/**
 * Tests for the InvertedIndex used in mapping engine pre-filtering.
 *
 * Key invariant: getCandidates() must return a SUPERSET of concepts
 * that would score > 0 via brute-force scoring. No false negatives.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InvertedIndex } from "../../src/mapping/inverted-index.js";
import type {
  TermTokens,
  ConceptTokens,
  ConceptTokenCache,
} from "../../src/mapping/inverted-index.js";

// ─── Test Helpers ───────────────────────────────────────────────────

function makeConceptTokens(overrides: Partial<ConceptTokens> = {}): ConceptTokens {
  return {
    normalizedName: overrides.normalizedName ?? "",
    nameTokens: overrides.nameTokens ?? [],
    pathTokens: overrides.pathTokens ?? [],
    descriptionTokens: overrides.descriptionTokens ?? [],
  };
}

function makeTermTokens(overrides: Partial<TermTokens> = {}): TermTokens {
  return {
    normalizedName: overrides.normalizedName ?? "",
    normalizedAliases: overrides.normalizedAliases ?? [],
    nameTokens: overrides.nameTokens ?? [],
    definitionTokens: overrides.definitionTokens ?? [],
    aliasTokenSets: overrides.aliasTokenSets ?? [],
  };
}

function buildTestIndex(
  concepts: Record<string, Partial<ConceptTokens>>,
): InvertedIndex {
  const cache: ConceptTokenCache = new Map();
  const ids: string[] = [];

  for (const [id, tokens] of Object.entries(concepts)) {
    ids.push(id);
    cache.set(id, makeConceptTokens(tokens));
  }

  const index = new InvertedIndex();
  index.build(ids, cache);
  return index;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("InvertedIndex", () => {
  describe("build and query basics", () => {
    it("should find concepts by exact name token match", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["auth", "service"] },
        "c2": { nameTokens: ["billing", "module"] },
        "c3": { nameTokens: ["user", "manager"] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["auth"], normalizedName: "auth" }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(false);
    });

    it("should find concepts by path token match", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["foo"], pathTokens: ["src", "billing", "service"] },
        "c2": { nameTokens: ["bar"], pathTokens: ["src", "auth", "handler"] },
      });

      // file-path strategy uses term name tokens against concept path tokens
      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["billing"], normalizedName: "billing" }),
      );

      expect(candidates.has("c1")).toBe(true);
    });

    it("should find concepts by description token match", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["foo"], descriptionTokens: ["handles", "payment", "processing"] },
        "c2": { nameTokens: ["bar"], descriptionTokens: ["manages", "user", "sessions"] },
      });

      // description strategy uses term definition tokens against concept desc tokens
      const candidates = index.getCandidates(
        makeTermTokens({ definitionTokens: ["payment"], normalizedName: "x" }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(false);
    });

    it("should find concepts by normalized name (exact strategy)", () => {
      const index = buildTestIndex({
        "c1": { normalizedName: "auth service", nameTokens: [] },
        "c2": { normalizedName: "billing module", nameTokens: [] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({ normalizedName: "auth service" }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(false);
    });

    it("should find concepts by compact name form", () => {
      const index = buildTestIndex({
        "c1": { normalizedName: "auth service", nameTokens: ["auth", "service"] },
      });

      // "authservice" (compact) should match "auth service" indexed concept
      const candidates = index.getCandidates(
        makeTermTokens({ normalizedName: "authservice", nameTokens: ["authservice"] }),
      );

      expect(candidates.has("c1")).toBe(true);
    });
  });

  describe("prefix matching", () => {
    it("should find concepts where query token is prefix of concept token", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["authentication", "handler"] },
        "c2": { nameTokens: ["billing", "service"] },
      });

      // "auth" is a prefix of "authentication"
      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["auth"], normalizedName: "auth" }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(false);
    });

    it("should find concepts where concept token is prefix of query token", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["auth"] },
        "c2": { nameTokens: ["billing"] },
      });

      // "authentication" starts with "auth"
      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["authentication"], normalizedName: "authentication" }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(false);
    });

    it("should not prefix-match tokens shorter than 3 chars", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["ab", "service"] },
      });

      // "ab" is < 3 chars, should not be prefix matched
      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["abcdef"], normalizedName: "abcdef" }),
      );

      // Should not find c1 via prefix (but might find via other token matches)
      // "ab" won't be prefix-matched because it's < 3 chars
      // "abcdef" doesn't start with "service" either
      // c1 should not be found
      expect(candidates.has("c1")).toBe(false);
    });
  });

  describe("alias matching", () => {
    it("should find concepts by alias-exact strategy", () => {
      const index = buildTestIndex({
        "c1": { normalizedName: "auth service", nameTokens: ["auth", "service"] },
        "c2": { normalizedName: "billing", nameTokens: ["billing"] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({
          normalizedName: "login handler",
          normalizedAliases: ["auth service"],
          nameTokens: ["login", "handler"],
        }),
      );

      expect(candidates.has("c1")).toBe(true);
    });

    it("should find concepts by alias-token strategy", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["authentication"] },
        "c2": { nameTokens: ["billing"] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({
          normalizedName: "login",
          nameTokens: ["login"],
          aliasTokenSets: [["auth"]],
        }),
      );

      // "auth" is a prefix of "authentication" in nameIndex
      expect(candidates.has("c1")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should return empty set when term has no tokens", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["auth"] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({
          normalizedName: "",
          nameTokens: [],
          definitionTokens: [],
          aliasTokenSets: [],
          normalizedAliases: [],
        }),
      );

      expect(candidates.size).toBe(0);
    });

    it("should handle empty concept cache", () => {
      const index = new InvertedIndex();
      index.build([], new Map());

      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["auth"], normalizedName: "auth" }),
      );

      expect(candidates.size).toBe(0);
    });

    it("should handle concepts with no tokens", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: [], pathTokens: [], descriptionTokens: [], normalizedName: "" },
      });

      const candidates = index.getCandidates(
        makeTermTokens({ nameTokens: ["auth"], normalizedName: "auth" }),
      );

      expect(candidates.has("c1")).toBe(false);
    });

    it("should union candidates across multiple strategies", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["auth"], pathTokens: [] },         // matches via name
        "c2": { nameTokens: [], pathTokens: ["billing"] },      // matches via path
        "c3": { nameTokens: [], descriptionTokens: ["payment"] }, // matches via desc
      });

      const candidates = index.getCandidates(
        makeTermTokens({
          nameTokens: ["auth", "billing"],
          definitionTokens: ["payment"],
          normalizedName: "auth billing",
        }),
      );

      expect(candidates.has("c1")).toBe(true);
      expect(candidates.has("c2")).toBe(true);
      expect(candidates.has("c3")).toBe(true);
    });
  });

  describe("serialization", () => {
    it("should serialize and deserialize correctly", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["auth", "service"], pathTokens: ["src", "auth"], normalizedName: "auth service" },
        "c2": { nameTokens: ["billing"], descriptionTokens: ["payment", "processing"], normalizedName: "billing" },
      });

      const serialized = index.serialize();
      const restored = InvertedIndex.deserialize(serialized);

      // Same query should return same results
      const term = makeTermTokens({ nameTokens: ["auth"], normalizedName: "auth" });
      const originalResult = index.getCandidates(term);
      const restoredResult = restored.getCandidates(term);

      expect(restoredResult).toEqual(originalResult);
    });

    it("should produce JSON-serializable output", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["test"] },
      });

      const serialized = index.serialize();
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);
      const restored = InvertedIndex.deserialize(parsed);

      const candidates = restored.getCandidates(
        makeTermTokens({ nameTokens: ["test"], normalizedName: "test" }),
      );
      expect(candidates.has("c1")).toBe(true);
    });
  });

  describe("superset correctness guarantee", () => {
    it("should return superset of brute-force exact matches", () => {
      // Set up concepts where exact matching would find c1
      const index = buildTestIndex({
        "c1": { normalizedName: "auth service", nameTokens: ["auth", "service"] },
        "c2": { normalizedName: "billing module", nameTokens: ["billing", "module"] },
        "c3": { normalizedName: "user manager", nameTokens: ["user", "manager"] },
      });

      // Query: exact match on "auth service"
      const candidates = index.getCandidates(
        makeTermTokens({
          normalizedName: "auth service",
          nameTokens: ["auth", "service"],
        }),
      );

      // Must include c1 (exact match)
      expect(candidates.has("c1")).toBe(true);
    });

    it("should return superset of brute-force token overlap matches", () => {
      const index = buildTestIndex({
        "c1": { nameTokens: ["authentication", "service"] },
        "c2": { nameTokens: ["completely", "unrelated"] },
        "c3": { nameTokens: ["auth", "handler"] },
      });

      const candidates = index.getCandidates(
        makeTermTokens({
          nameTokens: ["auth", "service"],
          normalizedName: "auth service",
        }),
      );

      // c1 should match (auth is prefix of authentication, service exact)
      expect(candidates.has("c1")).toBe(true);
      // c3 should match (auth exact)
      expect(candidates.has("c3")).toBe(true);
      // c2 should NOT match
      expect(candidates.has("c2")).toBe(false);
    });
  });
});
