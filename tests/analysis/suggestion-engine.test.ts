/**
 * Tests for the Suggestion Generation Engine.
 *
 * Validates that generateSuggestions() correctly takes impact analysis
 * results and a term change description, then produces specific
 * modification suggestions with before/after snippets.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { analyzeImpact } from "../../src/analysis/impact-analysis.js";
import {
  generateSuggestions,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  toKebabCase,
  detectNamingConvention,
  transformName,
} from "../../src/analysis/suggestion-engine.js";
import type {
  ImpactAnalysisResult,
  AffectedFile,
  AffectedSymbol,
} from "../../src/analysis/impact-analysis.js";
import type {
  TermChangeDescription,
  SuggestionResult,
  SuggestionOptions,
  SuggestionKind,
} from "../../src/analysis/suggestion-engine.js";
import type { CodeLocation, CodeRelationship } from "../../src/models/glossary.js";

// ─── Test Helpers ───────────────────────────────────────────────────────

let tempDir: string;
let storage: JsonGlossaryStorage;

async function createTestStorage(): Promise<JsonGlossaryStorage> {
  tempDir = await mkdtemp(join(tmpdir(), "lingo-suggestion-test-"));
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
  },
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

/**
 * Creates a minimal ImpactAnalysisResult for testing without needing storage.
 */
function createMockImpactResult(
  query: string,
  affectedFiles: AffectedFile[],
  found = true,
): ImpactAnalysisResult {
  return {
    query,
    found,
    matchedTerms: found
      ? [
          {
            id: "term-1",
            name: query,
            definition: `Definition of ${query}`,
            confidence: "manual",
            codeLocationCount: affectedFiles.reduce(
              (sum, f) => sum + f.symbols.length,
              0,
            ),
          },
        ]
      : [],
    affectedFiles,
    summary: {
      totalMatchedTerms: found ? 1 : 0,
      totalAffectedFiles: affectedFiles.length,
      totalSymbols: affectedFiles.reduce(
        (sum, f) => sum + f.symbols.length,
        0,
      ),
      relationshipBreakdown: {},
      confidenceBreakdown: found ? { manual: 1 } : {},
    },
  };
}

function createAffectedFile(
  filePath: string,
  symbols: Array<{
    name: string;
    relationship: CodeRelationship;
    lineRange?: { start: number; end: number };
    note?: string;
  }>,
  termId = "term-1",
  termName = "Test Term",
): AffectedFile {
  return {
    filePath,
    symbols: symbols.map((s) => ({
      ...s,
      fromTermId: termId,
      fromTermName: termName,
    })),
    relationships: [...new Set(symbols.map((s) => s.relationship))],
    termIds: [termId],
    termNames: [termName],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("Suggestion Engine — Name Transformation Utilities", () => {
  describe("toCamelCase", () => {
    it("converts space-separated words", () => {
      expect(toCamelCase("Sprint Velocity")).toBe("sprintVelocity");
    });

    it("converts hyphen-separated words", () => {
      expect(toCamelCase("sprint-velocity")).toBe("sprintVelocity");
    });

    it("converts underscore-separated words", () => {
      expect(toCamelCase("sprint_velocity")).toBe("sprintVelocity");
    });

    it("handles single word", () => {
      expect(toCamelCase("Sprint")).toBe("sprint");
    });

    it("handles empty string", () => {
      expect(toCamelCase("")).toBe("");
    });

    it("handles multiple words", () => {
      expect(toCamelCase("User Auth Token")).toBe("userAuthToken");
    });
  });

  describe("toPascalCase", () => {
    it("converts space-separated words", () => {
      expect(toPascalCase("Sprint Velocity")).toBe("SprintVelocity");
    });

    it("handles single word", () => {
      expect(toPascalCase("sprint")).toBe("Sprint");
    });

    it("converts from kebab-case", () => {
      expect(toPascalCase("sprint-velocity")).toBe("SprintVelocity");
    });
  });

  describe("toSnakeCase", () => {
    it("converts space-separated words", () => {
      expect(toSnakeCase("Sprint Velocity")).toBe("sprint_velocity");
    });

    it("handles single word", () => {
      expect(toSnakeCase("Sprint")).toBe("sprint");
    });
  });

  describe("toKebabCase", () => {
    it("converts space-separated words", () => {
      expect(toKebabCase("Sprint Velocity")).toBe("sprint-velocity");
    });

    it("handles single word", () => {
      expect(toKebabCase("Sprint")).toBe("sprint");
    });
  });

  describe("detectNamingConvention", () => {
    it("detects camelCase", () => {
      expect(detectNamingConvention("sprintVelocity")).toBe("camelCase");
    });

    it("detects PascalCase", () => {
      expect(detectNamingConvention("SprintVelocity")).toBe("PascalCase");
    });

    it("detects snake_case", () => {
      expect(detectNamingConvention("sprint_velocity")).toBe("snake_case");
    });

    it("detects kebab-case", () => {
      expect(detectNamingConvention("sprint-velocity")).toBe("kebab-case");
    });

    it("returns unknown for simple lowercase", () => {
      expect(detectNamingConvention("sprint")).toBe("unknown");
    });
  });

  describe("transformName", () => {
    it("transforms to detected convention", () => {
      expect(transformName("Sprint Velocity", "camelCase")).toBe("sprintVelocity");
      expect(transformName("Sprint Velocity", "PascalCase")).toBe("SprintVelocity");
      expect(transformName("Sprint Velocity", "snake_case")).toBe("sprint_velocity");
      expect(transformName("Sprint Velocity", "kebab-case")).toBe("sprint-velocity");
    });

    it("defaults to camelCase for unknown convention", () => {
      expect(transformName("Sprint Velocity", "unknown")).toBe("sprintVelocity");
    });
  });
});

describe("Suggestion Engine — generateSuggestions", () => {
  describe("empty / no-match scenarios", () => {
    it("returns empty result when impact analysis found nothing", () => {
      const impact = createMockImpactResult("nonexistent", [], false);
      const change: TermChangeDescription = {
        type: "rename",
        oldName: "nonexistent",
        newName: "something",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      expect(result.hasSuggestions).toBe(false);
      expect(result.suggestions).toEqual([]);
      expect(result.summary.totalSuggestions).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("returns empty result when impact found terms but no affected files", () => {
      const impact: ImpactAnalysisResult = {
        query: "orphan term",
        found: true,
        matchedTerms: [
          {
            id: "t1",
            name: "Orphan Term",
            definition: "A term with no code locations",
            confidence: "manual",
            codeLocationCount: 0,
          },
        ],
        affectedFiles: [],
        summary: {
          totalMatchedTerms: 1,
          totalAffectedFiles: 0,
          totalSymbols: 0,
          relationshipBreakdown: {},
          confidenceBreakdown: { manual: 1 },
        },
      };

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Orphan Term",
        newName: "New Name",
        description: "Renaming orphan",
      };

      const result = generateSuggestions(impact, change);

      expect(result.hasSuggestions).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("rename change type", () => {
    it("generates symbol-rename suggestions for defining symbols", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "Aligning with SAFe terminology",
      };

      const result = generateSuggestions(impact, change);

      expect(result.hasSuggestions).toBe(true);

      // Should have a critical symbol-rename suggestion
      const renames = result.suggestions.filter(
        (s) => s.kind === "symbol-rename",
      );
      expect(renames.length).toBeGreaterThan(0);

      const primaryRename = renames.find((s) => s.priority === "critical");
      expect(primaryRename).toBeDefined();
      expect(primaryRename!.before).toBe("SprintVelocity");
      expect(primaryRename!.after).toBe("IterationThroughput");
      expect(primaryRename!.autoApplicable).toBe(true);
    });

    it("preserves naming convention when generating rename suggestions", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "calculateSprintVelocity", relationship: "implements" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const rename = result.suggestions.find(
        (s) => s.kind === "symbol-rename",
      );
      expect(rename).toBeDefined();
      // camelCase symbol should produce camelCase suggestion
      expect(rename!.after).toBe("iterationThroughput");
    });

    it("generates comment-update suggestions alongside renames", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const commentUpdates = result.suggestions.filter(
        (s) => s.kind === "comment-update",
      );
      expect(commentUpdates.length).toBeGreaterThan(0);
      expect(commentUpdates[0].before).toContain("Sprint Velocity");
      expect(commentUpdates[0].after).toContain("Iteration Throughput");
    });

    it("generates test-update suggestions for test files", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("tests/velocity.test.ts", [
          { name: "velocityTests", relationship: "tests" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const testUpdates = result.suggestions.filter(
        (s) => s.kind === "test-update",
      );
      expect(testUpdates.length).toBeGreaterThan(0);
    });

    it("generates config-update suggestions for config relationships", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("config/metrics.json", [
          { name: "sprintVelocityConfig", relationship: "configures" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const configUpdates = result.suggestions.filter(
        (s) => s.kind === "config-update",
      );
      expect(configUpdates.length).toBeGreaterThan(0);
    });

    it("generates file-rename suggestions when filename contains term", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/sprint-velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const fileRenames = result.suggestions.filter(
        (s) => s.kind === "file-rename",
      );
      expect(fileRenames.length).toBeGreaterThan(0);
      expect(fileRenames[0].before).toContain("sprint-velocity");
      expect(fileRenames[0].after).toContain("iteration-throughput");
    });

    it("generates import-update suggestions when file is renamed", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/sprint-velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const importUpdates = result.suggestions.filter(
        (s) => s.kind === "import-update",
      );
      expect(importUpdates.length).toBeGreaterThan(0);
    });

    it("handles file-level references in rename", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("docs/sprint-velocity.md", [
          { name: "(file-level)", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      expect(result.hasSuggestions).toBe(true);
      const commentUpdate = result.suggestions.find(
        (s) => s.kind === "comment-update",
      );
      expect(commentUpdate).toBeDefined();
      expect(commentUpdate!.before).toContain("Sprint Velocity");
      expect(commentUpdate!.after).toContain("Iteration Throughput");
    });

    it("generates usage-site rename suggestions at lower priority", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/dashboard.ts", [
          { name: "sprintVelocityWidget", relationship: "uses" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const usageRename = result.suggestions.find(
        (s) => s.kind === "symbol-rename" && s.relationship === "uses",
      );
      expect(usageRename).toBeDefined();
      expect(usageRename!.priority).toBe("recommended");
    });
  });

  describe("redefine change type", () => {
    it("generates comment-update suggestions for all affected locations", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
          { name: "calculateVelocity", relationship: "implements" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "redefine",
        oldName: "Sprint Velocity",
        description: "Now measures story points per week instead of per sprint",
        newDefinition: "The rate of story points completed per week",
      };

      const result = generateSuggestions(impact, change);

      expect(result.hasSuggestions).toBe(true);

      const commentUpdates = result.suggestions.filter(
        (s) => s.kind === "comment-update",
      );
      expect(commentUpdates.length).toBeGreaterThan(0);
    });

    it("marks defining locations as critical priority for redefine", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "redefine",
        oldName: "Sprint Velocity",
        description: "Definition changed",
        newDefinition: "New definition",
      };

      const result = generateSuggestions(impact, change);

      const definingComment = result.suggestions.find(
        (s) => s.kind === "comment-update" && s.relationship === "defines",
      );
      expect(definingComment).toBeDefined();
      expect(definingComment!.priority).toBe("critical");
    });

    it("generates structural-refactor suggestions for implementations", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "redefine",
        oldName: "Sprint Velocity",
        description: "Fundamental change in how velocity is calculated",
        newDefinition: "New velocity calculation method",
      };

      const result = generateSuggestions(impact, change);

      const structuralSuggestions = result.suggestions.filter(
        (s) => s.kind === "structural-refactor",
      );
      expect(structuralSuggestions.length).toBeGreaterThan(0);
    });
  });

  describe("deprecate change type", () => {
    it("generates deprecation-marker suggestions for defining symbols", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "deprecate",
        oldName: "Sprint Velocity",
        description: "Replaced by Flow Metrics in v3",
      };

      const result = generateSuggestions(impact, change);

      const deprecations = result.suggestions.filter(
        (s) => s.kind === "deprecation-marker",
      );
      expect(deprecations.length).toBeGreaterThan(0);
      expect(deprecations[0].priority).toBe("critical");
      expect(deprecations[0].after).toContain("@deprecated");
    });

    it("generates TODO comments for usage sites of deprecated terms", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/dashboard.ts", [
          { name: "velocityWidget", relationship: "uses" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "deprecate",
        oldName: "Sprint Velocity",
        description: "Replaced by Flow Metrics",
      };

      const result = generateSuggestions(impact, change);

      const usageSuggestions = result.suggestions.filter(
        (s) => s.relationship === "uses",
      );
      expect(usageSuggestions.length).toBeGreaterThan(0);
      expect(usageSuggestions[0].after).toContain("TODO");
      expect(usageSuggestions[0].after).toContain("deprecated");
    });

    it("generates test-update suggestions for deprecation", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("tests/velocity.test.ts", [
          { name: "velocityTests", relationship: "tests" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "deprecate",
        oldName: "Sprint Velocity",
        description: "Being replaced",
      };

      const result = generateSuggestions(impact, change);

      const testSuggestions = result.suggestions.filter(
        (s) => s.kind === "test-update",
      );
      expect(testSuggestions.length).toBeGreaterThan(0);
      expect(testSuggestions[0].after).toContain("deprecated");
    });
  });

  describe("split change type", () => {
    it("generates structural-refactor suggestions for defining symbols", () => {
      const impact = createMockImpactResult("User Management", [
        createAffectedFile("src/user/manager.ts", [
          { name: "UserManager", relationship: "defines" },
        ], "t1", "User Management"),
      ]);

      const change: TermChangeDescription = {
        type: "split",
        oldName: "User Management",
        description: "Splitting into distinct auth and profile concerns",
        splitInto: ["User Authentication", "User Profile"],
      };

      const result = generateSuggestions(impact, change);

      const structural = result.suggestions.filter(
        (s) => s.kind === "structural-refactor",
      );
      expect(structural.length).toBeGreaterThan(0);
      expect(structural[0].priority).toBe("critical");
      expect(structural[0].after).toContain("UserAuthentication");
      expect(structural[0].after).toContain("UserProfile");
    });

    it("generates review suggestions for usage sites in splits", () => {
      const impact = createMockImpactResult("User Management", [
        createAffectedFile("src/api/routes.ts", [
          { name: "userRoutes", relationship: "uses" },
        ], "t1", "User Management"),
      ]);

      const change: TermChangeDescription = {
        type: "split",
        oldName: "User Management",
        description: "Splitting into auth and profile",
        splitInto: ["User Auth", "User Profile"],
      };

      const result = generateSuggestions(impact, change);

      const reviews = result.suggestions.filter(
        (s) => s.kind === "comment-update" && s.relationship === "uses",
      );
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews[0].after).toContain("TODO");
    });
  });

  describe("merge change type", () => {
    it("generates consolidation suggestions for defining symbols", () => {
      const impact = createMockImpactResult("Auth", [
        createAffectedFile("src/auth/login.ts", [
          { name: "LoginService", relationship: "defines" },
        ], "t1", "Login Auth"),
      ]);

      const change: TermChangeDescription = {
        type: "merge",
        oldName: "Login Auth",
        newName: "Authentication Service",
        description: "Consolidating login and session management",
        mergeFrom: ["Login Auth", "Session Manager"],
      };

      const result = generateSuggestions(impact, change);

      const structural = result.suggestions.filter(
        (s) => s.kind === "structural-refactor",
      );
      expect(structural.length).toBeGreaterThan(0);
      expect(structural[0].priority).toBe("critical");
      expect(structural[0].after).toContain("AuthenticationService");
    });

    it("generates reference-update suggestions for non-defining relationships", () => {
      const impact = createMockImpactResult("Auth", [
        createAffectedFile("src/api/middleware.ts", [
          { name: "authMiddleware", relationship: "uses" },
        ], "t1", "Login Auth"),
      ]);

      const change: TermChangeDescription = {
        type: "merge",
        oldName: "Login Auth",
        newName: "Authentication Service",
        description: "Consolidating",
        mergeFrom: ["Login Auth", "Session Manager"],
      };

      const result = generateSuggestions(impact, change);

      const refUpdates = result.suggestions.filter(
        (s) => s.relationship === "uses",
      );
      expect(refUpdates.length).toBeGreaterThan(0);
    });
  });

  describe("relocate change type", () => {
    it("generates move suggestions for defining symbols", () => {
      const impact = createMockImpactResult("Auth Service", [
        createAffectedFile("src/legacy/auth.ts", [
          { name: "AuthService", relationship: "defines" },
        ], "t1", "Auth Service"),
      ]);

      const change: TermChangeDescription = {
        type: "relocate",
        oldName: "Auth Service",
        description: "Moving auth to new module structure",
        newLocation: "src/modules/auth/service.ts",
      };

      const result = generateSuggestions(impact, change);

      const structural = result.suggestions.filter(
        (s) => s.kind === "structural-refactor",
      );
      expect(structural.length).toBeGreaterThan(0);
      expect(structural[0].priority).toBe("critical");
      expect(structural[0].after).toContain("src/modules/auth/service.ts");
    });

    it("generates import-update suggestions for usage sites", () => {
      const impact = createMockImpactResult("Auth Service", [
        createAffectedFile("src/api/routes.ts", [
          { name: "authRoutes", relationship: "uses" },
        ], "t1", "Auth Service"),
      ]);

      const change: TermChangeDescription = {
        type: "relocate",
        oldName: "Auth Service",
        description: "Moving auth to new location",
        newLocation: "src/modules/auth/service.ts",
      };

      const result = generateSuggestions(impact, change);

      const importUpdates = result.suggestions.filter(
        (s) => s.kind === "import-update",
      );
      expect(importUpdates.length).toBeGreaterThan(0);
      expect(importUpdates[0].priority).toBe("critical");
    });

    it("generates comment-update suggestions for other relationships", () => {
      const impact = createMockImpactResult("Auth Service", [
        createAffectedFile("tests/auth.test.ts", [
          { name: "authTests", relationship: "tests" },
        ], "t1", "Auth Service"),
      ]);

      const change: TermChangeDescription = {
        type: "relocate",
        oldName: "Auth Service",
        description: "Moving auth",
        newLocation: "src/modules/auth/service.ts",
      };

      const result = generateSuggestions(impact, change);

      const comments = result.suggestions.filter(
        (s) => s.kind === "comment-update",
      );
      expect(comments.length).toBeGreaterThan(0);
    });
  });

  describe("options — filtering", () => {
    it("filters by suggestion kind", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        kinds: ["symbol-rename"],
      });

      // All suggestions should be symbol-rename
      for (const s of result.suggestions) {
        expect(s.kind).toBe("symbol-rename");
      }
    });

    it("filters by minimum priority", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        minPriority: "critical",
      });

      // All suggestions should be critical
      for (const s of result.suggestions) {
        expect(s.priority).toBe("critical");
      }
    });

    it("excludes test files when includeTests=false", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
        createAffectedFile("tests/velocity.test.ts", [
          { name: "velocityTests", relationship: "tests" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        includeTests: false,
      });

      // No suggestions should reference test files
      const testSuggestions = result.suggestions.filter(
        (s) => s.filePath.includes("test"),
      );
      expect(testSuggestions).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes("test"))).toBe(true);
    });

    it("excludes config files when includeConfigs=false", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
        createAffectedFile("config/metrics.json", [
          { name: "metricsConfig", relationship: "configures" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        includeConfigs: false,
      });

      // No suggestions should have relationship "configures"
      const configSuggestions = result.suggestions.filter(
        (s) => s.kind === "config-update",
      );
      expect(configSuggestions).toHaveLength(0);
    });
  });

  describe("options — limits", () => {
    it("respects maxSuggestionsPerFile", () => {
      const impact = createMockImpactResult("Auth", [
        createAffectedFile("src/auth/service.ts", [
          { name: "AuthService", relationship: "defines" },
          { name: "validateCredentials", relationship: "implements" },
          { name: "hashPassword", relationship: "implements" },
          { name: "generateToken", relationship: "implements" },
        ], "t1", "Auth"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Auth",
        newName: "Authentication",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        maxSuggestionsPerFile: 2,
      });

      // Count suggestions per file
      const perFile = new Map<string, number>();
      for (const s of result.suggestions) {
        perFile.set(s.filePath, (perFile.get(s.filePath) ?? 0) + 1);
      }

      for (const [_, count] of perFile) {
        expect(count).toBeLessThanOrEqual(2);
      }
    });

    it("respects maxTotalSuggestions", () => {
      const impact = createMockImpactResult("Auth", [
        createAffectedFile("src/auth/service.ts", [
          { name: "AuthService", relationship: "defines" },
          { name: "validateCredentials", relationship: "implements" },
        ], "t1", "Auth"),
        createAffectedFile("src/auth/token.ts", [
          { name: "TokenManager", relationship: "defines" },
          { name: "refreshToken", relationship: "implements" },
        ], "t1", "Auth"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Auth",
        newName: "Authentication",
        description: "test",
      };

      const result = generateSuggestions(impact, change, {
        maxTotalSuggestions: 3,
      });

      expect(result.suggestions.length).toBeLessThanOrEqual(3);
      expect(result.warnings.some((w) => w.includes("Truncated"))).toBe(true);
    });
  });

  describe("sorting and priority", () => {
    it("sorts suggestions by priority (critical first)", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
          { name: "displayVelocity", relationship: "uses" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      // Check that critical suggestions come before recommended and optional
      let lastPriorityRank = Infinity;
      const RANK: Record<string, number> = {
        critical: 2,
        recommended: 1,
        optional: 0,
      };

      for (const s of result.suggestions) {
        const rank = RANK[s.priority];
        expect(rank).toBeLessThanOrEqual(lastPriorityRank);
        if (rank < lastPriorityRank) {
          lastPriorityRank = rank;
        }
      }
    });
  });

  describe("summary statistics", () => {
    it("correctly counts byKind breakdown", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      // Verify byKind adds up to totalSuggestions
      const kindTotal = Object.values(result.summary.byKind).reduce(
        (sum, n) => sum + (n ?? 0),
        0,
      );
      expect(kindTotal).toBe(result.summary.totalSuggestions);
    });

    it("correctly counts byPriority breakdown", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const priorityTotal = Object.values(result.summary.byPriority).reduce(
        (sum, n) => sum + (n ?? 0),
        0,
      );
      expect(priorityTotal).toBe(result.summary.totalSuggestions);
    });

    it("correctly counts autoApplicableCount", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const actualAutoApplicable = result.suggestions.filter(
        (s) => s.autoApplicable,
      ).length;
      expect(result.summary.autoApplicableCount).toBe(actualAutoApplicable);
    });

    it("correctly counts filesAffected", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
        createAffectedFile("src/dashboard.ts", [
          { name: "velocityWidget", relationship: "uses" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      // Should have at least 2 files affected
      expect(result.summary.filesAffected).toBeGreaterThanOrEqual(2);
    });
  });

  describe("suggestion metadata", () => {
    it("includes fromTermId and fromTermName on every suggestion", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile(
          "src/metrics/velocity.ts",
          [{ name: "SprintVelocity", relationship: "defines" }],
          "term-abc",
          "Sprint Velocity",
        ),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      for (const s of result.suggestions) {
        expect(s.fromTermId).toBe("term-abc");
        expect(s.fromTermName).toBe("Sprint Velocity");
      }
    });

    it("includes the change description in the result", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "Aligning with SAFe terminology",
      };

      const result = generateSuggestions(impact, change);

      expect(result.change).toBe(change);
      expect(result.query).toBe("Sprint Velocity");
    });

    it("assigns unique IDs to every suggestion", () => {
      const impact = createMockImpactResult("Sprint Velocity", [
        createAffectedFile("src/metrics/velocity.ts", [
          { name: "SprintVelocity", relationship: "defines" },
          { name: "calculateVelocity", relationship: "implements" },
        ], "t1", "Sprint Velocity"),
      ]);

      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "test",
      };

      const result = generateSuggestions(impact, change);

      const ids = result.suggestions.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("integration with real storage", () => {
    beforeEach(async () => {
      storage = await createTestStorage();
    });

    afterEach(async () => {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("works end-to-end: addTerm → analyzeImpact → generateSuggestions", async () => {
      // Set up a realistic term
      await addTestTerm(storage, {
        name: "Sprint Velocity",
        definition: "The rate of story points completed per sprint",
        aliases: ["velocity", "SV"],
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "SprintVelocity",
            relationship: "defines",
            lineRange: { start: 10, end: 50 },
          },
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "implements",
            lineRange: { start: 52, end: 80 },
          },
          {
            filePath: "src/dashboard/sprint-widget.ts",
            symbol: "SprintWidget",
            relationship: "uses",
          },
          {
            filePath: "tests/metrics/velocity.test.ts",
            symbol: "velocityTests",
            relationship: "tests",
          },
        ],
      });

      // Run impact analysis
      const impact = analyzeImpact(storage, "Sprint Velocity");
      expect(impact.found).toBe(true);
      expect(impact.affectedFiles.length).toBeGreaterThan(0);

      // Generate suggestions for a rename
      const change: TermChangeDescription = {
        type: "rename",
        oldName: "Sprint Velocity",
        newName: "Iteration Throughput",
        description: "Aligning with SAFe terminology across the organization",
      };

      const result = generateSuggestions(impact, change);

      // Validate the full pipeline produced meaningful results
      expect(result.hasSuggestions).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.summary.totalSuggestions).toBeGreaterThan(0);
      expect(result.summary.filesAffected).toBeGreaterThanOrEqual(2);

      // Should have critical suggestions for the defining symbol
      const criticalSuggestions = result.suggestions.filter(
        (s) => s.priority === "critical",
      );
      expect(criticalSuggestions.length).toBeGreaterThan(0);

      // Should have symbol renames
      const renames = result.suggestions.filter(
        (s) => s.kind === "symbol-rename",
      );
      expect(renames.length).toBeGreaterThan(0);

      // Should have test-related suggestions
      const testSuggestions = result.suggestions.filter(
        (s) => s.kind === "test-update",
      );
      expect(testSuggestions.length).toBeGreaterThan(0);
    });

    it("handles deprecation end-to-end", async () => {
      await addTestTerm(storage, {
        name: "Legacy Auth",
        definition: "Old authentication system",
        codeLocations: [
          {
            filePath: "src/auth/legacy.ts",
            symbol: "LegacyAuth",
            relationship: "defines",
          },
          {
            filePath: "src/api/middleware.ts",
            symbol: "authMiddleware",
            relationship: "uses",
          },
        ],
      });

      const impact = analyzeImpact(storage, "Legacy Auth");
      const result = generateSuggestions(impact, {
        type: "deprecate",
        oldName: "Legacy Auth",
        description: "Replaced by OAuth2 integration in v3.0",
      });

      expect(result.hasSuggestions).toBe(true);

      // Should have deprecation markers for the defining symbol
      const deprecationMarkers = result.suggestions.filter(
        (s) => s.kind === "deprecation-marker",
      );
      expect(deprecationMarkers.length).toBeGreaterThan(0);

      // Should have TODO comments for usage sites
      const usageSuggestions = result.suggestions.filter(
        (s) => s.relationship === "uses",
      );
      expect(usageSuggestions.length).toBeGreaterThan(0);
    });
  });
});
