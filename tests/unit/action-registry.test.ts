import { describe, expect, it } from "bun:test";
import {
  formatActionsForLLM,
  getAction,
  getActionsByCategory,
  getActionsByRisk,
  getActionsRequiringParam,
  getAllActions,
} from "../../src/action-registry.ts";

describe("action-registry", () => {
  describe("getAction", () => {
    it("returns action by command name", () => {
      const action = getAction("backlog");
      expect(action).toBeDefined();
      expect(action!.command).toBe("backlog");
      expect(action!.description).toContain("backlog");
      expect(action!.risk).toBe("low");
    });

    it("returns undefined for unknown command", () => {
      expect(getAction("nonexistent")).toBeUndefined();
    });

    it("returns correct metadata for help", () => {
      const action = getAction("help");
      expect(action).toBeDefined();
      expect(action!.risk).toBe("low");
      expect(action!.requiresSupabase).toBe(false);
      expect(action!.params.length).toBe(0);
    });

    it("returns correct metadata for docs", () => {
      const action = getAction("docs");
      expect(action).toBeDefined();
      expect(action!.risk).toBe("low");
      expect(action!.requiresSupabase).toBe(true);
      expect(action!.module).toBe("documents");
      expect(action!.params.length).toBe(2);
      expect(action!.aliases).toContain("documents");
      expect(action!.aliases).toContain("facture");
    });
  });

  describe("getAllActions", () => {
    it("returns all registered actions", () => {
      const actions = getAllActions();
      expect(actions.length).toBeGreaterThanOrEqual(25);
    });

    it("covers all known commands", () => {
      const commands = getAllActions().map((a) => a.command);
      const expected = [
        "help",
        "workflow",
        "status",
        "monitor",
        "task",
        "backlog",
        "sprint",
        "start",
        "done",
        "explore",
        "docs",
        "brain",
        "ideas",
        "remind",
        "metrics",
        "retro",
        "patterns",
        "alerts",
        "cost",
        "profile",
        "notify",
        "projects",
        "project",
        "speak",
        "export",
        "feature",
        "rollback",
      ];
      for (const cmd of expected) {
        expect(commands).toContain(cmd);
      }
    });

    it("every action has required fields", () => {
      for (const action of getAllActions()) {
        expect(action.command).toBeTruthy();
        expect(action.description).toBeTruthy();
        expect(action.usage).toBeTruthy();
        expect(["low", "medium", "high"]).toContain(action.risk);
        expect(action.module).toBeTruthy();
        expect(Array.isArray(action.params)).toBe(true);
        expect(Array.isArray(action.aliases)).toBe(true);
        expect(action.aliases.length).toBeGreaterThan(0);
      }
    });

    it("every action has a category for menu grouping", () => {
      const validCategories = ["tasks", "quality", "knowledge", "project", "system"];
      for (const action of getAllActions()) {
        expect(action.category).toBeTruthy();
        expect(validCategories).toContain(action.category);
      }
    });
  });

  describe("getActionsByRisk", () => {
    it("returns low-risk actions", () => {
      const low = getActionsByRisk("low");
      expect(low.length).toBeGreaterThan(0);
      for (const a of low) {
        expect(a.risk).toBe("low");
      }
    });

    it("returns high-risk actions", () => {
      const high = getActionsByRisk("high");
      expect(high.length).toBeGreaterThan(0);
      const commands = high.map((a) => a.command);
      expect(commands).toContain("rollback");
    });

    it("returns medium-risk actions", () => {
      const medium = getActionsByRisk("medium");
      expect(medium.length).toBeGreaterThan(0);
      const commands = medium.map((a) => a.command);
      expect(commands).toContain("task");
      expect(commands).toContain("done");
      expect(commands).toContain("start");
    });
  });

  describe("getActionsRequiringParam", () => {
    it("finds actions requiring taskId", () => {
      const actions = getActionsRequiringParam("taskId");
      expect(actions.length).toBeGreaterThanOrEqual(2);
      const commands = actions.map((a) => a.command);
      expect(commands).toContain("start");
      expect(commands).toContain("done");
    });

    it("finds actions requiring title", () => {
      const actions = getActionsRequiringParam("title");
      expect(actions.length).toBeGreaterThanOrEqual(1);
      expect(actions.map((a) => a.command)).toContain("task");
    });

    it("returns empty for nonexistent param", () => {
      expect(getActionsRequiringParam("xyz")).toHaveLength(0);
    });
  });

  describe("getActionsByCategory", () => {
    it("returns actions for tasks category", () => {
      const tasks = getActionsByCategory("tasks");
      expect(tasks.length).toBeGreaterThan(0);
      const commands = tasks.map((a) => a.command);
      expect(commands).toContain("task");
      expect(commands).toContain("backlog");
      expect(commands).toContain("sprint");
    });

    it("returns actions for quality category", () => {
      const quality = getActionsByCategory("quality");
      expect(quality.length).toBeGreaterThan(0);
      const commands = quality.map((a) => a.command);
      expect(commands).toContain("metrics");
      expect(commands).toContain("retro");
    });

    it("returns empty for unknown category", () => {
      expect(getActionsByCategory("nonexistent")).toHaveLength(0);
    });
  });

  describe("formatActionsForLLM", () => {
    it("returns all actions in readable format", () => {
      const formatted = formatActionsForLLM();
      expect(formatted).toContain("/backlog");
      expect(formatted).toContain("low");
      expect(formatted).toContain("high");
    });

    it("each line starts with /command", () => {
      const lines = formatActionsForLLM().split("\n");
      for (const line of lines) {
        expect(line).toMatch(/^\/\w+/);
      }
    });
  });
});
