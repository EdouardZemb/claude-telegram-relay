# Spec : Migration schema Supabase — synchronisation DB/code/schema.sql

> Genere le 2026-03-20. Source : docs/explorations/EXPLORE-desynchronisation-schema-supabase.md, verification codebase directe.

## 1. Objectif

Resoudre les 7 divergences entre le schema Supabase en production, le fichier de reference `db/schema.sql`, et le code TypeScript. Les corrections se decomposent en 2 volets : (A) migrations SQL pour creer les 4 tables manquantes et ajouter la colonne `model` a `cost_tracking`, et (B) corrections des noms de colonnes errones dans 4 fichiers TypeScript. L'objectif est de restaurer la fiabilite de 8 modules actuellement defaillants en production (16 operations Supabase en echec silencieux).

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Les 4 tables declarees dans schema.sql mais absentes de Supabase doivent etre creees par migration : `pipeline_runs`, `gate_evaluations`, `trust_scores`, `agent_events` | Exploration D1, erreur PGRST205 en prod | `pipeline-state.ts` echoue a chaque appel checkpoint |
| R2 | La colonne `model TEXT` doit etre ajoutee a `cost_tracking` en production et dans schema.sql | Exploration D3, `cost-tracking.ts:147` insere `model` | `logCost()` perd l'info modele sur chaque insert |
| R3 | Les inserts dans `workflow_logs` doivent utiliser `step_from`/`step_to` (noms reels) et non `from_step`/`to_step`/`step` (noms errones) | Exploration D4, schema.sql L206-207 | `code-review.ts:192-194` et `orchestrator.ts:1209-1211` |
| R4 | Les selects de `workflow_logs` filtrant par type d'evenement doivent filtrer sur `step_from` ou `metadata` et non sur une colonne `step` inexistante | Verification codebase, `alerts.ts:168,221` | `.eq("step", "code_review")` retourne toujours vide |
| R5 | Les requetes sur `audit_results` doivent utiliser `global_score`/`findings` (noms reels en Supabase) et non `score`/`gaps` | Exploration D5, `memory-server.ts:1018` | L'outil MCP `audit_codebase` retourne null pour score et findings |
| R6 | La table `audit_results` doit etre documentee dans `db/schema.sql` pour refleter la realite Supabase | Exploration D2, table existe en prod (migration 20260320103150) mais absente de schema.sql | Dashboard et MCP l'utilisent |
| R7 | Toute migration SQL doit utiliser `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` pour garantir l'idempotence | Exploration section contraintes | `CREATE TABLE IF NOT EXISTS pipeline_runs (...)` |
| R8 | Les tables avec RLS actif dans schema.sql doivent avoir RLS active dans la migration (gate_evaluations, trust_scores ont deja leurs policies dans schema.sql, pipeline_runs et agent_events n'en ont pas) | Verification schema.sql L795-800, absence L685-700 | `pipeline_runs` et `agent_events` doivent avoir RLS + policy |
| R9 | `dashboard/server.ts` utilise aussi `row.score`/`row.gaps` pour audit_results — doit etre corrige comme `memory-server.ts` (R5) | Challenge adversarial F-DA-1 | Memes colonnes erronees que R5 |
| R10 | Les tests `code-review.test.ts` et `mcp-audit-tool.test.ts` doivent etre adaptes apres les corrections de colonnes (assertions sur les anciens noms) | Challenge adversarial + Impact analysis | Tests cassent obligatoirement sans adaptation |
| R11 | Les `CREATE POLICY` et `CREATE TRIGGER` doivent utiliser `DROP ... IF EXISTS` avant `CREATE` pour garantir l'idempotence (PostgreSQL n'a pas de `IF NOT EXISTS` pour ces objets) | Challenge adversarial idempotence | `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ...` |
| R12 | Ordre de deploiement : migration SQL appliquee AVANT restart du code. Documenter dans le rapport pipeline | Challenge adversarial F-EC-1 | cost-tracking.ts insere `model` sans fallback |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `db/schema.sql` | SQL DDL | Fichier local L417-499, L1093-1105, L352-375 | Definitions des 4 tables, colonnes cost_tracking, indexes, RLS policies |
| Supabase production | PostgreSQL | MCP `apply_migration` | Tables existantes, colonnes reelles |
| `src/code-review.ts` | TypeScript | Fichier local L190-204 | Insert workflow_logs avec mauvais noms |
| `src/orchestrator.ts` | TypeScript | Fichier local L1207-1230 | Insert workflow_logs avec mauvais noms |
| `src/alerts.ts` | TypeScript | Fichier local L165-171, L218-224 | Select workflow_logs avec colonne `step` inexistante |
| `mcp/memory-server.ts` | TypeScript | Fichier local L1016-1068 | Select audit_results avec mauvais noms de colonnes |

## 4. Donnees de sortie

### 4.1 — Migration SQL (1 fichier Supabase)

Migration unique appliquee via `mcp__supabase__apply_migration`. Contient :
- `CREATE TABLE IF NOT EXISTS pipeline_runs (...)` avec indexes et trigger updated_at (R1, R7)
- `CREATE TABLE IF NOT EXISTS gate_evaluations (...)` avec indexes (R1, R7)
- `CREATE TABLE IF NOT EXISTS trust_scores (...)` (R1, R7)
- `CREATE TABLE IF NOT EXISTS agent_events (...)` avec indexes (R1, R7)
- `ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS model TEXT` (R2, R7)
- RLS enable + policy "Allow all" pour les 4 nouvelles tables (R8)
- Fonction trigger `update_pipeline_runs_updated_at()` + trigger `pipeline_runs_updated_at` (R1)

### 4.2 — Corrections TypeScript (4 fichiers)

**`src/code-review.ts` (R3)** : dans l'insert workflow_logs, remplacer `step: "code_review"` / `from_step: "execution"` / `to_step: "review"` par `step_from: "execution"` / `step_to: "review"`. Supprimer la cle `step` inexistante.

**`src/orchestrator.ts` (R3)** : dans l'insert workflow_logs, remplacer `step: "orchestration"` / `from_step: "orchestration_start"` / `to_step: "orchestration_end"` par `step_from: "orchestration_start"` / `step_to: "orchestration_end"`. Supprimer la cle `step` inexistante. Deplacer l'info type dans `metadata` (ex: `type: "orchestration"` dans l'objet metadata).

**`src/alerts.ts` (R4)** : remplacer `.eq("step", "code_review")` par un filtre sur metadata (ex: `.not("metadata->score", "is", null)` pour identifier les reviews) et `.eq("step", "orchestration")` par un filtre equivalent sur metadata (ex: `.not("metadata->pipeline", "is", null)` pour identifier les orchestrations). Alternativement, filtrer sur `step_from` avec les valeurs pertinentes.

**`mcp/memory-server.ts` (R5)** : dans la requete audit_results, remplacer `score` par `global_score` et `gaps` par `findings` dans la clause select, et dans toutes les references au resultat (`row.score` -> `row.global_score`, `row.gaps` -> `row.findings`, cles JSON).

### 4.3 — Mise a jour schema.sql (R6)

Ajouter la definition de la table `audit_results` dans `db/schema.sql` avec les colonnes reelles de production (`id`, `global_score`, `axis_scores`, `findings`, `created_at`, etc.) et la colonne `model TEXT` dans la definition de `cost_tracking`. Ajouter RLS enable + policies pour `pipeline_runs` et `agent_events`.

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `db/schema.sql` | Modifier | Ajouter table `audit_results`, colonne `model` a `cost_tracking`, RLS policies pour `pipeline_runs` et `agent_events` (R2, R6, R8) |
| `src/code-review.ts` | Modifier | Fix noms de colonnes L190-204 : `from_step` -> `step_from`, `to_step` -> `step_to`, supprimer `step` (R3) |
| `src/orchestrator.ts` | Modifier | Fix noms de colonnes L1207-1230 : `from_step` -> `step_from`, `to_step` -> `step_to`, supprimer `step` (R3) |
| `src/alerts.ts` | Modifier | Fix requetes L168, L221 : remplacer `.eq("step", ...)` par filtre valide (R4) |
| `mcp/memory-server.ts` | Modifier | Fix noms de colonnes L1018-1068 : `score` -> `global_score`, `gaps` -> `findings` (R5) |
| `dashboard/server.ts` | Modifier | Fix noms de colonnes audit_results : `score` -> `global_score`, `gaps` -> `findings` (R9) |
| `tests/unit/code-review.test.ts` | Modifier | Adapter assertions : `step`/`from_step`/`to_step` -> `step_from`/`step_to` + metadata (R10) |
| `tests/unit/mcp-audit-tool.test.ts` | Modifier | Adapter assertions : `row.score`/`row.gaps` -> `row.global_score`/`row.findings` (R10) |
| Migration SQL (via MCP) | Creer | 4 tables + 1 colonne + RLS + trigger, avec DROP IF EXISTS pour policies/triggers (R1, R2, R7, R8, R11) |

## 6. Patterns existants

### 6.1 — Insert correct dans workflow_logs (src/workflow.ts)

Le pattern correct est utilise dans `src/workflow.ts:264-268` :
```typescript
await this.supabase.from("workflow_logs").insert({
  task_id: this.taskId,
  sprint_id: this.sprintId,
  step_from: this.currentStep,
  step_to: this.currentStep,
  duration_seconds: 0,
```
Utilise `step_from` et `step_to` (noms corrects). Pas de cle `step`. Ce pattern doit etre replique dans `code-review.ts` et `orchestrator.ts`.

### 6.2 — Insert correct dans workflow_logs (src/adversarial-verifier.ts)

`src/adversarial-verifier.ts:184-189` utilise aussi les bons noms :
```typescript
const { error } = await supabase.from("workflow_logs").insert({
  task_id: taskId,
  step_from: "verification",
  step_to: "verification",
```

### 6.3 — Migration existante avec IF NOT EXISTS

Le schema.sql utilise systematiquement `CREATE TABLE IF NOT EXISTS` et `CREATE INDEX IF NOT EXISTS` (visible sur les 25+ tables declarees). Le pattern est standard dans le projet.

### 6.4 — RLS policy pattern "Allow all"

Les tables sans scoping projet utilisent le pattern simple `CREATE POLICY "Allow all for authenticated" ON <table> FOR ALL USING (true);` (schema.sql L796-800 pour gate_evaluations et trust_scores).

## 7. Contraintes

- **Idempotence obligatoire** : toutes les operations SQL doivent etre rejouables sans erreur (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). Le systeme de migration Supabase ne supporte pas les rollbacks (R7)
- **Compatibilite PostgREST** : les colonnes doivent exister en DB pour que les requetes PostgREST reussissent (PGRST204/205). Pas de type-checking cote client Supabase-js
- **Colonne `tokens_total` dans cost_tracking** : c'est une colonne generee (`GENERATED ALWAYS AS (tokens_input + tokens_output) STORED`). L'ajout de `model TEXT` ne doit pas interferer avec cette colonne
- **Tests existants (2720)** : les modifications TypeScript ne doivent pas casser les tests. Les tests de `mcp/memory-server.ts` (fichier `tests/unit/mcp-audit-tool.test.ts`) verifient la presence de `audit_results?select=` dans le code -- ils devront peut-etre etre ajustes si le select change
- **Pas de suppression** : aucune table, colonne ou donnee ne doit etre supprimee. Toutes les operations sont additives (tables, colonnes, indexes, policies)
- **Foreign keys** : `pipeline_runs.task_id` et `gate_evaluations.task_id` referencent `tasks(id)`. La table `tasks` existe en production
- **Fallback in-memory** : `agent-events.ts` a un fallback in-memory quand la table n'existe pas. Apres creation de la table, le fallback reste en place comme securite -- pas de modification necessaire dans ce fichier
- **Deplacer l'info type** : les cles `step` supprimees dans `code-review.ts` et `orchestrator.ts` portaient une info de typage ("code_review", "orchestration"). Cette info doit etre preservee dans le champ `metadata` pour maintenir la tracabilite et ne pas casser les queries existantes de `alerts.ts` (apres leur correction)

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | Les 4 tables `pipeline_runs`, `gate_evaluations`, `trust_scores`, `agent_events` existent en Supabase apres migration | `mcp__supabase__execute_sql` : `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('pipeline_runs','gate_evaluations','trust_scores','agent_events')` retourne 4 lignes | manual |
| V2 | La colonne `model` existe dans `cost_tracking` apres migration | `mcp__supabase__execute_sql` : `SELECT column_name FROM information_schema.columns WHERE table_name='cost_tracking' AND column_name='model'` retourne 1 ligne | manual |
| V3 | `code-review.ts` insere dans `workflow_logs` avec `step_from` et `step_to` (pas `from_step`/`to_step`/`step`) | Grep du fichier pour absence de `from_step`, `to_step`, `step:` dans le bloc insert | unit |
| V4 | `orchestrator.ts` insere dans `workflow_logs` avec `step_from` et `step_to` (pas `from_step`/`to_step`/`step`) | Grep du fichier pour absence de `from_step`, `to_step`, `step:` dans le bloc insert | unit |
| V5 | `alerts.ts` ne filtre plus sur `.eq("step", ...)` qui n'existe pas dans `workflow_logs` | Grep du fichier pour absence de `.eq("step",` | unit |
| V6 | `mcp/memory-server.ts` requete `global_score` et `findings` (pas `score`/`gaps`) pour audit_results | Grep du fichier pour `global_score` et `findings` dans le bloc audit_codebase ; absence de `score,axis_scores,gaps` dans le select | unit |
| V7 | `db/schema.sql` contient la definition de `audit_results` | Grep de schema.sql pour `CREATE TABLE.*audit_results` | unit |
| V8 | `db/schema.sql` contient `model TEXT` dans la definition de `cost_tracking` | Grep de schema.sql pour `model TEXT` dans le bloc cost_tracking | unit |
| V9 | Les 4 nouvelles tables ont RLS active avec policy "Allow all" | Grep de schema.sql pour `ENABLE ROW LEVEL SECURITY` et `CREATE POLICY` pour pipeline_runs, agent_events, gate_evaluations, trust_scores | unit |
| V10 | La migration est idempotente (rejouable sans erreur) | Appliquer la migration 2 fois consecutivement, la 2eme ne produit pas d'erreur | manual |
| V11 | Les 2720 tests existants passent apres les modifications TypeScript | `bun test` retourne 0 echecs | integration |
| V12 | Les indexes declares dans schema.sql pour les 4 tables sont crees | Migration inclut les `CREATE INDEX IF NOT EXISTS` correspondants | manual |
| V13 | Le trigger `pipeline_runs_updated_at` est cree dans la migration | Migration inclut la fonction trigger et le trigger | manual |
| V14 | L'info type deplacee de `step` vers `metadata` est presente dans les inserts corriges de `code-review.ts` et `orchestrator.ts` | Lecture du code : `metadata` contient une cle `type` ou `event_type` avec la valeur | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | 7 divergences identifiees, 16 operations en echec, 8 modules affectes. L'exploration est exhaustive (comparaison 3 sources de verite) |
| Perimetre | Couvert | Option C (Migration + fix code). Les 7 divergences sont couvertes. L'option D (CI guard) est explicitement exclue du perimetre pour etre traitee dans un sprint ulterieur |
| Validation | Couvert | 14 V-criteres couvrant migration SQL (V1, V2, V10, V12, V13), fix code (V3-V6, V14), schema.sql (V7-V9), et non-regression (V11) |
| Technique | Couvert | Contraintes d'idempotence, compatibilite PostgREST, foreign keys, RLS, colonne generee identifiees. Patterns existants documentes |
| UX | Non applicable | Pas d'interaction utilisateur directe. Les corrections restaurent des fonctionnalites backend (pipeline checkpoint, trust scores, event sourcing, alertes) |
| Alternatives | Couvert | 4 alternatives evaluees dans l'exploration (A: statu quo, B: migration seule, C: migration+fix, D: migration+fix+CI). C retenue comme compromis optimal |

**Zones d'ombre residuelles** :

1. **Structure exacte de `audit_results` en production** : la table a ete creee par une migration (20260320103150) dont le SQL n'est pas disponible localement. Les colonnes identifiees sont `id`, `global_score`, `axis_scores`, `findings`, `created_at` mais la definition complete (types exacts, contraintes, defaults) devra etre verifiee via `mcp__supabase__execute_sql` avant d'ecrire la definition dans schema.sql. A trancher pendant l'implementation.

2. **Fonctions RPC `get_backlog` et `trigger_embed`** : existent en Supabase mais absentes de schema.sql. Non couvertes par cette spec (divergence D6 partielle). A traiter dans un ticket separe si elles sont custom.

3. **Filtre de remplacement dans `alerts.ts`** : le choix entre filtrer sur `step_from` ou sur une cle metadata depend de comment l'info type sera stockee apres correction de `code-review.ts` et `orchestrator.ts`. L'implementation devra s'assurer de la coherence entre les inserts corriges et les queries corrigees.

4. **CI guard (option D)** : un check CI qui compare schema.sql vs les colonnes referencees dans le code eviterait la regression future. Differe au sprint suivant.
