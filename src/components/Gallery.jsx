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

  const isPhotoItem = (it) => {
    if (!it) return false;
    if (it.type === 'photo') return true;
    const mt = String(it.mimeType || '').toLowerCase();
    return mt.startsWith('image/');
  };

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
      });
    };
    setup();
    return () => {
      if (sub) sub.remove();
    };
  }, [previewOpen, annotateOpen]);

  const openPreview = async (item) => {
    setActiveItem(item);
    setPreviewOpen(true);

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
        busNo: (busNo || '').trim(),
        manualRect: manualRectNorm,
        // 你之後若要存 bbox / OCR raw text / distance / scheme，都可以在這裡擴充
      };

      const old = Array.isArray(data[idx].annotations) ? data[idx].annotations : [];
      data[idx] = {
        ...data[idx],
        annotations: [ann, ...old],
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
        minHeight: '100%',
        padding: '16px 14px',
        paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        background: '#0b0b0b',
        color: '#fff',
      },
      header: { fontSize: 20, fontWeight: 800, marginBottom: 10 },
      sub: { color: '#aaa', fontSize: 12, marginBottom: 12 },

      grid: { display: 'flex', flexDirection: 'column', gap: 10 },
      card: {
        background: '#161616',
        borderRadius: 14,
        padding: 12,
        border: '1px solid rgba(255,255,255,0.06)',
      },
      row: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' },
      title: { fontWeight: 800, fontSize: 14, lineHeight: 1.2 },
      meta: { color: '#9a9a9a', fontSize: 12, marginTop: 6, lineHeight: 1.3 },
      pill: {
        padding: '4px 8px',
        fontSize: 12,
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

  return (
    <div style={styles.page}>
      <div style={styles.header}>標注資料庫</div>
      <div style={styles.sub}>{loading ? '讀取中…' : `共 ${items.length} 筆資料`}</div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button
          onClick={reload}
          style={{
            height: 42,
            padding: '0 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            fontWeight: 800,
          }}
        >
          重新整理
        </button>
      </div>

      <div style={styles.grid}>
        {items.map((it) => {
          const isP = isPhotoItem(it);
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
                      ? ` • 標注 ${it.annotations.length}`
                      : ''}
                  </div>
                </div>
                <div style={styles.pill}>開啟</div>
              </div>
            </div>
          );
        })}
      </div>

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

              <div style={styles.actionGroup}>
                <button style={styles.actionBtn('#f59a00')} onClick={doShare}>
                  {isPhotoItem(activeItem) ? '匯出/分享照片' : '匯出/分享影片'}
                </button>

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

              {/* 錄音播放（影片可能有） */}
              <div style={styles.section}>
                <button style={styles.btnSmall('#1f3bff')} onClick={playAudio}>
                  {audioPlaying ? '停止播放錄音' : '播放錄音'}
                </button>
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