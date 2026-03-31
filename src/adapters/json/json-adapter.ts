/**
 * Generic JSON PM Adapter
 *
 * A PM-tool-agnostic adapter that consumes structured JSON data representing
 * projects, items, and terminology. This serves three key use cases:
 *
 * 1. **Cold-start bootstrap**: Organizations with no PM tool integration can
 *    provide a JSON file describing their projects, features, and terminology
 *    to get immediate value from Lingo.
 *
 * 2. **Testing & development**: Developers can use JSON fixtures instead of
 *    live PM tool APIs for deterministic, offline testing.
 *
 * 3. **Import from any source**: Any tool that can export to JSON (CSV→JSON,
 *    spreadsheet→JSON, custom scripts) can feed data into Lingo through
 *    this adapter.
 *
 * Data flow:
 *   JSON data (file or in-memory) → JsonAdapter → PMProject[] / PMItem[]
 *   → normalizeToTerms() → NormalizedTerm[] → glossary import
 *
 * The adapter validates the incoming JSON structure and provides clear error
 * messages for malformed data, making it easy for organizations to author
 * their initial terminology mappings.
 */

import type {
  PMAdapter,
  PMProject,
  PMItem,
  PMItemType,
  PMItemKind,
  PMItemStatus,
  PMStatusCategory,
  PMFieldValue,
  NormalizedTerm,
  ExtractionOptions,
  ExtractionResult,
  ExtractionStats,
  ConnectionStatus,
  PaginationOptions,
  PaginatedResult,
  PMItemFilterOptions,
  PMTermCandidate,
  PMTermExtractionOptions,
} from "../types.js";

import { PMAdapterError } from "../types.js";

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Configuration for the JSON adapter.
 *
 * The adapter accepts PM data either inline (via `data`) or as a file
 * path (via `filePath`). Inline data takes precedence if both are provided.
 */
export interface JsonAdapterConfig {
  /**
   * Inline PM data to use directly.
   * Takes precedence over `filePath` if both are provided.
   */
  data?: JsonPMData;

  /**
   * Path to a JSON file containing PM data.
   * Used only if `data` is not provided.
   */
  filePath?: string;

  /**
   * Default PMItemType for items that don't specify a type.
   * Default: "task"
   */
  defaultItemType?: PMItemType;

  /**
   * Organization name for source attribution.
   * Default: "json-import"
   */
  organizationName?: string;
}

// ─── Input JSON Schemas ─────────────────────────────────────────────

/**
 * The top-level structure of JSON PM data.
 *
 * Organizations provide this structure (as a file or inline data)
 * to bootstrap Lingo with their terminology and project information.
 */
export interface JsonPMData {
  /** Organization or workspace name */
  organization?: string;

  /** Array of project definitions */
  projects?: JsonProject[];

  /** Array of item definitions (items without a project are assigned to a default project) */
  items?: JsonItem[];
}

/**
 * A project definition in the JSON input.
 * Minimal required fields: `id` and `name`.
 */
export interface JsonProject {
  /** Unique identifier for this project */
  id: string;

  /** Human-readable project name */
  name: string;

  /** Optional description */
  description?: string;

  /** Optional URL */
  url?: string;

  /** ISO 8601 timestamp of last modification */
  updatedAt?: string;

  /** Optional key-value metadata */
  metadata?: Record<string, unknown>;

  /** Items belonging to this project (alternative to top-level `items` with `projectId`) */
  items?: JsonItem[];
}

/**
 * An item definition in the JSON input.
 *
 * The adapter normalizes this flexible input format into the canonical
 * PMItem structure, applying defaults where fields are omitted.
 */
export interface JsonItem {
  /** Unique identifier (auto-generated if omitted) */
  id?: string;

  /** Item title (required) */
  title: string;

  /** Description or body text */
  description?: string;

  /**
   * Item type — accepts both legacy PMItemType values and PMItemKind values.
   * If omitted, defaults to the adapter's `defaultItemType`.
   */
  type?: string;

  /** Status label (free-form string, normalized into PMStatusCategory) */
  status?: string;

  /** Labels/tags */
  labels?: string[];

  /** Assignee names */
  assignees?: string[];

  /** Project ID this item belongs to */
  projectId?: string;

  /** Parent item ID for hierarchical relationships */
  parentId?: string;

  /** URL linking to this item */
  url?: string;

  /** ISO 8601 creation timestamp */
  createdAt?: string;

  /** ISO 8601 last-modified timestamp */
  updatedAt?: string;

  /** Key-value custom fields */
  customFields?: Record<string, unknown>;

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

// ─── Type Mapping ───────────────────────────────────────────────────

/**
 * Maps string type labels to PMItemType.
 * Case-insensitive matching.
 */
const TYPE_MAPPING: Record<string, PMItemType> = {
  epic: "epic",
  feature: "feature",
  story: "story",
  "user story": "story",
  "user-story": "story",
  task: "task",
  subtask: "task",
  bug: "bug",
  issue: "bug",
  defect: "bug",
  label: "label",
  status: "status",
  workflow: "workflow",
  project: "project",
  milestone: "milestone",
  page: "custom",
  initiative: "epic",
  custom: "custom",
};

/**
 * Maps PMItemType to PMItemKind for the enhanced domain model.
 */
const KIND_MAPPING: Partial<Record<PMItemType, PMItemKind>> = {
  epic: "epic",
  story: "story",
  bug: "bug",
  task: "task",
  feature: "task",
  milestone: "milestone",
};

/**
 * Maps free-form status strings to PMStatusCategory.
 * Case-insensitive matching.
 */
const STATUS_MAPPING: Record<string, PMStatusCategory> = {
  backlog: "todo",
  todo: "todo",
  "to do": "todo",
  "to-do": "todo",
  open: "todo",
  new: "todo",
  planned: "todo",
  "not started": "todo",

  "in progress": "in_progress",
  "in-progress": "in_progress",
  "in development": "in_progress",
  active: "in_progress",
  started: "in_progress",
  working: "in_progress",
  doing: "in_progress",

  "in review": "in_progress",
  "in-review": "in_progress",
  review: "in_progress",
  testing: "in_progress",
  qa: "in_progress",

  done: "done",
  completed: "done",
  closed: "done",
  resolved: "done",
  shipped: "done",
  released: "done",
  finished: "done",

  cancelled: "cancelled",
  canceled: "cancelled",
  "won't fix": "cancelled",
  "wont fix": "cancelled",
  "won't do": "cancelled",
  abandoned: "cancelled",
  rejected: "cancelled",
  duplicate: "cancelled",
};

// ─── JSON Adapter ───────────────────────────────────────────────────

export class JsonAdapter implements PMAdapter {
  readonly name = "json";
  readonly displayName = "JSON Import";

  private readonly config: JsonAdapterConfig;

  /** Resolved PM data (loaded from file or provided inline) */
  private resolvedData: ResolvedPMData | null = null;

  constructor(config: JsonAdapterConfig) {
    this.config = config;
  }

  // ─── Connection ────────────────────────────────────────────────────

  async testConnection(): Promise<ConnectionStatus> {
    try {
      const data = await this.loadData();
      return {
        connected: true,
        message: `JSON adapter loaded: ${data.projects.length} project(s), ${data.items.length} item(s)`,
        details: {
          organization: data.organization,
          projectCount: data.projects.length,
          itemCount: data.items.length,
        },
      };
    } catch (err) {
      return {
        connected: false,
        message: `Failed to load JSON data: ${(err as Error).message}`,
        details: { error: (err as Error).message },
      };
    }
  }

  // ─── Projects ──────────────────────────────────────────────────────

  async listProjects(
    options?: PaginationOptions
  ): Promise<PaginatedResult<PMProject>> {
    const data = await this.loadData();

    const pageSize = options?.pageSize ?? 100;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = data.projects.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < data.projects.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(startIndex + pageSize) : undefined,
      totalCount: data.projects.length,
    };
  }

  async getProject(projectId: string): Promise<PMProject | undefined> {
    const data = await this.loadData();
    return data.projects.find((p) => p.externalId === projectId);
  }

  // ─── Items ─────────────────────────────────────────────────────────

  async listItems(
    projectId: string,
    options?: PMItemFilterOptions
  ): Promise<PaginatedResult<PMItem>> {
    const data = await this.loadData();
    let filtered = data.items.filter((i) => i.projectId === projectId);

    // Apply status filter
    if (options?.statusCategory) {
      filtered = filtered.filter(
        (i) => i.status.category === options.statusCategory
      );
    }

    // Apply label filter
    if (options?.labels?.length) {
      filtered = filtered.filter((i) =>
        i.labels.some((l) => options.labels!.includes(l))
      );
    }

    // Apply updatedAfter filter
    if (options?.updatedAfter) {
      filtered = filtered.filter(
        (i) => i.updatedAt && i.updatedAt >= options.updatedAfter!
      );
    }

    // Apply search query filter
    if (options?.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      filtered = filtered.filter(
        (i) =>
          i.title.toLowerCase().includes(query) ||
          (i.description?.toLowerCase().includes(query) ?? false)
      );
    }

    const pageSize = options?.pageSize ?? 100;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = filtered.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < filtered.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(startIndex + pageSize) : undefined,
    };
  }

  async getItem(itemId: string): Promise<PMItem | undefined> {
    const data = await this.loadData();
    return data.items.find((i) => i.externalId === itemId);
  }

  // ─── Terminology Pipeline ─────────────────────────────────────────

  async extractItems(options?: ExtractionOptions): Promise<PMItem[]> {
    const data = await this.loadData();
    let items = [...data.items];

    // Apply project filter
    if (options?.project) {
      items = items.filter((i) => i.projectId === options.project);
    }

    // Apply type filter
    if (options?.itemTypes?.length) {
      items = items.filter((i) => options.itemTypes!.includes(i.type));
    }

    // Apply modifiedAfter filter
    if (options?.modifiedAfter) {
      items = items.filter(
        (i) => i.updatedAt && i.updatedAt >= options.modifiedAfter!
      );
    }

    // Apply includeArchived filter
    if (!options?.includeArchived) {
      items = items.filter((i) => !i.metadata.archived);
    }

    // Apply maxItems limit
    if (options?.maxItems && items.length > options.maxItems) {
      items = items.slice(0, options.maxItems);
    }

    return items;
  }

  normalizeToTerms(items: PMItem[]): NormalizedTerm[] {
    const terms: NormalizedTerm[] = [];
    const seen = new Set<string>();

    for (const item of items) {
      // Skip items with empty titles
      if (!item.title.trim()) {
        continue;
      }

      // Deduplicate by name (case-insensitive)
      const key = item.title.toLowerCase().trim();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      terms.push(this.normalizeItem(item));
    }

    return terms;
  }

  async extract(options?: ExtractionOptions): Promise<ExtractionResult> {
    const startTime = performance.now();
    const warnings: string[] = [];

    let items: PMItem[];
    try {
      items = await this.extractItems(options);
    } catch (err) {
      warnings.push(`Extraction error: ${(err as Error).message}`);
      items = [];
    }

    const terms = this.normalizeToTerms(items);
    const durationMs = performance.now() - startTime;

    // Compute stats
    const itemsByType: Partial<Record<PMItemType, number>> = {};
    for (const item of items) {
      itemsByType[item.type] = (itemsByType[item.type] ?? 0) + 1;
    }

    const stats: ExtractionStats = {
      itemsFetched: items.length,
      termsProduced: terms.length,
      itemsSkipped: items.length - terms.length,
      durationMs,
      itemsByType,
    };

    return {
      adapterName: this.name,
      extractedAt: new Date().toISOString(),
      terms,
      stats,
      warnings,
    };
  }

  async extractTerminology(
    projectId: string,
    options?: PMTermExtractionOptions
  ): Promise<PMTermCandidate[]> {
    const data = await this.loadData();
    let projectItems = data.items.filter((i) => i.projectId === projectId);

    // Apply maxItems limit
    if (options?.maxItems) {
      projectItems = projectItems.slice(0, options.maxItems);
    }

    const termMap = new Map<string, PMTermCandidate>();

    for (const item of projectItems) {
      if (!item.title.trim()) continue;

      // Skip description-only analysis if disabled
      const includeDescriptions = options?.includeDescriptions !== false;

      const key = item.title.toLowerCase().trim();
      const existing = termMap.get(key);

      if (existing) {
        existing.frequency++;
        if (!existing.source.itemIds.includes(item.externalId)) {
          existing.source.itemIds.push(item.externalId);
        }
        // Merge context from description if richer
        if (
          includeDescriptions &&
          item.description &&
          item.description.length > existing.contextSnippet.length
        ) {
          existing.contextSnippet = item.description.slice(0, 200);
        }
      } else {
        const contextSnippet =
          includeDescriptions && item.description
            ? item.description.slice(0, 200)
            : `${item.type} in ${item.project ?? "unknown project"}`;

        termMap.set(key, {
          term: item.title.trim(),
          contextSnippet,
          source: {
            adapter: this.name,
            projectId,
            itemIds: [item.externalId],
            url: item.url,
          },
          frequency: 1,
          suggestedCategory: item.project ?? undefined,
          suggestedAliases: [],
        });
      }
    }

    const minFrequency = options?.minFrequency ?? 1;
    return Array.from(termMap.values())
      .filter((t) => t.frequency >= minFrequency)
      .sort((a, b) => b.frequency - a.frequency);
  }

  // ─── Data Loading ─────────────────────────────────────────────────

  /**
   * Load and resolve PM data from inline config or file.
   * Results are cached after first load.
   */
  private async loadData(): Promise<ResolvedPMData> {
    if (this.resolvedData) {
      return this.resolvedData;
    }

    let rawData: JsonPMData;

    if (this.config.data) {
      rawData = this.config.data;
    } else if (this.config.filePath) {
      rawData = await this.loadFromFile(this.config.filePath);
    } else {
      // Empty data — valid for an unconfigured adapter
      rawData = {};
    }

    this.resolvedData = this.resolveData(rawData);
    return this.resolvedData;
  }

  /**
   * Load JSON data from a file path.
   */
  private async loadFromFile(filePath: string): Promise<JsonPMData> {
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as JsonPMData;
    } catch (err) {
      throw new PMAdapterError(
        `Failed to load JSON data from "${filePath}": ${(err as Error).message}`,
        "PARSE_ERROR",
        this.name,
        err
      );
    }
  }

  /**
   * Resolve raw JSON data into the internal format.
   * - Creates a default project if items exist without projects
   * - Normalizes item types and statuses
   * - Assigns auto-generated IDs where missing
   */
  private resolveData(raw: JsonPMData): ResolvedPMData {
    const orgName =
      raw.organization ??
      this.config.organizationName ??
      "json-import";

    // Build projects
    const projects: PMProject[] = (raw.projects ?? []).map((p) =>
      this.resolveProject(p)
    );

    // Build items from both top-level items and project-embedded items
    const items: PMItem[] = [];

    // Items embedded in projects
    for (const jp of raw.projects ?? []) {
      if (jp.items?.length) {
        for (const ji of jp.items) {
          items.push(this.resolveItem(ji, jp.id, jp.name));
        }
      }
    }

    // Top-level items
    for (const ji of raw.items ?? []) {
      const projectId = ji.projectId ?? "default";
      const project = projects.find((p) => p.externalId === projectId);
      items.push(this.resolveItem(ji, projectId, project?.name));
    }

    // Ensure a default project exists if there are orphan items
    const hasOrphans = items.some(
      (i) => i.projectId === "default" && !projects.some((p) => p.externalId === "default")
    );
    if (hasOrphans) {
      projects.push({
        externalId: "default",
        name: orgName,
        description: "Default project for items without an explicit project",
        metadata: { isDefault: true },
      });
    }

    return {
      organization: orgName,
      projects,
      items,
    };
  }

  /**
   * Convert a JSON project definition to a PMProject.
   */
  private resolveProject(jp: JsonProject): PMProject {
    return {
      externalId: jp.id,
      name: jp.name,
      description: jp.description,
      url: jp.url,
      externalUrl: jp.url,
      updatedAt: jp.updatedAt,
      metadata: jp.metadata ?? {},
    };
  }

  /**
   * Convert a JSON item definition to a PMItem.
   */
  private resolveItem(
    ji: JsonItem,
    projectId: string,
    projectName?: string
  ): PMItem {
    const defaultType = this.config.defaultItemType ?? "task";
    const type = ji.type
      ? mapType(ji.type, defaultType)
      : defaultType;
    const kind: PMItemKind = KIND_MAPPING[type] ?? "other";
    const status = resolveStatus(ji.status);
    const customFields = resolveCustomFields(ji.customFields);

    return {
      externalId: ji.id ?? generateItemId(),
      title: ji.title,
      description: ji.description,
      type,
      kind,
      status,
      url: ji.url,
      externalUrl: ji.url,
      labels: ji.labels ?? [],
      assignees: ji.assignees ?? [],
      projectId,
      project: projectName,
      parentId: ji.parentId,
      createdAt: ji.createdAt,
      updatedAt: ji.updatedAt,
      customFields,
      metadata: ji.metadata ?? {},
    };
  }

  // ─── Normalization ────────────────────────────────────────────────

  /**
   * Convert a single PMItem into a NormalizedTerm.
   */
  private normalizeItem(item: PMItem): NormalizedTerm {
    const definition = this.buildDefinition(item);
    const tags = this.buildTags(item);

    return {
      name: item.title.trim(),
      definition,
      aliases: [],
      category: item.project ?? undefined,
      tags,
      source: {
        adapter: this.name,
        externalId: item.externalId,
        url: item.url,
      },
      confidence: "ai-suggested",
    };
  }

  /**
   * Build a human-readable definition from item fields.
   */
  private buildDefinition(item: PMItem): string {
    if (item.description) {
      const maxLen = 500;
      return item.description.length > maxLen
        ? item.description.slice(0, maxLen) + "..."
        : item.description;
    }

    // Generate a synthetic definition from metadata
    const parts: string[] = [];
    const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
    parts.push(`${typeLabel} from JSON import`);

    if (item.project) {
      parts.push(`in project "${item.project}"`);
    }

    if (item.status.originalLabel) {
      parts.push(`(status: ${item.status.originalLabel})`);
    }

    return parts.join(" ") + ".";
  }

  /**
   * Build tags from item metadata.
   */
  private buildTags(item: PMItem): string[] {
    const tags: string[] = [...item.labels];
    tags.push(item.type);
    tags.push("json-import");

    if (item.status.originalLabel) {
      tags.push(
        `status:${item.status.originalLabel.toLowerCase().replace(/\s+/g, "-")}`
      );
    }

    return [...new Set(tags)]; // Deduplicate
  }

  /**
   * Force reload of data on next access.
   * Useful for testing or when the underlying data source has changed.
   */
  reload(): void {
    this.resolvedData = null;
  }
}

// ─── Internal Types ─────────────────────────────────────────────────

/**
 * Resolved PM data after normalization.
 */
interface ResolvedPMData {
  organization: string;
  projects: PMProject[];
  items: PMItem[];
}

// ─── Utility Functions ──────────────────────────────────────────────

/**
 * Map a free-form type string to a PMItemType.
 */
function mapType(typeStr: string, fallback: PMItemType): PMItemType {
  const normalized = typeStr.toLowerCase().trim();
  return TYPE_MAPPING[normalized] ?? fallback;
}

/**
 * Resolve a free-form status string to a PMItemStatus.
 */
function resolveStatus(statusStr?: string): PMItemStatus {
  if (!statusStr) {
    return { category: "unknown", originalLabel: "" };
  }

  const normalized = statusStr.toLowerCase().trim();
  const category = STATUS_MAPPING[normalized] ?? "unknown";

  return { category, originalLabel: statusStr };
}

/**
 * Convert raw custom fields to typed PMFieldValue records.
 */
function resolveCustomFields(
  raw?: Record<string, unknown>
): Record<string, PMFieldValue> {
  if (!raw) return {};

  const result: Record<string, PMFieldValue> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      result[key] = { type: "string", value };
    } else if (typeof value === "number") {
      result[key] = { type: "number", value };
    } else if (typeof value === "boolean") {
      result[key] = { type: "boolean", value };
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      result[key] = { type: "multi_select", value: value as string[] };
    } else {
      result[key] = { type: "unknown", value };
    }
  }

  return result;
}

let itemCounter = 0;

/**
 * Generate a sequential item ID for items without explicit IDs.
 */
function generateItemId(): string {
  return `json-item-${++itemCounter}`;
}

/**
 * Reset the item counter. Useful for testing.
 * @internal
 */
export function resetItemCounter(): void {
  itemCounter = 0;
}
