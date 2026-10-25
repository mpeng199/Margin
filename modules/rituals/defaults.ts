/**
 * Default rituals (SPEC 4.2, 4.9, 9). Pure data, so the shutdown module can fall back to it
 * when the rituals module is switched off. Step ids are stable: code keys off them, so a step can
 * be renamed or reordered without breaking the flow that renders it.
 */
export type RitualId = 'shutdown' | 'weekly-review' | 'morning';

export interface RitualStep {
  id: string;
  label: string;
  /** One-line reason shown under the step. */
  why?: string;
  /** Source for the why, e.g. "Masicampo & Baumeister 2011". */
  source?: string;
  /** Built-in step. Can be renamed and reordered; removing it asks for confirmation. */
  core?: boolean;
}
export interface Ritual { id: RitualId; name: string; steps: RitualStep[] }

export const RITUAL_IDS: RitualId[] = ['shutdown', 'weekly-review', 'morning'];

const step = (id: string, label: string, why: string, source?: string): RitualStep => ({ id, label, why, source, core: true });

export const DEFAULT_RITUALS: Record<RitualId, Ritual> = {
  shutdown: {
    id: 'shutdown',
    name: 'Shutdown',
    steps: [
      step('dump', 'Brain dump every open loop', 'Unfinished tasks keep nagging until they are written down somewhere you trust.', 'Masicampo & Baumeister 2011'),
      step('actions', 'Give each item a next action and a day or slot', 'A specific plan, not just a reminder, is what lets an unfinished task go.', 'Masicampo & Baumeister 2011'),
      step('must-dos', 'Choose tomorrow’s must-dos', 'A short, specific to-do list for tomorrow helped people fall asleep faster.', 'Scullin 2018'),
      step('tomorrow', 'Glance at tomorrow’s calendar', 'Knowing what tomorrow holds leaves nothing running in the background tonight.', 'Leroy 2009'),
      step('deadlines', 'Confirm every deadline in the next 72 hours is covered', 'A deadline with no plan is an open loop. Cover it, move it, or accept the risk on purpose.', 'Masicampo & Baumeister 2011'),
      step('phone', 'Phone goes out of the bedroom', 'Devices in the bedroom are linked to shorter, worse sleep in teens.', 'Carter 2016'),
      step('complete', 'Shutdown complete', 'Mentally detaching from work after hours has the strongest link to lower fatigue.', 'Bennett 2018'),
    ],
  },
  'weekly-review': {
    id: 'weekly-review',
    name: 'Weekly review',
    steps: [
      step('score', 'Score the week: energy, dread, effectiveness, sleep, stop breaks', 'The same few numbers every week turn a feeling into a trend, and show when to get help.', 'Bianchi 2021'),
      step('triage', 'Triage the carry-over list', 'A task that keeps rolling over needs a decision, not another day.', 'Masicampo & Baumeister 2011'),
      step('priorities', 'Set 3 priorities for the week', 'Naming what, when and where makes follow-through likelier.', 'Gollwitzer & Sheeran 2006'),
      step('wip', 'Check the WIP limit and project statuses', 'Changing workload and schedules beat individual coping techniques.', 'Panagioti 2017'),
      step('owners', 'Do the owner check-ins', 'Delegating a function only lowers your load if the check-in actually happens.', 'Panagioti 2017'),
      step('deadlines', 'Review deadlines for the next 3 weeks', 'Looking ahead keeps the urgent from crowding out the important.', 'Zhu, Yang & Hsee 2018'),
      step('rules', 'Apply rule outcomes', 'Rules you set while rested decide for you when you are tired.', 'Gollwitzer & Sheeran 2006'),
      step('proposed', 'Decide on Proposed commitments', 'A new yes starts as Proposed and activates only if something of equal size goes.', 'Panagioti 2017'),
      step('offday', 'Confirm the next off-day', 'One full day without work is the structural change worth protecting.', 'Panagioti 2017'),
    ],
  },
  morning: {
    id: 'morning',
    name: 'Morning',
    steps: [
      step('checkin', 'Check in (bedtime, wake, energy)', 'Under 30 seconds. It shows whether you are getting the 8 to 10 hours teens need.', 'AASM'),
      step('daylight', 'Daylight within 30 minutes of waking', 'Morning light helps set your body clock, so lights-out comes easier tonight.'),
      step('today', 'Glance at today', 'Seeing the day’s real size before it starts keeps the plan inside your capacity.', 'Panagioti 2017'),
    ],
  },
};

export const cloneRitual = (id: RitualId): Ritual => structuredClone(DEFAULT_RITUALS[id]);
