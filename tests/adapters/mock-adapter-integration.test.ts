/**
 * Mock PM Adapter — Integration Test
 *
 * Proves that a new PM tool adapter can be registered and used
 * WITHOUT modifying any core logic files.
 *
 * This test demonstrates the adapter extensibility contract:
 *
 * 1. A new adapter module (mock/) implements the PMAdapter interface
 * 2. The adapter registers via a factory — the same pattern as Notion
 * 3. Core systems (registry, extraction, terminology) work seamlessly
 *    with the new adapter — zero core changes required
 *
 * This is the "second adapter" test: if it passes, any third-party
 * could add their own PM tool adapter to the Lingo ecosystem by
 * following the same pattern.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { registerBuiltinAdapters } from "../../src/adapters/builtin-adapters.js";
import {
  MockPMAdapter,
  mockFactoryRegistration,
  createMockAdapter,
} from "../../src/adapters/mock/index.js";
import type {
  PMAdapter,
  PMProject,
  PMItem,
} from "../../src/adapters/types.js";

// ─── Test Data ────────────────────────────────────────────────────

const SEED_PROJECTS: PMProject[] = [
  {
    externalId: "mock-proj-1",
    name: "Sprint Board",
    description: "Engineering sprint tracking",
    url: "https://mock-pm.example/sprint-board",
    updatedAt: "2026-01-15T10:00:00.000Z",
    metadata: { workspace: "engineering" },
  },
  {
    externalId: "mock-proj-2",
    name: "Product Roadmap",
    description: "Q2 product roadmap",
    metadata: {},
  },
];

const SEED_ITEMS: PMItem[] = [
  {
    externalId: "mock-item-1",
    title: "Sprint Velocity",
    description: "Track sprint velocity across teams",
    type: "feature",
    kind: "task",
    status: { category: "in_progress", originalLabel: "In Progress" },
    labels: ["metrics", "agile"],
    assignees: ["Alice"],
    projectId: "mock-proj-1",
    project: "Sprint Board",
    customFields: {},
    metadata: {},
  },
  {
    externalId: "mock-item-2",
    title: "Sprint Velocity",
    description: "Dashboard for sprint velocity metrics",
    type: "story",
    kind: "story",
    status: { category: "todo", originalLabel: "Backlog" },
    labels: ["dashboard"],
    assignees: [],
    projectId: "mock-proj-1",
    project: "Sprint Board",
    customFields: {},
    metadata: {},
  },
  {
    externalId: "mock-item-3",
    title: "User Onboarding Flow",
    description: "Multi-step onboarding wizard for new users",
    type: "epic",
    kind: "epic",
    status: { category: "todo", originalLabel: "Planned" },
    labels: ["ux", "growth"],
    assignees: ["Bob"],
    projectId: "mock-proj-1",
    project: "Sprint Board",
    customFields: {},
    metadata: {},
  },
  {
    externalId: "mock-item-4",
    title: "API Rate Limiting",
    description: "Implement rate limiting on public API endpoints",
    type: "task",
    kind: "task",
    status: { category: "done", originalLabel: "Done" },
    labels: ["backend", "security"],
    assignees: ["Charlie"],
    projectId: "mock-proj-2",
    project: "Product Roadmap",
    customFields: {},
    metadata: {},
  },
];

// ─── Tests ────────────────────────────────────────────────────────

describe("Mock PM Adapter — Integration (Extensibility Proof)", () => {
  describe("Factory registration without core changes", () => {
    let registry: AdapterRegistry;

    beforeEach(() => {
      registry = new AdapterRegistry();
    });

    it("registers the mock factory alongside built-in adapters", () => {
      // Step 1: Register built-in adapters (the core startup flow)
      registerBuiltinAdapters(registry);

      // Step 2: Register the mock adapter (no core file modified)
      registry.registerFactory(mockFactoryRegistration);

      // Both adapters are now available
      expect(registry.hasFactory("notion")).toBe(true);
      expect(registry.hasFactory("mock")).toBe(true);
      expect(registry.registeredFactories).toContain("notion");
      expect(registry.registeredFactories).toContain("mock");
    });

    it("mock adapter appears in availableAdapters discovery", () => {
      registerBuiltinAdapters(registry);
      registry.registerFactory(mockFactoryRegistration);

      const available = registry.availableAdapters;
      const mockInfo = available.find((a) => a.name === "mock");

      expect(mockInfo).toBeDefined();
      expect(mockInfo!.displayName).toBe("Mock PM Tool");
      expect(mockInfo!.description).toBeTruthy();
      expect(mockInfo!.instantiated).toBe(false);
    });

    it("creates a mock adapter from factory with config", () => {
      registry.registerFactory(mockFactoryRegistration);

      const adapter = registry.createAdapter("mock", {
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("mock");
      expect(adapter.displayName).toBe("Mock PM Tool");
    });

    it("getOrCreate caches mock adapter instance", () => {
      registry.registerFactory(mockFactoryRegistration);

      const first = registry.getOrCreate("mock", {
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });
      const second = registry.getOrCreate("mock", {});

      expect(first).toBe(second); // Same cached instance
      expect(registry.has("mock")).toBe(true);
    });

    it("creates mock adapter with empty config (zero required fields)", () => {
      registry.registerFactory(mockFactoryRegistration);

      // Unlike Notion which requires apiToken, Mock works with empty config
      const adapter = registry.createAdapter("mock", {});

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("mock");
    });
  });

  describe("Mock adapter implements full PMAdapter contract", () => {
    let adapter: PMAdapter;

    beforeEach(() => {
      adapter = new MockPMAdapter({
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });
    });

    it("testConnection returns success", async () => {
      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.message).toContain("mock");
      expect(status.details).toBeDefined();
    });

    it("listProjects returns all seed projects", async () => {
      const result = await adapter.listProjects();

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.totalCount).toBe(2);
      expect(result.items[0].name).toBe("Sprint Board");
      expect(result.items[1].name).toBe("Product Roadmap");
    });

    it("listProjects supports pagination", async () => {
      const page1 = await adapter.listProjects({ pageSize: 1 });
      expect(page1.items).toHaveLength(1);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await adapter.listProjects({
        pageSize: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });

    it("getProject returns a project by ID", async () => {
      const project = await adapter.getProject("mock-proj-1");

      expect(project).toBeDefined();
      expect(project!.name).toBe("Sprint Board");
      expect(project!.description).toBe("Engineering sprint tracking");
    });

    it("getProject returns undefined for unknown ID", async () => {
      const project = await adapter.getProject("nonexistent");
      expect(project).toBeUndefined();
    });

    it("listItems returns items for a specific project", async () => {
      const result = await adapter.listItems("mock-proj-1");

      expect(result.items).toHaveLength(3);
      expect(result.items.every((i) => i.projectId === "mock-proj-1")).toBe(
        true
      );
    });

    it("listItems filters by status category", async () => {
      const result = await adapter.listItems("mock-proj-1", {
        statusCategory: "in_progress",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Sprint Velocity");
    });

    it("listItems filters by labels", async () => {
      const result = await adapter.listItems("mock-proj-1", {
        labels: ["ux"],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("User Onboarding Flow");
    });

    it("listItems filters by search query", async () => {
      const result = await adapter.listItems("mock-proj-1", {
        searchQuery: "dashboard",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].externalId).toBe("mock-item-2");
    });

    it("getItem returns a single item by ID", async () => {
      const item = await adapter.getItem("mock-item-3");

      expect(item).toBeDefined();
      expect(item!.title).toBe("User Onboarding Flow");
      expect(item!.kind).toBe("epic");
    });

    it("getItem returns undefined for unknown ID", async () => {
      expect(await adapter.getItem("nonexistent")).toBeUndefined();
    });

    it("extractItems returns all items", async () => {
      const items = await adapter.extractItems();
      expect(items).toHaveLength(4);
    });

    it("extractItems filters by item type", async () => {
      const items = await adapter.extractItems({ itemTypes: ["task"] });

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("API Rate Limiting");
    });

    it("extractItems filters by project", async () => {
      const items = await adapter.extractItems({ project: "mock-proj-2" });

      expect(items).toHaveLength(1);
      expect(items[0].title).toBe("API Rate Limiting");
    });

    it("extractItems respects maxItems", async () => {
      const items = await adapter.extractItems({ maxItems: 2 });
      expect(items).toHaveLength(2);
    });

    it("normalizeToTerms converts items to NormalizedTerms", () => {
      const terms = adapter.normalizeToTerms(SEED_ITEMS.slice(0, 2));

      expect(terms).toHaveLength(2);
      expect(terms[0].name).toBe("Sprint Velocity");
      expect(terms[0].source.adapter).toBe("mock");
      expect(terms[0].source.externalId).toBe("mock-item-1");
      expect(terms[0].confidence).toBe("ai-suggested");
      expect(terms[0].tags).toContain("metrics");
    });

    it("extract returns a complete ExtractionResult", async () => {
      const result = await adapter.extract();

      expect(result.adapterName).toBe("mock");
      expect(result.extractedAt).toBeTruthy();
      expect(result.terms).toHaveLength(4);
      expect(result.stats.itemsFetched).toBe(4);
      expect(result.stats.termsProduced).toBe(4);
      expect(result.stats.itemsSkipped).toBe(0);
      expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.warnings).toEqual([]);
    });

    it("extract computes per-type statistics", async () => {
      const result = await adapter.extract();

      expect(result.stats.itemsByType.feature).toBe(1);
      expect(result.stats.itemsByType.story).toBe(1);
      expect(result.stats.itemsByType.epic).toBe(1);
      expect(result.stats.itemsByType.task).toBe(1);
    });

    it("extractTerminology surfaces term candidates from a project", async () => {
      const candidates = await adapter.extractTerminology("mock-proj-1");

      expect(candidates.length).toBeGreaterThan(0);
      expect(
        candidates.every((c) => c.source.projectId === "mock-proj-1")
      ).toBe(true);
      expect(candidates.every((c) => c.source.adapter === "mock")).toBe(true);
    });

    it("extractTerminology deduplicates and counts frequency", async () => {
      const candidates = await adapter.extractTerminology("mock-proj-1");

      const velocity = candidates.find((c) => c.term === "Sprint Velocity");
      expect(velocity).toBeDefined();
      expect(velocity!.frequency).toBe(2);
      expect(velocity!.source.itemIds).toHaveLength(2);

      // Should be sorted by frequency descending
      expect(candidates[0].frequency).toBeGreaterThanOrEqual(
        candidates[candidates.length - 1].frequency
      );
    });

    it("extractTerminology respects minFrequency", async () => {
      const candidates = await adapter.extractTerminology("mock-proj-1", {
        minFrequency: 2,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].term).toBe("Sprint Velocity");
    });

    it("extractTerminology respects maxItems", async () => {
      const candidates = await adapter.extractTerminology("mock-proj-1", {
        maxItems: 1,
      });

      // Only first item scanned, so only one term
      expect(candidates.length).toBeLessThanOrEqual(1);
    });

    it("extractTerminology returns empty for unknown project", async () => {
      const candidates = await adapter.extractTerminology("nonexistent");
      expect(candidates).toHaveLength(0);
    });
  });

  describe("Adapter interchangeability — core code is adapter-agnostic", () => {
    it("core extraction loop works identically across adapter types", async () => {
      const registry = new AdapterRegistry();
      registerBuiltinAdapters(registry);
      registry.registerFactory(mockFactoryRegistration);

      // Create the mock adapter with seed data
      const adapter = registry.getOrCreate("mock", {
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });

      // This simulates what core extraction code does:
      // 1. Get adapter from registry by name
      // 2. Test connection
      // 3. List projects
      // 4. Extract terminology

      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);

      const projects = await adapter.listProjects();
      expect(projects.items.length).toBeGreaterThan(0);

      const result = await adapter.extract();
      expect(result.adapterName).toBe("mock");
      expect(result.terms.length).toBeGreaterThan(0);

      // All terms are properly normalized
      for (const term of result.terms) {
        expect(term.name).toBeTruthy();
        expect(term.source.adapter).toBe("mock");
        expect(term.confidence).toBe("ai-suggested");
      }
    });

    it("registry iterates all adapters uniformly (polymorphism proof)", async () => {
      const registry = new AdapterRegistry();

      // Register mock adapter via factory
      registry.registerFactory(mockFactoryRegistration);
      registry.getOrCreate("mock", {
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });

      // Core code can iterate all adapters without knowing their types
      for (const adapterInfo of registry.availableAdapters) {
        const adapter = registry.get(adapterInfo.name);
        if (!adapter) continue;

        // Same interface, works regardless of adapter type
        const status = await adapter.testConnection();
        expect(typeof status.connected).toBe("boolean");

        const extraction = await adapter.extract();
        expect(extraction.adapterName).toBe(adapterInfo.name);
        expect(Array.isArray(extraction.terms)).toBe(true);
      }
    });
  });

  describe("Direct construction (without factory)", () => {
    it("MockPMAdapter can be used directly without the registry", () => {
      const adapter = new MockPMAdapter({
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });

      expect(adapter.name).toBe("mock");
      expect(adapter.displayName).toBe("Mock PM Tool");
    });

    it("MockPMAdapter works with default (empty) config", async () => {
      const adapter = new MockPMAdapter();

      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);

      const projects = await adapter.listProjects();
      expect(projects.items).toHaveLength(0);

      const result = await adapter.extract();
      expect(result.terms).toHaveLength(0);
    });

    it("simulateConnectionFailure flag works", async () => {
      const adapter = new MockPMAdapter({
        simulateConnectionFailure: true,
      });

      const status = await adapter.testConnection();
      expect(status.connected).toBe(false);
    });
  });

  describe("createMockAdapter factory function", () => {
    it("creates adapter from raw config object", () => {
      const adapter = createMockAdapter({
        projects: SEED_PROJECTS,
        items: SEED_ITEMS,
      });

      expect(adapter.name).toBe("mock");
      expect(adapter.displayName).toBe("Mock PM Tool");
    });

    it("creates adapter from empty config", () => {
      const adapter = createMockAdapter({});

      expect(adapter.name).toBe("mock");
    });
  });
});
