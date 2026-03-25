/**
 * Generated tests — SPEC-modes-de-mise-en-page-telegram-html-markdown
 *
 * V10: formatMetrics returns <b>Metriques Sprint S23</b> as title
 * V11: formatMetricsComparison returns <b>Evolution des sprints</b>
 * V16: formatRetro is NOT sent via sendResponseHtml (invariant LLM)
 * V18: CLAUDE.md rule distinguishes LLM responses and bot-side formatting
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";

describe("HTML formatting migration — quality.ts", () => {
  // V10: formatMetrics uses HTML bold for title
  it("V10: formatMetrics source uses <b>Metriques Sprint ...<b> pattern", () => {
    const source = readFileSync("src/commands/quality.ts", "utf-8");
    expect(source).toContain("<b>Metriques Sprint");
  });

  // V11: formatMetricsComparison uses HTML bold for header
  it("V11: formatMetricsComparison source uses <b>Evolution des sprints</b>", () => {
    const source = readFileSync("src/commands/quality.ts", "utf-8");
    expect(source).toContain("<b>Evolution des sprints</b>");
  });

  // V16: formatRetro is NOT sent via sendResponseHtml (invariant LLM — R2)
  it("V16: formatRetro is never sent via sendResponseHtml", () => {
    const source = readFileSync("src/commands/quality.ts", "utf-8");
    // sendResponseHtml must not appear in proximity to formatRetro
    const htmlCalls = [...source.matchAll(/sendResponseHtml\s*\([^)]+formatRetro/g)];
    expect(htmlCalls).toHaveLength(0);
  });
});

describe("HTML formatting migration — tasks.ts", () => {
  // V1: formatBacklog uses <b> for section headers
  it("V1: formatBacklog source uses <b> HTML tags for section headers", () => {
    const source = readFileSync("src/tasks.ts", "utf-8");
    // The source contains template literal with <b>${sectionNames[...]} pattern
    expect(source).toContain("<b>${sectionNames[status]}</b>");
  });

  // V5: formatSprintSummary uses <b>Sprint ...
  it("V5: formatSprintSummary source uses <b>Sprint HTML tag", () => {
    const source = readFileSync("src/tasks.ts", "utf-8");
    expect(source).toContain("<b>Sprint ");
  });
});

describe("HTML formatting migration — pipeline-tracker.ts", () => {
  // V6: formatStatusBar uses <b>Pipeline ...
  it("V6: formatStatusBar source uses <b>Pipeline", () => {
    const source = readFileSync("src/pipeline-tracker.ts", "utf-8");
    expect(source).toContain("<b>Pipeline");
  });

  // V7: formatStatusBar uses <code> for artifact
  it("V7: formatStatusBar source uses <code> for shortArtifact", () => {
    const source = readFileSync("src/pipeline-tracker.ts", "utf-8");
    expect(source).toContain("<code>");
  });
});

describe("HTML formatting migration — CLAUDE.md R8", () => {
  // V18: CLAUDE.md distinguishes LLM responses and bot-side formatting
  it("V18: CLAUDE.md contains updated formatting rule with LLM vs bot-side distinction", () => {
    const source = readFileSync("CLAUDE.md", "utf-8");
    expect(source).toContain("LLM responses");
    expect(source).toContain("sendResponseHtml");
    expect(source).toContain("escapeHtml");
  });
});

describe("escapeHtml — html-utils.ts", () => {
  it("html-utils.ts exports escapeHtml function", () => {
    const source = readFileSync("src/html-utils.ts", "utf-8");
    expect(source).toContain("export function escapeHtml");
  });

  it("escapeHtml escapes & < > \" '", () => {
    // Import via require to avoid TS issues in test
    const mod = require("../../src/html-utils.ts");
    expect(mod.escapeHtml("a & b")).toBe("a &amp; b");
    expect(mod.escapeHtml("a < b")).toBe("a &lt; b");
    expect(mod.escapeHtml("a > b")).toBe("a &gt; b");
    expect(mod.escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
    expect(mod.escapeHtml("it's")).toBe("it&#39;s");
  });
});
