/** Google Calendar v3 client: incremental sync with syncToken, app-calendar writes, backoff. */
import type { FetchLike } from '../todoist/client';

export const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

export interface GEventTime { dateTime?: string; date?: string; timeZone?: string }
export interface GEvent {
  id: string; status?: 'confirmed' | 'tentative' | 'cancelled'; summary?: string; description?: string; location?: string;
  start?: GEventTime; end?: GEventTime; transparency?: 'opaque' | 'transparent'; colorId?: string; htmlLink?: string;
  recurringEventId?: string; originalStartTime?: GEventTime; recurrence?: string[]; eventType?: string; updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}
export interface GCalendarListEntry {
  id: string; summary: string; summaryOverride?: string; description?: string; timeZone?: string; backgroundColor?: string; colorId?: string;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader'; primary?: boolean; selected?: boolean; hidden?: boolean; deleted?: boolean;
}

export class SyncTokenGone extends Error {}
export class GoogleError extends Error { constructor(message: string, public status: number, public reason?: string) { super(message); } }

export class GoogleCalendarClient {
  constructor(private token: () => Promise<string>, private fetchImpl: FetchLike = fetch, private base = GCAL_BASE) {}

  private async call(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}, attempt = 0): Promise<any> {
    const q = init.query ? '?' + new URLSearchParams(Object.entries(init.query).filter(([, v]) => v !== undefined) as [string, string][]) : '';
    const res = await this.fetchImpl(`${this.base}${path}${q}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${await this.token()}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 204) return null;
    const j: any = await res.json().catch(() => null);
    if (res.ok) return j;
    const reason = j?.error?.errors?.[0]?.reason;
    if (res.status === 410 && reason !== 'deleted') throw new SyncTokenGone('Sync token expired');
    if (res.status === 410 && reason === 'deleted') return null;
    const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason ?? ''));
    if (retryable && attempt < 5) {
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000 + Math.random() * 1000, 32_000)));
      return this.call(path, init, attempt + 1);
    }
    throw new GoogleError(j?.error?.message ?? `Google Calendar HTTP ${res.status}`, res.status, reason);
  }

  async calendarList(syncToken?: string): Promise<{ items: GCalendarListEntry[]; nextSyncToken?: string }> {
    const items: GCalendarListEntry[] = [];
    let pageToken: string | undefined;
    let next: string | undefined;
    do {
      const r = await this.call('/users/me/calendarList', { query: { maxResults: '250', pageToken, syncToken, showDeleted: syncToken ? undefined : 'false' } });
      items.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
      next = r.nextSyncToken ?? next;
    } while (pageToken);
    return { items, nextSyncToken: next };
  }

  /**
   * Full sync (no token): single events from `timeMin`. Incremental: syncToken only (timeMin is not allowed).
   * Throws SyncTokenGone on 410 so the caller wipes and re-syncs that calendar.
   */
  async events(calendarId: string, opts: { syncToken?: string; timeMin?: string }): Promise<{ items: GEvent[]; nextSyncToken?: string }> {
    const items: GEvent[] = [];
    let pageToken: string | undefined;
    let next: string | undefined;
    do {
      const r = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: { singleEvents: 'true', maxResults: '2500', pageToken, syncToken: opts.syncToken, timeMin: opts.syncToken ? undefined : opts.timeMin },
      });
      items.push(...(r.items ?? []));
      pageToken = r.nextPageToken;
      next = r.nextSyncToken ?? next;
    } while (pageToken);
    return { items, nextSyncToken: next };
  }

  insertCalendar(body: { summary: string; timeZone: string; description?: string }): Promise<{ id: string; summary: string }> {
    return this.call('/calendars', { method: 'POST', body });
  }
  patchCalendarListEntry(calendarId: string, body: { backgroundColor?: string; foregroundColor?: string; selected?: boolean }) {
    return this.call(`/users/me/calendarList/${encodeURIComponent(calendarId)}`, { method: 'PATCH', body, query: { colorRgbFormat: 'true' } });
  }
  insertEvent(calendarId: string, ev: Partial<GEvent>): Promise<GEvent> {
    return this.call(`/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: ev });
  }
  patchEvent(calendarId: string, eventId: string, patch: Partial<GEvent>): Promise<GEvent> {
    return this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: patch });
  }
  deleteEvent(calendarId: string, eventId: string): Promise<null> {
    return this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  }
}
