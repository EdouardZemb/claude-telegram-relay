/**
 * @module browser-delegation
 * @description Browser delegation service: wraps spawnClaude with Chrome for web navigation.
 * Extracted from commands layer to enforce architectural boundaries (S4).
 * VNC URL sourced from config (S2), instruction length capped (security).
 */

import { spawnClaude } from "./agent.ts";
import { getConfig } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("browser-delegation");

/** Maximum length for browse instructions to prevent oversized payloads */
const BROWSE_INSTRUCTION_MAX_LEN = 500;

/** Result of a browser delegation call */
export interface BrowseResult {
  response: string;
  vncUrl: string;
}

/**
 * Delegate a browsing task to Claude Code with Chrome.
 * Instruction is capped at BROWSE_INSTRUCTION_MAX_LEN characters.
 * VNC URL is sourced from config (NOVNC_URL env var).
 */
export async function browseClaude(instruction: string): Promise<BrowseResult> {
  const vncUrl = getConfig().novncUrl;
  const safeInstruction = instruction.substring(0, BROWSE_INSTRUCTION_MAX_LEN);

  log.info(`Browser delegation: ${safeInstruction.substring(0, 80)}...`);

  const browseStart = Date.now();
  const browseResult = await spawnClaude({
    prompt:
      safeInstruction +
      "\nIMPORTANT: Si tu rencontres un captcha ou une verification anti-bot, " +
      "dis-le clairement dans ta reponse et attends 30 secondes avant de reessayer " +
      "(l'utilisateur peut intervenir manuellement via noVNC).",
    chrome: true,
    effort: "high",
    timeout: 180_000,
  });

  const elapsed = ((Date.now() - browseStart) / 1000).toFixed(0);
  log.info(
    `Browser result: exit=${browseResult.exitCode} stdout=${browseResult.stdout.length}b stderr=${browseResult.stderr.length}b elapsed=${elapsed}s`,
  );
  if (browseResult.exitCode !== 0) {
    log.error(`Browser stderr: ${browseResult.stderr.substring(0, 500)}`);
  }

  const response = browseResult.stdout.trim() || "Aucun résultat du navigateur.";
  return { response, vncUrl };
}
