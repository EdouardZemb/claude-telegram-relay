# Implementation Report — Migration des feature flags vers Supabase

> Date : 2026-03-25
> Source : docs/explorations/EXPLORE-migration-des-feature-flags-vers.md
> Phase : dev-implement (TDD)

## Resume

Migration du systeme de feature flags de `config/features.json` (fichier local ecrase par `git checkout -- .` a chaque deploy) vers une table Supabase `feature_flags` avec cache en memoire. L'API synchrone `isFeatureEnabled()` est preservee grace au cache pre-charge au boot. Le deploy script interroge Supabase via `curl` avec fallback sur le fichier JSON.

## Tests generes

| Fichier | Tests | V-criteres couverts |
|---------|-------|---------------------|
| `tests/unit/feature-flags-supabase.test.ts` | 22 | V1-V12 (schema, sync read, init, fallback, setFeature, listFeatures, refresh, deploy.yml, format, unknown flags, loadDefaults, edge cases) |
| `tests/unit/feature-flags.test.ts` | 17 | Backward compat (loadFeatures, isFeatureEnabled, setFeature async, listFeatures, formatFeatures, initFeatureFlags mock) |
| `tests/unit/sdd-auto-deploy.test.ts` | 19 | Adapte V3 pour curl + Supabase + fallback bun |

Total : **58 tests** dedies aux feature flags (39 nouveaux/adaptes + 19 existants adaptes)

## Fichiers modifies

| Fichier | Lignes changees | Description |
|---------|----------------|-------------|
| `src/feature-flags.ts` | ~220 (rewrite) | Refonte complete : cache Map + Supabase persistence + `initFeatureFlags()` + `refreshFeatureFlags()` + `loadDefaults()` + `_resetForTesting()`. `isFeatureEnabled()` reste synchrone. `setFeature()` devient async. |
| `db/schema.sql` | +32 | Table `feature_flags` (flag TEXT PK, enabled BOOLEAN, description, updated_at, updated_by) + RLS + seed 11 flags |
| `db/migrations/001_initial.sql` | +32 | Meme ajout (synchro schema/migration) |
| `.github/workflows/deploy.yml` | +30/-10 | Check `sdd_auto_deploy` via `curl` PostgREST, fallback `bun -e` sur `features.json` |
| `src/relay.ts` | +3 | Import + appel `initFeatureFlags(supabase)` au boot |
| `mcp/memory-server.ts` | +3 | Import `initFeatureFlags` + `await initFeatureFlags(supabase)` + `await setFeature()` |
| `src/commands/utilities.ts` | +2 | `await setFeature()` (etait synchrone) |
| `tests/unit/feature-flags.test.ts` | ~170 (rewrite) | Adapte pour cache memoire, `_resetForTesting()`, async `setFeature()` |
| `tests/unit/sdd-auto-deploy.test.ts` | +5 | `_resetForTesting()` + V3 adapte pour curl |
| `tests/unit/sdd-auto-advance.test.ts` | +6 | `_resetForTesting()` + `await setFeature()` |
| `tests/unit/nlu-feature-request.test.ts` | +8/-12 | `setFlag()` via `setFeature()` cache au lieu de `writeFileSync` |
| `tests/unit/job-manager.test.ts` | +12 | `beforeEach`/`afterEach` disable `sdd_auto_advance` pour isoler les tests de notification |
| `tests/unit/coding-standards.test.ts` | -2 | Retire `feature-flags.ts` de l'allowlist S6 (a maintenant createLogger) |

## Migration Supabase

Migration `create_feature_flags_table` appliquee avec succes. 11 flags seedes avec les valeurs de production.

## Tests completes et resultats

```
bun test — 2267 pass, 0 fail, 1 skip (81 fichiers)
```

Dont 58 tests couvrant directement les feature flags (schema, init, cache, persistence, deploy.yml, backward compat, edge cases).

## Architecture

```
                 Boot                          Runtime
                  |                              |
  initFeatureFlags(supabase)              isFeatureEnabled(flag)
          |                                      |
    [Supabase SELECT]                   [Map.get() — sync]
          |                                      |
    OK? → populate cache                 returns boolean
    Error? → loadDefaults()
             (config/features.json)

  setFeature(flag, enabled)              refreshFeatureFlags()
          |                                      |
    cache.set() — immediate              [Supabase SELECT]
    supabase.upsert() — best-effort      repopulate cache
```

- `config/features.json` : conserve comme source de valeurs par defaut (jamais modifie au runtime)
- `isFeatureEnabled()` : reste synchrone (10+ consommateurs inchanges)
- `setFeature()` : maintenant async (3 call sites adaptes)
- Deploy script : `curl` vers PostgREST avec fallback JSON
- Heartbeat : utilise le fallback fichier (pas de changement necessaire)

## Statut final

**DONE** — Tous les tests passent. Migration Supabase appliquee. Le probleme critique (flags ecrases par `git checkout -- .`) est resolu.

## Etape suivante

`/dev-review` puis `/dev-doc`
