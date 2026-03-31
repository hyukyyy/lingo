/**
 * PM Tool Item Types — Intermediate Representation
 *
 * Defines the canonical, PM-tool-agnostic schema for project management items.
 * This is the "lingua franca" between:
 *   - PM tool adapters (Notion, Linear, Jira) that normalize external data INTO these types
 *   - NL input parsing that extracts structured items FROM natural language
 *   - The glossary mapping system that links PM concepts to code locations
 *
 * Design principles:
 *   - Adapter-agnostic: No Notion/Linear/Jira-specific fields in the core types
 *   - Normalized enums: Status, priority, and item types use canonical values
 *     that adapters map to/from their tool-specific equivalents
 *   - Extensible metadata: `metadata` field for adapter-specific data that
 *     doesn't fit the canonical schema
 *   - Zod schemas: Runtime validation alongside TypeScript types
 *   - Hierarchical: Items can reference parents/children for epic→story→task trees
 */

import { z } from "zod";

// ─── PM Item Type ────────────────────────────────────────────────────

/**
 * The canonical set of PM item types that Lingo understands.
 * Adapters map their tool-specific types to these canonical values.
 *
 * Hierarchy (typical, not enforced):
 *   initiative → epic → story → task → subtask
 *
 * Non-hierarchical:
 *   bug, feature, milestone
 */
export const PmItemTypeSchema = z.enum([
  "initiative",   // Strategic theme or OKR-level grouping
  "epic",         // Large body of work spanning multiple stories
  "story",        // A user-facing requirement or user story
  "task",         // A concrete, assignable unit of work
  "subtask",      // A sub-unit of a task
  "bug",          // A defect report
  "feature",      // A feature request or capability
  "milestone",    // A time-bound goal or release target
]);

export type PmItemType = z.infer<typeof PmItemTypeSchema>;

/**
 * All valid PM item type values as a readonly array.
 * Useful for iteration, validation, and UI rendering.
 */
export const PM_ITEM_TYPES = PmItemTypeSchema.options;

// ─── Normalized Status ───────────────────────────────────────────────

/**
 * Canonical statuses that all PM tools map to.
 * Adapters translate tool-specific statuses (e.g., Jira's "In QA",
 * Linear's "Triage") into these normalized values.
 */
export const PmStatusSchema = z.enum([
  "backlog",      // Not yet prioritized or scheduled
  "todo",         // Prioritized, ready to start
  "in-progress",  // Actively being worked on
  "in-review",    // Under review (code review, QA, stakeholder review)
  "done",         // Completed
  "cancelled",    // Won't do / abandoned
]);

export type PmStatus = z.infer<typeof PmStatusSchema>;

export const PM_STATUSES = PmStatusSchema.options;

// ─── Normalized Priority ─────────────────────────────────────────────

/**
 * Canonical priority levels. Adapters translate tool-specific priorities
 * (e.g., Jira's P1-P5, Linear's "Urgent"/"High"/"Medium"/"Low")
 * into these normalized values.
 */
export const PmPrioritySchema = z.enum([
  "critical",     // Blocking / must fix immediately
  "high",         // Important, should be done soon
  "medium",       // Normal priority
  "low",          // Nice to have, can wait
  "none",         // No priority assigned
]);

export type PmPriority = z.infer<typeof PmPrioritySchema>;

export const PM_PRIORITIES = PmPrioritySchema.options;

// ─── Item Source ─────────────────────────────────────────────────────

/**
 * Tracks where a PM item came from — which adapter and external system.
 * Provides traceability back to the source PM tool.
 */
export const PmItemSourceSchema = z.object({
  /** The adapter that provided this item (e.g., "notion", "linear", "jira", "manual") */
  adapter: z.string().min(1),

  /** The item's ID in the source PM tool (for sync/dedup) */
  externalId: z.string().optional(),

  /** URL linking back to the item in the source PM tool */
  url: z.string().url().optional(),

  /** When this item was last synced from the source */
  lastSyncedAt: z.string().datetime().optional(),
});

export type PmItemSource = z.infer<typeof PmItemSourceSchema>;

// ─── Person Reference ────────────────────────────────────────────────

/**
 * A lightweight reference to a person (assignee, reporter, etc.).
 * Not a full user model — just enough to display and trace back.
 */
export const PersonRefSchema = z.object({
  /** Display name */
  name: z.string().min(1),

  /** Email or unique identifier in the source system */
  email: z.string().email().optional(),

  /** ID in the source PM tool */
  externalId: z.string().optional(),
});

export type PersonRef = z.infer<typeof PersonRefSchema>;

// ─── Item Reference ──────────────────────────────────────────────────

/**
 * A lightweight reference to another PM item (for parent/child/dependency links).
 * Avoids circular references by using IDs rather than full item objects.
 */
export const PmItemRefSchema = z.object({
  /** The referenced item's internal Lingo ID */
  id: z.string().uuid(),

  /** The referenced item's type (for context without loading the full item) */
  type: PmItemTypeSchema,

  /** The referenced item's title (for display without loading the full item) */
  title: z.string(),
});

export type PmItemRef = z.infer<typeof PmItemRefSchema>;

// ─── PM Item (Core Schema) ──────────────────────────────────────────

/**
 * The canonical intermediate representation of a PM item.
 *
 * This is what adapters produce and what downstream consumers (glossary mapper,
 * MCP tools, NL parser) work with. It's designed to be:
 *   - Rich enough to capture the essential semantics of any PM tool item
 *   - Simple enough to be maintainable by one developer
 *   - Extensible via the `metadata` escape hatch for adapter-specific data
 */
export const PmItemSchema = z.object({
  /** Unique internal identifier (UUID v4) */
  id: z.string().uuid(),

  /** The canonical type of this item */
  type: PmItemTypeSchema,

  /** The item's title/summary */
  title: z.string().min(1),

  /** Longer description or acceptance criteria (plain text or markdown) */
  description: z.string().default(""),

  /** Normalized status */
  status: PmStatusSchema,

  /** Normalized priority */
  priority: PmPrioritySchema,

  /** Free-form labels/tags for flexible categorization */
  labels: z.array(z.string()).default([]),

  /** Person assigned to this item */
  assignee: PersonRefSchema.optional(),

  /** Person who created/reported this item */
  reporter: PersonRefSchema.optional(),

  /** Parent item reference (e.g., the epic this story belongs to) */
  parent: PmItemRefSchema.optional(),

  /** Child item references (e.g., tasks under this story) */
  children: z.array(PmItemRefSchema).default([]),

  /** Items this one depends on (blocked by) */
  dependencies: z.array(PmItemRefSchema).default([]),

  /** Where this item came from */
  source: PmItemSourceSchema,

  /**
   * Adapter-specific metadata that doesn't fit the canonical schema.
   * Examples: Jira sprint ID, Linear cycle number, Notion database properties.
   * Opaque to the core system — only the originating adapter interprets it.
   */
  metadata: z.record(z.string(), z.unknown()).default({}),

  /** Optional due date (ISO 8601) */
  dueDate: z.string().datetime().optional(),

  /** ISO 8601 timestamp of when this item was created in the source system */
  createdAt: z.string().datetime(),

  /** ISO 8601 timestamp of when this item was last updated in the source system */
  updatedAt: z.string().datetime(),
});

export type PmItem = z.infer<typeof PmItemSchema>;

// ─── Creation Helpers ────────────────────────────────────────────────

/**
 * Input schema for creating a new PM item. Omits auto-generated fields
 * (id, createdAt, updatedAt) and provides sensible defaults for optional fields.
 */
export const CreatePmItemInputSchema = PmItemSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  status: true,
  priority: true,
  labels: true,
  children: true,
  dependencies: true,
  metadata: true,
  description: true,
});

export type CreatePmItemInput = z.infer<typeof CreatePmItemInputSchema>;

/**
 * Creates a new PmItem with auto-generated ID and timestamps.
 * Applies sensible defaults for fields not provided.
 *
 * @param input - The item creation input (validated at runtime via Zod)
 * @returns A fully populated PmItem
 * @throws ZodError if the input fails validation
 */
export function createPmItem(input: CreatePmItemInput): PmItem {
  // Validate input at runtime
  const validated = CreatePmItemInputSchema.parse(input);

  const now = new Date().toISOString();

  return {
    id: generateId(),
    type: validated.type,
    title: validated.title,
    description: validated.description ?? "",
    status: validated.status ?? "backlog",
    priority: validated.priority ?? "none",
    labels: validated.labels ?? [],
    assignee: validated.assignee,
    reporter: validated.reporter,
    parent: validated.parent,
    children: validated.children ?? [],
    dependencies: validated.dependencies ?? [],
    source: validated.source,
    metadata: validated.metadata ?? {},
    dueDate: validated.dueDate,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Adapter Mapping Types ───────────────────────────────────────────

/**
 * Defines how a PM tool adapter maps its native item types to Lingo's
 * canonical PmItemType. Each adapter provides one of these.
 *
 * Example (Notion):
 *   { "Page": "story", "Database Item": "task" }
 *
 * Example (Linear):
 *   { "Issue": "task", "Project": "epic", "Initiative": "initiative" }
 *
 * Example (Jira):
 *   { "Story": "story", "Task": "task", "Bug": "bug", "Epic": "epic" }
 */
export type ItemTypeMapping = Record<string, PmItemType>;

/**
 * Defines how a PM tool adapter maps its native statuses to Lingo's
 * canonical PmStatus.
 *
 * Example (Jira):
 *   { "To Do": "todo", "In Progress": "in-progress", "In QA": "in-review", "Done": "done" }
 */
export type StatusMapping = Record<string, PmStatus>;

/**
 * Defines how a PM tool adapter maps its native priorities to Lingo's
 * canonical PmPriority.
 *
 * Example (Linear):
 *   { "Urgent": "critical", "High": "high", "Medium": "medium", "Low": "low", "No priority": "none" }
 */
export type PriorityMapping = Record<string, PmPriority>;

/**
 * Combined mapping configuration for a PM tool adapter.
 * Encapsulates all the normalization rules an adapter needs.
 */
export interface AdapterMappingConfig {
  /** Maps native item types → canonical PmItemType */
  itemTypes: ItemTypeMapping;

  /** Maps native statuses → canonical PmStatus */
  statuses: StatusMapping;

  /** Maps native priorities → canonical PmPriority */
  priorities: PriorityMapping;
}

// ─── Collection Schema ───────────────────────────────────────────────

/**
 * A collection of PM items with metadata about the sync/import operation.
 * This is what an adapter returns after fetching items from a PM tool.
 */
export const PmItemCollectionSchema = z.object({
  /** The adapter that produced this collection */
  adapter: z.string().min(1),

  /** ISO 8601 timestamp of when this collection was fetched */
  fetchedAt: z.string().datetime(),

  /** The items in this collection */
  items: z.array(PmItemSchema),

  /** Total count in the source (may exceed items.length if paginated) */
  totalCount: z.number().int().nonnegative(),

  /** Whether there are more items available (pagination) */
  hasMore: z.boolean().default(false),

  /** Opaque cursor for fetching the next page, if hasMore is true */
  cursor: z.string().optional(),
});

export type PmItemCollection = z.infer<typeof PmItemCollectionSchema>;

// ─── Utilities ───────────────────────────────────────────────────────

/**
 * Generates a UUID v4 identifier.
 * Uses crypto.randomUUID when available, falls back to a simple implementation.
 */
function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Type guard: checks if a string is a valid PmItemType.
 */
export function isPmItemType(value: string): value is PmItemType {
  return PmItemTypeSchema.safeParse(value).success;
}

/**
 * Type guard: checks if a string is a valid PmStatus.
 */
export function isPmStatus(value: string): value is PmStatus {
  return PmStatusSchema.safeParse(value).success;
}

/**
 * Type guard: checks if a string is a valid PmPriority.
 */
export function isPmPriority(value: string): value is PmPriority {
  return PmPrioritySchema.safeParse(value).success;
}

/**
 * Validates a raw object against the PmItem schema.
 * Returns a discriminated result (success/error) rather than throwing.
 */
export function validatePmItem(data: unknown): z.SafeParseReturnType<unknown, PmItem> {
  return PmItemSchema.safeParse(data);
}
