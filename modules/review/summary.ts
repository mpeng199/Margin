/**
 * The plain, factual summary used when Claude is off (or unreachable). No praise, no guilt:
 * numbers, comparisons with last week, and what was decided.
 */
import { fmtDuration, fromISO, type ISODate } from '../../src/core/time';
import type { AutoStats } from './context';
import type { Draft } from './types';

export interface PastScores { weekStart: ISODate; energy: number; dread: number; effective: number }
const md = (d: ISODate) => fromISO(`${d}T12:00:00`).toFormat('MMM d');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const delta = (now: number, was: number) => (now === was ? 'no change' : `${now > was ? '+' : '−'}${Math.abs(now - was)}`);

export function composeSummary(i: {
  draft: Draft; stats: AutoStats; last: PastScores | null; lookback: { from: ISODate; to: ISODate };
  carryOvers: number; deadlinesWithoutPlan: number; offdayDate: ISODate | null;
}): string {
  const { draft: d, stats: s, last } = i;
  const lines: string[] = [];
  lines.push(`Review for the week of ${md(d.weekStart)}, looking back at ${md(i.lookback.from)} to ${md(i.lookback.to)}.`);

  const { energy, dread, effective } = d.scores;
  if (energy != null && dread != null && effective != null) {
    let l = `Scores: energy ${energy}, dread ${dread}, effective ${effective}.`;
    l += last
      ? ` Against the review of ${md(last.weekStart)}: energy ${delta(energy, last.energy)}, dread ${delta(dread, last.dread)}, effective ${delta(effective, last.effective)}.`
      : ' There is no earlier review to compare with yet.';
    lines.push(l);
  } else lines.push('Scores were not entered.');

  if (s.sleepAvgMin != null) {
    const gap = s.sleepTargetMin - s.sleepAvgMin;
    lines.push(`Sleep averaged ${fmtDuration(s.sleepAvgMin)} over ${plural(s.sleepNights, 'night')}, ${gap > 0 ? `${fmtDuration(gap)} under` : `${fmtDuration(-gap)} over`} the ${fmtDuration(s.sleepTargetMin)} target.`);
  } else lines.push('No sleep check-ins were recorded in this window.');

  let stop = s.stopBreaks === 0 ? 'The stop held every day.' : `The stop was broken ${plural(s.stopBreaks, 'time')} on ${plural(s.breakDays, 'day')}.`;
  if (s.shutdownDays != null) stop += ` Shutdown was completed on ${s.shutdownDays} of ${s.days} days.`;
  lines.push(stop);

  const t = Object.values(d.decisions.triage);
  const count = (k: string) => t.filter((x) => x.decision === k).length;
  if (i.carryOvers || t.length) {
    lines.push(`Carry-overs: ${plural(i.carryOvers, 'task')} carried this week. Decisions: ${count('move')} moved, ${count('first')} made first, ${count('delegate')} delegated, ${count('drop')} dropped${i.carryOvers > t.length ? `, ${i.carryOvers - t.length} left undecided` : ''}.`);
  } else lines.push('Nothing was carried over this week.');

  const pri = d.priorities.filter((p) => p.text.trim());
  if (pri.length) {
    lines.push(`Priorities for next week: ${pri.map((p, n) => `${n + 1}. ${p.text.trim()}${p.slot ? ` (block ${fromISO(p.slot.start).toFormat('EEE h:mm a')})` : ''}`).join(' ')}`);
  }

  const pc = d.decisions.projectChanges;
  if (pc.length) lines.push(`Project changes: ${pc.map((c) => `${c.name} ${c.from} to ${c.to}`).join('; ')}.`);
  const prop = Object.entries(d.decisions.proposed);
  if (prop.length) lines.push(`Proposed commitments: ${prop.filter(([, v]) => v.action === 'activate').length} activated, ${prop.filter(([, v]) => v.action === 'later').length} left proposed.`);
  const req = Object.values(d.decisions.required);
  if (req.length) lines.push(`Rule outcomes handled: ${req.map((r) => r.how).join('; ')}.`);
  const ci = Object.keys(d.decisions.checkins).length;
  if (ci) lines.push(`Owner check-ins logged: ${ci}.`);
  if (i.deadlinesWithoutPlan) lines.push(`${plural(i.deadlinesWithoutPlan, 'deadline')} in the next three weeks had no work time set aside.`);
  if (i.offdayDate) {
    const moved = Object.keys(d.decisions.offday.moves).length;
    lines.push(`Next off-day: ${md(i.offdayDate)}${moved ? `, ${plural(moved, 'task')} moved off it` : ''}.`);
  }
  if (d.notes.trim()) lines.push(`Notes: ${d.notes.trim()}`);
  return lines.join('\n');
}
