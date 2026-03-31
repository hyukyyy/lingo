/**
 * Impact Analysis Module
 *
 * Given a planning term, queries the knowledge base to retrieve all
 * associated code locations and their mappings, returning a structured
 * list of affected files and symbols.
 *
 * This is the core "organizational context" query — when an AI tool
 * encounters an org-specific term (e.g., "Sprint Velocity"), this module
 * tells it exactly which files, classes, and functions implement that concept.
 *
 * Usage:
 *   const result = analyzeImpact(storage, "sprint velocity");
 *   console.log(result.affectedFiles); // Files implementing the concept
 *   console.log(result.summary);       // Quick stats
 */

import type { JsonGlossaryStorage } from "../storage/json-store.js";
import type {
  GlossaryTerm,
  CodeLocation,
  CodeRelationship,
  ConfidenceLevel,
} from "../models/glossary.js";

// ─── Result Types ─────────────────────────────────────────────────────

/**
 * Summary of a glossary term that matched the impact analysis query.
 */
export interface MatchedTermSummary {
  /** The term's unique ID */
  id: string;

  /** The term's canonical name */
  name: string;

  /** The term's definition */
  definition: string;

  /** Confidence level of this term's mappings */
  confidence: ConfidenceLevel;

  /** Number of code locations this term references */
  codeLocationCount: number;
}

/**
 * A symbol found within an affected file.
 * Represents a specific code element (function, class, etc.) linked to a term.
 */
export interface AffectedSymbol {
  /** The symbol name (e.g., "AuthService", "calculateVelocity") */
  name: string;

  /** How this symbol relates to the planning term */
  relationship: CodeRelationship;

  /** Optional precise line range in the file */
  lineRange?: { start: number; end: number };

  /** Optional note explaining why this symbol is relevant */
  note?: string;

  /** ID of the glossary term that links to this symbol */
  fromTermId: string;

  /** Name of the glossary term that links to this symbol */
  fromTermName: string;
}

/**
 * An affected file — a file in the codebase that implements, uses, or
 * relates to the queried planning term.
 */
export interface AffectedFile {
  /** Relative file path from project root */
  filePath: string;

  /** All symbols within this file linked to matching terms */
  symbols: AffectedSymbol[];

  /** Unique relationship types found in this file */
  relationships: CodeRelationship[];

  /** IDs of the glossary terms that reference this file */
  termIds: string[];

  /** Names of the glossary terms that reference this file */
  termNames: string[];
}

/**
 * Statistical summary of the impact analysis result.
 */
export interface ImpactSummary {
  /** How many glossary terms matched the query */
  totalMatchedTerms: number;

  /** How many distinct files are affected */
  totalAffectedFiles: number;

  /** Total number of symbols across all affected files */
  totalSymbols: number;

  /** Breakdown of how many code locations have each relationship type */
  relationshipBreakdown: Partial<Record<CodeRelationship, number>>;

  /** Breakdown of how many matched terms have each confidence level */
  confidenceBreakdown: Partial<Record<ConfidenceLevel, number>>;
}

/**
 * The complete result of an impact analysis query.
 */
export interface ImpactAnalysisResult {
  /** The original search term/query */
  query: string;

  /** Whether any matches were found */
  found: boolean;

  /** Glossary terms that matched the query */
  matchedTerms: MatchedTermSummary[];

  /** Deduplicated list of affected files with their symbols */
  affectedFiles: AffectedFile[];

  /** Statistical summary */
  summary: ImpactSummary;
}

// ─── Configuration ────────────────────────────────────────────────────

/**
 * Options for controlling impact analysis behavior.
 */
export interface ImpactAnalysisOptions {
  /**
   * Maximum number of matched terms to consider.
   * Limits the breadth of the analysis. Default: 20.
   */
  maxTerms?: number;

  /**
   * If true, only include terms with code locations.
   * Terms without mappings are excluded from results. Default: true.
   */
  requireCodeLocations?: boolean;

  /**
   * Filter by confidence level — only include terms at or above this level.
   * Order: "manual" > "ai-verified" > "ai-suggested"
   * Default: undefined (include all confidence levels).
   */
  minConfidence?: ConfidenceLevel;

  /**
   * Filter results to only include specific relationship types.
   * Default: undefined (include all relationships).
   */
  relationships?: CodeRelationship[];

  /**
   * Filter results to only include files matching these path patterns.
   * Simple substring matching. Default: undefined (include all files).
   */
  filePathFilter?: string;
}

// ─── Confidence Ordering ──────────────────────────────────────────────

/**
 * Confidence levels ranked from lowest to highest.
 * Used for minConfidence filtering.
 */
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  "ai-suggested": 0,
  "ai-verified": 1,
  "manual": 2,
};

/**
 * Check if a confidence level meets the minimum threshold.
 */
function meetsConfidenceThreshold(
  actual: ConfidenceLevel,
  minimum: ConfidenceLevel
): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[minimum];
}

// ─── Core Analysis Function ───────────────────────────────────────────

/**
 * Analyze the impact of a planning term across the codebase.
 *
 * Given a planning term (e.g., "Sprint Velocity", "auth guard", "billing module"),
 * queries the knowledge base to find all matching glossary terms and their
 * associated code locations, returning a structured view of affected files
 * and symbols.
 *
 * The function:
 * 1. Searches the glossary for terms matching the query (name, aliases, definition)
 * 2. Collects all code locations from matching terms
 * 3. Deduplicates and groups by file path
 * 4. Returns a structured result with files, symbols, and summary statistics
 *
 * @param storage - The loaded glossary storage instance
 * @param query - The planning term or phrase to analyze
 * @param options - Optional analysis configuration
 * @returns Structured impact analysis result
 */
export function analyzeImpact(
  storage: JsonGlossaryStorage,
  query: string,
  options?: ImpactAnalysisOptions,
): ImpactAnalysisResult {
  const maxTerms = options?.maxTerms ?? 20;
  const requireCodeLocations = options?.requireCodeLocations ?? true;
  const minConfidence = options?.minConfidence;
  const relationshipFilter = options?.relationships
    ? new Set(options.relationships)
    : undefined;
  const filePathFilter = options?.filePathFilter?.toLowerCase();

  // Step 1: Search the glossary for matching terms
  let matchingTerms = storage.searchTerms(query);

  // Apply confidence filter
  if (minConfidence) {
    matchingTerms = matchingTerms.filter((term) =>
      meetsConfidenceThreshold(term.confidence, minConfidence)
    );
  }

  // Optionally filter out terms with no code locations
  if (requireCodeLocations) {
    matchingTerms = matchingTerms.filter(
      (term) => term.codeLocations.length > 0
    );
  }

  // Limit number of terms
  matchingTerms = matchingTerms.slice(0, maxTerms);

  // Step 2: Build matched term summaries
  const matchedTerms: MatchedTermSummary[] = matchingTerms.map((term) => ({
    id: term.id,
    name: term.name,
    definition: term.definition,
    confidence: term.confidence,
    codeLocationCount: term.codeLocations.length,
  }));

  // Step 3: Collect all code locations grouped by file path
  const fileMap = new Map<string, {
    symbols: AffectedSymbol[];
    termIds: Set<string>;
    termNames: Set<string>;
  }>();

  for (const term of matchingTerms) {
    for (const loc of term.codeLocations) {
      // Apply relationship filter
      if (relationshipFilter && !relationshipFilter.has(loc.relationship)) {
        continue;
      }

      // Apply file path filter
      if (filePathFilter && !loc.filePath.toLowerCase().includes(filePathFilter)) {
        continue;
      }

      // Get or create file entry
      let fileEntry = fileMap.get(loc.filePath);
      if (!fileEntry) {
        fileEntry = {
          symbols: [],
          termIds: new Set(),
          termNames: new Set(),
        };
        fileMap.set(loc.filePath, fileEntry);
      }

      // Add term references
      fileEntry.termIds.add(term.id);
      fileEntry.termNames.add(term.name);

      // Add symbol if present
      if (loc.symbol) {
        // Avoid duplicate symbols from the same term
        const isDuplicate = fileEntry.symbols.some(
          (s) =>
            s.name === loc.symbol &&
            s.fromTermId === term.id &&
            s.relationship === loc.relationship
        );

        if (!isDuplicate) {
          fileEntry.symbols.push({
            name: loc.symbol,
            relationship: loc.relationship,
            lineRange: loc.lineRange,
            note: loc.note,
            fromTermId: term.id,
            fromTermName: term.name,
          });
        }
      } else {
        // File-level reference without a specific symbol
        // Still track it as an affected file (already done above via fileMap)
        // Add a file-level entry so the relationship is visible
        const isDuplicate = fileEntry.symbols.some(
          (s) =>
            s.name === "(file-level)" &&
            s.fromTermId === term.id &&
            s.relationship === loc.relationship
        );

        if (!isDuplicate) {
          fileEntry.symbols.push({
            name: "(file-level)",
            relationship: loc.relationship,
            lineRange: loc.lineRange,
            note: loc.note,
            fromTermId: term.id,
            fromTermName: term.name,
          });
        }
      }
    }
  }

  // Step 4: Build affected files list
  const affectedFiles: AffectedFile[] = Array.from(fileMap.entries())
    .map(([filePath, entry]) => {
      // Collect unique relationships in this file
      const relationships = [
        ...new Set(entry.symbols.map((s) => s.relationship)),
      ];

      return {
        filePath,
        symbols: entry.symbols,
        relationships,
        termIds: [...entry.termIds],
        termNames: [...entry.termNames],
      };
    })
    // Sort by number of symbols descending (most referenced files first),
    // then alphabetically by path for stability
    .sort((a, b) => {
      if (b.symbols.length !== a.symbols.length) {
        return b.symbols.length - a.symbols.length;
      }
      return a.filePath.localeCompare(b.filePath);
    });

  // Step 5: Build summary statistics
  const relationshipBreakdown: Partial<Record<CodeRelationship, number>> = {};
  const confidenceBreakdown: Partial<Record<ConfidenceLevel, number>> = {};
  let totalSymbols = 0;

  for (const file of affectedFiles) {
    for (const symbol of file.symbols) {
      totalSymbols++;
      relationshipBreakdown[symbol.relationship] =
        (relationshipBreakdown[symbol.relationship] ?? 0) + 1;
    }
  }

  for (const term of matchedTerms) {
    confidenceBreakdown[term.confidence] =
      (confidenceBreakdown[term.confidence] ?? 0) + 1;
  }

  const summary: ImpactSummary = {
    totalMatchedTerms: matchedTerms.length,
    totalAffectedFiles: affectedFiles.length,
    totalSymbols,
    relationshipBreakdown,
    confidenceBreakdown,
  };

  return {
    query,
    found: matchedTerms.length > 0,
    matchedTerms,
    affectedFiles,
    summary,
  };
}
