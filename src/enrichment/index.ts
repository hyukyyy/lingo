/**
 * Enrichment Module — Progressive enrichment for the organizational context layer.
 *
 * Exports the enrichment tracker and enriched search functionality that
 * enables Lingo to improve query quality over time through accumulated
 * usage signals.
 */

export {
  EnrichmentTracker,
  type UsageSignal,
  type SignalType,
  type TermEnrichment,
  type EnrichmentState,
} from "./enrichment-tracker.js";

export {
  enrichedSearch,
  analyzeEnrichmentImpact,
  computeSearchQuality,
  type EnrichedSearchResult,
  type EnrichedSearchOptions,
  type EnrichmentImpact,
} from "./enriched-search.js";
