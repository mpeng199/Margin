import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import { at, addDays, fromISO, type ISODate } from '../../src/core/time';
import { computeSleep, napNote, shortNights, weekendDrift, energyTrend, lowSleepMostNights, type Night } from './sleep';
import type { CheckinService } from './manifest';

const boot = (when = '2026-10-26T08:00:00-04:00') => testApp({ at: when, only: ['day', 'checkin', 'gethelp', 'phases'] });

/** Bedtime (HH:mm) that gives `sleepMin` before a 06:30 wake on an ordinary night. */
const bedFor = (sleepMin: number) => {
  const m = (((6 * 60 + 30 - sleepMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const night = (date: ISODate, sleepMin: number, wake = '06:30', energy?: number): Night => ({ date, wakeTime: at(date, wake).toISO()!, sleepMin, energy });

describe('sleep math', () => {
  it('counts elapsed time across the Nov 1 2026 fall-back: 10:00 PM EDT to 6:30 AM EST is 9h 30m', () => {
    const s = computeSleep('2026-11-01', '22:00', '06:30');
    expect(s.sleepMin).toBe(9 * 60 + 30);
    expect(s.bedtime.toISO()).toBe('2026-10-31T22:00:00.000-04:00');
    expect(s.wake.toISO()).toBe('2026-11-01T06:30:00.000-05:00');
  });

  it('counts a night short by an hour when clocks spring forward', () => {
    expect(computeSleep('2026-03-08', '22:00', '06:30').sleepMin).toBe(7 * 60 + 30);
  });

  it('treats a bedtime after midnight as the same date and an evening bedtime as the night before', () => {
    const late = computeSleep('2026-10-27', '00:30', '06:30');
    expect(late.bedtime.toISODate()).toBe('2026-10-27');
    expect(late.sleepMin).toBe(360);
    const evening = computeSleep('2026-10-27', '23:15', '06:30');
    expect(evening.bedtime.toISODate()).toBe('2026-10-26');
    expect(evening.sleepMin).toBe(435);
  });

  it('refuses times that cannot be a night of sleep', () => {
    expect(() => computeSleep('2026-10-26', '09:00', '06:30')).toThrow(/night of sleep/);
    expect(() => computeSleep('2026-10-26', '06:20', '06:30')).toThrow(/night of sleep/);
  });

  it('adds a gentle note for naps over 20 minutes or after 4 PM, and none inside the bounds', () => {
    expect(napNote(20, '15:30')).toBeNull();
    expect(napNote(45, '13:00')).toMatch(/over 20 minutes/);
    expect(napNote(15, '16:30')).toMatch(/after 4 PM/);
    expect(napNote(null)).toBeNull();
  });
});

describe('rule conditions (pure)', () => {
  const today = '2026-10-26';

  it('short nights: all of the last N under the hours, in a row, and recent', () => {
    const three = [night('2026-10-26', 6 * 60), night('2026-10-25', 6 * 60 + 40), night('2026-10-24', 5 * 60 + 50)];
    const v = shortNights(three, 7, 3, today);
    expect(v.met).toBe(true);
    expect(v.detail).toMatch(/Under 7 hours of sleep 3 nights running/);
    expect(shortNights([night('2026-10-26', 6 * 60), night('2026-10-25', 7 * 60 + 30), night('2026-10-24', 6 * 60)], 7, 3, today).met).toBe(false);
    expect(shortNights(three.slice(0, 2), 7, 3, today).met).toBe(false);
    // stale: the newest entry is a week old
    expect(shortNights(three.map((n, i) => night(addDays(today, -7 - i), 6 * 60)), 7, 3, today).met).toBe(false);
  });

  it('weekend drift: weekend wake later than school days by more than maxMin', () => {
    const base: Night[] = [night('2026-10-19', 400), night('2026-10-20', 400), night('2026-10-21', 400), night('2026-10-22', 400), night('2026-10-23', 400)];
    const school = [1, 2, 3, 4, 5];
    const late = [...base, night('2026-10-24', 500, '09:30'), night('2026-10-25', 500, '09:30')];
    const v = weekendDrift(late, school, 90);
    expect(v.met).toBe(true);
    expect(v.detail).toMatch(/3h later/);
    expect(weekendDrift([...base, night('2026-10-24', 500, '08:00')], school, 90).met).toBe(false); // exactly 90 is allowed
    expect(weekendDrift(base, school, 90).met).toBe(false); // no weekend yet
  });

  it('energy trend: up, flat and down over three weekly averages; sparse weeks never count', () => {
    const run = (levels: [number, number, number]) => {
      const out: Night[] = [];
      for (let d = 0; d < 21; d++) {
        const date = addDays(today, -(20 - d));
        out.push(night(date, 480, '06:30', levels[Math.floor(d / 7)]));
      }
      return out;
    };
    expect(energyTrend(run([4, 5, 6]), 'up', 3, today).met).toBe(true);
    expect(energyTrend(run([4, 5, 6]), 'down', 3, today).met).toBe(false);
    expect(energyTrend(run([6, 5, 4]), 'down', 3, today).met).toBe(true);
    expect(energyTrend(run([5, 5, 5]), 'flat', 3, today).met).toBe(true);
    expect(energyTrend(run([5, 5, 5]), 'flat', 3, today, 1, 5).met).toBe(false); // flat, but not below 5
    expect(energyTrend(run([5, 5.4, 5.5]), 'up', 3, today).met).toBe(false); // under one point of change
    expect(energyTrend(run([4, 5, 6]).slice(0, 8), 'up', 3, today).met).toBe(false);
  });

  it('low sleep on most nights needs a majority of at least 7 recent check-ins', () => {
    const mk = (n: number, low: number) => Array.from({ length: n }, (_, i) => night(addDays(today, -i), i < low ? 5 * 60 + 30 : 8 * 60));
    expect(lowSleepMostNights(mk(12, 8), 6, today).met).toBe(true);
    expect(lowSleepMostNights(mk(12, 6), 6, today).met).toBe(false);
    expect(lowSleepMostNights(mk(6, 6), 6, today).met).toBe(false);
  });
});

describe('checkin service', () => {
  it('saves a check-in, answers entry/entries/sleepNights, and emits checkin.submitted', async () => {
    const app = await boot('2026-11-02T08:00:00-05:00');
    const svc = app.ctx.service<CheckinService>('checkin');
    const e = svc.submit({ date: '2026-11-01', bedtime: '22:00', wakeTime: '06:30', energy: 6 });
    expect(e.sleepMin).toBe(570);
    expect(svc.entry('2026-11-01')?.energy).toBe(6);
    svc.submit({ date: '2026-11-02', bedtime: '23:00', wakeTime: '06:30', energy: 7 });
    expect(svc.entries('2026-11-01', '2026-11-02').map((x) => x.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(svc.sleepNights(1)).toMatchObject([{ date: '2026-11-02', sleepMin: 450 }]);
    expect(svc.sleepNights(5).map((n) => n.date)).toEqual(['2026-11-02', '2026-11-01']);
    await flush();
    const evs = app.ctx.bus.since('checkin.submitted', '2000-01-01');
    expect(evs.map((x) => x.payload)).toEqual(expect.arrayContaining([{ date: '2026-11-01', sleepMin: 570, energy: 6 }]));
    const st = svc.state();
    expect(st.submitted).toBe(true);
    expect(st.summary).toBe('7h 30m · energy 7');
  });

  it('replaces an existing check-in for the same date', () => boot().then((app) => {
    const svc = app.ctx.service<CheckinService>('checkin');
    svc.submit({ bedtime: '22:30', wakeTime: '06:30', energy: 4 });
    svc.submit({ bedtime: '22:30', wakeTime: '06:30', energy: 8 });
    expect(svc.entries('2026-10-01', '2026-10-31')).toHaveLength(1);
    expect(svc.entry('2026-10-26')?.energy).toBe(8);
  }));

  it('prefills bedtime from last night’s lights-out and wake from the wake setting, then from the previous entry', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    expect(svc.prefill('2026-10-26')).toEqual({ bedtime: '22:00', wakeTime: '06:30' });
    expect(svc.state().submitted).toBe(false);
  });

  it('rejects future dates and impossible energy', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    expect(() => svc.submit({ date: '2026-10-27', bedtime: '22:00', wakeTime: '06:30', energy: 5 })).toThrow(/hasn’t happened/);
    expect(() => svc.submit({ bedtime: '22:00', wakeTime: '06:30', energy: 11 })).toThrow();
  });

  it('custom metrics are data: add one, answer it, archive it, and past answers stay', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    const mood = svc.addMetric({ label: 'Mood', type: '0-10' });
    const run = svc.addMetric({ label: 'Went outside', type: 'yes/no' });
    expect(mood.key).toBe('mood');
    expect(svc.addMetric({ label: 'Mood', type: 'number' }).key).toBe('mood_2');
    const e = svc.submit({ bedtime: '22:00', wakeTime: '06:30', energy: 5, extras: { mood: 7, [run.key]: true, nonsense: 3 } });
    expect(e.extras).toEqual({ mood: 7, went_outside: true });
    expect(() => svc.submit({ bedtime: '22:00', wakeTime: '06:30', energy: 5, extras: { mood: 11 } })).toThrow(/0 to 10/);
    svc.archiveMetric('mood');
    expect(svc.metrics().map((m) => m.key)).not.toContain('mood');
    expect(svc.entry('2026-10-26')?.extras.mood).toBe(7);
  });

  it('plans a daily caffeine cutoff reminder as a wellbeing notification', async () => {
    const app = await boot();
    const planned = app.ctx.registry.get('checkin')!.notifications!(app.ctx, '2026-10-26');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ category: 'wellbeing', title: 'Caffeine cutoff', key: 'checkin.caffeine:2026-10-26' });
    expect(planned[0].body).toMatch(/Drake 2013/);
    expect(planned[0].at.toISO()).toBe('2026-10-26T14:00:00.000-04:00');
    app.ctx.settings.set('checkin', { caffeineReminder: false });
    expect(app.ctx.registry.get('checkin')!.notifications!(app.ctx, '2026-10-26')).toEqual([]);
  });

  it('evaluates the registered conditions against saved check-ins', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    const cond = (id: string) => app.ctx.registry.get('checkin')!.rules!.conditions!.find((c) => c.id === id)!;
    for (const d of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      app.setNow(`${d}T09:00:00-04:00`);
      svc.submit({ date: d, bedtime: bedFor(6 * 60 + 10), wakeTime: '06:30', energy: 5 });
    }
    const short = await cond('sleep.short_nights').evaluate(app.ctx, { hours: 7, nights: 3 });
    expect(short.met).toBe(true);
    expect((await cond('sleep.short_nights').evaluate(app.ctx, { hours: 6, nights: 3 })).met).toBe(false);
    // Sat/Sun are weekend days; weekdays wake at 6:30 but the weekend is later
    const wake = (d: string, w: string, e: number) => { app.setNow(`${d}T10:00:00-04:00`); svc.submit({ date: d, bedtime: '22:30', wakeTime: w, energy: e }); };
    wake('2026-10-19', '06:30', 5); wake('2026-10-20', '06:30', 5); wake('2026-10-21', '06:30', 5);
    wake('2026-10-24', '09:45', 5); wake('2026-10-25', '09:15', 5); // replaces the earlier short-night entries for those dates
    app.setNow('2026-10-26T09:00:00-04:00');
    const drift = await cond('sleep.weekend_drift').evaluate(app.ctx, { maxMin: 90 });
    expect(drift.met).toBe(true);
    expect((await cond('sleep.weekend_drift').evaluate(app.ctx, { maxMin: 240 })).met).toBe(false);
  });

  it('energy trend reads the weekly averages out of real check-ins', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    const cond = app.ctx.registry.get('checkin')!.rules!.conditions!.find((c) => c.id === 'checkin.energy_trend')!;
    for (let k = 20; k >= 0; k--) {
      const d = addDays('2026-10-26', -k);
      app.setNow(`${d}T09:00:00-04:00`);
      svc.submit({ date: d, bedtime: '22:30', wakeTime: '06:30', energy: [4, 5, 6][Math.floor((20 - k) / 7)] });
    }
    expect((await cond.evaluate(app.ctx, { direction: 'up', weeks: 3, minChange: 1, below: 10 })).met).toBe(true);
    expect((await cond.evaluate(app.ctx, { direction: 'down', weeks: 3, minChange: 1, below: 10 })).met).toBe(false);
  });
});

describe('baseline (onboarding step 8)', () => {
  const baseline = { bedtime: '23:30', wakeTime: '06:45', caffeineTime: '16:00', energy: 4, dread: 7, effective: 5, redFlags: [] as string[], phase1Start: '2026-10-26' };

  it('records the baseline and sets the phase 1 start date without opening Get help', async () => {
    const app = await boot();
    const r = await app.req('POST', '/api/checkin/baseline', baseline);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, openedHelp: false });
    expect(app.ctx.service<CheckinService>('checkin').baseline()).toMatchObject({ energy: 4, dread: 7, effective: 5 });
    expect(app.ctx.settings.get<any>('phases').phase1Start).toBe('2026-10-26');
    expect(app.ctx.service<any>('gethelp').state().open).toBe(false);
  });

  it('any red flag opens Get help with the reason "baseline"', async () => {
    const app = await boot();
    const r = await app.req('POST', '/api/checkin/baseline', { ...baseline, redFlags: ['low_mood'] });
    expect(r.json.openedHelp).toBe(true);
    const st = app.ctx.service<any>('gethelp').state();
    expect(st.open).toBe(true);
    expect(st.reason).toBe('baseline');
    await flush();
    expect(app.ctx.bus.since('gethelp.opened', '2000-01-01').map((e) => e.payload.reason)).toContain('baseline');
  });
});

describe('privacy', () => {
  it('keeps check-in, sleep and mood data out of Claude unless wellbeing sharing is on', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    svc.submit({ bedtime: '23:00', wakeTime: '06:30', energy: 3 });
    const m = app.ctx.registry.get('checkin')!;
    const tool = m.claude!.tools!.find((t) => t.name === 'get_checkins')!;

    // missing setting = off
    expect(await m.claude!.context!(app.ctx)).toBeNull();
    expect(await tool.run(app.ctx, {})).toEqual({ available: false });

    app.ctx.settings.set('ai', { shareWellbeing: false });
    expect(await m.claude!.context!(app.ctx)).toBeNull();
    expect(await tool.run(app.ctx, {})).toEqual({ available: false });

    app.ctx.settings.set('ai', { shareWellbeing: true });
    expect(await m.claude!.context!(app.ctx)).toMatchObject({ lastWeek: [{ date: '2026-10-26', sleepMin: 450, energy: 3 }] });
    expect(await tool.run(app.ctx, {})).toMatchObject([{ date: '2026-10-26', energy: 3 }]);
  });
});

describe('routes', () => {
  it('POST /api/checkin/submit then GET /api/checkin/today shows the summary line', async () => {
    const app = await boot();
    const pre = await app.req('GET', '/api/checkin/today');
    expect(pre.json).toMatchObject({ submitted: false, prefill: { bedtime: '22:00', wakeTime: '06:30' } });
    const post = await app.req('POST', '/api/checkin/submit', { bedtime: '22:30', wakeTime: '06:30', energy: 6 });
    expect(post.status).toBe(200);
    const bad = await app.req('POST', '/api/checkin/submit', { bedtime: '22:30', wakeTime: '06:30', energy: 12 });
    expect(bad.status).toBe(400);
    const today = await app.req('GET', '/api/checkin/today');
    expect(today.json).toMatchObject({ submitted: true, summary: '8h · energy 6' });
    const rules = await app.req('GET', '/api/checkin/rules');
    expect(rules.json.length).toBeGreaterThanOrEqual(6);
    expect(fromISO(today.json.entry.bedtime).toFormat('HH:mm')).toBe('22:30');
  });
});
