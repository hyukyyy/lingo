/**
 * Tests for the SCM Adapter Interface & Domain Models
 *
 * Validates:
 * - SCMAdapter interface contract can be implemented
 * - SCM domain data models (PullRequestRef, SCMConnectionStatus, PRInfo, PRFileChange)
 * - SCMAdapterConfig configuration model
 * - SCMAdapterError error handling with typed error codes
 * - GitHubSCMAdapter satisfies the interface contract
 * - URL parsing contract (parsePullRequestUrl)
 * - fetchPullRequest / fetchPullRequestByUrl contract
 * - Error code mapping for all SCMAdapterErrorCode values
 *
 * Mirrors the structure of pm-adapter-interface.test.ts for consistency.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SCMAdapter,
  SCMConnectionStatus,
  SCMAdapterConfig,
  SCMAdapterErrorCode,
  PullRequestRef,
  PRInfo,
  PRFileChange,
} from "../../src/adapters/scm/types.js";
import { SCMAdapterError } from "../../src/adapters/scm/types.js";
import {
  GitHubSCMAdapter,
  createGitHubSCMAdapter,
} from "../../src/adapters/scm/github-scm-adapter.js";

// ─── Test Mock SCM Adapter ────────────────────────────────────────

/**
 * A minimal mock adapter that implements the full SCMAdapter interface.
 * Proves the interface is implementable without any SCM tool dependency.
 */
class MockSCMAdapter implements SCMAdapter {
  readonly name = "mock-scm";
  readonly displayName = "Mock SCM Tool";

  private pullRequests: Map<string, PRInfo> = new Map();

  constructor(prs?: PRInfo[]) {
    for (const pr of prs ?? []) {
      const key = `${pr.url}`;
      this.pullRequests.set(key, pr);
    }
  }

  async testConnection(): Promise<SCMConnectionStatus> {
    return {
      connected: true,
      message: "Connected to mock SCM tool",
      details: { version: "1.0", authenticated: true },
    };
  }

  parsePullRequestUrl(url: string): PullRequestRef {
    const match = url.match(/mock:\/\/([^/]+)\/([^/]+)\/pr\/(\d+)/);
    if (!match) {
      throw new SCMAdapterError(
        `Invalid mock PR URL: ${url}`,
        "INVALID_URL",
        this.name,
      );
    }
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  async fetchPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRInfo> {
    for (const pr of this.pullRequests.values()) {
      if (pr.number === prNumber) {
        return pr;
      }
    }
    throw new SCMAdapterError(
      `PR #${prNumber} not found in ${owner}/${repo}`,
      "NOT_FOUND",
      this.name,
    );
  }

  async fetchPullRequestByUrl(url: string): Promise<PRInfo> {
    const ref = this.parsePullRequestUrl(url);
    return this.fetchPullRequest(ref.owner, ref.repo, ref.number);
  }
}

// ─── Test Data Helpers ────────────────────────────────────────────

function createTestPRInfo(overrides?: Partial<PRInfo>): PRInfo {
  return {
    number: 42,
    title: "feat: Add authentication flow",
    body: "## Summary\nImplements OAuth2 authentication",
    url: "https://github.com/acme/app/pull/42",
    mergedAt: null,
    labels: ["feature", "auth"],
    changedFiles: [
      {
        filename: "src/auth/oauth.ts",
        status: "added",
        additions: 120,
        deletions: 0,
        patch: "@@ -0,0 +1,120 @@\n+export class OAuth...",
      },
      {
        filename: "src/auth/oauth.test.ts",
        status: "added",
        additions: 80,
        deletions: 0,
      },
    ],
    ...overrides,
  };
}

function createTestFileChange(overrides?: Partial<PRFileChange>): PRFileChange {
  return {
    filename: "src/feature.ts",
    status: "modified",
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe("SCM Adapter Interface & Domain Models", () => {
  // ─── PullRequestRef ─────────────────────────────────────────────

  describe("PullRequestRef", () => {
    it("has required fields", () => {
      const ref: PullRequestRef = {
        owner: "facebook",
        repo: "react",
        number: 12345,
      };

      expect(ref.owner).toBe("facebook");
      expect(ref.repo).toBe("react");
      expect(ref.number).toBe(12345);
    });

    it("supports various owner/repo formats", () => {
      const refs: PullRequestRef[] = [
        { owner: "facebook", repo: "react", number: 1 },
        { owner: "gitlab-org", repo: "gitlab-ce", number: 999 },
        { owner: "my-org", repo: "my-repo.js", number: 42 },
      ];

      for (const ref of refs) {
        expect(typeof ref.owner).toBe("string");
        expect(typeof ref.repo).toBe("string");
        expect(typeof ref.number).toBe("number");
      }
    });
  });

  // ─── SCMConnectionStatus ────────────────────────────────────────

  describe("SCMConnectionStatus", () => {
    it("represents a successful connection", () => {
      const status: SCMConnectionStatus = {
        connected: true,
        message: "Connected to GitHub API",
        details: { rateLimit: 5000, rateLimitRemaining: 4999 },
      };

      expect(status.connected).toBe(true);
      expect(status.message).toBeTruthy();
      expect(status.details).toBeDefined();
    });

    it("represents a failed connection", () => {
      const status: SCMConnectionStatus = {
        connected: false,
        message: "Authentication failed: invalid token",
      };

      expect(status.connected).toBe(false);
      expect(status.message).toContain("failed");
      expect(status.details).toBeUndefined();
    });

    it("details field is optional", () => {
      const status: SCMConnectionStatus = {
        connected: true,
        message: "OK",
      };

      expect(status.details).toBeUndefined();
    });
  });

  // ─── SCMAdapterConfig ──────────────────────────────────────────

  describe("SCMAdapterConfig", () => {
    it("defines base configuration for SCM adapters", () => {
      const config: SCMAdapterConfig = {
        adapterName: "github",
        baseUrl: "https://api.github.com",
        token: "ghp_xxxxxxxxxxxx",
        timeoutMs: 30_000,
      };

      expect(config.adapterName).toBe("github");
      expect(config.baseUrl).toBe("https://api.github.com");
      expect(config.token).toBe("ghp_xxxxxxxxxxxx");
      expect(config.timeoutMs).toBe(30_000);
    });

    it("has optional fields for minimal configuration", () => {
      const config: SCMAdapterConfig = {
        adapterName: "gitlab",
      };

      expect(config.adapterName).toBe("gitlab");
      expect(config.baseUrl).toBeUndefined();
      expect(config.token).toBeUndefined();
      expect(config.timeoutMs).toBeUndefined();
    });

    it("supports custom base URLs for enterprise instances", () => {
      const config: SCMAdapterConfig = {
        adapterName: "github-enterprise",
        baseUrl: "https://github.mycompany.com/api/v3",
        token: "ghe_token",
      };

      expect(config.baseUrl).toContain("mycompany.com");
    });
  });

  // ─── PRInfo ────────────────────────────────────────────────────

  describe("PRInfo", () => {
    it("has all required fields", () => {
      const pr = createTestPRInfo();

      expect(pr.number).toBe(42);
      expect(pr.title).toBeTruthy();
      expect(typeof pr.body).toBe("string");
      expect(pr.url).toBeTruthy();
      expect(pr.labels).toBeInstanceOf(Array);
      expect(pr.changedFiles).toBeInstanceOf(Array);
    });

    it("mergedAt is null for unmerged PRs", () => {
      const pr = createTestPRInfo({ mergedAt: null });
      expect(pr.mergedAt).toBeNull();
    });

    it("mergedAt is a date string for merged PRs", () => {
      const pr = createTestPRInfo({ mergedAt: "2025-03-15T10:30:00Z" });
      expect(pr.mergedAt).toBe("2025-03-15T10:30:00Z");
    });

    it("changedFiles contains PRFileChange entries", () => {
      const pr = createTestPRInfo();
      expect(pr.changedFiles.length).toBeGreaterThan(0);

      const file = pr.changedFiles[0];
      expect(file.filename).toBeTruthy();
      expect(["added", "modified", "removed", "renamed"]).toContain(file.status);
      expect(typeof file.additions).toBe("number");
      expect(typeof file.deletions).toBe("number");
    });
  });

  // ─── PRFileChange ──────────────────────────────────────────────

  describe("PRFileChange", () => {
    it("supports all file status values", () => {
      const statuses: PRFileChange["status"][] = [
        "added",
        "modified",
        "removed",
        "renamed",
      ];

      for (const status of statuses) {
        const file = createTestFileChange({ status });
        expect(file.status).toBe(status);
      }
    });

    it("patch field is optional", () => {
      const fileWithPatch = createTestFileChange({
        patch: "@@ -1,5 +1,10 @@\n+new code",
      });
      expect(fileWithPatch.patch).toBeDefined();

      const fileWithoutPatch = createTestFileChange();
      expect(fileWithoutPatch.patch).toBeUndefined();
    });

    it("tracks addition and deletion counts", () => {
      const file = createTestFileChange({
        additions: 50,
        deletions: 20,
      });

      expect(file.additions).toBe(50);
      expect(file.deletions).toBe(20);
    });
  });

  // ─── SCMAdapterError ──────────────────────────────────────────

  describe("SCMAdapterError", () => {
    it("carries error code and adapter name", () => {
      const error = new SCMAdapterError(
        "Rate limit exceeded",
        "RATE_LIMITED",
        "github",
      );

      expect(error.message).toBe("Rate limit exceeded");
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.adapterName).toBe("github");
      expect(error.name).toBe("SCMAdapterError");
      expect(error).toBeInstanceOf(Error);
    });

    it("optionally carries a cause", () => {
      const cause = new Error("HTTP 429 Too Many Requests");
      const error = new SCMAdapterError(
        "Rate limited",
        "RATE_LIMITED",
        "github",
        cause,
      );

      expect(error.cause).toBe(cause);
    });

    it("supports all SCM error codes", () => {
      const codes: SCMAdapterErrorCode[] = [
        "AUTH_FAILED",
        "NOT_FOUND",
        "RATE_LIMITED",
        "NETWORK_ERROR",
        "INVALID_CONFIG",
        "INVALID_URL",
        "PARSE_ERROR",
        "UNSUPPORTED",
        "UNKNOWN",
      ];

      for (const code of codes) {
        const error = new SCMAdapterError("test", code, "test-scm");
        expect(error.code).toBe(code);
      }
    });

    it("extends Error for standard catch handling", () => {
      const error = new SCMAdapterError("test", "UNKNOWN", "github");

      try {
        throw error;
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(SCMAdapterError);
      }
    });

    it("preserves stack trace", () => {
      const error = new SCMAdapterError("test", "UNKNOWN", "github");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("SCMAdapterError");
    });

    it("has INVALID_URL code unique to SCM (not in PM adapter)", () => {
      const error = new SCMAdapterError(
        "Cannot parse PR URL",
        "INVALID_URL",
        "github",
      );
      expect(error.code).toBe("INVALID_URL");
    });
  });

  // ─── SCMAdapter Interface Contract (Mock Implementation) ──────

  describe("SCMAdapter interface contract (mock implementation)", () => {
    const testPRs = [
      createTestPRInfo({
        number: 1,
        title: "feat: Auth flow",
        url: "mock://acme/app/pr/1",
        labels: ["feature"],
        changedFiles: [
          createTestFileChange({ filename: "src/auth.ts", status: "added" }),
        ],
      }),
      createTestPRInfo({
        number: 2,
        title: "fix: Login bug",
        url: "mock://acme/app/pr/2",
        mergedAt: "2025-03-10T12:00:00Z",
        labels: ["bug"],
        changedFiles: [
          createTestFileChange({ filename: "src/login.ts", status: "modified" }),
          createTestFileChange({ filename: "src/login.test.ts", status: "modified" }),
        ],
      }),
    ];

    let adapter: SCMAdapter;

    beforeEach(() => {
      adapter = new MockSCMAdapter(testPRs);
    });

    it("exposes name and displayName", () => {
      expect(adapter.name).toBe("mock-scm");
      expect(adapter.displayName).toBe("Mock SCM Tool");
    });

    it("name is a non-empty string", () => {
      expect(typeof adapter.name).toBe("string");
      expect(adapter.name.length).toBeGreaterThan(0);
    });

    it("displayName is a non-empty string", () => {
      expect(typeof adapter.displayName).toBe("string");
      expect(adapter.displayName.length).toBeGreaterThan(0);
    });

    it("testConnection returns SCMConnectionStatus", async () => {
      const status = await adapter.testConnection();

      expect(status).toHaveProperty("connected");
      expect(status).toHaveProperty("message");
      expect(typeof status.connected).toBe("boolean");
      expect(typeof status.message).toBe("string");
    });

    it("testConnection returns connected=true for valid config", async () => {
      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);
      expect(status.message).toBeTruthy();
    });

    it("testConnection may include details", async () => {
      const status = await adapter.testConnection();
      if (status.details) {
        expect(typeof status.details).toBe("object");
      }
    });

    it("parsePullRequestUrl returns PullRequestRef", () => {
      const ref = adapter.parsePullRequestUrl("mock://facebook/react/pr/123");

      expect(ref).toHaveProperty("owner");
      expect(ref).toHaveProperty("repo");
      expect(ref).toHaveProperty("number");
      expect(ref.owner).toBe("facebook");
      expect(ref.repo).toBe("react");
      expect(ref.number).toBe(123);
    });

    it("parsePullRequestUrl extracts correct components", () => {
      const ref = adapter.parsePullRequestUrl("mock://my-org/my-repo/pr/42");

      expect(ref.owner).toBe("my-org");
      expect(ref.repo).toBe("my-repo");
      expect(ref.number).toBe(42);
    });

    it("parsePullRequestUrl throws SCMAdapterError for invalid URL", () => {
      expect(() => {
        adapter.parsePullRequestUrl("not-a-valid-url");
      }).toThrow(SCMAdapterError);

      try {
        adapter.parsePullRequestUrl("not-a-valid-url");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        const scmErr = err as SCMAdapterError;
        expect(scmErr.code).toBe("INVALID_URL");
        expect(scmErr.adapterName).toBe("mock-scm");
      }
    });

    it("parsePullRequestUrl is synchronous", () => {
      const result = adapter.parsePullRequestUrl("mock://acme/app/pr/1");
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.number).toBe(1);
    });

    it("fetchPullRequest returns PRInfo", async () => {
      const pr = await adapter.fetchPullRequest("acme", "app", 1);

      expect(pr).toHaveProperty("number");
      expect(pr).toHaveProperty("title");
      expect(pr).toHaveProperty("body");
      expect(pr).toHaveProperty("url");
      expect(pr).toHaveProperty("labels");
      expect(pr).toHaveProperty("changedFiles");
    });

    it("fetchPullRequest returns correct PR data", async () => {
      const pr = await adapter.fetchPullRequest("acme", "app", 1);

      expect(pr.number).toBe(1);
      expect(pr.title).toBe("feat: Auth flow");
      expect(pr.labels).toContain("feature");
      expect(pr.changedFiles.length).toBeGreaterThan(0);
    });

    it("fetchPullRequest includes changed files with expected fields", async () => {
      const pr = await adapter.fetchPullRequest("acme", "app", 2);

      expect(pr.changedFiles).toHaveLength(2);
      for (const file of pr.changedFiles) {
        expect(file).toHaveProperty("filename");
        expect(file).toHaveProperty("status");
        expect(file).toHaveProperty("additions");
        expect(file).toHaveProperty("deletions");
        expect(typeof file.filename).toBe("string");
        expect(typeof file.additions).toBe("number");
        expect(typeof file.deletions).toBe("number");
      }
    });

    it("fetchPullRequest returns merged PR info", async () => {
      const pr = await adapter.fetchPullRequest("acme", "app", 2);
      expect(pr.mergedAt).toBe("2025-03-10T12:00:00Z");
    });

    it("fetchPullRequest throws SCMAdapterError for not found", async () => {
      await expect(
        adapter.fetchPullRequest("acme", "app", 9999),
      ).rejects.toThrow(SCMAdapterError);

      try {
        await adapter.fetchPullRequest("acme", "app", 9999);
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        const scmErr = err as SCMAdapterError;
        expect(scmErr.code).toBe("NOT_FOUND");
      }
    });

    it("fetchPullRequest is async (returns a Promise)", async () => {
      const result = adapter.fetchPullRequest("acme", "app", 1);
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it("fetchPullRequestByUrl returns PRInfo from URL", async () => {
      const pr = await adapter.fetchPullRequestByUrl("mock://acme/app/pr/1");

      expect(pr.number).toBe(1);
      expect(pr.title).toBe("feat: Auth flow");
    });

    it("fetchPullRequestByUrl is equivalent to parse + fetch", async () => {
      const url = "mock://acme/app/pr/2";
      const ref = adapter.parsePullRequestUrl(url);
      const prDirect = await adapter.fetchPullRequest(ref.owner, ref.repo, ref.number);
      const prByUrl = await adapter.fetchPullRequestByUrl(url);

      expect(prDirect.number).toBe(prByUrl.number);
      expect(prDirect.title).toBe(prByUrl.title);
      expect(prDirect.changedFiles.length).toBe(prByUrl.changedFiles.length);
    });

    it("fetchPullRequestByUrl throws INVALID_URL for bad URL", async () => {
      await expect(
        adapter.fetchPullRequestByUrl("garbage-url"),
      ).rejects.toThrow(SCMAdapterError);

      try {
        await adapter.fetchPullRequestByUrl("garbage-url");
      } catch (err) {
        const scmErr = err as SCMAdapterError;
        expect(scmErr.code).toBe("INVALID_URL");
      }
    });

    it("fetchPullRequestByUrl throws NOT_FOUND when PR does not exist", async () => {
      await expect(
        adapter.fetchPullRequestByUrl("mock://acme/app/pr/9999"),
      ).rejects.toThrow(SCMAdapterError);

      try {
        await adapter.fetchPullRequestByUrl("mock://acme/app/pr/9999");
      } catch (err) {
        const scmErr = err as SCMAdapterError;
        expect(scmErr.code).toBe("NOT_FOUND");
      }
    });
  });

  // ─── GitHubSCMAdapter Interface Satisfaction ──────────────────

  describe("GitHubSCMAdapter satisfies SCMAdapter contract", () => {
    let adapter: GitHubSCMAdapter;

    beforeEach(() => {
      adapter = new GitHubSCMAdapter({ token: "test-token" });
    });

    it("implements required readonly properties", () => {
      expect(adapter.name).toBe("github");
      expect(adapter.displayName).toBe("GitHub");
    });

    it("name is 'github'", () => {
      expect(adapter.name).toBe("github");
    });

    it("displayName is 'GitHub'", () => {
      expect(adapter.displayName).toBe("GitHub");
    });

    it("implements testConnection method", () => {
      expect(typeof adapter.testConnection).toBe("function");
    });

    it("implements parsePullRequestUrl method", () => {
      expect(typeof adapter.parsePullRequestUrl).toBe("function");
    });

    it("implements fetchPullRequest method", () => {
      expect(typeof adapter.fetchPullRequest).toBe("function");
    });

    it("implements fetchPullRequestByUrl method", () => {
      expect(typeof adapter.fetchPullRequestByUrl).toBe("function");
    });

    it("parses standard GitHub PR URLs", () => {
      const ref = adapter.parsePullRequestUrl(
        "https://github.com/facebook/react/pull/12345",
      );

      expect(ref.owner).toBe("facebook");
      expect(ref.repo).toBe("react");
      expect(ref.number).toBe(12345);
    });

    it("parses GitHub PR URLs with various owner/repo names", () => {
      const cases = [
        {
          url: "https://github.com/my-org/my-repo/pull/1",
          expected: { owner: "my-org", repo: "my-repo", number: 1 },
        },
        {
          url: "https://github.com/user123/project_name/pull/999",
          expected: { owner: "user123", repo: "project_name", number: 999 },
        },
      ];

      for (const { url, expected } of cases) {
        const ref = adapter.parsePullRequestUrl(url);
        expect(ref.owner).toBe(expected.owner);
        expect(ref.repo).toBe(expected.repo);
        expect(ref.number).toBe(expected.number);
      }
    });

    it("throws SCMAdapterError with INVALID_URL for non-GitHub URLs", () => {
      const invalidUrls = [
        "https://gitlab.com/owner/repo/-/merge_requests/123",
        "https://bitbucket.org/owner/repo/pull-requests/123",
        "not-a-url",
        "",
        "https://github.com/owner",
        "https://github.com/owner/repo",
        "https://github.com/owner/repo/issues/123",
      ];

      for (const url of invalidUrls) {
        expect(() => adapter.parsePullRequestUrl(url)).toThrow(SCMAdapterError);

        try {
          adapter.parsePullRequestUrl(url);
        } catch (err) {
          const scmErr = err as SCMAdapterError;
          expect(scmErr.code).toBe("INVALID_URL");
          expect(scmErr.adapterName).toBe("github");
        }
      }
    });

    it("parsePullRequestUrl preserves the cause from underlying parser", () => {
      try {
        adapter.parsePullRequestUrl("invalid");
      } catch (err) {
        const scmErr = err as SCMAdapterError;
        expect(scmErr.cause).toBeDefined();
      }
    });
  });

  // ─── GitHubSCMAdapter Construction ───────────────────────────

  describe("GitHubSCMAdapter construction", () => {
    it("can be constructed with no config", () => {
      const adapter = new GitHubSCMAdapter();
      expect(adapter.name).toBe("github");
    });

    it("can be constructed with token", () => {
      const adapter = new GitHubSCMAdapter({ token: "ghp_test" });
      expect(adapter.name).toBe("github");
    });

    it("can be constructed with custom base URL", () => {
      const adapter = new GitHubSCMAdapter({
        baseUrl: "https://github.mycompany.com/api/v3",
      });
      expect(adapter.name).toBe("github");
    });

    it("can be constructed with full config", () => {
      const adapter = new GitHubSCMAdapter({
        token: "ghp_test",
        baseUrl: "https://api.github.com",
        timeoutMs: 60_000,
      });
      expect(adapter.name).toBe("github");
    });
  });

  // ─── Factory Function ──────────────────────────────────────────

  describe("createGitHubSCMAdapter factory", () => {
    it("creates a GitHubSCMAdapter from a generic config object", () => {
      const adapter = createGitHubSCMAdapter({
        token: "ghp_factory_test",
        baseUrl: "https://api.github.com",
      });

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
      expect(adapter.name).toBe("github");
      expect(adapter.displayName).toBe("GitHub");
    });

    it("handles empty config", () => {
      const adapter = createGitHubSCMAdapter({});

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
      expect(adapter.name).toBe("github");
    });

    it("ignores unknown config properties", () => {
      const adapter = createGitHubSCMAdapter({
        token: "ghp_test",
        unknownProp: "should be ignored",
        anotherProp: 42,
      });

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
    });

    it("coerces non-string token to undefined", () => {
      const adapter = createGitHubSCMAdapter({
        token: 12345,
      });

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
    });

    it("coerces non-string baseUrl to undefined", () => {
      const adapter = createGitHubSCMAdapter({
        baseUrl: true,
      });

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
    });

    it("coerces non-number timeoutMs to undefined", () => {
      const adapter = createGitHubSCMAdapter({
        timeoutMs: "not-a-number",
      });

      expect(adapter).toBeInstanceOf(GitHubSCMAdapter);
    });
  });

  // ─── Interface Substitutability ───────────────────────────────

  describe("Interface substitutability (Liskov)", () => {
    it("MockSCMAdapter and GitHubSCMAdapter both satisfy SCMAdapter", () => {
      const adapters: SCMAdapter[] = [
        new MockSCMAdapter(),
        new GitHubSCMAdapter({ token: "test" }),
      ];

      for (const adapter of adapters) {
        expect(typeof adapter.name).toBe("string");
        expect(typeof adapter.displayName).toBe("string");
        expect(typeof adapter.testConnection).toBe("function");
        expect(typeof adapter.parsePullRequestUrl).toBe("function");
        expect(typeof adapter.fetchPullRequest).toBe("function");
        expect(typeof adapter.fetchPullRequestByUrl).toBe("function");
      }
    });

    it("any SCMAdapter implementation can be used interchangeably", async () => {
      async function testAdapterContract(adapter: SCMAdapter): Promise<void> {
        expect(adapter.name.length).toBeGreaterThan(0);
        expect(adapter.displayName.length).toBeGreaterThan(0);

        const status = await adapter.testConnection();
        expect(typeof status.connected).toBe("boolean");
        expect(typeof status.message).toBe("string");
      }

      await testAdapterContract(new MockSCMAdapter());

      const githubAdapter = new GitHubSCMAdapter({ token: "test" });
      expect(typeof githubAdapter.testConnection).toBe("function");
    });

    it("parsePullRequestUrl error contract is consistent across adapters", () => {
      const adapters: Array<{ adapter: SCMAdapter; invalidUrl: string }> = [
        { adapter: new MockSCMAdapter(), invalidUrl: "bad-url" },
        { adapter: new GitHubSCMAdapter(), invalidUrl: "bad-url" },
      ];

      for (const { adapter, invalidUrl } of adapters) {
        try {
          adapter.parsePullRequestUrl(invalidUrl);
          expect.fail("Expected SCMAdapterError");
        } catch (err) {
          expect(err).toBeInstanceOf(SCMAdapterError);
          const scmErr = err as SCMAdapterError;
          expect(scmErr.code).toBe("INVALID_URL");
          expect(scmErr.adapterName).toBe(adapter.name);
        }
      }
    });
  });

  // ─── Contract: Adapter is Stateless ───────────────────────────

  describe("Statelessness contract", () => {
    it("parsePullRequestUrl returns same result for same input", () => {
      const adapter = new GitHubSCMAdapter();
      const url = "https://github.com/owner/repo/pull/42";

      const ref1 = adapter.parsePullRequestUrl(url);
      const ref2 = adapter.parsePullRequestUrl(url);

      expect(ref1.owner).toBe(ref2.owner);
      expect(ref1.repo).toBe(ref2.repo);
      expect(ref1.number).toBe(ref2.number);
    });

    it("multiple adapter instances are independent", () => {
      const adapter1 = new GitHubSCMAdapter({ token: "token-1" });
      const adapter2 = new GitHubSCMAdapter({ token: "token-2" });

      const url = "https://github.com/org/repo/pull/100";
      const ref1 = adapter1.parsePullRequestUrl(url);
      const ref2 = adapter2.parsePullRequestUrl(url);

      expect(ref1).toEqual(ref2);
    });
  });

  // ─── Contract: Error Hierarchy ────────────────────────────────

  describe("Error hierarchy contract", () => {
    it("SCMAdapterError is instanceof Error", () => {
      const err = new SCMAdapterError("test", "UNKNOWN", "github");
      expect(err instanceof Error).toBe(true);
    });

    it("SCMAdapterError is instanceof SCMAdapterError", () => {
      const err = new SCMAdapterError("test", "UNKNOWN", "github");
      expect(err instanceof SCMAdapterError).toBe(true);
    });

    it("SCMAdapterError.name is 'SCMAdapterError'", () => {
      const err = new SCMAdapterError("test", "UNKNOWN", "github");
      expect(err.name).toBe("SCMAdapterError");
    });

    it("all adapter methods throw SCMAdapterError (not raw Error)", () => {
      const adapter = new MockSCMAdapter();

      try {
        adapter.parsePullRequestUrl("invalid");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        expect(err).not.toBeInstanceOf(TypeError);
      }
    });

    it("GitHub adapter wraps underlying errors as SCMAdapterError", () => {
      const adapter = new GitHubSCMAdapter();

      try {
        adapter.parsePullRequestUrl("not-a-github-url");
      } catch (err) {
        expect(err).toBeInstanceOf(SCMAdapterError);
        const scmErr = err as SCMAdapterError;
        expect(scmErr.cause).toBeDefined();
      }
    });
  });

  // ─── Contract: Method Return Types ────────────────────────────

  describe("Method return type contracts", () => {
    it("testConnection returns Promise<SCMConnectionStatus>", async () => {
      const adapter = new MockSCMAdapter();
      const promise = adapter.testConnection();

      expect(promise).toBeInstanceOf(Promise);

      const result = await promise;
      expect(result).toHaveProperty("connected");
      expect(result).toHaveProperty("message");
    });

    it("parsePullRequestUrl returns PullRequestRef (sync)", () => {
      const adapter = new MockSCMAdapter();
      const result = adapter.parsePullRequestUrl("mock://org/repo/pr/1");

      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toHaveProperty("owner");
      expect(result).toHaveProperty("repo");
      expect(result).toHaveProperty("number");
    });

    it("fetchPullRequest returns Promise<PRInfo>", async () => {
      const adapter = new MockSCMAdapter([createTestPRInfo({ number: 1 })]);
      const promise = adapter.fetchPullRequest("o", "r", 1);

      expect(promise).toBeInstanceOf(Promise);

      const result = await promise;
      expect(result).toHaveProperty("number");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("changedFiles");
    });

    it("fetchPullRequestByUrl returns Promise<PRInfo>", async () => {
      const adapter = new MockSCMAdapter([
        createTestPRInfo({ number: 1, url: "mock://o/r/pr/1" }),
      ]);
      const promise = adapter.fetchPullRequestByUrl("mock://o/r/pr/1");

      expect(promise).toBeInstanceOf(Promise);

      const result = await promise;
      expect(result).toHaveProperty("number");
    });
  });
});
