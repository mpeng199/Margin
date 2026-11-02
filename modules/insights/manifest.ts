/**
 * insights — what the last 4 to 12 weeks show: sleep and wake consistency, energy and the weekly ratings,
 * stop adherence, carry-overs, must-do completion, time per project, habit consistency. Read-only; every
 * section is built from another module's service and is left out when that module is off.
 */
import { z } from 'zod';
import { defineModule } from '../../src/core/types';
import { buildSummary, metricsForClaude, weeksParam, MAX_WEEKS } from './build';

export default defineModule({
  id: 'insights',
  name: 'Insights',
  description: 'Sleep, energy, stop adherence, carry-overs, must-dos, time per project, and habit consistency over 4 to 12 weeks.',
  routes(r, ctx) {
    r.get('/summary', (c) => {
      const raw = c.req.query('weeks');
      const weeks = weeksParam.safeParse(raw ?? 8);
      if (!weeks.success) return c.json({ error: `weeks must be a whole number from 1 to ${MAX_WEEKS}.` }, 400);
      return c.json(buildSummary(ctx, weeks.data));
    });
  },
  nav: [{ id: 'insights', label: 'Insights', icon: 'ChartLine', path: '/insights', section: 'main', order: 50, shortcut: 'Mod+7', work: false }],
  claude: {
    tools: [{
      name: 'get_metrics',
      description: 'Recent metrics over 1–26 weeks (default 8): stop adherence, carry-over stats, must-do completion, time per project, and habit consistency. Sleep and energy are included only when the person has turned on wellbeing sharing.',
      kind: 'read',
      input: z.object({ weeks: z.number().int().min(1).max(MAX_WEEKS).optional() }),
      run: (ctx, i) => metricsForClaude(buildSummary(ctx, i.weeks ?? 8), ctx.settings.get<any>('ai')?.shareWellbeing === true),
    }],
  },
});
