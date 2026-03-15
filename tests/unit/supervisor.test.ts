/**
 * Unit Tests — src/supervisor.ts (S25 T4)
 *
 * Tests for deterministic TypeScript supervisor.
 */

import { describe, it, expect } from "bun:test";
import { Supervisor } from "../../src/supervisor";
import type { AgentStepResult } from "../../src/orchestrator";

function makeResult(
  agentId: string,
  success: boolean,
  durationMs: number = 100
): AgentStepResult {
  return {
    agentId: agentId as any,
    agentName: agentId,
    success,
    output: `output of ${agentId}`,
    structured: null,
    durationMs,
    error: success ? undefined : `${agentId} failed`,
  };
}

describe("Supervisor", () => {
  it("tracks all agent statuses (AC-012)", () => {
    const sup = new Supervisor();
    sup.register("analyst", "analyst");
    sup.register("pm", "pm");
    sup.register("dev", "dev");

    const statuses = sup.getAllStatuses();
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s.status === "pending")).toBe(true);
  });

  it("retry with failure context (AC-013)", () => {
    const sup = new Supervisor({ maxAttempts: 3 });
    sup.register("dev", "dev");
    sup.startPipeline();

    sup.markStarted("dev");
    sup.markCompleted("dev", makeResult("dev", false));

    // First failure: should retry (attempts=1, max=3)
    const decision = sup.decide("dev");
    expect(decision).toBe("retry");

    const status = sup.getStatus("dev");
    expect(status?.status).toBe("retrying");
    expect(status?.attempts).toBe(1);
  });

  it("escalate after exhausted retries for critical agent (AC-014)", () => {
    const sup = new Supervisor({ maxAttempts: 2 });
    sup.register("dev", "dev");
    sup.startPipeline();

    // Attempt 1
    sup.markStarted("dev");
    sup.markCompleted("dev", makeResult("dev", false));
    expect(sup.decide("dev")).toBe("retry");

    // Attempt 2
    sup.markStarted("dev");
    sup.markCompleted("dev", makeResult("dev", false));

    // Exhausted: dev is critical -> escalate
    expect(sup.decide("dev")).toBe("escalate");
  });

  it("skip non-critical agent after exhausted retries (AC-014)", () => {
    const sup = new Supervisor({ maxAttempts: 1 });
    sup.register("analyst", "analyst");
    sup.startPipeline();

    sup.markStarted("analyst");
    sup.markCompleted("analyst", makeResult("analyst", false));

    // analyst is non-critical -> skip
    expect(sup.decide("analyst")).toBe("skip");

    const status = sup.getStatus("analyst");
    expect(status?.status).toBe("skipped");
  });

  it("produces structured summary report (AC-015)", () => {
    const sup = new Supervisor({ maxAttempts: 2 });
    sup.register("analyst", "analyst");
    sup.register("dev", "dev");
    sup.register("qa", "qa");
    sup.startPipeline();

    sup.markStarted("analyst");
    sup.markCompleted("analyst", makeResult("analyst", true, 200));

    sup.markStarted("dev");
    sup.markCompleted("dev", makeResult("dev", true, 500));

    sup.markStarted("qa");
    sup.markCompleted("qa", makeResult("qa", true, 300));

    const report = sup.generateReport();

    expect(report.succeeded).toHaveLength(3);
    expect(report.failed).toHaveLength(0);
    expect(report.sequential_equivalent_ms).toBe(1000); // 200+500+300
    expect(report.speedup_ratio).toBeGreaterThan(0);
    expect(report.per_agent_timing).toHaveLength(3);
  });

  it("timeout detection (EC-004)", () => {
    const sup = new Supervisor({ timeoutMs: 50 });
    sup.register("dev", "dev");
    sup.startPipeline();

    sup.markStarted("dev");

    // Not timed out yet
    expect(sup.isTimedOut("dev")).toBe(false);

    // Force the start time to be in the past
    const status = sup.getStatus("dev")!;
    status.startedAt = Date.now() - 100;

    expect(sup.isTimedOut("dev")).toBe(true);

    sup.markTimedOut("dev");
    expect(sup.getStatus("dev")?.status).toBe("timed_out");
    expect(sup.getStatus("dev")?.error).toContain("Timeout");
  });

  it("report includes speedup_ratio and per_agent_timing", () => {
    const sup = new Supervisor();
    sup.register("analyst", "analyst");
    sup.register("pm", "pm");
    sup.startPipeline();

    sup.markStarted("analyst");
    sup.markCompleted("analyst", makeResult("analyst", true, 100));

    sup.markStarted("pm");
    sup.markCompleted("pm", makeResult("pm", true, 100));

    const report = sup.generateReport();

    expect(report.per_agent_timing).toHaveLength(2);
    expect(report.per_agent_timing[0].agent).toBeDefined();
    expect(report.per_agent_timing[0].durationMs).toBe(100);
    expect(report.speedup_ratio).toBeGreaterThan(0);
  });
});
