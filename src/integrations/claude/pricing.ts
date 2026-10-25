/**
 * Estimated cost per call. Prices are $/MTok from the claude-api skill's model table (cached 2026-10-06);
 * cache reads are 0.1x input, 5-minute cache writes 1.25x input. These are estimates, not a bill.
 */
import type { ProviderUsage } from './types';

interface Price { in: number; out: number }
const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 }, // up to 100K prompt tokens; 5x beyond (handled below)
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-fable-5': { in: 10, out: 50 },
};
const FALLBACK = PRICES['claude-sonnet-5-5'];

export const KNOWN_MODELS = Object.keys(PRICES);
export const isKnownModel = (model: string) => model in PRICES;

export function estimateCostUsd(model: string, u: ProviderUsage): number {
  const p = PRICES[model] ?? FALLBACK; // ponytail: unknown model ids are priced like Sonnet 5.5 and flagged by isKnownModel
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const long = model === 'claude-haiku-5-5' && prompt > 100_000 ? 5 : 1;
  const inRate = p.in * long;
  const outRate = p.out * long;
  const usd = (u.inputTokens * inRate + u.cacheReadTokens * inRate * 0.1 + u.cacheWriteTokens * inRate * 1.25 + u.outputTokens * outRate) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Rough token count for pre-flight budget checks (4 characters per token, a little pessimistic). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
