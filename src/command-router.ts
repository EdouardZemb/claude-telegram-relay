/**
 * @module command-router
 * @description Routes detected intents to command execution. Handles risk-based confirmation
 * (S37-04), contextual parameter extraction (S37-05), and multi-turn clarification (S37-06).
 * Integrated into zz-messages.ts to execute commands directly instead of suggesting.
 */

import { Context, InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DetectedIntent } from "./intent-detection.ts";
import { getAction, type ActionDefinition } from "./action-registry.ts";

// ── Types ────────────────────────────────────────────────────

export interface RouteResult {
  /** Whether the intent was handled (routed to a command or pending confirmation) */
  handled: boolean;
  /** If pending, the action awaiting confirmation */
  pendingAction?: string;
}

export interface RouterContext {
  supabase: SupabaseClient | null;
  getThreadId: (ctx: Context) => number | undefined;
  threadOpts: (ctx: Context) => { message_thread_id?: number };
  /** Dispatch a synthetic command through the bot's handler pipeline */
  dispatchCommand: (ctx: Context, command: string) => Promise<void>;
}

// ── Pending Confirmations (per chat) ─────────────────────────

interface PendingConfirmation {
  command: string;
  args: string;
  timestamp: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();
const CONFIRMATION_TTL_MS = 60_000; // 1 minute

function confirmationKey(ctx: Context): string {
  const chatId = ctx.chat?.id || 0;
  const threadId = (ctx.message as any)?.message_thread_id || 0;
  return `${chatId}:${threadId}`;
}

// ── Pending Clarifications (per chat) ────────────────────────

interface PendingClarification {
  command: string;
  missingParam: string;
  timestamp: number;
}

const pendingClarifications = new Map<string, PendingClarification>();
const CLARIFICATION_TTL_MS = 60_000; // 1 minute

// ── Contextual Parameter Extraction ──────────────────────────

/**
 * Try to resolve missing task ID from context:
 * - Recent conversation mentioning a task
 * - Tasks currently in_progress
 */
async function resolveTaskId(
  supabase: SupabaseClient | null,
  text: string,
): Promise<string | undefined> {
  if (!supabase) return undefined;

  // Check if text contains something that looks like a task ID prefix (hex)
  const idMatch = text.match(/\b([a-f0-9]{4,8})\b/);
  if (idMatch) return idMatch[1];

  // Look for "la tache" / "cette tache" — resolve from in_progress tasks
  if (/\b(la|cette|ma)\s+tache\b/i.test(text)) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title")
      .eq("status", "in_progress")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id.substring(0, 8);
  }

  // "la derniere tache" — most recently created
  if (/\b(derniere|precedente)\s+tache\b/i.test(text)) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title")
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id.substring(0, 8);
  }

  return undefined;
}

/**
 * Try to resolve task from the most recent failed/paused pipeline run.
 * Used when intent is "resume" without explicit task ID.
 */
async function resolveLastFailedPipeline(
  supabase: SupabaseClient | null,
): Promise<{ taskId: string; sessionId: string } | undefined> {
  if (!supabase) return undefined;

  const { data } = await supabase
    .from("pipeline_runs")
    .select("task_id, session_id")
    .in("status", ["failed", "paused"])
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data?.[0]) return undefined;

  return {
    taskId: data[0].task_id.substring(0, 8),
    sessionId: data[0].session_id,
  };
}

/**
 * Try to resolve sprint ID from context
 */
async function resolveSprintId(
  supabase: SupabaseClient | null,
): Promise<string | undefined> {
  if (!supabase) return undefined;

  const { data } = await supabase
    .from("tasks")
    .select("sprint")
    .not("sprint", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  return data?.[0]?.sprint || undefined;
}

// ── Route Intent ─────────────────────────────────────────────

/**
 * Route a detected intent. For high-risk actions, sends a confirmation prompt.
 * For actions missing required params, asks a clarification question.
 * For safe actions, builds a synthetic command message for Grammy to process.
 *
 * Returns whether the message was handled.
 */
export async function routeIntent(
  ctx: Context,
  intent: DetectedIntent,
  rctx: RouterContext,
): Promise<RouteResult> {
  const action = intent.action || getAction(intent.command);
  if (!action) return { handled: false };

  // Check Supabase requirement
  if (action.requiresSupabase && !rctx.supabase) {
    return { handled: false };
  }

  // Resolve missing required parameters from context
  let args = intent.args || "";

  // Resume pipeline: resolve task from last failed pipeline run
  if (action.command === "orchestrate" && args.trim() === "--resume") {
    const resolved = await resolveLastFailedPipeline(rctx.supabase);
    if (resolved) {
      args = `${resolved.taskId} --resume`;
    } else {
      await ctx.reply("Aucun pipeline echoue ou en pause a reprendre.", rctx.threadOpts(ctx));
      return { handled: true };
    }
  }

  const missingParams = action.params.filter((p) => p.required && !args.trim());

  if (missingParams.length > 0) {
    const paramName = missingParams[0]!.name;

    // Try contextual resolution
    if (paramName === "taskId") {
      const resolved = await resolveTaskId(rctx.supabase, ctx.message?.text || "");
      if (resolved) {
        args = resolved;
      }
    } else if (paramName === "sprintId") {
      const resolved = await resolveSprintId(rctx.supabase);
      if (resolved) {
        args = resolved;
      }
    }

    // Still missing — ask for clarification (S37-06)
    if (!args.trim() && missingParams[0]!.required) {
      const key = confirmationKey(ctx);
      pendingClarifications.set(key, {
        command: action.command,
        missingParam: paramName,
        timestamp: Date.now(),
      });

      const question = buildClarificationQuestion(action, paramName);
      await ctx.reply(question, rctx.threadOpts(ctx));
      return { handled: true };
    }
  }

  // High-risk actions require confirmation (S37-04)
  if (action.risk === "high") {
    const key = confirmationKey(ctx);
    pendingConfirmations.set(key, {
      command: action.command,
      args,
      timestamp: Date.now(),
    });

    const cmdStr = args ? `/${action.command} ${args}` : `/${action.command}`;
    const keyboard = new InlineKeyboard()
      .text("Confirmer", `intent_confirm:${action.command}`)
      .text("Annuler", "intent_cancel");

    await ctx.reply(
      `Action detectee : ${cmdStr}\n${action.description}\n\nConfirmer l'execution ?`,
      { ...rctx.threadOpts(ctx), reply_markup: keyboard },
    );
    return { handled: true, pendingAction: action.command };
  }

  // Safe or medium risk — dispatch command through bot handler pipeline
  const cmdStr = args ? `/${action.command} ${args}` : `/${action.command}`;
  await ctx.reply(cmdStr, rctx.threadOpts(ctx));
  await rctx.dispatchCommand(ctx, cmdStr);
  return { handled: true };
}

/**
 * Check if the current message is a response to a pending clarification.
 * Returns the resolved command string, or null if no pending clarification.
 */
export function checkPendingClarification(ctx: Context, text: string): string | null {
  const key = confirmationKey(ctx);
  const pending = pendingClarifications.get(key);
  if (!pending) return null;

  // Check TTL
  if (Date.now() - pending.timestamp > CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(key);
    return null;
  }

  pendingClarifications.delete(key);
  return `/${pending.command} ${text.trim()}`;
}

/**
 * Handle confirmation callback queries (intent_confirm / intent_cancel).
 * Returns the command to execute, or null if cancelled/expired.
 */
export function handleConfirmationCallback(
  ctx: Context,
  data: string,
): string | null {
  if (data === "intent_cancel") {
    const key = confirmationKey(ctx);
    pendingConfirmations.delete(key);
    return null;
  }

  if (data.startsWith("intent_confirm:")) {
    // Retrieve the pending from callbackQuery context
    const chatId = ctx.callbackQuery?.message?.chat?.id || 0;
    const threadId = (ctx.callbackQuery?.message as any)?.message_thread_id || 0;
    const key = `${chatId}:${threadId}`;
    const pending = pendingConfirmations.get(key);

    if (!pending || Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
      pendingConfirmations.delete(key);
      return null;
    }

    pendingConfirmations.delete(key);
    return pending.args
      ? `/${pending.command} ${pending.args}`
      : `/${pending.command}`;
  }

  return null;
}

// ── Clarification Questions ──────────────────────────────────

function buildClarificationQuestion(action: ActionDefinition, paramName: string): string {
  switch (paramName) {
    case "taskId":
      return `Quelle tache veux-tu ${actionVerb(action.command)} ? Donne-moi l'ID ou les premiers caracteres.`;
    case "title":
      return "Quel titre pour la tache ?";
    case "request":
      return "Que veux-tu planifier ? Decris-moi ce que tu veux realiser.";
    case "taskCount":
      return "Combien de taches dans le sprint ?";
    case "time":
      return "A quelle heure ? (ex: 14h30, ou 2h pour dans 2 heures)";
    case "text":
      return "Quel texte pour le rappel ?";
    default:
      return `Quel ${paramName} ?`;
  }
}

function actionVerb(command: string): string {
  switch (command) {
    case "exec": return "executer";
    case "start": return "demarrer";
    case "done": return "terminer";
    case "orchestrate": return "orchestrer";
    case "autopipeline": return "lancer en autopipeline";
    default: return "traiter";
  }
}

// ── Synthetic Update Builder ────────────────────────────────

let _syntheticUpdateCounter = 0;

/**
 * Build a synthetic Telegram Update object that Grammy can process
 * as if the user had typed a command. Preserves the original user's
 * identity so auth middleware passes.
 */
export function buildSyntheticUpdate(ctx: Context, command: string): Record<string, unknown> {
  const slashEnd = command.indexOf(" ");
  const cmdLength = slashEnd !== -1 ? slashEnd : command.length;

  // Handle both message and callback query contexts
  const chat = ctx.chat || ctx.callbackQuery?.message?.chat;
  const from = ctx.from || ctx.callbackQuery?.from;
  const threadId =
    (ctx.message as any)?.message_thread_id ||
    (ctx.callbackQuery?.message as any)?.message_thread_id;

  _syntheticUpdateCounter++;
  const update: Record<string, unknown> = {
    update_id: Date.now() + _syntheticUpdateCounter,
    message: {
      message_id: Date.now() + _syntheticUpdateCounter,
      from,
      chat,
      date: Math.floor(Date.now() / 1000),
      text: command,
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: cmdLength,
        },
      ],
      ...(threadId ? { message_thread_id: threadId } : {}),
    },
  };

  return update;
}
