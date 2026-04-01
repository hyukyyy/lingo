/**
 * Tests for list_adapters MCP Tool
 *
 * Validates the unified adapter listing across both PM and SCM registries.
 * The tool returns { name, type, displayName }[] where type is "pm" or "scm".
 *
 * Covers:
 * - Empty registries (no adapters)
 * - PM-only adapters
 * - SCM-only adapters
 * - Unified PM + SCM adapters
 * - No registries provided (options undefined)
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
import { SCMAdapterRegistry } from "../../src/adapters/scm/registry.js";

// ─── Test Helpers ──────────────────────────────────────────────────────

/**
 * Creates a connected MCP server + client pair with custom registries.
 */
async function createTestPair(opts?: {
  adapterRegistry?: AdapterRegistry;
  scmAdapterRegistry?: SCMAdapterRegistry;
}): Promise<{
  server: McpServer;
  client: Client;
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-list-adapters-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  const server = new McpServer(
    { name: "lingo-test", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  registerTools(server, storage, {
    adapterRegistry: opts?.adapterRegistry,
    scmAdapterRegistry: opts?.scmAdapterRegistry,
  });

  const client = new Client({ name: "test-client", version: "0.0.1" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    tempDir,
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

/**
 * Helper to call list_adapters and parse the response.
 */
async function callListAdapters(client: Client): Promise<{
  success: boolean;
  count: number;
  adapters: Array<{ name: string; type: string; displayName: string }>;
}> {
  const result = await client.callTool({
    name: TOOL_NAMES.LIST_ADAPTERS,
    arguments: {},
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0]
    .text;
  return JSON.parse(text);
}

// ─── Mock PM adapter that satisfies the minimal PMAdapter interface ────

function createMockPMAdapter(name: string, displayName: string) {
  return {
    name,
    displayName,
    testConnection: async () => ({ connected: true, message: "ok" }),
    listProjects: async () => ({ items: [], hasMore: false }),
    getProject: async () => undefined,
    listItems: async () => ({ items: [], hasMore: false }),
    getItem: async () => undefined,
    extractItems: async () => [],
    normalizeToTerms: () => [],
    extract: async () => ({
      adapterName: name,
      extractedAt: new Date().toISOString(),
      terms: [],
      stats: {
        itemsFetched: 0,
        termsProduced: 0,
        itemsSkipped: 0,
        durationMs: 0,
        itemsByType: {},
      },
      warnings: [],
    }),
    extractTerminology: async () => [],
  };
}

// ─── Mock SCM adapter that satisfies the minimal SCMAdapter interface ──

function createMockSCMAdapter(name: string, displayName: string) {
  return {
    name,
    displayName,
    testConnection: async () => ({ connected: true, message: "ok" }),
    parsePullRequestUrl: () => ({ owner: "test", repo: "test", number: 1 }),
    fetchPullRequest: async () => ({
      number: 1,
      title: "test",
      description: "",
      url: "",
      mergedAt: null,
      labels: [],
      files: [],
    }),
    fetchPullRequestByUrl: async () => ({
      number: 1,
      title: "test",
      description: "",
      url: "",
      mergedAt: null,
      labels: [],
      files: [],
    }),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("list_adapters tool", () => {
  describe("empty registries — no adapters registered", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const pair = await createTestPair({
        adapterRegistry: new AdapterRegistry(),
        scmAdapterRegistry: new SCMAdapterRegistry(),
      });
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns success with empty adapter list", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.adapters).toEqual([]);
    });
  });

  describe("PM-only adapters", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const pmRegistry = new AdapterRegistry();
      pmRegistry.registerFactory({
        name: "notion",
        displayName: "Notion",
        description: "Notion workspace adapter",
        factory: (config) => createMockPMAdapter("notion", "Notion") as any,
      });
      pmRegistry.registerFactory({
        name: "linear",
        displayName: "Linear",
        description: "Linear project tracker",
        factory: (config) => createMockPMAdapter("linear", "Linear") as any,
      });

      const pair = await createTestPair({
        adapterRegistry: pmRegistry,
        scmAdapterRegistry: new SCMAdapterRegistry(),
      });
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns only PM adapters with type 'pm'", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.adapters).toEqual([
        { name: "notion", type: "pm", displayName: "Notion" },
        { name: "linear", type: "pm", displayName: "Linear" },
      ]);
    });

    it("all adapters have type 'pm'", async () => {
      const result = await callListAdapters(client);
      for (const adapter of result.adapters) {
        expect(adapter.type).toBe("pm");
      }
    });
  });

  describe("SCM-only adapters", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const scmRegistry = new SCMAdapterRegistry();
      scmRegistry.registerFactory({
        name: "github",
        displayName: "GitHub",
        description: "GitHub SCM adapter",
        factory: (config) => createMockSCMAdapter("github", "GitHub") as any,
      });

      const pair = await createTestPair({
        adapterRegistry: new AdapterRegistry(),
        scmAdapterRegistry: scmRegistry,
      });
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns only SCM adapters with type 'scm'", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.adapters).toEqual([
        { name: "github", type: "scm", displayName: "GitHub" },
      ]);
    });

    it("all adapters have type 'scm'", async () => {
      const result = await callListAdapters(client);
      for (const adapter of result.adapters) {
        expect(adapter.type).toBe("scm");
      }
    });
  });

  describe("unified PM + SCM adapters", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const pmRegistry = new AdapterRegistry();
      pmRegistry.registerFactory({
        name: "notion",
        displayName: "Notion",
        description: "Notion workspace adapter",
        factory: (config) => createMockPMAdapter("notion", "Notion") as any,
      });

      const scmRegistry = new SCMAdapterRegistry();
      scmRegistry.registerFactory({
        name: "github",
        displayName: "GitHub",
        description: "GitHub SCM adapter",
        factory: (config) => createMockSCMAdapter("github", "GitHub") as any,
      });

      const pair = await createTestPair({
        adapterRegistry: pmRegistry,
        scmAdapterRegistry: scmRegistry,
      });
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns both PM and SCM adapters in unified list", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.adapters).toEqual([
        { name: "notion", type: "pm", displayName: "Notion" },
        { name: "github", type: "scm", displayName: "GitHub" },
      ]);
    });

    it("PM adapters appear before SCM adapters", async () => {
      const result = await callListAdapters(client);
      const types = result.adapters.map((a) => a.type);
      expect(types).toEqual(["pm", "scm"]);
    });

    it("each adapter has name, type, and displayName", async () => {
      const result = await callListAdapters(client);
      for (const adapter of result.adapters) {
        expect(adapter).toHaveProperty("name");
        expect(adapter).toHaveProperty("type");
        expect(adapter).toHaveProperty("displayName");
        expect(typeof adapter.name).toBe("string");
        expect(typeof adapter.type).toBe("string");
        expect(typeof adapter.displayName).toBe("string");
      }
    });
  });

  describe("no registries provided", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      // No registries at all — options is empty
      const pair = await createTestPair({});
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("returns empty list when no registries are provided", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.adapters).toEqual([]);
    });
  });

  describe("instance-only adapters (registered without factory)", () => {
    let client: Client;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const pmRegistry = new AdapterRegistry();
      // Register a direct instance (no factory)
      pmRegistry.register(
        createMockPMAdapter("json-file", "JSON File") as any
      );

      const scmRegistry = new SCMAdapterRegistry();
      // Register a direct instance (no factory)
      scmRegistry.register(
        createMockSCMAdapter("gitlab", "GitLab") as any
      );

      const pair = await createTestPair({
        adapterRegistry: pmRegistry,
        scmAdapterRegistry: scmRegistry,
      });
      client = pair.client;
      cleanup = pair.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it("includes instance-only adapters in the list", async () => {
      const result = await callListAdapters(client);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.adapters).toContainEqual({
        name: "json-file",
        type: "pm",
        displayName: "JSON File",
      });
      expect(result.adapters).toContainEqual({
        name: "gitlab",
        type: "scm",
        displayName: "GitLab",
      });
    });
  });
});
