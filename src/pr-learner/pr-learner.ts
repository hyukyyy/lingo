/**
 * PR Learner — Extract organizational terminology from GitHub Pull Requests.
 *
 * Parses PR title, description, and changed files to learn
 * planning term ↔ code location mappings.
 */

import type { CodeLocation, CodeRelationship } from "../models/glossary.js";
import type { JsonGlossaryStorage } from "../storage/json-store.js";
import type { SCMAdapter } from "../adapters/scm/types.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  mergedAt: string | null;
  labels: string[];
  changedFiles: PRFileChange[];
}

export interface PRFileChange {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface LearnResult {
  termsCreated: number;
  termsUpdated: number;
  codeLocationsAdded: number;
  terms: LearnedTerm[];
}

export interface LearnedTerm {
  name: string;
  definition: string;
  codeLocations: CodeLocation[];
  action: "created" | "updated";
  source: string;
}

export interface LearnOptions {
  prUrl: string;
  githubToken?: string;
  dryRun?: boolean;
  /**
   * Pre-fetched PR data (e.g., from an external GitHub MCP server).
   * When provided, skips all fetch operations and uses this data directly.
   */
  prData?: PRInfo;
  /**
   * Optional SCM adapter instance. When provided, uses the adapter to fetch PR
   * data instead of direct GitHub API calls. This enables support for any SCM
   * provider (GitHub, GitLab, etc.) through the adapter abstraction.
   *
   * When omitted, falls back to the built-in direct GitHub API calls
   * (`parsePRUrl` + `fetchPR`), preserving backward compatibility.
   */
  scmAdapter?: SCMAdapter;
}

// ─── GitHub API ─────────────────────────────────────────────────────

interface GitHubPRResponse {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  labels: Array<{ name: string }>;
}

interface GitHubFileResponse {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Parse a GitHub PR URL into owner, repo, and PR number.
 */
export function parsePRUrl(url: string): { owner: string; repo: string; prNumber: number } {
  // Supports: https://github.com/owner/repo/pull/123
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitHub PR URL: ${url}. Expected format: https://github.com/owner/repo/pull/123`);
  }
  return { owner: match[1], repo: match[2], prNumber: parseInt(match[3], 10) };
}

/**
 * Fetch PR information from GitHub API.
 */
export async function fetchPR(
  owner: string,
  repo: string,
  prNumber: number,
  token?: string,
): Promise<PRInfo> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "lingo-mcp-server",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  // Fetch PR details
  const prRes = await fetch(baseUrl, { headers });
  if (!prRes.ok) {
    throw new Error(`GitHub API error ${prRes.status}: ${await prRes.text()}`);
  }
  const prData = (await prRes.json()) as GitHubPRResponse;

  // Fetch changed files
  const filesRes = await fetch(`${baseUrl}/files?per_page=100`, { headers });
  if (!filesRes.ok) {
    throw new Error(`GitHub API error ${filesRes.status}: ${await filesRes.text()}`);
  }
  const filesData = (await filesRes.json()) as GitHubFileResponse[];

  return {
    number: prData.number,
    title: prData.title,
    body: prData.body ?? "",
    url: prData.html_url,
    mergedAt: prData.merged_at,
    labels: prData.labels.map((l) => l.name),
    changedFiles: filesData.map((f) => ({
      filename: f.filename,
      status: f.status as PRFileChange["status"],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}

// ─── Term Extraction ────────────────────────────────────────────────

/**
 * Extract planning terms from PR title and description.
 *
 * Looks for:
 * - PR title as primary term candidate
 * - Sections in description (## headings, bullet points)
 * - Common patterns: "feat: ...", "fix: ...", "[FEATURE] ..."
 */
export function extractTermsFromPR(pr: PRInfo): Array<{ name: string; definition: string }> {
  const terms: Array<{ name: string; definition: string }> = [];

  // Extract from title — strip conventional commit prefix
  const titleClean = pr.title
    .replace(/^(feat|fix|refactor|chore|docs|style|test|perf|ci|build)(\(.+?\))?:\s*/i, "")
    .replace(/^\[.+?\]\s*/, "")
    .trim();

  if (titleClean.length > 3) {
    terms.push({
      name: titleClean,
      definition: `Feature from PR #${pr.number}: ${pr.title}`,
    });
  }

  // Extract from description — look for headings and key sections
  if (pr.body) {
    const lines = pr.body.split("\n");
    for (const line of lines) {
      // ## Section headings as term candidates
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        const heading = headingMatch[1].trim();
        // Skip common non-term headings
        if (!isMetaHeading(heading) && heading.length > 3) {
          terms.push({
            name: heading,
            definition: `Section from PR #${pr.number} description`,
          });
        }
      }
    }
  }

  return terms;
}

function isMetaHeading(heading: string): boolean {
  const meta = [
    "summary", "description", "changes", "test plan", "testing",
    "checklist", "screenshots", "notes", "todo", "context",
    "motivation", "related", "breaking changes", "migration",
    "how to test", "review", "before", "after",
  ];
  return meta.some((m) => heading.toLowerCase().includes(m));
}

/**
 * Map PR changed files to CodeLocation entries.
 */
export function extractCodeLocations(
  files: PRFileChange[],
): CodeLocation[] {
  return files
    .filter((f) => f.status !== "removed")
    .filter((f) => isCodeFile(f.filename))
    .map((f) => ({
      filePath: f.filename,
      relationship: inferRelationship(f) as CodeRelationship,
      note: `From PR: ${f.additions} additions, ${f.deletions} deletions`,
    }));
}

function isCodeFile(filename: string): boolean {
  const codeExtensions = [
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
    ".java", ".kt", ".swift", ".rb", ".php", ".cs",
    ".vue", ".svelte",
  ];
  return codeExtensions.some((ext) => filename.endsWith(ext));
}

function inferRelationship(file: PRFileChange): string {
  if (file.filename.includes("test") || file.filename.includes("spec")) {
    return "tests";
  }
  if (file.filename.includes("config") || file.filename.endsWith(".json") || file.filename.endsWith(".yml")) {
    return "configures";
  }
  if (file.status === "added") {
    return "defines";
  }
  return "implements";
}

// ─── Main Learn Function ────────────────────────────────────────────

/**
 * Learn organizational terminology from a GitHub PR.
 *
 * 1. Fetches PR info from GitHub API (via SCM adapter or direct calls)
 * 2. Extracts planning terms from title/description
 * 3. Maps changed files to code locations
 * 4. Creates or updates glossary terms
 *
 * When `options.scmAdapter` is provided, delegates PR fetching to the adapter.
 * Otherwise, falls back to the built-in direct GitHub API calls for backward
 * compatibility.
 */
export async function learnFromPR(
  storage: JsonGlossaryStorage,
  options: LearnOptions,
): Promise<LearnResult> {
  // Fetch PR info: prData → scmAdapter → direct API (priority chain)
  let pr: PRInfo;

  if (options.prData) {
    // Pre-fetched data (e.g., from external GitHub MCP server)
    pr = options.prData;
  } else if (options.scmAdapter) {
    // Use the SCM adapter — supports any provider (GitHub, GitLab, etc.)
    pr = await options.scmAdapter.fetchPullRequestByUrl(options.prUrl);
  } else {
    // Fallback: direct GitHub API calls (backward compatible)
    const { owner, repo, prNumber } = parsePRUrl(options.prUrl);
    const token = options.githubToken ?? process.env.LINGO_GITHUB_TOKEN ?? undefined;
    pr = await fetchPR(owner, repo, prNumber, token);
  }
  const extractedTerms = extractTermsFromPR(pr);
  const codeLocations = extractCodeLocations(pr.changedFiles);

  if (extractedTerms.length === 0) {
    return { termsCreated: 0, termsUpdated: 0, codeLocationsAdded: 0, terms: [] };
  }

  const result: LearnResult = {
    termsCreated: 0,
    termsUpdated: 0,
    codeLocationsAdded: 0,
    terms: [],
  };

  for (const extracted of extractedTerms) {
    // Check if term already exists
    const existing = storage.searchTerms(extracted.name);
    const exactMatch = existing.find(
      (t) => t.name.toLowerCase() === extracted.name.toLowerCase(),
    );

    if (exactMatch) {
      // Merge code locations
      const newLocations = codeLocations.filter(
        (loc) => !exactMatch.codeLocations.some((el) => el.filePath === loc.filePath),
      );

      if (newLocations.length > 0 && !options.dryRun) {
        await storage.updateTerm(exactMatch.id, {
          codeLocations: [...exactMatch.codeLocations, ...newLocations],
        });
      }

      result.termsUpdated++;
      result.codeLocationsAdded += newLocations.length;
      result.terms.push({
        name: extracted.name,
        definition: exactMatch.definition,
        codeLocations: newLocations,
        action: "updated",
        source: options.prUrl,
      });
    } else {
      // Create new term
      if (!options.dryRun) {
        await storage.addTerm({
          name: extracted.name,
          definition: extracted.definition,
          codeLocations,
          source: { adapter: "github", externalId: options.prUrl, url: options.prUrl },
          confidence: "ai-suggested",
          tags: pr.labels,
        });
      }

      result.termsCreated++;
      result.codeLocationsAdded += codeLocations.length;
      result.terms.push({
        name: extracted.name,
        definition: extracted.definition,
        codeLocations,
        action: "created",
        source: options.prUrl,
      });
    }
  }

  return result;
}
