/**
 * @module commands/command-router
 * @description Routing helpers extracted from zz-messages.ts.
 * Handles intent routing, clarification flow, confirmation callbacks,
 * and synthetic update construction for command dispatch.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { type Context, InlineKeyboard } from "grammy";
import { type ActionDefinition, getAction } from "../action-registry.ts";
import { isFeatureEnabled } from "../feature-flags.ts";
import type { DetectedIntent } from "../intent-detection.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("command-router");

// ── Types ────────────────────────────────────────────────────

export interface RouteResult {
  handled: boolean;
  pendingAction?: string;
}

export interface RouterContext {
  supabase: SupabaseClient | null;
  getThreadId: (ctx: Context) => number | undefined;
  threadOpts: (ctx: Context) => { message_thread_id?: number };
  dispatchCommand: (ctx: Context, command: string) => Promise<void>;
}

// ── Internal types (not exported) ───────────────────────────

interface PendingConfirmation {
  command: string;
  args: string;
  timestamp: number;
}

interface PendingClarification {
  command: string;
  missingParam: string;
  timestamp: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();
const pendingClarifications = new Map<string, PendingClarification>();
const CONFIRMATION_TTL_MS = 60_000;
const CLARIFICATION_TTL_MS = 60_000;

// ── Internal helpers ─────────────────────────────────────────

function confirmationKey(ctx: Context): string {
  const chatId = ctx.chat?.id || 0;
  const threadId = (ctx.message as { message_thread_id?: number })?.message_thread_id || 0;
  return `${chatId}:${threadId}`;
}

async function resolveTaskId(
  supabase: SupabaseClient | null,
  text: string,
): Promise<string | undefined> {
  if (!supabase) return undefined;
  const idMatch = text.match(/\b([a-f0-9]{4,8})\b/);
  if (idMatch) return idMatch[1];
  if (/\b(la|cette|ma)\s+tache\b/i.test(text)) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title")
      .eq("status", "in_progress")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (data?.[0]) return data[0].id.substring(0, 8);
  }
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

async function resolveSprintId(supabase: SupabaseClient | null): Promise<string | undefined> {
  if (!supabase) return undefined;
  const { data } = await supabase
    .from("tasks")
    .select("sprint")
    .not("sprint", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.sprint || undefined;
}

// ── Exported helpers ─────────────────────────────────────────

export function buildClarificationQuestion(action: ActionDefinition, paramName: string): string {
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

export function actionVerb(command: string): string {
  switch (command) {
    case "exec":
      return "executer";
    case "start":
      return "demarrer";
    case "done":
      return "terminer";
    default:
      return "traiter";
  }
}

export async function routeIntent(
  ctx: Context,
  intent: DetectedIntent,
  rctx: RouterContext,
): Promise<RouteResult> {
  const action = intent.action || getAction(intent.command);
  if (!action) {
    log.debug("routeIntent: no action found", { command: intent.command });
    return { handled: false };
  }
  if (action.requiresSupabase && !rctx.supabase) return { handled: false };

  let args = intent.args || "";
  const missingParams = action.params.filter((p) => p.required && !args.trim());

  if (missingParams.length > 0) {
    const paramName = missingParams[0].name;
    if (paramName === "taskId") {
      const resolved = await resolveTaskId(rctx.supabase, ctx.message?.text || "");
      if (resolved) args = resolved;
    } else if (paramName === "sprintId") {
      const resolved = await resolveSprintId(rctx.supabase);
      if (resolved) args = resolved;
    }
    if (!args.trim() && missingParams[0].required) {
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

  if (action.risk === "high") {
    const key = confirmationKey(ctx);
    pendingConfirmations.set(key, { command: action.command, args, timestamp: Date.now() });
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

  const cmdStr = args ? `/${action.command} ${args}` : `/${action.command}`;
  await ctx.reply(cmdStr, rctx.threadOpts(ctx));
  await rctx.dispatchCommand(ctx, cmdStr);
  return { handled: true };
}

export function checkPendingClarification(ctx: Context, text: string): string | null {
  const key = confirmationKey(ctx);
  const pending = pendingClarifications.get(key);
  if (!pending) return null;
  if (Date.now() - pending.timestamp > CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(key);
    return null;
  }
  pendingClarifications.delete(key);
  return `/${pending.command} ${text.trim()}`;
}

export function handleConfirmationCallback(ctx: Context, data: string): string | null {
  if (data === "intent_cancel") {
    const key = confirmationKey(ctx);
    pendingConfirmations.delete(key);
    return null;
  }
  if (data.startsWith("intent_confirm:")) {
    const chatId = ctx.callbackQuery?.message?.chat?.id || 0;
    const threadId =
      (ctx.callbackQuery?.message as { message_thread_id?: number })?.message_thread_id || 0;
    const key = `${chatId}:${threadId}`;
    const pending = pendingConfirmations.get(key);
    if (!pending || Date.now() - pending.timestamp > CONFIRMATION_TTL_MS) {
      pendingConfirmations.delete(key);
      return null;
    }
    pendingConfirmations.delete(key);
    return pending.args ? `/${pending.command} ${pending.args}` : `/${pending.command}`;
  }
  return null;
}

let _syntheticUpdateCounter = 0;

export function buildSyntheticUpdate(ctx: Context, command: string): Record<string, unknown> {
  const slashEnd = command.indexOf(" ");
  const cmdLength = slashEnd !== -1 ? slashEnd : command.length;
  const chat = ctx.chat || ctx.callbackQuery?.message?.chat;
  const from = ctx.from || ctx.callbackQuery?.from;
  type MsgWithThread = { message_thread_id?: number };
  const threadId =
    (ctx.message as MsgWithThread)?.message_thread_id ||
    (ctx.callbackQuery?.message as MsgWithThread)?.message_thread_id;
  _syntheticUpdateCounter++;
  return {
    update_id: Date.now() + _syntheticUpdateCounter,
    message: {
      message_id: Date.now() + _syntheticUpdateCounter,
      from,
      chat,
      date: Math.floor(Date.now() / 1000),
      text: command,
      entities: [{ type: "bot_command", offset: 0, length: cmdLength }],
      ...(threadId ? { message_thread_id: threadId } : {}),
    },
  };
}

// ── Feature Request Intent (NLU) ────────────────────────────────

interface PendingFeatureRequest {
  subject: string;
  timestamp: number;
}

const pendingFeatureRequests = new Map<string, PendingFeatureRequest>();
const FEATURE_REQUEST_TTL_MS = 120_000;

/**
 * Check if a detected intent is a feature_request and the flag is enabled.
 * Returns true only when both conditions are met.
 */
export function isFeatureRequestIntent(detected: DetectedIntent | null): boolean {
  if (!detected) return false;
  if (detected.intent !== "feature_request") return false;
  return isFeatureEnabled("nlu_feature_request");
}

/**
 * Show the feature request confirmation InlineKeyboard.
 * Stores the pending request for callback resolution.
 */
export async function showFeatureRequestConfirmation(
  ctx: Context,
  subject: string,
  threadOpts: Record<string, unknown>,
): Promise<void> {
  const key = confirmationKey(ctx);
  pendingFeatureRequests.set(key, { subject, timestamp: Date.now() });

  const keyboard = new InlineKeyboard()
    .text("Maturer", "feature_request_confirm")
    .text("Non merci", "feature_request_cancel");

  const displaySubject = subject ? ` : "${subject}"` : "";
  await ctx.reply(`Ca ressemble a une idee${displaySubject}.\nLancer la maturation ?`, {
    ...threadOpts,
    reply_markup: keyboard,
  });
}

/**
 * Handle feature_request confirmation/cancel callbacks.
 * Returns the /explore command string on confirm, null on cancel or unrelated data.
 * If an explicit subject is passed (from args), it is used directly;
 * otherwise falls back to the pending request map.
 */
export function handleFeatureRequestCallback(
  ctx: Context,
  data: string,
  subject: string | undefined,
): string | null {
  if (data === "feature_request_cancel") {
    const key = confirmationKey(ctx);
    pendingFeatureRequests.delete(key);
    return null;
  }
  if (data === "feature_request_confirm") {
    const key = confirmationKey(ctx);
    // Use provided subject or look up pending
    let resolvedSubject = subject;
    if (!resolvedSubject) {
      const pending = pendingFeatureRequests.get(key);
      if (!pending || Date.now() - pending.timestamp > FEATURE_REQUEST_TTL_MS) {
        pendingFeatureRequests.delete(key);
        return null;
      }
      resolvedSubject = pending.subject;
    }
    pendingFeatureRequests.delete(key);
    return resolvedSubject ? `/idea ${resolvedSubject}` : "/idea";
  }
  return null;
}

/**
 * Show the feature request confirmation with AR2 expert-persona gate pre-assessment.
 * AR2 gate evaluates the request before showing the Maturer/Non merci buttons.
 * Falls back to standard confirmation on error (fail-open for UX continuity).
 *
 * Feature flag: ar2_gate_enabled
 */
export async function showFeatureRequestWithAR2(
  ctx: Context,
  subject: string,
  threadOpts: Record<string, unknown>,
  callLLM: (prompt: string) => Promise<string>,
): Promise<void> {
  try {
    const { runAR2Gate } = await import("../ar2-gate.ts");
    const ar2Result = await runAR2Gate(subject, "", callLLM);

    const key = confirmationKey(ctx);
    pendingFeatureRequests.set(key, { subject, timestamp: Date.now() });

    const verdictIcon = ar2Result.verdict === "GO" ? "\u2705" : "\u26a0\ufe0f";
    const rationale = ar2Result.rationale.substring(0, 200);

    const keyboard = new InlineKeyboard()
      .text("Maturer", "feature_request_confirm")
      .text("Non merci", "feature_request_cancel");

    const displaySubject = subject ? ` : "${subject}"` : "";
    await ctx.reply(
      `Ca ressemble a une idee${displaySubject}.\n\n${verdictIcon} <b>Evaluation expert</b> : ${rationale}\n\nLancer la maturation ?`,
      {
        ...threadOpts,
        reply_markup: keyboard,
        parse_mode: "HTML" as const,
      },
    );
  } catch {
    // Fail-open: fall back to standard confirmation on AR2 error
    await showFeatureRequestConfirmation(ctx, subject, threadOpts);
  }
}
