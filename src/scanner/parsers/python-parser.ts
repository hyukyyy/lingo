/**
 * Python parser for the codebase scanner.
 *
 * Uses regex-based parsing (no AST dependency) to extract code concepts
 * from .py files. Extracts:
 * - Module (file-level)
 * - Classes (with methods)
 * - Functions (standalone)
 * - Constants (module-level ALL_CAPS assignments)
 */

import { basename, extname } from "node:path";
import type {
  CodeConcept,
  LanguageParser,
  SupportedLanguage,
} from "../../types/index.js";

/**
 * Build a concept ID from file path and concept name.
 */
function buildId(filePath: string, ...parts: string[]): string {
  const base = filePath.replace(/\\/g, "/");
  if (parts.length === 0) return base;
  return `${base}#${parts.join(".")}`;
}

/**
 * Extract the module-level concept for a Python file.
 */
function parseModuleConcept(filePath: string, content: string): CodeConcept {
  const fileName = basename(filePath, extname(filePath));
  const lines = content.split("\n");
  const lineCount = lines.length;

  // Try to find a module-level docstring (triple-quoted string at start)
  let description = `Python module ${fileName}`;
  const docMatch = content.match(/^(?:#[^\n]*\n)*\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  if (docMatch) {
    const docContent = (docMatch[1] || docMatch[2] || "").trim();
    const firstLine = docContent.split("\n")[0].trim();
    if (firstLine) {
      description = firstLine;
    }
  }

  return {
    id: buildId(filePath),
    name: fileName,
    kind: "module",
    filePath,
    line: 1,
    endLine: lineCount,
    description,
    exported: true,
    language: "python",
    metadata: { lineCount },
  };
}

/**
 * Extract class declarations and their methods from Python code.
 */
function parseClasses(filePath: string, content: string): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match class declarations: class Name(bases):
  const classRegex = /^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(classRegex);
    if (!match) continue;

    const className = match[1];
    const bases = match[2]?.trim();
    const startLine = i + 1;

    // Find end of class by looking for next line at same or lower indentation
    const endLine = findPythonBlockEnd(lines, i);

    const classId = buildId(filePath, className);

    // Check for class docstring
    let classDesc = `Class ${className}`;
    if (bases) {
      classDesc = `Class ${className} extending ${bases}`;
    }
    const docstring = extractDocstring(lines, i + 1);
    if (docstring) {
      classDesc = docstring;
    }

    // Determine if the class is "exported" (not prefixed with _)
    const isExported = !className.startsWith("_");

    concepts.push({
      id: classId,
      name: className,
      kind: "class",
      filePath,
      line: startLine,
      endLine,
      description: classDesc,
      parentId: buildId(filePath),
      exported: isExported,
      language: "python",
      metadata: { bases: bases || null },
    });

    // Extract methods within the class
    const methodRegex = /^\s{4}(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/;

    for (let j = i + 1; j < (endLine ?? lines.length); j++) {
      const methodMatch = lines[j].match(methodRegex);
      if (!methodMatch) continue;

      const isAsync = !!methodMatch[1];
      const methodName = methodMatch[2];
      const params = methodMatch[3]?.trim();

      // Check for method docstring
      let methodDesc = `Method ${methodName}`;
      const methodDoc = extractDocstring(lines, j + 1);
      if (methodDoc) {
        methodDesc = methodDoc;
      }

      const isPrivate = methodName.startsWith("_") && !methodName.startsWith("__");
      const isDunder = methodName.startsWith("__") && methodName.endsWith("__");

      concepts.push({
        id: buildId(filePath, className, methodName),
        name: methodName,
        kind: "function",
        filePath,
        line: j + 1,
        description: methodDesc,
        parentId: classId,
        exported: !isPrivate,
        language: "python",
        metadata: {
          isAsync,
          isMethod: true,
          isPrivate,
          isDunder,
          params: params || null,
        },
      });
    }
  }

  return concepts;
}

/**
 * Extract standalone function declarations.
 */
function parseFunctions(filePath: string, content: string): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match top-level function declarations (not indented = not methods)
  const funcRegex = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(funcRegex);
    if (!match) continue;

    const isAsync = !!match[1];
    const funcName = match[2];
    const params = match[3]?.trim();
    const endLine = findPythonBlockEnd(lines, i);

    // Check for docstring
    let description = `Function ${funcName}`;
    const docstring = extractDocstring(lines, i + 1);
    if (docstring) {
      description = docstring;
    }

    const isPrivate = funcName.startsWith("_");

    concepts.push({
      id: buildId(filePath, funcName),
      name: funcName,
      kind: "function",
      filePath,
      line: i + 1,
      endLine,
      description,
      parentId: buildId(filePath),
      exported: !isPrivate,
      language: "python",
      metadata: {
        isAsync,
        isMethod: false,
        isPrivate,
        params: params || null,
      },
    });
  }

  return concepts;
}

/**
 * Extract module-level constants (ALL_CAPS names).
 */
function parseConstants(filePath: string, content: string): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match module-level ALL_CAPS assignments
  const constRegex = /^([A-Z][A-Z0-9_]+)\s*[=:]/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(constRegex);
    if (!match) continue;

    const name = match[1];

    concepts.push({
      id: buildId(filePath, name),
      name,
      kind: "constant",
      filePath,
      line: i + 1,
      description: `Constant ${name}`,
      parentId: buildId(filePath),
      exported: true,
      language: "python",
      metadata: {},
    });
  }

  return concepts;
}

/**
 * Find the end of a Python block using indentation.
 */
function findPythonBlockEnd(
  lines: string[],
  startIndex: number
): number | undefined {
  // Get the indentation of the starting line
  const startIndent = lines[startIndex].match(/^(\s*)/)?.[1].length ?? 0;

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= startIndent) {
      return i; // 1-indexed would be i, but we want the line before
    }
  }

  return lines.length;
}

/**
 * Extract a docstring from the line after a definition.
 */
function extractDocstring(
  lines: string[],
  startIndex: number
): string | null {
  if (startIndex >= lines.length) return null;

  const line = lines[startIndex].trim();

  // Single-line docstring: """text""" or '''text'''
  const singleMatch = line.match(/^(?:"""(.+?)"""|'''(.+?)''')/);
  if (singleMatch) {
    return (singleMatch[1] || singleMatch[2] || "").trim();
  }

  // Multi-line docstring opening
  if (line.startsWith('"""') || line.startsWith("'''")) {
    const quote = line.slice(0, 3);
    const firstLineContent = line.slice(3).trim();

    // Look for closing quote
    for (let i = startIndex; i < Math.min(startIndex + 20, lines.length); i++) {
      if (i === startIndex) continue;
      if (lines[i].trim().endsWith(quote)) {
        // Return first meaningful line
        return firstLineContent || lines[startIndex + 1]?.trim() || null;
      }
    }
  }

  return null;
}

/**
 * Python language parser implementation.
 */
export class PythonParser implements LanguageParser {
  language: SupportedLanguage = "python";
  extensions = [".py"];

  parse(filePath: string, content: string): CodeConcept[] {
    const concepts: CodeConcept[] = [];

    // Module-level concept
    concepts.push(parseModuleConcept(filePath, content));

    // Extract all concept kinds
    concepts.push(...parseClasses(filePath, content));
    concepts.push(...parseFunctions(filePath, content));
    concepts.push(...parseConstants(filePath, content));

    // Deduplicate by ID
    const seen = new Set<string>();
    return concepts.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }
}
