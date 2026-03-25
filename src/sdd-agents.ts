/**
 * @module sdd-agents
 * @description SDD agent functions: business logic for each pipeline phase.
 * Phase 3 Architecture V2 — pure business logic, NOT a grammY Composer.
 * Imports restricted to agent.ts, conversation-handoff.ts, logger.ts (R13).
 */

import { spawnSync } from "bun";
import { writeFile as _writeFileDefault, mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { spawnClaude } from "./agent.ts";
import type { BotContext } from "./bot-context.ts";
import { formatHandoffForAgent, type HandoffSummary } from "./conversation-handoff.ts";
import { isFeatureEnabled as _isFeatureEnabledDefault } from "./feature-flags.ts";
import { createLogger } from "./logger.ts";
import { buildEnrichedPrompt as _buildEnrichedPromptDefault } from "./prompt-overlay.ts";

const log = createLogger("sdd-agents");

/**
 * Optional test hook: replace writeFile without polluting the global fs/promises mock.
 * In production this is undefined and the real writeFile is used.
 * In tests, call setWriteFileHook(fn) before importing sdd-agents functions.
 */
let _writeFileHook: ((path: string, content: string) => Promise<void>) | undefined;

/** @internal — for tests only */
export function setWriteFileHook(
  fn: ((path: string, content: string) => Promise<void>) | undefined,
): void {
  _writeFileHook = fn;
}

function writeFile(path: string, content: string): Promise<void> {
  if (_writeFileHook) return _writeFileHook(path, content);
  return _writeFileDefault(path, content);
}

/**
 * Optional test hook: replace spawnSync calls for testing.
 * In production this is undefined and the real spawnSync is used.
 */
let _spawnSyncHook: ((args: string[]) => { exitCode: number | null }) | undefined;

/** @internal — for tests only */
export function setSpawnSyncHook(
  fn: ((args: string[]) => { exitCode: number | null }) | undefined,
): void {
  _spawnSyncHook = fn;
}

function execSpawnSync(args: string[]): { exitCode: number | null } {
  if (_spawnSyncHook) return _spawnSyncHook(args);
  return spawnSync(args);
}

/**
 * Optional test hook: replace isFeatureEnabled without reading from disk.
 * In production this is undefined and the real isFeatureEnabled is used.
 */
let _featureEnabledHook: ((flag: string) => boolean) | undefined;

/** @internal — for tests only */
export function setFeatureEnabledHook(fn: ((flag: string) => boolean) | undefined): void {
  _featureEnabledHook = fn;
}

function checkFeatureEnabled(flag: string): boolean {
  if (_featureEnabledHook) return _featureEnabledHook(flag);
  return _isFeatureEnabledDefault(flag);
}

/**
 * Optional test hook: replace buildEnrichedPrompt without importing prompt-overlay in tests.
 * In production this is undefined and the real buildEnrichedPrompt is used.
 */
let _buildEnrichedPromptHook: ((role: string, base: string) => string) | undefined;

/** @internal — for tests only */
export function setBuildEnrichedPromptHook(
  fn: ((role: string, base: string) => string) | undefined,
): void {
  _buildEnrichedPromptHook = fn;
}

function enrichPrompt(role: string, base: string): string {
  if (_buildEnrichedPromptHook) return _buildEnrichedPromptHook(role, base);
  return _buildEnrichedPromptDefault(role, base);
}

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const AGENTS_DIR = join(PROJECT_ROOT, ".claude", "agents");
const SKILLS_DIR = join(PROJECT_ROOT, ".claude", "skills");

// ── Verdict Extraction Helpers ───────────────────────────────

type ChallengeVerdict = "GO" | "GO_WITH_CHANGES" | "NO-GO";

/** Severity order: higher index = more severe */
const VERDICT_SEVERITY: Record<ChallengeVerdict, number> = {
  GO: 0,
  GO_WITH_CHANGES: 1,
  "NO-GO": 2,
};

/** Extract explore verdict (GO/PIVOT/DROP). Falls back to GO (F-DA-3). */
function extractExploreVerdict(output: string): "GO" | "PIVOT" | "DROP" {
  const m =
    output.match(/##\s*Verdict\s*\n\s*(GO|PIVOT|DROP)/i) ||
    output.match(/\bverdict\s*:\s*(GO|PIVOT|DROP)\b/i);
  return m ? (m[1].toUpperCase() as "GO" | "PIVOT" | "DROP") : "GO";
}

/** Extract challenge verdict. Explicit line or severity-based fallback (F-DA-4). */
function extractChallengeVerdict(output: string): ChallengeVerdict {
  const m = output.match(/##\s*Verdict\s+de\s+l'agent\s*:\s*(GO_WITH_CHANGES|NO-GO|GO)/i);
  if (m) return m[1].toUpperCase() as ChallengeVerdict;
  if (/\[BLOQUANT\]/i.test(output)) return "NO-GO";
  if (/\[MAJEUR\]/i.test(output)) return "GO_WITH_CHANGES";
  return "GO";
}

/** Return the most severe verdict from a list (F-DA-4). */
function mostSevereVerdict(verdicts: ChallengeVerdict[]): ChallengeVerdict {
  if (verdicts.length === 0) return "GO";
  return verdicts.reduce((worst, current) =>
    VERDICT_SEVERITY[current] > VERDICT_SEVERITY[worst] ? current : worst,
  );
}

/** Read an agent definition file from .claude/agents/. Returns "" on failure.
 * When the prompt_feedback_loop feature flag is enabled, enriches the prompt
 * with active overlays for the agent role (derived from filename).
 */
async function readAgentFile(filename: string): Promise<string> {
  try {
    const content = await readFile(join(AGENTS_DIR, filename), "utf-8");
    // Enrich with overlays if feature flag is on
    if (checkFeatureEnabled("prompt_feedback_loop") && content) {
      const role = filename.replace(/\.md$/, "");
      return enrichPrompt(role, content);
    }
    return content;
  } catch {
    log.warn(`Agent file not found: ${filename}`);
    return "";
  }
}

// ── Phase → Agent Role Mapping ───────────────────────────────

/**
 * Maps each SDD phase to the canonical agent role responsible for that phase.
 * Used by job-manager to write agent_events with the correct agent_role.
 * Source of truth: the readAgentFile() calls in each runSdd* function below.
 * "discuss" maps to "spec-architect" (the architect drives the discussion).
 */
export const PHASE_TO_AGENT_ROLE: Record<string, string> = {
  explore: "explorer",
  discuss: "spec-architect",
  spec: "spec-architect",
  challenge: "spec-architect",
  implement: "implementer",
  review: "reviewer",
  doc: "spec-architect",
};

// ── Public API ───────────────────────────────────────────────

/** Run the SDD Explore phase (R5, R12). Builds prompt directly (no buildExploreFn reuse). */
export async function runSddExplore(
  name: string,
  _chatId?: number,
  _threadId?: number | undefined,
): Promise<string> {
  try {
    const agentDef = await readAgentFile("explorer.md");
    const humanName = name.replace(/-/g, " ");

    const prompt = [
      "EXPLORATION SDD",
      "",
      `Sujet: ${humanName}`,
      `Nom: ${name}`,
      "",
      "Explore le codebase, analyse les fichiers pertinents, et produis un rapport structure.",
      `Sauvegarde le rapport dans docs/explorations/EXPLORE-${name}.md`,
      "",
      "A la fin du rapport, inclus une section:",
      "## Verdict",
      "GO | PIVOT | DROP",
      "(sur une ligne seule, suivi d'une justification)",
    ].join("\n");

    const result = await spawnClaude({
      prompt,
      systemPrompt: agentDef || undefined,
      model: "claude-sonnet-4-6",
      effort: "medium",
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const error = result.stderr || "Pas de reponse de l'agent explorer";
      log.error("runSddExplore failed", { name, error });
      return `SDD_EXPLORE_FAILED: ${error.substring(0, 500)}`;
    }

    const verdict = extractExploreVerdict(result.stdout);
    return `SDD_EXPLORE_${verdict}: ${name} — EXPLORE-${name}.md`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddExplore exception", { name, error: msg });
    return `SDD_EXPLORE_FAILED: ${msg.substring(0, 500)}`;
  }
}

/** Run the SDD Spec phase (R6, D2). Handoff summary substitutes for Discovery Interview. */
export async function runSddSpec(
  name: string,
  handoff: HandoffSummary,
  bctx: BotContext,
): Promise<string> {
  try {
    const agentDef = await readAgentFile("spec-architect.md");
    const formattedHandoff = formatHandoffForAgent(handoff);
    const humanName = name.replace(/-/g, " ");

    const prompt = [
      "SPECIFICATION SDD",
      "",
      "CONTEXTE CONVERSATIONNEL:",
      formattedHandoff,
      "",
      `Genere la spec 9 sections pour : ${humanName}`,
      `Nom: ${name}`,
      "",
      `Sauvegarde la spec dans docs/specs/SPEC-${name}.md`,
      "",
      handoff.explorationRef ? `Reference exploration: ${handoff.explorationRef}` : "",
      handoff.specRef ? `Reference spec precedente: ${handoff.specRef}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await spawnClaude({
      prompt,
      systemPrompt: agentDef || undefined,
      model: "claude-sonnet-4-6",
      effort: "high",
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const error = result.stderr || "Pas de reponse du spec-architect";
      log.error("runSddSpec failed", { name, error });
      return `SDD_SPEC_FAILED: ${error.substring(0, 500)}`;
    }

    // Extract V-criteria count from output if possible
    const vMatch = result.stdout.match(/V(\d+)/g);
    const vCount = vMatch ? new Set(vMatch).size : 0;

    return `SDD_SPEC_OK: ${name} — SPEC-${name}.md (${vCount} V-criteres)`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddSpec exception", { name, error: msg });
    return `SDD_SPEC_FAILED: ${msg.substring(0, 500)}`;
  }
}

/** Run the SDD Challenge phase (R7, F-EC-2). 3 agents via Promise.allSettled. */
export async function runSddChallenge(name: string, bctx: BotContext): Promise<string> {
  try {
    const specPath = `docs/specs/SPEC-${name}.md`;
    const reportPath = join(PROJECT_ROOT, "docs", "reviews", `adversarial-SPEC-${name}.md`);

    const agents = [
      { file: "devils-advocate.md", label: "Devil's Advocate" },
      { file: "edge-case-hunter.md", label: "Edge Case Hunter" },
      { file: "simplicity-skeptic.md", label: "Simplicity Skeptic" },
    ];

    const basePrompt = [
      "CHALLENGE ADVERSARIAL SDD",
      "",
      `Spec a analyser: ${specPath}`,
      `Lis la spec et produis ton rapport d'analyse adversariale.`,
      "",
      "A la fin de ton rapport, inclus une ligne:",
      "## Verdict de l'agent: GO | GO_WITH_CHANGES | NO-GO",
    ].join("\n");

    // Launch 3 agents in parallel via Promise.allSettled (F-EC-2)
    const promises = agents.map(async (agent) => {
      const agentDef = await readAgentFile(agent.file);
      return spawnClaude({
        prompt: basePrompt,
        systemPrompt: agentDef || undefined,
        model: "claude-sonnet-4-6",
        effort: "medium",
      });
    });

    const results = await Promise.allSettled(promises);

    // Process results
    const sections: string[] = [];
    const verdicts: ChallengeVerdict[] = [];
    let successCount = 0;

    for (let i = 0; i < results.length; i++) {
      const settled = results[i];
      const agent = agents[i];

      if (settled.status === "fulfilled") {
        const r = settled.value;
        if (r.exitCode === 0 && r.stdout.trim()) {
          sections.push(`## ${agent.label} — Rapport\n\n${r.stdout.trim()}`);
          verdicts.push(extractChallengeVerdict(r.stdout));
          successCount++;
        } else {
          const errMsg = r.stderr || "Sortie vide";
          sections.push(
            `## ${agent.label} — AGENT CRASH\n\nL'agent a echoue (exitCode: ${r.exitCode}).\nErreur: ${errMsg.substring(0, 500)}`,
          );
        }
      } else {
        const errMsg =
          settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        sections.push(
          `## ${agent.label} — AGENT CRASH\n\nL'agent a echoue avec une exception.\nErreur: ${errMsg.substring(0, 500)}`,
        );
      }
    }

    // All agents failed
    if (successCount === 0) {
      log.error("runSddChallenge: all 3 agents failed", { name });
      return `SDD_CHALLENGE_FAILED: Les 3 agents adversariaux ont echoue`;
    }

    // Build consolidated report
    const globalVerdict = mostSevereVerdict(verdicts);
    const report = [
      `# Challenge Adversarial — SPEC-${name}.md`,
      "",
      `Verdict global: ${globalVerdict}`,
      `Agents: ${successCount}/3 reussis`,
      "",
      "---",
      "",
      sections.join("\n\n---\n\n"),
    ].join("\n");

    // Save report
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report);
    log.info("Challenge report saved", { path: reportPath, verdict: globalVerdict });

    // Return prefixed result
    if (globalVerdict === "NO-GO") {
      return `SDD_CHALLENGE_NO-GO: ${name} — adversarial-SPEC-${name}.md`;
    } else if (globalVerdict === "GO_WITH_CHANGES") {
      return `SDD_CHALLENGE_GO_WITH_CHANGES: ${name} — adversarial-SPEC-${name}.md`;
    }
    return `SDD_CHALLENGE_GO: ${name} — adversarial-SPEC-${name}.md`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddChallenge exception", { name, error: msg });
    return `SDD_CHALLENGE_FAILED: ${msg.substring(0, 500)}`;
  }
}

/** Run the SDD Implement phase (R8). useWorktree: true, spec + adversarial refs. */
export async function runSddImplement(name: string, bctx: BotContext): Promise<string> {
  try {
    const specRef = `docs/specs/SPEC-${name}.md`;
    const adversarialRef = `docs/reviews/adversarial-SPEC-${name}.md`;

    const prompt = [
      "IMPLEMENTATION SDD",
      "",
      `Implementer la spec: ${specRef}`,
      `Review adversariale: ${adversarialRef}`,
      "",
      "Instructions:",
      `- Lis la spec ${specRef} et la review ${adversarialRef}`,
      "- Implemente en TDD (tests d'abord, puis code)",
      "- Tiens compte des findings de la review adversariale",
      `- Sauvegarde le rapport dans docs/reviews/implement-${name}.md`,
      "- Cree une PR avec les changements",
    ].join("\n");

    const result = await spawnClaude({
      prompt,
      model: "claude-sonnet-4-6",
      effort: "high",
      useWorktree: true,
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const error = result.stderr || "Pas de reponse de l'agent d'implementation";
      log.error("runSddImplement failed", { name, error });
      return `SDD_IMPLEMENT_FAILED: ${error.substring(0, 500)}`;
    }

    // Extract full PR URL from agent output (F-DA-1: include URL for later extraction by extractPrUrl)
    const prUrlFromStdout = result.stdout.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0];
    if (prUrlFromStdout) {
      return `SDD_IMPLEMENT_OK: ${name} — ${prUrlFromStdout}`;
    }

    // Fallback: try to extract PR number only
    const prMatch = result.stdout.match(/PR\s*#?(\d+)/i);
    const prInfo = prMatch ? `PR#${prMatch[1]}` : "PR created";
    return `SDD_IMPLEMENT_OK: ${name} — ${prInfo}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddImplement exception", { name, error: msg });
    return `SDD_IMPLEMENT_FAILED: ${msg.substring(0, 500)}`;
  }
}

/** Run the SDD Doc phase. Dev-doc skill updates documentation post-implementation. */
export async function runSddDoc(name: string, bctx: BotContext): Promise<string> {
  try {
    let skillContent = "";
    try {
      skillContent = await readFile(join(SKILLS_DIR, "dev-doc", "SKILL.md"), "utf-8");
    } catch {
      log.warn("dev-doc SKILL.md not found, running without system prompt");
    }

    const implRef = `docs/reviews/implement-${name}.md`;

    const prompt = [
      "DOCUMENTATION SDD",
      "",
      `Pipeline: ${name}`,
      `Rapport d'implementation: ${implRef}`,
      "",
      "Instructions:",
      `- Lis le rapport d'implementation ${implRef} si disponible`,
      "- Mets a jour la documentation du codebase (CLAUDE.md, docs/) selon les modifications",
      "- Verifie la coherence des modules/exports documentes",
    ].join("\n");

    const result = await spawnClaude({
      prompt,
      systemPrompt: skillContent || undefined,
      model: "claude-sonnet-4-6",
      effort: "medium",
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const error = result.stderr || "Pas de reponse de l'agent documentation";
      log.error("runSddDoc failed", { name, error });
      return `SDD_DOC_FAILED: ${error.substring(0, 500)}`;
    }

    return `SDD_DOC_OK: ${name} — documentation mise a jour`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddDoc exception", { name, error: msg });
    return `SDD_DOC_FAILED: ${msg.substring(0, 500)}`;
  }
}

/** Run the SDD Review phase. Reviewer agent examines implementation. */
export async function runSddReview(
  name: string,
  bctx: BotContext,
  prUrl?: string,
): Promise<string> {
  try {
    const agentDef = await readAgentFile("reviewer.md");
    const specRef = `docs/specs/SPEC-${name}.md`;
    const implRef = `docs/reviews/implement-${name}.md`;

    const prompt = [
      "REVIEW SDD",
      "",
      `Spec: ${specRef}`,
      `Rapport d'implementation: ${implRef}`,
      "",
      "Instructions:",
      `- Lis la spec ${specRef} et le rapport d'implementation ${implRef}`,
      "- Verifie la conformite de l'implementation avec la spec",
      "- Verifie que les V-criteres sont couverts par des tests",
      "- Produis un rapport de review complet",
      "- A la fin de ton rapport, ecris sur une ligne seule :",
      "  VERDICT: APPROVED",
      "  ou VERDICT: CHANGES_REQUESTED",
      "  (APPROVED si l'implementation est conforme, CHANGES_REQUESTED si des corrections sont requises)",
    ].join("\n");

    const result = await spawnClaude({
      prompt,
      systemPrompt: agentDef || undefined,
      model: "claude-sonnet-4-6",
      effort: "medium",
    });

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const error = result.stderr || "Pas de reponse de l'agent reviewer";
      log.error("runSddReview failed", { name, error });
      return `SDD_REVIEW_FAILED: ${error.substring(0, 500)}`;
    }

    // Extract verdict — use last occurrence to avoid false positives from quoted criteria (F-EC-1)
    const verdictMatches = [...result.stdout.matchAll(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED)/gi)];
    const lastMatch = verdictMatches.at(-1);
    const extractedVerdict = lastMatch ? lastMatch[1].toUpperCase() : null;
    log.info("runSddReview verdict extracted", { name, extractedVerdict });

    // Default to CHANGES_REQUESTED if no verdict found (conservative)
    const verdict = extractedVerdict === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";

    // If APPROVED and prUrl provided: call gh pr review --approve (R7)
    let autoMergeActivated = false;
    if (verdict === "APPROVED" && prUrl) {
      const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
      const githubRepo = process.env.GITHUB_REPO || "";
      if (prNumber && githubRepo) {
        const reviewResult = execSpawnSync([
          "gh",
          "pr",
          "review",
          prNumber,
          "--approve",
          "--body",
          "Approuve par reviewer SDD",
          "-R",
          githubRepo,
        ]);
        if (reviewResult.exitCode !== 0) {
          log.error("gh pr review --approve failed", {
            name,
            prNumber,
            exitCode: reviewResult.exitCode,
          });
          // R7: log but continue — verdict Telegram remains APPROVED
        }

        // Auto-merge: if feature flag enabled, activate gh pr merge --auto (AM)
        if (checkFeatureEnabled("sdd_auto_merge")) {
          const mergeResult = execSpawnSync([
            "gh",
            "pr",
            "merge",
            prNumber,
            "--auto",
            "--squash",
            "--delete-branch",
            "-R",
            githubRepo,
          ]);
          if (mergeResult.exitCode === 0) {
            autoMergeActivated = true;
            log.info("Auto-merge activated for PR", { name, prNumber });
          } else {
            log.error("gh pr merge --auto failed", {
              name,
              prNumber,
              exitCode: mergeResult.exitCode,
            });
            // Log but continue — fallback to manual merge button
          }
        }
      }
    }

    const autoMergeTag = autoMergeActivated ? " [AUTO-MERGE]" : "";
    return `SDD_REVIEW_${verdict}: ${name}${autoMergeTag}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("runSddReview exception", { name, error: msg });
    return `SDD_REVIEW_FAILED: ${msg.substring(0, 500)}`;
  }
}
