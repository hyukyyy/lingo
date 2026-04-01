/**
 * Integration Test — No-Matches Scenario
 *
 * Verifies correct behavior across the Lingo system when a glossary is
 * populated with terms but tool output/input does NOT contain any matching
 * terms. This is distinct from the no-glossary scenario (empty store) — here
 * the store has data but the content being analyzed has zero overlap.
 *
 * Scenarios tested:
 *   1. Hook produces no advisory output when tool output has no term matches
 *   2. Hook produces no output for partial/substring matches (word boundaries)
 *   3. MCP query tools return empty results for unrelated queries
 *   4. find_by_file returns empty when file path has no associated terms
 *   5. End-to-end: populated glossary + unrelated tool output = silent hook
 *   6. Mixed scenario: some tools match, some don't — only matches produce output
 *
 * This validates the integration between:
 *   - MCP server (query tools returning correct empty results)
 *   - Glossary storage (populated store with real terms)
 *   - Prompt learning hook (word-boundary-aware matching in bash/jq)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type LingoServerConfig } from "../../src/server.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";
import { TOOL_NAMES } from "../../src/tools/index.js";

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
  glossaryPath: string,
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
  toolResult: unknown,
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
  const results: Array<{
    termId: string;
    signalType: string;
    matchedLabel: string;
  }> = [];
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
 * The glossary terms we seed for this test suite. These represent real
 * organizational terminology in a specific domain (fintech/billing).
 */
const SEED_TERMS = [
  {
    name: "Sprint Velocity",
    definition: "Story points completed per sprint iteration",
    aliases: ["velocity", "SV"],
    category: "agile-metrics",
    tags: ["metrics"],
  },
  {
    name: "Billing Engine",
    definition: "Subscription billing and invoicing system",
    aliases: ["billing", "invoicing"],
    category: "billing",
    tags: ["payments"],
  },
  {
    name: "Feature Flag System",
    definition: "Infrastructure for toggling features per user segment",
    aliases: ["feature toggles", "flags"],
    category: "infrastructure",
    tags: ["deployment"],
  },
  {
    name: "Authentication Guard",
    definition: "Middleware that validates JWT tokens for route protection",
    aliases: ["auth guard", "JWT validator"],
    category: "security",
    tags: ["auth"],
  },
];

/**
 * Creates a fully connected MCP server + client pair with a populated glossary
 * containing known terms, ready for no-matches testing.
 */
async function createNoMatchesHarness() {
  const tempDir = await mkdtemp(join(tmpdir(), "lingo-no-matches-"));
  const glossaryPath = join(tempDir, ".lingo", "glossary.json");

  const storage = new JsonGlossaryStorage(glossaryPath);
  await storage.load("no-matches-test-org");

  const config: LingoServerConfig = {
    glossaryPath,
    organization: "no-matches-test-org",
    logLevel: "error",
  };
  const server = createServer(config, storage);

  const client = new Client({
    name: "no-matches-test-client",
    version: "1.0.0",
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Seed the glossary with known terms
  const termIds: Record<string, string> = {};
  for (const termData of SEED_TERMS) {
    const result = await client.callTool({
      name: TOOL_NAMES.ADD_TERM,
      arguments: termData,
    });
    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    termIds[termData.name] = (parsed.term as Record<string, unknown>)
      .id as string;
  }

  return {
    tempDir,
    glossaryPath,
    storage,
    server,
    client,
    termIds,
    cleanup: async () => {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

// ─── Integration Tests ──────────────────────────────────────────────────

describe(
  "No-Matches Scenario Integration Tests",
  { timeout: 30000 },
  () => {
    let glossaryPath: string;
    let client: Client;
    let termIds: Record<string, string>;
    let cleanup: () => Promise<void>;
    let jqAvailable: boolean;

    beforeAll(async () => {
      jqAvailable = await checkJqAvailable();
    });

    beforeEach(async () => {
      const harness = await createNoMatchesHarness();
      glossaryPath = harness.glossaryPath;
      client = harness.client;
      termIds = harness.termIds;
      cleanup = harness.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    // ── 1. Hook Silent on Completely Unrelated Content ────────────────

    describe("hook produces no output for unrelated tool content", () => {
      beforeEach(({ skip }) => {
        if (!jqAvailable) skip();
      });

      it("returns empty stdout when tool output discusses unrelated topics", async () => {
        const hookInput = makePostToolUseJson(
          "Read",
          { file_path: "src/weather/forecast.ts" },
          {
            content: [
              {
                type: "text",
                text: "This module implements weather forecasting using atmospheric pressure data and humidity sensors.",
              },
            ],
          },
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout for numeric/code-heavy output with no term overlap", async () => {
        const hookInput = makePostToolUseJson(
          "Bash",
          { command: "npm test" },
          "Test Suites: 42 passed, 42 total\nTests: 187 passed, 187 total\nSnapshots: 0 total\nTime: 4.231 s",
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout for tool output with only generic programming terms", async () => {
        const hookInput = makePostToolUseJson(
          "Read",
          { file_path: "src/utils/array-helpers.ts" },
          {
            content: [
              {
                type: "text",
                text: "export function flatten<T>(arr: T[][]): T[] { return arr.reduce((acc, val) => acc.concat(val), []); }",
              },
            ],
          },
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout for Bash command output with error messages", async () => {
        const hookInput = makePostToolUseJson(
          "Bash",
          { command: "docker compose up -d" },
          "Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout for git diff output with no term matches", async () => {
        const hookInput = makePostToolUseJson(
          "Bash",
          { command: "git diff HEAD~1" },
          [
            "diff --git a/src/utils/logger.ts b/src/utils/logger.ts",
            "index abc1234..def5678 100644",
            "--- a/src/utils/logger.ts",
            "+++ b/src/utils/logger.ts",
            "@@ -1,5 +1,7 @@",
            "+import { format } from 'date-fns';",
            " export class Logger {",
            "   private level: string;",
            "+  private timestamp: boolean;",
            " }",
          ].join("\n"),
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });
    });

    // ── 2. Hook Respects Word Boundaries (No Partial Matches) ────────

    describe("hook does not match partial words or substrings", () => {
      beforeEach(({ skip }) => {
        if (!jqAvailable) skip();
      });

      it("does not match 'velocity' substring inside 'velocityVector'", async () => {
        // "velocity" is an alias for Sprint Velocity — but "velocityVector"
        // should NOT match because of word boundary enforcement
        const hookInput = makePostToolUseJson(
          "Read",
          { file_path: "src/physics/motion.ts" },
          {
            content: [
              {
                type: "text",
                text: "const velocityVector = calculateVelocityVector(mass, acceleration);",
              },
            ],
          },
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        // Should not produce suggestions since "velocity" only appears as a
        // substring of "velocityVector" and "calculateVelocityVector"
        const suggestions = parseHookSuggestions(hookResult.stdout);
        const velocityMatch = suggestions.find(
          (s) => s.termId === termIds["Sprint Velocity"],
        );
        expect(velocityMatch).toBeUndefined();
      });

      it("does not match 'billing' substring inside 'rebilling' or 'billingsworth'", async () => {
        const hookInput = makePostToolUseJson(
          "Read",
          {},
          {
            content: [
              {
                type: "text",
                text: "The rebilling process for Mr. Billingsworth was handled by the prebilling module.",
              },
            ],
          },
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        const suggestions = parseHookSuggestions(hookResult.stdout);
        const billingMatch = suggestions.find(
          (s) => s.termId === termIds["Billing Engine"],
        );
        expect(billingMatch).toBeUndefined();
      });

      it("does not match 'flags' substring inside 'flagsEnabled' or 'configFlags'", async () => {
        const hookInput = makePostToolUseJson(
          "Bash",
          { command: "grep -r flagsEnabled" },
          "src/config.ts:  const flagsEnabled = process.env.FEATURE_FLAGS_ENABLED === 'true';",
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        const suggestions = parseHookSuggestions(hookResult.stdout);
        const flagsMatch = suggestions.find(
          (s) => s.termId === termIds["Feature Flag System"],
        );
        expect(flagsMatch).toBeUndefined();
      });
    });

    // ── 3. MCP Query Tools Return Empty for Non-Matching Queries ─────

    describe("MCP query tools return empty results for non-matching queries", () => {
      it("query_context returns zero results for unrelated query", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.QUERY_CONTEXT,
          arguments: { query: "machine learning neural network" },
        });

        expect(result.isError).toBeFalsy();

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.count).toBe(0);
        expect(parsed.terms).toEqual([]);
        // Should NOT have _coldStart since the store is populated
        expect(parsed._coldStart).toBeUndefined();
      });

      it("get_term returns not-found error for non-existent term name", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.GET_TERM,
          arguments: { name: "Quantum Entanglement Module" },
        });

        // When store is populated, a missing term is a real "not found" error
        expect(result.isError).toBe(true);

        const parsed = parseResult(result);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain("not found");
        // No cold start since the store has terms
        expect(parsed._coldStart).toBeUndefined();
      });

      it("get_term returns not-found error for non-existent term ID", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.GET_TERM,
          arguments: { id: "00000000-0000-0000-0000-000000000000" },
        });

        // When store is populated, a missing term is a real "not found" error
        expect(result.isError).toBe(true);

        const parsed = parseResult(result);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain("not found");
        expect(parsed._coldStart).toBeUndefined();
      });

      it("find_by_file returns empty for a file not associated with any term", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.FIND_BY_FILE,
          arguments: { filePath: "src/unrelated/quantum-physics.ts" },
        });

        expect(result.isError).toBeFalsy();

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.count).toBe(0);
        expect(parsed.terms).toEqual([]);
        // Store has terms → no cold start flag
        expect(parsed._coldStart).toBeUndefined();
      });

      it("list_terms with non-matching filter returns zero results", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.LIST_TERMS,
          arguments: { category: "quantum-physics" },
        });

        expect(result.isError).toBeFalsy();

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.count).toBe(0);
        expect(parsed.terms).toEqual([]);
        // Store has terms → no cold start flag
        expect(parsed._coldStart).toBeUndefined();
      });
    });

    // ── 4. No Cold-Start in Populated Store with No Matches ──────────

    describe("populated store does not trigger cold-start guidance on empty results", () => {
      it("query_context with no matches omits _coldStart and guidance", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.QUERY_CONTEXT,
          arguments: { query: "something totally unrelated" },
        });

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.count).toBe(0);
        expect(parsed._coldStart).toBeUndefined();
        expect(parsed.guidance).toBeUndefined();
      });

      it("list_terms returns terms and no guidance when store is populated", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.LIST_TERMS,
          arguments: {},
        });

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.count).toBe(SEED_TERMS.length);
        expect(parsed._coldStart).toBeUndefined();
        expect(parsed.guidance).toBeUndefined();
      });
    });

    // ── 5. End-to-End: Populated Glossary + Unrelated Tool = Silent ──

    describe("end-to-end: populated glossary with completely unrelated tool output", () => {
      beforeEach(({ skip }) => {
        if (!jqAvailable) skip();
      });

      it("full cycle: add terms → run hook with unrelated content → no advisory → query confirms terms still exist", async () => {
        // Step 1: Verify terms were seeded (sanity check)
        const listResult = await client.callTool({
          name: TOOL_NAMES.LIST_TERMS,
          arguments: {},
        });
        const listParsed = parseResult(listResult);
        expect(listParsed.count).toBe(SEED_TERMS.length);

        // Step 2: Run hook with content that has zero overlap with any term
        const hookInput = makePostToolUseJson(
          "Read",
          { file_path: "src/astronomy/star-catalog.ts" },
          {
            content: [
              {
                type: "text",
                text: [
                  "/**",
                  " * Star catalog module for astronomical coordinate calculations.",
                  " * Uses right ascension and declination for stellar positioning.",
                  " * Supports Hipparcos, Tycho-2, and Gaia DR3 catalogs.",
                  " */",
                  "export class StarCatalog {",
                  "  private rightAscension: number;",
                  "  private declination: number;",
                  "  private magnitude: number;",
                  "",
                  "  calculateParallax(distance: number): number {",
                  "    return 1 / distance;",
                  "  }",
                  "}",
                ].join("\n"),
              },
            ],
          },
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        // Step 3: Hook should be completely silent
        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");

        // Step 4: Verify terms are still intact (hook didn't corrupt anything)
        const afterListResult = await client.callTool({
          name: TOOL_NAMES.LIST_TERMS,
          arguments: {},
        });
        const afterParsed = parseResult(afterListResult);
        expect(afterParsed.count).toBe(SEED_TERMS.length);
      });

      it("hook is silent for multiple sequential unrelated tool outputs", async () => {
        const unrelatedPayloads = [
          makePostToolUseJson(
            "Read",
            { file_path: "README.md" },
            { content: [{ type: "text", text: "# Project Setup\n\nRun npm install to get started." }] },
          ),
          makePostToolUseJson(
            "Bash",
            { command: "ls -la" },
            "total 48\ndrwxr-xr-x  12 user  staff  384 Apr  1 10:00 .\n-rw-r--r--   1 user  staff  1234 Apr  1 10:00 package.json",
          ),
          makePostToolUseJson(
            "Edit",
            { file_path: "src/config.ts", old_string: "port: 3000", new_string: "port: 8080" },
            { content: [{ type: "text", text: "File edited successfully" }] },
          ),
          makePostToolUseJson(
            "Grep",
            { pattern: "TODO", path: "src/" },
            "src/utils/helpers.ts:42: // TODO: refactor this helper\nsrc/config.ts:10: // TODO: load from env",
          ),
        ];

        for (const payload of unrelatedPayloads) {
          const hookResult = await runHook(payload, glossaryPath);
          expect(hookResult.exitCode).toBe(0);
          expect(hookResult.stdout).toBe("");
        }
      });
    });

    // ── 6. Mixed Scenario: Some Match, Some Don't ────────────────────

    describe("mixed scenario: correctly distinguishes matching vs. non-matching content", () => {
      beforeEach(({ skip }) => {
        if (!jqAvailable) skip();
      });

      it("produces output only for the tool invocation that contains matching terms", async () => {
        // Non-matching tool output → silent
        const noMatchInput = makePostToolUseJson(
          "Read",
          { file_path: "src/math/trigonometry.ts" },
          {
            content: [
              {
                type: "text",
                text: "Calculates sine, cosine, and tangent for geometric transformations.",
              },
            ],
          },
        );

        const noMatchResult = await runHook(noMatchInput, glossaryPath);
        expect(noMatchResult.exitCode).toBe(0);
        expect(noMatchResult.stdout).toBe("");

        // Matching tool output → advisory
        const matchInput = makePostToolUseJson(
          "Read",
          { file_path: "src/metrics/sprint.ts" },
          {
            content: [
              {
                type: "text",
                text: "This module calculates Sprint Velocity for the team dashboard.",
              },
            ],
          },
        );

        const matchResult = await runHook(matchInput, glossaryPath);
        expect(matchResult.exitCode).toBe(0);
        expect(matchResult.stdout).toContain("record_signal");
        expect(matchResult.stdout).toContain(termIds["Sprint Velocity"]);

        // Another non-matching tool output → silent again
        const noMatch2Input = makePostToolUseJson(
          "Bash",
          { command: "node --version" },
          "v20.11.1",
        );

        const noMatch2Result = await runHook(noMatch2Input, glossaryPath);
        expect(noMatch2Result.exitCode).toBe(0);
        expect(noMatch2Result.stdout).toBe("");
      });

      it("query_context returns results for matching query but not for unrelated query", async () => {
        // Matching query
        const matchResult = await client.callTool({
          name: TOOL_NAMES.QUERY_CONTEXT,
          arguments: { query: "billing" },
        });
        const matchParsed = parseResult(matchResult);
        expect(matchParsed.success).toBe(true);
        expect(matchParsed.count).toBeGreaterThanOrEqual(1);

        // Non-matching query
        const noMatchResult = await client.callTool({
          name: TOOL_NAMES.QUERY_CONTEXT,
          arguments: { query: "quantum computing" },
        });
        const noMatchParsed = parseResult(noMatchResult);
        expect(noMatchParsed.success).toBe(true);
        expect(noMatchParsed.count).toBe(0);
        expect(noMatchParsed.terms).toEqual([]);
      });
    });

    // ── 7. Edge Cases: Empty and Whitespace Content ──────────────────

    describe("edge cases for empty or whitespace content", () => {
      beforeEach(({ skip }) => {
        if (!jqAvailable) skip();
      });

      it("returns empty stdout when tool result is an empty string", async () => {
        const hookInput = makePostToolUseJson("Bash", { command: "true" }, "");

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout when tool result is whitespace only", async () => {
        const hookInput = makePostToolUseJson(
          "Bash",
          { command: "echo '   '" },
          "   \n\t\n   ",
        );

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("returns empty stdout when structured content has empty text", async () => {
        const hookInput = makePostToolUseJson("Read", {}, {
          content: [{ type: "text", text: "" }],
        });

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });

      it("handles tool result with no content array gracefully", async () => {
        const hookInput = makePostToolUseJson("Read", {}, {
          content: [],
        });

        const hookResult = await runHook(hookInput, glossaryPath);

        expect(hookResult.exitCode).toBe(0);
        expect(hookResult.stdout).toBe("");
      });
    });

    // ── 8. Suggest Code Changes Returns Empty for Non-Matching Terms ─

    describe("suggest_code_changes returns empty for non-matching terms", () => {
      it("returns empty suggestions when changed term name does not match glossary", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.SUGGEST_CODE_CHANGES,
          arguments: {
            changeType: "rename",
            oldName: "Quantum Entanglement",
            newName: "Quantum Superposition",
            description: "Renaming an unrelated concept",
          },
        });

        expect(result.isError).toBeFalsy();

        const parsed = parseResult(result);
        expect(parsed.success).toBe(true);
        expect(parsed.suggestions).toEqual([]);
      });
    });

    // ── 9. Record Signal Fails Gracefully for Non-Existent Term ──────

    describe("record_signal handles non-existent term ID gracefully", () => {
      it("returns error for a term ID not in the glossary", async () => {
        const result = await client.callTool({
          name: TOOL_NAMES.RECORD_SIGNAL,
          arguments: {
            termId: "00000000-0000-0000-0000-000000000000",
            signalType: "prompt",
          },
        });

        const parsed = parseResult(result);
        // Should indicate failure but not crash
        expect(parsed.success).toBe(false);
      });
    });
  },
);
