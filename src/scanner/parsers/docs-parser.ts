/**
 * Docs parser for the codebase scanner.
 *
 * Extracts domain term concepts from markdown and plain-text documentation
 * files (.md, .txt). Uses the docs-parser extractors (headers, bold text,
 * table cells) and converts DocsTermCandidate[] to CodeConcept[].
 *
 * Fenced code blocks are stripped before extraction to avoid false positives
 * (e.g., a class name inside a code example being double-counted).
 */

import type {
  CodeConcept,
  CodeConceptKind,
  LanguageParser,
} from "../../types/index.js";
import { extractAllPatterns } from "../../docs-parser/index.js";
import type { ExtractionMethod } from "../../docs-parser/types.js";

/**
 * Build a concept ID from file path and concept name.
 */
function buildId(filePath: string, ...parts: string[]): string {
  const base = filePath.replace(/\\/g, "/");
  if (parts.length === 0) return base;
  return `${base}#${parts.join(".")}`;
}

/**
 * Map extraction method to CodeConceptKind.
 */
const KIND_MAP: Record<ExtractionMethod, CodeConceptKind> = {
  header: "section",
  bold: "term",
  "table-cell": "definition",
};

/**
 * Strip fenced code blocks from markdown content.
 *
 * Replaces lines inside fenced blocks (``` or ~~~) with empty strings
 * to preserve line numbers for accurate source mapping.
 */
export function stripFencedCodeBlocks(content: string): string {
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      lines[i] = "";
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      lines[i] = "";
    }
  }

  return lines.join("\n");
}

/**
 * Parser that extracts domain terms from markdown documentation files.
 */
export class DocsParser implements LanguageParser {
  readonly language = "markdown" as const;
  readonly extensions = [".md", ".txt"];

  parse(filePath: string, content: string): CodeConcept[] {
    const stripped = stripFencedCodeBlocks(content);
    const candidates = extractAllPatterns(filePath, stripped);

    return candidates.map((candidate) => ({
      id: buildId(filePath, candidate.term),
      name: candidate.term,
      kind: KIND_MAP[candidate.extractionMethod],
      filePath: candidate.filePath,
      line: candidate.line,
      description: candidate.contextSnippet,
      exported: true,
      language: this.language,
      metadata: {
        extractionMethod: candidate.extractionMethod,
        ...(candidate.headerLevel != null && {
          headerLevel: candidate.headerLevel,
        }),
      },
    }));
  }
}
