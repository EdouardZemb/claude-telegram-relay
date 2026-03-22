# Rapport d'implementation — SPEC-reviser-prd-to-deploy-workflow

> Date : 2026-03-21
> Spec : `docs/specs/SPEC-reviser-prd-to-deploy-workflow.md`
> Review adversariale : `docs/reviews/adversarial-SPEC-reviser-prd-to-deploy-workflow.md`

## Synthese

Implementation du preflight PRD-to-Deploy avec phases de maturation (P1 spec-lite, P2 adversarial challenge, E1 impact analysis) avant le lancement de l'implementation batch. Le conformance check (P3) est reporte en V2 conformement a R11.

**Statut : DONE**

## Phase 1 — Test Architect

Squelettes generes dans `tests/generated/reviser-prd-to-deploy-workflow.test.ts`.

| Describe | V-critere | Niveau | Tests prevus |
|----------|-----------|--------|--------------|
| [V1] runPrdPreflightChecks full pipeline | V1 | unit | 4 tests (nominal, per-task calls, adversarial input, impact files) |
| [V2] P1 skipped when spec_phase_lite off | V2 | unit | 3 tests (empty protoSpecs, P2+E1 still runs, R5bis story files) |
| [V3] P2+E1 skipped when adversarial off | V3 | unit | 3 tests (null adversarial/impact, P1 still runs, verdict PASS) |
| [V4] verdict SKIPPED both sub-flags off | V4 | unit | 1 test |
| [V5] verdict PAUSE on BLOQUANT | V5 | unit | 1 test |
| [V5bis] verdict PAUSE on SKIPPED | V5bis | unit | 1 test |
| [V6] formatPreflightReport plain text | V6 | unit | 6 tests |
| [V7] finding filtering by severity | V7 | unit | 5 tests |
| [V8] pendingProtoSpec TTL storage | V8 | unit | 3 tests |
| [V9] prdwf_preflight_ok callback | V9 | integration | 1 skip (needs Composer) |
| [V10] prdwf_preflight_abort | V10 | integration | 1 test + 1 skip |
| [V11] prdwf_revise_prd redirect | V11 | integration | 1 skip |
| [V12] retrocompatibility flag off | V12 | integration | 1 test + 1 skip |
| [V13] prdWorkflowStep accepts spec_preflight | V13 | unit | 2 tests |
| [V14] job-manager 2 buttons | V14 | unit | 1 test |
| [V15] job-manager 3 buttons PAUSE | V15 | unit | 2 tests |
| [V18] prd_maturation_phases flag | V18 | unit | 1 test |
| [V19] launchJob integration | V19 | integration | 1 skip |
| [V20] cleanup after abort | V20 | unit | 1 test |
| buildPreflightResultTag | - | unit | 2 tests |
| buildPreflightKeyboard | - | unit | 3 tests |
| formatPreflightReport edge cases | - | unit | 4 tests |

Resume : 20 V-criteres (V16/V17 reportes V2), 45 tests passants, 5 skips integration.

## Phase 2 — Implementer

### Fichiers modifies

| Fichier | Action | Description |
|---------|--------|-------------|
| `config/features.json` | modifie | Ajout flag `prd_maturation_phases: false` |
| `src/conversation-session.ts` | modifie | Ajout `"spec_preflight"` au type union `prdWorkflowStep` |
| `src/prd-workflow.ts` | modifie | Ajout imports, type `PreflightReport`, fonctions `runPrdPreflightChecks`, `formatPreflightReport`, `buildPreflightResultTag`, `buildPreflightKeyboard`, `storePendingProtoSpec`, `getPendingProtoSpec`, `clearPendingProtoSpec`, `isPrdMaturationEnabled` |
| `src/commands/planning.ts` | modifie | Ajout imports, modification callback `prd_approve` pour preflight conditionnel, ajout callbacks `prdwf_preflight_ok`, `prdwf_preflight_abort`, `prdwf_revise_prd` |
| `src/job-manager.ts` | modifie | Ajout case `prd-preflight` dans `getCompletionKeyboard()` et `sendJobCompletionNotification()` |

### Corrections adversariales integrees

| Finding | Correction |
|---------|------------|
| F-DA-1 (BLOQUANT) | AdversarialInput synthetique : `taskTitle = prd.title`, `taskDescription = prd.content`, `agentOutput = JSON.stringify(protoSpecs)` |
| F-DA-2 (MAJEUR) | `adversarial.verdict === "SKIPPED"` mappe sur `PAUSE` (prudence) |
| F-DA-3 (MAJEUR) | E1 utilise `buildStoryFile(task).impactedFiles` quand P1 est off (R5bis) |
| F-EC-4/F-SS-4 (MAJEUR) | Fonctions reelles `getCompletionKeyboard()` et `sendJobCompletionNotification()` modifiees |
| F-EC-5 (MAJEUR) | StoryFile -> StoryFileInput conversion avec stringify des AcceptanceCriterion objects |
| F-SS-2 (MAJEUR) | Conformance check (P3) reporte V2 conformement a R11 |

### Decisions d'implementation

1. **StoryFile to StoryFileInput conversion** : Les `AcceptanceCriterion` objects sont convertis en strings formatees `"AC-1: Given g, When w, Then t"` avant passage a `generateProtoSpec`, corrigeant F-EC-5.

2. **Decomposition + preflight en un seul job** : Plutot que deux jobs sequentiels (decompose puis preflight), les deux operations sont groupees dans un seul job `prd-preflight` pour simplifier le flux et eviter les problemes de coordination.

3. **Callbacks sans prdId inline** : Les callbacks `prdwf_preflight_ok`, `prdwf_preflight_abort`, `prdwf_revise_prd` n'incluent pas le prdId dans leur data (respecte la limite 64 bytes). Le prdId est recupere depuis `pendingProtoSpecs` via le chatKey.

## Phase 3 — Tester

Tests completes avec edge cases, scenarios d'erreur, et cas limites. 45 tests passants couvrant :
- Pipeline complet avec tous les flags actifs
- Chaque combinaison de la matrice de flags (R12)
- Filtrage des findings par severite (R9)
- Stockage temporaire avec TTL
- Formatage texte plat sans markdown
- Boutons conditionnels (PASS vs PAUSE)
- Retrocompatibilite

## Resultat `bun test`

```
354 pass
5 skip
0 fail
836 expect() calls
Ran 359 tests across 5 files. [326ms]
```

Tests complets du projet (2866 tests, 106 fichiers) : 2860 pass, 5 skip, 1 fail (pre-existant dans `refactorisation-llm-ops-transversale.test.ts`, non lie a cette implementation).

## Statut final

**DONE** — Le conformance check puis la review sont geres par `/dev-pipeline`.
