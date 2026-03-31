/**
 * Tests for the MCP query tools: query_context, get_term, list_terms, find_by_file.
 *
 * These tests verify that AI clients can search and retrieve organizational
 * terminology-to-code mappings through the MCP tool interface. Each tool is
 * tested against a real JsonGlossaryStorage backend with pre-seeded terms.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { registerTools, TOOL_NAMES } from "../../src/tools/index.js";
import type { GlossaryTerm } from "../../src/models/glossary.js";

// ─── Test Helpers ────────────────────────────────────────────────────

/**
 * Parse the JSON text content from an MCP tool result.
 */
function parseToolResult(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text as string);
}

/**
 * Create a connected MCP server + client pair with pre-seeded glossary terms.
 */
async function createTestHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-query-tools-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  // Pre-seed glossary with test terms
  const sprintVelocity = await storage.addTerm({
    name: "Sprint Velocity",
    definition: "The number of story points completed per sprint cycle",
    aliases: ["velocity", "team speed", "SV"],
    category: "agile",
    tags: ["metrics", "planning"],
    codeLocations: [
      {
        filePath: "src/metrics/velocity.ts",
        symbol: "calculateVelocity",
        relationship: "defines",
        note: "Core velocity calculation logic",
      },
      {
        filePath: "src/dashboard/sprint-overview.tsx",
        symbol: "VelocityChart",
        relationship: "uses",
      },
    ],
    source: { adapter: "notion", externalId: "page-123" },
    confidence: "ai-verified",
  });

  const authFlow = await storage.addTerm({
    name: "Authentication Flow",
    definition: "The process users go through to verify their identity",
    aliases: ["auth flow", "login process", "sign-in"],
    category: "authentication",
    tags: ["security", "user-facing"],
    codeLocations: [
      {
        filePath: "src/services/auth.ts",
        symbol: "AuthService",
        relationship: "defines",
        note: "Main auth service",
      },
      {
        filePath: "src/middleware/auth-guard.ts",
        symbol: "AuthGuard",
        relationship: "implements",
        lineRange: { start: 10, end: 50 },
      },
      {
        filePath: "tests/auth.test.ts",
        symbol: "authTests",
        relationship: "tests",
      },
    ],
    source: { adapter: "notion", externalId: "page-456" },
    confidence: "manual",
  });

  const billingModule = await storage.addTerm({
    name: "Billing Module",
    definition: "The subsystem handling subscription management and payment processing",
    aliases: ["billing", "payments", "subscription engine"],
    category: "billing",
    tags: ["payments", "infrastructure"],
    codeLocations: [
      {
        filePath: "src/billing/subscription-manager.ts",
        symbol: "SubscriptionManager",
        relationship: "defines",
      },
      {
        filePath: "src/billing/payment-gateway.ts",
        symbol: "PaymentGateway",
        relationship: "implements",
      },
    ],
    source: { adapter: "linear" },
    confidence: "ai-suggested",
  });

  const featureFlag = await storage.addTerm({
    name: "Feature Flag System",
    definition: "Infrastructure for toggling features on/off per user segment",
    aliases: ["feature toggles", "flags", "FF"],
    category: "infrastructure",
    tags: ["devops", "release-management"],
    codeLocations: [
      {
        filePath: "src/features/flag-manager.ts",
        symbol: "FlagManager",
        relationship: "defines",
      },
      {
        filePath: "src/middleware/feature-gate.ts",
        symbol: "featureGate",
        relationship: "implements",
      },
    ],
    source: { adapter: "manual" },
    confidence: "manual",
  });

  const sprintRetro = await storage.addTerm({
    name: "Sprint Retrospective",
    definition: "Team ceremony at end of sprint to reflect on process improvements",
    aliases: ["retro", "retrospective"],
    category: "agile",
    tags: ["process", "planning"],
    codeLocations: [],
    source: { adapter: "notion", externalId: "page-789" },
    confidence: "ai-suggested",
  });

  // Set up MCP server + client via in-memory transport
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
    terms: {
      sprintVelocity,
      authFlow,
      billingModule,
      featureFlag,
      sprintRetro,
    },
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("MCP Query Tools", () => {
  let tempDir: string;
  let storage: JsonGlossaryStorage;
  let server: McpServer;
  let client: Client;
  let terms: Record<string, GlossaryTerm>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createTestHarness();
    tempDir = harness.tempDir;
    storage = harness.storage;
    server = harness.server;
    client = harness.client;
    terms = harness.terms;
    cleanup = harness.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── query_context ───────────────────────────────────────────────────

  describe("query_context (search_context)", () => {
    it("returns matching terms for an exact name query", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Sprint Velocity" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.query).toBe("Sprint Velocity");
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("returns matching terms for a partial name query", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "velocity" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      // "Sprint Velocity" should be the top result
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Sprint Velocity");
    });

    it("returns matching terms when searching by alias", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "team speed" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("returns matching terms when searching by definition content", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "subscription management" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Billing Module");
    });

    it("returns empty results for a non-matching query", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "xyznonexistent123" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("filters results by category", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint", category: "agile" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      // All returned terms should be in the "agile" category
      for (const term of parsed.terms) {
        expect(term.category).toBe("agile");
      }
    });

    it("category filter excludes non-matching categories", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint", category: "billing" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      // "Sprint Velocity" and "Sprint Retrospective" are "agile", not "billing"
      expect(parsed.count).toBe(0);
    });

    it("respects the limit parameter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint", limit: 1 },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.terms.length).toBeLessThanOrEqual(1);
    });

    it("defaults to limit of 10 when not specified", async () => {
      // With 5 seeded terms, all should be under the default limit
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "a" }, // broad query
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.terms.length).toBeLessThanOrEqual(10);
    });

    it("search is case-insensitive", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "SPRINT VELOCITY" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("returns terms sorted by relevance (exact match first)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Sprint Velocity" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      // Sprint Velocity should be first (exact name match)
      if (parsed.terms.length > 0) {
        expect(parsed.terms[0].name).toBe("Sprint Velocity");
      }
    });

    it("includes code locations in the response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Sprint Velocity" },
      });

      const parsed = parseToolResult(result);
      const term = parsed.terms[0];
      expect(term.codeLocations).toBeDefined();
      expect(term.codeLocations.length).toBeGreaterThan(0);
      expect(term.codeLocations[0].filePath).toBe(
        "src/metrics/velocity.ts"
      );
      expect(term.codeLocations[0].symbol).toBe("calculateVelocity");
      expect(term.codeLocations[0].relationship).toBe("defines");
    });

    it("includes full term metadata in the response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Authentication Flow" },
      });

      const parsed = parseToolResult(result);
      const term = parsed.terms[0];
      expect(term.id).toBeDefined();
      expect(term.name).toBe("Authentication Flow");
      expect(term.definition).toBeDefined();
      expect(term.aliases).toEqual(
        expect.arrayContaining(["auth flow", "login process", "sign-in"])
      );
      expect(term.category).toBe("authentication");
      expect(term.tags).toEqual(
        expect.arrayContaining(["security", "user-facing"])
      );
      expect(term.source).toBeDefined();
      expect(term.confidence).toBe("manual");
      expect(term.createdAt).toBeDefined();
      expect(term.updatedAt).toBeDefined();
    });

    it("can search by category name", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "authentication" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Authentication Flow");
    });
  });

  // ── get_term (resolve_term) ─────────────────────────────────────────

  describe("get_term (resolve_term)", () => {
    it("retrieves a term by exact ID", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.sprintVelocity.id },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.id).toBe(terms.sprintVelocity.id);
      expect(parsed.term.name).toBe("Sprint Velocity");
      expect(parsed.term.definition).toContain("story points");
    });

    it("retrieves a term by name search", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "Authentication Flow" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Authentication Flow");
    });

    it("retrieves a term by alias search", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "payments" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Billing Module");
    });

    it("name search is case-insensitive", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "FEATURE FLAG SYSTEM" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Feature Flag System");
    });

    it("returns full term details with code locations", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.authFlow.id },
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.codeLocations).toHaveLength(3);
      expect(parsed.term.codeLocations[0].filePath).toBe(
        "src/services/auth.ts"
      );
      expect(parsed.term.codeLocations[1].lineRange).toEqual({
        start: 10,
        end: 50,
      });
      expect(parsed.term.aliases).toEqual([
        "auth flow",
        "login process",
        "sign-in",
      ]);
    });

    it("prefers ID lookup over name search", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: {
          id: terms.sprintVelocity.id,
          name: "Billing Module",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("falls back to name search when ID not found", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: {
          id: "00000000-0000-4000-8000-000000000000",
          name: "Billing Module",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Billing Module");
    });

    it("returns error when neither id nor name provided", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: {},
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Either 'id' or 'name' must be provided");
    });

    it("returns error when term not found", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "xyznonexistent123" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("returns error when ID not found and no name fallback", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: "00000000-0000-4000-8000-000000000000" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });
  });

  // ── list_terms ──────────────────────────────────────────────────────

  describe("list_terms", () => {
    it("returns all terms when called with no arguments", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(5); // 5 pre-seeded terms
      expect(parsed.terms).toHaveLength(5);
    });

    it("returns all terms with full details", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const parsed = parseToolResult(result);
      for (const term of parsed.terms) {
        expect(term.id).toBeDefined();
        expect(term.name).toBeDefined();
        expect(term.definition).toBeDefined();
        expect(Array.isArray(term.aliases)).toBe(true);
        expect(Array.isArray(term.codeLocations)).toBe(true);
        expect(term.source).toBeDefined();
        expect(term.confidence).toBeDefined();
      }
    });

    it("filters by category", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: "agile" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2); // Sprint Velocity + Sprint Retrospective
      for (const term of parsed.terms) {
        expect(term.category).toBe("agile");
      }
    });

    it("filters by tag", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { tag: "security" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Authentication Flow");
    });

    it("filters by confidence level", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { confidence: "manual" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      for (const term of parsed.terms) {
        expect(term.confidence).toBe("manual");
      }
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Authentication Flow");
      expect(names).toContain("Feature Flag System");
    });

    it("filters by adapter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { adapter: "notion" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      for (const term of parsed.terms) {
        expect(term.source.adapter).toBe("notion");
      }
      // Sprint Velocity + Auth Flow + Sprint Retrospective all have adapter: "notion"
      expect(parsed.count).toBe(3);
    });

    it("supports search via query parameter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { query: "sprint" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(2);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Sprint Velocity");
      expect(names).toContain("Sprint Retrospective");
    });

    it("combines search query with filters", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {
          query: "sprint",
          confidence: "ai-verified",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      // Only Sprint Velocity is "ai-verified" among sprint results
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("supports filePath lookup", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { filePath: "src/billing" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Billing Module");
    });

    it("returns empty results for non-matching filter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: "nonexistent-category" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("combines multiple filters", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {
          category: "agile",
          tag: "planning",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      // Both Sprint Velocity and Sprint Retrospective are "agile" and tagged "planning"
      expect(parsed.count).toBe(2);
    });
  });

  // ── find_by_file ────────────────────────────────────────────────────

  describe("find_by_file", () => {
    it("finds terms associated with a specific file", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/services/auth.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.filePath).toBe("src/services/auth.ts");
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Authentication Flow");
    });

    it("finds terms with partial file path match", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "auth" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThanOrEqual(1);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Authentication Flow");
    });

    it("finds terms for billing directory path", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/billing" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Billing Module");
    });

    it("returns empty results when no terms match the file", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/nonexistent/file.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("search is case-insensitive", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "SRC/METRICS/VELOCITY.TS" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("includes full term details in response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/metrics/velocity.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(1);
      const term = parsed.terms[0];
      expect(term.id).toBeDefined();
      expect(term.name).toBe("Sprint Velocity");
      expect(term.definition).toBeDefined();
      expect(term.aliases).toEqual(
        expect.arrayContaining(["velocity", "team speed", "SV"])
      );
      expect(term.codeLocations).toHaveLength(2);
      expect(term.category).toBe("agile");
    });

    it("returns a term even when only one code location matches", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "sprint-overview" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
      // Should still include ALL code locations, not just the matching one
      expect(parsed.terms[0].codeLocations.length).toBeGreaterThanOrEqual(2);
    });

    it("finds test file associations", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "tests/auth.test.ts" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Authentication Flow");
    });

    it("finds multiple terms when a file is shared", async () => {
      // Add a second term that references the same file
      await storage.addTerm({
        name: "Velocity Chart",
        definition: "Visual component for displaying sprint velocity trends",
        codeLocations: [
          {
            filePath: "src/dashboard/sprint-overview.tsx",
            symbol: "VelocityChart",
            relationship: "defines",
          },
        ],
      });

      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/dashboard/sprint-overview.tsx" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(2);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Sprint Velocity");
      expect(names).toContain("Velocity Chart");
    });
  });

  // ── Cross-tool integration ──────────────────────────────────────────

  describe("cross-tool integration", () => {
    it("add_term → query_context finds the new term", async () => {
      // Add a new term
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Code Review Checklist",
          definition: "Standard checklist for reviewing pull requests",
          category: "quality",
        },
      });

      // Search for it
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "code review" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Code Review Checklist");
    });

    it("add_term with codeLocations → find_by_file discovers it", async () => {
      // Add a term with code locations
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Error Boundary",
          definition: "React error boundary component",
          codeLocations: [
            {
              filePath: "src/components/ErrorBoundary.tsx",
              symbol: "ErrorBoundary",
              relationship: "defines",
            },
          ],
        },
      });

      // Find it by file
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "ErrorBoundary" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Error Boundary");
    });

    it("remove_term → query_context no longer finds it", async () => {
      // Verify term exists first
      const beforeResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Feature Flag" },
      });
      const beforeParsed = parseToolResult(beforeResult);
      expect(beforeParsed.count).toBeGreaterThanOrEqual(1);

      // Remove the term
      await client.callTool({
        name: TOOL_NAMES.REMOVE_TERM,
        arguments: { id: terms.featureFlag.id },
      });

      // Verify it's gone
      const afterResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Feature Flag System" },
      });
      const afterParsed = parseToolResult(afterResult);
      const names = afterParsed.terms.map((t: { name: string }) => t.name);
      expect(names).not.toContain("Feature Flag System");
    });

    it("update_term → query_context finds updated name", async () => {
      // Update the term name
      await client.callTool({
        name: TOOL_NAMES.UPDATE_TERM,
        arguments: {
          id: terms.featureFlag.id,
          name: "Release Flags",
        },
      });

      // Search for new name
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Release Flags" },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      const names = parsed.terms.map((t: { name: string }) => t.name);
      expect(names).toContain("Release Flags");
    });

    it("query_context result ID can be used with get_term", async () => {
      // Search to get a term
      const searchResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "billing" },
      });
      const searchParsed = parseToolResult(searchResult);
      const termId = searchParsed.terms[0].id;

      // Use that ID to get full details
      const getResult = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: termId },
      });
      const getParsed = parseToolResult(getResult);
      expect(getParsed.success).toBe(true);
      expect(getParsed.term.id).toBe(termId);
      expect(getParsed.term.name).toBe("Billing Module");
    });
  });
});
