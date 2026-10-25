/**
 * google — Google Calendar is the source of truth for events. Reads every calendar with incremental
 * sync tokens; writes only to calendars the app owns (one "Blocks" calendar + one per project).
 * Writing to a calendar the app didn't create needs the opt-in scope AND a per-change yes
 * (payload.confirmed === true, set only by an explicit confirmation in the UI).
 */
import path from 'node:path';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { j } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, getZone } from '../../src/core/time';
import { GoogleCalendarClient, SyncTokenGone, type GEvent } from '../../src/integrations/google/client';
import { startAuth, refresh, revoke, ReconnectRequired, BASE_SCOPES, SCOPES, type PendingAuth } from '../../src/integrations/google/oauth';
import { createMockGoogle } from '../../src/integrations/google/mock';

const settings = z.object({
  mode: z.enum(['mock', 'live']).default('mock').describe('Live uses your Google account; mock uses a local stand-in.'),
  syncEveryMin: z.number().int().min(1).max(60).default(5),
  blocksCalendarName: z.string().default('Margin · Blocks').describe('The calendar Margin writes time blocks to.'),
  projectCalendarPrefix: z.string().default('Project · ').describe('Prefix for per-project calendars.'),
  pastDays: z.number().int().min(7).max(365).default(60).describe('How far back the first full sync reaches.'),
  hiddenCalendars: z.array(z.string()).default([]).describe('Calendar ids to ignore in Margin.'),
});
type Settings = z.infer<typeof settings>;

export interface CalEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  color: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  status: string;
  appOwned: boolean;
  /** Set on events Margin created: block | fixed | phase | milestone | deadline | session | meeting */
  marginKind: string | null;
  marginRef: string | null;
  marginFixedId: string | null;
  projectId: string | null;
  recurring: boolean;
  htmlLink: string | null;
  description: string | null;
}

const MARK = 'margin';

export function createGoogleService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('google');
  let mock: ReturnType<typeof createMockGoogle> | null = null;
  const getMock = () => (mock ??= createMockGoogle({ file: path.join(ctx.dataDir, 'mock-google.json'), now: () => now() }));
  let access: { token: string; expiresAt: number } | null = null;
  let pending: PendingAuth | null = null;
  let syncing: Promise<void> | null = null;

  const clientCfg = () => j<{ clientId: string; clientSecret: string } | null>(ctx.keychain.get('google.client'), null);
  const scopes = (): string[] => s().mode === 'mock' ? getMock().state().scopes : kvGet(ctx.db, 'google.scopes', []);

  async function token(): Promise<string> {
    if (s().mode === 'mock') return 'mock-access';
    if (access && access.expiresAt > Date.now()) return access.token;
    const cfg = clientCfg();
    const rt = ctx.keychain.get('google.refresh');
    if (!cfg || !rt) throw Object.assign(new Error('Google Calendar isn’t connected.'), { status: 409 });
    try {
      const t = await refresh({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: rt });
      access = { token: t.accessToken, expiresAt: t.expiresAt };
      kvSet(ctx.db, 'google.needsReconnect', false);
      return t.accessToken;
    } catch (e) {
      if (e instanceof ReconnectRequired) {
        kvSet(ctx.db, 'google.needsReconnect', true);
        ctx.bus.emit('google.reconnect_needed', {});
      }
      throw e;
    }
  }
  const api = () => new GoogleCalendarClient(token, s().mode === 'mock' ? getMock().fetch : fetch);

  function toRow(calId: string, e: GEvent) {
    const allDay = !!e.start?.date;
    const zone = getZone();
    const start = allDay ? DateTime.fromISO(e.start!.date!, { zone }) : DateTime.fromISO(e.start?.dateTime ?? '', { zone });
    const end = allDay ? DateTime.fromISO(e.end!.date!, { zone }) : DateTime.fromISO(e.end?.dateTime ?? '', { zone });
    const priv = e.extendedProperties?.private ?? {};
    return {
      calendar_id: calId, id: e.id, status: e.status ?? 'confirmed', summary: e.summary ?? '(No title)',
      start: allDay ? e.start!.date! : start.toISO(), end: allDay ? e.end!.date! : end.toISO(),
      start_ms: start.isValid ? start.toMillis() : 0, end_ms: end.isValid ? end.toMillis() : 0, all_day: allDay,
      transparency: e.transparency ?? 'opaque', recurring_event_id: e.recurringEventId ?? null, event_type: e.eventType ?? 'default',
      margin_kind: priv[MARK] ? priv.marginKind ?? 'block' : null, margin_ref: priv.marginRef ?? null, margin_fixed: priv.marginFixedId ?? null,
      raw: JSON.stringify(e),
    };
  }
  function upsertEvent(calId: string, e: GEvent) {
    if (e.status === 'cancelled') { ctx.db.run('DELETE FROM gc_events WHERE calendar_id = ? AND id = ?', calId, e.id); return; }
    const r = toRow(calId, e);
    ctx.db.run(`INSERT INTO gc_events (calendar_id, id, status, summary, start, end, start_ms, end_ms, all_day, transparency, recurring_event_id, event_type, margin_kind, margin_ref, margin_fixed, raw)
      VALUES ($calendar_id, $id, $status, $summary, $start, $end, $start_ms, $end_ms, $all_day, $transparency, $recurring_event_id, $event_type, $margin_kind, $margin_ref, $margin_fixed, $raw)
      ON CONFLICT(calendar_id, id) DO UPDATE SET status=excluded.status, summary=excluded.summary, start=excluded.start, end=excluded.end, start_ms=excluded.start_ms,
        end_ms=excluded.end_ms, all_day=excluded.all_day, transparency=excluded.transparency, recurring_event_id=excluded.recurring_event_id, event_type=excluded.event_type,
        margin_kind=excluded.margin_kind, margin_ref=excluded.margin_ref, margin_fixed=excluded.margin_fixed, raw=excluded.raw`, r);
  }

  async function syncCalendar(c: GoogleCalendarClient, calId: string) {
    const row = ctx.db.get<{ sync_token: string | null }>('SELECT sync_token FROM gc_calendars WHERE id = ?', calId);
    let res;
    try {
      res = row?.sync_token ? await c.events(calId, { syncToken: row.sync_token }) : null;
    } catch (e) {
      if (!(e instanceof SyncTokenGone)) throw e;
      res = null;
    }
    if (!res) {
      // Full sync: wipe this calendar's cache, then fetch from timeMin.
      const timeMin = now().minus({ days: s().pastDays }).toUTC().toISO()!;
      res = await c.events(calId, { timeMin });
      ctx.db.run('DELETE FROM gc_events WHERE calendar_id = ?', calId);
    }
    ctx.db.tx(() => { for (const e of res!.items) upsertEvent(calId, e); });
    ctx.db.run('UPDATE gc_calendars SET sync_token = ? WHERE id = ?', res.nextSyncToken ?? null, calId);
  }

  function appCalendarId(kind: string, ref: string): string | null {
    return ctx.db.get<{ calendar_id: string }>('SELECT calendar_id FROM app_calendars WHERE kind = ? AND ref = ?', kind, ref)?.calendar_id ?? null;
  }
  function isAppOwned(calId: string) {
    return !!ctx.db.get('SELECT 1 FROM app_calendars WHERE calendar_id = ?', calId);
  }

  const svc = {
    settings: s,
    mock: () => (s().mode === 'mock' ? getMock() : null),

    status() {
      const sc = scopes();
      return {
        mode: s().mode,
        clientConfigured: s().mode === 'mock' || !!clientCfg(),
        connected: s().mode === 'mock' || ctx.keychain.has('google.refresh'),
        needsReconnect: kvGet(ctx.db, 'google.needsReconnect', false),
        connecting: !!pending,
        scopes: sc,
        canWriteOwned: sc.includes(SCOPES.eventsOwned),
        lastSyncAt: kvGet<string | null>(ctx.db, 'google.lastSyncAt', null),
        lastError: kvGet<string | null>(ctx.db, 'google.lastError', null),
        blocksCalendarId: appCalendarId('blocks', 'main'),
      };
    },

    setClient(clientId: string, clientSecret: string) {
      ctx.keychain.set('google.client', JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }));
    },

    /** Returns the consent URL; finishing happens in the background when Google redirects to the loopback. */
    async connect(opts: { primaryWrites?: boolean } = {}) {
      if (s().mode === 'mock' && !clientCfg()) {
        getMock().grant(opts.primaryWrites ? [...BASE_SCOPES, SCOPES.eventsOwned] : BASE_SCOPES);
        await svc.sync();
        return { url: null, mock: true };
      }
      const cfg = clientCfg();
      if (!cfg) throw Object.assign(new Error('Add your Google OAuth client ID and secret first (README, step 2).'), { status: 409 });
      pending?.cancel();
      const want = opts.primaryWrites ? [...BASE_SCOPES, SCOPES.eventsOwned] : BASE_SCOPES;
      pending = await startAuth({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: want });
      const p = pending;
      p.result.then(async (t) => {
        if (t.refreshToken) ctx.keychain.set('google.refresh', t.refreshToken);
        access = { token: t.accessToken, expiresAt: t.expiresAt };
        kvSet(ctx.db, 'google.scopes', t.scope);
        kvSet(ctx.db, 'google.needsReconnect', false);
        ctx.settings.set('google', { mode: 'live' });
        // Wipe mock-era cache so live data replaces it.
        ctx.db.exec('DELETE FROM gc_events; DELETE FROM gc_calendars; DELETE FROM app_calendars;');
        ctx.bus.emit('google.connected', { scopes: t.scope });
        await svc.sync().catch((e) => ctx.log.warn('first google sync failed', e.message));
      }).catch((e) => {
        kvSet(ctx.db, 'google.lastError', e.message);
        ctx.bus.emit('google.connect_failed', { error: e.message });
      }).finally(() => { if (pending === p) pending = null; });
      return { url: p.url, mock: false };
    },

    async disconnect() {
      const rt = ctx.keychain.get('google.refresh');
      if (rt) await revoke(rt);
      ctx.keychain.delete('google.refresh');
      access = null;
      kvSet(ctx.db, 'google.scopes', []);
      ctx.settings.set('google', { mode: 'mock' });
      ctx.db.exec('DELETE FROM gc_events; DELETE FROM gc_calendars; DELETE FROM app_calendars;');
    },

    async sync(): Promise<void> {
      if (syncing) return syncing;
      syncing = (async () => {
        try {
          const c = api();
          const list = await c.calendarList();
          const seen = new Set<string>();
          for (const cal of list.items) {
            if (cal.deleted) continue;
            seen.add(cal.id);
            ctx.db.run(`INSERT INTO gc_calendars (id, summary, color, access_role, is_primary, selected, raw) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, color=excluded.color, access_role=excluded.access_role, is_primary=excluded.is_primary, selected=excluded.selected, raw=excluded.raw`,
              cal.id, cal.summaryOverride ?? cal.summary, cal.backgroundColor ?? null, cal.accessRole, !!cal.primary, cal.selected !== false, JSON.stringify(cal));
          }
          for (const r of ctx.db.all<{ id: string }>('SELECT id FROM gc_calendars')) {
            if (!seen.has(r.id)) { ctx.db.run('DELETE FROM gc_calendars WHERE id = ?', r.id); ctx.db.run('DELETE FROM gc_events WHERE calendar_id = ?', r.id); }
          }
          const hidden = new Set(s().hiddenCalendars);
          for (const id of seen) if (!hidden.has(id)) await syncCalendar(c, id);
          kvSet(ctx.db, 'google.lastSyncAt', now().toISO());
          kvSet(ctx.db, 'google.lastError', null);
          ctx.bus.emit('google.synced', {});
        } catch (e: any) {
          kvSet(ctx.db, 'google.lastError', e.message);
          ctx.log.warn('google sync failed', e.message);
          throw e;
        } finally { syncing = null; }
      })();
      return syncing;
    },

    calendars() {
      const hidden = new Set(s().hiddenCalendars);
      return ctx.db.all('SELECT c.*, a.kind app_kind, a.ref app_ref FROM gc_calendars c LEFT JOIN app_calendars a ON a.calendar_id = c.id ORDER BY c.is_primary DESC, c.summary')
        .map((c) => ({ id: c.id, summary: c.summary, color: c.color, accessRole: c.access_role, primary: !!c.is_primary, appKind: c.app_kind, appRef: c.app_ref, hidden: hidden.has(c.id) }));
    },

    /** Events overlapping [start, end) across visible calendars (or the given ones). */
    eventsBetween(startIso: string, endIso: string, opts: { calendarIds?: string[] } = {}): CalEvent[] {
      const a = DateTime.fromISO(startIso).toMillis(), b = DateTime.fromISO(endIso).toMillis();
      const hidden = new Set(s().hiddenCalendars);
      const rows = ctx.db.all(`SELECT e.*, c.summary cal_name, c.color cal_color, a.kind app_kind, a.ref app_ref FROM gc_events e
        JOIN gc_calendars c ON c.id = e.calendar_id LEFT JOIN app_calendars a ON a.calendar_id = e.calendar_id
        WHERE e.start_ms < ? AND e.end_ms > ? AND e.status != 'cancelled' AND e.event_type NOT IN ('workingLocation')
        ORDER BY e.all_day DESC, e.start_ms`, b, a);
      return rows
        .filter((r) => (opts.calendarIds ? opts.calendarIds.includes(r.calendar_id) : !hidden.has(r.calendar_id)))
        .map((r) => {
          const raw = j<GEvent>(r.raw, {} as GEvent);
          return {
            id: r.id, calendarId: r.calendar_id, calendarName: r.cal_name, color: r.cal_color, title: r.summary,
            start: r.start, end: r.end, allDay: !!r.all_day,
            busy: !r.all_day && r.transparency !== 'transparent' && r.event_type !== 'birthday',
            status: r.status, appOwned: !!r.app_kind, marginKind: r.margin_kind, marginRef: r.margin_ref, marginFixedId: r.margin_fixed,
            projectId: r.app_kind === 'project' ? r.app_ref : null, recurring: !!r.recurring_event_id,
            htmlLink: raw.htmlLink ?? null, description: raw.description ?? null,
          } satisfies CalEvent;
        });
    },

    appCalendarId,
    isAppOwned,

    /** Find or create an app-owned calendar. Idempotent: reuses the stored id when it still exists. */
    async ensureAppCalendar(kind: 'blocks' | 'project', ref: string, summary: string, color?: string): Promise<string> {
      const existing = appCalendarId(kind, ref);
      if (existing && ctx.db.get('SELECT 1 FROM gc_calendars WHERE id = ?', existing)) return existing;
      const c = api();
      const cal = await c.insertCalendar({ summary, timeZone: getZone(), description: kind === 'blocks' ? 'Time blocks scheduled by Margin.' : 'Project timeline managed by Margin.' });
      if (color) await c.patchCalendarListEntry(cal.id, { backgroundColor: color, foregroundColor: '#ffffff', selected: true }).catch(() => {});
      ctx.db.run('INSERT OR REPLACE INTO app_calendars (kind, ref, calendar_id, created_at) VALUES (?, ?, ?, ?)', kind, ref, cal.id, now().toISO());
      await svc.sync().catch(() => {});
      return cal.id;
    },
    linkAppCalendar(kind: 'blocks' | 'project', ref: string, calendarId: string) {
      ctx.db.run('INSERT OR REPLACE INTO app_calendars (kind, ref, calendar_id, created_at) VALUES (?, ?, ?, ?)', kind, ref, calendarId, now().toISO());
    },

    async createEvent(calendarId: string, input: EventInput) {
      const ev = await api().insertEvent(calendarId, toGEvent(input));
      await svc.sync().catch(() => {});
      return ev;
    },
    async patchEvent(calendarId: string, eventId: string, input: Partial<EventInput>) {
      const ev = await api().patchEvent(calendarId, eventId, toGEvent(input, true));
      await svc.sync().catch(() => {});
      return ev;
    },
    async deleteEvent(calendarId: string, eventId: string) {
      await api().deleteEvent(calendarId, eventId);
      ctx.db.run('DELETE FROM gc_events WHERE calendar_id = ? AND (id = ? OR recurring_event_id = ?)', calendarId, eventId, eventId);
      await svc.sync().catch(() => {});
    },
    event(calendarId: string, eventId: string) {
      const r = ctx.db.get('SELECT * FROM gc_events WHERE calendar_id = ? AND id = ?', calendarId, eventId);
      return r ? { ...r, raw: j(r.raw, {}) } : null;
    },
  };
  return svc;
}
export type GoogleService = ReturnType<typeof createGoogleService>;

export interface EventInput {
  title: string;
  start: string; // ISO datetime, or YYYY-MM-DD when allDay
  end: string;   // exclusive for all-day
  allDay?: boolean;
  description?: string;
  busy?: boolean;
  recurrence?: string[];
  marginKind?: string;
  marginRef?: string;
  marginFixedId?: string;
}

export function toGEvent(i: Partial<EventInput>, partial = false): Partial<GEvent> {
  const out: Partial<GEvent> = {};
  if (i.title !== undefined) out.summary = i.title;
  if (i.description !== undefined) out.description = i.description;
  if (i.start !== undefined) out.start = i.allDay ? { date: i.start.slice(0, 10) } : { dateTime: i.start, timeZone: getZone() };
  if (i.end !== undefined) out.end = i.allDay ? { date: i.end.slice(0, 10) } : { dateTime: i.end, timeZone: getZone() };
  if (i.busy !== undefined) out.transparency = i.busy ? 'opaque' : 'transparent';
  if (i.recurrence) out.recurrence = i.recurrence;
  if (!partial || i.marginKind || i.marginRef) {
    out.extendedProperties = { private: { [MARK]: '1', marginKind: i.marginKind ?? 'block', ...(i.marginRef ? { marginRef: i.marginRef } : {}), ...(i.marginFixedId ? { marginFixedId: i.marginFixedId } : {}) } };
  }
  return out;
}

const eventInput = z.object({
  title: z.string().min(1), start: z.string(), end: z.string(), allDay: z.boolean().optional(), description: z.string().optional(),
  busy: z.boolean().optional(), recurrence: z.array(z.string()).optional(), marginKind: z.string().optional(), marginRef: z.string().optional(), marginFixedId: z.string().optional(),
});

export default defineModule({
  id: 'google',
  name: 'Google Calendar',
  description: 'Reads all your calendars; writes only to calendars Margin owns unless you confirm a specific change.',
  core: true,
  settings,
  migrations: [
    `CREATE TABLE gc_calendars (id TEXT PRIMARY KEY, summary TEXT NOT NULL, color TEXT, access_role TEXT, is_primary INTEGER NOT NULL DEFAULT 0, selected INTEGER NOT NULL DEFAULT 1, sync_token TEXT, raw TEXT);
     CREATE TABLE gc_events (calendar_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT, summary TEXT, start TEXT, end TEXT, start_ms INTEGER, end_ms INTEGER,
       all_day INTEGER NOT NULL DEFAULT 0, transparency TEXT, recurring_event_id TEXT, event_type TEXT, margin_kind TEXT, margin_ref TEXT, margin_fixed TEXT, raw TEXT,
       PRIMARY KEY (calendar_id, id));
     CREATE INDEX gc_events_time ON gc_events(start_ms, end_ms);
     CREATE INDEX gc_events_ref ON gc_events(margin_ref);
     CREATE TABLE app_calendars (kind TEXT NOT NULL, ref TEXT NOT NULL, calendar_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, ref));`,
  ],
  service: createGoogleService,
  widgets: [{ id: 'reconnect', slot: 'today.banner', order: -5 }],
  emits: ['google.synced', 'google.connected', 'google.connect_failed', 'google.reconnect_needed'],
  init(ctx) {
    const g = ctx.service<GoogleService>('google');
    const guard = (calendarId: string, p: any) => {
      if (g.isAppOwned(calendarId)) return;
      if (!p.confirmed) throw new Error('This calendar isn’t one Margin owns. Confirm this specific change first.');
      if (!g.status().canWriteOwned) throw new Error('Writing to your own calendars needs the extra Google permission (Settings → Google Calendar → Allow writes).');
    };
    const resolveCal = async (p: any): Promise<string> => {
      if (p.calendarId) return p.calendarId;
      if (p.appCalendar) return g.ensureAppCalendar(p.appCalendar.kind, p.appCalendar.ref, p.appCalendar.summary ?? g.settings().blocksCalendarName, p.appCalendar.color);
      return g.ensureAppCalendar('blocks', 'main', g.settings().blocksCalendarName);
    };
    ctx.changes.register('gcal.calendar.ensure', { label: 'Create a Margin calendar', apply: async (_c, p) => ({ calendarId: await g.ensureAppCalendar(p.kind, p.ref, p.summary, p.color) }), editable: ['summary'] });
    ctx.changes.register('gcal.event.create', {
      label: 'Add a calendar event', editable: ['title', 'start', 'end'],
      apply: async (_c, p) => {
        const cal = await resolveCal(p);
        guard(cal, p);
        const ev = await g.createEvent(cal, eventInput.parse(p));
        return { calendarId: cal, eventId: ev.id };
      },
    });
    ctx.changes.register('gcal.event.update', {
      label: 'Change a calendar event', editable: ['title', 'start', 'end'],
      apply: async (_c, p) => {
        guard(p.calendarId, p);
        const ev = g.event(p.calendarId, p.eventId);
        const raw: any = ev?.raw ?? {};
        if (!g.isAppOwned(p.calendarId) && raw.extendedProperties?.private?.[MARK] !== '1' && !p.confirmed) throw new Error('Margin didn’t create this event; confirm the change first.');
        const { calendarId, eventId, confirmed, ...rest } = p;
        return g.patchEvent(calendarId, eventId, rest);
      },
    });
    ctx.changes.register('gcal.event.delete', {
      label: 'Remove an event Margin created',
      apply: async (_c, p) => {
        const ev = g.event(p.calendarId, p.eventId);
        const raw: any = ev?.raw ?? {};
        if (raw.extendedProperties?.private?.[MARK] !== '1' && !g.isAppOwned(p.calendarId)) throw new Error('Margin only removes events it created.');
        return g.deleteEvent(p.calendarId, p.eventId);
      },
    });
  },
  jobs: [
    {
      id: 'sync',
      every: 1,
      async run(ctx) {
        const g = ctx.service<GoogleService>('google');
        const st = g.status();
        if (!st.connected || st.needsReconnect) return;
        const last = st.lastSyncAt;
        if (!last || now().diff(DateTime.fromISO(last), 'minutes').minutes >= g.settings().syncEveryMin) await g.sync().catch(() => {});
      },
    },
    {
      // calendarList incremental sync misses renames; tokens also age. Re-run a full sync nightly.
      id: 'full-resync',
      at: () => ['03:30'],
      async run(ctx) {
        ctx.db.exec('UPDATE gc_calendars SET sync_token = NULL');
        await ctx.service<GoogleService>('google').sync().catch(() => {});
      },
    },
  ],
  routes(r, ctx) {
    const g = () => ctx.service<GoogleService>('google');
    r.get('/status', (c) => c.json(g().status()));
    r.post('/client', async (c) => {
      const b = z.object({ clientId: z.string().min(10), clientSecret: z.string().min(6) }).parse(await c.req.json());
      g().setClient(b.clientId, b.clientSecret);
      return c.json(g().status());
    });
    r.post('/connect', async (c) => {
      const b = await c.req.json().catch(() => ({}));
      return c.json(await g().connect({ primaryWrites: !!b.primaryWrites }));
    });
    r.post('/use-mock', async (c) => { ctx.settings.set('google', { mode: 'mock' }); ctx.db.exec('DELETE FROM gc_events; DELETE FROM gc_calendars; DELETE FROM app_calendars;'); await g().sync(); return c.json(g().status()); });
    r.post('/disconnect', async (c) => { await g().disconnect(); return c.json(g().status()); });
    r.post('/sync', async (c) => { await g().sync(); return c.json(g().status()); });
    r.get('/calendars', (c) => c.json(g().calendars()));
    r.get('/events', (c) => {
      const start = c.req.query('start')!, end = c.req.query('end')!;
      const ids = c.req.query('calendars');
      return c.json(g().eventsBetween(start, end, ids ? { calendarIds: ids.split(',') } : {}));
    });
  },
  claude: {
    tools: [
      {
        name: 'list_events',
        description: 'Calendar events between two ISO datetimes across all visible calendars.',
        kind: 'read',
        input: z.object({ start: z.string(), end: z.string() }),
        run: (ctx, i) => ctx.service<GoogleService>('google').eventsBetween(i.start, i.end).map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendar: e.calendarName, busy: e.busy, kind: e.marginKind })),
      },
      {
        name: 'propose_time_blocks',
        description: 'Propose time blocks on the Margin Blocks calendar (created only after the person approves). Never after the hard stop.',
        kind: 'propose',
        input: z.object({ blocks: z.array(z.object({ title: z.string(), start: z.string(), end: z.string(), taskId: z.string().optional() })) }),
        run: (ctx, i) => {
          const day = ctx.service<any>('day');
          return i.blocks.map((b: any) => {
            const date = b.start.slice(0, 10);
            const stop = day.anchors(date).effectiveStop;
            if (DateTime.fromISO(b.end).toMillis() > stop.toMillis()) throw new Error(`Block “${b.title}” ends after the hard stop (${stop.toFormat('h:mm a')}).`);
            return { kind: 'gcal.event.create', title: `Block “${b.title}” ${DateTime.fromISO(b.start).setZone(getZone()).toFormat('EEE h:mm')}–${DateTime.fromISO(b.end).setZone(getZone()).toFormat('h:mm a')}`, payload: { title: b.title, start: b.start, end: b.end, marginKind: 'block', marginRef: b.taskId } };
          });
        },
      },
    ],
  },
});
