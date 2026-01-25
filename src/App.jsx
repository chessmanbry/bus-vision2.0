import React, { useState } from 'react';
import Recorder from './components/Recorder';
import Gallery from './components/Gallery';
import './index.css';

function App() {
  // 預設進入錄影模式
  const [mode, setMode] = useState('recorder'); // 'recorder' | 'gallery'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', backgroundColor: '#000' }}>
      
      {/* 上半部：主要功能區 */}
      <div style={{ flex: 1, position: 'relative' }}>
        {mode === 'recorder' ? <Recorder /> : <Gallery />}
      </div>

      {/* 底部導覽列 */}
      <nav style={{ 
          height: '80px', 
          background: '#000', 
          borderTop: '2px solid #333', 
          display: 'flex', 
          justifyContent: 'space-around', 
          alignItems: 'center',
          zIndex: 100
      }}>
        <button 
          onClick={() => setMode('recorder')}
          style={{ 
            background: 'none', 
            border: 'none', 
            color: mode === 'recorder' ? '#FFFF00' : '#666', // 啟動時變黃色
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            fontSize: '1.2rem', 
            fontWeight: 'bold'
          }}
        >
          <span style={{ fontSize: '1.5rem', marginBottom: '4px' }}>📹</span>
          <span>錄影辨識</span>
        </button>

        <button 
          onClick={() => setMode('gallery')}
          style={{ 
            background: 'none', 
            border: 'none', 
            color: mode === 'gallery' ? '#FFFF00' : '#666',
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            fontSize: '1.2rem', 
            fontWeight: 'bold'
          }}
        >
          <span style={{ fontSize: '1.5rem', marginBottom: '4px' }}>📂</span>
          <span>資料庫</span>
        </button>
      </nav>
    </div>
  );
}

export default App;