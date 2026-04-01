/**
 * SCM Adapter — Abstract Interface & Shared Types
 *
 * Defines the contract that all SCM (Source Control Management) tool adapters
 * must implement. Following the adapter pattern (mirroring the PM adapter
 * pattern in `../types.ts`), this decouples Lingo's core logic from any
 * specific SCM provider (GitHub, GitLab, Bitbucket, etc.).
 *
 * Data flow:
 *   SCM Tool API  ->  SCMAdapter.fetchPullRequest()  ->  PRInfo
 *                 ->  (domain logic: extractTermsFromPR, extractCodeLocations)
 *                 ->  GlossaryTerm updates
 *
 * The SCMAdapter handles only the SCM-specific fetch operations.
 * Term extraction and glossary integration are handled by domain logic
 * that sits above the adapter layer (currently in `pr-learner`).
 */

import type { PRInfo, PRFileChange } from "../../pr-learner/pr-learner.js";

// ─── Re-export PR types for adapter consumers ─────────────────────
// These types originate in pr-learner but are part of the SCM adapter contract.
export type { PRInfo, PRFileChange };

// ─── Pull Request Reference ─────────────────────────────────────────

/**
 * A parsed pull request / merge request reference.
 * Normalizes the URL into components that can be used by any SCM provider.
 */
export interface PullRequestRef {
  /** Repository owner or namespace (e.g., "facebook" for GitHub, "gitlab-org" for GitLab) */
  owner: string;

  /** Repository name (e.g., "react") */
  repo: string;

  /** Pull request / merge request number */
  number: number;
}

// ─── SCM Connection Status ──────────────────────────────────────────

/**
 * Connection status returned by testConnection().
 * Mirrors the PM adapter's ConnectionStatus pattern.
 */
export interface SCMConnectionStatus {
  /** Whether the connection was successful */
  connected: boolean;

  /** Human-readable message about the connection status */
  message: string;

  /** Additional details (e.g., authenticated user, rate limit remaining) */
  details?: Record<string, unknown>;
}

// ─── SCM Adapter Configuration ──────────────────────────────────────

/**
 * Base configuration that every SCM adapter requires.
 * Concrete adapters extend this with provider-specific fields.
 */
export interface SCMAdapterConfig {
  /** Human-readable name for this adapter instance (e.g., "github", "gitlab") */
  adapterName: string;

  /** Base API URL override (e.g., for GitHub Enterprise, self-hosted GitLab) */
  baseUrl?: string;

  /** Authentication token */
  token?: string;

  /** Request timeout in milliseconds (default: 30_000) */
  timeoutMs?: number;
}

// ─── SCM Adapter Error ──────────────────────────────────────────────

/**
 * Error codes specific to SCM adapter operations.
 */
export type SCMAdapterErrorCode =
  | "AUTH_FAILED"       // Authentication or authorization failure
  | "NOT_FOUND"         // Requested resource does not exist
  | "RATE_LIMITED"      // API rate limit exceeded
  | "NETWORK_ERROR"     // Network connectivity issue
  | "INVALID_CONFIG"    // Adapter configuration is invalid
  | "INVALID_URL"       // Could not parse the provided PR/MR URL
  | "PARSE_ERROR"       // Failed to parse response from SCM tool
  | "UNSUPPORTED"       // Operation not supported by this adapter
  | "UNKNOWN";          // Catch-all for unexpected errors

/**
 * Error thrown by SCM adapter operations.
 * Carries a typed error code so callers can handle different failures.
 */
export class SCMAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: SCMAdapterErrorCode,
    public readonly adapterName: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SCMAdapterError";
  }
}

// ─── SCM Adapter Interface ──────────────────────────────────────────

/**
 * The core adapter interface that all SCM tool adapters must implement.
 *
 * Design contract:
 * 1. Adapters are stateless between calls (no session management)
 * 2. Authentication is handled via config passed to the constructor
 * 3. parsePullRequestUrl() extracts structured refs from tool-specific URLs
 * 4. fetchPullRequest() retrieves full PR data including changed files
 *
 * The interface deliberately has a narrow surface area:
 * - Only pull request / merge request operations are in scope for v0.2
 * - Term extraction logic lives above the adapter layer
 * - Future versions may add commit browsing, branch listing, etc.
 *
 * Implementing a new adapter:
 * ```typescript
 * class GitLabSCMAdapter implements SCMAdapter {
 *   name = "gitlab";
 *   displayName = "GitLab";
 *   // ... implement all methods
 * }
 * ```
 */
export interface SCMAdapter {
  /** Unique identifier for this adapter (e.g., "github", "gitlab", "bitbucket") */
  readonly name: string;

  /** Human-readable display name (e.g., "GitHub", "GitLab", "Bitbucket") */
  readonly displayName: string;

  // ─── Connection ──────────────────────────────────────────────────

  /**
   * Test connectivity to the SCM provider.
   * Verifies that the adapter's configuration (API tokens, etc.) is valid
   * and that the target SCM API is reachable.
   */
  testConnection(): Promise<SCMConnectionStatus>;

  // ─── URL Parsing ─────────────────────────────────────────────────

  /**
   * Parse a pull request / merge request URL into structured components.
   *
   * Each SCM provider has its own URL format:
   * - GitHub: https://github.com/owner/repo/pull/123
   * - GitLab: https://gitlab.com/namespace/project/-/merge_requests/123
   *
   * @param url - The full PR/MR URL
   * @returns Parsed reference with owner, repo, and number
   * @throws SCMAdapterError with code INVALID_URL if the URL can't be parsed
   */
  parsePullRequestUrl(url: string): PullRequestRef;

  // ─── Pull Request Data ──────────────────────────────────────────

  /**
   * Fetch complete pull request information including changed files.
   *
   * This is the primary data-fetching method. It retrieves the PR metadata
   * (title, description, labels, merge status) and all changed files
   * (with additions/deletions counts and optional patches).
   *
   * @param owner - Repository owner/namespace
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Full PR information including changed files
   * @throws SCMAdapterError on auth, network, rate-limit, or parse failures
   */
  fetchPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRInfo>;

  /**
   * Convenience method: parse a URL and fetch the PR in one step.
   *
   * Equivalent to calling parsePullRequestUrl() then fetchPullRequest()
   * with the parsed components.
   *
   * @param url - The full PR/MR URL
   * @returns Full PR information including changed files
   * @throws SCMAdapterError on URL parse, auth, network, or other failures
   */
  fetchPullRequestByUrl(url: string): Promise<PRInfo>;
}
