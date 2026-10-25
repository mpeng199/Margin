/**
 * Todoist API v1 client (https://api.todoist.com/api/v1). REST v2 / Sync v9 return 410 since 2026.
 * Reads: incremental /sync. Writes: /sync commands (batched, idempotent by uuid).
 * See docs/research/todoist.md for every quirk this encodes.
 */
export const TODOIST_BASE = 'https://api.todoist.com/api/v1';

export interface TdDue { date: string; timezone: string | null; string: string; lang: string; is_recurring: boolean; datetime?: string }
export interface TdItem {
  id: string; project_id: string; section_id: string | null; parent_id: string | null;
  content: string; description: string; priority: number; labels: string[];
  due: TdDue | null; deadline: { date: string } | null; duration: { amount: number; unit: 'minute' | 'day' } | null;
  checked: boolean; is_deleted: boolean; child_order: number;
  added_at?: string; updated_at?: string; completed_at?: string | null;
}
export interface TdProject { id: string; name: string; color: string; parent_id: string | null; child_order: number; inbox_project?: boolean; is_archived: boolean; is_deleted: boolean; view_style?: string }
export interface TdSection { id: string; project_id: string; name: string; section_order: number; is_archived: boolean; is_deleted: boolean }
export interface TdLabel { id: string; name: string; color: string; is_deleted: boolean }
export interface SyncResponse {
  sync_token: string; full_sync: boolean;
  items?: TdItem[]; projects?: TdProject[]; sections?: TdSection[]; labels?: TdLabel[];
  user?: { id: string; inbox_project_id: string; tz_info?: { timezone: string }; full_name?: string };
  user_plan_limits?: { current: { max_projects: number; durations: boolean; reminders?: boolean; comments?: boolean } };
  temp_id_mapping?: Record<string, string>;
  sync_status?: Record<string, 'ok' | { error: string; error_code: number; error_tag: string; http_code: number }>;
}
export interface Command { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> }

export class TodoistError extends Error {
  constructor(message: string, public status: number, public tag?: string, public retryAfter?: number) { super(message); }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TodoistClient {
  constructor(private token: string, private fetchImpl: FetchLike = fetch, private base = TODOIST_BASE) {}

  private async call(path: string, init: RequestInit & { form?: Record<string, unknown>; json?: unknown } = {}, attempt = 0): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(init.form).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();
    } else if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await this.fetchImpl(`${this.base}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
    if (res.status === 429 && attempt < 3) {
      const retry = Number(res.headers.get('retry-after') ?? 2);
      await new Promise((r) => setTimeout(r, Math.min(retry, 30) * 1000));
      return this.call(path, init, attempt + 1);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = res.status === 401 ? 'Todoist rejected the API token. Paste a fresh one from Todoist → Settings → Integrations → Developer.' : json?.error ?? text ?? `HTTP ${res.status}`;
      throw new TodoistError(msg, res.status, json?.error_tag, json?.error_extra?.retry_after);
    }
    return json;
  }

  sync(syncToken = '*', resourceTypes = ['projects', 'sections', 'items', 'labels', 'user', 'user_plan_limits']): Promise<SyncResponse> {
    return this.call('/sync', { form: { sync_token: syncToken, resource_types: resourceTypes } });
  }

  /** Run commands (≤100 per call). Throws if any command failed, listing each failure. */
  async commands(cmds: Command[]): Promise<SyncResponse> {
    const out: SyncResponse = { sync_token: '', full_sync: false, temp_id_mapping: {}, sync_status: {} };
    for (let i = 0; i < cmds.length; i += 100) {
      const res: SyncResponse = await this.call('/sync', { form: { commands: cmds.slice(i, i + 100) } });
      Object.assign(out.temp_id_mapping!, res.temp_id_mapping ?? {});
      Object.assign(out.sync_status!, res.sync_status ?? {});
      out.sync_token = res.sync_token;
    }
    const failed = Object.entries(out.sync_status ?? {}).filter(([, v]) => v !== 'ok');
    if (failed.length) {
      const detail = failed.map(([uuid, v]) => `${cmds.find((c) => c.uuid === uuid)?.type ?? uuid}: ${(v as any).error}`).join('; ');
      throw new TodoistError(`Todoist refused: ${detail}`, 400, (failed[0][1] as any).error_tag);
    }
    return out;
  }

  /** Natural-language quick add, parsed by Todoist itself. */
  quickAdd(text: string): Promise<TdItem> {
    return this.call('/tasks/quick', { json: { text, meta: false } });
  }

  async completedSince(sinceISO: string, untilISO: string): Promise<TdItem[]> {
    const out: TdItem[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ since: sinceISO, until: untilISO, limit: '200', ...(cursor ? { cursor } : {}) });
      const res = await this.call(`/tasks/completed/by_completion_date?${q}`);
      out.push(...(res.items ?? []));
      cursor = res.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }
}

export const cmd = (type: string, args: Record<string, unknown>, tempId?: string): Command =>
  ({ type, uuid: crypto.randomUUID(), args, ...(tempId ? { temp_id: tempId } : {}) });

/**
 * Due object for moving a task to a new date. Recurring tasks keep string/is_recurring/timezone/lang
 * (the only path that preserves recurrence); a task with a time keeps its time-of-day.
 */
export function rescheduleDue(old: TdDue | null, newDate: string): Record<string, unknown> {
  const hasTimeNew = newDate.includes('T');
  let date = newDate;
  if (!hasTimeNew && old?.date?.includes('T')) date = `${newDate}${old.date.slice(10)}`; // keep time + Z suffix
  if (old?.is_recurring) {
    return { date, string: old.string, is_recurring: true, timezone: old.timezone, lang: old.lang ?? 'en' };
  }
  return { date };
}

/** Todoist priority 4 = UI p1. */
export const uiPriority = (apiPriority: number) => 5 - apiPriority;
export const apiPriority = (ui: number) => 5 - ui;
