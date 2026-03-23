/**
 * Unit Tests — src/orchestrator.ts
 *
 * Tests for the multi-agent orchestration framework.
 * S22: Structured message passing, retry loop, dynamic pipeline selection.
 */

import { describe, expect, it } from "bun:test";
import { isFeatureEnabled, loadFeatures } from "../../src/feature-flags";
import {
  type AgentRole,
  type AgentStepResult,
  classifyPipeline,
  DEFAULT_PIPELINE,
  formatOrchestrationResult,
  LIGHT_PIPELINE,
  type OrchestratedResult,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  selectPipeline,
} from "../../src/orchestrator";
import type { Task } from "../../src/tasks";

describe("Pipeline Definitions", () => {
  it("DEFAULT_PIPELINE includes all main agents in order", () => {
    expect(DEFAULT_PIPELINE).toEqual(["analyst", "pm", "architect", "dev", "qa"]);
  });

  it("QUICK_PIPELINE has dev and qa only", () => {
    expect(QUICK_PIPELINE).toEqual(["dev", "qa"]);
  });

  it("REVIEW_PIPELINE has qa and architect", () => {
    expect(REVIEW_PIPELINE).toEqual(["qa", "architect"]);
  });

  it("all pipelines contain valid agent roles", () => {
    const validRoles: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm"];
    for (const pipeline of [DEFAULT_PIPELINE, QUICK_PIPELINE, REVIEW_PIPELINE]) {
      for (const role of pipeline) {
        expect(validRoles).toContain(role);
      }
    }
  });
});

describe("formatOrchestrationResult", () => {
  function makeStep(
    agentId: AgentRole,
    agentName: string,
    success: boolean,
    output: string = "test output",
    durationMs: number = 5000,
    opts?: { structured?: any; retryCount?: number },
  ): AgentStepResult {
    return {
      agentId,
      agentName,
      success,
      output,
      structured: opts?.structured ?? null,
      durationMs,
      retryCount: opts?.retryCount,
    };
  }

  it("formats a successful orchestration", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("dev", "Amelia", true, "Code implemented"),
        makeStep("qa", "Quinn", true, "All tests pass"),
      ],
      totalDurationMs: 10000,
      summary: "All agents succeeded",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION OK");
    expect(formatted).toContain("Amelia");
    expect(formatted).toContain("Quinn");
    expect(formatted).toContain("10s");
  });

  it("formats a failed orchestration", () => {
    const result: OrchestratedResult = {
      success: false,
      steps: [
        makeStep("dev", "Amelia", true, "Code done"),
        makeStep("qa", "Quinn", false, "", 3000),
      ],
      totalDurationMs: 8000,
      summary: "QA failed",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION ATTENTION");
    expect(formatted).toContain("echec");
  });

  it("includes last successful agent output in result", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Analysis complete: good feasibility"),
        makeStep("dev", "Amelia", true, "Implemented feature XYZ"),
      ],
      totalDurationMs: 20000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("Implemented feature XYZ");
  });

  it("truncates very long output", () => {
    const longOutput = "x".repeat(5000);
    const result: OrchestratedResult = {
      success: true,
      steps: [makeStep("dev", "Amelia", true, longOutput)],
      totalDurationMs: 5000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("...");
    expect(formatted.length).toBeLessThan(5500);
  });

  it("handles empty steps array", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [],
      totalDurationMs: 0,
      summary: "Nothing to do",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("ORCHESTRATION OK");
    expect(formatted).toContain("0s");
  });

  it("shows duration per agent", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Done", 15000),
        makeStep("pm", "John", true, "Done", 30000),
        makeStep("dev", "Amelia", true, "Done", 120000),
      ],
      totalDurationMs: 165000,
      summary: "All done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("15s");
    expect(formatted).toContain("30s");
    expect(formatted).toContain("120s");
  });

  // S22 — Structured output and retry display

  it("shows [JSON] tag for steps with structured output", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Done", 5000, {
          structured: {
            role: "analyst",
            analysis: "ok",
            risks: [],
            recommendations: [],
            dependencies: [],
            feasibility: "high",
          },
        }),
        makeStep("dev", "Amelia", true, "Done", 10000),
      ],
      totalDurationMs: 15000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("[JSON]");
    // Dev should NOT have [JSON]
    const lines = formatted.split("\n");
    const ameliaLine = lines.find((l) => l.includes("Amelia"));
    expect(ameliaLine).not.toContain("[JSON]");
  });

  it("shows retry count in formatted output", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [makeStep("dev", "Amelia", true, "Done", 15000, { retryCount: 2 })],
      totalDurationMs: 15000,
      summary: "Done after retries",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("2 retries");
    expect(formatted).toContain("Retries: 2");
  });

  it("does not show retries when count is 0", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [makeStep("dev", "Amelia", true, "Done")],
      totalDurationMs: 5000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).not.toContain("retries");
    expect(formatted).not.toContain("Retries:");
  });

  it("shows total retries across multiple agents", () => {
    const result: OrchestratedResult = {
      success: true,
      steps: [
        makeStep("analyst", "Mary", true, "Done", 5000, { retryCount: 1 }),
        makeStep("dev", "Amelia", true, "Done", 10000, { retryCount: 2 }),
      ],
      totalDurationMs: 15000,
      summary: "Done",
    };

    const formatted = formatOrchestrationResult(result);
    expect(formatted).toContain("Retries: 3");
  });
});

// ── S22-06: Dynamic Pipeline Selection ───────────────────────

describe("selectPipeline", () => {
  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "test-id",
      title: "Test task",
      status: "backlog",
      priority: 2,
      created_at: new Date().toISOString(),
      project: "test",
      ...overrides,
    } as Task;
  }

  it("returns explicit pipeline when provided", () => {
    const task = makeTask({ title: "Fix bug" });
    const pipeline = selectPipeline(task, ["dev", "qa"]);
    expect(pipeline).toEqual(["dev", "qa"]);
  });

  it("selects QUICK for bug fix tasks", () => {
    const bugTitles = [
      "Fix crash on startup",
      "Bug: messages not delivered",
      "Hotfix for login error",
      "Corriger le crash du dashboard",
      "Patch regression S21",
    ];

    for (const title of bugTitles) {
      const task = makeTask({ title });
      expect(selectPipeline(task)).toEqual(QUICK_PIPELINE);
    }
  });

  it("selects REVIEW for review/audit tasks", () => {
    const reviewTitles = [
      "Code review module orchestrator",
      "Audit securite des endpoints",
      "Refactor memory module",
      "Nettoyage du code mort",
    ];

    for (const title of reviewTitles) {
      const task = makeTask({ title });
      expect(selectPipeline(task)).toEqual(REVIEW_PIPELINE);
    }
  });

  it("selects QUICK for documentation tasks", () => {
    const docTitles = [
      "Update README documentation",
      "Ajouter le changelog",
      "Guide de setup pour nouveaux devs",
    ];

    for (const title of docTitles) {
      const task = makeTask({ title });
      expect(selectPipeline(task)).toEqual(QUICK_PIPELINE);
    }
  });

  it("selects QUICK for simple low-priority tasks", () => {
    const task = makeTask({
      title: "Add button",
      priority: 3,
      subtasks: null,
    });
    expect(selectPipeline(task)).toEqual(QUICK_PIPELINE);
  });

  it("selects DEFAULT for complex feature tasks", () => {
    const task = makeTask({
      title: "Implement multi-agent parallel execution with worktrees",
      priority: 1,
    });
    expect(selectPipeline(task)).toEqual(DEFAULT_PIPELINE);
  });

  it("checks description as well as title", () => {
    const task = makeTask({
      title: "Update module",
      description: "Fix the crash that happens on reload",
    });
    expect(selectPipeline(task)).toEqual(QUICK_PIPELINE);
  });

  it("does not classify P1/P2 short titles without keywords as QUICK", () => {
    const task = makeTask({
      title: "Add new feature",
      priority: 1,
    });
    expect(selectPipeline(task)).toEqual(DEFAULT_PIPELINE);
  });
});

describe("classifyPipeline", () => {
  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "test-id",
      title: "Test task",
      status: "backlog",
      priority: 2,
      created_at: new Date().toISOString(),
      project: "test",
      ...overrides,
    } as Task;
  }

  it("classifies bug tasks as QUICK", () => {
    expect(classifyPipeline(makeTask({ title: "Fix bug" }))).toBe("QUICK");
  });

  it("classifies review tasks as REVIEW", () => {
    expect(classifyPipeline(makeTask({ title: "Code review" }))).toBe("REVIEW");
  });

  it("classifies doc tasks as DOC", () => {
    expect(classifyPipeline(makeTask({ title: "Update documentation" }))).toBe("DOC");
  });

  it("classifies feature tasks as DEFAULT", () => {
    expect(classifyPipeline(makeTask({ title: "Implement new auth system", priority: 1 }))).toBe(
      "DEFAULT",
    );
  });
});

// ── P1/P2/E1/P3 Feature Flags ────────────────────────────────

describe("[V14] Feature Flags for P1/P2/E1/P3", () => {
  it("[V14] config/features.json contains spec_phase_lite=false", () => {
    const flags = loadFeatures();
    expect(flags.spec_phase_lite).toBe(false);
  });

  it("[V14] config/features.json contains adversarial_challenge=false", () => {
    const flags = loadFeatures();
    expect(flags.adversarial_challenge).toBe(false);
  });

  it("spec_phase_lite is disabled by default", () => {
    expect(isFeatureEnabled("spec_phase_lite")).toBe(false);
  });

  it("adversarial_challenge is disabled by default", () => {
    expect(isFeatureEnabled("adversarial_challenge")).toBe(false);
  });

  it("[V15] existing flags are unchanged after adding new ones", () => {
    const flags = loadFeatures();
    expect(flags.heartbeat).toBe(true);
    expect(flags.job_manager).toBe(true);
    expect(flags.auto_document_search).toBe(true);
    expect(flags.prd_to_deploy).toBe(true);
    expect(flags.exploration_phase).toBe(false);
    expect(flags.exploration_gate).toBe(false);
    expect(flags.llmops_monitoring).toBe(true);
  });
});

describe("[V12] P1/P2/E1/P3 pipeline scope guards", () => {
  function _makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "test-scope",
      title: "Test task",
      status: "backlog",
      priority: 2,
      created_at: new Date().toISOString(),
      project: "test",
      ...overrides,
    } as Task;
  }

  it("QUICK pipeline is not affected by P1/P2/P3", () => {
    // V12: QUICK, SOLO, REVIEW unaffected even if flags active
    // (the orchestrator checks pipelineTypeForFlags before calling P1/P2/P3)
    expect(QUICK_PIPELINE).toEqual(["dev", "qa"]);
    expect(QUICK_PIPELINE).not.toContain("spec-lite");
    expect(QUICK_PIPELINE).not.toContain("adversarial");
  });

  it("SOLO pipeline is not affected by P1/P2/P3", () => {
    expect(SOLO_PIPELINE).toEqual(["dev"]);
  });

  it("REVIEW pipeline is not affected by P1/P2/P3", () => {
    expect(REVIEW_PIPELINE).toEqual(["qa", "architect"]);
  });

  it("DEFAULT pipeline has dev preceded by architect (P2 insertion point)", () => {
    const devIdx = DEFAULT_PIPELINE.indexOf("dev");
    const archIdx = DEFAULT_PIPELINE.indexOf("architect");
    expect(devIdx).toBeGreaterThan(archIdx);
    // P2 inserts between architect and dev (F-DA-2)
  });

  it("LIGHT pipeline has dev preceded by planner (P2 insertion point)", () => {
    const devIdx = LIGHT_PIPELINE.indexOf("dev");
    const plannerIdx = LIGHT_PIPELINE.indexOf("planner");
    expect(devIdx).toBeGreaterThan(plannerIdx);
    // F-DA-2: P2 inserts by detecting pre-dev agent, not by gateMap
  });
});

// ── Working memory promotion in orchestrator ─────────────────

describe("memory_promotion feature flag", () => {
  // V2 / V12: Flag exists in config
  it("[V12] memory_promotion flag exists in features.json and defaults to false", () => {
    const flags = loadFeatures();
    expect(flags.memory_promotion).toBe(false);
  });

  it("memory_promotion is disabled by default", () => {
    expect(isFeatureEnabled("memory_promotion")).toBe(false);
  });
});

// ── Working memory promotion structural verification ─────────

describe("Working memory promotion in orchestrate()", () => {
  // Read orchestrator source once for structural assertions
  let orchestratorSource: string;

  it("loads orchestrator source for structural tests", async () => {
    const fs = await import("fs");
    orchestratorSource = fs.readFileSync("src/orchestrator.ts", "utf-8");
    expect(orchestratorSource.length).toBeGreaterThan(0);
  });

  it("[V1] promoteWorkingMemory is called when memory_promotion flag is active and blackboard has working_memory", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V1: The orchestrator must check isFeatureEnabled("memory_promotion") AND bbSessionId
    const guardMatch = source.match(
      /if\s*\(\s*isFeatureEnabled\(\s*["']memory_promotion["']\s*\)\s*&&\s*bbSessionId\s*\)/,
    );
    expect(guardMatch).not.toBeNull();

    // V1: promoteWorkingMemory is called with supabase, working memory, and sessionId
    const callMatch = source.match(
      /promoteWorkingMemory\(\s*supabase\s*,\s*wmForPromotion\s*,\s*bbSessionId\s*\)/,
    );
    expect(callMatch).not.toBeNull();

    // V1: working memory is read from blackboard section
    expect(source).toContain('readSection(supabase, bbSessionId, "working_memory")');
  });

  it("[V2] promoteWorkingMemory is NOT called when flag is inactive", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V2: The guard ensures promotion is skipped when flag is off
    // isFeatureEnabled("memory_promotion") is the first condition in the if-guard
    const guardMatch = source.match(/if\s*\(\s*isFeatureEnabled\(\s*["']memory_promotion["']\s*\)/);
    expect(guardMatch).not.toBeNull();

    // V2: promoteWorkingMemory only appears INSIDE this guarded block, not elsewhere
    const lines = source.split("\n");
    const promoteCalls = lines.filter(
      (l) =>
        l.includes("promoteWorkingMemory(") &&
        !l.trimStart().startsWith("import") &&
        !l.trimStart().startsWith("//"),
    );
    // Should only have one call (the guarded one)
    expect(promoteCalls.length).toBe(1);
  });

  it("[V3] promoteWorkingMemory is NOT called when useBlackboard is false", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V3: bbSessionId is only set when options.useBlackboard is true
    // The guard `isFeatureEnabled("memory_promotion") && bbSessionId` ensures
    // no promotion when blackboard is not used (bbSessionId stays null)
    const bbSessionInit = source.match(/let\s+bbSessionId:\s*string\s*\|\s*null\s*=\s*null/);
    expect(bbSessionInit).not.toBeNull();

    // bbSessionId is only assigned inside if (options.useBlackboard)
    const bbAssignment = source.match(
      /if\s*\(\s*options\.useBlackboard\s*\)\s*\{[\s\S]*?bbSessionId\s*=\s*`bb-/,
    );
    expect(bbAssignment).not.toBeNull();
  });

  it("[V4] promoteWorkingMemory failure does not block orchestrate() return", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V4: The promotion block is wrapped in try/catch
    // Extract the promotion block and verify it's inside try/catch
    const tryCatchMatch = source.match(
      /try\s*\{[\s\S]*?promoteWorkingMemory\([\s\S]*?\}\s*catch\s*\(\s*promoError\s*\)/,
    );
    expect(tryCatchMatch).not.toBeNull();

    // V4: The catch block logs the error but does NOT re-throw
    const catchBlock = source.match(
      /catch\s*\(\s*promoError\s*\)\s*\{[^}]*log\.error\([^)]*\)[^}]*\}/,
    );
    expect(catchBlock).not.toBeNull();

    // V4: After the try/catch, the function continues to return orchestratedResult
    const afterPromotion = source.indexOf("promoteWorkingMemory(");
    const returnResult = source.indexOf("return orchestratedResult;", afterPromotion);
    expect(returnResult).toBeGreaterThan(afterPromotion);
  });

  it("[V5] promotion count is reported via onProgress", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V5: onProgress is called with the promoted count
    const progressMatch = source.match(
      /if\s*\(\s*promotedCount\s*>\s*0\s*&&\s*options\.onProgress\s*\)/,
    );
    expect(progressMatch).not.toBeNull();

    // V5: The message contains the count of promoted items (may be multiline after formatting)
    const messageMatch = source.match(
      /options\.onProgress\(\s*`Working memory: \$\{promotedCount\} items promus en memoire permanente`[\s,]*\)/s,
    );
    expect(messageMatch).not.toBeNull();
  });

  it("[V13] promotion works with InMemoryBlackboard fallback", async () => {
    const fs = await import("fs");
    const source = fs.readFileSync("src/orchestrator.ts", "utf-8");

    // V13: When supabase is null or bbFallback exists, reading uses InMemoryBlackboard
    const fallbackRead = source.match(
      /bbFallback\?\.read\(\s*bbSessionId\s*,\s*["']working_memory["']\s*\)/,
    );
    expect(fallbackRead).not.toBeNull();

    // V13: The ternary handles both Supabase and InMemoryBlackboard paths
    const ternaryMatch = source.match(
      /supabase\s*&&\s*!bbFallback[\s\S]*?readSection\([\s\S]*?\)\s*:\s*.*bbFallback\?\.read\(/,
    );
    expect(ternaryMatch).not.toBeNull();
  });
});
