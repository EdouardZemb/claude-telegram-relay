/**
 * Unit Tests — Explorer Agent (T3)
 *
 * Tests for explorer agent definition, schema, validation, and MCP config.
 */

import { describe, it, expect } from "bun:test";
import {
  getAgent,
  getAgentForCommand,
  buildAgentSystemPrompt,
} from "../../src/bmad-agents";
import {
  getSchemaForRole,
  getJsonSchemaForRole,
  validateAgentOutput,
  parseAgentOutput,
  formatStructuredOutput,
  type ExplorerOutput,
} from "../../src/agent-schemas";
import {
  getMcpToolsForRole,
  buildMcpToolInstructions,
  isToolAllowed,
} from "../../src/mcp-config";
import { isFeatureEnabled } from "../../src/feature-flags";

// ── Agent Definition ────────────────────────────────────────────

describe("Explorer Agent Definition", () => {
  it("exists in registry with correct metadata", () => {
    const explorer = getAgent("explorer");
    expect(explorer).toBeDefined();
    expect(explorer!.name).toBe("Ada");
    expect(explorer!.title).toBe("Explorer");
    expect(explorer!.icon).toBe("🔍");
  });

  it("has Haiku model with low effort and small budget", () => {
    const explorer = getAgent("explorer");
    expect(explorer!.effort).toBe("low");
    expect(explorer!.model).toBe("claude-haiku-4-5");
    expect(explorer!.maxBudgetUsd).toBe(0.10);
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
    expect(explorer!.criticalActions.some(a => a.toLowerCase().includes("read-only") || a.toLowerCase().includes("never modify"))).toBe(true);
  });
});

// ── Output Schema ───────────────────────────────────────────────

describe("Explorer Output Schema", () => {
  const validOutput: ExplorerOutput = {
    role: "explorer",
    etat_des_lieux: "Le module relay.ts fait 243 lignes et utilise le pattern Composer.",
    options: [
      {
        label: "Option A",
        description: "Refactorer en micro-modules",
        pros: ["separation des responsabilites"],
        cons: ["complexite accrue"],
      },
    ],
    recommandations: [
      {
        action: "Extraire le middleware auth dans un fichier dedie",
        effort: "small",
        impact: "medium",
        files: ["src/relay.ts"],
      },
    ],
    effort_estimate: {
      total: "2-3 heures",
      breakdown: ["1h extraction middleware", "1h tests", "30min validation"],
    },
    references: ["src/relay.ts:42", "src/loader.ts:10"],
  };

  it("has schema description for explorer role", () => {
    const schema = getSchemaForRole("explorer" as any);
    expect(schema).toBeTruthy();
    expect(schema).toContain("etat_des_lieux");
    expect(schema).toContain("recommandations");
    expect(schema).toContain("effort_estimate");
    expect(schema).toContain("references");
  });

  it("has JSON Schema for --json-schema flag", () => {
    const jsonSchema = getJsonSchemaForRole("explorer");
    expect(jsonSchema).toBeDefined();
    expect((jsonSchema as any).type).toBe("object");
    expect((jsonSchema as any).required).toContain("etat_des_lieux");
    expect((jsonSchema as any).required).toContain("options");
    expect((jsonSchema as any).required).toContain("recommandations");
  });

  it("validates correct explorer output", () => {
    expect(validateAgentOutput(validOutput, "explorer" as any)).toBe(true);
  });

  it("rejects output missing etat_des_lieux", () => {
    const invalid = { ...validOutput, etat_des_lieux: undefined };
    expect(validateAgentOutput(invalid, "explorer" as any)).toBe(false);
  });

  it("rejects output missing options array", () => {
    const invalid = { ...validOutput, options: "not an array" };
    expect(validateAgentOutput(invalid, "explorer" as any)).toBe(false);
  });

  it("rejects output missing recommandations array", () => {
    const invalid = { ...validOutput, recommandations: null };
    expect(validateAgentOutput(invalid, "explorer" as any)).toBe(false);
  });

  it("parses explorer output from JSON string", () => {
    const raw = JSON.stringify(validOutput);
    const parsed = parseAgentOutput(raw, "explorer" as any);
    expect(parsed).toBeDefined();
    expect(parsed!.role).toBe("explorer");
    expect((parsed as ExplorerOutput).etat_des_lieux).toBe(validOutput.etat_des_lieux);
  });

  it("parses explorer output from marker-wrapped JSON", () => {
    const raw = `Some preamble text\n<<<JSON>>>\n${JSON.stringify(validOutput)}\n<<<END>>>\nSome epilogue`;
    const parsed = parseAgentOutput(raw, "explorer" as any);
    expect(parsed).toBeDefined();
    expect(parsed!.role).toBe("explorer");
  });

  it("formats explorer output for display", () => {
    const formatted = formatStructuredOutput(validOutput);
    expect(formatted).toContain("Etat des lieux:");
    expect(formatted).toContain("Options:");
    expect(formatted).toContain("Recommandations:");
    expect(formatted).toContain("Effort:");
    expect(formatted).toContain("References:");
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

// ── Feature Flag ────────────────────────────────────────────────

describe("Explorer Feature Flag", () => {
  it("explore_mode flag exists and is enabled", () => {
    expect(isFeatureEnabled("explore_mode")).toBe(true);
  });
});
