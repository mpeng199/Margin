import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import { fromISO, minutesBetween } from '../../src/core/time';
import focus, { type FocusService } from './manifest';

const MON = '2026-10-26T16:00:00-04:00';
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

async function boot(at = MON) {
  const app = await testApp({ at, only: ['focus'] });
  const svc = app.ctx.service<FocusService>('focus');
  const stop = fromISO((await app.req('GET', '/api/day/state')).json.anchors.effectiveStop);
  return { ...app, svc, stop: stop.toISO()! };
}

describe('focus timer', () => {
  it('counts elapsed minutes from instants across the Nov 1 repeated hour', async () => {
    // 01:30 EDT -> 01:30 EST is 60 real minutes, though the wall clock reads the same.
    expect(minutesBetween(fromISO('2026-11-01T01:30:00-04:00'), fromISO('2026-11-01T01:30:00-05:00'))).toBe(60);
    const a = await boot('2026-11-01T01:30:00-04:00');
    // Restore a running session from the database, as after a daemon restart.
    a.ctx.db.run(
      `INSERT INTO sessions (id, project_id, task_id, date, start, cutoff, work_min, break_min, phase, phase_start, banked_ms, run_since, status)
       VALUES ('s1', 'p1', '', '2026-11-01', '2026-11-01T01:30:00-04:00', '2026-11-01T20:00:00-05:00', 120, 10, 'work', '2026-11-01T01:30:00-04:00', 0, '2026-11-01T01:30:00-04:00', 'active')`,
    );
    a.setNow('2026-11-01T01:30:00-05:00');
    expect(a.svc.active()!.workedMin).toBe(60);
    const out = await a.req('POST', '/api/focus/stop');
    expect(out.json.log.minutes).toBe(60);
    expect(a.svc.timeLogs()[0]).toMatchObject({ projectId: 'p1', minutes: 60, start: '2026-11-01T01:30:00-04:00' });
  });

  it('runs 50 work then 10 break, logs once, and survives a pause', async () => {
    const a = await boot();
    const events: any[] = [];
    a.ctx.bus.on('focus.completed', (p) => { events.push(p); });
    expect((await a.req('POST', '/api/focus/start', { projectId: 'p1', taskId: 't1' })).status).toBe(200);
    expect((await a.req('POST', '/api/focus/start', { projectId: 'p2' })).status).toBe(409);
    a.setNow(plus(MON, 20));
    await a.req('POST', '/api/focus/pause');
    a.setNow(plus(MON, 50)); // 30 minutes paused do not count
    expect(a.svc.active()).toMatchObject({ paused: true, workedMin: 20, endsAt: null });
    await a.req('POST', '/api/focus/resume');
    a.setNow(plus(MON, 80)); // 20 + 30 = 50 worked
    expect(a.svc.active()).toMatchObject({ phase: 'break' });
    await flush();
    expect(events).toEqual([expect.objectContaining({ projectId: 'p1', taskId: 't1', minutes: 50, date: '2026-10-26' })]);
    expect((await a.req('POST', '/api/focus/pause')).status).toBe(409); // breaks don't pause
    a.setNow(plus(MON, 95)); // break over
    expect(a.svc.active()).toBeNull();
    expect(a.svc.timeLogs()).toHaveLength(1);
  });

  it('ends at the effective stop and warns ten minutes before', async () => {
    const a = await boot();
    a.setNow(plus(a.stop, -20));
    expect((await a.req('POST', '/api/focus/start', { projectId: 'p1' })).status).toBe(200);
    a.setNow(plus(a.stop, -9));
    expect(a.svc.active()).toMatchObject({ stopWarning: true, cutoffLimited: true, minutesToCutoff: 9 });
    a.setNow(plus(a.stop, 5));
    expect(a.svc.active()).toBeNull();
    const [log] = a.svc.timeLogs();
    expect(log.minutes).toBe(20);
    expect(log.end).toBe(fromISO(a.stop).toISO());
    const late = await a.req('POST', '/api/focus/start', { projectId: 'p1' });
    expect(late.status).toBe(409);
    expect(late.json.error).toMatch(/No new focus blocks tonight/);
  });

  it('plans notifications keyed by session id', async () => {
    const a = await boot();
    const id = (await a.req('POST', '/api/focus/start', { projectId: 'p1' })).json.id as string;
    const plan = focus.notifications!(a.ctx, '2026-10-26');
    expect(plan.map((n) => n.key)).toEqual([`focus.break:${id}`, `focus.breakend:${id}`]);
    expect(plan[0]).toMatchObject({ category: 'wellbeing', title: 'Break', body: 'Ten minutes away from screens — look out a window, refill water.' });
    expect(plan[0].at.toISO()).toBe(fromISO(plus(MON, 50)).toISO());
    expect(focus.notifications!(a.ctx, '2026-10-25')).toEqual([]);
    // Still planned after the block settles, so a late tick can't lose the prompt.
    a.setNow(plus(MON, 55));
    expect(focus.notifications!(a.ctx, '2026-10-26').map((n) => n.key)).toContain(`focus.break:${id}`);
    // Within ten minutes of the stop: the warning is keyed too.
    await a.req('POST', '/api/focus/stop');
    a.setNow(plus(a.stop, -30));
    const id2 = (await a.req('POST', '/api/focus/start', { projectId: 'p1' })).json.id as string;
    expect(focus.notifications!(a.ctx, '2026-10-26').map((n) => n.key)).toContain(`focus.stopwarn:${id2}`);
  });

  it('logs time per project', async () => {
    const a = await boot();
    for (const [p, offset] of [['p1', 0], ['p2', 70], ['p1', 140]] as const) {
      a.setNow(plus(MON, offset));
      await a.req('POST', '/api/focus/start', { projectId: p });
      a.setNow(plus(MON, offset + 30));
      await a.req('POST', '/api/focus/stop');
    }
    const sum = (q: any) => a.svc.timeLogs(q).reduce((s, l) => s + l.minutes, 0);
    expect(sum({ projectId: 'p1' })).toBe(60);
    expect(sum({ projectId: 'p2' })).toBe(30);
    expect(sum({ from: '2026-10-27' })).toBe(0);
    expect(sum({ from: '2026-10-26', to: '2026-10-26' })).toBe(90);
    const logs = (await a.req('GET', '/api/focus/logs?projectId=p2')).json;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ projectId: 'p2', minutes: 30, taskId: '' });
  });
});
