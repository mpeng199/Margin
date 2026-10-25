/**
 * Pure sleep and trend math for the check-in module (no DB, no ctx), so it is easy to test across DST
 * and safe to import from the web half. All time math goes through src/core/time.ts.
 */
import type { DateTime } from 'luxon';
import { at, addDays, minutesBetween, fromISO, weekday, daysBetween, type ISODate, type HHMM } from '../../src/core/time';

export const TARGET_MIN = 8 * 60;
export const TARGET_MAX = 10 * 60;
export const NAP_MAX_MIN = 20;
export const NAP_LATEST: HHMM = '16:00';

/** The sleep rules, each with a one-line why and its source. Shown in the check-in and by GET /api/checkin/rules. */
export const SLEEP_RULES: { id: string; rule: string; why: string; source: string }[] = [
  { id: 'target', rule: 'Aim for 8 to 10 hours.', why: 'That is the range recommended for ages 13 to 18.', source: 'AASM 2016' },
  { id: 'weekend', rule: 'Wake no more than 1.5 hours later on weekends.', why: 'A big weekend shift acts like jet lag on Monday morning.', source: 'Wittmann 2006' },
  { id: 'caffeine', rule: 'Last caffeine by 2 PM.', why: 'About 6 hours before bed keeps sleep intact.', source: 'Drake 2013' },
  { id: 'phone', rule: 'Charge your phone outside the bedroom.', why: 'Devices at bedtime are linked to shorter, later sleep.', source: 'Carter 2016' },
  { id: 'daylight', rule: 'Get outside within 30 minutes of waking.', why: 'Morning light sets the body clock for the day.', source: 'Wright 2013' },
  { id: 'naps', rule: 'Keep naps to 20 minutes, before 4 PM.', why: 'Short early naps help without taking from tonight.', source: 'Milner & Cote 2009' },
];

export interface SleepCalc { bedtime: DateTime; wake: DateTime; sleepMin: number }

/**
 * Bedtime belongs to the previous evening, or to just after midnight on `date`.
 * Wake belongs to `date`. Sleep is elapsed minutes (DST-correct: 10 PM EDT → 6:30 AM EST is 9h 30m).
 */
export function computeSleep(date: ISODate, bedtime: HHMM, wakeTime: HHMM): SleepCalc {
  const wake = at(date, wakeTime);
  const hour = Number(bedtime.split(':')[0]);
  let bed = at(date, bedtime);
  // Before noon and before waking = after midnight, same date. Otherwise the previous evening.
  if (!(hour < 12 && bed.toMillis() < wake.toMillis())) bed = at(addDays(date, -1), bedtime);
  const sleepMin = minutesBetween(bed, wake);
  if (sleepMin < 30 || sleepMin > 16 * 60) {
    throw Object.assign(new Error('Those times don’t add up to a night of sleep. Check bedtime and wake time.'), { status: 400 });
  }
  return { bedtime: bed, wake, sleepMin };
}

/** A gentle note when a nap falls outside 20 minutes or past 4 PM. Null when it is within bounds. */
export function napNote(napMin: number | null | undefined, napStart?: HHMM | null, max = NAP_MAX_MIN, latest: HHMM = NAP_LATEST): string | null {
  if (!napMin) return null;
  const long = napMin > max;
  const late = !!napStart && napStart >= latest;
  if (!long && !late) return null;
  const what = long && late ? 'Longer and later naps' : long ? 'Naps over 20 minutes' : 'Naps after 4 PM';
  return `${what} can make falling asleep harder tonight. Next time, 20 minutes before 4 PM tends to work best.`;
}

/** Minutes since local midnight of an ISO instant. */
export const minuteOfDay = (iso: string): number => { const d = fromISO(iso); return d.hour * 60 + d.minute; };

export interface Night { date: ISODate; wakeTime: string; sleepMin: number; energy?: number }

export interface Verdict { met: boolean; detail?: string }

const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return m ? `${h}h ${m}m` : `${h}h`; };

/** Under `hours` for `nights` entries in a row (newest first). A skipped check-in is tolerated; a stale pattern is not. */
export function shortNights(newestFirst: Night[], hours: number, nights: number, todayDate: ISODate): Verdict {
  const last = newestFirst.slice(0, nights);
  if (last.length < nights) return { met: false };
  if (daysBetween(last[0].date, todayDate) > 2) return { met: false };
  if (daysBetween(last[nights - 1].date, last[0].date) > nights + 1) return { met: false };
  if (!last.every((n) => n.sleepMin < hours * 60)) return { met: false };
  return { met: true, detail: `Under ${hours} hours of sleep ${nights} nights running (${last.map((n) => hm(n.sleepMin)).reverse().join(', ')}).` };
}

/** Weekend wake average vs school-day wake average over the entries given (the last 14 days). */
export function weekendDrift(nights: Night[], schoolDays: number[], maxMin: number): Verdict {
  const school = nights.filter((n) => schoolDays.includes(weekday(n.date)));
  const weekend = nights.filter((n) => !schoolDays.includes(weekday(n.date)));
  if (school.length < 2 || weekend.length < 1) return { met: false };
  const avg = (l: Night[]) => l.reduce((s, n) => s + minuteOfDay(n.wakeTime), 0) / l.length;
  const drift = Math.round(avg(weekend) - avg(school));
  if (drift <= maxMin) return { met: false };
  return { met: true, detail: `Weekend wake times ran ${hm(drift)} later than school days. The guide is ${hm(maxMin)} or less.` };
}

/** Weekly energy averages over `weeks` rolling 7-day windows ending `end`, oldest first. Null when a window has too few entries. */
export function weeklyEnergy(nights: Night[], weeks: number, end: ISODate, minPerWeek = 3): number[] | null {
  const out: number[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const hi = addDays(end, -7 * k), lo = addDays(hi, -6);
    const xs = nights.filter((n) => n.date >= lo && n.date <= hi && typeof n.energy === 'number').map((n) => n.energy!);
    if (xs.length < minPerWeek) return null;
    out.push(xs.reduce((s, x) => s + x, 0) / xs.length);
  }
  return out;
}

/** Direction of weekly energy: first window vs last window, with a minimum change so noise doesn't count. */
export function energyTrend(nights: Night[], direction: 'up' | 'flat' | 'down', weeks: number, end: ISODate, minChange = 1, below = 10): Verdict {
  const avgs = weeklyEnergy(nights, weeks, end);
  if (!avgs) return { met: false };
  const delta = avgs[avgs.length - 1] - avgs[0];
  const actual = delta >= minChange ? 'up' : delta <= -minChange ? 'down' : 'flat';
  if (actual !== direction) return { met: false };
  if (direction === 'flat' && !(avgs[avgs.length - 1] < below)) return { met: false };
  return { met: true, detail: `Weekly energy averages over ${weeks} weeks: ${avgs.map((a) => a.toFixed(1)).join(' → ')}.` };
}

/** More than half of the check-ins in the last 14 days were under `hours` (needs at least 7 entries). */
export function lowSleepMostNights(nights: Night[], hours: number, end: ISODate, minEntries = 7): Verdict {
  const lo = addDays(end, -13);
  const recent = nights.filter((n) => n.date >= lo && n.date <= end);
  if (recent.length < minEntries) return { met: false };
  const low = recent.filter((n) => n.sleepMin < hours * 60).length;
  if (low * 2 <= recent.length) return { met: false };
  return { met: true, detail: `Sleep was under ${hours} hours on ${low} of your last ${recent.length} check-ins.` };
}
