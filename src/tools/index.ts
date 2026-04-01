/**
 * Lingo MCP Tools — Tool definitions for the organizational context layer.
 *
 * Registers tools with the MCP server that expose glossary query and management
 * operations. These are the primary interface for AI development tools (Claude Code,
 * Cursor) to interact with an organization's terminology <-> code location mappings.
 *
 * Tool inventory:
 *   - query_context:         Search the glossary for terms matching a query
 *   - get_term:              Retrieve a specific glossary term by ID or name
 *   - add_term:              Add a new term to the glossary
 *   - update_term:           Update an existing glossary term
 *   - remove_term:           Remove a term from the glossary
 *   - list_terms:            List all terms, optionally filtered or searched
 *   - find_by_file:          Find terms associated with a specific file path
 *   - bootstrap:             AI-powered cold-start: infer terms from codebase scan
 *   - suggest_code_changes:  Analyze term change impact and generate code modification suggestions
 *   - create_from_text:      Reverse-flow: parse NL text into PM items, optionally route through adapter
 *   - list_adapters:         List all available PM and SCM adapters with { name, type, displayName }
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonGlossaryStorage } from "../storage/json-store.js";
import type {
  GlossaryTerm,
  CodeRelationship,
  ConfidenceLevel,
  CodeLocation,
  SignalType,
} from "../models/glossary.js";
import { BootstrapOrchestrator } from "../bootstrap/index.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { SCMAdapterRegistry } from "../adapters/scm/registry.js";
import { analyzeImpact } from "../analysis/impact-analysis.js";
import {
  generateSuggestions,
  type TermChangeType,
  type SuggestionKind,
  type SuggestionPriority,
} from "../analysis/suggestion-engine.js";
import { parseNaturalLanguage } from "../nl-parser/nl-parser.js";
import { createPmItem } from "../models/pm-items.js";
import type { NlParserOptions } from "../nl-parser/types.js";
import type { PmItemType, PmStatus, PmPriority, PmItem, CreatePmItemInput } from "../models/pm-items.js";
import { learnFromPR } from "../pr-learner/index.js";

// ─── Tool Names (exported for testing) ─────────────────────────────────

export const TOOL_NAMES = {
  QUERY_CONTEXT: "query_context",
  GET_TERM: "get_term",
  ADD_TERM: "add_term",
  UPDATE_TERM: "update_term",
  REMOVE_TERM: "remove_term",
  LIST_TERMS: "list_terms",
  FIND_BY_FILE: "find_by_file",
  BOOTSTRAP: "bootstrap",
  SUGGEST_CODE_CHANGES: "suggest_code_changes",
  CREATE_FROM_TEXT: "create_from_text",
  LEARN_FROM_PR: "learn_from_pr",
  RECORD_SIGNAL: "record_signal",
  LIST_ADAPTERS: "list_adapters",
} as const;

/**
 * All tool names as an array, useful for verification in tests.
 */
export const ALL_TOOL_NAMES = Object.values(TOOL_NAMES);

// ─── Cold Start / Empty Store Helpers ─────────────────────────────────

/**
 * Guidance messages displayed when the glossary store is empty (cold start).
 * Provides users with actionable instructions to populate data.
 */
export const COLD_START_GUIDANCE = {
  /** Short description of the empty state */
  message:
    "The glossary is empty — no organizational terms have been defined yet.",

  /** Step-by-step guidance for populating the glossary */
  howToPopulate: [
    "Use the 'bootstrap' tool to auto-discover terms from your codebase and connected PM tools (Notion, Linear).",
    "Use the 'add_term' tool to manually define terms one at a time with their code locations.",
    "Connect a PM adapter (e.g., Notion) and run bootstrap with the 'adapter' parameter to extract terms from your planning tools.",
  ],

  /** Quick example for getting started */
  quickStart:
    "Try: bootstrap with dryRun=true to preview what terms would be discovered, then run again with dryRun=false to persist them.",
} as const;

/**
 * Checks whether the glossary store has zero terms (cold start state).
 *
 * @param storage - The glossary storage instance
 * @returns true if the store is loaded and contains no terms
 */
function isStoreEmpty(storage: JsonGlossaryStorage): boolean {
  try {
    const store = storage.getStore();
    return Object.keys(store.terms).length === 0;
  } catch {
    // Store not loaded — treat as empty
    return true;
  }
}

/**
 * Builds the cold-start guidance object to include in empty-state responses.
 */
function buildColdStartGuidance() {
  return {
    _coldStart: true,
    guidance: {
      message: COLD_START_GUIDANCE.message,
      howToPopulate: COLD_START_GUIDANCE.howToPopulate,
      quickStart: COLD_START_GUIDANCE.quickStart,
    },
  };
}

// ─── Output Formatting ───────────────────────────────────────────────

/**
 * Formats a GlossaryTerm for MCP tool output.
 * Provides a clean, readable representation with all relevant fields.
 */
function formatTermForOutput(term: GlossaryTerm) {
  return {
    id: term.id,
    name: term.name,
    definition: term.definition,
    aliases: term.aliases,
    codeLocations: term.codeLocations.map((loc) => ({
      filePath: loc.filePath,
      symbol: loc.symbol,
      lineRange: loc.lineRange,
      relationship: loc.relationship,
      note: loc.note,
    })),
    category: term.category,
    tags: term.tags,
    source: term.source,
    confidence: term.confidence,
    coupling: term.coupling ?? null,
    createdAt: term.createdAt,
    updatedAt: term.updatedAt,
  };
}

/**
 * Applies optional post-filters (category, tag, confidence, adapter) to a list of terms.
 * Used when the primary retrieval method was search or file-path lookup.
 */
function applyFilters(
  terms: GlossaryTerm[],
  filters: {
    category?: string;
    tag?: string;
    confidence?: string;
    adapter?: string;
  }
): GlossaryTerm[] {
  return terms.filter((term) => {
    if (filters.category && term.category !== filters.category) {
      return false;
    }
    if (filters.tag && !term.tags.includes(filters.tag)) {
      return false;
    }
    if (filters.confidence && term.confidence !== filters.confidence) {
      return false;
    }
    if (filters.adapter && term.source.adapter !== filters.adapter) {
      return false;
    }
    return true;
  });
}

// ─── SCM Adapter Resolution ─────────────────────────────────────────────

/**
 * Hostname-to-adapter-name mapping for SCM URL resolution.
 * Maps well-known SCM hostnames to their adapter identifiers.
 *
 * This enables the learn_from_pr tool to automatically select the correct
 * SCM adapter based on the PR URL, without requiring the caller to specify
 * the adapter explicitly.
 */
const SCM_HOST_MAP: Record<string, string> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/**
 * Resolves an SCM adapter name from a pull request / merge request URL.
 *
 * Extracts the hostname from the URL and maps it to a known adapter name.
 * Returns undefined if the URL cannot be parsed or the hostname is not
 * recognized.
 *
 * @param url - The PR/MR URL (e.g., "https://github.com/owner/repo/pull/123")
 * @returns The adapter name (e.g., "github"), or undefined if not recognized
 */
export function resolveScmAdapterName(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    return SCM_HOST_MAP[hostname];
  } catch {
    // URL parsing failed — caller will fall back to default behavior
    return undefined;
  }
}

// ─── Registration ──────────────────────────────────────────────────────

/**
 * Options for tool registration.
 */
export interface RegisterToolsOptions {
  /** Optional PM adapter registry for the bootstrap tool */
  adapterRegistry?: AdapterRegistry;
  /** Optional SCM adapter registry for learn_from_pr and list_adapters tools */
  scmAdapterRegistry?: SCMAdapterRegistry;
}

/**
 * Registers all Lingo tools on the given MCP server instance.
 *
 * Tools that operate on glossary data (add_term, get_term, list_terms) require
 * a storage instance to be provided. The bootstrap tool wires together the
 * codebase scanner, PM adapter, and mapping engine for cold-start.
 *
 * @param server  - The McpServer instance to register tools on
 * @param storage - The loaded JsonGlossaryStorage instance for persistence
 * @param options - Optional configuration for tool registration
 */
export function registerTools(
  server: McpServer,
  storage: JsonGlossaryStorage,
  options?: RegisterToolsOptions,
): void {
  // ── query_context ──────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.QUERY_CONTEXT,
    "Search the organizational glossary for terms matching a natural-language query. " +
      "Returns matching terms with their definitions and associated code locations. " +
      "Use this when an AI tool encounters unfamiliar organizational terminology.",
    {
      query: z.string().describe(
        "Natural-language search query (e.g., 'sprint velocity', 'auth service', 'billing module')"
      ),
      category: z.string().optional().describe(
        "Optional category filter to narrow results (e.g., 'authentication', 'billing')"
      ),
      limit: z.number().int().positive().max(100).optional().describe(
        "Maximum number of results to return (default: 10)"
      ),
    },
    async (args) => {
      try {
        const limit = args.limit ?? 10;
        const storeEmpty = isStoreEmpty(storage);

        // Primary search using glossary storage
        let results = storage.searchTerms(args.query);

        // Apply category filter if provided
        if (args.category) {
          results = results.filter(
            (term) => term.category === args.category
          );
        }

        // Sort by coupling score descending — stronger mappings surface first
        results.sort(
          (a, b) => (b.coupling?.score ?? 0) - (a.coupling?.score ?? 0)
        );

        // Apply result limit
        results = results.slice(0, limit);

        // Build response with cold-start guidance when store is empty
        const response: Record<string, unknown> = {
          success: true,
          query: args.query,
          count: results.length,
          terms: results.map(formatTermForOutput),
        };

        if (storeEmpty) {
          Object.assign(response, buildColdStartGuidance());
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_term ───────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.GET_TERM,
    "Retrieve a specific glossary term by its unique ID or by searching for its name. " +
      "Returns the full term including definition, aliases, code locations, and metadata. " +
      "Provide either 'id' for exact lookup, or 'name' for case-insensitive search.",
    {
      id: z.string().optional().describe("The unique ID of the glossary term to retrieve"),
      name: z.string().optional().describe(
        "The name of the term to search for (case-insensitive, returns best match)"
      ),
    },
    async (args) => {
      try {
        // Validate that at least one identifier is provided
        if (!args.id && !args.name) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Either 'id' or 'name' must be provided",
                }),
              },
            ],
            isError: true,
          };
        }

        const storeEmpty = isStoreEmpty(storage);

        let term: GlossaryTerm | undefined;

        // ID-based lookup takes priority
        if (args.id) {
          term = storage.getTerm(args.id);
        }

        // Fall back to name-based search
        if (!term && args.name) {
          const results = storage.searchTerms(args.name);
          term = results.length > 0 ? results[0] : undefined;
        }

        if (!term) {
          const identifier = args.id ?? args.name;

          // When the store is empty (cold start), return a non-error response
          // with guidance on how to populate data instead of a hard error
          if (storeEmpty) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      success: true,
                      term: null,
                      message: `Term '${identifier}' not found — the glossary is currently empty.`,
                      ...buildColdStartGuidance(),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          // Store has terms but this specific term wasn't found — that's a real "not found"
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Term not found: ${identifier}`,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  term: formatTermForOutput(term),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── add_term ───────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.ADD_TERM,
    "Add a new term to the organizational glossary. " +
      "Creates a mapping between a planning/product concept and its code locations. " +
      "Requires at minimum a name and definition. Returns the created term with its generated ID.",
    {
      name: z.string().min(1).describe(
        "The canonical name of the term (e.g., 'Sprint Velocity', 'Auth Guard')"
      ),
      definition: z.string().min(1).describe(
        "Human-readable definition explaining what this term means in the org's context"
      ),
      aliases: z.array(z.string()).optional().describe(
        "Alternative names, abbreviations, or colloquialisms (e.g., ['SV', 'velocity'])"
      ),
      category: z.string().optional().describe(
        "Domain grouping (e.g., 'authentication', 'billing', 'analytics')"
      ),
      tags: z.array(z.string()).optional().describe(
        "Flexible classification tags"
      ),
      codeLocations: z
        .array(
          z.object({
            filePath: z.string().describe("Relative file path from project root"),
            symbol: z.string().optional().describe("Function, class, or variable name"),
            lineStart: z.number().optional().describe("Optional start line number"),
            lineEnd: z.number().optional().describe("Optional end line number"),
            relationship: z
              .enum(["defines", "implements", "uses", "tests", "configures"])
              .describe("How this code relates to the term"),
            note: z.string().optional().describe("Optional note about the relationship"),
          })
        )
        .optional()
        .describe("Code locations where this term is implemented or referenced"),
      source: z
        .object({
          adapter: z.string().describe("The source system (e.g., 'notion', 'linear', 'manual')"),
          externalId: z.string().optional().describe("External ID for traceability"),
          url: z.string().optional().describe("URL linking back to the source"),
        })
        .optional()
        .describe("Where this term originated"),
      confidence: z
        .enum(["manual", "ai-suggested", "ai-verified"])
        .optional()
        .describe("Confidence level for the term-to-code mapping (default: 'manual')"),
    },
    async (args) => {
      try {
        // Transform code locations from tool input to storage model
        const codeLocations: CodeLocation[] | undefined = args.codeLocations?.map(
          (loc) => ({
            filePath: loc.filePath,
            symbol: loc.symbol,
            lineRange:
              loc.lineStart !== undefined && loc.lineEnd !== undefined
                ? { start: loc.lineStart, end: loc.lineEnd }
                : undefined,
            relationship: loc.relationship as CodeRelationship,
            note: loc.note,
          })
        );

        const term = await storage.addTerm({
          name: args.name,
          definition: args.definition,
          aliases: args.aliases,
          codeLocations,
          category: args.category,
          tags: args.tags,
          source: args.source,
          confidence: args.confidence as ConfidenceLevel | undefined,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Term '${term.name}' created with ID ${term.id}`,
                  term: formatTermForOutput(term),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── update_term ────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.UPDATE_TERM,
    "Update an existing glossary term. " +
      "Allows partial updates — only the provided fields will be changed. " +
      "The updatedAt timestamp is automatically set.",
    {
      id: z.string().uuid().describe("The unique ID of the term to update"),
      name: z.string().min(1).optional().describe("Updated term name"),
      definition: z.string().min(1).optional().describe("Updated definition"),
      aliases: z.array(z.string()).optional().describe("Updated aliases list (replaces existing)"),
      category: z.string().optional().describe("Updated category"),
      tags: z.array(z.string()).optional().describe("Updated tags (replaces existing)"),
      codeLocations: z
        .array(
          z.object({
            filePath: z.string().describe("Relative file path from project root"),
            symbol: z.string().optional().describe("Function, class, or variable name"),
            lineStart: z.number().optional().describe("Optional start line number"),
            lineEnd: z.number().optional().describe("Optional end line number"),
            relationship: z
              .enum(["defines", "implements", "uses", "tests", "configures"])
              .describe("How this code relates to the term"),
            note: z.string().optional().describe("Optional note about the relationship"),
          })
        )
        .optional()
        .describe("Updated code locations (replaces existing)"),
      confidence: z
        .enum(["manual", "ai-suggested", "ai-verified"])
        .optional()
        .describe("Updated confidence level"),
      source: z
        .object({
          adapter: z.string().describe("The source system (e.g., 'notion', 'linear', 'manual')"),
          externalId: z.string().optional().describe("External ID for traceability"),
          url: z.string().optional().describe("URL linking back to the source"),
        })
        .optional()
        .describe("Updated source information"),
    },
    async (args) => {
      try {
        // Build partial update object from provided fields
        const updates: Record<string, unknown> = {};

        if (args.name !== undefined) {
          updates.name = args.name;
        }
        if (args.definition !== undefined) {
          updates.definition = args.definition;
        }
        if (args.aliases !== undefined) {
          updates.aliases = args.aliases;
        }
        if (args.category !== undefined) {
          updates.category = args.category;
        }
        if (args.tags !== undefined) {
          updates.tags = args.tags;
        }
        if (args.confidence !== undefined) {
          updates.confidence = args.confidence;
        }
        if (args.source !== undefined) {
          updates.source = args.source;
        }

        // Transform code locations from tool input to storage model
        if (args.codeLocations !== undefined) {
          updates.codeLocations = args.codeLocations.map((loc) => ({
            filePath: loc.filePath,
            symbol: loc.symbol,
            lineRange:
              loc.lineStart !== undefined && loc.lineEnd !== undefined
                ? { start: loc.lineStart, end: loc.lineEnd }
                : undefined,
            relationship: loc.relationship as CodeRelationship,
            note: loc.note,
          }));
        }

        const term = await storage.updateTerm(args.id, updates);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Term '${term.name}' (${term.id}) updated successfully`,
                  term: formatTermForOutput(term),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── remove_term ────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.REMOVE_TERM,
    "Remove a term from the organizational glossary by its ID. " +
      "This permanently deletes the term and its code location mappings. " +
      "Returns the deleted term's details for confirmation.",
    {
      id: z.string().uuid().describe("The unique ID of the term to remove"),
    },
    async (args) => {
      try {
        // Validate term existence before attempting removal
        const existing = storage.getTerm(args.id);
        if (!existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Term not found: ${args.id}`,
                }),
              },
            ],
            isError: true,
          };
        }

        // Capture term details before deletion for confirmation
        const termSnapshot = formatTermForOutput(existing);

        // Perform the deletion
        const removed = await storage.removeTerm(args.id);

        if (!removed) {
          // Defensive: should not happen since we checked existence above
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Failed to remove term: ${args.id}`,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Term '${existing.name}' (${existing.id}) removed successfully`,
                  removedTerm: termSnapshot,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── list_terms ─────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.LIST_TERMS,
    "List and search organizational glossary terms. " +
      "Supports full-text search via 'query' parameter, filtering by category/tag/confidence/adapter, " +
      "and file-path-based lookup to find terms related to specific code files. " +
      "Returns all matching terms sorted by relevance when searching, " +
      "or all terms when no filters are provided.",
    {
      query: z.string().optional().describe(
        "Search query to match against term names, aliases, and definitions"
      ),
      category: z.string().optional().describe(
        "Filter by domain category (e.g., 'authentication')"
      ),
      tag: z.string().optional().describe(
        "Filter by tag"
      ),
      confidence: z
        .enum(["manual", "ai-suggested", "ai-verified"])
        .optional()
        .describe("Filter by confidence level"),
      adapter: z.string().optional().describe(
        "Filter by source adapter (e.g., 'notion', 'linear', 'manual')"
      ),
      filePath: z.string().optional().describe(
        "Find terms that reference this file path (partial match supported)"
      ),
    },
    async (args) => {
      try {
        const storeEmpty = isStoreEmpty(storage);
        let terms: GlossaryTerm[];

        // File-path-based search takes a different code path
        if (args.filePath) {
          terms = storage.findTermsByFile(args.filePath);
        }
        // Full-text search
        else if (args.query) {
          terms = storage.searchTerms(args.query);
        }
        // Filtered list
        else {
          const hasFilter =
            args.category || args.tag || args.confidence || args.adapter;
          terms = storage.listTerms(
            hasFilter
              ? {
                  category: args.category,
                  tag: args.tag,
                  confidence: args.confidence as ConfidenceLevel | undefined,
                  adapter: args.adapter,
                }
              : undefined
          );
        }

        // Apply additional filters on top of search/file results
        if (args.filePath || args.query) {
          terms = applyFilters(terms, args);
        }

        // Build response with cold-start guidance when store is empty
        const response: Record<string, unknown> = {
          success: true,
          count: terms.length,
          terms: terms.map(formatTermForOutput),
        };

        if (storeEmpty) {
          Object.assign(response, buildColdStartGuidance());
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── find_by_file ───────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.FIND_BY_FILE,
    "Find glossary terms associated with a specific file path. " +
      "Useful when an AI tool is working on a file and needs to understand " +
      "what organizational concepts are implemented there.",
    {
      filePath: z.string().min(1).describe(
        "File path to search for (relative to project root, partial matches supported)"
      ),
    },
    async (args) => {
      try {
        const storeEmpty = isStoreEmpty(storage);
        const terms = storage.findTermsByFile(args.filePath);

        // Build response with cold-start guidance when store is empty
        const response: Record<string, unknown> = {
          success: true,
          filePath: args.filePath,
          count: terms.length,
          terms: terms.map(formatTermForOutput),
        };

        if (storeEmpty) {
          Object.assign(response, buildColdStartGuidance());
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── bootstrap ──────────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.BOOTSTRAP,
    "AI-powered cold-start bootstrap for new organizations. " +
      "Scans the codebase and optionally connected PM tools (Notion, Linear) to " +
      "automatically infer glossary terms and their code location mappings. " +
      "Results are added with 'ai-suggested' confidence level for human review.",
    {
      rootDir: z.string().optional().describe(
        "Project root directory to scan (defaults to current working directory)"
      ),
      adapter: z.string().optional().describe(
        "PM tool adapter to use for term discovery (e.g., 'notion', 'linear'). " +
        "If omitted, only codebase scanning is performed."
      ),
      projectId: z.string().optional().describe(
        "Specific project/database ID in the PM tool to extract terms from"
      ),
      maxItems: z.number().int().positive().optional().describe(
        "Maximum number of items to extract from the PM tool (default: adapter-specific)"
      ),
      dryRun: z.boolean().optional().describe(
        "If true, returns inferred terms without persisting them (default: false)"
      ),
      organization: z.string().optional().describe(
        "Organization name for the glossary store (used if store is newly created)"
      ),
    },
    async (args) => {
      try {
        const orchestrator = new BootstrapOrchestrator({
          storage,
          adapterRegistry: options?.adapterRegistry,
        });

        const summary = await orchestrator.run({
          rootDir: args.rootDir ?? process.cwd(),
          adapterName: args.adapter,
          adapterOptions: {
            projectId: args.projectId,
            maxItems: args.maxItems,
          },
          dryRun: args.dryRun ?? false,
          organization: args.organization,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: summary.persisted
                    ? `Bootstrap complete: ${summary.termsCreated} terms created with ${summary.mappingsCreated} code mappings`
                    : summary.terms.length > 0
                      ? `Dry run complete: ${summary.terms.length} terms would be created`
                      : "Bootstrap complete: no terms found to create",
                  summary: {
                    persisted: summary.persisted,
                    termsCreated: summary.termsCreated,
                    mappingsCreated: summary.mappingsCreated,
                    termSource: summary.termSource,
                    adapterName: summary.adapterName,
                    scan: summary.scan,
                    extraction: summary.extraction,
                    mapping: summary.mapping,
                    totalDurationMs: Math.round(summary.totalDurationMs),
                  },
                  terms: summary.terms,
                  warnings: summary.warnings,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── suggest_code_changes ────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.SUGGEST_CODE_CHANGES,
    "Analyze the impact of a term change and generate concrete code modification suggestions. " +
      "Given a planning term and a description of what's changing (rename, redefine, deprecate, " +
      "split, merge, or relocate), this tool identifies all affected code locations and produces " +
      "specific before/after code change suggestions with priorities. " +
      "Use this when an organizational concept is evolving and you need to know what code to update.",
    {
      // ── Change description ──
      changeType: z
        .enum(["rename", "redefine", "deprecate", "split", "merge", "relocate"])
        .describe(
          "The kind of change: 'rename' (name changing), 'redefine' (meaning changing), " +
          "'deprecate' (retiring), 'split' (one→many), 'merge' (many→one), 'relocate' (moving code)"
        ),
      oldName: z.string().min(1).describe(
        "The current/original name of the term being changed (e.g., 'Sprint Velocity')"
      ),
      newName: z.string().optional().describe(
        "The new term name — required for 'rename' and 'merge' change types"
      ),
      description: z.string().min(1).describe(
        "Human-readable description of why the change is happening"
      ),
      newDefinition: z.string().optional().describe(
        "Updated definition text (relevant for 'redefine' changes)"
      ),
      splitInto: z.array(z.string()).optional().describe(
        "For 'split' changes: the list of new term names being created"
      ),
      mergeFrom: z.array(z.string()).optional().describe(
        "For 'merge' changes: the list of term names being merged together"
      ),
      newLocation: z.string().optional().describe(
        "For 'relocate' changes: the new file path for the code"
      ),

      // ── Impact analysis options ──
      maxTerms: z.number().int().positive().max(50).optional().describe(
        "Maximum number of matching glossary terms to consider (default: 20)"
      ),
      minConfidence: z
        .enum(["manual", "ai-suggested", "ai-verified"])
        .optional()
        .describe("Only include terms at or above this confidence level"),
      relationships: z
        .array(z.enum(["defines", "implements", "uses", "tests", "configures"]))
        .optional()
        .describe("Filter to only include specific relationship types in the analysis"),
      filePathFilter: z.string().optional().describe(
        "Only include files matching this substring (case-insensitive)"
      ),

      // ── Suggestion generation options ──
      maxSuggestionsPerFile: z.number().int().positive().max(50).optional().describe(
        "Maximum suggestions per file (default: 20)"
      ),
      maxTotalSuggestions: z.number().int().positive().max(200).optional().describe(
        "Maximum total suggestions (default: 100)"
      ),
      suggestionKinds: z
        .array(
          z.enum([
            "symbol-rename",
            "file-rename",
            "comment-update",
            "string-literal-update",
            "import-update",
            "deprecation-marker",
            "structural-refactor",
            "test-update",
            "config-update",
          ])
        )
        .optional()
        .describe("Filter to only generate specific kinds of suggestions"),
      minPriority: z
        .enum(["critical", "recommended", "optional"])
        .optional()
        .describe("Only include suggestions at or above this priority (default: 'optional')"),
      includeTests: z.boolean().optional().describe(
        "Whether to include suggestions for test files (default: true)"
      ),
      includeConfigs: z.boolean().optional().describe(
        "Whether to include suggestions for configuration files (default: true)"
      ),
    },
    async (args) => {
      try {
        const storeEmpty = isStoreEmpty(storage);

        // Step 1: Run impact analysis to find affected code locations
        const impactResult = analyzeImpact(storage, args.oldName, {
          maxTerms: args.maxTerms,
          requireCodeLocations: true,
          minConfidence: args.minConfidence as "manual" | "ai-suggested" | "ai-verified" | undefined,
          relationships: args.relationships as Array<"defines" | "implements" | "uses" | "tests" | "configures"> | undefined,
          filePathFilter: args.filePathFilter,
        });

        // Step 2: Build the term change description
        const change = {
          type: args.changeType as TermChangeType,
          oldName: args.oldName,
          newName: args.newName,
          description: args.description,
          newDefinition: args.newDefinition,
          splitInto: args.splitInto,
          mergeFrom: args.mergeFrom,
          newLocation: args.newLocation,
        };

        // Step 3: Generate suggestions based on impact analysis
        const suggestionResult = generateSuggestions(impactResult, change, {
          maxSuggestionsPerFile: args.maxSuggestionsPerFile,
          maxTotalSuggestions: args.maxTotalSuggestions,
          kinds: args.suggestionKinds as SuggestionKind[] | undefined,
          minPriority: (args.minPriority as SuggestionPriority) ?? "optional",
          includeTests: args.includeTests,
          includeConfigs: args.includeConfigs,
        });

        // Step 4: Format the response for the AI client
        const response: Record<string, unknown> = {
          success: true,
          change: {
            type: change.type,
            oldName: change.oldName,
            newName: change.newName,
            description: change.description,
          },
          impact: {
            query: impactResult.query,
            found: impactResult.found,
            matchedTerms: impactResult.matchedTerms,
            summary: impactResult.summary,
          },
          suggestions: suggestionResult.suggestions.map((s) => ({
            id: s.id,
            filePath: s.filePath,
            kind: s.kind,
            priority: s.priority,
            title: s.title,
            rationale: s.rationale,
            symbolName: s.symbolName,
            relationship: s.relationship,
            lineRange: s.lineRange,
            before: s.before,
            after: s.after,
            autoApplicable: s.autoApplicable,
          })),
          summary: suggestionResult.summary,
          warnings: suggestionResult.warnings,
        };

        // Include cold-start guidance when store is empty
        if (storeEmpty) {
          Object.assign(response, buildColdStartGuidance());
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── create_from_text ────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.CREATE_FROM_TEXT,
    "Reverse-flow pipeline: parse natural language text into structured PM items. " +
      "Accepts free-text descriptions of work items (epics, stories, tasks, bugs) " +
      "and extracts intent, entities, and hierarchy to produce structured PM items " +
      "in Lingo's canonical format. Optionally routes through a registered PM adapter " +
      "(e.g., 'mock', 'json') for creation. Supports bullet lists, numbered lists, " +
      "user stories ('As a X, I want Y'), and inline type prefixes ('Epic: Title'). " +
      "Use this to convert planning discussions into actionable PM items.",
    {
      text: z.string().min(1).describe(
        "Natural language text describing work items to create. " +
        "Supports bullet lists, numbered lists, 'Type: Title' format, " +
        "and user story format ('As a user, I want...'). " +
        "Example: 'User Authentication\\n- Login page\\n- Registration flow\\n- Password reset'"
      ),
      adapter: z.string().optional().describe(
        "Name of a registered PM adapter to route item creation through (e.g., 'mock', 'json'). " +
        "If omitted, items are parsed and returned without external creation."
      ),
      projectId: z.string().optional().describe(
        "Project/database ID in the target PM tool (required when adapter is specified)"
      ),
      dryRun: z.boolean().optional().describe(
        "If true, parse and return items without creating them in the adapter (default: true)"
      ),
      defaultItemType: z
        .enum(["initiative", "epic", "story", "task", "subtask", "bug", "feature", "milestone"])
        .optional()
        .describe("Default item type when the parser can't determine it from context (default: 'task')"),
      defaultStatus: z
        .enum(["backlog", "todo", "in-progress", "in-review", "done", "cancelled"])
        .optional()
        .describe("Default status for newly parsed items (default: 'backlog')"),
      defaultPriority: z
        .enum(["critical", "high", "medium", "low", "none"])
        .optional()
        .describe("Default priority for newly parsed items (default: 'none')"),
      sourceAdapter: z.string().optional().describe(
        "Source adapter name to tag on created items (default: 'nl-parser')"
      ),
    },
    async (args) => {
      try {
        // Step 1: Configure parser options from tool arguments
        const parserOptions: NlParserOptions = {};
        if (args.defaultItemType) {
          parserOptions.defaultItemType = args.defaultItemType as PmItemType;
        }
        if (args.defaultStatus) {
          parserOptions.defaultStatus = args.defaultStatus as PmStatus;
        }
        if (args.defaultPriority) {
          parserOptions.defaultPriority = args.defaultPriority as PmPriority;
        }
        if (args.sourceAdapter) {
          parserOptions.sourceAdapter = args.sourceAdapter;
        }

        // Step 2: Parse the natural language input
        const parseResult = parseNaturalLanguage(args.text, parserOptions);

        // Step 3: Create structured PmItem objects from parsed items
        const pmItems: PmItem[] = parseResult.items.map((input: CreatePmItemInput) =>
          createPmItem(input)
        );

        // Step 4: Optionally route through an adapter
        let adapterResult: AdapterCreationResult | undefined;
        const isDryRun = args.dryRun ?? true;

        if (args.adapter && !isDryRun && options?.adapterRegistry) {
          const adapter = options.adapterRegistry.get(args.adapter);
          if (!adapter) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Adapter "${args.adapter}" is not registered. ` +
                      `Available adapters: ${options.adapterRegistry.registeredAdapters.join(", ") || "none"}`,
                  }),
                },
              ],
              isError: true,
            };
          }

          // Verify connection before attempting creation
          const connectionStatus = await adapter.testConnection();
          if (!connectionStatus.connected) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Adapter "${args.adapter}" connection failed: ${connectionStatus.message}`,
                  }),
                },
              ],
              isError: true,
            };
          }

          adapterResult = {
            adapterName: adapter.name,
            displayName: adapter.displayName,
            routed: true,
            projectId: args.projectId,
            itemCount: pmItems.length,
          };
        }

        // Step 5: Build the response
        const response = {
          success: true,
          parse: {
            intent: parseResult.intent,
            confidence: parseResult.confidence,
            entityCount: parseResult.entities.length,
            entities: parseResult.entities.map((e) => ({
              kind: e.kind,
              rawValue: e.rawValue,
              normalizedValue: e.normalizedValue,
              confidence: e.confidence,
            })),
          },
          items: pmItems.map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            description: item.description,
            status: item.status,
            priority: item.priority,
            labels: item.labels,
            assignee: item.assignee,
            reporter: item.reporter,
            parent: item.parent,
            children: item.children,
            source: item.source,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
          hierarchy: parseResult.hierarchy.map((h) => ({
            parentTitle: h.parentTitle,
            parentType: h.parentType,
            childTitle: h.childTitle,
            childType: h.childType,
          })),
          summary: {
            itemCount: pmItems.length,
            intent: parseResult.intent,
            confidence: parseResult.confidence,
            dryRun: isDryRun,
            adapterRouted: adapterResult?.routed ?? false,
            adapterName: adapterResult?.adapterName,
          },
          diagnostics: parseResult.diagnostics,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── learn_from_pr ─────────────────────────────────────────────────

  server.tool(
    TOOL_NAMES.LEARN_FROM_PR,
    "Learn organizational terminology from a GitHub Pull Request. " +
      "Extracts planning terms from PR title/description and maps them to changed code files. " +
      "Use dryRun to preview before persisting.",
    {
      prUrl: z
        .string()
        .describe("GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)"),
      githubToken: z
        .string()
        .optional()
        .describe("GitHub Personal Access Token (falls back to LINGO_GITHUB_TOKEN env var)"),
      dryRun: z
        .boolean()
        .optional()
        .default(false)
        .describe("Preview extracted terms without saving to glossary"),
    },
    async (args) => {
      try {
        // Resolve SCM adapter from registry when available.
        // Maps URL hostname to adapter name (e.g., "github.com" → "github").
        // Falls back to direct GitHub API calls if no adapter is found.
        let scmAdapter: import("../adapters/scm/types.js").SCMAdapter | undefined;
        if (options?.scmAdapterRegistry) {
          const adapterName = resolveScmAdapterName(args.prUrl);
          if (adapterName) {
            scmAdapter = options.scmAdapterRegistry.get(adapterName);
          }
        }

        const result = await learnFromPR(storage, {
          prUrl: args.prUrl,
          githubToken: args.githubToken,
          dryRun: args.dryRun,
          scmAdapter,
        });

        const response = {
          success: true,
          dryRun: args.dryRun,
          summary: {
            termsCreated: result.termsCreated,
            termsUpdated: result.termsUpdated,
            codeLocationsAdded: result.codeLocationsAdded,
          },
          terms: result.terms.map((t) => ({
            name: t.name,
            definition: t.definition,
            action: t.action,
            codeLocations: t.codeLocations.map((cl) => ({
              filePath: cl.filePath,
              relationship: cl.relationship,
            })),
            source: t.source,
          })),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── record_signal ──────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.RECORD_SIGNAL,
    "Record a coupling signal for a glossary term, strengthening the mapping between " +
      "the term and its code locations. Each signal type adds a fixed score increment " +
      "(prompt: +0.15, manual: +0.20, pr: +0.10, docs: +0.08, bootstrap: +0.05). " +
      "Scores cap at 1.0. Terms inactive for 6+ months receive a decay factor before " +
      "the new signal is applied. Use this from Claude Code hooks or other automation " +
      "to record when a term appears in an accepted prompt or commit.",
    {
      termId: z.string().describe(
        "The unique ID of the glossary term to signal"
      ),
      signalType: z
        .enum(["pr", "prompt", "docs", "manual", "bootstrap"])
        .describe(
          "The type of signal: 'prompt' (accepted AI suggestion), 'pr' (merged PR), " +
          "'docs' (found in planning doc), 'manual' (explicitly added), 'bootstrap' (cold-start scan)"
        ),
    },
    async (args) => {
      try {
        const updated = await storage.recordSignal(
          args.termId,
          args.signalType as SignalType
        );

        if (!updated) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: `Term not found: ${args.termId}`,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: `Signal '${args.signalType}' recorded for term '${updated.name}'`,
                  coupling: updated.coupling,
                  termId: updated.id,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── list_adapters ──────────────────────────────────────────────────
  server.tool(
    TOOL_NAMES.LIST_ADAPTERS,
    "List all available PM (Project Management) and SCM (Source Control Management) adapters. " +
      "Returns a unified list of adapters known to both registries, each with { name, type, displayName }. " +
      "Use this to discover which integrations are available before calling bootstrap, create_from_text, or learn_from_pr.",
    {},
    async () => {
      try {
        const adapters: Array<{ name: string; type: string; displayName: string }> = [];

        // Collect PM adapters from the PM adapter registry
        if (options?.adapterRegistry) {
          for (const info of options.adapterRegistry.availableAdapters) {
            adapters.push({
              name: info.name,
              type: "pm",
              displayName: info.displayName,
            });
          }
        }

        // Collect SCM adapters from the SCM adapter registry
        if (options?.scmAdapterRegistry) {
          for (const info of options.scmAdapterRegistry.availableAdapters) {
            adapters.push({
              name: info.name,
              type: "scm",
              displayName: info.displayName,
            });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  count: adapters.length,
                  adapters,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: (error as Error).message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}

// ─── Internal Types ─────────────────────────────────────────────────

/**
 * Result of routing PM items through an adapter for creation.
 */
interface AdapterCreationResult {
  adapterName: string;
  displayName: string;
  routed: boolean;
  projectId?: string;
  itemCount: number;
}
