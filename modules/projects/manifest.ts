/**
 * projects — every project is a tab with its own Todoist link, its own Google calendar, timeline,
 * statuses (Core / Maintain / Pause / Drop / Proposed), WIP limit, "yes requires a no", and templates.
 * SPEC 5 and 4.5. The separation rule keeps a project's milestones off the main calendar unless you choose.
 */
import { z } from 'zod';
import type { Context } from 'hono';
import { defineModule, type ClaudeTool } from '../../src/core/types';
import type { ChangeSet, ProposedChange } from '../../src/core/changesets';
import { today, addDays } from '../../src/core/time';
import { DEFAULT_PAUSE_DAYS, SEPARATIONS, STATUSES, seedSuggestions, slugify } from './model';
import { createProjectsService, fail, settings, type ProjectsService, type ScheduleOp } from './service';

export type { ProjectsService } from './service';
export * from './model';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const maintenance = z.object({ action: z.string(), capMin: z.number().int().min(0), told: z.string() });
const kindEnum = z.enum(['milestone', 'deadline']);
const createSchema = z.object({
  name: z.string().min(1), color: z.string().optional(), icon: z.string().optional(), isSchool: z.boolean().optional(), purpose: z.string().optional(), goal: z.string().optional(),
  templateId: z.string().nullish(), startDate: date.optional(), sizeMin: z.number().int().min(0).optional(), weeklyBudgetMin: z.number().int().min(0).optional(),
  separation: z.enum(SEPARATIONS).optional(),
});
const updateSchema = z.object({
  name: z.string().min(1), color: z.string(), icon: z.string(), purpose: z.string(), goal: z.string(), separation: z.enum(SEPARATIONS),
  weeklyBudgetMin: z.number().int().min(0), sizeMin: z.number().int().min(0), isSchool: z.boolean(), pinned: z.boolean(), maintenance: maintenance.nullable(),
}).partial();
const scheduleSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move_milestone'), milestoneId: z.string(), date }),
  z.object({ op: z.literal('move_phase'), phaseId: z.string(), start: date, end: date }),
  z.object({ op: z.literal('move_task'), taskId: z.string(), date }),
  z.object({ op: z.literal('add_milestone'), title: z.string().min(1), date, kind: kindEnum.optional(), calendar: z.boolean().optional() }),
  z.object({ op: z.literal('add_phase'), title: z.string().min(1), start: date, end: date, calendar: z.boolean().optional() }),
  z.object({ op: z.literal('remove_item'), type: z.enum(['phase', 'milestone']), id: z.string() }),
  z.object({ op: z.literal('sync_calendar') }),
  z.object({ op: z.literal('bulk_milestones'), items: z.array(z.object({ title: z.string(), date, kind: kindEnum.optional() })).min(1) }),
]);

/** A failed set is an error for the caller; a partial one still returns so the UI can say which part failed. */
function respond(c: Context, out: ChangeSet) {
  if (out.status === 'failed') return c.json({ error: out.changes.find((x) => x.status === 'failed')?.error ?? 'The change failed.', changeSet: out }, 409);
  return c.json(out);
}

export default defineModule({
  id: 'projects',
  name: 'Projects',
  description: 'Every project is a tab with its own tasks, timeline, calendar and notes, and a status that decides how much of your week it gets.',
  settings,
  migrations: [
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'Folder', status TEXT NOT NULL DEFAULT 'proposed',
       is_school INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '',
       maint_action TEXT, maint_cap_min INTEGER, maint_told TEXT, restart_date TEXT,
       td_type TEXT, td_id TEXT, td_name TEXT, calendar_id TEXT,
       separation TEXT NOT NULL DEFAULT 'milestones', weekly_budget_min INTEGER NOT NULL DEFAULT 0, size_min INTEGER NOT NULL DEFAULT 0,
       sort_order INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
       template_id TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
     );
     CREATE TABLE project_phases (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, gcal_event_id TEXT);
     CREATE INDEX project_phases_project ON project_phases(project_id);
     CREATE TABLE project_milestones (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'milestone', date TEXT NOT NULL, gcal_event_id TEXT, done INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX project_milestones_project ON project_milestones(project_id, date);
     CREATE INDEX project_milestones_date ON project_milestones(date);
     CREATE TABLE project_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE TABLE project_status_log (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
     CREATE INDEX project_status_log_project ON project_status_log(project_id, at);`,
  ],
  service: createProjectsService,
  // One entry only: the sidebar component lists the individual projects under it.
  nav: [{ id: 'projects', label: 'Projects', icon: 'FolderKanban', path: '/projects', section: 'main', order: 20, work: true }],
  emits: ['project.created', 'project.status_changed', 'project.updated', 'project.reordered', 'project.timeline_changed', 'project.notes_changed'],
  on: {
    // Sets applied from the review screen (not just from a project tab) still link a new Todoist project and pair calendar events.
    'changeset.applied': async (p, ctx) => {
      const set = ctx.changes.get(p.id);
      if (set) await ctx.service<ProjectsService>('projects').afterApply(set);
    },
  },
  init(ctx) {
    const S = () => ctx.service<ProjectsService>('projects');
    const A = (kind: string, label: string, apply: (p: any) => unknown, editable?: string[]) => ctx.changes.register(kind, { label, apply: (_c, p) => apply(p), editable });
    A('projects.status.set', 'Change a project’s status', (p) => {
      const out = S().setStatus(p.projectId, p.status, { restartDate: p.restartDate, maintenance: p.maintenance, reason: p.reason });
      return { changeSetId: out.changeSetId ?? null };
    }, ['restartDate']);
    A('projects.activate', 'Activate a proposed project (pausing or dropping another)', (p) => ({ changeSetId: S().activate(p.projectId, p.tradeOffId ?? null, { action: p.action, restartDate: p.restartDate }).changeSetId ?? null }), ['restartDate']);
    A('projects.update', 'Edit a project', (p) => S().update(p.projectId, p.patch ?? {}));
    A('projects.milestone.add', 'Add a milestone or deadline', (p) => S().addMilestone({ id: p.id, projectId: p.projectId, title: p.title, date: p.date, kind: p.kind }), ['title', 'date']);
    A('projects.milestone.update', 'Change a milestone or deadline', (p) => S().updateMilestone(p.milestoneId, { title: p.title, date: p.date, kind: p.kind }), ['title', 'date']);
    A('projects.phase.add', 'Add a phase', (p) => S().addPhase({ id: p.id, projectId: p.projectId, title: p.title, start: p.start, end: p.end }), ['title', 'start', 'end']);
    A('projects.phase.update', 'Change a phase', (p) => S().updatePhase(p.phaseId, { title: p.title, start: p.start, end: p.end }), ['title', 'start', 'end']);
    A('projects.item.remove', 'Remove a phase or milestone from the timeline', (p) => S().removeItem(p.type, p.id));
    A('projects.task.unlabel', 'Remove a Todoist label', (p) => ctx.service<any>('todoist').removeLabel(p.taskId, p.label));
  },
  routes(r, ctx) {
    const S = () => ctx.service<ProjectsService>('projects');
    const detail = (id: string) => {
      const s = S();
      const p = s.get(id);
      if (!p) throw fail('That project no longer exists.', 404);
      return { ...p, phases: s.phases(id), milestones: s.milestones(id), nextMilestone: s.nextMilestone(id) };
    };

    // ---- collection
    r.get('/', (c) => c.json(S().list().filter((p) => c.req.query('archived') === '1' || !p.archived)));
    r.get('/summary', (c) => {
      const s = S();
      const list = s.list().filter((p) => !p.archived);
      return c.json({
        projects: list.map((p) => ({ ...p, nextMilestone: s.nextMilestone(p.id), spent: p.status === 'core' || p.status === 'maintain' ? s.spent(p) : null })),
        wip: s.wip(), canAdd: s.canAdd(), restartDue: s.restartDue().map((p) => p.id),
        proposed: list.filter((p) => p.status === 'proposed'),
        tradeoffs: list.filter((p) => !p.isSchool && (p.status === 'core' || p.status === 'maintain')),
      });
    });
    r.get('/seed-suggestions', (c) => c.json(seedSuggestions(today())));
    r.get('/templates', (c) => c.json(S().templates()));
    r.delete('/templates/:id', (c) => { S().removeTemplate(c.req.param('id')); return c.json({ ok: true }); });
    r.post('/reorder', async (c) => {
      const { ids } = z.object({ ids: z.array(z.string()) }).parse(await c.req.json());
      S().reorder(ids);
      return c.json({ ok: true });
    });
    r.post('/', async (c) => {
      const b = createSchema.parse(await c.req.json());
      return c.json(S().create(b));
    });

    /**
     * Onboarding: create every confirmed seed with its status (bypassing the add-commitment gate), then link Todoist
     * ('label' | 'create' | 'project:<id>' | 'none') and optionally give it its own calendar. Returns the created projects.
     */
    r.post('/onboarding', async (c) => {
      const s = S();
      const item = z.object({
        key: z.string().optional(), name: z.string().min(1), status: z.enum(['core', 'maintain', 'pause', 'drop']), isSchool: z.boolean().optional(),
        color: z.string().optional(), icon: z.string().optional(), templateId: z.string().nullish(), maintenance: maintenance.nullish(), restartDate: date.nullish(),
        sizeMin: z.number().int().min(0).optional(), weeklyBudgetMin: z.number().int().min(0).optional(),
        link: z.string().default('none'), createCalendar: z.boolean().default(false),
      }).passthrough();
      const { items } = z.object({ items: z.array(item) }).parse(await c.req.json());
      const seeds = seedSuggestions(today());
      const prepared = items.map((it) => {
        const seed = seeds.find((x) => x.key === it.key);
        const tpl = it.templateId ? s.template(it.templateId) : null;
        const mt = it.status === 'maintain' ? it.maintenance ?? seed?.maintenance ?? tpl?.data.maintenance ?? null : null;
        if (it.status === 'maintain') {
          try { s.checkMaintenance(mt); } catch (e: any) { throw fail(`${it.name}: ${e.message}`, 400); }
        }
        const restartDate = it.status === 'pause' ? it.restartDate ?? seed?.restartDate ?? addDays(today(), DEFAULT_PAUSE_DAYS) : null;
        return { it, mt, restartDate, seed };
      });
      const out: any[] = [];
      for (const { it, mt, restartDate, seed } of prepared) {
        const existing = s.list().find((p) => !p.archived && p.name.toLowerCase() === it.name.trim().toLowerCase());
        if (existing) { out.push(existing); continue; }
        const created = s.create({
          name: it.name, status: it.status, isSchool: it.isSchool ?? seed?.isSchool, color: it.color ?? seed?.color, icon: it.icon ?? seed?.icon, templateId: it.templateId ?? seed?.templateId,
          sizeMin: it.sizeMin ?? seed?.sizeMin, weeklyBudgetMin: it.weeklyBudgetMin ?? seed?.weeklyBudgetMin, maintenance: mt, restartDate,
        }, { onboarding: true });
        const warnings: string[] = [];
        const label = async () => { await s.linkTodoist(created.id, { type: 'label', name: slugify(created.name) }); };
        try {
          if (it.link === 'label') await label();
          else if (it.link === 'create') {
            try {
              const done = await s.applyPlan(s.planTodoistCreate(created.id), 'onboarding');
              if (done.status === 'failed' || !s.get(created.id)?.todoist) await label();
            } catch (e: any) {
              if (e.code !== 'plan_limit') ctx.log.warn('todoist project create failed during onboarding', e.message);
              await label();
            }
          } else if (it.link.startsWith('project:')) await s.linkTodoist(created.id, { type: 'project', id: it.link.slice('project:'.length) });
        } catch (e: any) { warnings.push(`Todoist link: ${e.message}`); }
        if (it.createCalendar && it.status !== 'drop') {
          try { await s.ensureCalendar(created.id); } catch (e: any) { warnings.push(`Calendar: ${e.message}`); }
        }
        out.push({ ...s.get(created.id), ...(warnings.length ? { warnings } : {}) });
      }
      return c.json(out);
    });

    // ---- one project
    r.get('/:id', (c) => c.json(detail(c.req.param('id'))));
    r.patch('/:id', async (c) => c.json(S().update(c.req.param('id'), updateSchema.parse(await c.req.json()))));
    r.get('/:id/overview', (c) => c.json(S().overview(c.req.param('id'))));
    r.post('/:id/status', async (c) => {
      const b = z.object({
        status: z.enum(STATUSES), restartDate: date.nullish(), maintenance: maintenance.nullish(), mirrorPause: z.boolean().optional(),
        archiveTodoistProject: z.boolean().optional(), reason: z.string().optional(),
      }).parse(await c.req.json());
      return c.json(S().setStatus(c.req.param('id'), b.status, { ...b, restartDate: b.restartDate ?? undefined, maintenance: b.maintenance ?? undefined }));
    });
    r.post('/:id/activate', async (c) => {
      const b = z.object({ tradeOffId: z.string().nullable(), action: z.enum(['pause', 'drop']).optional(), restartDate: date.optional(), status: z.enum(['core', 'maintain']).optional(), maintenance: maintenance.optional() }).parse(await c.req.json());
      return c.json(S().activate(c.req.param('id'), b.tradeOffId, b));
    });
    r.put('/:id/notes', async (c) => {
      const { notes } = z.object({ notes: z.string() }).parse(await c.req.json());
      S().setNotes(c.req.param('id'), notes);
      return c.json({ ok: true });
    });
    r.get('/:id/notes', (c) => c.json({ notes: S().notes(c.req.param('id')) }));
    r.post('/:id/save-template', async (c) => {
      const b = z.object({ name: z.string().min(1), description: z.string().optional() }).parse(await c.req.json());
      return c.json(S().saveTemplate(c.req.param('id'), b.name, b.description));
    });

    // ---- tasks (the linked Todoist project or label)
    r.get('/:id/tasks', (c) => {
      const s = S();
      const p = s.get(c.req.param('id'));
      if (!p) throw fail('That project no longer exists.', 404);
      const sections = p.todoist?.type === 'project' && p.todoist.id ? ctx.service<any>('todoist').sections(p.todoist.id) : [];
      return c.json({ link: p.todoist, sections, tasks: s.tasksOf(p) });
    });
    r.post('/:id/tasks', async (c) => {
      const b = z.object({ content: z.string().min(1), sectionId: z.string().optional(), dueString: z.string().optional() }).parse(await c.req.json());
      return c.json({ id: await S().addTask(c.req.param('id'), b) });
    });
    r.post('/:id/tasks/:taskId/must-do', async (c) => {
      const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
      return c.json(await S().setMustDo(c.req.param('taskId'), on));
    });

    // ---- timeline, calendar, log
    r.get('/:id/timeline', (c) => c.json(S().timeline(c.req.param('id'), c.req.query('from') ?? undefined, c.req.query('to') ?? undefined)));
    r.get('/:id/calendar', (c) => {
      const start = c.req.query('start'), end = c.req.query('end');
      if (!start || !end) throw fail('start and end dates are required.');
      return c.json(S().calendar(c.req.param('id'), start, end, c.req.query('overlay') === '1'));
    });
    r.get('/:id/log', (c) => c.json(S().log(c.req.param('id'), c.req.query('from') ?? addDays(today(), -30), c.req.query('to') ?? today())));

    /** Every timeline write (drag, add, remove, sync). Without `confirm` it previews the change list; with it, applies one change set. */
    r.post('/:id/schedule', async (c) => {
      const { confirm, ...rest } = (await c.req.json()) as Record<string, unknown>;
      const op = scheduleSchema.parse(rest) as ScheduleOp;
      const s = S();
      const plan = s.planSchedule(c.req.param('id'), op);
      if (!confirm) return c.json({ preview: plan });
      return respond(c, await s.applyPlan(plan));
    });
    /** Onboarding and Claude: [{ title, date, kind }] → one change set of local milestones + calendar events (?review=1 leaves it pending). */
    r.post('/:id/milestones/bulk', async (c) => {
      const items = z.array(z.object({ title: z.string().min(1), date, kind: kindEnum.optional() })).min(1).parse(await c.req.json());
      const s = S();
      const plan = s.planSchedule(c.req.param('id'), { op: 'bulk_milestones', items });
      if (c.req.query('review') === '1') {
        const set = ctx.changes.propose({ source: 'onboarding', title: plan.title, summary: plan.summary, changes: plan.changes });
        return c.json(set);
      }
      return respond(c, await s.applyPlan(plan, 'onboarding'));
    });

    // ---- links
    r.get('/:id/todoist-options', (c) => c.json(S().todoistOptions(c.req.param('id'))));
    r.post('/:id/todoist', async (c) => {
      const b = z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('project'), projectId: z.string() }),
        z.object({ mode: z.literal('label'), name: z.string().min(1) }),
        z.object({ mode: z.literal('unlink') }),
        z.object({ mode: z.literal('create'), confirm: z.boolean().optional() }),
      ]).parse(await c.req.json());
      const s = S(), id = c.req.param('id');
      if (b.mode === 'project') return c.json(await s.linkTodoist(id, { type: 'project', id: b.projectId }));
      if (b.mode === 'label') return c.json(await s.linkTodoist(id, { type: 'label', name: b.name }));
      if (b.mode === 'unlink') return c.json(await s.linkTodoist(id, null));
      const plan = s.planTodoistCreate(id); // throws 409 plan_limit when the Free plan is full
      if (!b.confirm) return c.json({ preview: plan });
      const out = await s.applyPlan(plan);
      if (out.status === 'failed') return respond(c, out);
      return c.json({ changeSet: out, project: s.get(id) });
    });
    r.get('/:id/calendar-options', (c) => c.json(S().calendarOptions(c.req.param('id'))));
    r.post('/:id/calendar-link', async (c) => {
      const b = z.discriminatedUnion('mode', [z.object({ mode: z.literal('create') }), z.object({ mode: z.literal('link'), calendarId: z.string() })]).parse(await c.req.json());
      const s = S(), id = c.req.param('id');
      if (b.mode === 'create') { await s.ensureCalendar(id); return c.json(s.get(id)); }
      return c.json(s.linkCalendar(id, b.calendarId));
    });
  },
  rules: {
    conditions: [
      {
        id: 'projects.wip_exceeded',
        label: 'Too many non-school projects are Core',
        description: 'More non-school projects are Core than the work-in-progress limit allows.',
        params: z.object({}),
        evaluate: (ctx) => {
          const w = ctx.service<ProjectsService>('projects').wip();
          return { met: w.exceeded, detail: `${w.count} non-school projects are Core and the limit is ${w.limit}. Pause or drop one.` };
        },
      },
      {
        id: 'projects.over_budget',
        label: 'A project went over its weekly time budget',
        description: 'Time logged to a Core or Maintain project this week is above its budget.',
        params: z.object({}),
        evaluate: (ctx) => {
          const s = ctx.service<ProjectsService>('projects');
          const over = s.list().filter((p) => !p.archived && (p.status === 'core' || p.status === 'maintain')).map((p) => ({ p, sp: s.spent(p) })).filter((x) => x.sp.over);
          if (!over.length) return { met: false };
          const { p, sp } = over[0];
          const more = over.length > 1 ? ` and ${over.length - 1} more` : '';
          return { met: true, subject: p.id, detail: `${p.name} is at ${Math.round(sp.actualMin)} min against a ${sp.budgetMin} min weekly budget${more}.` };
        },
      },
    ],
  },
  claude: {
    context: (ctx) => {
      const s = ctx.service<ProjectsService>('projects');
      return { wip: s.wip(), projects: s.list().filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, status: p.status, isSchool: p.isSchool, restartDate: p.restartDate, sizeMin: p.sizeMin })) };
    },
    tools: [
      {
        name: 'list_projects',
        description: 'Project tabs with status, size, weekly budget vs actual, maintenance line, restart date and next milestone. Use before suggesting any change to commitments.',
        kind: 'read',
        input: z.object({ includeArchived: z.boolean().optional() }),
        run: (ctx, i) => {
          const s = ctx.service<ProjectsService>('projects');
          return s.list().filter((p) => i.includeArchived || !p.archived).map((p) => ({
            id: p.id, name: p.name, status: p.status, isSchool: p.isSchool, purpose: p.purpose, goal: p.goal, sizeMin: p.sizeMin, weeklyBudgetMin: p.weeklyBudgetMin,
            maintenance: p.maintenance, restartDate: p.restartDate, separation: p.separation, nextMilestone: s.nextMilestone(p.id),
            spentThisWeekMin: p.status === 'core' || p.status === 'maintain' ? s.spent(p).actualMin : null,
          }));
        },
      },
      {
        name: 'get_project',
        description: 'One project in detail: phases, milestones, open tasks (with carry counts), waiting-on items and this week’s time.',
        kind: 'read',
        input: z.object({ projectId: z.string() }),
        run: (ctx, i) => {
          const o = ctx.service<ProjectsService>('projects').overview(i.projectId);
          const s = ctx.service<ProjectsService>('projects');
          return {
            ...o, phases: s.phases(i.projectId), milestones: s.milestones(i.projectId),
            tasks: s.tasksOf(o.project).slice(0, 60).map((t) => ({ id: t.id, content: t.content, due: t.due?.date ?? null, estimateMin: t.estimateMin, carryCount: t.meta.carryCount, owner: t.meta.owner })),
          };
        },
      },
      {
        name: 'propose_project_changes',
        description: 'Propose project changes for review (never applied directly). action: set_status {projectId,status,restartDate?,maintenance?} · activate {projectId,tradeOffId,restartDate?} · update {projectId,purpose?,goal?,weeklyBudgetMin?,sizeMin?,separation?} · add_milestone {projectId,title,date,kind?} · move_milestone {milestoneId,date} · add_phase {projectId,title,start,end} · move_phase {phaseId,start,end}. Maintain needs maintenance {action,capMin,told}; Pause needs a restartDate; activating needs a tradeOffId of equal or larger size.',
        kind: 'propose',
        input: z.object({ changes: z.array(z.object({
          action: z.enum(['set_status', 'activate', 'update', 'add_milestone', 'move_milestone', 'add_phase', 'move_phase']),
          projectId: z.string().optional(), status: z.enum(STATUSES).optional(), restartDate: z.string().optional(), maintenance: maintenance.optional(), tradeOffId: z.string().optional(),
          purpose: z.string().optional(), goal: z.string().optional(), weeklyBudgetMin: z.number().optional(), sizeMin: z.number().optional(), separation: z.enum(SEPARATIONS).optional(),
          title: z.string().optional(), date: z.string().optional(), kind: kindEnum.optional(), milestoneId: z.string().optional(), phaseId: z.string().optional(), start: z.string().optional(), end: z.string().optional(),
        })) }),
        run: (ctx, i): ProposedChange[] => {
          const s = ctx.service<ProjectsService>('projects');
          const name = (id?: string) => `“${(id && s.get(id)?.name) || 'project'}”`;
          const out: ProposedChange[] = [];
          for (const ch of i.changes as any[]) {
            switch (ch.action) {
              case 'set_status':
                out.push({ kind: 'projects.status.set', title: `Set ${name(ch.projectId)} to ${ch.status}${ch.restartDate ? ` until ${ch.restartDate}` : ''}`, payload: { projectId: ch.projectId, status: ch.status, restartDate: ch.restartDate, maintenance: ch.maintenance, reason: 'Proposed by Claude' }, before: { status: s.get(ch.projectId)?.status } });
                break;
              case 'activate':
                out.push({ kind: 'projects.activate', title: `Activate ${name(ch.projectId)} by pausing ${name(ch.tradeOffId)}`, payload: { projectId: ch.projectId, tradeOffId: ch.tradeOffId, restartDate: ch.restartDate }, before: { status: 'proposed' } });
                break;
              case 'update': {
                const { action, projectId, ...patch } = ch;
                const keep = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && ['purpose', 'goal', 'weeklyBudgetMin', 'sizeMin', 'separation'].includes(k)));
                out.push({ kind: 'projects.update', title: `Edit ${name(projectId)}: ${Object.keys(keep).join(', ')}`, payload: { projectId, patch: keep }, before: Object.fromEntries(Object.keys(keep).map((k) => [k, (s.get(projectId) as any)?.[k]])) });
                break;
              }
              case 'add_milestone': out.push(...s.planSchedule(ch.projectId, { op: 'add_milestone', title: ch.title, date: ch.date, kind: ch.kind }).changes); break;
              case 'add_phase': out.push(...s.planSchedule(ch.projectId, { op: 'add_phase', title: ch.title, start: ch.start, end: ch.end }).changes); break;
              case 'move_milestone': {
                const row = ctx.db.get<{ project_id: string }>('SELECT project_id FROM project_milestones WHERE id = ?', ch.milestoneId);
                if (!row) throw new Error('Unknown milestone.');
                out.push(...s.planSchedule(row.project_id, { op: 'move_milestone', milestoneId: ch.milestoneId, date: ch.date }).changes);
                break;
              }
              case 'move_phase': {
                const row = ctx.db.get<{ project_id: string }>('SELECT project_id FROM project_phases WHERE id = ?', ch.phaseId);
                if (!row) throw new Error('Unknown phase.');
                out.push(...s.planSchedule(row.project_id, { op: 'move_phase', phaseId: ch.phaseId, start: ch.start, end: ch.end }).changes);
                break;
              }
            }
          }
          return out;
        },
      } satisfies ClaudeTool,
    ],
  },
});

