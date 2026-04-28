/**
 * Blog / SEO `/api/blog/*` — stubs so reference UI loads; extend with real WP/GSC later.
 * All paths stay under dashboard/backend (no code outside this package except env).
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

function j(c: { json: (a: unknown) => Response }, data: unknown) {
  return c.json(data);
}

export function createBlogRouter(_cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();
  const empty = {
    stats: { queue: 0, articles: 0 },
    articles: { articles: [], total: 0 },
    audit: { items: [] },
    scheduler: { tasks: [] },
    insights: { rows: [] },
  };

  r.get('/api/blog/scheduler', (c) => j(c, empty.scheduler));
  r.get('/api/blog/performance-status', (c) => j(c, { ok: true }));
  r.get('/api/blog/article-keywords', (c) => j(c, { keywords: [] }));
  r.get('/api/blog/article-performance', (c) => j(c, { rows: [] }));
  r.get('/api/blog/insights', (c) => j(c, empty.insights));
  r.get('/api/blog/daily-traffic', (c) => j(c, { days: [] }));
  r.get('/api/blog/performance-kpis', (c) => j(c, { kpis: [] }));
  r.get('/api/blog/agents', (c) => j(c, { agents: [] }));
  r.get('/api/blog/agent-source', (c) => j(c, { content: '' }));
  r.post('/api/blog/agent-source', (c) => j(c, { lines: 0, message: 'read_only_stub' }));
  r.get('/api/blog/affiliates', (c) => j(c, { affiliates: [] }));
  r.get('/api/blog/affiliates/history', (c) => j(c, { history: [] }));
  r.get('/api/blog/affiliates/refresh', (c) => j(c, { ok: true }));
  r.get('/api/blog/rewrite-queue', (c) => j(c, { items: [] }));
  r.get('/api/blog/interlinking', (c) => j(c, { suggestions: [] }));
  r.get('/api/blog/interlinking-changes', (c) => j(c, { changes: [] }));
  r.get('/api/blog/cannibalism', (c) => j(c, { gscGroups: [], structuralGroups: [], lastRun: null }));
  r.post('/api/blog/invalidate-link-graph', (c) => j(c, { ok: true }));

  return r;
}
