# Implementation Report: Event-driven SDD Auto-Advance

**Date:** 2026-03-25
**Source:** docs/explorations/EXPLORE-bridge-heartbeat-sdd-convergence.md
**Option implementee:** C — Event-driven dans relay (inline)

## Resume

Implementation de l'auto-avancement event-driven pour le pipeline SDD dans le relay. Quand une phase SDD se termine avec un verdict auto-advanceable (GO, OK, APPROVED), la phase suivante est lancee automatiquement sans intervention utilisateur. Controle par feature flag `sdd_auto_advance` et un circuit breaker de profondeur (max 3 auto-avances consecutifs).

## Tests generes

**Fichier:** `tests/unit/sdd-auto-advance.test.ts` (27 tests)

| V-critere | Test | Statut |
|-----------|------|--------|
| V1 | getNextSddPhase — 5 verdicts auto-advancables (explore+GO, spec+OK, challenge+GO, implement+OK, review+APPROVED) | PASS |
| V2 | getNextSddPhase — 7 verdicts non-auto-advancables (PIVOT, DROP, GO_WITH_CHANGES, NO-GO, CHANGES_REQUESTED, unknown) | PASS |
| V3 | Auto-advance declenche pour explore+GO (integration) | PASS |
| V3b | Auto-advance declenche pour spec+OK -> challenge (integration) | PASS |
| V4 | Pas d'auto-advance quand feature flag desactive (structural) | PASS |
| V4-full | Pas d'auto-advance quand flag desactive (integration complete) | PASS |
| V5 | Pas d'auto-advance pour jobs echoues | PASS |
| V5b | Pas d'auto-advance pour jobs non-SDD | PASS |
| V6 | Depth counter incremente sur auto-advance | PASS |
| V7 | Notification inclut phase et verdict | PASS |
| V8 | Pas d'auto-advance pour doc (phase terminale) | PASS |
| V8-edge | Pas d'auto-advance pour sdd-doc jobs | PASS |
| V9 | resetAutoAdvanceDepth remet a 0 | PASS |
| - | Tracker step updated to running on auto-advance | PASS |

## Fichiers modifies

| Fichier | Lignes changees | Description |
|---------|----------------|-------------|
| `src/sdd-auto-advance.ts` | +271 (nouveau) | Module extrait: getNextSddPhase, depth tracking, tryAutoAdvance, buildAutoAdvanceAgentFn |
| `src/job-manager.ts` | +10, -0 (net: 769 LOC) | Import du module, appel tryAutoAdvance dans sendJobCompletionNotification, _resetForTests inclut _clearDepthForTests |
| `config/features.json` | +1 | Ajout flag `sdd_auto_advance: false` |
| `CLAUDE.md` | +1 | Documentation du nouveau module sdd-auto-advance.ts |
| `tests/unit/sdd-auto-advance.test.ts` | +350 (nouveau) | 27 tests unitaires et d'integration |

## Architecture

```
sendJobCompletionNotification()
  |
  +-- SDD step update (existant)
  +-- SDD task sync (existant)
  +-- Send completion notification (existant)
  +-- tryAutoAdvance(job, botInstance, launch)  <-- NOUVEAU
       |
       +-- Check feature flag sdd_auto_advance
       +-- Parse verdict from result
       +-- getNextSddPhase(phase, verdict) -> nextPhase | null
       +-- Check depth < MAX_DEPTH (3)
       +-- Send "Auto-avancement" notification
       +-- buildAutoAdvanceAgentFn(nextPhase, ...)
       +-- launch(nextJobType, ...)
```

**Decisions de design:**
- Module extrait (`sdd-auto-advance.ts`) pour respecter le seuil 800 LOC de `job-manager.ts` (769 LOC apres extraction)
- Feature flag `sdd_auto_advance` desactive par defaut (activation via `/feature enable sdd_auto_advance`)
- Circuit breaker: max 3 auto-avances consecutifs sans interaction utilisateur
- Phase `discuss` geree comme cas special (conversationnelle, pas d'agent): marquee "ok" immediatement
- Lazy imports dans `buildAutoAdvanceAgentFn` pour eviter les dependances circulaires

## Mapping auto-avancement

| Phase | Verdict | Next Phase |
|-------|---------|------------|
| explore | GO | discuss |
| spec | OK | challenge |
| challenge | GO | implement |
| implement | OK | review |
| review | APPROVED | doc |
| explore | PIVOT/DROP | (bloque) |
| challenge | GO_WITH_CHANGES/NO-GO | (bloque) |
| review | CHANGES_REQUESTED | (bloque) |
| doc | OK | (terminal) |

## Resultat bun test

```
2132 pass, 1 skip, 0 fail
Ran 2133 tests across 76 files
```

## Statut: DONE

Prochaines etapes recommandees:
- `/dev-review` pour la revue de code
- `/dev-doc` pour la mise a jour documentation
