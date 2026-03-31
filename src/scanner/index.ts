/**
 * CodebaseScanner — the main orchestrator that ties together file discovery
 * and language-specific parsers to produce a structured inventory of code
 * concepts from a codebase.
 *
 * Usage:
 *   const scanner = new CodebaseScanner();
 *   const result = await scanner.scan({ rootDir: "/path/to/project" });
 *   console.log(result.concepts); // All extracted code concepts
 *   console.log(result.stats);    // Scan statistics
 */

import { readFile } from "node:fs/promises";
import type {
  CodeConcept,
  CodeConceptKind,
  ScanConfig,
  ScanResult,
  ScanStats,
  ScanDiagnostic,
  SupportedLanguage,
} from "../types/index.js";
import { discoverFiles, readFileContent } from "./file-discovery.js";
import { ParserRegistry } from "./parsers/index.js";

export { ParserRegistry } from "./parsers/index.js";
export { discoverFiles, readFileContent } from "./file-discovery.js";
export { TypeScriptParser } from "./parsers/typescript-parser.js";
export { PythonParser } from "./parsers/python-parser.js";

/**
 * The main codebase scanner.
 *
 * Orchestrates:
 * 1. File discovery (walking the directory tree)
 * 2. Language-specific parsing (extracting code concepts)
 * 3. Result aggregation (statistics, diagnostics)
 */
export class CodebaseScanner {
  private registry: ParserRegistry;

  constructor(registry?: ParserRegistry) {
    this.registry = registry ?? new ParserRegistry();
  }

  /**
   * Scan a codebase and return a structured inventory of code concepts.
   */
  async scan(config: ScanConfig): Promise<ScanResult> {
    const startTime = performance.now();
    const allConcepts: CodeConcept[] = [];
    const allDiagnostics: ScanDiagnostic[] = [];

    // Phase 1: Discover files
    const discovery = await discoverFiles(config);
    allDiagnostics.push(...discovery.diagnostics);

    // Add directory concepts
    allConcepts.push(...discovery.directories);

    // Phase 2: Parse each file
    let filesParsed = 0;
    let filesSkipped = 0;

    for (const file of discovery.files) {
      const parser = this.registry.getParser(file.extension);
      if (!parser) {
        filesSkipped++;
        continue;
      }

      // Read file content
      const content = await readFileContent(file.absolutePath);
      if (content === null) {
        filesSkipped++;
        allDiagnostics.push({
          level: "warning",
          filePath: file.relativePath,
          message: "Could not read file content",
        });
        continue;
      }

      // Parse the file
      try {
        const concepts = parser.parse(file.relativePath, content);
        allConcepts.push(...concepts);
        filesParsed++;
      } catch (err) {
        filesSkipped++;
        allDiagnostics.push({
          level: "error",
          filePath: file.relativePath,
          message: `Parse error: ${(err as Error).message}`,
        });
      }
    }

    const durationMs = performance.now() - startTime;

    // Phase 3: Compute statistics
    const stats = this.computeStats(
      discovery.files.length,
      filesParsed,
      filesSkipped,
      allConcepts,
      durationMs
    );

    return {
      rootDir: config.rootDir,
      scannedAt: new Date().toISOString(),
      concepts: allConcepts,
      stats,
      diagnostics: allDiagnostics,
    };
  }

  /**
   * Compute scan statistics from the results.
   */
  private computeStats(
    filesDiscovered: number,
    filesParsed: number,
    filesSkipped: number,
    concepts: CodeConcept[],
    durationMs: number
  ): ScanStats {
    const conceptsByKind: Record<CodeConceptKind, number> = {
      module: 0,
      class: 0,
      function: 0,
      interface: 0,
      enum: 0,
      constant: 0,
      directory: 0,
      namespace: 0,
    };

    const conceptsByLanguage: Record<SupportedLanguage, number> = {
      typescript: 0,
      javascript: 0,
      python: 0,
      unknown: 0,
    };

    for (const concept of concepts) {
      conceptsByKind[concept.kind]++;
      conceptsByLanguage[concept.language]++;
    }

    return {
      filesDiscovered,
      filesParsed,
      filesSkipped,
      conceptsExtracted: concepts.length,
      conceptsByKind,
      conceptsByLanguage,
      durationMs,
    };
  }

  /**
   * Get the parser registry (useful for adding custom parsers).
   */
  get parserRegistry(): ParserRegistry {
    return this.registry;
  }
}
