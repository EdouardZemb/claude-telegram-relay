/**
 * Unit Tests — src/story-files.ts
 *
 * Tests for story file generation, formatting, and AC parsing.
 */

import { describe, it, expect } from "bun:test";
import {
  buildStoryFile,
  formatStoryForAgent,
  formatStoryPreview,
  type StoryFile,
} from "../../src/story-files";

const baseTask = {
  id: "test-id-123",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  title: "Add user profile page",
  description: "Create a profile page that shows user info and settings",
  project: "test-project",
  status: "backlog" as const,
  priority: 2,
  sprint: "S16",
  tags: [],
  estimated_hours: null,
  actual_hours: null,
  blocked_by: null,
  notes: null,
  completed_at: null,
  acceptance_criteria: null,
  dev_notes: null,
  architecture_ref: null,
  subtasks: [],
};

describe("buildStoryFile", () => {
  it("generates a story file from a basic task", () => {
    const story = buildStoryFile(baseTask);
    expect(story.title).toBe("Add user profile page");
    expect(story.description).toContain("profile page");
  });

  it("parses Given/When/Then acceptance criteria", () => {
    const task = {
      ...baseTask,
      acceptance_criteria:
        "Given a logged-in user, When they visit /profile, Then they see their name and email",
    };
    const story = buildStoryFile(task);
    expect(story.acceptanceCriteria.length).toBe(1);
    expect(story.acceptanceCriteria[0].id).toBe("AC-1");
    expect(story.acceptanceCriteria[0].given).toContain("logged-in user");
    expect(story.acceptanceCriteria[0].when).toContain("/profile");
    expect(story.acceptanceCriteria[0].then).toContain("name and email");
  });

  it("converts bullet-point ACs to structured format", () => {
    const task = {
      ...baseTask,
      acceptance_criteria: "- User can see their name\n- User can edit their email\n- Changes are saved",
    };
    const story = buildStoryFile(task);
    expect(story.acceptanceCriteria.length).toBe(3);
    expect(story.acceptanceCriteria[0].id).toBe("AC-1");
    expect(story.acceptanceCriteria[1].id).toBe("AC-2");
    expect(story.acceptanceCriteria[2].id).toBe("AC-3");
  });

  it("generates test stubs from acceptance criteria", () => {
    const task = {
      ...baseTask,
      acceptance_criteria: "Given a user, When they click save, Then data persists",
    };
    const story = buildStoryFile(task);
    expect(story.testStubs.length).toBe(1);
    expect(story.testStubs[0].id).toBe("TEST-1");
    expect(story.testStubs[0].acMapping).toBe("AC-1");
    expect(story.testStubs[0].type).toBe("unit");
  });

  it("converts existing subtasks to implementation steps", () => {
    const task = {
      ...baseTask,
      subtasks: [
        { title: "Create component", ac_mapping: "AC-1", done: false },
        { title: "Add tests", done: true },
      ],
    };
    const story = buildStoryFile(task);
    expect(story.implementationSteps.length).toBe(2);
    expect(story.implementationSteps[0].id).toBe("STEP-1");
    expect(story.implementationSteps[0].title).toBe("Create component");
    expect(story.implementationSteps[0].done).toBe(false);
    expect(story.implementationSteps[1].done).toBe(true);
  });

  it("generates done criteria", () => {
    const task = {
      ...baseTask,
      acceptance_criteria: "Given X, When Y, Then Z",
    };
    const story = buildStoryFile(task);
    expect(story.doneCriteria.length).toBeGreaterThan(0);
    expect(story.doneCriteria).toContain("Tous les tests existants passent (bun test)");
    expect(story.doneCriteria.some((c) => c.includes("AC-1"))).toBe(true);
  });

  it("extracts impacted files from description", () => {
    const task = {
      ...baseTask,
      description: "Modify src/relay.ts and add tests/unit/profile.test.ts",
    };
    const story = buildStoryFile(task);
    expect(story.impactedFiles).toContain("src/relay.ts");
    expect(story.impactedFiles).toContain("tests/unit/profile.test.ts");
  });

  it("handles task with no ACs, no subtasks gracefully", () => {
    const story = buildStoryFile(baseTask);
    expect(story.acceptanceCriteria).toEqual([]);
    expect(story.implementationSteps).toEqual([]);
    expect(story.testStubs).toEqual([]);
    expect(story.doneCriteria.length).toBeGreaterThan(0);
  });
});

describe("formatStoryForAgent", () => {
  it("produces readable text with all sections", () => {
    const task = {
      ...baseTask,
      acceptance_criteria: "Given a user, When they visit /profile, Then they see info",
      subtasks: [
        { title: "Create component", ac_mapping: "AC-1", done: false },
      ],
      architecture_ref: "Uses React SPA pattern",
    };
    const story = buildStoryFile(task);
    const formatted = formatStoryForAgent(story);

    expect(formatted).toContain("STORY FILE:");
    expect(formatted).toContain("CRITERES D'ACCEPTATION:");
    expect(formatted).toContain("ETAPES D'IMPLEMENTATION");
    expect(formatted).toContain("TESTS REQUIS:");
    expect(formatted).toContain("DEFINITION OF DONE:");
    expect(formatted).toContain("NOTES ARCHITECTURE:");
    expect(formatted).toContain("React SPA pattern");
  });

  it("shows checkbox state for implementation steps", () => {
    const task = {
      ...baseTask,
      subtasks: [
        { title: "Done step", done: true },
        { title: "Pending step", done: false },
      ],
    };
    const story = buildStoryFile(task);
    const formatted = formatStoryForAgent(story);

    expect(formatted).toContain("[x] STEP-1: Done step");
    expect(formatted).toContain("[ ] STEP-2: Pending step");
  });
});

describe("formatStoryPreview", () => {
  it("shows compact preview for Telegram", () => {
    const task = {
      ...baseTask,
      acceptance_criteria: "- Can see name\n- Can edit email\n- Can upload avatar\n- Can delete account",
    };
    const story = buildStoryFile(task);
    const preview = formatStoryPreview(story);

    expect(preview).toContain("Story: Add user profile page");
    expect(preview).toContain("ACs: 4");
    expect(preview).toContain("Tests: 4");
    expect(preview).toContain("... +1 autres");
  });
});
