/**
 * Tests for the Impact Analysis module.
 *
 * Validates that analyzeImpact() correctly queries the knowledge base
 * for a planning term and returns structured results with affected files,
 * symbols, and summary statistics.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonGlossaryStorage } from "../src/storage/json-store.js";
import { analyzeImpact } from "../src/analysis/impact-analysis.js";
import type {
  ImpactAnalysisResult,
  ImpactAnalysisOptions,
} from "../src/analysis/impact-analysis.js";
import type { CodeLocation, CodeRelationship } from "../src/models/glossary.js";

// ─── Test Helpers ───────────────────────────────────────────────────────

let tempDir: string;
let storage: JsonGlossaryStorage;

async function createTestStorage(): Promise<JsonGlossaryStorage> {
  tempDir = await mkdtemp(join(tmpdir(), "lingo-impact-test-"));
  const filePath = join(tempDir, "glossary.json");
  const s = new JsonGlossaryStorage(filePath);
  await s.load("test-org");
  return s;
}

async function addTestTerm(
  store: JsonGlossaryStorage,
  overrides: {
    name: string;
    definition: string;
    aliases?: string[];
    codeLocations?: CodeLocation[];
    category?: string;
    tags?: string[];
    confidence?: "manual" | "ai-suggested" | "ai-verified";
  }
) {
  return store.addTerm({
    name: overrides.name,
    definition: overrides.definition,
    aliases: overrides.aliases ?? [],
    codeLocations: overrides.codeLocations ?? [],
    category: overrides.category,
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? "manual",
    source: { adapter: "manual" },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("Impact Analysis", () => {
  beforeEach(async () => {
    storage = await createTestStorage();
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("analyzeImpact — basic behavior", () => {
    it("returns empty result for a query with no matches", () => {
      const result = analyzeImpact(storage, "nonexistent term");

      expect(result.found).toBe(false);
      expect(result.query).toBe("nonexistent term");
      expect(result.matchedTerms).toEqual([]);
      expect(result.affectedFiles).toEqual([]);
      expect(result.summary.totalMatchedTerms).toBe(0);
      expect(result.summary.totalAffectedFiles).toBe(0);
      expect(result.summary.totalSymbols).toBe(0);
    });

    it("finds a term by exact name match and returns its code locations", async () => {
      await addTestTerm(storage, {
        name: "Sprint Velocity",
        definition: "The rate of story points completed per sprint",
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines",
          },
          {
            filePath: "src/dashboard/sprint-widget.ts",
            symbol: "SprintWidget",
            relationship: "uses",
          },
        ],
      });

      const result = analyzeImpact(storage, "Sprint Velocity");

      expect(result.found).toBe(true);
      expect(result.matchedTerms).toHaveLength(1);
      expect(result.matchedTerms[0].name).toBe("Sprint Velocity");
      expect(result.affectedFiles).toHaveLength(2);
      expect(result.summary.totalAffectedFiles).toBe(2);
      expect(result.summary.totalSymbols).toBe(2);
    });

    it("finds a term by partial name match", async () => {
      await addTestTerm(storage, {
        name: "Authentication Guard",
        definition: "Middleware that protects routes requiring login",
        codeLocations: [
          {
            filePath: "src/auth/guard.ts",
            symbol: "AuthGuard",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "authentication");

      expect(result.found).toBe(true);
      expect(result.matchedTerms[0].name).toBe("Authentication Guard");
      expect(result.affectedFiles).toHaveLength(1);
      expect(result.affectedFiles[0].filePath).toBe("src/auth/guard.ts");
    });

    it("finds a term by alias", async () => {
      await addTestTerm(storage, {
        name: "Sprint Velocity",
        definition: "Story points per sprint",
        aliases: ["velocity", "SV", "sprint speed"],
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "computeSV",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "velocity");

      expect(result.found).toBe(true);
      expect(result.matchedTerms[0].name).toBe("Sprint Velocity");
      expect(result.affectedFiles[0].symbols[0].name).toBe("computeSV");
    });

    it("finds a term by definition keyword", async () => {
      await addTestTerm(storage, {
        name: "Feature Toggle",
        definition: "A mechanism to enable or disable features at runtime without deployment",
        codeLocations: [
          {
            filePath: "src/config/feature-flags.ts",
            symbol: "FeatureFlags",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "runtime");

      expect(result.found).toBe(true);
      expect(result.matchedTerms[0].name).toBe("Feature Toggle");
    });
  });

  describe("analyzeImpact — multiple terms", () => {
    it("aggregates code locations from multiple matching terms", async () => {
      await addTestTerm(storage, {
        name: "User Auth",
        definition: "User authentication flow",
        codeLocations: [
          {
            filePath: "src/auth/login.ts",
            symbol: "LoginHandler",
            relationship: "defines",
          },
        ],
      });

      await addTestTerm(storage, {
        name: "Auth Token",
        definition: "JWT authentication token management",
        codeLocations: [
          {
            filePath: "src/auth/token.ts",
            symbol: "TokenManager",
            relationship: "defines",
          },
          {
            filePath: "src/auth/login.ts",
            symbol: "generateToken",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "auth");

      expect(result.found).toBe(true);
      expect(result.matchedTerms.length).toBeGreaterThanOrEqual(2);
      // src/auth/login.ts should appear once but with symbols from both terms
      const loginFile = result.affectedFiles.find(
        (f) => f.filePath === "src/auth/login.ts"
      );
      expect(loginFile).toBeDefined();
      expect(loginFile!.symbols.length).toBe(2);
      expect(loginFile!.termIds.length).toBe(2);
    });

    it("deduplicates files referenced by multiple terms", async () => {
      const sharedFile = "src/shared/utils.ts";

      await addTestTerm(storage, {
        name: "Billing Utils",
        definition: "Billing utility functions",
        codeLocations: [
          {
            filePath: sharedFile,
            symbol: "formatCurrency",
            relationship: "uses",
          },
        ],
      });

      await addTestTerm(storage, {
        name: "Analytics Utils",
        definition: "Analytics utility functions",
        codeLocations: [
          {
            filePath: sharedFile,
            symbol: "trackEvent",
            relationship: "uses",
          },
        ],
      });

      // Both terms contain "utils" — both should match
      const result = analyzeImpact(storage, "utils");

      // The shared file should appear once
      const matchingFiles = result.affectedFiles.filter(
        (f) => f.filePath === sharedFile
      );
      expect(matchingFiles).toHaveLength(1);

      // But it should have symbols from both terms
      const file = matchingFiles[0];
      expect(file.symbols).toHaveLength(2);
      expect(file.symbols.map((s) => s.name)).toContain("formatCurrency");
      expect(file.symbols.map((s) => s.name)).toContain("trackEvent");
    });
  });

  describe("analyzeImpact — symbol details", () => {
    it("includes line range when available", async () => {
      await addTestTerm(storage, {
        name: "User Profile",
        definition: "User profile management",
        codeLocations: [
          {
            filePath: "src/user/profile.ts",
            symbol: "UserProfile",
            relationship: "defines",
            lineRange: { start: 10, end: 50 },
          },
        ],
      });

      const result = analyzeImpact(storage, "user profile");

      expect(result.affectedFiles[0].symbols[0].lineRange).toEqual({
        start: 10,
        end: 50,
      });
    });

    it("includes notes when available", async () => {
      await addTestTerm(storage, {
        name: "Billing Engine",
        definition: "Core billing calculation logic",
        codeLocations: [
          {
            filePath: "src/billing/engine.ts",
            symbol: "BillingEngine",
            relationship: "defines",
            note: "Main entry point for all billing calculations",
          },
        ],
      });

      const result = analyzeImpact(storage, "billing engine");

      expect(result.affectedFiles[0].symbols[0].note).toBe(
        "Main entry point for all billing calculations"
      );
    });

    it("tracks which term each symbol came from", async () => {
      const term = await addTestTerm(storage, {
        name: "Payment Gateway",
        definition: "Integration with external payment processor",
        codeLocations: [
          {
            filePath: "src/payments/stripe.ts",
            symbol: "StripeAdapter",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "payment gateway");

      expect(result.affectedFiles[0].symbols[0].fromTermId).toBe(term.id);
      expect(result.affectedFiles[0].symbols[0].fromTermName).toBe(
        "Payment Gateway"
      );
    });

    it("handles file-level references without symbols", async () => {
      await addTestTerm(storage, {
        name: "Config Schema",
        definition: "Application configuration schema",
        codeLocations: [
          {
            filePath: "config/schema.json",
            relationship: "configures",
          },
        ],
      });

      const result = analyzeImpact(storage, "config schema");

      expect(result.affectedFiles).toHaveLength(1);
      expect(result.affectedFiles[0].filePath).toBe("config/schema.json");
      expect(result.affectedFiles[0].symbols[0].name).toBe("(file-level)");
      expect(result.affectedFiles[0].symbols[0].relationship).toBe("configures");
    });
  });

  describe("analyzeImpact — affected file structure", () => {
    it("lists unique relationships per file", async () => {
      await addTestTerm(storage, {
        name: "Auth Service",
        definition: "Authentication service layer",
        codeLocations: [
          {
            filePath: "src/auth/service.ts",
            symbol: "AuthService",
            relationship: "defines",
          },
          {
            filePath: "src/auth/service.ts",
            symbol: "validateCredentials",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "auth service");

      expect(result.affectedFiles[0].relationships).toContain("defines");
      expect(result.affectedFiles[0].relationships).toContain("implements");
    });

    it("sorts files by symbol count descending", async () => {
      await addTestTerm(storage, {
        name: "Data Pipeline",
        definition: "ETL data processing pipeline",
        codeLocations: [
          {
            filePath: "src/pipeline/transform.ts",
            symbol: "transform",
            relationship: "implements",
          },
          {
            filePath: "src/pipeline/transform.ts",
            symbol: "TransformStep",
            relationship: "defines",
          },
          {
            filePath: "src/pipeline/extract.ts",
            symbol: "extract",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "data pipeline");

      // transform.ts has 2 symbols, extract.ts has 1
      expect(result.affectedFiles[0].filePath).toBe(
        "src/pipeline/transform.ts"
      );
      expect(result.affectedFiles[1].filePath).toBe(
        "src/pipeline/extract.ts"
      );
    });

    it("includes term names on each affected file", async () => {
      const term = await addTestTerm(storage, {
        name: "Notification Service",
        definition: "Handles sending notifications to users",
        codeLocations: [
          {
            filePath: "src/notifications/sender.ts",
            symbol: "NotificationSender",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "notification service");

      expect(result.affectedFiles[0].termNames).toContain(
        "Notification Service"
      );
      expect(result.affectedFiles[0].termIds).toContain(term.id);
    });
  });

  describe("analyzeImpact — summary statistics", () => {
    it("correctly counts relationship breakdown", async () => {
      await addTestTerm(storage, {
        name: "Event System",
        definition: "Event-driven architecture backbone",
        codeLocations: [
          {
            filePath: "src/events/emitter.ts",
            symbol: "EventEmitter",
            relationship: "defines",
          },
          {
            filePath: "src/events/handler.ts",
            symbol: "EventHandler",
            relationship: "implements",
          },
          {
            filePath: "tests/events.test.ts",
            symbol: "eventTests",
            relationship: "tests",
          },
          {
            filePath: "src/app.ts",
            symbol: "initEvents",
            relationship: "uses",
          },
        ],
      });

      const result = analyzeImpact(storage, "event system");

      expect(result.summary.relationshipBreakdown).toEqual({
        defines: 1,
        implements: 1,
        tests: 1,
        uses: 1,
      });
    });

    it("correctly counts confidence breakdown", async () => {
      await addTestTerm(storage, {
        name: "Manual Auth",
        definition: "Manually defined authentication term",
        confidence: "manual",
        codeLocations: [
          { filePath: "src/auth.ts", symbol: "A", relationship: "defines" },
        ],
      });

      await addTestTerm(storage, {
        name: "AI Auth Suggestion",
        definition: "AI-suggested authentication term",
        confidence: "ai-suggested",
        codeLocations: [
          { filePath: "src/auth2.ts", symbol: "B", relationship: "defines" },
        ],
      });

      const result = analyzeImpact(storage, "auth");

      expect(result.summary.confidenceBreakdown).toEqual({
        manual: 1,
        "ai-suggested": 1,
      });
    });
  });

  describe("analyzeImpact — options", () => {
    it("respects maxTerms option", async () => {
      // Create 5 terms that all match "component"
      for (let i = 0; i < 5; i++) {
        await addTestTerm(storage, {
          name: `Component ${i}`,
          definition: `Test component number ${i}`,
          codeLocations: [
            {
              filePath: `src/components/comp-${i}.ts`,
              symbol: `Component${i}`,
              relationship: "defines",
            },
          ],
        });
      }

      const result = analyzeImpact(storage, "component", { maxTerms: 2 });

      expect(result.matchedTerms.length).toBeLessThanOrEqual(2);
    });

    it("respects requireCodeLocations option (default: true)", async () => {
      await addTestTerm(storage, {
        name: "API Gateway",
        definition: "Central API routing gateway",
        codeLocations: [], // No code locations
      });

      const result = analyzeImpact(storage, "api gateway");

      // Default: requireCodeLocations=true, so term without locations is excluded
      expect(result.found).toBe(false);
      expect(result.matchedTerms).toHaveLength(0);
    });

    it("includes terms without code locations when requireCodeLocations=false", async () => {
      await addTestTerm(storage, {
        name: "API Gateway",
        definition: "Central API routing gateway",
        codeLocations: [], // No code locations
      });

      const result = analyzeImpact(storage, "api gateway", {
        requireCodeLocations: false,
      });

      expect(result.found).toBe(true);
      expect(result.matchedTerms).toHaveLength(1);
      expect(result.matchedTerms[0].name).toBe("API Gateway");
      expect(result.affectedFiles).toHaveLength(0);
    });

    it("filters by minConfidence", async () => {
      await addTestTerm(storage, {
        name: "Auth Manual",
        definition: "Manually verified auth term",
        confidence: "manual",
        codeLocations: [
          { filePath: "src/a.ts", symbol: "A", relationship: "defines" },
        ],
      });

      await addTestTerm(storage, {
        name: "Auth Suggested",
        definition: "AI-suggested auth term",
        confidence: "ai-suggested",
        codeLocations: [
          { filePath: "src/b.ts", symbol: "B", relationship: "defines" },
        ],
      });

      await addTestTerm(storage, {
        name: "Auth Verified",
        definition: "AI-verified auth term",
        confidence: "ai-verified",
        codeLocations: [
          { filePath: "src/c.ts", symbol: "C", relationship: "defines" },
        ],
      });

      // Only include "ai-verified" and above (i.e., ai-verified + manual)
      const result = analyzeImpact(storage, "auth", {
        minConfidence: "ai-verified",
      });

      expect(result.matchedTerms).toHaveLength(2);
      const names = result.matchedTerms.map((t) => t.name);
      expect(names).toContain("Auth Manual");
      expect(names).toContain("Auth Verified");
      expect(names).not.toContain("Auth Suggested");
    });

    it("filters by relationship types", async () => {
      await addTestTerm(storage, {
        name: "Billing Module",
        definition: "Core billing functionality",
        codeLocations: [
          {
            filePath: "src/billing/engine.ts",
            symbol: "BillingEngine",
            relationship: "defines",
          },
          {
            filePath: "tests/billing.test.ts",
            symbol: "billingTests",
            relationship: "tests",
          },
          {
            filePath: "src/app.ts",
            symbol: "initBilling",
            relationship: "uses",
          },
        ],
      });

      const result = analyzeImpact(storage, "billing module", {
        relationships: ["defines", "implements"],
      });

      // Only the "defines" location should be included (no "tests" or "uses")
      expect(result.affectedFiles).toHaveLength(1);
      expect(result.affectedFiles[0].filePath).toBe("src/billing/engine.ts");
    });

    it("filters by file path pattern", async () => {
      await addTestTerm(storage, {
        name: "Logging System",
        definition: "Application-wide logging infrastructure",
        codeLocations: [
          {
            filePath: "src/logging/logger.ts",
            symbol: "Logger",
            relationship: "defines",
          },
          {
            filePath: "tests/logging.test.ts",
            symbol: "loggerTests",
            relationship: "tests",
          },
          {
            filePath: "src/logging/transport.ts",
            symbol: "ConsoleTransport",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "logging system", {
        filePathFilter: "src/",
      });

      // Only src/ files should be included, not tests/
      expect(result.affectedFiles).toHaveLength(2);
      expect(
        result.affectedFiles.every((f) => f.filePath.startsWith("src/"))
      ).toBe(true);
    });
  });

  describe("analyzeImpact — edge cases", () => {
    it("handles empty query string", () => {
      const result = analyzeImpact(storage, "");

      expect(result.found).toBe(false);
      expect(result.matchedTerms).toEqual([]);
      expect(result.affectedFiles).toEqual([]);
    });

    it("handles query with only whitespace", () => {
      const result = analyzeImpact(storage, "   ");

      expect(result.found).toBe(false);
    });

    it("handles case-insensitive search", async () => {
      await addTestTerm(storage, {
        name: "JWT Token",
        definition: "JSON Web Token for auth",
        codeLocations: [
          {
            filePath: "src/auth/jwt.ts",
            symbol: "JwtService",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "jwt token");

      expect(result.found).toBe(true);
      expect(result.matchedTerms[0].name).toBe("JWT Token");
    });

    it("avoids duplicate symbols from the same term", async () => {
      await addTestTerm(storage, {
        name: "Rate Limiter",
        definition: "Request rate limiting middleware",
        codeLocations: [
          {
            filePath: "src/middleware/rate-limiter.ts",
            symbol: "RateLimiter",
            relationship: "defines",
          },
          // Same symbol, same relationship, same file — should deduplicate
          {
            filePath: "src/middleware/rate-limiter.ts",
            symbol: "RateLimiter",
            relationship: "defines",
          },
        ],
      });

      const result = analyzeImpact(storage, "rate limiter");

      // Should have deduplicated the identical symbol
      expect(result.affectedFiles[0].symbols).toHaveLength(1);
    });

    it("allows same symbol with different relationships", async () => {
      await addTestTerm(storage, {
        name: "Cache Layer",
        definition: "In-memory caching layer",
        codeLocations: [
          {
            filePath: "src/cache/redis.ts",
            symbol: "RedisCache",
            relationship: "defines",
          },
          {
            filePath: "src/cache/redis.ts",
            symbol: "RedisCache",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "cache layer");

      // Same symbol but different relationships — both should appear
      expect(result.affectedFiles[0].symbols).toHaveLength(2);
    });

    it("returns the query string in the result", async () => {
      const result = analyzeImpact(storage, "my specific query");

      expect(result.query).toBe("my specific query");
    });

    it("matched term summary includes codeLocationCount", async () => {
      await addTestTerm(storage, {
        name: "Search Index",
        definition: "Full-text search indexing service",
        codeLocations: [
          { filePath: "src/search/index.ts", symbol: "SearchIndex", relationship: "defines" },
          { filePath: "src/search/indexer.ts", symbol: "Indexer", relationship: "implements" },
          { filePath: "src/search/query.ts", symbol: "SearchQuery", relationship: "uses" },
        ],
      });

      const result = analyzeImpact(storage, "search index");

      expect(result.matchedTerms[0].codeLocationCount).toBe(3);
    });
  });

  describe("analyzeImpact — combined options", () => {
    it("applies multiple filters simultaneously", async () => {
      await addTestTerm(storage, {
        name: "Auth Service",
        definition: "Core authentication service",
        confidence: "manual",
        codeLocations: [
          {
            filePath: "src/auth/service.ts",
            symbol: "AuthService",
            relationship: "defines",
          },
          {
            filePath: "tests/auth.test.ts",
            symbol: "authTests",
            relationship: "tests",
          },
        ],
      });

      await addTestTerm(storage, {
        name: "Auth Helper",
        definition: "Authentication helper utilities",
        confidence: "ai-suggested",
        codeLocations: [
          {
            filePath: "src/auth/helpers.ts",
            symbol: "hashPassword",
            relationship: "implements",
          },
        ],
      });

      const result = analyzeImpact(storage, "auth", {
        minConfidence: "manual",
        relationships: ["defines"],
        filePathFilter: "src/",
      });

      // Only manual confidence, only "defines" relationship, only src/ files
      expect(result.matchedTerms).toHaveLength(1);
      expect(result.matchedTerms[0].name).toBe("Auth Service");
      expect(result.affectedFiles).toHaveLength(1);
      expect(result.affectedFiles[0].filePath).toBe("src/auth/service.ts");
    });
  });
});
