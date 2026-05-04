/**
 * WordPress REST write helpers — create a new draft (unpublished) post/page from rewritten HTML.
 * Source post is never required for the create; taxonomies are copied only when the REST user can read the source.
 */
import { log } from './logger.js';

export type WpRestConfig = {
  baseUrl: string;
  username: string;
  appPassword: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;

export function loadWpRestConfig(): WpRestConfig | null {
  const site = process.env.WP_SITE_URL || '';
  const apiBaseEnv = process.env.WP_API_BASE_URL || '';
  const baseUrl = (apiBaseEnv || (site ? `${site.replace(/\/+$/, '')}/wp-json/wp/v2` : '')).replace(/\/+$/, '');
  const username = process.env.WP_USERNAME || '';
  const appPassword = process.env.WP_APP_PASSWORD || '';
  if (!baseUrl || !username || !appPassword) return null;
  return { baseUrl, username, appPassword };
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

type WpTypeEntry = { rest_base?: string };
type PostEdit = {
  id: number;
  slug?: string;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
};

async function tryFetchSourceMeta(
  cfg: WpRestConfig,
  restBase: string,
  sourceId: number,
): Promise<Partial<Pick<PostEdit, 'categories' | 'tags' | 'featured_media'>>> {
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
    return {
      categories: edit.categories,
      tags: edit.tags,
      featured_media: edit.featured_media,
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
 * Does not modify the source. Taxonomies / featured image are copied only if the source is readable via REST.
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
}): Promise<CreateDraftResult> {
  const restBase = await resolveRestBase(params.cfg, params.wpType);
  const meta = await tryFetchSourceMeta(params.cfg, restBase, params.wpId);
  if (!meta.categories?.length && !meta.tags?.length && !(meta.featured_media && meta.featured_media > 0)) {
    log.info({ sourceId: params.wpId, restBase }, 'wordpress draft: source meta not copied (no read access or none set); creating new draft only');
  }

  const excerpt = `Unpublished rewrite draft — source ${params.wpType} ID ${params.sourceWpId}. Review before publish.`;

  const payload: Record<string, unknown> = {
    title: params.newTitle,
    content: params.contentHtml,
    status: 'draft',
    slug: params.draftSlug,
    excerpt,
  };

  if (Array.isArray(meta.categories) && meta.categories.length) {
    payload.categories = meta.categories;
  }
  if (Array.isArray(meta.tags) && meta.tags.length) {
    payload.tags = meta.tags;
  }
  if (typeof meta.featured_media === 'number' && meta.featured_media > 0) {
    payload.featured_media = meta.featured_media;
  }

  const created = await wpRequest<{ id: number; slug?: string; link?: string }>(
    params.cfg,
    'POST',
    `/${restBase}`,
    payload,
  );

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
