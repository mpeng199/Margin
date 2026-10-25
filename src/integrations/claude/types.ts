/**
 * The one small interface every Claude provider implements (plan login, API key, or a test fake).
 * The service owns tools, validation, privacy, budget and change sets; a provider only drives the
 * model/tool loop and reports tokens.
 */
import type { z } from 'zod';

export type ProviderId = 'plan' | 'api';

export interface ProviderTool {
  name: string;
  description: string;
  input: z.ZodObject<any>;
  /** Never throws. Errors come back as `isError` text so the model can correct itself. */
  execute(input: unknown): Promise<{ content: string; isError?: boolean }>;
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface ProviderRequest {
  feature: string;
  model: string;
  /** Stable text (cached). Volatile context goes in the last user message, never here. */
  system: string;
  messages: ChatTurn[];
  tools: ProviderTool[];
  maxTokens: number;
  maxRounds: number;
  effort?: 'low' | 'medium' | 'high';
  /** Remaining dollars this call may spend (api provider only); the loop stops when estimated spend passes it. */
  budgetUsd?: number | null;
  signal?: AbortSignal;
}

export interface ProviderUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export const zeroUsage = (): ProviderUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export const addUsage = (a: ProviderUsage, b: ProviderUsage): ProviderUsage => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

export interface ProviderResult {
  text: string;
  usage: ProviderUsage;
  /** Model that actually answered. */
  model: string;
  stopReason: 'end_turn' | 'max_tokens' | 'max_rounds' | 'budget' | 'refusal' | string;
  rounds: number;
}

export interface Provider {
  readonly id: ProviderId;
  run(req: ProviderRequest): Promise<ProviderResult>;
}

export type AiErrorCode = 'off' | 'budget' | 'not_configured' | 'cli_missing' | 'auth' | 'rate_limit' | 'provider' | 'invalid';

/** An error whose message is already plain language and safe to show. `status` is used by the HTTP layer. */
export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string, public status = 502) {
    super(message);
    this.name = 'AiError';
  }
}
