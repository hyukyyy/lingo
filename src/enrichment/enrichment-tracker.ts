/**
 * Enrichment Tracker — Accumulates usage signals for progressive enrichment.
 *
 * As users interact with the Lingo glossary (querying terms, accessing
 * individual terms, adding code locations, verifying mappings), the tracker
 * records these signals and computes enrichment scores that improve future
 * query relevance.
 *
 * This is the core of Lingo's "organizational context layer" accumulation:
 * the more the system is used, the better it understands an organization's
 * language and workflows.
 *
 * Signal types:
 * - query:                User searched for a term → records query pattern
 * - access:               User accessed a specific term → records access frequency
 * - code-location-added:  Code location added to a term → enriches precision
 * - alias-added:          Alias added to a term → enriches query coverage
 * - term-verified:        AI-suggested term verified by human → boosts confidence
 *
 * Usage:
 *   const tracker = new EnrichmentTracker();
 *   tracker.recordQuery("auth", ["term-id-1"]);
 *   tracker.recordAccess("term-id-1");
 *   const score = tracker.getEnrichmentScore("term-id-1");
 *   const suggestions = tracker.suggestAliases("term-id-1");
 */

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Types of usage signals that the enrichment tracker records.
 */
export type SignalType =
  | "query"
  | "access"
  | "code-location-added"
  | "alias-added"
  | "term-verified";

/**
 * A single usage signal recorded by the tracker.
 */
export interface UsageSignal {
  /** What kind of interaction occurred */
  type: SignalType;

  /** When the signal was recorded (ISO 8601) */
  timestamp: string;

  /** Term ID(s) involved in this interaction */
  termIds: string[];

  /** The search query text (for "query" signals) */
  query?: string;

  /** Additional metadata about the signal */
  metadata?: Record<string, unknown>;
}

/**
 * Accumulated enrichment data for a single term.
 */
export interface TermEnrichment {
  /** The term this enrichment data is for */
  termId: string;

  /** How many times this term has been directly accessed */
  accessCount: number;

  /** How many times this term appeared in query results */
  queryHitCount: number;

  /** Unique query patterns that led to this term being found */
  queryPatterns: string[];

  /** Number of code locations that have been added over time */
  codeLocationAdditions: number;

  /** Number of aliases that have been added over time */
  aliasAdditions: number;

  /** Whether this term has been human-verified */
  verified: boolean;

  /** When this term was last accessed (ISO 8601) */
  lastAccessed?: string;

  /** Computed enrichment score (0.0 to 1.0) — higher means more enriched */
  score: number;
}

/**
 * The complete enrichment state, serializable for persistence.
 */
export interface EnrichmentState {
  /** All recorded usage signals */
  signals: UsageSignal[];

  /** Per-term enrichment data */
  termEnrichments: Record<string, TermEnrichment>;

  /** Query → term ID associations (which terms matched which queries) */
  queryTermMap: Record<string, string[]>;
}

// ─── Constants ──────────────────────────────────────────────────────

/** How much each access contributes to the enrichment score */
const ACCESS_WEIGHT = 0.05;

/** How much each unique query pattern contributes */
const QUERY_PATTERN_WEIGHT = 0.08;

/** How much each code location addition contributes */
const CODE_LOCATION_WEIGHT = 0.15;

/** How much each alias addition contributes */
const ALIAS_WEIGHT = 0.10;

/** Bonus for human verification */
const VERIFICATION_BONUS = 0.20;

/** Maximum enrichment score */
const MAX_SCORE = 1.0;

/** Maximum number of query patterns to track per term */
const MAX_QUERY_PATTERNS_PER_TERM = 50;

/** Maximum number of signals to keep in memory */
const MAX_SIGNALS = 1000;

// ─── Tracker ────────────────────────────────────────────────────────

/**
 * Tracks usage signals and computes enrichment scores for terms.
 *
 * The tracker is designed to be lightweight and in-memory, suitable
 * for the single-process MCP server model. State can be exported
 * and imported for persistence across server restarts.
 */
export class EnrichmentTracker {
  private state: EnrichmentState;

  constructor(initialState?: Partial<EnrichmentState>) {
    this.state = {
      signals: initialState?.signals ?? [],
      termEnrichments: initialState?.termEnrichments ?? {},
      queryTermMap: initialState?.queryTermMap ?? {},
    };
  }

  // ─── Signal Recording ─────────────────────────────────────────────

  /**
   * Records a query signal — the user searched and these terms matched.
   *
   * This is the primary enrichment mechanism: as users query the glossary,
   * the tracker learns which query patterns lead to which terms.
   *
   * @param query - The search query text
   * @param matchedTermIds - IDs of terms that were returned as results
   */
  recordQuery(query: string, matchedTermIds: string[]): void {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery || matchedTermIds.length === 0) return;

    const signal: UsageSignal = {
      type: "query",
      timestamp: new Date().toISOString(),
      termIds: matchedTermIds,
      query: normalizedQuery,
    };
    this.addSignal(signal);

    // Update query → term map
    if (!this.state.queryTermMap[normalizedQuery]) {
      this.state.queryTermMap[normalizedQuery] = [];
    }
    for (const termId of matchedTermIds) {
      if (!this.state.queryTermMap[normalizedQuery].includes(termId)) {
        this.state.queryTermMap[normalizedQuery].push(termId);
      }
    }

    // Update per-term enrichment
    for (const termId of matchedTermIds) {
      const enrichment = this.getOrCreateEnrichment(termId);
      enrichment.queryHitCount++;
      if (
        !enrichment.queryPatterns.includes(normalizedQuery) &&
        enrichment.queryPatterns.length < MAX_QUERY_PATTERNS_PER_TERM
      ) {
        enrichment.queryPatterns.push(normalizedQuery);
      }
      this.recomputeScore(enrichment);
    }
  }

  /**
   * Records a direct term access — the user retrieved a specific term.
   *
   * Frequent access indicates high relevance and should boost the term
   * in future search rankings.
   *
   * @param termId - The ID of the term that was accessed
   */
  recordAccess(termId: string): void {
    const signal: UsageSignal = {
      type: "access",
      timestamp: new Date().toISOString(),
      termIds: [termId],
    };
    this.addSignal(signal);

    const enrichment = this.getOrCreateEnrichment(termId);
    enrichment.accessCount++;
    enrichment.lastAccessed = signal.timestamp;
    this.recomputeScore(enrichment);
  }

  /**
   * Records that a code location was added to a term.
   *
   * Each code location addition makes the term more useful — it can now
   * be found via file-path queries and provides more precise code mappings.
   *
   * @param termId - The term that gained a new code location
   */
  recordCodeLocationAdded(termId: string): void {
    const signal: UsageSignal = {
      type: "code-location-added",
      timestamp: new Date().toISOString(),
      termIds: [termId],
    };
    this.addSignal(signal);

    const enrichment = this.getOrCreateEnrichment(termId);
    enrichment.codeLocationAdditions++;
    this.recomputeScore(enrichment);
  }

  /**
   * Records that an alias was added to a term.
   *
   * Each alias addition broadens the term's query surface area —
   * more queries will now match this term.
   *
   * @param termId - The term that gained a new alias
   */
  recordAliasAdded(termId: string): void {
    const signal: UsageSignal = {
      type: "alias-added",
      timestamp: new Date().toISOString(),
      termIds: [termId],
    };
    this.addSignal(signal);

    const enrichment = this.getOrCreateEnrichment(termId);
    enrichment.aliasAdditions++;
    this.recomputeScore(enrichment);
  }

  /**
   * Records that a term was verified by a human.
   *
   * Verification is a strong signal of quality — the term is not just
   * AI-suggested but has been confirmed as accurate.
   *
   * @param termId - The term that was verified
   */
  recordTermVerified(termId: string): void {
    const signal: UsageSignal = {
      type: "term-verified",
      timestamp: new Date().toISOString(),
      termIds: [termId],
    };
    this.addSignal(signal);

    const enrichment = this.getOrCreateEnrichment(termId);
    enrichment.verified = true;
    this.recomputeScore(enrichment);
  }

  // ─── Querying Enrichment Data ─────────────────────────────────────

  /**
   * Returns the enrichment score for a term (0.0 to 1.0).
   *
   * The score represents how "enriched" a term is through usage:
   * - 0.0 = no usage data, term exists but has never been interacted with
   * - 0.5 = moderate usage, some queries and accesses
   * - 1.0 = heavily used, verified, well-mapped term
   *
   * @param termId - The term to get the score for
   * @returns Enrichment score between 0.0 and 1.0
   */
  getEnrichmentScore(termId: string): number {
    return this.state.termEnrichments[termId]?.score ?? 0;
  }

  /**
   * Returns the full enrichment data for a term.
   *
   * @param termId - The term to get enrichment data for
   * @returns TermEnrichment or undefined if no data exists
   */
  getTermEnrichment(termId: string): TermEnrichment | undefined {
    return this.state.termEnrichments[termId];
  }

  /**
   * Suggests aliases for a term based on query patterns.
   *
   * When users search for a term using different phrases than its current
   * name/aliases, those query patterns become alias suggestions. This is
   * the "learning from usage" aspect of progressive enrichment.
   *
   * @param termId - The term to suggest aliases for
   * @param currentAliases - The term's current aliases (to avoid suggesting duplicates)
   * @returns Array of suggested alias strings
   */
  suggestAliases(termId: string, currentAliases: string[] = []): string[] {
    const enrichment = this.state.termEnrichments[termId];
    if (!enrichment) return [];

    const normalizedExisting = new Set(
      currentAliases.map((a) => a.toLowerCase().trim())
    );

    // Query patterns that aren't already aliases are alias candidates
    return enrichment.queryPatterns.filter(
      (pattern) => !normalizedExisting.has(pattern)
    );
  }

  /**
   * Returns a relevance boost for a specific query-term pair.
   *
   * If a query has previously been associated with a term (the user
   * searched this exact query before and this term was a result),
   * the term gets a relevance boost for that query.
   *
   * @param query - The search query
   * @param termId - The term to check relevance for
   * @returns A boost value between 0.0 and 0.3
   */
  getQueryRelevanceBoost(query: string, termId: string): number {
    const normalizedQuery = query.toLowerCase().trim();
    const associatedTerms = this.state.queryTermMap[normalizedQuery];

    if (!associatedTerms || !associatedTerms.includes(termId)) {
      return 0;
    }

    // Base boost for having been previously associated
    let boost = 0.10;

    // Additional boost based on how many times this query-term pair appeared
    const enrichment = this.state.termEnrichments[termId];
    if (enrichment) {
      // More accesses = more relevant
      const accessBoost = Math.min(enrichment.accessCount * 0.02, 0.10);
      // More query hits = more relevant
      const queryBoost = Math.min(enrichment.queryHitCount * 0.01, 0.10);
      boost += accessBoost + queryBoost;
    }

    return Math.min(boost, 0.30);
  }

  /**
   * Returns terms related to a given term based on co-occurrence in queries.
   *
   * If two terms frequently appear in results for the same queries,
   * they are likely related concepts. This enables cross-referencing.
   *
   * @param termId - The term to find related terms for
   * @returns Array of related term IDs, sorted by co-occurrence strength
   */
  getRelatedTerms(termId: string): string[] {
    const enrichment = this.state.termEnrichments[termId];
    if (!enrichment) return [];

    // Find all queries that matched this term
    const relatedQueries = enrichment.queryPatterns;

    // Count co-occurrences with other terms
    const cooccurrences = new Map<string, number>();

    for (const query of relatedQueries) {
      const associatedTerms = this.state.queryTermMap[query] ?? [];
      for (const otherId of associatedTerms) {
        if (otherId !== termId) {
          cooccurrences.set(otherId, (cooccurrences.get(otherId) ?? 0) + 1);
        }
      }
    }

    // Sort by co-occurrence count (highest first)
    return Array.from(cooccurrences.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  // ─── State Management ─────────────────────────────────────────────

  /**
   * Exports the current enrichment state for persistence.
   */
  exportState(): EnrichmentState {
    return structuredClone(this.state);
  }

  /**
   * Returns summary statistics about the enrichment state.
   */
  getStats(): {
    totalSignals: number;
    enrichedTermCount: number;
    uniqueQueries: number;
    averageScore: number;
  } {
    const enrichments = Object.values(this.state.termEnrichments);
    const totalScore = enrichments.reduce((sum, e) => sum + e.score, 0);

    return {
      totalSignals: this.state.signals.length,
      enrichedTermCount: enrichments.length,
      uniqueQueries: Object.keys(this.state.queryTermMap).length,
      averageScore:
        enrichments.length > 0 ? totalScore / enrichments.length : 0,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Add a signal to the log, trimming old signals if needed.
   */
  private addSignal(signal: UsageSignal): void {
    this.state.signals.push(signal);

    // Trim old signals to prevent unbounded growth
    if (this.state.signals.length > MAX_SIGNALS) {
      this.state.signals = this.state.signals.slice(-MAX_SIGNALS);
    }
  }

  /**
   * Get or create a TermEnrichment entry.
   */
  private getOrCreateEnrichment(termId: string): TermEnrichment {
    if (!this.state.termEnrichments[termId]) {
      this.state.termEnrichments[termId] = {
        termId,
        accessCount: 0,
        queryHitCount: 0,
        queryPatterns: [],
        codeLocationAdditions: 0,
        aliasAdditions: 0,
        verified: false,
        score: 0,
      };
    }
    return this.state.termEnrichments[termId];
  }

  /**
   * Recompute the enrichment score for a term based on accumulated signals.
   *
   * The score formula rewards:
   * - Frequent access (the term is being used)
   * - Diverse query patterns (the term is findable via many queries)
   * - Code location richness (the term has precise code mappings)
   * - Alias richness (the term has many ways to be found)
   * - Human verification (the term is confirmed accurate)
   */
  private recomputeScore(enrichment: TermEnrichment): void {
    let score = 0;

    // Access contribution (diminishing returns via log)
    score += Math.min(
      Math.log2(1 + enrichment.accessCount) * ACCESS_WEIGHT,
      0.20
    );

    // Query pattern diversity
    score += Math.min(
      enrichment.queryPatterns.length * QUERY_PATTERN_WEIGHT,
      0.25
    );

    // Code location richness
    score += Math.min(
      enrichment.codeLocationAdditions * CODE_LOCATION_WEIGHT,
      0.25
    );

    // Alias richness
    score += Math.min(
      enrichment.aliasAdditions * ALIAS_WEIGHT,
      0.15
    );

    // Verification bonus
    if (enrichment.verified) {
      score += VERIFICATION_BONUS;
    }

    enrichment.score = Math.min(score, MAX_SCORE);
  }
}
