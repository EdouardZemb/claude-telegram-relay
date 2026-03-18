/**
 * @module bot-context
 * @description Shared dependency object for all Composer modules. Extracts shared state,
 * config, and utility functions from relay.ts so that command modules can access them
 * without globals or closures.
 */

import { Bot, Context, InputFile } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import { synthesize } from "./tts.ts";
import { analyzeProfile } from "./profile-evolution.ts";
import { getTopicConfig as getTopicConfigHelper, type TopicConfig } from "./topic-config.ts";
import { getIdea } from "./memory.ts";

// ============================================================
// CONFIG CONSTANTS
// ============================================================

export const PROJECT_ROOT = dirname(dirname(import.meta.path));
export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
export const GROUP_ID = process.env.TELEGRAM_GROUP_ID || "";
export const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
export const PROJECT_DIR = process.env.PROJECT_DIR || "";
export const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
export const TEMP_DIR = join(RELAY_DIR, "temp");
export const UPLOADS_DIR = join(RELAY_DIR, "uploads");
export const USER_NAME = process.env.USER_NAME || "";
export const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
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

export { type TopicConfig };

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
  sendVoiceResponse: (ctx: Context, response: string) => Promise<void>;
  buildPrompt: (
    userMessage: string,
    relevantContext?: string,
    memoryContext?: string,
    recentMessages?: string,
    topicName?: string,
    dynamicProfile?: string,
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
  findIdeaByPrefix: (prefix: string) => Promise<any>;
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

async function callClaudeInternal(
  prompt: string,
  options?: ClaudeCallOptions,
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text", "--dangerously-skip-permissions");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

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
        console.error("Heartbeat send error:", e);
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
      console.error("Claude error:", stderr);
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
    console.error("Spawn error:", error);
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

async function callClaude(
  prompt: string,
  options?: ClaudeCallOptions,
): Promise<string> {
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
    console.error(`Circuit breaker: skipping message ${messageId} after ${count} errors`);
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
    reminders = [];
  }
}

async function saveReminders(): Promise<void> {
  await writeFile(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

// ============================================================
// SUPABASE
// ============================================================

export const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

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
    console.error("Supabase save error:", error);
  }
}

// ============================================================
// SESSION (loaded at module init)
// ============================================================

let session = await loadSession();

// ============================================================
// TOPIC FORUM HELPERS
// ============================================================

const TOPIC_NAMES: Record<number, string> = {};

function getThreadId(ctx: Context): number | undefined {
  return (ctx.message as any)?.message_thread_id;
}

function threadOpts(ctx: Context): { message_thread_id?: number } {
  const threadId = getThreadId(ctx);
  return threadId ? { message_thread_id: threadId } : {};
}

function getTopicName(ctx: Context): string | undefined {
  const threadId = getThreadId(ctx);
  if (!threadId) return undefined;
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
  // No profile yet
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
      parts.push(`Types de taches frequents: ${insights.taskPreferences.topTaskTypes.slice(0, 3).map((t: any) => t.type).join(", ")}`);
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
    // Silent fail
  }
  return dynamicProfileCache;
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
      "\n[DONE: search text for completed goal]",
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
    console.error("TTS error:", error);
  }

  await sendResponse(ctx, response);
}

// ============================================================
// IDEA HELPER
// ============================================================

async function findIdeaByPrefix(prefix: string): Promise<any> {
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
      } catch {}
    },
    findIdeaByPrefix,
  };
}
