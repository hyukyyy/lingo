import { describe, it, expect } from "vitest";
import {
  createEmptyStore,
  createTerm,
  GLOSSARY_SCHEMA_VERSION,
  type GlossaryTerm,
  type GlossaryStore,
  type CodeLocation,
} from "../src/models/glossary.js";

describe("Glossary Data Model", () => {
  describe("createEmptyStore", () => {
    it("creates a store with correct schema version", () => {
      const store = createEmptyStore("test-org");
      expect(store.version).toBe(GLOSSARY_SCHEMA_VERSION);
    });

    it("sets the organization name", () => {
      const store = createEmptyStore("acme-corp");
      expect(store.organization).toBe("acme-corp");
    });

    it("initializes with empty terms", () => {
      const store = createEmptyStore("test-org");
      expect(store.terms).toEqual({});
    });

    it("sets lastModified to a valid ISO timestamp", () => {
      const before = new Date().toISOString();
      const store = createEmptyStore("test-org");
      const after = new Date().toISOString();

      expect(store.lastModified >= before).toBe(true);
      expect(store.lastModified <= after).toBe(true);
    });
  });

  describe("createTerm", () => {
    it("creates a term with required fields", () => {
      const term = createTerm({
        name: "Sprint Velocity",
        definition: "The number of story points completed per sprint",
      });

      expect(term.name).toBe("Sprint Velocity");
      expect(term.definition).toBe(
        "The number of story points completed per sprint"
      );
      expect(term.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("sets default values for optional fields", () => {
      const term = createTerm({
        name: "Test",
        definition: "A test term",
      });

      expect(term.aliases).toEqual([]);
      expect(term.codeLocations).toEqual([]);
      expect(term.tags).toEqual([]);
      expect(term.source).toEqual({ adapter: "manual" });
      expect(term.confidence).toBe("manual");
      expect(term.category).toBeUndefined();
    });

    it("sets createdAt and updatedAt timestamps", () => {
      const before = new Date().toISOString();
      const term = createTerm({
        name: "Test",
        definition: "A test term",
      });
      const after = new Date().toISOString();

      expect(term.createdAt >= before).toBe(true);
      expect(term.createdAt <= after).toBe(true);
      expect(term.createdAt).toBe(term.updatedAt);
    });

    it("accepts optional fields when provided", () => {
      const codeLocation: CodeLocation = {
        filePath: "src/services/auth.ts",
        symbol: "AuthService",
        relationship: "defines",
      };

      const term = createTerm({
        name: "Authentication Flow",
        definition: "The process users go through to verify their identity",
        aliases: ["auth", "login flow", "sign-in"],
        codeLocations: [codeLocation],
        category: "authentication",
        tags: ["security", "user-facing"],
        source: { adapter: "notion", externalId: "page-123" },
        confidence: "ai-verified",
      });

      expect(term.aliases).toEqual(["auth", "login flow", "sign-in"]);
      expect(term.codeLocations).toHaveLength(1);
      expect(term.codeLocations[0].filePath).toBe("src/services/auth.ts");
      expect(term.codeLocations[0].symbol).toBe("AuthService");
      expect(term.codeLocations[0].relationship).toBe("defines");
      expect(term.category).toBe("authentication");
      expect(term.tags).toEqual(["security", "user-facing"]);
      expect(term.source.adapter).toBe("notion");
      expect(term.source.externalId).toBe("page-123");
      expect(term.confidence).toBe("ai-verified");
    });

    it("generates unique IDs for each term", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const term = createTerm({
          name: `Term ${i}`,
          definition: `Definition ${i}`,
        });
        ids.add(term.id);
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("CodeLocation type structure", () => {
    it("supports all relationship types", () => {
      const relationships = [
        "defines",
        "implements",
        "uses",
        "tests",
        "configures",
      ] as const;

      for (const rel of relationships) {
        const loc: CodeLocation = {
          filePath: "test.ts",
          relationship: rel,
        };
        expect(loc.relationship).toBe(rel);
      }
    });

    it("supports optional lineRange", () => {
      const loc: CodeLocation = {
        filePath: "src/app.ts",
        relationship: "defines",
        lineRange: { start: 10, end: 50 },
      };
      expect(loc.lineRange?.start).toBe(10);
      expect(loc.lineRange?.end).toBe(50);
    });

    it("supports optional note", () => {
      const loc: CodeLocation = {
        filePath: "src/app.ts",
        relationship: "implements",
        note: "Main entry point for the feature",
      };
      expect(loc.note).toBe("Main entry point for the feature");
    });
  });

  describe("GlossaryStore type structure", () => {
    it("stores terms keyed by ID", () => {
      const term = createTerm({
        name: "Test Term",
        definition: "A test",
      });

      const store: GlossaryStore = {
        version: GLOSSARY_SCHEMA_VERSION,
        organization: "test-org",
        lastModified: new Date().toISOString(),
        terms: { [term.id]: term },
      };

      expect(store.terms[term.id]).toBe(term);
    });
  });
});
