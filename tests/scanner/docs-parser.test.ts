/**
 * Integration tests for DocsParser — the LanguageParser implementation
 * that extracts domain terms from markdown documentation files.
 */
import { describe, it, expect } from "vitest";
import { DocsParser, stripFencedCodeBlocks } from "../../src/scanner/parsers/docs-parser.js";

describe("DocsParser", () => {
  const parser = new DocsParser();

  // ─── LanguageParser contract ────────────────────────────────────

  describe("LanguageParser contract", () => {
    it("declares markdown as language", () => {
      expect(parser.language).toBe("markdown");
    });

    it("handles .md and .txt extensions", () => {
      expect(parser.extensions).toContain(".md");
      expect(parser.extensions).toContain(".txt");
    });

    it("parse returns CodeConcept[]", () => {
      const result = parser.parse("doc.md", "# Hello World");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ─── Kind mapping ──────────────────────────────────────────────

  describe("kind mapping", () => {
    it("maps headers to section kind", () => {
      const result = parser.parse("doc.md", "## Architecture");
      const concept = result.find((c) => c.name === "Architecture");
      expect(concept?.kind).toBe("section");
    });

    it("maps bold text to term kind", () => {
      const result = parser.parse("doc.md", "The **Policy Engine** handles auth.");
      const concept = result.find((c) => c.name === "Policy Engine");
      expect(concept?.kind).toBe("term");
    });

    it("maps table cells to definition kind", () => {
      const content = [
        "| Component | Description |",
        "|-----------|-------------|",
        "| Service Mesh | Handles routing |",
      ].join("\n");
      const result = parser.parse("doc.md", content);
      const concept = result.find((c) => c.name === "Service Mesh");
      expect(concept?.kind).toBe("definition");
    });
  });

  // ─── CodeConcept field mapping ──────────────────────────────────

  describe("CodeConcept fields", () => {
    it("sets id as filePath#termName", () => {
      const result = parser.parse("docs/arch.md", "# Auth Service");
      expect(result[0].id).toBe("docs/arch.md#Auth Service");
    });

    it("normalizes backslashes in id", () => {
      const result = parser.parse("docs\\arch.md", "# Auth Service");
      expect(result[0].id).toBe("docs/arch.md#Auth Service");
    });

    it("sets language to markdown", () => {
      const result = parser.parse("doc.md", "# Topic");
      expect(result[0].language).toBe("markdown");
    });

    it("sets exported to true", () => {
      const result = parser.parse("doc.md", "# Topic");
      expect(result[0].exported).toBe(true);
    });

    it("includes extractionMethod in metadata", () => {
      const result = parser.parse("doc.md", "# Topic");
      expect(result[0].metadata).toHaveProperty("extractionMethod", "header");
    });

    it("includes headerLevel in metadata for headers", () => {
      const result = parser.parse("doc.md", "### Deep Header");
      expect(result[0].metadata).toHaveProperty("headerLevel", 3);
    });

    it("omits headerLevel for non-header concepts", () => {
      const result = parser.parse("doc.md", "A **bold term** here.");
      expect(result[0].metadata).not.toHaveProperty("headerLevel");
    });

    it("sets description from context snippet", () => {
      const result = parser.parse("doc.md", "# Important Topic");
      expect(result[0].description).toBeTruthy();
      expect(result[0].description).toContain("Important Topic");
    });

    it("preserves line numbers", () => {
      const content = "\n\n# Third Line";
      const result = parser.parse("doc.md", content);
      expect(result[0].line).toBe(3);
    });
  });

  // ─── Fenced code block stripping ───────────────────────────────

  describe("fenced code block stripping", () => {
    it("skips terms inside backtick code blocks", () => {
      const content = [
        "# Real Header",
        "",
        "```typescript",
        "# Not A Header",
        "class **PolicyEngine** {",
        "  // This is code, not docs",
        "}",
        "```",
        "",
        "The **Actual Term** is here.",
      ].join("\n");

      const result = parser.parse("doc.md", content);
      const names = result.map((c) => c.name);

      expect(names).toContain("Real Header");
      expect(names).toContain("Actual Term");
      expect(names).not.toContain("Not A Header");
      expect(names).not.toContain("PolicyEngine");
    });

    it("skips terms inside tilde code blocks", () => {
      const content = [
        "# Visible",
        "~~~",
        "## Hidden Header",
        "~~~",
      ].join("\n");

      const result = parser.parse("doc.md", content);
      const names = result.map((c) => c.name);
      expect(names).toContain("Visible");
      expect(names).not.toContain("Hidden Header");
    });

    it("preserves line numbers after code block stripping", () => {
      const content = [
        "# First",           // line 1
        "```",                // line 2
        "# Hidden",           // line 3
        "```",                // line 4
        "# After Block",      // line 5
      ].join("\n");

      const result = parser.parse("doc.md", content);
      const afterBlock = result.find((c) => c.name === "After Block");
      expect(afterBlock?.line).toBe(5);
    });

    it("handles nested-looking code fences gracefully", () => {
      const content = [
        "# Visible",
        "```",
        "some code with ``` in a comment",
        "```",
        "# Also Visible",
      ].join("\n");

      const result = parser.parse("doc.md", content);
      // The inner ``` toggles the state — behavior is deterministic
      // even if edge-case-y. Just verify no crash.
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it("handles file that is only a code block", () => {
      const content = "```\n# Hidden\n```";
      const result = parser.parse("doc.md", content);
      expect(result).toHaveLength(0);
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns empty array for empty content", () => {
      expect(parser.parse("doc.md", "")).toHaveLength(0);
    });

    it("returns empty array for whitespace-only content", () => {
      expect(parser.parse("doc.md", "   \n\n  ")).toHaveLength(0);
    });

    it("handles large mixed document", () => {
      const content = [
        "# Project Overview",
        "",
        "The **Core Engine** drives everything.",
        "",
        "## Components",
        "",
        "| Name | Purpose |",
        "|------|---------|",
        "| Auth Module | Authentication |",
        "| Data Layer | Persistence |",
        "",
        "```python",
        "class CoreEngine:",
        "    pass",
        "```",
        "",
        "### API Surface",
      ].join("\n");

      const result = parser.parse("README.md", content);
      const names = result.map((c) => c.name);

      expect(names).toContain("Project Overview");
      expect(names).toContain("Core Engine");
      expect(names).toContain("Components");
      expect(names).toContain("Auth Module");
      expect(names).toContain("API Surface");
      // Code block content should be excluded
      expect(names).not.toContain("CoreEngine");
    });
  });
});

// ─── stripFencedCodeBlocks unit tests ────────────────────────────

describe("stripFencedCodeBlocks", () => {
  it("replaces code block lines with empty strings", () => {
    const input = "line1\n```\ncode\n```\nline5";
    const result = stripFencedCodeBlocks(input);
    const lines = result.split("\n");
    expect(lines[0]).toBe("line1");
    expect(lines[1]).toBe("");  // opening fence
    expect(lines[2]).toBe("");  // code content
    expect(lines[3]).toBe("");  // closing fence
    expect(lines[4]).toBe("line5");
  });

  it("preserves total line count", () => {
    const input = "a\n```\nb\nc\n```\nd";
    const result = stripFencedCodeBlocks(input);
    expect(result.split("\n").length).toBe(input.split("\n").length);
  });

  it("handles indented code fences", () => {
    const input = "text\n  ```js\n  code\n  ```\nmore text";
    const result = stripFencedCodeBlocks(input);
    const lines = result.split("\n");
    expect(lines[0]).toBe("text");
    expect(lines[2]).toBe("");
    expect(lines[4]).toBe("more text");
  });

  it("returns content unchanged if no code blocks", () => {
    const input = "# Hello\n\nSome text";
    expect(stripFencedCodeBlocks(input)).toBe(input);
  });
});
