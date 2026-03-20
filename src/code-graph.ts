/**
 * @module code-graph
 * @description Knowledge graph of the codebase: modules, exports, imports, dependencies.
 * Regex-based indexer extracts structure from TypeScript files. Provides graph queries
 * for agent context injection, impact analysis, and complexity estimation.
 * S39.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";

const PROJECT_ROOT = process.env.PROJECT_DIR || process.cwd();
const GRAPH_CACHE_PATH = join(PROJECT_ROOT, "config", "code-graph.json");

// ── Types ────────────────────────────────────────────────────

export interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "default";
}

export interface GraphNode {
  id: string; // relative path: "src/relay.ts"
  exports: ExportedSymbol[];
  lineCount: number;
}

export interface GraphEdge {
  source: string; // importer (relative path)
  target: string; // imported module (relative path)
  imports: string[]; // imported symbol names
  isTypeOnly: boolean;
}

export interface CodeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexedAt: string;
  commitHash?: string;
}

export interface GraphStats {
  totalModules: number;
  totalEdges: number;
  totalExports: number;
  avgDependencies: number;
  mostConnected: Array<{ module: string; connections: number }>;
}

export interface FunctionInfo {
  name: string;
  startLine: number;
  lineCount: number;
  complexity: number;
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Extract exported symbols from a TypeScript source file.
 */
export function extractExports(content: string): ExportedSymbol[] {
  const exports: ExportedSymbol[] = [];
  const seen = new Set<string>();

  const patterns: Array<{ regex: RegExp; kind: ExportedSymbol["kind"] }> = [
    { regex: /^export\s+(?:async\s+)?function\s+(\w+)/gm, kind: "function" },
    { regex: /^export\s+class\s+(\w+)/gm, kind: "class" },
    { regex: /^export\s+interface\s+(\w+)/gm, kind: "interface" },
    { regex: /^export\s+type\s+(\w+)\s*[=<]/gm, kind: "type" },
    { regex: /^export\s+(?:const|let|var)\s+(\w+)/gm, kind: "const" },
  ];

  for (const { regex, kind } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        exports.push({ name, kind });
      }
    }
  }

  // Default export
  const defaultMatch = content.match(/^export\s+default\s+(?:function\s+)?(\w+)?/m);
  if (defaultMatch) {
    const name = defaultMatch[1] || "default";
    if (!seen.has(name)) {
      exports.push({ name, kind: "default" });
    }
  }

  return exports;
}

/**
 * Extract import edges from a TypeScript source file.
 * Only tracks local imports (starting with ./ or ../).
 */
export function extractImports(
  content: string,
  sourceFile: string
): Array<{ target: string; imports: string[]; isTypeOnly: boolean }> {
  const results: Array<{ target: string; imports: string[]; isTypeOnly: boolean }> = [];
  const sourceDir = dirname(sourceFile);

  const regex = /^import\s+(type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/gm;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const isTypeOnly = !!match[1];
    const namedImports = match[2];
    const defaultImport = match[3];
    const fromPath = match[4];

    // Only track local imports
    if (!fromPath.startsWith("./") && !fromPath.startsWith("../")) continue;

    // Resolve relative path
    let resolvedPath = resolve(join(PROJECT_ROOT, sourceDir), fromPath);
    // Make relative to project root
    let targetRelative = relative(PROJECT_ROOT, resolvedPath);

    // Normalize: ensure .ts extension
    if (!targetRelative.endsWith(".ts")) {
      targetRelative += ".ts";
    }

    const importNames: string[] = [];
    if (namedImports) {
      for (const name of namedImports.split(",")) {
        const trimmed = name.trim().replace(/\s+as\s+\w+/, "");
        if (trimmed) importNames.push(trimmed);
      }
    }
    if (defaultImport) {
      importNames.push(defaultImport);
    }

    results.push({
      target: targetRelative,
      imports: importNames,
      isTypeOnly,
    });
  }

  return results;
}

// ── Indexer ───────────────────────────────────────────────────

/**
 * Recursively find all .ts files under a directory (relative to PROJECT_ROOT).
 */
function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  const absDir = join(PROJECT_ROOT, dir);

  if (!existsSync(absDir)) return files;

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, .git, tests, dashboard, scripts, etc.
      if (["node_modules", ".git", "tests", "dashboard", "scripts", "setup", "mcp", "supabase", "examples"].includes(entry.name)) continue;
      files.push(...findTypeScriptFiles(relPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      files.push(relPath);
    }
  }

  return files;
}

/**
 * Index the codebase and build the graph.
 * Scans src/**\/*.ts for imports, exports, and dependencies.
 */
export function indexCodebase(rootDir?: string): CodeGraph {
  const scanDir = rootDir || "src";
  const files = findTypeScriptFiles(scanDir);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const file of files) {
    const absPath = join(PROJECT_ROOT, file);
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const lineCount = content.split("\n").length;
    const exports = extractExports(content);
    nodes.push({ id: file, exports, lineCount });

    const imports = extractImports(content, file);
    for (const imp of imports) {
      edges.push({
        source: file,
        target: imp.target,
        imports: imp.imports,
        isTypeOnly: imp.isTypeOnly,
      });
    }
  }

  // Get commit hash
  let commitHash: string | undefined;
  try {
    const { execSync } = require("child_process");
    commitHash = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT })
      .toString()
      .trim();
  } catch {
    // Not in a git repo or git not available
  }

  return {
    nodes,
    edges,
    indexedAt: new Date().toISOString(),
    commitHash,
  };
}

// ── Cache ────────────────────────────────────────────────────

let graphCache: CodeGraph | null = null;

/**
 * Save graph to local JSON cache.
 */
export function saveGraph(graph: CodeGraph, path?: string): void {
  const cachePath = path || GRAPH_CACHE_PATH;
  writeFileSync(cachePath, JSON.stringify(graph, null, 2) + "\n", "utf-8");
  graphCache = graph;
}

/**
 * Load graph from local JSON cache.
 */
export function loadGraph(path?: string): CodeGraph | null {
  if (graphCache) return graphCache;

  const cachePath = path || GRAPH_CACHE_PATH;
  if (!existsSync(cachePath)) return null;

  try {
    const content = readFileSync(cachePath, "utf-8");
    graphCache = JSON.parse(content);
    return graphCache;
  } catch {
    return null;
  }
}

/**
 * Get or build the graph (lazy init).
 */
export function getGraph(): CodeGraph {
  const cached = loadGraph();
  if (cached) return cached;

  const graph = indexCodebase();
  saveGraph(graph);
  return graph;
}

/**
 * Clear the in-memory cache (for testing).
 */
export function clearGraphCache(): void {
  graphCache = null;
}

// ── Queries ──────────────────────────────────────────────────

/**
 * Get direct dependencies of a module (what it imports).
 */
export function getModuleDependencies(graph: CodeGraph, moduleId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.source === moduleId);
}

/**
 * Get modules that depend on a given module (what imports it).
 */
export function getDependents(graph: CodeGraph, moduleId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.target === moduleId);
}

/**
 * Get the impact radius of a module change using BFS.
 * Returns all modules that transitively depend on this module.
 * @param depth Maximum traversal depth (default 3)
 */
export function getImpactRadius(
  graph: CodeGraph,
  moduleId: string,
  depth: number = 3
): Array<{ module: string; distance: number }> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; dist: number }> = [{ id: moduleId, dist: 0 }];

  while (queue.length > 0) {
    const { id, dist } = queue.shift()!;

    if (visited.has(id) || dist > depth) continue;
    visited.set(id, dist);

    // Find all modules that import this one
    const dependents = graph.edges.filter((e) => e.target === id);
    for (const dep of dependents) {
      if (!visited.has(dep.source)) {
        queue.push({ id: dep.source, dist: dist + 1 });
      }
    }
  }

  // Remove the starting node
  visited.delete(moduleId);

  return Array.from(visited.entries())
    .map(([module, distance]) => ({ module, distance }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Get related modules: direct imports + direct dependents.
 */
export function getRelatedModules(graph: CodeGraph, moduleId: string): string[] {
  const related = new Set<string>();

  // Direct imports
  for (const edge of graph.edges) {
    if (edge.source === moduleId) related.add(edge.target);
    if (edge.target === moduleId) related.add(edge.source);
  }

  return Array.from(related);
}

/**
 * Find a node by module ID (partial match).
 */
export function findNode(graph: CodeGraph, query: string): GraphNode | undefined {
  // Exact match first
  const exact = graph.nodes.find((n) => n.id === query);
  if (exact) return exact;

  // Partial match on filename
  return graph.nodes.find((n) => n.id.endsWith(query) || n.id.includes(query));
}

// ── Cycle Detection ─────────────────────────────────────────

/**
 * Detect circular dependencies in the module graph via DFS with 3-color marking.
 * Returns an array of cycles, where each cycle is an array of module IDs.
 */
export function detectCycles(graph: CodeGraph): string[][] {
  // Build adjacency list from edges
  const adj = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adj.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source)!.push(edge.target);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) {
    color.set(id, WHITE);
  }

  const cycles: string[][] = [];
  const path: string[] = [];

  function dfs(node: string): void {
    color.set(node, GRAY);
    path.push(node);

    for (const neighbor of (adj.get(node) || [])) {
      if (color.get(neighbor) === GRAY) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor);
      }
    }

    path.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  // Deduplicate: normalize by rotating to start at lexicographically smallest node
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const cycle of cycles) {
    const min = cycle.reduce((a, b) => (a < b ? a : b));
    const minIdx = cycle.indexOf(min);
    const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
    const key = rotated.join("\u2192");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(rotated);
    }
  }

  return unique;
}

// ── Per-Function Complexity ─────────────────────────────────

/**
 * Compute cyclomatic complexity of a function body.
 * Strips comments, string literals, and template literals before counting.
 * @internal
 */
function computeCyclomaticComplexity(body: string): number {
  // Strip single-line comments
  let cleaned = body.replace(/\/\/.*$/gm, "");
  // Strip multi-line comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip template literals (before string literals to avoid interference)
  cleaned = cleaned.replace(/`(?:[^`\\]|\\[\s\S])*`/g, "");
  // Strip double-quoted strings
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, "");
  // Strip single-quoted strings
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "");

  let count = 0;

  // Branch keywords with word boundaries
  const keywords = [/\bif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bcase\b/g, /\bcatch\b/g];
  for (const re of keywords) {
    const m = cleaned.match(re);
    if (m) count += m.length;
  }

  // Logical operators
  count += (cleaned.match(/&&/g) || []).length;
  count += (cleaned.match(/\|\|/g) || []).length;

  // Ternary ? (exclude ?. optional chaining, ?? nullish coalescing, ?: optional property)
  count += (cleaned.match(/\?(?![.?:])/g) || []).length;

  return 1 + count;
}

/**
 * Extract function body boundaries via brace-depth counting.
 * Tracks parenthesis depth to skip braces inside parameter type annotations.
 * Falls back to semicolon-terminated expression for single-expression arrows.
 * @internal
 */
function extractFunctionBody(
  lines: string[],
  startIdx: number
): { endIdx: number; body: string } {
  let braceDepth = 0;
  let parenDepth = 0;
  let foundOpen = false;
  let bodyStartLine = startIdx;

  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;

      if (parenDepth > 0) continue;

      if (ch === "{") {
        braceDepth++;
        if (!foundOpen) {
          foundOpen = true;
          bodyStartLine = i;
        }
      } else if (ch === "}") {
        braceDepth--;
        if (foundOpen && braceDepth === 0) {
          return { endIdx: i, body: lines.slice(bodyStartLine, i + 1).join("\n") };
        }
      }
    }
  }

  // No matching brace — single-expression arrow or parse error
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trimEnd().endsWith(";")) {
      return { endIdx: i, body: lines.slice(startIdx, i + 1).join("\n") };
    }
  }

  return { endIdx: startIdx, body: lines[startIdx] };
}

/**
 * Get exported functions from a module with per-function complexity.
 * Reads the source file from disk, detects exported function declarations
 * and arrow function exports, computes cyclomatic complexity.
 */
export function getExportedFunctions(modulePath: string): FunctionInfo[] {
  const absPath = modulePath.startsWith("/") ? modulePath : join(PROJECT_ROOT, modulePath);

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const results: FunctionInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | null = null;

    // Pattern 1: export [async] function name(
    const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      name = funcMatch[1];
    } else {
      // Pattern 2: export const name = ... => (arrow function)
      const constMatch = line.match(/^export\s+const\s+(\w+)\s*=/);
      if (constMatch && line.includes("=>")) {
        name = constMatch[1];
      }
    }

    if (!name) continue;

    const startLine = i + 1; // 1-indexed
    const { endIdx, body } = extractFunctionBody(lines, i);
    const lineCount = endIdx - i + 1;
    const complexity = computeCyclomaticComplexity(body);

    results.push({ name, startLine, lineCount, complexity });

    // Skip to end of function body to avoid re-entering
    i = endIdx;
  }

  return results;
}

// ── Statistics ───────────────────────────────────────────────

/**
 * Get aggregate graph statistics.
 */
export function getGraphStats(graph: CodeGraph): GraphStats {
  const totalModules = graph.nodes.length;
  const totalEdges = graph.edges.length;
  const totalExports = graph.nodes.reduce((sum, n) => sum + n.exports.length, 0);
  const avgDependencies = totalModules > 0 ? Math.round((totalEdges / totalModules) * 10) / 10 : 0;

  // Most connected modules (imports + dependents)
  const connectionCount = new Map<string, number>();
  for (const node of graph.nodes) {
    connectionCount.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
  }

  const mostConnected = Array.from(connectionCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([module, connections]) => ({ module, connections }));

  return { totalModules, totalEdges, totalExports, avgDependencies, mostConnected };
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format graph context for agent prompt injection.
 * @param moduleId Target module being worked on
 * @param role Agent role (determines how much context to include)
 */
export function formatGraphContext(
  graph: CodeGraph,
  moduleId: string,
  role: string
): string {
  const node = findNode(graph, moduleId);
  if (!node) return "";

  const parts: string[] = [`MODULE: ${node.id} (${node.lineCount} lines)`];

  // Exports
  if (node.exports.length > 0) {
    parts.push("Exports: " + node.exports.map((e) => `${e.name} (${e.kind})`).join(", "));
  }

  // Dependencies
  const deps = getModuleDependencies(graph, node.id);
  if (deps.length > 0) {
    parts.push("Imports: " + deps.map((d) => {
      const shortTarget = d.target.replace("src/", "");
      return d.imports.length > 0 ? `${shortTarget} {${d.imports.join(", ")}}` : shortTarget;
    }).join(", "));
  }

  // Dependents
  const dependents = getDependents(graph, node.id);
  if (dependents.length > 0) {
    parts.push("Utilise par: " + dependents.map((d) => d.source.replace("src/", "")).join(", "));
  }

  // For architect/qa: impact radius
  if (role === "architect" || role === "qa") {
    const impact = getImpactRadius(graph, node.id, 2);
    if (impact.length > 0) {
      parts.push("Impact (d<=2): " + impact.map((i) =>
        `${i.module.replace("src/", "")} (d=${i.distance})`
      ).join(", "));
    }
  }

  return parts.join("\n");
}

/**
 * Format graph stats for /monitor display.
 */
export function formatGraphStatsForMonitor(graph: CodeGraph): string {
  const stats = getGraphStats(graph);
  const lines = [
    "CODE GRAPH:",
    `  Modules: ${stats.totalModules} | Edges: ${stats.totalEdges} | Exports: ${stats.totalExports}`,
    `  Moy. dependances: ${stats.avgDependencies}`,
    `  Plus connectes: ${stats.mostConnected.map((m) => `${m.module.replace("src/", "")}(${m.connections})`).join(", ")}`,
  ];
  if (graph.indexedAt) {
    lines.push(`  Indexe le: ${new Date(graph.indexedAt).toLocaleString("fr-FR")}`);
  }
  return lines.join("\n");
}

/**
 * Estimate module complexity from graph (for LLM router).
 * Returns a score 1-10 based on connections and code size.
 */
export function estimateComplexity(graph: CodeGraph, moduleId: string): number {
  const node = findNode(graph, moduleId);
  if (!node) return 5; // default medium

  const deps = getModuleDependencies(graph, node.id).length;
  const dependents = getDependents(graph, node.id).length;
  const impact = getImpactRadius(graph, node.id, 2).length;
  const lines = node.lineCount;

  // Score components (each 0-2.5, total 0-10)
  const depScore = Math.min(deps / 4, 2.5);
  const dependentScore = Math.min(dependents / 4, 2.5);
  const impactScore = Math.min(impact / 6, 2.5);
  const sizeScore = Math.min(lines / 200, 2.5);

  return Math.round((depScore + dependentScore + impactScore + sizeScore) * 10) / 10;
}

/**
 * Get modules likely affected by a task (heuristic: search for module names in task text).
 */
export function findAffectedModules(graph: CodeGraph, taskText: string): string[] {
  const text = taskText.toLowerCase();
  const affected: string[] = [];

  for (const node of graph.nodes) {
    // Extract module name from path (e.g., "src/orchestrator.ts" -> "orchestrator")
    const moduleName = node.id.replace(/^src\//, "").replace(/\.ts$/, "").replace(/^commands\//, "");
    if (text.includes(moduleName.toLowerCase())) {
      affected.push(node.id);
    }
  }

  return affected;
}
