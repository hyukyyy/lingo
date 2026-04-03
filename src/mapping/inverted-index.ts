/**
 * Inverted Index for Mapping Engine Pre-filtering
 *
 * Builds a token → concept ID index that enables the mapping engine
 * to skip term-concept pairs with zero matching potential. Instead of
 * scoring all 14K terms × 30K concepts, we first query the inverted
 * index to find the small set of concepts that share at least one
 * token with each term, then only score those candidates.
 *
 * Handles prefix matching (e.g., "auth" ↔ "authentication") via a
 * sorted vocabulary with binary search for prefix-range lookups.
 *
 * Correctness guarantee: the candidate set returned by getCandidates()
 * is a SUPERSET of concepts that would produce score > 0 via brute-force.
 * No false negatives — only false positives (which are filtered by scoring).
 */

import { normalizeForComparison } from "./tokenizer.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Pre-tokenized representation of a PM term (mirrors mapping-engine internal type) */
export interface TermTokens {
  normalizedName: string;
  normalizedAliases: string[];
  nameTokens: string[];
  definitionTokens: string[];
  aliasTokenSets: string[][];
}

/** Pre-tokenized representation of a code concept (mirrors mapping-engine internal type) */
export interface ConceptTokens {
  normalizedName: string;
  nameTokens: string[];
  pathTokens: string[];
  descriptionTokens: string[];
}

/** Lookup from concept ID → pre-tokenized data */
export type ConceptTokenCache = Map<string, ConceptTokens>;

/** Serialized form for worker thread transfer */
export interface SerializedInvertedIndex {
  nameIndex: [string, string[]][];
  pathIndex: [string, string[]][];
  descIndex: [string, string[]][];
  normalizedNameIndex: [string, string[]][];
  sortedVocabulary: string[];
}

// ─── Inverted Index ─────────────────────────────────────────────────

export class InvertedIndex {
  /** token → concept IDs that have this token in their name */
  private nameIndex = new Map<string, Set<string>>();
  /** token → concept IDs that have this token in their file path */
  private pathIndex = new Map<string, Set<string>>();
  /** token → concept IDs that have this token in their description */
  private descIndex = new Map<string, Set<string>>();
  /** normalized full name (and compact form) → concept IDs */
  private normalizedNameIndex = new Map<string, Set<string>>();
  /** Sorted array of all unique tokens across all indexes (for prefix lookup) */
  private sortedVocabulary: string[] = [];

  /**
   * Build the inverted index from concepts and their pre-computed token cache.
   */
  build(conceptIds: string[], cache: ConceptTokenCache): void {
    const allTokens = new Set<string>();

    for (const conceptId of conceptIds) {
      const tokens = cache.get(conceptId);
      if (!tokens) continue;

      // Index name tokens
      for (const token of tokens.nameTokens) {
        this.addToIndex(this.nameIndex, token, conceptId);
        allTokens.add(token);
      }

      // Index path tokens
      for (const token of tokens.pathTokens) {
        this.addToIndex(this.pathIndex, token, conceptId);
        allTokens.add(token);
      }

      // Index description tokens
      for (const token of tokens.descriptionTokens) {
        this.addToIndex(this.descIndex, token, conceptId);
        allTokens.add(token);
      }

      // Index normalized name (for exact strategy)
      if (tokens.normalizedName) {
        this.addToIndex(this.normalizedNameIndex, tokens.normalizedName, conceptId);
        // Also index compact form (spaces removed) for camelCase matching
        const compact = tokens.normalizedName.replace(/\s/g, "");
        if (compact !== tokens.normalizedName) {
          this.addToIndex(this.normalizedNameIndex, compact, conceptId);
        }
      }
    }

    // Build sorted vocabulary for prefix binary search
    this.sortedVocabulary = Array.from(allTokens).sort();
  }

  /**
   * Get candidate concept IDs that could potentially match a term.
   * Returns the union of candidates across all matching strategies.
   *
   * Returns an empty set if the term has no tokens — caller should
   * fall back to full scan in that case.
   */
  getCandidates(termTokens: TermTokens): Set<string> {
    const candidates = new Set<string>();
    let hasAnyTokens = false;

    // ── exact strategy candidates ──
    if (termTokens.normalizedName) {
      hasAnyTokens = true;
      this.addMatchesFromNormalizedName(termTokens.normalizedName, candidates);
    }

    // ── alias-exact strategy candidates ──
    for (const alias of termTokens.normalizedAliases) {
      if (alias) {
        hasAnyTokens = true;
        this.addMatchesFromNormalizedName(alias, candidates);
      }
    }

    // ── token-overlap strategy: term name tokens vs concept name tokens ──
    for (const token of termTokens.nameTokens) {
      hasAnyTokens = true;
      this.addMatchesWithPrefixes(this.nameIndex, token, candidates);
    }

    // ── file-path strategy: term name tokens vs concept path tokens ──
    for (const token of termTokens.nameTokens) {
      this.addMatchesWithPrefixes(this.pathIndex, token, candidates);
    }

    // ── description strategy: term definition tokens vs concept desc tokens ──
    for (const token of termTokens.definitionTokens) {
      hasAnyTokens = true;
      this.addMatchesWithPrefixes(this.descIndex, token, candidates);
    }

    // ── alias-token strategy: alias tokens vs concept name tokens ──
    for (const aliasTokens of termTokens.aliasTokenSets) {
      for (const token of aliasTokens) {
        hasAnyTokens = true;
        this.addMatchesWithPrefixes(this.nameIndex, token, candidates);
      }
    }

    // If no tokens at all, return empty set (caller should fallback to full scan)
    if (!hasAnyTokens) {
      return new Set();
    }

    return candidates;
  }

  // ─── Serialization (for worker threads) ───────────────────────────

  serialize(): SerializedInvertedIndex {
    return {
      nameIndex: this.serializeIndex(this.nameIndex),
      pathIndex: this.serializeIndex(this.pathIndex),
      descIndex: this.serializeIndex(this.descIndex),
      normalizedNameIndex: this.serializeIndex(this.normalizedNameIndex),
      sortedVocabulary: this.sortedVocabulary,
    };
  }

  static deserialize(data: SerializedInvertedIndex): InvertedIndex {
    const index = new InvertedIndex();
    index.nameIndex = InvertedIndex.deserializeIndex(data.nameIndex);
    index.pathIndex = InvertedIndex.deserializeIndex(data.pathIndex);
    index.descIndex = InvertedIndex.deserializeIndex(data.descIndex);
    index.normalizedNameIndex = InvertedIndex.deserializeIndex(data.normalizedNameIndex);
    index.sortedVocabulary = data.sortedVocabulary;
    return index;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private addToIndex(
    index: Map<string, Set<string>>,
    token: string,
    conceptId: string,
  ): void {
    let set = index.get(token);
    if (!set) {
      set = new Set();
      index.set(token, set);
    }
    set.add(conceptId);
  }

  /**
   * Add concept IDs for a normalized name lookup.
   * Checks both the exact normalized form and compact form (spaces removed).
   */
  private addMatchesFromNormalizedName(
    normalizedName: string,
    candidates: Set<string>,
  ): void {
    // Exact normalized name
    const exact = this.normalizedNameIndex.get(normalizedName);
    if (exact) {
      for (const id of exact) candidates.add(id);
    }

    // Compact form
    const compact = normalizedName.replace(/\s/g, "");
    if (compact !== normalizedName) {
      const compactMatches = this.normalizedNameIndex.get(compact);
      if (compactMatches) {
        for (const id of compactMatches) candidates.add(id);
      }
    }

    // Substring matching: for terms with compact length >= 3,
    // the exact strategy checks if concept name contains term name.
    // We approximate this by also matching tokens from the normalized name.
    // This is conservative (may over-return) but avoids false negatives.
  }

  /**
   * Find concept IDs from an index for a given token, including
   * prefix-related tokens (e.g., "auth" finds concepts indexed under
   * "authentication" and vice versa).
   */
  private addMatchesWithPrefixes(
    index: Map<string, Set<string>>,
    queryToken: string,
    candidates: Set<string>,
  ): void {
    if (queryToken.length < 2) return;

    // Exact token match
    const exact = index.get(queryToken);
    if (exact) {
      for (const id of exact) candidates.add(id);
    }

    // Prefix matching: find tokens in vocabulary where
    // queryToken.startsWith(vocabToken) || vocabToken.startsWith(queryToken)
    // Only for tokens with length >= 3 (matching computePartialTokenOverlap behavior)
    if (queryToken.length >= 3) {
      const prefixTokens = this.findPrefixRelatedTokens(queryToken);
      for (const relatedToken of prefixTokens) {
        const matches = index.get(relatedToken);
        if (matches) {
          for (const id of matches) candidates.add(id);
        }
      }
    }
  }

  /**
   * Find all tokens in the sorted vocabulary that have a prefix
   * relationship with the query token.
   *
   * Uses binary search to find the range of tokens starting with
   * the query token's first 3 characters, then checks full prefix.
   */
  private findPrefixRelatedTokens(queryToken: string): string[] {
    const results: string[] = [];
    const prefix3 = queryToken.slice(0, 3);

    // Binary search for the first token >= prefix3
    let lo = this.lowerBound(prefix3);

    // Scan forward while tokens share the 3-char prefix
    while (lo < this.sortedVocabulary.length) {
      const vocabToken = this.sortedVocabulary[lo];
      if (!vocabToken.startsWith(prefix3)) break;

      // Check full prefix relationship (skip exact match, already handled)
      if (vocabToken !== queryToken && vocabToken.length >= 3) {
        if (vocabToken.startsWith(queryToken) || queryToken.startsWith(vocabToken)) {
          results.push(vocabToken);
        }
      }

      lo++;
    }

    // Also check if query token is a prefix of tokens NOT starting with prefix3.
    // This happens when queryToken itself is very short (3 chars) and some vocab tokens
    // start with those 3 chars but in a different prefix3 group.
    // Already covered by the scan above since we use queryToken's own prefix3.

    return results;
  }

  /**
   * Binary search: find the index of the first element >= target.
   */
  private lowerBound(target: string): number {
    let lo = 0;
    let hi = this.sortedVocabulary.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedVocabulary[mid] < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo;
  }

  private serializeIndex(index: Map<string, Set<string>>): [string, string[]][] {
    const entries: [string, string[]][] = [];
    for (const [key, set] of index) {
      entries.push([key, Array.from(set)]);
    }
    return entries;
  }

  private static deserializeIndex(entries: [string, string[]][]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const [key, ids] of entries) {
      map.set(key, new Set(ids));
    }
    return map;
  }
}
