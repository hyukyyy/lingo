import { describe, it, expect } from "vitest";
import { TypeScriptParser } from "../../src/scanner/parsers/typescript-parser.js";

describe("TypeScriptParser", () => {
  const parser = new TypeScriptParser();

  describe("module-level concept", () => {
    it("should extract a module concept for every file", () => {
      const concepts = parser.parse("src/foo.ts", "const x = 1;");
      const module = concepts.find((c) => c.kind === "module");
      expect(module).toBeDefined();
      expect(module!.name).toBe("foo");
      expect(module!.filePath).toBe("src/foo.ts");
      expect(module!.kind).toBe("module");
      expect(module!.language).toBe("typescript");
    });

    it("should extract description from JSDoc comment", () => {
      const code = `/**
 * This is the auth module.
 */
export class Auth {}`;
      const concepts = parser.parse("src/auth.ts", code);
      const module = concepts.find((c) => c.kind === "module");
      expect(module!.description).toBe("This is the auth module.");
    });

    it("should detect whether the module has exports", () => {
      const withExport = parser.parse("a.ts", "export const x = 1;");
      expect(withExport.find((c) => c.kind === "module")!.exported).toBe(true);

      const withoutExport = parser.parse("b.ts", "const x = 1;");
      expect(withoutExport.find((c) => c.kind === "module")!.exported).toBe(false);
    });
  });

  describe("class extraction", () => {
    it("should extract exported class", () => {
      const code = `export class AuthService {
  constructor() {}
}`;
      const concepts = parser.parse("src/auth.ts", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.name).toBe("AuthService");
      expect(cls!.exported).toBe(true);
      expect(cls!.line).toBe(1);
    });

    it("should extract internal class", () => {
      const code = `class InternalHelper {
  doWork() {}
}`;
      const concepts = parser.parse("src/helper.ts", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.name).toBe("InternalHelper");
      expect(cls!.exported).toBe(false);
    });

    it("should extract abstract class", () => {
      const code = `export abstract class BaseService {
  abstract handle(): void;
}`;
      const concepts = parser.parse("src/base.ts", code);
      const cls = concepts.find((c) => c.kind === "class");
      expect(cls).toBeDefined();
      expect(cls!.metadata.isAbstract).toBe(true);
    });

    it("should extract class methods", () => {
      const code = `export class UserService {
  async getUser(id: string): Promise<User> {
    return db.find(id);
  }

  static createDefault(): UserService {
    return new UserService();
  }
}`;
      const concepts = parser.parse("src/user.ts", code);
      const methods = concepts.filter(
        (c) => c.kind === "function" && c.metadata.isMethod
      );
      expect(methods).toHaveLength(2);

      const getUser = methods.find((m) => m.name === "getUser");
      expect(getUser).toBeDefined();
      expect(getUser!.metadata.isAsync).toBe(true);
      expect(getUser!.parentId).toBe("src/user.ts#UserService");

      const createDefault = methods.find((m) => m.name === "createDefault");
      expect(createDefault).toBeDefined();
      expect(createDefault!.metadata.isStatic).toBe(true);
    });
  });

  describe("function extraction", () => {
    it("should extract exported function declaration", () => {
      const code = `export function processData(input: string): string {
  return input.trim();
}`;
      const concepts = parser.parse("src/process.ts", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "processData"
      );
      expect(fn).toBeDefined();
      expect(fn!.exported).toBe(true);
      expect(fn!.metadata.isArrow).toBe(false);
    });

    it("should extract async function", () => {
      const code = `export async function fetchData(url: string): Promise<Data> {
  return fetch(url);
}`;
      const concepts = parser.parse("src/fetch.ts", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "fetchData"
      );
      expect(fn).toBeDefined();
      expect(fn!.metadata.isAsync).toBe(true);
    });

    it("should extract arrow function", () => {
      const code = `export const createHandler = (config: Config) => {
  return new Handler(config);
};`;
      const concepts = parser.parse("src/handler.ts", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "createHandler"
      );
      expect(fn).toBeDefined();
      expect(fn!.metadata.isArrow).toBe(true);
      expect(fn!.exported).toBe(true);
    });

    it("should extract async arrow function", () => {
      const code = `export const fetchItems = async (query: string) => {
  return [];
};`;
      const concepts = parser.parse("src/items.ts", code);
      const fn = concepts.find(
        (c) => c.kind === "function" && c.name === "fetchItems"
      );
      expect(fn).toBeDefined();
      expect(fn!.metadata.isAsync).toBe(true);
      expect(fn!.metadata.isArrow).toBe(true);
    });
  });

  describe("interface and type extraction", () => {
    it("should extract exported interface", () => {
      const code = `export interface UserConfig {
  name: string;
  role: string;
}`;
      const concepts = parser.parse("src/types.ts", code);
      const iface = concepts.find(
        (c) => c.kind === "interface" && c.name === "UserConfig"
      );
      expect(iface).toBeDefined();
      expect(iface!.exported).toBe(true);
      expect(iface!.metadata.isTypeAlias).toBe(false);
    });

    it("should extract type alias", () => {
      const code = `export type UserId = string;`;
      const concepts = parser.parse("src/types.ts", code);
      const typeAlias = concepts.find(
        (c) => c.kind === "interface" && c.name === "UserId"
      );
      expect(typeAlias).toBeDefined();
      expect(typeAlias!.metadata.isTypeAlias).toBe(true);
    });

    it("should NOT extract interfaces from JavaScript files", () => {
      const code = `export interface Config {
  key: string;
}`;
      // Even though JS doesn't have interfaces, the regex might match.
      // But the parser should skip them for .js files
      const concepts = parser.parse("src/config.js", code);
      const iface = concepts.find((c) => c.kind === "interface");
      expect(iface).toBeUndefined();
    });
  });

  describe("enum extraction", () => {
    it("should extract exported enum", () => {
      const code = `export enum Status {
  Active = "active",
  Inactive = "inactive",
}`;
      const concepts = parser.parse("src/status.ts", code);
      const enumConcept = concepts.find((c) => c.kind === "enum");
      expect(enumConcept).toBeDefined();
      expect(enumConcept!.name).toBe("Status");
      expect(enumConcept!.exported).toBe(true);
    });

    it("should extract const enum", () => {
      const code = `export const enum Direction {
  Up,
  Down,
}`;
      const concepts = parser.parse("src/dir.ts", code);
      const enumConcept = concepts.find((c) => c.kind === "enum");
      expect(enumConcept).toBeDefined();
      expect(enumConcept!.metadata.isConst).toBe(true);
    });
  });

  describe("constant extraction", () => {
    it("should extract exported constants", () => {
      const code = `export const MAX_RETRIES = 3;
export const BASE_URL = "https://api.example.com";`;
      const concepts = parser.parse("src/config.ts", code);
      const constants = concepts.filter((c) => c.kind === "constant");
      expect(constants).toHaveLength(2);
      expect(constants.map((c) => c.name)).toContain("MAX_RETRIES");
      expect(constants.map((c) => c.name)).toContain("BASE_URL");
    });

    it("should NOT count arrow functions as constants", () => {
      const code = `export const handler = (req: Request) => {
  return new Response();
};`;
      const concepts = parser.parse("src/handler.ts", code);
      const constants = concepts.filter((c) => c.kind === "constant");
      expect(constants).toHaveLength(0);
    });
  });

  describe("concept IDs and parent relationships", () => {
    it("should build proper concept IDs", () => {
      const code = `export class Foo {
  bar() {}
}
export function baz() {}`;
      const concepts = parser.parse("src/foo.ts", code);

      expect(concepts.find((c) => c.name === "Foo")!.id).toBe("src/foo.ts#Foo");
      expect(concepts.find((c) => c.name === "bar")!.id).toBe(
        "src/foo.ts#Foo.bar"
      );
      expect(concepts.find((c) => c.name === "baz")!.id).toBe("src/foo.ts#baz");
    });

    it("should set parentId correctly", () => {
      const code = `export class Service {
  handle() {}
}`;
      const concepts = parser.parse("src/svc.ts", code);
      const method = concepts.find((c) => c.name === "handle");
      expect(method!.parentId).toBe("src/svc.ts#Service");
    });
  });

  describe("deduplication", () => {
    it("should not produce duplicate concept IDs", () => {
      const code = `export const handler = (req: Request) => {
  return new Response();
};`;
      const concepts = parser.parse("src/handler.ts", code);
      const ids = concepts.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("integration with sample fixture", () => {
    it("should correctly parse the auth-service fixture", async () => {
      const { readFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      const fixturePath = resolve(
        import.meta.dirname,
        "../fixtures/sample-project/src/auth-service.ts"
      );
      const content = await readFile(fixturePath, "utf-8");
      const concepts = parser.parse("src/auth-service.ts", content);

      // Should have: module, AuthConfig interface, TokenPayload type,
      // AuthRole enum, MAX_LOGIN_ATTEMPTS const, SESSION_TIMEOUT const,
      // AuthService class with 4 methods, hashPassword function, createToken arrow fn,
      // _internalHelper function
      const kinds = concepts.map((c) => c.kind);
      expect(kinds).toContain("module");
      expect(kinds).toContain("class");
      expect(kinds).toContain("interface");
      expect(kinds).toContain("enum");
      expect(kinds).toContain("function");
      expect(kinds).toContain("constant");

      // Verify the class was found
      const authService = concepts.find(
        (c) => c.kind === "class" && c.name === "AuthService"
      );
      expect(authService).toBeDefined();
      expect(authService!.exported).toBe(true);

      // Verify methods
      const methods = concepts.filter(
        (c) => c.parentId === "src/auth-service.ts#AuthService" && c.kind === "function"
      );
      expect(methods.length).toBeGreaterThanOrEqual(3);
      expect(methods.map((m) => m.name)).toContain("login");
      expect(methods.map((m) => m.name)).toContain("logout");
      expect(methods.map((m) => m.name)).toContain("validateToken");
    });
  });
});
