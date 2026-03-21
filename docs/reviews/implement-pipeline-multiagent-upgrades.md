# Implementation Report — SPEC-pipeline-multiagent-upgrades

> Date : 2026-03-20
> Spec : docs/specs/SPEC-pipeline-multiagent-upgrades.md
> Review adversariale : docs/reviews/adversarial-SPEC-pipeline-multiagent-upgrades.md

## Statut final : DONE

## Resume

Implementation des 5 ameliorations P1-P5 du pipeline multi-agent : parallelisme intra-phase (overlap), context refresh mid-pipeline, DLQ cognitive, seuil adaptatif LIGHT/DEFAULT, et observabilite cross-agent (correlation_id).

## Phase 1 — Test Architect

Squelettes generes dans `tests/generated/pipeline-multiagent-upgrades.test.ts` couvrant les 22 V-criteres de la spec.

| Fichier test | V-criteres | Niveau | Tests prevus |
|--------------|-----------|--------|--------------|
| tests/generated/pipeline-multiagent-upgrades.test.ts | V1-V24 | unit + integration | 36 tests |

## Phase 2 — Implementer

### Fichiers modifies

| Fichier | Lignes changees | Raison |
|---------|----------------|--------|
| `src/llm-router.ts` | 1 | P4: seuil `scoreToPipeline()` 0.6 -> 0.7 |
| `src/pipeline-selection.ts` | +36 | P4: `BREAKING_KEYWORDS` constant, `hasBreakingKeywords()` helper, overrides R10/R11 dans `selectAdaptivePipeline()` |
| `src/agent-events.ts` | +68 | P3: type `failure_captured`, `FailureContext` interface, `captureAgentFailure()`. P5: `getTracingTimeline` alias |
| `src/orchestrator.ts` | +246 | P1: overlap logic (effectiveOverlap, overlapThreshold, Promise.allSettled block). P2: refreshContext mid-pipeline. P3: captureAgentFailure call after retry exhaust. P5: pipeline_session_id dans logCost metadata. Options overlap/refreshContext dans OrchestrateOptions |
| `tests/unit/llm-router.test.ts` | +3/-8 | P4: tests mis a jour pour seuil 0.7 |
| `tests/unit/adaptive-pipeline.test.ts` | +8/-4 | P4: tests mis a jour pour seuil 0.7 |

### Fichier cree

| Fichier | Lignes | Description |
|---------|--------|-------------|
| `tests/generated/pipeline-multiagent-upgrades.test.ts` | 595 | 36 tests couvrant tous les V-criteres |

### Details par amelioration

**P1 — Parallelisme intra-phase (overlap)**
- Nouvelle option `overlap?: boolean` dans `OrchestrateOptions`
- R1c: overlap incompatible avec useBlackboard, fallback sequentiel avec `console.warn`
- R1: les 2 derniers agents du pipeline s'executent via `Promise.allSettled()`
- R1b: si un agent echoue et stopOnFailure, les deux resultats sont conserves
- R1d: previousMessages fige au moment du fork (snapshot)
- Support du retry loop, DLQ, logCost, checkpoint, et event emission pour les agents overlap

**P2 — Context refresh mid-pipeline**
- Nouvelle option `refreshContext?: boolean` dans `OrchestrateOptions`
- R4/R5: `buildAgentContext()` complet re-appele avant chaque agent (sauf le 1er)
- R6: si `buildAgentContext()` retourne `""`, le cache existant est conserve
- Fonctionne aussi pour les agents en mode overlap

**P3 — Agent DLQ (Dead Letter Queue cognitive)**
- Nouveau type `failure_captured` dans `AgentEventType`
- Nouvelle interface `FailureContext` et fonction `captureAgentFailure()`
- R7: payload contient prompt_snippet (500 chars), partial_output (2000 chars), error, tokens_input, tokens_output, duration_ms
- R8: fire-and-forget avec fallback in-memory, jamais bloquant
- Appele dans orchestrate() apres epuisement des retries (sequentiel et overlap)

**P4 — Seuil adaptatif LIGHT vs DEFAULT**
- R9: seuil `scoreToPipeline()` passe de `<= 0.6` a `<= 0.7`
- R10: `selectAdaptivePipeline()` force DEFAULT quand `affectedModules.length > 5`
- R11: `selectAdaptivePipeline()` force DEFAULT quand breaking keywords detectes
- Overrides appliques APRES le switch sur `difficulty.pipeline` (post-switch, conforme a F-DA-1)
- `BREAKING_KEYWORDS` exporte pour testabilite
- `hasBreakingKeywords()` helper exporte

**P5 — Observabilite cross-agent (correlation_id)**
- R12: `pipelineSessionId` propage dans chaque appel `logCost()` via `metadata: { pipeline_session_id }`
- R13: `getTracingTimeline` est un export alias de `getAgentEvents` dans agent-events.ts
- R14: aucun changement structurel (session_id deja utilise correctement)

## Phase 3 — Tester

Tests completes avec edge cases, scenarios d'erreur et robustesse :

- Truncation prompt_snippet/partial_output
- Supabase qui throw (non-bloquant)
- Supabase null (fallback in-memory)
- Champs vides dans FailureContext
- Gros token counts
- Breaking keywords (positifs et negatifs)
- Overlap threshold calculations pour pipelines de 1, 2, 3 et 5 agents
- Promise.allSettled preserving both success and failure results
- Boundary values pour scoreToPipeline

## Resultat bun test

```
2728 pass
0 fail
6553 expect() calls
Ran 2728 tests across 102 files. [37.43s]
```

Tests avant implementation : 2692 pass
Tests apres implementation : 2728 pass (+36 nouveaux tests)
Tests existants casses et corriges : 2 (seuil 0.6 -> 0.7 dans llm-router.test.ts et adaptive-pipeline.test.ts)

## V-criteres couverts

| V-critere | Statut | Test |
|-----------|--------|------|
| V1 | OK | scoreToPipeline(0.65) == LIGHT |
| V2 | OK | scoreToPipeline(0.71) == DEFAULT |
| V3 | OK | scoreToPipeline(0.3) == LIGHT |
| V4 | OK | scoreToPipeline(0.7) == LIGHT |
| V5 | OK | selectAdaptivePipeline force DEFAULT pour 6 modules |
| V6 | OK | selectAdaptivePipeline force DEFAULT pour breaking keywords |
| V7 | OK | selectAdaptivePipeline retourne LIGHT pour 3 modules |
| V8 | OK | failure_captured est un type valide |
| V9 | OK | captureAgentFailure insere avec payload complet |
| V10 | OK | captureAgentFailure ne propage pas les erreurs |
| V11 | OK | captureAgentFailure fallback in-memory |
| V12 | Couvert via V13/logique | refreshContext pattern teste |
| V13 | OK | Cache preserve quand refresh retourne "" |
| V14 | Couvert via V24 | Defaut sequentiel sans refresh |
| V17 | OK | metadata.pipeline_session_id dans CostEntry |
| V18 | OK | getTracingTimeline === getAgentEvents |
| V19 | OK | overlap + blackboard = fallback sequentiel |
| V20 | OK | overlap threshold pour 3+ agents |
| V21 | OK | Promise.allSettled preserve les deux resultats |
| V22 | OK | overlap threshold pour 2 agents |
| V23 | OK | overlap avec 1 agent = pas de changement |
| V24 | OK | defaut = tout sequentiel |

## Etape suivante

**DONE** : le conformance check puis la review sont geres par `/dev-pipeline`.
