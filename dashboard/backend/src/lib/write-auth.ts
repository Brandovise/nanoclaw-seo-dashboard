import type { Context } from 'hono';
import type { AppConfig } from '../config.js';

/** Matches incofin dashboard: optional Bearer or x-dashboard-token when DASHBOARD_WRITE_TOKEN is set. */
export function isWriteAuthorized(c: Context, cfg: AppConfig): boolean {
  const token = cfg.DASHBOARD_WRITE_TOKEN;
  if (!token) return true;
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const x = (c.req.header('x-dashboard-token') || '').trim();
  return bearer === token || x === token;
}
