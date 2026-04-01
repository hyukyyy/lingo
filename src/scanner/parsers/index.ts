/**
 * Parser registry — maps file extensions to the appropriate language parser.
 *
 * Follows the adapter pattern: new parsers can be registered without
 * modifying existing code.
 */

import type { LanguageParser } from "../../types/index.js";
import { TypeScriptParser } from "./typescript-parser.js";
import { PythonParser } from "./python-parser.js";
import { DocsParser } from "./docs-parser.js";

/**
 * Registry of all available language parsers.
 * Keyed by file extension (including the dot).
 */
export class ParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();

  constructor() {
    // Register built-in parsers
    this.register(new TypeScriptParser());
    this.register(new PythonParser());
    this.register(new DocsParser());
  }

  /**
   * Register a parser for its declared extensions.
   */
  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) {
      this.parsers.set(ext.toLowerCase(), parser);
    }
  }

  /**
   * Get the parser for a given file extension.
   * Returns undefined if no parser is registered for that extension.
   */
  getParser(extension: string): LanguageParser | undefined {
    return this.parsers.get(extension.toLowerCase());
  }

  /**
   * Check if a file extension has a registered parser.
   */
  hasParser(extension: string): boolean {
    return this.parsers.has(extension.toLowerCase());
  }

  /**
   * Get all registered extensions.
   */
  get supportedExtensions(): string[] {
    return Array.from(this.parsers.keys());
  }
}
