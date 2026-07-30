/**
 * Shared token usage shapes for `/api/tokens`. Dollar amounts and token totals
 * are expected to come from provider admin APIs, not local price tables.
 */
export interface TokenAgg {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
  requests: number;
}

function emptyAgg(): TokenAgg {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, requests: 0 };
}

export interface ParsedTokenUsage {
  total: TokenAgg;
  byModel: Record<string, TokenAgg>;
  byAgent: Record<string, TokenAgg>;
  byDay: Record<string, TokenAgg>;
  byAgentModel: Record<string, Record<string, TokenAgg>>;
}

export function emptyParsedTokenUsage(): ParsedTokenUsage {
  return {
    total: emptyAgg(),
    byModel: {},
    byAgent: {},
    byDay: {},
    byAgentModel: {},
  };
}
