/**
 * Tests for audit config loader and validator.
 * Covers AC-1 (weights sum 100%), AC-2 (layering violations),
 * AC-3 (custom thresholds), AC-4 (JSON structure validation).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  loadAuditConfig,
  validateAuditConfig,
  buildDefaultConfig,
  clearAuditConfigCache,
  checkLayeringViolations,
  getAxisThresholds,
  getPenalties,
  type AuditConfig,
  type AuditFinding,
  type LayeringRule,
} from "../../src/audit.ts";
import type { CodeGraph } from "../../src/code-graph.ts";

const TMP_DIR = join(process.cwd(), "tests", "tmp");
const TMP_CONFIG = join(TMP_DIR, "audit-test.json");

function writeTestConfig(config: unknown): string {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(TMP_CONFIG, JSON.stringify(config, null, 2), "utf-8");
  return TMP_CONFIG;
}

function cleanupTestConfig(): void {
  if (existsSync(TMP_CONFIG)) unlinkSync(TMP_CONFIG);
}

function validConfig(): AuditConfig {
  return {
    weights: { structure: 20, tests: 20, architecture: 20, debt: 15, security: 15, docs: 10 },
    globalThresholds: { pass: 70, warn: 50 },
    axisThresholds: {
      structure: { maxLineCount: 1000, maxComplexity: 8 },
      tests: { minCoveragePercent: 80 },
      debt: { todoMaxAgeDays: 60 },
      architecture: { maxDependencyCount: 10 },
      security: { maxAnyCount: 5 },
    },
    penalties: {
      structure: { largeModule: 10, highComplexity: 5, emptyExports: 1 },
      debt: { critical: 5, important: 3, minor: 1 },
      architecture: { cycle: 20, overCoupled: 5 },
      security: { important: 3, minor: 1 },
    },
    layering: [
      {
        source: "src/commands/",
        forbiddenTargets: ["db/"],
        message: "Composers must not import database layer directly",
      },
    ],
    fix: { defaultPriority: 2, tag: "audit" },
  };
}

function makeGraph(edges: Array<{ source: string; target: string }>): CodeGraph {
  return {
    nodes: [],
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      imports: [],
      isTypeOnly: false,
    })),
    indexedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  clearAuditConfigCache();
});

afterEach(() => {
  cleanupTestConfig();
  clearAuditConfigCache();
});

// ── AC-1: Weights total 100% ────────────────────────────────

describe("AC-1: weights total 100%", () => {
  it("accepts config where weights sum to 100", () => {
    const config = validConfig();
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    const sum = Object.values(loaded.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("rejects config where weights sum to 90", () => {
    const config = validConfig();
    config.weights.docs = 0; // 20+20+20+15+15+0 = 90
    const path = writeTestConfig(config);
    expect(() => loadAuditConfig(path)).toThrow("weights must total 100%");
  });

  it("rejects config where weights sum to 110", () => {
    const config = validConfig();
    config.weights.docs = 20; // 20+20+20+15+15+20 = 110
    const path = writeTestConfig(config);
    expect(() => loadAuditConfig(path)).toThrow("weights must total 100%");
  });

  it("loads default config with weights summing to 100 when file missing", () => {
    const loaded = loadAuditConfig(join(TMP_DIR, "nonexistent.json"));
    const sum = Object.values(loaded.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("validates all 6 axis keys are present in weights", () => {
    const config = validConfig();
    expect(config.weights).toHaveProperty("structure");
    expect(config.weights).toHaveProperty("tests");
    expect(config.weights).toHaveProperty("architecture");
    expect(config.weights).toHaveProperty("debt");
    expect(config.weights).toHaveProperty("security");
    expect(config.weights).toHaveProperty("docs");
  });

  it("loads the actual config/audit.json and weights sum to 100", () => {
    clearAuditConfigCache();
    const loaded = loadAuditConfig();
    const sum = Object.values(loaded.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});

// ── AC-2: Layering violations ────────────────────────────────

describe("AC-2: layering violation detection", () => {
  it("detects commands/ -> db/ violation", () => {
    const rules: LayeringRule[] = [
      {
        source: "src/commands/",
        forbiddenTargets: ["db/"],
        message: "Composers must not import database layer directly",
      },
    ];
    const graph = makeGraph([
      { source: "src/commands/tasks.ts", target: "db/schema.ts" },
    ]);

    const findings = checkLayeringViolations(graph, rules);
    expect(findings).toHaveLength(1);
    expect(findings[0].axis).toBe("architecture");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toBe("Composers must not import database layer directly");
    expect(findings[0].file).toBe("src/commands/tasks.ts");
    expect(findings[0].detail).toContain("src/commands/tasks.ts -> db/schema.ts");
  });

  it("does not flag valid imports from commands/", () => {
    const rules: LayeringRule[] = [
      {
        source: "src/commands/",
        forbiddenTargets: ["db/"],
        message: "Composers must not import database layer directly",
      },
    ];
    const graph = makeGraph([
      { source: "src/commands/tasks.ts", target: "src/tasks.ts" },
    ]);

    const findings = checkLayeringViolations(graph, rules);
    expect(findings).toHaveLength(0);
  });

  it("does not flag edges from non-matching sources", () => {
    const rules: LayeringRule[] = [
      {
        source: "src/commands/",
        forbiddenTargets: ["db/"],
        message: "test",
      },
    ];
    const graph = makeGraph([
      { source: "src/orchestrator.ts", target: "db/schema.ts" },
    ]);

    const findings = checkLayeringViolations(graph, rules);
    expect(findings).toHaveLength(0);
  });

  it("detects multiple violations in a single graph", () => {
    const rules: LayeringRule[] = [
      {
        source: "src/commands/",
        forbiddenTargets: ["db/"],
        message: "No DB from commands",
      },
      {
        source: "mcp/",
        forbiddenTargets: ["src/commands/"],
        message: "MCP must not import commands",
      },
    ];
    const graph = makeGraph([
      { source: "src/commands/audit.ts", target: "db/migrations.ts" },
      { source: "mcp/memory-server.ts", target: "src/commands/help.ts" },
    ]);

    const findings = checkLayeringViolations(graph, rules);
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toBe("No DB from commands");
    expect(findings[1].message).toBe("MCP must not import commands");
  });

  it("detects violation for multiple forbidden targets in one rule", () => {
    const rules: LayeringRule[] = [
      {
        source: "supabase/functions/",
        forbiddenTargets: ["src/"],
        message: "Edge Functions must not import source modules",
      },
    ];
    const graph = makeGraph([
      { source: "supabase/functions/embed/index.ts", target: "src/memory.ts" },
    ]);

    const findings = checkLayeringViolations(graph, rules);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("Edge Functions must not import source modules");
  });

  it("returns empty findings for empty rules", () => {
    const graph = makeGraph([
      { source: "src/commands/tasks.ts", target: "db/schema.ts" },
    ]);
    const findings = checkLayeringViolations(graph, []);
    expect(findings).toHaveLength(0);
  });

  it("returns empty findings for empty graph", () => {
    const rules: LayeringRule[] = [
      { source: "src/commands/", forbiddenTargets: ["db/"], message: "test" },
    ];
    const findings = checkLayeringViolations({ nodes: [], edges: [], indexedAt: "" }, rules);
    expect(findings).toHaveLength(0);
  });

  it("uses layering rules from loaded config", () => {
    const config = validConfig();
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    const graph = makeGraph([
      { source: "src/commands/tasks.ts", target: "db/schema.ts" },
    ]);

    const findings = checkLayeringViolations(graph, loaded.layering);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toBe("Composers must not import database layer directly");
  });
});

// ── AC-3: Custom thresholds override defaults ────────────────

describe("AC-3: custom thresholds", () => {
  it("uses custom maxLineCount from config", () => {
    const config = validConfig();
    config.axisThresholds.structure.maxLineCount = 800;
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    const thresholds = getAxisThresholds(loaded);

    // 750 lines < 800 threshold = no warning
    expect(750 < thresholds.structure.maxLineCount).toBe(true);
  });

  it("default maxLineCount is 500 in buildDefaultConfig", () => {
    const defaults = buildDefaultConfig();
    const thresholds = getAxisThresholds(defaults);
    expect(thresholds.structure.maxLineCount).toBe(500);
  });

  it("config maxLineCount=1000 overrides default 500", () => {
    const config = validConfig();
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    expect(loaded.axisThresholds.structure.maxLineCount).toBe(1000);
  });

  it("750-line module passes with 800 threshold, would fail with 500 default", () => {
    const config = validConfig();
    config.axisThresholds.structure.maxLineCount = 800;
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);

    const moduleLineCount = 750;
    const customThreshold = loaded.axisThresholds.structure.maxLineCount;
    const defaultThreshold = 500;

    expect(moduleLineCount < customThreshold).toBe(true); // no warning with custom
    expect(moduleLineCount >= defaultThreshold).toBe(true); // would warn with default
  });

  it("custom minCoveragePercent overrides default", () => {
    const config = validConfig();
    config.axisThresholds.tests.minCoveragePercent = 90;
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    expect(loaded.axisThresholds.tests.minCoveragePercent).toBe(90);
  });

  it("custom maxDependencyCount overrides default", () => {
    const config = validConfig();
    config.axisThresholds.architecture.maxDependencyCount = 15;
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    expect(loaded.axisThresholds.architecture.maxDependencyCount).toBe(15);
  });

  it("custom penalties override defaults", () => {
    const config = validConfig();
    config.penalties.structure.largeModule = 15;
    const path = writeTestConfig(config);
    const loaded = loadAuditConfig(path);
    const penalties = getPenalties(loaded);
    expect(penalties.structure.largeModule).toBe(15);
  });

  it("getAxisThresholds returns all sections", () => {
    const config = validConfig();
    const thresholds = getAxisThresholds(config);
    expect(thresholds.structure).toBeDefined();
    expect(thresholds.tests).toBeDefined();
    expect(thresholds.debt).toBeDefined();
    expect(thresholds.architecture).toBeDefined();
    expect(thresholds.security).toBeDefined();
  });

  it("getPenalties returns all sections", () => {
    const config = validConfig();
    const penalties = getPenalties(config);
    expect(penalties.structure).toBeDefined();
    expect(penalties.debt).toBeDefined();
    expect(penalties.architecture).toBeDefined();
    expect(penalties.security).toBeDefined();
  });
});

// ── AC-4: JSON structure validation ──────────────────────────

describe("AC-4: JSON structure validation", () => {
  it("accepts valid config", () => {
    const config = validConfig();
    expect(() => validateAuditConfig(config)).not.toThrow();
  });

  it("rejects null", () => {
    expect(() => validateAuditConfig(null)).toThrow("non-null object");
  });

  it("rejects string", () => {
    expect(() => validateAuditConfig("not an object")).toThrow("non-null object");
  });

  it("rejects missing weights", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.weights;
    expect(() => validateAuditConfig(config)).toThrow("weights");
  });

  it("rejects non-numeric weight", () => {
    const config = validConfig();
    (config.weights as any).structure = "twenty";
    expect(() => validateAuditConfig(config)).toThrow("weights.structure must be a non-negative number");
  });

  it("rejects negative weight", () => {
    const config = validConfig();
    config.weights.structure = -5;
    expect(() => validateAuditConfig(config)).toThrow("weights.structure must be a non-negative number");
  });

  it("rejects missing globalThresholds", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.globalThresholds;
    expect(() => validateAuditConfig(config)).toThrow("globalThresholds");
  });

  it("rejects non-numeric globalThresholds.pass", () => {
    const config = validConfig();
    (config.globalThresholds as any).pass = "high";
    expect(() => validateAuditConfig(config)).toThrow("globalThresholds.pass must be a number");
  });

  it("rejects missing axisThresholds", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.axisThresholds;
    expect(() => validateAuditConfig(config)).toThrow("axisThresholds");
  });

  it("rejects non-numeric axisThresholds.structure.maxLineCount", () => {
    const config = validConfig();
    (config.axisThresholds.structure as any).maxLineCount = "big";
    expect(() => validateAuditConfig(config)).toThrow("axisThresholds.structure.maxLineCount must be a number");
  });

  it("rejects missing penalties", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.penalties;
    expect(() => validateAuditConfig(config)).toThrow("penalties");
  });

  it("rejects non-array layering", () => {
    const config = validConfig();
    (config as any).layering = "not an array";
    expect(() => validateAuditConfig(config)).toThrow("layering");
  });

  it("rejects layering rule with missing source", () => {
    const config = validConfig();
    config.layering = [{ forbiddenTargets: ["db/"], message: "test" } as any];
    expect(() => validateAuditConfig(config)).toThrow("layering[0].source must be a string");
  });

  it("rejects layering rule with non-array forbiddenTargets", () => {
    const config = validConfig();
    config.layering = [{ source: "src/", forbiddenTargets: "db/", message: "test" } as any];
    expect(() => validateAuditConfig(config)).toThrow("layering[0].forbiddenTargets must be a string array");
  });

  it("rejects layering rule with non-string in forbiddenTargets", () => {
    const config = validConfig();
    config.layering = [{ source: "src/", forbiddenTargets: [42], message: "test" } as any];
    expect(() => validateAuditConfig(config)).toThrow("layering[0].forbiddenTargets must be a string array");
  });

  it("rejects layering rule with missing message", () => {
    const config = validConfig();
    config.layering = [{ source: "src/", forbiddenTargets: ["db/"] } as any];
    expect(() => validateAuditConfig(config)).toThrow("layering[0].message must be a string");
  });

  it("rejects missing fix", () => {
    const config = validConfig() as Record<string, unknown>;
    delete config.fix;
    expect(() => validateAuditConfig(config)).toThrow("fix");
  });

  it("rejects non-numeric fix.defaultPriority", () => {
    const config = validConfig();
    (config.fix as any).defaultPriority = "high";
    expect(() => validateAuditConfig(config)).toThrow("fix.defaultPriority must be a number");
  });

  it("rejects non-string fix.tag", () => {
    const config = validConfig();
    (config.fix as any).tag = 123;
    expect(() => validateAuditConfig(config)).toThrow("fix.tag must be a string");
  });

  it("accepts empty layering array", () => {
    const config = validConfig();
    config.layering = [];
    expect(() => validateAuditConfig(config)).not.toThrow();
  });

  it("validates all field types in the actual config/audit.json", () => {
    clearAuditConfigCache();
    const loaded = loadAuditConfig();
    expect(() => validateAuditConfig(loaded)).not.toThrow();
    expect(typeof loaded.weights.structure).toBe("number");
    expect(typeof loaded.globalThresholds.pass).toBe("number");
    expect(typeof loaded.axisThresholds.structure.maxLineCount).toBe("number");
    expect(typeof loaded.penalties.structure.largeModule).toBe("number");
    expect(Array.isArray(loaded.layering)).toBe(true);
    expect(typeof loaded.fix.tag).toBe("string");
  });
});

// ── Config loading edge cases ────────────────────────────────

describe("config loading", () => {
  it("caches config after first load", () => {
    const config = validConfig();
    const path = writeTestConfig(config);
    const first = loadAuditConfig(path);
    const second = loadAuditConfig(path);
    expect(first).toEqual(second);
  });

  it("clearAuditConfigCache forces reload", () => {
    const config = validConfig();
    const path = writeTestConfig(config);
    loadAuditConfig(path);
    clearAuditConfigCache();
    // Modify the file
    config.axisThresholds.structure.maxLineCount = 2000;
    writeTestConfig(config);
    const reloaded = loadAuditConfig(path);
    expect(reloaded.axisThresholds.structure.maxLineCount).toBe(2000);
  });

  it("returns default config when file does not exist", () => {
    const loaded = loadAuditConfig(join(TMP_DIR, "nonexistent.json"));
    expect(loaded.weights).toEqual({ structure: 20, tests: 20, architecture: 20, debt: 15, security: 15, docs: 10 });
  });

  it("buildDefaultConfig weights sum to 100", () => {
    const defaults = buildDefaultConfig();
    const sum = Object.values(defaults.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });

  it("throws on invalid JSON syntax", () => {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(TMP_CONFIG, "{ invalid json }", "utf-8");
    expect(() => loadAuditConfig(TMP_CONFIG)).toThrow();
  });
});
