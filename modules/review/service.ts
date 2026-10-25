/**
 * The review service: the weekly draft (autosaved), finishing it into ONE change set, scores history,
 * and the helpers the rule conditions use. Other modules call this through ctx.service('review').
 */
import type { Ctx } from '../../src/core/types';
import { j } from '../../src/core/db';
import { kvGet, kvSet } from '../../src/core/kv';
import { addDays, at, fromISO, now, today, weekStartOf, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import { assignSlots, buildChanges, firstWorkDay, slotOptions } from './changes';
import { autoStats, deadlineItems, offdayPanel, requiredSteps, triageList } from './context';
import { resolveSteps, type ReviewStep } from './steps';
import { composeSummary, type PastScores } from './summary';
import {
  emptyDecisions, emptyDraft, isNum, reviewWeek, safe,
  type Decisions, type Draft, type Priority, type ReviewSettings, type Scores,
} from './types';

export interface DraftPatch {
  step?: number;
  done?: Record<string, boolean>;
  scores?: Partial<Scores>;
  priorities?: Priority[];
  notes?: string;
  summary?: string;
  summarySource?: Draft['summarySource'];
  aiChangeSetId?: string | null;
  decisions?: Partial<Decisions>;
}
export interface ScoreRow { weekStart: ISODate; energy: number; dread: number; effective: number; sleepAvgMin: number | null; stopBreaks: number }

const fail = (message: string, status = 409) => Object.assign(new Error(message), { status });
const md = (d: ISODate) => fromISO(`${d}T12:00:00`).toFormat('MMM d');
const score = (v: unknown) => (v === null ? null : isNum(v) ? Math.max(0, Math.min(10, Math.round(v))) : undefined);

export function createReviewService(ctx: Ctx) {
  const settings = () => ctx.settings.get<ReviewSettings>('review');
  const day = () => ctx.service<DayService>('day');
  const week = (date: ISODate = today()) => reviewWeek(date, day().settings().weekStart, settings().reviewDay);

  function getDraft(ws: ISODate): Draft {
    const r = ctx.db.get('SELECT * FROM reviews WHERE week_start = ?', ws);
    if (!r) return emptyDraft(ws);
    const st = j<any>(r.state, {});
    return {
      ...emptyDraft(ws),
      step: st.step ?? 0, done: st.done ?? {}, scores: { ...emptyDraft(ws).scores, ...j(r.scores, {}) },
      priorities: j(r.priorities, []), notes: r.notes ?? '', summary: r.summary ?? '',
      summarySource: st.summarySource ?? null, aiChangeSetId: st.aiChangeSetId ?? null,
      decisions: { ...emptyDecisions(), ...(st.decisions ?? {}) },
      changeSetId: r.change_set_id, startedAt: r.started_at, updatedAt: r.updated_at, completedAt: r.completed_at,
    };
  }
  function putDraft(d: Draft, snap?: { sleepAvgMin: number | null; stopBreaks: number }) {
    ctx.db.run(
      `INSERT INTO reviews (week_start, scores, priorities, state, notes, summary, change_set_id, started_at, updated_at, completed_at, sleep_avg_min, stop_breaks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET scores = excluded.scores, priorities = excluded.priorities, state = excluded.state, notes = excluded.notes,
         summary = excluded.summary, change_set_id = excluded.change_set_id, started_at = excluded.started_at, updated_at = excluded.updated_at,
         completed_at = excluded.completed_at, sleep_avg_min = COALESCE(excluded.sleep_avg_min, reviews.sleep_avg_min), stop_breaks = COALESCE(excluded.stop_breaks, reviews.stop_breaks)`,
      d.weekStart, JSON.stringify(d.scores), JSON.stringify(d.priorities),
      JSON.stringify({ step: d.step, done: d.done, decisions: d.decisions, summarySource: d.summarySource, aiChangeSetId: d.aiChangeSetId }),
      d.notes, d.summary, d.changeSetId, d.startedAt, d.updatedAt, d.completedAt, snap?.sleepAvgMin ?? null, snap?.stopBreaks ?? null);
  }

  /** Completed reviews, oldest first. */
  function completed(limit = 60) {
    return ctx.db.all('SELECT * FROM reviews WHERE completed_at IS NOT NULL ORDER BY week_start DESC LIMIT ?', limit).reverse();
  }
  const pastScores = (before: ISODate): PastScores | null => {
    const r = ctx.db.get('SELECT * FROM reviews WHERE completed_at IS NOT NULL AND week_start < ? ORDER BY week_start DESC LIMIT 1', before);
    if (!r) return null;
    const s = j<Scores>(r.scores, null as any);
    return s && isNum(s.energy) && isNum(s.dread) && isNum(s.effective) ? { weekStart: r.week_start, energy: s.energy, dread: s.dread, effective: s.effective } : null;
  };

  const svc = {
    settings,
    week,
    getDraft,
    /** Scores of the last completed review before `before`, for week-over-week comparison. */
    previous: pastScores,

    /** The checklist: the editable `weekly-review` ritual when that module is on, else the nine steps from the spec. */
    steps(): ReviewStep[] {
      const ritual = safe<any>(() => ctx.maybe<any>('rituals')?.get?.('weekly-review'), null);
      return resolveSteps(ritual, requiredSteps(ctx).length > 0);
    },

    current() {
      const w = week();
      const draft = getDraft(w.weekStart);
      return { ...w, today: today(), due: svc.isDue(), completed: !!draft.completedAt, draft, steps: svc.steps(), durationMin: settings().durationMin };
    },

    /** Due from the review time on the review day until the week's review is finished. */
    isDue(): boolean {
      const w = week();
      return !getDraft(w.weekStart).completedAt && now().toMillis() >= at(w.reviewDate, settings().reviewTime).toMillis();
    },
    isCompleted(weekStart: ISODate) { return !!getDraft(weekStart).completedAt; },

    history() {
      return completed().reverse().map((r) => {
        const d = getDraft(r.week_start);
        return {
          weekStart: d.weekStart, completedAt: d.completedAt, scores: d.scores, priorities: d.priorities.map((p) => p.text),
          summary: d.summary, changeSetId: d.changeSetId, sleepAvgMin: r.sleep_avg_min as number | null, stopBreaks: r.stop_breaks as number | null,
        };
      });
    },

    /** Scores of the last `weeks` completed reviews, oldest first. Sleep and stop breaks are frozen at completion. */
    scores(weeks = 8): ScoreRow[] {
      return completed(weeks).flatMap((r): ScoreRow[] => {
        const s = j<Scores>(r.scores, null as any);
        if (!s || !isNum(s.energy) || !isNum(s.dread) || !isNum(s.effective)) return [];
        const live = r.sleep_avg_min == null || r.stop_breaks == null ? (() => { const lb = week(r.week_start).lookback; return autoStats(ctx, lb.from, lb.to); })() : null;
        return [{
          weekStart: r.week_start, energy: s.energy, dread: s.dread, effective: s.effective,
          sleepAvgMin: r.sleep_avg_min ?? live?.sleepAvgMin ?? null, stopBreaks: r.stop_breaks ?? live?.stopBreaks ?? 0,
        }];
      });
    },

    /** The last n completed reviews, or [] when they are not recent enough to say anything about now. */
    recent(n: number): ScoreRow[] {
      const rows = svc.scores(n);
      if (rows.length < n) return [];
      return rows[rows.length - 1].weekStart >= addDays(week().weekStart, -14) ? rows : [];
    },
    stableWeeks(n: number): boolean {
      const r = svc.recent(n);
      return r.length >= n && r.every((x, i) => x.dread < 7 && (i === 0 || (x.energy - r[i - 1].energy > -2 && x.effective - r[i - 1].effective > -2 && x.dread - r[i - 1].dread < 2)));
    },
    /** True when the most recent review day has passed without that week's review (or a later one) being finished. */
    missed() {
      const t = today();
      const w = week(t);
      const target = t > w.reviewDate ? w : week(addDays(w.weekStart, -1));
      const since = kvGet<ISODate>(ctx.db, 'review.since', t);
      const later = ctx.db.get('SELECT 1 FROM reviews WHERE completed_at IS NOT NULL AND week_start >= ?', target.weekStart);
      return { met: !later && target.reviewDate > since && target.reviewDate < t, weekStart: target.weekStart, reviewDate: target.reviewDate };
    },

    /** Autosave. Structural edits are refused once the review is finished; the summary and notes stay editable. */
    patch(p: DraftPatch): Draft {
      const w = week();
      const d = getDraft(w.weekStart);
      const s = settings();
      if (d.completedAt && Object.keys(p).some((k) => !['notes', 'summary', 'summarySource', 'aiChangeSetId'].includes(k))) throw fail('This week’s review is finished.');
      if (p.step !== undefined) d.step = Math.max(0, Math.min(svc.steps().length - 1, Math.round(p.step)));
      if (p.done) d.done = { ...d.done, ...p.done };
      if (p.scores) for (const k of ['energy', 'dread', 'effective'] as const) { const v = score(p.scores[k]); if (v !== undefined) d.scores[k] = v; }
      if (p.priorities) d.priorities = assignSlots(ctx, p.priorities.slice(0, 3), w.ahead, s.blockMin, s.blockEarliest);
      if (p.notes !== undefined) d.notes = p.notes;
      if (p.summary !== undefined) d.summary = p.summary;
      if (p.summarySource !== undefined) d.summarySource = p.summarySource;
      if (p.aiChangeSetId !== undefined) d.aiChangeSetId = p.aiChangeSetId;
      if (p.decisions) d.decisions = { ...d.decisions, ...p.decisions } as Decisions;
      d.startedAt ??= now().toISO();
      d.updatedAt = now().toISO();
      putDraft(d);
      return d;
    },

    slots(minutes = settings().blockMin) {
      return slotOptions(ctx, week().ahead, minutes, settings().blockEarliest, svc.getDraft(week().weekStart).priorities.flatMap((p) => (p.slot ? [p.slot] : [])));
    },

    /** The plain summary for the draft as it stands now. */
    plainSummary(d: Draft = getDraft(week().weekStart)): string {
      const w = week(d.weekStart);
      const lb = w.lookback;
      const deadlines = deadlineItems(ctx, today(), addDays(today(), 21));
      return composeSummary({
        draft: d, stats: autoStats(ctx, lb.from, lb.to), last: pastScores(d.weekStart), lookback: lb,
        carryOvers: triageList(ctx, lb.from).length,
        deadlinesWithoutPlan: deadlines.filter((x) => x.needsPlan && !x.planned && !d.decisions.deadlines[x.key]?.trim()).length,
        offdayDate: d.decisions.offday.date ?? offdayPanel(ctx).date,
      });
    },

    /**
     * Finish: check the review is complete, collect every external write into ONE change set (not applied),
     * freeze the numbers, and announce it. Local decisions (project statuses, check-ins) were already saved.
     */
    async finish(): Promise<{ changeSetId: string | null; changes: number; summary: string }> {
      const w = week();
      const d = getDraft(w.weekStart);
      if (d.completedAt) return { changeSetId: d.changeSetId, changes: 0, summary: d.summary };
      const steps = svc.steps();
      const { energy, dread, effective } = d.scores;
      if (energy == null || dread == null || effective == null) {
        throw fail(`Rate energy, dread and effective first (step ${Math.max(1, steps.findIndex((s) => s.panel === 'score') + 1)}).`);
      }
      const open = requiredSteps(ctx).filter((r) => !d.decisions.required[r.id]);
      if (open.length) {
        throw fail(`${open.map((r) => r.label).join(' and ')} must be done before this review can finish (step ${steps.findIndex((s) => s.panel === 'rules') + 1}).`);
      }
      const blocks = d.priorities.flatMap((p, n) => p.block && p.slot && p.text.trim() ? [{
        title: `Deep work: ${p.text.trim()}`, start: p.slot.start, end: p.slot.end,
        ref: p.ref?.type === 'task' ? p.ref.id : `review:${w.weekStart}:${n + 1}`, description: `Priority ${n + 1} from the weekly review of ${md(w.reviewDate)}.`,
      }] : []);
      const changes = buildChanges(ctx, {
        weekStart: w.weekStart, firstDay: firstWorkDay(ctx, w.ahead.from),
        triage: Object.entries(d.decisions.triage).map(([taskId, t]) => ({ taskId, ...t })),
        offdayMoves: Object.entries(d.decisions.offday.moves).map(([taskId, date]) => ({ taskId, date })),
        blocks,
      });
      const stats = autoStats(ctx, w.lookback.from, w.lookback.to);
      const text = d.summarySource === 'claude' && d.summary.trim() ? d.summary : svc.plainSummary(d);
      let changeSetId: string | null = null;
      if (changes.length) {
        const set = ctx.changes.propose({
          source: 'review', title: `Weekly review · ${md(w.reviewDate)}`,
          summary: `${changes.length} change${changes.length === 1 ? '' : 's'} decided in the weekly review. Nothing is written to Todoist or Google Calendar until you apply them.`,
          changes,
        });
        changeSetId = set.id;
      }
      d.summary = text;
      d.summarySource ??= 'margin';
      d.changeSetId = changeSetId;
      d.completedAt = now().toISO();
      d.updatedAt = d.completedAt;
      d.step = steps.length - 1;
      ctx.db.tx(() => {
        putDraft(d, { sleepAvgMin: stats.sleepAvgMin, stopBreaks: stats.stopBreaks });
        // Resolved required steps are done; anything a rule added meanwhile stays.
        kvSet(ctx.db, 'review.requiredSteps', requiredSteps(ctx).filter((r) => !d.decisions.required[r.id]));
      });
      ctx.bus.emit('review.completed', { weekStart: w.weekStart, changeSetId, changes: changes.length });
      return { changeSetId, changes: changes.length, summary: text };
    },
  };
  return svc;
}
export type ReviewService = ReturnType<typeof createReviewService>;
