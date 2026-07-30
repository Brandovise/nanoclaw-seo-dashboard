/**
 * Interlinking analysis: WordPress link graph → orphan / weak pages + optional Claude suggestions.
 * Replaces the external `interlinking_agent.py` flow for graph + API; markdown `--apply` remains out-of-band.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { sqlWpTypesDashboardClause } from './wp-dashboard-types.js';
import { log } from './logger.js';
import { getWpGraph } from './wordpress-sync.js';

export type IlPublicNode = {
  id: string;
  title: string;
  category: string;
  inbound: number;
  outbound: number;
  /** Lowercase WP types for this slug (e.g. post, page). */
  wpTypes: string[];
  /** Human-readable type label for badges. */
  wpTypeLabel: string;
};

export type IlSuggestion = {
  inbound: Array<{
    source_slug: string;
    anchor_text: string;
    placement_hint: string;
  }>;
  outbound: Array<{
    target_slug: string;
    anchor_text: string;
    placement_hint: string;
  }>;
};

function ensureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interlinking_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      suggestions_json TEXT NOT NULL DEFAULT '{}',
      last_run_at TEXT,
      graph_touch_at TEXT
    );
  `);
}

/** Ensure `interlinking_state` exists (e.g. fresh dashboard DB after reset). */
export function bootstrapInterlinkingSchema(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    ensureTables(db);
  } finally {
    db.close();
  }
}

function openDashboardRw(cfg: AppConfig): Database.Database {
  fs.mkdirSync(path.dirname(cfg.DASHBOARD_SQLITE_PATH), { recursive: true });
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  ensureTables(db);
  return db;
}

export function suggestionHasContent(s: IlSuggestion | undefined): boolean {
  if (!s) return false;
  const ins = Array.isArray(s.inbound) ? s.inbound.length : 0;
  const outs = Array.isArray(s.outbound) ? s.outbound.length : 0;
  return ins + outs > 0;
}

function readSuggestions(db: Database.Database): Record<string, IlSuggestion> {
  const row = db.prepare('SELECT suggestions_json FROM interlinking_state WHERE id = 1').get() as
    | { suggestions_json: string }
    | undefined;
  if (!row?.suggestions_json) return {};
  try {
    const o = JSON.parse(row.suggestions_json) as Record<string, IlSuggestion>;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeSuggestions(db: Database.Database, sug: Record<string, IlSuggestion>, lastRun: string): void {
  db.prepare(
    `INSERT INTO interlinking_state (id, suggestions_json, last_run_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET suggestions_json = excluded.suggestions_json, last_run_at = excluded.last_run_at`,
  ).run(JSON.stringify(sug), lastRun);
}

function touchGraph(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO interlinking_state (id, graph_touch_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET graph_touch_at = excluded.graph_touch_at`,
  ).run(now);
}

type RawGNode = {
  id: string;
  slug?: string;
  label?: string;
  category?: string;
  /** WordPress REST type (post, page, …). */
  type?: string;
};

function formatWpTypeLabel(types: Set<string>): { wpTypes: string[]; wpTypeLabel: string } {
  const raw = [...types].map((t) => (t || 'post').trim().toLowerCase() || 'post');
  const uniq = [...new Set(raw.length ? raw : ['post'])].sort();
  const wpTypes = uniq;
  const wpTypeLabel = uniq.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' · ');
  return { wpTypes, wpTypeLabel };
}

/** Build slug-keyed nodes and degree counts (merges multiple WP keys that share the same slug). */
export function buildInterlinkingFromWpGraph(): {
  stats: {
    totalNodes: number;
    totalLinks: number;
    orphanNodes: number;
    avgLinksPerNode: number;
  };
  orphans: IlPublicNode[];
  noInbound: IlPublicNode[];
  weakInbound: IlPublicNode[];
  allNodes: IlPublicNode[];
  linkGraph: {
    nodes: IlPublicNode[];
    links: Array<{ source: string; target: string }>;
  };
} {
  const g = getWpGraph();
  const edges = g.edges as Array<{ source: string; target: string }>;
  const nodes = g.nodes as RawGNode[];

  const inDeg: Record<string, number> = {};
  const outDeg: Record<string, number> = {};
  for (const n of nodes) {
    inDeg[n.id] = 0;
    outDeg[n.id] = 0;
  }
  for (const e of edges) {
    if (outDeg[e.source] === undefined) outDeg[e.source] = 0;
    if (inDeg[e.target] === undefined) inDeg[e.target] = 0;
    outDeg[e.source] = (outDeg[e.source] || 0) + 1;
    inDeg[e.target] = (inDeg[e.target] || 0) + 1;
  }

  const keyToSlug = new Map<string, string>();
  const slugToKeys = new Map<string, string[]>();
  for (const n of nodes) {
    const slug = ((n.slug || '').trim() || n.id).trim();
    keyToSlug.set(n.id, slug);
    if (!slugToKeys.has(slug)) slugToKeys.set(slug, []);
    slugToKeys.get(slug)!.push(n.id);
  }

  const slugToMeta = new Map<
    string,
    { title: string; category: string; typeSet: Set<string> }
  >();
  for (const n of nodes) {
    const slug = keyToSlug.get(n.id)!;
    const wpt = (typeof n.type === 'string' ? n.type : 'post').trim().toLowerCase() || 'post';
    if (!slugToMeta.has(slug)) {
      slugToMeta.set(slug, {
        title: String(n.label || n.slug || slug),
        category: typeof n.category === 'string' ? n.category : 'uncategorized',
        typeSet: new Set(),
      });
    }
    slugToMeta.get(slug)!.typeSet.add(wpt);
  }

  const allNodes: IlPublicNode[] = [];
  for (const [slug, keys] of slugToKeys) {
    const meta = slugToMeta.get(slug)!;
    const { wpTypes, wpTypeLabel } = formatWpTypeLabel(meta.typeSet);
    let inbound = 0;
    let outbound = 0;
    for (const k of keys) {
      inbound += inDeg[k] ?? 0;
      outbound += outDeg[k] ?? 0;
    }
    allNodes.push({
      id: slug,
      title: meta.title,
      category: meta.category,
      inbound,
      outbound,
      wpTypes,
      wpTypeLabel,
    });
  }

  const orphans = allNodes.filter((n) => n.inbound === 0 && n.outbound === 0);
  const noInbound = allNodes.filter((n) => n.inbound === 0 && n.outbound > 0);
  const weakInbound = allNodes.filter((n) => n.inbound > 0 && n.inbound < 2);
  const totalLinks = edges.length;
  const totalNodes = allNodes.length;
  const sumDeg = allNodes.reduce((s, n) => s + n.inbound + n.outbound, 0);
  const avgLinksPerNode = totalNodes > 0 ? Math.round((sumDeg / totalNodes) * 10) / 10 : 0;
  const orphanNodes = orphans.length;

  const links = edges.map((e) => ({
    source: keyToSlug.get(e.source) || e.source,
    target: keyToSlug.get(e.target) || e.target,
  }));

  return {
    stats: { totalNodes, totalLinks, orphanNodes, avgLinksPerNode },
    orphans,
    noInbound,
    weakInbound,
    allNodes,
    linkGraph: { nodes: allNodes.map((n) => ({ ...n })), links },
  };
}

function loadGscPerformance(days: number): Record<string, number> {
  const envPath = process.env.BLOG_PERFORMANCE_DB?.trim();
  const p = envPath ? path.resolve(envPath) : path.join(os.homedir(), '.nanoclaw', 'blog_performance.db');
  if (!fs.existsSync(p)) return {};
  try {
    const db = new Database(p, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT slug, SUM(clicks) as total_clicks
         FROM blog_performance
         WHERE snapshot_date >= date('now', ?)
         GROUP BY slug
         ORDER BY total_clicks DESC`,
      )
      .all(`-${days} days`) as Array<{ slug: string; total_clicks: number }>;
    db.close();
    const o: Record<string, number> = {};
    for (const r of rows) o[r.slug] = r.total_clicks;
    return o;
  } catch (e) {
    log.warn({ err: e }, 'interlinking GSC perf DB read failed');
    return {};
  }
}

type WpRowCtx = {
  slug: string;
  title: string;
  seotitle: string;
  categoryurl: string;
  seodescription: string;
  headings: string[];
};

function extractHeadingsFromText(text: string, max = 8): string[] {
  const out: string[] = [];
  const re = /^##\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    out.push(m[1]!.trim());
  }
  return out;
}

function firstCategoryName(categoriesJson: string): string {
  try {
    const arr = JSON.parse(categoriesJson || '[]') as Array<{ name?: string }>;
    return arr[0]?.name || '';
  } catch {
    return '';
  }
}

function hasWpArticlesTable(db: Database.Database): boolean {
  try {
    const r = db
      .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='wp_articles' LIMIT 1`)
      .get() as { x: number } | undefined;
    return Boolean(r);
  } catch {
    return false;
  }
}

function getWpArticleContext(db: Database.Database, slug: string): WpRowCtx | null {
  if (!hasWpArticlesTable(db)) return null;
  const row = db
    .prepare(
      `SELECT slug, title, excerpt, categories_json, content_text FROM wp_articles WHERE slug = ? AND ${sqlWpTypesDashboardClause()} ORDER BY CASE WHEN wp_type = 'page' THEN 0 ELSE 1 END LIMIT 1`,
    )
    .get(slug) as
    | {
        slug: string;
        title: string | null;
        excerpt: string | null;
        categories_json: string | null;
        content_text: string | null;
      }
    | undefined;
  if (!row) return null;
  const text = row.content_text || '';
  return {
    slug: row.slug,
    title: row.title || row.slug,
    seotitle: row.title || row.slug,
    categoryurl: firstCategoryName(row.categories_json || '[]'),
    seodescription: row.excerpt || '',
    headings: extractHeadingsFromText(text),
  };
}

/**
 * Target article + ranked candidate neighbours for Claude interlinking.
 * Used by batch job (`/api/blog/interlinking/run`) and on-demand during content rewrite when no saved suggestion exists.
 */
function collectInterlinkCandidatesForSlug(
  slug: string,
  built: ReturnType<typeof buildInterlinkingFromWpGraph>,
  wpDb: Database.Database,
  perf: Record<string, number>,
): { info: WpRowCtx; candidates: WpRowCtx[] } | null {
  const allNodeList = built.allNodes;
  const nodeKnown = allNodeList.find((n) => n.id === slug);
  const info = getWpArticleContext(wpDb, slug);
  if (!info) return null;
  const anchorNode = nodeKnown ?? {
    id: slug,
    title: info.title,
    category: info.categoryurl || 'uncategorized',
    inbound: 0,
    outbound: 0,
    wpTypes: [] as string[],
    wpTypeLabel: 'Post',
  };
  const cat = info.categoryurl || anchorNode.category;
  const sameCat: WpRowCtx[] = [];
  const otherCat: WpRowCtx[] = [];
  for (const n of allNodeList) {
    if (n.id === slug) continue;
    const row: WpRowCtx = (() => {
      const ctx = getWpArticleContext(wpDb, n.id);
      if (ctx) return ctx;
      return {
        slug: n.id,
        title: n.title,
        seotitle: n.title,
        categoryurl: n.category,
        seodescription: '',
        headings: [],
      };
    })();
    const rcat = row.categoryurl || n.category;
    if (rcat === cat) sameCat.push(row);
    else otherCat.push(row);
  }
  sameCat.sort((a, b) => (perf[b.slug] || 0) - (perf[a.slug] || 0));
  otherCat.sort((a, b) => (perf[b.slug] || 0) - (perf[a.slug] || 0));
  const candidates = [...sameCat, ...otherCat].slice(0, 40);
  return { info, candidates };
}

/**
 * Ensures Claude interlink inbound/outbound suggestions exist for **slug** — returns cached DB row when present,
 * otherwise calls Anthropic, merges into `interlinking_state`, and returns fresh suggestions (or null on skip/failure).
 * Used by rewrite pipeline when `interlink_state` lacks this slug but `ANTHROPIC_API_KEY` is set.
 */
export async function ensureInterlinkSuggestionsForSlug(cfg: AppConfig, slug: string): Promise<IlSuggestion | null> {
  const s = typeof slug === 'string' ? slug.trim() : '';
  if (!s) return null;
  if (!anthropicKey(cfg)) {
    log.info({ slug: s }, 'interlink ensure: skipped (no ANTHROPIC_API_KEY)');
    return null;
  }
  const rw = openDashboardRw(cfg);
  try {
    const merged = readSuggestions(rw);
    if (suggestionHasContent(merged[s])) {
      return merged[s];
    }

    const built = buildInterlinkingFromWpGraph();
    const perf = loadGscPerformance(60);
    const pack = collectInterlinkCandidatesForSlug(s, built, rw, perf);
    if (!pack || pack.candidates.length === 0) {
      log.info({ slug: s }, 'interlink ensure: no candidates (WP graph empty or lone page)');
      return null;
    }

    let sug: IlSuggestion;
    try {
      sug = await suggestInterlinksAnthropic(cfg, pack.info, pack.candidates, perf);
    } catch (err) {
      log.warn({ err, slug: s }, 'interlink ensure: Claude call failed');
      return null;
    }
    if (!suggestionHasContent(sug)) {
      log.info({ slug: s }, 'interlink ensure: Claude returned empty suggestions');
      return null;
    }
    merged[s] = sug;
    writeSuggestions(rw, merged, new Date().toISOString());
    log.info({ slug: s, outbound: sug.outbound?.length ?? 0, inbound: sug.inbound?.length ?? 0 }, 'interlink ensure: saved for rewrite');
    return sug;
  } finally {
    rw.close();
  }
}

function anthropicKey(cfg: AppConfig): string | undefined {
  const k = cfg.ANTHROPIC_API_KEY?.trim();
  return k || undefined;
}

function interlinkModel(cfg: AppConfig): string {
  return (
    process.env.INTERLINKING_MODEL?.trim() ||
    cfg.SEO_AUDIT_MODEL ||
    process.env.SEO_AUDIT_MODEL ||
    'claude-sonnet-4-20250514'
  );
}

async function suggestInterlinksAnthropic(
  cfg: AppConfig,
  target: WpRowCtx,
  candidates: WpRowCtx[],
  performance: Record<string, number>,
): Promise<IlSuggestion> {
  const key = anthropicKey(cfg);
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const catLines: string[] = [];
  for (const c of candidates.slice(0, 40)) {
    const h2s = c.headings.slice(0, 3).join(', ');
    const clicks = performance[c.slug] || 0;
    const perfTag = clicks ? `  [GSC: ${clicks} clicks]` : '';
    catLines.push(`- ${c.slug}: "${c.seotitle || c.title}"  headings: ${h2s}${perfTag}`);
  }
  const catalogue = catLines.join('\n');

  const targetTitle = target.seotitle || target.title;
  const targetH2s = target.headings.slice(0, 5).join(', ');
  const siteHint = process.env.INTERLINKING_SITE_LABEL || 'this site';

  const user = `You are an SEO specialist for ${siteHint}.

TARGET ARTICLE (has no or very few incoming internal links):
  slug:        ${target.slug}
  title:       ${targetTitle}
  category:    ${target.categoryurl}
  description: ${target.seodescription}
  H2 headings: ${targetH2s}

EXISTING ARTICLES (candidate sources, [GSC: N clicks] = Google Search clicks in last ~60 days where data exists):
${catalogue}

Provide two lists:
1. INBOUND: which existing articles should add a link TO the target article.
   Prefer HIGH-TRAFFIC articles (more GSC clicks) as sources.
2. OUTBOUND: which articles the target article should link OUT to.

Rules:
- Only suggest links that add genuine value to the reader
- Anchor text must be descriptive (never "click here" / "read more")
- 3–5 suggestions per list maximum
- For inbound suggestions, prefer articles with [GSC: clicks] over zero-traffic articles

JSON only:
{
  "inbound": [
    {"source_slug": "...", "anchor_text": "...", "placement_hint": "one sentence"}
  ],
  "outbound": [
    {"target_slug": "...", "anchor_text": "...", "placement_hint": "one sentence"}
  ]
}`;

  const model = interlinkModel(cfg);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text?.trim() ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]!) as IlSuggestion;
      return {
        inbound: Array.isArray(parsed.inbound) ? parsed.inbound : [],
        outbound: Array.isArray(parsed.outbound) ? parsed.outbound : [],
      };
    } catch {
      /* fallthrough */
    }
  }
  return { inbound: [], outbound: [] };
}

const ilState = {
  running: false,
  processed: 0,
  total: 0,
  lastMessage: null as string | null,
};

let ilJob: Promise<void> | null = null;

export type InterlinkingProblemScope = 'orphans' | 'no-inbound' | 'weak' | 'all';

export function getInterlinkingRunState() {
  return { ...ilState };
}

export type InterlinkingWpTypeFilter = 'all' | 'post' | 'page';

/** Targets for Claude: one problem bucket (or all), optionally posts-only or pages-only. */
export function buildInterlinkingTargets(
  built: ReturnType<typeof buildInterlinkingFromWpGraph>,
  scope: InterlinkingProblemScope,
  wpType: InterlinkingWpTypeFilter,
): IlPublicNode[] {
  const byId = new Map<string, IlPublicNode>();
  const add = (arr: IlPublicNode[]) => {
    for (const n of arr) byId.set(n.id, n);
  };
  if (scope === 'orphans') add(built.orphans);
  else if (scope === 'no-inbound') add(built.noInbound);
  else if (scope === 'weak') add(built.weakInbound);
  else {
    add(built.orphans);
    add(built.noInbound);
    add(built.weakInbound);
  }
  let out = [...byId.values()];
  if (wpType !== 'all') {
    out = out.filter((n) => (n.wpTypes || []).includes(wpType));
  }
  const rank = (n: IlPublicNode) => {
    if (n.inbound === 0 && n.outbound === 0) return 0;
    if (n.inbound === 0 && n.outbound > 0) return 1;
    return 2;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return out;
}

export function getInterlinkingPayload(cfg: AppConfig): {
  stats: ReturnType<typeof buildInterlinkingFromWpGraph>['stats'];
  orphans: IlPublicNode[];
  noInbound: IlPublicNode[];
  weakInbound: IlPublicNode[];
  /** Every article node in link graph — use to resolve suggestion slugs outside problem buckets (e.g. rewrite on-demand). */
  fullGraphNodes: IlPublicNode[];
  suggestions: Record<string, IlSuggestion>;
  lastRun: string | null;
  lastGraphUpdated: string | null;
  siteUrl: string;
  processedCount: number;
  slugTypes: Record<string, { wpTypes: string[]; wpTypeLabel: string }>;
} {
  const built = buildInterlinkingFromWpGraph();
  let suggestions: Record<string, IlSuggestion> = {};
  let lastRun: string | null = null;
  let lastGraphUpdated: string | null = null;
  if (fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
    const db = openDashboardRw(cfg);
    try {
      suggestions = readSuggestions(db);
      const meta = db.prepare('SELECT last_run_at, graph_touch_at FROM interlinking_state WHERE id = 1').get() as
        | { last_run_at: string | null; graph_touch_at: string | null }
        | undefined;
      lastRun = meta?.last_run_at || null;
      lastGraphUpdated = meta?.graph_touch_at || null;
    } finally {
      db.close();
    }
  }
  let processedCount = 0;
  for (const k of Object.keys(suggestions)) {
    if (suggestionHasContent(suggestions[k])) processedCount += 1;
  }
  const siteUrl = (cfg.WP_SITE_URL || process.env.WP_SITE_URL || '').replace(/\/+$/, '');
  const slugTypes: Record<string, { wpTypes: string[]; wpTypeLabel: string }> = {};
  for (const n of built.allNodes) {
    slugTypes[n.id] = { wpTypes: n.wpTypes, wpTypeLabel: n.wpTypeLabel };
  }
  return {
    stats: built.stats,
    orphans: built.orphans,
    noInbound: built.noInbound,
    weakInbound: built.weakInbound,
    fullGraphNodes: built.allNodes,
    suggestions,
    lastRun,
    lastGraphUpdated,
    siteUrl,
    processedCount,
    slugTypes,
  };
}

/** Shape compatible with legacy `interlinking_agent.py` / `/api/blog/link-graph` consumers. */
export function getLinkGraphCompatPayload(): {
  nodes: IlPublicNode[];
  links: Array<{ source: string; target: string }>;
  stats: {
    totalNodes: number;
    totalLinks: number;
    orphanNodes: number;
    avgLinksPerNode: number;
  };
} {
  const b = buildInterlinkingFromWpGraph();
  return {
    nodes: b.linkGraph.nodes,
    links: b.linkGraph.links,
    stats: b.stats,
  };
}

export function invalidateInterlinkingGraphTouch(cfg: AppConfig): void {
  const db = openDashboardRw(cfg);
  try {
    touchGraph(db);
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SCOPES: InterlinkingProblemScope[] = ['orphans', 'no-inbound', 'weak', 'all'];

function normalizeProblemScope(raw: string | undefined): InterlinkingProblemScope {
  const s = (raw || 'all').trim();
  return SCOPES.includes(s as InterlinkingProblemScope) ? (s as InterlinkingProblemScope) : 'all';
}

const WP_TYPES: InterlinkingWpTypeFilter[] = ['all', 'post', 'page'];

function normalizeWpTypeFilter(raw: string | undefined): InterlinkingWpTypeFilter {
  const s = (raw || 'all').trim().toLowerCase();
  return WP_TYPES.includes(s as InterlinkingWpTypeFilter) ? (s as InterlinkingWpTypeFilter) : 'all';
}

export function startInterlinkingSuggestionsJob(
  cfg: AppConfig,
  opts: {
    limit: number;
    resume?: boolean;
    problemScope?: string;
    wpType?: string;
  },
): { started: boolean; message: string } {
  if (ilJob || ilState.running) {
    return { started: false, message: 'Interlinking suggestion job is already running.' };
  }
  if (!anthropicKey(cfg)) {
    return {
      started: false,
      message: 'ANTHROPIC_API_KEY is not configured. Add it to .env and restart the dashboard API.',
    };
  }

  const cap = Math.min(50, Math.max(1, opts.limit));
  const resume = opts.resume !== false;
  const problemScope = normalizeProblemScope(opts.problemScope);
  const wpTypeFilter = normalizeWpTypeFilter(opts.wpType);

  const built = buildInterlinkingFromWpGraph();
  let targets = buildInterlinkingTargets(built, problemScope, wpTypeFilter);

  if (targets.length === 0) {
    const scopeLabel = problemScope === 'all' ? 'problem pages' : problemScope.replace(/-/g, ' ');
    const typeHint = wpTypeFilter !== 'all' ? ` (type: ${wpTypeFilter})` : '';
    return {
      started: false,
      message: `No ${scopeLabel}${typeHint} in the WordPress link graph. Adjust Problem / WP type filters below or run WP sync.`,
    };
  }

  const dbPreview = openDashboardRw(cfg);
  let mergedPreview: Record<string, IlSuggestion>;
  try {
    mergedPreview = readSuggestions(dbPreview);
  } finally {
    dbPreview.close();
  }

  let limited: typeof targets;
  let skippedExisting = 0;
  if (resume) {
    const pending = targets.filter((t) => !suggestionHasContent(mergedPreview[t.id]));
    skippedExisting = targets.length - pending.length;
    limited = pending.slice(0, cap);
  } else {
    limited = targets.slice(0, cap);
  }

  if (limited.length === 0) {
    return {
      started: false,
      message:
        skippedExisting > 0
          ? `Every prioritized page already has saved suggestions (${skippedExisting} skipped). Raise the limit or turn off "Resume" to redo the first ${cap} in the queue.`
          : 'Nothing to process.',
    };
  }

  ilState.running = true;
  ilState.processed = 0;
  ilState.total = limited.length;
  ilState.lastMessage = 'Starting…';

  ilJob = (async () => {
    const db = openDashboardRw(cfg);
    const dashRo = fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)
      ? new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true })
      : null;
    try {
      const perf = loadGscPerformance(60);
      let merged = readSuggestions(db);
      const wpDb = dashRo ?? db;
      for (let i = 0; i < limited.length; i++) {
        const node = limited[i]!;
        ilState.processed = i + 1;
        ilState.lastMessage = `Claude (${i + 1}/${limited.length}): ${node.id}`;

        const pack = collectInterlinkCandidatesForSlug(node.id, built, wpDb, perf);
        if (!pack || pack.candidates.length === 0) {
          log.warn({ slug: node.id }, 'interlinking batch: no candidates for node');
          if (i + 1 < limited.length) await sleep(1000);
          continue;
        }

        try {
          const sug = await suggestInterlinksAnthropic(cfg, pack.info, pack.candidates, perf);
          if (suggestionHasContent(sug)) {
            merged = { ...merged, [node.id]: sug };
            writeSuggestions(db, merged, new Date().toISOString());
          }
        } catch (e) {
          log.warn({ err: e, slug: node.id }, 'interlinking Claude call failed');
          // Do not persist empty on error so a later run (resume) retries this slug.
        }
        if (i + 1 < limited.length) await sleep(1000);
      }

      ilState.processed = limited.length;
      ilState.lastMessage = 'Done';
      log.info(
        { count: limited.length, resume, skippedExisting },
        'interlinking suggestions job completed',
      );
    } finally {
      dashRo?.close();
      db.close();
      ilState.running = false;
      ilJob = null;
    }
  })();

  const skipNote =
    resume && skippedExisting > 0 ? ` (${skippedExisting} already saved were skipped).` : '';
  const scopeNote =
    problemScope === 'all'
      ? 'all problem groups'
      : problemScope.replace(/-/g, ' ');
  const typeNote = wpTypeFilter !== 'all' ? ` · ${wpTypeFilter}s only` : '';
  return {
    started: true,
    message: `Running Claude for ${limited.length} URL(s) (${scopeNote}${typeNote}).${skipNote} Refresh when finished.`,
  };
}

function resolveBlogPerfDbPath(): string | null {
  const env = process.env.BLOG_PERFORMANCE_DB?.trim();
  const p = env ? path.resolve(env) : path.join(os.homedir(), '.nanoclaw', 'blog_performance.db');
  return fs.existsSync(p) ? p : null;
}

/** Cron-applied links + GSC deltas — same schema as incofin `interlinking_changes` in blog performance SQLite. */
export function getInterlinkingChangesPayload(): {
  changes: unknown[];
  totalApplied: number;
  articlesFixed: number;
  changeLogHint: string | null;
} {
  const p = resolveBlogPerfDbPath();
  if (!p) {
    return {
      changes: [],
      totalApplied: 0,
      articlesFixed: 0,
      changeLogHint:
        'Cron counts stay at 0 until a blog performance DB is available. Set BLOG_PERFORMANCE_DB or add ~/.nanoclaw/blog_performance.db with an interlinking_changes table (written by your interlinking cron).',
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(p, { readonly: true, fileMustExist: true });
  } catch (e) {
    log.warn({ err: e, p }, 'blog performance db open failed');
    return {
      changes: [],
      totalApplied: 0,
      articlesFixed: 0,
      changeLogHint: `Could not open performance DB at ${p}.`,
    };
  }

  try {
    const hasTable = db
      .prepare(
        `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='interlinking_changes' LIMIT 1`,
      )
      .get() as { x: number } | undefined;
    if (!hasTable) {
      return {
        changes: [],
        totalApplied: 0,
        articlesFixed: 0,
        changeLogHint:
          'Found the performance DB but no interlinking_changes table yet. Your cron should CREATE TABLE and INSERT rows when links are applied.',
      };
    }

    type ChangeRow = {
      id: number;
      orphan_slug: string;
      source_slug: string;
      target_slug: string;
      direction: string;
      anchor_text: string | null;
      applied_at: string;
      commit_sha: string | null;
    };
    const rawChanges = db
      .prepare(
        `SELECT id, orphan_slug, source_slug, target_slug, direction, anchor_text, applied_at, commit_sha
         FROM interlinking_changes
         WHERE direction != 'skipped'
         ORDER BY applied_at DESC
         LIMIT 200`,
      )
      .all() as ChangeRow[];

    const hasPerf = Boolean(
      db
        .prepare(
          `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='blog_performance' LIMIT 1`,
        )
        .get(),
    );

    const enriched = rawChanges.map((c) => {
      let clicksBefore: number | null = null;
      let clicksAfter: number | null = null;
      if (hasPerf) {
        try {
          const slug = c.orphan_slug;
          const d = c.applied_at.slice(0, 10);
          const before = db!
            .prepare(
              `SELECT SUM(clicks) AS total FROM blog_performance
               WHERE slug = ? AND snapshot_date >= date(?, '-14 days') AND snapshot_date < date(?, '-7 days')`,
            )
            .get(slug, d, d) as { total: number } | undefined;
          const after = db!
            .prepare(
              `SELECT SUM(clicks) AS total FROM blog_performance
               WHERE slug = ? AND snapshot_date >= date(?, '+1 days') AND snapshot_date <= date(?, '+8 days')`,
            )
            .get(slug, d, d) as { total: number } | undefined;
          clicksBefore = before?.total ?? null;
          clicksAfter = after?.total ?? null;
        } catch {
          /* ignore */
        }
      }
      return {
        ...c,
        clicks_before: clicksBefore,
        clicks_after: clicksAfter,
      };
    });

    const articlesFixed = new Set(rawChanges.map((c) => c.orphan_slug)).size;
    return {
      changes: enriched,
      totalApplied: rawChanges.length,
      articlesFixed,
      changeLogHint: rawChanges.length === 0 ? 'interlinking_changes exists but has no rows yet.' : null,
    };
  } catch (e) {
    log.warn({ err: e }, 'interlinking_changes query failed');
    return {
      changes: [],
      totalApplied: 0,
      articlesFixed: 0,
      changeLogHint: e instanceof Error ? e.message : String(e),
    };
  } finally {
    db?.close();
  }
}
