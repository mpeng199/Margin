import fs from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** Plain line logger. Never pass secrets in; there is no redaction magic to rely on. */
export function createLogger(dir: string | null, quiet = false): Logger {
  const file = dir ? path.join(dir, 'margin.log') : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const write = (level: string, msg: string, extra?: unknown) => {
    const tail = extra instanceof Error ? ` ${extra.message}\n${extra.stack}` : extra !== undefined ? ` ${safe(extra)}` : '';
    const line = `${new Date().toISOString()} ${level} ${msg}${tail}`;
    if (!quiet) (level === 'ERROR' ? console.error : console.log)(line);
    if (file) fs.appendFile(file, line + '\n', () => {});
  };
  return {
    info: (m, e) => write('INFO', m, e),
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e),
  };
}
function safe(v: unknown) {
  try { return JSON.stringify(v).slice(0, 2000); } catch { return String(v); }
}
