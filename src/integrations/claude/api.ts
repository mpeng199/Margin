/**
 * API-key provider: the Claude API through @anthropic-ai/sdk, with a manual tool loop.
 *  - The stable system prompt carries a cache breakpoint, and so does the last message, so later rounds
 *    of one run (and later turns of one chat) read the earlier prefix from cache.
 *  - Tools are sorted by name so the cached prefix is byte-stable.
 *  - Thinking is left at the model default (adaptive); effort is set per feature. No sampling params
 *    and no forced tool_choice: Sonnet 5.5 rejects both.
 *  - The key comes only from the caller (Keychain). Nothing here reads the environment.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { AiError, addUsage, zeroUsage, type Provider, type ProviderRequest, type ProviderResult, type ProviderTool, type ProviderUsage } from './types';
import { estimateCostUsd } from './pricing';

type Client = Pick<Anthropic, 'messages'>;

function jsonSchema(t: ProviderTool): Anthropic.Tool['input_schema'] {
  const { $schema: _s, ...rest } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest as Anthropic.Tool['input_schema'];
}

/** Put a cache breakpoint on the final block of the final message (without mutating the history). */
function withTailCache(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1] as any;
  if (!tail || tail.type === 'thinking' || tail.type === 'redacted_thinking') return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { role: last.role, content: blocks } as Anthropic.MessageParam];
}

export function friendlyApiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiError('auth', 'Anthropic rejected the API key. Paste a new key in Settings → Claude.', 401);
  if (e instanceof Anthropic.RateLimitError) return new AiError('rate_limit', 'Claude is rate limiting requests right now. Try again in a minute.', 429);
  if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) return new AiError('provider', 'The Console organization has no API credit left. Add credit in the Claude Console, or switch to plan login.', 402);
  if (e instanceof Anthropic.APIConnectionError) return new AiError('provider', 'Couldn’t reach Claude. Check your internet connection and try again.', 503);
  if (e instanceof Anthropic.APIError) return new AiError('provider', `Claude returned an error (${e.status ?? 'network'}): ${e.message.slice(0, 200)}`, 502);
  return new AiError('provider', `Claude call failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, 502);
}

export function createApiProvider(deps: { getKey: () => string | null; client?: Client }): Provider {
  return {
    id: 'api',
    async run(req: ProviderRequest): Promise<ProviderResult> {
      let client = deps.client;
      if (!client) {
        const apiKey = deps.getKey();
        if (!apiKey) throw new AiError('not_configured', 'No API key is saved. Paste one in Settings → Claude.', 409);
        client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
      }
      const tools: Anthropic.Tool[] = [...req.tools].sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
      const byName = new Map(req.tools.map((t) => [t.name, t]));
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
      let usage: ProviderUsage = zeroUsage();
      let model = req.model;

      for (let round = 1; ; round++) {
        let res: Anthropic.Message;
        try {
          res = await client.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            ...(tools.length ? { tools } : {}),
            messages: withTailCache(messages),
            ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          }, req.signal ? { signal: req.signal } : undefined);
        } catch (e) { throw friendlyApiError(e); }

        model = res.model || req.model;
        const u = res.usage as any;
        usage = addUsage(usage, {
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        });
        const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        const done = (stopReason: string): ProviderResult => ({ text, usage, model, stopReason, rounds: round });

        if (res.stop_reason === 'refusal') return { ...done('refusal'), text: text || 'Claude declined this request.' };
        if (res.stop_reason === 'max_tokens') return done('max_tokens');
        if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
        if (res.stop_reason !== 'tool_use') return done('end_turn');

        if (round >= req.maxRounds) return done('max_rounds');
        if (req.budgetUsd != null && estimateCostUsd(req.model, usage) >= req.budgetUsd) return done('budget');

        // Execute every tool call from this turn, then answer all of them in ONE user message.
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const results = await Promise.all(uses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
          const tool = byName.get(use.name);
          if (!tool) return { type: 'tool_result', tool_use_id: use.id, content: `Unknown tool "${use.name}".`, is_error: true };
          const out = await tool.execute(use.input);
          return { type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
        }));
        messages.push({ role: 'user', content: results });
      }
    },
  };
}
