/**
 * Unit Tests — src/blackboard.ts concurrent extensions (S25 T5)
 *
 * Tests for writeSectionWithRetry, mergeImplementationSection,
 * dev-sub-N role authorization.
 */

import { describe, it, expect } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  createBlackboard,
  writeSection,
  readSection,
  writeSectionWithRetry,
  mergeImplementationSection,
  InMemoryBlackboard,
} from "../../src/blackboard";

describe("concurrent blackboard", () => {
  it("concurrent writes to different sections succeed (AC-016)", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1", "DEFAULT");

    // Two agents write different sections
    const r1 = await writeSection(supabase, "session-1", "spec", { data: "spec" }, "analyst", 1);
    expect(r1.success).toBe(true);

    const r2 = await writeSection(supabase, "session-1", "tasks", { data: "tasks" }, "pm", r1.newVersion);
    expect(r2.success).toBe(true);

    // Verify both sections written
    const spec = await readSection(supabase, "session-1", "spec");
    const tasks = await readSection(supabase, "session-1", "tasks");
    expect(spec).toEqual({ data: "spec" });
    expect(tasks).toEqual({ data: "tasks" });
  });

  it("same-section version conflict auto-retried (AC-017)", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1");

    // Write once to advance version to 2
    await writeSection(supabase, "session-1", "spec", { v: 1 }, "analyst", 1);

    // Try writing with stale version 1 — writeSectionWithRetry should re-read and succeed
    const result = await writeSectionWithRetry(
      supabase, "session-1", "spec", { v: 2 }, "analyst", 1, 3
    );

    expect(result.success).toBe(true);
    expect(result.newVersion).toBe(3);
  });

  it("mergeImplementationSection concats arrays (AC-018)", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1");

    // Pre-populate implementation section
    await writeSection(supabase, "session-1", "implementation", {
      files_modified: ["src/a.ts"],
      tests_added: ["test-a"],
      summaries: ["Agent 0 done"],
    }, "dev", 1);

    // Merge new agent results
    const result = await mergeImplementationSection(
      supabase,
      "session-1",
      [
        { structured: { files_modified: ["src/b.ts"], tests_added: ["test-b"], summary: "Agent 1 done" }, output: "" },
        { structured: { files: ["src/c.ts"], tests: ["test-c"], summary: "Agent 2 done" }, output: "" },
      ],
      2 // current version after first write
    );

    expect(result.success).toBe(true);

    const impl = await readSection(supabase, "session-1", "implementation");
    expect(impl.files_modified).toContain("src/a.ts");
    expect(impl.files_modified).toContain("src/b.ts");
    expect(impl.files_modified).toContain("src/c.ts");
    expect(impl.tests_added).toContain("test-a");
    expect(impl.tests_added).toContain("test-b");
    expect(impl.tests_added).toContain("test-c");
    expect(impl.summaries).toHaveLength(3);
  });

  it("version conflict retried during fan-in, max 3 (EC-007)", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1");

    // writeSectionWithRetry with an intentionally stale version
    // should eventually succeed by re-reading
    const result = await writeSectionWithRetry(
      supabase, "session-1", "spec", { data: "test" }, "analyst", 1, 3
    );

    expect(result.success).toBe(true);
  });

  it("dev-sub-N roles authorized for implementation section", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1");

    const r1 = await writeSection(supabase, "session-1", "implementation", { sub: 0 }, "dev-sub-0", 1);
    expect(r1.success).toBe(true);

    const r2 = await writeSection(supabase, "session-1", "implementation", { sub: 1 }, "dev-sub-1", r1.newVersion);
    expect(r2.success).toBe(true);
  });

  it("dev-sub-N cannot write to spec section", async () => {
    const supabase = createMockSupabase();
    await createBlackboard(supabase, "task-1", "session-1");

    const result = await writeSection(supabase, "session-1", "spec", { data: "hack" }, "dev-sub-0", 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not authorized");
  });
});

describe("InMemoryBlackboard with dev-sub-N", () => {
  it("dev-sub-N can write to implementation", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const r = bb.write("session-1", "implementation", { data: 1 }, "dev-sub-0", 1);
    expect(r.success).toBe(true);
  });

  it("dev-sub-N cannot write to spec", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const r = bb.write("session-1", "spec", { data: 1 }, "dev-sub-0", 1);
    expect(r.success).toBe(false);
  });
});
