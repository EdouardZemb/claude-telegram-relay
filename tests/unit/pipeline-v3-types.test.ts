/**
 * Unit Tests — src/pipeline-v3/types.ts
 *
 * V-criteria covered:
 * V1: Type exports exist and are correctly structured
 * V2: createEmptyV3Run creates a valid run with all phases pending
 * V3: Constants QUORUM_THRESHOLD and DEFAULT_MAX_ITERATIONS have correct values
 * V4: V3_ALL_PHASES and V3_PHASE_LABELS are consistent
 */

import { describe, expect, it } from "bun:test";
import {
  ALL_REVIEWER_ROLES,
  createEmptyV3Run,
  DEFAULT_MAX_ITERATIONS,
  type PanelVerdict,
  QUORUM_THRESHOLD,
  type ReviewerFinding,
  V3_ALL_PHASES,
  V3_PHASE_LABELS,
  type V3Run,
} from "../../src/pipeline-v3/types.ts";

describe("pipeline-v3/types", () => {
  describe("constants", () => {
    it("V3: QUORUM_THRESHOLD is 2 (quorum 2/3)", () => {
      expect(QUORUM_THRESHOLD).toBe(2);
    });

    it("V3: DEFAULT_MAX_ITERATIONS is 3 (circuit breaker)", () => {
      expect(DEFAULT_MAX_ITERATIONS).toBe(3);
    });

    it("ALL_REVIEWER_ROLES has 3 roles", () => {
      expect(ALL_REVIEWER_ROLES).toEqual(["security", "performance", "architecture"]);
    });
  });

  describe("V3_ALL_PHASES / V3_PHASE_LABELS", () => {
    it("V4: V3_ALL_PHASES lists all 6 phases", () => {
      expect(V3_ALL_PHASES).toEqual(["bridge", "implement", "review", "fix", "done", "failed"]);
    });

    it("V4: V3_PHASE_LABELS has an entry for every phase", () => {
      for (const phase of V3_ALL_PHASES) {
        expect(V3_PHASE_LABELS[phase]).toBeDefined();
        expect(typeof V3_PHASE_LABELS[phase]).toBe("string");
      }
    });
  });

  describe("createEmptyV3Run", () => {
    it("V2: creates a run with all phases pending", () => {
      const run = createEmptyV3Run("mat-123", "test-pipeline", "/path/to/SPEC-UNIFIEE.md");

      expect(run.maturationRunId).toBe("mat-123");
      expect(run.name).toBe("test-pipeline");
      expect(run.specPath).toBe("/path/to/SPEC-UNIFIEE.md");
      expect(run.currentPhase).toBe("bridge");
      expect(run.iteration).toBe(0);
      expect(run.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
      expect(run.panelHistory).toEqual([]);

      for (const phase of V3_ALL_PHASES) {
        expect(run.steps[phase].phase).toBe(phase);
        expect(run.steps[phase].status).toBe("pending");
      }
    });

    it("V2: generates a unique UUID for each run", () => {
      const run1 = createEmptyV3Run("mat-1", "a", "/a");
      const run2 = createEmptyV3Run("mat-2", "b", "/b");
      expect(run1.id).not.toBe(run2.id);
    });

    it("V2: sets timestamps", () => {
      const before = new Date().toISOString();
      const run = createEmptyV3Run("mat-1", "a", "/a");
      const after = new Date().toISOString();

      expect(run.createdAt >= before).toBe(true);
      expect(run.createdAt <= after).toBe(true);
      expect(run.updatedAt).toBe(run.createdAt);
    });
  });

  describe("type structure (compile-time + runtime shape)", () => {
    it("V1: ReviewerFinding has required fields", () => {
      const finding: ReviewerFinding = {
        role: "security",
        verdict: "APPROVED",
        findings: "No issues found",
        veto: false,
      };
      expect(finding.role).toBe("security");
      expect(finding.verdict).toBe("APPROVED");
      expect(finding.veto).toBe(false);
    });

    it("V1: PanelVerdict has required fields", () => {
      const panel: PanelVerdict = {
        verdict: "APPROVED",
        approvedCount: 3,
        totalResponded: 3,
        vetoed: false,
        findings: [],
        changeRequests: "",
      };
      expect(panel.approvedCount).toBe(3);
      expect(panel.vetoed).toBe(false);
    });

    it("V1: V3Run has required fields", () => {
      const run: V3Run = createEmptyV3Run("mat-1", "test", "/spec.md");
      expect(run.id).toBeDefined();
      expect(run.maturationRunId).toBeDefined();
      expect(run.specPath).toBeDefined();
      expect(run.currentPhase).toBeDefined();
      expect(run.iteration).toBeDefined();
      expect(run.maxIterations).toBeDefined();
      expect(run.steps).toBeDefined();
      expect(run.panelHistory).toBeDefined();
    });
  });
});
