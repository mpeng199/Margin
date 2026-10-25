/**
 * The module contract. Every feature is a folder under /modules with a manifest.ts
 * default-exporting a ModuleManifest. The daemon discovers folders at boot; nothing
 * else needs editing to add a module. See docs/ADDING_A_MODULE.md.
 */
import type { Hono } from 'hono';
import type { z } from 'zod';
import type { DateTime } from 'luxon';
import type { DB } from './db';
import type { Bus } from './bus';
import type { SettingsStore } from './settings';
import type { Keychain } from './keychain';
import type { Notifier, NotificationCategory } from './notify';
import type { ChangeSets } from './changesets';
import type { RulesEngine } from './rules';
import type { Registry } from './registry';
import type { Logger } from './log';
import type { ISODate, HHMM } from './time';

export interface Ctx {
  db: DB;
  bus: Bus;
  settings: SettingsStore;
  keychain: Keychain;
  notify: Notifier;
  changes: ChangeSets;
  rules: RulesEngine;
  registry: Registry;
  log: Logger;
  /** Service exposed by another module's `service()` factory (throws if the module is missing). */
  service<T = any>(moduleId: string): T;
  /** Same, but undefined when the module is disabled. */
  maybe<T = any>(moduleId: string): T | undefined;
  dataDir: string;
  dev: boolean;
}

export interface Job {
  id: string;
  /** Run every N minutes. */
  every?: number;
  /** Or at wall-clock times each day (resolved per date, DST-safe). */
  at?: (ctx: Ctx, date: ISODate) => HHMM[];
  run: (ctx: Ctx) => void | Promise<void>;
}

export interface PlannedNotification {
  /** Unique per occurrence, e.g. `shutdown.wrap:2026-11-01`. Used to never send twice. */
  key: string;
  at: DateTime;
  title: string;
  body: string;
  category: NotificationCategory;
  /** In-app path to open on click, e.g. '/shutdown'. */
  path?: string;
}

export interface NavEntry {
  id: string;
  label: string;
  /** lucide-react icon name in PascalCase, e.g. 'Sun', 'CalendarDays'. */
  icon: string;
  path: string;
  section: 'main' | 'projects' | 'secondary';
  order: number;
  /** Shown in the command palette and as a menu accelerator hint, e.g. 'Mod+1'. */
  shortcut?: string;
  /** Counts as a "work view" (gated in Evening mode and on the off-day). */
  work?: boolean;
}

export type WidgetSlot = 'today.banner' | 'today.main' | 'today.side' | 'evening' | 'offday';
export interface WidgetDecl {
  id: string;
  slot: WidgetSlot;
  order: number;
}

export interface RuleEvalResult {
  met: boolean;
  /** Plain sentence shown in the banner/review, e.g. "Stop broken 2 times this week." */
  detail?: string;
  /** Optional subject (e.g. a project id) the actions can use. */
  subject?: string;
}
export interface RuleCondition {
  id: string;
  label: string;
  description: string;
  params: z.ZodObject<any>;
  evaluate: (ctx: Ctx, params: any) => RuleEvalResult | Promise<RuleEvalResult>;
}
export interface RuleFiringInfo {
  ruleId: string;
  ruleName: string;
  detail: string;
  subject?: string;
  why?: string;
}
export interface RuleAction {
  id: string;
  label: string;
  params: z.ZodObject<any>;
  run: (ctx: Ctx, params: any, firing: RuleFiringInfo) => void | Promise<void>;
}
export interface RuleDef {
  id: string;
  name: string;
  enabled: boolean;
  /** All conditions must hold (AND). Use separate rules for OR. */
  when: { condition: string; params: Record<string, unknown> }[];
  then: { action: string; params: Record<string, unknown> }[];
  why?: string;
  source?: string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input: z.ZodObject<any>;
  /**
   * Read tools return data. Write tools must not write: they return proposed changes
   * ({ kind, title, payload }[]) which the caller collects into one change set.
   */
  kind: 'read' | 'propose';
  run: (ctx: Ctx, input: any) => unknown | Promise<unknown>;
}

export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  /** Core modules cannot be disabled. */
  core?: boolean;
  /** Default on unless false. */
  defaultEnabled?: boolean;
  /** Other module ids this one needs enabled. */
  requires?: string[];
  /** zod object; every field needs a .default() so `{}` parses. Rendered in Settings automatically. */
  settings?: z.ZodObject<any>;
  /** Ordered SQL migrations. Append only; never edit a shipped one. */
  migrations?: string[];
  /** Factory for an object other modules can call via ctx.service(id). */
  service?: (ctx: Ctx) => unknown;
  /** Mounted at /api/<id>. */
  routes?: (r: Hono, ctx: Ctx) => void;
  /** Runs once at boot after migrations and services exist. */
  init?: (ctx: Ctx) => void | Promise<void>;
  jobs?: Job[];
  /** Notifications this module wants for a given local date. Re-planned every tick, sent once per key. */
  notifications?: (ctx: Ctx, date: ISODate) => PlannedNotification[];
  /** Event names this module emits (documentation + palette of the rules editor). */
  emits?: string[];
  /** Event handlers. */
  on?: Record<string, (payload: any, ctx: Ctx) => void | Promise<void>>;
  rules?: { conditions?: RuleCondition[]; actions?: RuleAction[]; defaults?: RuleDef[] };
  claude?: {
    tools?: ClaudeTool[];
    /** Short, stable context about this module's state for Claude (respect privacy toggles). */
    context?: (ctx: Ctx) => unknown | Promise<unknown>;
  };
  nav?: NavEntry[];
  widgets?: WidgetDecl[];
}

export function defineModule(m: ModuleManifest): ModuleManifest {
  return m;
}
