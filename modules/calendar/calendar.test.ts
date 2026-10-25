import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import { at, addDays, weekday } from '../../src/core/time';
import type { GoogleService } from '../google/manifest';
import { buildRange, type RangeResult } from './manifest';
import { GRID_START_MIN, layoutDay, monthGrid, shiftMonth, wallMinutes, weekDates, yPx, type LayoutItem } from './layout';

const ev = (id: string, date: string, from: string, to: string, extra: Partial<LayoutItem> = {}): LayoutItem => ({
  id, start: at(date, from).toISO()!, end: at(date, to).toISO()!, allDay: false, ...extra,
});
const boot = () => testApp({ at: '2026-10-26T16:00:00-04:00', only: ['day', 'google', 'calendar'] });

describe('calendar layout model', () => {
  it('positions by wall-clock minutes: 6:00 AM Mon–Fri sits at the same y on both sides of the Nov 1 change', () => {
    const before = weekDates('2026-10-28', 7); // Sun Oct 25 – Sat Oct 31 (EDT)
    const after = weekDates('2026-11-04', 7);  // Sun Nov 1 – Sat Nov 7 (EST)
    expect(before[0]).toBe('2026-10-25');
    expect(after[0]).toBe('2026-11-01');
    const ys = [...before, ...after].filter((d) => weekday(d) <= 5).map((d) => {
      const l = layoutDay(d, [ev('wake', d, '06:00', '07:00')]);
      return yPx(l.placed[0].top, 48);
    });
    expect(ys).toHaveLength(10);
    expect(new Set(ys)).toEqual(new Set([0]));
  });

  it('keeps evening events at the same wall-clock position after the change, even though the day is 25 hours', () => {
    const a = layoutDay('2026-10-31', [ev('x', '2026-10-31', '19:30', '20:15')]);
    const b = layoutDay('2026-11-01', [ev('x', '2026-11-01', '19:30', '20:15')]);
    const c = layoutDay('2026-11-02', [ev('x', '2026-11-02', '19:30', '20:15')]);
    expect([a, b, c].map((l) => [l.placed[0].top, l.placed[0].bottom])).toEqual([[1170, 1215], [1170, 1215], [1170, 1215]]);
    // The repeated 1:00–2:00 AM hour is before the 6 AM grid start: counted, not drawn.
    const night = layoutDay('2026-11-01', [{ id: 'dup', allDay: false, start: '2026-11-01T01:30:00.000-04:00', end: '2026-11-01T01:45:00.000-04:00' }]);
    expect(night.placed).toHaveLength(0);
    expect(night.before).toHaveLength(1);
  });

  it('wallMinutes reads the zoned clock, not elapsed time, across the repeated hour', () => {
    expect(wallMinutes('2026-11-01T01:30:00.000-04:00', '2026-11-01')).toBe(90); // first 1:30 (EDT)
    expect(wallMinutes('2026-11-01T01:30:00.000-05:00', '2026-11-01')).toBe(90); // second 1:30 (EST)
    expect(wallMinutes('2026-11-01T06:00:00.000-05:00', '2026-11-01')).toBe(360);
    expect(wallMinutes('2026-10-31T23:00:00.000-04:00', '2026-11-01')).toBe(0);
    expect(wallMinutes('2026-11-02T00:00:00.000-05:00', '2026-11-01')).toBe(1440);
  });

  it('clamps events that cross the grid edges and sets the hard stop line', () => {
    const d = '2026-11-01';
    const l = layoutDay(d, [
      { id: 'late', allDay: false, start: at('2026-10-31', '23:00').toISO()!, end: at(d, '07:30').toISO()! }, // spills in from last night
      { id: 'overnight', allDay: false, start: at(d, '22:00').toISO()!, end: at('2026-11-02', '01:00').toISO()! }, // spills out
      { id: 'early', allDay: false, start: at(d, '04:00').toISO()!, end: at(d, '05:30').toISO()! },
      { id: 'tiny', allDay: false, start: at(d, '12:00').toISO()!, end: at(d, '12:00').toISO()! },
      { id: 'holiday', allDay: true, start: d, end: '2026-11-02' },
    ], at(d, '21:00').toISO());
    const by = Object.fromEntries(l.placed.map((p) => [p.item.id, p]));
    expect([by.late.top, by.late.bottom]).toEqual([GRID_START_MIN, 450]);
    expect([by.overnight.top, by.overnight.bottom]).toEqual([1320, 1440]);
    expect(by.tiny.bottom - by.tiny.top).toBeGreaterThanOrEqual(20);
    expect(l.before.map((x) => x.id)).toEqual(['early']);
    expect(l.allDay.map((x) => x.id)).toEqual(['holiday']);
    expect(l.stopMin).toBe(1260);
  });

  it('puts overlapping events side by side and lets later gaps use the full width', () => {
    const d = '2026-10-27';
    const l = layoutDay(d, [
      ev('a', d, '09:00', '11:00'), ev('b', d, '10:00', '11:30'), ev('c', d, '10:30', '12:00'),
      ev('solo', d, '13:00', '14:00'), ev('back', d, '11:30', '12:30'),
    ]);
    const p = Object.fromEntries(l.placed.map((x) => [x.item.id, [x.col, x.cols]]));
    expect(p.a).toEqual([0, 3]);
    expect(p.b).toEqual([1, 3]);
    expect(p.c).toEqual([2, 3]);
    expect(p.back[1]).toBe(3); // overlaps c, so it stays in the same cluster
    expect(p.solo).toEqual([0, 1]);
  });

  it('builds week and month grids on the right boundaries', () => {
    expect(weekDates('2026-11-01', 7)[0]).toBe('2026-11-01'); // Sunday start
    expect(weekDates('2026-11-01', 1)[0]).toBe('2026-10-26'); // Monday start
    const nov = monthGrid('2026-11-15', 7);
    expect(nov.start).toBe('2026-11-01');
    expect(nov.weeks).toBe(5);
    expect(nov.days.at(-1)).toBe('2026-12-05');
    const novMon = monthGrid('2026-11-15', 1);
    expect(novMon.start).toBe('2026-10-26');
    expect(novMon.weeks).toBe(6);
    expect(monthGrid('2026-02-10', 7).weeks).toBe(4); // Feb 2026 starts on a Sunday and has 28 days
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-15');
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15');
  });
});

describe('calendar range route', () => {
  it('week of Nov 1: fixed 6:00 AM blocks Mon–Fri land at the same y either side, and the stop line stays at 9:00 PM', async () => {
    const app = await boot();
    app.ctx.settings.set('day', { fixedBlocks: [{ id: 'early', label: 'Early block', kind: 'other', days: [1, 2, 3, 4, 5], start: '06:00', end: '07:00' }] });
    const a = (await app.req('GET', '/api/calendar/range?start=2026-10-25&days=7')).json as RangeResult;
    const b = (await app.req('GET', '/api/calendar/range?start=2026-11-01&days=7')).json as RangeResult;
    expect(a.days.map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays('2026-10-25', i)));
    const tops = [...a.days, ...b.days].filter((d) => weekday(d.date) <= 5).map((d) => {
      const item = d.items.find((i) => i.title === 'Early block')!;
      expect(item).toBeTruthy();
      return layoutDay(d.date, d.items, d.anchors.effectiveStop).placed.find((p) => p.item.id === item.id)!.top;
    });
    expect(tops).toEqual(Array(10).fill(360));
    const stops = [...a.days, ...b.days].map((d) => layoutDay(d.date, d.items, d.anchors.effectiveStop).stopMin);
    expect(new Set(stops)).toEqual(new Set([1260]));
    // Nov 1 has 25 hours; its neighbours have 24. The header says so; positions ignore it.
    expect(Object.fromEntries([...a.days, ...b.days].map((d) => [d.date, d.lengthMin]))['2026-11-01']).toBe(1500);
    expect(b.days.filter((d) => d.lengthMin !== 1440).map((d) => d.date)).toEqual(['2026-11-01']);
  });

  it('keeps Badminton at 6:00 AM from the synced calendar on both sides of the change, with a link to open it', async () => {
    const app = await boot();
    await app.ctx.service<GoogleService>('google').sync();
    const a = (await app.req('GET', '/api/calendar/range?start=2026-10-25&days=7')).json as RangeResult;
    const b = (await app.req('GET', '/api/calendar/range?start=2026-11-01&days=7')).json as RangeResult;
    const find = (r: RangeResult, date: string) => r.days.find((d) => d.date === date)!;
    const tue1 = find(a, '2026-10-27'), tue2 = find(b, '2026-11-03');
    const top = (day: ReturnType<typeof find>) => layoutDay(day.date, day.items, day.anchors.effectiveStop).placed.find((p) => p.item.title === 'Badminton')!.top;
    expect(top(tue1)).toBe(360);
    expect(top(tue2)).toBe(360);
    const badminton = tue1.items.find((i) => i.title === 'Badminton')!;
    expect(badminton.htmlLink).toMatch(/^https:\/\/calendar\.google\.com/);
    expect(badminton.busy).toBe(true);
    // All-day holiday is in the all-day row, not the grid.
    const election = find(b, '2026-11-03').items.find((i) => i.title === 'Election Day')!;
    const l = layoutDay('2026-11-03', find(b, '2026-11-03').items);
    expect(l.allDay.map((x) => x.id)).toContain(election.id);
    expect(l.placed.some((p) => p.item.id === election.id)).toBe(false);
  });

  it('reports load versus capacity per day and honours the calendar visibility setting', async () => {
    const app = await boot();
    await app.ctx.service<GoogleService>('google').sync();
    const g = app.ctx.service<GoogleService>('google');
    const r = (await app.req('GET', '/api/calendar/range?start=2026-10-26&days=1')).json as RangeResult;
    expect(r.days[0].capacity.freeMin).toBeGreaterThan(0);
    expect(r.days[0].capacity.status).toBeDefined();
    const before = (await app.req('GET', '/api/calendar/range?start=2026-10-27&days=1')).json as RangeResult;
    expect(before.days[0].items.some((i) => i.title === 'Badminton')).toBe(true);
    const primary = g.calendars().find((c) => c.primary)!;
    const patched = await app.req('PATCH', '/api/settings/google', { hiddenCalendars: [primary.id] });
    expect(patched.status).toBe(200);
    expect(g.calendars().find((c) => c.id === primary.id)!.hidden).toBe(true);
    const after = (await app.req('GET', '/api/calendar/range?start=2026-10-27&days=1')).json as RangeResult;
    expect(after.days[0].items.some((i) => i.title === 'Badminton')).toBe(false);
  });

  it('validates range boundaries: 1 to 42 days, real dates only', async () => {
    const app = await boot();
    const get = (q: string) => app.req('GET', `/api/calendar/range?${q}`);
    expect(((await get('start=2026-11-01&days=1')).json as RangeResult).days).toHaveLength(1);
    expect(((await get('start=2026-11-01&days=42')).json as RangeResult).days).toHaveLength(42);
    expect(((await get('start=2026-11-01&days=500')).json as RangeResult).days).toHaveLength(42);
    expect(((await get('start=2026-11-01&days=2.9')).json as RangeResult).days).toHaveLength(2);
    expect((await get('start=2026-11-01&days=0')).status).toBe(400);
    expect((await get('start=2026-11-01&days=abc')).status).toBe(400);
    expect((await get('start=2026-13-45&days=7')).status).toBe(400);
    expect((await get('start=tomorrow')).status).toBe(400);
    // Default: the current week (Sunday start) for the pinned clock, Mon Oct 26.
    const def = (await get('')).json as RangeResult;
    expect(def.start).toBe('2026-10-25');
    expect(def.days).toHaveLength(7);
    // Ranges are contiguous across the DST change and across a month edge.
    const span = (await get('start=2026-10-30&days=5')).json as RangeResult;
    expect(span.days.map((d) => d.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('still answers when the optional modules are missing', async () => {
    const app = await boot();
    const none = new Set(['google', 'projects', 'plan']);
    const ctx = { ...app.ctx, maybe: (id: string) => (none.has(id) ? undefined : app.ctx.maybe(id)) } as typeof app.ctx;
    const r = buildRange(ctx, '2026-11-01', 7);
    expect(r.sources).toEqual({ google: false, projects: false, plan: false });
    expect(r.days).toHaveLength(7);
    expect(r.days.every((d) => d.items.every((i) => i.htmlLink === null && i.projectName === null))).toBe(true);
    // The real app reports exactly which optional modules are on in this boot.
    const real = (await app.req('GET', '/api/calendar/range?start=2026-11-01&days=1')).json as RangeResult;
    expect(real.sources).toEqual({ google: true, projects: !!app.ctx.maybe('projects'), plan: !!app.ctx.maybe('plan') });
  });
});
