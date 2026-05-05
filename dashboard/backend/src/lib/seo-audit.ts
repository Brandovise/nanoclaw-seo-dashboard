/**
 * AI SEO audit: Claude evaluates each article; results persist in `seo_audits` (dashboard SQLite).
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { log } from './logger.js';
import { sqlWpTypesDashboardClause } from './wp-dashboard-types.js';
import { hasTable } from './nanoclaw-db.js';

/** 22 checks — must match what the blog UI and top-issues expect. */
export const SEO_AUDIT_CHECK_IDS_22 = [
  'title_tag',
  'meta_description',
  'canonical',
  'h1',
  'heading_hierarchy',
  'intro_answer_intent',
  'keyword_usage',
  'internal_links',
  'external_links',
  'images_alt_text',
  'schema_structured_data',
  'readability',
  'eeat_experience',
  'eeat_authority',
  'eeat_trust',
  'geo_relevance',
  'snippet_optimization',
  'url_slugs',
  'mobile_ux',
  'core_web_vitals_signals',
  'thin_content',
  'duplicate_risk',
  'cta_clarity',
] as const;

const LlmAuditSchema = z.object({
  seo_score: z.number().min(0).max(100),
  geo_score: z.number().min(0).max(100),
  summary: z.string().optional(),
  checks: z.record(
    z.string(),
    z.object({
      status: z.enum(['PASS', 'FAIL']),
      note: z.string().optional(),
    }),
  ),
});

export type SeoAuditRecord = {
  slug: string;
  title: string;
  seo_score: number;
  geo_score: number;
  audited_at: string;
  checks: Record<string, { status: 'PASS' | 'FAIL'; note?: string }>;
  model?: string;
  summary?: string;
};

const auditState: {
  running: boolean;
  lastMessage: string | null;
  processed: number;
  total: number;
} = { running: false, lastMessage: null, processed: 0, total: 0 };

export function getSeoAuditRunState() {
  return { ...auditState };
}

let auditJob: Promise<void> | null = null;

function openDashboardDbRW(cfg: AppConfig): Database.Database {
  return new Database(cfg.DASHBOARD_SQLITE_PATH);
}

function openDashboardDbRO(cfg: AppConfig): Database.Database {
  return new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
}

/** All rows from `seo_audits` (empty if no DB/table). Exported for the blog stats API. */
export function readSeoAuditRecords(cfg: AppConfig): SeoAuditRecord[] {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return [];
  const db = openDashboardDbRO(cfg);
  try {
    if (!hasTable(db, 'seo_audits')) return [];
    const rows = db
      .prepare(
        'SELECT slug, title, seo_score, geo_score, audited_at, summary, model, checks_json FROM seo_audits ORDER BY slug',
      )
      .all() as Array<{
        slug: string;
        title: string;
        seo_score: number;
        geo_score: number;
        audited_at: string;
        summary: string | null;
        model: string | null;
        checks_json: string;
      }>;
    return rows.map((row) => {
      let checks: SeoAuditRecord['checks'] = {} as SeoAuditRecord['checks'];
      try {
        checks = JSON.parse(row.checks_json) as SeoAuditRecord['checks'];
      } catch {
        /* keep empty */
      }
      return {
        slug: row.slug,
        title: row.title,
        seo_score: row.seo_score,
        geo_score: row.geo_score,
        audited_at: row.audited_at,
        summary: row.summary ?? undefined,
        model: row.model ?? undefined,
        checks,
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getLatestSeoAuditAt(cfg: AppConfig): string | null {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return null;
  const db = openDashboardDbRO(cfg);
  try {
    if (!hasTable(db, 'seo_audits')) return null;
    const r = db.prepare('SELECT max(audited_at) as m FROM seo_audits').get() as { m: string | null } | undefined;
    return r?.m ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function mergeRecord(cfg: AppConfig, rec: SeoAuditRecord): void {
  const db = openDashboardDbRW(cfg);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO seo_audits (slug, title, seo_score, geo_score, audited_at, summary, model, checks_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.slug,
      rec.title,
      rec.seo_score,
      rec.geo_score,
      rec.audited_at,
      rec.summary ?? null,
      rec.model ?? null,
      JSON.stringify(rec.checks),
    );
  } finally {
    db.close();
  }
}

/** Remove one row from `seo_audits` (does not delete WordPress content). */
export function deleteSeoAuditRecord(
  cfg: AppConfig,
  slug: string,
): { ok: boolean; notFound: boolean; message: string } {
  const s = slug.trim();
  if (!s) {
    return { ok: false, notFound: false, message: 'Missing slug.' };
  }
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) {
    return { ok: false, notFound: true, message: 'No stored audit for that slug.' };
  }
  const db = openDashboardDbRW(cfg);
  try {
    if (!hasTable(db, 'seo_audits')) {
      return { ok: false, notFound: true, message: 'No stored audit for that slug.' };
    }
    const r = db.prepare('DELETE FROM seo_audits WHERE slug = ?').run(s);
    if (r.changes === 0) {
      return { ok: false, notFound: true, message: 'No stored audit for that slug.' };
    }
    return { ok: true, notFound: false, message: 'Audit removed for this article.' };
  } finally {
    db.close();
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type WpRow = {
  slug: string;
  title: string;
  content_text: string | null;
  content_html: string | null;
};

/** Re-audit when WP content changed after the last audit. */
function wpNeedsAudit(wpModified: string | null, existing: SeoAuditRecord | undefined): boolean {
  if (!existing) return true;
  if (!wpModified) return false;
  const w = Date.parse(wpModified);
  const a = Date.parse(existing.audited_at);
  if (Number.isNaN(w) || Number.isNaN(a)) return false;
  return w > a;
}

/**
 * Batch runs: walk newest-first and take `limit` articles that are not yet audited
 * (or were edited in WordPress after the last stored audit). Explicit `slugs` re-runs those rows regardless.
 */
function getWpRows(cfg: AppConfig, slugs: string[] | null, limit: number): WpRow[] {
  if (!fs.existsSync(cfg.DASHBOARD_SQLITE_PATH)) return [];
  const db = new Database(cfg.DASHBOARD_SQLITE_PATH, { readonly: true, fileMustExist: true });
  try {
    const has = db
      .prepare(`SELECT 1 as x FROM sqlite_master WHERE type='table' AND name='wp_articles'`)
      .get() as { x: number } | undefined;
    if (!has) return [];
    if (slugs?.length) {
      const ph = slugs.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT slug, title, content_text, content_html FROM wp_articles WHERE ${sqlWpTypesDashboardClause()} AND slug IN (${ph}) LIMIT ${limit}`,
        )
        .all(...slugs) as WpRow[];
    }

    const bySlug = new Map(readSeoAuditRecords(cfg).map((r) => [r.slug, r] as [string, SeoAuditRecord]));
    const order = db
      .prepare(
        `SELECT slug, modified_at FROM wp_articles WHERE ${sqlWpTypesDashboardClause()} ORDER BY modified_at DESC`,
      )
      .all() as { slug: string; modified_at: string | null }[];
    const picked: string[] = [];
    for (const row of order) {
      if (wpNeedsAudit(row.modified_at, bySlug.get(row.slug))) {
        picked.push(row.slug);
        if (picked.length >= limit) break;
      }
    }
    if (picked.length === 0) return [];
    const ph = picked.map(() => '?').join(',');
    const full = db
      .prepare(
        `SELECT slug, title, content_text, content_html FROM wp_articles WHERE ${sqlWpTypesDashboardClause()} AND slug IN (${ph})`,
      )
      .all(...picked) as WpRow[];
    const m = new Map(full.map((r) => [r.slug, r]));
    return picked.map((s) => m.get(s)).filter((r): r is WpRow => r != null);
  } finally {
    db.close();
  }
}

function buildBodyText(row: WpRow, maxLen: number): string {
  const raw = (row.content_text && row.content_text.length > 50 ? row.content_text : null) || stripHtml(row.content_html || '');
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}\n\n[…content truncated for audit…]`;
}

function normalizeChecks(raw: Record<string, { status: string; note?: string }>): SeoAuditRecord['checks'] {
  const out: SeoAuditRecord['checks'] = {};
  for (const id of SEO_AUDIT_CHECK_IDS_22) {
    const v = raw[id];
    if (v && (v.status === 'PASS' || v.status === 'FAIL')) {
      out[id] = { status: v.status, note: v.note };
    } else {
      out[id] = { status: 'PASS', note: 'not_scored' };
    }
  }
  return out;
}

function anthropicKey(cfg: AppConfig): string | undefined {
  const k = cfg.ANTHROPIC_API_KEY?.trim();
  return k || undefined;
}

async function callAnthropicAudit(cfg: AppConfig, row: WpRow): Promise<SeoAuditRecord> {
  const key = anthropicKey(cfg);
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (add it to .env or set ANTHROPIC_API_KEY in the environment)');

  const model = cfg.SEO_AUDIT_MODEL || process.env.SEO_AUDIT_MODEL || 'claude-sonnet-4-20250514';
  const maxContent = Math.max(
    5000,
    cfg.SEO_AUDIT_MAX_CONTENT_CHARS ??
      (parseInt(process.env.SEO_AUDIT_MAX_CONTENT_CHARS || '80000', 10) || 80000),
  );
  const body = buildBodyText(row, maxContent);

  const checkList = SEO_AUDIT_CHECK_IDS_22.map((id, i) => `  ${i + 1}. ${id}`).join('\n');

  const system = `You are an expert SEO and GEO (Generative Engine Optimization) auditor for German-language financial / YMYL blog content.
Score conservatively. Target threshold for "good" content is 70/100.
You MUST respond with a single valid JSON object only, no markdown.
JSON schema:
{
  "seo_score": <0-100 integer>,
  "geo_score": <0-100 integer for how well the piece would perform in AI overview / generative search contexts>,
  "summary": "<1-2 short sentences: what mainly drives the SEO and GEO scores, and the most impactful improvements>",
  "checks": {
     "<check_id>": { "status": "PASS" | "FAIL", "note": "<optional short reason>" }
  }
}
Use these exact check_id keys (22 total):
${checkList}
Every key must be present. Use PASS or FAIL for each.`;

  const user = `Article
---
slug: ${row.slug}
title: ${row.title || row.slug}
---
Plain / derived text (may be truncated):
${body}
`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 6000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === 'text')?.text?.trim() ?? '';
  let jsonStr = text;
  const codeFence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFence) jsonStr = codeFence[1]!.trim();
  const parsed = JSON.parse(jsonStr) as unknown;
  const v = LlmAuditSchema.parse(parsed);
  return {
    slug: row.slug,
    title: row.title || row.slug,
    seo_score: Math.round(v.seo_score),
    geo_score: Math.round(v.geo_score),
    audited_at: new Date().toISOString(),
    checks: normalizeChecks(v.checks as SeoAuditRecord['checks']),
    model,
    summary: v.summary,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function startSeoAuditJob(
  cfg: AppConfig,
  opts: { slugs?: string[]; limit: number; pauseMs: number },
): { started: boolean; message: string } {
  if (auditState.running) {
    return { started: false, message: 'SEO audit is already running.' };
  }
  if (auditJob) {
    return { started: false, message: 'SEO audit is already running.' };
  }
  if (!anthropicKey(cfg)) {
    return {
      started: false,
      message: 'ANTHROPIC_API_KEY is not configured. Set it in the repo .env file (or environment) and restart the dashboard API.',
    };
  }

  const rows = getWpRows(cfg, opts.slugs && opts.slugs.length ? opts.slugs : null, opts.limit);
  if (rows.length === 0) {
    const isExplicit = Boolean(opts.slugs && opts.slugs.length);
    return {
      started: false,
      message: isExplicit
        ? 'No WordPress articles in dashboard DB for the requested slug(s). Run WordPress sync first.'
        : 'No articles need a new SEO audit: everything in sync is already audited. Sync again after new or updated posts, or re-run a specific slug from the API.',
    };
  }

  auditState.running = true;
  auditState.lastMessage = null;
  auditState.processed = 0;
  auditState.total = rows.length;

  auditJob = (async () => {
    const pause = opts.pauseMs;
    try {
      for (const row of rows) {
        try {
          const rec = await callAnthropicAudit(cfg, row);
          mergeRecord(cfg, rec);
          auditState.processed += 1;
          log.info(
            { slug: row.slug, seo: rec.seo_score, geo: rec.geo_score, n: auditState.processed, of: rows.length },
            'seo_audit article done',
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          auditState.lastMessage = msg;
          log.error({ err: e, slug: row.slug }, 'seo_audit article failed');
        }
        if (pause > 0) await sleep(pause);
      }
      auditState.lastMessage = 'completed';
    } finally {
      auditState.running = false;
      auditJob = null;
    }
  })();

  return { started: true, message: `Started SEO audit for ${rows.length} article(s).` };
}
