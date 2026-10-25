/**
 * Read-only aggregate endpoints for the MCP server (GET /api/ai/read/*). They compose module services by their
 * documented contracts, degrade to a plain message when a module is off, and apply the same wellbeing filter as the in-app tools.
 */
import type { Hono } from 'hono';
import type { Ctx } from '../../src/core/types';
import { addDays, today } from '../../src/core/time';
import { stripWellbeing } from '../../src/integrations/claude';

export const compactTask = (t: any) => ({
  id: t.id, content: t.content, project: t.projectName, projectId: t.projectId, priority: `p${t.priority}`, labels: t.labels,
  due: t.due ? { date: t.due.date, time: t.due.time, recurring: t.due.recurring } : null, deadline: t.deadline, estimateMin: t.estimateMin,
  mustDo: t.meta?.mustDoDate ?? null, optional: !!t.meta?.optional, carryCount: t.meta?.carryCount ?? 0, nextAction: t.meta?.nextAction ?? null, owner: t.meta?.owner ?? null,
});
const compactProject = (p: any) => ({
  id: p.id, name: p.name, status: p.status, isSchool: p.isSchool, purpose: p.purpose, goal: p.goal, maintenance: p.maintenance,
  restartDate: p.restartDate, separation: p.separation, weeklyBudgetMin: p.weeklyBudgetMin, sizeMin: p.sizeMin ?? null,
});
const safe = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

export function registerReadRoutes(r: Hono, ctx: Ctx) {
  const share = () => !!ctx.settings.get<any>('ai').shareWellbeing;
  const send = (c: any, v: unknown) => c.json(share() ? v : stripWellbeing(v));
  const off = (c: any, what: string) => c.json({ error: `${what} is turned off in Margin, so this isn't available.` }, 404);

  r.get('/read/today', (c) => {
    const day = ctx.maybe<any>('day');
    if (!day) return off(c, 'The Day module');
    const date = c.req.query('date') ?? day.planningDate();
    const plan = ctx.maybe<any>('plan');
    return send(c, {
      date, state: day.state(), capacity: day.capacity(date), timeline: day.timeline(date),
      plan: plan ? {
        mustDos: safe(() => plan.mustDos(date).map(compactTask)), homework: safe(() => plan.homework(date).map(compactTask)),
        carryOver: safe(() => plan.carryOver(date).map(compactTask)), triageQueue: safe(() => plan.triageQueue().map(compactTask)),
      } : null,
      ...(plan ? {} : { note: 'The Plan module is off, so must-dos and homework are not available.' }),
    });
  });

  r.get('/read/tasks', (c) => {
    const td = ctx.maybe<any>('todoist');
    if (!td) return off(c, 'Todoist');
    const q = c.req.query();
    return send(c, td.tasks({ projectId: q.projectId, label: q.label, dueOn: q.dueOn, dueOnOrBefore: q.dueOnOrBefore }).slice(0, 150).map(compactTask));
  });

  r.get('/read/projects', (c) => {
    const pr = ctx.maybe<any>('projects');
    if (pr) return send(c, pr.list().filter((p: any) => !p.archived).map(compactProject));
    const td = ctx.maybe<any>('todoist');
    if (!td) return off(c, 'The Projects module');
    return send(c, { note: 'The Projects module is off; these are plain Todoist projects.', projects: td.projects() });
  });

  r.get('/read/projects/:id', (c) => {
    const pr = ctx.maybe<any>('projects');
    if (!pr) return off(c, 'The Projects module');
    const id = c.req.param('id');
    const p = pr.get(id);
    if (!p) return c.json({ error: `No project with id "${id}".` }, 404);
    const td = ctx.maybe<any>('todoist');
    const link = p.todoist;
    const tasks = td && link ? safe(() => td.tasks(link.type === 'label' ? { label: link.name } : { projectId: link.id }).slice(0, 100).map(compactTask)) : null;
    const del = ctx.maybe<any>('delegation');
    return send(c, {
      project: compactProject(p), tasks,
      deadlines: safe(() => pr.deadlines(today(), addDays(today(), 21)).filter((d: any) => d.projectId === id)),
      functions: del ? safe(() => del.functions(id)) : null, waiting: del ? safe(() => del.waiting(id)) : null,
    });
  });

  r.get('/read/metrics', (c) => {
    const weeks = Math.min(12, Math.max(1, Number(c.req.query('weeks') ?? 4) || 4));
    const to = today(), from = addDays(to, -7 * weeks);
    const day = ctx.maybe<any>('day'), td = ctx.maybe<any>('todoist'), focus = ctx.maybe<any>('focus'), habits = ctx.maybe<any>('habits'), review = ctx.maybe<any>('review');
    const sumBy = (rows: any[], key: string, val: (x: any) => number) => rows.reduce<Record<string, number>>((a, x) => { a[x[key]] = (a[x[key]] ?? 0) + val(x); return a; }, {});
    const out: Record<string, unknown> = { from, to, weeks };
    if (day) out.stopBreaks = safe(() => { const b = day.stopBreaks(from, to); return { count: b.length, byDate: sumBy(b, 'date', () => 1) }; });
    if (td) out.completions = safe(() => { const k = td.completions(from, to); return { total: k.length, byProject: sumBy(k, 'project_id', () => 1) }; });
    if (focus) out.focusMinutesByProject = safe(() => sumBy(focus.timeLogs({ from, to }), 'projectId', (x) => x.minutes));
    if (habits) out.habits = safe(() => habits.list().map((h: any) => ({ id: h.id, name: h.name, consistency14: habits.consistency(h.id, 14), consistency28: habits.consistency(h.id, 28) })));
    if (review) out.weeklyScores = safe(() => review.scores(weeks));
    if (Object.keys(out).length <= 3) out.note = 'No metrics modules are on (Day, Todoist, Focus, Habits, Review), so there is nothing to summarize.';
    return send(c, out);
  });
}
