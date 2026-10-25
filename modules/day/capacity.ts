/**
 * Capacity (SPEC 4.1): free minutes between fixed blocks and the hard stop, versus planned load
 * (estimates × 1.5). Pure function over intervals; the service feeds it calendar + plan data.
 */
import type { DateTime } from 'luxon';
import { at, freeMinutes, freeGaps, weekday, type Interval, type ISODate, type HHMM } from '../../src/core/time';

export interface FixedBlock {
  id: string;
  label: string;
  kind: 'school' | 'commute' | 'lab' | 'gym' | 'dinner' | 'sport' | 'other';
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  start: HHMM;
  end: HHMM;
}

export interface LoadItem { id: string; title: string; estimateMin: number; paddedMin: number; lane: 'must' | 'homework' | 'other' }

export interface Capacity {
  date: ISODate;
  window: { start: string; end: string };
  freeMin: number;
  loadMin: number;
  rawLoadMin: number;
  /** load / free; Infinity when free is 0 and there is load. */
  ratio: number;
  status: 'open' | 'ok' | 'tight' | 'over' | 'none';
  overByMin: number;
  busy: { start: string; end: string; label: string; source: string }[];
  gaps: { start: string; end: string; minutes: number }[];
  items: LoadItem[];
  /** The weekly off-day: no work capacity by design. */
  offDay?: boolean;
}

export function fixedIntervals(blocks: FixedBlock[], date: ISODate): (Interval & { id: string; kind: FixedBlock['kind']; label: string; source: string })[] {
  const wd = weekday(date);
  return blocks
    .filter((b) => b.days.includes(wd))
    .map((b) => ({ id: b.id, kind: b.kind, start: at(date, b.start), end: at(date, b.end), label: b.label, source: 'fixed' }));
}

export function computeCapacity(args: {
  date: ISODate;
  wake: DateTime;
  stop: DateTime;
  busy: (Interval & { label: string; source: string })[];
  items: LoadItem[];
  nearZeroMin?: number;
}): Capacity {
  const window = { start: args.wake, end: args.stop };
  const free = freeMinutes(window, args.busy);
  const load = args.items.reduce((s, i) => s + i.paddedMin, 0);
  const raw = args.items.reduce((s, i) => s + i.estimateMin, 0);
  const ratio = free > 0 ? load / free : load > 0 ? Infinity : 0;
  const nearZero = args.nearZeroMin ?? 30;
  const status: Capacity['status'] =
    free < nearZero ? 'none' : ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : ratio < 0.4 ? 'open' : 'ok';
  return {
    date: args.date,
    window: { start: args.wake.toISO()!, end: args.stop.toISO()! },
    freeMin: free,
    loadMin: Math.round(load),
    rawLoadMin: Math.round(raw),
    ratio,
    status,
    overByMin: Math.max(0, Math.round(load - free)),
    busy: args.busy.map((b) => ({ start: b.start.toISO()!, end: b.end.toISO()!, label: b.label, source: b.source })),
    gaps: freeGaps(window, args.busy, 15).map((g) => ({
      start: g.start.toISO()!, end: g.end.toISO()!, minutes: Math.round((g.end.toMillis() - g.start.toMillis()) / 60000),
    })),
    items: args.items,
  };
}

export const pad = (estimateMin: number, multiplier: number) => Math.round(estimateMin * multiplier);
