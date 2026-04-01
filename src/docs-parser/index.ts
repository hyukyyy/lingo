/**
 * Local Document Scanner (feature 6.2)
 *
 * Scans local .md and .txt files for organizational terminology using
 * regex-based pattern extractors. Produces term candidates that can be
 * fed into the bootstrap orchestrator for code mapping.
 */

export type {
  DocsTermCandidate,
  ExtractionMethod,
  DocsScanOptions,
  DocsScanResult,
} from "./types.js";

export {
  extractFromHeaders,
  extractFromBoldText,
  extractFromTableCells,
  extractAllPatterns,
  cleanInlineMarkdown,
  isValidTerm,
} from "./markdown-patterns.js";
