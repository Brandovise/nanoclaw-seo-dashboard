#!/usr/bin/env node
/**
 * Irreversible: clears dashboard SQLite (all rows), WP sync disk tree, rewrite staging,
 * blog queue/logs/progress and `content/*.md` under the resolved blog data dir.
 *
 * Usage (from repo root):
 *   pnpm exec tsx dashboard/backend/src/scripts/reset-dashboard-data.ts
 */
import { loadConfig } from '../config.js';
import { resetDashboardData } from '../lib/dashboard-reset.js';

const cfg = loadConfig();
const summary = resetDashboardData(cfg);

console.log(
  JSON.stringify(
    {
      ok: true,
      sqlitePath: summary.sqlitePath,
      tableCount: summary.tablesCleared.length,
      tablesCleared: summary.tablesCleared,
      databaseReplaced: summary.databaseReplaced,
      wpSyncRootRemoved: summary.wpSyncRootRemoved,
      rewritePathsRemoved: summary.rewriteStaging.pathsRemoved,
      blogFilesRemoved: summary.blogFilesRemoved,
    },
    null,
    2,
  ),
);
