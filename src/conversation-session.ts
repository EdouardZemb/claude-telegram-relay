/**
 * @module conversation-session
 * @description Conversation sessions: tracks conversation state per chat thread.
 * Sessions capture intent history, user constraints, and decisions for contextual
 * intent detection and agent context enrichment. TTL 30min. S43.
 */

// ── Types ────────────────────────────────────────────────────

export type SessionPhase = "discovery" | "planning" | "execution" | "closure";

export interface DetectedConstraint {
  type: "speed" | "quality" | "budget" | "scope" | "deadline";
  value: string;
  /** The message that surfaced this constraint */
  source: string;
  detectedAt: number;
}

export interface SessionDecision {
  description: string;
  timestamp: number;
}

export interface IntentEntry {
  intent: string;
  command: string;
  confidence: number;
  timestamp: number;
  /** Was the intent executed (vs just suggested)? */
  executed: boolean;
}

export interface ConversationSession {
  id: string;
  chatId: number;
  threadId?: number;
  createdAt: number;
  lastActivity: number;
  phase: SessionPhase;
  /** Trail of detected intents in this session */
  intents: IntentEntry[];
  /** User constraints extracted from conversation */
  constraints: DetectedConstraint[];
  /** Decisions taken during the session */
  decisions: SessionDecision[];
  /** Recent user messages (last 5, for context) */
  recentMessages: string[];
  /** Task ID if a task was referenced or created */
  activeTaskId?: string;
}

// ── Session Store ────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RECENT_MESSAGES = 5;
const MAX_INTENTS = 20;

const sessions = new Map<string, ConversationSession>();

function sessionKey(chatId: number, threadId?: number): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

/**
 * Get or create a conversation session for the given chat/thread.
 */
export function getSession(chatId: number, threadId?: number): ConversationSession {
  const key = sessionKey(chatId, threadId);
  const existing = sessions.get(key);

  if (existing && Date.now() - existing.lastActivity < SESSION_TTL_MS) {
    existing.lastActivity = Date.now();
    return existing;
  }

  // Expired or new — create fresh
  const session: ConversationSession = {
    id: `cs-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    chatId,
    threadId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    phase: "discovery",
    intents: [],
    constraints: [],
    decisions: [],
    recentMessages: [],
  };
  sessions.set(key, session);
  return session;
}

/**
 * Check if a session exists and is active (not expired).
 */
export function hasActiveSession(chatId: number, threadId?: number): boolean {
  const key = sessionKey(chatId, threadId);
  const session = sessions.get(key);
  return !!session && Date.now() - session.lastActivity < SESSION_TTL_MS;
}

// ── Session Mutations ────────────────────────────────────────

/**
 * Record a user message in the session.
 */
export function addMessage(session: ConversationSession, message: string): void {
  session.recentMessages.push(message);
  if (session.recentMessages.length > MAX_RECENT_MESSAGES) {
    session.recentMessages.shift();
  }
  session.lastActivity = Date.now();
}

/**
 * Record a detected intent in the session.
 */
export function addIntent(
  session: ConversationSession,
  intent: string,
  command: string,
  confidence: number,
  executed: boolean,
): void {
  session.intents.push({
    intent,
    command,
    confidence,
    timestamp: Date.now(),
    executed,
  });
  if (session.intents.length > MAX_INTENTS) {
    session.intents.shift();
  }

  // Phase transitions based on intents
  updatePhase(session, command, executed);
  session.lastActivity = Date.now();
}

/**
 * Record a user constraint extracted from conversation.
 */
export function addConstraint(
  session: ConversationSession,
  type: DetectedConstraint["type"],
  value: string,
  source: string,
): void {
  // Replace existing constraint of same type
  session.constraints = session.constraints.filter((c) => c.type !== type);
  session.constraints.push({ type, value, source, detectedAt: Date.now() });
  session.lastActivity = Date.now();
}

/**
 * Record a decision taken during the session.
 */
export function addDecision(session: ConversationSession, description: string): void {
  session.decisions.push({ description, timestamp: Date.now() });
  session.lastActivity = Date.now();
}

/**
 * Set the active task ID for the session.
 */
export function setActiveTask(session: ConversationSession, taskId: string): void {
  session.activeTaskId = taskId;
  session.lastActivity = Date.now();
}

// ── Phase Detection ──────────────────────────────────────────

const PLANNING_COMMANDS = new Set(["plan", "prd", "planify", "estimate"]);
const EXECUTION_COMMANDS = new Set(["exec", "orchestrate", "autopipeline", "start"]);
const CLOSURE_COMMANDS = new Set(["done", "retro", "metrics"]);

function updatePhase(session: ConversationSession, command: string, executed: boolean): void {
  if (!executed) return;

  if (EXECUTION_COMMANDS.has(command)) {
    session.phase = "execution";
  } else if (CLOSURE_COMMANDS.has(command)) {
    session.phase = "closure";
  } else if (PLANNING_COMMANDS.has(command) && session.phase === "discovery") {
    session.phase = "planning";
  }
}

// ── Constraint Extraction ────────────────────────────────────

const CONSTRAINT_PATTERNS: Array<{
  type: DetectedConstraint["type"];
  patterns: RegExp[];
  extractor: (match: RegExpMatchArray) => string;
}> = [
  {
    type: "speed",
    patterns: [
      /\b(vite|rapide(ment)?|urgent|presse|asap|rapidement)\b/i,
      /\b(pas\s+le\s+temps|en\s+urgence)\b/i,
    ],
    extractor: () => "fast",
  },
  {
    type: "quality",
    patterns: [
      /\b(bien\s+fait|qualite|soigne|robuste|solid[e]?)\b/i,
      /\b(tests?\s+(complets?|exhausti[fv]s?))\b/i,
    ],
    extractor: () => "high",
  },
  {
    type: "budget",
    patterns: [
      /\b(pas\s+cher|economique|budget|cout\s+reduit|economiser)\b/i,
      /\b(pipeline\s+quick|rapide\s+et\s+pas\s+cher)\b/i,
    ],
    extractor: () => "low",
  },
  {
    type: "scope",
    patterns: [
      /\b(simple|minimal(e)?|juste\s+le?\s+|seulement)\b/i,
      /\b(pas\s+(besoin|la\s+peine)\s+de)\b/i,
    ],
    extractor: () => "minimal",
  },
  {
    type: "deadline",
    patterns: [
      /\b(avant|pour|d'?ici)\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|ce\s+soir)\b/i,
      /\b(deadline|echeance|date\s+limite)\b/i,
    ],
    extractor: (m) => m[0],
  },
];

/**
 * Extract constraints from a user message text.
 * Returns newly detected constraints (not already in session).
 */
export function extractConstraints(text: string): DetectedConstraint[] {
  const found: DetectedConstraint[] = [];
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  for (const { type, patterns, extractor } of CONSTRAINT_PATTERNS) {
    for (const pattern of patterns) {
      const match = normalized.match(pattern) || text.match(pattern);
      if (match) {
        found.push({
          type,
          value: extractor(match),
          source: text.substring(0, 100),
          detectedAt: Date.now(),
        });
        break; // One match per type is enough
      }
    }
  }

  return found;
}

// ── Context Formatting ───────────────────────────────────────

/**
 * Build a summary of the session for LLM intent detection.
 * Compact format to fit within token budget.
 */
export function formatSessionForIntent(session: ConversationSession): string {
  const parts: string[] = [];

  // Recent intents (last 3)
  const recentIntents = session.intents.slice(-3);
  if (recentIntents.length > 0) {
    const intentStr = recentIntents
      .map((i) => `/${i.command}${i.executed ? "" : "(suggere)"}`)
      .join(", ");
    parts.push(`Intents recents: ${intentStr}`);
  }

  // Constraints
  if (session.constraints.length > 0) {
    const constraintStr = session.constraints
      .map((c) => `${c.type}=${c.value}`)
      .join(", ");
    parts.push(`Contraintes: ${constraintStr}`);
  }

  // Phase
  parts.push(`Phase: ${session.phase}`);

  // Active task
  if (session.activeTaskId) {
    parts.push(`Tache active: ${session.activeTaskId.substring(0, 8)}`);
  }

  return parts.join(" | ");
}

/**
 * Build conversation context for agent prompts (S43-03).
 * Extracts the key information agents need from the conversation session.
 * Returns formatted string ready for injection into agent context.
 */
export function buildConversationContext(session: ConversationSession): string {
  const parts: string[] = [];

  // Recent messages (what the user actually said)
  if (session.recentMessages.length > 0) {
    parts.push("Messages recents de l'utilisateur:");
    for (const msg of session.recentMessages) {
      parts.push(`- "${msg.substring(0, 200)}"`);
    }
  }

  // Constraints
  if (session.constraints.length > 0) {
    parts.push("");
    parts.push("Contraintes exprimees:");
    for (const c of session.constraints) {
      const labels: Record<string, string> = {
        speed: "Vitesse",
        quality: "Qualite",
        budget: "Budget",
        scope: "Perimetre",
        deadline: "Echeance",
      };
      parts.push(`- ${labels[c.type] || c.type}: ${c.value}`);
    }
  }

  // Decisions
  if (session.decisions.length > 0) {
    parts.push("");
    parts.push("Decisions prises:");
    for (const d of session.decisions.slice(-5)) {
      parts.push(`- ${d.description}`);
    }
  }

  // Intent trail (what the user explored before launching)
  const executedIntents = session.intents.filter((i) => i.executed);
  if (executedIntents.length > 0) {
    parts.push("");
    parts.push("Commandes executees dans cette session:");
    for (const i of executedIntents.slice(-5)) {
      parts.push(`- /${i.command} (confiance: ${i.confidence})`);
    }
  }

  if (parts.length === 0) return "";

  return parts.join("\n");
}

// ── Cleanup ──────────────────────────────────────────────────

/**
 * Remove expired sessions. Call periodically.
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastActivity >= SESSION_TTL_MS) {
      sessions.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

/**
 * Get the number of active sessions. For monitoring.
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/** Reset all sessions (for testing). */
export function _resetSessions(): void {
  sessions.clear();
}
