import { describe, it, expect } from 'vitest';
import { testApp } from '../helpers';

describe('boot + day module', () => {
  it('serves day state with computed anchors', async () => {
    const app = await testApp({ at: '2026-10-26T15:00:00-04:00' });
    const r = await app.req('GET', '/api/day/state');
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe('day');
    expect(r.json.anchors.hardStop).toBe('2026-10-26T21:00:00.000-04:00');
  });

  it('rejects writes without the X-Margin header and foreign hosts', async () => {
    const app = await testApp();
    const r1 = await app.app.request('/api/day/break-stop', { method: 'POST', headers: { host: '127.0.0.1:7317' }, body: '{}' });
    expect(r1.status).toBe(403);
  });

  it('late night: allowed before 4 PM, once per week', async () => {
    const app = await testApp({ at: '2026-10-27T15:00:00-04:00' });
    const ok = await app.req('POST', '/api/day/late-night', { reason: 'Lab poster due' });
    expect(ok.status).toBe(200);
    expect(ok.json.anchors.effectiveStop).toBe('2026-10-27T22:00:00.000-04:00');
    app.setNow('2026-10-29T12:00:00-04:00');
    const again = await app.req('POST', '/api/day/late-night', { reason: 'again' });
    expect(again.status).toBe(409);
    app.setNow('2026-11-02T17:00:00-05:00');
    const late = await app.req('POST', '/api/day/late-night', { reason: 'too late' });
    expect(late.status).toBe(409);
    expect(late.json.error).toMatch(/before 4 PM/);
  });

  it('evening after the stop, and before wake the next morning', async () => {
    const app = await testApp({ at: '2026-10-26T21:05:00-04:00' });
    expect((await app.req('GET', '/api/day/state')).json.mode).toBe('evening');
    app.setNow('2026-10-27T05:00:00-04:00');
    const s = (await app.req('GET', '/api/day/state')).json;
    expect(s.mode).toBe('evening');
    expect(s.date).toBe('2026-10-26');
  });
});
