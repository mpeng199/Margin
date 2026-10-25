/** Shared types, settings and week math for the review module. */
import { z } from 'zod';
import { addDays, weekStartOf, type ISODate } from '../../src/core/time';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const settingsSchema = z.object({
  reviewDay: z.number().int().min(1).max(7).default(7).describe('Day of the weekly review (7 = Sunday).'),
  reviewTime: hhmm.default('15:00').describe('When the review reminder appears.'),
  durationMin: z.number().int().min(15).max(120).default(45).describe('How long the review should take.'),
  blockMin: z.number().int().min(30).max(180).default(90).describe('Length of the deep-work block proposed for each priority.'),
  blockEarliest: hhmm.default('09:00').describe('Deep-work blocks are never proposed before this time.'),
});
export type ReviewSettings = z.infer<typeof settingsSchema>;

export interface Scores { energy: number | null; dread: number | null; effective: number | null }
export interface Slot { start: string; end: string }
export interface Priority {
  text: string;
  ref: { type: 'project' | 'task'; id: string } | null;
  /** Ask for a deep-work block next week. The server picks `slot` when it is empty. */
  block: boolean;
  slot: Slot | null;
}
export type TriageChoice = 'move' | 'first' | 'delegate' | 'drop';
export interface TriageDecision { decision: TriageChoice; date?: string; owner?: string; reason?: string }
export interface Decisions {
  triage: Record<string, TriageDecision>;
  /** functionId → note that was logged through delegation.logCheckin */
  checkins: Record<string, string>;
  /** deadline key → "when will you work on this" note */
  deadlines: Record<string, string>;
  /** required step id → how it was resolved */
  required: Record<string, { how: string; projectId?: string; at: string }>;
  proposed: Record<string, { action: 'activate' | 'decline'; tradeOffId?: string; at: string }>;
  projectChanges: { projectId: string; name: string; from: string; to: string; at: string }[];
  offday: { date: ISODate | null; confirmed: boolean; moves: Record<string, ISODate> };
}
export interface Draft {
  weekStart: ISODate;
  step: number;
  done: Record<string, boolean>;
  scores: Scores;
  priorities: Priority[];
  notes: string;
  summary: string;
  decisions: Decisions;
  changeSetId: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export const emptyDecisions = (): Decisions => ({
  triage: {}, checkins: {}, deadlines: {}, required: {}, proposed: {}, projectChanges: [],
  offday: { date: null, confirmed: false, moves: {} },
});
export const emptyDraft = (weekStart: ISODate): Draft => ({
  weekStart, step: 0, done: {}, scores: { energy: null, dread: null, effective: null }, priorities: [],
  notes: '', summary: '', decisions: emptyDecisions(), changeSetId: null, startedAt: null, updatedAt: null, completedAt: null,
});

export interface RequiredStep { id: string; label: string; ruleId?: string }

/**
 * The week a review belongs to, as of `date`.
 * - `weekStart`: first day of the week containing `date` (settings: day.weekStart, Sunday by default).
 * - `reviewDate`: the review day inside that week.
 * - `lookback`: the 7 days before the review (sleep and stop breaks are measured here).
 * - `ahead`: the 7 days after the later of the review day and `date` (priorities and blocks go here).
 * String comparison of ISO dates is chronological.
 */
export function reviewWeek(date: ISODate, weekStart: number, reviewDay: number) {
  const start = weekStartOf(date, weekStart);
  const reviewDate = addDays(start, (reviewDay - weekStart + 7) % 7);
  const anchor = date < reviewDate ? date : reviewDate;
  const aheadFrom = addDays(date > reviewDate ? date : reviewDate, 1);
  return {
    weekStart: start,
    reviewDate,
    lookback: { from: addDays(anchor, -7), to: addDays(anchor, -1) },
    ahead: { from: aheadFrom, to: addDays(aheadFrom, 6) },
  };
}
export type ReviewWeek = ReturnType<typeof reviewWeek>;

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export function mean(xs: number[]): number | null {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
/** Call another module defensively: a missing or half-built service must not break the review. */
export function safe<T>(fn: () => T, fallback: T): T {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}
