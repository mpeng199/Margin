import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import type { GetHelpService } from './manifest';
import { RED_FLAGS } from './flags';

const boot = () => testApp({ at: '2026-10-26T09:00:00-04:00', only: ['day'] });

describe('gethelp', () => {
  it('is a core module that cannot be turned off', async () => {
    const app = await boot();
    expect(app.ctx.registry.isEnabled('gethelp')).toBe(true);
    expect(() => app.ctx.registry.setEnabled('gethelp', false)).toThrow(/core/);
  });

  it('open() records a request for today and emits gethelp.opened', async () => {
    const app = await boot();
    const help = app.ctx.service<GetHelpService>('gethelp');
    expect(help.state()).toMatchObject({ open: false, dismissedToday: false, requests: [] });
    const r = help.open('Under 6 hours of sleep on most nights');
    expect(r.created).toBe(true);
    const st = help.state();
    expect(st.open).toBe(true);
    expect(st.reason).toBe('Under 6 hours of sleep on most nights');
    await flush();
    expect(app.ctx.bus.since('gethelp.opened', '2000-01-01').map((e) => e.payload)).toEqual([{ reason: 'Under 6 hours of sleep on most nights' }]);
  });

  it('records the same reason once a day', async () => {
    const app = await boot();
    const help = app.ctx.service<GetHelpService>('gethelp');
    const a = help.open('baseline');
    const b = help.open('baseline');
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    expect(help.state().requests).toHaveLength(1);
    await flush();
    expect(app.ctx.bus.since('gethelp.opened', '2000-01-01')).toHaveLength(1);
  });

  it('dismisses for today only: a re-check the same day stays quiet, a new reason shows, and the next day it can open again', async () => {
    const app = await boot();
    const help = app.ctx.service<GetHelpService>('gethelp');
    help.open('rule: low sleep');
    expect(help.dismiss()).toMatchObject({ open: false, dismissedToday: true });

    help.open('rule: low sleep'); // the same rule checking again must not undo the dismissal
    expect(help.state().open).toBe(false);

    help.open('red-flags'); // something new from the person
    expect(help.state().open).toBe(true);
    help.dismiss();
    expect(help.state().open).toBe(false);

    app.setNow('2026-10-27T09:00:00-04:00');
    expect(help.state()).toMatchObject({ open: false, dismissedToday: false, requests: [] }); // nothing is open until something opens it
    help.open('rule: low sleep'); // the rule still holds, so the morning check opens it again
    expect(help.state()).toMatchObject({ open: true, reason: 'rule: low sleep' });
  });

  it('shows the trusted adult only when a phone number is set', async () => {
    const app = await boot();
    const help = app.ctx.service<GetHelpService>('gethelp');
    expect(help.state().contact).toBeNull();
    app.ctx.settings.set('gethelp', { trustedAdultName: 'Aunt Mei', trustedAdultPhone: '555-0100' });
    expect(help.state().contact).toEqual({ name: 'Aunt Mei', phone: '555-0100' });
    expect(help.contact()?.name).toBe('Aunt Mei');
  });

  it('red-flag check: any yes opens Get help, all no does not, unknown ids are ignored', async () => {
    const app = await boot();
    const none = Object.fromEntries(RED_FLAGS.map((f) => [f.id, false]));
    const r0 = await app.req('POST', '/api/gethelp/red-flags', { answers: none });
    expect(r0.json).toEqual({ opened: false, yes: [] });
    expect(app.ctx.service<GetHelpService>('gethelp').state().open).toBe(false);

    const r1 = await app.req('POST', '/api/gethelp/red-flags', { answers: { ...none, nonsense: true } });
    expect(r1.json.opened).toBe(false);

    const r2 = await app.req('POST', '/api/gethelp/red-flags', { answers: { ...none, low_mood: true, short_sleep: true } });
    expect(r2.json).toEqual({ opened: true, yes: ['low_mood', 'short_sleep'] });
    expect(app.ctx.service<GetHelpService>('gethelp').state()).toMatchObject({ open: true, reason: 'red-flags' });

    const bad = await app.req('POST', '/api/gethelp/red-flags', { answers: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('serves state and dismiss over HTTP', async () => {
    const app = await boot();
    app.ctx.service<GetHelpService>('gethelp').open('baseline');
    expect((await app.req('GET', '/api/gethelp/state')).json.open).toBe(true);
    expect((await app.req('POST', '/api/gethelp/dismiss')).json).toMatchObject({ open: false, dismissedToday: true });
  });

  it('lists all six red flags from the spec, phrased as plain statements', () => {
    expect(RED_FLAGS).toHaveLength(6);
    expect(RED_FLAGS.map((f) => f.id)).toContain('self_harm');
    for (const f of RED_FLAGS) expect(f.text).not.toMatch(/!|disorder|diagnos/i);
  });
});
