## Rapport d'impact : Migration schema Supabase — synchronisation DB/code/schema.sql

> Genere le 2026-03-20 a partir de docs/specs/SPEC-migration-schema-supabase.md.

### Niveau de risque : HIGH

### Resume

Ce changement impacte directement 5 fichiers source (4 TypeScript + 1 SQL) et cree 4 tables SQL via migration. Le blast radius est significatif : 3 des fichiers modifies (`code-review.ts`, `orchestrator.ts`, `alerts.ts`) sont importes par des modules critiques (agent.ts, auto-pipeline.ts, heartbeat.ts, 3 Composers), et la modification des noms de colonnes dans `mcp/memory-server.ts` casse un test unitaire existant qui verifie le code source par string-matching. Le risque est HIGH a cause de la combinaison (a) renommage de colonnes = breaking changes dans les tests, (b) coherence requise entre inserts corriges et queries corrigees dans alerts.ts, et (c) le dashboard utilise `audit_results` avec les colonnes `score`/`gaps` dans ses tests sans couche d'abstraction.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/code-review.ts` | **Direct** | Insert workflow_logs : `step`/`from_step`/`to_step` remplaces par `step_from`/`step_to`. Suppression cle `step` inexistante |
| `src/orchestrator.ts` | **Direct** | Insert workflow_logs : meme correction que code-review.ts. Info type deplacee dans metadata |
| `src/alerts.ts` | **Direct** | 2 queries `.eq("step", ...)` remplacees par filtre sur metadata ou step_from. Logique de filtrage modifiee |
| `mcp/memory-server.ts` | **Direct** | Select audit_results : `score` -> `global_score`, `gaps` -> `findings`. Toutes references au resultat changees |
| `db/schema.sql` | **Direct** | Ajout table `audit_results`, colonne `model` dans cost_tracking, RLS pour pipeline_runs et agent_events |
| `src/agent.ts` | Indirect | Importe `saveReviewResult` de code-review.ts. Pas de changement de signature — pas casse |
| `src/auto-pipeline.ts` | Indirect | Importe de orchestrator.ts (types seulement). Pas casse |
| `src/heartbeat.ts` | Indirect | Importe `runAllChecks` de alerts.ts. Pas de changement de signature — pas casse |
| `src/commands/quality.ts` | Indirect | Importe `runAllChecks`, `formatAlerts` de alerts.ts. Pas de changement de signature — pas casse |
| `src/commands/help.ts` | Indirect | Importe de alerts.ts et trust-scores.ts. Pas de changement de signature — pas casse |
| `src/commands/zz-messages.ts` | Indirect | Importe `recordResponseTime` de alerts.ts. Pas de changement de signature — pas casse |
| `src/commands/execution.ts` | Indirect | Importe de orchestrator.ts. Pas de changement de signature — pas casse |
| `src/pipeline-state.ts` | Indirect | Ecrit dans `pipeline_runs` (table creee par migration). Deja en fallback in-memory. Beneficiaire |
| `src/agent-events.ts` | Indirect | Ecrit dans `agent_events` (table creee par migration). Deja en fallback in-memory. Beneficiaire |
| `src/trust-scores.ts` | Indirect | Ecrit dans `trust_scores` (table creee par migration). Deja en fallback in-memory. Beneficiaire |
| `src/gate-persistence.ts` | Indirect | Ecrit dans `gate_evaluations` (table creee par migration). Beneficiaire |
| `src/feedback-loop.ts` | Indirect | Lit `gate_evaluations`. Beneficiaire |
| `src/cost-tracking.ts` | Indirect | Insere `model` dans cost_tracking. Colonne ajoutee par migration. Beneficiaire |
| `src/workflow.ts` | Aucun | Utilise deja `step_from`/`step_to` correctement. Pattern de reference |
| `src/adversarial-verifier.ts` | Aucun | Utilise deja `step_from`/`step_to` correctement. Pattern de reference |
| `src/patterns.ts` | Aucun | Lit `step_from` correctement. Pas impacte |
| `dashboard/server.ts` | Indirect | Requete `audit_results` avec `select("*")` — pas de colonnes explicites, pas casse |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/code-review.ts` | `saveReviewResult()` | Modification interne (noms de colonnes dans insert) | **Oui** — signature inchangee |
| `src/orchestrator.ts` | `logOrchestrationResult()` | Modification interne (noms de colonnes dans insert) | **Oui** — fonction privee (non exportee) |
| `src/alerts.ts` | `checkReviewScoreDrop()` | Modification logique (filtre query) | **Oui** — signature inchangee, semantique du retour identique |
| `src/alerts.ts` | `checkAgentFailurePatterns()` | Modification logique (filtre query) | **Oui** — signature inchangee, semantique du retour identique |
| `mcp/memory-server.ts` | Tool `audit_codebase` | Modification select + output JSON keys | **Non** — les cles JSON de sortie changent (`score` -> `global_score`, `gaps` -> `findings`) |

### Breaking changes potentiels

- [x] **Test `tests/unit/code-review.test.ts` L387-389** : verifie `insertData[0].data.step === "code_review"`, `insertData[0].data.from_step === "execution"`, `insertData[0].data.to_step === "review"`. Apres correction, `step` n'existe plus et `from_step`/`to_step` deviennent `step_from`/`step_to`. **3 assertions cassees** — impact : `tests/unit/code-review.test.ts`

- [x] **Test `tests/unit/mcp-audit-tool.test.ts` L38-41** : verifie la presence de `"score: row.score"`, `"gaps: row.gaps"`, `"globalScore: row.score"` dans le code source par string-matching. Apres correction (`row.score` -> `row.global_score`, `row.gaps` -> `row.findings`), **4 assertions cassees** — impact : `tests/unit/mcp-audit-tool.test.ts`

- [x] **Test `tests/unit/dashboard-audit.test.ts` L15-24, L39, L53-54** : utilise `makeAudit()` avec colonnes `score` et `gaps`. Le test mock utilise `select("*")` donc les colonnes retournees par le mock refletent les noms du mock (pas les noms reels DB). Comme `dashboard/server.ts` fait `select("*")` et les tests mockent localement, **les tests ne sont pas directement casses par le changement code**, mais le mock ne reflete plus la realite DB (`score` devrait etre `global_score`, `gaps` devrait etre `findings`). Risque de confusion/maintenance — impact : `tests/unit/dashboard-audit.test.ts`

- [x] **Output MCP `audit_codebase`** : les consommateurs externes (Claude, MCP clients) recevaient `{ score, axis_scores, gaps }` et recevront `{ global_score, axis_scores, findings }`. Tout prompt ou agent qui parse ces cles par nom sera casse — impact : tout agent utilisant l'outil MCP `audit_codebase`

- [x] **Coherence insert/query alerts.ts** : si `code-review.ts` et `orchestrator.ts` deplacent l'info type dans `metadata` (ex: `metadata.type = "code_review"`), les queries corrigees dans `alerts.ts` doivent utiliser exactement les memes cles metadata. Une incoherence entre l'insert et le query rendrait les alertes muettes — impact : `src/alerts.ts`, `src/code-review.ts`, `src/orchestrator.ts`

### Points d'attention pour le Reviewer

1. **Coherence des filtres alerts.ts avec les inserts corriges** : la spec laisse le choix du filtre de remplacement dans `alerts.ts` (zone d'ombre #3). Le Reviewer doit verifier que la cle utilisee dans `checkReviewScoreDrop()` (ex: `.contains("metadata", { type: "code_review" })`) correspond exactement a la cle inseree dans `saveReviewResult()` de `code-review.ts`, et de meme pour `checkAgentFailurePatterns()` avec `logOrchestrationResult()` de `orchestrator.ts`. Verifier `src/alerts.ts:165-172` et `src/alerts.ts:218-224` vs `src/code-review.ts:190-203` et `src/orchestrator.ts:1207-1231`.

2. **Tests a adapter obligatoirement** : au minimum 2 fichiers de test doivent etre modifies pour que `bun test` passe (V11). `tests/unit/code-review.test.ts` (L387-389 : `step` -> supprime, `from_step` -> `step_from`, `to_step` -> `step_to`, ajouter assertion sur `metadata.type`) et `tests/unit/mcp-audit-tool.test.ts` (L38-41 : `score: row.score` -> `global_score: row.global_score`, `gaps: row.gaps` -> `findings: row.findings`, `globalScore: row.score` -> `globalScore: row.global_score`). La spec ne mentionne pas explicitement ces adaptations de tests.

3. **Dashboard test mock divergence** : `tests/unit/dashboard-audit.test.ts` utilise des mocks avec colonnes `score`/`gaps` qui ne correspondent plus aux noms reels en production (`global_score`/`findings`). Meme si les tests passent (car le mock bypass la DB), ils valident un contrat incorrect. Le Reviewer doit decider si les mocks doivent etre corriges dans ce PR ou dans un ticket separe.

4. **Output MCP breaking change** : le changement des cles JSON dans l'output de l'outil `audit_codebase` (`score`→`global_score`, `gaps`→`findings`) est un breaking change pour les consommateurs MCP. La description de l'outil dans `memory-server.ts` (L1006-1010) mentionne "global score" et "findings (gaps)" ce qui est coherent avec les nouveaux noms, mais les consommateurs existants (prompts, agents, scripts) qui parsent `score` et `gaps` seront casses. Verifier `mcp/memory-server.ts:1058-1067`.

5. **Idempotence de la migration SQL** : verifier que la migration utilise bien `CREATE TABLE IF NOT EXISTS` et `ADD COLUMN IF NOT EXISTS` pour les 5 operations (V10). Attention particuliere a la colonne `model TEXT` dans `cost_tracking` : la colonne generee `tokens_total` ne doit pas etre impactee (V2, contrainte spec).

6. **RLS manquant pour pipeline_runs et agent_events dans schema.sql** : la spec demande d'ajouter RLS dans schema.sql (R8) mais schema.sql n'a actuellement ni `ENABLE ROW LEVEL SECURITY` ni policy pour ces 2 tables (alors que `gate_evaluations` et `trust_scores` en ont deja, L795-800). Le Reviewer doit verifier que la migration inclut les `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` et `CREATE POLICY` pour `pipeline_runs` et `agent_events`, et que schema.sql est mis a jour en coherence.

### Blast radius

- Modules directement modifies : **5** (code-review.ts, orchestrator.ts, alerts.ts, mcp/memory-server.ts, db/schema.sql)
- Modules indirectement impactes : **13** (agent.ts, auto-pipeline.ts, heartbeat.ts, commands/quality.ts, commands/help.ts, commands/zz-messages.ts, commands/execution.ts, pipeline-state.ts, agent-events.ts, trust-scores.ts, gate-persistence.ts, feedback-loop.ts, cost-tracking.ts)
- Fichiers source modifies : **5** + 1 migration SQL
- Fichiers de test a verifier : **4** (code-review.test.ts, mcp-audit-tool.test.ts, dashboard-audit.test.ts, pipeline-state.test.ts)
