import { describe, it, expect } from 'vitest';
import { testApp } from '../helpers';
import type { GoogleService } from '../../modules/google/manifest';

const boot = () => testApp({ at: '2026-10-26T16:00:00-04:00', only: ['day', 'todoist', 'google', 'today'] });

describe('google module (mock API)', () => {
  it('syncs all calendars and keeps 6:00 AM badminton at 6:00 across the Nov 1 DST change', async () => {
    const app = await boot();
    const g = app.ctx.service<GoogleService>('google');
    await g.sync();
    expect(g.calendars().length).toBe(3);
    const before = g.eventsBetween('2026-10-27T00:00:00-04:00', '2026-10-28T00:00:00-04:00').find((e) => e.title === 'Badminton')!;
    const after = g.eventsBetween('2026-11-03T00:00:00-05:00', '2026-11-04T00:00:00-05:00').find((e) => e.title === 'Badminton')!;
    expect(before.start).toBe('2026-10-27T06:00:00.000-04:00');
    expect(after.start).toBe('2026-11-03T06:00:00.000-05:00');
    expect(after.busy).toBe(true);
    const holiday = g.eventsBetween('2026-11-03T00:00:00-05:00', '2026-11-04T00:00:00-05:00').find((e) => e.title === 'Election Day')!;
    expect(holiday.allDay).toBe(true);
    expect(holiday.busy).toBe(false);
  });

  it('incremental sync picks up an edit made on the phone, and a 410 triggers a clean full resync', async () => {
    const app = await boot();
    const g = app.ctx.service<GoogleService>('google');
    await g.sync();
    const mock = g.mock()!;
    const ortho = g.eventsBetween('2026-10-28T00:00:00-04:00', '2026-10-29T00:00:00-04:00').find((e) => e.title === 'Orthodontist')!;
    mock.editFromPhone(ortho.calendarId, ortho.id, { summary: 'Orthodontist (moved)' });
    await g.sync();
    expect(g.eventsBetween('2026-10-28T00:00:00-04:00', '2026-10-29T00:00:00-04:00').some((e) => e.title === 'Orthodontist (moved)')).toBe(true);
    mock.expireTokens();
    await g.sync();
    expect(g.eventsBetween('2026-10-28T00:00:00-04:00', '2026-10-29T00:00:00-04:00').filter((e) => e.title.startsWith('Orthodontist'))).toHaveLength(1);
  });

  it('creates app calendars idempotently and writes blocks through a change set', async () => {
    const app = await boot();
    const g = app.ctx.service<GoogleService>('google');
    await g.sync();
    const id1 = await g.ensureAppCalendar('blocks', 'main', 'Margin · Blocks');
    const id2 = await g.ensureAppCalendar('blocks', 'main', 'Margin · Blocks');
    expect(id1).toBe(id2);
    const set = app.ctx.changes.propose({ source: 'user', title: 'Block', changes: [
      { kind: 'gcal.event.create', title: 'Deep block', payload: { title: 'Deep work: RSI essay', start: '2026-10-26T19:00:00-04:00', end: '2026-10-26T20:15:00-04:00', marginKind: 'block' } },
    ] });
    const out = await app.ctx.changes.apply(set.id);
    expect(out.status).toBe('applied');
    const ev = g.eventsBetween('2026-10-26T00:00:00-04:00', '2026-10-27T00:00:00-04:00').find((e) => e.title === 'Deep work: RSI essay')!;
    expect(ev.appOwned).toBe(true);
    expect(ev.marginKind).toBe('block');
  });

  it('refuses to write to the primary calendar without the scope and an explicit confirm', async () => {
    const app = await boot();
    const g = app.ctx.service<GoogleService>('google');
    await g.sync();
    const set = app.ctx.changes.propose({ source: 'claude', title: 'x', changes: [
      { kind: 'gcal.event.create', title: 'on primary', payload: { calendarId: 'me@example.com', title: 'Nope', start: '2026-10-26T19:00:00-04:00', end: '2026-10-26T20:00:00-04:00' } },
      { kind: 'gcal.event.create', title: 'confirmed but no scope', payload: { calendarId: 'me@example.com', confirmed: true, title: 'Nope', start: '2026-10-26T19:00:00-04:00', end: '2026-10-26T20:00:00-04:00' } },
    ] });
    const out = await app.ctx.changes.apply(set.id);
    expect(out.changes[0].status).toBe('failed');
    expect(out.changes[0].error).toMatch(/Confirm this specific change/);
    expect(out.changes[1].error).toMatch(/extra Google permission/);
  });

  it('day timeline merges fixed blocks and calendar events, and capacity uses them', async () => {
    const app = await boot();
    app.ctx.settings.set('day', { fixedBlocks: [
      { id: 'school', label: 'School', kind: 'school', days: [1, 3, 4], start: '06:45', end: '14:02' },
      { id: 'lab', label: 'Lab', kind: 'lab', days: [1, 2, 3, 4, 5], start: '15:40', end: '18:15' },
    ] });
    await app.ctx.service<GoogleService>('google').sync();
    const r = await app.req('GET', '/api/day/capacity?date=2026-10-26');
    // wake 6:30 → stop 21:00 = 870 min; school 437 + lab 155 = 592 busy → 278 free
    expect(r.json.freeMin).toBe(278);
    const tl = (await app.req('GET', '/api/day/timeline?date=2026-10-27')).json;
    expect(tl.map((i: any) => i.title)).toEqual(expect.arrayContaining(['Badminton', 'Lab']));
  });
});
