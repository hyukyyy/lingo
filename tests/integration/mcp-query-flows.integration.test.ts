/**
 * End-to-End MCP Protocol Integration Tests — Query Flows
 *
 * These tests verify the complete MCP protocol query lifecycle as experienced
 * by registered AI tool clients (Claude Code, Cursor, etc.). Each test
 * simulates what a real AI tool does when it connects to the Lingo MCP server
 * and queries organizational context:
 *
 *   1. Client connects to server via MCP protocol
 *   2. Client discovers available tools (tools/list)
 *   3. Client calls tools to query/manage organizational context
 *   4. Server returns correctly structured responses with org context
 *
 * Unlike unit tests, these tests exercise the full stack:
 *   Server creation → Storage initialization → Tool registration →
 *   Transport connection → Protocol messaging → Response parsing
 *
 * The InMemoryTransport simulates the stdio/SSE transport without network I/O,
 * giving us genuine protocol-level testing with deterministic behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type LingoServerConfig } from "../../src/server.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { TOOL_NAMES, ALL_TOOL_NAMES } from "../../src/tools/index.js";
import type { GlossaryTerm } from "../../src/models/glossary.js";

// ─── Types ─────────────────────────────────────────────────────────────

interface ToolResponse {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface TermResponse {
  id: string;
  name: string;
  definition: string;
  aliases: string[];
  codeLocations: Array<{
    filePath: string;
    symbol?: string;
    lineRange?: { start: number; end: number };
    relationship: string;
    note?: string;
  }>;
  category?: string;
  tags: string[];
  source: { adapter: string; externalId?: string; url?: string };
  confidence: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Test Helpers ──────────────────────────────────────────────────────

/**
 * Parse JSON text content from an MCP tool call result.
 */
function parseResult(result: {
  content: Array<{ type: string; text?: string }>;
}): ToolResponse {
  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || !("text" in textContent)) {
    throw new Error("No text content in tool result");
  }
  return JSON.parse(textContent.text as string);
}

/**
 * Seed data representing a realistic organization's terminology.
 * Covers multiple domains, adapter sources, confidence levels, and
 * code location relationships.
 */
async function seedOrganizationalContext(storage: JsonGlossaryStorage): Promise<{
  sprintVelocity: GlossaryTerm;
  authGuard: GlossaryTerm;
  billingEngine: GlossaryTerm;
  featureFlags: GlossaryTerm;
  dataIngestion: GlossaryTerm;
  deployPipeline: GlossaryTerm;
}> {
  const sprintVelocity = await storage.addTerm({
    name: "Sprint Velocity",
    definition:
      "The measure of story points completed per sprint iteration, used for capacity planning.",
    aliases: ["velocity", "team speed", "SV", "sprint throughput"],
    category: "agile-metrics",
    tags: ["metrics", "planning", "capacity"],
    codeLocations: [
      {
        filePath: "src/metrics/velocity-calculator.ts",
        symbol: "VelocityCalculator",
        relationship: "defines",
        note: "Core velocity calculation engine",
      },
      {
        filePath: "src/dashboard/sprint-overview.tsx",
        symbol: "VelocityChart",
        relationship: "uses",
        lineRange: { start: 42, end: 87 },
      },
      {
        filePath: "src/api/metrics-endpoints.ts",
        symbol: "getVelocity",
        relationship: "implements",
      },
      {
        filePath: "tests/metrics/velocity.test.ts",
        symbol: "velocityTests",
        relationship: "tests",
      },
    ],
    source: { adapter: "notion", externalId: "page-sprint-001" },
    confidence: "ai-verified",
  });

  const authGuard = await storage.addTerm({
    name: "Authentication Guard",
    definition:
      "Middleware component that validates JWT tokens and enforces route-level access control.",
    aliases: ["auth guard", "route guard", "JWT validator", "auth middleware"],
    category: "security",
    tags: ["authentication", "middleware", "security"],
    codeLocations: [
      {
        filePath: "src/middleware/auth-guard.ts",
        symbol: "AuthGuard",
        relationship: "defines",
        note: "Primary auth middleware for Express routes",
      },
      {
        filePath: "src/services/token-service.ts",
        symbol: "TokenService",
        relationship: "implements",
        lineRange: { start: 15, end: 120 },
      },
      {
        filePath: "src/config/auth-config.ts",
        symbol: "AUTH_CONFIG",
        relationship: "configures",
      },
      {
        filePath: "tests/middleware/auth-guard.test.ts",
        symbol: "authGuardSuite",
        relationship: "tests",
      },
    ],
    source: { adapter: "linear", externalId: "LIN-1234" },
    confidence: "manual",
  });

  const billingEngine = await storage.addTerm({
    name: "Billing Engine",
    definition:
      "Subscription lifecycle manager handling plan selection, payment processing, " +
      "invoice generation, and usage-based billing.",
    aliases: ["billing", "subscription manager", "payment system", "invoicing"],
    category: "billing",
    tags: ["payments", "subscriptions", "revenue"],
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
      {
        filePath: "src/billing/invoice-generator.ts",
        symbol: "InvoiceGenerator",
        relationship: "implements",
      },
      {
        filePath: "src/config/stripe-config.ts",
        symbol: "STRIPE_CONFIG",
        relationship: "configures",
      },
    ],
    source: { adapter: "notion", externalId: "page-billing-002", url: "https://notion.so/billing" },
    confidence: "ai-verified",
  });

  const featureFlags = await storage.addTerm({
    name: "Feature Flag System",
    definition:
      "Infrastructure for toggling features on/off per user segment, " +
      "supporting percentage rollouts and A/B testing.",
    aliases: ["feature toggles", "flags", "FF", "rollout system"],
    category: "infrastructure",
    tags: ["devops", "release-management", "testing"],
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
      {
        filePath: "src/features/rollout-engine.ts",
        symbol: "RolloutEngine",
        relationship: "implements",
      },
    ],
    source: { adapter: "manual" },
    confidence: "manual",
  });

  const dataIngestion = await storage.addTerm({
    name: "Data Ingestion Pipeline",
    definition:
      "ETL system that collects data from external sources, " +
      "transforms it into the internal schema, and loads it into the data warehouse.",
    aliases: ["ETL pipeline", "data pipeline", "ingestion", "data loader"],
    category: "data-engineering",
    tags: ["data", "etl", "infrastructure"],
    codeLocations: [
      {
        filePath: "src/data/ingestion/pipeline-orchestrator.ts",
        symbol: "PipelineOrchestrator",
        relationship: "defines",
      },
      {
        filePath: "src/data/ingestion/transformers/index.ts",
        symbol: "transformerRegistry",
        relationship: "implements",
      },
      {
        filePath: "src/data/ingestion/loaders/warehouse-loader.ts",
        symbol: "WarehouseLoader",
        relationship: "implements",
      },
    ],
    source: { adapter: "notion", externalId: "page-data-003" },
    confidence: "ai-suggested",
  });

  const deployPipeline = await storage.addTerm({
    name: "Deployment Pipeline",
    definition:
      "CI/CD pipeline that builds, tests, and deploys the application " +
      "through staging → canary → production environments.",
    aliases: ["CI/CD", "deploy pipeline", "release pipeline"],
    category: "infrastructure",
    tags: ["devops", "ci-cd", "deployment"],
    codeLocations: [
      {
        filePath: ".github/workflows/deploy.yml",
        relationship: "defines",
        note: "GitHub Actions workflow definition",
      },
      {
        filePath: "src/deploy/canary-checker.ts",
        symbol: "CanaryChecker",
        relationship: "implements",
      },
    ],
    source: { adapter: "manual" },
    confidence: "manual",
  });

  return {
    sprintVelocity,
    authGuard,
    billingEngine,
    featureFlags,
    dataIngestion,
    deployPipeline,
  };
}

/**
 * Creates a fully connected MCP server + client pair with seeded org data.
 * This is the test harness that simulates a real AI tool connecting to Lingo.
 */
async function createE2EHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-e2e-test-"));
  const glossaryPath = join(tempDir, "glossary.json");

  // Initialize storage with org context
  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("acme-corp");

  // Seed realistic org terminology
  const seededTerms = await seedOrganizationalContext(storage);

  // Create the full Lingo MCP server
  const config: LingoServerConfig = {
    glossaryPath,
    organization: "acme-corp",
    logLevel: "error", // suppress logs during tests
  };
  const server = createServer(config, storage);

  // Create a client simulating an AI tool (e.g., Claude Code)
  const client = new Client({
    name: "claude-code-test",
    version: "1.0.0",
  });

  // Connect via in-memory transport (simulates stdio)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    storage,
    tempDir,
    terms: seededTerms,
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Integration Tests ──────────────────────────────────────────────────

describe("End-to-End MCP Protocol Query Flows", () => {
  let client: Client;
  let storage: JsonGlossaryStorage;
  let terms: Awaited<ReturnType<typeof seedOrganizationalContext>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createE2EHarness();
    client = harness.client;
    storage = harness.storage;
    terms = harness.terms;
    cleanup = harness.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── 1. Tool Discovery ───────────────────────────────────────────────

  describe("AI client tool discovery", () => {
    it("client discovers all available Lingo tools on connection", async () => {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);

      for (const expected of ALL_TOOL_NAMES) {
        expect(toolNames).toContain(expected);
      }
    });

    it("each tool provides a natural-language description for AI comprehension", async () => {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        // AI tools need substantial descriptions to choose the right tool
        expect(tool.description!.length).toBeGreaterThan(30);
      }
    });

    it("query_context tool has the schema an AI client needs", async () => {
      const { tools } = await client.listTools();
      const queryTool = tools.find((t) => t.name === TOOL_NAMES.QUERY_CONTEXT);

      expect(queryTool).toBeDefined();
      const props = queryTool!.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("query");
      expect(props).toHaveProperty("category");
      expect(props).toHaveProperty("limit");

      // 'query' should be required
      const required = queryTool!.inputSchema.required as string[];
      expect(required).toContain("query");
    });
  });

  // ── 2. Natural Language Context Queries ─────────────────────────────

  describe("natural language context queries (query_context)", () => {
    it("resolves org-specific jargon to code locations", async () => {
      // Scenario: AI encounters "sprint velocity" in a conversation
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "sprint velocity" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);

      const topTerm = (parsed as any).terms[0] as TermResponse;
      expect(topTerm.name).toBe("Sprint Velocity");
      expect(topTerm.definition).toContain("story points");

      // Critical: AI needs code locations to navigate the codebase
      expect(topTerm.codeLocations.length).toBeGreaterThanOrEqual(2);
      expect(topTerm.codeLocations[0].filePath).toBe(
        "src/metrics/velocity-calculator.ts"
      );
      expect(topTerm.codeLocations[0].symbol).toBe("VelocityCalculator");
      expect(topTerm.codeLocations[0].relationship).toBe("defines");
    });

    it("resolves abbreviations to full org terms", async () => {
      // Scenario: AI encounters "SV" abbreviation in a ticket
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "SV" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      expect((parsed as any).terms[0].name).toBe("Sprint Velocity");
    });

    it("resolves colloquial aliases to formal terms", async () => {
      // Scenario: Developer says "auth guard" but the term is "Authentication Guard"
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "auth guard" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Authentication Guard");
    });

    it("searches across definitions for conceptual queries", async () => {
      // Scenario: AI asks about "payment processing" — not an exact term name
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "payment processing" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Billing Engine");
    });

    it("scopes results by domain category", async () => {
      // Scenario: AI needs only infrastructure-related context
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "pipeline", category: "infrastructure" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      // Only infrastructure terms should appear (not data-engineering pipeline)
      for (const term of (parsed as any).terms as TermResponse[]) {
        expect(term.category).toBe("infrastructure");
      }
    });

    it("limits result count for token-constrained AI clients", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "a", limit: 2 },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).terms.length).toBeLessThanOrEqual(2);
    });

    it("returns empty results gracefully for unknown terms", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "quantum flux capacitor" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(0);
      expect((parsed as any).terms).toEqual([]);
    });
  });

  // ── 3. Direct Term Resolution ───────────────────────────────────────

  describe("direct term resolution (get_term)", () => {
    it("resolves term by ID — the primary lookup for AI tools", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.authGuard.id },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);

      const term = (parsed as any).term as TermResponse;
      expect(term.id).toBe(terms.authGuard.id);
      expect(term.name).toBe("Authentication Guard");
      expect(term.definition).toContain("JWT tokens");
      expect(term.aliases).toEqual(
        expect.arrayContaining(["auth guard", "JWT validator"])
      );
      expect(term.codeLocations).toHaveLength(4);
      expect(term.source.adapter).toBe("linear");
      expect(term.confidence).toBe("manual");
    });

    it("resolves term by name — fuzzy lookup for natural language", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "billing engine" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).term.name).toBe("Billing Engine");
      expect((parsed as any).term.codeLocations).toHaveLength(4);
    });

    it("returns rich code location metadata including line ranges", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.authGuard.id },
      });

      const parsed = parseResult(result);
      const term = (parsed as any).term as TermResponse;

      // Find the code location with a line range
      const tokenService = term.codeLocations.find(
        (loc) => loc.symbol === "TokenService"
      );
      expect(tokenService).toBeDefined();
      expect(tokenService!.lineRange).toEqual({ start: 15, end: 120 });
      expect(tokenService!.relationship).toBe("implements");
    });

    it("returns source traceability back to PM tool", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.billingEngine.id },
      });

      const parsed = parseResult(result);
      const term = (parsed as any).term as TermResponse;
      expect(term.source.adapter).toBe("notion");
      expect(term.source.externalId).toBe("page-billing-002");
      expect(term.source.url).toBe("https://notion.so/billing");
    });

    it("handles missing term with clear error for AI consumption", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: "00000000-0000-4000-8000-000000000000" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Term not found");
    });
  });

  // ── 4. File-Based Context Discovery ─────────────────────────────────

  describe("file-based context discovery (find_by_file)", () => {
    it("finds terms when AI opens a specific file", async () => {
      // Scenario: AI is editing auth-guard.ts and needs context
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/middleware/auth-guard.ts" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Authentication Guard");
    });

    it("finds terms from partial directory path", async () => {
      // Scenario: AI wants to know what "src/billing" is about
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/billing" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Billing Engine");
    });

    it("finds multiple terms when a file is referenced by several terms", async () => {
      // Feature gate middleware is used by Feature Flags
      // Let's also associate it with Auth Guard's middleware directory
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/middleware" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      // Both "Authentication Guard" (auth-guard.ts) and
      // "Feature Flag System" (feature-gate.ts) have files in src/middleware
      expect((parsed as any).count).toBeGreaterThanOrEqual(2);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Authentication Guard");
      expect(names).toContain("Feature Flag System");
    });

    it("finds terms associated with test files", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "tests/metrics/velocity.test.ts" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Sprint Velocity");
    });

    it("finds terms associated with config files", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/config/auth-config.ts" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Authentication Guard");
    });

    it("finds terms associated with non-code files (YAML)", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: ".github/workflows/deploy.yml" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Deployment Pipeline");
    });

    it("returns empty results for files with no term associations", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/utils/string-helpers.ts" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(0);
      expect((parsed as any).terms).toEqual([]);
    });
  });

  // ── 5. Filtered Term Listing ────────────────────────────────────────

  describe("filtered term listing (list_terms)", () => {
    it("lists all terms when no filters applied", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(6); // 6 seeded terms
    });

    it("filters by domain category", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: "security" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Authentication Guard");
    });

    it("filters by tag across all domains", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { tag: "devops" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(2);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Feature Flag System");
      expect(names).toContain("Deployment Pipeline");
    });

    it("filters by confidence level", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { confidence: "ai-suggested" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Data Ingestion Pipeline");
    });

    it("filters by adapter source", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { adapter: "notion" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      // Sprint Velocity, Billing Engine, Data Ingestion Pipeline
      expect((parsed as any).count).toBe(3);
      for (const term of (parsed as any).terms as TermResponse[]) {
        expect(term.source.adapter).toBe("notion");
      }
    });

    it("combines search query with category filter", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { query: "pipeline", category: "data-engineering" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Data Ingestion Pipeline");
    });

    it("combines multiple filters simultaneously", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {
          category: "infrastructure",
          tag: "devops",
          confidence: "manual",
        },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      // Both Feature Flag System and Deployment Pipeline match all three
      expect((parsed as any).count).toBe(2);
    });

    it("returns empty when filters exclude all terms", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {
          category: "security",
          adapter: "notion", // Auth Guard is from "linear", not "notion"
        },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(0);
    });

    it("supports file-path lookup through list_terms", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { filePath: "src/data/ingestion" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Data Ingestion Pipeline");
    });
  });

  // ── 6. Multi-Step Query Workflows ───────────────────────────────────

  describe("multi-step query workflows (simulating AI tool behavior)", () => {
    it("workflow: discover → search → resolve → navigate", async () => {
      // Step 1: AI discovers available tools
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // Step 2: AI searches for a concept mentioned in conversation
      const searchResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "billing" },
      });
      const searchParsed = parseResult(searchResult);
      expect(searchParsed.success).toBe(true);
      const termId = ((searchParsed as any).terms[0] as TermResponse).id;

      // Step 3: AI resolves the full term details
      const resolveResult = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: termId },
      });
      const resolveParsed = parseResult(resolveResult);
      expect(resolveParsed.success).toBe(true);
      expect(((resolveParsed as any).term as TermResponse).name).toBe(
        "Billing Engine"
      );

      // Step 4: AI looks up what else is in the billing directory
      const fileResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/billing" },
      });
      const fileParsed = parseResult(fileResult);
      expect(fileParsed.success).toBe(true);
      expect((fileParsed as any).count).toBeGreaterThanOrEqual(1);
    });

    it("workflow: file-context → related terms → domain exploration", async () => {
      // Step 1: AI opens a middleware file and asks "what is this?"
      const fileResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/middleware/feature-gate.ts" },
      });
      const fileParsed = parseResult(fileResult);
      expect(fileParsed.success).toBe(true);
      const firstTerm = (fileParsed as any).terms[0] as TermResponse;
      expect(firstTerm.name).toBe("Feature Flag System");

      // Step 2: AI wants more context about the same domain
      const domainResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: firstTerm.category },
      });
      const domainParsed = parseResult(domainResult);
      expect(domainParsed.success).toBe(true);
      // Both Feature Flag System and Deployment Pipeline are "infrastructure"
      expect((domainParsed as any).count).toBe(2);
    });

    it("workflow: add term → immediately queryable", async () => {
      // Step 1: AI creates a new org term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Health Check Endpoint",
          definition: "API endpoint for load balancer health monitoring",
          aliases: ["health check", "liveness probe"],
          category: "infrastructure",
          tags: ["monitoring", "devops"],
          codeLocations: [
            {
              filePath: "src/api/health.ts",
              symbol: "healthCheck",
              relationship: "defines",
            },
          ],
        },
      });
      const addParsed = parseResult(addResult);
      expect(addParsed.success).toBe(true);

      // Step 2: Immediately search for it
      const searchResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "health check" },
      });
      const searchParsed = parseResult(searchResult);
      expect(searchParsed.success).toBe(true);
      const names = (searchParsed as any).terms.map(
        (t: TermResponse) => t.name
      );
      expect(names).toContain("Health Check Endpoint");

      // Step 3: Find by file
      const fileResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/api/health.ts" },
      });
      const fileParsed = parseResult(fileResult);
      expect(fileParsed.success).toBe(true);
      expect((fileParsed as any).terms[0].name).toBe("Health Check Endpoint");
    });

    it("workflow: update term → changes reflected in queries", async () => {
      // Step 1: Update term with new code location and alias
      await client.callTool({
        name: TOOL_NAMES.UPDATE_TERM,
        arguments: {
          id: terms.featureFlags.id,
          aliases: ["feature toggles", "flags", "FF", "rollout system", "experiment framework"],
          codeLocations: [
            {
              filePath: "src/features/flag-manager.ts",
              symbol: "FlagManager",
              relationship: "defines",
            },
            {
              filePath: "src/features/experiment-runner.ts",
              symbol: "ExperimentRunner",
              relationship: "implements",
            },
          ],
        },
      });

      // Step 2: Search by new alias
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "experiment framework" },
      });
      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      expect((parsed as any).terms[0].name).toBe("Feature Flag System");

      // Step 3: Find by new file location
      const fileResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/features/experiment-runner.ts" },
      });
      const fileParsed = parseResult(fileResult);
      expect(fileParsed.success).toBe(true);
      expect((fileParsed as any).terms[0].name).toBe("Feature Flag System");
    });

    it("workflow: remove term → no longer appears in queries", async () => {
      // Step 1: Confirm term exists
      const beforeResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Data Ingestion Pipeline" },
      });
      expect(parseResult(beforeResult).success).toBe(true);
      expect((parseResult(beforeResult) as any).count).toBeGreaterThanOrEqual(1);

      // Step 2: Remove it
      const removeResult = await client.callTool({
        name: TOOL_NAMES.REMOVE_TERM,
        arguments: { id: terms.dataIngestion.id },
      });
      expect(parseResult(removeResult).success).toBe(true);

      // Step 3: Confirm it's gone from search
      const afterSearchResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "Data Ingestion Pipeline" },
      });
      const afterSearch = parseResult(afterSearchResult);
      const names = (afterSearch as any).terms.map(
        (t: TermResponse) => t.name
      );
      expect(names).not.toContain("Data Ingestion Pipeline");

      // Step 4: Confirm it's gone from file lookup
      const afterFileResult = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/data/ingestion" },
      });
      const afterFile = parseResult(afterFileResult);
      expect((afterFile as any).count).toBe(0);

      // Step 5: Confirm list count decreased
      const listResult = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });
      expect((parseResult(listResult) as any).count).toBe(5); // was 6
    });
  });

  // ── 7. Response Structure Validation ────────────────────────────────

  describe("response structure validation for AI consumption", () => {
    it("query_context response has consistent structure", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "auth" },
      });

      const parsed = parseResult(result);
      expect(parsed).toHaveProperty("success");
      expect(parsed).toHaveProperty("query");
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("terms");
      expect(typeof (parsed as any).success).toBe("boolean");
      expect(typeof (parsed as any).query).toBe("string");
      expect(typeof (parsed as any).count).toBe("number");
      expect(Array.isArray((parsed as any).terms)).toBe(true);
    });

    it("get_term response includes all fields needed by AI tools", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: terms.sprintVelocity.id },
      });

      const parsed = parseResult(result);
      const term = (parsed as any).term as TermResponse;

      // All fields an AI tool needs to understand and navigate to code
      expect(term.id).toBeDefined();
      expect(term.name).toBeDefined();
      expect(term.definition).toBeDefined();
      expect(Array.isArray(term.aliases)).toBe(true);
      expect(Array.isArray(term.codeLocations)).toBe(true);
      expect(Array.isArray(term.tags)).toBe(true);
      expect(term.source).toBeDefined();
      expect(term.source.adapter).toBeDefined();
      expect(term.confidence).toBeDefined();
      expect(term.createdAt).toBeDefined();
      expect(term.updatedAt).toBeDefined();

      // Code locations have full detail
      for (const loc of term.codeLocations) {
        expect(loc.filePath).toBeDefined();
        expect(loc.relationship).toBeDefined();
      }
    });

    it("error responses have consistent structure for AI error handling", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: "00000000-0000-4000-8000-000000000000" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(false);
      expect(typeof parsed.error).toBe("string");
      expect(parsed.error!.length).toBeGreaterThan(0);
    });

    it("list_terms response includes term count for AI reasoning", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: { category: "billing" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      // Count matches actual array length
      expect((parsed as any).count).toBe((parsed as any).terms.length);
    });

    it("find_by_file response includes the queried file path", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "src/billing/payment-gateway.ts" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).filePath).toBe("src/billing/payment-gateway.ts");
    });
  });

  // ── 8. Multiple Concurrent AI Clients ───────────────────────────────

  describe("concurrent AI tool client support", () => {
    it("two AI clients can connect and query simultaneously", async () => {
      // Create a second client (simulating Cursor alongside Claude Code)
      const secondClient = new Client({
        name: "cursor-test",
        version: "1.0.0",
      });

      // We need a separate server+transport for the second client
      // because each transport pair is 1:1
      const tempDir2 = await mkdtemp(join(tmpdir(), "lingo-e2e-test2-"));
      const glossaryPath2 = join(tempDir2, "glossary.json");
      const storage2 = new JsonGlossaryStorage(glossaryPath2);
      await storage2.load("acme-corp");
      await seedOrganizationalContext(storage2);

      const config2: LingoServerConfig = {
        glossaryPath: glossaryPath2,
        organization: "acme-corp",
        logLevel: "error",
      };
      const server2 = createServer(config2, storage2);

      const [clientTransport2, serverTransport2] =
        InMemoryTransport.createLinkedPair();
      await server2.connect(serverTransport2);
      await secondClient.connect(clientTransport2);

      try {
        // Both clients query simultaneously
        const [result1, result2] = await Promise.all([
          client.callTool({
            name: TOOL_NAMES.QUERY_CONTEXT,
            arguments: { query: "billing" },
          }),
          secondClient.callTool({
            name: TOOL_NAMES.QUERY_CONTEXT,
            arguments: { query: "authentication" },
          }),
        ]);

        const parsed1 = parseResult(result1);
        const parsed2 = parseResult(result2);

        // Both succeed with correct results
        expect(parsed1.success).toBe(true);
        expect(parsed2.success).toBe(true);

        expect((parsed1 as any).terms[0].name).toBe("Billing Engine");
        expect((parsed2 as any).terms[0].name).toBe("Authentication Guard");
      } finally {
        await secondClient.close();
        await server2.close();
        await rm(tempDir2, { recursive: true, force: true });
      }
    });
  });

  // ── 9. Cold-Start Query Behavior ────────────────────────────────────

  describe("cold-start query behavior (empty glossary)", () => {
    let emptyClient: Client;
    let emptyCleanup: () => Promise<void>;

    beforeEach(async () => {
      // Create a server with an empty glossary
      const tempDir = await mkdtemp(join(tmpdir(), "lingo-e2e-empty-"));
      const glossaryPath = join(tempDir, "glossary.json");
      const emptyStorage = new JsonGlossaryStorage(glossaryPath);
      await emptyStorage.load("new-org");

      const config: LingoServerConfig = {
        glossaryPath,
        organization: "new-org",
        logLevel: "error",
      };
      const server = createServer(config, emptyStorage);
      emptyClient = new Client({ name: "new-ai-client", version: "1.0.0" });

      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await emptyClient.connect(ct);

      emptyCleanup = async () => {
        await emptyClient.close();
        await server.close();
        await rm(tempDir, { recursive: true, force: true });
      };
    });

    afterEach(async () => {
      await emptyCleanup();
    });

    it("query_context on empty glossary returns cold-start guidance", async () => {
      const result = await emptyClient.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "anything" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(0);

      // Cold-start guidance should be present
      expect((parsed as any)._coldStart).toBe(true);
      expect((parsed as any).guidance).toBeDefined();
      expect((parsed as any).guidance.howToPopulate).toBeDefined();
      expect(Array.isArray((parsed as any).guidance.howToPopulate)).toBe(true);
    });

    it("list_terms on empty glossary returns cold-start guidance", async () => {
      const result = await emptyClient.callTool({
        name: TOOL_NAMES.LIST_TERMS,
        arguments: {},
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(0);
      expect((parsed as any)._coldStart).toBe(true);
    });

    it("get_term on empty glossary returns helpful message (not error)", async () => {
      const result = await emptyClient.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { name: "anything" },
      });

      const parsed = parseResult(result);
      // Should be a soft "not found" with guidance, not a hard error
      expect(parsed.success).toBe(true);
      expect((parsed as any).term).toBeNull();
      expect((parsed as any)._coldStart).toBe(true);
    });

    it("tools still work after first term is added to empty store", async () => {
      // Add first term
      const addResult = await emptyClient.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "First Concept",
          definition: "The very first organizational term",
          codeLocations: [
            {
              filePath: "src/core/concept.ts",
              symbol: "Concept",
              relationship: "defines",
            },
          ],
        },
      });
      expect(parseResult(addResult).success).toBe(true);

      // Now query should find it without cold-start guidance
      const searchResult = await emptyClient.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "First Concept" },
      });
      const searchParsed = parseResult(searchResult);
      expect(searchParsed.success).toBe(true);
      expect((searchParsed as any).count).toBe(1);
      expect((searchParsed as any)._coldStart).toBeUndefined();
    });
  });

  // ── 10. Cross-Domain Query Scenarios ────────────────────────────────

  describe("cross-domain query scenarios", () => {
    it("finds terms across multiple domains for broad queries", async () => {
      // "infrastructure" search should match both Feature Flags and Deploy Pipeline
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "infrastructure" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(2);
    });

    it("case-insensitive search works across all term fields", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "AUTHENTICATION GUARD" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBeGreaterThanOrEqual(1);
      expect((parsed as any).terms[0].name).toBe("Authentication Guard");
    });

    it("finds term by searching for implementation detail in definition", async () => {
      // Searching for "JWT" should find Auth Guard (mentioned in definition)
      const result = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "JWT" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      const names = (parsed as any).terms.map((t: TermResponse) => t.name);
      expect(names).toContain("Authentication Guard");
    });

    it("find_by_file is case-insensitive", async () => {
      const result = await client.callTool({
        name: TOOL_NAMES.FIND_BY_FILE,
        arguments: { filePath: "SRC/BILLING/PAYMENT-GATEWAY.TS" },
      });

      const parsed = parseResult(result);
      expect(parsed.success).toBe(true);
      expect((parsed as any).count).toBe(1);
      expect((parsed as any).terms[0].name).toBe("Billing Engine");
    });
  });
});
