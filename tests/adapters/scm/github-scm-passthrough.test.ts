/**
 * GitHub SCM Adapter Passthrough Tests
 *
 * Verifies that existing GitHub direct-call functionality (pr-learner module)
 * produces identical results when called through the SCMAdapter interface.
 *
 * The core assertion: for any GitHub operation, calling the direct function
 * (e.g., fetchPR, parsePRUrl) and calling the equivalent SCMAdapter method
 * (e.g., adapter.fetchPullRequest, adapter.parsePullRequestUrl) must yield
 * the same result.
 *
 * This validates that the adapter layer is a transparent pass-through with
 * no behavioral differences from the original direct-call code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubSCMAdapter } from "../../../src/adapters/scm/github-scm-adapter.js";
import type { SCMAdapter, PullRequestRef, PRInfo } from "../../../src/adapters/scm/types.js";
import { SCMAdapterError } from "../../../src/adapters/scm/types.js";
import {
  parsePRUrl,
  fetchPR,
  extractTermsFromPR,
  extractCodeLocations,
} from "../../../src/pr-learner/pr-learner.js";
import type { PRFileChange } from "../../../src/pr-learner/pr-learner.js";

// ─── Mock GitHub API Responses ────────────────────────────────────

/**
 * Standard mock PR API response matching GitHub's v3 API format.
 * Used by both direct-call and adapter-call tests to ensure identical inputs.
 */
const MOCK_PR_RESPONSE = {
  number: 42,
  title: "feat: Add user authentication flow",
  body: "## Authentication\nImplements OAuth2 login with Google and GitHub providers.\n## Test Plan\nUnit tests added.",
  html_url: "https://github.com/acme/webapp/pull/42",
  merged_at: "2025-03-15T10:30:00Z",
  labels: [{ name: "feature" }, { name: "auth" }],
};

/**
 * Standard mock files API response.
 */
const MOCK_FILES_RESPONSE = [
  {
    filename: "src/auth/oauth-provider.ts",
    status: "added",
    additions: 150,
    deletions: 0,
    patch: "@@ -0,0 +1,150 @@ ...",
  },
  {
    filename: "src/auth/login-handler.ts",
    status: "modified",
    additions: 45,
    deletions: 12,
    patch: "@@ -1,12 +1,45 @@ ...",
  },
  {
    filename: "tests/auth/oauth-provider.test.ts",
    status: "added",
    additions: 80,
    deletions: 0,
  },
  {
    filename: "src/legacy/old-auth.ts",
    status: "removed",
    additions: 0,
    deletions: 200,
  },
  {
    filename: "config/auth.json",
    status: "modified",
    additions: 5,
    deletions: 2,
  },
];

/**
 * Expected PRInfo after both direct-call and adapter-call process the mock.
 */
const EXPECTED_PR_INFO: PRInfo = {
  number: 42,
  title: "feat: Add user authentication flow",
  body: "## Authentication\nImplements OAuth2 login with Google and GitHub providers.\n## Test Plan\nUnit tests added.",
  url: "https://github.com/acme/webapp/pull/42",
  mergedAt: "2025-03-15T10:30:00Z",
  labels: ["feature", "auth"],
  changedFiles: [
    { filename: "src/auth/oauth-provider.ts", status: "added", additions: 150, deletions: 0, patch: "@@ -0,0 +1,150 @@ ..." },
    { filename: "src/auth/login-handler.ts", status: "modified", additions: 45, deletions: 12, patch: "@@ -1,12 +1,45 @@ ..." },
    { filename: "tests/auth/oauth-provider.test.ts", status: "added", additions: 80, deletions: 0, patch: undefined },
    { filename: "src/legacy/old-auth.ts", status: "removed", additions: 0, deletions: 200, patch: undefined },
    { filename: "config/auth.json", status: "modified", additions: 5, deletions: 2, patch: undefined },
  ],
};

// ─── Test Helpers ─────────────────────────────────────────────────

/**
 * Set up global fetch mock to simulate GitHub API responses.
 */
function mockGitHubApi() {
  const mockFetch = vi.fn<(...args: any[]) => Promise<Response>>();

  mockFetch.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    // PR details endpoint
    if (urlStr.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/) && !urlStr.includes("/files")) {
      return new Response(JSON.stringify(MOCK_PR_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // PR files endpoint
    if (urlStr.includes("/files")) {
      return new Response(JSON.stringify(MOCK_FILES_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Rate limit endpoint (for testConnection)
    if (urlStr.includes("/rate_limit")) {
      return new Response(
        JSON.stringify({ rate: { limit: 5000, remaining: 4999 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("GitHub SCM Adapter Passthrough Tests", () => {
  let adapter: SCMAdapter;
  let mockFetch: ReturnType<typeof mockGitHubApi>;

  beforeEach(() => {
    mockFetch = mockGitHubApi();
    adapter = new GitHubSCMAdapter({ token: "test-token-123" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── URL Parsing Passthrough ─────────────────────────────────────

  describe("URL parsing: direct-call vs adapter", () => {
    const validUrls = [
      "https://github.com/acme/webapp/pull/42",
      "https://github.com/facebook/react/pull/1",
      "https://github.com/org-name/repo-name/pull/99999",
    ];

    for (const url of validUrls) {
      it(`parsePRUrl("${url}") matches adapter.parsePullRequestUrl()`, () => {
        // Direct call (existing behavior)
        const directResult = parsePRUrl(url);

        // Adapter call (new interface)
        const adapterResult: PullRequestRef = adapter.parsePullRequestUrl(url);

        // Must produce identical results
        expect(adapterResult.owner).toBe(directResult.owner);
        expect(adapterResult.repo).toBe(directResult.repo);
        expect(adapterResult.number).toBe(directResult.prNumber);
      });
    }

    it("both reject invalid URLs with matching intent", () => {
      const invalidUrl = "https://gitlab.com/owner/repo/merge_requests/1";

      // Direct call throws generic Error
      expect(() => parsePRUrl(invalidUrl)).toThrow();

      // Adapter call throws SCMAdapterError with INVALID_URL code
      expect(() => adapter.parsePullRequestUrl(invalidUrl)).toThrow(SCMAdapterError);
      try {
        adapter.parsePullRequestUrl(invalidUrl);
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect((err as SCMAdapterError).code).toBe("INVALID_URL");
        expect((err as SCMAdapterError).adapterName).toBe("github");
      }
    });

    it("both reject empty URLs", () => {
      expect(() => parsePRUrl("")).toThrow();
      expect(() => adapter.parsePullRequestUrl("")).toThrow(SCMAdapterError);
    });

    it("both reject URLs without PR number", () => {
      expect(() => parsePRUrl("https://github.com/owner/repo")).toThrow();
      expect(() => adapter.parsePullRequestUrl("https://github.com/owner/repo")).toThrow(SCMAdapterError);
    });
  });

  // ─── Fetch PR Passthrough ────────────────────────────────────────

  describe("Fetch PR: direct-call vs adapter", () => {
    it("fetchPR() and adapter.fetchPullRequest() return identical PRInfo", async () => {
      // Direct call (existing behavior)
      const directResult = await fetchPR("acme", "webapp", 42, "test-token-123");

      // Adapter call (new interface)
      const adapterResult = await adapter.fetchPullRequest("acme", "webapp", 42);

      // Must produce identical PRInfo
      expect(adapterResult).toEqual(directResult);
    });

    it("adapter result matches expected PRInfo structure", async () => {
      const result = await adapter.fetchPullRequest("acme", "webapp", 42);

      expect(result.number).toBe(EXPECTED_PR_INFO.number);
      expect(result.title).toBe(EXPECTED_PR_INFO.title);
      expect(result.body).toBe(EXPECTED_PR_INFO.body);
      expect(result.url).toBe(EXPECTED_PR_INFO.url);
      expect(result.mergedAt).toBe(EXPECTED_PR_INFO.mergedAt);
      expect(result.labels).toEqual(EXPECTED_PR_INFO.labels);
      expect(result.changedFiles).toHaveLength(EXPECTED_PR_INFO.changedFiles.length);
    });

    it("adapter preserves all changed file details", async () => {
      const result = await adapter.fetchPullRequest("acme", "webapp", 42);

      // Check each file matches
      for (let i = 0; i < EXPECTED_PR_INFO.changedFiles.length; i++) {
        expect(result.changedFiles[i].filename).toBe(EXPECTED_PR_INFO.changedFiles[i].filename);
        expect(result.changedFiles[i].status).toBe(EXPECTED_PR_INFO.changedFiles[i].status);
        expect(result.changedFiles[i].additions).toBe(EXPECTED_PR_INFO.changedFiles[i].additions);
        expect(result.changedFiles[i].deletions).toBe(EXPECTED_PR_INFO.changedFiles[i].deletions);
      }
    });

    it("adapter passes correct auth headers via token", async () => {
      await adapter.fetchPullRequest("acme", "webapp", 42);

      // Verify fetch was called with the right auth header
      const calls = mockFetch.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        const options = call[1] as RequestInit;
        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer test-token-123");
        expect(headers["User-Agent"]).toBe("lingo-mcp-server");
      }
    });
  });

  // ─── fetchPullRequestByUrl Passthrough ───────────────────────────

  describe("fetchPullRequestByUrl: combines parse + fetch", () => {
    it("fetchPullRequestByUrl yields same result as manual parse → fetch", async () => {
      const url = "https://github.com/acme/webapp/pull/42";

      // Manual two-step (parse + fetch)
      const ref = adapter.parsePullRequestUrl(url);
      const twoStepResult = await adapter.fetchPullRequest(ref.owner, ref.repo, ref.number);

      // Convenience one-step
      const oneStepResult = await adapter.fetchPullRequestByUrl(url);

      // Must be identical
      expect(oneStepResult).toEqual(twoStepResult);
    });

    it("fetchPullRequestByUrl matches direct fetchPR after parsePRUrl", async () => {
      const url = "https://github.com/acme/webapp/pull/42";

      // Direct calls (existing behavior)
      const { owner, repo, prNumber } = parsePRUrl(url);
      const directResult = await fetchPR(owner, repo, prNumber, "test-token-123");

      // Adapter convenience method
      const adapterResult = await adapter.fetchPullRequestByUrl(url);

      expect(adapterResult).toEqual(directResult);
    });

    it("rejects invalid URLs before attempting fetch", async () => {
      await expect(
        adapter.fetchPullRequestByUrl("not-a-url"),
      ).rejects.toThrow(SCMAdapterError);
    });
  });

  // ─── Term Extraction Compatibility ──────────────────────────────

  describe("Domain logic works identically with adapter-fetched data", () => {
    it("extractTermsFromPR works with adapter-fetched PRInfo", async () => {
      // Fetch via adapter
      const prInfo = await adapter.fetchPullRequest("acme", "webapp", 42);

      // Apply domain logic (not part of adapter, but must work with its output)
      const terms = extractTermsFromPR(prInfo);

      // Same as calling domain logic on direct-fetched data
      const directPrInfo = await fetchPR("acme", "webapp", 42, "test-token-123");
      const directTerms = extractTermsFromPR(directPrInfo);

      expect(terms).toEqual(directTerms);
    });

    it("extractCodeLocations works with adapter-fetched file changes", async () => {
      // Fetch via adapter
      const prInfo = await adapter.fetchPullRequest("acme", "webapp", 42);

      // Apply domain logic
      const locations = extractCodeLocations(prInfo.changedFiles);

      // Same as calling domain logic on direct-fetched data
      const directPrInfo = await fetchPR("acme", "webapp", 42, "test-token-123");
      const directLocations = extractCodeLocations(directPrInfo.changedFiles);

      expect(locations).toEqual(directLocations);
    });

    it("full pipeline: parse → fetch → extract terms → extract locations", async () => {
      const url = "https://github.com/acme/webapp/pull/42";

      // Full adapter pipeline
      const prInfo = await adapter.fetchPullRequestByUrl(url);
      const terms = extractTermsFromPR(prInfo);
      const locations = extractCodeLocations(prInfo.changedFiles);

      // Full direct pipeline (existing behavior)
      const { owner, repo, prNumber } = parsePRUrl(url);
      const directPrInfo = await fetchPR(owner, repo, prNumber, "test-token-123");
      const directTerms = extractTermsFromPR(directPrInfo);
      const directLocations = extractCodeLocations(directPrInfo.changedFiles);

      // Results must be identical
      expect(terms).toEqual(directTerms);
      expect(locations).toEqual(directLocations);

      // Verify terms were actually extracted (sanity check)
      expect(terms.length).toBeGreaterThan(0);
      expect(terms[0].name).toBe("Add user authentication flow");

      // Verify code locations (removed files excluded, code files only)
      expect(locations.length).toBeGreaterThan(0);
      expect(locations.every((l) => l.filePath !== "src/legacy/old-auth.ts")).toBe(true);
    });
  });

  // ─── Error Handling Passthrough ─────────────────────────────────

  describe("Error handling: adapter wraps errors consistently", () => {
    it("wraps 404 errors as NOT_FOUND", async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      );

      try {
        await adapter.fetchPullRequest("owner", "repo", 999);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect((err as SCMAdapterError).code).toBe("NOT_FOUND");
        expect((err as SCMAdapterError).adapterName).toBe("github");
      }
    });

    it("wraps 401 errors as AUTH_FAILED", async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      );

      try {
        await adapter.fetchPullRequest("owner", "repo", 1);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect((err as SCMAdapterError).code).toBe("AUTH_FAILED");
      }
    });

    it("wraps 403 errors as AUTH_FAILED", async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
      );

      try {
        await adapter.fetchPullRequest("owner", "repo", 1);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect((err as SCMAdapterError).code).toBe("AUTH_FAILED");
      }
    });

    it("wraps 429 errors as RATE_LIMITED", async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ message: "rate limit" }), { status: 429 }),
      );

      try {
        await adapter.fetchPullRequest("owner", "repo", 1);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect((err as SCMAdapterError).code).toBe("RATE_LIMITED");
      }
    });

    it("preserves original error as cause", async () => {
      mockFetch.mockImplementation(async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      );

      try {
        await adapter.fetchPullRequest("owner", "repo", 999);
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as SCMAdapterError).cause).toBeDefined();
      }
    });
  });

  // ─── Adapter Metadata ──────────────────────────────────────────

  describe("Adapter metadata", () => {
    it("exposes name and displayName", () => {
      expect(adapter.name).toBe("github");
      expect(adapter.displayName).toBe("GitHub");
    });
  });

  // ─── testConnection ────────────────────────────────────────────

  describe("testConnection", () => {
    it("returns connected status on success", async () => {
      const status = await adapter.testConnection();

      expect(status.connected).toBe(true);
      expect(status.message).toContain("GitHub");
      expect(status.details?.authenticated).toBe(true);
    });

    it("returns disconnected status on failure", async () => {
      mockFetch.mockImplementation(async () =>
        new Response("Unauthorized", { status: 401 }),
      );

      const status = await adapter.testConnection();
      expect(status.connected).toBe(false);
    });

    it("handles network errors gracefully", async () => {
      mockFetch.mockImplementation(async () => {
        throw new Error("ECONNREFUSED");
      });

      const status = await adapter.testConnection();
      expect(status.connected).toBe(false);
      expect(status.message).toContain("ECONNREFUSED");
    });
  });

  // ─── Token Handling ────────────────────────────────────────────

  describe("Token handling", () => {
    it("works without a token (public repos)", async () => {
      const publicAdapter = new GitHubSCMAdapter({});
      // Clear LINGO_GITHUB_TOKEN env for this test
      const originalEnv = process.env.LINGO_GITHUB_TOKEN;
      delete process.env.LINGO_GITHUB_TOKEN;

      try {
        // Re-create with no env token
        const noTokenAdapter = new GitHubSCMAdapter({ token: undefined });
        await noTokenAdapter.fetchPullRequest("acme", "webapp", 42);

        // Verify no auth header sent
        const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
        const headers = (lastCall[1] as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
      } finally {
        if (originalEnv) {
          process.env.LINGO_GITHUB_TOKEN = originalEnv;
        }
      }
    });

    it("uses configured token over env var", async () => {
      process.env.LINGO_GITHUB_TOKEN = "env-token";
      const configuredAdapter = new GitHubSCMAdapter({ token: "config-token" });

      await configuredAdapter.fetchPullRequest("acme", "webapp", 42);

      const firstCall = mockFetch.mock.calls[0];
      const headers = (firstCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer config-token");

      delete process.env.LINGO_GITHUB_TOKEN;
    });
  });

  // ─── Interface Compliance ──────────────────────────────────────

  describe("SCMAdapter interface compliance", () => {
    it("implements all required interface methods", () => {
      // Verify all methods exist and are callable
      expect(typeof adapter.testConnection).toBe("function");
      expect(typeof adapter.parsePullRequestUrl).toBe("function");
      expect(typeof adapter.fetchPullRequest).toBe("function");
      expect(typeof adapter.fetchPullRequestByUrl).toBe("function");

      // Verify read-only properties
      expect(typeof adapter.name).toBe("string");
      expect(typeof adapter.displayName).toBe("string");
    });

    it("can be used polymorphically through SCMAdapter type", async () => {
      // Declare as interface type (not concrete class)
      const polymorphicAdapter: SCMAdapter = adapter;

      // All operations work through the interface
      const ref = polymorphicAdapter.parsePullRequestUrl(
        "https://github.com/acme/webapp/pull/42",
      );
      expect(ref.owner).toBe("acme");

      const pr = await polymorphicAdapter.fetchPullRequest("acme", "webapp", 42);
      expect(pr.number).toBe(42);

      const prByUrl = await polymorphicAdapter.fetchPullRequestByUrl(
        "https://github.com/acme/webapp/pull/42",
      );
      expect(prByUrl.number).toBe(42);
    });
  });
});
