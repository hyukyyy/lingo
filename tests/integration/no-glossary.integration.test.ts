/**
 * Integration Test — No-Glossary Scenario
 *
 * Verifies correct behavior when no glossary file exists on disk.
 * This is distinct from the cold-start tests (which start with an empty but
 * already-loaded store): here we test the full lifecycle from a completely
 * absent glossary file through to a working, populated glossary.
 *
 * Scenarios tested:
 *   1. Server starts successfully when pointed at a non-existent glossary path
 *   2. The glossary file is automatically created on disk
 *   3. All query/lookup tools return graceful empty-state responses (not errors)
 *   4. Mutation tools (add_term) work and persist to the newly created file
 *   5. Subsequent queries find the newly added terms
 *   6. A second server instance can load the persisted glossary
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import {
  registerTools,
  TOOL_NAMES,
  COLD_START_GUIDANCE,
} from "../../src/tools/index.js";
import { createServer, type LingoServerConfig } from "../../src/server.js";

// ─── Test Helpers ────────────────────────────────────────────────────────

/**
 * Parse JSON text content from an MCP tool call result.
 */
function parseResult(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): Record<string, unknown> {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text as string);
}

/**
 * Checks whether a file exists on disk.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an MCP server + client harness pointing at a glossary path
 * where NO glossary file exists on disk. The storage is loaded (which
 * triggers auto-creation), simulating a real first-run experience.
 */
async function createNoGlossaryHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-no-glossary-test-"));

  // This path does NOT have a glossary file yet
  const glossaryPath = join(tempDir, ".lingo", "glossary.json");

  // Verify the file truly does not exist
  const existsBefore = await fileExists(glossaryPath);
  if (existsBefore) {
    throw new Error("Test setup error: glossary file should not exist yet");
  }

  // Initialize storage — load() detects missing file and creates empty store
  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("no-glossary-test-org");

  // Create server with the full createServer factory (includes adapter registries)
  const config: LingoServerConfig = {
    glossaryPath,
    organization: "no-glossary-test-org",
    logLevel: "error", // suppress logs during tests
  };
  const server = createServer(config, storage);

  // Create a client simulating an AI tool
  const client = new Client({
    name: "no-glossary-test-client",
    version: "1.0.0",
  });

  // Connect via in-memory transport
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    tempDir,
    glossaryPath,
    storage,
    server,
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Integration Tests ──────────────────────────────────────────────────

describe("No-Glossary Scenario Integration Tests", () => {
  let tempDir: string;
  let glossaryPath: string;
  let storage: JsonGlossaryStorage;
  let server: McpServer;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createNoGlossaryHarness();
    tempDir = harness.tempDir;
    glossaryPath = harness.glossaryPath;
    storage = harness.storage;
    server = harness.server;
    client = harness.client;
    cleanup = harness.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── 1. File Lifecycle ────────────────────────────────────────────────

  describe("glossary file auto-creation", () => {
    it("creates the glossary file on disk after storage.load()", async () => {
      // By the time we get here, load() has run in beforeEach
      const exists = await fileExists(glossaryPath);
      expect(exists).toBe(true);
    });

    it("creates the parent directory (.lingo/) if it does not exist", async () => {
      const lingoDir = join(tempDir, ".lingo");
      const exists = await fileExists(lingoDir);
      expect(exists).toBe(true);
    });

    it("creates a valid JSON glossary file with correct schema", async () => {
      const raw = await readFile(glossaryPath, "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.version).toBe("1.0.0");
      expect(parsed.organization).toBe("no-glossary-test-org");
      expect(typeof parsed.lastModified).toBe("string");
      expect(parsed.terms).toEqual({});
    });

    it("creates a store with zero terms", () => {
      const store = storage.getStore();
      expect(Object.keys(store.terms)).toHaveLength(0);
    });
  });

  // ── 2. Tool Discovery ────────────────────────────────────────────────

  describe("tool discovery with no pre-existing glossary", () => {
    it("client discovers all available tools", async () => {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);

      // All core tools should be present
      expect(toolNames).toContain(TOOL_NAMES.QUERY_CONTEXT);
      expect(toolNames).toContain(TOOL_NAMES.GET_TERM);
      expect(toolNames).toContain(TOOL_NAMES.ADD_TERM);
      expect(toolNames).toContain(TOOL_NAMES.UPDATE_TERM);
      expect(toolNames).toContain(TOOL_NAMES.REMOVE_TERM);
      expect(toolNames).toContain(TOOL_NAMES.LIST_TERMS);
      expect(toolNames).toContain(TOOL_NAMES.FIND_BY_FILE);
      expect(toolNames).toContain(TOOL_NAMES.LIST_ADAPTERS);
    });
  });

  // ── 3. Query Tools Return Graceful Empty State ────────────────────────

  describe("query tools return graceful responses (no errors)", () => {
    it("query_context returns success with empty results and cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "authentication" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
      expect(parsed._coldStart).toBe(true);
      expect(parsed.guidance).toBeDefined();
    });

    it("get_term by name returns success with null term (not an error)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Sprint Velocity" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term).toBeNull();
      expect(parsed._coldStart).toBe(true);
    });

    it("get_term by ID returns success with null term (not an error)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term).toBeNull();
      expect(parsed._coldStart).toBe(true);
    });

    it("list_terms returns success with empty array and cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
      expect(parsed._coldStart).toBe(true);
      expect(parsed.guidance).toBeDefined();
    });

    it("find_by_file returns success with empty results", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/services/auth.ts" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
      expect(parsed._coldStart).toBe(true);
    });

    it("list_adapters returns adapter info even without glossary data", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_ADAPTERS,
        arguments: {},
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);

      // Adapter listing doesn't depend on glossary state, so should return adapters
      const adapters = parsed.adapters as Array<{
        name: string;
        type: string;
        displayName: string;
      }>;
      expect(Array.isArray(adapters)).toBe(true);
    });

    it("suggest_code_changes returns success with empty suggestions", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Auth Guard",
          newName: "Security Gate",
          description: "Renaming for clarity",
        },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.suggestions).toEqual([]);
      expect(parsed._coldStart).toBe(true);
    });
  });

  // ── 4. Mutation: Adding Terms to the Empty Store ──────────────────────

  describe("adding terms to a freshly created glossary", () => {
    it("add_term succeeds and returns the new term", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points completed per sprint iteration",
          aliases: ["velocity", "SV"],
          category: "agile-metrics",
          tags: ["metrics", "planning"],
        },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed.term as Record<string, unknown>).name).toBe("Sprint Velocity");
      expect((parsed.term as Record<string, unknown>).definition).toBe(
        "Story points completed per sprint iteration"
      );
    });

    it("added term is persisted to the glossary file on disk", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Deployment Pipeline",
          definition: "CI/CD pipeline through staging to production",
        },
      });

      // Read the file directly to verify persistence
      const raw = await readFile(glossaryPath, "utf-8");
      const fileData = JSON.parse(raw);

      const termIds = Object.keys(fileData.terms);
      expect(termIds).toHaveLength(1);

      const term = fileData.terms[termIds[0]];
      expect(term.name).toBe("Deployment Pipeline");
      expect(term.definition).toBe("CI/CD pipeline through staging to production");
    });

    it("added term is queryable via query_context", async () => {
      // Add a term
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Authentication Guard",
          definition: "Middleware that validates JWT tokens for route protection",
          aliases: ["auth guard", "JWT validator"],
        },
      });

      // Query for it
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "auth guard" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);

      const terms = parsed.terms as Array<Record<string, unknown>>;
      expect(terms[0].name).toBe("Authentication Guard");
    });

    it("added term is retrievable via get_term by name", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Feature Flag System",
          definition: "Infrastructure for toggling features on/off per user segment",
        },
      });

      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Feature Flag System" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed.term as Record<string, unknown>).name).toBe("Feature Flag System");
    });

    it("cold-start guidance disappears after adding a term", async () => {
      // Before: cold-start guidance present
      const beforeResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      const beforeParsed = parseResult(beforeResult);
      expect(beforeParsed._coldStart).toBe(true);
      expect(beforeParsed.guidance).toBeDefined();

      // Add a term
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "API Gateway",
          definition: "Entry point for all external API requests",
        },
      });

      // After: cold-start guidance gone
      const afterResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      const afterParsed = parseResult(afterResult);
      expect(afterParsed._coldStart).toBeUndefined();
      expect(afterParsed.guidance).toBeUndefined();
      expect(afterParsed.count).toBe(1);
    });
  });

  // ── 5. Full Lifecycle: Create → Populate → Query → Persist → Reload ──

  describe("complete lifecycle from no glossary to populated and reloaded", () => {
    it("end-to-end: create → add terms → query → reload from disk", async () => {
      // Step 1: Add multiple terms
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points completed per sprint",
          aliases: ["velocity", "SV"],
          category: "agile-metrics",
          tags: ["metrics"],
          codeLocations: [
            {
              filePath: "src/metrics/velocity.ts",
              symbol: "VelocityCalculator",
              relationship: "defines",
            },
          ],
        },
      });

      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Auth Guard",
          definition: "JWT validation middleware",
          aliases: ["authentication guard"],
          category: "security",
          tags: ["auth"],
          codeLocations: [
            {
              filePath: "src/middleware/auth.ts",
              symbol: "AuthGuard",
              relationship: "defines",
            },
          ],
        },
      });

      // Step 2: Verify both terms are queryable
      const listResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      const listParsed = parseResult(listResult);
      expect(listParsed.count).toBe(2);
      expect(listParsed._coldStart).toBeUndefined();

      // Step 3: Verify find_by_file works
      const findResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/middleware/auth.ts" },
      });
      const findParsed = parseResult(findResult);
      expect(findParsed.count).toBe(1);
      const foundTerms = findParsed.terms as Array<Record<string, unknown>>;
      expect(foundTerms[0].name).toBe("Auth Guard");

      // Step 4: Verify the data persisted to disk correctly
      const raw = await readFile(glossaryPath, "utf-8");
      const fileData = JSON.parse(raw);
      expect(Object.keys(fileData.terms)).toHaveLength(2);

      // Step 5: Create a SECOND storage instance and load from same file
      // This proves the glossary was correctly persisted and is reloadable
      const storage2 = new JsonGlossaryStorage(glossaryPath);
      const reloadedStore = await storage2.load("no-glossary-test-org");

      expect(Object.keys(reloadedStore.terms)).toHaveLength(2);

      const termNames = Object.values(reloadedStore.terms).map((t) => t.name);
      expect(termNames).toContain("Sprint Velocity");
      expect(termNames).toContain("Auth Guard");
    });
  });

  // ── 6. Edge Case: Deeply Nested Glossary Path ─────────────────────────

  describe("deeply nested glossary path", () => {
    it("creates all necessary parent directories automatically", async () => {
      // Clean up existing harness
      await cleanup();

      // Create new temp dir with deeply nested path
      const deepTempDir = await mkdtemp(join(tmpdir(), "lingo-deep-path-test-"));
      const deepGlossaryPath = join(
        deepTempDir,
        "a",
        "b",
        "c",
        ".lingo",
        "glossary.json"
      );

      const deepStorage = new JsonGlossaryStorage(deepGlossaryPath);
      await deepStorage.load("deep-org");

      // Verify file was created
      const exists = await fileExists(deepGlossaryPath);
      expect(exists).toBe(true);

      // Verify it's a valid store
      const store = deepStorage.getStore();
      expect(store.organization).toBe("deep-org");
      expect(Object.keys(store.terms)).toHaveLength(0);

      // Clean up
      await rm(deepTempDir, { recursive: true, force: true });

      // Re-create harness for afterEach cleanup
      const harness = await createNoGlossaryHarness();
      tempDir = harness.tempDir;
      glossaryPath = harness.glossaryPath;
      storage = harness.storage;
      server = harness.server;
      client = harness.client;
      cleanup = harness.cleanup;
    });
  });

  // ── 7. Multiple Calls to Non-Existent Store ───────────────────────────

  describe("multiple sequential tool calls on fresh store", () => {
    it("handles rapid sequential queries without errors", async () => {
      // Fire multiple queries against empty store — none should error
      const results = await Promise.all([
        client.callTool({
          name: TOOL_NAMES.QUERY_CONTEXT,
          arguments: { query: "velocity" },
        }),
        client.callTool({
          name: TOOL_NAMES.LIST_TERMS,
          arguments: {},
        }),
        client.callTool({
          name: TOOL_NAMES.FIND_BY_FILE,
          arguments: { filePath: "src/index.ts" },
        }),
      ]);

      for (const result of results) {
        expect(result.isError).toBeFalsy();
        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
      }
    });

    it("handles add then immediate query correctly", async () => {
      // Add term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Cache Layer",
          definition: "Redis-backed caching infrastructure",
          codeLocations: [
            {
              filePath: "src/cache/redis-client.ts",
              symbol: "RedisCache",
              relationship: "defines",
            },
          ],
        },
      });
      expect(parseResult(addResult).success).toBe(true);

      // Immediately query
      const queryResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "cache" },
      });
      const queryParsed = parseResult(queryResult);
      expect(queryParsed.success).toBe(true);
      expect(queryParsed.count).toBeGreaterThanOrEqual(1);

      // Immediately find by file
      const findResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/cache/redis-client.ts" },
      });
      const findParsed = parseResult(findResult);
      expect(findParsed.count).toBe(1);
    });
  });
});
