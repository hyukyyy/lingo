/**
 * Term↔Code Mapping Engine
 *
 * Takes extracted PM terms (NormalizedTerm[]) and scanned code concepts
 * (CodeConcept[]), applies multiple heuristic matching strategies, and
 * generates ranked candidate mappings with confidence scores.
 *
 * Matching Strategies (applied in order, scores combined):
 * 1. Exact match: term name/alias matches concept name exactly
 * 2. Token overlap: tokenized term name vs tokenized concept name
 * 3. File path match: term tokens appear in concept's file path
 * 4. Description match: term definition tokens overlap concept description tokens
 *
 * Confidence scores range from 0.0 to 1.0 and are composed from:
 * - Base score from matching strategies
 * - Bonus for concept kind (classes/interfaces weighted higher)
 * - Bonus for exported concepts
 *
 * Usage:
 *   const engine = new MappingEngine();
 *   const result = engine.generateMappings(terms, concepts);
 *   console.log(result.mappings); // Ranked candidate mappings
 */

import type { CodeConcept, CodeConceptKind } from "../types/index.js";
import type { NormalizedTerm } from "../adapters/types.js";
import type { CodeRelationship } from "../models/glossary.js";
import {
  tokenize,
  tokenizeFilePath,
  tokenizeSentence,
  computeTokenOverlap,
  computePartialTokenOverlap,
  normalizeForComparison,
} from "./tokenizer.js";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * The name of a matching strategy that contributed to a candidate's score.
 */
export type MatchStrategy =
  | "exact"             // Exact name match (case-insensitive)
  | "alias-exact"       // Exact alias match (case-insensitive)
  | "token-overlap"     // Token-level overlap between name tokens
  | "file-path"         // Term tokens found in file path
  | "description"       // Definition/description token overlap
  | "alias-token";      // Token overlap with aliases

/**
 * A candidate mapping between a PM term and a code concept.
 * Includes the confidence score and which strategies matched.
 */
export interface MappingCandidate {
  /** The PM term name this mapping is for */
  termName: string;

  /** The code concept ID this term maps to */
  conceptId: string;

  /** Human-readable concept name */
  conceptName: string;

  /** What kind of code element the concept is */
  conceptKind: CodeConceptKind;

  /** File path where the concept lives */
  filePath: string;

  /** Confidence score from 0.0 to 1.0 */
  confidence: number;

  /** Which matching strategies contributed to this score */
  matchStrategies: MatchStrategy[];

  /** Suggested relationship type based on the concept kind */
  suggestedRelationship: CodeRelationship;
}

/**
 * Configuration for the mapping engine.
 */
export interface MappingConfig {
  /** Minimum confidence threshold — candidates below this are filtered out (default: 0.15) */
  minConfidence?: number;

  /** Maximum number of candidates to return per term (default: 5) */
  maxCandidatesPerTerm?: number;

  /** Which strategies to use (default: all) */
  strategies?: MatchStrategy[];
}

/**
 * Statistics about a mapping generation run.
 */
export interface MappingStats {
  /** Number of PM terms processed */
  termsProcessed: number;

  /** Number of code concepts analyzed */
  conceptsAnalyzed: number;

  /** Total candidate mappings generated (before filtering) */
  candidatesGenerated: number;

  /** Candidates that survived the confidence threshold */
  candidatesAfterFilter: number;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Complete result of a mapping generation operation.
 */
export interface MappingResult {
  /** Ranked candidate mappings (highest confidence first) */
  mappings: MappingCandidate[];

  /** Statistics about the mapping run */
  stats: MappingStats;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Default minimum confidence threshold */
const DEFAULT_MIN_CONFIDENCE = 0.10;

/** Default max candidates per term */
const DEFAULT_MAX_CANDIDATES_PER_TERM = 5;

/**
 * Strategy weights — how much each strategy contributes to the final score.
 * Primary strategies (exact, token) carry most weight.
 * Secondary strategies (file-path, description) provide supplementary signal.
 * When all strategies fire at full strength, the raw total can exceed 1.0
 * before the kind-adjustment and clamping step.
 */
const STRATEGY_WEIGHTS: Record<MatchStrategy, number> = {
  "exact":         0.55,
  "alias-exact":   0.50,
  "token-overlap": 0.35,
  "file-path":     0.20,
  "description":   0.20,
  "alias-token":   0.20,
};

/**
 * Bonus multiplier for concept kind — more "defining" kinds score higher.
 * These represent how likely a concept kind is to be the primary definition
 * of a PM term.
 */
const KIND_BONUS: Record<CodeConceptKind, number> = {
  class:      1.00,
  interface:  0.95,
  module:     0.85,
  enum:       0.80,
  namespace:  0.75,
  function:   0.70,
  constant:   0.60,
  directory:  0.50,
};

/**
 * Map concept kind to the suggested code relationship type.
 */
const KIND_TO_RELATIONSHIP: Record<CodeConceptKind, CodeRelationship> = {
  class:      "defines",
  interface:  "defines",
  module:     "defines",
  enum:       "defines",
  namespace:  "defines",
  function:   "implements",
  constant:   "configures",
  directory:  "defines",
};

/** Bonus for exported concepts (more likely to be public API / primary definition) */
const EXPORT_BONUS = 0.05;

// ─── Engine ─────────────────────────────────────────────────────────

/**
 * The main mapping engine that generates term↔code candidate mappings.
 *
 * Stateless — each call to generateMappings() is independent.
 * Thread-safe — no shared mutable state.
 */
export class MappingEngine {
  private readonly minConfidence: number;
  private readonly maxCandidatesPerTerm: number;
  private readonly enabledStrategies: Set<MatchStrategy>;

  constructor(config?: MappingConfig) {
    this.minConfidence = config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.maxCandidatesPerTerm =
      config?.maxCandidatesPerTerm ?? DEFAULT_MAX_CANDIDATES_PER_TERM;
    this.enabledStrategies = new Set(
      config?.strategies ?? (Object.keys(STRATEGY_WEIGHTS) as MatchStrategy[])
    );
  }

  /**
   * Generate candidate mappings between PM terms and code concepts.
   *
   * For each term, scores every concept using the enabled matching strategies,
   * then returns the top candidates above the confidence threshold.
   *
   * @param terms - PM terms extracted from a project management tool
   * @param concepts - Code concepts extracted from codebase scanning
   * @returns Mapping result with ranked candidates and statistics
   */
  generateMappings(
    terms: NormalizedTerm[],
    concepts: CodeConcept[]
  ): MappingResult {
    const startTime = performance.now();

    // Pre-compute tokenized representations for all concepts (avoid re-tokenizing per term)
    const conceptTokenCache = this.buildConceptTokenCache(concepts);

    let totalCandidates = 0;
    const allMappings: MappingCandidate[] = [];

    for (const term of terms) {
      const termTokens = this.tokenizeTerm(term);
      const candidates = this.scoreTerm(term, termTokens, concepts, conceptTokenCache);
      totalCandidates += candidates.length;

      // Filter by confidence threshold
      const filtered = candidates.filter((c) => c.confidence >= this.minConfidence);

      // Sort by confidence (highest first) and take top N
      filtered.sort((a, b) => b.confidence - a.confidence);
      const topN = filtered.slice(0, this.maxCandidatesPerTerm);

      allMappings.push(...topN);
    }

    const durationMs = performance.now() - startTime;

    return {
      mappings: allMappings,
      stats: {
        termsProcessed: terms.length,
        conceptsAnalyzed: concepts.length,
        candidatesGenerated: totalCandidates,
        candidatesAfterFilter: allMappings.length,
        durationMs,
      },
    };
  }

  // ─── Private: Scoring ─────────────────────────────────────────────

  /**
   * Score a single term against all concepts and return candidate mappings.
   */
  private scoreTerm(
    term: NormalizedTerm,
    termTokens: TermTokens,
    concepts: CodeConcept[],
    cache: ConceptTokenCache
  ): MappingCandidate[] {
    const candidates: MappingCandidate[] = [];
    // Track unique concept IDs to deduplicate
    const seenConceptIds = new Set<string>();

    for (const concept of concepts) {
      const conceptTokens = cache.get(concept.id)!;
      const { score, strategies } = this.computeScore(
        term,
        termTokens,
        concept,
        conceptTokens
      );

      if (score <= 0 || strategies.length === 0) continue;

      // Deduplicate: only keep the first (and best) match per concept
      if (seenConceptIds.has(concept.id)) continue;
      seenConceptIds.add(concept.id);

      // Apply kind bonus
      const kindMultiplier = KIND_BONUS[concept.kind] ?? 0.5;
      let adjustedScore = score * (0.7 + 0.3 * kindMultiplier);

      // Apply export bonus
      if (concept.exported) {
        adjustedScore += EXPORT_BONUS;
      }

      // Clamp to [0, 1]
      adjustedScore = Math.min(1.0, Math.max(0.0, adjustedScore));

      candidates.push({
        termName: term.name,
        conceptId: concept.id,
        conceptName: concept.name,
        conceptKind: concept.kind,
        filePath: concept.filePath,
        confidence: Math.round(adjustedScore * 1000) / 1000, // Round to 3 decimal places
        matchStrategies: strategies,
        suggestedRelationship: KIND_TO_RELATIONSHIP[concept.kind] ?? "uses",
      });
    }

    return candidates;
  }

  /**
   * Compute the raw score for a term-concept pair using all enabled strategies.
   */
  private computeScore(
    term: NormalizedTerm,
    termTokens: TermTokens,
    concept: CodeConcept,
    conceptTokens: ConceptTokens
  ): { score: number; strategies: MatchStrategy[] } {
    let score = 0;
    const strategies: MatchStrategy[] = [];

    // Strategy 1: Exact name match
    if (this.enabledStrategies.has("exact")) {
      const exactScore = this.scoreExactMatch(
        termTokens.normalizedName,
        conceptTokens.normalizedName
      );
      if (exactScore > 0) {
        score += exactScore * STRATEGY_WEIGHTS["exact"];
        strategies.push("exact");
      }
    }

    // Strategy 2: Alias exact match
    if (this.enabledStrategies.has("alias-exact")) {
      const aliasScore = this.scoreAliasExactMatch(
        termTokens.normalizedAliases,
        conceptTokens.normalizedName
      );
      if (aliasScore > 0) {
        score += aliasScore * STRATEGY_WEIGHTS["alias-exact"];
        strategies.push("alias-exact");
      }
    }

    // Strategy 3: Token overlap (term name tokens vs concept name tokens)
    // Uses partial/prefix matching to handle cases like "auth" ↔ "authentication"
    if (this.enabledStrategies.has("token-overlap")) {
      const tokenScore = computePartialTokenOverlap(
        termTokens.nameTokens,
        conceptTokens.nameTokens
      );
      if (tokenScore > 0) {
        score += tokenScore * STRATEGY_WEIGHTS["token-overlap"];
        strategies.push("token-overlap");
      }
    }

    // Strategy 4: File path match
    // Uses partial matching — term "billing" should match path token "billing"
    if (this.enabledStrategies.has("file-path")) {
      const pathScore = computePartialTokenOverlap(
        termTokens.nameTokens,
        conceptTokens.pathTokens
      );
      if (pathScore > 0) {
        score += pathScore * STRATEGY_WEIGHTS["file-path"];
        strategies.push("file-path");
      }
    }

    // Strategy 5: Description/definition match
    // Uses partial matching for natural language overlap
    if (this.enabledStrategies.has("description")) {
      const descScore = computePartialTokenOverlap(
        termTokens.definitionTokens,
        conceptTokens.descriptionTokens
      );
      if (descScore > 0) {
        score += descScore * STRATEGY_WEIGHTS["description"];
        strategies.push("description");
      }
    }

    // Strategy 6: Alias token overlap
    if (this.enabledStrategies.has("alias-token")) {
      let bestAliasTokenScore = 0;
      for (const aliasTokens of termTokens.aliasTokenSets) {
        const aliasScore = computePartialTokenOverlap(
          aliasTokens,
          conceptTokens.nameTokens
        );
        if (aliasScore > bestAliasTokenScore) {
          bestAliasTokenScore = aliasScore;
        }
      }
      if (bestAliasTokenScore > 0) {
        score += bestAliasTokenScore * STRATEGY_WEIGHTS["alias-token"];
        strategies.push("alias-token");
      }
    }

    return { score, strategies };
  }

  /**
   * Score exact name match. Returns 1.0 for exact match, 0.0 otherwise.
   * Comparison is done on normalized forms (lowered, separators converted to spaces).
   * Also checks compact form (all separators removed) to catch camelCase vs space-separated.
   */
  private scoreExactMatch(
    normalizedTermName: string,
    normalizedConceptName: string
  ): number {
    if (!normalizedTermName || !normalizedConceptName) return 0;

    // Exact match (after normalization — spaces, underscores, dashes all become spaces)
    if (normalizedTermName === normalizedConceptName) return 1.0;

    // Compact form: remove all spaces to compare "auth service" vs "authservice"
    const termCompact = normalizedTermName.replace(/\s/g, "");
    const conceptCompact = normalizedConceptName.replace(/\s/g, "");
    if (termCompact === conceptCompact) return 0.95;

    // Check if one contains the other (substring) for shorter terms
    if (termCompact.length >= 3 && conceptCompact.length >= 3) {
      if (conceptCompact.includes(termCompact)) {
        return 0.6 * (termCompact.length / conceptCompact.length);
      }
      if (termCompact.includes(conceptCompact)) {
        return 0.6 * (conceptCompact.length / termCompact.length);
      }
    }

    return 0;
  }

  /**
   * Score alias exact matches. Returns the best alias match score.
   */
  private scoreAliasExactMatch(
    normalizedAliases: string[],
    normalizedConceptName: string
  ): number {
    if (!normalizedConceptName) return 0;

    let bestScore = 0;

    for (const alias of normalizedAliases) {
      if (alias === normalizedConceptName) {
        bestScore = Math.max(bestScore, 1.0);
      } else {
        const aliasCompact = alias.replace(/\s/g, "");
        const conceptCompact = normalizedConceptName.replace(/\s/g, "");
        if (aliasCompact === conceptCompact) {
          bestScore = Math.max(bestScore, 0.9);
        }
      }
    }

    return bestScore;
  }

  // ─── Private: Token Caching ───────────────────────────────────────

  /**
   * Pre-tokenize a term into all the token forms needed by strategies.
   */
  private tokenizeTerm(term: NormalizedTerm): TermTokens {
    return {
      normalizedName: normalizeForComparison(term.name),
      normalizedAliases: term.aliases.map(normalizeForComparison),
      nameTokens: tokenize(term.name),
      definitionTokens: tokenizeSentence(term.definition),
      aliasTokenSets: term.aliases.map((a) => tokenize(a)),
    };
  }

  /**
   * Build a lookup of pre-tokenized concept representations.
   */
  private buildConceptTokenCache(
    concepts: CodeConcept[]
  ): ConceptTokenCache {
    const cache = new Map<string, ConceptTokens>();

    for (const concept of concepts) {
      cache.set(concept.id, {
        normalizedName: normalizeForComparison(concept.name),
        nameTokens: tokenize(concept.name),
        pathTokens: tokenizeFilePath(concept.filePath),
        descriptionTokens: tokenizeSentence(concept.description),
      });
    }

    return cache;
  }
}

// ─── Internal Types ─────────────────────────────────────────────────

/** Pre-tokenized representation of a PM term */
interface TermTokens {
  normalizedName: string;
  normalizedAliases: string[];
  nameTokens: string[];
  definitionTokens: string[];
  aliasTokenSets: string[][];
}

/** Pre-tokenized representation of a code concept */
interface ConceptTokens {
  normalizedName: string;
  nameTokens: string[];
  pathTokens: string[];
  descriptionTokens: string[];
}

/** Lookup from concept ID → pre-tokenized data */
type ConceptTokenCache = Map<string, ConceptTokens>;
