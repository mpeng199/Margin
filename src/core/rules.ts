/**
 * Pre-committed if-then rules stored as data. Modules contribute conditions and actions;
 * rules reference them by id. A rule fires once when all its conditions become true, stays
 * active (shown as a banner) until its conditions clear or it is dismissed, then can fire again.
 */
import { z } from 'zod';
import type { DB } from './db';
import { j, uid } from './db';
import type { Bus } from './bus';
import type { Ctx, RuleAction, RuleCondition, RuleDef, RuleFiringInfo } from './types';
import { now, today } from './time';

export interface Firing {
  id: string;
  ruleId: string;
  ruleName: string;
  firedAt: string;
  detail: string;
  subject?: string | null;
  why?: string | null;
  source?: string | null;
  actions: string[];
  dismissedOn?: string | null;
  resolvedAt?: string | null;
}

export class RulesEngine {
  private conditions = new Map<string, RuleCondition & { module: string }>();
  private actions = new Map<string, RuleAction & { module: string }>();

  constructor(private db: DB, private bus: Bus, private getCtx: () => Ctx) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY, def TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rule_firings (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, fired_at TEXT NOT NULL, detail TEXT NOT NULL,
        subject TEXT, actions TEXT NOT NULL, dismissed_on TEXT, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS rule_firings_rule ON rule_firings(rule_id, fired_at);
    `);
  }

  addCondition(module: string, c: RuleCondition) { this.conditions.set(c.id, { ...c, module }); }
  addAction(module: string, a: RuleAction) { this.actions.set(a.id, { ...a, module }); }

  catalog() {
    const enabled = (mod: string) => this.getCtx().registry.isEnabled(mod);
    const toJson = (schema: any) => { try { return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }); } catch { return null; } };
    return {
      conditions: [...this.conditions.values()].map((c) => ({ id: c.id, label: c.label, description: c.description, module: c.module, available: enabled(c.module), params: toJson(c.params) })),
      actions: [...this.actions.values()].map((a) => ({ id: a.id, label: a.label, module: a.module, available: enabled(a.module), params: toJson(a.params) })),
    };
  }

  /** Insert default rules once; never overwrite a rule the person edited. */
  seed(defs: RuleDef[]) {
    for (const d of defs) {
      if (!this.db.get('SELECT 1 FROM rules WHERE id = ?', d.id)) {
        this.db.run('INSERT INTO rules (id, def, builtin, updated_at) VALUES (?, ?, 1, ?)', d.id, JSON.stringify(d), now().toISO());
      }
    }
  }

  list(): (RuleDef & { builtin: boolean; available: boolean })[] {
    return this.db.all('SELECT * FROM rules ORDER BY builtin DESC, updated_at').map((r) => {
      const def = j<RuleDef>(r.def, null as any);
      const available = def.when.every((w) => this.isAvailable(this.conditions.get(w.condition)))
        && def.then.every((t) => this.isAvailable(this.actions.get(t.action)));
      return { ...def, builtin: !!r.builtin, available };
    });
  }
  private isAvailable(x?: { module: string }) { return !!x && this.getCtx().registry.isEnabled(x.module); }

  save(def: RuleDef) {
    for (const w of def.when) {
      const c = this.conditions.get(w.condition);
      if (!c) throw new Error(`Unknown condition ${w.condition}`);
      w.params = c.params.parse(w.params ?? {});
    }
    for (const t of def.then) {
      const a = this.actions.get(t.action);
      if (!a) throw new Error(`Unknown action ${t.action}`);
      t.params = a.params.parse(t.params ?? {});
    }
    const id = def.id || uid();
    this.db.run(`INSERT INTO rules (id, def, builtin, updated_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET def = excluded.def, updated_at = excluded.updated_at`, id, JSON.stringify({ ...def, id }), now().toISO());
    this.bus.emit('rules.changed', { id });
    return id;
  }

  remove(id: string) {
    this.db.run('DELETE FROM rules WHERE id = ? AND builtin = 0', id);
    this.db.run('UPDATE rules SET def = json_set(def, \'$.enabled\', json(\'false\')) WHERE id = ? AND builtin = 1', id);
  }

  /** Evaluate every enabled rule. New firings run their actions; cleared conditions resolve firings. */
  async evaluate(): Promise<Firing[]> {
    const ctx = this.getCtx();
    const fired: Firing[] = [];
    for (const rule of this.list()) {
      if (!rule.enabled || !rule.available) continue;
      let met = true;
      const details: string[] = [];
      let subject: string | undefined;
      for (const w of rule.when) {
        const c = this.conditions.get(w.condition)!;
        try {
          const res = await c.evaluate(ctx, c.params.parse(w.params ?? {}));
          if (!res.met) { met = false; break; }
          if (res.detail) details.push(res.detail);
          subject ??= res.subject;
        } catch (e) {
          ctx.log.error(`rule condition ${w.condition} failed`, e);
          met = false;
          break;
        }
      }
      const active = this.db.get('SELECT * FROM rule_firings WHERE rule_id = ? AND resolved_at IS NULL ORDER BY fired_at DESC LIMIT 1', rule.id);
      if (met && !active) {
        const f: Firing = {
          id: uid(), ruleId: rule.id, ruleName: rule.name, firedAt: now().toISO()!,
          detail: details.join(' ') || rule.name, subject, why: rule.why, source: rule.source,
          actions: rule.then.map((t) => t.action),
        };
        this.db.run('INSERT INTO rule_firings (id, rule_id, fired_at, detail, subject, actions) VALUES (?, ?, ?, ?, ?, ?)',
          f.id, f.ruleId, f.firedAt, f.detail, f.subject ?? null, JSON.stringify(f.actions));
        const info: RuleFiringInfo = { ruleId: rule.id, ruleName: rule.name, detail: f.detail, subject, why: rule.why };
        for (const t of rule.then) {
          const a = this.actions.get(t.action)!;
          try { await a.run(ctx, a.params.parse(t.params ?? {}), info); }
          catch (e) { ctx.log.error(`rule action ${t.action} failed`, e); }
        }
        this.bus.emit('rule.fired', { ruleId: rule.id, detail: f.detail, subject });
        fired.push(f);
      } else if (!met && active) {
        this.db.run('UPDATE rule_firings SET resolved_at = ? WHERE id = ?', now().toISO(), active.id);
        this.bus.emit('rule.resolved', { ruleId: rule.id });
      }
    }
    return fired;
  }

  /** Active firings not dismissed today. */
  active(): Firing[] {
    const t = today();
    const rules = new Map(this.list().map((r) => [r.id, r]));
    return this.db.all('SELECT * FROM rule_firings WHERE resolved_at IS NULL ORDER BY fired_at DESC')
      .filter((f) => f.dismissed_on !== t)
      .map((f) => ({
        id: f.id, ruleId: f.rule_id, ruleName: rules.get(f.rule_id)?.name ?? f.rule_id, firedAt: f.fired_at,
        detail: f.detail, subject: f.subject, why: rules.get(f.rule_id)?.why, source: rules.get(f.rule_id)?.source,
        actions: j(f.actions, []), dismissedOn: f.dismissed_on, resolvedAt: f.resolved_at,
      }));
  }
  isActive(ruleIdOrAction: string) {
    return this.active().some((f) => f.ruleId === ruleIdOrAction || f.actions.includes(ruleIdOrAction));
  }
  /** Dismiss for today only (it returns tomorrow while the condition still holds). */
  dismiss(firingId: string) {
    this.db.run('UPDATE rule_firings SET dismissed_on = ? WHERE id = ?', today(), firingId);
  }
  history(limit = 100): Firing[] {
    return this.db.all('SELECT * FROM rule_firings ORDER BY fired_at DESC LIMIT ?', limit).map((f) => ({
      id: f.id, ruleId: f.rule_id, ruleName: f.rule_id, firedAt: f.fired_at, detail: f.detail, subject: f.subject,
      actions: j(f.actions, []), dismissedOn: f.dismissed_on, resolvedAt: f.resolved_at,
    }));
  }
}
