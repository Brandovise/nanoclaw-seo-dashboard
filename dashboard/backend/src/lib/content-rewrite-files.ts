/**
 * On-disk storage for rewritten HTML + JSON staging index (no rewrite queue in SQLite).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

const STAGING_INDEX = 'staging-index.json';
const STAGING_DIR = 'staging';

export type RewriteStagingItem = {
  id: string;
  slug: string;
  wp_id: number;
  wp_type: string;
  source_url: string | null;
  seo_score: number | null;
  status: 'rewritten' | 'done' | 'failed';
  rewritten_title: string | null;
  draft_slug: string | null;
  html_rel_path: string | null;
  research_notes: string | null;
  diagnosis_json: string | null;
  /** JSON trace of multi-agent rounds (reviewer scores, approve flag), for operators only. */
  orchestrator_trace_json?: string | null;
  rewritten_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  draft_wp_id: number | null;
  draft_wp_link: string | null;
  dry_run: boolean;
};

function rewriteRootAbs(cfg: AppConfig): string {
  return path.resolve(cfg.resolvedRewriteFilesDir);
}

function assertUnderRoot(rootAbs: string, fileAbs: string): void {
  const sep = path.sep;
  if (!(fileAbs === rootAbs || fileAbs.startsWith(rootAbs + sep))) {
    throw new Error('Rewrite file path escapes storage root');
  }
}

function stagingIndexAbs(cfg: AppConfig): string {
  return path.join(rewriteRootAbs(cfg), STAGING_INDEX);
}

export function newRewriteStagingId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function readStagingIndex(cfg: AppConfig): RewriteStagingItem[] {
  const p = stagingIndexAbs(cfg);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const o = JSON.parse(raw) as { items?: RewriteStagingItem[] };
    return Array.isArray(o.items) ? o.items : [];
  } catch {
    return [];
  }
}

export function writeStagingIndex(cfg: AppConfig, items: RewriteStagingItem[]): void {
  const root = rewriteRootAbs(cfg);
  fs.mkdirSync(root, { recursive: true });
  const p = stagingIndexAbs(cfg);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function upsertStagingItem(cfg: AppConfig, item: RewriteStagingItem): void {
  const items = readStagingIndex(cfg);
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) items.push(item);
  else items[i] = item;
  writeStagingIndex(cfg, items);
}

export function getStagingItemById(cfg: AppConfig, id: string): RewriteStagingItem | undefined {
  return readStagingIndex(cfg).find((x) => x.id === id);
}

/** Best-effort delete of stored HTML; ignores missing file. */
export function deleteRewriteHtmlFile(cfg: AppConfig, relativePath: string): void {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('..')) {
    throw new Error('Invalid rewrite file path');
  }
  const root = rewriteRootAbs(cfg);
  const abs = path.resolve(root, ...trimmed.split('/').filter(Boolean));
  assertUnderRoot(root, abs);
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw e;
  }
  try {
    const dir = path.dirname(abs);
    if (dir !== root && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    /* ignore */
  }
}

export function removeStagingItemById(cfg: AppConfig, id: string): boolean {
  const items = readStagingIndex(cfg);
  const idx = items.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  const [removed] = items.splice(idx, 1);
  writeStagingIndex(cfg, items);
  const rel = removed.html_rel_path?.trim();
  if (rel) {
    try {
      deleteRewriteHtmlFile(cfg, rel);
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** Write UTF-8 HTML under `staging/{id}.html`; returns relative POSIX path. */
export function writeStagingHtmlFile(cfg: AppConfig, stagingId: string, html: string): string {
  const rel = `${STAGING_DIR}/${stagingId}.html`;
  const root = rewriteRootAbs(cfg);
  const abs = path.resolve(root, ...rel.split('/'));
  assertUnderRoot(root, abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html, 'utf8');
  return rel.replace(/\\/g, '/');
}

export function readRewriteHtmlFromPath(cfg: AppConfig, relativePath: string): string {
  const trimmed = relativePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.includes('..')) {
    throw new Error('Invalid rewrite file path');
  }
  const root = rewriteRootAbs(cfg);
  const abs = path.resolve(root, ...trimmed.split('/').filter(Boolean));
  assertUnderRoot(root, abs);
  return fs.readFileSync(abs, 'utf8');
}

/** @deprecated Legacy path pattern `{runId}/{itemId}.html` — prefer staging files. */
export function relativeRewriteHtmlPath(runId: number, itemId: number): string {
  return `${runId}/${itemId}.html`;
}

/** Load HTML from disk path or legacy inline blob field. */
export function loadStoredRewrittenHtml(
  cfg: AppConfig,
  row: { rewritten_html_path: string | null; rewritten_html: string | null },
): string {
  const p = row.rewritten_html_path?.trim();
  if (p) {
    try {
      return readRewriteHtmlFromPath(cfg, p);
    } catch {
      return '';
    }
  }
  return row.rewritten_html?.trim() ?? '';
}

/** Remove all files under the rewrite storage root and reset `staging-index.json` to []. */
export function clearRewriteStagingDir(cfg: AppConfig): { pathsRemoved: number } {
  const root = rewriteRootAbs(cfg);
  let pathsRemoved = 0;
  if (fs.existsSync(root)) {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      const abs = path.join(root, ent.name);
      assertUnderRoot(root, abs);
      if (ent.isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      } else {
        fs.unlinkSync(abs);
      }
      pathsRemoved += 1;
    }
  }
  fs.mkdirSync(root, { recursive: true });
  writeStagingIndex(cfg, []);
  return { pathsRemoved };
}
