import { describe, it, expect } from "vitest";
import {
  PmItemTypeSchema,
  PmStatusSchema,
  PmPrioritySchema,
  PmItemSourceSchema,
  PersonRefSchema,
  PmItemRefSchema,
  PmItemSchema,
  PmItemCollectionSchema,
  createPmItem,
  isPmItemType,
  isPmStatus,
  isPmPriority,
  validatePmItem,
  PM_ITEM_TYPES,
  PM_STATUSES,
  PM_PRIORITIES,
  type PmItem,
  type PmItemType,
  type PmStatus,
  type PmPriority,
  type CreatePmItemInput,
  type AdapterMappingConfig,
  type ItemTypeMapping,
  type StatusMapping,
  type PriorityMapping,
} from "../src/models/pm-items.js";

// ─── Helper: builds a minimal valid CreatePmItemInput ────────────────

function minimalInput(overrides: Partial<CreatePmItemInput> = {}): CreatePmItemInput {
  return {
    type: "task",
    title: "Implement login page",
    source: { adapter: "manual" },
    ...overrides,
  };
}

// ─── Enum schemas ────────────────────────────────────────────────────

describe("PmItemTypeSchema", () => {
  it("accepts all canonical item types", () => {
    const types: PmItemType[] = [
      "initiative", "epic", "story", "task", "subtask", "bug", "feature", "milestone",
    ];
    for (const t of types) {
      expect(PmItemTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects unknown item types", () => {
    expect(PmItemTypeSchema.safeParse("ticket").success).toBe(false);
    expect(PmItemTypeSchema.safeParse("").success).toBe(false);
    expect(PmItemTypeSchema.safeParse(42).success).toBe(false);
  });

  it("PM_ITEM_TYPES contains all values", () => {
    expect(PM_ITEM_TYPES).toEqual([
      "initiative", "epic", "story", "task", "subtask", "bug", "feature", "milestone",
    ]);
  });
});

describe("PmStatusSchema", () => {
  it("accepts all canonical statuses", () => {
    const statuses: PmStatus[] = [
      "backlog", "todo", "in-progress", "in-review", "done", "cancelled",
    ];
    for (const s of statuses) {
      expect(PmStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown statuses", () => {
    expect(PmStatusSchema.safeParse("open").success).toBe(false);
    expect(PmStatusSchema.safeParse("closed").success).toBe(false);
  });

  it("PM_STATUSES contains all values", () => {
    expect(PM_STATUSES).toEqual([
      "backlog", "todo", "in-progress", "in-review", "done", "cancelled",
    ]);
  });
});

describe("PmPrioritySchema", () => {
  it("accepts all canonical priorities", () => {
    const priorities: PmPriority[] = [
      "critical", "high", "medium", "low", "none",
    ];
    for (const p of priorities) {
      expect(PmPrioritySchema.safeParse(p).success).toBe(true);
    }
  });

  it("rejects unknown priorities", () => {
    expect(PmPrioritySchema.safeParse("urgent").success).toBe(false);
    expect(PmPrioritySchema.safeParse("P1").success).toBe(false);
  });

  it("PM_PRIORITIES contains all values", () => {
    expect(PM_PRIORITIES).toEqual([
      "critical", "high", "medium", "low", "none",
    ]);
  });
});

// ─── Sub-schemas ─────────────────────────────────────────────────────

describe("PmItemSourceSchema", () => {
  it("accepts a minimal source", () => {
    const result = PmItemSourceSchema.safeParse({ adapter: "notion" });
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated source", () => {
    const result = PmItemSourceSchema.safeParse({
      adapter: "jira",
      externalId: "PROJ-123",
      url: "https://myorg.atlassian.net/browse/PROJ-123",
      lastSyncedAt: "2026-03-31T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty adapter string", () => {
    const result = PmItemSourceSchema.safeParse({ adapter: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL", () => {
    const result = PmItemSourceSchema.safeParse({
      adapter: "jira",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("PersonRefSchema", () => {
  it("accepts a name-only person", () => {
    const result = PersonRefSchema.safeParse({ name: "Alice" });
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated person", () => {
    const result = PersonRefSchema.safeParse({
      name: "Bob",
      email: "bob@example.com",
      externalId: "user-456",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = PersonRefSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = PersonRefSchema.safeParse({
      name: "Carol",
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("PmItemRefSchema", () => {
  it("accepts a valid item reference", () => {
    const result = PmItemRefSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "epic",
      title: "User Authentication",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID id", () => {
    const result = PmItemRefSchema.safeParse({
      id: "not-a-uuid",
      type: "task",
      title: "Something",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const result = PmItemRefSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "invalid",
      title: "Something",
    });
    expect(result.success).toBe(false);
  });
});

// ─── PmItem full schema ─────────────────────────────────────────────

describe("PmItemSchema", () => {
  function validItem(): PmItem {
    return {
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "story",
      title: "As a user, I want to log in with SSO",
      description: "## Acceptance Criteria\n- SAML support\n- Google OAuth",
      status: "todo",
      priority: "high",
      labels: ["auth", "sso"],
      assignee: { name: "Alice", email: "alice@example.com" },
      reporter: { name: "Bob" },
      parent: {
        id: "660e8400-e29b-41d4-a716-446655440000",
        type: "epic",
        title: "Authentication Overhaul",
      },
      children: [],
      dependencies: [],
      source: {
        adapter: "notion",
        externalId: "page-abc123",
        url: "https://notion.so/page-abc123",
      },
      metadata: { notionDatabaseId: "db-xyz" },
      dueDate: "2026-04-15T00:00:00.000Z",
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-31T14:30:00.000Z",
    };
  }

  it("accepts a fully populated item", () => {
    const result = PmItemSchema.safeParse(validItem());
    expect(result.success).toBe(true);
  });

  it("accepts a minimal item (only required fields)", () => {
    const result = PmItemSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "task",
      title: "Fix login bug",
      status: "backlog",
      priority: "none",
      source: { adapter: "manual" },
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects item without required title", () => {
    const item = validItem();
    // @ts-expect-error - intentionally testing runtime validation
    delete item.title;
    const result = PmItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const item = { ...validItem(), title: "" };
    const result = PmItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const item = { ...validItem(), status: "open" };
    const result = PmItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });

  it("preserves metadata as opaque record", () => {
    const item = validItem();
    item.metadata = {
      jiraSprint: 42,
      linearCycle: { id: "c1", name: "Cycle 1" },
      customField: true,
    };
    const result = PmItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual(item.metadata);
    }
  });
});

// ─── createPmItem factory ───────────────────────────────────────────

describe("createPmItem", () => {
  it("creates an item with required fields only", () => {
    const item = createPmItem(minimalInput());

    expect(item.title).toBe("Implement login page");
    expect(item.type).toBe("task");
    expect(item.source.adapter).toBe("manual");
  });

  it("generates a valid UUID v4 id", () => {
    const item = createPmItem(minimalInput());
    expect(item.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("generates unique IDs for each item", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const item = createPmItem(minimalInput({ title: `Task ${i}` }));
      ids.add(item.id);
    }
    expect(ids.size).toBe(50);
  });

  it("sets default status to backlog", () => {
    const item = createPmItem(minimalInput());
    expect(item.status).toBe("backlog");
  });

  it("sets default priority to none", () => {
    const item = createPmItem(minimalInput());
    expect(item.priority).toBe("none");
  });

  it("sets default empty arrays", () => {
    const item = createPmItem(minimalInput());
    expect(item.labels).toEqual([]);
    expect(item.children).toEqual([]);
    expect(item.dependencies).toEqual([]);
  });

  it("sets default empty string for description", () => {
    const item = createPmItem(minimalInput());
    expect(item.description).toBe("");
  });

  it("sets default empty metadata", () => {
    const item = createPmItem(minimalInput());
    expect(item.metadata).toEqual({});
  });

  it("sets createdAt and updatedAt to current time", () => {
    const before = new Date().toISOString();
    const item = createPmItem(minimalInput());
    const after = new Date().toISOString();

    expect(item.createdAt >= before).toBe(true);
    expect(item.createdAt <= after).toBe(true);
    expect(item.createdAt).toBe(item.updatedAt);
  });

  it("accepts all optional fields", () => {
    const parentRef = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      type: "epic" as const,
      title: "Auth Epic",
    };

    const item = createPmItem({
      type: "story",
      title: "SSO Login",
      description: "Implement SSO login flow",
      status: "in-progress",
      priority: "high",
      labels: ["auth", "sso"],
      assignee: { name: "Alice", email: "alice@example.com" },
      reporter: { name: "Bob" },
      parent: parentRef,
      children: [],
      dependencies: [],
      source: {
        adapter: "linear",
        externalId: "LIN-123",
        url: "https://linear.app/team/LIN-123",
      },
      metadata: { linearCycleId: "cycle-1" },
      dueDate: "2026-04-15T00:00:00.000Z",
    });

    expect(item.type).toBe("story");
    expect(item.title).toBe("SSO Login");
    expect(item.description).toBe("Implement SSO login flow");
    expect(item.status).toBe("in-progress");
    expect(item.priority).toBe("high");
    expect(item.labels).toEqual(["auth", "sso"]);
    expect(item.assignee?.name).toBe("Alice");
    expect(item.reporter?.name).toBe("Bob");
    expect(item.parent?.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(item.source.adapter).toBe("linear");
    expect(item.metadata).toEqual({ linearCycleId: "cycle-1" });
    expect(item.dueDate).toBe("2026-04-15T00:00:00.000Z");
  });

  it("throws on invalid input (empty title)", () => {
    expect(() => createPmItem(minimalInput({ title: "" }))).toThrow();
  });

  it("throws on invalid input (bad type)", () => {
    // @ts-expect-error - intentionally testing runtime validation
    expect(() => createPmItem(minimalInput({ type: "ticket" }))).toThrow();
  });

  it("creates items for every canonical type", () => {
    for (const type of PM_ITEM_TYPES) {
      const item = createPmItem(minimalInput({ type, title: `${type} item` }));
      expect(item.type).toBe(type);
    }
  });

  it("creates items for every canonical status", () => {
    for (const status of PM_STATUSES) {
      const item = createPmItem(minimalInput({ status }));
      expect(item.status).toBe(status);
    }
  });

  it("creates items for every canonical priority", () => {
    for (const priority of PM_PRIORITIES) {
      const item = createPmItem(minimalInput({ priority }));
      expect(item.priority).toBe(priority);
    }
  });
});

// ─── Type guards ─────────────────────────────────────────────────────

describe("Type guards", () => {
  describe("isPmItemType", () => {
    it("returns true for valid item types", () => {
      expect(isPmItemType("epic")).toBe(true);
      expect(isPmItemType("story")).toBe(true);
      expect(isPmItemType("bug")).toBe(true);
    });

    it("returns false for invalid item types", () => {
      expect(isPmItemType("ticket")).toBe(false);
      expect(isPmItemType("")).toBe(false);
      expect(isPmItemType("Epic")).toBe(false); // case sensitive
    });
  });

  describe("isPmStatus", () => {
    it("returns true for valid statuses", () => {
      expect(isPmStatus("backlog")).toBe(true);
      expect(isPmStatus("in-progress")).toBe(true);
      expect(isPmStatus("done")).toBe(true);
    });

    it("returns false for invalid statuses", () => {
      expect(isPmStatus("open")).toBe(false);
      expect(isPmStatus("closed")).toBe(false);
    });
  });

  describe("isPmPriority", () => {
    it("returns true for valid priorities", () => {
      expect(isPmPriority("critical")).toBe(true);
      expect(isPmPriority("none")).toBe(true);
    });

    it("returns false for invalid priorities", () => {
      expect(isPmPriority("P1")).toBe(false);
      expect(isPmPriority("urgent")).toBe(false);
    });
  });
});

// ─── validatePmItem ──────────────────────────────────────────────────

describe("validatePmItem", () => {
  it("returns success for valid item data", () => {
    const item = createPmItem(minimalInput());
    const result = validatePmItem(item);
    expect(result.success).toBe(true);
  });

  it("returns error for invalid data", () => {
    const result = validatePmItem({ title: "Missing fields" });
    expect(result.success).toBe(false);
  });

  it("returns error for null", () => {
    const result = validatePmItem(null);
    expect(result.success).toBe(false);
  });

  it("returns error for non-object", () => {
    const result = validatePmItem("not an object");
    expect(result.success).toBe(false);
  });
});

// ─── PmItemCollectionSchema ──────────────────────────────────────────

describe("PmItemCollectionSchema", () => {
  it("accepts a valid collection", () => {
    const item = createPmItem(minimalInput());
    const collection = {
      adapter: "notion",
      fetchedAt: "2026-03-31T12:00:00.000Z",
      items: [item],
      totalCount: 1,
      hasMore: false,
    };
    const result = PmItemCollectionSchema.safeParse(collection);
    expect(result.success).toBe(true);
  });

  it("accepts an empty collection", () => {
    const collection = {
      adapter: "linear",
      fetchedAt: "2026-03-31T12:00:00.000Z",
      items: [],
      totalCount: 0,
      hasMore: false,
    };
    const result = PmItemCollectionSchema.safeParse(collection);
    expect(result.success).toBe(true);
  });

  it("accepts a paginated collection with cursor", () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      createPmItem(minimalInput({ title: `Task ${i}` }))
    );
    const collection = {
      adapter: "jira",
      fetchedAt: "2026-03-31T12:00:00.000Z",
      items,
      totalCount: 100,
      hasMore: true,
      cursor: "eyJwYWdlIjoxfQ==",
    };
    const result = PmItemCollectionSchema.safeParse(collection);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items).toHaveLength(3);
      expect(result.data.totalCount).toBe(100);
      expect(result.data.hasMore).toBe(true);
      expect(result.data.cursor).toBe("eyJwYWdlIjoxfQ==");
    }
  });
});

// ─── Adapter mapping types (structural tests) ───────────────────────

describe("AdapterMappingConfig (structural)", () => {
  it("allows defining a Jira-like mapping config", () => {
    const config: AdapterMappingConfig = {
      itemTypes: {
        "Story": "story",
        "Task": "task",
        "Bug": "bug",
        "Epic": "epic",
        "Sub-task": "subtask",
      },
      statuses: {
        "To Do": "todo",
        "In Progress": "in-progress",
        "In Review": "in-review",
        "Done": "done",
        "Won't Do": "cancelled",
      },
      priorities: {
        "Highest": "critical",
        "High": "high",
        "Medium": "medium",
        "Low": "low",
        "Lowest": "low",
      },
    };

    expect(config.itemTypes["Story"]).toBe("story");
    expect(config.statuses["In Progress"]).toBe("in-progress");
    expect(config.priorities["Highest"]).toBe("critical");
  });

  it("allows defining a Linear-like mapping config", () => {
    const config: AdapterMappingConfig = {
      itemTypes: {
        "Issue": "task",
        "Project": "epic",
        "Initiative": "initiative",
      },
      statuses: {
        "Triage": "backlog",
        "Backlog": "backlog",
        "Todo": "todo",
        "In Progress": "in-progress",
        "Done": "done",
        "Cancelled": "cancelled",
      },
      priorities: {
        "Urgent": "critical",
        "High": "high",
        "Medium": "medium",
        "Low": "low",
        "No priority": "none",
      },
    };

    expect(config.itemTypes["Issue"]).toBe("task");
    expect(config.statuses["Triage"]).toBe("backlog");
    expect(config.priorities["Urgent"]).toBe("critical");
  });

  it("allows defining a Notion-like mapping config", () => {
    const config: AdapterMappingConfig = {
      itemTypes: {
        "Page": "story",
        "Task": "task",
        "Project": "epic",
      },
      statuses: {
        "Not started": "todo",
        "In progress": "in-progress",
        "Complete": "done",
      },
      priorities: {
        "High": "high",
        "Medium": "medium",
        "Low": "low",
      },
    };

    expect(config.itemTypes["Page"]).toBe("story");
    expect(config.statuses["Not started"]).toBe("todo");
    expect(config.priorities["High"]).toBe("high");
  });
});

// ─── Hierarchy modeling ──────────────────────────────────────────────

describe("Hierarchy modeling", () => {
  it("models an initiative → epic → story → task hierarchy", () => {
    const task = createPmItem({
      type: "task",
      title: "Write SAML callback handler",
      source: { adapter: "manual" },
    });

    const story = createPmItem({
      type: "story",
      title: "SSO Login Flow",
      children: [{ id: task.id, type: "task", title: task.title }],
      source: { adapter: "manual" },
    });

    const epic = createPmItem({
      type: "epic",
      title: "Authentication Overhaul",
      children: [{ id: story.id, type: "story", title: story.title }],
      source: { adapter: "manual" },
    });

    const initiative = createPmItem({
      type: "initiative",
      title: "Security Improvements Q2",
      children: [{ id: epic.id, type: "epic", title: epic.title }],
      source: { adapter: "manual" },
    });

    expect(initiative.type).toBe("initiative");
    expect(initiative.children).toHaveLength(1);
    expect(initiative.children[0].type).toBe("epic");

    expect(epic.children).toHaveLength(1);
    expect(epic.children[0].type).toBe("story");

    expect(story.children).toHaveLength(1);
    expect(story.children[0].type).toBe("task");
  });

  it("models dependencies between items", () => {
    const apiTask = createPmItem({
      type: "task",
      title: "Build auth API endpoint",
      source: { adapter: "manual" },
    });

    const uiTask = createPmItem({
      type: "task",
      title: "Build login form UI",
      dependencies: [{ id: apiTask.id, type: "task", title: apiTask.title }],
      source: { adapter: "manual" },
    });

    expect(uiTask.dependencies).toHaveLength(1);
    expect(uiTask.dependencies[0].id).toBe(apiTask.id);
    expect(uiTask.dependencies[0].title).toBe("Build auth API endpoint");
  });
});
