/**
 * JSON Adapter Factory
 *
 * Provides factory-based creation of the JSON adapter without
 * requiring callers to import the concrete JsonAdapter class.
 *
 * Mirrors the pattern established by `notion/factory.ts`:
 * - Core code never imports JsonAdapter directly
 * - Factory validates config and provides clear error messages
 * - Registration object plugs into the AdapterRegistry
 *
 * Config validation is lightweight (compared to Notion's Zod schema)
 * since JSON adapter config is simpler and more permissive.
 */

import type { PMAdapter } from "../types.js";
import { PMAdapterError } from "../types.js";
import type { AdapterFactoryRegistration } from "../registry.js";
import { JsonAdapter, type JsonAdapterConfig, type JsonPMData } from "./json-adapter.js";

/**
 * Create a JSON PM adapter from a raw configuration object.
 *
 * Accepts a flexible config object and validates it minimally:
 * - `data` (optional): Inline JSON PM data object
 * - `filePath` (optional): Path to a JSON file
 * - `defaultItemType` (optional): Default type for items
 * - `organizationName` (optional): Organization name for source attribution
 *
 * At least one of `data` or `filePath` should be provided for the adapter
 * to be useful, but the factory doesn't enforce this — an empty adapter
 * is valid for testing or lazy configuration.
 *
 * @param config - Raw configuration object
 * @returns A configured JsonAdapter instance
 * @throws PMAdapterError if the config is structurally invalid
 */
export function createJsonAdapter(config: Record<string, unknown>): PMAdapter {
  const adapterConfig: JsonAdapterConfig = {};

  // Validate and extract 'data' field
  if (config.data !== undefined) {
    if (typeof config.data !== "object" || config.data === null) {
      throw new PMAdapterError(
        `JSON adapter config "data" must be an object, got ${typeof config.data}`,
        "INVALID_CONFIG",
        "json"
      );
    }
    adapterConfig.data = config.data as JsonPMData;
  }

  // Validate and extract 'filePath' field
  if (config.filePath !== undefined) {
    if (typeof config.filePath !== "string") {
      throw new PMAdapterError(
        `JSON adapter config "filePath" must be a string, got ${typeof config.filePath}`,
        "INVALID_CONFIG",
        "json"
      );
    }
    adapterConfig.filePath = config.filePath;
  }

  // Validate and extract 'defaultItemType' field
  if (config.defaultItemType !== undefined) {
    if (typeof config.defaultItemType !== "string") {
      throw new PMAdapterError(
        `JSON adapter config "defaultItemType" must be a string, got ${typeof config.defaultItemType}`,
        "INVALID_CONFIG",
        "json"
      );
    }
    adapterConfig.defaultItemType = config.defaultItemType as JsonAdapterConfig["defaultItemType"];
  }

  // Validate and extract 'organizationName' field
  if (config.organizationName !== undefined) {
    if (typeof config.organizationName !== "string") {
      throw new PMAdapterError(
        `JSON adapter config "organizationName" must be a string, got ${typeof config.organizationName}`,
        "INVALID_CONFIG",
        "json"
      );
    }
    adapterConfig.organizationName = config.organizationName;
  }

  return new JsonAdapter(adapterConfig);
}

/**
 * Factory registration metadata for the JSON adapter.
 *
 * Use this with `AdapterRegistry.registerFactory()` to make the JSON
 * adapter available for factory-based creation.
 *
 * @example
 *   import { jsonFactoryRegistration } from "./json/factory.js";
 *   registry.registerFactory(jsonFactoryRegistration);
 */
export const jsonFactoryRegistration: AdapterFactoryRegistration = {
  name: "json",
  displayName: "JSON Import",
  description:
    "Imports PM data from structured JSON files or inline data. " +
    "Ideal for cold-start bootstrap, testing, and importing from " +
    "tools that export to JSON.",
  factory: createJsonAdapter,
};
