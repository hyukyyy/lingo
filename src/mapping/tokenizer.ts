/**
 * Tokenizer — Text normalization and tokenization for the mapping engine.
 *
 * Breaks identifiers (camelCase, PascalCase, snake_case, kebab-case),
 * file paths, and natural language text into normalized lowercase tokens
 * for comparison. This is the foundation of the heuristic matching
 * strategies used to map PM terms to code concepts.
 */

import { basename, extname } from "node:path";

// ─── Stop Words ─────────────────────────────────────────────────────

/**
 * Common English stop words that carry little semantic meaning.
 * Filtered out during sentence tokenization.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
  "from", "had", "has", "have", "he", "her", "his", "how", "i",
  "if", "in", "into", "is", "it", "its", "let", "may", "my",
  "no", "nor", "not", "of", "on", "or", "our", "own",
  "say", "she", "so", "some", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "too",
  "up", "us", "was", "we", "were", "what", "when", "which",
  "who", "whom", "why", "will", "with", "would", "you", "your",
]);

/**
 * Common directory names in codebases that carry little semantic signal
 * for term matching (too generic).
 */
const GENERIC_PATH_SEGMENTS = new Set([
  "src", "lib", "dist", "build", "out", "bin", "test", "tests",
  "spec", "specs", "__tests__", "__mocks__", "node_modules",
  "vendor", "packages", "apps", "components", "utils", "helpers",
  "common", "shared", "core", "internal", "public", "private",
  "assets", "static", "config", "configs",
]);

/** Minimum token length to keep (single-char tokens are noise) */
const MIN_TOKEN_LENGTH = 2;

// ─── Core Tokenization ──────────────────────────────────────────────

/**
 * Universal tokenizer: detects the input type and tokenizes accordingly.
 * Handles camelCase, PascalCase, snake_case, kebab-case, and plain text.
 *
 * @param input - A string to tokenize (identifier, sentence, or mixed)
 * @returns Array of lowercase tokens, filtered for minimum length
 */
export function tokenize(input: string): string[] {
  if (!input || input.trim().length === 0) {
    return [];
  }

  // Split on common separators: spaces, underscores, dashes, dots, slashes
  const roughTokens = input
    .split(/[\s_\-./\\]+/)
    .filter((s) => s.length > 0);

  const result: string[] = [];

  for (const token of roughTokens) {
    // Further split camelCase/PascalCase
    const subTokens = splitCamelCase(token);
    for (const sub of subTokens) {
      const lower = sub.toLowerCase();
      if (lower.length >= MIN_TOKEN_LENGTH) {
        result.push(lower);
      }
    }
  }

  return result;
}

/**
 * Tokenize a code identifier (function name, class name, variable name).
 * Handles camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE.
 *
 * @param identifier - A code identifier to tokenize
 * @returns Array of lowercase tokens
 */
export function tokenizeIdentifier(identifier: string): string[] {
  return tokenize(identifier);
}

/**
 * Tokenize a file path, extracting meaningful directory and file name tokens.
 * Filters out common generic directory names and file extensions.
 *
 * @param filePath - A relative file path (e.g., "src/auth/auth-service.ts")
 * @returns Array of lowercase tokens from the path
 */
export function tokenizeFilePath(filePath: string): string[] {
  // Remove extension
  const ext = extname(filePath);
  const withoutExt = ext ? filePath.slice(0, -ext.length) : filePath;

  // Split path into segments
  const segments = withoutExt.split(/[/\\]/).filter((s) => s.length > 0);

  const result: string[] = [];

  for (const segment of segments) {
    // Skip generic directory names
    if (GENERIC_PATH_SEGMENTS.has(segment.toLowerCase())) {
      continue;
    }

    // Tokenize each segment (handles kebab-case, camelCase, etc.)
    const tokens = tokenize(segment);
    result.push(...tokens);
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  return result.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

/**
 * Tokenize a natural language sentence/paragraph.
 * Splits on whitespace and punctuation, filters stop words,
 * and returns meaningful content tokens.
 *
 * @param text - Natural language text to tokenize
 * @returns Array of lowercase content tokens (stop words removed)
 */
export function tokenizeSentence(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // Remove punctuation, split on whitespace
  const words = text
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const result: string[] = [];

  for (const word of words) {
    const lower = word.toLowerCase();

    // Skip stop words
    if (STOP_WORDS.has(lower)) continue;

    // Skip very short tokens
    if (lower.length < MIN_TOKEN_LENGTH) continue;

    result.push(lower);
  }

  return result;
}

// ─── Comparison Utilities ───────────────────────────────────────────

/**
 * Compute the Jaccard-like overlap between two token arrays.
 * Uses the intersection-over-union formula for a symmetric similarity score.
 *
 * @param tokensA - First token array
 * @param tokensB - Second token array
 * @returns A score between 0.0 (no overlap) and 1.0 (identical)
 */
export function computeTokenOverlap(
  tokensA: string[],
  tokensB: string[]
): number {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  if (intersection === 0) return 0;

  // Union = |A| + |B| - |intersection|
  const union = setA.size + setB.size - intersection;

  return intersection / union;
}

/**
 * Normalize a string for simple exact comparison.
 * Lowercases, trims, removes special characters (except spaces),
 * strips underscores/dashes (common code separators), and collapses whitespace.
 *
 * @param input - Raw string to normalize
 * @returns Normalized string suitable for exact comparison
 */
export function normalizeForComparison(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[_\-]/g, " ")   // Convert underscores and dashes to spaces FIRST
    .replace(/[^\w\s]/g, "")  // Then remove remaining special chars
    .replace(/\s+/g, " ")     // Collapse whitespace
    .trim();
}

/**
 * Compute partial/prefix-aware token overlap.
 * Like computeTokenOverlap but also counts partial matches where
 * one token is a prefix of another (e.g., "auth" matches "authentication").
 *
 * @param tokensA - First token array
 * @param tokensB - Second token array
 * @param prefixWeight - How much weight to give prefix matches (0.0-1.0, default 0.6)
 * @returns A score between 0.0 and 1.0
 */
export function computePartialTokenOverlap(
  tokensA: string[],
  tokensB: string[],
  prefixWeight: number = 0.7
): number {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  // Score A→B: how well are A's tokens covered by B?
  const scoreAB = computeDirectionalPartialScore(setA, setB, prefixWeight);

  // Score B→A: how well are B's tokens covered by A?
  const scoreBA = computeDirectionalPartialScore(setB, setA, prefixWeight);

  // Return the geometric mean of both directions (balanced coverage)
  // But if one direction has zero coverage, fall back to max
  if (scoreAB === 0 || scoreBA === 0) {
    return Math.max(scoreAB, scoreBA) * 0.7; // Penalty for one-directional match
  }

  return Math.sqrt(scoreAB * scoreBA);
}

/**
 * Compute how well source tokens are covered by target tokens,
 * allowing partial (prefix) matches.
 */
function computeDirectionalPartialScore(
  source: Set<string>,
  target: Set<string>,
  prefixWeight: number
): number {
  if (source.size === 0) return 0;

  let matchScore = 0;

  for (const tokenA of source) {
    // Check exact match first
    if (target.has(tokenA)) {
      matchScore += 1.0;
      continue;
    }

    // Check prefix match: shorter is prefix of longer
    let bestPartialScore = 0;
    for (const tokenB of target) {
      if (tokenA.length >= 3 && tokenB.length >= 3) {
        if (tokenB.startsWith(tokenA) || tokenA.startsWith(tokenB)) {
          const shorter = Math.min(tokenA.length, tokenB.length);
          const longer = Math.max(tokenA.length, tokenB.length);
          const prefixScore = (shorter / longer) * prefixWeight;
          bestPartialScore = Math.max(bestPartialScore, prefixScore);
        }
      }
    }
    matchScore += bestPartialScore;
  }

  return matchScore / source.size;
}

// ─── Internal Helpers ───────────────────────────────────────────────

/**
 * Split a camelCase or PascalCase string into component words.
 *
 * Examples:
 * - "authService" → ["auth", "Service"]
 * - "HTTPClient" → ["HTTP", "Client"]
 * - "parseJSONData" → ["parse", "JSON", "Data"]
 * - "simpleWord" → ["simple", "Word"]
 *
 * @param str - A camelCase/PascalCase string
 * @returns Array of unsplit word components
 */
function splitCamelCase(str: string): string[] {
  if (!str) return [];

  // Handle the case where the entire string is uppercase (e.g., "HTTP", "URL")
  if (str === str.toUpperCase() && str.length > 0) {
    return [str];
  }

  // Split on transitions:
  // 1. lowercase → uppercase: "auth" | "Service"
  // 2. uppercase run → uppercase + lowercase: "HTTP" | "Client"
  // 3. digits: separate number runs
  const parts = str
    .replace(/([a-z])([A-Z])/g, "$1\0$2")           // camelCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")     // acronym split
    .replace(/([a-zA-Z])(\d)/g, "$1\0$2")            // letter-to-digit
    .replace(/(\d)([a-zA-Z])/g, "$1\0$2")            // digit-to-letter
    .split("\0");

  return parts.filter((p) => p.length > 0);
}
