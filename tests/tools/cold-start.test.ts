/**
 * Tests for Cold Start Graceful Handling (Sub-AC 1 of AC 10)
 *
 * Verifies that all query/lookup tools return meaningful empty-state responses
 * (not errors) when the glossary store has zero mappings, including helpful
 * guidance on how to populate data.
 *
 * Cold start = a new organization with zero glossary terms.
 * All tools should:
 *   1. Return success: true (not isError)
 *   2. Return empty results (not crashes or confusing errors)
 *   3. Include a _coldStart flag and guidance object with actionable instructions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

// ─── Test Helpers ────────────────────────────────────────────────────

/**
 * Parse the JSON text content from an MCP tool result.
 */
function parseToolResult(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}) {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text as string);
}

/**
 * Verifies that a response contains cold-start guidance with the expected structure.
 */
function expectColdStartGuidance(parsed: Record<string, unknown>) {
  expect(parsed._coldStart).toBe(true);
  expect(parsed.guidance).toBeDefined();

  const guidance = parsed.guidance as Record<string, unknown>;
  expect(typeof guidance.message).toBe("string");
  expect(guidance.message).toContain("empty");

  expect(Array.isArray(guidance.howToPopulate)).toBe(true);
  const howTo = guidance.howToPopulate as string[];
  expect(howTo.length).toBeGreaterThanOrEqual(1);
  // Should mention bootstrap and add_term as ways to populate
  const allGuidance = howTo.join(" ");
  expect(allGuidance).toContain("bootstrap");
  expect(allGuidance).toContain("add_term");

  expect(typeof guidance.quickStart).toBe("string");
  expect((guidance.quickStart as string).length).toBeGreaterThan(0);
}

/**
 * Creates a connected MCP server + client pair with an EMPTY glossary store.
 * This simulates the cold-start scenario — a brand new organization with zero data.
 */
async function createEmptyStoreTestHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-cold-start-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  // Verify the store is genuinely empty
  const store = storage.getStore();
  if (Object.keys(store.terms).length !== 0) {
    throw new Error("Test setup error: store should be empty");
  }

  const server = new McpServer(
    { name: "lingo-test", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );
  registerTools(server, storage);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    tempDir,
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

// ─── Tests ──────────────────────────────────────────────────────────

describe("Cold Start Graceful Handling", () => {
  let tempDir: string;
  let storage: JsonGlossaryStorage;
  let server: McpServer;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createEmptyStoreTestHarness();
    tempDir = harness.tempDir;
    storage = harness.storage;
    server = harness.server;
    client = harness.client;
    cleanup = harness.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── COLD_START_GUIDANCE export ──────────────────────────────────────

  describe("COLD_START_GUIDANCE constant", () => {
    it("has a message describing the empty state", () => {
      expect(typeof COLD_START_GUIDANCE.message).toBe("string");
      expect(COLD_START_GUIDANCE.message).toContain("empty");
    });

    it("has howToPopulate with actionable instructions", () => {
      expect(Array.isArray(COLD_START_GUIDANCE.howToPopulate)).toBe(true);
      expect(COLD_START_GUIDANCE.howToPopulate.length).toBeGreaterThanOrEqual(2);
      const combined = COLD_START_GUIDANCE.howToPopulate.join(" ");
      expect(combined).toContain("bootstrap");
      expect(combined).toContain("add_term");
    });

    it("has a quickStart hint", () => {
      expect(typeof COLD_START_GUIDANCE.quickStart).toBe("string");
      expect(COLD_START_GUIDANCE.quickStart.length).toBeGreaterThan(0);
    });
  });

  // ── query_context ──────────────────────────────────────────────────

  describe("query_context with empty store", () => {
    it("returns success: true (not an error)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint velocity" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
    });

    it("returns zero results with empty terms array", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "any search term" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("includes cold-start guidance with actionable instructions", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint velocity" },
      });

      const parsed = parseToolResult(result);
      expectColdStartGuidance(parsed);
    });

    it("preserves the query in the response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "authentication flow" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.query).toBe("authentication flow");
    });

    it("works with category filter on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "test", category: "billing" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });

    it("works with limit parameter on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "test", limit: 5 },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });
  });

  // ── get_term ───────────────────────────────────────────────────────

  describe("get_term with empty store", () => {
    it("returns success: true (not an error) when looking up by name", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Sprint Velocity" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
    });

    it("returns success: true (not an error) when looking up by ID", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
    });

    it("returns term: null instead of a hard error", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Sprint Velocity" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.term).toBeNull();
    });

    it("includes a human-readable message explaining the empty state", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Auth Guard" },
      });

      const parsed = parseToolResult(result);
      expect(typeof parsed.message).toBe("string");
      expect(parsed.message).toContain("Auth Guard");
      expect(parsed.message).toContain("empty");
    });

    it("includes cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Feature Flag" },
      });

      const parsed = parseToolResult(result);
      expectColdStartGuidance(parsed);
    });

    it("still returns isError for missing arguments (no id or name)", async () => {
      // This is a usage error, not a cold-start scenario — should still error
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: {},
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Either 'id' or 'name' must be provided");
    });
  });

  // ── list_terms ─────────────────────────────────────────────────────

  describe("list_terms with empty store", () => {
    it("returns success: true with zero terms", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("includes cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const parsed = parseToolResult(result);
      expectColdStartGuidance(parsed);
    });

    it("works with category filter on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: "authentication" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });

    it("works with confidence filter on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { confidence: "manual" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });

    it("works with adapter filter on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { adapter: "notion" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });

    it("works with query search on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { query: "sprint" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });

    it("works with filePath search on empty store", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { filePath: "src/services/auth.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expectColdStartGuidance(parsed);
    });
  });

  // ── find_by_file ───────────────────────────────────────────────────

  describe("find_by_file with empty store", () => {
    it("returns success: true with zero results", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/services/auth.ts" },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("preserves the filePath in the response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/billing/payment-gateway.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.filePath).toBe("src/billing/payment-gateway.ts");
    });

    it("includes cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/services/auth.ts" },
      });

      const parsed = parseToolResult(result);
      expectColdStartGuidance(parsed);
    });
  });

  // ── suggest_code_changes ────────────────────────────────────────────

  describe("suggest_code_changes with empty store", () => {
    it("returns success: true with empty suggestions", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming for SAFe alignment",
        },
      });

      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.suggestions).toEqual([]);
    });

    it("includes cold-start guidance", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "deprecate",
          oldName: "Some Feature",
          description: "Being retired",
        },
      });

      const parsed = parseToolResult(result);
      expectColdStartGuidance(parsed);
    });

    it("includes impact analysis showing nothing found", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Auth Guard",
          newName: "Security Gate",
          description: "Renaming for clarity",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.impact).toBeDefined();
      expect(parsed.impact.found).toBe(false);
      expect(parsed.impact.matchedTerms).toEqual([]);
    });

    it("includes summary with zero counts", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "redefine",
          oldName: "Billing Module",
          description: "Expanding scope",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.summary).toBeDefined();
      expect(parsed.summary.totalSuggestions).toBe(0);
    });

    it("returns warnings array (non-empty, since no terms matched)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Nonexistent",
          newName: "New Name",
          description: "Testing",
        },
      });

      const parsed = parseToolResult(result);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings.length).toBeGreaterThan(0);
    });
  });

  // ── Cross-cutting: cold-start guidance disappears after adding data ─

  describe("cold-start guidance lifecycle", () => {
    it("guidance appears on empty store, disappears after adding a term", async () => {
      // Step 1: Verify guidance appears on empty store
      const emptyResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      const emptyParsed = parseToolResult(emptyResult);
      expect(emptyParsed._coldStart).toBe(true);
      expect(emptyParsed.guidance).toBeDefined();

      // Step 2: Add a term
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Rate of story points per sprint",
        },
      });

      // Step 3: Verify guidance no longer appears
      const populatedResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      const populatedParsed = parseToolResult(populatedResult);
      expect(populatedParsed._coldStart).toBeUndefined();
      expect(populatedParsed.guidance).toBeUndefined();
      expect(populatedParsed.count).toBe(1);
    });

    it("query_context drops guidance after adding a term", async () => {
      // Empty state — should have guidance
      const emptyResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "velocity" },
      });
      expect(parseToolResult(emptyResult)._coldStart).toBe(true);

      // Add a term
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Rate of story points per sprint",
        },
      });

      // Populated state — should NOT have guidance
      const populatedResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "velocity" },
      });
      const parsed = parseToolResult(populatedResult);
      expect(parsed._coldStart).toBeUndefined();
      expect(parsed.count).toBeGreaterThanOrEqual(1);
    });

    it("get_term returns isError when store has terms but specific term not found", async () => {
      // Add a term first
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Rate of story points per sprint",
        },
      });

      // Look up a term that doesn't exist — store is NOT empty, so this is a real "not found"
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Nonexistent Term" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
      // No cold-start guidance since store is not empty
      expect(parsed._coldStart).toBeUndefined();
    });

    it("find_by_file drops guidance after adding a term with code locations", async () => {
      // Empty state — guidance present
      const emptyResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/auth.ts" },
      });
      expect(parseToolResult(emptyResult)._coldStart).toBe(true);

      // Add a term with code location
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Auth Service",
          definition: "Authentication service",
          codeLocations: [
            {
              filePath: "src/auth.ts",
              symbol: "AuthService",
              relationship: "defines",
            },
          ],
        },
      });

      // Populated state — no guidance
      const populatedResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/auth.ts" },
      });
      const parsed = parseToolResult(populatedResult);
      expect(parsed._coldStart).toBeUndefined();
      expect(parsed.count).toBe(1);
    });
  });
});
