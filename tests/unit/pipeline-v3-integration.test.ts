/**
 * Unit Tests — V3 pipeline integration with maturation and feature flag
 *
 * V-criteria covered:
 * V1: pipeline_v3 feature flag exists and defaults to false
 * V2: V3 barrel re-exports are accessible
 * V3: V3 pipeline end-to-end reflective loop with circuit breaker
 * V4: V3 pipeline happy path from SPEC-UNIFIEE to merged
 */

import { afterEach, describe, expect, it } from "bun:test";
import { _resetForTesting, isFeatureEnabled, loadDefaults } from "../../src/feature-flags.ts";
import {
  _setReadFileHookForTests,
  _setReviewPanelHookForTests,
  _setSpawnHookForTests,
  runV3Pipeline,
} from "../../src/pipeline-v3/orchestrator.ts";
import type { PanelVerdict } from "../../src/pipeline-v3/types.ts";

// Import from barrel to test re-exports
import {
  ALL_REVIEWER_ROLES,
  computePanelVerdict,
  createEmptyV3Run,
  DEFAULT_MAX_ITERATIONS,
  extractReviewerVerdict,
  getNextV3Phase,
  QUORUM_THRESHOLD,
  V3_ALL_PHASES,
} from "../../src/pipeline-v3.ts";

describe("pipeline-v3/integration", () => {
  afterEach(() => {
    _resetForTesting();
    _setSpawnHookForTests(undefined);
    _setReadFileHookForTests(undefined);
    _setReviewPanelHookForTests(undefined);
  });

  describe("feature flag", () => {
    it("V1: pipeline_v3 flag exists in defaults and is false", () => {
      const defaults = loadDefaults();
      expect(defaults.pipeline_v3).toBe(false);
    });

    it("V1: isFeatureEnabled returns false for pipeline_v3 by default", () => {
      _resetForTesting();
      expect(isFeatureEnabled("pipeline_v3")).toBe(false);
    });
  });

  describe("barrel re-exports", () => {
    it("V2: all key exports are accessible from barrel", () => {
      expect(typeof createEmptyV3Run).toBe("function");
      expect(typeof getNextV3Phase).toBe("function");
      expect(typeof computePanelVerdict).toBe("function");
      expect(typeof extractReviewerVerdict).toBe("function");
      expect(typeof runV3Pipeline).toBe("function");
      expect(DEFAULT_MAX_ITERATIONS).toBe(3);
      expect(QUORUM_THRESHOLD).toBe(2);
      expect(ALL_REVIEWER_ROLES.length).toBe(3);
      expect(V3_ALL_PHASES.length).toBe(6);
    });
  });

  describe("end-to-end", () => {
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

    it("V4: full pipeline from spec to merged", async () => {
      _setReadFileHookForTests(async () => "# SPEC-UNIFIEE\n\nImplementer le module X");

      _setSpawnHookForTests(async () => ({
        stdout: "Implementation complete.\nhttps://github.com/test/repo/pull/100",
        stderr: "",
        exitCode: 0,
      }));

      _setReviewPanelHookForTests(async () => makeApprovedPanel());

      const progress: string[] = [];
      const { result, run } = await runV3Pipeline(
        "maturation-run-id",
        "test-e2e",
        "/path/to/SPEC-UNIFIEE.md",
        async (msg) => progress.push(msg),
      );

      expect(result).toContain("V3_DONE:test-e2e");
      expect(run.maturationRunId).toBe("maturation-run-id");
      expect(run.finalStatus).toBe("merged");
      expect(run.prUrl).toBe("https://github.com/test/repo/pull/100");
      expect(run.panelHistory.length).toBe(1);
      expect(progress.length).toBeGreaterThan(0);
    });

    it("V3: circuit breaker triggers after 3 rejections", async () => {
      _setReadFileHookForTests(async () => "# SPEC");

      _setSpawnHookForTests(async () => ({
        stdout: "Some code.\nhttps://github.com/test/repo/pull/1",
        stderr: "",
        exitCode: 0,
      }));

      _setReviewPanelHookForTests(async () => ({
        verdict: "CHANGES_REQUESTED" as const,
        approvedCount: 0,
        totalResponded: 3,
        vetoed: false,
        findings: [],
        changeRequests: "Everything is wrong",
      }));

      const { result, run } = await runV3Pipeline("mat-1", "stuck", "/spec.md", async () => {});

      expect(result).toContain("V3_CIRCUIT_BREAKER:stuck");
      expect(run.finalStatus).toBe("circuit_breaker");
      expect(run.panelHistory.length).toBe(3);
    });
  });
});
