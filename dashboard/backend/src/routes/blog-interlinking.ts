/**
 * Interlinking APIs: WordPress-derived link graph, Claude suggestions, legacy link-graph shape.
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from '../lib/logger.js';
import {
  getInterlinkingChangesPayload,
  getInterlinkingPayload,
  getInterlinkingRunState,
  getLinkGraphCompatPayload,
  invalidateInterlinkingGraphTouch,
  startInterlinkingSuggestionsJob,
} from '../lib/interlinking.js';
import { isWriteAuthorized } from '../lib/write-auth.js';

export function createBlogInterlinkingRouter(cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();

  /** Legacy path used by `interlinking_agent.py` — same shape as WP-derived graph with slug ids. */
  r.get('/api/blog/link-graph', (c) => {
    try {
      return c.json(getLinkGraphCompatPayload());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/interlinking', (c) => {
    try {
      return c.json(getInterlinkingPayload(cfg));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/interlinking/run-state', (c) => {
    try {
      return c.json(getInterlinkingRunState());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post('/api/blog/interlinking/run', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      limit?: number;
      resume?: boolean;
      problemScope?: string;
      /** WordPress content type filter: all | post | page */
      wpType?: string;
    };
    const limit = Math.min(50, Math.max(1, body.limit ?? 10));
    const resume = body.resume !== false;
    const problemScope = body.problemScope;
    const wpType = typeof body.wpType === 'string' ? body.wpType : '';
    const start = startInterlinkingSuggestionsJob(cfg, { limit, resume, problemScope, wpType });
    if (start.started) {
      log.info(
        { limit, resume, problemScope, wpType: wpType || undefined },
        'POST /api/blog/interlinking/run: job started',
      );
    }
    return c.json({ ...start, state: getInterlinkingRunState() });
  });

  r.get('/api/blog/interlinking-changes', (c) => {
    try {
      return c.json(getInterlinkingChangesPayload());
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /** No write token required (legacy compat with `interlinking_agent.py`); only records a server-side timestamp. */
  r.post('/api/blog/invalidate-link-graph', (c) => {
    try {
      invalidateInterlinkingGraphTouch(cfg);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return r;
}
