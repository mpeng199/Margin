import type { DB } from './db';

/** Small key/value store for flags and sync cursors (table created by the registry). */
export function kvGet<T = any>(db: DB, key: string, fallback: T): T {
  const row = db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}
export function kvSet(db: DB, key: string, value: unknown) {
  db.run(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), new Date().toISOString());
}
export function kvDel(db: DB, key: string) {
  db.run('DELETE FROM kv WHERE key = ?', key);
}
