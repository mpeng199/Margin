/**
 * plan — the daily plan and carry-over (SPEC 4.3, 4.4).
 *
 * Must-dos (max 3 beyond homework, a 4th forces a swap or goes optional), the homework lane, one deep
 * block, batched message slots, plan acceptance against capacity, carry counts with a hard stop at 3
 * ("There is no 4th roll"), and the urgency check ("What actually happens if this waits a week?").
 *
 * Tasks live in Todoist; must-do / optional / carry state is task_meta (via the todoist service).
 * An "optional" task is committed to nothing: it never counts toward the cap or toward load.
 * Tasks owned by someone else (meta.owner set: delegated) and tasks in paused/dropped projects are
 * left out of every bucket.
 */
import { z } from 'zod';
import type { DateTime } from 'luxon';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, at, addDays, fromISO, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import { pad, type LoadItem } from '../day/capacity';
import type { TodoistService, Task, TaskMeta } from '../todoist/manifest';
import type { GoogleService } from '../google/manifest';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const settings = z.object({
  mustDoCap: z.number().int().min(1).max(5).default(3).describe('Most must-dos per day beyond homework. Fewer priorities, more finished (Ivy Lee method).'),
  deepBlockMin: z.number().int().min(60).max(90).default(75).describe('Length of the daily deep-work block, 60 to 90 minutes.'),
  messageSlots: z.object({
    afterSchool: hhmm.default('18:30'),
    atShutdown: hhmm.nullable().default(null),
  }).default({ afterSchool: '18:30', atShutdown: null })
    .describe('Two batches for messages. Leave atShutdown null to use 15 minutes before the hard stop.'),
  includeOverdue: z.boolean().default(true).describe('Count overdue tasks in today’s load.'),
});
export type PlanSettings = z.infer<typeof settings>;

export const MAX_CARRIES = 3;
const MESSAGE_BLOCK_MIN = 15;

export class PlanError extends Error {
  constructor(message: string, public status = 409, public extra: Record<string, unknown> = {}) { super(message); }
}

/** Most-carried first, then p1 → p4, then by name. This is also the must-do "slot" order. */
const urgency = (a: Task, b: Task) =>
  b.meta.carryCount - a.meta.carryCount || a.priority - b.priority || (a.due?.date ?? '9').localeCompare(b.due?.date ?? '9') || a.content.localeCompare(b.content);

export interface PlanTaskView {
  id: string; content: string; projectName: string; priority: number; labels: string[];
  due: Task['due']; estimateMin: number | null; effectiveMin: number; paddedMin: number;
  carryCount: number; nextAction: string | null; optional: boolean; done: boolean; lane: LoadItem['lane'];
}

export function createPlanService(ctx: Ctx) {
  const s = () => ctx.settings.get<PlanSettings>('plan');
  const td = () => ctx.service<TodoistService>('todoist');
  const day = () => ctx.service<DayService>('day');
  const projects = () => ctx.maybe<any>('projects');
  const planningDate = () => day().planningDate();

  const hidden = (t: Task) => !!projects()?.isHidden?.(t);
  const eligible = (t: Task) => !t.checked && !hidden(t) && !t.meta.owner;
  const isHomework = (t: Task) =>
    t.labels.includes(td().settings().homeworkLabel) || t.meta.homework === true || !!projects()?.projectForTask?.(t)?.isSchool;
  const dayLabel = (date: ISODate) => (date === planningDate() ? 'Today' : date === addDays(planningDate(), 1) ? 'Tomorrow' : date);

  /** Everything planned for a date, split into lanes. Optional tasks are listed but carry no load. */
  function buckets(date: ISODate) {
    const musts = td().tasks({ mustDoOn: date }).filter(eligible);
    const overdue = s().includeOverdue && date === planningDate();
    const due = (overdue ? td().tasks({ dueOnOrBefore: date }) : td().tasks({ dueOn: date })).filter(eligible);
    const seen = new Set(musts.map((t) => t.id));
    // A task committed to a later day isn't today's load.
    const rest = due.filter((t) => !seen.has(t.id) && !(t.meta.mustDoDate && t.meta.mustDoDate > date));
    return {
      required: musts.filter((t) => !t.meta.optional).sort(urgency),
      optional: musts.filter((t) => t.meta.optional).sort(urgency),
      homework: rest.filter(isHomework).sort(urgency),
      other: rest.filter((t) => !isHomework(t)).sort(urgency),
    };
  }

  /** Must-dos for a date including finished ones: the cap counts commitments, not what's left. */
  function mustDoSnapshot(date: ISODate) {
    const all = td().tasks({ mustDoOn: date, includeDone: true }).filter((t) => !hidden(t));
    return { required: all.filter((t) => !t.meta.optional), optional: all.filter((t) => t.meta.optional) };
  }

  // ---- Todoist label mirror (must-do label iff a required must-do), serialized to avoid duplicate label_add
  let chain: Promise<unknown> = Promise.resolve();
  const mirror = (taskId: string) => {
    chain = chain.then(async () => {
      const t = td().task(taskId);
      if (!t || t.checked) return;
      const label = td().settings().mustDoLabel;
      const want = !!t.meta.mustDoDate && !t.meta.optional;
      if (want && !t.labels.includes(label)) await td().addLabel(taskId, label);
      if (!want && t.labels.includes(label)) await td().removeLabel(taskId, label);
    }).catch((e) => ctx.log.warn('must-do label mirror failed', e?.message ?? e));
    return chain;
  };

  async function createBlock(title: string, start: DateTime, end: DateTime, ref: string) {
    const g = ctx.maybe<GoogleService>('google');
    if (!g) throw new PlanError('Google Calendar is turned off, so there’s nowhere to put the block.');
    const date = start.toISODate()!;
    const stop = day().anchors(date).hardStop;
    if (end.toMillis() > stop.toMillis()) throw new PlanError(`That would run past your ${stop.toFormat('h:mm a')} stop.`);
    // The click that calls this is the yes: propose and apply in one step.
    const set = ctx.changes.propose({
      source: 'user', title: `Block “${title}”`,
      changes: [{
        kind: 'gcal.event.create',
        title: `Block “${title}” ${start.toFormat('EEE h:mm')}–${end.toFormat('h:mm a')}`,
        payload: { title, start: start.toISO(), end: end.toISO(), marginKind: 'block', marginRef: ref },
      }],
    });
    const out = await ctx.changes.apply(set.id);
    const c = out.changes[0];
    if (c.status !== 'applied') throw new PlanError(c.error ?? 'Couldn’t add the block to your calendar.');
    return { changeSetId: out.id, eventId: (c.result as any)?.eventId as string | undefined };
  }

  const blocksOn = (date: ISODate) => {
    const g = ctx.maybe<GoogleService>('google');
    return g ? g.eventsBetween(at(date, '00:00').toISO()!, at(addDays(date, 1), '00:00').toISO()!).filter((e) => e.marginKind === 'block') : [];
  };

  const svc = {
    settings: s,
    mustDoCap: () => s().mustDoCap,
    mirror,

    // ------------------------------------------------------------------ contract: planned work
    loadFor(date: ISODate): LoadItem[] {
      const b = buckets(date);
      const dayS = day().settings();
      const item = (t: Task, lane: LoadItem['lane']): LoadItem => {
        const est = t.estimateMin || dayS.defaultEstimateMin;
        return { id: t.id, title: t.content, estimateMin: est, paddedMin: pad(est, dayS.estimateMultiplier), lane };
      };
      return [...b.required.map((t) => item(t, 'must')), ...b.homework.map((t) => item(t, 'homework')), ...b.other.map((t) => item(t, 'other'))];
    },
    /** Required first, then optional. */
    mustDos(date: ISODate): Task[] { const b = buckets(date); return [...b.required, ...b.optional]; },
    homework(date: ISODate): Task[] { return buckets(date).homework; },
    others(date: ISODate): Task[] { return buckets(date).other; },
    /** Planned for the date and still open: the candidates to carry at shutdown. Optional tasks may stay undone. */
    carryOver(date: ISODate): Task[] { const b = buckets(date); return [...b.required, ...b.homework, ...b.other]; },

    // ------------------------------------------------------------------ must-dos and the cap
    mustDoState(date: ISODate) {
      const snap = mustDoSnapshot(date);
      return { cap: s().mustDoCap, used: snap.required.length, required: snap.required, optional: snap.optional };
    },

    /**
     * Make a task a must-do for a date. A required one beyond the cap needs `swapOut` (a required
     * must-do to remove) or `optional: true`; otherwise this throws a 409 with the current list.
     */
    async addMustDo(taskId: string, date: ISODate, opts: { optional?: boolean; swapOut?: string } = {}) {
      const t = td().task(taskId);
      if (!t) throw new PlanError('Task not found', 404);
      if (t.checked) throw new PlanError('That task is already done.');
      const cap = s().mustDoCap;
      let swapped: string | null = null;
      if (!opts.optional) {
        const others = mustDoSnapshot(date).required.filter((x) => x.id !== taskId);
        if (others.length >= cap) {
          if (!opts.swapOut) {
            throw new PlanError(`${dayLabel(date)} already has ${cap} must-dos. Swap one out, or make this one optional.`, 409, {
              code: 'cap_reached', cap, date, current: others.map((x) => ({ id: x.id, content: x.content, done: x.checked })),
            });
          }
          const out = others.find((x) => x.id === opts.swapOut);
          if (!out || out.checked) throw new PlanError('Pick an unfinished must-do to swap out.', 400);
          td().setMeta(out.id, { mustDoDate: null, optional: false });
          await mirror(out.id);
          swapped = out.id;
        }
      }
      td().setMeta(taskId, { mustDoDate: date, optional: !!opts.optional });
      await mirror(taskId);
      return { ok: true, swapped };
    },
    async removeMustDo(taskId: string) {
      td().setMeta(taskId, { mustDoDate: null, optional: false });
      await mirror(taskId);
    },

    /** The whole plan for a date in one payload (Plan page, Today widgets, Claude). */
    dayPlan(date: ISODate) {
      const b = buckets(date);
      const snap = mustDoSnapshot(date);
      const done = snap.required.filter((t) => t.checked);
      const dayS = day().settings();
      const cap = day().capacity(date);
      const view = (t: Task, lane: LoadItem['lane']): PlanTaskView => {
        const eff = t.estimateMin || dayS.defaultEstimateMin;
        return {
          id: t.id, content: t.content, projectName: t.projectName, priority: t.priority, labels: t.labels, due: t.due,
          estimateMin: t.estimateMin, effectiveMin: eff, paddedMin: pad(eff, dayS.estimateMultiplier),
          carryCount: t.meta.carryCount, nextAction: t.meta.nextAction, optional: !!t.meta.optional && t.meta.mustDoDate === date, done: t.checked, lane,
        };
      };
      const used = snap.required.length;
      const blockers: string[] = [];
      if (cap.loadMin > cap.freeMin) blockers.push(`Planned work is ${cap.overByMin} minutes more than the time you have. Move, shrink, make optional, or drop something.`);
      if (used > s().mustDoCap) blockers.push(`${used} must-dos is over the limit of ${s().mustDoCap}. Swap one out or make one optional.`);
      return {
        date,
        cap: { limit: s().mustDoCap, used },
        mustDos: [...b.required.map((t) => view(t, 'must')), ...done.map((t) => view(t, 'must'))],
        optional: b.optional.map((t) => view(t, 'must')),
        homework: b.homework.map((t) => view(t, 'homework')),
        other: b.other.map((t) => view(t, 'other')),
        capacity: { loadMin: cap.loadMin, rawLoadMin: cap.rawLoadMin, freeMin: cap.freeMin, status: cap.status, overByMin: cap.overByMin, gaps: cap.gaps },
        multiplier: dayS.estimateMultiplier,
        acceptedAt: svc.acceptedAt(date),
        canAccept: blockers.length === 0,
        blockers,
        aiEnabled: !!ctx.maybe<any>('ai')?.enabled?.(),
      };
    },

    acceptedAt(date: ISODate): string | null {
      return ctx.db.get<{ accepted_at: string }>('SELECT accepted_at FROM plan_days WHERE date = ?', date)?.accepted_at ?? null;
    },
    accept(date: ISODate) {
      const p = svc.dayPlan(date);
      if (!p.canAccept) throw new PlanError(p.blockers[0], 409, { code: 'triage_first', blockers: p.blockers });
      const at_ = now().toISO()!;
      ctx.db.run(`INSERT INTO plan_days (date, accepted_at) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET accepted_at = excluded.accepted_at`, date, at_);
      ctx.bus.emit('plan.accepted', { date });
      return { ok: true, acceptedAt: at_ };
    },

    // ------------------------------------------------------------------ carry-over (SPEC 4.4)
    /**
     * Carry unfinished tasks to `toDate`. Tasks already carried 3 times are refused and returned in
     * `needsTriage`; Todoist failures are returned in `failed` (those tasks are left untouched).
     */
    async carry(taskIds: string[], toDate: ISODate, nextActions: Record<string, string> = {}) {
      const from = planningDate();
      const carried: string[] = [], needsTriage: string[] = [], failed: { taskId: string; error: string }[] = [];
      for (const id of taskIds) {
        const t = td().task(id);
        if (!t || t.checked) continue;
        if (t.meta.carryCount >= MAX_CARRIES) { needsTriage.push(id); continue; }
        try {
          // Never pull a later due date earlier; reschedule keeps recurrence.
          if (t.due && t.due.date < toDate) await td().reschedule(id, toDate);
        } catch (e: any) { failed.push({ taskId: id, error: e?.message ?? String(e) }); continue; }
        const count = t.meta.carryCount + 1;
        const patch: Partial<TaskMeta> = { carryCount: count, lastCarryDate: from };
        if (t.meta.mustDoDate && t.meta.mustDoDate < toDate) patch.mustDoDate = toDate;
        const next = nextActions[id]?.trim();
        if (next) patch.nextAction = next;
        td().setMeta(id, patch);
        ctx.bus.emit('task.carried', { taskId: id, count });
        carried.push(id);
      }
      return { carried, needsTriage, failed };
    },

    /** Carried 3 times and not yet decided. A 'first' or 'slot' decision holds until its day is over. */
    triageQueue(): Task[] {
      const pd = planningDate();
      const daytime = day().mode() === 'day';
      return td().tasks().filter((t) => {
        if (!eligible(t) || t.meta.carryCount < MAX_CARRIES) return false;
        const last = ctx.db.get<{ decision: string; target_date: string | null }>(
          `SELECT decision, target_date FROM plan_triage WHERE task_id = ? AND decision IN ('first', 'slot') ORDER BY at DESC LIMIT 1`, t.id);
        const live = !!last?.target_date && (last.target_date > pd || (last.target_date === pd && daytime));
        return !live;
      }).sort(urgency);
    },

    async triage(taskId: string, decision: 'first' | 'slot' | 'delegate' | 'drop', opts: { slotStart?: string; owner?: string; reason?: string; date?: ISODate } = {}) {
      const t = td().task(taskId);
      if (!t) throw new PlanError('Task not found', 404);
      if (t.checked) throw new PlanError('That task is already done.');
      let target: ISODate | null = null;
      let detail = '';
      let displaced: string | null = null;
      if (decision === 'first') {
        target = opts.date ?? addDays(planningDate(), 1);
        const required = mustDoSnapshot(target).required.filter((x) => x.id !== t.id);
        if (required.length >= s().mustDoCap) {
          // Slot #1 is for this task; the lowest-priority open must-do moves to optional.
          const victim = required.filter((x) => !x.checked).sort(urgency).at(-1);
          if (victim) { td().setMeta(victim.id, { optional: true }); await mirror(victim.id); displaced = victim.id; }
        }
        if (t.due && t.due.date < target) await td().reschedule(t.id, target);
        td().setMeta(t.id, { mustDoDate: target, optional: false });
        await mirror(t.id);
        detail = displaced ? `displaced ${displaced}` : '';
      } else if (decision === 'slot') {
        if (!opts.slotStart) throw new PlanError('Pick a start time for the slot.', 400);
        const start = fromISO(opts.slotStart);
        if (!start.isValid) throw new PlanError('That start time isn’t valid.', 400);
        target = start.toISODate()!;
        const minutes = Math.max(15, t.estimateMin || day().settings().defaultEstimateMin);
        await createBlock(t.content, start, start.plus({ minutes }), t.id);
        if (!t.due || t.due.date !== target) await td().reschedule(t.id, target);
        detail = start.toISO()!;
      } else if (decision === 'delegate') {
        const owner = opts.owner?.trim();
        if (!owner) throw new PlanError('Who is taking this? Add an owner.', 400);
        td().setMeta(t.id, { owner, mustDoDate: null, optional: false });
        await td().addLabel(t.id, 'waiting');
        await td().comment(t.id, `Delegated to ${owner}${opts.reason?.trim() ? `: ${opts.reason.trim()}` : ''}`);
        await mirror(t.id);
        detail = owner;
      } else if (decision === 'drop') {
        await td().drop(t.id, opts.reason?.trim() || `Carried ${t.meta.carryCount} times`);
        await mirror(t.id);
      } else {
        throw new PlanError('Unknown decision', 400);
      }
      ctx.db.run('INSERT INTO plan_triage (id, task_id, decision, target_date, detail, carry_count, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        uid(), taskId, decision, target, detail, t.meta.carryCount, now().toISO());
      ctx.bus.emit('task.triaged', { taskId, decision });
      return { ok: true, displaced };
    },

    // ------------------------------------------------------------------ urgency check (SPEC 4.4)
    needsUrgencyAnswer(taskId: string, priority: number): boolean {
      const t = td().task(taskId);
      return !!t && priority < t.priority;
    },
    /** The gate for marking something urgent or bumping its priority. Lowering a priority needs no answer. */
    async setPriority(taskId: string, priority: number, answer?: string) {
      if (!Number.isInteger(priority) || priority < 1 || priority > 4) throw new PlanError('Priority is 1 (urgent) to 4.', 400);
      const t = td().task(taskId);
      if (!t) throw new PlanError('Task not found', 404);
      if (priority === t.priority) return { ok: true, changed: false };
      const a = (answer ?? '').trim();
      if (priority < t.priority && !a) {
        throw new PlanError('What actually happens if this waits a week? Answer that first.', 400, { code: 'answer_required' });
      }
      if (a) {
        ctx.db.run('INSERT INTO plan_urgency (id, task_id, task_title, from_priority, to_priority, answer, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          uid(), taskId, t.content, t.priority, priority, a, now().toISO());
      }
      await td().update(taskId, { priority });
      ctx.bus.emit('plan.urgency_answered', { taskId, from: t.priority, to: priority });
      return { ok: true, changed: true };
    },
    urgencyAnswers(limit = 50) {
      return ctx.db.all<{ id: string; task_id: string; task_title: string; from_priority: number; to_priority: number; answer: string; at: string }>(
        'SELECT * FROM plan_urgency ORDER BY at DESC LIMIT ?', limit);
    },

    // ------------------------------------------------------------------ deep block and messages
    deepBlock(date: ISODate) {
      const e = blocksOn(date).find((x) => x.marginRef?.startsWith('deep:'));
      return e ? { eventId: e.id, start: e.start, end: e.end, project: e.title.replace(/^Deep work · /, '') } : null;
    },
    deepBlockInfo(date: ISODate) {
      const gaps = day().capacity(date).gaps.filter((g) => g.minutes >= 60);
      const list: { id: string; name: string }[] = projects()?.activeNonSchool?.().map((p: any) => ({ id: p.id, name: p.name }))
        ?? td().projects().filter((p) => !p.inbox).map((p) => ({ id: p.id, name: p.name }));
      return { date, minutes: s().deepBlockMin, block: svc.deepBlock(date), gaps, projects: list };
    },
    /** One 60–90 minute block per day, inside a free gap, never past the hard stop. Created on the click (source 'user'). */
    async createDeepBlock(input: { date: ISODate; project: string; start: string; minutes?: number }) {
      const minutes = input.minutes ?? s().deepBlockMin;
      if (!Number.isInteger(minutes) || minutes < 60 || minutes > 90) throw new PlanError('A deep block is 60 to 90 minutes.', 400);
      const project = input.project.trim();
      if (!project) throw new PlanError('Pick the one project this block is for.', 400);
      if (svc.deepBlock(input.date)) throw new PlanError('There’s already a deep block that day. One per day, on one project.');
      const start = /^\d{2}:\d{2}$/.test(input.start) ? at(input.date, input.start) : fromISO(input.start);
      if (!start.isValid) throw new PlanError('That start time isn’t valid.', 400);
      const end = start.plus({ minutes });
      if (input.date === planningDate() && start.toMillis() < now().toMillis()) throw new PlanError('That time has already passed.');
      const fits = day().capacity(input.date).gaps.some((g) => fromISO(g.start).toMillis() <= start.toMillis() && fromISO(g.end).toMillis() >= end.toMillis());
      if (!fits) throw new PlanError('That doesn’t fit a free gap before your stop. Pick a time inside one of the gaps.');
      return createBlock(`Deep work · ${project}`, start, end, `deep:${input.date}`);
    },

    messageSlots(date: ISODate) {
      const st = s().messageSlots;
      const a = day().anchors(date);
      const after = at(date, st.afterSchool);
      const shut = st.atShutdown ? at(date, st.atShutdown) : a.hardStop.minus({ minutes: 15 });
      const blocked = new Set(blocksOn(date).map((e) => e.marginRef));
      const slot = (id: string, label: string, start: DateTime) => ({
        id, label, time: start.toFormat('h:mm a'), start: start.toISO()!, end: start.plus({ minutes: MESSAGE_BLOCK_MIN }).toISO()!,
        blocked: blocked.has(`messages:${date}:${id}`),
      });
      return [slot('after_school', `Messages · ${after.toFormat('h:mm a')}`, after), slot('shutdown', 'Messages · at shutdown', shut)];
    },
    async createMessageBlock(date: ISODate, slotId: string) {
      const slot = svc.messageSlots(date).find((x) => x.id === slotId);
      if (!slot) throw new PlanError('Unknown message slot', 400);
      if (slot.blocked) throw new PlanError('That slot is already on your calendar.');
      return createBlock('Messages', fromISO(slot.start), fromISO(slot.end), `messages:${date}:${slotId}`);
    },

    // ------------------------------------------------------------------ rule conditions
    carryHotspot(count: number) {
      const proj = projects();
      const groups = new Map<string, { name: string; n: number }>();
      for (const t of td().tasks().filter((x) => eligible(x) && x.meta.carryCount >= 1)) {
        const p = proj?.projectForTask?.(t);
        const key = p?.id ?? t.projectId;
        const g = groups.get(key) ?? { name: p?.name ?? t.projectName, n: 0 };
        g.n++;
        groups.set(key, g);
      }
      const top = [...groups.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      if (!top || top[1].n < count) return { met: false };
      return { met: true, subject: top[0], detail: `${top[1].n} open tasks in ${top[1].name} have been carried over.` };
    },
    overCapacityDays(days: number) {
      const from = planningDate();
      const over = Array.from({ length: 7 }, (_, i) => addDays(from, i)).filter((d) => day().capacity(d).status === 'over');
      return { met: over.length >= days, detail: `${over.length} of the next 7 days have more planned than fits.` };
    },
  };
  return svc;
}
export type PlanService = ReturnType<typeof createPlanService>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export default defineModule({
  id: 'plan',
  name: 'Daily plan',
  description: 'Three must-dos, the homework lane, one deep block, batched messages, plan acceptance, carry-over and triage.',
  requires: ['day', 'todoist'],
  settings,
  migrations: [
    `CREATE TABLE plan_days (date TEXT PRIMARY KEY, accepted_at TEXT);
     CREATE TABLE plan_urgency (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_title TEXT NOT NULL DEFAULT '', from_priority INTEGER, to_priority INTEGER NOT NULL, answer TEXT NOT NULL, at TEXT NOT NULL);
     CREATE INDEX plan_urgency_task ON plan_urgency(task_id);
     CREATE TABLE plan_triage (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, decision TEXT NOT NULL, target_date TEXT, detail TEXT, carry_count INTEGER, at TEXT NOT NULL);
     CREATE INDEX plan_triage_task ON plan_triage(task_id, at);`,
  ],
  service: createPlanService,
  widgets: [
    { id: 'must-dos', slot: 'today.main', order: 10 },
    { id: 'homework', slot: 'today.main', order: 20 },
    { id: 'carry-triage', slot: 'today.main', order: 30 },
    { id: 'deep-block', slot: 'today.main', order: 40 },
    { id: 'messages', slot: 'today.main', order: 70 },
  ],
  emits: ['plan.accepted', 'task.carried', 'task.triaged', 'plan.urgency_answered'],
  on: {
    // Keep the Todoist must-do label in step with the flag, whoever changed it (UI, Claude's change set, shutdown).
    'task.meta_changed': (p, ctx) => {
      if (Array.isArray(p.keys) && p.keys.some((k: string) => k === 'mustDoDate' || k === 'optional')) return ctx.service<PlanService>('plan').mirror(p.taskId) as Promise<void>;
    },
    // A recurring must-do that was just completed is still open (next occurrence): start it fresh.
    'task.completed': (p, ctx) => {
      const td = ctx.service<TodoistService>('todoist');
      const t = td.task(p.taskId);
      if (t && !t.checked && (t.meta.mustDoDate || t.meta.carryCount)) {
        td.setMeta(p.taskId, { mustDoDate: null, optional: false, carryCount: 0, lastCarryDate: null, nextAction: null });
      }
    },
  },
  routes(r, ctx) {
    const plan = () => ctx.service<PlanService>('plan');
    const day = () => ctx.service<DayService>('day');
    const dateQ = (c: any) => c.req.query('date') ?? day().planningDate();
    /** Errors carry a status and, for the cap and the urgency gate, extra fields the UI acts on. */
    const guard = async (c: any, fn: () => unknown) => {
      try { return c.json(await fn()); }
      catch (e: any) {
        if (e instanceof PlanError) return c.json({ error: e.message, ...e.extra }, e.status);
        throw e;
      }
    };

    r.get('/day', (c) => c.json(plan().dayPlan(dateQ(c))));
    r.post('/accept', (c) => guard(c, async () => plan().accept(dateStr.parse((await c.req.json()).date ?? day().planningDate()))));

    r.post('/must-do', (c) => guard(c, async () => {
      const b = z.object({ taskId: z.string().min(1), date: dateStr.optional(), optional: z.boolean().optional(), swapOut: z.string().optional() }).parse(await c.req.json());
      return plan().addMustDo(b.taskId, b.date ?? day().planningDate(), b);
    }));
    r.post('/must-do/remove', (c) => guard(c, async () => { await plan().removeMustDo(z.object({ taskId: z.string() }).parse(await c.req.json()).taskId); return { ok: true }; }));

    r.post('/move', (c) => guard(c, async () => {
      const b = z.object({ taskIds: z.array(z.string()).min(1), date: dateStr }).parse(await c.req.json());
      const td = ctx.service<TodoistService>('todoist');
      if (b.taskIds.length === 1) { await td.reschedule(b.taskIds[0], b.date); return { ok: true }; }
      // Bulk moves wait for review.
      const set = ctx.changes.propose({
        source: 'bulk', title: `Move ${b.taskIds.length} tasks to ${at(b.date, '12:00').toFormat('EEE MMM d')}`,
        changes: b.taskIds.map((id) => ({ kind: 'todoist.task.reschedule', title: `Move “${td.task(id)?.content ?? id}” to ${b.date}`, payload: { taskId: id, date: b.date }, before: { date: td.task(id)?.due?.date ?? null } })),
      });
      return { ok: true, changeSetId: set.id };
    }));

    r.post('/priority', (c) => guard(c, async () => {
      const b = z.object({ taskId: z.string().min(1), priority: z.number().int().min(1).max(4), answer: z.string().optional() }).parse(await c.req.json());
      return plan().setPriority(b.taskId, b.priority, b.answer);
    }));
    r.get('/urgency', (c) => c.json(plan().urgencyAnswers()));

    r.post('/carry', (c) => guard(c, async () => {
      const b = z.object({ taskIds: z.array(z.string()), toDate: dateStr, nextActions: z.record(z.string(), z.string()).optional() }).parse(await c.req.json());
      return plan().carry(b.taskIds, b.toDate, b.nextActions);
    }));
    r.get('/triage-queue', (c) => c.json(plan().triageQueue().map((t) => ({
      id: t.id, content: t.content, projectName: t.projectName, carryCount: t.meta.carryCount, nextAction: t.meta.nextAction, estimateMin: t.estimateMin, due: t.due,
    }))));
    r.post('/triage', (c) => guard(c, async () => {
      const b = z.object({
        taskId: z.string().min(1), decision: z.enum(['first', 'slot', 'delegate', 'drop']),
        slotStart: z.string().optional(), owner: z.string().optional(), reason: z.string().optional(), date: dateStr.optional(),
      }).parse(await c.req.json());
      return plan().triage(b.taskId, b.decision, b);
    }));

    r.get('/deep-block', (c) => c.json(plan().deepBlockInfo(dateQ(c))));
    r.post('/deep-block', (c) => guard(c, async () => {
      const b = z.object({ date: dateStr, project: z.string(), start: z.string(), minutes: z.number().int().optional() }).parse(await c.req.json());
      return plan().createDeepBlock(b);
    }));
    r.get('/messages', (c) => c.json(plan().messageSlots(dateQ(c))));
    r.post('/messages/block', (c) => guard(c, async () => {
      const b = z.object({ date: dateStr, slot: z.enum(['after_school', 'shutdown']) }).parse(await c.req.json());
      return plan().createMessageBlock(b.date, b.slot);
    }));

    r.post('/ai-draft', (c) => guard(c, async () => {
      const ai = ctx.maybe<any>('ai');
      if (!ai?.enabled?.()) throw new PlanError('Claude isn’t turned on. Turn it on in Settings to draft a plan.');
      const date = dateStr.parse((await c.req.json().catch(() => ({}))).date ?? day().planningDate());
      const out = await ai.run('plan_day', { date });
      return { changeSetId: out.changeSetId ?? null, text: out.text ?? '' };
    }));
  },
  rules: {
    conditions: [
      {
        id: 'plan.carry_hotspot',
        label: 'Carry-over hotspot',
        description: 'One project has this many open tasks that were carried over. The subject is the project.',
        params: z.object({ count: z.number().int().min(1).default(2) }),
        evaluate: (ctx, p) => ctx.service<PlanService>('plan').carryHotspot(p.count),
      },
      {
        id: 'plan.over_capacity_days',
        label: 'Over capacity several days',
        description: 'This many of the next 7 days have more planned than fits before the stop.',
        params: z.object({ days: z.number().int().min(1).max(7).default(3) }),
        evaluate: (ctx, p) => ctx.service<PlanService>('plan').overCapacityDays(p.days),
      },
    ],
  },
  claude: {
    context(ctx) {
      const plan = ctx.service<PlanService>('plan');
      const date = ctx.service<DayService>('day').planningDate();
      const st = plan.mustDoState(date);
      return { mustDoCap: st.cap, mustDosToday: st.required.map((t) => t.content), needTriage: plan.triageQueue().length };
    },
    tools: [
      {
        name: 'get_today_plan',
        description: 'The plan for a date: must-dos (cap and how many are used), optional, homework, other due tasks with estimates, capacity, whether it was accepted, and tasks carried 3 times that need triage.',
        kind: 'read',
        input: z.object({ date: z.string().optional() }),
        run: (ctx, i) => {
          const plan = ctx.service<PlanService>('plan');
          const date = i.date ?? ctx.service<DayService>('day').planningDate();
          const p = plan.dayPlan(date);
          const slim = (t: PlanTaskView) => ({ id: t.id, content: t.content, project: t.projectName, priority: `p${t.priority}`, estimateMin: t.effectiveMin, carryCount: t.carryCount, nextAction: t.nextAction, done: t.done });
          return {
            date, mustDoCap: p.cap, mustDos: p.mustDos.map(slim), optional: p.optional.map(slim), homework: p.homework.map(slim), other: p.other.map(slim),
            capacity: { loadMin: p.capacity.loadMin, freeMin: p.capacity.freeMin, status: p.capacity.status, overByMin: p.capacity.overByMin },
            acceptedAt: p.acceptedAt,
            needsTriage: plan.triageQueue().map((t) => ({ id: t.id, content: t.content, carryCount: t.meta.carryCount })),
          };
        },
      },
      {
        name: 'propose_must_dos',
        description: 'Propose must-dos for a date as a change set. Respects the cap: only as many as there are free slots are proposed. Homework does not count toward the cap.',
        kind: 'propose',
        input: z.object({ date: z.string().optional(), taskIds: z.array(z.string()) }),
        run: (ctx, i) => {
          const plan = ctx.service<PlanService>('plan');
          const td = ctx.service<TodoistService>('todoist');
          const date = i.date ?? ctx.service<DayService>('day').planningDate();
          const st = plan.mustDoState(date);
          const already = new Set(st.required.map((t) => t.id));
          let free = st.cap - st.required.length;
          const out: { kind: string; title: string; payload: object; before: object }[] = [];
          for (const id of i.taskIds as string[]) {
            const t = td.task(id);
            if (!t || t.checked || already.has(id) || t.meta.owner || free <= 0) continue;
            free--;
            out.push({
              kind: 'task.meta', title: `Make “${t.content}” a must-do for ${at(date, '12:00').toFormat('EEE MMM d')}`,
              payload: { taskId: id, patch: { mustDoDate: date, optional: false } }, before: { mustDoDate: t.meta.mustDoDate, optional: t.meta.optional },
            });
          }
          return out;
        },
      },
    ],
  },
});
