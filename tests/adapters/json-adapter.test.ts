/**
 * Tests for the Generic JSON PM Adapter
 *
 * Validates:
 * - JsonAdapter implements the full PMAdapter interface
 * - Loading from inline data and file paths
 * - Project listing, filtering, and pagination
 * - Item listing with all filter options
 * - Type and status normalization from free-form strings
 * - Custom field resolution
 * - Terminology extraction with frequency counting
 * - normalizeToTerms conversion to NormalizedTerm format
 * - extract() convenience method with stats
 * - Default project creation for orphan items
 * - Error handling for invalid data/files
 * - Factory-based creation via createJsonAdapter
 * - Registry integration via jsonFactoryRegistration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  JsonAdapter,
  resetItemCounter,
  type JsonAdapterConfig,
  type JsonPMData,
  type JsonProject,
  type JsonItem,
} from "../../src/adapters/json/json-adapter.js";

import {
  createJsonAdapter,
  jsonFactoryRegistration,
} from "../../src/adapters/json/factory.js";

import { PMAdapterError } from "../../src/adapters/types.js";
import type {
  PMAdapter,
  PMItem,
  PMProject,
  NormalizedTerm,
  ExtractionResult,
} from "../../src/adapters/types.js";

import { AdapterRegistry } from "../../src/adapters/registry.js";
import {
  registerBuiltinAdapters,
  BUILTIN_ADAPTER_FACTORIES,
} from "../../src/adapters/builtin-adapters.js";

// ─── Test Data ────────────────────────────────────────────────────────

const SAMPLE_DATA: JsonPMData = {
  organization: "Acme Corp",
  projects: [
    {
      id: "proj-roadmap",
      name: "Product Roadmap",
      description: "Q1 2025 roadmap",
      url: "https://example.com/roadmap",
      updatedAt: "2025-01-15T00:00:00.000Z",
    },
    {
      id: "proj-platform",
      name: "Platform Team",
      description: "Platform infrastructure",
    },
  ],
  items: [
    {
      id: "item-auth",
      title: "Auth Flow Redesign",
      description: "Redesign the authentication flow to support SSO",
      type: "feature",
      status: "In Progress",
      labels: ["security", "frontend"],
      assignees: ["Alice"],
      projectId: "proj-roadmap",
      url: "https://example.com/auth",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-10T00:00:00.000Z",
    },
    {
      id: "item-billing",
      title: "Billing API",
      description: "Build billing integration with Stripe",
      type: "epic",
      status: "todo",
      labels: ["backend", "payments"],
      projectId: "proj-roadmap",
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-05T00:00:00.000Z",
    },
    {
      id: "item-auth-bug",
      title: "Auth Flow Redesign",
      description: "Fix redirect loop in auth flow",
      type: "bug",
      status: "Done",
      labels: ["security"],
      projectId: "proj-roadmap",
      updatedAt: "2025-01-12T00:00:00.000Z",
    },
    {
      id: "item-k8s",
      title: "Kubernetes Migration",
      description: "Migrate services to Kubernetes",
      type: "epic",
      status: "backlog",
      labels: ["infrastructure"],
      projectId: "proj-platform",
      updatedAt: "2025-01-03T00:00:00.000Z",
    },
    {
      id: "item-monitoring",
      title: "Observability Stack",
      description: "Set up Grafana + Prometheus monitoring",
      type: "task",
      status: "In Review",
      labels: ["infrastructure", "monitoring"],
      assignees: ["Bob"],
      projectId: "proj-platform",
    },
  ],
};

// ─── Helper ──────────────────────────────────────────────────────────

function createAdapter(
  data?: JsonPMData,
  config?: Partial<JsonAdapterConfig>
): JsonAdapter {
  return new JsonAdapter({
    data: data ?? SAMPLE_DATA,
    ...config,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("JsonAdapter", () => {
  beforeEach(() => {
    resetItemCounter();
  });

  // ─── Identity ──────────────────────────────────────────────────────

  describe("identity", () => {
    it("has name 'json'", () => {
      const adapter = createAdapter();
      expect(adapter.name).toBe("json");
    });

    it("has displayName 'JSON Import'", () => {
      const adapter = createAdapter();
      expect(adapter.displayName).toBe("JSON Import");
    });

    it("implements PMAdapter interface", () => {
      const adapter: PMAdapter = createAdapter();
      expect(adapter.name).toBeDefined();
      expect(adapter.displayName).toBeDefined();
      expect(typeof adapter.testConnection).toBe("function");
      expect(typeof adapter.listProjects).toBe("function");
      expect(typeof adapter.getProject).toBe("function");
      expect(typeof adapter.listItems).toBe("function");
      expect(typeof adapter.getItem).toBe("function");
      expect(typeof adapter.extractItems).toBe("function");
      expect(typeof adapter.normalizeToTerms).toBe("function");
      expect(typeof adapter.extract).toBe("function");
      expect(typeof adapter.extractTerminology).toBe("function");
    });
  });

  // ─── testConnection ────────────────────────────────────────────────

  describe("testConnection()", () => {
    it("reports successful connection with data stats", async () => {
      const adapter = createAdapter();
      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.message).toContain("2 project(s)");
      expect(status.message).toContain("5 item(s)");
      expect(status.details?.organization).toBe("Acme Corp");
    });

    it("reports successful connection with empty data", async () => {
      const adapter = createAdapter({});
      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.message).toContain("0 project(s)");
      expect(status.message).toContain("0 item(s)");
    });

    it("reports failure for invalid file path", async () => {
      const adapter = new JsonAdapter({
        filePath: "/nonexistent/path/data.json",
      });
      const status = await adapter.testConnection();

      expect(status.connected).toBe(false);
      expect(status.message).toContain("Failed to load");
    });
  });

  // ─── Projects ──────────────────────────────────────────────────────

  describe("listProjects()", () => {
    it("returns all projects", async () => {
      const adapter = createAdapter();
      const result = await adapter.listProjects();

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe("Product Roadmap");
      expect(result.items[1].name).toBe("Platform Team");
      expect(result.hasMore).toBe(false);
    });

    it("supports pagination with pageSize", async () => {
      const adapter = createAdapter();

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

    it("returns totalCount", async () => {
      const adapter = createAdapter();
      const result = await adapter.listProjects();
      expect(result.totalCount).toBe(2);
    });

    it("preserves project metadata", async () => {
      const adapter = createAdapter();
      const result = await adapter.listProjects();
      const roadmap = result.items.find(
        (p) => p.externalId === "proj-roadmap"
      );

      expect(roadmap).toBeDefined();
      expect(roadmap!.description).toBe("Q1 2025 roadmap");
      expect(roadmap!.url).toBe("https://example.com/roadmap");
      expect(roadmap!.updatedAt).toBe("2025-01-15T00:00:00.000Z");
    });
  });

  describe("getProject()", () => {
    it("returns a project by ID", async () => {
      const adapter = createAdapter();
      const project = await adapter.getProject("proj-roadmap");

      expect(project).toBeDefined();
      expect(project!.name).toBe("Product Roadmap");
    });

    it("returns undefined for unknown project", async () => {
      const adapter = createAdapter();
      const project = await adapter.getProject("nonexistent");
      expect(project).toBeUndefined();
    });
  });

  // ─── Items ─────────────────────────────────────────────────────────

  describe("listItems()", () => {
    it("returns items for a specific project", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap");

      expect(result.items).toHaveLength(3);
      expect(result.items.every((i) => i.projectId === "proj-roadmap")).toBe(
        true
      );
    });

    it("filters by status category", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap", {
        statusCategory: "in_progress",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Auth Flow Redesign");
    });

    it("filters by labels", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap", {
        labels: ["payments"],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Billing API");
    });

    it("filters by updatedAfter", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap", {
        updatedAfter: "2025-01-08T00:00:00.000Z",
      });

      expect(result.items).toHaveLength(2);
      const titles = result.items.map((i) => i.title);
      expect(titles).toContain("Auth Flow Redesign");
    });

    it("filters by searchQuery on title", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap", {
        searchQuery: "billing",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Billing API");
    });

    it("filters by searchQuery on description", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("proj-roadmap", {
        searchQuery: "Stripe",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Billing API");
    });

    it("supports pagination", async () => {
      const adapter = createAdapter();
      const page1 = await adapter.listItems("proj-roadmap", { pageSize: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.hasMore).toBe(true);

      const page2 = await adapter.listItems("proj-roadmap", {
        pageSize: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });

    it("returns empty for unknown project", async () => {
      const adapter = createAdapter();
      const result = await adapter.listItems("nonexistent");

      expect(result.items).toHaveLength(0);
    });
  });

  describe("getItem()", () => {
    it("returns an item by ID", async () => {
      const adapter = createAdapter();
      const item = await adapter.getItem("item-auth");

      expect(item).toBeDefined();
      expect(item!.title).toBe("Auth Flow Redesign");
      expect(item!.type).toBe("feature");
      expect(item!.kind).toBe("task"); // feature maps to task kind
    });

    it("returns undefined for unknown item", async () => {
      const adapter = createAdapter();
      const item = await adapter.getItem("nonexistent");
      expect(item).toBeUndefined();
    });
  });

  // ─── Type Normalization ────────────────────────────────────────────

  describe("type normalization", () => {
    it("normalizes common type names", async () => {
      const data: JsonPMData = {
        items: [
          { title: "A", type: "Epic" },
          { title: "B", type: "FEATURE" },
          { title: "C", type: "user story" },
          { title: "D", type: "Bug" },
          { title: "E", type: "Milestone" },
          { title: "F", type: "initiative" },
        ],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items.find((i) => i.title === "A")!.type).toBe("epic");
      expect(items.find((i) => i.title === "B")!.type).toBe("feature");
      expect(items.find((i) => i.title === "C")!.type).toBe("story");
      expect(items.find((i) => i.title === "D")!.type).toBe("bug");
      expect(items.find((i) => i.title === "E")!.type).toBe("milestone");
      expect(items.find((i) => i.title === "F")!.type).toBe("epic");
    });

    it("uses defaultItemType for unknown types", async () => {
      const data: JsonPMData = {
        items: [{ title: "Mystery Item", type: "unknown_thing" }],
      };
      const adapter = createAdapter(data, { defaultItemType: "feature" });
      const items = await adapter.extractItems();

      expect(items[0].type).toBe("feature");
    });

    it("defaults to 'task' when no type specified", async () => {
      const data: JsonPMData = {
        items: [{ title: "No Type Item" }],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].type).toBe("task");
    });

    it("maps types to correct PMItemKind", async () => {
      const data: JsonPMData = {
        items: [
          { title: "A", type: "epic" },
          { title: "B", type: "story" },
          { title: "C", type: "bug" },
          { title: "D", type: "task" },
          { title: "E", type: "milestone" },
          { title: "F", type: "label" },
        ],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items.find((i) => i.title === "A")!.kind).toBe("epic");
      expect(items.find((i) => i.title === "B")!.kind).toBe("story");
      expect(items.find((i) => i.title === "C")!.kind).toBe("bug");
      expect(items.find((i) => i.title === "D")!.kind).toBe("task");
      expect(items.find((i) => i.title === "E")!.kind).toBe("milestone");
      expect(items.find((i) => i.title === "F")!.kind).toBe("other");
    });
  });

  // ─── Status Normalization ──────────────────────────────────────────

  describe("status normalization", () => {
    it("normalizes common status labels", async () => {
      const statuses = [
        { input: "To Do", expected: "todo" },
        { input: "Backlog", expected: "todo" },
        { input: "In Progress", expected: "in_progress" },
        { input: "In Review", expected: "in_progress" },
        { input: "Done", expected: "done" },
        { input: "Completed", expected: "done" },
        { input: "Cancelled", expected: "cancelled" },
        { input: "Won't Fix", expected: "cancelled" },
      ];

      for (const { input, expected } of statuses) {
        const data: JsonPMData = {
          items: [{ title: `Status: ${input}`, status: input }],
        };
        const adapter = createAdapter(data);
        const items = await adapter.extractItems();

        expect(items[0].status.category).toBe(expected);
        expect(items[0].status.originalLabel).toBe(input);
      }
    });

    it("defaults to 'unknown' for unrecognized statuses", async () => {
      const data: JsonPMData = {
        items: [{ title: "Custom Status", status: "Awaiting Approval" }],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].status.category).toBe("unknown");
      expect(items[0].status.originalLabel).toBe("Awaiting Approval");
    });

    it("defaults to 'unknown' with empty label when no status", async () => {
      const data: JsonPMData = {
        items: [{ title: "No Status" }],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].status.category).toBe("unknown");
      expect(items[0].status.originalLabel).toBe("");
    });
  });

  // ─── Custom Fields ────────────────────────────────────────────────

  describe("custom field resolution", () => {
    it("resolves typed custom fields from raw values", async () => {
      const data: JsonPMData = {
        items: [
          {
            title: "Custom Fields Item",
            customFields: {
              priority: "P0",
              storyPoints: 5,
              isBlocking: true,
              tags: ["a", "b"],
              complex: { nested: true },
            },
          },
        ],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();
      const cf = items[0].customFields;

      expect(cf.priority).toEqual({ type: "string", value: "P0" });
      expect(cf.storyPoints).toEqual({ type: "number", value: 5 });
      expect(cf.isBlocking).toEqual({ type: "boolean", value: true });
      expect(cf.tags).toEqual({ type: "multi_select", value: ["a", "b"] });
      expect(cf.complex).toEqual({
        type: "unknown",
        value: { nested: true },
      });
    });

    it("defaults to empty custom fields", async () => {
      const data: JsonPMData = {
        items: [{ title: "No Custom Fields" }],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].customFields).toEqual({});
    });
  });

  // ─── Default Project ──────────────────────────────────────────────

  describe("default project for orphan items", () => {
    it("creates a default project for items without projectId", async () => {
      const data: JsonPMData = {
        organization: "Test Org",
        items: [
          { title: "Orphan Item 1" },
          { title: "Orphan Item 2" },
        ],
      };
      const adapter = createAdapter(data);

      const projects = await adapter.listProjects();
      expect(projects.items).toHaveLength(1);
      expect(projects.items[0].externalId).toBe("default");
      expect(projects.items[0].name).toBe("Test Org");
      expect(projects.items[0].metadata.isDefault).toBe(true);

      const items = await adapter.listItems("default");
      expect(items.items).toHaveLength(2);
    });

    it("uses organizationName config for default project name", async () => {
      const data: JsonPMData = {
        items: [{ title: "Orphan" }],
      };
      const adapter = createAdapter(data, {
        organizationName: "My Company",
      });

      const projects = await adapter.listProjects();
      expect(projects.items[0].name).toBe("My Company");
    });
  });

  // ─── Project-Embedded Items ───────────────────────────────────────

  describe("items embedded in projects", () => {
    it("resolves items defined inside project objects", async () => {
      const data: JsonPMData = {
        projects: [
          {
            id: "proj-1",
            name: "Project One",
            items: [
              { title: "Embedded Task 1", type: "task" },
              { title: "Embedded Task 2", type: "bug" },
            ],
          },
        ],
      };
      const adapter = createAdapter(data);

      const items = await adapter.listItems("proj-1");
      expect(items.items).toHaveLength(2);
      expect(items.items[0].title).toBe("Embedded Task 1");
      expect(items.items[0].projectId).toBe("proj-1");
      expect(items.items[0].project).toBe("Project One");
      expect(items.items[1].type).toBe("bug");
    });
  });

  // ─── Auto-Generated IDs ───────────────────────────────────────────

  describe("auto-generated IDs", () => {
    it("generates sequential IDs for items without explicit IDs", async () => {
      const data: JsonPMData = {
        items: [
          { title: "No ID 1" },
          { title: "No ID 2" },
          { title: "No ID 3" },
        ],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].externalId).toBe("json-item-1");
      expect(items[1].externalId).toBe("json-item-2");
      expect(items[2].externalId).toBe("json-item-3");
    });

    it("preserves explicit IDs", async () => {
      const data: JsonPMData = {
        items: [{ id: "my-custom-id", title: "With ID" }],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      expect(items[0].externalId).toBe("my-custom-id");
    });
  });

  // ─── extractItems ─────────────────────────────────────────────────

  describe("extractItems()", () => {
    it("returns all items without options", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems();
      expect(items).toHaveLength(5);
    });

    it("filters by project", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({
        project: "proj-platform",
      });
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.projectId === "proj-platform")).toBe(true);
    });

    it("filters by item types", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({
        itemTypes: ["epic"],
      });
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.type === "epic")).toBe(true);
    });

    it("filters by modifiedAfter", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({
        modifiedAfter: "2025-01-08T00:00:00.000Z",
      });
      // Only items with updatedAt >= 2025-01-08
      expect(items.length).toBeGreaterThanOrEqual(1);
      for (const item of items) {
        expect(item.updatedAt! >= "2025-01-08T00:00:00.000Z").toBe(true);
      }
    });

    it("applies maxItems limit", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({ maxItems: 2 });
      expect(items).toHaveLength(2);
    });

    it("returns empty array for empty data", async () => {
      const adapter = createAdapter({});
      const items = await adapter.extractItems();
      expect(items).toEqual([]);
    });
  });

  // ─── normalizeToTerms ─────────────────────────────────────────────

  describe("normalizeToTerms()", () => {
    it("converts items to NormalizedTerms", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({ maxItems: 1 });
      const terms = adapter.normalizeToTerms(items);

      expect(terms).toHaveLength(1);
      expect(terms[0].name).toBe("Auth Flow Redesign");
      expect(terms[0].source.adapter).toBe("json");
      expect(terms[0].source.externalId).toBe("item-auth");
      expect(terms[0].confidence).toBe("ai-suggested");
    });

    it("deduplicates by title (case-insensitive)", async () => {
      const adapter = createAdapter();
      // Sample data has two items titled "Auth Flow Redesign"
      const items = await adapter.extractItems({ project: "proj-roadmap" });
      const terms = adapter.normalizeToTerms(items);

      const authTerms = terms.filter((t) => t.name === "Auth Flow Redesign");
      expect(authTerms).toHaveLength(1);
    });

    it("skips items with empty titles", () => {
      const adapter = createAdapter();
      const items: PMItem[] = [
        {
          externalId: "empty",
          title: "  ",
          type: "task",
          kind: "task",
          status: { category: "todo", originalLabel: "To Do" },
          labels: [],
          assignees: [],
          projectId: "p",
          customFields: {},
          metadata: {},
        },
      ];
      const terms = adapter.normalizeToTerms(items);
      expect(terms).toHaveLength(0);
    });

    it("uses description as definition when available", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({ maxItems: 1 });
      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].definition).toBe(
        "Redesign the authentication flow to support SSO"
      );
    });

    it("generates synthetic definition when no description", () => {
      const adapter = createAdapter();
      const items: PMItem[] = [
        {
          externalId: "no-desc",
          title: "No Description Item",
          type: "feature",
          kind: "task",
          status: { category: "todo", originalLabel: "To Do" },
          labels: [],
          assignees: [],
          projectId: "p",
          project: "My Project",
          customFields: {},
          metadata: {},
        },
      ];
      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].definition).toContain("Feature from JSON import");
      expect(terms[0].definition).toContain('My Project');
    });

    it("includes item tags in NormalizedTerm tags", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({ maxItems: 1 });
      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].tags).toContain("security");
      expect(terms[0].tags).toContain("frontend");
      expect(terms[0].tags).toContain("feature");
      expect(terms[0].tags).toContain("json-import");
    });

    it("uses project name as category", async () => {
      const adapter = createAdapter();
      const items = await adapter.extractItems({ maxItems: 1 });
      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].category).toBe("Product Roadmap");
    });
  });

  // ─── extract() ────────────────────────────────────────────────────

  describe("extract()", () => {
    it("returns a complete ExtractionResult", async () => {
      const adapter = createAdapter();
      const result = await adapter.extract();

      expect(result.adapterName).toBe("json");
      expect(result.extractedAt).toBeTruthy();
      expect(result.terms.length).toBeGreaterThan(0);
      expect(result.stats.itemsFetched).toBe(5);
      expect(result.stats.termsProduced).toBeGreaterThan(0);
      expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.warnings).toEqual([]);
    });

    it("computes itemsByType statistics", async () => {
      const adapter = createAdapter();
      const result = await adapter.extract();

      expect(result.stats.itemsByType.feature).toBe(1);
      expect(result.stats.itemsByType.epic).toBe(2);
      expect(result.stats.itemsByType.bug).toBe(1);
      expect(result.stats.itemsByType.task).toBe(1);
    });

    it("counts skipped items (duplicates)", async () => {
      const adapter = createAdapter();
      const result = await adapter.extract();

      // 5 items fetched, but "Auth Flow Redesign" appears twice → 1 skipped
      expect(result.stats.itemsSkipped).toBe(
        result.stats.itemsFetched - result.stats.termsProduced
      );
    });

    it("passes options to extractItems", async () => {
      const adapter = createAdapter();
      const result = await adapter.extract({
        project: "proj-platform",
      });

      expect(result.stats.itemsFetched).toBe(2);
      expect(
        result.terms.every((t) => t.category === "Platform Team")
      ).toBe(true);
    });
  });

  // ─── extractTerminology ───────────────────────────────────────────

  describe("extractTerminology()", () => {
    it("surfaces term candidates from a project", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap");

      expect(candidates.length).toBeGreaterThan(0);
      expect(
        candidates.every((c) => c.source.projectId === "proj-roadmap")
      ).toBe(true);
      expect(candidates.every((c) => c.source.adapter === "json")).toBe(true);
    });

    it("deduplicates and counts frequency", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap");

      const authFlow = candidates.find((c) => c.term === "Auth Flow Redesign");
      expect(authFlow).toBeDefined();
      expect(authFlow!.frequency).toBe(2); // Two items with same title
      expect(authFlow!.source.itemIds).toHaveLength(2);
    });

    it("sorts by frequency descending", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap");

      for (let i = 1; i < candidates.length; i++) {
        expect(candidates[i - 1].frequency).toBeGreaterThanOrEqual(
          candidates[i].frequency
        );
      }
    });

    it("respects minFrequency option", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap", {
        minFrequency: 2,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].term).toBe("Auth Flow Redesign");
    });

    it("respects maxItems option", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap", {
        maxItems: 1,
      });

      // With maxItems: 1, only first item is scanned
      expect(candidates.length).toBeLessThanOrEqual(1);
    });

    it("returns empty for unknown project", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("nonexistent");
      expect(candidates).toHaveLength(0);
    });

    it("uses description for context snippet", async () => {
      const adapter = createAdapter();
      const candidates = await adapter.extractTerminology("proj-roadmap");

      const billing = candidates.find((c) => c.term === "Billing API");
      expect(billing).toBeDefined();
      expect(billing!.contextSnippet).toContain("Stripe");
    });

    it("falls back to type + project for context when no description", async () => {
      const data: JsonPMData = {
        projects: [{ id: "p1", name: "My Project" }],
        items: [
          { title: "No Description Term", projectId: "p1" },
        ],
      };
      const adapter = createAdapter(data);
      const candidates = await adapter.extractTerminology("p1", {
        includeDescriptions: false,
      });

      expect(candidates[0].contextSnippet).toContain("task");
      expect(candidates[0].contextSnippet).toContain("My Project");
    });
  });

  // ─── File Loading ─────────────────────────────────────────────────

  describe("file loading", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `lingo-json-test-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("loads data from a JSON file", async () => {
      const filePath = join(tmpDir, "pm-data.json");
      const data: JsonPMData = {
        organization: "File Org",
        projects: [{ id: "fp1", name: "File Project" }],
        items: [
          {
            title: "File Item",
            projectId: "fp1",
          },
        ],
      };
      await writeFile(filePath, JSON.stringify(data));

      const adapter = new JsonAdapter({ filePath });
      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.details?.organization).toBe("File Org");

      const projects = await adapter.listProjects();
      expect(projects.items).toHaveLength(1);

      const items = await adapter.listItems("fp1");
      expect(items.items).toHaveLength(1);
      expect(items.items[0].title).toBe("File Item");
    });

    it("throws PMAdapterError for nonexistent file", async () => {
      const adapter = new JsonAdapter({
        filePath: join(tmpDir, "nonexistent.json"),
      });

      // First access triggers file load
      await expect(adapter.extractItems()).rejects.toThrow(PMAdapterError);
    });

    it("throws PMAdapterError for invalid JSON", async () => {
      const filePath = join(tmpDir, "bad.json");
      await writeFile(filePath, "not valid json {{{");

      const adapter = new JsonAdapter({ filePath });
      await expect(adapter.extractItems()).rejects.toThrow(PMAdapterError);
    });

    it("caches loaded data", async () => {
      const filePath = join(tmpDir, "cached.json");
      await writeFile(filePath, JSON.stringify({
        items: [{ title: "Cached Item" }],
      }));

      const adapter = new JsonAdapter({ filePath });

      // First load
      const items1 = await adapter.extractItems();
      expect(items1).toHaveLength(1);

      // Modify file
      await writeFile(filePath, JSON.stringify({
        items: [{ title: "New Item" }, { title: "Another" }],
      }));

      // Second access uses cache (still 1 item)
      const items2 = await adapter.extractItems();
      expect(items2).toHaveLength(1);
    });

    it("reload() clears cache for fresh load", async () => {
      const filePath = join(tmpDir, "reload.json");
      await writeFile(filePath, JSON.stringify({
        items: [{ title: "Original" }],
      }));

      const adapter = new JsonAdapter({ filePath });
      const items1 = await adapter.extractItems();
      expect(items1).toHaveLength(1);

      // Update and reload
      await writeFile(filePath, JSON.stringify({
        items: [{ title: "New 1" }, { title: "New 2" }],
      }));
      adapter.reload();

      const items2 = await adapter.extractItems();
      expect(items2).toHaveLength(2);
    });
  });

  // ─── Empty / Edge Cases ───────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty data gracefully", async () => {
      const adapter = createAdapter({});

      const projects = await adapter.listProjects();
      expect(projects.items).toHaveLength(0);

      const items = await adapter.extractItems();
      expect(items).toHaveLength(0);

      const result = await adapter.extract();
      expect(result.terms).toHaveLength(0);
      expect(result.stats.itemsFetched).toBe(0);
    });

    it("handles adapter with no config", async () => {
      const adapter = new JsonAdapter({});
      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);
    });

    it("preserves item URL and external URL", async () => {
      const adapter = createAdapter();
      const item = await adapter.getItem("item-auth");

      expect(item!.url).toBe("https://example.com/auth");
      expect(item!.externalUrl).toBe("https://example.com/auth");
    });

    it("preserves assignees", async () => {
      const adapter = createAdapter();
      const item = await adapter.getItem("item-auth");
      expect(item!.assignees).toEqual(["Alice"]);
    });

    it("preserves timestamps", async () => {
      const adapter = createAdapter();
      const item = await adapter.getItem("item-auth");
      expect(item!.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(item!.updatedAt).toBe("2025-01-10T00:00:00.000Z");
    });

    it("preserves parent-child relationships via parentId", async () => {
      const data: JsonPMData = {
        items: [
          { id: "parent", title: "Epic", type: "epic" },
          { id: "child", title: "Story", type: "story", parentId: "parent" },
        ],
      };
      const adapter = createAdapter(data);
      const items = await adapter.extractItems();

      const child = items.find((i) => i.externalId === "child");
      expect(child!.parentId).toBe("parent");
    });
  });
});

// ─── Factory Tests ──────────────────────────────────────────────────

describe("JSON Adapter Factory", () => {
  describe("createJsonAdapter()", () => {
    it("creates an adapter from minimal config", () => {
      const adapter = createJsonAdapter({});
      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("json");
      expect(adapter.displayName).toBe("JSON Import");
    });

    it("creates an adapter with inline data", async () => {
      const adapter = createJsonAdapter({
        data: {
          items: [{ title: "Factory Item" }],
        },
      });
      const result = await adapter.extract();
      expect(result.terms).toHaveLength(1);
      expect(result.terms[0].name).toBe("Factory Item");
    });

    it("passes config fields through", async () => {
      const adapter = createJsonAdapter({
        organizationName: "Factory Org",
        defaultItemType: "feature",
        data: {
          items: [{ title: "Custom Type Item" }],
        },
      });
      const items = await adapter.extractItems();
      expect(items[0].type).toBe("feature");
    });

    it("throws on invalid data type", () => {
      expect(() =>
        createJsonAdapter({ data: "not an object" })
      ).toThrow(PMAdapterError);
    });

    it("throws on invalid filePath type", () => {
      expect(() =>
        createJsonAdapter({ filePath: 123 })
      ).toThrow(PMAdapterError);
    });

    it("throws on invalid defaultItemType type", () => {
      expect(() =>
        createJsonAdapter({ defaultItemType: 42 })
      ).toThrow(PMAdapterError);
    });

    it("throws on invalid organizationName type", () => {
      expect(() =>
        createJsonAdapter({ organizationName: true })
      ).toThrow(PMAdapterError);
    });
  });

  describe("jsonFactoryRegistration", () => {
    it("has correct metadata", () => {
      expect(jsonFactoryRegistration.name).toBe("json");
      expect(jsonFactoryRegistration.displayName).toBe("JSON Import");
      expect(jsonFactoryRegistration.description).toBeTruthy();
      expect(typeof jsonFactoryRegistration.factory).toBe("function");
    });

    it("factory creates a working adapter", async () => {
      const adapter = jsonFactoryRegistration.factory({
        data: { items: [{ title: "Registration Test" }] },
      });

      expect(adapter.name).toBe("json");
      const result = await adapter.extract();
      expect(result.terms[0].name).toBe("Registration Test");
    });
  });
});

// ─── Registry Integration Tests ─────────────────────────────────────

describe("JSON Adapter Registry Integration", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
    resetItemCounter();
  });

  it("JSON adapter is included in BUILTIN_ADAPTER_FACTORIES", () => {
    const names = BUILTIN_ADAPTER_FACTORIES.map((f) => f.name);
    expect(names).toContain("json");
  });

  it("registerBuiltinAdapters registers JSON factory", () => {
    registerBuiltinAdapters(registry);
    expect(registry.hasFactory("json")).toBe(true);
  });

  it("JSON adapter appears in availableAdapters", () => {
    registerBuiltinAdapters(registry);

    const available = registry.availableAdapters;
    const json = available.find((a) => a.name === "json");

    expect(json).toBeDefined();
    expect(json!.displayName).toBe("JSON Import");
    expect(json!.description).toBeTruthy();
    expect(json!.instantiated).toBe(false);
  });

  it("creates JSON adapter via registry factory", () => {
    registerBuiltinAdapters(registry);

    const adapter = registry.createAdapter("json", {
      data: { items: [{ title: "Registry Item" }] },
    });

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("json");
  });

  it("getOrCreate caches JSON adapter instance", () => {
    registerBuiltinAdapters(registry);

    const config = { data: { items: [{ title: "Cached" }] } };
    const first = registry.getOrCreate("json", config);
    const second = registry.getOrCreate("json", config);

    expect(first).toBe(second);
    expect(registry.has("json")).toBe(true);
  });

  it("both Notion and JSON adapters coexist in registry", () => {
    registerBuiltinAdapters(registry);

    expect(registry.hasFactory("notion")).toBe(true);
    expect(registry.hasFactory("json")).toBe(true);

    const available = registry.availableAdapters;
    expect(available.length).toBeGreaterThanOrEqual(2);

    const names = available.map((a) => a.name);
    expect(names).toContain("notion");
    expect(names).toContain("json");
  });

  it("JSON adapter produces NormalizedTerms through registry", async () => {
    registerBuiltinAdapters(registry);

    const adapter = registry.createAdapter("json", {
      data: {
        organization: "Registry Test Org",
        projects: [{ id: "p1", name: "Test Project" }],
        items: [
          {
            title: "Sprint Velocity",
            description: "Story points completed per sprint",
            type: "feature",
            projectId: "p1",
          },
        ],
      },
    });

    const result = await adapter.extract();
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0].name).toBe("Sprint Velocity");
    expect(result.terms[0].definition).toBe(
      "Story points completed per sprint"
    );
    expect(result.terms[0].source.adapter).toBe("json");
  });
});
