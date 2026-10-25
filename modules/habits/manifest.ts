/**
 * habits — a no-code habit builder built to keep adding (SPEC 8).
 * Implementation-intention cues, consistency over 2 and 4 weeks instead of streaks, "never miss twice",
 * at most two habits in formation, graduation to automatic, a seed library that is off until chosen,
 * and auto-logging from other modules' events so nothing is logged twice.
 */
import { z } from 'zod';
import { defineModule, type Ctx, type PlannedNotification } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, today, at, addDays, minutesBetween, fromISO, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';
import { LIBRARY, PHASE_ONE, libraryEntry, type AutoSource } from './library';
import {
  consistencyLast, formationDay, isDone, isDue, isReady, missedTwice, recentDays,
  type HabitType, type Schedule, type DayStatus,
} from './logic';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

const settings = z.object({
  formationLimit: z.number().int().min(1).max(5).default(2).describe('Habits in formation at once. More than two spreads effort too thin.'),
  holdPct: z.number().int().min(50).max(100).default(80).describe('A habit may graduate to automatic when each of the last two weeks is at least this consistent.'),
  wakeToleranceMin: z.number().int().min(5).max(90).default(30).describe('“Fixed wake time” counts when you wake within this many minutes of your wake time.'),
  lightsOutGraceMin: z.number().int().min(0).max(60).default(15).describe('“Lights-out on time” counts when bedtime is within this many minutes of lights-out.'),
  minFocusBlockMin: z.number().int().min(5).max(120).default(25).describe('A focus block this long or longer counts for “50/10 breaks”.'),
});
export type HabitSettings = z.infer<typeof settings>;

export type HabitState = 'formation' | 'automatic' | 'archived';

export interface HabitView {
  id: string;
  key: string | null;
  name: string;
  why: string;
  cueAfter: string;
  cueWill: string;
  /** “After X, I will Y.” */
  cue: string;
  type: HabitType;
  schedule: Schedule;
  target: number;
  reminder: string | null;
  startDate: ISODate;
  state: HabitState;
  auto: AutoSource | null;
  /** Day N of formation (null before the start date). */
  day: number | null;
  due: boolean;
  /** Today's logged value, or null. */
  value: number | null;
  done: boolean;
  /** True when today's log came from an event rather than a tap. */
  autoLogged: boolean;
  consistency2w: number | null;
  consistency4w: number | null;
  missedTwice: boolean;
  /** Held the bar in each of the last two weeks: can move to automatic. */
  ready: boolean;
  recent: { date: ISODate; status: DayStatus }[];
  graduatedOn: ISODate | null;
}

interface HabitRow {
  id: string; lib_key: string | null; name: string; why: string; cue_after: string; cue_will: string; type: HabitType;
  schedule: string; target: number; reminder: string | null; start_date: string; auto: AutoSource | null; state: HabitState;
  graduated_on: string | null; created_at: string;
}
interface LogRow { habit_id: string; date: string; value: number; source: string }

const err = (message: string, status = 400) => Object.assign(new Error(message), { status });

export const habitInput = z.object({
  name: z.string().trim().min(1).max(80),
  why: z.string().trim().max(240).default(''),
  cueAfter: z.string().trim().max(120).default(''),
  cueWill: z.string().trim().max(160).default(''),
  type: z.enum(['yesno', 'count', 'minutes', 'scale']).default('yesno'),
  schedule: z.union([
    z.object({ kind: z.literal('days'), days: z.array(z.number().int().min(1).max(7)).min(1) }),
    z.object({ kind: z.literal('perWeek'), n: z.number().int().min(1).max(7) }),
  ]).default({ kind: 'days', days: [1, 2, 3, 4, 5, 6, 7] }),
  target: z.number().min(0).max(1440).default(1),
  reminder: hhmm.nullable().default(null),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type HabitInput = z.input<typeof habitInput>;

/** A time from the check-in: either “HH:MM” or an ISO instant. */
function moment(v: string, date: ISODate) {
  return /^\d{1,2}:\d{2}$/.test(v) ? at(date, v.padStart(5, '0')) : fromISO(v);
}

export function createHabitsService(ctx: Ctx) {
  const cfg = () => ctx.settings.get<HabitSettings>('habits');
  const day = () => ctx.maybe<DayService>('day');
  const weekStart = () => day()?.settings().weekStart ?? 7;
  const currentDate = (): ISODate => day()?.planningDate() ?? today();

  const rows = (where = "state != 'archived'") => ctx.db.all<HabitRow>(`SELECT * FROM habits WHERE ${where} ORDER BY created_at, rowid`);
  const row = (id: string) => ctx.db.get<HabitRow>('SELECT * FROM habits WHERE id = ?', id);
  const logsOf = (id: string) => ctx.db.all<LogRow>('SELECT habit_id, date, value, source FROM habit_logs WHERE habit_id = ?', id);
  const core = (r: HabitRow) => ({ type: r.type, schedule: JSON.parse(r.schedule) as Schedule, target: r.target, startDate: r.start_date });
  const doneSet = (r: HabitRow, logs: LogRow[]) => new Set(logs.filter((l) => isDone(r, l.value)).map((l) => l.date));

  function view(r: HabitRow, date: ISODate): HabitView {
    const h = core(r);
    const logs = logsOf(r.id);
    const done = doneSet(r, logs);
    const ws = weekStart();
    const todayLog = logs.find((l) => l.date === date);
    return {
      id: r.id, key: r.lib_key, name: r.name, why: r.why, cueAfter: r.cue_after, cueWill: r.cue_will,
      cue: r.cue_after && r.cue_will ? `After ${r.cue_after}, I will ${r.cue_will}.` : '',
      type: r.type, schedule: h.schedule, target: r.target, reminder: r.reminder, startDate: r.start_date,
      state: r.state, auto: r.auto, day: formationDay(r.start_date, date),
      due: r.state === 'formation' && isDue(h, done, date, ws),
      value: todayLog?.value ?? null, done: done.has(date), autoLogged: todayLog?.source === 'auto',
      consistency2w: consistencyLast(h, done, 14, date, ws).pct,
      consistency4w: consistencyLast(h, done, 28, date, ws).pct,
      missedTwice: r.state === 'formation' && missedTwice(h, done, date, ws),
      ready: r.state === 'formation' && isReady(h, done, date, ws, cfg().holdPct / 100),
      recent: recentDays(h, done, date, 14, ws),
      graduatedOn: r.graduated_on,
    };
  }

  const svc = {
    settings: cfg,
    currentDate,

    /** Non-archived habits (in formation or automatic), oldest first. */
    list(date: ISODate = currentDate()): HabitView[] {
      return rows().map((r) => view(r, date));
    },
    get(id: string, date: ISODate = currentDate()): HabitView | null {
      const r = row(id);
      return r ? view(r, date) : null;
    },
    /** Habits on today's list: in formation, scheduled for the date. */
    due(date: ISODate = currentDate()): HabitView[] {
      return svc.list(date).filter((h) => h.due);
    },
    /** Habits in formation that were missed on two scheduled days in a row. */
    missedTwice(date: ISODate = currentDate()): HabitView[] {
      return svc.list(date).filter((h) => h.missedTwice);
    },

    /** Consistency % over the last `days` days (null when nothing was scheduled). Today counts once done. */
    consistency(habitId: string, days: number, date: ISODate = currentDate()): number | null {
      return svc.consistencyDetail(habitId, days, date).pct;
    },
    consistencyDetail(habitId: string, days: number, date: ISODate = currentDate()) {
      const r = row(habitId);
      if (!r) throw err('Habit not found.', 404);
      return consistencyLast(core(r), doneSet(r, logsOf(r.id)), days, date, weekStart());
    },

    /** Formation slots: at most `formationLimit` at once; the next unlocks when the current ones hold the bar. */
    slots(date: ISODate = currentDate()) {
      const max = cfg().formationLimit;
      const inFormation = rows("state = 'formation'");
      const ready = inFormation.filter((r) => view(r, date).ready);
      const free = Math.max(0, max - inFormation.length);
      let reason: string | undefined;
      if (free === 0) {
        reason = ready.length
          ? `${ready.map((r) => r.name).join(' and ')} ${ready.length > 1 ? 'have' : 'has'} held ${cfg().holdPct}% for two weeks. Move ${ready.length > 1 ? 'them' : 'it'} to automatic to open a slot.`
          : `${inFormation.length} in formation. The next one unlocks when the current ones hold ${cfg().holdPct}% or better for two weeks.`;
      }
      return { max, used: inFormation.length, free, canAdd: free > 0, reason, ready: ready.map((r) => r.id) };
    },

    /** Create a habit. Blocked when the formation slots are full (use opts.force for onboarding presets). */
    add(input: HabitInput, opts: { libKey?: string; auto?: AutoSource | null; force?: boolean } = {}): HabitView {
      const i = habitInput.parse(input);
      if (!opts.force) {
        const s = svc.slots();
        if (!s.canAdd) throw err(s.reason ?? 'Formation slots are full.', 409);
      }
      const id = uid();
      const start = i.startDate ?? currentDate();
      ctx.db.run(
        `INSERT INTO habits (id, lib_key, name, why, cue_after, cue_will, type, schedule, target, reminder, start_date, auto, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'formation', ?)`,
        id, opts.libKey ?? null, i.name, i.why, i.cueAfter, i.cueWill, i.type, JSON.stringify(i.schedule),
        i.type === 'yesno' ? 1 : i.target, i.reminder, start, opts.auto ?? null, now().toISO(),
      );
      ctx.bus.emit('habit.created', { habitId: id, name: i.name });
      return svc.get(id)!;
    },

    fromLibrary(key: string, opts: { force?: boolean; startDate?: ISODate } = {}): HabitView {
      const l = libraryEntry(key);
      if (!l) throw err('That habit isn’t in the library.', 404);
      const existing = ctx.db.get<HabitRow>("SELECT * FROM habits WHERE lib_key = ? AND state != 'archived'", key);
      if (existing) return view(existing, currentDate());
      return svc.add({
        name: l.name, why: l.why, cueAfter: l.cueAfter, cueWill: l.cueWill, type: l.type, target: l.target,
        schedule: l.schedule(day()?.settings().offDay ?? 6), startDate: opts.startDate,
      }, { libKey: key, auto: l.auto ?? null, force: opts.force });
    },

    library() {
      const added = new Set(rows().map((r) => r.lib_key).filter(Boolean));
      return LIBRARY.map((l) => ({
        key: l.key, name: l.name, why: l.why, cue: `After ${l.cueAfter}, I will ${l.cueWill}.`, type: l.type, auto: l.auto ?? null,
        phaseOne: (PHASE_ONE as readonly string[]).includes(l.key), added: added.has(l.key),
      }));
    },

    /**
     * Phase 1 turns on only three habits: fixed wake time, shutdown complete, phone out of the bedroom.
     * Idempotent: running it again changes nothing. It is the one place the formation limit doesn't apply,
     * because it is the starting set; nothing else can be added until these hold the bar.
     */
    enablePhaseOne(): HabitView[] {
      for (const key of PHASE_ONE) {
        const archived = ctx.db.get<HabitRow>("SELECT * FROM habits WHERE lib_key = ? AND state = 'archived' ORDER BY created_at DESC", key);
        const live = ctx.db.get('SELECT 1 FROM habits WHERE lib_key = ? AND state != \'archived\'', key);
        if (live) continue;
        if (archived) ctx.db.run("UPDATE habits SET state = 'formation', graduated_on = NULL WHERE id = ?", archived.id);
        else svc.fromLibrary(key, { force: true });
      }
      return PHASE_ONE.map((k) => rows().find((r) => r.lib_key === k)!).map((r) => view(r, currentDate()));
    },

    update(id: string, patch: Partial<HabitInput>): HabitView {
      const r = row(id);
      if (!r) throw err('Habit not found.', 404);
      const cur = { name: r.name, why: r.why, cueAfter: r.cue_after, cueWill: r.cue_will, type: r.type, schedule: JSON.parse(r.schedule), target: r.target, reminder: r.reminder, startDate: r.start_date };
      const i = habitInput.parse({ ...cur, ...patch });
      ctx.db.run(
        `UPDATE habits SET name = ?, why = ?, cue_after = ?, cue_will = ?, type = ?, schedule = ?, target = ?, reminder = ?, start_date = ? WHERE id = ?`,
        i.name, i.why, i.cueAfter, i.cueWill, i.type, JSON.stringify(i.schedule), i.type === 'yesno' ? 1 : i.target, i.reminder, i.startDate ?? r.start_date, id,
      );
      ctx.bus.emit('habit.updated', { habitId: id });
      return svc.get(id)!;
    },

    /** Move to automatic: leaves the daily view and frees a formation slot. Needs the bar held for two weeks. */
    graduate(id: string): HabitView {
      const v = svc.get(id);
      if (!v) throw err('Habit not found.', 404);
      if (v.state !== 'formation') throw err('That habit isn’t in formation.', 409);
      if (!v.ready) throw err(`${v.name} needs ${cfg().holdPct}% or better in each of the last two weeks before it moves to automatic. Habits take a median of 66 days to form (Lally 2010).`, 409);
      ctx.db.run("UPDATE habits SET state = 'automatic', graduated_on = ? WHERE id = ?", currentDate(), id);
      ctx.bus.emit('habit.graduated', { habitId: id });
      return svc.get(id)!;
    },
    /** Stop tracking (keeps the history). Frees the slot. */
    archive(id: string): void {
      if (!row(id)) throw err('Habit not found.', 404);
      ctx.db.run("UPDATE habits SET state = 'archived' WHERE id = ?", id);
      ctx.bus.emit('habit.archived', { habitId: id });
    },

    /**
     * Log a value for a date. Manual logs always win; an automatic log never overwrites a manual one,
     * and logging the same value twice is a no-op (so events can't double-log).
     */
    log(habitId: string, date: ISODate, value: number, source: 'manual' | 'auto' = 'manual'): HabitView {
      const r = row(habitId);
      if (!r) throw err('Habit not found.', 404);
      if (!Number.isFinite(value) || value < 0) throw err('Enter zero or a positive number.');
      const v = r.type === 'yesno' ? (value > 0 ? 1 : 0) : r.type === 'scale' ? Math.min(10, value) : value;
      const prev = ctx.db.get<LogRow>('SELECT habit_id, date, value, source FROM habit_logs WHERE habit_id = ? AND date = ?', habitId, date);
      if (prev && source === 'auto' && prev.source === 'manual') return view(r, currentDate());
      if (prev && prev.value === v && (prev.source === source || source === 'auto')) return view(r, currentDate());
      ctx.db.run(
        `INSERT INTO habit_logs (habit_id, date, value, source, logged_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(habit_id, date) DO UPDATE SET value = excluded.value, source = excluded.source, logged_at = excluded.logged_at`,
        habitId, date, v, source, now().toISO(),
      );
      ctx.bus.emit('habit.logged', { habitId, date, value: v, done: isDone(r, v), source });
      return view(r, currentDate());
    },
    unlog(habitId: string, date: ISODate): HabitView {
      const r = row(habitId);
      if (!r) throw err('Habit not found.', 404);
      if (ctx.db.run('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?', habitId, date).changes) {
        ctx.bus.emit('habit.unlogged', { habitId, date });
      }
      return view(r, currentDate());
    },

    /** Feed a habit from an event. Habits that aren't turned on simply don't exist, so this is a no-op for them. */
    autoLog(source: AutoSource, date: ISODate, value: number) {
      for (const r of rows().filter((x) => x.auto === source && x.start_date <= date)) svc.log(r.id, date, value, 'auto');
    },

    /** Wake and bedtime from the morning check-in → “fixed wake time” and “lights-out on time”. */
    autoFromCheckin(date: ISODate) {
      const entry = ctx.maybe<any>('checkin')?.entry(date);
      const d = day();
      if (!entry || !d) return;
      const planned = d.anchors(date).wake;
      const wake = entry.wakeTime ? moment(entry.wakeTime, date) : null;
      if (wake) {
        svc.autoLog('wake', date, Math.abs(minutesBetween(planned, wake)) <= cfg().wakeToleranceMin ? 1 : 0);
      }
      if (entry.bedtime) {
        // Bedtime belongs to the previous evening unless it is clock-time before noon and before waking.
        let bed = moment(entry.bedtime, date);
        if (/^\d{1,2}:\d{2}$/.test(entry.bedtime)) {
          const hour = Number(entry.bedtime.split(':')[0]);
          const ref = wake ?? planned;
          if (!(hour < 12 && bed.toMillis() < ref.toMillis())) bed = moment(entry.bedtime, addDays(date, -1));
        }
        const lightsOut = d.anchors(addDays(date, -1)).lightsOut;
        svc.autoLog('lightsout', date, minutesBetween(lightsOut, bed) <= cfg().lightsOutGraceMin ? 1 : 0);
      }
    },
  };
  return svc;
}
export type HabitsService = ReturnType<typeof createHabitsService>;

export default defineModule({
  id: 'habits',
  name: 'Habits',
  description: 'A no-code habit builder: cues, consistency instead of streaks, never miss twice, two in formation at a time, and a seed library.',
  settings,
  migrations: [
    `CREATE TABLE habits (
       id TEXT PRIMARY KEY,
       lib_key TEXT,
       name TEXT NOT NULL,
       why TEXT NOT NULL DEFAULT '',
       cue_after TEXT NOT NULL DEFAULT '',
       cue_will TEXT NOT NULL DEFAULT '',
       type TEXT NOT NULL,
       schedule TEXT NOT NULL,
       target REAL NOT NULL DEFAULT 1,
       reminder TEXT,
       start_date TEXT NOT NULL,
       auto TEXT,
       state TEXT NOT NULL DEFAULT 'formation',
       graduated_on TEXT,
       created_at TEXT NOT NULL
     );
     CREATE INDEX habits_state ON habits(state);
     CREATE TABLE habit_logs (
       habit_id TEXT NOT NULL,
       date TEXT NOT NULL,
       value REAL NOT NULL,
       source TEXT NOT NULL DEFAULT 'manual',
       logged_at TEXT NOT NULL,
       PRIMARY KEY (habit_id, date)
     );`,
  ],
  service: createHabitsService,
  emits: ['habit.logged', 'habit.unlogged', 'habit.created', 'habit.updated', 'habit.graduated', 'habit.archived'],
  on: {
    'shutdown.completed': (p, ctx) => ctx.service<HabitsService>('habits').autoLog('shutdown', p.date, 1),
    'checkin.submitted': (p, ctx) => ctx.service<HabitsService>('habits').autoFromCheckin(p.date),
    'review.completed': (_p, ctx) => {
      const h = ctx.service<HabitsService>('habits');
      h.autoLog('review', h.currentDate(), 1);
    },
    'focus.completed': (p, ctx) => {
      const h = ctx.service<HabitsService>('habits');
      if ((p.minutes ?? Infinity) >= h.settings().minFocusBlockMin) h.autoLog('focus', p.date ?? h.currentDate(), 1);
    },
  },
  /** Reminders: a `wellbeing` notification at the habit's time on the days it is due and not yet done. */
  notifications(ctx, date): PlannedNotification[] {
    const h = ctx.service<HabitsService>('habits');
    return h.list(date).filter((x) => x.reminder && x.due && !x.done).map((x) => ({
      key: `habit.reminder:${x.id}:${date}`,
      at: at(date, x.reminder!),
      title: x.name,
      body: x.cue || `Time for ${x.name.toLowerCase()}.`,
      category: 'wellbeing' as const,
      path: '/habits',
    }));
  },
  routes(r, ctx) {
    const svc = () => ctx.service<HabitsService>('habits');
    const dateParam = (c: any) => c.req.query('date') ?? svc().currentDate();
    r.get('/', (c) => c.json(svc().list(dateParam(c))));
    r.get('/overview', (c) => {
      const date = dateParam(c);
      const all = svc().list(date);
      return c.json({
        date,
        formation: all.filter((h) => h.state === 'formation'),
        automatic: all.filter((h) => h.state === 'automatic'),
        slots: svc().slots(date),
        library: svc().library(),
        research: { median: 66, min: 18, max: 254, source: 'Lally 2010' },
      });
    });
    r.get('/today', (c) => {
      const date = dateParam(c);
      const due = svc().due(date);
      return c.json({ date, due, nudges: svc().missedTwice(date).map((h) => h.id) });
    });
    r.get('/library', (c) => c.json(svc().library()));
    r.get('/slots', (c) => c.json(svc().slots(dateParam(c))));
    r.post('/', async (c) => c.json(svc().add(await c.req.json())));
    r.post('/phase-one', (c) => c.json(svc().enablePhaseOne()));
    r.post('/library/:key', (c) => c.json(svc().fromLibrary(c.req.param('key'))));
    r.patch('/:id', async (c) => c.json(svc().update(c.req.param('id'), await c.req.json())));
    r.post('/:id/log', async (c) => {
      const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), value: z.number() }).parse(await c.req.json());
      return c.json(svc().log(c.req.param('id'), body.date ?? svc().currentDate(), body.value));
    });
    r.delete('/:id/log/:date', (c) => c.json(svc().unlog(c.req.param('id'), c.req.param('date'))));
    r.post('/:id/graduate', (c) => c.json(svc().graduate(c.req.param('id'))));
    r.post('/:id/archive', (c) => { svc().archive(c.req.param('id')); return c.json({ ok: true }); });
  },
  nav: [{ id: 'habits', label: 'Habits', icon: 'Repeat', path: '/habits', section: 'main', order: 40, work: false }],
  widgets: [{ id: 'today', slot: 'today.main', order: 60 }],
  rules: {
    conditions: [{
      id: 'habits.missed_twice',
      label: 'A habit was missed twice in a row',
      description: 'Two scheduled days (or two weeks, for “N per week” habits) passed with no log for a habit in formation.',
      params: z.object({}),
      evaluate: (ctx) => {
        const hit = ctx.service<HabitsService>('habits').missedTwice();
        return {
          met: hit.length > 0,
          detail: hit.length ? `${hit.map((h) => h.name).join(', ')}: two scheduled ${hit.length === 1 && hit[0].schedule.kind === 'perWeek' ? 'weeks' : 'days'} in a row without a log.` : undefined,
          subject: hit[0]?.id,
        };
      },
    }],
  },
});

