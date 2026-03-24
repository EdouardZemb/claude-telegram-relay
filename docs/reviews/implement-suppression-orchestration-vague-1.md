# Implementation Report — SPEC-suppression-orchestration-vague-1

> Spec : `docs/specs/SPEC-suppression-orchestration-vague-1.md`
> Review adversariale : `docs/reviews/adversarial-SPEC-suppression-orchestration-vague-1.md`
> Date : 2026-03-24

## Resume

Suppression de l'orchestration TypeScript (vague 1) : les deux Composers `execution.ts` et `planning.ts` et tous les modules feuilles en cascade. Corrections critiques du challenge adversarial appliquees (F-DA-1, F-DA-2, F-DA-3).

## Corrections adversariales appliquees

| Finding | Resolution |
|---------|-----------|
| F-DA-1 (BLOQUANT) : AgentRole importe par 4 modules actifs | Type `AgentRole` deplace dans `src/bmad-agents.ts`. Imports mis a jour dans `feedback-loop.ts`, `agent-context.ts`, `mcp-config.ts`, `bmad-prompts.ts` |
| F-DA-2 (BLOQUANT) : prd-workflow.ts doit etre supprime | `prd-workflow.ts` supprime (zero importeur apres adaptation de `zz-messages.ts`) |
| F-DA-3 (BLOQUANT) : gate-persistence.ts manquait | `gate-persistence.ts` ajoute a la liste des suppressions |
| F-DA-5 (MAJEUR) : conversation-session.ts utilise par zz-messages | Seul `PendingProposal` et le code de proposal routing retires. Les imports `getSession`, `addConstraint`, etc. conserves |
| F-EC-2 (MAJEUR) : agent-messaging et agent-events deviennent code mort | Les deux modules supprimes (zero importeur apres adaptation de help.ts et suppression de orchestrator/pipeline.ts) |
| F-DA-4 (MAJEUR) : tests prd-workflow non analyses | Tous les tests prd-workflow supprimes (le module est supprime) |
| F-DA-8 (MINEUR) : logger-migration.test.ts reference gate-persistence | References supprimees du test |
| F-EC-3 (MAJEUR) : sdd-agents.test.ts reference gate-persistence | gate-persistence retire de la liste des modules interdits |

## Fichiers supprimes (src/) — 21 modules, ~11 000 LOC

| Fichier | LOC |
|---------|-----|
| `src/commands/execution.ts` | 648 |
| `src/commands/planning.ts` | 847 |
| `src/orchestrator.ts` (barrel) | 41 |
| `src/orchestrator/types.ts` | 95 |
| `src/orchestrator/agent-step.ts` | 262 |
| `src/orchestrator/pipeline.ts` | 1 096 |
| `src/orchestrator/format.ts` | 188 |
| `src/blackboard.ts` | 653 |
| `src/deliberation.ts` | 150 |
| `src/adversarial-verifier.ts` | 342 |
| `src/pipeline-selection.ts` | 310 |
| `src/pipeline-state.ts` | 258 |
| `src/llm-router.ts` | 465 |
| `src/agent-schemas.ts` | 1 091 |
| `src/gate-evaluator.ts` | 927 |
| `src/auto-pipeline.ts` | 393 |
| `src/gate-persistence.ts` | 222 |
| `src/prd-workflow.ts` | ~500 |
| `src/prd.ts` | ~350 |
| `src/agent-events.ts` | ~250 |
| `src/agent-messaging.ts` | ~300 |

## Fichiers supprimes (tests/) — 30 fichiers, ~5 000 LOC

- `tests/unit/command-validators.test.ts`
- `tests/unit/orchestrator.test.ts`
- `tests/unit/orchestrator-deliberation.test.ts`
- `tests/unit/gate-evaluator.test.ts`
- `tests/unit/gate-persistence.test.ts`
- `tests/unit/rubric-scoring.test.ts`
- `tests/unit/dual-verification.test.ts`
- `tests/unit/deliberation.test.ts`
- `tests/unit/adversarial-verifier.test.ts`
- `tests/unit/agent-schemas.test.ts`
- `tests/unit/parallel-blackboard.test.ts`
- `tests/unit/pipeline-selection.test.ts`
- `tests/unit/pipeline-state.test.ts`
- `tests/unit/llm-router.test.ts`
- `tests/unit/auto-pipeline.test.ts`
- `tests/unit/batch-parallel.test.ts`
- `tests/unit/adaptive-pipeline.test.ts`
- `tests/unit/s38-integration.test.ts`
- `tests/unit/tavily-research.test.ts`
- `tests/unit/trust-integration.test.ts`
- `tests/unit/prd-workflow.test.ts`
- `tests/unit/prd-workflow-comprehensive.test.ts`
- `tests/unit/prd-workflow-e2e-junctions.test.ts`
- `tests/unit/prd-workflow-integration.test.ts`
- `tests/unit/prd.test.ts`
- `tests/unit/agent-events.test.ts`
- `tests/unit/agent-messaging.test.ts`
- `tests/integration/mcp-blackboard.test.ts`
- `tests/generated/durcissement-standards-vague-2.test.ts`
- `tests/generated/durcissement-standards-vague-4.test.ts`
- `tests/generated/pipeline-multiagent-upgrades.test.ts`
- `tests/generated/refactorisation-llm-ops-transversale.test.ts`
- `tests/generated/sante-systeme-memoire-permanente-multi.test.ts`

## Fichiers modifies (adaptes) — 20 fichiers

| Fichier | Modification |
|---------|-------------|
| `src/bmad-agents.ts` | Ajout du type `AgentRole` (migration depuis orchestrator/types.ts) |
| `src/feedback-loop.ts` | Import AgentRole depuis bmad-agents.ts |
| `src/agent-context.ts` | Import AgentRole depuis bmad-agents.ts |
| `src/mcp-config.ts` | Import AgentRole depuis bmad-agents.ts |
| `src/bmad-prompts.ts` | Import dynamique AgentRole depuis bmad-agents.ts |
| `src/commands/help.ts` | Retrait imports gate-persistence, agent-events, agent-messaging, bmad-agents, conversation-session, trust-scores, feedback-loop. Simplification /help, /workflow, /monitor. Retrait /agents |
| `src/commands/zz-messages.ts` | Retrait imports prd, prd-workflow. Retrait proposal routing, PRD workflow intercepts |
| `src/commands/jobs.ts` | Retrait import prd.ts, auto-pipeline dynamic import. Retrait jc_prd et jc_batch_retry handlers |
| `src/action-registry.ts` | Retrait 8 entrees (exec, orchestrate, autopipeline, plan, prd, prd_workflow, planify) |
| `src/intent-detection.ts` | Retrait patterns plan_task, execute_task, resume_pipeline, view_prd, create_prd, suggest_prd |
| `mcp/memory-server.ts` | Retrait imports orchestrator, prd, story-files, cost-estimate, pipeline-selection. Retrait outils prd_create/list/get/approve/reject, get_estimate, orchestrate_task, PIPELINE_MAP |
| `CLAUDE.md` | Retrait modules supprimes des tables Source Modules et Telegram Commands |
| `tests/unit/action-registry.test.ts` | Retrait assertions exec/orchestrate/autopipeline/plan/prd |
| `tests/unit/intent-detection.test.ts` | Retrait tests plan/exec/orchestrate/prd/resume_pipeline |
| `tests/unit/coding-standards.test.ts` | Retrait references aux fichiers supprimes dans LOC allowlist et env vars |
| `tests/unit/loader.test.ts` | Mise a jour du count (14 → 12 composers) |
| `tests/unit/logger-migration.test.ts` | Retrait references gate-persistence.ts et commands/execution.ts |
| `tests/unit/mcp-orchestration-tools.test.ts` | Retrait tests get_estimate, orchestrate_task, update tool count (28 → 21) |
| `tests/unit/mcp-business-tools.test.ts` | Retrait describe PRD Tools et tests background job prd_create/orchestrate_task |
| `tests/unit/mcp-audit-tool.test.ts` | Retrait assertion orchestrate_task placement |
| `tests/unit/command-router.test.ts` | Retrait tests exec, orchestrate, resume_pipeline |
| `tests/unit/jobs-command.test.ts` | Retrait tests backgroundEligible pour exec/orchestrate/autopipeline/plan/prd/planify |
| `tests/unit/code-graph.test.ts` | Remplacement references orchestrator par bot-context |
| `tests/unit/sdd-agents.test.ts` | Retrait gate-persistence de la liste des modules interdits |
| `tests/system/module-integrity.test.ts` | Retrait tests import orchestrator et prd |
| `tests/e2e/e2e.test.ts` | Retrait test /agents |

## Modules conserves (scope guard)

Les modules suivants n'ont PAS ete supprimes car ils ont encore des importeurs actifs :

| Module | Importeurs actifs |
|--------|------------------|
| `story-files.ts` | bmad-agents.ts → agent.ts, quality.ts, help.ts |
| `workflow.ts` | patterns.ts, quality.ts |
| `feedback-loop.ts` | relay.ts, quality.ts |
| `conversation-session.ts` | relay.ts, zz-messages.ts |
| `command-router.ts` | zz-messages.ts |
| `trust-scores.ts` | agent-context.ts |
| `cost-estimate.ts` | utilities.ts |
| `code-review.ts` | sdd-agents.ts |

## Resultats

- **`bunx tsc --noEmit`** : 0 erreurs
- **`bun test`** : 2557 pass, 1 skip, 1 fail pre-existant (biome check exploration.ts — pas introduit par cette vague)
- **LOC supprimes** : ~24 236 lignes (source + tests + generated)
- **82 fichiers changes** : 318 insertions, 24 236 suppressions

## Statut : DONE

Prochaine etape : `/dev-review` puis `/dev-doc` pour mise a jour documentation.
