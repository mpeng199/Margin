import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import type { HabitsService } from './manifest';
import { consistencyLast, consistencyOver, isReady, missedTwice, isDue, recentDays, dateRange, type HabitCore } from './logic';

const TODAY = '2026-10-26'; // a Monday
const set = (...d: string[]) => new Set(d);
const daily = (start = '2026-10-01'): HabitCore => ({ type: 'yesno', target: 1, startDate: start, schedule: { kind: 'days', days: [1, 2, 3, 4, 5, 6, 7] } });
const mwf = (start = '2026-09-01'): HabitCore => ({ type: 'yesno', target: 1, startDate: start, schedule: { kind: 'days', days: [1, 3, 5] } });
const perWeek = (n: number, start = '2026-09-01'): HabitCore => ({ type: 'yesno', target: 1, startDate: start, schedule: { kind: 'perWeek', n } });

describe('consistency math', () => {
  it('specific weekdays: today is pending until done, not a miss', () => {
    // Mon/Wed/Fri in the 14 days to Mon Oct 26: Oct 14, 16, 19, 21, 23 (today excluded). Oct 21 missed.
    const done = set('2026-10-14', '2026-10-16', '2026-10-19', '2026-10-23');
    const two = consistencyLast(mwf(), done, 14, TODAY);
    expect(two).toMatchObject({ scheduled: 5, done: 4, pct: 80 });
    // Doing today's scheduled one adds it to both sides.
    const withToday = consistencyLast(mwf(), set(...done, TODAY), 14, TODAY);
    expect(withToday).toMatchObject({ scheduled: 6, done: 5, pct: 83 });
    // Four weeks: 11 scheduled before today, 9 done.
    const four = consistencyLast(mwf(), set(...done, '2026-09-30', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12'), 28, TODAY);
    expect(four).toMatchObject({ scheduled: 11, done: 9, pct: 82 });
  });

  it('days before the start date are not misses', () => {
    const c = consistencyLast(daily('2026-10-20'), set('2026-10-20', '2026-10-21'), 14, TODAY);
    expect(c).toMatchObject({ scheduled: 6, done: 2 }); // Oct 20..25; today is pending
    expect(consistencyLast(daily('2026-10-26'), set(), 14, TODAY).pct).toBeNull(); // starts today: nothing scheduled yet
  });

  it('N per week: judged week by week, pro-rated for partial weeks, a big week does not pay for an empty one', () => {
    // Weeks (Sunday start): Oct 11–17 (window covers 13–17), Oct 18–24, Oct 25– (Oct 25 only; today pending).
    const done = set('2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23');
    const c = consistencyLast(perWeek(3), done, 14, TODAY);
    // expected = 3*5/7 + 3 + 3/7 = 5.571; got = min(2, 2.143) + 3 + 0 = 5
    expect(c.pct).toBe(90);
    expect(c.done).toBe(5);
    // Five days in one week and one in the next: the extra two days don't count toward the second week.
    const lumpy = consistencyOver(perWeek(3), set('2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-18'), '2026-10-11', '2026-10-24', TODAY);
    expect(lumpy.pct).toBe(Math.round(((3 + 1) / 6) * 100)); // 67
  });

});

describe('never miss twice', () => {
  it('daily: one miss is fine, two in a row triggers, doing it clears', () => {
    const base = ['2026-10-22', '2026-10-23'];
    expect(missedTwice(daily(), set(...base), TODAY)).toBe(true); // Oct 24 and 25 passed
    expect(missedTwice(daily(), set(...base, '2026-10-24'), TODAY)).toBe(false); // one miss (Oct 25)
    expect(missedTwice(daily(), set(...base, '2026-10-25'), TODAY)).toBe(false);
    expect(missedTwice(daily(), set(...base, TODAY), TODAY)).toBe(false); // done today clears it
    expect(missedTwice(daily('2026-10-25'), set(), TODAY)).toBe(false); // only one scheduled day has passed
  });

  it('only scheduled days count', () => {
    // Mon/Wed/Fri, last done Mon Oct 19: Wed 21 and Fri 23 passed.
    expect(missedTwice(mwf(), set('2026-10-19'), TODAY)).toBe(true);
    expect(missedTwice(mwf(), set('2026-10-19', '2026-10-21'), TODAY)).toBe(false);
    // Tue/Thu non-scheduled days between don't count: last done Fri Oct 23, today Mon Oct 26 → nothing missed.
    expect(missedTwice(mwf(), set('2026-10-23'), TODAY)).toBe(false);
  });

  it('N per week: two short weeks in a row, and nothing yet this week', () => {
    const h = perWeek(3, '2026-09-20');
    expect(missedTwice(h, set('2026-10-06', '2026-10-13'), TODAY)).toBe(true);
    expect(missedTwice(h, set('2026-10-06', '2026-10-13', '2026-10-25'), TODAY)).toBe(false); // started this week
    expect(missedTwice(h, set('2026-10-12', '2026-10-13', '2026-10-14'), TODAY)).toBe(false); // last week held
    expect(missedTwice(perWeek(3, '2026-10-13'), set(), TODAY)).toBe(false); // the week of Oct 11 wasn't fully in play
  });
});

describe('due, ready and recent strip', () => {
  it('N per week stays on the list until the week is met', () => {
    const h = perWeek(2);
    expect(isDue(h, set(), TODAY)).toBe(true);
    expect(isDue(h, set('2026-10-25', '2026-10-26'), '2026-10-27')).toBe(false);
    expect(isDue(h, set('2026-10-25', '2026-10-26'), TODAY)).toBe(true); // already done today: stays visible, checked
  });
  it('ready needs two weeks in and 80% in each of the last two weeks', () => {
    const all = dateRange('2026-10-13', '2026-10-25').filter((d) => d !== '2026-10-15' && d !== '2026-10-22');
    expect(isReady(daily('2026-10-05'), set(...all), TODAY)).toBe(true);
    expect(isReady(daily('2026-10-20'), set(...all), TODAY)).toBe(false); // started 6 days ago
    // 5 of 7 in the older week is 71%
    const weak = dateRange('2026-10-13', '2026-10-25').filter((d) => !['2026-10-15', '2026-10-16', '2026-10-22'].includes(d));
    expect(isReady(daily('2026-10-05'), set(...weak), TODAY)).toBe(false);
  });
  it('recent strip marks misses as neutral data and rest days as rest', () => {
    // Tue 20 … Mon 26 for Mon/Wed/Fri: Wed 21 missed, Fri 23 done, Mon 26 (today) still pending.
    const r = recentDays(mwf(), set('2026-10-23'), TODAY, 7);
    expect(r.map((x) => x.status)).toEqual(['rest', 'miss', 'rest', 'done', 'rest', 'rest', 'pending']);
    expect(r[0].date).toBe('2026-10-20');
  });
});

const boot = (at = '2026-10-26T16:00:00-04:00') => testApp({ at, only: ['day', 'habits'] });
const habits = (app: Awaited<ReturnType<typeof boot>>) => app.ctx.service<HabitsService>('habits');

describe('formation limit', () => {
  it('allows two in formation, blocks the third, and unlocks it after both hold 80% for two weeks', async () => {
    const app = await boot();
    const h = habits(app);
    const a = h.add({ name: 'Stretch', startDate: '2026-10-05' });
    const b = h.add({ name: 'Read', startDate: '2026-10-05' });
    expect(h.slots()).toMatchObject({ max: 2, used: 2, free: 0, canAdd: false });
    expect(() => h.add({ name: 'Third' })).toThrow(/next one unlocks/);
    expect((await app.req('POST', '/api/habits', { name: 'Third' })).status).toBe(409);

    // Not ready yet: nothing logged, so graduation is refused and the slot stays closed.
    expect(() => h.graduate(a.id)).toThrow(/80%/);

    // Both hold the bar: every day of the last 13 except one in each week (6/7 and 5/6 ≥ 80%).
    for (const id of [a.id, b.id]) {
      for (const d of dateRange('2026-10-13', '2026-10-25')) if (d !== '2026-10-15' && d !== '2026-10-22') h.log(id, d, 1);
    }
    const s = h.slots();
    expect(s.ready).toEqual([a.id, b.id]);
    expect(s.canAdd).toBe(false);
    expect(s.reason).toMatch(/Move them to automatic/);

    // Graduating one frees one slot; the habit leaves the daily view.
    const g = h.graduate(a.id);
    expect(g.state).toBe('automatic');
    expect(h.due().map((x) => x.id)).not.toContain(a.id);
    expect(h.slots()).toMatchObject({ used: 1, free: 1, canAdd: true });
    expect(h.add({ name: 'Third' }).name).toBe('Third');
    expect(h.slots().canAdd).toBe(false);
  });

  it('a habit that hasn’t held 80% in the older week is not ready (71%)', async () => {
    const app = await boot();
    const h = habits(app);
    const a = h.add({ name: 'Stretch', startDate: '2026-10-05' });
    for (const d of dateRange('2026-10-13', '2026-10-25')) if (!['2026-10-15', '2026-10-16', '2026-10-22'].includes(d)) h.log(a.id, d, 1);
    expect(h.get(a.id)!.ready).toBe(false);
    expect(h.get(a.id)!.consistency2w).toBe(77); // 10 of 13 scheduled days
    expect(() => h.graduate(a.id)).toThrow(/Lally 2010/);
    h.archive(a.id); // stopping frees the slot too
    expect(h.slots().free).toBe(2);
  });

  it('exposes Lally 2010 research, never a 21-day claim', async () => {
    const app = await boot();
    const r = (await app.req('GET', '/api/habits/overview')).json;
    expect(r.research).toEqual({ median: 66, min: 18, max: 254, source: 'Lally 2010' });
    expect(JSON.stringify(r)).not.toMatch(/\b21\b/);
  });
});

describe('seed library and phase one', () => {
  it('is off until chosen, and phase one turns on exactly three, idempotently', async () => {
    const app = await boot();
    const h = habits(app);
    expect(h.list()).toHaveLength(0);
    expect(h.library()).toHaveLength(11);
    expect(h.library().filter((l) => l.phaseOne).map((l) => l.key).sort()).toEqual(['fixed-wake', 'phone-out', 'shutdown-complete']);

    const first = h.enablePhaseOne();
    expect(first.map((x) => x.name)).toEqual(['Fixed wake time', 'Shutdown complete', 'Phone out of the bedroom']);
    const second = h.enablePhaseOne();
    expect(second.map((x) => x.id)).toEqual(first.map((x) => x.id));
    expect(h.list()).toHaveLength(3);
    // through the route, as onboarding does
    const r = await app.req('POST', '/api/habits/phase-one');
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(3);
    expect(h.list()).toHaveLength(3);
    // The starting set fills the slots: nothing else is added until it holds.
    expect(h.slots()).toMatchObject({ used: 3, canAdd: false });
    expect(() => h.fromLibrary('daylight')).toThrow(/unlocks/);
    // Shutdown isn't scheduled on the off-day (Saturday).
    expect(first[1].schedule).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5, 7] });
    // Stopping one and running phase one again brings it back (still no duplicates).
    h.archive(first[0].id);
    expect(h.enablePhaseOne().map((x) => x.id)).toEqual(first.map((x) => x.id));
    expect(h.list()).toHaveLength(3);
  });
});

describe('auto-logging from events', () => {
  async function setup() {
    const app = await boot();
    const h = habits(app);
    for (const k of ['fixed-wake', 'shutdown-complete', 'lights-out', 'weekly-review', 'breaks-50-10']) h.fromLibrary(k, { force: true });
    const byKey = (k: string) => h.list().find((x) => x.key === k)!;
    const logs = (k: string) => app.ctx.db.all('SELECT * FROM habit_logs WHERE habit_id = ?', byKey(k).id);
    const events = () => app.ctx.db.all("SELECT * FROM events WHERE name = 'habit.logged'").length;
    return { app, h, byKey, logs, events };
  }

  it('shutdown.completed logs “Shutdown complete” once, even if the event repeats, and never over a manual log', async () => {
    const { app, h, byKey, logs, events } = await setup();
    app.ctx.bus.emit('shutdown.completed', { date: TODAY, at: '2026-10-26T20:50:00-04:00' });
    app.ctx.bus.emit('shutdown.completed', { date: TODAY, at: '2026-10-26T20:51:00-04:00' });
    await flush();
    expect(logs('shutdown-complete')).toHaveLength(1);
    expect(logs('shutdown-complete')[0]).toMatchObject({ value: 1, source: 'auto', date: TODAY });
    expect(events()).toBe(1);
    expect(byKey('shutdown-complete').autoLogged).toBe(true);
    // Manual log of the same habit on a later date, then the event: the manual one stays.
    h.log(byKey('shutdown-complete').id, '2026-10-27', 1, 'manual');
    h.autoLog('shutdown', '2026-10-27', 0);
    expect(logs('shutdown-complete').find((l) => l.date === '2026-10-27')).toMatchObject({ value: 1, source: 'manual' });
    expect(events()).toBe(2);
  });

  it('checkin.submitted logs wake time within ±30 min and bedtime within 15 min of lights-out', async () => {
    const { app, byKey, logs } = await setup();
    const entries: Record<string, any> = {
      // wake 06:30, lights-out the night before 22:00 (Sunday night → Monday school day)
      '2026-10-26': { date: '2026-10-26', bedtime: '22:10', wakeTime: '06:40', sleepMin: 510, energy: 6 },
      '2026-10-27': { date: '2026-10-27', bedtime: '23:00', wakeTime: '07:20', sleepMin: 500, energy: 5 },
    };
    const ctx = app.ctx as any;
    const orig = ctx.maybe.bind(ctx);
    ctx.maybe = (id: string) => (id === 'checkin' ? { entry: (d: string) => entries[d] ?? null } : orig(id));
    app.ctx.bus.emit('checkin.submitted', { date: '2026-10-26', sleepMin: 510, energy: 6 });
    app.ctx.bus.emit('checkin.submitted', { date: '2026-10-26', sleepMin: 510, energy: 6 }); // repeat: no duplicate
    app.ctx.bus.emit('checkin.submitted', { date: '2026-10-27', sleepMin: 500, energy: 5 });
    await flush();
    expect(logs('fixed-wake').map((l) => [l.date, l.value])).toEqual([['2026-10-26', 1], ['2026-10-27', 0]]);
    expect(logs('lights-out').map((l) => [l.date, l.value])).toEqual([['2026-10-26', 1], ['2026-10-27', 0]]);
    expect(byKey('fixed-wake').value).toBe(1);
  });

  it('bedtime after midnight and ISO times from the check-in are understood', async () => {
    const { app, logs } = await setup();
    const entries: Record<string, any> = {
      '2026-10-26': { date: '2026-10-26', bedtime: '2026-10-25T22:05:00-04:00', wakeTime: '2026-10-26T06:25:00-04:00' },
      '2026-10-27': { date: '2026-10-27', bedtime: '00:20', wakeTime: '06:30' },
    };
    const ctx = app.ctx as any;
    const orig = ctx.maybe.bind(ctx);
    ctx.maybe = (id: string) => (id === 'checkin' ? { entry: (d: string) => entries[d] ?? null } : orig(id));
    app.ctx.bus.emit('checkin.submitted', { date: '2026-10-26', sleepMin: 500, energy: 5 });
    app.ctx.bus.emit('checkin.submitted', { date: '2026-10-27', sleepMin: 370, energy: 5 });
    await flush();
    expect(logs('lights-out').map((l) => [l.date, l.value])).toEqual([['2026-10-26', 1], ['2026-10-27', 0]]);
    expect(logs('fixed-wake').map((l) => [l.date, l.value])).toEqual([['2026-10-26', 1], ['2026-10-27', 1]]);
  });

  it('review.completed and focus.completed log their habits once; short blocks do not count', async () => {
    const { app, logs, events } = await setup();
    app.ctx.bus.emit('review.completed', { weekStart: '2026-10-25' });
    app.ctx.bus.emit('review.completed', { weekStart: '2026-10-25' });
    app.ctx.bus.emit('focus.completed', { projectId: 'p1', taskId: null, minutes: 8 });
    await flush();
    expect(logs('weekly-review')).toHaveLength(1);
    expect(logs('breaks-50-10')).toHaveLength(0);
    app.ctx.bus.emit('focus.completed', { projectId: 'p1', taskId: null, minutes: 50 });
    app.ctx.bus.emit('focus.completed', { projectId: 'p2', taskId: null, minutes: 50 });
    await flush();
    expect(logs('breaks-50-10')).toHaveLength(1);
    expect(events()).toBe(2);
  });
});

describe('logging by type, reminders, rule', () => {
  it('count, minutes and 0–10 habits are done at their target; yes/no clamps; undo removes the log', async () => {
    const app = await boot();
    const h = habits(app);
    const water = h.add({ name: 'Water', type: 'count', target: 6, startDate: '2026-10-20' });
    h.log(water.id, TODAY, 4);
    expect(h.get(water.id)).toMatchObject({ value: 4, done: false });
    h.log(water.id, TODAY, 6);
    expect(h.get(water.id)).toMatchObject({ value: 6, done: true });
    const wind = h.add({ name: 'Wind-down', type: 'scale', target: 6, startDate: '2026-10-20' });
    h.log(wind.id, TODAY, 5);
    expect(h.get(wind.id)!.done).toBe(false);
    h.log(wind.id, TODAY, 12); // clamps to 10
    expect(h.get(wind.id)).toMatchObject({ value: 10, done: true });
    expect(() => h.log(wind.id, TODAY, -1)).toThrow();
    const r = await app.req('DELETE', `/api/habits/${wind.id}/log/${TODAY}`);
    expect(r.json.value).toBeNull();
    expect((await app.req('GET', '/api/habits/today')).json.due.map((x: any) => x.name)).toEqual(['Water', 'Wind-down']);
  });

  it('reminders are wellbeing notifications at the habit’s wall-clock time, DST-safe, skipped once done', async () => {
    const app = await boot('2026-11-01T06:00:00-05:00');
    const h = habits(app);
    const v = h.add({ name: 'Stretch', cueAfter: 'I brush my teeth', cueWill: 'stretch for two minutes', reminder: '07:00', startDate: '2026-10-30' });
    const m = app.ctx.registry.get('habits')!;
    const plan = m.notifications!(app.ctx, '2026-11-01');
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ key: `habit.reminder:${v.id}:2026-11-01`, category: 'wellbeing', title: 'Stretch', body: 'After I brush my teeth, I will stretch for two minutes.' });
    expect(plan[0].at.toISO()).toBe('2026-11-01T07:00:00.000-05:00');
    expect(m.notifications!(app.ctx, '2026-10-31')[0].at.toISO()).toBe('2026-10-31T07:00:00.000-04:00');
    h.log(v.id, '2026-11-01', 1);
    expect(m.notifications!(app.ctx, '2026-11-01')).toHaveLength(0);
  });

  it('habits.missed_twice is met when a habit in formation was missed two scheduled days running', async () => {
    const app = await boot();
    const h = habits(app);
    const cond = app.ctx.registry.get('habits')!.rules!.conditions!.find((c) => c.id === 'habits.missed_twice')!;
    const a = h.add({ name: 'Stretch', startDate: '2026-10-20' });
    h.log(a.id, '2026-10-22', 1);
    const res = await cond.evaluate(app.ctx, {});
    expect(res).toMatchObject({ met: true, subject: a.id });
    expect(res.detail).toMatch(/Stretch/);
    h.log(a.id, '2026-10-24', 1);
    expect((await cond.evaluate(app.ctx, {})).met).toBe(false);
    expect(h.get(a.id)!.missedTwice).toBe(false);
  });

  it('validates the builder input at the route', async () => {
    const app = await boot();
    expect((await app.req('POST', '/api/habits', { name: '' })).status).toBe(400);
    expect((await app.req('POST', '/api/habits', { name: 'x', schedule: { kind: 'days', days: [9] } })).status).toBe(400);
    const ok = await app.req('POST', '/api/habits', { name: 'Walk', why: 'Clears my head', cueAfter: 'lunch', cueWill: 'walk ten minutes', type: 'minutes', target: 10, schedule: { kind: 'perWeek', n: 3 }, reminder: '12:30' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ name: 'Walk', state: 'formation', cue: 'After lunch, I will walk ten minutes.', day: 1 });
  });
});
