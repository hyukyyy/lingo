/**
 * TypeScript/JavaScript parser for the codebase scanner.
 *
 * Uses regex-based parsing (no AST dependency) to extract code concepts
 * from .ts, .tsx, .js, and .jsx files. This keeps the scanner lightweight
 * and dependency-free while catching the most important code structures.
 *
 * Extracted concepts:
 * - Module (file-level)
 * - Classes (with methods)
 * - Functions (standalone, exported)
 * - Interfaces and type aliases
 * - Enums
 * - Exported constants
 */

import { basename, extname } from "node:path";
import type {
  CodeConcept,
  LanguageParser,
  SupportedLanguage,
} from "../../types/index.js";

/**
 * Generate a human-readable description for a code concept based on its
 * name, kind, and context clues.
 */
function generateDescription(
  name: string,
  kind: CodeConcept["kind"],
  context: { isExported: boolean; isAsync: boolean; isDefault: boolean; params?: string }
): string {
  const visibility = context.isExported ? "Exported" : "Internal";
  const asyncPrefix = context.isAsync ? "async " : "";

  switch (kind) {
    case "class":
      return `${visibility} class ${name}`;
    case "function": {
      const paramInfo = context.params ? ` with parameters (${context.params})` : "";
      return `${visibility} ${asyncPrefix}function ${name}${paramInfo}`;
    }
    case "interface":
      return `${visibility} interface defining the shape of ${name}`;
    case "enum":
      return `${visibility} enum ${name}`;
    case "constant":
      return `${visibility} constant ${name}`;
    default:
      return `${kind} ${name}`;
  }
}

/**
 * Build a concept ID from file path and concept name.
 */
function buildId(filePath: string, ...parts: string[]): string {
  const base = filePath.replace(/\\/g, "/");
  if (parts.length === 0) return base;
  return `${base}#${parts.join(".")}`;
}

/**
 * Extract the module-level concept for a file.
 */
function parseModuleConcept(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept {
  const fileName = basename(filePath, extname(filePath));
  const lineCount = content.split("\n").length;

  // Try to find a file-level doc comment (first JSDoc or leading comment)
  let description = `Module ${fileName}`;
  const docMatch = content.match(/^\/\*\*\s*\n([\s\S]*?)\*\//);
  if (docMatch) {
    const docLines = docMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l.length > 0 && !l.startsWith("@"));
    if (docLines.length > 0) {
      description = docLines[0];
    }
  }

  // Detect if it has any exports
  const hasExports = /\bexport\b/.test(content);

  return {
    id: buildId(filePath),
    name: fileName,
    kind: "module",
    filePath,
    line: 1,
    endLine: lineCount,
    description,
    exported: hasExports,
    language,
    metadata: { lineCount },
  };
}

/**
 * Extract class declarations and their methods.
 */
function parseClasses(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match class declarations: export? (abstract)? class Name (extends/implements)?
  const classRegex =
    /^(\s*)(export\s+)?(export\s+default\s+)?(abstract\s+)?class\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(classRegex);
    if (!match) continue;

    const isExported = !!(match[2] || match[3]);
    const isDefault = !!match[3];
    const isAbstract = !!match[4];
    const className = match[5];
    const startLine = i + 1;

    // Find the end of the class by tracking brace depth
    const endLine = findBlockEnd(lines, i);

    const classId = buildId(filePath, className);

    concepts.push({
      id: classId,
      name: className,
      kind: "class",
      filePath,
      line: startLine,
      endLine,
      description: generateDescription(className, "class", {
        isExported,
        isAsync: false,
        isDefault,
      }),
      parentId: buildId(filePath),
      exported: isExported,
      language,
      metadata: { isAbstract, isDefault },
    });

    // Extract methods within the class
    const methodRegex =
      /^\s+(static\s+)?(async\s+)?(get\s+|set\s+)?(\w+)\s*\(([^)]*)\)/;

    for (let j = i + 1; j < (endLine ?? lines.length); j++) {
      const methodMatch = lines[j].match(methodRegex);
      if (!methodMatch) continue;

      // Skip lines that look like property assignments, not methods
      if (lines[j].includes("=") && !lines[j].includes("=>")) continue;

      const isStatic = !!methodMatch[1];
      const isAsync = !!methodMatch[2];
      const accessor = methodMatch[3]?.trim();
      const methodName = methodMatch[4];
      const params = methodMatch[5]?.trim();

      // Skip constructor-like patterns or common non-method patterns
      if (["if", "for", "while", "switch", "catch", "return", "new", "super"].includes(methodName)) {
        continue;
      }

      concepts.push({
        id: buildId(filePath, className, methodName),
        name: methodName,
        kind: "function",
        filePath,
        line: j + 1,
        description: generateDescription(methodName, "function", {
          isExported: false,
          isAsync,
          isDefault: false,
          params: params || undefined,
        }),
        parentId: classId,
        exported: false,
        language,
        metadata: { isStatic, isAsync, accessor: accessor || null, isMethod: true },
      });
    }
  }

  return concepts;
}

/**
 * Extract standalone function declarations.
 */
function parseFunctions(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match function declarations:
  // export? (async)? function name(params)
  const funcRegex =
    /^(export\s+)?(export\s+default\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;

  // Match arrow function assignments:
  // export? const name = (async)? (params) =>
  const arrowRegex =
    /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(?([^)=]*)\)?\s*=>/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip lines inside classes (indented) — we handle those in parseClasses
    if (/^\s{2,}/.test(line) && !/^export\s/.test(line.trim())) continue;

    let funcMatch = line.match(funcRegex);
    if (funcMatch) {
      const isExported = !!(funcMatch[1] || funcMatch[2]);
      const isDefault = !!funcMatch[2];
      const isAsync = !!funcMatch[3];
      const funcName = funcMatch[4];
      const params = funcMatch[5]?.trim();
      const endLine = findBlockEnd(lines, i);

      concepts.push({
        id: buildId(filePath, funcName),
        name: funcName,
        kind: "function",
        filePath,
        line: i + 1,
        endLine,
        description: generateDescription(funcName, "function", {
          isExported,
          isAsync,
          isDefault,
          params: params || undefined,
        }),
        parentId: buildId(filePath),
        exported: isExported,
        language,
        metadata: { isAsync, isDefault, isArrow: false },
      });
      continue;
    }

    let arrowMatch = line.match(arrowRegex);
    if (arrowMatch) {
      const isExported = !!arrowMatch[1];
      const funcName = arrowMatch[3];
      const isAsync = !!arrowMatch[4];
      const params = arrowMatch[5]?.trim();
      const endLine = findBlockEnd(lines, i) ?? findStatementEnd(lines, i);

      concepts.push({
        id: buildId(filePath, funcName),
        name: funcName,
        kind: "function",
        filePath,
        line: i + 1,
        endLine,
        description: generateDescription(funcName, "function", {
          isExported,
          isAsync,
          isDefault: false,
          params: params || undefined,
        }),
        parentId: buildId(filePath),
        exported: isExported,
        language,
        metadata: { isAsync, isDefault: false, isArrow: true },
      });
    }
  }

  return concepts;
}

/**
 * Extract interface and type alias declarations (TypeScript only).
 */
function parseInterfaces(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept[] {
  if (language !== "typescript") return [];

  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match interface declarations
  const interfaceRegex = /^(export\s+)?(export\s+default\s+)?interface\s+(\w+)/;

  // Match type alias declarations
  const typeRegex = /^(export\s+)?type\s+(\w+)\s*=/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const ifaceMatch = line.match(interfaceRegex);
    if (ifaceMatch) {
      const isExported = !!(ifaceMatch[1] || ifaceMatch[2]);
      const name = ifaceMatch[3];
      const endLine = findBlockEnd(lines, i);

      concepts.push({
        id: buildId(filePath, name),
        name,
        kind: "interface",
        filePath,
        line: i + 1,
        endLine,
        description: generateDescription(name, "interface", {
          isExported,
          isAsync: false,
          isDefault: false,
        }),
        parentId: buildId(filePath),
        exported: isExported,
        language,
        metadata: { isTypeAlias: false },
      });
      continue;
    }

    const typeMatch = line.match(typeRegex);
    if (typeMatch) {
      const isExported = !!typeMatch[1];
      const name = typeMatch[2];

      concepts.push({
        id: buildId(filePath, name),
        name,
        kind: "interface",
        filePath,
        line: i + 1,
        description: generateDescription(name, "interface", {
          isExported,
          isAsync: false,
          isDefault: false,
        }),
        parentId: buildId(filePath),
        exported: isExported,
        language,
        metadata: { isTypeAlias: true },
      });
    }
  }

  return concepts;
}

/**
 * Extract enum declarations.
 */
function parseEnums(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept[] {
  if (language !== "typescript") return [];

  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  const enumRegex = /^(export\s+)?(const\s+)?enum\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(enumRegex);
    if (!match) continue;

    const isExported = !!match[1];
    const isConst = !!match[2];
    const name = match[3];
    const endLine = findBlockEnd(lines, i);

    concepts.push({
      id: buildId(filePath, name),
      name,
      kind: "enum",
      filePath,
      line: i + 1,
      endLine,
      description: generateDescription(name, "enum", {
        isExported,
        isAsync: false,
        isDefault: false,
      }),
      parentId: buildId(filePath),
      exported: isExported,
      language,
      metadata: { isConst },
    });
  }

  return concepts;
}

/**
 * Extract exported constants.
 */
function parseConstants(
  filePath: string,
  content: string,
  language: SupportedLanguage
): CodeConcept[] {
  const concepts: CodeConcept[] = [];
  const lines = content.split("\n");

  // Match: export const NAME = value (but NOT arrow functions, which are handled in parseFunctions)
  const constRegex = /^export\s+(const|let|var)\s+(\w+)\s*[=:]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(constRegex);
    if (!match) continue;

    const name = match[2];

    // Skip if this looks like a function (arrow function — handled elsewhere)
    if (line.includes("=>") || line.includes("function")) continue;

    // Skip if it's a type re-export
    if (line.includes("type ")) continue;

    concepts.push({
      id: buildId(filePath, name),
      name,
      kind: "constant",
      filePath,
      line: i + 1,
      description: generateDescription(name, "constant", {
        isExported: true,
        isAsync: false,
        isDefault: false,
      }),
      parentId: buildId(filePath),
      exported: true,
      language,
      metadata: {},
    });
  }

  return concepts;
}

/**
 * Find the end of a block (matching closing brace) starting from a line.
 */
function findBlockEnd(lines: string[], startIndex: number): number | undefined {
  let depth = 0;
  let foundOpen = false;

  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return i + 1; // 1-indexed
        }
      }
    }
  }

  return undefined;
}

/**
 * Find the end of a statement (semicolon or end of expression).
 */
function findStatementEnd(
  lines: string[],
  startIndex: number
): number | undefined {
  for (let i = startIndex; i < Math.min(startIndex + 50, lines.length); i++) {
    if (lines[i].includes(";") || (i > startIndex && /^\S/.test(lines[i]))) {
      return i + 1;
    }
  }
  return undefined;
}

/**
 * Determine the language from file extension.
 */
function languageFromExtension(ext: string): SupportedLanguage {
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "unknown";
  }
}

/**
 * TypeScript/JavaScript language parser implementation.
 */
export class TypeScriptParser implements LanguageParser {
  language: SupportedLanguage = "typescript";
  extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

  parse(filePath: string, content: string): CodeConcept[] {
    const ext = extname(filePath).toLowerCase();
    const language = languageFromExtension(ext);

    const concepts: CodeConcept[] = [];

    // Module-level concept
    concepts.push(parseModuleConcept(filePath, content, language));

    // Extract all concept kinds
    concepts.push(...parseClasses(filePath, content, language));
    concepts.push(...parseFunctions(filePath, content, language));
    concepts.push(...parseInterfaces(filePath, content, language));
    concepts.push(...parseEnums(filePath, content, language));
    concepts.push(...parseConstants(filePath, content, language));

    // Deduplicate by ID (arrow functions might match both function and constant patterns)
    const seen = new Set<string>();
    return concepts.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }
}
