# Rapport adversarial — SPEC-memoire-hybride-agents-bmad.md (Cycle 2)

> Genere le 2026-03-23. Cycle 2 : verification des corrections du cycle 1 + recherche de nouveaux problemes.
> Agents : Devil's Advocate (DA), Edge Case Hunter (EC), Simplicity Skeptic (SS).

---

## Synthese des corrections cycle 1

| Finding cycle 1 | Statut | Verification |
|----------------|--------|--------------|
| F-DA-1 : `resolveAgentMemoryConflict()` separee | RESOLU | R9 precise explicitement la table cible `agent_memory` et la signature `resolveAgentMemoryConflict(supabase, role, content)` |
| F-DA-2 : tableau reequilibrage shares exact | RESOLU | Section 6.5 fournit deux tableaux complets (avec/sans exploration) avec totaux verifies |
| F-EC-1 : graduation idempotente ON CONFLICT | RESOLU | Contrainte 7 precise `ON CONFLICT DO NOTHING` sur index unique `(content_hash, metadata->>'source')` |
| F-DA-3/F-EC-2 : planner et explorer dans ROLE_CANONICAL_TAGS | RESOLU | Section 6.7 inclut les 8 roles dont planner et explorer |
| F-DA-4 : graduation V1 par exact-match | RESOLU | R10 definit explicitement la graduation par contenu normalise (lowercase, trim, whitespace collapse) |
| F-EC-4 : archivage quand hard limit 15 atteint | RESOLU | Contrainte 7 precise "archiver l'entree la moins importante avant insertion" |
| F-SS-1 : reutilisation memory_links | RESOLU | R14 specifie la colonne `agent_role TEXT` nullable ajoutee a `memory_links` |
| F-SS-2 : graduation par exact-match | RESOLU | Confirme dans R10 et section 9 zones d'ombre residuelles |

**Toutes les corrections cycle 1 sont presentes et bien formulees.**

---

## Tableau de synthese — Nouveaux findings cycle 2

| ID | Agent | Severite | Titre |
|----|-------|----------|-------|
| F-DA-1 | Devil's Advocate | BLOQUANT | `content_hash` n'existe pas dans le schema `memory` |
| F-DA-2 | Devil's Advocate | MAJEUR | `resolveAgentMemoryConflict()` : reference aux constantes semantiques incompatible avec l'exact-match |
| F-DA-3 | Devil's Advocate | MAJEUR | `agent_role TEXT` sur `memory_links` brise les FK existantes |
| F-DA-4 | Devil's Advocate | MINEUR | Budget "8-12%" formule comme range mais `ROLE_MEMORY_SHARE` est une constante |
| F-EC-1 | Edge Case Hunter | BLOQUANT | FK `memory_links` rejette les UUIDs de `agent_memory` |
| F-EC-2 | Edge Case Hunter | MAJEUR | Hard limit 15 : table d'archivage pour `agent_memory` non definie |
| F-EC-3 | Edge Case Hunter | MAJEUR | `item.agent` dans `workingMemory` non valide en tant qu'`AgentRole` |
| F-EC-4 | Edge Case Hunter | MINEUR | Graduation fire-and-forget : echec silencieux non observable |
| F-SS-1 | Simplicity Skeptic | MAJEUR | `memory_links` avec `agent_role` : FK cassee + UNIQUE constraint incompatible |
| F-SS-2 | Simplicity Skeptic | MAJEUR | `ROLE_TOKEN_BUDGETS` absent pour `planner` et `explorer` |
| F-SS-3 | Simplicity Skeptic | MINEUR | Flag `graduated` dans `metadata` de `agent_memory` : mise a jour non specifiee |

---

## Verdict

**GO WITH CHANGES**

Deux findings BLOQUANTS independants :
- F-DA-1 : la contrainte d'idempotence de graduation repose sur une colonne `content_hash` qui n'existe pas dans le schema actuel de `memory` — bloquant mais resolvable par un SELECT-before-INSERT sans migration lourde.
- F-EC-1 : les FK de `memory_links` pointent exclusivement vers `memory(id)`, rendant l'utilisation de cette table pour les liens issus de `agent_memory` physiquement impossible sans modification de schema non specifiee.

Les deux sont resolvables sans remettre en cause l'architecture globale.

---

## Findings detailles

### Devil's Advocate

---

**[BLOQUANT] F-DA-1 — `content_hash` inexistant dans le schema `memory`**

- Source : Contrainte 7 (section 7), V10 (section 8)
- Description : La spec stipule que la graduation est idempotente via `ON CONFLICT DO NOTHING` sur un index unique `(content_hash, metadata->>'source')` dans la table `memory`. Or, la table `memory` dans `db/schema.sql` (lignes 58-73) ne possede aucune colonne `content_hash`. L'expression `metadata->>'source'` peut servir d'index fonctionnel sur JSONB, mais `content_hash` est introuvable dans le schema. La migration SQL echouera a la creation de l'index unique.
- Impact : Bloquant — la contrainte d'idempotence est impossiblee a creer en l'etat. La graduation ne sera pas protegee contre la double-insertion.
- Evidence : `db/schema.sql` lignes 58-73 — colonnes de `memory` : `id, created_at, updated_at, type, content, deadline, completed_at, priority, importance_score, last_accessed_at, access_count, idea_status, metadata, embedding`. Aucune colonne `content_hash`.

---

**[MAJEUR] F-DA-2 — `resolveAgentMemoryConflict()` : constantes semantiques incompatibles avec l'exact-match**

- Source : R9, section 6.3
- Description : R9 definit `resolveAgentMemoryConflict()` comme reutilisant les seuils `DUPLICATE_THRESHOLD` et `CONTRADICTION_THRESHOLD` (constantes de similarite semantique : 0.85 et 0.80, utilisees dans `resolveMemoryConflict()` avec l'Edge Function `search`). Mais la section 6.3 precise explicitement que cette nouvelle fonction "N'utilise PAS l'Edge Function `search`" et "Compare par similarite de contenu normalise (lowercase, trim, whitespace collapse)". Ces deux descriptions sont incompatibles : on ne peut pas appliquer un seuil flottant de 0.85 a une comparaison de strings normalisees (le resultat serait toujours 0 ou 1). La spec nomme des constantes semantiques pour une logique binaire d'exact-match.
- Impact : Majeur — le developpeur interpretant R9 implementera soit une comparaison vectorielle (en voyant `DUPLICATE_THRESHOLD`), soit une comparaison string (en lisant la section 6.3), avec des comportements orthogonaux. Les V-criteres V2 testent "contenu identique normalise" (confirme exact-match), mais R9 reste ambigu.

---

**[MAJEUR] F-DA-3 — `agent_role TEXT` sur `memory_links` incompatible avec les FK existantes**

- Source : R14, section 5
- Description : `memory_links` a des colonnes `source_id UUID REFERENCES memory(id) ON DELETE CASCADE` et `target_id UUID REFERENCES memory(id) ON DELETE CASCADE` (`db/schema.sql` lignes 534-542). La spec (R14) propose d'utiliser cette table pour les liens inter-memoires role en ajoutant `agent_role TEXT` nullable. Mais les entrees `agent_memory` ont leurs propres UUIDs dans une table separee. Si `auto_link_agent_memory` tente d'inserer dans `memory_links` avec `source_id` = UUID d'une `agent_memory`, la FK vers `memory(id)` est violee. La reutilisation est physiquement impossible sans modifier les contraintes de la table.
- Impact : Majeur — l'implementation naive echouera avec une violation de contrainte FK a l'insertion de chaque lien depuis `agent_memory`.

---

**[MINEUR] F-DA-4 — Budget "8-12%" formule comme range mais `ROLE_MEMORY_SHARE` est une constante**

- Source : R6, section 4.1, V7
- Description : R6 definit le budget memoire role comme "8-12% du budget total". La section 4.1 precise `Math.floor(charBudget * ROLE_MEMORY_SHARE)` avec une seule constante. V7 teste que le share est "dans [0.08, 0.12]". Le tableau section 6.5 donne 0.10 (sans exploration) et 0.08 (avec exploration), mais ceux-ci sont les shares reequilibres de la section MEMOIRE ROLE dans `buildAgentContext()`, pas le `ROLE_MEMORY_SHARE` de `buildMemoryChains()`. La spec ne definit pas si `ROLE_MEMORY_SHARE` varie ou s'il est fixe a 0.10.

---

### Edge Case Hunter

---

**[BLOQUANT] F-EC-1 — FK `memory_links` rejette les UUIDs de `agent_memory`**

- Scenario : Un agent architect effectue un pipeline. `saveAgentMemory()` insere dans `agent_memory` (UUID = X). L'Edge Function `embed` genere un embedding. Le trigger `auto_link_agent_memory` (specifie en R13 et section 6.8) appelle `link_memory(X)`. Dans `link_memory()`, PostgreSQL tente d'inserer dans `memory_links` avec `source_id = X`. La contrainte FK `source_id REFERENCES memory(id)` rejette l'insertion car X n'existe pas dans `memory`.
- Source : R13 (trigger `auto_link_agent_memory`), R14 (reutilisation `memory_links`), section 6.8
- Impact : Bloquant — violation de contrainte d'integrite referentielle a chaque tentative de lien. La fonctionnalite de liens inter-memoires role est totalement inoperante. Le trigger echouera, potentiellement avec `RAISE WARNING` (pattern existant dans `link_memory()`, `db/schema.sql` lignes 625-627).
- Frequence estimee : Frequente — se produit a chaque pipeline avec `agent_role_memory=true` des qu'un embedding est genere.

---

**[MAJEUR] F-EC-2 — Hard limit 15 : table d'archivage pour `agent_memory` non definie**

- Scenario : `saveAgentMemory()` est appelee alors que l'agent "architect" a deja 15 entrees dans `agent_memory`. La spec dit "archiver l'entree la moins importante avant d'inserer la nouvelle". Mais aucune table d'archivage pour `agent_memory` n'est definie dans la spec. La table `memory_archive` existante (`db/schema.sql` lignes 681-696) est specifique a `memory` : pas de colonne `agent_role`, colonnes `type`, `deadline`, `completed_at` non pertinentes pour `agent_memory`. La spec ne dit pas : supprimer ? inserer dans `memory_archive` ? creer une `agent_memory_archive` ?
- Source : Contrainte 7 (section 7)
- Impact : Majeur — comportement non defini en production. L'implementeur devra choisir arbitrairement entre suppression et archivage, avec des implications differentes sur la tracabilite.
- Frequence estimee : Occasionnelle — atteinte progressivement apres plusieurs sprints pour les roles actifs (architect, qa).

---

**[MAJEUR] F-EC-3 — `item.agent` dans `workingMemory` : validation de role manquante**

- Scenario : `promoteWorkingMemory()` itere sur `workingMemory.decisions[].agent` (type `string` dans `WorkingMemoryData`, `src/memory.ts` lignes 886-892). Un agent peut ecrire un nom libre dans son output JSON : `"Mary (analyst)"`, `"architect_v2"`, `""`, ou omettre le champ. `saveAgentMemory()` recevra alors un role invalide, non present dans `ROLE_CANONICAL_TAGS`. La spec ne definit pas le comportement dans ce cas : tags vides ? exception ? skip silencieux ?
- Source : R15, section 3 (`WorkingMemoryData`), V9
- Impact : Majeur — la spec ne definit pas la validation du parametre `role` a l'entree de `saveAgentMemory()`. En production avec des agents imparfaits, des entrees `agent_memory` sans tags canoniques seront inserees, degradant la qualite de la memoire structuree.
- Frequence estimee : Occasionnelle — depend de la fidelite des outputs JSON des agents.

---

**[MINEUR] F-EC-4 — Graduation fire-and-forget : echec non observable**

- Scenario : `graduateAgentMemory()` est appele en fire-and-forget avec catch silencieux (pattern `bumpMemoryAccess`). Si Supabase est temporairement indisponible, si la contrainte d'idempotence echoue pour une raison inattendue, ou si le contenu normalise est vide (edge case), la graduation ne se produit pas sans aucune trace. La spec ne definit pas de logging minimum pour le catch.
- Source : Contrainte 7 (graduation non-bloquante), R11
- Frequence estimee : Rare.

---

### Simplicity Skeptic

---

**[MAJEUR] F-SS-1 — `memory_links` avec `agent_role` : deux incompatibilites structurelles**

- Source : R14, section 5
- Description : La spec propose d'ajouter `agent_role TEXT` nullable a `memory_links` pour eviter une table separee. Deux problemes independants :
  1. FK physiquement incompatibles (meme probleme que F-DA-3/F-EC-1) — les UUIDs de `agent_memory` ne peuvent pas etre `source_id` ou `target_id`.
  2. La contrainte UNIQUE existante `(source_id, target_id)` (`db/schema.sql` ligne 541) empeche d'avoir deux liens entre les memes IDs pour des roles differents. Si `agent_memory` uuid-A et `agent_memory` uuid-B (meme contenu, roles differents) sont lies, un seul lien peut exister. La semantique multi-role est perdue.
- Alternative : Retirer les liens inter-memoires role du perimetre V1. Les liens enrichis ajoutent une complexite significative (trigger SQL, schema migration, FK cross-table) pour une valeur incertaine en V1.
- Codebase : `db/schema.sql` lignes 534-543.

---

**[MAJEUR] F-SS-2 — `ROLE_TOKEN_BUDGETS` absent pour `planner` et `explorer`**

- Source : Section 3 (donnees d'entree), R6, section 6.5
- Description : La spec reference `ROLE_TOKEN_BUDGETS` depuis `agent-context.ts` pour calculer le budget de la section MEMOIRE ROLE. `agent-context.ts` (lignes 30-37) definit `ROLE_TOKEN_BUDGETS` pour 6 roles uniquement : `analyst(4000), pm(3500), architect(3500), dev(2000), qa(2500), sm(2000)`. Les roles `planner` et `explorer` — presents dans `ROLE_CANONICAL_TAGS` (section 6.7) et dans le type `AgentRole` (`src/orchestrator.ts` lignes 138-146) — n'ont pas de budget defini. `getTokenBudget()` retourne un fallback de 2500 tokens pour ces roles (code existant ligne 40), mais la spec ne mentionne pas ce comportement ni s'il est acceptable pour le calcul du budget memoire role.
- Alternative : Specifier dans la section 5 (fichiers concernes) que `ROLE_TOKEN_BUDGETS` est etendu avec `planner: 3000` et `explorer: 3000` dans `agent-context.ts`.
- Codebase : `src/agent-context.ts` lignes 30-40.

---

**[MINEUR] F-SS-3 — Flag `graduated` dans `agent_memory.metadata` : mise a jour non specifiee**

- Source : R11, V11
- Description : V11 teste que `graduateAgentMemory()` ne double-gradue pas si `metadata.graduated = true` sur les entrees sources. R11 dit que `agent_memory` est conservee apres graduation. Mais la spec ne definit pas l'operation qui ecrit `metadata.graduated = true` sur les entrees `agent_memory` sources : un UPDATE apres insertion dans `memory` ? L'ecriture initiale lors de l'insertion ? Le schema section 4.2 ne contient pas ce champ dans `metadata`. Sans cette etape, V11 ne peut jamais passer.

---

## Recommandations

### Corrections BLOQUANTES (prerequis avant implementation)

**1. Remplacer `ON CONFLICT` sur `content_hash` par SELECT-before-INSERT (F-DA-1)**

Supprimer la mention de `content_hash` et de l'index unique dans la spec. Remplacer par : "`graduateAgentMemory()` verifie d'abord si une entree avec `metadata->>'source' = 'agent_memory_graduation'` et le meme contenu normalise existe dans `memory` avant d'inserer (SELECT COUNT(*) > 0 → skip). Idempotence garantie par la logique applicative."

**2. Retirer les liens inter-memoires role du perimetre V1 (F-DA-3 / F-EC-1 / F-SS-1)**

Supprimer R13, R14, section 6.8 (`auto_link_agent_memory` trigger), V13 et la mention de liens enrichis dans la section 4.1. Les liens enrichis sont une feature V2. La table `memory_links` n'est pas modifiable sans casser les FK. Supprimer aussi le dernier bullet de la section 4.1 concernant l'affichage des liens.

### Corrections MAJEURES

**3. Clarifier `resolveAgentMemoryConflict()` : exact-match binaire (F-DA-2)**

Remplacer dans R9 : "Seuils DUPLICATE_THRESHOLD, CONTRADICTION_THRESHOLD reutilises" par : "Logique binaire : si le contenu normalise est identique a une entree existante pour le meme role → action 'skip'. Sinon → action 'insert'. Les constantes de similarite semantique ne sont PAS utilisees."

**4. Definir le comportement du hard limit 15 (F-EC-2)**

Specifier dans la contrainte 7 : "Quand le hard limit est atteint, l'entree `agent_memory` la moins importante (score le plus bas apres decroissance temporelle) est SUPPRIMEE avec un log `log.info` traçant l'id et le score. Pas de table d'archivage separee pour V1."

**5. Ajouter validation du role dans `saveAgentMemory()` (F-EC-3)**

Ajouter dans la section 7 (Contraintes) ou dans la signature de `saveAgentMemory()` : "Si `role` n'est pas une cle de `ROLE_CANONICAL_TAGS`, loguer un warning (`log.warn`) et retourner sans insertion."

**6. Etendre `ROLE_TOKEN_BUDGETS` pour `planner` et `explorer` (F-SS-2)**

Ajouter dans la section 5 (fichiers concernes) : "Dans `src/agent-context.ts` : ajouter `planner: 3000` et `explorer: 3000` a `ROLE_TOKEN_BUDGETS`."

### Corrections MINEURES

**7. Fixer `ROLE_MEMORY_SHARE` a 0.10 sans ambiguite (F-DA-4)** — remplacer "8-12%" dans R6 par "10% du budget total de l'agent (ROLE_MEMORY_SHARE = 0.10), reduit a 8% quand une exploration est presente".

**8. Ajouter `log.warn` dans le catch de graduation (F-EC-4)** — minimum observable : `log.warn("graduateAgentMemory failed (non-blocking)", { error: String(error) })`.

**9. Specifier UPDATE sur `agent_memory` lors de la graduation (F-SS-3)** — ajouter a la description de `graduateAgentMemory()` : "Apres insertion dans `memory`, mettre a jour `metadata.graduated = true` et `metadata.graduation_date` sur chaque entree `agent_memory` source via UPDATE."

---

## Points forts

- **Architecture additive exemplaire** : le feature flag `agent_role_memory` garantit zero regression sur les 3343 tests existants. Pattern conforme aux conventions du projet.
- **Toutes les corrections cycle 1 correctement appliquees** : travail rigoureux entre les deux cycles, aucune regression introduite.
- **Tags statiques sans LLM call** : decision pragmatique et coherente avec la contrainte de performance. `ROLE_CANONICAL_TAGS` bien defini pour les 8 roles incluant planner et explorer.
- **`resolveAgentMemoryConflict()` separee de `resolveMemoryConflict()`** : evite la contamination cross-table, decoupage propre.
- **Tableaux de reequilibrage complets** : les deux scenarios (avec/sans exploration) sont specifies avec totaux verifies — travail rigoureux.
- **18 V-criteres granulaires** : couverture unit/integration bien equilibree, aucun test E2E requis (complexite evitee a juste titre).
- **Graduation par exact-match** : choix sage pour V1, evite la dependance aux embeddings asynchrones.
- **Non-bloquant par design** : `graduateAgentMemory()` en fire-and-forget, pattern identique a `bumpMemoryAccess()` — coherence avec le codebase existant.

---

## Statistiques globales

| Agent | Bloquants | Majeurs | Mineurs | Total |
|-------|-----------|---------|---------|-------|
| Devil's Advocate | 1 | 2 | 1 | 4 |
| Edge Case Hunter | 1 | 2 | 1 | 4 |
| Simplicity Skeptic | 0 | 2 | 1 | 3 |
| **Total (deduplique)** | **2** | **5** | **3** | **10** |

Note de deduplication : F-DA-3, F-EC-1 et F-SS-1 portent sur le meme probleme structurel (FK `memory_links` incompatibles avec `agent_memory`). Comptes comme 3 findings distincts car chaque agent apporte un angle complementaire (contradiction spec, cas de crash, sur-complexite).

---

## Etape suivante

**GO WITH CHANGES** — Corriger les 2 bloquants et 5 majeurs dans la spec avant implementation :

1. Remplacer `ON CONFLICT DO NOTHING` sur `content_hash` par SELECT-before-INSERT (F-DA-1)
2. Retirer R13, R14, section 6.8 du scope V1 — liens inter-memoires role reportes en V2 (F-DA-3/F-EC-1/F-SS-1)
3. Clarifier que `resolveAgentMemoryConflict()` utilise un exact-match binaire, sans reference aux constantes de similarite semantique (F-DA-2)
4. Specifier le comportement du hard limit 15 : suppression avec log (F-EC-2)
5. Ajouter validation du parametre `role` dans `saveAgentMemory()` (F-EC-3)
6. Etendre `ROLE_TOKEN_BUDGETS` pour `planner` et `explorer` dans `agent-context.ts` (F-SS-2)

Puis : `/dev-implement "Implementer SPEC-memoire-hybride-agents-bmad. Spec: docs/specs/SPEC-memoire-hybride-agents-bmad.md"`
