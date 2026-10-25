/**
 * Change sets: the only path for bulk writes and for anything Claude initiates.
 * A change set is a list of typed changes, each rendered as a before → after diff, applied
 * all/some/none after review. Appliers are registered per `kind` by integrations and modules.
 * There is deliberately no applier that deletes a Todoist task or project.
 */
import type { DB } from './db';
import { j, uid } from './db';
import type { Bus } from './bus';
import type { Ctx } from './types';
import { now } from './time';

export interface ProposedChange {
  kind: string;
  /** One line a person can read, e.g. "Move “Draft abstract” to Tue Nov 3". */
  title: string;
  payload: Record<string, any>;
  /** Snapshot of the target before the change, for the diff. */
  before?: Record<string, any> | null;
}
export interface Change extends ProposedChange {
  id: string;
  setId: string;
  idx: number;
  status: 'pending' | 'applied' | 'skipped' | 'failed';
  error?: string | null;
  result?: any;
}
export interface ChangeSet {
  id: string;
  source: 'claude' | 'review' | 'bulk' | 'onboarding' | 'user' | 'shutdown' | 'mcp' | string;
  title: string;
  summary: string;
  status: 'pending' | 'applied' | 'partial' | 'failed' | 'discarded';
  createdAt: string;
  appliedAt?: string | null;
  changes: Change[];
}
export interface Applier {
  label: string;
  /** Fields of the payload a person may edit in the review UI. */
  editable?: string[];
  apply: (ctx: Ctx, payload: any) => Promise<unknown> | unknown;
}

export class ChangeSets {
  private appliers = new Map<string, Applier>();
  constructor(private db: DB, private bus: Bus, private getCtx: () => Ctx) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS change_sets (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES change_sets(id), idx INTEGER NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL, before TEXT,
        status TEXT NOT NULL, error TEXT, result TEXT
      );
      CREATE INDEX IF NOT EXISTS changes_set ON changes(set_id, idx);
    `);
  }

  register(kind: string, applier: Applier) { this.appliers.set(kind, applier); }
  kinds() { return [...this.appliers.entries()].map(([kind, a]) => ({ kind, label: a.label, editable: a.editable ?? [] })); }

  propose(input: { source: ChangeSet['source']; title: string; summary?: string; changes: ProposedChange[] }): ChangeSet {
    for (const c of input.changes) if (!this.appliers.has(c.kind)) throw new Error(`No applier for change kind "${c.kind}"`);
    const id = uid();
    this.db.tx(() => {
      this.db.run('INSERT INTO change_sets (id, source, title, summary, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, input.source, input.title, input.summary ?? '', 'pending', now().toISO());
      input.changes.forEach((c, idx) =>
        this.db.run('INSERT INTO changes (id, set_id, idx, kind, title, payload, before, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          uid(), id, idx, c.kind, c.title, JSON.stringify(c.payload), c.before ? JSON.stringify(c.before) : null, 'pending'));
    });
    this.bus.emit('changeset.proposed', { id, source: input.source, count: input.changes.length });
    return this.get(id)!;
  }

  get(id: string): ChangeSet | null {
    const s = this.db.get('SELECT * FROM change_sets WHERE id = ?', id);
    if (!s) return null;
    const changes = this.db.all('SELECT * FROM changes WHERE set_id = ? ORDER BY idx', id).map((c) => ({
      id: c.id, setId: c.set_id, idx: c.idx, kind: c.kind, title: c.title,
      payload: j(c.payload, {}), before: j(c.before, null), status: c.status, error: c.error, result: j(c.result, null),
    }));
    return { id: s.id, source: s.source, title: s.title, summary: s.summary, status: s.status, createdAt: s.created_at, appliedAt: s.applied_at, changes };
  }

  list(status?: string): ChangeSet[] {
    const rows = status
      ? this.db.all<{ id: string }>('SELECT id FROM change_sets WHERE status = ? ORDER BY created_at DESC LIMIT 100', status)
      : this.db.all<{ id: string }>('SELECT id FROM change_sets ORDER BY created_at DESC LIMIT 100');
    return rows.map((r) => this.get(r.id)!);
  }

  /** Edit a pending change's payload (only fields the applier marks editable). */
  edit(setId: string, changeId: string, patch: Record<string, unknown>) {
    const c = this.db.get('SELECT * FROM changes WHERE id = ? AND set_id = ?', changeId, setId);
    if (!c || c.status !== 'pending') throw new Error('Change not editable');
    const editable = this.appliers.get(c.kind)?.editable ?? [];
    const payload = j<Record<string, unknown>>(c.payload, {});
    for (const [k, v] of Object.entries(patch)) {
      if (!editable.includes(k)) throw new Error(`Field "${k}" is not editable`);
      payload[k] = v;
    }
    this.db.run('UPDATE changes SET payload = ? WHERE id = ?', JSON.stringify(payload), changeId);
    return this.get(setId);
  }

  /** Apply the selected changes in order (all pending ones when changeIds is omitted). Others become skipped. */
  async apply(setId: string, changeIds?: string[]): Promise<ChangeSet> {
    const set = this.get(setId);
    if (!set) throw new Error('Change set not found');
    if (set.status !== 'pending') throw new Error(`Change set is ${set.status}`);
    const chosen = new Set(changeIds ?? set.changes.map((c) => c.id));
    const ctx = this.getCtx();
    for (const c of set.changes) {
      if (c.status !== 'pending') continue;
      if (!chosen.has(c.id)) {
        this.db.run("UPDATE changes SET status = 'skipped' WHERE id = ?", c.id);
        continue;
      }
      try {
        const result = await this.appliers.get(c.kind)!.apply(ctx, c.payload);
        this.db.run("UPDATE changes SET status = 'applied', result = ? WHERE id = ?", JSON.stringify(result ?? null), c.id);
      } catch (e: any) {
        this.db.run("UPDATE changes SET status = 'failed', error = ? WHERE id = ?", String(e?.message ?? e), c.id);
      }
    }
    const after = this.get(setId)!;
    const applied = after.changes.filter((c) => c.status === 'applied').length;
    const failed = after.changes.filter((c) => c.status === 'failed').length;
    const status = failed && !applied ? 'failed' : applied === after.changes.length ? 'applied' : 'partial';
    this.db.run('UPDATE change_sets SET status = ?, applied_at = ? WHERE id = ?', status, now().toISO(), setId);
    this.bus.emit('changeset.applied', { id: setId, applied, failed, source: set.source });
    return this.get(setId)!;
  }

  discard(setId: string) {
    this.db.run("UPDATE change_sets SET status = 'discarded' WHERE id = ? AND status = 'pending'", setId);
    this.db.run("UPDATE changes SET status = 'skipped' WHERE set_id = ? AND status = 'pending'", setId);
    this.bus.emit('changeset.discarded', { id: setId });
  }
}
