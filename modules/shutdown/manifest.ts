/**
 * shutdown — the hard stop and the 10-minute guided shutdown (SPEC 4.2). Logs when shutdown started and
 * finished, plans the stop notifications, and tells the rules engine how well the stop is holding.
 * Completing shutdown is what flips the app into Evening mode (day.mode() reads completedAt).
 */
import { z } from 'zod';
import { defineModule, type Ctx, type PlannedNotification, type RuleCondition } from '../../src/core/types';
import { now, addDays, fromISO, fmtTime, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { TodoistService } from '../todoist/manifest';
import { createFlow, payloadSchema, FlowError } from './flow';

const settings = z.object({
  wrapUpMin: z.number().int().min(5).max(120).default(30).describe('“Wrap up” notification, minutes before the stop.'),
  startMin: z.number().int().min(1).max(60).default(10).describe('“Start your shutdown” notification, minutes before the stop.'),
  lightsOutCueMin: z.number().int().min(0).max(60).default(15).describe('“Screens down” cue, minutes before lights-out.'),
  brokenGraceMin: z.number().int().min(0).max(60).default(15).describe('A night counts as a broken stop when shutdown is logged more than this many minutes after the stop.'),
  overdueLookbackDays: z.number().int().min(0).max(60).default(7).describe('Overdue tasks older than this aren’t part of the 72-hour deadline check.'),
});
type Settings = z.infer<typeof settings>;

export interface ShutdownNight {
  date: ISODate;
  startedAt: string | null;
  completedAt: string | null;
  minutesAfterStop: number | null;
}
export interface NightStatus { date: ISODate; completed: boolean; minutesAfterStop: number | null; breaks: number; broken: boolean; held: boolean }

const PROJECT_VIEW = /^\/projects\/([^/?#]+)/;

export function createShutdownService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('shutdown');
  const day = () => ctx.service<DayService>('day');
  const row = (date: ISODate) =>
    ctx.db.get<{ started_at: string | null; completed_at: string | null; minutes_after_stop: number | null; summary: string | null }>('SELECT * FROM shutdowns WHERE date = ?', date);

  const flow = createFlow(ctx, { settings: s, completedAt: (d) => svc.completedAt(d), row });

  const svc = {
    settings: s,
    flow,

    /** ISO time shutdown was logged for the night of `date`, or null. */
    completedAt(date: ISODate): string | null { return row(date)?.completed_at ?? null; },

    history(from: ISODate, to: ISODate): ShutdownNight[] {
      return ctx.db.all<{ date: string; started_at: string | null; completed_at: string | null; minutes_after_stop: number | null }>(
        'SELECT date, started_at, completed_at, minutes_after_stop FROM shutdowns WHERE date >= ? AND date <= ? ORDER BY date', from, to,
      ).map((r) => ({ date: r.date, startedAt: r.started_at, completedAt: r.completed_at, minutesAfterStop: r.minutes_after_stop }));
    },

    summary(date: ISODate): Record<string, any> | null {
      const r = row(date);
      return r?.summary ? JSON.parse(r.summary) : null;
    },

    /** Stop breaks that count against the stop. Work opened during the off-day's daytime is `offday.worked`, not a broken stop. */
    stopBreaks(from: ISODate, to: ISODate) {
      const d = day();
      return d.stopBreaks(from, to).filter((b) => !(d.isOffDay(b.date) && fromISO(b.at).toMillis() < d.anchors(b.date).effectiveStop.toMillis()));
    },

    /** Per-night verdict: broken = a stop break that night, or shutdown logged well after the stop. Held = shutdown on time, no breaks. */
    nights(from: ISODate, to: ISODate): NightStatus[] {
      const grace = s().brokenGraceMin;
      const hist = new Map(svc.history(from, to).map((h) => [h.date, h]));
      const breaks = new Map<string, number>();
      for (const b of svc.stopBreaks(from, to)) breaks.set(b.date, (breaks.get(b.date) ?? 0) + 1);
      const out: NightStatus[] = [];
      for (let date = from; date <= to; date = addDays(date, 1)) {
        const h = hist.get(date);
        const n = breaks.get(date) ?? 0;
        const completed = !!h?.completedAt;
        const late = completed && h!.minutesAfterStop != null && h!.minutesAfterStop > grace;
        out.push({ date, completed, minutesAfterStop: h?.minutesAfterStop ?? null, breaks: n, broken: n > 0 || late, held: completed && !late && n === 0 });
      }
      return out;
    },

    /** The most recent night whose outcome is known: tonight once shutdown is logged or the stop has passed. */
    lastDecidedNight(): ISODate {
      const d = day();
      const date = d.planningDate();
      return svc.completedAt(date) || now().toMillis() >= d.anchors(date).effectiveStop.toMillis() ? date : addDays(date, -1);
    },
  };
  return svc;
}
export type ShutdownService = ReturnType<typeof createShutdownService>;

const notes = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;

const conditions: RuleCondition[] = [
  {
    id: 'shutdown.stop_broken_count',
    label: 'Stop broken several times',
    description: 'The stop was broken on at least N nights in the last D days: a “breaking my stop” tap, or shutdown logged well after the stop.',
    params: z.object({ count: z.number().int().min(1).max(30).default(2), windowDays: z.number().int().min(1).max(90).default(7) }),
    evaluate: (ctx, p) => {
      const sd = ctx.service<ShutdownService>('shutdown');
      const to = ctx.service<DayService>('day').planningDate();
      const n = sd.nights(addDays(to, -(p.windowDays - 1)), to).filter((x) => x.broken).length;
      return { met: n >= p.count, detail: `Stop broken ${notes(n)} ${p.windowDays === 7 ? 'this week' : `in the last ${p.windowDays} days`}.` };
    },
  },
  {
    id: 'shutdown.stop_held_days',
    label: 'Stop held most nights',
    description: 'Shutdown logged on time, with no stop break, on at least H of the last N nights.',
    params: z.object({ held: z.number().int().min(1).max(30).default(6), of: z.number().int().min(1).max(30).default(7) }),
    evaluate: (ctx, p) => {
      const sd = ctx.service<ShutdownService>('shutdown');
      const to = sd.lastDecidedNight();
      const n = sd.nights(addDays(to, -(p.of - 1)), to).filter((x) => x.held).length;
      return { met: n >= p.held, detail: `Stop held ${n} of the last ${p.of} nights.` };
    },
  },
  {
    id: 'shutdown.past_stop_on_project',
    label: 'Working past the stop on one project',
    description: 'You opened the same project’s views after the stop on at least N nights in the last D days. The subject is the project id.',
    params: z.object({ times: z.number().int().min(1).max(30).default(2), windowDays: z.number().int().min(1).max(90).default(14) }),
    evaluate: (ctx, p) => {
      const sd = ctx.service<ShutdownService>('shutdown');
      const to = ctx.service<DayService>('day').planningDate();
      const nights = new Map<string, Set<string>>();
      for (const b of sd.stopBreaks(addDays(to, -(p.windowDays - 1)), to)) {
        const id = PROJECT_VIEW.exec(b.view)?.[1];
        if (!id) continue;
        if (!nights.has(id)) nights.set(id, new Set());
        nights.get(id)!.add(b.date);
      }
      const [top, set] = [...nights.entries()].sort((a, b) => b[1].size - a[1].size)[0] ?? [];
      if (!top || set!.size < p.times) return { met: false };
      let name = top;
      try { name = ctx.maybe<{ get(id: string): { name: string } | null }>('projects')?.get(top)?.name ?? top; } catch { /* keep the id */ }
      return { met: true, subject: top, detail: `Worked past your stop on ${name} ${notes(set!.size)} in the last ${p.windowDays} days.` };
    },
  },
];

export default defineModule({
  id: 'shutdown',
  name: 'Shutdown',
  description: 'The hard-stop notifications, the 10-minute guided shutdown, and Evening mode.',
  settings,
  migrations: [
    `CREATE TABLE shutdowns (date TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, minutes_after_stop INTEGER, summary TEXT);`,
  ],
  service: createShutdownService,
  nav: [{ id: 'shutdown', label: 'Shutdown', icon: 'Moon', path: '/shutdown', section: 'secondary', order: 10 }],
  widgets: [
    { id: 'countdown', slot: 'evening', order: 0 },
    { id: 'prompt', slot: 'evening', order: 5 },
  ],
  emits: ['shutdown.started', 'shutdown.completed'],
  init(ctx) {
    const td = () => ctx.service<TodoistService>('todoist');
    // One change = one new task from the brain dump, with its next action kept as task metadata.
    ctx.changes.register('shutdown.task.add', {
      label: 'Add a task from the shutdown',
      editable: ['content', 'nextAction'],
      apply: async (_c, p) => {
        const id = await td().add({
          content: p.content,
          description: p.nextAction ? `Next action: ${p.nextAction}` : '',
          dueDate: p.dueDate ?? undefined,
          projectId: p.projectId ?? undefined,
        });
        if (!id) throw new Error('Todoist didn’t return the new task.');
        td().setMeta(id, { nextAction: p.nextAction || null, mustDoDate: p.mustDoDate ?? null });
        return { taskId: id };
      },
    });
  },

  notifications(ctx, date): PlannedNotification[] {
    const day = ctx.service<DayService>('day');
    const st = ctx.settings.get<Settings>('shutdown');
    const a = day.anchors(date);
    const stop = fmtTime(a.effectiveStop);
    const out: PlannedNotification[] = [];
    // Wellbeing, not work: the work gate closes at the stop, and "Shutdown now" must still arrive.
    if (!day.isOffDay(date) && !ctx.service<ShutdownService>('shutdown').completedAt(date)) {
      out.push(
        { key: `shutdown.wrap:${date}`, at: a.effectiveStop.minus({ minutes: st.wrapUpMin }), title: 'Wrap up', body: `Your stop is at ${stop}.`, category: 'wellbeing', path: '/shutdown' },
        { key: `shutdown.start:${date}`, at: a.effectiveStop.minus({ minutes: st.startMin }), title: 'Start your shutdown', body: 'It takes about 10 minutes.', category: 'wellbeing', path: '/shutdown' },
        { key: `shutdown.now:${date}`, at: a.effectiveStop, title: 'Shutdown now', body: 'Your stop is now. Open the shutdown and finish up.', category: 'wellbeing', path: '/shutdown' },
      );
    }
    out.push({
      key: `shutdown.lights:${date}`, at: a.lightsOut.minus({ minutes: st.lightsOutCueMin }),
      title: `Lights-out at ${fmtTime(a.lightsOut)}`, body: 'Screens down.', category: 'wellbeing',
    });
    return out;
  },

  rules: { conditions },

  routes(r, ctx) {
    const svc = () => ctx.service<ShutdownService>('shutdown');
    const flow = () => svc().flow;
    const date = () => ctx.service<DayService>('day').planningDate();
    const guard = async (c: any, fn: () => Promise<unknown> | unknown) => {
      try { return c.json(await fn()); } catch (e) {
        if (e instanceof FlowError) return c.json({ error: e.message, ...e.extra }, e.status);
        throw e;
      }
    };
    r.get('/state', (c) => guard(c, () => flow().state(date())));
    r.post('/start', (c) => guard(c, () => { flow().start(date()); return { ok: true }; }));
    r.put('/draft', async (c) => {
      const body = await c.req.json();
      if (JSON.stringify(body).length > 200_000) return c.json({ error: 'Draft too large' }, 413);
      flow().saveDraft(date(), body);
      return c.json({ ok: true });
    });
    r.post('/check', async (c) => { const p = payloadSchema.parse(await c.req.json()); return guard(c, () => flow().evaluate(date(), p)); });
    r.post('/suggest', async (c) => {
      const { items } = z.object({ items: z.array(z.string().trim().min(1).max(300)).min(1).max(60) }).parse(await c.req.json());
      return guard(c, () => flow().suggest(date(), items));
    });
    r.post('/finish', async (c) => { const p = payloadSchema.parse(await c.req.json()); return guard(c, () => flow().finish(date(), p)); });
    r.get('/history', (c) => {
      const to = c.req.query('to') ?? date();
      return c.json(svc().history(c.req.query('from') ?? addDays(to, -13), to));
    });
  },

  claude: {
    context(ctx) {
      const sd = ctx.service<ShutdownService>('shutdown');
      const date = ctx.service<DayService>('day').planningDate();
      return { date, shutdownLoggedTonight: !!sd.completedAt(date) };
    },
    tools: [{
      name: 'get_shutdown_history',
      description: 'The nightly shutdown log: when each shutdown started and finished, minutes after the stop, stop breaks, and whether the stop held. Use it for stop-adherence questions. Default: the last 14 nights.',
      kind: 'read',
      input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      run: (ctx, i) => {
        const sd = ctx.service<ShutdownService>('shutdown');
        const to = i.to ?? ctx.service<DayService>('day').planningDate();
        const from = i.from ?? addDays(to, -13);
        const hist = new Map(sd.history(from, to).map((h) => [h.date, h]));
        const nights = sd.nights(from, to).map((n) => ({
          date: n.date,
          startedAt: hist.get(n.date)?.startedAt ?? null,
          completedAt: hist.get(n.date)?.completedAt ?? null,
          minutesAfterStop: n.minutesAfterStop,
          stopBreaks: n.breaks,
          verdict: n.held ? 'held' : n.broken ? 'broken' : n.completed ? 'logged' : 'not logged',
          acceptedRisks: sd.summary(n.date)?.risks ?? [],
        }));
        return { from, to, held: nights.filter((n) => n.verdict === 'held').length, broken: nights.filter((n) => n.verdict === 'broken').length, nights };
      },
    }],
  },
});
