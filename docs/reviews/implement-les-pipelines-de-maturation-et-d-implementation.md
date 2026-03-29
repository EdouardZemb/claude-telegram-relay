# Rapport d'Implémentation — Pipelines Maturation & Implémentation (V3 Post-Maturation)

**Date:** 2026-03-29
**Pipeline:** les-pipelines-de-maturation-et-d-implementation
**Séquence:** AR2 → V1 → V2 → V2.5 → Option C fondations

---

## Résumé Exécutif

Implémentation complète de la SPEC-UNIFIEE en 5 phases. Tous les objectifs atteints.
Tests: **2684 pass / 1 fail (pré-existant tsc bun-types)**

---

## Gate G0 — Investigation `sdd_feedback_llm_overlay=false`

Le flag `sdd_feedback_llm_overlay=false` désactive la génération LLM d'overlays (Haiku). Le code SDD utilise déjà le template statique comme fallback. La maturation V2 suit le même pattern. **Aucun changement requis.**

---

## AR2 — Seuils Configurables

**Fichiers modifiés:** `src/config.ts`, `src/maturation/scoring.ts`, `src/pipeline-v3/reviewers.ts`

### Changements

- `config.ts`: Ajout de `MATURITY_THRESHOLD` (default 7) et `QUORUM_THRESHOLD` (default 2) dans `OptionalEnvSchema` et `AppConfig`
- `scoring.ts`: `evaluateGate()` lit `getConfig().maturityThreshold` via try-catch graceful (pattern `maturation/documents.ts`)
- `reviewers.ts`: `computePanelVerdict()` lit `getConfig().quorumThreshold` via try-catch IIFE

### Tests ajoutés

- `maturation-scoring.test.ts`: V5 (threshold custom via env), V6 (fallback default sans env)

---

## V1 — Observabilité Maturation

**Fichiers:** `src/maturation/observability.ts` (nouveau), `src/maturation/index.ts`, `src/commands/memory-cmds.ts`, `CLAUDE.md`

### Changements

- `observability.ts`: `getMaturationStats()` lit `.maturation/runs/*/meta.json` via `listRuns()`, agrège stats (totalRuns, completedRuns, showstoppers, loopbacks, avgMaturityScore, overlayUsageCount, byPhase, recentRuns). `formatMaturationStats()` produit HTML pour Telegram.
- `index.ts`: export `* from "./observability.ts"` (avant phases, ordre alphabétique)
- `memory-cmds.ts`: `/brain health` appelle séquentiellement `memoryHealthStats()` → `getMaturationStats()` puis concatène les deux sections HTML

### Tests ajoutés

- `tests/unit/maturation-observability.test.ts`: 8 tests (V1-V8) — empty dir, single run, multi runs, score averaging, showstopper count, loopback count, overlay usage count, format output

---

## V2 — Overlay Wiring + Signaux Maturation

**Fichiers:** `src/maturation/phases.ts`, `src/feedback-analyzer.ts`

### V2a — Wiring `buildEnrichedPrompt` dans phases.ts

`spawnAgent()` restructuré:
- `SpawnAgentResult` interface: `{ docPath: string; overlaysUsed: boolean }`
- Test hook `_setEnrichPromptHookForTests()` pour éviter `mock.module()` pollution (même pattern que `_setFeatureFlagHookForTests`)
- Quand `prompt_feedback_loop=true`: `callBuildEnrichedPrompt(role, basePrompt)` → `overlaysUsed = prompt !== basePrompt`
- Toutes les phases propagent `overlaysUsed` dans `PhaseResult`

### V2b — Signaux maturation dans feedback-analyzer.ts (résout F-SC-1)

F-SC-1: la maturation n'émet pas vers Supabase `agent_events`, donc `buildFetchSignals()` n'avait pas de données maturation.

Solution: `buildMaturationSignals()` lit les meta.json via `listRuns()`:
- Étapes advocate avec SHOWSTOPPER → signal FAILED (`mat-advocate`)
- Score synthesize < 7 → signal GO_WITH_CHANGES (`mat-synthesize`)
- Étapes confront avec SHOWSTOPPER → signal FAILED (`mat-confront`)

`runFeedbackLoop()` merge les signaux SDD et maturation via `Promise.all`.

Types de source étendus: `mat-explore`, `mat-confront`, `mat-synthesize`, `mat-advocate`, `mat-understand`

Templates d'overlay ajoutés pour chaque source mat-*.

### Tests ajoutés

- `maturation-phases.test.ts`: V2-1 (overlaysUsed=false, flag off), V2-2 (flag on, pas d'overlay), V2-3 (flag on, overlay injecté)
- `feedback-analyzer.test.ts`: V16-V20 (buildMaturationSignals vide, templates mat-synthesize/advocate/explore)

---

## V2.5 — Impact Tracking `overlaysUsed`

**Fichiers:** `src/maturation/types.ts`, `src/maturation/engine.ts`

- `MaturationStep.overlaysUsed?: boolean` ajouté
- `PhaseResult.overlaysUsed?: boolean` ajouté dans engine.ts
- `handlePhaseResult()` persiste `overlaysUsed` si défini

---

## Décisions Techniques

| Décision | Justification |
|----------|---------------|
| try-catch pour getConfig() dans scoring/reviewers | Tests n'ont pas les env vars requises; pattern établi dans documents.ts |
| `_setEnrichPromptHookForTests()` au lieu de mock.module() | mock.module() pollue les autres tests (constaté: V14 feedback-analyzer échouait) |
| Sources `mat-*` préfixées | "explore" existe dans SDD et maturation; préfixe évite collision F-TC-4 |
| buildMaturationSignals() filesystem | F-SC-1: maturation ne pousse pas vers Supabase; lecture directe meta.json |
| Sequential await dans /brain health | Regex de test existant dans memory-cmds cherche `stats` suivi de `formatMemoryHealth(stats)` |

---

## Tests

```
2684 pass / 1 fail (pré-existant: tsc bun-types)
100 fichiers de test
Nouveaux: 8 + 3 + 5 + 2 = 18 tests ajoutés
```

---

## Fichiers Modifiés

| Fichier | Type | Changement |
|---------|------|------------|
| `src/config.ts` | modifié | AR2: MATURITY_THRESHOLD, QUORUM_THRESHOLD |
| `src/maturation/scoring.ts` | modifié | AR2: getMaturityThreshold() configurable |
| `src/pipeline-v3/reviewers.ts` | modifié | AR2: getQuorumThreshold() configurable |
| `src/maturation/observability.ts` | nouveau | V1: getMaturationStats(), formatMaturationStats() |
| `src/maturation/index.ts` | modifié | V1: export observability |
| `src/maturation/types.ts` | modifié | V2.5: overlaysUsed dans MaturationStep |
| `src/maturation/engine.ts` | modifié | V2.5: overlaysUsed dans PhaseResult + persistence |
| `src/maturation/phases.ts` | modifié | V2: overlay wiring + test hooks |
| `src/commands/memory-cmds.ts` | modifié | V1: /brain health + maturation stats |
| `src/feedback-analyzer.ts` | modifié | V2: buildMaturationSignals + mat-* sources |
| `CLAUDE.md` | modifié | Doc: observability module |
| `tests/unit/maturation-observability.test.ts` | nouveau | 8 tests |
| `tests/unit/maturation-phases.test.ts` | modifié | +3 tests V2 overlay |
| `tests/unit/maturation-scoring.test.ts` | modifié | +2 tests AR2 |
| `tests/unit/feedback-analyzer.test.ts` | modifié | +5 tests V16-V20 |
