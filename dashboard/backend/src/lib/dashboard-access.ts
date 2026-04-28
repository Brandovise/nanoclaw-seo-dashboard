import type { Context } from 'hono';
import type { AppConfig } from '../config.js';
import { DASHBOARD_SESSION_COOKIE, isSessionValid } from './auth-session.js';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function parseBasicAuth(authorization: string | undefined): { user: string; pass: string } | null {
  if (!authorization?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i === -1) return null;
    return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

function credentialsConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.DASHBOARD_BASIC_AUTH_USER && cfg.DASHBOARD_BASIC_AUTH_PASSWORD);
}

export function isDashboardAccessAuthorized(c: Context, cfg: AppConfig): boolean {
  if (!credentialsConfigured(cfg)) return true;
  const cookies = parseCookies(c.req.header('Cookie'));
  if (isSessionValid(cookies[DASHBOARD_SESSION_COOKIE])) return true;
  const basic = parseBasicAuth(c.req.header('Authorization') ?? c.req.header('authorization'));
  if (
    basic &&
    basic.user === cfg.DASHBOARD_BASIC_AUTH_USER &&
    basic.pass === cfg.DASHBOARD_BASIC_AUTH_PASSWORD
  ) {
    return true;
  }
  return false;
}

export function isCredentialsRequired(cfg: AppConfig): boolean {
  return credentialsConfigured(cfg);
}
