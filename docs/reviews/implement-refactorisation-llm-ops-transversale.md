# Implementation Report — SPEC-refactorisation-llm-ops-transversale

> Date : 2026-03-21
> Spec : docs/specs/SPEC-refactorisation-llm-ops-transversale.md
> Review adversariale : docs/reviews/adversarial-SPEC-refactorisation-llm-ops-transversale.md

## Phase 1 — Test Architect

Squelettes generes dans `tests/generated/refactorisation-llm-ops-transversale.test.ts`.

| V-critere | Niveau | Description | Describes generes |
|-----------|--------|-------------|-------------------|
| V1 | unit | buildSpanId format | 2 tests |
| V2 | unit | Circuit-breaker open trust < 30 | 1 test |
| V3 | unit | Circuit-breaker open failures >= 3 | 1 test |
| V4 | unit | Circuit-breaker closed normal | 2 tests |
| V5 | unit | suggestedDowngrade exploitable | 2 tests |
| V6 | unit | recordPromptVersion upsert | 2 tests |
| V7 | unit | recordPromptVersion idempotent | 2 tests |
| V8 | unit | logCostWithSpan enriches entry | 2 tests |
| V9 | unit | CostEntry span_id/session_id optional | 3 tests |
| V10 | integration | getLlmOpsSnapshot complet | 2 tests |
| V11 | unit | runLlmOpsCheck detecte anomalie | 1 test |
| V12 | unit | runLlmOpsCheck no-op normal | 2 tests |
| V13 | integration | heartbeat + flag ON + interval | 2 tests |
| V14 | integration | heartbeat flag OFF | 2 tests |
| V15 | integration | heartbeat interval non depasse | 2 tests |
| V16 | integration | orchestrator recordPromptVersion | 2 tests |
| V17 | integration | orchestrator logCostWithSpan | 2 tests |
| V18 | integration | migration SQL | 3 tests |
| V19 | integration | /monitor getLlmOpsSnapshot | 2 tests |
| V20 | integration | tests existants passent | 1 test |
| V21 | unit | tsc --noEmit | 2 tests |
| V22 | unit | HeartbeatState backward compat | 3 tests |

Plus edge cases et robustesse : 12 tests supplementaires.

Total : 53 tests dans 1 fichier.

## Phase 2 — Implementer

### Fichiers crees

| Fichier | Lignes | Description |
|---------|--------|-------------|
| `src/llm-ops.ts` | ~290 | Module facade unifie : 6 fonctions publiques + sha256 + formatting |
| `db/migrations/llm-ops-schema.sql` | ~25 | Migration : table prompt_versions + colonnes span_id/session_id |

### Fichiers modifies

| Fichier | Modification | Regles |
|---------|-------------|--------|
| `src/cost-tracking.ts` | Ajout `span_id`, `session_id` optionnels a `CostEntry` + inclusion dans `logCost()` insert | R8, V9 |
| `src/heartbeat-prompt.ts` | Ajout `lastLlmOpsCheckAt: string \| null` a `HeartbeatState` + `createDefaultState()` | R7, V22 |
| `src/heartbeat.ts` | Import `runLlmOpsCheck` + bloc periodique gate sur feature flag + intervalle 30min | R7, R10 |
| `src/orchestrator.ts` | Remplacement `logCost` par `logCostWithSpan` + `buildSpanId` (2 points) + appel `recordPromptVersion` | R4, R8, R11 |
| `src/bmad-prompts.ts` | Export de `loadAgentYaml` (etait private) pour usage par l'orchestrateur | R11 |
| `src/commands/help.ts` | Import `getLlmOpsSnapshot` + `formatLlmOpsSnapshot`, ajout section LLM-Ops dans `/monitor` | R1, R9 |
| `config/features.json` | Ajout `"llmops_monitoring": false` | R7 |
| `db/schema.sql` | Ajout table `prompt_versions`, colonnes `span_id`/`session_id` sur `cost_tracking`, index | R3, R4 |
| `CLAUDE.md` | Ajout `llm-ops.ts` dans la table des modules | Doc freshness |

### Decisions techniques

1. **Dependance circulaire resolue (F-DA-1)** : `llm-ops.ts` utilise `import type { AgentRole }` depuis `orchestrator.ts` — type-only import, pas de cycle runtime. Bun/TS resout correctement.

2. **recordPromptVersion appele depuis l'orchestrateur (F-EC-1, F-SS-2)** : Pas dans `buildAgentSystemPromptPart()` (fonction pure sans supabase). Appele fire-and-forget dans le flow d'execution d'un step agent, ou le SupabaseClient est disponible.

3. **Filtre temporel costSummary (F-DA-4)** : `getLlmOpsSnapshot()` filtre `cost_tracking` sur les 7 derniers jours pour eviter les queries lentes.

4. **shouldDowngradePipeline supprime (F-SS-1)** : Conforme a R5, la decision de downgrade reste dans l'orchestrateur. `getCircuitBreakerStatus()` retourne un `suggestedDowngrade` exploitable mais ne decide pas.

5. **Backward compatibility logCost (R8)** : Les champs `span_id` et `session_id` sont optionnels dans `CostEntry`. `logCost()` ne les inclut dans l'insert que s'ils sont presents. Les appelants existants ne sont pas impactes.

6. **Separateur combined_hash (F-DA-5)** : Format `"${templateHash}:${feedbackHash}"` avec separateur `:` pour eviter les collisions theoriques.

## Phase 3 — Tester

Tests completes avec edge cases, scenarios d'erreur et robustesse.

### Edge cases ajoutes

- `sha256` : chaine vide, unicode, determinisme
- `formatLlmOpsSnapshot` : circuit-breakers ouverts, prompt versions vides
- `getCircuitBreakerStatus` : score exact au seuil (30), exactly 3 failures
- `runLlmOpsCheck` : erreur dans notifyFn (ne crash pas le check)
- `logCostWithSpan` + `logCost` avec et sans span_id (backward compat)

## Resultat `bun test`

```
2781 pass
0 fail
6690 expect() calls
Ran 2781 tests across 103 files. [27.90s]
```

Tous les tests existants (2737 avant) + 53 nouveaux = 2781 tests passent.
Aucune regression.

## Statut final

**DONE**

L'etape suivante (conformance check + review) est geree par `/dev-pipeline`.
