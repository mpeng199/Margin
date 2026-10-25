import { describe, it, expect } from 'vitest';
import { testApp } from '../../tests/helpers';
import type { RitualsService } from './manifest';

const boot = () => testApp({ at: '2026-10-26T16:00:00-04:00', only: ['day', 'rituals'] });

describe('rituals module', () => {
  it('ships the shutdown, weekly-review and morning defaults in order', async () => {
    const app = await boot();
    const r = app.ctx.service<RitualsService>('rituals');
    expect(r.get('shutdown').steps.map((s) => s.label)).toEqual([
      'Brain dump every open loop',
      'Give each item a next action and a day or slot',
      'Choose tomorrow’s must-dos',
      'Glance at tomorrow’s calendar',
      'Confirm every deadline in the next 72 hours is covered',
      'Phone goes out of the bedroom',
      'Shutdown complete',
    ]);
    expect(r.get('weekly-review').steps).toHaveLength(9);
    expect(r.get('morning').steps.map((s) => s.id)).toEqual(['checkin', 'daylight', 'today']);
    for (const ritual of r.list()) {
      for (const s of ritual.steps) {
        expect(s.core).toBe(true);
        expect(s.why, `${ritual.id}/${s.id} why`).toBeTruthy();
      }
    }
    expect(r.get('shutdown').steps.find((s) => s.id === 'dump')!.source).toBe('Masicampo & Baumeister 2011');
    expect(r.get('shutdown').steps.find((s) => s.id === 'phone')!.source).toBe('Carter 2016');
  });

  it('renames, reorders, adds and removes steps, keeps ids stable, and flags only built-in steps as core', async () => {
    const app = await boot();
    const r = app.ctx.service<RitualsService>('rituals');
    const before = r.get('shutdown').steps;
    const reordered = [before[1], before[0], ...before.slice(2)].map((s) => (s.id === 'dump' ? { ...s, label: 'Dump it all' } : s));
    const saved = r.save('shutdown', [...reordered, { label: 'Lay out clothes' }]);
    expect(saved.steps.map((s) => s.id).slice(0, 3)).toEqual(['actions', 'dump', 'must-dos']);
    expect(saved.steps.find((s) => s.id === 'dump')!.label).toBe('Dump it all');
    const custom = saved.steps[saved.steps.length - 1];
    expect(custom.label).toBe('Lay out clothes');
    expect(custom.id).toMatch(/^custom-/);
    expect(custom.core).toBeUndefined();
    // the why/source of a built-in step survive a save that omits them
    expect(saved.steps.find((s) => s.id === 'dump')!.why).toBe(before[0].why);
    // a client cannot promote a custom step to core
    const forged = r.save('shutdown', [{ ...custom, core: true }]);
    expect(forged.steps[0].core).toBeUndefined();
    // removal of core steps is allowed by the service (the UI confirms)
    expect(forged.steps).toHaveLength(1);
    expect(r.get('shutdown').steps).toHaveLength(1);
    expect(r.isCustomised('shutdown')).toBe(true);
    expect(r.isCustomised('morning')).toBe(false);
  });

  it('rejects empty rituals and blank labels, and resets to the defaults', async () => {
    const app = await boot();
    const r = app.ctx.service<RitualsService>('rituals');
    expect(() => r.save('morning', [])).toThrow(/at least one step/);
    expect(() => r.save('morning', [{ label: '  ' }])).toThrow(/needs a name/);
    expect(() => r.get('nope' as any)).toThrow(/Unknown ritual/);
    r.save('morning', [{ label: 'Only this' }]);
    expect(r.get('morning').steps).toHaveLength(1);
    expect(r.reset('morning').steps).toHaveLength(3);
    expect(r.isCustomised('morning')).toBe(false);
  });

  it('serves the checklists over the API', async () => {
    const app = await boot();
    const list = await app.req('GET', '/api/rituals');
    expect(list.json.map((x: any) => x.id)).toEqual(['shutdown', 'weekly-review', 'morning']);
    const put = await app.req('PUT', '/api/rituals/morning', { steps: [{ id: 'checkin', label: 'Check in' }, { label: 'Stretch' }] });
    expect(put.status).toBe(200);
    expect(put.json.steps.map((s: any) => s.label)).toEqual(['Check in', 'Stretch']);
    expect((await app.req('GET', '/api/rituals/morning')).json.steps).toHaveLength(2);
    expect((await app.req('GET', '/api/rituals/unknown')).status).toBe(404);
    expect((await app.req('POST', '/api/rituals/morning/reset')).json.steps).toHaveLength(3);
  });
});
