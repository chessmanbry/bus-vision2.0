import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import Recorder from './components/Recorder';
import Gallery from './components/Gallery';
import './index.css';

function App() {
  const [mode, setMode] = useState('recorder');
  const isAndroidNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

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
        minHeight: 72,
        paddingBottom: 'max(env(safe-area-inset-bottom), 18px)',
        paddingTop: 6,
        background: 'linear-gradient(180deg, rgba(5,5,5,0.94), #050505)',
        borderTop: '1px solid rgba(255,255,255,0.12)',
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        zIndex: 100,
        boxSizing: 'border-box'
      }}>
        <button onClick={() => setMode('recorder')} style={navBtn(mode === 'recorder')}>
          <span style={{ fontSize: '1.45rem', marginBottom: 4 }}>📹</span>
          <span>採集</span>
        </button>
        <button onClick={() => setMode('gallery')} style={navBtn(mode === 'gallery')}>
          <span style={{ fontSize: '1.45rem', marginBottom: 4 }}>📂</span>
          <span>資料庫</span>
        </button>
      </nav>
    </div>
  );
}

function navBtn(active) {
  return {
    minWidth: 118,
    height: 46,
    borderRadius: 18,
    border: active ? '1px solid rgba(255,245,100,0.70)' : '1px solid rgba(255,255,255,0.10)',
    background: active ? 'rgba(255,255,90,0.14)' : 'rgba(255,255,255,0.04)',
    color: active ? '#FFFF88' : '#aaa',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    fontSize: '0.82rem',
    fontWeight: 900,
    padding: 0
  };
}

export default App;
