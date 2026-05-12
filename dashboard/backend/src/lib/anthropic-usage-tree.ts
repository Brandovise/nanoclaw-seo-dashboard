/**
 * Build typed usage trees from Anthropic Admin API responses (no local pricing math).
 */
import type { ParsedTokenUsage, TokenAgg } from './tokens.js';

function emptyAgg(): TokenAgg {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 0 };
}

type AnthropicBillingShape = {
  usage?: { data?: unknown[] };
  cost?: { data?: unknown[] };
};

function asBuckets(
  data: unknown,
): Array<{ starting_at?: string; model?: string; model_name?: string; results?: unknown[] }> {
  if (!data || typeof data !== 'object') return [];
  const u = (data as AnthropicBillingShape).usage;
  const list = u?.data;
  return Array.isArray(list)
    ? (list as Array<{ starting_at?: string; model?: string; model_name?: string; results?: unknown[] }>)
    : [];
}

function asCostBuckets(data: unknown): Array<{ starting_at?: string; results?: unknown[] }> {
  if (!data || typeof data !== 'object') return [];
  const c = (data as AnthropicBillingShape).cost;
  const list = c?.data;
  return Array.isArray(list) ? (list as Array<{ starting_at?: string; results?: unknown[] }>) : [];
}

/** Converts Usage + Cost admin payloads into the dashboard usage tree (Anthropic-reported tokens + cost only). */
export function usageTreeFromAnthropicAdmin(payload: AnthropicBillingShape): ParsedTokenUsage {
  const total = emptyAgg();
  const byModel: Record<string, TokenAgg> = {};
  const byAgent: Record<string, TokenAgg> = {};
  const byDay: Record<string, TokenAgg> = {};
  const byAgentModel: Record<string, Record<string, TokenAgg>> = {};
  const adminLabel = 'admin-billing';

  const add = (
    day: string,
    model: string,
    input: number,
    output: number,
    cacheWrite: number,
    cacheRead: number,
    cost: number,
    requests: number,
  ) => {
    const m = model || 'anthropic';
    const a = adminLabel;
    if (!byModel[m]) byModel[m] = emptyAgg();
    if (!byAgent[a]) byAgent[a] = emptyAgg();
    if (!byDay[day]) byDay[day] = emptyAgg();
    if (!byAgentModel[a]) byAgentModel[a] = {};
    if (!byAgentModel[a][m]) byAgentModel[a][m] = emptyAgg();
    const targets = [total, byModel[m], byAgent[a], byDay[day], byAgentModel[a][m]];
    for (const t of targets) {
      t.input += input;
      t.output += output;
      t.cacheWrite += cacheWrite;
      t.cacheRead += cacheRead;
      t.cost += cost;
      t.requests += requests;
    }
  };

  for (const bucket of asBuckets(payload)) {
    const day = (bucket.starting_at || '').slice(0, 10) || 'unknown';
    const bucketModel = bucket.model || bucket.model_name || 'anthropic';
    const results = Array.isArray(bucket.results) ? bucket.results : [];
    for (const r of results as Array<Record<string, unknown>>) {
      const input = Number(r.uncached_input_tokens ?? r.input_tokens ?? 0);
      const output = Number(r.output_tokens ?? 0);
      const cacheRead = Number(r.cache_read_input_tokens ?? 0);
      const cc = (r.cache_creation ?? {}) as Record<string, unknown>;
      const cacheWrite =
        Number(cc.ephemeral_1h_input_tokens ?? 0) + Number(cc.ephemeral_5m_input_tokens ?? 0);
      const model = String(r.model ?? r.model_name ?? bucketModel);
      add(day, model, input, output, cacheWrite, cacheRead, 0, 1);
    }
  }

  for (const bucket of asCostBuckets(payload)) {
    const day = (bucket.starting_at || '').slice(0, 10) || 'unknown';
    const results = Array.isArray(bucket.results) ? bucket.results : [];
    let dayCost = 0;
    for (const r of results as Array<{ amount?: string }>) {
      dayCost += parseFloat(String(r.amount ?? '0')) / 100;
    }
    if (dayCost > 0) add(day, 'anthropic-cost', 0, 0, 0, 0, dayCost, 0);
  }

  return { total, byModel, byAgent, byDay, byAgentModel };
}
