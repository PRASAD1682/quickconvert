import { PDFDocument } from 'pdf-lib';
import fsp from 'node:fs/promises';
import sharp from 'sharp';

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
};

/**
 * Combines one or more images into a single PDF, one image per page.
 * pageSize: 'A4' | 'Letter' | 'Fit' (page sized to match each image's own
 * aspect ratio — no letterboxing, closest to what users usually expect from
 * a quick "images to PDF" tool).
 */
export async function convertImagesToPdf({ imagePaths, outPath, pageSize = 'Fit' }) {
  const doc = await PDFDocument.create();

  for (const imgPath of imagePaths) {
    // Normalize every input to PNG bytes via sharp — handles JPEG, WebP,
    // GIF, etc. uniformly and strips any embedded EXIF/location metadata
    // as a side effect of the re-encode.
    const meta = await sharp(imgPath).metadata();
    const pngBuffer = await sharp(imgPath).png().toBuffer();
    const embedded = await doc.embedPng(pngBuffer);
    const imgW = meta.width;
    const imgH = meta.height;

    let pageW, pageH, drawW, drawH, x, y;
    if (pageSize === 'Fit') {
      pageW = imgW; pageH = imgH;
      drawW = imgW; drawH = imgH; x = 0; y = 0;
    } else {
      [pageW, pageH] = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
      const margin = Math.min(pageW, pageH) * 0.04;
      const availW = pageW - margin * 2;
      const availH = pageH - margin * 2;
      const scale = Math.min(availW / imgW, availH / imgH);
      drawW = imgW * scale; drawH = imgH * scale;
      x = (pageW - drawW) / 2; y = (pageH - drawH) / 2;
    }

    const page = doc.addPage([pageW, pageH]);
    page.drawImage(embedded, { x, y, width: drawW, height: drawH });
  }

  const bytes = await doc.save();
  await fsp.writeFile(outPath, bytes);
  return outPath;
}
