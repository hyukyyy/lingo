/**
 * NL Input Parser Types
 *
 * Defines the output types for the natural language input parser.
 * The parser extracts intent, entities, and hierarchy from free-text
 * descriptions and produces structured PM item objects compatible with
 * the Lingo intermediate representation (PmItem / CreatePmItemInput).
 *
 * Design:
 * - Rule-based extraction (no external AI dependency for core parsing)
 * - Pipeline architecture: tokenize → detect intent → extract entities → assemble items
 * - Confidence scoring so consumers can decide when to ask for clarification
 * - Span tracking for entity positions (enables UI highlighting)
 */

import type { PmItemType, PmStatus, PmPriority, CreatePmItemInput } from "../models/pm-items.js";

// ─── Intent ─────────────────────────────────────────────────────────

/**
 * The user's inferred intent from the natural language input.
 *
 * - "create": User wants to create new PM items
 * - "update": User wants to modify existing items
 * - "describe": User is describing/defining concepts (no action implied)
 * - "query": User is asking about or searching for items
 * - "decompose": User wants to break down a large item into smaller pieces
 * - "unknown": Parser couldn't determine intent
 */
export type NlIntent =
  | "create"
  | "update"
  | "describe"
  | "query"
  | "decompose"
  | "unknown";

// ─── Entity ─────────────────────────────────────────────────────────

/**
 * The kind of entity extracted from natural language text.
 */
export type NlEntityKind =
  | "item_type"    // PM item type (epic, story, task, etc.)
  | "status"       // Status reference (todo, in progress, done, etc.)
  | "priority"     // Priority level (critical, high, medium, low)
  | "label"        // A tag or label
  | "person"       // A person's name (assignee, reporter)
  | "date"         // A date reference
  | "title"        // An item title extracted from the text
  | "description"  // A description or acceptance criteria
  | "dependency";  // A dependency reference

/**
 * A single entity extracted from the input text.
 * Includes the raw text span and a normalized value mapped
 * to the Lingo canonical vocabulary.
 */
export interface NlEntity {
  /** What kind of entity this is */
  kind: NlEntityKind;

  /** The raw text as it appeared in the input */
  rawValue: string;

  /**
   * The normalized/canonical value.
   * For item_type: a PmItemType value
   * For status: a PmStatus value
   * For priority: a PmPriority value
   * For others: the cleaned-up string
   */
  normalizedValue: string;

  /**
   * Character position span in the original input text.
   * Enables UI highlighting and debugging.
   */
  span: TextSpan;

  /** Confidence in this extraction (0.0 to 1.0) */
  confidence: number;
}

/**
 * A span of text within the original input.
 */
export interface TextSpan {
  /** Start character offset (0-indexed, inclusive) */
  start: number;
  /** End character offset (0-indexed, exclusive) */
  end: number;
}

// ─── Hierarchy ──────────────────────────────────────────────────────

/**
 * A parent-child relationship detected between items in the input.
 * Uses titles (not IDs) because the items haven't been created yet.
 */
export interface NlHierarchyRelation {
  /** Title of the parent item */
  parentTitle: string;

  /** Inferred type of the parent item */
  parentType: PmItemType;

  /** Title of the child item */
  childTitle: string;

  /** Inferred type of the child item */
  childType: PmItemType;
}

// ─── Parse Result ───────────────────────────────────────────────────

/**
 * The complete result of parsing a natural language input.
 * Contains everything needed to create PM items from the text.
 */
export interface NlParseResult {
  /** The detected user intent */
  intent: NlIntent;

  /** Confidence in the overall parse (0.0 to 1.0) */
  confidence: number;

  /** All entities extracted from the text */
  entities: NlEntity[];

  /**
   * Structured PM items assembled from the extracted entities.
   * Ready to be passed to `createPmItem()` for creation.
   */
  items: CreatePmItemInput[];

  /** Detected parent-child relationships between items */
  hierarchy: NlHierarchyRelation[];

  /** The original input text */
  rawText: string;

  /** Diagnostic messages (warnings about ambiguous parses, etc.) */
  diagnostics: string[];
}

// ─── Parser Options ─────────────────────────────────────────────────

/**
 * Options for configuring the NL parser's behavior.
 */
export interface NlParserOptions {
  /**
   * The default PM item type to assign when the parser can't determine
   * the type from context. Default: "task"
   */
  defaultItemType?: PmItemType;

  /**
   * The default status for newly parsed items. Default: "backlog"
   */
  defaultStatus?: PmStatus;

  /**
   * The default priority for newly parsed items. Default: "none"
   */
  defaultPriority?: PmPriority;

  /**
   * The source adapter name to set on parsed items. Default: "nl-parser"
   */
  sourceAdapter?: string;

  /**
   * Minimum confidence threshold for an entity to be included.
   * Entities below this threshold are discarded. Default: 0.3
   */
  minEntityConfidence?: number;
}
