/**
 * Autonomy Scanner — Proactive Opportunity Detection
 *
 * Scans the project for improvement opportunities and returns
 * actionable findings that can be turned into auto-generated tasks.
 *
 * Scanners:
 * - Missing test coverage (src modules without corresponding tests)
 * - TODO/FIXME markers in source code
 * - Stuck tasks needing intervention
 * - Stale backlog items that could be deprioritized
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readdir } from "fs/promises";
import { join, basename } from "path";

// ── Types ────────────────────────────────────────────────────

export interface Opportunity {
  type: "missing_tests" | "todo_marker" | "stuck_task" | "stale_backlog";
  title: string;
  description: string;
  priority: number; // 1-5
  dedup_key: string; // Used to avoid creating duplicate tasks
}

export interface ScanResult {
  opportunities: Opportunity[];
  scannedAt: string;
  summary: string;
}

// ── Scanners ─────────────────────────────────────────────────

/**
 * Find src modules that have no corresponding unit test file.
 */
export async function scanMissingTests(projectRoot: string): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];

  const srcDir = join(projectRoot, "src");
  const testDir = join(projectRoot, "tests", "unit");

  let srcFiles: string[];
  let testFiles: string[];

  try {
    srcFiles = (await readdir(srcDir)).filter((f) => f.endsWith(".ts"));
    testFiles = (await readdir(testDir)).filter((f) => f.endsWith(".test.ts"));
  } catch {
    return opportunities;
  }

  const testedModules = new Set(testFiles.map((f) => f.replace(".test.ts", "")));

  // Modules that are standalone scripts or too large to unit test meaningfully
  const skipModules = new Set(["relay", "alert-cron", "autonomy-cron"]);

  for (const srcFile of srcFiles) {
    const moduleName = srcFile.replace(".ts", "");
    if (skipModules.has(moduleName)) continue;
    if (testedModules.has(moduleName)) continue;

    opportunities.push({
      type: "missing_tests",
      title: `Ajouter des tests pour ${moduleName}`,
      description: `Le module src/${srcFile} n'a pas de fichier de tests unitaires correspondant.`,
      priority: 3,
      dedup_key: `missing_tests:${moduleName}`,
    });
  }

  return opportunities;
}

/**
 * Scan source files for TODO and FIXME markers.
 */
export async function scanTodoMarkers(projectRoot: string): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const srcDir = join(projectRoot, "src");

  let srcFiles: string[];
  try {
    srcFiles = (await readdir(srcDir)).filter((f) => f.endsWith(".ts"));
  } catch {
    return opportunities;
  }

  for (const srcFile of srcFiles) {
    const filePath = join(srcDir, srcFile);
    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }

    const lines = content.split("\n");
    let todoCount = 0;
    let fixmeCount = 0;

    for (const line of lines) {
      if (/\/\/\s*TODO/i.test(line)) todoCount++;
      if (/\/\/\s*FIXME/i.test(line)) fixmeCount++;
    }

    if (fixmeCount > 0) {
      opportunities.push({
        type: "todo_marker",
        title: `Resoudre ${fixmeCount} FIXME dans ${srcFile}`,
        description: `${fixmeCount} marqueur(s) FIXME trouves dans src/${srcFile}.`,
        priority: 2,
        dedup_key: `fixme:${srcFile}`,
      });
    }

    if (todoCount >= 3) {
      opportunities.push({
        type: "todo_marker",
        title: `Traiter ${todoCount} TODOs dans ${srcFile}`,
        description: `${todoCount} marqueur(s) TODO accumules dans src/${srcFile}.`,
        priority: 3,
        dedup_key: `todo:${srcFile}`,
      });
    }
  }

  return opportunities;
}

/**
 * Find tasks stuck in_progress for too long.
 */
export async function scanStuckTasks(supabase: SupabaseClient): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: stuckTasks } = await supabase
    .from("tasks")
    .select("id, title, updated_at")
    .eq("status", "in_progress")
    .lt("updated_at", cutoff48h);

  for (const task of stuckTasks || []) {
    const hoursStuck = Math.round(
      (Date.now() - new Date(task.updated_at).getTime()) / (60 * 60 * 1000)
    );

    opportunities.push({
      type: "stuck_task",
      title: `Debloquer: ${task.title}`,
      description: `Tache en cours depuis ${hoursStuck}h sans mise a jour. Verifier si elle est bloquee ou a terminer.`,
      priority: 2,
      dedup_key: `stuck:${task.id}`,
    });
  }

  return opportunities;
}

/**
 * Find old backlog items that might need cleanup.
 */
export async function scanStaleBacklog(supabase: SupabaseClient): Promise<Opportunity[]> {
  const opportunities: Opportunity[] = [];
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: staleTasks } = await supabase
    .from("tasks")
    .select("id, title, created_at, sprint")
    .eq("status", "backlog")
    .lt("created_at", cutoff7d)
    .limit(10);

  if ((staleTasks?.length ?? 0) >= 5) {
    opportunities.push({
      type: "stale_backlog",
      title: `Nettoyer le backlog (${staleTasks!.length} taches anciennes)`,
      description: `${staleTasks!.length} taches en backlog depuis plus de 7 jours. Envisager de prioriser, reporter ou annuler.`,
      priority: 4,
      dedup_key: `stale_backlog:cleanup`,
    });
  }

  return opportunities;
}

// ── Main Scanner ─────────────────────────────────────────────

/**
 * Run all scanners and return combined results.
 */
export async function runAllScanners(
  projectRoot: string,
  supabase: SupabaseClient
): Promise<ScanResult> {
  const allOpportunities: Opportunity[] = [];

  const [missingTests, todos, stuck, stale] = await Promise.all([
    scanMissingTests(projectRoot),
    scanTodoMarkers(projectRoot),
    scanStuckTasks(supabase),
    scanStaleBacklog(supabase),
  ]);

  allOpportunities.push(...missingTests, ...todos, ...stuck, ...stale);

  // Sort by priority (lower = higher priority)
  allOpportunities.sort((a, b) => a.priority - b.priority);

  const summary = allOpportunities.length === 0
    ? "Aucune opportunite detectee. Projet en bon etat."
    : `${allOpportunities.length} opportunite(s): ${missingTests.length} tests manquants, ${todos.length} TODOs, ${stuck.length} taches bloquees, ${stale.length} backlog.`;

  return {
    opportunities: allOpportunities,
    scannedAt: new Date().toISOString(),
    summary,
  };
}

/**
 * Check if a task with this dedup_key already exists in the backlog.
 */
export async function isDuplicate(
  supabase: SupabaseClient,
  dedupKey: string
): Promise<boolean> {
  const { data } = await supabase
    .from("tasks")
    .select("id")
    .contains("tags", ["auto-generated"])
    .eq("notes", dedupKey)
    .neq("status", "cancelled")
    .neq("status", "done")
    .limit(1);

  return (data?.length ?? 0) > 0;
}

// ── Formatting ───────────────────────────────────────────────

export function formatScanResult(result: ScanResult): string {
  const lines: string[] = [];

  lines.push(`[Scan Autonome] ${new Date(result.scannedAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`);
  lines.push("");
  lines.push(result.summary);

  if (result.opportunities.length > 0) {
    lines.push("");
    for (const opp of result.opportunities.slice(0, 8)) {
      const prio = `P${opp.priority}`;
      lines.push(`  [${prio}] ${opp.title}`);
    }

    if (result.opportunities.length > 8) {
      lines.push(`  ... +${result.opportunities.length - 8} autres`);
    }
  }

  return lines.join("\n");
}
