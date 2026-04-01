/**
 * Built-in SCM Adapter Discovery
 *
 * Registers all built-in SCM tool adapter factories with a given registry.
 * This mirrors the PM adapter pattern in `../builtin-adapters.ts`.
 *
 * Core application code should call `registerBuiltinSCMAdapters(registry)`
 * at startup, then use the registry exclusively for SCM adapter access.
 * This ensures that:
 *
 * 1. No core module imports a concrete SCM adapter class
 * 2. Adding a new SCM adapter requires only adding an import + push here
 * 3. The registry is the single source of truth for available SCM adapters
 *
 * SCM adapter modules must export an `SCMAdapterFactoryRegistration` object
 * following the pattern in `factory.ts`.
 */

import type { SCMAdapterRegistry, SCMAdapterFactoryRegistration } from "./registry.js";
import { githubSCMFactoryRegistration } from "./factory.js";

/**
 * All built-in SCM adapter factory registrations.
 *
 * To add a new SCM adapter:
 * 1. Create the adapter class implementing SCMAdapter (e.g., `gitlab-scm-adapter.ts`)
 * 2. Export a factory function and an `SCMAdapterFactoryRegistration` in `factory.ts` or a separate factory file
 * 3. Import the registration here
 * 4. Add it to this array
 *
 * That's it — the adapter becomes available via the SCM registry.
 */
export const BUILTIN_SCM_ADAPTER_FACTORIES: readonly SCMAdapterFactoryRegistration[] = [
  githubSCMFactoryRegistration,
  // Future: gitlabSCMFactoryRegistration,
  // Future: bitbucketSCMFactoryRegistration,
];

/**
 * Register all built-in SCM adapter factories with the given registry.
 *
 * Uses `replaceFactory()` so this can be called multiple times safely
 * (e.g., in tests). Existing factory registrations with the same name
 * are silently overwritten.
 *
 * @param registry - The SCM adapter registry to populate
 * @returns The number of factories registered
 */
export function registerBuiltinSCMAdapters(
  registry: Pick<SCMAdapterRegistry, "replaceFactory">,
): number {
  for (const registration of BUILTIN_SCM_ADAPTER_FACTORIES) {
    registry.replaceFactory(registration);
  }
  return BUILTIN_SCM_ADAPTER_FACTORIES.length;
}

/**
 * Get the names of all built-in SCM adapters.
 * Useful for documentation and error messages.
 */
export function getBuiltinSCMAdapterNames(): string[] {
  return BUILTIN_SCM_ADAPTER_FACTORIES.map((r) => r.name);
}
