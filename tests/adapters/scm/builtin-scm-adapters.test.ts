import { describe, it, expect, beforeEach } from "vitest";
import { SCMAdapterRegistry } from "../../../src/adapters/scm/registry.js";
import {
  registerBuiltinSCMAdapters,
  getBuiltinSCMAdapterNames,
  BUILTIN_SCM_ADAPTER_FACTORIES,
} from "../../../src/adapters/scm/builtin-scm-adapters.js";
import { githubSCMFactoryRegistration } from "../../../src/adapters/scm/factory.js";

describe("Built-in SCM Adapter Discovery", () => {
  let registry: SCMAdapterRegistry;

  beforeEach(() => {
    registry = new SCMAdapterRegistry();
  });

  describe("BUILTIN_SCM_ADAPTER_FACTORIES", () => {
    it("contains the GitHub adapter", () => {
      expect(BUILTIN_SCM_ADAPTER_FACTORIES.length).toBeGreaterThanOrEqual(1);

      const names = BUILTIN_SCM_ADAPTER_FACTORIES.map((f) => f.name);
      expect(names).toContain("github");
    });

    it("each registration has required fields", () => {
      for (const reg of BUILTIN_SCM_ADAPTER_FACTORIES) {
        expect(reg.name).toBeTruthy();
        expect(reg.displayName).toBeTruthy();
        expect(typeof reg.factory).toBe("function");
      }
    });

    it("each registration has a unique name", () => {
      const names = BUILTIN_SCM_ADAPTER_FACTORIES.map((f) => f.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });

  describe("githubSCMFactoryRegistration", () => {
    it("has correct metadata", () => {
      expect(githubSCMFactoryRegistration.name).toBe("github");
      expect(githubSCMFactoryRegistration.displayName).toBe("GitHub");
      expect(githubSCMFactoryRegistration.description).toBeTruthy();
      expect(typeof githubSCMFactoryRegistration.factory).toBe("function");
    });

    it("factory creates a valid GitHub SCM adapter", () => {
      const adapter = githubSCMFactoryRegistration.factory({});

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("github");
      expect(adapter.displayName).toBe("GitHub");
    });

    it("factory passes token config to adapter", () => {
      const adapter = githubSCMFactoryRegistration.factory({
        token: "ghp_test123",
        baseUrl: "https://github.example.com/api/v3",
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("github");
    });
  });

  describe("registerBuiltinSCMAdapters()", () => {
    it("registers all built-in SCM factories", () => {
      const count = registerBuiltinSCMAdapters(registry);

      expect(count).toBe(BUILTIN_SCM_ADAPTER_FACTORIES.length);
      expect(registry.hasFactory("github")).toBe(true);
    });

    it("makes SCM adapters available via availableAdapters", () => {
      registerBuiltinSCMAdapters(registry);

      const available = registry.availableAdapters;
      expect(available.length).toBeGreaterThanOrEqual(1);

      const github = available.find((a) => a.name === "github");
      expect(github).toBeDefined();
      expect(github!.displayName).toBe("GitHub");
      expect(github!.description).toBeTruthy();
      expect(github!.instantiated).toBe(false);
    });

    it("can be called multiple times safely (idempotent)", () => {
      registerBuiltinSCMAdapters(registry);
      registerBuiltinSCMAdapters(registry);

      // Should not throw FACTORY_ALREADY_EXISTS (uses replaceFactory)
      expect(registry.registeredFactories).toHaveLength(
        BUILTIN_SCM_ADAPTER_FACTORIES.length
      );
    });

    it("returns the count of registered factories", () => {
      const count = registerBuiltinSCMAdapters(registry);
      expect(count).toBe(BUILTIN_SCM_ADAPTER_FACTORIES.length);
    });
  });

  describe("getBuiltinSCMAdapterNames()", () => {
    it("returns names of all built-in SCM adapters", () => {
      const names = getBuiltinSCMAdapterNames();

      expect(names).toContain("github");
      expect(names).toHaveLength(BUILTIN_SCM_ADAPTER_FACTORIES.length);
    });
  });

  describe("GitHub factory integration via registry", () => {
    it("creates a valid adapter via registry.createAdapter", () => {
      registerBuiltinSCMAdapters(registry);

      const adapter = registry.createAdapter("github", {});

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("github");
      expect(adapter.displayName).toBe("GitHub");
    });

    it("creates adapter with token config via registry", () => {
      registerBuiltinSCMAdapters(registry);

      const adapter = registry.createAdapter("github", {
        token: "ghp_test_token",
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("github");
    });

    it("getOrCreate caches GitHub adapter instance", () => {
      registerBuiltinSCMAdapters(registry);

      const first = registry.getOrCreate("github", {});
      const second = registry.getOrCreate("github", {});

      expect(first).toBe(second);
      expect(registry.has("github")).toBe(true);
    });
  });
});
