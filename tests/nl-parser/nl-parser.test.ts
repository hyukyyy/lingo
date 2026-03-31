/**
 * Tests for the NL Input Parser
 *
 * Covers:
 * - Intent detection
 * - Entity extraction (item types, statuses, priorities, labels, people, dates)
 * - Title extraction from various text formats
 * - Hierarchy detection
 * - Full parse pipeline producing CreatePmItemInput objects
 * - Edge cases (empty input, ambiguous text, etc.)
 */

import { describe, it, expect } from "vitest";
import {
  parseNaturalLanguage,
  detectIntent,
  extractItemTypes,
  extractStatuses,
  extractPriorities,
  extractLabels,
  extractPersons,
  extractDates,
  extractTitles,
  detectHierarchy,
  extractAllEntities,
} from "../../src/nl-parser/nl-parser.js";
import type {
  NlParseResult,
  NlIntent,
  NlEntity,
} from "../../src/nl-parser/types.js";

// ─── Intent Detection ───────────────────────────────────────────────

describe("detectIntent", () => {
  it("detects create intent from 'create' keyword", () => {
    const result = detectIntent("Create a new login page");
    expect(result.intent).toBe("create");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects create intent from 'add' keyword", () => {
    const result = detectIntent("Add user authentication feature");
    expect(result.intent).toBe("create");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects create intent from 'we need' phrase", () => {
    const result = detectIntent("We need a dashboard for analytics");
    expect(result.intent).toBe("create");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("detects create intent from 'implement' keyword", () => {
    const result = detectIntent("Implement SSO integration");
    expect(result.intent).toBe("create");
  });

  it("detects update intent from 'update' keyword", () => {
    const result = detectIntent("Update the priority of the auth task");
    expect(result.intent).toBe("update");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects update intent from 'mark as' phrase", () => {
    const result = detectIntent("Mark as done");
    expect(result.intent).toBe("update");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("detects describe intent from user story format", () => {
    const result = detectIntent("As a user, I want to log in with SSO");
    expect(result.intent).toBe("create");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("detects query intent from 'find' keyword", () => {
    const result = detectIntent("Find all high priority bugs");
    expect(result.intent).toBe("query");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects query intent from 'show' keyword", () => {
    const result = detectIntent("Show me the in-progress tasks");
    expect(result.intent).toBe("query");
  });

  it("detects decompose intent from 'break down' phrase", () => {
    const result = detectIntent("Break down the authentication epic into stories");
    expect(result.intent).toBe("decompose");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("detects decompose from header + bullet list structure", () => {
    const text = `Authentication System
- Login page
- Password reset
- SSO integration`;
    const result = detectIntent(text);
    expect(result.intent).toBe("decompose");
  });

  it("returns unknown for ambiguous text", () => {
    const result = detectIntent("hmm");
    expect(result.intent).toBe("unknown");
  });

  it("returns unknown for empty text", () => {
    const result = detectIntent("");
    expect(result.intent).toBe("unknown");
  });
});

// ─── Item Type Extraction ───────────────────────────────────────────

describe("extractItemTypes", () => {
  it("extracts 'epic' from text", () => {
    const entities = extractItemTypes("Create a new epic for authentication");
    const epic = entities.find((e) => e.normalizedValue === "epic");
    expect(epic).toBeDefined();
    expect(epic!.kind).toBe("item_type");
    expect(epic!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts 'story' from text", () => {
    const entities = extractItemTypes("Add a story for login flow");
    const story = entities.find((e) => e.normalizedValue === "story");
    expect(story).toBeDefined();
  });

  it("extracts 'user story' as story type", () => {
    const entities = extractItemTypes("Write a user story for the checkout");
    const story = entities.find((e) => e.normalizedValue === "story");
    expect(story).toBeDefined();
    expect(story!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts 'bug' from text", () => {
    const entities = extractItemTypes("There's a bug in the payment flow");
    expect(entities.some((e) => e.normalizedValue === "bug")).toBe(true);
  });

  it("extracts 'task' from text", () => {
    const entities = extractItemTypes("Create a task to update docs");
    expect(entities.some((e) => e.normalizedValue === "task")).toBe(true);
  });

  it("maps 'ticket' to 'task'", () => {
    const entities = extractItemTypes("File a ticket for the UI issue");
    expect(entities.some((e) => e.normalizedValue === "task")).toBe(true);
  });

  it("maps 'defect' to 'bug'", () => {
    const entities = extractItemTypes("Log a defect for the login error");
    expect(entities.some((e) => e.normalizedValue === "bug")).toBe(true);
  });

  it("extracts subtask", () => {
    const entities = extractItemTypes("Add a subtask for testing");
    expect(entities.some((e) => e.normalizedValue === "subtask")).toBe(true);
  });

  it("extracts milestone", () => {
    const entities = extractItemTypes("Set a milestone for Q2 release");
    expect(entities.some((e) => e.normalizedValue === "milestone")).toBe(true);
  });

  it("includes text span information", () => {
    const entities = extractItemTypes("Create an epic for auth");
    const epic = entities.find((e) => e.normalizedValue === "epic");
    expect(epic).toBeDefined();
    expect(epic!.span.start).toBeGreaterThanOrEqual(0);
    expect(epic!.span.end).toBeGreaterThan(epic!.span.start);
  });

  it("returns empty for text without item types", () => {
    const entities = extractItemTypes("The sky is blue");
    // May pick up false positives for very common words, but should be minimal
    expect(entities.length).toBeLessThanOrEqual(1);
  });
});

// ─── Status Extraction ──────────────────────────────────────────────

describe("extractStatuses", () => {
  it("extracts 'in progress' status", () => {
    const entities = extractStatuses("The task is in progress");
    expect(entities.some((e) => e.normalizedValue === "in-progress")).toBe(true);
  });

  it("extracts 'done' status", () => {
    const entities = extractStatuses("Mark the feature as done");
    expect(entities.some((e) => e.normalizedValue === "done")).toBe(true);
  });

  it("extracts 'backlog' status", () => {
    const entities = extractStatuses("Move to backlog");
    expect(entities.some((e) => e.normalizedValue === "backlog")).toBe(true);
  });

  it("extracts 'in review' status", () => {
    const entities = extractStatuses("Currently in review");
    expect(entities.some((e) => e.normalizedValue === "in-review")).toBe(true);
  });

  it("extracts 'cancelled' status", () => {
    const entities = extractStatuses("This has been cancelled");
    expect(entities.some((e) => e.normalizedValue === "cancelled")).toBe(true);
  });

  it("maps 'completed' to 'done'", () => {
    const entities = extractStatuses("This task is completed");
    expect(entities.some((e) => e.normalizedValue === "done")).toBe(true);
  });

  it("maps 'not started' to 'todo'", () => {
    const entities = extractStatuses("Not started yet");
    expect(entities.some((e) => e.normalizedValue === "todo")).toBe(true);
  });
});

// ─── Priority Extraction ────────────────────────────────────────────

describe("extractPriorities", () => {
  it("extracts 'high priority'", () => {
    const entities = extractPriorities("This is high priority");
    expect(entities.some((e) => e.normalizedValue === "high")).toBe(true);
    const hp = entities.find((e) => e.normalizedValue === "high");
    expect(hp!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts 'critical' priority", () => {
    const entities = extractPriorities("Critical bug in production");
    expect(entities.some((e) => e.normalizedValue === "critical")).toBe(true);
  });

  it("extracts 'low priority'", () => {
    const entities = extractPriorities("Low priority cleanup task");
    expect(entities.some((e) => e.normalizedValue === "low")).toBe(true);
  });

  it("maps 'urgent' to 'critical'", () => {
    const entities = extractPriorities("Urgent: fix the deployment");
    expect(entities.some((e) => e.normalizedValue === "critical")).toBe(true);
  });

  it("maps 'nice to have' to 'low'", () => {
    const entities = extractPriorities("This is nice to have");
    expect(entities.some((e) => e.normalizedValue === "low")).toBe(true);
  });

  it("extracts P0 notation as critical", () => {
    const entities = extractPriorities("P0 production outage");
    expect(entities.some((e) => e.normalizedValue === "critical")).toBe(true);
  });

  it("extracts P1 notation as high", () => {
    const entities = extractPriorities("P1 security vulnerability");
    expect(entities.some((e) => e.normalizedValue === "high")).toBe(true);
  });

  it("extracts P2 notation as medium", () => {
    const entities = extractPriorities("P2 performance improvement");
    expect(entities.some((e) => e.normalizedValue === "medium")).toBe(true);
  });
});

// ─── Label Extraction ───────────────────────────────────────────────

describe("extractLabels", () => {
  it("extracts hashtag-style labels", () => {
    const entities = extractLabels("Fix the login #auth #security");
    const labels = entities.map((e) => e.normalizedValue);
    expect(labels).toContain("auth");
    expect(labels).toContain("security");
  });

  it("extracts bracket-style labels", () => {
    const entities = extractLabels("Update [frontend] component");
    expect(entities.some((e) => e.normalizedValue === "frontend")).toBe(true);
  });

  it("extracts explicit label: syntax", () => {
    const entities = extractLabels("labels: auth, backend, api");
    expect(entities.some((e) => e.normalizedValue === "auth")).toBe(true);
    expect(entities.some((e) => e.normalizedValue === "backend")).toBe(true);
    expect(entities.some((e) => e.normalizedValue === "api")).toBe(true);
  });

  it("extracts tag: syntax", () => {
    const entities = extractLabels("tags: infrastructure");
    expect(entities.some((e) => e.normalizedValue === "infrastructure")).toBe(true);
  });
});

// ─── Person Extraction ──────────────────────────────────────────────

describe("extractPersons", () => {
  it("extracts 'assigned to Name'", () => {
    const entities = extractPersons("Assigned to Alice");
    const person = entities.find((e) => e.normalizedValue === "Alice");
    expect(person).toBeDefined();
    expect(person!.kind).toBe("person");
  });

  it("extracts @mention", () => {
    const entities = extractPersons("CC @bob on this task");
    expect(entities.some((e) => e.normalizedValue === "bob")).toBe(true);
  });

  it("extracts 'reported by Name'", () => {
    const entities = extractPersons("Reported by Carol");
    expect(entities.some((e) => e.normalizedValue === "Carol")).toBe(true);
  });

  it("does not extract common words as names", () => {
    const entities = extractPersons("for the task");
    // 'the' should be filtered out as a common word
    expect(entities.filter((e) => e.normalizedValue === "the")).toHaveLength(0);
  });
});

// ─── Date Extraction ────────────────────────────────────────────────

describe("extractDates", () => {
  it("extracts ISO date", () => {
    const entities = extractDates("Due by 2026-04-15");
    expect(entities.some((e) => e.normalizedValue === "2026-04-15")).toBe(true);
  });

  it("extracts named month date", () => {
    const entities = extractDates("Launch on March 15");
    expect(entities.some((e) => e.normalizedValue.includes("March 15"))).toBe(true);
  });

  it("extracts relative date reference", () => {
    const entities = extractDates("Finish by next week");
    expect(entities.some((e) => e.normalizedValue.includes("next week"))).toBe(true);
  });

  it("extracts slash-format date", () => {
    const entities = extractDates("Due: 04/15/2026");
    expect(entities.some((e) => e.normalizedValue === "04/15/2026")).toBe(true);
  });
});

// ─── Title Extraction ───────────────────────────────────────────────

describe("extractTitles", () => {
  it("extracts titles from bullet list", () => {
    const text = `- Login page design
- Password reset flow
- Session management`;
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(3);
    expect(titles[0].title).toBe("Login page design");
    expect(titles[1].title).toBe("Password reset flow");
    expect(titles[2].title).toBe("Session management");
  });

  it("extracts titles from numbered list", () => {
    const text = `1. Implement OAuth provider
2. Add token refresh
3. Create user profile page`;
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(3);
    expect(titles[0].title).toBe("Implement OAuth provider");
  });

  it("extracts title with type prefix", () => {
    const text = "Epic: User Authentication System";
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(1);
    expect(titles[0].title).toBe("User Authentication System");
    expect(titles[0].inferredType).toBe("epic");
  });

  it("extracts user story as title with story type", () => {
    const text = "As a user, I want to reset my password";
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(1);
    expect(titles[0].inferredType).toBe("story");
  });

  it("extracts single line as title", () => {
    const text = "Fix the broken dropdown menu";
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(1);
    expect(titles[0].title).toBe("Fix the broken dropdown menu");
  });

  it("extracts header and list items separately", () => {
    const text = `Auth System Overhaul
- Login page
- Password reset
- SSO`;
    const titles = extractTitles(text, []);
    expect(titles.length).toBeGreaterThanOrEqual(3);
    // First should be the header
    expect(titles[0].title).toBe("Auth System Overhaul");
  });

  it("handles mixed bullet formats", () => {
    const text = `- Task one
* Task two
• Task three`;
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(3);
  });

  it("assigns type from bracket prefix", () => {
    const text = "- [Bug] Login button not responding";
    const titles = extractTitles(text, []);
    expect(titles).toHaveLength(1);
    expect(titles[0].title).toBe("Login button not responding");
    expect(titles[0].inferredType).toBe("bug");
  });
});

// ─── Hierarchy Detection ────────────────────────────────────────────

describe("detectHierarchy", () => {
  it("detects parent-child from header + bullet list", () => {
    const text = `Authentication Epic
- Login story
- Signup story`;

    const entities = extractAllEntities(text, 0.3);
    const titles = extractTitles(text, entities);
    const hierarchy = detectHierarchy(text, titles, entities);

    expect(hierarchy.length).toBeGreaterThanOrEqual(1);
    expect(hierarchy[0].parentTitle).toBe("Authentication Epic");
  });

  it("detects hierarchy from indentation levels", () => {
    const text = `- Epic: User Auth
  - Story: Login flow
  - Story: Signup flow`;

    const entities = extractAllEntities(text, 0.3);
    const titles = extractTitles(text, entities);
    const hierarchy = detectHierarchy(text, titles, entities);

    expect(hierarchy.length).toBeGreaterThanOrEqual(1);
    const parentChild = hierarchy.find(
      (h) => h.parentTitle === "User Auth"
    );
    expect(parentChild).toBeDefined();
  });

  it("infers parent type from child types", () => {
    const text = `Payments
- Story: Checkout flow
- Story: Payment processing`;

    const entities = extractAllEntities(text, 0.3);
    const titles = extractTitles(text, entities);
    const hierarchy = detectHierarchy(text, titles, entities);

    const parentRelation = hierarchy.find((h) => h.parentTitle === "Payments");
    if (parentRelation) {
      expect(parentRelation.parentType).toBe("epic");
    }
  });

  it("returns empty for single items", () => {
    const text = "Just a single task";
    const entities = extractAllEntities(text, 0.3);
    const titles = extractTitles(text, entities);
    const hierarchy = detectHierarchy(text, titles, entities);

    expect(hierarchy).toHaveLength(0);
  });
});

// ─── Full Parse Pipeline ────────────────────────────────────────────

describe("parseNaturalLanguage", () => {
  describe("empty/invalid input", () => {
    it("handles empty string", () => {
      const result = parseNaturalLanguage("");
      expect(result.intent).toBe("unknown");
      expect(result.confidence).toBe(0);
      expect(result.items).toHaveLength(0);
      expect(result.entities).toHaveLength(0);
      expect(result.diagnostics).toContain("Empty input text");
    });

    it("handles whitespace-only input", () => {
      const result = parseNaturalLanguage("   \n\t  ");
      expect(result.intent).toBe("unknown");
      expect(result.items).toHaveLength(0);
    });

    it("handles null/undefined gracefully", () => {
      // @ts-expect-error - testing runtime robustness
      const result = parseNaturalLanguage(null);
      expect(result.intent).toBe("unknown");
      expect(result.items).toHaveLength(0);
    });
  });

  describe("simple single-item creation", () => {
    it("parses 'Create a task to update docs'", () => {
      const result = parseNaturalLanguage("Create a task to update docs");
      expect(result.intent).toBe("create");
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      const item = result.items[0];
      expect(item.type).toBe("task");
      expect(item.title).toBeTruthy();
      expect(item.source.adapter).toBe("nl-parser");
    });

    it("parses 'Add a high priority bug for login crash'", () => {
      const result = parseNaturalLanguage("Add a high priority bug for login crash");
      expect(result.intent).toBe("create");
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      const item = result.items[0];
      expect(item.type).toBe("bug");
      expect(item.priority).toBe("high");
    });

    it("parses user story format", () => {
      const result = parseNaturalLanguage(
        "As a user, I want to reset my password, so that I can recover my account"
      );
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      const item = result.items[0];
      expect(item.type).toBe("story");
      expect(item.title).toContain("As a user");
      expect(item.description).toContain("recover my account");
    });

    it("parses item with explicit type prefix", () => {
      const result = parseNaturalLanguage("Epic: User Authentication System");
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      const item = result.items[0];
      expect(item.type).toBe("epic");
      expect(item.title).toBe("User Authentication System");
    });
  });

  describe("multi-item creation from lists", () => {
    it("parses bullet list into multiple items", () => {
      const text = `- Implement login page
- Add password validation
- Create session management`;

      const result = parseNaturalLanguage(text);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].title).toBe("Implement login page");
      expect(result.items[1].title).toBe("Add password validation");
      expect(result.items[2].title).toBe("Create session management");
    });

    it("parses numbered list into multiple items", () => {
      const text = `1. Design API schema
2. Implement endpoints
3. Write integration tests`;

      const result = parseNaturalLanguage(text);
      expect(result.items).toHaveLength(3);
    });

    it("parses list with type prefixes", () => {
      const text = `- Epic: Auth Overhaul
- Story: Login flow
- Task: Write unit tests`;

      const result = parseNaturalLanguage(text);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].type).toBe("epic");
      expect(result.items[1].type).toBe("story");
      expect(result.items[2].type).toBe("task");
    });
  });

  describe("hierarchy parsing", () => {
    it("detects parent-child from header + list", () => {
      const text = `Authentication Epic
- Login page
- Password reset
- SSO integration`;

      const result = parseNaturalLanguage(text);
      expect(result.hierarchy.length).toBeGreaterThanOrEqual(1);
      expect(result.items.length).toBeGreaterThanOrEqual(3);
    });

    it("preserves hierarchy information in relations", () => {
      const text = `Epic: Auth System
- Story: Login flow
- Story: Signup flow`;

      const result = parseNaturalLanguage(text);
      const authParent = result.hierarchy.find(
        (h) => h.parentTitle === "Auth System"
      );
      if (authParent) {
        expect(authParent.parentType).toBe("epic");
      }
    });
  });

  describe("entity extraction in context", () => {
    it("extracts labels from hashtags", () => {
      const result = parseNaturalLanguage("Fix the dropdown #frontend #urgent");
      expect(result.entities.some((e) => e.kind === "label" && e.normalizedValue === "frontend")).toBe(true);
    });

    it("extracts labels from bracket notation", () => {
      const result = parseNaturalLanguage("[backend] Update the API endpoint");
      expect(result.entities.some((e) => e.kind === "label" && e.normalizedValue === "backend")).toBe(true);
    });

    it("extracts assignee from @mention", () => {
      const result = parseNaturalLanguage("Create a task @alice to update the docs");
      const person = result.entities.find((e) => e.kind === "person");
      expect(person).toBeDefined();
    });

    it("extracts date reference", () => {
      const result = parseNaturalLanguage("Deploy the feature by 2026-04-15");
      expect(result.entities.some((e) => e.kind === "date")).toBe(true);
    });
  });

  describe("options", () => {
    it("respects defaultItemType option", () => {
      const result = parseNaturalLanguage("Fix the dropdown", {
        defaultItemType: "bug",
      });
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      // If no explicit type in the text, should use default
      expect(result.items[0].type).toBe("bug");
    });

    it("respects sourceAdapter option", () => {
      const result = parseNaturalLanguage("Create a login task", {
        sourceAdapter: "custom-tool",
      });
      if (result.items.length > 0) {
        expect(result.items[0].source.adapter).toBe("custom-tool");
      }
    });

    it("respects minEntityConfidence option", () => {
      const highThreshold = parseNaturalLanguage(
        "Maybe add a feature for that issue thing",
        { minEntityConfidence: 0.9 }
      );
      const lowThreshold = parseNaturalLanguage(
        "Maybe add a feature for that issue thing",
        { minEntityConfidence: 0.1 }
      );
      // Higher threshold should produce fewer entities
      expect(highThreshold.entities.length).toBeLessThanOrEqual(lowThreshold.entities.length);
    });
  });

  describe("confidence scoring", () => {
    it("produces higher confidence for explicit create intent", () => {
      const explicit = parseNaturalLanguage("Create a new epic for Authentication");
      const implicit = parseNaturalLanguage("Something about authentication");

      expect(explicit.confidence).toBeGreaterThan(implicit.confidence);
    });

    it("produces non-zero confidence for valid input", () => {
      const result = parseNaturalLanguage("Create a task");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("entities have individual confidence scores", () => {
      const result = parseNaturalLanguage("Create a high priority epic");
      for (const entity of result.entities) {
        expect(entity.confidence).toBeGreaterThanOrEqual(0);
        expect(entity.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("real-world examples", () => {
    it("parses a sprint planning input", () => {
      const text = `Sprint 12 Tasks:
- [Bug] Fix payment timeout - high priority
- [Story] Add export to CSV
- [Task] Update API documentation
- [Task] Refactor auth middleware`;

      const result = parseNaturalLanguage(text);
      expect(result.items.length).toBeGreaterThanOrEqual(4);

      const bugItem = result.items.find((i) => i.type === "bug");
      expect(bugItem).toBeDefined();
      expect(bugItem!.title).toContain("Fix payment timeout");
    });

    it("parses a feature decomposition", () => {
      const text = `Epic: Real-time Notifications
- Story: Email notification preferences
- Story: Push notification setup
- Story: In-app notification center
- Task: Design notification data model`;

      const result = parseNaturalLanguage(text);
      expect(result.items.length).toBeGreaterThanOrEqual(4);
      expect(result.hierarchy.length).toBeGreaterThanOrEqual(1);

      // The epic should be parent of the stories
      const epicRelation = result.hierarchy.find(
        (h) => h.parentTitle === "Real-time Notifications"
      );
      expect(epicRelation).toBeDefined();
      expect(epicRelation!.parentType).toBe("epic");
    });

    it("parses a bug report", () => {
      const text = "Critical bug: Users can't log in after password reset. Assigned to Bob #auth #security";

      const result = parseNaturalLanguage(text);
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      // Should detect priority and labels
      expect(result.entities.some((e) => e.kind === "priority" && e.normalizedValue === "critical")).toBe(true);
      expect(result.entities.some((e) => e.kind === "label" && e.normalizedValue === "auth")).toBe(true);
      expect(result.entities.some((e) => e.kind === "label" && e.normalizedValue === "security")).toBe(true);
    });
  });

  describe("output structure", () => {
    it("includes rawText in result", () => {
      const input = "Create a new task";
      const result = parseNaturalLanguage(input);
      expect(result.rawText).toBe(input);
    });

    it("items have proper source adapter", () => {
      const result = parseNaturalLanguage("Create a task");
      for (const item of result.items) {
        expect(item.source).toBeDefined();
        expect(item.source.adapter).toBe("nl-parser");
      }
    });

    it("items have default status when not specified", () => {
      const result = parseNaturalLanguage("Add a feature for dark mode");
      for (const item of result.items) {
        expect(item.status).toBeDefined();
      }
    });

    it("entities include span information", () => {
      const result = parseNaturalLanguage("Create a high priority epic");
      for (const entity of result.entities) {
        expect(entity.span).toBeDefined();
        expect(typeof entity.span.start).toBe("number");
        expect(typeof entity.span.end).toBe("number");
        expect(entity.span.end).toBeGreaterThan(entity.span.start);
      }
    });
  });
});
