/**
 * The guided shutdown (SPEC 4.2): what the flow screen needs, the rules it enforces, and the single
 * transaction that runs when the person presses "Shutdown Complete".
 *
 * The screen keeps its answers in the browser (and a draft on the server, so Esc is safe). Nothing
 * touches Todoist until Finish: new items and 72-hour fixes become ONE change set applied on that
 * click (source "shutdown"); carry-over and triage go through the plan service; must-dos are task meta.
 */
import { z } from 'zod';
import type { Ctx } from '../../src/core/types';
import type { ProposedChange } from '../../src/core/changesets';
import { kvGet, kvSet, kvDel } from '../../src/core/kv';
import { now, addDays, at, weekStartOf, weekday, minutesBetween, fromISO, fmtTime, type ISODate } from '../../src/core/time';
import type { DayService, TimelineItem } from '../day/manifest';
import type { Task, TodoistService } from '../todoist/manifest';
import { cloneRitual, type RitualStep } from '../rituals/defaults';

// ---------------------------------------------------------------- collaborators (all optional)
export interface PlanLike {
  carryOver(date: ISODate): Task[];
  carry(taskIds: string[], toDate: ISODate, nextActions?: Record<string, string>): Promise<void>;
  triage(taskId: string, decision: 'first' | 'slot' | 'delegate' | 'drop', opts?: { slotStart?: string; owner?: string; reason?: string }): Promise<void>;
}
interface ProjectsLike {
  deadlines(from: ISODate, to: ISODate): { projectId: string; projectName: string; title: string; date: ISODate; kind: 'deadline' | 'milestone' }[];
  isHidden(task: Task): boolean;
}
interface AiLike { enabled(): boolean; run(feature: string, input: any): Promise<{ text: string; changeSetId?: string; data?: any }> }
interface RitualsLike { get(id: 'shutdown'): { steps: RitualStep[] } }

// ---------------------------------------------------------------- payload
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const text = (max: number) => z.string().trim().max(max);

export const payloadSchema = z.object({
  items: z.array(z.object({
    text: text(300).min(1),
    nextAction: text(300).default(''),
    when: z.enum(['tomorrow', 'date', 'week', 'someday']).default('tomorrow'),
    date: iso.optional(),
    time: hhmm.optional(),
    mustDo: z.boolean().default(false),
  })).default([]),
  carry: z.array(z.object({ taskId: z.string().min(1), nextAction: text(300).default('') })).default([]),
  triage: z.array(z.object({
    taskId: z.string().min(1),
    decision: z.enum(['first', 'slot', 'delegate', 'drop']),
    time: hhmm.optional(),
    owner: text(80).optional(),
    reason: text(300).optional(),
  })).default([]),
  mustDos: z.array(z.string()).default([]),
  decisions: z.array(z.object({
    key: z.string().min(1),
    status: z.enum(['covered', 'moved', 'risk']),
    date: iso.optional(),
    time: hhmm.optional(),
    reason: text(300).optional(),
  })).default([]),
  phoneOut: z.boolean().default(false),
});
export type Payload = z.infer<typeof payloadSchema>;
type Item = Payload['items'][number];

// ---------------------------------------------------------------- shapes for the screen
export interface LightTask {
  id: string; content: string; projectName: string; priority: number;
  due: ISODate | null; dueTime: string | null; deadline: ISODate | null; recurring: boolean;
  estimateMin: number | null; carryCount: number; nextAction: string | null;
  homework: boolean; mustDoDate: ISODate | null;
}
export interface DeadlineRow {
  key: string;
  kind: 'task' | 'project';
  title: string;
  where: string;
  date: ISODate;
  dateKind: 'due' | 'deadline' | 'milestone';
  time: string | null;
  taskId?: string;
  recurring?: boolean;
  homework?: boolean;
  /** Covered by something already chosen in this shutdown. */
  auto: 'must-do' | 'carried' | 'triaged' | 'homework' | null;
  status: 'covered' | 'moved' | 'risk' | null;
  decision?: { date?: string; time?: string; reason?: string };
  resolved: boolean;
}
export type StepKind = 'dump' | 'actions' | 'must-dos' | 'tomorrow' | 'deadlines' | 'phone' | 'complete';
export interface Problem { step: StepKind; code: string; message: string; ref?: string }
export interface Evaluation { ok: boolean; problems: Problem[]; deadlines: DeadlineRow[]; cap: number; mustDoTotal: number }

export interface ShutdownState {
  date: ISODate;
  planDate: ISODate;
  planLabel: string;
  tomorrow: ISODate;
  weekDate: ISODate;
  now: string;
  startedAt: string | null;
  completedAt: string | null;
  minutesAfterStop: number | null;
  stop: string;
  lightsOut: string;
  steps: RitualStep[];
  aiEnabled: boolean;
  planAvailable: boolean;
  cap: number;
  carry: (LightTask & { mustTriage: boolean })[];
  candidates: LightTask[];
  mustDosCurrent: string[];
  tomorrowView: { date: ISODate; isOffDay: boolean; wake: string; stop: string; timeline: TimelineItem[] };
  deadlines: DeadlineRow[];
  draft: unknown | null;
}

export class FlowError extends Error {
  constructor(message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); }
}

export interface FlowHelpers {
  settings(): { overdueLookbackDays: number };
  completedAt(date: ISODate): string | null;
  row(date: ISODate): { started_at: string | null; completed_at: string | null; minutes_after_stop: number | null } | undefined;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const dayName = (date: ISODate) => DAY_NAMES[weekday(date) - 1];
const fmtDate = (date: ISODate) => fromISO(`${date}T12:00:00`).toFormat('ccc, MMM d');

export function createFlow(ctx: Ctx, h: FlowHelpers) {
  const day = () => ctx.service<DayService>('day');
  const td = () => ctx.service<TodoistService>('todoist');
  const plan = () => ctx.maybe<PlanLike>('plan');
  const projects = () => ctx.maybe<ProjectsLike>('projects');
  const ai = () => ctx.maybe<AiLike>('ai');

  const isHomework = (t: Task) => t.meta.homework ?? t.labels.includes(td().settings().homeworkLabel);
  const hidden = (t: Task) => { try { return !!projects()?.isHidden(t); } catch { return false; } };
  const light = (t: Task): LightTask => ({
    id: t.id, content: t.content, projectName: t.projectName, priority: t.priority,
    due: t.due?.date ?? null, dueTime: t.due?.time ?? null, deadline: t.deadline, recurring: !!t.due?.recurring,
    estimateMin: t.estimateMin, carryCount: t.meta.carryCount, nextAction: t.meta.nextAction,
    homework: !!isHomework(t), mustDoDate: t.meta.mustDoDate,
  });

  /** The next day that is not the off-day: "tomorrow" for planning purposes. */
  function planDateFor(date: ISODate): ISODate {
    let d = addDays(date, 1);
    for (let i = 0; i < 7 && day().isOffDay(d); i++) d = addDays(d, 1);
    return d;
  }
  /** "This week": the last school day of the week that is on or after the plan date (else next week's). */
  function thisWeekDate(planDate: ISODate): ISODate {
    const st = day().settings();
    const lastWorkday = (from: ISODate) => {
      const ws = weekStartOf(from, st.weekStart);
      for (let i = 6; i >= 0; i--) {
        const d = addDays(ws, i);
        if (st.schoolDays.includes(weekday(d)) && !day().isOffDay(d)) return d;
      }
      return planDate;
    };
    const d = lastWorkday(planDate);
    return d >= planDate ? d : lastWorkday(addDays(planDate, 7));
  }
  function mustDoCap(): number {
    if (!ctx.maybe('plan')) return 3;
    const s = ctx.settings.get<Record<string, unknown>>('plan') ?? {};
    for (const k of ['mustDoCap', 'mustDosPerDay', 'maxMustDos', 'mustDoMax', 'cap']) {
      const v = s[k];
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    }
    const k = Object.keys(s).find((x) => /must/i.test(x) && typeof s[x] === 'number');
    return k ? (s[k] as number) : 3;
  }

  function carryList(date: ISODate) {
    const p = plan();
    if (!p) return [];
    return p.carryOver(date).filter((t) => !t.checked).map((t) => ({ ...light(t), mustTriage: t.meta.carryCount >= 3 }));
  }

  function candidates(planDate: ISODate, carryIds: Set<string>): LightTask[] {
    const byId = new Map<string, Task>();
    for (const t of td().tasks({ dueOnOrBefore: planDate })) byId.set(t.id, t);
    for (const t of td().tasks({ mustDoOn: planDate })) byId.set(t.id, t);
    for (const id of carryIds) if (!byId.has(id)) { const t = td().task(id); if (t) byId.set(id, t); }
    const rank = (t: Task) => (t.meta.mustDoDate === planDate ? 0 : carryIds.has(t.id) ? 1 : 2);
    return [...byId.values()]
      .filter((t) => !t.checked && !isHomework(t) && !hidden(t))
      .sort((a, b) => rank(a) - rank(b) || (a.due?.date ?? '9999').localeCompare(b.due?.date ?? '9999') || a.priority - b.priority)
      .slice(0, 60)
      .map(light);
  }

  /** Everything due or with a deadline in the next 72 hours (plus recent misses), and project deadlines. */
  function deadlineBase(date: ISODate): Omit<DeadlineRow, 'auto' | 'status' | 'resolved' | 'decision'>[] {
    const end = addDays(date, 3);
    const from = addDays(date, -h.settings().overdueLookbackDays);
    const rows: Omit<DeadlineRow, 'auto' | 'status' | 'resolved' | 'decision'>[] = [];
    for (const t of td().tasks()) {
      if (hidden(t)) continue;
      const dates = [t.due?.date, t.deadline].filter((x): x is string => !!x).filter((x) => x >= from && x <= end).sort();
      if (!dates.length) continue;
      const d = dates[0];
      rows.push({
        key: `task:${t.id}`, kind: 'task', title: t.content, where: t.projectName, date: d,
        dateKind: d === t.deadline ? 'deadline' : 'due',
        time: t.due?.date === d ? t.due.time : null,
        taskId: t.id, recurring: !!t.due?.recurring, homework: !!isHomework(t),
      });
    }
    try {
      for (const p of projects()?.deadlines(date, end) ?? []) {
        rows.push({ key: `proj:${p.projectId}:${p.date}:${p.title}`, kind: 'project', title: p.title, where: p.projectName, date: p.date, dateKind: p.kind === 'milestone' ? 'milestone' : 'deadline', time: null });
      }
    } catch (e) { ctx.log.warn('shutdown: project deadlines unavailable', String(e)); }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
  }

  function resolveWhen(it: Item, planDate: ISODate, weekDate: ISODate): { date: ISODate | null; time: string | null } {
    if (it.when === 'someday') return { date: null, time: null };
    const date = it.when === 'tomorrow' ? planDate : it.when === 'week' ? weekDate : (it.date ?? null);
    return { date, time: it.time ?? null };
  }

  // ---------------------------------------------------------------- validation
  function evaluate(date: ISODate, p: Payload): Evaluation {
    const problems: Problem[] = [];
    const planDate = planDateFor(date);
    const weekDate = thisWeekDate(planDate);
    const cap = mustDoCap();
    const carry = carryList(date);
    const carryById = new Map(carry.map((c) => [c.id, c]));
    const triaged = new Map(p.triage.map((t) => [t.taskId, t]));

    p.items.forEach((it, i) => {
      if (!it.nextAction) problems.push({ step: 'actions', code: 'item_next_action', ref: `item:${i}`, message: `Add a next action for “${it.text}”.` });
      if (it.when === 'date' && !it.date) problems.push({ step: 'actions', code: 'item_date', ref: `item:${i}`, message: `Pick a date for “${it.text}”.` });
      if (it.when === 'date' && it.date && it.date < date) problems.push({ step: 'actions', code: 'item_past', ref: `item:${i}`, message: `“${it.text}” is dated in the past.` });
      if (it.mustDo && resolveWhen(it, planDate, weekDate).date !== planDate) {
        problems.push({ step: 'must-dos', code: 'must_do_date', ref: `item:${i}`, message: `“${it.text}” is a must-do but isn’t dated for ${planDate === addDays(date, 1) ? 'tomorrow' : dayName(planDate)}.` });
      }
    });
    for (const c of p.carry) {
      const row = carryById.get(c.taskId);
      if (row?.mustTriage) problems.push({ step: 'actions', code: 'carry_limit', ref: c.taskId, message: `“${row.content}” has been carried 3 times. Triage it instead of carrying it again.` });
      else if (!c.nextAction) problems.push({ step: 'actions', code: 'carry_next_action', ref: c.taskId, message: `Add a next action for “${row?.content ?? 'this task'}”.` });
    }
    for (const c of carry) {
      if (c.mustTriage && !triaged.has(c.id)) {
        problems.push({ step: 'actions', code: 'triage_required', ref: c.id, message: `“${c.content}” has been carried 3 times. Do it first, give it a fixed slot, delegate it, or drop it.` });
      }
    }
    for (const t of p.triage) {
      const name = carryById.get(t.taskId)?.content ?? 'this task';
      if (t.decision === 'slot' && !t.time) problems.push({ step: 'actions', code: 'triage_slot', ref: t.taskId, message: `Pick a time for “${name}”.` });
      if (t.decision === 'delegate' && !t.owner) problems.push({ step: 'actions', code: 'triage_owner', ref: t.taskId, message: `Say who owns “${name}”.` });
    }

    const forced = p.triage.filter((t) => t.decision === 'first').map((t) => t.taskId);
    const mustSet = new Set([...forced, ...p.mustDos]);
    const mustDoTotal = mustSet.size + p.items.filter((i) => i.mustDo).length;
    if (mustDoTotal > cap) problems.push({ step: 'must-dos', code: 'cap', message: `Pick at most ${cap} must-dos. You chose ${mustDoTotal}.` });

    const carriedIds = new Set(p.carry.map((c) => c.taskId));
    const decisions = new Map(p.decisions.map((d) => [d.key, d]));
    const deadlines: DeadlineRow[] = deadlineBase(date).map((r) => {
      let auto: DeadlineRow['auto'] = null;
      if (r.taskId) {
        if (mustSet.has(r.taskId)) auto = 'must-do';
        else if (carriedIds.has(r.taskId)) auto = 'carried';
        else if (triaged.has(r.taskId)) auto = 'triaged';
        else if (r.homework) auto = 'homework';
      }
      const dec = decisions.get(r.key);
      let status: DeadlineRow['status'] = null;
      let resolved = !!auto;
      if (!auto && dec) {
        if (dec.status === 'covered') { status = 'covered'; resolved = true; }
        else if (dec.status === 'moved' && r.taskId && dec.date) { status = 'moved'; resolved = true; }
        else if (dec.status === 'risk' && dec.reason) { status = 'risk'; resolved = true; }
      }
      return { ...r, auto, status, resolved, decision: dec ? { date: dec.date, time: dec.time, reason: dec.reason } : undefined };
    });
    const open = deadlines.filter((d) => !d.resolved).length;
    if (open) problems.push({ step: 'deadlines', code: 'uncovered', message: `${open} ${open === 1 ? 'deadline' : 'deadlines'} in the next 72 hours ${open === 1 ? 'isn’t' : 'aren’t'} covered yet. Mark each covered, move it, or accept the risk with a reason.` });
    if (!p.phoneOut) problems.push({ step: 'phone', code: 'phone', message: 'Confirm the phone is going out of the bedroom.' });
    return { ok: problems.length === 0, problems, deadlines, cap, mustDoTotal };
  }

  // ---------------------------------------------------------------- state for the screen
  function state(date: ISODate): ShutdownState {
    const d = day();
    const a = d.anchors(date);
    const planDate = planDateFor(date);
    const tomorrow = addDays(date, 1);
    const carry = carryList(date);
    const row = h.row(date);
    const tomorrowAnchors = d.anchors(tomorrow);
    const draftRow = kvGet<{ date: ISODate; data: unknown } | null>(ctx.db, 'shutdown.draft', null);
    const rituals = ctx.maybe<RitualsLike>('rituals');
    const steps = rituals ? rituals.get('shutdown').steps : cloneRitual('shutdown').steps;
    return {
      date, planDate, planLabel: planDate === tomorrow ? 'Tomorrow' : dayName(planDate), tomorrow,
      weekDate: thisWeekDate(planDate),
      now: now().toISO()!,
      startedAt: row?.started_at ?? null, completedAt: row?.completed_at ?? null, minutesAfterStop: row?.minutes_after_stop ?? null,
      stop: a.effectiveStop.toISO()!, lightsOut: a.lightsOut.toISO()!,
      steps,
      aiEnabled: !!ai()?.enabled(),
      planAvailable: !!plan(),
      cap: mustDoCap(),
      carry,
      candidates: candidates(planDate, new Set(carry.map((c) => c.id))),
      mustDosCurrent: td().tasks({ mustDoOn: planDate }).filter((t) => !isHomework(t)).map((t) => t.id),
      tomorrowView: { date: tomorrow, isOffDay: d.isOffDay(tomorrow), wake: tomorrowAnchors.wake.toISO()!, stop: tomorrowAnchors.effectiveStop.toISO()!, timeline: d.timeline(tomorrow) },
      deadlines: evaluate(date, payloadSchema.parse({})).deadlines,
      draft: draftRow && draftRow.date === date ? draftRow.data : null,
    };
  }

  // ---------------------------------------------------------------- draft + start
  function start(date: ISODate) {
    const row = h.row(date);
    if (row?.completed_at || row?.started_at) return;
    ctx.db.run(`INSERT INTO shutdowns (date, started_at) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET started_at = excluded.started_at`, date, now().toISO());
    ctx.bus.emit('shutdown.started', { date });
  }
  const saveDraft = (date: ISODate, data: unknown) => kvSet(ctx.db, 'shutdown.draft', { date, savedAt: now().toISO(), data });

  const appliedRefs = (date: ISODate) => {
    const v = kvGet<{ date: ISODate; refs: string[] } | null>(ctx.db, 'shutdown.applied', null);
    return new Set(v && v.date === date ? v.refs : []);
  };

  // ---------------------------------------------------------------- Claude suggestions
  async function suggest(date: ISODate, items: string[]) {
    const a = ai();
    if (!a || !a.enabled()) throw new FlowError('Claude is turned off. Turn it on in Settings to get suggestions.', 409);
    const planDate = planDateFor(date);
    const res = await a.run('shutdown_actions', { items, date, tomorrow: planDate });
    // We only borrow the suggestions for pre-filling; drop any change set the AI module proposed on the side.
    if (res.changeSetId) { try { ctx.changes.discard(res.changeSetId); } catch { /* already gone */ } }
    return { text: res.text, suggestions: normalizeSuggestions(res.data, items, planDate) };
  }

  // ---------------------------------------------------------------- finish
  async function finish(date: ISODate, p: Payload) {
    if (h.completedAt(date)) throw new FlowError('Shutdown is already logged for tonight.', 409);
    const ev = evaluate(date, p);
    if (!ev.ok) throw new FlowError(ev.problems[0].message, 400, { problems: ev.problems });

    const planDate = planDateFor(date);
    const weekDate = thisWeekDate(planDate);
    const applied = appliedRefs(date);
    const somedayProject = td().projects().find((x) => /someday/i.test(x.name))?.id;
    const changes: ProposedChange[] = [];
    for (const it of p.items) {
      const ref = `item:${it.text}`;
      if (applied.has(ref)) continue;
      const when = resolveWhen(it, planDate, weekDate);
      const dueDate = when.date ? (when.time ? `${when.date}T${when.time}:00` : when.date) : null;
      const label = !when.date ? 'Someday' : `${fmtDate(when.date)}${when.time ? ` at ${fmtTime(at(when.date, when.time))}` : ''}`;
      changes.push({
        kind: 'shutdown.task.add',
        title: `Add “${it.text}” for ${label}`,
        payload: { ref, content: it.text, nextAction: it.nextAction, dueDate, mustDoDate: it.mustDo ? planDate : null, projectId: when.date ? undefined : somedayProject },
      });
    }
    for (const r of ev.deadlines) {
      if (r.status !== 'moved' || !r.taskId || !r.decision?.date) continue;
      const ref = `move:${r.key}`;
      if (applied.has(ref)) continue;
      const to = r.decision.time ? `${r.decision.date}T${r.decision.time}:00` : r.decision.date;
      const label = `${fmtDate(r.decision.date)}${r.decision.time ? ` at ${fmtTime(at(r.decision.date, r.decision.time))}` : ''}`;
      changes.push({ kind: 'todoist.task.reschedule', title: `Move “${r.title}” to ${label}`, payload: { taskId: r.taskId, date: to, ref }, before: { date: r.date } });
    }

    let changeSetId: string | null = null;
    let created = 0;
    let moved = 0;
    if (changes.length) {
      const nNew = changes.filter((c) => c.kind === 'shutdown.task.add').length;
      const set = ctx.changes.propose({
        source: 'shutdown',
        title: `Shutdown ${date}: ${nNew} new ${nNew === 1 ? 'task' : 'tasks'}${changes.length > nNew ? `, ${changes.length - nNew} moved` : ''}`,
        summary: 'Applied when you pressed Shutdown Complete.',
        changes,
      });
      const res = await ctx.changes.apply(set.id);
      changeSetId = res.id;
      const done = res.changes.filter((c) => c.status === 'applied');
      kvSet(ctx.db, 'shutdown.applied', { date, refs: [...applied, ...done.map((c) => c.payload.ref)] });
      created = done.filter((c) => c.kind === 'shutdown.task.add').length;
      moved = done.length - created;
      const bad = res.changes.filter((c) => c.status === 'failed');
      if (bad.length) {
        throw new FlowError(
          `Todoist didn’t accept ${bad.length} ${bad.length === 1 ? 'change' : 'changes'}: ${bad[0].error}. Shutdown isn’t logged yet. Fix the connection and press Shutdown Complete again; what already went through won’t be added twice.`,
          502, { changeSetId, failed: bad.map((c) => ({ title: c.title, error: c.error })) },
        );
      }
    }

    const pl = plan();
    if (pl) {
      for (const t of p.triage) {
        await pl.triage(t.taskId, t.decision, { slotStart: t.time ? at(planDate, t.time).toISO()! : undefined, owner: t.owner, reason: t.reason });
      }
      if (p.carry.length) await pl.carry(p.carry.map((c) => c.taskId), planDate, Object.fromEntries(p.carry.map((c) => [c.taskId, c.nextAction])));
    }

    // Must-dos are exactly what was chosen: anything offered in step 3 and left unchecked is released.
    const keep = new Set([...p.mustDos, ...p.triage.filter((t) => t.decision === 'first').map((t) => t.taskId)]);
    for (const id of keep) if (td().task(id)) td().setMeta(id, { mustDoDate: planDate });
    for (const t of candidates(planDate, new Set(p.carry.map((c) => c.taskId)))) {
      if (!keep.has(t.id) && t.mustDoDate === planDate) td().setMeta(t.id, { mustDoDate: null });
    }

    const t = now();
    const stop = day().anchors(date).effectiveStop;
    const minutesAfterStop = minutesBetween(stop, t);
    const risks = ev.deadlines.filter((r) => r.status === 'risk').map((r) => ({ key: r.key, title: r.title, date: r.date, reason: r.decision?.reason ?? '' }));
    const summary = { created, moved, carried: p.carry.length, triaged: p.triage.length, mustDos: keep.size + p.items.filter((i) => i.mustDo).length, risks, changeSetId };
    ctx.db.run(
      `INSERT INTO shutdowns (date, started_at, completed_at, minutes_after_stop, summary) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET started_at = COALESCE(shutdowns.started_at, excluded.started_at), completed_at = excluded.completed_at,
         minutes_after_stop = excluded.minutes_after_stop, summary = excluded.summary`,
      date, t.toISO(), t.toISO(), minutesAfterStop, JSON.stringify(summary),
    );
    kvDel(ctx.db, 'shutdown.draft');
    kvDel(ctx.db, 'shutdown.applied');
    ctx.bus.emit('shutdown.completed', { date, at: t.toISO() });
    return { ok: true, date, completedAt: t.toISO()!, minutesAfterStop, ...summary };
  }

  return { state, evaluate, start, saveDraft, suggest, finish, planDateFor, thisWeekDate, somedayProjectId: () => td().projects().find((x) => /someday/i.test(x.name))?.id };
}
export type Flow = ReturnType<typeof createFlow>;

// ---------------------------------------------------------------- suggestion parsing
export interface Suggestion { index: number; text: string; nextAction: string; when?: Item['when']; date?: ISODate; time?: string }

/** Claude's answer may be an array or wrapped in an object; fields may be named a few ways. Be liberal. */
export function normalizeSuggestions(data: any, items: string[], planDate: ISODate): Suggestion[] {
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.suggestions) ? data.suggestions : Array.isArray(data?.actions) ? data.actions : [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const out: Suggestion[] = [];
  list.forEach((e, pos) => {
    const o = typeof e === 'string' ? { nextAction: e } : e ?? {};
    const label = String(o.text ?? o.item ?? o.title ?? o.loop ?? '');
    let index = label ? items.findIndex((x) => norm(x) === norm(label)) : -1;
    if (index < 0 && pos < items.length) index = pos;
    if (index < 0) return;
    const nextAction = String(o.nextAction ?? o.next_action ?? o.action ?? '').trim();
    if (!nextAction) return;
    const s: Suggestion = { index, text: items[index], nextAction };
    const rawWhen = String(o.when ?? o.day ?? o.date ?? o.due ?? '').trim().toLowerCase();
    const m = rawWhen.match(/^(\d{4}-\d{2}-\d{2})(?:[t ](\d{2}:\d{2}))?/);
    if (m) {
      if (m[1] === planDate) s.when = 'tomorrow'; else { s.when = 'date'; s.date = m[1]; }
      if (m[2]) s.time = m[2];
    } else if (rawWhen.startsWith('tomorrow')) s.when = 'tomorrow';
    else if (rawWhen.includes('week')) s.when = 'week';
    else if (/someday|later|maybe/.test(rawWhen)) s.when = 'someday';
    const slot = String(o.slot ?? o.time ?? o.start ?? '').match(/(\d{1,2}):(\d{2})/);
    if (slot && !s.time) s.time = `${slot[1].padStart(2, '0')}:${slot[2]}`;
    out.push(s);
  });
  return out;
}
