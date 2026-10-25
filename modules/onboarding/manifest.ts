/**
 * onboarding — about 10 minutes, every step skippable (SPEC 7). Owns little data of its own: it
 * writes settings and calls other modules' services so the first Today is already populated.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { kvGet, kvSet } from '../../src/core/kv';
import { now, at, addDays, today, weekday } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { GoogleService } from '../google/manifest';

export const STEPS = ['accounts', 'wake', 'blocks', 'week', 'projects', 'owners', 'deadlines', 'baseline'] as const;

/** SPEC 7 step 3 seeds, from the current schedule. */
export const SEED_BLOCKS = [
  { id: 'school-mwth', label: 'School', kind: 'school', days: [1, 3, 4], start: '06:45', end: '14:02' },
  { id: 'school-tf', label: 'School', kind: 'school', days: [2, 5], start: '08:45', end: '15:30' },
  { id: 'lab', label: 'Lab', kind: 'lab', days: [1, 2, 3, 4, 5], start: '15:40', end: '18:15' },
  { id: 'commute', label: 'Home', kind: 'commute', days: [1, 2, 3, 4, 5], start: '18:15', end: '18:45' },
  { id: 'gym', label: 'Gym', kind: 'gym', days: [1, 3, 5], start: '18:45', end: '19:35' },
  { id: 'dinner', label: 'Dinner', kind: 'dinner', days: [1, 2, 3, 4, 5], start: '19:35', end: '20:05' },
  { id: 'badminton', label: 'Badminton', kind: 'sport', days: [2], start: '06:00', end: '08:00' },
];

interface State { completed: boolean; step: number; skipped: string[]; finishedAt?: string }
const getState = (ctx: Ctx): State => kvGet(ctx.db, 'onboarding.state', { completed: false, step: 0, skipped: [] });

/** Weekly RRULE for a fixed block on the Blocks calendar, first occurrence on or after today. */
function blockEvent(b: (typeof SEED_BLOCKS)[number]) {
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  let d = today();
  while (!b.days.includes(weekday(d))) d = addDays(d, 1);
  return {
    title: b.label, start: at(d, b.start).toISO()!, end: at(d, b.end).toISO()!, busy: true,
    recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${b.days.map((x) => days[x - 1]).join(',')}`],
    marginKind: 'fixed', marginFixedId: b.id, description: 'Fixed block from Margin onboarding.',
  };
}

export default defineModule({
  id: 'onboarding',
  name: 'Onboarding',
  description: 'First-run setup: accounts, wake time, fixed blocks, off-day, projects, owners, deadlines, baseline.',
  routes(r, ctx) {
    r.get('/state', (c) => c.json({ ...getState(ctx), steps: STEPS }));
    r.post('/step', async (c) => {
      const { step, skipped } = z.object({ step: z.number().int().min(0).max(STEPS.length), skipped: z.string().optional() }).parse(await c.req.json());
      const s = getState(ctx);
      kvSet(ctx.db, 'onboarding.state', { ...s, step, skipped: skipped ? [...new Set([...s.skipped, skipped])] : s.skipped });
      return c.json(getState(ctx));
    });
    r.post('/complete', (c) => {
      kvSet(ctx.db, 'onboarding.state', { ...getState(ctx), completed: true, finishedAt: now().toISO() });
      ctx.bus.emit('onboarding.completed', {});
      return c.json(getState(ctx));
    });
    r.post('/restart', (c) => { kvSet(ctx.db, 'onboarding.state', { completed: false, step: 0, skipped: [] }); return c.json(getState(ctx)); });
    r.get('/seed-blocks', (c) => {
      const current = ctx.service<DayService>('day').settings().fixedBlocks;
      return c.json(current.length ? current : SEED_BLOCKS);
    });
    /** Fixed blocks already on some calendar under the same name are skipped (no duplicates on the phone). */
    r.post('/blocks-to-calendar', async (c) => {
      const day = ctx.service<DayService>('day');
      const google = ctx.service<GoogleService>('google');
      const blocks = day.settings().fixedBlocks.filter((b) => b.kind === 'school' || b.kind === 'lab');
      const startIso = at(today(), '00:00').toISO()!;
      const endIso = at(addDays(today(), 7), '00:00').toISO()!;
      const existing = google.eventsBetween(startIso, endIso);
      const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').trim();
      const todo = blocks.filter((b) => !existing.some((e) => !e.allDay && norm(e.title).startsWith(norm(b.label))));
      const skipped = blocks.length - todo.length;
      if (!todo.length) return c.json({ created: 0, skipped, message: 'School and lab are already on your calendar.' });
      const set = ctx.changes.propose({
        source: 'onboarding', title: 'Put school and lab on the Blocks calendar',
        changes: todo.map((b) => ({ kind: 'gcal.event.create', title: `${b.label} · weekly`, payload: blockEvent(b as any) })),
      });
      const out = await ctx.changes.apply(set.id);
      const created = out.changes.filter((x) => x.status === 'applied').length;
      return c.json({ created, skipped, changeSetId: set.id, message: `Added ${created} weekly block${created === 1 ? '' : 's'} to “${google.settings().blocksCalendarName}”.` });
    });
  },
  nav: [],
});
