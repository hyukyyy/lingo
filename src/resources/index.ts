/**
 * Lingo MCP Resources — Resource definitions for the organizational context layer.
 *
 * Registers resources with the MCP server that expose the glossary store as
 * browsable, AI-readable data. Resources complement tools by providing a
 * passive "read" interface — AI tools can browse available resources without
 * needing to know specific tool invocations.
 *
 * Resource inventory:
 *   - lingo://terms              Static resource: summary listing of all glossary terms
 *   - lingo://terms/{termId}     Template resource: individual term detail by ID
 *   - lingo://categories         Static resource: list of all term categories
 *   - lingo://status             Static resource: glossary store metadata and stats
 *
 * All resources are currently stubs returning placeholder data. They will be
 * connected to the JsonGlossaryStorage backend as the implementation matures.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─── Resource URIs (exported for testing) ─────────────────────────────

export const RESOURCE_URIS = {
  TERMS: "lingo://terms",
  TERM_BY_ID: "lingo://terms/{termId}",
  CATEGORIES: "lingo://categories",
  STATUS: "lingo://status",
} as const;

/**
 * All static resource URIs as an array (excludes templates).
 */
export const STATIC_RESOURCE_URIS = [
  RESOURCE_URIS.TERMS,
  RESOURCE_URIS.CATEGORIES,
  RESOURCE_URIS.STATUS,
] as const;

/**
 * Resource template names, used to identify template registrations.
 */
export const RESOURCE_TEMPLATE_NAMES = {
  TERM_BY_ID: "term_by_id",
} as const;

// ─── Registration ──────────────────────────────────────────────────────

/**
 * Registers all Lingo resources on the given MCP server instance.
 *
 * Resources provide a browsable, read-only view of the glossary store.
 * They allow AI tools to discover available data without needing to
 * know specific tool names or invocations.
 *
 * @param server - The McpServer instance to register resources on
 */
export function registerResources(server: McpServer): void {
  registerTermsResource(server);
  registerTermByIdResource(server);
  registerCategoriesResource(server);
  registerStatusResource(server);
}

// ─── lingo://terms ─────────────────────────────────────────────────────

/**
 * Static resource: Summary listing of all glossary terms.
 *
 * Returns a JSON array of term summaries (id, name, category, confidence).
 * Use the lingo://terms/{termId} template for full term details.
 */
function registerTermsResource(server: McpServer): void {
  server.resource(
    "terms",
    RESOURCE_URIS.TERMS,
    {
      description:
        "Browse all organizational glossary terms. " +
        "Returns a summary listing with term names, categories, and confidence levels. " +
        "Use individual term URIs for full details including code locations.",
      mimeType: "application/json",
    },
    async (_uri) => {
      // Stub: return placeholder data
      return {
        contents: [
          {
            uri: RESOURCE_URIS.TERMS,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                description:
                  "Organizational glossary terms — maps planning terminology to code locations.",
                count: 0,
                terms: [],
                hint: "No terms loaded yet. Use the add_term tool or bootstrap tool to populate the glossary.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ─── lingo://terms/{termId} ────────────────────────────────────────────

/**
 * Template resource: Individual glossary term detail by ID.
 *
 * Returns the full term data including definition, aliases, code locations,
 * source metadata, and confidence level.
 */
function registerTermByIdResource(server: McpServer): void {
  const template = new ResourceTemplate("lingo://terms/{termId}", {
    list: undefined,
  });

  server.resource(
    RESOURCE_TEMPLATE_NAMES.TERM_BY_ID,
    template,
    {
      description:
        "Retrieve a specific glossary term by its unique ID. " +
        "Returns the full term including definition, aliases, code locations, " +
        "source traceability, and confidence level.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const termId = variables.termId as string;

      // Stub: return placeholder indicating term not found
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                error: "Term not found",
                termId,
                hint: "No glossary data loaded. Use the add_term tool to create terms.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ─── lingo://categories ────────────────────────────────────────────────

/**
 * Static resource: Lists all unique categories across glossary terms.
 *
 * Useful for AI tools to understand the domain structure of an
 * organization's terminology before querying for specific terms.
 */
function registerCategoriesResource(server: McpServer): void {
  server.resource(
    "categories",
    RESOURCE_URIS.CATEGORIES,
    {
      description:
        "Browse all glossary term categories. " +
        "Returns the list of domain categories (e.g., 'authentication', 'billing') " +
        "with term counts for each. Useful for understanding the org's domain structure.",
      mimeType: "application/json",
    },
    async (_uri) => {
      // Stub: return empty categories
      return {
        contents: [
          {
            uri: RESOURCE_URIS.CATEGORIES,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                description:
                  "Domain categories for organizational glossary terms.",
                count: 0,
                categories: [],
                hint: "No categories yet. Categories are derived from glossary terms.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

// ─── lingo://status ────────────────────────────────────────────────────

/**
 * Static resource: Glossary store metadata and statistics.
 *
 * Provides a quick overview of the glossary's current state — useful for
 * AI tools to understand what data is available before making queries.
 */
function registerStatusResource(server: McpServer): void {
  server.resource(
    "status",
    RESOURCE_URIS.STATUS,
    {
      description:
        "Glossary store status and statistics. " +
        "Shows the number of terms, categories, adapters in use, " +
        "and when the glossary was last modified.",
      mimeType: "application/json",
    },
    async (_uri) => {
      // Stub: return placeholder status
      return {
        contents: [
          {
            uri: RESOURCE_URIS.STATUS,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                version: "0.1.0",
                organization: "default",
                totalTerms: 0,
                totalCategories: 0,
                adapters: [],
                confidenceBreakdown: {
                  manual: 0,
                  "ai-suggested": 0,
                  "ai-verified": 0,
                },
                lastModified: null,
                hint: "Glossary is empty. Use bootstrap or add_term to get started.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
