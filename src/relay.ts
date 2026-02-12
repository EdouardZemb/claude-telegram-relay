/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { cpus, totalmem, freemem, loadavg, uptime as osUptime } from "os";
import { transcribe } from "./transcribe.ts";
import { synthesize } from "./tts.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentMessages,
} from "./memory.ts";
import {
  addTask,
  getBacklog,
  updateTaskStatus,
  getSprintSummary,
  getCurrentSprint,
  formatBacklog,
  formatSprintSummary,
} from "./tasks.ts";
import { executeTask, decomposeTask } from "./agent.ts";
import { buildStoryFile, enrichTaskWithStory, formatStoryPreview } from "./story-files.ts";
import {
  generatePRD,
  savePRD,
  getPRD,
  getPRDs,
  updatePRDStatus,
  formatPRDList,
  formatPRDDetail,
} from "./prd.ts";
import {
  initNotifications,
  notifyPRCreated,
  notifyTaskStarted,
  notifyTaskDone,
} from "./notifications.ts";
import {
  collectSprintMetrics,
  getSprintMetrics,
  getAllSprintMetrics,
  formatMetrics,
  formatMetricsComparison,
  generateRetroData,
  saveRetro,
  acceptRetroActions,
  getRetro,
  formatRetro,
  WorkflowTracker,
  applyWorkflowSuggestions,
} from "./workflow.ts";
import { analyzePatterns, formatPatterns, type WorkflowSuggestion } from "./patterns.ts";
import { runAllChecks, formatAlerts } from "./alerts.ts";
import {
  proposeWorkflowChange,
  extractProposalsFromRetro,
  getPendingProposals,
  formatProposals,
} from "./workflow-propagation.ts";
import {
  analyzeProfile,
  proposeProfileUpdates,
  applyProfileUpdates,
  formatProfileInsights,
  formatProfileUpdates,
} from "./profile-evolution.ts";
import {
  enrichPromptWithAgent,
  buildBmadExecPrompt,
  formatAgentList,
  getAgentForCommand,
} from "./bmad-agents.ts";
import {
  checkGatesWithOverrides,
  overrideGate,
  clearGateOverrides,
} from "./gates.ts";
import {
  orchestrate,
  formatOrchestrationResult,
  DEFAULT_PIPELINE,
  QUICK_PIPELINE,
  REVIEW_PIPELINE,
  type AgentRole,
} from "./orchestrator.ts";
import {
  runAutoPipeline,
  formatPipelineResult,
} from "./auto-pipeline.ts";
import {
  loadFeedbackRules,
  processRetroFeedback,
} from "./feedback-loop.ts";
import {
  analyzeBacklog as analyzeBacklogProactive,
  formatPlannerResult as formatPlannerResultTg,
} from "./proactive-planner.ts";
import {
  listProjects,
  getProject,
  createProject,
  archiveProject,
  updateProject,
  resolveProjectContext,
  setActiveProjectSlug,
  formatProjectList,
  formatProjectDetail,
} from "./projects.ts";
import {
  shardDocument,
  getRelevantShards,
  buildShardedContext,
  buildTaskContext,
  findRelatedDocuments,
  formatCrossRefs,
} from "./document-sharding.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CLAUDE CALL MUTEX (process one message at a time)
// ============================================================

let claudeBusy = false;
interface ClaudeCallOptions {
  resume?: boolean;
  imagePath?: string;
  heartbeat?: { chatId: number | string; threadId?: number };
}
const claudeQueue: Array<{
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  prompt: string;
  options?: ClaudeCallOptions;
}> = [];

async function processClaudeQueue(): Promise<void> {
  if (claudeBusy || claudeQueue.length === 0) return;
  claudeBusy = true;
  const { resolve, reject, prompt, options } = claudeQueue.shift()!;
  try {
    const result = await callClaudeInternal(prompt, options);
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    claudeBusy = false;
    processClaudeQueue();
  }
}

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes — send a "still working" message

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// RATE LIMITER
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // max messages per window
const messageTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Remove old timestamps
  while (messageTimestamps.length > 0 && messageTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    messageTimestamps.shift();
  }
  if (messageTimestamps.length >= RATE_LIMIT_MAX) return true;
  messageTimestamps.push(now);
  return false;
}

// ============================================================
// CIRCUIT BREAKER (skip messages that cause repeated errors)
// ============================================================

const errorCounts = new Map<number, number>(); // message_id → error count
const CIRCUIT_BREAKER_THRESHOLD = 3;

function recordError(messageId: number): boolean {
  const count = (errorCounts.get(messageId) || 0) + 1;
  errorCounts.set(messageId, count);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    console.error(`Circuit breaker: skipping message ${messageId} after ${count} errors`);
    errorCounts.delete(messageId);
    return true; // tripped
  }
  return false;
}

function clearError(messageId: number): void {
  errorCounts.delete(messageId);
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  errorCounts.clear();
  // Also clean up old rate limit timestamps to prevent memory leak
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (messageTimestamps.length > 0 && messageTimestamps[0] < cutoff) {
    messageTimestamps.shift();
  }
}, 300_000);

// ============================================================
// REMINDERS
// ============================================================

interface Reminder {
  id: string;
  text: string;
  triggerAt: number; // epoch ms
  chatId: number;
  threadId?: number; // forum topic thread ID
}

const REMINDERS_FILE = join(RELAY_DIR, "reminders.json");
let reminders: Reminder[] = [];

async function loadReminders(): Promise<void> {
  try {
    const content = await readFile(REMINDERS_FILE, "utf-8");
    reminders = JSON.parse(content);
  } catch {
    reminders = [];
  }
}

async function saveReminders(): Promise<void> {
  await writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

await loadReminders();

// ============================================================
// ERROR NOTIFICATION
// ============================================================

const RELAY_START_TIME = Date.now();

async function notifyError(error: unknown, context: string): Promise<void> {
  console.error(`[${context}]`, error);
  // Will be wired up after bot is created
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully...");
  try { bot?.stop(); } catch {}
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  try { bot?.stop(); } catch {}
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
initNotifications(bot);

// ============================================================
// TOPIC FORUM HELPERS
// ============================================================

// Topic configuration: defines behavior and allowed commands per topic
interface TopicConfig {
  systemPrompt: string;       // Extra instructions for Claude in this topic
  allowedCommands: string[];  // Commands allowed in this topic (empty = all)
  label: string;              // Human-readable label for logs
}

const TOPIC_CONFIGS: Record<string, TopicConfig> = {
  "claude-relay": {
    label: "Dev",
    systemPrompt:
      "This is the development topic for the claude-relay project. " +
      "Focus on technical discussions: code, architecture, bugs, deployments, CI/CD. " +
      "Be precise and technical. Refer to files, functions, and line numbers when relevant. " +
      "You can suggest code changes and execute tasks.",
    allowedCommands: ["exec", "plan", "prd", "task", "backlog", "sprint", "done", "start", "status", "export", "remind", "speak", "metrics", "retro", "patterns", "alerts", "profile"],
  },
  "idees": {
    label: "Brainstorm",
    systemPrompt:
      "This is the brainstorming topic. " +
      "Help explore ideas freely. Be creative, propose alternatives, play devil's advocate. " +
      "No need to be overly technical here — focus on concepts, possibilities, and strategy. " +
      "Ask follow-up questions to refine ideas.",
    allowedCommands: ["task", "plan", "prd", "remind", "speak"],
  },
  "sprint": {
    label: "Sprint",
    systemPrompt:
      "This is the sprint management topic. " +
      "Focus on task tracking, progress updates, priorities, and planning. " +
      "Keep messages short and actionable. Use task IDs when referencing work.",
    allowedCommands: ["task", "backlog", "sprint", "done", "start", "plan", "prd", "exec", "status", "remind", "speak", "metrics", "retro", "patterns", "alerts", "profile"],
  },
  "serveur": {
    label: "Ops",
    systemPrompt:
      "This is the server operations topic. " +
      "Focus on infrastructure, monitoring, deployments, logs, and system health. " +
      "Be practical and direct. Suggest concrete commands when troubleshooting.",
    allowedCommands: ["status", "exec", "remind", "speak"],
  },
};

function getTopicConfig(topicName: string | undefined): TopicConfig | undefined {
  if (!topicName) return undefined;
  const key = topicName.toLowerCase().trim();
  return TOPIC_CONFIGS[key];
}

// Known topic names by thread ID (populated at runtime)
const TOPIC_NAMES: Record<number, string> = {};

function getThreadId(ctx: Context): number | undefined {
  return (ctx.message as any)?.message_thread_id;
}

function isGroupForum(ctx: Context): boolean {
  return GROUP_ID !== "" && ctx.chat?.id.toString() === GROUP_ID;
}

function threadOpts(ctx: Context): { message_thread_id?: number } {
  const threadId = getThreadId(ctx);
  return threadId ? { message_thread_id: threadId } : {};
}

function getTopicName(ctx: Context): string | undefined {
  const threadId = getThreadId(ctx);
  if (!threadId) return undefined;
  // Try to detect topic name from forum_topic_created or cached names
  const topicCreated = (ctx.message as any)?.reply_to_message?.forum_topic_created;
  if (topicCreated?.name) {
    TOPIC_NAMES[threadId] = topicCreated.name;
  }
  return TOPIC_NAMES[threadId];
}

function heartbeatOpts(ctx: Context): { chatId: number | string; threadId?: number } {
  const chatId = ctx.chat?.id ?? "";
  const threadId = getThreadId(ctx);
  return threadId ? { chatId, threadId } : { chatId };
}

function isCommandAllowed(ctx: Context, command: string): boolean {
  const topicName = getTopicName(ctx);
  const config = getTopicConfig(topicName);
  // No topic or no config = all commands allowed (private chat or unknown topic)
  if (!config) return true;
  return config.allowedCommands.includes(command);
}

function commandGuard(ctx: Context, command: string): string | null {
  if (isCommandAllowed(ctx, command)) return null;
  const topicName = getTopicName(ctx) || "ce topic";
  return `La commande /${command} n'est pas disponible dans le topic "${topicName}".`;
}

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  const chatId = ctx.chat?.id.toString();

  // Log chat info for debugging (helps discover group IDs)
  if (ctx.chat && ctx.chat.type !== "private") {
    console.log(`Group message: chat_id=${chatId} thread=${getThreadId(ctx)} from=${userId}`);
  }

  // Accept messages from: private chat with allowed user OR the configured group forum (from allowed user)
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    if (ctx.chat?.type === "private") {
      await ctx.reply("This bot is private.");
    }
    return;
  }

  // If it's a group but not our configured group, ignore
  if (ctx.chat && ctx.chat.type !== "private" && GROUP_ID && chatId !== GROUP_ID) {
    console.log(`Ignored group: ${chatId}`);
    return;
  }

  // Rate limiting
  if (isRateLimited()) {
    await ctx.reply("Trop de messages. Attends un peu avant de renvoyer.", threadOpts(ctx));
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: ClaudeCallOptions
): Promise<string> {
  // If Claude is already busy, queue this call and notify caller
  if (claudeBusy) {
    return new Promise<string>((resolve, reject) => {
      claudeQueue.push({ resolve, reject, prompt, options });
    });
  }
  claudeBusy = true;
  try {
    const result = await callClaudeInternal(prompt, options);
    return result;
  } finally {
    claudeBusy = false;
    processClaudeQueue();
  }
}

async function callClaudeInternal(
  prompt: string,
  options?: ClaudeCallOptions
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text", "--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  // Heartbeat: send periodic "still working" signals on Telegram
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatCount = 0;
  const startTime = Date.now();

  if (options?.heartbeat) {
    const { chatId, threadId } = options.heartbeat;
    heartbeatTimer = setInterval(async () => {
      heartbeatCount++;
      const elapsed = Math.round((Date.now() - startTime) / 60000);
      try {
        const opts: Record<string, unknown> = {};
        if (threadId) opts.message_thread_id = threadId;
        await bot.api.sendMessage(
          chatId,
          `Je travaille toujours dessus... (${elapsed} min)`,
          opts
        );
      } catch (e) {
        console.error("Heartbeat send error:", e);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  try {
    // Filter out Claude Code env vars to prevent nested session detection
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY"].includes(k)
      )
    );

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: cleanEnv,
    });

    // No hard timeout — let the process run until completion
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// /help — list all available commands
bot.command("help", async (ctx) => {
  const help = [
    "COMMANDES — Workflow BMad",
    "",
    "ANALYSE & PLANIFICATION",
    "  /prd <description> -- Creer un PRD (Product Manager John)",
    "  /plan <description> -- Decomposer en sous-taches (PM John)",
    "  /agents -- Agents BMad disponibles et leurs roles",
    "",
    "BACKLOG & SPRINT",
    "  /task <titre> -- Ajouter une tache",
    "  /backlog [projet] -- Voir le backlog",
    "  /sprint [id] -- Etat du sprint",
    "  /start <id> -- Demarrer une tache",
    "  /done <id> -- Terminer une tache",
    "",
    "EXECUTION",
    "  /exec <id> -- Lancer l'agent Dev (Amelia)",
    "  /orchestrate <id> [pipeline] -- Pipeline multi-agents (full/quick/review)",
    "  /autopipeline <id> [fast|full] -- Pipeline auto BMad complet",
    "  /workflow -- Voir le processus BMad complet",
    "",
    "QUALITE & AMELIORATION",
    "  /metrics [sprint] -- Metriques (Scrum Master Bob)",
    "  /retro [sprint] -- Retrospective (Bob)",
    "  /patterns -- Analyse multi-sprints (Analyste Mary)",
    "  /alerts -- Alertes proactives (QA Quinn)",
    "  /planify [sprint] -- Analyse proactive du backlog + recommandations",
    "",
    "PROJETS",
    "  /projects -- Tous les projets",
    "  /project create|switch|archive -- Gerer",
    "",
    "UTILITAIRES",
    "  /status -- Etat serveur",
    "  /remind <heure> <texte> -- Rappel",
    "  /speak [texte] -- Synthese vocale",
    "  /profile -- Profil utilisateur",
    "  /export -- Export donnees",
    "",
    "Envoie un texte ou vocal pour discuter librement.",
  ].join("\n");
  await ctx.reply(help, threadOpts(ctx));
});

// /workflow — show BMad workflow overview
bot.command("workflow", async (ctx) => {
  const workflow = [
    "WORKFLOW BMad — Processus Complet",
    "",
    "1. ANALYSE (Analyste Mary)",
    "   Research, domain expertise, competitive analysis",
    "   -> Produit un brief ou une analyse",
    "",
    "2. PLANIFICATION (PM John)",
    "   /prd pour creer le PRD",
    "   /plan pour decomposer en taches",
    "   -> Gate 1 : PRD approuve requis",
    "",
    "3. ARCHITECTURE (Architecte Winston)",
    "   Design technique, decisions ADR",
    "   -> Gate 2 : Architecture validee",
    "",
    "4. EXECUTION (Dev Amelia)",
    "   /exec pour lancer l'implementation",
    "   Tests obligatoires, story files atomiques",
    "   -> Gate 3 : Code review avant merge",
    "",
    "5. QUALITE (QA Quinn)",
    "   Tests automatises, review adversariale",
    "   CI/CD : branche -> PR -> merge -> deploy",
    "",
    "6. RETROSPECTIVE (Scrum Master Bob)",
    "   /retro pour analyser le sprint",
    "   /metrics pour les donnees quantitatives",
    "   /patterns pour les tendances multi-sprints",
    "   -> Les retros decident des ajustements",
    "",
    "Chaque gate peut etre bypassee explicitement.",
    "Le processus s'ameliore via les retros.",
  ].join("\n");
  await ctx.reply(workflow, threadOpts(ctx));
});

// /agents — list BMad agents and their capabilities
bot.command("agents", async (ctx) => {
  const blocked = commandGuard(ctx, "agents");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  await ctx.reply(formatAgentList(), threadOpts(ctx));
});

// /projects — list all projects
bot.command("projects", async (ctx) => {
  const blocked = commandGuard(ctx, "projects");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) { await ctx.reply("Supabase non configure.", threadOpts(ctx)); return; }

  const projects = await listProjects(supabase);
  await sendResponse(ctx, formatProjectList(projects));
});

// /project — manage projects (create, switch, info, archive)
bot.command("project", async (ctx) => {
  const blocked = commandGuard(ctx, "project");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) { await ctx.reply("Supabase non configure.", threadOpts(ctx)); return; }

  const args = ctx.match?.trim() || "";

  // /project (no args) → show current project info
  if (!args) {
    const current = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
    if (current) {
      await sendResponse(ctx, formatProjectDetail(current));
    } else {
      await ctx.reply("Aucun projet actif. Utilise /projects pour voir la liste.", threadOpts(ctx));
    }
    return;
  }

  const [subcommand, ...rest] = args.split(" ");
  const argument = rest.join(" ").trim();

  if (subcommand === "create") {
    if (!argument) {
      await ctx.reply("Usage: /project create <nom du projet>", threadOpts(ctx));
      return;
    }
    const slug = argument
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const project = await createProject(supabase, { name: argument, slug });
    if (project) {
      await ctx.reply(`Projet cree: ${project.name} (${project.slug})\nID: ${project.id.substring(0, 8)}`, threadOpts(ctx));
    } else {
      await ctx.reply("Erreur lors de la creation du projet. Le nom existe peut-etre deja.", threadOpts(ctx));
    }
  } else if (subcommand === "switch") {
    if (!argument) {
      await ctx.reply("Usage: /project switch <slug>", threadOpts(ctx));
      return;
    }
    const project = await getProject(supabase, argument);
    if (project) {
      setActiveProjectSlug(project.slug);
      await ctx.reply(`Projet actif: ${project.name} (${project.slug})`, threadOpts(ctx));
    } else {
      await ctx.reply(`Projet "${argument}" introuvable.`, threadOpts(ctx));
    }
  } else if (subcommand === "archive") {
    if (!argument) {
      await ctx.reply("Usage: /project archive <slug>", threadOpts(ctx));
      return;
    }
    const project = await getProject(supabase, argument);
    if (project) {
      await archiveProject(supabase, project.id);
      await ctx.reply(`Projet archive: ${project.name}`, threadOpts(ctx));
    } else {
      await ctx.reply(`Projet "${argument}" introuvable.`, threadOpts(ctx));
    }
  } else if (subcommand === "topic") {
    // /project topic <topic_id> — link current project to a Telegram topic
    const topicId = parseInt(argument);
    if (isNaN(topicId)) {
      await ctx.reply("Usage: /project topic <topic_thread_id>", threadOpts(ctx));
      return;
    }
    const current = await resolveProjectContext(supabase);
    if (current) {
      await updateProject(supabase, current.id, { telegram_topic_id: topicId });
      await ctx.reply(`Projet ${current.name} lie au topic ${topicId}`, threadOpts(ctx));
    } else {
      await ctx.reply("Aucun projet actif.", threadOpts(ctx));
    }
  } else {
    // /project <slug> — show project info
    const project = await getProject(supabase, subcommand);
    if (project) {
      await sendResponse(ctx, formatProjectDetail(project));
    } else {
      await ctx.reply(`Projet "${subcommand}" introuvable. Commandes: create, switch, archive, topic`, threadOpts(ctx));
    }
  }
});

// /speak command — synthesize text to voice
bot.command("speak", async (ctx) => {
  const blocked = commandGuard(ctx, "speak");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  const text = ctx.match?.trim();

  await ctx.replyWithChatAction("record_voice");

  if (text) {
    // /speak <text> → synthesize the given text
    const audioBuffer = await synthesize(text);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), threadOpts(ctx));
    } else {
      await ctx.reply("TTS is not configured. Set TTS_PROVIDER=local and PIPER_* vars in .env.", threadOpts(ctx));
    }
    return;
  }

  // /speak alone → re-synthesize last assistant message from Supabase
  if (!supabase) {
    await ctx.reply("Supabase not configured — cannot retrieve last message.", threadOpts(ctx));
    return;
  }

  const { data } = await supabase
    .from("messages")
    .select("content")
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!data?.content) {
    await ctx.reply("No previous assistant message found.", threadOpts(ctx));
    return;
  }

  const audioBuffer = await synthesize(data.content.substring(0, 4000));
  if (audioBuffer) {
    await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), threadOpts(ctx));
  } else {
    await ctx.reply("TTS is not configured. Set TTS_PROVIDER=local and PIPER_* vars in .env.", threadOpts(ctx));
  }
});

// /task — add a task to the backlog
bot.command("task", async (ctx) => {
  const blocked = commandGuard(ctx, "task");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const input = ctx.match?.trim();
  if (!input) {
    await ctx.reply("Usage: /task titre de la tache", threadOpts(ctx));
    return;
  }
  // Resolve project context
  const currentProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  const projectSlug = currentProject?.slug || "telegram-relay";
  const task = await addTask(supabase, input, { project: projectSlug, project_id: currentProject?.id });
  if (task) {
    await ctx.reply(`Tache ajoutee: ${task.title}\nProjet: ${projectSlug}\nID: ${task.id.substring(0, 8)}`, threadOpts(ctx));
  } else {
    await ctx.reply("Erreur lors de l'ajout de la tache.", threadOpts(ctx));
  }
});

// /backlog — view current backlog
bot.command("backlog", async (ctx) => {
  const blocked = commandGuard(ctx, "backlog");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const filter = ctx.match?.trim();
  if (filter) {
    // Explicit project filter
    const tasks = await getBacklog(supabase, { project: filter });
    await sendResponse(ctx, formatBacklog(tasks));
  } else {
    // Auto-scope to current project
    const currentProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
    const tasks = await getBacklog(supabase, currentProject ? { project_id: currentProject.id } : undefined);
    const header = currentProject ? `Backlog — ${currentProject.name}\n\n` : "";
    await sendResponse(ctx, header + formatBacklog(tasks));
  }
});

// /sprint — view sprint status or assign tasks to a sprint
bot.command("sprint", async (ctx) => {
  const blocked = commandGuard(ctx, "sprint");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const arg = ctx.match?.trim();

  // Resolve project context for scoping
  const currentProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  const projectFilter = currentProject ? { project_id: currentProject.id } : {};

  if (!arg) {
    // Show current sprint summary
    const current = currentProject?.current_sprint || await getCurrentSprint(supabase);
    if (!current) {
      await ctx.reply("Aucun sprint actif. Utilise /sprint S01 pour en creer un.", threadOpts(ctx));
      return;
    }
    const summary = await getSprintSummary(supabase, current);
    const tasks = await getBacklog(supabase, { sprint: current, ...projectFilter });
    const header = currentProject ? `${currentProject.name} — ` : "";
    const text = header + formatSprintSummary(current, summary) + "\n\n" + formatBacklog(tasks, `Taches ${current}`);
    await sendResponse(ctx, text);
    return;
  }

  // /sprint S01 — show that sprint
  const summary = await getSprintSummary(supabase, arg);
  const tasks = await getBacklog(supabase, { sprint: arg, ...projectFilter });
  const header = currentProject ? `${currentProject.name} — ` : "";
  const text = header + formatSprintSummary(arg, summary) + "\n\n" + formatBacklog(tasks, `Taches ${arg}`);
  await sendResponse(ctx, text);
});

// /done — mark a task as done by ID prefix
bot.command("done", async (ctx) => {
  const blocked = commandGuard(ctx, "done");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const idPrefix = ctx.match?.trim();
  if (!idPrefix) {
    await ctx.reply("Usage: /done <id> (premiers caracteres de l'ID)", threadOpts(ctx));
    return;
  }

  // Find task by ID prefix
  const { data: matches } = await supabase
    .from("tasks")
    .select("id, title")
    .like("id", `${idPrefix}%`)
    .neq("status", "done")
    .limit(2);

  if (!matches || matches.length === 0) {
    await ctx.reply(`Aucune tache trouvee avec l'ID commencant par "${idPrefix}".`, threadOpts(ctx));
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, threadOpts(ctx));
    return;
  }

  const updated = await updateTaskStatus(supabase, matches[0].id, "done");
  if (updated) {
    await ctx.reply(`Fait: ${updated.title}`, threadOpts(ctx));
    // Notify sprint topic if not already in it
    const currentThread = getThreadId(ctx);
    const sprintThread = parseInt(process.env.SPRINT_THREAD_ID || "0");
    if (currentThread !== sprintThread) {
      await notifyTaskDone(updated.title, updated.id);
    }
  } else {
    await ctx.reply("Erreur lors de la mise a jour.", threadOpts(ctx));
  }
});

// /start — mark a task as in_progress by ID prefix
bot.command("start", async (ctx) => {
  // grammY auto-handles /start for new bots, but we override for task management
  if (!supabase) return;
  const idPrefix = ctx.match?.trim();
  if (!idPrefix) return; // /start without args = normal bot start, do nothing
  const blocked = commandGuard(ctx, "start");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }

  const { data: matches } = await supabase
    .from("tasks")
    .select("id, title")
    .like("id", `${idPrefix}%`)
    .eq("status", "backlog")
    .limit(2);

  if (!matches || matches.length === 0) {
    await ctx.reply(`Aucune tache backlog trouvee avec l'ID "${idPrefix}".`, threadOpts(ctx));
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, threadOpts(ctx));
    return;
  }

  const updated = await updateTaskStatus(supabase, matches[0].id, "in_progress");
  if (updated) {
    await ctx.reply(`En cours: ${updated.title}`, threadOpts(ctx));
    // Notify sprint topic if not already in it
    const currentThread = getThreadId(ctx);
    const sprintThread = parseInt(process.env.SPRINT_THREAD_ID || "0");
    if (currentThread !== sprintThread) {
      await notifyTaskStarted(updated.title, updated.id);
    }
  } else {
    await ctx.reply("Erreur lors de la mise a jour.", threadOpts(ctx));
  }
});

// /exec — execute a task from the backlog using a sub-agent
bot.command("exec", async (ctx) => {
  const blocked = commandGuard(ctx, "exec");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const idPrefix = ctx.match?.trim();
  if (!idPrefix) {
    await ctx.reply("Usage: /exec <id> (premiers caracteres de l'ID de la tache)", threadOpts(ctx));
    return;
  }

  const { data: matches } = await supabase
    .from("tasks")
    .select("*")
    .like("id", `${idPrefix}%`)
    .in("status", ["backlog", "in_progress"])
    .limit(2);

  if (!matches || matches.length === 0) {
    await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, threadOpts(ctx));
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(`Plusieurs taches correspondent. Sois plus precis:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`, threadOpts(ctx));
    return;
  }

  const task = matches[0];

  // BMad Gate Check — enforce gates before execution
  const gateFailure = await checkGatesWithOverrides(supabase, task);
  if (gateFailure) {
    const keyboard = gateFailure.overridable
      ? new InlineKeyboard()
          .text("Forcer le bypass", `gate_override:${task.id}:${gateFailure.gate}`)
          .text("Annuler", `gate_cancel:${task.id}`)
      : undefined;
    await ctx.reply(
      `GATE BLOQUEE\n\n${gateFailure.gate}\n${gateFailure.reason}`,
      { ...threadOpts(ctx), reply_markup: keyboard }
    );
    return;
  }

  // Enrich task with sharded document context
  const execProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  if (execProject?.id) {
    const shardedContext = await buildTaskContext(supabase, task.title, execProject.id, 3000);
    if (shardedContext) {
      task.description = (task.description || "") + "\n\nCONTEXTE DOCUMENTS:\n" + shardedContext;
    }
  }

  // Enrich task with story file (BMad structured specs)
  if (supabase) {
    const story = buildStoryFile(task);
    const enriched = await enrichTaskWithStory(supabase, task.id, story);
    if (enriched) {
      // Reload task with persisted story data
      const { data: refreshed } = await supabase
        .from("tasks")
        .select("*")
        .eq("id", task.id)
        .single();
      if (refreshed) {
        Object.assign(task, refreshed);
      }
      const preview = formatStoryPreview(story);
      await ctx.reply(`Story file generee:\n${preview}`, threadOpts(ctx));
    }
  }

  await ctx.reply(`Lancement de l'agent pour: ${task.title}\nCa peut prendre quelques minutes...`, threadOpts(ctx));

  // Workflow tracking
  const tracker = new WorkflowTracker(supabase, {
    taskId: task.id,
    sprintId: task.sprint || undefined,
    startStep: "request",
  });

  // Log transition: request -> execution
  await tracker.transition("execution", { agent_notes: `Exec lance pour: ${task.title}` });

  // Periodic heartbeat so user knows the agent is still running
  let heartbeatCount = 0;
  const heartbeat = setInterval(async () => {
    heartbeatCount++;
    const elapsed = heartbeatCount * 2;
    try {
      await ctx.reply(`Agent en cours... (${elapsed} min)`, threadOpts(ctx));
    } catch {}
  }, 120_000); // Every 2 minutes

  const result = await executeTask(supabase, task, async (msg) => {
    await ctx.reply(msg, threadOpts(ctx));
  });

  clearInterval(heartbeat);

  if (result.success) {
    // Log transition: execution -> review
    await tracker.transition("review", {
      checkpoint_result: "pass",
      agent_notes: `Agent termine avec succes`,
    });

    const duration = Math.round(result.durationMs / 1000);
    const summary = result.output.length > 3000
      ? result.output.substring(result.output.length - 3000)
      : result.output;
    const prLine = result.prUrl ? `\n\nPR: ${result.prUrl}` : "";
    const ciLine = result.ciPassed === false
      ? `\n\nCI echouee: ${result.ciDetails || "voir la PR"}\nTache en statut "review" — a corriger avant merge.`
      : result.ciPassed === true
      ? "\n\nCI OK"
      : "";
    await sendResponse(ctx, `Tache terminee en ${duration}s: ${task.title}${prLine}${ciLine}\n\n${summary}`);

    // Log transition: review -> closure (if CI passed)
    if (result.ciPassed !== false) {
      await tracker.transition("closure", {
        checkpoint_result: result.ciPassed ? "pass" : "skipped",
        agent_notes: result.ciPassed ? "CI OK, tache cloturee" : "Pas de CI, tache cloturee",
      });
    } else {
      await tracker.logCheckpoint("fail", `CI echouee: ${result.ciDetails || "details dans la PR"}`);
    }

    // Proactive notifications to other topics
    if (result.prUrl) {
      const branchName = `feature/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50)}`;
      await notifyPRCreated(task.title, result.prUrl, branchName);
    }
    if (result.ciPassed !== false) {
      await notifyTaskDone(task.title, task.id);
    }
  } else {
    // Log failure
    await tracker.logCheckpoint("fail", result.error || "Execution echouee");
    const errMsg = result.error || result.output || "Erreur inconnue";
    await sendResponse(ctx, `Echec de la tache: ${task.title}\n\nErreur:\n${errMsg.substring(0, 2000)}`);
  }

  // Clear gate overrides after execution
  clearGateOverrides(task.id);
});

// /orchestrate — run a task through a multi-agent pipeline
bot.command("orchestrate", async (ctx) => {
  const blocked = commandGuard(ctx, "orchestrate");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const args = ctx.match?.trim() || "";
  // Parse: /orchestrate <taskId> [pipeline]
  // pipeline: "full" (default), "quick", "review", or comma-separated agent IDs
  const parts = args.split(/\s+/);
  const idPrefix = parts[0];
  const pipelineArg = parts[1] || "full";

  if (!idPrefix) {
    await ctx.reply(
      "Usage: /orchestrate <id> [pipeline]\n\n" +
      "Pipelines disponibles:\n" +
      "  full — Analyst -> PM -> Architect -> Dev -> QA (defaut)\n" +
      "  quick — Dev -> QA\n" +
      "  review — QA -> Architect\n" +
      "  custom — ex: /orchestrate abc pm,dev,qa",
      threadOpts(ctx)
    );
    return;
  }

  // Find task
  const { data: matches } = await supabase
    .from("tasks")
    .select("*")
    .like("id", `${idPrefix}%`)
    .in("status", ["backlog", "in_progress"])
    .limit(2);

  if (!matches || matches.length === 0) {
    await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, threadOpts(ctx));
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(
      `Plusieurs taches correspondent:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
      threadOpts(ctx)
    );
    return;
  }

  const task = matches[0];

  // Resolve pipeline
  let pipeline: AgentRole[];
  const validAgents: AgentRole[] = ["analyst", "pm", "architect", "dev", "qa", "sm"];
  if (pipelineArg === "full") {
    pipeline = [...DEFAULT_PIPELINE];
  } else if (pipelineArg === "quick") {
    pipeline = [...QUICK_PIPELINE];
  } else if (pipelineArg === "review") {
    pipeline = [...REVIEW_PIPELINE];
  } else {
    // Custom: comma-separated agent IDs
    const customAgents = pipelineArg.split(",").map((s) => s.trim().toLowerCase());
    const invalid = customAgents.filter((a) => !validAgents.includes(a as AgentRole));
    if (invalid.length > 0) {
      await ctx.reply(
        `Agents inconnus: ${invalid.join(", ")}\nAgents valides: ${validAgents.join(", ")}`,
        threadOpts(ctx)
      );
      return;
    }
    pipeline = customAgents as AgentRole[];
  }

  await ctx.reply(
    `Orchestration lancee pour: ${task.title}\nPipeline: ${pipeline.join(" -> ")}\nCa peut prendre plusieurs minutes...`,
    threadOpts(ctx)
  );

  const result = await orchestrate(supabase, task, {
    pipeline,
    stopOnFailure: true,
    onProgress: async (msg) => {
      await ctx.reply(msg, threadOpts(ctx));
    },
  });

  const formatted = formatOrchestrationResult(result);
  await sendResponse(ctx, formatted);
});

// /autopipeline — run a task through the full automated BMad pipeline
bot.command("autopipeline", async (ctx) => {
  const blocked = commandGuard(ctx, "autopipeline");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const args = ctx.match?.trim() || "";
  const parts = args.split(/\s+/);
  const idPrefix = parts[0];
  const mode = parts[1] || "fast"; // "fast" (default) or "full" (with analysis)

  if (!idPrefix) {
    await ctx.reply(
      "Usage: /autopipeline <id> [fast|full]\n\n" +
      "Modes:\n" +
      "  fast — Gate -> Story -> Dev -> Review (defaut)\n" +
      "  full — Gate -> Story -> Analyst+PM+Architect -> Dev -> Review",
      threadOpts(ctx)
    );
    return;
  }

  const { data: matches } = await supabase
    .from("tasks")
    .select("*")
    .like("id", `${idPrefix}%`)
    .in("status", ["backlog", "in_progress"])
    .limit(2);

  if (!matches || matches.length === 0) {
    await ctx.reply(`Aucune tache trouvee avec l'ID "${idPrefix}".`, threadOpts(ctx));
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(
      `Plusieurs taches correspondent:\n${matches.map((m: { id: string; title: string }) => `  ${m.id.substring(0, 8)} — ${m.title}`).join("\n")}`,
      threadOpts(ctx)
    );
    return;
  }

  const task = matches[0];

  await ctx.reply(
    `AUTO-PIPELINE lance pour: ${task.title}\nMode: ${mode}\nLe pipeline tourne en autonomie. Notifications a chaque phase.`,
    threadOpts(ctx)
  );

  const result = await runAutoPipeline(supabase, task, {
    includeAnalysis: mode === "full",
    onProgress: async (msg) => {
      await ctx.reply(msg, threadOpts(ctx));
    },
  });

  const formatted = formatPipelineResult(result);
  await sendResponse(ctx, formatted);
});

// /plan — decompose a request into sub-tasks and add them to the backlog
bot.command("plan", async (ctx) => {
  const blocked = commandGuard(ctx, "plan");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const request = ctx.match?.trim();
  if (!request) {
    await ctx.reply("Usage: /plan description de ce que tu veux realiser", threadOpts(ctx));
    return;
  }

  // Resolve project context
  const currentProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  const projectSlug = currentProject?.slug || "telegram-relay";

  await ctx.reply("Decomposition en cours...", threadOpts(ctx));

  // Workflow tracking for the decomposition step
  const currentSprint = currentProject?.current_sprint || await getCurrentSprint(supabase);
  const tracker = new WorkflowTracker(supabase, {
    sprintId: currentSprint || undefined,
    startStep: "request",
  });
  await tracker.transition("decomposition", { agent_notes: `Plan demande: ${request.substring(0, 100)}` });

  const subtasks = await decomposeTask(request);

  if (subtasks.length === 0) {
    await tracker.logCheckpoint("fail", "Aucune sous-tache generee");
    await ctx.reply("Impossible de decomposer cette demande. Reformule ou ajoute plus de details.", threadOpts(ctx));
    return;
  }

  await tracker.logCheckpoint("pass", `${subtasks.length} sous-taches generees`);
  await tracker.transition("validation", { agent_notes: `${subtasks.length} sous-taches proposees` });

  const added = [];
  for (const st of subtasks) {
    const task = await addTask(supabase, st.title, {
      description: st.description,
      priority: st.priority,
      project: projectSlug,
      project_id: currentProject?.id,
    });
    if (task) {
      // Persist acceptance criteria from decomposition
      if (st.acceptance_criteria) {
        await supabase.from("tasks").update({
          acceptance_criteria: st.acceptance_criteria,
        }).eq("id", task.id);
        task.acceptance_criteria = st.acceptance_criteria;
      }
      // Generate and persist story file for each subtask
      const story = buildStoryFile(task);
      await enrichTaskWithStory(supabase, task.id, story);
      added.push(task);
    }
  }

  const lines = added.map((t, i) => {
    const acCount = (t.acceptance_criteria || "").split("\n").filter((l: string) => l.trim()).length;
    return `${i + 1}. P${t.priority} ${t.title} [${t.id.substring(0, 8)}]${acCount > 0 ? ` (${acCount} ACs)` : ""}`;
  });
  await sendResponse(ctx, `${added.length} taches ajoutees au backlog avec story files:\n\n${lines.join("\n")}\n\nUtilise /exec <id> pour lancer l'execution d'une tache.`);
});

// /prd — generate a PRD from a description, or list existing PRDs
bot.command("prd", async (ctx) => {
  const blocked = commandGuard(ctx, "prd");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }
  const input = ctx.match?.trim();

  // Resolve project context
  const currentProject = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  const projectSlug = currentProject?.slug || "telegram-relay";

  // /prd without args → list PRDs for current project
  if (!input) {
    const prds = await getPRDs(supabase, { project: projectSlug });
    await sendResponse(ctx, formatPRDList(prds));
    return;
  }

  // /prd <id> (8 chars or less, looks like a UUID prefix) → show detail
  if (input.length <= 8 && /^[a-f0-9]+$/.test(input)) {
    const prd = await getPRD(supabase, input);
    if (!prd) {
      await ctx.reply(`Aucun PRD trouve avec l'ID "${input}".`, threadOpts(ctx));
      return;
    }
    const detail = formatPRDDetail(prd);
    // Send with validation buttons if still draft
    if (prd.status === "draft") {
      const keyboard = new InlineKeyboard()
        .text("Approuver", `prd_approve:${prd.id}`)
        .text("Rejeter", `prd_reject:${prd.id}`)
        .row()
        .text("Modifier", `prd_revise:${prd.id}`);
      // Split if too long for a single message with keyboard
      if (detail.length > 4000) {
        await sendResponse(ctx, detail);
        await ctx.reply("Actions:", { ...threadOpts(ctx), reply_markup: keyboard });
      } else {
        await ctx.reply(detail, { ...threadOpts(ctx), reply_markup: keyboard });
      }
    } else {
      await sendResponse(ctx, detail);
    }
    return;
  }

  // /prd <description> → generate new PRD
  await ctx.reply("Generation du PRD en cours...", threadOpts(ctx));

  const generated = await generatePRD(input, projectSlug);
  if (!generated) {
    await ctx.reply("Impossible de generer le PRD. Reformule ou ajoute plus de details.", threadOpts(ctx));
    return;
  }

  const prd = await savePRD(supabase, generated, {
    project: projectSlug,
    requested_by: ctx.from?.first_name || "unknown",
  });

  if (!prd) {
    await ctx.reply("Erreur lors de la sauvegarde du PRD.", threadOpts(ctx));
    return;
  }

  // Auto-shard the PRD for efficient context loading
  const currentProjectForShard = await resolveProjectContext(supabase, ctx.message?.message_thread_id);
  await shardDocument(supabase, {
    id: prd.id,
    title: prd.title,
    content: prd.content,
    type: "prd",
    project_id: currentProjectForShard?.id,
  });

  const detail = formatPRDDetail(prd);
  const keyboard = new InlineKeyboard()
    .text("Approuver", `prd_approve:${prd.id}`)
    .text("Rejeter", `prd_reject:${prd.id}`)
    .row()
    .text("Modifier", `prd_revise:${prd.id}`);

  // Send PRD content then buttons
  if (detail.length > 4000) {
    await sendResponse(ctx, detail);
    await ctx.reply("Actions:", { ...threadOpts(ctx), reply_markup: keyboard });
  } else {
    await ctx.reply(detail, { ...threadOpts(ctx), reply_markup: keyboard });
  }
});

// Callback query handler for PRD validation buttons
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("prd_")) {
    if (!supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    const [action, prdId] = data.split(":");
    if (!prdId) {
      await ctx.answerCallbackQuery({ text: "ID manquant." });
      return;
    }

    if (action === "prd_approve") {
      const updated = await updatePRDStatus(supabase, prdId, "approved");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD approuve !" });
        await ctx.editMessageText(
          `PRD APPROUVE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nLe PRD est maintenant pret pour l'implementation. Utilise /plan pour decomposer en taches.`
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_reject") {
      const updated = await updatePRDStatus(supabase, prdId, "rejected");
      if (updated) {
        await ctx.answerCallbackQuery({ text: "PRD rejete." });
        await ctx.editMessageText(
          `PRD REJETE: ${updated.title} [${updated.id.substring(0, 8)}]\n\nCree un nouveau PRD avec /prd si tu veux reprendre.`
        );
      } else {
        await ctx.answerCallbackQuery({ text: "Erreur." });
      }
    } else if (action === "prd_revise") {
      await ctx.answerCallbackQuery({ text: "Envoie tes modifications." });
      await ctx.editMessageText(
        `PRD en revision [${prdId.substring(0, 8)}]\n\nDecris les modifications souhaitees dans un message. Je regenererai le PRD avec tes retours.`
      );
    }
    return;
  }

  // Retro validation callbacks
  if (data.startsWith("retro_")) {
    if (!supabase) {
      await ctx.answerCallbackQuery({ text: "Supabase non configure." });
      return;
    }

    const [action, sprintId] = data.split(":");
    if (!sprintId) {
      await ctx.answerCallbackQuery({ text: "Sprint ID manquant." });
      return;
    }

    if (action === "retro_accept_all") {
      const retro = await getRetro(supabase, sprintId);
      if (retro?.actions_proposed) {
        await acceptRetroActions(supabase, sprintId, retro.actions_proposed);

        // Process feedback rules from retro (S17-01: activate feedback loop)
        const feedbackResult = await processRetroFeedback(supabase, {
          sprint_id: sprintId,
          what_didnt: retro.what_didnt || [],
          patterns_detected: retro.patterns_detected || [],
          actions_proposed: retro.actions_proposed,
        });
        console.log(`Feedback loop: ${feedbackResult.newRules} new rules, ${feedbackResult.updatedRules} updated`);

        // Reload feedback rules into memory so buildFeedbackContext uses fresh data
        await loadFeedbackRules(supabase);

        // Apply workflow suggestions (checkpoint mode changes) from accepted actions
        const workflowChanges = applyWorkflowSuggestions(retro.actions_proposed);

        // Cross-project propagation: extract and propose workflow changes
        const currentProject = await resolveProjectContext(supabase, ctx.callbackQuery?.message?.message_thread_id);
        if (currentProject?.id) {
          const proposals = extractProposalsFromRetro(
            { sprint: sprintId, actions: retro.actions_proposed },
            currentProject.id
          );
          const propagationResults: string[] = [];
          for (const p of proposals) {
            const result = await proposeWorkflowChange(supabase, {
              ...p,
              projectId: currentProject.id,
              sprint: sprintId,
            });
            if (result.promoted) {
              propagationResults.push(`PROMU: ${p.target} — ${p.description} (${result.votes} votes)`);
            } else if (!result.isNew) {
              propagationResults.push(`Vote ajoute: ${p.target} (${result.votes} votes)`);
            } else {
              propagationResults.push(`Propose: ${p.target}`);
            }
          }
          if (propagationResults.length > 0) {
            workflowChanges.push(...propagationResults.map((r) => `[CROSS-PROJET] ${r}`));
          }
        }

        let message = `Retro ${sprintId} : toutes les actions ont ete validees.`;
        if (workflowChanges.length > 0) {
          message += `\n\nModifications appliquees :\n${workflowChanges.map(c => `  ${c}`).join("\n")}`;
        } else {
          message += " Elles seront prises en compte dans le prochain sprint.";
        }

        await ctx.answerCallbackQuery({ text: "Actions validees !" });
        await ctx.editMessageText(message);
      }
    } else if (action === "retro_reject") {
      await ctx.answerCallbackQuery({ text: "Actions rejetees." });
      await ctx.editMessageText(
        `Retro ${sprintId} : actions rejetees. Tu peux relancer /retro ${sprintId} pour regenerer.`
      );
    }
    return;
  }

  // Gate override callbacks (BMad gates)
  if (data.startsWith("gate_")) {
    const parts = data.split(":");
    const action = parts[0]; // gate_override or gate_cancel
    const taskId = parts[1];

    if (action === "gate_override" && taskId) {
      const gateName = parts.slice(2).join(":"); // gate name may contain colons
      overrideGate(taskId, gateName);

      // Audit trail: log gate override
      if (supabase) {
        await supabase.from("workflow_audit").insert({
          task_id: taskId,
          action: "gate_override",
          field: gateName,
          from_value: "blocked",
          to_value: "overridden",
          reason: `User override via Telegram button`,
        }).catch(() => {});
      }

      await ctx.answerCallbackQuery({ text: "Gate bypassed." });
      await ctx.editMessageText(
        `Gate bypassed: ${gateName}\n\nRelance /exec ${taskId.substring(0, 8)} pour executer la tache.`
      );
    } else if (action === "gate_cancel" && taskId) {
      await ctx.answerCallbackQuery({ text: "Execution annulee." });
      await ctx.editMessageText(
        `Execution annulee. Resous la gate avant de relancer /exec.`
      );
    }
    return;
  }

  // Profile update callbacks
  if (data.startsWith("profile_")) {
    if (data === "profile_apply") {
      if (!supabase) {
        await ctx.answerCallbackQuery({ text: "Supabase non configure." });
        return;
      }
      const insights = await analyzeProfile(supabase);
      const updates = proposeProfileUpdates(insights, profileContext);
      if (updates.length > 0) {
        const applied = applyProfileUpdates(updates);
        if (applied) {
          // Reload profile context
          try {
            profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
          } catch {}
          await ctx.answerCallbackQuery({ text: "Profil mis a jour !" });
          await ctx.editMessageText("Profil mis a jour avec succes.");
        } else {
          await ctx.answerCallbackQuery({ text: "Erreur lors de la mise a jour." });
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Aucune mise a jour a appliquer." });
      }
    } else if (data === "profile_skip") {
      await ctx.answerCallbackQuery({ text: "Modifications ignorees." });
      await ctx.editMessageText("Modifications du profil ignorees.");
    }
    return;
  }

  // Unknown callback
  await ctx.answerCallbackQuery();
});

// /status — server and bot status
bot.command("status", async (ctx) => {
  const blocked = commandGuard(ctx, "status");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  try {
    const uptimeSec = Math.round((Date.now() - RELAY_START_TIME) / 1000);
    const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    const memUsed = Math.round((totalmem() - freemem()) / 1024 / 1024);
    const memTotal = Math.round(totalmem() / 1024 / 1024);
    const memPct = Math.round((1 - freemem() / totalmem()) * 100);
    const load = loadavg();

    const parts = [
      `Serveur: ${require("os").hostname()}`,
      `Uptime bot: ${uptimeStr}`,
      `Uptime systeme: ${Math.floor(osUptime() / 3600)}h`,
      `CPU: ${cpus().length} cores, load ${load[0].toFixed(1)} / ${load[1].toFixed(1)} / ${load[2].toFixed(1)}`,
      `Memoire: ${memUsed}/${memTotal} MB (${memPct}%)`,
    ];

    // PM2 services
    try {
      const pm2Output = execSync("npx pm2 jlist 2>/dev/null", { timeout: 5000 }).toString();
      const pm2Apps = JSON.parse(pm2Output);
      parts.push("");
      parts.push("Services PM2:");
      for (const app of pm2Apps) {
        const status = app.pm2_env?.status || "unknown";
        const restarts = app.pm2_env?.restart_time || 0;
        const mem = Math.round((app.monit?.memory || 0) / 1024 / 1024);
        parts.push(`  ${app.name}: ${status} (${mem}MB, ${restarts} restarts)`);
      }
    } catch {}

    // Message count today
    if (supabase) {
      const today = new Date().toISOString().split("T")[0];
      const { count } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .gte("created_at", today);
      parts.push("");
      parts.push(`Messages aujourd'hui: ${count ?? 0}`);
    }

    await sendResponse(ctx, parts.join("\n"));
  } catch (error) {
    console.error("Status error:", error);
    await ctx.reply("Erreur lors de la recuperation du statut.", threadOpts(ctx));
  }
});

// /remind — set a timed reminder
bot.command("remind", async (ctx) => {
  const blocked = commandGuard(ctx, "remind");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  const input = ctx.match?.trim();
  if (!input) {
    await ctx.reply("Usage: /remind 14h30 Appeler le client\nOu: /remind 2h Verifier les logs", threadOpts(ctx));
    return;
  }

  // Parse time: either HH:MM (absolute) or Nh/Nm (relative)
  const relativeMatch = input.match(/^(\d+)(h|m)\s+(.+)$/i);
  const absoluteMatch = input.match(/^(\d{1,2})[h:](\d{2})?\s+(.+)$/i);

  let triggerAt: number;
  let text: string;
  let timeLabel: string;

  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    text = relativeMatch[3];
    const ms = unit === "h" ? amount * 3600_000 : amount * 60_000;
    triggerAt = Date.now() + ms;
    timeLabel = `dans ${amount}${unit}`;
  } else if (absoluteMatch) {
    const hours = parseInt(absoluteMatch[1]);
    const minutes = parseInt(absoluteMatch[2] || "0");
    text = absoluteMatch[3];
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1); // Tomorrow if time already passed
    }
    triggerAt = target.getTime();
    timeLabel = `a ${hours}h${minutes.toString().padStart(2, "0")}`;
  } else {
    await ctx.reply("Format non reconnu. Exemples:\n/remind 14h30 Appeler le client\n/remind 2h Verifier les logs\n/remind 30m Pause cafe", threadOpts(ctx));
    return;
  }

  const reminder: Reminder = {
    id: crypto.randomUUID().substring(0, 8),
    text,
    triggerAt,
    chatId: ctx.chat.id,
    threadId: getThreadId(ctx),
  };

  reminders.push(reminder);
  await saveReminders();

  await ctx.reply(`Rappel programme ${timeLabel}: ${text}`, threadOpts(ctx));
});

// /patterns — multi-sprint pattern analysis
bot.command("patterns", async (ctx) => {
  const blocked = commandGuard(ctx, "patterns");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  await ctx.replyWithChatAction("typing");
  const analysis = await analyzePatterns(supabase);
  await sendResponse(ctx, formatPatterns(analysis));
});

// /alerts — proactive anomaly detection
bot.command("alerts", async (ctx) => {
  const blocked = commandGuard(ctx, "alerts");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const arg = ctx.match?.trim();
  const sprintId = arg || await getCurrentSprint(supabase) || undefined;

  await ctx.replyWithChatAction("typing");
  const alerts = await runAllChecks(supabase, sprintId);
  await sendResponse(ctx, formatAlerts(alerts));
});

// /planify — proactive backlog analysis with recommendations
bot.command("planify", async (ctx) => {
  const blocked = commandGuard(ctx, "planify");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const arg = ctx.match?.trim();
  const sprintId = arg || await getCurrentSprint(supabase) || undefined;

  await ctx.replyWithChatAction("typing");
  const result = await analyzeBacklogProactive(supabase, sprintId);
  await sendResponse(ctx, formatPlannerResultTg(result));
});

// /profile — analyze and evolve user profile
bot.command("profile", async (ctx) => {
  const blocked = commandGuard(ctx, "profile");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  await ctx.replyWithChatAction("typing");
  const insights = await analyzeProfile(supabase);
  const updates = proposeProfileUpdates(insights, profileContext);

  let response = formatProfileInsights(insights);
  if (updates.length > 0) {
    response += "\n\n" + formatProfileUpdates(updates);

    const keyboard = new InlineKeyboard()
      .text("Appliquer les mises a jour", `profile_apply`)
      .row()
      .text("Ignorer", `profile_skip`);
    await sendResponse(ctx, response);
    await ctx.reply("Appliquer ces modifications au profil ?", { ...threadOpts(ctx), reply_markup: keyboard });
  } else {
    await sendResponse(ctx, response);
  }
});

// /export — export conversations and memory
// /metrics — show sprint metrics
bot.command("metrics", async (ctx) => {
  const blocked = commandGuard(ctx, "metrics");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const arg = ctx.match?.trim();

  if (arg === "all" || arg === "compare") {
    const all = await getAllSprintMetrics(supabase);
    await sendResponse(ctx, formatMetricsComparison(all));
    return;
  }

  // Specific sprint or current
  const sprintId = arg || await getCurrentSprint(supabase);
  if (!sprintId) {
    await ctx.reply("Aucun sprint actif. Usage: /metrics S11 ou /metrics all", threadOpts(ctx));
    return;
  }

  // Collect fresh metrics first
  await collectSprintMetrics(supabase, sprintId);
  const metrics = await getSprintMetrics(supabase, sprintId);
  await sendResponse(ctx, formatMetrics(metrics));
});

// /retro — generate or view sprint retrospective
bot.command("retro", async (ctx) => {
  const blocked = commandGuard(ctx, "retro");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  const arg = ctx.match?.trim();
  const sprintId = arg || await getCurrentSprint(supabase);
  if (!sprintId) {
    await ctx.reply("Aucun sprint actif. Usage: /retro S11", threadOpts(ctx));
    return;
  }

  // Check if retro already exists
  const existing = await getRetro(supabase, sprintId);
  if (existing) {
    await sendResponse(ctx, formatRetro(existing));
    return;
  }

  // Generate new retro
  await ctx.reply(`Generation de la retro pour ${sprintId}...`, threadOpts(ctx));
  await ctx.replyWithChatAction("typing");

  // Collect metrics first
  await collectSprintMetrics(supabase, sprintId);
  const retroData = await generateRetroData(supabase, sprintId);

  if (!retroData) {
    await ctx.reply("Pas assez de donnees pour generer une retro.", threadOpts(ctx));
    return;
  }

  // Also run pattern analysis to feed into the retro
  const patternAnalysis = await analyzePatterns(supabase);

  // Use Claude to analyze and generate the retro (enriched with SM agent Bob)
  const smAgent = getAgentForCommand("retro");
  const agentPrefix = smAgent
    ? `Tu es ${smAgent.name}, ${smAgent.title} (${smAgent.icon}). ${smAgent.communicationStyle}\n\n`
    : "";
  const retroPrompt = [
    agentPrefix + "Analyse les donnees suivantes pour generer une retrospective de sprint structuree.",
    "Reponds UNIQUEMENT en JSON valide, sans markdown, sans commentaires.",
    "",
    `Sprint: ${sprintId}`,
    `Metriques: ${JSON.stringify(retroData.metrics)}`,
    `Stats workflow: ${JSON.stringify(retroData.workflowStats)}`,
    `Taches (${retroData.tasks.length}): ${JSON.stringify(retroData.tasks.map((t: any) => ({ title: t.title, status: t.status, priority: t.priority })))}`,
    patternAnalysis.patterns.length > 0
      ? `Patterns detectes automatiquement: ${JSON.stringify(patternAnalysis.patterns.map(p => p.description))}`
      : "",
    patternAnalysis.suggestions.length > 0
      ? `Suggestions workflow automatiques: ${JSON.stringify(patternAnalysis.suggestions.map(s => ({ action: s.action, priority: s.priority, target_step: s.target_step, suggested_change: s.suggested_change })))}`
      : "",
    "",
    'Format JSON attendu:',
    '{"what_worked": ["..."], "what_didnt": ["..."], "patterns_detected": ["..."], "actions_proposed": [{"action": "...", "priority": "high|medium|low", "target_step": "optional_step_id", "suggested_change": "optional_change"}]}',
    "Inclus les suggestions workflow automatiques dans actions_proposed en conservant target_step et suggested_change.",
  ].join("\n");

  try {
    const analysis = await callClaude(retroPrompt, { heartbeat: heartbeatOpts(ctx) });
    const jsonMatch = analysis.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      await ctx.reply("Erreur: impossible de parser la retro generee.", threadOpts(ctx));
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    await saveRetro(supabase, sprintId, {
      what_worked: parsed.what_worked || [],
      what_didnt: parsed.what_didnt || [],
      patterns_detected: parsed.patterns_detected || [],
      actions_proposed: parsed.actions_proposed || [],
      raw_analysis: analysis,
    });

    const retro = await getRetro(supabase, sprintId);
    await sendResponse(ctx, formatRetro(retro));

    // Offer validation buttons
    if (parsed.actions_proposed?.length > 0) {
      const keyboard = new InlineKeyboard()
        .text("Valider toutes les actions", `retro_accept_all:${sprintId}`)
        .row()
        .text("Rejeter", `retro_reject:${sprintId}`);
      await ctx.reply("Valider les actions proposees ?", { ...threadOpts(ctx), reply_markup: keyboard });
    }
  } catch (error) {
    console.error("Retro generation error:", error);
    await ctx.reply("Erreur lors de la generation de la retro.", threadOpts(ctx));
  }
});

bot.command("export", async (ctx) => {
  const blocked = commandGuard(ctx, "export");
  if (blocked) { await ctx.reply(blocked, threadOpts(ctx)); return; }
  if (!supabase) {
    await ctx.reply("Supabase non configure.", threadOpts(ctx));
    return;
  }

  await ctx.replyWithChatAction("upload_document");

  try {
    const [messagesResult, memoryResult, tasksResult] = await Promise.all([
      supabase.from("messages").select("role, content, created_at").order("created_at", { ascending: true }),
      supabase.from("memory").select("type, content, created_at"),
      supabase.from("tasks").select("title, description, status, priority, sprint, created_at, completed_at").order("priority", { ascending: true }),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      messages: messagesResult.data || [],
      memory: memoryResult.data || [],
      tasks: tasksResult.data || [],
    };

    const json = JSON.stringify(exportData, null, 2);
    const buffer = Buffer.from(json, "utf-8");
    const filename = `export_${new Date().toISOString().split("T")[0]}.json`;

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption: `Export: ${exportData.messages.length} messages, ${exportData.memory.length} memories, ${exportData.tasks.length} taches`,
      ...threadOpts(ctx),
    });
  } catch (error) {
    console.error("Export error:", error);
    await ctx.reply("Erreur lors de l'export.", threadOpts(ctx));
  }
});

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const messageId = ctx.message.message_id;

  const threadId = getThreadId(ctx);
  const topicName = getTopicName(ctx);
  console.log(`Message: ${text.substring(0, 50)}...${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

  try {
    await ctx.replyWithChatAction("typing");

    const meta: Record<string, unknown> = {};
    if (threadId) {
      meta.thread_id = threadId;
      if (topicName) meta.topic = topicName;
    }

    await saveMessage("user", text, meta);

    // Gather context: semantic search + facts/goals + recent messages + dynamic profile
    const [relevantContext, memoryContext, recentMessages, dynProfile] = await Promise.all([
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
      getRecentMessages(supabase),
      getDynamicProfile(),
    ]);

    const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext, recentMessages, topicName, dynProfile);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true, heartbeat: heartbeatOpts(ctx) });

    // Parse and save any memory intents, strip tags from response
    const response = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", response, meta);
    await sendResponse(ctx, response);
    clearError(messageId);
  } catch (error) {
    console.error("Text handler error:", error);
    if (!recordError(messageId)) {
      await ctx.reply("Erreur lors du traitement du message. Reessaie.", threadOpts(ctx)).catch(() => {});
    }
  }
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const messageId = ctx.message.message_id;
  const threadId = getThreadId(ctx);
  const topicName = getTopicName(ctx);
  console.log(`Voice message: ${voice.duration}s${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

  try {
    await ctx.replyWithChatAction("typing");

    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply(
        "Voice transcription is not set up yet. " +
          "Run the setup again and choose a voice provider (Groq or local Whisper).",
        threadOpts(ctx)
      );
      return;
    }

    const meta: Record<string, unknown> = {};
    if (threadId) {
      meta.thread_id = threadId;
      if (topicName) meta.topic = topicName;
    }

    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.", threadOpts(ctx));
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, meta);

    const [relevantContext, memoryContext, recentMessages, dynProfile] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
      getRecentMessages(supabase),
      getDynamicProfile(),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext,
      recentMessages,
      topicName,
      dynProfile
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true, heartbeat: heartbeatOpts(ctx) });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse, meta);
    await sendVoiceResponse(ctx, claudeResponse);
    clearError(messageId);
  } catch (error) {
    console.error("Voice error:", error);
    if (!recordError(messageId)) {
      await ctx.reply("Erreur lors du traitement du vocal. Reessaie.", threadOpts(ctx)).catch(() => {});
    }
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const messageId = ctx.message.message_id;
  const threadId = getThreadId(ctx);
  const topicName = getTopicName(ctx);
  console.log(`Image received${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

  try {
    await ctx.replyWithChatAction("typing");

    const meta: Record<string, unknown> = {};
    if (threadId) {
      meta.thread_id = threadId;
      if (topicName) meta.topic = topicName;
    }

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`, meta);

    const claudeResponse = await callClaude(prompt, { resume: true, heartbeat: heartbeatOpts(ctx) });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse, meta);
    await sendResponse(ctx, cleanResponse);
    clearError(messageId);
  } catch (error) {
    console.error("Image error:", error);
    if (!recordError(messageId)) {
      await ctx.reply("Erreur lors du traitement de l'image. Reessaie.", threadOpts(ctx)).catch(() => {});
    }
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const messageId = ctx.message.message_id;
  const threadId = getThreadId(ctx);
  const topicName = getTopicName(ctx);
  console.log(`Document: ${doc.file_name}${threadId ? ` [topic:${topicName || threadId}]` : ""}`);

  try {
    await ctx.replyWithChatAction("typing");

    const meta: Record<string, unknown> = {};
    if (threadId) {
      meta.thread_id = threadId;
      if (topicName) meta.topic = topicName;
    }

    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, meta);

    const claudeResponse = await callClaude(prompt, { resume: true, heartbeat: heartbeatOpts(ctx) });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse, meta);
    await sendResponse(ctx, cleanResponse);
    clearError(messageId);
  } catch (error) {
    console.error("Document error:", error);
    if (!recordError(messageId)) {
      await ctx.reply("Erreur lors du traitement du document. Reessaie.", threadOpts(ctx)).catch(() => {});
    }
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

// Dynamic profile: cached insights refreshed every 6 hours
let dynamicProfileCache: string = "";
let dynamicProfileLastRefresh = 0;
const PROFILE_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

async function getDynamicProfile(): Promise<string> {
  if (!supabase) return "";
  if (Date.now() - dynamicProfileLastRefresh < PROFILE_REFRESH_INTERVAL && dynamicProfileCache) {
    return dynamicProfileCache;
  }
  try {
    const insights = await analyzeProfile(supabase);
    const parts: string[] = [];
    if (insights.activityPattern.peakHour) {
      parts.push(`Pic d'activite: ${insights.activityPattern.peakHour}h`);
    }
    if (insights.taskPreferences.topTaskTypes.length > 0) {
      parts.push(`Types de taches frequents: ${insights.taskPreferences.topTaskTypes.slice(0, 3).map(t => t.type).join(", ")}`);
    }
    if (insights.taskPreferences.avgTasksPerSprint > 0) {
      parts.push(`Moyenne: ${insights.taskPreferences.avgTasksPerSprint} taches/sprint`);
    }
    if (insights.communicationStyle.prefersBrief) {
      parts.push(`Style: concis`);
    }
    if (insights.activityPattern.activeDays.length > 0) {
      parts.push(`Jours actifs: ${insights.activityPattern.activeDays.slice(0, 3).join(", ")}`);
    }
    if (insights.workflowPreferences.autonomyLevel) {
      parts.push(`Autonomie: ${insights.workflowPreferences.autonomyLevel}`);
    }
    dynamicProfileCache = parts.length > 0 ? `\nDYNAMIC PROFILE (auto-detected):\n${parts.join("\n")}` : "";
    dynamicProfileLastRefresh = Date.now();
  } catch {
    // Silent fail — dynamic profile is a nice-to-have
  }
  return dynamicProfileCache;
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentMessages?: string,
  topicName?: string,
  dynamicProfile?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
    "IMPORTANT: Never use markdown formatting in your responses. No bold (**), no italic (*), no code blocks (```), no inline code (`), no headers (#), no bullet lists (- or *). Write in plain text only. Use line breaks for structure if needed.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);

  if (topicName) {
    const config = getTopicConfig(topicName);
    if (config) {
      parts.push(`\nTOPIC CONTEXT: This message is in the "${topicName}" topic (${config.label}). ${config.systemPrompt}`);
    } else {
      parts.push(`\nTOPIC CONTEXT: This message is in the "${topicName}" topic of a Telegram forum group. Stay focused on the topic's subject.`);
    }
  }

  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (dynamicProfile) parts.push(dynamicProfile);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  if (process.env.VOICE_PROVIDER || process.env.TTS_PROVIDER) {
    parts.push(
      "\nVOICE CAPABILITIES:" +
        "\nYou have full voice capabilities on this Telegram bot." +
        (process.env.VOICE_PROVIDER
          ? "\n- Voice messages from the user are automatically transcribed. When you see '[Voice message transcribed]', respond naturally without mentioning transcription."
          : "") +
        (process.env.TTS_PROVIDER
          ? "\n- Your text responses to voice messages are automatically converted to voice audio. You DO have the ability to respond with voice — never say otherwise."
          : "") +
        "\n- Never suggest installing TTS, speech synthesis, or voice tools — they are already set up and working." +
        "\n- Respond naturally as if speaking out loud."
    );
  }

  if (recentMessages) parts.push(`\n${recentMessages}`);

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;
  const opts = threadOpts(ctx);

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response, opts);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk, opts);
  }
}

async function sendVoiceResponse(ctx: Context, response: string): Promise<void> {
  // Strip any markdown that slipped through
  const clean = response
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();

  // Truncate for TTS (≈2 min of audio max)
  const TTS_MAX = 4000;
  const ttsText = clean.length > TTS_MAX ? clean.substring(0, TTS_MAX) : clean;
  const wasTruncated = response.length > TTS_MAX;
  const opts = threadOpts(ctx);

  try {
    const audioBuffer = await synthesize(ttsText);

    if (audioBuffer) {
      // Always send both: voice + text transcription
      await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), opts);
      await sendResponse(ctx, response);
      return;
    }
  } catch (error) {
    console.error("TTS error:", error);
  }

  // Fallback to text only if TTS fails or is not configured
  await sendResponse(ctx, response);
}

// ============================================================
// REMINDER SCHEDULER
// ============================================================

setInterval(async () => {
  const now = Date.now();
  const due = reminders.filter((r) => r.triggerAt <= now);
  if (due.length === 0) return;

  for (const r of due) {
    try {
      const opts: Record<string, unknown> = {};
      if (r.threadId) opts.message_thread_id = r.threadId;
      await bot.api.sendMessage(r.chatId, `Rappel: ${r.text}`, opts);
    } catch (error) {
      console.error("Reminder send error:", error);
    }
  }

  reminders = reminders.filter((r) => r.triggerAt > now);
  await saveReminders();
}, 30_000); // Check every 30 seconds

// ============================================================
// ERROR NOTIFICATION (wire up after bot is created)
// ============================================================

bot.catch(async (err) => {
  console.error("Bot error:", err);
  if (ALLOWED_USER_ID) {
    try {
      const errorMsg = `Erreur critique du bot:\n${String(err.error || err).substring(0, 500)}`;
      await bot.api.sendMessage(parseInt(ALLOWED_USER_ID), errorMsg);
    } catch {
      // Can't notify — just log
    }
  }
});

// Catch uncaught exceptions and notify
process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  if (ALLOWED_USER_ID) {
    try {
      await bot.api.sendMessage(
        parseInt(ALLOWED_USER_ID),
        `Exception non geree dans le relay:\n${String(error).substring(0, 500)}\n\nLe bot va redemarrer via PM2.`
      );
    } catch {}
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
  if (ALLOWED_USER_ID) {
    try {
      await bot.api.sendMessage(
        parseInt(ALLOWED_USER_ID),
        `Rejection non geree:\n${String(reason).substring(0, 500)}`
      );
    } catch {}
  }
});

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

// Load feedback rules from retros on startup
if (supabase) {
  loadFeedbackRules(supabase).then((rules) => {
    console.log(`Loaded ${rules.length} feedback rules (${rules.filter(r => r.active).length} active)`);
  }).catch((e) => console.error("Failed to load feedback rules:", e));
}

// Drop pending updates on startup to avoid re-processing old messages
await bot.api.deleteWebhook({ drop_pending_updates: true });

bot.start({
  drop_pending_updates: true,
  onStart: () => {
    console.log("Bot is running! (pending updates dropped)");
  },
});
