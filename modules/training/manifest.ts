/**
 * training — gym and badminton log with a weekly check for overtraining signs (SPEC 4.12).
 * At least one rest day a week (ideally the off-day), a deload in Stabilize, and a lighter session
 * after a short night. Two or more warning signs suggest a deload or rest; never trade sleep for training.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, today, addDays, weekStartOf, getZone, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const SHORT_SLEEP_MIN = 420;

export interface Lift { name: string; weight: number; reps: number }
export interface TrainingSession {
  id: string; kind: 'gym' | 'badminton'; date: ISODate; minutes: number; rpe: number;
  lifts: Lift[]; soreness: number | null; dreaded: boolean; note: string;
}
export interface Sign { id: 'rhr' | 'lifts' | 'soreness' | 'dread'; label: string; detail: string }
export interface Warnings { signs: Sign[]; suggest: boolean }

export const sessionInput = z.object({
  kind: z.enum(['gym', 'badminton']),
  date: isoDate.optional(),
  minutes: z.number().int().min(1).max(360),
  rpe: z.number().int().min(1).max(10),
  lifts: z.array(z.object({ name: z.string().trim().min(1).max(60), weight: z.number().min(0).max(1000), reps: z.number().int().min(1).max(100) })).max(20).default([]),
  soreness: z.number().int().min(0).max(10).nullable().default(null),
  dreaded: z.boolean().default(false),
  note: z.string().trim().max(240).default(''),
});

/** Best-effort strength score: estimated one-rep max (Epley); bodyweight lifts fall back to reps. */
const score = (l: Lift) => (l.weight > 0 ? l.weight * (1 + l.reps / 30) : l.reps);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The weekly check. Pure, so it can be tested without a database.
 *  - rhr: the latest weekly resting heart rate is 5+ bpm above the average of the 4 readings before it
 *  - lifts: a lift logged 2+ times in the last 14 days with no new best against everything before
 *  - soreness: mean soreness over the last 7 days is 6+ (2+ readings)
 *  - dread: 2+ sessions dreaded in the last 7 days
 * Two or more signs suggest a deload or rest.
 */
export function detectWarnings(input: { date: ISODate; sessions: Pick<TrainingSession, 'date' | 'soreness' | 'dreaded' | 'lifts'>[]; rhr: { week: ISODate; bpm: number }[] }): Warnings {
  const { date } = input;
  const signs: Sign[] = [];
  const week = input.sessions.filter((s) => s.date > addDays(date, -7) && s.date <= date);

  const rhr = [...input.rhr].sort((a, b) => (a.week < b.week ? -1 : 1));
  const latest = rhr[rhr.length - 1];
  const prior = rhr.slice(-5, -1);
  if (latest && latest.week > addDays(date, -14) && prior.length >= 2) {
    const avg = mean(prior.map((r) => r.bpm));
    if (latest.bpm - avg >= 5) signs.push({ id: 'rhr', label: 'Resting heart rate up', detail: `${latest.bpm} bpm, ${Math.round(latest.bpm - avg)} above your ${prior.length}-week average of ${Math.round(avg)}.` });
  }

  const lifts = new Map<string, { name: string; recent: number[]; before: number[] }>();
  for (const s of input.sessions) {
    if (s.date > date) continue;
    for (const l of s.lifts) {
      const k = l.name.trim().toLowerCase();
      const e = lifts.get(k) ?? { name: l.name.trim(), recent: [], before: [] };
      (s.date > addDays(date, -14) ? e.recent : e.before).push(score(l));
      lifts.set(k, e);
    }
  }
  // ponytail: one best-of comparison per lift; a per-set progression model if this proves too blunt
  const stalled = [...lifts.values()].filter((e) => e.recent.length >= 2 && e.before.length >= 1 && Math.max(...e.recent) <= Math.max(...e.before));
  if (stalled.length) signs.push({ id: 'lifts', label: 'Lifts stalled', detail: `No new best in 2 weeks: ${stalled.map((e) => e.name).join(', ')}.` });

  const sore = week.map((s) => s.soreness).filter((x): x is number => x != null);
  if (sore.length >= 2 && mean(sore) >= 6) signs.push({ id: 'soreness', label: 'Persistent soreness', detail: `Soreness averaged ${mean(sore).toFixed(1)} of 10 over ${sore.length} sessions this week.` });

  const dreaded = week.filter((s) => s.dreaded).length;
  if (dreaded >= 2) signs.push({ id: 'dread', label: 'Dreading sessions', detail: `${dreaded} sessions dreaded this week.` });

  return { signs, suggest: signs.length >= 2 };
}

const dayName = (d: ISODate) => DateTime.fromISO(d, { zone: 'UTC' }).toFormat('cccc');

const err = (message: string, status = 400) => Object.assign(new Error(message), { status });
interface Row { id: string; kind: 'gym' | 'badminton'; date: string; minutes: number; rpe: number; lifts: string; soreness: number | null; dreaded: number; note: string }
const toSession = (r: Row): TrainingSession => ({ id: r.id, kind: r.kind, date: r.date, minutes: r.minutes, rpe: r.rpe, lifts: JSON.parse(r.lifts), soreness: r.soreness, dreaded: !!r.dreaded, note: r.note });

export function createTrainingService(ctx: Ctx) {
  const day = () => ctx.maybe<DayService>('day');
  const currentDate = (): ISODate => day()?.planningDate() ?? today();
  const weekStart = () => day()?.settings().weekStart ?? 7;
  const offDay = () => day()?.settings().offDay ?? 6;

  const svc = {
    currentDate,
    /** Sessions between two dates, inclusive, oldest first. */
    sessions(from: ISODate, to: ISODate): TrainingSession[] {
      return ctx.db.all<Row>('SELECT * FROM training_sessions WHERE date >= ? AND date <= ? ORDER BY date, created_at', from, to).map(toSession);
    },
    add(input: z.input<typeof sessionInput>): TrainingSession {
      const i = sessionInput.parse(input);
      const id = uid();
      ctx.db.run(
        'INSERT INTO training_sessions (id, kind, date, minutes, rpe, lifts, soreness, dreaded, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, i.kind, i.date ?? currentDate(), i.minutes, i.rpe, JSON.stringify(i.kind === 'gym' ? i.lifts : []), i.soreness, i.dreaded ? 1 : 0, i.note, now().toISO(),
      );
      ctx.bus.emit('training.logged', { id, kind: i.kind, date: i.date ?? currentDate(), minutes: i.minutes, rpe: i.rpe });
      return toSession(ctx.db.get<Row>('SELECT * FROM training_sessions WHERE id = ?', id)!);
    },
    remove(id: string) {
      if (!ctx.db.run('DELETE FROM training_sessions WHERE id = ?', id).changes) throw err('That session was already removed.', 404);
    },

    /** Weekly resting heart rate, keyed by the first day of the week. */
    setRhr(bpm: number, week: ISODate = weekStartOf(currentDate(), weekStart())) {
      if (!Number.isFinite(bpm) || bpm < 25 || bpm > 140) throw err('Enter a resting heart rate between 25 and 140.');
      ctx.db.run('INSERT INTO training_rhr (week, bpm, logged_at) VALUES (?, ?, ?) ON CONFLICT(week) DO UPDATE SET bpm = excluded.bpm, logged_at = excluded.logged_at', week, Math.round(bpm), now().toISO());
    },
    rhr(weeks = 8): { week: ISODate; bpm: number }[] {
      return ctx.db.all<{ week: string; bpm: number }>('SELECT week, bpm FROM training_rhr ORDER BY week DESC LIMIT ?', weeks).reverse();
    },

    warnings(date: ISODate = currentDate()): Warnings {
      return detectWarnings({ date, sessions: svc.sessions(addDays(date, -120), date), rhr: svc.rhr(5) });
    },

    /** Rest days this week, ideally the off-day. */
    rest(date: ISODate = currentDate()) {
      const ws = weekStartOf(date, weekStart());
      const week = svc.sessions(ws, addDays(ws, 6));
      const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).map((d) => ({ date: d, trained: week.some((s) => s.date === d), future: d > date }));
      const off = days.find((d) => DateTime.fromISO(d.date, { zone: 'UTC' }).weekday === offDay())!;
      const restDays = days.filter((d) => d.date < date && !d.trained).length;
      let message: string | null = null;
      if (off.trained) message = `You trained on your off-day, ${dayName(off.date)}. It works best as the rest day.`;
      else if (restDays === 0) {
        message = off.date >= date ? `No rest day in yet this week. Keep ${off.date === date ? 'today' : dayName(off.date)}, your off-day, clear.` : 'No rest day this week yet. Take the next day off.';
      }
      return { weekStart: ws, days, restDays, offDay: off.date, offDayTrained: off.trained, message };
    },

    overview(date: ISODate = currentDate()) {
      const rest = svc.rest(date);
      const sleepMin = ctx.maybe<any>('checkin')?.entry(date)?.sleepMin ?? null;
      const lighter = sleepMin != null && sleepMin < SHORT_SLEEP_MIN;
      const stabilize = ctx.maybe<any>('phases')?.current().phase === 'stabilize';
      const week = svc.sessions(rest.weekStart, addDays(rest.weekStart, 6));
      const rhr = svc.rhr(8);
      const prior = rhr.slice(-5, -1);
      return {
        date, rest,
        today: {
          sleepMin, lighter,
          message: lighter ? 'Under 7 hours of sleep. Go lighter today: shorter, easier, or skip it. Sleep comes before training.' : null,
        },
        deload: {
          active: stabilize,
          note: stabilize ? 'Stabilize phase: cut volume by about a third and keep the weights the same. Recovery comes first.' : null,
        },
        warnings: svc.warnings(date),
        rhr: { weeks: rhr, thisWeek: rhr.find((r) => r.week === rest.weekStart)?.bpm ?? null, avg: prior.length >= 2 ? Math.round(mean(prior.map((r) => r.bpm))) : null },
        week: { sessions: week.length, minutes: week.reduce((s, x) => s + x.minutes, 0) },
        recent: svc.sessions(addDays(date, -21), date).reverse(),
        zone: getZone(),
      };
    },
  };
  return svc;
}
export type TrainingService = ReturnType<typeof createTrainingService>;

export default defineModule({
  id: 'training',
  name: 'Training',
  description: 'Log gym and badminton sessions, keep a rest day each week, and catch overtraining signs early.',
  migrations: [
    `CREATE TABLE training_sessions (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       date TEXT NOT NULL,
       minutes INTEGER NOT NULL,
       rpe INTEGER NOT NULL,
       lifts TEXT NOT NULL DEFAULT '[]',
       soreness INTEGER,
       dreaded INTEGER NOT NULL DEFAULT 0,
       note TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL
     );
     CREATE INDEX training_sessions_date ON training_sessions(date);
     CREATE TABLE training_rhr (week TEXT PRIMARY KEY, bpm INTEGER NOT NULL, logged_at TEXT NOT NULL);`,
  ],
  service: createTrainingService,
  emits: ['training.logged'],
  routes(r, ctx) {
    const svc = () => ctx.service<TrainingService>('training');
    r.get('/overview', (c) => c.json(svc().overview(c.req.query('date') ?? undefined)));
    r.get('/sessions', (c) => c.json(svc().sessions(c.req.query('from') ?? '0000-01-01', c.req.query('to') ?? '9999-12-31')));
    r.post('/sessions', async (c) => c.json(svc().add(await c.req.json())));
    r.delete('/sessions/:id', (c) => { svc().remove(c.req.param('id')); return c.json({ ok: true }); });
    r.put('/rhr', async (c) => {
      const b = z.object({ bpm: z.number(), week: isoDate.optional() }).parse(await c.req.json());
      svc().setRhr(b.bpm, b.week);
      return c.json({ ok: true });
    });
  },
  nav: [{ id: 'training', label: 'Training', icon: 'Dumbbell', path: '/training', section: 'main', order: 45, work: false }],
  widgets: [{ id: 'today', slot: 'today.side', order: 40 }],
  claude: {
    context: (ctx) => {
      const t = ctx.service<TrainingService>('training');
      const w = t.warnings();
      return { warningSigns: w.signs.map((s) => s.label), suggestDeload: w.suggest, restDaysSoFar: t.rest().restDays };
    },
  },
});
