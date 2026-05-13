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
  async tapToFocus(): Promise<any> { return { ok: false, tapX: 0.5, tapY: 0.5, afState: 'UNKNOWN', distanceConfidence: 'unavailable' }; }
  async getDistanceEstimate(): Promise<any> { return { ok: false, afState: 'UNKNOWN', distanceConfidence: 'unavailable', distanceSource: 'unavailable' }; }
  async getFocusInfo(): Promise<any> { return { ok: false, afState: 'UNKNOWN', distanceConfidence: 'unavailable' }; }
  async setTorch() { return { ok: false }; }
  async setPhotoFlashMode(options: { mode: string }) { return { ok: false, mode: options?.mode || 'off' }; }
  async setExposureCompensation(options: { index: number }) { return { ok: false, index: options?.index || 0 }; }
  async setZoom() { return { ok: false }; }
  async exportZip(): Promise<any> { throw new Error('Native ZIP export is only available on Android.'); }
}

