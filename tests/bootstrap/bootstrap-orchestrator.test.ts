/**
 * Tests for the Bootstrap Orchestrator.
 *
 * Verifies that the orchestrator correctly wires together the codebase scanner,
 * PM adapter, and mapping engine, persists results to storage, and returns
 * comprehensive summaries.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BootstrapOrchestrator } from "../../src/bootstrap/bootstrap-orchestrator.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { CodebaseScanner } from "../../src/scanner/index.js";
import { MappingEngine } from "../../src/mapping/index.js";
import type { PMAdapter, NormalizedTerm, ExtractionResult } from "../../src/adapters/types.js";
import type { CodeConcept, ScanResult } from "../../src/types/index.js";
import type { GlossaryTerm } from "../../src/models/glossary.js";

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeScanResult(concepts: CodeConcept[]): ScanResult {
  return {
    rootDir: "/test/project",
    scannedAt: new Date().toISOString(),
    concepts,
    stats: {
      filesDiscovered: 5,
      filesParsed: 3,
      filesSkipped: 2,
      conceptsExtracted: concepts.length,
      conceptsByKind: {
        module: 0, class: 0, function: 0, interface: 0,
        enum: 0, constant: 0, directory: 0, namespace: 0,
      },
      conceptsByLanguage: {
        typescript: concepts.length, javascript: 0, python: 0, unknown: 0,
      },
      durationMs: 42,
    },
    diagnostics: [],
  };
}

function makeConcept(overrides: Partial<CodeConcept> = {}): CodeConcept {
  return {
    id: overrides.id ?? "src/auth/AuthService.ts:AuthService",
    name: overrides.name ?? "AuthService",
    kind: overrides.kind ?? "class",
    filePath: overrides.filePath ?? "src/auth/AuthService.ts",
    line: overrides.line ?? 10,
    description: overrides.description ?? "Handles user authentication and session management",
    exported: overrides.exported ?? true,
    language: overrides.language ?? "typescript",
    metadata: overrides.metadata ?? {},
    ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
  };
}

function makeNormalizedTerm(overrides: Partial<NormalizedTerm> = {}): NormalizedTerm {
  return {
    name: overrides.name ?? "Auth Service",
    definition: overrides.definition ?? "Handles user authentication",
    aliases: overrides.aliases ?? ["AuthService"],
    category: overrides.category ?? "authentication",
    tags: overrides.tags ?? ["feature", "notion"],
    source: overrides.source ?? { adapter: "notion", externalId: "notion-123" },
    confidence: overrides.confidence ?? "ai-suggested",
  };
}

function makeExtractionResult(terms: NormalizedTerm[]): ExtractionResult {
  return {
    adapterName: "notion",
    extractedAt: new Date().toISOString(),
    terms,
    stats: {
      itemsFetched: terms.length + 2,
      termsProduced: terms.length,
      itemsSkipped: 2,
      durationMs: 100,
      itemsByType: { feature: terms.length },
    },
    warnings: [],
  };
}

function createMockAdapter(terms: NormalizedTerm[]): PMAdapter {
  return {
    name: "notion",
    displayName: "Notion",
    testConnection: vi.fn().mockResolvedValue({
      connected: true,
      message: "Connected",
    }),
    extractItems: vi.fn().mockResolvedValue([]),
    normalizeToTerms: vi.fn().mockReturnValue(terms),
    extract: vi.fn().mockResolvedValue(makeExtractionResult(terms)),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("BootstrapOrchestrator", () => {
  let storage: JsonGlossaryStorage;
  let adapterRegistry: AdapterRegistry;
  let scanner: CodebaseScanner;
  let mappingEngine: MappingEngine;

  const sampleConcepts: CodeConcept[] = [
    makeConcept({
      id: "src/auth/AuthService.ts:AuthService",
      name: "AuthService",
      kind: "class",
      filePath: "src/auth/AuthService.ts",
      description: "Handles user authentication and session management",
      exported: true,
    }),
    makeConcept({
      id: "src/billing/BillingEngine.ts:BillingEngine",
      name: "BillingEngine",
      kind: "class",
      filePath: "src/billing/BillingEngine.ts",
      description: "Processes billing calculations and invoices",
      exported: true,
    }),
    makeConcept({
      id: "src/billing/BillingEngine.ts:calculateTotal",
      name: "calculateTotal",
      kind: "function",
      filePath: "src/billing/BillingEngine.ts",
      description: "Calculates the total amount for an invoice",
      exported: true,
    }),
    makeConcept({
      id: "src/models/User.ts:User",
      name: "User",
      kind: "interface",
      filePath: "src/models/User.ts",
      description: "User data model interface",
      exported: true,
    }),
  ];

  beforeEach(async () => {
    // Create a fresh in-memory-ish storage for each test
    storage = new JsonGlossaryStorage("/tmp/test-bootstrap-glossary.json");
    // Pre-load the store to avoid file system side effects during tests
    vi.spyOn(storage, "load").mockResolvedValue({
      version: "1.0.0",
      organization: "test-org",
      lastModified: new Date().toISOString(),
      terms: {},
    });

    // Mock addTerm to track what gets persisted
    let termCounter = 0;
    vi.spyOn(storage, "addTerm").mockImplementation(async (params) => {
      termCounter++;
      const term: GlossaryTerm = {
        id: `test-term-${termCounter}`,
        name: params.name,
        definition: params.definition,
        aliases: params.aliases ?? [],
        codeLocations: params.codeLocations ?? [],
        category: params.category,
        tags: params.tags ?? [],
        source: params.source ?? { adapter: "manual" },
        confidence: params.confidence ?? "manual",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return term;
    });

    adapterRegistry = new AdapterRegistry();

    // Mock scanner
    scanner = new CodebaseScanner();
    vi.spyOn(scanner, "scan").mockResolvedValue(makeScanResult(sampleConcepts));

    // Use real mapping engine
    mappingEngine = new MappingEngine();
  });

  describe("run() with codebase-only (no PM adapter)", () => {
    it("should scan codebase and infer terms from code concepts", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
      });

      // Should have scanned the codebase
      expect(scanner.scan).toHaveBeenCalledWith(
        expect.objectContaining({ rootDir: "/test/project" }),
      );

      // Should have inferred terms (at least the classes and interface)
      expect(summary.termSource).toBe("codebase-inferred");
      expect(summary.termsCreated).toBeGreaterThan(0);
      expect(summary.persisted).toBe(true);

      // Scan stats should be populated
      expect(summary.scan.filesScanned).toBe(3);
      expect(summary.scan.conceptsFound).toBe(sampleConcepts.length);

      // No PM extraction stats
      expect(summary.extraction).toBeUndefined();

      // Should have term previews
      expect(summary.terms.length).toBeGreaterThan(0);
      for (const term of summary.terms) {
        expect(term.name).toBeTruthy();
        expect(term.definition).toBeTruthy();
        expect(term.id).toBeTruthy(); // Has an ID because it was persisted
      }
    });

    it("should persist terms with ai-suggested confidence", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await orchestrator.run({ rootDir: "/test/project" });

      // Every addTerm call should have confidence: "ai-suggested"
      const addTermCalls = vi.mocked(storage.addTerm).mock.calls;
      expect(addTermCalls.length).toBeGreaterThan(0);

      for (const [params] of addTermCalls) {
        expect(params.confidence).toBe("ai-suggested");
        expect(params.tags).toContain("bootstrap");
      }
    });

    it("should include code locations from mapping engine", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await orchestrator.run({ rootDir: "/test/project" });

      const addTermCalls = vi.mocked(storage.addTerm).mock.calls;

      // At least some terms should have code locations (the mapping engine
      // will produce exact matches for things like AuthService ↔ AuthService class)
      const termsWithLocations = addTermCalls.filter(
        ([params]) => params.codeLocations && params.codeLocations.length > 0,
      );
      expect(termsWithLocations.length).toBeGreaterThan(0);
    });
  });

  describe("run() with PM adapter", () => {
    it("should extract terms from PM adapter and map to code", async () => {
      const pmTerms: NormalizedTerm[] = [
        makeNormalizedTerm({
          name: "Auth Service",
          definition: "Handles user authentication and session management",
          aliases: ["AuthService", "authentication"],
        }),
        makeNormalizedTerm({
          name: "Billing Engine",
          definition: "Processes billing calculations and invoices",
          aliases: ["BillingEngine"],
        }),
      ];

      const mockAdapter = createMockAdapter(pmTerms);
      adapterRegistry.register(mockAdapter);

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "notion",
      });

      // Should use PM adapter as term source
      expect(summary.termSource).toBe("pm-adapter");
      expect(summary.adapterName).toBe("notion");

      // Should have extraction stats
      expect(summary.extraction).toBeDefined();
      expect(summary.extraction!.termsExtracted).toBe(2);

      // Should have created terms
      expect(summary.termsCreated).toBe(2);
      expect(summary.persisted).toBe(true);

      // Should have called the adapter's extract method
      expect(mockAdapter.extract).toHaveBeenCalled();
    });

    it("should fall back to codebase-inferred when adapter is not found", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "nonexistent-adapter",
      });

      // Should fall back to code inference
      expect(summary.termSource).toBe("codebase-inferred");
      expect(summary.warnings).toContainEqual(
        expect.stringContaining("not found in registry"),
      );
    });

    it("should fall back to codebase-inferred when adapter returns no terms", async () => {
      const mockAdapter = createMockAdapter([]); // No terms
      adapterRegistry.register(mockAdapter);

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "notion",
      });

      expect(summary.termSource).toBe("codebase-inferred");
      expect(summary.warnings).toContainEqual(
        expect.stringContaining("returned no terms"),
      );
    });

    it("should pass adapter options through to the adapter", async () => {
      const pmTerms = [makeNormalizedTerm()];
      const mockAdapter = createMockAdapter(pmTerms);
      adapterRegistry.register(mockAdapter);

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "notion",
        adapterOptions: {
          projectId: "db-123",
          maxItems: 50,
        },
      });

      expect(mockAdapter.extract).toHaveBeenCalledWith(
        expect.objectContaining({
          project: "db-123",
          maxItems: 50,
        }),
      );
    });
  });

  describe("dry run mode", () => {
    it("should not persist terms when dryRun is true", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        dryRun: true,
      });

      // Should NOT call addTerm
      expect(storage.addTerm).not.toHaveBeenCalled();

      // Should still return term previews
      expect(summary.terms.length).toBeGreaterThan(0);
      expect(summary.persisted).toBe(false);
      expect(summary.termsCreated).toBe(0);
      expect(summary.mappingsCreated).toBe(0);

      // Preview terms should NOT have IDs (not persisted)
      for (const term of summary.terms) {
        expect(term.id).toBeUndefined();
      }
    });

    it("should still compute mappings in dry run for preview", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        dryRun: true,
      });

      // Mapping stats should still be populated
      expect(summary.mapping.termsProcessed).toBeGreaterThan(0);
    });
  });

  describe("summary structure", () => {
    it("should include comprehensive timing information", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
      });

      expect(summary.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(summary.scan.durationMs).toBeGreaterThanOrEqual(0);
      expect(summary.mapping.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should include mapping engine statistics", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
      });

      expect(summary.mapping).toEqual(
        expect.objectContaining({
          termsProcessed: expect.any(Number),
          candidatesGenerated: expect.any(Number),
          candidatesAboveThreshold: expect.any(Number),
          durationMs: expect.any(Number),
        }),
      );
    });

    it("should report total mappings created", async () => {
      const pmTerms: NormalizedTerm[] = [
        makeNormalizedTerm({
          name: "Auth Service",
          aliases: ["AuthService"],
        }),
      ];
      const mockAdapter = createMockAdapter(pmTerms);
      adapterRegistry.register(mockAdapter);

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "notion",
      });

      // "Auth Service" should match "AuthService" class concept
      // So mappingsCreated should be >= 1
      expect(summary.mappingsCreated).toBeGreaterThanOrEqual(1);
    });
  });

  describe("inferTermsFromCode()", () => {
    it("should create terms from exported classes", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "AuthService",
          kind: "class",
          exported: true,
        }),
      ]);

      expect(terms.length).toBe(1);
      expect(terms[0].name).toBe("Auth Service");
      expect(terms[0].confidence).toBe("ai-suggested");
      expect(terms[0].source.adapter).toBe("bootstrap");
    });

    it("should create terms from exported interfaces", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "UserProfile",
          kind: "interface",
          exported: true,
        }),
      ]);

      expect(terms.length).toBe(1);
      expect(terms[0].name).toBe("User Profile");
    });

    it("should skip non-exported classes", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "InternalHelper",
          kind: "class",
          exported: false,
        }),
      ]);

      expect(terms.length).toBe(0);
    });

    it("should skip generic module names like index", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "index",
          kind: "module",
          exported: true,
        }),
      ]);

      expect(terms.length).toBe(0);
    });

    it("should deduplicate terms by normalized name", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          id: "a",
          name: "AuthService",
          kind: "class",
          exported: true,
        }),
        makeConcept({
          id: "b",
          name: "authService",
          kind: "function",
          exported: true,
        }),
      ]);

      // Should only have one term (class takes priority)
      expect(terms.length).toBe(1);
      expect(terms[0].name).toBe("Auth Service");
    });

    it("should infer category from file path", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "AuthService",
          kind: "class",
          filePath: "src/auth/AuthService.ts",
          exported: true,
        }),
      ]);

      expect(terms[0].category).toBe("auth");
    });

    it("should generate abbreviation aliases for multi-word names", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "BillingEngine",
          kind: "class",
          exported: true,
        }),
      ]);

      // "Billing Engine" should have "BE" as an alias
      expect(terms[0].aliases).toContain("BE");
    });

    it("should tag inferred terms with bootstrap", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "AuthService",
          kind: "class",
          exported: true,
        }),
      ]);

      expect(terms[0].tags).toContain("bootstrap");
      expect(terms[0].tags).toContain("class");
      expect(terms[0].tags).toContain("typescript");
    });

    it("should skip short function names", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "fn",
          kind: "function",
          exported: true,
        }),
      ]);

      expect(terms.length).toBe(0);
    });

    it("should skip generic directory names", () => {
      const orchestrator = new BootstrapOrchestrator({
        storage,
      });

      const terms = orchestrator.inferTermsFromCode([
        makeConcept({
          name: "utils",
          kind: "directory",
          filePath: "src/utils",
          exported: true,
        }),
        makeConcept({
          name: "billing",
          kind: "directory",
          filePath: "src/billing",
          exported: true,
        }),
      ]);

      // "utils" should be skipped, "billing" should be kept
      expect(terms.length).toBe(1);
      expect(terms[0].name).toBe("Billing");
    });
  });

  describe("edge cases", () => {
    it("should handle empty codebase gracefully", async () => {
      vi.spyOn(scanner, "scan").mockResolvedValue(makeScanResult([]));

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/empty/project",
      });

      expect(summary.termsCreated).toBe(0);
      expect(summary.warnings).toContainEqual(
        expect.stringContaining("No code concepts found"),
      );
    });

    it("should handle scanner errors by propagating them", async () => {
      vi.spyOn(scanner, "scan").mockRejectedValue(new Error("Scan failed: ENOENT"));

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await expect(
        orchestrator.run({ rootDir: "/nonexistent" }),
      ).rejects.toThrow("Scan failed: ENOENT");
    });

    it("should collect scan diagnostics as warnings", async () => {
      vi.spyOn(scanner, "scan").mockResolvedValue({
        ...makeScanResult(sampleConcepts),
        diagnostics: [
          { level: "warning", filePath: "broken.ts", message: "Parse failed" },
        ],
      });

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
      });

      expect(summary.warnings).toContainEqual(
        expect.stringContaining("broken.ts: Parse failed"),
      );
    });

    it("should pass scan config overrides through", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await orchestrator.run({
        rootDir: "/test/project",
        scanConfig: {
          maxDepth: 5,
          exclude: ["vendor/**"],
        },
      });

      expect(scanner.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          rootDir: "/test/project",
          maxDepth: 5,
          exclude: ["vendor/**"],
        }),
      );
    });

    it("should pass organization name to storage.load()", async () => {
      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      await orchestrator.run({
        rootDir: "/test/project",
        organization: "my-org",
      });

      expect(storage.load).toHaveBeenCalledWith("my-org");
    });

    it("should collect adapter extraction warnings", async () => {
      const mockAdapter = createMockAdapter([makeNormalizedTerm()]);
      vi.mocked(mockAdapter.extract).mockResolvedValue({
        ...makeExtractionResult([makeNormalizedTerm()]),
        warnings: ["Rate limited, some items skipped"],
      });
      adapterRegistry.register(mockAdapter);

      const orchestrator = new BootstrapOrchestrator({
        scanner,
        mappingEngine,
        storage,
        adapterRegistry,
      });

      const summary = await orchestrator.run({
        rootDir: "/test/project",
        adapterName: "notion",
      });

      expect(summary.warnings).toContainEqual(
        expect.stringContaining("Rate limited"),
      );
    });
  });
});
