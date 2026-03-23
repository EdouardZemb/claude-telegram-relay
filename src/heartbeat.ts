/**
 * @module heartbeat
 * @description Autonomous heartbeat: periodic project pulse that observes, analyzes,
 * and takes initiative. Runs as PM2 cron service every 10 minutes.
 * Consolidates alert-cron (hourly alerts, memory archival, morning digest)
 * and autonomy-cron (daily autonomy scan) into a single service.
 */

/**
 * Heartbeat — "Le Pouls"
 *
 * Periodic autonomous agent that monitors the project state and takes
 * proactive actions: notifications, task creation, anomaly detection.
 *
 * Flow: collect delta → triage (TypeScript) → spawn Claude if interesting
 *       → parse decision → execute actions → run periodic tasks → persist state
 *
 * Periodic tasks (run without Claude, time-gated):
 * - Every pulse: morning digest flush (if quiet hours just ended)
 * - Hourly: alert checks (runAllChecks) + memory archival (archiveOldMemories)
 * - Daily: autonomy scan (runAllScanners) — creates improvement tasks
 *
 * Run: bun run src/heartbeat.ts
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawnSync } from "bun";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { spawnClaude } from "./agent.ts";
// Periodic task imports (consolidated from alert-cron + autonomy-cron)
import { runAllChecks } from "./alerts.ts";
import { isDuplicate, runAllScanners } from "./autonomy-scanner.ts";
import {
  countTests,
  type DocState,
  extractCommands,
  extractModules,
  findGaps,
  parseClaudeMdCommands,
  parseClaudeMdModules,
  parseClaudeMdTestCount,
} from "./doc-utils.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import {
  buildHeartbeatPrompt,
  createDefaultState,
  HEARTBEAT_SYSTEM_PROMPT,
  type HeartbeatAction,
  type HeartbeatDecision,
  type HeartbeatDelta,
  type HeartbeatState,
} from "./heartbeat-prompt.ts";
// LLM-Ops periodic check
import { LLMOPS_CHECK_INTERVAL_MS, runLlmOpsCheck } from "./llm-ops.ts";
import { createLogger } from "./logger.ts";
import { archiveOldMemories } from "./memory.ts";
import { isQuietHours, loadPrefs } from "./notification-prefs.ts";
import { enqueue, flushMorningDigest, getQueue, loadQueue } from "./notification-queue.ts";
import { addTask, getCurrentSprint } from "./tasks.ts";

const log = createLogger("heartbeat");

const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const STATE_FILE = join(PROJECT_DIR, "config", "heartbeat-state.json");
const MCP_PENDING_FILE = join(RELAY_DIR, "mcp-pending-notifications.json");
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown per topic

// ── State Management ──────────────────────────────────────────

export async function loadState(): Promise<HeartbeatState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    // R6: optional IO → degrade gracefully
    return createDefaultState();
  }
}

export async function saveState(state: HeartbeatState): Promise<void> {
  const dir = join(PROJECT_DIR, "config");
  await mkdir(dir, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
  const { rename } = await import("fs/promises");
  await rename(tmp, STATE_FILE);
}

// ── Delta Collection ──────────────────────────────────────────

function git(...args: string[]): string {
  const result = spawnSync(["git", ...args], { cwd: PROJECT_DIR });
  return new TextDecoder().decode(result.stdout).trim();
}

function gh(...args: string[]): string {
  try {
    const result = spawnSync(["gh", ...args], { cwd: PROJECT_DIR });
    if (result.exitCode !== 0) return "";
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
}

export function getGitDelta(lastSha: string): {
  commits: string;
  currentSha: string;
  hasNew: boolean;
} {
  const currentSha = git("rev-parse", "HEAD");
  if (!lastSha || lastSha === currentSha) {
    return { commits: "", currentSha, hasNew: false };
  }
  const log = git("log", "--oneline", `${lastSha}..HEAD`);
  return { commits: log, currentSha, hasNew: log.length > 0 };
}

export async function getSprintDelta(
  supabase: SupabaseClient,
  lastSnapshot: HeartbeatState["lastSprintSnapshot"],
): Promise<{ summary: string; snapshot: HeartbeatState["lastSprintSnapshot"]; changed: boolean }> {
  const sprint = await getCurrentSprint(supabase);
  if (!sprint) {
    return {
      summary: "Aucun sprint actif",
      snapshot: { sprint: null, done: 0, total: 0 },
      changed: lastSnapshot.sprint !== null,
    };
  }

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, status")
    .eq("sprint", sprint);

  if (error) {
    log.error("Supabase error in getSprintDelta", { error });
    return {
      summary: "Erreur Supabase",
      snapshot: lastSnapshot,
      changed: false,
    };
  }

  const total = tasks?.length || 0;
  const done = tasks?.filter((t: { status: string }) => t.status === "done").length || 0;
  const inProgress =
    tasks?.filter((t: { status: string }) => t.status === "in_progress").length || 0;

  const changed =
    lastSnapshot.sprint !== sprint || lastSnapshot.done !== done || lastSnapshot.total !== total;

  const summary = `Sprint ${sprint}: ${done}/${total} terminees, ${inProgress} en cours`;
  return { summary, snapshot: { sprint, done, total }, changed };
}

export function getCIStatus(): { status: string; hasFailed: boolean } {
  const runs = gh("run", "list", "--limit", "3", "--json", "status,conclusion,name,headBranch");
  if (!runs) return { status: "Indisponible", hasFailed: false };

  try {
    const parsed = JSON.parse(runs) as Array<{
      status: string;
      conclusion: string;
      name: string;
      headBranch: string;
    }>;
    const lines = parsed.map((r) => `${r.name} (${r.headBranch}): ${r.conclusion || r.status}`);
    const hasFailed = parsed.some((r) => r.conclusion === "failure");
    return { status: lines.join("\n"), hasFailed };
  } catch {
    // R6: optional IO → degrade gracefully
    return { status: runs, hasFailed: false };
  }
}

export function getOpenPRs(): { prs: string; hasStale: boolean } {
  const prs = gh("pr", "list", "--json", "number,title,createdAt,headRefName", "--limit", "10");
  if (!prs) return { prs: "Aucune PR ouverte", hasStale: false };

  try {
    const parsed = JSON.parse(prs) as Array<{
      number: number;
      title: string;
      createdAt: string;
      headRefName: string;
    }>;
    if (parsed.length === 0) return { prs: "Aucune PR ouverte", hasStale: false };

    const now = Date.now();
    const STALE_MS = 24 * 60 * 60 * 1000; // 24h
    let hasStale = false;

    const lines = parsed.map((pr) => {
      const age = now - new Date(pr.createdAt).getTime();
      const ageH = Math.round(age / (60 * 60 * 1000));
      if (age > STALE_MS) hasStale = true;
      return `#${pr.number} ${pr.title} (${pr.headRefName}, ${ageH}h)`;
    });

    return { prs: lines.join("\n"), hasStale };
  } catch {
    // R6: optional IO → degrade gracefully
    return { prs: prs, hasStale: false };
  }
}

export async function getStaleTasks(
  supabase: SupabaseClient,
): Promise<{ tasks: string; hasStale: boolean }> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, updated_at")
    .eq("status", "in_progress");

  if (error) {
    log.error("Supabase error in getStaleTasks", { error });
    return { tasks: "", hasStale: false };
  }

  if (!data || data.length === 0) {
    return { tasks: "", hasStale: false };
  }

  const now = Date.now();
  const STALE_MS = 48 * 60 * 60 * 1000; // 48h

  const stale = data.filter(
    (t: { updated_at: string }) => now - new Date(t.updated_at).getTime() > STALE_MS,
  );

  if (stale.length === 0) {
    return { tasks: "", hasStale: false };
  }

  const lines = stale.map((t: { id: string; title: string; updated_at: string }) => {
    const ageH = Math.round((now - new Date(t.updated_at).getTime()) / (60 * 60 * 1000));
    return `${t.title} [${t.id.substring(0, 8)}] — en cours depuis ${ageH}h`;
  });

  return { tasks: lines.join("\n"), hasStale: true };
}

// ── Triage ────────────────────────────────────────────────────

export interface TriageResult {
  interesting: boolean;
  reasons: string[];
  delta: HeartbeatDelta;
}

export async function collectAndTriage(
  supabase: SupabaseClient,
  state: HeartbeatState,
): Promise<TriageResult> {
  const reasons: string[] = [];

  // Collect all deltas
  const gitDelta = getGitDelta(state.lastCommitSha);
  const sprintDelta = await getSprintDelta(supabase, state.lastSprintSnapshot);
  const ciStatus = getCIStatus();
  const openPRs = getOpenPRs();
  const staleTasks = await getStaleTasks(supabase);

  // Time since last pulse
  const lastPulseMs = state.lastPulseAt ? Date.now() - new Date(state.lastPulseAt).getTime() : 0;
  const timeSinceLastPulse = state.lastPulseAt
    ? `${Math.round(lastPulseMs / 60000)} min`
    : "premiere pulsation";

  // Triage: is anything interesting?
  if (gitDelta.hasNew) reasons.push("new_commits");
  if (sprintDelta.changed) reasons.push("sprint_changed");
  if (ciStatus.hasFailed) reasons.push("ci_failed");
  if (openPRs.hasStale) reasons.push("stale_prs");
  if (staleTasks.hasStale) reasons.push("stale_tasks");

  // First pulse is always interesting
  if (!state.lastPulseAt) reasons.push("first_pulse");

  const delta: HeartbeatDelta = {
    commits: gitDelta.commits,
    sprintSummary: sprintDelta.summary,
    ciStatus: ciStatus.status,
    openPRs: openPRs.prs,
    staleTasks: staleTasks.tasks,
    timeSinceLastPulse,
  };

  return {
    interesting: reasons.length > 0,
    reasons,
    delta,
  };
}

// ── Action Execution ──────────────────────────────────────────

async function writeMcpPending(notification: {
  type: string;
  severity: string;
  message: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });

  let pending: unknown[] = [];
  try {
    const content = await readFile(MCP_PENDING_FILE, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) pending = parsed;
  } catch {
    // R6: optional IO → degrade gracefully
    // File doesn't exist or parse error — start fresh
  }

  pending.push({ ...notification, createdAt: Date.now() });

  const tmp = MCP_PENDING_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(pending, null, 2));
  const { rename } = await import("fs/promises");
  await rename(tmp, MCP_PENDING_FILE);
}

export async function executeActions(
  decision: HeartbeatDecision,
  supabase: SupabaseClient,
  state: HeartbeatState,
): Promise<HeartbeatAction[]> {
  const executed: HeartbeatAction[] = [];
  const now = new Date().toISOString();

  for (const action of decision.actions) {
    if (action.type === "none") {
      executed.push({ type: "none", summary: "Rien a signaler", timestamp: now });
      continue;
    }

    if (action.type === "notify" && action.message) {
      // Check cooldown
      const topic = action.message.substring(0, 50);
      if (state.cooldowns[topic] && state.cooldowns[topic] > Date.now()) {
        log.info(`Cooldown actif pour: ${topic}`);
        continue;
      }

      await writeMcpPending({
        type: "alert",
        severity: action.priority === "high" ? "critical" : "normal",
        message: `[Pouls] ${action.message}`,
      });

      // Set cooldown
      state.cooldowns[topic] = Date.now() + COOLDOWN_MS;

      executed.push({ type: "notify", summary: action.message, timestamp: now });
      log.info(`Notification: ${action.message}`);
    }

    if (action.type === "task_create" && action.taskTitle) {
      const sprint = await getCurrentSprint(supabase);
      const task = await addTask(supabase, action.taskTitle, {
        description: action.taskDescription || undefined,
        priority: action.taskPriority || 3,
        sprint: sprint ?? undefined,
        tags: ["auto-generated", "heartbeat"],
      });

      if (task) {
        executed.push({ type: "task_create", summary: action.taskTitle, timestamp: now });
        log.info(`Tache creee: ${action.taskTitle} [${task.id.substring(0, 8)}]`);
      }
    }
  }

  return executed;
}

// ── Lightweight Audit ─────────────────────────────────────────

export interface LightweightAuditResult {
  score: number;
  gaps: Array<{ type: string; item: string; detail: string }>;
  testCount: number;
}

/**
 * Compute audit score from gaps list.
 * Score: 100 - (5 * missing/extra modules) - (5 * missing/extra commands) - (10 if test count drifts).
 * Clamped to [0, 100].
 */
export function computeAuditScore(gaps: Array<{ type: string }>): number {
  let score = 100;
  for (const gap of gaps) {
    score -= gap.type === "test_count" ? 10 : 5;
  }
  return Math.max(0, Math.min(100, score));
}

/**
 * Run a lightweight structure + tests audit using doc-utils.
 */
export async function runLightweightAudit(projectDir: string): Promise<LightweightAuditResult> {
  const srcDir = join(projectDir, "src");
  const relayPath = join(srcDir, "relay.ts");
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const testsDir = join(projectDir, "tests");

  const srcModules = await extractModules(srcDir);
  const srcCommands = await extractCommands(relayPath);
  const claudeMdModules = await parseClaudeMdModules(claudeMdPath);
  const claudeMdCommands = await parseClaudeMdCommands(claudeMdPath);

  const claudeMdContent = await readFile(claudeMdPath, "utf-8");
  const claudeMdTestCount = parseClaudeMdTestCount(claudeMdContent);

  // Only run countTests if structural checks pass (avoid heavy operation)
  let actualTestCount = claudeMdTestCount; // assume no drift by default
  const structState: DocState = {
    srcModules,
    claudeMdModules,
    srcCommands,
    claudeMdCommands,
    actualTestCount,
    claudeMdTestCount,
  };
  const structGaps = findGaps(structState);
  const structuralGapsOnly = structGaps.filter((g) => g.type !== "test_count");

  if (structuralGapsOnly.length === 0) {
    try {
      actualTestCount = await countTests(testsDir);
    } catch {
      // R6: optional IO → degrade gracefully
      actualTestCount = claudeMdTestCount; // fallback: assume no drift
    }
  }

  const fullState: DocState = {
    srcModules,
    claudeMdModules,
    srcCommands,
    claudeMdCommands,
    actualTestCount,
    claudeMdTestCount,
  };
  const gaps = findGaps(fullState);
  const score = computeAuditScore(gaps);

  return { score, gaps, testCount: actualTestCount };
}

// ── Main Pulse ────────────────────────────────────────────────

export async function pulse(): Promise<{
  skipped: boolean;
  reasons: string[];
  actions: HeartbeatAction[];
}> {
  const timestamp = new Date().toISOString();
  log.info("Heartbeat pulse starting...");

  // Check feature flag
  if (!isFeatureEnabled("heartbeat")) {
    log.info("Heartbeat disabled (feature flag off).");
    return { skipped: true, reasons: ["disabled"], actions: [] };
  }

  // Load state
  const state = await loadState();

  // Initialize Supabase
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !supabaseKey) {
    log.info("Supabase not configured, skipping.");
    return { skipped: true, reasons: ["no_supabase"], actions: [] };
  }
  const supabase = createClient(supabaseUrl, supabaseKey) as unknown as SupabaseClient;

  // Collect delta and triage
  const triage = await collectAndTriage(supabase, state);

  // Update state with latest data regardless
  const gitSha = git("rev-parse", "HEAD");
  const sprintDelta = await getSprintDelta(supabase, state.lastSprintSnapshot);

  state.lastPulseAt = timestamp;
  state.lastCommitSha = gitSha;
  state.lastSprintSnapshot = sprintDelta.snapshot;

  // Clean expired cooldowns
  const now = Date.now();
  for (const [topic, expiry] of Object.entries(state.cooldowns)) {
    if (expiry < now) delete state.cooldowns[topic];
  }

  // ── Triage + Claude analysis ───────────────────────────────
  let executed: HeartbeatAction[] = [];
  let skipped = true;

  if (!triage.interesting) {
    log.info("Nothing interesting. Skipping Claude spawn.");
  } else {
    skipped = false;
    log.info(`Interesting: ${triage.reasons.join(", ")}. Spawning Claude...`);

    // Build prompt and spawn Claude
    const prompt = buildHeartbeatPrompt(state, triage.delta);

    try {
      const result = await spawnClaude({
        prompt,
        systemPrompt: HEARTBEAT_SYSTEM_PROMPT,
        model: "claude-haiku-4-5",
        effort: "low",
        // Budget limits removed
        outputFormat: "json",
      });

      if (result.exitCode !== 0) {
        log.error("Claude spawn failed", { stderr: result.stderr });
      } else {
        // Parse decision — Claude CLI with --output-format json may wrap the response
        let decision: HeartbeatDecision | null = null;
        try {
          const raw = result.stdout;
          if (process.env.HEARTBEAT_DEBUG) {
            log.debug("Raw output (first 500 chars)", { raw: raw.substring(0, 500) });
          }
          let parsed: unknown;

          try {
            const wrapper = JSON.parse(raw);
            if (wrapper && typeof wrapper === "object" && "result" in wrapper) {
              const content = (wrapper as Record<string, unknown>).result;
              if (typeof content === "string" && content.trim()) {
                const cleaned = content
                  .replace(/```json\s*/g, "")
                  .replace(/```\s*/g, "")
                  .trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  parsed = JSON.parse(jsonMatch[0]);
                }
              }
              if (!parsed) {
                log.info("Claude wrapper result field empty or not JSON", {
                  result: String(content).substring(0, 200),
                });
              }
            } else {
              parsed = wrapper;
            }
          } catch {
            // R5: parse failure → fallback
            const jsonMatch = raw.match(/\{[\s\S]*"observations"[\s\S]*\}/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]);
            }
          }

          if (parsed) {
            const d = parsed as Record<string, unknown>;
            decision = {
              observations: Array.isArray(d.observations) ? (d.observations as string[]) : [],
              actions: Array.isArray(d.actions)
                ? (d.actions as HeartbeatDecision["actions"])
                : [{ type: "none" }],
              reasoning: typeof d.reasoning === "string" ? d.reasoning : "No reasoning provided",
            };
          } else {
            log.info("No decision parsed from Claude output, skipping.");
          }
        } catch (parseError) {
          log.error("JSON parse failed", { parseError, raw: result.stdout.substring(0, 500) });
        }

        if (decision) {
          log.info(`Decision: ${decision.reasoning}`);
          log.info(
            `Observations: ${decision.observations.length}, Actions: ${decision.actions.length}`,
          );

          executed = await executeActions(decision, supabase, state);
          state.recentActions = [...state.recentActions, ...executed].slice(-10);
        }
      }
    } catch (error) {
      log.error("Heartbeat Claude error", { error });
    }
  }

  // ── Periodic tasks (no Claude needed, run directly) ───────
  // These run regardless of triage result, gated only by time intervals.

  const sprint = (await getCurrentSprint(supabase)) || undefined;

  // Every pulse: Morning digest flush (if quiet hours just ended)
  try {
    await loadPrefs();
    await loadQueue();
    if (!isQuietHours() && getQueue().length > 0) {
      log.info(`Flushing ${getQueue().length} queued notifications as morning digest.`);
      await flushMorningDigest();
    }
  } catch (err) {
    log.error("Morning digest flush error", { error: err });
  }

  // Hourly: Alert checks
  try {
    const hourAgo = now - 60 * 60 * 1000;
    if (!state.lastAlertCheckAt || new Date(state.lastAlertCheckAt).getTime() < hourAgo) {
      log.info("Running hourly alert checks...");
      const alerts = await runAllChecks(supabase, sprint);
      if (alerts.length > 0) {
        log.info(`${alerts.length} alert(s) detected.`);
        for (const alert of alerts) {
          await enqueue({
            type: "alert",
            severity: alert.severity === "critical" ? "critical" : "normal",
            message: `[Alerte] ${alert.message}`,
            data: {
              alertType: alert.type,
              taskId: (alert.data?.taskId as string) || undefined,
            },
          });
        }
      }
      state.lastAlertCheckAt = timestamp;
    }
  } catch (err) {
    log.error("Alert check error", { error: err });
  }

  // Hourly: Memory archival
  try {
    const hourAgo = now - 60 * 60 * 1000;
    if (!state.lastArchivalAt || new Date(state.lastArchivalAt).getTime() < hourAgo) {
      log.info("Running memory archival...");
      const archived = await archiveOldMemories(supabase);
      if (archived > 0) {
        log.info(`Archived ${archived} old memories.`);
      }
      state.lastArchivalAt = timestamp;
    }
  } catch (err) {
    log.error("Memory archival error", { error: err });
  }

  // Every 30min: LLM-Ops check (gated on feature flag)
  try {
    if (isFeatureEnabled("llmops_monitoring")) {
      const llmOpsThreshold = now - LLMOPS_CHECK_INTERVAL_MS;
      if (
        !state.lastLlmOpsCheckAt ||
        new Date(state.lastLlmOpsCheckAt).getTime() < llmOpsThreshold
      ) {
        log.info("Running LLM-Ops check...");
        const notifyFn = async (msg: string) => {
          await enqueue({
            type: "alert",
            severity: "normal",
            message: msg,
          });
        };
        const llmOpsResult = await runLlmOpsCheck(supabase, notifyFn);
        if (llmOpsResult.anomalies.length > 0) {
          log.info(
            `LLM-Ops: ${llmOpsResult.anomalies.length} anomaly(ies), ${llmOpsResult.notificationsSent} notification(s).`,
          );
        }
        state.lastLlmOpsCheckAt = timestamp;
      }
    }
  } catch (err) {
    log.error("LLM-Ops check error", { error: err });
  }

  // Daily: Autonomy scan
  try {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    if (!state.lastAutonomyScanAt || new Date(state.lastAutonomyScanAt).getTime() < dayAgo) {
      log.info("Running daily autonomy scan...");
      const scanResult = await runAllScanners(PROJECT_DIR, supabase);
      if (scanResult.opportunities.length > 0) {
        log.info(`${scanResult.opportunities.length} opportunity(ies) found.`);
        const currentSprint = await getCurrentSprint(supabase);
        let created = 0;
        const MAX_TASKS_PER_RUN = 3;
        for (const opp of scanResult.opportunities.slice(0, MAX_TASKS_PER_RUN)) {
          const duplicate = await isDuplicate(supabase, opp.dedup_key);
          if (duplicate) {
            log.info(`Skip (duplicate): ${opp.title}`);
            continue;
          }
          const task = await addTask(supabase, opp.title, {
            description: opp.description,
            priority: opp.priority,
            sprint: currentSprint ?? undefined,
            tags: ["auto-generated", opp.type],
          });
          if (task) {
            await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id);
            log.info(`Created: ${opp.title} [${task.id.substring(0, 8)}]`);
            created++;
          }
        }
        if (created > 0) {
          await writeMcpPending({
            type: "alert",
            severity: "normal",
            message: `[Autonomie] ${created} tache(s) auto-generee(s) par le scan quotidien.`,
          });
        }
      }
      state.lastAutonomyScanAt = timestamp;
    }
  } catch (err) {
    log.error("Autonomy scan error", { error: err });
  }

  // Daily: Lightweight audit (structure + tests)
  try {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    if (
      isFeatureEnabled("audit_system") &&
      (!state.lastAuditAt || new Date(state.lastAuditAt).getTime() < dayAgo)
    ) {
      log.info("Running daily lightweight audit...");
      const auditResult = await runLightweightAudit(PROJECT_DIR);
      log.info(`Audit score: ${auditResult.score}/100 (${auditResult.gaps.length} gap(s))`);

      // Check for regression (only if we have a previous score)
      if (state.lastAuditScore !== null && state.lastAuditScore - auditResult.score > 5) {
        const delta = state.lastAuditScore - auditResult.score;
        await writeMcpPending({
          type: "alert",
          severity: "normal",
          message: `[Audit] Score structure/tests en regression: ${state.lastAuditScore} -> ${auditResult.score} (${delta} points). ${auditResult.gaps.length} ecart(s) detecte(s).`,
          data: {
            previousScore: state.lastAuditScore,
            currentScore: auditResult.score,
            delta,
            gapCount: auditResult.gaps.length,
          },
        });
        log.info(`Audit regression alert sent: ${state.lastAuditScore} -> ${auditResult.score}`);
      }

      state.lastAuditAt = timestamp;
      state.lastAuditScore = auditResult.score;
    }
  } catch (err) {
    log.error("Lightweight audit error", { error: err });
  }

  // ── Save state and return ─────────────────────────────────
  await saveState(state);

  log.info(`Pulse complete. ${executed.length} action(s) executed.`);
  return { skipped, reasons: triage.interesting ? triage.reasons : [], actions: executed };
}

// ── Entry Point ─────────────────────────────────────────────

if (import.meta.main) {
  pulse().catch((err) => {
    log.error("Heartbeat fatal error", { error: err });
    process.exit(1);
  });
}
