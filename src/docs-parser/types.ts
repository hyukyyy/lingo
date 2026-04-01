/**
 * Types for the local document scanner (feature 6.2).
 *
 * Defines the term candidate structure produced when scanning
 * local .md and .txt files for organizational terminology.
 * Candidates are passed unfiltered to the bootstrap orchestrator
 * for mapping against code concepts.
 */

// ─── Extraction Method ──────────────────────────────────────────────

/**
 * Which markdown structure pattern identified a term candidate.
 *
 * - "header": extracted from a markdown header (# H1 through ###### H6)
 * - "bold": extracted from bold/strong emphasis (**text** or __text__)
 * - "table-cell": extracted from a markdown table cell (| cell |)
 */
export type ExtractionMethod = "header" | "bold" | "table-cell";

// ─── Docs Term Candidate ───────────────────────────────────────────

/**
 * A term candidate extracted from a local document.
 *
 * This is the raw output of the markdown pattern extractors — analogous
 * to PMTermCandidate but sourced from local .md/.txt files rather than
 * a PM tool API.
 *
 * All candidates are passed unfiltered to downstream consumers;
 * no confidence threshold is applied at the extraction stage.
 */
export interface DocsTermCandidate {
  /** The extracted term text, trimmed and cleaned */
  term: string;

  /** Source file path (relative to project root) */
  filePath: string;

  /** Line number where the term was found (1-indexed) */
  line: number;

  /** Which extraction pattern identified this term */
  extractionMethod: ExtractionMethod;

  /** Surrounding context for definition inference */
  contextSnippet: string;

  /** Header level (1–6) when extractionMethod is "header" */
  headerLevel?: number;
}

// ─── Docs Scan Options ─────────────────────────────────────────────

/**
 * Options controlling local document scanning.
 */
export interface DocsScanOptions {
  /** Absolute path to the project root directory */
  rootDir: string;

  /** Glob patterns for documents to include (default: ["**\/*.md", "**\/*.txt"]) */
  include?: string[];

  /** Glob patterns to exclude (default: node_modules, .git, etc.) */
  exclude?: string[];

  /** Maximum file size in bytes to scan (default: 512KB) */
  maxFileSize?: number;
}

// ─── Docs Scan Result ──────────────────────────────────────────────

/**
 * Result of scanning local documents for term candidates.
 */
export interface DocsScanResult {
  /** All extracted term candidates */
  candidates: DocsTermCandidate[];

  /** Number of files scanned */
  filesScanned: number;

  /** Number of files skipped (too large, unreadable, etc.) */
  filesSkipped: number;

  /** Duration of the scan in milliseconds */
  durationMs: number;

  /** Any warnings encountered during scanning */
  warnings: string[];
}
