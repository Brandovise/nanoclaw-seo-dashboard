import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

const PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  'claude-3-opus': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
};

function getPricing(model: string) {
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).find((k) => model.includes(k) || k.includes(model));
  return key ? PRICING[key]! : { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 };
}

function calcCost(model: string, inp: number, out: number, cw: number, cr: number): number {
  const p = getPricing(model);
  return (inp * p.input + out * p.output + cw * p.cacheWrite + cr * p.cacheRead) / 1_000_000;
}

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

function addUsage(agg: TokenAgg, inp: number, out: number, cw: number, cr: number, model: string) {
  agg.input += inp;
  agg.output += out;
  agg.cacheWrite += cw;
  agg.cacheRead += cr;
  agg.cost += calcCost(model, inp, out, cw, cr);
  agg.requests += 1;
}

function findJsonlFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findJsonlFiles(full, out);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  } catch {
    /* skip */
  }
  return out;
}

function pathToLabel(filePath: string): string {
  const m = filePath.match(/v2-sessions\/(ag-[^/]+)\//);
  if (m) return `group:${m[1]}`;
  return 'other';
}

export function parseLocalUsage(cfg: AppConfig, sinceIso: string): {
  total: TokenAgg;
  byModel: Record<string, TokenAgg>;
  byAgent: Record<string, TokenAgg>;
  byDay: Record<string, TokenAgg>;
  byAgentModel: Record<string, Record<string, TokenAgg>>;
} {
  const total = emptyAgg();
  const byModel: Record<string, TokenAgg> = {};
  const byAgent: Record<string, TokenAgg> = {};
  const byDay: Record<string, TokenAgg> = {};
  const byAgentModel: Record<string, Record<string, TokenAgg>> = {};

  const roots = [cfg.v2SessionsDir];
  for (const root of roots) {
    for (const file of findJsonlFiles(root)) {
      const label = pathToLabel(file);
      const byReqId = new Map<string, { inp: number; out: number; cw: number; cr: number; model: string; ts: string }>();
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry: Record<string, unknown>;
          try {
            entry = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (entry.type !== 'assistant') continue;
          const ts = entry.timestamp as string | undefined;
          if (!ts || ts < sinceIso) continue;
          const msg = entry.message as Record<string, unknown> | undefined;
          const usage = msg?.usage as Record<string, number> | undefined;
          if (!usage) continue;
          const model = (msg?.model as string | undefined) ?? 'unknown';
          const inp = (usage.input_tokens ?? 0) as number;
          const outT = (usage.output_tokens ?? 0) as number;
          const cw = (usage.cache_creation_input_tokens ?? 0) as number;
          const cr = (usage.cache_read_input_tokens ?? 0) as number;
          const reqId = (entry.requestId as string) ?? (entry.uuid as string) ?? line.slice(0, 40);
          const existing = byReqId.get(reqId);
          if (!existing || outT > existing.out) {
            byReqId.set(reqId, { inp, out: outT, cw, cr, model, ts });
          }
        }
      } catch {
        continue;
      }
      for (const { inp, out, cw, cr, model, ts } of byReqId.values()) {
        if (!byModel[model]) byModel[model] = emptyAgg();
        if (!byAgent[label]) byAgent[label] = emptyAgg();
        const day = ts.slice(0, 10);
        if (!byDay[day]) byDay[day] = emptyAgg();
        if (!byAgentModel[label]) byAgentModel[label] = {};
        if (!byAgentModel[label][model]) byAgentModel[label][model] = emptyAgg();
        addUsage(total, inp, out, cw, cr, model);
        addUsage(byModel[model], inp, out, cw, cr, model);
        addUsage(byAgent[label], inp, out, cw, cr, model);
        addUsage(byDay[day], inp, out, cw, cr, model);
        addUsage(byAgentModel[label][model], inp, out, cw, cr, model);
      }
    }
  }

  return { total, byModel, byAgent, byDay, byAgentModel };
}
