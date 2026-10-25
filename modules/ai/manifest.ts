/**
 * ai — Claude inside Margin, and the door for Claude Code / Claude desktop (MCP).
 * Off until a provider is chosen; every other module works exactly the same without it.
 * Nothing Claude does writes: it proposes, you review (see src/core/changesets.ts).
 */
import { z } from 'zod';
import { defineModule } from '../../src/core/types';
import { addDays } from '../../src/core/time';
import { KNOWN_MODELS } from '../../src/integrations/claude';
import { createAiService, FEATURES, KEY_ACCOUNT, type AiService } from './service';
import { registerReadRoutes } from './read';

const settings = z.object({
  provider: z.enum(['off', 'plan', 'api']).default('off').describe('Off, your Claude plan login (through Claude Code), or a Claude API key from the Console.'),
  planningModel: z.string().min(1).default('claude-sonnet-5-5').describe('Used for planning your day, the weekly review and Ask.'),
  fastModel: z.string().min(1).default('claude-haiku-5-5').describe('Used for parsing capture text, shutdown next actions, and short drafts.'),
  monthlyBudgetUsd: z.number().min(1).max(500).default(5).describe('API key only: Margin refuses Claude calls once this month’s estimated spend would pass this amount.'),
  shareWellbeing: z.boolean().default(false).describe('Share sleep, energy, mood and dread data with Claude. Off keeps all of it out of everything Claude sees.'),
});

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const keyOk = (k: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);

export default defineModule({
  id: 'ai',
  name: 'Claude',
  description: 'Optional. Plan your day, turn a brain dump into next actions, write the weekly summary, and ask about your own data. Everything it suggests waits for your review.',
  defaultEnabled: true,
  settings,
  migrations: [
    `CREATE TABLE ai_usage (
       id TEXT PRIMARY KEY, at TEXT NOT NULL, month TEXT NOT NULL, feature TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
       input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
       cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
       cost_usd REAL NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1);
     CREATE INDEX ai_usage_month ON ai_usage(month);`,
  ],
  service: createAiService,
  emits: ['ai.key_changed'],
  nav: [{ id: 'ask', label: 'Ask', icon: 'Sparkles', path: '/ask', section: 'main', order: 60, work: true }],
  routes(r, ctx) {
    const ai = () => ctx.service<AiService>('ai');

    r.post('/run', async (c) => {
      const body = z.object({ feature: z.enum(FEATURES), input: z.any().optional() }).parse(await c.req.json());
      return c.json(await ai().run(body.feature, body.input));
    });
    r.get('/status', async (c) => c.json(await ai().status({ plan: c.req.query('plan') === '1' })));
    r.get('/usage', (c) => c.json(ai().usage()));
    r.get('/tools', (c) => c.json(ai().tools()));
    r.get('/models', (c) => c.json(KNOWN_MODELS));
    r.post('/test', async (c) => c.json(await ai().test()));

    // Write-only: the key goes to the Keychain and is never returned, logged, or stored anywhere else.
    r.post('/key', async (c) => {
      const { key } = z.object({ key: z.string().nullable() }).parse(await c.req.json());
      const k = key?.trim() ?? '';
      if (!k) ctx.keychain.delete(KEY_ACCOUNT);
      else {
        if (!keyOk(k)) return c.json({ error: 'That doesn’t look like a Claude API key. Keys from the Console start with sk-ant-.' }, 400);
        ctx.keychain.set(KEY_ACCOUNT, k);
      }
      ctx.bus.emit('ai.key_changed', { has: !!k });
      return c.json({ hasKey: ctx.keychain.has(KEY_ACCOUNT) });
    });

    // For the MCP server: proposals from Claude Code / Claude desktop become a pending change set (source "mcp").
    r.post('/propose', async (c) => {
      const body = z.object({
        title: z.string().min(1).max(200), summary: z.string().max(4000).optional(),
        changes: z.array(z.object({ kind: z.string().min(1), title: z.string().min(1).max(300), payload: z.record(z.string(), z.any()), before: z.record(z.string(), z.any()).nullish() })).min(1).max(100),
      }).parse(await c.req.json());
      return c.json({ ...ai().proposeFromMcp(body), message: 'Review it in Margin → Review changes. Nothing has been applied.' });
    });

    registerReadRoutes(r, ctx);
  },
  claude: {
    tools: [
      {
        // Fallback for plan_day when the plan module has no must-do tool: same two appliers the Plan screen uses (meta + Todoist label mirror).
        name: 'propose_must_dos',
        description: 'Propose must-do tasks for a date (at most 3 required per day beyond homework; mark extras optional). Queued for review; nothing is set until the person applies it.',
        kind: 'propose',
        input: z.object({ date: iso, mustDos: z.array(z.object({ taskId: z.string().min(1), optional: z.boolean().optional() })).min(1).max(8) }),
        run: (ctx, i) => {
          const td = ctx.service<any>('todoist');
          const label: string = td.settings().mustDoLabel;
          return i.mustDos.flatMap((m: { taskId: string; optional?: boolean }) => {
            const t = td.task(m.taskId);
            if (!t) throw new Error(`No task with id "${m.taskId}". Use ids from list_tasks.`);
            const name = `“${t.content}”`;
            return [
              { kind: 'task.meta', title: `${m.optional ? 'Optional' : 'Must-do'} for ${i.date}: ${name}`, payload: { taskId: m.taskId, patch: { mustDoDate: i.date, optional: !!m.optional } }, before: { mustDoDate: t.meta.mustDoDate, optional: t.meta.optional } },
              ...(m.optional || t.labels.includes(label) ? [] : [{ kind: 'todoist.task.label', title: `Label ${name} “${label}” in Todoist`, payload: { taskId: m.taskId, label } }]),
            ];
          });
        },
      },
    ],
  },
});
void addDays;
