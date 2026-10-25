/**
 * Everything the review writes outside Margin goes into ONE change set, built here:
 * reschedules, drops, delegation labels/notes, and deep-work blocks on the Margin Blocks calendar.
 * Also: finding room for those blocks (capacity gaps before the stop, never on the off-day).
 */
import type { DateTime } from 'luxon';
import type { Ctx } from '../../src/core/types';
import type { ProposedChange } from '../../src/core/changesets';
import { addDays, dateOf, freeGaps, fromISO, getZone, later, minutesBetween, at, now, today, type HHMM, type ISODate, type Interval } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { TodoistService, TaskMeta } from '../todoist/manifest';
import type { Priority, Slot, TriageDecision } from './types';

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const nice = (date: ISODate) => fromISO(`${date}T12:00:00`).toFormat('EEE MMM d');
const q = (s: string) => `“${s}”`;

// ---------------------------------------------------------------------------------------------- slots

export interface SlotOption extends Slot { date: ISODate; minutes: number }

/** Round up to the next quarter hour (elapsed minutes, so DST does not matter). */
function ceil15(dt: DateTime): DateTime {
  const t = dt.startOf('minute');
  const r = t.minute % 15;
  return r ? t.plus({ minutes: 15 - r }) : t;
}

/**
 * Places for a deep-work block of `minutes`: one per free gap, on days that still have room after
 * planned load (padded estimates), never on the off-day, never over an existing Margin block.
 */
export function slotOptions(ctx: Ctx, range: { from: ISODate; to: ISODate }, minutes: number, earliest: HHMM, taken: Slot[] = []): SlotOption[] {
  const day = ctx.service<DayService>('day');
  const takenIv: Interval[] = taken.map((t) => ({ start: fromISO(t.start), end: fromISO(t.end) }));
  const out: SlotOption[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    if (day.isOffDay(d)) continue;
    const cap = day.capacity(d);
    if (cap.freeMin - cap.loadMin < minutes) continue;
    const blocked: Interval[] = [
      ...day.timeline(d).filter((i) => i.source === 'block' && !i.allDay).map((i) => ({ start: fromISO(i.start), end: fromISO(i.end) })),
      ...takenIv,
    ];
    const notBefore = at(d, earliest);
    for (const g of cap.gaps) {
      const window = { start: later(fromISO(g.start), notBefore), end: fromISO(g.end) };
      for (const f of freeGaps(window, blocked, minutes)) {
        const start = ceil15(f.start);
        if (minutesBetween(start, f.end) < minutes) continue;
        out.push({ date: d, start: start.toISO()!, end: start.plus({ minutes }).toISO()!, minutes });
      }
    }
  }
  return out;
}

/** Give every priority that wants a block a slot (keeping the ones it already has). Clears slots when block is off. */
export function assignSlots(ctx: Ctx, priorities: Priority[], range: { from: ISODate; to: ISODate }, minutes: number, earliest: HHMM): Priority[] {
  const out = priorities.map((p) => ({ ...p, slot: p.block ? p.slot : null }));
  const taken: Slot[] = out.flatMap((p) => (p.slot ? [p.slot] : []));
  for (const p of out) {
    if (!p.block || p.slot) continue;
    const used = new Set(taken.map((t) => dateOf(fromISO(t.start))));
    const opts = slotOptions(ctx, range, minutes, earliest, taken);
    const pick = opts.find((o) => !used.has(o.date)) ?? opts[0];
    if (pick) { p.slot = { start: pick.start, end: pick.end }; taken.push(p.slot); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- change set

export interface ReviewPlan {
  weekStart: ISODate;
  /** Day a "do first" task is scheduled on: the first non-off-day after the review. */
  firstDay: ISODate;
  triage: ({ taskId: string } & TriageDecision)[];
  offdayMoves: { taskId: string; date: ISODate }[];
  blocks: { title: string; start: string; end: string; ref?: string; description?: string }[];
}

export function firstWorkDay(ctx: Ctx, from: ISODate): ISODate {
  const day = ctx.maybe<DayService>('day');
  let d = from;
  for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (!day?.isOffDay(d)) return d;
  return from;
}

export function buildChanges(ctx: Ctx, plan: ReviewPlan): ProposedChange[] {
  const td = ctx.service<TodoistService>('todoist');
  const day = ctx.service<DayService>('day');
  const t0 = today();

  const resched = new Map<string, ISODate>();
  const meta = new Map<string, Partial<TaskMeta>>();
  const drops: ProposedChange[] = [];
  const labels: ProposedChange[] = [];
  const dropped = new Set<string>();

  for (const d of plan.triage) {
    const task = td.task(d.taskId);
    if (!task || task.checked) continue;
    const name = q(task.content);
    const reset = { carryCount: 0, lastCarryDate: null as string | null };
    if (d.decision === 'move') {
      if (!d.date || d.date <= t0) throw fail(`Pick a date after today for ${name}.`);
      resched.set(task.id, d.date);
      meta.set(task.id, { ...reset, mustDoDate: null });
    } else if (d.decision === 'first') {
      resched.set(task.id, plan.firstDay);
      meta.set(task.id, { ...reset, mustDoDate: plan.firstDay });
    } else if (d.decision === 'delegate') {
      const owner = (d.owner ?? '').trim();
      if (!owner) throw fail(`Name who owns ${name} before delegating it.`);
      meta.set(task.id, { ...reset, owner, mustDoDate: null });
      labels.push({ kind: 'todoist.task.label', title: `Label ${name} as waiting on ${owner}`, payload: { taskId: task.id, label: 'waiting' }, before: { labels: task.labels } });
    } else {
      dropped.add(task.id);
      drops.push({ kind: 'todoist.task.drop', title: `Drop ${name}`, payload: { taskId: task.id, reason: d.reason?.trim() || 'Dropped in the weekly review' }, before: { due: task.due?.date ?? null } });
    }
  }
  // Off-day moves come later in the review, so they win over an earlier move of the same task.
  for (const m of plan.offdayMoves) {
    const task = td.task(m.taskId);
    if (!task || task.checked || dropped.has(task.id)) continue;
    if (m.date <= t0) throw fail(`Pick a date after today for ${q(task.content)}.`);
    resched.set(task.id, m.date);
    meta.set(task.id, { ...(meta.get(task.id) ?? {}) });
  }

  const out: ProposedChange[] = [];
  for (const [taskId, date] of resched) {
    const task = td.task(taskId)!;
    const first = meta.get(taskId)?.mustDoDate === date && date === plan.firstDay;
    out.push({
      kind: 'todoist.task.reschedule',
      title: first ? `Make ${q(task.content)} the first thing on ${nice(date)}` : `Move ${q(task.content)} to ${nice(date)}`,
      payload: { taskId, date }, before: { date: task.due?.date ?? null },
    });
  }
  out.push(...labels, ...drops);
  for (const [taskId, patch] of meta) {
    if (!Object.keys(patch).length) continue;
    const task = td.task(taskId)!;
    out.push({
      kind: 'task.meta', title: `Record the decision on ${q(task.content)} in Margin`, payload: { taskId, patch },
      before: { carryCount: task.meta.carryCount, mustDoDate: task.meta.mustDoDate, owner: task.meta.owner },
    });
  }
  for (const b of plan.blocks) {
    const s = fromISO(b.start), e = fromISO(b.end);
    if (!s.isValid || !e.isValid || e <= s) throw fail(`The block ${q(b.title)} has no valid time.`);
    if (s.toMillis() < now().toMillis()) throw fail(`The block ${q(b.title)} starts in the past.`);
    const stop = day.anchors(dateOf(s)).effectiveStop;
    if (e.toMillis() > stop.toMillis()) throw fail(`The block ${q(b.title)} ends after the stop (${stop.toFormat('h:mm a')}). Pick another slot.`, 409);
    out.push({
      kind: 'gcal.event.create',
      title: `Block ${q(b.title)} ${s.setZone(getZone()).toFormat('EEE h:mm')}–${e.setZone(getZone()).toFormat('h:mm a')}`,
      payload: { title: b.title, start: b.start, end: b.end, marginKind: 'block', marginRef: b.ref, description: b.description },
    });
  }
  return out;
}
