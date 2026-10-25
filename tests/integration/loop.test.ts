/**
 * The daily loop across modules and across the Nov 1, 2026 DST change:
 * plan within the cap → shutdown with carry-over → Evening mode + capture → off-day morning check-in
 * → Sunday (25-hour day) check-in with the extra hour counted.
 */
import { describe, it, expect } from 'vitest';
import { testApp } from '../helpers';
import type { TodoistService } from '../../modules/todoist/manifest';

describe('daily loop end to end (API)', () => {
  it('runs Friday → Sunday across the DST change', async () => {
    const app = await testApp({ at: '2026-10-30T15:00:00-04:00' }); // Friday afternoon, every module loaded
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    await app.ctx.service<any>('google').sync();
    app.ctx.settings.set('day', { fixedBlocks: [{ id: 'lab', label: 'Lab', kind: 'lab', days: [1, 2, 3, 4, 5], start: '15:40', end: '18:15' }] });

    // Plan: three must-dos, the fourth is refused unless it's optional or swaps one out.
    const open = td.tasks().filter((t) => !t.labels.includes('homework') && !t.due?.recurring).slice(0, 4);
    for (const t of open.slice(0, 3)) expect((await app.req('POST', '/api/plan/must-do', { taskId: t.id })).status).toBe(200);
    const fourth = await app.req('POST', '/api/plan/must-do', { taskId: open[3].id });
    expect(fourth.status).toBeGreaterThanOrEqual(400);
    expect((await app.req('POST', '/api/plan/must-do', { taskId: open[3].id, optional: true })).status).toBe(200);
    const cap = (await app.req('GET', '/api/day/capacity')).json;
    expect(cap.loadMin).toBeGreaterThan(0);
    expect(cap.items.some((i: any) => i.lane === 'must')).toBe(true);

    // 9:05 PM: past the stop → Evening mode even before the ritual.
    app.setNow('2026-10-30T21:05:00-04:00');
    expect((await app.req('GET', '/api/day/state')).json.mode).toBe('evening');

    // Shutdown: one new loop for tomorrow, carry an unfinished must-do with a next action, phone out.
    const check = (await app.req('POST', '/api/shutdown/check', { items: [], phoneOut: true })).json;
    const decisions = (check.deadlines ?? check.uncovered ?? []).map((d: any) => ({ key: d.key, status: 'risk', reason: 'Handled in the morning' }));
    const fin = await app.req('POST', '/api/shutdown/finish', {
      items: [{ text: 'Ask Dr. Lim about the poster template', nextAction: 'Email Dr. Lim one question', when: 'tomorrow' }],
      carry: [{ taskId: open[0].id, nextAction: 'Open the doc and write one sentence' }],
      mustDos: [], decisions, phoneOut: true,
    });
    expect([200, 201]).toContain(fin.status);
    const st = (await app.req('GET', '/api/day/state')).json;
    expect(st.shutdownAt).toBeTruthy();
    expect(td.meta(open[0].id)).toMatchObject({ carryCount: 1, nextAction: 'Open the doc and write one sentence' });

    // Evening capture lands for tomorrow.
    const cap2 = await app.req('POST', '/api/capture', { text: 'Buy poster board' });
    expect(cap2.json.message).toMatch(/tomorrow/i);

    // Saturday (off-day) morning check-in: 10:10 PM → 6:40 AM = 8h30.
    app.setNow('2026-10-31T07:00:00-04:00');
    const sat = await app.req('POST', '/api/checkin/submit', { bedtime: '22:10', wakeTime: '06:40', energy: 5 });
    expect(sat.json.sleepMin).toBe(510);
    const lastNight = (await app.req('GET', '/api/capture/last-night')).json;
    expect(lastNight.some((i: any) => /poster board/i.test(i.content ?? i.text))).toBe(true);

    // Sunday Nov 1: clocks fell back. Bed 10:00 PM EDT, up 6:30 AM EST = 9h30 in bed.
    app.setNow('2026-11-01T07:00:00-05:00');
    const sun = await app.req('POST', '/api/checkin/submit', { bedtime: '22:00', wakeTime: '06:30', energy: 6 });
    expect(sun.json.sleepMin).toBe(570);
    const anchors = (await app.req('GET', '/api/day/anchors?date=2026-11-01')).json;
    expect(anchors.hardStop).toBe('2026-11-01T21:00:00.000-05:00');
  });
});
