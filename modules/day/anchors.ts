/**
 * Day anchors (SPEC 4.1). Pure functions — no DB — so they're easy to test across DST.
 *
 * Night of date D = the evening of D, ending at wake on D+1.
 *   lightsOut(D) = the EARLIER of
 *       (a) wall clock:  wake(D+1) − 8h30m read on the clock   (e.g. 6:30 → 10:00 PM)
 *       (b) elapsed:     wake(D+1) instant − 8h30m of real time
 *     On ordinary nights (a) == (b). On the fall-back night (Nov 1, 2026) (a) is earlier and
 *     gives 9h30m in bed; on the spring-forward night (b) is earlier so sleep is never squeezed.
 *     Either way the stop never moves later than the clock time you're used to.
 *   hardStop(D) = lightsOut(D) − wind-down (60 min).
 *   School nights: an override can move the stop earlier, never later than the base computation.
 *   Late night (declared before 4 PM, ≤1/week): stop moves later by ≤60 min; lights-out stays put.
 */
import type { DateTime } from 'luxon';
import { at, addDays, weekday, earlier, toMinutes, fromMinutes, minutesBetween, type ISODate, type HHMM } from '../../src/core/time';

export interface AnchorSettings {
  wakeTime: HHMM;
  /** Mon..Sun (index 0 = Monday). null = use wakeTime. */
  weekdayWake: (HHMM | null)[];
  /** Per-date wake overrides. */
  dateWake: Record<ISODate, HHMM>;
  sleepNeedMin: number;
  fallAsleepMin: number;
  windDownMin: number;
  /** ISO weekdays (1=Mon) that are school days; the night before one is a school night. */
  schoolDays: number[];
}

export interface Anchors {
  date: ISODate;
  wake: DateTime;
  lightsOut: DateTime;
  hardStop: DateTime;
  /** Stop after any declared late-night extension. */
  effectiveStop: DateTime;
  nextWake: DateTime;
  schoolNight: boolean;
  lateNightMin: number;
  /** Real minutes between lights-out and next wake. */
  sleepWindowMin: number;
  /** Human-readable derivation for onboarding/settings. */
  math: string[];
  notes: string[];
}

export function wakeFor(s: AnchorSettings, date: ISODate): HHMM {
  return s.dateWake[date] ?? s.weekdayWake[weekday(date) - 1] ?? s.wakeTime;
}

function lightsOutFor(s: AnchorSettings, date: ISODate, wakeHHMM: HHMM): DateTime {
  const next = addDays(date, 1);
  const wakeInstant = at(next, wakeHHMM);
  const gap = s.sleepNeedMin + s.fallAsleepMin;
  // (a) wall-clock subtraction, resolved on whichever date it lands
  const wallMin = toMinutes(wakeHHMM) - gap;
  const wall = wallMin >= 0 ? at(next, fromMinutes(wallMin)) : at(date, fromMinutes(wallMin + 1440));
  // (b) elapsed subtraction
  const elapsed = wakeInstant.minus({ minutes: gap });
  return earlier(wall, elapsed);
}

export function computeAnchors(s: AnchorSettings, date: ISODate, lateNightMin = 0): Anchors {
  const next = addDays(date, 1);
  const nextWakeHHMM = wakeFor(s, next);
  const schoolNight = s.schoolDays.includes(weekday(next));
  const notes: string[] = [];

  let lightsOut = lightsOutFor(s, date, nextWakeHHMM);
  if (schoolNight && nextWakeHHMM !== s.wakeTime) {
    const base = lightsOutFor(s, date, s.wakeTime);
    if (base.toMillis() < lightsOut.toMillis()) {
      lightsOut = base;
      notes.push('School night: the later wake override can’t push the stop later.');
    }
  }
  const hardStop = lightsOut.minus({ minutes: s.windDownMin });
  const ext = Math.max(0, lateNightMin);
  const effectiveStop = ext ? earlier(hardStop.plus({ minutes: ext }), lightsOut) : hardStop;
  const nextWake = at(next, nextWakeHHMM);
  const sleepWindowMin = minutesBetween(lightsOut, nextWake);
  if (sleepWindowMin !== s.sleepNeedMin + s.fallAsleepMin && !notes.length) {
    const diff = sleepWindowMin - (s.sleepNeedMin + s.fallAsleepMin);
    notes.push(diff > 0
      ? `Clocks change tonight: ${Math.round(diff)} extra minutes in bed, same clock-time stop.`
      : `Clocks change tonight: lights-out moves ${Math.round(-diff)} minutes earlier so you still get the full window.`);
  }
  const fmt = (d: DateTime) => d.toFormat('h:mm a');
  return {
    date,
    wake: at(date, wakeFor(s, date)),
    lightsOut,
    hardStop,
    effectiveStop,
    nextWake,
    schoolNight,
    lateNightMin: ext,
    sleepWindowMin,
    math: [
      `Wake ${fmt(nextWake)}`,
      `− ${s.sleepNeedMin / 60} h sleep − ${s.fallAsleepMin} min to fall asleep = lights-out ${fmt(lightsOut)}`,
      `− ${s.windDownMin} min screen-free wind-down = hard stop ${fmt(hardStop)}`,
    ],
    notes,
  };
}

/** Which night/day are we in right now? Before wake, it's still the previous date's night. */
export function planningDate(s: AnchorSettings, nowDt: DateTime): ISODate {
  const d = nowDt.toISODate()!;
  const wake = at(d, wakeFor(s, d));
  return nowDt.toMillis() < wake.toMillis() ? addDays(d, -1) : d;
}
