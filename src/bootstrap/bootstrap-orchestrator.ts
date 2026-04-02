/**
 * Bootstrap Orchestrator
 *
 * Wires together the codebase scanner, PM adapter, and mapping engine into
 * a single coordinated bootstrap operation. This is the core cold-start
 * mechanism that lets new organizations get immediate value from Lingo.
 *
 * Flow:
 *   1. Scan the codebase to discover code concepts
 *   2. Extract terminology from a PM tool (if adapter is provided)
 *      OR infer terms from code concepts (cold-start without PM tool)
 *   3. Run the mapping engine to match terms to code concepts
 *   4. Persist the generated mappings to the glossary store
 *   5. Return a comprehensive summary
 *
 * All generated terms are marked with confidence "ai-suggested" so humans
 * can review and verify them before they reach "ai-verified" or "manual" status.
 */

import { CodebaseScanner } from "../scanner/index.js";
import { MappingEngine } from "../mapping/index.js";
import type { MappingCandidate, MappingConfig } from "../mapping/index.js";
import { JsonGlossaryStorage } from "../storage/json-store.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { NormalizedTerm, ExtractionResult } from "../adapters/types.js";
import type { CodeConcept, ScanConfig, ScanResult } from "../types/index.js";
import type { GlossaryTerm, CodeLocation, CodeRelationship } from "../models/glossary.js";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Options for the bootstrap operation.
 */
export interface BootstrapOptions {
  /** Absolute path to the project root to scan */
  rootDir: string;

  /**
   * PM adapter name to use for term extraction (e.g., "notion", "linear").
   * If omitted, terms are inferred from code concepts alone (cold-start).
   */
  adapterName?: string;

  /**
   * Options passed to the PM adapter's extract() method.
   */
  adapterOptions?: {
    /** Specific project/database ID in the PM tool */
    projectId?: string;
    /** Maximum items to extract */
    maxItems?: number;
  };

  /**
   * If true, compute mappings but don't persist them to storage.
   * Useful for previewing what the bootstrap would produce.
   */
  dryRun?: boolean;

  /**
   * Configuration overrides for the mapping engine.
   */
  mappingConfig?: MappingConfig;

  /**
   * Configuration overrides for the codebase scanner.
   */
  scanConfig?: Partial<Omit<ScanConfig, "rootDir">>;

  /**
   * Organization name for the glossary store (used if store is newly created).
   */
  organization?: string;
}

/**
 * Summary of what a bootstrap operation produced.
 */
export interface BootstrapSummary {
  /** Whether changes were persisted (false when dryRun is true) */
  persisted: boolean;

  /** Number of terms created in the glossary */
  termsCreated: number;

  /** Number of code location mappings created across all terms */
  mappingsCreated: number;

  /** How terminology was sourced */
  termSource: "pm-adapter" | "codebase-inferred";

  /** Name of the PM adapter used, if any */
  adapterName?: string;

  /** Codebase scan statistics */
  scan: {
    filesScanned: number;
    conceptsFound: number;
    durationMs: number;
  };

  /** PM extraction statistics (only when adapter is used) */
  extraction?: {
    itemsFetched: number;
    termsExtracted: number;
    durationMs: number;
  };

  /** Mapping engine statistics */
  mapping: {
    termsProcessed: number;
    candidatesGenerated: number;
    candidatesAboveThreshold: number;
    durationMs: number;
  };

  /** The created terms with their mappings (for dry-run preview or summary) */
  terms: BootstrapTermPreview[];

  /** Total duration of the entire bootstrap operation in milliseconds */
  totalDurationMs: number;

  /** Any warnings or issues encountered */
  warnings: string[];
}

/**
 * A preview of a term that was (or would be) created during bootstrap.
 */
export interface BootstrapTermPreview {
  /** Term name */
  name: string;
  /** Term definition */
  definition: string;
  /** Number of code location mappings */
  codeLocationCount: number;
  /** Best confidence score among the mappings */
  bestConfidence: number;
  /** The term ID (only set when persisted) */
  id?: string;
}

// ─── Orchestrator ──────────────────────────────────────────────────

/**
 * The bootstrap orchestrator — coordinates scanner, PM adapter, mapping
 * engine, and storage into a single cohesive operation.
 *
 * This class is stateless: each `run()` call is independent.
 * Dependencies are injected via the constructor for testability.
 */
export class BootstrapOrchestrator {
  private readonly scanner: CodebaseScanner;
  private readonly mappingEngine: MappingEngine;
  private readonly storage: JsonGlossaryStorage;
  private readonly adapterRegistry: AdapterRegistry;

  constructor(deps: {
    scanner?: CodebaseScanner;
    mappingEngine?: MappingEngine;
    storage: JsonGlossaryStorage;
    adapterRegistry?: AdapterRegistry;
  }) {
    this.scanner = deps.scanner ?? new CodebaseScanner();
    this.mappingEngine = deps.mappingEngine ?? new MappingEngine();
    this.storage = deps.storage;
    this.adapterRegistry = deps.adapterRegistry ?? new AdapterRegistry();
  }

  /**
   * Run the full bootstrap operation.
   *
   * Steps:
   * 1. Scan the codebase
   * 2. Extract/infer terminology
   * 3. Generate term↔code mappings
   * 4. Persist to glossary (unless dryRun)
   * 5. Return summary
   */
  async run(options: BootstrapOptions): Promise<BootstrapSummary> {
    const startTime = performance.now();
    const warnings: string[] = [];

    // ── Step 1: Scan the codebase ──────────────────────────────────
    const scanResult = await this.scanCodebase(options);

    if (scanResult.concepts.length === 0) {
      warnings.push("No code concepts found — check that the root directory contains source files.");
    }

    // Collect diagnostics from scan
    for (const diag of scanResult.diagnostics) {
      if (diag.level === "warning") {
        warnings.push(`[scan] ${diag.filePath}: ${diag.message}`);
      }
    }

    // ── Step 2: Extract or infer terminology ───────────────────────
    let terms: NormalizedTerm[];
    let termSource: "pm-adapter" | "codebase-inferred";
    let extractionStats: BootstrapSummary["extraction"] | undefined;

    if (options.adapterName) {
      const extractionResult = await this.extractFromAdapter(
        options.adapterName,
        options.adapterOptions,
      );

      if (extractionResult) {
        terms = extractionResult.terms;
        termSource = "pm-adapter";
        extractionStats = {
          itemsFetched: extractionResult.stats.itemsFetched,
          termsExtracted: extractionResult.stats.termsProduced,
          durationMs: extractionResult.stats.durationMs,
        };

        for (const w of extractionResult.warnings) {
          warnings.push(`[adapter:${options.adapterName}] ${w}`);
        }

        if (terms.length === 0) {
          warnings.push(
            `PM adapter "${options.adapterName}" returned no terms. ` +
            "Falling back to codebase-inferred terminology."
          );
          terms = this.inferTermsFromCode(scanResult.concepts);
          termSource = "codebase-inferred";
        }
      } else {
        throw new Error(
          `PM adapter "${options.adapterName}" is not available. ` +
          "Ensure the adapter token is configured (env var or /lingo:setup), " +
          "or omit the adapter parameter to scan codebase only."
        );
      }
    } else {
      terms = this.inferTermsFromCode(scanResult.concepts);
      termSource = "codebase-inferred";
    }

    if (terms.length === 0) {
      warnings.push("No terms available for mapping.");
    }

    // ── Step 3: Generate mappings ──────────────────────────────────
    const mappingResult = this.mappingEngine.generateMappings(
      terms,
      scanResult.concepts,
    );

    // ── Step 4: Persist to glossary ────────────────────────────────
    const persistedTerms: GlossaryTerm[] = [];
    const termPreviews: BootstrapTermPreview[] = [];

    if (!options.dryRun && terms.length > 0) {
      // Ensure the store is loaded
      await this.storage.load(options.organization ?? "default");

      for (const term of terms) {
        // Find the mapping candidates for this term
        const candidates = mappingResult.mappings.filter(
          (m) => m.termName === term.name,
        );

        const codeLocations = this.candidatesToCodeLocations(candidates);
        const bestConfidence = candidates.length > 0
          ? Math.max(...candidates.map((c) => c.confidence))
          : 0;

        const glossaryTerm = await this.storage.addTerm({
          name: term.name,
          definition: term.definition,
          aliases: term.aliases,
          codeLocations,
          category: term.category,
          tags: [...term.tags, "bootstrap"],
          source: term.source,
          confidence: "ai-suggested",
        });

        persistedTerms.push(glossaryTerm);
        termPreviews.push({
          name: glossaryTerm.name,
          definition: glossaryTerm.definition,
          codeLocationCount: codeLocations.length,
          bestConfidence,
          id: glossaryTerm.id,
        });
      }
    } else {
      // Dry run — build previews without persisting
      for (const term of terms) {
        const candidates = mappingResult.mappings.filter(
          (m) => m.termName === term.name,
        );

        const bestConfidence = candidates.length > 0
          ? Math.max(...candidates.map((c) => c.confidence))
          : 0;

        termPreviews.push({
          name: term.name,
          definition: term.definition,
          codeLocationCount: candidates.length,
          bestConfidence,
        });
      }
    }

    const totalDurationMs = performance.now() - startTime;

    // Count total code location mappings
    const totalMappings = termPreviews.reduce(
      (sum, t) => sum + t.codeLocationCount,
      0,
    );

    return {
      persisted: !options.dryRun && persistedTerms.length > 0,
      termsCreated: options.dryRun ? 0 : persistedTerms.length,
      mappingsCreated: options.dryRun ? 0 : totalMappings,
      termSource,
      adapterName: options.adapterName,
      scan: {
        filesScanned: scanResult.stats.filesParsed,
        conceptsFound: scanResult.concepts.length,
        durationMs: scanResult.stats.durationMs,
      },
      extraction: extractionStats,
      mapping: {
        termsProcessed: mappingResult.stats.termsProcessed,
        candidatesGenerated: mappingResult.stats.candidatesGenerated,
        candidatesAboveThreshold: mappingResult.stats.candidatesAfterFilter,
        durationMs: mappingResult.stats.durationMs,
      },
      terms: termPreviews,
      totalDurationMs,
      warnings,
    };
  }

  // ─── Private: Codebase Scanning ─────────────────────────────────

  /**
   * Run the codebase scanner with the given options.
   */
  private async scanCodebase(options: BootstrapOptions): Promise<ScanResult> {
    const scanConfig: ScanConfig = {
      rootDir: options.rootDir,
      ...options.scanConfig,
    };

    return this.scanner.scan(scanConfig);
  }

  // ─── Private: PM Adapter Extraction ─────────────────────────────

  /**
   * Extract terminology from a PM adapter.
   * Returns null if the adapter is not registered.
   */
  private async extractFromAdapter(
    adapterName: string,
    adapterOptions?: BootstrapOptions["adapterOptions"],
  ): Promise<ExtractionResult | null> {
    const adapter = this.adapterRegistry.get(adapterName);
    if (!adapter) {
      return null;
    }

    return adapter.extract({
      maxItems: adapterOptions?.maxItems,
      project: adapterOptions?.projectId,
    });
  }

  // ─── Private: Cold-Start Term Inference ─────────────────────────

  /**
   * Infer organizational terms from code concepts when no PM adapter
   * is available. This is the cold-start mechanism.
   *
   * Strategy:
   * - Classes, interfaces, and enums become term candidates
   *   (these are the most "naming-heavy" constructs)
   * - Top-level modules (files) with descriptive names become candidates
   * - Directories that appear to represent domain concepts become candidates
   * - Exported constants with descriptive names become candidates
   *
   * Each inferred term gets:
   * - Name derived from the concept's name (de-camelCased)
   * - Definition auto-generated from the concept's description and context
   * - Source marked as "bootstrap" adapter
   * - Confidence set to "ai-suggested"
   */
  inferTermsFromCode(concepts: CodeConcept[]): NormalizedTerm[] {
    const terms: NormalizedTerm[] = [];
    const seen = new Set<string>();

    // Priority order: classes/interfaces first, then modules, directories, functions
    const prioritized = [...concepts].sort((a, b) => {
      const kindOrder: Record<string, number> = {
        class: 0,
        interface: 1,
        enum: 2,
        term: 3,
        definition: 4,
        section: 5,
        module: 6,
        namespace: 7,
        directory: 8,
        function: 9,
        constant: 10,
      };
      return (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
    });

    for (const concept of prioritized) {
      // Only consider exported/significant concepts
      if (!this.isTermWorthy(concept)) {
        continue;
      }

      // Deduplicate by normalized name
      const normalizedName = concept.name.toLowerCase().trim();
      if (seen.has(normalizedName)) {
        continue;
      }
      seen.add(normalizedName);

      const humanName = this.humanizeName(concept.name);
      const definition = this.buildInferredDefinition(concept);

      terms.push({
        name: humanName,
        definition,
        aliases: this.buildAliases(concept.name, humanName),
        category: this.inferCategoryFromPath(concept.filePath),
        tags: [concept.kind, concept.language, "bootstrap"],
        source: {
          adapter: "bootstrap",
          externalId: concept.id,
        },
        confidence: "ai-suggested",
      });
    }

    return terms;
  }

  /**
   * Determine if a code concept is "term-worthy" — significant enough
   * to become a glossary term candidate.
   */
  private isTermWorthy(concept: CodeConcept): boolean {
    // Always include classes, interfaces, and enums
    if (["class", "interface", "enum"].includes(concept.kind)) {
      return concept.exported;
    }

    // Include top-level modules (files) with descriptive names
    if (concept.kind === "module") {
      // Skip index files and generic names
      const name = concept.name.toLowerCase();
      return !["index", "main", "app", "mod"].includes(name) && concept.exported;
    }

    // Include directories that look like domain concepts
    if (concept.kind === "directory") {
      const name = concept.name.toLowerCase();
      // Skip generic infrastructure directories
      const genericDirs = [
        "src", "lib", "dist", "build", "utils", "helpers",
        "types", "config", "test", "tests", "__tests__",
        "scripts", "public", "assets", "static",
      ];
      return !genericDirs.includes(name);
    }

    // Include exported named functions (but not arrow functions in modules)
    if (concept.kind === "function") {
      return concept.exported && concept.name.length > 3;
    }

    // Include namespaces
    if (concept.kind === "namespace") {
      return true;
    }

    // Doc-sourced: bold terms and table definitions are always term-worthy
    if (concept.kind === "term" || concept.kind === "definition") {
      return true;
    }

    // Doc-sourced: section headers are term-worthy unless generic
    if (concept.kind === "section") {
      const name = concept.name.toLowerCase();
      const genericSections = [
        "introduction", "overview", "summary", "table of contents",
        "getting started", "prerequisites", "installation", "usage",
        "contributing", "license", "changelog", "faq", "appendix",
        "references", "acknowledgements", "conclusion",
      ];
      return !genericSections.includes(name);
    }

    return false;
  }

  /**
   * Convert a code identifier name to a human-readable term name.
   * E.g., "AuthService" -> "Auth Service", "getUserById" -> "Get User By Id"
   */
  private humanizeName(name: string): string {
    // Split camelCase/PascalCase into words
    const words = name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();

    // Title-case each word
    return words
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  /**
   * Build a definition for a code-inferred term.
   */
  private buildInferredDefinition(concept: CodeConcept): string {
    if (concept.description && concept.description.length > 10) {
      return concept.description;
    }

    const kindLabel = concept.kind.charAt(0).toUpperCase() + concept.kind.slice(1);
    const location = concept.filePath;

    return `${kindLabel} "${concept.name}" found in ${location}. ` +
      `This term was auto-discovered during codebase bootstrap and may represent ` +
      `an organizational concept.`;
  }

  /**
   * Build aliases from the original code identifier and the humanized name.
   */
  private buildAliases(originalName: string, humanName: string): string[] {
    const aliases: string[] = [];

    // Original code identifier as an alias (if different from human name)
    if (originalName !== humanName && originalName !== humanName.replace(/\s/g, "")) {
      aliases.push(originalName);
    }

    // Lowercase version
    const lower = humanName.toLowerCase();
    if (lower !== humanName.toLowerCase()) {
      aliases.push(lower);
    }

    // Abbreviated form for multi-word names (e.g., "Auth Service" -> "AS")
    const words = humanName.split(/\s+/);
    if (words.length >= 2 && words.length <= 5) {
      const abbrev = words.map((w) => w.charAt(0).toUpperCase()).join("");
      if (abbrev.length >= 2) {
        aliases.push(abbrev);
      }
    }

    return aliases;
  }

  /**
   * Infer a category from a file path.
   * Looks at directory names to find domain-like segments.
   */
  private inferCategoryFromPath(filePath: string): string | undefined {
    const parts = filePath.split("/").filter(Boolean);

    // Skip common infrastructure directories to find the first "domain" segment
    const skipDirs = new Set([
      "src", "lib", "app", "packages", "modules", "components",
      "pages", "views", "controllers", "services", "models",
      "utils", "helpers", "common", "shared",
    ]);

    for (const part of parts) {
      const lower = part.toLowerCase();
      if (!skipDirs.has(lower) && !lower.includes(".")) {
        return part;
      }
    }

    return undefined;
  }

  // ─── Private: Mapping Candidates to Code Locations ──────────────

  /**
   * Convert mapping candidates into CodeLocation objects for storage.
   */
  private candidatesToCodeLocations(candidates: MappingCandidate[]): CodeLocation[] {
    return candidates.map((c) => ({
      filePath: c.filePath,
      symbol: c.conceptName,
      relationship: c.suggestedRelationship as CodeRelationship,
      note: `Auto-mapped with ${(c.confidence * 100).toFixed(0)}% confidence via ${c.matchStrategies.join(", ")}`,
    }));
  }
}
