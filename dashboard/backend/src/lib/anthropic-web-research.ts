/**
 * Research step for the content rewrite pipeline: Claude + Anthropic web search (server tool).
 * See Anthropic docs: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
 */
import type { AppConfig } from '../config.js';
import { log } from './logger.js';
import { PUBLICATION_BACKGROUND_FOR_PROMPTS } from './publication-context.js';

export type ResearchAgentInput = {
  slug: string;
  title: string;
  excerpt: string;
  contentSnippet: string;
  auditSummary: string;
  failNotes: string;
  checksJson: string;
};

/** Exported for docs/tests — this is the research “agent” system prompt. */
export const RESEARCH_AGENT_SYSTEM = `You are a dedicated **research agent** with web search. Output is **internal** to an editorial crew (orchestrator, writer, reviewer)—readers never see this verbatim.

${PUBLICATION_BACKGROUND_FOR_PROMPTS}

Rules:
- Use web search when needed; prefer authoritative or official sources (government, regulators, insurers’ own pages, reputable news) for Germany/EU where relevant.
- Do **not** rewrite the article and do **not** output HTML.
- Bullet points only; no long preamble.
- If results conflict or a figure is uncertain, say so explicitly—downstream agents must not treat your bullets as infallible statutory text.
- Prefer **themes and pointers** over pasting long numbers, coverage sums, or dates unless you are confident they come from an official primary source in the results. Never invent URLs.
- Label speculation vs confirmed: when unsure, write “uncertain — verify” rather than a precise euro amount.`;

/** Exported — user message template for the research agent (filled with article + audit context). */
export function buildResearchUserPrompt(input: ResearchAgentInput): string {
  return `Article: "${input.title}" (slug: ${input.slug})
Audit summary: ${input.auditSummary}

Failing SEO checks (notes):
${input.failNotes || '(none listed)'}

Full SEO/GEO checks_json from the earlier audit:
${input.checksJson || '{}'}

Excerpt: ${input.excerpt.slice(0, 500)}

Body excerpt for context:
${input.contentSnippet}

Your job as research agent:
1) Flag factual claims, statistics, or years in this topic that may be outdated or imprecise (Germany / EU context where relevant).
2) Provide 5–10 bullet points of concrete, verifiable updates or corrections a writer should apply (prefer specific institutions, law names, or official sources when relevant).
3) Note any major regulatory or widely reported changes since the article likely last reflected reality (use web search).
4) End with one line: "Confidence: high|medium|low" for how current your picture is for this topic.
Do not rewrite the article. Bullet text only, no preamble.`;
}

function rewriteModel(cfg: AppConfig): string {
  return cfg.REWRITE_MODEL || cfg.SEO_AUDIT_MODEL || process.env.REWRITE_MODEL || 'claude-sonnet-4-20250514';
}

function anthropicKey(cfg: AppConfig): string | undefined {
  const k = cfg.ANTHROPIC_API_KEY?.trim();
  return k || undefined;
}

function webSearchToolDef(cfg: AppConfig): Record<string, unknown> {
  const type = cfg.REWRITE_WEB_SEARCH_TOOL || 'web_search_20250305';
  const base: Record<string, unknown> = { type, name: 'web_search' };
  // max_uses is documented for web_search_20250305; omit for 20260209 if unsupported
  if (type === 'web_search_20250305') {
    base.max_uses = cfg.REWRITE_WEB_SEARCH_MAX_USES ?? 5;
  }
  return base;
}

type ContentBlock = { type: string; text?: string };

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as ContentBlock[]) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      parts.push(b.text.trim());
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Runs the research agent: one Messages API request with web_search enabled.
 * Anthropic executes searches server-side; response includes final assistant text (and citations metadata in blocks).
 */
export async function runAnthropicWebResearch(cfg: AppConfig, input: ResearchAgentInput): Promise<string> {
  const key = anthropicKey(cfg);
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set (research agent cannot run).');
  }

  const model = rewriteModel(cfg);
  const user = buildResearchUserPrompt(input);

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    system: RESEARCH_AGENT_SYSTEM,
    messages: [{ role: 'user', content: user }],
    tools: [webSearchToolDef(cfg)],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    log.error({ status: res.status, body: raw.slice(0, 800) }, 'research agent (Anthropic web search) request failed');
    throw new Error(`Research agent failed (HTTP ${res.status}): ${raw.slice(0, 500)}`);
  }

  let data: { content?: unknown };
  try {
    data = JSON.parse(raw) as { content?: unknown };
  } catch {
    throw new Error('Research agent returned non-JSON response.');
  }

  const text = extractAssistantText(data.content ?? []);
  if (!text) {
    log.error({ body: raw.slice(0, 1200) }, 'research agent returned no text content');
    throw new Error('Research agent returned empty text after web search.');
  }

  log.info({ slug: input.slug, model, chars: text.length }, 'research agent (Anthropic web search) completed');
  return text;
}
