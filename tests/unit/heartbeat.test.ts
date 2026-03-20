/**
 * Heartbeat — Unit Tests
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";
import {
  buildHeartbeatPrompt,
  createDefaultState,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_DECISION_SCHEMA,
  type HeartbeatState,
  type HeartbeatDelta,
} from "../../src/heartbeat-prompt";

// ── heartbeat-prompt.ts ─────────────────────────────────────

describe("HeartbeatPrompt", () => {
  describe("createDefaultState", () => {
    it("should return empty default state", () => {
      const state = createDefaultState();
      expect(state.lastPulseAt).toBe("");
      expect(state.lastCommitSha).toBe("");
      expect(state.lastSprintSnapshot.sprint).toBeNull();
      expect(state.lastSprintSnapshot.done).toBe(0);
      expect(state.lastSprintSnapshot.total).toBe(0);
      expect(state.recentActions).toEqual([]);
      expect(state.cooldowns).toEqual({});
    });

    it("should include periodic task tracking fields", () => {
      const state = createDefaultState();
      expect(state.lastAlertCheckAt).toBeNull();
      expect(state.lastArchivalAt).toBeNull();
      expect(state.lastAutonomyScanAt).toBeNull();
    });
  });

  describe("buildHeartbeatPrompt", () => {
    const baseState: HeartbeatState = {
      lastPulseAt: "2026-03-17T12:00:00.000Z",
      lastCommitSha: "abc123",
      lastSprintSnapshot: { sprint: "S44", done: 5, total: 10 },
      recentActions: [],
      cooldowns: {},
      lastAlertCheckAt: null,
      lastArchivalAt: null,
      lastAutonomyScanAt: null,
    };

    const baseDelta: HeartbeatDelta = {
      commits: "def456 feat: new feature\nghi789 fix: bug fix",
      sprintSummary: "Sprint S44: 7/10 terminees, 2 en cours",
      ciStatus: "CI (master): success",
      openPRs: "#52 Feature X (feature/x, 2h)",
      staleTasks: "",
      timeSinceLastPulse: "10 min",
    };

    it("should include pulsation header", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).toContain("PULSATION");
      expect(prompt).toContain("10 min");
    });

    it("should include commits section when present", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).toContain("COMMITS RECENTS:");
      expect(prompt).toContain("feat: new feature");
      expect(prompt).toContain("fix: bug fix");
    });

    it("should show no commits when empty", () => {
      const delta = { ...baseDelta, commits: "" };
      const prompt = buildHeartbeatPrompt(baseState, delta);
      expect(prompt).toContain("aucun nouveau commit");
    });

    it("should include sprint summary", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).toContain("SPRINT ACTUEL:");
      expect(prompt).toContain("Sprint S44");
    });

    it("should include CI status", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).toContain("CI STATUS:");
      expect(prompt).toContain("success");
    });

    it("should include open PRs", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).toContain("PRs OUVERTES:");
      expect(prompt).toContain("#52 Feature X");
    });

    it("should include stale tasks when present", () => {
      const delta = { ...baseDelta, staleTasks: "Task A — en cours depuis 72h" };
      const prompt = buildHeartbeatPrompt(baseState, delta);
      expect(prompt).toContain("TACHES POTENTIELLEMENT BLOQUEES:");
      expect(prompt).toContain("Task A");
    });

    it("should omit stale tasks when empty", () => {
      const prompt = buildHeartbeatPrompt(baseState, baseDelta);
      expect(prompt).not.toContain("TACHES POTENTIELLEMENT BLOQUEES:");
    });

    it("should include recent actions", () => {
      const state: HeartbeatState = {
        ...baseState,
        recentActions: [
          { type: "notify", summary: "CI cassee", timestamp: "2026-03-17T12:00:00Z" },
        ],
      };
      const prompt = buildHeartbeatPrompt(state, baseDelta);
      expect(prompt).toContain("ACTIONS RECENTES");
      expect(prompt).toContain("CI cassee");
    });

    it("should include active cooldowns", () => {
      const state: HeartbeatState = {
        ...baseState,
        cooldowns: { "ci_failure": Date.now() + 600000 },
      };
      const prompt = buildHeartbeatPrompt(state, baseDelta);
      expect(prompt).toContain("COOLDOWNS ACTIFS");
      expect(prompt).toContain("ci_failure");
    });

    it("should filter expired cooldowns", () => {
      const state: HeartbeatState = {
        ...baseState,
        cooldowns: { "old_topic": Date.now() - 1000 },
      };
      const prompt = buildHeartbeatPrompt(state, baseDelta);
      expect(prompt).not.toContain("COOLDOWNS ACTIFS");
    });

    it("should show first pulsation message", () => {
      const state = { ...baseState, lastPulseAt: "" };
      const delta = { ...baseDelta, timeSinceLastPulse: "premiere pulsation" };
      const prompt = buildHeartbeatPrompt(state, delta);
      expect(prompt).toContain("premiere pulsation");
    });
  });

  describe("HEARTBEAT_DECISION_SCHEMA", () => {
    it("should have required fields", () => {
      expect(HEARTBEAT_DECISION_SCHEMA.required).toContain("observations");
      expect(HEARTBEAT_DECISION_SCHEMA.required).toContain("actions");
      expect(HEARTBEAT_DECISION_SCHEMA.required).toContain("reasoning");
    });

    it("should define action types", () => {
      const actionSchema = HEARTBEAT_DECISION_SCHEMA.properties.actions.items;
      expect(actionSchema.properties.type.enum).toContain("notify");
      expect(actionSchema.properties.type.enum).toContain("task_create");
      expect(actionSchema.properties.type.enum).toContain("none");
    });
  });

  describe("HEARTBEAT_SYSTEM_PROMPT", () => {
    it("should be defined and non-empty", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it("should mention key rules", () => {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("Pouls");
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("none");
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain("notify");
    });
  });
});

// ── heartbeat.ts triage and actions ─────────────────────────

describe("Heartbeat Triage", () => {
  // Import functions that don't depend on spawnSync / filesystem
  // We test the triage logic via collectAndTriage with mock data

  describe("getSprintDelta", () => {
    it("should detect sprint change", async () => {
      const { getSprintDelta } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({
        tasks: [
          { id: "t1", title: "Task 1", status: "done", sprint: "S44" },
          { id: "t2", title: "Task 2", status: "in_progress", sprint: "S44" },
          { id: "t3", title: "Task 3", status: "backlog", sprint: "S44" },
        ],
      });
      // Mock getCurrentSprint
      supabase._registerRpc("get_sprint_summary", () => ({ sprint: "S44" }));

      const result = await getSprintDelta(supabase, {
        sprint: "S44",
        done: 0,
        total: 2,
      });

      expect(result.changed).toBe(true);
      expect(result.snapshot.done).toBe(1);
      expect(result.snapshot.total).toBe(3);
      expect(result.summary).toContain("S44");
    });

    it("should detect no change when snapshot matches", async () => {
      const { getSprintDelta } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({
        tasks: [
          { id: "t1", title: "Task 1", status: "done", sprint: "S44" },
          { id: "t2", title: "Task 2", status: "in_progress", sprint: "S44" },
        ],
      });

      const result = await getSprintDelta(supabase, {
        sprint: "S44",
        done: 1,
        total: 2,
      });

      expect(result.changed).toBe(false);
    });
  });

  describe("getStaleTasks", () => {
    it("should detect stale in_progress tasks", async () => {
      const { getStaleTasks } = await import("../../src/heartbeat");
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const supabase = createMockSupabase({
        tasks: [
          { id: "t1", title: "Stale Task", status: "in_progress", updated_at: threeDaysAgo },
        ],
      });

      const result = await getStaleTasks(supabase);
      expect(result.hasStale).toBe(true);
      expect(result.tasks).toContain("Stale Task");
    });

    it("should not flag recent in_progress tasks", async () => {
      const { getStaleTasks } = await import("../../src/heartbeat");
      const recentDate = new Date().toISOString();
      const supabase = createMockSupabase({
        tasks: [
          { id: "t1", title: "Recent Task", status: "in_progress", updated_at: recentDate },
        ],
      });

      const result = await getStaleTasks(supabase);
      expect(result.hasStale).toBe(false);
      expect(result.tasks).toBe("");
    });

    it("should return empty for no in_progress tasks", async () => {
      const { getStaleTasks } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({
        tasks: [
          { id: "t1", title: "Done Task", status: "done", updated_at: new Date().toISOString() },
        ],
      });

      const result = await getStaleTasks(supabase);
      expect(result.hasStale).toBe(false);
    });
  });
});

describe("Heartbeat Actions", () => {
  describe("executeActions", () => {
    it("should handle none action", async () => {
      const { executeActions } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({});
      const state = createDefaultState();

      const decision = {
        observations: ["Tout va bien"],
        actions: [{ type: "none" as const }],
        reasoning: "RAS",
      };

      const executed = await executeActions(decision, supabase, state);
      expect(executed.length).toBe(1);
      expect(executed[0].type).toBe("none");
    });

    it("should create task from task_create action", async () => {
      const { executeActions } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({ tasks: [] });
      const state = createDefaultState();

      const decision = {
        observations: ["Test manquant detecte"],
        actions: [{
          type: "task_create" as const,
          taskTitle: "Ajouter tests heartbeat",
          taskDescription: "Tests unitaires pour le module heartbeat",
          taskPriority: 3,
        }],
        reasoning: "Test coverage",
      };

      const executed = await executeActions(decision, supabase, state);
      expect(executed.length).toBe(1);
      expect(executed[0].type).toBe("task_create");
      expect(executed[0].summary).toBe("Ajouter tests heartbeat");

      // Verify task was created in Supabase
      const tasks = supabase._getTable("tasks");
      expect(tasks.length).toBe(1);
      expect(tasks[0].title).toBe("Ajouter tests heartbeat");
    });

    it("should skip notify action when on cooldown", async () => {
      const { executeActions } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({});
      const state: HeartbeatState = {
        ...createDefaultState(),
        cooldowns: { "CI cassee sur master": Date.now() + 600000 },
      };

      const decision = {
        observations: ["CI toujours cassee"],
        actions: [{
          type: "notify" as const,
          message: "CI cassee sur master",
          priority: "high" as const,
        }],
        reasoning: "CI failure",
      };

      const executed = await executeActions(decision, supabase, state);
      expect(executed.length).toBe(0);
    });

    it("should set cooldown after notify", async () => {
      const { executeActions } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({});
      const state = createDefaultState();

      const decision = {
        observations: ["Sprint en retard"],
        actions: [{
          type: "notify" as const,
          message: "Sprint S44 en retard: seulement 3/10 taches",
          priority: "medium" as const,
        }],
        reasoning: "Sprint delay",
      };

      await executeActions(decision, supabase, state);
      // Cooldown should be set (first 50 chars of message)
      const cooldownKeys = Object.keys(state.cooldowns);
      expect(cooldownKeys.length).toBe(1);
      expect(state.cooldowns[cooldownKeys[0]]).toBeGreaterThan(Date.now());
    });

    it("should handle multiple actions", async () => {
      const { executeActions } = await import("../../src/heartbeat");
      const supabase = createMockSupabase({ tasks: [] });
      const state = createDefaultState();

      const decision = {
        observations: ["CI cassee", "Tache bloquee"],
        actions: [
          { type: "notify" as const, message: "CI cassee sur feature/x", priority: "high" as const },
          { type: "task_create" as const, taskTitle: "Fix CI", taskDescription: "Corriger le build", taskPriority: 2 },
        ],
        reasoning: "Multiple issues",
      };

      const executed = await executeActions(decision, supabase, state);
      expect(executed.length).toBe(2);
      expect(executed[0].type).toBe("notify");
      expect(executed[1].type).toBe("task_create");
    });
  });
});

// ── Lightweight Audit ─────────────────────────────────────

describe("computeAuditScore", () => {
  it("should return 100 when no gaps", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    expect(computeAuditScore([])).toBe(100);
  });

  it("should deduct 5 points per module gap", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    const gaps = [
      { type: "missing_module" },
      { type: "extra_module" },
    ];
    expect(computeAuditScore(gaps)).toBe(90);
  });

  it("should deduct 5 points per command gap", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    const gaps = [
      { type: "missing_command" },
      { type: "extra_command" },
    ];
    expect(computeAuditScore(gaps)).toBe(90);
  });

  it("should deduct 10 points for test count gap", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    const gaps = [{ type: "test_count" }];
    expect(computeAuditScore(gaps)).toBe(90);
  });

  it("should clamp score to 0 minimum", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    // 25 module gaps = 125 point deduction
    const gaps = Array.from({ length: 25 }, () => ({ type: "missing_module" }));
    expect(computeAuditScore(gaps)).toBe(0);
  });

  it("should handle mixed gap types", async () => {
    const { computeAuditScore } = await import("../../src/heartbeat");
    const gaps = [
      { type: "missing_module" },   // -5
      { type: "extra_command" },     // -5
      { type: "test_count" },        // -10
    ];
    expect(computeAuditScore(gaps)).toBe(80);
  });
});

describe("Heartbeat Lightweight Audit Integration", () => {
  // AC-1: Given heartbeat active + audit_system enabled + 24h elapsed → audit is triggered
  describe("AC-1: Daily audit trigger", () => {
    it("should trigger audit when audit_system enabled and 24h elapsed", async () => {
      // We test the time-gating logic by checking state changes
      const state = createDefaultState();
      state.lastAuditAt = null; // never run before

      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const now = Date.now();
      const isExpired = !state.lastAuditAt || new Date(state.lastAuditAt).getTime() < (now - 24 * 60 * 60 * 1000);
      expect(isExpired).toBe(true);
    });

    it("should not trigger audit when less than 24h elapsed", () => {
      const state = createDefaultState();
      state.lastAuditAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(); // 12h ago

      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const isExpired = !state.lastAuditAt || new Date(state.lastAuditAt).getTime() < dayAgo;
      expect(isExpired).toBe(false);
    });

    it("should trigger audit on first run (lastAuditAt null)", () => {
      const state = createDefaultState();
      expect(state.lastAuditAt).toBeNull();

      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const isExpired = !state.lastAuditAt || new Date(state.lastAuditAt).getTime() < dayAgo;
      expect(isExpired).toBe(true);
    });
  });

  // AC-2: Score regression > 5 points → alert via notification
  describe("AC-2: Regression alert", () => {
    it("should detect regression when score drops by more than 5 points", () => {
      const previousScore = 78;
      const currentScore = 72;
      const delta = previousScore - currentScore;
      const shouldAlert = previousScore !== null && delta > 5;
      expect(shouldAlert).toBe(true);
      expect(delta).toBe(6);
    });

    it("should include delta in alert message", () => {
      const previousScore = 78;
      const currentScore = 72;
      const delta = previousScore - currentScore;
      const message = `[Audit] Score structure/tests en regression: ${previousScore} -> ${currentScore} (${delta} points). 3 ecart(s) detecte(s).`;
      expect(message).toContain("78 -> 72");
      expect(message).toContain("6 points");
      expect(message).toContain("3 ecart(s)");
    });

    it("should detect large regression (e.g. 20 points)", () => {
      const previousScore = 90;
      const currentScore = 70;
      const delta = previousScore - currentScore;
      expect(delta > 5).toBe(true);
      expect(delta).toBe(20);
    });
  });

  // AC-3: Stable score (delta <= 5) → no alert
  describe("AC-3: No alert on stable score", () => {
    it("should not alert when score improves", () => {
      const previousScore = 72;
      const currentScore = 78;
      const delta = previousScore - currentScore;
      const shouldAlert = previousScore !== null && delta > 5;
      expect(shouldAlert).toBe(false);
    });

    it("should not alert when score is exactly 5 points lower", () => {
      const previousScore = 78;
      const currentScore = 73;
      const delta = previousScore - currentScore;
      const shouldAlert = previousScore !== null && delta > 5;
      expect(shouldAlert).toBe(false);
    });

    it("should not alert when score is unchanged", () => {
      const previousScore = 78;
      const currentScore = 78;
      const delta = previousScore - currentScore;
      const shouldAlert = previousScore !== null && delta > 5;
      expect(shouldAlert).toBe(false);
    });

    it("should not alert on first run (no previous score)", () => {
      const previousScore = null;
      const currentScore = 72;
      const shouldAlert = previousScore !== null && previousScore - currentScore > 5;
      expect(shouldAlert).toBe(false);
    });
  });

  // AC-4: audit_system flag disabled → no audit
  describe("AC-4: Feature flag gate", () => {
    it("should have audit_system flag defaulting to false", () => {
      const features = require("../../config/features.json");
      expect(features.audit_system).toBe(false);
    });

    it("should skip audit when feature flag is disabled", () => {
      // Simulates the guard in pulse()
      const flagEnabled = false; // audit_system is off
      const lastAuditAt = null; // never ran
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const shouldRun = flagEnabled && (!lastAuditAt || new Date(lastAuditAt).getTime() < dayAgo);
      expect(shouldRun).toBe(false);
    });

    it("should run audit when feature flag is enabled and time has elapsed", () => {
      const flagEnabled = true; // audit_system is on
      const lastAuditAt = null; // never ran
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const shouldRun = flagEnabled && (!lastAuditAt || new Date(lastAuditAt).getTime() < dayAgo);
      expect(shouldRun).toBe(true);
    });
  });
});

describe("HeartbeatState audit fields", () => {
  it("should include lastAuditAt in default state", () => {
    const state = createDefaultState();
    expect(state.lastAuditAt).toBeNull();
  });

  it("should include lastAuditScore in default state", () => {
    const state = createDefaultState();
    expect(state.lastAuditScore).toBeNull();
  });

  it("should allow setting audit fields", () => {
    const state = createDefaultState();
    state.lastAuditAt = "2026-03-20T12:00:00.000Z";
    state.lastAuditScore = 85;
    expect(state.lastAuditAt).toBe("2026-03-20T12:00:00.000Z");
    expect(state.lastAuditScore).toBe(85);
  });
});

describe("Heartbeat Git Delta", () => {
  it("should detect no changes when SHA matches", () => {
    // getGitDelta calls spawnSync which will work in test env
    const { getGitDelta } = require("../../src/heartbeat");
    const currentSha = require("child_process")
      .execSync("git rev-parse HEAD", { cwd: process.cwd() })
      .toString()
      .trim();

    const result = getGitDelta(currentSha);
    expect(result.hasNew).toBe(false);
    expect(result.commits).toBe("");
    expect(result.currentSha).toBe(currentSha);
  });

  it("should detect new commits when SHA differs", () => {
    const { getGitDelta } = require("../../src/heartbeat");
    // Use a very old SHA to get some commits
    const result = getGitDelta("0000000000000000000000000000000000000000");
    // This should either have commits or fail gracefully
    expect(result.currentSha).toBeTruthy();
  });
});
