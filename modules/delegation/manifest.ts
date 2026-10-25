/**
 * delegation — SPEC 4.6. Per project: functions (owner, decision rights, due date, written
 * "good enough" criteria), a check-in cadence [weekly, 20 min], a waiting-on list, and check-in
 * notes. Plus a global script library for saying no. Claude can draft a reply; nothing is ever sent.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, today, addDays, daysBetween, type ISODate } from '../../src/core/time';

const settings = z.object({
  defaultCadence: z.enum(['weekly', 'biweekly', 'monthly']).default('weekly').describe('Check-in cadence for a new function.'),
  defaultCheckinMin: z.number().int().min(5).max(90).default(20).describe('Minutes for an owner check-in.'),
});
type Settings = z.infer<typeof settings>;

export type Cadence = 'weekly' | 'biweekly' | 'monthly';
export interface DelegatedFunction {
  id: string;
  projectId: string;
  name: string;
  owner: string | null;
  decisionRights: string;
  dueDate: ISODate | null;
  goodEnough: string;
  cadence: Cadence;
  checkinMin: number;
  lastCheckin: ISODate | null;
  nextCheckin: ISODate;
  order: number;
  createdAt: string;
}
export interface WaitingItem {
  id: string;
  projectId: string;
  functionId: string | null;
  what: string;
  who: string;
  since: ISODate;
  due: ISODate | null;
  doneAt: string | null;
}
export interface CheckinNote { id: string; functionId: string; projectId: string; date: ISODate; note: string; createdAt: string }
export interface Script { id: string; title: string; body: string; order: number; builtin: boolean }
export interface DueCheckin extends DelegatedFunction { projectName: string | null; overdueDays: number }

export const SEED_SCRIPTS = [
  { title: 'At capacity', body: 'I’m at capacity through January. I can do X in February, or I can point you to Y.' },
  { title: 'Only if I drop something', body: 'I can do this if I drop Z. Which matters more to you?' },
];

/** Next check-in = last one (or the day the function was created) plus the cadence. Date math only, so DST can't move it. */
export function nextCheckinDate(base: ISODate, cadence: Cadence): ISODate {
  if (cadence === 'weekly') return addDays(base, 7);
  if (cadence === 'biweekly') return addDays(base, 14);
  return DateTime.fromISO(base, { zone: 'UTC' }).plus({ months: 1 }).toISODate()!;
}

const slugSafe = (s: string) => s.trim();

export function createDelegationService(ctx: Ctx) {
  const st = () => ctx.settings.get<Settings>('delegation');
  const projects = () => ctx.maybe<{ get(id: string): { id: string; name: string; status: string; archived: boolean } | null }>('projects');

  const toFn = (r: any): DelegatedFunction => {
    const created = String(r.created_at).slice(0, 10);
    const cadence = r.cadence as Cadence;
    return {
      id: r.id, projectId: r.project_id, name: r.name, owner: r.owner, decisionRights: r.decision_rights, dueDate: r.due_date,
      goodEnough: r.good_enough, cadence, checkinMin: r.checkin_min, lastCheckin: r.last_checkin,
      nextCheckin: nextCheckinDate(r.last_checkin ?? r.created_date ?? created, cadence), order: r.ord, createdAt: r.created_at,
    };
  };
  const toWaiting = (r: any): WaitingItem => ({
    id: r.id, projectId: r.project_id, functionId: r.function_id, what: r.what, who: r.who, since: r.since, due: r.due, doneAt: r.done_at,
  });

  const svc = {
    settings: st,

    // ---- contract
    functions(projectId?: string): DelegatedFunction[] {
      const rows = projectId
        ? ctx.db.all('SELECT * FROM deleg_functions WHERE project_id = ? ORDER BY ord, created_at', projectId)
        : ctx.db.all('SELECT * FROM deleg_functions ORDER BY project_id, ord, created_at');
      return rows.map(toFn);
    },
    fn(id: string): DelegatedFunction | null {
      const r = ctx.db.get('SELECT * FROM deleg_functions WHERE id = ?', id);
      return r ? toFn(r) : null;
    },
    /** Functions whose owner check-in is due on or before `date`. Unowned functions have nobody to check in with. Paused and dropped projects are skipped. */
    dueCheckins(date: ISODate): DueCheckin[] {
      const out: DueCheckin[] = [];
      for (const f of svc.functions()) {
        if (!f.owner) continue;
        const p = projects()?.get(f.projectId);
        if (p && (p.archived || p.status === 'pause' || p.status === 'drop')) continue;
        if (f.nextCheckin > date) continue;
        out.push({ ...f, projectName: p?.name ?? null, overdueDays: Math.max(0, daysBetween(f.nextCheckin, date)) });
      }
      return out.sort((a, b) => b.overdueDays - a.overdueDays || a.nextCheckin.localeCompare(b.nextCheckin));
    },
    waiting(projectId?: string, opts: { includeDone?: boolean } = {}): WaitingItem[] {
      const where = [opts.includeDone ? '1=1' : 'done_at IS NULL'];
      const params: any[] = [];
      if (projectId) { where.push('project_id = ?'); params.push(projectId); }
      return ctx.db.all(`SELECT * FROM deleg_waiting WHERE ${where.join(' AND ')} ORDER BY done_at IS NOT NULL, due IS NULL, due, since`, ...params).map(toWaiting);
    },
    logCheckin(functionId: string, note: string): CheckinNote {
      const f = svc.fn(functionId);
      if (!f) throw Object.assign(new Error('That function no longer exists.'), { status: 404 });
      const row: CheckinNote = { id: uid(), functionId, projectId: f.projectId, date: today(), note: note.trim(), createdAt: now().toISO()! };
      ctx.db.tx(() => {
        ctx.db.run('INSERT INTO deleg_checkins (id, function_id, project_id, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', row.id, functionId, f.projectId, row.date, row.note, row.createdAt);
        ctx.db.run('UPDATE deleg_functions SET last_checkin = ? WHERE id = ?', row.date, functionId);
      });
      ctx.bus.emit('delegation.checkin_logged', { functionId, projectId: f.projectId, date: row.date });
      return row;
    },

    // ---- functions
    addFunction(input: { projectId: string; name: string; owner?: string | null; decisionRights?: string; dueDate?: ISODate | null; goodEnough?: string; cadence?: Cadence; checkinMin?: number }): DelegatedFunction {
      const name = input.name.trim();
      if (!name) throw Object.assign(new Error('A function needs a name.'), { status: 400 });
      const id = uid();
      const ord = (ctx.db.get<{ n: number }>('SELECT COALESCE(MAX(ord), -1) + 1 n FROM deleg_functions WHERE project_id = ?', input.projectId)!).n;
      ctx.db.run(`INSERT INTO deleg_functions (id, project_id, name, owner, decision_rights, due_date, good_enough, cadence, checkin_min, ord, created_at, created_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.projectId, name, input.owner?.trim() || null, input.decisionRights ?? '', input.dueDate ?? null, input.goodEnough ?? '',
        input.cadence ?? st().defaultCadence, input.checkinMin ?? st().defaultCheckinMin, ord, now().toISO(), today());
      ctx.bus.emit('delegation.function_changed', { id, projectId: input.projectId });
      return svc.fn(id)!;
    },
    updateFunction(id: string, patch: Partial<Pick<DelegatedFunction, 'name' | 'owner' | 'decisionRights' | 'dueDate' | 'goodEnough' | 'cadence' | 'checkinMin'>>): DelegatedFunction {
      const cur = svc.fn(id);
      if (!cur) throw Object.assign(new Error('That function no longer exists.'), { status: 404 });
      const m = { ...cur, ...patch };
      ctx.db.run('UPDATE deleg_functions SET name = ?, owner = ?, decision_rights = ?, due_date = ?, good_enough = ?, cadence = ?, checkin_min = ? WHERE id = ?',
        m.name.trim() || cur.name, m.owner?.trim() || null, m.decisionRights, m.dueDate ?? null, m.goodEnough, m.cadence, m.checkinMin, id);
      ctx.bus.emit('delegation.function_changed', { id, projectId: cur.projectId });
      return svc.fn(id)!;
    },
    /** Local data only; check-in notes go with the function. */
    removeFunction(id: string) {
      const f = svc.fn(id);
      if (!f) return;
      ctx.db.tx(() => {
        ctx.db.run('DELETE FROM deleg_checkins WHERE function_id = ?', id);
        ctx.db.run('UPDATE deleg_waiting SET function_id = NULL WHERE function_id = ?', id);
        ctx.db.run('DELETE FROM deleg_functions WHERE id = ?', id);
      });
      ctx.bus.emit('delegation.function_changed', { id, projectId: f.projectId });
    },
    checkins(q: { functionId?: string; projectId?: string; limit?: number }): CheckinNote[] {
      const where: string[] = ['1=1'];
      const params: any[] = [];
      if (q.functionId) { where.push('function_id = ?'); params.push(q.functionId); }
      if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
      return ctx.db.all(`SELECT * FROM deleg_checkins WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ?`, ...params, q.limit ?? 50)
        .map((r) => ({ id: r.id, functionId: r.function_id, projectId: r.project_id, date: r.date, note: r.note, createdAt: r.created_at }));
    },

    // ---- waiting-on
    addWaiting(input: { projectId: string; functionId?: string | null; what: string; who: string; since?: ISODate; due?: ISODate | null }): WaitingItem {
      if (!input.what.trim()) throw Object.assign(new Error('Say what you are waiting on.'), { status: 400 });
      const id = uid();
      ctx.db.run('INSERT INTO deleg_waiting (id, project_id, function_id, what, who, since, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, input.projectId, input.functionId ?? null, input.what.trim(), input.who.trim(), input.since ?? today(), input.due ?? null, now().toISO());
      ctx.bus.emit('delegation.waiting_changed', { id, projectId: input.projectId });
      return toWaiting(ctx.db.get('SELECT * FROM deleg_waiting WHERE id = ?', id));
    },
    updateWaiting(id: string, patch: Partial<Pick<WaitingItem, 'what' | 'who' | 'due' | 'functionId'>> & { done?: boolean }): WaitingItem {
      const cur = ctx.db.get('SELECT * FROM deleg_waiting WHERE id = ?', id);
      if (!cur) throw Object.assign(new Error('That item no longer exists.'), { status: 404 });
      const doneAt = patch.done === undefined ? cur.done_at : patch.done ? now().toISO() : null;
      ctx.db.run('UPDATE deleg_waiting SET what = ?, who = ?, due = ?, function_id = ?, done_at = ? WHERE id = ?',
        patch.what ?? cur.what, patch.who ?? cur.who, patch.due === undefined ? cur.due : patch.due, patch.functionId === undefined ? cur.function_id : patch.functionId, doneAt, id);
      ctx.bus.emit('delegation.waiting_changed', { id, projectId: cur.project_id });
      return toWaiting(ctx.db.get('SELECT * FROM deleg_waiting WHERE id = ?', id));
    },
    removeWaiting(id: string) { ctx.db.run('DELETE FROM deleg_waiting WHERE id = ?', id); ctx.bus.emit('delegation.waiting_changed', { id }); },

    // ---- script library (global)
    scripts(): Script[] {
      return ctx.db.all('SELECT * FROM deleg_scripts ORDER BY ord, created_at').map((r) => ({ id: r.id, title: r.title, body: r.body, order: r.ord, builtin: !!r.builtin }));
    },
    addScript(title: string, body: string): Script {
      if (!body.trim()) throw Object.assign(new Error('A script needs some text.'), { status: 400 });
      const id = uid();
      const ord = ctx.db.get<{ n: number }>('SELECT COALESCE(MAX(ord), -1) + 1 n FROM deleg_scripts')!.n;
      ctx.db.run('INSERT INTO deleg_scripts (id, title, body, ord, builtin, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, slugSafe(title) || 'Untitled', body.trim(), ord, now().toISO());
      ctx.bus.emit('delegation.scripts_changed', { id });
      return svc.scripts().find((s) => s.id === id)!;
    },
    updateScript(id: string, patch: { title?: string; body?: string }): Script {
      const cur = svc.scripts().find((s) => s.id === id);
      if (!cur) throw Object.assign(new Error('That script no longer exists.'), { status: 404 });
      ctx.db.run('UPDATE deleg_scripts SET title = ?, body = ? WHERE id = ?', patch.title?.trim() || cur.title, patch.body ?? cur.body, id);
      ctx.bus.emit('delegation.scripts_changed', { id });
      return svc.scripts().find((s) => s.id === id)!;
    },
    removeScript(id: string) { ctx.db.run('DELETE FROM deleg_scripts WHERE id = ?', id); ctx.bus.emit('delegation.scripts_changed', { id }); },

    /** Draft only. Never sends. Throws 409 when AI is off. */
    async draft(input: { situation: string; scriptId?: string; tone?: string }): Promise<{ text: string }> {
      const ai = ctx.maybe<{ enabled(): boolean; run(f: string, i: any): Promise<{ text: string }> }>('ai');
      if (!ai?.enabled()) throw Object.assign(new Error('Claude is turned off. Copy a script instead, or turn Claude on in Settings.'), { status: 409 });
      const script = input.scriptId ? svc.scripts().find((s) => s.id === input.scriptId) : null;
      const out = await ai.run('draft_message', {
        kind: 'say_no', situation: input.situation, base: script?.body ?? null, tone: input.tone ?? 'direct, kind, specific. No apology spiral.',
        note: 'Write the message only. It will be copied, never sent automatically.',
      });
      return { text: out.text };
    },
  };
  return svc;
}
export type DelegationService = ReturnType<typeof createDelegationService>;

const cadenceSchema = z.enum(['weekly', 'biweekly', 'monthly']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default defineModule({
  id: 'delegation',
  name: 'Delegation',
  description: 'Owners, decision rights, check-ins and a waiting-on list for each project, plus scripts for saying no.',
  settings,
  migrations: [
    `CREATE TABLE deleg_functions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT, decision_rights TEXT NOT NULL DEFAULT '', due_date TEXT,
       good_enough TEXT NOT NULL DEFAULT '', cadence TEXT NOT NULL DEFAULT 'weekly', checkin_min INTEGER NOT NULL DEFAULT 20, last_checkin TEXT, ord INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, created_date TEXT);
     CREATE INDEX deleg_functions_project ON deleg_functions(project_id);
     CREATE TABLE deleg_waiting (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, function_id TEXT, what TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', since TEXT NOT NULL, due TEXT, done_at TEXT, created_at TEXT NOT NULL);
     CREATE INDEX deleg_waiting_project ON deleg_waiting(project_id);
     CREATE TABLE deleg_checkins (id TEXT PRIMARY KEY, function_id TEXT NOT NULL, project_id TEXT NOT NULL, date TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
     CREATE INDEX deleg_checkins_fn ON deleg_checkins(function_id, date);
     CREATE TABLE deleg_scripts (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`,
  ],
  service: createDelegationService,
  nav: [{ id: 'scripts', label: 'Say-No Scripts', icon: 'MessageSquareText', path: '/scripts', section: 'secondary', order: 30 }],
  emits: ['delegation.function_changed', 'delegation.waiting_changed', 'delegation.checkin_logged', 'delegation.scripts_changed'],
  init(ctx) {
    // Seed the script library once; a script you delete stays deleted.
    if (kvGet(ctx.db, 'delegation.seeded', false)) return;
    SEED_SCRIPTS.forEach((s, i) => ctx.db.run('INSERT INTO deleg_scripts (id, title, body, ord, builtin, created_at) VALUES (?, ?, ?, ?, 1, ?)', uid(), s.title, s.body, i, now().toISO()));
    kvSet(ctx.db, 'delegation.seeded', true);
  },
  routes(r, ctx) {
    const d = () => ctx.service<DelegationService>('delegation');
    r.get('/functions', (c) => c.json(d().functions(c.req.query('projectId') ?? undefined)));
    r.post('/functions', async (c) => {
      const b = z.object({
        projectId: z.string().min(1), name: z.string().min(1), owner: z.string().nullable().optional(), decisionRights: z.string().optional(),
        dueDate: date.nullable().optional(), goodEnough: z.string().optional(), cadence: cadenceSchema.optional(), checkinMin: z.number().int().min(5).max(120).optional(),
      }).parse(await c.req.json());
      return c.json(d().addFunction(b));
    });
    r.patch('/functions/:id', async (c) => {
      const b = z.object({
        name: z.string().optional(), owner: z.string().nullable().optional(), decisionRights: z.string().optional(), dueDate: date.nullable().optional(),
        goodEnough: z.string().optional(), cadence: cadenceSchema.optional(), checkinMin: z.number().int().min(5).max(120).optional(),
      }).parse(await c.req.json());
      return c.json(d().updateFunction(c.req.param('id'), b));
    });
    r.delete('/functions/:id', (c) => { d().removeFunction(c.req.param('id')); return c.json({ ok: true }); });
    r.get('/due', (c) => c.json(d().dueCheckins(c.req.query('date') ?? today())));
    r.get('/checkins', (c) => c.json(d().checkins({ functionId: c.req.query('functionId') ?? undefined, projectId: c.req.query('projectId') ?? undefined })));
    r.post('/functions/:id/checkins', async (c) => {
      const { note } = z.object({ note: z.string().default('') }).parse(await c.req.json());
      return c.json(d().logCheckin(c.req.param('id'), note));
    });
    r.get('/waiting', (c) => c.json(d().waiting(c.req.query('projectId') ?? undefined, { includeDone: c.req.query('done') === '1' })));
    r.post('/waiting', async (c) => {
      const b = z.object({ projectId: z.string().min(1), functionId: z.string().nullable().optional(), what: z.string().min(1), who: z.string().default(''), since: date.optional(), due: date.nullable().optional() }).parse(await c.req.json());
      return c.json(d().addWaiting(b));
    });
    r.patch('/waiting/:id', async (c) => {
      const b = z.object({ what: z.string().optional(), who: z.string().optional(), due: date.nullable().optional(), functionId: z.string().nullable().optional(), done: z.boolean().optional() }).parse(await c.req.json());
      return c.json(d().updateWaiting(c.req.param('id'), b));
    });
    r.delete('/waiting/:id', (c) => { d().removeWaiting(c.req.param('id')); return c.json({ ok: true }); });
    r.get('/scripts', (c) => c.json(d().scripts()));
    r.post('/scripts', async (c) => {
      const b = z.object({ title: z.string().default(''), body: z.string().min(1) }).parse(await c.req.json());
      return c.json(d().addScript(b.title, b.body));
    });
    r.patch('/scripts/:id', async (c) => {
      const b = z.object({ title: z.string().optional(), body: z.string().optional() }).parse(await c.req.json());
      return c.json(d().updateScript(c.req.param('id'), b));
    });
    r.delete('/scripts/:id', (c) => { d().removeScript(c.req.param('id')); return c.json({ ok: true }); });
    r.get('/draft/available', (c) => c.json({ enabled: !!ctx.maybe<{ enabled(): boolean }>('ai')?.enabled() }));
    r.post('/draft', async (c) => {
      const b = z.object({ situation: z.string().min(1), scriptId: z.string().optional(), tone: z.string().optional() }).parse(await c.req.json());
      return c.json(await d().draft(b));
    });
  },
  rules: {
    conditions: [{
      id: 'delegation.checkin_overdue',
      label: 'An owner check-in is overdue',
      description: 'At least one delegated function is past its check-in date.',
      params: z.object({}),
      evaluate: (ctx) => {
        const overdue = ctx.service<DelegationService>('delegation').dueCheckins(today()).filter((f) => f.overdueDays > 0);
        if (!overdue.length) return { met: false };
        const top = overdue[0];
        const more = overdue.length > 1 ? ` and ${overdue.length - 1} more` : '';
        return {
          met: true, subject: top.projectId,
          detail: `${top.projectName ? `${top.projectName}: ` : ''}${top.name} check-in with ${top.owner} is ${top.overdueDays} day${top.overdueDays === 1 ? '' : 's'} overdue${more}.`,
        };
      },
    }],
  },
  claude: {
    tools: [{
      name: 'list_delegation',
      description: 'Delegated functions (owner, decision rights, next check-in) and open waiting-on items, optionally for one project.',
      kind: 'read',
      input: z.object({ projectId: z.string().optional() }),
      run: (ctx, i) => {
        const dd = ctx.service<DelegationService>('delegation');
        return { functions: dd.functions(i.projectId), due: dd.dueCheckins(today()), waiting: dd.waiting(i.projectId) };
      },
    }],
  },
});
