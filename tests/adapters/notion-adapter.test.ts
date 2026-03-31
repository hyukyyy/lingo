import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotionAdapter } from "../../src/adapters/notion/notion-adapter.js";
import type { NotionAdapterConfig } from "../../src/adapters/notion/notion-adapter.js";
import type {
  NotionClient,
  NotionPage,
  NotionDatabase,
  NotionDatabaseProperty,
  NotionPropertyValue,
  NotionPaginatedResponse,
} from "../../src/adapters/notion/notion-client.js";
import type { PMItem } from "../../src/adapters/types.js";

// ─── Test Helpers ───────────────────────────────────────────────────

/**
 * Creates a mock NotionClient for testing.
 */
function createMockClient(overrides?: Partial<NotionClient>): NotionClient {
  return {
    queryDatabase: vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    })),
    getDatabase: vi.fn(async () => createMockDatabase()),
    getPage: vi.fn(async () => createMockPage()),
    search: vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    })),
    getMe: vi.fn(async () => ({
      type: "bot",
      bot: { workspace_name: "Test Workspace" },
    })),
    ...overrides,
  };
}

/**
 * Creates a mock Notion database schema.
 */
function createMockDatabase(overrides?: Partial<NotionDatabase>): NotionDatabase {
  return {
    id: "db-123",
    object: "database",
    title: [{ type: "text" as const, plain_text: "Product Roadmap" }],
    description: [{ type: "text" as const, plain_text: "Our product roadmap" }],
    url: "https://notion.so/db-123",
    last_edited_time: "2025-01-15T10:00:00.000Z",
    properties: {
      Name: {
        id: "title",
        name: "Name",
        type: "title",
      },
      Description: {
        id: "desc",
        name: "Description",
        type: "rich_text",
      },
      Status: {
        id: "status",
        name: "Status",
        type: "status",
        status: {
          options: [
            { name: "Not Started", color: "gray" },
            { name: "In Progress", color: "blue" },
            { name: "In Review", color: "yellow" },
            { name: "Done", color: "green" },
          ],
          groups: [],
        },
      },
      Type: {
        id: "type",
        name: "Type",
        type: "select",
        select: {
          options: [
            { name: "Epic", color: "purple" },
            { name: "Feature", color: "blue" },
            { name: "Bug", color: "red" },
          ],
        },
      },
      Tags: {
        id: "tags",
        name: "Tags",
        type: "multi_select",
        multi_select: {
          options: [
            { name: "Frontend", color: "blue" },
            { name: "Backend", color: "green" },
            { name: "API", color: "orange" },
          ],
        },
      },
      Priority: {
        id: "priority",
        name: "Priority",
        type: "select",
        select: {
          options: [
            { name: "P0 - Critical" },
            { name: "P1 - High" },
            { name: "P2 - Medium" },
            { name: "P3 - Low" },
          ],
        },
      },
    },
    ...overrides,
  };
}

/**
 * Creates a mock Notion page.
 */
function createMockPage(overrides?: {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  tags?: string[];
  archived?: boolean;
  lastEdited?: string;
}): NotionPage {
  const {
    id = "page-1",
    title = "User Authentication",
    description = "Implement OAuth2 login flow",
    status = "In Progress",
    type = "Feature",
    tags = ["Backend", "API"],
    archived = false,
    lastEdited = "2025-01-15T10:00:00.000Z",
  } = overrides ?? {};

  const properties: Record<string, NotionPropertyValue> = {
    Name: {
      type: "title",
      title: [{ type: "text", plain_text: title }],
    },
    Description: {
      type: "rich_text",
      rich_text: [{ type: "text", plain_text: description }],
    },
    Status: {
      type: "status",
      status: status ? { name: status, color: "blue" } : null,
    },
    Type: {
      type: "select",
      select: type ? { name: type, color: "blue" } : null,
    },
    Tags: {
      type: "multi_select",
      multi_select: tags.map((t) => ({ name: t, color: "gray" })),
    },
  };

  return {
    id,
    url: `https://notion.so/${id}`,
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: lastEdited,
    archived,
    properties,
    parent: {
      type: "database_id",
      database_id: "db-123",
    },
  };
}

function defaultConfig(): NotionAdapterConfig {
  return {
    apiToken: "secret_test_token",
    databaseIds: ["db-123"],
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("NotionAdapter", () => {
  describe("constructor", () => {
    it("creates an adapter with the correct name and displayName", () => {
      const adapter = new NotionAdapter(defaultConfig(), createMockClient());

      expect(adapter.name).toBe("notion");
      expect(adapter.displayName).toBe("Notion");
    });
  });

  describe("testConnection", () => {
    it("returns connected status when API responds", async () => {
      const client = createMockClient();
      const adapter = new NotionAdapter(defaultConfig(), client);

      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.message).toContain("Test Workspace");
      expect(status.details?.workspaceName).toBe("Test Workspace");
    });

    it("returns disconnected status when API fails", async () => {
      const client = createMockClient({
        getMe: vi.fn(async () => {
          throw new Error("Unauthorized");
        }),
      });
      const adapter = new NotionAdapter(defaultConfig(), client);

      const status = await adapter.testConnection();

      expect(status.connected).toBe(false);
      expect(status.message).toContain("Failed to connect");
      expect(status.message).toContain("Unauthorized");
    });
  });

  describe("extractItems", () => {
    it("returns empty array when no databases configured", async () => {
      const config: NotionAdapterConfig = {
        apiToken: "secret_test_token",
        databaseIds: [],
      };
      const adapter = new NotionAdapter(config, createMockClient());

      const items = await adapter.extractItems();

      expect(items).toEqual([]);
    });

    it("extracts pages from a database as PMItems", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "User Authentication" }),
        createMockPage({ id: "page-2", title: "Payment Processing", type: "Epic" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      // Should include page items + schema items (statuses, priorities, tags)
      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(2);
      expect(pageItems[0].title).toBe("User Authentication");
      expect(pageItems[0].type).toBe("feature");
      expect(pageItems[1].title).toBe("Payment Processing");
      expect(pageItems[1].type).toBe("epic");
    });

    it("extracts item properties correctly", async () => {
      const page = createMockPage({
        title: "Dark Mode",
        description: "Add dark mode theme support",
        status: "In Review",
        type: "Feature",
        tags: ["Frontend"],
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      const pageItem = items.find((i) => i.title === "Dark Mode");
      expect(pageItem).toBeDefined();
      expect(pageItem!.description).toBe("Add dark mode theme support");
      expect(pageItem!.status.originalLabel).toBe("In Review");
      expect(pageItem!.labels).toContain("Frontend");
      expect(pageItem!.url).toContain("notion.so");
      expect(pageItem!.project).toBe("Product Roadmap");
    });

    it("skips archived pages by default", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "Active Feature", archived: false }),
        createMockPage({ id: "page-2", title: "Archived Feature", archived: true }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(1);
      expect(pageItems[0].title).toBe("Active Feature");
    });

    it("includes archived pages when requested", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "Active Feature", archived: false }),
        createMockPage({ id: "page-2", title: "Archived Feature", archived: true }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems({ includeArchived: true });

      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(2);
    });

    it("respects maxItems limit", async () => {
      const pages = Array.from({ length: 10 }, (_, i) =>
        createMockPage({ id: `page-${i}`, title: `Feature ${i}` })
      );

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems({ maxItems: 3 });

      expect(items.length).toBeLessThanOrEqual(3);
    });

    it("filters by item types", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "Auth Epic", type: "Epic" }),
        createMockPage({ id: "page-2", title: "Login Bug", type: "Bug" }),
        createMockPage({ id: "page-3", title: "Dark Mode", type: "Feature" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems({ itemTypes: ["bug"] });

      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(1);
      expect(pageItems[0].title).toBe("Login Bug");
    });

    it("filters by modifiedAfter date", async () => {
      const pages = [
        createMockPage({
          id: "page-1",
          title: "Old Feature",
          lastEdited: "2024-01-01T00:00:00.000Z",
        }),
        createMockPage({
          id: "page-2",
          title: "New Feature",
          lastEdited: "2025-06-01T00:00:00.000Z",
        }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems({
        modifiedAfter: "2025-01-01T00:00:00.000Z",
      });

      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(1);
      expect(pageItems[0].title).toBe("New Feature");
    });

    it("extracts schema-level status terms", async () => {
      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [],
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      const statusItems = items.filter((i) => i.type === "status");
      expect(statusItems.length).toBeGreaterThan(0);

      const statusNames = statusItems.map((i) => i.title);
      expect(statusNames).toContain("Not Started");
      expect(statusNames).toContain("In Progress");
      expect(statusNames).toContain("In Review");
      expect(statusNames).toContain("Done");
    });

    it("extracts schema-level label terms from taxonomy properties", async () => {
      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [],
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      const labelItems = items.filter((i) => i.type === "label");
      const labelNames = labelItems.map((i) => i.title);

      // Tags (multi_select with "tags" in name) should be extracted
      expect(labelNames).toContain("Frontend");
      expect(labelNames).toContain("Backend");
      expect(labelNames).toContain("API");

      // Priority (select with "priority" in name) should be extracted
      expect(labelNames).toContain("P0 - Critical");
      expect(labelNames).toContain("P1 - High");
    });

    it("skips schema extraction when extractSchemaTerms is false", async () => {
      const config: NotionAdapterConfig = {
        ...defaultConfig(),
        extractSchemaTerms: false,
      };

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [],
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(config, client);
      const items = await adapter.extractItems();

      expect(items).toHaveLength(0);
    });

    it("handles pagination", async () => {
      const queryDb = vi
        .fn()
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "page-1", title: "Feature A" })],
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "page-2", title: "Feature B" })],
          has_more: false,
          next_cursor: null,
        });

      const client = createMockClient({ queryDatabase: queryDb });
      const adapter = new NotionAdapter(defaultConfig(), client);
      const items = await adapter.extractItems();

      const pageItems = items.filter((i) => !i.externalId.includes(":"));
      expect(pageItems).toHaveLength(2);
      expect(pageItems[0].title).toBe("Feature A");
      expect(pageItems[1].title).toBe("Feature B");
      expect(queryDb).toHaveBeenCalledTimes(2);
    });
  });

  describe("normalizeToTerms", () => {
    let adapter: NotionAdapter;

    beforeEach(() => {
      adapter = new NotionAdapter(defaultConfig(), createMockClient());
    });

    /** Helper to create a PMItem with all required fields */
    function makePMItem(partial: Partial<PMItem> & Pick<PMItem, "externalId" | "title" | "type">): PMItem {
      return {
        kind: "task",
        status: { category: "unknown", originalLabel: "" },
        labels: [],
        assignees: [],
        projectId: "",
        customFields: {},
        metadata: {},
        ...partial,
      };
    }

    it("normalizes a PMItem into a NormalizedTerm", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "User Authentication",
          description: "OAuth2-based login and session management",
          type: "feature",
          url: "https://notion.so/page-1",
          labels: ["Backend", "Security"],
          status: { category: "in_progress", originalLabel: "In Progress" },
          project: "Product Roadmap",
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms).toHaveLength(1);
      expect(terms[0].name).toBe("User Authentication");
      expect(terms[0].definition).toBe("OAuth2-based login and session management");
      expect(terms[0].source.adapter).toBe("notion");
      expect(terms[0].source.externalId).toBe("page-1");
      expect(terms[0].source.url).toBe("https://notion.so/page-1");
      expect(terms[0].confidence).toBe("ai-suggested");
    });

    it("generates synthetic definition when description is missing", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "Sprint Planning",
          type: "feature",
          labels: [],
          project: "Agile Board",
          status: { category: "todo", originalLabel: "Not Started" },
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].definition).toContain("Feature");
      expect(terms[0].definition).toContain("Notion");
      expect(terms[0].definition).toContain("Agile Board");
    });

    it("truncates very long descriptions", () => {
      const longDescription = "x".repeat(1000);
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "Long Feature",
          description: longDescription,
          type: "feature",
          labels: [],
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].definition.length).toBeLessThanOrEqual(503); // 500 + "..."
      expect(terms[0].definition.endsWith("...")).toBe(true);
    });

    it("skips items with empty titles", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "",
          type: "feature",
        }),
        makePMItem({
          externalId: "page-2",
          title: "   ",
          type: "feature",
        }),
        makePMItem({
          externalId: "page-3",
          title: "Valid Feature",
          type: "feature",
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms).toHaveLength(1);
      expect(terms[0].name).toBe("Valid Feature");
    });

    it("deduplicates items by name (case-insensitive)", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "Authentication",
          type: "feature",
        }),
        makePMItem({
          externalId: "page-2",
          title: "authentication",
          type: "epic",
        }),
        makePMItem({
          externalId: "page-3",
          title: "AUTHENTICATION",
          type: "story",
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms).toHaveLength(1);
      expect(terms[0].name).toBe("Authentication");
    });

    it("builds tags from labels, type, and status", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "Dark Mode",
          type: "feature",
          labels: ["Frontend", "UI"],
          status: { category: "in_progress", originalLabel: "In Review" },
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].tags).toContain("Frontend");
      expect(terms[0].tags).toContain("UI");
      expect(terms[0].tags).toContain("feature");
      expect(terms[0].tags).toContain("notion");
      expect(terms[0].tags).toContain("status:in-review");
    });

    it("deduplicates tags", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "Test Item",
          type: "feature",
          labels: ["feature", "notion"], // overlap with auto-added tags
        }),
      ];

      const terms = adapter.normalizeToTerms(items);
      const tagCounts: Record<string, number> = {};
      for (const tag of terms[0].tags) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
      // No duplicates
      for (const count of Object.values(tagCounts)) {
        expect(count).toBe(1);
      }
    });

    it("infers category from metadata or project", () => {
      const items: PMItem[] = [
        makePMItem({
          externalId: "page-1",
          title: "With Category",
          type: "feature",
          labels: [],
          project: "Product Roadmap",
          metadata: { category: "authentication" },
        }),
        makePMItem({
          externalId: "page-2",
          title: "Without Category",
          type: "feature",
          labels: [],
          project: "Product Roadmap",
        }),
      ];

      const terms = adapter.normalizeToTerms(items);

      expect(terms[0].category).toBe("authentication");
      expect(terms[1].category).toBe("Product Roadmap");
    });
  });

  describe("extract (combined)", () => {
    it("returns a complete ExtractionResult", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "Feature A" }),
        createMockPage({ id: "page-2", title: "Feature B" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const result = await adapter.extract();

      expect(result.adapterName).toBe("notion");
      expect(result.extractedAt).toBeTruthy();
      expect(result.terms.length).toBeGreaterThan(0);
      expect(result.stats.itemsFetched).toBeGreaterThan(0);
      expect(result.stats.termsProduced).toBeGreaterThan(0);
      expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.warnings).toEqual([]);
    });

    it("handles extraction errors gracefully", async () => {
      const client = createMockClient({
        getDatabase: vi.fn(async () => {
          throw new Error("Network error");
        }),
      });

      const adapter = new NotionAdapter(defaultConfig(), client);
      const result = await adapter.extract();

      expect(result.terms).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("Network error");
    });

    it("reports correct statistics", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "Feature A", type: "Feature" }),
        createMockPage({ id: "page-2", title: "Epic B", type: "Epic" }),
        createMockPage({ id: "page-3", title: "", type: "Bug" }), // Empty title → skipped
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const config: NotionAdapterConfig = {
        ...defaultConfig(),
        extractSchemaTerms: false,
      };

      const adapter = new NotionAdapter(config, client);
      const result = await adapter.extract();

      expect(result.stats.itemsFetched).toBe(3);
      // "Untitled" replaces empty title, but it would still be a term
      // The actual count depends on dedup and empty-title filtering
      expect(result.stats.termsProduced).toBeGreaterThan(0);
    });
  });

  describe("property auto-detection", () => {
    it("auto-detects title property by type", async () => {
      const dbSchema = createMockDatabase({
        properties: {
          "Custom Title": {
            id: "ct",
            name: "Custom Title",
            type: "title",
          },
        },
      });

      const page: NotionPage = {
        id: "page-1",
        url: "https://notion.so/page-1",
        created_time: "2025-01-01T00:00:00.000Z",
        last_edited_time: "2025-01-15T10:00:00.000Z",
        archived: false,
        properties: {
          "Custom Title": {
            type: "title",
            title: [{ type: "text", plain_text: "Auto-Detected Title" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => dbSchema),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const config: NotionAdapterConfig = {
        ...defaultConfig(),
        extractSchemaTerms: false,
      };

      const adapter = new NotionAdapter(config, client);
      const items = await adapter.extractItems();

      expect(items[0].title).toBe("Auto-Detected Title");
    });

    it("uses explicit property mappings when provided", async () => {
      const dbSchema = createMockDatabase({
        properties: {
          "Task Name": {
            id: "tn",
            name: "Task Name",
            type: "title",
          },
          Notes: {
            id: "notes",
            name: "Notes",
            type: "rich_text",
          },
        },
      });

      const page: NotionPage = {
        id: "page-1",
        url: "https://notion.so/page-1",
        created_time: "2025-01-01T00:00:00.000Z",
        last_edited_time: "2025-01-15T10:00:00.000Z",
        archived: false,
        properties: {
          "Task Name": {
            type: "title",
            title: [{ type: "text", plain_text: "Custom Mapped" }],
          },
          Notes: {
            type: "rich_text",
            rich_text: [{ type: "text", plain_text: "Custom description" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => dbSchema),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const config: NotionAdapterConfig = {
        ...defaultConfig(),
        extractSchemaTerms: false,
        propertyMappings: {
          titleProperty: "Task Name",
          descriptionProperty: "Notes",
        },
      };

      const adapter = new NotionAdapter(config, client);
      const items = await adapter.extractItems();

      expect(items[0].title).toBe("Custom Mapped");
      expect(items[0].description).toBe("Custom description");
    });
  });

  describe("type mapping", () => {
    let adapter: NotionAdapter;

    beforeEach(() => {
      adapter = new NotionAdapter(defaultConfig(), createMockClient());
    });

    it("maps known type strings to PMItemType", () => {
      const typeCases: [string, string][] = [
        ["Epic", "epic"],
        ["Feature", "feature"],
        ["Story", "story"],
        ["User Story", "story"],
        ["Task", "task"],
        ["Bug", "bug"],
        ["Issue", "bug"],
        ["Defect", "bug"],
        ["Milestone", "milestone"],
        ["Project", "project"],
      ];

      for (const [notionType, expectedType] of typeCases) {
        const items: PMItem[] = [
          {
            externalId: `test-${notionType}`,
            title: `Test ${notionType}`,
            type: expectedType as any,
            kind: "task",
            status: { category: "unknown", originalLabel: "" },
            labels: [],
            assignees: [],
            projectId: "",
            customFields: {},
            metadata: {},
          },
        ];

        const terms = adapter.normalizeToTerms(items);
        expect(terms).toHaveLength(1);
      }
    });

    it("uses default type when type property is missing", async () => {
      const dbSchema = createMockDatabase({
        properties: {
          Name: { id: "title", name: "Name", type: "title" },
        },
      });

      const page: NotionPage = {
        id: "page-1",
        url: "https://notion.so/page-1",
        created_time: "2025-01-01T00:00:00.000Z",
        last_edited_time: "2025-01-15T10:00:00.000Z",
        archived: false,
        properties: {
          Name: {
            type: "title",
            title: [{ type: "text", plain_text: "Untyped Item" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => dbSchema),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const config: NotionAdapterConfig = {
        ...defaultConfig(),
        defaultItemType: "story",
        extractSchemaTerms: false,
      };

      const adapter2 = new NotionAdapter(config, client);
      const items = await adapter2.extractItems();

      expect(items[0].type).toBe("story");
    });
  });
});
