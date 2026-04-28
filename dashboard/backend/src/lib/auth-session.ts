import crypto from 'node:crypto';

export const DASHBOARD_SESSION_COOKIE = 'nanoclaw_dashboard_session';
export const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sessions = new Map<string, number>();

export function createDashboardSessionToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + DASHBOARD_SESSION_TTL_MS);
  return token;
}

export function deleteDashboardSessionToken(token: string | undefined): void {
  if (token) sessions.delete(token);
}

export function isSessionValid(token: string | undefined): boolean {
  if (!token) return false;
  const exp = sessions.get(token) ?? 0;
  if (exp <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}
