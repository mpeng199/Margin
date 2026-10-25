/**
 * All time math lives here. Rules:
 *  - A calendar day is an ISO date string ('2026-11-01'), never a Date at midnight.
 *  - A moment is a Luxon DateTime in the user's zone.
 *  - Durations between moments are elapsed minutes (DST-correct by construction).
 *  - Anchor times ('06:30') are wall-clock and resolved per date.
 */
import { DateTime } from 'luxon';

export type ISODate = string;
export type HHMM = string;

let zone = 'America/New_York';
let clock: () => number = () => Date.now();

export function setZone(z: string) { zone = z; }
export function getZone() { return zone; }
/** Tests (and the dev "time travel" switch) replace the clock. */
export function setClock(fn: () => number) { clock = fn; }
export function resetClock() { clock = () => Date.now(); }

export function now(): DateTime {
  return DateTime.fromMillis(clock(), { zone });
}
export function fromISO(s: string): DateTime {
  return DateTime.fromISO(s, { zone, setZone: false }).setZone(zone);
}
export function fromMillis(ms: number): DateTime {
  return DateTime.fromMillis(ms, { zone });
}
export function today(): ISODate {
  return now().toISODate()!;
}
export function dateOf(dt: DateTime): ISODate {
  return dt.setZone(zone).toISODate()!;
}

/** Wall-clock time on a date. Nonexistent times (spring-forward gap) roll forward; ambiguous ones take the earlier offset. */
export function at(date: ISODate, hhmm: HHMM): DateTime {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  return DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: m }, { zone });
}

export function addDays(date: ISODate, n: number): ISODate {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days: n }).toISODate()!;
}
/** 1 = Monday … 7 = Sunday */
export function weekday(date: ISODate): number {
  return DateTime.fromISO(date, { zone: 'UTC' }).weekday;
}
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round(DateTime.fromISO(b, { zone: 'UTC' }).diff(DateTime.fromISO(a, { zone: 'UTC' }), 'days').days);
}
/** Start of the week containing `date`. weekStart: 7 = Sunday (Todoist default here), 1 = Monday. */
export function weekStartOf(date: ISODate, weekStart = 7): ISODate {
  const wd = weekday(date);
  const back = (wd - weekStart + 7) % 7;
  return addDays(date, -back);
}
export function minutesBetween(a: DateTime, b: DateTime): number {
  return Math.round((b.toMillis() - a.toMillis()) / 60000);
}
export function minHHMM(a: HHMM, b: HHMM): HHMM { return toMinutes(a) <= toMinutes(b) ? a : b; }
export function toMinutes(hhmm: HHMM): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
export function fromMinutes(min: number): HHMM {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function earlier(a: DateTime, b: DateTime) { return a.toMillis() <= b.toMillis() ? a : b; }
export function later(a: DateTime, b: DateTime) { return a.toMillis() >= b.toMillis() ? a : b; }

/** "9:00 PM" */
export function fmtTime(dt: DateTime): string {
  return dt.setZone(zone).toFormat('h:mm a');
}
export function fmtDuration(min: number): string {
  const sign = min < 0 ? '−' : '';
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${sign}${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${sign}${h}h ${r}m` : `${sign}${h}h`;
}

export interface Interval { start: DateTime; end: DateTime }

/** Merge overlapping intervals (sorted output). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.end.toMillis() > i.start.toMillis())
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start.toMillis() <= last.end.toMillis()) {
      if (i.end.toMillis() > last.end.toMillis()) last.end = i.end;
    } else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Free minutes inside `window` not covered by `busy`. Elapsed time, so a 25-hour day counts 25 hours. */
export function freeMinutes(window: Interval, busy: Interval[]): number {
  const clipped = mergeIntervals(
    busy.map((b) => ({ start: later(b.start, window.start), end: earlier(b.end, window.end) })),
  );
  const busyMin = clipped.reduce((s, i) => s + minutesBetween(i.start, i.end), 0);
  return Math.max(0, minutesBetween(window.start, window.end) - busyMin);
}

/** Free gaps inside `window` (for slotting tasks). */
export function freeGaps(window: Interval, busy: Interval[], minMinutes = 1): Interval[] {
  const merged = mergeIntervals(
    busy.map((b) => ({ start: later(b.start, window.start), end: earlier(b.end, window.end) })),
  );
  const gaps: Interval[] = [];
  let cursor = window.start;
  for (const b of merged) {
    if (minutesBetween(cursor, b.start) >= minMinutes) gaps.push({ start: cursor, end: b.start });
    cursor = later(cursor, b.end);
  }
  if (minutesBetween(cursor, window.end) >= minMinutes) gaps.push({ start: cursor, end: window.end });
  return gaps;
}
