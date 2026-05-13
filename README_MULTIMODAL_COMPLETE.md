# Bus Vision 2.0.0.2 Multimodal Collector

這一版把原生 CameraX 採集鏈路修成可維護的完整資料採集器雛形：

- 修正 BusVisionNativePlugin 過早建立 NativeCameraHost，導致 `view_not_ready` / 原生相機黑畫面的問題。
- MainActivity 改為底層 CameraX PreviewView + 上層透明 Capacitor WebView。
- 移除 Activity onResume 自動開相機，改由 Recorder 在權限確認後顯式啟動。
- Recorder UI 直接呼叫原生 `startRecording / stopRecording / takePhoto`。
- 每筆影片會保存 MP4 + WAV + metadata.json。
- 每張照片會保存 JPG + metadata.json。
- metadata 內含 device、location、scene/distance/lighting/quality tags、annotation 預留欄位、trainingTargets。
- 新增 torch、zoom、night tag、distance tag、scene tag、quality tag、note。

## Mac 上重新安裝與同步

```bash
cd bus-vision2.0.0.1.2
rm -rf node_modules package-lock.json
npm install
npm run build
npx cap sync android
cd android
chmod +x gradlew
./gradlew clean
./gradlew :app:assembleDebug
```

APK 位置：

```bash
android/app/build/outputs/apk/debug/app-debug.apk
```

## 重要測試 Log

```bash
adb logcat | grep -E "BusVisionCam|BusVisionNative|BVAUD|CameraX"
```

如果看到 `Camera bound with preview + photo + video`，代表原生相機已經綁定成功。

## metadata 範例

```json
{
  "id": 1710000000000,
  "type": "video",
  "path": "BusData/VID_1710000000000.mp4",
  "audioPath": "BusData/AUD_1710000000000.wav",
  "createdAt": "2026-05-10T04:00:00.000Z",
  "collectorVersion": "bus-vision2.0.0.2-multimodal",
  "source": "android-native-camerax",
  "device": {},
  "location": {},
  "tags": {
    "scene": "roadside",
    "distance": "middle",
    "lighting": "day",
    "quality": "normal"
  },
  "annotation": {
    "boxes": [],
    "ocr": null,
    "busNumber": "",
    "vehicleMake": "",
    "vehicleModel": "",
    "vehicleYearRange": "",
    "yoloClass": ""
  },
  "trainingTargets": {
    "image": true,
    "audio": true,
    "vmmr": true,
    "busRouteOcr": true
  }
}
```

## 2026-05 UI refinement: camera-style collector screen

This build refines the recorder screen into a cleaner phone-camera style UI:

- Top status bar: READY/REC state, current status text, day/night toggle, flash mode, ranging toggle, and settings drawer.
- Day/night mode cycles through Auto / Day / Night using sun/moon style icons.
- Flash cycles through Auto / On / Off using camera-like flash icons. Current native support maps On to torch enabled and Auto/Off to torch disabled; the selected mode is still recorded in metadata.
- Main screen keeps only high-frequency actions: restart camera, record, photo, zoom shortcut, focus/ranging reticle.
- Advanced options are moved into a bottom pull-up drawer:
  - scene tag
  - distance tag
  - zoom
  - lens tag
  - quality tag
  - capture profile
  - device/lens/GPS/compass/focus-distance/object-distance telemetry toggles
  - note field
- Default telemetry is ON for device, lens, GPS, compass, focus distance, and object ranging so every sample is useful for later image, VMMR, OCR, sound, and distance-related training.

After extracting this zip on macOS, rebuild the web assets before syncing Android:

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
npx cap sync android
cd android
chmod +x gradlew
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
