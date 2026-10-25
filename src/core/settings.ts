/**
 * Schema-validated settings. Each module declares a zod object (every field defaulted);
 * values are stored as one JSON blob per module. Unknown/invalid stored values fall back to defaults.
 */
import { z } from 'zod';
import type { DB } from './db';
import type { Bus } from './bus';

export class SettingsStore {
  private schemas = new Map<string, z.ZodObject<any>>();
  constructor(private db: DB, private bus: Bus) {
    db.exec(`CREATE TABLE IF NOT EXISTS settings (module TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  register(moduleId: string, schema: z.ZodObject<any>) {
    this.schemas.set(moduleId, schema);
  }
  schema(moduleId: string) { return this.schemas.get(moduleId); }
  modules() { return [...this.schemas.keys()]; }

  get<T = Record<string, any>>(moduleId: string): T {
    const schema = this.schemas.get(moduleId);
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE module = ?', moduleId);
    const stored = row ? safeParse(row.value) : {};
    if (!schema) return stored as T;
    const res = schema.safeParse(stored);
    if (res.success) return res.data as T;
    // Keep valid fields, default the rest.
    const partial: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(stored)) {
      const field = (schema.shape as Record<string, z.ZodTypeAny>)[k];
      if (field && field.safeParse(v).success) partial[k] = v;
    }
    return schema.parse(partial) as T;
  }

  /** Shallow-merge a patch, validate, persist. Throws a ZodError on invalid input. */
  set<T = Record<string, any>>(moduleId: string, patch: Record<string, unknown>): T {
    const schema = this.schemas.get(moduleId);
    const merged = { ...this.get(moduleId), ...patch };
    const value = schema ? schema.parse(merged) : merged;
    this.db.run(
      `INSERT INTO settings (module, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(module) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      moduleId, JSON.stringify(value), new Date().toISOString(),
    );
    this.bus.emit('settings.changed', { module: moduleId, keys: Object.keys(patch) });
    return value as T;
  }

  /** JSON Schema for the Settings UI (generated from zod). */
  jsonSchema(moduleId: string) {
    const s = this.schemas.get(moduleId);
    return s ? z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) : null;
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}
