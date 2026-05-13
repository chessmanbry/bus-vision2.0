# Bus Vision 2.0.0.4 - Back Key + Dataset Export

本版新增：

## 1. Android 返回鍵
- 在資料庫頁按返回鍵：回到採集頁。
- 在資料庫彈窗、標注視窗、匯出視窗中按返回鍵：優先關閉目前視窗。
- 在採集頁進階控制抽屜打開時按返回鍵：先收合抽屜。

## 2. 資料庫多格式匯出
資料庫頁新增「匯出訓練檔案」入口，可輸出：

### YOLO 偵測資料
輸出 ZIP 內含：
- `images/train/*.jpg|png`
- `labels/train/*.txt`
- `data.yaml`
- `manifest.json`

若照片/截圖尚未標框，會輸出空 label 檔，方便後續補標。

### OCR 文字資料
輸出 ZIP 內含：
- `images/*`
- `ocr_manifest.csv`
- `ocr_manifest.json`

用於公車路線號碼、車頭文字、車牌或其他文字辨識研究。

### 聲音訓練資料
輸出 ZIP 內含：
- `audio/*.wav`
- `audio_manifest.csv`
- `audio_manifest.json`

manifest 會保留距離標籤、日夜間、場景、設備、備註等資訊，方便研究公車遠近聲音特徵。

### 完整研究封存
輸出 ZIP 內含：
- `metadata.json`
- `raw/*`

用於保留原始多模態資料，以後可重新轉換成不同訓練格式。

## 3. 建議使用方式
1. 採集頁拍照或錄影。
2. 到資料庫預覽。
3. 對照片或影片截圖進行標注與 OCR 修正。
4. 進入「匯出訓練檔案」。
5. 依照模型任務匯出 YOLO / OCR / Audio / Full ZIP。

