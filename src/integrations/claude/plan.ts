/**
 * Plan-login provider: runs Claude through the person's Claude plan, no API key.
 *  1. Claude Agent SDK (`query`) with Margin's tools served from an in-process MCP server, every built-in
 *     tool (Bash, Read, Edit …) turned off, and no user/project settings loaded.
 *  2. If the SDK path fails to start, fall back to headless `claude -p --output-format json`. That mode has no
 *     native tool calling here, so tools are emulated: the model answers `{"calls":[…]}` and we reply with results.
 * ANTHROPIC_API_KEY & co. are stripped from the child environment, otherwise Claude Code would bill the key instead of the plan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AiError, addUsage, zeroUsage, type Provider, type ProviderRequest, type ProviderResult, type ProviderTool, type ProviderUsage } from './types';
import { detectClaudeCli, planEnv, run as exec, type CliInfo } from './cli';

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

export interface PlanDeps {
  /** Scratch working directory for the child process (Margin's data dir). */
  cwd: string;
  detect?: () => Promise<CliInfo>;
  loadSdk?: () => Promise<SdkModule>;
  exec?: typeof exec;
}

function schemaOf(t: ProviderTool) {
  const { $schema: _s, ...rest } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

/** Flatten a chat into one prompt: both the SDK and `claude -p` take a single string. */
function flatten(req: ProviderRequest): string {
  if (req.messages.length === 1) return req.messages[0].content;
  return req.messages.map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${m.content}`).join('\n\n') + '\n\nAssistant:';
}

function friendly(text: string): AiError {
  if (/not logged in|\/login|login|authenticat|oauth|session expired|invalid api key|unauthorized|401/i.test(text)) return new AiError('auth', 'Claude can’t use your plan login right now (not signed in, or the sign-in expired). Run “claude auth login” in Terminal, then test again.', 401);
  if (/usage limit|rate limit|limit reached|too many requests|overloaded/i.test(text)) return new AiError('rate_limit', 'Your Claude plan limit is reached for now. It resets on its own; try again later, or switch to an API key in Settings.', 429);
  return new AiError('provider', `Claude (plan login) returned an error: ${text.replace(/\s+/g, ' ').trim().slice(0, 240)}`, 502);
}

function usageFrom(modelUsage: Record<string, any> | undefined, fallback: any): ProviderUsage {
  const entries = Object.values(modelUsage ?? {});
  if (entries.length) {
    return entries.reduce<ProviderUsage>((a, m) => addUsage(a, {
      inputTokens: m.inputTokens ?? 0, outputTokens: m.outputTokens ?? 0,
      cacheReadTokens: m.cacheReadInputTokens ?? 0, cacheWriteTokens: m.cacheCreationInputTokens ?? 0,
    }), zeroUsage());
  }
  return {
    inputTokens: fallback?.input_tokens ?? 0, outputTokens: fallback?.output_tokens ?? 0,
    cacheReadTokens: fallback?.cache_read_input_tokens ?? 0, cacheWriteTokens: fallback?.cache_creation_input_tokens ?? 0,
  };
}

/** Margin's tools as an in-process MCP server for the Agent SDK (exported so tests can talk to it over a memory transport). */
export function buildToolServer(sdk: Pick<SdkModule, 'tool' | 'createSdkMcpServer'>, tools: ProviderTool[]) {
  return sdk.createSdkMcpServer({
    name: 'margin', version: '1.0.0',
    tools: tools.map((t) => sdk.tool(t.name, t.description, t.input.shape as any, async (args: unknown) => {
      const r = await t.execute(args);
      return { content: [{ type: 'text' as const, text: r.content }], ...(r.isError ? { isError: true } : {}) };
    })),
  });
}

export function createPlanProvider(deps: PlanDeps): Provider {
  const detect = deps.detect ?? (() => detectClaudeCli());
  const sh = deps.exec ?? exec;

  async function viaSdk(req: ProviderRequest, cli: CliInfo): Promise<ProviderResult> {
    const sdk = await (deps.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk')))();
    fs.mkdirSync(deps.cwd, { recursive: true });
    const server = req.tools.length ? buildToolServer(sdk, req.tools) : null;
    const stderr: string[] = [];
    const q = sdk.query({
      prompt: flatten(req),
      options: {
        systemPrompt: req.system,
        model: req.model,
        tools: [], // no built-in tools at all: Margin's tools only
        ...(server ? { mcpServers: { margin: server } } : {}),
        allowedTools: req.tools.map((t) => `mcp__margin__${t.name}`),
        permissionMode: 'dontAsk',
        settingSources: [], // ignore ~/.claude and project settings, CLAUDE.md, hooks
        persistSession: false,
        maxTurns: req.maxRounds + 1,
        cwd: deps.cwd,
        env: planEnv(),
        pathToClaudeCodeExecutable: cli.path ?? undefined,
        stderr: (d: string) => { stderr.push(d); },
      } as any,
    });
    if (req.signal) req.signal.addEventListener('abort', () => q.close(), { once: true });
    let result: any = null;
    let lastText = '';
    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          const t = (msg.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
          if (t) lastText = t;
        }
        if (msg.type === 'result') result = msg;
      }
    } catch (e: any) {
      const msg = `${e?.message ?? e} ${stderr.join(' ')}`;
      const f = friendly(msg);
      if (f.code !== 'provider') throw f;
      throw new AiError('provider', `The Agent SDK couldn’t run: ${String(e?.message ?? e).slice(0, 200)}`, 502);
    }
    if (!result) throw new AiError('provider', 'The Agent SDK ended without an answer.', 502);
    const usage = usageFrom(result.modelUsage, result.usage);
    const model = Object.keys(result.modelUsage ?? {})[0] ?? req.model;
    if (result.subtype === 'error_max_turns') return { text: lastText, usage, model, stopReason: 'max_rounds', rounds: result.num_turns ?? req.maxRounds };
    if (result.is_error || result.subtype !== 'success') throw friendly(String(result.result ?? result.errors?.join(' ') ?? result.subtype));
    return { text: String(result.result ?? lastText).trim(), usage, model, stopReason: result.stop_reason ?? 'end_turn', rounds: result.num_turns ?? 1 };
  }

  async function viaHeadless(req: ProviderRequest, cli: CliInfo): Promise<ProviderResult> {
    const tools = req.tools;
    const protocol = tools.length
      ? '\n\nTOOLS (this session has no native tool calling)\nTo use tools, reply with ONLY a JSON object: {"calls":[{"tool":"<name>","input":{…}}]}. You will receive the results in the next message. ' +
        'When you are done, reply with your final answer (plain text, or the JSON the task asks for) with no "calls" key.\nAvailable tools:\n' +
        tools.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(schemaOf(t))}`).join('\n')
      : '';
    let transcript = flatten(req);
    let usage = zeroUsage();
    let model = req.model;
    const rounds = Math.min(req.maxRounds, 5);
    for (let round = 1; ; round++) {
      const r = await sh(cli.path!, ['-p', '--output-format', 'json', '--model', req.model, '--system-prompt', req.system + protocol,
        '--tools', '', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config'],
      { timeoutMs: 180_000, env: planEnv(), input: transcript });
      let j: any;
      try { j = JSON.parse(r.stdout); } catch { throw friendly(r.stderr || r.stdout || 'no output'); }
      if (j.is_error) throw friendly(String(j.result ?? j.subtype));
      usage = addUsage(usage, usageFrom(j.modelUsage, j.usage));
      model = Object.keys(j.modelUsage ?? {})[0] ?? model;
      const text = String(j.result ?? '').trim();
      const calls = tools.length ? parseCalls(text) : null;
      if (!calls || round >= rounds) return { text: calls ? '' : text, usage, model, stopReason: calls ? 'max_rounds' : 'end_turn', rounds: round };
      const results = await Promise.all(calls.map(async (c) => {
        const t = tools.find((x) => x.name === c.tool);
        const out = t ? await t.execute(c.input) : { content: `Unknown tool "${c.tool}".`, isError: true };
        return `[${c.tool}]${out.isError ? ' (error)' : ''} ${out.content}`;
      }));
      transcript += `\n\nAssistant: ${text}\n\nTool results:\n${results.join('\n\n')}\n\nContinue.`;
    }
  }

  return {
    id: 'plan',
    async run(req) {
      const cli = await detect();
      if (!cli.found) throw new AiError('cli_missing', cli.hint ?? 'Claude Code isn’t installed, so plan login can’t run.', 409);
      try {
        return await viaSdk(req, cli);
      } catch (e) {
        if (e instanceof AiError && e.code !== 'provider') throw e; // sign-in and limit problems would fail the same way headless
        try { return await viaHeadless(req, cli); }
        catch (e2) { throw e2 instanceof AiError && e2.code !== 'provider' ? e2 : new AiError('provider', `${(e as Error).message} The headless fallback failed too: ${(e2 as Error).message}`, 502); }
      }
    },
  };
}

function parseCalls(text: string): { tool: string; input: unknown }[] | null {
  const t = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (Array.isArray(o?.calls) && o.calls.length && o.calls.every((c: any) => typeof c?.tool === 'string')) return o.calls.map((c: any) => ({ tool: c.tool, input: c.input ?? {} }));
  } catch { /* final answer that happens to start with { */ }
  return null;
}
