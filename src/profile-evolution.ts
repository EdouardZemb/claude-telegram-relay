/**
 * Profile Evolution — S12 Intelligence Reflexive
 *
 * Analyse les interactions pour mettre a jour le profil
 * automatiquement. Detecte les preferences de communication,
 * les horaires d'activite, et les types de taches frequents.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = process.env.PROJECT_DIR || join(import.meta.dir, "..");

// ── Types ────────────────────────────────────────────────────

export interface ProfileInsights {
  communicationStyle: {
    avgMessageLength: number;
    prefersBrief: boolean;
    language: string;
  };
  activityPattern: {
    activeHours: number[];   // hours of the day with most activity (0-23)
    activeDays: string[];    // days of the week with most activity
    peakHour: number;
  };
  taskPreferences: {
    topTaskTypes: Array<{ type: string; count: number }>;
    avgTasksPerSprint: number;
    preferredPriority: number;
  };
  workflowPreferences: {
    autonomyLevel: "high" | "medium" | "low"; // Based on validation overrides
    checkpointOverrides: number; // Times user skipped checkpoints
  };
}

export interface ProfileUpdate {
  field: string;
  currentValue: string;
  proposedValue: string;
  reason: string;
}

// ── Analysis ─────────────────────────────────────────────────

/**
 * Analyse les messages recents pour deduire le profil de l'utilisateur.
 */
export async function analyzeProfile(
  supabase: SupabaseClient
): Promise<ProfileInsights> {
  // Get messages from the last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: messages } = await supabase
    .from("messages")
    .select("role, content, created_at")
    .gte("created_at", thirtyDaysAgo.toISOString())
    .order("created_at", { ascending: true });

  const msgs = messages ?? [];

  // Get tasks
  const { data: tasks } = await supabase
    .from("tasks")
    .select("title, status, priority, sprint, tags, created_at");

  const allTasks = tasks ?? [];

  // Communication style
  const userMessages = msgs.filter((m: any) => m.role === "user");
  const avgLen = userMessages.length > 0
    ? userMessages.reduce((sum: number, m: any) => sum + (m.content?.length ?? 0), 0) / userMessages.length
    : 0;

  const frenchIndicators = userMessages.filter((m: any) =>
    /\b(je|tu|nous|vous|est|sont|les|des|une|sur|dans|pour|avec|pas|que)\b/i.test(m.content ?? "")
  ).length;
  const language = frenchIndicators > userMessages.length * 0.3 ? "francais" : "english";

  // Activity pattern
  const hourCounts = new Array(24).fill(0);
  const dayCounts: Record<string, number> = {};
  const dayNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

  for (const m of userMessages) {
    const date = new Date(m.created_at);
    hourCounts[date.getHours()]++;
    const day = dayNames[date.getDay()];
    dayCounts[day] = (dayCounts[day] ?? 0) + 1;
  }

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const activeHours = hourCounts
    .map((count: number, hour: number) => ({ hour, count }))
    .filter((h: { count: number }) => h.count > 0)
    .sort((a: { count: number }, b: { count: number }) => b.count - a.count)
    .slice(0, 6)
    .map((h: { hour: number }) => h.hour)
    .sort((a: number, b: number) => a - b);

  const activeDays = Object.entries(dayCounts)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, 5)
    .map(([day]) => day);

  // Task preferences
  const taskTypes: Record<string, number> = {};
  for (const t of allTasks) {
    const type = categorizeTask(t.title);
    taskTypes[type] = (taskTypes[type] ?? 0) + 1;
  }

  const topTaskTypes = Object.entries(taskTypes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  const sprints = new Set(allTasks.filter((t: any) => t.sprint).map((t: any) => t.sprint));
  const avgTasksPerSprint = sprints.size > 0 ? Math.round(allTasks.length / sprints.size) : 0;

  const priorities = allTasks.map((t: any) => t.priority).filter((p: any) => p != null);
  const preferredPriority = priorities.length > 0
    ? Math.round(priorities.reduce((a: number, b: number) => a + b, 0) / priorities.length)
    : 3;

  return {
    communicationStyle: {
      avgMessageLength: Math.round(avgLen),
      prefersBrief: avgLen < 100,
      language,
    },
    activityPattern: {
      activeHours,
      activeDays,
      peakHour,
    },
    taskPreferences: {
      topTaskTypes,
      avgTasksPerSprint,
      preferredPriority,
    },
    workflowPreferences: {
      autonomyLevel: "high", // Default — refine with more data
      checkpointOverrides: 0,
    },
  };
}

// ── Profile Updates ──────────────────────────────────────────

/**
 * Compare les insights avec le profil actuel et propose des mises a jour.
 */
export function proposeProfileUpdates(
  insights: ProfileInsights,
  currentProfile: string
): ProfileUpdate[] {
  const updates: ProfileUpdate[] = [];

  // Check timezone alignment
  const hourRange = insights.activityPattern.activeHours;
  if (hourRange.length > 0) {
    const earliest = Math.min(...hourRange);
    const latest = Math.max(...hourRange);
    const currentTimezone = extractFromProfile(currentProfile, "Timezone") || "";

    if (earliest >= 8 && latest <= 18 && !currentTimezone.includes("Paris")) {
      // Could suggest timezone
    }

    // Check if hours differ from stated availability
    const currentAvailability = extractFromProfile(currentProfile, "Constraints") || "";
    if (currentAvailability && earliest < 9) {
      updates.push({
        field: "Constraints",
        currentValue: currentAvailability,
        proposedValue: `Actif des ${earliest}h en semaine`,
        reason: `Les donnees montrent une activite des ${earliest}h`,
      });
    }
  }

  // Communication style
  const currentStyle = extractFromProfile(currentProfile, "Communication Style") || "";
  if (insights.communicationStyle.prefersBrief && currentStyle.includes("detaille")) {
    updates.push({
      field: "Communication Style",
      currentValue: currentStyle,
      proposedValue: "Reponses concises et directes",
      reason: `Longueur moyenne des messages: ${insights.communicationStyle.avgMessageLength} caracteres (tendance a la concision)`,
    });
  } else if (!insights.communicationStyle.prefersBrief && currentStyle.includes("conci")) {
    updates.push({
      field: "Communication Style",
      currentValue: currentStyle,
      proposedValue: "Reponses detaillees avec contexte et explications",
      reason: `Longueur moyenne des messages: ${insights.communicationStyle.avgMessageLength} caracteres (preference pour le detail)`,
    });
  }

  // Top task types as interests
  if (insights.taskPreferences.topTaskTypes.length > 0) {
    const topTypes = insights.taskPreferences.topTaskTypes.slice(0, 3).map((t) => t.type);
    const currentGoals = extractFromProfile(currentProfile, "Goals") || "";
    if (!currentGoals || currentGoals.includes("remplir")) {
      updates.push({
        field: "Goals",
        currentValue: currentGoals,
        proposedValue: `Focus principal: ${topTypes.join(", ")}`,
        reason: `Types de taches les plus frequents sur les derniers sprints`,
      });
    }
  }

  return updates;
}

/**
 * Applique les mises a jour validees au profil.
 */
export function applyProfileUpdates(
  updates: ProfileUpdate[]
): boolean {
  const profilePath = join(PROJECT_ROOT, "config", "profile.md");
  if (!existsSync(profilePath)) return false;

  let content = readFileSync(profilePath, "utf-8");

  for (const update of updates) {
    if (update.currentValue && content.includes(update.currentValue)) {
      content = content.replace(update.currentValue, update.proposedValue);
    }
  }

  writeFileSync(profilePath, content);
  return true;
}

// ── Formatting ───────────────────────────────────────────────

export function formatProfileInsights(insights: ProfileInsights): string {
  const lines = [
    "Analyse du profil",
    "",
    "Communication :",
    `  Longueur moyenne des messages: ${insights.communicationStyle.avgMessageLength} car.`,
    `  Style: ${insights.communicationStyle.prefersBrief ? "concis" : "detaille"}`,
    `  Langue: ${insights.communicationStyle.language}`,
    "",
    "Activite :",
    `  Heures actives: ${insights.activityPattern.activeHours.map((h) => `${h}h`).join(", ")}`,
    `  Pic d'activite: ${insights.activityPattern.peakHour}h`,
    `  Jours actifs: ${insights.activityPattern.activeDays.join(", ")}`,
    "",
    "Taches :",
    `  Types frequents: ${insights.taskPreferences.topTaskTypes.map((t) => `${t.type} (${t.count})`).join(", ")}`,
    `  Moyenne par sprint: ${insights.taskPreferences.avgTasksPerSprint}`,
    `  Priorite habituelle: P${insights.taskPreferences.preferredPriority}`,
  ];

  return lines.join("\n");
}

export function formatProfileUpdates(updates: ProfileUpdate[]): string {
  if (updates.length === 0) return "Aucune mise a jour de profil suggeree.";

  const lines = ["Mises a jour du profil proposees :", ""];
  for (const u of updates) {
    lines.push(`${u.field}:`);
    lines.push(`  Actuel: ${u.currentValue || "(vide)"}`);
    lines.push(`  Propose: ${u.proposedValue}`);
    lines.push(`  Raison: ${u.reason}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────

function categorizeTask(title: string): string {
  const lower = title.toLowerCase();
  if (/\b(fix|bug|erreur|crash|patch)\b/.test(lower)) return "bugfix";
  if (/\b(test|integration|unitaire|couverture)\b/.test(lower)) return "testing";
  if (/\b(refactor|nettoyer|cleanup|simplif)\b/.test(lower)) return "refactoring";
  if (/\b(doc|readme|guide|wiki)\b/.test(lower)) return "documentation";
  if (/\b(ci|cd|deploy|pipeline|github|actions)\b/.test(lower)) return "devops";
  if (/\b(securit|token|auth|rls|inject)\b/.test(lower)) return "security";
  if (/\b(table|schema|migration|supabase|db|rpc)\b/.test(lower)) return "database";
  if (/\b(ui|dashboard|bouton|interface|affich)\b/.test(lower)) return "ui";
  return "feature";
}

function extractFromProfile(profile: string, section: string): string | null {
  const regex = new RegExp(`\\*\\*${section}[:\\s]*\\*\\*\\s*(.+?)(?=\\n\\*\\*|\\n##|$)`, "is");
  const match = profile.match(regex);
  if (match) return match[1].trim();

  // Try without bold
  const simpleRegex = new RegExp(`${section}[:\\s]+(.+?)(?=\\n[A-Z]|\\n##|$)`, "is");
  const simpleMatch = profile.match(simpleRegex);
  return simpleMatch ? simpleMatch[1].trim() : null;
}
