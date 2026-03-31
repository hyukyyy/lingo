import { describe, it, expect } from "vitest";
import {
  createNotionAdapter,
  notionFactoryRegistration,
} from "../../src/adapters/notion/factory.js";
import { NotionConfigError } from "../../src/adapters/notion/notion-config.js";
import type { PMAdapter } from "../../src/adapters/types.js";

describe("Notion Adapter Factory", () => {
  describe("createNotionAdapter()", () => {
    it("creates a valid adapter with valid config", () => {
      const adapter = createNotionAdapter({
        apiToken: "secret_test_token_abc123",
        databaseIds: [],
      });

      expect(adapter).toBeDefined();
      expect(adapter.name).toBe("notion");
      expect(adapter.displayName).toBe("Notion");
    });

    it("returns a PMAdapter-conformant object", () => {
      const adapter: PMAdapter = createNotionAdapter({
        apiToken: "ntn_test_token_abc123",
        databaseIds: [],
      });

      // Verify all interface methods exist
      expect(typeof adapter.testConnection).toBe("function");
      expect(typeof adapter.listProjects).toBe("function");
      expect(typeof adapter.getProject).toBe("function");
      expect(typeof adapter.listItems).toBe("function");
      expect(typeof adapter.getItem).toBe("function");
      expect(typeof adapter.extractItems).toBe("function");
      expect(typeof adapter.normalizeToTerms).toBe("function");
      expect(typeof adapter.extract).toBe("function");
      expect(typeof adapter.extractTerminology).toBe("function");
    });

    it("throws NotionConfigError for missing apiToken", () => {
      expect(() => {
        createNotionAdapter({ databaseIds: [] });
      }).toThrow(NotionConfigError);
    });

    it("throws NotionConfigError for invalid token prefix", () => {
      expect(() => {
        createNotionAdapter({
          apiToken: "invalid_prefix_token",
          databaseIds: [],
        });
      }).toThrow(NotionConfigError);
    });

    it("accepts both secret_ and ntn_ token prefixes", () => {
      const adapter1 = createNotionAdapter({
        apiToken: "secret_abc123",
        databaseIds: [],
      });
      expect(adapter1.name).toBe("notion");

      const adapter2 = createNotionAdapter({
        apiToken: "ntn_abc123",
        databaseIds: [],
      });
      expect(adapter2.name).toBe("notion");
    });

    it("passes optional config fields through", () => {
      // Should not throw — all optional fields accepted
      const adapter = createNotionAdapter({
        apiToken: "secret_test123",
        databaseIds: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
        propertyMappings: {
          titleProperty: "Name",
          statusProperty: "Status",
        },
        defaultItemType: "task",
        extractSchemaTerms: false,
      });

      expect(adapter.name).toBe("notion");
    });
  });

  describe("notionFactoryRegistration", () => {
    it("has correct metadata", () => {
      expect(notionFactoryRegistration.name).toBe("notion");
      expect(notionFactoryRegistration.displayName).toBe("Notion");
      expect(notionFactoryRegistration.description).toBeTruthy();
      expect(typeof notionFactoryRegistration.factory).toBe("function");
    });

    it("factory creates a working adapter", () => {
      const adapter = notionFactoryRegistration.factory({
        apiToken: "secret_integration_token_xyz",
        databaseIds: [],
      });

      expect(adapter.name).toBe("notion");
    });

    it("factory is the same function as createNotionAdapter", () => {
      expect(notionFactoryRegistration.factory).toBe(createNotionAdapter);
    });
  });
});
