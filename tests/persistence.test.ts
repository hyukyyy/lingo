/**
 * Cross-Session Persistence Tests
 *
 * Verifies AC 9: "Glossary persists across sessions"
 *
 * Each test simulates multiple "sessions" by creating separate
 * JsonGlossaryStorage instances that share the same file path.
 * This proves that data written in one session survives and is
 * correctly loaded by subsequent sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonGlossaryStorage,
  StorageError,
} from "../src/storage/json-store.js";
import {
  GLOSSARY_SCHEMA_VERSION,
  type GlossaryTerm,
} from "../src/models/glossary.js";

describe("Cross-Session Persistence (AC 9)", () => {
  let tempDir: string;
  let glossaryPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lingo-persist-"));
    glossaryPath = join(tempDir, ".lingo", "glossary.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper: create a new storage instance (simulates a new session).
   * Each call returns a fresh instance with no in-memory state,
   * as if the MCP server was restarted.
   */
  function newSession(): JsonGlossaryStorage {
    return new JsonGlossaryStorage(glossaryPath);
  }

  // ─── Core Persistence ──────────────────────────────────────────────

  describe("basic cross-session survival", () => {
    it("a term added in session 1 is readable in session 2", async () => {
      // Session 1: add a term
      const session1 = newSession();
      await session1.load("acme-corp");
      const created = await session1.addTerm({
        name: "Sprint Velocity",
        definition: "Average story points completed per sprint",
      });

      // Session 2: load from same file, verify term exists
      const session2 = newSession();
      await session2.load();
      const found = session2.getTerm(created.id);

      expect(found).toBeDefined();
      expect(found!.name).toBe("Sprint Velocity");
      expect(found!.definition).toBe(
        "Average story points completed per sprint"
      );
      expect(found!.id).toBe(created.id);
    });

    it("organization name persists across sessions", async () => {
      // Session 1: initialize with org name
      const session1 = newSession();
      await session1.load("zenith-labs");

      // Session 2: verify org name
      const session2 = newSession();
      const store = await session2.load();
      expect(store.organization).toBe("zenith-labs");
    });

    it("empty glossary persists correctly", async () => {
      // Session 1: create empty store
      const session1 = newSession();
      await session1.load("empty-org");

      // Session 2: verify still empty
      const session2 = newSession();
      const store = await session2.load();
      expect(store.organization).toBe("empty-org");
      expect(Object.keys(store.terms)).toHaveLength(0);
    });

    it("schema version persists correctly", async () => {
      const session1 = newSession();
      await session1.load("test-org");

      const session2 = newSession();
      const store = await session2.load();
      expect(store.version).toBe(GLOSSARY_SCHEMA_VERSION);
    });
  });

  // ─── Multi-term Persistence ────────────────────────────────────────

  describe("multiple terms across sessions", () => {
    it("multiple terms added in one session survive to the next", async () => {
      // Session 1: add several terms
      const session1 = newSession();
      await session1.load("multi-org");

      const term1 = await session1.addTerm({
        name: "Epic",
        definition: "A large body of work that spans multiple sprints",
        category: "agile",
      });
      const term2 = await session1.addTerm({
        name: "Story Point",
        definition: "Unit of effort estimation",
        category: "agile",
      });
      const term3 = await session1.addTerm({
        name: "Deployment Pipeline",
        definition: "CI/CD process from commit to production",
        category: "devops",
      });

      // Session 2: all terms should be present
      const session2 = newSession();
      await session2.load();
      const allTerms = session2.listTerms();

      expect(allTerms).toHaveLength(3);
      expect(session2.getTerm(term1.id)?.name).toBe("Epic");
      expect(session2.getTerm(term2.id)?.name).toBe("Story Point");
      expect(session2.getTerm(term3.id)?.name).toBe("Deployment Pipeline");
    });

    it("terms added across different sessions accumulate", async () => {
      // Session 1: add first term
      const session1 = newSession();
      await session1.load("accum-org");
      const id1 = (
        await session1.addTerm({
          name: "Term A",
          definition: "First term",
        })
      ).id;

      // Session 2: add second term
      const session2 = newSession();
      await session2.load();
      const id2 = (
        await session2.addTerm({
          name: "Term B",
          definition: "Second term",
        })
      ).id;

      // Session 3: add third term
      const session3 = newSession();
      await session3.load();
      const id3 = (
        await session3.addTerm({
          name: "Term C",
          definition: "Third term",
        })
      ).id;

      // Session 4: all three should be present
      const session4 = newSession();
      await session4.load();
      const terms = session4.listTerms();

      expect(terms).toHaveLength(3);
      expect(terms.map((t) => t.name).sort()).toEqual([
        "Term A",
        "Term B",
        "Term C",
      ]);
    });
  });

  // ─── CRUD Lifecycle Across Sessions ────────────────────────────────

  describe("CRUD operations persist across sessions", () => {
    it("update in session 2 is visible in session 3", async () => {
      // Session 1: create
      const session1 = newSession();
      await session1.load("crud-org");
      const original = await session1.addTerm({
        name: "Feature Flag",
        definition: "Boolean toggle for feature gating",
      });

      // Session 2: update
      const session2 = newSession();
      await session2.load();
      await session2.updateTerm(original.id, {
        definition: "Configuration toggle for gradual feature rollout",
        tags: ["infrastructure", "release-management"],
      });

      // Session 3: verify update persisted
      const session3 = newSession();
      await session3.load();
      const final = session3.getTerm(original.id);

      expect(final).toBeDefined();
      expect(final!.name).toBe("Feature Flag");
      expect(final!.definition).toBe(
        "Configuration toggle for gradual feature rollout"
      );
      expect(final!.tags).toEqual(["infrastructure", "release-management"]);
    });

    it("deletion in session 2 is reflected in session 3", async () => {
      // Session 1: create two terms
      const session1 = newSession();
      await session1.load("delete-org");
      const keepTerm = await session1.addTerm({
        name: "Keep This",
        definition: "Should survive deletion of sibling",
      });
      const removeTerm = await session1.addTerm({
        name: "Remove This",
        definition: "Will be removed in session 2",
      });

      // Session 2: delete one term
      const session2 = newSession();
      await session2.load();
      const removed = await session2.removeTerm(removeTerm.id);
      expect(removed).toBe(true);

      // Session 3: verify deletion persisted, other term survives
      const session3 = newSession();
      await session3.load();
      expect(session3.getTerm(removeTerm.id)).toBeUndefined();
      expect(session3.getTerm(keepTerm.id)).toBeDefined();
      expect(session3.listTerms()).toHaveLength(1);
    });

    it("full CRUD lifecycle across 4 sessions", async () => {
      // Session 1: Create
      const s1 = newSession();
      await s1.load("lifecycle-org");
      const term = await s1.addTerm({
        name: "API Gateway",
        definition: "Entry point for all API traffic",
        aliases: ["gateway"],
        source: { adapter: "manual" },
        confidence: "manual",
      });
      const termId = term.id;

      // Session 2: Read and verify
      const s2 = newSession();
      await s2.load();
      const readTerm = s2.getTerm(termId);
      expect(readTerm).toBeDefined();
      expect(readTerm!.name).toBe("API Gateway");

      // Session 3: Update
      const s3 = newSession();
      await s3.load();
      await s3.updateTerm(termId, {
        definition: "Centralized entry point for all API traffic with rate limiting",
        codeLocations: [
          {
            filePath: "src/gateway/index.ts",
            symbol: "APIGateway",
            relationship: "defines",
          },
        ],
        confidence: "ai-verified",
      });

      // Session 4: Verify update, then delete
      const s4 = newSession();
      await s4.load();
      const updated = s4.getTerm(termId);
      expect(updated!.definition).toContain("rate limiting");
      expect(updated!.codeLocations).toHaveLength(1);
      expect(updated!.confidence).toBe("ai-verified");
      expect(updated!.aliases).toEqual(["gateway"]); // Unchanged fields survive

      await s4.removeTerm(termId);

      // Session 5: Confirm deletion
      const s5 = newSession();
      await s5.load();
      expect(s5.getTerm(termId)).toBeUndefined();
      expect(s5.listTerms()).toHaveLength(0);
    });
  });

  // ─── Full Term Data Fidelity ───────────────────────────────────────

  describe("all term fields persist correctly", () => {
    it("preserves every field of a fully-specified term", async () => {
      // Session 1: create a term with ALL optional fields populated
      const session1 = newSession();
      await session1.load("fidelity-org");
      const created = await session1.addTerm({
        name: "User Authentication Flow",
        definition:
          "The complete process from login attempt through token issuance",
        aliases: ["auth flow", "login", "sign-in process"],
        codeLocations: [
          {
            filePath: "src/auth/login.ts",
            symbol: "LoginHandler",
            relationship: "defines",
            lineRange: { start: 15, end: 89 },
            note: "Main login handler class",
          },
          {
            filePath: "src/auth/token.ts",
            symbol: "issueToken",
            relationship: "implements",
          },
          {
            filePath: "tests/auth/login.test.ts",
            relationship: "tests",
          },
          {
            filePath: "config/auth.yaml",
            relationship: "configures",
            note: "OAuth provider configuration",
          },
        ],
        category: "authentication",
        tags: ["security", "user-facing", "critical-path"],
        source: {
          adapter: "notion",
          externalId: "notion-page-abc123",
          url: "https://notion.so/workspace/auth-flow-abc123",
        },
        confidence: "ai-verified",
      });

      // Session 2: verify EVERY field is intact
      const session2 = newSession();
      await session2.load();
      const loaded = session2.getTerm(created.id);

      expect(loaded).toBeDefined();

      // Identity
      expect(loaded!.id).toBe(created.id);
      expect(loaded!.name).toBe("User Authentication Flow");
      expect(loaded!.definition).toBe(
        "The complete process from login attempt through token issuance"
      );

      // Aliases
      expect(loaded!.aliases).toEqual([
        "auth flow",
        "login",
        "sign-in process",
      ]);

      // Code locations (deep equality)
      expect(loaded!.codeLocations).toHaveLength(4);
      expect(loaded!.codeLocations[0]).toEqual({
        filePath: "src/auth/login.ts",
        symbol: "LoginHandler",
        relationship: "defines",
        lineRange: { start: 15, end: 89 },
        note: "Main login handler class",
      });
      expect(loaded!.codeLocations[1]).toEqual({
        filePath: "src/auth/token.ts",
        symbol: "issueToken",
        relationship: "implements",
      });
      expect(loaded!.codeLocations[2]).toEqual({
        filePath: "tests/auth/login.test.ts",
        relationship: "tests",
      });
      expect(loaded!.codeLocations[3]).toEqual({
        filePath: "config/auth.yaml",
        relationship: "configures",
        note: "OAuth provider configuration",
      });

      // Category & tags
      expect(loaded!.category).toBe("authentication");
      expect(loaded!.tags).toEqual([
        "security",
        "user-facing",
        "critical-path",
      ]);

      // Source
      expect(loaded!.source).toEqual({
        adapter: "notion",
        externalId: "notion-page-abc123",
        url: "https://notion.so/workspace/auth-flow-abc123",
      });

      // Confidence
      expect(loaded!.confidence).toBe("ai-verified");

      // Timestamps
      expect(loaded!.createdAt).toBe(created.createdAt);
      expect(loaded!.updatedAt).toBe(created.updatedAt);
    });

    it("preserves terms with minimal fields (only required)", async () => {
      const session1 = newSession();
      await session1.load("minimal-org");
      const created = await session1.addTerm({
        name: "Minimal Term",
        definition: "Only required fields set",
      });

      const session2 = newSession();
      await session2.load();
      const loaded = session2.getTerm(created.id);

      expect(loaded!.name).toBe("Minimal Term");
      expect(loaded!.definition).toBe("Only required fields set");
      expect(loaded!.aliases).toEqual([]);
      expect(loaded!.codeLocations).toEqual([]);
      expect(loaded!.tags).toEqual([]);
      expect(loaded!.source).toEqual({ adapter: "manual" });
      expect(loaded!.confidence).toBe("manual");
    });
  });

  // ─── Search & Filter Persistence ───────────────────────────────────

  describe("search and filter work on persisted data", () => {
    it("searchTerms works on data loaded from disk", async () => {
      // Session 1: populate
      const session1 = newSession();
      await session1.load("search-org");
      await session1.addTerm({
        name: "Kubernetes Deployment",
        definition: "Container orchestration deployment config",
        aliases: ["k8s deploy", "kube deployment"],
        category: "infrastructure",
      });
      await session1.addTerm({
        name: "Feature Toggle",
        definition: "Runtime feature flag configuration",
        category: "release-management",
      });

      // Session 2: search on persisted data
      const session2 = newSession();
      await session2.load();

      const k8sResults = session2.searchTerms("kubernetes");
      expect(k8sResults).toHaveLength(1);
      expect(k8sResults[0].name).toBe("Kubernetes Deployment");

      const aliasResults = session2.searchTerms("k8s");
      expect(aliasResults).toHaveLength(1);
      expect(aliasResults[0].name).toBe("Kubernetes Deployment");

      const featureResults = session2.searchTerms("feature");
      expect(featureResults).toHaveLength(1);
      expect(featureResults[0].name).toBe("Feature Toggle");
    });

    it("listTerms with filters works on persisted data", async () => {
      // Session 1: populate with categorized terms
      const session1 = newSession();
      await session1.load("filter-org");
      await session1.addTerm({
        name: "Auth Token",
        definition: "JWT token",
        category: "auth",
        tags: ["security"],
        confidence: "manual",
        source: { adapter: "manual" },
      });
      await session1.addTerm({
        name: "OAuth Provider",
        definition: "External auth provider",
        category: "auth",
        tags: ["security", "external"],
        confidence: "ai-suggested",
        source: { adapter: "notion" },
      });
      await session1.addTerm({
        name: "Sprint Board",
        definition: "Kanban board for sprint",
        category: "agile",
        tags: ["planning"],
        confidence: "manual",
        source: { adapter: "linear" },
      });

      // Session 2: filter on persisted data
      const session2 = newSession();
      await session2.load();

      expect(session2.listTerms({ category: "auth" })).toHaveLength(2);
      expect(session2.listTerms({ tag: "security" })).toHaveLength(2);
      expect(session2.listTerms({ confidence: "ai-suggested" })).toHaveLength(1);
      expect(session2.listTerms({ adapter: "notion" })).toHaveLength(1);
      expect(session2.listTerms({ adapter: "linear" })).toHaveLength(1);
    });

    it("findTermsByFile works on persisted data", async () => {
      const session1 = newSession();
      await session1.load("file-org");
      await session1.addTerm({
        name: "Payment Service",
        definition: "Handles payment processing",
        codeLocations: [
          {
            filePath: "src/services/payment.ts",
            symbol: "PaymentService",
            relationship: "defines",
          },
          {
            filePath: "src/routes/payment-routes.ts",
            relationship: "uses",
          },
        ],
      });

      const session2 = newSession();
      await session2.load();

      const results = session2.findTermsByFile("payment");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Payment Service");
    });
  });

  // ─── Timestamp Persistence ─────────────────────────────────────────

  describe("timestamp integrity across sessions", () => {
    it("createdAt is preserved, updatedAt reflects last change", async () => {
      // Session 1: create
      const session1 = newSession();
      await session1.load("ts-org");
      const created = await session1.addTerm({
        name: "Timestamp Test",
        definition: "Testing timestamp persistence",
      });
      const originalCreatedAt = created.createdAt;
      const originalUpdatedAt = created.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 15));

      // Session 2: update
      const session2 = newSession();
      await session2.load();
      const updated = await session2.updateTerm(created.id, {
        definition: "Updated definition",
      });

      expect(updated.createdAt).toBe(originalCreatedAt);
      expect(updated.updatedAt > originalUpdatedAt).toBe(true);

      // Session 3: verify timestamps persisted
      const session3 = newSession();
      await session3.load();
      const final = session3.getTerm(created.id);

      expect(final!.createdAt).toBe(originalCreatedAt);
      expect(final!.updatedAt).toBe(updated.updatedAt);
      expect(final!.updatedAt > final!.createdAt).toBe(true);
    });

    it("lastModified on the store is updated after mutations", async () => {
      const session1 = newSession();
      const store1 = await session1.load("lm-org");
      const firstModified = store1.lastModified;

      await new Promise((r) => setTimeout(r, 15));

      await session1.addTerm({
        name: "Trigger Update",
        definition: "This should update lastModified",
      });

      const session2 = newSession();
      const store2 = await session2.load();
      expect(store2.lastModified > firstModified).toBe(true);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles terms with special characters in name and definition", async () => {
      const session1 = newSession();
      await session1.load("special-org");
      const created = await session1.addTerm({
        name: 'Term with "quotes" & <angle brackets>',
        definition:
          "Definition with\nnewlines\tand\ttabs and unicode: \u00e9\u00e8\u00ea\u00eb \u2603 \ud83d\ude80",
        aliases: ["alias/with/slashes", "alias\\with\\backslashes"],
      });

      const session2 = newSession();
      await session2.load();
      const loaded = session2.getTerm(created.id);

      expect(loaded!.name).toBe('Term with "quotes" & <angle brackets>');
      expect(loaded!.definition).toContain("\n");
      expect(loaded!.definition).toContain("\t");
      expect(loaded!.definition).toContain("\u00e9");
      expect(loaded!.definition).toContain("\ud83d\ude80");
      expect(loaded!.aliases).toEqual([
        "alias/with/slashes",
        "alias\\with\\backslashes",
      ]);
    });

    it("handles terms with empty string values in optional fields", async () => {
      const session1 = newSession();
      await session1.load("empty-org");
      const created = await session1.addTerm({
        name: "Edge Case",
        definition: "Testing empty strings",
        category: "",
        tags: [],
        aliases: [],
      });

      const session2 = newSession();
      await session2.load();
      const loaded = session2.getTerm(created.id);

      expect(loaded!.category).toBe("");
      expect(loaded!.tags).toEqual([]);
      expect(loaded!.aliases).toEqual([]);
    });

    it("handles many terms without data loss", async () => {
      const session1 = newSession();
      await session1.load("scale-org");

      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const term = await session1.addTerm({
          name: `Term ${i}`,
          definition: `Definition for term number ${i}`,
          category: `category-${i % 5}`,
          tags: [`tag-${i % 3}`, `tag-${i % 7}`],
        });
        ids.push(term.id);
      }

      // Session 2: verify all 100 terms survived
      const session2 = newSession();
      await session2.load();
      const allTerms = session2.listTerms();

      expect(allTerms).toHaveLength(100);

      // Verify each term individually
      for (let i = 0; i < 100; i++) {
        const term = session2.getTerm(ids[i]);
        expect(term).toBeDefined();
        expect(term!.name).toBe(`Term ${i}`);
        expect(term!.definition).toBe(`Definition for term number ${i}`);
      }
    });

    it("handles rapid successive sessions without corruption", async () => {
      // Simulate rapid session cycling (server restart scenarios)
      for (let i = 0; i < 10; i++) {
        const session = newSession();
        await session.load("rapid-org");
        await session.addTerm({
          name: `Rapid Term ${i}`,
          definition: `Added in rapid session ${i}`,
        });
      }

      // Final session: all terms should be present
      const finalSession = newSession();
      await finalSession.load();
      const terms = finalSession.listTerms();
      expect(terms).toHaveLength(10);

      for (let i = 0; i < 10; i++) {
        expect(terms.find((t) => t.name === `Rapid Term ${i}`)).toBeDefined();
      }
    });
  });

  // ─── Error Recovery ────────────────────────────────────────────────

  describe("error recovery", () => {
    it("rejects corrupted glossary file", async () => {
      // Session 1: write valid data
      const session1 = newSession();
      await session1.load("corrupt-org");
      await session1.addTerm({
        name: "Valid Term",
        definition: "This was valid",
      });

      // Corrupt the file
      await writeFile(glossaryPath, "{ invalid json !!!", "utf-8");

      // Session 2: should throw parse error
      const session2 = newSession();
      await expect(session2.load()).rejects.toThrow(StorageError);
    });

    it("rejects file with incompatible schema version", async () => {
      // Session 1: create valid store
      const session1 = newSession();
      await session1.load("version-org");

      // Tamper with version
      const raw = await readFile(glossaryPath, "utf-8");
      const data = JSON.parse(raw);
      data.version = "99.0.0";
      await writeFile(glossaryPath, JSON.stringify(data), "utf-8");

      // Session 2: should reject
      const session2 = newSession();
      await expect(session2.load()).rejects.toThrow(StorageError);
    });

    it("accepts compatible minor version bump", async () => {
      // Session 1: create valid store
      const session1 = newSession();
      await session1.load("minor-org");
      await session1.addTerm({
        name: "Compatible",
        definition: "Should work with minor version difference",
      });

      // Bump minor version (same major)
      const raw = await readFile(glossaryPath, "utf-8");
      const data = JSON.parse(raw);
      const [major] = GLOSSARY_SCHEMA_VERSION.split(".");
      data.version = `${major}.99.0`;
      await writeFile(glossaryPath, JSON.stringify(data), "utf-8");

      // Session 2: should still load (same major version)
      const session2 = newSession();
      const store = await session2.load();
      expect(session2.listTerms()).toHaveLength(1);
      expect(session2.listTerms()[0].name).toBe("Compatible");
    });
  });

  // ─── File Integrity ────────────────────────────────────────────────

  describe("file format integrity", () => {
    it("glossary file is human-readable JSON with indentation", async () => {
      const session1 = newSession();
      await session1.load("readable-org");
      await session1.addTerm({
        name: "Readable Term",
        definition: "Check the file format",
      });

      const raw = await readFile(glossaryPath, "utf-8");

      // Should be pretty-printed (contain newlines and indentation)
      expect(raw).toContain("\n");
      expect(raw).toMatch(/^\s{2}/m); // At least 2-space indentation
      expect(raw.endsWith("\n")).toBe(true); // Trailing newline

      // Should be valid JSON
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(GLOSSARY_SCHEMA_VERSION);
    });

    it("glossary file can be manually edited and re-loaded", async () => {
      // Session 1: create initial data
      const session1 = newSession();
      await session1.load("edit-org");
      const term = await session1.addTerm({
        name: "Editable Term",
        definition: "Original from code",
      });

      // Simulate manual file edit (e.g., user edits with text editor)
      const raw = await readFile(glossaryPath, "utf-8");
      const data = JSON.parse(raw);
      data.terms[term.id].definition = "Manually edited by human";
      await writeFile(
        glossaryPath,
        JSON.stringify(data, null, 2) + "\n",
        "utf-8"
      );

      // Session 2: should load the manually edited data
      const session2 = newSession();
      await session2.load();
      const loaded = session2.getTerm(term.id);
      expect(loaded!.definition).toBe("Manually edited by human");
    });
  });
});
