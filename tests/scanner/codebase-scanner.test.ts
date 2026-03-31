import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { CodebaseScanner } from "../../src/scanner/index.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures/sample-project");

describe("CodebaseScanner", () => {
  const scanner = new CodebaseScanner();

  describe("full scan of sample project", () => {
    it("should produce a complete scan result", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      expect(result.rootDir).toBe(FIXTURE_DIR);
      expect(result.scannedAt).toBeTruthy();
      expect(result.concepts.length).toBeGreaterThan(0);
      expect(result.stats.filesParsed).toBeGreaterThan(0);
      expect(result.stats.durationMs).toBeGreaterThan(0);
    });

    it("should discover all fixture files", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      // We have: auth-service.ts, models/user.ts, utils/helpers.ts, scripts/deploy.py
      expect(result.stats.filesParsed).toBe(4);
    });

    it("should extract concepts from all languages", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      const languages = new Set(result.concepts.map((c) => c.language));
      expect(languages).toContain("typescript");
      expect(languages).toContain("python");
    });

    it("should extract directory concepts", async () => {
      const result = await scanner.scan({
        rootDir: FIXTURE_DIR,
        includeDirectories: true,
      });

      const dirs = result.concepts.filter((c) => c.kind === "directory");
      expect(dirs.length).toBeGreaterThan(0);

      const dirNames = dirs.map((d) => d.name);
      expect(dirNames).toContain("src");
      expect(dirNames).toContain("models");
      expect(dirNames).toContain("utils");
      expect(dirNames).toContain("scripts");
    });

    it("should provide known descriptions for well-known directories", async () => {
      const result = await scanner.scan({
        rootDir: FIXTURE_DIR,
        includeDirectories: true,
      });

      const srcDir = result.concepts.find(
        (c) => c.kind === "directory" && c.name === "src"
      );
      expect(srcDir!.description).toBe("Main source code directory");

      const modelsDir = result.concepts.find(
        (c) => c.kind === "directory" && c.name === "models"
      );
      expect(modelsDir!.description).toBe("Data models and schemas");

      const utilsDir = result.concepts.find(
        (c) => c.kind === "directory" && c.name === "utils"
      );
      expect(utilsDir!.description).toBe("Utility functions and helpers");
    });
  });

  describe("scan statistics", () => {
    it("should count concepts by kind", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      const { conceptsByKind } = result.stats;
      expect(conceptsByKind.module).toBeGreaterThan(0);
      expect(conceptsByKind.class).toBeGreaterThan(0);
      expect(conceptsByKind.function).toBeGreaterThan(0);
    });

    it("should count concepts by language", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      const { conceptsByLanguage } = result.stats;
      expect(conceptsByLanguage.typescript).toBeGreaterThan(0);
      expect(conceptsByLanguage.python).toBeGreaterThan(0);
    });

    it("should report total concept count matching sum of kinds", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      const sumByKind = Object.values(result.stats.conceptsByKind).reduce(
        (a, b) => a + b,
        0
      );
      expect(result.stats.conceptsExtracted).toBe(sumByKind);
    });
  });

  describe("scan configuration", () => {
    it("should respect exclude patterns", async () => {
      // Create a scan that excludes Python files
      const result = await scanner.scan({
        rootDir: FIXTURE_DIR,
        include: ["**/*.ts"],
      });

      const pyModules = result.concepts.filter(
        (c) => c.language === "python" && c.kind === "module"
      );
      expect(pyModules).toHaveLength(0);
    });

    it("should allow disabling directory concepts", async () => {
      const result = await scanner.scan({
        rootDir: FIXTURE_DIR,
        includeDirectories: false,
      });

      const dirs = result.concepts.filter((c) => c.kind === "directory");
      expect(dirs).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("should handle non-existent root directory gracefully", async () => {
      const result = await scanner.scan({
        rootDir: "/tmp/does-not-exist-lingo-test",
      });

      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.concepts).toHaveLength(0);
      expect(result.stats.filesParsed).toBe(0);
    });
  });

  describe("concept relationships", () => {
    it("should correctly link methods to their parent class", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      // Find the AuthService class
      const authService = result.concepts.find(
        (c) => c.kind === "class" && c.name === "AuthService"
      );
      expect(authService).toBeDefined();

      // Find its methods
      const methods = result.concepts.filter(
        (c) => c.parentId === authService!.id
      );
      expect(methods.length).toBeGreaterThanOrEqual(3);
    });

    it("should link top-level functions to their module", async () => {
      const result = await scanner.scan({ rootDir: FIXTURE_DIR });

      const hashPassword = result.concepts.find(
        (c) => c.name === "hashPassword"
      );
      expect(hashPassword).toBeDefined();
      expect(hashPassword!.parentId).toBe("src/auth-service.ts");
    });
  });
});
