/**
 * @module explore-graph
 * @description Zero-LLM fast-path for /explore: detects structural queries that can be
 * answered purely from the code graph without any LLM call. Supports module info,
 * dependencies, dependents, impact radius, complexity, stats, and related modules.
 * S44/T5.
 */

import {
  type CodeGraph,
  findNode,
  getModuleDependencies,
  getDependents,
  getImpactRadius,
  getRelatedModules,
  getGraphStats,
  estimateComplexity,
  findAffectedModules,
} from "./code-graph.ts";

// ── Types ─────────────────────────────────────────────────────

export type GraphQueryType =
  | "module_info"
  | "dependencies"
  | "dependents"
  | "impact"
  | "complexity"
  | "related"
  | "stats";

export interface GraphQueryResult {
  type: GraphQueryType;
  moduleId?: string;
  response: string;
}

// ── Query Detection ───────────────────────────────────────────

const STATS_PATTERNS = [
  /\b(stats|statistiques?|overview|vue\s+d'ensemble|structure\s+globale|codebase|resume\s+du\s+code)\b/i,
  /\bcombien\s+de\s+(modules?|fichiers?)\b/i,
  /\bmodules?\s+les?\s+plus\s+connect/i,
];

const DEPENDENCY_PATTERNS = [
  /\b(dependan|import|utilise|consomme|requires?|a\s+besoin)\b/i,
  /\bqu.?\s*(importe|utilise|depend)/i,
  /\b(imports?|dependances?)\s+(de|du|of)\b/i,
];

const DEPENDENT_PATTERNS = [
  /\b(qui\s+utilise|qui\s+importe|used?\s+by|dependants?|dependents?|utilise\s+par|importe\s+par)\b/i,
  /\bqu.?\s*est.ce\s+qui\s+(utilise|importe)\b/i,
];

const IMPACT_PATTERNS = [
  /\b(impact|affecte|radius|rayon|transitif|propagation|cascade)\b/i,
  /\bsi\s+(on|je)\s+(modifie|change|touche)\b/i,
  /\bmodifier?\s+.*\b(affecte|impact|casse)\b/i,
];

const COMPLEXITY_PATTERNS = [
  /\b(complex|complexite|difficult|score|poids)\b/i,
  /\bcombien\s+.*\b(complex|lourd|gros)\b/i,
];

const RELATED_PATTERNS = [
  /\b(related|lie[es]?|associe[es]?|en\s+rapport|connexe|voisin)\b/i,
  /\bmodules?\s+(proches?|autour)\b/i,
];

/**
 * Try to extract a module name from a query string.
 * Matches known module IDs or common partial names.
 */
export function extractModuleName(query: string, graph: CodeGraph): string | null {
  const lower = query.toLowerCase();

  // Direct module path match: "src/relay.ts" or "relay.ts"
  for (const node of graph.nodes) {
    if (lower.includes(node.id.toLowerCase())) return node.id;
    const filename = node.id.replace(/^src\//, "").replace(/^commands\//, "").replace(/\.ts$/, "");
    if (lower.includes(filename.toLowerCase()) && filename.length >= 3) return node.id;
  }

  // Fuzzy: use findAffectedModules (heuristic match)
  const affected = findAffectedModules(graph, query);
  if (affected.length === 1) return affected[0];

  // If multiple matches, pick the one with shortest name (most specific)
  if (affected.length > 1) {
    return affected.sort((a, b) => a.length - b.length)[0];
  }

  return null;
}

/**
 * Detect if a query can be answered from the code graph alone.
 * Returns the query type and extracted module, or null if LLM is needed.
 */
export function detectGraphQuery(query: string, graph: CodeGraph): { type: GraphQueryType; moduleId: string | null } | null {
  const lower = query.toLowerCase();

  // Stats/overview queries (no module needed)
  if (STATS_PATTERNS.some(p => p.test(lower))) {
    return { type: "stats", moduleId: null };
  }

  // Try to extract a module name
  const moduleId = extractModuleName(query, graph);

  // If no module found, we need LLM for interpretation
  if (!moduleId) return null;

  // Check specific query types (order matters — more specific first)
  if (IMPACT_PATTERNS.some(p => p.test(lower))) {
    return { type: "impact", moduleId };
  }
  if (DEPENDENT_PATTERNS.some(p => p.test(lower))) {
    return { type: "dependents", moduleId };
  }
  if (DEPENDENCY_PATTERNS.some(p => p.test(lower))) {
    return { type: "dependencies", moduleId };
  }
  if (COMPLEXITY_PATTERNS.some(p => p.test(lower))) {
    return { type: "complexity", moduleId };
  }
  if (RELATED_PATTERNS.some(p => p.test(lower))) {
    return { type: "related", moduleId };
  }

  // Module name present but no specific query type → show module info
  return { type: "module_info", moduleId };
}

// ── Response Builders ────────────────────────────────────────

function formatModuleInfo(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const deps = getModuleDependencies(graph, node.id);
  const dependents = getDependents(graph, node.id);
  const complexity = estimateComplexity(graph, node.id);
  const impact = getImpactRadius(graph, node.id, 2);

  const lines: string[] = [
    `MODULE: ${node.id}`,
    `Lignes: ${node.lineCount}`,
    `Complexite: ${complexity}/10`,
    "",
  ];

  if (node.exports.length > 0) {
    lines.push(`Exports (${node.exports.length}):`);
    for (const exp of node.exports) {
      lines.push(`  ${exp.name} (${exp.kind})`);
    }
    lines.push("");
  }

  if (deps.length > 0) {
    lines.push(`Dependances (${deps.length}):`);
    for (const d of deps) {
      const short = d.target.replace("src/", "");
      lines.push(`  ${short}${d.imports.length > 0 ? ` {${d.imports.join(", ")}}` : ""}`);
    }
    lines.push("");
  }

  if (dependents.length > 0) {
    lines.push(`Utilise par (${dependents.length}):`);
    for (const d of dependents) {
      lines.push(`  ${d.source.replace("src/", "")}`);
    }
    lines.push("");
  }

  if (impact.length > 0) {
    lines.push(`Rayon d'impact (${impact.length} modules affectes):`);
    for (const i of impact) {
      lines.push(`  ${i.module.replace("src/", "")} (distance ${i.distance})`);
    }
  }

  return lines.join("\n");
}

function formatDependencies(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const deps = getModuleDependencies(graph, node.id);
  if (deps.length === 0) return `${node.id} n'importe aucun module local.`;

  const lines: string[] = [
    `DEPENDANCES DE ${node.id} (${deps.length}):`,
    "",
  ];
  for (const d of deps) {
    const short = d.target.replace("src/", "");
    const symbols = d.imports.length > 0 ? ` -> {${d.imports.join(", ")}}` : "";
    const typeOnly = d.isTypeOnly ? " (type only)" : "";
    lines.push(`  ${short}${symbols}${typeOnly}`);
  }
  return lines.join("\n");
}

function formatDependents(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const dependents = getDependents(graph, node.id);
  if (dependents.length === 0) return `Aucun module n'importe ${node.id}.`;

  const lines: string[] = [
    `MODULES QUI UTILISENT ${node.id} (${dependents.length}):`,
    "",
  ];
  for (const d of dependents) {
    const symbols = d.imports.length > 0 ? ` -> {${d.imports.join(", ")}}` : "";
    lines.push(`  ${d.source.replace("src/", "")}${symbols}`);
  }
  return lines.join("\n");
}

function formatImpact(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const impact = getImpactRadius(graph, node.id, 3);
  if (impact.length === 0) return `Modifier ${node.id} n'affecte aucun autre module (pas de dependants).`;

  const lines: string[] = [
    `IMPACT DE MODIFICATION DE ${node.id}:`,
    `${impact.length} modules affectes (profondeur max 3)`,
    "",
  ];

  const byDistance = new Map<number, string[]>();
  for (const i of impact) {
    const list = byDistance.get(i.distance) || [];
    list.push(i.module.replace("src/", ""));
    byDistance.set(i.distance, list);
  }

  for (const [dist, modules] of Array.from(byDistance.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(`Distance ${dist}: ${modules.join(", ")}`);
  }

  return lines.join("\n");
}

function formatComplexity(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const score = estimateComplexity(graph, node.id);
  const deps = getModuleDependencies(graph, node.id).length;
  const dependents = getDependents(graph, node.id).length;
  const impact = getImpactRadius(graph, node.id, 2).length;

  const level = score <= 3 ? "faible" : score <= 6 ? "moderee" : "elevee";

  return [
    `COMPLEXITE DE ${node.id}: ${score}/10 (${level})`,
    "",
    `Composantes:`,
    `  Lignes de code: ${node.lineCount}`,
    `  Dependances directes: ${deps}`,
    `  Dependants directs: ${dependents}`,
    `  Modules impactes (d<=2): ${impact}`,
    `  Exports: ${node.exports.length}`,
  ].join("\n");
}

function formatRelated(graph: CodeGraph, moduleId: string): string {
  const node = findNode(graph, moduleId);
  if (!node) return `Module "${moduleId}" non trouve dans le graphe.`;

  const related = getRelatedModules(graph, node.id);
  if (related.length === 0) return `${node.id} n'a aucun module lie.`;

  const deps = new Set(getModuleDependencies(graph, node.id).map(d => d.target));
  const depBy = new Set(getDependents(graph, node.id).map(d => d.source));

  const lines: string[] = [
    `MODULES LIES A ${node.id} (${related.length}):`,
    "",
  ];
  for (const r of related) {
    const short = r.replace("src/", "");
    const direction = deps.has(r) && depBy.has(r) ? "(bidirectionnel)"
      : deps.has(r) ? "(importe)"
      : "(importe par)";
    lines.push(`  ${short} ${direction}`);
  }
  return lines.join("\n");
}

function formatStats(graph: CodeGraph): string {
  const stats = getGraphStats(graph);
  const lines: string[] = [
    `STATISTIQUES DU CODEBASE:`,
    "",
    `Modules: ${stats.totalModules}`,
    `Liens d'import: ${stats.totalEdges}`,
    `Exports totaux: ${stats.totalExports}`,
    `Dependances moyennes par module: ${stats.avgDependencies}`,
    "",
    `Modules les plus connectes:`,
  ];
  for (const m of stats.mostConnected) {
    lines.push(`  ${m.module.replace("src/", "")} (${m.connections} connexions)`);
  }
  if (graph.indexedAt) {
    lines.push("");
    lines.push(`Indexe le: ${new Date(graph.indexedAt).toLocaleString("fr-FR")}`);
  }
  if (graph.commitHash) {
    lines.push(`Commit: ${graph.commitHash}`);
  }
  return lines.join("\n");
}

// ── Main Entry Point ─────────────────────────────────────────

/**
 * Try to answer an explore query from the code graph alone.
 * Returns a GraphQueryResult if successful, or null if LLM is needed.
 */
export function tryGraphResponse(query: string, graph: CodeGraph): GraphQueryResult | null {
  const detected = detectGraphQuery(query, graph);
  if (!detected) return null;

  const { type, moduleId } = detected;

  let response: string;
  switch (type) {
    case "stats":
      response = formatStats(graph);
      break;
    case "module_info":
      response = formatModuleInfo(graph, moduleId!);
      break;
    case "dependencies":
      response = formatDependencies(graph, moduleId!);
      break;
    case "dependents":
      response = formatDependents(graph, moduleId!);
      break;
    case "impact":
      response = formatImpact(graph, moduleId!);
      break;
    case "complexity":
      response = formatComplexity(graph, moduleId!);
      break;
    case "related":
      response = formatRelated(graph, moduleId!);
      break;
    default:
      return null;
  }

  return { type, moduleId: moduleId || undefined, response };
}
