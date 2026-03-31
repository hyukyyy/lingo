import { describe, it, expect, beforeEach } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import {
  registerBuiltinAdapters,
  getBuiltinAdapterNames,
  BUILTIN_ADAPTER_FACTORIES,
} from "../../src/adapters/builtin-adapters.js";

describe("Built-in Adapter Discovery", () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe("BUILTIN_ADAPTER_FACTORIES", () => {
    it("contains at least the Notion adapter", () => {
      expect(BUILTIN_ADAPTER_FACTORIES.length).toBeGreaterThanOrEqual(1);

      const names = BUILTIN_ADAPTER_FACTORIES.map((f) => f.name);
      expect(names).toContain("notion");
    });

    it("each registration has required fields", () => {
      for (const reg of BUILTIN_ADAPTER_FACTORIES) {
        expect(reg.name).toBeTruthy();
        expect(reg.displayName).toBeTruthy();
        expect(typeof reg.factory).toBe("function");
      }
    });

    it("each registration has a unique name", () => {
      const names = BUILTIN_ADAPTER_FACTORIES.map((f) => f.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });

  describe("registerBuiltinAdapters()", () => {
    it("registers all built-in factories", () => {
      const count = registerBuiltinAdapters(registry);

      expect(count).toBe(BUILTIN_ADAPTER_FACTORIES.length);
      expect(registry.hasFactory("notion")).toBe(true);
    });

    it("makes adapters available via availableAdapters", () => {
      registerBuiltinAdapters(registry);

      const available = registry.availableAdapters;
      expect(available.length).toBeGreaterThanOrEqual(1);

      const notion = available.find((a) => a.name === "notion");
      expect(notion).toBeDefined();
      expect(notion!.displayName).toBe("Notion");
      expect(notion!.description).toBeTruthy();
      expect(notion!.instantiated).toBe(false);
    });

    it("can be called multiple times safely (idempotent)", () => {
      registerBuiltinAdapters(registry);
      registerBuiltinAdapters(registry);

      // Should not throw FACTORY_ALREADY_EXISTS
      expect(registry.registeredFactories).toHaveLength(
        BUILTIN_ADAPTER_FACTORIES.length
      );
    });

    it("returns the count of registered factories", () => {
      const count = registerBuiltinAdapters(registry);
      expect(count).toBe(BUILTIN_ADAPTER_FACTORIES.length);
    });
  });

  describe("getBuiltinAdapterNames()", () => {
    it("returns names of all built-in adapters", () => {
      const names = getBuiltinAdapterNames();

      expect(names).toContain("notion");
      expect(names).toHaveLength(BUILTIN_ADAPTER_FACTORIES.length);
    });
  });

  describe("Notion factory integration", () => {
    it("Notion factory creates a valid adapter with proper config", () => {
      registerBuiltinAdapters(registry);

      // The Notion factory uses parseNotionConfig which requires valid token format
      const adapter = registry.createAdapter("notion", {
        apiToken: "secret_test_token_12345",
        databaseIds: [],
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("notion");
      expect(adapter.displayName).toBe("Notion");
    });

    it("Notion factory throws on invalid config", () => {
      registerBuiltinAdapters(registry);

      // Missing required apiToken
      expect(() => {
        registry.createAdapter("notion", {});
      }).toThrow(); // Should throw CREATION_FAILED wrapping NotionConfigError
    });

    it("Notion factory throws on invalid token format", () => {
      registerBuiltinAdapters(registry);

      expect(() => {
        registry.createAdapter("notion", {
          apiToken: "invalid_token",
          databaseIds: [],
        });
      }).toThrow();
    });

    it("getOrCreate caches Notion adapter instance", () => {
      registerBuiltinAdapters(registry);

      const config = {
        apiToken: "secret_test_token_12345",
        databaseIds: [],
      };

      const first = registry.getOrCreate("notion", config);
      const second = registry.getOrCreate("notion", config);

      expect(first).toBe(second);
      expect(registry.has("notion")).toBe(true);
    });
  });
});
