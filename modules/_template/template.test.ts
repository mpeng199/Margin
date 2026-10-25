import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { boot } from '../../src/core/boot';
import { memoryKeychain } from '../../src/core/keychain';

describe('_template module', () => {
  it('loads when copied under a real id and serves its route', async () => {
    // Folders starting with "_" are skipped by discovery; copy to a temp modules dir to exercise it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-mod-'));
    fs.cpSync(import.meta.dirname, path.join(dir, '_template'), { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-data-'));
    const src = fs.readFileSync(path.join(dir, '_template', 'manifest.ts'), 'utf8').replaceAll("'_template'", "'tmpl'").replaceAll('../../src/', `${path.resolve(import.meta.dirname, '../../src')}/`);
    fs.mkdirSync(path.join(dir, 'tmpl'));
    fs.writeFileSync(path.join(dir, 'tmpl', 'manifest.ts'), src);
    const { app, ctx } = await boot({ dataDir: data, quiet: true, keychain: memoryKeychain(), modulesDir: dir, dev: true });
    ctx.registry.setEnabled('tmpl', true);
    const post = await app.request('/api/tmpl/items', { method: 'POST', headers: { 'x-margin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Hello' }) });
    expect(post.status).toBe(200);
    const list = await (await app.request('/api/tmpl/items')).json();
    expect(list[0].title).toBe('Hello');
  });
});
