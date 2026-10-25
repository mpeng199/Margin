/**
 * The nine weekly-review steps (SPEC 4.9). The checklist itself comes from the editable `rituals`
 * module when it is on; this file is the fallback and the map from a ritual step to the panel that
 * renders it. A step the map does not know still shows up, as a plain "done" step.
 */

export type Panel =
  | 'score' | 'triage' | 'priorities' | 'wip' | 'checkins' | 'deadlines' | 'rules' | 'proposed' | 'offday' | 'generic';

export interface RitualStep { id: string; label: string; why?: string; source?: string }
export interface ReviewStep { id: string; panel: Panel; label: string; why: string; source: string | null }

/** Canonical order. `why` carries its source in the words, `source` is the citation shown beside it. */
export const DEFAULT_STEPS: (ReviewStep & { alias: RegExp })[] = [
  { id: 'score', panel: 'score', alias: /score|rate|rating/i, label: 'Score the week',
    why: 'Same three ratings every week, so a trend shows up in numbers instead of in how the week is remembered.', source: 'Panagioti 2017' },
  { id: 'triage', panel: 'triage', alias: /triage|carry/i, label: 'Triage the carry-over list',
    why: 'A task that rolled three times gets a decision, not a fourth roll. A specific plan stops it from nagging.', source: 'Masicampo & Baumeister 2011' },
  { id: 'priorities', panel: 'priorities', alias: /priorit/i, label: 'Set 3 priorities',
    why: 'Three is the cap. Saying when and where makes a priority more likely to happen than a vague intention.', source: 'Gollwitzer & Sheeran 2006' },
  { id: 'wip', panel: 'wip', alias: /wip|status|limit/i, label: 'Check the WIP limit and project statuses',
    why: 'Carrying less beats coping better, so the number of active projects is capped.', source: 'Panagioti 2017' },
  { id: 'checkins', panel: 'checkins', alias: /check-?in|owner|deleg/i, label: 'Do the owner check-ins',
    why: 'A written check-in is what keeps a delegated function from drifting back to you.', source: 'Panagioti 2017' },
  { id: 'deadlines', panel: 'deadlines', alias: /deadline/i, label: 'Review deadlines for the next 3 weeks',
    why: 'Looking three weeks out lets you choose what to work on before urgency chooses for you.', source: 'Zhu, Yang & Hsee 2018' },
  { id: 'rules', panel: 'rules', alias: /rule|outcome/i, label: 'Apply rule outcomes',
    why: 'These rules were written in advance so you do not have to negotiate with them tired.', source: 'Gollwitzer & Sheeran 2006' },
  { id: 'proposed', panel: 'proposed', alias: /propos|commit/i, label: 'Decide on Proposed commitments',
    why: 'Yes requires a no: a new commitment only starts in exchange for something of equal size.', source: 'Panagioti 2017' },
  { id: 'offday', panel: 'offday', alias: /off-?day|day off/i, label: 'Confirm the next off-day',
    why: 'One full day without work is the recovery that detaching after hours cannot replace.', source: 'Bennett 2018' },
];

const BY_ID = new Map(DEFAULT_STEPS.map((s) => [s.id, s]));

/** Match a ritual step to a panel: exact id, then keyword in id/label, then position. */
function panelFor(step: RitualStep, index: number, count: number): ReviewStep {
  const exact = BY_ID.get(step.id);
  const loose = exact ?? DEFAULT_STEPS.find((d) => d.alias.test(step.id) || d.alias.test(step.label));
  // A ritual that was reordered or renamed wholesale but still has the original nine steps: go by position.
  const byPos = !loose && count === DEFAULT_STEPS.length ? DEFAULT_STEPS[index] : undefined;
  const base = loose ?? byPos;
  return {
    id: step.id,
    panel: base?.panel ?? 'generic',
    label: step.label || base?.label || 'Step',
    why: step.why ?? base?.why ?? '',
    source: step.source ?? base?.source ?? null,
  };
}

/**
 * Steps to show. Always includes the rules panel, even if the checklist was edited to drop it,
 * because required steps from rules must be resolvable before the review can finish.
 */
export function resolveSteps(ritual: { steps: RitualStep[] } | null | undefined, needsRules: boolean): ReviewStep[] {
  const raw = ritual?.steps?.length ? ritual.steps : DEFAULT_STEPS.map(({ id, label, why, source }) => ({ id, label, why, source: source ?? undefined }));
  const steps = raw.map((s, i) => panelFor(s, i, raw.length));
  if (needsRules && !steps.some((s) => s.panel === 'rules')) {
    const r = BY_ID.get('rules')!;
    steps.splice(Math.max(0, steps.length - 2), 0, { id: r.id, panel: r.panel, label: r.label, why: r.why, source: r.source });
  }
  return steps;
}
