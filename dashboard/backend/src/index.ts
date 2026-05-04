import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config.js';
import { log } from './lib/logger.js';
import { initSeoDb } from './lib/nanoclaw-db.js';
import { migrateSeoAuditJsonToDbIfNeeded } from './lib/seo-audit-migrate.js';
import { initWordpressModule } from './lib/wordpress-sync.js';
import { isDashboardAccessAuthorized } from './lib/dashboard-access.js';
import { createNanoclawRouter } from './routes/nanoclaw.js';
import { createBlogWordpressRouter } from './routes/blog-wordpress.js';
import { createBlogSeoRouter } from './routes/blog-seo-routes.js';
import { createDashboardSessionRouter } from './routes/dashboard-session-routes.js';
import { createBlogInterlinkingRouter } from './routes/blog-interlinking.js';
import { createBlogRewritePipelineRouter } from './routes/blog-rewrite-pipeline.js';
import { createBlogRouter } from './routes/blog-stub.js';
import { dropLegacyRewriteQueueTables } from './lib/content-rewrite-pipeline.js';

const cfg = loadConfig();
initWordpressModule(cfg);
const seo = initSeoDb(cfg.DASHBOARD_SQLITE_PATH);
migrateSeoAuditJsonToDbIfNeeded(cfg, seo);
dropLegacyRewriteQueueTables(cfg);

function isPublicPath(method: string, path: string): boolean {
  if (path === '/health' || path === '/api/health') return true;
  if (path === '/api/dashboard/auth-status') return true;
  if (path === '/api/dashboard/login' && method === 'POST') return true;
  if (path === '/api/dashboard/logout' && method === 'POST') return true;
  if (method === 'OPTIONS') return true;
  return false;
}

const app = new Hono();
app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.get('/health', (c) => c.json({ ok: true, service: 'nanoclaw-dashboard-api' }));
app.get('/api/health', (c) => c.json({ ok: true, service: 'nanoclaw-dashboard-api' }));

app.use('/*', async (c, next) => {
  if (isPublicPath(c.req.method, c.req.path)) return next();
  if (!isDashboardAccessAuthorized(c, cfg) && c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

app.route('/', createDashboardSessionRouter(cfg));
app.route('/', createNanoclawRouter(cfg, seo));
app.route('/', createBlogWordpressRouter(cfg, seo));
app.route('/', createBlogSeoRouter(cfg, seo));
app.route('/', createBlogInterlinkingRouter(cfg, seo));
app.route('/', createBlogRewritePipelineRouter(cfg, seo));
app.route('/', createBlogRouter(cfg, seo));

serve(
  {
    fetch: app.fetch,
    port: cfg.DASHBOARD_API_PORT,
    hostname: cfg.DASHBOARD_API_HOST,
  },
  (info) => {
    log.info({ port: info.port, host: info.address, repo: cfg.repoRoot }, 'dashboard API listening');
  },
);
