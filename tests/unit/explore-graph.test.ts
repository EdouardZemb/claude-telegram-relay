/**
 * Unit Tests — Zero-LLM Graph Explore (T5)
 *
 * Tests for structural query detection and code-graph-based responses
 * that bypass the LLM entirely.
 */

import { describe, expect, it } from "bun:test";
import type { CodeGraph } from "../../src/code-graph";
import { detectGraphQuery, extractModuleName, tryGraphResponse } from "../../src/explore-graph";

// ── Test Graph Fixture ──────────────────────────────────────────

function buildTestGraph(): CodeGraph {
  return {
    nodes: [
      {
        id: "src/relay.ts",
        exports: [
          { name: "createBot", kind: "function" },
          { name: "default", kind: "default" },
        ],
        lineCount: 243,
      },
      {
        id: "src/orchestrator.ts",
        exports: [
          { name: "orchestrate", kind: "function" },
          { name: "OrchestrateOptions", kind: "interface" },
        ],
        lineCount: 450,
      },
      {
        id: "src/tasks.ts",
        exports: [
          { name: "createTask", kind: "function" },
          { name: "updateTask", kind: "function" },
          { name: "Task", kind: "interface" },
        ],
        lineCount: 180,
      },
      {
        id: "src/memory.ts",
        exports: [{ name: "getMemoryContext", kind: "function" }],
        lineCount: 320,
      },
      {
        id: "src/commands/help.ts",
        exports: [{ name: "default", kind: "default" }],
        lineCount: 80,
      },
      {
        id: "src/agent.ts",
        exports: [{ name: "spawnClaude", kind: "function" }],
        lineCount: 200,
      },
    ],
    edges: [
      // relay imports orchestrator, tasks, memory
      {
        source: "src/relay.ts",
        target: "src/orchestrator.ts",
        imports: ["orchestrate"],
        isTypeOnly: false,
      },
      {
        source: "src/relay.ts",
        target: "src/tasks.ts",
        imports: ["createTask"],
        isTypeOnly: false,
      },
      {
        source: "src/relay.ts",
        target: "src/memory.ts",
        imports: ["getMemoryContext"],
        isTypeOnly: false,
      },
      // orchestrator imports tasks, agent, memory
      {
        source: "src/orchestrator.ts",
        target: "src/tasks.ts",
        imports: ["updateTask"],
        isTypeOnly: false,
      },
      {
        source: "src/orchestrator.ts",
        target: "src/agent.ts",
        imports: ["spawnClaude"],
        isTypeOnly: false,
      },
      {
        source: "src/orchestrator.ts",
        target: "src/memory.ts",
        imports: ["getMemoryContext"],
        isTypeOnly: false,
      },
      // commands/help imports relay
      { source: "src/commands/help.ts", target: "src/relay.ts", imports: [], isTypeOnly: false },
    ],
    indexedAt: "2026-03-17T14:00:00Z",
    commitHash: "abc1234",
  };
}

// ── extractModuleName ────────────────────────────────────────────

describe("extractModuleName", () => {
  const graph = buildTestGraph();

  it("finds module by exact filename", () => {
    expect(extractModuleName("relay.ts", graph)).toBe("src/relay.ts");
  });

  it("finds module by name without extension", () => {
    expect(extractModuleName("orchestrator", graph)).toBe("src/orchestrator.ts");
  });

  it("finds module by full path", () => {
    expect(extractModuleName("src/tasks.ts", graph)).toBe("src/tasks.ts");
  });

  it("finds module in a sentence", () => {
    expect(extractModuleName("comment fonctionne le module relay", graph)).toBe("src/relay.ts");
  });

  it("returns null for unknown module", () => {
    expect(extractModuleName("un module inconnu", graph)).toBeNull();
  });

  it("finds commands/ module by name", () => {
    expect(extractModuleName("help", graph)).toBe("src/commands/help.ts");
  });

  it("picks shortest match when ambiguous", () => {
    // "agent" matches agent.ts — only one match
    expect(extractModuleName("agent", graph)).toBe("src/agent.ts");
  });
});

// ── detectGraphQuery ─────────────────────────────────────────────

describe("detectGraphQuery", () => {
  const graph = buildTestGraph();

  it("detects stats query", () => {
    const result = detectGraphQuery("statistiques du codebase", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("stats");
    expect(result!.moduleId).toBeNull();
  });

  it("detects stats with 'vue d'ensemble'", () => {
    const result = detectGraphQuery("vue d'ensemble de la structure", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("stats");
  });

  it("detects stats with 'overview'", () => {
    const result = detectGraphQuery("codebase overview", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("stats");
  });

  it("detects dependency query", () => {
    const result = detectGraphQuery("qu'est-ce qu'importe relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("dependencies");
    expect(result!.moduleId).toBe("src/relay.ts");
  });

  it("detects dependent query", () => {
    const result = detectGraphQuery("qui utilise orchestrator", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("dependents");
    expect(result!.moduleId).toBe("src/orchestrator.ts");
  });

  it("detects impact query", () => {
    const result = detectGraphQuery("impact de modifier tasks", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("impact");
    expect(result!.moduleId).toBe("src/tasks.ts");
  });

  it("detects impact with 'si on modifie'", () => {
    const result = detectGraphQuery("si on modifie memory qu'est-ce qui est affecte", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("impact");
    expect(result!.moduleId).toBe("src/memory.ts");
  });

  it("detects complexity query", () => {
    const result = detectGraphQuery("complexite de orchestrator", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("complexity");
    expect(result!.moduleId).toBe("src/orchestrator.ts");
  });

  it("detects related query", () => {
    const result = detectGraphQuery("modules lies a relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("related");
    expect(result!.moduleId).toBe("src/relay.ts");
  });

  it("defaults to module_info when module found but no specific type", () => {
    const result = detectGraphQuery("relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("module_info");
    expect(result!.moduleId).toBe("src/relay.ts");
  });

  it("returns null for queries needing LLM", () => {
    const result = detectGraphQuery("comment ameliorer la performance du bot", graph);
    expect(result).toBeNull();
  });

  it("returns null for opinion-based queries", () => {
    const result = detectGraphQuery("est-ce que notre architecture est bonne", graph);
    expect(result).toBeNull();
  });
});

// ── tryGraphResponse ─────────────────────────────────────────────

describe("tryGraphResponse", () => {
  const graph = buildTestGraph();

  it("returns stats response", () => {
    const result = tryGraphResponse("stats du codebase", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("stats");
    expect(result!.response).toContain("STATISTIQUES");
    expect(result!.response).toContain("Modules: 6");
    expect(result!.response).toContain("abc1234");
  });

  it("returns module_info response with exports", () => {
    const result = tryGraphResponse("relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("module_info");
    expect(result!.response).toContain("MODULE: src/relay.ts");
    expect(result!.response).toContain("243");
    expect(result!.response).toContain("createBot");
    expect(result!.response).toContain("Dependances");
    expect(result!.response).toContain("orchestrator.ts");
  });

  it("returns dependencies response", () => {
    const result = tryGraphResponse("dependances de orchestrator", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("dependencies");
    expect(result!.response).toContain("DEPENDANCES");
    expect(result!.response).toContain("tasks.ts");
    expect(result!.response).toContain("agent.ts");
    expect(result!.response).toContain("memory.ts");
  });

  it("returns dependents response", () => {
    const result = tryGraphResponse("qui utilise tasks", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("dependents");
    expect(result!.response).toContain("MODULES QUI UTILISENT");
    expect(result!.response).toContain("relay.ts");
    expect(result!.response).toContain("orchestrator.ts");
  });

  it("returns impact response grouped by distance", () => {
    const result = tryGraphResponse("impact de modifier memory", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("impact");
    expect(result!.response).toContain("IMPACT");
    expect(result!.response).toContain("Distance");
  });

  it("returns complexity response with score", () => {
    const result = tryGraphResponse("complexite de relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("complexity");
    expect(result!.response).toContain("COMPLEXITE");
    expect(result!.response).toContain("/10");
    expect(result!.response).toContain("Dependances directes");
  });

  it("returns related modules response", () => {
    const result = tryGraphResponse("modules lies a relay", graph);
    expect(result).toBeDefined();
    expect(result!.type).toBe("related");
    expect(result!.response).toContain("MODULES LIES");
    expect(result!.response).toContain("orchestrator.ts");
    expect(result!.response).toContain("tasks.ts");
  });

  it("returns null for LLM-required queries", () => {
    const result = tryGraphResponse("comment refactorer le bot pour supporter multi-tenant", graph);
    expect(result).toBeNull();
  });

  it("handles module with no dependents", () => {
    const result = tryGraphResponse("qui utilise help", graph);
    expect(result).toBeDefined();
    expect(result!.response).toContain("Aucun module");
  });

  it("handles module with no dependencies", () => {
    const result = tryGraphResponse("dependances de agent", graph);
    expect(result).toBeDefined();
    expect(result!.response).toContain("n'importe aucun module");
  });

  it("includes moduleId in result", () => {
    const result = tryGraphResponse("relay", graph);
    expect(result!.moduleId).toBe("src/relay.ts");
  });

  it("stats result has no moduleId", () => {
    const result = tryGraphResponse("statistiques", graph);
    expect(result!.moduleId).toBeUndefined();
  });
});

// ── Response Format Quality ──────────────────────────────────────

describe("Response formatting", () => {
  const graph = buildTestGraph();

  it("module_info includes all sections", () => {
    const result = tryGraphResponse("orchestrator", graph);
    expect(result!.response).toContain("MODULE:");
    expect(result!.response).toContain("Exports");
    expect(result!.response).toContain("Dependances");
    expect(result!.response).toContain("Utilise par");
  });

  it("dependency response shows imported symbols", () => {
    const result = tryGraphResponse("imports de relay", graph);
    expect(result!.response).toContain("orchestrate");
    expect(result!.response).toContain("createTask");
  });

  it("impact response shows distance grouping", () => {
    const result = tryGraphResponse("impact de modifier tasks", graph);
    expect(result!.response).toContain("Distance 1");
  });

  it("complexity response shows level label", () => {
    const result = tryGraphResponse("complexite de tasks", graph);
    // tasks.ts has few connections — should be faible or moderee
    expect(result!.response).toMatch(/(faible|moderee|elevee)/);
  });

  it("related response shows direction", () => {
    const result = tryGraphResponse("modules lies a orchestrator", graph);
    expect(result!.response).toMatch(/(importe|importe par|bidirectionnel)/);
  });

  it("stats response shows indexedAt date", () => {
    const result = tryGraphResponse("vue d'ensemble", graph);
    expect(result!.response).toContain("Indexe le");
  });
});
