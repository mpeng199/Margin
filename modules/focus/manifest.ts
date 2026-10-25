/**
 * focus — one project at a time, 50 minutes of work then 10 away from screens (SPEC 4.13).
 * The running state lives in the `sessions` table, so a reload or a daemon restart loses nothing.
 * Elapsed time always comes from instants (DST-safe), and a block never runs past the effective stop.
 * Transitions are lazy: `settle()` runs on every read and once a minute from the job, so
 * `focus.completed` fires even with the window closed.
 */
import { z } from 'zod';
import { defineModule, type Ctx, type PlannedNotification } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, fromISO, fromMillis, dateOf, fmtTime, type ISODate } from '../../src/core/time';
import type { DayService } from '../day/manifest';

const settings = z.object({
  workMin: z.number().int().min(10).max(120).default(50).describe('Minutes of work per block.'),
  breakMin: z.number().int().min(3).max(30).default(10).describe('Minutes away from screens after each block.'),
});
type FocusSettings = z.infer<typeof settings>;

export const WARN_BEFORE_STOP_MIN = 10;
const MIN = 60_000;

interface SessionRow {
  id: string; project_id: string; task_id: string; date: ISODate; start: string; cutoff: string;
  work_min: number; break_min: number; phase: 'work' | 'break'; phase_start: string;
  banked_ms: number; run_since: string | null; paused_at: string | null; work_end: string | null;
  status: 'active' | 'ended'; end_reason: 'complete' | 'stopped' | 'cutoff' | null; ended_at: string | null;
}
interface LogRow { id: string; project_id: string; task_id: string; date: ISODate; start: string; end: string; minutes: number }

export interface FocusLog { id: string; projectId: string; taskId: string; start: string; end: string; minutes: number }
export interface ActiveFocus {
  id: string;
  projectId: string;
  taskId: string;
  phase: 'work' | 'break';
  paused: boolean;
  start: string;
  /** When the current phase ends (already capped at the stop). Null while paused. */
  endsAt: string | null;
  /** Time left in the phase right now, capped at the stop. */
  remainingMs: number;
  phaseMs: number;
  /** Minutes of work done so far in this block. */
  workedMin: number;
  workMin: number;
  breakMin: number;
  cutoff: string;
  minutesToCutoff: number;
  /** The stop will end this phase before its time is up. */
  cutoffLimited: boolean;
  /** Within ten minutes of the stop during work. */
  stopWarning: boolean;
}
export interface FocusProject { id: string; name: string; color: string | null }

const err = (message: string, status = 400) => Object.assign(new Error(message), { status });
const ms = (iso: string) => fromISO(iso).toMillis();
const iso = (t: number) => fromMillis(t).toISO()!;
const toLog = (r: LogRow): FocusLog => ({ id: r.id, projectId: r.project_id, taskId: r.task_id, start: r.start, end: r.end, minutes: r.minutes });
const tenWord = (n: number) => (n === 10 ? 'Ten' : String(n));

export function createFocusService(ctx: Ctx) {
  const cfg = () => ctx.settings.get<FocusSettings>('focus');
  const day = () => ctx.service<DayService>('day');
  const activeRow = () => ctx.db.get<SessionRow>("SELECT * FROM sessions WHERE status = 'active' ORDER BY start DESC LIMIT 1");
  const rowById = (id: string) => ctx.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id)!;
  /** Running milliseconds in the current phase at instant `t` (a pause stops the clock). */
  const runMs = (s: SessionRow, t: number) => s.banked_ms + (s.run_since ? Math.max(0, t - ms(s.run_since)) : 0);

  function endSession(s: SessionRow, atMs: number, reason: 'complete' | 'stopped' | 'cutoff') {
    ctx.db.run("UPDATE sessions SET status = 'ended', end_reason = ?, ended_at = ?, run_since = NULL WHERE id = ?", reason, iso(atMs), s.id);
  }

  /** Close the work phase at `endMs`: log the minutes, then either start the break or end the session. */
  function finishWork(s: SessionRow, endMs: number, reason: 'complete' | 'stopped' | 'cutoff'): FocusLog | null {
    const minutes = Math.round(Math.min(runMs(s, endMs), s.work_min * MIN) / MIN);
    let log: FocusLog | null = null;
    if (minutes >= 1) {
      const row: LogRow = { id: uid(), project_id: s.project_id, task_id: s.task_id, date: dateOf(fromISO(s.start)), start: s.start, end: iso(endMs), minutes };
      ctx.db.run('INSERT INTO time_logs (id, project_id, task_id, session_id, date, start, end, minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        row.id, row.project_id, row.task_id, s.id, row.date, row.start, row.end, row.minutes);
      log = toLog(row);
      ctx.bus.emit('focus.completed', { projectId: s.project_id, taskId: s.task_id || null, minutes, date: row.date, logId: row.id });
    }
    if (reason === 'complete') {
      ctx.db.run("UPDATE sessions SET phase = 'break', phase_start = ?, banked_ms = 0, run_since = ?, paused_at = NULL, work_end = ? WHERE id = ?", iso(endMs), iso(endMs), iso(endMs), s.id);
    } else endSession(s, endMs, reason);
    return log;
  }

  /** Apply every transition that is due (work finished, break finished, stop reached). Returns the live session or null. */
  function settle(): SessionRow | null {
    let s = activeRow();
    if (!s) return null;
    const t = now().toMillis();
    const cutoff = ms(s.cutoff);
    if (s.phase === 'work') {
      const naturalEnd = s.run_since ? ms(s.run_since) + (s.work_min * MIN - s.banked_ms) : Infinity;
      if (naturalEnd <= t && naturalEnd <= cutoff) {
        finishWork(s, naturalEnd, 'complete');
        s = rowById(s.id);
      } else if (t >= cutoff) {
        finishWork(s, s.run_since ? cutoff : ms(s.paused_at!), 'cutoff');
        return null;
      } else return s;
    }
    // break phase
    const breakEnd = ms(s.phase_start) + s.break_min * MIN;
    const over = Math.min(breakEnd, cutoff);
    if (t >= over) { endSession(s, over, breakEnd <= cutoff ? 'complete' : 'cutoff'); return null; }
    return s;
  }

  function view(s: SessionRow): ActiveFocus {
    const t = now().toMillis();
    const cutoff = ms(s.cutoff);
    const phaseMs = (s.phase === 'work' ? s.work_min : s.break_min) * MIN;
    const paused = s.phase === 'work' && !s.run_since;
    const left = Math.max(0, phaseMs - runMs(s, t));
    const cutoffLimited = !paused && t + left > cutoff;
    const remaining = paused ? left : Math.max(0, Math.min(left, cutoff - t));
    const minutesToCutoff = Math.max(0, Math.round((cutoff - t) / MIN));
    return {
      id: s.id, projectId: s.project_id, taskId: s.task_id, phase: s.phase, paused, start: s.start,
      endsAt: paused ? null : iso(t + remaining), remainingMs: remaining, phaseMs,
      workedMin: s.phase === 'work' ? Math.floor(runMs(s, t) / MIN) : s.work_min,
      workMin: s.work_min, breakMin: s.break_min, cutoff: s.cutoff, minutesToCutoff, cutoffLimited,
      stopWarning: s.phase === 'work' && cutoff - t <= WARN_BEFORE_STOP_MIN * MIN,
    };
  }

  /** Projects worth focusing on: not paused, dropped, proposed or archived. Falls back to Todoist projects. */
  function projects(): FocusProject[] {
    const p = ctx.maybe<{ list(): { id: string; name: string; color: string; status: string; archived: boolean }[] }>('projects');
    if (p) {
      return p.list().filter((x) => !x.archived && !['pause', 'drop', 'proposed'].includes(x.status)).map((x) => ({ id: x.id, name: x.name, color: x.color }));
    }
    return (ctx.maybe<{ projects(): { id: string; name: string; color: string | null }[] }>('todoist')?.projects() ?? []).map((x) => ({ id: x.id, name: x.name, color: x.color }));
  }
  function projectName(id: string): string {
    const all = ctx.maybe<{ list(): { id: string; name: string }[] }>('projects')?.list().find((x) => x.id === id)?.name;
    return all ?? projects().find((x) => x.id === id)?.name ?? 'Project';
  }

  const svc = {
    settings: cfg,
    settle,
    projects,
    projectName,

    /** Time logs, newest last. `from`/`to` are inclusive local dates of the block's start. */
    timeLogs(q: { projectId?: string; from?: ISODate; to?: ISODate } = {}): FocusLog[] {
      const where: string[] = [];
      const params: string[] = [];
      if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
      if (q.from) { where.push('date >= ?'); params.push(q.from); }
      if (q.to) { where.push('date <= ?'); params.push(q.to); }
      return ctx.db.all<LogRow>(`SELECT * FROM time_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY start, rowid`, ...params).map(toLog);
    },

    /** The running block (work or break), or null. */
    active(): ActiveFocus | null {
      const s = settle();
      return s ? view(s) : null;
    },
    last(): { projectId: string; taskId: string } | null {
      const r = ctx.db.get<SessionRow>('SELECT * FROM sessions ORDER BY start DESC, rowid DESC LIMIT 1');
      return r ? { projectId: r.project_id, taskId: r.task_id } : null;
    },

    start(projectId: string, taskId?: string | null): ActiveFocus {
      if (!projectId) throw err('Pick a project first.');
      if (settle()) throw err('A focus block is already running. Stop it before starting another.', 409);
      const d = day();
      const date = d.planningDate();
      const stop = d.anchors(date).effectiveStop;
      const t = now();
      if (t.toMillis() >= stop.toMillis()) throw err(`Your stop was ${fmtTime(stop)}. No new focus blocks tonight.`, 409);
      const id = uid();
      const c = cfg();
      ctx.db.run(
        `INSERT INTO sessions (id, project_id, task_id, date, start, cutoff, work_min, break_min, phase, phase_start, banked_ms, run_since, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'work', ?, 0, ?, 'active')`,
        id, projectId, taskId ?? '', date, t.toISO(), stop.toISO(), c.workMin, c.breakMin, t.toISO(), t.toISO(),
      );
      ctx.bus.emit('focus.started', { projectId, taskId: taskId || null, date });
      return view(rowById(id));
    },

    pause(): ActiveFocus {
      const s = settle();
      if (!s) throw err('No focus block is running.', 409);
      if (s.phase !== 'work') throw err('Breaks don’t pause. Skip the break to stop it.', 409);
      if (!s.run_since) return view(s);
      const t = now().toMillis();
      ctx.db.run('UPDATE sessions SET banked_ms = ?, run_since = NULL, paused_at = ? WHERE id = ?', runMs(s, t), iso(t), s.id);
      return view(rowById(s.id));
    },
    resume(): ActiveFocus {
      const s = settle();
      if (!s) throw err('No focus block is running.', 409);
      if (s.run_since) return view(s);
      ctx.db.run('UPDATE sessions SET run_since = ?, paused_at = NULL WHERE id = ?', now().toISO(), s.id);
      return view(rowById(s.id));
    },
    /** End the block now. Work done so far is logged; stopping during the break just ends it. */
    stop(): FocusLog | null {
      const s = settle();
      if (!s) return null;
      const t = now().toMillis();
      if (s.phase === 'break') { endSession(s, t, 'stopped'); return null; }
      return finishWork(s, s.run_since ? t : ms(s.paused_at!), 'stopped');
    },

    /** Notifications for sessions on `date`, keyed by session id so each is sent once. */
    plan(date: ISODate): PlannedNotification[] {
      const out: PlannedNotification[] = [];
      for (const s of ctx.db.all<SessionRow>('SELECT * FROM sessions WHERE date = ? ORDER BY start', date)) {
        const cutoff = ms(s.cutoff);
        const active = s.status === 'active';
        const predictedEnd = active && s.phase === 'work' && s.run_since ? ms(s.run_since) + (s.work_min * MIN - s.banked_ms) : null;
        const workEnd = s.work_end ? ms(s.work_end) : predictedEnd;
        if (workEnd !== null && workEnd <= cutoff) {
          out.push({
            key: `focus.break:${s.id}`, at: fromMillis(workEnd), category: 'wellbeing', path: '/focus', title: 'Break',
            body: `${tenWord(s.break_min)} minutes away from screens — look out a window, refill water.`,
          });
          if (workEnd + s.break_min * MIN <= cutoff && (active || s.end_reason === 'complete')) {
            out.push({
              key: `focus.breakend:${s.id}`, at: fromMillis(workEnd + s.break_min * MIN), category: 'work', path: '/focus', title: 'Break over',
              body: 'Start another block, or call it here.',
            });
          }
        }
        const warnAt = cutoff - WARN_BEFORE_STOP_MIN * MIN;
        if (active && s.phase === 'work' && warnAt > ms(s.start) && (predictedEnd === null || predictedEnd > warnAt)) {
          out.push({
            key: `focus.stopwarn:${s.id}`, at: fromMillis(warnAt), category: 'wellbeing', path: '/focus', title: 'Stop in 10 minutes',
            body: `This block ends at ${fmtTime(fromMillis(cutoff))}. Wrap up what you can.`,
          });
        }
      }
      return out;
    },
  };
  return svc;
}
export type FocusService = ReturnType<typeof createFocusService>;

export default defineModule({
  id: 'focus',
  name: 'Focus',
  description: 'One project at a time: a 50-minute block, then ten minutes away from screens. Time is logged to the project.',
  requires: ['day'],
  settings,
  migrations: [
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       task_id TEXT NOT NULL DEFAULT '',
       date TEXT NOT NULL,
       start TEXT NOT NULL,
       cutoff TEXT NOT NULL,
       work_min INTEGER NOT NULL,
       break_min INTEGER NOT NULL,
       phase TEXT NOT NULL DEFAULT 'work',
       phase_start TEXT NOT NULL,
       banked_ms INTEGER NOT NULL DEFAULT 0,
       run_since TEXT,
       paused_at TEXT,
       work_end TEXT,
       status TEXT NOT NULL DEFAULT 'active',
       end_reason TEXT,
       ended_at TEXT
     );
     CREATE INDEX sessions_date ON sessions(date);
     CREATE TABLE time_logs (
       id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       task_id TEXT NOT NULL DEFAULT '',
       session_id TEXT,
       date TEXT NOT NULL,
       start TEXT NOT NULL,
       end TEXT NOT NULL,
       minutes INTEGER NOT NULL
     );
     CREATE INDEX time_logs_project ON time_logs(project_id, date);`,
  ],
  service: createFocusService,
  emits: ['focus.started', 'focus.completed'],
  jobs: [{ id: 'focus.settle', every: 1, run: (ctx) => { ctx.service<FocusService>('focus').settle(); } }],
  notifications: (ctx, date) => ctx.service<FocusService>('focus').plan(date),
  routes(r, ctx) {
    const svc = () => ctx.service<FocusService>('focus');
    const body = async (c: any) => z.object({ projectId: z.string().min(1), taskId: z.string().nullish() }).parse(await c.req.json());
    r.get('/active', (c) => {
      const f = svc();
      const a = f.active();
      return c.json({ session: a && { ...a, projectName: f.projectName(a.projectId) }, last: f.last(), workMin: f.settings().workMin, breakMin: f.settings().breakMin });
    });
    r.get('/projects', (c) => c.json(svc().projects()));
    /** Open Todoist tasks for the picker: the project's linked Todoist project or label. */
    r.get('/tasks', (c) => {
      const id = c.req.query('projectId');
      const td = ctx.maybe<any>('todoist');
      if (!id || !td) return c.json([]);
      const link = ctx.maybe<any>('projects')?.get(id)?.todoist as { type: string; id?: string; name?: string } | null | undefined;
      const filter = link ? (link.type === 'label' ? { label: link.name } : { projectId: link.id }) : { projectId: id };
      return c.json(td.tasks(filter).slice(0, 50).map((t: any) => ({ id: t.id, content: t.content })));
    });
    r.get('/logs', (c) => {
      const f = svc();
      const logs = f.timeLogs({ projectId: c.req.query('projectId') ?? undefined, from: c.req.query('from') ?? undefined, to: c.req.query('to') ?? undefined });
      return c.json(logs.map((l) => ({ ...l, projectName: f.projectName(l.projectId) })));
    });
    r.post('/start', async (c) => { const b = await body(c); return c.json(svc().start(b.projectId, b.taskId)); });
    r.post('/pause', (c) => c.json(svc().pause()));
    r.post('/resume', (c) => c.json(svc().resume()));
    r.post('/stop', (c) => c.json({ log: svc().stop() }));
  },
  nav: [{ id: 'focus', label: 'Focus', icon: 'Timer', path: '/focus', section: 'main', order: 35, work: true }],
  widgets: [{ id: 'timer', slot: 'today.main', order: 50 }],
  claude: {
    context: (ctx) => {
      const f = ctx.service<FocusService>('focus');
      const a = f.active();
      return a ? { running: { projectId: a.projectId, phase: a.phase, remainingMin: Math.round(a.remainingMs / MIN) } } : { running: null };
    },
  },
});
