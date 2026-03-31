/**
 * MCP Configuration Manifest Tests
 *
 * Validates that the mcp.json server manifest and client setup configs
 * are structurally correct and consistent with the actual server implementation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALL_TOOL_NAMES, TOOL_NAMES } from "../src/tools/index.js";
import { RESOURCE_URIS, STATIC_RESOURCE_URIS, RESOURCE_TEMPLATE_NAMES } from "../src/resources/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

function loadJson(relativePath: string): unknown {
  const fullPath = join(ROOT, relativePath);
  const raw = readFileSync(fullPath, "utf-8");
  return JSON.parse(raw);
}

function loadMcpManifest() {
  return loadJson("mcp.json") as {
    server: {
      name: string;
      version: string;
      description: string;
      command: string;
      args: string[];
      transport: string;
      env: Record<string, { description: string; default: string; required: boolean }>;
    };
    capabilities: {
      tools: Record<string, { description: string }>;
      resources: Record<string, { description: string }>;
    };
    instructions: string;
  };
}

interface ClientConfig {
  mcpServers: {
    lingo: {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
  };
}

function loadClientConfig(name: string): ClientConfig {
  return loadJson(`examples/mcp-configs/${name}.json`) as ClientConfig;
}

// ─── Server Manifest (mcp.json) ───────────────────────────────────────

describe("mcp.json server manifest", () => {
  it("exists at project root", () => {
    expect(existsSync(join(ROOT, "mcp.json"))).toBe(true);
  });

  it("is valid JSON", () => {
    expect(() => loadMcpManifest()).not.toThrow();
  });

  describe("server metadata", () => {
    it("has correct server name", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.name).toBe("lingo");
    });

    it("has version matching package.json", () => {
      const manifest = loadMcpManifest();
      const pkg = loadJson("package.json") as { version: string };
      expect(manifest.server.version).toBe(pkg.version);
    });

    it("has a meaningful description", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.description).toBeTruthy();
      expect(manifest.server.description.length).toBeGreaterThan(20);
    });

    it("uses npx as the command", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.command).toBe("npx");
    });

    it("points to @lingo/mcp-server package", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.args).toContain("@lingo/mcp-server");
    });

    it("uses stdio transport", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.transport).toBe("stdio");
    });
  });

  describe("environment variables", () => {
    it("declares LINGO_GLOSSARY_PATH", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.env.LINGO_GLOSSARY_PATH).toBeDefined();
      expect(manifest.server.env.LINGO_GLOSSARY_PATH.default).toBe(".lingo/glossary.json");
      expect(manifest.server.env.LINGO_GLOSSARY_PATH.required).toBe(false);
    });

    it("declares LINGO_ORG", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.env.LINGO_ORG).toBeDefined();
      expect(manifest.server.env.LINGO_ORG.default).toBe("default");
      expect(manifest.server.env.LINGO_ORG.required).toBe(false);
    });

    it("declares LINGO_LOG_LEVEL", () => {
      const manifest = loadMcpManifest();
      expect(manifest.server.env.LINGO_LOG_LEVEL).toBeDefined();
      expect(manifest.server.env.LINGO_LOG_LEVEL.default).toBe("info");
      expect(manifest.server.env.LINGO_LOG_LEVEL.required).toBe(false);
    });

    it("env defaults match server.ts loadConfig() defaults", () => {
      const manifest = loadMcpManifest();
      // These should match the defaults in src/server.ts loadConfig()
      expect(manifest.server.env.LINGO_GLOSSARY_PATH.default).toBe(".lingo/glossary.json");
      expect(manifest.server.env.LINGO_ORG.default).toBe("default");
      expect(manifest.server.env.LINGO_LOG_LEVEL.default).toBe("info");
    });
  });

  describe("capabilities — tools", () => {
    it("lists all registered tools", () => {
      const manifest = loadMcpManifest();
      const manifestToolNames = Object.keys(manifest.capabilities.tools);

      for (const toolName of ALL_TOOL_NAMES) {
        expect(manifestToolNames).toContain(toolName);
      }
    });

    it("does not list unknown tools", () => {
      const manifest = loadMcpManifest();
      const manifestToolNames = Object.keys(manifest.capabilities.tools);

      for (const toolName of manifestToolNames) {
        expect(ALL_TOOL_NAMES).toContain(toolName);
      }
    });

    it("every tool has a description", () => {
      const manifest = loadMcpManifest();
      for (const [name, tool] of Object.entries(manifest.capabilities.tools)) {
        expect(tool.description, `Tool ${name} should have a description`).toBeTruthy();
        expect(tool.description.length, `Tool ${name} description should be meaningful`).toBeGreaterThan(10);
      }
    });
  });

  describe("capabilities — resources", () => {
    it("lists all static resource URIs", () => {
      const manifest = loadMcpManifest();
      const manifestResourceUris = Object.keys(manifest.capabilities.resources);

      for (const uri of STATIC_RESOURCE_URIS) {
        expect(manifestResourceUris).toContain(uri);
      }
    });

    it("lists the term-by-id template resource", () => {
      const manifest = loadMcpManifest();
      const manifestResourceUris = Object.keys(manifest.capabilities.resources);
      expect(manifestResourceUris).toContain(RESOURCE_URIS.TERM_BY_ID);
    });

    it("every resource has a description", () => {
      const manifest = loadMcpManifest();
      for (const [uri, resource] of Object.entries(manifest.capabilities.resources)) {
        expect(resource.description, `Resource ${uri} should have a description`).toBeTruthy();
      }
    });
  });

  describe("instructions", () => {
    it("provides server instructions", () => {
      const manifest = loadMcpManifest();
      expect(manifest.instructions).toBeTruthy();
      expect(manifest.instructions.length).toBeGreaterThan(50);
    });

    it("mentions key concepts", () => {
      const manifest = loadMcpManifest();
      expect(manifest.instructions.toLowerCase()).toContain("glossary");
      expect(manifest.instructions.toLowerCase()).toContain("term");
    });
  });
});

// ─── Client Configs ──────────────────────────────────────────────────

describe("client setup configs", () => {
  const CLIENT_CONFIGS = [
    "claude-code",
    "cursor",
    "claude-desktop",
    "local-dev",
    "node-direct",
  ];

  for (const configName of CLIENT_CONFIGS) {
    describe(`${configName}.json`, () => {
      it("exists", () => {
        const path = join(ROOT, `examples/mcp-configs/${configName}.json`);
        expect(existsSync(path)).toBe(true);
      });

      it("is valid JSON", () => {
        expect(() => loadClientConfig(configName)).not.toThrow();
      });

      it("has mcpServers.lingo entry", () => {
        const config = loadClientConfig(configName);
        expect(config.mcpServers).toBeDefined();
        expect(config.mcpServers.lingo).toBeDefined();
      });

      it("specifies a command", () => {
        const config = loadClientConfig(configName);
        expect(config.mcpServers.lingo.command).toBeTruthy();
        expect(typeof config.mcpServers.lingo.command).toBe("string");
      });

      it("specifies args as an array", () => {
        const config = loadClientConfig(configName);
        expect(Array.isArray(config.mcpServers.lingo.args)).toBe(true);
      });
    });
  }

  describe("consistency across client configs", () => {
    it("all production configs use the same command", () => {
      const claudeCode = loadClientConfig("claude-code");
      const cursor = loadClientConfig("cursor");
      const claudeDesktop = loadClientConfig("claude-desktop");

      expect(claudeCode.mcpServers.lingo.command).toBe("npx");
      expect(cursor.mcpServers.lingo.command).toBe("npx");
      expect(claudeDesktop.mcpServers.lingo.command).toBe("npx");
    });

    it("all production configs point to @lingo/mcp-server", () => {
      const claudeCode = loadClientConfig("claude-code");
      const cursor = loadClientConfig("cursor");
      const claudeDesktop = loadClientConfig("claude-desktop");

      expect(claudeCode.mcpServers.lingo.args).toContain("@lingo/mcp-server");
      expect(cursor.mcpServers.lingo.args).toContain("@lingo/mcp-server");
      expect(claudeDesktop.mcpServers.lingo.args).toContain("@lingo/mcp-server");
    });

    it("local-dev config uses tsx for hot-reload", () => {
      const localDev = loadClientConfig("local-dev");
      expect(localDev.mcpServers.lingo.command).toBe("npx");
      expect(localDev.mcpServers.lingo.args).toContain("tsx");
      expect(localDev.mcpServers.lingo.args).toContain("src/server.ts");
    });

    it("node-direct config uses node command", () => {
      const nodeDirect = loadClientConfig("node-direct");
      expect(nodeDirect.mcpServers.lingo.command).toBe("node");
    });

    it("production configs have consistent env defaults", () => {
      const claudeCode = loadClientConfig("claude-code");
      const cursor = loadClientConfig("cursor");
      const claudeDesktop = loadClientConfig("claude-desktop");

      // All should default to the same glossary path
      expect(claudeCode.mcpServers.lingo.env?.LINGO_GLOSSARY_PATH).toBe(".lingo/glossary.json");
      expect(cursor.mcpServers.lingo.env?.LINGO_GLOSSARY_PATH).toBe(".lingo/glossary.json");
      expect(claudeDesktop.mcpServers.lingo.env?.LINGO_GLOSSARY_PATH).toBe(".lingo/glossary.json");
    });
  });
});

// ─── README ──────────────────────────────────────────────────────────

describe("mcp-configs README", () => {
  it("exists", () => {
    expect(existsSync(join(ROOT, "examples/mcp-configs/README.md"))).toBe(true);
  });

  it("references all client config files", () => {
    const readme = readFileSync(join(ROOT, "examples/mcp-configs/README.md"), "utf-8");
    expect(readme).toContain("claude-code.json");
    expect(readme).toContain("cursor.json");
    expect(readme).toContain("claude-desktop.json");
    expect(readme).toContain("local-dev.json");
    expect(readme).toContain("node-direct.json");
  });

  it("documents all environment variables", () => {
    const readme = readFileSync(join(ROOT, "examples/mcp-configs/README.md"), "utf-8");
    expect(readme).toContain("LINGO_GLOSSARY_PATH");
    expect(readme).toContain("LINGO_ORG");
    expect(readme).toContain("LINGO_LOG_LEVEL");
  });
});
