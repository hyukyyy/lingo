/**
 * Unit tests for the EnrichmentTracker.
 *
 * Tests the core enrichment signal recording, score computation,
 * alias suggestion, and state management functionality.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  EnrichmentTracker,
  type EnrichmentState,
} from "../../src/enrichment/enrichment-tracker.js";

describe("EnrichmentTracker", () => {
  let tracker: EnrichmentTracker;

  beforeEach(() => {
    tracker = new EnrichmentTracker();
  });

  // ─── Constructor ──────────────────────────────────────────────────

  describe("constructor", () => {
    it("creates an empty tracker by default", () => {
      const stats = tracker.getStats();
      expect(stats.totalSignals).toBe(0);
      expect(stats.enrichedTermCount).toBe(0);
      expect(stats.uniqueQueries).toBe(0);
      expect(stats.averageScore).toBe(0);
    });

    it("accepts initial state", () => {
      const initialState: Partial<EnrichmentState> = {
        signals: [
          {
            type: "access",
            timestamp: new Date().toISOString(),
            termIds: ["term-1"],
          },
        ],
        termEnrichments: {
          "term-1": {
            termId: "term-1",
            accessCount: 5,
            queryHitCount: 3,
            queryPatterns: ["test"],
            codeLocationAdditions: 1,
            aliasAdditions: 0,
            verified: false,
            score: 0.3,
          },
        },
        queryTermMap: { test: ["term-1"] },
      };

      const restored = new EnrichmentTracker(initialState);
      expect(restored.getEnrichmentScore("term-1")).toBe(0.3);
      expect(restored.getStats().totalSignals).toBe(1);
    });
  });

  // ─── Signal Recording ─────────────────────────────────────────────

  describe("recordQuery", () => {
    it("records a query signal and updates term enrichment", () => {
      tracker.recordQuery("test query", ["term-1"]);

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment).toBeDefined();
      expect(enrichment!.queryHitCount).toBe(1);
      expect(enrichment!.queryPatterns).toContain("test query");
    });

    it("normalizes query to lowercase", () => {
      tracker.recordQuery("Test Query", ["term-1"]);

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.queryPatterns).toContain("test query");
    });

    it("ignores empty queries", () => {
      tracker.recordQuery("", ["term-1"]);
      tracker.recordQuery("  ", ["term-1"]);

      expect(tracker.getStats().totalSignals).toBe(0);
    });

    it("ignores queries with no matched terms", () => {
      tracker.recordQuery("test", []);

      expect(tracker.getStats().totalSignals).toBe(0);
    });

    it("updates multiple term enrichments for a single query", () => {
      tracker.recordQuery("shared query", ["term-1", "term-2", "term-3"]);

      expect(tracker.getTermEnrichment("term-1")!.queryHitCount).toBe(1);
      expect(tracker.getTermEnrichment("term-2")!.queryHitCount).toBe(1);
      expect(tracker.getTermEnrichment("term-3")!.queryHitCount).toBe(1);
    });

    it("deduplicates query patterns per term", () => {
      tracker.recordQuery("same query", ["term-1"]);
      tracker.recordQuery("same query", ["term-1"]);
      tracker.recordQuery("same query", ["term-1"]);

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.queryHitCount).toBe(3);
      expect(enrichment!.queryPatterns).toHaveLength(1);
    });

    it("updates query-term map", () => {
      tracker.recordQuery("test", ["term-1", "term-2"]);

      const state = tracker.exportState();
      expect(state.queryTermMap["test"]).toContain("term-1");
      expect(state.queryTermMap["test"]).toContain("term-2");
    });
  });

  describe("recordAccess", () => {
    it("increments access count", () => {
      tracker.recordAccess("term-1");
      tracker.recordAccess("term-1");
      tracker.recordAccess("term-1");

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.accessCount).toBe(3);
    });

    it("updates lastAccessed timestamp", () => {
      tracker.recordAccess("term-1");

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.lastAccessed).toBeDefined();
    });

    it("increases enrichment score", () => {
      const before = tracker.getEnrichmentScore("term-1");
      tracker.recordAccess("term-1");
      const after = tracker.getEnrichmentScore("term-1");

      expect(after).toBeGreaterThan(before);
    });
  });

  describe("recordCodeLocationAdded", () => {
    it("increments code location count", () => {
      tracker.recordCodeLocationAdded("term-1");
      tracker.recordCodeLocationAdded("term-1");

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.codeLocationAdditions).toBe(2);
    });

    it("increases enrichment score significantly", () => {
      tracker.recordAccess("term-1"); // small contribution
      const afterAccess = tracker.getEnrichmentScore("term-1");

      tracker.recordCodeLocationAdded("term-1"); // larger contribution
      const afterCodeLoc = tracker.getEnrichmentScore("term-1");

      expect(afterCodeLoc - afterAccess).toBeGreaterThan(0.05);
    });
  });

  describe("recordAliasAdded", () => {
    it("increments alias count", () => {
      tracker.recordAliasAdded("term-1");

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.aliasAdditions).toBe(1);
    });

    it("increases enrichment score", () => {
      const before = tracker.getEnrichmentScore("term-1");
      tracker.recordAliasAdded("term-1");
      const after = tracker.getEnrichmentScore("term-1");

      expect(after).toBeGreaterThan(before);
    });
  });

  describe("recordTermVerified", () => {
    it("marks term as verified", () => {
      tracker.recordTermVerified("term-1");

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.verified).toBe(true);
    });

    it("provides a significant score boost", () => {
      tracker.recordAccess("term-1");
      const beforeVerify = tracker.getEnrichmentScore("term-1");

      tracker.recordTermVerified("term-1");
      const afterVerify = tracker.getEnrichmentScore("term-1");

      expect(afterVerify - beforeVerify).toBeGreaterThanOrEqual(0.15);
    });
  });

  // ─── Score Computation ────────────────────────────────────────────

  describe("enrichment score computation", () => {
    it("starts at 0 for unknown terms", () => {
      expect(tracker.getEnrichmentScore("nonexistent")).toBe(0);
    });

    it("never exceeds 1.0", () => {
      // Flood with signals
      for (let i = 0; i < 100; i++) {
        tracker.recordAccess("term-1");
        tracker.recordQuery(`query-${i}`, ["term-1"]);
        tracker.recordCodeLocationAdded("term-1");
        tracker.recordAliasAdded("term-1");
      }
      tracker.recordTermVerified("term-1");

      expect(tracker.getEnrichmentScore("term-1")).toBeLessThanOrEqual(1.0);
    });

    it("has diminishing returns for repeated access", () => {
      tracker.recordAccess("term-1");
      const after1 = tracker.getEnrichmentScore("term-1");

      tracker.recordAccess("term-1");
      const after2 = tracker.getEnrichmentScore("term-1");

      // Increment should be smaller for the second access
      const delta1 = after1 - 0;
      const delta2 = after2 - after1;
      expect(delta1).toBeGreaterThan(delta2);
    });

    it("combines multiple signal types for a comprehensive score", () => {
      tracker.recordAccess("term-1");
      tracker.recordQuery("query", ["term-1"]);
      tracker.recordCodeLocationAdded("term-1");
      tracker.recordAliasAdded("term-1");
      tracker.recordTermVerified("term-1");

      const score = tracker.getEnrichmentScore("term-1");

      // With all signal types, score should be substantial
      expect(score).toBeGreaterThan(0.4);
    });
  });

  // ─── Query Relevance Boost ────────────────────────────────────────

  describe("getQueryRelevanceBoost", () => {
    it("returns 0 for unknown query-term pairs", () => {
      expect(tracker.getQueryRelevanceBoost("unknown", "unknown")).toBe(0);
    });

    it("returns positive boost for known query-term associations", () => {
      tracker.recordQuery("test query", ["term-1"]);

      const boost = tracker.getQueryRelevanceBoost("test query", "term-1");
      expect(boost).toBeGreaterThan(0);
    });

    it("returns 0 for term not associated with the query", () => {
      tracker.recordQuery("test query", ["term-1"]);

      const boost = tracker.getQueryRelevanceBoost("test query", "term-2");
      expect(boost).toBe(0);
    });

    it("boost increases with more usage", () => {
      tracker.recordQuery("test", ["term-1"]);
      const boost1 = tracker.getQueryRelevanceBoost("test", "term-1");

      // More access and query hits
      for (let i = 0; i < 5; i++) {
        tracker.recordAccess("term-1");
        tracker.recordQuery("test", ["term-1"]);
      }

      const boost2 = tracker.getQueryRelevanceBoost("test", "term-1");
      expect(boost2).toBeGreaterThan(boost1);
    });

    it("is capped at 0.30", () => {
      for (let i = 0; i < 100; i++) {
        tracker.recordQuery("test", ["term-1"]);
        tracker.recordAccess("term-1");
      }

      const boost = tracker.getQueryRelevanceBoost("test", "term-1");
      expect(boost).toBeLessThanOrEqual(0.30);
    });
  });

  // ─── Alias Suggestions ───────────────────────────────────────────

  describe("suggestAliases", () => {
    it("returns empty for unknown terms", () => {
      expect(tracker.suggestAliases("unknown")).toEqual([]);
    });

    it("suggests query patterns as potential aliases", () => {
      tracker.recordQuery("auth", ["term-1"]);
      tracker.recordQuery("login", ["term-1"]);
      tracker.recordQuery("sign in", ["term-1"]);

      const suggestions = tracker.suggestAliases("term-1");
      expect(suggestions).toContain("auth");
      expect(suggestions).toContain("login");
      expect(suggestions).toContain("sign in");
    });

    it("excludes existing aliases from suggestions", () => {
      tracker.recordQuery("auth", ["term-1"]);
      tracker.recordQuery("login", ["term-1"]);
      tracker.recordQuery("sign in", ["term-1"]);

      const suggestions = tracker.suggestAliases("term-1", ["auth", "Login"]);
      expect(suggestions).not.toContain("auth");
      expect(suggestions).not.toContain("login"); // case-insensitive
      expect(suggestions).toContain("sign in");
    });
  });

  // ─── Related Terms ───────────────────────────────────────────────

  describe("getRelatedTerms", () => {
    it("returns empty for terms with no query history", () => {
      expect(tracker.getRelatedTerms("unknown")).toEqual([]);
    });

    it("identifies related terms through query co-occurrence", () => {
      tracker.recordQuery("microservices", ["term-a", "term-b"]);
      tracker.recordQuery("services", ["term-a", "term-c"]);

      const related = tracker.getRelatedTerms("term-a");
      expect(related).toContain("term-b");
      expect(related).toContain("term-c");
    });

    it("does not include the term itself", () => {
      tracker.recordQuery("test", ["term-a", "term-b"]);

      const related = tracker.getRelatedTerms("term-a");
      expect(related).not.toContain("term-a");
    });

    it("sorts by co-occurrence strength", () => {
      // term-b co-occurs with term-a in 3 queries
      tracker.recordQuery("q1", ["term-a", "term-b"]);
      tracker.recordQuery("q2", ["term-a", "term-b"]);
      tracker.recordQuery("q3", ["term-a", "term-b"]);

      // term-c co-occurs with term-a in only 1 query
      tracker.recordQuery("q4", ["term-a", "term-c"]);

      const related = tracker.getRelatedTerms("term-a");
      expect(related[0]).toBe("term-b"); // stronger co-occurrence first
    });
  });

  // ─── State Management ────────────────────────────────────────────

  describe("state management", () => {
    it("exports a deep clone of state", () => {
      tracker.recordAccess("term-1");

      const exported = tracker.exportState();
      // Mutating the export should not affect the tracker
      exported.termEnrichments["term-1"].accessCount = 999;

      const enrichment = tracker.getTermEnrichment("term-1");
      expect(enrichment!.accessCount).toBe(1); // unchanged
    });

    it("limits signal history to prevent unbounded growth", () => {
      // Record more signals than the max (1000)
      for (let i = 0; i < 1100; i++) {
        tracker.recordAccess(`term-${i % 10}`);
      }

      const state = tracker.exportState();
      expect(state.signals.length).toBeLessThanOrEqual(1000);
    });
  });
});
