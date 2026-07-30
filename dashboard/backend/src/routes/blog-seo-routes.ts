import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { isWriteAuthorized } from '../lib/write-auth.js';
import { getBlogStatsResponse, resolveAuditList } from '../lib/blog-seo-helpers.js';
import { deleteSeoAuditRecord, getSeoAuditRunState, startSeoAuditJob } from '../lib/seo-audit.js';

function failCount(article: Record<string, unknown>): number {
  return Object.values((article.checks as Record<string, { status: string }>) ?? {}).filter(
    (c) => c?.status === 'FAIL',
  ).length;
}

export function createBlogSeoRouter(cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();

  r.get('/api/blog/stats', (c) => {
    try {
      return c.json(getBlogStatsResponse(cfg));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/audit', (c) => {
    try {
      const audit = resolveAuditList(cfg);
      if (!audit.length) {
        return c.json({ articles: [], total: 0, topIssues: [] });
      }
      const limit = Math.min(200, parseInt(c.req.query('limit') ?? '100', 10));
      const offset = parseInt(c.req.query('offset') ?? '0', 10);
      const sortBy = c.req.query('sort') ?? 'seo_score';
      const order = c.req.query('order') ?? 'asc';

      const sorted = [...audit].sort((a, b) => {
        if (sortBy === 'failCount') {
          const av = failCount(a);
          const bv = failCount(b);
          return order === 'asc' ? av - bv : bv - av;
        }
        const av = (a[sortBy] as number) ?? 0;
        const bv = (b[sortBy] as number) ?? 0;
        return order === 'asc' ? av - bv : bv - av;
      });

      const issueCounts: Record<string, number> = {};
      for (const article of audit) {
        const checks = article.checks as Record<string, { status: string }> | undefined;
        if (!checks) continue;
        for (const [key, val] of Object.entries(checks)) {
          if (val?.status === 'FAIL') {
            issueCounts[key] = (issueCounts[key] ?? 0) + 1;
          }
        }
      }
      const topIssues = Object.entries(issueCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([issue, count]) => ({ issue, count }));

      return c.json({
        articles: sorted.slice(offset, offset + limit).map((a) => {
          const raw = a as Record<string, unknown>;
          const checks = (raw.checks as Record<string, { status: string; note?: string }>) ?? {};
          return {
            slug: raw.slug,
            title: raw.title,
            seo_score: raw.seo_score,
            geo_score: raw.geo_score,
            audited_at: raw.audited_at,
            failCount: Object.values(checks).filter((x) => x?.status === 'FAIL').length,
            summary: (typeof raw.summary === 'string' ? raw.summary : null) as string | null,
            checks,
            rewriteImpact: raw.rewrite_impact ?? null,
            model: (typeof raw.model === 'string' ? raw.model : null) as string | null,
            synthetic: Boolean(raw._synthetic),
          };
        }),
        total: audit.length,
        topIssues,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/audit/run-state', (c) => c.json(getSeoAuditRunState()));

  r.post('/api/blog/audit/run', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string; limit?: number };
    const limit = Math.min(50, Math.max(1, body.limit ?? 10));
    const pause = Math.max(
      0,
      cfg.SEO_AUDIT_PAUSE_MS ?? (parseInt(process.env.SEO_AUDIT_PAUSE_MS || '2000', 10) || 2000),
    );
    const start = startSeoAuditJob(cfg, {
      slugs: body.slug ? [body.slug] : undefined,
      limit: body.slug ? 1 : limit,
      pauseMs: pause,
    });
    return c.json({ ...start, state: getSeoAuditRunState() });
  });

  r.post('/api/blog/audit/delete', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
    const slug = typeof body.slug === 'string' ? body.slug : '';
    try {
      const result = deleteSeoAuditRecord(cfg, slug);
      if (!result.ok && result.notFound) {
        return c.json({ error: result.message }, 404);
      }
      if (!result.ok) {
        return c.json({ error: result.message }, 400);
      }
      return c.json({ ok: true, message: result.message });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return r;
}
