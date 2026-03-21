# Spec : Nettoyage schema Supabase Phase 4

> Genere le 2026-03-20. Source : exploration EXPLORE-phase-4-roadmap-nettoyage-schema.md, verification codebase directe (db/schema.sql, scripts/smoke-test.ts, tests/e2e/framework.ts, setup/verify.ts, CLAUDE.md).

## 1. Objectif

Supprimer les 2 tables mortes (`logs`, `workflow_proposals`) et la RPC morte (`get_recent_messages`) de `db/schema.sql`, puis migrer les 4 fichiers qui referencent la table `logs` vers des tables vivantes. Cette Phase 4 de la roadmap de refonte reduit le schema de 24 a 22 tables et elimine du code mort pour aligner le schema declaratif sur l'usage reel du codebase.

**Perimetre explicite** : on ne supprime PAS les tables en production Supabase (trop risque). On ne supprime que les definitions dans `db/schema.sql`. Les tables resteront en prod comme vestiges inertes.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Une table sans aucun consommateur fonctionnel (0 `.from("table")` dans src/, mcp/, dashboard/, supabase/functions/) doit etre supprimee de db/schema.sql | Exploration Phase 4 section 3a : `workflow_proposals` a 0 consommateur dans tout le codebase | `workflow_proposals` : 0 references dans src/, mcp/, dashboard/, supabase/ |
| R2 | Une table dont le seul consommateur est un utilitaire de test/setup (non fonctionnel) doit etre supprimee, et le consommateur migre vers une table vivante | Exploration Phase 4 section 3a : `logs` n'est utilisee que par smoke-test.ts, framework.ts, verify.ts, e2e-isolation.test.ts | `logs` : seuls usages = smoke test + e2e cleanup + setup verify |
| R3 | Une RPC dont le seul consommateur est un fichier d'exemple non deploye doit etre supprimee de db/schema.sql | Exploration Phase 4 section 3b : `get_recent_messages` uniquement dans examples/morning-briefing.ts | `get_recent_messages` : seul appel dans examples/morning-briefing.ts (non deploye) |
| R4 | Les tables vivantes identifiees par l'exploration (audit_results, memory_archive, memory_links) NE DOIVENT PAS etre touchees | Exploration Phase 4 section 3a : ces tables ont des consommateurs actifs (dashboard, MCP, heartbeat, memory.ts) | `memory_links` : interface MemoryLink dans src/memory.ts, RPCs link_memory/get_linked_memories |
| R5 | Les RPCs vivantes via Edge Functions (match_messages, match_memory, match_documents) et les fonctions RLS (current_project_id, set_project_scope) NE DOIVENT PAS etre touchees | Exploration Phase 4 sections 3b et 3c : consommateurs dans supabase/functions/ et 9 RLS policies | `match_memory` : utilisee par search/index.ts et memory-mcp/index.ts |
| R6 | Le commentaire d'en-tete de db/schema.sql doit refleter le nombre reel de tables apres suppression | Convention de maintenance : le schema se decrit comme "Reflects all N public tables" | "Reflects all 24 public tables" → "Reflects all 22 public tables" |
| R7 | La documentation (CLAUDE.md) doit etre mise a jour pour retirer les references aux elements supprimes | Convention CLAUDE.md : les listes de tables et RPCs doivent refleter l'etat reel | Retirer `logs`, `workflow_proposals` de la liste Tables, retirer `get_recent_messages` de la liste RPCs |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `db/schema.sql` | SQL DDL | Filesystem | Tables `logs` (L88-104), `workflow_proposals` (L324-347), RPC `get_recent_messages` (L832-846), RLS policies (L689, L697, L731-733, L777), en-tete (L4) |
| `scripts/smoke-test.ts` | TypeScript | Filesystem | Fonction `checkSupabase()` L102-121 : `.from("logs").insert()` et `.from("logs").delete()` |
| `tests/e2e/framework.ts` | TypeScript | Filesystem | Methode `cleanup()` L183-202 : tableau `cleanups` contient `{ table: "logs", column: "message" }` |
| `tests/unit/e2e-isolation.test.ts` | TypeScript | Filesystem | Test "cleanup targets the correct tables" L77-92 : liste et assertion sur `["tasks", "memory", "messages", "logs"]` |
| `setup/verify.ts` | TypeScript | Filesystem | Boucle L98 : `for (const table of ["messages", "memory", "logs"])` |
| `CLAUDE.md` | Markdown | Filesystem | L131 (liste Tables), L133 (liste RPCs) |

## 4. Donnees de sortie

### 4.1 db/schema.sql — suppressions

**En-tete (L4)** :
```
-- Authoritative database schema. Reflects all 24 public tables,
```
Devient :
```
-- Authoritative database schema. Reflects all 22 public tables,
```

**Table logs (L87-104)** : supprimer le bloc entier (commentaire section + CREATE TABLE + 2 index).

**Table workflow_proposals (L324-347)** : supprimer le bloc entier (commentaire section + CREATE TABLE + COMMENT ON TABLE + 2 index).

**RLS logs (L689)** : supprimer `ALTER TABLE logs ENABLE ROW LEVEL SECURITY;`

**RLS workflow_proposals (L697)** : supprimer `ALTER TABLE workflow_proposals ENABLE ROW LEVEL SECURITY;`

**Policies logs (L731-733)** : supprimer les 2 policies `logs_insert` et `logs_select_by_project`.

**Policy workflow_proposals (L777)** : supprimer la policy `"Allow all for authenticated" ON workflow_proposals`.

**RPC get_recent_messages (L831-846)** : supprimer le commentaire + la definition complete de la fonction.

### 4.2 scripts/smoke-test.ts — migration smoke test

Remplacer la table `logs` par la table `tasks` dans `checkSupabase()`. Choix de `tasks` plutot que `messages` car :
- `tasks` a un champ `title TEXT NOT NULL` simple pour l'insert test
- `tasks` a une policy `tasks_insert` + `tasks_delete` (open access), identique a `logs`

Avant (L103-115) :
```typescript
const testRow = { event: "smoke_test", metadata: { ts: Date.now() } };
const { data, error: insertErr } = await withTimeout(
  supabase.from("logs").insert(testRow).select(),
  10000
);
// ...
await supabase.from("logs").delete().eq("id", data[0].id);
```

Apres :
```typescript
const testRow = { title: `smoke_test_${Date.now()}`, status: "backlog", priority: "P3" };
const { data, error: insertErr } = await withTimeout(
  supabase.from("tasks").insert(testRow).select(),
  10000
);
// ...
await supabase.from("tasks").delete().eq("id", data[0].id);
```

### 4.3 tests/e2e/framework.ts — retrait logs du cleanup

Supprimer `{ table: "logs", column: "message" }` du tableau `cleanups` (L187). Le nettoyage E2E ne doit pas cibler une table supprimee.

### 4.4 tests/unit/e2e-isolation.test.ts — mise a jour du test

Mettre a jour le test "cleanup targets the correct tables" (L77-92) pour retirer `logs` :
- Tableau : retirer `{ table: "logs", column: "message" }`
- Assertion `toHaveLength(4)` → `toHaveLength(3)`
- Assertion `toEqual(["tasks", "memory", "messages", "logs"])` → `toEqual(["tasks", "memory", "messages"])`

### 4.5 setup/verify.ts — retrait logs de la verification

Remplacer la liste de tables verifiees (L98) :
```typescript
for (const table of ["messages", "memory", "logs"]) {
```
Par :
```typescript
for (const table of ["messages", "memory", "tasks"]) {
```

### 4.6 CLAUDE.md — mise a jour documentation

**L131 (Tables)** : retirer `workflow_proposals` et `logs` de la liste.

**L133 (RPCs)** : retirer `get_recent_messages` de la liste.

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `db/schema.sql` | Modifier | Supprimer table `logs` (L87-104), table `workflow_proposals` (L324-347), RPC `get_recent_messages` (L831-846), RLS + policies associees, mettre a jour en-tete |
| `scripts/smoke-test.ts` | Modifier | Migrer `.from("logs")` vers `.from("tasks")` dans checkSupabase() (L103-115) |
| `tests/e2e/framework.ts` | Modifier | Retirer `{ table: "logs", column: "message" }` du tableau cleanups (L187) |
| `tests/unit/e2e-isolation.test.ts` | Modifier | Retirer `logs` du test de validation des tables de cleanup (L78-91) |
| `setup/verify.ts` | Modifier | Remplacer `"logs"` par `"tasks"` dans la boucle de verification Supabase (L98) |
| `CLAUDE.md` | Modifier | Retirer `logs`, `workflow_proposals` des Tables (L131), retirer `get_recent_messages` des RPCs (L133) |

## 6. Patterns existants

### 6.1 Pattern de smoke test avec insert+delete (scripts/smoke-test.ts L102-121)

Le pattern actuel utilise insert + select + delete sur une table pour valider la connectivite Supabase :
```typescript
// scripts/smoke-test.ts:103-115
const testRow = { event: "smoke_test", metadata: { ts: Date.now() } };
const { data, error: insertErr } = await withTimeout(
  supabase.from("logs").insert(testRow).select(),
  10000
);
if (insertErr) {
  return { check: "Supabase", status: "fail", detail: `Insert failed: ${insertErr.message}`, ... };
}
if (data?.[0]?.id) {
  await supabase.from("logs").delete().eq("id", data[0].id);
}
```
Ce pattern est conserve intact ; seule la table cible et les champs de la row changent.

### 6.2 Pattern de cleanup E2E (tests/e2e/framework.ts L183-202)

Le tableau `cleanups` est itere pour supprimer les donnees E2E taguees :
```typescript
// tests/e2e/framework.ts:183-188
const cleanups: Array<{ table: string; column: string }> = [
  { table: "tasks", column: "title" },
  { table: "memory", column: "content" },
  { table: "messages", column: "content" },
  { table: "logs", column: "message" },
];
```
Le retrait d'un element est trivial — aucun autre code ne depend de la longueur du tableau.

### 6.3 Schema SQL — blocs table standards (db/schema.sql)

Chaque table suit le pattern : commentaire section → CREATE TABLE → CREATE INDEX → (optionnel COMMENT ON TABLE). La suppression d'un bloc est une operation de texte sans impact sur les blocs adjacents car il n'y a pas de FOREIGN KEY pointant vers `logs` ou `workflow_proposals`.

## 7. Contraintes

### Ce qu'il ne faut PAS casser

- **Tables vivantes** : `audit_results` (dashboard + MCP), `memory_archive` (cible de archive_old_memories), `memory_links` (src/memory.ts + RPCs link_memory/get_linked_memories)
- **RPCs vivantes via Edge Functions** : `match_messages`, `match_memory`, `match_documents` (utilisees par supabase/functions/search/ et memory-mcp/)
- **Fonctions RLS critiques** : `current_project_id()` (referencee dans 9 policies RLS), `set_project_scope()` (couple avec current_project_id)
- **RPCs vivantes dans src/** : `archive_old_memories` (heartbeat.ts:528), `bump_memory_access` (memory.ts), `get_active_goals`, `get_facts`, `get_sprint_summary`
- **Supabase production** : aucune migration SQL ne doit etre executee en production. On ne modifie que le fichier declaratif db/schema.sql

### Limites techniques

- Le fichier db/schema.sql est purement declaratif (documentation de reference). La suppression de blocs n'a pas d'effet sur Supabase en production
- Les tables `logs` et `workflow_proposals` resteront en production comme vestiges inertes — ce qui est acceptable car elles ne sont jamais lues
- Le smoke test doit fonctionner apres la migration : la table cible (`tasks`) doit avoir les policies RLS adequates pour insert + delete (verifie : `tasks_insert` et `tasks_delete` existent)

### Dependances

- Les tests existants (2720) ne referencent pas directement les tables `logs` ou `workflow_proposals` dans src/ — les seuls impacts sont dans les fichiers de test/utilitaires listes en section 5
- Le fichier `examples/morning-briefing.ts` reference `get_recent_messages` mais n'est pas deploye et est hors perimetre de cette spec (nettoyage optionnel futur)
- Le fichier `README.md` L469 reference `workflow_proposals` — hors perimetre de cette spec (documentation secondaire, le README n'est pas la source de verite)

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | db/schema.sql ne contient plus la definition de la table `logs` | Grep "CREATE TABLE.*logs" dans db/schema.sql retourne 0 resultat | unit |
| V2 | db/schema.sql ne contient plus la definition de la table `workflow_proposals` | Grep "CREATE TABLE.*workflow_proposals" dans db/schema.sql retourne 0 resultat | unit |
| V3 | db/schema.sql ne contient plus la definition de la RPC `get_recent_messages` | Grep "get_recent_messages" dans db/schema.sql retourne 0 resultat | unit |
| V4 | db/schema.sql ne contient plus de RLS/policies pour `logs` | Grep "logs" dans db/schema.sql retourne 0 resultat (aucune reference residuelle) | unit |
| V5 | db/schema.sql ne contient plus de RLS/policies pour `workflow_proposals` | Grep "workflow_proposals" dans db/schema.sql retourne 0 resultat | unit |
| V6 | L'en-tete de db/schema.sql indique "22 public tables" | Lecture de la ligne 4 du fichier | unit |
| V7 | Le smoke test utilise la table `tasks` au lieu de `logs` | Grep `.from("tasks")` dans scripts/smoke-test.ts retourne 2 occurrences (insert + delete) et Grep `.from("logs")` retourne 0 | unit |
| V8 | Le framework E2E ne reference plus `logs` dans son cleanup | Grep "logs" dans tests/e2e/framework.ts retourne 0 resultat | unit |
| V9 | Le test e2e-isolation valide 3 tables (sans logs) | Le test "cleanup targets the correct tables" asserte `toHaveLength(3)` et `toEqual(["tasks", "memory", "messages"])` | unit |
| V10 | setup/verify.ts verifie `tasks` au lieu de `logs` | Grep `"logs"` dans setup/verify.ts retourne 0 resultat | unit |
| V11 | CLAUDE.md ne mentionne plus `logs`, `workflow_proposals`, ni `get_recent_messages` dans les listes Tables/RPCs | Verification visuelle des lignes Tables et RPCs dans CLAUDE.md | unit |
| V12 | Les tables vivantes (audit_results, memory_archive, memory_links) sont toujours presentes dans db/schema.sql | Grep "CREATE TABLE.*audit_results", "CREATE TABLE.*memory_archive", "CREATE TABLE.*memory_links" retournent chacun 1 resultat | unit |
| V13 | Les RPCs vivantes (match_messages, match_memory, match_documents, current_project_id, set_project_scope) sont toujours presentes dans db/schema.sql | Grep pour chaque nom de fonction retourne 1+ resultat | unit |
| V14 | `bun test` passe sans regression (2720 tests) | Execution complete de la suite de tests | integration |
| V15 | Le schema SQL reste syntaxiquement valide (pas de references pendantes aux tables supprimees) | Aucune FOREIGN KEY, trigger ou policy ne reference `logs` ou `workflow_proposals` apres suppression | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Tables et RPCs mortes identifiees exhaustivement par l'exploration Phase 4 avec tracage de tous les consommateurs |
| Perimetre | Couvert | IN: suppression dans schema.sql + migration 4 fichiers consommateurs + doc CLAUDE.md. OUT: pas de DROP en production, pas de nettoyage examples/, pas de README.md |
| Validation | Couvert | 15 V-criteres couvrant chaque suppression, chaque migration, et la non-regression sur les elements vivants |
| Technique | Couvert | Aucune dependance cachee non traitee — toutes les references a `logs` dans le codebase sont listees et migrees |
| UX | Non applicable | Modifications internes (schema declaratif + tests/scripts), aucune interaction utilisateur impactee |
| Alternatives | Couvert | L'exploration a evalue 3 options (A: status quo, B: conservateur, C: agressif). Option B retenue : risque minimal, ROI positif. Option C rejetee car elle casserait archive_old_memories et les RLS policies |

**Zones d'ombre residuelles** :

1. **examples/morning-briefing.ts** : reference `get_recent_messages` mais est hors perimetre (fichier d'exemple non deploye). A nettoyer dans une future passe si souhaite.
2. **README.md L469** : reference `workflow_proposals` dans une table descriptive. Hors perimetre car le README n'est pas la source de verite du schema (CLAUDE.md l'est). A mettre a jour lors d'une future passe documentation.
3. **memory_archive comme "trou noir"** : la table est alimentee par `archive_old_memories` (heartbeat) mais jamais lue. C'est un sujet distinct pour une future Phase 5, pas un blocage pour cette spec.
