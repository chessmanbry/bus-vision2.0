import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Device } from '@capacitor/device';
import { App as CapacitorApp } from '@capacitor/app';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { BusVisionNative } from 'bus-vision-native';

const FOLDER_NAME = 'BusData';
const METADATA_FILE = `${FOLDER_NAME}/metadata.json`;
const IS_ANDROID_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
const FLASH_SEQUENCE = ['auto', 'on', 'off'];
const TASK_MODES = [
  { value: 'bus_detection', label: '公車偵測', hint: 'YOLO 公車本體/站牌/車流資料' },
  { value: 'route_ocr', label: '路線 OCR', hint: '車頭/LED/站牌號碼與文字辨識' },
  { value: 'audio_distance', label: '聲音距離', hint: '公車遠近聲音事件與提前通知研究' },
  { value: 'night_weather', label: '夜間/雨天補強', hint: '低光、雨天、逆光等困難樣本' },
  { value: 'calibration', label: '校正測距', hint: '鏡頭、焦距、羅盤、GPS 與點選測距' }
];
const SOUND_STAGES = ['background', 'far', 'middle', 'near', 'passing', 'leaving'];

async function ensureDir() {
  try { await Filesystem.mkdir({ path: FOLDER_NAME, directory: Directory.Data, recursive: true }); } catch (_) {}
}

async function readMetadata() {
  try {
    const res = await Filesystem.readFile({ path: METADATA_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    const parsed = JSON.parse(res.data || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

async function writeMetadata(items) {
  await ensureDir();
  await Filesystem.writeFile({
    path: METADATA_FILE,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data: JSON.stringify(items, null, 2)
  });
}

async function appendMetadata(item) {
  const items = await readMetadata();
  items.unshift(item);
  await writeMetadata(items);
}

async function getDeviceMeta() {
  try {
    const info = await Device.getInfo();
    return {
      manufacturer: info.manufacturer,
      model: info.model,
      platform: info.platform,
      osVersion: info.osVersion,
      operatingSystem: info.operatingSystem,
      isVirtual: info.isVirtual,
      webViewVersion: info.webViewVersion
    };
  } catch (_) {
    return {};
  }
}

async function getLocationMeta() {
  try {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 6000 });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      altitude: pos.coords.altitude,
      heading: pos.coords.heading,
      speed: pos.coords.speed
    };
  } catch (_) {
    return null;
  }
}

async function speak(text) {
  try {
    await TextToSpeech.speak({ text, lang: 'zh-TW', rate: 1.0, pitch: 1.0, volume: 1.0 });
  } catch (_) {}
}

function nowIso() { return new Date().toISOString(); }
function soundStageLabel(x) {
  return ({ background: '背景', far: '遠處接近', middle: '接近中', near: '即將抵達', passing: '經過身邊', leaving: '離開' })[x] || x;
}

export default function Recorder() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const webChunksRef = useRef([]);

  const [recording, setRecording] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [status, setStatus] = useState('初始化中...');
  const [lastSaved, setLastSaved] = useState(null);
  const [flashMode, setFlashMode] = useState('auto');
  const [zoom, setZoom] = useState(1);
  const [lightingMode, setLightingMode] = useState('auto');
  const [distanceEnabled, setDistanceEnabled] = useState(true);
  const [distanceTag, setDistanceTag] = useState('auto');
  const [sceneTag, setSceneTag] = useState('roadside');
  const [qualityTag, setQualityTag] = useState('normal');
  const [note, setNote] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lensTag, setLensTag] = useState('auto-wide');
  const [captureProfile, setCaptureProfile] = useState('training');
  const [taskMode, setTaskMode] = useState('bus_detection');
  const [soundDistanceStage, setSoundDistanceStage] = useState('background');
  const [annotationPreset, setAnnotationPreset] = useState('bus_full');
  const [recordDeviceMeta, setRecordDeviceMeta] = useState(true);
  const [recordLensMeta, setRecordLensMeta] = useState(true);
  const [recordCompassMeta, setRecordCompassMeta] = useState(true);
  const [recordLocationMeta, setRecordLocationMeta] = useState(true);
  const [recordFocusDistanceMeta, setRecordFocusDistanceMeta] = useState(true);
  const [focusInfo, setFocusInfo] = useState({ afState: 'UNKNOWN', estimatedMeters: null, finalDistanceMeters: null, distanceConfidence: 'unavailable', distanceSource: 'unavailable', tapX: null, tapY: null, arcore: null });
  const [focusPoint, setFocusPoint] = useState(null);
  const [zoomPanelOpen, setZoomPanelOpen] = useState(false);
  const [distanceHudOpen, setDistanceHudOpen] = useState(false);

  const stopWebCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const applyTransparentShell = () => {
    if (!IS_ANDROID_NATIVE) return;
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    const root = document.getElementById('root');
    if (root) root.style.backgroundColor = 'transparent';
  };

  const startCamera = async () => {
    setStatus('啟動相機中...');
    try {
      await ensureDir();
      if (IS_ANDROID_NATIVE) {
        stopWebCamera();
        const perm = await BusVisionNative.ensurePermissions();
        if (perm.camera !== 'granted') {
          setStatus('請允許相機權限');
          return;
        }
        if (perm.microphone !== 'granted' && perm.mic !== 'granted') {
          setStatus('請允許麥克風權限');
          return;
        }
        await BusVisionNative.startCamera();
        setCameraReady(true);
        setStatus('原生相機已就緒');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraReady(true);
      setStatus('Web 相機已就緒');
    } catch (err) {
      console.error(err);
      setCameraReady(false);
      setStatus(`相機啟動失敗：${err?.message || err}`);
    }
  };

  useEffect(() => {
    applyTransparentShell();
    startCamera();

    let sub;
    CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) startCamera();
      else {
        if (IS_ANDROID_NATIVE) BusVisionNative.stopCamera().catch(() => {});
        stopWebCamera();
        setCameraReady(false);
      }
    }).then((listener) => { sub = listener; });

    return () => {
      if (sub) sub.remove();
      if (IS_ANDROID_NATIVE) BusVisionNative.stopCamera().catch(() => {});
      stopWebCamera();
    };
  }, []);

  const effectiveLighting = () => {
    if (lightingMode !== 'auto') return lightingMode;
    const hour = new Date().getHours();
    return hour >= 18 || hour < 6 ? 'night' : 'day';
  };

  const buildBaseMetadata = async (kind) => {
    const [device, location] = await Promise.all([
      recordDeviceMeta ? getDeviceMeta() : Promise.resolve(null),
      recordLocationMeta || recordCompassMeta ? getLocationMeta() : Promise.resolve(null)
    ]);
    const locationForRecord = recordLocationMeta ? location : null;
    const compassForRecord = recordCompassMeta && location ? { heading: location.heading, speed: location.speed } : null;

    return {
      id: Date.now(),
      type: kind,
      createdAt: nowIso(),
      collectorVersion: 'bus-vision2.0.0.8.4-ui-layout-fix',
      source: IS_ANDROID_NATIVE ? 'android-native-camerax' : 'web-mediarecorder',
      captureProfile,
      taskMode,
      taskHint: TASK_MODES.find((m) => m.value === taskMode)?.hint || '',
      device,
      location: locationForRecord,
      telemetry: {
        enabled: {
          device: recordDeviceMeta,
          lens: recordLensMeta,
          location: recordLocationMeta,
          compass: recordCompassMeta,
          focusDistance: recordFocusDistanceMeta,
          objectDistance: distanceEnabled
        },
        lens: recordLensMeta ? lensTag : null,
        compass: compassForRecord,
        focusDistance: recordFocusDistanceMeta ? {
          mode: 'tap-to-focus',
          afState: focusInfo?.afState || 'UNKNOWN',
          focusDistanceDiopters: focusInfo?.focusDistanceDiopters ?? null,
          estimatedMeters: focusInfo?.estimatedMeters ?? null,
          finalDistanceMeters: focusInfo?.finalDistanceMeters ?? focusInfo?.estimatedMeters ?? null,
          distanceSource: focusInfo?.distanceSource || 'unavailable',
          arcore: focusInfo?.arcore || null,
          distancePipeline: focusInfo?.pipeline || ['arcore_depth', 'focus_distance', 'manual_label'],
          distanceConfidence: focusInfo?.distanceConfidence || 'unavailable',
          tapX: focusInfo?.tapX ?? null,
          tapY: focusInfo?.tapY ?? null,
          unit: 'meter',
          note: 'Camera2 LENS_FOCUS_DISTANCE estimate; use as approximate research metadata, not calibrated survey distance.'
        } : null,
        objectDistance: distanceEnabled ? { mode: 'arcore-focus-manual-fallback', tag: distanceTag, value: focusInfo?.finalDistanceMeters ?? focusInfo?.estimatedMeters ?? null, unit: 'meter', confidence: focusInfo?.distanceConfidence || 'unavailable', source: focusInfo?.distanceSource || 'unavailable', arcore: focusInfo?.arcore || null } : null,
        flashMode,
        zoomRatio: zoom,
        soundDistanceStage
      },
      tags: {
        scene: sceneTag,
        distance: distanceEnabled ? distanceTag : 'disabled',
        soundStage: soundDistanceStage,
        lighting: effectiveLighting(),
        lightingMode,
        quality: qualityTag
      },
      labels: [],
      annotation: {
        schemaVersion: 'dataset-v2',
        preset: annotationPreset,
        boxes: [],
        ocr: null,
        busNumber: '',
        vehicleMake: '',
        vehicleModel: '',
        vehicleYearRange: '',
        yoloClass: ''
      },
      trainingTargets: {
        image: true,
        audio: kind === 'video',
        vmmr: true,
        busRouteOcr: true,
        distanceRegression: distanceEnabled,
        soundEvent: kind === 'video',
        soundDistanceStage: kind === 'video' ? soundDistanceStage : null
      },
      note
    };
  };

  const applyFlashMode = async (mode) => {
    setFlashMode(mode);
    if (!IS_ANDROID_NATIVE) return;
    try {
      await BusVisionNative.setTorch({ enabled: mode === 'on' });
      setStatus(mode === 'on' ? '閃光燈：開啟' : mode === 'off' ? '閃光燈：關閉' : '閃光燈：自動');
    } catch (err) {
      setStatus(`閃光燈不可用：${err?.message || err}`);
    }
  };

  const cycleFlash = () => {
    const currentIndex = FLASH_SEQUENCE.indexOf(flashMode);
    const next = FLASH_SEQUENCE[(currentIndex + 1) % FLASH_SEQUENCE.length];
    applyFlashMode(next);
  };

  const cycleLighting = () => {
    const seq = ['auto', 'day', 'night'];
    const next = seq[(seq.indexOf(lightingMode) + 1) % seq.length];
    setLightingMode(next);
    setStatus(next === 'auto' ? '日夜間：自動判斷' : next === 'day' ? '日夜間：日間' : '日夜間：夜間');
  };

  const changeZoom = async (next) => {
    const safeZoom = Math.max(1, Math.min(10, Number(next) || 1));
    setZoom(safeZoom);
    if (IS_ANDROID_NATIVE) {
      try { await BusVisionNative.setZoom({ ratio: safeZoom }); } catch (_) {}
    }
  };


  const formatMeters = (value) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '無資料';
    const n = Number(value);
    if (n >= 20) return `≈ ${n.toFixed(0)} m`;
    if (n >= 3) return `≈ ${n.toFixed(1)} m`;
    return `≈ ${n.toFixed(2)} m`;
  };

  const afLabel = (state) => ({
    FOCUSED_LOCKED: '已對焦',
    PASSIVE_FOCUSED: '已對焦',
    PASSIVE_SCAN: '對焦中',
    ACTIVE_SCAN: '對焦中',
    NOT_FOCUSED_LOCKED: '對焦失敗',
    PASSIVE_UNFOCUSED: '未對焦',
    INACTIVE: '待對焦',
    UNKNOWN: '未知'
  })[state] || state || '未知';

  const confidenceLabel = (x) => ({ high: '高', medium: '中', low: '低', unavailable: '無資料' })[x] || x || '無資料';

  const sourceLabel = (x) => ({ arcore_depth: 'ARCore Depth', focus_distance: '對焦距離', manual_label: '手動標籤', unavailable: '無資料' })[x] || x || '無資料';

  const handlePreviewTap = async (event) => {
    if (!distanceEnabled && !recordFocusDistanceMeta) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    setFocusPoint({ x, y, ts: Date.now() });
    setStatus('對焦 / 估算距離中...');
    try {
      let info;
      if (IS_ANDROID_NATIVE) {
        info = await BusVisionNative.getDistanceEstimate({ x, y, manualTag: distanceTag });
      } else {
        info = { ok: true, tapX: x, tapY: y, afState: 'WEB_TAP_RECORDED', estimatedMeters: null, finalDistanceMeters: null, distanceConfidence: 'unavailable', distanceSource: 'manual_label', manualDistanceLabel: distanceTag, timestamp: Date.now() };
      }
      const normalized = {
        ...info,
        tapX: info.tapX ?? x,
        tapY: info.tapY ?? y,
        capturedAt: nowIso()
      };
      setFocusInfo(normalized);
      setStatus(`AF：${afLabel(normalized.afState)}｜距離：${formatMeters(normalized.finalDistanceMeters ?? normalized.estimatedMeters)}｜來源：${sourceLabel(normalized.distanceSource)}｜信心：${confidenceLabel(normalized.distanceConfidence)}`);
    } catch (err) {
      const fallback = { tapX: x, tapY: y, afState: 'UNKNOWN', estimatedMeters: null, finalDistanceMeters: null, distanceConfidence: 'unavailable', distanceSource: distanceTag !== 'auto' ? 'manual_label' : 'unavailable', manualDistanceLabel: distanceTag, capturedAt: nowIso(), warning: String(err?.message || err) };
      setFocusInfo(fallback);
      setStatus(`對焦資料不可用：${err?.message || err}`);
    }
  };

  const startRecording = async () => {
    if (!cameraReady) await startCamera();
    setStatus('開始錄影與收音...');
    if (IS_ANDROID_NATIVE) {
      await BusVisionNative.startRecording({ sampleRate: 48000, channels: 1 });
      setRecording(true);
      setStatus('採集中：MP4 + WAV + metadata');
      speak('開始採集');
      return;
    }

    webChunksRef.current = [];
    const stream = streamRef.current;
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (event) => { if (event.data?.size) webChunksRef.current.push(event.data); };
    mr.start(1000);
    setRecording(true);
    setStatus('Web 採集中');
  };

  const stopRecording = async () => {
    setStatus('停止並寫入資料...');
    if (IS_ANDROID_NATIVE) {
      const result = await BusVisionNative.stopRecording();
      const meta = await buildBaseMetadata('video');
      const item = {
        ...meta,
        path: result.path,
        audioPath: result.audioPath,
        filename: result.filename,
        audioFilename: result.audioFilename,
        mimeType: result.mimeType || 'video/mp4',
        durationMs: result.durationMs || 0,
        cameraMeta: result.cameraMeta || {},
        focusEvent: focusInfo || null
      };
      await appendMetadata(item);
      setLastSaved(item);
      setRecording(false);
      setStatus('已保存影片、聲音與 metadata');
      speak('採集完成');
      return;
    }

    await new Promise((resolve) => {
      const mr = mediaRecorderRef.current;
      if (!mr) return resolve();
      mr.onstop = resolve;
      mr.stop();
    });
    const blob = new Blob(webChunksRef.current, { type: 'video/webm' });
    const base64 = await blobToBase64(blob);
    const ts = Date.now();
    const path = `${FOLDER_NAME}/WEB_${ts}.webm`;
    await Filesystem.writeFile({ path, directory: Directory.Data, data: base64 });
    const meta = await buildBaseMetadata('video');
    const item = { ...meta, path, filename: `WEB_${ts}.webm`, mimeType: 'video/webm', sizeBytes: blob.size };
    await appendMetadata(item);
    setLastSaved(item);
    setRecording(false);
    setStatus('已保存 Web 影片與 metadata');
  };

  const takePhoto = async () => {
    try {
      if (!cameraReady) await startCamera();
      setStatus('拍照中...');
      if (IS_ANDROID_NATIVE) {
        const result = await BusVisionNative.takePhoto({ filename: `IMG_${Date.now()}.jpg` });
        const meta = await buildBaseMetadata('photo');
        const item = {
          ...meta,
          path: result.path,
          filename: result.filename,
          mimeType: result.mimeType || 'image/jpeg',
          cameraMeta: result.cameraMeta || {},
          focusEvent: focusInfo || null
        };
        await appendMetadata(item);
        setLastSaved(item);
        setStatus('照片與 metadata 已保存');
        speak('照片已保存');
        return;
      }
      const canvas = document.createElement('canvas');
      const v = videoRef.current;
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const ts = Date.now();
      const path = `${FOLDER_NAME}/IMG_${ts}.jpg`;
      await Filesystem.writeFile({ path, directory: Directory.Data, data: dataUrl.split(',')[1] });
      const meta = await buildBaseMetadata('photo');
      const item = { ...meta, path, filename: `IMG_${ts}.jpg`, mimeType: 'image/jpeg' };
      await appendMetadata(item);
      setLastSaved(item);
      setStatus('照片與 metadata 已保存');
    } catch (err) {
      console.error(err);
      setStatus(`拍照失敗：${err?.message || err}`);
    }
  };


  useEffect(() => {
    let sub;
    CapacitorApp.addListener('backButton', () => {
      if (drawerOpen) {
        setDrawerOpen(false);
      }
    }).then((listener) => { sub = listener; });
    return () => { if (sub) sub.remove(); };
  }, [drawerOpen]);

  const toggleRecording = async () => {
    try {
      if (recording) await stopRecording();
      else await startRecording();
    } catch (err) {
      console.error(err);
      setStatus(`錄影失敗：${err?.message || err}`);
      setRecording(false);
    }
  };

  return (
    <div style={styles.shell} onClick={handlePreviewTap}>
      <video ref={videoRef} autoPlay playsInline muted style={styles.webVideo} />
      <div style={{ ...styles.nightOverlay, background: effectiveLighting() === 'night' ? 'rgba(20,40,80,0.12)' : 'transparent' }} />

      <div style={styles.statusBar} onClick={(e) => e.stopPropagation()}>
        <div style={styles.leftStatus}>
          <span style={styles.statusDot(cameraReady ? '#28e070' : '#ffba33')} />
          <span>{recording ? 'REC' : cameraReady ? 'READY' : 'INIT'}</span>
          <span style={styles.statusText}>{status}</span>
        </div>
        <div style={styles.rightStatus}>
          <IconButton title="日夜間" label="日夜" active={lightingMode !== 'auto'} onClick={cycleLighting}>{lightingIcon(lightingMode)}</IconButton>
          <IconButton title="閃光燈" label="閃光" active={flashMode !== 'off'} onClick={cycleFlash}>{flashIcon(flashMode)}</IconButton>
          <IconButton title="測距" label="測距" active={distanceEnabled} onClick={() => setDistanceEnabled(!distanceEnabled)}>📐</IconButton>
          <IconButton title="設定" label="更多" active={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>🧰</IconButton>
        </div>
      </div>

      {focusPoint && (
        <div style={{ ...styles.tapFocusBox, left: `${focusPoint.x * 100}%`, top: `${focusPoint.y * 100}%` }}>
          <div style={styles.tapFocusSquare} />
        </div>
      )}

      <div style={styles.focusHud} onClick={(e) => e.stopPropagation()}>
        <button style={styles.panelMiniHeader} onClick={() => setDistanceHudOpen(!distanceHudOpen)}>
          <span>📏 距離</span>
          <strong>{formatMeters(focusInfo.finalDistanceMeters ?? focusInfo.estimatedMeters)}</strong>
          <span>{distanceHudOpen ? '⌄' : '⌃'}</span>
        </button>
        {distanceHudOpen && (
          <div style={styles.panelBody}>
            <div>AF：<strong>{afLabel(focusInfo.afState)}</strong></div>
            <div>來源：<strong>{sourceLabel(focusInfo.distanceSource)}</strong></div>
            <div>信心：<strong>{confidenceLabel(focusInfo.distanceConfidence)}</strong></div>
          </div>
        )}
      </div>

      <div style={styles.zoomPanel} onClick={(e) => e.stopPropagation()}>
        <button style={styles.panelMiniHeader} onClick={() => setZoomPanelOpen(!zoomPanelOpen)}>
          <span>🔎 變焦</span>
          <strong>{zoom.toFixed(1)}×</strong>
          <span>{zoomPanelOpen ? '⌄' : '⌃'}</span>
        </button>
        {zoomPanelOpen && (
          <div style={styles.panelBody}>
            <input
              aria-label="快速變焦"
              style={styles.zoomSlider}
              value={zoom}
              min="1"
              max="10"
              step="0.1"
              type="range"
              onChange={(e) => changeZoom(Number(e.target.value))}
            />
            <div style={styles.zoomTicks}>
              {[1, 2, 3, 5, 10].map((z) => (
                <button key={z} style={styles.zoomTickButton} onClick={() => changeZoom(z)}>{z}×</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {lastSaved && <div style={styles.savedToast}>已保存：{lastSaved.filename || lastSaved.path}</div>}

      <div style={styles.bottomControls} onClick={(e) => e.stopPropagation()}>
        <button onClick={startCamera} style={styles.roundAction} aria-label="重啟相機"><span>🔄</span><small>重啟</small></button>
        <button onClick={toggleRecording} style={recording ? styles.recordBtnActive : styles.recordBtn} aria-label="record">
          {recording ? <span style={styles.stopSquare} /> : <span style={styles.recordInnerDot} />}
        </button>
        <button onClick={takePhoto} style={styles.roundAction} aria-label="拍照"><span>📸</span><small>拍照</small></button>
      </div>

      <div style={{ ...styles.drawer, transform: drawerOpen ? 'translateY(0)' : 'translateY(calc(100% - 44px))' }} onClick={(e) => e.stopPropagation()}>
        <button style={styles.drawerHandle} onClick={() => setDrawerOpen(!drawerOpen)}>
          <span>{drawerOpen ? '收合設定' : '更多採集設定'}</span>
          <span>{drawerOpen ? '⌄' : '⌃'}</span>
        </button>

        <div style={styles.drawerContent}>
          <SectionTitle>任務模式</SectionTitle>
          <RowScroll>
            {TASK_MODES.map((m) => <Chip key={m.value} active={taskMode === m.value} onClick={() => setTaskMode(m.value)}>{m.label}</Chip>)}
          </RowScroll>
          <div style={styles.helpText}>{TASK_MODES.find((m) => m.value === taskMode)?.hint}</div>

          <SectionTitle>聲音距離階段</SectionTitle>
          <RowScroll>
            {SOUND_STAGES.map((x) => <Chip key={x} active={soundDistanceStage === x} onClick={() => setSoundDistanceStage(x)}>{soundStageLabel(x)}</Chip>)}
          </RowScroll>

          <SectionTitle>快速標籤</SectionTitle>
          <RowScroll>
            {['roadside', 'bus-stop', 'intersection', 'inside-bus', 'parking'].map((x) => <Chip key={x} active={sceneTag === x} onClick={() => setSceneTag(x)}>{sceneLabel(x)}</Chip>)}
          </RowScroll>
          <RowScroll>
            {['auto', 'near', 'middle', 'far', 'unknown'].map((x) => <Chip key={x} active={distanceTag === x} onClick={() => setDistanceTag(x)}>{distanceLabel(x)}</Chip>)}
          </RowScroll>

          <SectionTitle>採集參數</SectionTitle>
          <div style={styles.formGrid}>
            <label style={styles.field}>Zoom
              <input value={zoom} min="1" max="10" step="0.1" type="range" onChange={(e) => changeZoom(Number(e.target.value))} />
            </label>
            <label style={styles.field}>鏡頭
              <select value={lensTag} onChange={(e) => setLensTag(e.target.value)} style={styles.select}>
                <option value="auto-wide">自動 / 廣角</option>
                <option value="main-wide">主鏡頭</option>
                <option value="ultra-wide">超廣角</option>
                <option value="telephoto">長焦</option>
              </select>
            </label>
            <label style={styles.field}>品質
              <select value={qualityTag} onChange={(e) => setQualityTag(e.target.value)} style={styles.select}>
                <option value="normal">正常</option>
                <option value="blur">模糊</option>
                <option value="occluded">遮擋</option>
                <option value="low-light">低光</option>
                <option value="rain">雨天</option>
              </select>
            </label>
            <label style={styles.field}>用途
              <select value={captureProfile} onChange={(e) => setCaptureProfile(e.target.value)} style={styles.select}>
                <option value="training">訓練資料</option>
                <option value="calibration">校正 / 測距</option>
                <option value="ocr">OCR 路線/車牌</option>
                <option value="audio">聲音資料</option>
              </select>
            </label>
            <label style={styles.field}>標注預設
              <select value={annotationPreset} onChange={(e) => setAnnotationPreset(e.target.value)} style={styles.select}>
                <option value="bus_full">公車本體框</option>
                <option value="route_display">路線顯示框</option>
                <option value="license_plate">車牌框</option>
                <option value="bus_stop_sign">站牌框</option>
              </select>
            </label>
          </div>

          <SectionTitle>預設紀錄項目</SectionTitle>
          <div style={styles.toggleGrid}>
            <Toggle label="設備" value={recordDeviceMeta} onChange={setRecordDeviceMeta} />
            <Toggle label="鏡頭" value={recordLensMeta} onChange={setRecordLensMeta} />
            <Toggle label="羅盤" value={recordCompassMeta} onChange={setRecordCompassMeta} />
            <Toggle label="GPS" value={recordLocationMeta} onChange={setRecordLocationMeta} />
            <Toggle label="對焦距離" value={recordFocusDistanceMeta} onChange={setRecordFocusDistanceMeta} />
            <Toggle label="物體測距" value={distanceEnabled} onChange={setDistanceEnabled} />
          </div>

          <SectionTitle>即時對焦 / 距離估計</SectionTitle>
          <div style={styles.focusDetail}>
            <div>AF 狀態：{afLabel(focusInfo.afState)}</div>
            <div>估計距離：{formatMeters(focusInfo.finalDistanceMeters ?? focusInfo.estimatedMeters)}</div>
            <div>距離來源：{sourceLabel(focusInfo.distanceSource)}</div>
            <div>信心等級：{confidenceLabel(focusInfo.distanceConfidence)}</div>
            <div>ARCore：{focusInfo.arcore?.status || '尚未檢查'}</div>
            <div>Tap：{focusInfo.tapX != null ? `${Number(focusInfo.tapX).toFixed(3)}, ${Number(focusInfo.tapY).toFixed(3)}` : '尚未點擊'}</div>
          </div>

          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="本筆資料備註，例如：公車接近、車牌被遮、環境噪音大" style={styles.noteStyle} />
        </div>
      </div>
    </div>
  );
}

function IconButton({ active, onClick, title, label, children }) {
  return (
    <button title={title} onClick={onClick} style={{ ...styles.iconBtn, ...(active ? styles.iconBtnActive : {}) }}>
      <span style={styles.iconGlyph}>{children}</span>
      <span style={styles.iconLabel}>{label}</span>
    </button>
  );
}

function Toggle({ label, value, onChange }) {
  return <button onClick={() => onChange(!value)} style={{ ...styles.toggle, ...(value ? styles.toggleActive : {}) }}><span>{label}</span><strong>{value ? 'ON' : 'OFF'}</strong></button>;
}

function Chip({ active, onClick, children }) {
  return <button onClick={onClick} style={{ ...styles.chip, ...(active ? styles.chipActive : {}) }}>{children}</button>;
}

function RowScroll({ children }) { return <div style={styles.rowScroll}>{children}</div>; }
function SectionTitle({ children }) { return <div style={styles.sectionTitle}>{children}</div>; }

function lightingIcon(mode) {
  if (mode === 'day') return '☀️';
  if (mode === 'night') return '🌙';
  return 'A☀️';
}
function flashIcon(mode) {
  if (mode === 'on') return '⚡';
  if (mode === 'off') return '⚡︎';
  return 'A⚡';
}
function distanceLabel(x) {
  return ({ auto: '自動測距', unknown: '距離未知', near: '近距離', middle: '中距離', far: '遠距離' })[x] || x;
}
function sceneLabel(x) {
  return ({ roadside: '路側', 'bus-stop': '站牌', intersection: '路口', 'inside-bus': '車內', parking: '停車場' })[x] || x;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const glass = 'rgba(0,0,0,0.62)';
const border = '1px solid rgba(255,255,255,0.22)';
const styles = {
  shell: { height: '100%', background: IS_ANDROID_NATIVE ? 'transparent' : '#000', position: 'relative', overflow: 'hidden', color: '#fff', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' },
  webVideo: { width: '100%', height: '100%', objectFit: 'cover', background: '#000', display: IS_ANDROID_NATIVE ? 'none' : 'block' },
  nightOverlay: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  statusBar: { position: 'absolute', top: 12, left: 12, right: 12, zIndex: 40, minHeight: 48, borderRadius: 18, background: 'rgba(0,0,0,0.48)', border, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 8px 6px 12px', backdropFilter: 'blur(16px)' },
  leftStatus: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontWeight: 900, letterSpacing: 0.4 },
  statusText: { maxWidth: 145, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.9, fontWeight: 700, fontSize: 12 },
  rightStatus: { display: 'flex', alignItems: 'center', gap: 7 },
  iconBtn: { width: 48, height: 46, borderRadius: 17, border: '1px solid rgba(255,255,255,0.26)', background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(0,0,0,0.46))', color: '#fff', fontWeight: 1000, fontSize: 15, display: 'grid', placeItems: 'center', gap: 0, padding: '3px 2px', boxShadow: '0 8px 22px rgba(0,0,0,0.32)', backdropFilter: 'blur(14px)' },
  iconBtnActive: { border: '1px solid rgba(255,245,120,0.95)', background: 'linear-gradient(180deg, rgba(255,235,120,0.34), rgba(255,150,40,0.18))', color: '#fff8a8', boxShadow: '0 0 18px rgba(255,230,90,0.35), 0 8px 22px rgba(0,0,0,0.32)' },
  iconGlyph: { fontSize: 18, lineHeight: 1 },
  iconLabel: { fontSize: 9, lineHeight: 1, letterSpacing: 0.2, opacity: 0.92 },
  tapFocusBox: { position: 'absolute', zIndex: 24, transform: 'translate(-50%, -50%)', pointerEvents: 'none' },
  tapFocusSquare: { width: 70, height: 70, border: '2px solid rgba(255,255,120,0.96)', borderRadius: 18, boxShadow: '0 0 22px rgba(255,255,80,0.45), inset 0 0 18px rgba(255,255,80,0.12)' },
  focusHud: { position: 'absolute', left: 12, top: 78, zIndex: 31, minWidth: 126, borderRadius: 16, background: 'rgba(0,0,0,0.46)', border, backdropFilter: 'blur(14px)', overflow: 'hidden' },
  panelMiniHeader: { width: '100%', minHeight: 34, border: 'none', background: 'transparent', color: '#fff7ad', display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 8, padding: '7px 10px', fontSize: 12, fontWeight: 1000, textAlign: 'left' },
  panelBody: { display: 'grid', gap: 5, padding: '0 10px 9px', color: '#fff', fontSize: 11, fontWeight: 800, lineHeight: 1.25 },
  focusHint: { color: '#ffff99', fontSize: 11, maxWidth: 185 },
  zoomPanel: { position: 'absolute', left: 18, right: 18, bottom: 156, zIndex: 36, borderRadius: 18, background: 'rgba(0,0,0,0.46)', border, backdropFilter: 'blur(16px)', boxShadow: '0 12px 30px rgba(0,0,0,0.30)', overflow: 'hidden' },
  zoomHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 1000, color: '#fff7ad', marginBottom: 3 },
  zoomSlider: { width: '100%', accentColor: '#fff36b', height: 28 },
  zoomTicks: { display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 2 },
  zoomTickButton: { flex: 1, height: 26, borderRadius: 999, border: '1px solid rgba(255,255,255,0.20)', background: 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 11, fontWeight: 1000, padding: 0 },
  savedToast: { position: 'absolute', left: 12, right: 12, bottom: 236, zIndex: 34, padding: '10px 12px', borderRadius: 14, background: 'rgba(0,90,30,0.68)', border: '1px solid rgba(120,255,170,0.45)', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bottomControls: { position: 'absolute', bottom: 58, left: 0, right: 0, zIndex: 35, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, pointerEvents: 'auto' },
  roundAction: { width: 64, height: 64, borderRadius: 22, border: '1px solid rgba(255,255,255,0.30)', background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(0,0,0,0.54))', color: '#fff', fontWeight: 1000, display: 'grid', placeItems: 'center', padding: '5px 0', boxShadow: '0 10px 26px rgba(0,0,0,0.38)', backdropFilter: 'blur(14px)' },
  recordBtn: { width: 88, height: 88, borderRadius: 999, background: 'linear-gradient(180deg, #ff6b6b, #ff2020)', border: '6px solid #fff', boxShadow: '0 10px 32px rgba(0,0,0,0.58), 0 0 18px rgba(255,60,60,0.38)', display: 'grid', placeItems: 'center', padding: 0 },
  recordBtnActive: { width: 88, height: 88, borderRadius: 999, background: '#fff', border: '6px solid #ff4a4a', boxShadow: '0 10px 32px rgba(0,0,0,0.58)', display: 'grid', placeItems: 'center', padding: 0 },
  recordInnerDot: { width: 58, height: 58, borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '2px solid rgba(255,255,255,0.46)', display: 'block' },
  stopSquare: { width: 30, height: 30, borderRadius: 8, background: '#ff3333', display: 'block' },
  drawer: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 45, maxHeight: '72%', background: 'rgba(8,8,10,0.92)', borderTop: '1px solid rgba(255,255,255,0.20)', borderTopLeftRadius: 20, borderTopRightRadius: 20, transition: 'transform 220ms ease', backdropFilter: 'blur(18px)', boxShadow: '0 -18px 48px rgba(0,0,0,0.45)' },
  drawerHandle: { width: '100%', height: 44, background: 'transparent', color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', fontWeight: 1000, fontSize: 13 },
  drawerContent: { padding: '0 14px 18px', overflowY: 'auto', maxHeight: 'calc(72vh - 44px)' },
  sectionTitle: { fontSize: 13, fontWeight: 1000, opacity: 0.78, margin: '12px 4px 8px', letterSpacing: 0.8 },
  rowScroll: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 3 },
  helpText: { color: '#b9c7ff', fontSize: 12, lineHeight: 1.35, padding: '0 4px 4px' },
  chip: { padding: '9px 12px', borderRadius: 999, border, background: 'rgba(255,255,255,0.06)', color: '#fff', fontWeight: 900, whiteSpace: 'nowrap' },
  chipActive: { border: '1px solid #ffff66', background: 'rgba(255,255,0,0.18)', color: '#ffff99' },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  field: { display: 'grid', gap: 6, padding: 10, borderRadius: 14, background: 'rgba(255,255,255,0.06)', border, fontSize: 12, fontWeight: 900 },
  select: { height: 36, borderRadius: 10, background: '#111', color: '#fff', border, padding: '0 8px', fontWeight: 800 },
  toggleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
  toggle: { minHeight: 42, borderRadius: 14, border, background: 'rgba(255,255,255,0.06)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 10px', fontWeight: 900 },
  toggleActive: { border: '1px solid rgba(80,255,150,0.72)', background: 'rgba(20,160,80,0.25)' },
  focusDetail: { display: 'grid', gap: 6, padding: 10, borderRadius: 14, background: 'rgba(255,255,255,0.06)', border, color: '#e8e8e8', fontSize: 12, fontWeight: 800 },
  noteStyle: { width: '100%', height: 42, marginTop: 12, borderRadius: 14, background: '#111', color: '#fff', border, padding: '0 12px', fontWeight: 800, boxSizing: 'border-box' }
};
styles.statusDot = (color) => ({ width: 9, height: 9, borderRadius: 999, background: color, boxShadow: `0 0 12px ${color}` });
