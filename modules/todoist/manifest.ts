/**
 * todoist — source of truth for tasks. Mirrors projects/sections/tasks/labels into SQLite via
 * incremental sync, keeps app-only task metadata (estimate, must-do, carry count, next action,
 * owner), and writes back through direct actions (single checks) or change-set appliers (bulk).
 * Never deletes: there is no code path that sends item_delete or project_delete.
 */
import path from 'node:path';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { j } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, getZone, today, type ISODate } from '../../src/core/time';
import { TodoistClient, cmd, rescheduleDue, uiPriority, apiPriority, type TdItem, type SyncResponse, type Command } from '../../src/integrations/todoist/client';
import { createMockTodoist } from '../../src/integrations/todoist/mock';

const settings = z.object({
  mode: z.enum(['mock', 'live']).default('mock').describe('Live uses your Todoist account; mock uses a local stand-in.'),
  syncEveryMin: z.number().int().min(1).max(60).default(5).describe('Background sync interval.'),
  mustDoLabel: z.string().default('must-do').describe('Label mirrored onto must-do tasks so they show in Todoist too.'),
  homeworkLabel: z.string().default('homework').describe('Tasks with this label go to the homework lane.'),
  dropMode: z.enum(['complete', 'label']).default('complete').describe('“Drop” = complete with a note, or tag with the drop label. Never deletes.'),
  dropLabel: z.string().default('dropped'),
  pausedLabel: z.string().default('paused').describe('Applied to tasks of paused projects when you choose to mirror pauses into Todoist.'),
});
type Settings = z.infer<typeof settings>;

export interface TaskMeta {
  estimateMin: number | null;
  mustDoDate: ISODate | null;
  optional: boolean;
  homework: boolean | null;
  carryCount: number;
  lastCarryDate: ISODate | null;
  nextAction: string | null;
  owner: string | null;
}
export interface Task {
  id: string;
  content: string;
  description: string;
  projectId: string;
  projectName: string;
  sectionId: string | null;
  sectionName: string | null;
  parentId: string | null;
  priority: number; // UI: 1 = p1 (urgent) … 4 = none
  labels: string[];
  due: { date: ISODate; time: string | null; recurring: boolean; string: string } | null;
  deadline: ISODate | null;
  durationMin: number | null;
  estimateMin: number | null;
  checked: boolean;
  completedAt: string | null;
  meta: TaskMeta;
  url: string;
}

const EMPTY_META: TaskMeta = { estimateMin: null, mustDoDate: null, optional: false, homework: null, carryCount: 0, lastCarryDate: null, nextAction: null, owner: null };

/** Local date + time of a Todoist due.date (floating local, or UTC with Z). */
export function parseDue(d: TdItem['due']): Task['due'] {
  if (!d?.date) return null;
  if (d.date.length === 10) return { date: d.date, time: null, recurring: d.is_recurring, string: d.string };
  const dt = d.date.endsWith('Z') ? DateTime.fromISO(d.date, { zone: 'utc' }).setZone(getZone()) : DateTime.fromISO(d.date, { zone: getZone() });
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm'), recurring: d.is_recurring, string: d.string };
}

export function createTodoistService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('todoist');
  let mock: ReturnType<typeof createMockTodoist> | null = null;
  const getMock = () => (mock ??= createMockTodoist({ file: path.join(ctx.dataDir, 'mock-todoist.json'), now: () => now() }));
  let syncing: Promise<unknown> | null = null;

  const client = (): TodoistClient => {
    if (s().mode === 'mock') return new TodoistClient('mock-token', getMock().fetch);
    const token = ctx.keychain.get('todoist.token');
    if (!token) throw Object.assign(new Error('Todoist isn’t connected. Paste your API token in Settings → Todoist.'), { status: 409 });
    return new TodoistClient(token);
  };

  function applySync(res: SyncResponse) {
    ctx.db.tx(() => {
      if (res.full_sync) {
        // Full sync is authoritative: mark everything stale, then upsert what arrived.
        ctx.db.exec('DELETE FROM td_items WHERE checked = 0; DELETE FROM td_projects; DELETE FROM td_sections; DELETE FROM td_labels;');
      }
      for (const p of res.projects ?? []) {
        if (p.is_deleted) { ctx.db.run('DELETE FROM td_projects WHERE id = ?', p.id); continue; }
        ctx.db.run(`INSERT INTO td_projects (id, name, color, parent_id, child_order, inbox, archived, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, parent_id=excluded.parent_id, child_order=excluded.child_order, inbox=excluded.inbox, archived=excluded.archived, raw=excluded.raw`,
          p.id, p.name, p.color, p.parent_id, p.child_order, !!p.inbox_project, !!p.is_archived, JSON.stringify(p));
      }
      for (const sec of res.sections ?? []) {
        if (sec.is_deleted || sec.is_archived) { ctx.db.run('DELETE FROM td_sections WHERE id = ?', sec.id); continue; }
        ctx.db.run(`INSERT INTO td_sections (id, project_id, name, section_order) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, name=excluded.name, section_order=excluded.section_order`, sec.id, sec.project_id, sec.name, sec.section_order);
      }
      for (const l of res.labels ?? []) {
        if (l.is_deleted) { ctx.db.run('DELETE FROM td_labels WHERE id = ?', l.id); continue; }
        ctx.db.run(`INSERT INTO td_labels (id, name, color) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color`, l.id, l.name, l.color);
      }
      for (const it of res.items ?? []) {
        if (it.is_deleted) { ctx.db.run('DELETE FROM td_items WHERE id = ?', it.id); continue; }
        const due = parseDue(it.due);
        const prev = ctx.db.get<{ checked: number }>('SELECT checked FROM td_items WHERE id = ?', it.id);
        ctx.db.run(`INSERT INTO td_items (id, project_id, section_id, parent_id, content, description, priority, labels, due_date, due_time, due, deadline, duration_min, checked, completed_at, child_order, updated_at, raw)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, section_id=excluded.section_id, parent_id=excluded.parent_id, content=excluded.content,
            description=excluded.description, priority=excluded.priority, labels=excluded.labels, due_date=excluded.due_date, due_time=excluded.due_time, due=excluded.due,
            deadline=excluded.deadline, duration_min=excluded.duration_min, checked=excluded.checked, completed_at=excluded.completed_at, child_order=excluded.child_order,
            updated_at=excluded.updated_at, raw=excluded.raw`,
          it.id, it.project_id, it.section_id, it.parent_id, it.content, it.description ?? '', it.priority, JSON.stringify(it.labels ?? []),
          due?.date ?? null, due?.time ?? null, it.due ? JSON.stringify(it.due) : null, it.deadline?.date ?? null,
          it.duration ? (it.duration.unit === 'day' ? it.duration.amount * 1440 : it.duration.amount) : null,
          !!it.checked, it.completed_at ?? null, it.child_order ?? 0, it.updated_at ?? null, JSON.stringify(it));
        if (it.checked && prev && !prev.checked) logCompletion(it.id, it.content, it.project_id, 'todoist');
      }
      if (res.user) kvSet(ctx.db, 'todoist.user', { id: res.user.id, inboxProjectId: res.user.inbox_project_id, name: res.user.full_name ?? null });
      if (res.user_plan_limits) kvSet(ctx.db, 'todoist.plan', res.user_plan_limits.current);
      kvSet(ctx.db, 'todoist.syncToken', res.sync_token);
    });
  }

  function logCompletion(taskId: string, content: string, projectId: string, source: string) {
    const recent = ctx.db.get('SELECT 1 FROM td_completions WHERE task_id = ? AND completed_at > ?', taskId, now().minus({ minutes: 2 }).toISO());
    if (recent) return;
    ctx.db.run('INSERT INTO td_completions (task_id, content, project_id, completed_at, date, source) VALUES (?, ?, ?, ?, ?, ?)',
      taskId, content, projectId, now().toISO(), today(), source);
    ctx.bus.emit('task.completed', { taskId, content, projectId, source });
  }

  function rowToTask(r: any, metaRow?: any): Task {
    const raw = j<TdItem>(r.raw, null as any);
    const meta: TaskMeta = metaRow ? {
      estimateMin: metaRow.estimate_min, mustDoDate: metaRow.must_do_date, optional: !!metaRow.optional,
      homework: metaRow.homework === null || metaRow.homework === undefined ? null : !!metaRow.homework,
      carryCount: metaRow.carry_count ?? 0, lastCarryDate: metaRow.last_carry_date, nextAction: metaRow.next_action, owner: metaRow.owner,
    } : { ...EMPTY_META };
    const labels: string[] = j(r.labels, []);
    return {
      id: r.id, content: r.content, description: r.description ?? '', projectId: r.project_id, projectName: r.project_name ?? '',
      sectionId: r.section_id, sectionName: r.section_name ?? null, parentId: r.parent_id, priority: uiPriority(r.priority), labels,
      due: parseDue(raw?.due ?? null), deadline: r.deadline, durationMin: r.duration_min, estimateMin: meta.estimateMin ?? r.duration_min ?? null,
      checked: !!r.checked, completedAt: r.completed_at, meta, url: `https://app.todoist.com/app/task/${r.id}`,
    };
  }

  const svc = {
    settings: s,
    mock: () => (s().mode === 'mock' ? getMock() : null),
    client,

    status() {
      const plan = kvGet<any>(ctx.db, 'todoist.plan', null);
      const active = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM td_projects WHERE archived = 0')!.n;
      return {
        mode: s().mode,
        connected: s().mode === 'mock' || ctx.keychain.has('todoist.token'),
        lastSyncAt: kvGet<string | null>(ctx.db, 'todoist.lastSyncAt', null),
        lastError: kvGet<string | null>(ctx.db, 'todoist.lastError', null),
        plan: plan ? { maxProjects: plan.max_projects, durations: !!plan.durations, activeProjects: active, projectsLeft: Math.max(0, plan.max_projects - active) } : null,
        user: kvGet(ctx.db, 'todoist.user', null),
      };
    },

    async connect(token: string) {
      const res = await new TodoistClient(token).sync('*', ['user']);
      ctx.keychain.set('todoist.token', token);
      ctx.settings.set('todoist', { mode: 'live' });
      kvSet(ctx.db, 'todoist.syncToken', '*');
      await svc.sync();
      return res.user;
    },
    useMock() {
      ctx.settings.set('todoist', { mode: 'mock' });
      kvSet(ctx.db, 'todoist.syncToken', '*');
    },
    disconnect() {
      ctx.keychain.delete('todoist.token');
      ctx.settings.set('todoist', { mode: 'mock' });
      kvSet(ctx.db, 'todoist.syncToken', '*');
    },

    /** Incremental sync (a full one first time). One extra incremental after a full, per the docs. */
    async sync(): Promise<void> {
      if (syncing) { await syncing; return; }
      syncing = (async () => {
        try {
          const c = client();
          const token = kvGet<string>(ctx.db, 'todoist.syncToken', '*');
          const res = await c.sync(token);
          applySync(res);
          if (res.full_sync) applySync(await c.sync(res.sync_token));
          kvSet(ctx.db, 'todoist.lastSyncAt', now().toISO());
          kvSet(ctx.db, 'todoist.lastError', null);
          ctx.bus.emit('todoist.synced', { full: res.full_sync });
        } catch (e: any) {
          kvSet(ctx.db, 'todoist.lastError', e.message);
          ctx.log.warn('todoist sync failed', e.message);
          throw e;
        } finally { syncing = null; }
      })();
      await syncing;
    },

    /** Run commands then pull the result back into the mirror. */
    async write(cmds: Command[]) {
      const res = await client().commands(cmds);
      await svc.sync().catch(() => {});
      return res;
    },

    projects() {
      return ctx.db.all('SELECT id, name, color, parent_id, inbox, archived FROM td_projects WHERE archived = 0 ORDER BY inbox DESC, child_order')
        .map((p) => ({ id: p.id, name: p.name, color: p.color, parentId: p.parent_id, inbox: !!p.inbox }));
    },
    sections(projectId?: string) {
      return (projectId
        ? ctx.db.all('SELECT * FROM td_sections WHERE project_id = ? ORDER BY section_order', projectId)
        : ctx.db.all('SELECT * FROM td_sections ORDER BY section_order')).map((x) => ({ id: x.id, projectId: x.project_id, name: x.name, order: x.section_order }));
    },
    labels() { return ctx.db.all<{ id: string; name: string; color: string }>('SELECT id, name, color FROM td_labels ORDER BY name'); },
    inboxId(): string | null { return kvGet<any>(ctx.db, 'todoist.user', null)?.inboxProjectId ?? ctx.db.get<{ id: string }>('SELECT id FROM td_projects WHERE inbox = 1')?.id ?? null; },

    /** Open tasks (default) with metadata, optionally filtered. */
    tasks(f: { projectId?: string; label?: string; ids?: string[]; dueOnOrBefore?: ISODate; dueOn?: ISODate; includeDone?: boolean; mustDoOn?: ISODate } = {}): Task[] {
      const where: string[] = [];
      const params: any[] = [];
      if (!f.includeDone) where.push('i.checked = 0');
      if (f.projectId) { where.push('i.project_id = ?'); params.push(f.projectId); }
      if (f.label) { where.push("EXISTS (SELECT 1 FROM json_each(i.labels) WHERE value = ?)"); params.push(f.label); }
      if (f.ids) { where.push(`i.id IN (${f.ids.map(() => '?').join(',') || "''"})`); params.push(...f.ids); }
      if (f.dueOn) { where.push('i.due_date = ?'); params.push(f.dueOn); }
      if (f.dueOnOrBefore) { where.push('i.due_date IS NOT NULL AND i.due_date <= ?'); params.push(f.dueOnOrBefore); }
      if (f.mustDoOn) { where.push('m.must_do_date = ?'); params.push(f.mustDoOn); }
      const rows = ctx.db.all(`SELECT i.*, p.name project_name, s.name section_name, m.task_id m_id, m.estimate_min, m.must_do_date, m.optional, m.homework, m.carry_count, m.last_carry_date, m.next_action, m.owner
        FROM td_items i LEFT JOIN td_projects p ON p.id = i.project_id LEFT JOIN td_sections s ON s.id = i.section_id LEFT JOIN task_meta m ON m.task_id = i.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.due_date IS NULL, i.due_date, i.priority DESC, i.child_order`, ...params);
      return rows.map((r) => rowToTask(r, r.m_id ? r : undefined));
    },
    task(id: string): Task | null { return svc.tasks({ ids: [id], includeDone: true })[0] ?? null; },

    meta(taskId: string): TaskMeta {
      const r = ctx.db.get('SELECT * FROM task_meta WHERE task_id = ?', taskId);
      return r ? rowToTask({ raw: null, labels: '[]' }, r).meta : { ...EMPTY_META };
    },
    setMeta(taskId: string, patch: Partial<TaskMeta>) {
      const cur = svc.meta(taskId);
      const m = { ...cur, ...patch };
      ctx.db.run(`INSERT INTO task_meta (task_id, estimate_min, must_do_date, optional, homework, carry_count, last_carry_date, next_action, owner, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET estimate_min=excluded.estimate_min, must_do_date=excluded.must_do_date,
        optional=excluded.optional, homework=excluded.homework, carry_count=excluded.carry_count, last_carry_date=excluded.last_carry_date,
        next_action=excluded.next_action, owner=excluded.owner, updated_at=excluded.updated_at`,
        taskId, m.estimateMin, m.mustDoDate, m.optional, m.homework, m.carryCount, m.lastCarryDate, m.nextAction, m.owner, now().toISO());
      ctx.bus.emit('task.meta_changed', { taskId, keys: Object.keys(patch) });
      return m;
    },

    // ---------------- direct single actions (apply immediately)
    async close(taskId: string) {
      const t = svc.task(taskId);
      await svc.write([cmd('item_close', { id: taskId })]);
      if (t) logCompletion(taskId, t.content, t.projectId, 'margin');
    },
    async reopen(taskId: string) { await svc.write([cmd('item_uncomplete', { id: taskId })]); },
    async reschedule(taskId: string, date: string) {
      const raw = j<TdItem>(ctx.db.get<{ raw: string }>('SELECT raw FROM td_items WHERE id = ?', taskId)?.raw, null as any);
      if (!raw) throw Object.assign(new Error('Task not found'), { status: 404 });
      await svc.write([cmd('item_update', { id: taskId, due: rescheduleDue(raw.due, date) })]);
      const after = j<TdItem>(ctx.db.get<{ raw: string }>('SELECT raw FROM td_items WHERE id = ?', taskId)?.raw, null as any);
      if (raw.due?.is_recurring && !after?.due?.is_recurring) {
        // Safety net: put the original due back if recurrence was lost.
        await svc.write([cmd('item_update', { id: taskId, due: raw.due })]);
        throw new Error('Todoist dropped the recurrence; the original date was restored.');
      }
    },
    async update(taskId: string, patch: { content?: string; description?: string; priority?: number; labels?: string[] }) {
      const args: Record<string, unknown> = { id: taskId };
      if (patch.content !== undefined) args.content = patch.content;
      if (patch.description !== undefined) args.description = patch.description;
      if (patch.priority !== undefined) args.priority = apiPriority(patch.priority);
      if (patch.labels !== undefined) args.labels = patch.labels;
      if (patch.labels) await svc.ensureLabels(patch.labels);
      await svc.write([cmd('item_update', args)]);
    },
    async move(taskId: string, to: { projectId?: string; sectionId?: string }) {
      await svc.write([cmd('item_move', to.sectionId ? { id: taskId, section_id: to.sectionId } : { id: taskId, project_id: to.projectId })]);
    },
    async addLabel(taskId: string, label: string) {
      const t = svc.task(taskId);
      if (!t || t.labels.includes(label)) return;
      await svc.update(taskId, { labels: [...t.labels, label] });
    },
    async removeLabel(taskId: string, label: string) {
      const t = svc.task(taskId);
      if (!t || !t.labels.includes(label)) return;
      await svc.update(taskId, { labels: t.labels.filter((l) => l !== label) });
    },
    async comment(taskId: string, content: string) { await svc.write([cmd('note_add', { item_id: taskId, content })]); },
    async add(input: { content: string; projectId?: string; sectionId?: string; labels?: string[]; dueString?: string; dueDate?: string; priority?: number; description?: string }) {
      if (input.labels?.length) await svc.ensureLabels(input.labels);
      const temp = crypto.randomUUID();
      const res = await svc.write([cmd('item_add', {
        content: input.content, project_id: input.projectId, section_id: input.sectionId, labels: input.labels ?? [], description: input.description ?? '',
        priority: input.priority ? apiPriority(input.priority) : 1,
        due: input.dueString ? { string: input.dueString } : input.dueDate ? { date: input.dueDate } : undefined,
      }, temp)]);
      return res.temp_id_mapping?.[temp] ?? null;
    },
    async quickAdd(text: string) {
      const item = await client().quickAdd(text);
      await svc.sync().catch(() => {});
      return item;
    },
    /** Estimate goes to Todoist's duration when the plan supports it and the task has a time; otherwise local. */
    async setEstimate(taskId: string, minutes: number | null) {
      svc.setMeta(taskId, { estimateMin: minutes });
      const plan = kvGet<any>(ctx.db, 'todoist.plan', null);
      const t = svc.task(taskId);
      if (plan?.durations && t?.due?.time && minutes) {
        await svc.write([cmd('item_update', { id: taskId, duration: { amount: Math.min(minutes, 1440), unit: 'minute' } })]).catch((e) => ctx.log.warn('duration write failed', e.message));
      }
    },
    async ensureLabels(names: string[]) {
      const have = new Set(svc.labels().map((l) => l.name));
      const missing = [...new Set(names)].filter((n) => !have.has(n));
      if (missing.length) await svc.write(missing.map((name) => cmd('label_add', { name })));
    },
    /** Drop = close out without deleting: note + complete (ends recurrence), or the drop label. */
    async drop(taskId: string, reason: string) {
      const st = s();
      const note = `Dropped in Margin${reason ? `: ${reason}` : ''}`;
      if (st.dropMode === 'label') {
        await svc.addLabel(taskId, st.dropLabel);
        await svc.comment(taskId, note);
      } else {
        await svc.write([cmd('note_add', { item_id: taskId, content: note }), cmd('item_complete', { id: taskId })]);
      }
      svc.setMeta(taskId, { mustDoDate: null });
      ctx.bus.emit('task.dropped', { taskId, reason });
    },

    completions(from: ISODate, to: ISODate) {
      return ctx.db.all<{ task_id: string; content: string; project_id: string; completed_at: string; date: string; source: string }>(
        'SELECT * FROM td_completions WHERE date >= ? AND date <= ? ORDER BY completed_at', from, to);
    },
  };
  return svc;
}
export type TodoistService = ReturnType<typeof createTodoistService>;

const id = z.string().min(1);

export default defineModule({
  id: 'todoist',
  name: 'Todoist',
  description: 'Tasks sync with Todoist (the source of truth). Never deletes.',
  core: true,
  settings,
  migrations: [
    `CREATE TABLE td_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, parent_id TEXT, child_order INTEGER, inbox INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, raw TEXT);
     CREATE TABLE td_sections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, section_order INTEGER);
     CREATE TABLE td_labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
     CREATE TABLE td_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section_id TEXT, parent_id TEXT, content TEXT NOT NULL, description TEXT,
       priority INTEGER NOT NULL DEFAULT 1, labels TEXT NOT NULL DEFAULT '[]', due_date TEXT, due_time TEXT, due TEXT, deadline TEXT, duration_min INTEGER,
       checked INTEGER NOT NULL DEFAULT 0, completed_at TEXT, child_order INTEGER, updated_at TEXT, raw TEXT);
     CREATE INDEX td_items_due ON td_items(due_date);
     CREATE INDEX td_items_project ON td_items(project_id);
     CREATE TABLE task_meta (task_id TEXT PRIMARY KEY, estimate_min INTEGER, must_do_date TEXT, optional INTEGER NOT NULL DEFAULT 0, homework INTEGER,
       carry_count INTEGER NOT NULL DEFAULT 0, last_carry_date TEXT, next_action TEXT, owner TEXT, updated_at TEXT);
     CREATE INDEX task_meta_must ON task_meta(must_do_date);
     CREATE TABLE td_completions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, content TEXT, project_id TEXT, completed_at TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL);
     CREATE INDEX td_completions_date ON td_completions(date);`,
  ],
  service: createTodoistService,
  emits: ['todoist.synced', 'task.completed', 'task.dropped', 'task.meta_changed'],
  init(ctx) {
    const td = ctx.service<TodoistService>('todoist');
    const a = (kind: string, label: string, apply: (p: any) => Promise<unknown> | unknown, editable?: string[]) => ctx.changes.register(kind, { label, apply: (_c, p) => apply(p), editable });
    a('todoist.task.add', 'Add a Todoist task', (p) => td.add(p), ['content', 'dueString']);
    a('todoist.task.update', 'Edit a Todoist task', (p) => td.update(p.taskId, p), ['content']);
    a('todoist.task.reschedule', 'Reschedule (keeps recurrence)', (p) => td.reschedule(p.taskId, p.date), ['date']);
    a('todoist.task.close', 'Complete a task', (p) => td.close(p.taskId));
    a('todoist.task.move', 'Move a task', (p) => td.move(p.taskId, p));
    a('todoist.task.label', 'Add a label', (p) => td.addLabel(p.taskId, p.label));
    a('todoist.task.comment', 'Comment on a task', (p) => td.comment(p.taskId, p.content), ['content']);
    a('todoist.task.drop', 'Drop a task (complete with note, never delete)', (p) => td.drop(p.taskId, p.reason ?? ''), ['reason']);
    a('todoist.task.estimate', 'Set an estimate', (p) => td.setEstimate(p.taskId, p.minutes), ['minutes']);
    a('task.meta', 'Update task notes in Margin', (p) => td.setMeta(p.taskId, p.patch));
    a('todoist.project.add', 'Create a Todoist project', async (p) => {
      const st = td.status();
      if (st.plan && st.plan.projectsLeft <= 0) throw new Error(`Your Todoist plan allows ${st.plan.maxProjects} active projects. Link this tab to a label instead.`);
      const temp = crypto.randomUUID();
      const res = await td.write([cmd('project_add', { name: p.name, color: p.color ?? 'charcoal' }, temp)]);
      return { projectId: res.temp_id_mapping?.[temp] };
    }, ['name']);
    a('todoist.section.add', 'Create a section', async (p) => {
      const temp = crypto.randomUUID();
      const res = await td.write([cmd('section_add', { name: p.name, project_id: p.projectId }, temp)]);
      return { sectionId: res.temp_id_mapping?.[temp] };
    }, ['name']);
    a('todoist.project.archive', 'Archive a Todoist project (kept, not deleted)', (p) => td.write([cmd('project_archive', { id: p.projectId })]));
  },
  jobs: [
    {
      id: 'sync',
      every: 1,
      async run(ctx) {
        const td = ctx.service<TodoistService>('todoist');
        const last = kvGet<string | null>(ctx.db, 'todoist.lastSyncAt', null);
        const due = !last || now().diff(DateTime.fromISO(last), 'minutes').minutes >= td.settings().syncEveryMin;
        if (due && td.status().connected) await td.sync().catch(() => {});
      },
    },
  ],
  routes(r, ctx) {
    const td = () => ctx.service<TodoistService>('todoist');
    r.get('/status', (c) => c.json(td().status()));
    r.post('/connect', async (c) => {
      const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json());
      try { return c.json({ ok: true, user: await td().connect(token.trim()) }); }
      catch (e: any) { return c.json({ error: e.message }, 400); }
    });
    r.post('/use-mock', async (c) => { td().useMock(); await td().sync(); return c.json(td().status()); });
    r.post('/disconnect', (c) => { td().disconnect(); return c.json(td().status()); });
    r.post('/sync', async (c) => { await td().sync(); return c.json(td().status()); });
    r.get('/projects', (c) => c.json(td().projects()));
    r.get('/sections', (c) => c.json(td().sections(c.req.query('projectId') ?? undefined)));
    r.get('/labels', (c) => c.json(td().labels()));
    r.get('/tasks', (c) => c.json(td().tasks({
      projectId: c.req.query('projectId') ?? undefined, label: c.req.query('label') ?? undefined,
      dueOnOrBefore: c.req.query('dueOnOrBefore') ?? undefined, dueOn: c.req.query('dueOn') ?? undefined,
    })));
    r.get('/tasks/:id', (c) => { const t = td().task(c.req.param('id')); return t ? c.json(t) : c.json({ error: 'Not found' }, 404); });
    r.post('/tasks', async (c) => {
      const b = z.object({ content: z.string().min(1), projectId: id.optional(), sectionId: id.optional(), labels: z.array(z.string()).optional(), dueString: z.string().optional(), dueDate: z.string().optional(), priority: z.number().int().min(1).max(4).optional() }).parse(await c.req.json());
      return c.json({ id: await td().add(b) });
    });
    r.post('/tasks/:id/close', async (c) => { await td().close(c.req.param('id')); return c.json({ ok: true }); });
    r.post('/tasks/:id/reopen', async (c) => { await td().reopen(c.req.param('id')); return c.json({ ok: true }); });
    r.post('/tasks/:id/reschedule', async (c) => { const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}/) }).parse(await c.req.json()); await td().reschedule(c.req.param('id'), date); return c.json({ ok: true }); });
    r.post('/tasks/:id/estimate', async (c) => { const { minutes } = z.object({ minutes: z.number().int().min(0).max(1440).nullable() }).parse(await c.req.json()); await td().setEstimate(c.req.param('id'), minutes); return c.json({ ok: true }); });
    r.patch('/tasks/:id', async (c) => {
      const b = z.object({ content: z.string().optional(), description: z.string().optional(), priority: z.number().int().min(1).max(4).optional(), labels: z.array(z.string()).optional() }).parse(await c.req.json());
      await td().update(c.req.param('id'), b); return c.json({ ok: true });
    });
    r.patch('/tasks/:id/meta', async (c) => c.json(td().setMeta(c.req.param('id'), await c.req.json())));
    r.post('/tasks/:id/drop', async (c) => { const { reason } = await c.req.json().catch(() => ({ reason: '' })); await td().drop(c.req.param('id'), reason ?? ''); return c.json({ ok: true }); });
    r.post('/quick-add', async (c) => { const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json()); return c.json(await td().quickAdd(text)); });
    r.get('/completions', (c) => c.json(td().completions(c.req.query('from') ?? today(), c.req.query('to') ?? today())));
  },
  claude: {
    tools: [
      {
        name: 'list_tasks',
        description: 'Open Todoist tasks with Margin metadata (estimate, must-do date, carry count, next action, owner). Filter by projectId, label, or due on/before a date.',
        kind: 'read',
        input: z.object({ projectId: z.string().optional(), label: z.string().optional(), dueOnOrBefore: z.string().optional() }),
        run: (ctx, i) => ctx.service<TodoistService>('todoist').tasks(i).slice(0, 150).map((t) => ({
          id: t.id, content: t.content, project: t.projectName, priority: `p${t.priority}`, labels: t.labels, due: t.due, estimateMin: t.estimateMin,
          mustDo: t.meta.mustDoDate, carryCount: t.meta.carryCount, nextAction: t.meta.nextAction, owner: t.meta.owner,
        })),
      },
      {
        name: 'propose_task_changes',
        description: 'Propose Todoist edits for review (never applied directly). Each change: { action: "reschedule"|"add"|"drop"|"estimate"|"next_action"|"comment", taskId?, date?, content?, minutes?, reason?, nextAction? }.',
        kind: 'propose',
        input: z.object({ changes: z.array(z.object({
          action: z.enum(['reschedule', 'add', 'drop', 'estimate', 'next_action', 'comment']),
          taskId: z.string().optional(), date: z.string().optional(), content: z.string().optional(),
          minutes: z.number().optional(), reason: z.string().optional(), nextAction: z.string().optional(),
        })) }),
        run: (ctx, i) => {
          const td = ctx.service<TodoistService>('todoist');
          return i.changes.map((ch: any) => {
            const t = ch.taskId ? td.task(ch.taskId) : null;
            const name = t ? `“${t.content}”` : `“${ch.content ?? ''}”`;
            switch (ch.action) {
              case 'reschedule': return { kind: 'todoist.task.reschedule', title: `Move ${name} to ${ch.date}`, payload: { taskId: ch.taskId, date: ch.date }, before: { date: t?.due?.date ?? null } };
              case 'add': return { kind: 'todoist.task.add', title: `Add ${name}${ch.date ? ` for ${ch.date}` : ''}`, payload: { content: ch.content, dueString: ch.date } };
              case 'drop': return { kind: 'todoist.task.drop', title: `Drop ${name}`, payload: { taskId: ch.taskId, reason: ch.reason ?? '' } };
              case 'estimate': return { kind: 'todoist.task.estimate', title: `Estimate ${name} at ${ch.minutes} min`, payload: { taskId: ch.taskId, minutes: ch.minutes }, before: { minutes: t?.estimateMin ?? null } };
              case 'next_action': return { kind: 'task.meta', title: `Next action for ${name}: ${ch.nextAction}`, payload: { taskId: ch.taskId, patch: { nextAction: ch.nextAction } }, before: { nextAction: t?.meta.nextAction ?? null } };
              default: return { kind: 'todoist.task.comment', title: `Comment on ${name}`, payload: { taskId: ch.taskId, content: ch.content } };
            }
          });
        },
      },
    ],
  },
});
