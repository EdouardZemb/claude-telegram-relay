/**
 * Unit Tests — mcp/memory-server.ts (Orchestration MCP Tools)
 *
 * Tests for the new MCP tools: get_sprint_detail, get_metrics,
 * get_cost_summary, get_alerts, manage_feature, get_estimate, analyze_backlog.
 * Structural tests verifying tool definitions, parameter schemas,
 * dependency metadata, imports, and error handling.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const MCP_SERVER_PATH = join(import.meta.dir, "../../mcp/memory-server.ts");
const serverCode = readFileSync(MCP_SERVER_PATH, "utf-8");

describe("MCP Orchestration Tools — get_sprint_detail", () => {
  it("registers get_sprint_detail tool", () => {
    expect(serverCode).toContain('"get_sprint_detail"');
    expect(serverCode).toContain("Get full sprint status");
  });

  it("accepts optional sprint parameter", () => {
    expect(serverCode).toContain('sprint: z.string().optional().describe("Sprint ID');
  });

  it("auto-detects current sprint when omitted", () => {
    expect(serverCode).toContain("getCurrentSprint(supabase)");
  });

  it("fetches both summary and task list in parallel", () => {
    expect(serverCode).toContain("Promise.all([");
    expect(serverCode).toContain("getSprintSummary(supabase, sprintId)");
  });

  it("calculates completion rate", () => {
    expect(serverCode).toContain("completionRate");
    expect(serverCode).toContain("summary.done / summary.total");
  });

  it("includes dependency metadata in description", () => {
    expect(serverCode).toContain("Preconditions: none (root query)");
    expect(serverCode).toContain("Suggested next: get_metrics");
  });

  it("imports getCurrentSprint and getSprintSummary from tasks.ts", () => {
    expect(serverCode).toContain("getCurrentSprint");
    expect(serverCode).toContain("getSprintSummary");
    expect(serverCode).toContain('from "../src/tasks.ts"');
  });

  it("catches errors and returns error text", () => {
    const match = serverCode.match(/server\.tool\(\s*"get_sprint_detail"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — get_metrics", () => {
  it("registers get_metrics tool", () => {
    expect(serverCode).toContain('"get_metrics"');
    expect(serverCode).toContain("sprint performance metrics");
  });

  it("accepts optional sprint parameter", () => {
    const metricsSection = serverCode.slice(
      serverCode.indexOf('"get_metrics"'),
      serverCode.indexOf('"get_metrics"') + 800
    );
    expect(metricsSection).toContain("sprint: z.string().optional()");
  });

  it("queries sprint_metrics table", () => {
    expect(serverCode).toContain("sprint_metrics?sprint_id=eq.");
  });

  it("fetches recent sprints for comparison", () => {
    expect(serverCode).toContain("sprint_metrics?select=sprint_id,velocity,rework_rate,cycle_time_hours");
    expect(serverCode).toContain("order=created_at.desc&limit=3");
  });

  it("includes dependency metadata in description", () => {
    expect(serverCode).toContain("better after get_sprint_detail");
    expect(serverCode).toContain("Suggested next: get_cost_summary");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"get_metrics"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — get_cost_summary", () => {
  it("registers get_cost_summary tool", () => {
    expect(serverCode).toContain('"get_cost_summary"');
    expect(serverCode).toContain("token usage and cost breakdown");
  });

  it("accepts optional sprint parameter", () => {
    const costSection = serverCode.slice(
      serverCode.indexOf('"get_cost_summary"'),
      serverCode.indexOf('"get_cost_summary"') + 800
    );
    expect(costSection).toContain("sprint: z.string().optional()");
  });

  it("returns sprint-scoped costs when sprint provided", () => {
    expect(serverCode).toContain("getSprintCostSummary(supabase, sprint)");
  });

  it("returns total costs when sprint omitted", () => {
    expect(serverCode).toContain("getTotalCost(supabase)");
  });

  it("imports cost functions from cost-tracking.ts", () => {
    expect(serverCode).toContain("getSprintCostSummary");
    expect(serverCode).toContain("getTotalCost");
    expect(serverCode).toContain('from "../src/cost-tracking.ts"');
  });

  it("includes dependency metadata in description", () => {
    expect(serverCode).toContain("Suggested next: get_estimate");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"get_cost_summary"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — get_alerts", () => {
  it("registers get_alerts tool", () => {
    expect(serverCode).toContain('"get_alerts"');
    expect(serverCode).toContain("anomaly detection");
  });

  it("accepts optional sprint parameter", () => {
    const alertsSection = serverCode.slice(
      serverCode.indexOf('"get_alerts"'),
      serverCode.indexOf('"get_alerts"') + 800
    );
    expect(alertsSection).toContain("sprint: z.string().optional()");
  });

  it("calls runAllChecks from alerts.ts", () => {
    expect(serverCode).toContain("runAllChecks(supabase, sprintId)");
    expect(serverCode).toContain('from "../src/alerts.ts"');
  });

  it("auto-detects current sprint", () => {
    const alertsSection = serverCode.slice(
      serverCode.indexOf('"get_alerts"'),
      serverCode.indexOf('"get_alerts"') + 1200
    );
    expect(alertsSection).toContain("getCurrentSprint(supabase)");
  });

  it("returns structured alert data", () => {
    expect(serverCode).toContain("alertCount: alerts.length");
    expect(serverCode).toContain("a.severity");
    expect(serverCode).toContain("a.message");
  });

  it("includes dependency metadata in description", () => {
    const desc = serverCode.slice(
      serverCode.indexOf('"get_alerts"'),
      serverCode.indexOf('"get_alerts"') + 500
    );
    expect(desc).toContain("Preconditions: none");
    expect(desc).toContain("Suggested next:");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"get_alerts"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — manage_feature", () => {
  it("registers manage_feature tool", () => {
    expect(serverCode).toContain('"manage_feature"');
    expect(serverCode).toContain("feature flags");
  });

  it("accepts action (list/enable/disable) and optional flag name", () => {
    expect(serverCode).toContain('z.enum(["list", "enable", "disable"])');
    expect(serverCode).toContain("flag: z.string().optional()");
  });

  it("lists features on action=list", () => {
    expect(serverCode).toContain("listFeatures()");
    expect(serverCode).toContain('from "../src/feature-flags.ts"');
  });

  it("calls setFeature on enable/disable", () => {
    expect(serverCode).toContain("setFeature(flag, enabled)");
  });

  it("requires flag name for enable/disable", () => {
    expect(serverCode).toContain("flag name required for enable/disable");
  });

  it("enqueues notification on flag change", () => {
    expect(serverCode).toContain("Feature flag");
    expect(serverCode).toContain("via MCP");
  });

  it("includes dependency metadata in description", () => {
    const desc = serverCode.slice(
      serverCode.indexOf('"manage_feature"'),
      serverCode.indexOf('"manage_feature"') + 500
    );
    expect(desc).toContain("Preconditions: none (independent)");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"manage_feature"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — get_estimate", () => {
  it("registers get_estimate tool", () => {
    expect(serverCode).toContain('"get_estimate"');
    expect(serverCode).toContain("Estimate cost for a pipeline execution");
  });

  it("accepts task_count (required) and pipeline (optional)", () => {
    expect(serverCode).toContain("task_count: z.number().min(1)");
    expect(serverCode).toContain("pipeline: z.string().optional()");
  });

  it("calls estimateSprintCost from cost-estimate.ts", () => {
    expect(serverCode).toContain("estimateSprintCost(supabase, task_count,");
    expect(serverCode).toContain('from "../src/cost-estimate.ts"');
  });

  it("defaults to DEFAULT pipeline", () => {
    expect(serverCode).toContain('pipeline || "DEFAULT"');
  });

  it("includes dependency metadata in description", () => {
    const desc = serverCode.slice(
      serverCode.indexOf('"get_estimate"'),
      serverCode.indexOf('"get_estimate"') + 500
    );
    expect(desc).toContain("Preconditions:");
    expect(desc).toContain("Suggested next: task_create");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"get_estimate"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — analyze_backlog", () => {
  it("registers analyze_backlog tool", () => {
    expect(serverCode).toContain('"analyze_backlog"');
    expect(serverCode).toContain("proactive backlog analysis");
  });

  it("accepts optional sprint parameter", () => {
    const section = serverCode.slice(
      serverCode.indexOf('"analyze_backlog"'),
      serverCode.indexOf('"analyze_backlog"') + 800
    );
    expect(section).toContain("sprint: z.string().optional()");
  });

  it("calls analyzeBacklog from proactive-planner.ts", () => {
    expect(serverCode).toContain("analyzeBacklog(supabase, sprint)");
    expect(serverCode).toContain('from "../src/proactive-planner.ts"');
  });

  it("returns structured recommendations", () => {
    expect(serverCode).toContain("sprintHealth: result.sprintHealth");
    expect(serverCode).toContain("recommendationCount: result.recommendations.length");
    expect(serverCode).toContain("r.suggestedPipeline");
    expect(serverCode).toContain("r.complexityScore");
  });

  it("includes dependency metadata in description", () => {
    const desc = serverCode.slice(
      serverCode.indexOf('"analyze_backlog"'),
      serverCode.indexOf('"analyze_backlog"') + 500
    );
    expect(desc).toContain("Preconditions:");
    expect(desc).toContain("Suggested next: task_create");
  });

  it("catches errors", () => {
    const match = serverCode.match(/server\.tool\(\s*"analyze_backlog"[\s\S]*?try\s*\{[\s\S]*?catch\s*\(error\)/);
    expect(match).not.toBeNull();
  });
});

describe("MCP Orchestration Tools — Dependency Graph Metadata", () => {
  it("all new tools include Preconditions in description", () => {
    const tools = [
      "get_sprint_detail", "get_metrics", "get_cost_summary",
      "get_alerts", "manage_feature", "get_estimate", "analyze_backlog",
    ];
    for (const tool of tools) {
      const idx = serverCode.indexOf(`"${tool}"`);
      expect(idx).toBeGreaterThan(-1);
      const desc = serverCode.slice(idx, idx + 600);
      expect(desc).toContain("Preconditions:");
    }
  });

  it("all new tools include Suggested next in description", () => {
    const tools = [
      "get_sprint_detail", "get_metrics", "get_cost_summary",
      "get_alerts", "manage_feature", "get_estimate", "analyze_backlog",
    ];
    for (const tool of tools) {
      const idx = serverCode.indexOf(`"${tool}"`);
      const desc = serverCode.slice(idx, idx + 600);
      expect(desc).toContain("Suggested next:");
    }
  });

  it("get_sprint_detail suggests get_metrics and get_cost_summary", () => {
    const idx = serverCode.indexOf('"get_sprint_detail"');
    const desc = serverCode.slice(idx, idx + 400);
    expect(desc).toContain("get_metrics");
    expect(desc).toContain("get_cost_summary");
  });

  it("get_metrics suggests get_cost_summary and get_alerts", () => {
    const idx = serverCode.indexOf('"get_metrics"');
    const desc = serverCode.slice(idx, idx + 400);
    expect(desc).toContain("get_cost_summary");
    expect(desc).toContain("get_alerts");
  });

  it("get_estimate suggests task_create and get_cost_summary", () => {
    const idx = serverCode.indexOf('"get_estimate"');
    const desc = serverCode.slice(idx, idx + 400);
    expect(desc).toContain("task_create");
    expect(desc).toContain("get_cost_summary");
  });

  it("analyze_backlog suggests task_create and get_estimate", () => {
    const idx = serverCode.indexOf('"analyze_backlog"');
    const desc = serverCode.slice(idx, idx + 600);
    expect(desc).toContain("task_create");
    expect(desc).toContain("get_estimate");
  });
});

describe("MCP Orchestration Tools — Imports", () => {
  it("imports cost-tracking functions", () => {
    expect(serverCode).toContain('import { getSprintCostSummary, getTotalCost } from "../src/cost-tracking.ts"');
  });

  it("imports cost-estimate functions", () => {
    expect(serverCode).toContain('import { estimateSprintCost } from "../src/cost-estimate.ts"');
  });

  it("imports alerts functions", () => {
    expect(serverCode).toContain('import { runAllChecks } from "../src/alerts.ts"');
  });

  it("imports feature-flags functions", () => {
    expect(serverCode).toContain('import { listFeatures, setFeature } from "../src/feature-flags.ts"');
  });

  it("imports proactive-planner functions", () => {
    expect(serverCode).toContain('import { analyzeBacklog, formatPlannerResult } from "../src/proactive-planner.ts"');
  });

  it("preserves existing imports", () => {
    expect(serverCode).toContain('from "../src/tasks.ts"');
    expect(serverCode).toContain('from "../src/prd.ts"');
    expect(serverCode).toContain('from "../src/code-graph.ts"');
  });
});

describe("MCP Orchestration Tools — orchestrate_task", () => {
  it("registers orchestrate_task tool", () => {
    expect(serverCode).toContain('"orchestrate_task"');
    expect(serverCode).toContain("Run the multi-agent BMad pipeline on a task");
  });

  it("accepts task_id parameter", () => {
    expect(serverCode).toContain('task_id: z.string().describe("Task ID');
  });

  it("accepts optional pipeline parameter with valid types", () => {
    expect(serverCode).toContain('z.enum(["DEFAULT", "QUICK", "REVIEW", "SOLO", "LIGHT", "RESEARCH"])');
  });

  it("accepts optional use_blackboard parameter", () => {
    expect(serverCode).toContain("use_blackboard: z.boolean().optional()");
  });

  it("accepts optional auto_pipeline parameter", () => {
    expect(serverCode).toContain("auto_pipeline: z.boolean().optional()");
  });

  it("accepts optional resume_session_id parameter", () => {
    expect(serverCode).toContain("resume_session_id: z.string().optional()");
  });

  it("imports orchestrate and formatOrchestrationResult", () => {
    expect(serverCode).toContain('import { orchestrate, formatOrchestrationResult } from "../src/orchestrator.ts"');
  });

  it("imports pipeline constants", () => {
    expect(serverCode).toContain('import {');
    expect(serverCode).toContain("DEFAULT_PIPELINE");
    expect(serverCode).toContain("QUICK_PIPELINE");
    expect(serverCode).toContain("SOLO_PIPELINE");
    expect(serverCode).toContain("LIGHT_PIPELINE");
    expect(serverCode).toContain("RESEARCH_PIPELINE");
    expect(serverCode).toContain('from "../src/pipeline-selection.ts"');
  });

  it("defines PIPELINE_MAP for name-to-array resolution", () => {
    expect(serverCode).toContain("PIPELINE_MAP");
    expect(serverCode).toContain("DEFAULT: DEFAULT_PIPELINE");
    expect(serverCode).toContain("QUICK: QUICK_PIPELINE");
  });

  it("resolves task by ID prefix", () => {
    expect(serverCode).toContain("task_id.length < 36");
  });

  it("sends start notification via MCP pending", () => {
    expect(serverCode).toContain("Pipeline demarre via MCP");
  });

  it("sends formatted result to Telegram", () => {
    expect(serverCode).toContain("formatOrchestrationResult(result)");
  });

  it("uses onProgress callback for real-time updates", () => {
    expect(serverCode).toContain("onProgress: async (msg)");
  });

  it("defaults to auto pipeline when no pipeline specified", () => {
    expect(serverCode).toContain("const useAuto = auto_pipeline ?? (!pipeline)");
  });

  it("returns structured result with step details", () => {
    expect(serverCode).toContain("totalDurationMs: result.totalDurationMs");
    expect(serverCode).toContain("steps: result.steps.map");
  });

  it("handles errors with critical notification", () => {
    expect(serverCode).toContain("Pipeline echoue via MCP");
    expect(serverCode).toContain('severity: "critical"');
  });

  it("includes dependency metadata in tool description", () => {
    expect(serverCode).toContain("Preconditions: task must exist");
    expect(serverCode).toContain("Suggested next:");
  });
});

describe("MCP Orchestration Tools — Total Tool Count", () => {
  it("has 27 total tools registered (4 memory + 3 project + 2 blackboard + 3 graph + 2 task + 5 prd + 7 orchestration + 1 orchestrate_task)", () => {
    const toolMatches = serverCode.match(/server\.tool\(\s*"/g);
    expect(toolMatches).not.toBeNull();
    expect(toolMatches!.length).toBe(27);
  });
});
