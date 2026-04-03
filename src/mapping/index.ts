/**
 * Mapping module — Term↔Code mapping engine and utilities.
 *
 * This module provides the core logic for matching PM terms
 * to code concepts using heuristic matching strategies.
 */

export {
  MappingEngine,
  type MappingCandidate,
  type MappingConfig,
  type MappingProgress,
  type MappingResult,
  type MappingStats,
  type MatchStrategy,
} from "./mapping-engine.js";

export {
  tokenize,
  tokenizeIdentifier,
  tokenizeFilePath,
  tokenizeSentence,
  computeTokenOverlap,
  computePartialTokenOverlap,
  normalizeForComparison,
} from "./tokenizer.js";

export {
  InvertedIndex,
  type TermTokens,
  type ConceptTokens,
  type ConceptTokenCache,
  type SerializedInvertedIndex,
} from "./inverted-index.js";
