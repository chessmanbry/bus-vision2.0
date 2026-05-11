# Bus Vision 2.0.0.6 — Annotation & Audio Timeline

本版重點：

1. 資料庫新增分頁：全部資料、已標注資料、待補標資料、聲音資料、可訓練。
2. 單筆資料預覽新增標注歷史，可看到影像標注與聲音區段標注。
3. 聲音標注改成 timeline/segment 工作流：播放錄音、拖曳時間軸、設定起點/終點、選擇距離階段、儲存多個區段。
4. 音訊匯出新增 audio_segments.csv 與 audio_segments.json，支援後續切 WAV 小段進行聲音距離模型訓練。
5. Android/package 版本更新為 2.0.0.6。

建議乾淨安裝：

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
npx cap sync android
cd android
chmod +x gradlew
./gradlew clean
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.chessman.busvision2 -c android.intent.category.LAUNCHER 1
```
