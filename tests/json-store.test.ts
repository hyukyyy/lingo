import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonGlossaryStorage,
  StorageError,
} from "../src/storage/json-store.js";
import { GLOSSARY_SCHEMA_VERSION } from "../src/models/glossary.js";

describe("JsonGlossaryStorage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lingo-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createStorage(filename = "glossary.json"): JsonGlossaryStorage {
    return new JsonGlossaryStorage(join(tempDir, filename));
  }

  describe("load", () => {
    it("creates a new store when file does not exist", async () => {
      const storage = createStorage();
      const store = await storage.load("test-org");

      expect(store.version).toBe(GLOSSARY_SCHEMA_VERSION);
      expect(store.organization).toBe("test-org");
      expect(store.terms).toEqual({});
    });

    it("persists the new store to disk when creating", async () => {
      const path = join(tempDir, "glossary.json");
      const storage = new JsonGlossaryStorage(path);
      await storage.load("test-org");

      const contents = await readFile(path, "utf-8");
      const parsed = JSON.parse(contents);
      expect(parsed.organization).toBe("test-org");
      expect(parsed.version).toBe(GLOSSARY_SCHEMA_VERSION);
    });

    it("creates nested directories if needed", async () => {
      const path = join(tempDir, "deep", "nested", "glossary.json");
      const storage = new JsonGlossaryStorage(path);
      const store = await storage.load("test-org");

      expect(store.organization).toBe("test-org");

      const contents = await readFile(path, "utf-8");
      expect(JSON.parse(contents).organization).toBe("test-org");
    });

    it("loads an existing valid store from disk", async () => {
      const path = join(tempDir, "glossary.json");
      const { writeFile: writeF } = await import("node:fs/promises");
      await writeF(
        path,
        JSON.stringify({
          version: GLOSSARY_SCHEMA_VERSION,
          organization: "existing-org",
          lastModified: "2024-01-01T00:00:00.000Z",
          terms: {},
        }),
        "utf-8"
      );

      const storage = new JsonGlossaryStorage(path);
      const store = await storage.load();

      expect(store.organization).toBe("existing-org");
    });

    it("throws PARSE_ERROR for invalid JSON", async () => {
      const path = join(tempDir, "glossary.json");
      const { writeFile: writeF } = await import("node:fs/promises");
      await writeF(path, "not valid json {{{}}", "utf-8");

      const storage = new JsonGlossaryStorage(path);

      await expect(storage.load()).rejects.toThrow(StorageError);
      await expect(storage.load()).rejects.toMatchObject({
        code: "PARSE_ERROR",
      });
    });

    it("throws SCHEMA_MISMATCH for incompatible version", async () => {
      const path = join(tempDir, "glossary.json");
      const { writeFile: writeF } = await import("node:fs/promises");
      await writeF(
        path,
        JSON.stringify({
          version: "99.0.0",
          organization: "test",
          lastModified: "2024-01-01T00:00:00.000Z",
          terms: {},
        }),
        "utf-8"
      );

      const storage = new JsonGlossaryStorage(path);

      await expect(storage.load()).rejects.toThrow(StorageError);
      await expect(storage.load()).rejects.toMatchObject({
        code: "SCHEMA_MISMATCH",
      });
    });
  });

  describe("save", () => {
    it("throws if called before load", async () => {
      const storage = createStorage();

      await expect(storage.save()).rejects.toThrow(StorageError);
      await expect(storage.save()).rejects.toMatchObject({
        code: "WRITE_ERROR",
      });
    });

    it("writes valid JSON to disk", async () => {
      const path = join(tempDir, "glossary.json");
      const storage = new JsonGlossaryStorage(path);
      await storage.load("test-org");
      await storage.save();

      const contents = await readFile(path, "utf-8");
      const parsed = JSON.parse(contents);
      expect(parsed.version).toBe(GLOSSARY_SCHEMA_VERSION);
      expect(parsed.organization).toBe("test-org");
    });

    it("updates lastModified on save", async () => {
      const storage = createStorage();
      const store = await storage.load("test-org");
      const firstModified = store.lastModified;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));
      await storage.save();

      expect(store.lastModified > firstModified).toBe(true);
    });
  });

  describe("CRUD operations", () => {
    let storage: JsonGlossaryStorage;

    beforeEach(async () => {
      storage = createStorage();
      await storage.load("test-org");
    });

    describe("addTerm", () => {
      it("adds a term and persists to disk", async () => {
        const term = await storage.addTerm({
          name: "Sprint Velocity",
          definition: "Story points completed per sprint",
        });

        expect(term.id).toBeDefined();
        expect(term.name).toBe("Sprint Velocity");

        // Verify persisted
        const raw = await readFile(storage.getFilePath(), "utf-8");
        const parsed = JSON.parse(raw);
        expect(parsed.terms[term.id]).toBeDefined();
        expect(parsed.terms[term.id].name).toBe("Sprint Velocity");
      });

      it("adds a term with full details", async () => {
        const term = await storage.addTerm({
          name: "User Story",
          definition: "A feature description from user perspective",
          aliases: ["story", "US"],
          codeLocations: [
            {
              filePath: "src/models/story.ts",
              symbol: "UserStory",
              relationship: "defines",
            },
          ],
          category: "agile",
          tags: ["planning", "requirements"],
          source: { adapter: "notion", externalId: "abc-123" },
          confidence: "ai-verified",
        });

        const retrieved = storage.getTerm(term.id);
        expect(retrieved).toBeDefined();
        expect(retrieved?.aliases).toEqual(["story", "US"]);
        expect(retrieved?.codeLocations).toHaveLength(1);
        expect(retrieved?.category).toBe("agile");
      });
    });

    describe("getTerm", () => {
      it("returns undefined for non-existent ID", () => {
        expect(storage.getTerm("non-existent-id")).toBeUndefined();
      });

      it("returns the term for a valid ID", async () => {
        const added = await storage.addTerm({
          name: "Test Term",
          definition: "A test",
        });

        const retrieved = storage.getTerm(added.id);
        expect(retrieved).toEqual(added);
      });
    });

    describe("updateTerm", () => {
      it("updates specific fields without touching others", async () => {
        const term = await storage.addTerm({
          name: "Original Name",
          definition: "Original definition",
          tags: ["original"],
        });

        const updated = await storage.updateTerm(term.id, {
          definition: "Updated definition",
        });

        expect(updated.name).toBe("Original Name");
        expect(updated.definition).toBe("Updated definition");
        expect(updated.tags).toEqual(["original"]);
      });

      it("updates the updatedAt timestamp", async () => {
        const term = await storage.addTerm({
          name: "Test",
          definition: "Test",
        });

        await new Promise((r) => setTimeout(r, 10));

        const updated = await storage.updateTerm(term.id, {
          name: "Updated",
        });

        expect(updated.updatedAt > term.updatedAt).toBe(true);
        expect(updated.createdAt).toBe(term.createdAt);
      });

      it("prevents ID and createdAt from being overwritten", async () => {
        const term = await storage.addTerm({
          name: "Test",
          definition: "Test",
        });

        // TypeScript would prevent this, but test the runtime guard
        const updated = await storage.updateTerm(term.id, {
          name: "Updated",
        } as any);

        expect(updated.id).toBe(term.id);
        expect(updated.createdAt).toBe(term.createdAt);
      });

      it("throws for non-existent term", async () => {
        await expect(
          storage.updateTerm("non-existent", { name: "X" })
        ).rejects.toThrow(StorageError);
        await expect(
          storage.updateTerm("non-existent", { name: "X" })
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      });

      it("persists updates to disk", async () => {
        const term = await storage.addTerm({
          name: "Test",
          definition: "Original",
        });

        await storage.updateTerm(term.id, {
          definition: "Persisted update",
        });

        const raw = await readFile(storage.getFilePath(), "utf-8");
        const parsed = JSON.parse(raw);
        expect(parsed.terms[term.id].definition).toBe("Persisted update");
      });
    });

    describe("removeTerm", () => {
      it("removes an existing term and returns true", async () => {
        const term = await storage.addTerm({
          name: "To Remove",
          definition: "Will be removed",
        });

        const result = await storage.removeTerm(term.id);
        expect(result).toBe(true);
        expect(storage.getTerm(term.id)).toBeUndefined();
      });

      it("returns false for non-existent term", async () => {
        const result = await storage.removeTerm("non-existent");
        expect(result).toBe(false);
      });

      it("persists removal to disk", async () => {
        const term = await storage.addTerm({
          name: "To Remove",
          definition: "Will be removed",
        });

        await storage.removeTerm(term.id);

        const raw = await readFile(storage.getFilePath(), "utf-8");
        const parsed = JSON.parse(raw);
        expect(parsed.terms[term.id]).toBeUndefined();
      });
    });

    describe("listTerms", () => {
      beforeEach(async () => {
        await storage.addTerm({
          name: "Auth Token",
          definition: "JWT token for authentication",
          category: "authentication",
          tags: ["security"],
          confidence: "manual",
          source: { adapter: "manual" },
        });
        await storage.addTerm({
          name: "Sprint Velocity",
          definition: "Points per sprint",
          category: "agile",
          tags: ["metrics"],
          confidence: "ai-suggested",
          source: { adapter: "notion" },
        });
        await storage.addTerm({
          name: "SSO Provider",
          definition: "Single sign-on provider config",
          category: "authentication",
          tags: ["security", "infrastructure"],
          confidence: "ai-verified",
          source: { adapter: "notion" },
        });
      });

      it("returns all terms without filter", () => {
        const terms = storage.listTerms();
        expect(terms).toHaveLength(3);
      });

      it("filters by category", () => {
        const terms = storage.listTerms({ category: "authentication" });
        expect(terms).toHaveLength(2);
        expect(terms.every((t) => t.category === "authentication")).toBe(true);
      });

      it("filters by tag", () => {
        const terms = storage.listTerms({ tag: "security" });
        expect(terms).toHaveLength(2);
      });

      it("filters by confidence", () => {
        const terms = storage.listTerms({ confidence: "ai-suggested" });
        expect(terms).toHaveLength(1);
        expect(terms[0].name).toBe("Sprint Velocity");
      });

      it("filters by adapter", () => {
        const terms = storage.listTerms({ adapter: "notion" });
        expect(terms).toHaveLength(2);
      });

      it("returns empty array when no terms match filter", () => {
        const terms = storage.listTerms({ category: "non-existent" });
        expect(terms).toEqual([]);
      });
    });

    describe("searchTerms", () => {
      beforeEach(async () => {
        await storage.addTerm({
          name: "Sprint Velocity",
          definition: "Story points completed per sprint cycle",
          aliases: ["velocity", "team speed"],
          category: "agile",
        });
        await storage.addTerm({
          name: "Authentication Token",
          definition: "JWT bearer token used for API authentication",
          aliases: ["auth token", "JWT", "bearer"],
          category: "authentication",
        });
        await storage.addTerm({
          name: "Code Review",
          definition: "Peer review of code changes before merging",
          aliases: ["PR review", "pull request review"],
          category: "workflow",
        });
      });

      it("finds terms by exact name match", () => {
        const results = storage.searchTerms("Sprint Velocity");
        expect(results[0].name).toBe("Sprint Velocity");
      });

      it("finds terms by partial name match", () => {
        const results = storage.searchTerms("velocity");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("Sprint Velocity");
      });

      it("finds terms by alias match", () => {
        const results = storage.searchTerms("JWT");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("Authentication Token");
      });

      it("finds terms by definition content", () => {
        const results = storage.searchTerms("merging");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("Code Review");
      });

      it("ranks exact name match higher than partial", () => {
        const results = storage.searchTerms("Sprint Velocity");
        expect(results[0].name).toBe("Sprint Velocity");
      });

      it("is case-insensitive", () => {
        const results = storage.searchTerms("SPRINT VELOCITY");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe("Sprint Velocity");
      });

      it("returns empty for empty query", () => {
        expect(storage.searchTerms("")).toEqual([]);
        expect(storage.searchTerms("   ")).toEqual([]);
      });

      it("returns empty when nothing matches", () => {
        expect(storage.searchTerms("xyznonexistent")).toEqual([]);
      });
    });

    describe("findTermsByFile", () => {
      beforeEach(async () => {
        await storage.addTerm({
          name: "Auth Service",
          definition: "Handles authentication",
          codeLocations: [
            {
              filePath: "src/services/auth.ts",
              symbol: "AuthService",
              relationship: "defines",
            },
            {
              filePath: "src/middleware/auth-middleware.ts",
              relationship: "implements",
            },
          ],
        });
        await storage.addTerm({
          name: "User Model",
          definition: "Core user data model",
          codeLocations: [
            {
              filePath: "src/models/user.ts",
              symbol: "User",
              relationship: "defines",
            },
          ],
        });
      });

      it("finds terms by exact file path", () => {
        const results = storage.findTermsByFile("src/services/auth.ts");
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Auth Service");
      });

      it("finds terms by partial file path", () => {
        const results = storage.findTermsByFile("auth");
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe("Auth Service");
      });

      it("is case-insensitive", () => {
        const results = storage.findTermsByFile("AUTH");
        expect(results).toHaveLength(1);
      });

      it("returns empty when no terms reference the file", () => {
        const results = storage.findTermsByFile("nonexistent.ts");
        expect(results).toEqual([]);
      });
    });
  });

  describe("getStore", () => {
    it("throws if load has not been called", () => {
      const storage = createStorage();
      expect(() => storage.getStore()).toThrow(StorageError);
    });

    it("returns the store after load", async () => {
      const storage = createStorage();
      await storage.load("test-org");
      const store = storage.getStore();
      expect(store.organization).toBe("test-org");
    });
  });

  describe("data integrity", () => {
    it("round-trips data through save and load", async () => {
      const path = join(tempDir, "roundtrip.json");
      const storage1 = new JsonGlossaryStorage(path);
      await storage1.load("test-org");

      await storage1.addTerm({
        name: "Round Trip Term",
        definition: "Should survive save/load cycle",
        aliases: ["rtt"],
        codeLocations: [
          {
            filePath: "src/test.ts",
            symbol: "roundTrip",
            relationship: "defines",
            lineRange: { start: 1, end: 10 },
            note: "Test location",
          },
        ],
        category: "testing",
        tags: ["e2e"],
        source: { adapter: "notion", externalId: "ext-1", url: "https://notion.so/page" },
        confidence: "ai-verified",
      });

      // Load in a fresh instance
      const storage2 = new JsonGlossaryStorage(path);
      const store = await storage2.load();

      const terms = storage2.listTerms();
      expect(terms).toHaveLength(1);

      const term = terms[0];
      expect(term.name).toBe("Round Trip Term");
      expect(term.definition).toBe("Should survive save/load cycle");
      expect(term.aliases).toEqual(["rtt"]);
      expect(term.codeLocations).toHaveLength(1);
      expect(term.codeLocations[0].filePath).toBe("src/test.ts");
      expect(term.codeLocations[0].symbol).toBe("roundTrip");
      expect(term.codeLocations[0].relationship).toBe("defines");
      expect(term.codeLocations[0].lineRange).toEqual({ start: 1, end: 10 });
      expect(term.codeLocations[0].note).toBe("Test location");
      expect(term.category).toBe("testing");
      expect(term.tags).toEqual(["e2e"]);
      expect(term.source.adapter).toBe("notion");
      expect(term.source.externalId).toBe("ext-1");
      expect(term.source.url).toBe("https://notion.so/page");
      expect(term.confidence).toBe("ai-verified");
    });
  });
});
