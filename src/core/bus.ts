/** In-process event bus. Every event is also appended to the `events` table (the app's activity log). */
import type { DB } from './db';
import type { Logger } from './log';
import { now } from './time';

export type Handler = (payload: any) => void | Promise<void>;

export class Bus {
  private handlers = new Map<string, Set<Handler>>();
  constructor(private db: DB, private log: Logger) {
    db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      payload TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_name_at ON events(name, at);`);
  }

  on(name: string, h: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(h);
    return () => this.handlers.get(name)!.delete(h);
  }

  /** Persist then fan out. Handlers run after the caller's stack unwinds; errors are logged, never thrown back. */
  emit(name: string, payload: Record<string, unknown> = {}) {
    this.db.run('INSERT INTO events (name, payload, at) VALUES (?, ?, ?)', name, JSON.stringify(payload), now().toISO());
    const hs = [...(this.handlers.get(name) ?? []), ...(this.handlers.get('*') ?? [])];
    queueMicrotask(async () => {
      for (const h of hs) {
        try { await h({ ...payload, $event: name }); }
        catch (e) { this.log.error(`event handler for ${name} failed`, e); }
      }
    });
  }

  /** Events of a name since an ISO timestamp (inclusive). */
  since(name: string, iso: string): { payload: any; at: string }[] {
    return this.db
      .all<{ payload: string; at: string }>('SELECT payload, at FROM events WHERE name = ? AND at >= ? ORDER BY at', name, iso)
      .map((r) => ({ payload: JSON.parse(r.payload ?? '{}'), at: r.at }));
  }
}
