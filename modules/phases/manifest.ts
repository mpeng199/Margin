/**
 * phases — recovery phases (SPEC 4.10). Stabilize (weeks 1-2) → Recover (3-8) → Rebuild (month 3+),
 * counted from `phase1Start`. Rebuild also needs 3 steady weekly scores, otherwise it stays in Recover and says why.
 * Nothing new is added back before Rebuild; in Rebuild, one commitment at a time.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { kvGet, kvSet } from '../../src/core/kv';
import { today, addDays, daysBetween, type ISODate } from '../../src/core/time';

export type Phase = 'stabilize' | 'recover' | 'rebuild';

export const PHASE_RULES: Record<Phase, string[]> = {
  stabilize: ['Hold the stop every night.', 'Sleep before everything.', 'Deload training.', 'Nothing new.'],
  recover: ['Keep the stop.', 'Cut what the review flags.', 'Protect the off-day.'],
  rebuild: ['Re-add one commitment at a time, after 3 stable weeks.'],
};
export const PHASE_NAMES: Record<Phase, string> = { stabilize: 'Stabilize', recover: 'Recover', rebuild: 'Rebuild' };
const PHASE_WEEKS: Record<Phase, number | null> = { stabilize: 2, recover: 8, rebuild: null };
/** How many weeks in a row of steady scores Rebuild (and each re-added commitment) needs. */
export const STABLE_WEEKS_NEEDED = 3;
/** After re-adding a commitment, wait this long before the next one. */
const ONE_AT_A_TIME_DAYS = STABLE_WEEKS_NEEDED * 7;

const settings = z.object({
  phase1Start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('').describe('First day of the plan. Onboarding sets this. Blank = your first check-in, or today.'),
  override: z.enum(['auto', 'stabilize', 'recover', 'rebuild']).default('auto').describe('Choose a phase by hand. Auto follows the calendar and your weekly scores.'),
});
type Settings = z.infer<typeof settings>;

export interface PhaseInfo {
  phase: Phase;
  /** Week number counted from the start date (1 = the first week). */
  week: number;
  startDate: ISODate;
  rules: string[];
  /** How many weeks this phase runs (null = open-ended). */
  phaseWeeks: number | null;
  /** True when the phase was chosen by hand. */
  override: boolean;
  /** Why the calendar says Rebuild but the phase is still Recover. */
  holdReason?: string;
  /** Steady weekly scores in a row, most recent first. */
  stableWeeks: number;
}

interface Score { weekStart: string; energy: number | null; dread: number | null }

export function createPhasesService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('phases');

  /** Consecutive steady weeks ending with the latest score: energy not lower, dread not higher than the week before. */
  function stability(): { stable: number; haveReview: boolean; lastIssue?: string } {
    const review = ctx.maybe<{ scores(weeks: number): Score[] }>('review');
    if (!review) return { stable: 0, haveReview: false };
    const scores = [...(review.scores(STABLE_WEEKS_NEEDED + 1) ?? [])].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    let stable = 0;
    let lastIssue: string | undefined;
    for (let i = scores.length - 1; i >= 1; i--) {
      const cur = scores[i], prev = scores[i - 1];
      const known = cur.energy != null && prev.energy != null && cur.dread != null && prev.dread != null;
      const energyDown = known && cur.energy! < prev.energy!;
      const dreadUp = known && cur.dread! > prev.dread!;
      if (known && !energyDown && !dreadUp) { stable++; continue; }
      if (stable === 0) lastIssue = !known ? 'a week was missing its scores' : energyDown ? 'energy was lower than the week before' : 'dread was higher than the week before';
      break;
    }
    return { stable, haveReview: true, lastIssue };
  }

  function startDate(): ISODate {
    const set = s().phase1Start;
    if (set) return set;
    const first = ctx.maybe<any>('checkin')?.entries?.('2000-01-01', today())?.[0]?.date;
    return first ?? today();
  }

  const svc = {
    settings: s,

    current(): PhaseInfo {
      const start = startDate();
      const week = Math.max(1, Math.floor(daysBetween(start, today()) / 7) + 1);
      const calendar: Phase = week <= 2 ? 'stabilize' : week <= 8 ? 'recover' : 'rebuild';
      const { stable, haveReview, lastIssue } = stability();
      const ov = s().override;
      let phase = calendar;
      let holdReason: string | undefined;
      if (ov !== 'auto') phase = ov;
      else if (calendar === 'rebuild' && stable < STABLE_WEEKS_NEEDED) {
        phase = 'recover';
        holdReason = haveReview
          ? `Rebuild starts after ${STABLE_WEEKS_NEEDED} weekly scores in a row where energy didn’t drop and dread didn’t rise. ${stable} so far${lastIssue ? `; last time ${lastIssue}` : ''}.`
          : `Rebuild starts after ${STABLE_WEEKS_NEEDED} steady weekly scores. Turn on the weekly review so Margin can see them.`;
      }
      return {
        phase, week, startDate: start, rules: PHASE_RULES[phase], phaseWeeks: PHASE_WEEKS[phase],
        override: ov !== 'auto', holdReason, stableWeeks: stable,
      };
    },

    /** Nothing new before Rebuild. In Rebuild, one at a time, each after 3+ steady weeks. */
    canAddCommitment(): { allowed: boolean; reason?: string } {
      const cur = svc.current();
      if (cur.phase !== 'rebuild') {
        return { allowed: false, reason: `Nothing new is added before Rebuild. You’re in ${PHASE_NAMES[cur.phase]}, week ${cur.week}.${cur.holdReason ? ` ${cur.holdReason}` : ''}` };
      }
      if (cur.stableWeeks < STABLE_WEEKS_NEEDED) {
        return { allowed: false, reason: `Re-add a commitment after ${STABLE_WEEKS_NEEDED} steady weekly scores. ${cur.stableWeeks} so far.` };
      }
      const last = kvGet<{ date: ISODate } | null>(ctx.db, 'phases.lastAdded', null);
      if (last && daysBetween(last.date, today()) < ONE_AT_A_TIME_DAYS) {
        return { allowed: false, reason: `One at a time. You added one on ${last.date}; see how it holds until ${addDays(last.date, ONE_AT_A_TIME_DAYS)}.` };
      }
      return { allowed: true };
    },
  };
  return svc;
}
export type PhasesService = ReturnType<typeof createPhasesService>;

export default defineModule({
  id: 'phases',
  name: 'Recovery phases',
  description: 'Stabilize, Recover, Rebuild: what to hold at each stage, and when adding anything back is allowed.',
  settings,
  service: createPhasesService,
  emits: ['phase.changed'],
  widgets: [{ id: 'phase', slot: 'today.banner', order: 0 }],
  on: {
    // A commitment becoming active is a re-add; the next one waits.
    'project.status_changed': (p, ctx) => {
      const active = ['core', 'maintain'];
      if (active.includes(p.to) && !active.includes(p.from)) kvSet(ctx.db, 'phases.lastAdded', { date: today(), id: p.id });
    },
  },
  jobs: [{
    id: 'phase-watch',
    every: 30,
    run(ctx) {
      const cur = ctx.service<PhasesService>('phases').current().phase;
      const prev = kvGet<Phase | null>(ctx.db, 'phases.last', null);
      if (prev !== cur) {
        kvSet(ctx.db, 'phases.last', cur);
        if (prev) ctx.bus.emit('phase.changed', { from: prev, to: cur });
      }
    },
  }],
  routes(r, ctx) {
    const svc = () => ctx.service<PhasesService>('phases');
    r.get('/current', (c) => c.json(svc().current()));
    r.get('/can-add', (c) => c.json(svc().canAddCommitment()));
  },
  claude: {
    context: (ctx) => {
      const p = ctx.service<PhasesService>('phases').current();
      return { phase: p.phase, week: p.week, rules: p.rules };
    },
  },
});
