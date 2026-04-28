/**
 * Real WordPress REST sync + link graph (ported from incofin dashboard).
 */
import fs from 'node:fs';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from '../lib/logger.js';
import { isWriteAuthorized } from '../lib/write-auth.js';
import { resolveAuditList } from '../lib/blog-seo-helpers.js';
import {
  getWpGraph,
  getWpFeatureCoverage,
  getWpSyncCsvPath,
  getWpSyncState,
  listWpArticles,
  rebuildWpGraphHtml,
  startWpSyncJob,
} from '../lib/wordpress-sync.js';

export function createBlogWordpressRouter(cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();

  r.get('/api/blog/wp-sync/state', (c) => {
    try {
      return c.json(getWpSyncState());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post('/api/blog/wp-sync/run', (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const start = startWpSyncJob();
    if (start.started) {
      log.info({ ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '—' }, 'POST /api/blog/wp-sync/run: sync job started');
    } else {
      log.info('POST /api/blog/wp-sync/run: sync already running');
    }
    return c.json({ ...start, state: getWpSyncState() });
  });

  r.get('/api/blog/wp-sync/csv', (c) => {
    const csvPath = getWpSyncCsvPath();
    if (!fs.existsSync(csvPath)) {
      return c.json({ error: 'CSV snapshot not found. Run sync first.' }, 404);
    }
    return new Response(fs.createReadStream(csvPath) as unknown as BodyInit, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="wp_articles.csv"',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  r.get('/api/blog/wp-articles', (c) => {
    try {
      const q = c.req.query('q') || c.req.query('search');
      const data = listWpArticles({
        type: c.req.query('type') || undefined,
        status: c.req.query('status') || undefined,
        category: c.req.query('category') || undefined,
        search: q || undefined,
        limit: parseInt(c.req.query('limit') || '100', 10),
        offset: parseInt(c.req.query('offset') || '0', 10),
      });
      return c.json(data);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/wp-link-graph', (c) => {
    try {
      return c.json(getWpGraph());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/wp-feature-coverage', (c) => {
    try {
      const auditRows = resolveAuditList(cfg);
      const auditSlugs = auditRows.map((a) => String(a.slug || '')).filter(Boolean);
      return c.json(
        getWpFeatureCoverage({
          auditSlugs,
          queueSlugs: [],
          performanceSlugs: [],
        }),
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post('/api/blog/wp-graph/rebuild', (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const rebuilt = rebuildWpGraphHtml();
    return c.json(rebuilt, rebuilt.ok ? 200 : 500);
  });

  return r;
}
