/**
 * @module action-registry
 * @description Structured registry of all bot commands with metadata: description, parameters,
 * risk level, usage patterns. Used by the command router (S37-03) for intent-to-action mapping
 * and by the confirmation system (S37-04) for risk-based confirmation.
 */

// ── Types ────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export interface ActionParam {
  name: string;
  required: boolean;
  description: string;
}

export interface ActionDefinition {
  /** Command name without slash (e.g. "backlog") */
  command: string;
  /** Short French description for user display */
  description: string;
  /** Usage example */
  usage: string;
  /** Structured parameters */
  params: ActionParam[];
  /** Risk level: low = read-only, medium = reversible state change, high = execution/destructive */
  risk: RiskLevel;
  /** Source Composer module */
  module: string;
  /** Whether this command requires Supabase */
  requiresSupabase: boolean;
  /** Natural language aliases (French) for intent detection */
  aliases: string[];
  /** Whether this command can run as a background job (S46) */
  backgroundEligible?: boolean;
}

// ── Registry ─────────────────────────────────────────────────

const ACTIONS: ActionDefinition[] = [
  // ─── help.ts ───
  {
    command: "help",
    description: "Afficher la liste des commandes",
    usage: "/help",
    params: [],
    risk: "low",
    module: "help",
    requiresSupabase: false,
    aliases: ["aide", "commandes", "comment ca marche", "que sais-tu faire"],
  },
  {
    command: "workflow",
    description: "Afficher le processus BMad complet",
    usage: "/workflow",
    params: [],
    risk: "low",
    module: "help",
    requiresSupabase: false,
    aliases: ["processus", "workflow bmad", "etapes"],
  },
  {
    command: "status",
    description: "Etat du serveur et sante systeme",
    usage: "/status",
    params: [],
    risk: "low",
    module: "help",
    requiresSupabase: false,
    aliases: ["etat serveur", "sante", "systeme"],
  },
  {
    command: "monitor",
    description: "Monitoring production (temps reponse, spawn, erreurs)",
    usage: "/monitor",
    params: [],
    risk: "low",
    module: "help",
    requiresSupabase: false,
    aliases: ["monitoring", "production", "performances"],
  },

  // ─── tasks.ts ───
  {
    command: "task",
    description: "Creer une nouvelle tache",
    usage: "/task <titre>",
    params: [{ name: "title", required: true, description: "Titre de la tache" }],
    risk: "medium",
    module: "tasks",
    requiresSupabase: true,
    aliases: ["creer tache", "nouvelle tache", "ajouter tache", "il faut faire"],
  },
  {
    command: "backlog",
    description: "Voir le backlog des taches",
    usage: "/backlog [projet]",
    params: [{ name: "project", required: false, description: "Filtre par projet" }],
    risk: "low",
    module: "tasks",
    requiresSupabase: true,
    aliases: ["backlog", "taches a faire", "liste taches", "quoi faire"],
  },
  {
    command: "sprint",
    description: "Voir l'etat du sprint actuel",
    usage: "/sprint [id]",
    params: [{ name: "sprintId", required: false, description: "ID du sprint (ex: S37)" }],
    risk: "low",
    module: "tasks",
    requiresSupabase: true,
    aliases: ["sprint", "avancement", "progression", "ou en est-on"],
  },
  {
    command: "start",
    description: "Demarrer une tache (backlog -> in_progress)",
    usage: "/start <id>",
    params: [{ name: "taskId", required: true, description: "ID ou prefixe de la tache" }],
    risk: "medium",
    module: "tasks",
    requiresSupabase: true,
    aliases: ["demarrer tache", "commencer tache", "prendre tache"],
  },
  {
    command: "done",
    description: "Terminer une tache (-> done)",
    usage: "/done <id>",
    params: [{ name: "taskId", required: true, description: "ID ou prefixe de la tache" }],
    risk: "medium",
    module: "tasks",
    requiresSupabase: true,
    aliases: ["terminer tache", "finir tache", "tache terminee", "c'est fait"],
  },

  // ─── exploration.ts ───
  {
    command: "explore",
    description: "Explorer un sujet, module ou question dans le codebase",
    usage: "/explore <sujet a investiguer>",
    params: [
      { name: "query", required: true, description: "Sujet, module ou question a explorer" },
    ],
    risk: "low",
    module: "exploration",
    requiresSupabase: true,
    aliases: [
      "explorer",
      "investiguer",
      "analyser codebase",
      "comment fonctionne",
      "impact de",
      "regarder",
      "rechercher",
      "comparer",
      "benchmark",
      "state of the art",
      "etat de l'art",
      "alternative",
    ],
    backgroundEligible: true,
  },

  // ─── documents.ts ───
  {
    command: "docs",
    description: "Gerer et rechercher des documents (list, search, stats, categories)",
    usage: "/docs [list|search|stats|delete|categories] [terme]",
    params: [
      {
        name: "subcommand",
        required: false,
        description: "list, search, stats, delete, categories",
      },
      { name: "query", required: false, description: "Terme de recherche ou ID du document" },
    ],
    risk: "low",
    module: "documents",
    requiresSupabase: true,
    aliases: [
      "documents",
      "mes documents",
      "chercher document",
      "trouver document",
      "facture",
      "contrat",
    ],
  },

  // ─── memory-cmds.ts ───
  {
    command: "brain",
    description: "Synthese memoire (faits, decisions, patterns)",
    usage: "/brain",
    params: [],
    risk: "low",
    module: "memory-cmds",
    requiresSupabase: true,
    aliases: ["synthese memoire", "resume memoire", "qu'est-ce que tu sais", "memoire"],
  },
  {
    command: "ideas",
    description: "Gerer les idees (lister, ajouter, promouvoir, archiver)",
    usage: "/ideas [list|add|review|promote|archive] [arg]",
    params: [
      { name: "subcommand", required: false, description: "list, add, review, promote, archive" },
      { name: "arg", required: false, description: "Texte ou ID selon la sous-commande" },
    ],
    risk: "medium",
    module: "memory-cmds",
    requiresSupabase: true,
    aliases: ["idees", "suggestions", "propositions"],
  },
  {
    command: "remind",
    description: "Programmer un rappel",
    usage: "/remind <heure> <texte>",
    params: [
      { name: "time", required: true, description: "Heure (14h30) ou duree (2h, 30m)" },
      { name: "text", required: true, description: "Texte du rappel" },
    ],
    risk: "medium",
    module: "memory-cmds",
    requiresSupabase: false,
    aliases: ["rappel", "rappelle-moi", "dans 2 heures"],
  },

  // ─── quality.ts ───
  {
    command: "metrics",
    description: "Metriques du sprint (velocite, rework, cycle time)",
    usage: "/metrics [sprint|all]",
    params: [{ name: "sprintId", required: false, description: "Sprint ou 'all' pour comparer" }],
    risk: "low",
    module: "quality",
    requiresSupabase: true,
    aliases: ["metriques", "statistiques", "stats", "velocite", "performance"],
  },
  {
    command: "retro",
    description: "Generer une retrospective de sprint",
    usage: "/retro [sprint]",
    params: [{ name: "sprintId", required: false, description: "Sprint a analyser" }],
    risk: "medium",
    module: "quality",
    requiresSupabase: true,
    aliases: ["retrospective", "retro", "bilan sprint", "retour d'experience"],
    backgroundEligible: true,
  },
  {
    command: "patterns",
    description: "Analyse multi-sprints des tendances",
    usage: "/patterns",
    params: [],
    risk: "low",
    module: "quality",
    requiresSupabase: true,
    aliases: ["patterns", "tendances", "analyse multi-sprint"],
  },
  {
    command: "alerts",
    description: "Verifier les anomalies et alertes",
    usage: "/alerts [sprint]",
    params: [{ name: "sprintId", required: false, description: "Sprint a verifier" }],
    risk: "low",
    module: "quality",
    requiresSupabase: true,
    aliases: ["alertes", "anomalies", "problemes detectes"],
  },
  {
    command: "cost",
    description: "Suivi des couts tokens par agent/tache/sprint",
    usage: "/cost [sprint|total]",
    params: [{ name: "scope", required: false, description: "Sprint ou 'total'" }],
    risk: "low",
    module: "quality",
    requiresSupabase: true,
    aliases: ["couts", "depenses", "budget tokens", "combien ca coute"],
  },

  // ─── profile.ts ───
  {
    command: "profile",
    description: "Voir et mettre a jour le profil utilisateur",
    usage: "/profile",
    params: [],
    risk: "low",
    module: "profile",
    requiresSupabase: true,
    aliases: ["profil", "mon profil"],
  },
  {
    command: "notify",
    description: "Configurer les preferences de notifications",
    usage: "/notify [status|quiet|on|off|immediate] [type]",
    params: [
      { name: "action", required: false, description: "status, quiet, on, off, immediate, batch" },
      { name: "type", required: false, description: "task, pr, idea, alert" },
    ],
    risk: "medium",
    module: "profile",
    requiresSupabase: false,
    aliases: ["notifications", "preferences notifications"],
  },

  // ─── project.ts ───
  {
    command: "projects",
    description: "Lister tous les projets",
    usage: "/projects",
    params: [],
    risk: "low",
    module: "project",
    requiresSupabase: true,
    aliases: ["projets", "liste projets", "quels projets"],
  },
  {
    command: "project",
    description: "Gerer un projet (creer, changer, archiver)",
    usage: "/project [create|switch|archive|topic] [arg]",
    params: [
      { name: "subcommand", required: false, description: "create, switch, archive, topic" },
      { name: "arg", required: false, description: "Nom, slug, ou topic ID" },
    ],
    risk: "medium",
    module: "project",
    requiresSupabase: true,
    aliases: ["projet", "changer projet", "creer projet"],
  },

  // ─── jobs.ts ───
  {
    command: "jobs",
    description: "Voir les jobs en cours et recents",
    usage: "/jobs [cancel <id>]",
    params: [
      { name: "subcommand", required: false, description: "cancel" },
      { name: "jobId", required: false, description: "ID du job" },
    ],
    risk: "low",
    module: "jobs",
    requiresSupabase: false,
    aliases: ["jobs", "travaux en cours", "qu'est-ce qui tourne", "statut jobs"],
  },

  // ─── utilities.ts ───
  {
    command: "speak",
    description: "Synthese vocale d'un texte",
    usage: "/speak [texte]",
    params: [
      { name: "text", required: false, description: "Texte a synthetiser (ou dernier message)" },
    ],
    risk: "low",
    module: "utilities",
    requiresSupabase: false,
    aliases: ["parle", "dis", "synthese vocale", "lis a voix haute"],
  },
  {
    command: "export",
    description: "Exporter les donnees (messages, memoire, taches)",
    usage: "/export",
    params: [],
    risk: "low",
    module: "utilities",
    requiresSupabase: true,
    aliases: ["exporter", "export donnees", "telecharger donnees"],
  },
  {
    command: "feature",
    description: "Gerer les feature flags",
    usage: "/feature [list|enable|disable] [flag]",
    params: [
      { name: "action", required: false, description: "list, enable, disable" },
      { name: "flag", required: false, description: "Nom du flag" },
    ],
    risk: "medium",
    module: "utilities",
    requiresSupabase: false,
    aliases: ["feature flag", "flags", "activer feature"],
  },
  {
    command: "rollback",
    description: "Rollback au commit precedent",
    usage: "/rollback [raison]",
    params: [{ name: "reason", required: false, description: "Raison du rollback" }],
    risk: "high",
    module: "utilities",
    requiresSupabase: false,
    aliases: ["rollback", "revenir en arriere", "annuler deploy"],
    backgroundEligible: true,
  },
];

// ── Indexed access ───────────────────────────────────────────

const actionMap = new Map<string, ActionDefinition>();
for (const action of ACTIONS) {
  actionMap.set(action.command, action);
}

/** Get a single action by command name */
export function getAction(command: string): ActionDefinition | undefined {
  return actionMap.get(command);
}

/** Get all registered actions */
export function getAllActions(): ActionDefinition[] {
  return ACTIONS;
}

/** Get actions filtered by risk level */
export function getActionsByRisk(risk: RiskLevel): ActionDefinition[] {
  return ACTIONS.filter((a) => a.risk === risk);
}

/** Get actions that require a specific parameter */
export function getActionsRequiringParam(paramName: string): ActionDefinition[] {
  return ACTIONS.filter((a) => a.params.some((p) => p.name === paramName && p.required));
}

/** Format a concise action list for LLM context */
export function formatActionsForLLM(): string {
  return ACTIONS.map((a) => `/${a.command} — ${a.description} (${a.risk})`).join("\n");
}
