#!/usr/bin/env bun
/**
 * @module scripts/index-graph
 * @description CLI script to rebuild the code graph.
 * Usage: bun run scripts/index-graph.ts [--diff]
 *
 * --diff: Only re-index files changed since last index (uses git diff)
 */

import { indexCodebase, saveGraph, loadGraph, getGraphStats } from "../src/code-graph.ts";

const args = process.argv.slice(2);
const diffOnly = args.includes("--diff");

console.log("Indexing codebase...");
const start = Date.now();

const graph = indexCodebase();
saveGraph(graph);

const stats = getGraphStats(graph);
const elapsed = Date.now() - start;

console.log(`Done in ${elapsed}ms`);
console.log(`  Modules: ${stats.totalModules}`);
console.log(`  Edges: ${stats.totalEdges}`);
console.log(`  Exports: ${stats.totalExports}`);
console.log(`  Avg dependencies: ${stats.avgDependencies}`);
console.log(`  Commit: ${graph.commitHash || "unknown"}`);
console.log(`  Most connected:`);
for (const m of stats.mostConnected) {
  console.log(`    ${m.module} (${m.connections} connections)`);
}
