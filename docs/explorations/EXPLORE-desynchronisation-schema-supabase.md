---
phase: 0-explore
generated_at: "2026-03-20T14:30:00+01:00"
subject: "Desynchronisation schema Supabase vs code et schema.sql"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Desynchronisation schema Supabase

## Section 1 -- Probleme

Les logs PM2 revelent 3 erreurs en production apres correction de `.catch(() => {})` silencieux en Phase 1 :
1. **PGRST205** : table `pipeline_runs` manquante
2. **PGRST204** : colonne `from_step` manquante dans `workflow_logs`
3. **PGRST204** : colonne `model` manquante dans `cost_tracking`

Ces erreurs etaient masquees par des catches vides. Le probleme revele un ecart systematique entre 3 sources de verite :
- **db/schema.sql** : schema declare (25 tables)
- **Supabase reel** : schema en production (20 tables + 1 non declaree)
- **Code TypeScript** : colonnes/tables referencees dans les modules src/

L'exploration est necessaire car le probleme depasse les 3 erreurs signalees : une comparaison exhaustive revele **7 divergences distinctes** affectant la fiabilite de 8 modules.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | PostgREST error codes (PGRST204, PGRST205) | Documentation officielle | 2026-03-20 | PGRST205 = table/view not found, PGRST204 = column not found. PostgREST rejette les requetes referençant des objets inexistants | Haute |
| 2 | Supabase Migrations documentation | Documentation officielle | 2026-03-20 | Les migrations Supabase sont incrementales et irreversibles. La CLI `supabase migration` genere des fichiers horodates. L'etat reel est la somme de toutes les migrations appliquees | Haute |

**Synthese** : Le pattern classique de desynchronisation survient quand schema.sql est mis a jour comme "documentation" sans migration correspondante appliquee en production. Les corrections doivent utiliser le systeme de migration Supabase (`apply_migration`) pour garantir la tracabilite et l'idempotence.

L'absence de verification automatisee (CI check schema vs migrations) est la cause racine de la derive progressive.

## Section 3 -- Archeologie codebase

### 3.1 — Inventaire complet des divergences

**Divergence D1 : 4 tables manquantes en production**

| Table | Declaree dans schema.sql | Existe en Supabase | Modules qui l'utilisent |
|-------|:------------------------:|:------------------:|------------------------|
| `pipeline_runs` | Oui (L417-432) | Non | `pipeline-state.ts` (6 refs), `command-router.ts` (1), `commands/help.ts` (1) |
| `gate_evaluations` | Oui (L457-483) | Non | `gate-persistence.ts` (2 refs), `trust-scores.ts` (1), `feedback-loop.ts` (1) |
| `trust_scores` | Oui (L485-499) | Non | `trust-scores.ts` (2 refs) |
| `agent_events` | Oui (L493-) | Non | `agent-events.ts` (2 refs) |

**Impact** : 16 operations Supabase echouent silencieusement. Les modules `pipeline-state.ts`, `gate-persistence.ts`, `trust-scores.ts`, `agent-events.ts`, `feedback-loop.ts` sont fonctionnellement inertes en production.

**Divergence D2 : 1 table en production non declaree dans schema.sql**

| Table | Declaree dans schema.sql | Existe en Supabase | Modules qui l'utilisent |
|-------|:------------------------:|:------------------:|------------------------|
| `audit_results` | Non | Oui (migration 20260320103150) | `dashboard/server.ts`, `mcp/memory-server.ts` |

**Impact** : Fonctionne en production mais schema.sql ne reflete pas la realite.

**Divergence D3 : Colonne `model` manquante dans `cost_tracking`**

- `src/cost-tracking.ts:147` insere `model: entry.model || null`
- `db/schema.sql` ne declare PAS cette colonne
- Supabase reel ne contient PAS cette colonne
- **Impact** : chaque appel a `logCost()` avec un modele specifie produit un PGRST204

**Divergence D4 : Noms de colonnes inverses dans `workflow_logs`**

- Schema.sql et Supabase reel : colonnes `step_from`, `step_to`
- `src/code-review.ts:193-194` insere `from_step`, `to_step` (inverse)
- `src/orchestrator.ts:1210-1211` insere `from_step`, `to_step` (inverse)
- Les deux fichiers inserent aussi `step: "..."` qui n'existe pas comme colonne
- **Impact** : les inserts de code-review et orchestrator echouent (PGRST204). Les logs de workflow pour ces operations ne sont jamais persistes

Note : `src/workflow.ts`, `src/patterns.ts`, `src/adversarial-verifier.ts` utilisent les bons noms (`step_from`, `step_to`) -- l'erreur est localisee a 2 fichiers.

**Divergence D5 : Noms de colonnes dans `audit_results` (code vs DB)**

- `mcp/memory-server.ts:1018` requete `score` et `gaps`
- Supabase reel : colonnes `global_score` et `findings`
- **Impact** : l'outil MCP `audit_codebase` retourne des valeurs nulles pour le score et les findings

**Divergence D6 : Fonctions RPC**

- `get_backlog` : existe en Supabase, absent de schema.sql
- `trigger_embed` : existe en Supabase, absent de schema.sql
- `update_pipeline_runs_updated_at` : declare dans schema.sql, absent de Supabase (coherent avec table manquante)

**Divergence D7 : Trigger `pipeline_runs_updated_at`**

- Declare dans schema.sql (L450-452), absent de Supabase (table support manquante)

### 3.2 — Points de friction

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/pipeline-state.ts` | 6 appels a `pipeline_runs` inexistante | Critique — checkpoint/resume completement casse |
| 2 | `src/gate-persistence.ts` | 2 appels a `gate_evaluations` inexistante | Eleve — gate learning desactive |
| 3 | `src/trust-scores.ts` | 2 appels a `trust_scores` + 1 a `gate_evaluations` | Eleve — trust scores non persistes |
| 4 | `src/agent-events.ts` | 2 appels a `agent_events` inexistante (fallback in-memory) | Moyen — event sourcing non persiste mais fallback existe |
| 5 | `src/feedback-loop.ts` | 1 appel a `gate_evaluations` | Moyen — double-loop learning degrade |
| 6 | `src/code-review.ts` | Mauvais noms de colonnes (`from_step`/`to_step`/`step`) | Eleve — logs de code review perdus |
| 7 | `src/orchestrator.ts` | Mauvais noms de colonnes (`from_step`/`to_step`/`step`) | Eleve — logs d'orchestration perdus |
| 8 | `src/cost-tracking.ts` | Colonne `model` inexistante | Moyen — insert OK mais info model perdue |
| 9 | `mcp/memory-server.ts` | Colonnes `score`/`gaps` au lieu de `global_score`/`findings` | Moyen — outil audit MCP retourne null |
| 10 | `db/schema.sql` | Ne declare pas `audit_results`, `get_backlog`, `trigger_embed` | Faible — documentation incomplete |

### 3.3 — Actifs reutilisables

- **Systeme de migration Supabase** : 24 migrations deja appliquees avec succes, infrastructure rodee
- **MCP `apply_migration`** : permet d'appliquer des migrations directement
- **Tests existants** : 2720 tests, coverage sur les modules concernes permet de valider les fixes code
- **`agent-events.ts`** : possede deja un fallback in-memory, pattern a generaliser

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Migration SQL seule | C: Migration SQL + fix code | D: Migration + fix code + CI guard |
|---------|:------------:|:---------------------:|:--------------------------:|:----------------------------------:|
| **Complexite** | S | S | M | M |
| **Valeur ajoutee** | Low | Med | High | High |
| **Risque technique** | High (erreurs silencieuses) | Low | Low | Low |
| *Impact maintenance* | Derive continue | Stabilise DB | Stabilise DB + code | Empeche regression |
| *Reversibilite* | N/A | Haute (additive SQL) | Haute (additive) | Haute |

**Option A : Status quo** — Les erreurs continuent en silence. Le pipeline checkpoint/resume, trust scores, gate evaluations et agent events sont non fonctionnels. La dette s'accumule a chaque sprint qui ajoute des tables dans schema.sql sans migration.

**Option B : Migration SQL seule** — Creer les 4 tables manquantes + ajouter la colonne `model` a `cost_tracking`. Resout les erreurs PGRST205 mais pas les bugs de noms de colonnes dans le code (D4, D5). Correction partielle.

**Option C : Migration SQL + fix code** — Migration pour les tables/colonnes manquantes ET correction des noms de colonnes dans code-review.ts, orchestrator.ts, memory-server.ts, schema.sql. Resout les 7 divergences identifiees. C'est la correction complete du probleme.

**Option D : Migration + fix code + CI guard** — Option C plus un check CI qui compare schema.sql contre les migrations appliquees et/ou les colonnes referencees dans le code. Empeche la regression future. Investissement additionnel modere pour un benefice durable.

## Section 5 -- Verdict et justification

**Verdict : GO** — avec l'option C (Migration SQL + fix code).

Justification :
1. **7 divergences concretes identifiees** entre 3 sources de verite, dont 4 tables entieres manquantes en production. Le probleme est bien defini et l'inventaire exhaustif (Axe 2).
2. **16 operations Supabase echouent** en production, affectant 8 modules critiques (pipeline-state, gate-persistence, trust-scores, agent-events, feedback-loop, code-review, orchestrator, cost-tracking). L'impact est eleve.
3. **La correction est additive et a faible risque** : les CREATE TABLE IF NOT EXISTS et ALTER TABLE ADD COLUMN sont idempotents. Les fixes code sont des renommages de cles dans 4 fichiers.
4. **L'option D (CI guard) est souhaitable mais peut etre differee** au sprint suivant. La priorite est de restaurer les fonctionnalites cassees.
5. Le systeme de migrations Supabase est deja rode (24 migrations) et l'infrastructure de test (2720 tests) permet de valider les corrections.

## Section 6 -- Input pour etape suivante

### Input pour spec

**Option recommandee** : C — Migration SQL + fix code

**Actions a specifier** :

1. **Migration SQL** (1 fichier de migration Supabase) :
   - `CREATE TABLE IF NOT EXISTS pipeline_runs (...)` — copier la definition de schema.sql L417-432 + trigger L442-452
   - `CREATE TABLE IF NOT EXISTS gate_evaluations (...)` — copier la definition de schema.sql L457-483
   - `CREATE TABLE IF NOT EXISTS trust_scores (...)` — copier la definition de schema.sql L485-499
   - `CREATE TABLE IF NOT EXISTS agent_events (...)` — copier la definition de schema.sql L493+
   - `ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS model TEXT` — ajouter la colonne manquante
   - Inclure les index et RLS policies declarees dans schema.sql pour ces tables

2. **Fix code — noms de colonnes workflow_logs** :
   - `src/code-review.ts:192-194` : remplacer `step` par rien (supprimer), `from_step` → `step_from`, `to_step` → `step_to`
   - `src/orchestrator.ts:1209-1211` : idem

3. **Fix code — noms de colonnes audit_results** :
   - `mcp/memory-server.ts:1018` : remplacer `score` → `global_score`, `gaps` → `findings`
   - `mcp/memory-server.ts:1050` : `row.score` → `row.global_score`
   - `mcp/memory-server.ts:1030` : `gaps` → `findings`
   - `mcp/memory-server.ts:1040-1041` : `row.gaps` → `row.findings`
   - `mcp/memory-server.ts:1051` : `gaps` → `findings`
   - `mcp/memory-server.ts:1064` : `gaps` → `findings`

4. **Mise a jour schema.sql** :
   - Ajouter `audit_results` table definition
   - Ajouter colonne `model TEXT` a `cost_tracking`
   - Ajouter fonctions `get_backlog` et `trigger_embed` si elles sont custom (verifier)

**Fichiers concernes** :
- `db/schema.sql` (mise a jour documentation)
- `src/code-review.ts` (fix colonnes L192-194)
- `src/orchestrator.ts` (fix colonnes L1209-1211)
- `src/cost-tracking.ts` (aucun fix necessaire — le code est correct, c'est la DB qui manque la colonne)
- `mcp/memory-server.ts` (fix colonnes audit_results L1018, 1030, 1040-1041, 1050-1051, 1062, 1064)
- Migration SQL a creer

**Contraintes identifiees** :
- Les CREATE TABLE doivent utiliser `IF NOT EXISTS` pour idempotence
- Les ALTER TABLE doivent utiliser `ADD COLUMN IF NOT EXISTS`
- La migration doit inclure les RLS policies (L686-782 de schema.sql)
- Les tests existants (2720) doivent passer apres les modifications code

**Questions ouvertes** :
- Les fonctions `get_backlog` et `trigger_embed` sont-elles custom ou generees par Supabase ? Si custom, les ajouter a schema.sql
- Faut-il ajouter un CI guard (option D) dans le meme sprint ou le differer ?
- Les modules avec fallback in-memory (`agent-events.ts`) doivent-ils conserver le fallback apres creation de la table ?
