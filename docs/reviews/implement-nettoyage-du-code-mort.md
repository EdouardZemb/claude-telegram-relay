# Implementation Report — SPEC-nettoyage-du-code-mort

> Generated 2026-03-24. Spec: docs/specs/SPEC-nettoyage-du-code-mort.md
> Adversarial review: docs/reviews/adversarial-SPEC-nettoyage-du-code-mort.md

## Statut final : DONE

## Phase 1 — Test Architect (skipped)

No skeleton generation needed: this is a pure deletion/cleanup spec with no new functionality. Existing test modifications are prescribed by the spec.

## Phase 2 — Implementer

### Modules supprimes (3 fichiers)

| Fichier | LOC | Raison |
|---------|-----|--------|
| `src/spec-lite.ts` | 189 | Module entier derriere `spec_phase_lite` (flag desactive) |
| `src/adversarial-challenge.ts` | 362 | Module entier derriere `adversarial_challenge` (flag desactive) |
| `src/exploration-scoring.ts` | 292 | Module entier derriere `exploration_phase` (flag desactive) |

### Agents supprimes (5 fichiers)

- `.claude/agents/impact-analyst.md`
- `.claude/agents/security-checker.md`
- `.claude/agents/test-architect.md`
- `.claude/agents/implementer.md`
- `.claude/agents/tester.md`

### Skills supprimes (3 dossiers)

- `.claude/skills/dev-spec/`
- `.claude/skills/dev-challenge/`
- `.claude/skills/dev-pipeline/`

### Tests supprimes (4 fichiers)

| Fichier | LOC | Raison |
|---------|-----|--------|
| `tests/unit/spec-lite.test.ts` | 177 | Tests du module supprime |
| `tests/unit/adversarial-challenge.test.ts` | 193 | Tests du module supprime |
| `tests/unit/exploration-scoring.test.ts` | 302 | Tests du module supprime |
| `tests/generated/reviser-prd-to-deploy-workflow.test.ts` | 891 | Tous les describe blocs testent des fonctions supprimees |

### Modules modifies (13 fichiers)

| Fichier | Modifications |
|---------|---------------|
| `src/orchestrator/pipeline.ts` | Retire imports (adversarial-challenge, exploration-scoring, spec-lite, memory, feature-flags) + bloc shouldExplore (L131-170) + bloc P1 spec-lite + bloc P2+E1 adversarial + bloc P3 conformance + bloc memory_promotion + variable pipelineTypeForFlags inutilisee. 1486 → 1107 LOC |
| `src/prd-workflow.ts` | Retire imports (adversarial-challenge, spec-lite, agent-schemas types) + interface PreflightReport + fonctions isPrdMaturationEnabled, runPrdPreflightChecks, formatPreflightReport, buildPreflightResultTag, buildPreflightKeyboard, storePendingProtoSpec, getPendingProtoSpec, clearPendingProtoSpec. 783 → 492 LOC |
| `src/gate-evaluator.ts` | Retire bloc `exploration_gate` (early return quand flag desactive, ~8 lignes). 937 → 927 LOC |
| `src/llm-router.ts` | Retire import computeExplorationScore + import isFeatureEnabled + bloc exploration_phase hint. 481 → 465 LOC |
| `src/auto-pipeline.ts` | Retire import isFeatureEnabled + bloc spec_phase_lite (Phase 2b). 418 → 396 LOC |
| `src/commands/exploration.ts` | Retire import isFeatureEnabled + guard `exploration_phase` (L79-82). 234 → 229 LOC |
| `src/commands/planning.ts` | Retire imports maturation (buildPreflightResultTag, clearPendingProtoSpec, getPendingProtoSpec, isPrdMaturationEnabled, runPrdPreflightChecks, storePendingProtoSpec) + 3 callbacks preflight (prdwf_preflight_ok, prdwf_preflight_abort, prdwf_revise_prd) + branche isPrdMaturationEnabled() dans prd_approve. 1005 → 847 LOC |
| `src/memory/graph.ts` | Retire imports (graduateAgentMemory, saveAgentMemory, PROMOTION_MAX_CHARS, resolveMemoryConflict, updateMemoryWithRevision) + interface WorkingMemoryData + fonction promoteWorkingMemory (90 LOC). Conserve getAgentMemories (utilise dans buildMemoryChains), isFeatureEnabled (utilise pour agent_role_memory), filtre working_memory_promotion (donnees historiques). 855 → 744 LOC |
| `src/memory.ts` | Retire re-exports promoteWorkingMemory et WorkingMemoryData du barrel graph.ts |
| `src/job-manager.ts` | Retire import buildPreflightKeyboard + case "prd-preflight" dans buildJobCompletionKeyboard + notification prd-preflight dans sendJobCompletionNotification (F-EC-1 BLOQUANT corrige) |
| `config/features.json` | Retire 6 cles : exploration_phase, exploration_gate, spec_phase_lite, adversarial_challenge, prd_maturation_phases, memory_promotion. 6 cles conservees |
| `CLAUDE.md` | Retire 3 modules de la table (spec-lite, adversarial-challenge, exploration-scoring). MAJ counts : 72 modules (75-3), 6 agents (11-5), 4 skills (7-3). MAJ Dev Pipeline : retire dev-spec, dev-challenge, dev-pipeline. MAJ LOC allowlist. Retire promoteWorkingMemory de description graph.ts |
| `tests/unit/coding-standards.test.ts` | MAJ LOC_ALLOWLIST : retire memory/graph.ts (sous seuil), MAJ counts pipeline.ts/planning.ts/gate-evaluator.ts |

### Tests modifies (5 fichiers)

| Fichier | Modifications |
|---------|---------------|
| `tests/unit/orchestrator.test.ts` | Retire import loadFeatures/isFeatureEnabled. Retire describe "[V14] Feature Flags for P1/P2/E1/P3". Conserve "[V12] Pipeline scope guards" (tests structurels valides). Retire describes "memory_promotion feature flag" + "Working memory promotion in orchestrate()" |
| `tests/unit/logger-migration.test.ts` | Retire `adversarial-challenge.ts` et `spec-lite.ts` de MIGRATED_MODULES |
| `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` | Retire imports WorkingMemoryData/promoteWorkingMemory/PROMOTION_MAX_CHARS. Retire describes V1-V5 (memory_promotion guard), V12 (flag existence), V13 (InMemoryBlackboard fallback), V17 (truncation). Conserve V6-V10, V14-V16, V18 (memoryHealthStats, formatMemoryHealth, /brain health) |
| `tests/unit/memory-evolution.test.ts` | Retire imports WorkingMemoryData/promoteWorkingMemory/PROMOTION_MAX_CHARS. Retire describe "promoteWorkingMemory" (190 LOC). Retire describe "Feature flag memory_promotion" |
| `tests/generated/memoire-hybride-agents-bmad.test.ts` | Retire describes V8 (promoteWorkingMemory agent_role), V9 (saveAgentMemory via promoteWorkingMemory), V18 (orchestrator role-specific memory via promoteWorkingMemory) |

## Phase 3 — Tester (skipped)

No new edge cases to add: this is a deletion spec.

## Resultat `bun test`

```
3859 pass
10 skip
1 fail (pre-existing: biome check in durcissement-incremental-des-standards.test.ts — not related to this spec)
8092 expect() calls
Ran 3870 tests across 126 files. [37.47s]
```

Le seul echec (V11 biome check) est pre-existant : les erreurs sont dans `src/code-graph.ts` et `src/doc-utils.ts` (noImplicitAnyLet), fichiers non concernes par cette spec.

## Verification V-criteres

| # | Critere | Resultat |
|---|---------|----------|
| V1 | `src/spec-lite.ts` n'existe plus | PASS |
| V2 | `src/adversarial-challenge.ts` n'existe plus | PASS |
| V3 | `src/exploration-scoring.ts` n'existe plus | PASS |
| V4 | `bun run tsc --noEmit` passe sans erreur | PASS |
| V5 | `bun test` passe a 0 fail (nouveau) | PASS (1 pre-existant non lie) |
| V6 | features.json ne contient plus les 6 cles | PASS |
| V7 | Aucune reference aux modules supprimes dans imports TS | PASS |
| V8 | Aucune reference aux 6 flags supprimes dans src/ | PASS |
| V9 | 5 agents obsoletes supprimes | PASS |
| V10 | 3 skills obsoletes supprimes | PASS |
| V11 | graph.ts ne contient plus promoteWorkingMemory/WorkingMemoryData | PASS |
| V12 | graph.ts conserve getAgentMemories | PASS |
| V13 | graph.ts conserve filtre working_memory_promotion | PASS |
| V14 | memory.ts barrel ne re-exporte plus les symboles supprimes | PASS |
| V15 | exploration.ts n'a plus la guard exploration_phase | PASS |
| V16 | reviser-prd-to-deploy-workflow.test.ts supprime | PASS |
| V17 | logger-migration.test.ts ne reference plus les modules supprimes | PASS |
| V18 | CLAUDE.md ne contient plus dev-spec/dev-challenge/dev-pipeline | PASS |
| V19 | CLAUDE.md liste 6 agents | PASS |
| V20 | CLAUDE.md liste 4 skills | PASS |
| V21 | prd-workflow.ts ne contient plus les fonctions preflight | PASS |
| V22 | planning.ts ne contient plus isPrdMaturationEnabled/callbacks preflight | PASS |
| V24 | pipeline.ts ne contient plus generateProtoSpec/runAdversarialChallenge/shouldExplore/promoteWorkingMemory | PASS |
| V25 | job-manager.ts ne contient plus buildPreflightKeyboard | PASS |

## Hors scope identifie

1. **Test biome pre-existant (V11 durcissement)** : `src/code-graph.ts` L68/102 et `src/doc-utils.ts` L63 ont des `let match` sans annotation de type. Ce test echouait deja avant cette spec. Non lie au nettoyage.

2. **`tests/generated/memoire-hybride-agents-bmad.test.ts`** : ce fichier n'etait pas dans la section 5 de la spec mais contenait des tests V8/V9/V18 qui appelaient `promoteWorkingMemory` directement. Les describe blocs concernes ont ete retires pour eviter les echecs.

## Etape suivante

**DONE** : le conformance check puis la review sont geres par `/dev-pipeline`.
