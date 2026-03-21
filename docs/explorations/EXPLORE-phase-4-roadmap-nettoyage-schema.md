---
phase: 0-explore
generated_at: "2026-03-20T18:30:00+01:00"
subject: "Nettoyage schema Supabase — tables et RPCs mortes"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Nettoyage schema Supabase — tables et RPCs mortes

## Section 1 — Probleme

Le schema Supabase (`db/schema.sql`) declare 25 tables et 12 RPCs. L'audit post-Phase 2 (ROADMAP-REFONTE.md Phase 4) a identifie 5 tables et 6 RPCs potentiellement mortes — jamais requetees par le code applicatif. L'exploration doit verifier si ces elements ont des consommateurs externes (Edge Functions, MCP server, dashboard, webhooks, smoke tests, examples/) et decider pour chacun : supprimer, conserver, ou documenter.

Le risque principal est de supprimer un element utilise par un consommateur indirect (Edge Function deployee sur Supabase, RLS policy active) et de casser la production. L'exploration est necessaire avant de specifier car la reponse n'est pas binaire : certains elements sont "morts dans src/" mais vivants ailleurs.

## Section 2 — Etat de l'art

Axe "Non couvert" — Le sujet est purement interne au projet (nettoyage de schema d'une application specifique). Il n'y a pas de documentation externe, benchmark ou retour d'experience pertinent a chercher. Les bonnes pratiques generales (ne pas supprimer ce qui est utilise par des triggers/policies, migrer de facon reversible) sont connues et appliquees dans l'analyse ci-dessous.

> Note : l'axe 1 etant non couvert, le verdict ne peut pas etre base uniquement sur des sources externes. Il est neanmoins GO car le sujet est entierement interne et l'archeologie codebase (axe 2) est exhaustive.

**Degradation verdict** : Bien que l'axe 1 soit "Non couvert", le sujet est purement interne (nettoyage de schema projet-specifique) et ne necessite aucune source externe. L'exhaustivite de l'axe 2 compense ce manque. Le verdict GO est justifie par l'exception "sujet 100% interne".

## Section 3 — Archeologie codebase

### 3a. Tables — analyse d'usage detaillee

| # | Table | Consommateurs identifies | Verdict |
|---|-------|--------------------------|---------|
| 1 | `logs` | Uniquement `scripts/smoke-test.ts` (insert+delete pour tester la connectivite Supabase). 0 usage dans `src/`, `mcp/`, `dashboard/`, `supabase/functions/`. | MORTE — remplacer le smoke test par une autre table |
| 2 | `workflow_proposals` | 0 usage dans tout le codebase (src/, mcp/, dashboard/, supabase/, tests/). Declaree dans schema.sql L325-347. Mentionnee uniquement dans README.md et CLAUDE.md (documentation). | MORTE — supprimer |
| 3 | `audit_results` | `dashboard/server.ts:642` (.from("audit_results")), `mcp/memory-server.ts:1018` (REST API call). 0 usage dans `src/`. Tests associes : `tests/unit/dashboard-audit.test.ts`, `tests/unit/mcp-audit-tool.test.ts`. | VIVANTE via dashboard + MCP — conserver |
| 4 | `memory_archive` | 0 `.from("memory_archive")` dans tout le codebase. Cible de la RPC `archive_old_memories` (INSERT INTO memory_archive, schema.sql L1037). Jamais lue directement. | SEMI-MORTE — cible d'ecriture uniquement, jamais lue |
| 5 | `memory_links` | Interface `MemoryLink` dans `src/memory.ts:47`. RPCs `link_memory` et `get_linked_memories` dans schema.sql L532-660. Fonctions `linkMemories()`, `getLinkedMemories()`, `getLinkedMemoriesBatch()` dans `src/memory.ts` appelees par `memory-cmds.ts`. Trigger `auto_link_memory` (schema.sql L614-632). Tests : `tests/unit/memory-links.test.ts`. | VIVANTE — conserver |

### 3b. RPCs — analyse d'usage detaillee

| # | RPC | Consommateurs identifies | Verdict |
|---|-----|--------------------------|---------|
| R1 | `get_recent_messages` | 0 appels `.rpc("get_recent_messages")` dans src/. Seul usage : `examples/morning-briefing.ts:104` (fichier d'exemple, non deploye). Definie schema.sql L832. | MORTE — supprimer (l'exemple est obsolete) |
| R2 | `match_messages` | 0 appels `.rpc("match_messages")` dans src/. Utilisee par Edge Function `supabase/functions/search/index.ts:68` comme fallback pour `table === "messages"`. | VIVANTE via Edge Function — conserver |
| R3 | `match_memory` | 0 appels `.rpc("match_memory")` dans src/. Utilisee par Edge Function `search/index.ts:66` et `memory-mcp/index.ts:61`. | VIVANTE via Edge Functions — conserver |
| R4 | `match_documents` | 0 appels `.rpc("match_documents")` dans src/. Utilisee par Edge Function `search/index.ts:67`. Tests : `tests/unit/document-schema.test.ts`. | VIVANTE via Edge Function — conserver |
| R5 | `set_project_scope` | 0 appels `.rpc("set_project_scope")` dans tout le codebase. Definie schema.sql L711. Pas utilisee par le code applicatif ni par les Edge Functions. | MORTE en pratique — mais fait partie de l'infra RLS |
| R6 | `current_project_id` | Jamais appelee directement. MAIS utilisee dans 9 RLS policies (schema.sql L724, 733, 738, 745, 752, 757, 763, 772, 823) pour le filtrage project-scoped. | VIVANTE via RLS — NE PAS SUPPRIMER |
| R7 | `archive_old_memories` | `src/memory.ts:1180` (.rpc("archive_old_memories")). Appelee par `archiveOldMemories()`, invoquee par `heartbeat.ts:528` (toutes les heures). Tests : `tests/unit/memory.test.ts:797-824`. | VIVANTE — conserver |

### 3c. Synthese des dependances critiques

**Dependances cachees identifiees :**

1. **`current_project_id()` + `set_project_scope()`** : ces deux fonctions forment le mecanisme RLS project-scoped. `current_project_id()` est referencee dans 9 policies RLS actives. Supprimer l'une ou l'autre casserait toutes les requetes filtrees par projet. Le fait que `set_project_scope` ne soit jamais appele depuis le code signifie que le filtrage RLS ne fonctionne pas en pratique (toutes les policies retournent "true" car `current_project_id()` IS NULL), mais la suppression casserait le schema.

2. **`match_messages`, `match_memory`, `match_documents`** : appelees exclusivement par les Edge Functions `search` et `memory-mcp`, deployees sur Supabase. Le code src/ ne les appelle pas directement car il passe par les Edge Functions.

3. **`archive_old_memories` + `memory_archive`** : le heartbeat appelle bien `archive_old_memories` (toutes les heures), qui ecrit dans `memory_archive`. Mais personne ne lit jamais `memory_archive`. C'est un "trou noir" : les memories sont archivees mais jamais consultees.

4. **`logs` table** : utilisee uniquement par le smoke test comme "table canary" pour valider la connectivite Supabase. N'importe quelle autre table pourrait servir.

### 3d. Points de friction

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `scripts/smoke-test.ts` | Seul consommateur de la table `logs`. Si on supprime `logs`, le smoke test echoue. | Moyen — doit etre migre avant suppression |
| 2 | `db/schema.sql` L704-716 | `set_project_scope` + `current_project_id` lies aux 9 policies RLS | Critique — ne pas toucher sans migration RLS |
| 3 | `supabase/functions/search/` | Consommateur de `match_messages`, `match_memory`, `match_documents` | Critique — ces RPCs sont vivantes |
| 4 | `supabase/functions/memory-mcp/` | Consommateur de `match_memory` | Critique — cette RPC est vivante |
| 5 | `examples/morning-briefing.ts` | Seul consommateur de `get_recent_messages` | Faible — fichier d'exemple non deploye |
| 6 | `CLAUDE.md` L131, L133 | Liste les tables et RPCs — doit etre mis a jour | Faible — documentation |
| 7 | `README.md` | Reference `workflow_proposals`, `memory_archive` | Faible — documentation |
| 8 | `src/heartbeat.ts:528` | Appelle `archiveOldMemories` qui ecrit dans `memory_archive` | Moyen — memory_archive vivante en ecriture |

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Nettoyage conservateur | C: Nettoyage agressif |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** | S | S | M |
| **Valeur ajoutee** | Low | Med | Med |
| **Risque technique** | Low | Low | High |
| *Impact maintenance* | Negatif (confusion, tables fantomes) | Positif (schema propre, docs a jour) | Positif mais risque casse |
| *Reversibilite* | N/A | Haute (migration SQL reversible) | Moyenne (donnees perdues si DROP) |

### Option A — Status quo

Ne rien faire. Les tables et RPCs mortes restent dans le schema. Cout : 0. Risque : 0. Inconvenient : confusion pour les futurs contributeurs, CLAUDE.md liste des elements qui n'existent pas fonctionnellement, le smoke test utilise une table fantome.

### Option B — Nettoyage conservateur (recommandee)

Supprimer uniquement les elements confirmes morts sans consommateur :
- **Supprimer** : table `logs`, table `workflow_proposals`, RPC `get_recent_messages`
- **Conserver** : tout le reste (audit_results, memory_archive, memory_links, match_*, current_project_id, set_project_scope, archive_old_memories)
- **Migrer** : smoke test vers une autre table (ex: `messages` ou `memory`)
- **Documenter** : mettre a jour CLAUDE.md et README.md

Complexite faible : 1 migration SQL (DROP TABLE IF EXISTS, DROP FUNCTION IF EXISTS), 1 fix smoke-test.ts, mise a jour doc. Risque faible car les elements supprimes n'ont aucun consommateur.

### Option C — Nettoyage agressif

En plus de B : supprimer `memory_archive` (jamais lue) et `set_project_scope` (jamais appelee) et `get_recent_messages`. Risque significatif :
- Supprimer `memory_archive` casse `archive_old_memories` RPC (INSERT INTO memory_archive) et donc le heartbeat
- Supprimer `set_project_scope` casse le couple RLS (meme si inutilise, la politique repose sur le mecanisme complet)

Non recommandee sans refactoring prealable du heartbeat et des policies RLS.

## Section 5 — Verdict et justification

**Verdict : GO** — Lancer la spec avec l'option B (nettoyage conservateur).

Justification :

1. **Archeologie exhaustive (axe 2)** : chaque table et RPC a ete tracee dans tous les consommateurs possibles (src/, mcp/, dashboard/, supabase/functions/, scripts/, examples/, tests/, config/). Les verdicts individuels sont sans ambiguite.

2. **Risque minimal pour l'option B** : les 3 elements a supprimer (table `logs`, table `workflow_proposals`, RPC `get_recent_messages`) n'ont strictement aucun consommateur fonctionnel. Le seul impact est le smoke test (trivial a migrer).

3. **ROI positif** : la suppression elimine la confusion dans le schema, nettoie la documentation (CLAUDE.md liste ces tables comme actives), et retire du code mort de la base. L'effort est estime a < 1h.

4. **Conservation prudente** : les elements semi-morts (`memory_archive`, `set_project_scope`) sont conserves car ils ont des dependances structurelles (RPC archive, RLS policies). Leur nettoyage eventuel peut etre fait dans une phase ulterieure avec plus de refactoring.

5. **L'axe 1 non couvert est acceptable** car le sujet est 100% interne — aucune source externe n'apporterait d'information utile pour decider si une table du projet est utilisee ou non.

## Section 6 — Input pour etape suivante

### Input pour spec

**Option recommandee : B — Nettoyage conservateur**

**Elements a supprimer :**
1. Table `logs` (schema.sql L88-104, + index L105, + RLS policies L697+731-733)
2. Table `workflow_proposals` (schema.sql L325-347, + index L346-347, + RLS policies L697+777)
3. RPC `get_recent_messages` (schema.sql L832-846)

**Elements a migrer :**
4. `scripts/smoke-test.ts:105,115` : remplacer `.from("logs")` par `.from("messages")` ou `.from("memory")` (insert+delete test de connectivite)

**Documentation a mettre a jour :**
5. `CLAUDE.md` L131 : retirer `logs` et `workflow_proposals` de la liste des tables
6. `CLAUDE.md` L133 : retirer `get_recent_messages` de la liste des RPCs
7. `README.md` : retirer les references a `workflow_proposals`

**Fichiers concernes :**
- `db/schema.sql` — DROP TABLE + DROP FUNCTION
- `db/migrations/` — nouveau fichier migration
- `scripts/smoke-test.ts` — migration smoke test
- `CLAUDE.md` — mise a jour listes
- `README.md` — mise a jour table

**Contraintes identifiees :**
- La migration doit etre reversible (pas de donnees critiques dans `logs` ou `workflow_proposals`, mais utiliser DROP TABLE IF EXISTS)
- Le smoke test doit etre migre AVANT de supprimer la table `logs` (ou dans la meme PR)
- Les tests existants (2690) ne doivent pas etre impactes (aucun test ne reference ces tables)

**Questions ouvertes a resoudre pendant la spec :**
- Faut-il aussi nettoyer l'example `examples/morning-briefing.ts` qui reference `get_recent_messages` ?
- Faut-il ajouter un item Phase 6 (ROADMAP-REFONTE.md) pour l'ajout d'une lecture de `memory_archive` (actuellement trou noir) ?
