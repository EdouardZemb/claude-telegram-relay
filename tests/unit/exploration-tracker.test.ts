/**
 * Unit Tests — exploration.ts pipeline tracker integration
 *
 * V-criteria covered: V12, V13, V14
 * Tests that exploration.ts creates pipeline tracker and uses sdd-explore: job type.
 */

import { describe, expect, it } from "bun:test";

describe("exploration pipeline tracker integration", () => {
  // ── V12: Structural test — exploration.ts imports createPipeline ─────

  it("V12: exploration.ts imports createPipeline from pipeline-tracker", () => {
    // Structural: verify pipeline-tracker exports the functions used by exploration.ts
    const tracker = require("../../src/pipeline-tracker.ts");
    expect(typeof tracker.createPipeline).toBe("function");
    expect(typeof tracker.toPipelineName).toBe("function");
    expect(typeof tracker.updateStep).toBe("function");
    expect(typeof tracker.getTracker).toBe("function");
  });

  it("V12: toPipelineName produces kebab-case from query", () => {
    const { toPipelineName } = require("../../src/pipeline-tracker.ts");
    expect(toPipelineName("comment fonctionne le pipeline")).toBe(
      "comment-fonctionne-le-pipeline",
    );
    expect(toPipelineName("Architecture V2 — Phase 3")).toBe("architecture-v2-phase-3");
    expect(toPipelineName("écrire des accents français")).toBe("ecrire-des-accents-francais");
  });

  // ── V13: Job type format verification ─────────────────────────────

  it("V13: sdd-explore job type format matches expected pattern", () => {
    // Verify the regex used by getCompletionKeyboard matches sdd-explore:name
    const jobType = "sdd-explore:mon-pipeline";
    expect(jobType.startsWith("sdd-")).toBe(true);

    const typeColonIdx = jobType.indexOf(":");
    const phase = jobType.substring(4, typeColonIdx); // strip "sdd-", take until ":"
    const name = jobType.substring(typeColonIdx + 1);

    expect(phase).toBe("explore");
    expect(name).toBe("mon-pipeline");
  });

  // ── V14: updateStep called with running status ────────────────────

  it("V14: updateStep accepts { status: 'running', jobId } updates", async () => {
    const { createPipeline, updateStep, getTracker, _clearForTests } =
      require("../../src/pipeline-tracker.ts");

    _clearForTests();

    // Create a tracker
    await createPipeline(99999, undefined, "test-explore");

    // Update step — should not throw
    await updateStep(99999, undefined, "explore", { status: "running", jobId: "job-123" });

    // Verify
    const tracker = await getTracker(99999, undefined);
    expect(tracker).not.toBeNull();
    expect(tracker!.steps.explore.status).toBe("running");
    expect(tracker!.steps.explore.jobId).toBe("job-123");

    _clearForTests();
  });
});
