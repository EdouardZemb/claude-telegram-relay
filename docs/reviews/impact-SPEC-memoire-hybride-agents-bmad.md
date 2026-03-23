## Rapport d'impact : Memoire hybride pour agents BMad (option D)

> Genere le 2026-03-23 a partir de docs/specs/SPEC-memoire-hybride-agents-bmad.md.

### Niveau de risque : HIGH

### Resume

La spec introduit 3 nouvelles fonctions publiques dans `src/memory.ts` (`saveAgentMemory`, `getAgentMemories`, `graduateAgentMemory`), modifie 2 fonctions publiques exportees (`promoteWorkingMemory` — nouvelle semantique avec sideeffect vers une table inexistante, `buildMemoryChains` — nouvelle section conditionnelle), et ajoute une nouvelle section dans `buildAgentContext` qui casse le budget token existant (somme des shares passe de 1.08 a 1.18 sans exploration). Des tests existants assertent des valeurs hardcodees qui deviennent incorrectes apres la modification, notamment `memory_promotion = false` dans deux fichiers de test alors que le flag est actuellement `true` dans `config/features.json`. Le blast radius couvre 4 modules sources directs et 6 fichiers de test impactes.

---

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/memory.ts` | Direct — modification | Ajout de 3 fonctions publiques (`saveAgentMemory`, `getAgentMemories`, `graduateAgentMemory`), modification de `promoteWorkingMemory` (ajout d'un appel `saveAgentMemory` conditionnel + `agent_role` dans metadata), modification de `buildMemoryChains` (section MEMOIRE ROLE conditionnelle). Import de `isFeatureEnabled` depuis `feature-flags.ts` a ajouter. |
| `src/agent-context.ts` | Direct — modification | Ajout de la section `MEMOIRE ROLE` dans `buildAgentContext()` avec `share: 0.10`, ajout de la constante `ROLE_MEMORY_SHARE = 0.10`, import de `getAgentMemories` depuis `memory.ts`. Reequilibrage obligatoire de tous les shares existants. |
| `src/orchestrator.ts` | Direct — modification | Appel de `saveAgentMemory()` apres chaque execution d'agent sous feature flag `agent_role_memory`. Modification de la zone lignes 1780-1800 (bloc `memory_promotion`). |
| `db/schema.sql` | Direct — modification | Ajout de 2 nouvelles tables (`agent_memory`, `agent_memory_links`), 1 RPC (`get_agent_memories`), 2 triggers (`auto_link_agent_memory` sur insert + update). |
| `config/features.json` | Direct — modification | Ajout du flag `agent_role_memory: false`. |
| `src/feature-flags.ts` | Indirect | Nouveau flag consomme via `isFeatureEnabled("agent_role_memory")` dans `memory.ts`, `agent-context.ts`, `orchestrator.ts`. Aucune modification requise mais dependance de deplacement de config. |
| `src/blackboard.ts` | Indirect | `WorkingMemory` (source de `item.agent`) est lu et transmis a `saveAgentMemory`. Interface non modifiee mais utilisee par le nouveau flux. |
| `src/agent.ts` | Indirect | Appelle `buildAgentContext()` — beneficiera de la nouvelle section MEMOIRE ROLE sans modification. Pas de breaking change si les shares sont correctement reequilibres. |
| `supabase/functions/embed` | Indirect — dependance | Le trigger `auto_link_agent_memory` depend de l'Edge Function `embed` pour les embeddings de `agent_memory`. L'Edge Function n'est pas modifiee mais son perimetre est etendu a une nouvelle table. |
| `tests/unit/memory-evolution.test.ts` | Impacte | Tests `promoteWorkingMemory` : V8 et V9 de la spec requerront des assertions sur `metadata.agent_role` et les appels a `saveAgentMemory`. Tests existants sur `metadata.agent` (ligne 595) restent valides mais incomplets. |
| `tests/unit/memory-chains.test.ts` | Impacte | Tests `buildMemoryChains` doivent couvrir la section MEMOIRE ROLE (V4, V5, V6). |
| `tests/unit/agent-context.test.ts` | Impacte | Tests `buildAgentContext` doivent verifier le budget MEMOIRE ROLE 8-12% (V7) et V16 (somme shares <= 1.0). Les valeurs hardcodees des budgets par role ne changent pas. |
| `tests/unit/feature-flags.test.ts` | Impacte | Ajouter le test du flag `agent_role_memory` (V14). |
| `tests/unit/orchestrator.test.ts` | **Impacte — REGRESSION ACTIVE** | Ligne 446 : `expect(flags.memory_promotion).toBe(false)` — le flag est actuellement `true` dans `config/features.json`. Ce test echoue deja. L'ajout du flag `agent_role_memory` n'aggrave pas ce probleme mais il existe independamment. |
| `tests/unit/memory-evolution.test.ts` | **Impacte — REGRESSION ACTIVE** | Ligne 1091 : `expect(content.memory_promotion).toBe(false)` — meme probleme que ci-dessus. |

---

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/memory.ts` | `promoteWorkingMemory(supabase, workingMemory, sessionId)` | Modification comportementale (sideeffect nouveau vers `agent_memory` si flag actif) | Oui — signature inchangee, sideeffect conditionnel sous feature flag |
| `src/memory.ts` | `buildMemoryChains(supabase, role)` | Modification comportementale (section additionnelle dans le retour si flag actif) | Oui — retour toujours `string`, section conditionnelle |
| `src/memory.ts` | `saveAgentMemory(supabase, role, content, tags)` | Ajout | Oui — nouvel export |
| `src/memory.ts` | `getAgentMemories(supabase, role, limit)` | Ajout | Oui — nouvel export |
| `src/memory.ts` | `graduateAgentMemory(supabase, content)` | Ajout | Oui — nouvel export |
| `src/agent-context.ts` | `buildAgentContext(supabase, options)` | Modification comportementale (section MEMOIRE ROLE additionnelle si flag actif) | Oui — retour toujours `string`, section conditionnelle |
| `src/agent-context.ts` | `ROLE_MEMORY_SHARE` | Ajout de constante exportee | Oui — nouvel export |
| `src/agent-context.ts` | `ROLE_MEMORY_TAGS` | Ajout de constante exportee | Oui — nouvel export |

---

### Breaking changes potentiels

- [x] **Depassement de budget token dans `buildAgentContext`** — **impact** : `src/agent-context.ts`, tous les agents consommant ce contexte (`src/agent.ts`, `src/orchestrator.ts`). Le total des shares sans exploration est actuellement **1.08** (10 sections). L'ajout de `ROLE_MEMORY_SHARE = 0.10` porterait ce total a **1.18**, violant la contrainte V16. La spec l'indique en zone d'ombre (section 9.2) mais ne fixe pas le reequilibrage exact. Sans reequilibrage, les dernières sections (CONTEXTE CONVERSATION, TACHES SIMILAIRES) ne seront jamais atteintes car le budget s'epuisera avant.

- [x] **`resolveMemoryConflict` est couplee a la table `memory` via `findSimilarFact`** — **impact** : `src/memory.ts`. La spec (R9) indique que `resolveMemoryConflict` doit etre reutilisee dans `saveAgentMemory` mais en filtrant sur la table `agent_memory`. Or `findSimilarFact` est hardcodee sur `table: "memory"` (ligne 766 : `body: { query: content, table: "memory", ... }`). La reutilisation telle quelle effectuerait la deduplication sur la memoire globale plutot que sur `agent_memory`. Une variante `findSimilarAgentMemory(supabase, role, content)` sera necessaire.

- [x] **Race condition sur la graduation non-atomique** — **impact** : `src/memory.ts` (`graduateAgentMemory`). La spec (zone d'ombre 5) signale que la mise a jour de `metadata.graduated = true` sur les entrees sources doit etre atomique. Sans verrou ou transaction, deux executions paralleles peuvent inserer deux fois le meme pattern dans `memory` globale avant que le flag `graduated` soit ecrit.

- [x] **Tests assertant `memory_promotion = false` en conflit avec config actuelle** — **impact** : `tests/unit/orchestrator.test.ts` ligne 446, `tests/unit/memory-evolution.test.ts` ligne 1091. Ces tests echouent deja (`memory_promotion` vaut `true` dans `config/features.json`). L'implementeur devra les corriger independamment de cette spec.

---

### Points d'attention pour le Reviewer

1. **Reequilibrage des shares obligatoire avant integration** (`src/agent-context.ts` lignes 119-188) : le total actuel sans exploration est 1.08, pas 0.93 comme mentionne en zone d'ombre de la spec. Ajouter 0.10 donne 1.18. Le Reviewer doit exiger la table de reequilibrage complete avant merge (quelles sections sont reduites et de combien). V16 doit etre couvert par un test calculant la somme reelle des shares depuis le code source.

2. **`findSimilarFact` hardcodee sur `table: "memory"` — ne pas reutiliser telle quelle** (`src/memory.ts` ligne 766) : la spec indique "reutiliser `resolveMemoryConflict()`" mais cette fonction appelle `findSimilarFact` qui query la table `memory`. Pour `saveAgentMemory`, la recherche de doublons doit porter sur la table `agent_memory` (filtree par `agent_role`). Le Reviewer doit verifier que `saveAgentMemory` n'utilise pas `resolveMemoryConflict` directement mais une variante pointant vers `agent_memory`.

3. **Edge Function `embed` etendue a une nouvelle table sans modification** (`supabase/functions/embed`) : le trigger `auto_link_agent_memory` appelle `link_memory()` qui appelle l'Edge Function `embed` pour generer les embeddings de `agent_memory`. Verifier que l'Edge Function `embed` accepte les inserts depuis la table `agent_memory` (le body de la requete webhook peut inclure le nom de la table source). Si l'Edge Function filtre uniquement la table `memory`, le trigger sera silencieusement inoperant.

4. **Atomicite de `graduateAgentMemory`** (`src/memory.ts` — fonction a creer) : le Reviewer doit verifier que la mise a jour de `metadata.graduated = true` sur les deux entrees sources est effectuee dans la meme transaction (ou avec un mecanisme idempotent), avant l'insertion dans `memory` globale. Sans atomicite, un double-insert est possible en cas de pipelines paralleles. Un test unitaire de re-entrance doit etre exige (V11 couvre le cas "entrees deja graduees" mais pas le scenario de concurrence).

5. **Import circulaire potentiel** : `memory.ts` doit importer `isFeatureEnabled` depuis `feature-flags.ts`. Verifier qu'il n'existe pas de dependance inverse (actuellement `feature-flags.ts` n'importe pas `memory.ts`, verifiable dans les imports actuels). Risque faible mais a confirmer lors de l'implementation.

6. **Tests pre-existants en echec** (`config/features.json` + tests) : avant d'executer `bun test`, l'implementeur doit corriger `orchestrator.test.ts` ligne 446 et `memory-evolution.test.ts` ligne 1091 qui assertent `memory_promotion = false` alors que le flag est `true`. Ces echecs pre-existants masqueront les nouveaux echecs si non corriges.

---

### Blast radius

- Modules directement modifies : 5 (`src/memory.ts`, `src/agent-context.ts`, `src/orchestrator.ts`, `db/schema.sql`, `config/features.json`)
- Modules indirectement impactes : 4 (`src/feature-flags.ts`, `src/blackboard.ts`, `src/agent.ts`, `supabase/functions/embed`)
- Fichiers source modifies : 5
- Fichiers de test a verifier : 6 (`tests/unit/memory-evolution.test.ts`, `tests/unit/memory-chains.test.ts`, `tests/unit/agent-context.test.ts`, `tests/unit/feature-flags.test.ts`, `tests/unit/orchestrator.test.ts`, nouveau `tests/unit/memory-chains.test.ts` pour V4-V6)
