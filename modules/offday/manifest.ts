/**
 * offday — the weekly day without work (SPEC 4.x). Owns the leisure list ("would I be upset if this
 * produced nothing?" decides what counts), the off-day page, and the day-before warning that lists what
 * is due on the off-day and offers one change set to move it.
 * The mode itself (Day / Evening / Off-day) lives in `day`; this module being enabled is what turns the off-day on.
 */
import { z } from 'zod';
import { defineModule, type Ctx, type RuleCondition } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { kvGet } from '../../src/core/kv';
import { now, addDays, weekday, fromISO, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import type { Task, TodoistService } from '../todoist/manifest';

export interface LeisureItem { id: string; title: string; test: boolean }
export interface OffDayTask { id: string; content: string; projectName: string; time: string | null; recurring: boolean }
export interface OffDayEvent { id: string; title: string; start: string; end: string; calendarName?: string }
export interface OffDayWarning {
  date: ISODate;
  /** True only on the day before the off-day. */
  show: boolean;
  locked: boolean;
  tasks: OffDayTask[];
  events: OffDayEvent[];
  /** Where "Move to …" can send tasks: the two days after the off-day. */
  targets: { date: ISODate; label: string }[];
}

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });
const dayName = (date: ISODate) => fromISO(`${date}T12:00:00`).toFormat('cccc');

export const WORK_REFUSAL = 'If it would bother you to get nothing out of it, it’s work. It doesn’t go on the leisure list. Capture it as a task instead.';

export function createOffdayService(ctx: Ctx) {
  const day = () => ctx.service<DayService>('day');
  const td = () => ctx.maybe<TodoistService>('todoist');
  const hidden = (t: Task) => { try { return !!ctx.maybe<{ isHidden(t: Task): boolean }>('projects')?.isHidden(t); } catch { return false; } };

  const svc = {
    /** The off-day that is today (until the night ends) or the next one coming. */
    nextOffDay(): ISODate {
      const off = day().settings().offDay;
      const from = day().planningDate();
      for (let i = 0; i < 7; i++) if (weekday(addDays(from, i)) === off) return addDays(from, i);
      return from;
    },

    leisure(): LeisureItem[] {
      return ctx.db.all<{ id: string; title: string; test: number }>('SELECT id, title, test FROM offday_leisure ORDER BY created_at, rowid')
        .map((r) => ({ id: r.id, title: r.title, test: !!r.test }));
    },

    /** `wouldBeUpset` is the answer to “Would I be upset if this produced nothing?”. Yes means it is work. */
    addLeisure(title: string, wouldBeUpset: boolean): LeisureItem {
      const t = title.trim();
      if (!t) throw httpError('Type what you’d like to do.', 400);
      if (wouldBeUpset) throw httpError(WORK_REFUSAL, 422);
      const id = uid();
      ctx.db.run('INSERT INTO offday_leisure (id, title, test, created_at) VALUES (?, ?, 1, ?)', id, t.slice(0, 120), now().toISO());
      ctx.bus.emit('offday.leisure_added', { id, title: t });
      return { id, title: t.slice(0, 120), test: true };
    },

    removeLeisure(id: string) {
      ctx.db.run('DELETE FROM offday_leisure WHERE id = ?', id);
      ctx.bus.emit('offday.leisure_removed', { id });
    },

    /** Open tasks due on the date (paused and dropped projects are skipped). */
    tasksOnOffDay(date: ISODate): OffDayTask[] {
      const t = td();
      if (!t) return [];
      return t.tasks({ dueOn: date })
        .filter((x) => !x.checked && !hidden(x))
        .map((x) => ({ id: x.id, content: x.content, projectName: x.projectName, time: x.due?.time ?? null, recurring: !!x.due?.recurring }));
    },

    /** Busy, timed calendar entries on the date (Margin's own work blocks excluded). */
    eventsOnOffDay(date: ISODate): OffDayEvent[] {
      return day().timeline(date)
        .filter((i) => i.busy && !i.allDay && i.source !== 'block')
        .map((i) => ({ id: i.id, title: i.title, start: i.start, end: i.end, calendarName: i.calendarName }));
    },

    warning(): OffDayWarning {
      const date = svc.nextOffDay();
      const show = addDays(day().planningDate(), 1) === date;
      return {
        date, show,
        locked: kvGet<unknown>(ctx.db, 'offday.locked', false) === true,
        tasks: show ? svc.tasksOnOffDay(date) : [],
        events: show ? svc.eventsOnOffDay(date) : [],
        targets: [1, 2].map((n) => ({ date: addDays(date, n), label: dayName(addDays(date, n)) })),
      };
    },

    /** One change set moves everything due on the off-day; the click is the approval, so it is applied right away. */
    async moveDueTasks(to: ISODate) {
      const w = svc.warning();
      const target = w.targets.find((x) => x.date === to);
      if (!target) throw httpError('Pick one of the two days after your day off.', 400);
      if (!w.tasks.length) throw httpError('Nothing is due on your day off.', 409);
      if (!td()) throw httpError('Todoist is off, so tasks can’t be moved.', 409);
      const n = w.tasks.length;
      const set = ctx.changes.propose({
        source: 'offday',
        title: `Move ${n} ${n === 1 ? 'task' : 'tasks'} off your day off to ${target.label}`,
        summary: 'Keeps the day off clear. Recurring tasks stay recurring.',
        changes: w.tasks.map((t) => ({
          kind: 'todoist.task.reschedule',
          title: `Move “${t.content}” to ${fromISO(`${to}T12:00:00`).toFormat('ccc, MMM d')}`,
          payload: { taskId: t.id, date: t.time ? `${to}T${t.time}:00` : to },
          before: { date: w.date },
        })),
      });
      const res = await ctx.changes.apply(set.id);
      return { id: res.id, status: res.status, moved: res.changes.filter((c) => c.status === 'applied').length };
    },
  };
  return svc;
}
export type OffdayService = ReturnType<typeof createOffdayService>;

const conditions: RuleCondition[] = [{
  id: 'offday.worked',
  label: 'Worked on the off-day',
  description: 'Work views were opened during the off-day’s daytime on at least N off-days in the last D days.',
  params: z.object({ times: z.number().int().min(1).max(30).default(1), windowDays: z.number().int().min(1).max(90).default(28) }),
  evaluate: (ctx, p) => {
    const day = ctx.service<DayService>('day');
    const to = day.planningDate();
    const dates = new Set(
      day.stopBreaks(addDays(to, -(p.windowDays - 1)), to)
        .filter((b) => day.isOffDay(b.date) && fromISO(b.at).toMillis() < day.anchors(b.date).effectiveStop.toMillis())
        .map((b) => b.date),
    );
    const n = dates.size;
    return { met: n >= p.times, detail: `Opened work on your day off ${n} ${n === 1 ? 'time' : 'times'} in the last ${p.windowDays} days.` };
  },
}];

export default defineModule({
  id: 'offday',
  name: 'Day off',
  description: 'One full day a week without work: a leisure list, a day-before warning, and no work views.',
  requires: ['day'],
  migrations: [
    `CREATE TABLE offday_leisure (id TEXT PRIMARY KEY, title TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);`,
  ],
  service: createOffdayService,
  nav: [{ id: 'offday', label: 'Day off', icon: 'Sun', path: '/offday', section: 'secondary', order: 15 }],
  widgets: [
    { id: 'leisure', slot: 'evening', order: 20 },
    { id: 'offday-warning', slot: 'today.side', order: 30 },
  ],
  emits: ['offday.started', 'offday.leisure_added', 'offday.leisure_removed'],
  on: {
    'day.started': (p, ctx) => {
      if (ctx.service<DayService>('day').isOffDay(p.date)) ctx.bus.emit('offday.started', { date: p.date });
    },
  },
  rules: { conditions },
  routes(r, ctx) {
    const svc = () => ctx.service<OffdayService>('offday');
    r.get('/state', (c) => {
      const date = svc().nextOffDay();
      return c.json({
        date,
        isToday: date === ctx.service<DayService>('day').planningDate(),
        leisure: svc().leisure(),
        tasks: svc().tasksOnOffDay(date),
        events: svc().eventsOnOffDay(date),
        locked: kvGet<unknown>(ctx.db, 'offday.locked', false) === true,
      });
    });
    r.get('/leisure', (c) => c.json(svc().leisure()));
    r.post('/leisure', async (c) => {
      // The question has to be answered: a missing answer is a 400, not a pass.
      const b = z.object({ title: z.string().max(200), upsetIfNothing: z.boolean() }).parse(await c.req.json());
      return c.json(svc().addLeisure(b.title, b.upsetIfNothing));
    });
    r.delete('/leisure/:id', (c) => { svc().removeLeisure(c.req.param('id')); return c.json({ ok: true }); });
    r.get('/warning', (c) => c.json(svc().warning()));
    r.post('/warning/move', async (c) => {
      const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(await c.req.json());
      return c.json(await svc().moveDueTasks(date));
    });
  },
});
