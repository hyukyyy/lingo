/**
 * Notion Adapter Configuration Schema & Validation
 *
 * Provides Zod-based runtime validation for all Notion adapter configuration.
 * Validates API token format, database IDs (Notion UUID), property mappings,
 * and auth settings with clear, actionable error messages.
 *
 * Usage:
 *   import { parseNotionConfig, NotionConfigSchema } from "./notion-config.js";
 *
 *   // From raw user input / JSON:
 *   const config = parseNotionConfig(rawInput);  // throws on invalid
 *
 *   // Non-throwing validation:
 *   const result = validateNotionConfig(rawInput);
 *   if (!result.success) { console.error(result.errors); }
 */

import { z } from "zod";
import type { PMItemType } from "../types.js";

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Notion API tokens start with one of these prefixes.
 * - "secret_" — legacy integration tokens
 * - "ntn_"   — newer integration tokens (2024+)
 */
export const NOTION_TOKEN_PREFIXES = ["secret_", "ntn_"] as const;

/**
 * Notion uses UUIDs (with or without hyphens) as database/page identifiers.
 * Matches both "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" and "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".
 */
export const NOTION_ID_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * Default Notion API base URL.
 */
export const DEFAULT_NOTION_BASE_URL = "https://api.notion.com";

/**
 * Default Notion API version header.
 */
export const DEFAULT_NOTION_API_VERSION = "2022-06-28";

/**
 * Default request timeout in milliseconds.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Maximum request timeout (5 minutes).
 */
export const MAX_TIMEOUT_MS = 300_000;

// ─── Zod Schemas ───────────────────────────────────────────────────

/**
 * Validates a Notion API token.
 * Must be a non-empty string starting with "secret_" or "ntn_".
 */
export const NotionApiTokenSchema = z
  .string()
  .trim()
  .min(1, "API token must not be empty")
  .refine(
    (token) =>
      NOTION_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix)),
    {
      message: `API token must start with one of: ${NOTION_TOKEN_PREFIXES.join(", ")}. Get a token at https://www.notion.so/my-integrations`,
    }
  );

/**
 * Validates a Notion database/page ID (UUID format, with or without hyphens).
 */
export const NotionDatabaseIdSchema = z
  .string()
  .trim()
  .min(1, "Database ID must not be empty")
  .refine((id) => NOTION_ID_PATTERN.test(id), {
    message:
      "Database ID must be a valid Notion UUID (e.g., 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' or 'a1b2c3d4e5f67890abcdef1234567890')",
  });

/**
 * Validates property mappings — all fields are optional strings.
 * When provided, property names should be non-empty.
 */
export const PropertyMappingsSchema = z
  .object({
    /** Property name containing the page title */
    titleProperty: z
      .string()
      .trim()
      .min(1, "titleProperty must not be empty if specified")
      .optional(),

    /** Property name containing the description */
    descriptionProperty: z
      .string()
      .trim()
      .min(1, "descriptionProperty must not be empty if specified")
      .optional(),

    /** Property name containing the item type */
    typeProperty: z
      .string()
      .trim()
      .min(1, "typeProperty must not be empty if specified")
      .optional(),

    /** Property name containing the workflow status */
    statusProperty: z
      .string()
      .trim()
      .min(1, "statusProperty must not be empty if specified")
      .optional(),

    /** Property name containing labels/tags */
    labelsProperty: z
      .string()
      .trim()
      .min(1, "labelsProperty must not be empty if specified")
      .optional(),

    /** Property name containing category */
    categoryProperty: z
      .string()
      .trim()
      .min(1, "categoryProperty must not be empty if specified")
      .optional(),
  })
  .strict()
  .optional();

/**
 * Valid PM item types for the defaultItemType field.
 */
const PM_ITEM_TYPES: [string, ...string[]] = [
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

/**
 * The complete Notion adapter configuration schema.
 *
 * Required fields:
 * - apiToken: Notion integration token (secret_... or ntn_...)
 * - databaseIds: Array of Notion database UUIDs to extract from
 *
 * Optional fields:
 * - propertyMappings: Custom property name mappings
 * - defaultItemType: Fallback PM item type (default: "feature")
 * - extractSchemaTerms: Whether to extract DB schema terms (default: true)
 * - baseUrl: Notion API base URL override
 * - apiVersion: Notion API version override
 * - timeoutMs: Request timeout in milliseconds
 */
export const NotionConfigSchema = z
  .object({
    // ─── Required Auth ───────────────────────────────────────────
    apiToken: NotionApiTokenSchema,
    databaseIds: z
      .array(NotionDatabaseIdSchema)
      .min(0)
      .describe("Notion database IDs to extract terminology from"),

    // ─── Optional Property Mappings ──────────────────────────────
    propertyMappings: PropertyMappingsSchema,

    // ─── Optional Behavior ───────────────────────────────────────
    defaultItemType: z
      .enum(PM_ITEM_TYPES as [string, ...string[]])
      .default("feature")
      .describe("Default PM item type when a page has no type property")
      .optional(),

    extractSchemaTerms: z
      .boolean()
      .default(true)
      .describe("Whether to also extract database schema terms (statuses, labels)")
      .optional(),

    // ─── Optional Network ────────────────────────────────────────
    baseUrl: z
      .string()
      .url("baseUrl must be a valid URL")
      .default(DEFAULT_NOTION_BASE_URL)
      .optional(),

    apiVersion: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}$/,
        "apiVersion must be in YYYY-MM-DD format"
      )
      .default(DEFAULT_NOTION_API_VERSION)
      .optional(),

    timeoutMs: z
      .number()
      .int("timeoutMs must be an integer")
      .positive("timeoutMs must be positive")
      .max(MAX_TIMEOUT_MS, `timeoutMs must not exceed ${MAX_TIMEOUT_MS}ms (5 minutes)`)
      .default(DEFAULT_TIMEOUT_MS)
      .optional(),
  })
  .strict();

/**
 * The inferred TypeScript type from the Zod schema.
 * This is the validated configuration shape.
 */
export type ValidatedNotionConfig = z.infer<typeof NotionConfigSchema>;

// ─── Validation Result ─────────────────────────────────────────────

/**
 * A structured validation error with field path and message.
 */
export interface ConfigValidationError {
  /** Dot-path to the field (e.g., "databaseIds.0", "propertyMappings.titleProperty") */
  path: string;

  /** Human-readable error message */
  message: string;
}

/**
 * Result of a non-throwing validation attempt.
 */
export type ConfigValidationResult =
  | { success: true; config: ValidatedNotionConfig }
  | { success: false; errors: ConfigValidationError[] };

// ─── Public API ────────────────────────────────────────────────────

/**
 * Validate and parse raw configuration input into a validated Notion config.
 * Throws a descriptive error if validation fails.
 *
 * @param input - Raw configuration object (from JSON, env vars, user input)
 * @returns Validated configuration
 * @throws {NotionConfigError} with structured details if validation fails
 */
export function parseNotionConfig(input: unknown): ValidatedNotionConfig {
  const result = NotionConfigSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const errors = formatZodErrors(result.error);
  throw new NotionConfigError(
    `Invalid Notion adapter configuration:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`,
    errors
  );
}

/**
 * Non-throwing validation of Notion adapter configuration.
 * Returns a result object indicating success or failure with structured errors.
 *
 * @param input - Raw configuration object
 * @returns Validation result with either the valid config or error details
 */
export function validateNotionConfig(
  input: unknown
): ConfigValidationResult {
  const result = NotionConfigSchema.safeParse(input);

  if (result.success) {
    return { success: true, config: result.data };
  }

  return { success: false, errors: formatZodErrors(result.error) };
}

/**
 * Validates a single Notion API token string.
 * Useful for checking token format before constructing a full config.
 *
 * @returns null if valid, or an error message string
 */
export function validateApiToken(token: string): string | null {
  const result = NotionApiTokenSchema.safeParse(token);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? "Invalid API token";
}

/**
 * Validates a single Notion database ID.
 * Useful for checking ID format before adding to config.
 *
 * @returns null if valid, or an error message string
 */
export function validateDatabaseId(id: string): string | null {
  const result = NotionDatabaseIdSchema.safeParse(id);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? "Invalid database ID";
}

/**
 * Normalizes a Notion database ID to hyphenated UUID format.
 * Accepts both "a1b2c3d4e5f67890abcdef1234567890" and
 * "a1b2c3d4-e5f6-7890-abcd-ef1234567890".
 *
 * @returns Hyphenated UUID, or null if the input is not a valid Notion ID
 */
export function normalizeDatabaseId(id: string): string | null {
  const trimmed = id.trim().toLowerCase();
  if (!NOTION_ID_PATTERN.test(trimmed)) return null;

  // Remove existing hyphens, then re-insert in UUID format
  const hex = trimmed.replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Error Class ───────────────────────────────────────────────────

/**
 * Error thrown when Notion adapter configuration is invalid.
 * Contains structured error details for programmatic access.
 */
export class NotionConfigError extends Error {
  constructor(
    message: string,
    public readonly validationErrors: ConfigValidationError[]
  ) {
    super(message);
    this.name = "NotionConfigError";
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────

/**
 * Convert Zod error issues into our structured ConfigValidationError format.
 */
function formatZodErrors(error: z.ZodError): ConfigValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}
