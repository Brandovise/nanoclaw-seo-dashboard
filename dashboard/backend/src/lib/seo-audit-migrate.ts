/**
 * One-time import from legacy `audit_results.json` into `seo_audits`, then remove the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import { log } from './logger.js';

type LegacyRow = {
  slug: string;
  title: string;
  seo_score: number;
  geo_score: number;
  audited_at: string;
  summary?: string;
  model?: string;
  checks: Record<string, { status: string; note?: string }>;
};

export function migrateSeoAuditJsonToDbIfNeeded(cfg: AppConfig, db: Database.Database): void {
  const legacyPath = path.join(cfg.resolvedBlogDataDir, 'audit_results.json');
  const count = (
    db.prepare('SELECT COUNT(*) as c FROM seo_audits').get() as { c: number }
  ).c;
  if (count > 0) {
    if (fs.existsSync(legacyPath)) {
      try {
        fs.unlinkSync(legacyPath);
        log.info({ path: legacyPath }, 'seo_audit removed legacy JSON after DB already had rows');
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (!fs.existsSync(legacyPath)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      /* ignore */
    }
    return;
  }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO seo_audits (slug, title, seo_score, geo_score, audited_at, summary, model, checks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.transaction((rows: LegacyRow[]) => {
    for (const r of rows) {
      if (!r || typeof r.slug !== 'string' || !r.slug) continue;
      ins.run(
        r.slug,
        r.title ?? r.slug,
        r.seo_score ?? 0,
        r.geo_score ?? 0,
        r.audited_at ?? new Date().toISOString(),
        r.summary ?? null,
        r.model ?? null,
        JSON.stringify(r.checks ?? {}),
      );
    }
  });
  run(raw as LegacyRow[]);
  try {
    fs.unlinkSync(legacyPath);
  } catch {
    /* ignore */
  }
  log.info(
    { path: legacyPath, n: (raw as LegacyRow[]).length },
    'seo_audit migrated legacy audit_results.json to sqlite',
  );
}
