import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import type { TodoistService } from '../todoist/manifest';
import type { DayService } from '../day/manifest';
import type { PlanService } from '../plan/manifest';
import type { CaptureService } from './manifest';

async function boot(at: string) {
  const app = await testApp({ at, only: ['day', 'todoist', 'google', 'today', 'plan', 'capture'] });
  const td = app.ctx.service<TodoistService>('todoist');
  const day = app.ctx.service<DayService>('day');
  const cap = app.ctx.service<CaptureService>('capture');
  await td.sync();
  const rows = () => app.ctx.db.all<{ text: string; for_date: string | null; status: string; outcome: string | null; task_id: string | null }>('SELECT * FROM capture_items ORDER BY captured_at');
  const withAi = (ai: unknown) => {
    const orig = app.ctx.maybe.bind(app.ctx);
    (app.ctx as any).maybe = (id: string) => (id === 'ai' ? ai : orig(id));
  };
  return { app, td, day, cap, rows, withAi, inboxId: () => td.inboxId() };
}

describe('capture: day vs evening', () => {
  it('in the day it is a plain Todoist quick add (Todoist parses the date)', async () => {
    const { app, td, rows, inboxId } = await boot('2026-10-26T16:00:00-04:00');
    const r = await app.req('POST', '/api/capture', { text: 'Buy poster board tomorrow p2' });
    expect(r.status).toBe(200);
    expect(r.json.message).toBe('Added to Todoist.');
    const t = td.task(r.json.taskId)!;
    expect(t).toMatchObject({ content: 'Buy poster board', projectId: inboxId(), priority: 2 });
    expect(t.due!.date).toBe('2026-10-27');
    expect(rows()).toHaveLength(0); // nothing to show in the morning
    expect((await app.req('POST', '/api/capture', { text: '   ' })).status).toBe(400);
  });

  it('in Evening mode it lands in the Inbox undated and waits for tomorrow morning', async () => {
    const { app, td, rows, inboxId } = await boot('2026-10-26T21:30:00-04:00');
    const r = await app.req('POST', '/api/capture', { text: 'Ask Dr. Lim about the poster draft' });
    expect(r.json.message).toBe('Saved for tomorrow.');
    const t = td.task(r.json.taskId)!;
    expect(t.projectId).toBe(inboxId());
    expect(t.due).toBeNull();
    expect(rows()).toMatchObject([{ for_date: '2026-10-27', status: 'open', task_id: t.id }]);

    // Not shown tonight; shown tomorrow morning.
    expect((await app.req('GET', '/api/capture/last-night')).json).toEqual([]);
    app.setNow('2026-10-27T07:00:00-04:00');
    const morning = (await app.req('GET', '/api/capture/last-night')).json;
    expect(morning).toMatchObject([{ taskId: t.id, content: 'Ask Dr. Lim about the poster draft', forDate: '2026-10-27' }]);
  });

  it('on the off-day (mode is not "day") it behaves like the evening', async () => {
    const { app, day, rows } = await boot('2026-10-24T11:00:00-04:00'); // Saturday morning
    (day as any).mode = () => 'offday';
    const r = await app.req('POST', '/api/capture', { text: 'Idea for the donut render' });
    expect(r.json.message).toBe('Saved for tomorrow.');
    expect(rows()[0]).toMatchObject({ for_date: '2026-10-25', status: 'open' });
  });

  it('Make Must-Do, Schedule and Keep in Inbox each resolve the item', async () => {
    const { app, td, cap, rows } = await boot('2026-10-26T21:30:00-04:00');
    const ids: string[] = [];
    for (const text of ['Draft thank-you note', 'Renew library card', 'Look up REU deadlines']) {
      ids.push((await app.req('POST', '/api/capture', { text })).json.taskId);
    }
    app.setNow('2026-10-27T07:00:00-04:00');
    const items = cap.lastNight();
    expect(items).toHaveLength(3);

    const must = await app.req('POST', `/api/capture/items/${items[0].id}/must-do`, {});
    expect(must.status).toBe(200);
    expect(td.task(ids[0])!.meta.mustDoDate).toBe('2026-10-27');

    const sched = await app.req('POST', `/api/capture/items/${items[1].id}/schedule`, { date: '2026-10-30' });
    expect(sched.status).toBe(200);
    expect(td.task(ids[1])!.due!.date).toBe('2026-10-30');

    expect((await app.req('POST', `/api/capture/items/${items[2].id}/keep`)).status).toBe(200);
    expect(td.task(ids[2])!.due).toBeNull();

    expect(cap.lastNight()).toEqual([]);
    expect(rows().map((r) => r.outcome)).toEqual(['must-do', 'scheduled:2026-10-30', 'inbox']);
  });

  it('Make Must-Do reports a full day instead of silently exceeding the cap', async () => {
    const { app, td, cap } = await boot('2026-10-26T21:30:00-04:00');
    const plan = app.ctx.service<PlanService>('plan');
    const id = (await app.req('POST', '/api/capture', { text: 'One more thing' })).json.taskId;
    app.setNow('2026-10-27T07:00:00-04:00');
    for (const t of td.tasks().slice(0, 3)) await plan.addMustDo(t.id, '2026-10-27');
    const r = await app.req('POST', `/api/capture/items/${cap.lastNight()[0].id}/must-do`, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('cap_reached');
    expect(td.task(id)!.meta.mustDoDate).toBeNull();
    expect(cap.lastNight()).toHaveLength(1);
  });

  it('keeps the text when Todoist is unreachable and adds it on retry', async () => {
    const { app, td, cap, rows } = await boot('2026-10-26T21:30:00-04:00');
    const real = td.quickAdd.bind(td);
    (td as any).quickAdd = async () => { throw new Error('offline'); };
    const r = await app.req('POST', '/api/capture', { text: 'Remember to send the abstract' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ queued: true });
    expect(r.json.message).toMatch(/Saved on this Mac/);
    expect(rows()[0]).toMatchObject({ status: 'queued', for_date: '2026-10-27' });
    expect(await cap.flushQueue()).toBe(0);

    (td as any).quickAdd = real;
    expect(await cap.flushQueue()).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'open' });
    expect(td.task(rows()[0].task_id!)!.content).toBe('Remember to send the abstract');
  });
});

describe('capture across the Nov 1, 2026 clock change', () => {
  it('Saturday night capture shows up Sunday morning (after the 25-hour night)', async () => {
    const { app, cap, rows } = await boot('2026-10-31T22:00:00-04:00');
    const r = await app.req('POST', '/api/capture', { text: 'Pick up the poster tube' });
    expect(r.json.message).toBe('Saved for tomorrow.');
    expect(rows()[0].for_date).toBe('2026-11-01');
    app.setNow('2026-11-01T07:00:00-05:00');
    expect(cap.lastNight().map((x) => x.content)).toEqual(['Pick up the poster tube']);
    expect(cap.lastNight('2026-10-31')).toEqual([]);
  });
});

describe('Claude fallback', () => {
  const ai = (run: (f: string, i: any) => Promise<any>) => ({ enabled: () => true, run });

  it('parses on request, adds only after confirmation, and tolerates failure', async () => {
    const { app, td, withAi, rows } = await boot('2026-10-26T21:30:00-04:00');
    withAi(ai(async (feature, input) => {
      expect(feature).toBe('parse_capture');
      if (input.text.includes('boom')) throw new Error('model down');
      return { text: '', data: { content: 'Email Dr. Lim the poster', dueString: 'friday', priority: 2, estimateMin: 20, junk: 1 } };
    }));
    expect((await app.req('GET', '/api/capture/status')).json.smart).toBe(true);

    const p = await app.req('POST', '/api/capture/smart', { text: 'poster thing for lim fri' });
    expect(p.json).toMatchObject({ ok: true, parsed: { content: 'Email Dr. Lim the poster', dueString: 'friday', priority: 2, estimateMin: 20 } });
    expect(rows()).toHaveLength(0); // parsing adds nothing

    const failed = await app.req('POST', '/api/capture/smart', { text: 'boom' });
    expect(failed.status).toBe(200);
    expect(failed.json).toMatchObject({ ok: false, parsed: { content: 'boom' } });

    const add = await app.req('POST', '/api/capture/smart/add', p.json.parsed);
    expect(add.json.message).toBe('Saved for tomorrow.');
    const t = td.task(add.json.taskId)!;
    expect(t).toMatchObject({ content: 'Email Dr. Lim the poster', priority: 2, estimateMin: 20 });
    expect(t.due!.date).toBe('2026-10-30');
    expect(rows()).toMatchObject([{ for_date: '2026-10-27', status: 'open' }]);
  });

  it('is off without Claude or when the setting is off', async () => {
    const { app, withAi } = await boot('2026-10-26T16:00:00-04:00');
    expect((await app.req('GET', '/api/capture/status')).json.smart).toBe(false);
    expect((await app.req('POST', '/api/capture/smart', { text: 'x' })).status).toBe(409);
    withAi(ai(async () => ({ data: {} })));
    app.ctx.settings.set('capture', { useClaudeFallback: false });
    expect((await app.req('GET', '/api/capture/status')).json.smart).toBe(false);
  });
});
