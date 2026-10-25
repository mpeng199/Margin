/**
 * projects service: the contract other modules call (`list`, `get`, `filterForMain`, `projectForTask`,
 * `isHidden`, `activeNonSchool`, `deadlines`, `setStatus`) plus everything the project tabs need.
 * All Todoist and Google writes go through change sets; local rows are written directly.
 */
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '../../src/core/types';
import type { ProposedChange, ChangeSet } from '../../src/core/changesets';
import { uid } from '../../src/core/db';
import { now, today, addDays, daysBetween, at, fromISO, minutesBetween, weekStartOf, type ISODate } from '../../src/core/time';
import type { Task, TodoistService } from '../todoist/manifest';
import type { CalEvent, GoogleService } from '../google/manifest';
import type { DayService } from '../day/manifest';
import type { DelegationService } from '../delegation/manifest';
import {
  BUILTIN_TEMPLATES, PALETTE, STATUSES, isDate, slugify,
  type Maintenance, type Milestone, type MilestoneKind, type Phase, type Project, type Separation, type Status, type StatusChange, type Template, type TemplateData, type TodoistLink,
} from './model';

export const settings = z.object({
  wipLimit: z.number().int().min(1).max(6).default(2).describe('Most non-school projects that can be Core at once.'),
  defaultSeparation: z.enum(['hidden', 'milestones', 'everything']).default('milestones').describe('What a new project shows on Today and the main calendar besides work sessions and meetings.'),
  archiveTodoistOnDrop: z.boolean().default(false).describe('When you drop a project linked to a Todoist project, also archive that Todoist project (never deleted).'),
  mirrorPauseLabel: z.boolean().default(false).describe('When you pause a project, propose a change that labels its open Todoist tasks “paused”.'),
});
export type Settings = z.infer<typeof settings>;

export const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

/** Maintain needs the smallest weekly action, a minutes cap, and who has been told (SPEC 4.5). */
export function requireMaintenance(m: Maintenance | null | undefined): Maintenance {
  if (!m || !m.action?.trim()) throw fail('Maintain needs the smallest weekly action. What is the least that keeps this alive?', 400, { code: 'maintenance' });
  if (!(m.capMin > 0)) throw fail('Maintain needs a minutes cap: the most time this gets each week.', 400, { code: 'maintenance' });
  if (!m.told?.trim()) throw fail('Maintain needs to name who has been told that this project is at a lower level.', 400, { code: 'maintenance' });
  return m;
}

interface FocusLike { timeLogs(q: { projectId?: string; from?: string; to?: string }): { projectId: string; taskId: string; start: string; end: string; minutes: number }[] }
interface PhasesLike { canAddCommitment(): { allowed: boolean; reason?: string } }

export interface CreateInput {
  name: string;
  color?: string;
  icon?: string;
  isSchool?: boolean;
  purpose?: string;
  goal?: string;
  templateId?: string | null;
  startDate?: ISODate;
  sizeMin?: number;
  weeklyBudgetMin?: number;
  separation?: Separation;
  status?: Status;
  maintenance?: Maintenance | null;
  restartDate?: ISODate | null;
}
export interface StatusOpts {
  restartDate?: ISODate | null;
  maintenance?: Maintenance | null;
  /** Drop only: also archive the linked Todoist project (default from settings). */
  archiveTodoistProject?: boolean;
  /** Pause only: propose a change labelling the open tasks “paused” (default from settings). */
  mirrorPause?: boolean;
  reason?: string;
  /** Skip the add-commitment gate and the WIP check. Onboarding and `activate` (which checked already) use this. */
  force?: boolean;
}
export type ScheduleOp =
  | { op: 'move_milestone'; milestoneId: string; date: ISODate }
  | { op: 'move_phase'; phaseId: string; start: ISODate; end: ISODate }
  | { op: 'move_task'; taskId: string; date: ISODate }
  | { op: 'add_milestone'; title: string; date: ISODate; kind?: MilestoneKind; calendar?: boolean }
  | { op: 'add_phase'; title: string; start: ISODate; end: ISODate; calendar?: boolean }
  | { op: 'remove_item'; type: 'phase' | 'milestone'; id: string }
  | { op: 'sync_calendar' }
  | { op: 'bulk_milestones'; items: { title: string; date: ISODate; kind?: MilestoneKind }[] };
export interface Plan { title: string; summary: string; changes: ProposedChange[] }

const fmtD = (d: ISODate) => DateTime.fromISO(d, { zone: 'UTC' }).toFormat('EEE MMM d');
const fmtMin = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`);

const toProject = (r: any): Project => ({
  id: r.id, name: r.name, color: r.color, icon: r.icon, status: r.status, isSchool: !!r.is_school, purpose: r.purpose, goal: r.goal,
  maintenance: r.maint_action != null ? { action: r.maint_action, capMin: r.maint_cap_min ?? 0, told: r.maint_told ?? '' } : null,
  restartDate: r.restart_date, todoist: r.td_type ? { type: r.td_type, ...(r.td_id ? { id: r.td_id } : {}), ...(r.td_name ? { name: r.td_name } : {}) } : null,
  calendarId: r.calendar_id, separation: r.separation, weeklyBudgetMin: r.weekly_budget_min, sizeMin: r.size_min, order: r.sort_order,
  pinned: !!r.pinned, archived: !!r.archived, templateId: r.template_id, createdAt: r.created_at,
});
const toPhase = (r: any): Phase => ({ id: r.id, projectId: r.project_id, title: r.title, start: r.start_date, end: r.end_date, gcalEventId: r.gcal_event_id });
const toMilestone = (r: any): Milestone => ({ id: r.id, projectId: r.project_id, title: r.title, kind: r.kind, date: r.date, gcalEventId: r.gcal_event_id, done: !!r.done });

export function createProjectsService(ctx: Ctx) {
  const cfg = () => ctx.settings.get<Settings>('projects');
  const td = () => ctx.maybe<TodoistService>('todoist');
  const google = () => ctx.maybe<GoogleService>('google');
  let cache: Project[] | null = null;
  const touch = () => { cache = null; };
  const all = (): Project[] => (cache ??= ctx.db.all('SELECT * FROM projects ORDER BY sort_order, created_at').map(toProject));
  const mustGet = (id: string): Project => {
    const p = all().find((x) => x.id === id);
    if (!p) throw fail('That project no longer exists.', 404);
    return p;
  };

  const svc = {
    settings: cfg,
    wipLimit: () => cfg().wipLimit,

    // =========================================================== contract
    /** Every project, archived (dropped) ones included, in sidebar order. Filter on `archived` as needed. */
    list(): Project[] { return all(); },
    get(id: string): Project | null { return all().find((p) => p.id === id) ?? null; },

    /**
     * The separation rule (SPEC 5). Work that takes time (timed busy events: sessions, meetings) on a project
     * calendar always passes. Phases, milestones, deadlines and all-day events pass per the project's setting.
     * Events on other calendars pass unchanged.
     */
    filterForMain(events: CalEvent[]): CalEvent[] {
      const byId = new Map(all().map((p) => [p.id, p]));
      return events.filter((e) => {
        if (!e.projectId) return true;
        const structural = e.allDay || !e.busy || e.marginKind === 'phase' || e.marginKind === 'milestone' || e.marginKind === 'deadline';
        if (!structural) return true;
        const sep = byId.get(e.projectId)?.separation ?? cfg().defaultSeparation;
        if (sep === 'hidden') return false;
        if (sep === 'everything') return true;
        return e.marginKind !== 'phase'; // 'milestones': deadlines and milestones only
      });
    },

    /** The project a task belongs to. A linked Todoist project wins over a label link; live tabs win over archived ones. */
    projectForTask(task: Pick<Task, 'projectId' | 'labels'>): Project | null {
      const live = all().filter((p) => !p.archived);
      const dead = all().filter((p) => p.archived);
      for (const set of [live, dead]) {
        const byProject = set.find((p) => p.todoist?.type === 'project' && p.todoist.id === task.projectId);
        if (byProject) return byProject;
        const byLabel = set.find((p) => p.todoist?.type === 'label' && p.todoist.name && task.labels.includes(p.todoist.name));
        if (byLabel) return byLabel;
      }
      return null;
    },
    /** In a paused or dropped project: gone from Today and planning, never deleted. */
    isHidden(task: Pick<Task, 'projectId' | 'labels'>): boolean {
      const p = svc.projectForTask(task);
      return !!p && (p.status === 'pause' || p.status === 'drop' || p.archived);
    },
    /** WIP interpretation: a non-school project counts when its status is Core. Maintain is capped by its own minutes line. */
    activeNonSchool(): Project[] { return all().filter((p) => !p.archived && !p.isSchool && p.status === 'core'); },
    wip() {
      const active = svc.activeNonSchool();
      return { limit: cfg().wipLimit, count: active.length, exceeded: active.length > cfg().wipLimit, full: active.length >= cfg().wipLimit, activeIds: active.map((p) => p.id) };
    },

    deadlines(from: ISODate, to: ISODate) {
      const live = new Map(all().filter((p) => !p.archived && p.status !== 'pause' && p.status !== 'drop').map((p) => [p.id, p]));
      return ctx.db.all('SELECT * FROM project_milestones WHERE date >= ? AND date <= ? AND done = 0 ORDER BY date, title', from, to)
        .filter((m) => live.has(m.project_id))
        .map((m) => ({ projectId: m.project_id as string, projectName: live.get(m.project_id)!.name, title: m.title as string, date: m.date as ISODate, kind: m.kind as 'deadline' | 'milestone' }));
    },
    /** Paused projects whose restart date has arrived: a decision for the weekly review, never an automatic resume. */
    restartDue(date: ISODate = today()): Project[] { return all().filter((p) => !p.archived && p.status === 'pause' && p.restartDate && p.restartDate <= date); },

    // =========================================================== add-commitment gate
    canAdd(opts: { onboarding?: boolean } = {}): { allowed: boolean; reason?: string } {
      if (opts.onboarding) return { allowed: true };
      if (ctx.rules.isActive('lock_add_projects')) {
        const f = ctx.rules.active().find((x) => x.actions.includes('lock_add_projects') || x.ruleId === 'lock_add_projects');
        return { allowed: false, reason: `Adding projects is locked. ${f?.detail ?? ''}`.trim() };
      }
      const ph = ctx.maybe<PhasesLike>('phases')?.canAddCommitment();
      if (ph && !ph.allowed) return { allowed: false, reason: ph.reason ?? 'Nothing gets added back before the Rebuild phase.' };
      return { allowed: true };
    },

    // =========================================================== create / update
    /** New commitments start `proposed`; only onboarding may set a status directly. */
    create(input: CreateInput, opts: { onboarding?: boolean } = {}): Project {
      const gate = svc.canAdd(opts);
      if (!gate.allowed) throw fail(gate.reason!, 409, { code: 'locked' });
      const name = input.name?.trim();
      if (!name) throw fail('A project needs a name.');
      const tpl = input.templateId ? svc.template(input.templateId) : null;
      if (input.templateId && !tpl) throw fail('That template no longer exists.', 404);
      const id = uid();
      const order = (ctx.db.get<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM projects')!).n;
      const want: Status = opts.onboarding ? input.status ?? 'proposed' : 'proposed';
      ctx.db.tx(() => {
        ctx.db.run(`INSERT INTO projects (id, name, color, icon, status, is_school, purpose, goal, separation, weekly_budget_min, size_min, sort_order, template_id, created_at)
          VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, name, input.color ?? tpl?.data.color ?? PALETTE[order % PALETTE.length], input.icon ?? tpl?.data.icon ?? 'Folder', input.isSchool ? 1 : 0,
          input.purpose ?? '', input.goal ?? '', input.separation ?? cfg().defaultSeparation, input.weeklyBudgetMin ?? tpl?.data.weeklyBudgetMin ?? 0,
          input.sizeMin ?? tpl?.data.sizeMin ?? 0, order, tpl?.id ?? null, now().toISO());
        touch();
        ctx.db.run("INSERT INTO project_status_log (id, project_id, from_status, to_status, at, note) VALUES (?, ?, NULL, 'proposed', ?, 'Created')", uid(), id, now().toISO());
        if (tpl) svc.applyTemplate(id, tpl.data, input.startDate ?? today());
        if (want !== 'proposed') {
          svc.setStatus(id, want, {
            force: true, restartDate: input.restartDate, reason: 'Set during onboarding',
            maintenance: input.maintenance ?? (want === 'maintain' ? tpl?.data.maintenance ?? null : null),
          });
        }
      });
      ctx.bus.emit('project.created', { id });
      return mustGet(id);
    },

    update(id: string, patch: Partial<Pick<Project, 'name' | 'color' | 'icon' | 'purpose' | 'goal' | 'separation' | 'weeklyBudgetMin' | 'sizeMin' | 'isSchool' | 'pinned'>> & { maintenance?: Maintenance | null; notes?: string }): Project {
      const p = mustGet(id);
      const m = { ...p, ...patch };
      if (patch.maintenance !== undefined) {
        const mt = patch.maintenance;
        if (mt) svc.checkMaintenance(mt);
        else if (p.status === 'maintain') throw fail('A Maintain project needs its maintenance line. Change the status first.', 409);
      }
      const mt = patch.maintenance === undefined ? p.maintenance : patch.maintenance;
      ctx.db.run(`UPDATE projects SET name = ?, color = ?, icon = ?, purpose = ?, goal = ?, separation = ?, weekly_budget_min = ?, size_min = ?, is_school = ?, pinned = ?,
        maint_action = ?, maint_cap_min = ?, maint_told = ? WHERE id = ?`,
        m.name.trim() || p.name, m.color, m.icon, m.purpose, m.goal, m.separation, Math.max(0, Math.round(m.weeklyBudgetMin)), Math.max(0, Math.round(m.sizeMin)), m.isSchool ? 1 : 0, m.pinned ? 1 : 0,
        mt?.action ?? null, mt?.capMin ?? null, mt?.told ?? null, id);
      touch();
      ctx.bus.emit('project.updated', { id });
      return mustGet(id);
    },

    reorder(ids: string[]) {
      ctx.db.tx(() => {
        let i = 0;
        for (const id of ids) if (all().some((p) => p.id === id)) ctx.db.run('UPDATE projects SET sort_order = ? WHERE id = ?', i++, id);
        for (const p of all().filter((x) => !ids.includes(x.id))) ctx.db.run('UPDATE projects SET sort_order = ? WHERE id = ?', i++, p.id);
      });
      touch();
      ctx.bus.emit('project.reordered', { ids });
    },

    notes(id: string): string { mustGet(id); return ctx.db.get<{ notes: string }>('SELECT notes FROM projects WHERE id = ?', id)?.notes ?? ''; },
    setNotes(id: string, text: string) {
      mustGet(id);
      ctx.db.run('UPDATE projects SET notes = ? WHERE id = ?', text, id);
      ctx.bus.emit('project.notes_changed', { id });
    },

    // =========================================================== statuses (SPEC 4.5)
    checkMaintenance(m: Maintenance | null | undefined): Maintenance { return requireMaintenance(m); },

    /**
     * Change a project's status. Maintain needs a maintenance line, Pause a restart date, a 3rd Core non-school
     * project is refused (WIP), and anything that adds load obeys the add-commitment gate (rule lock + recovery phase).
     * Drop archives the tab and, when it has open tasks, proposes ONE change set of `todoist.task.drop`s
     * (+ optionally `todoist.project.archive`); the id is returned as `changeSetId`.
     */
    setStatus(id: string, status: Status, opts: StatusOpts = {}): Project & { changeSetId?: string } {
      const p = mustGet(id);
      if (!STATUSES.includes(status)) throw fail('Unknown status.');
      if (p.isSchool && (status === 'pause' || status === 'drop')) throw fail('School stays Core. It can’t be paused or dropped here.', 409);
      const adds = (p.status === 'pause' || p.status === 'drop' || p.status === 'proposed') && (status === 'core' || status === 'maintain');
      if (adds && !opts.force && status !== p.status) {
        const gate = svc.canAdd();
        if (!gate.allowed) throw fail(gate.reason!, 409, { code: 'locked' });
      }
      let maintenance = p.maintenance;
      if (status === 'maintain') {
        maintenance = requireMaintenance(opts.maintenance ?? p.maintenance);
      } else if (opts.maintenance) maintenance = opts.maintenance;
      let restart: ISODate | null = null;
      if (status === 'pause') {
        restart = opts.restartDate ?? p.restartDate;
        if (!restart || !isDate(restart) || restart <= today()) throw fail('Pause needs a restart date after today. When will you decide whether to bring this back?', 400, { code: 'restart' });
      }
      if (status === 'core' && !p.isSchool && p.status !== 'core' && !opts.force) {
        const others = svc.activeNonSchool().filter((x) => x.id !== id).length;
        if (others >= cfg().wipLimit) throw fail(`Work-in-progress limit: ${others} non-school projects are already Core and the limit is ${cfg().wipLimit}. Pause or drop one first.`, 409, { code: 'wip' });
      }
      const changed = p.status !== status;
      ctx.db.tx(() => {
        ctx.db.run('UPDATE projects SET status = ?, archived = ?, restart_date = ?, maint_action = ?, maint_cap_min = ?, maint_told = ? WHERE id = ?',
          status, status === 'drop' ? 1 : 0, restart, maintenance?.action ?? null, maintenance?.capMin ?? null, maintenance?.told ?? null, id);
        touch();
        if (changed) ctx.db.run('INSERT INTO project_status_log (id, project_id, from_status, to_status, at, note) VALUES (?, ?, ?, ?, ?, ?)', uid(), id, p.status, status, now().toISO(), opts.reason ?? '');
      });
      let changeSetId: string | undefined;
      if (changed && status === 'drop') changeSetId = svc.proposeCloseOut(mustGet(id), opts.archiveTodoistProject ?? cfg().archiveTodoistOnDrop)?.id;
      if (changed && status === 'pause' && (opts.mirrorPause ?? cfg().mirrorPauseLabel)) changeSetId ??= svc.proposePauseLabels(mustGet(id))?.id;
      if (changed && p.status === 'pause') changeSetId ??= svc.proposeResumeLabels(mustGet(id))?.id;
      if (changed) ctx.bus.emit('project.status_changed', { id, from: p.status, to: status });
      return { ...mustGet(id), ...(changeSetId ? { changeSetId } : {}) };
    },

    /** One change set that closes out a dropped project's open tasks. Never a delete. */
    proposeCloseOut(p: Project, archiveProject: boolean): ChangeSet | null {
      const tasks = svc.tasksOf(p);
      const changes: ProposedChange[] = tasks.map((t) => ({
        kind: 'todoist.task.drop', title: `Close out “${t.content}”`, payload: { taskId: t.id, reason: `Dropped project “${p.name}”` },
        before: { due: t.due?.date ?? null },
      }));
      if (archiveProject && p.todoist?.type === 'project' && p.todoist.id) {
        changes.push({ kind: 'todoist.project.archive', title: `Archive the Todoist project “${p.todoist.name ?? p.name}” (kept, not deleted)`, payload: { projectId: p.todoist.id } });
      }
      if (!changes.length) return null;
      return ctx.changes.propose({
        source: 'user', title: `Drop “${p.name}”: close out ${tasks.length} open task${tasks.length === 1 ? '' : 's'}`,
        summary: `The tab is archived and its data is kept. Open tasks are completed with a note or labelled, per your Drop setting in Todoist. Nothing is deleted.`, changes,
      });
    },
    proposePauseLabels(p: Project): ChangeSet | null {
      const label = td()?.settings().pausedLabel;
      const tasks = label ? svc.tasksOf(p).filter((t) => !t.labels.includes(label)) : [];
      if (!tasks.length) return null;
      return ctx.changes.propose({
        source: 'user', title: `Label ${tasks.length} task${tasks.length === 1 ? '' : 's'} “${label}” for ${p.name}`,
        summary: 'Mirrors the pause into Todoist so a filter can hide these tasks there too.',
        changes: tasks.map((t) => ({ kind: 'todoist.task.label', title: `Label “${t.content}” ${label}`, payload: { taskId: t.id, label } })),
      });
    },
    proposeResumeLabels(p: Project): ChangeSet | null {
      const label = td()?.settings().pausedLabel;
      const tasks = label ? svc.tasksOf(p).filter((t) => t.labels.includes(label)) : [];
      if (!tasks.length) return null;
      return ctx.changes.propose({
        source: 'user', title: `Remove the “${label}” label from ${tasks.length} task${tasks.length === 1 ? '' : 's'} in ${p.name}`,
        changes: tasks.map((t) => ({ kind: 'projects.task.unlabel', title: `Unlabel “${t.content}”`, payload: { taskId: t.id, label } })),
      });
    },

    /**
     * “Yes requires a no.” Activates a proposed project after pausing (default) or dropping an active, non-school
     * project of equal or larger size. Used by the weekly review. With nothing active to trade, `tradeOffId` may be null.
     */
    activate(id: string, tradeOffId: string | null, opts: { action?: 'pause' | 'drop'; restartDate?: ISODate; status?: 'core' | 'maintain'; maintenance?: Maintenance } = {}): Project & { changeSetId?: string } {
      const p = mustGet(id);
      if (p.status !== 'proposed') throw fail('Only a proposed project can be activated.', 409);
      const gate = svc.canAdd();
      if (!gate.allowed) throw fail(gate.reason!, 409, { code: 'locked' });
      const live = all().filter((x) => !x.archived && !x.isSchool && x.id !== id && (x.status === 'core' || x.status === 'maintain'));
      const trade = tradeOffId ? mustGet(tradeOffId) : null;
      if (trade) {
        if (trade.id === id || trade.isSchool || trade.archived || (trade.status !== 'core' && trade.status !== 'maintain')) throw fail('Pick an active, non-school project to pause or drop.', 400, { code: 'tradeoff' });
        if (trade.sizeMin < p.sizeMin) throw fail(`“${trade.name}” takes ${fmtMin(trade.sizeMin)} a week, less than “${p.name}” at ${fmtMin(p.sizeMin)}. Pick something of equal or larger size.`, 409, { code: 'tradeoff_size' });
      } else if (live.length) throw fail('Yes requires a no. Pick an active project of equal or larger size to pause or drop first.', 409, { code: 'tradeoff' });
      const target = opts.status ?? 'core';
      if (target === 'core' && !p.isSchool) {
        const others = svc.activeNonSchool().filter((x) => x.id !== id && x.id !== trade?.id).length;
        if (others >= cfg().wipLimit) throw fail(`Work-in-progress limit: ${others} other non-school projects are Core and the limit is ${cfg().wipLimit}. Activate as Maintain, or trade out a Core project.`, 409, { code: 'wip' });
      }
      if (target === 'maintain') svc.checkMaintenance(opts.maintenance ?? p.maintenance);
      let changeSetId: string | undefined;
      ctx.db.tx(() => {
        if (trade) changeSetId = svc.setStatus(trade.id, opts.action ?? 'pause', { force: true, restartDate: opts.restartDate ?? addDays(today(), 28), reason: `Traded for “${p.name}”` }).changeSetId;
        svc.setStatus(id, target, { force: true, maintenance: opts.maintenance, reason: trade ? `Activated; ${opts.action === 'drop' ? 'dropped' : 'paused'} “${trade.name}”` : 'Activated' });
      });
      return { ...mustGet(id), ...(changeSetId ? { changeSetId } : {}) };
    },

    statusLog(projectId: string): StatusChange[] {
      return ctx.db.all('SELECT * FROM project_status_log WHERE project_id = ? ORDER BY at DESC, rowid DESC', projectId)
        .map((r) => ({ id: r.id, projectId: r.project_id, from: r.from_status, to: r.to_status, at: r.at, note: r.note }));
    },

    // =========================================================== phases and milestones
    phases(projectId: string): Phase[] { return ctx.db.all('SELECT * FROM project_phases WHERE project_id = ? ORDER BY start_date, end_date, title', projectId).map(toPhase); },
    milestones(projectId: string): Milestone[] { return ctx.db.all('SELECT * FROM project_milestones WHERE project_id = ? ORDER BY date, title', projectId).map(toMilestone); },
    addPhase(p: { id?: string; projectId: string; title: string; start: ISODate; end: ISODate }): Phase {
      mustGet(p.projectId);
      if (!isDate(p.start) || !isDate(p.end) || p.end < p.start) throw fail('A phase needs a start date and an end date on or after it.');
      const id = p.id ?? uid();
      ctx.db.run('INSERT INTO project_phases (id, project_id, title, start_date, end_date) VALUES (?, ?, ?, ?, ?)', id, p.projectId, p.title.trim() || 'Phase', p.start, p.end);
      ctx.bus.emit('project.timeline_changed', { id: p.projectId });
      return svc.phases(p.projectId).find((x) => x.id === id)!;
    },
    updatePhase(id: string, patch: { title?: string; start?: ISODate; end?: ISODate }): Phase {
      const cur = ctx.db.get('SELECT * FROM project_phases WHERE id = ?', id);
      if (!cur) throw fail('That phase no longer exists.', 404);
      const start = patch.start ?? cur.start_date, end = patch.end ?? cur.end_date;
      if (!isDate(start) || !isDate(end) || end < start) throw fail('A phase needs a start date and an end date on or after it.');
      ctx.db.run('UPDATE project_phases SET title = ?, start_date = ?, end_date = ? WHERE id = ?', patch.title?.trim() || cur.title, start, end, id);
      ctx.bus.emit('project.timeline_changed', { id: cur.project_id });
      return svc.phases(cur.project_id).find((x) => x.id === id)!;
    },
    addMilestone(m: { id?: string; projectId: string; title: string; date: ISODate; kind?: MilestoneKind }): Milestone {
      mustGet(m.projectId);
      if (!isDate(m.date)) throw fail('A milestone needs a date.');
      const id = m.id ?? uid();
      ctx.db.run('INSERT INTO project_milestones (id, project_id, title, kind, date) VALUES (?, ?, ?, ?, ?)', id, m.projectId, m.title.trim() || 'Milestone', m.kind === 'deadline' ? 'deadline' : 'milestone', m.date);
      ctx.bus.emit('project.timeline_changed', { id: m.projectId });
      return svc.milestones(m.projectId).find((x) => x.id === id)!;
    },
    updateMilestone(id: string, patch: { title?: string; date?: ISODate; kind?: MilestoneKind; done?: boolean }): Milestone {
      const cur = ctx.db.get('SELECT * FROM project_milestones WHERE id = ?', id);
      if (!cur) throw fail('That milestone no longer exists.', 404);
      if (patch.date !== undefined && !isDate(patch.date)) throw fail('A milestone needs a date.');
      ctx.db.run('UPDATE project_milestones SET title = ?, date = ?, kind = ?, done = ? WHERE id = ?',
        patch.title?.trim() || cur.title, patch.date ?? cur.date, patch.kind ?? cur.kind, patch.done === undefined ? cur.done : patch.done ? 1 : 0, id);
      ctx.bus.emit('project.timeline_changed', { id: cur.project_id });
      return svc.milestones(cur.project_id).find((x) => x.id === id)!;
    },
    removeItem(type: 'phase' | 'milestone', id: string) {
      const table = type === 'phase' ? 'project_phases' : 'project_milestones';
      const cur = ctx.db.get(`SELECT project_id FROM ${table} WHERE id = ?`, id);
      if (!cur) return;
      ctx.db.run(`DELETE FROM ${table} WHERE id = ?`, id);
      ctx.bus.emit('project.timeline_changed', { id: cur.project_id });
    },
    nextMilestone(projectId: string, from: ISODate = today()) {
      const m = ctx.db.get('SELECT * FROM project_milestones WHERE project_id = ? AND date >= ? AND done = 0 ORDER BY date, title LIMIT 1', projectId, from);
      return m ? { ...toMilestone(m), daysAway: daysBetween(from, m.date) } : null;
    },

    // =========================================================== templates
    templates(): Template[] {
      const custom = ctx.db.all('SELECT * FROM project_templates ORDER BY created_at').map((r) => ({
        id: r.id, name: r.name, description: r.description, builtin: false, data: JSON.parse(r.data) as TemplateData,
      }));
      return [...BUILTIN_TEMPLATES, ...custom];
    },
    template(id: string): Template | null { return svc.templates().find((t) => t.id === id) ?? null; },
    applyTemplate(projectId: string, data: TemplateData, anchor: ISODate) {
      for (const ph of data.phases) svc.addPhase({ projectId, title: ph.title, start: addDays(anchor, ph.startOffset), end: addDays(anchor, ph.endOffset) });
      for (const m of data.milestones) svc.addMilestone({ projectId, title: m.title, date: addDays(anchor, m.offset), kind: m.kind });
    },
    /** “Save as Template”: phases and milestones become day offsets from the earliest date in the project. */
    saveTemplate(projectId: string, name: string, description = ''): Template {
      const p = mustGet(projectId);
      if (!name.trim()) throw fail('Give the template a name.');
      const ph = svc.phases(projectId), ms = svc.milestones(projectId);
      const dates = [...ph.map((x) => x.start), ...ms.map((x) => x.date)].sort();
      const anchor = dates[0] ?? today();
      const data: TemplateData = {
        phases: ph.map((x) => ({ title: x.title, startOffset: daysBetween(anchor, x.start), endOffset: daysBetween(anchor, x.end) })),
        milestones: ms.map((x) => ({ title: x.title, offset: daysBetween(anchor, x.date), kind: x.kind })),
        maintenance: p.maintenance ? { ...p.maintenance, told: '' } : null,
        icon: p.icon, color: p.color, sizeMin: p.sizeMin, weeklyBudgetMin: p.weeklyBudgetMin,
      };
      const id = `tpl-${uid().slice(0, 8)}`;
      ctx.db.run('INSERT INTO project_templates (id, name, description, data, created_at) VALUES (?, ?, ?, ?, ?)', id, name.trim(), description, JSON.stringify(data), now().toISO());
      return svc.template(id)!;
    },
    removeTemplate(id: string) { ctx.db.run('DELETE FROM project_templates WHERE id = ?', id); },

    // =========================================================== Todoist link
    tasksOf(p: Project): Task[] {
      const t = td();
      if (!t || !p.todoist) return [];
      if (p.todoist.type === 'project') return p.todoist.id ? t.tasks({ projectId: p.todoist.id }) : [];
      return p.todoist.name ? t.tasks({ label: p.todoist.name }) : [];
    },
    /** Todoist projects and labels a tab could link to, and whether the plan has room for a new project. */
    todoistOptions(id: string) {
      mustGet(id);
      const t = td()!;
      const status = t.status();
      const taken = new Set(all().filter((p) => !p.archived && p.id !== id).map((p) => (p.todoist?.type === 'project' ? `p:${p.todoist.id}` : p.todoist?.name ? `l:${p.todoist.name}` : '')));
      return {
        plan: status.plan, projectsLeft: status.plan?.projectsLeft ?? null, maxProjects: status.plan?.maxProjects ?? null,
        planLimited: !!status.plan && status.plan.projectsLeft <= 0,
        projects: t.projects().filter((p) => !p.inbox).map((p) => ({ id: p.id, name: p.name, taken: taken.has(`p:${p.id}`) })),
        labels: t.labels().map((l) => ({ id: l.id, name: l.name, taken: taken.has(`l:${l.name}`) })),
        suggestedLabel: slugify(mustGet(id).name),
      };
    },
    async linkTodoist(id: string, link: { type: 'project'; id: string } | { type: 'label'; name: string } | null): Promise<Project> {
      const p = mustGet(id);
      const t = td();
      if (!link) {
        ctx.db.run('UPDATE projects SET td_type = NULL, td_id = NULL, td_name = NULL WHERE id = ?', id);
      } else if (link.type === 'project') {
        const tp = t?.projects().find((x) => x.id === link.id);
        if (!tp) throw fail('That Todoist project isn’t in the last sync. Sync Todoist and try again.', 404);
        const dup = all().find((x) => x.id !== id && !x.archived && x.todoist?.type === 'project' && x.todoist.id === tp.id);
        if (dup) throw fail(`“${tp.name}” is already linked to the “${dup.name}” tab.`, 409);
        ctx.db.run("UPDATE projects SET td_type = 'project', td_id = ?, td_name = ? WHERE id = ?", tp.id, tp.name, id);
      } else {
        const name = link.name.trim();
        if (!name) throw fail('A label needs a name.');
        const dup = all().find((x) => x.id !== id && !x.archived && x.todoist?.type === 'label' && x.todoist.name === name);
        if (dup) throw fail(`The label “${name}” is already linked to the “${dup.name}” tab.`, 409);
        await t!.ensureLabels([name]);
        const lab = t!.labels().find((l) => l.name === name);
        ctx.db.run("UPDATE projects SET td_type = 'label', td_id = ?, td_name = ? WHERE id = ?", lab?.id ?? null, name, id);
      }
      touch();
      ctx.bus.emit('project.updated', { id, linked: 'todoist' });
      return mustGet(p.id);
    },
    /**
     * The change that creates a Todoist project for this tab. On the Free plan with no projects left it refuses
     * (409, code plan_limit) so the caller can offer a label link instead.
     */
    planTodoistCreate(id: string): Plan {
      const p = mustGet(id);
      const opt = svc.todoistOptions(id);
      if (opt.planLimited) {
        throw fail(`Your Todoist plan allows ${opt.maxProjects} active projects and all are in use. Link “${p.name}” to a label instead: tasks still live in Todoist, and the tab shows them the same way.`, 409, { code: 'plan_limit' });
      }
      return {
        title: `Create the Todoist project “${p.name}”`, summary: 'Creates an empty project in Todoist and links this tab to it.',
        changes: [{ kind: 'todoist.project.add', title: `Create the Todoist project “${p.name}”`, payload: { name: p.name, color: 'charcoal', _projectId: id } }],
      };
    },

    // =========================================================== Google calendar link
    calName(p: Project) { return `${google()?.settings().projectCalendarPrefix ?? 'Project · '}${p.name}`; },
    /** Create (or reuse) this project's own calendar, e.g. “Project · Delphic Medicine”. Idempotent. */
    async ensureCalendar(id: string): Promise<string> {
      const p = mustGet(id);
      const calId = await google()!.ensureAppCalendar('project', p.id, svc.calName(p), p.color);
      ctx.db.run('UPDATE projects SET calendar_id = ? WHERE id = ?', calId, id);
      touch();
      svc.adoptEventIds(id);
      ctx.bus.emit('project.updated', { id, linked: 'calendar' });
      return calId;
    },
    linkCalendar(id: string, calendarId: string): Project {
      mustGet(id);
      const g = google()!;
      if (!g.calendars().some((c) => c.id === calendarId)) throw fail('That calendar isn’t in the last sync. Sync Google Calendar and try again.', 404);
      const dup = all().find((x) => x.id !== id && x.calendarId === calendarId);
      if (dup) throw fail(`That calendar already belongs to the “${dup.name}” tab.`, 409);
      g.linkAppCalendar('project', id, calendarId);
      ctx.db.run('UPDATE projects SET calendar_id = ? WHERE id = ?', calendarId, id);
      touch();
      svc.adoptEventIds(id);
      ctx.bus.emit('project.updated', { id, linked: 'calendar' });
      return mustGet(id);
    },
    calendarOptions(id: string) {
      const p = mustGet(id);
      const g = google()!;
      const mine = new Set(all().filter((x) => x.id !== id).map((x) => x.calendarId));
      return {
        connected: g.status().connected, calendarId: p.calendarId, name: svc.calName(p),
        calendars: g.calendars().filter((c) => !c.hidden && !c.primary && c.appKind !== 'blocks').map((c) => ({ id: c.id, summary: c.summary, color: c.color, taken: mine.has(c.id) })),
      };
    },
    /** Pair local phases and milestones with calendar events by marginRef, so none is created twice. */
    adoptEventIds(id: string) {
      const g = google();
      const p = all().find((x) => x.id === id);
      const calId = p?.calendarId ?? g?.appCalendarId('project', id) ?? null;
      if (!g || !p || !calId) return;
      if (!p.calendarId) { ctx.db.run('UPDATE projects SET calendar_id = ? WHERE id = ?', calId, id); touch(); }
      const ph = svc.phases(id), ms = svc.milestones(id);
      const dates = [...ph.flatMap((x) => [x.start, x.end]), ...ms.map((x) => x.date)].sort();
      if (!dates.length) return;
      const evs = g.eventsBetween(at(addDays(dates[0], -1), '00:00').toISO()!, at(addDays(dates[dates.length - 1], 3), '00:00').toISO()!, { calendarIds: [calId] });
      const byRef = new Map(evs.filter((e) => e.marginRef).map((e) => [e.marginRef!, e.id]));
      for (const x of ph) if (byRef.has(x.id) && x.gcalEventId !== byRef.get(x.id)) ctx.db.run('UPDATE project_phases SET gcal_event_id = ? WHERE id = ?', byRef.get(x.id), x.id);
      for (const x of ms) if (byRef.has(x.id) && x.gcalEventId !== byRef.get(x.id)) ctx.db.run('UPDATE project_milestones SET gcal_event_id = ? WHERE id = ?', byRef.get(x.id), x.id);
    },
    calTarget(p: Project) {
      return p.calendarId ? { calendarId: p.calendarId } : { appCalendar: { kind: 'project', ref: p.id, summary: svc.calName(p), color: p.color } };
    },
    eventCreate(p: Project, kind: 'phase' | 'milestone' | 'deadline', refId: string, title: string, start: ISODate, endInclusive: ISODate): ProposedChange {
      const noun = kind === 'phase' ? 'phase' : kind;
      return {
        kind: 'gcal.event.create', title: `Add the ${noun} “${title}” to ${svc.calName(p)}`,
        payload: { ...svc.calTarget(p), title, start, end: addDays(endInclusive, 1), allDay: true, busy: false, marginKind: kind, marginRef: refId, _projectId: p.id },
      };
    },
    eventUpdate(p: Project, eventId: string, title: string, start: ISODate, endInclusive: ISODate, before: { start: ISODate; end: ISODate }): ProposedChange {
      return {
        kind: 'gcal.event.update', title: `Move “${title}” on ${svc.calName(p)} to ${fmtD(start)}${start === endInclusive ? '' : ` – ${fmtD(endInclusive)}`}`,
        payload: { calendarId: p.calendarId, eventId, start, end: addDays(endInclusive, 1), allDay: true, _projectId: p.id },
        before: { start: before.start, end: addDays(before.end, 1) },
      };
    },

    // =========================================================== schedule: every calendar/Todoist write for the timeline
    /** Builds the change list for an operation without writing anything. The UI shows it in a confirm sheet. */
    planSchedule(projectId: string, op: ScheduleOp): Plan {
      const p = mustGet(projectId);
      const g = google();
      const calOn = !!g && g.status().connected;
      switch (op.op) {
        case 'move_milestone': {
          svc.adoptEventIds(projectId);
          const m = svc.milestones(projectId).find((x) => x.id === op.milestoneId);
          if (!m) throw fail('That milestone no longer exists.', 404);
          if (!isDate(op.date)) throw fail('Pick a date.');
          const changes: ProposedChange[] = [{ kind: 'projects.milestone.update', title: `Move “${m.title}” to ${fmtD(op.date)}`, payload: { milestoneId: m.id, date: op.date, _projectId: projectId }, before: { date: m.date } }];
          if (p.calendarId && m.gcalEventId) changes.push(svc.eventUpdate(p, m.gcalEventId, m.title, op.date, op.date, { start: m.date, end: m.date }));
          return { title: `Move “${m.title}” from ${fmtD(m.date)} to ${fmtD(op.date)}`, summary: '', changes };
        }
        case 'move_phase': {
          svc.adoptEventIds(projectId);
          const ph = svc.phases(projectId).find((x) => x.id === op.phaseId);
          if (!ph) throw fail('That phase no longer exists.', 404);
          if (!isDate(op.start) || !isDate(op.end) || op.end < op.start) throw fail('A phase needs a start date and an end date on or after it.');
          const changes: ProposedChange[] = [{
            kind: 'projects.phase.update', title: `Move “${ph.title}” to ${fmtD(op.start)} – ${fmtD(op.end)}`,
            payload: { phaseId: ph.id, start: op.start, end: op.end, _projectId: projectId }, before: { start: ph.start, end: ph.end },
          }];
          if (p.calendarId && ph.gcalEventId) changes.push(svc.eventUpdate(p, ph.gcalEventId, ph.title, op.start, op.end, { start: ph.start, end: ph.end }));
          return { title: `Move “${ph.title}” from ${fmtD(ph.start)} – ${fmtD(ph.end)} to ${fmtD(op.start)} – ${fmtD(op.end)}`, summary: '', changes };
        }
        case 'move_task': {
          const t = td()?.task(op.taskId);
          if (!t) throw fail('That task isn’t in the last Todoist sync.', 404);
          if (!isDate(op.date)) throw fail('Pick a date.');
          return {
            title: `Move “${t.content}” from ${t.due ? fmtD(t.due.date) : 'no date'} to ${fmtD(op.date)}`, summary: t.due?.recurring ? 'This task repeats; the recurrence is kept.' : '',
            changes: [{ kind: 'todoist.task.reschedule', title: `Move “${t.content}” to ${fmtD(op.date)}`, payload: { taskId: t.id, date: op.date }, before: { date: t.due?.date ?? null } }],
          };
        }
        case 'add_milestone': {
          const id = uid();
          const kind = op.kind === 'deadline' ? 'deadline' : 'milestone';
          if (!isDate(op.date)) throw fail('Pick a date.');
          const changes: ProposedChange[] = [{ kind: 'projects.milestone.add', title: `Add the ${kind} “${op.title}” on ${fmtD(op.date)}`, payload: { id, projectId, title: op.title, date: op.date, kind, _projectId: projectId } }];
          if (op.calendar ?? (!!p.calendarId && calOn)) changes.push(svc.eventCreate(p, kind, id, op.title, op.date, op.date));
          return { title: `Add ${kind} “${op.title}”`, summary: '', changes };
        }
        case 'add_phase': {
          const id = uid();
          if (!isDate(op.start) || !isDate(op.end) || op.end < op.start) throw fail('A phase needs a start date and an end date on or after it.');
          const changes: ProposedChange[] = [{ kind: 'projects.phase.add', title: `Add the phase “${op.title}”, ${fmtD(op.start)} – ${fmtD(op.end)}`, payload: { id, projectId, title: op.title, start: op.start, end: op.end, _projectId: projectId } }];
          if (op.calendar ?? (!!p.calendarId && calOn)) changes.push(svc.eventCreate(p, 'phase', id, op.title, op.start, op.end));
          return { title: `Add phase “${op.title}”`, summary: '', changes };
        }
        case 'remove_item': {
          svc.adoptEventIds(projectId);
          const item = op.type === 'phase' ? svc.phases(projectId).find((x) => x.id === op.id) : svc.milestones(projectId).find((x) => x.id === op.id);
          if (!item) throw fail('That item no longer exists.', 404);
          const changes: ProposedChange[] = [{ kind: 'projects.item.remove', title: `Remove ${op.type} “${item.title}” from this timeline`, payload: { type: op.type, id: op.id, _projectId: projectId } }];
          if (p.calendarId && item.gcalEventId) changes.push({ kind: 'gcal.event.delete', title: `Remove “${item.title}” from ${svc.calName(p)} (an event Margin created)`, payload: { calendarId: p.calendarId, eventId: item.gcalEventId, _projectId: projectId } });
          return { title: `Remove “${item.title}”`, summary: '', changes };
        }
        case 'sync_calendar': {
          if (!calOn) throw fail('Google Calendar isn’t connected.', 409);
          svc.adoptEventIds(projectId);
          const changes: ProposedChange[] = [
            ...svc.phases(projectId).filter((x) => !x.gcalEventId).map((x) => svc.eventCreate(p, 'phase', x.id, x.title, x.start, x.end)),
            ...svc.milestones(projectId).filter((x) => !x.gcalEventId).map((x) => svc.eventCreate(p, x.kind, x.id, x.title, x.date, x.date)),
          ];
          return { title: `Put ${changes.length} timeline item${changes.length === 1 ? '' : 's'} on ${svc.calName(p)}`, summary: 'All-day events on this project’s own calendar, so the timeline shows on your phone.', changes };
        }
        case 'bulk_milestones': {
          const changes: ProposedChange[] = [];
          for (const it of op.items) {
            if (!it.title?.trim() || !isDate(it.date)) throw fail(`“${it.title ?? ''}” needs a title and a YYYY-MM-DD date.`);
            const id = uid();
            const kind = it.kind === 'milestone' ? 'milestone' : 'deadline';
            changes.push({ kind: 'projects.milestone.add', title: `Add the ${kind} “${it.title}” on ${fmtD(it.date)}`, payload: { id, projectId, title: it.title, date: it.date, kind, _projectId: projectId } });
            if (calOn) changes.push(svc.eventCreate(p, kind, id, it.title, it.date, it.date));
          }
          return { title: `Add ${op.items.length} date${op.items.length === 1 ? '' : 's'} to ${p.name}`, summary: calOn ? `Each goes on the timeline and as an all-day event on ${svc.calName(p)}.` : 'Local only: Google Calendar isn’t connected.', changes };
        }
      }
    },
    /** Propose then apply in one go: the user confirmed in the sheet. Returns the applied set. */
    async applyPlan(plan: Plan, source: ChangeSet['source'] = 'user'): Promise<ChangeSet> {
      if (!plan.changes.length) throw fail('Nothing to change.');
      const set = ctx.changes.propose({ source, title: plan.title, summary: plan.summary, changes: plan.changes });
      const out = await ctx.changes.apply(set.id);
      await svc.afterApply(out);
      return out;
    },
    async schedule(projectId: string, op: ScheduleOp, source: ChangeSet['source'] = 'user') { return svc.applyPlan(svc.planSchedule(projectId, op), source); },

    /** After a set applies: link a Todoist project Margin just created, and pair new calendar events with local rows. */
    async afterApply(set: ChangeSet) {
      for (const c of set.changes) {
        const pid = c.payload?._projectId as string | undefined;
        if (!pid || c.status !== 'applied' || !all().some((p) => p.id === pid)) continue;
        if (c.kind === 'todoist.project.add' && c.result?.projectId) {
          const p = mustGet(pid);
          if (!p.todoist) await svc.linkTodoist(pid, { type: 'project', id: c.result.projectId });
        } else if (c.kind.startsWith('gcal.event.')) svc.adoptEventIds(pid);
      }
    },

    // =========================================================== views
    weekRange() {
      const ws = ctx.maybe<DayService>('day')?.settings().weekStart ?? 7;
      const from = weekStartOf(today(), ws);
      return { from, to: addDays(from, 6) };
    },
    /** Time actually spent this week: focus-timer logs plus timed events on the project calendar (clipped to now). */
    spent(p: Project) {
      const { from, to } = svc.weekRange();
      const logs = (ctx.maybe<FocusLike>('focus')?.timeLogs({ projectId: p.id, from, to: addDays(to, 1) }) ?? []).filter((l) => l.start.slice(0, 10) >= from && l.start.slice(0, 10) <= to);
      const focusMin = logs.reduce((s, l) => s + l.minutes, 0);
      let eventMin = 0;
      const g = google();
      if (g && p.calendarId) {
        const t = now();
        for (const e of g.eventsBetween(at(from, '00:00').toISO()!, at(addDays(to, 1), '00:00').toISO()!, { calendarIds: [p.calendarId] })) {
          if (e.allDay || !e.busy) continue;
          const s = fromISO(e.start), en = fromISO(e.end);
          const end = en.toMillis() > t.toMillis() ? t : en;
          if (end.toMillis() > s.toMillis()) eventMin += minutesBetween(s, end);
        }
      }
      const budgetMin = p.weeklyBudgetMin || (p.status === 'maintain' ? p.maintenance?.capMin ?? 0 : 0);
      return { from, to, focusMin, eventMin, actualMin: focusMin + eventMin, budgetMin, over: budgetMin > 0 && focusMin + eventMin > budgetMin };
    },
    overview(id: string) {
      const p = mustGet(id);
      const tasks = svc.tasksOf(p);
      const t0 = today();
      return {
        project: p,
        nextMilestone: svc.nextMilestone(id),
        currentPhase: svc.phases(id).find((x) => x.start <= t0 && x.end >= t0) ?? null,
        budget: svc.spent(p),
        openLoops: {
          openTasks: tasks.length,
          overdue: tasks.filter((t) => t.due && t.due.date < t0).length,
          waiting: ctx.maybe<DelegationService>('delegation')?.waiting(id) ?? [],
        },
        hotspots: tasks.filter((t) => t.meta.carryCount >= 2).sort((a, b) => b.meta.carryCount - a.meta.carryCount)
          .map((t) => ({ id: t.id, content: t.content, carryCount: t.meta.carryCount, due: t.due?.date ?? null, nextAction: t.meta.nextAction })),
        statusLog: svc.statusLog(id).slice(0, 5),
      };
    },
    timeline(id: string, from: ISODate = addDays(today(), -60), to: ISODate = addDays(today(), 240)) {
      const p = mustGet(id);
      svc.adoptEventIds(id);
      const g = google();
      const sessions: { id: string; title: string; start: string; end: string; source: 'focus' | 'calendar' }[] = [];
      for (const l of ctx.maybe<FocusLike>('focus')?.timeLogs({ projectId: id, from, to: addDays(to, 1) }) ?? []) {
        sessions.push({ id: `focus:${l.taskId}:${l.start}`, title: td()?.task(l.taskId)?.content ?? 'Focus session', start: l.start, end: l.end, source: 'focus' });
      }
      if (g && p.calendarId) {
        for (const e of g.eventsBetween(at(from, '00:00').toISO()!, at(addDays(to, 1), '00:00').toISO()!, { calendarIds: [p.calendarId] })) {
          if (!e.allDay && e.busy && !['phase', 'milestone', 'deadline'].includes(e.marginKind ?? '')) sessions.push({ id: `cal:${e.id}`, title: e.title, start: e.start, end: e.end, source: 'calendar' });
        }
      }
      return {
        today: today(), phases: svc.phases(id), milestones: svc.milestones(id), sessions,
        tasks: svc.tasksOf(p).filter((t) => t.due).map((t) => ({ id: t.id, content: t.content, date: t.due!.date, recurring: t.due!.recurring, priority: t.priority })),
      };
    },
    calendar(id: string, startDate: ISODate, endDate: ISODate, overlay = false) {
      const p = mustGet(id);
      const g = google();
      const startIso = at(startDate, '00:00').toISO()!, endIso = at(endDate, '00:00').toISO()!;
      const events = g && p.calendarId ? g.eventsBetween(startIso, endIso, { calendarIds: [p.calendarId] }) : [];
      const main = overlay && g ? svc.filterForMain(g.eventsBetween(startIso, endIso)).filter((e) => e.calendarId !== p.calendarId) : [];
      const tasks = svc.tasksOf(p).filter((t) => t.due && t.due.date >= startDate && t.due.date < endDate).map((t) => ({ id: t.id, content: t.content, date: t.due!.date, time: t.due!.time }));
      return { events, overlay: main, tasks, calendarId: p.calendarId };
    },
    log(id: string, from: ISODate, to: ISODate) {
      const p = mustGet(id);
      const t = td();
      let completions: { taskId: string; content: string; completedAt: string; date: string }[] = [];
      if (t && p.todoist) {
        completions = t.completions(from, to).filter((c) => {
          if (p.todoist!.type === 'project') return c.project_id === p.todoist!.id;
          return !!p.todoist!.name && !!t.task(c.task_id)?.labels.includes(p.todoist!.name);
        }).map((c) => ({ taskId: c.task_id, content: c.content, completedAt: c.completed_at, date: c.date }));
      }
      const timeLogs = (ctx.maybe<FocusLike>('focus')?.timeLogs({ projectId: id, from, to: addDays(to, 1) }) ?? [])
        .filter((l) => l.start.slice(0, 10) >= from && l.start.slice(0, 10) <= to)
        .map((l) => ({ ...l, taskName: t?.task(l.taskId)?.content ?? null }));
      return { completions, timeLogs, timeMin: timeLogs.reduce((s, l) => s + l.minutes, 0), statusLog: svc.statusLog(id) };
    },

    // =========================================================== task actions from the Tasks tab
    async addTask(id: string, input: { content: string; sectionId?: string; dueString?: string }) {
      const p = mustGet(id);
      if (!p.todoist) throw fail('Link a Todoist project or label to this tab first.', 409);
      if (!input.content.trim()) throw fail('A task needs a title.');
      return td()!.add({
        content: input.content.trim(), dueString: input.dueString || undefined,
        ...(p.todoist.type === 'project' ? { projectId: p.todoist.id, sectionId: input.sectionId } : { labels: [p.todoist.name!] }),
      });
    },
    /** Must-do toggle: local flag plus the Todoist label. A 4th required must-do for a day becomes optional (SPEC 4.3). */
    async setMustDo(taskId: string, on: boolean) {
      const t = td()!;
      const task = t.task(taskId);
      if (!task) throw fail('That task isn’t in the last Todoist sync.', 404);
      const label = t.settings().mustDoLabel;
      if (!on) {
        t.setMeta(taskId, { mustDoDate: null, optional: false });
        await t.removeLabel(taskId, label);
        return { on: false, optional: false };
      }
      const date = ctx.maybe<DayService>('day')?.planningDate() ?? today();
      const cap = ctx.settings.get<{ mustDoCap?: number }>('plan')?.mustDoCap ?? 3;
      const required = (ctx.maybe<{ mustDos(d: ISODate): Task[] }>('plan')?.mustDos(date) ?? []).filter((x) => x.id !== taskId && !x.meta.optional).length;
      const optional = required >= cap;
      t.setMeta(taskId, { mustDoDate: date, optional });
      await t.addLabel(taskId, label);
      return { on: true, optional, date };
    },
  };
  return svc;
}
export type ProjectsService = ReturnType<typeof createProjectsService>;
