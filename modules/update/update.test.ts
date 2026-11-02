import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { testApp } from '../../tests/helpers';
import type { UpdateService } from './manifest';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

/** A bare "GitHub" remote, the installed checkout, and a second clone that pushes a new version. */
function repos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-upd-'));
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = path.join(base, 'seed');
  execFileSync('git', ['clone', '-q', remote, seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'v1\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'First version'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const app = path.join(base, 'app');
  execFileSync('git', ['clone', '-q', remote, app]);
  const push = (msg: string) => { fs.appendFileSync(path.join(seed, 'README.md'), `${msg}\n`); git(seed, 'commit', '-qam', msg); git(seed, 'push', '-q', 'origin', 'HEAD:main'); };
  return { app, push };
}

afterEach(() => { delete process.env.MARGIN_APP_DIR; });

describe('update', () => {
  it('detects pushed commits against the installed version, notifies once, and clears when caught up', async () => {
    const r = repos();
    process.env.MARGIN_APP_DIR = r.app;
    const a = await testApp({ at: '2026-11-02T10:00:00-05:00', only: ['update'] });
    fs.writeFileSync(path.join(a.dataDir, 'installed.json'), JSON.stringify({ sha: git(r.app, 'rev-parse', 'HEAD'), at: '2026-11-01T12:00:00Z' }));
    const u = a.ctx.service<UpdateService>('update');

    expect((await u.check()).available).toBe(false);
    r.push('Calmer evening copy');
    r.push('Fix carry-over count');
    const st = await u.check();
    expect(st).toMatchObject({ available: true, behind: 2, canApply: true, blockedReason: null });
    expect(st.changes.map((c) => c.subject)).toEqual(['Fix carry-over count', 'Calmer evening copy']);
    await u.check();
    expect(a.ctx.notify.recent().filter((n: any) => n.title === 'Margin update available')).toHaveLength(1);

    // "Later" hides the banner for this version only.
    u.dismiss();
    expect(u.status().dismissed).toBe(true);
    r.push('Third change');
    expect((await u.check()).dismissed).toBe(false);

    // Caught up (the updater pulls and records the new installed commit).
    git(r.app, 'pull', '-q', '--ff-only');
    fs.writeFileSync(path.join(a.dataDir, 'installed.json'), JSON.stringify({ sha: git(r.app, 'rev-parse', 'HEAD'), at: '2026-11-02T10:05:00Z' }));
    expect((await u.check()).available).toBe(false);
  });

  it('refuses to update over uncommitted edits, and over a checkout that is behind but not rebuilt it still offers', async () => {
    const r = repos();
    process.env.MARGIN_APP_DIR = r.app;
    const a = await testApp({ at: '2026-11-02T10:00:00-05:00', only: ['update'] });
    const first = git(r.app, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(a.dataDir, 'installed.json'), JSON.stringify({ sha: first, at: 'x' }));
    r.push('New version');
    fs.appendFileSync(path.join(r.app, 'README.md'), 'local edit\n');
    const u = a.ctx.service<UpdateService>('update');
    const st = await u.check();
    expect(st.canApply).toBe(false);
    expect(st.blockedReason).toMatch(/uncommitted changes/);
    expect(() => u.apply()).toThrow(/uncommitted changes/);

    // Pulled by hand but never rebuilt: still an update, because installed.json is what was built.
    git(r.app, 'checkout', '-q', '--', 'README.md');
    git(r.app, 'pull', '-q', '--ff-only');
    expect(await u.check()).toMatchObject({ available: true, behind: 1, canApply: true });
  });

  it('says plainly when there is no GitHub remote', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-noremote-'));
    execFileSync('git', ['init', '-q', dir]);
    process.env.MARGIN_APP_DIR = dir;
    const a = await testApp({ only: ['update'] });
    const st = await a.ctx.service<UpdateService>('update').check();
    expect(st.available).toBe(false);
    expect(st.error).toMatch(/no GitHub remote/);
  });
});
