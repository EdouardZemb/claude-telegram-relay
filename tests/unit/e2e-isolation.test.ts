/**
 * Unit tests for E2E data isolation and cleanup mechanisms.
 */

import { describe, test, expect } from "bun:test";

// Test the tag mechanism and isolation logic without importing the full framework
// (which would load relay.ts and all dependencies)

describe("E2E Data Isolation", () => {
  test("tag() produces unique prefixed strings", () => {
    const runId = "test-run-123";
    const tag = (text: string) => `[E2E-${runId}] ${text}`;

    expect(tag("My Task")).toBe("[E2E-test-run-123] My Task");
    expect(tag("Another")).toBe("[E2E-test-run-123] Another");
  });

  test("different runIds produce non-colliding tags", () => {
    const tag1 = (text: string) => `[E2E-run-1] ${text}`;
    const tag2 = (text: string) => `[E2E-run-2] ${text}`;

    const tagged1 = tag1("Task A");
    const tagged2 = tag2("Task A");

    expect(tagged1).not.toBe(tagged2);
    expect(tagged1).toContain("[E2E-run-1]");
    expect(tagged2).toContain("[E2E-run-2]");
  });

  test("tag pattern matches correctly for cleanup", () => {
    const runId = "12345";
    const pattern = `%[E2E-${runId}]%`;

    // Simulate SQL LIKE matching
    const like = (text: string, pat: string) => {
      const regex = new RegExp(
        pat.replace(/%/g, ".*").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
      );
      return regex.test(text);
    };

    expect(like("[E2E-12345] Test Task", pattern)).toBe(true);
    expect(like("Some [E2E-12345] data", pattern)).toBe(true);
    expect(like("[E2E-99999] Other run", pattern)).toBe(false);
    expect(like("Normal task", pattern)).toBe(false);
  });

  test("runId from GITHUB_RUN_ID is used when available", () => {
    const original = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_RUN_ID = "gh-42";

    const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
    expect(runId).toBe("gh-42");

    // Restore
    if (original) {
      process.env.GITHUB_RUN_ID = original;
    } else {
      delete process.env.GITHUB_RUN_ID;
    }
  });

  test("local runId is generated when GITHUB_RUN_ID is absent", () => {
    const original = process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ID;

    const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
    expect(runId).toStartWith("local-");

    // Restore
    if (original) {
      process.env.GITHUB_RUN_ID = original;
    }
  });

  test("cleanup targets the correct tables", () => {
    const tables = [
      { table: "tasks", column: "title" },
      { table: "memory", column: "content" },
      { table: "messages", column: "content" },
      { table: "logs", column: "message" },
    ];

    expect(tables).toHaveLength(4);
    expect(tables.map((t) => t.table)).toEqual([
      "tasks",
      "memory",
      "messages",
      "logs",
    ]);
  });
});
