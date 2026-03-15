/**
 * Unit Tests — src/adversarial-verifier.ts (S24 T5)
 *
 * Tests for drift report parsing, normalization,
 * QUICK pipeline skip, and formatting.
 */

import { describe, it, expect } from "bun:test";
import {
  parseDriftReport,
  formatDriftReport,
  verifySpecVsImplementation,
  type DriftReport,
} from "../../src/adversarial-verifier";

// ── parseDriftReport ─────────────────────────────────────────

describe("parseDriftReport", () => {
  it("parses valid JSON drift report (AC-015)", () => {
    const output = JSON.stringify({
      coverage_score: 85,
      drift_items: [
        { fr_id: "FR-001", status: "implemented", details: "Fully done" },
        { fr_id: "FR-002", status: "partial", details: "Missing edge case" },
      ],
      overall_verdict: "pass",
    });

    const report = parseDriftReport(output);

    expect(report.coverage_score).toBe(85);
    expect(report.drift_items).toHaveLength(2);
    expect(report.drift_items[0].fr_id).toBe("FR-001");
    expect(report.drift_items[0].status).toBe("implemented");
    expect(report.drift_items[1].status).toBe("partial");
    expect(report.overall_verdict).toBe("pass");
  });

  it("extracts JSON from mixed output", () => {
    const output = `Here is my analysis:
${JSON.stringify({
  coverage_score: 60,
  drift_items: [{ fr_id: "FR-001", status: "missing", details: "Not found" }],
  overall_verdict: "warning",
})}
End of report.`;

    const report = parseDriftReport(output);
    expect(report.coverage_score).toBe(60);
    expect(report.drift_items).toHaveLength(1);
    expect(report.overall_verdict).toBe("warning");
  });

  it("handles unparseable output gracefully", () => {
    const report = parseDriftReport("This is not JSON");

    expect(report.coverage_score).toBe(50);
    expect(report.drift_items).toHaveLength(0);
    expect(report.overall_verdict).toBe("warning");
  });

  it("clamps coverage score to 0-100", () => {
    const report = parseDriftReport(JSON.stringify({
      coverage_score: 200,
      drift_items: [],
      overall_verdict: "pass",
    }));

    expect(report.coverage_score).toBe(100);
  });

  it("normalizes invalid status values", () => {
    const report = parseDriftReport(JSON.stringify({
      coverage_score: 50,
      drift_items: [{ fr_id: "FR-001", status: "unknown", details: "Test" }],
      overall_verdict: "pass",
    }));

    expect(report.drift_items[0].status).toBe("partial"); // normalized
  });

  it("infers verdict from coverage when not provided", () => {
    const report = parseDriftReport(JSON.stringify({
      coverage_score: 90,
      drift_items: [],
    }));
    expect(report.overall_verdict).toBe("pass"); // 90 >= 80

    const report2 = parseDriftReport(JSON.stringify({
      coverage_score: 30,
      drift_items: [],
    }));
    expect(report2.overall_verdict).toBe("fail"); // 30 < 50
  });
});

// ── verifySpecVsImplementation ───────────────────────────────

describe("verifySpecVsImplementation", () => {
  it("skips on QUICK pipeline (EC-006)", async () => {
    const result = await verifySpecVsImplementation(
      { requirements: ["FR-001"] },
      { files: ["test.ts"] },
      "QUICK"
    );

    expect(result).toBeNull();
  });

  it("skips on lowercase quick pipeline", async () => {
    const result = await verifySpecVsImplementation(
      { requirements: ["FR-001"] },
      { files: ["test.ts"] },
      "quick"
    );

    expect(result).toBeNull();
  });

  it("returns warning for null spec", async () => {
    const result = await verifySpecVsImplementation(null, { files: ["test.ts"] });

    expect(result).not.toBeNull();
    expect(result!.coverage_score).toBe(0);
    expect(result!.overall_verdict).toBe("warning");
  });

  it("returns warning for null implementation", async () => {
    const result = await verifySpecVsImplementation({ spec: true }, null);

    expect(result).not.toBeNull();
    expect(result!.coverage_score).toBe(0);
    expect(result!.overall_verdict).toBe("warning");
  });
});

// ── formatDriftReport ────────────────────────────────────────

describe("formatDriftReport", () => {
  it("formats a drift report for display", () => {
    const report: DriftReport = {
      coverage_score: 75,
      drift_items: [
        { fr_id: "FR-001", status: "implemented", details: "Done" },
        { fr_id: "FR-002", status: "missing", details: "Not implemented" },
        { fr_id: "FR-003", status: "divergent", details: "Different approach" },
      ],
      overall_verdict: "warning",
    };

    const formatted = formatDriftReport(report);

    expect(formatted).toContain("ADVERSARIAL VERIFICATION");
    expect(formatted).toContain("75%");
    expect(formatted).toContain("WARNING");
    expect(formatted).toContain("FR-001");
    expect(formatted).toContain("FR-002");
    expect(formatted).toContain("FR-003");
  });

  it("handles null report (QUICK skip)", () => {
    const formatted = formatDriftReport(null);
    expect(formatted).toContain("skipped");
  });

  it("formats report with no drift items", () => {
    const report: DriftReport = {
      coverage_score: 100,
      drift_items: [],
      overall_verdict: "pass",
    };

    const formatted = formatDriftReport(report);
    expect(formatted).toContain("100%");
    expect(formatted).toContain("PASS");
  });
});
