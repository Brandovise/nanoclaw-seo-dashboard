/**
 * Multi-agent rewrite: **structured editorial state** (topic, research, diagnosis, draft, revision_notes)
 * is serialized into each agent call—no narrative transcript, predictable shape, bounded growth from notes.
 */
import type { AppConfig } from '../config.js';
import { log } from './logger.js';
import { runAnthropicWebResearch, type ResearchAgentInput } from './anthropic-web-research.js';
import { PUBLICATION_BACKGROUND_FOR_PROMPTS } from './publication-context.js';
import { auditSeoMarkdownContent, type SeoAuditRecord } from './seo-audit.js';

const MD_START = '<<<NANOCLAW_REWRITE_MD_START>>>';
const MD_END = '<<<NANOCLAW_REWRITE_MD_END>>>';
const HTML_START = '<<<NANOCLAW_REWRITE_HTML_START>>>';
const HTML_END = '<<<NANOCLAW_REWRITE_HTML_END>>>';

export type RewriteAcceptanceThresholds = {
  hr: number;
  seo: number;
  geo: number;
};

function rewriteModel(cfg: AppConfig): string {
  return cfg.REWRITE_MODEL || cfg.SEO_AUDIT_MODEL || process.env.REWRITE_MODEL || 'claude-sonnet-4-20250514';
}

function anthropicKey(cfg: AppConfig): string | undefined {
  const k = cfg.ANTHROPIC_API_KEY?.trim();
  return k || undefined;
}

async function callClaudeText(
  cfg: AppConfig,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const key = anthropicKey(cfg);
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = rewriteModel(cfg);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content?.find((b) => b.type === 'text')?.text?.trim() ?? '';
}

function stripJsonFence(text: string): string {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  return s;
}

function parseMarkdownDelimited(text: string): string {
  const t = text.trim();
  const start = t.indexOf(MD_START);
  const end = t.indexOf(MD_END);
  if (start !== -1 && end !== -1 && end > start) {
    const md = t.slice(start + MD_START.length, end).trim();
    if (md) return md;
  }
  try {
    const parsed = JSON.parse(stripJsonFence(t)) as { markdown?: string; md?: string };
    const md = typeof parsed.markdown === 'string' ? parsed.markdown : typeof parsed.md === 'string' ? parsed.md : '';
    if (md.trim()) return md;
  } catch {
    /* fall through */
  }
  const mdFence = t.match(/```(?:markdown|md)\s*([\s\S]*?)```/i);
  if (mdFence?.[1]?.trim()) return mdFence[1].trim();
  throw new Error(
    `Writer must return Markdown between ${MD_START} and ${MD_END} (or JSON {"markdown":"..."} / fenced markdown).`,
  );
}

function parseHtmlDelimited(text: string): string {
  const t = text.trim();
  const start = t.indexOf(HTML_START);
  const end = t.indexOf(HTML_END);
  if (start !== -1 && end !== -1 && end > start) {
    const html = t.slice(start + HTML_START.length, end).trim();
    if (html) return html;
  }
  try {
    const parsed = JSON.parse(stripJsonFence(t)) as { html?: string };
    if (typeof parsed.html === 'string' && parsed.html.trim()) return parsed.html.trim();
  } catch {
    /* fall through */
  }
  const htmlFence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (htmlFence?.[1]?.trim()) return htmlFence[1].trim();
  throw new Error(`HTML converter must return HTML between ${HTML_START} and ${HTML_END} (or JSON {"html":"..."}).`);
}

function emitProgress(
  onProgress: ((ev: { stage: string; message: string }) => void) | undefined,
  stage: string,
  message: string,
): void {
  try {
    onProgress?.({ stage, message });
  } catch {
    /* UI hook must not break the pipeline */
  }
}

export type ReviewerResult = {
  approve: boolean;
  human_readable: { score: number; notes: string };
  seo: { score: number; notes: string };
  geo: { score: number; notes: string };
  factual_risk: { level: 'low' | 'medium' | 'high'; notes: string; problem_claims: string[] };
  vs_original: { improved: boolean; notes: string };
  must_fix: string[];
  /** Concrete instructions for the writer’s next pass (empty if approve). */
  writer_brief: string;
};

export type OrchestratorRoundTrace = {
  round: number;
  rewrite_audit: SeoAuditRecord;
  reviewer: ReviewerResult;
  revised: boolean;
};

export type OrchestratorTrace = {
  review_rounds: number;
  final_approved: boolean;
  acceptance_thresholds: RewriteAcceptanceThresholds;
  final_html_audit?: SeoAuditRecord;
  /** True when the last round met score gates but the model did not set approve (orchestrator promoted). */
  soft_approved?: boolean;
  rounds: OrchestratorRoundTrace[];
};

function meetsAcceptanceThresholds(r: ReviewerResult, thresholds: RewriteAcceptanceThresholds): boolean {
  return (
    r.factual_risk.level !== 'high' &&
    r.human_readable.score >= thresholds.hr &&
    r.seo.score >= thresholds.seo &&
    r.geo.score >= thresholds.geo &&
    r.vs_original.improved
  );
}

export type RevisionNote = {
  round: number;
  /** Reviewer feedback for this round (scores, must_fix, brief, notes). */
  critique: string;
  /** Filled after the writer revises: what changed vs. prior draft (orchestrator summary). */
  changes_made: string;
};

/** Single structured object serialized into writer / reviewer / formatter calls (no chat transcript). */
export type EditorialState = {
  topic: { title: string; slug: string };
  /** Original SEO audit context that selected this page for rewriting. */
  seo_audit: { summary: string; failing_checks: string; checks_json: string };
  research: string;
  diagnosis_json: string;
  interlink_hints: string;
  /** Latest Markdown body; empty before first writer pass. */
  current_draft_markdown: string;
  revision_notes: RevisionNote[];
};

function serializeEditorialState(state: EditorialState): string {
  return JSON.stringify(state, null, 2);
}

function editorialStateBlock(state: EditorialState): string {
  return `=== EDITORIAL_STATE (structured JSON) ===
${serializeEditorialState(state)}
=== END EDITORIAL_STATE ===

`;
}

async function runDiagnosisAgent(
  cfg: AppConfig,
  input: {
    title: string;
    slug: string;
    summary: string;
    failNotes: string;
    checksJson: string;
    researchNotes: string;
    /** Claude/graph interlink cues — informs rewrite_focus (e.g. internal_links audit). */
    interlinkHints?: string;
  },
): Promise<string> {
  const system = `You are the planning / diagnosis agent between research and writing.
Respond with a single JSON object only, no markdown fences inside (raw JSON).
Schema: { "bullets": string[], "rewrite_focus": string[] }
- bullets: 4–8 concise reasons the page underperforms (SEO audit + research themes).
- rewrite_focus: 3–8 priorities for the writer covering **every important FAIL / weak SEO-GEO check** from checks_json; do NOT copy long verbatim research facts into this JSON—summarize themes only (e.g. "refresh statutory context" not exact euro figures).
- When interlink hints are provided, mention weaving specific internal outbound links naturally if internal linking / crawl depth showed up as weak.

${PUBLICATION_BACKGROUND_FOR_PROMPTS}`;

  const hil =
    typeof input.interlinkHints === 'string' && input.interlinkHints.trim().length > 0
      ? input.interlinkHints.trim().slice(0, 8000)
      : '(none)';

  const user = `Title: ${input.title}
Slug: ${input.slug}
Audit summary: ${input.summary || '(none)'}
Failing checks:
${input.failNotes || '(none)'}

Full checks_json from the original SEO/GEO audit:
${input.checksJson || '{}'}

Internal research themes (may be imperfect—writer must not invent specifics):
${input.researchNotes || '(none)'}

Interlink context (URLs/slugs/anchors—the writer will see full detail again in EDITORIAL_STATE; prioritize in rewrite_focus):
${hil}`;

  const text = await callClaudeText(cfg, system, user, 2500);
  const jsonStr = stripJsonFence(text);
  JSON.parse(jsonStr);
  return jsonStr;
}

function trunc(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function buildCritiqueFromReviewer(r: ReviewerResult, round: number, rewriteAudit: SeoAuditRecord): string {
  const lines = [
    `Round ${round} — approve: ${r.approve}`,
    `Scores: HR ${r.human_readable.score}/5, SEO ${r.seo.score}/100, GEO ${r.geo.score}/100, factual_risk ${r.factual_risk.level}`,
    `rewrite_audit_json:\n${JSON.stringify(
      {
        seo_score: rewriteAudit.seo_score,
        geo_score: rewriteAudit.geo_score,
        summary: rewriteAudit.summary,
        checks: rewriteAudit.checks,
      },
      null,
      2,
    )}`,
    `human_readable: ${trunc(r.human_readable.notes, 900)}`,
    `seo: ${trunc(r.seo.notes, 900)}`,
    `geo: ${trunc(r.geo.notes, 900)}`,
    `factual_risk: ${trunc(r.factual_risk.notes, 900)}`,
    `vs_original improved=${r.vs_original.improved}: ${trunc(r.vs_original.notes, 600)}`,
    r.factual_risk.problem_claims.length
      ? `problem_claims:\n${r.factual_risk.problem_claims.map((x) => `- ${x}`).join('\n')}`
      : 'problem_claims: (none)',
    r.must_fix.length ? `must_fix:\n${r.must_fix.map((x) => `- ${x}`).join('\n')}` : 'must_fix: (none)',
    r.writer_brief ? `writer_brief:\n${r.writer_brief}` : 'writer_brief: (none)',
  ];
  return lines.join('\n');
}

function summarizeWriterRevision(prevMd: string, newMd: string, round: number): string {
  return (
    `Round ${round} writer pass: Markdown length ${prevMd.length} → ${newMd.length} chars. ` +
    `Revised to address revision_notes entry round=${round} (critique must_fix / writer_brief).`
  );
}

function buildWriterMarkdownSystemPrompt(cfg: AppConfig): string {
  const site = (cfg.WP_SITE_URL || process.env.WP_SITE_URL || '').replace(/\/+$/, '');
  const siteLine = site
    ? `WordPress / site base: ${site} (publication should match this context).`
    : 'Match the publication context implied by the source HTML.';

  return `You are the **writer agent** for **https://unabhaengiger-finanzberater.de/** — independent insurance and financial advisory content in German.

${PUBLICATION_BACKGROUND_FOR_PROMPTS}

## Structured state (not chat history)
- The user message contains **EDITORIAL_STATE** as JSON: \`topic\`, \`seo_audit\`, \`research\`, \`diagnosis_json\`, \`interlink_hints\`, \`current_draft_markdown\`, \`revision_notes\`.
- **seo_audit.checks_json is the full original SEO/GEO audit input. You must read it and address all FAIL / weak checks that can be fixed in Markdown body content.** Do not rely only on diagnosis_json summaries.
- **revision_notes** is an ordered list: each item has \`round\`, \`critique\` (reviewer feedback that round), and \`changes_made\`. For **completed** rounds, \`changes_made\` summarizes what the writer did—**do not undo** those without a new critique. The **latest** entry may have an empty \`changes_made\`: that \`critique\` is what you must satisfy **this** turn.
- **current_draft_markdown** is the draft to revise (empty on first pass). Apply every open \`critique\` whose \`changes_made\` is still empty or incomplete; prefer the **latest** round’s must_fix/writer_brief inside that critique when something conflicts.
- Research, diagnosis, and seo_audit are **not** published. Do **not** dump raw research or audit notes into the article; transform them into useful reader-facing improvements. Do **not** invent € amounts unless they appear in **source HTML**.

## Voice
- Professional, calm, **Sie**-Anrede unless the source HTML consistently uses **du** in a section—then stay consistent per section.
- No hype, no throat-clearing filler. No em-dashes (—) for asides; use commas or parentheses.
- Feels human-edited, not keyword-stuffed.

## SEO / GEO (align with dashboard SEO audit)
- Start the Markdown file with YAML front matter so metadata is explicit in the \`.md\` artifact:
  - \`title\`: reader-facing SEO title.
  - \`meta_description\`: 140–160 character SERP-style description.
  - \`slug\`: canonical slug.
  - \`canonical_url\`: canonical URL when the site base is known.
- Strong heading ladder (# / ## / ###), answer-first where natural, solid E-E-A-T.
- Address **all actionable failures** from \`seo_audit.checks_json\` plus diagnosis / research themes—without robotic keyword stuffing.
- CMS/theme-only checks (schema and Core Web Vitals) cannot be fully fixed in Markdown; still support them where possible with snippet-ready intro, clear headings, E-E-A-T/trust copy, and image-alt suggestions in prose only if natural.
- **Internal links**: If **interlink_hints** lists URLs slugs or Markdown link lines, weave in **at least 4** contextual \`[anchor](absolute-url)\` links to relevant related pages—not a footer blob; scatter in body sections where they aid navigation. Omit a suggested URL only if it is genuinely off-topic.
- If hints are sparse, infer 2–4 internal links using the same site's path style as in **SOURCE HTML** (match domain + slug paths from existing anchors in source).

## Template-aware list writing (critical for Elementor rendering)
- When source sections contain icon bullets, keep list intent explicit in Markdown: use short lead sentence/line, then a real bullet list (one point per line), not a merged prose paragraph.
- Preserve semantic tone per section: warning/problem sections should read like risks, benefit/performance sections like positives, add-on/legal sections like supplementary points.
- Keep bullet items concise and parallel so they map cleanly into existing Elementor icon-box slots with their original icon/color styling.
- Preserve source section order and heading intent; do not move "covered" items into exclusion/warning sections or move exclusions into benefits sections.
- Do not invert polarity: "nicht versichert / ausgeschlossen / Voraussetzung" must stay negative wording, while covered benefits remain positive wording.
- Prefer refining existing points over adding many new bullets; only add bullets when truly necessary and in the same section intent.

## Hard rules (anti-hallucination)
- Do **not** add **new** concrete numbers (€, precise claim limits, case numbers) unless they are already in the **source HTML**.
- Do **not** present web-research snippets as the broker’s personal policy terms unless the source article already does.

## Output (mandatory)
Return the **full** revised article as **Markdown only** between these lines:
${MD_START}
---
title: "..."
meta_description: "..."
slug: "..."
canonical_url: "..."
---

# …complete Markdown article…
${MD_END}
Use standard Markdown (# headings, lists, **bold**, [text](url) for links). Include the YAML front matter exactly once at the top. Avoid raw HTML tags unless the source contained essential inline HTML you must preserve (rare).

${siteLine}`;
}

async function runWriterMarkdownAgent(
  cfg: AppConfig,
  input: {
    editorialState: EditorialState;
    originalHtml: string;
    roundLabel: string;
  },
): Promise<string> {
  const maxChars = cfg.REWRITE_MAX_HTML_CHARS;
  if (input.originalHtml.length > maxChars) {
    throw new Error(`Content HTML exceeds REWRITE_MAX_HTML_CHARS (${maxChars}).`);
  }

  const user = `${editorialStateBlock(input.editorialState)}
Task (${input.roundLabel}): Output the **complete** new Markdown article in the delimiters below. The JSON state already contains \`current_draft_markdown\` and \`revision_notes\`—use them.

=== SOURCE HTML (fact baseline; do not invent new specifics) ===
${input.originalHtml}
=== END SOURCE HTML ===

Return full Markdown with ${MD_START} / ${MD_END}.`;

  const text = await callClaudeText(cfg, buildWriterMarkdownSystemPrompt(cfg), user, 16_000);
  return parseMarkdownDelimited(text);
}

function buildReviewerSystemPromptWithThresholds(
  candidateIsMarkdown: boolean,
  thresholds: RewriteAcceptanceThresholds,
): string {
  return `You are the **reviewer agent**. The user message includes **EDITORIAL_STATE** (JSON): topic, research, diagnosis, \`current_draft_markdown\` (the draft under review), and **revision_notes** (prior critiques and what the writer reported changing).

${PUBLICATION_BACKGROUND_FOR_PROMPTS}

You also see **original full-page SEO audit signals** (summary, failing checks, checks_json excerpt), a **Markdown-actionable rewrite audit**, and the **original article HTML** for factual baseline.

Your job: judge whether the Markdown draft is fit to save as the rewrite output, or whether it needs another writer pass.

## SEO / GEO scope for this reviewer pass
You are reviewing a **Markdown artifact**, not final theme HTML.
- Use **REWRITE_MARKDOWN_SEO_AUDIT_JSON** as the scoring source for SEO/GEO. It is already scoped to Markdown-fixable issues.
- Do **not** block approval for final HTML/CMS-only criteria: schema markup implementation, final image selection/alt text, mobile UX, Core Web Vitals, Elementor/theme layout, or final rendered structured data. Mention them only as deferred notes if relevant.
- Do block approval for Markdown-fixable SEO/GEO problems: front matter metadata, title/meta length and uniqueness, heading ladder, answer-first intro, keyword naturalness, internal links, external/source citations, E-E-A-T/trust copy, snippet/FAQ clarity, topical completeness, CTA clarity, and GEO/entity clarity.
- You still must review non-SEO aspects: human readability, factual risk, research/source alignment, and regression vs original.

Respond with **one JSON object only** (no markdown), schema:
{
  "approve": boolean,
  "human_readable": { "score": number, "notes": string },
  "seo": { "score": number, "notes": string },
  "geo": { "score": number, "notes": string },
  "factual_risk": { "level": "low"|"medium"|"high", "notes": string, "problem_claims": string[] },
  "vs_original": { "improved": boolean, "notes": string },
  "must_fix": string[],
  "writer_brief": string
}

Scoring:
- **human_readable.score** is **1–5**: clarity, scannability, tone, undue repetition—not keyword stuffing; align with independent-advisor / transparency positioning where appropriate (see publication context above).
- **seo.score** and **geo.score** are **0–100**, matching the dashboard SEO page scale. Copy the numeric scores from **REWRITE_MARKDOWN_SEO_AUDIT_JSON** exactly. Use notes to explain the concrete Markdown-actionable check failures or improvements.

Rules:
- **approve: true** only when **all** of: vs_original.improved is true (or negligible regression); human_readable.score **≥ ${thresholds.hr}**; seo.score **≥ ${thresholds.seo}**; geo.score **≥ ${thresholds.geo}**; factual_risk is **not** **high**. **Medium** factual_risk can still approve if **problem_claims** are hedged wording or citations that roughly match original/research—not invented law/coverage guarantees.
- **approve: false** when any required gate fails: factual_risk is **high**, human_readable <${thresholds.hr}, seo <${thresholds.seo}, geo <${thresholds.geo}, or the draft clearly regresses vs original.
- **problem_claims**: quoted short phrases from the **revised candidate** (${candidateIsMarkdown ? 'Markdown' : 'HTML'}) that look like new concrete facts (amounts, dates, case numbers, coverage sums) **not** clearly supported by the **original HTML**—flag them.
- **must_fix**: imperative items for the writer; empty if approve. Only include fixes the Markdown writer can perform in this stage, plus factual/research/HR fixes. Do not include deferred final-HTML/CMS work as must_fix.
- **writer_brief**: short paragraph of guidance for the next draft; empty if approve.
- Be strict on hallucinated or over-specific regulatory detail in body copy.`;
}

function normalizeReviewer(raw: Record<string, unknown>): ReviewerResult {
  const hr = raw.human_readable as Record<string, unknown> | undefined;
  const seo = raw.seo as Record<string, unknown> | undefined;
  const geo = raw.geo as Record<string, unknown> | undefined;
  const fr = raw.factual_risk as Record<string, unknown> | undefined;
  const vo = raw.vs_original as Record<string, unknown> | undefined;
  const mustFixRaw = raw.must_fix ?? raw.mustFix;
  const briefRaw = raw.writer_brief ?? raw.writerBrief;
  const levelRaw = String(fr?.level ?? 'medium').toLowerCase();
  const level: ReviewerResult['factual_risk']['level'] =
    levelRaw === 'low' || levelRaw === 'high' ? levelRaw : 'medium';

  return {
    approve: Boolean(raw.approve),
    human_readable: {
      score: Math.min(5, Math.max(1, Number(hr?.score ?? 3))),
      notes: String(hr?.notes ?? ''),
    },
    seo: {
      score: Math.min(100, Math.max(0, Number(seo?.score ?? 65))),
      notes: String(seo?.notes ?? ''),
    },
    geo: {
      score: Math.min(100, Math.max(0, Number(geo?.score ?? 65))),
      notes: String(geo?.notes ?? ''),
    },
    factual_risk: {
      level,
      notes: String(fr?.notes ?? ''),
      problem_claims: Array.isArray(fr?.problem_claims)
        ? (fr.problem_claims as unknown[]).map(String)
        : Array.isArray(fr?.problemClaims)
          ? (fr.problemClaims as unknown[]).map(String)
          : [],
    },
    vs_original: {
      improved: Boolean(vo?.improved ?? true),
      notes: String(vo?.notes ?? ''),
    },
    must_fix: Array.isArray(mustFixRaw) ? mustFixRaw.map(String) : [],
    writer_brief: String(briefRaw ?? ''),
  };
}

async function runReviewerAgent(
  cfg: AppConfig,
  input: {
    title: string;
    slug: string;
    auditSummary: string;
    failNotes: string;
    checksJson: string;
    researchNotes: string;
    originalHtml: string;
    editorialState: EditorialState;
    rewriteAudit: SeoAuditRecord;
    acceptanceThresholds: RewriteAcceptanceThresholds;
    candidateIsMarkdown: boolean;
  },
): Promise<ReviewerResult> {
  const user = `${editorialStateBlock(input.editorialState)}
Title: ${input.title}
Slug: ${input.slug}

SEO audit summary: ${input.auditSummary || '(none)'}
Failing check notes (for context):
${input.failNotes || '(none)'}

checks_json (raw, excerpt if long) — use this to calibrate **seo.score** and **seo.notes**:
${input.checksJson.slice(0, 4000)}

REWRITE_MARKDOWN_SEO_AUDIT_JSON (Markdown-actionable SEO/GEO pipeline run on the candidate Markdown; copy seo_score and geo_score into your JSON scores):
${JSON.stringify(
  {
    seo_score: input.rewriteAudit.seo_score,
    geo_score: input.rewriteAudit.geo_score,
    summary: input.rewriteAudit.summary,
    checks: input.rewriteAudit.checks,
  },
  null,
  2,
).slice(0, 8000)}

Internal research (for hallucination cross-check—not for public paste):
${input.researchNotes.slice(0, 8000)}

The **candidate draft** is \`editorial_state.current_draft_markdown\` inside the JSON block above.

=== ORIGINAL HTML ===
${input.originalHtml.slice(0, 120_000)}
=== END ORIGINAL ===

Return JSON only.`;

  const text = await callClaudeText(
    cfg,
    buildReviewerSystemPromptWithThresholds(input.candidateIsMarkdown, input.acceptanceThresholds),
    user,
    4096,
  );
  let rawObj: Record<string, unknown>;
  try {
    rawObj = JSON.parse(stripJsonFence(text)) as Record<string, unknown>;
  } catch {
    throw new Error(`Reviewer agent returned invalid JSON: ${text.slice(0, 400)}`);
  }
  const normalized = normalizeReviewer(rawObj);
  normalized.seo.score = input.rewriteAudit.seo_score;
  normalized.geo.score = input.rewriteAudit.geo_score;
  if (!normalized.seo.notes.trim()) normalized.seo.notes = input.rewriteAudit.summary ?? '';
  if (!normalized.geo.notes.trim()) normalized.geo.notes = input.rewriteAudit.summary ?? '';
  return normalized;
}

function reviewerLogFields(reviewer: ReviewerResult): Record<string, unknown> {
  return {
    hrNotes: trunc(reviewer.human_readable.notes, 500),
    seoNotes: trunc(reviewer.seo.notes, 500),
    geoNotes: trunc(reviewer.geo.notes, 500),
    factualNotes: trunc(reviewer.factual_risk.notes, 500),
    vsOriginalNotes: trunc(reviewer.vs_original.notes, 400),
    problemClaimsSample: reviewer.factual_risk.problem_claims.slice(0, 5),
  };
}

function htmlConversionTraceContext(trace: OrchestratorTrace): string {
  return JSON.stringify(
    {
      final_approved: trace.final_approved,
      soft_approved: trace.soft_approved ?? false,
      acceptance_thresholds: trace.acceptance_thresholds,
      rounds: trace.rounds.map((r) => ({
        round: r.round,
        revised: r.revised,
        markdown_audit: {
          seo_score: r.rewrite_audit.seo_score,
          geo_score: r.rewrite_audit.geo_score,
          summary: r.rewrite_audit.summary,
          failing_checks: Object.fromEntries(
            Object.entries(r.rewrite_audit.checks).filter(([, v]) => v.status === 'FAIL'),
          ),
        },
        reviewer: {
          approve: r.reviewer.approve,
          human_readable: r.reviewer.human_readable,
          seo: r.reviewer.seo,
          geo: r.reviewer.geo,
          factual_risk: r.reviewer.factual_risk,
          vs_original: r.reviewer.vs_original,
          must_fix: r.reviewer.must_fix,
          writer_brief: r.reviewer.writer_brief,
        },
      })),
    },
    null,
    2,
  );
}

function buildHtmlConversionSystemPrompt(cfg: AppConfig): string {
  const site = (cfg.WP_SITE_URL || process.env.WP_SITE_URL || '').replace(/\/+$/, '');
  const siteLine = site ? `Site base: ${site}. Use it for canonical/internal URL consistency.` : '';
  return `You are the **HTML conversion writer** for a German YMYL financial advisory article.

${PUBLICATION_BACKGROUND_FOR_PROMPTS}

Your job is **not to review the article again**. The Markdown article was already reviewed for content quality, HR, factual risk, Markdown SEO, and GEO. Your job is to transform that accepted Markdown into basic SEO-optimized HTML while preserving the accepted content and keeping all prior SEO/reviewer decisions intact.

Inputs you will receive:
- ACCEPTED_MARKDOWN: source of truth for body copy and metadata.
- ORIGINAL_SEO_CONTEXT: original audit summary, failing checks, and checks_json.
- REVIEWER_AND_MARKDOWN_AUDIT_CONTEXT: all reviewer rounds and Markdown SEO/GEO audit points.

Conversion rules:
- Preserve the accepted Markdown's meaning, claims, tone, section order, headings, internal links, and reviewer-approved fixes.
- Do not introduce new facts, numbers, legal claims, coverage guarantees, or marketing hype.
- Convert YAML front matter into HTML SEO primitives: <title>, <meta name="description">, <link rel="canonical"> when present, and a slug meta/comment only if useful.
- Produce a complete basic HTML document: <!doctype html>, <html lang="de">, <head>, <body>, one semantic <article>.
- Use clean semantic HTML: h1-h4, p, ul/ol/li, strong, em, a, blockquote where appropriate.
- Preserve all Markdown links as <a href="..."> with their anchor text. Do not create a footer blob of links.
- Address full-page SEO/GEO concerns that are possible in basic HTML: metadata, canonical, semantic heading structure, internal links, answer-first intro, Article JSON-LD, and FAQPage JSON-LD only when the accepted Markdown has explicit FAQ-style Q&A content.
- You may add non-visible structured data derived from the accepted Markdown metadata and headings, but do not add visible body claims that are not in the Markdown.
- Do not add styling, theme classes, scripts other than JSON-LD, tracking pixels, forms, or CMS-specific Elementor markup.

Output:
Return the complete HTML only between:
${HTML_START}
...html...
${HTML_END}

${siteLine}`;
}

export async function runSeoHtmlConversionAgent(
  cfg: AppConfig,
  input: {
    slug: string;
    title: string;
    markdown: string;
    auditSummary: string;
    failNotes: string;
    checksJson: string;
    trace: OrchestratorTrace;
  },
): Promise<string> {
  const user = `Article slug: ${input.slug}
Article title: ${input.title}

=== ACCEPTED_MARKDOWN (source of truth) ===
${input.markdown}
=== END ACCEPTED_MARKDOWN ===

=== ORIGINAL_SEO_CONTEXT ===
summary:
${input.auditSummary || '(none)'}

failing_checks:
${input.failNotes || '(none)'}

checks_json:
${input.checksJson.slice(0, 12_000)}
=== END ORIGINAL_SEO_CONTEXT ===

=== REVIEWER_AND_MARKDOWN_AUDIT_CONTEXT ===
${htmlConversionTraceContext(input.trace).slice(0, 20_000)}
=== END REVIEWER_AND_MARKDOWN_AUDIT_CONTEXT ===

Convert the accepted Markdown into basic SEO-optimized HTML. Do not run or simulate a reviewer. Return only delimited HTML.`;

  const text = await callClaudeText(cfg, buildHtmlConversionSystemPrompt(cfg), user, 16_000);
  return parseHtmlDelimited(text);
}

/**
 * Orchestrator: **EditorialState** JSON passed to each agent; revision_notes accumulate critiques + changes_made.
 */
export async function runOrchestratedArticleRewrite(
  cfg: AppConfig,
  params: {
    slug: string;
    title: string;
    excerpt: string;
    contentSnippet: string;
    auditSummary: string;
    failNotes: string;
    checksJson: string;
    originalHtml: string;
    interlinkHints: string;
    acceptanceThresholds: RewriteAcceptanceThresholds;
    /** Live progress for dashboard UI (orchestrator / agent stages). */
    onProgress?: (ev: { stage: string; message: string }) => void;
  },
): Promise<{ markdown: string; researchNotes: string; diagnosisJson: string; trace: OrchestratorTrace }> {
  const onP = params.onProgress;
  const researchInput: ResearchAgentInput = {
    slug: params.slug,
    title: params.title,
    excerpt: params.excerpt,
    contentSnippet: params.contentSnippet,
    auditSummary: params.auditSummary,
    failNotes: params.failNotes,
    checksJson: params.checksJson,
  };
  emitProgress(onP, 'research', 'Research agent: web search and internal notes…');
  const researchNotes = await runAnthropicWebResearch(cfg, researchInput);
  emitProgress(onP, 'research', 'Research agent: done');

  const state: EditorialState = {
    topic: { title: params.title, slug: params.slug },
    seo_audit: {
      summary: params.auditSummary,
      failing_checks: params.failNotes,
      checks_json: params.checksJson,
    },
    research: researchNotes,
    diagnosis_json: '',
    interlink_hints: params.interlinkHints,
    current_draft_markdown: '',
    revision_notes: [],
  };

  emitProgress(onP, 'diagnosis', 'Planning agent: diagnosis and rewrite focus (JSON)…');
  const diagnosisJson = await runDiagnosisAgent(cfg, {
    title: params.title,
    slug: params.slug,
    summary: params.auditSummary,
    failNotes: params.failNotes,
    checksJson: params.checksJson,
    researchNotes,
    interlinkHints: params.interlinkHints,
  });
  emitProgress(onP, 'diagnosis', 'Planning agent: done');
  state.diagnosis_json = diagnosisJson;

  emitProgress(onP, 'writer', 'Writer (Markdown): initial draft…');
  let md = await runWriterMarkdownAgent(cfg, {
    editorialState: state,
    originalHtml: params.originalHtml,
    roundLabel: 'initial draft',
  });
  state.current_draft_markdown = md;
  emitProgress(onP, 'writer', 'Writer (Markdown): initial draft ready');

  const maxReviews = Math.max(1, Math.min(8, cfg.REWRITE_MAX_REVIEW_ROUNDS ?? 6));
  const thresholds = params.acceptanceThresholds;
  const trace: OrchestratorTrace = {
    review_rounds: maxReviews,
    final_approved: false,
    acceptance_thresholds: thresholds,
    rounds: [],
  };

  for (let r = 1; r <= maxReviews; r++) {
    if (cfg.REWRITE_PAUSE_MS > 0) await new Promise((res) => setTimeout(res, cfg.REWRITE_PAUSE_MS));

    emitProgress(onP, 'seo-audit', `Markdown SEO/GEO audit: round ${r}/${maxReviews}…`);
    const rewriteAudit = await auditSeoMarkdownContent(cfg, {
      slug: params.slug,
      title: params.title,
      bodyText: state.current_draft_markdown,
    });
    emitProgress(
      onP,
      'seo-audit',
      `Markdown SEO/GEO audit: SEO ${rewriteAudit.seo_score}/100, GEO ${rewriteAudit.geo_score}/100`,
    );

    emitProgress(onP, 'reviewer', `Reviewer (Markdown): round ${r}/${maxReviews}…`);
    const reviewer = await runReviewerAgent(cfg, {
      title: params.title,
      slug: params.slug,
      auditSummary: params.auditSummary,
      failNotes: params.failNotes,
      checksJson: params.checksJson,
      researchNotes,
      originalHtml: params.originalHtml,
      editorialState: state,
      rewriteAudit,
      acceptanceThresholds: thresholds,
      candidateIsMarkdown: true,
    });

    const passesThresholds = meetsAcceptanceThresholds(reviewer, thresholds);
    const accepted = reviewer.approve && passesThresholds;
    const revised = !accepted && r < maxReviews;
    trace.rounds.push({ round: r, rewrite_audit: rewriteAudit, reviewer, revised });

    const hr = reviewer.human_readable.score;
    const seo = reviewer.seo.score;
    const geo = reviewer.geo.score;
    const risk = reviewer.factual_risk.level;
    const noteTail = [
      reviewer.human_readable.notes.trim() ? `Readability: ${trunc(reviewer.human_readable.notes, 140)}` : '',
      reviewer.seo.notes.trim() ? `SEO: ${trunc(reviewer.seo.notes, 140)}` : '',
      reviewer.geo.notes.trim() ? `GEO: ${trunc(reviewer.geo.notes, 120)}` : '',
      reviewer.factual_risk.notes.trim() ? `Facts: ${trunc(reviewer.factual_risk.notes, 120)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const softPass = !accepted && r === maxReviews && passesThresholds;
    if (softPass) {
      log.info({ slug: params.slug, reviewRound: r }, 'rewrite: final-round soft-approve (scores OK, model held approve)');
    }

    if (accepted) {
      emitProgress(
        onP,
        'reviewer',
        `Reviewer: Markdown approved — HR ${hr}/5, SEO ${seo}/100, GEO ${geo}/100, risk ${risk}${noteTail ? ` — ${noteTail}` : ''}`,
      );
    } else if (softPass) {
      emitProgress(
        onP,
        'reviewer',
        `Reviewer: accepted on last round (soft) — HR ${hr}/5, SEO ${seo}/100, GEO ${geo}/100, risk ${risk}${noteTail ? ` — ${noteTail}` : ''}`,
      );
    } else if (revised) {
      emitProgress(
        onP,
        'reviewer',
        `Reviewer: Markdown revision — ${reviewer.must_fix.length} must-fix; HR ${hr}/5, SEO ${seo}/100, GEO ${geo}/100, risk ${risk}${noteTail ? ` — ${noteTail}` : ''}`,
      );
    } else {
      emitProgress(
        onP,
        'reviewer',
        `Reviewer: no further MD revision (HR ${hr}/5, SEO ${seo}/100, GEO ${geo}/100, risk ${risk})${noteTail ? ` — ${noteTail}` : ''}`,
      );
    }

    log.info(
      {
        slug: params.slug,
        reviewRound: r,
        candidateFormat: 'markdown',
        approve: accepted || softPass,
        factualRisk: reviewer.factual_risk?.level,
        hrScore: reviewer.human_readable?.score,
        seoScore: reviewer.seo?.score,
        geoScore: reviewer.geo?.score,
        vsImproved: reviewer.vs_original.improved,
        ...reviewerLogFields(reviewer),
      },
      'reviewer agent',
    );

    if (accepted || softPass) {
      trace.final_approved = true;
      trace.soft_approved = softPass;
      break;
    }

    if (!revised) break;

    const prevMd = state.current_draft_markdown;
    state.revision_notes.push({
      round: r,
      critique: buildCritiqueFromReviewer(reviewer, r, rewriteAudit),
      changes_made: '',
    });

    emitProgress(onP, 'writer', `Writer (Markdown): revision after review ${r}…`);
    md = await runWriterMarkdownAgent(cfg, {
      editorialState: state,
      originalHtml: params.originalHtml,
      roundLabel: `revision after review ${r}`,
    });
    state.current_draft_markdown = md;
    const lastNote = state.revision_notes[state.revision_notes.length - 1];
    if (lastNote) lastNote.changes_made = summarizeWriterRevision(prevMd, md, r);
    emitProgress(onP, 'writer', `Writer (Markdown): revision ${r} ready`);
  }

  if (!trace.final_approved) {
    emitProgress(
      onP,
      'reviewer',
      'Crew: using last Markdown draft — reviewer did not fully approve MD (human QA recommended)',
    );
    log.warn({ slug: params.slug, rounds: trace.rounds.length }, 'rewrite finished without reviewer approval—using last draft');
  } else if (trace.soft_approved) {
    emitProgress(
      onP,
      'reviewer',
      'Crew: final draft passed score gates (meta/schema may still be CMS-side)',
    );
  }

  return { markdown: md, researchNotes, diagnosisJson, trace };
}
