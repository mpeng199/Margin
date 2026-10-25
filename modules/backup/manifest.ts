/**
 * backup — automatic daily SQLite snapshot (VACUUM INTO, consistent while the app runs), pruned to
 * the newest N, plus JSON and CSV export of every table. Secrets are never in the DB, so exports are safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { now, today } from '../../src/core/time';

const settings = z.object({
  keep: z.number().int().min(3).max(90).default(14).describe('Daily backups to keep.'),
  time: z.string().regex(/^\d{2}:\d{2}$/).default('03:00').describe('When the daily backup runs.'),
});

export function createBackupService(ctx: Ctx) {
  const dir = path.join(ctx.dataDir, 'backups');
  const svc = {
    dir,
    list() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse()
        .map((f) => ({ file: f, path: path.join(dir, f), bytes: fs.statSync(path.join(dir, f)).size }));
    },
    run(label = today()) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `margin-${label}.db`);
      if (fs.existsSync(file)) fs.rmSync(file);
      ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      const keep = ctx.settings.get<{ keep: number }>('backup').keep;
      for (const old of svc.list().slice(keep)) fs.rmSync(old.path, { force: true });
      ctx.bus.emit('backup.created', { file: path.basename(file) });
      return file;
    },
    tables(): string[] {
      return ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name").map((r) => r.name);
    },
    exportJson() {
      const out: Record<string, unknown[]> = {};
      for (const t of svc.tables()) out[t] = ctx.db.all(`SELECT * FROM "${t}"`);
      return { app: 'Margin', exportedAt: now().toISO(), tables: out };
    },
    exportCsv(table: string) {
      if (!svc.tables().includes(table)) throw Object.assign(new Error('Unknown table'), { status: 404 });
      const rows = ctx.db.all(`SELECT * FROM "${table}"`);
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]);
      const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      return [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as any)[c])).join(','))].join('\n');
    },
  };
  return svc;
}
export type BackupService = ReturnType<typeof createBackupService>;

export default defineModule({
  id: 'backup',
  name: 'Backup and export',
  description: 'A daily local backup of the database, and JSON/CSV export of everything.',
  core: true,
  settings,
  service: createBackupService,
  emits: ['backup.created'],
  jobs: [{ id: 'daily', at: (ctx) => [ctx.settings.get<{ time: string }>('backup').time], run: (ctx) => { ctx.service<BackupService>('backup').run(); } }],
  routes(r, ctx) {
    const b = () => ctx.service<BackupService>('backup');
    r.get('/list', (c) => c.json(b().list().map(({ file, bytes }) => ({ file, bytes }))));
    r.post('/now', (c) => c.json({ file: path.basename(b().run(now().toFormat("yyyy-MM-dd'T'HHmm"))) }));
    r.post('/reveal', (c) => { execFile('open', [b().dir]); return c.json({ ok: true }); });
    r.get('/tables', (c) => c.json(b().tables()));
    r.get('/export.json', (c) => {
      c.header('content-disposition', `attachment; filename="margin-export-${today()}.json"`);
      return c.json(b().exportJson());
    });
    r.get('/export/:table', (c) => {
      const t = c.req.param('table').replace(/\.csv$/, '');
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="margin-${t}-${today()}.csv"`);
      return c.body(b().exportCsv(t));
    });
  },
});
