/**
 * SCM Adapter Registry — Factory-based SCM tool adapter management.
 *
 * Mirrors the PM AdapterRegistry API exactly, but operates on SCMAdapter
 * instances instead of PMAdapter instances. This symmetry ensures that
 * core code interacts with both PM and SCM registries using the same
 * mental model and API patterns.
 *
 * The registry serves two roles:
 *
 * 1. **Factory registry** — Adapter modules register factory functions
 *    that create SCMAdapter instances from config. This decouples core
 *    logic from concrete adapter classes: core code never imports
 *    GitHubSCMAdapter, GitLabSCMAdapter, etc. directly.
 *
 * 2. **Instance registry** — Once instantiated (via factory or direct
 *    registration), adapter instances are cached by name for reuse.
 *
 * Design principles:
 * - Core logic depends only on SCMAdapter interface + this registry
 * - New adapters are added by registering a factory — zero core changes
 * - Factories validate their own config and throw descriptive errors
 * - Instance caching avoids redundant construction / API handshakes
 *
 * Usage:
 *   // Register a factory (typically done at startup via registerBuiltinSCMAdapters)
 *   registry.registerFactory({
 *     name: "github",
 *     displayName: "GitHub",
 *     description: "GitHub SCM adapter",
 *     factory: (config) => new GitHubSCMAdapter(parseGitHubConfig(config)),
 *   });
 *
 *   // Create an adapter from config (core code — no concrete imports)
 *   const adapter = registry.createAdapter("github", { token: "..." });
 *
 *   // Or get a cached instance, creating it if necessary
 *   const adapter = registry.getOrCreate("github", { token: "..." });
 */

import type { SCMAdapter } from "./types.js";

// ─── Factory Types ─────────────────────────────────────────────────

/**
 * A function that creates an SCMAdapter from a configuration object.
 *
 * Factory functions are responsible for:
 * 1. Validating the config (throwing descriptive errors if invalid)
 * 2. Constructing and returning a fully-initialized SCMAdapter
 *
 * The config is an opaque record — each adapter defines its own schema.
 */
export type SCMAdapterFactory = (config: Record<string, unknown>) => SCMAdapter;

/**
 * Metadata for a registered SCM adapter factory.
 *
 * This is what gets registered in the registry — it describes an adapter
 * type that *can* be instantiated, without importing the concrete class.
 */
export interface SCMAdapterFactoryRegistration {
  /** Adapter identifier (e.g., "github", "gitlab", "bitbucket") */
  name: string;

  /** Human-readable display name (e.g., "GitHub", "GitLab", "Bitbucket") */
  displayName: string;

  /** Brief description of this adapter */
  description?: string;

  /** Factory function to create adapter instances from config */
  factory: SCMAdapterFactory;
}

/**
 * Public adapter info returned by discovery methods.
 * Excludes the factory function itself — callers don't need it.
 */
export interface SCMAdapterInfo {
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
 * Error thrown when SCM adapter registry operations fail.
 * Mirrors AdapterRegistryError from the PM registry.
 */
export class SCMAdapterRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: SCMAdapterRegistryErrorCode,
    public readonly adapterName?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SCMAdapterRegistryError";
  }
}

export type SCMAdapterRegistryErrorCode =
  | "FACTORY_NOT_FOUND"     // No factory registered for this adapter name
  | "FACTORY_ALREADY_EXISTS" // A factory with this name is already registered
  | "CREATION_FAILED"       // Factory threw during adapter creation
  | "ADAPTER_NOT_FOUND";    // No instance registered for this adapter name

// ─── Registry ──────────────────────────────────────────────────────

/**
 * Registry of SCM tool adapters with factory-based instantiation.
 *
 * Provides two layers:
 * - **Factories**: Register adapter constructors by name for lazy creation
 * - **Instances**: Cache and retrieve adapter instances by name
 *
 * Core code interacts with SCM adapters exclusively through this registry,
 * ensuring zero coupling to concrete adapter classes.
 *
 * This class mirrors the PM AdapterRegistry API exactly — same method
 * names, same semantics, same error handling — but operates on SCMAdapter.
 */
export class SCMAdapterRegistry {
  /** Cached adapter instances by name */
  private instances: Map<string, SCMAdapter> = new Map();

  /** Registered adapter factories by name */
  private factories: Map<string, SCMAdapterFactoryRegistration> = new Map();

  // ── Instance Management ─────────────────────────────────────────

  /**
   * Register a pre-instantiated SCM tool adapter.
   * If an adapter with the same name is already registered, it is replaced.
   *
   * @param adapter - The adapter instance to register
   */
  register(adapter: SCMAdapter): void {
    this.instances.set(adapter.name, adapter);
  }

  /**
   * Retrieve a registered adapter instance by name.
   *
   * @param name - The adapter name (e.g., "github", "gitlab")
   * @returns The adapter instance, or undefined if not found
   */
  get(name: string): SCMAdapter | undefined {
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
  getAll(): SCMAdapter[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get the number of registered adapter instances.
   */
  get size(): number {
    return this.instances.size;
  }

  // ── Factory Management ──────────────────────────────────────────

  /**
   * Register an adapter factory.
   *
   * Factories describe adapter types that can be instantiated on demand.
   * Multiple adapters can register factories, and instances are created
   * lazily when `createAdapter()` or `getOrCreate()` is called.
   *
   * @param registration - Factory metadata + creation function
   * @throws SCMAdapterRegistryError with code FACTORY_ALREADY_EXISTS if
   *         a factory with the same name is already registered (use
   *         `replaceFactory()` to overwrite intentionally)
   */
  registerFactory(registration: SCMAdapterFactoryRegistration): void {
    if (this.factories.has(registration.name)) {
      throw new SCMAdapterRegistryError(
        `SCM adapter factory "${registration.name}" is already registered. ` +
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
  replaceFactory(registration: SCMAdapterFactoryRegistration): void {
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

  // ── Factory-Based Instantiation ─────────────────────────────────

  /**
   * Create a new adapter instance using a registered factory.
   *
   * The adapter is created fresh each time — it is NOT automatically cached.
   * Use `getOrCreate()` if you want caching behavior.
   *
   * @param name - The adapter name (must have a registered factory)
   * @param config - Configuration object passed to the factory function
   * @returns A new SCMAdapter instance
   * @throws SCMAdapterRegistryError with code FACTORY_NOT_FOUND if no factory
   *         is registered for the given name
   * @throws SCMAdapterRegistryError with code CREATION_FAILED if the factory
   *         throws during adapter creation
   */
  createAdapter(name: string, config: Record<string, unknown>): SCMAdapter {
    const registration = this.factories.get(name);
    if (!registration) {
      const available = this.registeredFactories;
      const hint =
        available.length > 0
          ? ` Available adapters: ${available.join(", ")}`
          : " No SCM adapter factories are registered.";
      throw new SCMAdapterRegistryError(
        `No factory registered for SCM adapter "${name}".${hint}`,
        "FACTORY_NOT_FOUND",
        name
      );
    }

    try {
      return registration.factory(config);
    } catch (err) {
      throw new SCMAdapterRegistryError(
        `Failed to create SCM adapter "${name}": ${(err as Error).message}`,
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
   * @throws SCMAdapterRegistryError if no factory is registered and no instance exists
   */
  getOrCreate(name: string, config: Record<string, unknown>): SCMAdapter {
    const existing = this.instances.get(name);
    if (existing) {
      return existing;
    }

    const adapter = this.createAdapter(name, config);
    this.instances.set(adapter.name, adapter);
    return adapter;
  }

  // ── Discovery ───────────────────────────────────────────────────

  /**
   * Get information about all adapters known to the registry.
   *
   * Returns both factory-registered and instance-registered adapters,
   * deduplicated by name. Factory-registered adapters include metadata
   * like display name and description.
   *
   * @returns Array of SCMAdapterInfo objects
   */
  get availableAdapters(): SCMAdapterInfo[] {
    const result = new Map<string, SCMAdapterInfo>();

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

  // ── Bulk Operations ─────────────────────────────────────────────

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
