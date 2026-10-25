import { describe, it, expect } from 'vitest';
import { testApp, flush } from '../../tests/helpers';
import { uid } from '../../src/core/db';
import type { ProjectsService } from './manifest';
import type { TodoistService } from '../todoist/manifest';
import type { GoogleService } from '../google/manifest';
import { spanCols, xOf, widthOf, dragDays, dateAtX, ticks, PX_PER_DAY, packLanes } from './timeline';
import { BUILTIN_TEMPLATES, seedSuggestions } from './model';

const maint = { action: 'One 20-min owner check-in plus 30 min of decisions, Sundays', capMin: 50, told: 'Delphic owners' };

async function boot() {
  const app = await testApp({ at: '2026-10-26T16:00:00-04:00', only: ['day', 'todoist', 'google', 'projects', 'delegation'] });
  const svc = app.ctx.service<ProjectsService>('projects');
  const td = app.ctx.service<TodoistService>('todoist');
  const g = app.ctx.service<GoogleService>('google');
  await td.sync();
  await g.sync();
  const mk = (name: string, extra: Record<string, unknown> = {}) => svc.create({ name, status: 'core', sizeMin: 100, ...extra } as any, { onboarding: true });
  return { app, svc, td, g, mk };
}
/** Fire the bus handlers queued by changeset.applied. */
const settle = flush;

describe('projects: contract and CRUD', () => {
  it('creates proposed projects, lists, updates, reorders, keeps notes, and serves them over HTTP', async () => {
    const { app, svc } = await boot();
    const a = svc.create({ name: 'Research paper', status: 'core' as any, purpose: 'Publish' });
    expect(a.status).toBe('proposed'); // new commitments start proposed; a status can't be forced outside onboarding
    expect(a).toMatchObject({ name: 'Research paper', isSchool: false, archived: false, separation: 'milestones', calendarId: null, todoist: null });
    const b = svc.create({ name: 'Student org' });
    expect(svc.list().map((p) => p.name)).toEqual(['Research paper', 'Student org']);
    expect(svc.get(a.id)!.purpose).toBe('Publish');
    svc.update(a.id, { goal: 'Submit by Dec 1', weeklyBudgetMin: 180, color: '#34c759', icon: 'FlaskConical', separation: 'everything' });
    expect(svc.get(a.id)).toMatchObject({ goal: 'Submit by Dec 1', weeklyBudgetMin: 180, color: '#34c759', icon: 'FlaskConical', separation: 'everything' });
    svc.reorder([b.id, a.id]);
    expect(svc.list().map((p) => p.name)).toEqual(['Student org', 'Research paper']);
    svc.setNotes(a.id, '# Notes\n- read Smith 2020');
    expect(svc.notes(a.id)).toMatch(/Smith 2020/);
    const http = await app.req('GET', '/api/projects');
    expect(http.json.map((p: any) => p.name)).toEqual(['Student org', 'Research paper']);
    const one = await app.req('GET', `/api/projects/${a.id}`);
    expect(one.json).toMatchObject({ id: a.id, phases: [], milestones: [] });
    expect((await app.req('PATCH', `/api/projects/${a.id}`, { purpose: 'Learn to do research' })).json.purpose).toBe('Learn to do research');
    expect(svc.statusLog(a.id).map((s) => s.to)).toEqual(['proposed']);
  });

  it('projectForTask resolves by linked project then by label, and archived tabs lose to live ones', async () => {
    const { svc, td, mk } = await boot();
    const oneOff = td.projects().find((p) => p.name === 'One-off tasks')!;
    const a = mk('Linked by project');
    const b = mk('Linked by label');
    await svc.linkTodoist(a.id, { type: 'project', id: oneOff.id });
    await svc.linkTodoist(b.id, { type: 'label', name: 'delphic' });
    const id = await td.add({ content: 'Pick reviewers', labels: ['delphic'] });
    const t = td.task(id!)!; // in Inbox, labelled
    expect(svc.projectForTask(t)!.id).toBe(b.id);
    const inOneOff = td.tasks({ projectId: oneOff.id })[0];
    expect(svc.projectForTask(inOneOff)!.id).toBe(a.id);
    // The same Todoist project can't back two live tabs.
    const c = mk('Third');
    await expect(svc.linkTodoist(c.id, { type: 'project', id: oneOff.id })).rejects.toThrow(/already linked/);
  });

  it('save as template and create from a template with relative offsets', async () => {
    const { svc } = await boot();
    const tpl = BUILTIN_TEMPLATES.find((t) => t.id === 'research-paper')!;
    const p = svc.create({ name: 'Mito paper', templateId: tpl.id, startDate: '2026-10-26' });
    const phases = svc.phases(p.id);
    expect(phases).toHaveLength(4);
    expect(phases[0]).toMatchObject({ title: 'Literature review', start: '2026-10-26', end: '2026-11-15' });
    expect(svc.milestones(p.id).find((m) => m.kind === 'deadline')!.date).toBe('2027-02-03');
    const saved = svc.saveTemplate(p.id, 'My paper');
    expect(saved.builtin).toBe(false);
    expect(saved.data.phases[0]).toMatchObject({ startOffset: 0, endOffset: 20 });
    const q = svc.create({ name: 'Second paper', templateId: saved.id, startDate: '2027-01-04' });
    expect(svc.phases(q.id)[0]).toMatchObject({ start: '2027-01-04', end: '2027-01-24' });
    expect(svc.templates().map((t) => t.name)).toEqual(expect.arrayContaining(['Application cycle', 'Research paper', 'Student org', 'My paper']));
  });
});

describe('projects: separation rule (filterForMain)', () => {
  it('timed busy events always pass; milestones, phases and deadlines follow the project setting', async () => {
    const { svc, g, mk } = await boot();
    const p = mk('Delphic Medicine', { status: 'maintain', maintenance: maint });
    const cal = await svc.ensureCalendar(p.id);
    await g.createEvent(cal, { title: 'Owner check-in', start: '2026-10-27T16:00:00-04:00', end: '2026-10-27T16:20:00-04:00', busy: true, marginKind: 'session' });
    await g.createEvent(cal, { title: 'Issue due', start: '2026-10-27', end: '2026-10-28', allDay: true, marginKind: 'deadline', busy: false });
    await g.createEvent(cal, { title: 'Soft launch', start: '2026-10-27', end: '2026-10-28', allDay: true, marginKind: 'milestone', busy: false });
    await g.createEvent(cal, { title: 'Editing sprint', start: '2026-10-26', end: '2026-10-29', allDay: true, marginKind: 'phase', busy: false });
    const events = () => g.eventsBetween('2026-10-27T00:00:00-04:00', '2026-10-28T00:00:00-04:00');
    const titles = (sep: 'hidden' | 'milestones' | 'everything') => {
      svc.update(p.id, { separation: sep });
      return svc.filterForMain(events()).map((e) => e.title).sort();
    };
    expect(events().map((e) => e.title)).toEqual(expect.arrayContaining(['Owner check-in', 'Issue due', 'Soft launch', 'Editing sprint', 'Badminton']));
    expect(titles('hidden')).toEqual(['Badminton', 'Owner check-in'].sort());
    expect(titles('milestones')).toEqual(['Badminton', 'Issue due', 'Owner check-in', 'Soft launch'].sort()); // the default: no phases
    expect(titles('everything')).toEqual(['Badminton', 'Editing sprint', 'Issue due', 'Owner check-in', 'Soft launch'].sort());
  });

  it('day.timeline applies the rule', async () => {
    const { app, svc, g, mk } = await boot();
    const p = mk('Delphic Medicine', { status: 'maintain', maintenance: maint, separation: 'hidden' });
    const cal = await svc.ensureCalendar(p.id);
    await g.createEvent(cal, { title: 'Issue due', start: '2026-10-27', end: '2026-10-28', allDay: true, marginKind: 'deadline', busy: false });
    await g.createEvent(cal, { title: 'Owner check-in', start: '2026-10-27T16:00:00-04:00', end: '2026-10-27T16:20:00-04:00', busy: true, marginKind: 'session' });
    const titles = () => app.ctx.service<any>('day').timeline('2026-10-27').map((i: any) => i.title);
    expect(titles()).toContain('Owner check-in');
    expect(titles()).not.toContain('Issue due');
    svc.update(p.id, { separation: 'milestones' });
    expect(titles()).toContain('Issue due');
  });
});

describe('projects: statuses (SPEC 4.5)', () => {
  it('Maintain requires a maintenance line; Pause requires a restart date', async () => {
    const { svc } = await boot();
    const p = svc.create({ name: 'Red Cross' });
    await expect(async () => svc.setStatus(p.id, 'maintain')).rejects.toThrow(/smallest weekly action/);
    expect(() => svc.setStatus(p.id, 'maintain', { maintenance: { action: 'One event a month', capMin: 0, told: 'Officers' } })).toThrow(/minutes cap/);
    expect(() => svc.setStatus(p.id, 'maintain', { maintenance: { action: 'One event a month', capMin: 120, told: '' } })).toThrow(/who has been told/);
    expect(svc.get(p.id)!.status).toBe('proposed');
    const m = svc.setStatus(p.id, 'maintain', { maintenance: { action: 'One event a month', capMin: 120, told: 'Officers' } });
    expect(m).toMatchObject({ status: 'maintain', maintenance: { capMin: 120, told: 'Officers' } });
    expect(() => svc.setStatus(p.id, 'pause')).toThrow(/restart date/);
    expect(() => svc.setStatus(p.id, 'pause', { restartDate: '2026-10-20' })).toThrow(/restart date/);
    const paused = svc.setStatus(p.id, 'pause', { restartDate: '2027-01-04' });
    expect(paused).toMatchObject({ status: 'pause', restartDate: '2027-01-04' });
    expect(svc.restartDue('2027-01-03')).toHaveLength(0);
    expect(svc.restartDue('2027-01-04').map((x) => x.id)).toEqual([p.id]);
    expect(svc.statusLog(p.id).map((s) => `${s.from}>${s.to}`)).toEqual(['maintain>pause', 'proposed>maintain', 'null>proposed']);
  });

  it('School stays Core', async () => {
    const { svc, mk } = await boot();
    const s = mk('School', { isSchool: true });
    expect(() => svc.setStatus(s.id, 'pause', { restartDate: '2027-01-04' })).toThrow(/School stays Core/);
    expect(() => svc.setStatus(s.id, 'drop')).toThrow(/School stays Core/);
  });

  it('Pause hides the project’s tasks from Today and planning (isHidden), without touching Todoist', async () => {
    const { svc, td, mk } = await boot();
    const p = mk('Delphic Medicine');
    await svc.linkTodoist(p.id, { type: 'label', name: 'delphic' });
    const id = (await td.add({ content: 'Assign reviewers', labels: ['delphic'], dueDate: '2026-10-28' }))!;
    const other = (await td.add({ content: 'Unrelated plain task' }))!;
    expect(svc.isHidden(td.task(id)!)).toBe(false);
    svc.setStatus(p.id, 'pause', { restartDate: '2027-01-04' });
    expect(svc.isHidden(td.task(id)!)).toBe(true);
    expect(svc.isHidden(td.task(other)!)).toBe(false); // plain Todoist lists still show in Today
    expect(td.task(id)!.checked).toBe(false); // never deleted or closed
    svc.setStatus(p.id, 'core');
    expect(svc.isHidden(td.task(id)!)).toBe(false);
  });

  it('Pause can mirror a “paused” label through a change set, and resuming proposes removing it', async () => {
    const { app, svc, td, mk } = await boot();
    const p = mk('Delphic Medicine');
    await svc.linkTodoist(p.id, { type: 'label', name: 'delphic' });
    const id = (await td.add({ content: 'Assign reviewers', labels: ['delphic'] }))!;
    const out = svc.setStatus(p.id, 'pause', { restartDate: '2027-01-04', mirrorPause: true });
    expect(out.changeSetId).toBeTruthy();
    const set = app.ctx.changes.get(out.changeSetId!)!;
    expect(set.changes.map((c) => c.kind)).toEqual(['todoist.task.label']);
    await app.ctx.changes.apply(set.id);
    expect(td.task(id)!.labels).toContain('paused');
    const back = svc.setStatus(p.id, 'core');
    const undo = app.ctx.changes.get(back.changeSetId!)!;
    expect(undo.changes.map((c) => c.kind)).toEqual(['projects.task.unlabel']);
    await app.ctx.changes.apply(undo.id);
    expect(td.task(id)!.labels).not.toContain('paused');
  });

  it('Drop archives the tab, keeps its data, and closes tasks through ONE change set of drops (never deletes)', async () => {
    const { app, svc, td, mk } = await boot();
    const oneOff = td.projects().find((p) => p.name === 'One-off tasks')!;
    const p = mk('Side project');
    svc.addMilestone({ projectId: p.id, title: 'Demo', date: '2026-12-01' });
    svc.setNotes(p.id, 'keep these');
    await svc.linkTodoist(p.id, { type: 'project', id: oneOff.id });
    const open = td.tasks({ projectId: oneOff.id });
    expect(open.length).toBeGreaterThan(0);
    const before = app.ctx.changes.list().length;
    const out = svc.setStatus(p.id, 'drop', { archiveTodoistProject: true });
    expect(out).toMatchObject({ status: 'drop', archived: true });
    expect(app.ctx.changes.list().length).toBe(before + 1); // exactly one new change set
    const set = app.ctx.changes.get(out.changeSetId!)!;
    expect(new Set(set.changes.map((c) => c.kind))).toEqual(new Set(['todoist.task.drop', 'todoist.project.archive']));
    expect(set.changes.filter((c) => c.kind === 'todoist.task.drop')).toHaveLength(open.length);
    expect(set.changes.some((c) => /delete/i.test(c.kind))).toBe(false);
    expect(svc.milestones(p.id)).toHaveLength(1); // data kept
    expect(svc.notes(p.id)).toBe('keep these');
    const applied = await app.ctx.changes.apply(set.id);
    expect(applied.status).toBe('applied');
    expect(td.tasks({ projectId: oneOff.id })).toHaveLength(0);
    expect(svc.get(p.id)!.archived).toBe(true);
    expect(svc.isHidden({ projectId: oneOff.id, labels: [] })).toBe(true);
  });

  it('there is no applier that deletes anything', async () => {
    const { app } = await boot();
    expect(app.ctx.changes.kinds().filter((k) => k.kind.startsWith('projects.')).map((k) => k.kind).some((k) => /delete/.test(k))).toBe(false);
  });
});

describe('projects: WIP limit and “yes requires a no”', () => {
  it('counts Core non-school projects; a third Core is refused; the wip_exceeded rule reports forced overages', async () => {
    const { app, svc, mk } = await boot();
    mk('School', { isSchool: true });
    const a = mk('Applications');
    const b = mk('Delphic Medicine');
    expect(svc.activeNonSchool().map((p) => p.name)).toEqual(['Applications', 'Delphic Medicine']);
    expect(svc.wip()).toMatchObject({ limit: 2, count: 2, exceeded: false, full: true });
    const c = svc.create({ name: 'Third thing' });
    expect(() => svc.setStatus(c.id, 'core')).toThrow(/Work-in-progress limit/);
    expect(svc.setStatus(c.id, 'maintain', { maintenance: maint }).status).toBe('maintain'); // Maintain doesn't count
    const cond = app.ctx.rules.catalog().conditions.find((x) => x.id === 'projects.wip_exceeded')!;
    expect(cond.available).toBe(true);
    const manifest = (await import('./manifest')).default;
    const wipRule = manifest.rules!.conditions!.find((x) => x.id === 'projects.wip_exceeded')!;
    expect((await wipRule.evaluate(app.ctx, {})).met).toBe(false);
    mk('Forced third'); // onboarding may exceed; the meter and the rule say so
    expect(svc.wip().exceeded).toBe(true);
    expect((await wipRule.evaluate(app.ctx, {})).detail).toMatch(/3 non-school projects are Core and the limit is 2/);
    expect([a.id, b.id]).toHaveLength(2);
  });

  it('a new commitment is Proposed and activates only by pausing or dropping something of equal or larger size', async () => {
    const { app, svc, mk } = await boot();
    const big = mk('Applications', { sizeMin: 300 });
    const small = mk('Red Cross', { sizeMin: 60 });
    const idea = svc.create({ name: 'Podcast', sizeMin: 200 });
    expect(idea.status).toBe('proposed');
    expect(() => svc.activate(idea.id, null)).toThrow(/Yes requires a no/);
    expect(() => svc.activate(idea.id, small.id)).toThrow(/equal or larger size/);
    expect(svc.get(idea.id)!.status).toBe('proposed');
    const out = svc.activate(idea.id, big.id, { restartDate: '2027-01-11' });
    expect(out.status).toBe('core');
    expect(svc.get(big.id)).toMatchObject({ status: 'pause', restartDate: '2027-01-11' });
    expect(svc.get(small.id)!.status).toBe('core');
    expect(svc.activeNonSchool().map((p) => p.name).sort()).toEqual(['Podcast', 'Red Cross']);
    expect(svc.statusLog(idea.id)[0].note).toMatch(/paused “Applications”/);
    // trading by drop produces the drop change set
    const another = svc.create({ name: 'Newsletter', sizeMin: 50 });
    const via = svc.activate(another.id, small.id, { action: 'drop' });
    expect(svc.get(small.id)!.archived).toBe(true);
    expect(via.status).toBe('core');
    // a project can't be activated twice, and School can't be traded away
    expect(() => svc.activate(another.id, null)).toThrow(/Only a proposed project/);
    const school = mk('School', { isSchool: true });
    const next = svc.create({ name: 'Zine', sizeMin: 0 });
    expect(() => svc.activate(next.id, school.id)).toThrow(/non-school/);
    expect(app.ctx.changes.list('pending').length).toBeGreaterThanOrEqual(0);
  });

  it('proposed projects can be activated over HTTP, and the error names the problem', async () => {
    const { app, svc, mk } = await boot();
    const a = mk('Applications', { sizeMin: 300 });
    const idea = svc.create({ name: 'Podcast', sizeMin: 200 });
    const bad = await app.req('POST', `/api/projects/${idea.id}/activate`, { tradeOffId: null });
    expect(bad.status).toBe(409);
    expect(bad.json.error).toMatch(/Yes requires a no/);
    const ok = await app.req('POST', `/api/projects/${idea.id}/activate`, { tradeOffId: a.id, restartDate: '2027-01-11' });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('core');
  });
});

describe('projects: adding is locked by rules and recovery phase', () => {
  it('lock_add_projects blocks creation and activation; onboarding bypasses it', async () => {
    const { app, svc, mk } = await boot();
    const a = mk('Applications', { sizeMin: 300 });
    const idea = svc.create({ name: 'Idea', sizeMin: 100 });
    app.ctx.db.run('INSERT INTO rule_firings (id, rule_id, fired_at, detail, actions) VALUES (?, ?, ?, ?, ?)', uid(), 'low-sleep', '2026-10-26T08:00:00-04:00', 'Under 7 hours of sleep 3 nights in a row.', JSON.stringify(['banner', 'lock_add_projects']));
    expect(svc.canAdd()).toMatchObject({ allowed: false });
    expect(svc.canAdd().reason).toMatch(/Under 7 hours of sleep/);
    expect(() => svc.create({ name: 'Another' })).toThrow(/Adding projects is locked/);
    expect(() => svc.activate(idea.id, a.id)).toThrow(/locked/);
    const http = await app.req('POST', '/api/projects', { name: 'Via HTTP' });
    expect(http.status).toBe(409);
    expect(http.json.error).toMatch(/locked/);
    expect(svc.create({ name: 'Onboarding one', status: 'core' as any }, { onboarding: true }).status).toBe('core');
    expect(svc.list().map((p) => p.name)).not.toContain('Another');
  });

  it('a phase that disallows new commitments blocks creation and shows its reason', async () => {
    const { app, svc } = await boot();
    const real = app.ctx.maybe.bind(app.ctx);
    (app.ctx as any).maybe = (id: string) => (id === 'phases' ? { canAddCommitment: () => ({ allowed: false, reason: 'Stabilize phase: nothing gets added back before Rebuild.' }) } : real(id));
    expect(() => svc.create({ name: 'Nope' })).toThrow(/Stabilize phase/);
    expect(svc.canAdd({ onboarding: true }).allowed).toBe(true);
  });
});

describe('projects: Todoist and Google links', () => {
  it('creates the project calendar idempotently and puts phases and milestones on it as all-day events', async () => {
    const { app, svc, g, mk } = await boot();
    const p = svc.create({ name: 'Summer 2027 applications', templateId: 'application-cycle', startDate: '2026-10-26' });
    const before = g.calendars().length;
    const id1 = await svc.ensureCalendar(p.id);
    const id2 = await svc.ensureCalendar(p.id);
    expect(id1).toBe(id2);
    expect(g.calendars().length).toBe(before + 1);
    expect(g.calendars().find((c) => c.id === id1)).toMatchObject({ summary: 'Project · Summer 2027 applications', appKind: 'project', appRef: p.id });
    expect(svc.get(p.id)!.calendarId).toBe(id1);

    const set = await svc.schedule(p.id, { op: 'sync_calendar' });
    expect(set.status).toBe('applied');
    expect(set.changes.every((c) => c.kind === 'gcal.event.create')).toBe(true);
    await g.sync();
    const events = g.eventsBetween('2026-10-01T00:00:00-04:00', '2027-06-01T00:00:00-04:00', { calendarIds: [id1] });
    const phases = svc.phases(p.id), ms = svc.milestones(p.id);
    expect(events).toHaveLength(phases.length + ms.length);
    expect(events.every((e) => e.allDay && e.appOwned && e.projectId === p.id)).toBe(true);
    const research = events.find((e) => e.title === 'Research and shortlist')!;
    expect(research).toMatchObject({ marginKind: 'phase', start: '2026-10-26', end: '2026-11-09' }); // end is exclusive
    expect(events.find((e) => e.title === 'Applications due')!.marginKind).toBe('deadline');
    expect(events.find((e) => e.title === 'Shortlist final')!.marginKind).toBe('milestone');
    await settle();
    // local rows are paired with their events, so a second sync adds nothing
    expect(svc.phases(p.id).every((x) => !!x.gcalEventId)).toBe(true);
    expect(svc.milestones(p.id).every((x) => !!x.gcalEventId)).toBe(true);
    expect(svc.planSchedule(p.id, { op: 'sync_calendar' }).changes).toHaveLength(0);
    // main calendar shows deadlines and milestones but not phases (default separation)
    const main = svc.filterForMain(g.eventsBetween('2026-10-01T00:00:00-04:00', '2027-06-01T00:00:00-04:00')).filter((e) => e.calendarId === id1);
    expect(main.some((e) => e.marginKind === 'phase')).toBe(false);
    expect(main.some((e) => e.marginKind === 'deadline')).toBe(true);
    void app; void mk;
  });

  it('links an existing calendar instead of creating one', async () => {
    const { svc, g, mk } = await boot();
    const p = mk('Hunter Red Cross Club', { status: 'maintain', maintenance: maint });
    const hunter = g.calendars().find((c) => c.summary === 'Hunter College HS')!;
    expect(svc.linkCalendar(p.id, hunter.id).calendarId).toBe(hunter.id);
    const q = mk('Another');
    expect(() => svc.linkCalendar(q.id, hunter.id)).toThrow(/already belongs/);
    expect(() => svc.linkCalendar(q.id, 'nope')).toThrow(/isn’t in the last sync/);
  });

  it('creates a Todoist project through a todoist.project.add change and links it; on the Free-plan cap it offers a label instead', async () => {
    const { app, svc, td, mk } = await boot();
    expect(td.status().plan!.projectsLeft).toBe(2);
    const a = mk('Alpha'), b = mk('Beta'), c = mk('Gamma');
    for (const p of [a, b]) {
      const plan = svc.planTodoistCreate(p.id);
      expect(plan.changes.map((x) => x.kind)).toEqual(['todoist.project.add']);
      const out = await svc.applyPlan(plan);
      expect(out.status).toBe('applied');
      expect(svc.get(p.id)!.todoist).toMatchObject({ type: 'project', name: p.name });
    }
    await td.sync();
    expect(td.status().plan!.projectsLeft).toBe(0);
    expect(td.projects().map((x) => x.name)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
    // Free plan full: the plan is refused with an explanation, and the label link works.
    let err: any;
    try { svc.planTodoistCreate(c.id); } catch (e) { err = e; }
    expect(err.code).toBe('plan_limit');
    expect(err.message).toMatch(/Link “Gamma” to a label instead/);
    const http = await app.req('POST', `/api/projects/${c.id}/todoist`, { mode: 'create', confirm: true });
    expect(http.status).toBe(409);
    expect(http.json.error).toMatch(/label/);
    const opts = (await app.req('GET', `/api/projects/${c.id}/todoist-options`)).json;
    expect(opts).toMatchObject({ planLimited: true, projectsLeft: 0, suggestedLabel: 'gamma' });
    const linked = (await app.req('POST', `/api/projects/${c.id}/todoist`, { mode: 'label', name: opts.suggestedLabel })).json;
    expect(linked.todoist).toMatchObject({ type: 'label', name: 'gamma' });
    expect(td.labels().map((l) => l.name)).toContain('gamma');
    const taskId = (await svc.addTask(c.id, { content: 'First Gamma task' }))!;
    expect(td.task(taskId)!.labels).toEqual(['gamma']);
    expect(svc.tasksOf(svc.get(c.id)!).map((t) => t.content)).toEqual(['First Gamma task']);
  });
});

describe('projects: timeline scheduling writes back through one confirmed change set', () => {
  it('dragging a milestone and a phase updates local rows and the project calendar; a task goes to Todoist', async () => {
    const { app, svc, td, g } = await boot();
    const p = svc.create({ name: 'Research paper', templateId: 'research-paper', startDate: '2026-10-26' });
    await svc.ensureCalendar(p.id);
    await svc.schedule(p.id, { op: 'sync_calendar' });
    const outline = svc.milestones(p.id).find((m) => m.title === 'Outline approved')!; // 2026-11-15
    // preview first: nothing is written
    const prev = (await app.req('POST', `/api/projects/${p.id}/schedule`, { op: 'move_milestone', milestoneId: outline.id, date: '2026-11-02' })).json.preview;
    expect(prev.changes.map((c: any) => c.kind)).toEqual(['projects.milestone.update', 'gcal.event.update']);
    expect(svc.milestones(p.id).find((m) => m.id === outline.id)!.date).toBe('2026-11-15');
    const done = await app.req('POST', `/api/projects/${p.id}/schedule`, { op: 'move_milestone', milestoneId: outline.id, date: '2026-11-02', confirm: true });
    expect(done.status).toBe(200);
    expect(done.json.status).toBe('applied');
    expect(svc.milestones(p.id).find((m) => m.id === outline.id)!.date).toBe('2026-11-02');
    const ev = g.eventsBetween('2026-11-01T00:00:00-05:00', '2026-11-04T00:00:00-05:00', { calendarIds: [svc.get(p.id)!.calendarId!] }).find((e) => e.title === 'Outline approved')!;
    expect(ev).toMatchObject({ start: '2026-11-02', end: '2026-11-03', allDay: true });
    // phase: move across the fall-back weekend
    const lit = svc.phases(p.id)[0];
    const moved = await svc.schedule(p.id, { op: 'move_phase', phaseId: lit.id, start: '2026-10-30', end: '2026-11-03' });
    expect(moved.status).toBe('applied');
    expect(svc.phases(p.id)[0]).toMatchObject({ start: '2026-10-30', end: '2026-11-03' });
    const pev = g.eventsBetween('2026-10-29T00:00:00-04:00', '2026-11-05T00:00:00-05:00', { calendarIds: [svc.get(p.id)!.calendarId!] }).find((e) => e.title === 'Literature review')!;
    expect(pev).toMatchObject({ start: '2026-10-30', end: '2026-11-04' });
    // task: the todoist reschedule change
    const task = td.tasks({ dueOnOrBefore: '2026-12-31' })[0];
    const tp = svc.planSchedule(p.id, { op: 'move_task', taskId: task.id, date: '2026-11-02' });
    expect(tp.changes.map((c) => c.kind)).toEqual(['todoist.task.reschedule']);
    await svc.applyPlan(tp);
    expect(td.task(task.id)!.due!.date).toBe('2026-11-02');
    // one change set per drag
    expect(app.ctx.changes.list().filter((s) => s.title.startsWith('Move')).length).toBe(3);
  });

  it('adds and removes timeline items, with and without the calendar', async () => {
    const { svc, g } = await boot();
    const p = svc.create({ name: 'Zine' });
    const local = await svc.schedule(p.id, { op: 'add_milestone', title: 'Print', date: '2026-12-01' });
    expect(local.changes.map((c) => c.kind)).toEqual(['projects.milestone.add']); // no calendar yet: local only
    await svc.ensureCalendar(p.id);
    const both = await svc.schedule(p.id, { op: 'add_phase', title: 'Layout', start: '2026-11-01', end: '2026-11-07' });
    expect(both.changes.map((c) => c.kind)).toEqual(['projects.phase.add', 'gcal.event.create']);
    await settle();
    expect(svc.phases(p.id)[0].gcalEventId).toBeTruthy();
    const rm = await svc.schedule(p.id, { op: 'remove_item', type: 'phase', id: svc.phases(p.id)[0].id });
    expect(rm.changes.map((c) => c.kind)).toEqual(['projects.item.remove', 'gcal.event.delete']);
    expect(svc.phases(p.id)).toHaveLength(0);
    await g.sync();
    expect(g.eventsBetween('2026-10-30T00:00:00-04:00', '2026-11-10T00:00:00-05:00', { calendarIds: [svc.get(p.id)!.calendarId!] })).toHaveLength(0);
  });

  it('maps dates to day columns by whole days across Nov 1 2026: Oct 30 – Nov 3 is exactly 5 columns', () => {
    expect(spanCols('2026-10-26', '2026-10-30', '2026-11-03')).toEqual({ col: 4, span: 5 });
    expect(spanCols('2026-10-26', '2026-11-01', '2026-11-01')).toEqual({ col: 6, span: 1 });
    for (const zoom of ['week', 'month', 'quarter', 'semester'] as const) {
      const px = PX_PER_DAY[zoom];
      expect(widthOf('2026-10-30', '2026-11-03', px)).toBe(5 * px);
      expect(xOf('2026-10-26', '2026-11-02', px) - xOf('2026-10-26', '2026-10-31', px)).toBe(2 * px); // not 49 hours / 2 days + 1 hour
      expect(xOf('2026-10-26', '2026-11-02', px)).toBe(7 * px);
    }
    expect(dateAtX('2026-10-26', 6 * 30 + 12, 30)).toBe('2026-11-01');
    expect(dateAtX('2026-10-26', 7 * 30, 30)).toBe('2026-11-02');
    expect(dragDays(44, 30)).toBe(1);
    expect(dragDays(-46, 30)).toBe(-2);
    const days = ticks('2026-10-26', 14, 'week').map((t) => t.label);
    expect(days.slice(5, 9)).toEqual(['Sat 31', 'Sun 1', 'Mon 2', 'Tue 3']); // the fall-back Sunday is one column
    expect(packLanes([{ start: '2026-10-30', end: '2026-11-03' }, { start: '2026-11-01', end: '2026-11-05' }, { start: '2026-11-06', end: '2026-11-07' }]).map((x) => x.lane)).toEqual([0, 1, 0]);
  });

  it('serves the timeline view: phases, milestones, dated tasks and sessions', async () => {
    const { app, svc, td, g } = await boot();
    const p = svc.create({ name: 'Delphic Medicine' });
    await svc.linkTodoist(p.id, { type: 'label', name: 'delphic' });
    await svc.schedule(p.id, { op: 'add_phase', title: 'Issue 4', start: '2026-10-30', end: '2026-11-03' });
    await svc.schedule(p.id, { op: 'add_milestone', title: 'Issue 4 out', date: '2026-11-03', kind: 'deadline' });
    await td.add({ content: 'Assign reviewers', labels: ['delphic'], dueDate: '2026-10-29' });
    await td.add({ content: 'Undated', labels: ['delphic'] });
    const cal = await svc.ensureCalendar(p.id);
    await g.createEvent(cal, { title: 'Owner check-in', start: '2026-10-28T16:00:00-04:00', end: '2026-10-28T16:20:00-04:00', busy: true, marginKind: 'session' });
    const r = (await app.req('GET', `/api/projects/${p.id}/timeline`)).json;
    expect(r.phases[0]).toMatchObject({ title: 'Issue 4', start: '2026-10-30', end: '2026-11-03' });
    expect(r.milestones[0]).toMatchObject({ title: 'Issue 4 out', kind: 'deadline' });
    expect(r.tasks.map((t: any) => t.content)).toEqual(['Assign reviewers']);
    expect(r.sessions.map((s: any) => s.title)).toEqual(['Owner check-in']);
    expect(r.today).toBe('2026-10-26');
  });
});

describe('projects: views', () => {
  it('overview: budget vs actual from project-calendar events (clipped to now), next milestone, open loops, carry hotspots; over_budget rule', async () => {
    const { app, svc, td, g, mk } = await boot();
    const p = mk('Delphic Medicine', { status: 'maintain', maintenance: maint, weeklyBudgetMin: 30 });
    await svc.linkTodoist(p.id, { type: 'label', name: 'delphic' });
    const cal = await svc.ensureCalendar(p.id);
    // Monday Oct 26, "now" is 4:00 PM. One finished hour and one meeting still ahead.
    await g.createEvent(cal, { title: 'Owner sync', start: '2026-10-26T13:00:00-04:00', end: '2026-10-26T14:00:00-04:00', busy: true, marginKind: 'session' });
    await g.createEvent(cal, { title: 'Later', start: '2026-10-26T18:00:00-04:00', end: '2026-10-26T19:00:00-04:00', busy: true, marginKind: 'session' });
    const id = (await td.add({ content: 'Reviewer emails', labels: ['delphic'], dueDate: '2026-10-25' }))!;
    td.setMeta(id, { carryCount: 2 });
    await td.add({ content: 'Fine task', labels: ['delphic'] });
    await svc.schedule(p.id, { op: 'add_milestone', title: 'Issue out', date: '2026-10-30', kind: 'deadline' });
    const dl = svc.deadlines('2026-10-26', '2026-11-30');
    expect(dl).toEqual([{ projectId: p.id, projectName: 'Delphic Medicine', title: 'Issue out', date: '2026-10-30', kind: 'deadline' }]);
    const o = (await app.req('GET', `/api/projects/${p.id}/overview`)).json;
    expect(o.budget).toMatchObject({ from: '2026-10-25', to: '2026-10-31', eventMin: 60, focusMin: 0, actualMin: 60, budgetMin: 30, over: true });
    expect(o.nextMilestone).toMatchObject({ title: 'Issue out', daysAway: 4 });
    expect(o.openLoops).toMatchObject({ openTasks: 2, overdue: 1 });
    expect(o.hotspots.map((h: any) => h.content)).toEqual(['Reviewer emails']);
    const rule = (await import('./manifest')).default.rules!.conditions!.find((c) => c.id === 'projects.over_budget')!;
    const res = await rule.evaluate(app.ctx, {});
    expect(res.met).toBe(true);
    expect(res.detail).toMatch(/Delphic Medicine is at 60 min against a 30 min weekly budget/);
    // paused projects drop out of deadlines
    svc.setStatus(p.id, 'pause', { restartDate: '2027-01-04' });
    expect(svc.deadlines('2026-10-26', '2026-11-30')).toEqual([]);
  });

  it('tasks, must-do toggle, calendar view with optional main overlay, and the log', async () => {
    const { app, svc, td, g, mk } = await boot();
    const p = mk('Delphic Medicine');
    await svc.linkTodoist(p.id, { type: 'label', name: 'delphic' });
    const id = await svc.addTask(p.id, { content: 'Draft call for papers', dueString: '2026-10-28' });
    const tasks = (await app.req('GET', `/api/projects/${p.id}/tasks`)).json;
    expect(tasks.tasks.map((t: any) => t.content)).toEqual(['Draft call for papers']);
    const md = await app.req('POST', `/api/projects/${p.id}/tasks/${id}/must-do`, { on: true });
    expect(md.json).toMatchObject({ on: true, optional: false });
    expect(td.task(id!)!.meta.mustDoDate).toBe('2026-10-26');
    expect(td.task(id!)!.labels).toEqual(expect.arrayContaining(['delphic', 'must-do']));
    await app.req('POST', `/api/projects/${p.id}/tasks/${id}/must-do`, { on: false });
    expect(td.task(id!)!.labels).not.toContain('must-do');
    const cal = await svc.ensureCalendar(p.id);
    await g.createEvent(cal, { title: 'Owner sync', start: '2026-10-28T15:00:00-04:00', end: '2026-10-28T15:30:00-04:00', busy: true, marginKind: 'session' });
    const q = '/api/projects/' + p.id + '/calendar?start=2026-10-26&end=2026-11-02';
    const off = (await app.req('GET', q)).json;
    expect(off.events.map((e: any) => e.title)).toEqual(['Owner sync']);
    expect(off.overlay).toEqual([]);
    expect(off.tasks.map((t: any) => t.content)).toEqual(['Draft call for papers']);
    const on = (await app.req('GET', q + '&overlay=1')).json;
    expect(on.overlay.map((e: any) => e.title)).toContain('Badminton');
    expect(on.overlay.some((e: any) => e.title === 'Owner sync')).toBe(false);
    await svc.setMustDo(id!, false);
    await td.close(id!);
    const log = (await app.req('GET', `/api/projects/${p.id}/log?from=2026-10-01&to=2026-10-31`)).json;
    expect(log.completions.map((c: any) => c.content)).toEqual(['Draft call for papers']);
    expect(log.statusLog[0].to).toBe('core');
  });
});

describe('projects: onboarding helpers', () => {
  it('seed suggestions follow SPEC 5', () => {
    const seeds = seedSuggestions('2026-10-26');
    const by = (k: string) => seeds.find((s) => s.key === k)!;
    expect(by('school')).toMatchObject({ status: 'core', isSchool: true });
    expect(by('applications')).toMatchObject({ status: 'core', templateId: 'application-cycle' });
    expect(by('delphic')).toMatchObject({ status: 'maintain', maintenance: { action: 'One 20-min owner check-in plus 30 min of decisions, Sundays.' } });
    expect(by('red-cross').maintenance!.action).toMatch(/batched into one event a month/);
    expect(by('waypoint').status).toBe('pause');
    expect(seeds.filter((s) => ['serene', 'toxreadout', 'localflow', 'blender-web', 'margin'].includes(s.key)).every((s) => s.status === 'pause')).toBe(true);
    for (const s of seeds) expect(s).toMatchObject({ name: expect.any(String), color: expect.stringMatching(/^#/), icon: expect.any(String), isSchool: expect.any(Boolean) });
    for (const s of seeds.filter((x) => x.status === 'pause')) expect(s.restartDate! > '2026-10-26').toBe(true);
  });

  it('GET /seed-suggestions and POST /onboarding create projects with links and calendars', async () => {
    const { app, svc, td, g } = await boot();
    const seeds = (await app.req('GET', '/api/projects/seed-suggestions')).json as any[];
    expect(seeds.length).toBeGreaterThanOrEqual(8);
    const pick = (key: string, extra: Record<string, unknown>) => ({ ...seeds.find((s) => s.key === key), include: true, createCalendar: false, link: 'none', ...extra });
    const items = [
      pick('school', { link: 'none' }),
      pick('applications', { link: 'create', createCalendar: true }),
      pick('delphic', { link: 'create', createCalendar: true, maintenance: undefined }), // no explicit line → the seed's suggested line
      pick('red-cross', { link: 'label' }), // Free plan is now full → label
      pick('waypoint', { link: 'label', createCalendar: true }),
    ];
    const r = await app.req('POST', '/api/projects/onboarding', { items });
    expect(r.status).toBe(200);
    const made = r.json as any[];
    expect(made.map((p) => p.name)).toEqual(['School', 'Summer 2027 applications', 'Delphic Medicine', 'Hunter Red Cross Club', 'WaypointNYC']);
    const by = (n: string) => made.find((p) => p.name === n);
    expect(by('School')).toMatchObject({ status: 'core', isSchool: true, todoist: null });
    expect(by('Summer 2027 applications')).toMatchObject({ status: 'core', todoist: { type: 'project', name: 'Summer 2027 applications' } });
    expect(by('Summer 2027 applications').calendarId).toBeTruthy();
    expect(svc.phases(by('Summer 2027 applications').id)).toHaveLength(5); // template applied
    expect(by('Delphic Medicine')).toMatchObject({ status: 'maintain', maintenance: { capMin: 50 }, todoist: { type: 'project' } });
    expect(by('Delphic Medicine').maintenance.action).toMatch(/20-min owner check-in/);
    expect(by('Hunter Red Cross Club').todoist).toMatchObject({ type: 'label', name: 'hunter-red-cross-club' }); // Free-plan cap → label
    expect(by('WaypointNYC')).toMatchObject({ status: 'pause', restartDate: '2026-12-25', todoist: { type: 'label', name: 'waypointnyc' } });
    expect(g.calendars().filter((c) => c.appKind === 'project').map((c) => c.summary).sort()).toEqual(['Project · Delphic Medicine', 'Project · Summer 2027 applications', 'Project · WaypointNYC']);
    expect(td.labels().map((l) => l.name)).toEqual(expect.arrayContaining(['hunter-red-cross-club', 'waypointnyc']));
    // running it again does not duplicate tabs
    const again = await app.req('POST', '/api/projects/onboarding', { items });
    expect(again.json).toHaveLength(5);
    expect(svc.list()).toHaveLength(5);
  });

  it('onboarding rejects a Maintain item that has no line anywhere, before creating anything', async () => {
    const { app, svc } = await boot();
    const r = await app.req('POST', '/api/projects/onboarding', { items: [{ name: 'School', status: 'core', isSchool: true }, { name: 'Mystery', status: 'maintain' }] });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Mystery/);
    expect(svc.list()).toHaveLength(0);
  });

  it('bulk milestones create local milestones and calendar events in one change set', async () => {
    const { app, svc, g } = await boot();
    const p = svc.create({ name: 'Summer 2027 applications' }, { onboarding: true });
    await svc.ensureCalendar(p.id);
    const r = await app.req('POST', `/api/projects/${p.id}/milestones/bulk`, [
      { title: 'MIT PRIMES', date: '2026-12-01', kind: 'deadline' },
      { title: 'RSI application', date: '2027-01-14', kind: 'deadline' },
    ]);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('applied');
    expect(r.json.changes.map((c: any) => c.kind)).toEqual(['projects.milestone.add', 'gcal.event.create', 'projects.milestone.add', 'gcal.event.create']);
    expect(app.ctx.changes.list().filter((s) => s.source === 'onboarding')).toHaveLength(1);
    expect(svc.milestones(p.id).map((m) => `${m.title}:${m.date}:${m.kind}`)).toEqual(['MIT PRIMES:2026-12-01:deadline', 'RSI application:2027-01-14:deadline']);
    await g.sync();
    const evs = g.eventsBetween('2026-11-30T00:00:00-05:00', '2027-01-20T00:00:00-05:00', { calendarIds: [svc.get(p.id)!.calendarId!] });
    expect(evs.map((e) => e.title).sort()).toEqual(['MIT PRIMES', 'RSI application']);
    expect(evs.every((e) => e.allDay && e.marginKind === 'deadline')).toBe(true);
    expect(svc.milestones(p.id).every((m) => !!m.gcalEventId)).toBe(true);
    const review = await app.req('POST', `/api/projects/${p.id}/milestones/bulk?review=1`, [{ title: 'SSP', date: '2027-02-20', kind: 'deadline' }]);
    expect(review.json.status).toBe('pending');
    expect(svc.milestones(p.id)).toHaveLength(2);
  });

  it('bulk milestones create the calendar through the change when the project has none', async () => {
    const { app, svc, g } = await boot();
    const p = svc.create({ name: 'Zine' }, { onboarding: true });
    const r = await app.req('POST', `/api/projects/${p.id}/milestones/bulk`, [{ title: 'Print', date: '2026-12-01' }]);
    expect(r.json.status).toBe('applied');
    await settle();
    expect(svc.get(p.id)!.calendarId).toBeTruthy();
    expect(g.calendars().some((c) => c.summary === 'Project · Zine')).toBe(true);
  });
});

describe('projects: Claude tools', () => {
  it('list_projects and get_project read; propose_project_changes only proposes, and its changes apply', async () => {
    const { app, svc, mk } = await boot();
    const a = mk('Applications', { sizeMin: 300 });
    const idea = svc.create({ name: 'Podcast', sizeMin: 200 });
    const m = (await import('./manifest')).default;
    const tool = (n: string) => m.claude!.tools!.find((t) => t.name === n)!;
    const list = (await tool('list_projects').run(app.ctx, {})) as any[];
    expect(list.map((p) => p.name)).toEqual(['Applications', 'Podcast']);
    const detail: any = await tool('get_project').run(app.ctx, { projectId: a.id });
    expect(detail.project.name).toBe('Applications');
    const changes = (await tool('propose_project_changes').run(app.ctx, { changes: [
      { action: 'activate', projectId: idea.id, tradeOffId: a.id, restartDate: '2027-01-11' },
      { action: 'add_milestone', projectId: a.id, title: 'Essay draft', date: '2026-11-20' },
      { action: 'update', projectId: a.id, goal: 'Submit five applications' },
    ] })) as any[];
    expect(svc.get(idea.id)!.status).toBe('proposed'); // propose only
    const set = app.ctx.changes.propose({ source: 'claude', title: 'Weekly review', changes });
    const out = await app.ctx.changes.apply(set.id);
    expect(out.status).toBe('applied');
    expect(svc.get(a.id)).toMatchObject({ status: 'pause', goal: 'Submit five applications' });
    expect(svc.get(idea.id)!.status).toBe('core');
    expect(svc.milestones(a.id)[0].title).toBe('Essay draft');
  });

  it('applying a set from the review screen still links a new Todoist project (changeset.applied handler)', async () => {
    const { app, svc, mk } = await boot();
    const p = mk('Alpha');
    const plan = svc.planTodoistCreate(p.id);
    const set = app.ctx.changes.propose({ source: 'claude', title: plan.title, changes: plan.changes });
    await app.ctx.changes.apply(set.id);
    await settle();
    expect(svc.get(p.id)!.todoist).toMatchObject({ type: 'project', name: 'Alpha' });
  });
});

describe('delegation integration', () => {
  it('paused projects drop out of due check-ins', async () => {
    const { app, svc, mk } = await boot();
    const d = app.ctx.service<any>('delegation');
    const p = mk('Delphic Medicine');
    d.addFunction({ projectId: p.id, name: 'Editing', owner: 'Sam' });
    expect(d.dueCheckins('2026-11-02').map((x: any) => x.projectName)).toEqual(['Delphic Medicine']);
    svc.setStatus(p.id, 'pause', { restartDate: '2027-01-04' });
    expect(d.dueCheckins('2026-11-02')).toHaveLength(0);
  });
});
