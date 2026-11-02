/** The commit this process is running. Read once at boot; the updater restarts the daemon after an update. */
import { execFileSync } from 'node:child_process';
import { ROOT } from './paths';

let cached: string | null | undefined;
export function runningVersion(): string | null {
  if (cached !== undefined) return cached;
  try {
    cached = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.MARGIN_APP_DIR || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { cached = null; }
  return cached;
}
