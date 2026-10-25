import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import { detectWarnings, type TrainingSession } from './manifest';

const D = '2026-10-26'; // Monday
const s = (date: string, o: Partial<TrainingSession> = {}) => ({ date, soreness: null, dreaded: false, lifts: [], ...o });
const squat = (weight: number, reps = 5) => [{ name: 'Squat', weight, reps }];

describe('weekly warning check', () => {
  it('flags resting heart rate, stalled lifts, soreness and dread; two or more suggest a deload', () => {
    const none = detectWarnings({ date: D, sessions: [s('2026-10-24', { soreness: 3 })], rhr: [] });
    expect(none).toEqual({ signs: [], suggest: false });

    // RHR 4 over the 4-week average is not enough; 5 over is.
    const rhr = (latest: number) => [{ week: '2026-09-27', bpm: 56 }, { week: '2026-10-04', bpm: 56 }, { week: '2026-10-11', bpm: 56 }, { week: '2026-10-18', bpm: 56 }, { week: '2026-10-25', bpm: latest }];
    expect(detectWarnings({ date: D, sessions: [], rhr: rhr(60) }).signs).toEqual([]);
    const one = detectWarnings({ date: D, sessions: [], rhr: rhr(61) });
    expect(one.signs.map((x) => x.id)).toEqual(['rhr']);
    expect(one.suggest).toBe(false);

    // Squat: best 100 before, 2 sessions in the last 14 days with nothing higher -> stalled. Soreness mean 6.5 over 2 sessions.
    const sessions = [
      s('2026-09-28', { lifts: squat(100) }),
      s('2026-10-16', { lifts: squat(100) }),
      s('2026-10-23', { lifts: squat(100), soreness: 7 }),
      s('2026-10-25', { soreness: 6 }),
    ];
    const two = detectWarnings({ date: D, sessions, rhr: [] });
    expect(two.signs.map((x) => x.id)).toEqual(['lifts', 'soreness']);
    expect(two.suggest).toBe(true);

    // A new best clears the stall; two dreaded sessions in the week add a sign.
    const progressed = [...sessions.slice(0, 2), s('2026-10-23', { lifts: squat(105), dreaded: true }), s('2026-10-25', { dreaded: true })];
    expect(detectWarnings({ date: D, sessions: progressed, rhr: [] }).signs.map((x) => x.id)).toEqual(['dread']);
  });

  it('logs a session and reports the week with a rest-day note', async () => {
    const app = await testApp({ at: '2026-10-26T16:00:00-04:00', only: ['training'] });
    const post = await app.req('POST', '/api/training/sessions', { kind: 'gym', minutes: 60, rpe: 7, lifts: squat(100), soreness: 4, dreaded: false });
    expect(post.status).toBe(200);
    expect((await app.req('PUT', '/api/training/rhr', { bpm: 58 })).status).toBe(200);
    const o = (await app.req('GET', '/api/training/overview')).json;
    expect(o.week).toEqual({ sessions: 1, minutes: 60 });
    expect(o.rhr.thisWeek).toBe(58);
    expect(o.rest.restDays).toBe(1); // Sunday had no session
    expect(o.rest.message).toBeNull();
    expect(o.recent).toHaveLength(1);
    await app.req('POST', '/api/training/sessions', { kind: 'badminton', date: '2026-10-31', minutes: 90, rpe: 8 });
    expect((await app.req('GET', '/api/training/overview')).json.rest.message).toMatch(/trained on your off-day, Saturday/);
  });
});
