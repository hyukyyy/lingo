/**
 * File discovery module for the codebase scanner.
 *
 * Walks the directory tree, respects ignore patterns, and returns
 * a list of files to be parsed along with directory structure information.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import type { ScanConfig, ScanDiagnostic, CodeConcept } from "../types/index.js";
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATTERNS,
} from "../types/index.js";

/**
 * A discovered file ready for parsing.
 */
export interface DiscoveredFile {
  /** Absolute path to the file */
  absolutePath: string;

  /** Relative path from project root */
  relativePath: string;

  /** File extension (e.g., ".ts") */
  extension: string;

  /** File size in bytes */
  size: number;
}

/**
 * Result of the file discovery phase.
 */
export interface DiscoveryResult {
  /** Files that should be parsed */
  files: DiscoveredFile[];

  /** Directory concepts extracted from the tree structure */
  directories: CodeConcept[];

  /** Any issues found during discovery */
  diagnostics: ScanDiagnostic[];
}

/**
 * Check if a file/directory name matches any of the exclude patterns.
 * Supports simple name matching and glob-like patterns.
 */
function shouldExclude(name: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    // Exact name match
    if (name === pattern) return true;

    // Simple glob: *.ext pattern
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // e.g., ".min.js"
      if (name.endsWith(ext)) return true;
    }
  }
  return false;
}

/**
 * Check if a file matches any of the include patterns based on extension.
 */
function matchesIncludePatterns(
  fileName: string,
  includePatterns: string[]
): boolean {
  const ext = extname(fileName).toLowerCase();

  for (const pattern of includePatterns) {
    // Extract extension from glob pattern like "**/*.ts"
    const match = pattern.match(/\*(\.\w+)$/);
    if (match && ext === match[1]) return true;
  }

  return false;
}

/**
 * Generate a description for a directory based on its name and contents.
 */
function describeDirectory(dirName: string, childCount: number): string {
  const knownDirs: Record<string, string> = {
    src: "Main source code directory",
    lib: "Library code directory",
    utils: "Utility functions and helpers",
    helpers: "Helper functions and modules",
    models: "Data models and schemas",
    types: "Type definitions",
    interfaces: "Interface definitions",
    services: "Service layer (business logic)",
    controllers: "Request handlers / controllers",
    routes: "Route definitions",
    middleware: "Middleware functions",
    config: "Configuration files",
    tests: "Test files",
    test: "Test files",
    __tests__: "Test files",
    spec: "Test specification files",
    components: "UI components",
    pages: "Page-level components or views",
    views: "View templates or components",
    hooks: "Custom hooks",
    store: "State management",
    api: "API layer",
    auth: "Authentication and authorization",
    db: "Database layer",
    database: "Database layer",
    migrations: "Database migrations",
    scripts: "Utility scripts",
    assets: "Static assets",
    public: "Public/static files",
    adapters: "Adapter implementations",
    providers: "Provider implementations",
    core: "Core/shared functionality",
    common: "Shared/common code",
    shared: "Shared modules",
    features: "Feature modules",
    modules: "Application modules",
    domain: "Domain logic",
    entities: "Domain entities",
    repositories: "Data access repositories",
    resolvers: "GraphQL resolvers or similar",
    handlers: "Event or request handlers",
    events: "Event definitions and handlers",
    jobs: "Background jobs or tasks",
    queues: "Queue definitions",
    workers: "Worker processes",
    cli: "Command-line interface",
    plugins: "Plugin modules",
    extensions: "Extension modules",
  };

  const known = knownDirs[dirName.toLowerCase()];
  if (known) return known;

  return `Directory containing ${childCount} item${childCount !== 1 ? "s" : ""}`;
}

/**
 * Walk the directory tree and discover files for parsing.
 */
export async function discoverFiles(
  config: ScanConfig
): Promise<DiscoveryResult> {
  const excludePatterns = config.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
  const includePatterns = config.include ?? DEFAULT_INCLUDE_PATTERNS;
  const maxDepth = config.maxDepth ?? 20;
  const maxFileSize = config.maxFileSize ?? 1_048_576; // 1MB
  const includeDirectories = config.includeDirectories ?? true;

  const files: DiscoveredFile[] = [];
  const directories: CodeConcept[] = [];
  const diagnostics: ScanDiagnostic[] = [];

  async function walk(dirPath: string, depth: number): Promise<number> {
    if (depth > maxDepth) return 0;

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      const relPath = relative(config.rootDir, dirPath);
      diagnostics.push({
        level: "warning",
        filePath: relPath || ".",
        message: `Could not read directory: ${(err as Error).message}`,
      });
      return 0;
    }

    let childCount = 0;

    for (const entry of entries) {
      const entryName = entry.name;

      // Check exclude patterns
      if (shouldExclude(entryName, excludePatterns)) continue;

      const fullPath = join(dirPath, entryName);
      const relPath = relative(config.rootDir, fullPath);

      if (entry.isDirectory()) {
        const subChildCount = await walk(fullPath, depth + 1);
        childCount++;

        if (includeDirectories) {
          directories.push({
            id: relPath.replace(/\\/g, "/"),
            name: entryName,
            kind: "directory",
            filePath: relPath.replace(/\\/g, "/"),
            description: describeDirectory(entryName, subChildCount),
            exported: false,
            language: "unknown",
            metadata: { childCount: subChildCount, depth },
          });
        }
      } else if (entry.isFile()) {
        childCount++;

        // Check if file matches include patterns
        if (!matchesIncludePatterns(entryName, includePatterns)) continue;

        // Check file size
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > maxFileSize) {
            diagnostics.push({
              level: "warning",
              filePath: relPath,
              message: `File skipped: exceeds max size (${fileStat.size} > ${maxFileSize} bytes)`,
            });
            continue;
          }

          files.push({
            absolutePath: fullPath,
            relativePath: relPath.replace(/\\/g, "/"),
            extension: extname(entryName).toLowerCase(),
            size: fileStat.size,
          });
        } catch (err) {
          diagnostics.push({
            level: "warning",
            filePath: relPath,
            message: `Could not stat file: ${(err as Error).message}`,
          });
        }
      }
    }

    return childCount;
  }

  await walk(config.rootDir, 0);

  // Sort files by path for deterministic output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  directories.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return { files, directories, diagnostics };
}

/**
 * Read a file's content, returning null if it can't be read.
 */
export async function readFileContent(
  absolutePath: string
): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf-8");
  } catch {
    return null;
  }
}
