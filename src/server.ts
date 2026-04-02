#!/usr/bin/env node

/**
 * Lingo MCP Server — Entry Point
 *
 * Initializes the MCP server instance, connects via stdio transport,
 * and handles graceful startup/shutdown.
 *
 * This file is the executable entry point when running `lingo` as a CLI tool
 * or when configured as an MCP server in Claude Code / Cursor settings.
 *
 * Usage:
 *   npx lingo                       # Run the MCP server via stdio
 *   node dist/server.js             # Direct invocation
 *
 * The server exposes:
 *   - Tools for querying/managing organizational glossary terms
 *   - Resources for browsing the glossary store
 *
 * Configuration:
 *   LINGO_GLOSSARY_PATH — path to glossary JSON file (default: .lingo/glossary.json)
 *   LINGO_ORG           — organization name for new glossary stores (default: "default")
 *   LINGO_LOG_LEVEL     — logging level: debug | info | warn | error (default: "info")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonGlossaryStorage } from "./storage/json-store.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { registerBuiltinAdapters } from "./adapters/builtin-adapters.js";
import { SCMAdapterRegistry } from "./adapters/scm/registry.js";
import { registerBuiltinSCMAdapters } from "./adapters/scm/builtin-scm-adapters.js";

// ─── Constants ───────────────────────────────────────────────────────

const SERVER_NAME = "lingo";
const SERVER_VERSION = "0.1.0";

/**
 * Supported log levels in order of verbosity.
 */
type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─── Configuration ───────────────────────────────────────────────────

export interface LingoServerConfig {
  /** Path to the glossary JSON file */
  glossaryPath: string;
  /** Organization name for new glossary stores */
  organization: string;
  /** Logging level */
  logLevel: LogLevel;
  /** Adapter tokens from environment variables */
  adapterTokens: {
    github?: string;
    notion?: string;
  };
}

/**
 * Reads configuration from environment variables with sensible defaults.
 */
export function loadConfig(): LingoServerConfig {
  const logLevel = (process.env.LINGO_LOG_LEVEL ?? "info") as LogLevel;

  return {
    glossaryPath: process.env.LINGO_GLOSSARY_PATH ?? ".lingo/glossary.json",
    organization: process.env.LINGO_ORG ?? "default",
    logLevel: LOG_LEVELS[logLevel] !== undefined ? logLevel : "info",
    adapterTokens: {
      github: process.env.GITHUB_TOKEN,
      notion: process.env.NOTION_API_TOKEN,
    },
  };
}

// ─── Logger ──────────────────────────────────────────────────────────

/**
 * Simple stderr logger that respects the configured log level.
 * MCP servers MUST NOT write to stdout (that's the transport channel),
 * so all diagnostic output goes to stderr.
 */
export class Logger {
  private readonly threshold: number;

  constructor(level: LogLevel = "info") {
    this.threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  }

  debug(message: string, ...args: unknown[]): void {
    if (LOG_LEVELS.debug >= this.threshold) {
      process.stderr.write(`[lingo:debug] ${message}${this.formatArgs(args)}\n`);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (LOG_LEVELS.info >= this.threshold) {
      process.stderr.write(`[lingo:info] ${message}${this.formatArgs(args)}\n`);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (LOG_LEVELS.warn >= this.threshold) {
      process.stderr.write(`[lingo:warn] ${message}${this.formatArgs(args)}\n`);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (LOG_LEVELS.error >= this.threshold) {
      process.stderr.write(`[lingo:error] ${message}${this.formatArgs(args)}\n`);
    }
  }

  private formatArgs(args: unknown[]): string {
    if (args.length === 0) return "";
    return " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  }
}

// ─── Server Factory ──────────────────────────────────────────────────

/**
 * Creates and configures the Lingo MCP server instance.
 *
 * This is separated from `startServer()` to allow testing the server
 * configuration without starting the transport.
 *
 * @param config  - Server configuration
 * @param storage - Optional pre-initialized storage instance (created from config if not provided)
 */
export function createServer(
  config: LingoServerConfig,
  storage?: JsonGlossaryStorage
): McpServer {
  const resolvedStorage =
    storage ?? new JsonGlossaryStorage(config.glossaryPath);

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: [
        "Lingo is an organizational context layer that maps planning terminology to code locations.",
        "Use the available tools to search, browse, and manage your organization's glossary of terms.",
        "Each term connects a planning/product concept (e.g., 'Sprint Velocity') to specific code locations.",
      ].join(" "),
    }
  );

  // Create adapter registries and register built-in adapter factories
  const adapterRegistry = new AdapterRegistry();
  registerBuiltinAdapters(adapterRegistry);

  const scmAdapterRegistry = new SCMAdapterRegistry();
  registerBuiltinSCMAdapters(scmAdapterRegistry);

  // Register all tool handlers with storage backend and adapter registries
  registerTools(server, resolvedStorage, {
    adapterRegistry,
    scmAdapterRegistry,
    adapterTokens: config.adapterTokens,
  });

  // Register all resource handlers
  registerResources(server);

  return server;
}

// ─── Lifecycle ───────────────────────────────────────────────────────

/**
 * Starts the Lingo MCP server on stdio transport.
 *
 * Handles:
 * - Server creation and configuration
 * - Stdio transport connection
 * - Graceful shutdown on SIGINT / SIGTERM / stdin close
 *
 * @returns A cleanup function that can be called to shut down the server
 */
export async function startServer(
  config?: LingoServerConfig
): Promise<{ server: McpServer; cleanup: () => Promise<void> }> {
  const resolvedConfig = config ?? loadConfig();
  const logger = new Logger(resolvedConfig.logLevel);

  logger.info(`Starting ${SERVER_NAME} v${SERVER_VERSION}`);
  logger.debug("Configuration:", resolvedConfig);

  // Initialize glossary storage
  const storage = new JsonGlossaryStorage(resolvedConfig.glossaryPath);
  await storage.load(resolvedConfig.organization);
  logger.info(`Glossary loaded from ${storage.getFilePath()}`);

  // Create the MCP server with initialized storage
  const server = createServer(resolvedConfig, storage);

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Track whether we've already started shutdown to avoid double-cleanup
  let isShuttingDown = false;

  /**
   * Gracefully shuts down the server and transport.
   */
  async function cleanup(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Shutting down...");

    try {
      await server.close();
      logger.info("Server closed successfully");
    } catch (err) {
      logger.error("Error during shutdown:", (err as Error).message);
    }
  }

  // Register signal handlers for graceful shutdown
  const onSignal = () => {
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Handle stdin closing (parent process died)
  process.stdin.on("close", () => {
    logger.debug("stdin closed, initiating shutdown");
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  // Connect transport to server and start
  await server.connect(transport);
  logger.info("Server connected via stdio transport");

  return { server, cleanup };
}

// ─── Main ────────────────────────────────────────────────────────────

/**
 * Main entry point — invoked when this file is executed directly.
 */
async function main(): Promise<void> {
  try {
    await startServer();
  } catch (err) {
    process.stderr.write(
      `[lingo:fatal] Failed to start server: ${(err as Error).message}\n`
    );
    process.exit(1);
  }
}

// Run main when executed directly (not imported as a module)
// In ESM, there's no require.main === module, so we use a simple check
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("/server.js") ||
    process.argv[1].endsWith("/server.ts") ||
    process.argv[1].endsWith("dist/server.js") ||
    process.argv[1].endsWith("/lingo"));

if (isDirectExecution) {
  main();
}
