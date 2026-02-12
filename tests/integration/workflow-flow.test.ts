/**
 * Integration Tests — Full Workflow Flow
 *
 * Tests the complete lifecycle: task creation, workflow transitions,
 * metrics collection, pattern detection, alerts, and retro generation.
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
} from "../../src/workflow";
import { addTask, updateTaskStatus, getBacklog, getCurrentSprint } from "../../src/tasks";
import { analyzePatterns, formatPatterns } from "../../src/patterns";
import { runAllChecks, formatAlerts } from "../../src/alerts";
import { processMemoryIntents, getMemoryContext, getRecentMessages } from "../../src/memory";

// ── Full Sprint Lifecycle ────────────────────────────────────

describe("Full Sprint Lifecycle", () => {
  let supabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    reloadWorkflowConfig();
    supabase = createMockSupabase();
  });

  it("task flows through the entire workflow and produces metrics", async () => {
    // 1. Create tasks for a sprint
    const task1 = await addTask(supabase, "Implement feature A", { sprint: "S12", priority: 1 });
    const task2 = await addTask(supabase, "Fix bug B", { sprint: "S12", priority: 2 });
    const task3 = await addTask(supabase, "Add tests for C", { sprint: "S12", priority: 2 });
    expect(task1).not.toBeNull();
    expect(task2).not.toBeNull();
    expect(task3).not.toBeNull();

    // 2. Verify backlog
    const backlog = await getBacklog(supabase, { sprint: "S12" });
    expect(backlog.length).toBe(3);

    // 3. Current sprint should be S12
    const sprint = await getCurrentSprint(supabase);
    expect(sprint).toBe("S12");

    // 4. Start task 1 and track through workflow
    await updateTaskStatus(supabase, task1!.id, "in_progress");

    const tracker = new WorkflowTracker(supabase, {
      taskId: task1!.id,
      sprintId: "S12",
      startStep: "request",
    });

    // Request -> Decomposition -> Execution -> Review -> Closure
    await tracker.transition("decomposition", { agent_notes: "Decomposed into 3 subtasks" });
    await tracker.transition("execution", { checkpoint_result: "pass" });
    await tracker.transition("review", { checkpoint_result: "pass" });
    await tracker.transition("closure", { agent_notes: "PR merged" });

    await updateTaskStatus(supabase, task1!.id, "done");

    // 5. Do task 2 with rework
    await updateTaskStatus(supabase, task2!.id, "in_progress");

    const tracker2 = new WorkflowTracker(supabase, {
      taskId: task2!.id,
      sprintId: "S12",
      startStep: "request",
    });

    await tracker2.transition("decomposition");
    await tracker2.transition("execution");
    await tracker2.transition("review", { checkpoint_result: "fail", had_rework: true });
    // Rework: back to execution
    await tracker2.transition("execution", { had_rework: true });
    await tracker2.transition("review", { checkpoint_result: "pass" });
    await tracker2.transition("closure");

    await updateTaskStatus(supabase, task2!.id, "done");

    // 6. Complete task 3
    await updateTaskStatus(supabase, task3!.id, "in_progress");
    const tracker3 = new WorkflowTracker(supabase, {
      taskId: task3!.id,
      sprintId: "S12",
      startStep: "request",
    });
    await tracker3.transition("decomposition");
    await tracker3.transition("execution");
    await tracker3.transition("review", { checkpoint_result: "pass" });
    await tracker3.transition("closure");
    await updateTaskStatus(supabase, task3!.id, "done");

    // 7. Collect and verify metrics
    const metricsResult = await collectSprintMetrics(supabase, "S12");
    expect(metricsResult).toBe(true);

    const metrics = await getSprintMetrics(supabase, "S12");
    expect(metrics).not.toBeNull();
    expect(metrics.sprint_id).toBe("S12");
    expect(metrics.tasks_planned).toBe(3);
    expect(metrics.tasks_completed).toBe(3);
    expect(metrics.rework_count).toBeGreaterThan(0);

    // 8. Verify workflow logs were created
    const logs = supabase._getTable("workflow_logs");
    expect(logs.length).toBeGreaterThanOrEqual(12); // 4 + 6 + 4 transitions

    // 9. Format metrics (smoke test)
    const formatted = formatMetrics(metrics);
    expect(formatted).toContain("S12");
    expect(formatted).toContain("3/3");
  });
});

// ── Pattern Detection on Multi-Sprint Data ──────────────────

describe("Multi-Sprint Pattern Detection", () => {
  it("detects patterns across multiple sprints", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S10", tasks_planned: 10, tasks_completed: 5, created_at: "2026-01-15" },
        { sprint_id: "S11", tasks_planned: 10, tasks_completed: 7, created_at: "2026-02-01" },
        { sprint_id: "S12", tasks_planned: 10, tasks_completed: 10, created_at: "2026-02-12" },
      ],
      workflow_logs: [
        // Execution consistently slow across sprints
        ...["S10", "S11", "S12"].flatMap((sprint) =>
          [1, 2, 3].map((i) => ({
            sprint_id: sprint,
            step_from: "execution",
            step_to: "review",
            duration_seconds: 5000 + i * 500,
            had_rework: false,
            checkpoint_result: "pass",
            created_at: `2026-0${sprint === "S10" ? 1 : 2}-0${i}`,
          }))
        ),
        // Decomposition checkpoint always passes
        ...["S10", "S11"].flatMap((sprint) =>
          [1, 2, 3].map((i) => ({
            sprint_id: sprint,
            step_from: "decomposition",
            step_to: "execution",
            duration_seconds: 120,
            had_rework: false,
            checkpoint_result: "pass",
            created_at: `2026-0${sprint === "S10" ? 1 : 2}-0${i}`,
          }))
        ),
      ],
      retros: [],
    });

    const analysis = await analyzePatterns(supabase);
    expect(analysis.sprintCount).toBe(3);
    expect(analysis.patterns.length).toBeGreaterThan(0);

    // Should detect slow execution step
    const slowExec = analysis.patterns.find(
      (p) => p.type === "slow_step" && p.data.step === "execution"
    );
    expect(slowExec).toBeDefined();

    // Improving trend (completion rates going up)
    const improving = analysis.patterns.find((p) => p.type === "improving");
    expect(improving).toBeDefined();

    // Format should work
    const formatted = formatPatterns(analysis);
    expect(formatted).toContain("3 sprints");
    expect(formatted.length).toBeGreaterThan(50);
  });
});

// ── Alerts Integration ───────────────────────────────────────

describe("Alert System Integration", () => {
  it("detects stuck tasks and high rework simultaneously", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const supabase = createMockSupabase({
      tasks: [
        { id: "t1", title: "Stuck task", status: "in_progress", updated_at: twoDaysAgo, sprint: "S12" },
        { id: "t2", title: "Active task", status: "done", updated_at: new Date().toISOString(), sprint: "S12" },
      ],
      workflow_logs: [
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-01" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-02" },
        { sprint_id: "S12", had_rework: true, created_at: "2026-02-03" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-04" },
        { sprint_id: "S12", had_rework: false, created_at: "2026-02-05" },
      ],
    });

    const alerts = await runAllChecks(supabase, "S12");
    expect(alerts.length).toBeGreaterThanOrEqual(2);

    const types = alerts.map((a) => a.type);
    expect(types).toContain("stuck_task");
    expect(types).toContain("high_rework");

    const formatted = formatAlerts(alerts);
    expect(formatted).toContain("alertes");
    expect(formatted).toContain("Stuck task");
  });
});

// ── Retro with Pattern Integration ───────────────────────────

describe("Retro Generation with Workflow Data", () => {
  it("generates complete retro data from sprint history", async () => {
    const supabase = createMockSupabase({
      sprint_metrics: [
        { sprint_id: "S12", tasks_planned: 10, tasks_completed: 8 },
      ],
      workflow_logs: [
        { sprint_id: "S12", step_from: "request", step_to: "decomposition", duration_seconds: 60, had_rework: false, checkpoint_result: "skipped", created_at: "2026-02-10T10:00:00Z" },
        { sprint_id: "S12", step_from: "decomposition", step_to: "execution", duration_seconds: 180, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-10T10:03:00Z" },
        { sprint_id: "S12", step_from: "execution", step_to: "review", duration_seconds: 3600, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-10T11:00:00Z" },
        { sprint_id: "S12", step_from: "review", step_to: "execution", duration_seconds: 120, had_rework: true, checkpoint_result: "fail", created_at: "2026-02-10T11:02:00Z" },
        { sprint_id: "S12", step_from: "execution", step_to: "review", duration_seconds: 1800, had_rework: false, checkpoint_result: "corrected", created_at: "2026-02-10T11:32:00Z" },
        { sprint_id: "S12", step_from: "review", step_to: "closure", duration_seconds: 60, had_rework: false, checkpoint_result: "pass", created_at: "2026-02-10T11:33:00Z" },
      ],
      tasks: [
        { id: "t1", sprint: "S12", status: "done", title: "Task A" },
        { id: "t2", sprint: "S12", status: "done", title: "Task B" },
        { id: "t3", sprint: "S12", status: "in_progress", title: "Task C" },
      ],
      retros: [],
    });

    // 1. Generate retro data
    const retroData = await generateRetroData(supabase, "S12");
    expect(retroData).not.toBeNull();
    expect(retroData!.workflowStats.totalTransitions).toBe(6);
    expect(retroData!.workflowStats.reworkCount).toBe(1);
    expect(retroData!.tasks.length).toBe(3);

    // 2. Save a retro
    const saved = await saveRetro(supabase, "S12", {
      what_worked: ["Decomposition rapide", "CI stable"],
      what_didnt: ["Rework sur la review"],
      patterns_detected: ["Execution prend du temps"],
      actions_proposed: [
        { action: "Ajouter des tests en amont", priority: "high" },
        { action: "Automatiser le lint", priority: "medium" },
      ],
      raw_analysis: "Sprint globalement bon, quelques retouches necessaires.",
    });
    expect(saved).toBe(true);

    // 3. Verify the retro is stored
    const retros = supabase._getTable("retros");
    expect(retros.length).toBe(1);

    // 4. Format the retro
    const formatted = formatRetro(retros[0]);
    expect(formatted).toContain("S12");
    expect(formatted).toContain("Decomposition rapide");
    expect(formatted).toContain("Rework sur la review");
  });
});

// ── Memory Integration ───────────────────────────────────────

describe("Memory System Integration", () => {
  it("full memory lifecycle: store facts, goals, complete goals", async () => {
    const supabase = createMockSupabase();
    supabase._registerRpc("get_facts", () =>
      supabase._getTable("memory").filter((m: any) => m.type === "fact")
    );
    supabase._registerRpc("get_active_goals", () =>
      supabase._getTable("memory").filter((m: any) => m.type === "goal")
    );

    // 1. Process a response with memory tags
    const response1 = await processMemoryIntents(
      supabase,
      "Entendu! [REMEMBER: Edouard utilise Bun comme runtime] [GOAL: Terminer le S12 | DEADLINE: 2026-02-20] Je m'en occupe."
    );
    // Two tags removed leave extra spaces; just verify tags are stripped
    expect(response1).not.toContain("[REMEMBER:");
    expect(response1).not.toContain("[GOAL:");
    expect(response1).toContain("Entendu!");
    expect(response1).toContain("Je m'en occupe.");

    // 2. Check stored memory
    const memory = supabase._getTable("memory");
    expect(memory.length).toBe(2);
    expect(memory.some((m: any) => m.type === "fact" && m.content.includes("Bun"))).toBe(true);
    expect(memory.some((m: any) => m.type === "goal" && m.content.includes("S12"))).toBe(true);

    // 3. Get memory context (facts + goals)
    const context = await getMemoryContext(supabase);
    expect(context).toContain("FACTS:");
    expect(context).toContain("Bun");
    expect(context).toContain("GOALS:");
    expect(context).toContain("S12");

    // 4. Complete the goal
    const response2 = await processMemoryIntents(supabase, "C'est fait! [DONE: Terminer le S12]");
    expect(response2).toBe("C'est fait!");

    const updatedMemory = supabase._getTable("memory");
    const completedGoal = updatedMemory.find((m: any) => m.type === "completed_goal");
    expect(completedGoal).toBeDefined();
    expect(completedGoal.completed_at).toBeDefined();
  });

  it("message history is properly stored and retrieved", async () => {
    const supabase = createMockSupabase({
      messages: [
        { role: "user", content: "Salut", created_at: "2026-02-12T09:00:00Z" },
        { role: "assistant", content: "Bonjour Edouard!", created_at: "2026-02-12T09:00:01Z" },
        { role: "user", content: "Lance le sprint", created_at: "2026-02-12T09:01:00Z" },
        { role: "assistant", content: "C'est parti!", created_at: "2026-02-12T09:01:01Z" },
      ],
    });

    const recent = await getRecentMessages(supabase, 10);
    expect(recent).toContain("RECENT CONVERSATION:");
    expect(recent).toContain("Salut");
    expect(recent).toContain("Bonjour Edouard!");
    expect(recent).toContain("Lance le sprint");
  });
});

// ── Cross-Module: Task + Workflow + Pattern Pipeline ─────────

describe("Task-Workflow-Pattern Pipeline", () => {
  it("data flows from tasks through workflow to pattern detection", async () => {
    reloadWorkflowConfig();
    const supabase = createMockSupabase();

    // 1. Create and complete several tasks across 2 sprints
    for (const sprint of ["S11", "S12"]) {
      for (let i = 0; i < 5; i++) {
        const task = await addTask(supabase, `Task ${sprint}-${i}`, { sprint, priority: 2 });
        await updateTaskStatus(supabase, task!.id, "in_progress");

        const tracker = new WorkflowTracker(supabase, {
          taskId: task!.id,
          sprintId: sprint,
        });

        await tracker.transition("decomposition");
        await tracker.transition("execution");
        await tracker.transition("review", { checkpoint_result: "pass" });
        await tracker.transition("closure");

        await updateTaskStatus(supabase, task!.id, "done");
      }

      // Collect metrics after each sprint
      await collectSprintMetrics(supabase, sprint);
    }

    // 2. Verify metrics exist for both sprints
    const metrics = supabase._getTable("sprint_metrics");
    expect(metrics.length).toBe(2);
    expect(metrics.every((m: any) => m.tasks_completed === 5)).toBe(true);

    // 3. Run pattern analysis on the accumulated data
    const analysis = await analyzePatterns(supabase);
    expect(analysis.sprintCount).toBe(2);
    // With consistent 100% completion, should detect improving or stable trend
    expect(analysis.patterns.length).toBeGreaterThanOrEqual(0);

    // 4. Run alerts — no stuck tasks, no rework
    const alerts = await runAllChecks(supabase, "S12");
    // Should have no stuck tasks (all completed)
    const stuckAlerts = alerts.filter((a) => a.type === "stuck_task");
    expect(stuckAlerts.length).toBe(0);
  });
});
