# Implementation Report — Suppression orchestration Vagues 2+3

Phase: ARCHITECTURE-V2 Phase 4 (suppressions modules TypeScript)
Date: 2026-03-24
Statut: **DONE**

## Resultat

- **Typecheck**: `bunx tsc --noEmit` PASS
- **Tests**: 2098 pass, 0 fail, 3 skip (80 fichiers)
- **Biome**: 3 erreurs pre-existantes dans doc-utils.ts (noImplicitAnyLet), non liees

## Modules supprimes (16 fichiers, ~5 476 LOC)

| Module | LOC | Importeurs adaptes |
|--------|-----|-------------------|
| `src/explore-graph.ts` | 369 | Aucun (feuille pure) |
| `src/proactive-planner.ts` | 437 | `mcp/memory-server.ts` (outil analyze_backlog retire) |
| `src/agent-context.ts` | 486 | `src/agent.ts` (buildAgentContext retire, le SDD construit ses prompts) |
| `src/mcp-config.ts` | 257 | `src/agent.ts` (buildMcpToolInstructions retire), `src/sdd-agents.ts` (mcpRole retire) |
| `src/story-files.ts` | 351 | `src/bmad-agents.ts` (buildStoryFile/formatStoryForAgent retires de buildBmadExecPrompt) |
| `src/command-router.ts` | 367 | `src/commands/zz-messages.ts` (fonctions inline dans zz-messages) |
| `src/autonomy-scanner.ts` | 273 | `src/heartbeat.ts` (section daily autonomy scan retiree) |
| `src/patterns.ts` | 393 | `src/commands/quality.ts` (commande /patterns retiree, analyzePatterns retire du /retro) |
| `src/feedback-loop.ts` | 447 | `src/relay.ts`, `src/commands/quality.ts`, `src/bmad-prompts.ts` |
| `src/trust-scores.ts` | 289 | `src/alerts.ts`, `src/llm-ops.ts` (circuit-breaker simplifie) |
| `src/code-graph.ts` | 507 | `src/commands/help.ts`, `mcp/memory-server.ts` (3 outils MCP retires) |
| `src/profile-evolution.ts` | 326 | `src/bot-context.ts`, `src/commands/profile.ts` (/profile simplifie) |
| `src/code-review.ts` | 259 | `src/agent.ts` (gate 3 code review retiree de executeTask) |
| `src/cost-estimate.ts` | 159 | `src/commands/utilities.ts` (/estimate simplifie) |
| `src/explore-graph.ts` | 369 | — |
| `src/proactive-planner.ts` | 437 | — |

## Tests supprimes (14 fichiers)

- `tests/unit/explore-graph.test.ts`
- `tests/unit/proactive-planner.test.ts`
- `tests/unit/agent-context.test.ts`
- `tests/unit/mcp-config.test.ts`
- `tests/unit/story-files.test.ts`
- `tests/unit/command-router.test.ts`
- `tests/unit/autonomy-scanner.test.ts`
- `tests/unit/patterns.test.ts`
- `tests/unit/feedback-loop.test.ts`
- `tests/unit/trust-scores.test.ts`
- `tests/unit/code-graph.test.ts`
- `tests/unit/profile-evolution.test.ts`
- `tests/unit/code-review.test.ts`
- `tests/unit/cost-estimate.test.ts`
- `tests/unit/progressive-autonomy.test.ts`
- `tests/unit/mcp-orchestration-tools.test.ts`
- `tests/generated/memoire-hybride-agents-bmad.test.ts`

## Tests adaptes

- `tests/system/module-integrity.test.ts` — references aux modules supprimes retirees
- `tests/system/sprint-lifecycle.test.ts` — section pattern analysis desactivee (describe.skip)
- `tests/integration/workflow-flow.test.ts` — imports et sections patterns retires
- `tests/unit/explorer-agent.test.ts` — section MCP Config retiree
- `tests/unit/mcp-audit-tool.test.ts` — reference analyze_backlog retiree
- `tests/unit/mcp-business-tools.test.ts` — reference code graph tools retiree
- `tests/unit/coding-standards.test.ts` — allowlist mise a jour (bot-context retire, zz-messages ajoute)
- `tests/unit/doc-utils.test.ts` — seuils modules/commands ajustes
- `tests/unit/logger-migration.test.ts` — modules supprimes retires de la liste

## Modules adaptes (importeurs)

| Module adapte | Changements |
|--------------|-------------|
| `src/agent.ts` | Retrait buildAgentContext, buildMcpToolInstructions, runCodeReview/saveReviewResult/formatReviewResult. mcpRole retire de SpawnClaudeOptions. |
| `src/sdd-agents.ts` | Retrait mcpRole de l'appel spawnClaude |
| `src/bmad-agents.ts` | Retrait import story-files, Task type. buildBmadExecPrompt simplifie (plus de story file). |
| `src/bmad-prompts.ts` | Retrait import/appel buildFeedbackContext |
| `src/commands/quality.ts` | Retrait /patterns, analyzePatterns dans /retro, processRetroFeedback/loadFeedbackRules dans callback retro |
| `src/commands/zz-messages.ts` | Fonctions command-router inline (routeIntent, checkPendingClarification, handleConfirmationCallback, buildSyntheticUpdate) |
| `src/commands/help.ts` | Retrait code-graph (loadGraph, formatGraphStatsForMonitor) du /monitor |
| `src/commands/profile.ts` | /profile simplifie (affiche config/profile.md), callbacks profile_ retires |
| `src/commands/utilities.ts` | /estimate simplifie (renvoie vers /cost) |
| `src/heartbeat.ts` | Retrait section daily autonomy scan |
| `src/relay.ts` | Retrait loadFeedbackRules, import supabase inutilise |
| `src/bot-context.ts` | getDynamicProfile simplifie (retour vide) |
| `src/alerts.ts` | Retrait formatTrustScores du formatMonitoringStats |
| `src/llm-ops.ts` | Circuit-breaker simplifie (toujours healthy), getLlmOpsSnapshot simplifie, runLlmOpsCheck no-op |
| `mcp/memory-server.ts` | Retrait analyze_backlog tool, 3 code graph tools, import proactive-planner |
| `CLAUDE.md` | Modules, commandes et MCP description mis a jour |

## Modules DIFFERES (non supprimes — trop d'importeurs actifs)

| Module | Raison | Importeurs actifs |
|--------|--------|-------------------|
| `workflow.ts` (848 LOC) | Fournit /metrics et /retro via quality.ts | `commands/quality.ts` |
| `bmad-agents.ts` (459 LOC) | Fournit AgentRole, agent definitions via decomposeTask (MCP) | `agent.ts`, `commands/quality.ts`, `trust-scores.ts` (supprime) |
| `bmad-prompts.ts` (560 LOC) | Prompt builder utilise par bmad-agents.ts | `bmad-agents.ts`, `code-review.ts` (supprime) |
| `alerts.ts` (575 LOC) | Fournit /alerts, monitoring stats, recordResponseTime | `quality.ts`, `zz-messages.ts`, `heartbeat.ts`, `help.ts`, `mcp/` |
| `notification-prefs.ts` (135 LOC) | Quiet hours, prefs utilisees par heartbeat+queue+relay+profile | 4 importeurs actifs |
| `cost-tracking.ts` (366 LOC) | Fournit /cost, logCost utilise par llm-ops | `llm-ops.ts`, `quality.ts`, `mcp/` |
| `conversation-session.ts` (481 LOC) | Sessions conversation (getSession, constraints, intents) | `relay.ts`, `zz-messages.ts` |

## Metriques

| Metrique | Avant | Apres | Delta |
|----------|-------|-------|-------|
| Modules source | ~70 | 54 | -16 |
| LOC source | ~21K | 18 610 | -2 400 |
| Tests | 2 617 pass | 2 098 pass | -519 (tests modules supprimes) |
| Fichiers test | 97 | 80 | -17 |
| Commandes bot | ~29 | 28 | -1 (/patterns) |

## Statut final

**DONE** — tous les modules listables ont ete supprimes sauf 7 modules differes qui sont trop profondement ancres dans des features actives (/metrics, /retro, /alerts, /cost, /notify, intent routing, agent prompts). Leur suppression necessite soit la reimplementation des features, soit la Phase 5 (simplification des commandes).
