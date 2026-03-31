/**
 * Tests for the Notion Planning Item Extractor.
 *
 * Tests cover:
 * - Querying Notion databases and transforming pages to PMItem format
 * - Property auto-detection from database schemas
 * - Status normalization (Notion label → PMStatusCategory)
 * - Kind mapping (Notion type → PlanningItemKind)
 * - Pagination handling
 * - Filtering (by kind, status category, updatedAfter, maxItems)
 * - Custom field extraction
 * - Assignee extraction from people properties
 * - Project (database) listing and fetching
 * - Edge cases (empty databases, missing properties, archived pages)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NotionItemExtractor,
  normalizeStatusCategory,
  mapToItemKind,
} from "../../src/adapters/notion/notion-item-extractor.js";
import type {
  NotionExtractorConfig,
  PlanningItemKind,
} from "../../src/adapters/notion/notion-item-extractor.js";
import type {
  NotionClient,
  NotionPage,
  NotionDatabase,
  NotionDatabaseProperty,
  NotionPropertyValue,
} from "../../src/adapters/notion/notion-client.js";
import type { PMStatusCategory } from "../../src/adapters/types.js";

// ─── Test Helpers ───────────────────────────────────────────────────

function createMockClient(overrides?: Partial<NotionClient>): NotionClient {
  return {
    queryDatabase: vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    })),
    getDatabase: vi.fn(async () => createMockDatabase()),
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

function createMockDatabase(
  overrides?: Partial<NotionDatabase>
): NotionDatabase {
  return {
    id: "db-123",
    title: [{ type: "text" as const, plain_text: "Product Roadmap" }],
    description: [
      { type: "text" as const, plain_text: "Our product roadmap database" },
    ],
    url: "https://notion.so/db-123",
    properties: {
      Name: { id: "title", name: "Name", type: "title" },
      Description: { id: "desc", name: "Description", type: "rich_text" },
      Status: {
        id: "status",
        name: "Status",
        type: "status",
        status: {
          options: [
            { name: "Not Started", color: "gray" },
            { name: "In Progress", color: "blue" },
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
          ],
        },
      },
      Assignee: {
        id: "assignee",
        name: "Assignee",
        type: "people",
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
          ],
        },
      },
    },
    ...overrides,
  };
}

function createMockPage(overrides?: {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  tags?: string[];
  archived?: boolean;
  lastEdited?: string;
  createdTime?: string;
  assignees?: { name?: string; id: string }[];
  extraProperties?: Record<string, NotionPropertyValue>;
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
    createdTime = "2025-01-01T00:00:00.000Z",
    assignees = [],
    extraProperties = {},
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
    Assignee: {
      type: "people",
      people: assignees,
    },
    ...extraProperties,
  };

  return {
    id,
    url: `https://notion.so/${id}`,
    created_time: createdTime,
    last_edited_time: lastEdited,
    archived,
    properties,
    parent: {
      type: "database_id",
      database_id: "db-123",
    },
  };
}

// ─── normalizeStatusCategory Tests ──────────────────────────────────

describe("normalizeStatusCategory", () => {
  it("maps 'todo' family statuses", () => {
    const todoCases = [
      "Not Started",
      "Backlog",
      "To Do",
      "TODO",
      "Planned",
      "Open",
      "New",
    ];

    for (const label of todoCases) {
      expect(
        normalizeStatusCategory(label),
        `Expected "${label}" → "todo"`
      ).toBe("todo");
    }
  });

  it("maps 'in_progress' family statuses", () => {
    const inProgressCases = [
      "In Progress",
      "In Development",
      "In Review",
      "Active",
      "Doing",
      "Started",
      "WIP",
      "Work in Progress",
    ];

    for (const label of inProgressCases) {
      expect(
        normalizeStatusCategory(label),
        `Expected "${label}" → "in_progress"`
      ).toBe("in_progress");
    }
  });

  it("maps 'done' family statuses", () => {
    const doneCases = [
      "Done",
      "Complete",
      "Completed",
      "Closed",
      "Resolved",
      "Shipped",
      "Released",
      "Merged",
    ];

    for (const label of doneCases) {
      expect(
        normalizeStatusCategory(label),
        `Expected "${label}" → "done"`
      ).toBe("done");
    }
  });

  it("maps 'cancelled' family statuses", () => {
    const cancelledCases = [
      "Cancelled",
      "Canceled",
      "Abandoned",
      "Won't Do",
      "Wontfix",
      "Duplicate",
      "Rejected",
    ];

    for (const label of cancelledCases) {
      expect(
        normalizeStatusCategory(label),
        `Expected "${label}" → "cancelled"`
      ).toBe("cancelled");
    }
  });

  it("returns 'unknown' for unrecognized statuses", () => {
    expect(normalizeStatusCategory("Custom Status")).toBe("unknown");
    expect(normalizeStatusCategory("Waiting for Review")).toBe("unknown");
    expect(normalizeStatusCategory("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(normalizeStatusCategory("IN PROGRESS")).toBe("in_progress");
    expect(normalizeStatusCategory("done")).toBe("done");
    expect(normalizeStatusCategory("NOT STARTED")).toBe("todo");
  });

  it("trims whitespace", () => {
    expect(normalizeStatusCategory("  In Progress  ")).toBe("in_progress");
    expect(normalizeStatusCategory("  Done  ")).toBe("done");
  });
});

// ─── mapToItemKind Tests ────────────────────────────────────────────

describe("mapToItemKind", () => {
  it("maps known type strings to PlanningItemKind", () => {
    const cases: [string, PlanningItemKind][] = [
      ["Epic", "epic"],
      ["Feature", "task"],
      ["Story", "story"],
      ["User Story", "story"],
      ["Task", "task"],
      ["Bug", "bug"],
      ["Issue", "bug"],
      ["Defect", "bug"],
      ["Page", "page"],
      ["Doc", "page"],
      ["Documentation", "page"],
      ["Milestone", "milestone"],
      ["Release", "milestone"],
    ];

    for (const [input, expected] of cases) {
      expect(mapToItemKind(input, "other"), `Expected "${input}" → "${expected}"`).toBe(
        expected
      );
    }
  });

  it("returns fallback for unrecognized types", () => {
    expect(mapToItemKind("Unknown Type", "task")).toBe("task");
    expect(mapToItemKind("Spike", "other")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(mapToItemKind("EPIC", "other")).toBe("epic");
    expect(mapToItemKind("bug", "other")).toBe("bug");
  });
});

// ─── NotionItemExtractor Tests ──────────────────────────────────────

describe("NotionItemExtractor", () => {
  describe("extractItems", () => {
    it("extracts pages from a database as PMItems", async () => {
      const pages = [
        createMockPage({ id: "page-1", title: "User Auth", type: "Feature" }),
        createMockPage({ id: "page-2", title: "Payment Flow", type: "Epic" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it("transforms Notion page properties into PMItem fields", async () => {
      const page = createMockPage({
        id: "page-1",
        title: "Dark Mode Support",
        description: "Add dark mode theme to the application",
        status: "In Progress",
        type: "Feature",
        tags: ["Frontend", "UI"],
        createdTime: "2025-01-01T00:00:00.000Z",
        lastEdited: "2025-01-15T10:00:00.000Z",
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");
      const item = result.items[0];

      expect(item.externalId).toBe("page-1");
      expect(item.title).toBe("Dark Mode Support");
      expect(item.description).toBe("Add dark mode theme to the application");
      expect(item.kind).toBe("task"); // "Feature" maps to "task" in PlanningItemKind
      expect(item.status.category).toBe("in_progress");
      expect(item.status.originalLabel).toBe("In Progress");
      expect(item.labels).toEqual(["Frontend", "UI"]);
      expect(item.projectId).toBe("db-123");
      expect(item.externalUrl).toContain("notion.so");
      expect(item.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(item.updatedAt).toBe("2025-01-15T10:00:00.000Z");
    });

    it("sets correct kind for epics", async () => {
      const page = createMockPage({ type: "Epic" });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].kind).toBe("epic");
    });

    it("sets correct kind for bugs", async () => {
      const page = createMockPage({ type: "Bug" });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].kind).toBe("bug");
    });

    it("uses default kind when type property is missing", async () => {
      const db = createMockDatabase({
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
            title: [{ type: "text", plain_text: "My Task" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => db),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].kind).toBe("task"); // default kind
    });

    it("uses configured default kind", async () => {
      const db = createMockDatabase({
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
            title: [{ type: "text", plain_text: "My Story" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => db),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client, {
        defaultItemKind: "story",
      });
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].kind).toBe("story");
    });

    it("normalizes status labels into categories", async () => {
      const statusCases: [string, PMStatusCategory][] = [
        ["Not Started", "todo"],
        ["In Progress", "in_progress"],
        ["Done", "done"],
        ["Cancelled", "cancelled"],
      ];

      for (const [statusLabel, expectedCategory] of statusCases) {
        const page = createMockPage({ status: statusLabel });

        const client = createMockClient({
          queryDatabase: vi.fn(async () => ({
            results: [page],
            has_more: false,
            next_cursor: null,
          })),
        });

        const extractor = new NotionItemExtractor(client);
        const result = await extractor.extractItems("db-123");

        expect(result.items[0].status.category).toBe(expectedCategory);
        expect(result.items[0].status.originalLabel).toBe(statusLabel);
      }
    });

    it("sets status to unknown when status property is missing", async () => {
      const page = createMockPage({ status: "" });
      // Override the Status property to have null
      page.properties.Status = { type: "status", status: null };

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].status.category).toBe("unknown");
      expect(result.items[0].status.originalLabel).toBe("");
    });

    it("skips archived pages by default", async () => {
      const pages = [
        createMockPage({ id: "active", title: "Active", archived: false }),
        createMockPage({ id: "archived", title: "Archived", archived: true }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Active");
    });

    it("includes archived pages when configured", async () => {
      const pages = [
        createMockPage({ id: "active", title: "Active", archived: false }),
        createMockPage({ id: "archived", title: "Archived", archived: true }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client, {
        includeArchived: true,
      });
      const result = await extractor.extractItems("db-123");

      expect(result.items).toHaveLength(2);
    });

    it("uses Untitled for pages with empty titles", async () => {
      const page = createMockPage({ title: "" });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].title).toBe("Untitled");
    });

    it("stores database title in metadata", async () => {
      const page = createMockPage();

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].metadata.databaseTitle).toBe("Product Roadmap");
    });

    it("returns empty items for empty database", async () => {
      const client = createMockClient();
      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("extractItems — filtering", () => {
    it("filters by kind", async () => {
      const pages = [
        createMockPage({ id: "p1", title: "Auth Epic", type: "Epic" }),
        createMockPage({ id: "p2", title: "Login Bug", type: "Bug" }),
        createMockPage({ id: "p3", title: "Dashboard", type: "Feature" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", {
        kinds: ["bug"],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Login Bug");
    });

    it("filters by multiple kinds", async () => {
      const pages = [
        createMockPage({ id: "p1", title: "Auth Epic", type: "Epic" }),
        createMockPage({ id: "p2", title: "Login Bug", type: "Bug" }),
        createMockPage({ id: "p3", title: "Dashboard", type: "Feature" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", {
        kinds: ["epic", "bug"],
      });

      expect(result.items).toHaveLength(2);
      const titles = result.items.map((i) => i.title);
      expect(titles).toContain("Auth Epic");
      expect(titles).toContain("Login Bug");
    });

    it("filters by status category", async () => {
      const pages = [
        createMockPage({ id: "p1", title: "Todo Item", status: "Not Started" }),
        createMockPage({ id: "p2", title: "WIP Item", status: "In Progress" }),
        createMockPage({ id: "p3", title: "Done Item", status: "Done" }),
      ];

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", {
        statusCategory: "in_progress",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("WIP Item");
    });

    it("filters by updatedAfter", async () => {
      const pages = [
        createMockPage({
          id: "p1",
          title: "Old Item",
          lastEdited: "2024-01-01T00:00:00.000Z",
        }),
        createMockPage({
          id: "p2",
          title: "New Item",
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

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", {
        updatedAfter: "2025-01-01T00:00:00.000Z",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("New Item");
    });

    it("respects maxItems limit", async () => {
      const pages = Array.from({ length: 10 }, (_, i) =>
        createMockPage({ id: `page-${i}`, title: `Item ${i}` })
      );

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: pages,
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", { maxItems: 3 });

      expect(result.items).toHaveLength(3);
    });
  });

  describe("extractItems — pagination", () => {
    it("handles multi-page results", async () => {
      const queryDb = vi
        .fn()
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "p1", title: "Item A" })],
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "p2", title: "Item B" })],
          has_more: false,
          next_cursor: null,
        });

      const client = createMockClient({ queryDatabase: queryDb });
      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe("Item A");
      expect(result.items[1].title).toBe("Item B");
      expect(queryDb).toHaveBeenCalledTimes(2);
    });

    it("passes cursor to subsequent queries", async () => {
      const queryDb = vi
        .fn()
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "p1", title: "Item A" })],
          has_more: true,
          next_cursor: "abc-cursor",
        })
        .mockResolvedValueOnce({
          results: [],
          has_more: false,
          next_cursor: null,
        });

      const client = createMockClient({ queryDatabase: queryDb });
      const extractor = new NotionItemExtractor(client);
      await extractor.extractItems("db-123");

      // Second call should include the cursor
      expect(queryDb).toHaveBeenCalledTimes(2);
      const secondCall = queryDb.mock.calls[1][0];
      expect(secondCall.start_cursor).toBe("abc-cursor");
    });

    it("stops pagination when maxItems is reached mid-page", async () => {
      const pages = Array.from({ length: 5 }, (_, i) =>
        createMockPage({ id: `page-${i}`, title: `Item ${i}` })
      );

      const queryDb = vi.fn().mockResolvedValueOnce({
        results: pages,
        has_more: true,
        next_cursor: "more-cursor",
      });

      const client = createMockClient({ queryDatabase: queryDb });
      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", { maxItems: 3 });

      expect(result.items).toHaveLength(3);
      // Should not fetch second page since maxItems was reached
      expect(queryDb).toHaveBeenCalledTimes(1);
    });
  });

  describe("extractItems — assignees", () => {
    it("extracts assignee names from people property", async () => {
      const page = createMockPage({
        assignees: [
          { name: "Alice", id: "user-1" },
          { name: "Bob", id: "user-2" },
        ],
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].assignees).toEqual(["Alice", "Bob"]);
    });

    it("handles unnamed assignees with fallback ID", async () => {
      const page = createMockPage({
        assignees: [{ id: "user-abcd-1234-efgh" }],
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].assignees).toHaveLength(1);
      expect(result.items[0].assignees[0]).toContain("User");
    });

    it("returns empty assignees when no people property exists", async () => {
      const db = createMockDatabase({
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
            title: [{ type: "text", plain_text: "No Assignee" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => db),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].assignees).toEqual([]);
    });
  });

  describe("extractItems — custom fields", () => {
    it("extracts non-standard properties as custom fields", async () => {
      const page = createMockPage({
        extraProperties: {
          Priority: {
            type: "select",
            select: { name: "P1 - High", color: "red" },
          },
          "Story Points": {
            type: "number",
            number: 8,
          },
          "Due Date": {
            type: "date",
            date: { start: "2025-03-15" },
          },
          "Is Blocking": {
            type: "checkbox",
            checkbox: true,
          },
          "Related URL": {
            type: "url",
            url: "https://example.com/spec",
          },
        },
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");
      const customFields = result.items[0].customFields;

      expect(customFields["Priority"]).toEqual({
        type: "select",
        value: "P1 - High",
      });
      expect(customFields["Story Points"]).toEqual({
        type: "number",
        value: 8,
      });
      expect(customFields["Due Date"]).toEqual({
        type: "date",
        value: "2025-03-15",
      });
      expect(customFields["Is Blocking"]).toEqual({
        type: "boolean",
        value: true,
      });
      expect(customFields["Related URL"]).toEqual({
        type: "url",
        value: "https://example.com/spec",
      });
    });

    it("excludes standard mapped properties from custom fields", async () => {
      const page = createMockPage({
        title: "Test Item",
        description: "Test description",
        status: "In Progress",
        type: "Feature",
        tags: ["Backend"],
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");
      const customFields = result.items[0].customFields;

      // Standard fields should NOT appear in customFields
      expect(customFields).not.toHaveProperty("Name");
      expect(customFields).not.toHaveProperty("Description");
      expect(customFields).not.toHaveProperty("Status");
      expect(customFields).not.toHaveProperty("Type");
      expect(customFields).not.toHaveProperty("Tags");
    });

    it("handles null property values gracefully", async () => {
      const page = createMockPage({
        extraProperties: {
          "Empty Select": {
            type: "select",
            select: null,
          },
          "Empty Number": {
            type: "number",
            number: null,
          },
          "Empty URL": {
            type: "url",
            url: null,
          },
          "Empty Date": {
            type: "date",
            date: null,
          },
        },
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");
      const customFields = result.items[0].customFields;

      // Null values should not produce custom fields
      expect(customFields).not.toHaveProperty("Empty Select");
      expect(customFields).not.toHaveProperty("Empty Number");
      expect(customFields).not.toHaveProperty("Empty URL");
      expect(customFields).not.toHaveProperty("Empty Date");
    });

    it("extracts created_time and last_edited_time as date fields", async () => {
      const page = createMockPage({
        extraProperties: {
          "Created Time": {
            type: "created_time",
            created_time: "2025-01-01T00:00:00.000Z",
          },
          "Last Edited": {
            type: "last_edited_time",
            last_edited_time: "2025-03-15T12:00:00.000Z",
          },
        },
      });

      const client = createMockClient({
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");
      const customFields = result.items[0].customFields;

      expect(customFields["Created Time"]).toEqual({
        type: "date",
        value: "2025-01-01T00:00:00.000Z",
      });
      expect(customFields["Last Edited"]).toEqual({
        type: "date",
        value: "2025-03-15T12:00:00.000Z",
      });
    });
  });

  describe("extractItems — property auto-detection", () => {
    it("auto-detects title property by type", async () => {
      const db = createMockDatabase({
        properties: {
          "Task Title": { id: "tt", name: "Task Title", type: "title" },
        },
      });

      const page: NotionPage = {
        id: "page-1",
        url: "https://notion.so/page-1",
        created_time: "2025-01-01T00:00:00.000Z",
        last_edited_time: "2025-01-15T10:00:00.000Z",
        archived: false,
        properties: {
          "Task Title": {
            type: "title",
            title: [{ type: "text", plain_text: "Auto-detected" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => db),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].title).toBe("Auto-detected");
    });

    it("uses explicit property mappings when provided", async () => {
      const db = createMockDatabase({
        properties: {
          "Custom Name": { id: "cn", name: "Custom Name", type: "title" },
          Notes: { id: "notes", name: "Notes", type: "rich_text" },
        },
      });

      const page: NotionPage = {
        id: "page-1",
        url: "https://notion.so/page-1",
        created_time: "2025-01-01T00:00:00.000Z",
        last_edited_time: "2025-01-15T10:00:00.000Z",
        archived: false,
        properties: {
          "Custom Name": {
            type: "title",
            title: [{ type: "text", plain_text: "Mapped Title" }],
          },
          Notes: {
            type: "rich_text",
            rich_text: [{ type: "text", plain_text: "Mapped description" }],
          },
        },
        parent: { type: "database_id", database_id: "db-123" },
      };

      const client = createMockClient({
        getDatabase: vi.fn(async () => db),
        queryDatabase: vi.fn(async () => ({
          results: [page],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client, {
        propertyMappings: {
          titleProperty: "Custom Name",
          descriptionProperty: "Notes",
        },
      });
      const result = await extractor.extractItems("db-123");

      expect(result.items[0].title).toBe("Mapped Title");
      expect(result.items[0].description).toBe("Mapped description");
    });
  });

  describe("extractAllItems", () => {
    it("fetches all pages across pagination boundaries", async () => {
      const queryDb = vi
        .fn()
        .mockResolvedValueOnce({
          results: [
            createMockPage({ id: "p1", title: "A" }),
            createMockPage({ id: "p2", title: "B" }),
          ],
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: [createMockPage({ id: "p3", title: "C" })],
          has_more: false,
          next_cursor: null,
        });

      const client = createMockClient({ queryDatabase: queryDb });
      const extractor = new NotionItemExtractor(client);
      const items = await extractor.extractAllItems("db-123");

      expect(items).toHaveLength(3);
      expect(items.map((i) => i.title)).toEqual(["A", "B", "C"]);
    });

    it("respects maxItems across pages", async () => {
      const queryDb = vi
        .fn()
        .mockResolvedValueOnce({
          results: Array.from({ length: 5 }, (_, i) =>
            createMockPage({ id: `p${i}`, title: `Item ${i}` })
          ),
          has_more: true,
          next_cursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          results: Array.from({ length: 5 }, (_, i) =>
            createMockPage({ id: `p${i + 5}`, title: `Item ${i + 5}` })
          ),
          has_more: false,
          next_cursor: null,
        });

      const client = createMockClient({ queryDatabase: queryDb });
      const extractor = new NotionItemExtractor(client);
      const items = await extractor.extractAllItems("db-123", { maxItems: 7 });

      expect(items).toHaveLength(7);
    });
  });

  describe("listProjects", () => {
    it("lists databases as projects", async () => {
      const client = createMockClient({
        search: vi.fn(async () => ({
          results: [
            {
              id: "db-1",
              object: "database" as const,
              url: "https://notion.so/db-1",
              title: [{ type: "text" as const, plain_text: "Product Roadmap" }],
            },
            {
              id: "db-2",
              object: "database" as const,
              url: "https://notion.so/db-2",
              title: [{ type: "text" as const, plain_text: "Bug Tracker" }],
            },
            {
              id: "page-1",
              object: "page" as const,
              url: "https://notion.so/page-1",
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.listProjects();

      // Should only include databases, not pages
      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe("Product Roadmap");
      expect(result.items[0].externalId).toBe("db-1");
      expect(result.items[1].name).toBe("Bug Tracker");
    });

    it("returns empty list when no databases found", async () => {
      const client = createMockClient();
      const extractor = new NotionItemExtractor(client);
      const result = await extractor.listProjects();

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("handles databases with no title", async () => {
      const client = createMockClient({
        search: vi.fn(async () => ({
          results: [
            {
              id: "db-1",
              object: "database" as const,
              url: "https://notion.so/db-1",
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      });

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.listProjects();

      expect(result.items[0].name).toBe("Untitled Database");
    });
  });

  describe("getProject", () => {
    it("fetches a single database as a project", async () => {
      const client = createMockClient();
      const extractor = new NotionItemExtractor(client);
      const project = await extractor.getProject("db-123");

      expect(project).toBeDefined();
      expect(project!.name).toBe("Product Roadmap");
      expect(project!.externalId).toBe("db-123");
      expect(project!.description).toBe("Our product roadmap database");
      expect(project!.externalUrl).toBe("https://notion.so/db-123");
      expect(project!.metadata.propertyCount).toBe(7);
    });

    it("returns undefined when database not found", async () => {
      const client = createMockClient({
        getDatabase: vi.fn(async () => {
          throw new Error("Not found");
        }),
      });

      const extractor = new NotionItemExtractor(client);
      const project = await extractor.getProject("nonexistent");

      expect(project).toBeUndefined();
    });
  });

  describe("extractItems — combined filtering", () => {
    it("applies multiple filters simultaneously", async () => {
      const pages = [
        createMockPage({
          id: "p1",
          title: "Old Bug",
          type: "Bug",
          status: "Done",
          lastEdited: "2024-01-01T00:00:00.000Z",
        }),
        createMockPage({
          id: "p2",
          title: "New Bug",
          type: "Bug",
          status: "In Progress",
          lastEdited: "2025-06-01T00:00:00.000Z",
        }),
        createMockPage({
          id: "p3",
          title: "New Epic",
          type: "Epic",
          status: "In Progress",
          lastEdited: "2025-06-01T00:00:00.000Z",
        }),
        createMockPage({
          id: "p4",
          title: "New Feature Done",
          type: "Feature",
          status: "Done",
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

      const extractor = new NotionItemExtractor(client);
      const result = await extractor.extractItems("db-123", {
        kinds: ["bug"],
        statusCategory: "in_progress",
        updatedAfter: "2025-01-01T00:00:00.000Z",
      });

      // Only "New Bug" matches all three filters
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("New Bug");
    });
  });
});
