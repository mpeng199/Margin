import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, type BootOptions } from '../src/core/boot';
import { memoryKeychain } from '../src/core/keychain';
import { setClock, resetClock, setZone } from '../src/core/time';

/** Boot a fresh app in a temp dir. `at` pins the clock (ISO with offset). */
export async function testApp(opts: Partial<BootOptions> & { at?: string } = {}) {
  setZone('America/New_York');
  if (opts.at) { const ms = Date.parse(opts.at); setClock(() => ms); } else resetClock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-test-'));
  const res = await boot({ dataDir, quiet: true, keychain: memoryKeychain(), dev: true, ...opts });
  const req = async (method: string, url: string, body?: unknown) => {
    const r = await res.app.request(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-margin': '1', host: '127.0.0.1:7317' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  return { ...res, dataDir, req, setNow: (iso: string) => { const ms = Date.parse(iso); setClock(() => ms); } };
}
/** Let queued bus handlers run. */
export const flush = () => new Promise((r) => setTimeout(r, 10));
