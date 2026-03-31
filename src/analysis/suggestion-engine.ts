/**
 * Suggestion Generation Engine
 *
 * Takes impact analysis results and a description of a term change,
 * analyzes the code at each identified location, and produces specific
 * modification suggestions (renames, comment updates, structural changes)
 * with before/after snippets.
 *
 * This is the "what should change" engine — given that we know which code
 * locations are affected by a term change (from impact analysis), this module
 * figures out what kind of modifications are appropriate for each location.
 *
 * Usage:
 *   const impact = analyzeImpact(storage, "Sprint Velocity");
 *   const suggestions = generateSuggestions(impact, {
 *     type: "rename",
 *     oldName: "Sprint Velocity",
 *     newName: "Iteration Throughput",
 *     description: "Renaming to align with SAFe terminology",
 *   });
 *   console.log(suggestions.suggestions); // Concrete file modifications
 */

import type {
  ImpactAnalysisResult,
  AffectedFile,
  AffectedSymbol,
} from "./impact-analysis.js";
import type { CodeRelationship } from "../models/glossary.js";

// ─── Change Description Types ────────────────────────────────────────

/**
 * The kind of change being made to a term.
 */
export type TermChangeType =
  | "rename"        // Term name is changing
  | "redefine"      // Term meaning/definition is changing
  | "deprecate"     // Term is being retired/deprecated
  | "split"         // Term is being split into multiple new terms
  | "merge"         // Multiple terms are being merged into one
  | "relocate";     // Term's code is moving to a new location

/**
 * Describes what is changing about a term.
 * The engine uses this to determine what kinds of suggestions to generate.
 */
export interface TermChangeDescription {
  /** What kind of change is happening */
  type: TermChangeType;

  /** The original term name (before the change) */
  oldName: string;

  /** The new term name (for rename/merge), or undefined for other change types */
  newName?: string;

  /** Human-readable description of why the change is happening */
  description: string;

  /** For "split" changes: the new term names being created */
  splitInto?: string[];

  /** For "merge" changes: the terms being merged */
  mergeFrom?: string[];

  /** For "relocate" changes: the new file path */
  newLocation?: string;

  /** Updated definition text, if the definition is changing */
  newDefinition?: string;
}

// ─── Suggestion Types ────────────────────────────────────────────────

/**
 * The kind of code modification being suggested.
 */
export type SuggestionKind =
  | "symbol-rename"          // Rename a function, class, variable, etc.
  | "file-rename"            // Rename a file
  | "comment-update"         // Update comments/documentation
  | "string-literal-update"  // Update string literals (log messages, error text, etc.)
  | "import-update"          // Update import statements
  | "deprecation-marker"     // Add deprecation annotations/comments
  | "structural-refactor"    // Larger structural change (split class, move function)
  | "test-update"            // Update test descriptions or assertions
  | "config-update";         // Update configuration values

/**
 * Priority level for a suggestion — how important it is to apply.
 */
export type SuggestionPriority = "critical" | "recommended" | "optional";

/**
 * A single code modification suggestion with before/after snippets.
 */
export interface ModificationSuggestion {
  /** Unique ID for this suggestion (sequential within a result) */
  id: string;

  /** The file this suggestion applies to */
  filePath: string;

  /** The kind of modification */
  kind: SuggestionKind;

  /** How important this change is */
  priority: SuggestionPriority;

  /** Human-readable title for this suggestion */
  title: string;

  /** Detailed explanation of what should change and why */
  rationale: string;

  /** The symbol being modified (if applicable) */
  symbolName?: string;

  /** The relationship type of the affected code location */
  relationship: CodeRelationship;

  /** Line range where the change should be applied (if known) */
  lineRange?: { start: number; end: number };

  /** The code snippet before the change */
  before: string;

  /** The code snippet after the change */
  after: string;

  /** Which glossary term triggered this suggestion */
  fromTermId: string;

  /** Name of the glossary term that triggered this suggestion */
  fromTermName: string;

  /** Whether this suggestion can be auto-applied safely */
  autoApplicable: boolean;
}

/**
 * Summary statistics for the suggestion result.
 */
export interface SuggestionSummary {
  /** Total number of suggestions generated */
  totalSuggestions: number;

  /** Number of files with suggestions */
  filesAffected: number;

  /** Breakdown by suggestion kind */
  byKind: Partial<Record<SuggestionKind, number>>;

  /** Breakdown by priority */
  byPriority: Partial<Record<SuggestionPriority, number>>;

  /** How many suggestions can be auto-applied */
  autoApplicableCount: number;
}

/**
 * The complete result of suggestion generation.
 */
export interface SuggestionResult {
  /** The term change that triggered these suggestions */
  change: TermChangeDescription;

  /** The original impact analysis query */
  query: string;

  /** Whether any suggestions were generated */
  hasSuggestions: boolean;

  /** All generated modification suggestions, ordered by priority */
  suggestions: ModificationSuggestion[];

  /** Summary statistics */
  summary: SuggestionSummary;

  /** Warnings or notes about the suggestion generation */
  warnings: string[];
}

// ─── Configuration ───────────────────────────────────────────────────

/**
 * Options for controlling suggestion generation behavior.
 */
export interface SuggestionOptions {
  /**
   * Maximum number of suggestions to generate per file.
   * Default: 20.
   */
  maxSuggestionsPerFile?: number;

  /**
   * Maximum total suggestions to generate.
   * Default: 100.
   */
  maxTotalSuggestions?: number;

  /**
   * Filter to only generate specific kinds of suggestions.
   * Default: all kinds.
   */
  kinds?: SuggestionKind[];

  /**
   * Minimum priority level — only generate suggestions at or above this priority.
   * Default: "optional" (include all).
   */
  minPriority?: SuggestionPriority;

  /**
   * Whether to include suggestions for test files.
   * Default: true.
   */
  includeTests?: boolean;

  /**
   * Whether to include suggestions for config files.
   * Default: true.
   */
  includeConfigs?: boolean;
}

// ─── Priority Ordering ───────────────────────────────────────────────

const PRIORITY_RANK: Record<SuggestionPriority, number> = {
  critical: 2,
  recommended: 1,
  optional: 0,
};

function meetsPriorityThreshold(
  actual: SuggestionPriority,
  minimum: SuggestionPriority,
): boolean {
  return PRIORITY_RANK[actual] >= PRIORITY_RANK[minimum];
}

// ─── Name Transformation Utilities ───────────────────────────────────

/**
 * Converts a term name to its likely camelCase symbol equivalent.
 * "Sprint Velocity" → "sprintVelocity"
 */
export function toCamelCase(name: string): string {
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return "";
  return (
    words[0].toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
}

/**
 * Converts a term name to its likely PascalCase symbol equivalent.
 * "Sprint Velocity" → "SprintVelocity"
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/**
 * Converts a term name to its likely snake_case equivalent.
 * "Sprint Velocity" → "sprint_velocity"
 */
export function toSnakeCase(name: string): string {
  return name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("_");
}

/**
 * Converts a term name to its likely kebab-case equivalent.
 * "Sprint Velocity" → "sprint-velocity"
 */
export function toKebabCase(name: string): string {
  return name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-");
}

/**
 * Detects the naming convention used in a symbol name.
 */
export function detectNamingConvention(
  symbol: string,
): "camelCase" | "PascalCase" | "snake_case" | "kebab-case" | "unknown" {
  if (symbol.includes("_")) return "snake_case";
  if (symbol.includes("-")) return "kebab-case";
  if (symbol.length > 0 && symbol[0] === symbol[0].toUpperCase() && symbol[0] !== symbol[0].toLowerCase()) {
    return "PascalCase";
  }
  if (symbol.length > 0 && symbol[0] === symbol[0].toLowerCase() && /[A-Z]/.test(symbol)) {
    return "camelCase";
  }
  return "unknown";
}

/**
 * Transforms a term name into the target naming convention.
 */
export function transformName(
  name: string,
  convention: "camelCase" | "PascalCase" | "snake_case" | "kebab-case" | "unknown",
): string {
  switch (convention) {
    case "camelCase":
      return toCamelCase(name);
    case "PascalCase":
      return toPascalCase(name);
    case "snake_case":
      return toSnakeCase(name);
    case "kebab-case":
      return toKebabCase(name);
    default:
      return toCamelCase(name);
  }
}

// ─── Suggestion Generators (by change type) ──────────────────────────

/**
 * Generates suggestions for a rename change.
 * When a term is renamed, symbols, comments, imports, and string literals
 * may all need to be updated.
 */
function generateRenameSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const oldName = change.oldName;
  const newName = change.newName ?? change.oldName;

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;

      if (symbol.name === "(file-level)") {
        // File-level reference — suggest comment/documentation update
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "comment-update",
          priority: "recommended",
          title: `Update references to "${oldName}" in file comments`,
          rationale: `This file references the term "${oldName}" at the file level. ` +
            `Comments and documentation should be updated to use "${newName}".`,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// Related to: ${oldName}`,
          after: `// Related to: ${newName}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
        continue;
      }

      // Detect the naming convention of the existing symbol
      const convention = detectNamingConvention(symbol.name);
      const newSymbolName = transformName(newName, convention);

      // Primary suggestion: rename the symbol
      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "symbol-rename",
          priority: "critical",
          title: `Rename ${symbol.name} → ${newSymbolName}`,
          rationale: `The term "${oldName}" is being renamed to "${newName}". ` +
            `This symbol ${symbol.relationship} the concept and should be renamed to match. ` +
            `${change.description}`,
          symbolName: symbol.name,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name,
          after: newSymbolName,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: true,
        });
      } else if (symbol.relationship === "uses") {
        // Usage sites need to be updated too but are lower priority
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "symbol-rename",
          priority: "recommended",
          title: `Update usage of ${symbol.name} → ${newSymbolName}`,
          rationale: `The term "${oldName}" is being renamed to "${newName}". ` +
            `This symbol uses the concept and references should be updated. ` +
            `${change.description}`,
          symbolName: symbol.name,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name,
          after: newSymbolName,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: true,
        });
      } else if (symbol.relationship === "tests") {
        // Test files — update test descriptions and symbol references
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "test-update",
          priority: "recommended",
          title: `Update test references: ${symbol.name} → ${newSymbolName}`,
          rationale: `The term "${oldName}" is being renamed to "${newName}". ` +
            `Test code should be updated to reference the new name. ` +
            `${change.description}`,
          symbolName: symbol.name,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `describe("${symbol.name}", () => {`,
          after: `describe("${newSymbolName}", () => {`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else if (symbol.relationship === "configures") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "config-update",
          priority: "recommended",
          title: `Update configuration key: ${symbol.name}`,
          rationale: `The term "${oldName}" is being renamed to "${newName}". ` +
            `Configuration entries should be updated to use the new name. ` +
            `${change.description}`,
          symbolName: symbol.name,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `${toSnakeCase(oldName)}: ...`,
          after: `${toSnakeCase(newName)}: ...`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }

      // Additional suggestion: update comments near the symbol
      const commentId = `suggestion-${++idCounter.value}`;
      suggestions.push({
        id: commentId,
        filePath: file.filePath,
        kind: "comment-update",
        priority: "optional",
        title: `Update comments referencing "${oldName}" near ${symbol.name}`,
        rationale: `Comments and JSDoc near this symbol may reference "${oldName}" ` +
          `and should be updated to use "${newName}".`,
        symbolName: symbol.name,
        relationship: symbol.relationship,
        lineRange: symbol.lineRange,
        before: `/** Handles ${oldName} logic */`,
        after: `/** Handles ${newName} logic */`,
        fromTermId: symbol.fromTermId,
        fromTermName: symbol.fromTermName,
        autoApplicable: false,
      });
    }

    // If this is a file whose name contains the old term, suggest file rename
    const oldKebab = toKebabCase(oldName);
    const newKebab = toKebabCase(newName);
    if (file.filePath.toLowerCase().includes(oldKebab)) {
      const fileRenameId = `suggestion-${++idCounter.value}`;
      const newFilePath = file.filePath.replace(
        new RegExp(escapeRegExp(oldKebab), "gi"),
        newKebab,
      );
      suggestions.push({
        id: fileRenameId,
        filePath: file.filePath,
        kind: "file-rename",
        priority: "recommended",
        title: `Rename file to match new term name`,
        rationale: `The file name contains "${oldKebab}" which corresponds to the old term "${oldName}". ` +
          `It should be renamed to "${newKebab}" to match the new term "${newName}".`,
        relationship: file.relationships[0] ?? "defines",
        before: file.filePath,
        after: newFilePath,
        fromTermId: file.termIds[0],
        fromTermName: file.termNames[0],
        autoApplicable: false,
      });

      // Also suggest import updates for files that reference the old path
      const importId = `suggestion-${++idCounter.value}`;
      suggestions.push({
        id: importId,
        filePath: "(dependent files)",
        kind: "import-update",
        priority: "recommended",
        title: `Update imports referencing ${file.filePath}`,
        rationale: `If the file "${file.filePath}" is renamed to "${newFilePath}", ` +
          `all import statements referencing the old path must be updated.`,
        relationship: "uses",
        before: `import { ... } from "./${file.filePath.replace(/\.[^.]+$/, "")}"`,
        after: `import { ... } from "./${newFilePath.replace(/\.[^.]+$/, "")}"`,
        fromTermId: file.termIds[0],
        fromTermName: file.termNames[0],
        autoApplicable: false,
      });
    }
  }

  return suggestions;
}

/**
 * Generates suggestions for a definition change.
 * When a term's meaning changes, comments and documentation need updating.
 */
function generateRedefineSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const termName = change.oldName;
  const newDef = change.newDefinition ?? change.description;

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;
      const displayName = symbol.name === "(file-level)" ? file.filePath : symbol.name;

      // All locations need comment/documentation updates
      suggestions.push({
        id,
        filePath: file.filePath,
        kind: "comment-update",
        priority: symbol.relationship === "defines" ? "critical" : "recommended",
        title: `Update documentation for ${displayName}`,
        rationale: `The definition of "${termName}" has changed. ` +
          `Documentation and comments should be updated to reflect the new meaning. ` +
          `${change.description}`,
        symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
        relationship: symbol.relationship,
        lineRange: symbol.lineRange,
        before: `/** ${termName}: (old definition) */`,
        after: `/** ${termName}: ${truncate(newDef, 80)} */`,
        fromTermId: symbol.fromTermId,
        fromTermName: symbol.fromTermName,
        autoApplicable: false,
      });

      // If the symbol's behavior might need changing, suggest structural review
      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        const structuralId = `suggestion-${++idCounter.value}`;
        suggestions.push({
          id: structuralId,
          filePath: file.filePath,
          kind: "structural-refactor",
          priority: "recommended",
          title: `Review ${displayName} implementation against new definition`,
          rationale: `The meaning of "${termName}" has changed. The implementation in ` +
            `${displayName} should be reviewed to ensure it aligns with the new definition: ` +
            `"${truncate(newDef, 100)}".`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// Implementation based on old "${termName}" definition`,
          after: `// Implementation updated for new "${termName}" definition\n// ${truncate(newDef, 80)}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Generates suggestions for a deprecation change.
 * When a term is deprecated, all code referencing it should be marked accordingly.
 */
function generateDeprecateSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const termName = change.oldName;

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;
      const displayName = symbol.name === "(file-level)" ? file.filePath : symbol.name;

      // Add deprecation markers
      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "deprecation-marker",
          priority: "critical",
          title: `Mark ${displayName} as deprecated`,
          rationale: `The term "${termName}" is being deprecated. ` +
            `This symbol ${symbol.relationship} the concept and should be marked as deprecated. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name !== "(file-level)"
            ? `function ${symbol.name}(`
            : `// ${file.filePath}`,
          after: symbol.name !== "(file-level)"
            ? `/** @deprecated ${change.description} */\nfunction ${symbol.name}(`
            : `// @deprecated ${change.description}\n// ${file.filePath}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else if (symbol.relationship === "uses") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "comment-update",
          priority: "recommended",
          title: `Add deprecation notice for usage of ${displayName}`,
          rationale: `The term "${termName}" is being deprecated. ` +
            `This usage should be reviewed and a migration path identified. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name !== "(file-level)"
            ? `${symbol.name}(`
            : `// Uses ${termName}`,
          after: symbol.name !== "(file-level)"
            ? `// TODO: ${termName} is deprecated — ${truncate(change.description, 60)}\n${symbol.name}(`
            : `// TODO: ${termName} is deprecated — ${truncate(change.description, 60)}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else if (symbol.relationship === "tests") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "test-update",
          priority: "optional",
          title: `Review test coverage for deprecated ${displayName}`,
          rationale: `The term "${termName}" is being deprecated. ` +
            `Tests may need to be updated or marked for future removal. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `describe("${symbol.name}", () => {`,
          after: `describe("${symbol.name} (deprecated)", () => {\n  // TODO: Remove when ${termName} is fully retired`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else {
        // configures or other relationships
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "comment-update",
          priority: "recommended",
          title: `Add deprecation notice in ${file.filePath}`,
          rationale: `The term "${termName}" is being deprecated. ` +
            `This location should be annotated with a deprecation notice. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// ${termName} configuration`,
          after: `// @deprecated ${termName} configuration — ${truncate(change.description, 60)}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Generates suggestions for a split change.
 * When a term is split into multiple new terms, code needs to be reorganized.
 */
function generateSplitSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const oldName = change.oldName;
  const splitInto = change.splitInto ?? [];
  const splitList = splitInto.length > 0
    ? splitInto.map((n) => `"${n}"`).join(", ")
    : "(new terms not specified)";

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;
      const displayName = symbol.name === "(file-level)" ? file.filePath : symbol.name;

      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "structural-refactor",
          priority: "critical",
          title: `Refactor ${displayName} — split "${oldName}" into separate concerns`,
          rationale: `The term "${oldName}" is being split into ${splitList}. ` +
            `This symbol ${symbol.relationship} the concept and should be ` +
            `refactored into separate components for each new term. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name !== "(file-level)"
            ? `class ${symbol.name} { /* handles all ${oldName} concerns */ }`
            : `// ${file.filePath} — monolithic ${oldName} implementation`,
          after: splitInto.length > 0
            ? splitInto
                .map((n) => {
                  const pascal = toPascalCase(n);
                  return `class ${pascal} { /* handles ${n} */ }`;
                })
                .join("\n")
            : `// Split ${oldName} into separate concerns`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else {
        // uses, tests, configures — need to decide which new term to reference
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "comment-update",
          priority: "recommended",
          title: `Review ${displayName} — determine which new term applies`,
          rationale: `The term "${oldName}" is being split into ${splitList}. ` +
            `This location ${symbol.relationship} the concept and should be updated ` +
            `to reference the correct new term. ${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// Uses ${oldName}`,
          after: `// TODO: Determine which of ${splitList} this should reference`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Generates suggestions for a merge change.
 * When multiple terms merge into one, references need consolidation.
 */
function generateMergeSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const newName = change.newName ?? change.oldName;
  const mergeFrom = change.mergeFrom ?? [change.oldName];
  const mergeList = mergeFrom.map((n) => `"${n}"`).join(", ");

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;
      const displayName = symbol.name === "(file-level)" ? file.filePath : symbol.name;

      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        const convention = symbol.name !== "(file-level)"
          ? detectNamingConvention(symbol.name)
          : "PascalCase";
        const newSymbolName = transformName(newName, convention);

        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "structural-refactor",
          priority: "critical",
          title: `Consolidate ${displayName} into unified ${newSymbolName}`,
          rationale: `The terms ${mergeList} are being merged into "${newName}". ` +
            `This symbol should be consolidated with the other merged terms' implementations. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: symbol.name !== "(file-level)"
            ? `class ${symbol.name} { /* partial implementation */ }`
            : `// ${file.filePath}`,
          after: `class ${newSymbolName} { /* consolidated from ${mergeList} */ }`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "symbol-rename",
          priority: "recommended",
          title: `Update ${displayName} to reference merged term "${newName}"`,
          rationale: `The terms ${mergeList} are being merged into "${newName}". ` +
            `This reference should be updated. ${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// References ${symbol.fromTermName}`,
          after: `// References ${newName}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }
    }
  }

  return suggestions;
}

/**
 * Generates suggestions for a relocate change.
 * When a term's code moves to a new location, imports and references need updating.
 */
function generateRelocateSuggestions(
  change: TermChangeDescription,
  affectedFiles: AffectedFile[],
  idCounter: { value: number },
): ModificationSuggestion[] {
  const suggestions: ModificationSuggestion[] = [];
  const termName = change.oldName;
  const newLocation = change.newLocation ?? "(new location not specified)";

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      const id = `suggestion-${++idCounter.value}`;
      const displayName = symbol.name === "(file-level)" ? file.filePath : symbol.name;

      if (symbol.relationship === "defines" || symbol.relationship === "implements") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "structural-refactor",
          priority: "critical",
          title: `Move ${displayName} to ${newLocation}`,
          rationale: `The term "${termName}" code is being relocated. ` +
            `This symbol should be moved from ${file.filePath} to ${newLocation}. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// ${file.filePath}\n${symbol.name !== "(file-level)" ? `export function ${symbol.name}(` : `// ${termName} implementation`}`,
          after: `// ${newLocation}\n${symbol.name !== "(file-level)" ? `export function ${symbol.name}(` : `// ${termName} implementation (relocated)`}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else if (symbol.relationship === "uses") {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "import-update",
          priority: "critical",
          title: `Update import path for ${displayName}`,
          rationale: `The term "${termName}" code is being relocated from its current location ` +
            `to ${newLocation}. Import statements in this file must be updated. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `import { ${symbol.name !== "(file-level)" ? symbol.name : "..."} } from "(old location)"`,
          after: `import { ${symbol.name !== "(file-level)" ? symbol.name : "..."} } from "${newLocation.replace(/\.[^.]+$/, "")}"`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      } else {
        suggestions.push({
          id,
          filePath: file.filePath,
          kind: "comment-update",
          priority: "recommended",
          title: `Update reference to ${termName} location in ${displayName}`,
          rationale: `The term "${termName}" code is being relocated to ${newLocation}. ` +
            `References in this file should be updated to point to the new location. ` +
            `${change.description}`,
          symbolName: symbol.name !== "(file-level)" ? symbol.name : undefined,
          relationship: symbol.relationship,
          lineRange: symbol.lineRange,
          before: `// See ${file.filePath} for ${termName}`,
          after: `// See ${newLocation} for ${termName}`,
          fromTermId: symbol.fromTermId,
          fromTermName: symbol.fromTermName,
          autoApplicable: false,
        });
      }
    }
  }

  return suggestions;
}

// ─── Utility Functions ───────────────────────────────────────────────

/**
 * Truncates a string to a given length, adding "..." if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Escapes a string for use in a RegExp.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Core Generation Function ────────────────────────────────────────

/**
 * Generate modification suggestions based on impact analysis results
 * and a description of the term change.
 *
 * This is the main entry point for the suggestion engine. It:
 * 1. Routes to the appropriate generator based on change type
 * 2. Applies filtering (kinds, priority, test/config inclusion)
 * 3. Enforces limits (per-file and total)
 * 4. Produces summary statistics
 *
 * @param impactResult - The output from analyzeImpact()
 * @param change - Description of what is changing about the term
 * @param options - Optional configuration for suggestion generation
 * @returns Complete suggestion result with modifications and summary
 */
export function generateSuggestions(
  impactResult: ImpactAnalysisResult,
  change: TermChangeDescription,
  options?: SuggestionOptions,
): SuggestionResult {
  const maxPerFile = options?.maxSuggestionsPerFile ?? 20;
  const maxTotal = options?.maxTotalSuggestions ?? 100;
  const kindFilter = options?.kinds ? new Set(options.kinds) : undefined;
  const minPriority = options?.minPriority ?? "optional";
  const includeTests = options?.includeTests ?? true;
  const includeConfigs = options?.includeConfigs ?? true;

  const warnings: string[] = [];

  // If no affected files, return empty result
  if (!impactResult.found || impactResult.affectedFiles.length === 0) {
    return {
      change,
      query: impactResult.query,
      hasSuggestions: false,
      suggestions: [],
      summary: {
        totalSuggestions: 0,
        filesAffected: 0,
        byKind: {},
        byPriority: {},
        autoApplicableCount: 0,
      },
      warnings: impactResult.found
        ? ["Impact analysis found matching terms but no affected files."]
        : ["No matching terms found for the given query."],
    };
  }

  // Filter out test/config files if requested
  let affectedFiles = [...impactResult.affectedFiles];

  if (!includeTests) {
    const before = affectedFiles.length;
    affectedFiles = affectedFiles.filter(
      (f) => !f.relationships.includes("tests"),
    );
    if (affectedFiles.length < before) {
      warnings.push(
        `Excluded ${before - affectedFiles.length} test file(s) from suggestions.`,
      );
    }
  }

  if (!includeConfigs) {
    const before = affectedFiles.length;
    affectedFiles = affectedFiles.filter(
      (f) => !f.relationships.includes("configures"),
    );
    if (affectedFiles.length < before) {
      warnings.push(
        `Excluded ${before - affectedFiles.length} config file(s) from suggestions.`,
      );
    }
  }

  // Generate suggestions based on change type
  const idCounter = { value: 0 };
  let rawSuggestions: ModificationSuggestion[];

  switch (change.type) {
    case "rename":
      rawSuggestions = generateRenameSuggestions(change, affectedFiles, idCounter);
      break;
    case "redefine":
      rawSuggestions = generateRedefineSuggestions(change, affectedFiles, idCounter);
      break;
    case "deprecate":
      rawSuggestions = generateDeprecateSuggestions(change, affectedFiles, idCounter);
      break;
    case "split":
      rawSuggestions = generateSplitSuggestions(change, affectedFiles, idCounter);
      break;
    case "merge":
      rawSuggestions = generateMergeSuggestions(change, affectedFiles, idCounter);
      break;
    case "relocate":
      rawSuggestions = generateRelocateSuggestions(change, affectedFiles, idCounter);
      break;
    default:
      rawSuggestions = [];
      warnings.push(`Unknown change type: ${(change as TermChangeDescription).type}`);
  }

  // Apply kind filter
  if (kindFilter) {
    rawSuggestions = rawSuggestions.filter((s) => kindFilter.has(s.kind));
  }

  // Apply priority filter
  rawSuggestions = rawSuggestions.filter((s) =>
    meetsPriorityThreshold(s.priority, minPriority),
  );

  // Apply per-file limit
  if (maxPerFile < Infinity) {
    const fileCounts = new Map<string, number>();
    rawSuggestions = rawSuggestions.filter((s) => {
      const count = fileCounts.get(s.filePath) ?? 0;
      if (count >= maxPerFile) {
        return false;
      }
      fileCounts.set(s.filePath, count + 1);
      return true;
    });
  }

  // Sort by priority (critical first, then recommended, then optional)
  rawSuggestions.sort((a, b) => {
    const priorityDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (priorityDiff !== 0) return priorityDiff;
    // Within same priority, sort by file path for stability
    return a.filePath.localeCompare(b.filePath);
  });

  // Apply total limit
  if (rawSuggestions.length > maxTotal) {
    warnings.push(
      `Truncated suggestions from ${rawSuggestions.length} to ${maxTotal} (maxTotalSuggestions).`,
    );
    rawSuggestions = rawSuggestions.slice(0, maxTotal);
  }

  // Build summary
  const byKind: Partial<Record<SuggestionKind, number>> = {};
  const byPriority: Partial<Record<SuggestionPriority, number>> = {};
  const filesSet = new Set<string>();
  let autoApplicableCount = 0;

  for (const s of rawSuggestions) {
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    byPriority[s.priority] = (byPriority[s.priority] ?? 0) + 1;
    filesSet.add(s.filePath);
    if (s.autoApplicable) autoApplicableCount++;
  }

  const summary: SuggestionSummary = {
    totalSuggestions: rawSuggestions.length,
    filesAffected: filesSet.size,
    byKind,
    byPriority,
    autoApplicableCount,
  };

  return {
    change,
    query: impactResult.query,
    hasSuggestions: rawSuggestions.length > 0,
    suggestions: rawSuggestions,
    summary,
    warnings,
  };
}
