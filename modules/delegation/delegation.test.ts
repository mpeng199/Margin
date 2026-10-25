import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import type { DelegationService } from './manifest';
import { nextCheckinDate } from './manifest';

const boot = () => testApp({ at: '2026-10-26T16:00:00-04:00', only: ['delegation', 'projects'] });

describe('delegation module', () => {
  it('seeds the script library once and supports add, edit, delete', async () => {
    const app = await boot();
    const d = app.ctx.service<DelegationService>('delegation');
    const seeds = d.scripts();
    expect(seeds.map((s) => s.body)).toEqual([
      'I’m at capacity through January. I can do X in February, or I can point you to Y.',
      'I can do this if I drop Z. Which matters more to you?',
    ]);
    const added = (await app.req('POST', '/api/delegation/scripts', { title: 'Pause', body: 'I’m pausing this until spring.' })).json;
    await app.req('PATCH', `/api/delegation/scripts/${added.id}`, { body: 'I’m pausing this until April.' });
    expect(d.scripts().find((s) => s.id === added.id)!.body).toMatch(/April/);
    await app.req('DELETE', `/api/delegation/scripts/${seeds[0].id}`);
    expect(d.scripts()).toHaveLength(2);
  });

  it('Draft with Claude is unavailable without the ai service and never sends', async () => {
    const app = await boot();
    expect((await app.req('GET', '/api/delegation/draft/available')).json.enabled).toBe(false);
    const r = await app.req('POST', '/api/delegation/draft', { situation: 'Club asks me to chair a new committee' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Claude is turned off/);
  });

  it('functions CRUD through the route the onboarding screen calls (owner may be null)', async () => {
    const app = await boot();
    const d = app.ctx.service<DelegationService>('delegation');
    const r = await app.req('POST', '/api/delegation/functions', { projectId: 'p1', name: 'Editing and production', owner: null, cadence: 'weekly', checkinMin: 20 });
    expect(r.status).toBe(200);
    expect(r.json.owner).toBeNull();
    expect(r.json.checkinMin).toBe(20);
    await app.req('PATCH', `/api/delegation/functions/${r.json.id}`, { owner: 'Maya', decisionRights: 'Accepts or rejects edits', goodEnough: 'Two reviewers per paper, within 10 days', dueDate: '2026-11-15' });
    const f = d.functions('p1')[0];
    expect(f).toMatchObject({ owner: 'Maya', decisionRights: 'Accepts or rejects edits', goodEnough: 'Two reviewers per paper, within 10 days', dueDate: '2026-11-15', cadence: 'weekly' });
    expect(d.functions('other')).toHaveLength(0);
  });

  it('due check-ins: weekly cadence, only owned functions, resets after logging, DST-safe', async () => {
    const app = await boot();
    const d = app.ctx.service<DelegationService>('delegation');
    const a = d.addFunction({ projectId: 'p1', name: 'Manuscript intake', owner: 'Sam' });
    d.addFunction({ projectId: 'p1', name: 'Operations', owner: null });
    // Created 2026-10-26 → first check-in due 2026-11-02, the day after clocks fall back.
    expect(a.nextCheckin).toBe('2026-11-02');
    expect(d.dueCheckins('2026-11-01')).toHaveLength(0);
    const due = d.dueCheckins('2026-11-02');
    expect(due.map((x) => x.name)).toEqual(['Manuscript intake']);
    expect(due[0].overdueDays).toBe(0);
    expect(d.dueCheckins('2026-11-05')[0].overdueDays).toBe(3);
    app.setNow('2026-11-05T10:00:00-05:00');
    d.logCheckin(a.id, 'Sam is behind on reviewer emails; moved two to Priya.');
    expect(d.fn(a.id)!.lastCheckin).toBe('2026-11-05');
    expect(d.fn(a.id)!.nextCheckin).toBe('2026-11-12');
    expect(d.dueCheckins('2026-11-11')).toHaveLength(0);
    expect(d.checkins({ functionId: a.id })[0].note).toMatch(/reviewer emails/);
    expect(nextCheckinDate('2026-10-31', 'weekly')).toBe('2026-11-07');
    expect(nextCheckinDate('2026-10-31', 'biweekly')).toBe('2026-11-14');
    expect(nextCheckinDate('2026-10-31', 'monthly')).toBe('2026-11-30');
  });

  it('waiting-on list: add, resolve, filter by project', async () => {
    const app = await boot();
    const d = app.ctx.service<DelegationService>('delegation');
    const w = d.addWaiting({ projectId: 'p1', what: 'Reviewer list from Priya', who: 'Priya', due: '2026-11-03' });
    d.addWaiting({ projectId: 'p2', what: 'Venue confirmation', who: 'Front desk' });
    expect(d.waiting('p1')).toHaveLength(1);
    expect(d.waiting()).toHaveLength(2);
    d.updateWaiting(w.id, { done: true });
    expect(d.waiting('p1')).toHaveLength(0);
    expect(d.waiting('p1', { includeDone: true })[0].doneAt).toBeTruthy();
  });

  it('delegation.checkin_overdue fires only once a check-in is past its date', async () => {
    const app = await boot();
    const d = app.ctx.service<DelegationService>('delegation');
    d.addFunction({ projectId: 'p1', name: 'Outreach', owner: 'Jo' });
    const cond = app.ctx.rules.catalog().conditions.find((c) => c.id === 'delegation.checkin_overdue');
    expect(cond?.available).toBe(true);
    const evaluate = async () => {
      const mod = (await import('./manifest')).default;
      return mod.rules!.conditions![0].evaluate(app.ctx, {});
    };
    expect((await evaluate()).met).toBe(false);
    app.setNow('2026-11-02T09:00:00-05:00');
    expect((await evaluate()).met).toBe(false); // due today is not overdue
    app.setNow('2026-11-04T09:00:00-05:00');
    const r = await evaluate();
    expect(r.met).toBe(true);
    expect(r.detail).toMatch(/Outreach check-in with Jo is 2 days overdue/);
  });
});
