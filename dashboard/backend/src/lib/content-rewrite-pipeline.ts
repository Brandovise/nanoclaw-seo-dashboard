/**
 * Content rewrite pipeline: low SEO-score articles → Anthropic web-search research → diagnosis
 * → Markdown writer ↔ reviewer → Markdown staging, with optional basic HTML conversion + full SEO audit.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import {
  ensureInterlinkSuggestionsForSlug,
  suggestionHasContent,
  type IlSuggestion,
} from './interlinking.js';
import type { RewriteStagingItem } from './content-rewrite-files.js';
import {
  clearRewriteStagingDir,
  getStagingItemById,
  loadStoredRewriteOutput,
  newRewriteStagingId,
  readStagingIndex,
  removeStagingItemById,
  upsertStagingItem,
  writeStagingHtmlFile,
  writeStagingMarkdownFile,
} from './content-rewrite-files.js';
import { createDraftDuplicate, loadWpRestConfig } from './wordpress-write.js';
import { sqlWpTypesDashboardClause } from './wp-dashboard-types.js';
import { log } from './logger.js';
import { hasTable } from './nanoclaw-db.js';
import {
  runOrchestratedArticleRewrite,
  runSeoHtmlConversionAgent,
  type RewriteAcceptanceThresholds,
} from './content-rewrite-agents.js';
import { auditSeoContent } from './seo-audit.js';

type CandidateRow = {
  slug: string;
  seo_score: number;
  geo_score: number;
  summary: string | null;
  checks_json: string;
  wp_id: number;
  wp_type: string;
  title: string | null;
  content_html: string | null;
  content_text: string | null;
  source_url: string | null;
  excerpt: string | null;
};

const MAX_REWRITE_PROGRESS_LOG = 400;

const DEFAULT_ACCEPTANCE_THRESHOLDS: RewriteAcceptanceThresholds = { hr: 4, seo: 85, geo: 85 };

/** One line of pipeline / agent activity for the dashboard (API + UI). */
export type RewriteProgressEntry = {
  at: string;
  stage: string;
  message: string;
  slug?: string;
};

const rewriteState: {
  running: boolean;
  stopRequested: boolean;
  message: string | null;
  currentSlug: string | null;
  processed: number;
  total: number;
  lastRunStartedAt: string | null;
  lastThreshold: number | null;
  lastLimit: number | null;
  lastDryRun: boolean;
  /** Current agent / step id: orchestrator | research | diagnosis | writer | reviewer | html | full-seo-audit | persist | idle */
  stage: string;
  stageDetail: string | null;
  progressLog: RewriteProgressEntry[];
} = {
  running: false,
  stopRequested: false,
  message: null,
  currentSlug: null,
  processed: 0,
  total: 0,
  lastRunStartedAt: null,
  lastThreshold: null,
  lastLimit: null,
  lastDryRun: false,
  stage: 'idle',
  stageDetail: null,
  progressLog: [],
};

let rewriteJob: Promise<void> | null = null;

function pushRewriteProgress(entry: { stage: string; message: string; slug?: string }): void {
  const row: RewriteProgressEntry = {
    at: new Date().toISOString(),
    stage: entry.stage,
    message: entry.message,
    ...(entry.slug ? { slug: entry.slug } : {}),
  };
  rewriteState.stage = entry.stage;
  rewriteState.stageDetail = entry.message;
  rewriteState.progressLog.push(row);
  if (rewriteState.progressLog.length > MAX_REWRITE_PROGRESS_LOG) {
    rewriteState.progressLog.splice(0, rewriteState.progressLog.length - MAX_REWRITE_PROGRESS_LOG);
  }
}

export function getContentRewritePipelineState(): typeof rewriteState {
  return {
    ...rewriteState,
    progressLog: rewriteState.progressLog.slice(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function siteBase(cfg: AppConfig): string {
  return (cfg.WP_SITE_URL || process.env.WP_SITE_URL || '').replace(/\/+$/, '');
}

function anthropicKey(cfg: AppConfig): string | undefined {
  const k = cfg.ANTHROPIC_API_KEY?.trim();
  return k || undefined;
}

function readInterlinkMap(cfg: AppConfig): Record<string, IlSuggestion> {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return {};
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT suggestions_json FROM interlinking_state WHERE id = 1').get() as
      | { suggestions_json: string }
      | undefined;
    if (!row?.suggestions_json) return {};
    const o = JSON.parse(row.suggestions_json) as Record<string, IlSuggestion>;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  } finally {
    db.close();
  }
}

function formatInterlinkHints(slug: string, map: Record<string, IlSuggestion>): string {
  const s = map[slug];
  if (!s) return '';
  const ins = s.inbound?.length ? s.inbound.slice(0, 5) : [];
  const outs = s.outbound?.length ? s.outbound.slice(0, 8) : [];
  if (!ins.length && !outs.length) return '';
  const lines: string[] = ['Interlinking suggestions (use where natural; keep Markdown structure clean):'];
  for (const o of outs) {
    lines.push(`- Link to /${o.target_slug}/ anchor: "${o.anchor_text}" — ${o.placement_hint || ''}`);
  }
  for (const i of ins) {
    lines.push(`- Inbound from /${i.source_slug}/ anchor: "${i.anchor_text}" — ${i.placement_hint || ''}`);
  }
  return lines.join('\n');
}

/** Outbound/inbound neighbours from synced `wp_links` so writers get concrete URLs without running the Claude interlink job. */
function buildInternalLinkHintsFromWpDb(db: Database.Database, slug: string): string {
  if (!hasTable(db, 'wp_articles') || !hasTable(db, 'wp_links')) return '';

  type Row = { slug: string; title: string | null; url: string | null };
  const outRows = db
    .prepare(
      `
      SELECT DISTINCT w.slug AS slug, w.title AS title,
        COALESCE(NULLIF(trim(w.source_url), ''), l.target_url) AS url
      FROM wp_links l
      LEFT JOIN wp_articles w ON w.slug = l.target_slug AND (${sqlWpTypesDashboardClause('w')})
      WHERE l.source_slug = @slug AND l.is_internal = 1 AND l.target_slug IS NOT NULL AND l.target_slug != @slug
      ORDER BY length(COALESCE(w.title, '')) DESC
      LIMIT 12
    `,
    )
    .all({ slug }) as Row[];

  const inRows = db
    .prepare(
      `
      SELECT DISTINCT w.slug AS slug, w.title AS title, w.source_url AS url
      FROM wp_links l
      INNER JOIN wp_articles w ON w.slug = l.source_slug AND (${sqlWpTypesDashboardClause('w')})
      WHERE l.target_slug = @slug AND l.is_internal = 1 AND l.source_slug IS NOT NULL AND l.source_slug != @slug
      ORDER BY length(COALESCE(w.title, '')) DESC
      LIMIT 10
    `,
    )
    .all({ slug }) as Row[];

  if (!outRows.length && !inRows.length) return '';

  const lines = [
    'Internal URLs from current WordPress link graph (prefer 4–8 Markdown links scattered in the body; match anchor text to reader intent):',
  ];
  for (const r of outRows) {
    const url = r.url?.trim();
    const label = r.title?.trim() || r.slug.replace(/-/g, ' ');
    if (url) lines.push(`- [${label}](${url})  (slug ${r.slug})`);
    else lines.push(`- /${r.slug}/ — "${label}" (URL from sync incomplete; use site canonical path if needed)`);
  }
  if (inRows.length) {
    lines.push('Pages that already link here (good reciprocation / related-topic targets when you outbound):');
    for (const r of inRows) {
      const url = r.url?.trim();
      const label = r.title?.trim() || r.slug.replace(/-/g, ' ');
      if (url) lines.push(`- [${label}](${url})`);
      else lines.push(`- /${r.slug}/ — "${label}"`);
    }
  }
  return lines.join('\n');
}

function mergeInterlinkHints(primary: string, fromGraph: string): string {
  return [primary?.trim(), fromGraph?.trim()].filter(Boolean).join('\n\n');
}

export function failNotesFromChecks(checksJson: string): string {
  try {
    const o = JSON.parse(checksJson) as Record<string, { status?: string; note?: string }>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (v?.status === 'FAIL') {
        parts.push(`- ${k}: ${v.note || ''}`);
      }
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** Slugs that already have open staging — do not auto-pick again until user deletes that staging row. */
function slugsBlockedByStaging(cfg: AppConfig): Set<string> {
  const blocked = new Set<string>();
  for (const it of readStagingIndex(cfg)) {
    if (it.status === 'rewritten' || it.status === 'done') {
      blocked.add(it.slug);
    }
  }
  return blocked;
}

function pickCandidates(
  db: Database.Database,
  threshold: number,
  limit: number,
  geoTh: number | undefined,
  excludeSlugs?: Set<string>,
): CandidateRow[] {
  if (!hasTable(db, 'seo_audits') || !hasTable(db, 'wp_articles')) return [];

  const rows = db
    .prepare(
      `SELECT a.slug, a.seo_score, a.geo_score, a.summary, a.checks_json,
              w.wp_id, w.wp_type, w.title, w.content_html, w.content_text, w.source_url, w.excerpt
       FROM seo_audits a
       INNER JOIN wp_articles w ON w.slug = a.slug AND ${sqlWpTypesDashboardClause('w')}
       WHERE w.content_html IS NOT NULL AND length(trim(w.content_html)) > 50
       ORDER BY a.seo_score ASC, a.geo_score ASC`,
    )
    .all() as CandidateRow[];

  const out: CandidateRow[] = [];
  const seenSlug = new Set<string>();
  for (const r of rows) {
    if (seenSlug.has(r.slug)) continue;
    if (excludeSlugs?.has(r.slug)) {
      seenSlug.add(r.slug);
      continue;
    }
    const seoLow = r.seo_score < threshold;
    const geoLow = geoTh != null && r.geo_score < geoTh;
    if (!seoLow && !geoLow) continue;
    seenSlug.add(r.slug);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function draftSlugSuffix(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Same convention as WordPress sync / REST (e.g. post, page). */
function normalizeSyncWpTypeForRest(wpType: string | null | undefined): string {
  const t = (wpType ?? 'post').trim().toLowerCase();
  return t || 'post';
}

/** New draft slug: `{original}-rewritten-{YYYYMMDD}` */
function rewrittenDraftSlug(sourceSlug: string): string {
  const s = sourceSlug.trim().replace(/\/+$/, '');
  const day = draftSlugSuffix();
  if (!s) return `rewritten-${day}`;
  return `${s}-rewritten-${day}`;
}

/** New draft title: original display name + “ (rewritten)”. */
function rewrittenDraftTitle(sourceTitle: string): string {
  const t = sourceTitle.trim();
  if (!t) return 'Rewritten draft';
  if (/\(rewritten\)\s*$/i.test(t)) return t;
  return `${t} (rewritten)`;
}

function stagingItemBase(
  id: string,
  candidate: CandidateRow,
  dryRun: boolean,
  partial: Partial<RewriteStagingItem>,
): RewriteStagingItem {
  return {
    id,
    slug: candidate.slug,
    wp_id: candidate.wp_id,
    wp_type: candidate.wp_type,
    source_url: candidate.source_url,
    seo_score: candidate.seo_score,
    status: 'failed',
    rewritten_title: null,
    draft_slug: null,
    output_rel_path: null,
    output_format: undefined,
    html_rel_path: null,
    research_notes: null,
    diagnosis_json: null,
    orchestrator_trace_json: null,
    rewritten_at: null,
    finished_at: null,
    error_message: null,
    draft_wp_id: null,
    draft_wp_link: null,
    dry_run: dryRun,
    ...partial,
  };
}

async function processOneItem(
  cfg: AppConfig,
  db: Database.Database,
  candidate: CandidateRow,
  dryRun: boolean,
  ilMap: Record<string, IlSuggestion>,
  acceptanceThresholds: RewriteAcceptanceThresholds,
  convertToHtml: boolean,
): Promise<void> {
  const stagingId = newRewriteStagingId();
  const slug = candidate.slug;
  const wpTypeForArticle = normalizeSyncWpTypeForRest(candidate.wp_type);
  const html =
    (db
      .prepare(
        `SELECT content_html, title, excerpt, content_text FROM wp_articles WHERE slug = ? AND wp_type = ?`,
      )
      .get(slug, wpTypeForArticle) as
      | {
          content_html: string | null;
          title: string | null;
          excerpt: string | null;
          content_text: string | null;
        }
      | undefined) ??
    (db.prepare(
      `SELECT content_html, title, excerpt, content_text FROM wp_articles WHERE slug = ? AND ${sqlWpTypesDashboardClause()} ORDER BY CASE WHEN wp_type = 'page' THEN 0 ELSE 1 END LIMIT 1`,
    ).get(slug) as
      | {
          content_html: string | null;
          title: string | null;
          excerpt: string | null;
          content_text: string | null;
        }
      | undefined);
  if (!html?.content_html?.trim()) {
    pushRewriteProgress({ stage: 'orchestrator', message: 'Skipped — no content_html for slug', slug });
    upsertStagingItem(
      cfg,
      stagingItemBase(stagingId, candidate, dryRun, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: 'No content_html for slug',
      }),
    );
    return;
  }

  const aud = db
    .prepare(`SELECT summary, checks_json FROM seo_audits WHERE slug = ?`)
    .get(slug) as { summary: string | null; checks_json: string } | undefined;
  const summary = aud?.summary ?? '';
  const checksJson = aud?.checks_json ?? '{}';
  const failNotes = failNotesFromChecks(checksJson);

  const title = html.title || slug.replace(/-/g, ' ');
  const excerpt = html.excerpt || '';

  try {
    let hintsForSlug: Record<string, IlSuggestion> = ilMap;
    if (!suggestionHasContent(ilMap[slug])) {
      pushRewriteProgress({
        stage: 'interlinking',
        message: 'No saved interlink plan for this slug — generating (Anthropic) then rewriting…',
        slug,
      });
      const generated = await ensureInterlinkSuggestionsForSlug(cfg, slug);
      if (generated && suggestionHasContent(generated)) {
        hintsForSlug = { ...ilMap, [slug]: generated };
      }
    }
    const interHints = mergeInterlinkHints(
      formatInterlinkHints(slug, hintsForSlug),
      buildInternalLinkHintsFromWpDb(db, slug),
    );
    const { markdown, researchNotes: research, diagnosisJson, trace } = await runOrchestratedArticleRewrite(cfg, {
      slug,
      title,
      excerpt,
      contentSnippet: (html.content_text || '').slice(0, 6000),
      auditSummary: summary,
      failNotes,
      checksJson,
      originalHtml: html.content_html || '',
      interlinkHints: interHints,
      acceptanceThresholds,
      onProgress: (ev) => {
        pushRewriteProgress({ stage: ev.stage, message: ev.message, slug });
      },
    });

    let output = markdown;
    let outputFormat: 'markdown' | 'html' = 'markdown';
    let htmlRelPath: string | null = null;
    if (convertToHtml && trace.final_approved) {
      pushRewriteProgress({
        stage: 'html',
        message: 'HTML writer: converting accepted Markdown with SEO/reviewer context…',
        slug,
      });
      const htmlOutput = await runSeoHtmlConversionAgent(cfg, {
        slug,
        title,
        markdown,
        auditSummary: summary,
        failNotes,
        checksJson,
        trace,
      });
      pushRewriteProgress({
        stage: 'full-seo-audit',
        message: 'Full SEO/GEO audit only: generated HTML…',
        slug,
      });
      const htmlAudit = await auditSeoContent(cfg, {
        slug,
        title,
        bodyText: htmlOutput,
      });
      trace.final_html_audit = htmlAudit;
      output = htmlOutput;
      outputFormat = 'html';
      pushRewriteProgress({
        stage: 'full-seo-audit',
        message: `Full SEO/GEO audit only: HTML SEO ${htmlAudit.seo_score}/100, GEO ${htmlAudit.geo_score}/100`,
        slug,
      });
    } else if (convertToHtml && !trace.final_approved) {
      pushRewriteProgress({
        stage: 'html',
        message: 'Skipped HTML conversion because Markdown did not pass acceptance gates',
        slug,
      });
    }

    const fin = new Date().toISOString();
    const newSlug = rewrittenDraftSlug(slug);
    const draftTitle = rewrittenDraftTitle(title);
    const relPath =
      outputFormat === 'html'
        ? writeStagingHtmlFile(cfg, stagingId, output)
        : writeStagingMarkdownFile(cfg, stagingId, output);
    if (outputFormat === 'html') htmlRelPath = relPath;
    pushRewriteProgress({
      stage: 'persist',
      message:
        outputFormat === 'html'
          ? 'Saved generated HTML to staging after Markdown approval and full SEO/GEO audit'
          : !trace.final_approved
            ? 'Saved rewritten Markdown to staging (last draft — human QA recommended)'
            : trace.soft_approved
              ? 'Saved rewritten Markdown to staging (passed review score gates; meta/schema still in WP)'
              : 'Saved rewritten Markdown to staging (reviewer approved)',
      slug,
    });
    upsertStagingItem(
      cfg,
      stagingItemBase(stagingId, candidate, dryRun, {
        status: 'rewritten',
        rewritten_title: draftTitle,
        draft_slug: newSlug,
        output_rel_path: relPath,
        output_format: outputFormat,
        html_rel_path: htmlRelPath,
        research_notes: research,
        diagnosis_json: diagnosisJson,
        orchestrator_trace_json: JSON.stringify(trace),
        rewritten_at: fin,
        finished_at: fin,
        error_message: null,
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error({ err: e, slug, stagingId }, 'rewrite item failed');
    pushRewriteProgress({ stage: 'orchestrator', message: `Rewrite failed: ${msg.slice(0, 480)}`, slug });
    upsertStagingItem(
      cfg,
      stagingItemBase(stagingId, candidate, dryRun, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: msg.slice(0, 2000),
      }),
    );
  }
}

async function runLoop(
  cfg: AppConfig,
  candidates: CandidateRow[],
  dryRun: boolean,
  acceptanceThresholds: RewriteAcceptanceThresholds,
  convertToHtml: boolean,
): Promise<void> {
  const ilMap = readInterlinkMap(cfg);
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
    rewriteState.message = 'Dashboard SQLite not found';
    pushRewriteProgress({ stage: 'orchestrator', message: 'Dashboard SQLite not found — run aborted' });
    rewriteState.running = false;
    rewriteState.stopRequested = false;
    rewriteState.currentSlug = null;
    rewriteState.stage = 'idle';
    rewriteState.stageDetail = rewriteState.message;
    rewriteJob = null;
    return;
  }
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    rewriteState.total = candidates.length;
    rewriteState.processed = 0;
    let stoppedEarly = false;
    for (const c of candidates) {
      if (rewriteState.stopRequested) {
        stoppedEarly = true;
        break;
      }
      rewriteState.currentSlug = c.slug;
      pushRewriteProgress({
        stage: 'orchestrator',
        message: `Article ${rewriteState.processed + 1}/${rewriteState.total} — agents running`,
        slug: c.slug,
      });
      await processOneItem(cfg, db, c, dryRun, ilMap, acceptanceThresholds, convertToHtml);
      rewriteState.processed += 1;
      if (rewriteState.stopRequested) {
        stoppedEarly = true;
        break;
      }
      if (cfg.REWRITE_PAUSE_MS > 0) await sleep(cfg.REWRITE_PAUSE_MS);
    }
    rewriteState.message = stoppedEarly ? 'stopped' : 'completed';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rewriteState.message = msg;
    pushRewriteProgress({ stage: 'orchestrator', message: `Batch error: ${msg.slice(0, 480)}` });
    log.error({ err: e }, 'rewrite pipeline run failed');
  } finally {
    db.close();
    const finalMsg = rewriteState.message;
    if (finalMsg === 'stopped') {
      pushRewriteProgress({ stage: 'orchestrator', message: 'Batch stopped (remaining articles skipped)' });
    } else if (finalMsg === 'completed') {
      pushRewriteProgress({ stage: 'orchestrator', message: 'Batch completed — all queued articles processed' });
    }
    rewriteState.running = false;
    rewriteState.stopRequested = false;
    rewriteState.currentSlug = null;
    rewriteJob = null;
    rewriteState.stage = 'idle';
    rewriteState.stageDetail = finalMsg;
  }
}

export function requestContentRewritePipelineStop(): { ok: boolean; message: string } {
  if (!rewriteState.running) {
    return { ok: false, message: 'Pipeline is not running.' };
  }
  rewriteState.stopRequested = true;
  pushRewriteProgress({ stage: 'orchestrator', message: 'Stop requested — finishes current article then halts' });
  return { ok: true, message: 'Stop requested — halts after the current article.' };
}

/** Stops an in-flight run (await), deletes all staging files + index, drops legacy rewrite SQLite tables if present. */
export async function clearContentRewriteStaging(cfg: AppConfig): Promise<{
  ok: boolean;
  message: string;
  pathsRemoved?: number;
}> {
  if (rewriteState.running) {
    rewriteState.stopRequested = true;
    if (rewriteJob) {
      await rewriteJob;
    }
  }
  if (rewriteState.running) {
    return { ok: false, message: 'Pipeline could not finish stopping; try clear again.' };
  }

  const { pathsRemoved } = clearRewriteStagingDir(cfg);
  dropLegacyRewriteQueueTables(cfg, { quiet: true });

  rewriteState.stopRequested = false;
  rewriteState.lastRunStartedAt = null;
  rewriteState.lastThreshold = null;
  rewriteState.lastLimit = null;
  rewriteState.lastDryRun = false;
  rewriteState.processed = 0;
  rewriteState.total = 0;
  rewriteState.message = 'cleared';
  rewriteState.currentSlug = null;
  rewriteState.stage = 'idle';
  rewriteState.stageDetail = 'cleared';
  rewriteState.progressLog = [];

  log.info({ pathsRemoved }, 'rewrite staging cleared (disk + legacy DB tables)');
  return {
    ok: true,
    message: `Cleared ${pathsRemoved} path(s) under rewrite storage and reset staging index.`,
    pathsRemoved,
  };
}

/** One-time cleanup: legacy rewrite queue tables are unused (staging is filesystem-only). */
export function dropLegacyRewriteQueueTables(cfg: AppConfig, opts?: { quiet?: boolean }): void {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return;
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH);
  try {
    db.exec('DROP TABLE IF EXISTS content_rewrite_run_items; DROP TABLE IF EXISTS content_rewrite_runs;');
    if (!opts?.quiet) log.info('Dropped legacy content_rewrite_* tables; rewrite staging is filesystem-only.');
  } catch (e) {
    log.warn({ err: e }, 'drop legacy content_rewrite_* tables failed');
  } finally {
    db.close();
  }
}

export function startContentRewritePipelineJob(
  cfg: AppConfig,
  opts: {
    threshold?: number;
    limit?: number;
    dryRun?: boolean;
    acceptanceHr?: number;
    acceptanceSeo?: number;
    acceptanceGeo?: number;
    convertToHtml?: boolean;
  },
): { started: boolean; message: string } {
  if (rewriteJob || rewriteState.running) {
    return { started: false, message: 'Content rewrite pipeline is already running.' };
  }
  if (!anthropicKey(cfg)) {
    return { started: false, message: 'ANTHROPIC_API_KEY is not configured.' };
  }
  const threshold = opts.threshold ?? cfg.REWRITE_SEO_THRESHOLD;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  const dryRun = opts.dryRun === true;
  const convertToHtml = opts.convertToHtml === true;
  const acceptanceThresholds: RewriteAcceptanceThresholds = {
    hr: clampNumber(opts.acceptanceHr, DEFAULT_ACCEPTANCE_THRESHOLDS.hr, 1, 5),
    seo: clampNumber(opts.acceptanceSeo, DEFAULT_ACCEPTANCE_THRESHOLDS.seo, 0, 100),
    geo: clampNumber(opts.acceptanceGeo, DEFAULT_ACCEPTANCE_THRESHOLDS.geo, 0, 100),
  };

  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
    return { started: false, message: 'Dashboard SQLite not found.' };
  }
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
  let candidates: CandidateRow[] = [];
  try {
    if (!hasTable(db, 'seo_audits') || !hasTable(db, 'wp_articles')) {
      return { started: false, message: 'Run SEO audits and WP sync first (missing tables).' };
    }
    const geoTh = cfg.REWRITE_GEO_THRESHOLD;
    const blocked = slugsBlockedByStaging(cfg);
    candidates = pickCandidates(db, threshold, limit, geoTh, blocked);
  } finally {
    db.close();
  }

  if (candidates.length === 0) {
    return {
      started: false,
      message:
        'No articles to rewrite: none match the threshold, or every low-score slug already has staging (rewritten/done). Remove a staging row in the UI to rewrite that slug again.',
    };
  }

  const now = new Date().toISOString();
  rewriteState.running = true;
  rewriteState.stopRequested = false;
  rewriteState.message = 'started';
  rewriteState.lastRunStartedAt = now;
  rewriteState.lastThreshold = threshold;
  rewriteState.lastLimit = limit;
  rewriteState.lastDryRun = dryRun;
  rewriteState.processed = 0;
  rewriteState.total = candidates.length;
  rewriteState.progressLog = [];
  rewriteState.stage = 'orchestrator';
  rewriteState.stageDetail = 'Starting…';
  pushRewriteProgress({
    stage: 'orchestrator',
    message: `Run started — ${candidates.length} article(s), threshold ≤${threshold}; acceptance HR≥${acceptanceThresholds.hr}, SEO≥${acceptanceThresholds.seo}, GEO≥${acceptanceThresholds.geo}${convertToHtml ? '; HTML conversion + full audit enabled' : ''}${dryRun ? ', dry run' : ''}`,
  });

  rewriteJob = runLoop(cfg, candidates, dryRun, acceptanceThresholds, convertToHtml);

  const stagingHint = cfg.resolvedRewriteFilesDir.replace(cfg.repoRoot, '') || cfg.resolvedRewriteFilesDir;
  return {
    started: true,
    message: `Started rewrite of ${candidates.length} article(s) (threshold ≤${threshold}; acceptance HR≥${acceptanceThresholds.hr}, SEO≥${acceptanceThresholds.seo}, GEO≥${acceptanceThresholds.geo}${convertToHtml ? '; HTML conversion + full audit enabled' : ''}). Staging: ${stagingHint}`,
  };
}

export type RewriteItemPreview = {
  id: string;
  runId: number;
  slug: string;
  status: string;
  sourceUrl: string | null;
  rewrittenTitle: string | null;
  draftSlug: string | null;
  rewrittenAt: string | null;
  outputFormat: 'markdown' | 'html';
  rewriteOutputPath: string | null;
  /** @deprecated Legacy HTML path retained for old staged items. */
  rewriteHtmlPath: string | null;
  rewrittenMarkdown: string;
  /** @deprecated Legacy alias retained for old frontend callers. */
  rewrittenHtml: string;
  researchNotes: string | null;
  diagnosisJson: string | null;
  reviewScores: RewriteReviewScores;
  dryRun: boolean;
};

type RewriteReviewScores = {
  humanReadable: number | null;
  seo: number | null;
  geo: number | null;
  approved: boolean | null;
  softApproved: boolean | null;
};

function outputFormatForItem(row: RewriteStagingItem): 'markdown' | 'html' {
  if (row.output_format === 'markdown' || row.output_format === 'html') return row.output_format;
  const p = (row.output_rel_path || row.html_rel_path || '').toLowerCase();
  return p.endsWith('.md') ? 'markdown' : 'html';
}

function outputPathForItem(row: RewriteStagingItem): string | null {
  return row.output_rel_path?.trim() || row.html_rel_path?.trim() || null;
}

function reviewScoresFromTrace(traceJson: string | null | undefined): RewriteReviewScores {
  const empty: RewriteReviewScores = { humanReadable: null, seo: null, geo: null, approved: null, softApproved: null };
  if (!traceJson?.trim()) return empty;
  try {
    const trace = JSON.parse(traceJson) as {
      final_approved?: boolean;
      soft_approved?: boolean;
      final_html_audit?: { seo_score?: unknown; geo_score?: unknown };
      rounds?: Array<{
        reviewer?: {
          human_readable?: { score?: unknown };
          seo?: { score?: unknown };
          geo?: { score?: unknown };
        };
        rewrite_audit?: { seo_score?: unknown; geo_score?: unknown };
      }>;
    };
    const last = Array.isArray(trace.rounds) ? trace.rounds[trace.rounds.length - 1]?.reviewer : undefined;
    const lastAudit = Array.isArray(trace.rounds) ? trace.rounds[trace.rounds.length - 1]?.rewrite_audit : undefined;
    const finalHtmlAudit = trace.final_html_audit;
    return {
      humanReadable: last?.human_readable?.score == null ? null : Number(last.human_readable.score),
      seo:
        finalHtmlAudit?.seo_score != null
          ? Number(finalHtmlAudit.seo_score)
          : lastAudit?.seo_score == null
          ? last?.seo?.score == null
            ? null
            : Number(last.seo.score)
          : Number(lastAudit.seo_score),
      geo:
        finalHtmlAudit?.geo_score != null
          ? Number(finalHtmlAudit.geo_score)
          : lastAudit?.geo_score == null
          ? last?.geo?.score == null
            ? null
            : Number(last.geo.score)
          : Number(lastAudit.geo_score),
      approved: typeof trace.final_approved === 'boolean' ? trace.final_approved : null,
      softApproved: typeof trace.soft_approved === 'boolean' ? trace.soft_approved : null,
    };
  } catch {
    return empty;
  }
}

export function getRewriteItemPreview(cfg: AppConfig, itemId: string): RewriteItemPreview | null {
  const row = getStagingItemById(cfg, itemId);
  if (!row || row.status !== 'rewritten') return null;
  const outputPath = outputPathForItem(row);
  if (!outputPath) return null;
  const output = loadStoredRewriteOutput(cfg, { rewritten_output_path: outputPath, rewritten_html: null });
  if (!output.trim()) return null;
  const format = outputFormatForItem(row);
  return {
    id: row.id,
    runId: 0,
    slug: row.slug,
    status: row.status,
    sourceUrl: row.source_url,
    rewrittenTitle: row.rewritten_title,
    draftSlug: row.draft_slug,
    rewrittenAt: row.rewritten_at,
    outputFormat: format,
    rewriteOutputPath: outputPath,
    rewriteHtmlPath: row.html_rel_path?.trim() || null,
    rewrittenMarkdown: format === 'markdown' ? output : '',
    rewrittenHtml: format === 'html' ? output : output,
    researchNotes: row.research_notes,
    diagnosisJson: row.diagnosis_json,
    reviewScores: reviewScoresFromTrace(row.orchestrator_trace_json),
    dryRun: row.dry_run,
  };
}

export async function uploadRewriteItemToWordpress(
  cfg: AppConfig,
  itemId: string,
): Promise<{ ok: boolean; message: string; draftLink?: string | null; draftId?: number; draftSlug?: string | null }> {
  const row = getStagingItemById(cfg, itemId);
  if (!row) return { ok: false, message: 'Item not found.' };
  if (row.status !== 'rewritten') return { ok: false, message: 'Item is not awaiting upload (rewrite it first).' };
  if (row.dry_run) return { ok: false, message: 'This run was started as dry-run; uploads are disabled.' };
  const outputFormat = outputFormatForItem(row);
  if (outputFormat === 'markdown') {
    return {
      ok: false,
      message: 'This rewrite is stored as Markdown. Re-run with "HTML + full audit" enabled before uploading.',
    };
  }
  const html = loadStoredRewriteOutput(cfg, {
    rewritten_output_path: outputPathForItem(row),
    rewritten_html: null,
  }).trim();
  if (!html) return { ok: false, message: 'No rewritten HTML on disk.' };

  const wpCfg = loadWpRestConfig();
  if (!wpCfg)
    return {
      ok: false,
      message: 'WordPress credentials missing (WP_SITE_URL / WP_USERNAME or WP_USER / WP_APP_PASSWORD).',
    };

  const base = siteBase(cfg);
  if (!base) return { ok: false, message: 'WP_SITE_URL is required.' };

  const srcId = row.wp_id;
  const srcType = normalizeSyncWpTypeForRest(row.wp_type);

  let srcTitle: string | null = null;
  let sourceRestMetaFallback: Record<string, unknown> | null = null;
  if (fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
    const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
    try {
      const sr = db
        .prepare(`SELECT title, rest_meta_json FROM wp_articles WHERE slug = ? AND wp_type = ?`)
        .get(row.slug, srcType) as { title: string | null; rest_meta_json: string | null } | undefined;
      srcTitle = sr?.title?.trim() || null;
      const rawMeta = sr?.rest_meta_json?.trim();
      if (rawMeta) {
        try {
          sourceRestMetaFallback = JSON.parse(rawMeta) as Record<string, unknown>;
        } catch {
          sourceRestMetaFallback = null;
        }
      }
    } finally {
      db.close();
    }
  }

  const fallbackLabel = srcTitle || row.slug.replace(/-/g, ' ');
  const newTitle = row.rewritten_title?.trim() || rewrittenDraftTitle(fallbackLabel);
  const draftSlug = row.draft_slug?.trim() || rewrittenDraftSlug(row.slug);

  try {
    const created = await createDraftDuplicate({
      cfg: wpCfg,
      siteBase: base,
      wpId: srcId,
      wpType: srcType,
      newTitle,
      contentHtml: html,
      draftSlug,
      sourceWpId: srcId,
      sourceRestMetaFallback,
    });

    const fin = new Date().toISOString();
    upsertStagingItem(cfg, {
      ...row,
      status: 'done',
      finished_at: fin,
      draft_wp_id: created.draftId,
      draft_wp_link: created.adminEditUrl,
      draft_slug: created.draftSlug,
    });

    log.info({ itemId, draftId: created.draftId }, 'rewrite item uploaded to WordPress');
    return {
      ok: true,
      message: 'New unpublished draft created in WordPress.',
      draftLink: created.adminEditUrl,
      draftId: created.draftId,
      draftSlug: created.draftSlug,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error({ err: e, itemId }, 'upload rewrite item failed');
    return { ok: false, message: msg.slice(0, 2000) };
  }
}

/** Remove a staging entry and its artifact file. Does not delete anything in WordPress. */
export function deleteRewriteQueueItem(cfg: AppConfig, itemId: string): { ok: boolean; message: string } {
  if (rewriteState.running) {
    return { ok: false, message: 'Wait for the pipeline to finish before removing staging entries.' };
  }
  const ok = removeStagingItemById(cfg, itemId);
  if (!ok) return { ok: false, message: 'Item not found.' };
  log.info({ itemId }, 'rewrite staging item deleted');
  return { ok: true, message: 'Deleted.' };
}

export type RewriteQueueApiResponse = {
  queue: string[];
  done: string[];
  failed: Record<string, string>;
  rewrittenItems: Array<{
    itemId: string;
    slug: string;
    draftSlug: string | null;
    rewrittenTitle: string | null;
    sourceUrl: string | null;
    rewrittenAt: string | null;
    outputFormat: 'markdown' | 'html';
    rewriteOutputPath: string | null;
    rewriteHtmlPath: string | null;
    reviewScores: RewriteReviewScores;
    uploadBlocked: boolean;
  }>;
  doneItems: Array<{
    itemId: string;
    slug: string;
    draftWpId: number | null;
    draftLink: string | null;
    draftSlug: string | null;
    sourceUrl: string | null;
    finishedAt: string | null;
  }>;
  pendingItems: Array<{ itemId: string; slug: string }>;
  failedItems: Array<{ itemId: string; slug: string; error: string }>;
  run: {
    id: number;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    threshold: number;
    processed: number;
    total: number;
    dryRun: boolean;
  } | null;
};

export function getRewriteQueueApiPayload(cfg: AppConfig): RewriteQueueApiResponse {
  const staging = readStagingIndex(cfg);
  const empty: RewriteQueueApiResponse = {
    queue: [],
    done: [],
    failed: {},
    rewrittenItems: [],
    doneItems: [],
    pendingItems: [],
    failedItems: [],
    run: null,
  };

  if (!staging.length && !rewriteState.running && !rewriteState.lastRunStartedAt) {
    return empty;
  }

  const queue: string[] = [];
  if (rewriteState.running && rewriteState.currentSlug) {
    queue.push(rewriteState.currentSlug);
  }

  const done: string[] = [];
  const failed: Record<string, string> = {};
  const rewrittenItems: RewriteQueueApiResponse['rewrittenItems'] = [];
  const doneItems: RewriteQueueApiResponse['doneItems'] = [];
  const pendingItems: RewriteQueueApiResponse['pendingItems'] = [];
  const failedItems: RewriteQueueApiResponse['failedItems'] = [];

  for (const it of staging) {
    if (it.status === 'rewritten') {
      const outputFormat = outputFormatForItem(it);
      rewrittenItems.push({
        itemId: it.id,
        slug: it.slug,
        draftSlug: it.draft_slug,
        rewrittenTitle: it.rewritten_title,
        sourceUrl: it.source_url,
        rewrittenAt: it.rewritten_at,
        outputFormat,
        rewriteOutputPath: outputPathForItem(it),
        rewriteHtmlPath: it.html_rel_path ?? null,
        reviewScores: reviewScoresFromTrace(it.orchestrator_trace_json),
        uploadBlocked: it.dry_run || outputFormat === 'markdown',
      });
    } else if (it.status === 'done') {
      done.push(it.slug);
      doneItems.push({
        itemId: it.id,
        slug: it.slug,
        draftWpId: it.draft_wp_id,
        draftLink: it.draft_wp_link,
        draftSlug: it.draft_slug,
        sourceUrl: it.source_url,
        finishedAt: it.finished_at,
      });
    } else if (it.status === 'failed' && it.error_message) {
      failed[it.slug] = it.error_message;
      failedItems.push({ itemId: it.id, slug: it.slug, error: it.error_message });
    }
  }

  const run = {
    id: 0,
    status: rewriteState.running ? 'running' : 'idle',
    startedAt: rewriteState.lastRunStartedAt ?? '',
    finishedAt: null as string | null,
    threshold: rewriteState.lastThreshold ?? 0,
    processed: rewriteState.processed,
    total: rewriteState.running ? rewriteState.total : staging.length,
    dryRun: rewriteState.lastDryRun,
  };

  return {
    queue,
    done,
    failed,
    rewrittenItems,
    doneItems,
    pendingItems,
    failedItems,
    run,
  };
}
