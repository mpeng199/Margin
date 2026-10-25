/**
 * Data behind each review panel. Everything reads local SQLite caches through other modules'
 * services, and every optional module is called defensively so the review still works without it.
 */
import type { Ctx } from '../../src/core/types';
import { kvGet } from '../../src/core/kv';
import { addDays, at, fromISO, today, weekday, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { TodoistService, Task } from '../todoist/manifest';
import type { GoogleService, CalEvent } from '../google/manifest';
import { isNum, mean, safe, type RequiredStep } from './types';

export function autoStats(ctx: Ctx, from: ISODate, to: ISODate) {
  const day = ctx.service<DayService>('day');
  const entries = safe(() => ctx.maybe<any>('checkin')?.entries(from, to) as any[] | undefined, []) ?? [];
  const nights = entries.map((e) => e?.sleepMin).filter(isNum);
  const breaks = day.stopBreaks(from, to);
  const hist = safe<any>(() => ctx.maybe<any>('shutdown')?.history?.(from, to), undefined);
  const shutdownDays = Array.isArray(hist) ? hist.filter((h) => h && (h.completedAt ?? h.completed_at ?? h.at)).length : null;
  return {
    from, to, days: 7,
    sleepAvgMin: mean(nights), sleepNights: nights.length, sleepTargetMin: day.settings().sleepNeedMin,
    stopBreaks: breaks.length, breakDays: new Set(breaks.map((b) => b.date)).size, shutdownDays,
  };
}
export type AutoStats = ReturnType<typeof autoStats>;

const lite = (t: Task) => ({ id: t.id, content: t.content, projectName: t.projectName, due: t.due?.date ?? null, priority: t.priority, url: t.url });

// ---------------------------------------------------------------------------------------------- step 2

export interface TriageItem extends ReturnType<typeof lite> {
  carryCount: number; lastCarryDate: string | null; nextAction: string | null; owner: string | null; queued: boolean;
}
/** The triage queue (3+ carries) plus everything that was carried since the lookback began. */
export function triageList(ctx: Ctx, lookbackFrom: ISODate): TriageItem[] {
  const td = ctx.service<TodoistService>('todoist');
  const projects = ctx.maybe<any>('projects');
  const hidden = (t: Task) => !!safe(() => projects?.isHidden?.(t), false);
  const open = td.tasks();
  const queue: Task[] = safe(() => ctx.maybe<any>('plan')?.triageQueue?.() as Task[] | undefined, undefined) ?? open.filter((t) => t.meta.carryCount >= 3);
  const queued = new Set(queue.map((t) => t.id));
  const byId = new Map<string, Task>();
  for (const t of queue) byId.set(t.id, t);
  for (const t of open) if (t.meta.carryCount > 0 && t.meta.lastCarryDate && t.meta.lastCarryDate >= lookbackFrom) byId.set(t.id, t);
  return [...byId.values()]
    .filter((t) => !t.checked && !hidden(t))
    .map((t) => ({ ...lite(t), carryCount: t.meta.carryCount, lastCarryDate: t.meta.lastCarryDate, nextAction: t.meta.nextAction, owner: t.meta.owner, queued: queued.has(t.id) }))
    .sort((a, b) => Number(b.queued) - Number(a.queued) || b.carryCount - a.carryCount || (a.due ?? '9').localeCompare(b.due ?? '9'));
}

// ---------------------------------------------------------------------------------------------- step 3

export function priorityOptions(ctx: Ctx) {
  const td = ctx.service<TodoistService>('todoist');
  const projects = ctx.maybe<any>('projects');
  const list: any[] = safe(() => projects?.list() as any[] | undefined, []) ?? [];
  const hidden = (t: Task) => !!safe(() => projects?.isHidden?.(t), false);
  return {
    projects: list.filter((p) => !p.archived && (p.status === 'core' || p.status === 'maintain')).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    tasks: td.tasks().filter((t) => !t.due?.recurring && !hidden(t)).sort((a, b) => a.priority - b.priority || (a.due?.date ?? '9').localeCompare(b.due?.date ?? '9')).slice(0, 60)
      .map((t) => ({ id: t.id, content: t.content, projectName: t.projectName })),
  };
}

// ---------------------------------------------------------------------------------------------- step 4 and 8

export function projectsPanel(ctx: Ctx) {
  const projects = ctx.maybe<any>('projects');
  if (!projects) return { available: false, list: [] as any[], wipLimit: 2, active: 0, proposed: [] as any[], tradeOffs: [] as any[], phase: null as null | { allowed: boolean; reason?: string } };
  const list: any[] = (safe(() => projects.list() as any[], []) ?? []).filter((p) => !p.archived);
  const wipLimit = ctx.settings.get<any>('projects')?.wipLimit ?? 2;
  const phase = safe(() => ctx.maybe<any>('phases')?.canAddCommitment?.() as { allowed: boolean; reason?: string } | undefined, null);
  return {
    available: true,
    list: list.filter((p) => p.status !== 'proposed'),
    wipLimit,
    active: safe(() => (projects.activeNonSchool() as any[]).length, 0),
    proposed: list.filter((p) => p.status === 'proposed'),
    // Something of equal size to give up: an active non-school project.
    tradeOffs: list.filter((p) => !p.isSchool && (p.status === 'core' || p.status === 'maintain')),
    phase: phase ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- step 5

export function checkinsDue(ctx: Ctx) {
  const rows: any[] = safe(() => ctx.maybe<any>('delegation')?.dueCheckins?.(today()) as any[] | undefined, []) ?? [];
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    const id = String(r?.functionId ?? r?.id ?? '');
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id, name: String(r.name ?? r.function ?? r.title ?? r.functionName ?? 'Function'),
      owner: (r.owner ?? r.ownerName ?? null) as string | null, projectName: (r.projectName ?? r.project ?? null) as string | null,
      due: (r.due ?? r.dueDate ?? null) as string | null,
    }];
  });
}

// ---------------------------------------------------------------------------------------------- step 6

export interface DeadlineItem {
  key: string; kind: 'task' | 'project' | 'event'; title: string; date: ISODate; detail: string | null;
  taskId?: string; planned: boolean; needsPlan: boolean;
}
const DEADLINE_WORDS = /\b(due|deadline|submit|submission|exam|test|quiz|final|midterm|application|deliver)\b/i;

/** Todoist due dates and deadlines, project deadlines/milestones, and all-day calendar events in [from, to]. */
export function deadlineItems(ctx: Ctx, from: ISODate, to: ISODate): DeadlineItem[] {
  const td = ctx.service<TodoistService>('todoist');
  const google = ctx.service<GoogleService>('google');
  const projects = ctx.maybe<any>('projects');
  const events = google.eventsBetween(at(from, '00:00').toISO()!, at(addDays(to, 1), '00:00').toISO()!);
  const worked = events.filter((e) => e.appOwned && (e.marginKind === 'block' || e.marginKind === 'session'));
  const refs = new Set(worked.map((e) => e.marginRef).filter(Boolean) as string[]);
  const sessionProjects = new Set(worked.map((e) => e.projectId).filter(Boolean) as string[]);
  const hw = td.settings().homeworkLabel;
  const out: DeadlineItem[] = [];

  const open = td.tasks({ dueOnOrBefore: to });
  const withDeadline = td.tasks().filter((t) => t.deadline && t.deadline >= from && t.deadline <= to && !open.some((o) => o.id === t.id));
  for (const t of [...open, ...withDeadline]) {
    if (safe(() => projects?.isHidden?.(t), false)) continue;
    const date = t.deadline && t.deadline >= from && t.deadline <= to ? t.deadline
      : t.due && !t.due.recurring && t.due.date >= from && t.due.date <= to ? t.due.date : null;
    if (!date) continue;
    const homework = t.labels.includes(hw) || t.meta.homework === true;
    if (homework && !t.deadline) continue; // the homework lane already plans these
    out.push({
      key: `task:${t.id}`, kind: 'task', title: t.content, date, taskId: t.id,
      detail: [t.projectName, t.deadline ? 'Deadline' : 'Due'].filter(Boolean).join(' · '),
      planned: refs.has(t.id) || !!t.meta.mustDoDate || homework, needsPlan: true,
    });
  }
  const pd: any[] = safe(() => projects?.deadlines?.(from, to) as any[] | undefined, []) ?? [];
  const openByProject = (id: string) => td.tasks().some((t) => safe(() => projects.projectForTask(t)?.id, null) === id && (refs.has(t.id) || t.meta.mustDoDate));
  for (const d of pd) {
    out.push({
      key: `project:${d.projectId}:${d.date}:${d.title}`, kind: 'project', title: d.title, date: d.date,
      detail: `${d.projectName} · ${d.kind === 'milestone' ? 'Milestone' : 'Deadline'}`,
      planned: sessionProjects.has(d.projectId) || openByProject(d.projectId), needsPlan: true,
    });
  }
  const shown = new Set(out.map((o) => `${o.date}|${o.title.toLowerCase()}`));
  for (const e of events as CalEvent[]) {
    if (!e.allDay) continue;
    const date = e.start.slice(0, 10);
    if (date < from || date > to) continue;
    if (/holiday|birthday/i.test(e.calendarName) || e.calendarId.includes('#holiday@')) continue;
    if (e.appOwned && ['block', 'fixed', 'deadline', 'milestone', 'phase'].includes(e.marginKind ?? '')) continue;
    if (shown.has(`${date}|${e.title.toLowerCase()}`)) continue;
    out.push({ key: `event:${e.calendarId}:${e.id}`, kind: 'event', title: e.title, date, detail: e.calendarName, planned: false, needsPlan: DEADLINE_WORDS.test(e.title) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)).slice(0, 80);
}

// ---------------------------------------------------------------------------------------------- step 7

export function requiredSteps(ctx: Ctx): RequiredStep[] {
  const rows = kvGet<RequiredStep[]>(ctx.db, 'review.requiredSteps', []);
  const seen = new Set<string>();
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && !seen.has(r.id) && !!seen.add(r.id));
}

// ---------------------------------------------------------------------------------------------- step 9

export function offdayPanel(ctx: Ctx) {
  const day = ctx.service<DayService>('day');
  const td = ctx.service<TodoistService>('todoist');
  const google = ctx.service<GoogleService>('google');
  const projects = ctx.maybe<any>('projects');
  const offday = ctx.maybe<any>('offday');
  let date = safe<ISODate | null>(() => offday?.nextOffDay?.() ?? null, null);
  if (!date) {
    const off = day.settings().offDay;
    for (let i = 0; i < 7 && !date; i++) if (weekday(addDays(today(), i)) === off) date = addDays(today(), i);
  }
  if (!date) return { available: !!offday, date: null as ISODate | null, tasks: [] as ReturnType<typeof lite>[], events: [] as any[] };
  const raw = google.eventsBetween(at(date, '00:00').toISO()!, at(addDays(date, 1), '00:00').toISO()!);
  const shown = safe(() => projects?.filterForMain?.(raw) as CalEvent[] | undefined, undefined) ?? raw;
  return {
    available: !!offday,
    date,
    tasks: td.tasks({ dueOn: date }).filter((t) => !safe(() => projects?.isHidden?.(t), false)).map((t) => ({ ...lite(t), recurring: !!t.due?.recurring })),
    events: shown.filter((e) => e.marginKind !== 'fixed').map((e) => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendar: e.calendarName })),
  };
}

export { fromISO };
