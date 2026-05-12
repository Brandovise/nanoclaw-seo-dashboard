/**
 * Organization usage & cost from Anthropic Admin API (requires sk-ant-admin… key).
 * Shapes match what dashboard billing panels expect (raw `usage` / `cost` bucket arrays).
 */
import { log } from './logger.js';

const API = 'https://api.anthropic.com';

/** Response for POST-like UI: usage/cost buckets or `_error`. */
export type AnthropicAdminBillingPayload =
  | { usage: { data: unknown[] }; cost: { data: unknown[] } }
  | { _error: string };

type PageResult = {
  data: unknown[];
  has_more?: boolean;
  next_page?: string;
};

async function fetchReportPage(path: string, adminKey: string, search: URLSearchParams, pageToken?: string): Promise<PageResult> {
  const qs = new URLSearchParams(search);
  if (pageToken) qs.set('page', pageToken);

  const url = `${API}${path}?${qs.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    },
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }
  try {
    const body = JSON.parse(raw) as PageResult & Record<string, unknown>;
    const data = Array.isArray(body.data) ? body.data : [];
    return {
      data,
      has_more: Boolean(body.has_more),
      next_page: typeof body.next_page === 'string' ? body.next_page : undefined,
    };
  } catch {
    throw new Error(`Non-JSON admin API response: ${raw.slice(0, 200)}`);
  }
}

async function fetchAllReportData(
  path: string,
  adminKey: string,
  baseParams: URLSearchParams,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let page: string | undefined;
  let guard = 0;
  do {
    const chunk = await fetchReportPage(path, adminKey, baseParams, page);
    out.push(...chunk.data);
    page = chunk.has_more && chunk.next_page ? chunk.next_page : undefined;
    guard++;
    if (guard > 100) {
      log.warn({ path }, 'anthropic admin report pagination guard hit');
      break;
    }
  } while (page);
  return out;
}

/**
 * @param sinceIso inclusive start (RFC3339)
 * @param untilIso exclusive end (RFC3339), typically now
 */
export async function fetchAnthropicAdminBilling(
  adminKey: string,
  opts: {
    sinceIso: string;
    untilIso: string;
    period: 'today' | 'week' | 'month';
    /** Restrict report to these Anthropic API key IDs (Console → API keys → id). */
    apiKeyIds?: string[];
  },
): Promise<AnthropicAdminBillingPayload> {
  const key = adminKey.trim();
  if (!key.startsWith('sk-ant-admin')) {
    return {
      _error:
        'Key must be an Anthropic Admin API key (starts with sk-ant-admin). Standard API keys cannot read organization usage.',
    };
  }

  const bucketWidth = opts.period === 'today' ? '1h' : '1d';

  try {
    const usageParams = new URLSearchParams({
      starting_at: opts.sinceIso,
      ending_at: opts.untilIso,
      bucket_width: bucketWidth,
    });
    usageParams.append('group_by[]', 'model');
    for (const id of opts.apiKeyIds ?? []) {
      if (id.trim()) usageParams.append('api_key_ids', id.trim());
    }
    const costParams = new URLSearchParams({
      starting_at: opts.sinceIso,
      ending_at: opts.untilIso,
      bucket_width: bucketWidth,
    });
    for (const id of opts.apiKeyIds ?? []) {
      if (id.trim()) costParams.append('api_key_ids', id.trim());
    }

    const [usageData, costData] = await Promise.all([
      fetchAllReportData('/v1/organizations/usage_report/messages', key, usageParams).catch((e) => {
        log.warn({ err: String(e) }, 'anthropic usage_report/messages failed; retrying without group_by');
        const p = new URLSearchParams(usageParams);
        p.delete('group_by[]');
        return fetchAllReportData('/v1/organizations/usage_report/messages', key, p);
      }),
      fetchAllReportData('/v1/organizations/cost_report', key, costParams).catch((e) => {
        log.warn({ err: String(e) }, 'anthropic cost_report failed (tokens may still show)');
        return [];
      }),
    ]);

    return {
      usage: { data: usageData },
      cost: { data: costData },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ err: msg }, 'fetchAnthropicAdminBilling failed');
    return { _error: msg };
  }
}
