/**
 * Integration tests on recorded response shapes (tests/fixtures/*.json), run through the REAL live-mode
 * code paths: TodoistClient + incremental sync into the mirror, Google OAuth refresh + calendarList +
 * events sync. Only global fetch is stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { testApp } from '../helpers';
import type { TodoistService } from '../../modules/todoist/manifest';
import type { GoogleService } from '../../modules/google/manifest';

const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', name), 'utf8'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('recorded Todoist responses', () => {
  it('full + incremental sync land correctly in the mirror (priority, due parsing, deletes, completions)', async () => {
    const app = await testApp({ at: '2026-10-26T15:00:00-04:00', only: ['todoist'] });
    app.ctx.keychain.set('todoist.token', 'recorded-token');
    app.ctx.settings.set('todoist', { mode: 'live' });
    const queue = [fx('todoist-sync-full.json'), { full_sync: false, sync_token: 'after-full', items: [] }, fx('todoist-sync-incremental.json')];
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname} ${String(init.body ?? '').slice(0, 40)}`);
      expect((init.headers as any).authorization).toBe('Bearer recorded-token');
      return json(queue.shift());
    });
    const td = app.ctx.service<TodoistService>('todoist');
    await td.sync();
    expect(calls[0]).toMatch(/^POST \/api\/v1\/sync sync_token=\*/);
    expect(calls[1]).toMatch(/sync_token=TnYUZ/); // the extra incremental right after a full sync
    const water = td.task('6X7rM8997g3RQmvh')!;
    expect(water).toMatchObject({ priority: 1, labels: ['home'], sectionName: 'This week', durationMin: 15 });
    expect(water.due).toEqual({ date: '2026-10-27', time: '09:00', recurring: true, string: 'every day at 9am' }); // 13:00Z → 9:00 EDT
    expect(td.task('6X7rfFVPjhvv84XG')!.due).toMatchObject({ date: '2026-10-27', time: '16:00', recurring: false }); // floating
    expect(td.task('6X7rfEVP8hvv25ZQ')).toMatchObject({ parentId: '6X7rM8997g3RQmvh', deadline: '2026-11-03', priority: 3 });
    expect(td.status().plan).toMatchObject({ maxProjects: 5, durations: false });

    await td.sync();
    expect(td.tasks().map((t) => t.id)).toEqual(['6X7rM8997g3RQmvh']); // completed one closed, deleted one gone
    expect(td.task('6X7rfEVP8hvv25ZQ')).toBeNull();
    expect(td.completions('2026-10-26', '2026-10-26').map((c) => c.task_id)).toContain('6X7rfFVPjhvv84XG');
  });
});

describe('recorded Google Calendar responses', () => {
  it('refreshes the token, syncs calendars and events with sync tokens, and applies cancellations', async () => {
    const app = await testApp({ at: '2026-10-26T15:00:00-04:00', only: ['google'] });
    app.ctx.keychain.set('google.client', JSON.stringify({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret' }));
    app.ctx.keychain.set('google.refresh', 'refresh-token');
    app.ctx.settings.set('google', { mode: 'live' });
    let round = 0;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      seen.push(`${init.method ?? 'GET'} ${u.pathname}${u.searchParams.get('syncToken') ? ' (incremental)' : ''}`);
      if (u.host === 'oauth2.googleapis.com') {
        expect(String(init.body)).toContain('grant_type=refresh_token');
        return json({ access_token: 'access-1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/calendar.events.readonly', token_type: 'Bearer' });
      }
      expect((init.headers as any).authorization).toBe('Bearer access-1');
      if (u.pathname.endsWith('/users/me/calendarList')) { round++; return json(fx('google-calendarlist.json')); }
      if (u.pathname.includes('michaelpeng199%40gmail.com') || u.pathname.includes('michaelpeng199@gmail.com')) {
        if (u.searchParams.get('syncToken')) {
          expect(u.searchParams.get('timeMin')).toBeNull(); // not allowed with syncToken
          return json(fx('google-events-incremental.json'));
        }
        return json(fx('google-events-full.json'));
      }
      return json({ kind: 'calendar#events', items: [], nextSyncToken: `holiday-${round}` });
    });
    const g = app.ctx.service<GoogleService>('google');
    await g.sync();
    expect(seen[0]).toMatch(/^POST \/token/);
    const week = g.eventsBetween('2026-10-26T00:00:00-04:00', '2026-11-05T00:00:00-05:00');
    const badminton = week.filter((e) => e.title === 'Badminton');
    expect(badminton.map((e) => e.start)).toEqual(['2026-10-27T06:00:00.000-04:00', '2026-11-03T06:00:00.000-05:00']);
    expect(badminton.every((e) => e.busy && e.recurring)).toBe(true);
    expect(week.find((e) => e.title === 'BASKETBALL TRYOUTS')).toMatchObject({ allDay: true, busy: false, start: '2026-10-28', end: '2026-10-29' });
    expect(week.find((e) => e.title.startsWith('Study hall'))!.busy).toBe(false);
    expect(week.find((e) => e.title.startsWith('Deep work'))).toMatchObject({ marginKind: 'block', marginRef: '6X7rM8997g3RQmvh' });

    await g.sync();
    expect(seen.some((s) => s.includes('(incremental)'))).toBe(true);
    expect(g.eventsBetween('2026-10-26T00:00:00-04:00', '2026-11-05T00:00:00-05:00').some((e) => e.title === 'BASKETBALL TRYOUTS')).toBe(false);
  });

  it('turns invalid_grant into a reconnect banner instead of an error loop', async () => {
    const app = await testApp({ at: '2026-10-26T15:00:00-04:00', only: ['google'] });
    app.ctx.keychain.set('google.client', JSON.stringify({ clientId: 'cid', clientSecret: 'secret' }));
    app.ctx.keychain.set('google.refresh', 'expired');
    app.ctx.settings.set('google', { mode: 'live' });
    vi.stubGlobal('fetch', async () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const g = app.ctx.service<GoogleService>('google');
    await expect(g.sync()).rejects.toThrow(/sign-in expired/);
    expect(g.status().needsReconnect).toBe(true);
  });
});
