/**
 * _template — copy this folder to start a module (folders starting with "_" are not loaded).
 * `npm run new-module -- <id> "<one-line description>"` does the copy + rename for you.
 *
 * Checklist: settings (every field defaulted) · migrations (append-only) · service (what other
 * modules may call) · routes (/api/<id>) · nav/widgets (rendered by web/index.tsx) · events ·
 * rule conditions/actions · Claude tools · a test next to this file.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, today } from '../../src/core/time';

const settings = z.object({
  enabledThing: z.boolean().default(true).describe('Shown in Settings as a toggle.'),
  dailyTarget: z.number().int().min(1).max(10).default(3).describe('Shown as a number field.'),
});
type Settings = z.infer<typeof settings>;

export function createService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('_template');
  return {
    list: () => ctx.db.all<{ id: string; title: string; created_at: string }>('SELECT * FROM template_items ORDER BY created_at DESC'),
    add(title: string) {
      const id = uid();
      ctx.db.run('INSERT INTO template_items (id, title, date, created_at) VALUES (?, ?, ?, ?)', id, title, today(), now().toISO());
      ctx.bus.emit('template.added', { id, title });
      return id;
    },
    countToday: () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM template_items WHERE date = ?', today())!.n,
    target: () => s().dailyTarget,
  };
}
export type TemplateService = ReturnType<typeof createService>;

export default defineModule({
  id: '_template',
  name: 'Template',
  description: 'A minimal example module.',
  defaultEnabled: false,
  settings,
  migrations: [
    `CREATE TABLE template_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL);`,
  ],
  service: createService,
  emits: ['template.added'],
  on: {
    'day.started': (_p, ctx) => ctx.log.info('template saw a new day'),
  },
  routes(r, ctx) {
    const svc = () => ctx.service<TemplateService>('_template');
    r.get('/items', (c) => c.json(svc().list()));
    r.post('/items', async (c) => {
      const { title } = z.object({ title: z.string().min(1) }).parse(await c.req.json());
      return c.json({ id: svc().add(title) });
    });
  },
  nav: [{ id: 'template', label: 'Template', icon: 'Box', path: '/template', section: 'main', order: 90 }],
  widgets: [{ id: 'summary', slot: 'today.side', order: 90 }],
  rules: {
    conditions: [{
      id: 'template.below_target',
      label: 'Template items below target today',
      description: 'Fewer items today than the daily target.',
      params: z.object({}),
      evaluate: (ctx) => {
        const svc = ctx.service<TemplateService>('_template');
        const n = svc.countToday();
        return { met: n < svc.target(), detail: `${n} of ${svc.target()} today.` };
      },
    }],
  },
  claude: {
    tools: [{
      name: 'template_list',
      description: 'List template items.',
      kind: 'read',
      input: z.object({}),
      run: (ctx) => ctx.service<TemplateService>('_template').list(),
    }],
  },
});
