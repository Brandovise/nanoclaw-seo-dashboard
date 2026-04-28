import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

let _v2: Database.Database | null = null;

export function getV2ReadonlyDb(cfg: AppConfig): Database.Database {
  if (_v2) return _v2;
  if (!fs.existsSync(cfg.v2DbPath)) {
    throw new Error(`NanoClaw v2.db not found: ${cfg.v2DbPath}`);
  }
  _v2 = new Database(cfg.v2DbPath, { readonly: true, fileMustExist: true });
  return _v2;
}

export function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { x: number } | undefined;
  return !!row;
}

export function initSeoDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
    CREATE TABLE IF NOT EXISTS seo_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS seo_audits (
      slug TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      seo_score INTEGER NOT NULL,
      geo_score INTEGER NOT NULL,
      audited_at TEXT NOT NULL,
      summary TEXT,
      model TEXT,
      checks_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seo_audits_audited_at ON seo_audits(audited_at);
  `);
  return db;
}
