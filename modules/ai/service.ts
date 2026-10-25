/**
 * ai service: provider choice, tools, privacy, budget, usage, change sets.
 * Providers (src/integrations/claude) only drive the model loop; every rule that protects the person lives here:
 *  - nothing writes: propose tools queue changes, all of one run become ONE change set
 *  - wellbeing keys are stripped from tool results and context unless sharing is on
 *  - crisis language opens Get help before any model call, even with the provider off
 *  - the API-key provider is refused once this month's estimated spend would pass the budget
 */
import path from 'node:path';
import { z } from 'zod';
import type { ClaudeTool, Ctx } from '../../src/core/types';
import type { ProposedChange } from '../../src/core/changesets';
import { uid } from '../../src/core/db';
import { now, today, fromISO } from '../../src/core/time';
import {
  AiError, CARE_TEXT, WELLBEING_KEY, createApiProvider, createPlanProvider, detectClaudeCli, detectCrisis, estimateCostUsd, estimateTokens,
  planLoginStatus, stripWellbeing, zeroUsage, type Provider, type ProviderRequest, type ProviderResult, type ProviderTool,
} from '../../src/integrations/claude';
import { CARE_NOTE, SYSTEM, TASKS } from './prompts';

export const KEY_ACCOUNT = 'claude.apiKey';
export const FEATURES = ['plan_day', 'shutdown_actions', 'weekly_summary', 'draft_message', 'parse_capture', 'ask'] as const;
export type Feature = (typeof FEATURES)[number];

export interface AiSettings {
  provider: 'off' | 'plan' | 'api';
  planningModel: string;
  fastModel: string;
  monthlyBudgetUsd: number;
  shareWellbeing: boolean;
}

export interface ToolCallLog { name: string; kind: 'read' | 'propose'; ok: boolean; note?: string }
export interface RunOutput {
  text: string;
  changeSetId?: string;
  data?: any;
  toolCalls: ToolCallLog[];
  /** True when the care message (988, trusted adult) was shown and Get help was opened. */
  careShown?: boolean;
  /** Set when a run was cut short: 'budget' | 'max_tokens' | 'max_rounds' | 'refusal'. */
  stopped?: string;
  provider?: string;
  model?: string;
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) });
const INPUT: Record<Feature, z.ZodTypeAny> = {
  plan_day: z.object({ date: iso }),
  shutdown_actions: z.object({ items: z.array(z.string().min(1).max(500)).min(1).max(40) }),
  weekly_summary: z.object({ weekStart: iso }),
  draft_message: z.object({ kind: z.enum(['delegate', 'no']), context: z.string().min(1).max(4000) }),
  parse_capture: z.object({ text: z.string().min(1).max(500) }),
  ask: z.object({ messages: z.array(turn).min(1).max(30) }).refine((i) => i.messages[i.messages.length - 1].role === 'user', 'The last message must be from you.'),
};

const SHUTDOWN_OUT = z.object({
  items: z.array(z.object({
    text: z.string(), nextAction: z.string(),
    when: z.union([z.enum(['tomorrow', 'this_week', 'someday']), iso]),
    slot: z.string().optional().nullable(),
  })),
});
const CAPTURE_OUT = z.object({
  content: z.string().min(1), dueString: z.string().optional().nullable(), project: z.string().optional().nullable(),
  labels: z.array(z.string()).optional().nullable(), priority: z.number().int().min(1).max(4).optional().nullable(),
});

const PROPOSED = z.object({ kind: z.string().min(1), title: z.string().min(1), payload: z.record(z.string(), z.any()), before: z.record(z.string(), z.any()).nullish() });

interface FeatureConf { model: 'planning' | 'fast'; tools: 'all' | 'read-subset' | 'none'; effort: 'low' | 'medium'; maxTokens: number; rounds: number }
const CONF: Record<Feature, FeatureConf> = {
  plan_day: { model: 'planning', tools: 'all', effort: 'medium', maxTokens: 16000, rounds: 10 },
  weekly_summary: { model: 'planning', tools: 'all', effort: 'medium', maxTokens: 16000, rounds: 10 },
  ask: { model: 'planning', tools: 'all', effort: 'medium', maxTokens: 16000, rounds: 10 },
  shutdown_actions: { model: 'fast', tools: 'read-subset', effort: 'low', maxTokens: 8000, rounds: 4 },
  draft_message: { model: 'fast', tools: 'none', effort: 'low', maxTokens: 4000, rounds: 1 },
  parse_capture: { model: 'fast', tools: 'none', effort: 'low', maxTokens: 4000, rounds: 1 },
};
const READ_SUBSET = new Set(['get_capacity', 'get_anchors', 'list_tasks', 'list_events']);
const MAX_RESULT_CHARS = 30_000;
const MUST_DO_CAP_DEFAULT = 3;

export function createAiService(ctx: Ctx) {
  const s = () => ctx.settings.get<AiSettings>('ai');
  let override: Provider | null = null;
  let apiProvider: Provider | null = null;
  let planProvider: Provider | null = null;

  const month = () => now().toFormat('yyyy-MM');
  const spent = (provider?: string) => ctx.db.get<{ n: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) n FROM ai_usage WHERE month = ?${provider ? ' AND provider = ?' : ''}`, ...(provider ? [month(), provider] : [month()]))!.n;

  function provider(): Provider | null {
    if (override) return override;
    const p = s().provider;
    if (p === 'api') {
      if (!ctx.keychain.has(KEY_ACCOUNT)) return null;
      return (apiProvider ??= createApiProvider({ getKey: () => ctx.keychain.get(KEY_ACCOUNT) }));
    }
    if (p === 'plan') return (planProvider ??= createPlanProvider({ cwd: path.join(ctx.dataDir, 'claude-run') }));
    return null;
  }

  // ---------------------------------------------------------------- tools
  function gatherTools(): { module: string; tool: ClaudeTool }[] {
    const share = s().shareWellbeing;
    const out: { module: string; tool: ClaudeTool }[] = [];
    const seen = new Set<string>();
    const mods = [...ctx.registry.enabled()].sort((a, b) => Number(a.id === 'ai') - Number(b.id === 'ai')); // our fallbacks yield to a module's own tool of the same name
    for (const m of mods) {
      for (const t of m.claude?.tools ?? []) {
        if (!share && WELLBEING_KEY.test(t.name)) continue;
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push({ module: m.id, tool: t });
      }
    }
    return out;
  }

  function checkProposals(items: ProposedChange[], already: ProposedChange[]): { ok: ProposedChange[]; problems: string[] } {
    const kinds = new Set(ctx.changes.kinds().map((k) => k.kind));
    const day = ctx.maybe<any>('day');
    const td = ctx.maybe<any>('todoist');
    const cap = Number(ctx.settings.get<any>('plan')?.mustDoCap ?? MUST_DO_CAP_DEFAULT);
    const ok: ProposedChange[] = [];
    const problems: string[] = [];
    const key = (c: ProposedChange) => `${c.kind}:${JSON.stringify(c.payload)}`;
    const have = new Set(already.map(key));
    const mustDoCount = new Map<string, Set<string>>();
    const countFor = (date: string) => {
      if (!mustDoCount.has(date)) {
        const ids = new Set<string>((td?.tasks({ mustDoOn: date }) ?? []).filter((t: any) => !t.meta.optional).map((t: any) => t.id));
        for (const c of [...already, ...ok]) if (c.kind === 'task.meta' && c.payload.patch?.mustDoDate === date && !c.payload.patch.optional) ids.add(c.payload.taskId);
        mustDoCount.set(date, ids);
      }
      return mustDoCount.get(date)!;
    };
    for (const c of items) {
      if (!kinds.has(c.kind)) { problems.push(`Unknown change kind "${c.kind}". Known kinds: ${[...kinds].join(', ')}.`); continue; }
      if (have.has(key(c))) continue; // identical proposal already queued
      const p = c.payload;
      if (day && /^gcal\.event\.(create|update)$/.test(c.kind) && typeof p.start === 'string' && typeof p.end === 'string') {
        const date = fromISO(p.start).toISODate()!;
        const stop = day.anchors(date).effectiveStop;
        if (fromISO(p.end).toMillis() > stop.toMillis()) { problems.push(`“${c.title}” ends after the hard stop on ${date} (${stop.toFormat('h:mm a')}). Nothing is scheduled past the stop; move it earlier or to another day.`); continue; }
      }
      if (c.kind === 'task.meta' && p.patch?.mustDoDate && !p.patch.optional) {
        const set = countFor(p.patch.mustDoDate);
        if (!set.has(p.taskId) && set.size >= cap) { problems.push(`“${c.title}”: ${p.patch.mustDoDate} already has ${set.size} must-dos (the cap is ${cap}). Swap one out or make this one optional.`); continue; }
        set.add(p.taskId);
      }
      have.add(key(c));
      ok.push(c);
    }
    return { ok, problems };
  }

  const toText = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v ?? null);
    return t.length > MAX_RESULT_CHARS ? `${t.slice(0, MAX_RESULT_CHARS)}… (truncated ${t.length - MAX_RESULT_CHARS} characters; ask for less)` : t;
  };

  /** Wrap module tools for a provider. Read results are privacy-filtered; propose results are collected, never applied. */
  function wrapTools(list: { module: string; tool: ClaudeTool }[], proposals: ProposedChange[], calls: ToolCallLog[]): ProviderTool[] {
    const share = s().shareWellbeing;
    return list.map(({ tool }) => ({
      name: tool.name,
      description: `${tool.description}${tool.kind === 'propose' ? ' (Proposes changes for review; nothing is applied.)' : ''}`,
      input: tool.input,
      async execute(raw: unknown) {
        const parsed = tool.input.safeParse(raw ?? {});
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
          calls.push({ name: tool.name, kind: tool.kind, ok: false, note: 'invalid input' });
          return { content: `Invalid input for ${tool.name}: ${msg}. Fix the input and call it again.`, isError: true };
        }
        try {
          const out = await tool.run(ctx, parsed.data);
          if (tool.kind === 'read') {
            calls.push({ name: tool.name, kind: 'read', ok: true });
            return { content: toText(share ? out : stripWellbeing(out)) };
          }
          const arr = Array.isArray(out) ? out : out && typeof out === 'object' && Array.isArray((out as any).changes) ? (out as any).changes : out ? [out] : [];
          const items = z.array(PROPOSED).parse(arr) as ProposedChange[];
          const { ok, problems } = checkProposals(items, proposals);
          proposals.push(...ok);
          calls.push({ name: tool.name, kind: 'propose', ok: ok.length > 0 || !problems.length, note: `${ok.length} proposed${problems.length ? `, ${problems.length} rejected` : ''}` });
          return {
            content: JSON.stringify({ queued: ok.length, titles: ok.map((c) => c.title), rejected: problems, note: 'Proposed for review. Nothing has been applied.' }),
            isError: !ok.length && problems.length > 0,
          };
        } catch (e: any) {
          calls.push({ name: tool.name, kind: tool.kind, ok: false, note: String(e?.message ?? e).slice(0, 120) });
          return { content: `Error: ${String(e?.message ?? e)}`, isError: true };
        }
      },
    }));
  }

  // ---------------------------------------------------------------- context
  async function contextBlock(): Promise<string> {
    const modules: Record<string, unknown> = {};
    for (const m of ctx.registry.enabled()) {
      if (!m.claude?.context) continue;
      try { modules[m.id] = await m.claude.context(ctx); } catch (e: any) { ctx.log.warn(`ai context ${m.id} failed`, e?.message); }
    }
    const n = now();
    const body = { now: n.toISO(), today: n.toISODate(), weekday: n.toFormat('cccc'), ...modules };
    const json = JSON.stringify(s().shareWellbeing ? body : stripWellbeing(body));
    return `<margin_context>\n${json.slice(0, 12_000)}\n</margin_context>`;
  }

  // ---------------------------------------------------------------- usage + budget
  function record(feature: string, p: Provider, res: ProviderResult) {
    const cost = estimateCostUsd(res.model, res.usage);
    ctx.db.run(`INSERT INTO ai_usage (id, at, month, feature, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, uid(), now().toISO(), month(), feature, p.id, res.model, res.usage.inputTokens, res.usage.outputTokens,
    res.usage.cacheReadTokens, res.usage.cacheWriteTokens, cost);
  }

  const money = (n: number) => `$${n.toFixed(2)}`;

  async function invoke(feature: string, req: Omit<ProviderRequest, 'feature' | 'budgetUsd'>): Promise<ProviderResult> {
    const p = provider();
    if (!p) throw new AiError('off', s().provider === 'api' ? 'Claude is set to use an API key, but none is saved. Paste one in Settings → Claude.' : 'Claude is off. Turn it on in Settings → Claude.', 409);
    let budgetUsd: number | null = null;
    if (p.id === 'api') {
      const cap = s().monthlyBudgetUsd;
      const used = spent('api');
      const est = estimateCostUsd(req.model, {
        ...zeroUsage(),
        inputTokens: estimateTokens(req.system + JSON.stringify(req.messages)) + req.tools.length * 150,
        outputTokens: Math.min(req.maxTokens, 1500),
      });
      if (used + est > cap) {
        const resets = now().plus({ months: 1 }).startOf('month').toFormat('LLL d');
        throw new AiError('budget', `You’ve used ${money(used)} of this month’s ${money(cap)} Claude budget, and this request would likely go over. Raise the budget in Settings → Claude, or wait until ${resets}.`, 402);
      }
      budgetUsd = cap - used;
    }
    const res = await p.run({ ...req, feature, budgetUsd });
    record(feature, p, res);
    return res;
  }

  // ---------------------------------------------------------------- structured replies
  function parseJson<T>(text: string, schema: z.ZodType<T>): T | null {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { const r = schema.safeParse(JSON.parse(text.slice(a, b + 1))); return r.success ? r.data : null; } catch { return null; }
  }

  async function structured<T>(feature: Feature, base: Omit<ProviderRequest, 'feature' | 'budgetUsd'>, schema: z.ZodType<T>): Promise<{ data: T; res: ProviderResult }> {
    let res = await invoke(feature, base);
    let data = parseJson(res.text, schema);
    if (!data) { // one repair round: say what was wrong and ask again
      res = await invoke(feature, { ...base, messages: [...base.messages, { role: 'assistant', content: res.text || '(empty)' }, { role: 'user', content: 'That was not the JSON object I asked for. Reply with ONLY the JSON object, matching the shape exactly.' }] });
      data = parseJson(res.text, schema);
    }
    if (!data) throw new AiError('provider', 'Claude’s reply wasn’t in the expected shape. Try again.', 502);
    return { data, res };
  }

  // ---------------------------------------------------------------- run
  function userText(feature: Feature, input: any): string {
    if (feature === 'ask') return input.messages[input.messages.length - 1].content;
    if (feature === 'shutdown_actions') return input.items.join('\n');
    if (feature === 'draft_message') return input.context;
    if (feature === 'parse_capture') return input.text;
    return '';
  }

  const svc = {
    settings: s,
    /** Tests inject a fake here; it is used regardless of the provider setting. */
    useProvider(p: Provider | null) { override = p; },

    enabled(): boolean { return !!override || (s().provider === 'plan') || (s().provider === 'api' && ctx.keychain.has(KEY_ACCOUNT)); },
    month,
    spentUsd: spent,
    tools: () => gatherTools().map(({ module, tool }) => ({ module, name: tool.name, kind: tool.kind })),

    async run(feature: Feature, rawInput: unknown): Promise<RunOutput> {
      if (!(FEATURES as readonly string[]).includes(feature)) throw Object.assign(new Error(`Unknown AI feature "${feature}".`), { status: 400 });
      const input = INPUT[feature].parse(rawInput ?? {});
      const calls: ToolCallLog[] = [];

      // Crisis language: open Get help first, even when Claude is off.
      const crisis = detectCrisis(userText(feature, input));
      if (crisis) { try { ctx.maybe<{ open(reason: string): void }>('gethelp')?.open('ask'); } catch (e: any) { ctx.log.warn('gethelp.open failed', e?.message); } }
      const care = (extra: Partial<RunOutput> = {}): RunOutput => ({
        text: CARE_TEXT, toolCalls: calls, careShown: true,
        ...(feature === 'parse_capture' ? { data: { content: (input as any).text } } : {}), ...extra,
      });
      if (crisis && feature !== 'ask') return care();
      if (!provider()) { if (crisis) return care(); throw new AiError('off', svc.offMessage(), 409); }

      try {
        return await svc.runWithProvider(feature, input, calls, crisis);
      } catch (e) {
        if (crisis) { ctx.log.warn('ai call failed during a care response', (e as Error).message); return care(); }
        throw e;
      }
    },

    offMessage: () => 'Claude is off. Turn it on in Settings → Claude.',

    async runWithProvider(feature: Feature, input: any, calls: ToolCallLog[], crisis: boolean): Promise<RunOutput> {
      const conf = CONF[feature];
      const st = s();
      const model = conf.model === 'planning' ? st.planningModel : st.fastModel;
      const proposals: ProposedChange[] = [];
      let tools: ProviderTool[] = [];
      if (!crisis && conf.tools !== 'none') {
        const list = gatherTools().filter(({ tool }) => (conf.tools === 'all' ? true : tool.kind === 'read' && READ_SUBSET.has(tool.name)));
        tools = wrapTools(list, proposals, calls);
      }

      // Task text (volatile) + context go on the LAST user message so the cached prefix stays stable.
      let messages: ProviderRequest['messages'];
      let task = '';
      switch (feature) {
        case 'plan_day': task = TASKS.plan_day(input.date); break;
        case 'weekly_summary': task = TASKS.weekly_summary(input.weekStart); break;
        case 'shutdown_actions': task = TASKS.shutdown_actions(input.items); break;
        case 'draft_message': task = TASKS.draft_message(input.kind, input.context); break;
        case 'parse_capture': {
          const td = ctx.maybe<any>('todoist');
          task = TASKS.parse_capture(input.text, today(), now().toFormat('cccc'),
            (td?.projects?.() ?? []).map((p: any) => p.name).slice(0, 60), (td?.labels?.() ?? []).map((l: any) => l.name).slice(0, 60));
          break;
        }
        case 'ask': break;
      }
      const ctxBlock = await contextBlock();
      if (feature === 'ask') {
        const turns = input.messages.slice(-20) as ProviderRequest['messages'];
        const last = turns[turns.length - 1];
        messages = [...turns.slice(0, -1), { role: 'user', content: `${ctxBlock}\n\n${crisis ? `${CARE_NOTE}\n\n` : ''}${last.content}` }];
      } else {
        messages = [{ role: 'user', content: `${ctxBlock}\n\n${task}` }];
      }
      const base = { system: SYSTEM, messages, tools, model, maxTokens: conf.maxTokens, maxRounds: conf.rounds, effort: conf.effort };
      const out = (res: ProviderResult, extra: Partial<RunOutput> = {}): RunOutput => ({
        text: res.text, toolCalls: calls, provider: provider()!.id, model: res.model,
        ...(['budget', 'max_tokens', 'max_rounds', 'refusal'].includes(res.stopReason) ? { stopped: res.stopReason } : {}), ...extra,
      });
      const withChangeSet = (o: RunOutput, title: string, summary: string): RunOutput => {
        if (!proposals.length) return o;
        const set = ctx.changes.propose({ source: 'claude', title, summary: summary.slice(0, 2000), changes: proposals });
        return { ...o, changeSetId: set.id };
      };

      if (feature === 'shutdown_actions') {
        const { data, res } = await structured('shutdown_actions', base, SHUTDOWN_OUT);
        return out(res, { text: '', data });
      }
      if (feature === 'parse_capture') {
        const { data, res } = await structured('parse_capture', base, CAPTURE_OUT);
        const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));
        return out(res, { text: '', data: clean });
      }
      const res = await invoke(feature, base);
      const o = out(res);
      if (feature === 'plan_day') return withChangeSet(o, `Plan for ${input.date}`, res.text);
      if (feature === 'weekly_summary') return withChangeSet(o, `Week of ${input.weekStart}: proposed changes`, res.text);
      if (feature === 'ask') {
        const q = (input.messages[input.messages.length - 1].content as string).replace(/\s+/g, ' ').slice(0, 60);
        return withChangeSet(o, `From Ask: ${q}`, res.text);
      }
      return o; // draft_message: text only
    },

    // ---------------------------------------------------------------- status, usage, test
    async status(opts: { plan?: boolean } = {}) {
      const st = s();
      const used = spent('api');
      const out: any = {
        provider: st.provider, enabled: svc.enabled(),
        models: { planning: st.planningModel, fast: st.fastModel },
        shareWellbeing: st.shareWellbeing,
        hasKey: ctx.keychain.has(KEY_ACCOUNT),
        budget: { monthlyUsd: st.monthlyBudgetUsd, spentUsd: used, remainingUsd: Math.max(0, st.monthlyBudgetUsd - used) },
      };
      if (opts.plan) {
        const cli = await detectClaudeCli({ force: true });
        out.plan = { cli, login: cli.found ? await planLoginStatus(cli.path!) : null };
      }
      return out;
    },

    usage() {
      const m = month();
      const rows = ctx.db.all<any>(`SELECT feature, provider, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cache_read_tokens) cacheRead,
        SUM(cache_write_tokens) cacheWrite, SUM(cost_usd) cost FROM ai_usage WHERE month = ? GROUP BY feature, provider ORDER BY cost DESC`, m);
      const num = (r: any) => ({ feature: r.feature, provider: r.provider, calls: r.calls, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite, costUsd: Math.round(r.cost * 1e4) / 1e4 });
      const byFeature = rows.map(num);
      const sum = (provider?: string) => rows.filter((r) => !provider || r.provider === provider).reduce((a, r) => ({ calls: a.calls + r.calls, tokens: a.tokens + r.input + r.output + r.cacheRead + r.cacheWrite, costUsd: a.costUsd + r.cost }), { calls: 0, tokens: 0, costUsd: 0 });
      const cap = s().monthlyBudgetUsd;
      const api = sum('api');
      return {
        month: m, byFeature,
        total: sum(), api, plan: sum('plan'),
        budget: { monthlyUsd: cap, spentUsd: api.costUsd, remainingUsd: Math.max(0, cap - api.costUsd) },
        recent: ctx.db.all<any>('SELECT at, feature, provider, model, input_tokens inputTokens, output_tokens outputTokens, cost_usd costUsd FROM ai_usage ORDER BY at DESC LIMIT 10'),
      };
    },

    /** A tiny real call on the fast model: the only way to know a login or key works. */
    async test(): Promise<{ ok: boolean; provider: string; model: string; message: string; ms: number }> {
      const t0 = Date.now();
      const p = provider();
      const model = s().fastModel;
      if (!p) return { ok: false, provider: s().provider, model, message: s().provider === 'off' ? 'Claude is off. Choose plan login or an API key first.' : 'No API key is saved yet.', ms: 0 };
      try {
        const res = await invoke('test', { system: 'You are a connection test. Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test.' }], tools: [], model, maxTokens: 1024, maxRounds: 1, effort: 'low' });
        return { ok: true, provider: p.id, model: res.model, message: `Connected${p.id === 'plan' ? ' with your Claude plan' : ' with your API key'} (${res.model}).`, ms: Date.now() - t0 };
      } catch (e: any) {
        return { ok: false, provider: p.id, model, message: String(e?.message ?? e), ms: Date.now() - t0 };
      }
    },

    /** Used by POST /api/ai/propose (MCP): validated against registered kinds, always a pending change set. */
    proposeFromMcp(input: { title: string; summary?: string; changes: ProposedChange[] }) {
      const kinds = new Set(ctx.changes.kinds().map((k) => k.kind));
      const bad = input.changes.filter((c) => !kinds.has(c.kind)).map((c) => c.kind);
      if (bad.length) throw Object.assign(new Error(`Unknown change kind${bad.length > 1 ? 's' : ''}: ${[...new Set(bad)].join(', ')}. Known kinds: ${[...kinds].join(', ')}.`), { status: 400 });
      const { ok, problems } = checkProposals(input.changes, []);
      if (!ok.length) throw Object.assign(new Error(problems.join(' ') || 'No valid changes.'), { status: 400 });
      const set = ctx.changes.propose({ source: 'mcp', title: input.title, summary: input.summary ?? '', changes: ok });
      return { id: set.id, status: set.status, count: set.changes.length, rejected: problems, url: `/changes/${set.id}` };
    },
  };
  return svc;
}
export type AiService = ReturnType<typeof createAiService>;
