/**
 * Tests for Lingo MCP resource registration and stub responses.
 *
 * Uses the MCP SDK's in-process transport to test resources at the protocol level,
 * verifying both resources/list and resources/read handlers work correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type LingoServerConfig } from "../src/server.js";
import {
  RESOURCE_URIS,
  STATIC_RESOURCE_URIS,
  RESOURCE_TEMPLATE_NAMES,
} from "../src/resources/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─── Test Helpers ──────────────────────────────────────────────────────

const TEST_CONFIG: LingoServerConfig = {
  glossaryPath: ".lingo/test-glossary.json",
  organization: "test-org",
  logLevel: "error", // suppress logs during tests
};

/**
 * Sets up a connected MCP server + client pair for testing.
 */
async function createTestPair(): Promise<{
  server: McpServer;
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = createServer(TEST_CONFIG);
  const client = new Client({ name: "test-client", version: "0.0.1" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Lingo MCP Resources", () => {
  let client: Client;
  let server: McpServer;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const pair = await createTestPair();
    client = pair.client;
    server = pair.server;
    cleanup = pair.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── resources/list ──────────────────────────────────────────────────

  describe("resources/list handler", () => {
    it("returns all registered static resources", async () => {
      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);

      for (const uri of STATIC_RESOURCE_URIS) {
        expect(uris).toContain(uri);
      }
    });

    it("returns exactly 3 static resources", async () => {
      const result = await client.listResources();
      expect(result.resources).toHaveLength(3);
    });

    it("each static resource has a non-empty description", async () => {
      const result = await client.listResources();
      for (const resource of result.resources) {
        expect(resource.description).toBeTruthy();
        expect(typeof resource.description).toBe("string");
        expect(resource.description!.length).toBeGreaterThan(10);
      }
    });

    it("each static resource has application/json mimeType", async () => {
      const result = await client.listResources();
      for (const resource of result.resources) {
        expect(resource.mimeType).toBe("application/json");
      }
    });

    it("includes lingo://terms resource with correct metadata", async () => {
      const result = await client.listResources();
      const termsResource = result.resources.find(
        (r) => r.uri === RESOURCE_URIS.TERMS
      );

      expect(termsResource).toBeDefined();
      expect(termsResource!.name).toBe("terms");
      expect(termsResource!.description).toContain("glossary");
    });

    it("includes lingo://categories resource", async () => {
      const result = await client.listResources();
      const categoriesResource = result.resources.find(
        (r) => r.uri === RESOURCE_URIS.CATEGORIES
      );

      expect(categoriesResource).toBeDefined();
      expect(categoriesResource!.name).toBe("categories");
    });

    it("includes lingo://status resource", async () => {
      const result = await client.listResources();
      const statusResource = result.resources.find(
        (r) => r.uri === RESOURCE_URIS.STATUS
      );

      expect(statusResource).toBeDefined();
      expect(statusResource!.name).toBe("status");
    });
  });

  // ── resource templates ──────────────────────────────────────────────

  describe("resource templates", () => {
    it("lists the term_by_id resource template", async () => {
      const result = await client.listResourceTemplates();
      const templates = result.resourceTemplates;

      expect(templates.length).toBeGreaterThanOrEqual(1);

      const termTemplate = templates.find(
        (t) => t.name === RESOURCE_TEMPLATE_NAMES.TERM_BY_ID
      );
      expect(termTemplate).toBeDefined();
      expect(termTemplate!.uriTemplate).toBe(RESOURCE_URIS.TERM_BY_ID);
    });

    it("term_by_id template has description and mimeType", async () => {
      const result = await client.listResourceTemplates();
      const termTemplate = result.resourceTemplates.find(
        (t) => t.name === RESOURCE_TEMPLATE_NAMES.TERM_BY_ID
      );

      expect(termTemplate).toBeDefined();
      expect(termTemplate!.description).toBeTruthy();
      expect(termTemplate!.mimeType).toBe("application/json");
    });
  });

  // ── resources/read ──────────────────────────────────────────────────

  describe("resources/read handler", () => {
    it("reads lingo://terms and returns stub JSON", async () => {
      const result = await client.readResource({
        uri: RESOURCE_URIS.TERMS,
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe(RESOURCE_URIS.TERMS);
      expect(content.mimeType).toBe("application/json");

      const parsed = JSON.parse(content.text as string);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
      expect(parsed.hint).toBeTruthy();
    });

    it("reads lingo://categories and returns stub JSON", async () => {
      const result = await client.readResource({
        uri: RESOURCE_URIS.CATEGORIES,
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe(RESOURCE_URIS.CATEGORIES);
      expect(content.mimeType).toBe("application/json");

      const parsed = JSON.parse(content.text as string);
      expect(parsed.count).toBe(0);
      expect(parsed.categories).toEqual([]);
    });

    it("reads lingo://status and returns stub JSON", async () => {
      const result = await client.readResource({
        uri: RESOURCE_URIS.STATUS,
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe(RESOURCE_URIS.STATUS);
      expect(content.mimeType).toBe("application/json");

      const parsed = JSON.parse(content.text as string);
      expect(parsed.version).toBe("0.1.0");
      expect(parsed.organization).toBe("default");
      expect(parsed.totalTerms).toBe(0);
      expect(parsed.confidenceBreakdown).toBeDefined();
      expect(parsed.confidenceBreakdown.manual).toBe(0);
      expect(parsed.confidenceBreakdown["ai-suggested"]).toBe(0);
      expect(parsed.confidenceBreakdown["ai-verified"]).toBe(0);
    });

    it("reads lingo://terms/{termId} template resource and returns stub", async () => {
      const testId = "550e8400-e29b-41d4-a716-446655440000";
      const result = await client.readResource({
        uri: `lingo://terms/${testId}`,
      });

      expect(result.contents).toHaveLength(1);
      const content = result.contents[0];
      expect(content.uri).toBe(`lingo://terms/${testId}`);
      expect(content.mimeType).toBe("application/json");

      const parsed = JSON.parse(content.text as string);
      expect(parsed.error).toBe("Term not found");
      expect(parsed.termId).toBe(testId);
      expect(parsed.hint).toBeTruthy();
    });

    it("terms resource stub includes helpful description", async () => {
      const result = await client.readResource({
        uri: RESOURCE_URIS.TERMS,
      });

      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.description).toContain("glossary");
      expect(parsed.description).toContain("terminology");
    });

    it("status resource stub includes confidence breakdown", async () => {
      const result = await client.readResource({
        uri: RESOURCE_URIS.STATUS,
      });

      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.confidenceBreakdown).toEqual({
        manual: 0,
        "ai-suggested": 0,
        "ai-verified": 0,
      });
    });
  });

  // ── RESOURCE_URIS constant ─────────────────────────────────────────

  describe("RESOURCE_URIS constant", () => {
    it("has all expected URIs", () => {
      expect(RESOURCE_URIS.TERMS).toBe("lingo://terms");
      expect(RESOURCE_URIS.TERM_BY_ID).toBe("lingo://terms/{termId}");
      expect(RESOURCE_URIS.CATEGORIES).toBe("lingo://categories");
      expect(RESOURCE_URIS.STATUS).toBe("lingo://status");
    });

    it("STATIC_RESOURCE_URIS contains only static (non-template) URIs", () => {
      expect(STATIC_RESOURCE_URIS).toHaveLength(3);
      expect(STATIC_RESOURCE_URIS).toContain(RESOURCE_URIS.TERMS);
      expect(STATIC_RESOURCE_URIS).toContain(RESOURCE_URIS.CATEGORIES);
      expect(STATIC_RESOURCE_URIS).toContain(RESOURCE_URIS.STATUS);
      // Template URI should NOT be in the static list
      expect(STATIC_RESOURCE_URIS).not.toContain(RESOURCE_URIS.TERM_BY_ID);
    });
  });
});
