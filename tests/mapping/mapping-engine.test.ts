/**
 * Tests for the Term↔Code Mapping Engine
 *
 * The mapping engine takes extracted PM terms and code concepts,
 * applies heuristic and semantic matching to generate candidate
 * term↔code mappings with confidence scores.
 */

import { describe, it, expect } from "vitest";
import {
  MappingEngine,
  type MappingCandidate,
  type MappingConfig,
  type MappingResult,
} from "../../src/mapping/mapping-engine.js";
import type { CodeConcept } from "../../src/types/index.js";
import type { NormalizedTerm } from "../../src/adapters/types.js";

// ─── Test Fixtures ────────────────────────────────────────────────────

function makeTerm(overrides: Partial<NormalizedTerm> & Pick<NormalizedTerm, "name">): NormalizedTerm {
  return {
    name: overrides.name,
    definition: overrides.definition ?? `Definition of ${overrides.name}`,
    aliases: overrides.aliases ?? [],
    category: overrides.category,
    tags: overrides.tags ?? [],
    source: overrides.source ?? { adapter: "test" },
    confidence: overrides.confidence ?? "ai-suggested",
  };
}

function makeConcept(overrides: Partial<CodeConcept> & Pick<CodeConcept, "name" | "kind">): CodeConcept {
  return {
    id: overrides.id ?? `src/test.ts#${overrides.name}`,
    name: overrides.name,
    kind: overrides.kind,
    filePath: overrides.filePath ?? "src/test.ts",
    description: overrides.description ?? `A ${overrides.kind} named ${overrides.name}`,
    exported: overrides.exported ?? true,
    language: overrides.language ?? "typescript",
    metadata: overrides.metadata ?? {},
    ...(overrides.line !== undefined ? { line: overrides.line } : {}),
    ...(overrides.parentId !== undefined ? { parentId: overrides.parentId } : {}),
  };
}

// ─── Test Suites ──────────────────────────────────────────────────────

describe("MappingEngine", () => {
  describe("constructor and configuration", () => {
    it("creates an engine with default config", () => {
      const engine = new MappingEngine();
      expect(engine).toBeDefined();
    });

    it("accepts custom configuration", () => {
      const config: MappingConfig = {
        minConfidence: 0.5,
        maxCandidatesPerTerm: 3,
        strategies: ["exact", "token-overlap"],
      };
      const engine = new MappingEngine(config);
      expect(engine).toBeDefined();
    });
  });

  describe("generateMappings() - basic functionality", () => {
    it("returns empty results for empty inputs", () => {
      const engine = new MappingEngine();
      const result = engine.generateMappings([], []);

      expect(result.mappings).toEqual([]);
      expect(result.stats.termsProcessed).toBe(0);
      expect(result.stats.conceptsAnalyzed).toBe(0);
      expect(result.stats.candidatesGenerated).toBe(0);
    });

    it("returns no mappings when there are no code concepts", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Authentication" })];
      const result = engine.generateMappings(terms, []);

      expect(result.mappings).toEqual([]);
      expect(result.stats.termsProcessed).toBe(1);
    });

    it("returns no mappings when there are no terms", () => {
      const engine = new MappingEngine();
      const concepts = [makeConcept({ name: "AuthService", kind: "class" })];
      const result = engine.generateMappings([], concepts);

      expect(result.mappings).toEqual([]);
      expect(result.stats.conceptsAnalyzed).toBe(1);
    });

    it("generates mappings with confidence scores", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Auth Service" })];
      const concepts = [makeConcept({ name: "AuthService", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);

      expect(result.mappings.length).toBeGreaterThan(0);
      for (const mapping of result.mappings) {
        expect(mapping.confidence).toBeGreaterThanOrEqual(0);
        expect(mapping.confidence).toBeLessThanOrEqual(1);
      }
    });

    it("includes proper statistics in the result", () => {
      const engine = new MappingEngine();
      const terms = [
        makeTerm({ name: "Auth Service" }),
        makeTerm({ name: "User Profile" }),
      ];
      const concepts = [
        makeConcept({ name: "AuthService", kind: "class" }),
        makeConcept({ name: "UserProfile", kind: "class" }),
      ];

      const result = engine.generateMappings(terms, concepts);

      expect(result.stats.termsProcessed).toBe(2);
      expect(result.stats.conceptsAnalyzed).toBe(2);
      expect(result.stats.candidatesGenerated).toBeGreaterThan(0);
      expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("exact name matching", () => {
    it("matches when term name exactly matches concept name (case-insensitive)", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "AuthService" })];
      const concepts = [makeConcept({ name: "AuthService", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "AuthService" && m.conceptId === "src/test.ts#AuthService"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("matches term aliases against concept names", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Authentication", aliases: ["auth", "AuthService"] })];
      const concepts = [makeConcept({ name: "AuthService", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "Authentication"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe("token-based matching", () => {
    it("matches PascalCase concept name to space-separated term", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "User Profile" })];
      const concepts = [makeConcept({ name: "UserProfile", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "User Profile"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.5);
    });

    it("matches snake_case concept name to space-separated term", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "User Profile" })];
      const concepts = [makeConcept({ name: "user_profile", kind: "function" })];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "User Profile"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.5);
    });

    it("matches camelCase concept name to multi-word term", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Payment Gateway" })];
      const concepts = [makeConcept({ name: "paymentGateway", kind: "constant" })];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "Payment Gateway"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.5);
    });

    it("matches kebab-case file paths to terms", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "User Profile" })];
      const concepts = [
        makeConcept({
          name: "user-profile",
          kind: "module",
          filePath: "src/features/user-profile.ts",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "User Profile"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.3);
    });
  });

  describe("file path matching", () => {
    it("boosts confidence when file path contains term-related tokens", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Authentication" })];
      const concepts = [
        makeConcept({
          name: "login",
          kind: "function",
          filePath: "src/auth/authentication.ts",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "Authentication"
      );

      // File-path-only matches (no name overlap) are inherently weaker signals
      // The engine should still surface them as candidates above the min threshold
      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.1);
      expect(mapping!.matchStrategies).toContain("file-path");
    });

    it("matches directory names from file path against term tokens", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Billing Module" })];
      const concepts = [
        makeConcept({
          name: "InvoiceService",
          kind: "class",
          filePath: "src/billing/invoice-service.ts",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "Billing Module"
      );

      // Partial path overlap (1 of 2 term tokens in path) gives a low but non-zero score
      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.1);
      expect(mapping!.matchStrategies).toContain("file-path");
    });
  });

  describe("description/definition matching", () => {
    it("matches when term definition overlaps with concept description", () => {
      const engine = new MappingEngine();
      const terms = [
        makeTerm({
          name: "Sprint Velocity",
          definition: "Measures team sprint velocity by calculating story points completed per sprint",
        }),
      ];
      const concepts = [
        makeConcept({
          name: "calculateVelocity",
          kind: "function",
          description: "Calculates sprint velocity from completed story points",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const mapping = result.mappings.find(
        (m) => m.termName === "Sprint Velocity"
      );

      expect(mapping).toBeDefined();
      expect(mapping!.confidence).toBeGreaterThan(0.3);
    });
  });

  describe("confidence scoring", () => {
    it("higher-priority concept kinds get higher scores", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "UserService" })];
      const concepts = [
        makeConcept({ name: "UserService", kind: "class", id: "src/a.ts#UserService" }),
        makeConcept({ name: "UserService", kind: "constant", id: "src/b.ts#UserService" }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const classMapping = result.mappings.find((m) => m.conceptKind === "class");
      const constantMapping = result.mappings.find((m) => m.conceptKind === "constant");

      expect(classMapping).toBeDefined();
      expect(constantMapping).toBeDefined();
      // Classes should score higher than constants for the same name match
      expect(classMapping!.confidence).toBeGreaterThanOrEqual(constantMapping!.confidence);
    });

    it("exported concepts get higher scores than non-exported", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Helper" })];
      const concepts = [
        makeConcept({ name: "Helper", kind: "function", id: "src/a.ts#Helper", exported: true }),
        makeConcept({ name: "Helper", kind: "function", id: "src/b.ts#Helper", exported: false }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const exported = result.mappings.find((m) => m.conceptId === "src/a.ts#Helper");
      const internal = result.mappings.find((m) => m.conceptId === "src/b.ts#Helper");

      expect(exported).toBeDefined();
      expect(internal).toBeDefined();
      expect(exported!.confidence).toBeGreaterThan(internal!.confidence);
    });
  });

  describe("candidate filtering and limits", () => {
    it("filters out candidates below minimum confidence threshold", () => {
      const engine = new MappingEngine({ minConfidence: 0.5 });
      const terms = [makeTerm({ name: "VerySpecificTerm" })];
      const concepts = [
        makeConcept({ name: "CompletelyUnrelated", kind: "function" }),
      ];

      const result = engine.generateMappings(terms, concepts);

      for (const mapping of result.mappings) {
        expect(mapping.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("limits candidates per term to maxCandidatesPerTerm", () => {
      const engine = new MappingEngine({ maxCandidatesPerTerm: 2 });
      const terms = [makeTerm({ name: "User" })];
      const concepts = [
        makeConcept({ name: "UserService", kind: "class", id: "a#UserService" }),
        makeConcept({ name: "UserModel", kind: "class", id: "b#UserModel" }),
        makeConcept({ name: "UserController", kind: "class", id: "c#UserController" }),
        makeConcept({ name: "UserValidator", kind: "function", id: "d#UserValidator" }),
        makeConcept({ name: "UserHelper", kind: "function", id: "e#UserHelper" }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const userMappings = result.mappings.filter((m) => m.termName === "User");

      expect(userMappings.length).toBeLessThanOrEqual(2);
    });

    it("returns candidates sorted by confidence (highest first)", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "Auth" })];
      const concepts = [
        makeConcept({ name: "AuthService", kind: "class", id: "a#AuthService" }),
        makeConcept({ name: "authenticate", kind: "function", id: "b#authenticate" }),
        makeConcept({ name: "AuthConfig", kind: "interface", id: "c#AuthConfig" }),
      ];

      const result = engine.generateMappings(terms, concepts);
      const authMappings = result.mappings.filter((m) => m.termName === "Auth");

      for (let i = 1; i < authMappings.length; i++) {
        expect(authMappings[i - 1].confidence).toBeGreaterThanOrEqual(
          authMappings[i].confidence
        );
      }
    });
  });

  describe("mapping candidate structure", () => {
    it("includes all required fields in mapping candidates", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "UserService" })];
      const concepts = [makeConcept({ name: "UserService", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);

      expect(result.mappings.length).toBeGreaterThan(0);
      const candidate = result.mappings[0];

      expect(candidate).toHaveProperty("termName");
      expect(candidate).toHaveProperty("conceptId");
      expect(candidate).toHaveProperty("conceptName");
      expect(candidate).toHaveProperty("conceptKind");
      expect(candidate).toHaveProperty("filePath");
      expect(candidate).toHaveProperty("confidence");
      expect(candidate).toHaveProperty("matchStrategies");
      expect(candidate).toHaveProperty("suggestedRelationship");

      expect(typeof candidate.termName).toBe("string");
      expect(typeof candidate.conceptId).toBe("string");
      expect(typeof candidate.conceptName).toBe("string");
      expect(typeof candidate.confidence).toBe("number");
      expect(Array.isArray(candidate.matchStrategies)).toBe(true);
      expect(candidate.matchStrategies.length).toBeGreaterThan(0);
    });

    it("suggests appropriate relationship type based on concept kind", () => {
      const engine = new MappingEngine();

      // Class should suggest "defines"
      let result = engine.generateMappings(
        [makeTerm({ name: "AuthService" })],
        [makeConcept({ name: "AuthService", kind: "class" })]
      );
      let mapping = result.mappings[0];
      expect(mapping?.suggestedRelationship).toBe("defines");

      // Interface should suggest "defines"
      result = engine.generateMappings(
        [makeTerm({ name: "UserConfig" })],
        [makeConcept({ name: "UserConfig", kind: "interface" })]
      );
      mapping = result.mappings[0];
      expect(mapping?.suggestedRelationship).toBe("defines");

      // Function should suggest "implements"
      result = engine.generateMappings(
        [makeTerm({ name: "processPayment" })],
        [makeConcept({ name: "processPayment", kind: "function" })]
      );
      mapping = result.mappings[0];
      expect(mapping?.suggestedRelationship).toBe("implements");
    });
  });

  describe("multiple terms and concepts", () => {
    it("handles multiple terms mapped to different concepts", () => {
      const engine = new MappingEngine();
      const terms = [
        makeTerm({ name: "Auth Service", aliases: ["authentication"] }),
        makeTerm({ name: "User Profile" }),
        makeTerm({ name: "Billing" }),
      ];
      const concepts = [
        makeConcept({
          name: "AuthService",
          kind: "class",
          id: "src/auth/service.ts#AuthService",
          filePath: "src/auth/service.ts",
        }),
        makeConcept({
          name: "UserProfile",
          kind: "class",
          id: "src/user/profile.ts#UserProfile",
          filePath: "src/user/profile.ts",
        }),
        makeConcept({
          name: "BillingModule",
          kind: "module",
          id: "src/billing/index.ts",
          filePath: "src/billing/index.ts",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);

      expect(result.stats.termsProcessed).toBe(3);
      expect(result.mappings.length).toBeGreaterThan(0);

      // Each term should have at least one candidate mapping
      const authMappings = result.mappings.filter((m) => m.termName === "Auth Service");
      const profileMappings = result.mappings.filter((m) => m.termName === "User Profile");
      const billingMappings = result.mappings.filter((m) => m.termName === "Billing");

      expect(authMappings.length).toBeGreaterThan(0);
      expect(profileMappings.length).toBeGreaterThan(0);
      expect(billingMappings.length).toBeGreaterThan(0);

      // Auth should map to AuthService with high confidence
      expect(authMappings[0].conceptName).toBe("AuthService");
      expect(authMappings[0].confidence).toBeGreaterThan(0.5);

      // User Profile should map to UserProfile
      expect(profileMappings[0].conceptName).toBe("UserProfile");
    });
  });

  describe("edge cases", () => {
    it("handles terms with very short names", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "UI" })];
      const concepts = [
        makeConcept({ name: "UIComponent", kind: "class" }),
        makeConcept({ name: "setupUI", kind: "function" }),
      ];

      const result = engine.generateMappings(terms, concepts);
      // Should not crash, may or may not find matches
      expect(result.stats.termsProcessed).toBe(1);
    });

    it("handles concepts with no description", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "UserService" })];
      const concepts = [
        makeConcept({ name: "UserService", kind: "class", description: "" }),
      ];

      const result = engine.generateMappings(terms, concepts);
      expect(result.mappings.length).toBeGreaterThan(0);
    });

    it("handles terms with special characters in names", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "CI/CD Pipeline" })];
      const concepts = [
        makeConcept({ name: "CICDPipeline", kind: "class" }),
        makeConcept({
          name: "pipeline",
          kind: "module",
          filePath: "src/ci-cd/pipeline.ts",
        }),
      ];

      const result = engine.generateMappings(terms, concepts);
      expect(result.stats.termsProcessed).toBe(1);
    });

    it("deduplicates candidates for the same term-concept pair", () => {
      const engine = new MappingEngine();
      const terms = [makeTerm({ name: "AuthService", aliases: ["auth-service"] })];
      const concepts = [makeConcept({ name: "AuthService", kind: "class" })];

      const result = engine.generateMappings(terms, concepts);
      const uniquePairs = new Set(
        result.mappings.map((m) => `${m.termName}::${m.conceptId}`)
      );

      // Should not have duplicate term-concept pairs
      expect(uniquePairs.size).toBe(result.mappings.length);
    });
  });
});
