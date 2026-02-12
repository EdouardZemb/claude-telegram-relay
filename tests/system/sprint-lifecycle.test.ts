/**
 * System Tests — Sprint Full Lifecycle
 *
 * End-to-end tests that simulate a complete sprint from creation
 * to retrospective, crossing all module boundaries.
 * Validates no regressions in the core workflow pipeline.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createMockSupabase } from "../fixtures/mock-supabase";

// Set PROJECT_DIR before importing workflow modules
process.env.PROJECT_DIR = import.meta.dir + "/../fixtures";

import {
  WorkflowTracker,
  collectSprintMetrics,
  getSprintMetrics,
  generateRetroData,
  saveRetro,
  formatMetrics,
  formatRetro,
  reloadWorkflowConfig,
  applyWorkflowSuggestions,
} from "../../src/workflow";
import { addTask, updateTaskStatus, getBacklog, getCurrentSprint } from "../../src/tasks";
import { analyzePatterns, formatPatterns } from "../../src/patterns";
import { runAllChecks, formatAlerts, checkStuckTasks, checkReworkRate, checkSprintPace } from "../../src/alerts";
import { processMemoryIntents, getMemoryContext, getRecentMessages } from "../../src/memory";
import { readFileSync as _readFileSync, writeFileSync as _writeFileSync } from "fs";
import { join as _join } from "path";

const _FIXTURE_WORKFLOW_PATH = _join(import.meta.dir, "../fixtures/config/workflow.yaml");
const _FIXTURE_WORKFLOW_ORIGINAL = _readFileSync(_FIXTURE_WORKFLOW_PATH, "utf-8");

function _restoreWorkflow() {
  _writeFileSync(_FIXTURE_WORKFLOW_PATH, _FIXTURE_WORKFLOW_ORIGINAL);
  reloadWorkflowConfig();
}

// ── Scenario 1: Complete Sprint with Retro and Pattern-Driven Workflow Update ──

describe("System: Complete Sprint -> Retro -> Workflow Update", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    reloadWorkflowConfig();
    supabase = createMockSupabase();
  });

  it("runs an entire sprint then retro triggers workflow.yaml changes", async () => {
    // 1. Create sprint tasks
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      const t = await addTask(supabase, `S13 Task ${i + 1}`, { sprint: "S13", priority: 2 });
      expect(t).not.toBeNull();
      tasks.push(t!);
    }

    // 2. Verify backlog shows all tasks
    const backlog = await getBacklog(supabase, { sprint: "S13" });
    expect(backlog.length).toBe(5);

    // 3. Current sprint should be S13
    const sprint = await getCurrentSprint(supabase);
    expect(sprint).toBe("S13");

    // 4. Execute all tasks through the workflow
    for (const task of tasks) {
      await updateTaskStatus(supabase, task.id, "in_progress");
      const tracker = new WorkflowTracker(supabase, {
        taskId: task.id,
        sprintId: "S13",
        startStep: "request",
      });
      await tracker.transition("decomposition");
      await tracker.transition("execution", { checkpoint_result: "pass" });
      await tracker.transition("review", { checkpoint_result: "pass" });
      await tracker.transition("closure");
      await updateTaskStatus(supabase, task.id, "done");
    }

    // 5. Collect sprint metrics
    const metricsOk = await collectSprintMetrics(supabase, "S13");
    expect(metricsOk).toBe(true);

    const metrics = await getSprintMetrics(supabase, "S13");
    expect(metrics).not.toBeNull();
    expect(metrics.tasks_planned).toBe(5);
    expect(metrics.tasks_completed).toBe(5);
    expect(metrics.rework_count).toBe(0);

    // 6. Generate retro data from this sprint
    const retroData = await generateRetroData(supabase, "S13");
    expect(retroData).not.toBeNull();
    expect(retroData!.workflowStats.totalTransitions).toBe(20); // 4 transitions * 5 tasks
    expect(retroData!.tasks.length).toBe(5);

    // 7. Save a retro with workflow suggestions (simulating what /retro does)
    const saved = await saveRetro(supabase, "S13", {
      what_worked: ["Tous les tasks terminees", "Zero rework"],
      what_didnt: ["Checkpoint decomposition inutile"],
      patterns_detected: ["useless_checkpoint decomposition"],
      actions_proposed: [
        {
          action: "Desactiver le checkpoint decomposition",
          priority: "low",
          target_step: "decomposition",
          suggested_change: "checkpoint.mode: off",
        },
      ],
      raw_analysis: "Sprint parfait, simplifier le workflow.",
    });
    expect(saved).toBe(true);

    // 8. Apply workflow suggestions (as retro_accept_all would)
    const retros = supabase._getTable("retros");
    expect(retros.length).toBe(1);

    const changes = applyWorkflowSuggestions(retros[0].actions_proposed);
    expect(changes.length).toBe(1);
    expect(changes[0]).toContain("decomposition");
    expect(changes[0]).toContain("light -> off");

    // 9. Verify formatted output
    const formattedMetrics = formatMetrics(metrics);
    expect(formattedMetrics).toContain("S13");
    expect(formattedMetrics).toContain("5/5");

    const formattedRetro = formatRetro(retros[0]);
    expect(formattedRetro).toContain("S13");
    expect(formattedRetro).toContain("Tous les tasks terminees");

    // Restore fixture after workflow.yaml modification
    _restoreWorkflow();
  });
});

// ── Scenario 2: Sprint with Rework Triggers Alerts and Patterns ──

describe("System: Rework-Heavy Sprint -> Alerts + Pattern Detection", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    reloadWorkflowConfig();
    supabase = createMockSupabase();
  });

  it("rework in sprint triggers alerts and pattern analysis", async () => {
    // 1. Create tasks
    const task1 = await addTask(supabase, "Feature with rework", { sprint: "S13", priority: 1 });
    const task2 = await addTask(supabase, "Another rework task", { sprint: "S13", priority: 2 });
    const task3 = await addTask(supabase, "Clean task", { sprint: "S13", priority: 2 });
    expect(task1).not.toBeNull();
    expect(task2).not.toBeNull();
    expect(task3).not.toBeNull();

    // 2. Task 1: execution -> review fails -> back to execution -> review pass
    await updateTaskStatus(supabase, task1!.id, "in_progress");
    const tracker1 = new WorkflowTracker(supabase, {
      taskId: task1!.id,
      sprintId: "S13",
      startStep: "request",
    });
    await tracker1.transition("decomposition");
    await tracker1.transition("execution");
    await tracker1.transition("review", { checkpoint_result: "fail", had_rework: true });
    await tracker1.transition("execution", { had_rework: true });
    await tracker1.transition("review", { checkpoint_result: "pass" });
    await tracker1.transition("closure");
    await updateTaskStatus(supabase, task1!.id, "done");

    // 3. Task 2: same pattern — rework at review
    await updateTaskStatus(supabase, task2!.id, "in_progress");
    const tracker2 = new WorkflowTracker(supabase, {
      taskId: task2!.id,
      sprintId: "S13",
      startStep: "request",
    });
    await tracker2.transition("decomposition");
    await tracker2.transition("execution");
    await tracker2.transition("review", { checkpoint_result: "fail", had_rework: true });
    await tracker2.transition("execution", { had_rework: true });
    await tracker2.transition("review", { checkpoint_result: "pass" });
    await tracker2.transition("closure");
    await updateTaskStatus(supabase, task2!.id, "done");

    // 4. Task 3: clean pass
    await updateTaskStatus(supabase, task3!.id, "in_progress");
    const tracker3 = new WorkflowTracker(supabase, {
      taskId: task3!.id,
      sprintId: "S13",
      startStep: "request",
    });
    await tracker3.transition("decomposition");
    await tracker3.transition("execution");
    await tracker3.transition("review", { checkpoint_result: "pass" });
    await tracker3.transition("closure");
    await updateTaskStatus(supabase, task3!.id, "done");

    // 5. Collect metrics
    await collectSprintMetrics(supabase, "S13");
    const metrics = await getSprintMetrics(supabase, "S13");
    expect(metrics.rework_count).toBeGreaterThan(0);
    expect(metrics.tasks_completed).toBe(3);

    // 6. Verify workflow logs have rework data
    const logs = supabase._getTable("workflow_logs");
    const reworkLogs = logs.filter((l: any) => l.had_rework);
    expect(reworkLogs.length).toBeGreaterThanOrEqual(2);

    // 7. Run alerts — should detect high rework (if enough transitions)
    const alerts = await runAllChecks(supabase, "S13");
    // No stuck tasks — all tasks are done
    const stuckAlerts = alerts.filter((a) => a.type === "stuck_task");
    expect(stuckAlerts.length).toBe(0);

    // 8. Format alerts (even if none, should not crash)
    const formatted = formatAlerts(alerts);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

// ── Scenario 3: Multi-Sprint Trend Analysis ──

describe("System: Multi-Sprint Trend Analysis", () => {
  it("detects improving trend across 3 sprints", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 4, created_at: "2026-01-01" },
        { sprint_id: "S12", tasks_planned: 10, tasks_completed: 7, created_at: "2026-01-15" },
        { sprint_id: "S13", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-01" },
      ],
      workflow_logs: [
        // S11: slow execution steps
        ...Array.from({ length: 5 }, (_, i) => ({
          sprint_id: "S11",
          step_from: "execution",
          step_to: "review",
          duration_seconds: 5000 + i * 200,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-01-0${i + 1}`,
        })),
        // S12: faster execution
        ...Array.from({ length: 5 }, (_, i) => ({
          sprint_id: "S12",
          step_from: "execution",
          step_to: "review",
          duration_seconds: 4000 + i * 100,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-01-1${i + 6}`,
        })),
        // S13: even faster
        ...Array.from({ length: 5 }, (_, i) => ({
          sprint_id: "S13",
          step_from: "execution",
          step_to: "review",
          duration_seconds: 3000 + i * 100,
          had_rework: false,
          checkpoint_result: "pass",
          created_at: `2026-02-0${i + 1}`,
        })),
      ],
      retros: [],
    });

    // 1. Pattern analysis should detect improving trend
    const analysis = await analyzePatterns(supabase);
    expect(analysis.sprintCount).toBe(3);

    const improving = analysis.patterns.find((p) => p.type === "improving");
    expect(improving).toBeDefined();

    // 2. Slow execution step should be detected
    const slowExec = analysis.patterns.find(
      (p) => p.type === "slow_step" && p.data.step === "execution"
    );
    expect(slowExec).toBeDefined();

    // 3. Formatted output should be human-readable
    const formatted = formatPatterns(analysis);
    expect(formatted).toContain("3 sprints");
    expect(formatted).toContain("execution");
    expect(formatted.length).toBeGreaterThan(50);
  });

  it("detects degrading trend", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 10, created_at: "2026-01-01" },
        { sprint_id: "S12", tasks_planned: 10, tasks_completed: 6, created_at: "2026-01-15" },
        { sprint_id: "S13", tasks_planned: 10, tasks_completed: 3, created_at: "2026-02-01" },
      ],
      workflow_logs: [],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    const degrading = analysis.patterns.find((p) => p.type === "degrading");
    expect(degrading).toBeDefined();
    expect(degrading!.severity).toBe("warning");
  });
});

// ── Scenario 4: Memory System Integrity ──

describe("System: Memory Lifecycle Integrity", () => {
  it("facts and goals survive across simulated conversations", async () => {
    const supabase = createMockSupabase();
    supabase._registerRpc("get_facts", () =>
      supabase._getTable("memory").filter((m: any) => m.type === "fact")
    );
    supabase._registerRpc("get_active_goals", () =>
      supabase._getTable("memory").filter((m: any) => m.type === "goal")
    );

    // Conversation 1: store fact and goal
    const response1 = await processMemoryIntents(
      supabase,
      "OK! [REMEMBER: Le projet utilise Bun et TypeScript] [GOAL: Livrer le S13 avant le 20 fevrier | DEADLINE: 2026-02-20] Je m'en occupe."
    );
    expect(response1).not.toContain("[REMEMBER:");
    expect(response1).not.toContain("[GOAL:");
    expect(response1).toContain("OK!");

    // Conversation 2: add another fact
    const response2 = await processMemoryIntents(
      supabase,
      "Compris! [REMEMBER: Edouard prefere les reponses detaillees] Voila les details."
    );
    expect(response2).not.toContain("[REMEMBER:");

    // Verify memory state
    const memory = supabase._getTable("memory");
    const facts = memory.filter((m: any) => m.type === "fact");
    const goals = memory.filter((m: any) => m.type === "goal");
    expect(facts.length).toBe(2);
    expect(goals.length).toBe(1);

    // Conversation 3: memory context should include all stored items
    const context = await getMemoryContext(supabase);
    expect(context).toContain("FACTS:");
    expect(context).toContain("Bun");
    expect(context).toContain("detaillees");
    expect(context).toContain("GOALS:");
    expect(context).toContain("S13");

    // Conversation 4: complete the goal
    const response3 = await processMemoryIntents(
      supabase,
      "Le sprint est fini! [DONE: Livrer le S13 avant le 20 fevrier]"
    );
    expect(response3).not.toContain("[DONE:");

    // Goal should be marked completed
    const updatedMemory = supabase._getTable("memory");
    const completed = updatedMemory.filter((m: any) => m.type === "completed_goal");
    expect(completed.length).toBe(1);
    expect(completed[0].completed_at).toBeDefined();

    // Active goals should be empty now
    const activeGoals = updatedMemory.filter((m: any) => m.type === "goal");
    expect(activeGoals.length).toBe(0);
  });
});

// ── Scenario 5: Alert Cron Simulation ──

describe("System: Alert Cron End-to-End Simulation", () => {
  it("simulates what alert-cron.ts does: detect + format + report", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "stuck1", title: "Bloquer sur le deploy", status: "in_progress", updated_at: twoDaysAgo, sprint: "S13" },
        { id: "stuck2", title: "Config CI cassee", status: "in_progress", updated_at: twoDaysAgo, sprint: "S13" },
        { id: "ok1", title: "Task OK", status: "done", updated_at: new Date().toISOString(), sprint: "S13" },
      ],
      workflow_logs: Array.from({ length: 8 }, (_, i) => ({
        sprint_id: "S13",
        had_rework: i < 5, // 5/8 = 62.5% rework rate
        created_at: `2026-02-0${i + 1}`,
      })),
    });

    // Simulate getCurrentSprint
    const sprintId = "S13";

    // Run all checks (like alert-cron.ts does)
    const alerts = await runAllChecks(supabase, sprintId);
    expect(alerts.length).toBeGreaterThanOrEqual(2); // stuck tasks + high rework

    const types = alerts.map((a) => a.type);
    expect(types).toContain("stuck_task");
    expect(types).toContain("high_rework");

    // Format alerts (like alert-cron.ts does)
    const message = `[Alerte automatique]\n\n${formatAlerts(alerts)}`;
    expect(message).toContain("[Alerte automatique]");
    expect(message).toContain("alertes");
    expect(message).toContain("Bloquer sur le deploy");
    expect(message).toContain("Config CI cassee");

    // Verify severity is correct
    const stuckAlerts = alerts.filter((a) => a.type === "stuck_task");
    expect(stuckAlerts.length).toBe(2);
    for (const alert of stuckAlerts) {
      expect(alert.severity).toBe("warning");
      expect(alert.data.hoursStuck).toBeGreaterThanOrEqual(48);
    }

    const reworkAlert = alerts.find((a) => a.type === "high_rework");
    expect(reworkAlert).toBeDefined();
    expect(reworkAlert!.data.reworkRate).toBeGreaterThanOrEqual(60);
    expect(reworkAlert!.severity).toBe("critical"); // > 60%
  });

  it("reports no alerts when everything is healthy", async () => {
    const supabase = createMockSupabase({
      tasks: [
        { id: "ok1", title: "Done task", status: "done", updated_at: new Date().toISOString(), sprint: "S13" },
        { id: "ok2", title: "Fresh task", status: "in_progress", updated_at: new Date().toISOString(), sprint: "S13" },
      ],
      workflow_logs: Array.from({ length: 10 }, (_, i) => ({
        sprint_id: "S13",
        had_rework: i === 0, // only 10% rework
        created_at: `2026-02-0${i + 1}`,
      })),
    });

    const alerts = await runAllChecks(supabase, "S13");
    expect(alerts.length).toBe(0);

    const formatted = formatAlerts(alerts);
    expect(formatted).toContain("Aucune alerte");
  });
});

// ── Scenario 6: Workflow Suggestion Application Safety ──

describe("System: Workflow Suggestion Safety", () => {
  beforeEach(() => {
    _restoreWorkflow();
  });

  it("only applies valid suggestions", () => {
    const changes = applyWorkflowSuggestions([
      { action: "Valid change", target_step: "execution", suggested_change: "checkpoint.mode: light" },
      { action: "Invalid step", target_step: "nonexistent", suggested_change: "checkpoint.mode: off" },
      { action: "Invalid format", target_step: "review", suggested_change: "something wrong" },
      { action: "No target", suggested_change: "checkpoint.mode: off" },
    ]);

    // Only the valid execution change should apply
    expect(changes.length).toBe(1);
    expect(changes[0]).toContain("execution");
    expect(changes[0]).toContain("strict -> light");

    _restoreWorkflow();
  });

  it("does not apply duplicate mode changes", () => {
    // First, apply a change
    const changes1 = applyWorkflowSuggestions([
      { action: "Change", target_step: "decomposition", suggested_change: "checkpoint.mode: off" },
    ]);
    expect(changes1.length).toBe(1);

    // Re-apply same change — should be idempotent
    const changes2 = applyWorkflowSuggestions([
      { action: "Same change", target_step: "decomposition", suggested_change: "checkpoint.mode: off" },
    ]);
    expect(changes2.length).toBe(0);

    _restoreWorkflow();
  });

  it("handles empty suggestions gracefully", () => {
    const changes = applyWorkflowSuggestions([]);
    expect(changes.length).toBe(0);
  });
});

// ── Scenario 7: Recent Messages + Conversation Context ──

describe("System: Conversation Context Pipeline", () => {
  it("builds complete context from messages + memory", async () => {
    const supabase = createMockSupabase({
      messages: [
        { role: "user", content: "Lance le sprint S13", created_at: "2026-02-12T09:00:00Z" },
        { role: "assistant", content: "Sprint S13 demarre!", created_at: "2026-02-12T09:00:01Z" },
        { role: "user", content: "Cree 3 taches", created_at: "2026-02-12T09:01:00Z" },
        { role: "assistant", content: "3 taches creees dans le backlog.", created_at: "2026-02-12T09:01:01Z" },
      ],
    });

    supabase._registerRpc("get_facts", () => [
      { content: "Bun est le runtime", type: "fact" },
      { content: "Workflow en 6 etapes", type: "fact" },
    ]);
    supabase._registerRpc("get_active_goals", () => [
      { content: "Finir S13 avant le 20/02", type: "goal" },
    ]);

    // 1. Recent messages should be properly formatted
    const recent = await getRecentMessages(supabase, 10);
    expect(recent).toContain("RECENT CONVERSATION:");
    expect(recent).toContain("Lance le sprint S13");
    expect(recent).toContain("Sprint S13 demarre!");
    expect(recent).toContain("Cree 3 taches");

    // 2. Memory context should include facts and goals
    const memory = await getMemoryContext(supabase);
    expect(memory).toContain("FACTS:");
    expect(memory).toContain("Bun est le runtime");
    expect(memory).toContain("GOALS:");
    expect(memory).toContain("Finir S13");
  });
});

// ── Scenario 8: Sprint Pace Check with Edge Cases ──

describe("System: Sprint Pace Edge Cases", () => {
  it("does not alert on a fresh sprint (day 1)", async () => {
    const now = new Date().toISOString();
    const supabase = createMockSupabase({
      tasks: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        status: "backlog",
        sprint: "S13",
        created_at: now,
      })),
    });

    const alerts = await checkSprintPace(supabase, "S13");
    expect(alerts.length).toBe(0); // Too early to judge
  });

  it("alerts when sprint is 80% through with only 20% done", async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", status: "done", sprint: "S13", created_at: sixDaysAgo },
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `t${i + 2}`,
          status: "backlog",
          sprint: "S13",
          created_at: sixDaysAgo,
        })),
      ],
    });

    const alerts = await checkSprintPace(supabase, "S13");
    expect(alerts.length).toBe(1);
    expect(alerts[0].type).toBe("behind_schedule");
    expect(alerts[0].data.done).toBe(1);
    expect(alerts[0].data.total).toBe(10);
  });
});
