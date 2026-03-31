/**
 * PM Tool Adapter — Abstract Interface & Shared Types
 *
 * Defines the contract that all PM tool adapters must implement.
 * Following the adapter pattern, this decouples the core Lingo logic
 * from any specific PM tool (Notion, Linear, Jira, etc.).
 *
 * Data flow:
 *   PM Tool API → PMAdapter.listProjects() → PMProject[]
 *                → PMAdapter.listItems()    → PMItem[]
 *                → PMAdapter.extractItems() → PMItem[] → PMAdapter.normalizeToTerms() → NormalizedTerm[]
 *
 * NormalizedTerms are then fed into the GlossaryStorage to create GlossaryTerms.
 *
 * Layers:
 * - **Projects**: Top-level containers (databases, boards, workspaces)
 * - **Items**: Work units within projects (tasks, stories, epics, pages)
 * - **Terminology**: Organizational vocabulary extracted from items
 */

import type { TermSource, ConfidenceLevel } from "../models/glossary.js";

// ─── Pagination ──────────────────────────────────────────────────────

/**
 * Options for paginating through list results.
 */
export interface PaginationOptions {
  /** Maximum number of items to return per page */
  pageSize?: number;

  /** Opaque cursor returned by a previous page to fetch the next one */
  cursor?: string;
}

/**
 * A paginated response wrapping a list of items.
 */
export interface PaginatedResult<T> {
  /** The items for this page */
  items: T[];

  /** Cursor to fetch the next page, or `undefined` if this is the last page */
  nextCursor?: string;

  /** Whether there are more pages available */
  hasMore: boolean;

  /** Total count of items across all pages, if the PM tool provides it */
  totalCount?: number;
}

// ─── PM Project ──────────────────────────────────────────────────────

/**
 * A project, workspace, or database in the PM tool — the top-level
 * container that holds items.
 *
 * What constitutes a "project" depends on the tool:
 * - Notion: databases
 * - Linear: projects or teams
 * - Jira: projects
 */
export interface PMProject {
  /** Identifier in the external PM system */
  externalId: string;

  /** Human-readable project name */
  name: string;

  /** Optional description of the project */
  description?: string;

  /** URL to open this project in the PM tool's UI */
  url?: string;

  /** URL to open this project in the PM tool's UI (alias for `url`) */
  externalUrl?: string;

  /** ISO 8601 timestamp of when this project was last modified */
  updatedAt?: string;

  /** Adapter-specific data that doesn't fit the common model */
  metadata: Record<string, unknown>;
}

// ─── PM Field Values ─────────────────────────────────────────────────

/**
 * A value extracted from a PM item's custom field.
 * Wrapped in a discriminated union so consumers can handle each type safely.
 */
export type PMFieldValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "date"; value: string }           // ISO 8601
  | { type: "select"; value: string }          // Single-select option label
  | { type: "multi_select"; value: string[] }  // Multi-select option labels
  | { type: "url"; value: string }
  | { type: "unknown"; value: unknown };

// ─── PM Adapter Configuration ────────────────────────────────────────

/**
 * Base configuration that every PM adapter requires.
 * Concrete adapters extend this with tool-specific fields
 * (e.g., Notion adds `integrationToken`, Linear adds `apiKey`).
 */
export interface PMAdapterConfig {
  /** Human-readable name for this adapter instance (e.g., "notion", "linear") */
  adapterName: string;

  /** Base URL override for self-hosted instances (optional for SaaS tools) */
  baseUrl?: string;

  /** Request timeout in milliseconds (default: 30_000) */
  timeoutMs?: number;

  /** Adapter-specific configuration (API keys go here in concrete configs) */
  options: Record<string, unknown>;
}

// ─── PM Adapter Error ────────────────────────────────────────────────

/**
 * Error codes specific to PM adapter operations.
 */
export type PMAdapterErrorCode =
  | "AUTH_FAILED"       // Authentication or authorization failure
  | "NOT_FOUND"         // Requested resource does not exist
  | "RATE_LIMITED"      // API rate limit exceeded
  | "NETWORK_ERROR"     // Network connectivity issue
  | "INVALID_CONFIG"    // Adapter configuration is invalid
  | "PARSE_ERROR"       // Failed to parse response from PM tool
  | "UNSUPPORTED"       // Operation not supported by this adapter
  | "UNKNOWN";          // Catch-all for unexpected errors

/**
 * Error thrown by PM adapter operations.
 * Carries a typed error code so callers can handle different failures appropriately.
 */
export class PMAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: PMAdapterErrorCode,
    public readonly adapterName: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PMAdapterError";
  }
}

// ─── Identifiers ────────────────────────────────────────────────────

/**
 * Opaque string identifier in the external PM system.
 * Each adapter decides the format (UUID, slug, numeric, etc.).
 */
export type ExternalId = string;

// ─── PM Item Types ──────────────────────────────────────────────────

/**
 * Classification of items found in a PM tool.
 * Maps the diverse item types from different tools into a common vocabulary.
 *
 * @deprecated Use `PMItemKind` for the enhanced PM domain model.
 * Retained for backward compatibility with the extraction pipeline.
 */
export type PMItemType =
  | "epic"       // Large, multi-sprint initiative
  | "feature"    // A user-facing capability
  | "story"      // User story or use case
  | "task"       // Granular work item
  | "bug"        // Defect or issue
  | "label"      // A tag or label applied to items
  | "status"     // A workflow status (e.g., "In Review", "Done")
  | "workflow"   // A workflow definition or process
  | "project"    // A project grouping
  | "milestone"  // A milestone or release target
  | "custom";    // Anything that doesn't fit the above

/**
 * The kind of item within a PM project.
 * Not every PM tool uses all kinds — adapters map to the closest match.
 *
 * This is the enhanced classification for the unified PM domain model.
 */
export type PMItemKind =
  | "task"        // A work item / ticket / issue
  | "epic"        // A grouping of related tasks
  | "story"       // A user story
  | "bug"         // A defect report
  | "page"        // A documentation/wiki page (Notion pages, Confluence)
  | "milestone"   // A milestone or release target
  | "other";      // Catch-all for adapter-specific kinds

/**
 * A raw item extracted from a PM tool before normalization.
 * This is the intermediate representation between PM tool API responses
 * and the normalized terms that Lingo uses internally.
 *
 * The `type` field uses the legacy PMItemType for the extraction pipeline,
 * while `kind` uses the enhanced PMItemKind for the unified domain model.
 * Adapters should populate both fields.
 */
export interface PMItem {
  /** The item's unique identifier in the source PM tool */
  externalId: string;

  /** The item's title or name */
  title: string;

  /** Optional description or body text */
  description?: string;

  /**
   * Legacy item type classification.
   * @deprecated Use `kind` for new code.
   */
  type: PMItemType;

  /**
   * Enhanced item kind classification.
   * Maps to the unified PM domain model.
   */
  kind: PMItemKind;

  /** Normalized status of the item */
  status: PMItemStatus;

  /** URL linking back to this item in the source tool */
  url?: string;

  /** URL linking back to this item (alias for `url`, used in enhanced model) */
  externalUrl?: string;

  /** Labels or tags applied to this item in the source tool */
  labels: string[];

  /** Assignee display names (empty array if unassigned) */
  assignees: string[];

  /** The parent project's external ID */
  projectId: ExternalId;

  /** The project, database, or workspace this item belongs to (display name) */
  project?: string;

  /** Parent item ID for hierarchical relationships */
  parentId?: string;

  /** ISO 8601 timestamp of creation */
  createdAt?: string;

  /** ISO 8601 timestamp of last modification */
  updatedAt?: string;

  /** Key-value pairs from custom/additional fields the adapter exposes */
  customFields: Record<string, PMFieldValue>;

  /** Arbitrary metadata from the source tool */
  metadata: Record<string, unknown>;
}

// ─── PM Item Status ──────────────────────────────────────────────────

/**
 * Broad status categories that every PM tool can map into.
 */
export type PMStatusCategory =
  | "todo"
  | "in_progress"
  | "done"
  | "cancelled"
  | "unknown";

/**
 * Normalized status of a PM item.
 * Adapters map tool-specific statuses (e.g., "In Review") into category buckets
 * while preserving the original label.
 */
export interface PMItemStatus {
  /** Tool-agnostic category */
  category: PMStatusCategory;

  /** The original status label from the PM tool (e.g., "In Review", "Backlog") */
  originalLabel: string;
}

// ─── PM Item Filter Options ──────────────────────────────────────────

/**
 * Options for filtering items when listing them from a project.
 * All fields are optional — adapters apply whatever subset they support.
 */
export interface PMItemFilterOptions extends PaginationOptions {
  /** Filter by status category (e.g., only "in_progress" items) */
  statusCategory?: PMStatusCategory;

  /** Filter by label(s) — items must have at least one matching label */
  labels?: string[];

  /** Only return items updated after this ISO 8601 timestamp */
  updatedAfter?: string;

  /** Full-text search query (adapter-dependent support) */
  searchQuery?: string;
}

// ─── PM Term Candidate ───────────────────────────────────────────────

/**
 * A terminology candidate extracted directly from PM content.
 *
 * This is the bridge between PM data and Lingo's glossary: the adapter
 * scans project items and surfaces phrases/concepts that likely represent
 * organizational vocabulary. Unlike NormalizedTerm (which is ready for
 * glossary import), this is a raw candidate that may need AI enrichment.
 */
export interface PMTermCandidate {
  /** The term or phrase as it appears in the PM content */
  term: string;

  /** A definition or context snippet explaining what this term means */
  contextSnippet: string;

  /** Which adapter and project produced this candidate */
  source: {
    adapter: string;
    projectId: string;
    itemIds: string[];
    url?: string;
  };

  /** How many times this term appeared across scanned items */
  frequency: number;

  /** Optional category/domain inferred from PM structure (labels, project name) */
  suggestedCategory?: string;

  /** Optional aliases discovered (e.g., abbreviations used in the same context) */
  suggestedAliases: string[];
}

// ─── Term Extraction Options ─────────────────────────────────────────

/**
 * Options for terminology extraction — controls what the adapter
 * analyzes and how aggressively it surfaces candidates.
 */
export interface PMTermExtractionOptions {
  /**
   * Maximum number of items to scan for terminology.
   * Useful for large projects where scanning everything would be slow.
   * Default: adapter-specific (typically 100–500).
   */
  maxItems?: number;

  /**
   * Whether to include item descriptions/body content in analysis
   * (not just titles and labels). Default: true.
   */
  includeDescriptions?: boolean;

  /**
   * Minimum number of occurrences for a term to be surfaced.
   * Helps filter out one-off phrases. Default: 1.
   */
  minFrequency?: number;
}

// ─── Normalized Term ────────────────────────────────────────────────

/**
 * A normalized term extracted from a PM tool, ready to be imported
 * into the glossary as a GlossaryTerm.
 *
 * This is the standardized output of any PM adapter — regardless of
 * whether the source is Notion, Linear, Jira, or any other tool.
 */
export interface NormalizedTerm {
  /** The canonical name for this term */
  name: string;

  /** Human-readable definition of what this term means */
  definition: string;

  /** Alternative names or abbreviations */
  aliases: string[];

  /** Optional domain/category grouping */
  category?: string;

  /** Tags for flexible classification */
  tags: string[];

  /** Where this term originated (adapter name + external ID) */
  source: TermSource;

  /** Confidence level — typically "ai-suggested" for PM-extracted terms */
  confidence: ConfidenceLevel;
}

// ─── Extraction Options ─────────────────────────────────────────────

/**
 * Options controlling what gets extracted from a PM tool.
 * Adapters should support these options where the underlying API allows.
 */
export interface ExtractionOptions {
  /**
   * Filter by PM item types.
   * If empty or undefined, extract all supported types.
   */
  itemTypes?: PMItemType[];

  /**
   * Filter by project/database name or ID.
   * Interpretation is adapter-specific.
   */
  project?: string;

  /**
   * Maximum number of items to extract.
   * Useful for testing or limiting API calls.
   * Default: no limit (adapter-specific).
   */
  maxItems?: number;

  /**
   * Only extract items modified after this date.
   * ISO 8601 timestamp string.
   */
  modifiedAfter?: string;

  /**
   * Whether to include archived/completed items.
   * Default: false
   */
  includeArchived?: boolean;
}

// ─── Extraction Result ──────────────────────────────────────────────

/**
 * Summary statistics from an extraction operation.
 */
export interface ExtractionStats {
  /** Total items fetched from the PM tool API */
  itemsFetched: number;

  /** Items successfully normalized into terms */
  termsProduced: number;

  /** Items skipped (e.g., empty titles, duplicates) */
  itemsSkipped: number;

  /** Duration of the extraction in milliseconds */
  durationMs: number;

  /** Breakdown by PM item type */
  itemsByType: Partial<Record<PMItemType, number>>;
}

/**
 * The complete result of an extraction + normalization operation.
 */
export interface ExtractionResult {
  /** The adapter that performed the extraction */
  adapterName: string;

  /** When the extraction completed (ISO 8601) */
  extractedAt: string;

  /** The normalized terms ready for glossary import */
  terms: NormalizedTerm[];

  /** Statistics about the extraction */
  stats: ExtractionStats;

  /** Any warnings encountered during extraction */
  warnings: string[];
}

// ─── Adapter Interface ──────────────────────────────────────────────

/**
 * Connection status returned by testConnection().
 */
export interface ConnectionStatus {
  /** Whether the connection was successful */
  connected: boolean;

  /** Human-readable message about the connection status */
  message: string;

  /** Additional details (e.g., workspace name, user info) */
  details?: Record<string, unknown>;
}

/**
 * The core adapter interface that all PM tool adapters must implement.
 *
 * Design contract:
 * 1. Adapters are stateless between calls (no session management)
 * 2. Authentication is handled via config passed to the constructor
 * 3. Project methods provide top-level container access
 * 4. Item methods provide paginated access to work items
 * 5. extractItems() + normalizeToTerms() form the terminology pipeline
 * 6. extractTerminology() surfaces raw term candidates for AI enrichment
 *
 * The interface has two layers:
 * - **Data access**: listProjects, getProject, listItems, getItem
 * - **Terminology**: extractItems, normalizeToTerms, extract, extractTerminology
 *
 * Implementing a new adapter:
 * ```typescript
 * class LinearAdapter implements PMAdapter {
 *   name = "linear";
 *   // ... implement all methods
 * }
 * ```
 */
export interface PMAdapter {
  /** Unique identifier for this adapter (e.g., "notion", "linear", "jira") */
  readonly name: string;

  /** Human-readable display name (e.g., "Notion", "Linear", "Jira") */
  readonly displayName: string;

  // ─── Connection ──────────────────────────────────────────────────

  /**
   * Test connectivity to the PM tool.
   * Verifies that the adapter's configuration (API keys, etc.) is valid
   * and that the target PM tool is reachable.
   */
  testConnection(): Promise<ConnectionStatus>;

  // ─── Projects ────────────────────────────────────────────────────

  /**
   * List available projects/databases/workspaces.
   *
   * Returns a paginated list of top-level containers in the PM tool.
   * What constitutes a "project" depends on the tool:
   * - Notion: databases
   * - Linear: projects or teams
   * - Jira: projects
   *
   * @param options - Pagination options
   * @returns Paginated list of projects
   * @throws PMAdapterError on auth, network, or parse failures
   */
  listProjects(options?: PaginationOptions): Promise<PaginatedResult<PMProject>>;

  /**
   * Fetch a single project by its external ID.
   *
   * @param projectId - The project's identifier in the PM tool
   * @returns The project, or `undefined` if not found
   * @throws PMAdapterError on auth, network, or parse failures
   */
  getProject(projectId: string): Promise<PMProject | undefined>;

  // ─── Items ───────────────────────────────────────────────────────

  /**
   * List items within a project, with optional filtering and pagination.
   *
   * This is the primary data-fetching method for browsing project content.
   * Items include tasks, stories, epics, pages, etc.
   *
   * @param projectId - The project to list items from
   * @param options - Filtering and pagination options
   * @returns Paginated list of items
   * @throws PMAdapterError if the project is not found or on API errors
   */
  listItems(
    projectId: string,
    options?: PMItemFilterOptions
  ): Promise<PaginatedResult<PMItem>>;

  /**
   * Fetch a single item by its external ID.
   *
   * @param itemId - The item's identifier in the PM tool
   * @returns The item, or `undefined` if not found
   * @throws PMAdapterError on auth, network, or parse failures
   */
  getItem(itemId: string): Promise<PMItem | undefined>;

  // ─── Terminology Pipeline ────────────────────────────────────────

  /**
   * Extract raw items from the PM tool.
   * This is the "fetch" step — it retrieves data from the PM tool API
   * and converts it into the intermediate PMItem format.
   *
   * @param options - Filtering and pagination options
   * @returns Array of raw PM items
   */
  extractItems(options?: ExtractionOptions): Promise<PMItem[]>;

  /**
   * Normalize raw PM items into terms suitable for glossary import.
   * This is a pure transformation step — no API calls.
   *
   * @param items - Raw PM items from extractItems()
   * @returns Array of normalized terms
   */
  normalizeToTerms(items: PMItem[]): NormalizedTerm[];

  /**
   * Convenience method: extract items and normalize them in one step.
   * Returns a full ExtractionResult with statistics.
   *
   * @param options - Filtering and pagination options
   * @returns Complete extraction result with terms and stats
   */
  extract(options?: ExtractionOptions): Promise<ExtractionResult>;

  /**
   * Extract terminology candidates from a project's items.
   *
   * Unlike extract() which produces glossary-ready NormalizedTerms,
   * this method surfaces raw term candidates that may need AI enrichment
   * before becoming glossary entries. This supports Lingo's cold-start
   * bootstrap flow.
   *
   * @param projectId - The project to extract terminology from
   * @param options - Controls for the extraction process
   * @returns Array of terminology candidates, sorted by frequency (descending)
   * @throws PMAdapterError if the project is not found or on API errors
   */
  extractTerminology(
    projectId: string,
    options?: PMTermExtractionOptions
  ): Promise<PMTermCandidate[]>;
}
