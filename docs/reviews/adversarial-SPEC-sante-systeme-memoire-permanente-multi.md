# Adversarial Review — SPEC-sante-systeme-memoire-permanente-multi (Cycle 3)

> Date : 2026-03-23
> Spec source : docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic
> Cycle : 3 (post-corrections cycle 2 — spec et code deja implementes)

---

## Contexte de ce cycle

Ce challenge est execute sur une spec dont le code est **deja entierement implemente et deploye**. Toutes les fonctionnalites decrites (promoteWorkingMemory, memoryHealthStats, /brain health, feature flag memory_promotion) existent dans le codebase et sont couvertes par des tests. Le challenge evalue donc (1) la coherence spec-vs-code, (2) les zones d'ombre residuelles dans l'implementation reelle, et (3) les risques operationnels non documentes.

---

## Synthese

| Agent | BLOQUANT | MAJEUR | MINEUR | Total |
|-------|----------|--------|--------|-------|
| Devil's Advocate | 0 | 2 | 2 | 4 |
| Edge Case Hunter | 0 | 3 | 2 | 5 |
| Simplicity Skeptic | 0 | 2 | 1 | 3 |
| **Total (deduplique)** | **0** | **5** | **4** | **9** |

**Verdict : GO WITH CHANGES**

Justification : Aucun BLOQUANT. 5 MAJEURS, tous resolvables sans remettre en cause l'architecture. Les corrections du cycle 2 sont bien appliquees. L'implementation est presente et fonctionnelle. Les MAJEURS identifies relevent principalement de (a) la coherence spec-vs-code sur des points precis, et (b) des risques de performance a l'echelle qui ne se manifestent pas aujourd'hui mais doivent etre documentes.

### Corrections cycle 2 validees dans la spec et le code

1. R10 + V15 : `auto-pipeline.ts` avec `useBlackboard: true` — present en code (`auto-pipeline.ts:226`) et dans la spec
2. R11 + V17 : troncature 500 chars — implementee dans `promoteWorkingMemory()` avant `resolveMemoryConflict()` (ordre correct)
3. R12 + V18 : dispatch /brain health sur match exact — implementee dans `memory-cmds.ts:47`
4. R13 + V16 : guard division par zero — `if (total === 0) return empty`
5. R14 : limitation recentPromotions documentee dans la spec
6. Section 9 : "18 V-criteres" correct (vs "14" en cycle 2)

---

## Devil's Advocate — Rapport

### Findings

**[MAJEUR] F-DA-1 — Zone d'ombre #3 contredit la realite du codebase sur auto-pipeline**
- Source : Section 9, Zone d'ombre #3 vs codebase `src/auto-pipeline.ts:226`
- Description : La Zone d'ombre #3 dit "le module `auto-pipeline.ts` appelle `orchestrate()` SANS `useBlackboard: true` pour la Phase 3 (analyse). Cette spec inclut l'ajout de `useBlackboard: true` a cet appel (R10)." Or le code existant `auto-pipeline.ts` ligne 226 contient deja `useBlackboard: true`. La zone d'ombre decrit un etat pre-implementation qui n'est plus valide. Un lecteur de la spec croit que ce changement est encore a faire.
- Impact : Confusion lors de la revue post-implementation. Si quelqu'un lit la spec pour comprendre l'historique, la Zone d'ombre #3 cree un malentendu sur l'etat reel du code.
- Evidence : `src/auto-pipeline.ts:219-227` — `useBlackboard: true` est present dans l'appel `orchestrate()`.

**[MAJEUR] F-DA-2 — Le flag `agent_role_memory` dans `promoteWorkingMemory()` n'est pas documente dans la spec**
- Source : Section 2 (regles R1-R14), Section 7 (contraintes), code `src/memory.ts:971-981`
- Description : L'implementation reelle de `promoteWorkingMemory()` contient un bloc conditionnel sur le flag `agent_role_memory` (actif en production, `config/features.json:13`). Ce bloc appelle `saveAgentMemory()` et `graduateAgentMemory()` — soit 2 operations Supabase supplementaires par item promu. Ce comportement est entierement absent de la spec (aucune regle R1-R14, aucune contrainte, aucune zone d'ombre). En production avec `agent_role_memory: true`, chaque promotion cree des entrees supplementaires dans la table `agent_memory` en plus de `memory`, ce qui double le nombre d'ecritures et peut causer des effets de bord sur le budget token des agents.
- Impact : Comportement de production non documente. Les tests de promotion ne couvrent probablement pas ce code path avec `agent_role_memory` actif (les tests desactivent les feature flags par defaut).
- Evidence : `src/memory.ts:971` — `if (isFeatureEnabled("agent_role_memory")) { await saveAgentMemory(...); graduateAgentMemory(...); }`. `config/features.json:13` — `"agent_role_memory": true`.

**[MINEUR] F-DA-3 — R5 incomplet : le message `onProgress` est conditionnel mais la regle ne le dit pas**
- Source : Section 2, R5 ("Le nombre d'items promus est logue et reporte via `onProgress`")
- Description : L'implementation (orchestrator.ts:1806) envoie le message `onProgress` uniquement si `promotedCount > 0`. Si la working_memory contient des items mais que tous sont skipped (dedupliques), aucun message n'est emis. R5 n'indique pas cette conditionnalite — "le nombre d'items promus est reporte" implique qu'un rapport est toujours emis.
- Impact : Silence non explicite quand la promotion est active mais ne produit aucun insert. L'utilisateur ne sait pas si la promotion a ete tentee.

**[MINEUR] F-DA-4 — Dualite de types `WorkingMemory` / `WorkingMemoryData` non documentee**
- Source : Section 3 (Donnees d'entree) ; code `src/orchestrator.ts:72,1801` vs `src/memory.ts:888`
- Description : La spec mentionne `WorkingMemoryData` (memory.ts) comme type d'entree de `promoteWorkingMemory()`. L'orchestrateur importe `WorkingMemory` (blackboard.ts) et passe une valeur castee `as WorkingMemory` a `promoteWorkingMemory()`. Les deux interfaces ont la meme structure (memes champs), donc TypeScript compile sans erreur et le comportement est correct, mais la spec ne documente pas cette dualite. Si un champ diverge entre les deux types dans une evolution future, le bug sera invisible au compile time.
- Impact : Fragilite silencieuse non documentee. Bas risque aujourd'hui, risque croissant si les deux types evoluent independamment.

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[MAJEUR] F-EC-1 — `memoryHealthStats()` fetch ALL rows sans LIMIT — risque perf sur table grande**
- Scenario : La table `memory` contient 20 000+ enregistrements (projection a 12 mois avec `memory_promotion` actif et pipelines frequents). La query `supabase.from("memory").select("type, importance_score, created_at, access_count")` (memory.ts:1712) ramene toutes les lignes sans LIMIT. Supabase PostgREST retourne par defaut jusqu'a 1000 lignes (header `Range`), mais avec une configuration permissive, peut retourner plus. Sur 10k rows, le payload JSON depasse 1 MB et la latence de deserialisation depasse le budget `< 2s` (Section 7).
- Source : Section 2 R6 ; Section 7 contrainte performance `< 2s` ; code `memoryHealthStats()` memory.ts:1710-1730
- Impact : Degradation progressive de `/brain health` avec la croissance de la table. Le seuil de degradation n'est pas documente.
- Frequence estimee : rare aujourd'hui, frequent dans 6-12 mois si promotions actives

**[MAJEUR] F-EC-2 — Promotion silencieuse a zero si `supabase = null` avec `bbFallback` actif**
- Scenario : Pipeline utilisant `InMemoryBlackboard` (`bbFallback` non null) avec `supabase = null` (environnement offline ou test sans mock). La working_memory est lue via `bbFallback?.read()` (orchestrator.ts:1802). Mais `promoteWorkingMemory(supabase=null, wmForPromotion, bbSessionId)` retourne immediatement 0 car `if (!supabase || !workingMemory) return 0` (memory.ts:905). Les items sont lus correctement mais silencieusement abandonnes — zero log de warning, zero message utilisateur.
- Source : Section 7 contrainte "Compatibilite InMemoryBlackboard" ; V13 ("La promotion fonctionne avec le fallback InMemoryBlackboard")
- Impact : V13 est techniquement verifie si le test utilise un mock supabase non-null, mais la combinaison bbFallback + supabase null (cas reel en mode offline) produit un comportement non documente. Les decisions de pipeline sont perdues sans notification.
- Frequence estimee : frequent en tests, possible en prod si Supabase est temporairement indisponible

**[MAJEUR] F-EC-3 — Query `metadata->>source` sans index GIN — full table scan potentiel**
- Scenario : La query `recentPromotions` (memory.ts:1728-1730) utilise `.eq("metadata->>source", "working_memory_promotion")`. La colonne `memory.metadata` est JSONB. Le schema SQL (`db/schema.sql`) ne contient aucun index GIN sur `memory.metadata` ni index expression sur `memory.metadata->>'source'`. Indexes existants sur `memory` : type, created_at, idea_status, importance_score, last_accessed_at — aucun sur metadata. Chaque appel de `/brain health` effectue un full table scan filtre par JSONB.
- Source : Section 2 R6, R8 ; Section 4.2 champ `recentPromotions` ; `db/schema.sql:79-83`
- Impact : Latence croissante non couverte par le budget `< 2s` (Section 7). Seuil problematique vers 5 000-10 000 rows. Non documente comme limitation connue.
- Frequence estimee : impact progressif, critique vers 6-12 mois

**[MINEUR] F-EC-4 — Queries `memory_links` et `memory_archive` sans COUNT — fetch de tous les IDs**
- Scenario : `supabase.from("memory_links").select("id")` et `supabase.from("memory_archive").select("id")` (memory.ts:1716-1718) fetchent tous les IDs pour compter. Sur `memory_links` a 100k lignes (2 rows par paire de memoires liees), le payload peut depasser les limites Supabase. Le resultat `.data?.length || 0` compte en JS ce qui pourrait etre fait en SQL avec `COUNT(*)`.
- Source : Section 4.2 champs `linksCount`, `archiveCount`

**[MINEUR] F-EC-5 — Promotion sequentielle bloquante sur pipelines avec nombreuses decisions**
- Scenario : Pipeline DEFAULT (analyst + pm + architect) produisant 15 decisions et 20 discoveries. `promoteWorkingMemory()` appelle `resolveMemoryConflict()` sequentiellement pour chacun (boucle `for`, memory.ts:934), chaque appel faisant 1-2 requetes Supabase. 35 items x ~2 requetes = 70 appels sequentiels. Latence estimee : 7-15 secondes ajoutees a la fin du pipeline.
- Source : Pattern 3 ; Section 2 R1, R9 (echec non bloquant mais lenteur non mentionnee)

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — 3 queries full-scan pour calculer des agregats calculables en SQL**
- Source : Section 2 R6, R7 ; code `memoryHealthStats()` memory.ts:1710-1730
- Description : La fonction execute 6 queries en parallele dont au moins 3 ramenent TOUTES les lignes : (1) `select("type, importance_score, created_at, access_count")` pour byType + avgImportance + avgAgeDays — toutes les rows pour un COUNT + AVG calculable en SQL, (2) `select("id").not("embedding", "is", null)` pour le count embedding — un COUNT filtre, (3) `select("id")` sur memory_links et memory_archive — COUNT pur. Les agregats byType, avgImportanceScore, avgAgeDays, embeddingCoverage et les deux counts sont calculables en une ou deux requetes SQL natives. La spec impose "queries executees en parallele (Promise.all)" (Section 7) mais ne compare pas a une approche SQL aggreee.
- Alternative : Une RPC Supabase `get_memory_health_stats` avec GROUP BY type, AVG(), COUNT(*) FILTER remplace les 3-4 full-scan queries par une seule requete optimisee. Pattern existant : `db/schema.sql` contient deja des RPCs complexes (`get_sprint_summary`, `get_facts`).
- Codebase : `src/commands/memory-cmds.ts:73` utilise `bctx.supabase.rpc("get_facts")` — le pattern RPC est etabli.

**[MAJEUR] F-SS-2 — Comportement `agent_role_memory` dans la promotion — scope creep non controle**
- Source : Aucune section de la spec ; code `src/memory.ts:971-981`
- Description : L'implementation ajoute un bloc `if (isFeatureEnabled("agent_role_memory"))` avec appels a `saveAgentMemory()` et `graduateAgentMemory()` dans la boucle de promotion. Ce comportement n'est pas dans le scope de cette spec. Il est actif en production. Il cree un couplage implicite entre la promotion working memory et le systeme agent_memory. Si ce comportement est desirable, il doit etre documente dans la spec. Si non, il represente du scope creep dans le module memory.ts.
- Alternative : Soit documenter ce comportement comme R15 dans la spec, soit l'isoler dans une fonction appelee explicitement plutot que de le cacher dans promoteWorkingMemory().
- Codebase : `config/features.json:13` — `"agent_role_memory": true` en production. `src/memory.ts:971-981`.

**[MINEUR] F-SS-3 — `embCount` recalcule depuis le ratio flottant dans `formatMemoryHealth()`**
- Source : Section 4.2 exemple attendu ; code `formatMemoryHealth()` memory.ts:1791
- Description : `embCount = Math.round(stats.embeddingCoverage * stats.total)` recalcule un entier depuis un ratio flottant issu lui-meme d'une division entiere. Les erreurs d'arrondi sont improbables mais possibles (ex: total=7, 5 avec embedding : ratio=0.714..., Math.round(0.714*7)=5 — correct ; mais total=10, 3 avec embedding : ratio=0.3, Math.round(0.3*10)=3 — correct). Risque faible mais la solution simple est d'ajouter `embeddingCount: number` directement dans `MemoryHealthStats`.
- Alternative : Stocker le count entier dans la structure retournee plutot que seulement le ratio.

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 1

---

## Findings consolides et dedupliques

| ID | Severite | Titre | Agents | Resolvable |
|----|----------|-------|--------|------------|
| F-DA-1 | MAJEUR | Zone d'ombre #3 obsolete — auto-pipeline deja a jour | DA | Oui — corriger la spec |
| F-DA-2 / F-SS-2 | MAJEUR | Bloc `agent_role_memory` dans promotion — non documente | DA + SS | Oui — ajouter R15 ou note de perimetre |
| F-EC-1 / F-SS-1 | MAJEUR | Full-scan queries sans LIMIT dans memoryHealthStats | EC + SS | Oui — ajouter LIMIT ou RPC SQL |
| F-EC-2 | MAJEUR | Promotion silencieuse si bbFallback + supabase null | EC | Oui — ajouter log.warn ou documenter |
| F-EC-3 | MAJEUR | Query metadata->>source sans index GIN | EC | Oui — ajouter index dans schema.sql |
| F-DA-3 | MINEUR | R5 : message onProgress conditionnel non specifie | DA | Oui — clarifier R5 |
| F-DA-4 | MINEUR | Dualite WorkingMemory / WorkingMemoryData non documentee | DA | Oui — note dans Section 3 ou contraintes |
| F-EC-4 | MINEUR | memory_links et memory_archive : fetch IDs vs COUNT SQL | EC | Oui — remplacer par count exact |
| F-EC-5 | MINEUR | Promotion sequentielle bloquante sur nombreuses decisions | EC | Acceptable en V1, documenter comme zone d'ombre |

Note : F-DA-2 et F-SS-2 decrivent le meme probleme (agent_role_memory non documente). F-EC-1 et F-SS-1 decrivent le meme probleme (queries full-scan).

---

## Recommandations (actions pour passer a GO)

### Corrections de spec (priorite haute — ne necessitent pas de changements de code)

1. **Corriger Zone d'ombre #3** : supprimer ou corriger l'affirmation que `auto-pipeline.ts` "appelle `orchestrate()` SANS `useBlackboard: true`". Remplacer par : "`useBlackboard: true` est deja present depuis la correction cycle 2 (`auto-pipeline.ts:226`). Limitation V1 : la Phase 4 (`executeTask()`) reste hors scope du blackboard."

2. **Documenter le comportement `agent_role_memory`** : ajouter une regle R15 ou une note dans Section 7 : "Quand le flag `agent_role_memory` est actif (actuellement true en production), chaque item promu est egalement persiste dans `agent_memory` via `saveAgentMemory()`. Ce comportement est hors spec de cette feature mais est actif en production."

3. **Documenter la limitation offline (F-EC-2)** : ajouter en Section 9 Zone d'ombre : "En mode offline (supabase null) avec InMemoryBlackboard, la promotion retourne 0 silencieusement car `promoteWorkingMemory()` requiert un client Supabase. V13 est verifie avec mock supabase, pas en mode reellement offline."

### Corrections de code recommandees (peuvent etre des tickets separes)

4. **Ajouter un index SQL sur `metadata->>'source'`** (F-EC-3) : dans `db/schema.sql`, ajouter :
   `CREATE INDEX IF NOT EXISTS idx_memory_metadata_source ON memory ((metadata->>'source'));`
   Elimine le full table scan pour `recentPromotions`.

5. **Remplacer les full-scan queries par des COUNT SQL** (F-EC-1, F-EC-4) : pour `memory_links` et `memory_archive`, utiliser `.select('*', { count: 'exact', head: true })` pour obtenir le count sans fetcher les donnees. Pour `allMemories`, envisager de limiter a 5000 rows avec un LIMIT explicite.

6. **Clarifier R5** : specifier explicitement que le message `onProgress` est emis uniquement si `promotedCount > 0`. Ou changer pour emettre toujours un message (ex: "Working memory: 0 items promus (tous dedupliques)").

### Acceptable en V1 sans modification

- Promotion sequentielle (F-EC-5) : acceptable pour V1. A documenter comme zone d'ombre si le volume de decisions devient significatif.
- Dualite de types WorkingMemory / WorkingMemoryData (F-DA-4) : les deux interfaces sont identiques, TypeScript compile proprement. Risque theorique bas.
- `embCount` calcule depuis ratio (F-SS-3) : erreurs d'arrondi improbables, risque negligeable.

---

## Points forts identifies

1. **Toutes les corrections cycle 2 appliquees** : les 7 actions du cycle 2 sont implementees dans la spec et le code. Tres bonne velocite d'iteration.

2. **Tests exhaustifs** : 18 V-criteres couverts dans les tests unitaires et d'integration. La base de 223+ tests memory assure une bonne filet de securite.

3. **Feature flag pattern** : `memory_promotion: false` par defaut, activation manuelle. Rollback instantane.

4. **Try/catch isole (R9)** : la promotion ne bloque jamais le retour du pipeline — pattern correctement implementee.

5. **Troncature avant resolve (R11)** : la troncature 500 chars est appliquee AVANT `resolveMemoryConflict()`, garantissant la coherence entre le texte recherche et le texte insere. Ordre correct.

6. **Guard division par zero (R13)** : `if (total === 0) return empty` — propre, pas de NaN.

7. **Dispatch /brain health exact match (R12)** : `brainInput === "health"` — match strict, pas de regex fragile.

---

## Etape suivante

**Verdict : GO WITH CHANGES**

Corrections minimales requises avant de considerer la spec complete (sans changements de code urgents) :
1. Corriger Zone d'ombre #3 (incoherence spec-vs-code)
2. Documenter le comportement `agent_role_memory` (R15 ou note)
3. Documenter la limitation offline de V13

Corrections de code recommandees mais non bloquantes (peuvent etre des tickets tech debt) :
4. Index GIN sur `memory.metadata->>'source'`
5. COUNT SQL pour memory_links et memory_archive

Une fois les corrections de spec appliquees :
`/dev-implement "Implementer SPEC-sante-systeme-memoire-permanente-multi. Spec: docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md"`

Note : Le code etant deja implemente, cette commande servira principalement a valider la conformite de l'implementation avec la spec mise a jour, et eventuellement a appliquer les corrections de code recommandees.
