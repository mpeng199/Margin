import { describe, it, expect } from 'vitest';
import { computeAnchors, planningDate, type AnchorSettings } from '../../modules/day/anchors';
import { setZone, fromISO } from '../../src/core/time';

setZone('America/New_York');
const base: AnchorSettings = {
  wakeTime: '06:30', weekdayWake: [null, null, null, null, null, null, null], dateWake: {},
  sleepNeedMin: 480, fallAsleepMin: 30, windDownMin: 60, schoolDays: [1, 2, 3, 4, 5],
};
const t = (d: any) => d.toFormat('yyyy-MM-dd HH:mm ZZZZ');

describe('anchors', () => {
  it('spec example: wake 6:30 → lights-out 10:00 PM, stop 9:00 PM', () => {
    const a = computeAnchors(base, '2026-10-26');
    expect(t(a.lightsOut)).toBe('2026-10-26 22:00 EDT');
    expect(t(a.hardStop)).toBe('2026-10-26 21:00 EDT');
    expect(a.sleepWindowMin).toBe(510);
  });

  it('fall back (Sat Oct 31 → Sun Nov 1 2026): stop stays 9:00 PM, 9h30 in bed', () => {
    const a = computeAnchors(base, '2026-10-31');
    expect(t(a.lightsOut)).toBe('2026-10-31 22:00 EDT');
    expect(t(a.hardStop)).toBe('2026-10-31 21:00 EDT');
    expect(t(a.nextWake)).toBe('2026-11-01 06:30 EST');
    expect(a.sleepWindowMin).toBe(570);
    expect(a.notes[0]).toMatch(/extra minutes/);
  });

  it('the night after fall back is ordinary again', () => {
    const a = computeAnchors(base, '2026-11-01');
    expect(t(a.hardStop)).toBe('2026-11-01 21:00 EST');
    expect(a.sleepWindowMin).toBe(510);
  });

  it('spring forward (Sat Mar 13 → Sun Mar 14 2027): lights-out moves earlier, full window kept', () => {
    const a = computeAnchors(base, '2027-03-13');
    expect(t(a.lightsOut)).toBe('2027-03-13 21:00 EST');
    expect(a.sleepWindowMin).toBe(510);
  });

  it('weekday override moves an early-badminton night earlier', () => {
    const s = { ...base, weekdayWake: [null, '05:30', null, null, null, null, null] }; // Tuesday 5:30
    const a = computeAnchors(s, '2026-10-26'); // Monday night
    expect(t(a.hardStop)).toBe('2026-10-26 20:00 EDT');
  });

  it('school night: a later wake override cannot move the stop later', () => {
    const s = { ...base, dateWake: { '2026-10-28': '08:00' } };
    const a = computeAnchors(s, '2026-10-27');
    expect(t(a.hardStop)).toBe('2026-10-27 21:00 EDT');
  });

  it('non-school night may follow a later wake', () => {
    const s = { ...base, weekdayWake: [null, null, null, null, null, '08:00', null] }; // Saturday 8:00
    const a = computeAnchors(s, '2026-10-30'); // Friday night
    expect(t(a.hardStop)).toBe('2026-10-30 22:30 EDT');
  });

  it('late night extends the stop by up to 60 min, lights-out stays', () => {
    const a = computeAnchors(base, '2026-10-26', 60);
    expect(t(a.effectiveStop)).toBe('2026-10-26 22:00 EDT');
    expect(t(a.lightsOut)).toBe('2026-10-26 22:00 EDT');
    const b = computeAnchors({ ...base, windDownMin: 30 }, '2026-10-26', 60);
    expect(t(b.effectiveStop)).toBe('2026-10-26 22:00 EDT'); // capped at lights-out
  });

  it('planning date before wake is the previous night', () => {
    expect(planningDate(base, fromISO('2026-11-01T01:30:00-04:00'))).toBe('2026-10-31');
    expect(planningDate(base, fromISO('2026-11-01T01:30:00-05:00'))).toBe('2026-10-31'); // repeated hour
    expect(planningDate(base, fromISO('2026-11-01T06:31:00-05:00'))).toBe('2026-11-01');
  });
});
