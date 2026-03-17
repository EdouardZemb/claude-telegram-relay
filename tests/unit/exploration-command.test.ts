/**
 * Unit Tests — /explore Command (T4)
 *
 * Tests for the exploration Composer: command registration, topic config,
 * action registry, prompt building, and feature flag gating.
 */

import { describe, it, expect } from "bun:test";
import { getAction } from "../../src/action-registry";
import { getTopicConfig } from "../../src/topic-config";
import { getAgent, getAgentForCommand } from "../../src/bmad-agents";
import {
  buildAgentSystemPromptPart,
  buildAgentTaskPromptPart,
} from "../../src/bmad-prompts";
import {
  getJsonSchemaForRole,
  getSchemaForRole,
  buildStructuredOutputInstructions,
} from "../../src/agent-schemas";
import { isFeatureEnabled } from "../../src/feature-flags";

// ── Action Registry Integration ─────────────────────────────────

describe("/explore Action Registry", () => {
  it("is registered in action registry", () => {
    const action = getAction("explore");
    expect(action).toBeDefined();
    expect(action!.command).toBe("explore");
  });

  it("has low risk level", () => {
    const action = getAction("explore");
    expect(action!.risk).toBe("low");
  });

  it("requires Supabase", () => {
    const action = getAction("explore");
    expect(action!.requiresSupabase).toBe(true);
  });

  it("has query parameter as required", () => {
    const action = getAction("explore");
    expect(action!.params.length).toBe(1);
    expect(action!.params[0].name).toBe("query");
    expect(action!.params[0].required).toBe(true);
  });

  it("has French aliases for intent detection", () => {
    const action = getAction("explore");
    expect(action!.aliases.length).toBeGreaterThan(0);
    expect(action!.aliases).toContain("explorer");
  });

  it("references exploration module", () => {
    const action = getAction("explore");
    expect(action!.module).toBe("exploration");
  });
});

// ── Topic Config Integration ────────────────────────────────────

describe("/explore Topic Config", () => {
  it("is allowed in claude-relay (Dev) topic", () => {
    const config = getTopicConfig("claude-relay");
    expect(config).toBeDefined();
    expect(config!.allowedCommands).toContain("explore");
  });

  it("is allowed in idees (Brainstorm) topic", () => {
    const config = getTopicConfig("idees");
    expect(config).toBeDefined();
    expect(config!.allowedCommands).toContain("explore");
  });

  it("is allowed in sprint topic", () => {
    const config = getTopicConfig("sprint");
    expect(config).toBeDefined();
    expect(config!.allowedCommands).toContain("explore");
  });
});

// ── Agent Mapping ───────────────────────────────────────────────

describe("/explore Agent Mapping", () => {
  it("/explore maps to explorer agent", () => {
    const agent = getAgentForCommand("explore");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("explorer");
    expect(agent!.name).toBe("Ada");
  });

  it("explorer agent uses Haiku model", () => {
    const agent = getAgent("explorer");
    expect(agent!.model).toBe("claude-haiku-4-5");
  });

  it("explorer agent has low effort", () => {
    const agent = getAgent("explorer");
    expect(agent!.effort).toBe("low");
  });

  it("explorer agent has $0.10 budget", () => {
    const agent = getAgent("explorer");
    expect(agent!.maxBudgetUsd).toBe(0.10);
  });
});

// ── Prompt Building ─────────────────────────────────────────────

describe("/explore Prompt Building", () => {
  it("builds system prompt with explorer persona", () => {
    const systemPrompt = buildAgentSystemPromptPart("explorer", {
      command: "explore",
      taskTitle: "comment fonctionne le pipeline",
    });
    expect(systemPrompt).toContain("Ada");
    expect(systemPrompt).toContain("Explorer");
    expect(systemPrompt).toContain("EXPLORATION");
  });

  it("system prompt includes read-only instructions", () => {
    const systemPrompt = buildAgentSystemPromptPart("explorer", {
      command: "explore",
      taskTitle: "test",
    });
    expect(systemPrompt.toLowerCase()).toContain("lecture seule");
  });

  it("builds task prompt with query context", () => {
    const taskPrompt = buildAgentTaskPromptPart("explorer", {
      command: "explore",
      taskTitle: "architecture du pipeline multi-agents",
      projectName: "telegram-relay",
    });
    expect(taskPrompt).toContain("architecture du pipeline multi-agents");
    expect(taskPrompt).toContain("telegram-relay");
  });

  it("has structured output instructions for explorer", () => {
    const instructions = buildStructuredOutputInstructions("explorer" as any);
    expect(instructions).toContain("JSON");
    expect(instructions).toContain("etat_des_lieux");
    expect(instructions).toContain("recommandations");
  });

  it("has JSON schema for --json-schema flag", () => {
    const schema = getJsonSchemaForRole("explorer");
    expect(schema).toBeDefined();
    expect((schema as any).properties.etat_des_lieux).toBeDefined();
    expect((schema as any).properties.options).toBeDefined();
    expect((schema as any).properties.recommandations).toBeDefined();
  });

  it("has schema description for prompt injection", () => {
    const schema = getSchemaForRole("explorer" as any);
    expect(schema).toBeTruthy();
    expect(schema).toContain("etat_des_lieux");
    expect(schema).toContain("options");
  });
});

// ── Feature Flag Gating ─────────────────────────────────────────

describe("/explore Feature Flag", () => {
  it("explore_mode flag is enabled", () => {
    expect(isFeatureEnabled("explore_mode")).toBe(true);
  });
});
