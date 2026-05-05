/**
 * Elementor post meta entries that are large or regenerated server-side —
 * omit when storing sync snapshots or cloning drafts.
 */
export const ELEMENTOR_GENERATED_META_KEYS = new Set<string>([
  '_elementor_css',
  '_elementor_page_assets',
  '_elementor_screenshot',
  '_elementor_page_cache',
]);

export function omitElementorGeneratedMetaKeys(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (ELEMENTOR_GENERATED_META_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
