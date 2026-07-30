/**
 * Distilled public positioning from https://unabhaengiger-finanzberater.de/ueber-uns/
 * — for model tone/E-E-A-T only. Do not use as a source of verifiable claims unless the page body already states them.
 */
export const UEBER_UNS_SOURCE_URL = 'https://unabhaengiger-finanzberater.de/ueber-uns/';

export const PUBLICATION_BACKGROUND_FOR_PROMPTS = `## Brand and business context (public „${UEBER_UNS_SOURCE_URL}“)
**Brand:** Unabhängiger Finanzberater — **unabhaengiger-finanzberater.de** — German-language site for private clients (consistent **Sie**-Anrede).
**Legal entity (site footer):** InCoFin GmbH & Co. KG operates the offering visitors see under this brand.

**What “unabhängig” means here (visitor-facing story):**
- **Produktneutral:** access to a broad market of insurers and investment options, not bound to a single provider or fund family—contrasted on the site with representatives who remain product-tied.
- **Vergütung:** Vergütung can be an agreed **Honorar** with the client and/or via **Vertragspartner**; the site stresses transparency (understandable statements, written **Beratungsvertrag**, traceable costs).
- **Ablauf:** relationship begins with getting to know the client; **Finanzanalyse** / transparent basis before concrete insurance or investment packages; several appointments possible; long-term accompaniment and individualized plans (life situation, goals, income, liabilities).

**Values highlighted on Über uns:** openness and loyalty; engagement and security; fairness and quality; individuality and accompaniment.
**Scope (high level):** Versicherungen, Geldanlage / Investment, Altersvorsorge, Honorarberatung, Finanzplanung—typical German retail financial advisory topics.
**Presentation:** team-based organization (leadership, advisors, back office, **Kooperationspartner** as described on the site). Do **not** add or invent individual names, titles, statistics, phone numbers, or partner claims unless they already appear in the **source HTML** of the article you are editing.

Use this block for **voice, positioning, and E-E-A-T alignment**—not as a substitute for facts in the article or for regulatory/legal precision.`;
