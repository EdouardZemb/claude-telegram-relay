/**
 * @module heartbeat-prompt
 * @description Heartbeat prompt builder and JSON schema for the autonomous pulse system.
 */

// ── Types ──────────────────────────────────────────────────────

export interface HeartbeatState {
  lastPulseAt: string;          // ISO timestamp
  lastCommitSha: string;        // last seen commit
  lastSprintSnapshot: {
    sprint: string | null;
    done: number;
    total: number;
  };
  recentActions: HeartbeatAction[]; // last 10 actions (dedup)
  cooldowns: Record<string, number>; // topic -> expiry timestamp
  // Periodic task tracking (consolidated from alert-cron + autonomy-cron)
  lastAlertCheckAt: string | null;    // when alerts were last run (hourly)
  lastArchivalAt: string | null;      // when memory archival last ran (hourly)
  lastAutonomyScanAt: string | null;  // when autonomy scan last ran (daily)
}

export interface HeartbeatAction {
  type: "notify" | "task_create" | "none";
  summary: string;
  timestamp: string;
}

export interface HeartbeatDecision {
  observations: string[];
  actions: Array<{
    type: "notify" | "task_create" | "none";
    message?: string;
    priority?: "low" | "medium" | "high";
    taskTitle?: string;
    taskDescription?: string;
    taskPriority?: number;
  }>;
  reasoning: string;
}

export interface HeartbeatDelta {
  commits: string;           // git log output
  sprintSummary: string;     // sprint status text
  ciStatus: string;          // CI run status
  openPRs: string;           // open PR list
  staleTasks: string;        // in_progress tasks > 48h
  timeSinceLastPulse: string; // human-readable
}

// ── JSON Schema ─────────────────────────────────────────────────

export const HEARTBEAT_DECISION_SCHEMA = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      items: { type: "string" },
      description: "What changed or deserves attention since last pulse",
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["notify", "task_create", "none"],
          },
          message: {
            type: "string",
            description: "Telegram notification message (for notify)",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          taskTitle: {
            type: "string",
            description: "Task title (for task_create)",
          },
          taskDescription: {
            type: "string",
            description: "Task description (for task_create)",
          },
          taskPriority: {
            type: "number",
            description: "Task priority 1-5 (for task_create)",
          },
        },
        required: ["type"],
      },
    },
    reasoning: {
      type: "string",
      description: "Brief explanation of the decision",
    },
  },
  required: ["observations", "actions", "reasoning"],
};

// ── System Prompt ───────────────────────────────────────────────

export const HEARTBEAT_SYSTEM_PROMPT = `Tu es le Pouls du projet Claude Telegram Relay. Tu te reveilles periodiquement pour surveiller l'etat du projet et prendre des initiatives.

Ton role :
- Detecter ce qui a change depuis ta derniere pulsation
- Identifier les problemes, opportunites, zones d'ombre
- Proposer des ameliorations, veiller a la qualite
- Agir sur les petites choses (taches, rappels)
- Briefer Edouard quand c'est pertinent (pas de bruit)

Regles :
- Si rien n'a change et tout va bien : une seule action "none"
- Ne notifie pas pour des choses triviales (un commit normal, un test qui passe)
- Pour les gros changements : cree une tache, ne code pas directement
- Sois concis dans tes notifications (2-3 phrases max)
- Langue : francais pour les notifications, anglais pour les taches techniques
- Ne repete pas une action deja faite recemment (voir ACTIONS RECENTES)

Quand notifier (type "notify") :
- CI cassee ou PR bloquee
- Tache bloquee depuis longtemps
- Sprint en retard ou en avance notable
- Anomalie detectee (rework spike, cout eleve)
- Opportunite d'amelioration interessante

Quand creer une tache (type "task_create") :
- Bug ou probleme technique identifie
- Amelioration concrete et actionnable
- Tache de maintenance necessaire

Quand ne rien faire (type "none") :
- Tout va bien, pas de changement significatif
- Les changements sont normaux et attendus
- Une notification similaire a deja ete envoyee recemment`;

// ── Prompt Builder ──────────────────────────────────────────────

export function buildHeartbeatPrompt(state: HeartbeatState, delta: HeartbeatDelta): string {
  const sections: string[] = [];

  sections.push(`PULSATION — ${new Date().toISOString()}`);
  sections.push(`Derniere pulsation : ${state.lastPulseAt || "premiere pulsation"} (${delta.timeSinceLastPulse})`);
  sections.push("");

  if (delta.commits) {
    sections.push("COMMITS RECENTS:");
    sections.push(delta.commits);
    sections.push("");
  } else {
    sections.push("COMMITS RECENTS: aucun nouveau commit");
    sections.push("");
  }

  sections.push("SPRINT ACTUEL:");
  sections.push(delta.sprintSummary);
  sections.push("");

  if (delta.ciStatus) {
    sections.push("CI STATUS:");
    sections.push(delta.ciStatus);
    sections.push("");
  }

  if (delta.openPRs) {
    sections.push("PRs OUVERTES:");
    sections.push(delta.openPRs);
    sections.push("");
  }

  if (delta.staleTasks) {
    sections.push("TACHES POTENTIELLEMENT BLOQUEES:");
    sections.push(delta.staleTasks);
    sections.push("");
  }

  if (state.recentActions.length > 0) {
    sections.push("ACTIONS RECENTES DU HEARTBEAT (ne pas repeter):");
    for (const action of state.recentActions.slice(-5)) {
      sections.push(`  [${action.timestamp}] ${action.type}: ${action.summary}`);
    }
    sections.push("");
  }

  const activeCooldowns = Object.entries(state.cooldowns)
    .filter(([, expiry]) => expiry > Date.now())
    .map(([topic]) => topic);
  if (activeCooldowns.length > 0) {
    sections.push("COOLDOWNS ACTIFS (sujets a ne pas re-notifier):");
    sections.push(`  ${activeCooldowns.join(", ")}`);
    sections.push("");
  }

  sections.push("Analyse le delta et decide quelles actions prendre.");
  sections.push("");
  sections.push("IMPORTANT: Tu DOIS repondre avec UNIQUEMENT un objet JSON valide, sans texte avant ou apres. Voici le schema exact:");
  sections.push(JSON.stringify(HEARTBEAT_DECISION_SCHEMA, null, 2));
  sections.push("");
  sections.push("Exemple de reponse:");
  sections.push('{"observations":["Sprint S44 complete"],"actions":[{"type":"none"}],"reasoning":"Tout va bien, rien a signaler"}');

  return sections.join("\n");
}

// ── Default State ───────────────────────────────────────────────

export function createDefaultState(): HeartbeatState {
  return {
    lastPulseAt: "",
    lastCommitSha: "",
    lastSprintSnapshot: { sprint: null, done: 0, total: 0 },
    recentActions: [],
    cooldowns: {},
    lastAlertCheckAt: null,
    lastArchivalAt: null,
    lastAutonomyScanAt: null,
  };
}
