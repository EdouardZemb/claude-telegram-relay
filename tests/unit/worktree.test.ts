/**
 * Unit Tests — src/worktree.ts (S25 T3)
 *
 * Tests for git worktree lifecycle.
 * Note: actual git operations are tested via detectFileOverlap (pure function).
 * Git worktree create/cleanup tests are skipped in CI (require real git repo).
 */

import { describe, it, expect } from "bun:test";
import { detectFileOverlap } from "../../src/worktree";

describe("detectFileOverlap", () => {
  it("no overlap with different files (AC-010)", () => {
    const fileGroups = [
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts", "src/d.ts"],
      ["src/e.ts"],
    ];

    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  it("detects overlap on same file (AC-011, EC-001)", () => {
    const fileGroups = [
      ["src/a.ts", "src/shared.ts"],
      ["src/b.ts", "src/shared.ts"],
    ];

    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(true);
    expect(result.conflicts).toContain("src/shared.ts");
  });

  it("handles empty file lists", () => {
    const fileGroups = [[], [], []];
    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(false);
  });

  it("deduplicates conflict entries", () => {
    const fileGroups = [
      ["src/x.ts"],
      ["src/x.ts"],
      ["src/x.ts"],
    ];

    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toBe("src/x.ts");
  });

  it("single group never overlaps", () => {
    const fileGroups = [["src/a.ts", "src/b.ts"]];
    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(false);
  });

  it("multiple overlaps reported", () => {
    const fileGroups = [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/c.ts", "src/d.ts"],
    ];

    const result = detectFileOverlap(fileGroups);
    expect(result.overlapping).toBe(true);
    expect(result.conflicts).toContain("src/b.ts");
    expect(result.conflicts).toContain("src/c.ts");
  });

  it("empty subtask list returns no overlap", () => {
    const result = detectFileOverlap([]);
    expect(result.overlapping).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });
});
