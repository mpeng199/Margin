/**
 * One tick loop instead of cron. Every 30 s it asks each enabled module what is due and runs it.
 * Fire times are recomputed from wall-clock anchors on every tick, so DST shifts, laptop sleep and
 * settings changes need no re-registration. Each occurrence has a key and runs at most once.
 */
import type { Ctx } from './types';
import { now, today, addDays, at, minutesBetween } from './time';

const LATE_LIMIT_MIN = 20; // a notification more than 20 min late (e.g. laptop was asleep) is skipped, not sent stale
const JOB_LATE_LIMIT_MIN = 6 * 60;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private ctx: Ctx) {
    ctx.db.exec(`CREATE TABLE IF NOT EXISTS job_runs (key TEXT PRIMARY KEY, ran_at TEXT NOT NULL)`);
  }

  start(intervalMs = 30_000) {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const t = now();
      const d = today();
      for (const m of this.ctx.registry.enabled()) {
        for (const job of m.jobs ?? []) {
          try {
            if (job.every) {
              const key = `every:${m.id}:${job.id}`;
              const last = this.ctx.db.get<{ ran_at: string }>('SELECT ran_at FROM job_runs WHERE key = ?', key);
              if (!last || (t.toMillis() - Date.parse(last.ran_at)) / 60000 >= job.every) {
                this.mark(key);
                await job.run(this.ctx);
              }
            }
            if (job.at) {
              for (const hhmm of job.at(this.ctx, d)) {
                const fire = at(d, hhmm);
                const key = `at:${m.id}:${job.id}:${d}:${hhmm}`;
                const late = minutesBetween(fire, t);
                if (late >= 0 && late <= JOB_LATE_LIMIT_MIN && !this.ran(key)) {
                  this.mark(key);
                  await job.run(this.ctx);
                }
              }
            }
          } catch (e) {
            this.ctx.log.error(`job ${m.id}.${job.id} failed`, e);
          }
        }
        if (m.notifications) {
          for (const date of [addDays(d, -1), d]) {
            let planned;
            try { planned = m.notifications(this.ctx, date); } catch (e) { this.ctx.log.error(`notifications ${m.id} failed`, e); continue; }
            for (const n of planned) {
              const late = minutesBetween(n.at, t);
              if (late >= 0 && late <= LATE_LIMIT_MIN && !this.ctx.notify.wasSent(n.key)) {
                this.ctx.notify.send({ key: n.key, title: n.title, body: n.body, category: n.category, path: n.path });
              }
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private ran(key: string) { return !!this.ctx.db.get('SELECT 1 FROM job_runs WHERE key = ?', key); }
  private mark(key: string) {
    this.ctx.db.run('INSERT INTO job_runs (key, ran_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ran_at = excluded.ran_at', key, now().toISO());
  }
}
