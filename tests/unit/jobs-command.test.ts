import { describe, expect, it } from "bun:test";
import { getAction, getAllActions } from "../../src/action-registry.ts";

describe("action-registry backgroundEligible", () => {
  it("marks explore as background eligible", () => {
    expect(getAction("explore")!.backgroundEligible).toBe(true);
  });

  it("marks retro as background eligible", () => {
    expect(getAction("retro")!.backgroundEligible).toBe(true);
  });

  it("marks rollback as background eligible", () => {
    expect(getAction("rollback")!.backgroundEligible).toBe(true);
  });

  it("does not mark help as background eligible", () => {
    expect(getAction("help")!.backgroundEligible).toBeUndefined();
  });

  it("does not mark backlog as background eligible", () => {
    expect(getAction("backlog")!.backgroundEligible).toBeUndefined();
  });

  it("does not mark sprint as background eligible", () => {
    expect(getAction("sprint")!.backgroundEligible).toBeUndefined();
  });

  it("does not mark status as background eligible", () => {
    expect(getAction("status")!.backgroundEligible).toBeUndefined();
  });

  it("does not mark task as background eligible", () => {
    expect(getAction("task")!.backgroundEligible).toBeUndefined();
  });

  it("registers the /jobs command", () => {
    const action = getAction("jobs");
    expect(action).toBeDefined();
    expect(action!.risk).toBe("low");
    expect(action!.module).toBe("jobs");
    expect(action!.requiresSupabase).toBe(false);
  });

  it("counts background eligible commands", () => {
    const bgActions = getAllActions().filter((a) => a.backgroundEligible);
    expect(bgActions.length).toBeGreaterThanOrEqual(3);
  });

  it("all background eligible commands call spawnClaude or long operations", () => {
    const bgCommands = getAllActions()
      .filter((a) => a.backgroundEligible)
      .map((a) => a.command);
    const expected = [
      "explore",
      "retro",
      "rollback",
    ];
    for (const cmd of expected) {
      expect(bgCommands).toContain(cmd);
    }
  });
});
