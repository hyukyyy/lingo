/**
 * Tests for the suggest_code_changes MCP tool endpoint.
 *
 * Verifies that the tool:
 * 1. Accepts term change requests with various change types
 * 2. Orchestrates impact analysis + suggestion generation
 * 3. Returns properly formatted code change suggestions
 * 4. Handles edge cases (no matches, missing args, errors)
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

// ─── Test Helpers ──────────────────────────────────────────────────────

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
 * Creates a connected MCP server + client pair with pre-populated glossary data.
 */
async function createTestPair() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-suggest-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("test-org");

  const server = new McpServer(
    { name: "lingo-test", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  registerTools(server, storage);

  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

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

/**
 * Seeds a glossary with a term that has code locations for testing.
 */
async function seedTestTerm(
  storage: JsonGlossaryStorage,
  overrides?: {
    name?: string;
    definition?: string;
    confidence?: "manual" | "ai-suggested" | "ai-verified";
  }
) {
  return storage.addTerm({
    name: overrides?.name ?? "Sprint Velocity",
    definition:
      overrides?.definition ??
      "The rate of story points completed per sprint iteration",
    aliases: ["SV", "velocity"],
    category: "agile",
    tags: ["metrics", "sprint"],
    codeLocations: [
      {
        filePath: "src/services/velocity-calculator.ts",
        symbol: "SprintVelocity",
        relationship: "defines",
        lineRange: { start: 10, end: 50 },
        note: "Core velocity calculation class",
      },
      {
        filePath: "src/services/velocity-calculator.ts",
        symbol: "calculateVelocity",
        relationship: "implements",
        lineRange: { start: 20, end: 35 },
        note: "Main calculation method",
      },
      {
        filePath: "src/api/sprint-routes.ts",
        symbol: "getVelocity",
        relationship: "uses",
        lineRange: { start: 45, end: 60 },
      },
      {
        filePath: "tests/velocity.test.ts",
        symbol: "SprintVelocity",
        relationship: "tests",
        lineRange: { start: 5, end: 100 },
      },
      {
        filePath: "config/metrics.json",
        symbol: "sprint_velocity",
        relationship: "configures",
      },
    ],
    confidence: overrides?.confidence ?? "manual",
    source: { adapter: "manual" },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("suggest_code_changes MCP Tool", () => {
  let tempDir: string;
  let storage: JsonGlossaryStorage;
  let server: McpServer;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const pair = await createTestPair();
    tempDir = pair.tempDir;
    storage = pair.storage;
    server = pair.server;
    client = pair.client;
    cleanup = pair.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── Tool Registration ──────────────────────────────────────────────

  describe("tool registration", () => {
    it("is listed among available tools", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain(TOOL_NAMES.SUGGEST_CODE_CHANGES);
    });

    it("has a descriptive name and description", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === TOOL_NAMES.SUGGEST_CODE_CHANGES
      );
      expect(tool).toBeDefined();
      expect(tool!.description).toBeTruthy();
      expect(tool!.description!.length).toBeGreaterThan(20);
    });

    it("has expected input parameters", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === TOOL_NAMES.SUGGEST_CODE_CHANGES
      );
      expect(tool).toBeDefined();

      const props = tool!.inputSchema.properties as Record<string, unknown>;
      // Core change description params
      expect(props).toHaveProperty("changeType");
      expect(props).toHaveProperty("oldName");
      expect(props).toHaveProperty("newName");
      expect(props).toHaveProperty("description");
      // Impact analysis params
      expect(props).toHaveProperty("maxTerms");
      expect(props).toHaveProperty("minConfidence");
      expect(props).toHaveProperty("relationships");
      // Suggestion generation params
      expect(props).toHaveProperty("maxTotalSuggestions");
      expect(props).toHaveProperty("suggestionKinds");
      expect(props).toHaveProperty("minPriority");
    });

    it("requires changeType, oldName, and description", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === TOOL_NAMES.SUGGEST_CODE_CHANGES
      );
      expect(tool).toBeDefined();

      const required = tool!.inputSchema.required as string[];
      expect(required).toContain("changeType");
      expect(required).toContain("oldName");
      expect(required).toContain("description");
    });
  });

  // ── Rename Change Type ─────────────────────────────────────────────

  describe("rename changes", () => {
    it("returns suggestions when matching terms exist", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Aligning with SAFe terminology",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("rename");
      expect(parsed.change.oldName).toBe("Sprint Velocity");
      expect(parsed.change.newName).toBe("Iteration Throughput");

      // Should have found matching terms
      expect(parsed.impact.found).toBe(true);
      expect(parsed.impact.matchedTerms.length).toBeGreaterThan(0);

      // Should have generated suggestions
      expect(parsed.suggestions.length).toBeGreaterThan(0);
      expect(parsed.summary.totalSuggestions).toBeGreaterThan(0);
    });

    it("includes symbol-rename suggestions for defining symbols", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Aligning with SAFe terminology",
        },
      });

      const parsed = parseToolResult(result as any);
      const symbolRenames = parsed.suggestions.filter(
        (s: any) => s.kind === "symbol-rename"
      );
      expect(symbolRenames.length).toBeGreaterThan(0);

      // Should include critical renames for "defines" relationships
      const criticalRenames = symbolRenames.filter(
        (s: any) => s.priority === "critical"
      );
      expect(criticalRenames.length).toBeGreaterThan(0);
    });

    it("includes before/after snippets in each suggestion", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming concept",
        },
      });

      const parsed = parseToolResult(result as any);
      for (const suggestion of parsed.suggestions) {
        expect(suggestion).toHaveProperty("before");
        expect(suggestion).toHaveProperty("after");
        expect(typeof suggestion.before).toBe("string");
        expect(typeof suggestion.after).toBe("string");
        expect(suggestion.before.length).toBeGreaterThan(0);
        expect(suggestion.after.length).toBeGreaterThan(0);
      }
    });

    it("suggestion structure has all expected fields", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming concept",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.suggestions.length).toBeGreaterThan(0);

      const suggestion = parsed.suggestions[0];
      expect(suggestion).toHaveProperty("id");
      expect(suggestion).toHaveProperty("filePath");
      expect(suggestion).toHaveProperty("kind");
      expect(suggestion).toHaveProperty("priority");
      expect(suggestion).toHaveProperty("title");
      expect(suggestion).toHaveProperty("rationale");
      expect(suggestion).toHaveProperty("relationship");
      expect(suggestion).toHaveProperty("before");
      expect(suggestion).toHaveProperty("after");
      expect(suggestion).toHaveProperty("autoApplicable");
    });
  });

  // ── Deprecate Change Type ──────────────────────────────────────────

  describe("deprecate changes", () => {
    it("returns deprecation suggestions", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "deprecate",
          oldName: "Sprint Velocity",
          description: "Velocity metrics are being replaced by flow metrics",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("deprecate");
      expect(parsed.suggestions.length).toBeGreaterThan(0);

      // Should include deprecation markers
      const deprecationMarkers = parsed.suggestions.filter(
        (s: any) => s.kind === "deprecation-marker"
      );
      expect(deprecationMarkers.length).toBeGreaterThan(0);
    });
  });

  // ── Redefine Change Type ───────────────────────────────────────────

  describe("redefine changes", () => {
    it("returns documentation update suggestions", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "redefine",
          oldName: "Sprint Velocity",
          description: "Velocity now includes bug fixes, not just story points",
          newDefinition:
            "The rate of all work items completed per sprint, including stories and bugs",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("redefine");
      expect(parsed.suggestions.length).toBeGreaterThan(0);

      // Should include comment updates
      const commentUpdates = parsed.suggestions.filter(
        (s: any) => s.kind === "comment-update"
      );
      expect(commentUpdates.length).toBeGreaterThan(0);
    });
  });

  // ── Split Change Type ──────────────────────────────────────────────

  describe("split changes", () => {
    it("returns structural refactor suggestions", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "split",
          oldName: "Sprint Velocity",
          description: "Splitting velocity into separate delivery and quality metrics",
          splitInto: ["Delivery Velocity", "Quality Velocity"],
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("split");
      expect(parsed.suggestions.length).toBeGreaterThan(0);

      // Should include structural refactor suggestions
      const structuralRefactors = parsed.suggestions.filter(
        (s: any) => s.kind === "structural-refactor"
      );
      expect(structuralRefactors.length).toBeGreaterThan(0);
    });
  });

  // ── No Matches ─────────────────────────────────────────────────────

  describe("no matching terms", () => {
    it("returns empty suggestions when no terms match", async () => {
      // Don't seed any terms — glossary is empty

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Nonexistent Term",
          newName: "New Name",
          description: "This should find nothing",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.impact.found).toBe(false);
      expect(parsed.suggestions).toEqual([]);
      expect(parsed.summary.totalSuggestions).toBe(0);
      expect(parsed.warnings.length).toBeGreaterThan(0);
    });
  });

  // ── Filtering Options ──────────────────────────────────────────────

  describe("filtering options", () => {
    it("respects minPriority filter", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          minPriority: "critical",
        },
      });

      const parsed = parseToolResult(result as any);
      // All suggestions should be critical
      for (const s of parsed.suggestions) {
        expect(s.priority).toBe("critical");
      }
    });

    it("respects suggestionKinds filter", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          suggestionKinds: ["symbol-rename"],
        },
      });

      const parsed = parseToolResult(result as any);
      // All suggestions should be symbol-rename
      for (const s of parsed.suggestions) {
        expect(s.kind).toBe("symbol-rename");
      }
    });

    it("respects maxTotalSuggestions limit", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          maxTotalSuggestions: 2,
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.suggestions.length).toBeLessThanOrEqual(2);
    });

    it("respects includeTests filter", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          includeTests: false,
        },
      });

      const parsed = parseToolResult(result as any);
      // No test-update suggestions should appear
      const testSuggestions = parsed.suggestions.filter(
        (s: any) => s.kind === "test-update"
      );
      expect(testSuggestions).toHaveLength(0);
    });

    it("respects minConfidence impact analysis filter", async () => {
      // Add a term with low confidence
      await seedTestTerm(storage, { confidence: "ai-suggested" });

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          minConfidence: "manual",
        },
      });

      const parsed = parseToolResult(result as any);
      // Should not find ai-suggested terms when filtering for manual
      expect(parsed.impact.found).toBe(false);
      expect(parsed.suggestions).toHaveLength(0);
    });

    it("respects relationships filter", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          relationships: ["defines"],
        },
      });

      const parsed = parseToolResult(result as any);
      // All suggestions should only come from "defines" relationships
      for (const s of parsed.suggestions) {
        expect(s.relationship).toBe("defines");
      }
    });

    it("respects filePathFilter", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "Iteration Throughput",
          description: "Renaming",
          filePathFilter: "services",
        },
      });

      const parsed = parseToolResult(result as any);
      // All file paths should contain "services"
      for (const s of parsed.suggestions) {
        if (s.filePath !== "(dependent files)") {
          expect(s.filePath.toLowerCase()).toContain("services");
        }
      }
    });
  });

  // ── Response Structure ─────────────────────────────────────────────

  describe("response structure", () => {
    it("includes impact analysis summary", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "New Name",
          description: "Test",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.impact).toBeDefined();
      expect(parsed.impact.query).toBe("Sprint Velocity");
      expect(parsed.impact.summary).toBeDefined();
      expect(typeof parsed.impact.summary.totalMatchedTerms).toBe("number");
      expect(typeof parsed.impact.summary.totalAffectedFiles).toBe("number");
      expect(typeof parsed.impact.summary.totalSymbols).toBe("number");
    });

    it("includes suggestion summary statistics", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Sprint Velocity",
          newName: "New Name",
          description: "Test",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.summary).toBeDefined();
      expect(typeof parsed.summary.totalSuggestions).toBe("number");
      expect(typeof parsed.summary.filesAffected).toBe("number");
      expect(parsed.summary.byKind).toBeDefined();
      expect(parsed.summary.byPriority).toBeDefined();
      expect(typeof parsed.summary.autoApplicableCount).toBe("number");
    });

    it("includes change metadata in response", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "deprecate",
          oldName: "Some Term",
          description: "Being retired",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.change).toBeDefined();
      expect(parsed.change.type).toBe("deprecate");
      expect(parsed.change.oldName).toBe("Some Term");
      expect(parsed.change.description).toBe("Being retired");
    });

    it("returns warnings array", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "rename",
          oldName: "Nonexistent",
          newName: "New",
          description: "test",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(Array.isArray(parsed.warnings)).toBe(true);
    });
  });

  // ── Merge Change Type ──────────────────────────────────────────────

  describe("merge changes", () => {
    it("returns consolidation suggestions", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "merge",
          oldName: "Sprint Velocity",
          newName: "Team Throughput",
          description: "Merging velocity and capacity into a single metric",
          mergeFrom: ["Sprint Velocity", "Team Capacity"],
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("merge");
      expect(parsed.suggestions.length).toBeGreaterThan(0);
    });
  });

  // ── Relocate Change Type ───────────────────────────────────────────

  describe("relocate changes", () => {
    it("returns import and structural suggestions", async () => {
      await seedTestTerm(storage);

      const result = await client.callTool({
        name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
        arguments: {
          changeType: "relocate",
          oldName: "Sprint Velocity",
          description: "Moving velocity calculation to the metrics module",
          newLocation: "src/metrics/velocity.ts",
        },
      });

      const parsed = parseToolResult(result as any);
      expect(parsed.success).toBe(true);
      expect(parsed.change.type).toBe("relocate");
      expect(parsed.suggestions.length).toBeGreaterThan(0);

      // Should include structural refactor or import update suggestions
      const relocateSuggestions = parsed.suggestions.filter(
        (s: any) =>
          s.kind === "structural-refactor" || s.kind === "import-update"
      );
      expect(relocateSuggestions.length).toBeGreaterThan(0);
    });
  });
});
