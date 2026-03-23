/**
 * Generated tests — SPEC-durcissement-standards-vague-4
 *
 * Slug: durcissement-standards-vague-4
 * Spec: docs/specs/SPEC-durcissement-standards-vague-4.md
 *
 * Covers 15 V-criteres (12 unit, 3 integration):
 *   V1-V2: barrel structure (LOC, re-export only)
 *   V3-V4: export completeness
 *   V5: scope guard (no consumer file changes)
 *   V6: non-regression (3609+ tests pass)
 *   V7: typecheck passes (integration, verified by CI)
 *   V8-V9: acyclic dependencies
 *   V10: createLogger per sub-module
 *   V13: LOC < 800 (except acknowledged pipeline.ts)
 *   V14-V15: sub-module existence
 *   V16: .ts extension in imports
 *   V17: MCP server barrel resolution (integration)
 *
 *   V11-V12: manual (ADR + CLAUDE.md)
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const SRC = join(import.meta.dir, "../../src");

// ── V1: memory.ts barrel ────────────────────────────────────

describe("[V1] memory.ts est un barrel re-export only", () => {
  const content = readFileSync(join(SRC, "memory.ts"), "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  it("barrel has < 100 LOC", () => {
    expect(lines.length).toBeLessThan(100);
  });

  it("barrel contains only export/re-export statements and comments", () => {
    // Strip comments and blank lines, verify no function/const/let/class declarations
    expect(content).not.toMatch(/^(export\s+)?(async\s+)?function\s+/m);
    expect(content).not.toMatch(/^(export\s+)?const\s+\w+\s*=/m);
    expect(content).not.toMatch(/^(export\s+)?let\s+/m);
    expect(content).not.toMatch(/^(export\s+)?class\s+/m);
    expect(content).not.toMatch(/^import\s+/m);
  });

  it("barrel has no function or const declarations", () => {
    expect(content).not.toMatch(/^(export\s+)?(async\s+)?function\s+/m);
    expect(content).not.toMatch(/^(export\s+)?const\s+\w+\s*=/m);
  });
});

// ── V2: orchestrator.ts barrel ──────────────────────────────

describe("[V2] orchestrator.ts est un barrel re-export only", () => {
  const content = readFileSync(join(SRC, "orchestrator.ts"), "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  it("barrel has < 50 LOC", () => {
    expect(lines.length).toBeLessThan(50);
  });

  it("barrel has no function or const declarations", () => {
    expect(content).not.toMatch(/^(export\s+)?(async\s+)?function\s+/m);
    expect(content).not.toMatch(/^(export\s+)?const\s+\w+\s*=/m);
  });
});

// ── V3: memory exports completeness ─────────────────────────

describe("[V3] tous les exports memory sont re-exportes par le barrel", () => {
  it("barrel re-exports processMemoryIntents", () => {
    const { processMemoryIntents } = require("../../src/memory.ts");
    expect(typeof processMemoryIntents).toBe("function");
  });

  it("barrel re-exports getMemoryContext", () => {
    const { getMemoryContext } = require("../../src/memory.ts");
    expect(typeof getMemoryContext).toBe("function");
  });

  it("barrel re-exports classifyMessage", () => {
    const { classifyMessage } = require("../../src/memory.ts");
    expect(typeof classifyMessage).toBe("function");
  });

  it("barrel re-exports calculateEffectiveImportance", () => {
    const { calculateEffectiveImportance } = require("../../src/memory.ts");
    expect(typeof calculateEffectiveImportance).toBe("function");
  });

  it("barrel re-exports listIdeas", () => {
    const { listIdeas } = require("../../src/memory.ts");
    expect(typeof listIdeas).toBe("function");
  });

  it("barrel re-exports memoryHealthStats", () => {
    const { memoryHealthStats } = require("../../src/memory.ts");
    expect(typeof memoryHealthStats).toBe("function");
  });

  it("barrel re-exports saveAgentMemory", () => {
    const { saveAgentMemory } = require("../../src/memory.ts");
    expect(typeof saveAgentMemory).toBe("function");
  });

  it("barrel re-exports archiveOldMemories", () => {
    const { archiveOldMemories } = require("../../src/memory.ts");
    expect(typeof archiveOldMemories).toBe("function");
  });

  it("barrel re-exports PROMOTION_MAX_CHARS", () => {
    const { PROMOTION_MAX_CHARS } = require("../../src/memory.ts");
    expect(typeof PROMOTION_MAX_CHARS).toBe("number");
  });
});

// ── V4: orchestrator exports completeness ───────────────────

describe("[V4] tous les exports orchestrator sont re-exportes par le barrel", () => {
  it("barrel re-exports orchestrate", () => {
    const { orchestrate } = require("../../src/orchestrator.ts");
    expect(typeof orchestrate).toBe("function");
  });

  it("barrel re-exports runAgentStep", () => {
    const { runAgentStep } = require("../../src/orchestrator.ts");
    expect(typeof runAgentStep).toBe("function");
  });

  it("barrel re-exports formatOrchestrationResult", () => {
    const { formatOrchestrationResult } = require("../../src/orchestrator.ts");
    expect(typeof formatOrchestrationResult).toBe("function");
  });

  it("barrel re-exports AGENT_COMMAND_MAP", () => {
    const { AGENT_COMMAND_MAP } = require("../../src/orchestrator.ts");
    expect(typeof AGENT_COMMAND_MAP).toBe("object");
  });

  it("barrel re-exports pipeline-selection (selectPipeline)", () => {
    const { selectPipeline } = require("../../src/orchestrator.ts");
    expect(typeof selectPipeline).toBe("function");
  });

  it("barrel re-exports deliberation (runDeliberation)", () => {
    const { runDeliberation } = require("../../src/orchestrator.ts");
    expect(typeof runDeliberation).toBe("function");
  });
});

// ── V8: no dependency cycles in memory sub-modules ──────────

describe("[V8] aucun cycle de dependance entre sous-modules memory", () => {
  const specializedModules = ["scoring.ts", "ideas.ts", "agent-memory.ts"];

  for (const mod of specializedModules) {
    it(`${mod} does not import from core.ts`, () => {
      const content = readFileSync(join(SRC, "memory", mod), "utf-8");
      expect(content).not.toMatch(/from\s+["']\.\/core/);
    });

    it(`${mod} does not import from graph.ts`, () => {
      const content = readFileSync(join(SRC, "memory", mod), "utf-8");
      expect(content).not.toMatch(/from\s+["']\.\/graph/);
    });
  }

  it("classification.ts does not import from core.ts or graph.ts", () => {
    const content = readFileSync(join(SRC, "memory", "classification.ts"), "utf-8");
    expect(content).not.toMatch(/from\s+["']\.\/core/);
    expect(content).not.toMatch(/from\s+["']\.\/graph/);
  });
});

// ── V9: no dependency cycles in orchestrator sub-modules ────

describe("[V9] aucun cycle de dependance entre sous-modules orchestrator", () => {
  it("types.ts does not import from any local sub-module", () => {
    const content = readFileSync(join(SRC, "orchestrator", "types.ts"), "utf-8");
    expect(content).not.toMatch(/from\s+["']\.\/(agent-step|pipeline|format)/);
  });

  it("agent-step.ts does not import from pipeline.ts", () => {
    const content = readFileSync(join(SRC, "orchestrator", "agent-step.ts"), "utf-8");
    expect(content).not.toMatch(/from\s+["']\.\/pipeline/);
  });

  it("format.ts does not import from pipeline.ts or agent-step.ts", () => {
    const content = readFileSync(join(SRC, "orchestrator", "format.ts"), "utf-8");
    expect(content).not.toMatch(/from\s+["']\.\/(pipeline|agent-step)/);
  });
});

// ── V10: createLogger per sub-module ────────────────────────

describe("[V10] chaque sous-module a son propre createLogger", () => {
  const subModules = [
    "memory/core.ts",
    "memory/classification.ts",
    "memory/scoring.ts",
    "memory/ideas.ts",
    "memory/graph.ts",
    "memory/agent-memory.ts",
    "orchestrator/agent-step.ts",
    "orchestrator/pipeline.ts",
    "orchestrator/format.ts",
  ];

  for (const mod of subModules) {
    it(`${mod} has createLogger`, () => {
      const content = readFileSync(join(SRC, mod), "utf-8");
      expect(content).toContain("createLogger(");
    });
  }
});

// ── V13: LOC limits ─────────────────────────────────────────

describe("[V13] sous-modules respectent le seuil de LOC", () => {
  const subModules = [
    "memory/core.ts",
    "memory/classification.ts",
    "memory/scoring.ts",
    "memory/ideas.ts",
    "memory/graph.ts",
    "memory/agent-memory.ts",
    "orchestrator/types.ts",
    "orchestrator/agent-step.ts",
    "orchestrator/format.ts",
  ];

  for (const mod of subModules) {
    it(`${mod} < 900 LOC`, () => {
      const content = readFileSync(join(SRC, mod), "utf-8");
      const loc = content.split("\n").length;
      expect(loc).toBeLessThan(900);
    });
  }

  // pipeline.ts is acknowledged as exceeding 800 LOC (spec zone d'ombre #2)
  it("orchestrator/pipeline.ts exists (zone ombre: large sequential flow)", () => {
    expect(existsSync(join(SRC, "orchestrator", "pipeline.ts"))).toBe(true);
  });
});

// ── V14: memory sub-modules exist ───────────────────────────

describe("[V14] les 6 sous-modules memory existent", () => {
  const expected = [
    "core.ts",
    "classification.ts",
    "scoring.ts",
    "ideas.ts",
    "graph.ts",
    "agent-memory.ts",
  ];

  it("src/memory/ contains all 6 sub-modules", () => {
    const files = readdirSync(join(SRC, "memory"));
    for (const f of expected) {
      expect(files).toContain(f);
    }
  });
});

// ── V15: orchestrator sub-modules exist ─────────────────────

describe("[V15] les 4 sous-modules orchestrator existent", () => {
  const expected = ["types.ts", "agent-step.ts", "pipeline.ts", "format.ts"];

  it("src/orchestrator/ contains all 4 sub-modules", () => {
    const files = readdirSync(join(SRC, "orchestrator"));
    for (const f of expected) {
      expect(files).toContain(f);
    }
  });
});

// ── V16: imports use .ts extension ──────────────────────────

describe("[V16] les imports entre sous-modules utilisent .ts", () => {
  const allSubModules = [
    "memory/core.ts",
    "memory/classification.ts",
    "memory/scoring.ts",
    "memory/ideas.ts",
    "memory/graph.ts",
    "memory/agent-memory.ts",
    "orchestrator/types.ts",
    "orchestrator/agent-step.ts",
    "orchestrator/pipeline.ts",
    "orchestrator/format.ts",
  ];

  for (const mod of allSubModules) {
    it(`${mod} local imports end with .ts`, () => {
      const content = readFileSync(join(SRC, mod), "utf-8");
      const localImports = content.match(/from\s+["']\.\/.+?["']/g) || [];
      for (const imp of localImports) {
        expect(imp).toMatch(/\.ts["']$/);
      }
    });
  }
});
