/**
 * NL Input Parser — Barrel Export
 *
 * Exports the natural language input parser and its types.
 * The parser extracts intent, entities, and hierarchy from free-text
 * and produces structured PM item objects.
 */

// Core parser
export {
  parseNaturalLanguage,
  detectIntent,
  extractAllEntities,
  extractItemTypes,
  extractStatuses,
  extractPriorities,
  extractLabels,
  extractPersons,
  extractDates,
  extractTitles,
  detectHierarchy,
  type ExtractedTitle,
} from "./nl-parser.js";

// Types
export type {
  NlParseResult,
  NlIntent,
  NlEntity,
  NlEntityKind,
  NlHierarchyRelation,
  NlParserOptions,
  TextSpan,
} from "./types.js";

// Patterns (for extensibility and testing)
export {
  INTENT_PATTERNS,
  ITEM_TYPE_PATTERNS,
  STATUS_PATTERNS,
  PRIORITY_PATTERNS,
  PERSON_PATTERNS,
  DATE_PATTERNS,
  LABEL_PATTERNS,
  HIERARCHY_PATTERNS,
} from "./entity-patterns.js";
