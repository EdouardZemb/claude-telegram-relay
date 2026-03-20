/**
 * Unit Tests — Alert Cooldown Types & Config
 *
 * Covers AC-1, AC-2, AC-3 for alert cooldown system.
 */

import { describe, it, expect } from "bun:test";
import type { AlertEntityState, AlertState, AlertCooldowns } from "../../src/alerts";
import type { Alert } from "../../src/alerts";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CONFIG_PATH = join(import.meta.dir, "../../config/alert-cooldowns.json");

// AC-1: Interfaces are available and have correct fields
describe("Alert Cooldown Types (AC-1)", () => {
  it("AlertEntityState has lastAlertedAt, alertCount, lastSeverity", () => {
    const state: AlertEntityState = {
      lastAlertedAt: Date.now(),
      alertCount: 3,
      lastSeverity: "warning",
    };
    expect(state.lastAlertedAt).toBeGreaterThan(0);
    expect(state.alertCount).toBe(3);
    expect(state.lastSeverity).toBe("warning");
  });

  it("AlertEntityState lastSeverity accepts all Alert severity values", () => {
    const severities: Alert["severity"][] = ["info", "warning", "critical"];
    for (const severity of severities) {
      const state: AlertEntityState = {
        lastAlertedAt: 0,
        alertCount: 0,
        lastSeverity: severity,
      };
      expect(state.lastSeverity).toBe(severity);
    }
  });

  it("AlertState maps alert types to entity records", () => {
    const state: AlertState = {
      stuck_task: {
        "task-123": { lastAlertedAt: 1000, alertCount: 2, lastSeverity: "warning" },
      },
      high_rework: {
        "sprint-1": { lastAlertedAt: 2000, alertCount: 1, lastSeverity: "critical" },
      },
    };
    expect(state.stuck_task?.["task-123"]?.alertCount).toBe(2);
    expect(state.high_rework?.["sprint-1"]?.lastSeverity).toBe("critical");
  });

  it("AlertState allows partial (not all alert types required)", () => {
    const state: AlertState = {};
    expect(state.stuck_task).toBeUndefined();
    expect(state.stale_task).toBeUndefined();
  });

  it("AlertCooldowns has normalCooldownMs and criticalCooldownMs per type", () => {
    const cooldowns: AlertCooldowns = {
      stuck_task: { normalCooldownMs: 21600000, criticalCooldownMs: 43200000 },
      stale_task: { normalCooldownMs: 86400000, criticalCooldownMs: null },
      high_rework: { normalCooldownMs: 43200000, criticalCooldownMs: 21600000 },
      behind_schedule: { normalCooldownMs: 28800000, criticalCooldownMs: 14400000 },
      review_score_drop: { normalCooldownMs: 86400000, criticalCooldownMs: 43200000 },
      agent_failure_pattern: { normalCooldownMs: 14400000, criticalCooldownMs: 7200000 },
      long_running_step: { normalCooldownMs: 7200000, criticalCooldownMs: 3600000 },
    };
    expect(cooldowns.stuck_task.normalCooldownMs).toBe(21600000);
    expect(cooldowns.stale_task.criticalCooldownMs).toBeNull();
  });

  it("AlertCooldowns criticalCooldownMs accepts null for never-re-alert", () => {
    const cooldowns: AlertCooldowns = {
      stuck_task: { normalCooldownMs: 1, criticalCooldownMs: null },
      stale_task: { normalCooldownMs: 1, criticalCooldownMs: null },
      high_rework: { normalCooldownMs: 1, criticalCooldownMs: null },
      behind_schedule: { normalCooldownMs: 1, criticalCooldownMs: null },
      review_score_drop: { normalCooldownMs: 1, criticalCooldownMs: null },
      agent_failure_pattern: { normalCooldownMs: 1, criticalCooldownMs: null },
      long_running_step: { normalCooldownMs: 1, criticalCooldownMs: null },
    };
    for (const key of Object.keys(cooldowns) as Alert["type"][]) {
      expect(cooldowns[key].criticalCooldownMs).toBeNull();
    }
  });
});

// AC-2: config/alert-cooldowns.json exists with 7 types
describe("Alert Cooldowns Config File (AC-2)", () => {
  it("config/alert-cooldowns.json exists", () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  it("contains valid JSON", () => {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("has exactly 7 alert types", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const expectedTypes: Alert["type"][] = [
      "stuck_task",
      "stale_task",
      "high_rework",
      "behind_schedule",
      "review_score_drop",
      "agent_failure_pattern",
      "long_running_step",
    ];
    expect(Object.keys(config).sort()).toEqual(expectedTypes.sort());
  });

  it("each type has normalCooldownMs and criticalCooldownMs", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    for (const [type, value] of Object.entries(config)) {
      const v = value as { normalCooldownMs: number; criticalCooldownMs: number | null };
      expect(typeof v.normalCooldownMs).toBe("number");
      expect(v.normalCooldownMs).toBeGreaterThan(0);
      expect(v.criticalCooldownMs === null || typeof v.criticalCooldownMs === "number").toBe(true);
    }
  });

  it("config is type-compatible with AlertCooldowns", () => {
    const config: AlertCooldowns = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(config.stuck_task).toBeDefined();
    expect(config.long_running_step).toBeDefined();
  });
});

// AC-3: stuck_task specific values
describe("Alert Cooldowns Values (AC-3)", () => {
  it("stuck_task normalCooldownMs = 21600000 (6h)", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(config.stuck_task.normalCooldownMs).toBe(21600000);
  });

  it("stuck_task criticalCooldownMs = 43200000 (12h)", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(config.stuck_task.criticalCooldownMs).toBe(43200000);
  });

  it("stale_task criticalCooldownMs is null (jamais)", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(config.stale_task.criticalCooldownMs).toBeNull();
  });

  it("all cooldown values match specification", () => {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Verify all values from the spec
    expect(config.stuck_task).toEqual({ normalCooldownMs: 21600000, criticalCooldownMs: 43200000 });
    expect(config.stale_task).toEqual({ normalCooldownMs: 86400000, criticalCooldownMs: null });
    expect(config.high_rework).toEqual({ normalCooldownMs: 43200000, criticalCooldownMs: 21600000 });
    expect(config.behind_schedule).toEqual({ normalCooldownMs: 28800000, criticalCooldownMs: 14400000 });
    expect(config.review_score_drop).toEqual({ normalCooldownMs: 86400000, criticalCooldownMs: 43200000 });
    expect(config.agent_failure_pattern).toEqual({ normalCooldownMs: 14400000, criticalCooldownMs: 7200000 });
    expect(config.long_running_step).toEqual({ normalCooldownMs: 7200000, criticalCooldownMs: 3600000 });
  });
});
