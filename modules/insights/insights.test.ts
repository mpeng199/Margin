import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import {
  carryStats, clockMinutes, habitStats, mean, mustDoStats, projectTime, stdDev, stopAdherence, summarizeEnergy, summarizeSleep, toNights, toPct, weekStartsFor,
} from './aggregate';
import { buildSummary, metricsForClaude, type InsightsSummary } from './build';
import insights from './manifest';

const NOW = '2026-10-26T16:00:00-04:00'; // Monday
const boot = (only: string[] = ['day', 'insights']) => testApp({ at: NOW, only });
const iso = (date: string, hhmm: string, off = '-04:00') => `${date}T${hhmm}:00.000${off}`;

describe('weeks and clock helpers', () => {
  it('lists week starts oldest first, across the Nov 1 DST change', () => {
    expect(weekStartsFor('2026-10-26', 4, 7)).toEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
    expect(weekStartsFor('2026-10-26', 2, 1)).toEqual(['2026-10-19', '2026-10-26']);
    expect(weekStartsFor('2026-11-08', 3, 7)).toEqual(['2026-10-25', '2026-11-01', '2026-11-08']);
  });
  it('reads HH:MM and zoned instants as wall-clock minutes', () => {
    expect(clockMinutes('06:45')).toBe(405);
    expect(clockMinutes(iso('2026-10-27', '06:30'))).toBe(390);
    expect(clockMinutes('2026-11-02T06:30:00.000-05:00')).toBe(390);
    expect(clockMinutes('nope')).toBeNull();
    expect(clockMinutes(undefined)).toBeNull();
  });
  it('mean and population standard deviation', () => {
    expect(mean([])).toBeNull();
    expect(stdDev([5])).toBeNull();
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
});

describe('sleep and wake consistency', () => {
  const entries = [
    { date: '2026-10-19', sleepMin: 450, wakeTime: iso('2026-10-19', '06:30'), energy: 6 },
    { date: '2026-10-20', sleepMin: 480, wakeTime: iso('2026-10-20', '06:30'), energy: 7 },
    { date: '2026-10-21', sleepMin: 420, wakeTime: iso('2026-10-21', '06:45'), energy: 5 },
    { date: '2026-10-24', sleepMin: 540, wakeTime: iso('2026-10-24', '08:00'), energy: 8 },
    { date: '2026-10-25', sleepMin: 570, wakeTime: iso('2026-10-25', '08:30'), energy: 7 },
  ];
  it('averages sleep, measures wake variability, and splits weekday from weekend', () => {
    const s = summarizeSleep(entries);
    expect(s.sleepNights).toBe(5);
    expect(s.avgSleepMin).toBe(492);
    expect(s.inTargetNights).toBe(3); // 8h, 9h, 9h30
    expect(s.wake.avgMin).toBe(435);
    expect(s.wake.weekdayAvgMin).toBe(395);
    expect(s.wake.weekendAvgMin).toBe(495);
    expect(s.wake.driftMin).toBe(100);
    expect(s.wake.sdMin).toBeCloseTo(50.2, 1);
    expect(s.summary.sleep).toBe('Averaged 8h 12m across 5 nights. Target is 8–10 h; 3 nights landed inside it.');
    expect(s.summary.wake).toBe('Wake time varied by ±50 min (standard deviation), averaging 7:15 AM. Weekends ran 1h 40m later than weekdays; the guideline is 1h 30m or less.');
  });
  it('derives a duration from bedtime and wake time when sleepMin is missing', () => {
    const [n] = toNights([{ date: '2026-10-27', bedtime: iso('2026-10-26', '22:30'), wakeTime: iso('2026-10-27', '06:30') }]);
    expect(n.sleepMin).toBe(480);
    expect(n.wakeMin).toBe(390);
    expect(n.weekend).toBe(false);
  });
  it('says plainly when there is nothing to show', () => {
    const empty = summarizeSleep([]);
    expect(empty.avgSleepMin).toBeNull();
    expect(empty.summary.sleep).toBe('No sleep has been logged in this range yet.');
    expect(empty.summary.wake).toMatch(/at least 2 check-ins/);
    const one = summarizeSleep([entries[0]]);
    expect(one.wake.sdMin).toBeNull();
  });
});

describe('energy and the three weekly ratings', () => {
  it('sorts weeks, tolerates unrated values, and reports daily energy', () => {
    const e = summarizeEnergy(
      [{ weekStart: '2026-10-18', energy: 6, dread: 5, effective: 5, sleepAvgMin: 470, stopBreaks: 1 }, { weekStart: '2026-10-04', energy: 4, dread: 7, effective: 4 }],
      toNights([{ date: '2026-10-19', energy: 6 }, { date: '2026-10-20', energy: 8 }, { date: '2026-10-21' }]),
    );
    expect(e.weekly.map((w) => w.weekStart)).toEqual(['2026-10-04', '2026-10-18']);
    expect(e.weekly[0].stopBreaks).toBeNull();
    expect(e.summary.weekly).toBe('Week of Oct 18: energy 6, dread 5, effective 5. Week of Oct 4: energy 4, dread 7, effective 4.');
    expect(e.summary.daily).toBe('Check-in energy averaged 7 across 2 days (low 6, high 8).');
    expect(summarizeEnergy([], []).summary.weekly).toMatch(/No weekly ratings yet/);
  });
});

describe('stop adherence', () => {
  const weekStarts = ['2026-10-18', '2026-10-25'];
  const base = {
    from: '2026-10-18', today: '2026-10-26', weekStarts,
    shutdowns: ['19', '20', '21', '22', '23', '24'].map((d) => ({ date: `2026-10-${d}`, completed: true })),
    breaks: [{ date: '2026-10-22' }, { date: '2026-10-22' }, { date: '2026-10-25' }],
  };
  it('counts held, broken and unlogged nights by week; today only once something is recorded', () => {
    const s = stopAdherence(base);
    expect(s.weeks).toEqual([
      { weekStart: '2026-10-18', held: 5, broken: 1, unlogged: 1 },
      { weekStart: '2026-10-25', held: 0, broken: 1, unlogged: 0 },
    ]);
    expect([s.held, s.broken, s.unlogged, s.nights, s.breaks]).toEqual([5, 2, 1, 8, 3]);
    expect(s.summary).toBe('Stop held on 5 of 8 nights, broken on 2, nothing logged on 1. 3 breaks in total.');
    const tonight = stopAdherence({ ...base, shutdowns: [...base.shutdowns, { date: '2026-10-26', completed: true }] });
    expect(tonight.nights).toBe(9);
    expect(tonight.weeks[1].held).toBe(1);
  });
  it('treats a shutdown that was started but not completed as nothing logged', () => {
    const s = stopAdherence({ ...base, shutdowns: [{ date: '2026-10-19', completed: false }], breaks: [] });
    expect(s.held).toBe(0);
    expect(s.unlogged).toBe(8);
  });
});

describe('carry-over stats', () => {
  const ev = (taskId: string | undefined, count: number, date: string) => ({ payload: { taskId, count }, at: iso(date, '21:00') });
  it('counts carries per week and the tasks that reached 3, once each', () => {
    const c = carryStats({
      weekStarts: ['2026-10-18', '2026-10-25'], weekStart: 7, waiting: 1,
      events: [
        ev('t1', 1, '2026-10-19'), ev('t1', 2, '2026-10-20'), ev('t1', 3, '2026-10-21'),
        ev('t2', 1, '2026-10-26'), ev('t3', 3, '2026-10-27'), ev('t3', 3, '2026-10-28'),
        ev('old', 3, '2026-10-01'), ev(undefined, 1, '2026-10-22'),
      ],
    });
    expect(c.weeks).toEqual([
      { weekStart: '2026-10-18', carries: 3, tasks: 1, hit3: 1 },
      { weekStart: '2026-10-25', carries: 3, tasks: 2, hit3: 1 },
    ]);
    expect([c.carries, c.tasks, c.hit3]).toEqual([6, 3, 2]);
    expect(c.summary).toBe('6 carries across 3 tasks; 2 reached 3 carries. 1 task is waiting for a decision now.');
  });
  it('buckets by local date, so a late-evening event near midnight stays on its own day', () => {
    // 11:30 PM Sat Oct 31 EDT is Nov 1 UTC; weeks are decided on the local date.
    const c = carryStats({ weekStarts: ['2026-10-25', '2026-11-01'], events: [{ payload: { taskId: 'a', count: 1 }, at: '2026-11-01T03:30:00.000Z' }] });
    expect(c.weeks.map((w) => w.carries)).toEqual([1, 0]);
    expect(carryStats({ weekStarts: ['2026-10-25'], events: [] }).summary).toBe('No tasks were carried over in this range.');
  });
});

describe('must-do completion', () => {
  it('compares must_do_date with completions per task; optional ones are left out', () => {
    const m = mustDoStats({
      weekStarts: ['2026-10-18', '2026-10-25'],
      planned: [
        { taskId: 'a', date: '2026-10-19' }, { taskId: 'b', date: '2026-10-19' }, { taskId: 'c', date: '2026-10-20', optional: true },
        { taskId: 'd', date: '2026-10-21' }, { taskId: 'e', date: '2026-10-26' }, { taskId: 'a', date: '2026-10-19' },
      ],
      completions: [{ task_id: 'a', date: '2026-10-19' }, { task_id: 'b', date: '2026-10-20' }, { task_id: 'd', date: '2026-10-20' }],
    });
    expect(m.weeks).toEqual([
      { weekStart: '2026-10-18', planned: 3, done: 2, later: 1 },
      { weekStart: '2026-10-25', planned: 1, done: 0, later: 0 },
    ]);
    expect([m.planned, m.done, m.later, m.open]).toEqual([4, 2, 1, 1]);
    expect(m.summary).toBe('Finished 2 of 4 must-dos on the day (50%); 1 more finished later.');
    expect(mustDoStats({ planned: [], completions: [], weekStarts: ['2026-10-25'] }).summary).toBe('No must-dos were set in this range.');
  });
});

describe('time per project', () => {
  const now = '2026-10-26T16:00:00-04:00';
  const focus = [
    { projectId: 'lab', start: iso('2026-10-20', '16:00'), end: iso('2026-10-20', '16:50'), minutes: 50 },
    { projectId: 'lab', start: iso('2026-10-21', '16:00'), end: iso('2026-10-21', '16:50'), minutes: 50 },
  ];
  const ev = (over: object) => ({ projectId: 'lab', start: iso('2026-10-22', '15:00'), end: iso('2026-10-22', '16:00'), allDay: false, busy: true, marginKind: null as string | null, ...over });
  it('adds focus minutes to ended, busy, timed project events; skips phases, free time, future and duplicate sessions', () => {
    const p = projectTime({
      now, weeks: 2, focus,
      projects: [{ id: 'lab', name: 'Lim Lab', color: '#2a78d6', weeklyBudgetMin: 100 }],
      events: [
        ev({ marginKind: 'meeting' }),                                                         // 60
        ev({ start: iso('2026-10-20', '16:10'), end: iso('2026-10-20', '16:40'), marginKind: 'session' }), // same hour as a focus log
        ev({ marginKind: 'milestone' }), ev({ allDay: true, start: '2026-10-23', end: '2026-10-24' }),
        ev({ start: iso('2026-10-27', '15:00'), end: iso('2026-10-27', '16:00') }),               // future
        ev({ projectId: 'other', start: iso('2026-10-23', '10:00'), end: iso('2026-10-23', '10:30') }), // 30, unknown project
        ev({ projectId: 'other', busy: false }), ev({ projectId: null }),
      ],
    });
    expect(p.rows.map((r) => [r.projectId, r.name, r.focusMin, r.eventMin, r.totalMin, r.budgetMin])).toEqual([
      ['lab', 'Lim Lab', 100, 60, 160, 200],
      ['other', 'Unlinked project', 0, 30, 30, null],
    ]);
    expect(p.totalMin).toBe(190);
    expect(p.summary).toBe('3h 10m across 2 projects. Lim Lab took the most: 2h 40m.');
  });
  it('keeps a work-session event that has no matching focus log', () => {
    const p = projectTime({ now, weeks: 1, focus: [], projects: [], events: [ev({ marginKind: 'session' })] });
    expect(p.rows[0].eventMin).toBe(60);
    expect(projectTime({ now, weeks: 1, focus: [], projects: [], events: [] }).summary).toBe('No project time has been logged in this range yet.');
  });
  it('measures a session that crosses the Nov 1 change in elapsed minutes', () => {
    // 12:30 AM EDT to 1:30 AM EST is two real hours.
    const p = projectTime({ now: '2026-11-02T12:00:00-05:00', weeks: 1, focus: [], projects: [], events: [ev({ start: '2026-11-01T00:30:00.000-04:00', end: '2026-11-01T01:30:00.000-05:00' })] });
    expect(p.rows[0].eventMin).toBe(120);
  });
});

describe('habit consistency', () => {
  it('summarises 2-week and 4-week consistency and tolerates odd shapes', () => {
    const table: Record<string, Record<number, unknown>> = { h1: { 14: 0.86, 28: 80 }, h2: { 14: { pct: 50 }, 28: null } };
    const h = habitStats([{ id: 'h1', name: 'Fixed wake time' }, { id: 'h2', name: 'Phone out of bedroom' }], (id, d) => table[id][d]);
    expect(h.rows).toEqual([{ id: 'h1', name: 'Fixed wake time', d14: 86, d28: 80 }, { id: 'h2', name: 'Phone out of bedroom', d14: 50, d28: null }]);
    expect([h.avg14, h.avg28]).toEqual([68, 80]);
    expect(h.summary).toBe('Across 2 habits, consistency averaged 68% over 2 weeks and 80% over 4 weeks.');
    expect(toPct(1)).toBe(1); // habits.consistency is 0-100, so 1 means 1%
    expect(toPct(100)).toBe(100);
    expect(toPct('x')).toBeNull();
    expect(habitStats([], () => null).summary).toBe('No habits are set up yet.');
  });
});

/* ---------------------------------------------------------------- the route and the glue */
describe('insights summary (glue over optional modules)', () => {
  const fakes = (over: Record<string, unknown> = {}) => ({
    checkin: { entries: () => [
      { date: '2026-10-19', sleepMin: 450, wakeTime: iso('2026-10-19', '06:30'), energy: 6 },
      { date: '2026-10-25', sleepMin: 570, wakeTime: iso('2026-10-25', '08:30'), energy: 7 },
    ] },
    review: { scores: () => [{ weekStart: '2026-10-18', energy: 6, dread: 5, effective: 5, sleepAvgMin: 470, stopBreaks: 1 }, { weekStart: '2026-01-04', energy: 1, dread: 1, effective: 1, sleepAvgMin: 1, stopBreaks: 1 }] },
    shutdown: { history: () => [{ date: '2026-10-19', completedAt: iso('2026-10-19', '20:50') }, { date: '2026-10-20' }] },
    plan: { triageQueue: () => [{ id: 't3' }] },
    todoist: {
      tasks: ({ mustDoOn }: { mustDoOn: string }) => (mustDoOn === '2026-10-19' ? [{ id: 'a', meta: { optional: false } }, { id: 'o', meta: { optional: true } }] : []),
      completions: () => [{ task_id: 'a', date: '2026-10-19' }],
    },
    focus: { timeLogs: () => [{ projectId: 'lab', start: iso('2026-10-20', '16:00'), end: iso('2026-10-20', '16:50'), minutes: 50 }] },
    google: { eventsBetween: () => [] },
    projects: { list: () => [{ id: 'lab', name: 'Lim Lab', color: '#2a78d6', weeklyBudgetMin: 780 }] },
    habits: { list: () => [{ id: 'h1', name: 'Fixed wake time' }], consistency: (_id: string, d: number) => (d === 14 ? 90 : 80) },
    ...over,
  } as Record<string, any>);

  async function withFakes(f: Record<string, any>, weeks = 4) {
    const app = await boot();
    const real = app.ctx;
    const ctx = { ...real, maybe: (id: string) => (id === 'day' ? real.maybe(id) : f[id]) } as typeof real;
    return { app, ctx, summary: buildSummary(ctx, weeks) };
  }

  it('builds every section from the module services', async () => {
    const app = await boot();
    app.ctx.bus.emit('task.carried', { taskId: 't1', count: 3 });
    const f = fakes();
    const ctx = { ...app.ctx, maybe: (id: string) => (id === 'day' ? app.ctx.maybe(id) : f[id]) } as typeof app.ctx;
    const s = buildSummary(ctx, 4);
    expect(s.weekStarts).toEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
    expect([s.from, s.to]).toEqual(['2026-10-04', '2026-10-26']);
    expect(s.missing).toEqual({});
    expect(s.failed).toEqual([]);
    expect(s.sleep!.sleepNights).toBe(2);
    expect(s.energy!.weekly).toHaveLength(1); // the January review is outside the range
    expect(s.stops!.held).toBe(2);
    expect(s.carry!.hit3).toBe(1);
    expect(s.carry!.waiting).toBe(1);
    expect(s.mustDo!.planned).toBe(1);
    expect(s.mustDo!.done).toBe(1);
    expect(s.projects!.rows[0]).toMatchObject({ name: 'Lim Lab', focusMin: 50, budgetMin: 3120 });
    expect(s.habits!.rows[0]).toMatchObject({ d14: 90, d28: 80 });
  });

  it('omits sections whose modules are missing, and names the module', async () => {
    const { summary: s } = await withFakes({}); // nothing but day
    expect(s.sleep ?? s.energy ?? s.stops ?? s.carry ?? s.mustDo ?? s.projects ?? s.habits).toBeUndefined();
    expect(s.missing).toEqual({ sleep: 'checkin', energy: 'review or checkin', stops: 'shutdown', carry: 'plan', mustDo: 'todoist', projects: 'focus or google', habits: 'habits' });
    expect(s.failed).toEqual([]);
    expect(s.weekStarts).toHaveLength(4);
  });

  it('keeps going when one module throws', async () => {
    const { summary: s } = await withFakes(fakes({ shutdown: { history: () => { throw new Error('boom'); } } }));
    expect(s.failed).toEqual(['stops']);
    expect(s.stops).toBeUndefined();
    expect(s.sleep).toBeDefined();
    expect(s.habits).toBeDefined();
  });

  it('works with only some of a pair present (review without checkin, google without focus)', async () => {
    const f = fakes(); delete f.checkin; delete f.focus;
    const { summary: s } = await withFakes(f);
    expect(s.missing).toEqual({ sleep: 'checkin' });
    expect(s.energy!.weekly).toHaveLength(1);
    expect(s.energy!.daily).toEqual([]);
    expect(s.projects!.rows).toEqual([]);
  });

  it('GET /api/insights/summary answers with whatever modules this boot has, and validates weeks', async () => {
    const app = await boot();
    const r = await app.req('GET', '/api/insights/summary');
    expect(r.status).toBe(200);
    expect(r.json.weeks).toBe(8);
    expect(r.json.weekStarts).toHaveLength(8);
    expect(r.json.weekStarts.at(-1)).toBe('2026-10-25');
    // checkin, review, shutdown and habits are not in this boot, so their sections are absent and named.
    for (const k of ['sleep', 'energy', 'stops', 'habits'] as const) {
      expect(r.json[k]).toBeUndefined();
      expect(r.json.missing[k]).toBeTruthy();
    }
    expect(r.json.mustDo.summary).toBe('No must-dos were set in this range.');
    for (const w of [4, 12]) expect((await app.req('GET', `/api/insights/summary?weeks=${w}`)).json.weeks).toBe(w);
    for (const bad of ['0', '27', 'abc', '2.5', '-1']) expect((await app.req('GET', `/api/insights/summary?weeks=${bad}`)).status).toBe(400);
  });

  it('runs against real modules when they are on (checkin, review, shutdown, plan, habits)', async () => {
    const app = await testApp({ at: NOW, only: ['day', 'insights', 'checkin', 'review', 'shutdown', 'plan', 'habits', 'projects', 'rituals', 'phases', 'rules', 'offday'] });
    const r = await app.req('GET', '/api/insights/summary?weeks=4');
    expect(r.status).toBe(200);
    // Whatever is on must produce a section or an honest failure, never a crash.
    const keys = ['sleep', 'energy', 'stops', 'carry', 'mustDo', 'projects', 'habits'];
    for (const k of keys) expect(Boolean(r.json[k]) || k in r.json.missing || r.json.failed.includes(k)).toBe(true);
    if (app.ctx.maybe('checkin')) expect(r.json.sleep.summary.sleep).toMatch(/No sleep/);
  });
});

describe('get_metrics (Claude tool)', () => {
  const tool = insights.claude!.tools!.find((t) => t.name === 'get_metrics')!;

  it('is a read tool that withholds sleep and energy unless wellbeing sharing is on', async () => {
    expect(tool.kind).toBe('read');
    const app = await boot();
    const f = {
      checkin: { entries: () => [{ date: '2026-10-19', sleepMin: 450, wakeTime: iso('2026-10-19', '06:30'), energy: 6 }] },
      review: { scores: () => [{ weekStart: '2026-10-18', energy: 6, dread: 5, effective: 5, sleepAvgMin: 470, stopBreaks: 1 }] },
      habits: { list: () => [{ id: 'h1', name: 'Fixed wake time' }], consistency: () => 75 },
    } as Record<string, any>;
    const ctx = { ...app.ctx, maybe: (id: string) => (id === 'day' ? app.ctx.maybe(id) : f[id]) } as typeof app.ctx;

    const off = (await tool.run(ctx, { weeks: 4 })) as any;
    expect(off.sleep).toBeUndefined();
    expect(off.energy).toBeUndefined();
    expect(off.withheld).toEqual(['sleep', 'energy']);
    expect(off.habits.avg14).toBe(75);
    expect(JSON.stringify(off)).not.toMatch(/dread|wakeMin/);

    app.ctx.settings.set('ai', { shareWellbeing: true });
    const on = (await tool.run(ctx, {})) as any;
    expect(on.weeks).toBe(8);
    expect(on.withheld).toBeUndefined();
    expect(on.sleep.avgSleepMin).toBe(450);
    expect(on.sleep.nights).toBeUndefined(); // per-night rows stay out of the prompt
    expect(on.energy.weekly[0].dread).toBe(5);
    expect(on.energy.daily).toBeUndefined();
  });

  it('metricsForClaude leaves out nothing but the wellbeing data when sharing is off', () => {
    const s = { weeks: 4, from: '2026-10-04', to: '2026-10-26', weekStarts: [], missing: {}, failed: [], sleep: { nights: [] }, energy: { daily: [] }, stops: { held: 1 } } as unknown as InsightsSummary;
    const out = metricsForClaude(s, false) as any;
    expect(out.stops).toEqual({ held: 1 });
    expect(out.sleep).toBeUndefined();
    expect(out.withheld).toEqual(['sleep', 'energy']);
  });
});
