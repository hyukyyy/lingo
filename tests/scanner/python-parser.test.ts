import { describe, it, expect } from "vitest";
import { PythonParser } from "../../src/scanner/parsers/python-parser.js";

describe("PythonParser", () => {
  const parser = new PythonParser();

  describe("module-level concept", () => {
    it("should extract a module concept for every file", () => {
      const concepts = parser.parse("scripts/deploy.py", "x = 1");
      const module = concepts.find((c) => c.kind === "module");
      expect(module).toBeDefined();
      expect(module!.name).toBe("deploy");
      expect(module!.language).toBe("python");
    });

    it("should extract description from module docstring", () => {
      const code = `"""This is the deploy module."""

import os`;
      const concepts = parser.parse("deploy.py", code);
      const module = concepts.find((c) => c.kind === "module");
      expect(module!.description).toBe("This is the deploy module.");
    });

    it("should handle multi-line module docstring", () => {
      const code = `"""
Deployment script for the sample project.

Handles building, testing, and deploying the application.
"""

import os`;
      const concepts = parser.parse("deploy.py", code);
      const module = concepts.find((c) => c.kind === "module");
      expect(module!.description).toBe(
        "Deployment script for the sample project."
      );
    });
  });

  describe("class extraction", () => {
    it("should extract class with base classes", () => {
      const code = `class MyService(BaseService):
    """A service implementation."""

    def handle(self):
        pass`;
      const concepts = parser.parse("svc.py", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.name).toBe("MyService");
      expect(cls!.metadata.bases).toBe("BaseService");
    });

    it("should extract class without bases", () => {
      const code = `class Config:
    """Configuration container."""
    pass`;
      const concepts = parser.parse("config.py", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.name).toBe("Config");
    });

    it("should mark underscore-prefixed classes as non-exported", () => {
      const code = `class _InternalHelper:
    pass`;
      const concepts = parser.parse("helper.py", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls!.exported).toBe(false);
    });

    it("should extract class methods", () => {
      const code = `class UserService:
    def get_user(self, user_id: str):
        """Get a user by ID."""
        pass

    async def update_user(self, user_id: str, data: dict):
        """Update user data."""
        pass

    def _internal_method(self):
        pass`;
      const concepts = parser.parse("user.py", code);
      const methods = concepts.filter(
        (c) => c.kind === "function" && c.metadata.isMethod
      );
      expect(methods).toHaveLength(3);

      const getUser = methods.find((m) => m.name === "get_user");
      expect(getUser).toBeDefined();
      expect(getUser!.description).toBe("Get a user by ID.");
      expect(getUser!.parentId).toBe("user.py#UserService");

      const updateUser = methods.find((m) => m.name === "update_user");
      expect(updateUser!.metadata.isAsync).toBe(true);

      const internal = methods.find((m) => m.name === "_internal_method");
      expect(internal!.metadata.isPrivate).toBe(true);
      expect(internal!.exported).toBe(false);
    });

    it("should extract docstrings for methods", () => {
      const code = `class Foo:
    def bar(self):
        """Does bar things."""
        pass`;
      const concepts = parser.parse("foo.py", code);
      const method = concepts.find((c) => c.name === "bar");
      expect(method!.description).toBe("Does bar things.");
    });
  });

  describe("function extraction", () => {
    it("should extract top-level function", () => {
      const code = `def process_data(input_text: str) -> str:
    """Process and clean input text."""
    return input_text.strip()`;
      const concepts = parser.parse("process.py", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "process_data"
      );
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
      expect(fn!.description).toBe("Process and clean input text.");
    });

    it("should extract async function", () => {
      const code = `async def fetch_items(query: str):
    """Fetch items from the API."""
    pass`;
      const concepts = parser.parse("fetch.py", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "fetch_items"
      );
      expect(fn).toBeDefined();
      expect(fn!.metadata.isAsync).toBe(true);
    });

    it("should mark underscore-prefixed functions as private", () => {
      const code = `def _internal_helper():
    pass`;
      const concepts = parser.parse("helper.py", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "_internal_helper"
      );
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(false);
      expect(fn!.metadata.isPrivate).toBe(true);
    });
  });

  describe("constant extraction", () => {
    it("should extract ALL_CAPS constants", () => {
      const code = `MAX_RETRIES = 3
DEFAULT_ENV = "staging"
some_variable = "not a constant"`;
      const concepts = parser.parse("config.py", code);
      const constants = concepts.filter((c) => c.kind === "constant");
      expect(constants).toHaveLength(2);
      expect(constants.map((c) => c.name)).toContain("MAX_RETRIES");
      expect(constants.map((c) => c.name)).toContain("DEFAULT_ENV");
    });

    it("should not extract lowercase as constants", () => {
      const code = `my_var = 42
another = "hello"`;
      const concepts = parser.parse("vars.py", code);
      const constants = concepts.filter((c) => c.kind === "constant");
      expect(constants).toHaveLength(0);
    });
  });

  describe("integration with sample fixture", () => {
    it("should correctly parse the deploy.py fixture", async () => {
      const { readFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const fixturePath = resolve(
        import.meta.dirname,
        "../fixtures/sample-project/scripts/deploy.py"
      );
      const content = await readFile(fixturePath, "utf-8");
      const concepts = parser.parse("scripts/deploy.py", content);

      // Should have: module, 2 classes, their methods, 2 top-level functions,
      // 2 constants, 1 internal function
      const kinds = concepts.map((c) => c.kind);
      expect(kinds).toContain("module");
      expect(kinds).toContain("class");
      expect(kinds).toContain("function");
      expect(kinds).toContain("constant");

      // Verify classes
      const classes = concepts.filter((c) => c.kind === "class");
      expect(classes).toHaveLength(2);
      expect(classes.map((c) => c.name)).toContain("DeployConfig");
      expect(classes.map((c) => c.name)).toContain("DeployRunner");

      // Verify top-level functions
      const topFunctions = concepts.filter(
        (c) => c.kind === "function" && !c.metadata.isMethod
      );
      expect(topFunctions.map((f) => f.name)).toContain("get_version");
      expect(topFunctions.map((f) => f.name)).toContain("run_tests");
      expect(topFunctions.map((f) => f.name)).toContain("_internal_cleanup");

      // Verify constants
      const constants = concepts.filter((c) => c.kind === "constant");
      expect(constants.map((c) => c.name)).toContain("MAX_RETRIES");
      expect(constants.map((c) => c.name)).toContain("DEFAULT_ENV");
    });
  });
});
