import { WebPlugin } from '@capacitor/core';
import type { BusVisionNativePlugin } from './definitions';

export class BusVisionNativeWeb extends WebPlugin implements BusVisionNativePlugin {
  async isNativeAvailable() { return { available: false }; }
  async ensurePermissions() { return { ok: true, camera: 'granted', microphone: 'granted', mic: 'granted' }; }
  async startCamera() { return { ok: true }; }
  async stopCamera() { return { ok: true }; }
  async startRecording() { return { ok: true }; }
  async stopRecording(): Promise<any> { throw new Error('Native recording is only available on Android.'); }
  async takePhoto(): Promise<any> { throw new Error('Native photo capture is only available on Android.'); }
  async setTorch() { return { ok: false }; }
  async setZoom() { return { ok: false }; }
}
