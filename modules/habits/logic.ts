/**
 * Habit math (SPEC 8). Pure functions — no DB, no ctx — so the schedule, consistency and
 * "never miss twice" rules are easy to test across DST and safe to import from the web half.
 *
 * Rules baked in here:
 *  - A day in progress is never a miss: today counts only once it is done.
 *  - Consistency is a percentage over a window, not a streak. One miss is fine.
 *  - "N per week" is judged week by week and pro-rated for partial weeks, so a big week
 *    can't pay for an empty one.
 */
import { addDays, weekday, weekStartOf, daysBetween, type ISODate } from '../../src/core/time';

export type HabitType = 'yesno' | 'count' | 'minutes' | 'scale';
export type Schedule = { kind: 'days'; days: number[] } | { kind: 'perWeek'; n: number };

export interface HabitCore {
  type: HabitType;
  schedule: Schedule;
  /** yes/no ignores this (1). count/minutes: the amount that counts as done. 0–10: the lowest rating that counts (0 = any). */
  target: number;
  startDate: ISODate;
}

/** Lally 2010: median 66 days to automaticity, range 18–254. Never "21 days". */
export const LALLY = { median: 66, min: 18, max: 254 } as const;

export function isDone(h: Pick<HabitCore, 'type' | 'target'>, value: number | null | undefined): boolean {
  if (value == null) return false;
  return value >= (h.type === 'yesno' ? 1 : h.target);
}

export function dateRange(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface Span {
  /** Whole percent, or null when nothing was scheduled in the window. */
  pct: number | null;
  /** Unrounded 0..1 (thresholds use this, so 79.6% is not "80%"). */
  ratio: number | null;
  scheduled: number;
  done: number;
}

/** Consistency over [from, to], both inclusive, as of `today`. `doneDates` = dates the habit was done. */
export function consistencyOver(
  h: HabitCore, doneDates: ReadonlySet<ISODate>, from: ISODate, to: ISODate, today: ISODate, weekStart = 7,
): Span {
  const start = from < h.startDate ? h.startDate : from;
  const end = to > today ? today : to;
  const dates = start > end ? [] : dateRange(start, end).filter((d) => d !== today || doneDates.has(d));
  if (h.schedule.kind === 'days') {
    const days = h.schedule.days;
    const sched = dates.filter((d) => days.includes(weekday(d)));
    const done = sched.filter((d) => doneDates.has(d)).length;
    const ratio = sched.length ? done / sched.length : null;
    return { pct: ratio == null ? null : Math.round(ratio * 100), ratio, scheduled: sched.length, done };
  }
  // N per week: group the window by week, pro-rate the target by the days of each week inside it.
  const n = h.schedule.n;
  const weeks = new Map<ISODate, ISODate[]>();
  for (const d of dates) {
    const w = weekStartOf(d, weekStart);
    weeks.set(w, [...(weeks.get(w) ?? []), d]);
  }
  let expected = 0, got = 0, doneCount = 0;
  for (const ds of weeks.values()) {
    const exp = (n * ds.length) / 7;
    const dn = ds.filter((d) => doneDates.has(d)).length;
    expected += exp;
    got += Math.min(dn, exp);
    doneCount += dn;
  }
  const ratio = expected > 0 ? got / expected : null;
  return { pct: ratio == null ? null : Math.round(ratio * 100), ratio, scheduled: Math.round(expected * 100) / 100, done: doneCount };
}

/** Consistency over the last `days` days ending today. */
export const consistencyLast = (h: HabitCore, done: ReadonlySet<ISODate>, days: number, today: ISODate, weekStart = 7): Span =>
  consistencyOver(h, done, addDays(today, -(days - 1)), today, today, weekStart);

/**
 * "Never miss twice" (Lally 2010: a single missed day didn't derail formation).
 * Days schedule: two scheduled days have passed since the last time it was done.
 * N per week: the last two full weeks both fell short and nothing is done yet this week.
 * Today never counts (it's still in progress).
 */
export function missedTwice(h: HabitCore, doneDates: ReadonlySet<ISODate>, today: ISODate, weekStart = 7): boolean {
  if (h.startDate > today) return false;
  if (h.schedule.kind === 'days') {
    const days = h.schedule.days;
    let lastDone: ISODate | null = null;
    for (const d of doneDates) if (d <= today && (lastDone == null || d > lastDone)) lastDone = d;
    const from = lastDone && lastDone >= h.startDate ? addDays(lastDone, 1) : h.startDate;
    const yesterday = addDays(today, -1);
    if (from > yesterday) return false;
    return dateRange(from, yesterday).filter((d) => days.includes(weekday(d))).length >= 2;
  }
  const n = h.schedule.n;
  const cw = weekStartOf(today, weekStart);
  const w1 = addDays(cw, -7), w2 = addDays(cw, -14);
  if (h.startDate > w2) return false; // both weeks must have been fully in play
  const count = (w: ISODate) => dateRange(w, addDays(w, 6)).filter((d) => doneDates.has(d)).length;
  const thisWeek = dateRange(cw, today).some((d) => doneDates.has(d));
  return !thisWeek && count(w1) < n && count(w2) < n;
}

/** Is the habit on the list for `date`? (Formation state is checked by the caller.) */
export function isDue(h: HabitCore, doneDates: ReadonlySet<ISODate>, date: ISODate, weekStart = 7): boolean {
  if (date < h.startDate) return false;
  if (h.schedule.kind === 'days') return h.schedule.days.includes(weekday(date));
  if (doneDates.has(date)) return true;
  const ws = weekStartOf(date, weekStart);
  return dateRange(ws, date).filter((d) => doneDates.has(d)).length < h.schedule.n;
}

export type DayStatus = 'done' | 'miss' | 'rest' | 'pending' | 'before';
/** One dot per day for the recent strip. Misses are data, so they are neutral, not red. */
export function recentDays(h: HabitCore, doneDates: ReadonlySet<ISODate>, today: ISODate, n = 14, weekStart = 7): { date: ISODate; status: DayStatus }[] {
  return dateRange(addDays(today, -(n - 1)), today).map((date) => {
    if (date < h.startDate) return { date, status: 'before' as const };
    if (doneDates.has(date)) return { date, status: 'done' as const };
    if (h.schedule.kind === 'days') {
      if (!h.schedule.days.includes(weekday(date))) return { date, status: 'rest' as const };
      return { date, status: date === today ? ('pending' as const) : ('miss' as const) };
    }
    // N per week has no fixed days: an empty day is only a miss once the week can no longer reach N.
    const ws = weekStartOf(date, weekStart);
    const left = daysBetween(date, addDays(ws, 6));
    const done = dateRange(ws, date).filter((d) => doneDates.has(d)).length;
    const need = h.schedule.n - done;
    if (date === today) return { date, status: 'pending' as const };
    return { date, status: need > left ? ('miss' as const) : ('rest' as const) };
  });
}

/** Day N of formation (1 on the start date), or null before the start. */
export function formationDay(startDate: ISODate, today: ISODate): number | null {
  const n = daysBetween(startDate, today) + 1;
  return n >= 1 ? n : null;
}

/**
 * Ready to move to automatic: at least two weeks in, and 80% or better in each of the last two weeks
 * ("hold 80% for 2 weeks"). `holdRatio` is 0.8 by default.
 */
export function isReady(h: HabitCore, done: ReadonlySet<ISODate>, today: ISODate, weekStart = 7, holdRatio = 0.8): boolean {
  if (addDays(h.startDate, 13) > today) return false;
  const w1 = consistencyOver(h, done, addDays(today, -6), today, today, weekStart);
  const w2 = consistencyOver(h, done, addDays(today, -13), addDays(today, -7), today, weekStart);
  return w1.ratio != null && w2.ratio != null && w1.ratio >= holdRatio && w2.ratio >= holdRatio;
}
