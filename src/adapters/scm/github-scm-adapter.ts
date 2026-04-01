/**
 * GitHub SCM Adapter — GitHub Implementation of SCMAdapter
 *
 * Wraps the existing pr-learner GitHub API functions behind the SCMAdapter
 * interface. This adapter delegates to the battle-tested `fetchPR` and
 * `parsePRUrl` functions from `pr-learner`, ensuring identical behavior
 * to the original direct-call code.
 *
 * Design:
 * - Zero behavioral change from the existing pr-learner GitHub calls
 * - Configuration (token, base URL) is provided at construction time
 * - SCMAdapterError wraps any errors from the underlying functions
 *
 * This is the only SCM adapter required for v0.2.
 */

import type {
  SCMAdapter,
  SCMConnectionStatus,
  SCMAdapterConfig,
  PullRequestRef,
} from "./types.js";
import { SCMAdapterError } from "./types.js";
import type { PRInfo } from "../../pr-learner/pr-learner.js";
import { parsePRUrl, fetchPR } from "../../pr-learner/pr-learner.js";

// ─── Configuration ────────────────────────────────────────────────

/**
 * GitHub-specific SCM adapter configuration.
 */
export interface GitHubSCMAdapterConfig {
  /** GitHub Personal Access Token (optional for public repos) */
  token?: string;

  /** GitHub API base URL (default: https://api.github.com) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30_000) */
  timeoutMs?: number;
}

// ─── Adapter ──────────────────────────────────────────────────────

/**
 * GitHub SCM adapter that delegates to existing pr-learner functions.
 *
 * Wraps `parsePRUrl()` and `fetchPR()` from the pr-learner module,
 * providing the same behavior through the standardized SCMAdapter interface.
 * All existing direct-call tests can be expressed through this adapter
 * with identical results.
 */
export class GitHubSCMAdapter implements SCMAdapter {
  readonly name = "github";
  readonly displayName = "GitHub";

  private token?: string;
  private baseUrl: string;

  constructor(config?: GitHubSCMAdapterConfig) {
    this.token = config?.token ?? process.env.LINGO_GITHUB_TOKEN ?? undefined;
    this.baseUrl = config?.baseUrl ?? "https://api.github.com";
  }

  // ─── Connection ──────────────────────────────────────────────────

  async testConnection(): Promise<SCMConnectionStatus> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "lingo-mcp-server",
      };
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      const res = await fetch(`${this.baseUrl}/rate_limit`, { headers });

      if (!res.ok) {
        return {
          connected: false,
          message: `GitHub API returned ${res.status}: ${res.statusText}`,
        };
      }

      const data = (await res.json()) as {
        rate?: { remaining?: number; limit?: number };
      };

      return {
        connected: true,
        message: "Connected to GitHub API",
        details: {
          rateLimit: data.rate?.limit,
          rateLimitRemaining: data.rate?.remaining,
          authenticated: !!this.token,
        },
      };
    } catch (err) {
      return {
        connected: false,
        message: `Failed to connect to GitHub API: ${(err as Error).message}`,
      };
    }
  }

  // ─── URL Parsing ─────────────────────────────────────────────────

  /**
   * Parse a GitHub PR URL into components.
   *
   * Delegates to the existing `parsePRUrl()` function from pr-learner,
   * wrapping its error in an SCMAdapterError for consistent error handling.
   */
  parsePullRequestUrl(url: string): PullRequestRef {
    try {
      const { owner, repo, prNumber } = parsePRUrl(url);
      return { owner, repo, number: prNumber };
    } catch (err) {
      throw new SCMAdapterError(
        `Invalid GitHub PR URL: ${url}. Expected format: https://github.com/owner/repo/pull/123`,
        "INVALID_URL",
        this.name,
        err,
      );
    }
  }

  // ─── Pull Request Data ──────────────────────────────────────────

  /**
   * Fetch a GitHub pull request by owner, repo, and number.
   *
   * Delegates to the existing `fetchPR()` function from pr-learner,
   * using the adapter's configured token. Any errors from the underlying
   * function are wrapped in SCMAdapterError with appropriate error codes.
   */
  async fetchPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRInfo> {
    try {
      return await fetchPR(owner, repo, prNumber, this.token);
    } catch (err) {
      const message = (err as Error).message ?? String(err);

      // Map GitHub API errors to appropriate SCM error codes
      let code: SCMAdapterError["code"] = "UNKNOWN";
      if (message.includes("401") || message.includes("403")) {
        code = "AUTH_FAILED";
      } else if (message.includes("404")) {
        code = "NOT_FOUND";
      } else if (message.includes("429")) {
        code = "RATE_LIMITED";
      } else if (message.includes("fetch") || message.includes("ECONNREFUSED") || message.includes("network")) {
        code = "NETWORK_ERROR";
      }

      throw new SCMAdapterError(
        `Failed to fetch PR #${prNumber} from ${owner}/${repo}: ${message}`,
        code,
        this.name,
        err,
      );
    }
  }

  /**
   * Convenience: parse a URL and fetch the PR in one step.
   */
  async fetchPullRequestByUrl(url: string): Promise<PRInfo> {
    const ref = this.parsePullRequestUrl(url);
    return this.fetchPullRequest(ref.owner, ref.repo, ref.number);
  }
}

// ─── Factory ──────────────────────────────────────────────────────

/**
 * Create a GitHubSCMAdapter from a generic config object.
 *
 * Used by the adapter registry's factory-based instantiation pattern.
 */
export function createGitHubSCMAdapter(
  config: Record<string, unknown>,
): GitHubSCMAdapter {
  return new GitHubSCMAdapter({
    token: typeof config.token === "string" ? config.token : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
  });
}
