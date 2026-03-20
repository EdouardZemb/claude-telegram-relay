# Adversarial Review — SPEC-migration-schema-supabase

> Date : 2026-03-20
> Spec : docs/specs/SPEC-migration-schema-supabase.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic

---

## Synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|-----------------|------------------|-------------------|-------|
| BLOQUANT | 1 | 1 | 0 | 2 |
| MAJEUR   | 3 | 3 | 2 | 8 |
| MINEUR   | 2 | 2 | 3 | 7 |
| **Total** | **6** | **6** | **5** | **17** |

### Verdict : GO WITH CHANGES

**Justification** : 2 BLOQUANTs identifies, tous deux resolvables en modifiant la spec sans remettre en cause l'architecture. 8 MAJEURs necessitent des ajustements. La spec est solide sur le fond — les divergences sont reelles et bien documentees — mais presente des lacunes de couverture (dashboard non traite, tests a adapter, spec incomplete sur audit_results) qui doivent etre resolues avant implementation.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — dashboard/server.ts utilise `score`/`gaps` sur audit_results mais n'est pas couvert par la spec**
- Source : Section 5 (Fichiers concernes) / R5
- Description : La spec identifie R5 uniquement pour `mcp/memory-server.ts`, mais `dashboard/server.ts:563,582` accede aussi a `row.score` sur les resultats de `audit_results`. Le dashboard fait un `select("*")` (L639) donc les colonnes sont retournees par Supabase avec leurs vrais noms (`global_score`, `findings`), mais le code les lit ensuite via `row.score` (L563, L582) et non `row.global_score`. Ce fichier n'est pas dans le perimetre de correction de la spec.
- Impact : Apres la migration, le dashboard continuera de retourner `null` pour le score audit car il lit `row.score` alors que la colonne reelle est `global_score`. Le bug sera perpetue dans un module non couvert.
- Evidence : `dashboard/server.ts:563` — `score: row.score` ; `dashboard/server.ts:654` — `row.axis_scores` (celui-ci est correct). Le `select("*")` retourne les colonnes avec leurs noms reels PostgreSQL.

**[MAJEUR] F-DA-2 — Tests existants codent en dur les mauvais noms de colonnes**
- Source : Section 7 (Contraintes) / V11
- Description : La spec mentionne que les tests de `tests/unit/mcp-audit-tool.test.ts` "devront peut-etre etre ajustes" (formulation equivoque). En realite, les tests L32-41 verifient explicitement `expect(auditSection).toContain("score: row.score")` et `expect(auditSection).toContain("gaps: row.gaps")`. Ces tests CASSERONT obligatoirement apres le fix R5. La spec devrait lister ce fichier dans les fichiers a modifier (Section 5) et non le releguer en note.
- Impact : V11 (2720 tests passent) est garanti de FAIL si les tests ne sont pas mis a jour. L'implementation risque d'etre bloquee par la decouverte tardive.

**[MAJEUR] F-DA-3 — Incoherence entre R8 et l'etat reel de schema.sql pour pipeline_runs et agent_events**
- Source : R8 / Section 4.1
- Description : R8 affirme que "pipeline_runs et agent_events n'en ont pas [de RLS]" dans schema.sql. Verification : schema.sql ne contient effectivement pas d'`ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY` ni de policy pour `pipeline_runs` et `agent_events`. C'est correct. Cependant, la spec propose un RLS "Allow all" pour ces tables mais ne mentionne pas si la migration doit aussi ajouter les `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` a schema.sql. La Section 4.3 ne mentionne que le RLS pour `pipeline_runs` et `agent_events`, mais Section 5 le mentionne. Coherence ambigue.
- Impact : Si l'implementeur ne met a jour que la migration SQL sans modifier schema.sql, le fichier de reference diverge a nouveau de la production.

**[MAJEUR] F-DA-4 — Hypothese non verifiee sur la structure de audit_results**
- Source : Zone d'ombre 1 (Section 9) / R6
- Description : La spec propose d'ajouter `audit_results` dans schema.sql mais reconnait ne pas connaitre la structure exacte (types, contraintes, defaults). Pourtant, R6 est formulee comme une regle ferme et V7 valide la presence du CREATE TABLE. La spec prescrit une action (ecrire la DDL) sans avoir les donnees necessaires pour l'executer correctement. C'est une decision prematuree.
- Impact : L'implementeur devra faire un travail de decouverte (via `mcp__supabase__execute_sql`) qui n'est pas budgete dans la spec. Si la structure decouverte differe des hypotheses, la DDL pourrait etre incorrecte.

**[MINEUR] F-DA-5 — La spec affirme "16 operations en echec silencieux" sans listing exhaustif**
- Source : Section 1 (Objectif)
- Description : Le chiffre "16 operations Supabase en echec silencieux" est cite mais jamais decompose en un inventaire precis. On peut reconstituer : 2 inserts workflow_logs (code-review, orchestrator), 2 queries alerts.ts, 1 select audit_results (MCP), quelques operations pipeline_runs/gate_evaluations/trust_scores/agent_events. Mais le total de 16 n'est pas trace.
- Impact : Faible — le chiffre sert d'accroche, pas de critere de validation.

**[MINEUR] F-DA-6 — L'option de filtre metadata pour alerts.ts est sous-specifiee**
- Source : Section 4.2 (alerts.ts) / Zone d'ombre 3
- Description : La spec propose de remplacer `.eq("step", "code_review")` par `.not("metadata->score", "is", null)` mais cette heuristique est fragile : tout workflow_log avec un score en metadata serait matche, pas seulement les code reviews. La spec reconnaitra ce probleme en zone d'ombre 3 mais ne le resout pas.
- Impact : Le filtre de remplacement pourrait matcher des faux positifs si d'autres types de logs contiennent un champ `score` en metadata.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — Execution concurrente de la migration et du bot**
- Scenario : La migration cree 4 tables et ajoute une colonne. Pendant l'execution de la migration, le bot continue de tourner (PM2 `claude-relay`). Les modules `pipeline-state.ts`, `agent-events.ts`, `gate-persistence.ts` et `cost-tracking.ts` font des inserts fire-and-forget vers ces tables. Si la migration est a mi-chemin (ex: `pipeline_runs` cree mais pas encore `agent_events`), les modules qui insistent sur `agent_events` echoueront toujours (pas de changement), mais le fallback in-memory de `agent-events.ts` couvre ce cas. Cependant, `cost-tracking.ts` insere `model` sans fallback — si la colonne n'est pas encore ajoutee au moment de l'insert, PostgREST rejettera l'insert entier (PGRST204), perdant TOUTES les colonnes de cette ligne de cout, pas seulement `model`.
- Source : R2 / Section 7 (Contrainte sur `tokens_total`)
- Impact : Perte de donnees de cout pendant la fenetre de migration. `cost-tracking.ts:147` insere `model: entry.model || null` — si la colonne n'existe pas, l'insert entier echoue, pas seulement le champ model.
- Frequence estimee : Rare (fenetre de migration courte), mais impact potentiellement significatif si une pipeline est en cours.

**[MAJEUR] F-EC-2 — Pas de rollback prevu en cas d'echec partiel de la migration**
- Scenario : La migration est un script unique qui execute CREATE TABLE, ALTER TABLE, ALTER TABLE ENABLE RLS, CREATE POLICY en sequence. Si le CREATE TABLE pipeline_runs reussit mais le CREATE POLICY echoue (ex: nom de policy deja existant sans IF NOT EXISTS), la migration echoue a mi-parcours. Les tables seront crees mais sans RLS.
- Source : R7 (idempotence) / Section 4.1
- Impact : Etat inconsistant : tables creees sans policies. La spec exige l'idempotence (R7) mais ne mentionne pas l'idempotence des `CREATE POLICY`. En PostgreSQL, `CREATE POLICY` n'a pas de `IF NOT EXISTS`. Il faudrait un `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` ou un `DROP POLICY IF EXISTS` suivi de `CREATE POLICY`.
- Frequence estimee : Occasionnel — probable si la migration est rejouee (test, correction).

**[MAJEUR] F-EC-3 — Foreign key pipeline_runs.task_id vers tasks(id) sans gestion de NULL**
- Scenario : `pipeline-state.ts` cree des `pipeline_runs` avec un `task_id`. Si un pipeline est lance sans task_id (valeur null/undefined), le FK constraint pourrait bloquer l'insert. Le schema.sql montre `task_id UUID REFERENCES tasks(id)` sans NOT NULL, donc NULL est autorise. Cependant, si le code passe un task_id invalide (UUID malformed), l'insert echouera avec une FK violation.
- Source : Section 7 (Foreign keys) / R1
- Impact : Pipeline crash silencieux si task_id est invalide. Le fallback in-memory de pipeline-state.ts couvre ce cas, mais les donnees sont perdues.
- Frequence estimee : Rare — le task_id est generalement valide quand il passe par le workflow normal.

**[MAJEUR] F-EC-4 — Le trigger updated_at pour pipeline_runs peut confliter avec un trigger existant**
- Scenario : La migration cree `CREATE OR REPLACE FUNCTION update_pipeline_runs_updated_at()` et `CREATE TRIGGER pipeline_runs_updated_at`. Si la table existe deja en production (creee manuellement ou par une migration precedente), le trigger pourrait deja exister. `CREATE TRIGGER` n'a pas de `IF NOT EXISTS` en PostgreSQL standard (seulement depuis PG 15 avec `OR REPLACE`). Si le trigger existe, la migration echoue.
- Source : Section 4.1 / R7 (idempotence)
- Impact : Migration non idempotente contrairement a R7. Le trigger `CREATE TRIGGER pipeline_runs_updated_at` sans `IF NOT EXISTS` ni `DROP TRIGGER IF EXISTS` casserait l'idempotence.
- Frequence estimee : Occasionnel si la table existe deja en production.

**[MINEUR] F-EC-5 — Race condition entre correction code-review.ts et alerts.ts**
- Scenario : Si les corrections TypeScript sont deployees sans la migration SQL (deploy code avant migration), les inserts corriges de `code-review.ts` utiliseront `step_from`/`step_to` (bons noms) mais l'info type sera dans metadata. Pendant ce temps, les anciennes donnees en DB ont `step: "code_review"` qui n'est pas une colonne. En fait, ces anciennes lignes n'avaient jamais de colonne `step` — le champ etait simplement ignore par PostgREST. Donc alerts.ts avec l'ancien code `.eq("step", "code_review")` retourne deja vide. Pas de regression, mais la correction de alerts.ts doit gerer le fait qu'il n'y aura jamais de donnees historiques avec le bon format metadata.
- Source : Section 4.2 / Zone d'ombre 3
- Impact : alerts.ts apres correction ne trouvera aucune donnee historique car les anciennes lignes n'ont pas de metadata avec `type: "code_review"`. Les alertes review_score_drop et agent_failure_patterns seront vides jusqu'a ce que de nouvelles donnees soient inserees.
- Frequence estimee : Certain au premier deploiement. Impact temporaire.

**[MINEUR] F-EC-6 — Colonne `model` ajoutee a cost_tracking mais pas dans le select des aggregations**
- Scenario : `cost-tracking.ts:169` fait un select avec `task_id, agent_role, agent_name, tokens_input, tokens_output, cost_usd` — la colonne `model` n'est pas selectionnee dans les aggregations. La colonne sera inserable mais jamais lue dans les rapports de couts. Ce n'est pas un bug introduit par la spec, mais la spec ne mentionne pas la necessite d'ajouter `model` aux queries de lecture.
- Source : R2 / Section 4.2
- Impact : La colonne `model` sera inseree mais invisible dans les rapports. La valeur ajoutee de R2 est reduite a la tracabilite brute (requete SQL directe).
- Frequence estimee : Permanent — la colonne est inutile sans lecture.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — RLS "Allow all" est du theatre de securite**
- Source : R8 / Section 4.1 / Pattern 6.4
- Description : La spec exige d'activer RLS et de creer des policies "Allow all for authenticated" sur les 4 nouvelles tables. C'est exactement equivalent a ne pas avoir de RLS. Le pattern `FOR ALL USING (true)` autorise tout pour tout le monde. Ajouter RLS + "Allow all" ajoute de la complexite (6 lignes SQL par table) sans aucun benefice de securite.
- Alternative : Ne pas activer RLS sur ces tables (comme c'est le cas actuellement en production). Ou mieux : documenter dans la spec pourquoi le RLS existe (coherence avec les autres tables ? futur scoping projet ?) pour justifier le cout.
- Codebase : Le pattern est deja utilise dans schema.sql pour `cost_tracking`, `blackboard`, `memory_archive`, etc. (L782-788). C'est coherent avec le codebase, mais la coherence n'excuse pas la sur-ingenierie si le pattern original est deja du theatre.

**[MAJEUR] F-SS-2 — La spec combine migration SQL et corrections code dans un meme ticket**
- Source : Structure globale de la spec (Sections 4.1 + 4.2 + 4.3)
- Description : La spec regroupe 3 types de changements fondamentalement differents : (1) migration SQL de schema, (2) corrections de noms de colonnes dans du TypeScript, (3) mise a jour de la documentation schema.sql. Ces 3 axes ont des risques differents, des methodes de test differentes, et des ordres de deploiement differents. Les combiner dans un seul ticket augmente le risque d'echec en cascade et rend le code review plus lourd.
- Alternative : Decomposer en 2-3 PRs : (a) corrections TypeScript (zero risk, testable en isolation), (b) migration SQL + schema.sql (necessite coordination production), (c) ajout audit_results dans schema.sql (documentation pure). L'exploration originale mentionnait l'option C comme "migration + fix code" mais ne justifiait pas pourquoi un seul ticket est preferable a un decoupage.
- Codebase : Le projet utilise des feature branches avec PR individuelles. Un decoupage serait plus conforme au workflow git du projet.

**[MINEUR] F-SS-3 — Le trigger updated_at pour pipeline_runs est potentiellement inutile**
- Source : R1 / Section 4.1
- Description : La spec exige un trigger `updated_at` pour `pipeline_runs`. Verification dans le code : `pipeline-state.ts` utilise `.upsert()` et `.update()` sans jamais lire `updated_at`. Aucun module ne filtre ou tri par `updated_at` sur `pipeline_runs`. Le trigger ajoute de la complexite SQL sans utilisateur connu.
- Alternative : Ne pas creer le trigger. Ajouter `updated_at` comme colonne DEFAULT NOW() suffit, le trigger ne sera utile que si un query filtre/tri dessus.
- Codebase : Le trigger est declare dans schema.sql (L442-452) donc c'est coherent avec la documentation existante. Mais si la table n'existe pas encore en production, c'est l'occasion de questionner la necessite du trigger.

**[MINEUR] F-SS-4 — 14 criteres de validation pour 7 divergences est sur-specifie**
- Source : Section 8
- Description : 14 V-criteres pour corriger 7 divergences (ratio 2:1). Certains criteres sont redondants : V3 et V4 verifient la meme chose (bons noms de colonnes) dans 2 fichiers differents. V7, V8, V9 verifient tous schema.sql. V12 et V13 verifient des elements de la migration deja couverts par V1 et V10.
- Alternative : Reduire a 8-9 criteres en groupant par type de verification (migration OK, code fixe, schema.sql a jour, tests passent).
- Codebase : Les specs precedentes dans docs/specs/ utilisent des V-criteres mais avec un ratio plus raisonnable.

**[MINEUR] F-SS-5 — Zone d'ombre 2 (RPCs get_backlog et trigger_embed) est hors sujet**
- Source : Section 9, Zone d'ombre 2
- Description : La spec mentionne des RPCs `get_backlog` et `trigger_embed` absentes de schema.sql comme zone d'ombre, mais dit explicitement qu'elles sont "non couvertes par cette spec". Les mentionner ajoute du bruit sans valeur actionnable. Une spec doit couvrir son perimetre, pas inventorier tout ce qui existe ailleurs.
- Alternative : Supprimer cette zone d'ombre ou la releguer en commentaire hors spec (ex: dans un ticket separe).

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 3

---

## Findings dedupliques (multi-agent)

Les findings suivants ont ete identifies par plusieurs agents :

| Finding | Agents | Severite retenue |
|---------|--------|-----------------|
| Idempotence CREATE POLICY / CREATE TRIGGER non garantie | F-DA-3 (partiel) + F-EC-2 + F-EC-4 | MAJEUR |
| Structure audit_results inconnue, spec prescrit une action sans donnees | F-DA-4 + F-SS-5 (lie) | MAJEUR |
| alerts.ts — filtre metadata fragile, manque de donnees historiques | F-DA-6 + F-EC-5 | MINEUR |

---

## Recommandations (actions pour passer a GO)

1. **[BLOQUANT a resoudre] Ajouter `dashboard/server.ts` au perimetre** (F-DA-1) : Les lignes L563, L582 utilisent `row.score` au lieu de `row.global_score` et `row.gaps` au lieu de `row.findings` pour les audit_results. Ajouter ce fichier a la Section 5 et aux corrections Section 4.2.

2. **[BLOQUANT a resoudre] Gerer la concurrence migration/bot** (F-EC-1) : Ajouter une contrainte d'ordre de deploiement dans la spec : (a) appliquer la migration SQL, (b) puis deployer le code TypeScript. Ou documenter que `cost-tracking.ts` doit gerer le rejet PostgREST gracieusement (il le fait deja via try/catch L150).

3. **[MAJEUR] Lister explicitement `tests/unit/mcp-audit-tool.test.ts` dans les fichiers a modifier** (F-DA-2) : Les tests L32-41 cassent obligatoirement. Ajouter aussi `tests/unit/dashboard-audit.test.ts` si les noms de colonnes y sont testes.

4. **[MAJEUR] Garantir l'idempotence des policies et triggers** (F-EC-2, F-EC-4) : Utiliser `DROP POLICY IF EXISTS ... ; CREATE POLICY ...` et `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ...` dans la migration pour respecter R7.

5. **[MAJEUR] Verifier la structure audit_results avant implementation** (F-DA-4) : Promouvoir la zone d'ombre 1 en prerequis de l'implementation : executer `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='audit_results'` en production AVANT de rediger la DDL dans schema.sql.

6. **[MINEUR] Documenter l'ordre de deploiement** : migration SQL avant code TypeScript, ou justifier que le fallback try/catch de chaque module est suffisant.

7. **[MINEUR] Preciser la strategie de filtre pour alerts.ts** (F-DA-6, F-EC-5) : Choisir entre filtrer sur `step_from` (plus fiable) ou sur metadata (plus flexible) et documenter ce choix dans la spec pour eviter l'ambiguite pendant l'implementation.

---

## Points forts identifies

- **Analyse exhaustive des divergences** : la comparaison 3 sources de verite (Supabase prod, schema.sql, code TS) est methodique et complete.
- **Documentation des patterns existants** (Section 6) : les bons exemples de `workflow.ts` et `adversarial-verifier.ts` facilitent l'implementation.
- **Idempotence comme contrainte architecturale** (R7) : bonne pratique pour un systeme sans rollback natif.
- **Fallback in-memory identifies** (Section 7) : la spec reconnait correctement que `agent-events.ts` a un fallback et ne necessite pas de modification.
- **V-criteres avec methodes de verification** : chaque critere est testable (grep, SQL, bun test).

---

## Etape suivante

Verdict **GO WITH CHANGES** : mettre a jour `docs/specs/SPEC-migration-schema-supabase.md` selon les 7 recommandations ci-dessus, puis lancer :
```
/dev-implement "Implementer SPEC-migration-schema-supabase. Spec: docs/specs/SPEC-migration-schema-supabase.md"
```
