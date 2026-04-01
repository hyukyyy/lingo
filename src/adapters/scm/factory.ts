/**
 * GitHub SCM Adapter Factory Registration
 *
 * Provides an SCMAdapterFactoryRegistration object for the GitHub SCM adapter,
 * following the same pattern used by PM adapters (e.g., notion/factory.ts,
 * json/factory.ts).
 *
 * This bridges the abstract SCM adapter registry and the concrete
 * GitHubSCMAdapter implementation. Core code imports only this factory
 * registration (or the builtin-scm-adapters module), never the
 * GitHubSCMAdapter class directly.
 */

import type { SCMAdapterFactoryRegistration } from "./registry.js";
import { createGitHubSCMAdapter } from "./github-scm-adapter.js";

/**
 * Factory registration metadata for the GitHub SCM adapter.
 *
 * Use this with an SCM adapter registry's `registerFactory()` to make the
 * GitHub adapter available for factory-based creation.
 *
 * @example
 *   import { githubSCMFactoryRegistration } from "./scm/factory.js";
 *   scmRegistry.registerFactory(githubSCMFactoryRegistration);
 */
export const githubSCMFactoryRegistration: SCMAdapterFactoryRegistration = {
  name: "github",
  displayName: "GitHub",
  description:
    "Connects to GitHub repositories to analyze pull requests, " +
    "extract terminology from code changes, and learn from PR metadata.",
  factory: createGitHubSCMAdapter,
};
