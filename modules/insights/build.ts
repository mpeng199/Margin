/**
 * Insights: gather from the other modules (all optional, via ctx.maybe) and hand the rows to the pure
 * aggregators. A section whose module is missing is omitted and named in `missing`; one that throws is
 * omitted and named in `failed`, so a broken module never takes the whole screen down.
 */
import { z } from 'zod';
import type { Ctx } from '../../src/core/types';
import { addDays, at, now, today, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { CalEvent } from '../google/manifest';
import {
  carryStats, eachDate, habitStats, mustDoStats, projectTime, stopAdherence, summarizeEnergy, summarizeSleep, toNights, weekStartsFor,
  type CarrySection, type EnergySection, type HabitSection, type MustDoSection, type ProjectTimeSection, type SleepSection, type StopSection,
} from './aggregate';

export type SectionKey = 'sleep' | 'energy' | 'stops' | 'carry' | 'mustDo' | 'projects' | 'habits';
export interface InsightsSummary {
  weeks: number;
  from: ISODate;
  to: ISODate;
  weekStarts: ISODate[];
  sleep?: SleepSection;
  energy?: EnergySection;
  stops?: StopSection;
  carry?: CarrySection;
  mustDo?: MustDoSection;
  projects?: ProjectTimeSection;
  habits?: HabitSection;
  /** Sections left out because the module that feeds them is off, with the module id(s) to turn on. */
  missing: Partial<Record<SectionKey, string>>;
  /** Sections left out because their module threw. */
  failed: SectionKey[];
}

export const MAX_WEEKS = 26;
export const weeksParam = z.coerce.number().int().min(1).max(MAX_WEEKS);

type Svc = Record<string, (...a: any[]) => any>;

export function buildSummary(ctx: Ctx, weeks: number): InsightsSummary {
  const day = ctx.maybe<DayService>('day');
  const weekStart = day?.settings().weekStart ?? 7;
  const to = today();
  const weekStarts = weekStartsFor(to, weeks, weekStart);
  const from = weekStarts[0];
  const out: InsightsSummary = { weeks, from, to, weekStarts, missing: {}, failed: [] };

  const section = <K extends SectionKey>(key: K, needs: string[], anyOf: boolean, run: (svcs: Record<string, any>) => InsightsSummary[K]) => {
    const svcs = Object.fromEntries(needs.map((id) => [id, ctx.maybe<Svc>(id)]));
    const have = needs.filter((id) => svcs[id]);
    if (anyOf ? have.length === 0 : have.length < needs.length) { out.missing[key] = (anyOf ? needs : needs.filter((id) => !svcs[id])).join(' or '); return; }
    try { out[key] = run(svcs); } catch (e: any) { ctx.log.warn(`insights: ${key} failed`, e?.message ?? e); out.failed.push(key); }
  };

  const entries = (svcs: Record<string, any>) => (svcs.checkin ? svcs.checkin.entries(from, to) : []);
  section('sleep', ['checkin'], false, (s) => summarizeSleep(entries(s)));

  section('energy', ['review', 'checkin'], true, (s) => {
    const scores = s.review ? (s.review.scores(weeks) as { weekStart: ISODate }[]).filter((x) => x.weekStart >= from) : [];
    return summarizeEnergy(scores, toNights(entries(s)));
  });

  section('stops', ['shutdown'], false, (s) => {
    const history: any[] = s.shutdown.history(from, to) ?? [];
    return stopAdherence({
      from, today: to, weekStarts, weekStart,
      // A history row counts as a completed shutdown unless it says otherwise.
      shutdowns: history.map((h) => ({ date: h.date, completed: !('completedAt' in h || 'completed_at' in h) || !!(h.completedAt ?? h.completed_at) })),
      breaks: day ? day.stopBreaks(from, to) : [],
    });
  });

  // Carry-overs come from the core events table; the plan module only adds the waiting count.
  try {
    const events = ctx.bus.since('task.carried', at(from, '00:00').toISO()!);
    const plan = ctx.maybe<Svc>('plan');
    if (!plan && !events.length) out.missing.carry = 'plan';
    else out.carry = carryStats({ events, weekStarts, weekStart, waiting: plan ? plan.triageQueue().length : null });
  } catch (e: any) { ctx.log.warn('insights: carry failed', e?.message ?? e); out.failed.push('carry'); }

  section('mustDo', ['todoist'], false, (s) => {
    const planned = eachDate(from, to).flatMap((date) =>
      (s.todoist.tasks({ mustDoOn: date, includeDone: true }) as any[]).map((t) => ({ taskId: t.id as string, date, optional: !!t.meta?.optional })));
    return mustDoStats({ planned, completions: s.todoist.completions(from, to), weekStarts, weekStart });
  });

  section('projects', ['focus', 'google'], true, (s) => {
    const focus = s.focus ? s.focus.timeLogs({ from, to }) : [];
    const events: CalEvent[] = s.google ? s.google.eventsBetween(at(from, '00:00').toISO()!, at(addDays(to, 1), '00:00').toISO()!) : [];
    const projects = ctx.maybe<{ list(): { id: string; name: string; color: string; weeklyBudgetMin: number }[] }>('projects')?.list() ?? [];
    return projectTime({ focus, events: events.filter((e) => e.projectId), projects, weeks, now: now().toISO()! });
  });

  section('habits', ['habits'], false, (s) => habitStats(s.habits.list(), (id, days) => s.habits.consistency(id, days)));

  return out;
}

/**
 * What Claude may see. Sleep, check-in energy and the three weekly ratings are wellbeing data and are
 * withheld unless the person turned on sharing (missing = off, same rule as the check-in tool).
 * Per-night and per-day arrays are dropped; the weekly rows and the plain summary lines stay.
 */
export function metricsForClaude(summary: InsightsSummary, shareWellbeing: boolean) {
  const { sleep, energy, stops, carry, mustDo, projects, habits, ...head } = summary;
  const out: Record<string, unknown> = { ...head };
  if (shareWellbeing && sleep) { const { nights, ...rest } = sleep; out.sleep = rest; }
  if (shareWellbeing && energy) { const { daily, ...rest } = energy; out.energy = rest; }
  if (!shareWellbeing && (sleep || energy)) out.withheld = ['sleep', 'energy'];
  if (stops) out.stops = stops;
  if (carry) out.carry = carry;
  if (mustDo) out.mustDo = mustDo;
  if (projects) out.projects = projects;
  if (habits) out.habits = habits;
  return out;
}
