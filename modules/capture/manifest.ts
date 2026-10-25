/**
 * capture — quick capture (SPEC 6, 4.2 Evening mode).
 *
 * POST /api/capture {text} runs Todoist's own quick-add parser first. In Evening mode and on the
 * off-day nothing gets a forced date: the item lands in the Inbox and is remembered here as
 * "captured for" the next planning date, so the morning shows it ("From last night") with
 * Make Must-Do / Schedule / Keep in Inbox. If Todoist can't be reached the text is kept locally and
 * retried, so a thought is never lost. Claude parsing is an optional second step the person confirms.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, addDays, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { TodoistService } from '../todoist/manifest';
import type { PlanService } from '../plan/manifest';

const settings = z.object({
  useClaudeFallback: z.boolean().default(true).describe('Offer to have Claude parse a capture when Todoist’s own parsing isn’t enough. You confirm the result before anything is added.'),
});
type Settings = z.infer<typeof settings>;

export class CaptureError extends Error {
  constructor(message: string, public status = 409, public extra: Record<string, unknown> = {}) { super(message); }
}

export interface ParsedCapture {
  content: string; dueString?: string; priority?: number; labels?: string[]; projectId?: string; estimateMin?: number;
}

const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
/** Claude's answer is untrusted shape: keep only fields we understand. */
function normalizeParsed(data: any, original: string): ParsedCapture {
  const d = data && typeof data === 'object' ? data : {};
  const priority = Number(d.priority);
  const est = Number(d.estimateMin ?? d.estimate);
  return {
    content: str(d.content) ?? str(d.title) ?? str(d.text) ?? original.trim(),
    dueString: str(d.dueString) ?? str(d.due) ?? str(d.date),
    priority: Number.isInteger(priority) && priority >= 1 && priority <= 4 ? priority : undefined,
    labels: Array.isArray(d.labels) ? d.labels.filter((l: unknown) => typeof l === 'string' && l.trim()).map((l: string) => l.trim()) : undefined,
    projectId: str(d.projectId),
    estimateMin: Number.isFinite(est) && est > 0 && est <= 1440 ? Math.round(est) : undefined,
  };
}

export function createCaptureService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('capture');
  const td = () => ctx.service<TodoistService>('todoist');
  const day = () => ctx.service<DayService>('day');
  const plan = () => ctx.maybe<PlanService>('plan');
  const ai = () => ctx.maybe<any>('ai');
  const smartAvailable = () => !!ai()?.enabled?.() && s().useClaudeFallback;

  /** Evening mode and the off-day: nothing here is work yet. */
  const afterHours = () => day().mode() !== 'day';
  const forDate = (): ISODate | null => (afterHours() ? addDays(day().planningDate(), 1) : null);

  const record = (taskId: string | null, text: string, status: 'open' | 'queued' | 'handled', date: ISODate | null) => {
    const id = uid();
    ctx.db.run('INSERT INTO capture_items (id, text, task_id, for_date, status, captured_at) VALUES (?, ?, ?, ?, ?, ?)', id, text, taskId, date, status, now().toISO());
    return id;
  };
  const row = (id: string) => ctx.db.get<{ id: string; text: string; task_id: string | null; for_date: string | null; status: string }>('SELECT * FROM capture_items WHERE id = ?', id);
  const handle = (id: string, outcome: string) =>
    ctx.db.run("UPDATE capture_items SET status = 'handled', outcome = ?, handled_at = ? WHERE id = ?", outcome, now().toISO(), id);

  let flushing = false;
  const svc = {
    settings: s,
    smartAvailable,

    /** Todoist's own parser first. Always returns a message; never loses the text. */
    async capture(text: string): Promise<{ message: string; taskId?: string; queued?: boolean }> {
      const t = text.trim();
      if (!t) throw new CaptureError('Type something to capture.', 400);
      const date = forDate();
      const saved = date ? 'Saved for tomorrow.' : 'Added to Todoist.';
      try {
        const item = await td().quickAdd(t);
        if (date) record(item.id, t, 'open', date);
        ctx.bus.emit('capture.added', { taskId: item.id, forDate: date });
        return { message: saved, taskId: item.id };
      } catch (e: any) {
        record(null, t, 'queued', date);
        ctx.bus.emit('capture.queued', { forDate: date });
        ctx.log.warn('capture queued; Todoist unreachable', e?.message);
        return { message: 'Couldn’t reach Todoist. Saved on this Mac and it will be added when Todoist connects.', queued: true };
      }
    },

    /** Retry captures that couldn't be sent. */
    async flushQueue() {
      if (flushing) return 0;
      flushing = true;
      let n = 0;
      try {
        for (const q of ctx.db.all<{ id: string; text: string; for_date: string | null }>("SELECT * FROM capture_items WHERE status = 'queued' ORDER BY captured_at")) {
          try {
            const item = await td().quickAdd(q.text);
            ctx.db.run("UPDATE capture_items SET status = ?, task_id = ? WHERE id = ?", q.for_date ? 'open' : 'handled', item.id, q.id);
            n++;
          } catch { break; } // still offline: stop, try again later
        }
      } finally { flushing = false; }
      return n;
    },
    queuedCount: () => ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM capture_items WHERE status = 'queued'")!.n,

    /** Captured in the evening or on the off-day for `date` (or earlier) and not yet handled. */
    lastNight(date: ISODate = day().planningDate()) {
      return ctx.db.all<{ id: string; text: string; task_id: string; for_date: string; captured_at: string }>(
        "SELECT * FROM capture_items WHERE status = 'open' AND for_date IS NOT NULL AND for_date <= ? AND task_id IS NOT NULL ORDER BY captured_at", date)
        .map((r) => ({ id: r.id, text: r.text, taskId: r.task_id, forDate: r.for_date, capturedAt: r.captured_at, task: td().task(r.task_id) }))
        .filter((x) => x.task && !x.task.checked)
        .map((x) => ({ id: x.id, text: x.text, taskId: x.taskId, forDate: x.forDate, capturedAt: x.capturedAt, content: x.task!.content, projectName: x.task!.projectName, due: x.task!.due }));
    },

    async makeMustDo(itemId: string, opts: { date?: ISODate; optional?: boolean; swapOut?: string } = {}) {
      const r = row(itemId);
      if (!r?.task_id) throw new CaptureError('Capture not found', 404);
      const p = plan();
      if (!p) throw new CaptureError('The daily plan is turned off, so there are no must-dos.');
      const out = await p.addMustDo(r.task_id, opts.date ?? day().planningDate(), opts);
      handle(itemId, 'must-do');
      return out;
    },
    async schedule(itemId: string, date: ISODate) {
      const r = row(itemId);
      if (!r?.task_id) throw new CaptureError('Capture not found', 404);
      await td().reschedule(r.task_id, date);
      handle(itemId, `scheduled:${date}`);
      return { ok: true };
    },
    keep(itemId: string) {
      if (!row(itemId)) throw new CaptureError('Capture not found', 404);
      handle(itemId, 'inbox');
      return { ok: true };
    },

    // ---- Claude fallback: parse, then the person confirms (nothing is added by parsing)
    async smartParse(text: string): Promise<{ ok: boolean; parsed: ParsedCapture; message?: string }> {
      if (!smartAvailable()) throw new CaptureError('Claude parsing is off.');
      const t = text.trim();
      if (!t) throw new CaptureError('Type something to parse.', 400);
      try {
        const out = await ai().run('parse_capture', { text: t });
        let data = out?.data;
        if (!data && typeof out?.text === 'string') { try { data = JSON.parse(out.text); } catch { /* prose */ } }
        return { ok: true, parsed: normalizeParsed(data, t) };
      } catch (e: any) {
        ctx.log.warn('parse_capture failed', e?.message);
        return { ok: false, parsed: { content: t }, message: 'Claude couldn’t parse that. You can still add it as written.' };
      }
    },
    async addParsed(p: ParsedCapture) {
      const date = forDate();
      const id = await td().add({ content: p.content, dueString: p.dueString, priority: p.priority, labels: p.labels, projectId: p.projectId });
      if (!id) throw new CaptureError('Todoist didn’t return the new task. Try again.', 502);
      if (p.estimateMin) await td().setEstimate(id, p.estimateMin);
      if (date) record(id, p.content, 'open', date);
      ctx.bus.emit('capture.added', { taskId: id, forDate: date });
      return { message: date ? 'Saved for tomorrow.' : 'Added to Todoist.', taskId: id };
    },
  };
  return svc;
}
export type CaptureService = ReturnType<typeof createCaptureService>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default defineModule({
  id: 'capture',
  name: 'Quick capture',
  description: 'Capture anywhere into the Todoist inbox. After hours, items wait for the morning instead of becoming work.',
  requires: ['day', 'todoist'],
  settings,
  migrations: [
    `CREATE TABLE capture_items (id TEXT PRIMARY KEY, text TEXT NOT NULL, task_id TEXT, for_date TEXT, status TEXT NOT NULL DEFAULT 'open',
       captured_at TEXT NOT NULL, handled_at TEXT, outcome TEXT);
     CREATE INDEX capture_items_status ON capture_items(status, for_date);`,
  ],
  service: createCaptureService,
  widgets: [
    { id: 'capture', slot: 'evening', order: 10 },
    { id: 'from-last-night', slot: 'today.main', order: 15 },
  ],
  emits: ['capture.added', 'capture.queued'],
  jobs: [{ id: 'flush-queue', every: 3, run: async (ctx) => { await ctx.service<CaptureService>('capture').flushQueue(); } }],
  routes(r, ctx) {
    const cap = () => ctx.service<CaptureService>('capture');
    /** CaptureError and PlanError (cap reached) both carry a status and extra fields the UI acts on. */
    const guard = async (c: any, fn: () => unknown) => {
      try { return c.json(await fn()); }
      catch (e: any) {
        if (e && typeof e.status === 'number' && e.extra) return c.json({ error: e.message, ...e.extra }, e.status);
        throw e;
      }
    };

    r.post('/', (c) => guard(c, async () => cap().capture(z.object({ text: z.string() }).parse(await c.req.json()).text)));
    r.get('/status', (c) => c.json({ smart: cap().smartAvailable(), queued: cap().queuedCount() }));
    r.get('/last-night', (c) => c.json(cap().lastNight(c.req.query('date') ?? undefined)));

    r.post('/items/:id/must-do', (c) => guard(c, async () => {
      const b = z.object({ date: dateStr.optional(), optional: z.boolean().optional(), swapOut: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
      return cap().makeMustDo(c.req.param('id'), b);
    }));
    r.post('/items/:id/schedule', (c) => guard(c, async () => cap().schedule(c.req.param('id'), z.object({ date: dateStr }).parse(await c.req.json()).date)));
    r.post('/items/:id/keep', (c) => guard(c, async () => cap().keep(c.req.param('id'))));

    r.post('/smart', (c) => guard(c, async () => cap().smartParse(z.object({ text: z.string() }).parse(await c.req.json()).text)));
    r.post('/smart/add', (c) => guard(c, async () => cap().addParsed(z.object({
      content: z.string().min(1), dueString: z.string().optional(), priority: z.number().int().min(1).max(4).optional(),
      labels: z.array(z.string()).optional(), projectId: z.string().optional(), estimateMin: z.number().int().min(1).max(1440).optional(),
    }).parse(await c.req.json()))));
  },
});
