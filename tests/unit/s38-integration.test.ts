/**
 * Tests for S38 integration: blackboard messages section,
 * context enrichment, and backward compatibility.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  InMemoryBlackboard,
  type SectionName,
} from "../../src/blackboard.ts";
import { buildStructuredChainContext } from "../../src/agent-schemas.ts";
import type { AgentMessage } from "../../src/agent-schemas.ts";


// ── Blackboard Messages Section ──────────────────────────────

describe("Blackboard messages section", () => {
  // AC-006: Section messages available in blackboard
  it("includes messages in SectionName type", () => {
    const validSections: SectionName[] = [
      "spec", "plan", "tasks", "implementation",
      "verification", "working_memory", "messages",
    ];
    expect(validSections.length).toBe(7);
  });

  it("InMemoryBlackboard creates with messages section", () => {
    const bb = new InMemoryBlackboard();
    const row = bb.create("task-1", "session-1");
    expect(row.sections.messages).toBeNull();
  });

  // AC-010: All roles authorized to write messages
  it("allows all agent roles to write to messages section", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const roles = ["analyst", "pm", "architect", "dev", "qa", "sm"];
    let version = 1;

    for (const role of roles) {
      const result = bb.write("session-1", "messages", { test: role }, role, version);
      expect(result.success).toBe(true);
      version = result.newVersion;
    }
  });

  it("system role can write to messages section", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const result = bb.write("session-1", "messages", { test: "system" }, "system", 1);
    expect(result.success).toBe(true);
  });

  // EC-005: Sequential mode works with messages
  it("works with sequential writes", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    const r1 = bb.write("session-1", "messages", { messages: [{ from: "dev" }] }, "dev", 1);
    expect(r1.success).toBe(true);

    const data = bb.read("session-1", "messages");
    expect(data.messages.length).toBe(1);
  });
});

// ── buildStructuredChainContext S38 ──────────────────────────

describe("buildStructuredChainContext with inter-agent context", () => {
  // AC-023: buildStructuredChainContext includes inter-agent messages
  it("includes inter-agent context when provided", () => {
    const messages: AgentMessage[] = [{
      agentId: "analyst",
      agentName: "Analyst",
      success: true,
      structured: null,
      rawOutput: "Analysis result",
      durationMs: 1000,
    }];

    const interCtx = "MESSAGES INTER-AGENTS:\n[WARNING] qa -> dev: Missing tests";
    const result = buildStructuredChainContext(messages, interCtx);

    expect(result).toContain("CONTEXTE STRUCTURE DES AGENTS PRECEDENTS:");
    expect(result).toContain("Analysis result");
    expect(result).toContain("MESSAGES INTER-AGENTS:");
    expect(result).toContain("Missing tests");
  });

  it("works without inter-agent context (backward compatible)", () => {
    const messages: AgentMessage[] = [{
      agentId: "dev",
      agentName: "Dev",
      success: true,
      structured: null,
      rawOutput: "Dev output",
      durationMs: 500,
    }];

    const result = buildStructuredChainContext(messages);
    expect(result).toContain("Dev output");
    expect(result).not.toContain("MESSAGES INTER-AGENTS:");
  });

  it("works with only inter-agent context (no previous messages)", () => {
    const interCtx = "MESSAGES INTER-AGENTS:\n[DIRECTIVE] architect -> dev: Use pattern X";
    const result = buildStructuredChainContext([], interCtx);
    expect(result).toContain("Use pattern X");
  });

  it("returns empty when both messages and context are empty", () => {
    const result = buildStructuredChainContext([]);
    expect(result).toBe("");
  });
});


// ── SC-007: Backward Compatibility ───────────────────────────

describe("backward compatibility", () => {
  it("existing blackboard operations work unchanged", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    // Existing operations should still work
    const specResult = bb.write("session-1", "spec", { analysis: "test" }, "analyst", 1);
    expect(specResult.success).toBe(true);

    const planResult = bb.write("session-1", "plan", { design: "test" }, "architect", 2);
    expect(planResult.success).toBe(true);

    const spec = bb.read("session-1", "spec");
    expect(spec.analysis).toBe("test");
  });

  it("role authorization unchanged for existing sections", () => {
    const bb = new InMemoryBlackboard();
    bb.create("task-1", "session-1");

    // Dev can't write to spec
    const denied = bb.write("session-1", "spec", { test: true }, "dev", 1);
    expect(denied.success).toBe(false);

    // Analyst can write to spec
    const allowed = bb.write("session-1", "spec", { test: true }, "analyst", 1);
    expect(allowed.success).toBe(true);
  });
});
