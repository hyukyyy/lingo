import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AdapterRegistry,
  AdapterRegistryError,
  type AdapterFactory,
  type AdapterFactoryRegistration,
  type AdapterInfo,
} from "../../src/adapters/registry.js";
import type {
  PMAdapter,
  ConnectionStatus,
  ExtractionResult,
} from "../../src/adapters/types.js";

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Creates a minimal mock adapter for testing the registry.
 */
function createMockAdapter(name: string, displayName?: string): PMAdapter {
  return {
    name,
    displayName: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
    testConnection: vi.fn(async (): Promise<ConnectionStatus> => ({
      connected: true,
      message: `Connected to ${name}`,
    })),
    listProjects: vi.fn(async () => ({ items: [], hasMore: false })),
    getProject: vi.fn(async () => undefined),
    listItems: vi.fn(async () => ({ items: [], hasMore: false })),
    getItem: vi.fn(async () => undefined),
    extractItems: vi.fn(async () => []),
    normalizeToTerms: vi.fn(() => []),
    extract: vi.fn(async (): Promise<ExtractionResult> => ({
      adapterName: name,
      extractedAt: new Date().toISOString(),
      terms: [],
      stats: {
        itemsFetched: 0,
        termsProduced: 0,
        itemsSkipped: 0,
        durationMs: 0,
        itemsByType: {},
      },
      warnings: [],
    })),
    extractTerminology: vi.fn(async () => []),
  };
}

/**
 * Creates a mock adapter factory.
 */
function createMockFactory(name: string, displayName?: string): AdapterFactory {
  return (config: Record<string, unknown>) => {
    const adapter = createMockAdapter(name, displayName);
    // Store config in metadata for test verification
    (adapter as Record<string, unknown>).__config = config;
    return adapter;
  };
}

/**
 * Creates a full factory registration.
 */
function createMockRegistration(
  name: string,
  displayName?: string,
  description?: string
): AdapterFactoryRegistration {
  return {
    name,
    displayName: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
    description,
    factory: createMockFactory(name, displayName),
  };
}

// ─── Tests: Instance Registry (existing behavior) ──────────────────

describe("AdapterRegistry — Instance Management", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.registeredAdapters).toEqual([]);
  });

  it("registers an adapter", () => {
    const adapter = createMockAdapter("notion");

    registry.register(adapter);

    expect(registry.has("notion")).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.registeredAdapters).toEqual(["notion"]);
  });

  it("retrieves a registered adapter by name", () => {
    const adapter = createMockAdapter("linear");

    registry.register(adapter);

    const retrieved = registry.get("linear");
    expect(retrieved).toBe(adapter);
    expect(retrieved?.name).toBe("linear");
  });

  it("returns undefined for unregistered adapter", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() returns false for unregistered adapter", () => {
    expect(registry.has("jira")).toBe(false);
  });

  it("registers multiple adapters", () => {
    registry.register(createMockAdapter("notion"));
    registry.register(createMockAdapter("linear"));
    registry.register(createMockAdapter("jira"));

    expect(registry.size).toBe(3);
    expect(registry.registeredAdapters).toContain("notion");
    expect(registry.registeredAdapters).toContain("linear");
    expect(registry.registeredAdapters).toContain("jira");
  });

  it("replaces existing adapter with same name", () => {
    const adapter1 = createMockAdapter("notion", "Notion v1");
    const adapter2 = createMockAdapter("notion", "Notion v2");

    registry.register(adapter1);
    registry.register(adapter2);

    expect(registry.size).toBe(1);
    expect(registry.get("notion")?.displayName).toBe("Notion v2");
  });

  it("removes a registered adapter", () => {
    registry.register(createMockAdapter("notion"));

    const removed = registry.remove("notion");

    expect(removed).toBe(true);
    expect(registry.has("notion")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("remove() returns false for non-existent adapter", () => {
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("getAll() returns all adapter instances", () => {
    const notion = createMockAdapter("notion");
    const linear = createMockAdapter("linear");

    registry.register(notion);
    registry.register(linear);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(notion);
    expect(all).toContain(linear);
  });

  it("getAll() returns empty array when no adapters registered", () => {
    expect(registry.getAll()).toEqual([]);
  });
});

// ─── Tests: Factory Registration ───────────────────────────────────

describe("AdapterRegistry — Factory Registration", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("registers a factory", () => {
    const registration = createMockRegistration("notion", "Notion");

    registry.registerFactory(registration);

    expect(registry.hasFactory("notion")).toBe(true);
    expect(registry.registeredFactories).toEqual(["notion"]);
  });

  it("registers multiple factories", () => {
    registry.registerFactory(createMockRegistration("notion", "Notion"));
    registry.registerFactory(createMockRegistration("linear", "Linear"));
    registry.registerFactory(createMockRegistration("jira", "Jira"));

    expect(registry.registeredFactories).toHaveLength(3);
    expect(registry.registeredFactories).toContain("notion");
    expect(registry.registeredFactories).toContain("linear");
    expect(registry.registeredFactories).toContain("jira");
  });

  it("throws FACTORY_ALREADY_EXISTS when registering duplicate factory", () => {
    registry.registerFactory(createMockRegistration("notion"));

    expect(() => {
      registry.registerFactory(createMockRegistration("notion"));
    }).toThrow(AdapterRegistryError);

    try {
      registry.registerFactory(createMockRegistration("notion"));
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterRegistryError);
      const regErr = err as AdapterRegistryError;
      expect(regErr.code).toBe("FACTORY_ALREADY_EXISTS");
      expect(regErr.adapterName).toBe("notion");
    }
  });

  it("replaceFactory() overwrites existing factory silently", () => {
    const factory1 = createMockRegistration("notion", "Notion v1");
    const factory2 = createMockRegistration("notion", "Notion v2");

    registry.registerFactory(factory1);
    registry.replaceFactory(factory2);

    expect(registry.hasFactory("notion")).toBe(true);
    // Verify the new factory is in place by creating an adapter
    const adapter = registry.createAdapter("notion", {});
    expect(adapter.displayName).toBe("Notion v2");
  });

  it("replaceFactory() works when no prior factory exists", () => {
    registry.replaceFactory(createMockRegistration("linear"));

    expect(registry.hasFactory("linear")).toBe(true);
  });

  it("hasFactory() returns false for unregistered factory", () => {
    expect(registry.hasFactory("nonexistent")).toBe(false);
  });

  it("removeFactory() removes a registered factory", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const removed = registry.removeFactory("notion");

    expect(removed).toBe(true);
    expect(registry.hasFactory("notion")).toBe(false);
  });

  it("removeFactory() returns false for non-existent factory", () => {
    expect(registry.removeFactory("nonexistent")).toBe(false);
  });

  it("removing a factory does not remove cached instances", () => {
    registry.registerFactory(createMockRegistration("notion"));
    registry.getOrCreate("notion", {});

    registry.removeFactory("notion");

    expect(registry.hasFactory("notion")).toBe(false);
    expect(registry.has("notion")).toBe(true); // Instance still cached
  });
});

// ─── Tests: Factory-Based Instantiation ────────────────────────────

describe("AdapterRegistry — Factory-Based Instantiation", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("createAdapter() creates an adapter from a registered factory", () => {
    registry.registerFactory(createMockRegistration("notion", "Notion"));

    const adapter = registry.createAdapter("notion", { apiKey: "test-key" });

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("notion");
    expect(adapter.displayName).toBe("Notion");
  });

  it("createAdapter() passes config to the factory", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const config = { apiKey: "secret_abc", databaseIds: ["db-1"] };
    const adapter = registry.createAdapter("notion", config);

    expect((adapter as Record<string, unknown>).__config).toEqual(config);
  });

  it("createAdapter() creates fresh instances each time", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const adapter1 = registry.createAdapter("notion", {});
    const adapter2 = registry.createAdapter("notion", {});

    expect(adapter1).not.toBe(adapter2);
  });

  it("createAdapter() does NOT cache the instance", () => {
    registry.registerFactory(createMockRegistration("notion"));

    registry.createAdapter("notion", {});

    expect(registry.has("notion")).toBe(false);
  });

  it("createAdapter() throws FACTORY_NOT_FOUND for unknown adapter", () => {
    expect(() => {
      registry.createAdapter("unknown", {});
    }).toThrow(AdapterRegistryError);

    try {
      registry.createAdapter("unknown", {});
    } catch (err) {
      const regErr = err as AdapterRegistryError;
      expect(regErr.code).toBe("FACTORY_NOT_FOUND");
      expect(regErr.adapterName).toBe("unknown");
      expect(regErr.message).toContain("unknown");
    }
  });

  it("createAdapter() error message lists available adapters", () => {
    registry.registerFactory(createMockRegistration("notion"));
    registry.registerFactory(createMockRegistration("linear"));

    try {
      registry.createAdapter("jira", {});
    } catch (err) {
      const regErr = err as AdapterRegistryError;
      expect(regErr.message).toContain("notion");
      expect(regErr.message).toContain("linear");
    }
  });

  it("createAdapter() error message handles no available adapters", () => {
    try {
      registry.createAdapter("anything", {});
    } catch (err) {
      const regErr = err as AdapterRegistryError;
      expect(regErr.message).toContain("No adapter factories are registered");
    }
  });

  it("createAdapter() wraps factory errors as CREATION_FAILED", () => {
    const failingFactory: AdapterFactoryRegistration = {
      name: "broken",
      displayName: "Broken",
      factory: () => {
        throw new Error("Invalid API key format");
      },
    };
    registry.registerFactory(failingFactory);

    expect(() => {
      registry.createAdapter("broken", {});
    }).toThrow(AdapterRegistryError);

    try {
      registry.createAdapter("broken", {});
    } catch (err) {
      const regErr = err as AdapterRegistryError;
      expect(regErr.code).toBe("CREATION_FAILED");
      expect(regErr.adapterName).toBe("broken");
      expect(regErr.message).toContain("Invalid API key format");
      expect(regErr.cause).toBeInstanceOf(Error);
    }
  });
});

// ─── Tests: getOrCreate ────────────────────────────────────────────

describe("AdapterRegistry — getOrCreate", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("creates and caches an adapter when none exists", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const adapter = registry.getOrCreate("notion", { apiKey: "test" });

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("notion");
    expect(registry.has("notion")).toBe(true);
    expect(registry.get("notion")).toBe(adapter);
  });

  it("returns cached instance on subsequent calls", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const first = registry.getOrCreate("notion", { apiKey: "test" });
    const second = registry.getOrCreate("notion", { different: "config" });

    expect(first).toBe(second);
  });

  it("returns pre-registered instance without using factory", () => {
    const manualAdapter = createMockAdapter("notion", "Manual Notion");
    registry.register(manualAdapter);
    registry.registerFactory(createMockRegistration("notion", "Factory Notion"));

    const result = registry.getOrCreate("notion", {});

    expect(result).toBe(manualAdapter);
    expect(result.displayName).toBe("Manual Notion");
  });

  it("throws when no factory and no instance exists", () => {
    expect(() => {
      registry.getOrCreate("nonexistent", {});
    }).toThrow(AdapterRegistryError);
  });

  it("remove + getOrCreate recreates from factory", () => {
    registry.registerFactory(createMockRegistration("notion"));

    const first = registry.getOrCreate("notion", {});
    registry.remove("notion");
    const second = registry.getOrCreate("notion", {});

    expect(first).not.toBe(second);
    expect(second.name).toBe("notion");
  });
});

// ─── Tests: Discovery ──────────────────────────────────────────────

describe("AdapterRegistry — Discovery", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("availableAdapters returns empty when nothing registered", () => {
    expect(registry.availableAdapters).toEqual([]);
  });

  it("availableAdapters includes factory-registered adapters", () => {
    registry.registerFactory(
      createMockRegistration("notion", "Notion", "Notion workspace adapter")
    );

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    expect(available[0]).toEqual({
      name: "notion",
      displayName: "Notion",
      description: "Notion workspace adapter",
      instantiated: false,
    });
  });

  it("availableAdapters marks instantiated adapters", () => {
    registry.registerFactory(createMockRegistration("notion", "Notion"));
    registry.getOrCreate("notion", {});

    const available = registry.availableAdapters;
    expect(available[0].instantiated).toBe(true);
  });

  it("availableAdapters includes instance-only adapters", () => {
    registry.register(createMockAdapter("custom", "Custom Adapter"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    expect(available[0]).toEqual({
      name: "custom",
      displayName: "Custom Adapter",
      description: undefined,
      instantiated: true,
    });
  });

  it("availableAdapters deduplicates factory + instance", () => {
    registry.registerFactory(
      createMockRegistration("notion", "Notion", "A description")
    );
    registry.register(createMockAdapter("notion", "Notion Instance"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    // Factory metadata takes precedence
    expect(available[0].displayName).toBe("Notion");
    expect(available[0].description).toBe("A description");
    expect(available[0].instantiated).toBe(true);
  });

  it("availableAdapters combines factories and instance-only adapters", () => {
    registry.registerFactory(createMockRegistration("notion", "Notion"));
    registry.registerFactory(createMockRegistration("linear", "Linear"));
    registry.register(createMockAdapter("custom"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(3);

    const names = available.map((a) => a.name);
    expect(names).toContain("notion");
    expect(names).toContain("linear");
    expect(names).toContain("custom");
  });

  it("isAvailable() returns true for factory-registered adapters", () => {
    registry.registerFactory(createMockRegistration("notion"));

    expect(registry.isAvailable("notion")).toBe(true);
    expect(registry.isAvailable("linear")).toBe(false);
  });

  it("isAvailable() returns true for instance-registered adapters", () => {
    registry.register(createMockAdapter("custom"));

    expect(registry.isAvailable("custom")).toBe(true);
  });

  it("isAvailable() returns true when both factory and instance exist", () => {
    registry.registerFactory(createMockRegistration("notion"));
    registry.register(createMockAdapter("notion"));

    expect(registry.isAvailable("notion")).toBe(true);
  });
});

// ─── Tests: Bulk Operations ────────────────────────────────────────

describe("AdapterRegistry — Bulk Operations", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it("clear() removes all instances and factories", () => {
    registry.registerFactory(createMockRegistration("notion"));
    registry.register(createMockAdapter("linear"));

    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.registeredFactories).toHaveLength(0);
    expect(registry.availableAdapters).toHaveLength(0);
  });

  it("clearInstances() removes instances but keeps factories", () => {
    registry.registerFactory(createMockRegistration("notion"));
    registry.getOrCreate("notion", {});

    expect(registry.has("notion")).toBe(true);

    registry.clearInstances();

    expect(registry.has("notion")).toBe(false);
    expect(registry.hasFactory("notion")).toBe(true);
  });
});

// ─── Tests: AdapterRegistryError ───────────────────────────────────

describe("AdapterRegistryError", () => {
  it("has correct name and properties", () => {
    const err = new AdapterRegistryError(
      "test message",
      "FACTORY_NOT_FOUND",
      "notion"
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterRegistryError);
    expect(err.name).toBe("AdapterRegistryError");
    expect(err.message).toBe("test message");
    expect(err.code).toBe("FACTORY_NOT_FOUND");
    expect(err.adapterName).toBe("notion");
  });

  it("optionally carries a cause", () => {
    const cause = new Error("underlying issue");
    const err = new AdapterRegistryError(
      "wrapper",
      "CREATION_FAILED",
      "broken",
      cause
    );

    expect(err.cause).toBe(cause);
  });

  it("supports all error codes", () => {
    const codes = [
      "FACTORY_NOT_FOUND",
      "FACTORY_ALREADY_EXISTS",
      "CREATION_FAILED",
      "ADAPTER_NOT_FOUND",
    ] as const;

    for (const code of codes) {
      const err = new AdapterRegistryError("test", code);
      expect(err.code).toBe(code);
    }
  });
});

// ─── Tests: Core Decoupling Guarantee ──────────────────────────────

describe("AdapterRegistry — Core Decoupling", () => {
  it("core code can create adapters without importing concrete classes", () => {
    // Simulate what core code does:
    // 1. Someone registers factories at startup (knows about concrete classes)
    // 2. Core code uses only the registry to get adapters

    const registry = new AdapterRegistry();

    // "Startup" code registers factory (this is the ONLY place that
    // knows about concrete adapter construction)
    registry.registerFactory({
      name: "notion",
      displayName: "Notion",
      factory: (config) => createMockAdapter("notion"),
    });

    // "Core" code creates adapter purely by name + config
    // (zero imports of NotionAdapter or any concrete class)
    const adapter = registry.getOrCreate("notion", {
      apiToken: "secret_xyz",
      databaseIds: [],
    });

    expect(adapter.name).toBe("notion");
    expect(adapter.displayName).toBe("Notion");
  });

  it("factory pattern allows swapping adapter implementations", () => {
    const registry = new AdapterRegistry();

    // Register a "real" adapter factory
    registry.registerFactory({
      name: "notion",
      displayName: "Notion",
      factory: () => createMockAdapter("notion", "Real Notion"),
    });

    // Later, replace with a test double
    registry.replaceFactory({
      name: "notion",
      displayName: "Notion",
      factory: () => createMockAdapter("notion", "Test Notion"),
    });

    const adapter = registry.createAdapter("notion", {});
    expect(adapter.displayName).toBe("Test Notion");
  });

  it("adapter instances are fully interchangeable via the PMAdapter interface", async () => {
    const registry = new AdapterRegistry();

    // Register two different adapter types
    registry.registerFactory({
      name: "notion",
      displayName: "Notion",
      factory: () => createMockAdapter("notion"),
    });
    registry.registerFactory({
      name: "linear",
      displayName: "Linear",
      factory: () => createMockAdapter("linear"),
    });

    // Core code can work with any adapter uniformly
    for (const info of registry.availableAdapters) {
      const adapter = registry.getOrCreate(info.name, {});

      // All adapters satisfy the same interface
      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);

      const result = await adapter.extract();
      expect(result.adapterName).toBe(info.name);
    }
  });
});
