# Implementation Report -- SPEC-migration-schema-supabase

> Date : 2026-03-20
> Spec : docs/specs/SPEC-migration-schema-supabase.md
> Review adversariale : docs/reviews/adversarial-SPEC-migration-schema-supabase.md
> Statut : **DONE**

---

## Phase 1 -- Analyse et verification pre-implementation

### Verification Supabase (via MCP execute_sql)

Avant toute modification, l'etat reel de la base a ete verifie :

| Element | Etat reel | Action requise |
|---------|-----------|----------------|
| `pipeline_runs` | Absente | Creer via migration |
| `gate_evaluations` | Absente | Creer via migration |
| `trust_scores` | Absente | Creer via migration |
| `agent_events` | Absente | Creer via migration |
| `cost_tracking.model` | Absente | Ajouter via migration |
| `workflow_logs.metadata` | **Absente** (non prevu par la spec) | Ajouter via migration |
| `audit_results` | Presente, RLS desactive | Colonnes : `id`, `created_at`, `global_score` (int NOT NULL), `axis_scores` (jsonb), `findings` (jsonb), `task_ids_created` (text[]), `trigger_type` (text NOT NULL), `project_id` (uuid) |
| `workflow_logs` colonnes | `step_from`, `step_to` existent. Pas de `step`. Pas de `metadata` | Confirme : les inserts avec `step` echouaient silencieusement |

### Decouverte hors spec : `workflow_logs.metadata` manquante

La colonne `metadata JSONB DEFAULT '{}'` est declaree dans `db/schema.sql` (L216) mais **absente de la production Supabase**. Cela signifie que :
- Les inserts de `code-review.ts` et `orchestrator.ts` qui incluent `metadata: {...}` perdaient ces donnees silencieusement (PostgREST ignore les colonnes inconnues dans les inserts)
- Les queries de `alerts.ts` filtrant sur `metadata->score` retournaient toujours null

**Decision** : ajout de `ALTER TABLE workflow_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';` dans la migration car sans cette colonne, les corrections de noms de colonnes seraient inutiles.

### Correction du finding adversarial F-DA-1 (dashboard/server.ts)

Analyse : les lignes 563 et 582 identifiees par le Devil's Advocate comme `row.score` sur `audit_results` sont en realite `row.score` sur `trust_scores` (L563) et `gate_evaluations` (L582) -- tables ou la colonne s'appelle bien `score`. **F-DA-1 est un faux positif** pour les colonnes audit.

En revanche, `dashboard/server.ts` avait un bug reel : les fonctions `handleAgentMetrics` et `handleCodeReviews` utilisaient `.eq("step", "code_review")` et `.eq("step", "orchestration")` -- meme classe de bug que R4 (colonne `step` inexistante). Corrige.

---

## Phase 2 -- Fichiers modifies

### Migration SQL (nouveau fichier)

**`db/migrations/migration-schema-sync.sql`** -- Migration idempotente, a appliquer manuellement avant deploiement code.

Contenu :
1. `CREATE TABLE IF NOT EXISTS` pour les 4 tables manquantes (pipeline_runs, gate_evaluations, trust_scores, agent_events) avec indexes
2. `ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS model TEXT`
3. `ALTER TABLE workflow_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'` (decouverte hors spec)
4. Trigger `pipeline_runs_updated_at` avec `DROP TRIGGER IF EXISTS` avant `CREATE TRIGGER` (R11)
5. RLS enable + policies pour les 4 nouvelles tables + audit_results, avec `DROP POLICY IF EXISTS` avant `CREATE POLICY` (R11)

### Corrections TypeScript

| Fichier | Modifications | Regles |
|---------|---------------|--------|
| `src/code-review.ts` L190-203 | Remplace `step: "code_review"`, `from_step: "execution"`, `to_step: "review"` par `step_from: "execution"`, `step_to: "review"`. Ajoute `type: "code_review"` dans metadata | R3, R14 |
| `src/orchestrator.ts` L1207-1231 | Remplace `step: "orchestration"`, `from_step: "orchestration_start"`, `to_step: "orchestration_end"` par `step_from: "orchestration_start"`, `step_to: "orchestration_end"`. Ajoute `type: "orchestration"` dans metadata | R3, R14 |
| `src/alerts.ts` L165-171, L218-224 | Remplace `.eq("step", "code_review")` par `.eq("metadata->>type", "code_review")` et `.eq("step", "orchestration")` par `.eq("metadata->>type", "orchestration")` | R4 |
| `mcp/memory-server.ts` L1016-1068 | Remplace `score,axis_scores,gaps` par `global_score,axis_scores,findings` dans le select. Remplace `row.score` par `row.global_score`, `row.gaps` par `row.findings`, `axisGaps` par `axisFindings` | R5 |
| `dashboard/server.ts` L309-395, L498-504 | Remplace `.eq("step", ...)` et `log.step ===` par filtre sur `metadata->>type` / `metadata?.type` | R4 (meme classe) |

### Mise a jour schema.sql

| Modification | Regles |
|-------------|--------|
| Ajout `model TEXT` dans la definition de `cost_tracking` (L363) | R2 |
| Ajout table `audit_results` avec colonnes reelles (id, created_at, global_score, axis_scores, findings, task_ids_created, trigger_type, project_id) | R6 |
| Ajout RLS enable + policy pour `pipeline_runs`, `agent_events`, `audit_results` | R8 |

### Adaptation des tests

| Fichier | Modifications | Regles |
|---------|---------------|--------|
| `tests/unit/code-review.test.ts` L387-389 | Remplace assertions `data.step === "code_review"`, `data.from_step`, `data.to_step` par `data.step_from`, `data.step_to`, `data.metadata.type === "code_review"` | R10 |
| `tests/unit/mcp-audit-tool.test.ts` L32-41, L64-71, L73-79 | Remplace assertions `score: row.score` par `score: row.global_score`, `gaps: row.gaps` par `findings: row.findings`, `globalScore: row.score` par `globalScore: row.global_score` | R10 |

---

## Phase 3 -- Validation

### Resultat `bun test`

```
2690 pass
0 fail
6468 expect() calls
Ran 2690 tests across 101 files. [33.31s]
```

### V-criteres

| # | Critere | Statut | Verification |
|---|---------|--------|-------------|
| V1 | 4 tables existent apres migration | PRET (migration preparee, non appliquee) | `CREATE TABLE IF NOT EXISTS` dans migration |
| V2 | Colonne `model` dans cost_tracking | PRET (migration preparee) | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS model TEXT` |
| V3 | code-review.ts utilise `step_from`/`step_to` | OK | Grep confirme L192-193 |
| V4 | orchestrator.ts utilise `step_from`/`step_to` | OK | Grep confirme L1209-1210 |
| V5 | alerts.ts ne filtre plus sur `.eq("step", ...)` | OK | Grep confirme 0 occurrences |
| V6 | memory-server.ts requete `global_score`/`findings` | OK | Grep confirme L1018, L1062-1064 |
| V7 | schema.sql contient `audit_results` | OK | L1123 |
| V8 | schema.sql contient `model TEXT` dans cost_tracking | OK | L363 |
| V9 | RLS + policies pour les 4 tables + audit_results | OK | L804-813 |
| V10 | Migration idempotente | PRET | IF NOT EXISTS, DROP IF EXISTS partout |
| V11 | 2690 tests passent | OK | 0 fail |
| V12 | Indexes declares pour les 4 tables | OK | Migration inclut tous les `CREATE INDEX IF NOT EXISTS` |
| V13 | Trigger pipeline_runs_updated_at | OK | Migration avec DROP IF EXISTS + CREATE TRIGGER |
| V14 | Info type dans metadata | OK | `type: "code_review"` dans code-review.ts, `type: "orchestration"` dans orchestrator.ts |

---

## Decouvertes hors scope (non implementees)

1. **`workflow_logs.metadata` absente en production** : ajoutee dans la migration car bloquante pour l'implementation, mais cette divergence supplementaire n'etait pas identifiee dans l'exploration initiale. Cause probable : la colonne a ete ajoutee a schema.sql sans migration correspondante.

2. **`dashboard/server.ts` : `handleAgentMetrics` et `handleCodeReviews`** utilisaient `.eq("step", ...)` sur workflow_logs -- meme bug que R4. Corrige car le fichier etait deja en scope et le bug etait de meme nature.

3. **dashboard/server.ts : `handleAgentMetrics`** selectionne `step` comme colonne dans le select (`select("step, metadata, ...")`). Cette colonne n'existe pas, PostgREST l'ignore. Corrige en retirant `step` du select.

4. **Donnees historiques** : les queries de `alerts.ts` filtrant sur `metadata->>type` ne trouveront aucune donnee historique car l'ancien code inserait `step: "code_review"` qui etait ignore par PostgREST (colonne inexistante). Les alertes `review_score_drop` et `agent_failure_patterns` seront vides jusqu'a ce que de nouvelles donnees soient inserees avec le format corrige.

5. **dashboard/server.ts : step references dans `handleAgentMetrics`** au-dela du select -- la variable `log.step` etait utilisee pour discriminer les types de logs (orchestration vs code_review). Remplace par `log.metadata?.type`.

---

## Ordre de deploiement

1. **Appliquer la migration SQL** : `db/migrations/migration-schema-sync.sql` via Supabase SQL Editor ou MCP
2. **Deployer le code TypeScript** : `git pull && pm2 restart all`
3. **Verifier** : les V-criteres V1, V2, V10 en post-deploiement

---

## Statut final : DONE

Prochaine etape : conformance check puis review de code via `/dev-pipeline`.
