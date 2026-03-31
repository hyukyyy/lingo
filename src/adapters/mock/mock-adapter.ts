/**
 * Mock PM Adapter — Stub/In-Memory PM Tool Adapter
 *
 * A minimal, fully-functional PM adapter backed by in-memory data.
 * Serves two purposes:
 *
 * 1. **Proof of extensibility** — demonstrates that a new adapter can
 *    implement the PMAdapter interface and register with the adapter
 *    registry without modifying any core logic files.
 *
 * 2. **Testing aid** — provides a deterministic, zero-dependency adapter
 *    that tests can use without needing a real PM tool API.
 *
 * This follows the exact same structural pattern as the Notion adapter:
 *   - `mock-adapter.ts` — adapter implementation (this file)
 *   - `factory.ts`      — factory registration for the adapter registry
 *   - `index.ts`        — barrel exports
 */

import type {
  PMAdapter,
  PMProject,
  PMItem,
  PMItemFilterOptions,
  PaginationOptions,
  PaginatedResult,
  NormalizedTerm,
  ExtractionOptions,
  ExtractionResult,
  ExtractionStats,
  ConnectionStatus,
  PMTermCandidate,
  PMTermExtractionOptions,
  PMItemType,
} from "../types.js";

// ─── Configuration ────────────────────────────────────────────────

/**
 * Configuration for the MockPMAdapter.
 *
 * Since this is an in-memory adapter, configuration is minimal —
 * just seed data and optional behavioral flags.
 */
export interface MockPMAdapterConfig {
  /** Seed projects to populate the adapter with */
  projects?: PMProject[];

  /** Seed items to populate the adapter with */
  items?: PMItem[];

  /** If true, testConnection() returns a failure status */
  simulateConnectionFailure?: boolean;
}

// ─── Adapter ──────────────────────────────────────────────────────

/**
 * In-memory PM adapter for testing and extensibility demonstration.
 *
 * Implements the full PMAdapter interface backed by in-memory arrays.
 * All data access methods (list, get, filter, paginate) work correctly
 * against the seed data, making this adapter suitable for integration tests.
 */
export class MockPMAdapter implements PMAdapter {
  readonly name = "mock";
  readonly displayName = "Mock PM Tool";

  private projects: PMProject[];
  private items: PMItem[];
  private simulateConnectionFailure: boolean;

  constructor(config?: MockPMAdapterConfig) {
    this.projects = config?.projects ?? [];
    this.items = config?.items ?? [];
    this.simulateConnectionFailure = config?.simulateConnectionFailure ?? false;
  }

  // ── Connection ────────────────────────────────────────────────

  async testConnection(): Promise<ConnectionStatus> {
    if (this.simulateConnectionFailure) {
      return {
        connected: false,
        message: "Mock connection failure (simulated)",
      };
    }

    return {
      connected: true,
      message: "Connected to mock PM tool",
      details: {
        projectCount: this.projects.length,
        itemCount: this.items.length,
      },
    };
  }

  // ── Projects ──────────────────────────────────────────────────

  async listProjects(
    options?: PaginationOptions
  ): Promise<PaginatedResult<PMProject>> {
    return this.paginate(this.projects, options);
  }

  async getProject(projectId: string): Promise<PMProject | undefined> {
    return this.projects.find((p) => p.externalId === projectId);
  }

  // ── Items ─────────────────────────────────────────────────────

  async listItems(
    projectId: string,
    options?: PMItemFilterOptions
  ): Promise<PaginatedResult<PMItem>> {
    let filtered = this.items.filter((i) => i.projectId === projectId);

    // Apply filters
    if (options?.statusCategory) {
      filtered = filtered.filter(
        (i) => i.status.category === options.statusCategory
      );
    }
    if (options?.labels?.length) {
      filtered = filtered.filter((i) =>
        i.labels.some((l) => options.labels!.includes(l))
      );
    }
    if (options?.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      filtered = filtered.filter(
        (i) =>
          i.title.toLowerCase().includes(query) ||
          i.description?.toLowerCase().includes(query)
      );
    }
    if (options?.updatedAfter) {
      const threshold = new Date(options.updatedAfter).getTime();
      filtered = filtered.filter(
        (i) => i.updatedAt && new Date(i.updatedAt).getTime() > threshold
      );
    }

    return this.paginate(filtered, options);
  }

  async getItem(itemId: string): Promise<PMItem | undefined> {
    return this.items.find((i) => i.externalId === itemId);
  }

  // ── Terminology Pipeline ──────────────────────────────────────

  async extractItems(options?: ExtractionOptions): Promise<PMItem[]> {
    let result = [...this.items];

    if (options?.itemTypes?.length) {
      result = result.filter((i) => options.itemTypes!.includes(i.type));
    }
    if (options?.project) {
      result = result.filter(
        (i) =>
          i.projectId === options.project || i.project === options.project
      );
    }
    if (options?.maxItems) {
      result = result.slice(0, options.maxItems);
    }

    return result;
  }

  normalizeToTerms(items: PMItem[]): NormalizedTerm[] {
    return items
      .filter((item) => item.title.trim().length > 0)
      .map((item) => ({
        name: item.title,
        definition: item.description ?? `A ${item.type} from mock PM tool`,
        aliases: [],
        category: item.project,
        tags: [...item.labels],
        source: {
          adapter: this.name,
          externalId: item.externalId,
          url: item.url,
        },
        confidence: "ai-suggested" as const,
      }));
  }

  async extract(options?: ExtractionOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const items = await this.extractItems(options);
    const terms = this.normalizeToTerms(items);

    // Compute per-type stats
    const itemsByType: Partial<Record<PMItemType, number>> = {};
    for (const item of items) {
      itemsByType[item.type] = (itemsByType[item.type] ?? 0) + 1;
    }

    const stats: ExtractionStats = {
      itemsFetched: items.length,
      termsProduced: terms.length,
      itemsSkipped: items.length - terms.length,
      durationMs: Date.now() - startTime,
      itemsByType,
    };

    return {
      adapterName: this.name,
      extractedAt: new Date().toISOString(),
      terms,
      stats,
      warnings: [],
    };
  }

  async extractTerminology(
    projectId: string,
    options?: PMTermExtractionOptions
  ): Promise<PMTermCandidate[]> {
    let projectItems = this.items.filter((i) => i.projectId === projectId);

    if (options?.maxItems) {
      projectItems = projectItems.slice(0, options.maxItems);
    }

    // Build frequency map by normalized term
    const termMap = new Map<string, PMTermCandidate>();
    for (const item of projectItems) {
      const key = item.title.toLowerCase().trim();
      if (!key) continue;

      const existing = termMap.get(key);
      if (existing) {
        existing.frequency++;
        existing.source.itemIds.push(item.externalId);

        // Merge context if descriptions differ
        if (
          options?.includeDescriptions !== false &&
          item.description &&
          !existing.contextSnippet.includes(item.description)
        ) {
          existing.contextSnippet += ` | ${item.description}`;
        }
      } else {
        termMap.set(key, {
          term: item.title,
          contextSnippet: item.description ?? "",
          source: {
            adapter: this.name,
            projectId,
            itemIds: [item.externalId],
            url: item.url,
          },
          frequency: 1,
          suggestedCategory: item.project,
          suggestedAliases: [],
        });
      }
    }

    const minFreq = options?.minFrequency ?? 1;
    return Array.from(termMap.values())
      .filter((t) => t.frequency >= minFreq)
      .sort((a, b) => b.frequency - a.frequency);
  }

  // ── Helpers ───────────────────────────────────────────────────

  /**
   * Generic pagination helper for any array of items.
   */
  private paginate<T>(
    allItems: T[],
    options?: PaginationOptions
  ): PaginatedResult<T> {
    const pageSize = options?.pageSize ?? 50;
    const startIndex = options?.cursor ? parseInt(options.cursor, 10) : 0;
    const page = allItems.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < allItems.length;

    return {
      items: page,
      hasMore,
      nextCursor: hasMore ? String(startIndex + pageSize) : undefined,
      totalCount: allItems.length,
    };
  }
}
