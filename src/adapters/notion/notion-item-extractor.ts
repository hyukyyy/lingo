/**
 * Notion Planning Item Extractor
 *
 * Queries Notion databases and transforms results into the internal
 * planning item format (PlanningItem). This is the bridge between
 * Notion's API responses and Lingo's rich, normalized PM data model.
 *
 * The extractor handles:
 * - Querying Notion databases with pagination
 * - Auto-detecting property mappings from database schemas
 * - Transforming Notion pages into PlanningItem objects
 * - Normalizing Notion statuses into PMItemStatus (category + original label)
 * - Mapping Notion types into PlanningItemKind
 * - Extracting custom fields from page properties
 * - Converting Notion property values into typed PMFieldValue objects
 *
 * Data flow:
 *   NotionClient.queryDatabase() → NotionPage[] → extractItems() → PlanningItem[]
 *   NotionClient.getDatabase()   → NotionDatabase → listProjects() → PMProject
 *
 * The PlanningItem format is richer than the base PMItem (used in the
 * terminology extraction pipeline). It carries:
 * - Structured status (category + original label) instead of raw string
 * - Semantic kind (epic, story, bug, etc.) instead of the full PMItemType
 * - Assignee list
 * - Typed custom fields (select, number, date, etc.)
 * - Creation/modification timestamps
 * - Database (project) ID reference
 *
 * Usage:
 *   const extractor = new NotionItemExtractor(client, {
 *     propertyMappings: { titleProperty: "Name" },
 *   });
 *
 *   const result = await extractor.extractItems("db-123");
 *   // result.items: PlanningItem[]
 */

import type {
  NotionClient,
  NotionPage,
  NotionPropertyValue,
  NotionDatabase,
  NotionDatabaseProperty,
  NotionRichText,
} from "./notion-client.js";

import type {
  PMItemStatus,
  PMStatusCategory,
  PMFieldValue,
  PMProject,
  PaginatedResult,
  PaginationOptions,
} from "../types.js";

import type { PropertyMappings } from "./notion-adapter.js";

// ─── Planning Item Types ────────────────────────────────────────────

/**
 * The kind of planning item — a semantic classification of work.
 * Maps to the diverse item types from different PM tools.
 */
export type PlanningItemKind =
  | "epic"        // Large, multi-sprint initiative
  | "story"       // User story or use case
  | "task"        // Granular work item (includes "features")
  | "bug"         // Defect or issue
  | "page"        // Documentation or wiki page
  | "milestone"   // A milestone or release target
  | "other";      // Catch-all for unrecognized types

/**
 * A planning item in the internal normalized format.
 *
 * This is the rich representation of a work item extracted from a PM tool.
 * Unlike the simpler PMItem (used in the terminology extraction pipeline),
 * PlanningItem carries structured status, typed custom fields, assignees,
 * and full timestamps — everything needed for deep organizational context.
 */
export interface PlanningItem {
  /** Unique identifier in the source PM tool */
  externalId: string;

  /** Item title / summary */
  title: string;

  /** Full description or body content */
  description?: string;

  /** Semantic kind of this item */
  kind: PlanningItemKind;

  /** Normalized status with category + original label */
  status: PMItemStatus;

  /** Labels, tags, or categories attached to this item */
  labels: string[];

  /** Assignee display names (empty array if unassigned) */
  assignees: string[];

  /** The parent project/database external ID */
  projectId: string;

  /** URL to open this item in the PM tool's UI */
  externalUrl?: string;

  /** ISO 8601 timestamp of creation */
  createdAt?: string;

  /** ISO 8601 timestamp of last modification */
  updatedAt?: string;

  /** Key-value pairs from custom/additional fields */
  customFields: Record<string, PMFieldValue>;

  /** Adapter-specific data that doesn't fit the common model */
  metadata: Record<string, unknown>;
}

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Configuration options for the Notion item extractor.
 */
export interface NotionExtractorConfig {
  /**
   * Explicit property name mappings.
   * When provided, these override auto-detection.
   */
  propertyMappings?: PropertyMappings;

  /**
   * Default item kind when the database page has no type property.
   * Default: "task"
   */
  defaultItemKind?: PlanningItemKind;

  /**
   * Whether to include archived/completed items.
   * Default: false
   */
  includeArchived?: boolean;
}

// ─── Filter Options ─────────────────────────────────────────────────

/**
 * Options for filtering items during extraction.
 */
export interface NotionExtractionFilter {
  /** Only include items with these kinds */
  kinds?: PlanningItemKind[];

  /** Only include items modified after this ISO 8601 timestamp */
  updatedAfter?: string;

  /** Maximum number of items to return */
  maxItems?: number;

  /** Filter by status category */
  statusCategory?: PMStatusCategory;

  /** Pagination cursor for continued extraction */
  cursor?: string;

  /** Page size (max 100 for Notion API) */
  pageSize?: number;
}

// ─── Status Category Mapping ────────────────────────────────────────

/**
 * Maps common Notion status labels to status categories.
 * Case-insensitive matching.
 */
const STATUS_CATEGORY_MAP: Record<string, PMStatusCategory> = {
  // todo
  "not started": "todo",
  backlog: "todo",
  "to do": "todo",
  todo: "todo",
  planned: "todo",
  open: "todo",
  new: "todo",

  // in_progress
  "in progress": "in_progress",
  "in development": "in_progress",
  "in review": "in_progress",
  active: "in_progress",
  doing: "in_progress",
  started: "in_progress",
  wip: "in_progress",
  "work in progress": "in_progress",

  // done
  done: "done",
  complete: "done",
  completed: "done",
  closed: "done",
  resolved: "done",
  shipped: "done",
  released: "done",
  merged: "done",

  // cancelled
  cancelled: "cancelled",
  canceled: "cancelled",
  abandoned: "cancelled",
  "won't do": "cancelled",
  wontfix: "cancelled",
  duplicate: "cancelled",
  rejected: "cancelled",
};

/**
 * Normalize a Notion status label into a PMStatusCategory.
 */
export function normalizeStatusCategory(statusLabel: string): PMStatusCategory {
  const normalized = statusLabel.toLowerCase().trim();
  return STATUS_CATEGORY_MAP[normalized] ?? "unknown";
}

// ─── Kind Mapping ───────────────────────────────────────────────────

/**
 * Maps Notion select/type option names to PlanningItemKind.
 * Case-insensitive matching.
 */
const KIND_MAP: Record<string, PlanningItemKind> = {
  epic: "epic",
  feature: "task", // features are work items
  story: "story",
  "user story": "story",
  task: "task",
  bug: "bug",
  issue: "bug",
  defect: "bug",
  page: "page",
  doc: "page",
  documentation: "page",
  wiki: "page",
  milestone: "milestone",
  release: "milestone",
};

/**
 * Map a Notion type string to a PlanningItemKind.
 */
export function mapToItemKind(
  typeString: string,
  fallback: PlanningItemKind
): PlanningItemKind {
  const normalized = typeString.toLowerCase().trim();
  return KIND_MAP[normalized] ?? fallback;
}

// ─── Resolved Property Map ─────────────────────────────────────────

/**
 * Internal resolved property names for a database schema.
 */
interface ResolvedPropertyMap {
  title: string;
  description: string;
  type: string;
  status: string;
  labels: string;
  category: string;
  assignee: string;
}

// ─── Notion Item Extractor ──────────────────────────────────────────

/**
 * Extracts planning items from Notion databases and transforms them
 * into the internal PlanningItem format.
 *
 * This class handles the core extraction logic:
 * - Database querying with pagination
 * - Property auto-detection from database schemas
 * - Notion page → PlanningItem transformation
 * - Status normalization
 * - Custom field extraction
 */
export class NotionItemExtractor {
  private readonly client: NotionClient;
  private readonly config: NotionExtractorConfig;

  constructor(client: NotionClient, config?: NotionExtractorConfig) {
    this.client = client;
    this.config = config ?? {};
  }

  // ─── Project Extraction ────────────────────────────────────────

  /**
   * List Notion databases as PMProjects.
   * Uses the Notion search API to discover databases.
   *
   * @param options - Pagination options
   * @returns Paginated list of projects
   */
  async listProjects(
    options?: PaginationOptions
  ): Promise<PaginatedResult<PMProject>> {
    const searchResult = await this.client.search("");

    // Filter to databases only
    const databases = searchResult.results.filter(
      (r) => r.object === "database"
    );

    const projects: PMProject[] = databases.map((db) => ({
      externalId: db.id,
      name: db.title
        ? db.title.map((t) => t.plain_text).join("")
        : "Untitled Database",
      externalUrl: db.url,
      metadata: { object: "database" },
    }));

    // Apply simple cursor-based pagination
    const pageSize = options?.pageSize ?? 50;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const endIndex = startIndex + pageSize;
    const page = projects.slice(startIndex, endIndex);
    const hasMore = endIndex < projects.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(endIndex) : undefined,
    };
  }

  /**
   * Fetch a single Notion database as a PMProject.
   *
   * @param databaseId - The Notion database ID
   * @returns The project, or undefined if not found
   */
  async getProject(databaseId: string): Promise<PMProject | undefined> {
    try {
      const db = await this.client.getDatabase(databaseId);
      return this.databaseToProject(db);
    } catch {
      return undefined;
    }
  }

  // ─── Item Extraction ───────────────────────────────────────────

  /**
   * Extract planning items from a Notion database.
   *
   * Queries the database, resolves property mappings from the schema,
   * and transforms each page into a PlanningItem with normalized status,
   * kind, labels, and custom fields.
   *
   * @param databaseId - The Notion database to extract from
   * @param filter - Optional filtering and pagination options
   * @returns Paginated list of PlanningItems
   */
  async extractItems(
    databaseId: string,
    filter?: NotionExtractionFilter
  ): Promise<PaginatedResult<PlanningItem>> {
    // Fetch the database schema for property auto-detection
    const dbSchema = await this.client.getDatabase(databaseId);
    const propertyMap = this.resolvePropertyMappings(dbSchema);
    const dbTitle = extractPlainText(dbSchema.title);

    const items: PlanningItem[] = [];
    const pageSize = Math.min(filter?.pageSize ?? 100, 100);
    let cursor = filter?.cursor;
    let lastCursor: string | undefined;
    let hasMore = false;
    const maxItems = filter?.maxItems;

    do {
      const response = await this.client.queryDatabase({
        database_id: databaseId,
        page_size: pageSize,
        start_cursor: cursor,
      });

      for (const page of response.results) {
        // Skip archived pages unless configured to include them
        if (page.archived && !this.config.includeArchived) {
          continue;
        }

        // Apply updatedAfter filter
        if (
          filter?.updatedAfter &&
          page.last_edited_time < filter.updatedAfter
        ) {
          continue;
        }

        const item = this.pageToItem(page, propertyMap, databaseId, dbTitle);

        // Apply kind filter
        if (
          filter?.kinds &&
          filter.kinds.length > 0 &&
          !filter.kinds.includes(item.kind)
        ) {
          continue;
        }

        // Apply status category filter
        if (
          filter?.statusCategory &&
          item.status.category !== filter.statusCategory
        ) {
          continue;
        }

        items.push(item);

        // Check maxItems limit
        if (maxItems && items.length >= maxItems) {
          return {
            items,
            hasMore: response.has_more || items.length < response.results.length,
            nextCursor: response.next_cursor ?? undefined,
          };
        }
      }

      hasMore = response.has_more;
      lastCursor = response.next_cursor ?? undefined;
      cursor = hasMore ? lastCursor : undefined;
    } while (cursor);

    return {
      items,
      hasMore,
      nextCursor: lastCursor,
    };
  }

  /**
   * Extract all items from a database (auto-paginates).
   * Convenience method when you need all items without manual pagination.
   *
   * @param databaseId - The Notion database to extract from
   * @param filter - Optional filtering options (cursor/pageSize ignored)
   * @returns Array of all PlanningItems
   */
  async extractAllItems(
    databaseId: string,
    filter?: Omit<NotionExtractionFilter, "cursor" | "pageSize">
  ): Promise<PlanningItem[]> {
    const allItems: PlanningItem[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.extractItems(databaseId, {
        ...filter,
        cursor,
        pageSize: 100,
      });

      allItems.push(...result.items);

      if (filter?.maxItems && allItems.length >= filter.maxItems) {
        return allItems.slice(0, filter.maxItems);
      }

      cursor = result.hasMore ? result.nextCursor : undefined;
    } while (cursor);

    return allItems;
  }

  // ─── Private: Transformation ──────────────────────────────────

  /**
   * Transform a single Notion page into a PlanningItem.
   */
  private pageToItem(
    page: NotionPage,
    propertyMap: ResolvedPropertyMap,
    databaseId: string,
    databaseTitle: string
  ): PlanningItem {
    const title = this.extractTextProperty(
      page.properties,
      propertyMap.title,
      "title"
    );
    const description = this.extractTextProperty(
      page.properties,
      propertyMap.description,
      "text"
    );
    const statusLabel = this.extractTextProperty(
      page.properties,
      propertyMap.status,
      "select"
    );
    const typeStr = this.extractTextProperty(
      page.properties,
      propertyMap.type,
      "select"
    );
    const labels = this.extractMultiSelect(
      page.properties,
      propertyMap.labels
    );
    const assignees = this.extractPeople(
      page.properties,
      propertyMap.assignee
    );

    // Build status
    const status: PMItemStatus = statusLabel
      ? {
          category: normalizeStatusCategory(statusLabel),
          originalLabel: statusLabel,
        }
      : { category: "unknown", originalLabel: "" };

    // Determine kind
    const defaultKind = this.config.defaultItemKind ?? "task";
    const kind: PlanningItemKind = typeStr
      ? mapToItemKind(typeStr, defaultKind)
      : defaultKind;

    // Extract custom fields (properties not mapped to standard fields)
    const customFields = this.extractCustomFields(page.properties, propertyMap);

    return {
      externalId: page.id,
      title: title || "Untitled",
      description: description || undefined,
      kind,
      status,
      labels,
      assignees,
      projectId: databaseId,
      externalUrl: page.url,
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      customFields,
      metadata: {
        archived: page.archived,
        databaseTitle,
      },
    };
  }

  /**
   * Convert a Notion database into a PMProject.
   */
  private databaseToProject(db: NotionDatabase): PMProject {
    return {
      externalId: db.id,
      name: extractPlainText(db.title) || "Untitled Database",
      description: extractPlainText(db.description) || undefined,
      externalUrl: db.url,
      metadata: {
        propertyCount: Object.keys(db.properties).length,
        propertyNames: Object.keys(db.properties),
      },
    };
  }

  // ─── Private: Property Resolution ─────────────────────────────

  /**
   * Resolve property mappings from the database schema.
   * Uses explicit config when provided, auto-detects otherwise.
   */
  private resolvePropertyMappings(
    dbSchema: NotionDatabase
  ): ResolvedPropertyMap {
    const mappings = this.config.propertyMappings ?? {};
    const props = dbSchema.properties;

    return {
      title:
        mappings.titleProperty ??
        findPropertyByType(props, "title") ??
        "Name",
      description:
        mappings.descriptionProperty ??
        findPropertyByName(props, [
          "description",
          "summary",
          "details",
          "notes",
        ]) ??
        findPropertyByType(props, "rich_text") ??
        "",
      type:
        mappings.typeProperty ??
        findPropertyByName(props, ["type", "item type", "kind", "category"]) ??
        "",
      status:
        mappings.statusProperty ??
        findPropertyByType(props, "status") ??
        findPropertyByName(props, ["status", "state", "stage"]) ??
        "",
      labels:
        mappings.labelsProperty ??
        findPropertyByName(props, [
          "tags",
          "labels",
          "areas",
          "domains",
          "components",
        ]) ??
        findPropertyByType(props, "multi_select") ??
        "",
      category:
        mappings.categoryProperty ??
        findPropertyByName(props, [
          "category",
          "area",
          "domain",
          "team",
        ]) ??
        "",
      assignee: findPropertyByType(props, "people") ?? "",
    };
  }

  // ─── Private: Property Extraction ─────────────────────────────

  /**
   * Extract a string value from a page property.
   */
  private extractTextProperty(
    properties: Record<string, NotionPropertyValue>,
    propertyName: string,
    mode: "title" | "text" | "select"
  ): string {
    if (!propertyName) return "";

    const prop = properties[propertyName];
    if (!prop) return "";

    switch (mode) {
      case "title":
        if (prop.type === "title") {
          return extractPlainTextFromRichText(prop.title);
        }
        return "";

      case "text":
        if (prop.type === "rich_text") {
          return extractPlainTextFromRichText(prop.rich_text);
        }
        return "";

      case "select":
        if (prop.type === "select" && prop.select) {
          return prop.select.name;
        }
        if (prop.type === "status" && prop.status) {
          return prop.status.name;
        }
        return "";
    }
  }

  /**
   * Extract multi-select values as an array of strings.
   */
  private extractMultiSelect(
    properties: Record<string, NotionPropertyValue>,
    propertyName: string
  ): string[] {
    if (!propertyName) return [];

    const prop = properties[propertyName];
    if (!prop || prop.type !== "multi_select") return [];

    return prop.multi_select.map((opt) => opt.name);
  }

  /**
   * Extract people/assignee names from a people property.
   */
  private extractPeople(
    properties: Record<string, NotionPropertyValue>,
    propertyName: string
  ): string[] {
    if (!propertyName) return [];

    const prop = properties[propertyName];
    if (!prop || prop.type !== "people") return [];

    return prop.people
      .map((p) => p.name ?? `User ${p.id.slice(0, 8)}`)
      .filter(Boolean);
  }

  /**
   * Extract custom fields from page properties.
   * Includes all properties not mapped to standard fields.
   */
  private extractCustomFields(
    properties: Record<string, NotionPropertyValue>,
    propertyMap: ResolvedPropertyMap
  ): Record<string, PMFieldValue> {
    const standardProps = new Set([
      propertyMap.title,
      propertyMap.description,
      propertyMap.type,
      propertyMap.status,
      propertyMap.labels,
      propertyMap.category,
      propertyMap.assignee,
    ]);

    const customFields: Record<string, PMFieldValue> = {};

    for (const [name, value] of Object.entries(properties)) {
      if (standardProps.has(name)) continue;

      const converted = convertPropertyToFieldValue(value);
      if (converted) {
        customFields[name] = converted;
      }
    }

    return customFields;
  }
}

// ─── Utility Functions ──────────────────────────────────────────────

/**
 * Extract plain text from an array of Notion rich text objects.
 */
function extractPlainTextFromRichText(richText: NotionRichText[]): string {
  return richText.map((rt) => rt.plain_text).join("");
}

/**
 * Extract plain text from a Notion title field.
 */
function extractPlainText(title: NotionRichText[]): string {
  return extractPlainTextFromRichText(title);
}

/**
 * Find a property name in a database schema by its type.
 */
function findPropertyByType(
  properties: Record<string, NotionDatabaseProperty>,
  type: string
): string | undefined {
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === type) {
      return name;
    }
  }
  return undefined;
}

/**
 * Find a property name by matching candidate names (case-insensitive).
 */
function findPropertyByName(
  properties: Record<string, NotionDatabaseProperty>,
  candidates: string[]
): string | undefined {
  const propNames = Object.keys(properties);

  for (const candidate of candidates) {
    const match = propNames.find(
      (name) => name.toLowerCase() === candidate.toLowerCase()
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

/**
 * Convert a Notion property value into a typed PMFieldValue.
 * Returns undefined for unsupported or empty property types.
 */
function convertPropertyToFieldValue(
  prop: NotionPropertyValue
): PMFieldValue | undefined {
  switch (prop.type) {
    case "title":
      return {
        type: "string",
        value: extractPlainTextFromRichText(prop.title),
      };

    case "rich_text":
      return {
        type: "string",
        value: extractPlainTextFromRichText(prop.rich_text),
      };

    case "select":
      if (prop.select) {
        return { type: "select", value: prop.select.name };
      }
      return undefined;

    case "multi_select":
      return {
        type: "multi_select",
        value: prop.multi_select.map((opt) => opt.name),
      };

    case "status":
      if (prop.status) {
        return { type: "select", value: prop.status.name };
      }
      return undefined;

    case "number":
      if (prop.number !== null) {
        return { type: "number", value: prop.number };
      }
      return undefined;

    case "checkbox":
      return { type: "boolean", value: prop.checkbox };

    case "url":
      if (prop.url) {
        return { type: "url", value: prop.url };
      }
      return undefined;

    case "date":
      if (prop.date) {
        return { type: "date", value: prop.date.start };
      }
      return undefined;

    case "created_time":
      return { type: "date", value: prop.created_time };

    case "last_edited_time":
      return { type: "date", value: prop.last_edited_time };

    default:
      return undefined;
  }
}
