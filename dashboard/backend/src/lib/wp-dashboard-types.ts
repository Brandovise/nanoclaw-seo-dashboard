/** WordPress post types indexed in dashboard DB, APIs, graphs, SEO — excludes elementor_library, etc. */
export const DASHBOARD_WP_TYPES = ['post', 'page'] as const;
export type DashboardWpType = (typeof DASHBOARD_WP_TYPES)[number];

export function isDashboardWpType(v: string): v is DashboardWpType {
  return v === 'post' || v === 'page';
}

export function sqlWpTypesDashboardClause(alias?: string): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}wp_type IN ('post', 'page'))`;
}
