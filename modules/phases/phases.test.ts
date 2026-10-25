import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import { createPhasesService, type PhasesService } from './manifest';
import type { Ctx } from '../../src/core/types';

const boot = (when = '2026-10-26T09:00:00-04:00') => testApp({ at: when, only: ['day', 'checkin', 'phases'] });
type Score = { weekStart: string; energy: number | null; dread: number | null; effective: number | null; sleepAvgMin: number | null; stopBreaks: number };
const score = (weekStart: string, energy: number | null, dread: number | null): Score => ({ weekStart, energy, dread, effective: 5, sleepAvgMin: 480, stopBreaks: 0 });

/** The review module may not be on; give the phases service a stand-in for it. */
function withReview(ctx: Ctx, scores: Score[] | null): PhasesService {
  const maybe = ctx.maybe.bind(ctx);
  return createPhasesService({ ...ctx, maybe: ((id: string) => (id === 'review' && scores ? { scores: () => scores } : maybe(id))) as Ctx['maybe'] });
}
const steady = [score('2026-11-29', 5, 7), score('2026-12-06', 5, 7), score('2026-12-13', 6, 6), score('2026-12-20', 6, 6)];

describe('phases', () => {
  it('moves Stabilize → Recover by the calendar from phase1Start', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    const svc = app.ctx.service<PhasesService>('phases');
    const at = (iso: string) => { app.setNow(`${iso}T09:00:00${iso < '2026-11-01' ? '-04:00' : '-05:00'}`); return svc.current(); };
    expect(at('2026-10-26')).toMatchObject({ phase: 'stabilize', week: 1, startDate: '2026-10-26', phaseWeeks: 2 });
    expect(at('2026-11-08')).toMatchObject({ phase: 'stabilize', week: 2 });
    expect(at('2026-11-09')).toMatchObject({ phase: 'recover', week: 3 }); // across the Nov 1 clock change, still day 14
    expect(at('2026-12-20')).toMatchObject({ phase: 'recover', week: 8, phaseWeeks: 8 });
    expect(svc.current().rules).toEqual(['Keep the stop.', 'Cut what the review flags.', 'Protect the off-day.']);
  });

  it('lists each phase’s rules', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    expect(app.ctx.service<PhasesService>('phases').current().rules).toEqual([
      'Hold the stop every night.', 'Sleep before everything.', 'Deload training.', 'Nothing new.',
    ]);
  });

  it('starts counting from the first check-in (or today) when no start date is set', async () => {
    const app = await boot('2026-10-30T09:00:00-04:00');
    const svc = app.ctx.service<PhasesService>('phases');
    expect(svc.current()).toMatchObject({ startDate: '2026-10-30', week: 1 });
    app.ctx.service<any>('checkin').submit({ date: '2026-10-20', bedtime: '22:30', wakeTime: '06:30', energy: 5 });
    expect(svc.current()).toMatchObject({ startDate: '2026-10-20', week: 2 });
  });

  it('holds Rebuild back until 3 steady weekly scores, and says why', async () => {
    const app = await boot('2026-12-28T09:00:00-05:00'); // week 10 from Oct 26
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });

    const ok = withReview(app.ctx, steady).current();
    expect(ok).toMatchObject({ phase: 'rebuild', week: 10, stableWeeks: 3 });
    expect(ok.holdReason).toBeUndefined();

    // Same scores in any order
    expect(withReview(app.ctx, [...steady].reverse()).current().phase).toBe('rebuild');

    // Latest week: energy fell
    const dipped = withReview(app.ctx, [...steady.slice(0, 3), score('2026-12-20', 4, 6)]).current();
    expect(dipped.phase).toBe('recover');
    expect(dipped.stableWeeks).toBe(0);
    expect(dipped.holdReason).toMatch(/Rebuild starts after 3 weekly scores/);
    expect(dipped.holdReason).toMatch(/energy was lower/);

    // Dread rose two weeks ago but the last two are steady: only 2 in a row
    const two = withReview(app.ctx, [score('2026-11-29', 6, 5), score('2026-12-06', 6, 7), score('2026-12-13', 6, 7), score('2026-12-20', 7, 6)]).current();
    expect(two).toMatchObject({ phase: 'recover', stableWeeks: 2 });

    // Not enough reviews yet, and a week without scores
    expect(withReview(app.ctx, steady.slice(2)).current().phase).toBe('recover');
    expect(withReview(app.ctx, [...steady.slice(0, 3), score('2026-12-20', null, null)]).current().phase).toBe('recover');
  });

  it('stays in Recover when there is no weekly review to read scores from', async () => {
    const app = await boot('2026-12-28T09:00:00-05:00');
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    const cur = app.ctx.service<PhasesService>('phases').current();
    expect(cur.phase).toBe('recover');
    expect(cur.holdReason).toMatch(/weekly review/);
  });

  it('a manual override wins over the calendar and the gate', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26', override: 'rebuild' });
    expect(app.ctx.service<PhasesService>('phases').current()).toMatchObject({ phase: 'rebuild', week: 1, override: true });
    app.ctx.settings.set('phases', { override: 'auto' });
    expect(app.ctx.service<PhasesService>('phases').current()).toMatchObject({ phase: 'stabilize', override: false });
  });

  it('canAddCommitment: not before Rebuild', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    const svc = app.ctx.service<PhasesService>('phases');
    expect(svc.canAddCommitment()).toMatchObject({ allowed: false });
    expect(svc.canAddCommitment().reason).toMatch(/Nothing new is added before Rebuild.*Stabilize, week 1/);
    app.setNow('2026-11-16T09:00:00-05:00');
    expect(svc.canAddCommitment().reason).toMatch(/Recover, week 4/);
  });

  it('canAddCommitment: in Rebuild, only after 3 steady weeks, and one at a time', async () => {
    const app = await boot('2026-12-28T09:00:00-05:00');
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    expect(withReview(app.ctx, steady.slice(1)).canAddCommitment().allowed).toBe(false); // gate holds → still Recover

    app.ctx.settings.set('phases', { override: 'rebuild' });
    const noScores = withReview(app.ctx, [score('2026-12-13', 5, 5), score('2026-12-20', 5, 5)]);
    expect(noScores.canAddCommitment()).toMatchObject({ allowed: false });
    expect(noScores.canAddCommitment().reason).toMatch(/3 steady weekly scores. 1 so far/);

    const svc = withReview(app.ctx, steady);
    expect(svc.canAddCommitment()).toEqual({ allowed: true });

    // A project becoming active is a re-add: the next one waits three weeks.
    app.ctx.bus.emit('project.status_changed', { id: 'p1', from: 'proposed', to: 'core' });
    await flush();
    const after = svc.canAddCommitment();
    expect(after.allowed).toBe(false);
    expect(after.reason).toMatch(/One at a time.*until 2027-01-18/);
    app.setNow('2027-01-18T09:00:00-05:00');
    expect(svc.canAddCommitment().allowed).toBe(true);

    // Moving between active statuses isn't a re-add.
    app.ctx.bus.emit('project.status_changed', { id: 'p1', from: 'core', to: 'maintain' });
    await flush();
    expect(svc.canAddCommitment().allowed).toBe(true);
  });

  it('serves the current phase over HTTP', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    const r = await app.req('GET', '/api/phases/current');
    expect(r.json).toMatchObject({ phase: 'stabilize', week: 1 });
    expect((await app.req('GET', '/api/phases/can-add')).json.allowed).toBe(false);
  });

  it('emits phase.changed when the phase turns over', async () => {
    const app = await boot();
    app.ctx.settings.set('phases', { phase1Start: '2026-10-26' });
    const job = app.ctx.registry.get('phases')!.jobs![0];
    await job.run(app.ctx);
    app.setNow('2026-11-09T09:00:00-05:00');
    await job.run(app.ctx);
    await flush();
    expect(app.ctx.bus.since('phase.changed', '2000-01-01').map((e) => e.payload)).toEqual([{ from: 'stabilize', to: 'recover' }]);
  });
});
