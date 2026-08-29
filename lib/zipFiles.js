import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';

export function zipFiles(filePaths, zipOutPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipOutPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve(zipOutPath));
    archive.on('error', reject);
    archive.pipe(output);

    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }

    archive.finalize();
  });
}
