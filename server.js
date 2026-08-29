import express from 'express';
import multer from 'multer';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import PQueue from 'p-queue';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { convertPdfToImages } from './lib/pdfToImages.js';
import { convertImagesToPdf } from './lib/imagesToPdf.js';
import { zipFiles } from './lib/zipFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'tmp', 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'tmp', 'outputs');
const PUBLIC_DIR = path.join(__dirname, 'public');

// File age (ms) after which uploaded/converted files are auto-deleted.
const FILE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // sweep every 15 minutes

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------- Auto file cleanup ----------
async function cleanupOldFiles() {
  const now = Date.now();
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    let entries;
    try { entries = await fsp.readdir(dir); } catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > FILE_MAX_AGE_MS) {
          await fsp.rm(full, { recursive: true, force: true });
          console.log('[cleanup] removed', full);
        }
      } catch (err) {
        console.warn('[cleanup] could not check/remove', full, err.message);
      }
    }
  }
}
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);
cleanupOldFiles();

// ---------- Conversion concurrency queue ----------
// Caps how many conversion jobs run at once, so the server stays responsive
// under load instead of falling over. This is an in-process queue — good
// enough for a single server instance; swap for Redis + BullMQ later if you
// scale to multiple server instances.
const conversionQueue = new PQueue({ concurrency: 2 });

// ---------- App setup ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60, // 60 conversion requests per IP per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});
app.use('/api/convert', apiLimiter);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB per file — adjust for your hosting plan
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, queueSize: conversionQueue.size, queuePending: conversionQueue.pending });
});

// ---------- PDF -> Images ----------
app.post('/api/convert/pdf-to-images', upload.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    if (req.file.mimetype !== 'application/pdf' && !req.file.originalname.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'Please upload a PDF file.' });
    }

    const format = ['jpg', 'jpeg', 'png', 'webp'].includes(req.body.format) ? req.body.format : 'png';
    const dpi = Math.min(600, Math.max(72, parseInt(req.body.dpi, 10) || 150));
    const quality = Math.min(100, Math.max(10, parseInt(req.body.quality, 10) || 85));
    const pages = (req.body.pages || 'all').trim();

    const jobId = randomUUID();
    const jobOutDir = path.join(OUTPUT_DIR, jobId);
    await fsp.mkdir(jobOutDir, { recursive: true });

    const imagePaths = await conversionQueue.add(() =>
      convertPdfToImages({ pdfPath: uploadedPath, outDir: jobOutDir, format, dpi, quality, pages })
    );

    if (imagePaths.length === 0) {
      return res.status(422).json({ error: 'No matching pages were found to convert.' });
    }

    if (imagePaths.length === 1) {
      const filePath = imagePaths[0];
      return res.download(filePath, path.basename(filePath), async () => {
        // best-effort cleanup right after sending; the periodic sweep also catches anything missed
        fsp.rm(uploadedPath, { force: true }).catch(() => {});
      });
    }

    const zipPath = path.join(jobOutDir, 'converted-pages.zip');
    await zipFiles(imagePaths, zipPath);
    return res.download(zipPath, 'converted-pages.zip', async () => {
      fsp.rm(uploadedPath, { force: true }).catch(() => {});
    });
  } catch (err) {
    console.error('pdf-to-images error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  }
});

// ---------- Images -> PDF ----------
app.post('/api/convert/images-to-pdf', upload.array('files', 100), async (req, res) => {
  const uploadedPaths = (req.files || []).map((f) => f.path);
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded.' });
    }
    const pageSize = ['A4', 'Letter', 'Fit'].includes(req.body.pageSize) ? req.body.pageSize : 'Fit';

    const jobId = randomUUID();
    const outPath = path.join(OUTPUT_DIR, `${jobId}.pdf`);

    await conversionQueue.add(() =>
      convertImagesToPdf({ imagePaths: uploadedPaths, outPath, pageSize })
    );

    res.download(outPath, 'converted.pdf', async () => {
      for (const p of uploadedPaths) fsp.rm(p, { force: true }).catch(() => {});
    });
  } catch (err) {
    console.error('images-to-pdf error:', err);
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  }
});

// Fallback to index.html for the frontend (single-page app style)
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocStudio converter backend listening on port ${PORT}`);
});
