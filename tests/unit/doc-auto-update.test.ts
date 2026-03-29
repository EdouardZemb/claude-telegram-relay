/**
 * @module doc-auto-update.test
 * @description Unit tests for the doc-auto-update 3-tier classification system.
 * Covers tier classification, trigger detection, plan building, and constants.
 */

import { describe, expect, test } from "bun:test";
import {
  buildBranchName,
  buildDocUpdatePlan,
  classifyDoc,
  DOC_UPDATE_RULES,
  SKIP_CI_SUFFIX,
  shouldTriggerUpdate,
  TIER3_PATTERNS,
  tierLabel,
} from "../../src/doc-auto-update.ts";

describe("classifyDoc — Tier 1 (auto-merge)", () => {
  test("README.md", () => expect(classifyDoc("README.md")).toBe(1));
  test("CHANGELOG.md", () => expect(classifyDoc("CHANGELOG.md")).toBe(1));
  test("docs/WORKFLOW-DEV.md", () => expect(classifyDoc("docs/WORKFLOW-DEV.md")).toBe(1));
  test("docs/WORKFLOW-PIPELINE.md", () => expect(classifyDoc("docs/WORKFLOW-PIPELINE.md")).toBe(1));
  test("docs/SETUP.md", () => expect(classifyDoc("docs/SETUP.md")).toBe(1));
  test("docs/dashboard.md", () => expect(classifyDoc("docs/dashboard.md")).toBe(1));
  test("docs/bmad-system.md", () => expect(classifyDoc("docs/bmad-system.md")).toBe(1));
  test("docs/configuration.md", () => expect(classifyDoc("docs/configuration.md")).toBe(1));
});

describe("classifyDoc — Tier 2 (PR + notification, no auto-merge)", () => {
  test("CLAUDE.md", () => expect(classifyDoc("CLAUDE.md")).toBe(2));
});

describe("classifyDoc — Tier 3 (excluded)", () => {
  test("docs/specs/SPEC-foo.md", () => expect(classifyDoc("docs/specs/SPEC-foo.md")).toBe(3));
  test("docs/specs/SPEC-bar-baz.md", () =>
    expect(classifyDoc("docs/specs/SPEC-bar-baz.md")).toBe(3));
  test("docs/adr/ADR-001.md", () => expect(classifyDoc("docs/adr/ADR-001.md")).toBe(3));
  test("docs/adr/ADR-042.md", () => expect(classifyDoc("docs/adr/ADR-042.md")).toBe(3));
  test("unknown root doc defaults to 3", () => expect(classifyDoc("ROADMAP.md")).toBe(3));
  test("unknown docs/ file defaults to 3", () => expect(classifyDoc("docs/unknown.md")).toBe(3));
  test("docs/explorations/ defaults to 3", () =>
    expect(classifyDoc("docs/explorations/EXPLORE-foo.md")).toBe(3));
  test("docs/reviews/ defaults to 3", () => expect(classifyDoc("docs/reviews/review.md")).toBe(3));
});

describe("shouldTriggerUpdate", () => {
  test("triggers when src/ changes are present with other changes", () => {
    expect(shouldTriggerUpdate(["src/relay.ts", "CLAUDE.md"])).toBe(true);
  });
  test("triggers when only src/ changes are present", () => {
    expect(shouldTriggerUpdate(["src/relay.ts"])).toBe(true);
  });
  test("triggers when multiple src/ files changed", () => {
    expect(shouldTriggerUpdate(["src/relay.ts", "src/config.ts", "src/agent.ts"])).toBe(true);
  });
  test("does not trigger on empty change list", () => {
    expect(shouldTriggerUpdate([])).toBe(false);
  });
  test("does not trigger when only CLAUDE.md changed (anti-recursion)", () => {
    expect(shouldTriggerUpdate(["CLAUDE.md"])).toBe(false);
  });
  test("does not trigger when only docs/ changed (anti-recursion)", () => {
    expect(shouldTriggerUpdate(["docs/WORKFLOW-DEV.md"])).toBe(false);
  });
  test("does not trigger for scripts/ changes (not src/)", () => {
    expect(shouldTriggerUpdate(["scripts/doc-freshness.ts"])).toBe(false);
  });
  test("src/ prefix check is exact — not a substring match", () => {
    expect(shouldTriggerUpdate(["not-src/relay.ts"])).toBe(false);
  });
});

describe("buildDocUpdatePlan", () => {
  test("classifies stale docs into correct tiers", () => {
    const plan = buildDocUpdatePlan(
      ["src/relay.ts"],
      ["CLAUDE.md", "README.md", "docs/specs/SPEC-foo.md"],
    );
    expect(plan.tier1).toContain("README.md");
    expect(plan.tier2).toContain("CLAUDE.md");
    expect(plan.tier3).toContain("docs/specs/SPEC-foo.md");
  });

  test("shouldProceed is true when tier1 docs exist", () => {
    const plan = buildDocUpdatePlan(["src/relay.ts"], ["README.md"]);
    expect(plan.shouldProceed).toBe(true);
  });

  test("shouldProceed is true when tier2 docs exist", () => {
    const plan = buildDocUpdatePlan(["src/relay.ts"], ["CLAUDE.md"]);
    expect(plan.shouldProceed).toBe(true);
  });

  test("shouldProceed is false when only tier3 docs exist", () => {
    const plan = buildDocUpdatePlan(
      ["src/relay.ts"],
      ["docs/specs/SPEC-foo.md", "docs/adr/ADR-001.md"],
    );
    expect(plan.shouldProceed).toBe(false);
  });

  test("shouldProceed is false when no stale docs", () => {
    const plan = buildDocUpdatePlan(["src/relay.ts"], []);
    expect(plan.shouldProceed).toBe(false);
  });

  test("empty plan when no stale docs", () => {
    const plan = buildDocUpdatePlan(["src/relay.ts"], []);
    expect(plan.tier1).toHaveLength(0);
    expect(plan.tier2).toHaveLength(0);
    expect(plan.tier3).toHaveLength(0);
  });

  test("classifies multiple docs across all tiers", () => {
    const plan = buildDocUpdatePlan(
      ["src/relay.ts"],
      ["README.md", "CHANGELOG.md", "docs/WORKFLOW-DEV.md", "CLAUDE.md", "docs/adr/ADR-001.md"],
    );
    expect(plan.tier1).toHaveLength(3);
    expect(plan.tier2).toHaveLength(1);
    expect(plan.tier3).toHaveLength(1);
  });

  test("docs appear in exactly one tier (no duplicates)", () => {
    const plan = buildDocUpdatePlan(
      ["src/relay.ts"],
      ["README.md", "CLAUDE.md", "docs/specs/SPEC-foo.md"],
    );
    const all = [...plan.tier1, ...plan.tier2, ...plan.tier3];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });
});

describe("DOC_UPDATE_RULES", () => {
  test("has exactly 8 Tier 1 docs", () => {
    const tier1 = DOC_UPDATE_RULES.filter((r) => r.tier === 1);
    expect(tier1).toHaveLength(8);
  });

  test("has exactly 1 Tier 2 doc", () => {
    const tier2 = DOC_UPDATE_RULES.filter((r) => r.tier === 2);
    expect(tier2).toHaveLength(1);
  });

  test("CLAUDE.md is the Tier 2 doc", () => {
    const tier2 = DOC_UPDATE_RULES.filter((r) => r.tier === 2);
    expect(tier2[0].path).toBe("CLAUDE.md");
  });

  test("CHANGELOG.md is Tier 1 with append-only update type", () => {
    const rule = DOC_UPDATE_RULES.find((r) => r.path === "CHANGELOG.md");
    expect(rule).toBeDefined();
    expect(rule?.tier).toBe(1);
    expect(rule?.updateType).toBe("append-only");
  });

  test("all non-CHANGELOG Tier 1 docs have full update type", () => {
    const tier1 = DOC_UPDATE_RULES.filter((r) => r.tier === 1 && r.path !== "CHANGELOG.md");
    expect(tier1.every((r) => r.updateType === "full")).toBe(true);
  });

  test("all 8 expected Tier 1 paths are present", () => {
    const tier1Paths = DOC_UPDATE_RULES.filter((r) => r.tier === 1).map((r) => r.path);
    expect(tier1Paths).toContain("README.md");
    expect(tier1Paths).toContain("CHANGELOG.md");
    expect(tier1Paths).toContain("docs/WORKFLOW-DEV.md");
    expect(tier1Paths).toContain("docs/WORKFLOW-PIPELINE.md");
    expect(tier1Paths).toContain("docs/SETUP.md");
    expect(tier1Paths).toContain("docs/dashboard.md");
    expect(tier1Paths).toContain("docs/bmad-system.md");
    expect(tier1Paths).toContain("docs/configuration.md");
  });
});

describe("TIER3_PATTERNS", () => {
  test("contains docs/specs/ pattern", () => {
    expect(TIER3_PATTERNS).toContain("docs/specs/");
  });

  test("contains docs/adr/ pattern", () => {
    expect(TIER3_PATTERNS).toContain("docs/adr/");
  });

  test("has at least 2 patterns", () => {
    expect(TIER3_PATTERNS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("SKIP_CI_SUFFIX", () => {
  test("value is [skip actions]", () => {
    expect(SKIP_CI_SUFFIX).toBe("[skip actions]");
  });
});

describe("buildBranchName", () => {
  test("generates deterministic name from timestamp", () => {
    expect(buildBranchName(1234567890)).toBe("chore/doc-auto-update-1234567890");
  });

  test("uses current timestamp when none provided", () => {
    const before = Date.now();
    const name = buildBranchName();
    const after = Date.now();
    const ts = parseInt(name.replace("chore/doc-auto-update-", ""), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("always starts with chore/doc-auto-update-", () => {
    expect(buildBranchName(0)).toMatch(/^chore\/doc-auto-update-/);
  });
});

describe("tierLabel", () => {
  test("tier 1 → auto-merge", () => expect(tierLabel(1)).toBe("auto-merge"));
  test("tier 2 → review-required", () => expect(tierLabel(2)).toBe("review-required"));
  test("tier 3 → excluded", () => expect(tierLabel(3)).toBe("excluded"));
});
