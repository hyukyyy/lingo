/**
 * Integration Test: Own-Tools-Skipped Scenario
 *
 * Validates that Lingo's prompt-learning-hook.sh correctly excludes ALL of
 * Lingo's own MCP tools from processing. This is an integration test because
 * it verifies the contract between two independent components:
 *
 *   1. TypeScript tool definitions (ALL_TOOL_NAMES in src/tools/index.ts)
 *   2. Bash hook script (LINGO_TOOLS list in hooks/prompt-learning-hook.sh)
 *
 * If a new tool is added to the TypeScript codebase but not to the hook's
 * skip list, these tests will catch the drift.
 *
 * The test also verifies that non-Lingo tools (Read, Bash, etc.) ARE processed
 * normally — ensuring the skip logic is targeted, not over-broad.
 *
 * Requirements: bash, jq must be available on the test system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ALL_TOOL_NAMES } from "../../src/tools/index.js";

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const HOOK_PATH = join(PROJECT_ROOT, "hooks/prompt-learning-hook.sh");
const TEST_DIR = join(PROJECT_ROOT, "tests/integration/.tmp-own-tools-test");
const GLOSSARY_DIR = join(TEST_DIR, ".lingo");
const GLOSSARY_PATH = join(GLOSSARY_DIR, "glossary.json");

// ── Glossary fixture with a term that matches broadly ────────────────

const TEST_GLOSSARY = {
  version: "1.0.0",
  organization: "test-org",
  lastModified: "2026-04-01T00:00:00.000Z",
  terms: {
    "term-api-gateway": {
      id: "term-api-gateway",
      name: "API Gateway",
      definition: "Routes and authenticates API requests",
      aliases: ["gateway", "api-gw"],
      codeLocations: [],
      tags: ["infrastructure"],
      source: { adapter: "manual" },
      confidence: "manual",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
    "term-billing": {
      id: "term-billing",
      name: "Billing Engine",
      definition: "Subscription billing system",
      aliases: ["billing", "payments"],
      codeLocations: [],
      tags: ["billing"],
      source: { adapter: "manual" },
      confidence: "manual",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  },
};

/**
 * Text payload that is guaranteed to match glossary terms.
 * Used across all scenarios to ensure that skipping (or not) is the
 * only variable under test.
 */
const TERM_RICH_TEXT =
  "The API Gateway handles Billing Engine integration with payments and gateway routing";

// ── Hook runner ──────────────────────────────────────────────────────

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runHook(
  stdinInput: string,
  env?: Record<string, string>,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK_PATH], {
      cwd: TEST_DIR,
      env: {
        ...process.env,
        LINGO_GLOSSARY_PATH: GLOSSARY_PATH,
        ...env,
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

function makePostToolUseJson(
  toolName: string,
  toolResult: unknown,
): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: {},
    tool_result: toolResult,
  });
}

// ── Prerequisite check ───────────────────────────────────────────────

async function checkJqAvailable(): Promise<boolean> {
  try {
    await execFileAsync("jq", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Integration: Own-Tools-Skipped", { timeout: 30000 }, () => {
  let jqAvailable = false;

  beforeAll(async () => {
    jqAvailable = await checkJqAvailable();
    if (!jqAvailable) return;

    await mkdir(GLOSSARY_DIR, { recursive: true });
    await writeFile(GLOSSARY_PATH, JSON.stringify(TEST_GLOSSARY, null, 2));
  });

  afterAll(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  beforeEach(({ skip }) => {
    if (!jqAvailable) {
      skip();
    }
  });

  // ── Contract alignment: ALL_TOOL_NAMES must be skipped ──────────

  describe("every tool from ALL_TOOL_NAMES is skipped by the hook", () => {
    it("ALL_TOOL_NAMES is not empty (sanity check)", () => {
      expect(ALL_TOOL_NAMES.length).toBeGreaterThan(0);
    });

    for (const toolName of ALL_TOOL_NAMES) {
      it(`skips Lingo tool "${toolName}" — no output even with matching terms`, async () => {
        const input = makePostToolUseJson(toolName, TERM_RICH_TEXT);
        const result = await runHook(input);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
      });
    }
  });

  // ── MCP-prefixed variants are also skipped ──────────────────────

  describe("MCP-prefixed tool name variants are skipped", () => {
    const prefixVariants = [
      // Claude Code MCP prefix format: mcp__<server>__<tool>
      "mcp__lingo__query_context",
      "mcp__lingo__record_signal",
      "mcp__lingo__list_adapters",
      "mcp__lingo__learn_from_pr",
      // Alternative server name in prefix
      "mcp__lingo_mcp_server__get_term",
      "mcp__lingo_mcp__add_term",
      // Double-underscore namespace format
      "lingo__query_context",
      "lingo__record_signal",
      "lingo__bootstrap",
      // Colon namespace format
      "lingo:query_context",
      "lingo:record_signal",
      "lingo:list_terms",
    ];

    for (const toolName of prefixVariants) {
      it(`skips prefixed tool "${toolName}"`, async () => {
        const input = makePostToolUseJson(toolName, TERM_RICH_TEXT);
        const result = await runHook(input);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
      });
    }
  });

  // ── Non-Lingo tools ARE processed ───────────────────────────────

  describe("non-Lingo tools produce advisory output (not skipped)", () => {
    const externalTools = [
      "Read",
      "Bash",
      "Grep",
      "Edit",
      "Write",
      "mcp__github__get_pull_request",
      "mcp__slack__send_message",
      "some_random_tool",
    ];

    for (const toolName of externalTools) {
      it(`processes external tool "${toolName}" — produces advisory output`, async () => {
        const input = makePostToolUseJson(toolName, TERM_RICH_TEXT);
        const result = await runHook(input);

        expect(result.exitCode).toBe(0);
        // Should produce advisory output since terms match
        expect(result.stdout).toContain("record_signal");
        expect(result.stdout).toContain("term-api-gateway");
        expect(result.stdout).toContain("term-billing");
      });
    }
  });

  // ── Full round-trip: skip vs. process contrast ──────────────────

  describe("skip vs. process contrast in a single scenario", () => {
    it("Lingo's record_signal is silent, but external Read produces output — same payload", async () => {
      const payload = TERM_RICH_TEXT;

      // Lingo tool → silent
      const lingoResult = await runHook(
        makePostToolUseJson("record_signal", payload),
      );
      expect(lingoResult.stdout).toBe("");

      // External tool → advisory output
      const externalResult = await runHook(
        makePostToolUseJson("Read", payload),
      );
      expect(externalResult.stdout).not.toBe("");
      expect(externalResult.stdout).toContain("record_signal");
    });

    it("Lingo's learn_from_pr is silent, but external mcp__github__get_pr produces output — same payload", async () => {
      const payload = {
        content: [
          { type: "text", text: TERM_RICH_TEXT },
        ],
      };

      // Lingo tool → silent
      const lingoResult = await runHook(
        makePostToolUseJson("learn_from_pr", payload),
      );
      expect(lingoResult.stdout).toBe("");

      // External tool → advisory output
      const externalResult = await runHook(
        makePostToolUseJson("mcp__github__get_pr", payload),
      );
      expect(externalResult.stdout).not.toBe("");
      expect(externalResult.stdout).toContain("record_signal");
    });
  });

  // ── Hook skip-list completeness check ───────────────────────────

  describe("hook skip-list completeness", () => {
    it("the hook's LINGO_TOOLS list contains all tools from ALL_TOOL_NAMES", async () => {
      // Read the hook script to extract its LINGO_TOOLS list
      const { readFile } = await import("node:fs/promises");
      const hookContent = await readFile(HOOK_PATH, "utf-8");

      // Extract the LINGO_TOOLS variable value
      const match = hookContent.match(
        /LINGO_TOOLS="([^"]+)"/,
      );
      expect(match).not.toBeNull();

      const hookToolNames = match![1].trim().split(/\s+/);

      // Every tool in ALL_TOOL_NAMES should be in the hook's skip list
      for (const toolName of ALL_TOOL_NAMES) {
        expect(
          hookToolNames,
          `Tool "${toolName}" is defined in ALL_TOOL_NAMES but missing from hook's LINGO_TOOLS`,
        ).toContain(toolName);
      }

      // And the hook shouldn't have stale tool names
      for (const hookTool of hookToolNames) {
        expect(
          ALL_TOOL_NAMES as readonly string[],
          `Tool "${hookTool}" is in hook's LINGO_TOOLS but not in ALL_TOOL_NAMES — possibly stale`,
        ).toContain(hookTool);
      }
    });
  });
});
