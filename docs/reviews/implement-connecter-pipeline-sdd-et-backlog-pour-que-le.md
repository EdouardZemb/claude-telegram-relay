# Rapport d'implémentation — connecter-pipeline-sdd-et-backlog-pour-que-le

**Date :** 2026-03-25
**Spec :** docs/specs/SPEC-connecter-pipeline-sdd-et-backlog-pour-que-le.md
**Statut :** DONE

---

## 1. Tests générés

**Fichier :** `tests/unit/sdd-backlog-link.test.ts`

**V-critères couverts :**

| V-critère | Test | Statut |
|-----------|------|--------|
| V1 | tracker created without taskId has undefined taskId | PASS |
| V2 | createPipeline with taskId stores it in tracker | PASS |
| V3 | Task interface accepts sdd_pipeline_name | PASS |
| V4 | addTask with sdd_pipeline_name stores it | PASS |
| V4 | addTask without sdd_pipeline_name has null value | PASS |
| V5 | shows [SDD] for tasks with sdd_pipeline_name | PASS |
| V6 | explore/discuss/spec/challenge map to in_progress | PASS |
| V7 | implement/review map to review | PASS |
| V8 | doc maps to done | PASS |
| V9 | no-op when taskId is undefined (no throw) | PASS |
| V9 | no-op when phase status is not ok | PASS |
| V10 | finds task by full UUID | PASS |
| V10 | returns null for non-existent id | PASS |
| V11 | taskId persists to disk and survives reload | PASS |
| V12 | backward-compat — trackers without taskId load fine | PASS |
| V13 | schema.sql contains sdd_pipeline_name column | PASS |
| V14 | [SDD] indicator is placed before the title | PASS |
| V15 | does not downgrade if already in review | PASS |
| V16 | no-op when stepStatus is failed | PASS |
| + | syncs task to in_progress when explore completes | PASS |
| + | syncs task to review when implement completes | PASS |
| + | syncs task to done when doc completes | PASS |

Total : **22 tests, 22 pass**

---

## 2. Fichiers modifiés

### `src/sdd-task-sync.ts` (CRÉÉ — 111 LOC)
- `PHASE_TO_TASK_STATUS` : mapping phases SDD → statuts Task
- `syncTaskStatusForPhase()` : best-effort sync avec anti-downgrade, log.warn sur erreurs, aucun throw

### `src/tasks.ts` (+13 lignes)
- Interface `Task` : ajout `sdd_pipeline_name: string | null`
- Fonction `addTask` opts : ajout `sdd_pipeline_name?: string`, passé à l'insert Supabase
- Fonction `getTaskById()` : nouvelle fonction (CRUD par UUID)
- Fonction `formatBacklog()` : préfixe `[SDD] ` conditionnel avant le titre

### `src/pipeline-tracker.ts` (+5 lignes)
- Interface `PipelineTracker` : ajout `taskId?: string`
- Fonction `createPipeline()` : ajout paramètre `opts?: { taskId?: string }`, spread conditionnel dans le tracker

### `db/schema.sql` (+2 lignes)
- Colonne `sdd_pipeline_name TEXT` dans la table `tasks`
- COMMENT ON COLUMN correspondant

### `db/migrations/001_initial.sql` (+2 lignes)
- Même modification que schema.sql (cohérence migration initiale)

### `CLAUDE.md` (+1 ligne)
- Documentation du module `sdd-task-sync.ts` dans la table Source Modules

---

## 3. Tests complétés et résultats

**Résultats `bun test` :**
- Avant : 1978 pass, 2 fail (TSC bun-types pre-existing + doc-freshness)
- Après : 2001 pass, 1 fail (seul TSC bun-types pre-existing reste)

**22 nouveaux tests ajoutés, tous passent.**

La failure doc-freshness a été résolue en ajoutant `sdd-task-sync.ts` à CLAUDE.md.

La failure TSC (`bunx tsc --noEmit`) était pre-existante (missing bun-types dans le worktree) — confirmée par git stash + retest sans les changements.

---

## 4. Résultat `bun test`

```
2001 pass
1 skip
1 fail (pre-existing: tsc --noEmit / bun-types manquants dans worktree)
4045 expect() calls
Ran 2003 tests across 71 files. [32.94s]
```

---

## 5. Statut final : DONE

Tous les V-critères de la spec sont couverts et validés. L'implémentation est conforme aux contraintes :
- `sdd-task-sync.ts` : 111 LOC (< 800), pas de console.log, pas de process.env, dépendances autorisées uniquement
- Best-effort obligatoire respecté (aucun throw dans syncTaskStatusForPhase)
- Anti-downgrade correctement implémenté via STATUS_ORDER
- Backward-compat des trackers sans taskId préservée (pas de migration requise)
- Colonne SQL `sdd_pipeline_name` ajoutée dans schema.sql et migration initiale
