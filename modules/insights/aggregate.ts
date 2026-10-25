/**
 * Insights aggregation: pure functions over plain inputs (SPEC 6). No database, no services, so every
 * number on the screen can be checked against a fixture. Each section also carries one plain summary
 * line that states what is true, without judgment ("Averaged 7h 40m. Target is 8–10 h.").
 */
import { DateTime } from 'luxon';
import { addDays, fmtDuration, fromISO, weekStartOf, weekday, type ISODate } from '../../src/core/time';

export const SLEEP_TARGET_MIN: [number, number] = [480, 600];
/** AASM-style guideline from the spec: weekend wake no more than 1.5 h later than weekdays. */
export const WAKE_DRIFT_GUIDE_MIN = 90;

// ---------------------------------------------------------------- shared helpers
export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Population standard deviation; null with fewer than 2 values. */
export function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}
const round = (n: number | null, digits = 0) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (d: ISODate) => fromISO(d).toFormat('MMM d');
const hm = (min: number) => fmtDuration(min);
/** "6:45 AM" from minutes after midnight. */
export const clockLabel = (min: number) => {
  const m = Math.round(min);
  const h24 = Math.floor(m / 60) % 24;
  return `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};

/** Minutes after midnight for 'HH:MM' or a zoned ISO instant; null when it isn't a clock reading. */
export function clockMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (t) return Number(t[1]) * 60 + Number(t[2]);
  const d = fromISO(v);
  return d.isValid ? d.hour * 60 + d.minute : null;
}

/** The weeks shown: week starts from the oldest to the one containing `to`. */
export function weekStartsFor(to: ISODate, weeks: number, weekStart = 7): ISODate[] {
  const last = weekStartOf(to, weekStart);
  return Array.from({ length: weeks }, (_, i) => addDays(last, -(weeks - 1 - i) * 7));
}
export const weekOf = (date: ISODate, weekStart = 7) => weekStartOf(date, weekStart);
export const eachDate = (from: ISODate, to: ISODate): ISODate[] => {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

// ---------------------------------------------------------------- sleep and wake consistency
export interface CheckinLike { date: ISODate; bedtime?: unknown; wakeTime?: unknown; sleepMin?: unknown; energy?: unknown }
export interface Night { date: ISODate; sleepMin: number | null; wakeMin: number | null; energy: number | null; weekend: boolean }

export function toNights(entries: CheckinLike[]): Night[] {
  const byDate = new Map<ISODate, Night>();
  for (const e of entries) {
    let sleep = num(e.sleepMin);
    if (sleep === null || sleep <= 0) {
      // Derive from the clock readings when the stored duration is missing.
      const bed = clockMinutes(e.bedtime), wake = clockMinutes(e.wakeTime);
      sleep = bed !== null && wake !== null ? (((wake - bed) % 1440) + 1440) % 1440 || null : null;
    }
    byDate.set(e.date, { date: e.date, sleepMin: sleep, wakeMin: clockMinutes(e.wakeTime), energy: num(e.energy), weekend: weekday(e.date) >= 6 });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface SleepSection {
  /** Nights with any data, oldest first (chart input). */
  nights: Night[];
  targetMin: [number, number];
  avgSleepMin: number | null;
  sleepNights: number;
  inTargetNights: number;
  wake: { n: number; avgMin: number | null; sdMin: number | null; weekdayAvgMin: number | null; weekendAvgMin: number | null; driftMin: number | null };
  summary: { sleep: string; wake: string };
}

export function summarizeSleep(entries: CheckinLike[], target = SLEEP_TARGET_MIN): SleepSection {
  const nights = toNights(entries).filter((n) => n.sleepMin !== null || n.wakeMin !== null);
  const sleeps = nights.flatMap((n) => (n.sleepMin === null ? [] : [n.sleepMin]));
  const wakes = nights.filter((n) => n.wakeMin !== null);
  const weekday_ = wakes.filter((n) => !n.weekend).map((n) => n.wakeMin!);
  const weekend_ = wakes.filter((n) => n.weekend).map((n) => n.wakeMin!);
  const avg = mean(sleeps);
  const inTarget = sleeps.filter((m) => m >= target[0] && m <= target[1]).length;
  const wakeAvg = mean(wakes.map((n) => n.wakeMin!));
  const sd = stdDev(wakes.map((n) => n.wakeMin!));
  const wdAvg = mean(weekday_), weAvg = mean(weekend_);
  const drift = wdAvg !== null && weAvg !== null ? weAvg - wdAvg : null;

  const targetText = `${target[0] / 60}–${target[1] / 60} h`;
  const sleepLine = sleeps.length === 0
    ? 'No sleep has been logged in this range yet.'
    : `Averaged ${hm(avg!)} across ${plural(sleeps.length, 'night')}. Target is ${targetText}; ${plural(inTarget, 'night')} landed inside it.`;
  let wakeLine: string;
  if (wakes.length < 2 || sd === null) wakeLine = 'Wake times need at least 2 check-ins before a pattern shows.';
  else {
    wakeLine = `Wake time varied by ±${Math.round(sd)} min (standard deviation), averaging ${clockLabel(wakeAvg!)}.`;
    if (drift !== null) {
      const d = Math.round(Math.abs(drift));
      wakeLine += d < 5 ? ' Weekends and weekdays matched.'
        : ` Weekends ran ${hm(d)} ${drift > 0 ? 'later' : 'earlier'} than weekdays; the guideline is ${hm(WAKE_DRIFT_GUIDE_MIN)} or less.`;
    }
  }
  return {
    nights, targetMin: target, avgSleepMin: round(avg), sleepNights: sleeps.length, inTargetNights: inTarget,
    wake: { n: wakes.length, avgMin: round(wakeAvg), sdMin: round(sd, 1), weekdayAvgMin: round(wdAvg), weekendAvgMin: round(weAvg), driftMin: round(drift) },
    summary: { sleep: sleepLine, wake: wakeLine },
  };
}

// ---------------------------------------------------------------- energy and the three weekly ratings
export interface ScoreRow { weekStart: ISODate; energy: number | null; dread: number | null; effective: number | null; sleepAvgMin: number | null; stopBreaks: number | null }
export interface EnergySection {
  weekly: ScoreRow[];
  daily: { date: ISODate; energy: number }[];
  summary: { weekly: string; daily: string };
}

export function summarizeEnergy(scores: Partial<ScoreRow>[], nights: Night[]): EnergySection {
  const weekly: ScoreRow[] = scores
    .filter((s): s is Partial<ScoreRow> & { weekStart: ISODate } => typeof s.weekStart === 'string')
    .map((s) => ({ weekStart: s.weekStart, energy: num(s.energy), dread: num(s.dread), effective: num(s.effective), sleepAvgMin: num(s.sleepAvgMin), stopBreaks: num(s.stopBreaks) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const rated = weekly.filter((w) => w.energy !== null || w.dread !== null || w.effective !== null);
  const fmt = (w: ScoreRow) => [['energy', w.energy], ['dread', w.dread], ['effective', w.effective]]
    .map(([k, v]) => `${k} ${v === null ? 'not rated' : v}`).join(', ');
  let weeklyLine: string;
  if (!rated.length) weeklyLine = 'No weekly ratings yet. They are scored in the weekly review.';
  else {
    const last = rated[rated.length - 1], first = rated[0];
    weeklyLine = rated.length === 1
      ? `Week of ${shortDate(last.weekStart)}: ${fmt(last)}.`
      : `Week of ${shortDate(last.weekStart)}: ${fmt(last)}. Week of ${shortDate(first.weekStart)}: ${fmt(first)}.`;
  }
  const daily = nights.flatMap((n) => (n.energy === null ? [] : [{ date: n.date, energy: n.energy }]));
  const es = daily.map((d) => d.energy);
  const dailyLine = !es.length ? 'No daily energy check-ins in this range yet.'
    : `Check-in energy averaged ${round(mean(es), 1)} across ${plural(es.length, 'day')} (low ${Math.min(...es)}, high ${Math.max(...es)}).`;
  return { weekly, daily, summary: { weekly: weeklyLine, daily: dailyLine } };
}

// ---------------------------------------------------------------- stop adherence
export interface StopWeek { weekStart: ISODate; held: number; broken: number; unlogged: number }
export interface StopSection {
  weeks: StopWeek[];
  held: number; broken: number; unlogged: number; nights: number; breaks: number; shutdowns: number;
  summary: string;
}

/**
 * One row per night in [from, lastNight]. A night is
 *   broken   - any "I'm breaking my stop" on that date (even if the shutdown was completed first),
 *   held     - a completed shutdown and no break,
 *   unlogged - neither (no shutdown, no break). Not counted against anything; it is a gap in the data.
 */
export function stopAdherence(args: {
  from: ISODate; today: ISODate; weekStarts: ISODate[]; weekStart?: number;
  shutdowns: { date: ISODate; completed: boolean }[];
  breaks: { date: ISODate }[];
}): StopSection {
  const done = new Set(args.shutdowns.filter((s) => s.completed).map((s) => s.date));
  const broke = new Set(args.breaks.map((b) => b.date));
  // Today's night isn't over until something is recorded for it.
  const last = done.has(args.today) || broke.has(args.today) ? args.today : addDays(args.today, -1);
  const weeks = new Map<ISODate, StopWeek>(args.weekStarts.map((w) => [w, { weekStart: w, held: 0, broken: 0, unlogged: 0 }]));
  for (const date of eachDate(args.from, last)) {
    const w = weeks.get(weekOf(date, args.weekStart));
    if (!w) continue;
    if (broke.has(date)) w.broken++;
    else if (done.has(date)) w.held++;
    else w.unlogged++;
  }
  const rows = [...weeks.values()];
  const held = rows.reduce((s, w) => s + w.held, 0), broken = rows.reduce((s, w) => s + w.broken, 0), unlogged = rows.reduce((s, w) => s + w.unlogged, 0);
  const nights = held + broken + unlogged;
  const summary = nights === 0 ? 'No nights to count yet.'
    : `Stop held on ${held} of ${plural(nights, 'night')}, broken on ${broken}, nothing logged on ${unlogged}.`
      + (args.breaks.length > broken ? ` ${plural(args.breaks.length, 'break')} in total.` : '');
  return { weeks: rows, held, broken, unlogged, nights, breaks: args.breaks.length, shutdowns: done.size, summary };
}

// ---------------------------------------------------------------- carry-over
export interface CarryWeek { weekStart: ISODate; carries: number; tasks: number; hit3: number }
export interface CarrySection { weeks: CarryWeek[]; carries: number; tasks: number; hit3: number; waiting: number | null; summary: string }

/** `task.carried {taskId, count}` events from the core events table. A task "hits 3" in the week it is carried a third time. */
export function carryStats(args: {
  events: { payload: { taskId?: string; count?: number }; at: string }[];
  weekStarts: ISODate[]; weekStart?: number; waiting?: number | null;
}): CarrySection {
  const weeks = new Map<ISODate, { carries: number; tasks: Set<string>; hit3: Set<string> }>(
    args.weekStarts.map((w) => [w, { carries: 0, tasks: new Set(), hit3: new Set() }]));
  const everHit = new Set<string>();
  for (const e of [...args.events].sort((a, b) => a.at.localeCompare(b.at))) {
    const id = e.payload?.taskId;
    if (!id) continue;
    const w = weeks.get(weekOf(fromISO(e.at).toISODate()!, args.weekStart));
    if (!w) continue;
    w.carries++;
    w.tasks.add(id);
    if ((e.payload.count ?? 0) >= 3 && !everHit.has(id)) { everHit.add(id); w.hit3.add(id); }
  }
  const rows: CarryWeek[] = [...weeks].map(([weekStart, v]) => ({ weekStart, carries: v.carries, tasks: v.tasks.size, hit3: v.hit3.size }));
  const carries = rows.reduce((s, w) => s + w.carries, 0);
  const tasks = new Set([...weeks.values()].flatMap((v) => [...v.tasks])).size;
  const hit3 = rows.reduce((s, w) => s + w.hit3, 0);
  const waiting = args.waiting ?? null;
  const summary = carries === 0 ? 'No tasks were carried over in this range.'
    : `${plural(carries, 'carry', 'carries')} across ${plural(tasks, 'task')}; ${hit3} reached 3 carries.`
      + (waiting ? ` ${plural(waiting, 'task')} ${waiting === 1 ? 'is' : 'are'} waiting for a decision now.` : '');
  return { weeks: rows, carries, tasks, hit3, waiting, summary };
}

// ---------------------------------------------------------------- must-do completion
export interface MustDoWeek { weekStart: ISODate; planned: number; done: number; later: number }
export interface MustDoSection { weeks: MustDoWeek[]; planned: number; done: number; later: number; open: number; summary: string; note: string }

/**
 * `planned` = tasks whose task_meta.must_do_date falls on a day (required ones; optional ones are left out).
 * `completions` = todoist.completions(from, to). Done = completed on or before that day; later = completed after it.
 */
export function mustDoStats(args: {
  planned: { taskId: string; date: ISODate; optional?: boolean }[];
  completions: { task_id: string; date: ISODate }[];
  weekStarts: ISODate[]; weekStart?: number;
}): MustDoSection {
  const doneOn = new Map<string, ISODate>();
  for (const c of args.completions) if (!doneOn.has(c.task_id) || c.date < doneOn.get(c.task_id)!) doneOn.set(c.task_id, c.date);
  const weeks = new Map<ISODate, MustDoWeek>(args.weekStarts.map((w) => [w, { weekStart: w, planned: 0, done: 0, later: 0 }]));
  const seen = new Set<string>();
  for (const p of args.planned) {
    if (p.optional || seen.has(p.taskId)) continue;
    seen.add(p.taskId);
    const w = weeks.get(weekOf(p.date, args.weekStart));
    if (!w) continue;
    w.planned++;
    const c = doneOn.get(p.taskId);
    if (c !== undefined && c <= p.date) w.done++;
    else if (c !== undefined) w.later++;
  }
  const rows = [...weeks.values()];
  const planned = rows.reduce((s, w) => s + w.planned, 0), done = rows.reduce((s, w) => s + w.done, 0), later = rows.reduce((s, w) => s + w.later, 0);
  const summary = planned === 0 ? 'No must-dos were set in this range.'
    : `Finished ${done} of ${plural(planned, 'must-do')} on the day (${Math.round((done / planned) * 100)}%)`
      + (later ? `; ${later} more finished later.` : '.');
  return {
    weeks: rows, planned, done, later, open: planned - done - later, summary,
    note: 'A must-do that carries over moves to its new date, so each task counts once, on its latest date. Optional must-dos are left out.',
  };
}

// ---------------------------------------------------------------- time per project
export interface FocusLog { projectId: string; start: string; end: string; minutes: number }
export interface TimedEvent { projectId: string | null; start: string; end: string; allDay: boolean; busy: boolean; marginKind: string | null }
export interface ProjectInfo { id: string; name: string; color?: string | null; weeklyBudgetMin?: number | null }
export interface ProjectRow { projectId: string; name: string; color: string | null; focusMin: number; eventMin: number; totalMin: number; budgetMin: number | null }
export interface ProjectTimeSection { rows: ProjectRow[]; totalMin: number; weeks: number; summary: string }

const NOT_TIME = new Set(['phase', 'milestone', 'deadline']);
const ms = (iso: string) => DateTime.fromISO(iso).toMillis();

/**
 * Focus-timer minutes plus timed, busy events that already ended on project calendars.
 * Phases, milestones and deadlines aren't time. A work-session event that overlaps a focus log of the
 * same project is the same hour, so it is counted once (as focus).
 */
export function projectTime(args: { focus: FocusLog[]; events: TimedEvent[]; projects: ProjectInfo[]; weeks: number; now: string }): ProjectTimeSection {
  const info = new Map(args.projects.map((p) => [p.id, p]));
  const acc = new Map<string, { focus: number; ev: number }>();
  const get = (id: string) => acc.get(id) ?? (acc.set(id, { focus: 0, ev: 0 }), acc.get(id)!);
  for (const f of args.focus) get(f.projectId).focus += Math.max(0, f.minutes || 0);
  const nowMs = ms(args.now);
  for (const e of args.events) {
    if (!e.projectId || e.allDay || !e.busy || (e.marginKind && NOT_TIME.has(e.marginKind))) continue;
    const s = ms(e.start), t = ms(e.end);
    if (!(t > s) || t > nowMs) continue;
    if (e.marginKind === 'session' && args.focus.some((f) => f.projectId === e.projectId && ms(f.start) < t && ms(f.end) > s)) continue;
    get(e.projectId).ev += Math.round((t - s) / 60000);
  }
  const rows: ProjectRow[] = [...acc].map(([projectId, v]) => {
    const p = info.get(projectId);
    return {
      projectId, name: p?.name ?? 'Unlinked project', color: p?.color ?? null, focusMin: v.focus, eventMin: v.ev, totalMin: v.focus + v.ev,
      budgetMin: p?.weeklyBudgetMin ? p.weeklyBudgetMin * args.weeks : null,
    };
  }).filter((r) => r.totalMin > 0).sort((a, b) => b.totalMin - a.totalMin);
  const totalMin = rows.reduce((s, r) => s + r.totalMin, 0);
  const summary = rows.length === 0 ? 'No project time has been logged in this range yet.'
    : `${hm(totalMin)} across ${plural(rows.length, 'project')}. ${rows[0].name} took the most: ${hm(rows[0].totalMin)}.`;
  return { rows, totalMin, weeks: args.weeks, summary };
}

// ---------------------------------------------------------------- habit consistency
export interface HabitRow { id: string; name: string; d14: number | null; d28: number | null }
export interface HabitSection { rows: HabitRow[]; avg14: number | null; avg28: number | null; summary: string }

/** habits.consistency returns a 0-100 integer (or null). Also tolerates 0.82 fractions and { pct } objects. */
export function toPct(v: unknown): number | null {
  const raw = typeof v === 'object' && v !== null ? ((v as any).pct ?? (v as any).percent ?? (v as any).rate ?? (v as any).value) : v;
  const n = num(raw);
  if (n === null) return null;
  return Math.round(Math.max(0, Math.min(100, n > 0 && n < 1 ? n * 100 : n)));
}

export function habitStats(habits: { id: string; name: string }[], consistency: (id: string, days: number) => unknown): HabitSection {
  const rows = habits.map((h) => ({ id: h.id, name: h.name, d14: toPct(consistency(h.id, 14)), d28: toPct(consistency(h.id, 28)) }));
  const avg = (k: 'd14' | 'd28') => round(mean(rows.flatMap((r) => (r[k] === null ? [] : [r[k]!]))));
  const avg14 = avg('d14'), avg28 = avg('d28');
  const summary = rows.length === 0 ? 'No habits are set up yet.'
    : avg14 === null && avg28 === null ? 'Not enough logged days yet to show consistency.'
    : `Across ${plural(rows.length, 'habit')}, consistency averaged ${avg14 ?? '–'}% over 2 weeks and ${avg28 ?? '–'}% over 4 weeks.`;
  return { rows, avg14, avg28, summary };
}
