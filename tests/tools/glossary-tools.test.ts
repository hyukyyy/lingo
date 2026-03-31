/**
 * Tests for the glossary MCP tools: add_term, get_term, update_term, remove_term, list_terms
 *
 * These tests verify the MCP tool implementations by exercising the tool
 * handlers through the McpServer's registered tool interface, using a
 * real JsonGlossaryStorage backend with temp-file persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { registerTools } from "../../src/tools/index.js";
import type { GlossaryTerm } from "../../src/models/glossary.js";

// ─── Test Helpers ───────────────────────────────────────────────────

/**
 * Parse the JSON text content from an MCP tool result.
 */
function parseToolResult(result: { content: Array<{ type: string; text?: string }> }) {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text as string);
}

/**
 * Create a test server with storage wired up, returning helpers.
 */
async function createTestHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-tools-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  const server = new McpServer(
    { name: "lingo-test", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  registerTools(server, storage);

  return { tempDir, storage, server };
}

/**
 * Invokes an MCP tool handler directly via the server's internal registry.
 *
 * The McpServer exposes tool handlers through a request handler for "tools/call".
 * We simulate this by directly calling the low-level server's requestHandler.
 */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  // Access the internal Server's request handler
  const internalServer = server.server;

  // Build a tools/call request
  const request = {
    method: "tools/call" as const,
    params: {
      name,
      arguments: args,
    },
  };

  // Use the internal server's request handler
  const result = await (internalServer as any)._requestHandlers.get("tools/call")?.(
    request,
    {} // extra context
  );

  return result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Glossary MCP Tools", () => {
  let tempDir: string;
  let storage: JsonGlossaryStorage;
  let server: McpServer;

  beforeEach(async () => {
    const harness = await createTestHarness();
    tempDir = harness.tempDir;
    storage = harness.storage;
    server = harness.server;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── add_term ─────────────────────────────────────────────────────

  describe("add_term", () => {
    it("creates a term with minimum required fields", async () => {
      const result = await callTool(server, "add_term", {
        name: "Sprint Velocity",
        definition: "The number of story points completed per sprint",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
      expect(parsed.term.definition).toBe("The number of story points completed per sprint");
      expect(parsed.term.id).toBeDefined();
      expect(parsed.term.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("creates a term with all optional fields", async () => {
      const result = await callTool(server, "add_term", {
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
            note: "Main auth service implementation",
          },
          {
            filePath: "src/middleware/auth-guard.ts",
            symbol: "AuthGuard",
            relationship: "implements",
            lineStart: 10,
            lineEnd: 50,
          },
        ],
        source: {
          adapter: "notion",
          externalId: "page-abc-123",
          url: "https://notion.so/auth-flow",
        },
        confidence: "ai-verified",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.aliases).toEqual(["auth flow", "login process", "sign-in"]);
      expect(parsed.term.category).toBe("authentication");
      expect(parsed.term.tags).toEqual(["security", "user-facing"]);
      expect(parsed.term.codeLocations).toHaveLength(2);
      expect(parsed.term.codeLocations[0].filePath).toBe("src/services/auth.ts");
      expect(parsed.term.codeLocations[0].symbol).toBe("AuthService");
      expect(parsed.term.codeLocations[0].relationship).toBe("defines");
      expect(parsed.term.codeLocations[0].note).toBe("Main auth service implementation");
      expect(parsed.term.codeLocations[1].lineRange).toEqual({ start: 10, end: 50 });
      expect(parsed.term.source.adapter).toBe("notion");
      expect(parsed.term.source.externalId).toBe("page-abc-123");
      expect(parsed.term.confidence).toBe("ai-verified");
    });

    it("persists the created term to storage", async () => {
      const result = await callTool(server, "add_term", {
        name: "Persisted Term",
        definition: "Should be saved to disk",
      });

      const parsed = parseToolResult(result);
      const termId = parsed.term.id;

      // Verify it's in storage
      const stored = storage.getTerm(termId);
      expect(stored).toBeDefined();
      expect(stored?.name).toBe("Persisted Term");
    });

    it("sets default confidence to manual", async () => {
      const result = await callTool(server, "add_term", {
        name: "Default Confidence",
        definition: "Should default to manual",
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.confidence).toBe("manual");
    });

    it("sets default source to manual adapter", async () => {
      const result = await callTool(server, "add_term", {
        name: "Default Source",
        definition: "Should default to manual adapter",
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.source.adapter).toBe("manual");
    });

    it("includes success message with term name and ID", async () => {
      const result = await callTool(server, "add_term", {
        name: "Named Term",
        definition: "Has a name",
      });

      const parsed = parseToolResult(result);
      expect(parsed.message).toContain("Named Term");
      expect(parsed.message).toContain(parsed.term.id);
    });

    it("sets createdAt and updatedAt timestamps", async () => {
      const before = new Date().toISOString();

      const result = await callTool(server, "add_term", {
        name: "Timestamped",
        definition: "Has timestamps",
      });

      const after = new Date().toISOString();
      const parsed = parseToolResult(result);

      expect(parsed.term.createdAt >= before).toBe(true);
      expect(parsed.term.createdAt <= after).toBe(true);
      expect(parsed.term.createdAt).toBe(parsed.term.updatedAt);
    });

    it("handles code locations without line ranges", async () => {
      const result = await callTool(server, "add_term", {
        name: "No Lines",
        definition: "Code location without lines",
        codeLocations: [
          {
            filePath: "src/app.ts",
            relationship: "defines",
          },
        ],
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.codeLocations[0].lineRange).toBeUndefined();
    });
  });

  // ── get_term ─────────────────────────────────────────────────────

  describe("get_term", () => {
    let addedTerm: GlossaryTerm;

    beforeEach(async () => {
      addedTerm = await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint",
        aliases: ["velocity", "team speed"],
        category: "agile",
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines",
          },
        ],
      });
    });

    it("retrieves a term by ID", async () => {
      const result = await callTool(server, "get_term", {
        id: addedTerm.id,
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.id).toBe(addedTerm.id);
      expect(parsed.term.name).toBe("Sprint Velocity");
      expect(parsed.term.definition).toBe("Story points completed per sprint");
    });

    it("retrieves a term by name search", async () => {
      const result = await callTool(server, "get_term", {
        name: "Sprint Velocity",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("retrieves a term by partial name search", async () => {
      const result = await callTool(server, "get_term", {
        name: "velocity",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("retrieves a term by alias search", async () => {
      const result = await callTool(server, "get_term", {
        name: "team speed",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("returns full term details including code locations", async () => {
      const result = await callTool(server, "get_term", {
        id: addedTerm.id,
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.codeLocations).toHaveLength(1);
      expect(parsed.term.codeLocations[0].filePath).toBe("src/metrics/velocity.ts");
      expect(parsed.term.codeLocations[0].symbol).toBe("calculateVelocity");
      expect(parsed.term.aliases).toEqual(["velocity", "team speed"]);
      expect(parsed.term.category).toBe("agile");
    });

    it("prefers ID lookup over name when both provided", async () => {
      // Add another term with a similar name
      await storage.addTerm({
        name: "Sprint Velocity Metric",
        definition: "A different term",
      });

      const result = await callTool(server, "get_term", {
        id: addedTerm.id,
        name: "Sprint Velocity Metric",
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.id).toBe(addedTerm.id);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("falls back to name search when ID not found", async () => {
      const result = await callTool(server, "get_term", {
        id: "00000000-0000-4000-8000-000000000000",
        name: "Sprint Velocity",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("returns error when neither id nor name provided", async () => {
      const result = await callTool(server, "get_term", {});

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Either 'id' or 'name' must be provided");
    });

    it("returns error when term not found by ID", async () => {
      const result = await callTool(server, "get_term", {
        id: "00000000-0000-4000-8000-000000000000",
      });

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("returns error when term not found by name", async () => {
      const result = await callTool(server, "get_term", {
        name: "xyznonexistent",
      });

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("name search is case-insensitive", async () => {
      const result = await callTool(server, "get_term", {
        name: "SPRINT VELOCITY",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Sprint Velocity");
    });
  });

  // ── update_term ──────────────────────────────────────────────────

  describe("update_term", () => {
    let existingTerm: GlossaryTerm;

    beforeEach(async () => {
      existingTerm = await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint",
        aliases: ["velocity", "team speed"],
        category: "agile",
        tags: ["metrics", "planning"],
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines",
          },
        ],
        source: { adapter: "manual" },
        confidence: "manual",
      });
    });

    it("updates the term name", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Team Velocity",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Team Velocity");
      // Other fields remain unchanged
      expect(parsed.term.definition).toBe("Story points completed per sprint");
      expect(parsed.term.aliases).toEqual(["velocity", "team speed"]);
    });

    it("updates the definition", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        definition: "Average story points delivered per sprint cycle",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.definition).toBe("Average story points delivered per sprint cycle");
      expect(parsed.term.name).toBe("Sprint Velocity");
    });

    it("updates aliases", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        aliases: ["SV", "sprint speed", "throughput"],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.aliases).toEqual(["SV", "sprint speed", "throughput"]);
    });

    it("updates category", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        category: "project-management",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.category).toBe("project-management");
    });

    it("updates tags", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        tags: ["analytics", "performance"],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.tags).toEqual(["analytics", "performance"]);
    });

    it("updates code locations", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines",
            note: "Main velocity calculator",
          },
          {
            filePath: "src/dashboard/velocity-chart.ts",
            symbol: "VelocityChart",
            relationship: "uses",
            lineStart: 15,
            lineEnd: 80,
          },
        ],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.codeLocations).toHaveLength(2);
      expect(parsed.term.codeLocations[0].filePath).toBe("src/metrics/velocity.ts");
      expect(parsed.term.codeLocations[0].note).toBe("Main velocity calculator");
      expect(parsed.term.codeLocations[1].filePath).toBe("src/dashboard/velocity-chart.ts");
      expect(parsed.term.codeLocations[1].symbol).toBe("VelocityChart");
      expect(parsed.term.codeLocations[1].relationship).toBe("uses");
      expect(parsed.term.codeLocations[1].lineRange).toEqual({ start: 15, end: 80 });
    });

    it("updates confidence level", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        confidence: "ai-verified",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.confidence).toBe("ai-verified");
    });

    it("updates source information", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        source: {
          adapter: "notion",
          externalId: "page-xyz-789",
          url: "https://notion.so/velocity",
        },
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.source.adapter).toBe("notion");
      expect(parsed.term.source.externalId).toBe("page-xyz-789");
      expect(parsed.term.source.url).toBe("https://notion.so/velocity");
    });

    it("updates multiple fields at once", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Team Velocity Metric",
        definition: "Aggregate velocity across the team",
        aliases: ["TVM"],
        category: "performance",
        tags: ["kpi"],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.name).toBe("Team Velocity Metric");
      expect(parsed.term.definition).toBe("Aggregate velocity across the team");
      expect(parsed.term.aliases).toEqual(["TVM"]);
      expect(parsed.term.category).toBe("performance");
      expect(parsed.term.tags).toEqual(["kpi"]);
    });

    it("preserves the term ID", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Renamed Term",
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.id).toBe(existingTerm.id);
    });

    it("preserves createdAt timestamp", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Renamed Term",
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.createdAt).toBe(existingTerm.createdAt);
    });

    it("updates the updatedAt timestamp", async () => {
      // Small delay to ensure updatedAt differs from createdAt
      await new Promise((resolve) => setTimeout(resolve, 10));

      const before = new Date().toISOString();

      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Renamed Term",
      });

      const after = new Date().toISOString();
      const parsed = parseToolResult(result);
      expect(parsed.term.updatedAt >= before).toBe(true);
      expect(parsed.term.updatedAt <= after).toBe(true);
      // updatedAt should be newer than the original createdAt
      expect(parsed.term.updatedAt >= existingTerm.createdAt).toBe(true);
    });

    it("persists updates to storage", async () => {
      await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Persisted Update",
        definition: "This should be on disk",
      });

      const stored = storage.getTerm(existingTerm.id);
      expect(stored).toBeDefined();
      expect(stored?.name).toBe("Persisted Update");
      expect(stored?.definition).toBe("This should be on disk");
    });

    it("includes success message with term name and ID", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        name: "Updated Name",
      });

      const parsed = parseToolResult(result);
      expect(parsed.message).toContain("Updated Name");
      expect(parsed.message).toContain(existingTerm.id);
      expect(parsed.message).toContain("updated successfully");
    });

    it("returns error for non-existent term ID", async () => {
      const result = await callTool(server, "update_term", {
        id: "00000000-0000-4000-8000-000000000000",
        name: "Should Fail",
      });

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("can clear aliases to empty array", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        aliases: [],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.aliases).toEqual([]);
    });

    it("can replace code locations entirely", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        codeLocations: [
          {
            filePath: "src/new-location.ts",
            symbol: "newFunction",
            relationship: "implements",
          },
        ],
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.term.codeLocations).toHaveLength(1);
      expect(parsed.term.codeLocations[0].filePath).toBe("src/new-location.ts");
    });

    it("handles code locations without line ranges", async () => {
      const result = await callTool(server, "update_term", {
        id: existingTerm.id,
        codeLocations: [
          {
            filePath: "src/app.ts",
            relationship: "uses",
          },
        ],
      });

      const parsed = parseToolResult(result);
      expect(parsed.term.codeLocations[0].lineRange).toBeUndefined();
    });
  });

  // ── list_terms ───────────────────────────────────────────────────

  describe("list_terms", () => {
    beforeEach(async () => {
      await storage.addTerm({
        name: "Auth Token",
        definition: "JWT token for authentication",
        aliases: ["JWT", "bearer token"],
        category: "authentication",
        tags: ["security"],
        confidence: "manual",
        source: { adapter: "manual" },
        codeLocations: [
          {
            filePath: "src/auth/token.ts",
            symbol: "AuthToken",
            relationship: "defines",
          },
        ],
      });
      await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint cycle",
        aliases: ["velocity", "team speed"],
        category: "agile",
        tags: ["metrics", "planning"],
        confidence: "ai-suggested",
        source: { adapter: "notion" },
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "SprintVelocity",
            relationship: "defines",
          },
        ],
      });
      await storage.addTerm({
        name: "SSO Provider",
        definition: "Single sign-on provider configuration and integration",
        aliases: ["SSO", "SAML provider"],
        category: "authentication",
        tags: ["security", "infrastructure"],
        confidence: "ai-verified",
        source: { adapter: "notion" },
        codeLocations: [
          {
            filePath: "src/auth/sso.ts",
            symbol: "SSOProvider",
            relationship: "defines",
          },
          {
            filePath: "src/config/sso-config.ts",
            relationship: "configures",
          },
        ],
      });
    });

    it("returns all terms when no filters provided", async () => {
      const result = await callTool(server, "list_terms", {});

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(3);
      expect(parsed.terms).toHaveLength(3);
    });

    it("returns all terms with full details", async () => {
      const result = await callTool(server, "list_terms", {});

      const parsed = parseToolResult(result);
      const names = parsed.terms.map((t: any) => t.name);
      expect(names).toContain("Auth Token");
      expect(names).toContain("Sprint Velocity");
      expect(names).toContain("SSO Provider");

      // Verify a term has full details
      const authToken = parsed.terms.find((t: any) => t.name === "Auth Token");
      expect(authToken.definition).toBe("JWT token for authentication");
      expect(authToken.codeLocations).toHaveLength(1);
      expect(authToken.codeLocations[0].filePath).toBe("src/auth/token.ts");
    });

    it("searches by query string", async () => {
      const result = await callTool(server, "list_terms", {
        query: "velocity",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("search matches aliases", async () => {
      const result = await callTool(server, "list_terms", {
        query: "JWT",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.terms[0].name).toBe("Auth Token");
    });

    it("search matches definition content", async () => {
      const result = await callTool(server, "list_terms", {
        query: "single sign-on",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.terms[0].name).toBe("SSO Provider");
    });

    it("search is case-insensitive", async () => {
      const result = await callTool(server, "list_terms", {
        query: "SPRINT VELOCITY",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("filters by category", async () => {
      const result = await callTool(server, "list_terms", {
        category: "authentication",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(2);
      expect(
        parsed.terms.every((t: any) => t.category === "authentication")
      ).toBe(true);
    });

    it("filters by tag", async () => {
      const result = await callTool(server, "list_terms", {
        tag: "security",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(2);
      const names = parsed.terms.map((t: any) => t.name);
      expect(names).toContain("Auth Token");
      expect(names).toContain("SSO Provider");
    });

    it("filters by confidence level", async () => {
      const result = await callTool(server, "list_terms", {
        confidence: "ai-suggested",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Sprint Velocity");
    });

    it("filters by source adapter", async () => {
      const result = await callTool(server, "list_terms", {
        adapter: "notion",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(2);
      const names = parsed.terms.map((t: any) => t.name);
      expect(names).toContain("Sprint Velocity");
      expect(names).toContain("SSO Provider");
    });

    it("finds terms by file path", async () => {
      const result = await callTool(server, "list_terms", {
        filePath: "src/auth/token.ts",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Auth Token");
    });

    it("finds terms by partial file path", async () => {
      const result = await callTool(server, "list_terms", {
        filePath: "auth",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(2);
      const names = parsed.terms.map((t: any) => t.name);
      expect(names).toContain("Auth Token");
      expect(names).toContain("SSO Provider");
    });

    it("combines search query with category filter", async () => {
      const result = await callTool(server, "list_terms", {
        query: "token",
        category: "authentication",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(1);
      expect(parsed.terms[0].name).toBe("Auth Token");
    });

    it("combines file path with category filter", async () => {
      const result = await callTool(server, "list_terms", {
        filePath: "auth",
        category: "authentication",
      });

      const parsed = parseToolResult(result);
      // Both Auth Token and SSO Provider are in auth/ AND authentication category
      expect(parsed.count).toBe(2);
    });

    it("returns empty results for non-matching query", async () => {
      const result = await callTool(server, "list_terms", {
        query: "xyznonexistent",
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.terms).toEqual([]);
    });

    it("returns empty results for non-matching category", async () => {
      const result = await callTool(server, "list_terms", {
        category: "nonexistent",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(0);
    });

    it("returns empty results for non-matching file path", async () => {
      const result = await callTool(server, "list_terms", {
        filePath: "nonexistent.ts",
      });

      const parsed = parseToolResult(result);
      expect(parsed.count).toBe(0);
    });

    it("includes count in response", async () => {
      const result = await callTool(server, "list_terms", {});

      const parsed = parseToolResult(result);
      expect(typeof parsed.count).toBe("number");
      expect(parsed.count).toBe(parsed.terms.length);
    });
  });

  // ── remove_term ──────────────────────────────────────────────────

  describe("remove_term", () => {
    let existingTerm: GlossaryTerm;

    beforeEach(async () => {
      existingTerm = await storage.addTerm({
        name: "Sprint Velocity",
        definition: "Story points completed per sprint",
        aliases: ["velocity", "team speed"],
        category: "agile",
        tags: ["metrics", "planning"],
        codeLocations: [
          {
            filePath: "src/metrics/velocity.ts",
            symbol: "calculateVelocity",
            relationship: "defines",
          },
        ],
        source: { adapter: "manual" },
        confidence: "manual",
      });
    });

    it("removes an existing term by ID", async () => {
      const result = await callTool(server, "remove_term", {
        id: existingTerm.id,
      });

      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("removed successfully");
      expect(parsed.message).toContain("Sprint Velocity");
      expect(parsed.message).toContain(existingTerm.id);
    });

    it("returns the removed term details for confirmation", async () => {
      const result = await callTool(server, "remove_term", {
        id: existingTerm.id,
      });

      const parsed = parseToolResult(result);
      expect(parsed.removedTerm).toBeDefined();
      expect(parsed.removedTerm.id).toBe(existingTerm.id);
      expect(parsed.removedTerm.name).toBe("Sprint Velocity");
      expect(parsed.removedTerm.definition).toBe("Story points completed per sprint");
      expect(parsed.removedTerm.aliases).toEqual(["velocity", "team speed"]);
      expect(parsed.removedTerm.category).toBe("agile");
      expect(parsed.removedTerm.tags).toEqual(["metrics", "planning"]);
      expect(parsed.removedTerm.codeLocations).toHaveLength(1);
      expect(parsed.removedTerm.codeLocations[0].filePath).toBe("src/metrics/velocity.ts");
    });

    it("actually removes the term from storage", async () => {
      // Confirm term exists before removal
      expect(storage.getTerm(existingTerm.id)).toBeDefined();

      await callTool(server, "remove_term", {
        id: existingTerm.id,
      });

      // Term should no longer exist in storage
      expect(storage.getTerm(existingTerm.id)).toBeUndefined();
    });

    it("term no longer appears in list_terms after removal", async () => {
      // Verify term shows up in list_terms before removal
      const beforeResult = await callTool(server, "list_terms", {});
      const beforeParsed = parseToolResult(beforeResult);
      expect(beforeParsed.count).toBe(1);

      // Remove it
      await callTool(server, "remove_term", { id: existingTerm.id });

      // Verify it's gone from list_terms
      const afterResult = await callTool(server, "list_terms", {});
      const afterParsed = parseToolResult(afterResult);
      expect(afterParsed.count).toBe(0);
    });

    it("term no longer appears in search after removal", async () => {
      // Remove it
      await callTool(server, "remove_term", { id: existingTerm.id });

      // Search should return empty results
      const searchResult = await callTool(server, "list_terms", {
        query: "Sprint Velocity",
      });
      const searchParsed = parseToolResult(searchResult);
      expect(searchParsed.count).toBe(0);
    });

    it("term no longer found by get_term after removal", async () => {
      await callTool(server, "remove_term", { id: existingTerm.id });

      const getResult = await callTool(server, "get_term", {
        id: existingTerm.id,
      });

      // After removing the only term, the store is empty (cold start),
      // so get_term returns a non-error response with guidance
      expect(getResult.isError).toBeFalsy();
      const parsed = parseToolResult(getResult);
      expect(parsed.success).toBe(true);
      expect(parsed.term).toBeNull();
      expect(parsed._coldStart).toBe(true);
      expect(parsed.guidance).toBeDefined();
    });

    it("returns error for non-existent term ID", async () => {
      const result = await callTool(server, "remove_term", {
        id: "00000000-0000-4000-8000-000000000000",
      });

      expect(result.isError).toBe(true);
      const parsed = parseToolResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });

    it("returns error with the non-existent ID in the message", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000000";
      const result = await callTool(server, "remove_term", {
        id: fakeId,
      });

      const parsed = parseToolResult(result);
      expect(parsed.error).toContain(fakeId);
    });

    it("cannot remove the same term twice", async () => {
      // First removal succeeds
      const firstResult = await callTool(server, "remove_term", {
        id: existingTerm.id,
      });
      const firstParsed = parseToolResult(firstResult);
      expect(firstParsed.success).toBe(true);

      // Second removal fails — term no longer exists
      const secondResult = await callTool(server, "remove_term", {
        id: existingTerm.id,
      });
      expect(secondResult.isError).toBe(true);
      const secondParsed = parseToolResult(secondResult);
      expect(secondParsed.success).toBe(false);
      expect(secondParsed.error).toContain("Term not found");
    });

    it("removing one term does not affect others", async () => {
      // Add a second term
      const secondTerm = await storage.addTerm({
        name: "Auth Token",
        definition: "JWT token for authentication",
      });

      // Remove the first term
      await callTool(server, "remove_term", { id: existingTerm.id });

      // Second term should still exist
      const remainingTerm = storage.getTerm(secondTerm.id);
      expect(remainingTerm).toBeDefined();
      expect(remainingTerm?.name).toBe("Auth Token");

      // List should show only one term
      const listResult = await callTool(server, "list_terms", {});
      const listParsed = parseToolResult(listResult);
      expect(listParsed.count).toBe(1);
      expect(listParsed.terms[0].name).toBe("Auth Token");
    });

    it("persists removal to disk", async () => {
      await callTool(server, "remove_term", { id: existingTerm.id });

      // Reload storage from disk to verify persistence
      const freshStorage = new JsonGlossaryStorage(
        join(tempDir, "glossary.json")
      );
      await freshStorage.load("test-org");
      expect(freshStorage.getTerm(existingTerm.id)).toBeUndefined();
    });
  });

  // ── Integration: add_term -> get_term -> list_terms ──────────────

  describe("Integration: full workflow", () => {
    it("creates a term and retrieves it by ID", async () => {
      // Add
      const addResult = await callTool(server, "add_term", {
        name: "Feature Flag",
        definition: "A toggle that controls feature availability",
        category: "infrastructure",
        codeLocations: [
          {
            filePath: "src/flags/feature-flags.ts",
            symbol: "FeatureFlag",
            relationship: "defines",
          },
        ],
      });

      const addParsed = parseToolResult(addResult);
      expect(addParsed.success).toBe(true);
      const termId = addParsed.term.id;

      // Get by ID
      const getResult = await callTool(server, "get_term", { id: termId });
      const getParsed = parseToolResult(getResult);
      expect(getParsed.success).toBe(true);
      expect(getParsed.term.name).toBe("Feature Flag");
      expect(getParsed.term.codeLocations[0].filePath).toBe("src/flags/feature-flags.ts");
    });

    it("creates a term and finds it via list_terms search", async () => {
      await callTool(server, "add_term", {
        name: "Deployment Pipeline",
        definition: "The CI/CD pipeline for deploying code to production",
        category: "devops",
      });

      const listResult = await callTool(server, "list_terms", {
        query: "pipeline",
      });

      const listParsed = parseToolResult(listResult);
      expect(listParsed.count).toBe(1);
      expect(listParsed.terms[0].name).toBe("Deployment Pipeline");
    });

    it("creates multiple terms and lists them all", async () => {
      await callTool(server, "add_term", {
        name: "Term A",
        definition: "First term",
      });
      await callTool(server, "add_term", {
        name: "Term B",
        definition: "Second term",
      });
      await callTool(server, "add_term", {
        name: "Term C",
        definition: "Third term",
      });

      const listResult = await callTool(server, "list_terms", {});
      const listParsed = parseToolResult(listResult);
      expect(listParsed.count).toBe(3);
    });

    it("creates a term and finds it by name via get_term", async () => {
      await callTool(server, "add_term", {
        name: "Unique Searchable Term",
        definition: "A term with a unique name",
        aliases: ["UST"],
      });

      const getResult = await callTool(server, "get_term", {
        name: "Unique Searchable",
      });

      const getParsed = parseToolResult(getResult);
      expect(getParsed.success).toBe(true);
      expect(getParsed.term.name).toBe("Unique Searchable Term");
    });

    it("creates a term with code locations and finds it by file path", async () => {
      await callTool(server, "add_term", {
        name: "Billing Engine",
        definition: "Core billing calculation engine",
        codeLocations: [
          {
            filePath: "src/billing/engine.ts",
            symbol: "BillingEngine",
            relationship: "defines",
          },
          {
            filePath: "src/billing/calculator.ts",
            symbol: "calculateInvoice",
            relationship: "implements",
          },
        ],
      });

      const listResult = await callTool(server, "list_terms", {
        filePath: "billing/engine",
      });

      const listParsed = parseToolResult(listResult);
      expect(listParsed.count).toBe(1);
      expect(listParsed.terms[0].name).toBe("Billing Engine");
    });
  });
});
