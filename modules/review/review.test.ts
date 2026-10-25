import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import { kvGet, kvSet } from '../../src/core/kv';
import type { TodoistService } from '../todoist/manifest';
import type { GoogleService } from '../google/manifest';
import type { DayService } from '../day/manifest';
import type { ReviewService } from './service';
import { reviewWeek } from './types';
import { resolveSteps, DEFAULT_STEPS } from './steps';
import { autoStats } from './context';
import { composeSummary } from './summary';
import { slotOptions } from './changes';

/** Only what the review needs, so the suite passes whether or not the other module agents have finished. */
const boot = (at = '2026-10-25T15:00:00-04:00') => testApp({ at, only: ['review', 'day', 'todoist', 'google', 'today'] });

async function fullApp(at?: string) {
  const app = await boot(at);
  await app.ctx.service<TodoistService>('todoist').sync();
  await app.ctx.service<GoogleService>('google').sync();
  return app;
}
const put = (app: any, body: unknown) => app.req('PUT', '/api/review/draft', body);
/** Score and finish a review with no external changes. */
async function finishWith(app: any, scores: { energy: number; dread: number; effective: number }) {
  expect((await put(app, { scores })).status).toBe(200);
  const r = await app.req('POST', '/api/review/finish');
  expect(r.status).toBe(200);
  return r.json;
}

describe('review: week boundaries', () => {
  it('weeks start on the configured day, including the week that contains Nov 1 2026 (DST ends, 25-hour day)', () => {
    const ws = (d: string, start = 7) => reviewWeek(d, start, 7).weekStart;
    expect(ws('2026-10-24')).toBe('2026-10-18'); // Saturday
    expect(ws('2026-10-25')).toBe('2026-10-25'); // Sunday
    expect(ws('2026-10-31')).toBe('2026-10-25');
    expect(ws('2026-11-01')).toBe('2026-11-01'); // the DST Sunday starts its own week
    expect(ws('2026-11-07')).toBe('2026-11-01');
    expect(ws('2026-11-08')).toBe('2026-11-08');
    expect(ws('2026-11-01', 1)).toBe('2026-10-26'); // Monday-start weeks
    const w = reviewWeek('2026-11-01', 7, 7);
    expect(w).toMatchObject({ weekStart: '2026-11-01', reviewDate: '2026-11-01', lookback: { from: '2026-10-25', to: '2026-10-31' }, ahead: { from: '2026-11-02', to: '2026-11-08' } });
  });

  it('a late review looks back before the review day and ahead from tomorrow; an early one anchors on today', () => {
    // Saturday Oct 31: Sunday Oct 25 review was never done. Lookback stays on that review's week, ahead starts tomorrow.
    expect(reviewWeek('2026-10-31', 7, 7)).toMatchObject({ weekStart: '2026-10-25', lookback: { from: '2026-10-18', to: '2026-10-24' }, ahead: { from: '2026-11-01', to: '2026-11-07' } });
    // Friday reviews in Sunday-start weeks, opened on Wednesday.
    expect(reviewWeek('2026-10-28', 7, 5)).toMatchObject({ weekStart: '2026-10-25', reviewDate: '2026-10-30', lookback: { from: '2026-10-21', to: '2026-10-27' }, ahead: { from: '2026-10-31', to: '2026-11-06' } });
  });

  it('is due from the review time on review day, across the DST change', async () => {
    const app = await boot('2026-11-01T14:59:00-05:00');
    const svc = app.ctx.service<ReviewService>('review');
    expect(svc.current().weekStart).toBe('2026-11-01');
    expect(svc.isDue()).toBe(false);
    app.setNow('2026-11-01T15:00:00-05:00');
    expect(svc.isDue()).toBe(true);
    app.setNow('2026-11-01T00:30:00-04:00'); // before the clocks fall back
    expect(svc.current().weekStart).toBe('2026-11-01');
    expect(svc.isDue()).toBe(false);
    app.setNow('2026-10-31T23:30:00-04:00'); // Saturday night: last Sunday's review is still open
    expect(svc.current()).toMatchObject({ weekStart: '2026-10-25', due: true });
  });

  it('proposes 90-minute blocks on the 25-hour day with the right offsets', async () => {
    const app = await boot();
    const opts = slotOptions(app.ctx, { from: '2026-11-01', to: '2026-11-01' }, 90, '09:00');
    expect(opts[0]).toMatchObject({ date: '2026-11-01', start: '2026-11-01T09:00:00.000-05:00', end: '2026-11-01T10:30:00.000-05:00', minutes: 90 });
    const stop = app.ctx.service<DayService>('day').anchors('2026-11-01').hardStop;
    expect(opts.every((o) => new Date(o.end).getTime() <= stop.toMillis())).toBe(true);
  });
});

describe('review: scores and history', () => {
  it('stores scores, freezes stop breaks, and scores(weeks) returns the last completed weeks oldest first', async () => {
    const app = await boot('2026-10-11T15:00:00-04:00');
    const day = app.ctx.service<DayService>('day');
    const svc = app.ctx.service<ReviewService>('review');
    app.setNow('2026-10-22T20:00:00-04:00');
    day.breakStop('/today');
    day.breakStop('/projects');
    for (const [at, s] of [
      ['2026-10-11T15:05:00-04:00', { energy: 4, dread: 6, effective: 5 }],
      ['2026-10-18T15:05:00-04:00', { energy: 5, dread: 7, effective: 5 }],
      ['2026-10-25T15:05:00-04:00', { energy: 6, dread: 8, effective: 4 }],
    ] as const) {
      app.setNow(at);
      const out = await finishWith(app, s);
      expect(out.changeSetId).toBeNull(); // nothing external to write
    }
    const rows = svc.scores(8);
    expect(rows.map((r) => [r.weekStart, r.energy, r.dread, r.effective])).toEqual([
      ['2026-10-11', 4, 6, 5], ['2026-10-18', 5, 7, 5], ['2026-10-25', 6, 8, 4],
    ]);
    // Oct 22 falls in the lookback of the Oct 25 review (Oct 18–24) and in no other.
    expect(rows.map((r) => r.stopBreaks)).toEqual([0, 0, 2]);
    expect(rows.every((r) => r.sleepAvgMin === null)).toBe(true); // no check-in module in this app
    expect(svc.scores(2).map((r) => r.weekStart)).toEqual(['2026-10-18', '2026-10-25']);
    expect(svc.history().map((h) => h.weekStart)).toEqual(['2026-10-25', '2026-10-18', '2026-10-11']);
    expect(app.ctx.bus.since('review.completed', '2026-10-01T00:00:00Z').map((e) => e.payload.weekStart)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
  });

  it('rejects out-of-range scores by clamping and refuses edits to a finished review', async () => {
    const app = await boot();
    const r = await put(app, { scores: { energy: 14, dread: -3, effective: 5.4 } });
    expect(r.json.scores).toEqual({ energy: 10, dread: 0, effective: 5 });
    await finishWith(app, { energy: 5, dread: 5, effective: 5 });
    expect((await put(app, { scores: { energy: 1 } })).status).toBe(409);
    expect((await put(app, { notes: 'Still editable' })).status).toBe(200);
  });

  it('averages sleep from check-ins and counts stop breaks and shutdown days', () => {
    const day = { settings: () => ({ sleepNeedMin: 480 }), stopBreaks: () => [{ date: '2026-10-20' }, { date: '2026-10-20' }, { date: '2026-10-22' }] };
    const ctx: any = {
      service: () => day,
      maybe: (id: string) => id === 'checkin' ? { entries: () => [{ sleepMin: 420 }, { sleepMin: 480 }, { sleepMin: null }] }
        : id === 'shutdown' ? { history: () => [{ date: '2026-10-19', completedAt: 'x' }, { date: '2026-10-20', completedAt: null }, { date: '2026-10-21', completedAt: 'y' }] } : undefined,
    };
    expect(autoStats(ctx, '2026-10-18', '2026-10-24')).toMatchObject({ sleepAvgMin: 450, sleepNights: 2, sleepTargetMin: 480, stopBreaks: 3, breakDays: 2, shutdownDays: 2 });
    const none = autoStats({ ...ctx, maybe: () => undefined }, '2026-10-18', '2026-10-24');
    expect(none).toMatchObject({ sleepAvgMin: null, shutdownDays: null });
  });

  it('writes a plain factual summary with comparisons and no praise or exclamation marks', () => {
    const base = { weekStart: '2026-10-25', step: 0, done: {}, scores: { energy: 5, dread: 7, effective: 4 }, priorities: [], notes: '', summary: '', summarySource: null, aiChangeSetId: null,
      decisions: { triage: { a: { decision: 'move' }, b: { decision: 'drop' } }, checkins: {}, deadlines: {}, required: {}, proposed: {}, projectChanges: [], offday: { date: null, confirmed: false, moves: {} } },
      changeSetId: null, startedAt: null, updatedAt: null, completedAt: null } as any;
    const text = composeSummary({
      draft: base, lookback: { from: '2026-10-18', to: '2026-10-24' }, carryOvers: 3, deadlinesWithoutPlan: 1, offdayDate: '2026-10-31',
      stats: { from: '2026-10-18', to: '2026-10-24', days: 7, sleepAvgMin: 432, sleepNights: 6, sleepTargetMin: 480, stopBreaks: 2, breakDays: 2, shutdownDays: 5 },
      last: { weekStart: '2026-10-18', energy: 6, dread: 6, effective: 4 },
    });
    expect(text).toContain('energy 5, dread 7, effective 4');
    expect(text).toContain('energy −1, dread +1, effective no change');
    expect(text).toContain('Sleep averaged 7h 12m over 6 nights, 48m under the 8h target.');
    expect(text).toContain('broken 2 times on 2 days');
    expect(text).toContain('5 of 7 days');
    expect(text).toContain('1 moved, 0 made first, 0 delegated, 1 dropped, 1 left undecided');
    expect(text).not.toMatch(/!|great|well done|proud/i);
  });
});

describe('review: steps', () => {
  it('uses the nine spec steps without the rituals module, and maps an edited checklist onto panels', () => {
    expect(resolveSteps(null, false).map((s) => s.panel)).toEqual(DEFAULT_STEPS.map((s) => s.panel));
    const edited = resolveSteps({ steps: [
      { id: 'wr-1', label: 'Score the week' }, { id: 'wr-2', label: 'Carry-over triage' }, { id: 'wr-x', label: 'Water the plants' },
    ] }, false);
    expect(edited.map((s) => s.panel)).toEqual(['score', 'triage', 'generic']);
    // Original nine, ids replaced wholesale: go by position.
    const renamed = resolveSteps({ steps: DEFAULT_STEPS.map((s, i) => ({ id: `q${i}`, label: `Step ${i}` })) }, false);
    expect(renamed.map((s) => s.panel)).toEqual(DEFAULT_STEPS.map((s) => s.panel));
    // Dropping the rules step from the checklist does not hide required steps.
    const noRules = { steps: DEFAULT_STEPS.filter((s) => s.id !== 'rules').map(({ id, label }) => ({ id, label })) };
    expect(resolveSteps(noRules, false).some((s) => s.panel === 'rules')).toBe(false);
    expect(resolveSteps(noRules, true).some((s) => s.panel === 'rules')).toBe(true);
  });
});

describe('review: required steps from rules', () => {
  it('block finishing until each one is resolved, then clear from kv', async () => {
    const app = await boot();
    kvSet(app.ctx.db, 'review.requiredSteps', [
      { id: 'remove_maintain', label: 'Remove one Maintain item', ruleId: 'stop-broken' },
      { id: 'call_coach', label: 'Talk to the coach', ruleId: 'other' },
    ]);
    await put(app, { scores: { energy: 5, dread: 5, effective: 5 } });
    let r = await app.req('POST', '/api/review/finish');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Remove one Maintain item and Talk to the coach/);
    // remove_maintain with no Maintain project left resolves on its own; a generic one needs words.
    expect((await app.req('POST', '/api/review/required/remove_maintain', {})).json.how).toMatch(/No Maintain item/);
    expect((await app.req('POST', '/api/review/required/call_coach', {})).status).toBe(400);
    expect((await app.req('POST', '/api/review/required/nope', { how: 'x' })).status).toBe(404);
    r = await app.req('POST', '/api/review/finish');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Talk to the coach/);
    await app.req('POST', '/api/review/required/call_coach', { how: 'Told coach I am skipping Thursday practice' });
    r = await app.req('POST', '/api/review/finish');
    expect(r.status).toBe(200);
    expect(kvGet(app.ctx.db, 'review.requiredSteps', null)).toEqual([]);
  });

  it('needs scores before it finishes', async () => {
    const app = await boot();
    const r = await app.req('POST', '/api/review/finish');
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Rate energy, dread and effective/);
  });
});

describe('review: rule conditions', () => {
  async function ruleFires(app: any, condition: string, params: Record<string, unknown>) {
    app.ctx.rules.save({ id: `t-${condition}`, name: condition, enabled: true, when: [{ condition, params }], then: [] });
    await app.ctx.rules.evaluate();
    return app.ctx.rules.active().some((f: any) => f.ruleId === `t-${condition}`);
  }
  const weeks = async (app: any, rows: [string, number, number, number][]) => {
    for (const [d, energy, dread, effective] of rows) { app.setNow(`${d}T15:05:00-04:00`); await finishWith(app, { energy, dread, effective }); }
    app.setNow('2026-10-26T09:00:00-04:00');
  };

  it('review.dread_high fires after N weeks at or above the score, and not on one bad week or stale data', async () => {
    const hi = await boot('2026-10-11T15:00:00-04:00');
    await weeks(hi, [['2026-10-11', 5, 6, 5], ['2026-10-18', 5, 7, 5], ['2026-10-25', 5, 8, 5]]);
    expect(await ruleFires(hi, 'review.dread_high', { score: 7, weeks: 2 })).toBe(true);
    expect(hi.ctx.rules.active().find((f: any) => f.ruleId === 't-review.dread_high')!.detail).toBe('Dread was 7 and 8 in the last 2 weekly reviews.');
    expect(await ruleFires(hi, 'review.dread_high', { score: 7, weeks: 3 })).toBe(false); // week one was 6

    const one = await boot('2026-10-11T15:00:00-04:00');
    await weeks(one, [['2026-10-11', 5, 5, 5], ['2026-10-18', 5, 9, 5]]);
    expect(await ruleFires(one, 'review.dread_high', { score: 7, weeks: 2 })).toBe(false);

    const stale = await boot('2026-09-06T15:00:00-04:00');
    await weeks(stale, [['2026-09-06', 5, 9, 5], ['2026-09-13', 5, 9, 5]]);
    expect(await ruleFires(stale, 'review.dread_high', { score: 7, weeks: 2 })).toBe(false); // six weeks old
  });

  it('review.energy_trend and review.stable_weeks read the same history', async () => {
    const app = await boot('2026-10-04T15:00:00-04:00');
    await weeks(app, [['2026-10-04', 3, 4, 4], ['2026-10-11', 4, 4, 5], ['2026-10-18', 6, 5, 5], ['2026-10-25', 6, 5, 5]]);
    expect(await ruleFires(app, 'review.energy_trend', { direction: 'up', weeks: 3 })).toBe(true);
    expect(await ruleFires(app, 'review.energy_trend', { direction: 'down', weeks: 2 })).toBe(false);
    expect(await ruleFires(app, 'review.stable_weeks', { n: 3 })).toBe(true);
    const bad = await boot('2026-10-11T15:00:00-04:00');
    await weeks(bad, [['2026-10-11', 7, 3, 7], ['2026-10-18', 4, 3, 7], ['2026-10-25', 3, 3, 7]]);
    expect(await ruleFires(bad, 'review.energy_trend', { direction: 'down', weeks: 3 })).toBe(true);
    expect(await ruleFires(bad, 'review.stable_weeks', { n: 3 })).toBe(false); // energy fell 3 points in a week
  });

  it('review.missed fires the day after a review day with no finished review, and clears when a later one is finished', async () => {
    const app = await boot('2026-10-25T15:00:00-04:00');
    kvSet(app.ctx.db, 'review.since', '2026-10-18');
    const svc = app.ctx.service<ReviewService>('review');
    expect(svc.missed().met).toBe(false); // today is the review day: due, not missed
    app.setNow('2026-10-26T10:00:00-04:00');
    expect(svc.missed()).toMatchObject({ met: true, weekStart: '2026-10-25' });
    expect(await ruleFires(app, 'review.missed', {})).toBe(true);
    await finishWith(app, { energy: 5, dread: 5, effective: 5 });
    expect(svc.missed().met).toBe(false);
    // Nothing is "missed" from before the app started tracking.
    const fresh = await boot('2026-10-27T10:00:00-04:00');
    expect(fresh.ctx.service<ReviewService>('review').missed().met).toBe(false);
  });
});

describe('review: notification', () => {
  it('plans one work notification at the review time per week, and none once it is done', async () => {
    const app = await boot();
    const m = app.ctx.registry.get('review')!;
    const n = m.notifications!(app.ctx, '2026-10-25');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ key: 'review.due:2026-10-25', category: 'work', path: '/review' });
    expect(n[0].at.toISO()).toBe('2026-10-25T15:00:00.000-04:00');
    expect(m.notifications!(app.ctx, '2026-10-26')).toEqual([]);
    expect(m.notifications!(app.ctx, '2026-11-01')[0].at.toISO()).toBe('2026-11-01T15:00:00.000-05:00');
    await finishWith(app, { energy: 5, dread: 5, effective: 5 });
    expect(m.notifications!(app.ctx, '2026-10-25')).toEqual([]);
  });
});

describe('review: a full run produces a change set that applies to Todoist and Google Calendar', () => {
  it('moves, makes first, delegates, drops, moves off the off-day, and books deep-work blocks', async () => {
    const app = await fullApp();
    const td = app.ctx.service<TodoistService>('todoist');
    const g = app.ctx.service<GoogleService>('google');
    const find = (start: string) => td.tasks().find((t) => t.content.startsWith(start))!;
    const redCross = find('Reply to Red Cross');
    const essay = find('Draft RSI essay');
    const manuscripts = find('Assign two new manuscripts');
    const blender = find('Look into Blender');
    const packId = (await td.add({ content: 'Pack for Columbia SHP', dueDate: '2026-10-31' }))!;
    for (const t of [redCross, essay, manuscripts, blender]) td.setMeta(t.id, { carryCount: 3, lastCarryDate: '2026-10-24' });

    const ctxJson = (await app.req('GET', '/api/review/context')).json;
    expect(ctxJson.weekStart).toBe('2026-10-25');
    expect(ctxJson.triage.map((t: any) => t.id).sort()).toEqual([redCross.id, essay.id, manuscripts.id, blender.id].sort());
    expect(ctxJson.offday.date).toBe('2026-10-31');
    expect(ctxJson.offday.tasks.map((t: any) => t.id)).toContain(packId);
    expect(ctxJson.deadlines.some((d: any) => d.title === 'RSI application due')).toBe(true);
    expect(ctxJson.slots.length).toBeGreaterThan(0);

    const saved = await put(app, {
      scores: { energy: 5, dread: 6, effective: 4 },
      priorities: [
        { text: 'Finish the RSI essay draft', ref: { type: 'task', id: essay.id }, block: true, slot: null },
        { text: 'Lab notebook catch-up', ref: null, block: true, slot: null },
        { text: 'Sleep before 10:30', ref: null, block: false, slot: null },
      ],
      decisions: {
        triage: {
          [redCross.id]: { decision: 'move', date: '2026-10-27' },
          [essay.id]: { decision: 'first' },
          [manuscripts.id]: { decision: 'delegate', owner: 'Maya' },
          [blender.id]: { decision: 'drop', reason: 'Not this semester' },
        },
        offday: { date: '2026-10-31', confirmed: true, moves: { [packId]: '2026-11-01' } },
      },
    });
    expect(saved.status).toBe(200);
    const [p1, p2, p3] = saved.json.priorities;
    expect(p1.slot && p2.slot).toBeTruthy();
    expect(p3.slot).toBeNull();
    expect(p1.slot.start.slice(0, 10)).not.toBe(p2.slot.start.slice(0, 10)); // one block a day
    const day = app.ctx.service<DayService>('day');
    for (const p of [p1, p2]) expect(new Date(p.slot.end).getTime()).toBeLessThanOrEqual(day.anchors(p.slot.start.slice(0, 10)).hardStop.toMillis());

    const fin = await app.req('POST', '/api/review/finish');
    expect(fin.status).toBe(200);
    const set = (await app.req('GET', `/api/changesets/${fin.json.changeSetId}`)).json;
    expect(set).toMatchObject({ source: 'review', title: 'Weekly review · Oct 25', status: 'pending' });
    const kinds = set.changes.map((c: any) => c.kind);
    expect(kinds.filter((k: string) => k === 'todoist.task.reschedule')).toHaveLength(3); // red cross, essay, pack
    expect(kinds).toEqual(expect.arrayContaining(['todoist.task.label', 'todoist.task.drop', 'task.meta', 'gcal.event.create']));
    expect(kinds.filter((k: string) => k === 'gcal.event.create')).toHaveLength(2);
    expect(fin.json.summary).toMatch(/Scores: energy 5, dread 6, effective 4/);
    // Nothing reaches Todoist before the change set is applied.
    expect(td.task(redCross.id)!.due!.date).not.toBe('2026-10-27');

    const applied = (await app.req('POST', `/api/changesets/${set.id}/apply`, {})).json;
    expect(applied.changes.map((c: any) => `${c.kind}:${c.status}:${c.error ?? ''}`).filter((s: string) => !s.includes(':applied:'))).toEqual([]);
    expect(applied.status).toBe('applied');

    await td.sync();
    await g.sync();
    expect(td.task(redCross.id)!.due!.date).toBe('2026-10-27');
    expect(td.task(packId)!.due!.date).toBe('2026-11-01');
    expect(td.task(essay.id)!.due!.date).toBe('2026-10-26');
    expect(td.task(essay.id)!.meta).toMatchObject({ mustDoDate: '2026-10-26', carryCount: 0 });
    expect(td.task(manuscripts.id)!.labels).toContain('waiting');
    expect(td.task(manuscripts.id)!.meta).toMatchObject({ owner: 'Maya', carryCount: 0 });
    expect(td.task(blender.id)!.checked).toBe(true); // dropped = completed with a note, never deleted

    const blocksCal = g.appCalendarId('blocks', 'main')!;
    expect(blocksCal).toBeTruthy();
    const ev = g.eventsBetween('2026-10-26T00:00:00-04:00', '2026-11-08T00:00:00-05:00', { calendarIds: [blocksCal] });
    const essayBlock = ev.find((e) => e.title === 'Deep work: Finish the RSI essay draft')!;
    expect(essayBlock).toMatchObject({ appOwned: true, marginKind: 'block', marginRef: essay.id });
    expect(essayBlock.start).toBe(new Date(p1.slot.start).toISOString().length ? essayBlock.start : '');
    expect(new Date(essayBlock.start).getTime()).toBe(new Date(p1.slot.start).getTime());
    expect(ev.some((e) => e.title === 'Deep work: Lab notebook catch-up')).toBe(true);

    // The review is finished, linked to its change set, and finishing again changes nothing.
    const cur = (await app.req('GET', '/api/review/current')).json;
    expect(cur).toMatchObject({ completed: true, due: false });
    expect(cur.draft.changeSetId).toBe(set.id);
    const again = await app.req('POST', '/api/review/finish');
    expect(again.json.changeSetId).toBe(set.id);
    expect(app.ctx.changes.list().filter((s) => s.source === 'review')).toHaveLength(1);
  });

  it('keeps unfinished work out of the change set and refuses bad decisions', async () => {
    const app = await fullApp();
    const td = app.ctx.service<TodoistService>('todoist');
    const t = td.tasks()[0];
    await put(app, { scores: { energy: 5, dread: 5, effective: 5 }, decisions: { triage: { [t.id]: { decision: 'delegate' } } } });
    const r = await app.req('POST', '/api/review/finish');
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Name who owns/);
    await put(app, { decisions: { triage: { [t.id]: { decision: 'move', date: '2026-10-25' } } } });
    expect((await app.req('POST', '/api/review/finish')).json.error).toMatch(/Pick a date after today/);
    expect(app.ctx.changes.list()).toHaveLength(0);
    expect((await app.req('GET', '/api/review/current')).json.completed).toBe(false);
  });
});

describe('review: Claude tools', () => {
  const tool = (app: any, name: string) => app.ctx.registry.get('review').claude.tools.find((t: any) => t.name === name);

  it('get_week_summary leaves out sleep and scores unless wellbeing data is shared', async () => {
    const app = await fullApp();
    await put(app, { scores: { energy: 4, dread: 8, effective: 3 }, priorities: [{ text: 'Rest', ref: null, block: false, slot: null }] });
    const closed = await tool(app, 'get_week_summary').run(app.ctx, {});
    expect(closed).toMatchObject({ weekStart: '2026-10-25', wellbeingShared: false, priorities: ['Rest'] });
    expect(closed).not.toHaveProperty('scores');
    expect(closed).not.toHaveProperty('sleepAvgMin');
    app.ctx.settings.set('ai', { shareWellbeing: true });
    const open = await tool(app, 'get_week_summary').run(app.ctx, {});
    expect(open.scores).toEqual({ energy: 4, dread: 8, effective: 3 });
    expect(open).toHaveProperty('sleepAvgMin');
  });

  it('propose_review_changes returns appliable changes and refuses blocks past the hard stop', async () => {
    const app = await fullApp();
    const td = app.ctx.service<TodoistService>('todoist');
    const t = td.tasks().find((x) => x.content.startsWith('Reply to Red Cross'))!;
    const changes = await tool(app, 'propose_review_changes').run(app.ctx, { changes: [
      { action: 'move', taskId: t.id, date: '2026-10-28' },
      { action: 'block', title: 'Deep work: essay', start: '2026-10-27T16:00:00-04:00', end: '2026-10-27T17:30:00-04:00' },
    ] });
    expect(changes.map((c: any) => c.kind)).toEqual(['todoist.task.reschedule', 'task.meta', 'gcal.event.create']);
    const set = app.ctx.changes.propose({ source: 'claude', title: 'x', changes });
    expect((await app.ctx.changes.apply(set.id)).status).toBe('applied');
    expect(() => tool(app, 'propose_review_changes').run(app.ctx, { changes: [
      { action: 'block', title: 'Late', start: '2026-10-27T22:00:00-04:00', end: '2026-10-27T23:30:00-04:00' },
    ] })).toThrow(/after the stop/);
  });
});
