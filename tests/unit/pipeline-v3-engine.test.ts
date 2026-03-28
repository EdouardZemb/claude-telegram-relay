/**
 * Unit Tests — src/pipeline-v3/engine.ts
 *
 * V-criteria covered:
 * V1: bridge -> implement transition
 * V2: implement -> review transition
 * V3: review -> done when APPROVED
 * V4: review -> fix when CHANGES_REQUESTED (iterations left)
 * V5: review -> failed when circuit breaker trips
 * V6: fix -> implement (loop back, iteration increment)
 * V7: done/failed are terminal (return null)
 * V8: handleV3PhaseResult updates step status and timestamps
 * V9: handleV3PhaseResult records panel verdict in history
 * V10: handleV3PhaseResult resets steps on loop-back
 * V11: Circuit breaker sets finalStatus to "circuit_breaker"
 * V12: APPROVED sets finalStatus to "merged"
 */

import { describe, expect, it } from "bun:test";
import { getNextV3Phase, handleV3PhaseResult } from "../../src/pipeline-v3/engine.ts";
import { createEmptyV3Run, type PanelVerdict, type V3Run } from "../../src/pipeline-v3/types.ts";

function makeApprovedPanel(): PanelVerdict {
  return {
    verdict: "APPROVED",
    approvedCount: 3,
    totalResponded: 3,
    vetoed: false,
    findings: [],
    changeRequests: "",
  };
}

function makeRejectedPanel(): PanelVerdict {
  return {
    verdict: "CHANGES_REQUESTED",
    approvedCount: 1,
    totalResponded: 3,
    vetoed: false,
    findings: [],
    changeRequests: "Fix the bugs",
  };
}

describe("pipeline-v3/engine", () => {
  // ── getNextV3Phase ──────────────────────────────────────────

  describe("getNextV3Phase", () => {
    it("V1: bridge -> implement", () => {
      expect(getNextV3Phase("bridge", {})).toBe("implement");
    });

    it("V2: implement -> review", () => {
      expect(getNextV3Phase("implement", {})).toBe("review");
    });

    it("V3: review -> done when APPROVED", () => {
      expect(getNextV3Phase("review", { panelVerdict: makeApprovedPanel() })).toBe("done");
    });

    it("V4: review -> fix when CHANGES_REQUESTED with iterations left", () => {
      expect(
        getNextV3Phase("review", {
          panelVerdict: makeRejectedPanel(),
          iteration: 0,
          maxIterations: 3,
        }),
      ).toBe("fix");
    });

    it("V4: review -> fix on second iteration", () => {
      expect(
        getNextV3Phase("review", {
          panelVerdict: makeRejectedPanel(),
          iteration: 1,
          maxIterations: 3,
        }),
      ).toBe("fix");
    });

    it("V5: review -> failed when circuit breaker trips (last iteration)", () => {
      expect(
        getNextV3Phase("review", {
          panelVerdict: makeRejectedPanel(),
          iteration: 2,
          maxIterations: 3,
        }),
      ).toBe("failed");
    });

    it("V6: fix -> implement (loop back)", () => {
      expect(getNextV3Phase("fix", {})).toBe("implement");
    });

    it("V7: done is terminal", () => {
      expect(getNextV3Phase("done", {})).toBeNull();
    });

    it("V7: failed is terminal", () => {
      expect(getNextV3Phase("failed", {})).toBeNull();
    });

    it("V3: review with no panel verdict defaults to CHANGES_REQUESTED", () => {
      // undefined panelVerdict -> verdict is undefined, not "APPROVED"
      expect(getNextV3Phase("review", { iteration: 0, maxIterations: 3 })).toBe("fix");
    });
  });

  // ── handleV3PhaseResult ─────────────────────────────────────

  describe("handleV3PhaseResult", () => {
    let run: V3Run;

    function freshRun(): V3Run {
      return createEmptyV3Run("mat-1", "test", "/spec.md");
    }

    it("V8: updates step status and timestamps on success", () => {
      run = freshRun();
      run.currentPhase = "bridge";
      const before = new Date().toISOString();

      const updated = handleV3PhaseResult(run, "bridge", {
        status: "ok",
        result: "Bridge complete",
      });

      expect(updated.steps.bridge.status).toBe("ok");
      expect(updated.steps.bridge.result).toBe("Bridge complete");
      expect(updated.steps.bridge.completedAt).toBeDefined();
      expect(updated.steps.bridge.completedAt! >= before).toBe(true);
      expect(updated.currentPhase).toBe("implement");
    });

    it("V8: updates step to failed and sets currentPhase to failed", () => {
      run = freshRun();
      run.currentPhase = "implement";

      const updated = handleV3PhaseResult(run, "implement", {
        status: "failed",
        result: "spawn error",
      });

      expect(updated.steps.implement.status).toBe("failed");
      expect(updated.currentPhase).toBe("failed");
      expect(updated.finalStatus).toBe("failed");
    });

    it("V9: records panel verdict in history after review", () => {
      run = freshRun();
      run.currentPhase = "review";
      const panel = makeApprovedPanel();

      const updated = handleV3PhaseResult(run, "review", {
        status: "ok",
        panelVerdict: panel,
      });

      expect(updated.panelHistory.length).toBe(1);
      expect(updated.panelHistory[0].verdict).toBe("APPROVED");
    });

    it("V12: APPROVED panel moves to done with finalStatus merged", () => {
      run = freshRun();
      run.currentPhase = "review";

      const updated = handleV3PhaseResult(run, "review", {
        status: "ok",
        panelVerdict: makeApprovedPanel(),
      });

      expect(updated.currentPhase).toBe("done");
      expect(updated.finalStatus).toBe("merged");
    });

    it("V4: CHANGES_REQUESTED moves to fix", () => {
      run = freshRun();
      run.currentPhase = "review";
      run.iteration = 0;

      const updated = handleV3PhaseResult(run, "review", {
        status: "ok",
        panelVerdict: makeRejectedPanel(),
      });

      expect(updated.currentPhase).toBe("fix");
    });

    it("V10: fix -> implement resets steps and increments iteration", () => {
      run = freshRun();
      run.currentPhase = "fix";
      run.iteration = 0;
      run.steps.implement.status = "ok";
      run.steps.implement.startedAt = "2025-01-01T00:00:00Z";
      run.steps.implement.completedAt = "2025-01-01T00:05:00Z";
      run.steps.review.status = "ok";

      const updated = handleV3PhaseResult(run, "fix", {
        status: "ok",
        result: "Fixes applied",
      });

      expect(updated.currentPhase).toBe("implement");
      expect(updated.iteration).toBe(1);
      expect(updated.steps.implement.status).toBe("pending");
      expect(updated.steps.implement.startedAt).toBeUndefined();
      expect(updated.steps.implement.completedAt).toBeUndefined();
      expect(updated.steps.review.status).toBe("pending");
    });

    it("V11: circuit breaker sets finalStatus to circuit_breaker", () => {
      run = freshRun();
      run.currentPhase = "review";
      run.iteration = 2;
      run.maxIterations = 3;

      const updated = handleV3PhaseResult(run, "review", {
        status: "ok",
        panelVerdict: makeRejectedPanel(),
      });

      expect(updated.currentPhase).toBe("failed");
      expect(updated.finalStatus).toBe("circuit_breaker");
    });

    it("V9: multiple review iterations accumulate panel history", () => {
      run = freshRun();
      run.currentPhase = "review";

      // First review
      let updated = handleV3PhaseResult(run, "review", {
        status: "ok",
        panelVerdict: makeRejectedPanel(),
      });
      expect(updated.panelHistory.length).toBe(1);

      // Simulate fix and loop
      updated.currentPhase = "review";
      updated.iteration = 1;

      // Second review
      updated = handleV3PhaseResult(updated, "review", {
        status: "ok",
        panelVerdict: makeApprovedPanel(),
      });
      expect(updated.panelHistory.length).toBe(2);
      expect(updated.panelHistory[0].verdict).toBe("CHANGES_REQUESTED");
      expect(updated.panelHistory[1].verdict).toBe("APPROVED");
    });
  });
});
