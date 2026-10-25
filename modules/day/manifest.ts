/**
 * day — anchors (wake, lights-out, hard stop), fixed weekly blocks, capacity, late-night exception,
 * and the app's mode (day / evening / off-day) that every other module consults.
 */
import { z } from 'zod';
import type { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { now, today, addDays, weekday, weekStartOf, at, minutesBetween, fromISO, type ISODate } from '../../src/core/time';
import { computeAnchors, planningDate, type AnchorSettings, type Anchors } from './anchors';
import { computeCapacity, fixedIntervals, type Capacity, type FixedBlock, type LoadItem } from './capacity';
import { uid } from '../../src/core/db';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const fixedBlockSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['school', 'commute', 'lab', 'gym', 'dinner', 'sport', 'other']),
  days: z.array(z.number().int().min(1).max(7)),
  start: hhmm,
  end: hhmm,
});

const settings = z.object({
  wakeTime: hhmm.default('06:30').describe('Wake time. Lights-out and the hard stop are computed from it.'),
  weekdayWake: z.array(hhmm.nullable()).length(7).default([null, null, null, null, null, null, null])
    .describe('Per-weekday wake overrides, Monday first (e.g. early badminton days).'),
  dateWake: z.record(z.string(), hhmm).default({}).describe('One-off wake overrides by date.'),
  sleepNeedMin: z.number().int().min(480).max(600).default(480).describe('Sleep need in minutes (AASM: 8–10 h for ages 13–18).'),
  fallAsleepMin: z.number().int().min(0).max(60).default(30).describe('Minutes to fall asleep.'),
  windDownMin: z.number().int().min(30).max(120).default(60).describe('Screen-free wind-down before lights-out.'),
  schoolDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]).describe('School days. The night before one is a school night.'),
  offDay: z.number().int().min(1).max(7).default(6).describe('Weekly off-day (6 = Saturday).'),
  weekStart: z.number().int().min(1).max(7).default(7).describe('First day of the week (7 = Sunday).'),
  fixedBlocks: z.array(fixedBlockSchema).default([]).describe('Fixed weekly blocks: school, commute, lab, gym, dinner.'),
  estimateMultiplier: z.number().min(1).max(3).default(1.5).describe('Planning-fallacy multiplier for estimates.'),
  defaultEstimateMin: z.number().int().min(5).max(240).default(30).describe('Estimate used when a task has none.'),
  nearZeroMin: z.number().int().min(0).max(120).default(30).describe('Below this many free minutes a day counts as “no capacity”.'),
  lateNightMaxPerWeek: z.number().int().min(0).max(3).default(1),
  lateNightExtensionMin: z.number().int().min(15).max(90).default(60),
  lateNightDeadline: hhmm.default('16:00').describe('A late night must be declared before this time.'),
  breakStopUnlockMin: z.number().int().min(10).max(120).default(45).describe('How long work views stay open after “I’m breaking my stop”.'),
});
export type DaySettings = z.infer<typeof settings>;

export type Mode = 'day' | 'evening' | 'offday';

export interface DayState {
  now: string;
  date: ISODate;
  mode: Mode;
  workAllowed: boolean;
  unlockedUntil: string | null;
  isOffDay: boolean;
  isSchoolNight: boolean;
  shutdownAt: string | null;
  anchors: ReturnType<typeof serializeAnchors>;
  minutesToStop: number;
  minutesToLightsOut: number;
  lateNight: { date: ISODate; extensionMin: number; reason: string } | null;
  lateNightAvailable: { allowed: boolean; reason?: string };
}

export interface TimelineItem {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  source: 'fixed' | 'calendar' | 'block' | 'project';
  kind?: string;
  color?: string | null;
  calendarName?: string;
  projectId?: string | null;
  busy: boolean;
}

function serializeAnchors(a: Anchors) {
  return {
    date: a.date,
    wake: a.wake.toISO()!,
    lightsOut: a.lightsOut.toISO()!,
    hardStop: a.hardStop.toISO()!,
    effectiveStop: a.effectiveStop.toISO()!,
    nextWake: a.nextWake.toISO()!,
    schoolNight: a.schoolNight,
    lateNightMin: a.lateNightMin,
    sleepWindowMin: a.sleepWindowMin,
    math: a.math,
    notes: a.notes,
  };
}

export function createDayService(ctx: Ctx) {
  const s = () => ctx.settings.get<DaySettings>('day');
  const anchorSettings = (): AnchorSettings => s();

  const lateNightRow = (date: ISODate) =>
    ctx.db.get<{ date: string; extension_min: number; reason: string }>('SELECT * FROM late_nights WHERE date = ?', date);

  const svc = {
    settings: s,

    anchors(date: ISODate = svc.planningDate()): Anchors {
      return computeAnchors(anchorSettings(), date, lateNightRow(date)?.extension_min ?? 0);
    },
    anchorsJson(date?: ISODate) { return serializeAnchors(svc.anchors(date)); },

    planningDate(): ISODate { return planningDate(anchorSettings(), now()); },

    isOffDay(date: ISODate = svc.planningDate()) {
      return weekday(date) === s().offDay && ctx.registry.isEnabled('offday');
    },

    unlockedUntil(): DateTime | null {
      const row = ctx.db.get<{ until: string }>('SELECT until FROM stop_breaks ORDER BY at DESC LIMIT 1');
      if (!row) return null;
      const u = fromISO(row.until);
      return u.toMillis() > now().toMillis() ? u : null;
    },

    mode(): Mode {
      const date = svc.planningDate();
      const a = svc.anchors(date);
      const shutdownAt = ctx.maybe<{ completedAt(d: ISODate): string | null }>('shutdown')?.completedAt(date) ?? null;
      const t = now();
      // Before wake we're in the previous date's night by construction (planningDate), so it's evening.
      if (shutdownAt || t.toMillis() >= a.effectiveStop.toMillis() || t.toISODate() !== date) return 'evening';
      if (svc.isOffDay(date)) return 'offday';
      return 'day';
    },

    workAllowed(): boolean {
      return svc.mode() === 'day' || !!svc.unlockedUntil();
    },

    state(): DayState {
      const date = svc.planningDate();
      const a = svc.anchors(date);
      const t = now();
      const ln = lateNightRow(date);
      const mode = svc.mode();
      const unlocked = svc.unlockedUntil();
      return {
        now: t.toISO()!,
        date,
        mode,
        workAllowed: mode === 'day' || !!unlocked,
        unlockedUntil: unlocked?.toISO() ?? null,
        isOffDay: svc.isOffDay(date),
        isSchoolNight: a.schoolNight,
        shutdownAt: ctx.maybe<{ completedAt(d: ISODate): string | null }>('shutdown')?.completedAt(date) ?? null,
        anchors: serializeAnchors(a),
        minutesToStop: minutesBetween(t, a.effectiveStop),
        minutesToLightsOut: minutesBetween(t, a.lightsOut),
        lateNight: ln ? { date: ln.date, extensionMin: ln.extension_min, reason: ln.reason } : null,
        lateNightAvailable: svc.canDeclareLateNight(date),
      };
    },

    canDeclareLateNight(date: ISODate = today()): { allowed: boolean; reason?: string } {
      const st = s();
      if (lateNightRow(date)) return { allowed: false, reason: 'Already declared for tonight.' };
      if (date !== today()) return { allowed: false, reason: 'Late nights are declared on the day itself.' };
      if (now().toMillis() >= at(date, st.lateNightDeadline).toMillis()) {
        return { allowed: false, reason: `Late nights must be declared before ${at(date, st.lateNightDeadline).toFormat('h a')}.` };
      }
      const ws = weekStartOf(date, st.weekStart);
      const used = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM late_nights WHERE date >= ? AND date < ?', ws, addDays(ws, 7))!.n;
      if (used >= st.lateNightMaxPerWeek) return { allowed: false, reason: `You’ve used this week’s late night (${st.lateNightMaxPerWeek} per week).` };
      return { allowed: true };
    },

    declareLateNight(reason: string, extensionMin?: number) {
      const date = today();
      const can = svc.canDeclareLateNight(date);
      if (!can.allowed) throw Object.assign(new Error(can.reason), { status: 409 });
      const ext = Math.min(extensionMin ?? s().lateNightExtensionMin, s().lateNightExtensionMin);
      ctx.db.run('INSERT INTO late_nights (date, declared_at, extension_min, reason) VALUES (?, ?, ?, ?)', date, now().toISO(), ext, reason);
      ctx.bus.emit('day.late_night_declared', { date, extensionMin: ext, reason });
      return svc.state();
    },

    cancelLateNight(date: ISODate) {
      ctx.db.run('DELETE FROM late_nights WHERE date = ?', date);
      ctx.bus.emit('day.late_night_cancelled', { date });
    },

    /** “I’m breaking my stop.” Logged without judgment; unlocks work views for a while. */
    breakStop(view: string) {
      const until = now().plus({ minutes: s().breakStopUnlockMin });
      const date = svc.planningDate();
      ctx.db.run('INSERT INTO stop_breaks (id, date, at, until, view) VALUES (?, ?, ?, ?, ?)', uid(), date, now().toISO(), until.toISO(), view);
      ctx.bus.emit('stop.broken', { date, view });
      return svc.state();
    },
    endBreak() {
      ctx.db.run('UPDATE stop_breaks SET until = ? WHERE until > ?', now().toISO(), now().toISO());
      return svc.state();
    },
    stopBreaks(from: ISODate, to: ISODate) {
      return ctx.db.all<{ date: string; at: string; view: string }>('SELECT date, at, view FROM stop_breaks WHERE date >= ? AND date <= ? ORDER BY at', from, to);
    },

    fixedBlocks(): FixedBlock[] { return s().fixedBlocks; },

    /** Everything on the clock for a date, merged from fixed blocks, all calendars, and planned blocks. */
    timeline(date: ISODate): TimelineItem[] {
      const items: TimelineItem[] = [];
      const google = ctx.maybe<any>('google');
      const startIso = at(date, '00:00').toISO()!;
      const endIso = at(addDays(date, 1), '00:00').toISO()!;
      const events: any[] = google ? google.eventsBetween(startIso, endIso) : [];
      const projects = ctx.maybe<any>('projects');
      const visible = projects ? projects.filterForMain(events) : events;
      const coveredFixed = new Set(visible.filter((e: any) => e.marginFixedId).map((e: any) => e.marginFixedId));
      const norm = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, '').trim();
      for (const b of fixedIntervals(s().fixedBlocks, date)) {
        if (coveredFixed.has(b.id)) continue; // already on the Blocks calendar
        // Already on another calendar under the same name (e.g. "Lab (tentative)" on primary)?
        const dup = visible.some((e: any) => !e.allDay && norm(e.title).startsWith(norm(b.label))
          && fromISO(e.start).toMillis() < b.end.toMillis() && fromISO(e.end).toMillis() > b.start.toMillis());
        if (dup) continue;
        items.push({ id: `fixed:${b.id}:${date}`, title: b.label, start: b.start.toISO()!, end: b.end.toISO()!, allDay: false, source: 'fixed', kind: b.kind, busy: true });
      }
      for (const e of visible) {
        items.push({
          id: `cal:${e.calendarId}:${e.id}`, title: e.title, start: e.start, end: e.end, allDay: e.allDay,
          source: e.marginKind === 'block' ? 'block' : e.projectId ? 'project' : 'calendar',
          kind: e.marginKind ?? undefined, color: e.color, calendarName: e.calendarName, projectId: e.projectId ?? null, busy: e.busy,
        });
      }
      return items.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
    },

    capacity(date: ISODate): Capacity {
      const st = s();
      const a = svc.anchors(date);
      const busy = svc.timeline(date)
        .filter((i) => i.busy && !i.allDay && i.source !== 'block')
        .map((i) => ({ start: fromISO(i.start), end: fromISO(i.end), label: i.title, source: i.source }));
      const plan = ctx.maybe<{ loadFor(d: ISODate): LoadItem[] }>('plan');
      const items = plan ? plan.loadFor(date) : [];
      return computeCapacity({ date, wake: a.wake, stop: a.hardStop, busy, items, nearZeroMin: st.nearZeroMin });
    },

    week(start?: ISODate) {
      const ws = start ?? weekStartOf(svc.planningDate(), s().weekStart);
      const days = Array.from({ length: 7 }, (_, i) => svc.capacity(addDays(ws, i)));
      const weekdays = days.filter((d) => s().schoolDays.includes(weekday(d.date)));
      return {
        start: ws,
        days,
        freeMin: days.reduce((x, d) => x + d.freeMin, 0),
        loadMin: days.reduce((x, d) => x + d.loadMin, 0),
        weekdayFreeMin: weekdays.reduce((x, d) => x + d.freeMin, 0),
        weekdaysWithoutCapacity: weekdays.filter((d) => d.status === 'none').map((d) => d.date),
      };
    },
  };
  return svc;
}
export type DayService = ReturnType<typeof createDayService>;

export default defineModule({
  id: 'day',
  name: 'Day anchors',
  description: 'Wake time, lights-out, the hard stop, fixed blocks, capacity, and the day/evening/off-day mode.',
  core: true,
  settings,
  migrations: [
    `CREATE TABLE late_nights (date TEXT PRIMARY KEY, declared_at TEXT NOT NULL, extension_min INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '');
     CREATE TABLE stop_breaks (id TEXT PRIMARY KEY, date TEXT NOT NULL, at TEXT NOT NULL, until TEXT NOT NULL, view TEXT NOT NULL DEFAULT '');
     CREATE INDEX stop_breaks_date ON stop_breaks(date);`,
  ],
  service: createDayService,
  widgets: [
    { id: 'no-capacity', slot: 'today.banner', order: 30 },
    { id: 'horizon', slot: 'today.side', order: 0 },
    { id: 'capacity', slot: 'today.side', order: 10 },
    { id: 'timeline', slot: 'today.side', order: 20 },
  ],
  emits: ['day.started', 'day.late_night_declared', 'day.late_night_cancelled', 'stop.broken', 'mode.changed'],
  init(ctx) {
    const day = ctx.service<DayService>('day');
    // Quiet hours: no work notifications in Evening mode or on the off-day.
    ctx.notify.setGate((category) => {
      if (category !== 'work') return { allowed: true };
      const m = day.mode();
      return m === 'day' ? { allowed: true } : { allowed: false, reason: m };
    });
  },
  jobs: [
    {
      // Emit day.started at wake and mode.changed transitions so other modules can react.
      id: 'mode-watch',
      every: 1,
      run(ctx) {
        const day = ctx.service<DayService>('day');
        const date = day.planningDate();
        const mode = day.mode();
        const prev = ctx.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'day.lastMode'");
        const prevVal = prev ? JSON.parse(prev.value) : null;
        if (!prevVal || prevVal.mode !== mode || prevVal.date !== date) {
          ctx.db.run(`INSERT INTO kv (key, value, updated_at) VALUES ('day.lastMode', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            JSON.stringify({ mode, date }), new Date().toISOString());
          if (!prevVal || prevVal.date !== date) ctx.bus.emit('day.started', { date });
          ctx.bus.emit('mode.changed', { date, mode, from: prevVal?.mode ?? null });
        }
      },
    },
  ],
  routes(r, ctx) {
    const day = () => ctx.service<DayService>('day');
    r.get('/state', (c) => c.json(day().state()));
    r.get('/anchors', (c) => c.json(day().anchorsJson(c.req.query('date') ?? undefined)));
    r.post('/anchors/preview', async (c) => {
      // Onboarding: show the math for a wake time before saving it.
      const body = await c.req.json();
      const st = { ...day().settings(), ...body };
      return c.json(serializeAnchors(computeAnchors(st, body.date ?? today())));
    });
    r.get('/timeline', (c) => c.json(day().timeline(c.req.query('date') ?? day().planningDate())));
    r.get('/capacity', (c) => c.json(day().capacity(c.req.query('date') ?? day().planningDate())));
    r.get('/week', (c) => c.json(day().week(c.req.query('start') ?? undefined)));
    r.post('/late-night', async (c) => {
      const { reason, extensionMin } = await c.req.json();
      return c.json(day().declareLateNight(String(reason ?? ''), extensionMin));
    });
    r.delete('/late-night/:date', (c) => { day().cancelLateNight(c.req.param('date')); return c.json(day().state()); });
    r.post('/break-stop', async (c) => c.json(day().breakStop(String((await c.req.json()).view ?? ''))));
    r.post('/end-break', (c) => c.json(day().endBreak()));
    r.get('/stop-breaks', (c) => c.json(day().stopBreaks(c.req.query('from') ?? addDays(today(), -28), c.req.query('to') ?? today())));
  },
  claude: {
    context(ctx) {
      const st = ctx.service<DayService>('day').state();
      return { date: st.date, mode: st.mode, hardStop: st.anchors.hardStop, lightsOut: st.anchors.lightsOut, schoolNight: st.isSchoolNight };
    },
    tools: [
      {
        name: 'get_capacity',
        description: 'Free minutes vs planned load (estimates ×1.5) for a date or the current week. Use before proposing any plan.',
        kind: 'read',
        input: z.object({ date: z.string().optional(), week: z.boolean().optional() }),
        run: (ctx, i) => {
          const day = ctx.service<DayService>('day');
          if (i.week) { const w = day.week(); return { ...w, days: w.days.map(({ busy, gaps, ...d }) => d) }; }
          return day.capacity(i.date ?? day.planningDate());
        },
      },
      {
        name: 'get_anchors',
        description: 'Wake, hard stop and lights-out for a date. Nothing may be scheduled after the hard stop.',
        kind: 'read',
        input: z.object({ date: z.string().optional() }),
        run: (ctx, i) => ctx.service<DayService>('day').anchorsJson(i.date),
      },
    ],
  },
});
