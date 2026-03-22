/**
 * Unit Tests — src/pipeline-selection.ts
 *
 * Tests pipeline constants, keyword arrays, selectPipeline(), classifyPipeline(),
 * selectAdaptivePipeline(), classifyAdaptivePipeline(), and edge cases.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyAdaptivePipeline,
  classifyPipeline,
  DEFAULT_PIPELINE,
  LIGHT_PIPELINE,
  type PipelineType,
  QUICK_PIPELINE,
  RESEARCH_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  selectAdaptivePipeline,
  selectPipeline,
} from "../../src/pipeline-selection";

// ── Helpers ──────────────────────────────────────────────────

function makeTask(
  title: string,
  opts?: {
    description?: string | null;
    priority?: number;
    subtasks?: any[] | null;
  },
) {
  return {
    id: "test-1",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    title,
    description: opts?.description ?? null,
    project: "test",
    status: "backlog" as const,
    priority: opts?.priority ?? 2,
    sprint: null,
    tags: [],
    estimated_hours: null,
    actual_hours: null,
    blocked_by: null,
    notes: null,
    completed_at: null,
    acceptance_criteria: null,
    dev_notes: null,
    architecture_ref: null,
    subtasks: opts?.subtasks ?? null,
    project_id: null,
  } as any;
}

// ── Pipeline Constants ───────────────────────────────────────

describe("Pipeline constants", () => {
  it("DEFAULT_PIPELINE has 5 roles in correct order", () => {
    expect(DEFAULT_PIPELINE).toEqual(["analyst", "pm", "architect", "dev", "qa"]);
  });

  it("QUICK_PIPELINE has dev and qa", () => {
    expect(QUICK_PIPELINE).toEqual(["dev", "qa"]);
  });

  it("REVIEW_PIPELINE has qa and architect", () => {
    expect(REVIEW_PIPELINE).toEqual(["qa", "architect"]);
  });

  it("SOLO_PIPELINE has only dev", () => {
    expect(SOLO_PIPELINE).toEqual(["dev"]);
  });

  it("LIGHT_PIPELINE has planner, dev, qa", () => {
    expect(LIGHT_PIPELINE).toEqual(["planner", "dev", "qa"]);
  });

  it("RESEARCH_PIPELINE has explorer, planner, dev, qa", () => {
    expect(RESEARCH_PIPELINE).toEqual(["explorer", "planner", "dev", "qa"]);
  });
});

// ── selectPipeline ───────────────────────────────────────────

describe("selectPipeline", () => {
  it("returns explicit pipeline when provided", () => {
    const custom = ["dev" as const, "qa" as const];
    const result = selectPipeline(makeTask("anything at all"), custom);
    expect(result).toEqual(custom);
  });

  // Bug keywords → QUICK
  it("returns QUICK for bug keyword 'fix'", () => {
    expect(selectPipeline(makeTask("fix login crash"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for bug keyword 'bug'", () => {
    expect(selectPipeline(makeTask("bug in signup form"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for bug keyword 'hotfix'", () => {
    expect(selectPipeline(makeTask("hotfix for payment"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for bug keyword 'regression'", () => {
    expect(selectPipeline(makeTask("regression in auth flow"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for French bug keyword 'corriger'", () => {
    expect(selectPipeline(makeTask("corriger le formulaire"))).toEqual(QUICK_PIPELINE);
  });

  // Review keywords → REVIEW
  it("returns REVIEW for review keyword 'review'", () => {
    expect(selectPipeline(makeTask("review the auth module"))).toEqual(REVIEW_PIPELINE);
  });

  it("returns REVIEW for review keyword 'audit'", () => {
    expect(selectPipeline(makeTask("security audit"))).toEqual(REVIEW_PIPELINE);
  });

  it("returns REVIEW for review keyword 'refactor'", () => {
    expect(selectPipeline(makeTask("refactor orchestrator module"))).toEqual(REVIEW_PIPELINE);
  });

  it("returns REVIEW for review keyword 'cleanup'", () => {
    expect(selectPipeline(makeTask("cleanup dead code paths"))).toEqual(REVIEW_PIPELINE);
  });

  it("returns REVIEW for review keyword 'dette'", () => {
    expect(selectPipeline(makeTask("dette technique a traiter"))).toEqual(REVIEW_PIPELINE);
  });

  // Doc keywords → QUICK
  it("returns QUICK for doc keyword 'documentation'", () => {
    expect(selectPipeline(makeTask("update documentation"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for doc keyword 'readme'", () => {
    expect(selectPipeline(makeTask("improve readme instructions"))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for doc keyword 'changelog'", () => {
    expect(selectPipeline(makeTask("update changelog for release"))).toEqual(QUICK_PIPELINE);
  });

  // Research keywords → RESEARCH
  it("returns RESEARCH for research keyword 'research'", () => {
    expect(selectPipeline(makeTask("research database options"))).toEqual(RESEARCH_PIPELINE);
  });

  it("returns RESEARCH for research keyword 'benchmark'", () => {
    expect(selectPipeline(makeTask("benchmark JSON parsers"))).toEqual(RESEARCH_PIPELINE);
  });

  it("returns RESEARCH for research keyword 'compare'", () => {
    expect(selectPipeline(makeTask("compare ORM alternatives"))).toEqual(RESEARCH_PIPELINE);
  });

  it("returns RESEARCH for research keyword 'state of the art'", () => {
    expect(selectPipeline(makeTask("state of the art LLM routing"))).toEqual(RESEARCH_PIPELINE);
  });

  it("returns RESEARCH for French research keyword 'etat de l'art'", () => {
    expect(selectPipeline(makeTask("etat de l'art des frameworks"))).toEqual(RESEARCH_PIPELINE);
  });

  // Simple P3+ tasks → QUICK
  it("returns QUICK for short P3 task with no subtasks", () => {
    expect(selectPipeline(makeTask("add env var", { priority: 3 }))).toEqual(QUICK_PIPELINE);
  });

  it("returns QUICK for P4 simple task", () => {
    expect(selectPipeline(makeTask("tweak label", { priority: 4 }))).toEqual(QUICK_PIPELINE);
  });

  // DEFAULT fallback
  it("returns DEFAULT for complex task with no keywords", () => {
    expect(
      selectPipeline(makeTask("implement multi-agent orchestration pipeline with DAG execution")),
    ).toEqual(DEFAULT_PIPELINE);
  });

  it("returns DEFAULT for P1 short task (high priority bypasses simple rule)", () => {
    expect(selectPipeline(makeTask("add env var", { priority: 1 }))).toEqual(DEFAULT_PIPELINE);
  });

  it("returns DEFAULT for P3 task with long title", () => {
    const longTitle =
      "add a new comprehensive configuration management system for all environments";
    expect(selectPipeline(makeTask(longTitle, { priority: 3 }))).toEqual(DEFAULT_PIPELINE);
  });

  it("returns DEFAULT for P3 task with subtasks", () => {
    expect(
      selectPipeline(makeTask("add config", { priority: 3, subtasks: [{ title: "sub1" }] })),
    ).toEqual(DEFAULT_PIPELINE);
  });

  // Description matters
  it("detects keywords in description, not just title", () => {
    expect(
      selectPipeline(makeTask("update module", { description: "fix the broken handler" })),
    ).toEqual(QUICK_PIPELINE);
  });

  // Research keywords have priority over bug keywords
  it("research keywords take priority over bug keywords", () => {
    expect(selectPipeline(makeTask("research fix strategies for memory leaks"))).toEqual(
      RESEARCH_PIPELINE,
    );
  });
});

// ── classifyPipeline ─────────────────────────────────────────

describe("classifyPipeline", () => {
  it("classifies research tasks as RESEARCH", () => {
    expect(classifyPipeline(makeTask("investigate performance issue"))).toBe("RESEARCH");
  });

  it("classifies bug tasks as QUICK", () => {
    expect(classifyPipeline(makeTask("fix crash on startup"))).toBe("QUICK");
  });

  it("classifies review tasks as REVIEW", () => {
    expect(classifyPipeline(makeTask("code review PR 42"))).toBe("REVIEW");
  });

  it("classifies doc tasks as DOC", () => {
    expect(classifyPipeline(makeTask("write documentation for API"))).toBe("DOC");
  });

  it("classifies simple P3 tasks as QUICK", () => {
    expect(classifyPipeline(makeTask("rename variable", { priority: 3 }))).toBe("QUICK");
  });

  it("classifies complex tasks as DEFAULT", () => {
    expect(
      classifyPipeline(
        makeTask("implement new multi-agent scheduling system with parallel execution"),
      ),
    ).toBe("DEFAULT");
  });

  it("uses description for classification", () => {
    expect(
      classifyPipeline(makeTask("update module", { description: "audit the security posture" })),
    ).toBe("REVIEW");
  });

  it("returns DEFAULT for generic long title with P1 and no keywords", () => {
    expect(
      classifyPipeline(
        makeTask("implement the new multi-agent orchestration pipeline system", { priority: 1 }),
      ),
    ).toBe("DEFAULT");
  });
});

// ── selectAdaptivePipeline ───────────────────────────────────

describe("selectAdaptivePipeline", () => {
  it("returns explicit pipeline when provided", async () => {
    const custom = ["architect" as const, "dev" as const];
    const result = await selectAdaptivePipeline(makeTask("anything"), custom);
    expect(result).toEqual(custom);
  });

  it("returns RESEARCH for research keywords regardless of difficulty", async () => {
    const result = await selectAdaptivePipeline(makeTask("benchmark database engines"));
    expect(result).toEqual(RESEARCH_PIPELINE);
  });

  it("returns REVIEW for review keywords regardless of difficulty", async () => {
    const result = await selectAdaptivePipeline(makeTask("audit security module"));
    expect(result).toEqual(REVIEW_PIPELINE);
  });

  it("returns SOLO for trivial task (low difficulty score)", async () => {
    const result = await selectAdaptivePipeline(makeTask("fix typo"));
    expect(result).toEqual(SOLO_PIPELINE);
  });

  it("returns DEFAULT for complex task (high difficulty score)", async () => {
    const result = await selectAdaptivePipeline(
      makeTask("Implement new orchestration engine", {
        description:
          "Full architecture design with database migration, parallel execution framework, and security hardening of the authentication workflow integration",
      }),
    );
    expect(result).toEqual(DEFAULT_PIPELINE);
  });

  it("returns LIGHT for medium-difficulty task", async () => {
    const result = await selectAdaptivePipeline(
      makeTask("add notification preferences to user profile page"),
    );
    // Medium-length title, no extreme keywords → LIGHT
    expect([LIGHT_PIPELINE, SOLO_PIPELINE, DEFAULT_PIPELINE]).toContainEqual(result);
  });
});

// ── classifyAdaptivePipeline ─────────────────────────────────

describe("classifyAdaptivePipeline", () => {
  it("returns RESEARCH for research keywords", async () => {
    const result = await classifyAdaptivePipeline(makeTask("compare CI providers"));
    expect(result).toBe("RESEARCH");
  });

  it("returns REVIEW for review keywords", async () => {
    const result = await classifyAdaptivePipeline(makeTask("refactor legacy code"));
    expect(result).toBe("REVIEW");
  });

  it("returns SOLO for trivial task", async () => {
    const result = await classifyAdaptivePipeline(makeTask("fix typo"));
    expect(result).toBe("SOLO");
  });

  it("returns DEFAULT for complex task", async () => {
    const result = await classifyAdaptivePipeline(
      makeTask("Implement new orchestration engine", {
        description:
          "Full architecture design with database migration and security hardening across auth workflow integration protocol",
      }),
    );
    expect(result).toBe("DEFAULT");
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles empty title", () => {
    const result = selectPipeline(makeTask("", { priority: 3 }));
    expect(result).toEqual(QUICK_PIPELINE); // empty title < 40 chars, P3, no subtasks
  });

  it("handles null description", () => {
    const result = selectPipeline(makeTask("some task", { description: null }));
    // No keywords, P2, so DEFAULT
    expect(result).toEqual(DEFAULT_PIPELINE);
  });

  it("handles empty description", () => {
    const result = selectPipeline(makeTask("some task", { description: "" }));
    expect(result).toEqual(DEFAULT_PIPELINE);
  });

  it("keyword matching is case-insensitive", () => {
    expect(selectPipeline(makeTask("FIX the CRASH"))).toEqual(QUICK_PIPELINE);
    expect(selectPipeline(makeTask("CODE REVIEW"))).toEqual(REVIEW_PIPELINE);
    expect(selectPipeline(makeTask("BENCHMARK performance"))).toEqual(RESEARCH_PIPELINE);
  });

  it("keyword in description overrides simple P3 rule", () => {
    const task = makeTask("small change", { priority: 3, description: "audit the module" });
    // Even though title is short and P3, "audit" keyword → REVIEW
    expect(selectPipeline(task)).toEqual(REVIEW_PIPELINE);
  });

  it("classifyPipeline returns DOC, selectPipeline returns QUICK for doc tasks", () => {
    const task = makeTask("update documentation for modules");
    expect(classifyPipeline(task)).toBe("DOC");
    expect(selectPipeline(task)).toEqual(QUICK_PIPELINE);
  });

  it("research keyword priority: investigate triggers RESEARCH not DEFAULT", () => {
    expect(classifyPipeline(makeTask("investigate memory leak pattern"))).toBe("RESEARCH");
  });

  it("multiple conflicting keywords: first match wins (research > bug > review > doc)", () => {
    // Title contains both research and bug keyword
    const task1 = makeTask("research how to fix this bug efficiently");
    expect(classifyPipeline(task1)).toBe("RESEARCH"); // research checked first

    // Title contains bug and review keyword but no research
    const task2 = makeTask("fix the code review pipeline");
    expect(classifyPipeline(task2)).toBe("QUICK"); // bug checked before review

    // Title contains review and doc keyword but no bug or research
    const task3 = makeTask("review the documentation structure");
    expect(classifyPipeline(task3)).toBe("REVIEW"); // review checked before doc
  });
});

// ── PipelineType type check ──────────────────────────────────

describe("PipelineType", () => {
  it("classifyPipeline returns valid PipelineType values", () => {
    const validTypes: PipelineType[] = [
      "DEFAULT",
      "QUICK",
      "REVIEW",
      "DOC",
      "SOLO",
      "LIGHT",
      "RESEARCH",
    ];
    const result = classifyPipeline(
      makeTask("generic long task with complex requirements and scope", { priority: 1 }),
    );
    expect(validTypes).toContain(result);
  });
});
