/**
 * Enriched Search — Combines base glossary search with enrichment signals.
 *
 * This module wraps the basic `JsonGlossaryStorage.searchTerms()` with
 * enrichment-aware re-ranking. The result is that heavily-used, well-mapped,
 * and human-verified terms rank higher than newly-added, unused terms.
 *
 * This is where progressive enrichment becomes visible to AI tools:
 * identical queries return progressively better results as the organization
 * uses Lingo more.
 *
 * Re-ranking formula:
 *   adjustedScore = baseRelevance + enrichmentBoost + queryAffinityBoost
 *
 * Where:
 *   - baseRelevance:      the original search ranking (position-based)
 *   - enrichmentBoost:    from EnrichmentTracker.getEnrichmentScore()
 *   - queryAffinityBoost: from EnrichmentTracker.getQueryRelevanceBoost()
 */

import type { GlossaryTerm } from "../models/glossary.js";
import type { JsonGlossaryStorage } from "../storage/json-store.js";
import type { EnrichmentTracker } from "./enrichment-tracker.js";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A search result with enrichment metadata attached.
 */
export interface EnrichedSearchResult {
  /** The glossary term */
  term: GlossaryTerm;

  /** Base relevance score from the storage search (normalized 0-1) */
  baseRelevance: number;

  /** Enrichment score from usage signals (0-1) */
  enrichmentScore: number;

  /** Query-specific affinity boost (0-0.3) */
  queryAffinityBoost: number;

  /** Combined score used for final ranking */
  combinedScore: number;

  /** Whether this result was boosted by enrichment */
  enrichmentApplied: boolean;
}

/**
 * Options for enriched search.
 */
export interface EnrichedSearchOptions {
  /** Maximum number of results to return (default: 10) */
  limit?: number;

  /** Category filter */
  category?: string;

  /** Weight given to enrichment signals vs base relevance (0-1, default: 0.3) */
  enrichmentWeight?: number;
}

/**
 * Summary of how enrichment affected the search results.
 */
export interface EnrichmentImpact {
  /** How many results were re-ordered due to enrichment */
  reorderedCount: number;

  /** How many results had enrichment data */
  enrichedCount: number;

  /** Average enrichment score across results */
  averageEnrichmentScore: number;

  /** Whether enrichment made a material difference in ordering */
  materialImpact: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Default weight for enrichment signals in the combined score */
const DEFAULT_ENRICHMENT_WEIGHT = 0.3;

/** Default result limit */
const DEFAULT_LIMIT = 10;

// ─── Enriched Search Function ───────────────────────────────────────

/**
 * Performs an enriched search combining base relevance with usage signals.
 *
 * The base search results from `storage.searchTerms()` are re-ranked
 * using enrichment data from the tracker. This means that terms which
 * have been frequently accessed, well-mapped with code locations, and
 * verified by humans will rank higher than freshly-added terms.
 *
 * @param query - The search query
 * @param storage - The glossary storage backend
 * @param tracker - The enrichment tracker with accumulated signals
 * @param options - Search configuration options
 * @returns Array of enriched search results, sorted by combined score
 */
export function enrichedSearch(
  query: string,
  storage: JsonGlossaryStorage,
  tracker: EnrichmentTracker,
  options?: EnrichedSearchOptions
): EnrichedSearchResult[] {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const enrichmentWeight = options?.enrichmentWeight ?? DEFAULT_ENRICHMENT_WEIGHT;
  const baseWeight = 1 - enrichmentWeight;

  // Step 1: Get base search results
  let baseResults = storage.searchTerms(query);

  // Apply category filter if provided
  if (options?.category) {
    baseResults = baseResults.filter(
      (term) => term.category === options.category
    );
  }

  if (baseResults.length === 0) {
    return [];
  }

  // Step 2: Assign base relevance scores (position-based, normalized 0-1)
  const maxBaseScore = baseResults.length;

  // Step 3: Compute enriched scores and re-rank
  const enrichedResults: EnrichedSearchResult[] = baseResults.map(
    (term, index) => {
      // Base relevance: higher rank = higher score
      const baseRelevance = (maxBaseScore - index) / maxBaseScore;

      // Enrichment score from tracker
      const enrichmentScore = tracker.getEnrichmentScore(term.id);

      // Query-specific affinity boost
      const queryAffinityBoost = tracker.getQueryRelevanceBoost(query, term.id);

      // Combined score: weighted blend of base relevance and enrichment
      const combinedScore =
        baseWeight * baseRelevance +
        enrichmentWeight * enrichmentScore +
        queryAffinityBoost;

      return {
        term,
        baseRelevance,
        enrichmentScore,
        queryAffinityBoost,
        combinedScore,
        enrichmentApplied: enrichmentScore > 0 || queryAffinityBoost > 0,
      };
    }
  );

  // Step 4: Sort by combined score (highest first)
  enrichedResults.sort((a, b) => b.combinedScore - a.combinedScore);

  // Step 5: Record the query in the tracker for future enrichment
  const matchedTermIds = enrichedResults.map((r) => r.term.id);
  tracker.recordQuery(query, matchedTermIds);

  // Step 6: Apply limit
  return enrichedResults.slice(0, limit);
}

/**
 * Analyzes the impact of enrichment on search results.
 *
 * Compares the base ranking (without enrichment) to the enriched ranking
 * to determine how much enrichment improved the results. Useful for
 * demonstrating the progressive improvement of Lingo over time.
 *
 * @param results - Enriched search results
 * @returns Impact analysis
 */
export function analyzeEnrichmentImpact(
  results: EnrichedSearchResult[]
): EnrichmentImpact {
  if (results.length === 0) {
    return {
      reorderedCount: 0,
      enrichedCount: 0,
      averageEnrichmentScore: 0,
      materialImpact: false,
    };
  }

  // Count results with enrichment data
  const enrichedCount = results.filter((r) => r.enrichmentApplied).length;

  // Compute average enrichment score
  const totalEnrichmentScore = results.reduce(
    (sum, r) => sum + r.enrichmentScore,
    0
  );
  const averageEnrichmentScore = totalEnrichmentScore / results.length;

  // Check if enrichment changed the ordering
  // Build the base-only ordering (by base relevance)
  const baseOrder = [...results]
    .sort((a, b) => b.baseRelevance - a.baseRelevance)
    .map((r) => r.term.id);

  const enrichedOrder = results.map((r) => r.term.id);

  let reorderedCount = 0;
  for (let i = 0; i < Math.min(baseOrder.length, enrichedOrder.length); i++) {
    if (baseOrder[i] !== enrichedOrder[i]) {
      reorderedCount++;
    }
  }

  return {
    reorderedCount,
    enrichedCount,
    averageEnrichmentScore,
    materialImpact: reorderedCount > 0,
  };
}

/**
 * Computes a "search quality" metric for a set of enriched search results.
 *
 * Quality is measured as a combination of:
 * - Existence: having any results at all is a baseline improvement over zero
 * - Completeness: how many results have code locations (useful results)
 * - Enrichment depth: how enriched the returned terms are
 * - Confidence: how many results are verified or manual vs ai-suggested
 *
 * Returns a score from 0.0 (poor quality / no results) to 1.0 (high quality).
 * This metric is used in tests to demonstrate progressive quality improvement.
 *
 * @param results - Enriched search results to evaluate
 * @returns Quality score between 0.0 and 1.0
 */
export function computeSearchQuality(
  results: EnrichedSearchResult[]
): number {
  if (results.length === 0) return 0;

  // Existence baseline: having results at all provides a minimum quality
  // This ensures that going from 0 results to N results always improves quality
  const existenceBaseline = 0.10;

  // Completeness: proportion of results with at least one code location
  const withCodeLocations = results.filter(
    (r) => r.term.codeLocations.length > 0
  ).length;
  const completeness = withCodeLocations / results.length;

  // Enrichment depth: average enrichment score
  const avgEnrichment =
    results.reduce((sum, r) => sum + r.enrichmentScore, 0) / results.length;

  // Confidence: proportion of results that are verified or manual
  const highConfidence = results.filter(
    (r) => r.term.confidence === "manual" || r.term.confidence === "ai-verified"
  ).length;
  const confidenceRatio = highConfidence / results.length;

  // Weighted combination: existence baseline + progressive factors
  return Math.min(
    1.0,
    existenceBaseline +
      0.35 * completeness +
      0.25 * avgEnrichment +
      0.25 * confidenceRatio
  );
}
