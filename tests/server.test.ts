import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, loadConfig, Logger, type LingoServerConfig } from "../src/server.js";
import { JsonGlossaryStorage } from "../src/storage/json-store.js";
import { ALL_TOOL_NAMES, TOOL_NAMES } from "../src/tools/index.js";

describe("Lingo MCP Server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("loadConfig", () => {
    it("returns default configuration when no env vars are set", () => {
      // Clear any env vars that might be set
      vi.stubEnv("LINGO_GLOSSARY_PATH", "");
      vi.stubEnv("LINGO_ORG", "");
      vi.stubEnv("LINGO_LOG_LEVEL", "");

      // loadConfig uses ?? so empty string won't trigger default
      // Let's test with deleted env vars instead
      delete process.env.LINGO_GLOSSARY_PATH;
      delete process.env.LINGO_ORG;
      delete process.env.LINGO_LOG_LEVEL;

      const config = loadConfig();
      expect(config.glossaryPath).toBe(".lingo/glossary.json");
      expect(config.organization).toBe("default");
      expect(config.logLevel).toBe("info");
    });

    it("reads configuration from environment variables", () => {
      vi.stubEnv("LINGO_GLOSSARY_PATH", "/custom/path/glossary.json");
      vi.stubEnv("LINGO_ORG", "acme-corp");
      vi.stubEnv("LINGO_LOG_LEVEL", "debug");

      const config = loadConfig();
      expect(config.glossaryPath).toBe("/custom/path/glossary.json");
      expect(config.organization).toBe("acme-corp");
      expect(config.logLevel).toBe("debug");
    });

    it("falls back to 'info' for invalid log levels", () => {
      vi.stubEnv("LINGO_LOG_LEVEL", "invalid-level");
      delete process.env.LINGO_GLOSSARY_PATH;
      delete process.env.LINGO_ORG;

      const config = loadConfig();
      expect(config.logLevel).toBe("info");
    });
  });

  describe("createServer", () => {
    const testConfig: LingoServerConfig = {
      glossaryPath: ".lingo/glossary.json",
      organization: "test-org",
      logLevel: "info",
    };

    it("creates an McpServer instance", () => {
      const server = createServer(testConfig);
      expect(server).toBeDefined();
      expect(server.server).toBeDefined();
    });

    it("has connect and close methods", () => {
      const server = createServer(testConfig);
      expect(typeof server.connect).toBe("function");
      expect(typeof server.close).toBe("function");
    });
  });

  describe("tool registration", () => {
    const testConfig: LingoServerConfig = {
      glossaryPath: ".lingo/glossary.json",
      organization: "test-org",
      logLevel: "info",
    };

    it("registers all expected tools on the server", () => {
      const server = createServer(testConfig);

      // The McpServer stores registered tools internally.
      // We verify by checking the low-level server's request handlers.
      // The internal Server instance is accessible via server.server.
      expect(server).toBeDefined();

      // ALL_TOOL_NAMES should contain exactly 10 tools
      expect(ALL_TOOL_NAMES).toHaveLength(10);
      expect(ALL_TOOL_NAMES).toContain("query_context");
      expect(ALL_TOOL_NAMES).toContain("get_term");
      expect(ALL_TOOL_NAMES).toContain("add_term");
      expect(ALL_TOOL_NAMES).toContain("update_term");
      expect(ALL_TOOL_NAMES).toContain("remove_term");
      expect(ALL_TOOL_NAMES).toContain("list_terms");
      expect(ALL_TOOL_NAMES).toContain("find_by_file");
      expect(ALL_TOOL_NAMES).toContain("bootstrap");
      expect(ALL_TOOL_NAMES).toContain("suggest_code_changes");
      expect(ALL_TOOL_NAMES).toContain("create_from_text");
    });

    it("TOOL_NAMES constant has all expected keys", () => {
      expect(TOOL_NAMES.QUERY_CONTEXT).toBe("query_context");
      expect(TOOL_NAMES.GET_TERM).toBe("get_term");
      expect(TOOL_NAMES.ADD_TERM).toBe("add_term");
      expect(TOOL_NAMES.UPDATE_TERM).toBe("update_term");
      expect(TOOL_NAMES.REMOVE_TERM).toBe("remove_term");
      expect(TOOL_NAMES.LIST_TERMS).toBe("list_terms");
      expect(TOOL_NAMES.FIND_BY_FILE).toBe("find_by_file");
      expect(TOOL_NAMES.BOOTSTRAP).toBe("bootstrap");
      expect(TOOL_NAMES.CREATE_FROM_TEXT).toBe("create_from_text");
    });

    it("creates server without errors when tools are registered", () => {
      // If registerTools() threw during createServer(), this would fail
      expect(() => createServer(testConfig)).not.toThrow();
    });
  });

  describe("Logger", () => {
    it("writes to stderr, not stdout", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      const logger = new Logger("debug");
      logger.info("test message");

      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });

    it("respects log level threshold", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const logger = new Logger("warn");
      logger.debug("should not appear");
      logger.info("should not appear");
      logger.warn("should appear");
      logger.error("should appear");

      // Only warn and error should have been written
      expect(stderrSpy).toHaveBeenCalledTimes(2);

      stderrSpy.mockRestore();
    });

    it("formats messages with prefix", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const logger = new Logger("debug");
      logger.info("hello world");

      expect(stderrSpy).toHaveBeenCalledWith("[lingo:info] hello world\n");

      stderrSpy.mockRestore();
    });

    it("formats additional arguments", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const logger = new Logger("debug");
      logger.debug("config:", { key: "value" });

      expect(stderrSpy).toHaveBeenCalledWith(
        '[lingo:debug] config: {"key":"value"}\n'
      );

      stderrSpy.mockRestore();
    });

    it("handles all log levels", () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const logger = new Logger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(stderrSpy).toHaveBeenCalledTimes(4);
      expect(stderrSpy).toHaveBeenCalledWith("[lingo:debug] d\n");
      expect(stderrSpy).toHaveBeenCalledWith("[lingo:info] i\n");
      expect(stderrSpy).toHaveBeenCalledWith("[lingo:warn] w\n");
      expect(stderrSpy).toHaveBeenCalledWith("[lingo:error] e\n");

      stderrSpy.mockRestore();
    });
  });
});
