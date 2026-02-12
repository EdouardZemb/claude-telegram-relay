/**
 * Unit Tests — src/bmad-agents.ts
 *
 * Tests for BMad agent definitions, command mapping, and prompt enrichment.
 */

import { describe, it, expect } from "bun:test";
import {
  getAgents,
  getAgent,
  getAgentForCommand,
  buildAgentSystemPrompt,
  enrichPromptWithAgent,
  buildBmadExecPrompt,
  formatAgentList,
} from "../../src/bmad-agents";

describe("Agent Registry", () => {
  it("has 6 agents defined", () => {
    expect(getAgents().length).toBe(6);
  });

  it("each agent has required fields", () => {
    for (const agent of getAgents()) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(agent.title).toBeDefined();
      expect(agent.icon).toBeDefined();
      expect(agent.role).toBeDefined();
      expect(agent.commands.length).toBeGreaterThan(0);
    }
  });

  it("getAgent returns correct agent by ID", () => {
    const pm = getAgent("pm");
    expect(pm).toBeDefined();
    expect(pm!.name).toBe("John");
    expect(pm!.title).toBe("Product Manager");
  });

  it("getAgent returns undefined for unknown ID", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });
});

describe("Command Mapping", () => {
  it("maps /exec to Dev agent (Amelia)", () => {
    const agent = getAgentForCommand("exec");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("dev");
    expect(agent!.name).toBe("Amelia");
  });

  it("maps /plan to PM agent (John)", () => {
    const agent = getAgentForCommand("plan");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("pm");
  });

  it("maps /retro to SM agent (Bob)", () => {
    const agent = getAgentForCommand("retro");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("sm");
  });

  it("maps /prd to PM agent (John)", () => {
    const agent = getAgentForCommand("prd");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("pm");
  });

  it("returns undefined for unmapped commands", () => {
    expect(getAgentForCommand("help")).toBeUndefined();
    expect(getAgentForCommand("unknown")).toBeUndefined();
  });
});

describe("System Prompt Building", () => {
  it("includes agent name and role", () => {
    const dev = getAgent("dev")!;
    const prompt = buildAgentSystemPrompt(dev);
    expect(prompt).toContain("Amelia");
    expect(prompt).toContain("Developer Agent");
    expect(prompt).toContain("Senior Software Engineer");
  });

  it("includes critical actions for Dev agent", () => {
    const dev = getAgent("dev")!;
    const prompt = buildAgentSystemPrompt(dev);
    expect(prompt).toContain("ACTIONS CRITIQUES");
    expect(prompt).toContain("READ the entire story file");
    expect(prompt).toContain("NEVER lie about tests");
  });

  it("omits critical actions for agents without them", () => {
    const pm = getAgent("pm")!;
    const prompt = buildAgentSystemPrompt(pm);
    expect(prompt).not.toContain("ACTIONS CRITIQUES");
  });
});

describe("Prompt Enrichment", () => {
  it("enriches prompt with agent persona for mapped commands", () => {
    const { enrichedPrompt, agent } = enrichPromptWithAgent("plan", "Decompose cette tache");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("pm");
    expect(enrichedPrompt).toContain("John");
    expect(enrichedPrompt).toContain("Decompose cette tache");
  });

  it("returns original prompt for unmapped commands", () => {
    const { enrichedPrompt, agent } = enrichPromptWithAgent("help", "Show help");
    expect(agent).toBeUndefined();
    expect(enrichedPrompt).toBe("Show help");
  });
});

describe("BMad Exec Prompt", () => {
  it("builds a complete prompt with task details", () => {
    const prompt = buildBmadExecPrompt({
      title: "Fix the login bug",
      description: "Users cannot login with email",
      project: "my-app",
      priority: 1,
    });

    expect(prompt).toContain("Amelia");
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("Users cannot login with email");
    expect(prompt).toContain("my-app");
    expect(prompt).toContain("P1");
  });

  it("includes acceptance criteria when present", () => {
    const prompt = buildBmadExecPrompt({
      title: "Add button",
      acceptance_criteria: "Given a user on the homepage\nWhen they click the button\nThen a modal appears",
    });

    expect(prompt).toContain("CRITERES D'ACCEPTATION");
    expect(prompt).toContain("Given a user");
  });

  it("includes subtasks when present", () => {
    const prompt = buildBmadExecPrompt({
      title: "Implement feature",
      subtasks: [
        { title: "Create component", ac_mapping: "AC-1", done: false },
        { title: "Add tests", done: true },
      ],
    });

    expect(prompt).toContain("SOUS-TACHES");
    expect(prompt).toContain("[ ] Create component (AC: AC-1)");
    expect(prompt).toContain("[x] Add tests");
  });
});

describe("Format Agent List", () => {
  it("lists all agents with commands", () => {
    const list = formatAgentList();
    expect(list).toContain("AGENTS BMAD");
    expect(list).toContain("Mary");
    expect(list).toContain("John");
    expect(list).toContain("Winston");
    expect(list).toContain("Bob");
    expect(list).toContain("Amelia");
    expect(list).toContain("Quinn");
    expect(list).toContain("COMMANDES TELEGRAM -> AGENTS");
    expect(list).toContain("/exec");
    expect(list).toContain("/plan");
  });
});
