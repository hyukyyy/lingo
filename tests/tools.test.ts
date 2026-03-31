/**
 * Tests for Lingo MCP tool registration and stub responses.
 *
 * Uses the MCP SDK's in-process transport to test tools at the protocol level,
 * verifying both tools/list and tools/call handlers work correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JsonGlossaryStorage } from "../src/storage/json-store.js";
import { registerTools, ALL_TOOL_NAMES, TOOL_NAMES } from "../src/tools/index.js";
import { createServer, type LingoServerConfig } from "../src/server.js";

// ─── Test Helpers ──────────────────────────────────────────────────────

/**
 * Sets up a connected MCP server + client pair for testing.
 * Creates a temp directory for storage so tools have a real backend.
 */
async function createTestPair(): Promise<{
  server: McpServer;
  client: Client;
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-tools-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  const testConfig: LingoServerConfig = {
    glossaryPath,
    organization: "test-org",
    logLevel: "error",
  };

  const server = createServer(testConfig, storage);
  const client = new Client({ name: "test-client", version: "0.0.1" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

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

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Lingo MCP Tools", () => {
  let client: Client;
  let server: McpServer;
  let cleanup: () => Promise<void>;
  let tempDir: string;

  beforeAll(async () => {
    const pair = await createTestPair();
    client = pair.client;
    server = pair.server;
    tempDir = pair.tempDir;
    cleanup = pair.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── tools/list ───────────────────────────────────────────────────────

  describe("tools/list handler", () => {
    it("returns all registered tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);

      for (const name of ALL_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });

    it("registers exactly 10 tools", async () => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(10);
    });

    it("each tool has a non-empty description", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe("string");
        expect(tool.description!.length).toBeGreaterThan(10);
      }
    });

    it("each tool has an inputSchema", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("query_context tool has expected parameters", async () => {
      const result = await client.listTools();
      const queryTool = result.tools.find(
        (t) => t.name === TOOL_NAMES.QUERY_CONTEXT
      );

      expect(queryTool).toBeDefined();
      const props = queryTool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("query");
      expect(props).toHaveProperty("category");
      expect(props).toHaveProperty("limit");
    });

    it("add_term tool has expected parameters", async () => {
      const result = await client.listTools();
      const addTool = result.tools.find(
        (t) => t.name === TOOL_NAMES.ADD_TERM
      );

      expect(addTool).toBeDefined();
      const props = addTool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("name");
      expect(props).toHaveProperty("definition");
      expect(props).toHaveProperty("aliases");
      expect(props).toHaveProperty("codeLocations");
    });

    it("update_term tool has expected parameters", async () => {
      const result = await client.listTools();
      const updateTool = result.tools.find(
        (t) => t.name === TOOL_NAMES.UPDATE_TERM
      );

      expect(updateTool).toBeDefined();
      const props = updateTool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("id");
      expect(props).toHaveProperty("name");
      expect(props).toHaveProperty("definition");
      expect(props).toHaveProperty("aliases");
      expect(props).toHaveProperty("codeLocations");
      expect(props).toHaveProperty("confidence");
      expect(props).toHaveProperty("source");
    });

    it("bootstrap tool has expected parameters", async () => {
      const result = await client.listTools();
      const bootstrapTool = result.tools.find(
        (t) => t.name === TOOL_NAMES.BOOTSTRAP
      );

      expect(bootstrapTool).toBeDefined();
      const props = bootstrapTool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("rootDir");
      expect(props).toHaveProperty("adapter");
      expect(props).toHaveProperty("dryRun");
    });
  });

  // ── tools/call ───────────────────────────────────────────────────────

  describe("tools/call handler", () => {
    it("query_context returns real search results", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint velocity" },
      });

      expect(result.content).toHaveLength(1);
      const content = result.content[0] as { type: string; text: string };
      expect(content.type).toBe("text");

      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.query).toBe("sprint velocity");
      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.terms)).toBe(true);
    });

    it("get_term returns cold-start guidance for non-existent ID on empty store", async () => {
      const testId = "550e8400-e29b-41d4-a716-446655440000";
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: testId },
      });

      // On empty store, cold-start behavior returns success with guidance
      expect(result.isError).toBeFalsy();
      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.term).toBeNull();
      expect(parsed._coldStart).toBe(true);
      expect(parsed.guidance).toBeDefined();
    });

    it("add_term creates a real term", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "The rate of story points completed per sprint",
        },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
      expect(parsed.term.definition).toBe("The rate of story points completed per sprint");
      expect(parsed.term.id).toBeDefined();
    });

    it("update_term updates an existing term", async () => {
      // First, create a term to update
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Updatable Term",
          definition: "Original definition",
        },
      });
      const addContent = addResult.content[0] as { type: string; text: string };
      const addParsed = JSON.parse(addContent.text);
      const termId = addParsed.term.id;

      // Now update it
      const result = await client.callTool({
        name: TOOL_NAMES.UPDATE_TERM,
        arguments: {
          id: termId,
          definition: "Updated definition",
          aliases: ["UT"],
        },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Updatable Term");
      expect(parsed.term.definition).toBe("Updated definition");
      expect(parsed.term.aliases).toEqual(["UT"]);
    });

    it("update_term returns error for non-existent ID", async () => {
      const testId = "550e8400-e29b-41d4-a716-446655440000";
      const result = await client.callTool({
        name: TOOL_NAMES.UPDATE_TERM,
        arguments: {
          id: testId,
          definition: "Should fail",
        },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("remove_term removes an existing term", async () => {
      // First create a term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Removable Term",
          definition: "A term that will be removed",
        },
      });
      const addContent = addResult.content[0] as { type: string; text: string };
      const addParsed = JSON.parse(addContent.text);
      const termId = addParsed.term.id;

      // Now remove it
      const result = await client.callTool({
        name: TOOL_NAMES.REMOVE_TERM,
        arguments: { id: termId },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("removed successfully");
      expect(parsed.removedTerm.name).toBe("Removable Term");
    });

    it("remove_term returns error for non-existent ID", async () => {
      const testId = "550e8400-e29b-41d4-a716-446655440000";
      const result = await client.callTool({
        name: TOOL_NAMES.REMOVE_TERM,
        arguments: { id: testId },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("list_terms returns real response with filters", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {
          category: "authentication",
          confidence: "manual",
        },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.terms)).toBe(true);
    });

    it("find_by_file returns real search results", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/services/auth.ts" },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toBe("src/services/auth.ts");
      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.terms)).toBe(true);
    });

    it("bootstrap returns real response with summary", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.BOOTSTRAP,
        arguments: {
          rootDir: "/nonexistent-test-path",
          dryRun: true,
        },
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      // The real bootstrap orchestrator returns success/error
      // With a nonexistent path it may error or return empty results
      expect(typeof parsed.success).toBe("boolean");
    });

    it("list_terms works with no arguments", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      expect(parsed.success).toBe(true);
      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.terms)).toBe(true);
    });

    it("bootstrap works with no arguments", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.BOOTSTRAP,
        arguments: {},
      });

      const content = result.content[0] as { type: string; text: string };
      const parsed = JSON.parse(content.text);
      // The real bootstrap orchestrator returns success/error
      expect(typeof parsed.success).toBe("boolean");
    });
  });
});
