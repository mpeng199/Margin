/**
 * calendar — the main week and month calendar (SPEC 6). It owns no data: each day comes from
 * day.timeline(date), which already merges fixed blocks and every calendar through the projects
 * separation rule, so this screen can never show more than Today does. Read-only.
 */
import { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { addDays, at, minutesBetween, today, weekStartOf, type ISODate } from '../../src/core/time';
import type { DayService, TimelineItem } from '../day/manifest';
import type { Capacity } from '../day/capacity';
import type { CalEvent } from '../google/manifest';

export interface CalItem extends TimelineItem {
  htmlLink: string | null;
  projectName: string | null;
  projectColor: string | null;
}
export interface RangeDay {
  date: ISODate;
  /** Elapsed minutes in the local day: 1500 on Nov 1, 2026 (clocks go back), 1380 in spring. */
  lengthMin: number;
  items: CalItem[];
  capacity: Pick<Capacity, 'freeMin' | 'loadMin' | 'status' | 'overByMin'>;
  anchors: { wake: string; lightsOut: string; hardStop: string; effectiveStop: string };
}
export interface RangeResult {
  start: ISODate;
  days: RangeDay[];
  /** Which optional modules fed this range, so the screen can say what's missing. */
  sources: { google: boolean; projects: boolean; plan: boolean };
}

export const MAX_RANGE_DAYS = 42;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  return typeof s === 'string' && DATE.test(s) && DateTime.fromISO(s, { zone: 'UTC' }).isValid;
}

/** One list of days for the UI. `n` is clamped to 1..42 (a six-week month grid). */
export function buildRange(ctx: Ctx, start: ISODate, n: number): RangeResult {
  const day = ctx.service<DayService>('day');
  const google = ctx.maybe<{ eventsBetween(a: string, b: string): CalEvent[] }>('google');
  const projects = ctx.maybe<{ get(id: string): { name: string; color: string } | null }>('projects');
  const count = Math.min(MAX_RANGE_DAYS, Math.max(1, Math.floor(n) || 1));

  // The timeline has no htmlLink; look it up from the raw events once for the whole range.
  const links = new Map<string, string | null>();
  if (google) {
    const a = at(start, '00:00').toISO()!;
    const b = at(addDays(start, count), '00:00').toISO()!;
    for (const e of google.eventsBetween(a, b)) links.set(`cal:${e.calendarId}:${e.id}`, e.htmlLink);
  }
  const project = (id: string | null | undefined) => (id ? projects?.get(id) ?? null : null);

  const days: RangeDay[] = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(start, i);
    const a = day.anchors(date);
    const cap = day.capacity(date);
    days.push({
      date,
      lengthMin: minutesBetween(at(date, '00:00'), at(addDays(date, 1), '00:00')),
      items: day.timeline(date).map((t) => {
        const p = project(t.projectId);
        return { ...t, htmlLink: links.get(t.id) ?? null, projectName: p?.name ?? null, projectColor: p?.color ?? null };
      }),
      capacity: { freeMin: cap.freeMin, loadMin: cap.loadMin, status: cap.status, overByMin: cap.overByMin },
      anchors: { wake: a.wake.toISO()!, lightsOut: a.lightsOut.toISO()!, hardStop: a.hardStop.toISO()!, effectiveStop: a.effectiveStop.toISO()! },
    });
  }
  return { start, days, sources: { google: !!google, projects: !!projects, plan: !!ctx.maybe('plan') } };
}

export default defineModule({
  id: 'calendar',
  name: 'Calendar',
  description: 'Main week and month calendar with load versus capacity per day. Read-only.',
  routes(r, ctx) {
    r.get('/range', (c) => {
      const weekStart = ctx.settings.get<{ weekStart: number }>('day').weekStart;
      const start = c.req.query('start') ?? weekStartOf(today(), weekStart);
      if (!isISODate(start)) return c.json({ error: 'start must be a date like 2026-11-01.' }, 400);
      const n = Number(c.req.query('days') ?? 7);
      if (!Number.isFinite(n) || n < 1) return c.json({ error: 'days must be a number from 1 to 42.' }, 400);
      return c.json(buildRange(ctx, start, n));
    });
  },
  nav: [{ id: 'calendar', label: 'Calendar', icon: 'CalendarDays', path: '/calendar', section: 'main', order: 10, shortcut: 'Mod+2', work: true }],
});
