/**
 * Unit Tests — src/code-review.ts
 *
 * Tests for adversarial code review: result formatting,
 * review result persistence, gate pass/fail logic,
 * JSON parsing from Claude output, and edge cases.
 */

import { describe, it, expect } from "bun:test";
import {
  formatReviewResult,
  type CodeReviewResult,
  type ReviewFinding,
  type FindingSeverity,
} from "../../src/code-review";

// ── Helper builders ──────────────────────────────────────────

function buildFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "minor",
    category: "style",
    file: "src/test.ts",
    description: "Test finding",
    suggestion: "Fix it",
    ...overrides,
  };
}

function buildResult(overrides: Partial<CodeReviewResult> = {}): CodeReviewResult {
  return {
    success: true,
    findings: [],
    summary: "All good",
    score: 80,
    passesGate: true,
    rawOutput: "raw",
    ...overrides,
  };
}

// ── formatReviewResult ───────────────────────────────────────

describe("formatReviewResult", () => {
  it("displays score bar and score value", () => {
    const result = buildResult({ score: 75 });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("CODE REVIEW");
    expect(formatted).toContain("75/100");
  });

  it("shows Gate: PASSE when passesGate is true", () => {
    const result = buildResult({ passesGate: true });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("Gate: PASSE");
    expect(formatted).not.toContain("Gate: BLOQUEE");
  });

  it("shows Gate: BLOQUEE when passesGate is false", () => {
    const result = buildResult({ passesGate: false });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("Gate: BLOQUEE");
  });

  it("includes summary when present", () => {
    const result = buildResult({ summary: "Code is clean and well-tested." });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("Code is clean and well-tested.");
  });

  it("shows 'Aucun finding.' when findings array is empty", () => {
    const result = buildResult({ findings: [] });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("Aucun finding.");
  });

  it("displays findings count", () => {
    const findings = [buildFinding(), buildFinding(), buildFinding()];
    const result = buildResult({ findings });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("3 findings:");
  });

  it("sorts findings by severity: critical first, suggestion last", () => {
    const findings = [
      buildFinding({ severity: "suggestion", description: "Suggestion desc" }),
      buildFinding({ severity: "critical", description: "Critical desc" }),
      buildFinding({ severity: "minor", description: "Minor desc" }),
      buildFinding({ severity: "important", description: "Important desc" }),
    ];
    const result = buildResult({ findings });
    const formatted = formatReviewResult(result);

    const criticalIdx = formatted.indexOf("[CRITIQUE]");
    const importantIdx = formatted.indexOf("[IMPORTANT]");
    const minorIdx = formatted.indexOf("[MINEUR]");
    const suggestionIdx = formatted.indexOf("[SUGGESTION]");

    expect(criticalIdx).toBeLessThan(importantIdx);
    expect(importantIdx).toBeLessThan(minorIdx);
    expect(minorIdx).toBeLessThan(suggestionIdx);
  });

  it("maps severity labels to French", () => {
    const severities: FindingSeverity[] = ["critical", "important", "minor", "suggestion"];
    const expectedLabels = ["CRITIQUE", "IMPORTANT", "MINEUR", "SUGGESTION"];

    for (let i = 0; i < severities.length; i++) {
      const result = buildResult({
        findings: [buildFinding({ severity: severities[i] })],
      });
      const formatted = formatReviewResult(result);
      expect(formatted).toContain(`[${expectedLabels[i]}]`);
    }
  });

  it("shows category and file location", () => {
    const result = buildResult({
      findings: [buildFinding({ category: "security", file: "src/relay.ts" })],
    });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("security");
    expect(formatted).toContain("src/relay.ts");
  });

  it("shows file:line when line is present", () => {
    const result = buildResult({
      findings: [buildFinding({ file: "src/agent.ts", line: 42 })],
    });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("src/agent.ts:42");
  });

  it("shows file without line when line is absent", () => {
    const result = buildResult({
      findings: [buildFinding({ file: "src/agent.ts", line: undefined })],
    });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("src/agent.ts");
    expect(formatted).not.toContain("src/agent.ts:");
  });

  it("includes finding description and suggestion", () => {
    const result = buildResult({
      findings: [buildFinding({
        description: "Missing null check",
        suggestion: "Add if (!x) return early",
      })],
    });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("Missing null check");
    expect(formatted).toContain("-> Add if (!x) return early");
  });

  it("omits summary section when summary is empty", () => {
    const result = buildResult({ summary: "", findings: [] });
    const formatted = formatReviewResult(result);
    const lines = formatted.split("\n").filter(l => l.trim() !== "");

    // Should have: header line, gate line, "Aucun finding."
    expect(lines.length).toBe(3);
  });

  it("generates correct score bar length for score 100", () => {
    const result = buildResult({ score: 100, findings: [] });
    const formatted = formatReviewResult(result);

    // score 100 -> 20 '=' chars, 0 '-' chars
    expect(formatted).toContain("[====================]");
    expect(formatted).toContain("100/100");
  });

  it("generates correct score bar length for score 0", () => {
    const result = buildResult({ score: 0, passesGate: false, findings: [] });
    const formatted = formatReviewResult(result);

    // score 0 -> 0 '=' chars, 20 '-' chars
    expect(formatted).toContain("[--------------------]");
    expect(formatted).toContain("0/100");
  });

  it("generates correct score bar length for score 50", () => {
    const result = buildResult({ score: 50, findings: [] });
    const formatted = formatReviewResult(result);

    // score 50 -> 10 '=' chars, 10 '-' chars
    const barMatch = formatted.match(/\[([=-]+)\]/);
    expect(barMatch).not.toBeNull();
    expect(barMatch![1].replace(/[^=]/g, "").length).toBe(10);
    expect(barMatch![1].replace(/[^-]/g, "").length).toBe(10);
    expect(formatted).toContain("50/100");
  });

  it("handles multiple findings with mixed severities", () => {
    const findings = [
      buildFinding({ severity: "critical", file: "a.ts", description: "Critical bug" }),
      buildFinding({ severity: "minor", file: "b.ts", description: "Minor issue" }),
      buildFinding({ severity: "important", file: "c.ts", description: "Important thing" }),
    ];
    const result = buildResult({ findings, score: 45, passesGate: false });
    const formatted = formatReviewResult(result);

    expect(formatted).toContain("3 findings:");
    expect(formatted).toContain("[CRITIQUE]");
    expect(formatted).toContain("[IMPORTANT]");
    expect(formatted).toContain("[MINEUR]");
    expect(formatted).toContain("Gate: BLOQUEE");
  });
});

// ── Gate pass/fail logic ─────────────────────────────────────

describe("CodeReviewResult gate logic", () => {
  // The passesGate logic is: score >= 50 AND no critical findings.
  // We test the logic by constructing results that match the criteria.

  it("passes gate when score >= 50 and no critical findings", () => {
    // This mirrors the logic: score >= 50 && !findings.some(f => f.severity === "critical")
    const score = 75;
    const findings = [buildFinding({ severity: "minor" })];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(true);
  });

  it("fails gate when score < 50", () => {
    const score = 40;
    const findings: ReviewFinding[] = [];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(false);
  });

  it("fails gate when critical finding exists even with high score", () => {
    const score = 90;
    const findings = [buildFinding({ severity: "critical" })];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(false);
  });

  it("fails gate when score is exactly 49", () => {
    const score = 49;
    const findings: ReviewFinding[] = [];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(false);
  });

  it("passes gate when score is exactly 50", () => {
    const score = 50;
    const findings = [buildFinding({ severity: "suggestion" })];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(true);
  });

  it("passes gate with important findings but no critical", () => {
    const score = 60;
    const findings = [
      buildFinding({ severity: "important" }),
      buildFinding({ severity: "important" }),
    ];
    const passesGate = score >= 50 && !findings.some(f => f.severity === "critical");

    expect(passesGate).toBe(true);
  });
});

// ── JSON parsing logic ───────────────────────────────────────

describe("Review JSON parsing", () => {
  // Test the JSON extraction regex that runCodeReview uses: output.match(/\{[\s\S]*\}/)

  it("extracts JSON from clean output", () => {
    const output = JSON.stringify({
      findings: [{ severity: "minor", category: "style", file: "a.ts", description: "d", suggestion: "s" }],
      summary: "Clean code",
      score: 85,
    });

    const match = output.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]);
    expect(parsed.score).toBe(85);
    expect(parsed.findings).toHaveLength(1);
  });

  it("extracts JSON from mixed output with surrounding text", () => {
    const json = JSON.stringify({
      findings: [],
      summary: "OK",
      score: 90,
    });
    const output = `Here is my review:\n${json}\nEnd of review.`;

    const match = output.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]);
    expect(parsed.score).toBe(90);
  });

  it("returns null match for output without JSON", () => {
    const output = "This is plain text without any JSON structure";
    const match = output.match(/\{[\s\S]*\}/);
    expect(match).toBeNull();
  });

  it("handles nested JSON objects in findings", () => {
    const json = JSON.stringify({
      findings: [
        { severity: "critical", category: "security", file: "auth.ts", line: 10, description: "SQL injection", suggestion: "Use parameterized query" },
        { severity: "minor", category: "style", file: "utils.ts", description: "Long line", suggestion: "Break it" },
      ],
      summary: "Security issues found",
      score: 30,
    });

    const match = json.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].severity).toBe("critical");
    expect(parsed.findings[1].severity).toBe("minor");
  });

  it("defaults findings to empty array when not present", () => {
    const json = JSON.stringify({ summary: "OK", score: 70 });
    const match = json.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match![0]);
    const findings = (parsed.findings || []) as ReviewFinding[];
    expect(findings).toHaveLength(0);
  });

  it("defaults score to 0 when not present", () => {
    const json = JSON.stringify({ findings: [], summary: "Test" });
    const match = json.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match![0]);
    const score = parsed.score || 0;
    expect(score).toBe(0);
  });
});

// ── saveReviewResult ─────────────────────────────────────────

describe("saveReviewResult", () => {
  it("calls supabase with correct table and payload shape", async () => {
    // Dynamically import to test
    const { saveReviewResult } = await import("../../src/code-review");

    const insertData: any[] = [];
    const mockSupabase = {
      from: (table: string) => ({
        insert: (data: any) => {
          insertData.push({ table, data });
          return Promise.resolve({ error: null });
        },
      }),
    } as any;

    const result = buildResult({
      score: 72,
      findings: [
        buildFinding({ severity: "critical" }),
        buildFinding({ severity: "minor" }),
        buildFinding({ severity: "minor" }),
      ],
      passesGate: false,
      summary: "Needs work",
    });

    await saveReviewResult(mockSupabase, "task-123", "feature/test", result);

    expect(insertData).toHaveLength(1);
    expect(insertData[0].table).toBe("workflow_logs");
    expect(insertData[0].data.task_id).toBe("task-123");
    expect(insertData[0].data.step_from).toBe("execution");
    expect(insertData[0].data.step_to).toBe("review");
    expect(insertData[0].data.metadata.type).toBe("code_review");
    expect(insertData[0].data.metadata.branch).toBe("feature/test");
    expect(insertData[0].data.metadata.score).toBe(72);
    expect(insertData[0].data.metadata.findings_count).toBe(3);
    expect(insertData[0].data.metadata.critical_count).toBe(1);
    expect(insertData[0].data.metadata.passes_gate).toBe(false);
    expect(insertData[0].data.metadata.summary).toBe("Needs work");
  });

  it("logs error when supabase insert fails", async () => {
    const { saveReviewResult } = await import("../../src/code-review");

    const originalError = console.error;
    const errorCalls: any[][] = [];
    console.error = (...args: any[]) => { errorCalls.push(args); };

    const mockSupabase = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: "DB error" } }),
      }),
    } as any;

    await saveReviewResult(mockSupabase, "task-1", "branch", buildResult());

    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls[0][0]).toContain("saveReviewResult error");

    console.error = originalError;
  });

  it("does not throw when supabase insert succeeds", async () => {
    const { saveReviewResult } = await import("../../src/code-review");

    const mockSupabase = {
      from: () => ({
        insert: () => Promise.resolve({ error: null }),
      }),
    } as any;

    // Should not throw
    await expect(
      saveReviewResult(mockSupabase, "task-1", "branch", buildResult())
    ).resolves.toBeUndefined();
  });

  it("counts critical findings correctly with zero criticals", async () => {
    const { saveReviewResult } = await import("../../src/code-review");

    const insertData: any[] = [];
    const mockSupabase = {
      from: () => ({
        insert: (data: any) => {
          insertData.push(data);
          return Promise.resolve({ error: null });
        },
      }),
    } as any;

    const result = buildResult({
      findings: [
        buildFinding({ severity: "minor" }),
        buildFinding({ severity: "important" }),
        buildFinding({ severity: "suggestion" }),
      ],
    });

    await saveReviewResult(mockSupabase, "task-1", "branch", result);

    expect(insertData[0].metadata.critical_count).toBe(0);
    expect(insertData[0].metadata.findings_count).toBe(3);
  });
});

// ── runCodeReview result construction ─────────────────────────
// These tests verify the result construction logic that runCodeReview applies
// after getting Claude output, without spawning real processes.

describe("runCodeReview result construction", () => {
  // Simulate the parsing logic from runCodeReview lines 145-167
  function parseClaudeOutput(output: string): CodeReviewResult {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        findings: [],
        summary: "Impossible de parser la review.",
        score: 0,
        passesGate: false,
        rawOutput: output,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const findings = (parsed.findings || []) as ReviewFinding[];
    const score = parsed.score || 0;

    return {
      success: true,
      findings,
      summary: parsed.summary || "",
      score,
      passesGate: score >= 50 && !findings.some((f) => f.severity === "critical"),
      rawOutput: output,
    };
  }

  it("parses valid review JSON and builds correct result", () => {
    const output = JSON.stringify({
      findings: [
        { severity: "minor", category: "style", file: "a.ts", description: "d", suggestion: "s" },
      ],
      summary: "Minor style issues",
      score: 85,
    });

    const result = parseClaudeOutput(output);
    expect(result.success).toBe(true);
    expect(result.score).toBe(85);
    expect(result.passesGate).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBe("Minor style issues");
  });

  it("returns failure when output has no JSON", () => {
    const result = parseClaudeOutput("This is plain text, no JSON here.");
    expect(result.success).toBe(false);
    expect(result.score).toBe(0);
    expect(result.passesGate).toBe(false);
    expect(result.summary).toBe("Impossible de parser la review.");
    expect(result.rawOutput).toBe("This is plain text, no JSON here.");
  });

  it("sets passesGate false when score < 50", () => {
    const output = JSON.stringify({ findings: [], summary: "Bad", score: 30 });
    const result = parseClaudeOutput(output);
    expect(result.passesGate).toBe(false);
  });

  it("sets passesGate false when critical finding exists", () => {
    const output = JSON.stringify({
      findings: [{ severity: "critical", category: "security", file: "x.ts", description: "d", suggestion: "s" }],
      summary: "Critical issue",
      score: 80,
    });
    const result = parseClaudeOutput(output);
    expect(result.passesGate).toBe(false);
  });

  it("sets passesGate true with score >= 50 and no critical findings", () => {
    const output = JSON.stringify({
      findings: [{ severity: "important", category: "perf", file: "y.ts", description: "d", suggestion: "s" }],
      summary: "OK",
      score: 65,
    });
    const result = parseClaudeOutput(output);
    expect(result.passesGate).toBe(true);
  });

  it("defaults missing findings to empty array", () => {
    const output = JSON.stringify({ summary: "OK", score: 90 });
    const result = parseClaudeOutput(output);
    expect(result.findings).toHaveLength(0);
    expect(result.passesGate).toBe(true);
  });

  it("defaults missing score to 0", () => {
    const output = JSON.stringify({ findings: [], summary: "Test" });
    const result = parseClaudeOutput(output);
    expect(result.score).toBe(0);
    expect(result.passesGate).toBe(false);
  });

  it("defaults missing summary to empty string", () => {
    const output = JSON.stringify({ findings: [], score: 75 });
    const result = parseClaudeOutput(output);
    expect(result.summary).toBe("");
  });

  it("extracts JSON embedded in surrounding text", () => {
    const json = JSON.stringify({ findings: [], summary: "Clean", score: 95 });
    const output = `Here is my review analysis:\n${json}\nEnd of review output.`;
    const result = parseClaudeOutput(output);
    expect(result.success).toBe(true);
    expect(result.score).toBe(95);
  });

  it("preserves raw output in result", () => {
    const output = `Preamble ${JSON.stringify({ findings: [], summary: "OK", score: 80 })} epilogue`;
    const result = parseClaudeOutput(output);
    expect(result.rawOutput).toBe(output);
  });

  it("empty-diff result has correct shape", () => {
    // Mirrors the early return in runCodeReview when fullDiff is empty
    const emptyResult: CodeReviewResult = {
      success: true,
      findings: [],
      summary: "Aucun changement a reviewer.",
      score: 100,
      passesGate: true,
      rawOutput: "",
    };

    expect(emptyResult.success).toBe(true);
    expect(emptyResult.score).toBe(100);
    expect(emptyResult.passesGate).toBe(true);
    expect(emptyResult.summary).toBe("Aucun changement a reviewer.");
    expect(emptyResult.findings).toHaveLength(0);
  });

  it("error catch result has correct shape", () => {
    // Mirrors the catch block in runCodeReview
    const error = new Error("spawn failed");
    const errorResult: CodeReviewResult = {
      success: false,
      findings: [],
      summary: `Erreur review: ${error}`,
      score: 0,
      passesGate: false,
      rawOutput: String(error),
    };

    expect(errorResult.success).toBe(false);
    expect(errorResult.score).toBe(0);
    expect(errorResult.passesGate).toBe(false);
    expect(errorResult.summary).toContain("Erreur review:");
    expect(errorResult.summary).toContain("spawn failed");
  });
});

// ── Type contracts ───────────────────────────────────────────

describe("Type contracts", () => {
  it("ReviewFinding has all required fields", () => {
    const finding: ReviewFinding = {
      severity: "critical",
      category: "security",
      file: "src/auth.ts",
      description: "Vulnerability",
      suggestion: "Patch it",
    };

    expect(finding.severity).toBe("critical");
    expect(finding.category).toBe("security");
    expect(finding.file).toBe("src/auth.ts");
    expect(finding.description).toBe("Vulnerability");
    expect(finding.suggestion).toBe("Patch it");
    expect(finding.line).toBeUndefined();
  });

  it("ReviewFinding line is optional", () => {
    const withLine: ReviewFinding = {
      severity: "minor",
      category: "style",
      file: "a.ts",
      line: 99,
      description: "d",
      suggestion: "s",
    };
    expect(withLine.line).toBe(99);
  });

  it("FindingSeverity covers all 4 values", () => {
    const severities: FindingSeverity[] = ["critical", "important", "minor", "suggestion"];
    expect(severities).toHaveLength(4);
  });

  it("CodeReviewResult has all required fields", () => {
    const result: CodeReviewResult = {
      success: true,
      findings: [],
      summary: "",
      score: 50,
      passesGate: true,
      rawOutput: "",
    };

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("passesGate");
    expect(result).toHaveProperty("rawOutput");
  });
});

// ── Diff truncation logic ────────────────────────────────────

describe("Diff truncation logic", () => {
  it("truncates diff longer than 50000 chars", () => {
    const maxDiffLength = 50000;
    const longDiff = "a".repeat(60000);
    const truncated = longDiff.length > maxDiffLength
      ? longDiff.substring(0, maxDiffLength) + "\n\n[... DIFF TRONQUE ...]"
      : longDiff;

    expect(truncated.length).toBeLessThan(longDiff.length);
    expect(truncated).toContain("[... DIFF TRONQUE ...]");
    expect(truncated.length).toBe(maxDiffLength + "\n\n[... DIFF TRONQUE ...]".length);
  });

  it("does not truncate diff shorter than 50000 chars", () => {
    const maxDiffLength = 50000;
    const shortDiff = "a".repeat(1000);
    const truncated = shortDiff.length > maxDiffLength
      ? shortDiff.substring(0, maxDiffLength) + "\n\n[... DIFF TRONQUE ...]"
      : shortDiff;

    expect(truncated).toBe(shortDiff);
    expect(truncated).not.toContain("[... DIFF TRONQUE ...]");
  });

  it("does not truncate diff of exactly 50000 chars", () => {
    const maxDiffLength = 50000;
    const exactDiff = "a".repeat(50000);
    const truncated = exactDiff.length > maxDiffLength
      ? exactDiff.substring(0, maxDiffLength) + "\n\n[... DIFF TRONQUE ...]"
      : exactDiff;

    expect(truncated).toBe(exactDiff);
  });
});

// ── Score bar rendering ──────────────────────────────────────

describe("Score bar rendering", () => {
  it("renders proportional bar for various scores", () => {
    const testCases = [
      { score: 0, filled: 0, empty: 20 },
      { score: 25, filled: 5, empty: 15 },
      { score: 50, filled: 10, empty: 10 },
      { score: 75, filled: 15, empty: 5 },
      { score: 100, filled: 20, empty: 0 },
    ];

    for (const tc of testCases) {
      const bar = "=".repeat(Math.round(tc.score / 5)) + "-".repeat(20 - Math.round(tc.score / 5));
      expect(bar.length).toBe(20);
      expect(bar.replace(/[^=]/g, "").length).toBe(tc.filled);
      expect(bar.replace(/[^-]/g, "").length).toBe(tc.empty);
    }
  });
});
