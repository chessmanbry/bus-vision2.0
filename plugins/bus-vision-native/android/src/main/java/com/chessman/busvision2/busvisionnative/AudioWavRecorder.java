package com.chessman.busvision2.busvisionnative;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Records mono PCM16 and writes a WAV container.
 * This is intentionally simple for data collection.
 */
public class AudioWavRecorder {
  public static class Config {
    public int sampleRate = 48000;
    public int channels = 1;
    public int channelConfig = AudioFormat.CHANNEL_IN_MONO;
    public int audioFormat = AudioFormat.ENCODING_PCM_16BIT;
  }

  private final Config cfg;
  private AudioRecord recorder;
  private Thread thread;
  private volatile boolean running = false;
  private File outFile;
  private long totalPcmBytes = 0;
  private long startMs = 0;

  public AudioWavRecorder(Config cfg) {
    this.cfg = cfg;
  }

  public synchronized void start(File wavFile) throws IOException {
    if (running) return;
    outFile = wavFile;
    totalPcmBytes = 0;

    int minBuf = AudioRecord.getMinBufferSize(cfg.sampleRate, cfg.channelConfig, cfg.audioFormat);
    int bufferSize = Math.max(minBuf, cfg.sampleRate * 2); // ~1s buffer minimum

    recorder = new AudioRecord(
        MediaRecorder.AudioSource.MIC,
        cfg.sampleRate,
        cfg.channelConfig,
        cfg.audioFormat,
        bufferSize
    );

    if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
      throw new IOException("AudioRecord init failed");
    }

    // Ensure parent exists
    File parent = outFile.getParentFile();
    if (parent != null && !parent.exists()) parent.mkdirs();

    final FileOutputStream fos = new FileOutputStream(outFile);
    // Placeholder header (44 bytes)
    fos.write(makeWavHeader(0, cfg.sampleRate, cfg.channels, 16));

    running = true;
    recorder.startRecording();
  startMs = System.currentTimeMillis();
    Log.i("BVAUD", "audio start: sampleRate=" + cfg.sampleRate + " channels=" + cfg.channels + " path=" + outFile.getAbsolutePath());

    thread = new Thread(() -> {
      byte[] buf = new byte[bufferSize];
      try {
        while (running) {
          int read = recorder.read(buf, 0, buf.length);
          if (read > 0) {
            fos.write(buf, 0, read);
            totalPcmBytes += read;
          }
        }
      } catch (Throwable ignored) {
      } finally {
        try { fos.flush(); } catch (Throwable ignored) {}
        try { fos.close(); } catch (Throwable ignored) {}
        // Patch header sizes
        try {
          RandomAccessFileCompat.patchWavHeader(outFile, totalPcmBytes, cfg.sampleRate, cfg.channels, 16);
          long riff = 36 + totalPcmBytes;
          Log.i("BVAUD", "wav header patched: dataSize=" + totalPcmBytes + " riffSize=" + riff);
        } catch (Throwable t) {
          Log.w("BVAUD", "wav header patch failed", t);
        }
      }
    }, "AudioWavRecorder");
    thread.start();
  }

  public synchronized void stop() {
    running = false;
    try {
      if (recorder != null) {
        try { recorder.stop(); } catch (Throwable ignored) {}
        try { recorder.release(); } catch (Throwable ignored) {}
      }
    } finally {
      recorder = null;
    }
    if (thread != null) {
      try { thread.join(600); } catch (Throwable ignored) {}
      thread = null;
    }
  }

  public synchronized long getStartMs() {
    return startMs;
  }

  public synchronized boolean isRunning() {
    return running;
  }

  public synchronized File getOutFile() {
    return outFile;
  }

  private static byte[] makeWavHeader(long pcmBytes, int sampleRate, int channels, int bitsPerSample) {
    long byteRate = (long) sampleRate * channels * bitsPerSample / 8;
    long blockAlign = (long) channels * bitsPerSample / 8;
    long chunkSize = 36 + pcmBytes;

    ByteBuffer bb = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
    bb.put(new byte[]{'R','I','F','F'});
    bb.putInt((int) chunkSize);
    bb.put(new byte[]{'W','A','V','E'});
    bb.put(new byte[]{'f','m','t',' '});
    bb.putInt(16); // Subchunk1Size
    bb.putShort((short) 1); // PCM
    bb.putShort((short) channels);
    bb.putInt(sampleRate);
    bb.putInt((int) byteRate);
    bb.putShort((short) blockAlign);
    bb.putShort((short) bitsPerSample);
    bb.put(new byte[]{'d','a','t','a'});
    bb.putInt((int) pcmBytes);
    return bb.array();
  }

  /** Small helper to patch header without java.io.RandomAccessFile (keeps min API happy). */
  static class RandomAccessFileCompat {
    static void patchWavHeader(File wav, long pcmBytes, int sampleRate, int channels, int bitsPerSample) throws IOException {
      // Proper in-place patch using RandomAccessFile
      RandomAccessFile raf = null;
      try {
        raf = new RandomAccessFile(wav, "rw");
        raf.seek(0);
        raf.write(makeWavHeader(pcmBytes, sampleRate, channels, bitsPerSample));
      } finally {
        if (raf != null) {
          try { raf.close(); } catch (Throwable ignored) {}
        }
      }
    }
  }
}
