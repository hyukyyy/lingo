/**
 * JSON File Storage Layer
 *
 * Provides persistence functions for loading and saving the glossary
 * to a JSON file on disk. This is the primary storage backend for
 * single-project use cases.
 *
 * Design decisions:
 * - JSON for human readability and easy debugging
 * - Atomic writes (write to temp file, then rename) to prevent corruption
 * - Schema version validation on load for forward compatibility
 * - File locking is not implemented (single-process MCP server assumption)
 */

import { readFile, writeFile, rename, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type GlossaryStore,
  type GlossaryTerm,
  type SignalType,
  type CouplingSource,
  SIGNAL_SCORES,
  GLOSSARY_SCHEMA_VERSION,
  createEmptyStore,
  createTerm,
} from "../models/glossary.js";

/** Default filename for the glossary data file */
export const DEFAULT_GLOSSARY_FILENAME = ".lingo/glossary.json";

/**
 * Errors specific to the storage layer.
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: StorageErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export type StorageErrorCode =
  | "FILE_NOT_FOUND"
  | "PARSE_ERROR"
  | "SCHEMA_MISMATCH"
  | "WRITE_ERROR"
  | "VALIDATION_ERROR";

/**
 * JSON-file-backed storage for the glossary.
 *
 * Holds an in-memory copy of the store and syncs to disk on mutations.
 * Designed for single-process access (MCP server).
 */
export class JsonGlossaryStorage {
  private store: GlossaryStore | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  /**
   * Returns the resolved file path this storage instance uses.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Loads the glossary from disk. If the file doesn't exist,
   * creates a new empty store with the given organization name.
   *
   * @param organization - Organization name used when creating a new store
   * @returns The loaded (or newly created) glossary store
   */
  async load(organization = "default"): Promise<GlossaryStore> {
    try {
      await access(this.filePath);
    } catch {
      // File doesn't exist — initialize a new empty store
      this.store = createEmptyStore(organization);
      await this.save();
      return this.store;
    }

    const raw = await readFile(this.filePath, "utf-8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageError(
        `Failed to parse glossary file: ${this.filePath}`,
        "PARSE_ERROR",
        err
      );
    }

    this.store = validateStore(parsed);
    return this.store;
  }

  /**
   * Saves the current in-memory store to disk.
   * Uses atomic write (temp file + rename) to prevent corruption.
   */
  async save(): Promise<void> {
    if (!this.store) {
      throw new StorageError(
        "Cannot save: no store loaded. Call load() first.",
        "WRITE_ERROR"
      );
    }

    this.store.lastModified = new Date().toISOString();

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const content = JSON.stringify(this.store, null, 2) + "\n";
    const tempPath = this.filePath + ".tmp";

    try {
      await writeFile(tempPath, content, "utf-8");
      await rename(tempPath, this.filePath);
    } catch (err) {
      throw new StorageError(
        `Failed to write glossary file: ${this.filePath}`,
        "WRITE_ERROR",
        err
      );
    }
  }

  /**
   * Returns the current in-memory store snapshot.
   * Throws if load() has not been called.
   */
  getStore(): GlossaryStore {
    if (!this.store) {
      throw new StorageError(
        "Store not loaded. Call load() first.",
        "FILE_NOT_FOUND"
      );
    }
    return this.store;
  }

  // ─── Term CRUD Operations ─────────────────────────────────────────

  /**
   * Adds a new term to the glossary and persists to disk.
   *
   * @param params - Term creation parameters (name + definition required)
   * @returns The newly created term
   */
  async addTerm(
    params: Parameters<typeof createTerm>[0]
  ): Promise<GlossaryTerm> {
    const store = this.getStore();
    const term = createTerm(params);
    store.terms[term.id] = term;
    await this.save();
    return term;
  }

  /**
   * Retrieves a term by its ID.
   *
   * @returns The term, or undefined if not found
   */
  getTerm(id: string): GlossaryTerm | undefined {
    return this.getStore().terms[id];
  }

  /**
   * Updates an existing term by merging partial fields.
   * Automatically updates the `updatedAt` timestamp.
   *
   * @param id - The term ID to update
   * @param updates - Partial fields to merge
   * @returns The updated term
   * @throws StorageError if term not found
   */
  async updateTerm(
    id: string,
    updates: Partial<
      Omit<GlossaryTerm, "id" | "createdAt" | "updatedAt">
    >
  ): Promise<GlossaryTerm> {
    const store = this.getStore();
    const existing = store.terms[id];
    if (!existing) {
      throw new StorageError(
        `Term not found: ${id}`,
        "VALIDATION_ERROR"
      );
    }

    const updated: GlossaryTerm = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID override
      createdAt: existing.createdAt, // Prevent createdAt override
      updatedAt: new Date().toISOString(),
    };

    store.terms[id] = updated;
    await this.save();
    return updated;
  }

  /**
   * Removes a term from the glossary by ID.
   *
   * @returns true if the term was found and removed, false otherwise
   */
  async removeTerm(id: string): Promise<boolean> {
    const store = this.getStore();
    if (!store.terms[id]) {
      return false;
    }
    delete store.terms[id];
    await this.save();
    return true;
  }

  /**
   * Returns all terms as an array, optionally filtered.
   */
  listTerms(filter?: TermFilter): GlossaryTerm[] {
    const terms = Object.values(this.getStore().terms);

    if (!filter) {
      return terms;
    }

    return terms.filter((term) => {
      if (filter.category && term.category !== filter.category) {
        return false;
      }
      if (filter.tag && !term.tags.includes(filter.tag)) {
        return false;
      }
      if (filter.confidence && term.confidence !== filter.confidence) {
        return false;
      }
      if (filter.adapter && term.source.adapter !== filter.adapter) {
        return false;
      }
      return true;
    });
  }

  /**
   * Searches terms by name, aliases, and definition text.
   * Simple substring/case-insensitive search — suitable for MCP tool queries.
   *
   * @param query - Search string to match against term names, aliases, and definitions
   * @returns Array of matching terms, sorted by relevance (name match > alias match > definition match)
   */
  searchTerms(query: string): GlossaryTerm[] {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) {
      return [];
    }

    const terms = Object.values(this.getStore().terms);

    const scored = terms
      .map((term) => {
        let score = 0;

        // Exact name match (highest relevance)
        if (term.name.toLowerCase() === normalizedQuery) {
          score += 100;
        }
        // Name contains query
        else if (term.name.toLowerCase().includes(normalizedQuery)) {
          score += 50;
        }

        // Alias exact match
        for (const alias of term.aliases) {
          if (alias.toLowerCase() === normalizedQuery) {
            score += 80;
            break;
          } else if (alias.toLowerCase().includes(normalizedQuery)) {
            score += 40;
            break;
          }
        }

        // Definition contains query
        if (term.definition.toLowerCase().includes(normalizedQuery)) {
          score += 10;
        }

        // Category match
        if (
          term.category &&
          term.category.toLowerCase().includes(normalizedQuery)
        ) {
          score += 20;
        }

        return { term, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map(({ term }) => term);
  }

  /**
   * Finds terms that reference a specific file path in their code locations.
   *
   * @param filePath - The file path to search for (partial match)
   * @returns Array of terms that reference the given file
   */
  findTermsByFile(filePath: string): GlossaryTerm[] {
    const normalized = filePath.toLowerCase();
    return Object.values(this.getStore().terms).filter((term) =>
      term.codeLocations.some((loc) =>
        loc.filePath.toLowerCase().includes(normalized)
      )
    );
  }

  /**
   * Records a coupling signal for a term, increasing its coupling score.
   *
   * Each signal type adds a fixed increment (see SIGNAL_SCORES). Scores cap at 1.0.
   * A time-decay factor is applied if the term hasn't been seen in 6+ months:
   * the existing score is halved before the new signal is added.
   *
   * @param termId    - The ID of the term to update
   * @param signalType - The type of signal being recorded
   * @returns The updated term, or undefined if the term was not found
   */
  async recordSignal(
    termId: string,
    signalType: SignalType
  ): Promise<GlossaryTerm | undefined> {
    const store = this.getStore();
    const term = store.terms[termId];
    if (!term) {
      return undefined;
    }

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const increment = SIGNAL_SCORES[signalType];

    // Initialize coupling if this is the first signal
    if (!term.coupling) {
      term.coupling = {
        score: 0,
        signals: 0,
        sources: [],
        lastSeen: todayIso,
      };
    }

    // Apply time decay: if lastSeen > 6 months ago, halve the score
    const lastSeenDate = new Date(term.coupling.lastSeen);
    const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
    if (now.getTime() - lastSeenDate.getTime() > sixMonthsMs) {
      term.coupling.score = term.coupling.score * 0.5;
    }

    // Add signal increment (capped at 1.0)
    term.coupling.score = Math.min(1.0, term.coupling.score + increment);
    term.coupling.signals += 1;
    term.coupling.lastSeen = todayIso;

    // Update per-source count
    const existing = term.coupling.sources.find((s) => s.type === signalType);
    if (existing) {
      existing.count += 1;
    } else {
      term.coupling.sources.push({ type: signalType, count: 1 } as CouplingSource);
    }

    term.updatedAt = now.toISOString();
    await this.save();
    return term;
  }
}

/**
 * Filter criteria for listing terms.
 */
export interface TermFilter {
  category?: string;
  tag?: string;
  confidence?: GlossaryTerm["confidence"];
  adapter?: string;
}

// ─── Validation ───────────────────────────────────────────────────────

/**
 * Validates that a parsed JSON object conforms to the GlossaryStore schema.
 * Performs structural validation and checks schema version compatibility.
 */
function validateStore(data: unknown): GlossaryStore {
  if (!data || typeof data !== "object") {
    throw new StorageError(
      "Glossary data must be a JSON object",
      "PARSE_ERROR"
    );
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.version !== "string") {
    throw new StorageError(
      "Glossary data missing 'version' field",
      "SCHEMA_MISMATCH"
    );
  }

  // Check major version compatibility
  const [major] = obj.version.split(".");
  const [expectedMajor] = GLOSSARY_SCHEMA_VERSION.split(".");
  if (major !== expectedMajor) {
    throw new StorageError(
      `Incompatible glossary schema version: ${obj.version} (expected ${GLOSSARY_SCHEMA_VERSION})`,
      "SCHEMA_MISMATCH"
    );
  }

  if (typeof obj.organization !== "string") {
    throw new StorageError(
      "Glossary data missing 'organization' field",
      "PARSE_ERROR"
    );
  }

  if (typeof obj.lastModified !== "string") {
    throw new StorageError(
      "Glossary data missing 'lastModified' field",
      "PARSE_ERROR"
    );
  }

  if (!obj.terms || typeof obj.terms !== "object") {
    throw new StorageError(
      "Glossary data missing 'terms' field",
      "PARSE_ERROR"
    );
  }

  // Validate individual terms (lightweight — checks required fields)
  for (const [id, termData] of Object.entries(
    obj.terms as Record<string, unknown>
  )) {
    validateTerm(id, termData);
  }

  return data as GlossaryStore;
}

/**
 * Validates that a term object has the required fields.
 */
function validateTerm(id: string, data: unknown): void {
  if (!data || typeof data !== "object") {
    throw new StorageError(
      `Term '${id}' must be an object`,
      "VALIDATION_ERROR"
    );
  }

  const term = data as Record<string, unknown>;
  const requiredStrings = ["id", "name", "definition", "createdAt", "updatedAt"];

  for (const field of requiredStrings) {
    if (typeof term[field] !== "string") {
      throw new StorageError(
        `Term '${id}' missing required string field: ${field}`,
        "VALIDATION_ERROR"
      );
    }
  }

  if (!Array.isArray(term.aliases)) {
    throw new StorageError(
      `Term '${id}' missing required array field: aliases`,
      "VALIDATION_ERROR"
    );
  }

  if (!Array.isArray(term.codeLocations)) {
    throw new StorageError(
      `Term '${id}' missing required array field: codeLocations`,
      "VALIDATION_ERROR"
    );
  }
}
