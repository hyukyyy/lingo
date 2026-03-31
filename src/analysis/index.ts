/**
 * Analysis module — Impact analysis and suggestion generation capabilities.
 *
 * Provides functions for analyzing how organizational planning terms
 * map to code locations across the codebase, and for generating
 * concrete modification suggestions when terms change.
 */

export {
  analyzeImpact,
  type ImpactAnalysisResult,
  type ImpactAnalysisOptions,
  type ImpactSummary,
  type AffectedFile,
  type AffectedSymbol,
  type MatchedTermSummary,
} from "./impact-analysis.js";

export {
  generateSuggestions,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  toKebabCase,
  detectNamingConvention,
  transformName,
  type TermChangeType,
  type TermChangeDescription,
  type SuggestionKind,
  type SuggestionPriority,
  type ModificationSuggestion,
  type SuggestionSummary,
  type SuggestionResult,
  type SuggestionOptions,
} from "./suggestion-engine.js";
