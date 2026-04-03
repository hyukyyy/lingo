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

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
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
import { InvertedIndex } from "./inverted-index.js";
import type { TermTokens, ConceptTokens, ConceptTokenCache } from "./inverted-index.js";
import {
  computeScore as computeScorePure,
  scoreExactMatch as scoreExactMatchPure,
  scoreAliasExactMatch as scoreAliasExactMatchPure,
  STRATEGY_WEIGHTS as STRATEGY_WEIGHTS_IMPORTED,
  KIND_BONUS as KIND_BONUS_IMPORTED,
  KIND_TO_RELATIONSHIP as KIND_TO_RELATIONSHIP_IMPORTED,
  EXPORT_BONUS as EXPORT_BONUS_IMPORTED,
} from "./scoring.js";

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
 * Progress update emitted during mapping.
 */
export interface MappingProgress {
  /** Number of terms processed so far */
  termsProcessed: number;
  /** Total number of terms to process */
  totalTerms: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
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

  /** Optional progress callback, invoked periodically during mapping */
  onProgress?: (progress: MappingProgress) => void;
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

// ─── Constants (imported from scoring.ts) ───────────────────────────

/** Default minimum confidence threshold */
const DEFAULT_MIN_CONFIDENCE = 0.10;

/** Default max candidates per term */
const DEFAULT_MAX_CANDIDATES_PER_TERM = 5;

// Re-alias imported constants for backward compatibility within this file
const STRATEGY_WEIGHTS = STRATEGY_WEIGHTS_IMPORTED;
const KIND_BONUS = KIND_BONUS_IMPORTED;
const KIND_TO_RELATIONSHIP = KIND_TO_RELATIONSHIP_IMPORTED;
const EXPORT_BONUS = EXPORT_BONUS_IMPORTED;

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
  private readonly onProgress?: (progress: MappingProgress) => void;

  constructor(config?: MappingConfig) {
    this.minConfidence = config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.maxCandidatesPerTerm =
      config?.maxCandidatesPerTerm ?? DEFAULT_MAX_CANDIDATES_PER_TERM;
    this.enabledStrategies = new Set(
      config?.strategies ?? (Object.keys(STRATEGY_WEIGHTS) as MatchStrategy[])
    );
    this.onProgress = config?.onProgress;
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

    // Build inverted index for candidate pre-filtering
    const invertedIndex = new InvertedIndex();
    invertedIndex.build(
      concepts.map((c) => c.id),
      conceptTokenCache,
    );

    // Build a concept lookup map for fast ID → concept resolution
    const conceptMap = new Map(concepts.map((c) => [c.id, c]));

    let totalCandidates = 0;
    const allMappings: MappingCandidate[] = [];

    // Progress reporting: emit every 100 terms or 5% of total, whichever is smaller
    const progressInterval = Math.max(1, Math.min(100, Math.floor(terms.length * 0.05)));

    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const termTokens = this.tokenizeTerm(term);

      // Use inverted index to pre-filter candidate concepts
      const candidateIds = invertedIndex.getCandidates(termTokens);
      let candidateConcepts: CodeConcept[];
      if (candidateIds.size > 0) {
        candidateConcepts = [];
        for (const id of candidateIds) {
          const concept = conceptMap.get(id);
          if (concept) candidateConcepts.push(concept);
        }
      } else {
        // Fallback: no tokens → scan all concepts
        candidateConcepts = concepts;
      }

      const candidates = this.scoreTerm(term, termTokens, candidateConcepts, conceptTokenCache);
      totalCandidates += candidates.length;

      // Filter by confidence threshold
      const filtered = candidates.filter((c) => c.confidence >= this.minConfidence);

      // Sort by confidence (highest first) and take top N
      filtered.sort((a, b) => b.confidence - a.confidence);
      const topN = filtered.slice(0, this.maxCandidatesPerTerm);

      allMappings.push(...topN);

      // Emit progress
      if (this.onProgress && (i + 1) % progressInterval === 0) {
        this.onProgress({
          termsProcessed: i + 1,
          totalTerms: terms.length,
          elapsedMs: performance.now() - startTime,
        });
      }
    }

    // Final progress notification
    if (this.onProgress) {
      this.onProgress({
        termsProcessed: terms.length,
        totalTerms: terms.length,
        elapsedMs: performance.now() - startTime,
      });
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
   * Delegates to the pure scoring functions in scoring.ts.
   */
  private computeScore(
    _term: NormalizedTerm,
    termTokens: TermTokens,
    _concept: CodeConcept,
    conceptTokens: ConceptTokens
  ): { score: number; strategies: MatchStrategy[] } {
    return computeScorePure(termTokens, conceptTokens, this.enabledStrategies);
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

  // ─── Async Parallel Mapping ─────────────────────────────────────

  /**
   * Async version of generateMappings that uses worker threads for
   * parallel term scoring. Falls back to single-threaded execution
   * if workers fail or for small inputs.
   */
  async generateMappingsAsync(
    terms: NormalizedTerm[],
    concepts: CodeConcept[],
  ): Promise<MappingResult> {
    // For small inputs, skip worker overhead
    if (terms.length < 500 || concepts.length < 1000) {
      return this.generateMappings(terms, concepts);
    }

    const startTime = performance.now();

    try {
      return await this.runWithWorkers(terms, concepts, startTime);
    } catch (err) {
      // Graceful fallback to single-threaded
      process.stderr.write(
        `[lingo:mapping] Worker threads failed (${(err as Error).message}), falling back to single-threaded\n`,
      );
      return this.generateMappings(terms, concepts);
    }
  }

  private async runWithWorkers(
    terms: NormalizedTerm[],
    concepts: CodeConcept[],
    startTime: number,
  ): Promise<MappingResult> {
    // Build shared data structures
    const conceptTokenCache = this.buildConceptTokenCache(concepts);
    const invertedIndex = new InvertedIndex();
    invertedIndex.build(
      concepts.map((c) => c.id),
      conceptTokenCache,
    );

    // Serialize for worker transfer
    const serializedConcepts = concepts.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      filePath: c.filePath,
      exported: c.exported,
    }));

    const serializedCache: [string, ConceptTokens][] = [];
    for (const [id, tokens] of conceptTokenCache) {
      serializedCache.push([id, tokens]);
    }

    const serializedIndex = invertedIndex.serialize();

    const config = {
      minConfidence: this.minConfidence,
      maxCandidatesPerTerm: this.maxCandidatesPerTerm,
      enabledStrategies: Array.from(this.enabledStrategies),
    };

    // Split terms into chunks for workers
    const workerCount = Math.min(
      Math.max(1, availableParallelism() - 1),
      8,
      Math.ceil(terms.length / 100), // At least 100 terms per worker
    );

    const chunkSize = Math.ceil(terms.length / workerCount);
    const chunks: NormalizedTerm[][] = [];
    for (let i = 0; i < terms.length; i += chunkSize) {
      chunks.push(terms.slice(i, i + chunkSize));
    }

    // Resolve worker script path (ESM-compatible)
    const workerUrl = new URL("./mapping-worker.js", import.meta.url);

    // Track aggregated progress
    let totalTermsProcessed = 0;
    const workerTermsProcessed = new Array(chunks.length).fill(0);

    // Spawn workers
    const workerPromises = chunks.map((chunk, workerIndex) => {
      return new Promise<{ mappings: MappingCandidate[]; totalCandidates: number }>(
        (resolve, reject) => {
          const worker = new Worker(workerUrl, {
            workerData: {
              terms: chunk,
              concepts: serializedConcepts,
              conceptTokenCache: serializedCache,
              invertedIndex: serializedIndex,
              config,
            },
          });

          // Per-worker timeout (5 minutes)
          const timeout = setTimeout(() => {
            worker.terminate();
            reject(new Error(`Worker ${workerIndex} timed out after 5 minutes`));
          }, 5 * 60 * 1000);

          worker.on("message", (msg: { type: string; termsProcessed?: number; mappings?: MappingCandidate[]; totalCandidates?: number }) => {
            if (msg.type === "progress" && msg.termsProcessed !== undefined) {
              workerTermsProcessed[workerIndex] = msg.termsProcessed;
              const newTotal = workerTermsProcessed.reduce((a, b) => a + b, 0);
              if (this.onProgress && newTotal > totalTermsProcessed) {
                totalTermsProcessed = newTotal;
                this.onProgress({
                  termsProcessed: totalTermsProcessed,
                  totalTerms: terms.length,
                  elapsedMs: performance.now() - startTime,
                });
              }
            } else if (msg.type === "result") {
              clearTimeout(timeout);
              resolve({
                mappings: msg.mappings ?? [],
                totalCandidates: msg.totalCandidates ?? 0,
              });
            }
          });

          worker.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });

          worker.on("exit", (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
              reject(new Error(`Worker ${workerIndex} exited with code ${code}`));
            }
          });
        },
      );
    });

    // Wait for all workers
    const results = await Promise.all(workerPromises);

    // Merge results
    const allMappings: MappingCandidate[] = [];
    let totalCandidates = 0;

    for (const result of results) {
      allMappings.push(...result.mappings);
      totalCandidates += result.totalCandidates;
    }

    const durationMs = performance.now() - startTime;

    // Final progress
    if (this.onProgress) {
      this.onProgress({
        termsProcessed: terms.length,
        totalTerms: terms.length,
        elapsedMs: durationMs,
      });
    }

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
}

// Types TermTokens, ConceptTokens, ConceptTokenCache are imported from inverted-index.ts
