/**
 * @module intent-detection
 * @description Intent detection: detects user intent from natural language messages
 * and resolves to bot commands. Two-tier approach: fast regex matching for high-confidence
 * cases, LLM fallback (Haiku) for ambiguous messages. Behind feature flag "intent_detection".
 */

import { type ActionDefinition, formatActionsForLLM, getAction } from "./action-registry.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("intent-detection");
// ── Types ────────────────────────────────────────────────────

export interface DetectedIntent {
  intent: string;
  command: string;
  confidence: number;
  args?: string;
  /** The resolved action definition from the registry */
  action?: ActionDefinition;
  /** Source of detection: "regex" or "llm" */
  source: "regex" | "llm";
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
    command: "backlog",
    patterns: [
      /\b(backlog|taches?\s+(en\s+attente|a\s+faire)|quoi\s+faire|liste\s+(des\s+)?taches?)\b/i,
      /\b(qu'?est[- ]ce\s+qu'?il\s+(y\s+a|reste)\s+(a\s+faire|dans\s+le\s+backlog))\b/i,
      /\b(montre|affiche|voir)\s+(le\s+)?backlog\b/i,
    ],
  },
  {
    intent: "view_sprint",
    command: "sprint",
    patterns: [
      /\b(sprint\s+(actuel|en\s+cours)|avancement|progression|ou\s+en\s+est(-on)?)\b/i,
      /\b(comment\s+avance|etat\s+du\s+sprint)\b/i,
    ],
  },
  {
    intent: "create_task",
    command: "task",
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
    command: "metrics",
    patterns: [
      /\b(metriques?|statistiques?|stats?|velocite|performance)\b/i,
      /\b(comment\s+va\s+le\s+sprint)\b/i,
    ],
  },
  {
    intent: "run_retro",
    command: "retro",
    patterns: [/\b(retro(spective)?|bilan|retour\s+d'?experience)\b/i, /\bretrospective\b/i],
  },
  {
    intent: "get_help",
    command: "help",
    patterns: [
      /\b(aide|help|comment\s+(ca\s+marche|utiliser)|quelles?\s+commandes?)\b/i,
      /\b(qu'?est[- ]ce\s+que\s+tu\s+(peux|sais)\s+faire)\b/i,
    ],
  },
  {
    intent: "view_cost",
    command: "cost",
    patterns: [/\b(couts?|depenses?|budget|tokens?|combien\s+ca\s+coute)\b/i],
  },
  {
    intent: "brain_synthesis",
    command: "brain",
    patterns: [/\b(synthese|resume\s+memoire|qu'?est[- ]ce\s+que\s+tu\s+sais|memoire)\b/i],
  },
  {
    intent: "view_alerts",
    command: "alerts",
    patterns: [/\b(alertes?|anomalies?|problemes?|bugs?\s+detectes?)\b/i],
  },
  {
    intent: "view_ideas",
    command: "ideas",
    patterns: [/\b(idees?|suggestions?|propositions?)\b/i],
  },
  {
    intent: "plan_task",
    command: "plan",
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
    command: "exec",
    patterns: [
      /\b(execute|implemente)\s+(la\s+)?tache\b/i,
      /\b(lance)\s+(l'?agent|l'?execution|l'?implementation)\b/i,
    ],
  },
  {
    intent: "view_projects",
    command: "projects",
    patterns: [/\b(projets?|liste\s+des\s+projets?|quels?\s+projets?)\b/i],
  },
  {
    intent: "start_task",
    command: "start",
    patterns: [/\b(commence|demarre|prends?)\s+(la\s+)?tache\b/i],
  },
  {
    intent: "done_task",
    command: "done",
    patterns: [/\b(termine|fini|complete|cloture)\s+(la\s+)?tache\b/i],
  },
  {
    intent: "view_monitor",
    command: "monitor",
    patterns: [/\b(monitor(ing)?|surveillance|supervision)\b/i],
  },
  {
    intent: "rollback",
    command: "rollback",
    patterns: [/\b(rollback|revenir?\s+en\s+arriere|annuler?\s+(le\s+)?deploy)\b/i],
  },
  {
    intent: "resume_pipeline",
    command: "orchestrate",
    patterns: [
      // "relance le workflow", "reprends le pipeline", "resume l'execution"
      /\b(relance[rz]?|reprend[sz]?|reprendre|resume[rz]?)\s+(le\s+|la\s+|l'?)?(workflow|pipeline|orchestration|execution|implementation)\b/i,
      // "relance depuis l'echec", "reprendre ou ca a plante"
      /\b(relance[rz]?|reprend[sz]?|reprendre)\s+.{0,40}\b(echec|plante|echoue|crashe?)\b/i,
      // "relance le dernier pipeline", "reprendre le dernier workflow"
      /\b(relance[rz]?|reprend[sz]?|reprendre|resume[rz]?)\s+(le\s+)?dernier\s+(pipeline|workflow|execution)\b/i,
    ],
    argExtractor: () => "--resume",
  },
  {
    intent: "search_document",
    command: "docs",
    patterns: [
      // "trouve mon contrat", "retrouve ma facture", "trouve mes documents"
      /\b(trouve|retrouve)\s+(mon|ma|mes)\s+/i,
      // "ou est ma facture", "ou est mon contrat"
      /\bou\s+est\s+(mon|ma)\s+/i,
      // "cherche une facture", "recherche un document"
      /\b(cherche|recherche)\s+(un|une|le|la|mon|ma|mes|des)\s+(document|facture|contrat|recu|attestation|certificat|rapport|note|fiche|devis|bon|releve|bulletin)/i,
      // "montre-moi ma facture", "montre-moi mes documents"
      /\b(montre[- ]moi|affiche[- ]moi)\s+(mon|ma|mes)\s+/i,
      // "j'ai un document de mars"
      /\bj'?ai\s+un\s+document\s+(de|du|sur|pour)\s+/i,
      // "ma facture de janvier", "mon contrat d'assurance"
      /\b(ma|mon|mes)\s+(facture|contrat|recu|attestation|certificat|rapport|note|fiche|devis|bon|releve|bulletin)\s+(de|d'|du)\s+/i,
    ],
    argExtractor: (text) => {
      const extractors = [
        /(?:trouve|retrouve)\s+(?:mon|ma|mes)\s+(.+)/i,
        /ou\s+est\s+(?:mon|ma)\s+(.+)/i,
        /(?:cherche|recherche)\s+(?:un|une|le|la|mon|ma|mes|des)\s+(.+)/i,
        /(?:montre[- ]moi|affiche[- ]moi)\s+(?:mon|ma|mes)\s+(.+)/i,
        /j'?ai\s+un\s+document\s+(?:de|du|sur|pour)\s+(.+)/i,
        /(?:ma|mon|mes)\s+((?:facture|contrat|recu|attestation|certificat|rapport|note|fiche|devis|bon|releve|bulletin)(?:\s+.+)?)/i,
      ];
      for (const p of extractors) {
        const m = text.match(p);
        if (m?.[1]) {
          const term = m[1].replace(/\s*[?!.]\s*$/, "").trim();
          return `search ${term}`;
        }
      }
      return "search";
    },
  },
  {
    intent: "view_prd",
    command: "prd",
    patterns: [
      // "montre-moi le PRD", "affiche le PRD", "voir le PRD"
      /\b(montre|affiche|voir|show)\s+(?:moi\s+)?(?:le\s+)?prd\b/i,
      // "le PRD c495", "prd c495951a"
      /\bprd\s+[a-f0-9]{4,8}\b/i,
      // "liste les PRDs", "quels PRDs", "les PRDs"
      /\b(list[ée]?r?|voir)\s+(?:les?\s+)?prds?\b/i,
      /\b(quels?|combien\s+de)\s+prds?\b/i,
    ],
    argExtractor: (text) => {
      // Extract hex ID if present
      const idMatch = text.match(/\b([a-f0-9]{4,8})\b/i);
      if (idMatch) return idMatch[1];
      // Check if listing
      if (/\b(list[ée]?r?|quels?|combien)\b/i.test(text)) return "list";
      return undefined;
    },
  },
  {
    intent: "create_prd",
    command: "prd",
    patterns: [
      /\b(cree|creer|genere|generer|redige|rediger)\s+(?:un\s+)?prd\b/i,
      /\bprd\s+(pour|sur|de)\s+/i,
    ],
    argExtractor: (text) => {
      const match = text.match(/(?:prd|PRD)\s+(?:pour|sur|de)\s+(.+)/i);
      if (match) return match[1].replace(/\s*[?!.]\s*$/, "").trim();
      const match2 = text.match(/(?:cree|genere|redige)\s+(?:un\s+)?prd\s*:?\s+(.+)/i);
      if (match2) return match2[1].replace(/\s*[?!.]\s*$/, "").trim();
      return undefined;
    },
  },
  {
    intent: "suggest_prd",
    command: "prd_workflow",
    patterns: [
      /\b(je\s+voudrais|j'?aimerais|il\s+faudrait|on\s+devrait|on\s+pourrait)\s+(ajouter|creer|implementer|developper|faire|mettre\s+en\s+place)\s+/i,
      /\b(il\s+faudrait\s+que\s+le\s+bot|le\s+bot\s+devrait|le\s+systeme\s+devrait)\s+/i,
      /\b(on\s+a\s+besoin\s+d[e']\s*|il\s+nous\s+faut\s+|il\s+manque\s+)/i,
      /\b(nouvelle\s+fonctionnalite|nouvelle\s+feature|nouveau\s+module|nouvelle\s+commande)\b/i,
      /\b(implemente|developpe|code|lance\s+l'?implementation\s+de?)\s+/i,
      /\b(lance|lancer|cree|creer|genere|generer|fais|faire)\s+(?:le|un)\s+prd\s+(pour|de|sur)\s+/i,
      /\b(lance|lancer)\s+(?:le|un)\s+prd\b/i,
    ],
    argExtractor: (text) => {
      const patterns = [
        /(?:lance|lancer|cree|creer|genere|generer|fais|faire)\s+(?:le|un)\s+prd\s+(?:pour|de|sur)\s+(.+)/i,
        /(?:je\s+voudrais|j'?aimerais|il\s+faudrait|on\s+devrait|on\s+pourrait)\s+(?:ajouter|creer|implementer|developper|faire|mettre\s+en\s+place)\s+(.+)/i,
        /(?:il\s+faudrait\s+que\s+le\s+bot|le\s+bot\s+devrait|le\s+systeme\s+devrait)\s+(.+)/i,
        /(?:on\s+a\s+besoin\s+d[e']\s*|il\s+nous\s+faut\s+|il\s+manque\s+)(.+)/i,
        /(?:implemente|developpe|code|lance\s+l'?implementation\s+de?)\s+(.+)/i,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]) return m[1].replace(/\s*[?!.]\s*$/, "").trim();
      }
      return text;
    },
  },
  {
    intent: "view_jobs",
    command: "jobs",
    patterns: [
      /\b(jobs?|travaux|taches?\s+en\s+cours)\b/i,
      /\b(ou\s+en\s+est|c'?est\s+fini|statut\s+des?\s+jobs?)\b/i,
      /\b(qu'?est[- ]ce\s+qui\s+tourne)\b/i,
    ],
  },
  {
    intent: "explore_topic",
    command: "explore",
    patterns: [
      /\b(explore|investigu[ée]?r?|etudi[ée]?r?)\s+(le\s+|la\s+|l'|les?\s+|un\s+|une?\s+)?(\w+)/i,
      /\b(comment\s+fonctionne|c'?est\s+quoi|qu'?est[- ]ce\s+que)\s+(le\s+|la\s+|l')?(\w+)/i,
      /\bimpact\s+de\s+/i,
      /\b(regarde|examine|cherche)\s+(dans\s+)?/i,
      /\b(dependances?|dependents?|qui\s+utilise|utilise\s+par)\s+/i,
      /\b(complexite|architecture)\s+(de|du)\s+/i,
      /\b(recherche|research|compare|comparer|evaluer|benchmark)\s+(les?\s+|des?\s+|un\s+|une?\s+)?/i,
      /\b(state\s+of\s+the\s+art|etat\s+de\s+l'art|alternatives?\s+(a|pour))\b/i,
    ],
    argExtractor: (text) => {
      // Remove the trigger verb/phrase, keep the topic
      const patterns = [
        /(?:explore|investiguer|etudier|examiner|regarder|chercher)\s+(?:le\s+|la\s+|l'|les?\s+|un\s+|une?\s+)?(.+)/i,
        /comment\s+fonctionne\s+(?:le\s+|la\s+|l')?(.+)/i,
        /(?:c'?est\s+quoi|qu'?est[- ]ce\s+que)\s+(?:le\s+|la\s+|l')?(.+)/i,
        /impact\s+de\s+(?:modifier\s+)?(.+)/i,
        /(?:dependances?|dependents?|qui\s+utilise)\s+(?:de\s+|du\s+)?(.+)/i,
        /complexite\s+(?:de|du)\s+(.+)/i,
        /architecture\s+(?:de|du)\s+(.+)/i,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        const captured = m?.[m.length > 2 ? 2 : 1];
        if (captured) return captured.replace(/\s*\?\s*$/, "").trim();
      }
      return undefined;
    },
  },
];

// ── Core Regex Detection ─────────────────────────────────────

/**
 * Detect intent from a natural language message using regex patterns.
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
    const confidence = Math.min(Math.round((0.7 + (matchCount - 1) * 0.1) * 100) / 100, 0.95);

    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      const args = pattern.argExtractor?.(text);
      bestMatch = {
        intent: pattern.intent,
        command: pattern.command,
        confidence,
        args,
        action: getAction(pattern.command),
        source: "regex",
      };
    }
  }

  if (!bestMatch) {
    return { detected: null, suggestion: null };
  }

  const suggestion = bestMatch.args
    ? `/${bestMatch.command} ${bestMatch.args}`
    : `/${bestMatch.command}`;

  return {
    detected: bestMatch,
    suggestion,
  };
}

// ── LLM Intent Detection ────────────────────────────────────

export interface LLMIntentOptions {
  callLLM: (prompt: string) => Promise<string>;
  recentMessages?: string;
  timeoutMs?: number;
  /** S43: Session context for contextual intent detection */
  sessionContext?: string;
}

/**
 * Detect intent using LLM (Haiku) as fallback for ambiguous messages.
 * Only called when regex detection returns null or low confidence.
 */
export async function detectIntentWithLLM(
  text: string,
  options: LLMIntentOptions,
): Promise<IntentResult> {
  // Fast path: try regex first
  const regexResult = detectIntent(text);
  if (regexResult.detected && regexResult.detected.confidence >= 0.9) {
    return regexResult;
  }

  // LLM fallback
  try {
    const actionList = formatActionsForLLM();
    const prompt = [
      "Tu es un routeur d'intent. Analyse le message utilisateur et determine s'il correspond a une commande.",
      "",
      "COMMANDES DISPONIBLES:",
      actionList,
      "",
      options.sessionContext ? `CONTEXTE SESSION:\n${options.sessionContext}\n` : "",
      options.recentMessages ? `CONVERSATION RECENTE:\n${options.recentMessages}\n` : "",
      `MESSAGE UTILISATEUR: ${text}`,
      "",
      "Reponds UNIQUEMENT en JSON valide, sans markdown:",
      '{"command": "nom_commande_sans_slash", "args": "arguments extraits ou vide", "confidence": 0.0-1.0}',
      "",
      'Si aucune commande ne correspond, reponds: {"command": null, "args": "", "confidence": 0}',
      "Ne force pas un match si le message est juste une conversation normale.",
    ]
      .filter(Boolean)
      .join("\n");

    const timeoutMs = options.timeoutMs ?? 15000;
    const result = await Promise.race([
      options.callLLM(prompt),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("LLM timeout")), timeoutMs),
      ),
    ]);

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return regexResult;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.command || parsed.confidence < 0.6) return regexResult;

    const action = getAction(parsed.command);
    if (!action) return regexResult;

    // LLM result must beat regex result
    const llmConfidence = Math.min(parsed.confidence, 0.92); // Cap LLM slightly below max
    if (regexResult.detected && regexResult.detected.confidence >= llmConfidence) {
      return regexResult;
    }

    const detected: DetectedIntent = {
      intent: `llm_${parsed.command}`,
      command: parsed.command,
      confidence: llmConfidence,
      args: parsed.args || undefined,
      action,
      source: "llm",
    };

    return {
      detected,
      suggestion: detected.args ? `/${detected.command} ${detected.args}` : `/${detected.command}`,
    };
  } catch (error) {
    log.error("LLM intent detection error", { error: String(error) });
    // Fall back to regex result
    return regexResult;
  }
}

/**
 * Format a suggestion message for the user.
 * Only shown when confidence >= threshold (default 0.8).
 */
export function formatIntentSuggestion(result: IntentResult, threshold = 0.8): string | null {
  if (!result.detected || result.detected.confidence < threshold) return null;

  return `Tu voulais peut-etre lancer : ${result.suggestion}`;
}
