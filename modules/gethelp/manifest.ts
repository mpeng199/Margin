/**
 * gethelp — always one click away (SPEC 4.14). Core: it can't be turned off.
 * 988 call or text, an optional trusted adult, and the red-flag list. A rule (or an answer to the red-flag check)
 * opens a request for today; the card on Today can be dismissed for the day only.
 * Margin never calls this "just burnout" (burnout and depression overlap, r ≈ .80; Bianchi 2021) and is not a medical tool.
 */
import { z } from 'zod';
import { defineModule, type Ctx } from '../../src/core/types';
import { uid } from '../../src/core/db';
import { now, today, type ISODate } from '../../src/core/time';
import { RED_FLAG_IDS } from './flags';

const settings = z.object({
  trustedAdultName: z.string().default('').describe('Someone you trust and could call or text. Stored only on this Mac.'),
  trustedAdultPhone: z.string().default('').describe('Their phone number.'),
});
type Settings = z.infer<typeof settings>;

export interface HelpRequest { id: string; reason: string; openedAt: string; dismissed: boolean }
export interface HelpState {
  date: ISODate;
  /** An undismissed request exists for today: the red card shows on Today. */
  open: boolean;
  reason: string | null;
  dismissedToday: boolean;
  requests: HelpRequest[];
  contact: { name: string; phone: string } | null;
}

export function createGetHelpService(ctx: Ctx) {
  const s = () => ctx.settings.get<Settings>('gethelp');

  const svc = {
    /** Trusted adult, or null when no phone number is set. */
    contact(): { name: string; phone: string } | null {
      const { trustedAdultName: name, trustedAdultPhone: phone } = s();
      return phone.trim() ? { name: name.trim() || 'Trusted adult', phone: phone.trim() } : null;
    },

    /** Record an open-request for today. The same reason is recorded once a day, so a rule that re-checks can't re-open a card you dismissed. */
    open(reason: string) {
      const date = today();
      const why = (reason ?? '').trim().slice(0, 200) || 'requested';
      const existing = ctx.db.get<{ id: string }>('SELECT id FROM gethelp_requests WHERE date = ? AND reason = ?', date, why);
      if (existing) return { id: existing.id, date, reason: why, created: false };
      const id = uid();
      ctx.db.run('INSERT INTO gethelp_requests (id, date, reason, opened_at, dismissed_on) VALUES (?, ?, ?, ?, NULL)', id, date, why, now().toISO());
      ctx.bus.emit('gethelp.opened', { reason: why });
      return { id, date, reason: why, created: true };
    },

    state(): HelpState {
      const date = today();
      const rows = ctx.db.all<{ id: string; reason: string; opened_at: string; dismissed_on: string | null }>(
        'SELECT * FROM gethelp_requests WHERE date = ? ORDER BY opened_at', date);
      const requests = rows.map((r) => ({ id: r.id, reason: r.reason, openedAt: r.opened_at, dismissed: r.dismissed_on === date }));
      const live = requests.filter((r) => !r.dismissed);
      return {
        date,
        open: live.length > 0,
        reason: live[0]?.reason ?? null,
        dismissedToday: requests.length > 0 && live.length === 0,
        requests,
        contact: svc.contact(),
      };
    },

    /** Hide the card for the rest of today. Tomorrow it can open again if something still calls for it. */
    dismiss(): HelpState {
      const date = today();
      ctx.db.run('UPDATE gethelp_requests SET dismissed_on = ? WHERE date = ? AND dismissed_on IS NULL', date, date);
      ctx.bus.emit('gethelp.dismissed', { date });
      return svc.state();
    },

    /** Answers to the red-flag list (id → yes). Any yes opens Get help. */
    checkRedFlags(answers: Record<string, boolean>) {
      const yes = Object.entries(answers).filter(([id, v]) => v === true && RED_FLAG_IDS.has(id)).map(([id]) => id);
      if (yes.length) svc.open('red-flags');
      return { opened: yes.length > 0, yes };
    },
  };
  return svc;
}
export type GetHelpService = ReturnType<typeof createGetHelpService>;

export default defineModule({
  id: 'gethelp',
  name: 'Get help',
  description: '988 call or text, a trusted adult, and a gentle check for red flags. Always one click away.',
  core: true,
  settings,
  migrations: [
    `CREATE TABLE gethelp_requests (
       id TEXT PRIMARY KEY,
       date TEXT NOT NULL,
       reason TEXT NOT NULL,
       opened_at TEXT NOT NULL,
       dismissed_on TEXT
     );
     CREATE INDEX gethelp_requests_date ON gethelp_requests(date);`,
  ],
  service: createGetHelpService,
  emits: ['gethelp.opened', 'gethelp.dismissed'],
  nav: [{ id: 'help', label: 'Get help', icon: 'LifeBuoy', path: '/help', section: 'secondary', order: 90, work: false }],
  widgets: [{ id: 'card', slot: 'today.banner', order: -10 }],
  routes(r, ctx) {
    const svc = () => ctx.service<GetHelpService>('gethelp');
    r.get('/state', (c) => c.json(svc().state()));
    r.post('/dismiss', (c) => c.json(svc().dismiss()));
    r.post('/red-flags', async (c) => {
      const { answers } = z.object({ answers: z.record(z.string(), z.boolean()) }).parse(await c.req.json());
      return c.json(svc().checkRedFlags(answers));
    });
  },
});
