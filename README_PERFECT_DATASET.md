# Bus Vision 2.0.0.5 Perfect Dataset Build

本版在 2.0.0.4 基礎上補齊四個資料集核心能力：

## 1. 正式資料集標注流程
- 標注框類別：公車本體、路線顯示、車牌、站牌、車頭 LED、側面 LED。
- 標注品質：清晰度、可見性、遮擋程度。
- 儲存 `annotation-v2` schema，並同步寫入 `annotation.boxes`、`annotation.busNumber`、`annotation.yoloClass`。
- YOLO 匯出會依照標注類別產生 class names，不再只用單一 bus 類別。

## 2. 聲音距離階段標籤
採集與標注都支援：
- background：背景/無公車
- far：遠處接近
- middle：接近中
- near：即將抵達
- passing：經過身邊
- leaving：離開

音訊匯出 `audio_manifest.csv/json` 會包含 `sound_stage`，可直接用於聲音事件分類或公車接近預警研究。

## 3. 任務模式
採集頁新增任務模式：
- 公車偵測
- 路線 OCR
- 聲音距離
- 夜間/雨天補強
- 校正測距

每筆 metadata 會保存 `taskMode` 與 `taskHint`，方便後續過濾資料集。

## 4. 資料品質檢查
資料庫頁新增品質檢查：
- 可訓練 / 待補標 / 缺資料
- 每筆資料顯示品質百分比
- 預覽頁顯示缺少欄位
- 完整研究封存新增 `quality_report.json`

## 安裝測試
```bash
cd bus-vision2.0.0.1.2
rm -rf node_modules package-lock.json
npm install
npm run build
npx cap sync android
cd android
chmod +x gradlew
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
