/**
 * WordPress REST write helpers — create a new draft (unpublished) post/page from rewritten HTML.
 * Source post is never required for the create; taxonomies are copied only when the REST user can read the source.
 */
import { loadWpSyncConfig } from './wordpress-sync.js';
import { ELEMENTOR_GENERATED_META_KEYS } from './wp-elementor-meta-strip.js';
import { log } from './logger.js';

export type WpRestConfig = {
  baseUrl: string;
  username: string;
  appPassword: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;

/** Uses `loadWpSyncConfig()` so upload and sync read identical WP_* env (single source of truth). */
export function loadWpRestConfig(): WpRestConfig | null {
  const c = loadWpSyncConfig();
  if (!c.baseUrl || !c.username || !c.appPassword) return null;
  return { baseUrl: c.baseUrl, username: c.username, appPassword: c.appPassword };
}

function authHeader(cfg: WpRestConfig): string {
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.appPassword}`).toString('base64')}`;
}

async function wpRequest<T>(
  cfg: WpRestConfig,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${cfg.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(cfg),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WordPress ${method} ${res.status} ${url}: ${text.slice(0, 400)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(t);
  }
}

type WpRestMe = {
  id?: number;
  slug?: string;
  name?: string;
  roles?: string[];
};

type WpTypeEntry = { rest_base?: string };
type PostEdit = {
  id: number;
  slug?: string;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  meta?: Record<string, unknown>;
};

type ElementorWalkerNode = {
  elType?: string;
  widgetType?: string;
  settings?: Record<string, unknown>;
  elements?: unknown[];
};

/** Rough proxy for “primary body” widget: replace the largest HTML blob. */
function htmlPlainTextApproxLen(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

function likelyNonArticleHtml(raw: string): boolean {
  const t = raw.toLowerCase();
  return t.includes('<style') || t.includes('<script') || t.includes('<form');
}

/** Strip full-document chrome when REST `content.rendered` was a complete HTML page. */
function stripOuterDocumentShell(html: string): string {
  let h = html.trim();
  if (!h) return h;
  h = h.replace(/<!DOCTYPE[^>]*>/i, '').trim();
  h = h.replace(/<\?xml[^>]*\?>/i, '').trim();
  const bodyM = h.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyM?.[1]?.trim()) return bodyM[1].trim();
  h = h.replace(/^<html\b[^>]*>/i, '').replace(/<\/html>\s*$/i, '').trim();
  h = h.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '').trim();
  return h;
}

function longestTagInner(html: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let best = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (inner.length > best.length) best = inner;
  }
  return best.length >= 200 ? best : null;
}

/** Balanced inner HTML for a single opening `<div …>` whose `>` ends at `openAfterGt` (exclusive index of first inner char). */
function extractBalancedDivInner(html: string, openAfterGt: number): { inner: string; end: number } | null {
  let depth = 1;
  let pos = openAfterGt;
  const start = pos;
  const lower = html.toLowerCase();
  while (pos < html.length && depth > 0) {
    const idxDiv = lower.indexOf('<div', pos);
    const idxClose = lower.indexOf('</div>', pos);
    if (idxClose === -1) return null;
    if (idxDiv !== -1 && idxDiv < idxClose) {
      depth += 1;
      pos = idxDiv + 4;
    } else {
      depth -= 1;
      if (depth === 0) {
        return { inner: html.slice(start, idxClose), end: idxClose + 6 };
      }
      pos = idxClose + 6;
    }
  }
  return null;
}

/**
 * When the formatter preserved the full Elementor front-end tree, pull the largest
 * `elementor-widget-container` island so we do not nest a whole page inside one Text/HTML widget.
 */
function largestElementorWidgetContainerInner(html: string): string | null {
  if (!/elementor-widget-container/i.test(html)) return null;
  const re = /<div\b[^>]*\belementor-widget-container\b[^>]*>/gi;
  let best = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const afterGt = m.index + m[0].length;
    const parsed = extractBalancedDivInner(html, afterGt);
    if (!parsed) continue;
    const inner = parsed.inner.trim();
    if (inner.length < 80) continue;
    if (likelyNonArticleHtml(inner)) continue;
    if (htmlPlainTextApproxLen(inner) > htmlPlainTextApproxLen(best)) best = inner;
  }
  return best.length > 0 ? best : null;
}

/**
 * Formatter output often mirrors `content.rendered` (full Elementor page). For `_elementor_data`
 * injection we need a **single-widget** fragment: unwrap document/article layers and, when needed,
 * the largest Elementor rich-text container so layout stays valid and duplicates shrink.
 */
function sanitizeHtmlForElementorSingleWidget(html: string): string {
  const rawLen = html.trim().length;
  let h = stripOuterDocumentShell(html.trim());
  if (!h) return h;
  const mainInner = longestTagInner(h, 'main');
  if (mainInner && htmlPlainTextApproxLen(mainInner) >= Math.min(280, htmlPlainTextApproxLen(h) * 0.18)) {
    h = mainInner;
  }
  const articleInner = longestTagInner(h, 'article');
  if (articleInner && htmlPlainTextApproxLen(articleInner) >= Math.min(400, htmlPlainTextApproxLen(h) * 0.2)) {
    h = articleInner;
  }
  if (/elementor-widget-container|data-elementor-type/i.test(html)) {
    const island = largestElementorWidgetContainerInner(h);
    const islandPlain = island ? htmlPlainTextApproxLen(island) : 0;
    const hPlain = htmlPlainTextApproxLen(h);
    if (island && islandPlain >= 120 && (rawLen > 9000 || islandPlain >= hPlain * 0.32)) {
      h = island;
    }
  }
  return h.trim();
}

/**
 * Inject rewritten HTML into the largest Elementor Text Editor or HTML widget.
 * Leaves layout/sections intact; preserves Elementor-openable drafts when source was built with Elementor.
 */
function injectHtmlIntoElementorDataJson(rawData: unknown, newHtml: string): { injected: boolean; data: unknown } {
  if (newHtml.length === 0) return { injected: false, data: rawData };
  let parsed: unknown = rawData;
  if (typeof rawData === 'string') {
    try {
      parsed = JSON.parse(rawData) as unknown;
    } catch {
      return { injected: false, data: rawData };
    }
  }
  const roots = Array.isArray(parsed) ? parsed : null;
  if (!roots) return { injected: false, data: rawData };

  type Candidate = {
    holder: Record<string, unknown>;
    field: string;
    score: number;
    widgetType: string;
    raw: string;
  };
  let best: Candidate | undefined;
  const candidates: Candidate[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as ElementorWalkerNode;
    const children = n.elements;
    if (Array.isArray(children)) {
      for (const c of children) visit(c);
    }
    if (n.elType !== 'widget' || !n.settings || typeof n.settings !== 'object') return;
    const wt = typeof n.widgetType === 'string' ? n.widgetType : '';
    const pick = (field: string) => {
      const v = n.settings![field];
      if (typeof v !== 'string' || !v.trim()) return;
      const score = htmlPlainTextApproxLen(v);
      const c: Candidate = { holder: n.settings as Record<string, unknown>, field, score, widgetType: wt, raw: v };
      candidates.push(c);
      if (!best || score > best.score) best = c;
    };
    if (wt === 'text-editor') pick('editor');
    if (wt === 'html') pick('html');
  };

  for (const r of roots) visit(r);
  if (!best) return { injected: false, data: parsed };
  if (best.score < 15) return { injected: false, data: parsed };
  if (best.score < 40) {
    log.warn(
      { bestScore: best.score, widgetType: best.widgetType },
      'wordpress elementor: primary text/html widget is small — injecting anyway to avoid leaving stale body in other widgets',
    );
  }
  best.holder[best.field] = newHtml;

  const isProtectedWidgetField = (widgetType: string, field: string, raw: string): boolean => {
    const wt = widgetType.toLowerCase();
    const f = field.toLowerCase();
    if (wt.includes('form')) return true;
    if (wt.includes('shortcode')) return true;
    if (likelyNonArticleHtml(raw)) return true;
    if (
      /(^_|id$|class$|css|script|shortcode|url|link|href|placeholder|button|submit|label|name|email|tel|phone|captcha)/i.test(
        f,
      )
    ) {
      return true;
    }
    return false;
  };
  const strictCleanup = process.env.WP_ELEMENTOR_STRICT_CLEANUP === 'true';
  /** Always clear other large Text/HTML widgets so the old article does not stack under the new body. */
  const siblingClearThreshold = Math.max(90, Math.min(420, Math.floor(best.score * 0.13)));
  const strictExtraThreshold = Math.max(55, Math.floor(best.score * 0.08));
  let cleared = 0;
  for (const c of candidates) {
    if (c === best) continue;
    if (isProtectedWidgetField(c.widgetType, c.field, c.raw)) continue;
    const passesSibling = c.score >= siblingClearThreshold;
    const passesStrictExtra = strictCleanup && c.score >= strictExtraThreshold;
    if (!passesSibling && !passesStrictExtra) continue;
    c.holder[c.field] = '';
    cleared += 1;
  }

  // Some themes/pages keep article body fragments in non text-editor widgets
  // (e.g., icon-box descriptions/headings). Clear residual narrative fields broadly.
  // We intentionally keep protected fields (forms/shortcodes/css/script/url/labels, etc.).
  const secondaryThreshold = 18;
  const clearNestedStrings = (widgetType: string, root: unknown, path: string[] = []): unknown => {
    if (typeof root === 'string') {
      const key = path[path.length - 1] || '';
      const score = htmlPlainTextApproxLen(root);
      if (score < secondaryThreshold) return root;
      if (isProtectedWidgetField(widgetType, key, root)) return root;
      cleared += 1;
      return '';
    }
    if (Array.isArray(root)) {
      return root.map((v, i) => clearNestedStrings(widgetType, v, [...path, String(i)]));
    }
    if (root && typeof root === 'object') {
      const obj = root as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        obj[k] = clearNestedStrings(widgetType, v, [...path, k]);
      }
      return obj;
    }
    return root;
  };

  const clearResidualNarrative = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as ElementorWalkerNode;
    const children = n.elements;
    if (Array.isArray(children)) {
      for (const c of children) clearResidualNarrative(c);
    }
    if (n.elType !== 'widget' || !n.settings || typeof n.settings !== 'object') return;
    const wt = typeof n.widgetType === 'string' ? n.widgetType : '';
    const settings = n.settings as Record<string, unknown>;
    for (const [field, value] of Object.entries(settings)) {
      if (best && settings === best.holder && field === best.field) continue;
      settings[field] = clearNestedStrings(wt, value, [field]);
    }
  };
  if (strictCleanup) {
    for (const r of roots) clearResidualNarrative(r);
  }

  log.info(
    { replacedScore: best.score, cleared, strictCleanup },
    'wordpress elementor: injected rewritten body into primary widget',
  );
  return { injected: true, data: parsed };
}

/**
 * `_elementor_data` is registered as REST meta type **string** (serialized editor JSON blob).
 * Other keys (e.g. `_elementor_page_settings`) are **`object`** and must remain JSON objects — not doubly-encoded strings.
 */
const ELEMENTOR_REST_STRING_META_KEYS = new Set(['_elementor_data']);

function coerceMetaValueForRest(metaKey: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;

  if (typeof v === 'string') {
    if (ELEMENTOR_REST_STRING_META_KEYS.has(metaKey)) return v;
    const trimmed = v.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === 'object') return parsed;
      } catch {
        /* keep string */
      }
    }
    return v;
  }

  if (Array.isArray(v) || typeof v === 'object') {
    if (ELEMENTOR_REST_STRING_META_KEYS.has(metaKey)) {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return v;
  }

  return String(v);
}

type ElementorMetaPayloadResult = {
  meta?: Record<string, unknown>;
  injected: boolean;
};

/** Copy Elementor post meta from source (REST-shaped). Strip generated CSS/assets; optionally inject HTML into `_elementor_data`. */
function buildElementorMetaPayload(
  sourceMeta: Record<string, unknown> | undefined,
  contentHtml: string,
): ElementorMetaPayloadResult {
  if (!sourceMeta || typeof sourceMeta !== 'object') return { meta: undefined, injected: false };
  const editMode =
    typeof sourceMeta._elementor_edit_mode === 'string'
      ? sourceMeta._elementor_edit_mode
      : typeof sourceMeta._elementor_edit_mode === 'number'
        ? String(sourceMeta._elementor_edit_mode)
        : '';
  const rawData = sourceMeta._elementor_data;
  const hasRaw =
    rawData !== undefined &&
    rawData !== null &&
    (typeof rawData === 'string' ? rawData.trim().length > 0 : Array.isArray(rawData) ? rawData.length > 0 : false);
  const usesElementor = editMode === 'builder' && hasRaw;
  if (!usesElementor) return { meta: undefined, injected: false };

  const next: Record<string, unknown> = {};
  let dataOut: unknown = rawData;

  let htmlForWidget = sanitizeHtmlForElementorSingleWidget(contentHtml);
  if (htmlForWidget.trim().length < 40 && contentHtml.trim().length > 400) {
    log.warn(
      {},
      'wordpress elementor: sanitizer produced very little text vs source — using raw HTML for inject (layout may need manual trim)',
    );
    htmlForWidget = contentHtml.trim();
  }
  if (htmlForWidget.length + 400 < contentHtml.length) {
    log.info(
      { beforeChars: contentHtml.length, afterChars: htmlForWidget.length },
      'wordpress elementor: reduced full-page/Elementor chrome before single-widget inject',
    );
  }
  const { injected, data } = injectHtmlIntoElementorDataJson(rawData, htmlForWidget);
  dataOut = data;
  if (!injected) {
    log.info(
      {},
      'wordpress elementor: no large text-editor/html widget to replace — copying layout JSON unchanged; rely on post content where applicable',
    );
  }

  for (const [k, v] of Object.entries(sourceMeta)) {
    if (!k.startsWith('_elementor')) continue;
    if (ELEMENTOR_GENERATED_META_KEYS.has(k)) continue;
    if (k === '_elementor_data') {
      next[k] = coerceMetaValueForRest('_elementor_data', dataOut);
      continue;
    }
    next[k] = coerceMetaValueForRest(k, v);
  }

  next._elementor_edit_mode = 'builder';

  log.info({ keys: Object.keys(next), injected }, 'wordpress elementor: attaching meta on new draft');

  return { meta: next, injected };
}

async function fetchSourcePostForDuplicate(
  cfg: WpRestConfig,
  restBase: string,
  sourceId: number,
): Promise<Partial<Pick<PostEdit, 'categories' | 'tags' | 'featured_media'>> & { meta?: Record<string, unknown> }> {
  const tryGet = async (query: string): Promise<PostEdit | null> => {
    try {
      const path = query ? `/${restBase}/${sourceId}?${query}` : `/${restBase}/${sourceId}`;
      return await wpRequest<PostEdit>(cfg, 'GET', path);
    } catch {
      return null;
    }
  };
  const edit = await tryGet('context=edit');
  if (edit) {
    const metaRecord =
      edit.meta && typeof edit.meta === 'object' && !Array.isArray(edit.meta)
        ? (edit.meta as Record<string, unknown>)
        : undefined;
    return {
      categories: edit.categories,
      tags: edit.tags,
      featured_media: edit.featured_media,
      ...(metaRecord ? { meta: metaRecord } : {}),
    };
  }
  const view = await tryGet('');
  if (view) {
    return {
      categories: view.categories,
      tags: view.tags,
      featured_media: view.featured_media,
    };
  }
  return {};
}

function wpLoginFailureHelp(cfg: WpRestConfig, rawError: string): string {
  const credsPresent = Boolean(cfg.username?.trim()) && Boolean(cfg.appPassword?.trim());
  const notLoggedIn = /rest_not_logged_in/i.test(rawError);
  const lines = [
    `${rawError}`,
    '',
    notLoggedIn
      ? 'WordPress returned rest_not_logged_in — it did not accept HTTP Basic auth (no user is logged in for REST). Typical causes:'
      : 'WordPress REST auth failed. Check the following:',
    '1) Credentials: WP_USERNAME must be the exact login (Users screen), not display name. WP_APP_PASSWORD is from wp-admin → Users → Profile → Application Passwords for that same user (regenerate if unsure).',
    '2) Dashboard API container: ensure WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD are passed into the process (e.g. docker compose env_file pointing at the repo .env; then `docker compose up --build` or restart api).',
    '3) Host / CDN / security plugins: the Authorization header is often stripped before PHP. Apache may need RewriteRule to pass HTTP_AUTHORIZATION; nginx may need `fastcgi_param HTTP_AUTHORIZATION $http_authorization;`. Cloudflare or WAF rules can block it.',
    '4) Site must use HTTPS for Application Passwords; remove stray spaces or quotes in .env values.',
    !credsPresent ? '5) In this request, username or app password resolved empty in config — fix env in the running container.' : '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Proves Application Password auth; distinguishes wrong/missing Docker env vs role/capability. */
async function fetchRestCurrentUser(cfg: WpRestConfig): Promise<WpRestMe> {
  log.info(
    {
      wpEnv: {
        hasUsername: Boolean(cfg.username?.trim()),
        hasAppPassword: Boolean(cfg.appPassword?.trim()),
        baseHost: (() => {
          try {
            return new URL(cfg.baseUrl.replace(/\/wp-json\/wp\/v2\/?$/, '') || cfg.baseUrl).hostname;
          } catch {
            return undefined;
          }
        })(),
      },
    },
    'wordpress: REST auth probe (credentials present, not values)',
  );
  try {
    return await wpRequest<WpRestMe>(cfg, 'GET', '/users/me?context=edit');
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(wpLoginFailureHelp(cfg, raw));
  }
}

const restBaseCache = new Map<string, string>();

export async function resolveRestBase(cfg: WpRestConfig, wpType: string): Promise<string> {
  const key = wpType.toLowerCase() || 'post';
  const hit = restBaseCache.get(key);
  if (hit) return hit;
  let types: Record<string, WpTypeEntry>;
  try {
    types = await wpRequest<Record<string, WpTypeEntry>>(cfg, 'GET', '/types');
  } catch {
    types = await wpRequest<Record<string, WpTypeEntry>>(cfg, 'GET', '/types?context=edit');
  }
  const def = types[key];
  const rb = typeof def?.rest_base === 'string' ? def.rest_base : key === 'page' ? 'pages' : 'posts';
  restBaseCache.set(key, rb);
  return rb;
}

function buildAdminEditUrl(siteBase: string, wpId: number): string {
  const base = siteBase.replace(/\/+$/, '');
  return `${base}/wp-admin/post.php?post=${wpId}&action=edit`;
}

export type CreateDraftResult = {
  draftId: number;
  draftSlug: string;
  adminEditUrl: string;
  restLink: string;
};

/**
 * Create a new unpublished (draft) post or page with the given HTML.
 * If the source was edited with Elementor (`_elementor_edit_mode: builder`), copies Elementor meta from the source
 * and injects rewritten HTML into the largest Text Editor / HTML widget in `_elementor_data` so the draft opens in Elementor.
 */
export async function createDraftDuplicate(params: {
  cfg: WpRestConfig;
  siteBase: string;
  wpId: number;
  wpType: string;
  newTitle: string;
  contentHtml: string;
  draftSlug: string;
  sourceWpId: number;
  /** Parsed `wp_articles.rest_meta_json` when live REST omits `meta` (e.g. collection responses without meta). */
  sourceRestMetaFallback?: Record<string, unknown> | null;
}): Promise<CreateDraftResult> {
  const me = await fetchRestCurrentUser(params.cfg);
  log.info(
    { wpRestUser: me.slug, id: me.id, roles: me.roles },
    'wordpress: REST authenticated before draft create',
  );

  const restBase = await resolveRestBase(params.cfg, params.wpType);
  let dup = await fetchSourcePostForDuplicate(params.cfg, restBase, params.wpId);
  const metaKeys = dup.meta && typeof dup.meta === 'object' && !Array.isArray(dup.meta) ? Object.keys(dup.meta) : [];
  if (!metaKeys.length && params.sourceRestMetaFallback && typeof params.sourceRestMetaFallback === 'object') {
    dup = {
      ...dup,
      meta: { ...params.sourceRestMetaFallback },
    };
    log.info({ sourceId: params.wpId }, 'wordpress draft: merged synced rest_meta fallback (live REST had no meta)');
  }
  if (
    !dup.categories?.length &&
    !dup.tags?.length &&
    !(dup.featured_media && dup.featured_media > 0) &&
    !dup.meta?.['_elementor_data']
  ) {
    log.info({ sourceId: params.wpId, restBase }, 'wordpress draft: source snapshot minimal (taxonomy/elementor missing if no REST access)');
  }

  const elementor = buildElementorMetaPayload(dup.meta, params.contentHtml);
  const elementorMeta = elementor.meta;

  const excerpt = `Unpublished rewrite draft — source ${params.wpType} ID ${params.sourceWpId}. Review before publish.`;

  const payload: Record<string, unknown> = {
    title: params.newTitle,
    // Avoid duplicate front-end rendering (Elementor content + post_content) when Elementor injection succeeded.
    content: elementor.injected ? '' : params.contentHtml,
    status: 'draft',
    slug: params.draftSlug,
    excerpt,
  };

  if (Array.isArray(dup.categories) && dup.categories.length) {
    payload.categories = dup.categories;
  }
  if (Array.isArray(dup.tags) && dup.tags.length) {
    payload.tags = dup.tags;
  }
  if (typeof dup.featured_media === 'number' && dup.featured_media > 0) {
    payload.featured_media = dup.featured_media;
  }

  const hasElementorMeta = Boolean(elementorMeta && Object.keys(elementorMeta).length > 0);

  function shouldRetryDraftWithoutInlineMeta(err: unknown): boolean {
    const m = err instanceof Error ? err.message : String(err);
    if (/401|403|rest_cannot_create|rest_not_logged_in/i.test(m)) return false;
    return /\bmeta\b|_elementor|rest_invalid_(param|key)|cannot be updated|rest_(forbidden|blocked)/i.test(m);
  }

  let created: { id: number; slug?: string; link?: string };
  try {
    if (hasElementorMeta && elementorMeta) {
      try {
        created = await wpRequest<{ id: number; slug?: string; link?: string }>(
          params.cfg,
          'POST',
          `/${restBase}`,
          { ...payload, meta: elementorMeta },
        );
      } catch (e1) {
        if (!shouldRetryDraftWithoutInlineMeta(e1)) throw e1;
        log.warn({ err: e1 }, 'wordpress elementor: POST with inline meta failed — retrying without meta then PATCH');
        created = await wpRequest<{ id: number; slug?: string; link?: string }>(
          params.cfg,
          'POST',
          `/${restBase}`,
          payload,
        );
        await wpRequest(params.cfg, 'PATCH', `/${restBase}/${created.id}`, { meta: elementorMeta });
      }
    } else {
      created = await wpRequest<{ id: number; slug?: string; link?: string }>(
        params.cfg,
        'POST',
        `/${restBase}`,
        payload,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/401|rest_cannot_create/i.test(msg)) {
      throw new Error(
        `${msg}\n` +
          `REST user was: ${me.slug ?? '?'} (id=${me.id ?? '?'}, roles=${(me.roles ?? []).join(',') || '?'}). ` +
          `Creating posts requires a role with edit_posts (e.g. Administrator, Editor, Author). Sync can still work using public endpoints without this capability.`,
      );
    }
    throw e;
  }

  const draftId = created.id;
  const draftSlug = typeof created.slug === 'string' ? created.slug : params.draftSlug;
  const restLink = typeof created.link === 'string' ? created.link : '';
  const admin = buildAdminEditUrl(params.siteBase, draftId);

  log.info({ draftId, draftSlug, restBase, wpType: params.wpType }, 'wordpress draft created');

  return {
    draftId,
    draftSlug,
    adminEditUrl: admin,
    restLink: restLink || admin,
  };
}
