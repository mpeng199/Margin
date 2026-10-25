/**
 * SQLite via Node's built-in node:sqlite (no native build step, no ABI drift).
 * Each module owns its tables through an ordered list of SQL migrations.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type Row = Record<string, any>;
export type Params = SQLInputValue[] | [Record<string, SQLInputValue>];

export class DB {
  readonly raw: DatabaseSync;
  private stmts = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 4000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS _migrations (
        module TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.stmt(sql).all(...norm(sql, params)) as T[];
  }
  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.stmt(sql).get(...norm(sql, params)) as T | undefined;
  }
  run(sql: string, ...params: any[]) {
    return this.stmt(sql).run(...norm(sql, params));
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  /** Runs fn in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  private depth = 0;

  /** JSON helpers: columns named *_json are parsed on read by callers via j(). */
  migrate(module: string, migrations: string[]) {
    const cur = this.get<{ version: number }>('SELECT version FROM _migrations WHERE module = ?', module)?.version ?? 0;
    if (cur >= migrations.length) return;
    this.tx(() => {
      for (let v = cur; v < migrations.length; v++) this.raw.exec(migrations[v]);
      this.run(
        `INSERT INTO _migrations (module, version, applied_at) VALUES (?, ?, ?)
         ON CONFLICT(module) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
        module, migrations.length, new Date().toISOString(),
      );
    });
  }

  close() { this.raw.close(); }
}

const NAMED = /[$:@][A-Za-z_]/;
/**
 * node:sqlite rejects booleans and undefined; map them. Objects/arrays are stored as JSON.
 * A single object argument is treated as named parameters only when the SQL uses $name/:name/@name.
 */
function norm(sql: string, params: any[]): any[] {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array) && NAMED.test(sql)) {
    const o: Record<string, any> = {};
    for (const [k, v] of Object.entries(params[0])) o[k] = val(v);
    return [o];
  }
  return params.map(val);
}
function val(v: any) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** Parse a JSON column, tolerating null. */
export function j<T = any>(v: unknown, fallback: T): T {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

export const uid = () => crypto.randomUUID();
