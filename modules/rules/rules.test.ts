import { describe, it, expect, vi } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import { addDays } from '../../src/core/time';
import { kvGet } from '../../src/core/kv';
import type { Ctx, RuleFiringInfo } from '../../src/core/types';
import type { CheckinService } from '../checkin/manifest';
import type { GetHelpService } from '../gethelp/manifest';
import { ruleActions, defaultRules, evaluateRules } from './manifest';

const boot = (only: string[] = []) => testApp({ at: '2026-10-26T09:00:00-04:00', only: ['day', 'checkin', 'gethelp', 'phases', 'rules', ...only] });
const info = (over: Partial<RuleFiringInfo> = {}): RuleFiringInfo => ({ ruleId: 'r1', ruleName: 'Test rule', detail: 'Something happened.', ...over });
const action = (id: string) => ruleActions.find((a) => a.id === id)!;
const stub = (ctx: Ctx, extra: Record<string, unknown>): Ctx => ({ ...ctx, maybe: ((id: string) => (id in extra ? extra[id] : ctx.maybe(id))) as Ctx['maybe'] });

/** Seed check-ins straight into SQLite (no events), so the test controls when rules run. */
function seedNights(app: Awaited<ReturnType<typeof boot>>, spec: { date: string; sleepMin: number; energy?: number }[]) {
  for (const n of spec) {
    app.ctx.db.run(`INSERT OR REPLACE INTO checkins (date, bedtime, wake_time, sleep_min, energy, extras, submitted_at) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      n.date, `${n.date}T00:00:00.000-04:00`, `${n.date}T06:30:00.000-04:00`, n.sleepMin, n.energy ?? 5, '2026-10-26T09:00:00.000-04:00');
  }
}

describe('default rules', () => {
  it('seeds the spec’s rules with stable ids, a why and a source on each', async () => {
    const app = await boot();
    const list = app.ctx.rules.list();
    for (const d of defaultRules) {
      const r = list.find((x) => x.id === d.id)!;
      expect(r, d.id).toBeTruthy();
      expect(r.enabled).toBe(true);
      expect(r.why?.length).toBeGreaterThan(10);
      expect(r.source?.length).toBeGreaterThan(3);
    }
    expect(defaultRules.map((d) => d.id)).toEqual([
      'default.stop_broken', 'default.short_sleep', 'default.dread_high', 'default.past_stop_on_project',
      'default.on_track', 'default.energy_flat', 'default.energy_worse', 'default.low_sleep_red_flag',
    ]);
  });

  it('marks rules unavailable while the module that owns a condition is not on', async () => {
    const app = await boot();
    const byId = Object.fromEntries(app.ctx.rules.list().map((r) => [r.id, r.available]));
    expect(byId['default.short_sleep']).toBe(true);
    expect(byId['default.energy_worse']).toBe(true);
    expect(byId['default.low_sleep_red_flag']).toBe(true);
    expect(byId['default.stop_broken']).toBe(false); // needs the shutdown module
    expect(byId['default.dread_high']).toBe(false); // needs the review module
  });

  it('registers all eight generic actions in the catalog', async () => {
    const app = await boot();
    const ids = app.ctx.rules.catalog().actions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['banner', 'notification', 'require_review_step', 'lock_add_projects', 'offday_non_negotiable', 'ask_claude', 'create_task', 'open_get_help']));
    const banner = app.ctx.rules.catalog().actions.find((a) => a.id === 'banner')!;
    expect((banner.params as any).properties.tone.enum).toEqual(['amber', 'green']);
  });

  it('end to end: 3 nights under 7 hours → lock adding projects, protect the off-day, show an amber banner', async () => {
    const app = await boot();
    seedNights(app, [
      { date: '2026-10-24', sleepMin: 6 * 60 + 20 },
      { date: '2026-10-25', sleepMin: 6 * 60 + 45 },
      { date: '2026-10-26', sleepMin: 5 * 60 + 50 },
    ]);
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(false);
    expect(kvGet(app.ctx.db, 'offday.locked', false)).toBe(false);

    const fired = await app.ctx.rules.evaluate();
    expect(fired.map((f) => f.ruleId)).toContain('default.short_sleep');
    const f = fired.find((x) => x.ruleId === 'default.short_sleep')!;
    expect(f.detail).toMatch(/Under 7 hours of sleep 3 nights running \(6h 20m, 6h 45m, 5h 50m\)/);
    expect(f.actions).toEqual(['lock_add_projects', 'offday_non_negotiable', 'banner']);

    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(true);
    expect(app.ctx.rules.isActive('default.short_sleep')).toBe(true);
    expect(kvGet(app.ctx.db, 'offday.locked', false)).toBe(true);

    // The Today widget gets the amber banner with the why and the source.
    const alerts = (await app.req('GET', '/api/rules/alerts')).json;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: 'default.short_sleep', tone: 'amber', source: 'AASM 2016; Panagioti 2017' });
    expect(alerts[0].text).toMatch(/Adding projects is locked/);
    expect(alerts[0].why).toBeTruthy();
    expect(alerts[0].detail).toMatch(/6h 20m/);

    // A rule fires once; evaluating again doesn't repeat it.
    expect(await app.ctx.rules.evaluate()).toEqual([]);

    // Hiding the banner for today must not lift the lock.
    await app.req('POST', `/api/rules/alerts/${alerts[0].id}/hide`);
    expect((await app.req('GET', '/api/rules/alerts')).json).toEqual([]);
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(true);
    expect(kvGet(app.ctx.db, 'offday.locked', false)).toBe(true);
    app.setNow('2026-10-27T09:00:00-04:00');
    expect((await app.req('GET', '/api/rules/alerts')).json).toHaveLength(1); // back tomorrow while it still holds

    // A full night ends it: the lock and the off-day flag clear.
    seedNights(app, [{ date: '2026-10-27', sleepMin: 8 * 60 }]);
    await evaluateRules(app.ctx);
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(false);
    expect(kvGet(app.ctx.db, 'offday.locked', true)).toBe(false);
    expect(app.ctx.rules.history().map((h) => h.resolvedAt).filter(Boolean)).toHaveLength(1);
  });

  it('a check-in triggers evaluation on its own (checkin.submitted)', async () => {
    const app = await boot();
    const svc = app.ctx.service<CheckinService>('checkin');
    for (const d of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      app.setNow(`${d}T09:00:00-04:00`);
      svc.submit({ date: d, bedtime: '00:30', wakeTime: '06:30', energy: 5 }); // 6 h
    }
    await flush(); await flush();
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(true);
    expect(app.ctx.rules.history()).toHaveLength(1);
  });

  it('worse energy after 3 weeks opens Get help, and keeps it out of the amber alerts', async () => {
    const app = await boot();
    const nights = Array.from({ length: 21 }, (_, i) => ({ date: addDays('2026-10-26', i - 20), sleepMin: 8 * 60, energy: [7, 6, 5][Math.floor(i / 7)] }));
    seedNights(app, nights);
    const fired = await app.ctx.rules.evaluate();
    expect(fired.map((f) => f.ruleId)).toEqual(['default.energy_worse']);
    expect(app.ctx.service<GetHelpService>('gethelp').state()).toMatchObject({ open: true, reason: 'Energy lower after 3 weeks' });
    expect((await app.req('GET', '/api/rules/alerts')).json).toEqual([]);
  });

  it('under 6 hours on most nights is a red flag that opens Get help; the card comes back the next morning', async () => {
    const app = await boot();
    seedNights(app, Array.from({ length: 10 }, (_, i) => ({ date: addDays('2026-10-26', -i), sleepMin: i < 7 ? 5 * 60 + 20 : 8 * 60 })));
    await evaluateRules(app.ctx);
    const help = app.ctx.service<GetHelpService>('gethelp');
    expect(help.state()).toMatchObject({ open: true, reason: 'Under 6 hours of sleep on most nights' });
    help.dismiss();
    expect(help.state().open).toBe(false);

    app.setNow('2026-10-27T07:05:00-04:00');
    seedNights(app, [{ date: '2026-10-27', sleepMin: 5 * 60 + 30 }]);
    await app.ctx.registry.get('rules')!.jobs![0].run(app.ctx); // the 07:00 job
    expect(help.state()).toMatchObject({ open: true, reason: 'Under 6 hours of sleep on most nights' });
  });

  it('the 07:00 job is scheduled for wake-up time and evaluates the rules', async () => {
    const app = await boot();
    const job = app.ctx.registry.get('rules')!.jobs![0];
    expect(job.at!(app.ctx, '2026-11-01')).toEqual(['07:00']);
    seedNights(app, [
      { date: '2026-10-24', sleepMin: 6 * 60 }, { date: '2026-10-25', sleepMin: 6 * 60 }, { date: '2026-10-26', sleepMin: 6 * 60 },
    ]);
    await job.run(app.ctx);
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(true);
  });
});

describe('generic actions', () => {
  it('banner stores its tone and text, filling {detail} and {subject}', async () => {
    const app = await boot();
    await action('banner').run(app.ctx, { tone: 'green', text: 'Good: {detail} ({subject})' }, info({ detail: 'Energy is up.', subject: 'Delphic' }));
    await action('banner').run(app.ctx, { tone: 'amber', text: '' }, info({ ruleId: 'r2', detail: 'Plain detail.' }));
    expect(kvGet(app.ctx.db, 'rules.banners', {})).toEqual({
      r1: { tone: 'green', text: 'Good: Energy is up. (Delphic)' },
      r2: { tone: 'amber', text: 'Plain detail.' },
    });
    expect(() => action('banner').params.parse({ tone: 'red', text: 'x' })).toThrow();
  });

  it('notification sends a wellbeing notification by default', async () => {
    const app = await boot();
    await action('notification').run(app.ctx, action('notification').params.parse({ title: 'Check in with yourself', body: '{detail}' }), info());
    const sent = app.ctx.notify.recent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Check in with yourself', body: 'Something happened.', category: 'wellbeing' });
  });

  it('require_review_step appends { id, label, ruleId } once', async () => {
    const app = await boot();
    const p = { stepId: 'remove-maintain-item', label: 'Remove one Maintain item' };
    await action('require_review_step').run(app.ctx, p, info({ ruleId: 'default.stop_broken' }));
    await action('require_review_step').run(app.ctx, p, info({ ruleId: 'default.stop_broken' }));
    await action('require_review_step').run(app.ctx, p, info({ ruleId: 'someone.else' }));
    await action('require_review_step').run(app.ctx, { stepId: 'cut-one-more', label: 'Cut one more commitment' }, info({ ruleId: 'default.energy_flat' }));
    expect(kvGet(app.ctx.db, 'review.requiredSteps', [])).toEqual([
      { id: 'remove-maintain-item', label: 'Remove one Maintain item', ruleId: 'default.stop_broken' },
      { id: 'cut-one-more', label: 'Cut one more commitment', ruleId: 'default.energy_flat' },
    ]);
  });

  it('lock_add_projects is the active firing itself, and offday_non_negotiable sets the kv flag', async () => {
    const app = await boot();
    app.ctx.rules.save({ id: 'test.lock', name: 'Lock test', enabled: true, when: [{ condition: 'sleep.short_nights', params: { hours: 12, nights: 2 } }], then: [{ action: 'lock_add_projects', params: {} }, { action: 'offday_non_negotiable', params: {} }] });
    seedNights(app, [{ date: '2026-10-25', sleepMin: 400 }, { date: '2026-10-26', sleepMin: 400 }]);
    await evaluateRules(app.ctx);
    expect(app.ctx.rules.isActive('lock_add_projects')).toBe(true);
    expect(kvGet(app.ctx.db, 'offday.locked', false)).toBe(true);
    await action('offday_non_negotiable').run(app.ctx, {}, info());
    expect(kvGet(app.ctx.db, 'offday.locked', false)).toBe(true);
  });

  it('ask_claude runs ai.ask when Claude is on, and queues the prompt otherwise', async () => {
    const app = await boot();
    const run = vi.fn().mockResolvedValue({ text: 'ok' });
    await action('ask_claude').run(stub(app.ctx, { ai: { enabled: () => true, run } }), { prompt: 'What should I cut?' }, info({ detail: 'Slept 5h 10m' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('ask', { prompt: 'What should I cut?', ruleId: 'r1' }); // the firing detail stays local
    expect(kvGet(app.ctx.db, 'ai.queue', [])).toEqual([]);

    await action('ask_claude').run(stub(app.ctx, { ai: { enabled: () => false, run } }), { prompt: 'Queued one' }, info());
    await action('ask_claude').run(stub(app.ctx, { ai: { enabled: () => true, run: vi.fn().mockRejectedValue(new Error('offline')) } }), { prompt: 'Queued after a failure' }, info());
    await action('ask_claude').run(app.ctx, { prompt: 'No ai module' }, info());
    const q = kvGet<any[]>(app.ctx.db, 'ai.queue', []);
    expect(q.map((x) => x.prompt)).toEqual(['Queued one', 'Queued after a failure', 'No ai module']);
    expect(q[0]).toMatchObject({ ruleId: 'r1', ruleName: 'Test rule' });
    expect(JSON.stringify(q)).not.toMatch(/Slept/);
  });

  it('create_task adds a Todoist task with the due string', async () => {
    const app = await boot(['todoist']);
    const td = app.ctx.service<any>('todoist');
    await td.sync();
    await action('create_task').run(app.ctx, { content: 'Review what to cut', dueString: 'tomorrow' }, info());
    await td.sync();
    const t = td.tasks({}).find((x: any) => x.content === 'Review what to cut');
    expect(t).toBeTruthy();
    expect(t.due?.date).toBe('2026-10-27');
  });

  it('create_task is skipped quietly when Todoist is off', async () => {
    const app = await boot();
    await expect(action('create_task').run(app.ctx, { content: 'x', dueString: '' }, info())).resolves.toBeUndefined();
  });

  it('open_get_help opens a request named for the rule', async () => {
    const app = await boot();
    await action('open_get_help').run(app.ctx, {}, info({ ruleName: 'Energy lower after 3 weeks' }));
    expect(app.ctx.service<GetHelpService>('gethelp').state()).toMatchObject({ open: true, reason: 'Energy lower after 3 weeks' });
  });

  it('a user-made rule saves through the engine with validated params', async () => {
    const app = await boot();
    const id = app.ctx.rules.save({ id: '', name: 'Mine', enabled: true, when: [{ condition: 'sleep.short_nights', params: { hours: 8, nights: 2 } }], then: [{ action: 'banner', params: { tone: 'amber', text: 'Short sleep.' } }] });
    expect(app.ctx.rules.list().find((r) => r.id === id)).toMatchObject({ name: 'Mine', available: true, builtin: false });
    expect(() => app.ctx.rules.save({ id: '', name: 'Bad', enabled: true, when: [], then: [{ action: 'require_review_step', params: {} }] })).toThrow();
  });
});
