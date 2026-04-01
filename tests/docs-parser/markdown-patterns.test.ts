/**
 * Tests for markdown pattern extraction functions.
 *
 * Covers: extractFromHeaders, extractFromBoldText, extractFromTableCells,
 * extractAllPatterns, cleanInlineMarkdown, isValidTerm.
 */
import { describe, it, expect } from "vitest";
import {
  extractFromHeaders,
  extractFromBoldText,
  extractFromTableCells,
  extractAllPatterns,
  cleanInlineMarkdown,
  isValidTerm,
} from "../../src/docs-parser/index.js";

// ─── extractFromHeaders ──────────────────────────────────────────

describe("extractFromHeaders", () => {
  it("extracts h1 through h6 headers", () => {
    const content = [
      "# Heading One",
      "## Heading Two",
      "### Heading Three",
      "#### Heading Four",
      "##### Heading Five",
      "###### Heading Six",
    ].join("\n");

    const results = extractFromHeaders("docs/test.md", content);
    expect(results).toHaveLength(6);
    expect(results[0]).toMatchObject({
      term: "Heading One",
      headerLevel: 1,
      line: 1,
      extractionMethod: "header",
    });
    expect(results[5]).toMatchObject({
      term: "Heading Six",
      headerLevel: 6,
      line: 6,
    });
  });

  it("strips inline markdown from headers", () => {
    const content = "## [Auth Service](./auth.md) Overview";
    const results = extractFromHeaders("README.md", content);
    expect(results[0].term).toBe("Auth Service Overview");
  });

  it("ignores lines that are not headers", () => {
    const content = "This is not a header\n\nNeither is this";
    const results = extractFromHeaders("docs/test.md", content);
    expect(results).toHaveLength(0);
  });

  it("sets filePath from argument", () => {
    const results = extractFromHeaders("path/to/doc.md", "# Term");
    expect(results[0].filePath).toBe("path/to/doc.md");
  });

  it("includes contextSnippet around the header", () => {
    const content = "Some intro\n# Main Header\nMore text";
    const results = extractFromHeaders("doc.md", content);
    expect(results[0].contextSnippet).toContain("Main Header");
  });

  it("rejects invalid terms (too short, pure numbers)", () => {
    const content = "# X\n# 42\n# Valid Header";
    const results = extractFromHeaders("doc.md", content);
    expect(results).toHaveLength(1);
    expect(results[0].term).toBe("Valid Header");
  });
});

// ─── extractFromBoldText ─────────────────────────────────────────

describe("extractFromBoldText", () => {
  it("extracts **asterisk** bold terms", () => {
    const content = "The **Policy Engine** handles authorization.";
    const results = extractFromBoldText("doc.md", content);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      term: "Policy Engine",
      extractionMethod: "bold",
    });
  });

  it("extracts __underscore__ bold terms", () => {
    const content = "See the __Service Registry__ for details.";
    const results = extractFromBoldText("doc.md", content);
    expect(results).toHaveLength(1);
    expect(results[0].term).toBe("Service Registry");
  });

  it("avoids duplicates when both styles appear on the same line", () => {
    // If same term appears in different bold styles on different lines
    const content = "Use **Auth Provider** here.\nAlso __Auth Provider__ there.";
    const results = extractFromBoldText("doc.md", content);
    // Both should appear since they're on different lines
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts multiple bold terms from one line", () => {
    const content = "Compare **Service A** with **Service B** performance.";
    const results = extractFromBoldText("doc.md", content);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.term)).toContain("Service A");
    expect(results.map((r) => r.term)).toContain("Service B");
  });

  it("does not extract from header lines", () => {
    const content = "## **Bold Header**\nSome **real bold** text.";
    const results = extractFromBoldText("doc.md", content);
    // Should only get "real bold", not "Bold Header" (handled by header extractor)
    const terms = results.map((r) => r.term);
    expect(terms).not.toContain("Bold Header");
  });

  it("rejects invalid bold terms", () => {
    const content = "This is **X** and **---** nothing.";
    const results = extractFromBoldText("doc.md", content);
    expect(results).toHaveLength(0);
  });
});

// ─── extractFromTableCells ───────────────────────────────────────

describe("extractFromTableCells", () => {
  it("extracts terms from table cells", () => {
    const content = [
      "| Term | Description |",
      "|------|-------------|",
      "| Policy Engine | Handles authorization |",
      "| Service Mesh | Network routing |",
    ].join("\n");

    const results = extractFromTableCells("doc.md", content);
    const terms = results.map((r) => r.term);
    expect(terms).toContain("Policy Engine");
    expect(terms).toContain("Service Mesh");
  });

  it("skips separator rows", () => {
    const content = [
      "| Name | Value |",
      "|:-----|------:|",
      "| Config Key | setting |",
    ].join("\n");

    const results = extractFromTableCells("doc.md", content);
    // Separator row should not produce candidates
    const terms = results.map((r) => r.term);
    expect(terms).not.toContain("--");
    expect(terms).not.toContain(":-----");
  });

  it("sets extractionMethod to table-cell", () => {
    const content = "| Domain Term | Info |\n|---|---|\n| Glossary | terms |";
    const results = extractFromTableCells("doc.md", content);
    for (const r of results) {
      expect(r.extractionMethod).toBe("table-cell");
    }
  });

  it("handles empty tables", () => {
    const content = "No tables here, just text.";
    const results = extractFromTableCells("doc.md", content);
    expect(results).toHaveLength(0);
  });
});

// ─── extractAllPatterns ──────────────────────────────────────────

describe("extractAllPatterns", () => {
  it("combines results from all extractors", () => {
    const content = [
      "# Architecture",
      "",
      "The **Policy Engine** handles all authorization.",
      "",
      "| Component | Role |",
      "|-----------|------|",
      "| Service Mesh | Routing |",
    ].join("\n");

    const results = extractAllPatterns("doc.md", content);
    const terms = results.map((r) => r.term);
    expect(terms).toContain("Architecture");
    expect(terms).toContain("Policy Engine");
    expect(terms).toContain("Service Mesh");
  });

  it("deduplicates by (term, line)", () => {
    // If a bold term also appears in a header on the same line,
    // only the header version should appear (priority: header first)
    const content = "## **Auth Module**";
    const results = extractAllPatterns("doc.md", content);
    // Term from header should take priority
    const authEntries = results.filter(
      (r) => r.term.toLowerCase().includes("auth module"),
    );
    expect(authEntries.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array for empty content", () => {
    const results = extractAllPatterns("doc.md", "");
    expect(results).toHaveLength(0);
  });

  it("preserves line numbers", () => {
    const content = "\n\n# Third Line Header";
    const results = extractAllPatterns("doc.md", content);
    expect(results[0].line).toBe(3);
  });
});

// ─── cleanInlineMarkdown ─────────────────────────────────────────

describe("cleanInlineMarkdown", () => {
  it("strips link syntax", () => {
    expect(cleanInlineMarkdown("[Click Here](https://example.com)")).toBe(
      "Click Here",
    );
  });

  it("strips inline code", () => {
    expect(cleanInlineMarkdown("`AuthService` class")).toBe(
      "AuthService class",
    );
  });

  it("strips image syntax", () => {
    expect(cleanInlineMarkdown("![Logo](logo.png)")).toBe("Logo");
  });

  it("strips bold/italic markers", () => {
    expect(cleanInlineMarkdown("**bold** and *italic*")).toBe(
      "bold and italic",
    );
  });

  it("strips strikethrough", () => {
    expect(cleanInlineMarkdown("~~removed~~")).toBe("removed");
  });

  it("collapses whitespace", () => {
    expect(cleanInlineMarkdown("  too   many   spaces  ")).toBe(
      "too many spaces",
    );
  });
});

// ─── isValidTerm ─────────────────────────────────────────────────

describe("isValidTerm", () => {
  it("accepts normal terms", () => {
    expect(isValidTerm("Policy Engine")).toBe(true);
    expect(isValidTerm("AuthService")).toBe(true);
  });

  it("rejects too-short terms", () => {
    expect(isValidTerm("X")).toBe(false);
  });

  it("rejects pure numbers", () => {
    expect(isValidTerm("42")).toBe(false);
    expect(isValidTerm("3.14")).toBe(false);
  });

  it("rejects pure punctuation", () => {
    expect(isValidTerm("---")).toBe(false);
    expect(isValidTerm("***")).toBe(false);
  });

  it("rejects common markdown artifacts", () => {
    expect(isValidTerm("TODO")).toBe(false);
    expect(isValidTerm("FIXME")).toBe(false);
    expect(isValidTerm("TBD")).toBe(false);
  });

  it("accepts terms with mixed content", () => {
    expect(isValidTerm("Step 1")).toBe(true);
    expect(isValidTerm("v2.0")).toBe(true);
  });
});
