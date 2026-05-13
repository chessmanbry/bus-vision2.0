import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import Recorder from './components/Recorder';
import Gallery from './components/Gallery';
import './index.css';

function App() {
  const [mode, setMode] = useState('recorder');
  const isAndroidNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const isiOSNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

  useEffect(() => {
    let sub;
    CapacitorApp.addListener('backButton', () => {
      if (window.__busVisionOverlayOpen) return;
      if (mode === 'gallery') {
        setMode('recorder');
        return;
      }
      CapacitorApp.exitApp();
    }).then((listener) => { sub = listener; });
    return () => { if (sub) sub.remove(); };
  }, [mode]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100dvh',
      overflow: 'hidden',
      backgroundColor: isAndroidNative && mode === 'recorder' ? 'transparent' : '#000'
    }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: isAndroidNative && mode === 'recorder' ? 'transparent' : '#000' }}>
        {mode === 'recorder' ? <Recorder /> : <Gallery />}
      </div>

      <nav style={{
        minHeight: isAndroidNative ? 118 : 68,
        // Android 三鍵導覽列有些機型不會正確回報 safe-area-inset-bottom，
        // 所以原生 Android 額外保留 34px，避免「採集 / 資料庫」被大三鍵蓋住。
        paddingBottom: isAndroidNative ? 'calc(max(env(safe-area-inset-bottom), 0px) + 46px)' : 'max(env(safe-area-inset-bottom), 10px)',
        paddingTop: 10,
        paddingLeft: 14,
        paddingRight: 14,
        background: 'linear-gradient(180deg, rgba(5,5,5,0.94), #050505)',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'flex-start',
        gap: 12,
        zIndex: 100,
        boxSizing: 'border-box'
      }}>
        <button onClick={() => setMode('recorder')} style={navBtn(mode === 'recorder')} aria-label="採集">
          <span style={{ fontSize: '1.55rem', lineHeight: 1 }}>📹</span>
        </button>
        <button onClick={() => setMode('gallery')} style={navBtn(mode === 'gallery')} aria-label="資料庫">
          <span style={{ fontSize: '1.55rem', lineHeight: 1 }}>📂</span>
        </button>
      </nav>
    </div>
  );
}

function navBtn(active) {
  return {
    flex: 1,
    maxWidth: 190,
    minWidth: 120,
    height: 52,
    borderRadius: 18,
    border: active ? '1px solid rgba(255,245,100,0.78)' : '1px solid rgba(255,255,255,0.14)',
    background: active ? 'rgba(255,255,90,0.16)' : 'rgba(255,255,255,0.055)',
    color: active ? '#FFFF88' : '#ddd',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 0,
    fontSize: '0.92rem',
    lineHeight: 1.05,
    fontWeight: 900,
    padding: '6px 10px',
    boxSizing: 'border-box'
  };
}

export default App;
