/**
 * Tests for the Prompt Learning Hook advisory output.
 *
 * Validates that the hook outputs free-form advisory text on stdout
 * suggesting record_signal calls when glossary terms are detected
 * in tool output. The advisory output is purely informational —
 * no MCP coupling, no structured JSON, just human-readable suggestions.
 *
 * Requirements: bash, jq (available in CI and local dev environments)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Path to the hook script (relative to project root)
const HOOK_SCRIPT = resolve(__dirname, "../../hooks/prompt-learning-hook.sh");

/** Helper: run the hook with given stdin JSON and glossary path */
function runHook(
  stdinJson: string,
  glossaryPath: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", [HOOK_SCRIPT], {
      env: {
        ...process.env,
        LINGO_GLOSSARY_PATH: glossaryPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", reject);

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    // Write stdin and close it immediately
    proc.stdin.write(stdinJson);
    proc.stdin.end();
  });
}

/** Create a glossary JSON file at the given path */
async function createGlossary(
  glossaryPath: string,
  terms: Record<
    string,
    { id: string; name: string; aliases?: string[]; description: string }
  >
): Promise<void> {
  const glossary = {
    organization: "test-org",
    version: "1.0.0",
    terms: Object.fromEntries(
      Object.entries(terms).map(([key, t]) => [
        key,
        {
          ...t,
          aliases: t.aliases ?? [],
          codeLocations: [],
          coupling: { score: 0, sources: [] },
          confidence: "manual",
          tags: [],
        },
      ])
    ),
  };
  await writeFile(glossaryPath, JSON.stringify(glossary, null, 2));
}

describe("prompt-learning-hook advisory output", () => {
  let tempDir: string;
  let glossaryPath: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lingo-hook-advisory-"));
    glossaryPath = join(tempDir, "glossary.json");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("outputs advisory text suggesting record_signal for matched terms", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        description: "Handles user auth",
      },
    });

    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "src/auth-service.ts" },
      tool_result: "The Authentication Service handles login",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);

    // Advisory mentions the tool name
    expect(stdout).toContain("'Read'");

    // Advisory suggests record_signal call with correct termId
    expect(stdout).toContain('record_signal(termId: "auth-service"');

    // Advisory specifies signalType: "prompt" (hook-based coupling)
    expect(stdout).toContain('signalType: "prompt"');

    // Advisory includes the matched label for context
    expect(stdout).toContain("Authentication Service");

    // Advisory mentions coupling reinforcement purpose
    expect(stdout).toMatch(/coupling|reinforc|mapping/i);
  });

  it("outputs advisory for multiple matched terms", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        aliases: ["auth"],
        description: "Handles user auth",
      },
      "user-profile": {
        id: "user-profile",
        name: "User Profile",
        aliases: ["profile"],
        description: "Manages user profiles",
      },
    });

    const input = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/profile.ts" },
      tool_result:
        "Updated the auth module. User Profile page now shows status.",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);

    // Should suggest record_signal for both matched terms
    expect(stdout).toContain('record_signal(termId: "auth-service"');
    expect(stdout).toContain('record_signal(termId: "user-profile"');

    // Each suggestion should include signalType: "prompt"
    const promptMatches = stdout.match(/signalType: "prompt"/g);
    expect(promptMatches).not.toBeNull();
    expect(promptMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it("outputs nothing when no terms match", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        description: "Handles user auth",
      },
    });

    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "config.yml" },
      tool_result: "database_url: postgres://localhost/mydb",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("advisory uses free-form text, not structured JSON", async () => {
    await createGlossary(glossaryPath, {
      "billing": {
        id: "billing",
        name: "Billing",
        description: "Payment processing",
      },
    });

    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "grep Billing src/*.ts" },
      tool_result: "src/billing.ts: export class Billing { ... }",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);

    // Verify it's NOT structured JSON — it's free-form advisory text
    expect(() => JSON.parse(stdout)).toThrow();

    // Verify it reads like natural language guidance
    expect(stdout).toContain("record_signal");
    expect(stdout).toContain("Billing");
  });

  it("advisory includes the matched alias, not just the canonical name", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        aliases: ["AuthService", "auth-svc"],
        description: "Handles auth",
      },
    });

    const input = JSON.stringify({
      tool_name: "Grep",
      tool_input: { pattern: "auth-svc" },
      tool_result: "Found auth-svc in several files",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);
    // The advisory should mention what was matched (the alias)
    expect(stdout).toContain("auth-svc");
    expect(stdout).toContain('record_signal(termId: "auth-service"');
  });

  it("skips Lingo's own tools and outputs nothing", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        description: "Handles auth",
      },
    });

    const lingoTools = [
      "record_signal",
      "query_context",
      "get_term",
      "add_term",
      "list_adapters",
      "learn_from_pr",
    ];

    for (const toolName of lingoTools) {
      const input = JSON.stringify({
        tool_name: toolName,
        tool_input: {},
        tool_result: "Authentication Service was found",
      });

      const { stdout, exitCode } = await runHook(input, glossaryPath);
      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
    }
  });

  it("skips mcp__lingo prefixed tools", async () => {
    await createGlossary(glossaryPath, {
      "auth-service": {
        id: "auth-service",
        name: "Authentication Service",
        description: "Handles auth",
      },
    });

    const input = JSON.stringify({
      tool_name: "mcp__lingo__query_context",
      tool_input: {},
      tool_result: "Authentication Service info",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits silently when glossary file does not exist", async () => {
    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "auth.ts" },
      tool_result: "Authentication Service code",
    });

    const { stdout, exitCode } = await runHook(
      input,
      join(tempDir, "nonexistent-glossary.json")
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("exits silently on empty stdin", async () => {
    await createGlossary(glossaryPath, {
      "auth": {
        id: "auth",
        name: "Auth",
        description: "Auth module",
      },
    });

    const { stdout, exitCode } = await runHook("", glossaryPath);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("handles structured tool_result content blocks", async () => {
    await createGlossary(glossaryPath, {
      "payment-gateway": {
        id: "payment-gateway",
        name: "Payment Gateway",
        description: "Processes payments",
      },
    });

    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "src/payments.ts" },
      tool_result: {
        content: [
          { type: "text", text: "The Payment Gateway integration handles Stripe webhooks" },
          { type: "text", text: "See also: billing module" },
        ],
      },
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('record_signal(termId: "payment-gateway"');
    expect(stdout).toContain('signalType: "prompt"');
    expect(stdout).toContain("Payment Gateway");
  });

  it("advisory format includes actionable record_signal call signature", async () => {
    await createGlossary(glossaryPath, {
      "api-gateway": {
        id: "api-gateway",
        name: "API Gateway",
        description: "Routes API requests",
      },
    });

    const input = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "curl localhost:3000" },
      tool_result: "API Gateway responded with 200 OK",
    });

    const { stdout, exitCode } = await runHook(input, glossaryPath);

    expect(exitCode).toBe(0);

    // The advisory should include a complete, copy-pasteable call signature
    // Format: record_signal(termId: "...", signalType: "prompt")
    expect(stdout).toMatch(
      /record_signal\(termId: "api-gateway", signalType: "prompt"\)/
    );

    // It should also contextualize which label was matched
    expect(stdout).toMatch(/matched.*API Gateway/i);
  });
});
