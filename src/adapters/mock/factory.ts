/**
 * Mock Adapter Factory
 *
 * Provides factory-based creation of the Mock PM adapter without
 * requiring callers to import the concrete MockPMAdapter class.
 *
 * This follows the same structural pattern as `notion/factory.ts`:
 * - Export a `createMockAdapter()` function for direct usage
 * - Export a `mockFactoryRegistration` for registry-based usage
 *
 * This module demonstrates that a new adapter can be added to the
 * Lingo ecosystem by simply:
 * 1. Implementing the PMAdapter interface
 * 2. Creating a factory registration
 * 3. Calling `registry.registerFactory(mockFactoryRegistration)`
 *
 * No core logic files need to be modified.
 */

import type { PMAdapter } from "../types.js";
import type { AdapterFactoryRegistration } from "../registry.js";
import { MockPMAdapter, type MockPMAdapterConfig } from "./mock-adapter.js";
import type { PMProject, PMItem } from "../types.js";

/**
 * Create a Mock PM adapter from a raw configuration object.
 *
 * Accepts an opaque config record and extracts the fields relevant
 * to MockPMAdapterConfig. Unknown fields are silently ignored.
 *
 * @param config - Raw configuration object
 * @returns A configured MockPMAdapter instance
 */
export function createMockAdapter(config: Record<string, unknown>): PMAdapter {
  const adapterConfig: MockPMAdapterConfig = {
    projects: (config.projects as PMProject[] | undefined) ?? [],
    items: (config.items as PMItem[] | undefined) ?? [],
    simulateConnectionFailure:
      (config.simulateConnectionFailure as boolean | undefined) ?? false,
  };

  return new MockPMAdapter(adapterConfig);
}

/**
 * Factory registration metadata for the Mock PM adapter.
 *
 * Use this with `AdapterRegistry.registerFactory()` to make the Mock
 * adapter available for factory-based creation.
 *
 * @example
 *   import { mockFactoryRegistration } from "./mock/factory.js";
 *   registry.registerFactory(mockFactoryRegistration);
 */
export const mockFactoryRegistration: AdapterFactoryRegistration = {
  name: "mock",
  displayName: "Mock PM Tool",
  description:
    "In-memory mock PM adapter for testing and extensibility demonstration. " +
    "Proves that new adapters can be added without modifying core logic.",
  factory: createMockAdapter,
};
