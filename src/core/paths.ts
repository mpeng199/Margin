import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** ~/Library/Application Support/Margin, or MARGIN_DATA_DIR (dev and tests use their own). */
export function dataDir(): string {
  const dir = process.env.MARGIN_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Margin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const PORT = Number(process.env.MARGIN_PORT || 7317);
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
