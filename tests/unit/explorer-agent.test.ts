/**
 * Unit Tests — Explorer Agent (T3)
 *
 * Tests for explorer agent definition, schema, validation, and MCP config.
 */

import { describe, expect, it } from "bun:test";
import { buildAgentSystemPrompt, getAgent, getAgentForCommand } from "../../src/bmad-agents";
import { buildMcpToolInstructions, getMcpToolsForRole, isToolAllowed } from "../../src/mcp-config";

// ── Agent Definition ────────────────────────────────────────────

describe("Explorer Agent Definition", () => {
  it("exists in registry with correct metadata", () => {
    const explorer = getAgent("explorer");
    expect(explorer).toBeDefined();
    expect(explorer!.name).toBe("Ada");
    expect(explorer!.title).toBe("Explorer");
    expect(explorer!.icon).toBe("🔍");
  });

  it("has Haiku model with low effort and no budget limit", () => {
    const explorer = getAgent("explorer");
    expect(explorer!.effort).toBe("low");
    expect(explorer!.model).toBe("claude-haiku-4-5");
    expect(explorer!.maxBudgetUsd).toBeUndefined();
  });

  it("has trust thresholds", () => {
    const explorer = getAgent("explorer");
    expect(explorer!.trustThresholds).toBeDefined();
    expect(explorer!.trustThresholds!.specAutoApprove).toBe(60);
    expect(explorer!.trustThresholds!.implAutoApprove).toBe(80);
  });

  it("maps /explore to explorer agent", () => {
    const agent = getAgentForCommand("explore");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("explorer");
  });

  it("builds system prompt with explorer persona", () => {
    const explorer = getAgent("explorer");
    const prompt = buildAgentSystemPrompt(explorer!);
    expect(prompt).toContain("Ada");
    expect(prompt).toContain("Explorer");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("file paths");
  });

  it("has critical actions for read-only behavior", () => {
    const explorer = getAgent("explorer");
    expect(explorer!.criticalActions.length).toBeGreaterThan(0);
    expect(
      explorer!.criticalActions.some(
        (a) => a.toLowerCase().includes("read-only") || a.toLowerCase().includes("never modify"),
      ),
    ).toBe(true);
  });
});

// ── MCP Config ──────────────────────────────────────────────────

describe("Explorer MCP Config", () => {
  it("has MCP tools configured for explorer", () => {
    const tools = getMcpToolsForRole("explorer");
    expect(tools.length).toBeGreaterThan(0);
  });

  it("explorer has read-only access (no write_blackboard, no capture_thought)", () => {
    expect(isToolAllowed("explorer", "write_blackboard")).toBe(false);
    expect(isToolAllowed("explorer", "capture_thought")).toBe(false);
  });

  it("explorer can read project context and blackboard", () => {
    expect(isToolAllowed("explorer", "get_project_context")).toBe(true);
    expect(isToolAllowed("explorer", "read_blackboard")).toBe(true);
    expect(isToolAllowed("explorer", "search_thoughts")).toBe(true);
  });

  it("builds MCP tool instructions for explorer", () => {
    const instructions = buildMcpToolInstructions("explorer");
    expect(instructions).toContain("OUTILS MCP");
    expect(instructions).toContain("read-only");
    expect(instructions).toContain("search_thoughts");
  });
});
