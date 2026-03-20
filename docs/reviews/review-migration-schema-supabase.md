## Revue : Migration schema Supabase — synchronisation DB/code/schema.sql

> Generee le 2026-03-20. Spec : docs/specs/SPEC-migration-schema-supabase.md
> Impact : docs/reviews/impact-SPEC-migration-schema-supabase.md

### Fichiers revises

- dashboard/server.ts
- db/schema.sql
- db/migrations/migration-schema-sync.sql (nouveau)
- mcp/memory-server.ts
- src/alerts.ts
- src/code-review.ts
- src/orchestrator.ts
- tests/unit/code-review.test.ts
- tests/unit/mcp-audit-tool.test.ts

---

### Verification des V-criteres

| V# | Critere | Resultat | Commentaire |
|----|---------|----------|-------------|
| V1 | 4 tables dans la migration | PASS | `CREATE TABLE IF NOT EXISTS` pour pipeline_runs, gate_evaluations, trust_scores, agent_events |
| V2 | Colonne `model` dans cost_tracking | PASS | `ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS model TEXT` L89 |
| V3 | code-review.ts utilise step_from/step_to | PASS | L192: `step_from: "execution"`, L193: `step_to: "review"`. Pas de `from_step`/`to_step`/`step:` |
| V4 | orchestrator.ts utilise step_from/step_to | PASS | L1209: `step_from: "orchestration_start"`, L1210: `step_to: "orchestration_end"`. Pas de `from_step`/`to_step`/`step:` |
| V5 | alerts.ts ne filtre plus sur `.eq("step", ...)` | PASS | Utilise `.eq("metadata->>type", "code_review")` L168 et `.eq("metadata->>type", "orchestration")` L221 |
| V6 | memory-server.ts utilise global_score/findings | PASS | Select: `global_score,axis_scores,findings` L1018. Retour: `score: row.global_score`, `findings: row.findings` L1062-1064. Aucun `row.score`/`row.gaps` residuel |
| V7 | schema.sql contient audit_results | PASS | `CREATE TABLE IF NOT EXISTS audit_results` L1123 avec colonnes correctes |
| V8 | schema.sql contient model TEXT dans cost_tracking | PASS | `model TEXT` dans la definition cost_tracking L363 |
| V9 | RLS pour les 4 tables + audit_results | PASS | schema.sql L796-813 : ENABLE RLS + policy pour gate_evaluations, trust_scores, pipeline_runs, agent_events, audit_results |
| V10 | Migration idempotente | PASS | Tous `IF NOT EXISTS` pour tables/indexes/colonnes. `DROP IF EXISTS` avant `CREATE` pour policies et trigger. `CREATE OR REPLACE` pour la fonction trigger |
| V11 | Tests passent | PASS | `bun test` : 2690 pass, 0 fail |
| V12 | Indexes declares | PASS | Migration inclut tous les indexes de schema.sql pour les 4 tables |
| V13 | Trigger pipeline_runs_updated_at | PASS | Fonction trigger + trigger L102-113. DROP IF EXISTS avant CREATE |
| V14 | Info type dans metadata | PASS | code-review.ts L195: `type: "code_review"`. orchestrator.ts L1212: `type: "orchestration"`. Coherent avec les filtres de alerts.ts et dashboard/server.ts |

---

### Problemes bloquants

Aucun.

---

### Avertissements

1. **[db/migrations/migration-schema-sync.sql:97] Colonne metadata ajoutee a workflow_logs** — La migration ajoute `ALTER TABLE workflow_logs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'` (L97) qui n'est pas dans la spec originale (decouverte en implementation). C'est un ajout necessaire et correct : schema.sql declare deja `metadata JSONB DEFAULT '{}'` a L216, donc la production etait en desynchronisation sur cette colonne aussi. L'idempotence est respectee. Pas de risque, mais a documenter dans les notes de release.

2. **[db/migrations/migration-schema-sync.sql:139-142] RLS ajoute a audit_results** — La migration active RLS + policy sur `audit_results` (L139-142), ce qui n'etait pas explicitement demande par la spec (les R8/R11 mentionnent uniquement les 4 nouvelles tables). C'est un ajout benefique qui aligne audit_results avec le pattern projet (schema.sql L812-813 le declare deja). Aucun risque.

3. **[dashboard/server.ts] handleAudit utilise select("*")** — Le rapport d'impact mentionnait R9 (dashboard utilisant `score`/`gaps`). En realite, `handleAudit` (L641-645) utilise `select("*")` et retourne les donnees brutes sans mapping de colonnes, donc il n'est PAS impacte par le renommage. Les references `row.score` en L567 et L586 concernent respectivement `trust_scores.score` et `gate_evaluations.score` — colonnes reelles et correctes. Le rapport d'impact etait inexact sur ce point, mais le code est correct.

4. **[schema.sql:451] Trigger sans DROP IF EXISTS** — Dans schema.sql L451-453, le trigger `pipeline_runs_updated_at` est declare avec `CREATE TRIGGER` (sans `DROP IF EXISTS`) contrairement a la migration qui utilise `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`. Ce n'est pas un probleme fonctionnel (schema.sql est un fichier de reference, pas execute directement en production), mais l'inconsistance pourrait preter a confusion. Suggestion mineure : aligner schema.sql avec le pattern idempotent.

---

### Suggestions

1. **[db/migrations/migration-schema-sync.sql] Ajouter un COMMENT** — Les 4 tables creees par la migration n'ont pas de `COMMENT ON TABLE` contrairement a schema.sql qui en a (L436, L475, L497, L1118). Pas critique, mais ajouter les commentaires garantirait une coherence totale avec le schema de reference.

2. **[tests/unit/dashboard-audit.test.ts — hors scope]** — Le rapport d'impact mentionne que les mocks dans `dashboard-audit.test.ts` utilisent encore `score`/`gaps` au lieu de `global_score`/`findings`. Comme `handleAudit` fait `select("*")`, les tests passent car les mocks retournent directement des objets, mais les noms de colonnes dans les mocks ne refletent plus la realite DB. A traiter dans un ticket separe pour la coherence des mocks.

3. **[mcp/memory-server.ts:1062] Cle JSON de sortie `score` au lieu de `global_score`** — Dans le bloc sans filtre axis (L1061-1066), la cle de sortie JSON est `score: row.global_score` tandis que dans le bloc avec filtre axis (L1049-1050), c'est `globalScore: row.global_score`. Les deux formes sont correctes en tant que cles d'output JSON (distinctes des noms de colonnes DB), mais l'inconsistance entre `score` (sans filtre) et `globalScore` (avec filtre) peut preter a confusion pour les consommateurs MCP. A unifier si possible dans un ticket ulterieur.

---

### Verification de coherence croisee

| Insert (source) | Filtre (query) | Coherent |
|-----------------|----------------|----------|
| code-review.ts `metadata.type = "code_review"` | alerts.ts `.eq("metadata->>type", "code_review")` | Oui |
| code-review.ts `metadata.type = "code_review"` | dashboard/server.ts `.eq("metadata->>type", "code_review")` | Oui |
| orchestrator.ts `metadata.type = "orchestration"` | alerts.ts `.eq("metadata->>type", "orchestration")` | Oui |
| orchestrator.ts `metadata.type = "orchestration"` | dashboard/server.ts `log.metadata?.type === "orchestration"` | Oui |

La coherence insert/query est totale. Aucune alerte muette possible.

---

### Verification de la migration SQL

| Element | Idempotence | FK correctes | Coherent avec schema.sql |
|---------|-------------|--------------|-------------------------|
| pipeline_runs | IF NOT EXISTS | task_id -> tasks(id) | Oui (L418-434 identiques) |
| gate_evaluations | IF NOT EXISTS | task_id -> tasks(id) | Oui (L458-473 identiques) |
| trust_scores | IF NOT EXISTS | N/A (pas de FK) | Oui (L486-495 identiques) |
| agent_events | IF NOT EXISTS | N/A (pas de FK) | Oui (L1106-1113 identiques) |
| cost_tracking.model | ADD COLUMN IF NOT EXISTS | N/A | Oui (L363 dans schema.sql) |
| workflow_logs.metadata | ADD COLUMN IF NOT EXISTS | N/A | Oui (L216 dans schema.sql) |
| Policies (5 tables) | DROP IF EXISTS + CREATE | N/A | Oui |
| Trigger pipeline_runs | DROP IF EXISTS + CREATE | N/A | Oui |
| Function trigger | CREATE OR REPLACE | N/A | Oui |

---

### Backward compatibility

Toutes les API publiques conservent leur signature. Aucun export modifie. Les modifications sont internes (noms de colonnes dans les queries, colonnes selectionnees). Le seul breaking change est la sortie JSON de l'outil MCP `audit_codebase` dont les cles changent (`score`/`gaps` -> `global_score`/`findings` dans le select SQL), mais comme les anciennes cles etaient deja incorrectes (pointaient vers des colonnes inexistantes qui retournaient null), ce changement corrige un bug plutot que de casser un contrat fonctionnel.

---

### Rapport d'impact : validation

Le rapport d'impact identifiait correctement :
- Les 5 modules directement impactes et les 13 indirectement impactes
- Les 2 fichiers de test a adapter (code-review.test.ts, mcp-audit-tool.test.ts) — correctement adaptes
- La coherence insert/query alerts.ts (zone d'ombre #3) — resolue via `metadata->>type`

Le rapport d'impact etait **inexact** sur un point :
- R9 / dashboard-audit : le rapport indiquait que `dashboard/server.ts` utilisait `row.score`/`row.gaps` pour audit_results, mais la fonction `handleAudit` utilise `select("*")` sans mapping de colonnes. Les `row.score` dans le fichier concernent `trust_scores` et `gate_evaluations`, pas `audit_results`.

---

### Score : 92/100

Implementation solide et methodique. Toutes les corrections de noms de colonnes sont coherentes entre inserts et queries. La migration est idempotente avec un bon usage de `IF NOT EXISTS`, `DROP IF EXISTS`, et `CREATE OR REPLACE`. Les tests sont correctement adaptes et passent tous (2690/2690). L'ajout bonus de la colonne `metadata` sur `workflow_logs` et de RLS sur `audit_results` sont des bonifications justifiees. Les 8 points retires correspondent aux suggestions mineures (commentaires SQL manquants, inconsistance `score`/`globalScore` dans l'output MCP, trigger schema.sql non-idempotent).
