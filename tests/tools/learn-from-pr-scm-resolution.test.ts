/**
 * Tests for learn_from_pr SCM Adapter Resolution
 *
 * Validates that the learn_from_pr tool resolves the SCM adapter from
 * the registry when available, and falls back to direct API calls when
 * no adapter is found.
 *
 * Covers:
 * - Registry-based adapter resolution from PR URL hostname
 * - Adapter is passed to learnFromPR when found in registry
 * - Fallback to direct GitHub API calls when no registry
 * - Fallback to direct calls when adapter not in registry
 * - resolveScmAdapterName utility function
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveScmAdapterName } from "../../src/tools/index.js";

// ─── resolveScmAdapterName tests ────────────────────────────────────

describe("resolveScmAdapterName", () => {
  it("resolves github.com to 'github'", () => {
    expect(resolveScmAdapterName("https://github.com/owner/repo/pull/1")).toBe("github");
  });

  it("resolves gitlab.com to 'gitlab'", () => {
    expect(resolveScmAdapterName("https://gitlab.com/ns/project/-/merge_requests/1")).toBe("gitlab");
  });

  it("resolves bitbucket.org to 'bitbucket'", () => {
    expect(resolveScmAdapterName("https://bitbucket.org/owner/repo/pull-requests/1")).toBe("bitbucket");
  });

  it("returns undefined for unknown hosts", () => {
    expect(resolveScmAdapterName("https://custom-git.example.com/owner/repo/pull/1")).toBeUndefined();
  });

  it("returns undefined for invalid URLs", () => {
    expect(resolveScmAdapterName("not-a-url")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveScmAdapterName("")).toBeUndefined();
  });

  it("handles GitHub Enterprise (not in default map)", () => {
    expect(resolveScmAdapterName("https://github.acme.com/owner/repo/pull/1")).toBeUndefined();
  });
});

// ─── learn_from_pr SCM adapter resolution integration ───────────────

describe("learn_from_pr — SCM adapter resolution from registry", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  // Standard mock PR API response matching GitHub's v3 API format
  const MOCK_PR_RESPONSE = {
    number: 42,
    title: "feat: Add user authentication flow",
    body: "## Authentication\nImplements OAuth2 login.\n## Test Plan\nUnit tests added.",
    html_url: "https://github.com/acme/webapp/pull/42",
    merged_at: "2025-03-15T10:30:00Z",
    labels: [{ name: "feature" }],
  };

  const MOCK_FILES_RESPONSE = [
    {
      filename: "src/auth/oauth-provider.ts",
      status: "added",
      additions: 150,
      deletions: 0,
      patch: "@@ -0,0 +1,150 @@ ...",
    },
  ];

  function mockGitHubApi() {
    const mock = vi.fn<(...args: any[]) => Promise<Response>>();
    mock.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/files")) {
        return new Response(JSON.stringify(MOCK_FILES_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/)) {
        return new Response(JSON.stringify(MOCK_PR_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  beforeEach(() => {
    mockFetch = mockGitHubApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses SCM adapter from registry when available", async () => {
    // Dynamically import to get fresh module references
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { JsonGlossaryStorage } = await import("../../src/storage/json-store.js");
    const { registerTools, TOOL_NAMES } = await import("../../src/tools/index.js");
    const { SCMAdapterRegistry } = await import("../../src/adapters/scm/registry.js");

    const tempDir = await mkdtemp(join(tmpdir(), "lingo-learn-pr-test-"));
    const storage = new JsonGlossaryStorage(join(tempDir, "glossary.json"));
    await storage.load("test-org");

    // Create SCM registry and register a mock adapter
    const scmRegistry = new SCMAdapterRegistry();

    // Track whether the mock adapter's fetchPullRequestByUrl was called
    const fetchPullRequestByUrlSpy = vi.fn().mockResolvedValue({
      number: 42,
      title: "feat: Add user authentication flow",
      body: "## Authentication\nImplements OAuth2 login.",
      url: "https://github.com/acme/webapp/pull/42",
      mergedAt: "2025-03-15T10:30:00Z",
      labels: ["feature"],
      changedFiles: [
        {
          filename: "src/auth/oauth-provider.ts",
          status: "added",
          additions: 150,
          deletions: 0,
          patch: "@@ -0,0 +1,150 @@ ...",
        },
      ],
    });

    const mockSCMAdapter = {
      name: "github",
      displayName: "GitHub",
      testConnection: vi.fn(),
      parsePullRequestUrl: vi.fn(),
      fetchPullRequest: vi.fn(),
      fetchPullRequestByUrl: fetchPullRequestByUrlSpy,
    };

    // Register the mock adapter instance in the registry
    scmRegistry.register(mockSCMAdapter);

    const server = new McpServer(
      { name: "lingo-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, storage, { scmAdapterRegistry: scmRegistry });

    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: TOOL_NAMES.LEARN_FROM_PR,
        arguments: {
          prUrl: "https://github.com/acme/webapp/pull/42",
          dryRun: true,
        },
      });

      // The mock adapter's fetchPullRequestByUrl should have been called
      expect(fetchPullRequestByUrlSpy).toHaveBeenCalledOnce();
      expect(fetchPullRequestByUrlSpy).toHaveBeenCalledWith(
        "https://github.com/acme/webapp/pull/42",
      );

      // The result should be successful
      const textContent = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      );
      const parsed = JSON.parse(textContent!.text!);
      expect(parsed.success).toBe(true);
      expect(parsed.dryRun).toBe(true);

      // Direct fetch should NOT have been called since adapter was used
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to direct API calls when no registry provided", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { JsonGlossaryStorage } = await import("../../src/storage/json-store.js");
    const { registerTools, TOOL_NAMES } = await import("../../src/tools/index.js");

    const tempDir = await mkdtemp(join(tmpdir(), "lingo-learn-pr-test-"));
    const storage = new JsonGlossaryStorage(join(tempDir, "glossary.json"));
    await storage.load("test-org");

    const server = new McpServer(
      { name: "lingo-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    // No scmAdapterRegistry passed — should fall back to direct calls
    registerTools(server, storage);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: TOOL_NAMES.LEARN_FROM_PR,
        arguments: {
          prUrl: "https://github.com/acme/webapp/pull/42",
          dryRun: true,
        },
      });

      // Direct fetch should have been called (fallback path)
      expect(mockFetch).toHaveBeenCalled();

      // Result should still be successful
      const textContent = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      );
      const parsed = JSON.parse(textContent!.text!);
      expect(parsed.success).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to direct API calls when adapter not found in registry", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { JsonGlossaryStorage } = await import("../../src/storage/json-store.js");
    const { registerTools, TOOL_NAMES } = await import("../../src/tools/index.js");
    const { SCMAdapterRegistry } = await import("../../src/adapters/scm/registry.js");

    const tempDir = await mkdtemp(join(tmpdir(), "lingo-learn-pr-test-"));
    const storage = new JsonGlossaryStorage(join(tempDir, "glossary.json"));
    await storage.load("test-org");

    // Create empty SCM registry (no adapters registered)
    const scmRegistry = new SCMAdapterRegistry();

    const server = new McpServer(
      { name: "lingo-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, storage, { scmAdapterRegistry: scmRegistry });

    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: TOOL_NAMES.LEARN_FROM_PR,
        arguments: {
          prUrl: "https://github.com/acme/webapp/pull/42",
          dryRun: true,
        },
      });

      // Direct fetch should have been called (no adapter in registry)
      expect(mockFetch).toHaveBeenCalled();

      const textContent = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      );
      const parsed = JSON.parse(textContent!.text!);
      expect(parsed.success).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to direct API calls for unrecognized URL hosts", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { JsonGlossaryStorage } = await import("../../src/storage/json-store.js");
    const { registerTools, TOOL_NAMES } = await import("../../src/tools/index.js");
    const { SCMAdapterRegistry } = await import("../../src/adapters/scm/registry.js");

    const tempDir = await mkdtemp(join(tmpdir(), "lingo-learn-pr-test-"));
    const storage = new JsonGlossaryStorage(join(tempDir, "glossary.json"));
    await storage.load("test-org");

    const scmRegistry = new SCMAdapterRegistry();

    const server = new McpServer(
      { name: "lingo-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, storage, { scmAdapterRegistry: scmRegistry });

    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Use a custom domain URL that still matches GitHub API format
      // (parsePRUrl from pr-learner only matches github.com, so this will error)
      const result = await client.callTool({
        name: TOOL_NAMES.LEARN_FROM_PR,
        arguments: {
          prUrl: "https://custom-scm.example.com/owner/repo/pull/1",
          dryRun: true,
        },
      });

      // Should fail because the fallback parsePRUrl doesn't recognize the URL
      const textContent = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      );
      const parsed = JSON.parse(textContent!.text!);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid GitHub PR URL");
    } finally {
      await client.close();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
