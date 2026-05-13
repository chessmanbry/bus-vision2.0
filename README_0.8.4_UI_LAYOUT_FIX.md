# Bus Vision 2.0.0.8.4 UI Layout Fix

本版針對實機回報修正：

- 資料庫頁改成可垂直滑動，避免資料卡片被底部導航列截斷。
- 資料庫文字尺寸、標籤 pill 與卡片排版調整，避免文字重疊。
- 採集畫面移除右側重複的拍照/更多快捷按鈕，只保留上方狀態列與底部主控制。
- 變焦欄位改成可收合/展開，預設收合，只顯示目前倍率。
- 測距欄位改成可收合/展開，預設收合，只顯示目前距離。
- 「更多採集設定」抽屜縮小收合高度，降低遮擋主畫面。
- App 底部導航與資料庫內容加強 safe-area / bottom padding。

安裝流程：

```bash
pwd
ls package.json

rm -rf node_modules package-lock.json dist

npm install

npm run build

npx cap sync android

cd android

chmod +x gradlew

./gradlew clean

./gradlew :app:assembleDebug

adb devices

adb install -r app/build/outputs/apk/debug/app-debug.apk

adb shell monkey -p com.chessman.busvision2 -c android.intent.category.LAUNCHER 1
```

注意：`npm run build` 必須成功看到 `✓ built`，再繼續執行 `npx cap sync android`。
