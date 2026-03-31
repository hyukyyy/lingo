/**
 * Tests for the Notion API client — connection, authentication, and error handling.
 *
 * Tests cover:
 * - Token validation (format checking before any network call)
 * - Authentication error classification (401, 403)
 * - Structured error parsing from Notion JSON error bodies
 * - Error classification for all HTTP status codes
 * - Retry logic with exponential backoff
 * - Rate limiting (429) with Retry-After header handling
 * - Timeout handling
 * - Network error handling
 * - NotionApiError properties and helpers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpNotionClient,
  NotionApiError,
  sleep,
  type NotionClientConfig,
  type NotionErrorCode,
} from "../../src/adapters/notion/notion-client.js";

// ─── Mock fetch ────────────────────────────────────────────────────

// We mock the global fetch for HTTP-level tests
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Helpers ───────────────────────────────────────────────────────

function validConfig(overrides?: Partial<NotionClientConfig>): NotionClientConfig {
  return {
    apiToken: "secret_test_token_abc123",
    timeoutMs: 5000,
    retry: { maxRetries: 0, initialDelayMs: 10 }, // Disable retries by default in tests
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  const headerMap = new Headers(headers);
  headerMap.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    statusText: statusTextFor(status),
    headers: headerMap,
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>
): Response {
  return jsonResponse(
    { object: "error", status, code, message },
    status,
    headers
  );
}

function statusTextFor(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return map[status] ?? "Unknown";
}

// ─── Token Validation ──────────────────────────────────────────────

describe("HttpNotionClient — Token Validation", () => {
  it("accepts tokens starting with 'secret_'", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: "secret_abc" }))).not.toThrow();
  });

  it("accepts tokens starting with 'ntn_'", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: "ntn_workspace_token" }))).not.toThrow();
  });

  it("rejects empty token", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: "" }))).toThrow(NotionApiError);
    try {
      new HttpNotionClient(validConfig({ apiToken: "" }));
    } catch (err) {
      expect(err).toBeInstanceOf(NotionApiError);
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("unauthorized");
      expect(apiErr.message).toContain("required");
    }
  });

  it("rejects token with invalid prefix", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: "sk-abc123" }))).toThrow(NotionApiError);
    try {
      new HttpNotionClient(validConfig({ apiToken: "sk-abc123" }));
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("unauthorized");
      expect(apiErr.message).toContain("secret_");
      expect(apiErr.message).toContain("ntn_");
    }
  });

  it("rejects whitespace-only token", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: "   " }))).toThrow(NotionApiError);
  });

  it("rejects undefined token", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: undefined as unknown as string }))).toThrow(NotionApiError);
  });

  it("rejects null token", () => {
    expect(() => new HttpNotionClient(validConfig({ apiToken: null as unknown as string }))).toThrow(NotionApiError);
  });
});

// ─── Authentication Headers ────────────────────────────────────────

describe("HttpNotionClient — Authentication Headers", () => {
  it("sends correct Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: "bot", bot: { workspace_name: "Test" } })
    );

    const client = new HttpNotionClient(validConfig({ apiToken: "secret_my_token" }));
    await client.getMe();

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers.Authorization).toBe("Bearer secret_my_token");
  });

  it("sends Notion-Version header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: "bot", bot: { workspace_name: "Test" } })
    );

    const client = new HttpNotionClient(validConfig());
    await client.getMe();

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("supports custom API version", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: "bot", bot: { workspace_name: "Test" } })
    );

    const client = new HttpNotionClient(validConfig({ apiVersion: "2023-08-01" }));
    await client.getMe();

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers["Notion-Version"]).toBe("2023-08-01");
  });

  it("sends Content-Type header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ type: "bot", bot: { workspace_name: "Test" } })
    );

    const client = new HttpNotionClient(validConfig());
    await client.getMe();

    const [, fetchInit] = mockFetch.mock.calls[0];
    expect(fetchInit.headers["Content-Type"]).toBe("application/json");
  });
});

// ─── Connection & API Methods ──────────────────────────────────────

describe("HttpNotionClient — API Methods", () => {
  it("getMe calls /v1/users/me", async () => {
    const responseData = { type: "bot", bot: { workspace_name: "My Workspace" } };
    mockFetch.mockResolvedValueOnce(jsonResponse(responseData));

    const client = new HttpNotionClient(validConfig());
    const result = await client.getMe();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/users/me");
    expect(result).toEqual(responseData);
  });

  it("getDatabase calls /v1/databases/:id", async () => {
    const dbData = { id: "db-123", title: [], description: [], url: "", properties: {} };
    mockFetch.mockResolvedValueOnce(jsonResponse(dbData));

    const client = new HttpNotionClient(validConfig());
    await client.getDatabase("db-123");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/databases/db-123");
  });

  it("queryDatabase POSTs to /v1/databases/:id/query", async () => {
    const queryResult = { results: [], has_more: false, next_cursor: null };
    mockFetch.mockResolvedValueOnce(jsonResponse(queryResult));

    const client = new HttpNotionClient(validConfig());
    await client.queryDatabase({
      database_id: "db-456",
      page_size: 50,
    });

    const [url, fetchInit] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/databases/db-456/query");
    expect(fetchInit.method).toBe("POST");
    const body = JSON.parse(fetchInit.body);
    expect(body.page_size).toBe(50);
  });

  it("search POSTs to /v1/search", async () => {
    const searchResult = { results: [], has_more: false, next_cursor: null };
    mockFetch.mockResolvedValueOnce(jsonResponse(searchResult));

    const client = new HttpNotionClient(validConfig());
    await client.search("my query");

    const [url, fetchInit] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/search");
    expect(fetchInit.method).toBe("POST");
    const body = JSON.parse(fetchInit.body);
    expect(body.query).toBe("my query");
  });

  it("supports custom base URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ baseUrl: "https://notion-proxy.example.com" })
    );
    await client.getMe();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://notion-proxy.example.com/v1/users/me");
  });

  it("strips trailing slash from base URL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ baseUrl: "https://api.notion.com/" })
    );
    await client.getMe();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/users/me");
  });
});

// ─── Error Classification ──────────────────────────────────────────

describe("HttpNotionClient — Error Classification", () => {
  const errorCases: Array<{
    status: number;
    notionCode: string;
    expectedCode: NotionErrorCode;
    description: string;
  }> = [
    { status: 401, notionCode: "unauthorized", expectedCode: "unauthorized", description: "401 → unauthorized" },
    { status: 403, notionCode: "restricted_resource", expectedCode: "forbidden", description: "403 → forbidden" },
    { status: 404, notionCode: "object_not_found", expectedCode: "not_found", description: "404 → not_found" },
    { status: 409, notionCode: "conflict_error", expectedCode: "conflict", description: "409 → conflict" },
    { status: 429, notionCode: "rate_limited", expectedCode: "rate_limited", description: "429 → rate_limited" },
    { status: 400, notionCode: "validation_error", expectedCode: "validation_error", description: "400 → validation_error" },
    { status: 500, notionCode: "internal_server_error", expectedCode: "server_error", description: "500 → server_error" },
    { status: 502, notionCode: "internal_server_error", expectedCode: "server_error", description: "502 → server_error" },
    { status: 503, notionCode: "service_unavailable", expectedCode: "server_error", description: "503 → server_error" },
  ];

  for (const { status, notionCode, expectedCode, description } of errorCases) {
    it(`classifies ${description}`, async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(status, notionCode, `Test error for ${status}`)
      );

      const client = new HttpNotionClient(validConfig());

      try {
        await client.getMe();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(NotionApiError);
        const apiErr = err as NotionApiError;
        expect(apiErr.code).toBe(expectedCode);
        expect(apiErr.statusCode).toBe(status);
      }
    });
  }
});

// ─── Structured Error Parsing ──────────────────────────────────────

describe("HttpNotionClient — Structured Error Parsing", () => {
  it("parses Notion JSON error body", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(401, "unauthorized", "API token is invalid.")
    );

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.errorBody).toBeDefined();
      expect(apiErr.errorBody?.object).toBe("error");
      expect(apiErr.errorBody?.status).toBe(401);
      expect(apiErr.errorBody?.code).toBe("unauthorized");
      expect(apiErr.errorBody?.message).toBe("API token is invalid.");
    }
  });

  it("includes Notion error message in the error message", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, "validation_error", "Could not find property with name 'Foo'")
    );

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.message).toContain("Could not find property with name 'Foo'");
    }
  });

  it("handles non-JSON error bodies gracefully", async () => {
    const htmlResponse = new Response("<html>Gateway Timeout</html>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/html" },
    });
    mockFetch.mockResolvedValueOnce(htmlResponse);

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("server_error");
      expect(apiErr.errorBody).toBeUndefined();
      expect(apiErr.responseBody).toContain("Gateway Timeout");
    }
  });

  it("handles empty error body gracefully", async () => {
    const emptyResponse = new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    });
    mockFetch.mockResolvedValueOnce(emptyResponse);

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("server_error");
      expect(apiErr.errorBody).toBeUndefined();
    }
  });
});

// ─── NotionApiError Properties ─────────────────────────────────────

describe("NotionApiError", () => {
  describe("isRetryable", () => {
    it("rate_limited is retryable", () => {
      const err = new NotionApiError("rate limited", 429, "", "rate_limited");
      expect(err.isRetryable).toBe(true);
    });

    it("server_error is retryable", () => {
      const err = new NotionApiError("server error", 500, "", "server_error");
      expect(err.isRetryable).toBe(true);
    });

    it("timeout is retryable", () => {
      const err = new NotionApiError("timed out", 0, "", "timeout");
      expect(err.isRetryable).toBe(true);
    });

    it("network_error is retryable", () => {
      const err = new NotionApiError("network", 0, "", "network_error");
      expect(err.isRetryable).toBe(true);
    });

    it("unauthorized is NOT retryable", () => {
      const err = new NotionApiError("unauth", 401, "", "unauthorized");
      expect(err.isRetryable).toBe(false);
    });

    it("forbidden is NOT retryable", () => {
      const err = new NotionApiError("forbidden", 403, "", "forbidden");
      expect(err.isRetryable).toBe(false);
    });

    it("not_found is NOT retryable", () => {
      const err = new NotionApiError("not found", 404, "", "not_found");
      expect(err.isRetryable).toBe(false);
    });

    it("validation_error is NOT retryable", () => {
      const err = new NotionApiError("bad request", 400, "", "validation_error");
      expect(err.isRetryable).toBe(false);
    });
  });

  describe("isAuthError", () => {
    it("unauthorized is an auth error", () => {
      const err = new NotionApiError("unauth", 401, "", "unauthorized");
      expect(err.isAuthError).toBe(true);
    });

    it("forbidden is an auth error", () => {
      const err = new NotionApiError("forbidden", 403, "", "forbidden");
      expect(err.isAuthError).toBe(true);
    });

    it("not_found is NOT an auth error", () => {
      const err = new NotionApiError("not found", 404, "", "not_found");
      expect(err.isAuthError).toBe(false);
    });

    it("server_error is NOT an auth error", () => {
      const err = new NotionApiError("server", 500, "", "server_error");
      expect(err.isAuthError).toBe(false);
    });
  });

  describe("userMessage", () => {
    it("provides actionable guidance for unauthorized", () => {
      const err = new NotionApiError("unauth", 401, "", "unauthorized");
      expect(err.userMessage).toContain("invalid or expired");
      expect(err.userMessage).toContain("notion.so/my-integrations");
    });

    it("provides actionable guidance for forbidden", () => {
      const err = new NotionApiError("forbidden", 403, "", "forbidden");
      expect(err.userMessage).toContain("permission");
    });

    it("provides actionable guidance for not_found", () => {
      const err = new NotionApiError("not found", 404, "", "not_found");
      expect(err.userMessage).toContain("not found");
    });

    it("provides actionable guidance for rate_limited", () => {
      const err = new NotionApiError("rate limited", 429, "", "rate_limited");
      expect(err.userMessage).toContain("rate limit");
    });

    it("provides actionable guidance for timeout", () => {
      const err = new NotionApiError("timeout", 0, "", "timeout");
      expect(err.userMessage).toContain("timed out");
    });

    it("provides actionable guidance for network_error", () => {
      const err = new NotionApiError("network", 0, "", "network_error");
      expect(err.userMessage).toContain("network");
    });

    it("includes Notion's error message for validation errors", () => {
      const err = new NotionApiError("bad req", 400, "", "validation_error", {
        object: "error",
        status: 400,
        code: "validation_error",
        message: "Missing required property: title",
      });
      expect(err.userMessage).toContain("Missing required property: title");
    });
  });

  describe("error name", () => {
    it("has the correct error name for instanceof checks", () => {
      const err = new NotionApiError("test", 500, "");
      expect(err.name).toBe("NotionApiError");
      expect(err instanceof Error).toBe(true);
    });
  });
});

// ─── Retry Logic ───────────────────────────────────────────────────

describe("HttpNotionClient — Retry Logic", () => {
  it("does not retry on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );
    await client.getMe();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 500 server error up to maxRetries", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, "internal_server_error", "Server error"))
      .mockResolvedValueOnce(errorResponse(500, "internal_server_error", "Server error"))
      .mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );
    const result = await client.getMe();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ type: "bot" });
  });

  it("retries on 429 rate limit", async () => {
    mockFetch
      .mockResolvedValueOnce(
        errorResponse(429, "rate_limited", "Rate limited", { "Retry-After": "1" })
      )
      .mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 100 } })
    );
    const result = await client.getMe();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ type: "bot" });
  });

  it("throws after exhausting retries", async () => {
    mockFetch
      .mockResolvedValue(errorResponse(500, "internal_server_error", "Persistent server error"));

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 2, initialDelayMs: 1 } })
    );

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("server_error");
      expect(apiErr.statusCode).toBe(500);
    }

    // Initial attempt + 2 retries = 3 total
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 401 unauthorized", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(401, "unauthorized", "Invalid token")
    );

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("unauthorized");
    }

    // No retries — only 1 attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 403 forbidden", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(403, "restricted_resource", "No access")
    );

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("forbidden");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404 not found", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(404, "object_not_found", "Not found")
    );

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );

    try {
      await client.getDatabase("nonexistent");
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("not_found");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 400 validation error", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(400, "validation_error", "Bad query")
    );

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 3, initialDelayMs: 1 } })
    );

    try {
      await client.queryDatabase({ database_id: "db-1" });
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("validation_error");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries=0 (no retries)", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(500, "internal_server_error", "Error")
    );

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 0, initialDelayMs: 1 } })
    );

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as NotionApiError).code).toBe("server_error");
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── Timeout Handling ──────────────────────────────────────────────

describe("HttpNotionClient — Timeout Handling", () => {
  it("throws timeout error when request exceeds timeoutMs", async () => {
    // Mock fetch that aborts
    mockFetch.mockImplementation(() => {
      const err = new DOMException("The operation was aborted", "AbortError");
      return Promise.reject(err);
    });

    const client = new HttpNotionClient(
      validConfig({ timeoutMs: 100 })
    );

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("timeout");
      expect(apiErr.message).toContain("timed out");
    }
  });

  it("uses custom timeout when configured", () => {
    // Verify the client accepts the config (no easy way to test actual timeout
    // without real network, but we can verify it doesn't throw)
    expect(() => new HttpNotionClient(validConfig({ timeoutMs: 60_000 }))).not.toThrow();
  });
});

// ─── Network Error Handling ────────────────────────────────────────

describe("HttpNotionClient — Network Error Handling", () => {
  it("classifies fetch TypeError as network_error", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError("fetch failed: ECONNREFUSED")
    );

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("network_error");
      expect(apiErr.message).toContain("ECONNREFUSED");
    }
  });

  it("classifies DNS resolution failure as network_error", async () => {
    mockFetch.mockRejectedValueOnce(
      new TypeError("fetch failed: getaddrinfo ENOTFOUND api.notion.com")
    );

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("network_error");
      expect(apiErr.message).toContain("ENOTFOUND");
    }
  });

  it("wraps unexpected errors as network_error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Something unexpected happened"));

    const client = new HttpNotionClient(validConfig());

    try {
      await client.getMe();
      expect.fail("Should have thrown");
    } catch (err) {
      const apiErr = err as NotionApiError;
      expect(apiErr.code).toBe("network_error");
      expect(apiErr.message).toContain("Something unexpected happened");
    }
  });

  it("retries network errors when retries are configured", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ type: "bot" }));

    const client = new HttpNotionClient(
      validConfig({ retry: { maxRetries: 2, initialDelayMs: 1 } })
    );

    const result = await client.getMe();
    expect(result).toEqual({ type: "bot" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ─── sleep utility ─────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow some tolerance for timer precision
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("resolves with 0ms delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
