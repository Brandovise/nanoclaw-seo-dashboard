/**
 * Content rewrite pipeline API — staging snapshot (filesystem) + run state.
 */
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from '../lib/logger.js';
import {
  clearContentRewriteStaging,
  deleteRewriteQueueItem,
  getContentRewritePipelineState,
  getRewriteItemPreview,
  getRewriteQueueApiPayload,
  requestContentRewritePipelineStop,
  startContentRewritePipelineJob,
  uploadRewriteItemToWordpress,
} from '../lib/content-rewrite-pipeline.js';
import { isWriteAuthorized } from '../lib/write-auth.js';

export function createBlogRewritePipelineRouter(cfg: AppConfig, _seo: Database.Database): Hono {
  const r = new Hono();

  r.get('/api/blog/rewrite-queue', (c) => {
    try {
      return c.json(getRewriteQueueApiPayload(cfg));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/rewrite-pipeline/state', (c) => {
    try {
      const mem = getContentRewritePipelineState();
      const payload = getRewriteQueueApiPayload(cfg);
      return c.json({
        ...mem,
        run: payload.run,
        queueLength: payload.queue.length,
        doneLength: payload.done.length,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.get('/api/blog/rewrite-pipeline/item/:id', (c) => {
    try {
      const id = decodeURIComponent(c.req.param('id') || '').trim();
      if (!id) return c.json({ error: 'Invalid item id' }, 400);
      const preview = getRewriteItemPreview(cfg, id);
      if (!preview) return c.json({ error: 'Not found or no rewritten HTML yet.' }, 404);
      return c.json(preview);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post('/api/blog/rewrite-pipeline/upload', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as { itemId?: string | number };
    const itemId =
      typeof body.itemId === 'string' ? body.itemId.trim() : body.itemId != null ? String(body.itemId).trim() : '';
    if (!itemId) {
      return c.json({ error: 'itemId required' }, 400);
    }
    try {
      const result = await uploadRewriteItemToWordpress(cfg, itemId);
      if (result.ok) {
        log.info({ itemId }, 'POST /api/blog/rewrite-pipeline/upload');
      }
      return c.json({ ...result, state: getContentRewritePipelineState() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.delete('/api/blog/rewrite-pipeline/item/:id', (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const id = decodeURIComponent(c.req.param('id') || '').trim();
    if (!id) return c.json({ error: 'Invalid item id' }, 400);
    try {
      const result = deleteRewriteQueueItem(cfg, id);
      if (result.ok) {
        log.info({ itemId: id }, 'DELETE /api/blog/rewrite-pipeline/item');
      }
      return c.json({ ...result, state: getContentRewritePipelineState() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post('/api/blog/rewrite-pipeline/stop', (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const out = requestContentRewritePipelineStop();
    if (out.ok) {
      log.info('POST /api/blog/rewrite-pipeline/stop');
    }
    return c.json({ ...out, state: getContentRewritePipelineState() });
  });

  r.post('/api/blog/rewrite-pipeline/clear', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    try {
      const result = await clearContentRewriteStaging(cfg);
      if (result.ok) {
        log.info({ pathsRemoved: result.pathsRemoved }, 'POST /api/blog/rewrite-pipeline/clear');
      }
      return c.json({ ...result, state: getContentRewritePipelineState() });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e), state: getContentRewritePipelineState() }, 500);
    }
  });

  r.post('/api/blog/rewrite-pipeline/run', async (c) => {
    if (!isWriteAuthorized(c, cfg)) {
      return c.json({ error: 'Unauthorized write request' }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      threshold?: number;
      limit?: number;
      dryRun?: boolean;
    };
    const start = startContentRewritePipelineJob(cfg, {
      threshold: body.threshold,
      limit: body.limit,
      dryRun: body.dryRun,
    });
    if (start.started) {
      log.info({ threshold: body.threshold, limit: body.limit, dryRun: body.dryRun }, 'POST /api/blog/rewrite-pipeline/run');
    }
    return c.json({ ...start, state: getContentRewritePipelineState() });
  });

  return r;
}
