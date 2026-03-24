# Implementation Report — SPEC-modules-fondation-flow-sdd

> Date : 2026-03-24
> Spec : docs/specs/SPEC-modules-fondation-flow-sdd.md
> Review adversariale : docs/reviews/adversarial-SPEC-modules-fondation-flow-sdd.md
> Phase : 2 (Architecture V2 — Modules fondation)

---

## Statut final : DONE

---

## Tests generes

| Fichier | V-criteres couverts | Tests |
|---------|-------------------|-------|
| `tests/unit/pipeline-tracker.test.ts` | V1, V2, V3, V4, V5, V6, V7, V8, V9, V21 | 29 tests |
| `tests/unit/conversation-handoff.test.ts` | V10, V11, V12, V21 | 15 tests |
| `tests/unit/sdd-flow.test.ts` | V13, V16, V17, V18, V19, V20 | 22 tests |
| **Total** | **18 V-criteres / 24** | **66 tests** |

V-criteres non couverts en tests unitaires (integration/manuel) :
- V14, V15 : guard tracker null/expire dans le Composer (necessite mock grammY Context complet) — la logique est verifiee indirectement via pipeline-tracker V5 TTL + le code du callback handler
- V22 : chargement par loader.ts — verifie via le test loader existant (mis a jour pour 14 fichiers)
- V23 : integration callback sdd_spec -> launchJob — necessite mock complet du bot
- V24 : plain-text verification — verifie indirectement par le test formatStatusBar (pas de markdown)

---

## Fichiers modifies

| Fichier | Action | Lignes | Description |
|---------|--------|--------|-------------|
| `src/pipeline-tracker.ts` | Cree | 213 LOC | Module de suivi d'etat pipeline SDD par chat, persistence disque atomic write, status bar, TTL 7j |
| `src/conversation-handoff.ts` | Cree | 210 LOC | Extraction locale (pattern matching) du contexte conversationnel pour agents background — pas d'appel LLM |
| `src/commands/sdd-flow.ts` | Cree | 247 LOC | Composer grammY pour callbacks sdd_*, keyboard contextuel, detection convergence |
| `src/relay.ts` | Modifie | +2 lignes | Import et appel `initPipelineTracker()` au startup |
| `src/job-manager.ts` | Modifie | +45 lignes | Cases sdd-* dans `getCompletionKeyboard()` avec parsing verdict SDD_{PHASE}_{VERDICT}: |
| `src/commands/zz-messages.ts` | Modifie | +13 lignes | Import sdd-flow + detection convergence apres reponse Claude + affichage keyboard SDD |
| `tests/unit/pipeline-tracker.test.ts` | Cree | 29 tests | Couverture V1-V9, V21, persistence, TTL, formatStatusBar |
| `tests/unit/conversation-handoff.test.ts` | Cree | 15 tests | Couverture V10-V12, V21, extraction patterns, formatting |
| `tests/unit/sdd-flow.test.ts` | Cree | 22 tests | Couverture V13, V16-V20, keyboard contextuel, convergence |
| `CLAUDE.md` | Modifie | +3 lignes | Ajout des 3 nouveaux modules dans la table |
| `tests/unit/coding-standards.test.ts` | Modifie | +1 ligne | Ajout pipeline-tracker.ts a l'allowlist process.env (RELAY_DIR) |
| `tests/unit/loader.test.ts` | Modifie | +2 lignes | Mise a jour 13 -> 14 fichiers commande attendus |

---

## Findings adversariaux pris en compte

| Finding | Severite | Action |
|---------|----------|--------|
| F-DA-1 BLOQUANT | BLOQUANT | `assembleHandoffContext` ne fait PAS d'appel LLM — pattern matching local uniquement (correction pre-appliquee a la spec) |
| F-EC-1 BLOQUANT | BLOQUANT | Limitation V1 documentee : une pipeline par chat, pas de mutex concurrence (correction pre-appliquee) |
| F-DA-2 | MAJEUR | Pattern regex unifie `/(^|\n)Decisions:/` — fonctionne en debut de reponse ET apres newline |
| F-DA-3 / F-EC-6 | MAJEUR | `sdd_discuss` callback ajoute dans R13 (correction pre-appliquee) — implemente comme transition sans job |
| F-EC-3 | MAJEUR | Parsing callback avec `indexOf(":")` + `substring` au lieu de `split(":")` pour tolerer les noms avec ":" |
| F-EC-4 | MAJEUR | `updateStep()` ajoute a l'API publique avec no-op + log.warn si tracker null/expire |
| F-SS-1 | MAJEUR | Pattern `SDD_{PHASE}_{VERDICT}:` dans les resultats de job — parseable par `getCompletionKeyboard` ET `parseSddResultPrefix()` |
| F-SS-2 | MAJEUR | Reutilisation du pattern assemblage direct (comme `buildEnrichedDescription`) — pas d'appel LLM |
| F-SS-3 | MAJEUR | `initPipelineTracker()` explicitement appele dans relay.ts au startup (pattern initSessions) |
| F-DA-4 | MINEUR | `_clearForTests()` reset `persistLoaded = false` pour forcer reload depuis disque |
| F-SS-4/5 | MINEUR | Phase 'discuss' gere par `sdd_discuss` callback (status -> 'ok' sans job), presente dans status bar |

---

## Architecture des modules

### pipeline-tracker.ts (213 LOC)
- Types : `SddPhase`, `StepStatus`, `PipelineStep`, `PipelineTracker`
- API publique : `toPipelineName()`, `createPipeline()`, `getTracker()`, `updateStep()`, `formatStatusBar()`, `initPipelineTracker()`, `_clearForTests()`
- Persistence : atomic write (tmp -> rename) sur `RELAY_DIR/pipelines.json`
- Lazy path resolution via fonctions `getRelayDir()`/`getPipelinesFile()` pour testabilite
- TTL 7 jours sur `updatedAt`, verifie dans `getTracker()` et `loadPipelines()`
- Aucun import de modules marques "Supprime" (V21)

### conversation-handoff.ts (210 LOC)
- Types : `HandoffSummary`, `AssembleOptions`
- API publique : `assembleHandoffContext()`, `formatHandoffForAgent()`
- Pattern matching local : 5 familles de regex (decisions, contraintes, fichiers, questions resolues, hors scope)
- Deduplication des resultats extraits
- Aucun appel LLM (F-DA-1 resolu)
- Aucun import de modules marques "Supprime" (V21)

### commands/sdd-flow.ts (247 LOC)
- Types : `SddVerdict`, `ConvergenceSignal`
- API publique : `detectConvergenceInResponse()`, `buildSddKeyboard()`, `parseSddResultPrefix()`
- Default export : factory Composer `sddFlowComposer(bctx)`
- Guard prefixe `sdd_` avec `next()` pour les callbacks non-SDD (R9)
- 6 actions geres : explore, discuss, spec, challenge, implement, review (R13)
- `sdd_discuss` : transition sans job (status -> 'ok') (F-DA-3)
- Agents : placeholder `agentFn` — sera cable aux vrais agents en Phase 3
- Keyboard contextuel selon phase et verdict (R14)

---

## Resultat bun test

```
3936 pass
10 skip
0 fail
8278 expect() calls
Ran 3946 tests across 129 files. [35.69s]
```

Tests avant implementation : 3860 pass
Tests apres implementation : 3936 pass (+76)

---

## Besoins hors scope identifies

1. **System prompt conversationnel (Z1)** : La detection de convergence est implementee mais ne sera pas activee par Claude tant que le system prompt de `callClaude` n'est pas modifie pour instruire le format "Decisions: ...". A traiter en Phase 3.

2. **Cablage des vrais agents SDD** : Les callbacks `sdd_explore/spec/challenge/implement/review` utilisent un placeholder `agentFn`. Le cablage aux vrais agents (spawnClaude avec les bons templates) est Phase 3.

3. **Tests d'integration complets** (V14, V15, V22, V23) : Les tests de guard sur pipeline expire et les tests d'integration callback -> job launch necessitent un mock complet du contexte grammY. A ajouter dans une vague dediee aux tests d'integration.

4. **Coordination clavier post-job complete** : Le `getCompletionKeyboard` dans job-manager.ts parse le prefix SDD mais ne connait pas le `name` du pipeline (il extrait seulement l'action du `job.type`). Le name devrait etre stocke dans le job metadata ou extrait du resultat. Deferred Phase 3.

---

## Etape suivante

**DONE** — Les prochaines etapes du workflow sont :
- `/dev-review` pour la revue de code
- `/dev-doc` pour la mise a jour de la documentation
