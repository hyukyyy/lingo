/**
 * LearnOptions.scmAdapter Tests
 *
 * Verifies that `learnFromPR` correctly handles the optional `scmAdapter` field:
 * - When `scmAdapter` is provided: uses adapter.fetchPullRequestByUrl()
 * - When `scmAdapter` is omitted: falls back to direct GitHub API calls
 * - Backward compatible: existing callers without scmAdapter work unchanged
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  learnFromPR,
  extractTermsFromPR,
  extractCodeLocations,
} from "../../src/pr-learner/pr-learner.js";
import type { LearnOptions, PRInfo } from "../../src/pr-learner/pr-learner.js";
import type { SCMAdapter } from "../../src/adapters/scm/types.js";
import { JsonGlossaryStorage } from "../../src/storage/json-store.js";

// ─── Mock PR Data ─────────────────────────────────────────────────

const MOCK_PR_INFO: PRInfo = {
  number: 99,
  title: "feat: Add payment processing module",
  body: "## Payment Gateway\nIntegrates Stripe for payment processing.\n## Test Plan\nE2E tests added.",
  url: "https://github.com/acme/shop/pull/99",
  mergedAt: "2025-06-01T12:00:00Z",
  labels: ["feature", "payments"],
  changedFiles: [
    {
      filename: "src/payments/stripe-provider.ts",
      status: "added",
      additions: 200,
      deletions: 0,
      patch: "@@ +1,200 @@",
    },
    {
      filename: "src/payments/checkout-handler.ts",
      status: "modified",
      additions: 50,
      deletions: 10,
    },
    {
      filename: "tests/payments/stripe.test.ts",
      status: "added",
      additions: 120,
      deletions: 0,
    },
  ],
};

const PR_URL = "https://github.com/acme/shop/pull/99";

// ─── GitHub API Mock (for fallback path) ──────────────────────────

const MOCK_GITHUB_PR_RESPONSE = {
  number: 99,
  title: "feat: Add payment processing module",
  body: "## Payment Gateway\nIntegrates Stripe for payment processing.\n## Test Plan\nE2E tests added.",
  html_url: "https://github.com/acme/shop/pull/99",
  merged_at: "2025-06-01T12:00:00Z",
  labels: [{ name: "feature" }, { name: "payments" }],
};

const MOCK_GITHUB_FILES_RESPONSE = [
  { filename: "src/payments/stripe-provider.ts", status: "added", additions: 200, deletions: 0, patch: "@@ +1,200 @@" },
  { filename: "src/payments/checkout-handler.ts", status: "modified", additions: 50, deletions: 10 },
  { filename: "tests/payments/stripe.test.ts", status: "added", additions: 120, deletions: 0 },
];

function mockGitHubApi() {
  const mockFetch = vi.fn<(...args: any[]) => Promise<Response>>();

  mockFetch.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.match(/\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/) && !urlStr.includes("/files")) {
      return new Response(JSON.stringify(MOCK_GITHUB_PR_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("/files")) {
      return new Response(JSON.stringify(MOCK_GITHUB_FILES_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

// ─── Mock SCM Adapter ─────────────────────────────────────────────

function createMockSCMAdapter(prInfo: PRInfo = MOCK_PR_INFO): SCMAdapter {
  return {
    name: "mock-scm",
    displayName: "Mock SCM",
    testConnection: vi.fn().mockResolvedValue({ connected: true, message: "OK" }),
    parsePullRequestUrl: vi.fn().mockReturnValue({ owner: "acme", repo: "shop", number: 99 }),
    fetchPullRequest: vi.fn().mockResolvedValue(prInfo),
    fetchPullRequestByUrl: vi.fn().mockResolvedValue(prInfo),
  };
}

// ─── Mock Storage ─────────────────────────────────────────────────

function createMockStorage() {
  const terms: any[] = [];
  return {
    searchTerms: vi.fn().mockReturnValue([]),
    addTerm: vi.fn().mockImplementation(async (input: any) => {
      const term = { id: `term-${terms.length + 1}`, ...input, codeLocations: input.codeLocations ?? [] };
      terms.push(term);
      return term;
    }),
    updateTerm: vi.fn().mockResolvedValue(undefined),
    _terms: terms,
  } as unknown as JsonGlossaryStorage;
}

// ─── Tests ────────────────────────────────────────────────────────

describe("LearnOptions.scmAdapter (optional adapter field)", () => {
  let storage: JsonGlossaryStorage;

  beforeEach(() => {
    storage = createMockStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── scmAdapter provided: uses adapter ───────────────────────────

  describe("when scmAdapter is provided", () => {
    it("uses adapter.fetchPullRequestByUrl() instead of direct calls", async () => {
      const adapter = createMockSCMAdapter();

      await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // Adapter's fetchPullRequestByUrl should have been called
      expect(adapter.fetchPullRequestByUrl).toHaveBeenCalledWith(PR_URL);
      expect(adapter.fetchPullRequestByUrl).toHaveBeenCalledTimes(1);
    });

    it("does NOT make direct GitHub API calls when adapter is provided", async () => {
      const mockFetch = mockGitHubApi();
      const adapter = createMockSCMAdapter();

      await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // global fetch should NOT have been called (adapter handles fetching)
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("correctly extracts terms from adapter-fetched PR data", async () => {
      const adapter = createMockSCMAdapter();

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // Terms should be extracted from the mock PR info
      expect(result.termsCreated).toBeGreaterThan(0);
      expect(result.terms.length).toBeGreaterThan(0);
      expect(result.terms[0].name).toBe("Add payment processing module");
      expect(result.terms[0].source).toBe(PR_URL);
    });

    it("correctly maps code locations from adapter-fetched file changes", async () => {
      const adapter = createMockSCMAdapter();

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // Code locations should be extracted from mock changed files
      expect(result.codeLocationsAdded).toBeGreaterThan(0);

      // Find a created term and check its code locations
      const createdTerm = result.terms.find((t) => t.action === "created");
      expect(createdTerm).toBeDefined();
      expect(createdTerm!.codeLocations.length).toBeGreaterThan(0);

      // Verify code file paths come from the mock PR data
      const filePaths = createdTerm!.codeLocations.map((cl) => cl.filePath);
      expect(filePaths).toContain("src/payments/stripe-provider.ts");
    });

    it("respects dryRun when using adapter", async () => {
      const adapter = createMockSCMAdapter();

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
        dryRun: true,
      });

      // Terms should be identified but not persisted
      expect(result.termsCreated).toBeGreaterThan(0);
      expect((storage.addTerm as any)).not.toHaveBeenCalled();
    });

    it("works with different SCM adapter implementations", async () => {
      // Simulate a GitLab-like adapter that returns same PRInfo shape
      const gitlabPR: PRInfo = {
        ...MOCK_PR_INFO,
        url: "https://gitlab.com/acme/shop/-/merge_requests/99",
      };
      const gitlabAdapter = createMockSCMAdapter(gitlabPR);
      (gitlabAdapter as any).name = "gitlab";
      (gitlabAdapter as any).displayName = "GitLab";

      const result = await learnFromPR(storage, {
        prUrl: "https://gitlab.com/acme/shop/-/merge_requests/99",
        scmAdapter: gitlabAdapter,
      });

      expect(gitlabAdapter.fetchPullRequestByUrl).toHaveBeenCalledWith(
        "https://gitlab.com/acme/shop/-/merge_requests/99",
      );
      expect(result.termsCreated).toBeGreaterThan(0);
    });

    it("propagates adapter errors without wrapping", async () => {
      const adapter = createMockSCMAdapter();
      const adapterError = new Error("SCM provider unreachable");
      (adapter.fetchPullRequestByUrl as any).mockRejectedValue(adapterError);

      await expect(
        learnFromPR(storage, { prUrl: PR_URL, scmAdapter: adapter }),
      ).rejects.toThrow("SCM provider unreachable");
    });

    it("ignores githubToken when scmAdapter is provided", async () => {
      // When an adapter is provided, the adapter manages its own auth.
      // The githubToken option should not be used.
      const adapter = createMockSCMAdapter();
      const mockFetch = mockGitHubApi();

      await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
        githubToken: "should-not-be-used",
      });

      // Adapter should be used, not direct fetch
      expect(adapter.fetchPullRequestByUrl).toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ─── scmAdapter omitted: fallback to direct calls ────────────────

  describe("when scmAdapter is omitted (backward compatibility)", () => {
    it("falls back to direct GitHub API calls", async () => {
      const mockFetch = mockGitHubApi();

      await learnFromPR(storage, {
        prUrl: PR_URL,
      });

      // global fetch should have been called (direct GitHub API)
      expect(mockFetch).toHaveBeenCalled();

      // Verify it called the GitHub API for the right PR
      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/repos/acme/shop/pulls/99"))).toBe(true);
    });

    it("uses githubToken for direct API calls", async () => {
      const mockFetch = mockGitHubApi();

      await learnFromPR(storage, {
        prUrl: PR_URL,
        githubToken: "my-token",
      });

      // Verify Authorization header was sent
      const calls = mockFetch.mock.calls;
      const firstCall = calls[0];
      const headers = (firstCall[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-token");
    });

    it("extracts terms same as before (no regression)", async () => {
      mockGitHubApi();

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
      });

      expect(result.termsCreated).toBeGreaterThan(0);
      expect(result.terms[0].name).toBe("Add payment processing module");
      expect(result.terms[0].source).toBe(PR_URL);
    });

    it("existing LearnOptions without scmAdapter still type-checks", () => {
      // This is a compile-time check — if scmAdapter were required,
      // this would fail at build time. The test existing proves backward compat.
      const options: LearnOptions = {
        prUrl: PR_URL,
        githubToken: "token",
        dryRun: false,
      };

      // scmAdapter should be undefined when not set
      expect(options.scmAdapter).toBeUndefined();
    });
  });

  // ─── Adapter vs. direct produces same results ────────────────────

  describe("adapter path and direct path produce equivalent results", () => {
    it("same PR data yields identical LearnResult from both paths", async () => {
      const mockFetch = mockGitHubApi();

      // Direct path (no adapter)
      const directResult = await learnFromPR(createMockStorage(), {
        prUrl: PR_URL,
      });

      // Adapter path (with mock adapter returning same data)
      // The mock adapter returns MOCK_PR_INFO which has the same content
      // as what the GitHub API mock returns
      const adapter = createMockSCMAdapter();
      const adapterResult = await learnFromPR(createMockStorage(), {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // Both should create the same terms
      expect(adapterResult.termsCreated).toBe(directResult.termsCreated);
      expect(adapterResult.terms.map((t) => t.name)).toEqual(
        directResult.terms.map((t) => t.name),
      );
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles adapter returning PR with no extractable terms", async () => {
      const emptyPR: PRInfo = {
        number: 1,
        title: "fix", // too short to extract
        body: "",
        url: PR_URL,
        mergedAt: null,
        labels: [],
        changedFiles: [],
      };
      const adapter = createMockSCMAdapter(emptyPR);

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      expect(result.termsCreated).toBe(0);
      expect(result.termsUpdated).toBe(0);
      expect(result.terms).toEqual([]);
    });

    it("handles adapter returning PR with only non-code files", async () => {
      const nonCodePR: PRInfo = {
        number: 2,
        title: "docs: Update README with setup instructions",
        body: "",
        url: PR_URL,
        mergedAt: null,
        labels: ["docs"],
        changedFiles: [
          { filename: "README.md", status: "modified", additions: 10, deletions: 5 },
          { filename: "docs/setup.md", status: "added", additions: 30, deletions: 0 },
        ],
      };
      const adapter = createMockSCMAdapter(nonCodePR);

      const result = await learnFromPR(storage, {
        prUrl: PR_URL,
        scmAdapter: adapter,
      });

      // Term should be created (from title) but with no code locations
      expect(result.termsCreated).toBeGreaterThan(0);
      expect(result.codeLocationsAdded).toBe(0);
    });

    it("scmAdapter field is truly optional (undefined by default)", () => {
      const options: LearnOptions = { prUrl: PR_URL };
      expect(options.scmAdapter).toBeUndefined();
      expect("scmAdapter" in options).toBe(false);
    });
  });
});
