# BusVision 0.8.5 UI / Annotation Interaction Fix

## 修正內容

- 移除採集畫面底部「更多採集設定」上拉列，改由右上角設定按鈕開啟。
- 移除頂部 READY / 原生相機已就緒狀態列，降低畫面雜亂與遮擋。
- 底部「採集 / 資料庫」改成純圖示分頁，避免被 Android 三鍵導航遮住。
- 採集畫面比例重新調整，讓錄影、拍照、變焦、測距區域更乾淨。
- Android 鎖定直向顯示，避免橫向採集跑版。
- 標注頁加入「框選模式」開關：關閉時可順暢滑動頁面；開啟時才可拉框/拖曳框，降低誤標註。
- 「已標注資料」改成以已標注圖片/截圖為中心顯示；點開可看到既有標注框並修改後更新。
- 支援大螢幕/滑鼠操作：標注框選與按鈕仍使用 pointer 事件，手機外接螢幕或滑鼠可操作。

## 安裝

解壓後用 VS Code 打開有 package.json 的專案根目錄，執行：

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
