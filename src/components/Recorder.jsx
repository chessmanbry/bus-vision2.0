import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { App as CapacitorApp } from '@capacitor/app';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

const METADATA_FILE = 'BusData/metadata.json';
const FOLDER_NAME = 'BusData';

// === 幾何估距：物理寬度（m） ===
const OBJ_WIDTH_M = {
  bus: 2.55,
  car: 1.8,
  truck: 2.5,
  person: 0.5,
  motorcycle: 0.8,
  bicycle: 0.6,
};

const DEFAULT_HFOV_DEG = 62;

function safeNowId() {
  return Date.now();
}

export default function Recorder() {
  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);

  const [stream, setStream] = useState(null);
  const streamRef = useRef(null);

  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(null);

  const videoChunksRef = useRef([]);
  const [status, setStatus] = useState('初始化相機...');
  const [timer, setTimer] = useState(0);

  // 錄影 session（用來把錄影中的拍照綁到同一筆影片）
  const recordSessionIdRef = useRef(null);
  const pendingPhotosRef = useRef([]); // [{path, filename, createdAt}]

  // zoom
  const [zoomSupported, setZoomSupported] = useState(false);
  const [zoomMax, setZoomMax] = useState(5);
  const [zoomMin, setZoomMin] = useState(1);
  const [zoomTarget, setZoomTarget] = useState(1);
  const zoomAppliedRef = useRef(1);
  const zoomApplyTimerRef = useRef(null);

  // night/exposure
  const [isNightMode, setIsNightMode] = useState(false);
  const isNightModeRef = useRef(false);
  const brightnessIntervalRef = useRef(null);

  // compass
  const [currentHeading, setCurrentHeading] = useState(0);
  const [recordedGeoData, setRecordedGeoData] = useState(null);

  // distance (measuring)
  const [distanceText, setDistanceText] = useState('N/A');
  const [measureEnabled, setMeasureEnabled] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const lastDetectionsRef = useRef([]);
  const selectedDetRef = useRef(null);

  // overview window (viewfinder)
  const [showOverview, setShowOverview] = useState(true);

  // focus (not real distance; just show if exists)
  const [focusDist, setFocusDist] = useState('N/A');

  const [needsUserGesture, setNeedsUserGesture] = useState(false);

  // ===== 狀態燈：🟢準備、🔴錄影、🟡儲存中 =====
  const recLamp = useMemo(() => {
    if (progress !== null) return '🟡';
    if (recording) return '🔴';
    return '🟢';
  }, [progress, recording]);

  // ===== 測距方案燈（先用 bbox 幾何 => 方案一 🟢；之後接 Depth/ARCore => 🟡；雙鏡頭視差 => 🔴）=====
  // 目前程式只有 bbox 幾何估距，因此 measureLamp 固定 🟢（measureEnabled 時）
  const measureLamp = useMemo(() => {
    if (!measureEnabled) return '';
    return '🟢';
  }, [measureEnabled]);

  // === TTS ===
  const speak = async (text) => {
    try {
      await TextToSpeech.speak({
        text,
        lang: 'zh-TW',
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        category: 'ambient',
      });
      return;
    } catch (_) {}

    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-TW';
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
      }
    } catch (_) {}
  };

  // === MediaRecorder mimeType fallback（Android WebView 最關鍵）===
  const pickBestMimeType = () => {
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/mp4',
    ];
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  };

  const mimeToExt = (mime) => {
    if (!mime) return 'webm';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('webm')) return 'webm';
    return 'webm';
  };

  const ensureDir = async () => {
    try {
      await Filesystem.mkdir({ path: FOLDER_NAME, directory: Directory.Data, recursive: true });
    } catch (_) {}
  };

  const stopCamera = () => {
    try {
      const s = streamRef.current || stream;
      if (s) s.getTracks().forEach((track) => track.stop());
    } catch (_) {}

    streamRef.current = null;
    setStream(null);

    if (brightnessIntervalRef.current) {
      clearInterval(brightnessIntervalRef.current);
      brightnessIntervalRef.current = null;
    }

    if (zoomApplyTimerRef.current) {
      clearTimeout(zoomApplyTimerRef.current);
      zoomApplyTimerRef.current = null;
    }

    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const ensureLocationPermission = async () => {
    try {
      await Geolocation.requestPermissions();
    } catch (_) {}
  };

  const initZoomCaps = (mediaStream) => {
    try {
      const track = mediaStream.getVideoTracks?.()[0];
      const caps = track?.getCapabilities?.() || {};
      if (caps && 'zoom' in caps) {
        const mn = Number(caps.zoom.min ?? 1);
        const mx = Number(caps.zoom.max ?? 5);
        setZoomSupported(true);
        setZoomMin(isFinite(mn) ? mn : 1);
        setZoomMax(isFinite(mx) ? mx : 5);
        setZoomTarget((z) => Math.min(mx, Math.max(mn, z)));
        zoomAppliedRef.current = Math.min(mx, Math.max(mn, zoomAppliedRef.current));
      } else {
        setZoomSupported(false);
        setZoomMin(1);
        setZoomMax(5);
      }
    } catch (_) {
      setZoomSupported(false);
      setZoomMin(1);
      setZoomMax(5);
    }
  };

  const applyZoomSmooth = async (target) => {
    const s = streamRef.current || stream;
    if (!s) return;

    const track = s.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.() || {};

    const mn = zoomMin ?? 1;
    const mx = zoomMax ?? 5;
    const t = Math.min(mx, Math.max(mn, target));

    const from = zoomAppliedRef.current || 1;
    const steps = 6;
    const dt = 28;

    if (!(caps && 'zoom' in caps)) {
      zoomAppliedRef.current = t;
      return;
    }

    for (let i = 1; i <= steps; i++) {
      const z = from + ((t - from) * i) / steps;
      try {
        // eslint-disable-next-line no-await-in-loop
        await track.applyConstraints({ advanced: [{ zoom: z }] });
        zoomAppliedRef.current = z;
      } catch (_) {
        zoomAppliedRef.current = t;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, dt));
    }
  };

  const setZoom = (z) => {
    setZoomTarget(z);
    if (zoomApplyTimerRef.current) clearTimeout(zoomApplyTimerRef.current);
    zoomApplyTimerRef.current = setTimeout(() => {
      applyZoomSmooth(z);
    }, 90);
  };

  const startCamera = async () => {
    stopCamera();
    setStatus('初始化相機...');
    setNeedsUserGesture(false);
    setDistanceText('N/A');
    selectedDetRef.current = null;
    lastDetectionsRef.current = [];

    await ensureLocationPermission();

    try {
      let mediaStream = null;

      const baseVideo = {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: baseVideo, audio: true });
      } catch (e) {
        console.warn('getUserMedia(audio=true) failed, fallback audio=false:', e);
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: baseVideo, audio: false });
      }

      streamRef.current = mediaStream;
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().catch((err) => console.warn('video play failed:', err));
        };
      }

      initZoomCaps(mediaStream);

      // 嘗試啟用連續對焦/防抖（不保證支援，吞錯）
      try {
        const track = mediaStream.getVideoTracks?.()[0];
        const caps = track?.getCapabilities?.() || {};
        const adv = [];
        if (caps.focusMode) adv.push({ focusMode: 'continuous' });
        if (caps.stabilizationMode) adv.push({ stabilizationMode: 'continuous' });
        if (caps.videoStabilizationMode) adv.push({ videoStabilizationMode: 'auto' });
        if (adv.length) await track.applyConstraints({ advanced: adv });
      } catch (_) {}

      startSmartExposure(mediaStream);

      setStatus('就緒');
      await speak('相機已啟動');
    } catch (err) {
      console.error('startCamera failed:', err);
      const name = err?.name || '';
      const msg = err?.message || String(err);

      if (name === 'NotAllowedError' || msg.toLowerCase().includes('permission')) {
        setNeedsUserGesture(true);
      }

      setStatus(`相機啟動失敗: ${name} ${msg}`);
      await speak('相機啟動失敗');
    }
  };

  // 夜間/曝光智慧調整（暗時提高 EV）
  const startSmartExposure = (mediaStream) => {
    if (brightnessIntervalRef.current) clearInterval(brightnessIntervalRef.current);

    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    brightnessIntervalRef.current = setInterval(() => {
      if (!videoRef.current) return;
      try {
        ctx.drawImage(videoRef.current, 0, 0, 48, 48);
        const frame = ctx.getImageData(0, 0, 48, 48);
        const data = frame.data;

        let total = 0;
        for (let i = 0; i < data.length; i += 16) {
          total += (data[i] + data[i + 1] + data[i + 2]) / 3;
        }
        const avg = total / (data.length / 16);

        const track = mediaStream.getVideoTracks?.()[0];
        const capabilities = track?.getCapabilities?.() || {};
        const settings = track?.getSettings?.() || {};

        if (settings.focusDistance) setFocusDist(Number(settings.focusDistance).toFixed(2) + 'm');
        else setFocusDist('N/A');

        if ('exposureCompensation' in capabilities) {
          const evMax = Number(capabilities.exposureCompensation.max ?? 2);

          let shouldNight = isNightModeRef.current;
          let targetEV = 0;

          if (!isNightModeRef.current && avg < 38) {
            shouldNight = true;
            targetEV = Math.min(evMax, 2);
          } else if (isNightModeRef.current && avg > 55) {
            shouldNight = false;
            targetEV = 0;
          } else {
            targetEV = isNightModeRef.current ? Math.min(evMax, 2) : 0;
          }

          if (shouldNight !== isNightModeRef.current) {
            track.applyConstraints({ advanced: [{ exposureCompensation: targetEV }] }).catch(() => {});
            isNightModeRef.current = shouldNight;
            setIsNightMode(shouldNight);
          }
        }
      } catch (_) {}
    }, 520);
  };

  // compass
  useEffect(() => {
    const handleOrientation = (event) => {
      if (event.alpha !== null) setCurrentHeading(Math.round(event.alpha));
    };
    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => window.removeEventListener('deviceorientation', handleOrientation, true);
  }, []);

  // app lifecycle
  useEffect(() => {
    let appListener;

    const setupListener = async () => {
      appListener = await CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
        if (isActive) {
          setStatus('喚醒中…');
          setTimeout(() => startCamera(), 500);
        } else {
          if (recording) stopRecording();
          stopCamera();
        }
      });
    };

    setupListener();
    startCamera();

    return () => {
      if (appListener) appListener.remove();
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // metadata I/O
  const readMetadata = async () => {
    try {
      const contents = await Filesystem.readFile({
        path: METADATA_FILE,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      const arr = JSON.parse(contents.data || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  };

  const writeMetadata = async (items) => {
    await ensureDir();
    await Filesystem.writeFile({
      path: METADATA_FILE,
      directory: Directory.Data,
      data: JSON.stringify(items, null, 2),
      encoding: Encoding.UTF8,
    });
  };

  const arrayBufferToBase64 = (buffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  // ====== 拍照（存 PNG + 寫入資料庫）======
  const capturePhotoToBase64Png = async () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) throw new Error('video not ready');

    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(v, 0, 0, w, h);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    return { base64, w, h };
  };

  const savePhoto = async () => {
    try {
      await ensureDir();

      // 拍照存檔
      const ts = safeNowId();
      const sessionId = recordSessionIdRef.current; // 可能是 null
      const fname = sessionId ? `Photo_${sessionId}_${ts}.png` : `Photo_${ts}.png`;
      const fullPath = `${FOLDER_NAME}/${fname}`;

      const { base64 } = await capturePhotoToBase64Png();

      await Filesystem.writeFile({
        directory: Directory.Data,
        path: fullPath,
        data: base64,
      });

      // 取得定位（可容錯）
      let geoInfo = null;
      try {
        await Geolocation.requestPermissions();
        const position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 6000,
        });
        geoInfo = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          heading: currentHeading,
          accuracy: position.coords.accuracy,
        };
      } catch (e) {
        geoInfo = { error: String(e?.message || e), heading: currentHeading };
      }

      // 若錄影中：先暫存，待 saveVideo 綁到影片項目
      if (recording && sessionId) {
        pendingPhotosRef.current = [
          { path: fullPath, filename: fname, createdAt: new Date().toLocaleString() },
          ...pendingPhotosRef.current,
        ];
        setStatus('已拍照（已綁定本次錄影）');
        speak('已拍照');
        return;
      }

      // 未錄影：直接新增一筆 photo item 到 metadata（Gallery 會顯示）
      const data = await readMetadata();
      const newItem = {
        id: ts,
        kind: 'photo',
        filename: fname,
        path: fullPath,
        createdAt: new Date().toLocaleString(),
        location: geoInfo || { error: 'No Data' },
        distance: distanceText || 'N/A',
        timeOfDay: isNightModeRef.current ? 'night' : 'day',
        mimeType: 'image/png',
        hasSnapshot: true,
        snapshotPath: fullPath, // 照片本身就是 snapshot
        annotations: [],
      };

      data.unshift(newItem);
      await writeMetadata(data);

      setStatus('已拍照並存入資料庫');
      speak('已拍照並儲存');
    } catch (e) {
      console.warn('savePhoto failed:', e);
      setStatus('拍照失敗');
      speak('拍照失敗');
    }
  };

  // ===== Recording =====
  const startRecording = async () => {
    await speak('開始錄影');

    const s = streamRef.current || stream;
    if (!s) {
      setStatus('尚未取得相機串流');
      speak('尚未取得相機串流');
      return;
    }

    await ensureDir();

    // 開新 session
    const sessionId = safeNowId();
    recordSessionIdRef.current = sessionId;
    pendingPhotosRef.current = [];

    setStatus('定位中...');
    let geoInfo = null;
    try {
      await Geolocation.requestPermissions();
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 8000,
      });
      geoInfo = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        heading: currentHeading,
        accuracy: position.coords.accuracy,
      };
    } catch (e) {
      console.warn('Geolocation failed:', e);
      geoInfo = { error: String(e?.message || e), heading: currentHeading };
    }
    setRecordedGeoData(geoInfo);

    const mimeType = pickBestMimeType();
    const options = {};
    if (mimeType) options.mimeType = mimeType;
    options.videoBitsPerSecond = 1_500_000;

    try {
      let recorder;
      try {
        recorder = new MediaRecorder(s, options);
      } catch (e) {
        console.warn('[REC] init with options failed, retry without options:', e);
        recorder = new MediaRecorder(s);
      }

      mediaRecorderRef.current = recorder;
      videoChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) videoChunksRef.current.push(e.data);
      };

      recorder.onstop = saveVideo;

      recorder.start(200);

      setRecording(true);
      setStatus(isNightModeRef.current ? '錄影中（夜間）' : '錄影中（日間）');
    } catch (e) {
      console.error('MediaRecorder init failed:', e);
      setStatus('錄影失敗');
      speak('錄影失敗');
      recordSessionIdRef.current = null;
      pendingPhotosRef.current = [];
    }
  };

  const stopRecording = async () => {
    await speak('停止錄影，正在儲存');

    const r = mediaRecorderRef.current;
    if (r && r.state !== 'inactive') {
      try {
        if (typeof r.requestData === 'function') r.requestData();
      } catch (_) {}

      r.stop();

      setTimeout(() => {
        setRecording(false);
        setProgress(0);
        setStatus('儲存中…');
      }, 100);
    }
  };

  const saveVideo = async () => {
    const chunks = videoChunksRef.current;
    const totalBytes = chunks.reduce((sum, b) => sum + (b?.size || 0), 0);

    if (!chunks || chunks.length === 0 || totalBytes < 1000) {
      setStatus('錄影資料過小（codec 可能不支援）');
      setProgress(null);
      recordSessionIdRef.current = null;
      pendingPhotosRef.current = [];
      return;
    }

    try {
      const recorderMime = mediaRecorderRef.current?.mimeType || '';
      const finalMime = recorderMime || pickBestMimeType() || 'video/webm';
      const blob = new Blob(chunks, { type: finalMime });

      const timestamp = recordSessionIdRef.current || safeNowId();
      const fileName = `Bus_${timestamp}.${mimeToExt(finalMime)}`;
      const fullPath = `${FOLDER_NAME}/${fileName}`;

      setStatus('處理中...');
      setProgress(10);

      const ab = await blob.arrayBuffer();
      setProgress(35);
      const base64 = arrayBufferToBase64(ab);

      setStatus('寫入中...');
      setProgress(55);

      await Filesystem.writeFile({
        path: fullPath,
        data: base64,
        directory: Directory.Data,
      });

      setProgress(85);

      const currentData = await readMetadata();

      // 把錄影中拍到的照片綁上去（並把第一張設成 snapshotPath）
      const photos = pendingPhotosRef.current || [];
      const firstPhotoPath = photos.length ? photos[0].path : '';

      const newItem = {
        id: timestamp,
        kind: 'video',
        filename: fileName,
        path: fullPath,
        label: '',
        createdAt: new Date().toLocaleString(),
        location: recordedGeoData || { error: 'No Data' },
        distance: distanceText || 'N/A',
        timeOfDay: isNightModeRef.current ? 'night' : 'day',
        mimeType: finalMime,
        hasSnapshot: !!firstPhotoPath,
        snapshotPath: firstPhotoPath || '',
        photos: photos, // 你之後可以在 Gallery/標注頁擴充顯示更多張
        annotations: [],
      };

      currentData.unshift(newItem);
      await writeMetadata(currentData);

      setProgress(100);
      setStatus('儲存成功');
      await speak('影片儲存成功');

      setTimeout(() => {
        setProgress(null);
        setTimer(0);
        setStatus('就緒');
      }, 1200);
    } catch (error) {
      console.error('saveVideo write failed:', error);
      setStatus('儲存失敗');
      setProgress(null);
      speak('儲存失敗');
    } finally {
      recordSessionIdRef.current = null;
      pendingPhotosRef.current = [];
    }
  };

  // timer
  useEffect(() => {
    let interval = null;
    if (recording) interval = setInterval(() => setTimer((s) => s + 1), 1000);
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [recording]);

  const getCompassDirection = (deg) => {
    const directions = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
    return directions[Math.round(deg / 45) % 8];
  };

  // =========================
  // 測距：coco-ssd + bbox 幾何估距
  // =========================
  const cocoModelRef = useRef(null);
  const detectCanvasRef = useRef(null);

  const ensureDetectModel = async () => {
    const tf = await import('@tensorflow/tfjs');
    try {
      await import('@tensorflow/tfjs-backend-webgl');
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (_) {
      await tf.ready();
    }
    const cocoSsd = await import('@tensorflow-models/coco-ssd');
    if (!cocoModelRef.current) cocoModelRef.current = await cocoSsd.load();
    return cocoModelRef.current;
  };

  const grabFrameCanvas = () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) return null;

    const srcW = v.videoWidth || 1280;
    const srcH = v.videoHeight || 720;

    const targetW = 360;
    const scale = targetW / srcW;
    const targetH = Math.round(srcH * scale);

    let c = detectCanvasRef.current;
    if (!c) {
      c = document.createElement('canvas');
      detectCanvasRef.current = c;
    }
    c.width = targetW;
    c.height = targetH;

    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, targetW, targetH);
    return c;
  };

  const estimateDistanceFromBbox = ({ label, bbox }, zoomForCalc) => {
    const [, , w] = bbox;
    if (!w || w <= 1) return null;

    const realW = OBJ_WIDTH_M[label] ?? 2.0;
    const canvas = detectCanvasRef.current;
    const imgW = canvas?.width || 360;

    const hfov = (DEFAULT_HFOV_DEG * Math.PI) / 180;
    const focalPx = imgW / (2 * Math.tan(hfov / 2));

    const z = zoomForCalc || 1;
    const effFocal = focalPx * z;

    const distM = (realW * effFocal) / w;
    if (!isFinite(distM) || distM <= 0) return null;
    return distM;
  };

  const runDetectOnce = async () => {
    setDetectBusy(true);
    try {
      const canvas = grabFrameCanvas();
      if (!canvas) return;

      const model = await ensureDetectModel();
      const preds = await model.detect(canvas);

      const allowed = new Set(['bus', 'car', 'truck', 'person', 'motorcycle', 'bicycle']);
      const filtered = (preds || [])
        .filter((p) => allowed.has(p.class))
        .filter((p) => (p.score ?? 0) >= 0.45)
        .map((p) => ({ label: p.class, score: p.score, bbox: p.bbox }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));

      lastDetectionsRef.current = filtered;

      if (!filtered.length) {
        setDistanceText('畫面乾淨');
        selectedDetRef.current = null;
        return;
      }

      selectedDetRef.current = filtered[0];
      const zForCalc = zoomSupported ? zoomAppliedRef.current : zoomTarget;
      const dist = estimateDistanceFromBbox(filtered[0], zForCalc);
      setDistanceText(dist ? `${dist.toFixed(1)} m（估算）` : 'N/A');
    } catch (e) {
      console.warn('detect failed:', e);
      setDistanceText('N/A');
    } finally {
      setDetectBusy(false);
    }
  };

  const onVideoTapForDistance = async (e) => {
    if (!measureEnabled) return;

    if (!lastDetectionsRef.current?.length) {
      await runDetectOnce();
    }

    const v = videoRef.current;
    const canvas = detectCanvasRef.current;
    if (!v || !canvas) return;

    const rect = v.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const vw = rect.width;
    const vh = rect.height;
    const srcW = v.videoWidth || 1280;
    const srcH = v.videoHeight || 720;

    const scale = Math.max(vw / srcW, vh / srcH);
    const dispW = srcW * scale;
    const dispH = srcH * scale;
    const offsetX = (vw - dispW) / 2;
    const offsetY = (vh - dispH) / 2;

    const ix = (px - offsetX) / scale;
    const iy = (py - offsetY) / scale;

    const dsX = (ix / srcW) * canvas.width;
    const dsY = (iy / srcH) * canvas.height;

    const dets = lastDetectionsRef.current || [];
    let pick = null;

    for (const d of dets) {
      const [x, y, w, h] = d.bbox;
      if (dsX >= x && dsX <= x + w && dsY >= y && dsY <= y + h) {
        pick = d;
        break;
      }
    }

    if (!pick) {
      let best = null;
      let bestDist = Infinity;
      for (const d of dets) {
        const [x, y, w, h] = d.bbox;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const dd = (cx - dsX) ** 2 + (cy - dsY) ** 2;
        if (dd < bestDist) {
          bestDist = dd;
          best = d;
        }
      }
      pick = best;
    }

    if (!pick) {
      setDistanceText('畫面乾淨');
      return;
    }

    selectedDetRef.current = pick;
    const zForCalc = zoomSupported ? zoomAppliedRef.current : zoomTarget;
    const dist = estimateDistanceFromBbox(pick, zForCalc);
    if (dist) {
      setDistanceText(`${dist.toFixed(1)} m（估算）`);
      speak(`距離約 ${dist.toFixed(0)} 公尺`);
    } else {
      setDistanceText('N/A');
    }
  };

  useEffect(() => {
    if (!measureEnabled) return;
    let alive = true;

    const loop = async () => {
      while (alive) {
        // eslint-disable-next-line no-await-in-loop
        await runDetectOnce();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1200));
      }
    };

    loop();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureEnabled]);

  // UI styles
  const videoStyle = useMemo(() => {
    const needCssZoom = !zoomSupported;
    const z = Math.max(1, Number(zoomTarget || 1));
    return {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      transform: needCssZoom ? `scale(${z})` : 'none',
      transformOrigin: 'center center',
      transition: 'transform 0.18s ease-out',
      filter: 'contrast(1.08)',
    };
  }, [zoomSupported, zoomTarget]);

  const overlayPill = (bg) => ({
    background: bg,
    padding: '4px 8px',
    borderRadius: '10px',
    color: 'white',
    fontSize: '12px',
    whiteSpace: 'nowrap',
    fontWeight: 900,
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#000' }}>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} autoPlay playsInline muted style={videoStyle} onClick={onVideoTapForDistance} />

        {/* 觀景窗 */}
        {showOverview && (
          <div
            style={{
              position: 'absolute',
              right: 12,
              bottom: 170,
              width: 120,
              height: 160,
              borderRadius: 12,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.22)',
              background: '#000',
              zIndex: 25,
              boxShadow: '0 10px 24px rgba(0,0,0,0.55)',
            }}
          >
            <video
              autoPlay
              playsInline
              muted
              ref={(el) => {
                if (el && streamRef.current && el.srcObject !== streamRef.current) {
                  el.srcObject = streamRef.current;
                  el.play().catch(() => {});
                }
              }}
              style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'none', filter: 'contrast(1.02)' }}
            />
          </div>
        )}

        {/* 左上資訊（移除大字，改燈號） */}
        <div
          style={{
            position: 'absolute',
            top: 34,
            left: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            zIndex: 30,
            maxWidth: '86vw',
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <div style={overlayPill('rgba(0,0,0,0.60)')}>
              {recLamp} {recording ? '錄影中' : progress !== null ? '儲存中' : '就緒'}
            </div>

            <div style={overlayPill(isNightMode ? 'rgba(50, 50, 255, 0.6)' : 'rgba(255, 165, 0, 0.6)')}>
              {isNightMode ? '🌙 夜間' : '☀️ 日間'}
            </div>

            <div style={overlayPill('rgba(0, 128, 0, 0.6)')}>
              🧭 {currentHeading}° {getCompassDirection(currentHeading)}
            </div>

            <div style={overlayPill('rgba(128, 0, 128, 0.6)')}>📷 對焦 {focusDist}</div>

            <div style={overlayPill('rgba(0, 120, 255, 0.55)')}>📏 {distanceText}</div>

            {measureEnabled && <div style={overlayPill('rgba(0,0,0,0.45)')}>測距中：{measureLamp}</div>}
          </div>

          {recording && (
            <div style={{ color: '#ff4444', fontWeight: 900, fontSize: 20, textShadow: '0 2px 4px rgba(0,0,0,0.85)' }}>
              REC {new Date(timer * 1000).toISOString().substr(14, 5)}
            </div>
          )}
        </div>

        {/* 右側：變焦滑桿 + 快捷 */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            right: 12,
            transform: 'translateY(-50%)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            zIndex: 40,
            alignItems: 'center',
            width: 58,
          }}
        >
          <div
            style={{
              background: 'rgba(0,0,0,0.45)',
              border: '1px solid rgba(255,255,255,0.22)',
              borderRadius: 14,
              padding: '10px 8px',
              width: 58,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              backdropFilter: 'blur(6px)',
            }}
          >
            <div style={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>{zoomTarget.toFixed(1)}x</div>

            <input
              type="range"
              min={zoomMin}
              max={zoomMax}
              step={0.1}
              value={zoomTarget}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ width: 140, transform: 'rotate(-90deg)', accentColor: '#ffcc00' }}
            />

            <button
              onClick={() => setZoom(1)}
              style={{
                width: 44,
                height: 34,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.24)',
                background: 'rgba(0,0,0,0.35)',
                color: '#fff',
                fontWeight: 900,
              }}
            >
              1x
            </button>
          </div>

          <button
            onClick={() => setShowOverview((v) => !v)}
            style={{
              width: 58,
              height: 44,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              fontWeight: 900,
              backdropFilter: 'blur(6px)',
            }}
          >
            小窗
          </button>

          <button
            onClick={() => {
              setMeasureEnabled((v) => !v);
              if (!measureEnabled) speak('啟動測距');
              else speak('關閉測距');
            }}
            style={{
              width: 58,
              height: 44,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.22)',
              background: measureEnabled ? 'rgba(0,160,90,0.55)' : 'rgba(0,0,0,0.35)',
              color: '#fff',
              fontWeight: 900,
              backdropFilter: 'blur(6px)',
            }}
          >
            {detectBusy ? '…' : '測距'}
          </button>

          <button
            onClick={runDetectOnce}
            style={{
              width: 58,
              height: 44,
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              fontWeight: 900,
              backdropFilter: 'blur(6px)',
            }}
          >
            取框
          </button>
        </div>

        {/* needsUserGesture */}
        {needsUserGesture && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.78)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 60,
              padding: '0 24px',
              textAlign: 'center',
              gap: 12,
            }}
          >
            <div style={{ color: '#fff', fontSize: 18, fontWeight: 900 }}>需要允許相機/麥克風權限或點擊啟用</div>
            <div style={{ color: '#ccc', fontSize: 14, lineHeight: 1.4 }}>
              若你已按允許但仍無畫面，請點下面按鈕再試一次（Android WebView 常需要使用者手勢觸發）。
            </div>
            <button
              onClick={startCamera}
              style={{
                width: 220,
                height: 48,
                borderRadius: 12,
                border: '2px solid #fff',
                background: 'rgba(255,204,0,0.95)',
                color: '#000',
                fontWeight: 900,
                fontSize: 16,
              }}
            >
              點我啟用相機
            </button>
          </div>
        )}

        {/* progress overlay */}
        {progress !== null && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,0.85)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
              padding: '0 40px',
            }}
          >
            <div
              style={{
                width: '100%',
                color: '#4da3ff',
                marginBottom: 10,
                display: 'flex',
                justifyContent: 'space-between',
                fontWeight: 900,
              }}
            >
              <span>儲存中...</span>
              <span>{progress}%</span>
            </div>
            <div style={{ width: '100%', height: 12, background: '#333', borderRadius: 6, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #4da3ff, #00d2ff)',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* bottom bar：錄影鍵 +（錄影中）白色拍照鍵 */}
      <div
        style={{
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          background: '#111',
        }}
      >
        {!recording ? (
          <button
            onClick={startRecording}
            disabled={progress !== null}
            style={{
              width: 70,
              height: 70,
              borderRadius: '50%',
              border: '4px solid white',
              background: progress !== null ? '#555' : '#ff4444',
              opacity: progress !== null ? 0.5 : 1,
            }}
          />
        ) : (
          <>
            {/* 白色拍照鍵（錄影中顯示） */}
            <button
              onClick={savePhoto}
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                border: '3px solid rgba(255,255,255,0.95)',
                background: 'rgba(255,255,255,0.95)',
              }}
            />
            {/* 停止錄影鍵 */}
            <button
              onClick={stopRecording}
              style={{
                width: 70,
                height: 70,
                borderRadius: 10,
                border: 'none',
                background: 'white',
              }}
            />
          </>
        )}

        {/* 未錄影也能拍照（可選）：你若不想要就把這顆刪掉 */}
        {!recording && (
          <button
            onClick={savePhoto}
            disabled={progress !== null}
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              border: '3px solid rgba(255,255,255,0.75)',
              background: 'rgba(255,255,255,0.20)',
            }}
            title="拍照存入資料庫"
          />
        )}
      </div>
    </div>
  );
}