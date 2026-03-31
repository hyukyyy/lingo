/**
 * Notion PM Adapter
 *
 * Connects to a Notion workspace to extract planning terminology,
 * domain terms, feature names, and workflow labels from databases.
 *
 * Extraction strategy:
 * 1. Query specified database(s) for pages
 * 2. Extract title, description, status, labels, and other properties
 * 3. Also extract database-level metadata (status options, select options)
 *    as workflow/label terms
 * 4. Normalize everything into NormalizedTerm format
 *
 * The adapter handles two kinds of terminology:
 * - **Page-level terms**: Each database page (epic, feature, story) becomes a term
 * - **Schema-level terms**: Status options, select values, and labels from the
 *   database schema become workflow/label terms (these represent the org's
 *   unique vocabulary for describing work states)
 */

import type {
  PMAdapter,
  PMProject,
  PMItem,
  PMItemType,
  PMItemKind,
  PMItemStatus,
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

import type {
  NotionClient,
  NotionPage,
  NotionPropertyValue,
  NotionDatabase,
  NotionDatabaseProperty,
} from "./notion-client.js";

import {
  HttpNotionClient,
  type NotionClientConfig,
} from "./notion-client.js";

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Configuration for the Notion adapter.
 */
export interface NotionAdapterConfig {
  /** Notion integration token */
  apiToken: string;

  /**
   * Database IDs to extract from.
   * If empty, the adapter will attempt to discover databases via search.
   */
  databaseIds: string[];

  /**
   * Mapping of Notion property names to PMItem fields.
   * Allows adapting to different database schemas.
   *
   * Default mappings:
   * - titleProperty: auto-detected (first "title" type property)
   * - descriptionProperty: "Description" or first "rich_text" property
   * - typeProperty: "Type" (select)
   * - statusProperty: auto-detected (first "status" type property)
   * - labelsProperty: "Tags" or "Labels" (multi_select)
   */
  propertyMappings?: PropertyMappings;

  /**
   * Default PMItemType to assign when a page doesn't have a type property.
   * Default: "feature"
   */
  defaultItemType?: PMItemType;

  /**
   * Whether to also extract database schema terms (status options, labels, etc.).
   * Default: true
   */
  extractSchemaTerms?: boolean;

  /** Optional base URL override (for testing) */
  baseUrl?: string;

  /** Optional API version override */
  apiVersion?: string;
}

/**
 * Maps Notion property names to the fields we care about.
 */
export interface PropertyMappings {
  /** Property name containing the page title */
  titleProperty?: string;
  /** Property name containing the description */
  descriptionProperty?: string;
  /** Property name containing the item type (epic, feature, story) */
  typeProperty?: string;
  /** Property name containing the workflow status */
  statusProperty?: string;
  /** Property name containing labels/tags */
  labelsProperty?: string;
  /** Property name containing category */
  categoryProperty?: string;
}

// ─── Type Mapping ───────────────────────────────────────────────────

/**
 * Maps Notion select/status option names to PMItemType.
 * Case-insensitive matching.
 */
const TYPE_MAPPING: Record<string, PMItemType> = {
  epic: "epic",
  feature: "feature",
  story: "story",
  "user story": "story",
  task: "task",
  bug: "bug",
  issue: "bug",
  defect: "bug",
  milestone: "milestone",
  project: "project",
  label: "label",
};

function mapToPMItemType(typeString: string, fallback: PMItemType): PMItemType {
  const normalized = typeString.toLowerCase().trim();
  return TYPE_MAPPING[normalized] ?? fallback;
}

// ─── Notion Adapter ─────────────────────────────────────────────────

export class NotionAdapter implements PMAdapter {
  readonly name = "notion";
  readonly displayName = "Notion";

  private readonly client: NotionClient;
  private readonly config: NotionAdapterConfig;

  /**
   * Create a Notion adapter.
   *
   * @param config - Notion adapter configuration
   * @param client - Optional NotionClient injection (for testing)
   */
  constructor(config: NotionAdapterConfig, client?: NotionClient) {
    this.config = config;
    this.client =
      client ??
      new HttpNotionClient({
        apiToken: config.apiToken,
        baseUrl: config.baseUrl,
        apiVersion: config.apiVersion,
      });
  }

  /**
   * Test connectivity to the Notion workspace.
   */
  async testConnection(): Promise<ConnectionStatus> {
    try {
      const me = await this.client.getMe();
      const workspaceName = me.bot?.workspace_name ?? "unknown";

      return {
        connected: true,
        message: `Connected to Notion workspace: ${workspaceName}`,
        details: {
          type: me.type,
          workspaceName,
          configuredDatabases: this.config.databaseIds.length,
        },
      };
    } catch (err) {
      return {
        connected: false,
        message: `Failed to connect to Notion: ${(err as Error).message}`,
        details: { error: (err as Error).message },
      };
    }
  }

  // ─── Project Methods ──────────────────────────────────────────────
  // TODO: Full implementation in a subsequent AC.

  /**
   * List Notion databases accessible to the integration as projects.
   */
  async listProjects(
    _options?: PaginationOptions
  ): Promise<PaginatedResult<PMProject>> {
    // Notion databases = projects. Use search API to discover them.
    const databases = await this.client.search({
      filter: { property: "object", value: "database" },
      page_size: _options?.pageSize ?? 100,
      start_cursor: _options?.cursor,
    });

    const projects: PMProject[] = databases.results
      .filter((r): r is NotionDatabase => r.object === "database")
      .map((db) => ({
        externalId: db.id,
        name: extractPlainText(db.title) || "Untitled Database",
        description: undefined,
        url: db.url,
        updatedAt: db.last_edited_time,
        metadata: {
          propertyCount: Object.keys(db.properties).length,
        },
      }));

    return {
      items: projects,
      nextCursor: databases.next_cursor ?? undefined,
      hasMore: databases.has_more,
    };
  }

  /**
   * Fetch a single Notion database as a project.
   */
  async getProject(projectId: string): Promise<PMProject | undefined> {
    try {
      const db = await this.client.getDatabase(projectId);
      return {
        externalId: db.id,
        name: extractPlainText(db.title) || "Untitled Database",
        description: undefined,
        url: db.url,
        updatedAt: db.last_edited_time,
        metadata: {
          propertyCount: Object.keys(db.properties).length,
          properties: Object.keys(db.properties),
        },
      };
    } catch {
      return undefined;
    }
  }

  // ─── Item Methods ────────────────────────────────────────────────
  // TODO: Full implementation in a subsequent AC.

  /**
   * List items from a Notion database with pagination.
   */
  async listItems(
    projectId: string,
    options?: PMItemFilterOptions
  ): Promise<PaginatedResult<PMItem>> {
    const dbSchema = await this.client.getDatabase(projectId);
    const propertyMap = this.resolvePropertyMappings(dbSchema);
    const dbTitle = extractPlainText(dbSchema.title);

    const response = await this.client.queryDatabase({
      database_id: projectId,
      page_size: options?.pageSize ?? 100,
      start_cursor: options?.cursor,
    });

    const items: PMItem[] = response.results
      .filter((page) => !page.archived)
      .map((page) => this.pageToItem(page, propertyMap, dbTitle));

    return {
      items,
      nextCursor: response.next_cursor ?? undefined,
      hasMore: response.has_more,
    };
  }

  /**
   * Fetch a single Notion page as a PM item.
   */
  async getItem(itemId: string): Promise<PMItem | undefined> {
    try {
      const page = await this.client.getPage(itemId);
      if (!page.parent.database_id) return undefined;

      const dbSchema = await this.client.getDatabase(page.parent.database_id);
      const propertyMap = this.resolvePropertyMappings(dbSchema);
      const dbTitle = extractPlainText(dbSchema.title);

      return this.pageToItem(page, propertyMap, dbTitle);
    } catch {
      return undefined;
    }
  }

  /**
   * Extract terminology candidates from a Notion database's items.
   * Scans item titles, descriptions, and labels to surface organizational vocabulary.
   */
  async extractTerminology(
    projectId: string,
    options?: PMTermExtractionOptions
  ): Promise<PMTermCandidate[]> {
    // Use the existing extraction pipeline, then convert to term candidates
    const items = await this.extractItems({
      project: projectId,
      maxItems: options?.maxItems,
    });

    const termMap = new Map<string, PMTermCandidate>();

    for (const item of items) {
      if (!item.title.trim()) continue;

      const key = item.title.toLowerCase().trim();
      const existing = termMap.get(key);

      if (existing) {
        existing.frequency++;
        if (!existing.source.itemIds.includes(item.externalId)) {
          existing.source.itemIds.push(item.externalId);
        }
      } else {
        termMap.set(key, {
          term: item.title.trim(),
          contextSnippet: item.description?.slice(0, 200) ?? `${item.type} in ${item.project ?? "unknown project"}`,
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

  // ─── Extraction Pipeline ─────────────────────────────────────────

  /**
   * Extract raw items from configured Notion databases.
   */
  async extractItems(options?: ExtractionOptions): Promise<PMItem[]> {
    const databaseIds = this.config.databaseIds;
    if (databaseIds.length === 0) {
      return [];
    }

    const allItems: PMItem[] = [];

    for (const dbId of databaseIds) {
      // Fetch the database schema for property discovery
      const dbSchema = await this.client.getDatabase(dbId);
      const propertyMap = this.resolvePropertyMappings(dbSchema);

      // Extract page-level items
      const pageItems = await this.extractFromDatabase(
        dbId,
        dbSchema,
        propertyMap,
        options
      );
      allItems.push(...pageItems);

      // Extract schema-level terms (status options, labels, etc.)
      if (this.config.extractSchemaTerms !== false) {
        const schemaItems = this.extractSchemaItems(dbId, dbSchema);
        allItems.push(...schemaItems);
      }
    }

    // Apply maxItems limit if specified
    if (options?.maxItems && allItems.length > options.maxItems) {
      return allItems.slice(0, options.maxItems);
    }

    return allItems;
  }

  /**
   * Normalize raw PM items into terms suitable for glossary import.
   */
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

      const term = this.normalizeItem(item);
      terms.push(term);
    }

    return terms;
  }

  /**
   * Convenience method: extract items and normalize in one step.
   */
  async extract(options?: ExtractionOptions): Promise<ExtractionResult> {
    const startTime = performance.now();
    const warnings: string[] = [];

    // Extract raw items
    let items: PMItem[];
    try {
      items = await this.extractItems(options);
    } catch (err) {
      warnings.push(`Extraction error: ${(err as Error).message}`);
      items = [];
    }

    // Normalize
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

  // ─── Private: Database Extraction ─────────────────────────────────

  /**
   * Extract pages from a single Notion database.
   * Handles pagination to fetch all pages.
   */
  private async extractFromDatabase(
    databaseId: string,
    dbSchema: NotionDatabase,
    propertyMap: ResolvedPropertyMap,
    options?: ExtractionOptions
  ): Promise<PMItem[]> {
    const items: PMItem[] = [];
    let cursor: string | undefined;
    const pageSize = Math.min(options?.maxItems ?? 100, 100);
    const dbTitle = extractPlainText(dbSchema.title);

    do {
      const response = await this.client.queryDatabase({
        database_id: databaseId,
        page_size: pageSize,
        start_cursor: cursor,
      });

      for (const page of response.results) {
        // Skip archived pages unless requested
        if (page.archived && !options?.includeArchived) {
          continue;
        }

        // Apply modifiedAfter filter
        if (
          options?.modifiedAfter &&
          page.last_edited_time < options.modifiedAfter
        ) {
          continue;
        }

        const item = this.pageToItem(page, propertyMap, dbTitle);

        // Apply type filter
        if (
          options?.itemTypes &&
          options.itemTypes.length > 0 &&
          !options.itemTypes.includes(item.type)
        ) {
          continue;
        }

        items.push(item);

        // Check maxItems
        if (options?.maxItems && items.length >= options.maxItems) {
          return items;
        }
      }

      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return items;
  }

  /**
   * Convert a Notion page to a PMItem.
   */
  private pageToItem(
    page: NotionPage,
    propertyMap: ResolvedPropertyMap,
    databaseTitle: string
  ): PMItem {
    const title = this.extractProperty(page.properties, propertyMap.title, "title");
    const description = this.extractProperty(page.properties, propertyMap.description, "text");
    const statusLabel = this.extractProperty(page.properties, propertyMap.status, "select");
    const typeStr = this.extractProperty(page.properties, propertyMap.type, "select");
    const labels = this.extractMultiSelect(page.properties, propertyMap.labels);
    const category = this.extractProperty(page.properties, propertyMap.category, "select");

    const defaultType = this.config.defaultItemType ?? "feature";
    const itemType = typeStr
      ? mapToPMItemType(typeStr, defaultType)
      : defaultType;

    // Map legacy PMItemType to PMItemKind
    const kindMap: Partial<Record<PMItemType, PMItemKind>> = {
      epic: "epic",
      story: "story",
      bug: "bug",
      task: "task",
      milestone: "milestone",
      feature: "task",
    };
    const kind: PMItemKind = kindMap[itemType] ?? "other";

    // Build normalized status
    const status: PMItemStatus = statusLabel
      ? { category: "unknown", originalLabel: statusLabel }
      : { category: "unknown", originalLabel: "" };

    return {
      externalId: page.id,
      title: title || "Untitled",
      description: description || undefined,
      type: itemType,
      kind,
      status,
      url: page.url,
      externalUrl: page.url,
      labels,
      assignees: [],
      projectId: page.parent.database_id ?? "",
      project: databaseTitle || undefined,
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      customFields: {},
      metadata: {
        archived: page.archived,
        databaseId: page.parent.database_id,
        category: category || undefined,
      },
    };
  }

  /**
   * Extract schema-level items from a database definition.
   * Status options, select values, and multi-select options become
   * workflow/label terms that capture the org's planning vocabulary.
   */
  private extractSchemaItems(
    databaseId: string,
    dbSchema: NotionDatabase
  ): PMItem[] {
    const items: PMItem[] = [];
    const dbTitle = extractPlainText(dbSchema.title);

    /** Helper to create a schema-level PMItem with all required fields */
    const makeSchemaItem = (
      partial: Pick<PMItem, "externalId" | "title" | "description" | "type" | "labels"> & { metadata: Record<string, unknown> }
    ): PMItem => ({
      ...partial,
      kind: "other",
      status: { category: "unknown", originalLabel: "" },
      assignees: [],
      projectId: databaseId,
      project: dbTitle || undefined,
      customFields: {},
      metadata: partial.metadata,
    });

    for (const [propName, prop] of Object.entries(dbSchema.properties)) {
      // Extract status options as workflow terms
      if (prop.type === "status" && prop.status?.options) {
        for (const option of prop.status.options) {
          items.push(makeSchemaItem({
            externalId: `${databaseId}:status:${option.name}`,
            title: option.name,
            description: `Workflow status "${option.name}" from the "${propName}" property in database "${dbTitle}"`,
            type: "status",
            labels: ["workflow", "status"],
            metadata: {
              databaseId,
              propertyName: propName,
              propertyType: "status",
              color: option.color,
            },
          }));
        }
      }

      // Extract select options that represent types or categories
      if (prop.type === "select" && prop.select?.options) {
        // Only extract if it looks like a meaningful taxonomy property
        const lowerName = propName.toLowerCase();
        const isTaxonomy =
          lowerName.includes("type") ||
          lowerName.includes("category") ||
          lowerName.includes("priority") ||
          lowerName.includes("phase") ||
          lowerName.includes("stage") ||
          lowerName.includes("area");

        if (isTaxonomy) {
          for (const option of prop.select.options) {
            items.push(makeSchemaItem({
              externalId: `${databaseId}:select:${propName}:${option.name}`,
              title: option.name,
              description: `"${option.name}" is a "${propName}" category value in database "${dbTitle}"`,
              type: "label",
              labels: [propName.toLowerCase(), "category"],
              metadata: {
                databaseId,
                propertyName: propName,
                propertyType: "select",
                color: option.color,
              },
            }));
          }
        }
      }

      // Extract multi-select options as label terms
      if (prop.type === "multi_select" && prop.multi_select?.options) {
        const lowerName = propName.toLowerCase();
        const isLabels =
          lowerName.includes("tag") ||
          lowerName.includes("label") ||
          lowerName.includes("area") ||
          lowerName.includes("domain") ||
          lowerName.includes("component") ||
          lowerName.includes("team");

        if (isLabels) {
          for (const option of prop.multi_select.options) {
            items.push(makeSchemaItem({
              externalId: `${databaseId}:multi_select:${propName}:${option.name}`,
              title: option.name,
              description: `"${option.name}" is a "${propName}" label in database "${dbTitle}"`,
              type: "label",
              labels: [propName.toLowerCase()],
              metadata: {
                databaseId,
                propertyName: propName,
                propertyType: "multi_select",
                color: option.color,
              },
            }));
          }
        }
      }
    }

    return items;
  }

  // ─── Private: Property Resolution ─────────────────────────────────

  /**
   * Auto-detect property mappings from the database schema.
   * Uses the configured mappings where provided, auto-detects otherwise.
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
        findPropertyByName(props, ["description", "summary", "details"]) ??
        findPropertyByType(props, "rich_text") ??
        "",
      type:
        mappings.typeProperty ??
        findPropertyByName(props, ["type", "item type", "kind"]) ??
        "",
      status:
        mappings.statusProperty ??
        findPropertyByType(props, "status") ??
        findPropertyByName(props, ["status", "state", "stage"]) ??
        "",
      labels:
        mappings.labelsProperty ??
        findPropertyByName(props, ["tags", "labels", "areas", "domains", "components"]) ??
        findPropertyByType(props, "multi_select") ??
        "",
      category:
        mappings.categoryProperty ??
        findPropertyByName(props, ["category", "area", "domain", "team"]) ??
        "",
    };
  }

  /**
   * Extract a string value from a page's properties.
   */
  private extractProperty(
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

  // ─── Private: Normalization ───────────────────────────────────────

  /**
   * Convert a single PMItem into a NormalizedTerm.
   */
  private normalizeItem(item: PMItem): NormalizedTerm {
    const definition = this.buildDefinition(item);
    const tags = this.buildTags(item);
    const category = this.inferCategory(item);

    return {
      name: item.title.trim(),
      definition,
      aliases: [],
      category,
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
   * Build a human-readable definition from PMItem fields.
   */
  private buildDefinition(item: PMItem): string {
    if (item.description) {
      // Truncate very long descriptions
      const maxLen = 500;
      return item.description.length > maxLen
        ? item.description.slice(0, maxLen) + "..."
        : item.description;
    }

    // Generate a synthetic definition from metadata
    const parts: string[] = [];
    const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
    parts.push(`${typeLabel} from Notion`);

    if (item.project) {
      parts.push(`in project "${item.project}"`);
    }

    if (item.status.originalLabel) {
      parts.push(`(status: ${item.status.originalLabel})`);
    }

    return parts.join(" ") + ".";
  }

  /**
   * Build tags from PMItem metadata.
   */
  private buildTags(item: PMItem): string[] {
    const tags: string[] = [...item.labels];

    // Add the item type as a tag
    tags.push(item.type);

    // Add source info
    tags.push("notion");

    // Add status as a tag if present
    if (item.status.originalLabel) {
      tags.push(`status:${item.status.originalLabel.toLowerCase().replace(/\s+/g, "-")}`);
    }

    return [...new Set(tags)]; // Deduplicate
  }

  /**
   * Infer a category from the PMItem.
   */
  private inferCategory(item: PMItem): string | undefined {
    // Use explicit category from metadata if available
    const metaCategory = item.metadata.category;
    if (typeof metaCategory === "string" && metaCategory) {
      return metaCategory;
    }

    // Use project name as fallback category
    return item.project || undefined;
  }
}

// ─── Resolved Property Map ──────────────────────────────────────────

interface ResolvedPropertyMap {
  title: string;
  description: string;
  type: string;
  status: string;
  labels: string;
  category: string;
}

// ─── Utility Functions ──────────────────────────────────────────────

/**
 * Extract plain text from an array of Notion rich text objects.
 */
function extractPlainTextFromRichText(
  richText: { plain_text: string }[]
): string {
  return richText.map((rt) => rt.plain_text).join("");
}

/**
 * Extract plain text from a Notion title field (array of rich text).
 */
function extractPlainText(title: { plain_text: string }[]): string {
  return extractPlainTextFromRichText(title);
}

/**
 * Find a property name in a database schema by its type.
 * Returns the first match, or undefined.
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
 * Find a property name in a database schema by matching against
 * a list of candidate names (case-insensitive).
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
