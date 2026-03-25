# Code Review — connecter-pipeline-sdd-et-backlog-pour-que-le

**Date :** 2026-03-25
**Reviewer :** dev-review agent
**Score global : 88/100**

---

## Fichiers revus

| Fichier | Action | LOC delta |
|---------|--------|-----------|
| `src/sdd-task-sync.ts` | CRÉÉ | +111 |
| `src/tasks.ts` | MODIFIÉ | +16 |
| `src/pipeline-tracker.ts` | MODIFIÉ | +5 |
| `db/schema.sql` | MODIFIÉ | +4 |
| `db/migrations/001_initial.sql` | MODIFIÉ | +4 |
| `CLAUDE.md` | MODIFIÉ | +1 |
| `tests/unit/sdd-backlog-link.test.ts` | CRÉÉ | +333 |

---

## Résultats de validation

| Check | Résultat |
|-------|---------|
| `bunx tsc --noEmit` | 1 erreur pre-existante (`bun-types` manquant dans le worktree) — non liée aux changements |
| `bun test` | **2001 pass, 1 fail** (la failure TSC est pre-existante, confirmée) |
| 22 nouveaux tests | **22/22 pass** |

---

## Bloquants

Aucun bloquant identifié.

---

## Avertissements

### A1 — Log `from` erroné dans les tests (artefact mock)

Dans `src/sdd-task-sync.ts`, après la fetch du status courant et avant `updateTaskStatus`, le code log correctement `currentTask.status`. Mais les logs de test montrent :

```
syncTaskStatus: updated {"taskId":"t1","from":"in_progress","to":"in_progress","phase":"explore"}
```

...alors que le mock était initialisé avec `status: "backlog"`. La cause : le mock supabase retourne une référence à l'objet interne, qui est ensuite muté par `updateTaskStatus`. Ainsi, au moment du log, `currentTask.status` a déjà été mis à jour.

**Impact :** Aucun en production (Supabase retourne des objets indépendants). La logique anti-downgrade est correcte (elle compare les indices AVANT la mutation). Tests verts, comportement prod correct.

### A2 — Pas de migration ALTER TABLE pour l'existant

`db/migrations/001_initial.sql` est la migration initiale (création de table). La colonne `sdd_pipeline_name` y a été ajoutée, ce qui est correct pour un schéma vierge. Mais une base existante en production nécessite un `ALTER TABLE tasks ADD COLUMN sdd_pipeline_name TEXT;` séparé.

**Impact :** Déploiement prod : appliquer manuellement via Supabase MCP avant redémarrage du relay.

### A3 — Sync phases agents implicite dans sdd-flow.ts

`sdd-flow.ts` appelle `syncTaskStatusForPhase` uniquement pour la phase `discuss` (ligne 225). Les phases agentiques (explore, spec, challenge, implement, review, doc) sont synchées via `job-manager.ts` au moment de la complétion du job. Ce mécanisme est correct architecturalement mais n'est pas documenté dans `sdd-flow.ts`, ce qui peut induire en erreur un développeur lisant uniquement ce fichier.

---

## Suggestions

### S1 — getTaskById : commentaire sur absence de prefix-match

La spec mentionne "prefix UUID" dans V10 mais l'implémentation utilise un match exact (`eq("id", taskId)`). C'est suffisant pour l'usage actuel (les taskId sont toujours des UUIDs complets), mais un commentaire explicitant ce choix éviterait une future "amélioration" erronée.

### S2 — Lazy import Supabase dans job-manager.ts

Le bloc sync dans `job-manager.ts` (lignes 537-541) crée un nouveau client Supabase à chaque complétion de phase via `createClient(config...)`. Pour les best-effort calls peu fréquents, c'est acceptable. Si le volume augmente, envisager de passer le client supabase dans le `BackgroundJob` lors du démarrage SDD.

---

## Points positifs

- **Architecture clean** : `sdd-task-sync.ts` est un module focalisé (111 LOC, single responsibility). Import `type` utilisé correctement pour `SddPhase`, `StepStatus`, `Task`.
- **Best-effort respecté** : `syncTaskStatusForPhase` ne throw jamais, log.warn sur toutes les erreurs.
- **Anti-downgrade correct** : `STATUS_ORDER` et comparaison d'index protègent correctement contre les régressions de statut.
- **Backward-compat** : `taskId?: string` optionnel sur `PipelineTracker`, les trackers sans `taskId` se chargent sans erreur (V12 validé).
- **Standards S1-S7 respectés** : `createLogger`, pas de `process.env` direct, LOC < 800, pas de circular imports.
- **Coverage** : 22 tests couvrent tous les V-critères spec (V1-V16) + 3 cas supplémentaires.
- **Integration complète** : le module est correctement intégré dans `sdd-flow.ts`, `exploration.ts` et `job-manager.ts`.

---

## Décision : APPROVED — prêt pour PR
