/**
 * Unit Tests — Command Zod Validators
 *
 * Tests for TaskCommandSchema, ExecCommandSchema, OrchestrateCommandSchema, PrdCommandSchema.
 * V5-V15, V25 from SPEC-durcissement-standards-vague-3.
 * Adversarial corrections: F-DA-1 (VALID_PIPELINES lowercase), F-DA-2 (--hours excluded),
 * F-EC-2 (regex reinforced for ExecCommandSchema), F-SS-1 (boolean defaults).
 */

import { describe, expect, it } from "bun:test";
import { ExecCommandSchema, OrchestrateCommandSchema } from "../../src/commands/execution.ts";
import { PrdCommandSchema } from "../../src/commands/planning.ts";
import { parseTaskCommand, TaskCommandSchema } from "../../src/commands/tasks.ts";

// ── TaskCommandSchema (V5-V7) ─────────────────────────────────

describe("TaskCommandSchema", () => {
  // V5: valid input
  it("accepts { title: 'Fix bug', priority: 2 }", () => {
    const result = TaskCommandSchema.safeParse({ title: "Fix bug", priority: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Fix bug");
      expect(result.data.priority).toBe(2);
    }
  });

  it("accepts title only (no priority)", () => {
    const result = TaskCommandSchema.safeParse({ title: "Do something" });
    expect(result.success).toBe(true);
  });

  it("accepts title with desc", () => {
    const result = TaskCommandSchema.safeParse({ title: "Fix bug", desc: "A description" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.desc).toBe("A description");
  });

  it("coerces string priority to number", () => {
    const result = TaskCommandSchema.safeParse({ title: "Fix bug", priority: "3" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.priority).toBe(3);
  });

  // V6: empty title rejected
  it("rejects empty title", () => {
    const result = TaskCommandSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("requis");
    }
  });

  it("rejects missing title", () => {
    const result = TaskCommandSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // V7: priority out of range
  it("rejects priority > 5", () => {
    const result = TaskCommandSchema.safeParse({ title: "test", priority: 6 });
    expect(result.success).toBe(false);
  });

  it("rejects priority < 1", () => {
    const result = TaskCommandSchema.safeParse({ title: "test", priority: 0 });
    expect(result.success).toBe(false);
  });

  // F-DA-2: --hours not in schema
  it("does not include hours field (F-DA-2)", () => {
    const schema = TaskCommandSchema;
    const shape = schema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty("hours");
    expect(shape).not.toHaveProperty("estimatedHours");
  });
});

// ── parseTaskCommand helper ───────────────────────────────────

describe("parseTaskCommand", () => {
  it("parses simple title", () => {
    const r = parseTaskCommand("Fix bug");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title).toBe("Fix bug");
  });

  it("parses title with --priority", () => {
    const r = parseTaskCommand("Fix bug --priority 3");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("Fix bug");
      expect(r.value.priority).toBe(3);
    }
  });

  it("returns err for invalid priority", () => {
    const r = parseTaskCommand("Fix bug --priority 7");
    expect(r.ok).toBe(false);
  });

  it("returns err for empty title after flag stripping", () => {
    const r = parseTaskCommand("--priority 2");
    expect(r.ok).toBe(false);
  });
});

// ── ExecCommandSchema (V8-V10) ────────────────────────────────

describe("ExecCommandSchema", () => {
  // V8: valid idPrefix
  it("accepts valid hex idPrefix 'abc123'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "abc123" });
    expect(result.success).toBe(true);
  });

  it("accepts full UUID-length idPrefix", () => {
    const result = ExecCommandSchema.safeParse({
      idPrefix: "abc12345678901234567890123456789012",
    });
    expect(result.success).toBe(true);
  });

  it("accepts 4-char minimum idPrefix", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "abcd" });
    expect(result.success).toBe(true);
  });

  // V9: too short
  it("rejects idPrefix shorter than 4 chars", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "ab" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("trop court");
    }
  });

  // V10: invalid characters
  it("rejects non-hex characters 'xyz!@#'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "xyz!@#" });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase characters 'ABCDEF'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "ABCDEF" });
    expect(result.success).toBe(false);
  });

  // F-EC-2: pure-dash strings rejected
  it("rejects pure-dash string '----' (F-EC-2)", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "----" });
    expect(result.success).toBe(false);
  });

  it("rejects leading-dash string '-abc'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "-abc" });
    expect(result.success).toBe(false);
  });

  it("rejects trailing-dash string 'abc-'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "abc-" });
    expect(result.success).toBe(false);
  });

  it("accepts hex with internal dash 'abc1-def2'", () => {
    const result = ExecCommandSchema.safeParse({ idPrefix: "abc1-def2" });
    expect(result.success).toBe(true);
  });
});

// ── OrchestrateCommandSchema (V11-V12) ────────────────────────

describe("OrchestrateCommandSchema", () => {
  // V11: valid pipeline in lowercase, flags default to false
  it("accepts idPrefix + pipeline 'full' without flags", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "full",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipeline).toBe("full");
      expect(result.data.useBlackboard).toBe(false);
      expect(result.data.skipChallenge).toBe(false);
      expect(result.data.useResume).toBe(false);
    }
  });

  it("accepts pipeline 'quick'", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "quick",
    });
    expect(result.success).toBe(true);
  });

  it("accepts pipeline 'review'", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "review",
    });
    expect(result.success).toBe(true);
  });

  it("accepts idPrefix only (no pipeline)", () => {
    const result = OrchestrateCommandSchema.safeParse({ idPrefix: "abc123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipeline).toBeUndefined();
    }
  });

  it("accepts useBlackboard: true explicitly", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      useBlackboard: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.useBlackboard).toBe(true);
  });

  // F-SS-1: boolean defaults
  it("defaults boolean flags to false when omitted (F-SS-1)", () => {
    const result = OrchestrateCommandSchema.safeParse({ idPrefix: "abc123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.useBlackboard).toBe(false);
      expect(result.data.skipChallenge).toBe(false);
      expect(result.data.useResume).toBe(false);
    }
  });

  // V12: invalid pipeline (F-DA-1: uppercase or unknown)
  it("rejects pipeline 'INVALID' (V12)", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "INVALID",
    });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase pipeline 'LIGHT' (F-DA-1)", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "LIGHT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects uppercase pipeline 'FULL' (F-DA-1)", () => {
    const result = OrchestrateCommandSchema.safeParse({
      idPrefix: "abc123",
      pipeline: "FULL",
    });
    expect(result.success).toBe(false);
  });

  it("rejects idPrefix shorter than 4 chars", () => {
    const result = OrchestrateCommandSchema.safeParse({ idPrefix: "ab" });
    expect(result.success).toBe(false);
  });

  it("rejects pure-dash idPrefix (F-EC-2)", () => {
    const result = OrchestrateCommandSchema.safeParse({ idPrefix: "----" });
    expect(result.success).toBe(false);
  });
});

// ── PrdCommandSchema (V13-V15) ────────────────────────────────

describe("PrdCommandSchema", () => {
  // V13: action list
  it("accepts { action: 'list' } (V13)", () => {
    const result = PrdCommandSchema.safeParse({ action: "list" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.action).toBe("list");
  });

  it("accepts { action: 'create', description: 'Feature X' }", () => {
    const result = PrdCommandSchema.safeParse({ action: "create", description: "Feature X" });
    expect(result.success).toBe(true);
  });

  it("accepts { action: 'approve' }", () => {
    const result = PrdCommandSchema.safeParse({ action: "approve" });
    expect(result.success).toBe(true);
  });

  it("accepts { action: 'reject' }", () => {
    const result = PrdCommandSchema.safeParse({ action: "reject" });
    expect(result.success).toBe(true);
  });

  // V14: view with hex id
  it("accepts { action: 'view', id: 'abc12345' } (V14)", () => {
    const result = PrdCommandSchema.safeParse({ action: "view", id: "abc12345" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe("view");
      expect(result.data.id).toBe("abc12345");
    }
  });

  it("accepts id with 4 chars (minimum)", () => {
    const result = PrdCommandSchema.safeParse({ action: "view", id: "abcd" });
    expect(result.success).toBe(true);
  });

  it("rejects id longer than 8 chars", () => {
    const result = PrdCommandSchema.safeParse({ action: "view", id: "abc123456" });
    expect(result.success).toBe(false);
  });

  // V15: invalid action
  it("rejects invalid action 'invalid_action' (V15)", () => {
    const result = PrdCommandSchema.safeParse({ action: "invalid_action" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown action 'delete'", () => {
    const result = PrdCommandSchema.safeParse({ action: "delete" });
    expect(result.success).toBe(false);
  });

  it("rejects missing action", () => {
    const result = PrdCommandSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // F-DA-2: validates extracted object fields, not raw string
  it("validates extracted object fields (F-DA-2 — not raw string)", () => {
    // Schema operates on { action, id?, description? } — not raw input string
    const result = PrdCommandSchema.safeParse({ action: "list" });
    expect(result.success).toBe(true);
    // Raw string would fail
    const rawResult = PrdCommandSchema.safeParse("/prd list");
    expect(rawResult.success).toBe(false);
  });

  it("validates error message is in French", () => {
    const result = PrdCommandSchema.safeParse({ action: "bad" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Message should be in French (custom errorMap)
      const message = result.error.issues[0]?.message || "";
      expect(message.toLowerCase()).toMatch(/action|actions|invalide/);
    }
  });
});
