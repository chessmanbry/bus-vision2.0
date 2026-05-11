# BusVision2 Backend (Dataset Collector)

用途：接收 App 上傳的 **影片** 與 **截圖/標註**，並按 `label` 依資料夾整理成訓練資料集。

## 啟動

```bash
cd server
npm i
npm run dev
```

預設埠：`8787`（可用 `PORT=xxxx` 覆寫）

## App 端設定

在 **資料庫** 頁面上方輸入後端 URL，例如：

- 同一台電腦測試：`http://localhost:8787`
- 手機連電腦（同 Wi-Fi）：`http://<你的電腦內網IP>:8787`

之後打開某筆影片，按「上傳到後端（訓練資料）」即可。

## 產出

- `server/data/uploads/`：暫存檔（正常流程下標註圖片會搬到 dataset）
- `server/data/dataset/<label>/...`：依 label 分類的截圖資料
- `server/data/index.jsonl`：每次上傳的紀錄（方便後續做資料清洗/統計）

## 轉出 OCR 訓練資料（可選）

若你的標註框是框住「公車號碼/文字區域」，可用工具把截圖依框裁切成 OCR 資料集：

```bash
cd server/tools
pip install pillow
python export_ocr_dataset.py
```

會輸出：

- `server/data/ocr_dataset/images/`：裁切後的圖片
- `server/data/ocr_dataset/labels.csv`：檔名與文字 label

## API

- `GET /api/health`
- `POST /api/upload/video` (form-data: `file`, `meta`)
- `POST /api/upload/annotation` (form-data: `image`, `meta`)

注意：目前設計是「內網蒐集資料」用途，未加驗證；若要對外使用請加上 token 驗證。
