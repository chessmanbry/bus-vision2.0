import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

// tesseract.js（你已安裝）
// 這裡用動態 import，避免首次 bundle 過大

const FOLDER_NAME = 'BusData';
const METADATA_FILE = `${FOLDER_NAME}/metadata.json`;
const BOX_CLASSES = ['bus', 'route_display', 'license_plate', 'bus_stop_sign', 'front_led', 'side_led'];
const SOUND_STAGES = ['background', 'far', 'middle', 'near', 'passing', 'leaving'];

function boxClassLabel(x) {
  return ({ bus: '公車本體', route_display: '路線顯示', license_plate: '車牌', bus_stop_sign: '站牌', front_led: '車頭 LED', side_led: '側面 LED' })[x] || x;
}
function soundStageLabel(x) {
  return ({ background: '背景', far: '遠處接近', middle: '接近中', near: '即將抵達', passing: '經過身邊', leaving: '離開' })[x] || x;
}

function safeNowId() {
  return Date.now();
}

async function ensureDir() {
  try {
    await Filesystem.mkdir({ path: FOLDER_NAME, directory: Directory.Data, recursive: true });
  } catch (_) {}
}

async function readMetadata() {
  try {
    const res = await Filesystem.readFile({
      path: METADATA_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const arr = JSON.parse(res.data || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

async function writeMetadata(items) {
  await ensureDir();
  await Filesystem.writeFile({
    path: METADATA_FILE,
    directory: Directory.Data,
    data: JSON.stringify(items, null, 2),
    encoding: Encoding.UTF8,
  });
}

async function getPlayableSrcFromDataPath(dataPath) {
  const uriRes = await Filesystem.getUri({ directory: Directory.Data, path: dataPath });
  return Capacitor.convertFileSrc(uriRes.uri);
}

async function removeFileIfExists(dataPath) {
  try {
    await Filesystem.deleteFile({ directory: Directory.Data, path: dataPath });
  } catch (_) {}
}


// ---------- Export helpers: local dataset bundles ----------
const EXPORT_ROOT = 'BusExports';

function base64ToBytes(base64) {
  const clean = String(base64 || '').replace(/^data:.*?;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text ?? ''));
}

function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeU16(arr, value) { arr.push(value & 255, (value >>> 8) & 255); }
function writeU32(arr, value) { arr.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }
function pushBytes(arr, bytes) { for (let i = 0; i < bytes.length; i += 1) arr.push(bytes[i]); }

function createStoredZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const f of files) {
    const nameBytes = utf8Bytes(f.name.replace(/^\/+/, ''));
    const dataBytes = f.bytes instanceof Uint8Array ? f.bytes : utf8Bytes(f.text || '');
    const crc = crc32(dataBytes);
    const localHeader = [];
    writeU32(localHeader, 0x04034b50);
    writeU16(localHeader, 20); // version needed
    writeU16(localHeader, 0x0800); // UTF-8 names
    writeU16(localHeader, 0); // store, no compression
    writeU16(localHeader, time);
    writeU16(localHeader, day);
    writeU32(localHeader, crc);
    writeU32(localHeader, dataBytes.length);
    writeU32(localHeader, dataBytes.length);
    writeU16(localHeader, nameBytes.length);
    writeU16(localHeader, 0);
    pushBytes(localHeader, nameBytes);

    pushBytes(local, localHeader);
    pushBytes(local, dataBytes);

    const centralHeader = [];
    writeU32(centralHeader, 0x02014b50);
    writeU16(centralHeader, 20);
    writeU16(centralHeader, 20);
    writeU16(centralHeader, 0x0800);
    writeU16(centralHeader, 0);
    writeU16(centralHeader, time);
    writeU16(centralHeader, day);
    writeU32(centralHeader, crc);
    writeU32(centralHeader, dataBytes.length);
    writeU32(centralHeader, dataBytes.length);
    writeU16(centralHeader, nameBytes.length);
    writeU16(centralHeader, 0);
    writeU16(centralHeader, 0);
    writeU16(centralHeader, 0);
    writeU16(centralHeader, 0);
    writeU32(centralHeader, 0);
    writeU32(centralHeader, offset);
    pushBytes(centralHeader, nameBytes);
    pushBytes(central, centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const end = [];
  writeU32(end, 0x06054b50);
  writeU16(end, 0);
  writeU16(end, 0);
  writeU16(end, files.length);
  writeU16(end, files.length);
  writeU32(end, central.length);
  writeU32(end, local.length);
  writeU16(end, 0);

  const total = new Uint8Array(local.length + central.length + end.length);
  total.set(local, 0);
  total.set(central, local.length);
  total.set(end, local.length + central.length);
  return total;
}

function bestAnnotation(item) {
  const anns = Array.isArray(item.annotations) ? item.annotations : [];
  return anns[0] || null;
}

function yoloClassName(item) {
  const ann = bestAnnotation(item);
  const boxClass = ann?.boxClass || item?.annotation?.preset || item?.annotation?.yoloClass || 'bus';
  return String(boxClass).replace(/\W+/g, '_') || 'bus';
}

function yoloLabelLine(item, classIndexMap) {
  const ann = bestAnnotation(item);
  const rect = ann?.manualRect || item?.annotation?.boxes?.[0] || null;
  const cls = yoloClassName(item);
  const classIndex = classIndexMap.get(cls) ?? 0;
  if (!rect || rect.w == null || rect.h == null) return '';
  const xCenter = Number(rect.x) + Number(rect.w) / 2;
  const yCenter = Number(rect.y) + Number(rect.h) / 2;
  const values = [classIndex, xCenter, yCenter, Number(rect.w), Number(rect.h)];
  if (values.slice(1).some((v) => Number.isNaN(v))) return '';
  return `${values[0]} ${values.slice(1).map((v) => Math.max(0, Math.min(1, v)).toFixed(6)).join(' ')}`;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function extFromPath(path, fallback) {
  const m = String(path || '').match(/\.([a-zA-Z0-9]+)$/);
  return (m ? m[1].toLowerCase() : fallback).replace('jpeg', 'jpg');
}

async function readDataFileBytes(path) {
  const res = await Filesystem.readFile({ directory: Directory.Data, path });
  return base64ToBytes(res.data);
}

async function writeAndShareZip(zipName, files) {
  await Filesystem.mkdir({ path: EXPORT_ROOT, directory: Directory.Cache, recursive: true }).catch(() => {});
  const zipBytes = createStoredZip(files);
  const zipPath = `${EXPORT_ROOT}/${zipName}`;
  await Filesystem.writeFile({ directory: Directory.Cache, path: zipPath, data: bytesToBase64(zipBytes) });
  const uriRes = await Filesystem.getUri({ directory: Directory.Cache, path: zipPath });
  await Share.share({ title: zipName, text: 'Bus Vision dataset export', url: uriRes.uri, dialogTitle: '匯出資料集 ZIP' });
  return { zipPath, count: files.length, sizeBytes: zipBytes.length };
}

async function buildYoloZip(items) {
  const imageItems = items.filter((it) => isPhotoLikeItem(it) || it.snapshotPath);
  if (!imageItems.length) throw new Error('沒有可匯出的照片或截圖；請先拍照，或從影片截圖後標注。');

  const classNames = Array.from(new Set(imageItems.map(yoloClassName)));
  const classIndexMap = new Map(classNames.map((name, idx) => [name, idx]));
  const files = [];
  const manifest = [];

  for (const item of imageItems) {
    const sourcePath = isPhotoLikeItem(item) ? item.path : item.snapshotPath;
    if (!sourcePath) continue;
    try {
      const ext = extFromPath(sourcePath, 'jpg');
      const stem = `bus_${item.id}`;
      const bytes = await readDataFileBytes(sourcePath);
      const label = yoloLabelLine(item, classIndexMap);
      files.push({ name: `images/train/${stem}.${ext}`, bytes });
      files.push({ name: `labels/train/${stem}.txt`, text: label ? `${label}\n` : '' });
      manifest.push({ id: item.id, image: `images/train/${stem}.${ext}`, label: `labels/train/${stem}.txt`, className: yoloClassName(item), hasBox: Boolean(label), createdAt: item.createdAt, sourcePath });
    } catch (err) {
      manifest.push({ id: item.id, skipped: true, reason: String(err?.message || err), sourcePath });
    }
  }

  files.push({ name: 'data.yaml', text: `path: .\ntrain: images/train\nval: images/train\nnc: ${classNames.length}\nnames: [${classNames.map((x) => `'${x.replace(/'/g, '')}'`).join(', ')}]\n` });
  files.push({ name: 'manifest.json', text: JSON.stringify(manifest, null, 2) });
  files.push({ name: 'README.txt', text: 'YOLO export from Bus Vision multimodal collector. Empty label files mean the image is ready but still needs a bounding box annotation.\n' });
  return writeAndShareZip(`busvision_yolo_${Date.now()}.zip`, files);
}

async function buildOcrZip(items) {
  const rows = [['id', 'image', 'bus_number', 'created_at', 'lighting', 'distance', 'note']];
  const files = [];
  for (const item of items.filter((it) => isPhotoLikeItem(it) || it.snapshotPath)) {
    const sourcePath = isPhotoLikeItem(item) ? item.path : item.snapshotPath;
    if (!sourcePath) continue;
    try {
      const ext = extFromPath(sourcePath, 'jpg');
      const stem = `ocr_${item.id}`;
      files.push({ name: `images/${stem}.${ext}`, bytes: await readDataFileBytes(sourcePath) });
      const ann = bestAnnotation(item);
      rows.push([item.id, `images/${stem}.${ext}`, ann?.busNo || item?.annotation?.busNumber || '', item.createdAt || '', item?.tags?.lighting || '', item?.tags?.distance || '', item.note || '']);
    } catch (_) {}
  }
  if (files.length === 0) throw new Error('沒有可匯出的 OCR 圖片。');
  files.push({ name: 'ocr_manifest.csv', text: rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n' });
  files.push({ name: 'ocr_manifest.json', text: JSON.stringify(rows.slice(1).map((r) => ({ id: r[0], image: r[1], busNumber: r[2], createdAt: r[3], lighting: r[4], distance: r[5], note: r[6] })), null, 2) });
  files.push({ name: 'README.txt', text: 'OCR export. Put the bus route number in bus_number after manual correction. Images are route/plate/front-display crops or full frames depending on annotation status.\n' });
  return writeAndShareZip(`busvision_ocr_${Date.now()}.zip`, files);
}

async function buildAudioZip(items) {
  const audioItems = items.filter((it) => it.audioPath);
  if (!audioItems.length) throw new Error('沒有可匯出的音訊資料。請先錄影，系統會同步保存 WAV。');

  const files = [];
  const rows = [['id', 'audio', 'video', 'created_at', 'sound_stage', 'distance_tag', 'lighting', 'scene', 'device', 'task_mode', 'note']];
  const segmentRows = [['id', 'audio', 'source_item_id', 'start_sec', 'end_sec', 'duration_sec', 'label', 'distance_stage', 'device', 'scene', 'lighting', 'task_mode', 'note']];
  const manifest = [];
  const segmentManifest = [];

  for (const item of audioItems) {
    try {
      const ext = extFromPath(item.audioPath, 'wav');
      const audioName = `audio_${item.id}.${ext}`;
      files.push({ name: `audio/${audioName}`, bytes: await readDataFileBytes(item.audioPath) });
      rows.push([item.id, `audio/${audioName}`, item.path || '', item.createdAt || '', item?.tags?.soundStage || item?.telemetry?.soundDistanceStage || '', item?.tags?.distance || '', item?.tags?.lighting || '', item?.tags?.scene || '', item?.device?.model || '', item?.taskMode || item?.captureProfile || '', item.note || '']);
      const segments = audioSegmentsOf(item);
      manifest.push({ id: item.id, audio: `audio/${audioName}`, video: item.path, createdAt: item.createdAt, soundStage: item?.tags?.soundStage || item?.telemetry?.soundDistanceStage || '', audioSegments: segments, tags: item.tags, telemetry: item.telemetry, taskMode: item.taskMode, device: item.device, note: item.note });
      for (const seg of segments) {
        const durationSec = seg.durationSec || (Number(seg.endSec) - Number(seg.startSec));
        segmentRows.push([seg.id, `audio/${audioName}`, item.id, seg.startSec, seg.endSec, durationSec, seg.label || soundStageLabel(seg.stage), seg.stage, item?.device?.model || '', item?.tags?.scene || '', item?.tags?.lighting || '', item?.taskMode || item?.captureProfile || '', seg.note || item.note || '']);
        segmentManifest.push({ ...seg, sourceItemId: item.id, audio: `audio/${audioName}`, device: item.device, tags: item.tags, taskMode: item.taskMode });
      }
    } catch (err) {
      manifest.push({ id: item.id, skipped: true, reason: String(err?.message || err) });
    }
  }

  files.push({ name: 'audio_manifest.csv', text: rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n' });
  files.push({ name: 'audio_manifest.json', text: JSON.stringify(manifest, null, 2) });
  files.push({ name: 'audio_segments.csv', text: segmentRows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n' });
  files.push({ name: 'audio_segments.json', text: JSON.stringify(segmentManifest, null, 2) });
  files.push({ name: 'README.txt', text: 'Audio export for bus-distance research. audio_manifest contains whole recordings. audio_segments.csv/json contains time-ranged labels: background, far, middle, near, passing, leaving. Use ffmpeg or Python to cut WAV segments for training.\n' });
  return writeAndShareZip(`busvision_audio_${Date.now()}.zip`, files);
}

async function buildFullZip(items) {
  if (!items.length) throw new Error('資料庫是空的。');
  const files = [{ name: 'metadata.json', text: JSON.stringify(items, null, 2) }, { name: 'quality_report.json', text: JSON.stringify(items.map((item) => ({ id: item.id, filename: item.filename, quality: qualityCheck(item) })), null, 2) }];
  for (const item of items) {
    for (const key of ['path', 'snapshotPath', 'audioPath']) {
      if (!item[key]) continue;
      try {
        const ext = extFromPath(item[key], key === 'audioPath' ? 'wav' : 'bin');
        files.push({ name: `raw/${key}_${item.id}.${ext}`, bytes: await readDataFileBytes(item[key]) });
      } catch (_) {}
    }
  }
  files.push({ name: 'README.txt', text: 'Full Bus Vision export: raw media plus metadata.json. Use this as the archive source before converting into task-specific datasets.\n' });
  return writeAndShareZip(`busvision_full_${Date.now()}.zip`, files);
}


function qualityCheck(item) {
  const isImage = isPhotoLikeItem(item) || Boolean(item?.snapshotPath);
  const isVideo = item?.type === 'video' || String(item?.mimeType || '').startsWith('video/');
  const ann = bestAnnotation(item);
  const checks = {
    media: Boolean(item?.path),
    imageForYolo: isImage,
    yoloBox: Boolean(ann?.manualRect || item?.annotation?.boxes?.length),
    ocrText: Boolean(ann?.busNo || item?.annotation?.busNumber),
    audio: Boolean(item?.audioPath),
    soundStage: !isVideo || Boolean(item?.tags?.soundStage || item?.telemetry?.soundDistanceStage || audioSegmentsOf(item).length),
    taskMode: Boolean(item?.taskMode || item?.captureProfile),
    device: Boolean(item?.device?.model || item?.device?.manufacturer),
    location: Boolean(item?.location?.lat && item?.location?.lng),
    lighting: Boolean(item?.tags?.lighting),
    distance: Boolean(item?.tags?.distance || item?.telemetry?.objectDistance?.tag || item?.telemetry?.objectDistance?.value != null),
    focus: Boolean(item?.focusEvent?.afState || item?.telemetry?.focusDistance?.afState || item?.cameraMeta?.focus?.afState),
    estimatedDistance: Boolean(item?.focusEvent?.finalDistanceMeters != null || item?.focusEvent?.estimatedMeters != null || item?.telemetry?.objectDistance?.value != null || item?.cameraMeta?.focus?.estimatedMeters != null),
    distanceSource: Boolean(item?.focusEvent?.distanceSource || item?.telemetry?.objectDistance?.source || item?.telemetry?.focusDistance?.distanceSource),
  };
  const required = isVideo ? ['media', 'audio', 'soundStage', 'taskMode', 'device', 'lighting', 'focus', 'distance', 'distanceSource'] : ['media', 'imageForYolo', 'taskMode', 'device', 'lighting', 'focus', 'distance', 'distanceSource'];
  const pass = required.filter((k) => checks[k]).length;
  const score = Math.round((pass / required.length) * 100);
  const missing = required.filter((k) => !checks[k]);
  const trainReady = score >= 80 && (!isImage || checks.yoloBox || checks.ocrText);
  return { score, trainReady, missing, checks };
}

function qualityBadge(item) {
  const q = qualityCheck(item);
  if (q.trainReady) return { text: `可訓練 ${q.score}%`, color: '#22c55e' };
  if (q.score >= 70) return { text: `待補標 ${q.score}%`, color: '#f59e0b' };
  return { text: `缺資料 ${q.score}%`, color: '#ef4444' };
}

function annotationsOf(item) { return Array.isArray(item?.annotations) ? item.annotations : []; }
function audioSegmentsOf(item) { return Array.isArray(item?.audioAnnotations) ? item.audioAnnotations : []; }
function hasAnnotations(item) { return annotationsOf(item).length > 0 || audioSegmentsOf(item).length > 0; }
function hasAudio(item) { return Boolean(item?.audioPath); }
function viewName(name) {
  return ({ all: '全部資料', annotated: '已標注資料', todo: '待補標資料', audio: '聲音資料', trainable: '可訓練' })[name] || name;
}
function isPhotoLikeItem(it) {
  if (!it) return false;
  if (it.type === 'photo') return true;
  const mt = String(it.mimeType || '').toLowerCase();
  return mt.startsWith('image/');
}

// 解析 OCR 的數字：取最像公車號碼的連續數字（2~4碼）
function pickBestBusNumber(text) {
  if (!text) return '';
  const cleaned = text.replace(/[^\d]/g, ' ');
  const candidates = cleaned
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{2,4}$/.test(s));

  if (!candidates.length) return '';
  const score = (s) => (s.length === 3 ? 100 : s.length === 4 ? 80 : 60);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

// 把 element 畫到 canvas（維持原圖比例）
async function drawElementToCanvas(el) {
  const canvas = document.createElement('canvas');
  const w = el.naturalWidth || el.videoWidth || el.width || 1280;
  const h = el.naturalHeight || el.videoHeight || el.height || 720;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(el, 0, 0, w, h);
  return canvas;
}

// 從 canvas 裁切一塊（rect 是像素座標）
function cropCanvas(srcCanvas, rect) {
  const { x, y, w, h } = rect;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w));
  c.height = Math.max(1, Math.floor(h));
  const ctx = c.getContext('2d');
  ctx.drawImage(
    srcCanvas,
    Math.floor(x),
    Math.floor(y),
    Math.floor(w),
    Math.floor(h),
    0,
    0,
    Math.floor(w),
    Math.floor(h)
  );
  return c;
}

export default function Gallery() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportSummary, setExportSummary] = useState('');
  const [activeTab, setActiveTab] = useState('all');

  // audio segment annotation state
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioTime, setAudioTime] = useState(0);
  const [segStart, setSegStart] = useState('0.00');
  const [segEnd, setSegEnd] = useState('3.00');
  const [segStage, setSegStage] = useState('far');
  const [segNote, setSegNote] = useState('');

  // preview modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeItem, setActiveItem] = useState(null);

  // preview media states (video + image)
  const [videoSrc, setVideoSrc] = useState('');
  const [videoErr, setVideoErr] = useState('');
  const videoRef = useRef(null);

  const [imageSrc, setImageSrc] = useState('');
  const [imageErr, setImageErr] = useState('');

  // annotate modal state
  const [annotateOpen, setAnnotateOpen] = useState(false);
  const [snapshotSrc, setSnapshotSrc] = useState('');
  const snapImgRef = useRef(null);

  // 建議標注文字（顯示用）
  const [suggestText, setSuggestText] = useState(''); // ex: "car (80%)" 或 "" 表示畫面乾淨
  const [busNo, setBusNo] = useState('');
  const [boxClass, setBoxClass] = useState('bus');
  const [visibilityTag, setVisibilityTag] = useState('clear');
  const [occlusionTag, setOcclusionTag] = useState('none');
  const [blurTag, setBlurTag] = useState('sharp');
  const [annoSoundStage, setAnnoSoundStage] = useState('');

  // 物件偵測 boxes（用於畫綠框）
  const [detBoxes, setDetBoxes] = useState([]); // [{x,y,w,h,label,score}]
  const [busyDetect, setBusyDetect] = useState(false);
  const [busyOCR, setBusyOCR] = useState(false);

  // 手動框（用於 OCR 裁切）
  const [manualRectView, setManualRectView] = useState(null); // {x,y,w,h}
  const [isDraggingRect, setIsDraggingRect] = useState(false);
  const dragModeRef = useRef('none'); // 'new' | 'move'
  const dragStartRef = useRef(null);
  const snapBoxRef = useRef(null); // snapshot 容器（用來換算座標）

  // zoom preview（簡易放大鏡：顯示手動框裁切結果）
  const zoomCanvasRef = useRef(null);

  const [savingAnno, setSavingAnno] = useState(false);

  // toast
  const [toast, setToast] = useState('');
  const showToast = (msg, ms = 1400) => {
    setToast(msg);
    if (ms) setTimeout(() => setToast(''), ms);
  };

  const speak = async (text) => {
    try {
      await TextToSpeech.speak({
        text,
        lang: 'zh-TW',
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
      });
      return;
    } catch (_) {}
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-TW';
        u.rate = 1.0;
        window.speechSynthesis.speak(u);
      }
    } catch (_) {}
  };

  const isPhotoItem = (it) => isPhotoLikeItem(it);

  const reload = async () => {
    setLoading(true);
    const data = await readMetadata();
    data.sort((a, b) => (b.id || 0) - (a.id || 0));
    setItems(data);
    setLoading(false);
  };

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    window.__busVisionOverlayOpen = Boolean(previewOpen || annotateOpen || exportOpen);
    return () => { window.__busVisionOverlayOpen = false; };
  }, [previewOpen, annotateOpen, exportOpen]);

  // Android 返回鍵：關彈窗優先
  useEffect(() => {
    let sub;
    const setup = async () => {
      sub = await CapacitorApp.addListener('backButton', () => {
        if (annotateOpen) {
          setAnnotateOpen(false);
          return;
        }
        if (previewOpen) {
          closePreview();
          return;
        }
        if (exportOpen) {
          setExportOpen(false);
          return;
        }
      });
    };
    setup();
    return () => {
      if (sub) sub.remove();
    };
  }, [previewOpen, annotateOpen, exportOpen]);

  const openPreview = async (item) => {
    setActiveItem(item);
    setPreviewOpen(true);
    setAudioDuration(0);
    setAudioTime(0);
    setSegStart('0.00');
    setSegEnd('3.00');
    setSegStage(item?.tags?.soundStage || item?.telemetry?.soundDistanceStage || 'far');
    setSegNote('');

    // reset media states
    setVideoErr('');
    setVideoSrc('');
    setImageErr('');
    setImageSrc('');

    try {
      const src = await getPlayableSrcFromDataPath(item.path);
      if (isPhotoItem(item)) setImageSrc(src);
      else setVideoSrc(src);
    } catch (e) {
      if (isPhotoItem(item)) {
        setImageSrc('');
        setImageErr(`無法取得照片路徑：${String(e?.message || e)}`);
      } else {
        setVideoSrc('');
        setVideoErr(`無法取得影片路徑：${String(e?.message || e)}`);
      }
    }
  };

  const closePreview = () => {
    try {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
    } catch (_) {}
    setPreviewOpen(false);
    setActiveItem(null);
    setVideoSrc('');
    setVideoErr('');
    setImageSrc('');
    setImageErr('');
  };


  const runDatasetExport = async (kind) => {
    setExportBusy(true);
    setExportSummary('整理資料中…');
    try {
      const fresh = await readMetadata();
      let result;
      if (kind === 'yolo') result = await buildYoloZip(fresh);
      else if (kind === 'ocr') result = await buildOcrZip(fresh);
      else if (kind === 'audio') result = await buildAudioZip(fresh);
      else result = await buildFullZip(fresh);
      setExportSummary(`已建立 ZIP：${result.count} 個檔案，${Math.round(result.sizeBytes / 1024)} KB`);
      showToast('已呼叫系統分享 / 匯出');
    } catch (e) {
      setExportSummary(`匯出失敗：${String(e?.message || e)}`);
      showToast(`匯出失敗：${String(e?.message || e)}`, 2200);
    } finally {
      setExportBusy(false);
    }
  };

  const doShare = async () => {
    if (!activeItem) return;
    try {
      const uriRes = await Filesystem.getUri({ directory: Directory.Data, path: activeItem.path });
      await Share.share({
        title: isPhotoItem(activeItem) ? '分享照片' : '分享影片',
        text: activeItem.filename || (isPhotoItem(activeItem) ? 'bus-vision photo' : 'bus-vision video'),
        url: uriRes.uri,
        dialogTitle: isPhotoItem(activeItem) ? '匯出/分享照片' : '匯出/分享影片',
      });
      showToast('已呼叫分享');
    } catch (e) {
      showToast(`分享失敗：${String(e?.message || e)}`, 2000);
    }
  };

  const doDelete = async () => {
    if (!activeItem) return;
    const ok = confirm('確定要刪除此資料（影片/照片/截圖/標注）嗎？此動作不可復原。');
    if (!ok) return;

    try {
      await removeFileIfExists(activeItem.path);
      if (activeItem.snapshotPath) await removeFileIfExists(activeItem.snapshotPath);
      if (activeItem.audioPath) await removeFileIfExists(activeItem.audioPath);

      const data = await readMetadata();
      const next = data.filter((x) => x.id !== activeItem.id);
      await writeMetadata(next);

      showToast('已刪除');
      closePreview();
      await reload();
    } catch (e) {
      showToast(`刪除失敗：${String(e?.message || e)}`, 2000);
    }
  };

  // 影片：截圖 -> 存 png -> 進入標注
  const captureFrameToPng = async () => {
    if (!activeItem) return;
    const v = videoRef.current;
    if (!v) {
      showToast('尚未載入影片');
      return;
    }

    try {
      if (v.readyState < 2) {
        showToast('影片尚未就緒，請稍等');
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];

      const snapId = safeNowId();
      const snapName = `Snap_${activeItem.id || snapId}_${snapId}.png`;
      const snapPath = `${FOLDER_NAME}/${snapName}`;

      await ensureDir();
      await Filesystem.writeFile({
        directory: Directory.Data,
        path: snapPath,
        data: base64,
      });

      // 更新 metadata（影片才需要 snapshotPath）
      const data = await readMetadata();
      const idx = data.findIndex((x) => x.id === activeItem.id);
      if (idx >= 0) {
        data[idx] = {
          ...data[idx],
          hasSnapshot: true,
          snapshotPath: snapPath,
        };
        await writeMetadata(data);
      }

      const snapSrc = await getPlayableSrcFromDataPath(snapPath);

      // 開啟標注 UI：初始化狀態
      setSnapshotSrc(snapSrc);
      setSuggestText('');
      setDetBoxes([]);
      setBusNo('');
      setBoxClass(activeItem?.annotation?.preset || 'bus');
      setVisibilityTag('clear');
      setOcclusionTag('none');
      setBlurTag('sharp');
      setAnnoSoundStage(activeItem?.tags?.soundStage || activeItem?.telemetry?.soundDistanceStage || '');
      setManualRectView(null);

      setAnnotateOpen(true);
      showToast('已截圖，進入標注');
      speak('已截圖，開始標注');
    } catch (e) {
      showToast(`截圖失敗：${String(e?.message || e)}`, 2000);
    }
  };

  // 照片：直接進入標注（不需存 snapshot）
  const openPhotoAnnotate = async () => {
    if (!activeItem) return;
    try {
      const src = await getPlayableSrcFromDataPath(activeItem.path);

      setSnapshotSrc(src);
      setSuggestText('');
      setDetBoxes([]);
      setBusNo('');
      setBoxClass(activeItem?.annotation?.preset || 'bus');
      setVisibilityTag('clear');
      setOcclusionTag('none');
      setBlurTag('sharp');
      setAnnoSoundStage(activeItem?.tags?.soundStage || activeItem?.telemetry?.soundDistanceStage || '');
      setManualRectView(null);

      setAnnotateOpen(true);
      showToast('進入標注');
      speak('開始標注');
    } catch (e) {
      showToast(`開啟標注失敗：${String(e?.message || e)}`, 2000);
    }
  };

  // =========================
  // 真正可跑的 coco-ssd 偵測
  // =========================
  const cocoModelRef = useRef(null);

  const runDetect = async () => {
    try {
      if (!snapImgRef.current) {
        showToast('圖片尚未載入完成');
        return;
      }
      setBusyDetect(true);
      showToast('偵測中…', 900);

      const tf = await import('@tensorflow/tfjs');
      try {
        await import('@tensorflow/tfjs-backend-webgl');
        await tf.setBackend('webgl');
        await tf.ready();
      } catch (_) {}

      const cocoSsd = await import('@tensorflow-models/coco-ssd');

      if (!cocoModelRef.current) {
        cocoModelRef.current = await cocoSsd.load();
      }

      const img = snapImgRef.current;
      const srcCanvas = await drawElementToCanvas(img);

      const preds = await cocoModelRef.current.detect(srcCanvas);

      const filtered = (preds || [])
        .filter((p) => (p?.score ?? 0) >= 0.45)
        .map((p) => ({
          label: p.class,
          score: p.score,
          x: p.bbox[0],
          y: p.bbox[1],
          w: p.bbox[2],
          h: p.bbox[3],
        }));

      if (!filtered.length) {
        setSuggestText('');
        setDetBoxes([]);
        showToast('畫面乾淨');
        speak('畫面乾淨');
        return;
      }

      filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
      const top = filtered[0];
      setSuggestText(`${top.label} (${Math.round((top.score || 0) * 100)}%)`);
      setDetBoxes(filtered);

      showToast(`偵測到：${top.label}`);
      speak(`偵測到 ${top.label}`);
    } catch (e) {
      showToast(`偵測失敗：${String(e?.message || e)}`, 2000);
    } finally {
      setBusyDetect(false);
    }
  };

  // =========================
  // 真正可跑的 tesseract OCR
  // =========================
  const ocrWorkerRef = useRef(null);

  const runOCR = async () => {
    try {
      if (!snapImgRef.current) {
        showToast('圖片尚未載入完成');
        return;
      }
      setBusyOCR(true);
      showToast('OCR 掃描中…', 1200);

      const { createWorker } = await import('tesseract.js');

      if (!ocrWorkerRef.current) {
        const worker = await createWorker('eng');
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
        });
        ocrWorkerRef.current = worker;
      }

      const img = snapImgRef.current;
      const srcCanvas = await drawElementToCanvas(img);

      let targetCanvas = srcCanvas;

      if (manualRectView && snapBoxRef.current) {
        const box = snapBoxRef.current.getBoundingClientRect();
        const scaleX = srcCanvas.width / box.width;
        const scaleY = srcCanvas.height / box.height;
        const rectPx = {
          x: manualRectView.x * scaleX,
          y: manualRectView.y * scaleY,
          w: manualRectView.w * scaleX,
          h: manualRectView.h * scaleY,
        };
        if (rectPx.w > 20 && rectPx.h > 20) {
          targetCanvas = cropCanvas(srcCanvas, rectPx);
        }
      } else if (detBoxes.length) {
        const top = [...detBoxes].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
        if (top && top.w > 20 && top.h > 20) {
          targetCanvas = cropCanvas(srcCanvas, top);
        }
      }

      const { data } = await ocrWorkerRef.current.recognize(targetCanvas);
      const text = data?.text || '';
      const best = pickBestBusNumber(text);

      if (best) {
        setBusNo(best);
        showToast(`OCR：${best}`);
        speak(`號碼 ${best}`);
      } else {
        showToast('OCR 未找到清晰數字', 1600);
        speak('沒有找到清晰數字');
      }

      // 放大鏡：把 targetCanvas 畫到 zoomCanvas
      try {
        const z = zoomCanvasRef.current;
        if (z && targetCanvas) {
          const ctx = z.getContext('2d');
          const maxW = 520;
          const scale = Math.min(1, maxW / targetCanvas.width);
          z.width = Math.max(1, Math.floor(targetCanvas.width * scale));
          z.height = Math.max(1, Math.floor(targetCanvas.height * scale));
          ctx.clearRect(0, 0, z.width, z.height);
          ctx.drawImage(targetCanvas, 0, 0, z.width, z.height);
        }
      } catch (_) {}
    } catch (e) {
      showToast(`OCR 失敗：${String(e?.message || e)}`, 2000);
    } finally {
      setBusyOCR(false);
    }
  };

  // =========================
  // 錄音播放（若 metadata 有 audioPath）
  // =========================
  const audioRef = useRef(null);
  const [audioPlaying, setAudioPlaying] = useState(false);

  const playAudio = async () => {
    try {
      if (!activeItem?.audioPath) {
        showToast('此筆資料沒有錄音檔', 1600);
        return;
      }
      const src = await getPlayableSrcFromDataPath(activeItem.audioPath);

      if (!audioRef.current) {
        audioRef.current = new Audio(src);
        audioRef.current.addEventListener('ended', () => setAudioPlaying(false));
        audioRef.current.addEventListener('loadedmetadata', () => setAudioDuration(audioRef.current?.duration || 0));
        audioRef.current.addEventListener('timeupdate', () => setAudioTime(audioRef.current?.currentTime || 0));
      } else {
        if (audioRef.current.src !== src) audioRef.current.src = src;
      }

      if (audioPlaying) {
        audioRef.current.pause();
        setAudioPlaying(false);
      } else {
        await audioRef.current.play();
        setAudioPlaying(true);
      }
    } catch (e) {
      showToast(`播放失敗：${String(e?.message || e)}`, 2000);
      setAudioPlaying(false);
    }
  };


  // =========================
  // 聲音區段標注（0.6）
  // =========================
  const seekAudio = (value) => {
    const t = Math.max(0, Math.min(Number(value) || 0, audioDuration || 0));
    if (audioRef.current) audioRef.current.currentTime = t;
    setAudioTime(t);
  };

  const markSegmentStart = () => setSegStart((audioTime || 0).toFixed(2));
  const markSegmentEnd = () => setSegEnd((audioTime || Math.min((audioDuration || 3), 3)).toFixed(2));

  const saveAudioSegment = async () => {
    if (!activeItem?.audioPath) {
      showToast('此筆資料沒有錄音檔，無法切區段', 1600);
      return;
    }
    const startSec = Number(segStart);
    const endSec = Number(segEnd);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      showToast('請設定有效的起訖秒數', 1600);
      return;
    }
    try {
      const data = await readMetadata();
      const idx = data.findIndex((x) => x.id === activeItem.id);
      if (idx < 0) throw new Error('metadata item not found');
      const oldSegments = audioSegmentsOf(data[idx]);
      const segment = {
        id: safeNowId(),
        createdAt: new Date().toISOString(),
        schemaVersion: 'audio-segment-v1',
        startSec: Math.max(0, startSec),
        endSec: Math.max(startSec, endSec),
        durationSec: Math.max(0, endSec - startSec),
        stage: segStage,
        label: soundStageLabel(segStage),
        note: segNote.trim(),
      };
      data[idx] = {
        ...data[idx],
        audioAnnotations: [...oldSegments, segment].sort((a, b) => a.startSec - b.startSec),
        tags: { ...(data[idx].tags || {}), soundStage: data[idx]?.tags?.soundStage || segStage },
      };
      await writeMetadata(data);
      setActiveItem(data[idx]);
      await reload();
      showToast('已新增聲音區段標注');
    } catch (e) {
      showToast(`聲音標注儲存失敗：${String(e?.message || e)}`, 2000);
    }
  };

  const deleteAudioSegment = async (segmentId) => {
    if (!activeItem) return;
    try {
      const data = await readMetadata();
      const idx = data.findIndex((x) => x.id === activeItem.id);
      if (idx < 0) return;
      data[idx] = { ...data[idx], audioAnnotations: audioSegmentsOf(data[idx]).filter((s) => s.id !== segmentId) };
      await writeMetadata(data);
      setActiveItem(data[idx]);
      await reload();
      showToast('已刪除聲音區段');
    } catch (e) {
      showToast(`刪除失敗：${String(e?.message || e)}`, 2000);
    }
  };

  // =========================
  // 手動拉框
  // =========================
  const onSnapPointerDown = (e) => {
    if (!snapBoxRef.current) return;
    const rect = snapBoxRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (manualRectView) {
      const r = manualRectView;
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
      if (inside) {
        dragModeRef.current = 'move';
        dragStartRef.current = { x, y, base: { ...r } };
        setIsDraggingRect(true);
        return;
      }
    }

    dragModeRef.current = 'new';
    dragStartRef.current = { x, y };
    setManualRectView({ x, y, w: 1, h: 1 });
    setIsDraggingRect(true);
  };

  const onSnapPointerMove = (e) => {
    if (!isDraggingRect || !snapBoxRef.current || !dragStartRef.current) return;
    const rect = snapBoxRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragModeRef.current === 'new') {
      const sx = dragStartRef.current.x;
      const sy = dragStartRef.current.y;
      const nx = Math.min(sx, x);
      const ny = Math.min(sy, y);
      const nw = Math.abs(x - sx);
      const nh = Math.abs(y - sy);
      setManualRectView({ x: nx, y: ny, w: nw, h: nh });
    } else if (dragModeRef.current === 'move') {
      const { base } = dragStartRef.current;
      const dx = x - dragStartRef.current.x;
      const dy = y - dragStartRef.current.y;
      let nx = base.x + dx;
      let ny = base.y + dy;
      nx = Math.max(0, Math.min(nx, rect.width - base.w));
      ny = Math.max(0, Math.min(ny, rect.height - base.h));
      setManualRectView({ x: nx, y: ny, w: base.w, h: base.h });
    }
  };

  const onSnapPointerUp = () => {
    setIsDraggingRect(false);
    dragModeRef.current = 'none';
    dragStartRef.current = null;
  };

  const clearManualRect = () => {
    setManualRectView(null);
    showToast('已清除手動框');
  };

  // =============
  // 儲存標注（多次標注 → annotations[] 追加）
  // =============
  const saveAnnotation = async () => {
    if (!activeItem) return;

    setSavingAnno(true);
    try {
      const data = await readMetadata();
      const idx = data.findIndex((x) => x.id === activeItem.id);
      if (idx < 0) throw new Error('metadata item not found');

      const now = new Date().toISOString();

      let manualRectNorm = null;
      if (manualRectView && snapBoxRef.current) {
        const box = snapBoxRef.current.getBoundingClientRect();
        manualRectNorm = {
          x: manualRectView.x / box.width,
          y: manualRectView.y / box.height,
          w: manualRectView.w / box.width,
          h: manualRectView.h / box.height,
        };
      }

      const ann = {
        id: safeNowId(),
        createdAt: now,
        engineSuggestion: suggestText ? { text: suggestText } : { text: '畫面乾淨' },
        schemaVersion: 'annotation-v2',
        boxClass,
        boxClassLabel: boxClassLabel(boxClass),
        busNo: (busNo || '').trim(),
        manualRect: manualRectNorm,
        quality: { visibility: visibilityTag, occlusion: occlusionTag, blur: blurTag },
        soundStage: annoSoundStage || data[idx]?.tags?.soundStage || data[idx]?.telemetry?.soundDistanceStage || '',
        yolo: { className: boxClass, hasBox: Boolean(manualRectNorm) },
        ocr: { routeText: (busNo || '').trim(), targetClass: boxClass },
      };

      const old = Array.isArray(data[idx].annotations) ? data[idx].annotations : [];
      data[idx] = {
        ...data[idx],
        annotations: [ann, ...old],
        annotation: { ...(data[idx].annotation || {}), schemaVersion: 'dataset-v2', boxes: manualRectNorm ? [{ ...manualRectNorm, className: boxClass }] : (data[idx].annotation?.boxes || []), busNumber: (busNo || '').trim() || data[idx].annotation?.busNumber || '', yoloClass: boxClass },
        tags: { ...(data[idx].tags || {}), soundStage: ann.soundStage || data[idx].tags?.soundStage },
      };

      await writeMetadata(data);
      showToast('已儲存標注');
      speak('已儲存標注');
      setAnnotateOpen(false);
      await reload();
    } catch (e) {
      showToast(`儲存標注失敗：${String(e?.message || e)}`, 2000);
    } finally {
      setSavingAnno(false);
    }
  };

  // 清理 OCR worker
  useEffect(() => {
    return () => {
      try {
        if (ocrWorkerRef.current) {
          ocrWorkerRef.current.terminate();
          ocrWorkerRef.current = null;
        }
      } catch (_) {}
    };
  }, []);

  // =============
  // Styles
  // =============
  const styles = useMemo(
    () => ({
      page: {
        height: '100%',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        boxSizing: 'border-box',
        padding: '12px 12px',
        paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 0px))',
        background: '#0b0b0b',
        color: '#fff',
        fontSize: 14,
      },
      header: { fontSize: 22, fontWeight: 900, marginBottom: 8, lineHeight: 1.1 },
      sub: { color: '#aaa', fontSize: 13, marginBottom: 10, lineHeight: 1.35 },
      qualityPanel: { padding: 12, borderRadius: 14, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.20)', marginBottom: 12 },
      qualityTitle: { fontWeight: 1000, fontSize: 15, marginBottom: 4 },
      qualityText: { color: '#cfcfcf', fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word' },
      exportBar: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 },
      exportCard: { padding: 12, borderRadius: 14, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#fff', textAlign: 'left' },
      exportTitle: { fontWeight: 1000, fontSize: 15, marginBottom: 4 },
      exportDesc: { fontSize: 12, color: '#bbb', lineHeight: 1.35 },
      tabBar: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 12 },
      tabOn: { flex: '0 0 auto', padding: '8px 11px', borderRadius: 999, border: '1px solid #22c55e', background: 'rgba(34,197,94,0.22)', color: '#d8ffe7', fontWeight: 1000, fontSize: 13, whiteSpace: 'nowrap' },
      tabOff: { flex: '0 0 auto', padding: '8px 11px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, fontSize: 13, whiteSpace: 'nowrap' },
      historyBox: { padding: 10, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', marginTop: 8 },
      timelineBox: { padding: 12, borderRadius: 14, background: '#101010', border: '1px solid rgba(255,255,255,0.10)' },

      grid: { display: 'flex', flexDirection: 'column', gap: 10 },
      card: {
        background: '#161616',
        borderRadius: 14,
        padding: 12,
        border: '1px solid rgba(255,255,255,0.06)',
      },
      row: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'start' },
      title: { fontWeight: 900, fontSize: 15, lineHeight: 1.25, wordBreak: 'break-word', overflowWrap: 'anywhere' },
      meta: { color: '#9a9a9a', fontSize: 12, marginTop: 6, lineHeight: 1.35, wordBreak: 'break-word' },
      qualityPill: { padding: '4px 8px', fontSize: 11, borderRadius: 999, color: '#fff', fontWeight: 1000, whiteSpace: 'nowrap', maxWidth: 86, overflow: 'hidden', textOverflow: 'ellipsis' },
      pill: {
        padding: '4px 8px',
        fontSize: 11,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.08)',
        color: '#ddd',
        whiteSpace: 'nowrap',
      },

      // overlay
      overlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      },

      // ===== Preview bottom-sheet =====
      sheetOverlay: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: 10,
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
      },
      sheet: {
        width: 'min(560px, 100%)',
        maxHeight: '92vh',
        background: '#1a1a1a',
        borderRadius: 18,
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      },
      sheetHead: {
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(26,26,26,0.98)',
      },
      sheetTitle: { fontSize: 18, fontWeight: 900 },
      sheetBody: {
        padding: '12px 14px 16px',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
      },
      mediaArea: {
        borderRadius: 14,
        background: '#000',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.10)',
      },
      mediaRatio: {
        position: 'relative',
        width: '100%',
        paddingTop: '56.25%', // 16:9
      },
      videoSheet: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        background: '#000',
        display: 'block',
      },
      imgSheet: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        background: '#000',
        display: 'block',
      },
      errText: { marginTop: 10, color: '#ffb4b4', fontSize: 12, lineHeight: 1.35 },
      actionGroup: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        marginTop: 14,
        paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
      },

      modal: {
        width: 'min(520px, 96vw)',
        maxHeight: '92vh',
        background: '#1a1a1a',
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      modalHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 14px 10px',
      },
      modalTitle: { fontSize: 20, fontWeight: 900 },
      closeBtn: {
        width: 36,
        height: 36,
        borderRadius: 10,
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.10)',
        color: '#fff',
        fontSize: 18,
        fontWeight: 900,
      },

      modalBody: {
        padding: '0 14px 14px',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
      },
      section: { marginTop: 12 },

      // buttons
      actionBtn: (bg) => ({
        minHeight: 52,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.10)',
        background: bg,
        color: '#fff',
        fontSize: 16,
        fontWeight: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '10px 14px',
        textAlign: 'center',
        lineHeight: 1.2,
      }),
      btnRow2: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 10,
      },
      formGrid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
      miniLabel: { display: 'grid', gap: 6, color: '#ddd', fontSize: 12, fontWeight: 900 },
      chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      chipOn: { padding: '8px 10px', borderRadius: 999, border: '1px solid #22c55e', background: 'rgba(34,197,94,0.22)', color: '#d8ffe7', fontWeight: 900 },
      chipOff: { padding: '8px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900 },
      btnSmall: (bg) => ({
        height: 52,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.10)',
        background: bg,
        color: '#fff',
        fontSize: 16,
        fontWeight: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: 1,
      }),

      // annotate image container (overlay boxes)
      snapStage: {
        position: 'relative',
        width: '100%',
        borderRadius: 12,
        overflow: 'hidden',
        background: '#000',
        border: '1px solid rgba(255,255,255,0.08)',
        touchAction: 'none',
      },
      snapImg: {
        width: '100%',
        display: 'block',
        objectFit: 'contain',
      },
      boxLayer: {
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      },
      greenBox: (x, y, w, h) => ({
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        border: '2px solid #00ff66',
        borderRadius: 6,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.35) inset',
      }),
      greenLabel: {
        position: 'absolute',
        left: 0,
        top: -22,
        padding: '2px 6px',
        fontSize: 12,
        fontWeight: 900,
        borderRadius: 8,
        background: 'rgba(0,255,102,0.18)',
        border: '1px solid rgba(0,255,102,0.45)',
        color: '#b9ffda',
        whiteSpace: 'nowrap',
      },

      resultLine: {
        padding: '10px 12px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.10)',
        color: '#eaeaea',
        fontSize: 14,
        lineHeight: 1.35,
      },
      field: {
        width: '100%',
        height: 46,
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.12)',
        background: '#111',
        color: '#fff',
        padding: '0 12px',
        fontSize: 16,
        outline: 'none',
      },

      stickyFooter: {
        padding: '12px 14px calc(12px + env(safe-area-inset-bottom, 0px))',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        background: '#1a1a1a',
        position: 'sticky',
        bottom: 0,
      },

      toast: {
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
        background: 'rgba(0,0,0,0.78)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 12,
        padding: '10px 12px',
        color: '#fff',
        fontWeight: 700,
        zIndex: 10000,
      },
    }),
    []
  );

  // 將 detBoxes（原圖像素）轉成「顯示容器 px」以畫框
  const renderBoxesInView = () => {
    if (!snapBoxRef.current || !snapImgRef.current) return [];
    const box = snapBoxRef.current.getBoundingClientRect();

    const img = snapImgRef.current;
    const srcW = img.naturalWidth || 1;
    const srcH = img.naturalHeight || 1;

    const containerW = box.width;
    const containerH = box.height;
    const scale = Math.min(containerW / srcW, containerH / srcH);
    const dispW = srcW * scale;
    const dispH = srcH * scale;
    const offsetX = (containerW - dispW) / 2;
    const offsetY = (containerH - dispH) / 2;

    return detBoxes.map((b) => ({
      ...b,
      vx: offsetX + b.x * scale,
      vy: offsetY + b.y * scale,
      vw: b.w * scale,
      vh: b.h * scale,
    }));
  };

  const boxesView = annotateOpen ? renderBoxesInView() : [];

  const filteredItems = items.filter((it) => {
    if (activeTab === 'annotated') return hasAnnotations(it);
    if (activeTab === 'todo') return !qualityCheck(it).trainReady;
    if (activeTab === 'audio') return hasAudio(it);
    if (activeTab === 'trainable') return qualityCheck(it).trainReady;
    return true;
  });

  return (
    <div style={styles.page}>
      <div style={styles.header}>標注資料庫</div>
      <div style={styles.sub}>{loading ? '讀取中…' : `${viewName(activeTab)}：${filteredItems.length} / 共 ${items.length} 筆資料`}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 10, marginBottom: 12 }}>
        <button
          onClick={reload}
          style={{
            height: 42,
            padding: '0 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            fontWeight: 900,
            fontSize: 14,
            whiteSpace: 'nowrap',
          }}
        >
          重新整理
        </button>
        <button
          onClick={() => setExportOpen(true)}
          style={{
            height: 42,
            padding: '0 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: '#f59a00',
            color: '#fff',
            fontWeight: 900,
            fontSize: 14,
            whiteSpace: 'nowrap',
          }}
        >
          匯出訓練
        </button>
      </div>

      <div style={styles.tabBar}>
        {[
          ['all', `全部 ${items.length}`],
          ['annotated', `已標注 ${items.filter(hasAnnotations).length}`],
          ['todo', `待補標 ${items.filter((x) => !qualityCheck(x).trainReady).length}`],
          ['audio', `聲音 ${items.filter(hasAudio).length}`],
          ['trainable', `可訓練 ${items.filter((x) => qualityCheck(x).trainReady).length}`],
        ].map(([key, label]) => (
          <button key={key} style={activeTab === key ? styles.tabOn : styles.tabOff} onClick={() => setActiveTab(key)}>{label}</button>
        ))}
      </div>

      <div style={styles.qualityPanel}>
        <div style={styles.qualityTitle}>資料品質檢查</div>
        <div style={styles.qualityText}>可訓練：{items.filter((x) => qualityCheck(x).trainReady).length} / {items.length}；待補標：{items.filter((x) => !qualityCheck(x).trainReady && qualityCheck(x).score >= 70).length}；缺資料：{items.filter((x) => qualityCheck(x).score < 70).length}</div>
      </div>

      <div style={styles.grid}>
        {filteredItems.map((it) => {
          const isP = isPhotoItem(it);
          const qb = qualityBadge(it);
          return (
            <div key={it.id} style={styles.card} onClick={() => openPreview(it)}>
              <div style={styles.row}>
                <div>
                  <div style={styles.title}>
                    {it.filename || `Bus_${it.id}`} {isP ? '（照片）' : '（影片）'}
                  </div>
                  <div style={styles.meta}>
                    {it.createdAt || ''} {it.timeOfDay ? `• ${it.timeOfDay}` : ''}{' '}
                    {it.label ? `• label=${it.label}` : ''}
                    {Array.isArray(it.annotations) && it.annotations.length > 0
                      ? ` • 影像標注 ${it.annotations.length}`
                      : ''}
                    {audioSegmentsOf(it).length ? ` • 聲音區段 ${audioSegmentsOf(it).length}` : ''}
                  </div>
                </div>
                <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}><div style={{ ...styles.qualityPill, background: qb.color }}>{qb.text}</div><div style={styles.pill}>開啟</div></div>
              </div>
            </div>
          );
        })}
      </div>


      {exportOpen && (
        <div style={styles.sheetOverlay} onClick={() => setExportOpen(false)}>
          <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={styles.sheetHead}>
              <div style={styles.sheetTitle}>匯出訓練資料</div>
              <button style={styles.closeBtn} onClick={() => setExportOpen(false)}>×</button>
            </div>
            <div style={styles.sheetBody}>
              <div style={{ color: '#ccc', fontSize: 13, lineHeight: 1.45, marginBottom: 12 }}>
                系統會依照目前 metadata、照片/截圖、標注框與 WAV 錄音，自動產生可訓練資料集 ZIP。YOLO 若尚未標框，仍會輸出空 label 檔，方便後續補標。
              </div>
              <div style={styles.exportBar}>
                <button disabled={exportBusy} style={styles.exportCard} onClick={() => runDatasetExport('yolo')}>
                  <div style={styles.exportTitle}>YOLO 偵測資料</div>
                  <div style={styles.exportDesc}>images/train、labels/train、data.yaml</div>
                </button>
                <button disabled={exportBusy} style={styles.exportCard} onClick={() => runDatasetExport('ocr')}>
                  <div style={styles.exportTitle}>OCR 文字資料</div>
                  <div style={styles.exportDesc}>圖片 + ocr_manifest.csv/json</div>
                </button>
                <button disabled={exportBusy} style={styles.exportCard} onClick={() => runDatasetExport('audio')}>
                  <div style={styles.exportTitle}>聲音訓練資料</div>
                  <div style={styles.exportDesc}>WAV + 距離/場景/設備 manifest</div>
                </button>
                <button disabled={exportBusy} style={styles.exportCard} onClick={() => runDatasetExport('full')}>
                  <div style={styles.exportTitle}>完整研究封存</div>
                  <div style={styles.exportDesc}>raw media + metadata.json</div>
                </button>
              </div>
              {exportSummary ? <div style={styles.resultLine}>{exportSummary}</div> : null}
            </div>
          </div>
        </div>
      )}

      {/* ===== Preview（bottom-sheet：影片/照片共用）===== */}
      {previewOpen && (
        <div style={styles.sheetOverlay} onClick={closePreview}>
          <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={styles.sheetHead}>
              <div style={styles.sheetTitle}>
                {isPhotoItem(activeItem) ? '預覽照片' : '預覽影片'}
              </div>
              <button style={styles.closeBtn} onClick={closePreview}>
                ×
              </button>
            </div>

            <div style={styles.sheetBody}>
              <div style={styles.mediaArea}>
                <div style={styles.mediaRatio}>
                  {isPhotoItem(activeItem) ? (
                    imageSrc ? (
                      <img
                        src={imageSrc}
                        alt="photo"
                        style={styles.imgSheet}
                        onError={() => setImageErr('照片載入失敗（多半是檔案 URL/格式問題）')}
                      />
                    ) : (
                      <div style={{ padding: 16, color: '#bbb', position: 'absolute', inset: 0 }}>
                        {imageErr ? imageErr : '載入照片中…'}
                      </div>
                    )
                  ) : videoSrc ? (
                    <video
                      key={videoSrc}
                      ref={videoRef}
                      style={styles.videoSheet}
                      src={videoSrc}
                      controls
                      playsInline
                      preload="metadata"
                      onError={() => setVideoErr('影片播放失敗（多半是檔案 URL/格式問題）')}
                    />
                  ) : (
                    <div style={{ padding: 16, color: '#bbb', position: 'absolute', inset: 0 }}>
                      {videoErr ? videoErr : '載入影片中…'}
                    </div>
                  )}
                </div>
              </div>

              {videoErr ? <div style={styles.errText}>{videoErr}</div> : null}
              {imageErr ? <div style={styles.errText}>{imageErr}</div> : null}
              {activeItem ? <div style={styles.resultLine}>品質：{qualityCheck(activeItem).score}%｜缺少：{qualityCheck(activeItem).missing.join('、') || '無'}｜AF：{activeItem?.focusEvent?.afState || activeItem?.telemetry?.focusDistance?.afState || activeItem?.cameraMeta?.focus?.afState || '無'}｜距離：{activeItem?.focusEvent?.finalDistanceMeters ? `${Number(activeItem.focusEvent.finalDistanceMeters).toFixed(2)}m` : activeItem?.focusEvent?.estimatedMeters ? `${Number(activeItem.focusEvent.estimatedMeters).toFixed(2)}m` : activeItem?.telemetry?.objectDistance?.value ? `${Number(activeItem.telemetry.objectDistance.value).toFixed(2)}m` : '無'}｜來源：{activeItem?.focusEvent?.distanceSource || activeItem?.telemetry?.objectDistance?.source || '無'}｜聲音階段：{soundStageLabel(activeItem?.tags?.soundStage || activeItem?.telemetry?.soundDistanceStage || '')}</div> : null}

              {activeItem && hasAnnotations(activeItem) ? (
                <div style={styles.historyBox}>
                  <div style={{ fontWeight: 1000, marginBottom: 6 }}>標注歷史</div>
                  {annotationsOf(activeItem).slice(0, 6).map((ann, idx) => (
                    <div key={ann.id || idx} style={styles.resultLine}>影像 #{annotationsOf(activeItem).length - idx}｜{boxClassLabel(ann.boxClass)}｜OCR：{ann.busNo || ann?.ocr?.routeText || '未填'}｜框：{ann?.yolo?.hasBox ? '有' : '無'}｜{ann.createdAt || ''}</div>
                  ))}
                  {audioSegmentsOf(activeItem).slice(0, 8).map((seg) => (
                    <div key={seg.id} style={styles.resultLine}>聲音｜{Number(seg.startSec).toFixed(2)}–{Number(seg.endSec).toFixed(2)}s｜{soundStageLabel(seg.stage)}｜{seg.note || ''}</div>
                  ))}
                </div>
              ) : activeItem ? (
                <div style={styles.historyBox}>尚未標注。可進入標注或新增聲音區段。</div>
              ) : null}

              {activeItem?.audioPath ? (
                <div style={styles.timelineBox}>
                  <div style={{ fontWeight: 1000, marginBottom: 8 }}>聲音區段標注</div>
                  <div style={styles.resultLine}>目前：{audioTime.toFixed(2)}s / {audioDuration ? audioDuration.toFixed(2) : '?'}s</div>
                  <input type="range" min="0" max={Math.max(audioDuration || 1, 1)} step="0.05" value={Math.min(audioTime, audioDuration || 0)} onChange={(e) => seekAudio(e.target.value)} style={{ width: '100%', margin: '8px 0' }} />
                  <div style={styles.formGrid2}>
                    <label style={styles.miniLabel}>起點秒數<input style={styles.field} value={segStart} onChange={(e) => setSegStart(e.target.value)} inputMode="decimal" /></label>
                    <label style={styles.miniLabel}>終點秒數<input style={styles.field} value={segEnd} onChange={(e) => setSegEnd(e.target.value)} inputMode="decimal" /></label>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                    <button style={styles.btnSmall('rgba(255,255,255,0.08)')} onClick={markSegmentStart}>設為起點</button>
                    <button style={styles.btnSmall('rgba(255,255,255,0.08)')} onClick={markSegmentEnd}>設為終點</button>
                  </div>
                  <div style={{ marginTop: 10, fontWeight: 900 }}>距離階段</div>
                  <div style={styles.chipRow}>
                    {SOUND_STAGES.map((x) => <button key={x} style={segStage === x ? styles.chipOn : styles.chipOff} onClick={() => setSegStage(x)}>{soundStageLabel(x)}</button>)}
                  </div>
                  <input style={{ ...styles.field, marginTop: 10 }} value={segNote} onChange={(e) => setSegNote(e.target.value)} placeholder="區段備註，例如：車輛開始接近、煞車聲明顯" />
                  <button style={{ ...styles.actionBtn('#22c55e'), marginTop: 10 }} onClick={saveAudioSegment}>新增聲音區段</button>
                  {audioSegmentsOf(activeItem).length ? (
                    <div style={{ marginTop: 10 }}>
                      {audioSegmentsOf(activeItem).map((seg) => (
                        <div key={seg.id} style={{ ...styles.historyBox, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                          <div>{Number(seg.startSec).toFixed(2)}–{Number(seg.endSec).toFixed(2)}s｜{soundStageLabel(seg.stage)}<div style={styles.resultLine}>{seg.note || ''}</div></div>
                          <button style={{ ...styles.btnSmall('#3a1a1a'), height: 38 }} onClick={() => deleteAudioSegment(seg.id)}>刪除</button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div style={styles.actionGroup}>
                <button style={styles.actionBtn('#f59a00')} onClick={doShare}>
                  {isPhotoItem(activeItem) ? '匯出/分享照片' : '匯出/分享影片'}
                </button>

                {/* 獨立播放區：每筆資料若有 WAV 錄音檔，可在此單獨重放 */}
                {activeItem?.audioPath ? (
                  <button style={styles.actionBtn('#1f3bff')} onClick={playAudio}>
                    {audioPlaying ? '停止播放錄音' : '播放錄音'}
                  </button>
                ) : null}

                {isPhotoItem(activeItem) ? (
                  <button style={styles.actionBtn('#1689ff')} onClick={openPhotoAnnotate}>
                    進入標注
                  </button>
                ) : (
                  <button style={styles.actionBtn('#1689ff')} onClick={captureFrameToPng}>
                    截圖並開始標注
                  </button>
                )}

                <button style={styles.actionBtn('#ff3b30')} onClick={doDelete}>
                  刪除此資料
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== Annotate Modal（照片/截圖共用）===== */}
      {annotateOpen && (
        <div style={styles.overlay} onClick={() => setAnnotateOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <div style={styles.modalTitle}>開始標注</div>
              <button style={styles.closeBtn} onClick={() => setAnnotateOpen(false)}>
                ×
              </button>
            </div>

            <div style={styles.modalBody}>
              {/* 圖片 + 框層 */}
              <div style={styles.section}>
                <div
                  ref={snapBoxRef}
                  style={styles.snapStage}
                  onPointerDown={onSnapPointerDown}
                  onPointerMove={onSnapPointerMove}
                  onPointerUp={onSnapPointerUp}
                  onPointerCancel={onSnapPointerUp}
                >
                  {snapshotSrc ? (
                    <img
                      ref={snapImgRef}
                      src={snapshotSrc}
                      alt="snapshot"
                      style={styles.snapImg}
                      draggable={false}
                      onLoad={() => {
                        setDetBoxes([]);
                        setManualRectView(null);
                      }}
                    />
                  ) : null}

                  <div style={styles.boxLayer}>
                    {boxesView.map((b, idx) => (
                      <div key={idx} style={styles.greenBox(b.vx, b.vy, b.vw, b.vh)}>
                        <div style={styles.greenLabel}>
                          {b.label} {Math.round((b.score || 0) * 100)}%
                        </div>
                      </div>
                    ))}

                    {manualRectView && (
                      <div
                        style={styles.greenBox(
                          manualRectView.x,
                          manualRectView.y,
                          manualRectView.w,
                          manualRectView.h
                        )}
                      >
                        <div style={styles.greenLabel}>手動框（可拖曳）</div>
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ marginTop: 8, color: '#cfcfcf', fontSize: 12, lineHeight: 1.35 }}>
                  提示：你可以在圖片上「手動拉框」再按 OCR，準確率會比整張圖掃描更高。
                </div>
              </div>

              {/* 第一排：偵測 / OCR */}
              <div style={{ ...styles.section, ...styles.btnRow2 }}>
                <button style={styles.btnSmall('#2b2b2b')} onClick={runDetect} disabled={busyDetect}>
                  {busyDetect ? '偵測中…' : '物件偵測'}
                </button>
                <button style={styles.btnSmall('#2b2b2b')} onClick={runOCR} disabled={busyOCR}>
                  {busyOCR ? '掃描中…' : 'OCR 掃描'}
                </button>
              </div>

              {/* 第二排：結果顯示 + 輸入 */}
              <div style={styles.section}>
                <div style={styles.resultLine}>{suggestText ? `建議標注：${suggestText}` : '畫面乾淨'}</div>
              </div>

              <div style={styles.section}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>公車號碼：</div>
                <input
                  style={styles.field}
                  value={busNo}
                  onChange={(e) => setBusNo(e.target.value)}
                  placeholder="例如：932"
                  inputMode="numeric"
                />
              </div>

              <div style={styles.section}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>正式資料集標注欄位：</div>
                <div style={styles.formGrid2}>
                  <label style={styles.miniLabel}>框類別
                    <select style={styles.field} value={boxClass} onChange={(e) => setBoxClass(e.target.value)}>
                      {BOX_CLASSES.map((x) => <option key={x} value={x}>{boxClassLabel(x)}</option>)}
                    </select>
                  </label>
                  <label style={styles.miniLabel}>清晰度
                    <select style={styles.field} value={blurTag} onChange={(e) => setBlurTag(e.target.value)}>
                      <option value="sharp">清楚</option><option value="slight_blur">微糊</option><option value="blur">模糊</option>
                    </select>
                  </label>
                  <label style={styles.miniLabel}>可見性
                    <select style={styles.field} value={visibilityTag} onChange={(e) => setVisibilityTag(e.target.value)}>
                      <option value="clear">完整可見</option><option value="partial">部分可見</option><option value="hard">困難樣本</option>
                    </select>
                  </label>
                  <label style={styles.miniLabel}>遮擋
                    <select style={styles.field} value={occlusionTag} onChange={(e) => setOcclusionTag(e.target.value)}>
                      <option value="none">無遮擋</option><option value="minor">輕微遮擋</option><option value="heavy">嚴重遮擋</option>
                    </select>
                  </label>
                </div>
              </div>

              <div style={styles.section}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>聲音距離階段：</div>
                <div style={styles.chipRow}>
                  {SOUND_STAGES.map((x) => <button key={x} style={annoSoundStage === x ? styles.chipOn : styles.chipOff} onClick={() => setAnnoSoundStage(x)}>{soundStageLabel(x)}</button>)}
                </div>
              </div>

              {/* 放大鏡 */}
              <div style={styles.section}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>放大檢視（OCR 目標區）</div>
                <canvas
                  ref={zoomCanvasRef}
                  style={{
                    width: '100%',
                    borderRadius: 12,
                    border: '1px solid rgba(255,255,255,0.10)',
                    background: '#0b0b0b',
                  }}
                />
              </div>

              {/* 錄音播放與切區段（影片可能有） */}
              <div style={styles.section}>
                <button style={styles.btnSmall('#1f3bff')} onClick={playAudio}>
                  {audioPlaying ? '停止播放錄音' : '播放錄音'}
                </button>
                {activeItem?.audioPath ? (
                  <div style={{ ...styles.timelineBox, marginTop: 10 }}>
                    <div style={{ fontWeight: 1000, marginBottom: 8 }}>聲音區段標注</div>
                    <div style={styles.resultLine}>目前：{audioTime.toFixed(2)}s / {audioDuration ? audioDuration.toFixed(2) : '?'}s</div>
                    <input type="range" min="0" max={Math.max(audioDuration || 1, 1)} step="0.05" value={Math.min(audioTime, audioDuration || 0)} onChange={(e) => seekAudio(e.target.value)} style={{ width: '100%', margin: '8px 0' }} />
                    <div style={styles.formGrid2}>
                      <label style={styles.miniLabel}>起點秒數<input style={styles.field} value={segStart} onChange={(e) => setSegStart(e.target.value)} inputMode="decimal" /></label>
                      <label style={styles.miniLabel}>終點秒數<input style={styles.field} value={segEnd} onChange={(e) => setSegEnd(e.target.value)} inputMode="decimal" /></label>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                      <button style={styles.btnSmall('rgba(255,255,255,0.08)')} onClick={markSegmentStart}>設為起點</button>
                      <button style={styles.btnSmall('rgba(255,255,255,0.08)')} onClick={markSegmentEnd}>設為終點</button>
                    </div>
                    <div style={{ marginTop: 10, fontWeight: 900 }}>距離階段</div>
                    <div style={styles.chipRow}>
                      {SOUND_STAGES.map((x) => <button key={x} style={segStage === x ? styles.chipOn : styles.chipOff} onClick={() => setSegStage(x)}>{soundStageLabel(x)}</button>)}
                    </div>
                    <input style={{ ...styles.field, marginTop: 10 }} value={segNote} onChange={(e) => setSegNote(e.target.value)} placeholder="區段備註" />
                    <button style={{ ...styles.actionBtn('#22c55e'), marginTop: 10 }} onClick={saveAudioSegment}>新增聲音區段</button>
                  </div>
                ) : null}
              </div>

              {/* 清除手動框 */}
              <div style={styles.section}>
                <button style={styles.btnSmall('rgba(255,255,255,0.08)')} onClick={clearManualRect}>
                  清除手動框
                </button>
              </div>

              <div style={{ height: 8 }} />
            </div>

            {/* sticky footer */}
            <div style={styles.stickyFooter}>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={{ ...styles.actionBtn('rgba(255,255,255,0.08)'), flex: 1 }}
                  onClick={() => setAnnotateOpen(false)}
                >
                  取消
                </button>
                <button
                  style={{
                    ...styles.actionBtn('#22c55e'),
                    flex: 1,
                    opacity: savingAnno ? 0.7 : 1,
                  }}
                  onClick={saveAnnotation}
                  disabled={savingAnno}
                >
                  {savingAnno ? '儲存中…' : '儲存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast ? <div style={styles.toast}>{toast}</div> : null}
    </div>
  );
}