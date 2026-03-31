// Adapter interface & shared types
export type {
  ExternalId,
  PMAdapter,
  PMProject,
  PMItem,
  PMItemType,
  PMItemKind,
  PMItemStatus,
  PMStatusCategory,
  PMFieldValue,
  PMItemFilterOptions,
  PMTermCandidate,
  PMTermExtractionOptions,
  PMAdapterConfig,
  PMAdapterErrorCode,
  PaginationOptions,
  PaginatedResult,
  NormalizedTerm,
  ExtractionOptions,
  ExtractionResult,
  ExtractionStats,
  ConnectionStatus,
} from "./types.js";

export { PMAdapterError } from "./types.js";

// Adapter registry & factory types
export {
  AdapterRegistry,
  AdapterRegistryError,
  type AdapterFactory,
  type AdapterFactoryRegistration,
  type AdapterInfo,
  type AdapterRegistryErrorCode,
} from "./registry.js";

// Built-in adapter discovery
export {
  registerBuiltinAdapters,
  getBuiltinAdapterNames,
  BUILTIN_ADAPTER_FACTORIES,
} from "./builtin-adapters.js";

// Notion adapter
export {
  NotionAdapter,
  type NotionAdapterConfig,
  type PropertyMappings,
} from "./notion/index.js";

// Notion adapter factory
export {
  createNotionAdapter,
  notionFactoryRegistration,
} from "./notion/index.js";

export {
  HttpNotionClient,
  NotionApiError,
  sleep,
  type NotionClient,
  type NotionClientConfig,
  type NotionErrorCode,
  type NotionErrorBody,
  type RetryConfig,
} from "./notion/index.js";

// Notion configuration validation
export {
  NotionConfigSchema,
  NotionConfigError,
  parseNotionConfig,
  validateNotionConfig,
  validateApiToken,
  validateDatabaseId,
  normalizeDatabaseId,
  type ValidatedNotionConfig,
  type ConfigValidationError,
  type ConfigValidationResult,
} from "./notion/index.js";

// JSON adapter
export {
  JsonAdapter,
  resetItemCounter,
  type JsonAdapterConfig,
  type JsonPMData,
  type JsonProject,
  type JsonItem,
} from "./json/index.js";

// JSON adapter factory
export {
  createJsonAdapter,
  jsonFactoryRegistration,
} from "./json/index.js";
