/**
 * Timeline geometry. Everything is whole days from an origin date (`daysBetween`, which works in UTC),
 * never milliseconds, so the Nov 1 2026 fall-back can't stretch or shift a bar.
 */
import { addDays, daysBetween, weekday, type ISODate } from '../../src/core/time';

export type Zoom = 'week' | 'month' | 'quarter' | 'semester';
export const ZOOMS: { value: Zoom; label: string }[] = [
  { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }, { value: 'semester', label: 'Semester' },
];
/** Pixels per day column at each zoom. */
export const PX_PER_DAY: Record<Zoom, number> = { week: 96, month: 30, quarter: 11, semester: 5 };

/** Zero-based day column of `date` relative to `origin`. */
export const dayCol = (origin: ISODate, date: ISODate) => daysBetween(origin, date);

/** A date range [start, end] (both inclusive) as a starting column and a number of day columns. */
export function spanCols(origin: ISODate, start: ISODate, end: ISODate): { col: number; span: number } {
  return { col: daysBetween(origin, start), span: Math.max(1, daysBetween(start, end) + 1) };
}

export const xOf = (origin: ISODate, date: ISODate, px: number) => dayCol(origin, date) * px;
export const widthOf = (start: ISODate, end: ISODate, px: number) => Math.max(1, daysBetween(start, end) + 1) * px;
/** Which day column a horizontal position falls in. */
export const dateAtX = (origin: ISODate, x: number, px: number): ISODate => addDays(origin, Math.floor(x / px));
/** Whole days a drag of `dx` pixels moves an item (snaps to the nearest day). */
export const dragDays = (dx: number, px: number) => Math.round(dx / px);

export interface Tick { date: ISODate; x: number; label: string; major: boolean }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dom = (d: ISODate) => Number(d.slice(8));
const mon = (d: ISODate) => Number(d.slice(5, 7));

/** Header ticks for `days` columns from `origin`: every day at Week zoom, Mondays at Month, month starts above that. */
export function ticks(origin: ISODate, days: number, zoom: Zoom): Tick[] {
  const px = PX_PER_DAY[zoom];
  const out: Tick[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(origin, i);
    const x = i * px;
    if (zoom === 'week') out.push({ date: d, x, label: `${DAYS[weekday(d) - 1]} ${dom(d)}`, major: dom(d) === 1 || weekday(d) === 1 });
    else if (zoom === 'month') { if (weekday(d) === 1 || dom(d) === 1) out.push({ date: d, x, label: dom(d) === 1 ? MONTHS[mon(d) - 1] : String(dom(d)), major: dom(d) === 1 }); }
    else if (dom(d) === 1) out.push({ date: d, x, label: MONTHS[mon(d) - 1] + (mon(d) === 1 ? ` ${d.slice(0, 4)}` : ''), major: true });
  }
  return out;
}

/** Row packing: items that overlap in time go on different lanes, so bars never cover each other. */
export function packLanes<T extends { start: ISODate; end: ISODate }>(items: T[]): (T & { lane: number })[] {
  const laneEnds: ISODate[] = [];
  return [...items].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)).map((it) => {
    let lane = laneEnds.findIndex((e) => e < it.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.end); } else laneEnds[lane] = it.end;
    return { ...it, lane };
  });
}

/** Origin and length (in days) that show everything with some margin; at least `minDays`. */
export function extent(dates: ISODate[], today: ISODate, minDays: number): { origin: ISODate; days: number } {
  const all = [...dates, today].sort();
  const origin = addDays(all[0], -7);
  const end = addDays(all[all.length - 1], 14);
  return { origin, days: Math.max(minDays, daysBetween(origin, end)) };
}
