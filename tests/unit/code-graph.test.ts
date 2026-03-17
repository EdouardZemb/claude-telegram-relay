/**
 * Tests for code-graph module (S39)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  extractExports,
  extractImports,
  indexCodebase,
  saveGraph,
  loadGraph,
  clearGraphCache,
  getModuleDependencies,
  getDependents,
  getImpactRadius,
  getRelatedModules,
  findNode,
  getGraphStats,
  formatGraphContext,
  formatGraphStatsForMonitor,
  estimateComplexity,
  findAffectedModules,
  type CodeGraph,
  type GraphNode,
  type GraphEdge,
} from "../../src/code-graph.ts";

// ── extractExports ──────────────────────────────────────────

describe("extractExports", () => {
  it("extracts exported functions", () => {
    const code = `export function doSomething(x: number): void {}
export async function fetchData(): Promise<void> {}`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(2);
    expect(exports[0]).toEqual({ name: "doSomething", kind: "function" });
    expect(exports[1]).toEqual({ name: "fetchData", kind: "function" });
  });

  it("extracts exported classes", () => {
    const code = `export class MyService {\n  constructor() {}\n}`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toEqual({ name: "MyService", kind: "class" });
  });

  it("extracts exported interfaces", () => {
    const code = `export interface Config {\n  key: string;\n}`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toEqual({ name: "Config", kind: "interface" });
  });

  it("extracts exported types", () => {
    const code = `export type AgentRole = "dev" | "qa";`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toEqual({ name: "AgentRole", kind: "type" });
  });

  it("extracts exported constants", () => {
    const code = `export const MAX_RETRIES = 3;\nexport let counter = 0;`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(2);
    expect(exports[0]).toEqual({ name: "MAX_RETRIES", kind: "const" });
    expect(exports[1]).toEqual({ name: "counter", kind: "const" });
  });

  it("extracts default export", () => {
    const code = `export default function helpCommands(bctx: any) {}`;
    const exports = extractExports(code);
    expect(exports.some((e) => e.name === "helpCommands")).toBe(true);
  });

  it("deduplicates exports", () => {
    const code = `export function foo() {}\nexport function foo() {}`;
    const exports = extractExports(code);
    expect(exports.filter((e) => e.name === "foo")).toHaveLength(1);
  });

  it("handles empty content", () => {
    expect(extractExports("")).toEqual([]);
  });

  it("ignores non-exported functions", () => {
    const code = `function internal() {}\nexport function public() {}`;
    const exports = extractExports(code);
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe("public");
  });
});

// ── extractImports ──────────────────────────────────────────

describe("extractImports", () => {
  it("extracts named local imports", () => {
    const code = `import { foo, bar } from "./utils.ts";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports).toHaveLength(1);
    expect(imports[0].target).toBe("src/utils.ts");
    expect(imports[0].imports).toEqual(["foo", "bar"]);
    expect(imports[0].isTypeOnly).toBe(false);
  });

  it("extracts type-only imports", () => {
    const code = `import type { Config } from "./types.ts";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports).toHaveLength(1);
    expect(imports[0].isTypeOnly).toBe(true);
    expect(imports[0].imports).toEqual(["Config"]);
  });

  it("extracts default imports", () => {
    const code = `import myModule from "./my-module.ts";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports).toHaveLength(1);
    expect(imports[0].imports).toEqual(["myModule"]);
  });

  it("ignores external package imports", () => {
    const code = `import { Bot } from "grammy";\nimport { foo } from "@supabase/supabase-js";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports).toHaveLength(0);
  });

  it("resolves relative paths correctly", () => {
    const code = `import { bar } from "../utils.ts";`;
    const imports = extractImports(code, "src/commands/help.ts");
    expect(imports).toHaveLength(1);
    expect(imports[0].target).toBe("src/utils.ts");
  });

  it("handles as aliases", () => {
    const code = `import { foo as bar, baz } from "./module.ts";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports[0].imports).toEqual(["foo", "baz"]);
  });

  it("handles empty content", () => {
    expect(extractImports("", "src/relay.ts")).toEqual([]);
  });

  it("adds .ts extension when missing", () => {
    const code = `import { foo } from "./bar";`;
    const imports = extractImports(code, "src/relay.ts");
    expect(imports[0].target).toMatch(/\.ts$/);
  });
});

// ── indexCodebase ────────────────────────────────────────────

describe("indexCodebase", () => {
  it("indexes the real codebase", () => {
    const graph = indexCodebase();
    expect(graph.nodes.length).toBeGreaterThan(30);
    expect(graph.edges.length).toBeGreaterThan(20);
    expect(graph.indexedAt).toBeTruthy();
  });

  it("includes expected modules", () => {
    const graph = indexCodebase();
    const moduleIds = graph.nodes.map((n) => n.id);
    expect(moduleIds).toContain("src/relay.ts");
    expect(moduleIds).toContain("src/orchestrator.ts");
    expect(moduleIds).toContain("src/code-graph.ts");
  });

  it("captures cross-module imports", () => {
    const graph = indexCodebase();
    // orchestrator.ts imports from many modules
    const orchEdges = graph.edges.filter((e) => e.source === "src/orchestrator.ts");
    expect(orchEdges.length).toBeGreaterThan(3);
  });

  it("does not include test files", () => {
    const graph = indexCodebase();
    const testFiles = graph.nodes.filter((n) => n.id.includes("test"));
    expect(testFiles).toHaveLength(0);
  });
});

// ── saveGraph / loadGraph ───────────────────────────────────

describe("save and load graph", () => {
  const tempPath = join(process.cwd(), "config", "code-graph-test.json");

  afterEach(() => {
    clearGraphCache();
    try { unlinkSync(tempPath); } catch {}
  });

  it("saves and loads a graph", () => {
    const graph: CodeGraph = {
      nodes: [{ id: "src/foo.ts", exports: [{ name: "foo", kind: "function" }], lineCount: 10 }],
      edges: [{ source: "src/foo.ts", target: "src/bar.ts", imports: ["bar"], isTypeOnly: false }],
      indexedAt: new Date().toISOString(),
    };

    saveGraph(graph, tempPath);
    clearGraphCache();
    const loaded = loadGraph(tempPath);

    expect(loaded).not.toBeNull();
    expect(loaded!.nodes).toHaveLength(1);
    expect(loaded!.edges).toHaveLength(1);
  });

  it("returns null for missing cache", () => {
    clearGraphCache();
    const loaded = loadGraph("/tmp/nonexistent-graph.json");
    expect(loaded).toBeNull();
  });
});

// ── Graph Queries ────────────────────────────────────────────

describe("graph queries", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "src/a.ts", exports: [{ name: "aFn", kind: "function" }], lineCount: 50 },
      { id: "src/b.ts", exports: [{ name: "bFn", kind: "function" }], lineCount: 100 },
      { id: "src/c.ts", exports: [{ name: "cFn", kind: "function" }], lineCount: 200 },
      { id: "src/d.ts", exports: [{ name: "dFn", kind: "function" }], lineCount: 30 },
    ],
    edges: [
      { source: "src/a.ts", target: "src/b.ts", imports: ["bFn"], isTypeOnly: false },
      { source: "src/b.ts", target: "src/c.ts", imports: ["cFn"], isTypeOnly: false },
      { source: "src/d.ts", target: "src/b.ts", imports: ["bFn"], isTypeOnly: false },
    ],
    indexedAt: "2026-01-01T00:00:00Z",
  };

  describe("getModuleDependencies", () => {
    it("returns direct imports", () => {
      const deps = getModuleDependencies(graph, "src/a.ts");
      expect(deps).toHaveLength(1);
      expect(deps[0].target).toBe("src/b.ts");
    });

    it("returns empty for modules with no imports", () => {
      const deps = getModuleDependencies(graph, "src/c.ts");
      expect(deps).toHaveLength(0);
    });
  });

  describe("getDependents", () => {
    it("returns modules that import this one", () => {
      const deps = getDependents(graph, "src/b.ts");
      expect(deps).toHaveLength(2);
      const sources = deps.map((d) => d.source).sort();
      expect(sources).toEqual(["src/a.ts", "src/d.ts"]);
    });

    it("returns empty for leaf modules", () => {
      const deps = getDependents(graph, "src/a.ts");
      expect(deps).toHaveLength(0);
    });
  });

  describe("getImpactRadius", () => {
    it("returns transitive dependents with distance", () => {
      const impact = getImpactRadius(graph, "src/c.ts", 3);
      // c is imported by b, b is imported by a and d
      expect(impact.length).toBeGreaterThanOrEqual(1);
      const modules = impact.map((i) => i.module);
      expect(modules).toContain("src/b.ts"); // distance 1
    });

    it("respects depth limit", () => {
      const impact = getImpactRadius(graph, "src/c.ts", 1);
      const modules = impact.map((i) => i.module);
      expect(modules).toContain("src/b.ts");
      // a.ts is at distance 2, should not be included with depth=1
      expect(impact.every((i) => i.distance <= 1)).toBe(true);
    });

    it("returns empty for modules with no dependents", () => {
      const impact = getImpactRadius(graph, "src/a.ts", 3);
      expect(impact).toHaveLength(0);
    });
  });

  describe("getRelatedModules", () => {
    it("returns direct imports and dependents", () => {
      const related = getRelatedModules(graph, "src/b.ts");
      expect(related).toContain("src/a.ts"); // dependent
      expect(related).toContain("src/c.ts"); // dependency
      expect(related).toContain("src/d.ts"); // dependent
    });
  });

  describe("findNode", () => {
    it("finds exact match", () => {
      const node = findNode(graph, "src/a.ts");
      expect(node).not.toBeUndefined();
      expect(node!.id).toBe("src/a.ts");
    });

    it("finds partial match", () => {
      const node = findNode(graph, "a.ts");
      expect(node).not.toBeUndefined();
    });

    it("returns undefined for no match", () => {
      const node = findNode(graph, "nonexistent.ts");
      expect(node).toBeUndefined();
    });
  });
});

// ── Statistics ───────────────────────────────────────────────

describe("getGraphStats", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "src/a.ts", exports: [{ name: "a1", kind: "function" }, { name: "a2", kind: "const" }], lineCount: 50 },
      { id: "src/b.ts", exports: [{ name: "b1", kind: "function" }], lineCount: 100 },
    ],
    edges: [
      { source: "src/a.ts", target: "src/b.ts", imports: ["b1"], isTypeOnly: false },
    ],
    indexedAt: "2026-01-01T00:00:00Z",
  };

  it("calculates correct stats", () => {
    const stats = getGraphStats(graph);
    expect(stats.totalModules).toBe(2);
    expect(stats.totalEdges).toBe(1);
    expect(stats.totalExports).toBe(3);
    expect(stats.avgDependencies).toBe(0.5);
  });

  it("returns most connected modules", () => {
    const stats = getGraphStats(graph);
    expect(stats.mostConnected.length).toBeGreaterThan(0);
    // Both a.ts and b.ts have 1 connection each
    expect(stats.mostConnected[0].connections).toBeGreaterThanOrEqual(1);
  });
});

// ── Formatting ───────────────────────────────────────────────

describe("formatGraphContext", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "src/relay.ts", exports: [{ name: "createBot", kind: "function" }], lineCount: 243 },
      { id: "src/orchestrator.ts", exports: [{ name: "orchestrate", kind: "function" }], lineCount: 500 },
    ],
    edges: [
      { source: "src/relay.ts", target: "src/orchestrator.ts", imports: ["orchestrate"], isTypeOnly: false },
    ],
    indexedAt: "2026-01-01T00:00:00Z",
  };

  it("formats context for dev role", () => {
    const ctx = formatGraphContext(graph, "src/relay.ts", "dev");
    expect(ctx).toContain("relay.ts");
    expect(ctx).toContain("243 lines");
    expect(ctx).toContain("createBot");
    expect(ctx).toContain("orchestrator.ts");
  });

  it("includes impact radius for architect", () => {
    const ctx = formatGraphContext(graph, "src/orchestrator.ts", "architect");
    expect(ctx).toContain("orchestrator.ts");
  });

  it("returns empty for unknown module", () => {
    const ctx = formatGraphContext(graph, "src/nonexistent.ts", "dev");
    expect(ctx).toBe("");
  });
});

describe("formatGraphStatsForMonitor", () => {
  it("formats stats for display", () => {
    const graph: CodeGraph = {
      nodes: [
        { id: "src/a.ts", exports: [{ name: "a", kind: "function" }], lineCount: 50 },
      ],
      edges: [],
      indexedAt: "2026-03-17T08:00:00Z",
    };
    const output = formatGraphStatsForMonitor(graph);
    expect(output).toContain("CODE GRAPH:");
    expect(output).toContain("Modules: 1");
    expect(output).toContain("Edges: 0");
  });
});

// ── Complexity ───────────────────────────────────────────────

describe("estimateComplexity", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "src/simple.ts", exports: [{ name: "fn", kind: "function" }], lineCount: 20 },
      { id: "src/complex.ts", exports: [
        { name: "a", kind: "function" },
        { name: "b", kind: "function" },
      ], lineCount: 600 },
      { id: "src/dep1.ts", exports: [{ name: "d1", kind: "function" }], lineCount: 50 },
      { id: "src/dep2.ts", exports: [{ name: "d2", kind: "function" }], lineCount: 50 },
    ],
    edges: [
      { source: "src/complex.ts", target: "src/dep1.ts", imports: ["d1"], isTypeOnly: false },
      { source: "src/complex.ts", target: "src/dep2.ts", imports: ["d2"], isTypeOnly: false },
      { source: "src/dep1.ts", target: "src/complex.ts", imports: ["a"], isTypeOnly: false },
    ],
    indexedAt: "2026-01-01T00:00:00Z",
  };

  it("returns higher score for complex modules", () => {
    const simpleScore = estimateComplexity(graph, "src/simple.ts");
    const complexScore = estimateComplexity(graph, "src/complex.ts");
    expect(complexScore).toBeGreaterThan(simpleScore);
  });

  it("returns 5 for unknown modules", () => {
    expect(estimateComplexity(graph, "src/unknown.ts")).toBe(5);
  });
});

// ── findAffectedModules ─────────────────────────────────────

describe("findAffectedModules", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "src/orchestrator.ts", exports: [], lineCount: 100 },
      { id: "src/relay.ts", exports: [], lineCount: 100 },
      { id: "src/commands/help.ts", exports: [], lineCount: 100 },
    ],
    edges: [],
    indexedAt: "2026-01-01T00:00:00Z",
  };

  it("finds modules mentioned in task text", () => {
    const affected = findAffectedModules(graph, "Refactor orchestrator to support new pipeline");
    expect(affected).toContain("src/orchestrator.ts");
  });

  it("returns empty for unrelated text", () => {
    const affected = findAffectedModules(graph, "Fix database connection timeout");
    expect(affected).toHaveLength(0);
  });

  it("is case insensitive", () => {
    const affected = findAffectedModules(graph, "Update RELAY startup");
    expect(affected).toContain("src/relay.ts");
  });
});

// ── Integration: real codebase graph queries ────────────────

describe("integration: real codebase", () => {
  let graph: CodeGraph;

  beforeEach(() => {
    graph = indexCodebase();
  });

  it("orchestrator has dependencies", () => {
    const deps = getModuleDependencies(graph, "src/orchestrator.ts");
    expect(deps.length).toBeGreaterThan(3);
  });

  it("bot-context has dependents", () => {
    const deps = getDependents(graph, "src/bot-context.ts");
    expect(deps.length).toBeGreaterThan(0);
  });

  it("feature-flags has dependents", () => {
    const impact = getImpactRadius(graph, "src/feature-flags.ts", 2);
    expect(impact.length).toBeGreaterThanOrEqual(1);
  });

  it("relay.ts has exports", () => {
    const node = findNode(graph, "src/relay.ts");
    expect(node).not.toBeUndefined();
    expect(node!.exports.length).toBeGreaterThanOrEqual(1);
  });

  it("formatGraphContext works on real module", () => {
    const ctx = formatGraphContext(graph, "src/orchestrator.ts", "architect");
    expect(ctx).toContain("orchestrator.ts");
    expect(ctx.length).toBeGreaterThan(50);
  });

  it("estimateComplexity returns a number for real module", () => {
    const score = estimateComplexity(graph, "src/orchestrator.ts");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(10);
  });
});
