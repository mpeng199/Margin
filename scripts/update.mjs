// Margin updater. Started detached by the daemon (modules/update), so it survives the daemon restart
// it triggers. Steps: fast-forward to the target commit → npm install if dependencies changed →
// build the web app → reinstall (restarts the daemon, repackages + relaunches Margin.app if the shell
// changed). Progress goes to --state (read by the daemon); output to ~/Library/Logs/Margin/update.log.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const to = arg('to');
const branch = arg('branch') ?? 'main';
const stateFile = arg('state');
const root = path.resolve(import.meta.dirname, '..');
const binDir = path.dirname(process.execPath);
const env = { ...process.env, PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin` };

const prev = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
const state = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...prev, ...patch, at: new Date().toISOString() }));
const sh = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
};

console.log(`\n=== Margin update ${new Date().toISOString()} → ${to}`);
try {
  if (!to || !stateFile) throw new Error('update.mjs needs --to and --state');
  const from = sh('git', ['rev-parse', 'HEAD']);
  if (sh('git', ['status', '--porcelain', '--untracked-files=no'])) throw new Error('The Margin folder has uncommitted changes.');

  state({ phase: 'pulling' });
  sh('git', ['fetch', '--quiet', 'origin', branch]);
  if (from !== to) sh('git', ['merge', '--ff-only', to]);
  const changed = from === to ? [] : sh('git', ['diff', '--name-only', from, to]).split('\n');

  if (changed.some((f) => f === 'package.json' || f === 'package-lock.json') || !fs.existsSync(path.join(root, 'node_modules'))) {
    state({ phase: 'installing' });
    sh(path.join(binDir, 'npm'), ['install', '--no-fund', '--no-audit']);
  }
  if (changed.some((f) => f === '.gitmodules')) sh('git', ['submodule', 'update', '--init', '--recursive']);

  state({ phase: 'building' });
  sh(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'error']);

  // Mark done before reinstalling: the reinstall restarts the daemon, which reports this state on boot.
  state({ phase: 'done', from, to, reported: false });
  sh(process.execPath, [path.join(root, 'scripts', 'install.mjs'), '--relaunch']);
  console.log('=== update finished');
} catch (e) {
  console.error(e);
  state({ phase: 'failed', error: String(e.message ?? e).split('\n')[0], reported: false });
  // Bring the daemon back on whatever is checked out so the app keeps working.
  try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/dev.minimike.margin`]); } catch { /* not installed */ }
  process.exit(1);
}
