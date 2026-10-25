import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { testApp } from '../../tests/helpers';
import type { BackupService } from './manifest';

describe('backup', () => {
  it('snapshots the database, prunes old copies, and exports JSON/CSV', async () => {
    const app = await testApp({ at: '2026-11-01T03:00:00-05:00', only: ['backup'] });
    const b = app.ctx.service<BackupService>('backup');
    app.ctx.settings.set('backup', { keep: 3 });
    for (const d of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']) b.run(d);
    expect(b.list().map((x) => x.file)).toEqual(['margin-2026-10-31.db', 'margin-2026-10-30.db', 'margin-2026-10-29.db']);
    expect(fs.statSync(b.list()[0].path).size).toBeGreaterThan(1000);
    const json = (await app.req('GET', '/api/backup/export.json')).json;
    expect(json.tables.settings.some((r: any) => r.module === 'backup')).toBe(true);
    const csv = (await app.req('GET', '/api/backup/export/settings.csv')).text;
    expect(csv.split('\n')[0]).toBe('module,value,updated_at');
  });
});
