/**
 * @module audit
 * @description Audit configuration loader and validator. Reads config/audit.json,
 * validates structure (weights sum 100%, correct types), and provides layering
 * violation detection against the code graph.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CodeGraph, GraphEdge } from "./code-graph.ts";

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const CONFIG_PATH = join(PROJECT_ROOT, "config", "audit.json");

// ── Types ────────────────────────────────────────────────────

export interface AuditWeights {
  structure: number;
  tests: number;
  architecture: number;
  debt: number;
  security: number;
  docs: number;
}

export interface GlobalThresholds {
  pass: number;
  warn: number;
}

export interface StructureThresholds {
  maxLineCount: number;
  maxComplexity: number;
}

export interface TestsThresholds {
  minCoveragePercent: number;
}

export interface DebtThresholds {
  todoMaxAgeDays: number;
}

export interface ArchitectureThresholds {
  maxDependencyCount: number;
}

export interface SecurityThresholds {
  maxAnyCount: number;
}

export interface AxisThresholds {
  structure: StructureThresholds;
  tests: TestsThresholds;
  debt: DebtThresholds;
  architecture: ArchitectureThresholds;
  security: SecurityThresholds;
}

export interface StructurePenalties {
  largeModule: number;
  highComplexity: number;
  emptyExports: number;
}

export interface DebtPenalties {
  critical: number;
  important: number;
  minor: number;
}

export interface ArchitecturePenalties {
  cycle: number;
  overCoupled: number;
}

export interface SecurityPenalties {
  important: number;
  minor: number;
}

export interface Penalties {
  structure: StructurePenalties;
  debt: DebtPenalties;
  architecture: ArchitecturePenalties;
  security: SecurityPenalties;
}

export interface LayeringRule {
  source: string;
  forbiddenTargets: string[];
  message: string;
}

export interface FixConfig {
  defaultPriority: number;
  tag: string;
}

export interface AuditConfig {
  weights: AuditWeights;
  globalThresholds: GlobalThresholds;
  axisThresholds: AxisThresholds;
  penalties: Penalties;
  layering: LayeringRule[];
  fix: FixConfig;
}

export interface AuditFinding {
  axis: string;
  severity: "warning" | "critical";
  message: string;
  file?: string;
  detail?: string;
}

// ── Defaults ─────────────────────────────────────────────────

const DEFAULT_WEIGHTS: AuditWeights = {
  structure: 20,
  tests: 20,
  architecture: 20,
  debt: 15,
  security: 15,
  docs: 10,
};

const DEFAULT_GLOBAL_THRESHOLDS: GlobalThresholds = {
  pass: 70,
  warn: 50,
};

const DEFAULT_AXIS_THRESHOLDS: AxisThresholds = {
  structure: { maxLineCount: 500, maxComplexity: 8 },
  tests: { minCoveragePercent: 80 },
  debt: { todoMaxAgeDays: 60 },
  architecture: { maxDependencyCount: 10 },
  security: { maxAnyCount: 5 },
};

const DEFAULT_PENALTIES: Penalties = {
  structure: { largeModule: 10, highComplexity: 5, emptyExports: 1 },
  debt: { critical: 5, important: 3, minor: 1 },
  architecture: { cycle: 20, overCoupled: 5 },
  security: { important: 3, minor: 1 },
};

const DEFAULT_FIX: FixConfig = {
  defaultPriority: 2,
  tag: "audit",
};

const WEIGHT_AXES = ["structure", "tests", "architecture", "debt", "security", "docs"] as const;

// ── Validation ───────────────────────────────────────────────

/**
 * Validate that the audit config has correct structure and types.
 * Throws on invalid config.
 */
export function validateAuditConfig(config: unknown): asserts config is AuditConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("Audit config must be a non-null object");
  }

  const obj = config as Record<string, unknown>;

  // Validate weights
  if (typeof obj.weights !== "object" || obj.weights === null) {
    throw new Error("Audit config: 'weights' must be an object");
  }
  const weights = obj.weights as Record<string, unknown>;
  for (const axis of WEIGHT_AXES) {
    if (typeof weights[axis] !== "number" || weights[axis] < 0) {
      throw new Error(`Audit config: weights.${axis} must be a non-negative number`);
    }
  }
  const weightSum = WEIGHT_AXES.reduce((sum, axis) => sum + (weights[axis] as number), 0);
  if (weightSum !== 100) {
    throw new Error(`Audit config: weights must total 100%, got ${weightSum}%`);
  }

  // Validate globalThresholds
  if (typeof obj.globalThresholds !== "object" || obj.globalThresholds === null) {
    throw new Error("Audit config: 'globalThresholds' must be an object");
  }
  const gt = obj.globalThresholds as Record<string, unknown>;
  if (typeof gt.pass !== "number") throw new Error("Audit config: globalThresholds.pass must be a number");
  if (typeof gt.warn !== "number") throw new Error("Audit config: globalThresholds.warn must be a number");

  // Validate axisThresholds
  if (typeof obj.axisThresholds !== "object" || obj.axisThresholds === null) {
    throw new Error("Audit config: 'axisThresholds' must be an object");
  }
  const at = obj.axisThresholds as Record<string, unknown>;
  validateNumberField(at, "structure", "maxLineCount");
  validateNumberField(at, "structure", "maxComplexity");
  validateNumberField(at, "tests", "minCoveragePercent");
  validateNumberField(at, "debt", "todoMaxAgeDays");
  validateNumberField(at, "architecture", "maxDependencyCount");
  validateNumberField(at, "security", "maxAnyCount");

  // Validate penalties
  if (typeof obj.penalties !== "object" || obj.penalties === null) {
    throw new Error("Audit config: 'penalties' must be an object");
  }

  // Validate layering
  if (!Array.isArray(obj.layering)) {
    throw new Error("Audit config: 'layering' must be an array");
  }
  for (let i = 0; i < obj.layering.length; i++) {
    const rule = obj.layering[i];
    if (typeof rule !== "object" || rule === null) {
      throw new Error(`Audit config: layering[${i}] must be an object`);
    }
    if (typeof rule.source !== "string") {
      throw new Error(`Audit config: layering[${i}].source must be a string`);
    }
    if (!Array.isArray(rule.forbiddenTargets) || !rule.forbiddenTargets.every((t: unknown) => typeof t === "string")) {
      throw new Error(`Audit config: layering[${i}].forbiddenTargets must be a string array`);
    }
    if (typeof rule.message !== "string") {
      throw new Error(`Audit config: layering[${i}].message must be a string`);
    }
  }

  // Validate fix
  if (typeof obj.fix !== "object" || obj.fix === null) {
    throw new Error("Audit config: 'fix' must be an object");
  }
  const fix = obj.fix as Record<string, unknown>;
  if (typeof fix.defaultPriority !== "number") throw new Error("Audit config: fix.defaultPriority must be a number");
  if (typeof fix.tag !== "string") throw new Error("Audit config: fix.tag must be a string");
}

function validateNumberField(parent: Record<string, unknown>, section: string, field: string): void {
  const sectionObj = parent[section] as Record<string, unknown> | undefined;
  if (typeof sectionObj !== "object" || sectionObj === null) {
    throw new Error(`Audit config: axisThresholds.${section} must be an object`);
  }
  if (typeof sectionObj[field] !== "number") {
    throw new Error(`Audit config: axisThresholds.${section}.${field} must be a number`);
  }
}

// ── Loader ───────────────────────────────────────────────────

let configCache: AuditConfig | null = null;

/**
 * Load and validate audit config from config/audit.json.
 * Returns validated AuditConfig. Caches result in memory.
 * @param configPath Override path for testing
 */
export function loadAuditConfig(configPath?: string): AuditConfig {
  if (configCache && !configPath) return configCache;

  const path = configPath || CONFIG_PATH;

  if (!existsSync(path)) {
    const defaultConfig = buildDefaultConfig();
    if (!configPath) configCache = defaultConfig;
    return defaultConfig;
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);

  validateAuditConfig(parsed);

  if (!configPath) configCache = parsed;
  return parsed;
}

/**
 * Build a default config (all defaults, weights sum 100%).
 */
export function buildDefaultConfig(): AuditConfig {
  return {
    weights: { ...DEFAULT_WEIGHTS },
    globalThresholds: { ...DEFAULT_GLOBAL_THRESHOLDS },
    axisThresholds: JSON.parse(JSON.stringify(DEFAULT_AXIS_THRESHOLDS)),
    penalties: JSON.parse(JSON.stringify(DEFAULT_PENALTIES)),
    layering: [],
    fix: { ...DEFAULT_FIX },
  };
}

/**
 * Clear the config cache (for testing).
 */
export function clearAuditConfigCache(): void {
  configCache = null;
}

// ── Threshold helpers ────────────────────────────────────────

/**
 * Get axis thresholds with fallback to defaults.
 */
export function getAxisThresholds(config: AuditConfig): AxisThresholds {
  return {
    structure: {
      maxLineCount: config.axisThresholds?.structure?.maxLineCount ?? DEFAULT_AXIS_THRESHOLDS.structure.maxLineCount,
      maxComplexity: config.axisThresholds?.structure?.maxComplexity ?? DEFAULT_AXIS_THRESHOLDS.structure.maxComplexity,
    },
    tests: {
      minCoveragePercent: config.axisThresholds?.tests?.minCoveragePercent ?? DEFAULT_AXIS_THRESHOLDS.tests.minCoveragePercent,
    },
    debt: {
      todoMaxAgeDays: config.axisThresholds?.debt?.todoMaxAgeDays ?? DEFAULT_AXIS_THRESHOLDS.debt.todoMaxAgeDays,
    },
    architecture: {
      maxDependencyCount: config.axisThresholds?.architecture?.maxDependencyCount ?? DEFAULT_AXIS_THRESHOLDS.architecture.maxDependencyCount,
    },
    security: {
      maxAnyCount: config.axisThresholds?.security?.maxAnyCount ?? DEFAULT_AXIS_THRESHOLDS.security.maxAnyCount,
    },
  };
}

/**
 * Get penalties with fallback to defaults.
 */
export function getPenalties(config: AuditConfig): Penalties {
  return {
    structure: {
      largeModule: config.penalties?.structure?.largeModule ?? DEFAULT_PENALTIES.structure.largeModule,
      highComplexity: config.penalties?.structure?.highComplexity ?? DEFAULT_PENALTIES.structure.highComplexity,
      emptyExports: config.penalties?.structure?.emptyExports ?? DEFAULT_PENALTIES.structure.emptyExports,
    },
    debt: {
      critical: config.penalties?.debt?.critical ?? DEFAULT_PENALTIES.debt.critical,
      important: config.penalties?.debt?.important ?? DEFAULT_PENALTIES.debt.important,
      minor: config.penalties?.debt?.minor ?? DEFAULT_PENALTIES.debt.minor,
    },
    architecture: {
      cycle: config.penalties?.architecture?.cycle ?? DEFAULT_PENALTIES.architecture.cycle,
      overCoupled: config.penalties?.architecture?.overCoupled ?? DEFAULT_PENALTIES.architecture.overCoupled,
    },
    security: {
      important: config.penalties?.security?.important ?? DEFAULT_PENALTIES.security.important,
      minor: config.penalties?.security?.minor ?? DEFAULT_PENALTIES.security.minor,
    },
  };
}

// ── Layering check ───────────────────────────────────────────

/**
 * Check code graph edges against layering rules.
 * Returns AuditFinding for each violation detected.
 */
export function checkLayeringViolations(
  graph: CodeGraph,
  rules: LayeringRule[]
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const edge of graph.edges) {
    for (const rule of rules) {
      if (!edge.source.startsWith(rule.source)) continue;

      for (const forbidden of rule.forbiddenTargets) {
        if (edge.target.startsWith(forbidden)) {
          findings.push({
            axis: "architecture",
            severity: "critical",
            message: rule.message,
            file: edge.source,
            detail: `${edge.source} -> ${edge.target} violates layering: ${rule.source} must not import ${forbidden}`,
          });
        }
      }
    }
  }

  return findings;
}
