/**
 * checkin — the morning check-in (bedtime, wake, energy) and sleep. Under 30 seconds.
 * Custom metrics are rows in `checkin_metrics`, so adding one needs no code.
 * Sleep, energy and mood are sensitive: nothing here reaches Claude unless ai.shareWellbeing is on.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { j } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, today, addDays, at, fromISO, fmtDuration, type ISODate } from '../../src/core/time';
import {
  computeSleep, napNote, shortNights, weekendDrift, energyTrend, lowSleepMostNights, SLEEP_RULES, type Night,
} from './sleep';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const settings = z.object({
  caffeineReminder: z.boolean().default(true).describe('A daily reminder at the caffeine cutoff.'),
  caffeineCutoff: hhmm.default('14:00').describe('Last caffeine of the day. About 6 hours before bed keeps sleep intact (Drake 2013).'),
});
type Settings = z.infer<typeof settings>;

export interface CheckinEntry {
  date: ISODate;
  /** ISO instant, zoned. */
  bedtime: string;
  /** ISO instant, zoned. */
  wakeTime: string;
  sleepMin: number;
  energy: number;
  napMin: number | null;
  napStart: string | null;
  extras: Record<string, number | boolean>;
}
export type MetricType = '0-10' | 'yes/no' | 'number';
export interface Metric { key: string; label: string; type: MetricType }

const submitSchema = z.object({
  date: isoDate.optional(),
  bedtime: hhmm,
  wakeTime: hhmm,
  energy: z.number().int().min(0).max(10),
  napMin: z.number().int().min(0).max(240).nullish(),
  napStart: hhmm.nullish(),
  extras: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
});
const baselineSchema = z.object({
  bedtime: hhmm,
  wakeTime: hhmm,
  caffeineTime: hhmm.nullish(),
  energy: z.number().int().min(0).max(10),
  dread: z.number().int().min(0).max(10),
  effective: z.number().int().min(0).max(10),
  redFlags: z.array(z.string()).default([]),
  phase1Start: isoDate.nullish(),
});
export type BaselineInput = z.input<typeof baselineSchema>;
const metricSchema = z.object({ label: z.string().trim().min(1).max(40), type: z.enum(['0-10', 'yes/no', 'number']) });

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Claude sees check-in data only when the person has turned wellbeing sharing on (missing = off). */
export const sharesWellbeing = (ctx: Ctx) => ctx.settings.get<any>('ai')?.shareWellbeing === true;

export function createCheckinService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('checkin');
  const rowToEntry = (r: any): CheckinEntry => ({
    date: r.date, bedtime: r.bedtime, wakeTime: r.wake_time, sleepMin: r.sleep_min, energy: r.energy,
    napMin: r.nap_min ?? null, napStart: r.nap_start ?? null, extras: j(r.extras, {}),
  });
  const toNight = (e: CheckinEntry): Night => ({ date: e.date, wakeTime: e.wakeTime, sleepMin: e.sleepMin, energy: e.energy });

  const svc = {
    settings: s,

    entry(date: ISODate): CheckinEntry | null {
      const r = ctx.db.get('SELECT * FROM checkins WHERE date = ?', date);
      return r ? rowToEntry(r) : null;
    },
    entries(from: ISODate, to: ISODate): CheckinEntry[] {
      return ctx.db.all('SELECT * FROM checkins WHERE date >= ? AND date <= ? ORDER BY date', from, to).map(rowToEntry);
    },
    /** The last n nights of sleep, newest first. */
    sleepNights(n: number): { date: ISODate; bedtime: string; wakeTime: string; sleepMin: number }[] {
      return ctx.db.all('SELECT * FROM checkins ORDER BY date DESC LIMIT ?', Math.max(0, Math.floor(n)))
        .map(rowToEntry).map((e) => ({ date: e.date, bedtime: e.bedtime, wakeTime: e.wakeTime, sleepMin: e.sleepMin }));
    },
    /** Entries over the last `days` days up to today, as the plain shape the rule math uses. */
    nights(days: number): Night[] {
      return svc.entries(addDays(today(), -(days - 1)), today()).map(toNight);
    },

    metrics(): Metric[] {
      return ctx.db.all('SELECT key, label, type FROM checkin_metrics WHERE archived = 0 ORDER BY position, created_at') as Metric[];
    },
    addMetric(input: { label: string; type: MetricType }): Metric {
      const { label, type } = metricSchema.parse(input);
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'metric';
      let key = base, i = 2;
      while (ctx.db.get('SELECT 1 FROM checkin_metrics WHERE key = ?', key)) key = `${base}_${i++}`;
      const pos = (ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM checkin_metrics')?.n ?? 0);
      ctx.db.run('INSERT INTO checkin_metrics (key, label, type, position, archived, created_at) VALUES (?, ?, ?, ?, 0, ?)', key, label, type, pos, now().toISO());
      return { key, label, type };
    },
    /** Hides a metric from the form. Past answers stay in the entries. */
    archiveMetric(key: string) {
      ctx.db.run('UPDATE checkin_metrics SET archived = 1 WHERE key = ?', key);
    },

    /** What the form starts with: last night's lights-out (or the previous entry) and today's wake setting. */
    prefill(date: ISODate = today()): { bedtime: string; wakeTime: string } {
      const day = ctx.maybe<any>('day');
      const prev = addDays(date, -1);
      let bedtime: string | undefined;
      try { bedtime = day?.anchors(prev).lightsOut.toFormat('HH:mm'); } catch { /* day module unavailable */ }
      if (!bedtime) {
        const last = ctx.db.get('SELECT bedtime FROM checkins WHERE date < ? ORDER BY date DESC LIMIT 1', date);
        if (last) bedtime = fromISO(last.bedtime).toFormat('HH:mm');
      }
      bedtime ??= kvGet<any>(ctx.db, 'checkin.baseline', null)?.bedtime ?? '22:30';
      let wakeTime: string | undefined;
      try { wakeTime = day?.anchors(date).wake.toFormat('HH:mm'); } catch { /* ignore */ }
      wakeTime ??= '06:30';
      return { bedtime, wakeTime };
    },

    /** Save (or replace) the check-in for a date and announce it. */
    submit(raw: z.input<typeof submitSchema>): CheckinEntry {
      const input = submitSchema.parse(raw);
      const date = input.date ?? today();
      if (date > today()) throw bad('A check-in can’t be for a day that hasn’t happened yet.');
      const calc = computeSleep(date, input.bedtime, input.wakeTime);
      const known = new Map(svc.metrics().map((m) => [m.key, m]));
      const extras: Record<string, number | boolean> = {};
      for (const [k, v] of Object.entries(input.extras ?? {})) {
        const m = known.get(k);
        if (!m) continue; // unknown or archived metric
        if (m.type === 'yes/no') extras[k] = !!v;
        else if (m.type === '0-10') {
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10) throw bad(`${m.label} is a 0 to 10 answer.`);
          extras[k] = v;
        } else {
          if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${m.label} needs a number.`);
          extras[k] = v;
        }
      }
      ctx.db.run(`INSERT INTO checkins (date, bedtime, wake_time, sleep_min, energy, nap_min, nap_start, extras, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET bedtime = excluded.bedtime, wake_time = excluded.wake_time, sleep_min = excluded.sleep_min,
          energy = excluded.energy, nap_min = excluded.nap_min, nap_start = excluded.nap_start, extras = excluded.extras, submitted_at = excluded.submitted_at`,
        date, calc.bedtime.toISO(), calc.wake.toISO(), calc.sleepMin, input.energy, input.napMin || null, input.napMin ? input.napStart ?? null : null,
        JSON.stringify(extras), now().toISO());
      ctx.bus.emit('checkin.submitted', { date, sleepMin: calc.sleepMin, energy: input.energy });
      return svc.entry(date)!;
    },

    /** Everything the form and the summary line need for a date. */
    state(date: ISODate = today()) {
      const entry = svc.entry(date);
      return {
        date,
        submitted: !!entry,
        entry,
        summary: entry ? `${fmtDuration(entry.sleepMin)} · energy ${entry.energy}` : null,
        napNote: entry ? napNote(entry.napMin, entry.napStart) : null,
        prefill: svc.prefill(date),
        metrics: svc.metrics(),
      };
    },

    baseline(): (z.output<typeof baselineSchema> & { savedAt: string }) | null {
      return kvGet(ctx.db, 'checkin.baseline', null);
    },
    /** Onboarding step 8: record where things stand today. Any red flag opens Get help. */
    saveBaseline(raw: BaselineInput) {
      const b = baselineSchema.parse(raw);
      kvSet(ctx.db, 'checkin.baseline', { ...b, savedAt: now().toISO() });
      if (b.phase1Start) ctx.settings.set('phases', { phase1Start: b.phase1Start });
      ctx.bus.emit('checkin.baseline_saved', { phase1Start: b.phase1Start ?? null });
      let openedHelp = false;
      if (b.redFlags.length > 0) {
        const help = ctx.maybe<{ open(reason: string): unknown }>('gethelp');
        if (help) { help.open('baseline'); openedHelp = true; }
      }
      return { ok: true, openedHelp };
    },
  };
  return svc;
}
export type CheckinService = ReturnType<typeof createCheckinService>;

const svcOf = (ctx: Ctx) => ctx.service<CheckinService>('checkin');

export default defineModule({
  id: 'checkin',
  name: 'Morning check-in',
  description: 'Bedtime, wake time and energy in under 30 seconds, plus sleep rules and custom metrics.',
  settings,
  migrations: [
    `CREATE TABLE checkins (
       date TEXT PRIMARY KEY,
       bedtime TEXT NOT NULL,
       wake_time TEXT NOT NULL,
       sleep_min INTEGER NOT NULL,
       energy INTEGER NOT NULL,
       nap_min INTEGER,
       nap_start TEXT,
       extras TEXT NOT NULL DEFAULT '{}',
       submitted_at TEXT NOT NULL
     );
     CREATE TABLE checkin_metrics (
       key TEXT PRIMARY KEY,
       label TEXT NOT NULL,
       type TEXT NOT NULL,
       position INTEGER NOT NULL DEFAULT 0,
       archived INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL
     );`,
  ],
  service: createCheckinService,
  emits: ['checkin.submitted', 'checkin.baseline_saved'],
  widgets: [
    { id: 'checkin', slot: 'today.main', order: 0 },
    { id: 'checkin', slot: 'offday', order: 5 },
  ],
  notifications(ctx, date) {
    const st = ctx.settings.get<Settings>('checkin');
    if (!st.caffeineReminder) return [];
    return [{
      key: `checkin.caffeine:${date}`,
      at: at(date, st.caffeineCutoff),
      title: 'Caffeine cutoff',
      body: 'About 6 hours before bed keeps sleep intact (Drake 2013).',
      category: 'wellbeing',
    }];
  },
  routes(r, ctx) {
    r.get('/today', (c) => c.json(svcOf(ctx).state()));
    r.get('/state', (c) => c.json(svcOf(ctx).state(c.req.query('date') ?? today())));
    r.get('/entry/:date', (c) => c.json(svcOf(ctx).entry(c.req.param('date'))));
    r.get('/entries', (c) => c.json(svcOf(ctx).entries(c.req.query('from') ?? addDays(today(), -30), c.req.query('to') ?? today())));
    r.post('/submit', async (c) => c.json(svcOf(ctx).submit(await c.req.json())));
    r.post('/baseline', async (c) => c.json(svcOf(ctx).saveBaseline(await c.req.json())));
    r.get('/baseline', (c) => c.json(svcOf(ctx).baseline()));
    r.get('/metrics', (c) => c.json(svcOf(ctx).metrics()));
    r.post('/metrics', async (c) => c.json(svcOf(ctx).addMetric(await c.req.json())));
    r.delete('/metrics/:key', (c) => { svcOf(ctx).archiveMetric(c.req.param('key')); return c.json({ ok: true }); });
    r.get('/rules', (c) => c.json(SLEEP_RULES));
  },
  rules: {
    conditions: [
      {
        id: 'sleep.short_nights',
        label: 'Short sleep, nights in a row',
        description: 'Sleep was under a number of hours for several nights running.',
        params: z.object({ hours: z.number().min(3).max(12).default(7), nights: z.number().int().min(2).max(14).default(3) }),
        evaluate: (ctx, p) => shortNights(svcOf(ctx).sleepNights(p.nights), p.hours, p.nights, today()),
      },
      {
        id: 'sleep.weekend_drift',
        label: 'Weekend wake time drifting later',
        description: 'Weekend wake times are later than school-day wake times by more than a set number of minutes.',
        params: z.object({ maxMin: z.number().int().min(15).max(300).default(90) }),
        evaluate: (ctx, p) => {
          const school: number[] = ctx.maybe<any>('day')?.settings().schoolDays ?? [1, 2, 3, 4, 5];
          return weekendDrift(svcOf(ctx).nights(14), school, p.maxMin);
        },
      },
      {
        id: 'checkin.energy_trend',
        label: 'Energy trend',
        description: 'Weekly average energy is going up, staying flat, or going down over a number of weeks.',
        params: z.object({
          direction: z.enum(['up', 'flat', 'down']).default('flat'),
          weeks: z.number().int().min(2).max(8).default(3),
          minChange: z.number().min(0.1).max(5).default(1).describe('Points of weekly average that count as a change.'),
          below: z.number().min(0).max(10).default(10).describe('Only when the latest weekly average is below this (10 = always).'),
        }),
        evaluate: (ctx, p) => energyTrend(svcOf(ctx).nights(7 * p.weeks), p.direction, p.weeks, today(), p.minChange, p.below),
      },
      {
        id: 'checkin.low_sleep_most_nights',
        label: 'Short sleep on most nights',
        description: 'Most check-ins in the last 14 days were under a number of hours.',
        params: z.object({ hours: z.number().min(3).max(12).default(6) }),
        evaluate: (ctx, p) => lowSleepMostNights(svcOf(ctx).nights(14), p.hours, today()),
      },
    ],
  },
  claude: {
    // Private by default. Nothing about sleep, energy or mood goes to Claude unless the person allowed it.
    context(ctx) {
      if (!sharesWellbeing(ctx)) return null;
      const svc = svcOf(ctx);
      const last = svc.entries(addDays(today(), -6), today());
      return { lastWeek: last.map((e) => ({ date: e.date, sleepMin: e.sleepMin, energy: e.energy })) };
    },
    tools: [{
      name: 'get_checkins',
      description: 'Morning check-ins (sleep minutes, energy 0-10, custom metrics) for a date range. Only available when the person shares wellbeing data with Claude.',
      kind: 'read',
      input: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
      run: (ctx, i) => {
        if (!sharesWellbeing(ctx)) return { available: false };
        return svcOf(ctx).entries(i.from ?? addDays(today(), -13), i.to ?? today())
          .map((e) => ({ date: e.date, sleepMin: e.sleepMin, energy: e.energy, napMin: e.napMin, extras: e.extras }));
      },
    }],
  },
});
