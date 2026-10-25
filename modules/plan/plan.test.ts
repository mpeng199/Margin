import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import type { TodoistService, Task } from '../todoist/manifest';
import type { GoogleService } from '../google/manifest';
import type { DayService } from '../day/manifest';
import manifest, { type PlanService } from './manifest';

const D = '2026-10-26'; // Monday; stop 9:00 PM (wake 6:30)

async function boot(at = '2026-10-26T16:00:00-04:00') {
  const app = await testApp({ at, only: ['day', 'todoist', 'google', 'today', 'plan'] });
  const td = app.ctx.service<TodoistService>('todoist');
  const plan = app.ctx.service<PlanService>('plan');
  const day = app.ctx.service<DayService>('day');
  await td.sync();
  await app.ctx.service<GoogleService>('google').sync();
  const find = (s: string): Task => td.tasks({ includeDone: true }).find((t) => t.content.includes(s))!;
  const events = (name: string) => app.ctx.db.all<{ payload: string }>('SELECT payload FROM events WHERE name = ?', name).map((r) => JSON.parse(r.payload));
  /** Pretend a projects module exists. */
  const fakeProjects = (p: { isHidden?: (t: Task) => boolean; projectForTask?: (t: Task) => any }) => {
    const orig = app.ctx.maybe.bind(app.ctx);
    (app.ctx as any).maybe = (id: string) => (id === 'projects' ? { filterForMain: (e: any[]) => e, ...p } : orig(id));
  };
  return { app, td, plan, day, find, events, fakeProjects };
}

describe('must-dos and the cap', () => {
  it('allows 3, forces a swap or optional on the 4th, and mirrors the Todoist label', async () => {
    const { app, td, plan, find } = await boot();
    const [a, b, c, d] = ['Email Dr. Lim', 'Draft RSI essay', 'Assign two new manuscripts', 'Update lab notebook'].map((s) => find(s).id);
    for (const id of [a, b, c]) await plan.addMustDo(id, D);
    expect(plan.mustDoState(D)).toMatchObject({ cap: 3, used: 3 });
    expect(td.task(a)!.labels).toContain('must-do');

    const blocked = await app.req('POST', '/api/plan/must-do', { taskId: d, date: D });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: 'cap_reached', cap: 3 });
    expect(blocked.json.current).toHaveLength(3);
    expect(td.task(d)!.meta.mustDoDate).toBeNull();

    // Optional doesn't count toward the cap, and it carries no load.
    const opt = await app.req('POST', '/api/plan/must-do', { taskId: d, date: D, optional: true });
    expect(opt.status).toBe(200);
    expect(plan.mustDoState(D).used).toBe(3);
    expect(plan.mustDos(D).map((t) => t.id)).toEqual(expect.arrayContaining([a, b, c, d]));
    expect(plan.loadFor(D).some((i) => i.id === d)).toBe(false);
    expect(td.task(d)!.labels).not.toContain('must-do');

    // Swap: the new one goes in, the old one leaves the must-do list (task stays in Todoist).
    const e = find('Reply to Red Cross').id;
    const swap = await app.req('POST', '/api/plan/must-do', { taskId: e, date: D, swapOut: a });
    expect(swap.status).toBe(200);
    expect(td.task(a)!.meta.mustDoDate).toBeNull();
    expect(td.task(a)!.labels).not.toContain('must-do');
    expect(td.task(e)!.meta.mustDoDate).toBe(D);
    expect(plan.mustDoState(D).used).toBe(3);
  });

  it('counts finished must-dos against the cap, and puts required before optional', async () => {
    const { td, plan, find } = await boot();
    const ids = ['Email Dr. Lim', 'Draft RSI essay', 'Assign two new manuscripts'].map((s) => find(s).id);
    for (const id of ids) await plan.addMustDo(id, D);
    await td.close(ids[0]);
    expect(plan.mustDoState(D).used).toBe(3);
    await expect(plan.addMustDo(find('Update lab notebook').id, D)).rejects.toMatchObject({ status: 409 });
    await plan.addMustDo(find('Update lab notebook').id, D, { optional: true });
    const list = plan.mustDos(D);
    expect(list.at(-1)!.content).toContain('Update lab notebook');
    expect(list).toHaveLength(3); // two open required + one optional; the finished one is not "left to do"
  });

  it('mirrors flag changes made by other paths (a change set) onto the label', async () => {
    const { app, td, find } = await boot();
    const t = find('Draft RSI essay');
    const set = app.ctx.changes.propose({ source: 'claude', title: 'Must-dos', changes: [
      { kind: 'task.meta', title: 'Make a must-do', payload: { taskId: t.id, patch: { mustDoDate: D, optional: false } } },
    ] });
    await app.ctx.changes.apply(set.id);
    await flush();
    await app.ctx.service<PlanService>('plan').mirror(t.id); // wait for the serialized mirror queue
    expect(td.task(t.id)!.labels).toContain('must-do');
  });
});

describe('homework lane and load', () => {
  it('puts labelled, flagged and school-project tasks in the homework lane, outside the cap', async () => {
    const { td, plan, find, fakeProjects } = await boot();
    const chem = find('AP Chem');
    expect(plan.homework(D).map((t) => t.id)).toContain(chem.id);
    expect(plan.mustDos(D).map((t) => t.id)).not.toContain(chem.id);

    const flagged = find('Email Dr. Lim');
    td.setMeta(flagged.id, { homework: true });
    expect(plan.homework(D).map((t) => t.id)).toContain(flagged.id);

    const school = find('Assign two new manuscripts');
    fakeProjects({ projectForTask: (t) => (t.id === school.id ? { id: 'p-school', name: 'School', isSchool: true } : null) });
    expect(plan.homework(D).map((t) => t.id)).toContain(school.id);

    // Fill the cap with other tasks: homework doesn't use up slots.
    for (const s of ['Draft RSI essay', 'Update lab notebook', 'Reply to Red Cross']) await plan.addMustDo(find(s).id, D);
    expect(plan.mustDoState(D).used).toBe(3);
    expect(plan.loadFor(D).filter((i) => i.lane === 'homework').length).toBeGreaterThanOrEqual(3);
  });

  it('loadFor pads estimates ×1.5, defaults missing estimates, and skips hidden tasks', async () => {
    const { app, td, plan, day, find, fakeProjects } = await boot();
    const chem = find('AP Chem');
    const lim = find('Email Dr. Lim');
    await td.setEstimate(chem.id, 60);
    const load = plan.loadFor(D);
    expect(load.find((i) => i.id === chem.id)).toMatchObject({ estimateMin: 60, paddedMin: 90, lane: 'homework' });
    // no estimate → defaultEstimateMin (30) → 45
    expect(load.find((i) => i.id === lim.id)).toMatchObject({ estimateMin: 30, paddedMin: 45, lane: 'other' });
    // overdue work counts today
    expect(load.some((i) => i.title.includes('Red Cross'))).toBe(true);
    // tomorrow's tasks don't
    expect(load.some((i) => i.title.includes('Draft RSI essay'))).toBe(false);

    fakeProjects({ isHidden: (t) => t.id === chem.id || t.id === lim.id });
    const after = plan.loadFor(D);
    expect(after.some((i) => i.id === chem.id || i.id === lim.id)).toBe(false);
    expect(plan.carryOver(D).some((t) => t.id === chem.id)).toBe(false);
    // day.capacity consumes the same list
    expect(day.capacity(D).items.some((i) => i.id === chem.id)).toBe(false);
    expect(day.capacity(D).loadMin).toBe(after.reduce((s, i) => s + i.paddedMin, 0));

    app.ctx.settings.set('plan', { includeOverdue: false });
    expect(plan.loadFor(D).some((i) => i.title.includes('Red Cross'))).toBe(false);
  });

  it('leaves out delegated tasks', async () => {
    const { td, plan, find } = await boot();
    const t = find('Email Dr. Lim');
    td.setMeta(t.id, { owner: 'Priya' });
    expect(plan.loadFor(D).some((i) => i.id === t.id)).toBe(false);
  });
});

describe('plan acceptance', () => {
  it('blocks acceptance while load exceeds free time, then accepts and emits plan.accepted', async () => {
    const { app, td, plan, find, events } = await boot();
    await td.setEstimate(find('Email Dr. Lim').id, 600); // 600 × 1.5 = 900 > 870 free
    const p = plan.dayPlan(D);
    expect(p.capacity.status).toBe('over');
    expect(p.canAccept).toBe(false);
    const refused = await app.req('POST', '/api/plan/accept', { date: D });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('triage_first');
    expect(plan.acceptedAt(D)).toBeNull();

    // Remedy: shrink the estimate.
    await td.setEstimate(find('Email Dr. Lim').id, 30);
    const ok = await app.req('POST', '/api/plan/accept', { date: D });
    expect(ok.status).toBe(200);
    expect(plan.acceptedAt(D)).not.toBeNull();
    await flush();
    expect(events('plan.accepted')).toEqual([{ date: D }]);
  });

  it('refuses a plan with more required must-dos than the cap', async () => {
    const { td, plan, find } = await boot();
    for (const s of ['Email Dr. Lim', 'Draft RSI essay', 'Assign two new manuscripts', 'Update lab notebook']) td.setMeta(find(s).id, { mustDoDate: D });
    expect(plan.dayPlan(D).canAccept).toBe(false);
    expect(() => plan.accept(D)).toThrow(/limit of 3/);
  });

  it('bulk "move" becomes a change set; a single move applies directly', async () => {
    const { app, td, find } = await boot();
    const a = find('Email Dr. Lim').id, b = find('Assign two new manuscripts').id;
    const one = await app.req('POST', '/api/plan/move', { taskIds: [a], date: '2026-10-28' });
    expect(one.json.changeSetId).toBeUndefined();
    expect(td.task(a)!.due!.date).toBe('2026-10-28');
    const bulk = await app.req('POST', '/api/plan/move', { taskIds: [b, find('Update lab notebook').id], date: '2026-10-29' });
    expect(bulk.json.changeSetId).toBeTruthy();
    expect(td.task(b)!.due!.date).toBe(D); // nothing moved until the set is applied
    await app.ctx.changes.apply(bulk.json.changeSetId);
    expect(td.task(b)!.due!.date).toBe('2026-10-29');
  });
});

describe('carry-over', () => {
  it('increments the count, moves the due date and must-do, saves the next action, and keeps recurrence', async () => {
    const { td, plan, find, events } = await boot();
    const t = find('Assign two new manuscripts');
    await plan.addMustDo(t.id, D);
    const rec = find('Update lab notebook'); // every weekday
    const out = await plan.carry([t.id, rec.id], '2026-10-27', { [t.id]: 'Open the reviewer sheet' });
    expect(out.carried).toEqual([t.id, rec.id]);
    const after = td.task(t.id)!;
    expect(after.meta).toMatchObject({ carryCount: 1, lastCarryDate: D, mustDoDate: '2026-10-27', nextAction: 'Open the reviewer sheet' });
    expect(after.due!.date).toBe('2026-10-27');
    expect(td.task(rec.id)!.due).toMatchObject({ date: '2026-10-27', recurring: true });
    await flush();
    expect(events('task.carried')).toEqual(expect.arrayContaining([{ taskId: t.id, count: 1 }]));
    // A later due date isn't pulled earlier.
    const later = find('Weekly Delphic');
    const dueBefore = later.due!.date;
    await plan.carry([later.id], '2026-10-27');
    expect(td.task(later.id)!.due!.date).toBe(dueBefore);
  });

  it('refuses at the third carry: there is no 4th roll', async () => {
    const { app, td, plan, find } = await boot();
    const t = find('Assign two new manuscripts');
    for (const to of ['2026-10-27', '2026-10-28', '2026-10-29']) {
      const r = await plan.carry([t.id], to);
      expect(r.carried).toEqual([t.id]);
    }
    expect(td.task(t.id)!.meta.carryCount).toBe(3);
    expect(plan.triageQueue().map((x) => x.id)).toEqual([t.id]);

    const refused = await plan.carry([t.id], '2026-10-30');
    expect(refused).toMatchObject({ carried: [], needsTriage: [t.id] });
    expect(td.task(t.id)!.meta.carryCount).toBe(3);
    expect(td.task(t.id)!.due!.date).toBe('2026-10-29');
    expect((await app.req('GET', '/api/plan/triage-queue')).json.map((x: any) => x.id)).toEqual([t.id]);
  });
});

describe('triage decisions', () => {
  const stuck = async (b: Awaited<ReturnType<typeof boot>>, s = 'Assign two new manuscripts') => {
    const t = b.find(s);
    b.td.setMeta(t.id, { carryCount: 3 });
    return t;
  };

  it('first: becomes must-do slot #1 tomorrow, displacing one into optional, and leaves the queue until its day passes', async () => {
    const b = await boot();
    const t = await stuck(b);
    const full = ['Email Dr. Lim', 'Draft RSI essay', 'Update lab notebook'].map((s) => b.find(s));
    for (const x of full) await b.plan.addMustDo(x.id, '2026-10-27');
    const out = await b.plan.triage(t.id, 'first');
    expect(out.displaced).toBeTruthy();
    const after = b.plan.mustDoState('2026-10-27');
    expect(after.used).toBe(3);
    expect(after.required.map((x) => x.id)).toContain(t.id);
    expect(after.optional.map((x) => x.id)).toEqual([out.displaced]);
    expect(b.plan.mustDos('2026-10-27')[0].id).toBe(t.id); // most-carried leads
    expect(b.plan.triageQueue()).toHaveLength(0);
    await flush();
    expect(b.events('task.triaged')).toEqual([{ taskId: t.id, decision: 'first' }]);

    // Tomorrow evening, still not done: back in the queue (no 4th roll).
    b.app.setNow('2026-10-27T21:30:00-04:00');
    expect(b.plan.triageQueue().map((x) => x.id)).toEqual([t.id]);
  });

  it('slot: creates a calendar block through a change set and moves the due date', async () => {
    const b = await boot();
    const t = await stuck(b);
    await b.td.setEstimate(t.id, 45);
    await expect(b.plan.triage(t.id, 'slot', { slotStart: '2026-10-27T20:45:00-04:00' })).rejects.toThrow(/stop/);
    await b.plan.triage(t.id, 'slot', { slotStart: '2026-10-27T19:00:00-04:00' });
    const ev = b.app.ctx.service<GoogleService>('google').eventsBetween('2026-10-27T00:00:00-04:00', '2026-10-28T00:00:00-04:00').find((e) => e.title.includes('Assign two new manuscripts'))!;
    expect(ev).toMatchObject({ marginKind: 'block', appOwned: true, start: '2026-10-27T19:00:00.000-04:00', end: '2026-10-27T19:45:00.000-04:00' });
    expect(b.td.task(t.id)!.due!.date).toBe('2026-10-27');
    expect(b.app.ctx.changes.list().find((s) => s.source === 'user')?.status).toBe('applied');
    expect(b.plan.triageQueue()).toHaveLength(0);
  });

  it('delegate: records the owner, adds the waiting label and a comment, and takes it off the plan', async () => {
    const b = await boot();
    const t = await stuck(b);
    await expect(b.plan.triage(t.id, 'delegate')).rejects.toThrow(/owner/);
    await b.plan.triage(t.id, 'delegate', { owner: 'Priya', reason: 'She runs reviewer intake' });
    const after = b.td.task(t.id)!;
    expect(after.meta.owner).toBe('Priya');
    expect(after.labels).toContain('waiting');
    expect(b.td.mock()!.notes().some((n) => n.item_id === t.id && n.content.includes('Priya'))).toBe(true);
    expect(b.plan.triageQueue()).toHaveLength(0);
    expect(b.plan.loadFor(D).some((i) => i.id === t.id)).toBe(false);
  });

  it('drop: completes with a note (never deletes) and emits task.dropped', async () => {
    const b = await boot();
    const t = await stuck(b);
    await b.plan.triage(t.id, 'drop', { reason: 'Not mine to do' });
    expect(b.td.task(t.id)!.checked).toBe(true);
    expect(b.td.mock()!.notes().some((n) => n.content === 'Dropped in Margin: Not mine to do')).toBe(true);
    expect(b.plan.triageQueue()).toHaveLength(0);
    await flush();
    expect(b.events('task.dropped')).toHaveLength(1);
    expect(b.events('task.triaged')).toEqual([{ taskId: t.id, decision: 'drop' }]);
  });
});

describe('urgency check', () => {
  it('asks "What actually happens if this waits a week?" before a bump, stores the answer, then applies', async () => {
    const { app, td, plan, find } = await boot();
    const t = find('Draft RSI essay'); // p2
    expect(t.priority).toBe(2);
    expect(plan.needsUrgencyAnswer(t.id, 1)).toBe(true);
    expect(plan.needsUrgencyAnswer(t.id, 3)).toBe(false);

    const no = await app.req('POST', '/api/plan/priority', { taskId: t.id, priority: 1 });
    expect(no.status).toBe(400);
    expect(no.json.code).toBe('answer_required');
    expect((await app.req('POST', '/api/plan/priority', { taskId: t.id, priority: 1, answer: '   ' })).status).toBe(400);
    expect(td.task(t.id)!.priority).toBe(2);

    const yes = await app.req('POST', '/api/plan/priority', { taskId: t.id, priority: 1, answer: 'I would miss the RSI draft check-in.' });
    expect(yes.status).toBe(200);
    expect(td.task(t.id)!.priority).toBe(1);
    expect(plan.urgencyAnswers()[0]).toMatchObject({ task_id: t.id, from_priority: 2, to_priority: 1, answer: 'I would miss the RSI draft check-in.' });

    // Lowering a priority needs no answer.
    expect((await app.req('POST', '/api/plan/priority', { taskId: t.id, priority: 3 })).status).toBe(200);
    expect(td.task(t.id)!.priority).toBe(3);
  });
});

describe('deep block and message slots', () => {
  it('creates one 60–90 minute block inside a free gap, only after the click, never past the stop', async () => {
    const { app, plan } = await boot();
    const g = app.ctx.service<GoogleService>('google');
    const body = (o: object) => ({ date: '2026-10-27', project: 'Delphic Medicine', start: '15:00', minutes: 75, ...o });
    expect((await app.req('POST', '/api/plan/deep-block', body({ minutes: 120 }))).status).toBe(400);
    expect((await app.req('POST', '/api/plan/deep-block', body({ start: '20:00' }))).status).toBe(409); // 8:00–9:15 PM passes the 9:00 stop
    expect(plan.deepBlock('2026-10-27')).toBeNull();

    const ok = await app.req('POST', '/api/plan/deep-block', body({}));
    expect(ok.status).toBe(200);
    const ev = g.eventsBetween('2026-10-27T00:00:00-04:00', '2026-10-28T00:00:00-04:00').find((e) => e.title === 'Deep work · Delphic Medicine')!;
    expect(ev).toMatchObject({ marginKind: 'block', start: '2026-10-27T15:00:00.000-04:00', end: '2026-10-27T16:15:00.000-04:00' });
    expect(plan.deepBlock('2026-10-27')).toMatchObject({ project: 'Delphic Medicine' });
    expect((await app.req('POST', '/api/plan/deep-block', body({ project: 'Other', start: '17:00' }))).status).toBe(409); // one per day
  });

  it('shows the two message slots and can block each, with correct offsets across the Nov 1 clock change', async () => {
    const { app, plan } = await boot();
    const slots = plan.messageSlots(D);
    expect(slots.map((s) => s.label)).toEqual(['Messages · 6:30 PM', 'Messages · at shutdown']);
    expect(slots[1].time).toBe('8:45 PM'); // 15 minutes before the 9:00 PM stop
    expect(plan.messageSlots('2026-10-31')[0].start).toBe('2026-10-31T18:30:00.000-04:00');
    expect(plan.messageSlots('2026-11-01')[0].start).toBe('2026-11-01T18:30:00.000-05:00');
    expect(plan.messageSlots('2026-11-01')[1].start).toBe('2026-11-01T20:45:00.000-05:00');

    app.ctx.settings.set('plan', { messageSlots: { afterSchool: '19:00', atShutdown: '20:30' } });
    expect(plan.messageSlots(D).map((s) => s.time)).toEqual(['7:00 PM', '8:30 PM']);
    const r = await app.req('POST', '/api/plan/messages/block', { date: D, slot: 'shutdown' });
    expect(r.status).toBe(200);
    expect(plan.messageSlots(D)[1].blocked).toBe(true);
    expect((await app.req('POST', '/api/plan/messages/block', { date: D, slot: 'shutdown' })).status).toBe(409);
  });
});

describe('Nov 1, 2026 daylight-saving boundary', () => {
  it('carries from Sat Oct 31 to Sun Nov 1 and plans the 25-hour day correctly', async () => {
    const { td, plan, day, find, events } = await boot('2026-10-31T21:30:00-04:00');
    expect(day.planningDate()).toBe('2026-10-31');
    expect(day.mode()).toBe('evening');
    const t = find('Assign two new manuscripts'); // seeded due today (Oct 31)
    expect(t.due!.date).toBe('2026-10-31');
    await td.setEstimate(t.id, 40);
    await plan.addMustDo(t.id, '2026-10-31');

    const out = await plan.carry([t.id], '2026-11-01', { [t.id]: 'Open the reviewer sheet' });
    expect(out.carried).toEqual([t.id]);
    const after = td.task(t.id)!;
    expect(after.due!.date).toBe('2026-11-01');
    expect(after.meta).toMatchObject({ carryCount: 1, lastCarryDate: '2026-10-31', mustDoDate: '2026-11-01' });
    await flush();
    expect(events('task.carried')).toEqual([{ taskId: t.id, count: 1 }]);

    expect(plan.mustDos('2026-11-01').map((x) => x.id)).toEqual([t.id]);
    expect(plan.loadFor('2026-10-31').some((i) => i.id === t.id)).toBe(false);
    expect(plan.loadFor('2026-11-01').find((i) => i.id === t.id)).toMatchObject({ estimateMin: 40, paddedMin: 60, lane: 'must' });
    const cap = day.capacity('2026-11-01');
    expect(cap.items.some((i) => i.id === t.id)).toBe(true);
    expect(cap.freeMin).toBe(870); // 6:30 AM to 9:00 PM EST, after the 2 AM fall-back
    expect(cap.window.start).toBe('2026-11-01T06:30:00.000-05:00');
  });
});

describe('rules and Claude tools', () => {
  it('evaluates the carry hotspot and over-capacity conditions', async () => {
    const { td, plan, find } = await boot();
    expect(plan.carryHotspot(2).met).toBe(false);
    td.setMeta(find('Assign two new manuscripts').id, { carryCount: 1 });
    td.setMeta(find('Email Dr. Lim').id, { carryCount: 2 });
    const hot = plan.carryHotspot(2);
    expect(hot).toMatchObject({ met: true, subject: find('Email Dr. Lim').projectId });
    expect(manifest.rules!.conditions!.map((c) => c.id)).toEqual(['plan.carry_hotspot', 'plan.over_capacity_days']);

    expect(plan.overCapacityDays(1).met).toBe(false);
    await td.setEstimate(find('Email Dr. Lim').id, 700);
    expect(plan.overCapacityDays(1).met).toBe(true);
  });

  it('propose_must_dos respects the cap and proposes task.meta changes', async () => {
    const { app, plan, find } = await boot();
    await plan.addMustDo(find('Email Dr. Lim').id, D);
    await plan.addMustDo(find('Draft RSI essay').id, D);
    const tool = manifest.claude!.tools!.find((t) => t.name === 'propose_must_dos')!;
    const changes = (await tool.run(app.ctx, { date: D, taskIds: [find('Assign two new manuscripts').id, find('Update lab notebook').id] })) as any[];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'task.meta', payload: { patch: { mustDoDate: D, optional: false } } });
    const read = manifest.claude!.tools!.find((t) => t.name === 'get_today_plan')!;
    const plan_ = (await read.run(app.ctx, { date: D })) as any;
    expect(plan_.mustDoCap).toEqual({ limit: 3, used: 2 });
  });
});
