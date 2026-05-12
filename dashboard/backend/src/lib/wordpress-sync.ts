import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import Database from 'better-sqlite3';

import type { AppConfig } from '../config.js';
import { omitElementorGeneratedMetaKeys } from './wp-elementor-meta-strip.js';
import { DASHBOARD_WP_TYPES, isDashboardWpType, sqlWpTypesDashboardClause } from './wp-dashboard-types.js';
import { log } from './logger.js';

let pathsReady = false;
let WP_SYNC_ROOT: string;
let WP_SYNC_DB: string;
let WP_SYNC_RAW_DIR: string;
let WP_SYNC_CONTENT_DIR: string;
let WP_SYNC_GRAPHIFY_DIR: string;
let WP_SYNC_GRAPH_HTML: string;
let wpApiTimeoutMs = 30000;

/** Paths + DASHBOARD_SQLITE_PATH for wp_* tables. Call once at startup. */
export function initWordpressModule(cfg: AppConfig): void {
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(cfg.repoRoot, p.replace(/^\.\//, '')));
  const out = process.env.WP_SYNC_OUTPUT_DIR || 'dashboard/data/wp-sync';
  WP_SYNC_ROOT = resolve(out);
  WP_SYNC_DB = cfg.DASHBOARD_SQLITE_PATH;
  WP_SYNC_RAW_DIR = path.join(WP_SYNC_ROOT, 'raw');
  WP_SYNC_CONTENT_DIR = path.join(WP_SYNC_ROOT, 'content');
  WP_SYNC_GRAPHIFY_DIR = path.join(WP_SYNC_ROOT, 'graphify-workspace');
  WP_SYNC_GRAPH_HTML = path.join(WP_SYNC_GRAPHIFY_DIR, 'graphify-out', 'graph.html');
  wpApiTimeoutMs = Math.max(
    5000,
    parseInt(process.env.WP_API_TIMEOUT_MS || `${DEFAULT_WP_API_TIMEOUT_MS}`, 10) || DEFAULT_WP_API_TIMEOUT_MS,
  );
  wpDb = null;
  pathsReady = true;
  log.info(
    { wpSyncRoot: WP_SYNC_ROOT, sqlite: WP_SYNC_DB, graphHtml: WP_SYNC_GRAPH_HTML },
    'wordpress sync paths set',
  );
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface WordPressApiItem {
  id: number;
  slug?: string;
  status?: string;
  type?: string;
  link?: string;
  date?: string;
  modified?: string;
  title?: { rendered?: string } | string;
  excerpt?: { rendered?: string } | string;
  content?: { rendered?: string } | string;
  author?: number;
  categories?: number[];
  tags?: number[];
  /** Present when syncing with authenticated `context=edit` and plugins expose meta to REST (e.g. Elementor). */
  meta?: Record<string, JsonValue>;
  [key: string]: JsonValue | undefined;
}

interface PostTypeDef {
  slug: string;
  rest_base: string;
  viewable?: boolean;
  supports?: Record<string, boolean>;
}

interface TaxonomyDef {
  slug: string;
  rest_base: string;
}

interface WpArticleRecord {
  wp_id: number;
  wp_type: string;
  status: string;
  slug: string;
  title: string;
  excerpt: string;
  content_html: string;
  content_text: string;
  /** JSON-encoded REST `meta` from last sync (`context=edit`), minus bulky Elementor cache keys — includes `_elementor_data` when WP exposes it. */
  rest_meta_json: string;
  source_url: string;
  author: string;
  published_at: string;
  modified_at: string;
  categories_json: string;
  tags_json: string;
  taxonomy_json: string;
  sync_hash: string;
}

export interface WpSyncConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
  statusScope: string;
  apiRequestIntervalMs: number;
}

interface SyncResult {
  ok: boolean;
  runId: number;
  message: string;
  fetched: number;
  upserted: number;
  errors: number;
  graph: {
    nodes: number;
    edges: number;
    orphanCount: number;
  };
}

interface SyncStartResult {
  started: boolean;
  message: string;
}

interface GraphifyBuildResult {
  ok: boolean;
  htmlPath: string;
  message: string;
}

const DEFAULT_PAGE_SIZE = 100;
const RUNNING_MARKER = 'running';
const DONE_MARKER = 'success';
const FAILED_MARKER = 'error';
const DEFAULT_API_INTERVAL_MS = 250;
const DEFAULT_WP_API_TIMEOUT_MS = 30000;

class WpApiError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    super(`WordPress API ${status} at ${url}: ${body.slice(0, 300)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

let wpDb: Database.Database | null = null;
let wpSyncJob: Promise<SyncResult> | null = null;

/** Remove CPT rows (e.g. elementor_library) and drop link rows if any article row was deleted. */
function purgeNonDashboardWpArticlesAndStaleLinks(db: Database.Database): void {
  try {
    const chk = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='wp_articles' LIMIT 1`)
      .get() as { 1?: number } | undefined;
    if (!chk) return;
    const removed = db.prepare(`DELETE FROM wp_articles WHERE wp_type NOT IN ('post', 'page')`).run().changes ?? 0;
    if (removed > 0) {
      db.prepare('DELETE FROM wp_links').run();
      log.info({ removed }, 'wp_articles purged non-dashboard wp_type (dashboard: post + page only)');
    }
  } catch (err) {
    log.warn({ err }, 'wp dashboard type purge failed');
  }
}

function getWpDb(): Database.Database {
  if (!pathsReady) {
    throw new Error('WordPress module not initialized: call initWordpressModule(loadConfig()) at startup.');
  }
  if (wpDb) return wpDb;
  fs.mkdirSync(path.dirname(WP_SYNC_DB), { recursive: true });
  fs.mkdirSync(WP_SYNC_ROOT, { recursive: true });
  fs.mkdirSync(WP_SYNC_RAW_DIR, { recursive: true });
  wpDb = new Database(WP_SYNC_DB);
  wpDb.pragma('journal_mode = WAL');
  initWpSchema(wpDb);
  purgeNonDashboardWpArticlesAndStaleLinks(wpDb);
  return wpDb;
}

function initWpSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wp_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      message TEXT,
      fetched_count INTEGER DEFAULT 0,
      upserted_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      csv_path TEXT,
      total_types INTEGER DEFAULT 0,
      processed_types INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wp_articles (
      wp_id INTEGER NOT NULL,
      wp_type TEXT NOT NULL,
      status TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT,
      excerpt TEXT,
      content_html TEXT,
      content_text TEXT,
      rest_meta_json TEXT,
      source_url TEXT,
      author TEXT,
      published_at TEXT,
      modified_at TEXT,
      categories_json TEXT,
      tags_json TEXT,
      taxonomy_json TEXT,
      sync_hash TEXT,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (wp_id, wp_type)
    );

    CREATE INDEX IF NOT EXISTS idx_wp_articles_slug ON wp_articles(slug);
    CREATE INDEX IF NOT EXISTS idx_wp_articles_url ON wp_articles(source_url);
    CREATE INDEX IF NOT EXISTS idx_wp_articles_type ON wp_articles(wp_type);
    CREATE INDEX IF NOT EXISTS idx_wp_articles_status ON wp_articles(status);
    CREATE INDEX IF NOT EXISTS idx_wp_articles_modified ON wp_articles(modified_at);

    CREATE TABLE IF NOT EXISTS wp_links (
      source_key TEXT NOT NULL,
      source_slug TEXT NOT NULL,
      target_key TEXT,
      target_slug TEXT,
      target_url TEXT NOT NULL,
      anchor_text TEXT,
      is_internal INTEGER DEFAULT 0,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (source_key, target_url, anchor_text)
    );

    CREATE INDEX IF NOT EXISTS idx_wp_links_source ON wp_links(source_key);
    CREATE INDEX IF NOT EXISTS idx_wp_links_target ON wp_links(target_key);
    CREATE INDEX IF NOT EXISTS idx_wp_links_internal ON wp_links(is_internal);
  `);

  // Migration for existing DBs
  try {
    db.exec(`ALTER TABLE wp_sync_runs ADD COLUMN total_types INTEGER DEFAULT 0`);
  } catch {
    // column exists
  }
  try {
    db.exec(`ALTER TABLE wp_sync_runs ADD COLUMN processed_types INTEGER DEFAULT 0`);
  } catch {
    // column exists
  }
  try {
    db.exec(`ALTER TABLE wp_articles ADD COLUMN rest_meta_json TEXT`);
  } catch {
    // column exists
  }
}

/** Create `wp_*` tables on the dashboard DB (e.g. after removing an unreadable sqlite file). */
export function bootstrapWpArticlesSchema(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    initWpSchema(db);
  } finally {
    db.close();
  }
}

function updateRunProgress(
  db: Database.Database,
  runId: number,
  values: {
    message?: string;
    fetched_count?: number;
    upserted_count?: number;
    error_count?: number;
    total_types?: number;
    processed_types?: number;
  },
): void {
  const fields: string[] = [];
  const params: Record<string, unknown> = { runId };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    fields.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (fields.length === 0) return;
  db.prepare(`UPDATE wp_sync_runs SET ${fields.join(', ')} WHERE id = @runId`).run(params);
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persist REST `meta` (Elementor, etc.); strip generated Elementor cache blobs. */
function serializeWpRestMetaForStorage(meta: unknown): string {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  try {
    const stripped = omitElementorGeneratedMetaKeys(meta as Record<string, unknown>);
    if (!Object.keys(stripped).length) return '';
    return JSON.stringify(stripped);
  } catch {
    return '';
  }
}

function hashRecord(record: WpArticleRecord): string {
  const input = [
    record.wp_id,
    record.wp_type,
    record.status,
    record.slug,
    record.title,
    record.excerpt,
    record.content_html,
    record.rest_meta_json,
    record.source_url,
    record.modified_at,
    record.categories_json,
    record.tags_json,
    record.taxonomy_json,
  ].join('|');
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.search = '';
    let out = u.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

function decodeRendered(v: JsonValue | undefined): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const rendered = v.rendered;
    if (typeof rendered === 'string') return rendered;
  }
  return '';
}

/** Same env keys as sync. Upload must call this so WP_* parsing matches `runWpSync`. */
export function loadWpSyncConfig(): WpSyncConfig {
  const site = process.env.WP_SITE_URL || '';
  const apiBaseEnv = process.env.WP_API_BASE_URL || '';
  const username = (process.env.WP_USERNAME || process.env.WP_USER || '').trim();
  /** WP accepts app passwords with or without spaces; stripping avoids .env/compose mangling of spaced blocks. */
  const appPassword = (process.env.WP_APP_PASSWORD || '')
    .trim()
    .replace(/\s+/g, '');
  const statusScope = process.env.WP_STATUS_SCOPE || 'any';
  const apiRequestIntervalMs = Math.max(
    0,
    parseInt(process.env.WP_API_REQUEST_INTERVAL_MS || `${DEFAULT_API_INTERVAL_MS}`, 10) || DEFAULT_API_INTERVAL_MS,
  );

  const apiBase = apiBaseEnv ? apiBaseEnv : site ? `${site.replace(/\/+$/, '')}/wp-json/wp/v2` : '';

  return {
    baseUrl: apiBase.replace(/\/+$/, ''),
    username,
    appPassword,
    statusScope,
    apiRequestIntervalMs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRequestPacer(intervalMs: number): () => Promise<void> {
  let lastRequestAt = 0;
  return async () => {
    if (intervalMs <= 0) return;
    const now = Date.now();
    const delta = now - lastRequestAt;
    if (delta < intervalMs) {
      await sleep(intervalMs - delta);
    }
    lastRequestAt = Date.now();
  };
}

function authHeader(cfg: WpSyncConfig): string {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString('base64')}`;
}

async function wpFetchJson(cfg: WpSyncConfig, endpoint: string): Promise<{ data: unknown; headers: Headers }> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${cfg.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), wpApiTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: authHeader(cfg),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`WordPress API timeout after ${wpApiTimeoutMs}ms at ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new WpApiError(response.status, url, body);
  }
  const data = (await response.json()) as unknown;
  return { data, headers: response.headers };
}

async function wpFetchWithFallback(
  cfg: WpSyncConfig,
  endpoints: string[],
): Promise<{ data: unknown; headers: Headers; endpoint: string }> {
  let lastErr: unknown;
  for (const endpoint of endpoints) {
    try {
      const result = await wpFetchJson(cfg, endpoint);
      return { ...result, endpoint };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function discoverPostTypes(cfg: WpSyncConfig, paceRequest: () => Promise<void>): Promise<PostTypeDef[]> {
  await paceRequest();
  const { data } = await wpFetchWithFallback(cfg, ['/types?context=edit', '/types?context=view', '/types']);
  const obj = (data || {}) as Record<string, JsonValue>;
  const types: PostTypeDef[] = [];
  for (const [slug, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const restBase = typeof value.rest_base === 'string' ? value.rest_base : '';
    if (!restBase) continue;
    if (slug === 'attachment' || slug === 'revision' || slug === 'nav_menu_item') continue;
    const supports =
      value.supports && typeof value.supports === 'object' && !Array.isArray(value.supports)
        ? (value.supports as Record<string, boolean>)
        : undefined;
    const hasContent = supports?.editor || supports?.title;
    if (!hasContent && slug !== 'page' && slug !== 'post') continue;
    types.push({
      slug,
      rest_base: restBase,
      viewable: value.viewable === true,
      supports,
    });
  }
  const allow = new Set<string>(DASHBOARD_WP_TYPES);
  return types.filter((t) => allow.has(t.slug));
}

async function discoverTaxonomies(cfg: WpSyncConfig, paceRequest: () => Promise<void>): Promise<TaxonomyDef[]> {
  await paceRequest();
  const { data } = await wpFetchWithFallback(cfg, [
    '/taxonomies?context=edit',
    '/taxonomies?context=view',
    '/taxonomies',
  ]);
  const obj = (data || {}) as Record<string, JsonValue>;
  const out: TaxonomyDef[] = [];
  for (const [slug, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const restBase = typeof value.rest_base === 'string' ? value.rest_base : '';
    if (!restBase) continue;
    out.push({ slug, rest_base: restBase });
  }
  return out;
}

async function fetchTaxonomyTerms(
  cfg: WpSyncConfig,
  taxonomies: TaxonomyDef[],
  paceRequest: () => Promise<void>,
): Promise<Record<string, Record<number, string>>> {
  const byTax: Record<string, Record<number, string>> = {};
  for (const tax of taxonomies) {
    byTax[tax.slug] = {};
    let page = 1;
    while (true) {
      const endpointEdit = `/${tax.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&context=edit&_fields=id,name,slug`;
      const endpointView = `/${tax.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&context=view&_fields=id,name,slug`;
      const endpointDefault = `/${tax.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&_fields=id,name,slug`;
      try {
        await paceRequest();
        const { data, headers } = await wpFetchWithFallback(cfg, [endpointEdit, endpointView, endpointDefault]);
        const list = Array.isArray(data) ? (data as Array<Record<string, JsonValue>>) : [];
        for (const row of list) {
          const id = typeof row.id === 'number' ? row.id : NaN;
          const name = typeof row.name === 'string' ? row.name : '';
          if (!Number.isNaN(id) && name) byTax[tax.slug][id] = name;
        }
        const totalPages = parseInt(headers.get('x-wp-totalpages') || '1', 10);
        if (page >= totalPages || list.length === 0) break;
        page += 1;
      } catch {
        break;
      }
    }
  }
  return byTax;
}

async function fetchItemsForType(
  cfg: WpSyncConfig,
  typeDef: PostTypeDef,
  paceRequest: () => Promise<void>,
): Promise<WordPressApiItem[]> {
  const all: WordPressApiItem[] = [];
  let page = 1;
  while (true) {
    const endpoints = [
      `/${typeDef.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&context=edit&status=${encodeURIComponent(cfg.statusScope)}`,
      `/${typeDef.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&context=view&status=${encodeURIComponent(cfg.statusScope)}`,
      `/${typeDef.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&context=view&status=publish`,
      `/${typeDef.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}&status=publish`,
      `/${typeDef.rest_base}?per_page=${DEFAULT_PAGE_SIZE}&page=${page}`,
    ];
    await paceRequest();
    const { data, headers } = await wpFetchWithFallback(cfg, endpoints);
    const list = Array.isArray(data) ? (data as WordPressApiItem[]) : [];
    all.push(...list);
    const totalPages = parseInt(headers.get('x-wp-totalpages') || '1', 10);
    if (page >= totalPages || list.length === 0) break;
    page += 1;
  }
  return all;
}

function safePathSegment(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'unknown';
}

function contentFileName(wpType: string, status: string, slug: string, wpId: number): string {
  return `${safePathSegment(wpType)}__${safePathSegment(status)}__${safePathSegment(slug)}__${wpId}.html`;
}

function writeStructuredSnapshot(rows: WpArticleRecord[]): Record<string, string> {
  fs.rmSync(WP_SYNC_CONTENT_DIR, { recursive: true, force: true });
  fs.mkdirSync(WP_SYNC_CONTENT_DIR, { recursive: true });
  const map: Record<string, string> = {};
  for (const row of rows) {
    const fileName = contentFileName(row.wp_type, row.status, row.slug, row.wp_id);
    const absolutePath = path.join(WP_SYNC_CONTENT_DIR, fileName);
    fs.writeFileSync(absolutePath, row.content_html || '', 'utf8');
    map[`${row.wp_type}:${row.wp_id}`] = absolutePath;
  }
  return map;
}

function getAllWpRowsForGraphify(): WpArticleRecord[] {
  const db = getWpDb();
  return db
    .prepare(
      `
    SELECT
      wp_id, wp_type, status, slug, title, excerpt,
      content_html, content_text, rest_meta_json, source_url, author,
      published_at, modified_at, categories_json, tags_json,
      taxonomy_json, sync_hash
    FROM wp_articles
    WHERE ${sqlWpTypesDashboardClause()}
  `,
    )
    .all() as WpArticleRecord[];
}

function runGraphifyBuild(rows: WpArticleRecord[]): GraphifyBuildResult {
  if (!rows.length) {
    return {
      ok: false,
      htmlPath: WP_SYNC_GRAPH_HTML,
      message: 'No synced rows available to build graph.',
    };
  }
  try {
    const graph = getWpGraph();
    fs.mkdirSync(path.dirname(WP_SYNC_GRAPH_HTML), { recursive: true });
    const graphJson = JSON.stringify(graph).replace(/<\/script/gi, '<\\/script');
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WordPress Link Graph</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #020617; color: #e2e8f0; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    #topbar { height: 50px; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; box-sizing: border-box; }
    #title { font-weight: 600; }
    #stats { color: #94a3b8; font-size: 13px; }
    #graph { height: calc(100% - 50px); width: 100%; }
  </style>
</head>
<body>
  <div id="topbar">
    <div id="title">WordPress Internal Link Graph</div>
    <div id="stats"></div>
  </div>
  <div id="graph"></div>
  <script src="https://unpkg.com/force-graph"></script>
  <script>
    const graphData = ${graphJson};
    const stats = graphData.stats || {};
    const statsEl = document.getElementById('stats');
    if (statsEl) {
      statsEl.textContent = 'nodes: ' + (stats.totalNodes || 0) + ' | edges: ' + (stats.totalEdges || 0) + ' | orphans: ' + (stats.orphanCount || 0);
    }
    const container = document.getElementById('graph');
    const Graph = ForceGraph()(container)
      .graphData({ nodes: graphData.nodes || [], links: graphData.edges || [] })
      .nodeId('id')
      .nodeLabel((n) => {
        const label = n.label || n.slug || n.id;
        const cat = n.category || 'uncategorized';
        return label + ' (' + cat + ')';
      })
      .nodeVal(4)
      .nodeColor((n) => n.type === 'page' ? '#22d3ee' : '#818cf8')
      .linkDirectionalParticles(1)
      .linkDirectionalParticleWidth(1)
      .linkOpacity(0.28)
      .linkColor(() => '#64748b')
      .onNodeClick((n) => {
        if (!n || !n.slug) return;
        const url = '/api/blog/wp-articles?search=' + encodeURIComponent(String(n.slug)) + '&limit=1';
        window.open(url, '_blank', 'noopener');
      });
    Graph.d3AlphaDecay(0.02);
  </script>
</body>
</html>`;
    fs.writeFileSync(WP_SYNC_GRAPH_HTML, html, 'utf8');
    if (!fs.existsSync(WP_SYNC_GRAPH_HTML)) {
      return {
        ok: false,
        htmlPath: WP_SYNC_GRAPH_HTML,
        message: 'Graph HTML was not generated after sync.',
      };
    }
    return {
      ok: true,
      htmlPath: WP_SYNC_GRAPH_HTML,
      message: 'Graph HTML generated from WordPress sync data.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'WordPress graph build failed');
    return {
      ok: false,
      htmlPath: WP_SYNC_GRAPH_HTML,
      message: `Graph build failed: ${msg}`,
    };
  }
}

function buildArticleRecord(
  item: WordPressApiItem,
  wpType: string,
  taxMap: Record<string, Record<number, string>>,
): WpArticleRecord {
  const title = decodeRendered(item.title);
  const excerpt = decodeRendered(item.excerpt);
  const contentHtml = decodeRendered(item.content);
  const contentText = cleanHtml(contentHtml);
  const slug = typeof item.slug === 'string' ? item.slug : `${wpType}-${item.id}`;
  const sourceUrl = typeof item.link === 'string' ? item.link : '';
  const status = typeof item.status === 'string' ? item.status : 'unknown';
  const author = item.author != null ? String(item.author) : '';
  const publishedAt = typeof item.date === 'string' ? item.date : '';
  const modifiedAt = typeof item.modified === 'string' ? item.modified : '';
  const restMetaJson = serializeWpRestMetaForStorage(item.meta);

  const categories = Array.isArray(item.categories) ? item.categories : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];

  const categoriesNamed = categories.map((id) => ({
    id,
    name: taxMap.category?.[id] || `category:${id}`,
  }));
  const tagsNamed = tags.map((id) => ({
    id,
    name: taxMap.post_tag?.[id] || `tag:${id}`,
  }));

  const dynamicTaxonomy: Record<string, Array<{ id: number; name: string }>> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!Array.isArray(value)) continue;
    if (!value.every((v) => typeof v === 'number')) continue;
    if (!taxMap[key]) continue;
    dynamicTaxonomy[key] = (value as number[]).map((id) => ({
      id,
      name: taxMap[key]?.[id] || `${key}:${id}`,
    }));
  }

  const base: WpArticleRecord = {
    wp_id: item.id,
    wp_type: wpType,
    status,
    slug,
    title,
    excerpt,
    content_html: contentHtml,
    content_text: contentText,
    rest_meta_json: restMetaJson,
    source_url: sourceUrl,
    author,
    published_at: publishedAt,
    modified_at: modifiedAt,
    categories_json: JSON.stringify(categoriesNamed),
    tags_json: JSON.stringify(tagsNamed),
    taxonomy_json: JSON.stringify(dynamicTaxonomy),
    sync_hash: '',
  };
  base.sync_hash = hashRecord(base);
  return base;
}

function upsertArticles(db: Database.Database, rows: WpArticleRecord[]): number {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO wp_articles (
      wp_id, wp_type, status, slug, title, excerpt, content_html, content_text,
      rest_meta_json, source_url, author, published_at, modified_at, categories_json, tags_json,
      taxonomy_json, sync_hash, last_synced_at
    ) VALUES (
      @wp_id, @wp_type, @status, @slug, @title, @excerpt, @content_html, @content_text,
      @rest_meta_json, @source_url, @author, @published_at, @modified_at, @categories_json, @tags_json,
      @taxonomy_json, @sync_hash, @last_synced_at
    )
    ON CONFLICT(wp_id, wp_type) DO UPDATE SET
      status = excluded.status,
      slug = excluded.slug,
      title = excluded.title,
      excerpt = excluded.excerpt,
      content_html = excluded.content_html,
      content_text = excluded.content_text,
      rest_meta_json = excluded.rest_meta_json,
      source_url = excluded.source_url,
      author = excluded.author,
      published_at = excluded.published_at,
      modified_at = excluded.modified_at,
      categories_json = excluded.categories_json,
      tags_json = excluded.tags_json,
      taxonomy_json = excluded.taxonomy_json,
      sync_hash = excluded.sync_hash,
      last_synced_at = excluded.last_synced_at
  `);

  const tx = db.transaction((batch: WpArticleRecord[]) => {
    for (const row of batch) {
      stmt.run({
        ...row,
        last_synced_at: now,
      });
    }
  });
  tx(rows);
  return rows.length;
}

function extractLinksForArticle(contentHtml: string): Array<{ href: string; anchor: string }> {
  const links: Array<{ href: string; anchor: string }> = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(contentHtml)) !== null) {
    const href = (m[1] || '').trim();
    const anchor = cleanHtml(m[2] || '').slice(0, 300);
    if (!href) continue;
    links.push({ href, anchor });
  }
  return links;
}

function buildLinkGraph(baseSiteUrl: string): {
  nodes: number;
  edges: number;
  orphanCount: number;
} {
  const db = getWpDb();
  const rows = db
    .prepare(
      `
    SELECT wp_id, wp_type, slug, source_url, content_html
    FROM wp_articles
    WHERE ${sqlWpTypesDashboardClause()}
  `,
    )
    .all() as Array<{
    wp_id: number;
    wp_type: string;
    slug: string;
    source_url: string;
    content_html: string;
  }>;

  const siteHost = (() => {
    try {
      return new URL(baseSiteUrl).hostname;
    } catch {
      return '';
    }
  })();

  const keyByNormalizedUrl = new Map<string, { key: string; slug: string }>();
  for (const row of rows) {
    const key = `${row.wp_type}:${row.wp_id}`;
    if (row.source_url) {
      keyByNormalizedUrl.set(normalizeUrl(row.source_url), {
        key,
        slug: row.slug,
      });
    }
  }

  db.prepare('DELETE FROM wp_links').run();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO wp_links (
      source_key, source_slug, target_key, target_slug, target_url, anchor_text, is_internal, discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let edges = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const sourceKey = `${row.wp_type}:${row.wp_id}`;
    const links = extractLinksForArticle(row.content_html || '');
    for (const link of links) {
      let resolved: string;
      try {
        resolved = normalizeUrl(new URL(link.href, row.source_url || baseSiteUrl).toString());
      } catch {
        continue;
      }
      const isInternal = (() => {
        try {
          return siteHost && new URL(resolved).hostname === siteHost;
        } catch {
          return false;
        }
      })();
      const target = keyByNormalizedUrl.get(resolved);
      // Ignore self-links (anchors/sublinks pointing to the same page).
      // They are navigation artifacts, not inter-page graph edges.
      if (target?.key === sourceKey) {
        continue;
      }
      ins.run(
        sourceKey,
        row.slug,
        target?.key ?? null,
        target?.slug ?? null,
        resolved,
        link.anchor,
        isInternal ? 1 : 0,
        now,
      );
      edges += 1;
    }
  }

  const orphanRow = db
    .prepare(
      `
    SELECT COUNT(*) AS c
    FROM wp_articles a
    LEFT JOIN (
      SELECT target_key, COUNT(*) cnt
      FROM wp_links
      WHERE is_internal = 1 AND target_key IS NOT NULL
      GROUP BY target_key
    ) incoming ON incoming.target_key = (a.wp_type || ':' || a.wp_id)
    WHERE ${sqlWpTypesDashboardClause('a')} AND COALESCE(incoming.cnt, 0) = 0
  `,
    )
    .get() as { c: number };

  return {
    nodes: rows.length,
    edges,
    orphanCount: orphanRow.c || 0,
  };
}

function saveRawDump(runId: number, payload: unknown): string {
  const file = path.join(
    WP_SYNC_RAW_DIR,
    `run-${String(runId)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

export function getWpSyncState(): {
  configured: boolean;
  siteUrl: string;
  apiRequestIntervalMs: number;
  outputRoot: string;
  dbPath: string;
  contentDir: string;
  graphHtmlPath: string;
  running: boolean;
  latestRun: Record<string, unknown> | null;
  articleCount: number;
} {
  const cfg = loadWpSyncConfig();
  const db = getWpDb();
  const latestRun = db
    .prepare(
      `
    SELECT id, started_at, finished_at, status, message, fetched_count, upserted_count, error_count, csv_path, total_types, processed_types
    FROM wp_sync_runs
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .get() as Record<string, unknown> | undefined;
  const count = db
    .prepare(`SELECT COUNT(*) AS c FROM wp_articles WHERE ${sqlWpTypesDashboardClause()}`)
    .get() as {
    c: number;
  };
  return {
    configured: Boolean(cfg.baseUrl && cfg.username && cfg.appPassword),
    siteUrl: (process.env.WP_SITE_URL || cfg.baseUrl).replace(/\/+$/, ''),
    apiRequestIntervalMs: cfg.apiRequestIntervalMs,
    outputRoot: WP_SYNC_ROOT,
    dbPath: WP_SYNC_DB,
    contentDir: WP_SYNC_CONTENT_DIR,
    graphHtmlPath: WP_SYNC_GRAPH_HTML,
    running: wpSyncJob !== null,
    latestRun: latestRun || null,
    articleCount: count.c || 0,
  };
}

function finalizeStaleRunningRuns(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE wp_sync_runs
    SET finished_at = @now, status = @failed, message = COALESCE(message, 'Sync interrupted before completion')
    WHERE status = @running AND finished_at IS NULL
  `,
  ).run({
    now,
    failed: FAILED_MARKER,
    running: RUNNING_MARKER,
  });
}

export function startWpSyncJob(): SyncStartResult {
  if (wpSyncJob) {
    return { started: false, message: 'WordPress sync already running.' };
  }
  finalizeStaleRunningRuns(getWpDb());
  wpSyncJob = runWpSync().finally(() => {
    wpSyncJob = null;
  });
  return { started: true, message: 'WordPress sync started.' };
}

export async function runWpSync(): Promise<SyncResult> {
  const cfg = loadWpSyncConfig();
  if (!cfg.baseUrl || !cfg.username || !cfg.appPassword) {
    return {
      ok: false,
      runId: -1,
      message: 'Missing WP configuration (WP_SITE_URL/WP_API_BASE_URL, WP_USERNAME or WP_USER, WP_APP_PASSWORD).',
      fetched: 0,
      upserted: 0,
      errors: 1,
      graph: { nodes: 0, edges: 0, orphanCount: 0 },
    };
  }

  const db = getWpDb();
  const startedAt = new Date().toISOString();
  const runIns = db.prepare(`
    INSERT INTO wp_sync_runs (started_at, status, message)
    VALUES (?, ?, ?)
  `);
  const runId = Number(runIns.run(startedAt, RUNNING_MARKER, 'Sync started').lastInsertRowid);

  let fetched = 0;
  let upserted = 0;
  let errors = 0;
  let totalTypes = 0;
  let processedTypes = 0;
  log.info(
    { runId, restBase: cfg.baseUrl, statusScope: cfg.statusScope, timeoutMs: wpApiTimeoutMs },
    'wp_sync started (WordPress REST fetch in background)',
  );
  try {
    const paceRequest = createRequestPacer(cfg.apiRequestIntervalMs);
    purgeNonDashboardWpArticlesAndStaleLinks(db);
    const postTypes = await discoverPostTypes(cfg, paceRequest);
    totalTypes = postTypes.length;
    updateRunProgress(db, runId, {
      total_types: postTypes.length,
      processed_types: 0,
      message: `Discovered ${postTypes.length} content types`,
    });
    const taxonomies = await discoverTaxonomies(cfg, paceRequest);
    const termMap = await fetchTaxonomyTerms(cfg, taxonomies, paceRequest);

    const rawDump: {
      postTypes: unknown;
      taxonomies: unknown;
      items: Record<string, unknown>;
    } = {
      postTypes,
      taxonomies,
      items: {},
    };

    const allRows: WpArticleRecord[] = [];
    for (const typeDef of postTypes) {
      try {
        const items = await fetchItemsForType(cfg, typeDef, paceRequest);
        fetched += items.length;
        rawDump.items[typeDef.slug] = items;
        for (const item of items) {
          allRows.push(buildArticleRecord(item, typeDef.slug, termMap));
        }
      } catch (err) {
        errors += 1;
        log.warn({ err, type: typeDef.slug }, 'WordPress type fetch failed');
      }
      processedTypes += 1;
      updateRunProgress(db, runId, {
        fetched_count: fetched,
        error_count: errors,
        total_types: postTypes.length,
        processed_types: processedTypes,
        message: `Fetched ${processedTypes}/${postTypes.length} types`,
      });
    }

    upserted = upsertArticles(db, allRows);
    const graph = buildLinkGraph(cfg.baseUrl);
    writeStructuredSnapshot(allRows);
    saveRawDump(runId, rawDump);
    const graphify = runGraphifyBuild(allRows);
    if (!graphify.ok) {
      throw new Error(graphify.message);
    }
    log.info(
      { path: graphify.htmlPath, message: graphify.message, nodes: graph.nodes, edges: graph.edges },
      'wp_link_graph_html written',
    );

    const finished = new Date().toISOString();
    db.prepare(
      `
      UPDATE wp_sync_runs
      SET finished_at = ?, status = ?, message = ?, fetched_count = ?, upserted_count = ?, error_count = ?, csv_path = ?, total_types = ?, processed_types = ?
      WHERE id = ?
    `,
    ).run(
      finished,
      DONE_MARKER,
      `Sync completed: ${upserted} records`,
      fetched,
      upserted,
      errors,
      null,
      totalTypes,
      processedTypes,
      runId,
    );
    log.info(
      { runId, fetched, upserted, errors, graphHtml: WP_SYNC_GRAPH_HTML },
      'wp_sync completed',
    );

    return {
      ok: true,
      runId,
      message: 'WordPress sync completed.',
      fetched,
      upserted,
      errors,
      graph,
    };
  } catch (err) {
    const finished = new Date().toISOString();
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, runId, fetched, upserted }, 'wp_sync failed');
    db.prepare(
      `
      UPDATE wp_sync_runs
      SET finished_at = ?, status = ?, message = ?, fetched_count = ?, upserted_count = ?, error_count = ?, csv_path = ?, total_types = ?, processed_types = ?
      WHERE id = ?
    `,
    ).run(finished, FAILED_MARKER, msg, fetched, upserted, errors + 1, null, totalTypes, processedTypes, runId);
    return {
      ok: false,
      runId,
      message: msg,
      fetched,
      upserted,
      errors: errors + 1,
      graph: { nodes: 0, edges: 0, orphanCount: 0 },
    };
  }
}

export function deleteWpSyncedArticle(
  wpId: number,
  wpType: string,
): { ok: boolean; notFound?: boolean; message: string } {
  const id = Number(wpId);
  const type = typeof wpType === 'string' ? wpType.trim() : '';
  if (!Number.isFinite(id) || id <= 0 || !type) {
    return { ok: false, message: 'Invalid wp_id or wp_type.' };
  }
  const db = getWpDb();
  const row = db
    .prepare(`SELECT wp_id, wp_type, status, slug FROM wp_articles WHERE wp_id = ? AND wp_type = ?`)
    .get(id, type) as { wp_id: number; wp_type: string; status: string; slug: string } | undefined;
  if (!row) {
    return { ok: false, notFound: true, message: 'WordPress article not found in database.' };
  }
  const key = `${row.wp_type}:${row.wp_id}`;
  const contentPath = path.join(WP_SYNC_CONTENT_DIR, contentFileName(row.wp_type, row.status, row.slug, row.wp_id));
  try {
    if (fs.existsSync(contentPath)) fs.unlinkSync(contentPath);
  } catch {
    // best-effort cleanup
  }
  const delLinks = db.prepare(`DELETE FROM wp_links WHERE source_key = ? OR target_key = ?`);
  const delArticle = db.prepare(`DELETE FROM wp_articles WHERE wp_id = ? AND wp_type = ?`);
  const tx = db.transaction(() => {
    delLinks.run(key, key);
    delArticle.run(row.wp_id, row.wp_type);
  });
  tx();
  log.info({ wpId: row.wp_id, wpType: row.wp_type, slug: row.slug }, 'wp_articles row deleted from dashboard DB');
  return { ok: true, message: `Removed ${row.wp_type} ${row.slug} from sync database.` };
}

export function listWpArticles(opts: {
  type?: string;
  status?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /** When true, each row includes full `rest_meta_json` (large; WordPress REST meta snapshot). Default false. */
  includeRestMeta?: boolean;
}): {
  total: number;
  articles: Array<Record<string, unknown>>;
} {
  const db = getWpDb();
  const clauses: string[] = [sqlWpTypesDashboardClause('a')];
  const params: Record<string, unknown> = {};

  const typeFilter = typeof opts.type === 'string' ? opts.type.trim() : '';
  if (typeFilter && isDashboardWpType(typeFilter)) {
    clauses.push('a.wp_type = @type');
    params.type = typeFilter;
  }
  if (opts.status) {
    clauses.push('a.status = @status');
    params.status = opts.status;
  }
  if (opts.search) {
    clauses.push('(a.slug LIKE @q OR a.title LIKE @q)');
    params.q = `%${opts.search}%`;
  }
  if (opts.category) {
    clauses.push('a.categories_json LIKE @cat');
    params.cat = `%${opts.category}%`;
  }

  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = Math.min(500, Math.max(1, opts.limit || 100));
  const offset = Math.max(0, opts.offset || 0);
  params.limit = limit;
  params.offset = offset;

  const metaCol = opts.includeRestMeta ? ', a.rest_meta_json' : '';
  /** Light flag for UI — parse-free length check only. */
  const hasMetaSql = `,
      CASE WHEN length(trim(COALESCE(a.rest_meta_json, ''))) > 2 THEN 1 ELSE 0 END AS has_rest_meta`;

  const totalRow = db
    .prepare(
      `
    SELECT COUNT(*) AS c
    FROM wp_articles a
    ${where}
  `,
    )
    .get(params) as { c: number };

  const rows = db
    .prepare(
      `
    SELECT
      a.wp_id, a.wp_type, a.status, a.slug, a.title, a.source_url,
      a.categories_json, a.tags_json, a.modified_at, a.last_synced_at,
      COALESCE(outbound.cnt, 0) AS outbound_links,
      COALESCE(inbound.cnt, 0) AS inbound_links${hasMetaSql}${metaCol}
    FROM wp_articles a
    LEFT JOIN (
      SELECT source_key, COUNT(*) cnt
      FROM wp_links
      WHERE is_internal = 1
      GROUP BY source_key
    ) outbound ON outbound.source_key = (a.wp_type || ':' || a.wp_id)
    LEFT JOIN (
      SELECT target_key, COUNT(*) cnt
      FROM wp_links
      WHERE is_internal = 1 AND target_key IS NOT NULL
      GROUP BY target_key
    ) inbound ON inbound.target_key = (a.wp_type || ':' || a.wp_id)
    ${where}
    ORDER BY a.modified_at DESC, a.wp_type, a.slug
    LIMIT @limit OFFSET @offset
  `,
    )
    .all(params) as Array<Record<string, unknown>>;

  return {
    total: totalRow.c || 0,
    articles: rows,
  };
}

export function getWpGraph(): {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  stats: Record<string, unknown>;
} {
  const db = getWpDb();
  const articles = db
    .prepare(
      `
    SELECT wp_id, wp_type, slug, title, status, categories_json, source_url
    FROM wp_articles
    WHERE ${sqlWpTypesDashboardClause()}
    ORDER BY wp_type, slug
  `,
    )
    .all() as Array<{
    wp_id: number;
    wp_type: string;
    slug: string;
    title: string;
    status: string;
    categories_json: string;
    source_url: string;
  }>;

  const links = db
    .prepare(
      `
    SELECT source_key, target_key, target_url
    FROM wp_links
    WHERE is_internal = 1
  `,
    )
    .all() as Array<{
    source_key: string;
    target_key: string | null;
    target_url: string;
  }>;

  const nodes = articles.map((a) => {
    const cat = (() => {
      try {
        const arr = JSON.parse(a.categories_json || '[]') as Array<{
          name?: string;
        }>;
        return arr[0]?.name || 'uncategorized';
      } catch {
        return 'uncategorized';
      }
    })();
    return {
      id: `${a.wp_type}:${a.wp_id}`,
      slug: a.slug,
      label: a.title || a.slug,
      url: a.source_url || '',
      type: a.wp_type,
      status: a.status,
      category: cat,
    };
  });

  const edges = links
    .filter((l) => Boolean(l.target_key))
    .map((l) => ({
      source: l.source_key,
      target: l.target_key,
      url: l.target_url,
    }));

  const orphanRow = db
    .prepare(
      `
    SELECT COUNT(*) AS c
    FROM wp_articles a
    LEFT JOIN (
      SELECT target_key, COUNT(*) cnt
      FROM wp_links
      WHERE is_internal = 1 AND target_key IS NOT NULL
      GROUP BY target_key
    ) incoming ON incoming.target_key = (a.wp_type || ':' || a.wp_id)
    WHERE ${sqlWpTypesDashboardClause('a')} AND COALESCE(incoming.cnt, 0) = 0
  `,
    )
    .get() as { c: number };

  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      orphanCount: orphanRow.c || 0,
    },
  };
}

export function getWpFeatureCoverage(input: {
  auditSlugs: string[];
  queueSlugs: string[];
  performanceSlugs: string[];
}): {
  wpTotal: number;
  matched: {
    audit: number;
    queue: number;
    performance: number;
  };
  missingInWp: {
    audit: string[];
    queue: string[];
    performance: string[];
  };
} {
  const db = getWpDb();
  const wpSlugs = new Set(
    (
      db.prepare(`SELECT slug FROM wp_articles WHERE ${sqlWpTypesDashboardClause()}`).all() as Array<{
        slug: string;
      }>
    ).map((r) => r.slug),
  );

  const uniq = (items: string[]): string[] => [...new Set(items.filter(Boolean))];
  const audit = uniq(input.auditSlugs);
  const queue = uniq(input.queueSlugs);
  const performance = uniq(input.performanceSlugs);

  const missingInWp = {
    audit: audit.filter((s) => !wpSlugs.has(s)).slice(0, 200),
    queue: queue.filter((s) => !wpSlugs.has(s)).slice(0, 200),
    performance: performance.filter((s) => !wpSlugs.has(s)).slice(0, 200),
  };

  const overlap = (arr: string[]) => arr.filter((s) => wpSlugs.has(s)).length;

  return {
    wpTotal: wpSlugs.size,
    matched: {
      audit: overlap(audit),
      queue: overlap(queue),
      performance: overlap(performance),
    },
    missingInWp,
  };
}

export function getWpGraphHtmlPath(): string {
  return WP_SYNC_GRAPH_HTML;
}

export function ensureWpGraphHtmlGenerated(): GraphifyBuildResult {
  if (fs.existsSync(WP_SYNC_GRAPH_HTML)) {
    return {
      ok: true,
      htmlPath: WP_SYNC_GRAPH_HTML,
      message: 'Graph output already exists.',
    };
  }
  const rows = getAllWpRowsForGraphify();
  return runGraphifyBuild(rows);
}

export function rebuildWpGraphHtml(): GraphifyBuildResult {
  const rows = getAllWpRowsForGraphify();
  return runGraphifyBuild(rows);
}
