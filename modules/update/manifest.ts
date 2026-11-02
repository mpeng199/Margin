/**
 * update — notices when a newer Margin has been pushed to GitHub and installs it on request.
 *
 * "Installed" is the commit the last successful install/update built (installed.json in the data dir),
 * not the working tree's HEAD, so a checkout that moved ahead without being rebuilt still offers the update.
 * Applying runs scripts/update.mjs detached (own process group, so it survives the daemon restart it
 * triggers): fast-forward pull → npm install if dependencies changed → build → reinstall → relaunch.
 * It never force-pulls and refuses to run over uncommitted edits to tracked files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { kvGet, kvSet } from '../../src/core/kv';
import { ROOT } from '../../src/core/paths';
import { now } from '../../src/core/time';
import { runningVersion } from '../../src/core/version';

const run = promisify(execFile);

const settings = z.object({
  autoCheck: z.boolean().default(true).describe('Check GitHub for a newer Margin in the background.'),
  checkEveryMin: z.number().int().min(15).max(1440).default(60).describe('How often to check, in minutes.'),
  branch: z.string().min(1).default('main').describe('The branch updates come from.'),
});
type Settings = z.infer<typeof settings>;

export interface UpdateStatus {
  installed: string | null;
  installedAt: string | null;
  latest: string | null;
  behind: number;
  available: boolean;
  changes: { sha: string; subject: string; date: string }[];
  checkedAt: string | null;
  canApply: boolean;
  blockedReason: string | null;
  phase: 'idle' | 'starting' | 'pulling' | 'installing' | 'building' | 'restarting' | 'done' | 'failed';
  error: string | null;
  remote: string | null;
  dismissed: boolean;
}

export const appDir = () => process.env.MARGIN_APP_DIR || ROOT;

export function createUpdateService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('update');
  const stateFile = () => path.join(ctx.dataDir, 'update-state.json');
  const installedFile = () => path.join(ctx.dataDir, 'installed.json');
  const git = async (...args: string[]) => (await run('git', args, { cwd: appDir(), timeout: 60_000, maxBuffer: 4 << 20 })).stdout.trim();
  const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  let checking: Promise<UpdateStatus> | null = null;

  const svc = {
    settings: s,
    installed(): { sha: string | null; at: string | null } {
      const j = readJson(installedFile());
      return { sha: j?.sha ?? runningVersion(), at: j?.at ?? null };
    },
    runState(): { phase: UpdateStatus['phase']; error?: string; to?: string; from?: string; at?: string; reported?: boolean } {
      return readJson(stateFile()) ?? { phase: 'idle' };
    },

    status(): UpdateStatus {
      const cached = kvGet<Partial<UpdateStatus>>(ctx.db, 'update.status', {});
      const inst = svc.installed();
      const st = svc.runState();
      const busy = !['idle', 'done', 'failed'].includes(st.phase);
      const latest = cached.latest ?? null;
      const available = !!latest && latest !== inst.sha && (cached.behind ?? 0) > 0;
      return {
        installed: inst.sha, installedAt: inst.at, latest, behind: available ? cached.behind ?? 0 : 0, available,
        changes: available ? cached.changes ?? [] : [], checkedAt: cached.checkedAt ?? null,
        canApply: available && !busy && !cached.blockedReason, blockedReason: cached.blockedReason ?? null,
        phase: st.phase, error: st.phase === 'failed' ? st.error ?? 'The update failed.' : cached.error ?? null,
        remote: cached.remote ?? null, dismissed: !!latest && kvGet(ctx.db, 'update.dismissedSha', null) === latest,
      };
    },

    /** Fetch the branch and compare it with the installed commit. Notifies once per new commit. */
    async check(): Promise<UpdateStatus> {
      if (checking) return checking;
      checking = (async () => {
        const branch = s().branch;
        try {
          const remote = await git('remote', 'get-url', 'origin').catch(() => null);
          if (!remote) throw new Error('This copy of Margin has no GitHub remote, so there is nothing to check.');
          await git('fetch', '--quiet', 'origin', branch);
          const latest = await git('rev-parse', `origin/${branch}`);
          const inst = svc.installed().sha ?? (await git('rev-parse', 'HEAD'));
          const behind = Number(await git('rev-list', '--count', latest, `^${inst}`));
          const log = behind ? await git('log', '--format=%h%x09%cI%x09%s', '-n', '30', latest, `^${inst}`) : '';
          const changes = log ? log.split('\n').map((l) => { const [sha, date, ...rest] = l.split('\t'); return { sha, date, subject: rest.join('\t') }; }) : [];
          const dirty = (await git('status', '--porcelain', '--untracked-files=no')).length > 0;
          const ff = await git('merge-base', '--is-ancestor', 'HEAD', latest).then(() => true, () => false);
          const blockedReason = !behind ? null
            : dirty ? 'The Margin folder has uncommitted changes. Commit or discard them, then update.'
            : !ff ? 'The Margin folder has local commits that aren’t on GitHub. Push them first, then update.'
            : null;
          kvSet(ctx.db, 'update.status', { latest, behind, changes, checkedAt: now().toISO(), blockedReason, error: null, remote });
          if (behind && kvGet(ctx.db, 'update.notifiedSha', null) !== latest) {
            kvSet(ctx.db, 'update.notifiedSha', latest);
            ctx.notify.send({
              key: `update.available:${latest}`,
              title: 'Margin update available',
              body: behind === 1 ? changes[0]?.subject ?? '1 change' : `${behind} changes, including “${changes[0]?.subject ?? ''}”`,
              category: 'system',
              path: '/settings/update',
            });
            ctx.bus.emit('update.available', { latest, behind });
          }
        } catch (e: any) {
          const prev = kvGet<Record<string, unknown>>(ctx.db, 'update.status', {});
          kvSet(ctx.db, 'update.status', { ...prev, checkedAt: now().toISO(), error: String(e.stderr || e.message).trim().split('\n')[0] });
          ctx.log.warn('update check failed', e.message);
        } finally {
          kvSet(ctx.db, 'update.lastCheck', now().toISO());
        }
        return svc.status();
      })();
      try { return await checking; } finally { checking = null; }
    },

    /** Start the detached updater. The daemon (and the app window) restart when it's done. */
    apply(): UpdateStatus {
      const st = svc.status();
      if (!st.available) throw Object.assign(new Error('Margin is already up to date.'), { status: 409 });
      if (st.blockedReason) throw Object.assign(new Error(st.blockedReason), { status: 409 });
      if (!st.canApply) throw Object.assign(new Error('An update is already running.'), { status: 409 });
      fs.writeFileSync(stateFile(), JSON.stringify({ phase: 'starting', from: st.installed, to: st.latest, at: now().toISO() }));
      const logDir = path.join(process.env.HOME ?? '', 'Library', 'Logs', 'Margin');
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, 'update.log'), 'a');
      const child = spawn(process.execPath, [path.join(appDir(), 'scripts', 'update.mjs'), '--to', st.latest!, '--branch', s().branch, '--state', stateFile()], {
        cwd: appDir(), detached: true, stdio: ['ignore', out, out], env: { ...process.env },
      });
      child.unref();
      ctx.bus.emit('update.started', { to: st.latest });
      return svc.status();
    },

    dismiss() {
      const st = svc.status();
      if (st.latest) kvSet(ctx.db, 'update.dismissedSha', st.latest);
      ctx.bus.emit('update.dismissed', {});
    },
  };
  return svc;
}
export type UpdateService = ReturnType<typeof createUpdateService>;

export default defineModule({
  id: 'update',
  name: 'Updates',
  description: 'Checks GitHub for a newer Margin and installs it when you say so.',
  core: true,
  settings,
  service: createUpdateService,
  emits: ['update.available', 'update.started', 'update.dismissed', 'update.installed'],
  widgets: [{ id: 'banner', slot: 'today.banner', order: -20 }],
  init(ctx) {
    // Report the outcome of an update that restarted this daemon.
    const u = ctx.service<UpdateService>('update');
    const st = u.runState();
    if ((st.phase === 'done' || st.phase === 'failed') && !st.reported) {
      const file = path.join(ctx.dataDir, 'update-state.json');
      fs.writeFileSync(file, JSON.stringify({ ...st, reported: true }));
      if (st.phase === 'done') {
        kvSet(ctx.db, 'update.status', { ...kvGet(ctx.db, 'update.status', {}), behind: 0, changes: [], latest: st.to ?? null });
        ctx.notify.send({ key: `update.installed:${st.to}`, title: 'Margin updated', body: 'You’re on the latest version.', category: 'system', path: '/settings/update' });
        ctx.bus.emit('update.installed', { to: st.to });
      } else {
        ctx.notify.send({ key: `update.failed:${st.at}`, title: 'Margin couldn’t update', body: st.error ?? 'See Settings → Updates.', category: 'system', path: '/settings/update' });
      }
    }
  },
  jobs: [
    {
      id: 'check',
      every: 15,
      async run(ctx) {
        const u = ctx.service<UpdateService>('update');
        if (!u.settings().autoCheck || ctx.dev) return;
        const last = kvGet<string | null>(ctx.db, 'update.lastCheck', null);
        if (last && now().toMillis() - Date.parse(last) < u.settings().checkEveryMin * 60_000) return;
        await u.check();
      },
    },
  ],
  routes(r, ctx) {
    const u = () => ctx.service<UpdateService>('update');
    r.get('/status', (c) => c.json(u().status()));
    r.post('/check', async (c) => c.json(await u().check()));
    r.post('/apply', (c) => c.json(u().apply()));
    r.post('/dismiss', (c) => { u().dismiss(); return c.json(u().status()); });
  },
});
