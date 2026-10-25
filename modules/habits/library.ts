/**
 * The seed library (SPEC 8). Off unless chosen: nothing here is inserted until the person adds it,
 * or onboarding calls enablePhaseOne(). Each entry carries a one-line why with its source.
 * Sources mirror the sleep rules in the check-in module and the SPEC source list.
 */
import type { HabitType, Schedule } from './logic';

/** Which event feeds a habit automatically (so nothing is logged twice). */
export type AutoSource = 'wake' | 'lightsout' | 'shutdown' | 'review' | 'focus';

export interface LibraryHabit {
  key: string;
  name: string;
  why: string;
  cueAfter: string;
  cueWill: string;
  type: HabitType;
  target: number;
  schedule: (offDay: number) => Schedule;
  auto?: AutoSource;
}

const daily = (): Schedule => ({ kind: 'days', days: [1, 2, 3, 4, 5, 6, 7] });
const weekdays = (): Schedule => ({ kind: 'days', days: [1, 2, 3, 4, 5] });
const exceptOffDay = (offDay: number): Schedule => ({ kind: 'days', days: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== offDay) });

export const LIBRARY: LibraryHabit[] = [
  {
    key: 'fixed-wake', name: 'Fixed wake time', type: 'yesno', target: 1, schedule: daily, auto: 'wake',
    why: 'A steady wake time keeps sleep on schedule, weekends included (Wittmann 2006).',
    cueAfter: 'my alarm goes off', cueWill: 'get up within 30 minutes of my wake time',
  },
  {
    key: 'daylight', name: 'Daylight within 30 minutes', type: 'yesno', target: 1, schedule: daily,
    why: 'Morning light sets the body clock for the day (Wright 2013).',
    cueAfter: 'I get up', cueWill: 'step outside or sit by a bright window',
  },
  {
    key: 'caffeine-cutoff', name: 'Caffeine cutoff', type: 'yesno', target: 1, schedule: daily,
    why: 'Caffeine within about 6 hours of bed cuts sleep (Drake 2013).',
    cueAfter: 'lunch is over', cueWill: 'switch to water or decaf for the rest of the day',
  },
  {
    key: 'phone-out', name: 'Phone out of the bedroom', type: 'yesno', target: 1, schedule: daily,
    why: 'Devices at bedtime go with shorter, later sleep (Carter 2016).',
    cueAfter: 'I finish my shutdown', cueWill: 'plug my phone in outside the bedroom',
  },
  {
    key: 'shutdown-complete', name: 'Shutdown complete', type: 'yesno', target: 1, schedule: exceptOffDay, auto: 'shutdown',
    why: 'Detaching after hours has the strongest link to lower fatigue (Bennett 2018).',
    cueAfter: 'the stop notification arrives', cueWill: 'run the shutdown and tap Shutdown Complete',
  },
  {
    key: 'lights-out', name: 'Lights-out on time', type: 'yesno', target: 1, schedule: daily, auto: 'lightsout',
    why: 'Teens need 8 to 10 hours, and lights-out sets the window (AASM 2016).',
    cueAfter: 'the lights-out cue sounds', cueWill: 'put the phone down and turn off the light',
  },
  {
    key: 'breaks-50-10', name: '50/10 breaks', type: 'yesno', target: 1, schedule: () => ({ kind: 'perWeek', n: 3 }), auto: 'focus',
    why: 'Short breaks protect energy and focus (Albulescu 2022).',
    cueAfter: 'a focus block ends', cueWill: 'take ten minutes away from screens',
  },
  {
    key: 'message-batching', name: 'Message batching', type: 'yesno', target: 1, schedule: weekdays,
    why: 'Switching tasks leaves attention behind (Leroy 2009).',
    cueAfter: 'school ends', cueWill: 'answer messages in two slots, after school and at shutdown',
  },
  {
    key: 'weekly-review', name: 'Weekly review', type: 'yesno', target: 1, schedule: () => ({ kind: 'perWeek', n: 1 }), auto: 'review',
    why: 'Changing workload beats coping techniques (Panagioti 2017).',
    cueAfter: 'Sunday lunch', cueWill: 'open the weekly review and decide what to cut',
  },
  {
    key: 'off-day', name: 'Off-day', type: 'yesno', target: 1, schedule: (offDay) => ({ kind: 'days', days: [offDay] }),
    why: 'Fully detaching for a day is what restores (Bennett 2018).',
    cueAfter: 'I wake on my off-day', cueWill: 'leave the work views closed',
  },
  {
    key: 'leisure-after-shutdown', name: 'Leisure after shutdown', type: 'minutes', target: 30, schedule: weekdays,
    why: 'Time that has to produce nothing is what lets work let go (Bennett 2018).',
    cueAfter: 'shutdown is complete', cueWill: 'spend half an hour on something that doesn’t have to produce anything',
  },
];

/** Phase 1 turns on only these three. */
export const PHASE_ONE = ['fixed-wake', 'shutdown-complete', 'phone-out'] as const;

export const libraryEntry = (key: string) => LIBRARY.find((l) => l.key === key);
