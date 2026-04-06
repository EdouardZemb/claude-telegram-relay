/**
 * @module browser-delegation
 * @description Chrome browser delegation service.
 * Detects browse intent from user input (code-side) and delegates to
 * Claude Code with Chrome browser integration.
 *
 * Security: Intent is detected from the user's original message, NOT from
 * LLM output, preventing prompt injection attacks via [BROWSE: ...] tag
 * manipulation in model responses.
 */

import { spawnClaude } from "./agent.ts";
import { getConfig } from "./config.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("browser-delegation");

/** Maximum length of a browse instruction (chars). Prevents oversized payloads. */
export const BROWSE_MAX_INSTRUCTION_LENGTH = 500;

/**
 * Browse intent detection patterns (French + English).
 * All patterns must match URL/site references to avoid false positives.
 */
const BROWSE_PATTERNS: RegExp[] = [
  /\bva sur\b/i,
  /\bnavigue vers?\b/i,
  /\bouvre\b.*(site|page|url|http)/i,
  /\bvisite\b.*(site|page|url|http)/i,
  /https?:\/\//i,
  /\bwww\./i,
  /\b(cherche|trouve|recherche)\b.*(web|internet|en ligne)/i,
  /\b(cherche|trouve|recherche|ouvre|navigue|visite)\b.*\b(leboncoin|sncf|amazon|google|linkedin|twitter|facebook|instagram)\b/i,
  /\b(leboncoin|sncf|amazon|google|linkedin|twitter|facebook|instagram)\b.*(cherche|trouve|prix|info|navigue|visite)/i,
];

export interface BrowseDelegationResult {
  response: string;
  vncUrl: string;
}

/**
 * Pure pattern check — no feature-flag dependency.
 * Exported for testability; callers should use detectBrowseIntent instead.
 */
export function matchesBrowsePatterns(input: string): boolean {
  return BROWSE_PATTERNS.some((pattern) => pattern.test(input));
}

/**
 * Check if user input requires browser delegation.
 * Returns true only if the `chrome_browse` feature flag is enabled AND
 * the input matches browse intent patterns.
 *
 * Detection is code-side (not LLM-derived) to prevent prompt injection.
 */
export function detectBrowseIntent(input: string): boolean {
  if (!isFeatureEnabled("chrome_browse")) return false;
  return matchesBrowsePatterns(input);
}

/**
 * Execute a browse instruction using Claude Code with Chrome.
 * The instruction must come from the user's original message (not LLM output)
 * to prevent prompt injection.
 */
export async function executeBrowseInstruction(
  instruction: string,
): Promise<BrowseDelegationResult> {
  const novncUrl = (() => {
    try {
      return getConfig().novncUrl;
    } catch {
      return "";
    }
  })();

  // Truncate to prevent oversized instructions
  const safeInstruction = instruction.substring(0, BROWSE_MAX_INSTRUCTION_LENGTH);

  log.info(`Browser delegation: ${safeInstruction.substring(0, 60)}...`);

  const result = await spawnClaude({
    prompt:
      safeInstruction +
      "\nIMPORTANT: Si tu rencontres un captcha ou une verification anti-bot, " +
      "dis-le clairement dans ta reponse et attends 30 secondes avant de reessayer " +
      "(l'utilisateur peut intervenir manuellement via noVNC).",
    chrome: true,
    effort: "high",
    timeout: 180_000,
  });

  log.info(
    `Browser result: exit=${result.exitCode} stdout=${result.stdout.length}b stderr=${result.stderr.length}b`,
  );
  if (result.exitCode !== 0) {
    log.error(`Browser stderr: ${result.stderr.substring(0, 500)}`);
  }

  return {
    response: result.stdout.trim() || "Aucun résultat du navigateur.",
    vncUrl: novncUrl,
  };
}
