import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { discoverFiles } from "../../src/scanner/file-discovery.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures/sample-project");

describe("discoverFiles", () => {
  it("should discover all matching files", async () => {
    const result = await discoverFiles({ rootDir: FIXTURE_DIR });

    expect(result.files.length).toBe(4); // 3 .ts + 1 .py
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).toContain("src/auth-service.ts");
    expect(paths).toContain("src/models/user.ts");
    expect(paths).toContain("src/utils/helpers.ts");
    expect(paths).toContain("scripts/deploy.py");
  });

  it("should return files sorted by relative path", async () => {
    const result = await discoverFiles({ rootDir: FIXTURE_DIR });
    const paths = result.files.map((f) => f.relativePath);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });

  it("should extract correct file extensions", async () => {
    const result = await discoverFiles({ rootDir: FIXTURE_DIR });

    const tsFiles = result.files.filter((f) => f.extension === ".ts");
    expect(tsFiles).toHaveLength(3);

    const pyFiles = result.files.filter((f) => f.extension === ".py");
    expect(pyFiles).toHaveLength(1);
  });

  it("should discover directories with descriptions", async () => {
    const result = await discoverFiles({
      rootDir: FIXTURE_DIR,
      includeDirectories: true,
    });

    expect(result.directories.length).toBeGreaterThan(0);
    const dirNames = result.directories.map((d) => d.name);
    expect(dirNames).toContain("src");
  });

  it("should respect custom include patterns", async () => {
    const result = await discoverFiles({
      rootDir: FIXTURE_DIR,
      include: ["**/*.py"],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].extension).toBe(".py");
  });

  it("should respect exclude patterns", async () => {
    const result = await discoverFiles({
      rootDir: FIXTURE_DIR,
      exclude: ["scripts"],
    });

    const paths = result.files.map((f) => f.relativePath);
    expect(paths.some((p) => p.includes("scripts/"))).toBe(false);
  });

  it("should handle non-existent directory", async () => {
    const result = await discoverFiles({
      rootDir: "/tmp/does-not-exist-lingo-test",
    });

    expect(result.files).toHaveLength(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].level).toBe("warning");
  });

  it("should skip directories when includeDirectories is false", async () => {
    const result = await discoverFiles({
      rootDir: FIXTURE_DIR,
      includeDirectories: false,
    });

    expect(result.directories).toHaveLength(0);
  });

  it("should report file sizes", async () => {
    const result = await discoverFiles({ rootDir: FIXTURE_DIR });

    for (const file of result.files) {
      expect(file.size).toBeGreaterThan(0);
    }
  });

  it("should use forward slashes in relative paths", async () => {
    const result = await discoverFiles({ rootDir: FIXTURE_DIR });

    for (const file of result.files) {
      expect(file.relativePath).not.toContain("\\");
    }
  });
});
