/**
 * Calendar layout model (pure, shared by the server tests and the web grid).
 *
 * Everything is positioned by LOCAL WALL-CLOCK minutes (hour * 60 + minute) of the zoned start/end,
 * never by milliseconds from midnight. On Sunday Nov 1, 2026 the day has 25 hours (1:00–2:00 AM repeats),
 * so ms-from-midnight would push every event after 2 AM down by an hour. A 6:00 AM event is always
 * at wall minute 360, on both sides of the change. The repeated hour sits before the 6 AM grid start.
 */
import { DateTime } from 'luxon';
import { fromISO, addDays, weekStartOf, type ISODate } from '../../src/core/time';

export const GRID_START_MIN = 6 * 60;
export const GRID_END_MIN = 24 * 60;
/** Events shorter than this are drawn (and overlap-checked) at this height so they can be hit. */
export const MIN_VISUAL_MIN = 20;

export interface LayoutItem { id: string; start: string; end: string; allDay: boolean }

export interface Placed<T> {
  item: T;
  /** Wall-clock minutes from midnight, clamped to the visible grid. */
  top: number;
  bottom: number;
  /** Side-by-side column inside an overlapping cluster. */
  col: number;
  cols: number;
}

export interface DayLayout<T> {
  date: ISODate;
  allDay: T[];
  placed: Placed<T>[];
  /** Timed items that end before the grid starts (before 6 AM); counted, not drawn. */
  before: T[];
  /** Wall-clock minute of the hard stop, or null if it isn't inside this day. */
  stopMin: number | null;
}

/** Wall-clock minute of an instant relative to `date`: before the date -> 0, after it -> 1440. */
export function wallMinutes(iso: string, date: ISODate): number {
  const d = fromISO(iso);
  const day = d.toISODate()!;
  if (day < date) return 0;
  if (day > date) return 1440;
  return d.hour * 60 + d.minute;
}

/** Pixel offset of a wall-clock minute inside the grid. */
export function yPx(min: number, hourPx: number): number {
  return ((min - GRID_START_MIN) * hourPx) / 60;
}

export function layoutDay<T extends LayoutItem>(date: ISODate, items: T[], stopIso?: string | null): DayLayout<T> {
  const allDay: T[] = [];
  const before: T[] = [];
  const placed: Placed<T>[] = [];
  for (const item of items) {
    if (item.allDay) { allDay.push(item); continue; }
    const s = wallMinutes(item.start, date);
    const e = wallMinutes(item.end, date);
    if (Math.max(s, e) <= GRID_START_MIN && !(s === e && s === GRID_START_MIN)) { before.push(item); continue; }
    let top = Math.max(s, GRID_START_MIN);
    let bottom = Math.max(e, top + MIN_VISUAL_MIN);
    if (bottom > GRID_END_MIN) { bottom = GRID_END_MIN; top = Math.min(top, GRID_END_MIN - MIN_VISUAL_MIN); }
    placed.push({ item, top, bottom, col: 0, cols: 1 });
  }

  // Overlap clusters: events that transitively overlap share the width, side by side.
  placed.sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.item.id.localeCompare(b.item.id));
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  let colEnds: number[] = [];
  const flush = () => { for (const p of cluster) p.cols = Math.max(1, colEnds.length); cluster = []; colEnds = []; };
  for (const p of placed) {
    if (p.top >= clusterEnd) flush();
    let c = colEnds.findIndex((end) => end <= p.top);
    if (c < 0) c = colEnds.length;
    colEnds[c] = p.bottom;
    p.col = c;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  flush();

  const stopMin = stopIso ? wallMinutes(stopIso, date) : null;
  return { date, allDay, placed, before, stopMin: stopMin !== null && stopMin >= GRID_START_MIN && stopMin < GRID_END_MIN ? stopMin : null };
}

/** The 7 dates of the week containing `date` (weekStart: 7 = Sunday, 1 = Monday). */
export function weekDates(date: ISODate, weekStart = 7): ISODate[] {
  const ws = weekStartOf(date, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
}

/** The month grid: whole weeks covering the month containing `date`. */
export function monthGrid(date: ISODate, weekStart = 7): { month: string; start: ISODate; weeks: number; days: ISODate[] } {
  const first = DateTime.fromISO(date, { zone: 'UTC' }).startOf('month');
  const last = first.endOf('month').toISODate()!;
  const start = weekStartOf(first.toISODate()!, weekStart);
  const end = weekStartOf(last, weekStart);
  const weeks = Math.round(DateTime.fromISO(end, { zone: 'UTC' }).diff(DateTime.fromISO(start, { zone: 'UTC' }), 'days').days / 7) + 1;
  return { month: first.toFormat('yyyy-MM'), start, weeks, days: Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i)) };
}

/** Calendar-month shift that clamps the day (Jan 31 + 1 month = Feb 28). */
export function shiftMonth(date: ISODate, n: number): ISODate {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ months: n }).toISODate()!;
}
