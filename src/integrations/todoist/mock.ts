/**
 * A faithful in-process Todoist API v1 for mock mode and tests. Implements the subset the app uses
 * with the real semantics that bite: incremental sync tokens, per-command sync_status, inverted
 * priority, recurrence dropped by due.string/due.date-only updates, item_close advancing recurring
 * tasks, the Free plan's 5-project cap and missing durations. State persists to a JSON file.
 */
import fs from 'node:fs';
import { DateTime } from 'luxon';
import type { TdItem, TdProject, TdSection, TdLabel, TdDue } from './client';

interface State {
  v: number;
  versions: Record<string, number>; // key `${type}:${id}` → version
  projects: TdProject[]; sections: TdSection[]; items: TdItem[]; labels: TdLabel[];
  notes: { id: string; item_id: string; content: string; posted_at: string }[];
  completed: (TdItem & { completed_at: string })[];
  user: { id: string; inbox_project_id: string; full_name: string; tz_info: { timezone: string } };
  plan: { max_projects: number; durations: boolean; comments: boolean; reminders: boolean };
  seen: string[]; // executed command uuids
}

const ZONE = 'America/New_York';
const id = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

export function createMockTodoist(opts: { file?: string; now?: () => DateTime; seed?: boolean } = {}) {
  const now = opts.now ?? (() => DateTime.now().setZone(ZONE));
  let state: State = load() ?? fresh();
  if (opts.seed !== false && state.items.length === 0 && state.v === 0) seed();

  function load(): State | null {
    if (!opts.file || !fs.existsSync(opts.file)) return null;
    try { return JSON.parse(fs.readFileSync(opts.file, 'utf8')); } catch { return null; }
  }
  function save() { if (opts.file) fs.writeFileSync(opts.file, JSON.stringify(state)); }
  function fresh(): State {
    const inbox: TdProject = { id: 'inbox' + id().slice(0, 6), name: 'Inbox', color: 'charcoal', parent_id: null, child_order: 0, inbox_project: true, is_archived: false, is_deleted: false, view_style: 'list' };
    return {
      v: 0, versions: {}, projects: [inbox], sections: [], items: [], labels: [], notes: [], completed: [], seen: [],
      user: { id: '55960289', inbox_project_id: inbox.id, full_name: 'Michael', tz_info: { timezone: ZONE } },
      plan: { max_projects: 5, durations: false, comments: true, reminders: false },
    };
  }
  function touch(type: string, oid: string) { state.versions[`${type}:${oid}`] = ++state.v; }

  function seed() {
    const p = (name: string, color: string) => { const pr: TdProject = { id: id(), name, color, parent_id: null, child_order: state.projects.length, is_archived: false, is_deleted: false, view_style: 'list' }; state.projects.push(pr); touch('project', pr.id); return pr; };
    const oneOff = p('One-off tasks', 'blue');
    p('Maybe Someday', 'grey');
    for (const name of ['next', 'waiting', 'homework']) { const l: TdLabel = { id: id(), name, color: 'charcoal', is_deleted: false }; state.labels.push(l); touch('label', l.id); }
    const d = (n: number) => now().plus({ days: n }).toISODate()!;
    const add = (content: string, extra: Partial<TdItem> = {}) => {
      const it: TdItem = { id: id(), project_id: oneOff.id, section_id: null, parent_id: null, content, description: '', priority: 1, labels: [], due: null, deadline: null, duration: null, checked: false, is_deleted: false, child_order: state.items.length, added_at: now().toUTC().toISO()!, updated_at: now().toUTC().toISO()! };
      Object.assign(it, extra);
      state.items.push(it); touch('item', it.id); return it;
    };
    const due = (date: string, string?: string, recurring = false): TdDue => ({ date, timezone: null, string: string ?? date, lang: 'en', is_recurring: recurring });
    add('AP Chem problem set 4.2', { labels: ['homework'], due: due(d(0)), priority: 3 });
    add('Read APUSH ch. 12 and outline', { labels: ['homework'], due: due(d(1)) });
    add('Physics lab report: momentum', { labels: ['homework'], due: due(d(2)), priority: 2 });
    add('Email Dr. Lim the bead-coupling results', { due: due(d(0)), priority: 4, labels: ['next'] });
    add('Draft RSI essay #2 opening paragraph', { due: due(d(1)), priority: 3 });
    add('Assign two new manuscripts to reviewers', { due: due(d(0)), labels: ['next'] });
    add('Reply to Red Cross about the November blood drive', { due: due(d(-1)) });
    add('Weekly Delphic owner check-in', { due: due(d(7 - (now().weekday % 7)), 'every sunday', true) });
    add('Update lab notebook', { due: due(d(0), 'every weekday', true) });
    add('Look into Blender donut tutorial', { project_id: state.projects[2].id });
    add('Waiting on: SHP attendance confirmation', { labels: ['waiting'] });
    save();
  }

  // ------------------------------------------------------------------ due parsing (tiny subset of Todoist's)
  function parseDate(text: string): { date: string; rest: string; recurring: boolean; string: string } | null {
    const t = text.toLowerCase();
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const time = t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\bat\s+(\d{1,2}):(\d{2})\b/);
    const withTime = (date: DateTime) => {
      if (!time) return date.toISODate()!;
      let h = Number(time[1]) % 12; if (time[3] === 'pm') h += 12; if (!time[3]) h = Number(time[1]);
      return date.set({ hour: h, minute: Number(time[2] ?? 0), second: 0 }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    };
    let m: RegExpMatchArray | null;
    const base = now().startOf('day');
    if ((m = t.match(/\bevery\s+(day|weekday|week|month|(\d+)\s+days|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/))) {
      let first = base;
      if (weekdays.includes(m[1])) { const wd = weekdays.indexOf(m[1]) + 1; first = base.plus({ days: (wd - base.weekday + 7) % 7 }); }
      if (m[1] === 'weekday' && base.weekday > 5) first = base.plus({ days: 8 - base.weekday });
      return { date: withTime(first), rest: text.replace(new RegExp(m[0], 'i'), ''), recurring: true, string: m[0] };
    }
    let date: DateTime | null = null; let matched = '';
    if ((m = t.match(/\btoday\b/))) { date = base; matched = m[0]; }
    else if ((m = t.match(/\btomorrow\b/))) { date = base.plus({ days: 1 }); matched = m[0]; }
    else if ((m = t.match(/\bnext week\b/))) { date = base.plus({ days: 8 - base.weekday }); matched = m[0]; }
    else if ((m = t.match(/\bin (\d+) days?\b/))) { date = base.plus({ days: Number(m[1]) }); matched = m[0]; }
    else if ((m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/))) { date = DateTime.fromISO(m[1], { zone: ZONE }); matched = m[0]; }
    else if ((m = t.match(/\b(?:next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/))) {
      const idx = weekdays.findIndex((w) => w.startsWith(m![1].slice(0, 3))) + 1;
      date = base.plus({ days: ((idx - base.weekday + 7) % 7) || 7 }); matched = m[0];
    }
    if (!date && time) { date = base; }
    if (!date) return null;
    let rest = matched ? text.replace(new RegExp(matched, 'i'), '') : text;
    if (time) rest = rest.replace(new RegExp(time[0], 'i'), '');
    return { date: withTime(date), rest, recurring: false, string: (matched + (time ? ` ${time[0]}` : '')).trim() };
  }

  function nextOccurrence(due: TdDue): string {
    const s = due.string.toLowerCase();
    const d = DateTime.fromISO(due.date, { zone: ZONE });
    const keep = (x: DateTime) => (due.date.includes('T') ? x.toFormat("yyyy-MM-dd'T'HH:mm:ss") : x.toISODate()!);
    let m: RegExpMatchArray | null;
    if ((m = s.match(/every (\d+) days/))) return keep(d.plus({ days: Number(m[1]) }));
    if (s.includes('every weekday')) { let x = d.plus({ days: 1 }); while (x.weekday > 5) x = x.plus({ days: 1 }); return keep(x); }
    if (s.includes('every day')) return keep(d.plus({ days: 1 }));
    if (s.includes('every month')) return keep(d.plus({ months: 1 }));
    return keep(d.plus({ weeks: 1 }));
  }

  function applyDue(item: TdItem, due: any) {
    if (due === null) { item.due = null; return; }
    if (due.date && due.string && due.is_recurring) {
      item.due = { date: due.date, string: due.string, is_recurring: true, timezone: due.timezone ?? null, lang: due.lang ?? 'en' };
    } else if (due.string && !due.date) {
      const p = parseDate(due.string);
      item.due = p ? { date: p.date, string: due.string, is_recurring: p.recurring, timezone: null, lang: 'en' } : item.due;
    } else if (due.date) {
      // Date object without a recurring string: recurrence is dropped, exactly like the real API.
      item.due = { date: due.date, string: due.date, is_recurring: false, timezone: due.timezone ?? null, lang: 'en' };
    }
  }

  // ------------------------------------------------------------------ commands
  function run(c: { type: string; uuid: string; temp_id?: string; args: any }, temp: Record<string, string>) {
    const a = c.args;
    const resolve = (x: any) => (typeof x === 'string' && temp[x] ? temp[x] : x);
    const findItem = () => { const it = state.items.find((i) => i.id === resolve(a.id) && !i.is_deleted); if (!it) throw err('Task not found', 'ITEM_NOT_FOUND', 404); return it; };
    switch (c.type) {
      case 'item_add': {
        if (!a.content) throw err('content is required', 'INVALID_ARGUMENT_VALUE');
        const it: TdItem = {
          id: id(), project_id: resolve(a.project_id) ?? state.user.inbox_project_id, section_id: resolve(a.section_id) ?? null,
          parent_id: resolve(a.parent_id) ?? null, content: a.content, description: a.description ?? '', priority: a.priority ?? 1,
          labels: a.labels ?? [], due: null, deadline: a.deadline ?? null, duration: state.plan.durations ? a.duration ?? null : null,
          checked: false, is_deleted: false, child_order: state.items.length, added_at: now().toUTC().toISO()!, updated_at: now().toUTC().toISO()!,
        };
        if (a.due) applyDue(it, a.due);
        state.items.push(it); touch('item', it.id);
        if (c.temp_id) temp[c.temp_id] = it.id;
        return;
      }
      case 'item_update': {
        const it = findItem();
        for (const k of ['content', 'description', 'priority', 'labels', 'deadline'] as const) if (k in a) (it as any)[k] = a[k];
        if ('duration' in a && state.plan.durations) it.duration = a.duration;
        if ('due' in a) applyDue(it, a.due);
        if ('project_id' in a || 'section_id' in a) throw err('Use item_move to move tasks', 'INVALID_ARGUMENT_VALUE');
        it.updated_at = now().toUTC().toISO()!; touch('item', it.id); return;
      }
      case 'item_move': {
        const it = findItem();
        const set = ['project_id', 'section_id', 'parent_id'].filter((k) => a[k] != null);
        if (set.length !== 1) throw err('Only one of parent_id, section_id or project_id must be set', 'INVALID_ARGUMENT_VALUE');
        if (a.project_id) { it.project_id = resolve(a.project_id); it.section_id = null; it.parent_id = null; }
        if (a.section_id) { const s = state.sections.find((x) => x.id === resolve(a.section_id)); if (!s) throw err('Section not found', 'NOT_FOUND', 404); it.section_id = s.id; it.project_id = s.project_id; it.parent_id = null; }
        if (a.parent_id) { const p = state.items.find((x) => x.id === resolve(a.parent_id)); if (!p) throw err('Parent not found', 'NOT_FOUND', 404); it.parent_id = p.id; it.project_id = p.project_id; it.section_id = p.section_id; }
        touch('item', it.id); return;
      }
      case 'item_close': {
        const it = findItem();
        state.completed.push({ ...structuredClone(it), completed_at: now().toUTC().toISO()! });
        if (it.due?.is_recurring) it.due = { ...it.due, date: nextOccurrence(it.due) };
        else { it.checked = true; it.completed_at = now().toUTC().toISO()!; }
        touch('item', it.id); return;
      }
      case 'item_complete': {
        const it = findItem();
        it.checked = true; it.completed_at = a.date_completed ?? now().toUTC().toISO()!;
        state.completed.push({ ...structuredClone(it), completed_at: it.completed_at! });
        touch('item', it.id); return;
      }
      case 'item_uncomplete': { const it = findItem(); it.checked = false; it.completed_at = null; touch('item', it.id); return; }
      case 'label_add': {
        if (state.labels.some((l) => l.name === a.name && !l.is_deleted)) throw err('Label already exists', 'LABEL_ALREADY_EXISTS');
        const l: TdLabel = { id: id(), name: a.name, color: a.color ?? 'charcoal', is_deleted: false };
        state.labels.push(l); touch('label', l.id); if (c.temp_id) temp[c.temp_id] = l.id; return;
      }
      case 'note_add': {
        if (!state.items.find((i) => i.id === resolve(a.item_id))) throw err('Task not found', 'ITEM_NOT_FOUND', 404);
        state.notes.push({ id: id(), item_id: resolve(a.item_id), content: a.content, posted_at: now().toUTC().toISO()! }); return;
      }
      case 'project_add': {
        const active = state.projects.filter((p) => !p.is_archived && !p.is_deleted).length;
        if (active >= state.plan.max_projects) throw err(`Maximum number of projects (${state.plan.max_projects}) reached on your plan`, 'MAX_PROJECTS_LIMIT_REACHED', 403);
        const p: TdProject = { id: id(), name: a.name, color: a.color ?? 'charcoal', parent_id: a.parent_id ?? null, child_order: state.projects.length, is_archived: false, is_deleted: false, view_style: a.view_style ?? 'list' };
        state.projects.push(p); touch('project', p.id); if (c.temp_id) temp[c.temp_id] = p.id; return;
      }
      case 'project_archive': { const p = state.projects.find((x) => x.id === resolve(a.id)); if (!p) throw err('Project not found', 'NOT_FOUND', 404); p.is_archived = true; touch('project', p.id); return; }
      case 'section_add': {
        const pid = resolve(a.project_id);
        if (state.sections.filter((s) => s.project_id === pid && !s.is_deleted).length >= 20) throw err('Maximum sections reached', 'MAX_SECTIONS_LIMIT_REACHED', 403);
        const s: TdSection = { id: id(), project_id: pid, name: a.name, section_order: state.sections.length, is_archived: false, is_deleted: false };
        state.sections.push(s); touch('section', s.id); if (c.temp_id) temp[c.temp_id] = s.id; return;
      }
      case 'item_delete': case 'project_delete':
        throw err('Margin never deletes (mock refuses so tests catch it)', 'FORBIDDEN', 403);
      default:
        throw err(`Unknown command ${c.type}`, 'INVALID_ARGUMENT_VALUE');
    }
  }
  function err(message: string, tag: string, http = 400) { return Object.assign(new Error(message), { tag, http }); }

  function changedSince(v: number) {
    const pick = <T extends { id: string }>(type: string, list: T[]) => list.filter((o) => (state.versions[`${type}:${o.id}`] ?? 0) > v);
    return {
      projects: pick('project', state.projects), sections: pick('section', state.sections),
      items: pick('item', state.items), labels: pick('label', state.labels),
    };
  }

  // ------------------------------------------------------------------ HTTP surface
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1/, '');
    const auth = String((init.headers as any)?.authorization ?? '');
    if (!auth.startsWith('Bearer ') || auth === 'Bearer bad-token') return json(401, { error: 'Unauthorized', error_code: 477, error_tag: 'UNAUTHORIZED', http_code: 401 });
    try {
      if (path === '/sync' && init.method === 'POST') {
        const form = new URLSearchParams(String(init.body ?? ''));
        if (form.has('commands')) {
          const cmds = JSON.parse(form.get('commands')!);
          const temp: Record<string, string> = {};
          const status: Record<string, unknown> = {};
          for (const c of cmds) {
            if (state.seen.includes(c.uuid)) { status[c.uuid] = 'ok'; continue; }
            try { run(c, temp); status[c.uuid] = 'ok'; state.seen.push(c.uuid); }
            catch (e: any) { status[c.uuid] = { error: e.message, error_code: 20, error_tag: e.tag ?? 'INVALID', http_code: e.http ?? 400 }; }
          }
          save();
          return json(200, { sync_token: `v${state.v}`, full_sync: false, sync_status: status, temp_id_mapping: temp });
        }
        const token = (form.get('sync_token') ?? '*').replace(/^"|"$/g, '');
        const full = token === '*';
        const since = full ? 0 : Number(String(token).replace(/^v/, ''));
        const changed = full
          ? { projects: state.projects, sections: state.sections, items: state.items.filter((i) => !i.checked && !i.is_deleted), labels: state.labels }
          : changedSince(since);
        return json(200, { sync_token: `v${state.v}`, full_sync: full, ...structuredClone(changed), user: state.user, user_plan_limits: { current: state.plan } });
      }
      if (path === '/tasks/quick' && init.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        let text: string = body.text ?? '';
        const labels: string[] = [];
        let project_id = state.user.inbox_project_id;
        let priority = 1;
        text = text.replace(/(^|\s)@([\w-]+)/g, (_, s, l) => { labels.push(l); return s; });
        text = text.replace(/(^|\s)#([\w-]+)/g, (m0, s, name) => {
          const p = state.projects.find((x) => x.name.replace(/\s+/g, '').toLowerCase() === name.toLowerCase());
          if (p) { project_id = p.id; return s; } return m0;
        });
        text = text.replace(/(^|\s)p([1-4])\b/i, (_, s, n) => { priority = 5 - Number(n); return s; });
        const parsed = parseDate(text);
        const content = (parsed ? parsed.rest : text).replace(/\s+/g, ' ').trim();
        const temp: Record<string, string> = {};
        run({ type: 'item_add', uuid: crypto.randomUUID(), temp_id: 'q', args: { content, project_id, labels, priority, due: parsed ? { string: parsed.string } : undefined } }, temp);
        save();
        return json(200, state.items.find((i) => i.id === temp.q));
      }
      if (path === '/tasks/completed/by_completion_date') {
        const since = u.searchParams.get('since')!, until = u.searchParams.get('until')!;
        return json(200, { items: state.completed.filter((c) => c.completed_at >= since && c.completed_at < until) });
      }
      return json(404, { error: 'Not found', error_tag: 'NOT_FOUND', http_code: 404 });
    } catch (e: any) {
      return json(500, { error: e.message });
    }
  };

  return {
    fetch: fetchImpl,
    /** Test helpers */
    state: () => state,
    reset: (seedIt = false) => { state = fresh(); if (seedIt) seed(); save(); },
    setPlan: (p: Partial<State['plan']>) => { state.plan = { ...state.plan, ...p }; save(); },
    notes: () => state.notes,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
