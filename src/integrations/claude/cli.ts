/**
 * Find a working `claude` binary and read the plan-login state, without trusting any single path.
 * On this Mac ~/.local/bin/claude can be a symlink to a 500-byte placeholder (npm postinstall never
 * ran), so every candidate is actually executed with --version before it is believed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from '../../core/paths';

export interface CliCandidate { path: string; source: string; ok: boolean; version?: string; reason?: string }
export interface CliInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  source: string | null;
  candidates: CliCandidate[];
  /** Plain-language note when the first-choice binary is broken but another one works (or none does). */
  hint: string | null;
}
export interface LoginStatus { loggedIn: boolean; method: string | null; plan: string | null; detail: string }

export function run(file: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(file, args, { timeout: opts.timeoutMs ?? 8000, env: opts.env ?? process.env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code && typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) + (err && !stderr ? String((err as any).code ?? err.message) : '') });
    });
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

/** Where a claude binary might live, best first. */
export function candidatePaths(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const add = (p: string | undefined, source: string) => { if (p && !out.some((o) => o.path === p)) out.push({ path: p, source }); };
  add(process.env.MARGIN_CLAUDE_BIN, 'MARGIN_CLAUDE_BIN');
  // The Agent SDK ships its own native binary as an optional dependency.
  add(path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'), 'Agent SDK');
  const home = os.homedir();
  add(path.join(home, '.local', 'bin', 'claude'), '~/.local/bin');
  add(path.join(home, '.claude', 'local', 'claude'), '~/.claude/local');
  add('/opt/homebrew/bin/claude', 'Homebrew');
  add('/usr/local/bin/claude', '/usr/local/bin');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) add(path.join(dir, 'claude'), 'PATH');
  return out;
}

async function probe(c: { path: string; source: string }): Promise<CliCandidate> {
  let real: string;
  try { real = fs.realpathSync(c.path); } catch { return { ...c, ok: fs.existsSync(c.path) ? false : false, reason: fs.lstatSync(c.path, { throwIfNoEntry: false }) ? 'broken symlink (target missing)' : 'not installed' }; }
  const st = fs.statSync(real);
  if (!st.isFile()) return { ...c, ok: false, reason: 'not a file' };
  if (st.size < 4096) return { ...c, ok: false, reason: `target is a ${st.size}-byte placeholder (Claude Code's install step never finished)` };
  const r = await run(c.path, ['--version'], { timeoutMs: 8000 });
  const version = r.stdout.trim().split('\n')[0];
  if (r.code !== 0 || !version) return { ...c, ok: false, reason: `failed to run: ${r.stderr.trim().split('\n')[0] || 'no output'}` };
  return { ...c, ok: true, version: version.replace(/ \(Claude Code\)$/, '') };
}

let cached: { at: number; info: CliInfo } | null = null;

export async function detectClaudeCli(opts: { force?: boolean; candidates?: { path: string; source: string }[] } = {}): Promise<CliInfo> {
  if (!opts.force && !opts.candidates && cached && Date.now() - cached.at < 60_000) return cached.info;
  const list = opts.candidates ?? candidatePaths();
  const probed: CliCandidate[] = [];
  let hit: CliCandidate | undefined;
  for (const c of list) {
    const p = await probe(c);
    probed.push(p);
    if (p.ok) { hit = p; break; }
  }
  // Keep the diagnosis for well-known locations that exist but are broken; ignore plain "not installed" PATH noise.
  const broken = probed.filter((p) => !p.ok && p.reason !== 'not installed');
  let hint: string | null = null;
  if (hit && broken.length) hint = `${broken.map((b) => `${b.path.replace(os.homedir(), '~')} is unusable (${b.reason})`).join('; ')}. Margin is using ${hit.source === 'Agent SDK' ? 'the copy bundled with the Agent SDK' : hit.path} instead.`;
  if (!hit) hint = `No working Claude Code binary was found${broken.length ? `: ${broken.map((b) => `${b.path.replace(os.homedir(), '~')} (${b.reason})`).join('; ')}` : ''}. Reinstall Claude Code (npm install -g @anthropic-ai/claude-code), or run npm install in the Margin folder so the Agent SDK's bundled binary is present.`;
  const info: CliInfo = { found: !!hit, path: hit?.path ?? null, version: hit?.version ?? null, source: hit?.source ?? null, candidates: probed, hint };
  if (!opts.candidates) cached = { at: Date.now(), info };
  return info;
}

/** Environment for plan-login runs: an API key or cloud-provider switch in the environment would silently win over the login. */
export function planEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'margin/0.1.0';
  return env;
}

/** `claude auth status` (JSON). Uses the plan environment so an exported API key can't mask the login. */
export async function planLoginStatus(cliPath: string): Promise<LoginStatus> {
  const r = await run(cliPath, ['auth', 'status'], { timeoutMs: 10_000, env: planEnv() });
  try {
    const j = JSON.parse(r.stdout);
    if (j.loggedIn) {
      const method = j.authMethod ?? null;
      return { loggedIn: true, method, plan: j.subscriptionType ?? null, detail: method === 'claude.ai' ? `Claude Code reports a plan login${j.subscriptionType ? ` (${j.subscriptionType})` : ''}. Use Test Connection to confirm it still works; an expired sign-in only shows up on a real call.` : `Claude Code reports a login (${method ?? 'unknown method'}), not a Claude plan login.` };
    }
    return { loggedIn: false, method: null, plan: null, detail: 'Not signed in. Run “claude auth login” in Terminal, then test again.' };
  } catch {
    return { loggedIn: false, method: null, plan: null, detail: `Couldn’t read the login state${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''}.` };
  }
}
