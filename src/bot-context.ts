/**
 * @module bot-context
 * @description Shared dependency object for all Composer modules. Extracts shared state,
 * config, and utility functions from relay.ts so that command modules can access them
 * without globals or closures.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { type Bot, type Context, InputFile } from "grammy";
import { dirname, join } from "path";
import { getConfig } from "./config.ts";
import type { DocumentSearchResult } from "./documents.ts";
import { createLogger } from "./logger.ts";
import { getIdea } from "./memory.ts";
import { analyzeProfile } from "./profile-evolution.ts";
import { getTopicConfig as getTopicConfigHelper, type TopicConfig } from "./topic-config.ts";
import { synthesize } from "./tts.ts";

const log = createLogger("bot-context");
// ============================================================
// CONFIG CONSTANTS
// ============================================================

export const PROJECT_ROOT = dirname(dirname(import.meta.path));

// Config constants derived lazily from getConfig().
// getConfig() is a lazy singleton — it does not throw at module load time.
// These getters are evaluated when the exports are accessed.
export const BOT_TOKEN = (() => {
  try {
    return getConfig().telegramBotToken;
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
})();
export const ALLOWED_USER_ID = (() => {
  try {
    return getConfig().telegramUserId;
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
})();
export const GROUP_ID = (() => {
  try {
    return getConfig().telegramGroupId;
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
})();
export const CLAUDE_PATH = (() => {
  try {
    return getConfig().claudePath;
  } catch {
    // R6: optional IO → degrade gracefully
    return "claude";
  }
})();
export const PROJECT_DIR = (() => {
  try {
    return getConfig().projectDir;
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
})();
export const RELAY_DIR = (() => {
  try {
    const cfg = getConfig();
    return cfg.relayDir || join(process.env.HOME || "~", ".claude-relay");
  } catch {
    // R6: optional IO → degrade gracefully
    return join(process.env.HOME || "~", ".claude-relay");
  }
})();
export const TEMP_DIR = join(RELAY_DIR, "temp");
export const UPLOADS_DIR = join(RELAY_DIR, "uploads");
export const USER_NAME = (() => {
  try {
    return getConfig().userName;
  } catch {
    // R6: optional IO → degrade gracefully
    return "";
  }
})();
export const USER_TIMEZONE = (() => {
  try {
    const cfg = getConfig();
    return cfg.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // R6: optional IO → degrade gracefully
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
})();
export const RELAY_START_TIME = Date.now();

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_FILE = join(RELAY_DIR, "session.json");

// ============================================================
// TYPES
// ============================================================

export interface ClaudeCallOptions {
  resume?: boolean;
  imagePath?: string;
  heartbeat?: { chatId: number | string; threadId?: number };
}

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

export interface Reminder {
  id: string;
  text: string;
  triggerAt: number;
  chatId: number;
  threadId?: number;
}

export type { TopicConfig };

/**
 * Shared dependency object passed to all Composer factory functions.
 * Provides access to bot, supabase, and all shared utility functions.
 */
export interface BotContext {
  bot: Bot;
  supabase: SupabaseClient | null;

  // Claude CLI
  callClaude: (prompt: string, options?: ClaudeCallOptions) => Promise<string>;

  // Message handling
  sendResponse: (ctx: Context, response: string) => Promise<void>;
  sendResponseHtml: (ctx: Context, response: string) => Promise<void>;
  sendVoiceResponse: (ctx: Context, response: string) => Promise<void>;
  buildPrompt: (
    userMessage: string,
    relevantContext?: string,
    memoryContext?: string,
    recentMessages?: string,
    topicName?: string,
    dynamicProfile?: string,
    documentContext?: string,
  ) => string;
  saveMessage: (role: string, content: string, metadata?: Record<string, unknown>) => Promise<void>;
  getDynamicProfile: () => Promise<string>;

  // Telegram helpers
  getThreadId: (ctx: Context) => number | undefined;
  threadOpts: (ctx: Context) => { message_thread_id?: number };
  heartbeatOpts: (ctx: Context) => { chatId: number | string; threadId?: number };
  getTopicName: (ctx: Context) => string | undefined;
  getTopicConfig: (topicName: string | undefined) => TopicConfig | undefined;
  commandGuard: (ctx: Context, command: string) => string | null;

  // Error handling
  recordError: (messageId: number) => boolean;
  clearError: (messageId: number) => void;

  // Shared mutable state
  reminders: Reminder[];
  saveReminders: () => Promise<void>;
  loadReminders: () => Promise<void>;

  // Profile
  profileContext: string;
  reloadProfile: () => Promise<void>;

  // Idea helper
  findIdeaByPrefix: (prefix: string) => Promise<import("./memory.ts").Idea | null>;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    // R6: optional IO → degrade gracefully
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CLAUDE CALL MUTEX
// ============================================================

let claudeBusy = false;
const claudeQueue: Array<{
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  prompt: string;
  options?: ClaudeCallOptions;
}> = [];

// Forward declaration — set by createBotContext when bot is known
let _botRef: Bot | null = null;

async function callClaudeInternal(prompt: string, options?: ClaudeCallOptions): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text", "--dangerously-skip-permissions");

  log.info(`Calling Claude: ${prompt.substring(0, 50)}...`);

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

  if (options?.heartbeat && _botRef) {
    const { chatId, threadId } = options.heartbeat;
    heartbeatTimer = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 60000);
      try {
        const opts: Record<string, unknown> = {};
        if (threadId) opts.message_thread_id = threadId;
        await _botRef!.api.sendMessage(
          chatId,
          `Je travaille toujours dessus... (${elapsed} min)`,
          opts,
        );
      } catch (e) {
        log.error("Heartbeat send error", { error: String(e) });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  try {
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY"].includes(k),
      ),
    );

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: cleanEnv,
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.error("Claude error", { error: String(stderr) });
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
  } catch (error) {
    log.error("Spawn error", { error: String(error) });
    return `Error: Could not run Claude CLI`;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

function processClaudeQueue(): void {
  if (claudeBusy || claudeQueue.length === 0) return;
  claudeBusy = true;
  const { resolve, reject, prompt, options } = claudeQueue.shift()!;
  callClaudeInternal(prompt, options)
    .then(resolve)
    .catch(reject)
    .finally(() => {
      claudeBusy = false;
      processClaudeQueue();
    });
}

async function callClaude(prompt: string, options?: ClaudeCallOptions): Promise<string> {
  if (claudeBusy) {
    return new Promise<string>((resolve, reject) => {
      claudeQueue.push({ resolve, reject, prompt, options });
    });
  }
  claudeBusy = true;
  try {
    return await callClaudeInternal(prompt, options);
  } finally {
    claudeBusy = false;
    processClaudeQueue();
  }
}

// ============================================================
// RATE LIMITER & CIRCUIT BREAKER
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const messageTimestamps: number[] = [];

export function isRateLimited(): boolean {
  const now = Date.now();
  while (messageTimestamps.length > 0 && messageTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    messageTimestamps.shift();
  }
  if (messageTimestamps.length >= RATE_LIMIT_MAX) return true;
  messageTimestamps.push(now);
  return false;
}

const errorCounts = new Map<number, number>();
const CIRCUIT_BREAKER_THRESHOLD = 3;

function recordError(messageId: number): boolean {
  const count = (errorCounts.get(messageId) || 0) + 1;
  errorCounts.set(messageId, count);
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    log.error(`Circuit breaker: skipping message ${messageId} after ${count} errors`);
    errorCounts.delete(messageId);
    return true;
  }
  return false;
}

function clearError(messageId: number): void {
  errorCounts.delete(messageId);
}

/** Clear stale rate limit and error state. Call periodically from main. */
export function clearStaleState(): void {
  errorCounts.clear();
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (messageTimestamps.length > 0 && messageTimestamps[0] < cutoff) {
    messageTimestamps.shift();
  }
}

// ============================================================
// REMINDERS
// ============================================================

const REMINDERS_FILE = join(RELAY_DIR, "reminders.json");
let reminders: Reminder[] = [];

async function loadReminders(): Promise<void> {
  try {
    const content = await readFile(REMINDERS_FILE, "utf-8");
    reminders = JSON.parse(content);
  } catch {
    // R6: optional IO → degrade gracefully
    reminders = [];
  }
}

async function saveReminders(): Promise<void> {
  await writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

// ============================================================
// SUPABASE
// ============================================================

// Supabase client — lazy init via getConfig() to avoid module-level crash.
// Falls back to null if required env vars are absent (test environments).
function _createSupabase(): SupabaseClient | null {
  try {
    const cfg = getConfig();
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
      return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    }
    return null;
  } catch {
    // R6: optional IO → degrade gracefully
    return null;
  }
}

export const supabase: SupabaseClient | null = _createSupabase();

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
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
    log.error("Supabase save error", { error: String(error) });
  }
}

// ============================================================
// SESSION (loaded at module init)
// ============================================================

const session = await loadSession();

// ============================================================
// TOPIC FORUM HELPERS
// ============================================================

const TOPIC_NAMES: Record<number, string> = {};

type MsgWithThread = { message_thread_id?: number };
function getThreadId(ctx: Context): number | undefined {
  return (
    (ctx.message as MsgWithThread)?.message_thread_id ||
    (ctx.callbackQuery?.message as MsgWithThread)?.message_thread_id
  );
}

function threadOpts(ctx: Context): { message_thread_id?: number } {
  const threadId = getThreadId(ctx);
  return threadId ? { message_thread_id: threadId } : {};
}

function getTopicName(ctx: Context): string | undefined {
  const threadId = getThreadId(ctx);
  if (!threadId) return undefined;
  const topicCreated = (
    ctx.message as { reply_to_message?: { forum_topic_created?: { name?: string } } } | undefined
  )?.reply_to_message?.forum_topic_created;
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
  const config = getTopicConfigHelper(topicName);
  if (!config) return true;
  return config.allowedCommands.includes(command);
}

function commandGuard(ctx: Context, command: string): string | null {
  if (isCommandAllowed(ctx, command)) return null;
  const topicName = getTopicName(ctx) || "ce topic";
  return `La commande /${command} n'est pas disponible dans le topic "${topicName}".`;
}

// ============================================================
// PROFILE
// ============================================================

let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // R6: optional IO → degrade gracefully
}

let dynamicProfileCache = "";
let dynamicProfileLastRefresh = 0;
const PROFILE_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;

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
      parts.push(
        `Types de taches frequents: ${insights.taskPreferences.topTaskTypes
          .slice(0, 3)
          .map((t: { type: string }) => t.type)
          .join(", ")}`,
      );
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
    dynamicProfileCache =
      parts.length > 0 ? `\nDYNAMIC PROFILE (auto-detected):\n${parts.join("\n")}` : "";
    dynamicProfileLastRefresh = Date.now();
  } catch {
    // R7: optional feature → skip
  }
  return dynamicProfileCache;
}

// ============================================================
// DOCUMENT CONTEXT FORMATTER
// ============================================================

/**
 * Formats an array of DocumentSearchResult into a string for prompt injection.
 * Pure function — no side effects, no network calls.
 */
export function formatDocumentContext(results: DocumentSearchResult[]): string {
  if (results.length === 0) return "";

  const lines: string[] = ["--- DOCUMENTS PERTINENTS ---"];

  for (let i = 0; i < results.length; i++) {
    const doc = results[i];
    const title = doc.title || "Document sans titre";
    const category = doc.category_id ? `cat: ${doc.category_id}` : "";
    const date = doc.document_date || "date inconnue";
    const score = Math.round(doc.similarity * 100);

    let summary = "";
    if (doc.extracted_text) {
      summary =
        doc.extracted_text.length > 200
          ? doc.extracted_text.substring(0, 200) + "..."
          : doc.extracted_text;
    }

    const meta = [category, date, `pertinence: ${score}%`].filter(Boolean).join(", ");
    lines.push(`[${i + 1}] ${title} (${meta})`);
    if (summary) lines.push(`    ${summary}`);
  }

  return lines.join("\n");
}

// ============================================================
// PROMPT BUILDER
// ============================================================

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentMessages?: string,
  topicName?: string,
  dynamicProfile?: string,
  documentContext?: string,
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
    "IMPORTANT: Toujours écrire en français avec les accents corrects (é, è, ê, à, â, ù, ç, ô, î, ï, etc.). Ne jamais omettre les accents. Exemples : écrire 'améliorer' et non 'ameliorer', 'déjà' et non 'deja', 'tâche' et non 'tache', 'créé' et non 'cree'. Ceci est critique pour la qualité de la synthèse vocale.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);

  if (topicName) {
    const config = getTopicConfigHelper(topicName);
    if (config) {
      parts.push(
        `\nTOPIC CONTEXT: This message is in the "${topicName}" topic (${config.label}). ${config.systemPrompt}`,
      );
    } else {
      parts.push(
        `\nTOPIC CONTEXT: This message is in the "${topicName}" topic of a Telegram forum group. Stay focused on the topic's subject.`,
      );
    }
  }

  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (dynamicProfile) parts.push(dynamicProfile);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (documentContext) {
    parts.push(`\n${documentContext}`);
    parts.push(
      "Si des documents pertinents sont listés ci-dessus, tu peux les mentionner naturellement dans ta réponse quand c'est utile. Ne force pas leur mention si le sujet n'est pas lié.",
    );
  }
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]",
  );

  // SDD CONVERGENCE instruction — always present (F-DA-1 correction).
  // Behavioral guidance: no side-effect if no SDD pipeline is active.
  // Positioned after MEMORY MANAGEMENT, before VOICE CAPABILITIES (F-DA-2).
  parts.push(
    "\nSDD CONVERGENCE: When the conversation converges on clear decisions, " +
      "produce this exact format at the end of your response:\n" +
      "Decisions:\n- [decision 1]\n- [decision 2]\n" +
      "Prochaine etape: [suggested next step]",
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
        "\n- Respond naturally as if speaking out loud.",
    );
  }

  if (recentMessages) parts.push(`\n${recentMessages}`);
  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;
  const opts = threadOpts(ctx);

  if (!response || !response.trim()) return Promise.resolve();

  if (response.length <= MAX_LENGTH) {
    return ctx.reply(response, opts).then(() => {});
  }

  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return (async () => {
    for (const chunk of chunks) {
      await ctx.reply(chunk, opts);
    }
  })();
}

function sendResponseHtml(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;
  const opts = { ...threadOpts(ctx), parse_mode: "HTML" as const };

  if (!response || !response.trim()) return Promise.resolve();

  if (response.length <= MAX_LENGTH) {
    return ctx.reply(response, opts).then(() => {});
  }

  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return (async () => {
    for (const chunk of chunks) {
      await ctx.reply(chunk, opts);
    }
  })();
}

async function sendVoiceResponse(ctx: Context, response: string): Promise<void> {
  const clean = response
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .trim();

  const TTS_MAX = 4000;
  const ttsText = clean.length > TTS_MAX ? clean.substring(0, TTS_MAX) : clean;
  const opts = threadOpts(ctx);

  try {
    const audioBuffer = await synthesize(ttsText);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "voice.ogg"), opts);
      await sendResponse(ctx, response);
      return;
    }
  } catch (error) {
    log.error("TTS error", { error: String(error) });
  }

  await sendResponse(ctx, response);
}

// ============================================================
// IDEA HELPER
// ============================================================

async function findIdeaByPrefix(prefix: string): Promise<import("./memory.ts").Idea | null> {
  if (!supabase) return null;
  const exact = await getIdea(supabase, prefix);
  if (exact) return exact;

  const { data } = await supabase
    .from("memory")
    .select("id, content, idea_status, metadata, created_at")
    .eq("type", "idea")
    .ilike("id", `${prefix}%`)
    .limit(1);

  return data?.[0] || null;
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Creates a BotContext object with all shared dependencies.
 * Call this after the Bot is created but before loading Composers.
 */
export async function createBotContext(bot: Bot): Promise<BotContext> {
  _botRef = bot;
  await loadReminders();

  return {
    bot,
    supabase,
    callClaude,
    sendResponse,
    sendResponseHtml,
    sendVoiceResponse,
    buildPrompt,
    saveMessage,
    getDynamicProfile,
    getThreadId,
    threadOpts,
    heartbeatOpts,
    getTopicName,
    getTopicConfig: getTopicConfigHelper,
    commandGuard,
    recordError,
    clearError,
    reminders,
    saveReminders,
    loadReminders,
    profileContext,
    reloadProfile: async () => {
      try {
        profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
      } catch {
        // R6: optional IO → degrade gracefully
      }
    },
    findIdeaByPrefix,
  };
}
