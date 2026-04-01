/**
 * Tests for the prompt-learning-hook.sh PostToolUse hook.
 *
 * These tests invoke the shell script with various stdin inputs and verify
 * that it correctly identifies glossary terms, skips Lingo's own tools,
 * and outputs advisory text suggesting record_signal calls.
 *
 * Requirements: bash, jq must be available on the test system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, execFile } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Paths ────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const HOOK_PATH = join(PROJECT_ROOT, "hooks/prompt-learning-hook.sh");
const TEST_DIR = join(PROJECT_ROOT, "tests/hooks/.tmp-test-data");
const GLOSSARY_PATH = join(TEST_DIR, ".lingo/glossary.json");

// ── Test glossary fixture ────────────────────────────────────────────

const TEST_GLOSSARY = {
  version: "1.0.0",
  organization: "test-org",
  lastModified: "2026-04-01T00:00:00.000Z",
  terms: {
    "term-sprint-velocity": {
      id: "term-sprint-velocity",
      name: "Sprint Velocity",
      definition: "Team throughput metric per sprint",
      aliases: ["velocity", "sprint speed"],
      codeLocations: [],
      tags: [],
      source: { adapter: "manual" },
      confidence: "manual",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
    "term-auth": {
      id: "term-auth",
      name: "Authentication",
      definition: "User authentication system",
      aliases: ["auth", "login"],
      codeLocations: [],
      tags: [],
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
      tags: [],
      source: { adapter: "manual" },
      confidence: "manual",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  },
};

// ── Helper to run the hook ───────────────────────────────────────────

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(
  stdinInput: string,
  env?: Record<string, string>
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

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1 });
    });

    // Write input and close stdin so `cat` returns
    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

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

describe("prompt-learning-hook.sh", { timeout: 15000 }, () => {
  let jqAvailable = false;

  beforeAll(async () => {
    jqAvailable = await checkJqAvailable();
    if (!jqAvailable) return;

    // Create test directory and glossary
    await mkdir(join(TEST_DIR, ".lingo"), { recursive: true });
    await writeFile(GLOSSARY_PATH, JSON.stringify(TEST_GLOSSARY, null, 2));
  });

  afterAll(async () => {
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // Skip all tests if jq is not available
  beforeEach(({ skip }) => {
    if (!jqAvailable) {
      skip();
    }
  });

  describe("term detection", () => {
    it("detects term names in structured tool_result content", async () => {
      const input = makePostToolUseJson("Read", { file_path: "src/auth.ts" }, {
        content: [
          {
            type: "text",
            text: "This module implements the Authentication flow and tracks Sprint Velocity.",
          },
        ],
      });

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("record_signal");
      expect(result.stdout).toContain("term-sprint-velocity");
      expect(result.stdout).toContain("term-auth");
      expect(result.stdout).toContain('"prompt"');
    });

    it("detects alias matches (e.g. 'velocity', 'login')", async () => {
      const input = makePostToolUseJson("Bash", { command: "git diff" }, {
        content: [
          { type: "text", text: "Updated the login flow and velocity tracking" },
        ],
      });

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("term-auth");
      expect(result.stdout).toContain("term-sprint-velocity");
    });

    it("handles string tool_result (not structured content)", async () => {
      const input = makePostToolUseJson(
        "Grep",
        { pattern: "auth" },
        "Found auth references in billing module"
      );

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("term-auth");
      expect(result.stdout).toContain("term-billing");
    });

    it("matches terms case-insensitively", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [
          { type: "text", text: "SPRINT VELOCITY metric is shown here" },
        ],
      });

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("term-sprint-velocity");
    });

    it("also scans tool_input for term matches", async () => {
      const input = makePostToolUseJson(
        "Edit",
        { file_path: "src/billing.ts", description: "Fix billing engine" },
        { content: [{ type: "text", text: "File edited successfully" }] }
      );

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("term-billing");
    });

    it("outputs each matched term only once even with multiple alias hits", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [
          {
            type: "text",
            text: "Authentication module with auth service and login page",
          },
        ],
      });

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      // term-auth should appear exactly once
      const matches = result.stdout.match(/term-auth/g);
      expect(matches).toHaveLength(1);
    });

    it("respects word boundaries — does not match partial words", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [
          {
            type: "text",
            text: "authorize the user and authenticate credentials",
          },
        ],
      });

      const result = await runHook(input);

      // "auth" should NOT match inside "authorize" or "authenticate"
      expect(result.stdout).toBe("");
    });
  });

  describe("skipping Lingo own tools", () => {
    const lingoTools = [
      "query_context",
      "get_term",
      "add_term",
      "update_term",
      "remove_term",
      "list_terms",
      "find_by_file",
      "bootstrap",
      "suggest_code_changes",
      "create_from_text",
      "learn_from_pr",
      "record_signal",
      "list_adapters",
    ];

    for (const tool of lingoTools) {
      it(`skips Lingo tool: ${tool}`, async () => {
        const input = makePostToolUseJson(tool, {}, {
          content: [
            { type: "text", text: "Sprint Velocity Authentication Billing Engine" },
          ],
        });

        const result = await runHook(input);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
      });
    }

    it("skips tools with mcp__lingo prefix", async () => {
      const input = makePostToolUseJson(
        "mcp__lingo_mcp__query_context",
        {},
        "Sprint Velocity"
      );

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("skips tools with lingo__ prefix", async () => {
      const input = makePostToolUseJson(
        "lingo__record_signal",
        {},
        "Sprint Velocity"
      );

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("no glossary file", () => {
    it("exits silently when glossary file does not exist", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [{ type: "text", text: "Sprint Velocity" }],
      });

      const result = await runHook(input, {
        LINGO_GLOSSARY_PATH: "/tmp/nonexistent-glossary.json",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("no matches", () => {
    it("outputs nothing when no glossary terms match", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [
          {
            type: "text",
            text: "This is a completely unrelated piece of text about weather",
          },
        ],
      });

      const result = await runHook(input);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("edge cases", () => {
    it("handles empty stdin gracefully", async () => {
      const result = await runHook("");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("handles invalid JSON gracefully", async () => {
      const result = await runHook("not valid json at all");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("handles JSON without tool_name gracefully", async () => {
      const result = await runHook(JSON.stringify({ foo: "bar" }));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("includes the tool name in advisory output", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [{ type: "text", text: "Sprint Velocity" }],
      });

      const result = await runHook(input);

      expect(result.stdout).toContain("'Read'");
    });

    it("suggests signalType 'prompt' for all matches", async () => {
      const input = makePostToolUseJson("Read", {}, {
        content: [
          { type: "text", text: "Sprint Velocity and Authentication and Billing Engine" },
        ],
      });

      const result = await runHook(input);

      // Every record_signal suggestion line should use "prompt" signal type
      const suggestionLines = result.stdout
        .split("\n")
        .filter((l) => l.includes("record_signal("));
      expect(suggestionLines.length).toBeGreaterThanOrEqual(3);
      for (const line of suggestionLines) {
        expect(line).toContain('"prompt"');
      }
    });
  });
});
