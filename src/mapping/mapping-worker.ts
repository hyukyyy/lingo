/**
 * Mapping Worker Thread
 *
 * Runs in a worker_thread to process a chunk of terms in parallel.
 * Receives serialized data via workerData, reconstructs in-memory
 * structures, scores term-concept pairs, and posts results back.
 *
 * Messages:
 *   Worker → Main: { type: "progress", termsProcessed: number }
 *   Worker → Main: { type: "result", mappings: MappingCandidate[], totalCandidates: number }
 */

import { parentPort, workerData } from "node:worker_threads";

import {
  computeScore,
  KIND_BONUS,
  KIND_TO_RELATIONSHIP,
  EXPORT_BONUS,
} from "./scoring.js";
import type { MatchStrategy } from "./scoring.js";
import type { MappingCandidate } from "./mapping-engine.js";
import { InvertedIndex } from "./inverted-index.js";
import type {
  ConceptTokenCache,
  SerializedInvertedIndex,
  TermTokens,
} from "./inverted-index.js";
import {
  tokenize,
  tokenizeSentence,
  normalizeForComparison,
} from "./tokenizer.js";
import type { NormalizedTerm } from "../adapters/types.js";
import type { CodeConcept, CodeConceptKind } from "../types/index.js";

// ─── Worker Payload Types ───────────────────────────────────────────

export interface WorkerPayload {
  terms: NormalizedTerm[];
  concepts: SerializedConcept[];
  conceptTokenCache: SerializedConceptTokenCache;
  invertedIndex: SerializedInvertedIndex;
  config: {
    minConfidence: number;
    maxCandidatesPerTerm: number;
    enabledStrategies: string[];
  };
}

export interface SerializedConcept {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  exported: boolean;
}

export type SerializedConceptTokenCache = [string, {
  normalizedName: string;
  nameTokens: string[];
  pathTokens: string[];
  descriptionTokens: string[];
}][];

export interface WorkerProgressMessage {
  type: "progress";
  termsProcessed: number;
}

export interface WorkerResultMessage {
  type: "result";
  mappings: MappingCandidate[];
  totalCandidates: number;
}

export type WorkerMessage = WorkerProgressMessage | WorkerResultMessage;

// ─── Worker Entry Point ─────────────────────────────────────────────

function runWorker(): void {
  if (!parentPort || !workerData) return;

  const payload = workerData as WorkerPayload;

  // Reconstruct data structures from serialized form
  const invertedIndex = InvertedIndex.deserialize(payload.invertedIndex);

  const conceptTokenCache: ConceptTokenCache = new Map();
  for (const [id, tokens] of payload.conceptTokenCache) {
    conceptTokenCache.set(id, tokens);
  }

  const conceptMap = new Map<string, SerializedConcept>();
  for (const concept of payload.concepts) {
    conceptMap.set(concept.id, concept);
  }

  const enabledStrategies = new Set(payload.config.enabledStrategies as MatchStrategy[]);
  const { minConfidence, maxCandidatesPerTerm } = payload.config;

  const allMappings: MappingCandidate[] = [];
  let totalCandidates = 0;

  // Progress: report every 100 terms
  const progressInterval = Math.max(1, Math.min(100, Math.floor(payload.terms.length * 0.05)));

  for (let i = 0; i < payload.terms.length; i++) {
    const term = payload.terms[i];
    const termTokens = tokenizeTerm(term);

    // Use inverted index to get candidate concept IDs
    const candidateIds = invertedIndex.getCandidates(termTokens);

    const candidates: MappingCandidate[] = [];
    const seenConceptIds = new Set<string>();

    const idsToScore = candidateIds.size > 0 ? candidateIds : new Set(conceptMap.keys());

    for (const conceptId of idsToScore) {
      const conceptTokens = conceptTokenCache.get(conceptId);
      const concept = conceptMap.get(conceptId);
      if (!conceptTokens || !concept) continue;

      const { score, strategies } = computeScore(
        termTokens,
        conceptTokens,
        enabledStrategies,
      );

      if (score <= 0 || strategies.length === 0) continue;
      if (seenConceptIds.has(conceptId)) continue;
      seenConceptIds.add(conceptId);

      const kind = concept.kind as CodeConceptKind;
      const kindMultiplier = KIND_BONUS[kind] ?? 0.5;
      let adjustedScore = score * (0.7 + 0.3 * kindMultiplier);

      if (concept.exported) {
        adjustedScore += EXPORT_BONUS;
      }

      adjustedScore = Math.min(1.0, Math.max(0.0, adjustedScore));

      candidates.push({
        termName: term.name,
        conceptId,
        conceptName: concept.name,
        conceptKind: kind,
        filePath: concept.filePath,
        confidence: Math.round(adjustedScore * 1000) / 1000,
        matchStrategies: strategies,
        suggestedRelationship: KIND_TO_RELATIONSHIP[kind] ?? "uses",
      });
    }

    totalCandidates += candidates.length;

    const filtered = candidates.filter((c) => c.confidence >= minConfidence);
    filtered.sort((a, b) => b.confidence - a.confidence);
    allMappings.push(...filtered.slice(0, maxCandidatesPerTerm));

    // Emit progress
    if ((i + 1) % progressInterval === 0) {
      parentPort!.postMessage({
        type: "progress",
        termsProcessed: i + 1,
      } satisfies WorkerProgressMessage);
    }
  }

  // Send final result
  parentPort!.postMessage({
    type: "result",
    mappings: allMappings,
    totalCandidates,
  } satisfies WorkerResultMessage);
}

function tokenizeTerm(term: NormalizedTerm): TermTokens {
  return {
    normalizedName: normalizeForComparison(term.name),
    normalizedAliases: term.aliases.map(normalizeForComparison),
    nameTokens: tokenize(term.name),
    definitionTokens: tokenizeSentence(term.definition),
    aliasTokenSets: term.aliases.map((a) => tokenize(a)),
  };
}

// Run when loaded as a worker
runWorker();
