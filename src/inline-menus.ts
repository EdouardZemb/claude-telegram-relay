/**
 * @module inline-menus
 * @description Progressive inline menu system for Telegram bot UX.
 * Builds dynamic InlineKeyboard menus from action-registry metadata.
 * Provides category grouping, sub-menus with back navigation,
 * onboarding keyboard, and contextual action keyboards.
 *
 * Constraints:
 * - Max 5 rows per keyboard (iOS compatibility)
 * - Max 64 bytes per callback_data
 * - Callback prefix convention: menu_, task_, notify_
 */

import { InlineKeyboard } from "grammy";
import { type ActionDefinition, getAllActions } from "./action-registry.ts";
import type { NotificationPrefs } from "./notification-queue.ts";

// ── Category Types & Constants ─────────────────────────────────

export interface MenuCategory {
  /** Short unique identifier */
  id: string;
  /** Display label (French) */
  label: string;
  /** Short description for the menu */
  description: string;
  /** Commands belonging to this category */
  commands: string[];
}

/**
 * Menu categories grouping the 27+ commands into navigable sections.
 * Each command appears in exactly one category.
 */
export const MENU_CATEGORIES: MenuCategory[] = [
  {
    id: "tasks",
    label: "Taches & Sprint",
    description: "Gestion des taches, backlog et sprints",
    commands: ["task", "backlog", "sprint", "start", "done"],
  },
  {
    id: "quality",
    label: "Qualite & Suivi",
    description: "Metriques, retros, alertes et couts",
    commands: ["metrics", "retro", "patterns", "alerts", "cost"],
  },
  {
    id: "knowledge",
    label: "Memoire & Docs",
    description: "Memoire, idees, documents et exploration",
    commands: ["brain", "ideas", "idea", "docs", "explore", "remind"],
  },
  {
    id: "project",
    label: "Projets & Profil",
    description: "Projets, profil et notifications",
    commands: ["projects", "project", "profile", "notify"],
  },
  {
    id: "system",
    label: "Systeme & Outils",
    description: "Statut, monitoring, feature flags et utilitaires",
    commands: [
      "help",
      "workflow",
      "status",
      "monitor",
      "speak",
      "export",
      "feature",
      "rollback",
      "jobs",
    ],
  },
];

// ── Build an index: command -> category for fast lookup ─────────

const commandCategoryMap = new Map<string, string>();
for (const cat of MENU_CATEGORIES) {
  for (const cmd of cat.commands) {
    commandCategoryMap.set(cmd, cat.id);
  }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Get the category ID for a command.
 */
export function getCategoryForCommand(command: string): string | undefined {
  return commandCategoryMap.get(command);
}

/**
 * Get ActionDefinitions for a given category ID.
 * Returns empty array for unknown categories.
 */
export function getActionsForCategory(categoryId: string): ActionDefinition[] {
  const cat = MENU_CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return [];

  const allActions = getAllActions();
  const actionMap = new Map<string, ActionDefinition>();
  for (const a of allActions) {
    actionMap.set(a.command, a);
  }

  return cat.commands
    .map((cmd) => actionMap.get(cmd))
    .filter((a): a is ActionDefinition => a !== undefined);
}

/**
 * Build the main menu keyboard with one button per category.
 * Max 5 rows (one per category).
 */
export function buildMainMenuKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const cat of MENU_CATEGORIES) {
    kb.text(cat.label, `menu_cat:${cat.id}`);
    kb.row();
  }

  // Remove trailing empty row if any
  if (kb.inline_keyboard.length > 0) {
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    if (lastRow.length === 0) {
      kb.inline_keyboard.pop();
    }
  }

  return kb;
}

/**
 * Build a sub-menu keyboard for a specific category.
 * Shows command buttons + a "Retour" (back) button on the last row.
 * Max 5 rows total. If more commands than fit, they are grouped 2 per row.
 * Returns undefined for unknown categories.
 */
export function buildCategoryKeyboard(categoryId: string): InlineKeyboard | undefined {
  const actions = getActionsForCategory(categoryId);
  if (actions.length === 0) return undefined;

  const kb = new InlineKeyboard();
  const MAX_ROWS = 4; // reserve 1 row for back button

  // Lay out command buttons, 2 per row
  let rowCount = 0;
  for (let i = 0; i < actions.length && rowCount < MAX_ROWS; i++) {
    const action = actions[i];
    kb.text(`/${action.command}`, `menu_cmd:${action.command}`);
    // Two buttons per row, or end of list
    if (i % 2 === 1 || i === actions.length - 1) {
      kb.row();
      rowCount++;
    }
  }

  // Back button
  kb.text("Retour", "menu_back");

  return kb;
}

/**
 * Build the onboarding keyboard shown on /start (no args).
 * Quick access to common actions + full menu button.
 */
export function buildOnboardingKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();

  kb.text("Voir le backlog", "menu_cmd:backlog");
  kb.text("Etat du sprint", "menu_cmd:sprint");
  kb.row();
  kb.text("Statut systeme", "menu_cmd:status");
  kb.text("Toutes les commandes", "menu_back");
  kb.row();

  // Remove trailing empty row
  if (kb.inline_keyboard.length > 0) {
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    if (lastRow.length === 0) {
      kb.inline_keyboard.pop();
    }
  }

  return kb;
}

/**
 * Build an action keyboard for a backlog task item.
 * Shows "Demarrer" button with short task ID.
 */
export function buildBacklogActionKeyboard(taskId: string, _taskTitle: string): InlineKeyboard {
  const shortId = taskId.substring(0, 8);
  const kb = new InlineKeyboard();
  kb.text("Demarrer", `task_start:${shortId}`);
  kb.text("Terminer", `task_done:${shortId}`);
  return kb;
}

/**
 * Build navigation keyboard for quality commands.
 * Allows jumping between /metrics, /retro, /alerts, /cost.
 */
export function buildQualityNavKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text("Metriques", "menu_cmd:metrics");
  kb.text("Retro", "menu_cmd:retro");
  kb.row();
  kb.text("Alertes", "menu_cmd:alerts");
  kb.text("Couts", "menu_cmd:cost");
  return kb;
}

/**
 * Build notification preferences keyboard with toggle buttons.
 * Shows current state (enabled/disabled/immediate) for each type.
 */
export function buildNotifyPrefsKeyboard(prefs: NotificationPrefs): InlineKeyboard {
  const kb = new InlineKeyboard();
  const types: Array<{ key: string; label: string }> = [
    { key: "task", label: "Task" },
    { key: "pr", label: "PR" },
    { key: "idea", label: "Idea" },
    { key: "alert", label: "Alert" },
  ];

  for (const t of types) {
    const tp = prefs.types[t.key as keyof typeof prefs.types];
    const status = tp?.enabled ? (tp.immediate ? "imm" : "on") : "off";
    const label = `${t.label} [${status}]`;
    const action = tp?.enabled ? "off" : "on";
    kb.text(label, `notify_${action}:${t.key}`);
    kb.row();
  }

  // Remove trailing empty row
  if (kb.inline_keyboard.length > 0) {
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    if (lastRow.length === 0) {
      kb.inline_keyboard.pop();
    }
  }

  return kb;
}
