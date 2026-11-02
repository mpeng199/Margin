// Installs the background daemon as a launchd agent (starts at login, restarts if it dies),
// packages Margin.app when the shell changed, then opens it. Safe to run repeatedly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appDestination, dataDir } from './app-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
const label = 'dev.minimike.margin';
const uid = process.getuid();
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Margin');
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

const node = process.execPath;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(node)}</string><string>--no-warnings</string><string>--import</string><string>tsx</string><string>src/daemon.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc(path.dirname(node))}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(logDir)}/daemon.log</string>
  <key>StandardErrorPath</key><string>${esc(logDir)}/daemon.log</string>
</dict></plist>
`;
const changed = !fs.existsSync(plistPath) || fs.readFileSync(plistPath, 'utf8') !== plist;
fs.writeFileSync(plistPath, plist);
const isLoaded = () => spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' }).status === 0;
if (changed && isLoaded()) {
  // bootout returns before the job is gone; wait for it, or the bootstrap below races a dying job.
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
  for (let i = 0; i < 40 && isLoaded(); i++) spawnSync('sleep', ['0.25']);
}
const loaded = isLoaded();
if (!loaded) execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
else spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });

// Wait for the daemon.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await fetch('http://127.0.0.1:7317/api/health')).ok; } catch { /* starting */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.error(`The daemon didn't start. See ${logDir}/daemon.log`); process.exit(1); }
console.log('Background service running (launchd agent dev.minimike.margin).');

// Package the shell only when its sources changed.
const hash = crypto.createHash('sha1');
for (const f of fs.readdirSync(path.join(root, 'shell'), { recursive: true })) {
  const p = path.join(root, 'shell', String(f));
  if (fs.statSync(p).isFile()) hash.update(String(f)).update(fs.readFileSync(p));
}
const stamp = path.join(root, 'out', '.shell-hash');
const app = appDestination();
const digest = hash.digest('hex');
const relaunch = process.argv.includes('--relaunch');
let repackaged = false;
if (!fs.existsSync(app) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== digest) {
  console.log('Packaging Margin.app…');
  // A running copy has to quit before its bundle is replaced.
  const wasRunning = spawnSync('pgrep', ['-f', 'Margin.app/Contents/MacOS/Margin'], { stdio: 'ignore' }).status === 0;
  if (wasRunning) { spawnSync('osascript', ['-e', 'quit app "Margin"'], { stdio: 'ignore' }); spawnSync('sleep', ['2']); }
  execFileSync(process.execPath, [path.join(root, 'scripts/package-shell.mjs')], { stdio: 'inherit', cwd: root });
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, digest);
  repackaged = true;
}

// Record what is installed so the updater knows what “newer” means.
try {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), 'installed.json'), JSON.stringify({ sha, at: new Date().toISOString(), app }));
} catch { /* not a git checkout */ }

// --relaunch (updater): only reopen the app if its bundle changed; otherwise the open window reloads itself.
if (relaunch ? repackaged : !process.argv.includes('--no-open')) spawnSync('open', [app]);
console.log(`Margin is installed at ${app} and starts at login.`);
