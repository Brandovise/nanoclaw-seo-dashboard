import { Hono } from 'hono';
import type { AppConfig } from '../config.js';
import {
  createDashboardSessionToken,
  deleteDashboardSessionToken,
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_TTL_MS,
  isSessionValid,
} from '../lib/auth-session.js';
import { isCredentialsRequired } from '../lib/dashboard-access.js';

function getCookieFromHeader(h: string | undefined, name: string): string | undefined {
  if (!h) return undefined;
  for (const p of h.split(';')) {
    const i = p.indexOf('=');
    if (i === -1) continue;
    if (p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return undefined;
}

export function createDashboardSessionRouter(cfg: AppConfig): Hono {
  const r = new Hono();

  r.get('/api/dashboard/auth-status', (c) => {
    const required = isCredentialsRequired(cfg);
    const tok = getCookieFromHeader(c.req.header('Cookie'), DASHBOARD_SESSION_COOKIE);
    const loggedIn = isSessionValid(tok);
    return c.json({ required, loggedIn });
  });

  r.post('/api/dashboard/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    if (!cfg.DASHBOARD_BASIC_AUTH_USER || !cfg.DASHBOARD_BASIC_AUTH_PASSWORD) {
      return c.json(
        {
          error: 'DASHBOARD_BASIC_AUTH_USER and DASHBOARD_BASIC_AUTH_PASSWORD are not set on the server.',
        },
        500,
      );
    }
    if (body.username !== cfg.DASHBOARD_BASIC_AUTH_USER || body.password !== cfg.DASHBOARD_BASIC_AUTH_PASSWORD) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const token = createDashboardSessionToken();
    c.header(
      'Set-Cookie',
      `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)}`,
    );
    return c.json({ ok: true });
  });

  r.post('/api/dashboard/logout', (c) => {
    const tok = getCookieFromHeader(c.req.header('Cookie'), DASHBOARD_SESSION_COOKIE);
    deleteDashboardSessionToken(tok);
    c.header('Set-Cookie', `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return c.json({ ok: true });
  });

  return r;
}
