/**
 * In-process Google Calendar v3 stand-in for mock mode and tests. Implements calendarList/events
 * with syncTokens (incremental results include cancelled events, 410 on unknown tokens), singleEvents
 * expansion with DST-correct instances, calendars.insert, and scope rules: writes only to calendars
 * the app created unless calendar.events.owned was granted.
 */
import fs from 'node:fs';
import { DateTime } from 'luxon';
import type { GEvent, GCalendarListEntry } from './client';
import { SCOPES, BASE_SCOPES } from './oauth';

const ZONE = 'America/New_York';
interface Cal extends GCalendarListEntry { appCreated?: boolean }
interface Ev extends GEvent { _v: number; _master?: string }
interface State { v: number; calendars: Cal[]; events: Record<string, Ev[]>; masters: Record<string, Record<string, Ev>>; scopes: string[]; tokens: Record<string, number> }

const rid = () => Array.from({ length: 20 }, () => 'abcdefghijklmnopqrstuv0123456789'[Math.floor(Math.random() * 32)]).join('');

export function createMockGoogle(opts: { file?: string; now?: () => DateTime; seed?: boolean } = {}) {
  const now = opts.now ?? (() => DateTime.now().setZone(ZONE));
  let state: State = load() ?? fresh();
  if (opts.seed !== false && state.calendars.length === 0) seed();

  function load(): State | null {
    if (!opts.file || !fs.existsSync(opts.file)) return null;
    try { return JSON.parse(fs.readFileSync(opts.file, 'utf8')); } catch { return null; }
  }
  function save() { if (opts.file) fs.writeFileSync(opts.file, JSON.stringify(state)); }
  function fresh(): State { return { v: 0, calendars: [], events: {}, masters: {}, scopes: [...BASE_SCOPES], tokens: {} }; }

  function addCal(c: Cal) { state.calendars.push(c); state.events[c.id] = []; state.masters[c.id] = {}; return c; }
  function put(calId: string, e: Partial<GEvent> & { id?: string }, master?: string): Ev {
    const list = state.events[calId];
    const ev: Ev = { status: 'confirmed', transparency: 'opaque', eventType: 'default', ...e, id: e.id ?? rid(), _v: ++state.v, _master: master, updated: now().toUTC().toISO()!, htmlLink: `https://calendar.google.com/calendar/event?eid=${rid()}` };
    const i = list.findIndex((x) => x.id === ev.id);
    if (i >= 0) list[i] = ev; else list.push(ev);
    return ev;
  }

  /** Expand a weekly/daily RRULE into instances in the zone (so 6:45 stays 6:45 across DST). */
  function expand(calId: string, master: Ev) {
    const rule = (master.recurrence ?? []).find((r) => r.startsWith('RRULE:'));
    if (!rule) return;
    const parts = Object.fromEntries(rule.slice(6).split(';').map((p) => p.split('=')));
    const startDt = DateTime.fromISO(master.start!.dateTime ?? master.start!.date!, { zone: master.start!.timeZone ?? ZONE });
    const endDt = DateTime.fromISO(master.end!.dateTime ?? master.end!.date!, { zone: master.end!.timeZone ?? ZONE });
    const durMin = endDt.diff(startDt, 'minutes').minutes;
    const allDay = !!master.start!.date;
    const days = parts.BYDAY ? String(parts.BYDAY).split(',').map((d) => ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].indexOf(d) + 1) : [startDt.weekday];
    const until = parts.UNTIL ? DateTime.fromFormat(String(parts.UNTIL).slice(0, 8), 'yyyyMMdd', { zone: ZONE }).endOf('day') : now().plus({ days: 200 });
    const from = DateTime.max(startDt.startOf('day'), now().minus({ days: 45 }).startOf('day'));
    // Drop old instances of this master, then regenerate
    state.events[calId] = state.events[calId].filter((e) => e._master !== master.id);
    for (let d = from; d <= until; d = d.plus({ days: 1 })) {
      if (parts.FREQ === 'WEEKLY' && !days.includes(d.weekday)) continue;
      if (parts.FREQ !== 'WEEKLY' && parts.FREQ !== 'DAILY') continue;
      const s = d.set({ hour: startDt.hour, minute: startDt.minute });
      if (s < startDt.startOf('day')) continue;
      const e = s.plus({ minutes: durMin });
      const idSuffix = allDay ? s.toFormat('yyyyMMdd') : s.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
      put(calId, {
        ...strip(master), id: `${master.id}_${idSuffix}`, recurringEventId: master.id, recurrence: undefined,
        start: allDay ? { date: s.toISODate()! } : { dateTime: s.toISO()!, timeZone: ZONE },
        end: allDay ? { date: e.toISODate()! } : { dateTime: e.toISO()!, timeZone: ZONE },
        originalStartTime: allDay ? { date: s.toISODate()! } : { dateTime: s.toISO()!, timeZone: ZONE },
      }, master.id);
    }
  }
  function strip(e: Ev): GEvent { const { _v, _master, ...rest } = e; return rest; }

  function seed() {
    addCal({ id: 'michaelpeng199@gmail.com', summary: 'michaelpeng199@gmail.com', accessRole: 'owner', primary: true, selected: true, timeZone: ZONE, backgroundColor: '#039be5' });
    addCal({ id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays in United States', accessRole: 'reader', selected: true, timeZone: ZONE, backgroundColor: '#0b8043' });
    addCal({ id: 'hunter-feed@import.calendar.google.com', summary: 'Hunter College HS', accessRole: 'reader', selected: true, timeZone: ZONE, backgroundColor: '#8e24aa' });
    const primary = 'michaelpeng199@gmail.com';
    const recurring = (summary: string, byday: string, start: string, end: string, extra: Partial<GEvent> = {}) => {
      const first = now().startOf('week').minus({ weeks: 6 }).toISODate()!;
      const m: Ev = { id: rid(), summary, start: { dateTime: `${first}T${start}:00`, timeZone: ZONE }, end: { dateTime: `${first}T${end}:00`, timeZone: ZONE }, recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${byday}`], status: 'confirmed', _v: 0, ...extra };
      state.masters[primary][m.id] = m;
      expand(primary, m);
    };
    recurring('Badminton', 'TU', '06:00', '08:00');
    recurring('Red Cross', 'TH', '11:05', '11:55');
    recurring('Columbia SHP', 'SA', '09:30', '12:30', { location: 'Pupin Hall, Columbia', description: 'Science Honors Program' });
    const day = (n: number) => now().plus({ days: n }).toISODate()!;
    const one = (cal: string, summary: string, date: string, start?: string, end?: string, extra: Partial<GEvent> = {}) => put(cal, start
      ? { summary, start: { dateTime: DateTime.fromISO(`${date}T${start}`, { zone: ZONE }).toISO()!, timeZone: ZONE }, end: { dateTime: DateTime.fromISO(`${date}T${end}`, { zone: ZONE }).toISO()!, timeZone: ZONE }, ...extra }
      : { summary, start: { date }, end: { date: DateTime.fromISO(date).plus({ days: 1 }).toISODate()! }, transparency: 'transparent', ...extra });
    one(primary, 'Basketball tryouts', day(4));
    one(primary, 'Orthodontist', day(2), '16:30', '17:15');
    one(primary, 'RSI application due', day(19));
    one('en.usa#holiday@group.v.calendar.google.com', 'Election Day', '2026-11-03');
    one('en.usa#holiday@group.v.calendar.google.com', 'Veterans Day', '2026-11-11');
    one('en.usa#holiday@group.v.calendar.google.com', 'Thanksgiving Day', '2026-11-26');
    one('hunter-feed@import.calendar.google.com', 'Chemistry unit test', day(3), '10:15', '11:00', { transparency: 'transparent' });
    one('hunter-feed@import.calendar.google.com', 'Early dismissal', day(5));
    save();
  }

  function err(status: number, reason: string, message: string) {
    return new Response(JSON.stringify({ error: { code: status, message, errors: [{ reason, message }] } }), { status, headers: { 'content-type': 'application/json' } });
  }
  const ok = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  function canWrite(calId: string) {
    const c = state.calendars.find((x) => x.id === calId);
    if (!c) return 'notFound';
    if (c.appCreated && state.scopes.includes(SCOPES.appCreated)) return null;
    if (c.accessRole === 'owner' && state.scopes.includes(SCOPES.eventsOwned)) return null;
    return 'forbidden';
  }
  function issueToken() { const t = `st_${rid()}`; state.tokens[t] = state.v; return t; }

  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/calendar\/v3/, ''));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const auth = String((init.headers as any)?.authorization ?? '');
    if (auth !== 'Bearer mock-access') return err(401, 'authError', 'Invalid Credentials');
    let m: RegExpMatchArray | null;

    if (path === '/users/me/calendarList' && method === 'GET') {
      const st = u.searchParams.get('syncToken');
      if (st && !(st in state.tokens)) return err(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.');
      return ok({ items: state.calendars.map(({ appCreated, ...c }) => c), nextSyncToken: issueToken() });
    }
    if ((m = path.match(/^\/users\/me\/calendarList\/(.+)$/)) && method === 'PATCH') {
      const c = state.calendars.find((x) => x.id === m![1]);
      if (!c) return err(404, 'notFound', 'Not Found');
      if (!c.appCreated) return err(403, 'forbidden', 'Insufficient Permission');
      Object.assign(c, body); save(); return ok(c);
    }
    if (path === '/calendars' && method === 'POST') {
      if (!state.scopes.includes(SCOPES.appCreated)) return err(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.');
      const c = addCal({ id: `${rid()}@group.calendar.google.com`, summary: body.summary, description: body.description, timeZone: body.timeZone, accessRole: 'owner', selected: true, appCreated: true, backgroundColor: '#9e69af' });
      save(); return ok({ id: c.id, summary: c.summary, timeZone: c.timeZone });
    }
    if ((m = path.match(/^\/calendars\/([^/]+)\/events$/))) {
      const calId = m[1];
      if (!state.events[calId]) return err(404, 'notFound', 'Not Found');
      if (method === 'GET') {
        const st = u.searchParams.get('syncToken');
        if (st && u.searchParams.get('timeMin')) return err(400, 'invalid', 'syncToken cannot be combined with timeMin');
        if (st && !(st in state.tokens)) return err(410, 'fullSyncRequired', 'Sync token is no longer valid, a full sync is required.');
        let items: Ev[];
        if (st) items = state.events[calId].filter((e) => e._v > state.tokens[st]);
        else {
          const tmin = u.searchParams.get('timeMin');
          items = state.events[calId].filter((e) => e.status !== 'cancelled' && (!tmin || (e.end?.dateTime ?? e.end?.date ?? '') >= tmin.slice(0, (e.end?.date ? 10 : 25))));
        }
        return ok({ kind: 'calendar#events', items: items.map(strip), nextSyncToken: issueToken() });
      }
      if (method === 'POST') {
        const no = canWrite(calId);
        if (no) return err(403, 'forbidden', 'You need to have writer access to this calendar.');
        if (body.id && state.events[calId].some((e) => e.id === body.id)) return err(409, 'duplicate', 'The requested identifier already exists.');
        if (body.recurrence?.length) {
          const mst: Ev = { ...body, id: body.id ?? rid(), _v: 0 };
          state.masters[calId][mst.id] = mst;
          expand(calId, mst);
          save(); return ok(strip(mst));
        }
        const ev = put(calId, body); save(); return ok(strip(ev));
      }
    }
    if ((m = path.match(/^\/calendars\/([^/]+)\/events\/([^/]+)$/))) {
      const [calId, evId] = [m[1], m[2]];
      const no = canWrite(calId);
      if (no) return err(403, 'forbidden', 'You need to have writer access to this calendar.');
      const master = state.masters[calId]?.[evId];
      if (method === 'PATCH') {
        if (master) { Object.assign(master, body); expand(calId, master); save(); return ok(strip(master)); }
        const ev = state.events[calId].find((e) => e.id === evId);
        if (!ev) return err(404, 'notFound', 'Not Found');
        const merged = { ...ev, ...body, extendedProperties: body.extendedProperties ?? ev.extendedProperties };
        const out = put(calId, merged, ev._master); save(); return ok(strip(out));
      }
      if (method === 'DELETE') {
        if (master) {
          delete state.masters[calId][evId];
          for (const e of state.events[calId]) if (e._master === evId) { e.status = 'cancelled'; e._v = ++state.v; }
          save(); return ok(null, 204);
        }
        const ev = state.events[calId].find((e) => e.id === evId);
        if (!ev || ev.status === 'cancelled') return err(410, 'deleted', 'Resource has been deleted');
        ev.status = 'cancelled'; ev._v = ++state.v; save(); return ok(null, 204);
      }
    }
    return err(404, 'notFound', `No mock route for ${method} ${path}`);
  };

  return {
    fetch: fetchImpl,
    state: () => state,
    grant: (scopes: string[]) => { state.scopes = scopes; save(); },
    expireTokens: () => { state.tokens = {}; save(); },
    /** Simulate an edit made on the phone. */
    editFromPhone: (calId: string, evId: string, patch: Partial<GEvent>) => { const ev = state.events[calId].find((e) => e.id === evId)!; put(calId, { ...ev, ...patch }, ev._master); save(); },
  };
}
