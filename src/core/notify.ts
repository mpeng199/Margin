/**
 * Native notifications. When the Margin.app shell is running it receives them over SSE and shows
 * them through Notification Center under the app's own name and icon. With no shell connected the
 * daemon falls back to osascript so notifications still fire with the window closed.
 */
import { execFile } from 'node:child_process';
import type { DB } from './db';
import type { Logger } from './log';
import { now } from './time';

export type NotificationCategory = 'work' | 'wellbeing' | 'system';
export interface NotificationInput {
  key?: string;
  title: string;
  body: string;
  category: NotificationCategory;
  path?: string;
}
type Transport = (n: NotificationInput) => boolean; // true when delivered

export class Notifier {
  private gate: (c: NotificationCategory) => { allowed: boolean; reason?: string } = () => ({ allowed: true });
  private shell: Transport | null = null;
  private mode = process.env.MARGIN_NOTIFY ?? 'auto'; // auto | log | off

  constructor(private db: DB, private log: Logger) {
    db.exec(`CREATE TABLE IF NOT EXISTS notification_log (
      key TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      category TEXT NOT NULL,
      delivery TEXT NOT NULL
    )`);
  }

  /** The day module installs the quiet-hours gate (no work notifications after shutdown / on the off-day). */
  setGate(fn: (c: NotificationCategory) => { allowed: boolean; reason?: string }) { this.gate = fn; }
  setShellTransport(t: Transport | null, connected?: () => boolean) { this.shell = t; this.shellConnected = connected ?? null; }
  /** True when Margin.app is connected and will show notifications under its own name. */
  hasShell() { return !!this.shellConnected?.(); }
  private shellConnected: (() => boolean) | null = null;

  wasSent(key: string) {
    return !!this.db.get('SELECT 1 FROM notification_log WHERE key = ?', key);
  }

  send(n: NotificationInput): string {
    const key = n.key ?? `adhoc:${now().toMillis()}:${Math.random().toString(36).slice(2, 7)}`;
    if (this.wasSent(key)) return 'duplicate';
    const g = this.gate(n.category);
    let delivery: string;
    if (!g.allowed) delivery = `suppressed:${g.reason ?? 'quiet'}`;
    else if (this.mode === 'off') delivery = 'off';
    else if (this.mode === 'log') delivery = 'log';
    else if (this.shell && this.shell(n)) delivery = 'shell';
    else { osascript(n, this.log); delivery = 'osascript'; }
    this.db.run(
      'INSERT OR IGNORE INTO notification_log (key, sent_at, title, body, category, delivery) VALUES (?, ?, ?, ?, ?, ?)',
      key, now().toISO(), n.title, n.body, n.category, delivery,
    );
    this.log.info(`notify [${delivery}] ${n.title}`);
    return delivery;
  }

  recent(limit = 50) {
    return this.db.all('SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT ?', limit);
  }
}

function osascript(n: NotificationInput, log: Logger) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${esc(n.body)}" with title "Margin" subtitle "${esc(n.title)}"`;
  execFile('osascript', ['-e', script], (err) => { if (err) log.warn('osascript notification failed', err.message); });
}
