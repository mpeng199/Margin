/**
 * rituals — the shutdown, weekly-review and morning checklists as editable data (SPEC 9).
 * Defaults live in defaults.ts. A person's edits are stored per ritual; "Reset" returns to the defaults.
 * Step ids are stable, so other modules can key behaviour off them while labels are renamed freely.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now } from '../../src/core/time';
import { DEFAULT_RITUALS, RITUAL_IDS, cloneRitual, type Ritual, type RitualId, type RitualStep } from './defaults';

export type { Ritual, RitualId, RitualStep } from './defaults';

const stepSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1, 'A step needs a name.').max(160),
  why: z.string().trim().max(400).optional(),
  source: z.string().trim().max(120).optional(),
  core: z.boolean().optional(),
});
const stepsSchema = z.array(stepSchema).min(1, 'A ritual needs at least one step.').max(30);

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

export function createRitualsService(ctx: Ctx) {
  function assertId(id: string): asserts id is RitualId {
    if (!RITUAL_IDS.includes(id as RitualId)) throw httpError(`Unknown ritual “${id}”.`, 404);
  }

  /** Core flags and the default why/source always come from the defaults, whatever was stored. */
  function normalize(id: RitualId, steps: RitualStep[]): RitualStep[] {
    const defaults = new Map(DEFAULT_RITUALS[id].steps.map((s) => [s.id, s]));
    return steps.map((s) => {
      const d = defaults.get(s.id);
      const out: RitualStep = { id: s.id, label: s.label };
      const why = s.why ?? d?.why;
      const source = s.source ?? d?.source;
      if (why) out.why = why;
      if (source) out.source = source;
      if (d?.core) out.core = true;
      return out;
    });
  }

  const svc = {
    ids: () => [...RITUAL_IDS],

    get(id: RitualId): Ritual {
      assertId(id);
      const row = ctx.db.get<{ steps: string }>('SELECT steps FROM rituals WHERE id = ?', id);
      const base = cloneRitual(id);
      if (!row) return base;
      try {
        return { ...base, steps: normalize(id, JSON.parse(row.steps) as RitualStep[]) };
      } catch {
        return base;
      }
    },

    list(): Ritual[] {
      return RITUAL_IDS.map((id) => svc.get(id));
    },

    isCustomised(id: RitualId): boolean {
      assertId(id);
      return !!ctx.db.get('SELECT 1 FROM rituals WHERE id = ?', id);
    },

    /** Replace a ritual's steps. Missing ids are assigned; order is the array order. */
    save(id: RitualId, steps: Array<Partial<RitualStep> & { label: string }>): Ritual {
      assertId(id);
      const parsed = stepsSchema.safeParse(steps);
      if (!parsed.success) throw httpError(parsed.error.issues[0]?.message ?? 'Invalid steps.', 400);
      const seen = new Set<string>();
      const clean = parsed.data.map((s) => {
        let sid = s.id ?? `custom-${uid().slice(0, 8)}`;
        if (seen.has(sid)) sid = `custom-${uid().slice(0, 8)}`;
        seen.add(sid);
        return { ...s, id: sid } as RitualStep;
      });
      const stored = normalize(id, clean);
      ctx.db.run(
        `INSERT INTO rituals (id, steps, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at`,
        id, JSON.stringify(stored), now().toISO(),
      );
      ctx.bus.emit('rituals.changed', { id });
      return svc.get(id);
    },

    reset(id: RitualId): Ritual {
      assertId(id);
      ctx.db.run('DELETE FROM rituals WHERE id = ?', id);
      ctx.bus.emit('rituals.changed', { id });
      return svc.get(id);
    },
  };
  return svc;
}
export type RitualsService = ReturnType<typeof createRitualsService>;

export default defineModule({
  id: 'rituals',
  name: 'Rituals',
  description: 'Edit the shutdown, weekly-review and morning checklists: rename, reorder, add, remove.',
  migrations: [
    `CREATE TABLE rituals (id TEXT PRIMARY KEY, steps TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  ],
  service: createRitualsService,
  emits: ['rituals.changed'],
  routes(r, ctx) {
    const svc = () => ctx.service<RitualsService>('rituals');
    r.get('/', (c) => c.json(svc().list().map((x) => ({ ...x, customised: svc().isCustomised(x.id) }))));
    r.get('/:id', (c) => c.json(svc().get(c.req.param('id') as RitualId)));
    r.put('/:id', async (c) => {
      const body = z.object({ steps: z.array(z.any()) }).parse(await c.req.json());
      return c.json(svc().save(c.req.param('id') as RitualId, body.steps));
    });
    r.post('/:id/reset', (c) => c.json(svc().reset(c.req.param('id') as RitualId)));
  },
  claude: {
    tools: [{
      name: 'get_rituals',
      description: 'The editable checklists (shutdown, weekly-review, morning) with each step’s label and why.',
      kind: 'read',
      input: z.object({ id: z.enum(['shutdown', 'weekly-review', 'morning']).optional() }),
      run: (ctx, i) => {
        const svc = ctx.service<RitualsService>('rituals');
        return i.id ? svc.get(i.id) : svc.list();
      },
    }],
  },
});
