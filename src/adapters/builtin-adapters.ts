/**
 * Built-in Adapter Discovery
 *
 * Registers all built-in PM tool adapter factories with a given registry.
 * This is the single point where concrete adapter modules are imported.
 *
 * Core application code should call `registerBuiltinAdapters(registry)`
 * at startup, then use the registry exclusively for adapter access.
 * This ensures that:
 *
 * 1. No core module imports a concrete adapter class
 * 2. Adding a new adapter requires only adding an import + push here
 * 3. The registry is the single source of truth for available adapters
 *
 * Adapter modules must export an `AdapterFactoryRegistration` object
 * following the pattern in `notion/factory.ts`.
 */

import type { AdapterRegistry, AdapterFactoryRegistration } from "./registry.js";
import { notionFactoryRegistration } from "./notion/factory.js";
import { jsonFactoryRegistration } from "./json/factory.js";

/**
 * All built-in adapter factory registrations.
 *
 * To add a new adapter:
 * 1. Create `src/adapters/<name>/factory.ts` exporting an AdapterFactoryRegistration
 * 2. Import it here
 * 3. Add it to this array
 *
 * That's it — the adapter becomes available via the registry.
 */
export const BUILTIN_ADAPTER_FACTORIES: readonly AdapterFactoryRegistration[] = [
  notionFactoryRegistration,
  jsonFactoryRegistration,
  // Future: linearFactoryRegistration,
  // Future: jiraFactoryRegistration,
];

/**
 * Register all built-in adapter factories with the given registry.
 *
 * Uses `replaceFactory()` so this can be called multiple times safely
 * (e.g., in tests). Existing factory registrations with the same name
 * are silently overwritten.
 *
 * @param registry - The adapter registry to populate
 * @returns The number of factories registered
 */
export function registerBuiltinAdapters(registry: AdapterRegistry): number {
  for (const registration of BUILTIN_ADAPTER_FACTORIES) {
    registry.replaceFactory(registration);
  }
  return BUILTIN_ADAPTER_FACTORIES.length;
}

/**
 * Get the names of all built-in adapters.
 * Useful for documentation and error messages.
 */
export function getBuiltinAdapterNames(): string[] {
  return BUILTIN_ADAPTER_FACTORIES.map((r) => r.name);
}
