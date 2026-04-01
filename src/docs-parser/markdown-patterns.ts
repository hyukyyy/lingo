/**
 * Markdown Structure Pattern Extractors
 *
 * Regex-based lightweight extractors that identify term candidates from
 * markdown document structures: headers, bold text, and table cells.
 * Follows the same regex-based approach as the TypeScript and Python
 * parsers — no AST dependency, no external markdown library.
 *
 * Each extractor operates on raw file content and produces
 * DocsTermCandidate objects with source location metadata.
 * All candidates are emitted unfiltered — no confidence thresholds.
 *
 * Extractors:
 *   extractFromHeaders    — # H1 through ###### H6
 *   extractFromBoldText   — **bold** and __bold__
 *   extractFromTableCells — | cell | cell |
 *   extractAllPatterns    — runs all three and deduplicates
 */

import type { DocsTermCandidate } from "./types.js";

// ─── Constants ─────────────────────────────────────────────────────

/**
 * Minimum length for a term candidate to be considered meaningful.
 * Single characters and very short strings are noise, not terms.
 */
const MIN_TERM_LENGTH = 2;

/**
 * Maximum length for a term candidate. Extremely long strings are
 * likely paragraphs accidentally captured, not discrete terms.
 */
const MAX_TERM_LENGTH = 100;

/**
 * Number of context lines to capture around an extracted term
 * (before and after the line containing the term).
 */
const CONTEXT_LINES = 1;

// ─── Header Extraction ────────────────────────────────────────────

/**
 * Regex matching ATX-style markdown headers (# through ######).
 * Captures:
 *   [1] = the '#' characters (length determines heading level)
 *   [2] = the header text content
 *
 * Handles optional trailing '#' characters and whitespace.
 */
const HEADER_REGEX = /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/;

/**
 * Extract term candidates from markdown headers.
 *
 * Headers represent structural organization of a document and frequently
 * contain domain terminology (feature names, component names, concepts).
 * The header level provides hierarchy context.
 *
 * @param filePath - Relative path to the document
 * @param content - Raw file content
 * @returns Array of term candidates from headers
 */
export function extractFromHeaders(
  filePath: string,
  content: string,
): DocsTermCandidate[] {
  const candidates: DocsTermCandidate[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(HEADER_REGEX);
    if (!match) continue;

    const headerLevel = match[1].length;
    const rawText = match[2].trim();

    // Clean markdown inline formatting from the header text
    const term = cleanInlineMarkdown(rawText);

    if (!isValidTerm(term)) continue;

    candidates.push({
      term,
      filePath,
      line: i + 1,
      extractionMethod: "header",
      contextSnippet: buildContextSnippet(lines, i),
      headerLevel,
    });
  }

  return candidates;
}

// ─── Bold Text Extraction ─────────────────────────────────────────

/**
 * Regex matching bold/strong emphasis in markdown.
 * Handles both **asterisk** and __underscore__ styles.
 * Uses non-greedy matching to avoid spanning across multiple bold regions.
 *
 * Global flag required to find all matches on a single line.
 */
const BOLD_ASTERISK_REGEX = /\*\*(.+?)\*\*/g;
const BOLD_UNDERSCORE_REGEX = /__(.+?)__/g;

/**
 * Extract term candidates from bold/strong-emphasis text.
 *
 * Bold text in planning documents often highlights key terms,
 * feature names, or important concepts. These are strong signals
 * that the emphasized text represents organizational terminology.
 *
 * @param filePath - Relative path to the document
 * @param content - Raw file content
 * @returns Array of term candidates from bold text
 */
export function extractFromBoldText(
  filePath: string,
  content: string,
): DocsTermCandidate[] {
  const candidates: DocsTermCandidate[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines that are headers — headers are handled by extractFromHeaders
    if (HEADER_REGEX.test(line)) continue;

    // Extract **asterisk** bold
    for (const match of line.matchAll(BOLD_ASTERISK_REGEX)) {
      const term = cleanInlineMarkdown(match[1].trim());
      if (!isValidTerm(term)) continue;

      candidates.push({
        term,
        filePath,
        line: i + 1,
        extractionMethod: "bold",
        contextSnippet: buildContextSnippet(lines, i),
      });
    }

    // Extract __underscore__ bold
    for (const match of line.matchAll(BOLD_UNDERSCORE_REGEX)) {
      const term = cleanInlineMarkdown(match[1].trim());
      if (!isValidTerm(term)) continue;

      // Avoid duplicates when same text is bold via both styles on same line
      if (candidates.some(
        (c) => c.line === i + 1 && c.term === term && c.extractionMethod === "bold",
      )) {
        continue;
      }

      candidates.push({
        term,
        filePath,
        line: i + 1,
        extractionMethod: "bold",
        contextSnippet: buildContextSnippet(lines, i),
      });
    }
  }

  return candidates;
}

// ─── Table Cell Extraction ────────────────────────────────────────

/**
 * Regex matching a markdown table row (line starting/ending with |).
 * We split cells by the pipe character and extract each cell's content.
 */
const TABLE_ROW_REGEX = /^\s*\|(.+)\|\s*$/;

/**
 * Regex matching a markdown table separator row (e.g., |---|---|).
 * These rows define column alignment and should be skipped.
 */
const TABLE_SEPARATOR_REGEX = /^\s*\|[\s:]*-+[\s:]*(?:\|[\s:]*-+[\s:]*)*\|\s*$/;

/**
 * Extract term candidates from markdown table cells.
 *
 * Tables in planning documents frequently contain structured terminology:
 * glossary tables, feature lists, requirement matrices, API endpoint tables.
 * Each non-empty, non-separator cell is a potential term candidate.
 *
 * @param filePath - Relative path to the document
 * @param content - Raw file content
 * @returns Array of term candidates from table cells
 */
export function extractFromTableCells(
  filePath: string,
  content: string,
): DocsTermCandidate[] {
  const candidates: DocsTermCandidate[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Must look like a table row
    if (!TABLE_ROW_REGEX.test(line)) continue;

    // Skip separator rows (|---|---|)
    if (TABLE_SEPARATOR_REGEX.test(line)) continue;

    // Split into cells and process each one
    const cells = line
      .replace(/^\s*\|/, "")   // Remove leading pipe
      .replace(/\|\s*$/, "")   // Remove trailing pipe
      .split("|");

    for (const cell of cells) {
      const term = cleanInlineMarkdown(cell.trim());

      if (!isValidTerm(term)) continue;

      candidates.push({
        term,
        filePath,
        line: i + 1,
        extractionMethod: "table-cell",
        contextSnippet: buildContextSnippet(lines, i),
      });
    }
  }

  return candidates;
}

// ─── Combined Extraction ──────────────────────────────────────────

/**
 * Run all pattern extractors on a document and return deduplicated
 * candidates. Deduplication is by (term, line) pair — the same term
 * on the same line from different extractors is kept only once,
 * preferring header > bold > table-cell priority.
 *
 * @param filePath - Relative path to the document
 * @param content - Raw file content
 * @returns Array of deduplicated term candidates from all patterns
 */
export function extractAllPatterns(
  filePath: string,
  content: string,
): DocsTermCandidate[] {
  const headerCandidates = extractFromHeaders(filePath, content);
  const boldCandidates = extractFromBoldText(filePath, content);
  const tableCandidates = extractFromTableCells(filePath, content);

  // Merge with deduplication by (term, line)
  const seen = new Set<string>();
  const all: DocsTermCandidate[] = [];

  // Priority order: headers first, then bold, then table cells
  for (const candidate of [...headerCandidates, ...boldCandidates, ...tableCandidates]) {
    const key = `${candidate.term.toLowerCase()}:${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(candidate);
  }

  return all;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Remove inline markdown formatting from extracted text.
 * Strips: links, inline code, images, italic markers, strikethrough.
 */
export function cleanInlineMarkdown(text: string): string {
  return text
    // Remove image syntax: ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Remove link syntax: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Remove inline code: `code` → code
    .replace(/`([^`]+)`/g, "$1")
    // Remove remaining bold/italic markers
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    // Remove strikethrough: ~~text~~ → text
    .replace(/~~([^~]+)~~/g, "$1")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether a string is a valid term candidate.
 *
 * Filters out:
 * - Too short (< MIN_TERM_LENGTH characters)
 * - Too long (> MAX_TERM_LENGTH characters)
 * - Pure numeric values
 * - Pure punctuation/symbols
 * - Common markdown artifacts
 */
export function isValidTerm(text: string): boolean {
  if (text.length < MIN_TERM_LENGTH || text.length > MAX_TERM_LENGTH) {
    return false;
  }

  // Reject pure numbers (e.g., "42", "3.14")
  if (/^\d+(\.\d+)?$/.test(text)) {
    return false;
  }

  // Reject pure punctuation/symbols
  if (/^[^a-zA-Z0-9]+$/.test(text)) {
    return false;
  }

  // Reject common non-term markdown artifacts
  const artifacts = ["---", "***", "___", "...", "TODO", "FIXME", "NOTE", "TBD"];
  if (artifacts.includes(text.toUpperCase())) {
    return false;
  }

  return true;
}

/**
 * Build a context snippet around a given line index.
 * Returns the line itself plus surrounding lines for context.
 */
function buildContextSnippet(lines: string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - CONTEXT_LINES);
  const end = Math.min(lines.length, lineIndex + CONTEXT_LINES + 1);

  return lines
    .slice(start, end)
    .join("\n")
    .trim();
}
