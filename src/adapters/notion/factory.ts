/**
 * Notion Adapter Factory
 *
 * Provides factory-based creation of the Notion adapter without
 * requiring callers to import the concrete NotionAdapter class.
 *
 * This module is the bridge between the abstract adapter registry
 * and the concrete Notion implementation. Core code imports only
 * this factory (or more typically, the builtin-adapters module),
 * never the NotionAdapter class itself.
 *
 * The factory validates config via the Notion Zod schema before
 * constructing the adapter, providing clear error messages for
 * misconfiguration.
 */

import type { PMAdapter } from "../types.js";
import type { AdapterFactoryRegistration } from "../registry.js";
import { NotionAdapter, type NotionAdapterConfig } from "./notion-adapter.js";
import { parseNotionConfig } from "./notion-config.js";
import type { PMItemType } from "../types.js";

/**
 * Create a Notion PM adapter from a raw configuration object.
 *
 * The config is validated via the NotionConfigSchema (Zod). If validation
 * fails, a NotionConfigError is thrown with structured details.
 *
 * @param config - Raw configuration object (must include apiToken, databaseIds)
 * @returns A configured NotionAdapter instance
 * @throws NotionConfigError if the config is invalid
 */
export function createNotionAdapter(config: Record<string, unknown>): PMAdapter {
  const validated = parseNotionConfig(config);

  // Bridge from Zod's validated output to the NotionAdapterConfig type.
  // The Zod schema validates that defaultItemType is a valid PMItemType,
  // but its TypeScript type is `string` due to the z.enum([string, ...]) definition.
  const adapterConfig: NotionAdapterConfig = {
    apiToken: validated.apiToken,
    databaseIds: validated.databaseIds,
    propertyMappings: validated.propertyMappings,
    defaultItemType: validated.defaultItemType as PMItemType | undefined,
    extractSchemaTerms: validated.extractSchemaTerms,
    baseUrl: validated.baseUrl,
    apiVersion: validated.apiVersion,
  };

  return new NotionAdapter(adapterConfig);
}

/**
 * Factory registration metadata for the Notion adapter.
 *
 * Use this with `AdapterRegistry.registerFactory()` to make the Notion
 * adapter available for factory-based creation.
 *
 * @example
 *   import { notionFactoryRegistration } from "./notion/factory.js";
 *   registry.registerFactory(notionFactoryRegistration);
 */
export const notionFactoryRegistration: AdapterFactoryRegistration = {
  name: "notion",
  displayName: "Notion",
  description:
    "Connects to Notion workspaces to extract planning terminology, " +
    "feature names, and workflow labels from databases.",
  factory: createNotionAdapter,
};
