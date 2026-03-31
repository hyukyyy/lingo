/**
 * Progressive Enrichment Tests
 *
 * Demonstrates that as mappings are added through usage, query results
 * improve in relevance and completeness. Each test shows a clear
 * before/after quality difference.
 *
 * The progressive enrichment story:
 * 1. Empty glossary → zero results (cold start)
 * 2. Add basic terms → name matching works, but no code locations
 * 3. Add aliases → queries that failed before now succeed
 * 4. Add code locations → file-based discovery + completeness improves
 * 5. Usage accumulates → enrichment boosts frequently-used terms
 * 6. Verification → confidence-based filtering yields higher quality
 * 7. Cross-referencing → related terms surface through co-occurrence
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { EnrichmentTracker } from "../../src/enrichment/enrichment-tracker.js";
import {
  enrichedSearch,
  analyzeEnrichmentImpact,
  computeSearchQuality,
  type EnrichedSearchResult,
} from "../../src/enrichment/enriched-search.js";

// ─── Test Helpers ────────────────────────────────────────────────────

let tempDir: string;
let storage: JsonGlossaryStorage;
let tracker: EnrichmentTracker;

/**
 * Creates a fresh storage + tracker pair for each test.
 */
async function createTestContext() {
  tempDir = await mkdtemp(join(tmpdir(), "lingo-enrichment-test-"));
  const glossaryPath = join(tempDir, "glossary.json");
  storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");
  tracker = new EnrichmentTracker();
}

async function cleanupTestContext() {
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Extracts just the term names from enriched search results.
 */
function resultNames(results: EnrichedSearchResult[]): string[] {
  return results.map((r) => r.term.name);
}

// ─── Test Suites ──────────────────────────────────────────────────────

describe("Progressive Enrichment", () => {
  beforeEach(async () => {
    await createTestContext();
  });

  afterEach(async () => {
    await cleanupTestContext();
  });

  // ── Phase 1: Cold Start → First Terms ──────────────────────────────

  describe("Phase 1: Cold start to first terms", () => {
    it("empty glossary returns zero results for any query", () => {
      const results = enrichedSearch("authentication", storage, tracker);

      expect(results).toEqual([]);
      expect(computeSearchQuality(results)).toBe(0);
    });

    it("adding a single term makes it discoverable by name", async () => {
      // BEFORE: no results
      const before = enrichedSearch("authentication", storage, tracker);
      expect(before).toHaveLength(0);

      // ACTION: add a term
      await storage.addTerm({
        name: "Authentication Flow",
        definition: "User identity verification process",
      });

      // AFTER: the term is now findable
      const after = enrichedSearch("authentication", storage, tracker);
      expect(after).toHaveLength(1);
      expect(after[0].term.name).toBe("Authentication Flow");

      // Quality improved (but still low — no code locations, no enrichment)
      const qualityAfter = computeSearchQuality(after);
      expect(qualityAfter).toBeGreaterThan(0);
    });

    it("adding multiple terms increases the breadth of queryable concepts", async () => {
      // Add several terms
      await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint cycle",
        category: "agile",
      });
      await storage.addTerm({
        name: "Authentication Flow",
        definition: "User identity verification process",
        category: "security",
      });
      await storage.addTerm({
        name: "Billing Module",
        definition: "Subscription and payment processing system",
        category: "billing",
      });

      // Different queries now reach different terms
      const agileResults = enrichedSearch("sprint", storage, tracker);
      expect(agileResults.length).toBeGreaterThanOrEqual(1);
      expect(resultNames(agileResults)).toContain("Sprint Velocity");

      const authResults = enrichedSearch("authentication", storage, tracker);
      expect(authResults.length).toBeGreaterThanOrEqual(1);
      expect(resultNames(authResults)).toContain("Authentication Flow");

      const billingResults = enrichedSearch("billing", storage, tracker);
      expect(billingResults.length).toBeGreaterThanOrEqual(1);
      expect(resultNames(billingResults)).toContain("Billing Module");
    });
  });

  // ── Phase 2: Aliases Improve Query Coverage ───────────────────────

  describe("Phase 2: Aliases improve query coverage", () => {
    it("alias additions make terms findable by colloquial names", async () => {
      // Add term without aliases
      const term = await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint",
      });

      // BEFORE: searching by informal name fails
      const before = enrichedSearch("team speed", storage, tracker);
      expect(before).toHaveLength(0);

      // ACTION: add aliases that match informal language
      await storage.updateTerm(term.id, {
        aliases: ["velocity", "team speed", "SV"],
      });

      // AFTER: informal query now finds the term
      const after = enrichedSearch("team speed", storage, tracker);
      expect(after.length).toBeGreaterThanOrEqual(1);
      expect(resultNames(after)).toContain("Sprint Velocity");
    });

    it("each alias addition incrementally expands search coverage", async () => {
      const term = await storage.addTerm({
        name: "Feature Flag System",
        definition: "Infrastructure for toggling features per user segment",
      });

      // Stage 1: Only findable by exact name
      let results = enrichedSearch("feature flag", storage, tracker);
      expect(results.length).toBeGreaterThanOrEqual(1);

      // "toggles" doesn't match yet
      results = enrichedSearch("toggles", storage, tracker);
      expect(results).toHaveLength(0);

      // Stage 2: Add first alias
      await storage.updateTerm(term.id, {
        aliases: ["feature toggles"],
      });

      results = enrichedSearch("toggles", storage, tracker);
      expect(results.length).toBeGreaterThanOrEqual(1);

      // "FF" doesn't match yet
      results = enrichedSearch("FF", storage, tracker);
      expect(results).toHaveLength(0);

      // Stage 3: Add another alias
      await storage.updateTerm(term.id, {
        aliases: ["feature toggles", "FF"],
      });

      results = enrichedSearch("FF", storage, tracker);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(resultNames(results)).toContain("Feature Flag System");
    });
  });

  // ── Phase 3: Code Locations Improve Completeness ──────────────────

  describe("Phase 3: Code locations improve completeness and file queries", () => {
    it("adding code locations increases search quality score", async () => {
      const term = await storage.addTerm({
        name: "Authentication Flow",
        definition: "User identity verification process",
      });

      // BEFORE: term exists but has no code locations
      const before = enrichedSearch("authentication", storage, tracker);
      expect(before).toHaveLength(1);
      expect(before[0].term.codeLocations).toHaveLength(0);
      const qualityBefore = computeSearchQuality(before);

      // ACTION: add code locations
      await storage.updateTerm(term.id, {
        codeLocations: [
          {
            filePath: "src/services/auth.ts",
            symbol: "AuthService",
            relationship: "defines" as const,
          },
          {
            filePath: "src/middleware/auth-guard.ts",
            symbol: "AuthGuard",
            relationship: "implements" as const,
          },
        ],
      });

      // AFTER: same query, but results now include code locations
      const after = enrichedSearch("authentication", storage, tracker);
      expect(after).toHaveLength(1);
      expect(after[0].term.codeLocations).toHaveLength(2);
      const qualityAfter = computeSearchQuality(after);

      // Quality improved because results are now "complete" (have code locations)
      expect(qualityAfter).toBeGreaterThan(qualityBefore);
    });

    it("code locations enable file-path-based term discovery", async () => {
      await storage.addTerm({
        name: "Billing Module",
        definition: "Subscription and payment processing",
        codeLocations: [
          {
            filePath: "src/billing/subscription-manager.ts",
            symbol: "SubscriptionManager",
            relationship: "defines" as const,
          },
          {
            filePath: "src/billing/payment-gateway.ts",
            symbol: "PaymentGateway",
            relationship: "implements" as const,
          },
        ],
      });

      // File-path query finds related terms
      const results = storage.findTermsByFile("src/billing");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Billing Module");

      // More specific file path also works
      const specificResults = storage.findTermsByFile("payment-gateway");
      expect(specificResults).toHaveLength(1);
    });

    it("progressively adding code locations to multiple terms improves cross-file discoverability", async () => {
      const authTerm = await storage.addTerm({
        name: "Authentication",
        definition: "User identity verification",
      });
      const billingTerm = await storage.addTerm({
        name: "Billing",
        definition: "Payment processing",
      });

      // BEFORE: no file-path discovery possible
      expect(storage.findTermsByFile("src/services")).toHaveLength(0);

      // ACTION: add code locations to auth
      await storage.updateTerm(authTerm.id, {
        codeLocations: [
          {
            filePath: "src/services/auth.ts",
            symbol: "AuthService",
            relationship: "defines" as const,
          },
        ],
      });

      // AFTER stage 1: auth is discoverable by file
      expect(storage.findTermsByFile("src/services")).toHaveLength(1);

      // ACTION: add code locations to billing in same directory
      await storage.updateTerm(billingTerm.id, {
        codeLocations: [
          {
            filePath: "src/services/billing.ts",
            symbol: "BillingService",
            relationship: "defines" as const,
          },
        ],
      });

      // AFTER stage 2: both terms discoverable in the same directory
      const servicesTerms = storage.findTermsByFile("src/services");
      expect(servicesTerms).toHaveLength(2);
      const names = servicesTerms.map((t) => t.name);
      expect(names).toContain("Authentication");
      expect(names).toContain("Billing");
    });
  });

  // ── Phase 4: Usage Accumulation Improves Ranking ──────────────────

  describe("Phase 4: Usage accumulation improves search ranking", () => {
    it("frequently accessed terms rank higher than rarely accessed ones", async () => {
      // Add two terms with similar relevance to a query
      const lessUsed = await storage.addTerm({
        name: "Sprint Planning",
        definition: "Ceremony for planning sprint work items",
        category: "agile",
      });
      const moreUsed = await storage.addTerm({
        name: "Sprint Review",
        definition: "Ceremony for reviewing sprint deliverables",
        category: "agile",
      });

      // Initial search: both should appear for "sprint"
      const initialResults = enrichedSearch("sprint", storage, tracker);
      expect(initialResults.length).toBe(2);

      // Simulate heavy usage of Sprint Review
      for (let i = 0; i < 10; i++) {
        tracker.recordAccess(moreUsed.id);
      }
      // Record query associations
      tracker.recordQuery("sprint", [moreUsed.id]);
      tracker.recordQuery("sprint ceremony", [moreUsed.id]);
      tracker.recordQuery("review", [moreUsed.id]);

      // After usage accumulation: Sprint Review should rank higher
      const enrichedResults = enrichedSearch("sprint", storage, tracker);
      expect(enrichedResults.length).toBe(2);

      // The more-used term should have a higher combined score
      const reviewResult = enrichedResults.find(
        (r) => r.term.name === "Sprint Review"
      )!;
      const planningResult = enrichedResults.find(
        (r) => r.term.name === "Sprint Planning"
      )!;

      expect(reviewResult.enrichmentScore).toBeGreaterThan(
        planningResult.enrichmentScore
      );
      expect(reviewResult.enrichmentApplied).toBe(true);
    });

    it("enrichment score increases with each type of signal", async () => {
      const term = await storage.addTerm({
        name: "Deployment Pipeline",
        definition: "CI/CD pipeline for deploying applications",
      });

      // Baseline score: zero enrichment
      expect(tracker.getEnrichmentScore(term.id)).toBe(0);

      // After access signals
      tracker.recordAccess(term.id);
      tracker.recordAccess(term.id);
      const afterAccess = tracker.getEnrichmentScore(term.id);
      expect(afterAccess).toBeGreaterThan(0);

      // After query signals
      tracker.recordQuery("deployment", [term.id]);
      tracker.recordQuery("pipeline", [term.id]);
      const afterQuery = tracker.getEnrichmentScore(term.id);
      expect(afterQuery).toBeGreaterThan(afterAccess);

      // After code location addition
      tracker.recordCodeLocationAdded(term.id);
      const afterCodeLoc = tracker.getEnrichmentScore(term.id);
      expect(afterCodeLoc).toBeGreaterThan(afterQuery);

      // After alias addition
      tracker.recordAliasAdded(term.id);
      const afterAlias = tracker.getEnrichmentScore(term.id);
      expect(afterAlias).toBeGreaterThan(afterCodeLoc);

      // After verification
      tracker.recordTermVerified(term.id);
      const afterVerify = tracker.getEnrichmentScore(term.id);
      expect(afterVerify).toBeGreaterThan(afterAlias);
    });

    it("query affinity boost surfaces terms that previously matched a query", async () => {
      const authTerm = await storage.addTerm({
        name: "Authentication Flow",
        definition: "User identity verification process",
        aliases: ["auth"],
      });
      const audiTerm = await storage.addTerm({
        name: "Audit Log",
        definition: "System for recording audit trail events",
        aliases: ["audit trail"],
      });

      // Both terms match "au" prefix queries to some extent
      // But simulate that "auth" queries consistently lead to authTerm
      tracker.recordQuery("auth", [authTerm.id]);
      tracker.recordQuery("auth", [authTerm.id]);
      tracker.recordQuery("auth", [authTerm.id]);
      tracker.recordAccess(authTerm.id);

      // Check query affinity
      const authBoost = tracker.getQueryRelevanceBoost("auth", authTerm.id);
      const auditBoost = tracker.getQueryRelevanceBoost("auth", audiTerm.id);

      expect(authBoost).toBeGreaterThan(auditBoost);
    });
  });

  // ── Phase 5: Verification Improves Confidence Quality ─────────────

  describe("Phase 5: Verification improves result confidence quality", () => {
    it("verified terms have higher search quality than AI-suggested terms", async () => {
      // Add ai-suggested term
      await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points per sprint",
        confidence: "ai-suggested",
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines" as const,
          },
        ],
      });

      // BEFORE: search quality reflects ai-suggested confidence
      const before = enrichedSearch("velocity", storage, tracker);
      const qualityBefore = computeSearchQuality(before);

      // ACTION: verify the term (update confidence to ai-verified)
      await storage.updateTerm(before[0].term.id, {
        confidence: "ai-verified",
      });

      // AFTER: same term, same query, but higher quality due to verification
      const after = enrichedSearch("velocity", storage, tracker);
      const qualityAfter = computeSearchQuality(after);

      expect(qualityAfter).toBeGreaterThan(qualityBefore);
    });

    it("mix of verified and unverified terms yields intermediate quality", async () => {
      // Add one verified term and one ai-suggested term
      await storage.addTerm({
        name: "Authentication",
        definition: "Identity verification",
        confidence: "manual",
        codeLocations: [
          {
            filePath: "src/auth.ts",
            symbol: "auth",
            relationship: "defines" as const,
          },
        ],
      });
      await storage.addTerm({
        name: "Authorization",
        definition: "Permission checking after authentication",
        confidence: "ai-suggested",
        codeLocations: [
          {
            filePath: "src/authz.ts",
            symbol: "authorize",
            relationship: "defines" as const,
          },
        ],
      });

      // Both terms match "auth" queries
      const results = enrichedSearch("auth", storage, tracker);
      const quality = computeSearchQuality(results);

      // Quality should be between 0 and 1, reflecting the mix
      expect(quality).toBeGreaterThan(0);
      expect(quality).toBeLessThanOrEqual(1);

      // The verified term should have higher base quality contribution
      const verifiedResult = results.find(
        (r) => r.term.confidence === "manual"
      );
      const suggestedResult = results.find(
        (r) => r.term.confidence === "ai-suggested"
      );
      expect(verifiedResult).toBeDefined();
      expect(suggestedResult).toBeDefined();
    });
  });

  // ── Phase 6: End-to-End Progressive Quality Improvement ───────────

  describe("Phase 6: End-to-end progressive quality improvement", () => {
    it("demonstrates monotonically increasing quality through progressive enrichment stages", async () => {
      const qualityScores: number[] = [];

      // Stage 0: Empty — zero quality
      const stage0 = enrichedSearch("auth", storage, tracker);
      qualityScores.push(computeSearchQuality(stage0));
      expect(qualityScores[0]).toBe(0);

      // Stage 1: Add a bare term (no code locations, no aliases, ai-suggested)
      const authTerm = await storage.addTerm({
        name: "Authentication Flow",
        definition: "User identity verification process",
        confidence: "ai-suggested",
      });
      const stage1 = enrichedSearch("authentication", storage, tracker);
      qualityScores.push(computeSearchQuality(stage1));
      expect(qualityScores[1]).toBeGreaterThan(qualityScores[0]);

      // Stage 2: Add code locations — completeness improves
      await storage.updateTerm(authTerm.id, {
        codeLocations: [
          {
            filePath: "src/services/auth.ts",
            symbol: "AuthService",
            relationship: "defines" as const,
          },
          {
            filePath: "src/middleware/auth-guard.ts",
            symbol: "AuthGuard",
            relationship: "implements" as const,
          },
        ],
      });
      tracker.recordCodeLocationAdded(authTerm.id);
      tracker.recordCodeLocationAdded(authTerm.id);

      const stage2 = enrichedSearch("authentication", storage, tracker);
      qualityScores.push(computeSearchQuality(stage2));
      expect(qualityScores[2]).toBeGreaterThan(qualityScores[1]);

      // Stage 3: Accumulate usage signals — enrichment boosts ranking
      for (let i = 0; i < 5; i++) {
        tracker.recordAccess(authTerm.id);
      }
      tracker.recordQuery("authentication", [authTerm.id]);
      tracker.recordQuery("auth flow", [authTerm.id]);
      tracker.recordQuery("login process", [authTerm.id]);

      const stage3 = enrichedSearch("authentication", storage, tracker);
      qualityScores.push(computeSearchQuality(stage3));
      expect(qualityScores[3]).toBeGreaterThan(qualityScores[2]);

      // Stage 4: Verify the term — confidence improves
      await storage.updateTerm(authTerm.id, {
        confidence: "ai-verified",
      });
      tracker.recordTermVerified(authTerm.id);

      const stage4 = enrichedSearch("authentication", storage, tracker);
      qualityScores.push(computeSearchQuality(stage4));
      expect(qualityScores[4]).toBeGreaterThan(qualityScores[3]);

      // Verify the overall trend: each stage is better than the last
      for (let i = 1; i < qualityScores.length; i++) {
        expect(qualityScores[i]).toBeGreaterThanOrEqual(qualityScores[i - 1]);
      }
    });

    it("demonstrates that enrichment re-orders results to surface more relevant terms", async () => {
      // Add three terms — one will be heavily used
      const auth = await storage.addTerm({
        name: "Authentication",
        definition: "Identity verification with secure login",
        codeLocations: [
          {
            filePath: "src/auth/service.ts",
            symbol: "AuthService",
            relationship: "defines" as const,
          },
        ],
      });
      const authConfig = await storage.addTerm({
        name: "Auth Configuration",
        definition: "Authentication system configuration settings",
        codeLocations: [
          {
            filePath: "src/auth/config.ts",
            symbol: "AuthConfig",
            relationship: "configures" as const,
          },
        ],
      });
      const authTests = await storage.addTerm({
        name: "Auth Test Suite",
        definition: "Authentication integration and unit tests",
        codeLocations: [
          {
            filePath: "tests/auth.test.ts",
            symbol: "authTestSuite",
            relationship: "tests" as const,
          },
        ],
      });

      // BEFORE enrichment: all have similar base relevance for "auth"
      const beforeResults = enrichedSearch("auth", storage, tracker);
      const beforeImpact = analyzeEnrichmentImpact(beforeResults);
      expect(beforeImpact.enrichedCount).toBe(0);
      expect(beforeImpact.materialImpact).toBe(false);

      // Simulate heavy usage of "Authentication" (the main concept)
      for (let i = 0; i < 15; i++) {
        tracker.recordAccess(auth.id);
      }
      tracker.recordQuery("auth", [auth.id]);
      tracker.recordQuery("authentication", [auth.id]);
      tracker.recordQuery("login", [auth.id]);
      tracker.recordCodeLocationAdded(auth.id);
      tracker.recordAliasAdded(auth.id);
      tracker.recordTermVerified(auth.id);

      // Moderate usage of config
      tracker.recordAccess(authConfig.id);
      tracker.recordAccess(authConfig.id);

      // Minimal usage of tests (no enrichment)

      // AFTER enrichment: the heavily-used term should rank highest
      const afterResults = enrichedSearch("auth", storage, tracker);
      const afterImpact = analyzeEnrichmentImpact(afterResults);

      expect(afterImpact.enrichedCount).toBeGreaterThan(0);

      // The main Authentication term should have the highest enrichment
      const authResult = afterResults.find(
        (r) => r.term.name === "Authentication"
      )!;
      const configResult = afterResults.find(
        (r) => r.term.name === "Auth Configuration"
      )!;
      const testResult = afterResults.find(
        (r) => r.term.name === "Auth Test Suite"
      )!;

      expect(authResult.enrichmentScore).toBeGreaterThan(
        configResult.enrichmentScore
      );
      expect(configResult.enrichmentScore).toBeGreaterThan(
        testResult.enrichmentScore
      );
    });
  });

  // ── Phase 7: Cross-Referencing Through Co-Occurrence ──────────────

  describe("Phase 7: Cross-referencing through query co-occurrence", () => {
    it("terms queried together become related through the tracker", async () => {
      const authTerm = await storage.addTerm({
        name: "Authentication",
        definition: "User identity verification",
      });
      const sessionTerm = await storage.addTerm({
        name: "Session Management",
        definition: "Managing user sessions after authentication",
      });
      const billingTerm = await storage.addTerm({
        name: "Billing",
        definition: "Payment processing system",
      });

      // Simulate queries where auth and session often co-occur
      tracker.recordQuery("user login", [authTerm.id, sessionTerm.id]);
      tracker.recordQuery("session auth", [authTerm.id, sessionTerm.id]);
      tracker.recordQuery("identity", [authTerm.id]);

      // Auth and Session should be related
      const relatedToAuth = tracker.getRelatedTerms(authTerm.id);
      expect(relatedToAuth).toContain(sessionTerm.id);
      // Billing should NOT be related to auth
      expect(relatedToAuth).not.toContain(billingTerm.id);

      // Session should be related to auth too
      const relatedToSession = tracker.getRelatedTerms(sessionTerm.id);
      expect(relatedToSession).toContain(authTerm.id);
    });

    it("alias suggestions emerge from query patterns", async () => {
      const term = await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint",
        aliases: ["velocity"],
      });

      // Users search using various informal terms
      tracker.recordQuery("team speed", [term.id]);
      tracker.recordQuery("sprint throughput", [term.id]);
      tracker.recordQuery("velocity", [term.id]); // already an alias
      tracker.recordQuery("sprint pace", [term.id]);

      // Alias suggestions should include query patterns not already in aliases
      const suggestions = tracker.suggestAliases(term.id, [
        "velocity",
        "Sprint Velocity",
      ]);

      expect(suggestions).toContain("team speed");
      expect(suggestions).toContain("sprint throughput");
      expect(suggestions).toContain("sprint pace");
      // "velocity" is already an alias, shouldn't be suggested
      expect(suggestions).not.toContain("velocity");
    });
  });

  // ── Phase 8: Enrichment Statistics and State ──────────────────────

  describe("Phase 8: Enrichment state tracking", () => {
    it("tracks enrichment statistics accurately", async () => {
      const term1 = await storage.addTerm({
        name: "Term A",
        definition: "First term",
      });
      const term2 = await storage.addTerm({
        name: "Term B",
        definition: "Second term",
      });

      // Record various signals
      tracker.recordAccess(term1.id);
      tracker.recordAccess(term1.id);
      tracker.recordAccess(term2.id);
      tracker.recordQuery("test query", [term1.id, term2.id]);
      tracker.recordCodeLocationAdded(term1.id);

      const stats = tracker.getStats();
      expect(stats.totalSignals).toBe(5); // 2 access + 1 access + 1 query + 1 code-loc
      expect(stats.enrichedTermCount).toBe(2);
      expect(stats.uniqueQueries).toBe(1);
      expect(stats.averageScore).toBeGreaterThan(0);
    });

    it("enrichment state can be exported and restored", async () => {
      const term = await storage.addTerm({
        name: "Persistent Term",
        definition: "A term with persistent enrichment",
      });

      // Build up enrichment
      tracker.recordAccess(term.id);
      tracker.recordQuery("persistent", [term.id]);
      tracker.recordCodeLocationAdded(term.id);
      tracker.recordTermVerified(term.id);

      const scoreBeforeExport = tracker.getEnrichmentScore(term.id);
      expect(scoreBeforeExport).toBeGreaterThan(0);

      // Export state
      const exportedState = tracker.exportState();

      // Create a new tracker from exported state
      const restoredTracker = new EnrichmentTracker(exportedState);

      // Score should be preserved
      const scoreAfterRestore = restoredTracker.getEnrichmentScore(term.id);
      expect(scoreAfterRestore).toBe(scoreBeforeExport);

      // Stats should be preserved
      const restoredStats = restoredTracker.getStats();
      expect(restoredStats.totalSignals).toBe(4);
      expect(restoredStats.enrichedTermCount).toBe(1);
    });

    it("per-term enrichment data is detailed and accurate", async () => {
      const term = await storage.addTerm({
        name: "Detailed Term",
        definition: "A term with detailed enrichment tracking",
      });

      tracker.recordAccess(term.id);
      tracker.recordAccess(term.id);
      tracker.recordAccess(term.id);
      tracker.recordQuery("detailed", [term.id]);
      tracker.recordQuery("enrichment", [term.id]);
      tracker.recordCodeLocationAdded(term.id);
      tracker.recordAliasAdded(term.id);
      tracker.recordTermVerified(term.id);

      const enrichment = tracker.getTermEnrichment(term.id);
      expect(enrichment).toBeDefined();
      expect(enrichment!.accessCount).toBe(3);
      expect(enrichment!.queryHitCount).toBe(2);
      expect(enrichment!.queryPatterns).toContain("detailed");
      expect(enrichment!.queryPatterns).toContain("enrichment");
      expect(enrichment!.codeLocationAdditions).toBe(1);
      expect(enrichment!.aliasAdditions).toBe(1);
      expect(enrichment!.verified).toBe(true);
      expect(enrichment!.score).toBeGreaterThan(0.5);
    });
  });

  // ── Phase 9: Before/After Quality Comparison ──────────────────────

  describe("Phase 9: Comprehensive before/after quality comparison", () => {
    it("measures quality improvement across the full enrichment lifecycle", async () => {
      /**
       * This test simulates a realistic enrichment lifecycle and measures
       * quality at each step to prove progressive improvement.
       *
       * Scenario: An org starts using Lingo for their authentication system.
       * Over time, they add terms, aliases, code locations, use the system,
       * and verify mappings. At each step, search quality should improve.
       */

      const qualityTimeline: Array<{
        stage: string;
        quality: number;
        resultCount: number;
        enrichedCount: number;
      }> = [];

      function recordQuality(stage: string, query: string) {
        const results = enrichedSearch(query, storage, tracker);
        const quality = computeSearchQuality(results);
        const impact = analyzeEnrichmentImpact(results);
        qualityTimeline.push({
          stage,
          quality,
          resultCount: results.length,
          enrichedCount: impact.enrichedCount,
        });
      }

      const query = "auth service";

      // Stage 0: Empty
      recordQuality("empty", query);

      // Stage 1: Add basic auth term
      const authTerm = await storage.addTerm({
        name: "Auth Service",
        definition: "Core authentication service handling user login and session management",
        confidence: "ai-suggested",
      });
      recordQuality("basic-term", query);

      // Stage 2: Add aliases
      await storage.updateTerm(authTerm.id, {
        aliases: ["authentication", "login service", "auth"],
      });
      tracker.recordAliasAdded(authTerm.id);
      recordQuality("with-aliases", query);

      // Stage 3: Add code locations
      await storage.updateTerm(authTerm.id, {
        codeLocations: [
          {
            filePath: "src/services/auth-service.ts",
            symbol: "AuthService",
            relationship: "defines" as const,
            note: "Primary auth service class",
          },
          {
            filePath: "src/middleware/auth-middleware.ts",
            symbol: "authMiddleware",
            relationship: "implements" as const,
          },
          {
            filePath: "src/config/auth-config.ts",
            symbol: "AuthConfig",
            relationship: "configures" as const,
          },
        ],
      });
      tracker.recordCodeLocationAdded(authTerm.id);
      tracker.recordCodeLocationAdded(authTerm.id);
      tracker.recordCodeLocationAdded(authTerm.id);
      recordQuality("with-code-locations", query);

      // Stage 4: Add a related term
      const sessionTerm = await storage.addTerm({
        name: "Session Manager",
        definition: "Manages user auth sessions and token refresh",
        confidence: "ai-suggested",
        aliases: ["session service"],
        codeLocations: [
          {
            filePath: "src/services/session-manager.ts",
            symbol: "SessionManager",
            relationship: "defines" as const,
          },
        ],
      });
      recordQuality("with-related-term", query);

      // Stage 5: Simulate usage
      for (let i = 0; i < 8; i++) {
        tracker.recordAccess(authTerm.id);
      }
      tracker.recordQuery("auth service", [authTerm.id]);
      tracker.recordQuery("authentication", [authTerm.id, sessionTerm.id]);
      tracker.recordQuery("login", [authTerm.id]);
      tracker.recordAccess(sessionTerm.id);
      recordQuality("after-usage", query);

      // Stage 6: Verify terms
      await storage.updateTerm(authTerm.id, { confidence: "ai-verified" });
      tracker.recordTermVerified(authTerm.id);
      recordQuality("after-verification", query);

      // Verify progressive improvement
      for (let i = 1; i < qualityTimeline.length; i++) {
        expect(
          qualityTimeline[i].quality,
          `Quality should improve from "${qualityTimeline[i - 1].stage}" to "${qualityTimeline[i].stage}"`
        ).toBeGreaterThanOrEqual(qualityTimeline[i - 1].quality);
      }

      // Verify the empty → final improvement is significant
      const emptyQuality = qualityTimeline[0].quality;
      const finalQuality = qualityTimeline[qualityTimeline.length - 1].quality;
      expect(finalQuality).toBeGreaterThan(emptyQuality);
      expect(finalQuality).toBeGreaterThan(0.5); // Should be at least moderate quality

      // Verify enrichment was applied in later stages
      const lastStage = qualityTimeline[qualityTimeline.length - 1];
      expect(lastStage.enrichedCount).toBeGreaterThan(0);
    });
  });
});
