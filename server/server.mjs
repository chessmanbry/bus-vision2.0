import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DATASET_DIR = path.join(DATA_DIR, 'dataset');
const INDEX_FILE = path.join(DATA_DIR, 'index.jsonl');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATASET_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(morgan('dev'));

// 注意：multipart 由 multer 處理；不要在此啟用會吃掉 body 的 json parser。

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const ts = Date.now();
    cb(null, `${ts}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: {
    // 視情況調整。若你錄 1080p/長時間，可再放大。
    fileSize: 1024 * 1024 * 500 // 500MB
  }
});

const appendIndex = (obj) => {
  fs.appendFileSync(INDEX_FILE, JSON.stringify({
    ...obj,
    receivedAt: new Date().toISOString()
  }) + '\n');
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, port: PORT });
});

// 1) 上傳影片
// form-data: file=<video>, meta=<json string>
app.post('/api/upload/video', upload.single('file'), (req, res) => {
  try {
    const meta = req.body?.meta ? JSON.parse(req.body.meta) : null;
    appendIndex({ type: 'video', file: req.file?.filename, meta });
    res.json({ ok: true, storedAs: req.file?.filename });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'bad request' });
  }
});

// 2) 上傳截圖/標註
// form-data: image=<jpg/png>, meta=<json string>
app.post('/api/upload/annotation', upload.single('image'), (req, res) => {
  try {
    const meta = req.body?.meta ? JSON.parse(req.body.meta) : {};

    // 依 label 分資料夾，方便後續訓練資料整理
    const labelRaw = (meta?.annotation?.label || meta?.videoLabel || 'unlabeled').toString();
    const label = labelRaw.trim() ? labelRaw.trim().replace(/[^a-zA-Z0-9_-]/g, '_') : 'unlabeled';
    const labelDir = path.join(DATASET_DIR, label);
    fs.mkdirSync(labelDir, { recursive: true });

    // 把檔案從 uploads 移到 dataset/<label>/
    const src = path.join(UPLOAD_DIR, req.file?.filename || '');
    const ext = path.extname(req.file?.originalname || '') || '.jpg';
    const dstName = `${Date.now()}_${label}${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dst = path.join(labelDir, dstName);

    // 若 src 不存在（理論上不會），就不搬移
    if (req.file?.filename && fs.existsSync(src)) {
      fs.renameSync(src, dst);
    }

    appendIndex({ type: 'annotation', file: path.relative(DATA_DIR, dst), meta });
    res.json({ ok: true, storedAs: path.relative(DATA_DIR, dst) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.message || 'bad request' });
  }
});

// 方便檢視：直接打開已上傳檔案（內網使用）
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/dataset', express.static(DATASET_DIR));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BusVision backend listening on http://0.0.0.0:${PORT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
});
