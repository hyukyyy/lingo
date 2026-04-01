/**
 * Integration Test — Term Detection Scenario
 *
 * Verifies the end-to-end term detection flow across the Lingo system:
 *
 *   1. Terms are added to the glossary via MCP tools (add_term)
 *   2. The prompt-learning hook detects those terms in simulated tool input/output
 *   3. The record_signal tool strengthens coupling for detected terms
 *   4. Coupling scores increase and are reflected in subsequent queries
 *
 * This test exercises the integration between:
 *   - MCP server (term management, record_signal)
 *   - Glossary storage (persistence, coupling tracking)
 *   - Prompt learning hook (term detection in bash/jq)
 *
 * Unlike unit tests, this validates the full lifecycle:
 *   add_term → glossary persisted → hook reads glossary → detects terms →
 *   record_signal → coupling updated → query reflects new score
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type LingoServerConfig } from "../../src/server.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { TOOL_NAMES } from "../../src/tools/index.js";
import type { GlossaryTerm } from "../../src/models/glossary.js";

const execFileAsync = promisify(execFile);

// ─── Paths ───────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const HOOK_PATH = join(PROJECT_ROOT, "hooks/prompt-learning-hook.sh");

// ─── Types ───────────────────────────────────────────────────────────────

interface ToolResponse {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── Test Helpers ────────────────────────────────────────────────────────

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
 * Run the prompt-learning-hook.sh with given stdin JSON, pointing at the
 * test glossary path.
 */
function runHook(
  stdinInput: string,
  glossaryPath: string
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK_PATH], {
      env: {
        ...process.env,
        LINGO_GLOSSARY_PATH: glossaryPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1 });
    });

    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

/**
 * Construct a PostToolUse JSON payload as the hook expects on stdin.
 */
function makePostToolUseJson(
  toolName: string,
  toolInput: unknown,
  toolResult: unknown
): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    tool_result: toolResult,
  });
}

/**
 * Parse record_signal suggestions from hook advisory output.
 * Returns an array of { termId, signalType, matchedLabel }.
 */
function parseHookSuggestions(stdout: string): Array<{
  termId: string;
  signalType: string;
  matchedLabel: string;
}> {
  const regex =
    /record_signal\(termId: "([^"]+)", signalType: "([^"]+)"\)\s*#\s*matched: "([^"]+)"/g;
  const results: Array<{ termId: string; signalType: string; matchedLabel: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stdout)) !== null) {
    results.push({
      termId: match[1],
      signalType: match[2],
      matchedLabel: match[3],
    });
  }
  return results;
}

/**
 * Check if jq is available on the system (required by the hook).
 */
async function checkJqAvailable(): Promise<boolean> {
  try {
    await execFileAsync("jq", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a fully connected MCP server + client pair with an empty glossary,
 * ready for the term-detection integration scenario.
 */
async function createTermDetectionHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-term-detect-"));
  const glossaryPath = join(tempDir, ".lingo", "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("term-detect-test-org");

  const config: LingoServerConfig = {
    glossaryPath,
    organization: "term-detect-test-org",
    logLevel: "error",
  };
  const server = createServer(config, storage);

  const client = new Client({
    name: "term-detect-test-client",
    version: "1.0.0",
  });

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

describe("Term Detection Integration Scenario", { timeout: 30000 }, () => {
  let tempDir: string;
  let glossaryPath: string;
  let storage: JsonGlossaryStorage;
  let client: Client;
  let cleanup: () => Promise<void>;
  let jqAvailable: boolean;

  beforeAll(async () => {
    jqAvailable = await checkJqAvailable();
  });

  beforeEach(async () => {
    const harness = await createTermDetectionHarness();
    tempDir = harness.tempDir;
    glossaryPath = harness.glossaryPath;
    storage = harness.storage;
    client = harness.client;
    cleanup = harness.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── 1. Terms Added via MCP Are Detectable by Hook ───────────────────

  describe("terms added via MCP are detectable by the prompt-learning hook", () => {
    beforeEach(({ skip }) => {
      if (!jqAvailable) skip();
    });

    it("detects a term added via add_term in subsequent tool output", async () => {
      // Step 1: Add a term via MCP
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points completed per sprint iteration",
          aliases: ["velocity", "SV"],
          category: "agile-metrics",
          tags: ["metrics"],
        },
      });
      const addParsed = parseResult(addResult);
      expect(addParsed.success).toBe(true);
      const termId = (addParsed.term as Record<string, unknown>).id as string;

      // Step 2: Simulate a tool execution that mentions "Sprint Velocity"
      const hookInput = makePostToolUseJson("Read", { file_path: "src/metrics.ts" }, {
        content: [
          {
            type: "text",
            text: "This module calculates Sprint Velocity for the team dashboard.",
          },
        ],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      // Step 3: Verify the hook detected the term
      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toContain("record_signal");
      expect(hookResult.stdout).toContain(termId);
      expect(hookResult.stdout).toContain('"prompt"');
    });

    it("detects aliases of MCP-added terms", async () => {
      // Add a term with aliases
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Authentication Guard",
          definition: "Middleware that validates JWT tokens",
          aliases: ["auth guard", "JWT validator", "auth middleware"],
          category: "security",
        },
      });
      const addParsed = parseResult(addResult);
      expect(addParsed.success).toBe(true);
      const termId = (addParsed.term as Record<string, unknown>).id as string;

      // Simulate tool output containing an alias (not the canonical name)
      const hookInput = makePostToolUseJson(
        "Bash",
        { command: "git diff" },
        "Modified the auth middleware to support refresh tokens"
      );

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toContain(termId);
      expect(hookResult.stdout).toContain("record_signal");
    });

    it("detects multiple terms from a single tool output", async () => {
      // Add two distinct terms
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Billing Engine",
          definition: "Subscription billing system",
          aliases: ["billing"],
        },
      });

      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Feature Flag System",
          definition: "Infrastructure for toggling features per user segment",
          aliases: ["feature toggles", "flags"],
        },
      });

      // Simulate tool output mentioning both terms
      const hookInput = makePostToolUseJson("Read", {}, {
        content: [
          {
            type: "text",
            text: "The Billing Engine module uses the Feature Flag System to control premium features.",
          },
        ],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      const suggestions = parseHookSuggestions(hookResult.stdout);
      expect(suggestions.length).toBeGreaterThanOrEqual(2);

      const matchedLabels = suggestions.map((s) => s.matchedLabel);
      // At least one should match "Billing Engine" or alias, another "Feature Flag System" or alias
      const hasBilling = matchedLabels.some(
        (l) => l === "Billing Engine" || l === "billing"
      );
      const hasFeatureFlags = matchedLabels.some(
        (l) => l === "Feature Flag System" || l === "feature toggles" || l === "flags"
      );
      expect(hasBilling).toBe(true);
      expect(hasFeatureFlags).toBe(true);
    });

    it("detects terms in tool input (not just tool result)", async () => {
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Data Pipeline",
          definition: "ETL system for data ingestion",
          aliases: ["ETL pipeline", "ingestion"],
        },
      });
      const addParsed = parseResult(addResult);
      expect(addParsed.success).toBe(true);
      const termId = (addParsed.term as Record<string, unknown>).id as string;

      // Term appears only in tool_input, not in tool_result
      const hookInput = makePostToolUseJson(
        "Edit",
        { file_path: "src/data-pipeline/transform.ts", description: "Fix Data Pipeline bug" },
        { content: [{ type: "text", text: "File edited successfully" }] }
      );

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toContain(termId);
    });

    it("performs case-insensitive matching", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "API Gateway",
          definition: "Central entry point for external API requests",
        },
      });

      // Use uppercase in tool output
      const hookInput = makePostToolUseJson("Read", {}, {
        content: [
          { type: "text", text: "The API GATEWAY handles all incoming requests." },
        ],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toContain("record_signal");
      expect(hookResult.stdout).toContain("API Gateway");
    });

    it("does not detect terms when none match the tool output", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points per sprint",
        },
      });

      const hookInput = makePostToolUseJson("Read", {}, {
        content: [
          {
            type: "text",
            text: "Completely unrelated text about weather forecasting models.",
          },
        ],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toBe("");
    });
  });

  // ── 2. Full Lifecycle: Add → Detect → Signal → Verify Coupling ─────

  describe("complete term-detection lifecycle with coupling reinforcement", () => {
    beforeEach(({ skip }) => {
      if (!jqAvailable) skip();
    });

    it("end-to-end: add term → hook detects → record_signal → coupling increases", async () => {
      // Step 1: Add a term via MCP
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Cache Layer",
          definition: "Redis-backed caching infrastructure",
          aliases: ["redis cache", "cache"],
          codeLocations: [
            {
              filePath: "src/cache/redis-client.ts",
              symbol: "RedisCache",
              relationship: "defines",
            },
          ],
        },
      });
      const addParsed = parseResult(addResult);
      expect(addParsed.success).toBe(true);
      const term = addParsed.term as Record<string, unknown>;
      const termId = term.id as string;

      // Step 2: Verify initial coupling is absent or zero
      const initialGet = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: termId },
      });
      const initialParsed = parseResult(initialGet);
      const initialTerm = initialParsed.term as Record<string, unknown>;
      const initialCoupling = initialTerm.coupling as
        | { score: number; signals: number }
        | undefined;
      const initialScore = initialCoupling?.score ?? 0;

      // Step 3: Simulate a tool execution that mentions "Cache Layer"
      const hookInput = makePostToolUseJson(
        "Read",
        { file_path: "src/cache/redis-client.ts" },
        {
          content: [
            {
              type: "text",
              text: "The Cache Layer implementation uses Redis for storing session data.",
            },
          ],
        }
      );

      const hookResult = await runHook(hookInput, glossaryPath);

      // Step 4: Parse hook advisory and verify it suggests record_signal
      expect(hookResult.exitCode).toBe(0);
      const suggestions = parseHookSuggestions(hookResult.stdout);
      const cacheSuggestion = suggestions.find((s) => s.termId === termId);
      expect(cacheSuggestion).toBeDefined();
      expect(cacheSuggestion!.signalType).toBe("prompt");

      // Step 5: Follow the hook's advice — call record_signal via MCP
      const signalResult = await client.callTool({
        name: TOOL_NAMES.RECORD_SIGNAL,
        arguments: {
          termId: termId,
          signalType: "prompt",
        },
      });
      const signalParsed = parseResult(signalResult);
      expect(signalParsed.success).toBe(true);

      // Step 6: Verify coupling score increased
      const afterGet = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: termId },
      });
      const afterParsed = parseResult(afterGet);
      const afterTerm = afterParsed.term as Record<string, unknown>;
      const afterCoupling = afterTerm.coupling as {
        score: number;
        signals: number;
        sources: Array<{ type: string; count: number }>;
      };

      expect(afterCoupling.score).toBeGreaterThan(initialScore);
      expect(afterCoupling.signals).toBeGreaterThanOrEqual(1);

      // Verify the prompt source is tracked
      const promptSource = afterCoupling.sources.find(
        (s) => s.type === "prompt"
      );
      expect(promptSource).toBeDefined();
      expect(promptSource!.count).toBeGreaterThanOrEqual(1);
    });

    it("multiple signal recordings accumulate coupling score", async () => {
      // Add a term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Auth Service",
          definition: "User authentication microservice",
          aliases: ["auth", "authentication"],
        },
      });
      const termId = (
        parseResult(addResult).term as Record<string, unknown>
      ).id as string;

      // Record multiple signals (simulating hook detections over time)
      for (let i = 0; i < 3; i++) {
        await client.callTool({
          name: TOOL_NAMES.RECORD_SIGNAL,
          arguments: { termId, signalType: "prompt" },
        });
      }

      // Verify accumulated coupling
      const getResult = await client.callTool({
        name: TOOL_NAMES.GET_TERM,
        arguments: { id: termId },
      });
      const parsed = parseResult(getResult);
      const coupling = (parsed.term as Record<string, unknown>).coupling as {
        score: number;
        signals: number;
        sources: Array<{ type: string; count: number }>;
      };

      // 3 prompt signals at 0.15 each = 0.45 minimum
      expect(coupling.score).toBeGreaterThanOrEqual(0.40);
      expect(coupling.signals).toBeGreaterThanOrEqual(3);
      expect(
        coupling.sources.find((s) => s.type === "prompt")!.count
      ).toBeGreaterThanOrEqual(3);
    });
  });

  // ── 3. Hook Skips Lingo Tools (Integration Verification) ───────────

  describe("hook correctly skips Lingo tool names from MCP-added terms", () => {
    beforeEach(({ skip }) => {
      if (!jqAvailable) skip();
    });

    it("does not trigger on record_signal tool output even when terms match", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points per sprint",
        },
      });

      // Simulate a record_signal call output that mentions the term
      const hookInput = makePostToolUseJson(
        "record_signal",
        { termId: "some-id", signalType: "prompt" },
        "Recorded signal for Sprint Velocity"
      );

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toBe("");
    });

    it("does not trigger on MCP-prefixed lingo tools", async () => {
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Sprint Velocity",
          definition: "Story points per sprint",
        },
      });

      const hookInput = makePostToolUseJson(
        "mcp__lingo__query_context",
        { query: "velocity" },
        "Sprint Velocity: Story points per sprint"
      );

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toBe("");
    });
  });

  // ── 4. Term Detection with Updated/Removed Terms ───────────────────

  describe("term detection reflects term updates and removals", () => {
    beforeEach(({ skip }) => {
      if (!jqAvailable) skip();
    });

    it("detects terms by their updated aliases after update_term", async () => {
      // Add a term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Deployment Pipeline",
          definition: "CI/CD pipeline through staging to production",
          aliases: ["deploy pipeline"],
        },
      });
      const termId = (
        parseResult(addResult).term as Record<string, unknown>
      ).id as string;

      // Update with new alias
      await client.callTool({
        name: TOOL_NAMES.UPDATE_TERM,
        arguments: {
          id: termId,
          aliases: ["deploy pipeline", "release pipeline", "CD pipeline"],
        },
      });

      // Verify the new alias is detectable
      const hookInput = makePostToolUseJson("Bash", {}, {
        content: [
          { type: "text", text: "Triggering the CD pipeline for the latest release" },
        ],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).toContain(termId);
      expect(hookResult.stdout).toContain("record_signal");
    });

    it("does not detect removed terms", async () => {
      // Add a term
      const addResult = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Legacy Module",
          definition: "Deprecated module scheduled for removal",
        },
      });
      const termId = (
        parseResult(addResult).term as Record<string, unknown>
      ).id as string;

      // Verify it's detectable first
      let hookInput = makePostToolUseJson("Read", {}, {
        content: [
          { type: "text", text: "The Legacy Module handles old data formats." },
        ],
      });

      let hookResult = await runHook(hookInput, glossaryPath);
      expect(hookResult.stdout).toContain(termId);

      // Remove the term
      await client.callTool({
        name: TOOL_NAMES.REMOVE_TERM,
        arguments: { id: termId },
      });

      // Verify it's no longer detectable
      hookResult = await runHook(hookInput, glossaryPath);
      expect(hookResult.exitCode).toBe(0);
      expect(hookResult.stdout).not.toContain(termId);
    });
  });

  // ── 5. Term Detection with Query Context Consistency ───────────────

  describe("detected terms are consistent with query_context results", () => {
    beforeEach(({ skip }) => {
      if (!jqAvailable) skip();
    });

    it("hook detects the same terms that query_context returns", async () => {
      // Add multiple terms
      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Notification Service",
          definition: "Sends push/email/SMS notifications to users",
          aliases: ["notifier", "alerts"],
        },
      });

      await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Search Index",
          definition: "Elasticsearch-based full-text search",
          aliases: ["search engine", "elasticsearch"],
        },
      });

      const searchText = "Notification Service sends alerts when the Search Index is updated";

      // Query via MCP to see which terms match "notification"
      const notifResult = await client.callTool({
        name: TOOL_NAMES.QUERY_CONTEXT,
        arguments: { query: "notification" },
      });
      const notifParsed = parseResult(notifResult);
      expect(notifParsed.success).toBe(true);
      expect((notifParsed as any).count).toBeGreaterThanOrEqual(1);

      // Hook should also detect "Notification Service"
      const hookInput = makePostToolUseJson("Read", {}, {
        content: [{ type: "text", text: searchText }],
      });

      const hookResult = await runHook(hookInput, glossaryPath);

      expect(hookResult.exitCode).toBe(0);
      const suggestions = parseHookSuggestions(hookResult.stdout);
      expect(suggestions.length).toBeGreaterThanOrEqual(1);

      // The hook's detected terms should overlap with query_context results
      const hookTermIds = suggestions.map((s) => s.termId);
      const queryTermIds = ((notifParsed as any).terms as Array<Record<string, unknown>>).map(
        (t) => t.id as string
      );

      // At least the notification term should appear in both
      const overlap = hookTermIds.filter((id) => queryTermIds.includes(id));
      expect(overlap.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 6. Glossary Persistence Verification ───────────────────────────

  describe("glossary file is consistent after term-detection operations", () => {
    it("glossary file contains all terms after add/update/signal cycle", async () => {
      // Add terms
      const addResult1 = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Rate Limiter",
          definition: "Controls API request rate per client",
          aliases: ["throttle", "rate limit"],
        },
      });
      const termId1 = (
        parseResult(addResult1).term as Record<string, unknown>
      ).id as string;

      const addResult2 = await client.callTool({
        name: TOOL_NAMES.ADD_TERM,
        arguments: {
          name: "Circuit Breaker",
          definition: "Prevents cascading failures in distributed systems",
          aliases: ["breaker", "fault tolerance"],
        },
      });
      const termId2 = (
        parseResult(addResult2).term as Record<string, unknown>
      ).id as string;

      // Record signals for one of them
      await client.callTool({
        name: TOOL_NAMES.RECORD_SIGNAL,
        arguments: { termId: termId1, signalType: "prompt" },
      });

      // Read glossary file directly and verify structure
      const raw = await readFile(glossaryPath, "utf-8");
      const glossary = JSON.parse(raw);

      // Both terms should be present
      const termIds = Object.keys(glossary.terms);
      expect(termIds).toContain(termId1);
      expect(termIds).toContain(termId2);

      // Term 1 should have coupling data
      const term1 = glossary.terms[termId1];
      expect(term1.name).toBe("Rate Limiter");
      expect(term1.coupling).toBeDefined();
      expect(term1.coupling.score).toBeGreaterThan(0);

      // Term 2 should have no or zero coupling
      const term2 = glossary.terms[termId2];
      expect(term2.name).toBe("Circuit Breaker");
      const term2Score = term2.coupling?.score ?? 0;
      expect(term2Score).toBe(0);
    });
  });
});
