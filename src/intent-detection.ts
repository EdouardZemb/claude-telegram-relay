/**
 * @module intent-detection
 * @description Intent detection spike: detects user intent from natural language messages
 * and suggests matching bot commands. Uses pattern matching with LLM fallback.
 * Behind feature flag "intent_detection".
 */

// ── Types ────────────────────────────────────────────────────

export interface DetectedIntent {
  intent: string;
  command: string;
  confidence: number;
  args?: string;
}

export interface IntentResult {
  detected: DetectedIntent | null;
  suggestion: string | null;
}

// ── Intent Patterns ──────────────────────────────────────────

interface IntentPattern {
  intent: string;
  command: string;
  patterns: RegExp[];
  /** Extract args from the matched text */
  argExtractor?: (text: string) => string | undefined;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: "view_backlog",
    command: "/backlog",
    patterns: [
      /\b(backlog|taches?\s+(en\s+attente|a\s+faire)|quoi\s+faire|liste\s+(des\s+)?taches?)\b/i,
      /\b(qu'?est[- ]ce\s+qu'?il\s+(y\s+a|reste)\s+(a\s+faire|dans\s+le\s+backlog))\b/i,
      /\b(montre|affiche|voir)\s+(le\s+)?backlog\b/i,
    ],
  },
  {
    intent: "view_sprint",
    command: "/sprint",
    patterns: [
      /\b(sprint\s+(actuel|en\s+cours)|avancement|progression|ou\s+en\s+est(-on)?)\b/i,
      /\b(comment\s+avance|etat\s+du\s+sprint)\b/i,
    ],
  },
  {
    intent: "create_task",
    command: "/task",
    patterns: [
      /\b(cree|ajoute|nouvelle)\s+(une\s+)?tache\b/i,
      /\b(il\s+faut|on\s+doit|faudrait)\s+(ajouter|creer|faire)\b/i,
    ],
    argExtractor: (text) => {
      const match = text.match(/(?:tache|faire|creer|ajouter)\s*:?\s+(.+)/i);
      return match?.[1]?.trim();
    },
  },
  {
    intent: "view_metrics",
    command: "/metrics",
    patterns: [
      /\b(metriques?|statistiques?|stats?|velocite|performance)\b/i,
      /\b(comment\s+va\s+le\s+sprint)\b/i,
    ],
  },
  {
    intent: "run_retro",
    command: "/retro",
    patterns: [
      /\b(retro(spective)?|bilan|retour\s+d'?experience)\b/i,
      /\bretrospective\b/i,
    ],
  },
  {
    intent: "get_help",
    command: "/help",
    patterns: [
      /\b(aide|help|comment\s+(ca\s+marche|utiliser)|quelles?\s+commandes?)\b/i,
      /\b(qu'?est[- ]ce\s+que\s+tu\s+(peux|sais)\s+faire)\b/i,
    ],
  },
  {
    intent: "view_cost",
    command: "/cost",
    patterns: [
      /\b(couts?|depenses?|budget|tokens?|combien\s+ca\s+coute)\b/i,
    ],
  },
  {
    intent: "brain_synthesis",
    command: "/brain",
    patterns: [
      /\b(synthese|resume\s+memoire|qu'?est[- ]ce\s+que\s+tu\s+sais|memoire)\b/i,
    ],
  },
  {
    intent: "view_alerts",
    command: "/alerts",
    patterns: [
      /\b(alertes?|anomalies?|problemes?|bugs?\s+detectes?)\b/i,
    ],
  },
  {
    intent: "view_ideas",
    command: "/ideas",
    patterns: [
      /\b(idees?|suggestions?|propositions?)\b/i,
    ],
  },
  {
    intent: "plan_task",
    command: "/plan",
    patterns: [
      /\b(planifie|decompose|decoupe|organise)\s+(\w+\s+)?(tache|feature|fonctionnalite)\b/i,
      /\b(planifie|decompose|decoupe)\s+/i,
    ],
    argExtractor: (text) => {
      const match = text.match(/(?:planifie|decompose|decoupe)\s+(?:la\s+)?(.+)/i);
      return match?.[1]?.trim();
    },
  },
  {
    intent: "execute_task",
    command: "/exec",
    patterns: [
      /\b(execute|lance|demarre|implemente)\s+(la\s+)?tache\b/i,
    ],
  },
  {
    intent: "view_projects",
    command: "/projects",
    patterns: [
      /\b(projets?|liste\s+des\s+projets?|quels?\s+projets?)\b/i,
    ],
  },
  {
    intent: "start_task",
    command: "/start",
    patterns: [
      /\b(commence|demarre|prends?)\s+(la\s+)?tache\b/i,
    ],
  },
  {
    intent: "done_task",
    command: "/done",
    patterns: [
      /\b(termine|fini|complete|cloture)\s+(la\s+)?tache\b/i,
    ],
  },
];

// ── Core Detection ───────────────────────────────────────────

/**
 * Detect intent from a natural language message.
 * Returns detected intent with confidence score, or null if no match.
 *
 * Confidence levels:
 *   0.9+ — Strong match (multiple pattern hits or very specific phrases)
 *   0.7-0.9 — Good match (single pattern hit)
 *   <0.7 — Weak match (not returned)
 */
export function detectIntent(text: string): IntentResult {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  let bestMatch: DetectedIntent | null = null;
  let bestConfidence = 0;

  for (const pattern of INTENT_PATTERNS) {
    let matchCount = 0;
    for (const regex of pattern.patterns) {
      if (regex.test(normalized) || regex.test(text)) {
        matchCount++;
      }
    }

    if (matchCount === 0) continue;

    // Confidence: 0.7 base + 0.1 per additional match, max 0.95
    const confidence = Math.min(0.7 + (matchCount - 1) * 0.1, 0.95);

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      const args = pattern.argExtractor?.(text);
      bestMatch = {
        intent: pattern.intent,
        command: pattern.command,
        confidence,
        args,
      };
    }
  }

  if (!bestMatch) {
    return { detected: null, suggestion: null };
  }

  const suggestion = bestMatch.args
    ? `${bestMatch.command} ${bestMatch.args}`
    : bestMatch.command;

  return {
    detected: bestMatch,
    suggestion,
  };
}

/**
 * Format a suggestion message for the user.
 * Only shown when confidence >= threshold (default 0.8).
 */
export function formatIntentSuggestion(result: IntentResult, threshold = 0.8): string | null {
  if (!result.detected || result.detected.confidence < threshold) return null;

  return `Tu voulais peut-etre lancer : ${result.suggestion}`;
}
