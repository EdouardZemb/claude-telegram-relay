---
phase: 1-implement
generated_at: "2026-03-26T11:42:00Z"
subject: "Orphan recovery — pont heartbeat-SDD pour detection et remediation des pipelines bloques"
status: DONE
---

# Implementation Report — Orphan Recovery (Heartbeat-SDD Watchdog)

## Tests generes

| Fichier | V-criteres couverts | Tests |
|---------|-------------------|-------|
| `tests/unit/heartbeat-sdd-watchdog.test.ts` | V1-V9 | 21 tests |

### V-criteres couverts

- **V1**: Detection des phases agent bloquees (>30 min running) — 3 tests
- **V2**: Seuil differencie pour phase `discuss` (24h) — 2 tests
- **V3**: Ignore les phases non-running (pending, ok, failed) — 3 tests
- **V4**: Phase `running` sans `startedAt` traitee comme bloquee (conservateur) — 1 test
- **V5**: Degradation gracieuse (fichier absent, JSON malformed, tableau vide) — 3 tests
- **V6**: Filtrage TTL (pipelines expires >7 jours ignores) — 1 test
- **V7**: Format des notifications (nom pipeline, phase, temps ecoule) — 2 tests
- **V8**: Seuil differencie pour phase `implement` (60 min vs 30 min) — 3 tests
- **V9**: Export `getStuckThresholdMs()` avec valeurs attendues par phase — 3 tests

## Fichiers modifies

| Fichier | Changement | LOC |
|---------|-----------|-----|
| `src/heartbeat-sdd-watchdog.ts` | **Nouveau** — module watchdog (detection orphelins SDD) | 140 |
| `src/heartbeat-prompt.ts` | Ajout `lastPipelineWatchdogAt` dans HeartbeatState + createDefaultState | +2 |
| `src/heartbeat.ts` | Import watchdog + integration dans periodic tasks (feature-gated) | +28 |
| `config/features.json` | Nouveau flag `sdd_pipeline_watchdog: true` | +1 |
| `tests/unit/heartbeat.test.ts` | Fix baseState pour compatibilite avec nouveau champ HeartbeatState | +2/-6 |
| `tests/unit/heartbeat-sdd-watchdog.test.ts` | **Nouveau** — 21 tests unitaires | 404 |

## Architecture

Option B de l'exploration (watchdog heartbeat) implementee fidellement :

1. **`src/heartbeat-sdd-watchdog.ts`** (140 LOC) : module autonome qui lit `pipelines.json` directement (cross-processus, lecture seule). Exporte `checkSddPipelines(relayDir)` et `getStuckThresholdMs(phase)`.

2. **Seuils differencies par phase** :
   - Phases agent (explore, spec, challenge, review, doc) : **30 min**
   - Phase implement : **60 min** (legitimement plus longue)
   - Phase discuss : **24h** (conversationnelle, pilotee par l'utilisateur)
   - Phase running sans `startedAt` : traitee comme bloquee (conservateur)

3. **Integration dans heartbeat.ts** : appelee a chaque pulse (10 min), gatee par feature flag `sdd_pipeline_watchdog`. Utilise le systeme de cooldowns existant du heartbeat pour l'idempotence (pas de re-notification pour le meme pipeline bloque).

4. **Notifications** : via `writeMcpPending()` (canal existant du heartbeat) avec prefixe `[SDD Watchdog]`.

## Resultat bun test

```
2357 pass, 1 skip, 2 fail (pre-existants)
4797 expect() calls
84 files
```

Les 2 echecs sont pre-existants (biome lint sur `sdd-agents.ts`/`agent-context.ts` + ENOENT bun binary dans agent test). Zero regression introduite.

## Statut final

**DONE**

## Prochaine etape

`/dev-review` puis `/dev-doc`
