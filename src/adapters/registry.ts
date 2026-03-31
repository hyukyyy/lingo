/**
 * Adapter Registry — Factory-based PM tool adapter management.
 *
 * The registry serves two roles:
 *
 * 1. **Factory registry** — Adapter modules register factory functions
 *    that create PMAdapter instances from config. This decouples core
 *    logic from concrete adapter classes: core code never imports
 *    NotionAdapter, LinearAdapter, etc. directly.
 *
 * 2. **Instance registry** — Once instantiated (via factory or direct
 *    registration), adapter instances are cached by name for reuse.
 *
 * Design principles:
 * - Core logic depends only on PMAdapter interface + this registry
 * - New adapters are added by registering a factory — zero core changes
 * - Factories validate their own config and throw descriptive errors
 * - Instance caching avoids redundant construction / API handshakes
 *
 * Usage:
 *   // Register a factory (typically done at startup via registerBuiltinAdapters)
 *   registry.registerFactory({
 *     name: "notion",
 *     displayName: "Notion",
 *     description: "Notion workspace adapter",
 *     factory: (config) => new NotionAdapter(parseNotionConfig(config)),
 *   });
 *
 *   // Create an adapter from config (core code — no concrete imports)
 *   const adapter = registry.createAdapter("notion", { apiToken: "...", databaseIds: [] });
 *
 *   // Or get a cached instance, creating it if necessary
 *   const adapter = registry.getOrCreate("notion", { apiToken: "...", databaseIds: [] });
 */

import type { PMAdapter } from "./types.js";

// ─── Factory Types ─────────────────────────────────────────────────

/**
 * A function that creates a PMAdapter from a configuration object.
 *
 * Factory functions are responsible for:
 * 1. Validating the config (throwing descriptive errors if invalid)
 * 2. Constructing and returning a fully-initialized PMAdapter
 *
 * The config is an opaque record — each adapter defines its own schema.
 * Factories should use their adapter's config validation (e.g., Zod schemas)
 * to parse and validate the input.
 */
export type AdapterFactory = (config: Record<string, unknown>) => PMAdapter;

/**
 * Metadata for a registered adapter factory.
 *
 * This is what gets registered in the registry — it describes an adapter
 * type that *can* be instantiated, without importing the concrete class.
 */
export interface AdapterFactoryRegistration {
  /** Adapter identifier (e.g., "notion", "linear", "jira") */
  name: string;

  /** Human-readable display name (e.g., "Notion", "Linear", "Jira") */
  displayName: string;

  /** Brief description of this adapter */
  description?: string;

  /** Factory function to create adapter instances from config */
  factory: AdapterFactory;
}

/**
 * Public adapter info returned by discovery methods.
 * Excludes the factory function itself — callers don't need it.
 */
export interface AdapterInfo {
  /** Adapter identifier */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Brief description */
  description?: string;

  /** Whether an instance of this adapter is currently cached */
  instantiated: boolean;
}

// ─── Error Types ───────────────────────────────────────────────────

/**
 * Error thrown when adapter registry operations fail.
 */
export class AdapterRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: AdapterRegistryErrorCode,
    public readonly adapterName?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AdapterRegistryError";
  }
}

export type AdapterRegistryErrorCode =
  | "FACTORY_NOT_FOUND"     // No factory registered for this adapter name
  | "FACTORY_ALREADY_EXISTS" // A factory with this name is already registered
  | "CREATION_FAILED"       // Factory threw during adapter creation
  | "ADAPTER_NOT_FOUND";    // No instance registered for this adapter name

// ─── Registry ──────────────────────────────────────────────────────

/**
 * Registry of PM tool adapters with factory-based instantiation.
 *
 * Provides two layers:
 * - **Factories**: Register adapter constructors by name for lazy creation
 * - **Instances**: Cache and retrieve adapter instances by name
 *
 * Core code interacts with adapters exclusively through this registry,
 * ensuring zero coupling to concrete adapter classes.
 */
export class AdapterRegistry {
  /** Cached adapter instances by name */
  private instances: Map<string, PMAdapter> = new Map();

  /** Registered adapter factories by name */
  private factories: Map<string, AdapterFactoryRegistration> = new Map();

  // ── Instance Management (existing API, preserved) ────────────────

  /**
   * Register a pre-instantiated PM tool adapter.
   * If an adapter with the same name is already registered, it is replaced.
   *
   * @param adapter - The adapter instance to register
   */
  register(adapter: PMAdapter): void {
    this.instances.set(adapter.name, adapter);
  }

  /**
   * Retrieve a registered adapter instance by name.
   *
   * @param name - The adapter name (e.g., "notion", "linear")
   * @returns The adapter instance, or undefined if not found
   */
  get(name: string): PMAdapter | undefined {
    return this.instances.get(name);
  }

  /**
   * Check if an adapter instance is registered.
   *
   * @param name - The adapter name
   */
  has(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Remove a registered adapter instance.
   *
   * @param name - The adapter name to remove
   * @returns true if the adapter was found and removed
   */
  remove(name: string): boolean {
    return this.instances.delete(name);
  }

  /**
   * Get the names of all registered adapter instances.
   */
  get registeredAdapters(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * Get all registered adapter instances.
   */
  getAll(): PMAdapter[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get the number of registered adapter instances.
   */
  get size(): number {
    return this.instances.size;
  }

  // ── Factory Management (NEW) ─────────────────────────────────────

  /**
   * Register an adapter factory.
   *
   * Factories describe adapter types that can be instantiated on demand.
   * Multiple adapters can register factories, and instances are created
   * lazily when `createAdapter()` or `getOrCreate()` is called.
   *
   * @param registration - Factory metadata + creation function
   * @throws AdapterRegistryError with code FACTORY_ALREADY_EXISTS if
   *         a factory with the same name is already registered (use
   *         `replaceFactory()` to overwrite intentionally)
   */
  registerFactory(registration: AdapterFactoryRegistration): void {
    if (this.factories.has(registration.name)) {
      throw new AdapterRegistryError(
        `Adapter factory "${registration.name}" is already registered. ` +
          `Use replaceFactory() to overwrite.`,
        "FACTORY_ALREADY_EXISTS",
        registration.name
      );
    }
    this.factories.set(registration.name, registration);
  }

  /**
   * Register or replace an adapter factory.
   *
   * Unlike `registerFactory()`, this will silently overwrite any
   * existing factory with the same name. Useful for testing or
   * when intentionally replacing a built-in adapter.
   *
   * @param registration - Factory metadata + creation function
   */
  replaceFactory(registration: AdapterFactoryRegistration): void {
    this.factories.set(registration.name, registration);
  }

  /**
   * Check if a factory is registered for the given adapter name.
   *
   * @param name - The adapter name
   */
  hasFactory(name: string): boolean {
    return this.factories.has(name);
  }

  /**
   * Remove a registered adapter factory.
   *
   * @param name - The adapter name whose factory should be removed
   * @returns true if the factory was found and removed
   */
  removeFactory(name: string): boolean {
    return this.factories.delete(name);
  }

  /**
   * Get the names of all registered adapter factories.
   */
  get registeredFactories(): string[] {
    return Array.from(this.factories.keys());
  }

  // ── Factory-Based Instantiation (NEW) ────────────────────────────

  /**
   * Create a new adapter instance using a registered factory.
   *
   * The adapter is created fresh each time — it is NOT automatically cached.
   * Use `getOrCreate()` if you want caching behavior.
   *
   * @param name - The adapter name (must have a registered factory)
   * @param config - Configuration object passed to the factory function
   * @returns A new PMAdapter instance
   * @throws AdapterRegistryError with code FACTORY_NOT_FOUND if no factory
   *         is registered for the given name
   * @throws AdapterRegistryError with code CREATION_FAILED if the factory
   *         throws during adapter creation
   */
  createAdapter(name: string, config: Record<string, unknown>): PMAdapter {
    const registration = this.factories.get(name);
    if (!registration) {
      const available = this.registeredFactories;
      const hint =
        available.length > 0
          ? ` Available adapters: ${available.join(", ")}`
          : " No adapter factories are registered.";
      throw new AdapterRegistryError(
        `No factory registered for adapter "${name}".${hint}`,
        "FACTORY_NOT_FOUND",
        name
      );
    }

    try {
      return registration.factory(config);
    } catch (err) {
      throw new AdapterRegistryError(
        `Failed to create adapter "${name}": ${(err as Error).message}`,
        "CREATION_FAILED",
        name,
        err
      );
    }
  }

  /**
   * Get an existing adapter instance, or create and cache one using
   * the registered factory.
   *
   * If an instance with the given name already exists, it is returned
   * directly (config is ignored). To force re-creation, call `remove()`
   * first.
   *
   * @param name - The adapter name
   * @param config - Configuration object (used only if creating a new instance)
   * @returns The adapter instance (cached or newly created)
   * @throws AdapterRegistryError if no factory is registered and no instance exists
   */
  getOrCreate(name: string, config: Record<string, unknown>): PMAdapter {
    const existing = this.instances.get(name);
    if (existing) {
      return existing;
    }

    const adapter = this.createAdapter(name, config);
    this.instances.set(adapter.name, adapter);
    return adapter;
  }

  // ── Discovery (NEW) ──────────────────────────────────────────────

  /**
   * Get information about all adapters known to the registry.
   *
   * Returns both factory-registered and instance-registered adapters,
   * deduplicated by name. Factory-registered adapters include metadata
   * like display name and description.
   *
   * @returns Array of AdapterInfo objects
   */
  get availableAdapters(): AdapterInfo[] {
    const result = new Map<string, AdapterInfo>();

    // Start with factory registrations (richer metadata)
    for (const [name, reg] of this.factories) {
      result.set(name, {
        name: reg.name,
        displayName: reg.displayName,
        description: reg.description,
        instantiated: this.instances.has(name),
      });
    }

    // Add any instance-only adapters (registered without a factory)
    for (const [name, adapter] of this.instances) {
      if (!result.has(name)) {
        result.set(name, {
          name: adapter.name,
          displayName: adapter.displayName,
          instantiated: true,
        });
      }
    }

    return Array.from(result.values());
  }

  /**
   * Check if an adapter is available — either as a factory or an instance.
   *
   * @param name - The adapter name
   */
  isAvailable(name: string): boolean {
    return this.instances.has(name) || this.factories.has(name);
  }

  // ── Bulk Operations ──────────────────────────────────────────────

  /**
   * Clear all registered instances and factories.
   * Useful for testing.
   */
  clear(): void {
    this.instances.clear();
    this.factories.clear();
  }

  /**
   * Clear only cached instances, keeping factories intact.
   * Useful for resetting state without losing adapter registrations.
   */
  clearInstances(): void {
    this.instances.clear();
  }
}
