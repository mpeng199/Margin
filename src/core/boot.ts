/** Wires the core shell together. Used by the daemon, the tests, and the MCP server. */
import path from 'node:path';
import { DB } from './db';
import { Bus } from './bus';
import { Registry, discoverModules } from './registry';
import { SettingsStore } from './settings';
import { createKeychain, type Keychain } from './keychain';
import { Notifier } from './notify';
import { ChangeSets } from './changesets';
import { RulesEngine } from './rules';
import { Scheduler } from './scheduler';
import { createLogger } from './log';
import { createApp, Hub } from './http';
import { ROOT, PORT } from './paths';
import { setZone } from './time';
import type { Ctx, ModuleManifest } from './types';

export interface BootOptions {
  dataDir: string;
  dev?: boolean;
  keychain?: Keychain;
  modulesDir?: string;
  /** Restrict to these module ids (tests). */
  only?: string[];
  quiet?: boolean;
  port?: number;
  zone?: string;
}

export async function boot(opts: BootOptions) {
  if (opts.zone) setZone(opts.zone);
  const log = createLogger(opts.quiet ? null : path.join(opts.dataDir, 'logs'), opts.quiet);
  const db = new DB(path.join(opts.dataDir, 'margin.db'));
  const bus = new Bus(db, log);
  const registry = new Registry(db);
  const settings = new SettingsStore(db, bus);
  const keychain = opts.keychain ?? (await createKeychain());
  const notify = new Notifier(db, log);
  const services = new Map<string, unknown>();
  // eslint-disable-next-line prefer-const
  let ctx: Ctx;
  const changes = new ChangeSets(db, bus, () => ctx);
  const rules = new RulesEngine(db, bus, () => ctx);
  ctx = {
    db, bus, settings, keychain, notify, changes, rules, registry, log,
    dataDir: opts.dataDir,
    dev: !!opts.dev,
    service<T>(id: string) {
      if (!services.has(id)) throw new Error(`Service "${id}" is not available`);
      return services.get(id) as T;
    },
    maybe<T>(id: string) {
      return registry.isEnabled(id) ? (services.get(id) as T | undefined) : undefined;
    },
  };

  let manifests: ModuleManifest[] = await discoverModules(opts.modulesDir ?? path.join(ROOT, 'modules'));
  if (opts.only) manifests = manifests.filter((m) => opts.only!.includes(m.id) || m.core);
  for (const m of manifests) registry.add(m);
  for (const m of manifests) {
    if (m.settings) settings.register(m.id, m.settings);
    if (m.migrations?.length) db.migrate(m.id, m.migrations);
  }
  for (const m of manifests) if (m.service) services.set(m.id, m.service(ctx));
  for (const m of manifests) {
    for (const c of m.rules?.conditions ?? []) rules.addCondition(m.id, c);
    for (const a of m.rules?.actions ?? []) rules.addAction(m.id, a);
  }
  for (const m of manifests) if (m.rules?.defaults) rules.seed(m.rules.defaults);
  for (const m of manifests) {
    for (const [name, h] of Object.entries(m.on ?? {})) {
      bus.on(name, async (p) => { if (registry.isEnabled(m.id)) await h(p, ctx); });
    }
  }
  for (const m of manifests) {
    if (!m.init) continue;
    try { await m.init(ctx); } catch (e) { log.error(`init ${m.id} failed`, e); }
  }

  const hub = new Hub();
  bus.on('*', (p) => { hub.broadcast('bus', { name: p.$event }); });
  notify.setShellTransport((n) => hub.broadcast('notify', n, 'shell') > 0);
  const app = createApp(ctx, hub, opts.port ?? PORT);
  const scheduler = new Scheduler(ctx);
  return { ctx, app, scheduler, hub };
}
