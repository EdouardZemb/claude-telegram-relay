/**
 * Unit Tests — S44 T9: Tavily Web Research Integration
 *
 * Tests for Tavily MCP config, web research detection, RESEARCH pipeline,
 * and router/DAG support for the new pipeline type.
 */

import { describe, it, expect } from "bun:test";
import {
  getMcpToolsForRole,
  getMcpAllowedToolNames,
  buildMcpToolInstructions,
  isToolAllowed,
  getTavilyToolsForRole,
  getTavilyAllowedToolNames,
  TAVILY_TOOLS,
} from "../../src/mcp-config";
import { detectWebResearchIntent } from "../../src/commands/exploration";
import {
  selectPipeline,
  classifyPipeline,
  RESEARCH_PIPELINE,
  SOLO_PIPELINE,
  LIGHT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  DEFAULT_PIPELINE,
  type PipelineType,
} from "../../src/orchestrator";
import {
  getDAG,
  RESEARCH_DAG,
} from "../../src/dag-executor";
import {
  parseRouterResponse,
  routerPipelineToRoles,
} from "../../src/llm-router";
import { getAction } from "../../src/action-registry";
import { detectIntent } from "../../src/intent-detection";

// ── Tavily MCP Config ──────────────────────────────────────────

describe("Tavily MCP Tool Registry", () => {
  it("defines tavily_search and tavily_extract", () => {
    expect(TAVILY_TOOLS).toContain("tavily_search");
    expect(TAVILY_TOOLS).toContain("tavily_extract");
    expect(TAVILY_TOOLS.length).toBe(2);
  });

  it("explorer role has Tavily access", () => {
    const tools = getTavilyToolsForRole("explorer");
    expect(tools).toContain("tavily_search");
    expect(tools).toContain("tavily_extract");
  });

  it("other roles have no Tavily access", () => {
    for (const role of ["analyst", "pm", "architect", "dev", "qa", "sm", "planner"]) {
      const tools = getTavilyToolsForRole(role);
      expect(tools).toEqual([]);
    }
  });

  it("returns mcp__tavily__ prefixed names for explorer", () => {
    const names = getTavilyAllowedToolNames("explorer");
    expect(names).toContain("mcp__tavily__tavily_search");
    expect(names).toContain("mcp__tavily__tavily_extract");
  });

  it("getMcpAllowedToolNames includes both memory and Tavily tools for explorer", () => {
    const all = getMcpAllowedToolNames("explorer");
    // Memory tools
    expect(all.some((t: string) => t.startsWith("mcp__memory__"))).toBe(true);
    // Tavily tools
    expect(all).toContain("mcp__tavily__tavily_search");
    expect(all).toContain("mcp__tavily__tavily_extract");
  });

  it("getMcpAllowedToolNames has no Tavily tools for dev", () => {
    const all = getMcpAllowedToolNames("dev");
    expect(all.every((t: string) => !t.includes("tavily"))).toBe(true);
  });
});

describe("Tavily MCP Instructions", () => {
  it("explorer instructions include Tavily section", () => {
    const instructions = buildMcpToolInstructions("explorer");
    expect(instructions).toContain("TAVILY");
    expect(instructions).toContain("tavily_search");
    expect(instructions).toContain("tavily_extract");
    expect(instructions).toContain("GUIDE TAVILY");
  });

  it("dev instructions do not include Tavily section", () => {
    const instructions = buildMcpToolInstructions("dev");
    expect(instructions).not.toContain("TAVILY");
    expect(instructions).not.toContain("tavily_search");
  });

  it("analyst instructions do not include Tavily section", () => {
    const instructions = buildMcpToolInstructions("analyst");
    expect(instructions).not.toContain("TAVILY");
  });
});

// ── Web Research Detection ─────────────────────────────────────

describe("detectWebResearchIntent", () => {
  it("detects API-related queries", () => {
    expect(detectWebResearchIntent("quelles api de caching existent")).toBe(true);
    expect(detectWebResearchIntent("compare les alternatives API")).toBe(true);
  });

  it("detects library/framework queries", () => {
    expect(detectWebResearchIntent("quelle library pour le parsing")).toBe(true);
    expect(detectWebResearchIntent("quel framework de test utiliser")).toBe(true);
  });

  it("detects benchmark/comparison queries", () => {
    expect(detectWebResearchIntent("benchmark des solutions de cache")).toBe(true);
    expect(detectWebResearchIntent("comparaison redis vs memcached")).toBe(true);
    expect(detectWebResearchIntent("comparatif des outils de CI")).toBe(true);
  });

  it("detects state of the art queries", () => {
    expect(detectWebResearchIntent("state of the art en orchestration")).toBe(true);
    expect(detectWebResearchIntent("etat de l'art des pipelines")).toBe(true);
  });

  it("detects tool/package queries", () => {
    expect(detectWebResearchIntent("quel outil pour le monitoring")).toBe(true);
    expect(detectWebResearchIntent("package npm pour le websocket")).toBe(true);
  });

  it("detects open source/solution queries", () => {
    expect(detectWebResearchIntent("solution open source de logging")).toBe(true);
    expect(detectWebResearchIntent("alternative a datadog")).toBe(true);
  });

  it("returns false for code-only queries", () => {
    expect(detectWebResearchIntent("comment fonctionne le module relay")).toBe(false);
    expect(detectWebResearchIntent("dependances de orchestrator")).toBe(false);
    expect(detectWebResearchIntent("qui utilise memory.ts")).toBe(false);
    expect(detectWebResearchIntent("impact de modifier tasks")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(detectWebResearchIntent("BENCHMARK des Solutions")).toBe(true);
    expect(detectWebResearchIntent("Alternative A Redis")).toBe(true);
  });
});

// ── RESEARCH Pipeline ──────────────────────────────────────────

describe("RESEARCH Pipeline Definition", () => {
  it("has explorer -> planner -> dev -> qa sequence", () => {
    expect(RESEARCH_PIPELINE).toEqual(["explorer", "planner", "dev", "qa"]);
  });
});

describe("RESEARCH Pipeline Selection", () => {
  function makeTask(title: string, desc?: string, priority?: number) {
    return {
      id: "test",
      title,
      description: desc || null,
      priority: priority || 3,
      status: "backlog" as const,
      subtasks: null,
    } as any;
  }

  it("selects RESEARCH for research-keyword tasks", () => {
    const task = makeTask("Research caching solutions");
    const pipeline = selectPipeline(task);
    expect(pipeline).toEqual(RESEARCH_PIPELINE);
  });

  it("selects RESEARCH for French research keywords", () => {
    expect(selectPipeline(makeTask("Recherche alternatives a Redis"))).toEqual(RESEARCH_PIPELINE);
    expect(selectPipeline(makeTask("Etude des solutions de monitoring"))).toEqual(RESEARCH_PIPELINE);
    expect(selectPipeline(makeTask("Comparer les frameworks de test"))).toEqual(RESEARCH_PIPELINE);
  });

  it("selects RESEARCH for benchmark tasks", () => {
    expect(selectPipeline(makeTask("Benchmark des solutions de cache"))).toEqual(RESEARCH_PIPELINE);
  });

  it("selects RESEARCH for state of the art tasks", () => {
    expect(selectPipeline(makeTask("State of the art en CI/CD"))).toEqual(RESEARCH_PIPELINE);
    expect(selectPipeline(makeTask("Etat de l'art des orchestrateurs"))).toEqual(RESEARCH_PIPELINE);
  });

  it("does not select RESEARCH for bug fix tasks", () => {
    expect(selectPipeline(makeTask("Fix crash on startup"))).toEqual(QUICK_PIPELINE);
  });

  it("does not select RESEARCH for review tasks", () => {
    expect(selectPipeline(makeTask("Audit du code de auth"))).toEqual(REVIEW_PIPELINE);
  });

  it("explicit pipeline overrides research detection", () => {
    const task = makeTask("Research caching solutions");
    const pipeline = selectPipeline(task, ["dev", "qa"]);
    expect(pipeline).toEqual(["dev", "qa"]);
  });
});

describe("classifyPipeline with RESEARCH", () => {
  function makeTask(title: string, desc?: string) {
    return { id: "t", title, description: desc || null, priority: 3, status: "backlog" as const, subtasks: null } as any;
  }

  it("classifies research tasks as RESEARCH", () => {
    expect(classifyPipeline(makeTask("Research new auth library"))).toBe("RESEARCH");
    expect(classifyPipeline(makeTask("Benchmark solutions de cache"))).toBe("RESEARCH");
    expect(classifyPipeline(makeTask("Comparer Redis vs Memcached"))).toBe("RESEARCH");
  });

  it("classifies bug tasks as QUICK (not RESEARCH)", () => {
    expect(classifyPipeline(makeTask("Fix login bug"))).toBe("QUICK");
  });

  it("RESEARCH type is valid PipelineType", () => {
    const ptype: PipelineType = "RESEARCH";
    expect(ptype).toBe("RESEARCH");
  });
});

// ── RESEARCH DAG ───────────────────────────────────────────────

describe("RESEARCH DAG", () => {
  it("defines explorer -> planner -> dev -> qa dependency chain", () => {
    expect(RESEARCH_DAG.get("explorer")).toEqual([]);
    expect(RESEARCH_DAG.get("planner")).toEqual(["explorer"]);
    expect(RESEARCH_DAG.get("dev")).toEqual(["planner"]);
    expect(RESEARCH_DAG.get("qa")).toEqual(["dev"]);
  });

  it("has 4 nodes", () => {
    expect(RESEARCH_DAG.size).toBe(4);
  });

  it("getDAG returns RESEARCH DAG for RESEARCH type", () => {
    const dag = getDAG("RESEARCH");
    expect(dag.has("explorer")).toBe(true);
    expect(dag.has("planner")).toBe(true);
    expect(dag.has("dev")).toBe(true);
    expect(dag.has("qa")).toBe(true);
    expect(dag.get("explorer")).toEqual([]);
    expect(dag.get("planner")).toEqual(["explorer"]);
  });
});

// ── LLM Router RESEARCH Support ────────────────────────────────

describe("LLM Router RESEARCH pipeline", () => {
  it("parses RESEARCH pipeline from router response", () => {
    const output = JSON.stringify({
      pipeline: "RESEARCH",
      models: {
        explorer: "claude-sonnet-4-6",
        planner: "claude-sonnet-4-6",
        dev: "claude-sonnet-4-6",
        qa: "claude-haiku-4-5",
      },
      budget: 3.0,
      reasoning: "Research task needs explorer",
    });
    const decision = parseRouterResponse(output);
    expect(decision).not.toBeNull();
    expect(decision!.pipeline).toBe("RESEARCH");
  });

  it("maps RESEARCH to explorer -> planner -> dev -> qa roles", () => {
    const roles = routerPipelineToRoles({
      pipeline: "RESEARCH",
      models: {},
      budget: 3.0,
      reasoning: "",
    });
    expect(roles).toEqual(["explorer", "planner", "dev", "qa"]);
  });
});

// ── Action Registry Research Aliases ───────────────────────────

describe("explore action research aliases", () => {
  it("has research-related aliases", () => {
    const action = getAction("explore");
    expect(action).toBeDefined();
    expect(action!.aliases).toContain("rechercher");
    expect(action!.aliases).toContain("comparer");
    expect(action!.aliases).toContain("benchmark");
    expect(action!.aliases).toContain("state of the art");
    expect(action!.aliases).toContain("etat de l'art");
    expect(action!.aliases).toContain("alternative");
  });
});

// ── Intent Detection Research Patterns ─────────────────────────

describe("Intent detection research patterns", () => {
  it("detects research intent in French", () => {
    const result = detectIntent("recherche des alternatives a Redis");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("explore");
  });

  it("detects benchmark intent", () => {
    const result = detectIntent("benchmark les solutions de cache");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("explore");
  });

  it("detects compare intent", () => {
    const result = detectIntent("comparer les frameworks de test");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("explore");
  });

  it("detects state of the art intent", () => {
    const result = detectIntent("state of the art en orchestration multi-agents");
    expect(result.detected).not.toBeNull();
    expect(result.detected!.command).toBe("explore");
  });
});

