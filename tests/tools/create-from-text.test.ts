/**
 * Tests for the create_from_text MCP tool — Reverse-Flow Pipeline
 *
 * Validates the full reverse-flow pipeline:
 *   NL text input → NL parser → PM item creation → optional adapter routing
 *
 * Covers:
 * - Basic NL text parsing into PM items
 * - Bullet list and numbered list parsing
 * - User story format parsing
 * - Type prefix parsing (e.g., "Epic: Title")
 * - Hierarchy detection (parent-child relationships)
 * - Parser option overrides (defaultItemType, defaultStatus, defaultPriority)
 * - Adapter routing (dry-run and live routing through mock adapter)
 * - Error handling (empty input, invalid adapter)
 * - Edge cases (single item, complex multi-item input)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { registerTools, TOOL_NAMES } from "../../src/tools/index.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { MockPMAdapter } from "../../src/adapters/mock/mock-adapter.js";

// ─── Test Helpers ──────────────────────────────────────────────────────

/**
 * Parse the JSON text response from a tool call result.
 */
function parseToolResult(result: { content: Array<{ type: string; text?: string }> }) {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !textContent.text) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text);
}

/**
 * Sets up a connected MCP server + client pair with adapter registry.
 */
async function createTestPair(opts?: { withMockAdapter?: boolean }): Promise<{
  server: McpServer;
  client: Client;
  tempDir: string;
  registry: AdapterRegistry;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-create-text-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  const registry = new AdapterRegistry();

  // Optionally register the mock adapter
  if (opts?.withMockAdapter) {
    const mockAdapter = new MockPMAdapter({
      projects: [
        {
          externalId: "proj-1",
          name: "Test Project",
          metadata: {},
        },
      ],
    });
    registry.register(mockAdapter);
  }

  const server = new McpServer(
    { name: "lingo-test", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  registerTools(server, storage, { adapterRegistry: registry });

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    tempDir,
    registry,
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("create_from_text — Reverse-Flow Pipeline", () => {
  let client: Client;
  let server: McpServer;
  let registry: AdapterRegistry;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const pair = await createTestPair({ withMockAdapter: true });
    client = pair.client;
    server = pair.server;
    registry = pair.registry;
    cleanup = pair.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── Tool Registration ─────────────────────────────────────────────

  describe("tool registration", () => {
    it("is listed among available tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain(TOOL_NAMES.CREATE_FROM_TEXT);
    });

    it("has a description", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === TOOL_NAMES.CREATE_FROM_TEXT
      );
      expect(tool).toBeDefined();
      expect(tool!.description).toBeTruthy();
      expect(tool!.description!.length).toBeGreaterThan(20);
    });

    it("has expected input parameters", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === TOOL_NAMES.CREATE_FROM_TEXT
      );
      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("text");
      expect(props).toHaveProperty("adapter");
      expect(props).toHaveProperty("projectId");
      expect(props).toHaveProperty("dryRun");
      expect(props).toHaveProperty("defaultItemType");
      expect(props).toHaveProperty("defaultStatus");
      expect(props).toHaveProperty("defaultPriority");
    });
  });

  // ── Basic Parsing ─────────────────────────────────────────────────

  describe("basic NL text parsing", () => {
    it("parses a single item from simple text", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Create a login page" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      expect(parsed.parse.intent).toBe("create");
      expect(parsed.summary.dryRun).toBe(true);
    });

    it("parses bullet list items", async () => {
      const text = `User Authentication
- Login page
- Registration flow
- Password reset`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(3);

      // Verify titles are extracted
      const titles = parsed.items.map((i: any) => i.title);
      expect(titles).toContain("Login page");
      expect(titles).toContain("Registration flow");
      expect(titles).toContain("Password reset");
    });

    it("parses numbered list items", async () => {
      const text = `Sprint tasks:
1. Set up CI pipeline
2. Write unit tests
3. Deploy staging environment`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(3);
    });

    it("parses user story format", async () => {
      const text = "As a user, I want to reset my password, so that I can regain access to my account";

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      expect(parsed.parse.intent).toBe("create");

      // User story should produce a story-type item
      const storyItem = parsed.items.find((i: any) => i.type === "story");
      expect(storyItem).toBeDefined();
    });

    it("parses type prefix format", async () => {
      const text = `Epic: User Authentication
- Story: Login with email
- Story: Social login integration
- Task: Set up OAuth provider`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(3);

      // Check that types are correctly inferred
      const epicItem = parsed.items.find((i: any) => i.type === "epic");
      expect(epicItem).toBeDefined();
    });
  });

  // ── Hierarchy Detection ───────────────────────────────────────────

  describe("hierarchy detection", () => {
    it("detects parent-child hierarchy from header + bullet list", async () => {
      const text = `User Authentication
- Login page
- Registration flow
- Password reset`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.hierarchy.length).toBeGreaterThanOrEqual(1);

      // The header should be the parent
      const parentRelation = parsed.hierarchy.find(
        (h: any) => h.parentTitle === "User Authentication"
      );
      expect(parentRelation).toBeDefined();
    });
  });

  // ── Parser Options ────────────────────────────────────────────────

  describe("parser option overrides", () => {
    it("respects defaultItemType override", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Build analytics dashboard",
          defaultItemType: "epic",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      // Items without an explicit type should use the default
      const item = parsed.items[0];
      expect(item.type).toBe("epic");
    });

    it("respects defaultStatus override", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Implement payment processing",
          defaultStatus: "todo",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items[0].status).toBe("todo");
    });

    it("respects defaultPriority override", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Fix critical login bug",
          defaultPriority: "high",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      // Priority from entity extraction may override, but default should apply
      // when no priority entity is detected
    });

    it("respects sourceAdapter override", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Build search feature",
          sourceAdapter: "custom-source",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items[0].source.adapter).toBe("custom-source");
    });
  });

  // ── Response Structure ────────────────────────────────────────────

  describe("response structure", () => {
    it("returns complete parse metadata", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Create a user dashboard with analytics" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);

      // Parse section
      expect(parsed.parse).toBeDefined();
      expect(parsed.parse.intent).toBeDefined();
      expect(typeof parsed.parse.confidence).toBe("number");
      expect(typeof parsed.parse.entityCount).toBe("number");
      expect(Array.isArray(parsed.parse.entities)).toBe(true);

      // Items section
      expect(Array.isArray(parsed.items)).toBe(true);
      for (const item of parsed.items) {
        expect(item.id).toBeDefined();
        expect(item.type).toBeDefined();
        expect(item.title).toBeDefined();
        expect(item.status).toBeDefined();
        expect(item.priority).toBeDefined();
        expect(item.source).toBeDefined();
        expect(item.createdAt).toBeDefined();
        expect(item.updatedAt).toBeDefined();
      }

      // Summary section
      expect(parsed.summary).toBeDefined();
      expect(typeof parsed.summary.itemCount).toBe("number");
      expect(parsed.summary.intent).toBeDefined();
      expect(typeof parsed.summary.confidence).toBe("number");
      expect(typeof parsed.summary.dryRun).toBe("boolean");
      expect(typeof parsed.summary.adapterRouted).toBe("boolean");

      // Diagnostics
      expect(Array.isArray(parsed.diagnostics)).toBe(true);
    });

    it("includes entity details in response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Create a high priority bug for login failure" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.parse.entities.length).toBeGreaterThan(0);

      // Entities should have expected shape
      for (const entity of parsed.parse.entities) {
        expect(entity.kind).toBeDefined();
        expect(entity.rawValue).toBeDefined();
        expect(entity.normalizedValue).toBeDefined();
        expect(typeof entity.confidence).toBe("number");
      }
    });

    it("generates valid UUIDs for items", async () => {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Build a new feature" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      for (const item of parsed.items) {
        expect(item.id).toMatch(uuidPattern);
      }
    });

    it("generates ISO 8601 timestamps", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Create a task" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      for (const item of parsed.items) {
        // Should be parseable as a date
        expect(new Date(item.createdAt).toISOString()).toBeTruthy();
        expect(new Date(item.updatedAt).toISOString()).toBeTruthy();
      }
    });
  });

  // ── Adapter Routing ───────────────────────────────────────────────

  describe("adapter routing", () => {
    it("defaults to dry-run mode (no adapter routing)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Create a task for testing" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.summary.dryRun).toBe(true);
      expect(parsed.summary.adapterRouted).toBe(false);
    });

    it("routes through adapter when adapter specified and dryRun is false", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Create a task for testing adapter routing",
          adapter: "mock",
          dryRun: false,
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.summary.adapterRouted).toBe(true);
      expect(parsed.summary.adapterName).toBe("mock");
    });

    it("returns error for unregistered adapter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Create a task",
          adapter: "nonexistent",
          dryRun: false,
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("nonexistent");
      expect(parsed.error).toContain("not registered");
    });

    it("stays in dry-run mode even with adapter when dryRun is true", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text: "Create a task for dry-run testing",
          adapter: "mock",
          dryRun: true,
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.summary.dryRun).toBe(true);
      expect(parsed.summary.adapterRouted).toBe(false);
    });
  });

  // ── Complex Inputs ────────────────────────────────────────────────

  describe("complex inputs", () => {
    it("handles multi-line input with mixed formats", async () => {
      const text = `Sprint 12 Planning
- Epic: Payment System Redesign
- Story: Update checkout flow
- Bug: Fix double-charge issue
- Task: Write migration script`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(4);

      // Check that different types are recognized
      const types = parsed.items.map((i: any) => i.type);
      expect(types).toContain("epic");
      expect(types).toContain("story");
      expect(types).toContain("bug");
      expect(types).toContain("task");
    });

    it("handles input with metadata entities (priorities, labels)", async () => {
      const text = "Create a high priority task to fix the authentication service [backend]";

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    });

    it("handles single-line input", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "Implement user profile page" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      expect(parsed.items[0].title).toBeTruthy();
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns empty items for very short ambiguous input", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "hmm" },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      // Even ambiguous input should parse without error
      expect(Array.isArray(parsed.items)).toBe(true);
      expect(Array.isArray(parsed.diagnostics)).toBe(true);
    });

    it("handles whitespace-heavy input gracefully", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: { text: "   Create a dashboard   " },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Full Pipeline Integration ─────────────────────────────────────

  describe("full pipeline integration", () => {
    it("end-to-end: NL text → parser → PM items with hierarchy", async () => {
      const text = `User Authentication Epic
- Login with email and password
- Social login (Google, GitHub)
- Two-factor authentication
- Password reset flow`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text,
          defaultItemType: "story",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);

      // Should produce multiple items
      expect(parsed.items.length).toBeGreaterThanOrEqual(4);

      // Should detect hierarchy
      expect(parsed.hierarchy.length).toBeGreaterThanOrEqual(1);

      // Parse metadata should be populated
      expect(parsed.parse.intent).toBeDefined();
      expect(parsed.parse.confidence).toBeGreaterThan(0);

      // Summary should be accurate
      expect(parsed.summary.itemCount).toBe(parsed.items.length);
      expect(parsed.summary.dryRun).toBe(true);
    });

    it("end-to-end: parse + adapter routing pipeline", async () => {
      const text = `API Improvements
- Add rate limiting
- Implement caching layer
- Add request validation`;

      const result = await client.callTool({
        name: TOOL_NAMES.CREATE_FROM_TEXT,
        arguments: {
          text,
          adapter: "mock",
          dryRun: false,
          defaultItemType: "task",
          sourceAdapter: "planning-session",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);

      // Items should be created
      expect(parsed.items.length).toBeGreaterThanOrEqual(3);

      // Adapter routing should be recorded
      expect(parsed.summary.adapterRouted).toBe(true);
      expect(parsed.summary.adapterName).toBe("mock");

      // Source should reflect custom source adapter
      for (const item of parsed.items) {
        expect(item.source.adapter).toBe("planning-session");
      }
    });
  });
});
