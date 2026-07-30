import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { fileMtimeSafe, readJsonSafe } from './fs-utils.js';
import { getLatestSeoAuditAt, readSeoAuditRecords } from './seo-audit.js';

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

export function resolveAuditList(cfg: AppConfig): Array<Record<string, unknown>> {
  const fromDb = readSeoAuditRecords(cfg);
  if (fromDb.length > 0) {
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
            const slugs = wpN.prepare('SELECT slug FROM wp_articles').all() as Array<{ slug: string }>;
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
