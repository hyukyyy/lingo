/**
 * Tests for the PM Adapter Interface & Domain Models
 *
 * Validates:
 * - PMAdapter interface contract can be implemented
 * - PM domain data models (PMProject, PMItem, PMFieldValue, etc.)
 * - PMAdapterRegistry registration and lookup
 * - PMAdapterError error handling
 * - PaginatedResult pagination helpers
 * - PMTermCandidate terminology extraction model
 */

import { describe, it, expect, vi } from "vitest";
import type {
  PMAdapter,
  PMProject,
  PMItem,
  PMItemType,
  PMItemKind,
  PMItemStatus,
  PMStatusCategory,
  PMFieldValue,
  PMItemFilterOptions,
  PMTermCandidate,
  PMTermExtractionOptions,
  PMAdapterConfig,
  PaginationOptions,
  PaginatedResult,
  ExternalId,
  NormalizedTerm,
  ExtractionOptions,
  ExtractionResult,
  ConnectionStatus,
} from "../../src/adapters/types.js";
import {
  PMAdapterError,
} from "../../src/adapters/types.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

// ─── Test Mock Adapter ─────────────────────────────────────────────

/**
 * A minimal mock adapter that implements the full PMAdapter interface.
 * Proves the interface is implementable without any PM tool dependency.
 */
class MockPMAdapter implements PMAdapter {
  readonly name = "mock";
  readonly displayName = "Mock PM Tool";

  private projects: PMProject[] = [];
  private items: PMItem[] = [];

  constructor(projects?: PMProject[], items?: PMItem[]) {
    this.projects = projects ?? [];
    this.items = items ?? [];
  }

  async testConnection(): Promise<ConnectionStatus> {
    return {
      connected: true,
      message: "Connected to mock PM tool",
      details: { version: "1.0" },
    };
  }

  async listProjects(
    options?: PaginationOptions
  ): Promise<PaginatedResult<PMProject>> {
    const pageSize = options?.pageSize ?? 10;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = this.projects.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < this.projects.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(startIndex + pageSize) : undefined,
      totalCount: this.projects.length,
    };
  }

  async getProject(projectId: string): Promise<PMProject | undefined> {
    return this.projects.find((p) => p.externalId === projectId);
  }

  async listItems(
    projectId: string,
    options?: PMItemFilterOptions
  ): Promise<PaginatedResult<PMItem>> {
    let filtered = this.items.filter((i) => i.projectId === projectId);

    if (options?.statusCategory) {
      filtered = filtered.filter(
        (i) => i.status.category === options.statusCategory
      );
    }
    if (options?.labels?.length) {
      filtered = filtered.filter((i) =>
        i.labels.some((l) => options.labels!.includes(l))
      );
    }

    const pageSize = options?.pageSize ?? 10;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = filtered.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < filtered.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(startIndex + pageSize) : undefined,
    };
  }

  async getItem(itemId: string): Promise<PMItem | undefined> {
    return this.items.find((i) => i.externalId === itemId);
  }

  async extractItems(_options?: ExtractionOptions): Promise<PMItem[]> {
    return this.items;
  }

  normalizeToTerms(items: PMItem[]): NormalizedTerm[] {
    return items.map((item) => ({
      name: item.title,
      definition: item.description ?? `A ${item.type}`,
      aliases: [],
      tags: item.labels,
      source: { adapter: this.name, externalId: item.externalId },
      confidence: "ai-suggested" as const,
    }));
  }

  async extract(_options?: ExtractionOptions): Promise<ExtractionResult> {
    const items = await this.extractItems(_options);
    const terms = this.normalizeToTerms(items);
    return {
      adapterName: this.name,
      extractedAt: new Date().toISOString(),
      terms,
      stats: {
        itemsFetched: items.length,
        termsProduced: terms.length,
        itemsSkipped: 0,
        durationMs: 0,
        itemsByType: {},
      },
      warnings: [],
    };
  }

  async extractTerminology(
    projectId: string,
    options?: PMTermExtractionOptions
  ): Promise<PMTermCandidate[]> {
    const projectItems = this.items.filter((i) => i.projectId === projectId);
    const limited = options?.maxItems
      ? projectItems.slice(0, options.maxItems)
      : projectItems;

    const termMap = new Map<string, PMTermCandidate>();
    for (const item of limited) {
      const key = item.title.toLowerCase();
      const existing = termMap.get(key);
      if (existing) {
        existing.frequency++;
        existing.source.itemIds.push(item.externalId);
      } else {
        termMap.set(key, {
          term: item.title,
          contextSnippet: item.description ?? "",
          source: {
            adapter: this.name,
            projectId,
            itemIds: [item.externalId],
          },
          frequency: 1,
          suggestedCategory: item.project,
          suggestedAliases: [],
        });
      }
    }

    const minFreq = options?.minFrequency ?? 1;
    return Array.from(termMap.values())
      .filter((t) => t.frequency >= minFreq)
      .sort((a, b) => b.frequency - a.frequency);
  }
}

// ─── Test Data Helpers ─────────────────────────────────────────────

function createTestProject(overrides?: Partial<PMProject>): PMProject {
  return {
    externalId: "proj-1",
    name: "Test Project",
    description: "A test project",
    url: "https://example.com/proj-1",
    updatedAt: "2025-01-01T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function createTestItem(overrides?: Partial<PMItem>): PMItem {
  return {
    externalId: "item-1",
    title: "Test Item",
    description: "A test item",
    type: "task",
    kind: "task",
    status: { category: "todo", originalLabel: "To Do" },
    labels: ["backend"],
    assignees: ["Alice"],
    projectId: "proj-1",
    project: "Test Project",
    customFields: {},
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("PM Adapter Interface & Domain Models", () => {
  // ─── PMProject ─────────────────────────────────────────────────

  describe("PMProject", () => {
    it("has required fields", () => {
      const project: PMProject = {
        externalId: "proj-123",
        name: "Roadmap 2025",
        metadata: {},
      };

      expect(project.externalId).toBe("proj-123");
      expect(project.name).toBe("Roadmap 2025");
      expect(project.metadata).toEqual({});
    });

    it("supports optional fields", () => {
      const project = createTestProject({
        description: "Q1 roadmap",
        url: "https://notion.so/roadmap",
        externalUrl: "https://notion.so/roadmap",
        updatedAt: "2025-03-01T00:00:00.000Z",
        metadata: { propertyCount: 5 },
      });

      expect(project.description).toBe("Q1 roadmap");
      expect(project.url).toBe("https://notion.so/roadmap");
      expect(project.updatedAt).toBe("2025-03-01T00:00:00.000Z");
      expect(project.metadata).toEqual({ propertyCount: 5 });
    });
  });

  // ─── PMItem ────────────────────────────────────────────────────

  describe("PMItem", () => {
    it("has all required fields", () => {
      const item = createTestItem();

      expect(item.externalId).toBe("item-1");
      expect(item.title).toBe("Test Item");
      expect(item.type).toBe("task");
      expect(item.kind).toBe("task");
      expect(item.status.category).toBe("todo");
      expect(item.status.originalLabel).toBe("To Do");
      expect(item.labels).toEqual(["backend"]);
      expect(item.assignees).toEqual(["Alice"]);
      expect(item.projectId).toBe("proj-1");
      expect(item.customFields).toEqual({});
      expect(item.metadata).toEqual({});
    });

    it("supports all PMItemType values", () => {
      const types: PMItemType[] = [
        "epic", "feature", "story", "task", "bug",
        "label", "status", "workflow", "project", "milestone", "custom",
      ];
      for (const t of types) {
        const item = createTestItem({ type: t });
        expect(item.type).toBe(t);
      }
    });

    it("supports all PMItemKind values", () => {
      const kinds: PMItemKind[] = [
        "task", "epic", "story", "bug", "page", "milestone", "other",
      ];
      for (const k of kinds) {
        const item = createTestItem({ kind: k });
        expect(item.kind).toBe(k);
      }
    });

    it("supports all PMStatusCategory values", () => {
      const categories: PMStatusCategory[] = [
        "todo", "in_progress", "done", "cancelled", "unknown",
      ];
      for (const cat of categories) {
        const status: PMItemStatus = { category: cat, originalLabel: cat };
        expect(status.category).toBe(cat);
      }
    });
  });

  // ─── PMFieldValue ──────────────────────────────────────────────

  describe("PMFieldValue", () => {
    it("supports string values", () => {
      const field: PMFieldValue = { type: "string", value: "hello" };
      expect(field.type).toBe("string");
      expect(field.value).toBe("hello");
    });

    it("supports number values", () => {
      const field: PMFieldValue = { type: "number", value: 42 };
      expect(field.type).toBe("number");
      expect(field.value).toBe(42);
    });

    it("supports boolean values", () => {
      const field: PMFieldValue = { type: "boolean", value: true };
      expect(field.type).toBe("boolean");
      expect(field.value).toBe(true);
    });

    it("supports date values", () => {
      const field: PMFieldValue = { type: "date", value: "2025-01-01" };
      expect(field.type).toBe("date");
      expect(field.value).toBe("2025-01-01");
    });

    it("supports select values", () => {
      const field: PMFieldValue = { type: "select", value: "High" };
      expect(field.type).toBe("select");
      expect(field.value).toBe("High");
    });

    it("supports multi_select values", () => {
      const field: PMFieldValue = {
        type: "multi_select",
        value: ["Frontend", "Backend"],
      };
      expect(field.type).toBe("multi_select");
      expect(field.value).toEqual(["Frontend", "Backend"]);
    });

    it("supports url values", () => {
      const field: PMFieldValue = { type: "url", value: "https://example.com" };
      expect(field.type).toBe("url");
      expect(field.value).toBe("https://example.com");
    });

    it("supports unknown values", () => {
      const field: PMFieldValue = { type: "unknown", value: { complex: true } };
      expect(field.type).toBe("unknown");
    });

    it("can be used as typed custom fields on PMItem", () => {
      const item = createTestItem({
        customFields: {
          priority: { type: "select", value: "P0" },
          storyPoints: { type: "number", value: 5 },
          dueDate: { type: "date", value: "2025-06-01" },
        },
      });

      expect(item.customFields["priority"]).toEqual({
        type: "select",
        value: "P0",
      });
      expect(item.customFields["storyPoints"]).toEqual({
        type: "number",
        value: 5,
      });
    });
  });

  // ─── PMTermCandidate ───────────────────────────────────────────

  describe("PMTermCandidate", () => {
    it("captures term with source traceability", () => {
      const candidate: PMTermCandidate = {
        term: "Sprint Velocity",
        contextSnippet: "The number of story points completed per sprint",
        source: {
          adapter: "notion",
          projectId: "proj-1",
          itemIds: ["item-1", "item-2"],
          url: "https://notion.so/sprint-velocity",
        },
        frequency: 5,
        suggestedCategory: "agile",
        suggestedAliases: ["velocity", "sprint speed"],
      };

      expect(candidate.term).toBe("Sprint Velocity");
      expect(candidate.source.adapter).toBe("notion");
      expect(candidate.source.itemIds).toHaveLength(2);
      expect(candidate.frequency).toBe(5);
      expect(candidate.suggestedAliases).toContain("velocity");
    });
  });

  // ─── PMAdapterConfig ──────────────────────────────────────────

  describe("PMAdapterConfig", () => {
    it("defines base configuration for adapters", () => {
      const config: PMAdapterConfig = {
        adapterName: "notion",
        baseUrl: "https://api.notion.com",
        timeoutMs: 30_000,
        options: { apiKey: "secret_xxx" },
      };

      expect(config.adapterName).toBe("notion");
      expect(config.options).toHaveProperty("apiKey");
    });
  });

  // ─── PMAdapterError ───────────────────────────────────────────

  describe("PMAdapterError", () => {
    it("carries error code and adapter name", () => {
      const error = new PMAdapterError(
        "Rate limit exceeded",
        "RATE_LIMITED",
        "notion"
      );

      expect(error.message).toBe("Rate limit exceeded");
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.adapterName).toBe("notion");
      expect(error.name).toBe("PMAdapterError");
      expect(error).toBeInstanceOf(Error);
    });

    it("optionally carries a cause", () => {
      const cause = new Error("HTTP 429");
      const error = new PMAdapterError(
        "Rate limited",
        "RATE_LIMITED",
        "linear",
        cause
      );

      expect(error.cause).toBe(cause);
    });

    it("supports all error codes", () => {
      const codes = [
        "AUTH_FAILED",
        "NOT_FOUND",
        "RATE_LIMITED",
        "NETWORK_ERROR",
        "INVALID_CONFIG",
        "PARSE_ERROR",
        "UNSUPPORTED",
        "UNKNOWN",
      ] as const;

      for (const code of codes) {
        const error = new PMAdapterError("test", code, "test-adapter");
        expect(error.code).toBe(code);
      }
    });
  });

  // ─── PaginatedResult ──────────────────────────────────────────

  describe("PaginatedResult", () => {
    it("represents a single page of results", () => {
      const result: PaginatedResult<PMProject> = {
        items: [createTestProject()],
        hasMore: true,
        nextCursor: "cursor-2",
        totalCount: 50,
      };

      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("cursor-2");
      expect(result.totalCount).toBe(50);
    });

    it("represents the last page", () => {
      const result: PaginatedResult<PMProject> = {
        items: [createTestProject()],
        hasMore: false,
      };

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeUndefined();
    });
  });

  // ─── PMAdapter Interface Contract ─────────────────────────────

  describe("PMAdapter interface contract", () => {
    const projects = [
      createTestProject({ externalId: "proj-1", name: "Roadmap" }),
      createTestProject({ externalId: "proj-2", name: "Backlog" }),
    ];

    const items = [
      createTestItem({
        externalId: "item-1",
        title: "Auth Flow",
        projectId: "proj-1",
        status: { category: "in_progress", originalLabel: "In Progress" },
        labels: ["security"],
      }),
      createTestItem({
        externalId: "item-2",
        title: "Auth Flow",
        projectId: "proj-1",
        status: { category: "todo", originalLabel: "To Do" },
        labels: ["api"],
      }),
      createTestItem({
        externalId: "item-3",
        title: "Dark Mode",
        projectId: "proj-1",
        labels: ["frontend"],
      }),
      createTestItem({
        externalId: "item-4",
        title: "Billing API",
        projectId: "proj-2",
      }),
    ];

    let adapter: PMAdapter;

    beforeEach(() => {
      adapter = new MockPMAdapter(projects, items);
    });

    it("exposes name and displayName", () => {
      expect(adapter.name).toBe("mock");
      expect(adapter.displayName).toBe("Mock PM Tool");
    });

    it("testConnection returns ConnectionStatus", async () => {
      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);
      expect(status.message).toBeTruthy();
    });

    it("listProjects returns paginated projects", async () => {
      const result = await adapter.listProjects();
      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe("Roadmap");
      expect(result.items[1].name).toBe("Backlog");
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

    it("getProject returns a single project", async () => {
      const project = await adapter.getProject("proj-1");
      expect(project).toBeDefined();
      expect(project!.name).toBe("Roadmap");
    });

    it("getProject returns undefined for unknown ID", async () => {
      const project = await adapter.getProject("nonexistent");
      expect(project).toBeUndefined();
    });

    it("listItems returns items for a project", async () => {
      const result = await adapter.listItems("proj-1");
      expect(result.items).toHaveLength(3);
      expect(result.items.every((i) => i.projectId === "proj-1")).toBe(true);
    });

    it("listItems filters by status category", async () => {
      const result = await adapter.listItems("proj-1", {
        statusCategory: "in_progress",
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Auth Flow");
    });

    it("listItems filters by labels", async () => {
      const result = await adapter.listItems("proj-1", {
        labels: ["frontend"],
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Dark Mode");
    });

    it("getItem returns a single item", async () => {
      const item = await adapter.getItem("item-1");
      expect(item).toBeDefined();
      expect(item!.title).toBe("Auth Flow");
    });

    it("getItem returns undefined for unknown ID", async () => {
      const item = await adapter.getItem("nonexistent");
      expect(item).toBeUndefined();
    });

    it("extractItems returns all items", async () => {
      const allItems = await adapter.extractItems();
      expect(allItems).toHaveLength(4);
    });

    it("normalizeToTerms converts items to NormalizedTerms", () => {
      const terms = adapter.normalizeToTerms(items.slice(0, 1));
      expect(terms).toHaveLength(1);
      expect(terms[0].name).toBe("Auth Flow");
      expect(terms[0].source.adapter).toBe("mock");
    });

    it("extract returns a complete ExtractionResult", async () => {
      const result = await adapter.extract();
      expect(result.adapterName).toBe("mock");
      expect(result.terms.length).toBeGreaterThan(0);
      expect(result.stats.itemsFetched).toBe(4);
    });

    it("extractTerminology surfaces term candidates from a project", async () => {
      const candidates = await adapter.extractTerminology("proj-1");
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.source.projectId === "proj-1")).toBe(true);
    });

    it("extractTerminology deduplicates and counts frequency", async () => {
      const candidates = await adapter.extractTerminology("proj-1");
      const authFlow = candidates.find((c) => c.term === "Auth Flow");
      expect(authFlow).toBeDefined();
      expect(authFlow!.frequency).toBe(2); // Two items with same title
      expect(authFlow!.source.itemIds).toHaveLength(2);
    });

    it("extractTerminology respects minFrequency option", async () => {
      const candidates = await adapter.extractTerminology("proj-1", {
        minFrequency: 2,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].term).toBe("Auth Flow");
    });

    it("extractTerminology respects maxItems option", async () => {
      const candidates = await adapter.extractTerminology("proj-1", {
        maxItems: 1,
      });
      expect(candidates.length).toBeLessThanOrEqual(1);
    });

    it("extractTerminology returns empty for unknown project", async () => {
      const candidates = await adapter.extractTerminology("nonexistent");
      expect(candidates).toHaveLength(0);
    });
  });

  // ─── AdapterRegistry ──────────────────────────────────────────

  describe("AdapterRegistry with PMAdapter", () => {
    it("registers and retrieves adapters", () => {
      const registry = new AdapterRegistry();
      const adapter = new MockPMAdapter();

      registry.register(adapter);

      expect(registry.has("mock")).toBe(true);
      expect(registry.get("mock")).toBe(adapter);
      expect(registry.registeredAdapters).toContain("mock");
    });

    it("supports multiple adapters", () => {
      const registry = new AdapterRegistry();

      const mock1 = new MockPMAdapter();
      const mock2 = { ...new MockPMAdapter(), name: "linear", displayName: "Linear" } as PMAdapter;

      registry.register(mock1);
      registry.register(mock2);

      expect(registry.registeredAdapters).toHaveLength(2);
      expect(registry.get("mock")).toBe(mock1);
      expect(registry.get("linear")).toBe(mock2);
    });

    it("overwrites adapters with the same name", () => {
      const registry = new AdapterRegistry();

      const adapter1 = new MockPMAdapter();
      const adapter2 = new MockPMAdapter();

      registry.register(adapter1);
      registry.register(adapter2);

      expect(registry.get("mock")).toBe(adapter2);
    });
  });

  // ─── ExternalId ───────────────────────────────────────────────

  describe("ExternalId type alias", () => {
    it("is a string type alias", () => {
      const id: ExternalId = "abc-123";
      expect(typeof id).toBe("string");
    });
  });
});
