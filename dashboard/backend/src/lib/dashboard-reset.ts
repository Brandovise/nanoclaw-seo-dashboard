/**
 * Danger zone: wipes dashboard SQLite row data + WordPress sync dirs + rewrite staging + optional blog helper files.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { initSeoDb } from './nanoclaw-db.js';
import { blogPaths } from './blog-seo-helpers.js';
import { clearRewriteStagingDir } from './content-rewrite-files.js';
import { bootstrapInterlinkingSchema } from './interlinking.js';
import { log } from './logger.js';
import { bootstrapWpArticlesSchema } from './wordpress-sync.js';

function resolveWpSyncRoot(cfg: AppConfig): string {
  const out = process.env.WP_SYNC_OUTPUT_DIR || 'dashboard/data/wp-sync';
  return path.isAbsolute(out) ? out : path.resolve(cfg.repoRoot, out.replace(/^\.\//, ''));
}

function rmDirContentsOrWhole(root: string): void {
  try {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    log.warn({ err: e, root }, 'dashboard-reset: rm sync root partially failed');
  }
}

function unlinkSqliteCluster(mainPath: string): void {
  for (const p of [`${mainPath}-journal`, `${mainPath}-wal`, `${mainPath}-shm`, mainPath]) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
        throw new Error(
          `Cannot unlink ${p} (${code ?? 'unknown'}). Fix permissions on dashboard/data ` +
            '(e.g. sudo chown -R "$USER:$USER" dashboard/data), or sudo rm that file.',
        );
      }
    }
  }
}

/** New empty sqlite with SEO + WordPress sync + interlinking tables. */
function recreateFreshDashboardDatabase(sqlitePath: string): void {
  unlinkSqliteCluster(sqlitePath);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

  const seodb = initSeoDb(sqlitePath);
  seodb.close();

  bootstrapWpArticlesSchema(sqlitePath);
  bootstrapInterlinkingSchema(sqlitePath);
}

/** Delete every row in every application table (keeps schema). */
export function wipeDashboardSqliteTables(dbPath: string): { tablesCleared: string[] } {
  const cleared: string[] = [];
  if (!fs.existsSync(dbPath)) return { tablesCleared: cleared };
  const db = new Database(dbPath);
  try {
    try {
      db.pragma('foreign_keys = OFF');
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      for (const { name } of tables) {
        if (!/^[\w]+$/u.test(name)) continue;
        db.exec(`DELETE FROM "${name}"`);
        cleared.push(name);
      }
      try {
        db.exec('DELETE FROM sqlite_sequence');
      } catch {
        /* no sequence table */
      }
    } catch (e) {
      const code =
        e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
      if (code === 'SQLITE_READONLY') {
        throw new Error(
          `Cannot write dashboard database (read-only): ${dbPath}. Fix ownership/permissions on the file, ` +
            '`app.sqlite-shm`, `app.sqlite-wal`, and the parent directory (e.g. sudo chown -R "$USER:$USER" dashboard/data).',
        );
      }
      throw e;
    }
    return { tablesCleared: cleared };
  } finally {
    db.close();
  }
}

export type DashboardResetSummary = {
  sqlitePath: string;
  tablesCleared: string[];
  /** True when unreadable/host-owned DB files were deleted and recreated (common after Docker). */
  databaseReplaced: boolean;
  wpSyncRootRemoved: string;
  rewriteStaging: { pathsRemoved: number };
  blogFilesRemoved: string[];
};

/** Irreversible: empty dashboard DB, remove WP sync artifacts, clear rewrite staging, remove blog_queue / logs / rewrite_progress JSON. Does not touch NanoClaw v2.db or groups/. */
export function resetDashboardData(cfg: AppConfig): DashboardResetSummary {
  const sqlitePath = cfg.DASHBOARD_SQLITE_PATH;
  let tablesCleared: string[] = [];
  let databaseReplaced = false;

  if (!fs.existsSync(sqlitePath)) {
    recreateFreshDashboardDatabase(sqlitePath);
    tablesCleared = ['(no prior database file — created empty schema)'];
    databaseReplaced = true;
  } else {
    try {
      ({ tablesCleared } = wipeDashboardSqliteTables(sqlitePath));
    } catch (e) {
      const ro =
        e instanceof Error &&
        (e.message.includes('read-only') || e.message.includes('Cannot write dashboard database'));
      if (!ro) throw e;
      log.warn(
        { sqlitePath },
        'dashboard-reset: SQLite not writable (often Docker-created files); replacing DB file with fresh schema',
      );
      recreateFreshDashboardDatabase(sqlitePath);
      tablesCleared = ['(replaced unreadable SQLite with empty schema — use chown to avoid deletion)'];
      databaseReplaced = true;
    }
  }

  const wpSyncRoot = resolveWpSyncRoot(cfg);
  rmDirContentsOrWhole(wpSyncRoot);

  const rewriteStaging = clearRewriteStagingDir(cfg);

  const bp = blogPaths(cfg);
  const blogFilesRemoved: string[] = [];
  const blogSidecars = [bp.blogQueue, bp.schedulerLog, bp.rewriteProgress];
  for (const p of blogSidecars) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        blogFilesRemoved.push(p);
      }
    } catch (e) {
      log.warn({ err: e, p }, 'dashboard-reset: could not unlink blog helper file');
    }
  }

  try {
    if (fs.existsSync(bp.contentDir)) {
      for (const f of fs.readdirSync(bp.contentDir)) {
        if (!f.endsWith('.md')) continue;
        const p = path.join(bp.contentDir, f);
        fs.unlinkSync(p);
        blogFilesRemoved.push(p);
      }
    }
  } catch (e) {
    log.warn({ err: e, dir: bp.contentDir }, 'dashboard-reset: clearing blog content/*.md skipped');
  }

  log.warn(
    { sqlitePath, tablesCleared: tablesCleared.length, wpSyncRoot },
    'dashboard-reset: wiped dashboard data (SQLite rows + WP sync dir + staging + blog helpers)',
  );

  return {
    sqlitePath,
    tablesCleared,
    databaseReplaced,
    wpSyncRootRemoved: wpSyncRoot,
    rewriteStaging,
    blogFilesRemoved,
  };
}
