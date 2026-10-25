import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import type { TodoistService } from '../todoist/manifest';
import type { GoogleService } from '../google/manifest';
import type { DayService } from '../day/manifest';
import type { OffdayService } from './manifest';
import offday from './manifest';

const boot = (at: string) => testApp({ at, only: ['day', 'todoist', 'google', 'offday'] });

describe('offday: leisure list', () => {
  it('refuses anything that would upset you to get nothing from, and requires an answer', async () => {
    const app = await boot('2026-10-28T16:00:00-04:00');
    const refused = await app.req('POST', '/api/offday/leisure', { title: 'Polish the RSI essay', upsetIfNothing: true });
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatch(/it’s work/);
    expect((await app.req('POST', '/api/offday/leisure', { title: 'Walk without headphones' })).status).toBe(400);
    expect((await app.req('POST', '/api/offday/leisure', { title: '   ', upsetIfNothing: false })).status).toBe(400);
    expect(app.ctx.service<OffdayService>('offday').leisure()).toEqual([]);

    const ok = await app.req('POST', '/api/offday/leisure', { title: 'Draw', upsetIfNothing: false });
    expect(ok.status).toBe(200);
    const svc = app.ctx.service<OffdayService>('offday');
    expect(svc.leisure()).toEqual([{ id: ok.json.id, title: 'Draw', test: true }]);
    await app.req('DELETE', `/api/offday/leisure/${ok.json.id}`);
    expect(svc.leisure()).toEqual([]);
  });
});

describe('offday: the day-before warning', () => {
  it('finds the next off-day, lists what is due and busy on it, and moves the tasks in one change set', async () => {
    const app = await boot('2026-10-30T16:00:00-04:00'); // Friday; Saturday Oct 31 is the off-day
    const td = app.ctx.service<TodoistService>('todoist');
    const a = (await td.add({ content: 'Finish the lab write-up', dueDate: '2026-10-31' }))!;
    const b = (await td.add({ content: 'Call the orthodontist', dueDate: '2026-10-31T10:00:00' }))!;
    await td.sync();
    await app.ctx.service<GoogleService>('google').sync();
    const svc = app.ctx.service<OffdayService>('offday');
    expect(svc.nextOffDay()).toBe('2026-10-31');

    const w = (await app.req('GET', '/api/offday/warning')).json;
    expect(w.show).toBe(true);
    expect(w.tasks.map((t: any) => t.id)).toEqual(expect.arrayContaining([a, b]));
    expect(w.events.map((e: any) => e.title)).toContain('Columbia SHP');
    expect(w.targets.map((x: any) => x.label)).toEqual(['Sunday', 'Monday']);

    const moved = await app.req('POST', '/api/offday/warning/move', { date: '2026-11-01' }); // Sunday, the day the clocks change
    expect(moved.status).toBe(200);
    expect(moved.json.status).toBe('applied');
    const set = app.ctx.changes.get(moved.json.id)!;
    expect(set.changes.every((c) => c.kind === 'todoist.task.reschedule')).toBe(true);
    expect(set.changes).toHaveLength(moved.json.moved);

    await td.sync();
    expect(td.task(a)!.due!.date).toBe('2026-11-01');
    expect(td.task(b)!.due).toMatchObject({ date: '2026-11-01', time: '10:00' });
    expect(svc.tasksOnOffDay('2026-10-31')).toEqual([]);
    expect((await app.req('POST', '/api/offday/warning/move', { date: '2026-11-01' })).status).toBe(409); // nothing left to move
    expect((await app.req('POST', '/api/offday/warning/move', { date: '2026-11-05' })).status).toBe(400);
  });

  it('shows nothing earlier in the week, and on the day itself the next off-day is today', async () => {
    const app = await boot('2026-10-28T16:00:00-04:00');
    expect((await app.req('GET', '/api/offday/warning')).json).toMatchObject({ show: false, tasks: [], events: [] });
    app.setNow('2026-10-31T11:00:00-04:00');
    expect(app.ctx.service<DayService>('day').isOffDay()).toBe(true);
    expect(app.ctx.service<OffdayService>('offday').nextOffDay()).toBe('2026-10-31');
  });
});

describe('offday: rule condition offday.worked', () => {
  it('counts off-days where work was opened during the daytime, not after the stop', async () => {
    const app = await boot('2026-10-31T11:00:00-04:00');
    const cond = offday.rules!.conditions![0];
    expect((await cond.evaluate(app.ctx, { times: 1, windowDays: 28 })).met).toBe(false);
    app.ctx.service<DayService>('day').breakStop('/projects/shp');
    const r = await cond.evaluate(app.ctx, { times: 1, windowDays: 28 });
    expect(r.met).toBe(true);
    expect(r.detail).toMatch(/1 time in the last 28 days/);
  });
});
