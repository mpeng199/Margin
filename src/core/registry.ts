/**
 * Discovers /modules/<id>/manifest.ts, tracks which are enabled (toggleable at runtime, no restart),
 * and exposes public metadata to the web app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DB } from './db';
import type { ModuleManifest } from './types';
import type { SettingsStore } from './settings';

export class Registry {
  readonly all: ModuleManifest[] = [];
  private byId = new Map<string, ModuleManifest>();

  constructor(private db: DB) {
    db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)`);
  }

  add(m: ModuleManifest) {
    if (this.byId.has(m.id)) throw new Error(`Duplicate module id ${m.id}`);
    this.all.push(m);
    this.byId.set(m.id, m);
  }
  get(id: string) { return this.byId.get(id); }

  private overrides(): Record<string, boolean> {
    const row = this.db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'modules.enabled'");
    return row ? JSON.parse(row.value) : {};
  }
  isEnabled(id: string): boolean {
    const m = this.byId.get(id);
    if (!m) return false;
    if (m.core) return true;
    const o = this.overrides();
    const self = o[id] ?? m.defaultEnabled !== false;
    return self && (m.requires ?? []).every((r) => this.isEnabled(r));
  }
  setEnabled(id: string, on: boolean) {
    const m = this.byId.get(id);
    if (!m) throw new Error(`Unknown module ${id}`);
    if (m.core && !on) throw new Error(`${m.name} is a core module and can't be turned off`);
    const o = this.overrides();
    o[id] = on;
    this.db.run(`INSERT INTO kv (key, value, updated_at) VALUES ('modules.enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(o), new Date().toISOString());
  }
  enabled() { return this.all.filter((m) => this.isEnabled(m.id)); }

  publicInfo(settings: SettingsStore) {
    return this.all.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      core: !!m.core,
      enabled: this.isEnabled(m.id),
      requires: m.requires ?? [],
      nav: m.nav ?? [],
      widgets: m.widgets ?? [],
      emits: m.emits ?? [],
      consumes: Object.keys(m.on ?? {}),
      hasSettings: !!m.settings,
      settingsSchema: m.settings ? settings.jsonSchema(m.id) : null,
      claudeTools: (m.claude?.tools ?? []).map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      ruleConditions: (m.rules?.conditions ?? []).map((c) => c.id),
      ruleActions: (m.rules?.actions ?? []).map((a) => a.id),
      jobs: (m.jobs ?? []).map((j) => j.id),
    }));
  }
}

/** Import every modules/<id>/manifest.ts, ordered so `requires` come first. */
export async function discoverModules(modulesDir: string): Promise<ModuleManifest[]> {
  const ids = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((id) => fs.existsSync(path.join(modulesDir, id, 'manifest.ts')));
  const manifests: ModuleManifest[] = [];
  for (const id of ids) {
    const mod = await import(pathToFileURL(path.join(modulesDir, id, 'manifest.ts')).href);
    const m: ModuleManifest = mod.default;
    if (!m || m.id !== id) throw new Error(`modules/${id}/manifest.ts must default-export a manifest with id "${id}"`);
    manifests.push(m);
  }
  // Topological order on requires (stable otherwise).
  const out: ModuleManifest[] = [];
  const seen = new Set<string>();
  const visit = (m: ModuleManifest, stack: string[] = []) => {
    if (seen.has(m.id)) return;
    if (stack.includes(m.id)) throw new Error(`Module dependency cycle: ${[...stack, m.id].join(' → ')}`);
    for (const r of m.requires ?? []) {
      const dep = manifests.find((x) => x.id === r);
      if (dep) visit(dep, [...stack, m.id]);
    }
    seen.add(m.id);
    out.push(m);
  };
  manifests.forEach((m) => visit(m));
  return out;
}
