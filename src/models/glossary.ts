/**
 * Glossary Term Data Model
 *
 * Defines the core data types for organizational terminology ↔ code location
 * mappings. A glossary term captures how an organization refers to concepts
 * in planning/product discussions and where those concepts live in code.
 */

/**
 * A reference to a specific location in the codebase where a term is
 * implemented, used, or relevant.
 */
export interface CodeLocation {
  /** Relative file path from project root (e.g., "src/services/auth.ts") */
  filePath: string;

  /** Optional symbol name (function, class, variable, etc.) */
  symbol?: string;

  /** Optional line range for precise location */
  lineRange?: {
    start: number;
    end: number;
  };

  /** How this code location relates to the term */
  relationship: CodeRelationship;

  /** Optional human-readable note about why this location is relevant */
  note?: string;
}

/**
 * Describes how a code location relates to a glossary term.
 * - "defines": The primary definition/implementation of the concept
 * - "implements": An implementation detail or concrete realization
 * - "uses": Code that uses/consumes the concept
 * - "tests": Test code that verifies the concept
 * - "configures": Configuration related to the concept
 */
export type CodeRelationship =
  | "defines"
  | "implements"
  | "uses"
  | "tests"
  | "configures";

/**
 * Confidence level for how a term mapping was established.
 * - "manual": Explicitly created/verified by a human
 * - "ai-suggested": Suggested by AI bootstrap, not yet verified
 * - "ai-verified": Suggested by AI and confirmed by a human
 */
export type ConfidenceLevel = "manual" | "ai-suggested" | "ai-verified";

/**
 * The source/origin of a glossary term — where it was discovered or defined.
 */
export interface TermSource {
  /** The adapter/system that provided this term (e.g., "notion", "linear", "manual") */
  adapter: string;

  /** Optional external ID for traceability back to the source system */
  externalId?: string;

  /** Optional URL linking back to the source */
  url?: string;
}

/**
 * A single glossary term mapping organizational language to code locations.
 *
 * This is the core data unit of Lingo — it captures the bidirectional
 * relationship between how people talk about concepts and where those
 * concepts exist in code.
 */
export interface GlossaryTerm {
  /** Unique identifier for this term (UUID v4) */
  id: string;

  /** The canonical name of the term (e.g., "Sprint Velocity") */
  name: string;

  /** Human-readable definition explaining what this term means in the org's context */
  definition: string;

  /** Alternative names, abbreviations, or colloquialisms for this term */
  aliases: string[];

  /** Code locations where this term is implemented/used */
  codeLocations: CodeLocation[];

  /** Optional category/domain grouping (e.g., "authentication", "billing") */
  category?: string;

  /** Optional tags for flexible classification */
  tags: string[];

  /** Where this term originated */
  source: TermSource;

  /** How confident we are in the term-to-code mapping */
  confidence: ConfidenceLevel;

  /** ISO 8601 timestamp of when this term was created */
  createdAt: string;

  /** ISO 8601 timestamp of when this term was last updated */
  updatedAt: string;
}

/**
 * The top-level structure for the glossary data file.
 * Contains metadata about the glossary and all terms.
 */
export interface GlossaryStore {
  /** Schema version for forward compatibility */
  version: string;

  /** Organization identifier or project name */
  organization: string;

  /** ISO 8601 timestamp of last modification */
  lastModified: string;

  /** All glossary terms, keyed by their unique ID */
  terms: Record<string, GlossaryTerm>;
}

/**
 * Current schema version. Bumped when the data model changes
 * in a way that requires migration.
 */
export const GLOSSARY_SCHEMA_VERSION = "1.0.0";

/**
 * Creates a new empty GlossaryStore with default values.
 */
export function createEmptyStore(organization: string): GlossaryStore {
  return {
    version: GLOSSARY_SCHEMA_VERSION,
    organization,
    lastModified: new Date().toISOString(),
    terms: {},
  };
}

/**
 * Creates a new GlossaryTerm with sensible defaults.
 * Requires at minimum a name and definition.
 */
export function createTerm(
  params: Pick<GlossaryTerm, "name" | "definition"> &
    Partial<Omit<GlossaryTerm, "id" | "createdAt" | "updatedAt">>
): GlossaryTerm {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    name: params.name,
    definition: params.definition,
    aliases: params.aliases ?? [],
    codeLocations: params.codeLocations ?? [],
    category: params.category,
    tags: params.tags ?? [],
    source: params.source ?? { adapter: "manual" },
    confidence: params.confidence ?? "manual",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Generates a UUID v4 identifier.
 * Uses crypto.randomUUID when available, falls back to a simple implementation.
 */
function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
