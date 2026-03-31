/**
 * Tests for the tokenizer utility used by the mapping engine.
 *
 * The tokenizer breaks identifiers and natural language text into
 * normalized tokens for comparison. It handles camelCase, PascalCase,
 * snake_case, kebab-case, file paths, and natural language.
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  tokenizeIdentifier,
  tokenizeFilePath,
  tokenizeSentence,
  computeTokenOverlap,
  normalizeForComparison,
} from "../../src/mapping/tokenizer.js";

describe("tokenizer", () => {
  describe("tokenize()", () => {
    it("tokenizes camelCase identifiers", () => {
      expect(tokenize("authService")).toEqual(["auth", "service"]);
    });

    it("tokenizes PascalCase identifiers", () => {
      expect(tokenize("AuthService")).toEqual(["auth", "service"]);
    });

    it("tokenizes snake_case identifiers", () => {
      expect(tokenize("user_profile")).toEqual(["user", "profile"]);
    });

    it("tokenizes kebab-case identifiers", () => {
      expect(tokenize("user-profile")).toEqual(["user", "profile"]);
    });

    it("tokenizes space-separated words", () => {
      expect(tokenize("User Profile")).toEqual(["user", "profile"]);
    });

    it("handles consecutive uppercase letters (acronyms)", () => {
      expect(tokenize("HTTPClient")).toEqual(["http", "client"]);
      expect(tokenize("parseJSON")).toEqual(["parse", "json"]);
      expect(tokenize("XMLParser")).toEqual(["xml", "parser"]);
    });

    it("handles mixed separators", () => {
      expect(tokenize("user_profile-service")).toEqual(["user", "profile", "service"]);
    });

    it("returns empty array for empty string", () => {
      expect(tokenize("")).toEqual([]);
    });

    it("lowercases all tokens", () => {
      expect(tokenize("MyBigClass")).toEqual(["my", "big", "class"]);
    });

    it("filters out very short tokens (1 char)", () => {
      expect(tokenize("a_b_c")).toEqual([]);
    });

    it("handles numbers in identifiers", () => {
      const tokens = tokenize("config2024");
      expect(tokens).toContain("config");
    });
  });

  describe("tokenizeIdentifier()", () => {
    it("splits camelCase and PascalCase", () => {
      expect(tokenizeIdentifier("getUserProfile")).toEqual(["get", "user", "profile"]);
    });

    it("handles all-uppercase words", () => {
      expect(tokenizeIdentifier("URL")).toEqual(["url"]);
    });

    it("handles underscores and dashes", () => {
      expect(tokenizeIdentifier("get_user_profile")).toEqual(["get", "user", "profile"]);
    });
  });

  describe("tokenizeFilePath()", () => {
    it("extracts tokens from file path components", () => {
      const tokens = tokenizeFilePath("src/auth/auth-service.ts");
      expect(tokens).toContain("auth");
      expect(tokens).toContain("service");
    });

    it("strips file extensions", () => {
      const tokens = tokenizeFilePath("src/models/user.ts");
      expect(tokens).not.toContain("ts");
    });

    it("ignores common directory names like src, lib, dist", () => {
      const tokens = tokenizeFilePath("src/lib/auth/service.ts");
      expect(tokens).not.toContain("src");
      expect(tokens).not.toContain("lib");
    });
  });

  describe("tokenizeSentence()", () => {
    it("splits by whitespace and punctuation", () => {
      const tokens = tokenizeSentence("The user profile service handles login.");
      expect(tokens).toContain("user");
      expect(tokens).toContain("profile");
      expect(tokens).toContain("service");
      expect(tokens).toContain("login");
    });

    it("filters stop words", () => {
      const tokens = tokenizeSentence("The user is a member of the team");
      expect(tokens).not.toContain("the");
      expect(tokens).not.toContain("is");
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("of");
      expect(tokens).toContain("user");
      expect(tokens).toContain("member");
      expect(tokens).toContain("team");
    });

    it("lowercases all tokens", () => {
      const tokens = tokenizeSentence("Running Sprint Velocity Report");
      expect(tokens).toContain("running");
      expect(tokens).toContain("sprint");
      expect(tokens).toContain("velocity");
      expect(tokens).toContain("report");
    });
  });

  describe("computeTokenOverlap()", () => {
    it("returns 1.0 for identical token sets", () => {
      expect(computeTokenOverlap(["auth", "service"], ["auth", "service"])).toBe(1.0);
    });

    it("returns 0 for completely disjoint sets", () => {
      expect(computeTokenOverlap(["auth", "service"], ["billing", "module"])).toBe(0);
    });

    it("returns partial overlap score", () => {
      const score = computeTokenOverlap(
        ["user", "profile", "service"],
        ["user", "profile"]
      );
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it("returns 0 for empty token arrays", () => {
      expect(computeTokenOverlap([], [])).toBe(0);
      expect(computeTokenOverlap(["auth"], [])).toBe(0);
      expect(computeTokenOverlap([], ["auth"])).toBe(0);
    });

    it("is symmetric", () => {
      const a = ["auth", "service", "user"];
      const b = ["auth", "handler"];
      expect(computeTokenOverlap(a, b)).toBe(computeTokenOverlap(b, a));
    });
  });

  describe("normalizeForComparison()", () => {
    it("lowercases and trims", () => {
      expect(normalizeForComparison("  AuthService  ")).toBe("authservice");
    });

    it("removes special characters", () => {
      expect(normalizeForComparison("CI/CD Pipeline")).toBe("cicd pipeline");
    });

    it("collapses whitespace", () => {
      expect(normalizeForComparison("User   Profile")).toBe("user profile");
    });

    it("converts underscores and dashes to spaces", () => {
      expect(normalizeForComparison("user_profile")).toBe("user profile");
      expect(normalizeForComparison("user-profile")).toBe("user profile");
    });
  });
});
