/**
 * Lingo — Organizational context layer for AI development tools.
 *
 * This is the main entry point for the lingo package.
 * Re-exports the scanner module and core types.
 */

// Core types
export type {
  CodeConcept,
  CodeConceptKind,
  SupportedLanguage,
  ScanConfig,
  ScanResult,
  ScanStats,
  ScanDiagnostic,
  LanguageParser,
} from "./types/index.js";

export {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATTERNS,
} from "./types/index.js";

// Scanner
export {
  CodebaseScanner,
  ParserRegistry,
  TypeScriptParser,
  PythonParser,
  discoverFiles,
  readFileContent,
} from "./scanner/index.js";

// Tools
export {
  registerTools,
  TOOL_NAMES,
  ALL_TOOL_NAMES,
  type RegisterToolsOptions,
} from "./tools/index.js";

// Resources
export {
  registerResources,
  RESOURCE_URIS,
  STATIC_RESOURCE_URIS,
  RESOURCE_TEMPLATE_NAMES,
} from "./resources/index.js";

// Adapters — abstract interface & types
export type {
  PMAdapter,
  PMItem,
  PMItemType,
  NormalizedTerm,
  ExtractionOptions,
  ExtractionResult,
  ExtractionStats,
  ConnectionStatus,
} from "./adapters/index.js";

// Adapter registry & factory
export {
  AdapterRegistry,
  AdapterRegistryError,
  type AdapterFactory,
  type AdapterFactoryRegistration,
  type AdapterInfo,
  type AdapterRegistryErrorCode,
} from "./adapters/index.js";

// Built-in adapter discovery
export {
  registerBuiltinAdapters,
  getBuiltinAdapterNames,
} from "./adapters/index.js";

// Concrete adapters (for direct use when needed)
export {
  NotionAdapter,
  type NotionAdapterConfig,
  HttpNotionClient,
  NotionApiError,
  type NotionClient,
  type NotionClientConfig,
  createNotionAdapter,
  notionFactoryRegistration,
} from "./adapters/index.js";

// Mapping engine
export {
  MappingEngine,
  type MappingCandidate,
  type MappingConfig,
  type MappingResult,
  type MappingStats,
  type MatchStrategy,
  tokenize,
  tokenizeIdentifier,
  tokenizeFilePath,
  tokenizeSentence,
  computeTokenOverlap,
  computePartialTokenOverlap,
  normalizeForComparison,
} from "./mapping/index.js";

// Bootstrap orchestrator
export {
  BootstrapOrchestrator,
  type BootstrapOptions,
  type BootstrapSummary,
  type BootstrapTermPreview,
} from "./bootstrap/index.js";

// Impact analysis
export {
  analyzeImpact,
  type ImpactAnalysisResult,
  type ImpactAnalysisOptions,
  type ImpactSummary,
  type AffectedFile,
  type AffectedSymbol,
  type MatchedTermSummary,
} from "./analysis/index.js";
