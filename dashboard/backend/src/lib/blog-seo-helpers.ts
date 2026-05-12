import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { fileMtimeSafe, readJsonSafe } from './fs-utils.js';
import { getLatestSeoAuditAt, readSeoAuditRecords } from './seo-audit.js';
import { sqlWpTypesDashboardClause } from './wp-dashboard-types.js';
import { readStagingIndex } from './content-rewrite-files.js';
import type { SeoAuditRecord } from './seo-audit.js';

export function blogPaths(cfg: AppConfig) {
  const base = cfg.resolvedBlogDataDir;
  return {
    base,
    blogQueue: path.join(base, 'blog_queue.json'),
    schedulerLog: path.join(base, 'blog_scheduler.log'),
    contentDir: path.join(base, 'content'),
    rewriteProgress: path.join(base, 'rewrite_progress.json'),
  };
}

/** When no rows in `seo_audits`, list WP posts with placeholder scores so the UI can load. */
export function buildAuditFallbackFromWordPress(cfg: AppConfig): Array<Record<string, unknown>> {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return [];
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    const has = db
      .prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name='wp_articles'`)
      .get() as { x: number } | undefined;
    if (!has) return [];
    return (
      db
        .prepare(
          `SELECT slug, title, last_synced_at as audited_at
         FROM wp_articles
         WHERE ${sqlWpTypesDashboardClause()}
         ORDER BY modified_at DESC
         LIMIT 5000`,
        )
        .all() as Array<{ slug: string; title: string; audited_at: string }>
    ).map((r) => ({
      slug: r.slug,
      title: r.title,
      seo_score: 0,
      geo_score: 0,
      audited_at: r.audited_at,
      checks: {} as Record<string, { status: string }>,
      _synthetic: true,
    }));
  } finally {
    db.close();
  }
}

type RewriteAuditImpact = {
  rewritten_at: string | null;
  output_format: 'markdown' | 'html';
  updated_kind: 'markdown' | 'html';
  prev: {
    seo_score: number;
    geo_score: number;
    checks: SeoAuditRecord['checks'];
  };
  updated: {
    seo_score: number;
    geo_score: number;
    checks: SeoAuditRecord['checks'];
    summary?: string;
  };
  markdown: RewriteAuditSnapshot | null;
  html: RewriteAuditSnapshot | null;
  delta: {
    seo_score: number;
    geo_score: number;
  };
  deltas: {
    markdown: { seo_score: number; geo_score: number } | null;
    html: { seo_score: number; geo_score: number } | null;
  };
};

type RewriteAuditSnapshot = {
  audit_mode: 'markdown' | 'html';
  label: string;
  audited_at: string | null;
  seo_score: number;
  geo_score: number;
  checks: SeoAuditRecord['checks'];
  summary?: string;
};

type RewriteAuditPair = {
  at: string;
  outputFormat: 'markdown' | 'html';
  markdown: SeoAuditRecord | null;
  html: SeoAuditRecord | null;
};

function latestRewriteAuditBySlug(cfg: AppConfig): Map<string, RewriteAuditPair> {
  const out = new Map<string, RewriteAuditPair>();
  for (const item of readStagingIndex(cfg)) {
    if (item.status !== 'rewritten' && item.status !== 'done') continue;
    const traceJson = item.orchestrator_trace_json?.trim();
    if (!traceJson) continue;
    try {
      const trace = JSON.parse(traceJson) as {
        final_html_audit?: SeoAuditRecord;
        rounds?: Array<{ rewrite_audit?: SeoAuditRecord }>;
      };
      const rounds = Array.isArray(trace.rounds) ? trace.rounds : [];
      const markdownAudit = [...rounds].reverse().find((r) => r.rewrite_audit)?.rewrite_audit ?? null;
      const htmlAudit = trace.final_html_audit ?? null;
      if (!markdownAudit && !htmlAudit) continue;
      const at = item.rewritten_at || item.finished_at || htmlAudit?.audited_at || markdownAudit?.audited_at || '';
      const existing = out.get(item.slug);
      if (existing && existing.at > at) continue;
      const p = (item.output_rel_path || item.html_rel_path || '').toLowerCase();
      const outputFormat = item.output_format === 'html' || p.endsWith('.html') ? 'html' : 'markdown';
      out.set(item.slug, {
        at,
        outputFormat,
        markdown: markdownAudit,
        html: htmlAudit,
      });
    } catch {
      /* ignore malformed trace */
    }
  }
  return out;
}

function snapshot(
  mode: 'markdown' | 'html',
  audit: SeoAuditRecord | null,
): RewriteAuditSnapshot | null {
  if (!audit) return null;
  return {
    audit_mode: mode,
    label: mode === 'markdown' ? 'Markdown SEO/GEO' : 'Final HTML SEO/GEO',
    audited_at: audit.audited_at || null,
    seo_score: audit.seo_score,
    geo_score: audit.geo_score,
    checks: audit.checks,
    summary: audit.summary,
  };
}

function buildRewriteImpact(
  original: SeoAuditRecord,
  rewrite: RewriteAuditPair | undefined,
): RewriteAuditImpact | null {
  if (!rewrite) return null;
  const markdown = snapshot('markdown', rewrite.markdown);
  const html = snapshot('html', rewrite.html);
  const active = html ?? markdown;
  if (!active) return null;
  const markdownDelta = markdown
    ? { seo_score: markdown.seo_score - original.seo_score, geo_score: markdown.geo_score - original.geo_score }
    : null;
  const htmlDelta = html
    ? { seo_score: html.seo_score - original.seo_score, geo_score: html.geo_score - original.geo_score }
    : null;
  const activeDelta = active.audit_mode === 'html' ? htmlDelta! : markdownDelta!;
  return {
    rewritten_at: rewrite.at || null,
    output_format: rewrite.outputFormat,
    updated_kind: active.audit_mode,
    prev: {
      seo_score: original.seo_score,
      geo_score: original.geo_score,
      checks: original.checks,
    },
    updated: {
      seo_score: active.seo_score,
      geo_score: active.geo_score,
      checks: active.checks,
      summary: active.summary,
    },
    markdown,
    html,
    delta: {
      seo_score: activeDelta.seo_score,
      geo_score: activeDelta.geo_score,
    },
    deltas: {
      markdown: markdownDelta,
      html: htmlDelta,
    },
  };
}

export function resolveAuditList(cfg: AppConfig): Array<Record<string, unknown>> {
  const fromDb = readSeoAuditRecords(cfg);
  if (fromDb.length > 0) {
    const rewriteAudits = latestRewriteAuditBySlug(cfg);
    return fromDb.map(
      (r) =>
        ({
          slug: r.slug,
          title: r.title,
          seo_score: r.seo_score,
          geo_score: r.geo_score,
          audited_at: r.audited_at,
          summary: r.summary,
          model: r.model,
          checks: r.checks,
          rewrite_impact: buildRewriteImpact(r, rewriteAudits.get(r.slug)),
        }) as Record<string, unknown>,
    );
  }
  return buildAuditFallbackFromWordPress(cfg);
}

type AuditEntry = { slug: string; seo_score: number; geo_score: number; audited_at: string };

export function getResolvedAuditForStats(cfg: AppConfig): { rows: AuditEntry[]; fromDatabase: boolean } {
  const fromDb = readSeoAuditRecords(cfg);
  if (fromDb.length > 0) {
    return {
      rows: fromDb.map((r) => ({
        slug: r.slug,
        seo_score: r.seo_score,
        geo_score: r.geo_score,
        audited_at: r.audited_at,
      })),
      fromDatabase: true,
    };
  }
  const fb = buildAuditFallbackFromWordPress(cfg) as Array<AuditEntry & Record<string, unknown>>;
  if (fb.length) return { rows: fb, fromDatabase: false };
  return { rows: [], fromDatabase: false };
}

export function getBlogStatsResponse(cfg: AppConfig) {
  const p = blogPaths(cfg);
  const schedulerQueue = readJsonSafe<
    Record<string, { slug: string; status: string; error?: string | null; updated_at?: string }>
  >(p.blogQueue);
  const { rows: audit } = getResolvedAuditForStats(cfg);
  const hasAudit = audit.length > 0;

  let totalOnDisk = 0;
  const onDiskSlugs = new Set<string>();
  try {
    if (fs.existsSync(p.contentDir)) {
      for (const f of fs.readdirSync(p.contentDir)) {
        if (f.endsWith('.md')) {
          totalOnDisk++;
          onDiskSlugs.add(f.replace('.md', ''));
        }
      }
    }
  } catch {
    /* dir missing */
  }
  if (totalOnDisk === 0 && !hasAudit) {
    try {
      if (fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
        const wpN = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
        try {
          const has = wpN
            .prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name='wp_articles'`)
            .get() as { x: number } | undefined;
          if (has) {
            const slugs = wpN
              .prepare(`SELECT slug FROM wp_articles WHERE ${sqlWpTypesDashboardClause()}`)
              .all() as Array<{ slug: string }>;
            for (const { slug } of slugs) onDiskSlugs.add(slug);
            totalOnDisk = slugs.length;
          }
        } finally {
          wpN.close();
        }
      }
    } catch {
      /* no v2 / wp table */
    }
  }

  let rewriteDone = 0;
  let rewritePending = 0;
  let rewriteFailed = 0;
  let rewriteReady = 0;
  let rewriteUploaded = 0;
  let firstRewriteDate: string | null = null;
  let lastRewriteDate: string | null = null;
  if (schedulerQueue) {
    for (const [slug, entry] of Object.entries(schedulerQueue)) {
      if (!onDiskSlugs.has(slug)) continue;
      if (entry.status === 'done') {
        rewriteDone++;
        if (entry.updated_at) {
          if (!firstRewriteDate || entry.updated_at < firstRewriteDate) firstRewriteDate = entry.updated_at;
          if (!lastRewriteDate || entry.updated_at > lastRewriteDate) lastRewriteDate = entry.updated_at;
        }
      } else if (entry.status === 'failed') rewriteFailed++;
      else rewritePending++;
    }
    for (const slug of onDiskSlugs) {
      if (!schedulerQueue[slug]) rewritePending++;
    }
  } else {
    rewritePending = totalOnDisk;
  }

  // New pipeline source of truth: rewrite staging index (filesystem, not legacy queue JSON).
  // If present, prefer these counts so overview cards match the rewrite/upload UI.
  const staging = readStagingIndex(cfg);
  if (staging.length > 0) {
    rewriteReady = staging.filter((x) => x.status === 'rewritten').length;
    rewriteUploaded = staging.filter((x) => x.status === 'done').length;
    rewriteFailed = staging.filter((x) => x.status === 'failed').length;
    rewriteDone = rewriteUploaded;
    rewritePending = rewriteReady;
    for (const it of staging) {
      const at = (it.finished_at || it.rewritten_at || '').trim();
      if (!at) continue;
      if (!firstRewriteDate || at < firstRewriteDate) firstRewriteDate = at;
      if (!lastRewriteDate || at > lastRewriteDate) lastRewriteDate = at;
    }
  }

  let interlinkProcessedCount = 0;
  try {
    if (fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
      const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
      try {
        const has = db
          .prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name='interlinking_state'`)
          .get() as { x: number } | undefined;
        if (has) {
          const row = db
            .prepare('SELECT suggestions_json FROM interlinking_state WHERE id = 1')
            .get() as { suggestions_json: string | null } | undefined;
          if (row?.suggestions_json?.trim()) {
            const o = JSON.parse(row.suggestions_json) as Record<
              string,
              { inbound?: unknown[]; outbound?: unknown[] }
            >;
            interlinkProcessedCount = Object.values(o || {}).filter((v) => {
              const ins = Array.isArray(v?.inbound) ? v.inbound.length : 0;
              const outs = Array.isArray(v?.outbound) ? v.outbound.length : 0;
              return ins + outs > 0;
            }).length;
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    /* interlinking table may be absent on older resets */
  }

  const auditCount = audit.length;
  const seoScored = audit.filter((a) => a.seo_score > 0);
  const geoScored = audit.filter((a) => a.geo_score > 0);
  const avgSeo = seoScored.length ? Math.round(seoScored.reduce((s, a) => s + a.seo_score, 0) / seoScored.length) : 0;
  const avgGeo = geoScored.length ? Math.round(geoScored.reduce((s, a) => s + a.geo_score, 0) / geoScored.length) : 0;
  const above60 = audit.filter((a) => a.seo_score >= 60).length;

  const seoDist = { poor: 0, fair: 0, good: 0, excellent: 0 };
  const geoDist = { poor: 0, fair: 0, good: 0, excellent: 0 };
  for (const a of seoScored) {
    if (a.seo_score < 40) seoDist.poor++;
    else if (a.seo_score < 60) seoDist.fair++;
    else if (a.seo_score < 80) seoDist.good++;
    else seoDist.excellent++;
  }
  for (const a of geoScored) {
    if (a.geo_score < 40) geoDist.poor++;
    else if (a.geo_score < 60) geoDist.fair++;
    else if (a.geo_score < 80) geoDist.good++;
    else geoDist.excellent++;
  }

  const articlesPerDay = 4;
  const daysRemaining = rewritePending > 0 ? Math.ceil(rewritePending / articlesPerDay) : 0;
  const etaDate =
    daysRemaining > 0 ? new Date(Date.now() + daysRemaining * 86400000).toISOString().slice(0, 10) : null;

  return {
    rewriteDone,
    rewriteTotal: totalOnDisk,
    rewritePending,
    rewriteFailed,
    rewriteReady,
    rewriteUploaded,
    auditCount,
    seoScoredCount: seoScored.length,
    geoScoredCount: geoScored.length,
    avgSeo,
    avgGeo,
    above60,
    seoDist,
    geoDist,
    perfSummary: null,
    firstRewriteDate,
    lastRewriteDate,
    schedulerQueueLen: rewritePending,
    interlinkProcessedCount,
    eta: {
      daysRemaining,
      estimatedDate: etaDate,
      articlesPerDay,
    },
    lastActivity: {
      rewriteProgress: fileMtimeSafe(p.rewriteProgress),
      /** ISO timestamp of latest row in `seo_audits` (same dashboard SQLite as WordPress sync). */
      auditResults: getLatestSeoAuditAt(cfg),
      schedulerQueue: fileMtimeSafe(p.blogQueue),
      schedulerLog: fileMtimeSafe(p.schedulerLog),
    },
  };
}
