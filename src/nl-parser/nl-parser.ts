/**
 * Natural Language Input Parser
 *
 * Extracts intent, entities, and hierarchy from natural language text
 * and produces structured PM item objects (CreatePmItemInput).
 *
 * Pipeline:
 *   1. Detect intent (create, update, describe, query, decompose)
 *   2. Extract entities (item types, statuses, priorities, labels, people, dates)
 *   3. Extract titles from the text structure
 *   4. Detect hierarchy (parent-child relationships from bullet lists, "under", etc.)
 *   5. Assemble entities into CreatePmItemInput objects
 *
 * Design:
 * - Pure functions, no side effects, fully synchronous
 * - Rule-based extraction — no external AI/LLM dependency
 * - Confidence scoring for every extraction decision
 * - Designed to be wrapped by an AI-powered enrichment layer later
 */

import type { PmItemType, PmStatus, PmPriority, CreatePmItemInput } from "../models/pm-items.js";
import type {
  NlParseResult,
  NlIntent,
  NlEntity,
  NlEntityKind,
  NlHierarchyRelation,
  NlParserOptions,
  TextSpan,
} from "./types.js";
import {
  INTENT_PATTERNS,
  ITEM_TYPE_PATTERNS,
  STATUS_PATTERNS,
  PRIORITY_PATTERNS,
  PERSON_PATTERNS,
  DATE_PATTERNS,
  LABEL_PATTERNS,
  HIERARCHY_PATTERNS,
} from "./entity-patterns.js";

// ─── Default Options ────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<NlParserOptions> = {
  defaultItemType: "task",
  defaultStatus: "backlog",
  defaultPriority: "none",
  sourceAdapter: "nl-parser",
  minEntityConfidence: 0.3,
};

// ─── Main Parser ────────────────────────────────────────────────────

/**
 * Parse natural language text into structured PM item data.
 *
 * @param text - The natural language input to parse
 * @param options - Parser configuration options
 * @returns A complete parse result with intent, entities, items, and hierarchy
 */
export function parseNaturalLanguage(
  text: string,
  options?: NlParserOptions
): NlParseResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const diagnostics: string[] = [];

  if (!text || !text.trim()) {
    return {
      intent: "unknown",
      confidence: 0,
      entities: [],
      items: [],
      hierarchy: [],
      rawText: text ?? "",
      diagnostics: ["Empty input text"],
    };
  }

  const normalizedText = text.trim();

  // Step 1: Detect intent
  const { intent, confidence: intentConfidence } = detectIntent(normalizedText);

  // Step 2: Extract all entities
  const allEntities = extractAllEntities(normalizedText, opts.minEntityConfidence);

  // Step 3: Extract titles from the text
  const titles = extractTitles(normalizedText, allEntities);

  // Step 4: Detect hierarchy
  const hierarchy = detectHierarchy(normalizedText, titles, allEntities);

  // Step 5: Assemble PM items from entities + titles
  const items = assembleItems(normalizedText, titles, allEntities, hierarchy, opts, diagnostics);

  // Calculate overall confidence
  const entityConfidences = allEntities.map((e) => e.confidence);
  const avgEntityConfidence =
    entityConfidences.length > 0
      ? entityConfidences.reduce((a, b) => a + b, 0) / entityConfidences.length
      : 0.5;
  const overallConfidence = Math.min(
    1.0,
    (intentConfidence * 0.4 + avgEntityConfidence * 0.3 + (items.length > 0 ? 0.3 : 0))
  );

  return {
    intent,
    confidence: Math.round(overallConfidence * 100) / 100,
    entities: allEntities,
    items,
    hierarchy,
    rawText: normalizedText,
    diagnostics,
  };
}

// ─── Intent Detection ───────────────────────────────────────────────

/**
 * Detect the user's intent from the input text.
 * Returns the highest-confidence intent match.
 */
export function detectIntent(text: string): { intent: NlIntent; confidence: number } {
  let bestIntent: NlIntent = "unknown";
  let bestConfidence = 0;

  for (const { pattern, intent, confidence } of INTENT_PATTERNS) {
    if (pattern.test(text) && confidence > bestConfidence) {
      bestIntent = intent;
      bestConfidence = confidence;
    }
  }

  // If no explicit intent but text has list structure, assume "create" or "decompose"
  if (bestIntent === "unknown") {
    const hasListStructure = /(?:^|\n)\s*[-*•]\s+/m.test(text);
    const hasNumberedList = /(?:^|\n)\s*\d+[.)]\s+/m.test(text);

    if (hasListStructure || hasNumberedList) {
      // If there's a header followed by list items, it's decomposition
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length > 1 && !lines[0].match(/^\s*[-*•\d]/)) {
        bestIntent = "decompose";
        bestConfidence = 0.6;
      } else {
        bestIntent = "create";
        bestConfidence = 0.5;
      }
    }
  }

  // User story format "As a X, I want Y" strongly implies create intent
  // (overrides describe since user stories are items to be created)
  if (/\bas\s+a\s+\w+.*I\s+want/i.test(text)) {
    bestIntent = "create";
    bestConfidence = 0.95;
  }

  return { intent: bestIntent, confidence: bestConfidence };
}

// ─── Entity Extraction ──────────────────────────────────────────────

/**
 * Extract all entities from the input text.
 * Runs all entity extractors and merges results.
 */
export function extractAllEntities(
  text: string,
  minConfidence: number
): NlEntity[] {
  const entities: NlEntity[] = [
    ...extractItemTypes(text),
    ...extractStatuses(text),
    ...extractPriorities(text),
    ...extractLabels(text),
    ...extractPersons(text),
    ...extractDates(text),
  ];

  // Filter by minimum confidence
  return entities.filter((e) => e.confidence >= minConfidence);
}

/**
 * Extract PM item type entities from text.
 */
export function extractItemTypes(text: string): NlEntity[] {
  const entities: NlEntity[] = [];
  const seen = new Set<number>(); // track start positions to avoid duplicates

  for (const { pattern, type, confidence } of ITEM_TYPE_PATTERNS) {
    // Reset regex lastIndex for global patterns
    const regex = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    let match: RegExpExecArray | null;
    const globalRegex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");

    while ((match = globalRegex.exec(text)) !== null) {
      const start = match.index;
      if (seen.has(start)) continue;
      seen.add(start);

      entities.push({
        kind: "item_type",
        rawValue: match[0],
        normalizedValue: type,
        span: { start, end: start + match[0].length },
        confidence,
      });

      // Prevent infinite loop on zero-width matches
      if (match[0].length === 0) break;
    }
  }

  // Deduplicate: if multiple patterns match at overlapping spans,
  // keep the one with highest confidence
  return deduplicateEntities(entities);
}

/**
 * Extract status entities from text.
 */
export function extractStatuses(text: string): NlEntity[] {
  const entities: NlEntity[] = [];

  for (const { pattern, status, confidence } of STATUS_PATTERNS) {
    const globalRegex = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(text)) !== null) {
      entities.push({
        kind: "status",
        rawValue: match[0],
        normalizedValue: status,
        span: { start: match.index, end: match.index + match[0].length },
        confidence,
      });
      if (match[0].length === 0) break;
    }
  }

  return deduplicateEntities(entities);
}

/**
 * Extract priority entities from text.
 */
export function extractPriorities(text: string): NlEntity[] {
  const entities: NlEntity[] = [];

  for (const { pattern, priority, confidence } of PRIORITY_PATTERNS) {
    const globalRegex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(text)) !== null) {
      entities.push({
        kind: "priority",
        rawValue: match[0],
        normalizedValue: priority,
        span: { start: match.index, end: match.index + match[0].length },
        confidence,
      });
      if (match[0].length === 0) break;
    }
  }

  return deduplicateEntities(entities);
}

/**
 * Extract label/tag entities from text.
 */
export function extractLabels(text: string): NlEntity[] {
  const entities: NlEntity[] = [];

  for (const pattern of LABEL_PATTERNS) {
    const globalRegex = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(text)) !== null) {
      const rawValue = match[0];
      const labelValue = match[1] || rawValue;

      // Split comma-separated labels
      const labels = labelValue.split(/,\s*/);
      for (const label of labels) {
        const trimmed = label.trim();
        if (!trimmed) continue;

        entities.push({
          kind: "label",
          rawValue: rawValue,
          normalizedValue: trimmed.toLowerCase(),
          span: { start: match.index, end: match.index + rawValue.length },
          confidence: 0.8,
        });
      }

      if (match[0].length === 0) break;
    }
  }

  return entities;
}

/**
 * Extract person reference entities from text.
 */
export function extractPersons(text: string): NlEntity[] {
  const entities: NlEntity[] = [];

  for (const { pattern, role } of PERSON_PATTERNS) {
    const globalRegex = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(text)) !== null) {
      const personName = match[1]?.trim();
      if (!personName) continue;

      // Skip if person name looks like a common word
      if (isCommonWord(personName)) continue;

      entities.push({
        kind: "person",
        rawValue: match[0],
        normalizedValue: personName,
        span: { start: match.index, end: match.index + match[0].length },
        confidence: 0.7,
      });

      if (match[0].length === 0) break;
    }
  }

  return entities;
}

/**
 * Extract date reference entities from text.
 */
export function extractDates(text: string): NlEntity[] {
  const entities: NlEntity[] = [];

  for (const pattern of DATE_PATTERNS) {
    const globalRegex = new RegExp(pattern.source, "gi");
    let match: RegExpExecArray | null;

    while ((match = globalRegex.exec(text)) !== null) {
      const dateValue = match[1] || match[0];

      entities.push({
        kind: "date",
        rawValue: match[0],
        normalizedValue: dateValue.trim(),
        span: { start: match.index, end: match.index + match[0].length },
        confidence: 0.85,
      });

      if (match[0].length === 0) break;
    }
  }

  return entities;
}

// ─── Title Extraction ───────────────────────────────────────────────

/**
 * Structured title extracted from text with its inferred item type.
 */
export interface ExtractedTitle {
  title: string;
  inferredType?: PmItemType;
  indentLevel: number;
  lineIndex: number;
}

/**
 * Extract item titles from the input text.
 *
 * Strategies:
 * 1. Bullet/numbered list items → each is a title
 * 2. "Type: Title" patterns → explicit type + title
 * 3. User story format "As a X, I want Y, so that Z"
 * 4. Single-line input → the whole line is a title
 */
export function extractTitles(
  text: string,
  entities: NlEntity[]
): ExtractedTitle[] {
  const titles: ExtractedTitle[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Measure indent level (for hierarchy detection)
    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
    const indentLevel = Math.floor(leadingSpaces / 2);

    // Strategy 1: Bullet list item
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      const bulletContent = bulletMatch[1].trim();
      const parsed = parseTitleLine(bulletContent, entities);
      titles.push({
        title: parsed.title,
        inferredType: parsed.type,
        indentLevel,
        lineIndex: i,
      });
      continue;
    }

    // Strategy 2: Numbered list item
    const numberMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numberMatch) {
      const numberedContent = numberMatch[1].trim();
      const parsed = parseTitleLine(numberedContent, entities);
      titles.push({
        title: parsed.title,
        inferredType: parsed.type,
        indentLevel,
        lineIndex: i,
      });
      continue;
    }

    // Strategy 3: "Type: Title" pattern
    const typeTitleMatch = trimmed.match(
      /^(initiative|epic|story|task|subtask|bug|feature|milestone)[:\-]\s*(.+)$/i
    );
    if (typeTitleMatch) {
      const typeStr = typeTitleMatch[1].toLowerCase();
      const title = typeTitleMatch[2].trim();
      titles.push({
        title,
        inferredType: normalizeItemType(typeStr),
        indentLevel,
        lineIndex: i,
      });
      continue;
    }

    // Strategy 4: User story format
    const userStoryMatch = trimmed.match(
      /^as\s+a\s+(\w+(?:\s+\w+)*),?\s+I\s+want\s+(.+?)(?:,?\s+so\s+that\s+(.+))?$/i
    );
    if (userStoryMatch) {
      const want = userStoryMatch[2].trim();
      titles.push({
        title: trimmed,
        inferredType: "story",
        indentLevel,
        lineIndex: i,
      });
      continue;
    }

    // Strategy 5: If this is a single-line input or a header line (first non-blank line
    // before bullet items), treat as a title
    if (lines.length === 1) {
      const parsed = parseTitleLine(trimmed, entities);
      titles.push({
        title: parsed.title,
        inferredType: parsed.type,
        indentLevel: 0,
        lineIndex: i,
      });
    } else if (i === 0 || (i > 0 && !isListLine(lines[i - 1]) && isListLine(lines[i + 1] ?? ""))) {
      // This line is a header before a list — it's the parent item
      const parsed = parseTitleLine(trimmed, entities);

      // Don't treat pure meta/intent lines as titles
      if (!isPureMetaLine(trimmed)) {
        titles.push({
          title: parsed.title,
          inferredType: parsed.type,
          indentLevel,
          lineIndex: i,
        });
      }
    }
  }

  return titles;
}

// ─── Hierarchy Detection ────────────────────────────────────────────

/**
 * Detect parent-child relationships from the text structure and keywords.
 *
 * Signals:
 * 1. Indentation levels in bullet lists
 * 2. "under", "part of", "belongs to" keywords
 * 3. Header + bullet list structure (header is parent, bullets are children)
 */
export function detectHierarchy(
  text: string,
  titles: ExtractedTitle[],
  entities: NlEntity[]
): NlHierarchyRelation[] {
  const relations: NlHierarchyRelation[] = [];

  if (titles.length < 2) return relations;

  // Strategy 1: Header + list items → header is parent
  const headerTitle = titles.find((t) => t.indentLevel === 0 && t.lineIndex === 0);
  const listTitles = titles.filter((t) => t.lineIndex > 0);

  if (headerTitle && listTitles.length > 0) {
    const parentType = headerTitle.inferredType ?? inferParentType(listTitles);

    for (const child of listTitles) {
      // Only create hierarchy if the child is at a deeper indent or is a list item
      if (child.indentLevel >= headerTitle.indentLevel) {
        relations.push({
          parentTitle: headerTitle.title,
          parentType,
          childTitle: child.title,
          childType: child.inferredType ?? inferChildType(parentType),
        });
      }
    }
  }

  // Strategy 2: Nested indent levels
  const sortedByLine = [...titles].sort((a, b) => a.lineIndex - b.lineIndex);
  for (let i = 1; i < sortedByLine.length; i++) {
    const current = sortedByLine[i];
    const previous = sortedByLine[i - 1];

    // If current is more indented than previous, it's a child
    if (current.indentLevel > previous.indentLevel) {
      // Check we haven't already created this relation in Strategy 1
      const alreadyExists = relations.some(
        (r) => r.parentTitle === previous.title && r.childTitle === current.title
      );
      if (!alreadyExists) {
        relations.push({
          parentTitle: previous.title,
          parentType: previous.inferredType ?? "epic",
          childTitle: current.title,
          childType: current.inferredType ?? inferChildType(previous.inferredType ?? "epic"),
        });
      }
    }
  }

  // Strategy 3: Keyword-based hierarchy ("under Epic X", "part of")
  for (const { pattern, direction } of HIERARCHY_PATTERNS) {
    if (!pattern.test(text)) continue;

    // This is a signal that the text describes hierarchy,
    // which we've already captured through structure.
    // Could be enhanced with more specific keyword extraction later.
  }

  return relations;
}

// ─── Item Assembly ──────────────────────────────────────────────────

/**
 * Assemble extracted titles and entities into CreatePmItemInput objects.
 */
function assembleItems(
  text: string,
  titles: ExtractedTitle[],
  entities: NlEntity[],
  hierarchy: NlHierarchyRelation[],
  opts: Required<NlParserOptions>,
  diagnostics: string[]
): CreatePmItemInput[] {
  if (titles.length === 0) {
    // If no titles were extracted but there's text, try to use the whole text as a single item
    const cleanText = text.replace(/\n/g, " ").trim();
    if (cleanText.length > 0 && cleanText.length <= 200) {
      const cleanedTitle = stripMetaPrefix(cleanText);
      if (cleanedTitle) {
        return [buildItem(cleanedTitle, entities, opts)];
      }
    }
    diagnostics.push("Could not extract any item titles from the input");
    return [];
  }

  const items: CreatePmItemInput[] = [];

  for (const extracted of titles) {
    const item = buildItem(extracted.title, entities, opts, extracted.inferredType);
    items.push(item);
  }

  if (items.length === 0) {
    diagnostics.push("Entities were extracted but no complete items could be assembled");
  }

  return items;
}

/**
 * Build a single CreatePmItemInput from a title and extracted entities.
 */
function buildItem(
  title: string,
  entities: NlEntity[],
  opts: Required<NlParserOptions>,
  inferredType?: PmItemType
): CreatePmItemInput {
  // Determine item type: explicit entity > inferred from title > default
  const typeEntity = entities.find((e) => e.kind === "item_type");
  const type = inferredType ?? (typeEntity?.normalizedValue as PmItemType) ?? opts.defaultItemType;

  // Determine status: from entities > default
  const statusEntity = entities.find((e) => e.kind === "status");
  const status = (statusEntity?.normalizedValue as PmStatus) ?? opts.defaultStatus;

  // Determine priority: from entities > default
  const priorityEntity = entities.find((e) => e.kind === "priority");
  const priority = (priorityEntity?.normalizedValue as PmPriority) ?? opts.defaultPriority;

  // Collect labels
  const labelEntities = entities.filter((e) => e.kind === "label");
  const labels = [...new Set(labelEntities.map((e) => e.normalizedValue))];

  // Determine assignee
  const assigneeEntity = entities.find(
    (e) => e.kind === "person" && e.rawValue.match(/assign|owner|@|for\s/i)
  );
  const assignee = assigneeEntity
    ? { name: assigneeEntity.normalizedValue }
    : undefined;

  // Determine reporter
  const reporterEntity = entities.find(
    (e) => e.kind === "person" && e.rawValue.match(/reported|from\s/i)
  );
  const reporter = reporterEntity
    ? { name: reporterEntity.normalizedValue }
    : undefined;

  // Extract description (user story acceptance criteria, etc.)
  const description = extractDescription(title, entities);

  return {
    type,
    title: cleanTitle(title),
    description,
    status,
    priority,
    labels,
    assignee,
    reporter,
    source: { adapter: opts.sourceAdapter },
  };
}

// ─── Helper Functions ───────────────────────────────────────────────

/**
 * Parse a title line that may contain an inline type prefix.
 * E.g., "Epic: User Authentication" → { type: "epic", title: "User Authentication" }
 */
function parseTitleLine(
  line: string,
  entities: NlEntity[]
): { title: string; type?: PmItemType } {
  // Check for "Type: Title" or "Type - Title"
  const typeMatch = line.match(
    /^(initiative|epic|story|task|subtask|bug|feature|milestone)[:\-]\s*(.+)$/i
  );
  if (typeMatch) {
    return {
      title: typeMatch[2].trim(),
      type: normalizeItemType(typeMatch[1]),
    };
  }

  // Check for "[Type] Title"
  const bracketMatch = line.match(
    /^\[(initiative|epic|story|task|subtask|bug|feature|milestone)\]\s*(.+)$/i
  );
  if (bracketMatch) {
    return {
      title: bracketMatch[2].trim(),
      type: normalizeItemType(bracketMatch[1]),
    };
  }

  return { title: line };
}

/**
 * Normalize an item type string to a canonical PmItemType.
 */
function normalizeItemType(raw: string): PmItemType {
  const lower = raw.toLowerCase().trim();
  const mapping: Record<string, PmItemType> = {
    initiative: "initiative",
    epic: "epic",
    story: "story",
    stories: "story",
    "user story": "story",
    task: "task",
    tasks: "task",
    subtask: "subtask",
    "sub-task": "subtask",
    bug: "bug",
    bugs: "bug",
    feature: "feature",
    features: "feature",
    milestone: "milestone",
    milestones: "milestone",
  };
  return mapping[lower] ?? "task";
}

/**
 * Infer the parent type based on child types.
 * E.g., if children are stories, parent is likely an epic.
 */
function inferParentType(children: ExtractedTitle[]): PmItemType {
  const childTypes = children
    .map((c) => c.inferredType)
    .filter((t): t is PmItemType => !!t);

  if (childTypes.includes("epic")) return "initiative";
  if (childTypes.includes("story")) return "epic";
  if (childTypes.includes("task") || childTypes.includes("subtask")) return "story";
  return "epic"; // Default parent type
}

/**
 * Infer the child type based on the parent type.
 */
function inferChildType(parentType: PmItemType): PmItemType {
  const childMapping: Record<PmItemType, PmItemType> = {
    initiative: "epic",
    epic: "story",
    story: "task",
    task: "subtask",
    subtask: "subtask",
    bug: "task",
    feature: "story",
    milestone: "epic",
  };
  return childMapping[parentType] ?? "task";
}

/**
 * Clean a title string by removing metadata prefixes and extra whitespace.
 */
function cleanTitle(title: string): string {
  return title
    .replace(/^\s*[-*•]\s+/, "")       // Remove bullet prefix
    .replace(/^\s*\d+[.)]\s+/, "")     // Remove numbered prefix
    .replace(/\s{2,}/g, " ")           // Collapse whitespace
    .trim();
}

/**
 * Strip intent/meta prefix from a line to extract a usable title.
 * E.g., "Create a new login page" → "login page"
 */
function stripMetaPrefix(text: string): string {
  return text
    .replace(/^(?:create|add|make|build|implement|write|develop|we\s+need)\s+(?:a\s+(?:new\s+)?)?/i, "")
    .replace(/^(?:new\s+)/i, "")
    .trim();
}

/**
 * Extract a description from the title (e.g., user story "so that" clause).
 */
function extractDescription(title: string, entities: NlEntity[]): string {
  // User story format: extract the "so that" clause as description
  const storyMatch = title.match(
    /as\s+a\s+\w+(?:\s+\w+)*,?\s+I\s+want\s+(.+?)(?:,?\s+so\s+that\s+(.+))?$/i
  );
  if (storyMatch && storyMatch[2]) {
    return `Acceptance criteria: ${storyMatch[2].trim()}`;
  }

  return "";
}

/**
 * Check if a line is a bullet/numbered list item.
 */
function isListLine(line: string): boolean {
  const trimmed = line.trim();
  return /^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
}

/**
 * Check if a line is purely meta/intent without a meaningful title.
 * E.g., "Create the following tasks:" is meta, not a title.
 */
function isPureMetaLine(line: string): boolean {
  return /^(?:create|add|here\s+are|the\s+following|these\s+are|list\s+of)\b.*[:]\s*$/i.test(line);
}

/**
 * Check if a word is too common to be a person's name.
 */
function isCommonWord(word: string): boolean {
  const commonWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
    "for", "of", "with", "by", "from", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "can",
    "this", "that", "it", "them", "they", "we", "you", "me",
    "my", "your", "our", "their", "his", "her", "its",
    "all", "each", "every", "some", "any", "no", "not",
    "task", "tasks", "story", "stories", "epic", "bug", "feature",
    "new", "next", "week", "month", "sprint",
  ]);
  return commonWords.has(word.toLowerCase());
}

/**
 * Deduplicate entities that overlap in text position.
 * When multiple entities cover the same span, keep the one with highest confidence.
 */
function deduplicateEntities(entities: NlEntity[]): NlEntity[] {
  if (entities.length <= 1) return entities;

  // Sort by start position, then by confidence (descending)
  const sorted = [...entities].sort((a, b) => {
    if (a.span.start !== b.span.start) return a.span.start - b.span.start;
    return b.confidence - a.confidence;
  });

  const result: NlEntity[] = [];
  let lastEnd = -1;

  for (const entity of sorted) {
    // If this entity overlaps with the previous one kept, skip it
    // (the previous one has higher or equal confidence due to sorting)
    if (entity.span.start < lastEnd) continue;

    result.push(entity);
    lastEnd = entity.span.end;
  }

  return result;
}
