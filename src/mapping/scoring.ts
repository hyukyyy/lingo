/**
 * Pure Scoring Functions for Mapping Engine
 *
 * Extracted from mapping-engine.ts so they can be used both by the main
 * thread MappingEngine and by worker threads for parallel processing.
 *
 * All functions in this module are pure (no side effects, no shared state)
 * and safe to call from any thread.
 */

import type { CodeConceptKind } from "../types/index.js";
import type { NormalizedTerm } from "../adapters/types.js";
import type { CodeRelationship } from "../models/glossary.js";
import { computePartialTokenOverlap } from "./tokenizer.js";
import type { TermTokens, ConceptTokens } from "./inverted-index.js";

// Re-export the MatchStrategy type for workers
export type MatchStrategy =
  | "exact"
  | "alias-exact"
  | "token-overlap"
  | "file-path"
  | "description"
  | "alias-token";

// ─── Constants ──────────────────────────────────────────────────────

export const STRATEGY_WEIGHTS: Record<MatchStrategy, number> = {
  "exact":         0.55,
  "alias-exact":   0.50,
  "token-overlap": 0.35,
  "file-path":     0.20,
  "description":   0.20,
  "alias-token":   0.20,
};

export const KIND_BONUS: Record<CodeConceptKind, number> = {
  class:      1.00,
  interface:  0.95,
  module:     0.85,
  enum:       0.80,
  namespace:  0.75,
  function:   0.70,
  constant:   0.60,
  directory:  0.50,
  section:    0.40,
  term:       0.45,
  definition: 0.45,
};

export const KIND_TO_RELATIONSHIP: Record<CodeConceptKind, CodeRelationship> = {
  class:      "defines",
  interface:  "defines",
  module:     "defines",
  enum:       "defines",
  namespace:  "defines",
  function:   "implements",
  constant:   "configures",
  directory:  "defines",
  section:    "defines",
  term:       "defines",
  definition: "defines",
};

export const EXPORT_BONUS = 0.05;

// ─── Pure Scoring Functions ─────────────────────────────────────────

/**
 * Compute the raw score for a term-concept pair using the given strategies.
 */
export function computeScore(
  termTokens: TermTokens,
  conceptTokens: ConceptTokens,
  enabledStrategies: Set<MatchStrategy>,
): { score: number; strategies: MatchStrategy[] } {
  let score = 0;
  const strategies: MatchStrategy[] = [];

  if (enabledStrategies.has("exact")) {
    const exactScore = scoreExactMatch(
      termTokens.normalizedName,
      conceptTokens.normalizedName,
    );
    if (exactScore > 0) {
      score += exactScore * STRATEGY_WEIGHTS["exact"];
      strategies.push("exact");
    }
  }

  if (enabledStrategies.has("alias-exact")) {
    const aliasScore = scoreAliasExactMatch(
      termTokens.normalizedAliases,
      conceptTokens.normalizedName,
    );
    if (aliasScore > 0) {
      score += aliasScore * STRATEGY_WEIGHTS["alias-exact"];
      strategies.push("alias-exact");
    }
  }

  if (enabledStrategies.has("token-overlap")) {
    const tokenScore = computePartialTokenOverlap(
      termTokens.nameTokens,
      conceptTokens.nameTokens,
    );
    if (tokenScore > 0) {
      score += tokenScore * STRATEGY_WEIGHTS["token-overlap"];
      strategies.push("token-overlap");
    }
  }

  if (enabledStrategies.has("file-path")) {
    const pathScore = computePartialTokenOverlap(
      termTokens.nameTokens,
      conceptTokens.pathTokens,
    );
    if (pathScore > 0) {
      score += pathScore * STRATEGY_WEIGHTS["file-path"];
      strategies.push("file-path");
    }
  }

  if (enabledStrategies.has("description")) {
    const descScore = computePartialTokenOverlap(
      termTokens.definitionTokens,
      conceptTokens.descriptionTokens,
    );
    if (descScore > 0) {
      score += descScore * STRATEGY_WEIGHTS["description"];
      strategies.push("description");
    }
  }

  if (enabledStrategies.has("alias-token")) {
    let bestAliasTokenScore = 0;
    for (const aliasTokens of termTokens.aliasTokenSets) {
      const aliasScore = computePartialTokenOverlap(
        aliasTokens,
        conceptTokens.nameTokens,
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
 * Score exact name match.
 */
export function scoreExactMatch(
  normalizedTermName: string,
  normalizedConceptName: string,
): number {
  if (!normalizedTermName || !normalizedConceptName) return 0;

  if (normalizedTermName === normalizedConceptName) return 1.0;

  const termCompact = normalizedTermName.replace(/\s/g, "");
  const conceptCompact = normalizedConceptName.replace(/\s/g, "");
  if (termCompact === conceptCompact) return 0.95;

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
 * Score alias exact matches.
 */
export function scoreAliasExactMatch(
  normalizedAliases: string[],
  normalizedConceptName: string,
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
