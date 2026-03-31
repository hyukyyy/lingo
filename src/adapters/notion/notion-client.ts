/**
 * Notion API Client Interface & Types
 *
 * Abstracts the Notion API behind a clean interface for testability.
 * The real implementation uses the Notion API; tests use a mock.
 *
 * We define our own minimal types rather than depending on the
 * @notionhq/client package, keeping the dependency tree small and
 * allowing the adapter to work with any HTTP client.
 *
 * Features:
 * - Retry logic with exponential backoff for transient failures
 * - Rate limiting (429) handling with Retry-After header support
 * - Structured error parsing from Notion's JSON error responses
 * - Error classification (auth, not-found, rate-limit, server, network)
 * - Token validation before making requests
 */

// ─── Notion API Types (minimal subset) ──────────────────────────────

/**
 * A property value from a Notion database page.
 * We only model the types we actually use for term extraction.
 */
export type NotionPropertyValue =
  | { type: "title"; title: NotionRichText[] }
  | { type: "rich_text"; rich_text: NotionRichText[] }
  | { type: "select"; select: { name: string; color?: string } | null }
  | { type: "multi_select"; multi_select: { name: string; color?: string }[] }
  | { type: "status"; status: { name: string; color?: string } | null }
  | { type: "url"; url: string | null }
  | { type: "date"; date: { start: string; end?: string | null } | null }
  | { type: "checkbox"; checkbox: boolean }
  | { type: "number"; number: number | null }
  | { type: "relation"; relation: { id: string }[] }
  | { type: "formula"; formula: { type: string; string?: string; number?: number; boolean?: boolean } }
  | { type: "rollup"; rollup: { type: string } }
  | { type: "created_time"; created_time: string }
  | { type: "last_edited_time"; last_edited_time: string }
  | { type: "people"; people: { name?: string; id: string }[] }
  | { type: "files"; files: { name: string; type: string }[] }
  | { type: "unsupported"; unsupported: unknown };

/**
 * A rich text segment from the Notion API.
 */
export interface NotionRichText {
  type: "text" | "mention" | "equation";
  plain_text: string;
  href?: string | null;
}

/**
 * A Notion database page with its properties.
 */
export interface NotionPage {
  id: string;
  url: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  properties: Record<string, NotionPropertyValue>;
  parent: {
    type: "database_id" | "page_id" | "workspace";
    database_id?: string;
    page_id?: string;
  };
}

/**
 * A Notion database definition (metadata about the database itself).
 */
export interface NotionDatabase {
  id: string;
  object: "database";
  title: NotionRichText[];
  description: NotionRichText[];
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionDatabaseProperty>;
}

/**
 * A property definition from a Notion database schema.
 */
export interface NotionDatabaseProperty {
  id: string;
  name: string;
  type: string;
  select?: { options: { name: string; color?: string }[] };
  multi_select?: { options: { name: string; color?: string }[] };
  status?: { options: { name: string; color?: string }[]; groups: { name: string; option_ids: string[] }[] };
}

/**
 * A paginated response from the Notion API.
 */
export interface NotionPaginatedResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * A search result entry from the Notion search API.
 */
export interface NotionSearchResult {
  id: string;
  object: "page" | "database";
  url: string;
  title?: NotionRichText[];
  parent?: {
    type: string;
    database_id?: string;
  };
}

// ─── Notion Client Interface ────────────────────────────────────────

/**
 * Query filter for the Notion database query API.
 */
export interface NotionQueryFilter {
  property?: string;
  [key: string]: unknown;
}

/**
 * Options for querying a Notion database.
 */
export interface NotionQueryOptions {
  database_id: string;
  filter?: NotionQueryFilter;
  page_size?: number;
  start_cursor?: string;
}

/**
 * Options for the Notion search API.
 * Supports both simple string queries and structured filter options.
 */
export interface NotionSearchOptions {
  /** Text query to search for */
  query?: string;

  /** Filter results to a specific object type */
  filter?: { property: "object"; value: "page" | "database" };

  /** Maximum results per page */
  page_size?: number;

  /** Pagination cursor */
  start_cursor?: string;
}

/**
 * Abstract interface for interacting with the Notion API.
 *
 * This is the seam for dependency injection — tests provide a mock
 * implementation, production uses the real HTTP client.
 */
export interface NotionClient {
  /**
   * Query pages from a Notion database with optional filtering.
   */
  queryDatabase(
    options: NotionQueryOptions
  ): Promise<NotionPaginatedResponse<NotionPage>>;

  /**
   * Retrieve a database definition (schema, properties).
   */
  getDatabase(databaseId: string): Promise<NotionDatabase>;

  /**
   * Retrieve a single page by ID.
   */
  getPage(pageId: string): Promise<NotionPage>;

  /**
   * Search across the Notion workspace.
   * Accepts either a simple string query or structured search options.
   */
  search(
    queryOrOptions: string | NotionSearchOptions
  ): Promise<NotionPaginatedResponse<NotionSearchResult>>;

  /**
   * Retrieve the current user (for connection testing).
   */
  getMe(): Promise<{ type: string; bot?: { workspace_name?: string } }>;
}

// ─── Error Types ────────────────────────────────────────────────────

/**
 * Classification of Notion API errors for programmatic handling.
 */
export type NotionErrorCode =
  | "unauthorized"       // 401 — invalid or expired token
  | "forbidden"          // 403 — token lacks required permissions
  | "not_found"          // 404 — resource doesn't exist or not shared with integration
  | "conflict"           // 409 — resource conflict
  | "rate_limited"       // 429 — rate limit exceeded
  | "validation_error"   // 400 — invalid request body/params
  | "server_error"       // 500+ — Notion internal error
  | "network_error"      // Fetch failed (DNS, connection refused, etc.)
  | "timeout"            // Request timed out
  | "unknown";           // Unclassified error

/**
 * Structured error body from the Notion API.
 * Notion returns JSON errors with this shape.
 */
export interface NotionErrorBody {
  object: "error";
  status: number;
  code: string;
  message: string;
}

/**
 * Error thrown when the Notion API returns a non-OK response.
 * Contains structured error information for programmatic handling.
 */
export class NotionApiError extends Error {
  /** Classified error code for programmatic handling */
  public readonly code: NotionErrorCode;

  /** Parsed error body from Notion, if available */
  public readonly errorBody?: NotionErrorBody;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    code?: NotionErrorCode,
    errorBody?: NotionErrorBody
  ) {
    super(message);
    this.name = "NotionApiError";
    this.code = code ?? classifyStatusCode(statusCode);
    this.errorBody = errorBody;
  }

  /** Whether this error is potentially retryable (transient) */
  get isRetryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "server_error" ||
      this.code === "timeout" ||
      this.code === "network_error"
    );
  }

  /** Whether this is an authentication/authorization error */
  get isAuthError(): boolean {
    return this.code === "unauthorized" || this.code === "forbidden";
  }

  /** Human-friendly error description with actionable guidance */
  get userMessage(): string {
    switch (this.code) {
      case "unauthorized":
        return "Notion API token is invalid or expired. Check your integration token at https://www.notion.so/my-integrations";
      case "forbidden":
        return "Notion integration lacks permission for this resource. Ensure the integration is connected to the target pages/databases.";
      case "not_found":
        return "Notion resource not found. The database or page may not exist, or the integration may not have access.";
      case "rate_limited":
        return "Notion API rate limit exceeded. Requests will be retried automatically.";
      case "validation_error":
        return `Invalid request to Notion API: ${this.errorBody?.message ?? this.message}`;
      case "server_error":
        return "Notion API server error. This is usually temporary — try again shortly.";
      case "timeout":
        return "Request to Notion API timed out. Check your network connection and try again.";
      case "network_error":
        return "Cannot reach Notion API. Check your network connection and firewall settings.";
      default:
        return this.message;
    }
  }
}

/**
 * Classify an HTTP status code into a NotionErrorCode.
 */
function classifyStatusCode(status: number): NotionErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 400) return "validation_error";
  if (status >= 500) return "server_error";
  return "unknown";
}

/**
 * Parse a response body string into a structured NotionErrorBody,
 * or return undefined if it can't be parsed.
 */
function parseErrorBody(body: string): NotionErrorBody | undefined {
  try {
    const parsed = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.object === "error" &&
      typeof parsed.status === "number" &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      return parsed as NotionErrorBody;
    }
  } catch {
    // Not JSON or wrong shape — that's fine
  }
  return undefined;
}

// ─── Retry Configuration ────────────────────────────────────────────

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;

  /** Initial backoff delay in milliseconds (default: 1000) */
  initialDelayMs: number;

  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxDelayMs: number;

  /** Backoff multiplier between retries (default: 2) */
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

// ─── Real Notion Client ─────────────────────────────────────────────

/**
 * Configuration for the real Notion API client.
 */
export interface NotionClientConfig {
  /** Notion integration token (starts with "secret_" or "ntn_") */
  apiToken: string;

  /** Base URL for the Notion API (default: https://api.notion.com) */
  baseUrl?: string;

  /** Notion API version header (default: "2022-06-28") */
  apiVersion?: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;

  /** Retry configuration for transient failures */
  retry?: Partial<RetryConfig>;
}

/** Valid Notion API token prefixes */
const VALID_TOKEN_PREFIXES = ["secret_", "ntn_"] as const;

/**
 * Real Notion API client using fetch().
 *
 * Makes actual HTTP requests to the Notion API.
 * Handles pagination, authentication headers, error handling,
 * rate limiting with Retry-After support, and retry with exponential backoff.
 */
export class HttpNotionClient implements NotionClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly retryConfig: RetryConfig;

  constructor(config: NotionClientConfig) {
    // Validate token format
    validateToken(config.apiToken);

    this.baseUrl = (config.baseUrl ?? "https://api.notion.com").replace(
      /\/$/,
      ""
    );
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
    };
    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      "Notion-Version": config.apiVersion ?? "2022-06-28",
      "Content-Type": "application/json",
    };
  }

  async queryDatabase(
    options: NotionQueryOptions
  ): Promise<NotionPaginatedResponse<NotionPage>> {
    const body: Record<string, unknown> = {};
    if (options.filter) body.filter = options.filter;
    if (options.page_size) body.page_size = options.page_size;
    if (options.start_cursor) body.start_cursor = options.start_cursor;

    return this.post<NotionPaginatedResponse<NotionPage>>(
      `/v1/databases/${options.database_id}/query`,
      body
    );
  }

  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.get<NotionDatabase>(`/v1/databases/${databaseId}`);
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return this.get<NotionPage>(`/v1/pages/${pageId}`);
  }

  async search(
    queryOrOptions: string | NotionSearchOptions
  ): Promise<NotionPaginatedResponse<NotionSearchResult>> {
    const body: Record<string, unknown> =
      typeof queryOrOptions === "string"
        ? { query: queryOrOptions }
        : { ...queryOrOptions };

    return this.post<NotionPaginatedResponse<NotionSearchResult>>(
      "/v1/search",
      body
    );
  }

  async getMe(): Promise<{ type: string; bot?: { workspace_name?: string } }> {
    return this.get(`/v1/users/me`);
  }

  // ─── HTTP Helpers with Retry ────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    return this.requestWithRetry<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.requestWithRetry<T>("POST", path, body);
  }

  /**
   * Execute an HTTP request with retry logic.
   *
   * Retries on:
   * - 429 (Rate Limited) — uses Retry-After header if present
   * - 500+ (Server Error) — exponential backoff
   * - Network errors (fetch failures, timeouts) — exponential backoff
   *
   * Does NOT retry on:
   * - 401/403 (Auth errors) — retrying won't help
   * - 400 (Validation errors) — retrying won't help
   * - 404 (Not found) — retrying won't help
   */
  private async requestWithRetry<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    let lastError: NotionApiError | undefined;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await this.executeRequest<T>(method, path, body);
      } catch (err) {
        if (!(err instanceof NotionApiError)) {
          throw err;
        }

        lastError = err;

        // Don't retry non-retryable errors
        if (!err.isRetryable) {
          throw err;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= this.retryConfig.maxRetries) {
          break;
        }

        // Calculate delay
        const delay = this.calculateRetryDelay(err, attempt);
        await sleep(delay);
      }
    }

    // If we get here, we exhausted retries
    throw lastError!;
  }

  /**
   * Execute a single HTTP request (no retry).
   */
  private async executeRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: this.headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(
        `${this.baseUrl}${path}`,
        fetchOptions
      );

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        const errorBody = parseErrorBody(responseBody);

        // Build a descriptive error message
        const errorMessage = errorBody?.message
          ? `Notion API error (${response.status}): ${errorBody.message}`
          : `Notion API error: ${response.status} ${response.statusText}`;

        const error = new NotionApiError(
          errorMessage,
          response.status,
          responseBody,
          undefined, // auto-classify from status
          errorBody
        );

        // Attach Retry-After for rate limit errors
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter) {
            (error as NotionApiErrorWithRetry).retryAfterMs =
              parseRetryAfter(retryAfter);
          }
        }

        throw error;
      }

      return (await response.json()) as T;
    } catch (err) {
      // Re-throw NotionApiError as-is
      if (err instanceof NotionApiError) {
        throw err;
      }

      // Classify fetch-level errors
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new NotionApiError(
          `Notion API request timed out after ${this.timeoutMs}ms`,
          0,
          "",
          "timeout"
        );
      }

      // Network errors (DNS failure, connection refused, etc.)
      if (err instanceof TypeError && (err as Error).message?.includes("fetch")) {
        throw new NotionApiError(
          `Network error connecting to Notion API: ${(err as Error).message}`,
          0,
          "",
          "network_error"
        );
      }

      // Other unexpected errors — wrap as network_error
      throw new NotionApiError(
        `Unexpected error connecting to Notion API: ${(err as Error).message}`,
        0,
        "",
        "network_error"
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Calculate the delay before a retry attempt.
   *
   * For rate limit errors (429): use Retry-After header if available.
   * For other errors: exponential backoff with jitter.
   */
  private calculateRetryDelay(error: NotionApiError, attempt: number): number {
    // Use Retry-After header for rate limit errors
    if (error.code === "rate_limited") {
      const retryAfterMs = (error as NotionApiErrorWithRetry).retryAfterMs;
      if (retryAfterMs && retryAfterMs > 0) {
        // Clamp to maxDelayMs
        return Math.min(retryAfterMs, this.retryConfig.maxDelayMs);
      }
    }

    // Exponential backoff with jitter
    const baseDelay =
      this.retryConfig.initialDelayMs *
      Math.pow(this.retryConfig.backoffMultiplier, attempt);
    const jitter = Math.random() * 0.3 * baseDelay; // ±30% jitter
    return Math.min(baseDelay + jitter, this.retryConfig.maxDelayMs);
  }
}

/**
 * Extended error type with optional retry-after metadata.
 * Used internally — not part of the public API.
 */
interface NotionApiErrorWithRetry extends NotionApiError {
  retryAfterMs?: number;
}

// ─── Token Validation ───────────────────────────────────────────────

/**
 * Validates that a Notion API token has a recognized prefix.
 * Throws a descriptive error if the token format is invalid.
 */
function validateToken(token: string): void {
  if (!token || typeof token !== "string") {
    throw new NotionApiError(
      "Notion API token is required. Get one at https://www.notion.so/my-integrations",
      0,
      "",
      "unauthorized"
    );
  }

  const trimmed = token.trim();
  if (!trimmed) {
    throw new NotionApiError(
      "Notion API token must not be empty. Get one at https://www.notion.so/my-integrations",
      0,
      "",
      "unauthorized"
    );
  }

  const hasValidPrefix = VALID_TOKEN_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix)
  );

  if (!hasValidPrefix) {
    throw new NotionApiError(
      `Invalid Notion API token format. Token must start with ${VALID_TOKEN_PREFIXES.map((p) => `"${p}"`).join(" or ")}. Get a token at https://www.notion.so/my-integrations`,
      0,
      "",
      "unauthorized"
    );
  }
}

// ─── Utility Functions ──────────────────────────────────────────────

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both seconds (integer) and HTTP-date formats.
 */
function parseRetryAfter(value: string): number {
  // Try parsing as seconds (integer)
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.max(0, delayMs);
  }

  // Fallback: 1 second
  return 1000;
}

/**
 * Sleep for a given number of milliseconds.
 * Extracted as a function to allow mocking in tests.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
