/**
 * Tests for SCMAdapterRegistry — Factory-based SCM tool adapter management.
 *
 * Mirrors the structure of tests/adapters/registry.test.ts exactly,
 * validating that SCMAdapterRegistry implements the same API contract
 * as the PM AdapterRegistry but operates on SCMAdapter instances.
 *
 * Covers:
 * - Instance management (register, get, has, remove, getAll, size)
 * - Factory registration (registerFactory, replaceFactory, hasFactory, removeFactory)
 * - Factory-based instantiation (createAdapter, getOrCreate)
 * - Discovery (availableAdapters, isAvailable)
 * - Bulk operations (clear, clearInstances)
 * - Error handling (SCMAdapterRegistryError codes)
 * - Core decoupling guarantee
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SCMAdapterRegistry,
  SCMAdapterRegistryError,
  type SCMAdapterFactory,
  type SCMAdapterFactoryRegistration,
  type SCMAdapterInfo,
} from "../../../src/adapters/scm/registry.js";
import type {
  SCMAdapter,
  SCMConnectionStatus,
  PullRequestRef,
} from "../../../src/adapters/scm/types.js";
import type { PRInfo } from "../../../src/pr-learner/pr-learner.js";

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Creates a minimal mock SCM adapter for testing the registry.
 */
function createMockSCMAdapter(name: string, displayName?: string): SCMAdapter {
  return {
    name,
    displayName: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
    testConnection: vi.fn(async (): Promise<SCMConnectionStatus> => ({
      connected: true,
      message: `Connected to ${name}`,
    })),
    parsePullRequestUrl: vi.fn((url: string): PullRequestRef => ({
      owner: "test",
      repo: "repo",
      number: 1,
    })),
    fetchPullRequest: vi.fn(async (): Promise<PRInfo> => ({
      number: 1,
      title: "Test PR",
      body: "Test body",
      url: "https://example.com/pr/1",
      mergedAt: null,
      labels: [],
      changedFiles: [],
    })),
    fetchPullRequestByUrl: vi.fn(async (): Promise<PRInfo> => ({
      number: 1,
      title: "Test PR",
      body: "Test body",
      url: "https://example.com/pr/1",
      mergedAt: null,
      labels: [],
      changedFiles: [],
    })),
  };
}

/**
 * Creates a mock SCM adapter factory.
 */
function createMockSCMFactory(name: string, displayName?: string): SCMAdapterFactory {
  return (config: Record<string, unknown>) => {
    const adapter = createMockSCMAdapter(name, displayName);
    // Store config in metadata for test verification
    (adapter as Record<string, unknown>).__config = config;
    return adapter;
  };
}

/**
 * Creates a full factory registration.
 */
function createMockSCMRegistration(
  name: string,
  displayName?: string,
  description?: string
): SCMAdapterFactoryRegistration {
  return {
    name,
    displayName: displayName ?? name.charAt(0).toUpperCase() + name.slice(1),
    description,
    factory: createMockSCMFactory(name, displayName),
  };
}

// ─── Tests: Instance Registry ─────────────────────────────────────

describe("SCMAdapterRegistry — Instance Management", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("starts empty", () => {
    expect(registry.size).toBe(0);
    expect(registry.registeredAdapters).toEqual([]);
  });

  it("registers an adapter", () => {
    const adapter = createMockSCMAdapter("github");

    registry.register(adapter);

    expect(registry.has("github")).toBe(true);
    expect(registry.size).toBe(1);
    expect(registry.registeredAdapters).toEqual(["github"]);
  });

  it("retrieves a registered adapter by name", () => {
    const adapter = createMockSCMAdapter("gitlab");

    registry.register(adapter);

    const retrieved = registry.get("gitlab");
    expect(retrieved).toBe(adapter);
    expect(retrieved?.name).toBe("gitlab");
  });

  it("returns undefined for unregistered adapter", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() returns false for unregistered adapter", () => {
    expect(registry.has("bitbucket")).toBe(false);
  });

  it("registers multiple adapters", () => {
    registry.register(createMockSCMAdapter("github"));
    registry.register(createMockSCMAdapter("gitlab"));
    registry.register(createMockSCMAdapter("bitbucket"));

    expect(registry.size).toBe(3);
    expect(registry.registeredAdapters).toContain("github");
    expect(registry.registeredAdapters).toContain("gitlab");
    expect(registry.registeredAdapters).toContain("bitbucket");
  });

  it("replaces existing adapter with same name", () => {
    const adapter1 = createMockSCMAdapter("github", "GitHub v1");
    const adapter2 = createMockSCMAdapter("github", "GitHub v2");

    registry.register(adapter1);
    registry.register(adapter2);

    expect(registry.size).toBe(1);
    expect(registry.get("github")?.displayName).toBe("GitHub v2");
  });

  it("removes a registered adapter", () => {
    registry.register(createMockSCMAdapter("github"));

    const removed = registry.remove("github");

    expect(removed).toBe(true);
    expect(registry.has("github")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("remove() returns false for non-existent adapter", () => {
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("getAll() returns all adapter instances", () => {
    const github = createMockSCMAdapter("github");
    const gitlab = createMockSCMAdapter("gitlab");

    registry.register(github);
    registry.register(gitlab);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(github);
    expect(all).toContain(gitlab);
  });

  it("getAll() returns empty array when no adapters registered", () => {
    expect(registry.getAll()).toEqual([]);
  });
});

// ─── Tests: Factory Registration ──────────────────────────────────

describe("SCMAdapterRegistry — Factory Registration", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("registers a factory", () => {
    const registration = createMockSCMRegistration("github", "GitHub");

    registry.registerFactory(registration);

    expect(registry.hasFactory("github")).toBe(true);
    expect(registry.registeredFactories).toEqual(["github"]);
  });

  it("registers multiple factories", () => {
    registry.registerFactory(createMockSCMRegistration("github", "GitHub"));
    registry.registerFactory(createMockSCMRegistration("gitlab", "GitLab"));
    registry.registerFactory(createMockSCMRegistration("bitbucket", "Bitbucket"));

    expect(registry.registeredFactories).toHaveLength(3);
    expect(registry.registeredFactories).toContain("github");
    expect(registry.registeredFactories).toContain("gitlab");
    expect(registry.registeredFactories).toContain("bitbucket");
  });

  it("throws FACTORY_ALREADY_EXISTS when registering duplicate factory", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    expect(() => {
      registry.registerFactory(createMockSCMRegistration("github"));
    }).toThrow(SCMAdapterRegistryError);

    try {
      registry.registerFactory(createMockSCMRegistration("github"));
    } catch (err) {
      expect(err).toBeInstanceOf(SCMAdapterRegistryError);
      const regErr = err as SCMAdapterRegistryError;
      expect(regErr.code).toBe("FACTORY_ALREADY_EXISTS");
      expect(regErr.adapterName).toBe("github");
    }
  });

  it("replaceFactory() overwrites existing factory silently", () => {
    const factory1 = createMockSCMRegistration("github", "GitHub v1");
    const factory2 = createMockSCMRegistration("github", "GitHub v2");

    registry.registerFactory(factory1);
    registry.replaceFactory(factory2);

    expect(registry.hasFactory("github")).toBe(true);
    // Verify the new factory is in place by creating an adapter
    const adapter = registry.createAdapter("github", {});
    expect(adapter.displayName).toBe("GitHub v2");
  });

  it("replaceFactory() works when no prior factory exists", () => {
    registry.replaceFactory(createMockSCMRegistration("gitlab"));

    expect(registry.hasFactory("gitlab")).toBe(true);
  });

  it("hasFactory() returns false for unregistered factory", () => {
    expect(registry.hasFactory("nonexistent")).toBe(false);
  });

  it("removeFactory() removes a registered factory", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const removed = registry.removeFactory("github");

    expect(removed).toBe(true);
    expect(registry.hasFactory("github")).toBe(false);
  });

  it("removeFactory() returns false for non-existent factory", () => {
    expect(registry.removeFactory("nonexistent")).toBe(false);
  });

  it("removing a factory does not remove cached instances", () => {
    registry.registerFactory(createMockSCMRegistration("github"));
    registry.getOrCreate("github", {});

    registry.removeFactory("github");

    expect(registry.hasFactory("github")).toBe(false);
    expect(registry.has("github")).toBe(true); // Instance still cached
  });
});

// ─── Tests: Factory-Based Instantiation ───────────────────────────

describe("SCMAdapterRegistry — Factory-Based Instantiation", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("createAdapter() creates an adapter from a registered factory", () => {
    registry.registerFactory(createMockSCMRegistration("github", "GitHub"));

    const adapter = registry.createAdapter("github", { token: "test-token" });

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("github");
    expect(adapter.displayName).toBe("GitHub");
  });

  it("createAdapter() passes config to the factory", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const config = { token: "ghp_secret_abc", baseUrl: "https://api.github.com" };
    const adapter = registry.createAdapter("github", config);

    expect((adapter as Record<string, unknown>).__config).toEqual(config);
  });

  it("createAdapter() creates fresh instances each time", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const adapter1 = registry.createAdapter("github", {});
    const adapter2 = registry.createAdapter("github", {});

    expect(adapter1).not.toBe(adapter2);
  });

  it("createAdapter() does NOT cache the instance", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    registry.createAdapter("github", {});

    expect(registry.has("github")).toBe(false);
  });

  it("createAdapter() throws FACTORY_NOT_FOUND for unknown adapter", () => {
    expect(() => {
      registry.createAdapter("unknown", {});
    }).toThrow(SCMAdapterRegistryError);

    try {
      registry.createAdapter("unknown", {});
    } catch (err) {
      const regErr = err as SCMAdapterRegistryError;
      expect(regErr.code).toBe("FACTORY_NOT_FOUND");
      expect(regErr.adapterName).toBe("unknown");
      expect(regErr.message).toContain("unknown");
    }
  });

  it("createAdapter() error message lists available adapters", () => {
    registry.registerFactory(createMockSCMRegistration("github"));
    registry.registerFactory(createMockSCMRegistration("gitlab"));

    try {
      registry.createAdapter("bitbucket", {});
    } catch (err) {
      const regErr = err as SCMAdapterRegistryError;
      expect(regErr.message).toContain("github");
      expect(regErr.message).toContain("gitlab");
    }
  });

  it("createAdapter() error message handles no available adapters", () => {
    try {
      registry.createAdapter("anything", {});
    } catch (err) {
      const regErr = err as SCMAdapterRegistryError;
      expect(regErr.message).toContain("No SCM adapter factories are registered");
    }
  });

  it("createAdapter() wraps factory errors as CREATION_FAILED", () => {
    const failingFactory: SCMAdapterFactoryRegistration = {
      name: "broken",
      displayName: "Broken",
      factory: () => {
        throw new Error("Invalid token format");
      },
    };
    registry.registerFactory(failingFactory);

    expect(() => {
      registry.createAdapter("broken", {});
    }).toThrow(SCMAdapterRegistryError);

    try {
      registry.createAdapter("broken", {});
    } catch (err) {
      const regErr = err as SCMAdapterRegistryError;
      expect(regErr.code).toBe("CREATION_FAILED");
      expect(regErr.adapterName).toBe("broken");
      expect(regErr.message).toContain("Invalid token format");
      expect(regErr.cause).toBeInstanceOf(Error);
    }
  });
});

// ─── Tests: getOrCreate ───────────────────────────────────────────

describe("SCMAdapterRegistry — getOrCreate", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("creates and caches an adapter when none exists", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const adapter = registry.getOrCreate("github", { token: "test" });

    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("github");
    expect(registry.has("github")).toBe(true);
    expect(registry.get("github")).toBe(adapter);
  });

  it("returns cached instance on subsequent calls", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const first = registry.getOrCreate("github", { token: "test" });
    const second = registry.getOrCreate("github", { different: "config" });

    expect(first).toBe(second);
  });

  it("returns pre-registered instance without using factory", () => {
    const manualAdapter = createMockSCMAdapter("github", "Manual GitHub");
    registry.register(manualAdapter);
    registry.registerFactory(createMockSCMRegistration("github", "Factory GitHub"));

    const result = registry.getOrCreate("github", {});

    expect(result).toBe(manualAdapter);
    expect(result.displayName).toBe("Manual GitHub");
  });

  it("throws when no factory and no instance exists", () => {
    expect(() => {
      registry.getOrCreate("nonexistent", {});
    }).toThrow(SCMAdapterRegistryError);
  });

  it("remove + getOrCreate recreates from factory", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    const first = registry.getOrCreate("github", {});
    registry.remove("github");
    const second = registry.getOrCreate("github", {});

    expect(first).not.toBe(second);
    expect(second.name).toBe("github");
  });
});

// ─── Tests: Discovery ─────────────────────────────────────────────

describe("SCMAdapterRegistry — Discovery", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("availableAdapters returns empty when nothing registered", () => {
    expect(registry.availableAdapters).toEqual([]);
  });

  it("availableAdapters includes factory-registered adapters", () => {
    registry.registerFactory(
      createMockSCMRegistration("github", "GitHub", "GitHub SCM adapter")
    );

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    expect(available[0]).toEqual({
      name: "github",
      displayName: "GitHub",
      description: "GitHub SCM adapter",
      instantiated: false,
    });
  });

  it("availableAdapters marks instantiated adapters", () => {
    registry.registerFactory(createMockSCMRegistration("github", "GitHub"));
    registry.getOrCreate("github", {});

    const available = registry.availableAdapters;
    expect(available[0].instantiated).toBe(true);
  });

  it("availableAdapters includes instance-only adapters", () => {
    registry.register(createMockSCMAdapter("custom", "Custom SCM"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    expect(available[0]).toEqual({
      name: "custom",
      displayName: "Custom SCM",
      description: undefined,
      instantiated: true,
    });
  });

  it("availableAdapters deduplicates factory + instance", () => {
    registry.registerFactory(
      createMockSCMRegistration("github", "GitHub", "A description")
    );
    registry.register(createMockSCMAdapter("github", "GitHub Instance"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(1);
    // Factory metadata takes precedence
    expect(available[0].displayName).toBe("GitHub");
    expect(available[0].description).toBe("A description");
    expect(available[0].instantiated).toBe(true);
  });

  it("availableAdapters combines factories and instance-only adapters", () => {
    registry.registerFactory(createMockSCMRegistration("github", "GitHub"));
    registry.registerFactory(createMockSCMRegistration("gitlab", "GitLab"));
    registry.register(createMockSCMAdapter("custom"));

    const available = registry.availableAdapters;
    expect(available).toHaveLength(3);

    const names = available.map((a) => a.name);
    expect(names).toContain("github");
    expect(names).toContain("gitlab");
    expect(names).toContain("custom");
  });

  it("isAvailable() returns true for factory-registered adapters", () => {
    registry.registerFactory(createMockSCMRegistration("github"));

    expect(registry.isAvailable("github")).toBe(true);
    expect(registry.isAvailable("gitlab")).toBe(false);
  });

  it("isAvailable() returns true for instance-registered adapters", () => {
    registry.register(createMockSCMAdapter("custom"));

    expect(registry.isAvailable("custom")).toBe(true);
  });

  it("isAvailable() returns true when both factory and instance exist", () => {
    registry.registerFactory(createMockSCMRegistration("github"));
    registry.register(createMockSCMAdapter("github"));

    expect(registry.isAvailable("github")).toBe(true);
  });
});

// ─── Tests: Bulk Operations ───────────────────────────────────────

describe("SCMAdapterRegistry — Bulk Operations", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  it("clear() removes all instances and factories", () => {
    registry.registerFactory(createMockSCMRegistration("github"));
    registry.register(createMockSCMAdapter("gitlab"));

    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.registeredFactories).toHaveLength(0);
    expect(registry.availableAdapters).toHaveLength(0);
  });

  it("clearInstances() removes instances but keeps factories", () => {
    registry.registerFactory(createMockSCMRegistration("github"));
    registry.getOrCreate("github", {});

    expect(registry.has("github")).toBe(true);

    registry.clearInstances();

    expect(registry.has("github")).toBe(false);
    expect(registry.hasFactory("github")).toBe(true);
  });
});

// ─── Tests: SCMAdapterRegistryError ───────────────────────────────

describe("SCMAdapterRegistryError", () => {
  it("has correct name and properties", () => {
    const err = new SCMAdapterRegistryError(
      "test message",
      "FACTORY_NOT_FOUND",
      "github"
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SCMAdapterRegistryError);
    expect(err.name).toBe("SCMAdapterRegistryError");
    expect(err.message).toBe("test message");
    expect(err.code).toBe("FACTORY_NOT_FOUND");
    expect(err.adapterName).toBe("github");
  });

  it("optionally carries a cause", () => {
    const cause = new Error("underlying issue");
    const err = new SCMAdapterRegistryError(
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
      const err = new SCMAdapterRegistryError("test", code);
      expect(err.code).toBe(code);
    }
  });
});

// ─── Tests: Core Decoupling Guarantee ─────────────────────────────

describe("SCMAdapterRegistry — Core Decoupling", () => {
  it("core code can create adapters without importing concrete classes", () => {
    // Simulate what core code does:
    // 1. Someone registers factories at startup (knows about concrete classes)
    // 2. Core code uses only the registry to get adapters

    const registry = new SCMAdapterRegistry();

    // "Startup" code registers factory (this is the ONLY place that
    // knows about concrete adapter construction)
    registry.registerFactory({
      name: "github",
      displayName: "GitHub",
      factory: (config) => createMockSCMAdapter("github"),
    });

    // "Core" code creates adapter purely by name + config
    // (zero imports of GitHubSCMAdapter or any concrete class)
    const adapter = registry.getOrCreate("github", {
      token: "ghp_secret_xyz",
    });

    expect(adapter.name).toBe("github");
    // displayName comes from the mock's auto-capitalization ("Github")
    // In real usage, the factory provides the proper display name
    expect(adapter.displayName).toBeTruthy();
  });

  it("factory pattern allows swapping adapter implementations", () => {
    const registry = new SCMAdapterRegistry();

    // Register a "real" adapter factory
    registry.registerFactory({
      name: "github",
      displayName: "GitHub",
      factory: () => createMockSCMAdapter("github", "Real GitHub"),
    });

    // Later, replace with a test double
    registry.replaceFactory({
      name: "github",
      displayName: "GitHub",
      factory: () => createMockSCMAdapter("github", "Test GitHub"),
    });

    const adapter = registry.createAdapter("github", {});
    expect(adapter.displayName).toBe("Test GitHub");
  });

  it("adapter instances are fully interchangeable via the SCMAdapter interface", async () => {
    const registry = new SCMAdapterRegistry();

    // Register two different adapter types
    registry.registerFactory({
      name: "github",
      displayName: "GitHub",
      factory: () => createMockSCMAdapter("github"),
    });
    registry.registerFactory({
      name: "gitlab",
      displayName: "GitLab",
      factory: () => createMockSCMAdapter("gitlab"),
    });

    // Core code can work with any adapter uniformly
    for (const info of registry.availableAdapters) {
      const adapter = registry.getOrCreate(info.name, {});

      // All adapters satisfy the same interface
      const status = await adapter.testConnection();
      expect(status.connected).toBe(true);

      const ref = adapter.parsePullRequestUrl("any-url");
      expect(ref).toHaveProperty("owner");
      expect(ref).toHaveProperty("repo");
      expect(ref).toHaveProperty("number");
    }
  });
});

// ─── Tests: API Parity with PM AdapterRegistry ───────────────────

describe("SCMAdapterRegistry — API Parity with PM AdapterRegistry", () => {
  it("has all instance management methods from PM AdapterRegistry", () => {
    const registry = new SCMAdapterRegistry();

    // Instance management methods
    expect(typeof registry.register).toBe("function");
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.has).toBe("function");
    expect(typeof registry.remove).toBe("function");
    expect(typeof registry.getAll).toBe("function");

    // Instance management properties
    expect(typeof registry.size).toBe("number");
    expect(Array.isArray(registry.registeredAdapters)).toBe(true);
  });

  it("has all factory management methods from PM AdapterRegistry", () => {
    const registry = new SCMAdapterRegistry();

    expect(typeof registry.registerFactory).toBe("function");
    expect(typeof registry.replaceFactory).toBe("function");
    expect(typeof registry.hasFactory).toBe("function");
    expect(typeof registry.removeFactory).toBe("function");
    expect(Array.isArray(registry.registeredFactories)).toBe(true);
  });

  it("has all factory-based instantiation methods from PM AdapterRegistry", () => {
    const registry = new SCMAdapterRegistry();

    expect(typeof registry.createAdapter).toBe("function");
    expect(typeof registry.getOrCreate).toBe("function");
  });

  it("has all discovery methods from PM AdapterRegistry", () => {
    const registry = new SCMAdapterRegistry();

    expect(Array.isArray(registry.availableAdapters)).toBe(true);
    expect(typeof registry.isAvailable).toBe("function");
  });

  it("has all bulk operation methods from PM AdapterRegistry", () => {
    const registry = new SCMAdapterRegistry();

    expect(typeof registry.clear).toBe("function");
    expect(typeof registry.clearInstances).toBe("function");
  });
});
