/**
 * WordPress REST write helpers — create a new draft (unpublished) post/page from rewritten HTML.
 *
 * Elementor strategy:
 *   1. Sanitize the formatter HTML to a plain semantic article-body fragment (h1–h6, p,
 *      ul/ol/li, blockquote, table, a, img, strong/em, …). Everything Elementor-specific
 *      (wrappers, scripts, classes, data-*) is stripped.
 *   2. Walk the source `_elementor_data` and pick widget *prototypes* — the first heading
 *      widget per header_size, the first text-editor, the first icon-list (with its icon /
 *      typography / spacing settings), and the outer container's layout settings.
 *   3. Rebuild `_elementor_data` from the new content using those prototypes: each heading
 *      block becomes a heading widget with the source's heading typography; each list
 *      block becomes an icon-list widget with the source's icon (e.g. `fas fa-circle`,
 *      `fas fa-check`) reused per item; paragraph blocks become text-editor widgets with
 *      the source's editor typography. Source widget *content* is discarded so no old
 *      article fragments can render under the new one — but the *styling* is preserved.
 *   4. `post_content` is also set to the cleaned HTML so feeds, AMP, and non-Elementor
 *      rendering paths still show the article correctly.
 */
import { randomBytes } from 'node:crypto';
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
  template?: string;
  categories?: number[];
  tags?: number[];
  featured_media?: number;
  meta?: Record<string, unknown>;
};

// ──────────────────────────────────────────────────────────────────────────────
// HTML sanitization → semantic article body
// ──────────────────────────────────────────────────────────────────────────────

const ALLOWED_BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'pre', 'figure', 'figcaption',
  'hr', 'br',
]);

const ALLOWED_INLINE_TAGS = new Set([
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'code', 'sup', 'sub', 'small', 'mark', 'img',
]);

const ALLOWED_TAGS = new Set([...ALLOWED_BLOCK_TAGS, ...ALLOWED_INLINE_TAGS]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);

const STRIP_BLOCK_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button',
  'select', 'option', 'textarea', 'audio', 'video', 'canvas', 'object', 'embed',
  'input', 'label', 'fieldset', 'legend',
];

function escapeAttrValue(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function extractAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = attrs.match(re);
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? '').trim();
}

/**
 * Aggressive deterministic cleanup. Takes the formatter output (which often mirrors
 * the full Elementor frontend tree) and produces a plain semantic article-body fragment
 * suitable for a single text-editor widget.
 */
export function cleanHtmlToSemanticBody(raw: string): string {
  if (!raw) return '';
  let h = raw;

  // 1. Document chrome
  h = h.replace(/<!DOCTYPE[^>]*>/gi, '');
  h = h.replace(/<\?xml[^>]*\?>/gi, '');
  h = h.replace(/<\/?(html|head|body)\b[^>]*>/gi, '');

  // 2. HTML comments (including WP block comments — they don't help inside Elementor)
  h = h.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Strip dangerous / unwanted tags AND their content
  for (const tag of STRIP_BLOCK_TAGS) {
    const blockRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    const selfRe = new RegExp(`<${tag}\\b[^>]*/>`, 'gi');
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    h = h.replace(blockRe, '').replace(selfRe, '').replace(openRe, '').replace(closeRe, '');
  }

  // 4. Walk every tag: rewrite allowed tags with whitelisted attrs, drop non-allowed tags
  //    (drop the tag, keep inner content — i.e. unwrap divs/sections/articles/spans).
  h = h.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (_match, tagRaw: string, attrsRaw: string) => {
    const tag = tagRaw.toLowerCase();
    const isClosing = _match.startsWith('</');
    if (!ALLOWED_TAGS.has(tag)) return '';

    if (isClosing) {
      if (VOID_TAGS.has(tag)) return '';
      return `</${tag}>`;
    }

    let attrs = '';
    if (tag === 'a') {
      const href = extractAttr(attrsRaw, 'href');
      const title = extractAttr(attrsRaw, 'title');
      if (href) attrs += ` href="${escapeAttrValue(href)}"`;
      if (title) attrs += ` title="${escapeAttrValue(title)}"`;
      // Mark external links open in new tab is a theme choice; leave default behavior.
    } else if (tag === 'img') {
      const src = extractAttr(attrsRaw, 'src');
      const alt = extractAttr(attrsRaw, 'alt');
      const title = extractAttr(attrsRaw, 'title');
      if (!src) return ''; // drop broken <img>
      attrs += ` src="${escapeAttrValue(src)}"`;
      attrs += ` alt="${escapeAttrValue(alt ?? '')}"`;
      if (title) attrs += ` title="${escapeAttrValue(title)}"`;
    }

    if (VOID_TAGS.has(tag)) return `<${tag}${attrs} />`;
    return `<${tag}${attrs}>`;
  });

  // 5. Drop empty inline/block wrappers introduced by the unwrap step.
  //    (Font-awesome <i class="fas fa-…"></i> icon tags become empty after attrs are stripped — drop them.)
  for (let i = 0; i < 4; i += 1) {
    const before = h;
    h = h.replace(/<(i|b|em|strong|u|s|small|mark|sup|sub|code|a)>\s*<\/\1>/gi, '');
    h = h.replace(/<(p|li|h[1-6]|blockquote|figcaption|td|th|caption)>\s*<\/\1>/gi, '');
    h = h.replace(/<(ul|ol|table|thead|tbody|tfoot|tr|figure)>\s*<\/\1>/gi, '');
    if (h === before) break;
  }

  // 6. Whitespace normalization (preserve paragraph structure)
  h = h.replace(/[ \t]+/g, ' ');
  h = h.replace(/\s*\n\s*\n+\s*/g, '\n\n');
  h = h.replace(/>\s+</g, '><');

  return h.trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Source widget prototypes + content-block parser
// ──────────────────────────────────────────────────────────────────────────────

function elementorId(): string {
  // Source data uses 7-hex IDs (e.g. "bdb86d5", "8b0ddc7"); match that shape so
  // the regenerated tree is indistinguishable from a hand-edited one.
  return randomBytes(4).toString('hex').slice(0, 7);
}

type ElementorElement = {
  id: string;
  elType: string;
  settings: Record<string, unknown>;
  elements: ElementorElement[];
  isInner: boolean;
  widgetType?: string;
};

type WidgetPrototypes = {
  /** First heading widget per `header_size` value ("h1" → widget). Falls back to a generic prototype if specific size missing. */
  headings: Map<string, ElementorElement>;
  textEditor: ElementorElement | null;
  iconList: ElementorElement | null;
  iconBox: ElementorElement | null;
  /** First top-level container/section — its settings define the page-body wrapper (boxed_width, padding, …). */
  outerWrapper: ElementorElement | null;
};

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isElementorElement(v: unknown): v is ElementorElement {
  return !!v && typeof v === 'object' && 'elType' in (v as Record<string, unknown>);
}

function parseElementorData(raw: unknown): ElementorElement[] | null {
  let data: unknown = raw;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data)) return null;
  return data.filter(isElementorElement);
}

function collectPrototypes(elements: ElementorElement[]): WidgetPrototypes {
  const protos: WidgetPrototypes = {
    headings: new Map(),
    textEditor: null,
    iconList: null,
    iconBox: null,
    outerWrapper: null,
  };
  // First top-level container/section becomes the wrapper prototype.
  for (const el of elements) {
    if (el.elType === 'container' || el.elType === 'section') {
      protos.outerWrapper = el;
      break;
    }
  }
  const visit = (els: ElementorElement[]): void => {
    for (const el of els) {
      if (el.elType === 'widget') {
        const settings = (el.settings ?? {}) as Record<string, unknown>;
        if (el.widgetType === 'heading') {
          const sizeRaw = settings.header_size;
          const size = typeof sizeRaw === 'string' && sizeRaw ? sizeRaw : 'h2';
          if (!protos.headings.has(size)) protos.headings.set(size, el);
        } else if (el.widgetType === 'text-editor' && !protos.textEditor) {
          protos.textEditor = el;
        } else if (el.widgetType === 'icon-list' && !protos.iconList) {
          protos.iconList = el;
        } else if (el.widgetType === 'icon-box' && !protos.iconBox) {
          protos.iconBox = el;
        }
      }
      if (Array.isArray(el.elements) && el.elements.length) visit(el.elements);
    }
  };
  visit(elements);
  return protos;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML → content blocks (heading / paragraph / list)
// ──────────────────────────────────────────────────────────────────────────────

type ContentBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; html: string }
  | { type: 'list'; ordered: boolean; items: string[] };

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractListItems(listInner: string): string[] {
  const items: string[] = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(listInner)) !== null) {
    const inner = (m[1] ?? '').trim();
    // Items keep inline tags (a/strong/em); just collapse whitespace.
    const cleaned = inner.replace(/\s+/g, ' ').trim();
    if (cleaned) items.push(cleaned);
  }
  return items;
}

/**
 * Walk the cleaned semantic HTML and pull out top-level blocks in document order.
 * The cleaner has already stripped wrappers, so the input is essentially a sequence
 * of `<h1>…<h6>`, `<p>`, `<ul>/<ol>`, `<blockquote>`, `<table>`, `<figure>` siblings.
 */
export function htmlToContentBlocks(html: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!html) return blocks;
  // Match each top-level block element. `[\s\S]*?` is non-greedy across newlines.
  const blockRe =
    /<(h[1-6]|p|ul|ol|blockquote|table|figure|pre)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    const inner = m[3] ?? '';
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const text = decodeBasicEntities(stripTags(inner));
      if (text) blocks.push({ type: 'heading', level, text });
    } else if (tag === 'p') {
      const trimmed = inner.trim();
      if (trimmed) blocks.push({ type: 'paragraph', html: `<p>${trimmed}</p>` });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = extractListItems(inner);
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
    } else {
      // blockquote / table / figure / pre — keep the whole element verbatim as a paragraph block.
      const verbatim = `<${tag}>${inner}</${tag}>`;
      if (inner.trim()) blocks.push({ type: 'paragraph', html: verbatim });
    }
  }
  const withStrongBullets = normalizeParagraphBullets(blocks);
  return normalizeColonLedParagraphLists(withStrongBullets);
}

function tryListItemFromParagraph(paragraphHtml: string): string | null {
  const m = paragraphHtml.match(/^<p>\s*<strong>([\s\S]*?)<\/strong>\s*([\s\S]*?)\s*<\/p>$/i);
  if (!m) return null;
  const strongText = decodeBasicEntities(stripTags(m[1] ?? '')).trim();
  const restText = decodeBasicEntities(stripTags(m[2] ?? '')).trim();
  if (!strongText) return null;
  const cleanedStrong = strongText.endsWith(':') ? strongText.slice(0, -1).trim() : strongText;
  const full = restText ? `${cleanedStrong}: ${restText}` : cleanedStrong;
  if (full.length < 8) return null;
  return full;
}

function normalizeParagraphBullets(blocks: ContentBlock[]): ContentBlock[] {
  if (!blocks.length) return blocks;
  const out: ContentBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type !== 'paragraph') {
      out.push(b);
      i += 1;
      continue;
    }
    const firstItem = tryListItemFromParagraph(b.html);
    if (!firstItem) {
      out.push(b);
      i += 1;
      continue;
    }
    const items: string[] = [firstItem];
    let j = i + 1;
    while (j < blocks.length) {
      const n = blocks[j];
      if (n.type !== 'paragraph') break;
      const item = tryListItemFromParagraph(n.html);
      if (!item) break;
      items.push(item);
      j += 1;
    }
    if (items.length >= 2) {
      out.push({ type: 'list', ordered: false, items });
      i = j;
    } else {
      out.push(b);
      i += 1;
    }
  }
  return out;
}

function paragraphText(paragraphHtml: string): string {
  return decodeBasicEntities(stripTags(paragraphHtml)).replace(/\s+/g, ' ').trim();
}

function looksLikeListLeadParagraph(paragraphHtml: string): boolean {
  const text = paragraphText(paragraphHtml);
  if (!text) return false;
  return text.endsWith(':');
}

function looksLikeSimpleListItemParagraph(paragraphHtml: string): boolean {
  const hasRichInlineMarkup = /<(a|strong|em|b|i|u|img|table|blockquote|figure|pre)\b/i.test(paragraphHtml);
  if (hasRichInlineMarkup) return false;
  const text = paragraphText(paragraphHtml);
  if (!text) return false;
  if (text.length > 180) return false;
  if (/[.!?]\s*$/.test(text)) return false;
  return true;
}

function normalizeColonLedParagraphLists(blocks: ContentBlock[]): ContentBlock[] {
  if (!blocks.length) return blocks;
  const out: ContentBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type !== 'paragraph' || !looksLikeListLeadParagraph(b.html)) {
      out.push(b);
      i += 1;
      continue;
    }
    const items: string[] = [];
    let j = i + 1;
    while (j < blocks.length) {
      const n = blocks[j];
      if (n.type !== 'paragraph') break;
      if (!looksLikeSimpleListItemParagraph(n.html)) break;
      items.push(paragraphText(n.html));
      j += 1;
    }
    if (items.length >= 2) {
      out.push(b);
      out.push({ type: 'list', ordered: false, items });
      i = j;
    } else {
      out.push(b);
      i += 1;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Widget builders (clone prototype, swap content)
// ──────────────────────────────────────────────────────────────────────────────

function makeWidget(
  widgetType: string,
  settings: Record<string, unknown>,
): ElementorElement {
  return {
    id: elementorId(),
    elType: 'widget',
    widgetType,
    settings,
    elements: [],
    isInner: false,
  };
}

function buildHeadingWidget(
  proto: ElementorElement | undefined,
  text: string,
  level: number,
): ElementorElement {
  const settings = proto?.settings ? deepClone(proto.settings as Record<string, unknown>) : {};
  settings.title = text;
  settings.header_size = `h${level}`;
  return makeWidget('heading', settings);
}

function buildTextEditorWidget(
  proto: ElementorElement | null,
  html: string,
): ElementorElement {
  const settings = proto?.settings ? deepClone(proto.settings as Record<string, unknown>) : {};
  settings.editor = html;
  return makeWidget('text-editor', settings);
}

function buildIconListWidget(
  proto: ElementorElement | null,
  items: string[],
): ElementorElement {
  if (!proto?.settings) {
    // Fallback — no icon-list prototype available; render as a text-editor `<ul>`.
    const ulHtml = `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
    return buildTextEditorWidget(null, ulHtml);
  }
  const settings = deepClone(proto.settings as Record<string, unknown>);

  // The icon_list field is an array on the live tree but a JSON string when re-serialized
  // back into _elementor_data. Normalize to an array, build a per-item template from the
  // first existing item (so we keep its `selected_icon`), then write back as an array —
  // JSON.stringify on the whole tree will encode it correctly.
  let existing: unknown = settings.icon_list;
  if (typeof existing === 'string') {
    try {
      existing = JSON.parse(existing);
    } catch {
      existing = [];
    }
  }
  const existingArr = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
  const itemTemplate: Record<string, unknown> | null =
    existingArr.length > 0 ? deepClone(existingArr[0] as Record<string, unknown>) : null;

  const newItems: Record<string, unknown>[] = items.map((text) => {
    const item: Record<string, unknown> = itemTemplate ? deepClone(itemTemplate) : {};
    item._id = elementorId();
    item.text = text;
    // The source's links pointed at the source post's anchors — drop them so the new draft
    // doesn't carry stale `#1` / `#2` jump links.
    delete item.link;
    return item;
  });
  settings.icon_list = newItems;
  return makeWidget('icon-list', settings);
}

function buildIconBoxWidget(
  proto: ElementorElement | null,
  text: string,
): ElementorElement {
  const settings = proto?.settings ? deepClone(proto.settings as Record<string, unknown>) : {};
  // Avoid duplicated text rendering in themes where icon-box shows both title and description.
  const hadTitle =
    typeof settings.title_text === 'string' && settings.title_text.trim().length > 0;
  settings.description_text = text;
  settings.title_text = hadTitle ? text : '';
  return makeWidget('icon-box', settings);
}

// ──────────────────────────────────────────────────────────────────────────────
// Build the full _elementor_data from blocks + prototypes
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Group consecutive paragraph blocks into one text-editor widget so the editor's
 * typography wraps a coherent run of body copy (the source uses one text-editor
 * per section, not per paragraph).
 */
function widgetsFromBlocks(blocks: ContentBlock[], protos: WidgetPrototypes): ElementorElement[] {
  const out: ElementorElement[] = [];
  let paraBuffer: string[] = [];
  const flushParas = (): void => {
    if (!paraBuffer.length) return;
    const html = paraBuffer.join('\n');
    out.push(buildTextEditorWidget(protos.textEditor, html));
    paraBuffer = [];
  };
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      paraBuffer.push(b.html);
      continue;
    }
    flushParas();
    if (b.type === 'heading') {
      const headingProto =
        protos.headings.get(`h${b.level}`) ??
        protos.headings.get('h2') ??
        protos.headings.values().next().value;
      out.push(buildHeadingWidget(headingProto, b.text, b.level));
    } else if (b.type === 'list') {
      if (b.ordered) {
        // Ordered lists don't map well to icon-list (which is unordered); use a text-editor with `<ol>`
        // so numbering is preserved instead of being replaced by repeating icons.
        const olHtml = `<ol>${b.items.map((t) => `<li>${t}</li>`).join('')}</ol>`;
        out.push(buildTextEditorWidget(protos.textEditor, olHtml));
      } else {
        if (protos.iconBox) {
          for (const item of b.items) out.push(buildIconBoxWidget(protos.iconBox, item));
        } else {
          out.push(buildIconListWidget(protos.iconList, b.items));
        }
      }
    }
  }
  flushParas();
  return out;
}

function isContentWidget(el: ElementorElement): boolean {
  return (
    el.elType === 'widget' &&
    (el.widgetType === 'heading' ||
      el.widgetType === 'text-editor' ||
      el.widgetType === 'icon-list' ||
      el.widgetType === 'icon-box')
  );
}

function buildElementorDataByReplacingContentWidgets(
  sourceData: ElementorElement[],
  generatedWidgets: ElementorElement[],
): ElementorElement[] {
  const queueByType = {
    heading: generatedWidgets
      .filter((w) => w.elType === 'widget' && w.widgetType === 'heading')
      .map((w) => deepClone(w)),
    'text-editor': generatedWidgets
      .filter((w) => w.elType === 'widget' && w.widgetType === 'text-editor')
      .map((w) => deepClone(w)),
    'icon-list': generatedWidgets
      .filter((w) => w.elType === 'widget' && w.widgetType === 'icon-list')
      .map((w) => deepClone(w)),
    'icon-box': generatedWidgets
      .filter((w) => w.elType === 'widget' && w.widgetType === 'icon-box')
      .map((w) => deepClone(w)),
  };

  const takeNextForWidgetType = (widgetType: string | undefined): ElementorElement | null => {
    if (!widgetType) return null;
    if (widgetType === 'heading') return queueByType.heading.shift() ?? null;
    if (widgetType === 'text-editor') return queueByType['text-editor'].shift() ?? null;
    if (widgetType === 'icon-list') return queueByType['icon-list'].shift() ?? null;
    if (widgetType === 'icon-box') return queueByType['icon-box'].shift() ?? null;
    return null;
  };

  const extractIconBoxText = (widget: ElementorElement): string | null => {
    const settings = (widget.settings ?? {}) as Record<string, unknown>;
    const description = typeof settings.description_text === 'string' ? settings.description_text.trim() : '';
    if (description) return description;
    const title = typeof settings.title_text === 'string' ? settings.title_text.trim() : '';
    if (title) return title;
    return null;
  };

  const classifyIconBoxText = (text: string): 'positive' | 'negative' | 'neutral' => {
    const t = text.toLowerCase();
    const negativeHints = [
      'nicht',
      'kein',
      'keine',
      'ohne',
      'ausgeschlossen',
      'nicht versichert',
      'nicht gedeckt',
      'achtung',
      'warnung',
      'verboten',
      'voraussetzung',
    ];
    const positiveHints = [
      'versichert',
      'abgedeckt',
      'gedeckt',
      'inklusive',
      'inbegriffen',
      'leistet',
      'übernimmt',
      'schutz',
      'enthalten',
    ];
    if (negativeHints.some((h) => t.includes(h))) return 'negative';
    if (positiveHints.some((h) => t.includes(h))) return 'positive';
    return 'neutral';
  };

  const classifySourceIconBoxSlot = (widget: ElementorElement): 'positive' | 'negative' | 'neutral' => {
    const settings = (widget.settings ?? {}) as Record<string, unknown>;
    const iconRaw = settings.icon as unknown;
    const iconValue =
      typeof iconRaw === 'string'
        ? iconRaw
        : iconRaw && typeof iconRaw === 'object' && typeof (iconRaw as Record<string, unknown>).value === 'string'
          ? ((iconRaw as Record<string, unknown>).value as string)
          : '';
    const i = iconValue.toLowerCase();

    if (
      i.includes('fa-check') ||
      i.includes('fa-check-circle') ||
      i.includes('fa-check-square')
    ) {
      return 'positive';
    }
    if (
      i.includes('icon-cross') ||
      i.includes('fa-times') ||
      i.includes('fa-xmark') ||
      i.includes('fa-exclamation') ||
      i.includes('fa-ban') ||
      i.includes('fa-warning')
    ) {
      return 'negative';
    }
    return 'neutral';
  };

  const iconTextQueues: Record<'positive' | 'negative' | 'neutral', string[]> = {
    positive: [],
    negative: [],
    neutral: [],
  };

  for (const widget of queueByType['icon-box']) {
    const text = extractIconBoxText(widget);
    if (!text) continue;
    iconTextQueues[classifyIconBoxText(text)].push(text);
  }

  const takeNextIconBoxTextForSlot = (slotKind: 'positive' | 'negative' | 'neutral'): string | null => {
    const primary = iconTextQueues[slotKind];
    if (primary.length) return primary.shift() ?? null;
    // Never force opposite polarity into colored template slots.
    // If no same-kind text is available, only neutral spillover is allowed.
    if (slotKind !== 'neutral' && iconTextQueues.neutral.length) {
      return iconTextQueues.neutral.shift() ?? null;
    }
    if (slotKind === 'neutral') {
      if (iconTextQueues.positive.length) return iconTextQueues.positive.shift() ?? null;
      if (iconTextQueues.negative.length) return iconTextQueues.negative.shift() ?? null;
    }
    return null;
  };

  const replaceIconBoxTextOnly = (sourceWidget: ElementorElement): ElementorElement => {
    const slotKind = classifySourceIconBoxSlot(sourceWidget);
    const nextText = takeNextIconBoxTextForSlot(slotKind) ?? extractIconBoxText(sourceWidget);
    if (!nextText) return deepClone(sourceWidget);
    const cleanText = decodeBasicEntities(stripTags(nextText)).replace(/\s+/g, ' ').trim();
    if (!cleanText) return deepClone(sourceWidget);
    const cloned = deepClone(sourceWidget);
    const settings = (cloned.settings ?? {}) as Record<string, unknown>;
    const hadTitle = typeof settings.title_text === 'string' && settings.title_text.trim().length > 0;
    settings.description_text = cleanText;
    settings.title_text = hadTitle ? cleanText : '';
    cloned.settings = settings;
    return cloned;
  };

  const rewriteNode = (node: ElementorElement): ElementorElement | null => {
    if (isContentWidget(node)) {
      if (node.widgetType === 'icon-box') {
        // Keep icon/color/styling from each original template slot and only replace copy.
        // This preserves mixed bullet styles (e.g. red warning, blue info, green checks)
        // while preventing opposite-semantics text from leaking into wrong-colored slots.
        return replaceIconBoxTextOnly(node);
      }
      // Strict template slot binding: only replace with same widget type.
      // This prevents content from drifting into unrelated template regions.
      const next = takeNextForWidgetType(node.widgetType);
      return next ? deepClone(next) : deepClone(node);
    }
    const cloned: ElementorElement = {
      ...deepClone(node),
      elements: [],
    };
    if (Array.isArray(node.elements) && node.elements.length) {
      const rewrittenChildren = node.elements
        .map((child) => rewriteNode(child))
        .filter((child): child is ElementorElement => Boolean(child));
      cloned.elements = rewrittenChildren;
    }
    return cloned;
  };

  const rebuilt = sourceData
    .map((node) => rewriteNode(node))
    .filter((node): node is ElementorElement => Boolean(node));

  // Strict template-preservation mode:
  // Do not append overflow widgets into the first content host. Appending causes
  // rewritten content to appear in unintended areas (often near helper/html widgets),
  // which makes the draft look like the page template wasn't applied.
  // If rewritten content is longer than available content slots, we keep the source
  // structure intact and intentionally truncate overflow instead of mutating layout.
  return rebuilt;
}

/**
 * Build a fresh `_elementor_data` tree using the source's widget styling as prototypes
 * and the new article HTML as content. Source widget content is intentionally discarded
 * so the old article cannot bleed through; only the *styling* is reused.
 */
export function buildElementorDataFromSource(
  cleanedHtml: string,
  sourceData: ElementorElement[] | null,
): ElementorElement[] {
  const blocks = htmlToContentBlocks(cleanedHtml);
  const protos: WidgetPrototypes = sourceData
    ? collectPrototypes(sourceData)
    : { headings: new Map(), textEditor: null, iconList: null, iconBox: null, outerWrapper: null };

  // If the new HTML has no recognizable blocks (rare), fall back to a single text-editor widget
  // with the raw cleaned HTML so something useful still renders.
  const widgets =
    blocks.length > 0
      ? widgetsFromBlocks(blocks, protos)
      : [buildTextEditorWidget(protos.textEditor, cleanedHtml)];

  if (sourceData && sourceData.length) {
    return buildElementorDataByReplacingContentWidgets(sourceData, widgets);
  }

  // Wrap in the source's outer container/section if present so width/padding match the original.
  if (protos.outerWrapper) {
    const wrapper: ElementorElement = {
      id: elementorId(),
      elType: protos.outerWrapper.elType,
      settings: deepClone(protos.outerWrapper.settings as Record<string, unknown>),
      elements: [],
      isInner: false,
    };
    if (wrapper.elType === 'section') {
      // section needs a column child, then widgets inside the column.
      const column: ElementorElement = {
        id: elementorId(),
        elType: 'column',
        settings: { _column_size: 100, _inline_size: null },
        elements: widgets,
        isInner: false,
      };
      wrapper.elements = [column];
    } else {
      // container (flexbox) holds widgets directly.
      wrapper.elements = widgets;
    }
    return [wrapper];
  }

  // No outer wrapper available — fall back to the older section/column structure.
  const column: ElementorElement = {
    id: elementorId(),
    elType: 'column',
    settings: { _column_size: 100, _inline_size: null },
    elements: widgets,
    isInner: false,
  };
  const section: ElementorElement = {
    id: elementorId(),
    elType: 'section',
    settings: { structure: '10' },
    elements: [column],
    isInner: false,
  };
  return [section];
}

// ──────────────────────────────────────────────────────────────────────────────
// Source post lookup + meta payload
// ──────────────────────────────────────────────────────────────────────────────

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
  /** Whether the new draft uses Elementor (i.e. `_elementor_data` is set). */
  usesElementor: boolean;
};

/**
 * Build Elementor post meta for the new draft.
 *
 * Decision: use Elementor if the source did (`_elementor_edit_mode = builder` with non-empty
 * `_elementor_data`). When yes, build a fresh widget tree from the new content but reuse the
 * source's widget styling as prototypes (heading typography, icon-list icons, text-editor
 * fonts, outer container layout). This guarantees the old article cannot render under the
 * new one *and* preserves the visual identity of the page (checkmarks/circles on lists,
 * styled headings, branded section width, etc.).
 *
 * Generated/cached keys (CSS, screenshots, page assets) are never copied — they are
 * regenerated by Elementor on first render of the draft.
 */
function buildElementorMetaPayload(
  sourceMeta: Record<string, unknown> | undefined,
  cleanedHtml: string,
): ElementorMetaPayloadResult {
  if (!sourceMeta || typeof sourceMeta !== 'object') return { usesElementor: false };

  const rawData = sourceMeta._elementor_data;
  const sourceHasElementorData =
    rawData !== undefined &&
    rawData !== null &&
    (typeof rawData === 'string'
      ? rawData.trim().length > 0
      : Array.isArray(rawData)
        ? rawData.length > 0
        : false);
  // Some installs store `_elementor_data` but omit or vary `_elementor_edit_mode`
  // (e.g. migrated content, plugin/version differences). Presence of usable
  // Elementor data is the reliable signal for widget-based reconstruction.
  const usesElementor = sourceHasElementorData;
  if (!usesElementor) return { usesElementor: false };

  const next: Record<string, unknown> = {};

  // Build a fresh widget tree using the source's widget styling as prototypes.
  // Source widget *content* is intentionally discarded (so the old article cannot render
  // below the new one), but the source's heading typography, icon-list icons, text-editor
  // font settings, and outer container layout are reused — so the new draft looks like
  // the same Elementor theme.
  const sourceData = parseElementorData(rawData);
  const freshData = buildElementorDataFromSource(cleanedHtml, sourceData);
  next._elementor_data = JSON.stringify(freshData);
  next._elementor_edit_mode = 'builder';

  // Preserve a small allow-list of structural keys from source so the draft opens
  // in the same Elementor mode (page vs post) at the same version.
  const PRESERVE_KEYS = new Set([
    '_elementor_template_type',
    '_elementor_version',
    '_elementor_pro_version',
    '_wp_page_template',
  ]);
  for (const [k, v] of Object.entries(sourceMeta)) {
    if (!PRESERVE_KEYS.has(k)) continue;
    if (ELEMENTOR_GENERATED_META_KEYS.has(k)) continue;
    next[k] = coerceMetaValueForRest(k, v);
  }

  // Sane defaults if source omitted them.
  if (!next._elementor_template_type) {
    next._elementor_template_type = 'wp-post';
  }

  log.info(
    { keys: Object.keys(next), htmlChars: cleanedHtml.length },
    'wordpress elementor: rebuilt _elementor_data from source widget prototypes',
  );

  return { meta: next, usesElementor: true };
}

async function fetchSourcePostForDuplicate(
  cfg: WpRestConfig,
  restBase: string,
  sourceId: number,
): Promise<
  Partial<Pick<PostEdit, 'categories' | 'tags' | 'featured_media' | 'template'>> & {
    meta?: Record<string, unknown>;
  }
> {
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
      template: edit.template,
      categories: edit.categories,
      tags: edit.tags,
      featured_media: edit.featured_media,
      ...(metaRecord ? { meta: metaRecord } : {}),
    };
  }
  const view = await tryGet('');
  if (view) {
    return {
      template: view.template,
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
 *
 * For Elementor sources, builds a fresh `_elementor_data` whose widgets reuse the source's
 * styling prototypes (heading typography, icon-list icons, text-editor font, outer container
 * layout) but contain the new content — so the draft inherits the page's visual identity
 * without carrying any of the old article's text.
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

  // Sanitize the formatter HTML deterministically before doing anything else.
  const cleanedHtml = cleanHtmlToSemanticBody(params.contentHtml);
  if (cleanedHtml.length + 400 < params.contentHtml.length) {
    log.info(
      { beforeChars: params.contentHtml.length, afterChars: cleanedHtml.length },
      'wordpress: stripped Elementor scaffold/styles from formatter HTML before upload',
    );
  }
  if (cleanedHtml.length < 60 && params.contentHtml.trim().length > 200) {
    log.warn(
      { beforeChars: params.contentHtml.length, afterChars: cleanedHtml.length },
      'wordpress: sanitizer produced very little content vs source — falling back to raw HTML',
    );
  }
  const bodyHtml = cleanedHtml.length >= 60 ? cleanedHtml : params.contentHtml.trim();

  const elementor = buildElementorMetaPayload(dup.meta, bodyHtml);
  const elementorMeta = elementor.meta;

  const excerpt = `Unpublished rewrite draft — source ${params.wpType} ID ${params.sourceWpId}. Review before publish.`;

  const payload: Record<string, unknown> = {
    title: params.newTitle,
    // Always include cleaned HTML in post_content too — Elementor renders its own data,
    // but this keeps feeds/AMP/non-Elementor fallbacks correct.
    content: bodyHtml,
    status: 'draft',
    slug: params.draftSlug,
    excerpt,
  };

  if (Array.isArray(dup.categories) && dup.categories.length) {
    payload.categories = dup.categories;
  }
  if (typeof dup.template === 'string' && dup.template.trim()) {
    // Critical for pages using custom templates (e.g. elementor_header_footer).
    // Missing this can change wrapper classes and section/background rendering.
    payload.template = dup.template.trim();
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

  log.info(
    { draftId, draftSlug, restBase, wpType: params.wpType, usesElementor: elementor.usesElementor },
    'wordpress draft created',
  );

  return {
    draftId,
    draftSlug,
    adminEditUrl: admin,
    restLink: restLink || admin,
  };
}
