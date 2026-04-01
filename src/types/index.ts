/**
 * Core types for the Lingo codebase scanner.
 *
 * These types define the structured inventory that the scanner produces
 * when analyzing a codebase — mapping code locations to semantic concepts
 * that can later be linked to organizational planning terminology.
 */

// ─── Code Concept Types ───────────────────────────────────────────────

/**
 * The kind of code element discovered during scanning.
 */
export type CodeConceptKind =
  | "module"       // A file-level module (e.g., a .ts, .py, .js file)
  | "class"        // A class declaration
  | "function"     // A standalone function or method
  | "interface"    // An interface or type alias (TS-specific)
  | "enum"         // An enum declaration
  | "constant"     // A top-level constant or exported variable
  | "directory"    // A directory in the project structure
  | "namespace"    // A namespace or package grouping
  | "section"      // A document section heading (from markdown headers)
  | "term"         // A highlighted term (from bold text in docs)
  | "definition";  // A structured definition (from table cells in docs)

/**
 * A single code concept extracted from the codebase.
 * This is the atomic unit of the scanner's output.
 */
export interface CodeConcept {
  /** Unique identifier for this concept (e.g., "src/auth/AuthService.login") */
  id: string;

  /** Human-readable name (e.g., "login", "AuthService", "utils") */
  name: string;

  /** What kind of code element this is */
  kind: CodeConceptKind;

  /** File path relative to the project root */
  filePath: string;

  /** Line number where the concept starts (1-indexed), if applicable */
  line?: number;

  /** Line number where the concept ends (1-indexed), if applicable */
  endLine?: number;

  /** Auto-generated description of what this concept likely does */
  description: string;

  /** The parent concept's ID (e.g., a method's parent class) */
  parentId?: string;

  /** Export visibility */
  exported: boolean;

  /** Language of the source file */
  language: SupportedLanguage;

  /** Additional metadata extracted from the code */
  metadata: Record<string, unknown>;
}

// ─── Language Support ─────────────────────────────────────────────────

/**
 * Languages the scanner can parse.
 * Extensible — new parsers can be added for each language.
 */
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "markdown"
  | "unknown";

// ─── Scanner Configuration ────────────────────────────────────────────

/**
 * Configuration for a scan operation.
 */
export interface ScanConfig {
  /** Absolute path to the project root directory */
  rootDir: string;

  /** Glob patterns to include (default: all supported extensions) */
  include?: string[];

  /** Glob patterns to exclude (default: node_modules, dist, .git, etc.) */
  exclude?: string[];

  /** Maximum directory depth to traverse (default: 20) */
  maxDepth?: number;

  /** Maximum file size in bytes to parse (default: 1MB) */
  maxFileSize?: number;

  /** Whether to include directory concepts in the output */
  includeDirectories?: boolean;
}

/**
 * Default patterns to exclude from scanning.
 */
export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  "coverage",
  ".cache",
  ".turbo",
  ".output",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

/**
 * Default include patterns by language.
 */
export const DEFAULT_INCLUDE_PATTERNS: string[] = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.py",
  "**/*.md",
];

// ─── Scan Results ─────────────────────────────────────────────────────

/**
 * Statistics about a completed scan.
 */
export interface ScanStats {
  /** Total files discovered */
  filesDiscovered: number;

  /** Files actually parsed (after filtering) */
  filesParsed: number;

  /** Files skipped due to size or error */
  filesSkipped: number;

  /** Total concepts extracted */
  conceptsExtracted: number;

  /** Breakdown by concept kind */
  conceptsByKind: Record<CodeConceptKind, number>;

  /** Breakdown by language */
  conceptsByLanguage: Record<SupportedLanguage, number>;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * The complete result of a codebase scan.
 * This is the structured inventory that downstream components consume.
 */
export interface ScanResult {
  /** The root directory that was scanned */
  rootDir: string;

  /** ISO timestamp of when the scan completed */
  scannedAt: string;

  /** All extracted code concepts */
  concepts: CodeConcept[];

  /** Scan statistics */
  stats: ScanStats;

  /** Any errors or warnings encountered during scanning */
  diagnostics: ScanDiagnostic[];
}

/**
 * A diagnostic message from the scanner (warning or error).
 */
export interface ScanDiagnostic {
  level: "warning" | "error";
  filePath: string;
  message: string;
}

// ─── Parser Interface ─────────────────────────────────────────────────

/**
 * Interface that language-specific parsers must implement.
 * Follows the adapter pattern — each language gets its own parser.
 */
export interface LanguageParser {
  /** Which language this parser handles */
  language: SupportedLanguage;

  /** File extensions this parser can handle */
  extensions: string[];

  /**
   * Parse a single file and extract code concepts.
   *
   * @param filePath - Relative path from project root
   * @param content - The file's text content
   * @returns Array of extracted code concepts
   */
  parse(filePath: string, content: string): CodeConcept[];
}
