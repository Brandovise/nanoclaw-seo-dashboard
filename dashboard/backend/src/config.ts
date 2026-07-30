import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** `dashboard/backend/src` → monorepo root (nanoclaw-seo-dashboard) */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DASHBOARD_API_HOST: z.string().default('0.0.0.0'),
  DASHBOARD_API_PORT: z.coerce.number().default(3002),
  NANOCLAW_DATA_DIR: z.string().min(1),
  NANOCLAW_LOG_PATH: z.string().optional(),
  NANOCLAW_GROUPS_DIR: z.string().optional(),
  DASHBOARD_SQLITE_PATH: z.string().min(1),
  DASHBOARD_BASIC_AUTH_USER: z.string().optional(),
  DASHBOARD_BASIC_AUTH_PASSWORD: z.string().optional(),
  DASHBOARD_WRITE_TOKEN: z.string().optional(),
  /** Blog queue, content dir, etc.; default `dashboard/data/blog`. SEO audit rows are in DASHBOARD_SQLITE_PATH (`seo_audits`), not JSON. */
  DASHBOARD_BLOG_DATA_DIR: z.string().optional(),
  MAX_CONCURRENT_CONTAINERS: z.coerce.number().default(5),
  NANOCLAW_SRC_DIR: z.string().optional(),
  WP_SITE_URL: z.string().optional(),
  WP_USERNAME: z.string().optional(),
  WP_APP_PASSWORD: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  SEO_AUDIT_MODEL: z.string().optional(),
  SEO_AUDIT_MAX_CONTENT_CHARS: z.coerce.number().optional(),
  SEO_AUDIT_PAUSE_MS: z.coerce.number().optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  v2DbPath: string;
  v2SessionsDir: string;
  resolvedLogPath: string;
  resolvedGroupsDir: string;
  resolvedSrcDir: string;
  resolvedBlogDataDir: string;
  backendRoot: string;
  /** Monorepo root (parent of `dashboard/`) */
  repoRoot: string;
};

function applyEnvFile(p: string): void {
  const content = fs.readFileSync(p, 'utf8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const cur = process.env[k];
    if (cur !== undefined && cur !== '') continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

/** Merge multiple .env files (repo root first, then cwd) so keys like ANTHROPIC_API_KEY are not missed. */
function findEnvFile(): void {
  const candidates = [
    path.join(REPO_ROOT, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '..', '.env'),
  ];
  const seen = new Set<string>();
  for (const p of candidates) {
    const abs = path.resolve(p);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);
    applyEnvFile(abs);
  }
}

let _config: AppConfig | null = null;

function resolveFromRepo(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export function loadConfig(): AppConfig {
  if (_config) return _config;
  findEnvFile();
  const raw = schema.parse(process.env);
  const dataDir = resolveFromRepo(raw.NANOCLAW_DATA_DIR);
  const v2DbPath = path.join(dataDir, 'v2.db');
  const v2SessionsDir = path.join(dataDir, 'v2-sessions');
  const resolvedLogPath = raw.NANOCLAW_LOG_PATH
    ? resolveFromRepo(raw.NANOCLAW_LOG_PATH)
    : path.join(path.dirname(dataDir), 'logs', 'nanoclaw.log');
  const resolvedGroupsDir = raw.NANOCLAW_GROUPS_DIR ? resolveFromRepo(raw.NANOCLAW_GROUPS_DIR) : path.join(REPO_ROOT, 'groups');
  const resolvedSrcDir = raw.NANOCLAW_SRC_DIR ? resolveFromRepo(raw.NANOCLAW_SRC_DIR) : path.join(REPO_ROOT, 'src');
  const backendRoot = path.resolve(__dirname, '..');
  const sqlitePath = resolveFromRepo(raw.DASHBOARD_SQLITE_PATH);
  const blogDataDir = resolveFromRepo(raw.DASHBOARD_BLOG_DATA_DIR || 'dashboard/data/blog');

  _config = {
    ...raw,
    DASHBOARD_SQLITE_PATH: sqlitePath,
    resolvedBlogDataDir: blogDataDir,
    v2DbPath,
    v2SessionsDir,
    resolvedLogPath,
    resolvedGroupsDir,
    resolvedSrcDir,
    backendRoot,
    repoRoot: REPO_ROOT,
  };
  return _config;
}
