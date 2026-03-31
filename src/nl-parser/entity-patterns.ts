/**
 * Entity Pattern Definitions
 *
 * Centralized pattern definitions for extracting entities from natural language.
 * Each pattern maps natural language phrases to canonical Lingo values
 * (PmItemType, PmStatus, PmPriority).
 *
 * Patterns are organized by entity kind and ordered by specificity —
 * multi-word patterns before single-word to avoid partial matches.
 */

import type { PmItemType, PmStatus, PmPriority } from "../models/pm-items.js";

// ─── Item Type Patterns ─────────────────────────────────────────────

/**
 * Maps natural language phrases to canonical PmItemType values.
 * Order matters: longer/more-specific phrases first.
 */
export const ITEM_TYPE_PATTERNS: Array<{
  pattern: RegExp;
  type: PmItemType;
  confidence: number;
}> = [
  // Multi-word patterns (higher specificity)
  { pattern: /\buser\s+stor(?:y|ies)\b/i, type: "story", confidence: 0.95 },
  { pattern: /\bfeature\s+request\b/i, type: "feature", confidence: 0.9 },
  { pattern: /\bbug\s+(?:report|fix)\b/i, type: "bug", confidence: 0.9 },
  { pattern: /\bsub[- ]?task\b/i, type: "subtask", confidence: 0.95 },

  // Single-word patterns
  { pattern: /\binitiative\b/i, type: "initiative", confidence: 0.95 },
  { pattern: /\bepic\b/i, type: "epic", confidence: 0.95 },
  { pattern: /\bstor(?:y|ies)\b/i, type: "story", confidence: 0.85 },
  { pattern: /\btasks?\b/i, type: "task", confidence: 0.8 },
  { pattern: /\bbugs?\b/i, type: "bug", confidence: 0.85 },
  { pattern: /\bfeatures?\b/i, type: "feature", confidence: 0.8 },
  { pattern: /\bmilestones?\b/i, type: "milestone", confidence: 0.9 },

  // Informal/colloquial patterns
  { pattern: /\btickets?\b/i, type: "task", confidence: 0.7 },
  { pattern: /\bissues?\b/i, type: "task", confidence: 0.6 },
  { pattern: /\bwork\s+items?\b/i, type: "task", confidence: 0.6 },
  { pattern: /\bdefects?\b/i, type: "bug", confidence: 0.85 },
  { pattern: /\bthemes?\b/i, type: "initiative", confidence: 0.7 },
  { pattern: /\bgoals?\b/i, type: "milestone", confidence: 0.6 },
  { pattern: /\breleases?\b/i, type: "milestone", confidence: 0.7 },
];

// ─── Status Patterns ────────────────────────────────────────────────

/**
 * Maps natural language phrases to canonical PmStatus values.
 */
export const STATUS_PATTERNS: Array<{
  pattern: RegExp;
  status: PmStatus;
  confidence: number;
}> = [
  // Multi-word patterns
  { pattern: /\bin\s+progress\b/i, status: "in-progress", confidence: 0.95 },
  { pattern: /\bin\s+review\b/i, status: "in-review", confidence: 0.95 },
  { pattern: /\bunder\s+review\b/i, status: "in-review", confidence: 0.9 },
  { pattern: /\bnot\s+started\b/i, status: "todo", confidence: 0.9 },
  { pattern: /\bready\s+(?:to\s+start|for\s+dev)\b/i, status: "todo", confidence: 0.85 },
  { pattern: /\bwon'?t\s+(?:do|fix)\b/i, status: "cancelled", confidence: 0.9 },
  { pattern: /\bto\s+do\b/i, status: "todo", confidence: 0.9 },

  // Single-word patterns
  { pattern: /\bbacklog\b/i, status: "backlog", confidence: 0.95 },
  { pattern: /\btodo\b/i, status: "todo", confidence: 0.9 },
  { pattern: /\bblocked\b/i, status: "in-progress", confidence: 0.7 },
  { pattern: /\bdone\b/i, status: "done", confidence: 0.9 },
  { pattern: /\bcompleted?\b/i, status: "done", confidence: 0.9 },
  { pattern: /\bfinished\b/i, status: "done", confidence: 0.85 },
  { pattern: /\bcancell?ed\b/i, status: "cancelled", confidence: 0.95 },
  { pattern: /\babandoned\b/i, status: "cancelled", confidence: 0.85 },
  { pattern: /\bpending\b/i, status: "backlog", confidence: 0.7 },
  { pattern: /\bactive\b/i, status: "in-progress", confidence: 0.7 },
  { pattern: /\bstarted\b/i, status: "in-progress", confidence: 0.75 },
];

// ─── Priority Patterns ──────────────────────────────────────────────

/**
 * Maps natural language phrases to canonical PmPriority values.
 */
export const PRIORITY_PATTERNS: Array<{
  pattern: RegExp;
  priority: PmPriority;
  confidence: number;
}> = [
  // Explicit priority mentions
  { pattern: /\bcritical\s+priority\b/i, priority: "critical", confidence: 0.95 },
  { pattern: /\bhigh\s+priority\b/i, priority: "high", confidence: 0.95 },
  { pattern: /\bmedium\s+priority\b/i, priority: "medium", confidence: 0.95 },
  { pattern: /\blow\s+priority\b/i, priority: "low", confidence: 0.95 },
  { pattern: /\bno\s+priority\b/i, priority: "none", confidence: 0.9 },

  // Urgency words
  { pattern: /\bcritical\b/i, priority: "critical", confidence: 0.8 },
  { pattern: /\burgent\b/i, priority: "critical", confidence: 0.85 },
  { pattern: /\bblocker\b/i, priority: "critical", confidence: 0.85 },
  { pattern: /\bblocking\b/i, priority: "critical", confidence: 0.75 },
  { pattern: /\bhigh\b/i, priority: "high", confidence: 0.6 },
  { pattern: /\bimportant\b/i, priority: "high", confidence: 0.7 },
  { pattern: /\bmedium\b/i, priority: "medium", confidence: 0.6 },
  { pattern: /\bnormal\b/i, priority: "medium", confidence: 0.6 },
  { pattern: /\blow\b/i, priority: "low", confidence: 0.6 },
  { pattern: /\bnice\s+to\s+have\b/i, priority: "low", confidence: 0.85 },
  { pattern: /\bminor\b/i, priority: "low", confidence: 0.7 },
  { pattern: /\btrivial\b/i, priority: "low", confidence: 0.75 },

  // P-notation (common in Jira/engineering culture)
  { pattern: /\bP0\b/, priority: "critical", confidence: 0.95 },
  { pattern: /\bP1\b/, priority: "high", confidence: 0.9 },
  { pattern: /\bP2\b/, priority: "medium", confidence: 0.9 },
  { pattern: /\bP3\b/, priority: "low", confidence: 0.9 },
  { pattern: /\bP4\b/, priority: "low", confidence: 0.85 },
];

// ─── Intent Patterns ────────────────────────────────────────────────

/**
 * Patterns for detecting the user's intent from their input.
 * Ordered by confidence.
 */
export const INTENT_PATTERNS: Array<{
  pattern: RegExp;
  intent: "create" | "update" | "describe" | "query" | "decompose";
  confidence: number;
}> = [
  // Create intent
  { pattern: /\b(?:create|add|make|build|implement|write|develop|set\s+up)\b/i, intent: "create", confidence: 0.85 },
  { pattern: /\b(?:we\s+need|need\s+to|should\s+have|let'?s\s+(?:add|build|create))\b/i, intent: "create", confidence: 0.8 },
  { pattern: /\b(?:new|introduce)\b/i, intent: "create", confidence: 0.6 },

  // Update intent
  { pattern: /\b(?:update|change|modify|edit|rename|move|reassign)\b/i, intent: "update", confidence: 0.85 },
  { pattern: /\b(?:mark\s+as|set\s+to|change\s+to)\b/i, intent: "update", confidence: 0.9 },

  // Describe intent
  { pattern: /\b(?:describe|define|explain|document|specification|spec)\b/i, intent: "describe", confidence: 0.8 },
  { pattern: /\b(?:what\s+is|what\s+are|meaning\s+of)\b/i, intent: "describe", confidence: 0.85 },
  { pattern: /\b(?:as\s+a\s+\w+,?\s+I\s+want)\b/i, intent: "describe", confidence: 0.9 },

  // Query intent
  { pattern: /\b(?:find|search|list|show|get|where|which|look\s+up)\b/i, intent: "query", confidence: 0.85 },
  { pattern: /\b(?:how\s+many|what'?s\s+the\s+status)\b/i, intent: "query", confidence: 0.9 },

  // Decompose intent
  { pattern: /\b(?:break\s+(?:down|into|up)|decompose|split|divide)\b/i, intent: "decompose", confidence: 0.9 },
  { pattern: /\b(?:consists?\s+of|includes?|contains?)\b/i, intent: "decompose", confidence: 0.7 },
];

// ─── Person Patterns ────────────────────────────────────────────────

/**
 * Patterns for detecting person references (assignees, reporters).
 */
export const PERSON_PATTERNS: Array<{
  pattern: RegExp;
  role: "assignee" | "reporter";
}> = [
  // Assignee patterns
  { pattern: /\bassigned?\s+to\s+(\w+(?:\s+\w+)?)\b/i, role: "assignee" },
  { pattern: /\bowner:\s*(\w+(?:\s+\w+)?)\b/i, role: "assignee" },
  { pattern: /\b(?:for|by)\s+@?(\w+(?:\s+\w+)?)\b/i, role: "assignee" },
  { pattern: /@(\w+)\b/, role: "assignee" },

  // Reporter patterns
  { pattern: /\breported\s+by\s+(\w+(?:\s+\w+)?)\b/i, role: "reporter" },
  { pattern: /\bfrom\s+(\w+(?:\s+\w+)?)\b/i, role: "reporter" },
];

// ─── Date Patterns ──────────────────────────────────────────────────

/**
 * Patterns for detecting date references in text.
 * Returns the matched date text for downstream date parsing.
 */
export const DATE_PATTERNS: RegExp[] = [
  // ISO dates
  /\b(\d{4}-\d{2}-\d{2})\b/,

  // Relative dates
  /\b((?:next|this)\s+(?:week|month|quarter|sprint))\b/i,
  /\b((?:by|due|before|until)\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,?\s+\d{4})?))\b/i,

  // Named dates
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,?\s+\d{4})?)\b/i,
  /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
];

// ─── Label Patterns ─────────────────────────────────────────────────

/**
 * Patterns for detecting labels/tags in text.
 */
export const LABEL_PATTERNS: RegExp[] = [
  // Explicit label mentions
  /\blabels?:\s*(\w+(?:,\s*\w+)*)\b/i,
  /\btags?:\s*(\w+(?:,\s*\w+)*)\b/i,

  // Bracketed labels
  /\[(\w+(?:[-/]\w+)*)\]/g,

  // Hashtag-style labels
  /#(\w+(?:[-_]\w+)*)\b/g,
];

// ─── Hierarchy Patterns ─────────────────────────────────────────────

/**
 * Patterns indicating parent-child relationships between items.
 */
export const HIERARCHY_PATTERNS: Array<{
  pattern: RegExp;
  direction: "parent-to-child" | "child-to-parent";
}> = [
  // Parent-to-child
  { pattern: /\b(?:includes?|contains?|consists?\s+of|has)\s+(?:the\s+following|these)\b/i, direction: "parent-to-child" },
  { pattern: /\b(?:broken?\s+(?:down|into)|decomposed?\s+into|split\s+into)\b/i, direction: "parent-to-child" },

  // Child-to-parent
  { pattern: /\b(?:under|within|part\s+of|belongs?\s+to|inside|child\s+of)\b/i, direction: "child-to-parent" },
  { pattern: /\b(?:parent|epic|initiative):\s*/i, direction: "child-to-parent" },
];
