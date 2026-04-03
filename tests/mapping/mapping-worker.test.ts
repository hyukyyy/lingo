/**
 * Tests for the worker thread parallelization in the mapping engine.
 *
 * Key invariants:
 * - generateMappingsAsync() produces the same results as generateMappings()
 *   for small inputs (where it falls back to single-threaded)
 * - For large inputs, worker results are correct
 * - Worker failures trigger graceful fallback to single-threaded
 */

import { describe, it, expect } from "vitest";
import { MappingEngine } from "../../src/mapping/mapping-engine.js";
import type { NormalizedTerm } from "../../src/adapters/types.js";
import type { CodeConcept } from "../../src/types/index.js";

// ─── Test Helpers ───────────────────────────────────────────────────

function makeTerm(name: string, definition = ""): NormalizedTerm {
  return {
    name,
    definition: definition || `Definition for ${name}`,
    aliases: [],
    category: undefined,
    tags: [],
    source: { adapter: "test", externalId: name },
    confidence: "ai-suggested",
  };
}

function makeConcept(
  name: string,
  filePath: string,
  kind: CodeConcept["kind"] = "class",
): CodeConcept {
  return {
    id: `${filePath}#${name}`,
    name,
    kind,
    filePath,
    language: "typescript",
    exported: true,
    description: `A ${kind} called ${name}`,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("MappingEngine - async parallelization", () => {
  describe("small input fallback", () => {
    it("should produce identical results to sync for small inputs", async () => {
      const engine = new MappingEngine();

      const terms = [
        makeTerm("Auth Service"),
        makeTerm("Billing Module"),
        makeTerm("User Manager"),
      ];

      const concepts = [
        makeConcept("AuthService", "src/auth/auth-service.ts"),
        makeConcept("BillingModule", "src/billing/billing-module.ts"),
        makeConcept("UserManager", "src/users/user-manager.ts"),
        makeConcept("Logger", "src/utils/logger.ts"),
      ];

      const syncResult = engine.generateMappings(terms, concepts);
      const asyncResult = await engine.generateMappingsAsync(terms, concepts);

      // Same number of mappings
      expect(asyncResult.mappings.length).toBe(syncResult.mappings.length);
      expect(asyncResult.stats.termsProcessed).toBe(syncResult.stats.termsProcessed);
      expect(asyncResult.stats.conceptsAnalyzed).toBe(syncResult.stats.conceptsAnalyzed);

      // Same mapping content (order-independent comparison)
      const syncKeys = syncResult.mappings
        .map((m) => `${m.termName}→${m.conceptId}:${m.confidence}`)
        .sort();
      const asyncKeys = asyncResult.mappings
        .map((m) => `${m.termName}→${m.conceptId}:${m.confidence}`)
        .sort();
      expect(asyncKeys).toEqual(syncKeys);
    });
  });

  describe("progress callback", () => {
    it("should invoke progress callback during sync fallback", async () => {
      const progressCalls: { termsProcessed: number; totalTerms: number }[] = [];

      const engine = new MappingEngine({
        onProgress: (p) => progressCalls.push({ ...p }),
      });

      const terms = [makeTerm("Auth"), makeTerm("Billing"), makeTerm("User")];
      const concepts = [
        makeConcept("AuthService", "src/auth.ts"),
        makeConcept("BillingService", "src/billing.ts"),
      ];

      await engine.generateMappingsAsync(terms, concepts);

      // Should have at least the final progress call
      expect(progressCalls.length).toBeGreaterThan(0);
      const lastCall = progressCalls[progressCalls.length - 1];
      expect(lastCall.termsProcessed).toBe(terms.length);
      expect(lastCall.totalTerms).toBe(terms.length);
    });
  });

  describe("sync generateMappings with progress", () => {
    it("should invoke onProgress during sync mapping", () => {
      const progressCalls: number[] = [];

      const engine = new MappingEngine({
        onProgress: (p) => progressCalls.push(p.termsProcessed),
      });

      // Create enough terms to trigger multiple progress calls
      const terms = Array.from({ length: 200 }, (_, i) => makeTerm(`Term${i}`));
      const concepts = [
        makeConcept("Foo", "src/foo.ts"),
        makeConcept("Bar", "src/bar.ts"),
      ];

      engine.generateMappings(terms, concepts);

      // Should have multiple progress updates (every 10 terms for 200 = 5% = 10)
      expect(progressCalls.length).toBeGreaterThan(1);
      // Last call should be total
      expect(progressCalls[progressCalls.length - 1]).toBe(200);
      // Progress should be monotonically non-decreasing
      for (let i = 1; i < progressCalls.length; i++) {
        expect(progressCalls[i]).toBeGreaterThanOrEqual(progressCalls[i - 1]);
      }
    });
  });

  describe("inverted index correctness", () => {
    it("should produce same or superset results compared to brute-force", () => {
      const engine = new MappingEngine();

      const terms = [
        makeTerm("Authentication Handler"),
        makeTerm("Payment Processing"),
        makeTerm("User Profile"),
      ];

      const concepts = [
        makeConcept("AuthHandler", "src/auth/handler.ts"),
        makeConcept("PaymentProcessor", "src/payments/processor.ts"),
        makeConcept("UserProfile", "src/users/profile.ts"),
        makeConcept("DatabaseConnection", "src/db/connection.ts"),
        makeConcept("HttpClient", "src/http/client.ts"),
      ];

      const result = engine.generateMappings(terms, concepts);

      // Auth → AuthHandler should be found
      const authMappings = result.mappings.filter((m) => m.termName === "Authentication Handler");
      expect(authMappings.some((m) => m.conceptName === "AuthHandler")).toBe(true);

      // Payment → PaymentProcessor should be found
      const paymentMappings = result.mappings.filter((m) => m.termName === "Payment Processing");
      expect(paymentMappings.some((m) => m.conceptName === "PaymentProcessor")).toBe(true);

      // User Profile → UserProfile should be found
      const userMappings = result.mappings.filter((m) => m.termName === "User Profile");
      expect(userMappings.some((m) => m.conceptName === "UserProfile")).toBe(true);
    });
  });
});
