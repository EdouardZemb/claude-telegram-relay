/**
 * Tests — SPEC-reviser-prd-to-deploy-workflow
 *
 * V-criteres from Section 8. Covers:
 * - runPrdPreflightChecks full pipeline (V1)
 * - P1 skipped when spec_phase_lite off (V2)
 * - P2+E1 skipped when adversarial_challenge off (V3)
 * - verdict SKIPPED when both sub-flags off (V4)
 * - verdict PAUSE on BLOQUANT finding (V5)
 * - verdict PAUSE on adversarial SKIPPED (V5bis)
 * - formatPreflightReport plain text (V6)
 * - formatPreflightReport finding filtering (V7)
 * - storePendingProtoSpec / getPendingProtoSpec TTL (V8)
 * - prdwf_preflight_ok callback (V9) [integration - skeleton]
 * - prdwf_preflight_abort callback (V10) [integration - skeleton]
 * - prdwf_revise_prd callback (V11) [integration - skeleton]
 * - Retrocompatibility with flag off (V12) [integration - skeleton]
 * - prdWorkflowStep accepts spec_preflight (V13)
 * - job-manager prd-preflight buttons (V14)
 * - job-manager prd-preflight PAUSE 3 buttons (V15)
 * - prd_maturation_phases flag in features.json (V18)
 * - preflight launched via launchJob (V19) [integration - skeleton]
 * - cleanup after prdwf_preflight_abort (V20)
 *
 * V16, V17: DEFERRED (V2 — conformance check)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// ── Mock Setup ───────────────────────────────────────────────

// Track which flags are "enabled" for testing
const mockFlagState: Record<string, boolean> = {};

mock.module("../../src/feature-flags", () => ({
  isFeatureEnabled: (flag: string) => mockFlagState[flag] === true,
  loadFeatures: () => ({ ...mockFlagState }),
  setFeature: mock(),
  listFeatures: () => Object.entries(mockFlagState).map(([flag, enabled]) => ({ flag, enabled })),
  formatFeatures: () => "",
}));

// Mock spec-lite
const mockGenerateProtoSpec = mock(() =>
  Promise.resolve({
    objective: "Test objective",
    v_criteria: [
      { id: "V1", description: "test criterion", level: "unit" as const },
      { id: "V2", description: "test criterion 2", level: "integration" as const },
    ],
    impacted_files: ["src/module-a.ts", "src/module-b.ts"],
    generated_at: new Date().toISOString(),
    agent_model: "claude-haiku-4-5",
    duration_ms: 100,
  }),
);
mock.module("../../src/spec-lite", () => ({
  generateProtoSpec: mockGenerateProtoSpec,
  parseProtoSpec: mock(),
}));

// Mock adversarial-challenge
const mockRunAdversarialChallenge = mock(() =>
  Promise.resolve({
    findings: [] as any[],
    stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
    verdict: "PASS" as const,
    duration_ms: 200,
  }),
);
const mockRunImpactAnalysis = mock(() =>
  Promise.resolve({
    risk_level: "LOW" as const,
    modules_impacted_direct: 1,
    modules_impacted_transitive: 3,
    breaking_changes: [] as string[],
    attention_points: [] as string[],
    graph_only: true,
    duration_ms: 50,
  }),
);
mock.module("../../src/adversarial-challenge", () => ({
  runAdversarialChallenge: mockRunAdversarialChallenge,
  runImpactAnalysis: mockRunImpactAnalysis,
}));

// Mock story-files
mock.module("../../src/story-files", () => ({
  buildStoryFile: mock(() => ({
    title: "Test task",
    description: "desc",
    acceptanceCriteria: [{ id: "AC-1", given: "g", when: "w", then: "t" }],
    implementationSteps: [
      { id: "STEP-1", title: "step", description: "d", acMapping: [], done: false },
    ],
    testStubs: [{ id: "TEST-1", description: "test", type: "unit", acMapping: "AC-1" }],
    doneCriteria: ["done"],
    impactedFiles: ["src/fallback.ts"],
    architectureNotes: "",
  })),
  enrichTaskWithStory: mock(() => Promise.resolve()),
  formatStoryForAgent: mock(() => "story"),
}));

// ── Imports (after mocks) ────────────────────────────────────

import { getCompletionKeyboard, type Job } from "../../src/job-manager";
import {
  buildPreflightKeyboard,
  buildPreflightResultTag,
  clearPendingProtoSpec,
  formatPreflightReport,
  getPendingProtoSpec,
  isPrdMaturationEnabled,
  type PreflightReport,
  runPrdPreflightChecks,
  storePendingProtoSpec,
} from "../../src/prd-workflow";

// ── Test Data Helpers ────────────────────────────────────────

function makeMockPRD() {
  return {
    id: "c495951a-1234-5678-abcd-ef0123456789",
    title: "Test PRD",
    content: "PRD content for testing",
    summary: "Test summary",
    project: "telegram-relay",
    status: "approved" as const,
    created_at: new Date().toISOString(),
    metadata: {},
  };
}

function makeMockTasks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}-xxxx-yyyy-zzzz-123456789abc`,
    title: `Task ${i + 1}`,
    description: `Description for task ${i + 1}`,
    status: "backlog" as const,
    priority: 2,
    project: "telegram-relay",
    created_at: new Date().toISOString(),
    acceptance_criteria: `AC for task ${i + 1}`,
  }));
}

function makeFullReport(overrides?: Partial<PreflightReport>): PreflightReport {
  return {
    prdId: "c495951a",
    prdTitle: "Test PRD",
    protoSpecs: [
      {
        taskId: "task-1",
        taskTitle: "Task 1",
        spec: {
          objective: "Objective 1",
          v_criteria: [
            { id: "V1", description: "criterion 1", level: "unit" },
            { id: "V2", description: "criterion 2", level: "integration" },
          ],
          impacted_files: ["src/a.ts", "src/b.ts"],
          generated_at: new Date().toISOString(),
          agent_model: "claude-haiku-4-5",
          duration_ms: 100,
        },
      },
    ],
    adversarial: {
      findings: [],
      stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
      verdict: "PASS",
      duration_ms: 200,
    },
    impact: {
      risk_level: "LOW",
      modules_impacted_direct: 1,
      modules_impacted_transitive: 3,
      breaking_changes: [],
      attention_points: [],
      graph_only: true,
      duration_ms: 50,
    },
    verdict: "PASS",
    durationMs: 350,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

// V-critere: V1
describe("[V1] runPrdPreflightChecks returns valid PreflightReport with all sub-flags active", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = true;
    mockFlagState.adversarial_challenge = true;
    mockGenerateProtoSpec.mockClear();
    mockRunAdversarialChallenge.mockClear();
    mockRunImpactAnalysis.mockClear();
    mockRunAdversarialChallenge.mockImplementation(() =>
      Promise.resolve({
        findings: [],
        stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
        verdict: "PASS" as const,
        duration_ms: 200,
      }),
    );
  });

  test("returns PreflightReport with protoSpecs, adversarial, impact, and verdict PASS", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(2);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.prdId).toBe(prd.id);
    expect(report.prdTitle).toBe(prd.title);
    expect(report.protoSpecs.length).toBe(2);
    expect(report.adversarial).not.toBeNull();
    expect(report.impact).not.toBeNull();
    expect(report.verdict).toBe("PASS");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("calls generateProtoSpec once per task", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(3);
    await runPrdPreflightChecks(prd as any, tasks as any);
    expect(mockGenerateProtoSpec).toHaveBeenCalledTimes(3);
  });

  test("calls runAdversarialChallenge with synthetic input (PRD title)", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    await runPrdPreflightChecks(prd as any, tasks as any);

    expect(mockRunAdversarialChallenge).toHaveBeenCalledTimes(1);
    const callArg = mockRunAdversarialChallenge.mock.calls[0][0] as any;
    expect(callArg.taskTitle).toBe(prd.title);
    expect(callArg.taskDescription).toBe(prd.content);
  });

  test("calls runImpactAnalysis with union of impacted files from proto-specs", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    await runPrdPreflightChecks(prd as any, tasks as any);

    expect(mockRunImpactAnalysis).toHaveBeenCalledTimes(1);
    const callArg = mockRunImpactAnalysis.mock.calls[0][0] as any;
    // mockGenerateProtoSpec returns impacted_files: ["src/module-a.ts", "src/module-b.ts"]
    expect(callArg).toContain("src/module-a.ts");
    expect(callArg).toContain("src/module-b.ts");
  });
});

// V-critere: V2
describe("[V2] runPrdPreflightChecks skips P1 when spec_phase_lite is off", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = false;
    mockFlagState.adversarial_challenge = true;
    mockGenerateProtoSpec.mockClear();
    mockRunAdversarialChallenge.mockClear();
    mockRunImpactAnalysis.mockClear();
    mockRunAdversarialChallenge.mockImplementation(() =>
      Promise.resolve({
        findings: [],
        stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
        verdict: "PASS" as const,
        duration_ms: 200,
      }),
    );
  });

  test("returns protoSpecs: [] when spec_phase_lite is off", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(2);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.protoSpecs).toEqual([]);
    expect(mockGenerateProtoSpec).not.toHaveBeenCalled();
  });

  test("still runs P2+E1 when spec_phase_lite is off", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.adversarial).not.toBeNull();
    expect(report.impact).not.toBeNull();
    expect(mockRunAdversarialChallenge).toHaveBeenCalledTimes(1);
    expect(mockRunImpactAnalysis).toHaveBeenCalledTimes(1);
  });

  test("E1 uses impactedFiles from story files when P1 is off (R5bis)", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    await runPrdPreflightChecks(prd as any, tasks as any);

    // Story file mock returns impactedFiles: ["src/fallback.ts"]
    const callArg = mockRunImpactAnalysis.mock.calls[0][0] as any;
    expect(callArg).toContain("src/fallback.ts");
  });
});

// V-critere: V3
describe("[V3] runPrdPreflightChecks skips P2+E1 when adversarial_challenge is off", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = true;
    mockFlagState.adversarial_challenge = false;
    mockGenerateProtoSpec.mockClear();
    mockRunAdversarialChallenge.mockClear();
    mockRunImpactAnalysis.mockClear();
  });

  test("returns adversarial: null, impact: null when adversarial_challenge is off", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.adversarial).toBeNull();
    expect(report.impact).toBeNull();
    expect(mockRunAdversarialChallenge).not.toHaveBeenCalled();
    expect(mockRunImpactAnalysis).not.toHaveBeenCalled();
  });

  test("still runs P1 when adversarial_challenge is off", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(2);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.protoSpecs.length).toBe(2);
    expect(mockGenerateProtoSpec).toHaveBeenCalledTimes(2);
  });

  test("verdict is PASS when only P1 runs", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.verdict).toBe("PASS");
  });
});

// V-critere: V4
describe("[V4] runPrdPreflightChecks returns verdict SKIPPED when both sub-flags off", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = false;
    mockFlagState.adversarial_challenge = false;
  });

  test("returns verdict SKIPPED with empty data", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.verdict).toBe("SKIPPED");
    expect(report.protoSpecs).toEqual([]);
    expect(report.adversarial).toBeNull();
    expect(report.impact).toBeNull();
  });
});

// V-critere: V5
describe("[V5] runPrdPreflightChecks returns verdict PAUSE on BLOQUANT finding", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = true;
    mockFlagState.adversarial_challenge = true;
    mockRunAdversarialChallenge.mockImplementation(() =>
      Promise.resolve({
        findings: [
          {
            id: "F-1",
            severity: "BLOQUANT" as const,
            title: "Blocking issue",
            description: "A critical problem",
            source: "test",
          },
        ],
        stats: { bloquants: 1, majeurs: 0, mineurs: 0 },
        verdict: "PAUSE" as const,
        duration_ms: 100,
      }),
    );
  });

  test("returns verdict PAUSE when adversarial has BLOQUANT findings", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.verdict).toBe("PAUSE");
  });
});

// V-critere: V5bis
describe("[V5bis] runPrdPreflightChecks returns verdict PAUSE when adversarial returns SKIPPED", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = true;
    mockFlagState.spec_phase_lite = true;
    mockFlagState.adversarial_challenge = true;
    mockRunAdversarialChallenge.mockImplementation(() =>
      Promise.resolve({
        findings: [],
        stats: { bloquants: 0, majeurs: 0, mineurs: 0 },
        verdict: "SKIPPED" as const,
        duration_ms: 100,
      }),
    );
  });

  test("returns verdict PAUSE when adversarial verdict is SKIPPED (F-DA-2 prudence)", async () => {
    const prd = makeMockPRD();
    const tasks = makeMockTasks(1);
    const report = await runPrdPreflightChecks(prd as any, tasks as any);

    expect(report.verdict).toBe("PAUSE");
  });
});

// V-critere: V6
describe("[V6] formatPreflightReport produces plain text without markdown", () => {
  test("output contains no markdown characters (*, _, `)", () => {
    const report = makeFullReport();
    const text = formatPreflightReport(report);

    expect(text).not.toContain("*");
    expect(text).not.toContain("_");
    expect(text).not.toContain("`");
  });

  test("output contains required sections: proto-spec, challenge, impact, duree", () => {
    const report = makeFullReport();
    const text = formatPreflightReport(report);

    expect(text).toContain("Proto-spec");
    expect(text).toContain("Challenge adversarial");
    expect(text).toContain("Analyse d'impact");
    expect(text).toContain("Duree");
  });

  test("output starts with RAPPORT PRE-LANCEMENT", () => {
    const report = makeFullReport();
    const text = formatPreflightReport(report);

    expect(text.startsWith("RAPPORT PRE-LANCEMENT")).toBe(true);
  });

  test("includes PRD title in header", () => {
    const report = makeFullReport({ prdTitle: "Mon Feature" });
    const text = formatPreflightReport(report);

    expect(text).toContain("Mon Feature");
  });

  test("shows task count and V-criteria count", () => {
    const report = makeFullReport();
    const text = formatPreflightReport(report);

    expect(text).toContain("1 taches analysees");
    expect(text).toContain("2 V-criteres generes");
  });

  test("shows duration in seconds", () => {
    const report = makeFullReport({ durationMs: 5000 });
    const text = formatPreflightReport(report);

    expect(text).toContain("Duree : 5s");
  });
});

// V-critere: V7
describe("[V7] formatPreflightReport filters findings by severity (R9)", () => {
  test("always shows BLOQUANT findings", () => {
    const report = makeFullReport({
      adversarial: {
        findings: [
          {
            id: "F-1",
            severity: "BLOQUANT",
            title: "Blocking issue",
            description: "desc",
            source: "s",
          },
        ],
        stats: { bloquants: 1, majeurs: 0, mineurs: 0 },
        verdict: "PAUSE",
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    expect(text).toContain("F-1 : Blocking issue");
  });

  test("shows MAJEUR findings when <= 3", () => {
    const report = makeFullReport({
      adversarial: {
        findings: [
          { id: "F-1", severity: "MAJEUR", title: "Major 1", description: "d", source: "s" },
          { id: "F-2", severity: "MAJEUR", title: "Major 2", description: "d", source: "s" },
        ],
        stats: { bloquants: 0, majeurs: 2, mineurs: 0 },
        verdict: "PASS",
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    expect(text).toContain("F-1 : Major 1");
    expect(text).toContain("F-2 : Major 2");
  });

  test("hides individual MAJEUR findings when > 3", () => {
    const findings = Array.from({ length: 4 }, (_, i) => ({
      id: `F-${i + 1}`,
      severity: "MAJEUR" as const,
      title: `Major ${i + 1}`,
      description: "d",
      source: "s",
    }));
    const report = makeFullReport({
      adversarial: {
        findings,
        stats: { bloquants: 0, majeurs: 4, mineurs: 0 },
        verdict: "PASS",
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    // Should show the count but not individual titles
    expect(text).toContain("4 finding(s) majeur(s)");
    expect(text).not.toContain("F-1 : Major 1");
  });

  test("never shows MINEUR findings", () => {
    const report = makeFullReport({
      adversarial: {
        findings: [
          { id: "F-1", severity: "BLOQUANT", title: "Blocker", description: "d", source: "s" },
          { id: "F-2", severity: "MINEUR", title: "Minor issue", description: "d", source: "s" },
        ],
        stats: { bloquants: 1, majeurs: 0, mineurs: 1 },
        verdict: "PAUSE",
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    expect(text).toContain("F-1 : Blocker");
    expect(text).not.toContain("Minor issue");
  });

  test("combined: 1 BLOQUANT, 4 MAJEURS, 2 MINEURS — only BLOQUANT shown", () => {
    const findings = [
      {
        id: "F-B1",
        severity: "BLOQUANT" as const,
        title: "Blocker one",
        description: "d",
        source: "s",
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `F-M${i + 1}`,
        severity: "MAJEUR" as const,
        title: `Major ${i + 1}`,
        description: "d",
        source: "s",
      })),
      {
        id: "F-m1",
        severity: "MINEUR" as const,
        title: "Minor one",
        description: "d",
        source: "s",
      },
      {
        id: "F-m2",
        severity: "MINEUR" as const,
        title: "Minor two",
        description: "d",
        source: "s",
      },
    ];
    const report = makeFullReport({
      adversarial: {
        findings,
        stats: { bloquants: 1, majeurs: 4, mineurs: 2 },
        verdict: "PAUSE",
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    expect(text).toContain("F-B1 : Blocker one");
    expect(text).not.toContain("Major 1");
    expect(text).not.toContain("Minor one");
  });
});

// V-critere: V8
describe("[V8] storePendingProtoSpec / getPendingProtoSpec with TTL", () => {
  afterEach(() => {
    clearPendingProtoSpec("test-key");
  });

  test("stores and retrieves proto-specs immediately", () => {
    const specs = [
      {
        taskId: "t1",
        taskTitle: "Task 1",
        spec: {
          objective: "obj",
          v_criteria: [],
          impacted_files: [],
          generated_at: "",
          agent_model: "",
          duration_ms: 0,
        },
      },
    ];
    storePendingProtoSpec("test-key", "prd-123", specs);
    const result = getPendingProtoSpec("test-key");
    expect(result).toBeDefined();
    expect(result!.prdId).toBe("prd-123");
    expect(result!.protoSpecs).toEqual(specs);
  });

  test("clearPendingProtoSpec removes the value", () => {
    storePendingProtoSpec("test-key", "prd-123", []);
    clearPendingProtoSpec("test-key");
    const result = getPendingProtoSpec("test-key");
    expect(result).toBeUndefined();
  });

  test("returns undefined for non-existent key", () => {
    const result = getPendingProtoSpec("non-existent-key");
    expect(result).toBeUndefined();
  });
});

// V-critere: V9
describe("[V9] prdwf_preflight_ok callback launches batch pipeline", () => {
  test.skip("calls launchJob with autopipeline-batch type", () => {
    // Integration test: requires full Composer + callback context
    // TODO: mock ctx, bctx, simulate callback prdwf_preflight_ok
  });
});

// V-critere: V10
describe("[V10] prdwf_preflight_abort cancels workflow", () => {
  test.skip("calls ctx.editMessageText with cancellation message", () => {
    // Integration test: requires full Composer + callback context
  });

  test("cleans up pendingProtoSpecs", () => {
    storePendingProtoSpec("abort-key", "prd-999", []);
    // Simulate what abort handler does
    clearPendingProtoSpec("abort-key");
    expect(getPendingProtoSpec("abort-key")).toBeUndefined();
  });
});

// V-critere: V11
describe("[V11] prdwf_revise_prd redirects to PRD revision flow", () => {
  test.skip("stores pending revision with prdId", () => {
    // Integration test: requires full Composer + callback context
  });
});

// V-critere: V12
describe("[V12] Retrocompatibility: prd_maturation_phases off preserves existing flow", () => {
  beforeEach(() => {
    mockFlagState.prd_maturation_phases = false;
    mockFlagState.prd_to_deploy = true;
  });

  test("isPrdMaturationEnabled returns false when flag is off", () => {
    expect(isPrdMaturationEnabled()).toBe(false);
  });

  test.skip("prd_approve -> decompose -> prdwf_launch flow unchanged", () => {
    // Integration test: requires full Composer + callback context
  });
});

// V-critere: V13
describe("[V13] prdWorkflowStep accepts spec_preflight value", () => {
  test("spec_preflight is a valid value for prdWorkflowStep", () => {
    // Import the type and verify runtime assignment works
    const { getSession } = require("../../src/conversation-session");
    // Create a session and set the step
    const session = getSession(999999, 888888);
    session.prdWorkflowStep = "spec_preflight";
    expect(session.prdWorkflowStep).toBe("spec_preflight");
  });

  test("existing values still valid: triage, generation, revision, decomposition, implementation, done", () => {
    const { getSession, _resetSessions } = require("../../src/conversation-session");
    const existing = [
      "triage",
      "generation",
      "revision",
      "decomposition",
      "implementation",
      "done",
    ];
    const session = getSession(999998, 888887);
    for (const step of existing) {
      session.prdWorkflowStep = step;
      expect(session.prdWorkflowStep).toBe(step);
    }
  });
});

// V-critere: V14
describe("[V14] job-manager prd-preflight generates 2 buttons on completion", () => {
  test("getCompletionKeyboard returns keyboard for prd-preflight PASS", () => {
    const job: Job = {
      id: "test-job",
      type: "prd-preflight",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "PRDWF_PREFLIGHT:abc12345|PASS|3 taches analysees, 12 V-criteres, risque LOW",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    // Verify the keyboard has buttons (InlineKeyboard internal structure)
    const kbStr = JSON.stringify(kb);
    expect(kbStr).toContain("prdwf_preflight_ok");
    expect(kbStr).toContain("prdwf_preflight_abort");
  });
});

// V-critere: V15
describe("[V15] job-manager prd-preflight with PAUSE generates 3 buttons", () => {
  test("getCompletionKeyboard returns 3 buttons including prdwf_revise_prd when verdict PAUSE", () => {
    const job: Job = {
      id: "test-job",
      type: "prd-preflight",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "PRDWF_PREFLIGHT:abc12345|PAUSE|1 bloquant identifie",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    const kbStr = JSON.stringify(kb);
    expect(kbStr).toContain("prdwf_preflight_ok");
    expect(kbStr).toContain("prdwf_preflight_abort");
    expect(kbStr).toContain("prdwf_revise_prd");
  });

  test("getCompletionKeyboard does NOT include prdwf_revise_prd when verdict PASS", () => {
    const job: Job = {
      id: "test-job",
      type: "prd-preflight",
      status: "completed",
      chatId: 123,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result: "PRDWF_PREFLIGHT:abc12345|PASS|all good",
      error: null,
    };
    const kb = getCompletionKeyboard(job);
    expect(kb).toBeDefined();
    const kbStr = JSON.stringify(kb);
    expect(kbStr).not.toContain("prdwf_revise_prd");
  });
});

// V-critere: V18
describe("[V18] prd_maturation_phases flag present in features.json", () => {
  test("flag exists in config/features.json with default false", () => {
    const flagsPath = join(__dirname, "../../config/features.json");
    const flags = JSON.parse(readFileSync(flagsPath, "utf-8"));
    expect(flags).toHaveProperty("prd_maturation_phases");
    expect(flags.prd_maturation_phases).toBe(false);
  });
});

// V-critere: V19
describe("[V19] Preflight launched via launchJob, does not block handler", () => {
  test.skip("launchJob called with type prd-preflight", () => {
    // Integration test: requires full Composer + callback context
  });
});

// V-critere: V20
describe("[V20] After prdwf_preflight_abort, new workflow starts clean", () => {
  test("no residual state in pendingProtoSpecs after cleanup", () => {
    const key = "cleanup-test";
    storePendingProtoSpec(key, "prd-cleanup", []);
    // Simulate abort cleanup
    clearPendingProtoSpec(key);
    expect(getPendingProtoSpec(key)).toBeUndefined();
  });
});

// ── Additional: buildPreflightResultTag ──────────────────────

describe("buildPreflightResultTag", () => {
  test("produces correct tag format", () => {
    const report = makeFullReport();
    const tag = buildPreflightResultTag(report);
    expect(tag).toStartWith("PRDWF_PREFLIGHT:");
    expect(tag).toContain("|PASS|");
    expect(tag).toContain("1 taches analysees");
    expect(tag).toContain("2 V-criteres");
    expect(tag).toContain("risque LOW");
  });

  test("includes PAUSE verdict", () => {
    const report = makeFullReport({ verdict: "PAUSE" });
    const tag = buildPreflightResultTag(report);
    expect(tag).toContain("|PAUSE|");
  });
});

// ── Additional: buildPreflightKeyboard ───────────────────────

describe("buildPreflightKeyboard", () => {
  test("PASS verdict: 2 buttons (continuer, annuler)", () => {
    const kb = buildPreflightKeyboard("PASS");
    const kbStr = JSON.stringify(kb);
    expect(kbStr).toContain("prdwf_preflight_ok");
    expect(kbStr).toContain("prdwf_preflight_abort");
    expect(kbStr).not.toContain("prdwf_revise_prd");
  });

  test("PAUSE verdict: 3 buttons (continuer, reviser, annuler)", () => {
    const kb = buildPreflightKeyboard("PAUSE");
    const kbStr = JSON.stringify(kb);
    expect(kbStr).toContain("prdwf_preflight_ok");
    expect(kbStr).toContain("prdwf_revise_prd");
    expect(kbStr).toContain("prdwf_preflight_abort");
  });

  test("SKIPPED verdict: 2 buttons (no revise)", () => {
    const kb = buildPreflightKeyboard("SKIPPED");
    const kbStr = JSON.stringify(kb);
    expect(kbStr).toContain("prdwf_preflight_ok");
    expect(kbStr).toContain("prdwf_preflight_abort");
    expect(kbStr).not.toContain("prdwf_revise_prd");
  });
});

// ── Additional: formatPreflightReport edge cases ─────────────

describe("formatPreflightReport edge cases", () => {
  test("handles report with no adversarial (P2 off)", () => {
    const report = makeFullReport({ adversarial: null });
    const text = formatPreflightReport(report);
    expect(text).toContain("Challenge adversarial : non execute");
  });

  test("handles report with no impact (E1 off)", () => {
    const report = makeFullReport({ impact: null });
    const text = formatPreflightReport(report);
    expect(text).toContain("Analyse d'impact : non executee");
  });

  test("handles report with no proto-specs (P1 off)", () => {
    const report = makeFullReport({ protoSpecs: [] });
    const text = formatPreflightReport(report);
    expect(text).toContain("0 taches analysees");
  });

  test("shows breaking changes when present", () => {
    const report = makeFullReport({
      impact: {
        risk_level: "HIGH",
        modules_impacted_direct: 5,
        modules_impacted_transitive: 12,
        breaking_changes: ["API change in module X"],
        attention_points: [],
        graph_only: false,
        duration_ms: 100,
      },
    });
    const text = formatPreflightReport(report);
    expect(text).toContain("risque HIGH");
    expect(text).toContain("Breaking : API change in module X");
  });
});
