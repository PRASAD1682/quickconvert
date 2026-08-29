import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fsp from 'node:fs/promises';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

async function getPageCount(pdfPath) {
  const { stdout } = await execFileAsync('pdfinfo', [pdfPath]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error('Could not read the PDF page count (is the file a valid PDF?).');
  return parseInt(match[1], 10);
}

/**
 * Parses a page-selection string into a sorted, de-duplicated list of page
 * numbers, clamped to the document's actual page count.
 *   'all'          -> every page
 *   '1,3,5-7,10'   -> [1,3,5,6,7,10]
 */
export function parsePagesSpec(spec, totalPages) {
  if (!spec || spec.toLowerCase() === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const result = new Set();
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      let a = parseInt(rangeMatch[1], 10);
      let b = parseInt(rangeMatch[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p++) if (p >= 1 && p <= totalPages) result.add(p);
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n) && n >= 1 && n <= totalPages) result.add(n);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

/**
 * Renders selected pages of a PDF to image files.
 * Always rasterizes losslessly via poppler (pdftoppm) first, then uses sharp
 * to apply the final format + quality — one consistent post-processing step
 * regardless of the requested output format.
 */
export async function convertPdfToImages({ pdfPath, outDir, format, dpi, quality, pages }) {
  const totalPages = await getPageCount(pdfPath);
  const pageNumbers = parsePagesSpec(pages, totalPages);
  if (pageNumbers.length === 0) return [];

  const outputs = [];

  for (const pageNum of pageNumbers) {
    const rawPrefix = path.join(outDir, `page-${pageNum}-raw`);
    const rawPngPath = `${rawPrefix}.png`;

    await execFileAsync('pdftoppm', [
      '-png', '-r', String(dpi),
      '-f', String(pageNum), '-l', String(pageNum),
      '-singlefile',
      pdfPath, rawPrefix,
    ]);

    const ext = format === 'jpg' ? 'jpg' : format;
    const finalPath = path.join(outDir, `page-${pageNum}.${ext}`);

    if (format === 'png') {
      await sharp(rawPngPath).png({ compressionLevel: 8 }).toFile(finalPath);
    } else if (format === 'jpg' || format === 'jpeg') {
      await sharp(rawPngPath).flatten({ background: '#ffffff' }).jpeg({ quality }).toFile(finalPath);
    } else if (format === 'webp') {
      await sharp(rawPngPath).webp({ quality }).toFile(finalPath);
    } else {
      throw new Error(`Unsupported output format: ${format}`);
    }

    await fsp.rm(rawPngPath, { force: true }).catch(() => {});
    outputs.push(finalPath);
  }

  return outputs;
}
