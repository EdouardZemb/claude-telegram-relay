/**
 * Unit Tests — src/bmad-prompts.ts
 *
 * Tests for agent prompt building, isolation instructions,
 * and capabilities.
 */

import { describe, it, expect } from "bun:test";
import {
  buildFullAgentPrompt,
  getAgentCapabilities,
  checkAgentPermission,
  buildIsolationInstructions,
  type AgentPromptContext,
} from "../../src/bmad-prompts";

describe("buildFullAgentPrompt", () => {
  it("returns empty string for unknown agent", () => {
    const context: AgentPromptContext = { command: "exec" };
    const prompt = buildFullAgentPrompt("nonexistent_agent", context);
    expect(prompt).toBe("");
  });

  it("builds prompt for dev agent with exec command", () => {
    const context: AgentPromptContext = {
      command: "exec",
      taskTitle: "Implementer feature X",
      taskDescription: "Description complete",
      priority: 1,
      sprintId: "S17",
    };

    const prompt = buildFullAgentPrompt("dev", context);
    expect(prompt).toContain("ROLE:");
    expect(prompt).toContain("TACHE: Implementer feature X");
    expect(prompt).toContain("PRIORITE: P1");
    expect(prompt).toContain("SPRINT: S17");
    expect(prompt).toContain("INSTRUCTIONS EXECUTION");
  });

  it("includes acceptance criteria when provided", () => {
    const context: AgentPromptContext = {
      command: "exec",
      taskTitle: "Test",
      acceptanceCriteria: "Le systeme doit supporter 1000 users",
    };

    const prompt = buildFullAgentPrompt("dev", context);
    expect(prompt).toContain("CRITERES D'ACCEPTATION");
    expect(prompt).toContain("1000 users");
  });

  it("includes subtasks when provided", () => {
    const context: AgentPromptContext = {
      command: "exec",
      taskTitle: "Test",
      subtasks: [
        { title: "Step 1", done: true },
        { title: "Step 2", done: false },
      ],
    };

    const prompt = buildFullAgentPrompt("dev", context);
    expect(prompt).toContain("SOUS-TACHES");
    expect(prompt).toContain("[x] Step 1");
    expect(prompt).toContain("[ ] Step 2");
  });

  it("builds prompt for pm agent with plan command", () => {
    const context: AgentPromptContext = {
      command: "plan",
      taskTitle: "Planifier Sprint",
    };

    const prompt = buildFullAgentPrompt("pm", context);
    expect(prompt).toContain("INSTRUCTIONS DECOMPOSITION");
    expect(prompt).toContain("sous-taches");
  });

  it("builds prompt for sm agent with retro command", () => {
    const context: AgentPromptContext = {
      command: "retro",
      sprintId: "S16",
    };

    const prompt = buildFullAgentPrompt("sm", context);
    expect(prompt).toContain("INSTRUCTIONS RETRO");
  });

  it("builds prompt for qa agent with alerts command", () => {
    const context: AgentPromptContext = { command: "alerts" };

    const prompt = buildFullAgentPrompt("qa", context);
    expect(prompt).toContain("INSTRUCTIONS ALERTES");
  });

  it("includes sharded context when provided", () => {
    const context: AgentPromptContext = {
      command: "exec",
      taskTitle: "Test",
      shardedContext: "PRD: Feature description\nArchitecture: Module design",
    };

    const prompt = buildFullAgentPrompt("dev", context);
    expect(prompt).toContain("CONTEXTE DOCUMENTS");
    expect(prompt).toContain("PRD: Feature description");
  });

  it("includes dev notes when provided", () => {
    const context: AgentPromptContext = {
      command: "exec",
      taskTitle: "Test",
      devNotes: "Attention au rate limiting",
    };

    const prompt = buildFullAgentPrompt("dev", context);
    expect(prompt).toContain("NOTES DEV");
    expect(prompt).toContain("rate limiting");
  });
});

describe("getAgentCapabilities", () => {
  it("returns dev capabilities", () => {
    const caps = getAgentCapabilities("dev");
    expect(caps.canModifyCode).toBe(true);
    expect(caps.canModifyArchitecture).toBe(false);
    expect(caps.canDeployToProduction).toBe(false);
  });

  it("returns pm capabilities", () => {
    const caps = getAgentCapabilities("pm");
    expect(caps.canModifyCode).toBe(false);
    expect(caps.canModifyPRD).toBe(true);
    expect(caps.canCreateTasks).toBe(true);
  });

  it("returns architect capabilities", () => {
    const caps = getAgentCapabilities("architect");
    expect(caps.canModifyArchitecture).toBe(true);
    expect(caps.canReviewCode).toBe(true);
    expect(caps.canModifyCode).toBe(false);
  });

  it("returns qa capabilities", () => {
    const caps = getAgentCapabilities("qa");
    expect(caps.canModifyCode).toBe(true);
    expect(caps.canReviewCode).toBe(true);
    expect(caps.canModifyPRD).toBe(false);
  });

  it("returns safe defaults for unknown agent", () => {
    const caps = getAgentCapabilities("unknown_agent");
    expect(caps.canModifyCode).toBe(false);
    expect(caps.canModifyArchitecture).toBe(false);
    expect(caps.canDeployToProduction).toBe(false);
  });
});

describe("checkAgentPermission", () => {
  it("allows dev to modify code", () => {
    expect(checkAgentPermission("dev", "canModifyCode")).toBe(true);
  });

  it("denies dev from deploying to production", () => {
    expect(checkAgentPermission("dev", "canDeployToProduction")).toBe(false);
  });

  it("allows pm to create tasks", () => {
    expect(checkAgentPermission("pm", "canCreateTasks")).toBe(true);
  });

  it("denies pm from modifying code", () => {
    expect(checkAgentPermission("pm", "canModifyCode")).toBe(false);
  });
});

describe("buildIsolationInstructions", () => {
  it("lists restrictions for dev agent", () => {
    const instructions = buildIsolationInstructions("dev");
    expect(instructions).toContain("LIMITES DE TON ROLE");
    expect(instructions).toContain("ne PEUX PAS modifier les decisions d'architecture");
    expect(instructions).not.toContain("ne PEUX PAS modifier le code source");
  });

  it("lists restrictions for analyst agent", () => {
    const instructions = buildIsolationInstructions("analyst");
    expect(instructions).toContain("ne PEUX PAS modifier le code source");
    expect(instructions).toContain("ne PEUX PAS creer de taches");
  });

  it("lists allowed file patterns", () => {
    const instructions = buildIsolationInstructions("dev");
    expect(instructions).toContain("Fichiers autorises");
    expect(instructions).toContain("src/**");
  });
});
