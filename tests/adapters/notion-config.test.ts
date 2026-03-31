import { describe, it, expect } from "vitest";
import {
  NotionConfigSchema,
  NotionApiTokenSchema,
  NotionDatabaseIdSchema,
  PropertyMappingsSchema,
  NotionConfigError,
  parseNotionConfig,
  validateNotionConfig,
  validateApiToken,
  validateDatabaseId,
  normalizeDatabaseId,
  NOTION_TOKEN_PREFIXES,
  DEFAULT_NOTION_BASE_URL,
  DEFAULT_NOTION_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "../../src/adapters/notion/notion-config.js";

// ─── Helpers ───────────────────────────────────────────────────────

/** Minimal valid config for test defaults. */
function validConfig(overrides?: Record<string, unknown>) {
  return {
    apiToken: "secret_abc123xyz",
    databaseIds: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    ...overrides,
  };
}

// ─── NotionApiTokenSchema ──────────────────────────────────────────

describe("NotionApiTokenSchema", () => {
  it("accepts tokens starting with 'secret_'", () => {
    const result = NotionApiTokenSchema.safeParse("secret_abc123");
    expect(result.success).toBe(true);
  });

  it("accepts tokens starting with 'ntn_'", () => {
    const result = NotionApiTokenSchema.safeParse("ntn_abc123xyz");
    expect(result.success).toBe(true);
  });

  it("rejects empty strings", () => {
    const result = NotionApiTokenSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only strings", () => {
    const result = NotionApiTokenSchema.safeParse("   ");
    expect(result.success).toBe(false);
  });

  it("rejects tokens without a valid prefix", () => {
    const result = NotionApiTokenSchema.safeParse("sk-12345");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("secret_");
      expect(result.error.issues[0].message).toContain("ntn_");
    }
  });

  it("rejects tokens that contain the prefix but don't start with it", () => {
    const result = NotionApiTokenSchema.safeParse("my_secret_token");
    expect(result.success).toBe(false);
  });

  it("trims whitespace before validation", () => {
    const result = NotionApiTokenSchema.safeParse("  secret_abc123  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("secret_abc123");
    }
  });
});

// ─── NotionDatabaseIdSchema ────────────────────────────────────────

describe("NotionDatabaseIdSchema", () => {
  it("accepts hyphenated UUIDs", () => {
    const result = NotionDatabaseIdSchema.safeParse(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
    expect(result.success).toBe(true);
  });

  it("accepts non-hyphenated UUIDs (32-char hex)", () => {
    const result = NotionDatabaseIdSchema.safeParse(
      "a1b2c3d4e5f67890abcdef1234567890"
    );
    expect(result.success).toBe(true);
  });

  it("accepts uppercase UUIDs", () => {
    const result = NotionDatabaseIdSchema.safeParse(
      "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
    );
    expect(result.success).toBe(true);
  });

  it("rejects empty strings", () => {
    const result = NotionDatabaseIdSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects strings that are not UUIDs", () => {
    const result = NotionDatabaseIdSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("UUID");
    }
  });

  it("rejects UUIDs with wrong length", () => {
    const result = NotionDatabaseIdSchema.safeParse("a1b2c3d4-e5f6-7890");
    expect(result.success).toBe(false);
  });

  it("rejects UUIDs with non-hex characters", () => {
    const result = NotionDatabaseIdSchema.safeParse(
      "g1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
    expect(result.success).toBe(false);
  });

  it("trims whitespace before validation", () => {
    const result = NotionDatabaseIdSchema.safeParse(
      "  a1b2c3d4-e5f6-7890-abcd-ef1234567890  "
    );
    expect(result.success).toBe(true);
  });
});

// ─── PropertyMappingsSchema ────────────────────────────────────────

describe("PropertyMappingsSchema", () => {
  it("accepts undefined (all optional)", () => {
    const result = PropertyMappingsSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("accepts an empty object", () => {
    const result = PropertyMappingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid property names", () => {
    const result = PropertyMappingsSchema.safeParse({
      titleProperty: "Task Name",
      descriptionProperty: "Details",
      typeProperty: "Item Type",
      statusProperty: "Status",
      labelsProperty: "Tags",
      categoryProperty: "Domain",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial property mappings", () => {
    const result = PropertyMappingsSchema.safeParse({
      titleProperty: "Name",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty string property names", () => {
    const result = PropertyMappingsSchema.safeParse({
      titleProperty: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown property fields (strict mode)", () => {
    const result = PropertyMappingsSchema.safeParse({
      titleProperty: "Name",
      unknownField: "value",
    });
    expect(result.success).toBe(false);
  });
});

// ─── NotionConfigSchema (full config) ──────────────────────────────

describe("NotionConfigSchema", () => {
  describe("valid configurations", () => {
    it("accepts minimal valid config", () => {
      const result = NotionConfigSchema.safeParse(validConfig());
      expect(result.success).toBe(true);
    });

    it("accepts config with all optional fields", () => {
      const result = NotionConfigSchema.safeParse({
        apiToken: "secret_full_config_test",
        databaseIds: [
          "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "11111111-2222-3333-4444-555555555555",
        ],
        propertyMappings: {
          titleProperty: "Task Name",
          descriptionProperty: "Details",
          statusProperty: "State",
        },
        defaultItemType: "story",
        extractSchemaTerms: false,
        baseUrl: "https://custom-notion-proxy.example.com",
        apiVersion: "2023-08-01",
        timeoutMs: 60000,
      });
      expect(result.success).toBe(true);
    });

    it("accepts config with empty databaseIds array", () => {
      const result = NotionConfigSchema.safeParse({
        apiToken: "secret_test",
        databaseIds: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts config with ntn_ token prefix", () => {
      const result = NotionConfigSchema.safeParse({
        apiToken: "ntn_workspace_token_abc",
        databaseIds: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts multiple database IDs", () => {
      const result = NotionConfigSchema.safeParse({
        apiToken: "secret_test",
        databaseIds: [
          "11111111-1111-1111-1111-111111111111",
          "22222222-2222-2222-2222-222222222222",
          "33333333333333333333333333333333",
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("required field validation", () => {
    it("rejects missing apiToken", () => {
      const result = NotionConfigSchema.safeParse({
        databaseIds: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing databaseIds", () => {
      const result = NotionConfigSchema.safeParse({
        apiToken: "secret_test",
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty/null input", () => {
      expect(NotionConfigSchema.safeParse(null).success).toBe(false);
      expect(NotionConfigSchema.safeParse(undefined).success).toBe(false);
      expect(NotionConfigSchema.safeParse("").success).toBe(false);
      expect(NotionConfigSchema.safeParse(42).success).toBe(false);
    });
  });

  describe("apiToken validation", () => {
    it("rejects invalid token prefix", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ apiToken: "bearer_abc123" })
      );
      expect(result.success).toBe(false);
    });

    it("rejects empty token", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ apiToken: "" })
      );
      expect(result.success).toBe(false);
    });
  });

  describe("databaseIds validation", () => {
    it("rejects invalid database IDs in array", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ databaseIds: ["not-a-uuid"] })
      );
      expect(result.success).toBe(false);
    });

    it("rejects mixed valid and invalid IDs", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({
          databaseIds: [
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "invalid",
          ],
        })
      );
      expect(result.success).toBe(false);
    });

    it("rejects non-array databaseIds", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ databaseIds: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })
      );
      expect(result.success).toBe(false);
    });
  });

  describe("optional field validation", () => {
    it("rejects invalid defaultItemType", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ defaultItemType: "invalid-type" })
      );
      expect(result.success).toBe(false);
    });

    it("accepts all valid PMItemType values for defaultItemType", () => {
      const validTypes = [
        "epic",
        "feature",
        "story",
        "task",
        "bug",
        "label",
        "status",
        "workflow",
        "project",
        "milestone",
        "custom",
      ];

      for (const type of validTypes) {
        const result = NotionConfigSchema.safeParse(
          validConfig({ defaultItemType: type })
        );
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid baseUrl (not a URL)", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ baseUrl: "not-a-url" })
      );
      expect(result.success).toBe(false);
    });

    it("rejects invalid apiVersion format", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ apiVersion: "v2" })
      );
      expect(result.success).toBe(false);
    });

    it("accepts valid apiVersion in YYYY-MM-DD format", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ apiVersion: "2023-08-01" })
      );
      expect(result.success).toBe(true);
    });

    it("rejects negative timeoutMs", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ timeoutMs: -1000 })
      );
      expect(result.success).toBe(false);
    });

    it("rejects timeoutMs exceeding max", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ timeoutMs: MAX_TIMEOUT_MS + 1 })
      );
      expect(result.success).toBe(false);
    });

    it("rejects non-integer timeoutMs", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ timeoutMs: 1500.5 })
      );
      expect(result.success).toBe(false);
    });

    it("rejects unknown fields (strict mode)", () => {
      const result = NotionConfigSchema.safeParse(
        validConfig({ unknownField: "value" })
      );
      expect(result.success).toBe(false);
    });
  });
});

// ─── parseNotionConfig ─────────────────────────────────────────────

describe("parseNotionConfig", () => {
  it("returns validated config for valid input", () => {
    const config = parseNotionConfig(validConfig());

    expect(config.apiToken).toBe("secret_abc123xyz");
    expect(config.databaseIds).toEqual([
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ]);
  });

  it("throws NotionConfigError for invalid input", () => {
    expect(() => parseNotionConfig({})).toThrow(NotionConfigError);
  });

  it("error contains structured validation errors", () => {
    try {
      parseNotionConfig({ apiToken: "invalid", databaseIds: ["bad-id"] });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotionConfigError);
      const configErr = err as InstanceType<typeof NotionConfigError>;
      expect(configErr.validationErrors.length).toBeGreaterThan(0);

      // Should have errors for both apiToken and databaseIds
      const paths = configErr.validationErrors.map((e) => e.path);
      expect(paths).toContain("apiToken");
      expect(paths).toContain("databaseIds.0");
    }
  });

  it("error message is human-readable", () => {
    try {
      parseNotionConfig({ apiToken: "bad" });
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Invalid Notion adapter configuration");
      expect(msg).toContain("apiToken");
    }
  });

  it("trims whitespace from token and IDs", () => {
    const config = parseNotionConfig({
      apiToken: "  secret_trimmed  ",
      databaseIds: ["  a1b2c3d4-e5f6-7890-abcd-ef1234567890  "],
    });

    expect(config.apiToken).toBe("secret_trimmed");
    expect(config.databaseIds[0]).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });
});

// ─── validateNotionConfig ──────────────────────────────────────────

describe("validateNotionConfig", () => {
  it("returns success:true for valid config", () => {
    const result = validateNotionConfig(validConfig());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.apiToken).toBe("secret_abc123xyz");
    }
  });

  it("returns success:false with errors for invalid config", () => {
    const result = validateNotionConfig({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toHaveProperty("path");
      expect(result.errors[0]).toHaveProperty("message");
    }
  });

  it("does not throw on invalid input", () => {
    expect(() => validateNotionConfig(null)).not.toThrow();
    expect(() => validateNotionConfig(undefined)).not.toThrow();
    expect(() => validateNotionConfig("string")).not.toThrow();
  });

  it("returns all validation errors at once", () => {
    const result = validateNotionConfig({
      apiToken: "invalid",
      databaseIds: ["bad-id-1", "bad-id-2"],
      timeoutMs: -5,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Should report errors for token, both db IDs, and timeout
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ─── validateApiToken ──────────────────────────────────────────────

describe("validateApiToken", () => {
  it("returns null for valid tokens", () => {
    expect(validateApiToken("secret_abc")).toBeNull();
    expect(validateApiToken("ntn_abc")).toBeNull();
  });

  it("returns error message for invalid tokens", () => {
    const err = validateApiToken("invalid_token");
    expect(err).toBeTruthy();
    expect(typeof err).toBe("string");
  });

  it("returns error for empty string", () => {
    expect(validateApiToken("")).toBeTruthy();
  });
});

// ─── validateDatabaseId ────────────────────────────────────────────

describe("validateDatabaseId", () => {
  it("returns null for valid UUIDs", () => {
    expect(
      validateDatabaseId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    ).toBeNull();
    expect(
      validateDatabaseId("a1b2c3d4e5f67890abcdef1234567890")
    ).toBeNull();
  });

  it("returns error message for invalid IDs", () => {
    const err = validateDatabaseId("not-valid");
    expect(err).toBeTruthy();
    expect(typeof err).toBe("string");
  });
});

// ─── normalizeDatabaseId ───────────────────────────────────────────

describe("normalizeDatabaseId", () => {
  it("normalizes non-hyphenated UUID to hyphenated format", () => {
    const result = normalizeDatabaseId("a1b2c3d4e5f67890abcdef1234567890");
    expect(result).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("keeps already-hyphenated UUIDs unchanged", () => {
    const result = normalizeDatabaseId(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
    expect(result).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("lowercases uppercase UUIDs", () => {
    const result = normalizeDatabaseId(
      "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
    );
    expect(result).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("trims whitespace", () => {
    const result = normalizeDatabaseId(
      "  a1b2c3d4e5f67890abcdef1234567890  "
    );
    expect(result).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("returns null for invalid IDs", () => {
    expect(normalizeDatabaseId("not-a-uuid")).toBeNull();
    expect(normalizeDatabaseId("")).toBeNull();
    expect(normalizeDatabaseId("too-short")).toBeNull();
  });
});

// ─── Constants ─────────────────────────────────────────────────────

describe("Configuration constants", () => {
  it("exports expected token prefixes", () => {
    expect(NOTION_TOKEN_PREFIXES).toContain("secret_");
    expect(NOTION_TOKEN_PREFIXES).toContain("ntn_");
  });

  it("exports sensible defaults", () => {
    expect(DEFAULT_NOTION_BASE_URL).toBe("https://api.notion.com");
    expect(DEFAULT_NOTION_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MAX_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});
