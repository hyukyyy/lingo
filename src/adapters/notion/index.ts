export {
  NotionAdapter,
  type NotionAdapterConfig,
  type PropertyMappings,
} from "./notion-adapter.js";

// Factory for registry-based creation
export {
  createNotionAdapter,
  notionFactoryRegistration,
} from "./factory.js";

export {
  HttpNotionClient,
  NotionApiError,
  sleep,
  type NotionClient,
  type NotionClientConfig,
  type NotionPage,
  type NotionDatabase,
  type NotionDatabaseProperty,
  type NotionPropertyValue,
  type NotionRichText,
  type NotionPaginatedResponse,
  type NotionSearchResult,
  type NotionSearchOptions,
  type NotionQueryOptions,
  type NotionQueryFilter,
  type NotionErrorCode,
  type NotionErrorBody,
  type RetryConfig,
} from "./notion-client.js";

// Planning item extractor (internal PlanningItem format)
export {
  NotionItemExtractor,
  normalizeStatusCategory,
  mapToItemKind,
  type PlanningItem,
  type PlanningItemKind,
  type NotionExtractorConfig,
  type NotionExtractionFilter,
} from "./notion-item-extractor.js";

// Configuration validation
export {
  NotionConfigSchema,
  NotionApiTokenSchema,
  NotionDatabaseIdSchema,
  PropertyMappingsSchema,
  NotionConfigError,
  parseNotionConfig,
  validateNotionConfig,
  validateApiToken,
  validateDatabaseId,
  normalizeDatabaseId,
  type ValidatedNotionConfig,
  type ConfigValidationError,
  type ConfigValidationResult,
  NOTION_TOKEN_PREFIXES,
  NOTION_ID_PATTERN,
  DEFAULT_NOTION_BASE_URL,
  DEFAULT_NOTION_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from "./notion-config.js";
