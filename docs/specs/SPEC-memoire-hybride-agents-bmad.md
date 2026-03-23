# Spec : Memoire hybride pour agents BMad (option D)

> Genere le 2026-03-23. Source : docs/explorations/EXPLORE-explore-et-analyse-les-dernieres.md (option D, section 4), input utilisateur, exploration codebase (src/memory.ts, src/agent-context.ts, src/orchestrator.ts, db/schema.sql, config/features.json).

## 1. Objectif

Implementer la memoire hybride (option D) pour les agents BMad : chaque agent accumule une memoire role-specifique persistante (table `agent_memory`) en complement de la memoire globale partagee. Les agents annotent leurs memoires avec des tags structures sans LLM call systematique (auto-organisation allegee). Les liens inter-memoires role sont reportes en V2 (contrainte FK sur `memory_links`). Un mecanisme de "graduation" promeut les patterns confirms par plusieurs roles vers la memoire globale. Le deploiement est progressif via feature flag `agent_role_memory`.

L'objectif est de permettre a l'architecte d'accumuler des patterns architecturaux, au QA des patterns de bugs recurrents, au PM des patterns de planification, etc., enrichissant la qualite des evaluations au fil des sprints.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Une table `agent_memory` separee stocke les memoires role-specifiques, distincte de la table `memory` globale | Exploration section 4 option D + input utilisateur | `agent_memory` avec colonne `agent_role TEXT NOT NULL` |
| R2 | `buildMemoryChains()` injecte la memoire role-specifique EN COMPLEMENT (pas en remplacement) de la memoire globale | Input utilisateur, exploration section 6 | Section "MEMOIRE ROLE" ajoutee apres "CONTEXTE MEMOIRE" |
| R3 | Le pipeline de promotion working memory taggue chaque item promu avec le role de l'agent source | Input utilisateur, exploration section 6 | `metadata.agent_role = "architect"` sur les faits promus |
| R4 | Les agents annotent leurs memoires avec des tags structures via champ `tags TEXT[]` — sans LLM call supplementaire | Input utilisateur (auto-organisation allegee) | `tags = ["pattern-architectural", "decision-technique"]` |
| R5 | Les tags sont determines par le role de l'agent : chaque role a un ensemble de tags canoniques predetermines | Input utilisateur | architect → `["pattern-architectural", "contrainte-technique"]`, qa → `["pattern-bug", "regression"]`, pm → `["pattern-planification", "estimation"]` |
| R6 | Budget tokens : la section memoire role represente 8-12% du budget total de l'agent | Input utilisateur | analyst budget=4000 tokens → ~400-480 tokens pour memoire role |
| R7 | Limite de 15 memoires role-specifiques par agent (recuprees par score d'importance decroissant) | Input utilisateur | `get_agent_memories(p_role, p_limit=15)` |
| R8 | La decroissance temporelle (half-life 70 jours) s'applique aux memoires `agent_memory` identique aux memoires globales | Exploration section 6 contraintes, coherence avec `calculateEffectiveImportance()` | Score = 50 * 2^(-age/70) + acces_boost |
| R9 | La resolution de conflits s'applique aux memoires role avant insertion via `resolveAgentMemoryConflict(supabase, role, content)` qui query `agent_memory` filtree par `agent_role`. Comparaison par exact-match binaire sur contenu normalise (lowercase, trim, whitespace collapse) — pas de seuils semantiques (DUPLICATE_THRESHOLD n'est pas applicable car il repose sur l'Edge Function `search` hardcodee sur `memory`). Actions : "skip" si contenu identique normalise, "insert" sinon | Adversarial cycle 1 F-DA-1, cycle 2 F-DA-2 | table cible = `agent_memory`, comparaison binaire |
| R10 | Mecanisme de "graduation" V1 par exact-match (contenu normalise) : une memoire role est graduee vers la memoire globale quand le meme contenu (normalise : lowercase, trim, whitespace collapse) est confirme par au moins 2 roles distincts. Seuil de graduation fixe : exact-match sur contenu normalise (pas de similarite semantique en V1 — les embeddings sont generes de maniere asynchrone par trigger et ne sont pas disponibles au moment de la graduation) | Input utilisateur, adversarial F-SS-2, F-DA-4 | architect + qa confirment le meme pattern architectural → graduation vers `memory` globale |
| R11 | La graduation copie le contenu vers `memory` avec `metadata.source = "agent_memory_graduation"` et conserve l'entree `agent_memory` (pas de suppression) | Input utilisateur, principe de non-regression | Double persistance : `agent_memory` conservee + nouvelle entree `memory` |
| R12 | Le feature flag `agent_role_memory` controle l'activation : si false, `buildMemoryChains()` se comporte comme avant | Input utilisateur, pattern feature-flags existant | `isFeatureEnabled("agent_role_memory")` dans `buildMemoryChains()` et `promoteWorkingMemory()` |
| R13 | Les memoires role-specifiques ont leurs propres embeddings (colonne `embedding VECTOR(1536)`) pour la recherche semantique future (V2). Le trigger `embed` existant genere les embeddings de maniere asynchrone | Input utilisateur (reutilisation embeddings existants), architecture exploration | Edge function `embed` + trigger sur `agent_memory` |
| R14 | **REPORTE V2** : les liens inter-memoires role sont hors scope V1. Raison : `memory_links.source_id` a une FK vers `memory(id)`, rendant impossible l'insertion de liens depuis `agent_memory` sans refonte du schema de liens (adversarial cycle 2 F-DA-3/F-EC-1). En V1, la section MEMOIRE ROLE affiche les memoires en format plat (sans liens) pour tous les roles | Adversarial cycle 2 F-DA-3, F-EC-1, F-SS-1 | Format plat uniquement en V1 |
| R15 | La fonction `saveAgentMemory()` est appelee par l'orchestrateur a la fin de chaque execution d'agent (phase de promotion). Elle valide que le role fourni est present dans `ROLE_CANONICAL_TAGS` avant insertion (adversarial cycle 2 F-EC-3 : `item.agent` est un string libre, pas un role valide garanti) | Exploration section 6 fichiers concernes, adversarial cycle 2 F-EC-3 | Apres `promoteWorkingMemory()` dans orchestrator.ts. Si role invalide : log.warn et skip |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `WorkingMemoryData` (blackboard working_memory) | Interface TypeScript | `readSection(supabase, bbSessionId, "working_memory")` | `decisions[].agent`, `decisions[].decision`, `decisions[].reasoning`, `discoveries[].agent`, `discoveries[].fact` |
| `AgentRole` (string) | Type TypeScript | Parametre de `buildAgentContext()` et `buildMemoryChains()` | Valeurs : "analyst", "pm", "architect", "dev", "qa", "sm", "planner", "explorer" |
| `agent_memory` table Supabase | Table PostgreSQL | RPC `get_agent_memories(p_role, p_limit)` | `id`, `content`, `agent_role`, `tags`, `importance_score`, `created_at`, `last_accessed_at`, `access_count` |
| Feature flag `agent_role_memory` | JSON file | `isFeatureEnabled("agent_role_memory")` | Valeur booleenne |
| `ROLE_TOKEN_BUDGETS` | Constante TypeScript | Importee depuis `agent-context.ts` | Budget par role en tokens |

## 4. Donnees de sortie

### 4.1 Section "MEMOIRE ROLE" dans le contexte agent

Structure formatee injectee dans `buildAgentContext()` :

```
MEMOIRE ROLE (architect):
- Pattern architectural: [contenu] [tags: pattern-architectural, microservice]
- Decision technique: [contenu] [tags: decision-technique]
```

Regles de remplissage :
- Affichee uniquement si `isFeatureEnabled("agent_role_memory")` et des memoires role existent (R12)
- Limitee a 15 memoires maximum (R7), triees par score d'importance decroissant (R8)
- Budget : 8-12% du budget total de l'agent, calcule via `Math.floor(charBudget * ROLE_MEMORY_SHARE)` (R6)
- Tags affiches entre crochets en fin de contenu (R4, R5)
- V1 : format plat pour tous les roles (liens inter-memoires role reportes V2, R14). Pas de `[extends]` / `[supports]` dans la section MEMOIRE ROLE en V1

### 4.2 Entrees `agent_memory` (insertion)

Schema de l'objet insere :
```typescript
{
  agent_role: "architect",
  content: "Pattern: injection de dependances via buildAgentContext (raison: testabilite)",
  tags: ["pattern-architectural", "decision-technique"],
  importance_score: 75,
  metadata: {
    source: "working_memory_promotion",
    pipeline_session_id: "uuid-session",
    promotion_type: "decision" | "discovery",
    graduated: false
  }
}
```

### 4.3 Entree `memory` (graduation)

Lorsqu'un pattern est confirme par >= 2 roles :
```typescript
{
  type: "fact",
  content: "[contenu original]",
  metadata: {
    source: "agent_memory_graduation",
    confirming_roles: ["architect", "qa"],
    graduated_from_ids: ["uuid-agent-memory-1", "uuid-agent-memory-2"],
    graduation_date: "2026-03-23T..."
  }
}
```

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `db/schema.sql` | Modifier | Ajouter table `agent_memory`, RPC `get_agent_memories`, trigger embed sur `agent_memory` (liens inter-memoires reportes V2) |
| `src/memory.ts` | Modifier | Ajouter `saveAgentMemory()`, `getAgentMemories()`, `graduateAgentMemory()`, `resolveAgentMemoryConflict()`, modifier `promoteWorkingMemory()` pour tagger avec role |
| `src/agent-context.ts` | Modifier | Modifier `buildAgentContext()` et `buildMemoryChains()` pour injecter la section MEMOIRE ROLE, ajouter constante `ROLE_MEMORY_SHARE`, `ROLE_MEMORY_TAGS` |
| `src/orchestrator.ts` | Modifier | Appeler `saveAgentMemory()` apres chaque execution d'agent (apres promoteWorkingMemory), sous feature flag |
| `config/features.json` | Modifier | Ajouter flag `agent_role_memory: false` (inactif par defaut) |
| `tests/unit/memory-chains.test.ts` | Modifier | Ajouter tests pour `getAgentMemories()`, `saveAgentMemory()`, `graduateAgentMemory()`, section MEMOIRE ROLE dans buildMemoryChains |
| `tests/unit/agent-context.test.ts` | Modifier | Ajouter tests pour la section MEMOIRE ROLE dans buildAgentContext, budget 8-12% |
| `tests/unit/feature-flags.test.ts` | Modifier | Ajouter test pour le flag `agent_role_memory` |

## 6. Patterns existants

### 6.1 Structure de buildMemoryChains() a etendre

`src/memory.ts` lignes 1521-1626 — le pattern exact a suivre pour ajouter la section role :

```typescript
// Tactical roles: flat facts (dev, sm)
if (role === "dev" || role === "sm") {
  parts.push("Faits cles:\n" + facts.slice(0, 10).map((f) => `- ${f.content}`).join("\n"));
} else {
  // Strategic roles: structured chains
  // ... chaines avec liens enrichis via classifyLinkContent()
}
```

En V1, la section MEMOIRE ROLE utilise le format plat pour TOUS les roles (liens reportes V2). V2 pourra ajouter les chaines enrichies pour les roles strategiques.

### 6.2 Pattern de promotion working memory a modifier

`src/memory.ts` lignes 899-972 — fonction `promoteWorkingMemory()`. L'agent est deja disponible dans `item.agent` (ligne 908). Il suffit d'ajouter `agent_role` dans le metadata a l'insertion (ligne 953) ET d'appeler `saveAgentMemory()` en parallele :

```typescript
// Existant (ligne 953-964) :
const { error } = await supabase.from("memory").insert({
  type: "fact",
  content,
  metadata: {
    source: "working_memory_promotion",
    pipeline_session_id: sessionId,
    agent: item.agent,          // <- deja present
    promotion_type: item.promotionType,
  },
});
```

### 6.3 Pattern de resolution de conflits — variante agent_memory

`src/memory.ts` lignes 797-824 — `resolveMemoryConflict()`. Cette fonction est **hardcodee sur la table `memory`** (Edge Function `search` avec `table: "memory"`, adversarial F-DA-1). Elle ne peut PAS etre reutilisee telle quelle pour `agent_memory`. Creer `resolveAgentMemoryConflict(supabase, role, content)` qui :
1. Query `agent_memory` filtree par `agent_role = role`
2. Compare par similarite de contenu normalise (lowercase, trim, whitespace collapse)
3. Retourne `{ action: "skip" | "insert", existingId? }` — exact-match binaire (pas de seuils semantiques DUPLICATE_THRESHOLD, adversarial cycle 2 F-DA-2)
4. N'utilise PAS l'Edge Function `search` (pas de dependance aux embeddings asynchrones pour la deduplication)

### 6.4 Pattern de calcul d'importance reutilisable

`src/memory.ts` lignes 147-176 — `calculateEffectiveImportance(baseScore, createdAt, lastAccessedAt, accessCount)`. Aucune modification requise, la fonction est pure et independante de la table.

### 6.5 Pattern de budget tokens et sections

`src/agent-context.ts` lignes 119-189 — le tableau `sections` avec `{ label, content, share }` :

```typescript
const sections: Array<{ label: string; content: string; share: number }> = [];
if (memoryCtx) sections.push({ label: "CONTEXTE MEMOIRE", content: memoryCtx, share: 0.23 });
// ... autres sections
```

Le meme pattern s'applique pour la section MEMOIRE ROLE. Tableau de reequilibrage exact des shares (adversarial F-DA-2 : total actuel sans exploration = 1.08, pas 0.93) :

**Sans exploration** (target = 1.00) :

| Section | Avant | Apres |
|---------|-------|-------|
| CONTEXTE MEMOIRE | 0.23 | 0.20 |
| SPRINT ACTUEL | 0.10 | 0.08 |
| TACHES RECENTES | 0.13 | 0.11 |
| GRAPHE CODE | 0.10 | 0.08 |
| CONFIANCE AGENTS | 0.07 | 0.06 |
| METRIQUES SPRINT | 0.09 | 0.08 |
| DOCUMENTS PROJET | 0.10 | 0.08 |
| PROFIL UTILISATEUR | 0.08 | 0.07 |
| TACHES SIMILAIRES | 0.10 | 0.08 |
| CONTEXTE CONVERSATION | 0.08 | 0.06 |
| **MEMOIRE ROLE** | -- | **0.10** |
| **Total** | **1.08** | **1.00** |

**Avec exploration** (target = 1.00) :

| Section | Avant | Apres |
|---------|-------|-------|
| CONTEXTE MEMOIRE | 0.21 | 0.18 |
| RAPPORT EXPLORATION | 0.12 | 0.10 |
| SPRINT ACTUEL | 0.08 | 0.07 |
| TACHES RECENTES | 0.11 | 0.09 |
| GRAPHE CODE | 0.08 | 0.07 |
| CONFIANCE AGENTS | 0.06 | 0.05 |
| METRIQUES SPRINT | 0.07 | 0.06 |
| DOCUMENTS PROJET | 0.08 | 0.07 |
| PROFIL UTILISATEUR | 0.06 | 0.05 |
| TACHES SIMILAIRES | 0.07 | 0.06 |
| CONTEXTE CONVERSATION | 0.06 | 0.05 |
| **MEMOIRE ROLE** | -- | **0.08** |
| **Total** | **1.00** | **0.93** |

Note : le total avec exploration (0.93) est sous 1.00 car toutes les sections ne sont pas toujours presentes. Les sections manquantes liberent de l'espace supplementaire.

### 6.6 Pattern de feature flag

`src/feature-flags.ts` ligne 31-34 — `isFeatureEnabled(flag: string): boolean`. Pattern utilise partout, notamment dans `orchestrator.ts` ligne 1780 : `if (isFeatureEnabled("memory_promotion"))`.

### 6.7 Pattern de tags canoniques par role

Inspire de `src/trust-scores.ts` (suivi par role) et `src/bmad-agents.ts` (definitions des 8 agents). Les tags canoniques seront une constante dans `src/memory.ts` :

```typescript
const ROLE_CANONICAL_TAGS: Record<string, string[]> = {
  analyst: ["analyse-metier", "exigence", "besoin-utilisateur", "risque"],
  pm: ["planification", "estimation", "priorite", "dependance"],
  architect: ["pattern-architectural", "decision-technique", "contrainte", "dette-technique"],
  dev: ["implementation", "fix", "refactoring", "api"],
  qa: ["pattern-bug", "regression", "cas-limite", "test-manquant"],
  sm: ["processus", "blocage", "retrospective", "velocite"],
  planner: ["decomposition", "estimation", "priorisation", "scope"],
  explorer: ["recherche", "benchmark", "etat-art", "alternative"],
};
```

### 6.8 Trigger embed existant (pattern a reutiliser)

`db/schema.sql` — trigger sur la table `memory` qui appelle l'Edge Function `embed` quand un contenu est insere. Le meme pattern de trigger sera cree sur `agent_memory` pour generer les embeddings (utile pour V2 quand les liens seront implementes). Note : le trigger `auto_link_memory` qui appelle `link_memory()` n'est PAS replique en V1 car `memory_links.source_id` a une FK vers `memory(id)` (adversarial cycle 2).

## 7. Contraintes

- **Ne pas casser** : `buildMemoryChains()` et `buildAgentContext()` continuent de fonctionner exactement comme avant quand `agent_role_memory` est false. Zero regression sur les 3343 tests existants.
- **Ne pas casser** : `promoteWorkingMemory()` continue de persister dans `memory` globale. L'ajout de `saveAgentMemory()` est additionnel, pas un remplacement.
- **Budget tokens strict** : la somme de tous les `share` dans `sections` ne doit pas depasser 1.0. L'ajout du share 0.10 (sans exploration) / 0.08 (avec exploration) pour MEMOIRE ROLE necessite de reequilibrer les autres sections selon le tableau exact de la section 6.5. Les tests `agent-context.test.ts` verifient ces proportions.
- **Pas de LLM call supplementaire** : la generation des tags est entierement basee sur `ROLE_CANONICAL_TAGS` (lookup statique). Aucun appel a `classify-thought` ou autre Edge Function pour l'annotation des memoires role.
- **Idempotence** : `saveAgentMemory()` doit appeler `resolveAgentMemoryConflict()` (exact-match binaire sur contenu normalise) avant insertion. La graduation utilise un SELECT-before-INSERT avec verification `metadata.graduated = true` sur les entrees sources pour garantir l'idempotence (adversarial cycle 2 F-DA-1 : la colonne `content_hash` n'existe pas dans `memory`, donc pas de `ON CONFLICT`). Le pattern est : 1) SELECT entrees agent_memory avec meme contenu normalise, 2) verifier >= 2 roles distincts et aucune entree deja graduee, 3) INSERT dans `memory`, 4) UPDATE `metadata.graduated = true` sur les sources.
- **Graduation non-bloquante** : `graduateAgentMemory()` est appele en fire-and-forget (catch silencieux) pour ne pas bloquer le pipeline, pattern identique a `bumpMemoryAccess()`.
- **Limite de volume avec eviction** : la table `agent_memory` ne doit pas depasser 15 entrees actives par role. Quand le hard limit est atteint lors d'une insertion, supprimer l'entree la moins importante (score le plus bas apres decroissance temporelle) avec un log.info("agent_memory eviction", { role, evictedId, evictedScore }) avant d'inserer la nouvelle (adversarial cycle 2 F-EC-2 : `memory_archive` a un schema incompatible, pas de colonne `agent_role`). Pas de rejet silencieux.
- **Dependance Edge Function `embed`** : le trigger embed sur `agent_memory` depend de l'Edge Function `embed` existante pour generer les embeddings. L'Edge Function n'est pas modifiee. Le trigger auto-link n'est PAS replique en V1 (FK constraint, adversarial cycle 2).
- **RLS** : la nouvelle table `agent_memory` doit avoir une politique RLS "Allow all for authenticated" (pattern coherent avec la table `memory`).

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `saveAgentMemory(supabase, "architect", content, ["pattern-architectural"])` insere dans `agent_memory` avec `agent_role="architect"` et `tags=["pattern-architectural"]` | Test unitaire avec mock Supabase : verifier `from("agent_memory").insert()` appele avec les bons champs | unit |
| V2 | `saveAgentMemory()` appelle `resolveAgentMemoryConflict()` (pas `resolveMemoryConflict()`) et retourne 0 si la memoire est un doublon (action "skip") | Test unitaire : mock retournant contenu identique normalise, verifier qu'aucune insertion n'est faite | unit |
| V3 | `getAgentMemories(supabase, "qa", 15)` retourne au maximum 15 entrees pour le role "qa", triees par importance_score decroissant | Test unitaire avec mock retournant 20 entrees, verifier slice a 15 | unit |
| V4 | `buildMemoryChains(supabase, "architect")` avec `agent_role_memory=true` inclut une section "MEMOIRE ROLE (architect)" dans le resultat | Test unitaire : mock `get_agent_memories` retournant 3 entrees, verifier presence de la section dans la string retournee | unit |
| V5 | `buildMemoryChains(supabase, role)` avec `agent_role_memory=true` retourne la section MEMOIRE ROLE en format plat (sans liens) pour TOUS les roles en V1 (liens reportes V2) | Test unitaire : verifier absence de prefixe `[extends]` ou `[supports]` dans la section MEMOIRE ROLE pour architect et dev | unit |
| V6 | `buildMemoryChains(supabase, "analyst")` avec `agent_role_memory=false` ne contient pas "MEMOIRE ROLE" | Test unitaire : setFeature("agent_role_memory", false), verifier absence de la section | unit |
| V7 | `buildAgentContext(supabase, { role: "architect" })` avec `agent_role_memory=true` alloue entre 8% et 12% du budget total a la section MEMOIRE ROLE | Test unitaire : verifier que `Math.floor(charBudget * ROLE_MEMORY_SHARE)` est dans [0.08, 0.12] * charBudget | unit |
| V8 | `promoteWorkingMemory()` persiste dans `metadata.agent_role` le role de l'agent source pour chaque item promu | Test unitaire : WorkingMemoryData avec `decisions[0].agent = "qa"`, verifier `metadata.agent_role = "qa"` dans l'insertion | unit |
| V9 | `promoteWorkingMemory()` appelle `saveAgentMemory()` pour chaque item promu quand `agent_role_memory=true` | Test unitaire : mock `saveAgentMemory`, verifier nb d'appels = nb items promus | unit |
| V10 | `graduateAgentMemory(supabase, content)` insere dans `memory` avec `metadata.source = "agent_memory_graduation"` et `metadata.confirming_roles` contenant au moins 2 roles distincts. Graduation par exact-match sur contenu normalise (lowercase, trim, whitespace collapse). Idempotent via SELECT-before-INSERT + UPDATE `metadata.graduated = true` sur les sources | Test unitaire : mock deux entrees `agent_memory` de roles distincts avec meme contenu normalise, verifier insertion dans `memory` et UPDATE graduated=true | unit |
| V11 | `graduateAgentMemory()` ne double-gradue pas si la graduation a deja eu lieu (metadata.graduated = true sur les entrees `agent_memory` sources) | Test unitaire : entrees avec `metadata.graduated = true`, verifier qu'aucune insertion dans `memory` n'est faite | unit |
| V12 | Le schema SQL `agent_memory` contient les colonnes `id UUID`, `agent_role TEXT NOT NULL`, `content TEXT NOT NULL`, `tags TEXT[]`, `importance_score NUMERIC`, `embedding VECTOR(1536)`, `metadata JSONB` | Verification du fichier db/schema.sql (grep/read) | manual |
| V13 | Le RPC `get_agent_memories(p_role, p_limit)` filtre par `agent_role = p_role` et ordonne par `importance_score DESC` | Test integration avec mock Supabase : verifier que le RPC est appele avec les bons parametres | integration |
| V14 | `isFeatureEnabled("agent_role_memory")` retourne false avant que le flag soit active dans `config/features.json` | Test unitaire existant dans feature-flags.test.ts : verifier que flag inconnu retourne false | unit |
| V15 | `buildAgentContext(null, { role: "architect" })` retourne `""` independamment du feature flag | Test unitaire existant a garder : regression guard | unit |
| V16 | La somme de tous les shares dans `sections` de `buildAgentContext()` est <= 1.0 apres ajout de ROLE_MEMORY_SHARE | Test unitaire : sommer tous les shares definis, verifier <= 1.0 | unit |
| V17 | `ROLE_CANONICAL_TAGS["architect"]` contient `"pattern-architectural"` et `ROLE_CANONICAL_TAGS["qa"]` contient `"pattern-bug"` et `ROLE_CANONICAL_TAGS["planner"]` et `ROLE_CANONICAL_TAGS["explorer"]` existent | Test unitaire : verifier les valeurs de la constante exportee pour les 8 roles | unit |
| V18 | L'orchestrateur appelle `saveAgentMemory()` apres chaque agent execute avec succes quand `agent_role_memory=true` | Test integration : mock orchestrateur avec pipeline ["architect", "qa"], verifier 2 appels a saveAgentMemory | integration |
| V19 | `saveAgentMemory()` avec un role invalide (ex: "unknown") log un warning et retourne 0 sans insertion | Test unitaire : verifier log.warn et aucun appel a `from("agent_memory").insert()` | unit |
| V20 | `saveAgentMemory()` avec hard limit atteint (15 memoires existantes) supprime la moins importante avec log avant insertion | Test unitaire : mock retournant 15 entrees existantes, verifier DELETE puis INSERT | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Gap clairement identifie par l'exploration : agents indifferencies par role, pas de memoire procedural par specialite. Les 3 sources academiques convergent sur la valeur de la memoire role-specifique. |
| Perimetre | Couvert | V1 (option D hybride) : table separee + injection contexte + promotion taguee + auto-organisation legere par tags statiques + graduation. Hors scope V1 : cleanup/archivage memoires anciennes par role, UI de visualisation des memoires role, metriques d'usage par role. |
| Validation | Couvert | 18 V-criteres dont 15 unit et 3 integration. Pas de test E2E (necessite embedding reel + Supabase), ce qui est accepte car la logique metier est testable par mocks. |
| Technique | Couvert | Architecture additive (pas de refonte), feature flag, budget tokens reequilibre, tags statiques sans LLM call, graduation non-bloquante. Dependances : Edge Function `embed` (non modifiee), trigger SQL auto-link. |
| UX | Non applicable | Pas d'interaction utilisateur directe. Les memoires role-specifiques sont injectees silencieusement dans le contexte agent. La commande `/brain health` pourrait afficher des stats (hors scope V1). |
| Alternatives | Pertinent | Option C (A-MEM full agentique) evaluee et ecartee : cout LLM systematique + refonte memory.ts + benefice marginal incertain. Option B (role-specifique sans auto-organisation) evaluee et augmentee : D > B car les tags statiques et les liens enrichis par role ajoutent de la valeur structurelle a cout quasi nul. |

### Zones d'ombre residuelles

1. ~~**Seuil de graduation**~~ — RESOLU (adversarial F-DA-4, F-SS-2) : graduation V1 par exact-match sur contenu normalise (pas de similarite semantique). Plus de zone d'ombre sur le seuil.

2. ~~**Reequilibrage des shares**~~ — RESOLU (adversarial F-DA-2) : tableau exact de reequilibrage specifie en section 6.5. Total sans exploration corrige de 1.08 a 1.00.

3. ~~**Strategie de cleanup**~~ — RESOLU (adversarial F-EC-4) : quand le hard limit 15 est atteint, archiver l'entree la moins importante avant insertion. Pas de rejet silencieux.

4. **Graduation de la memoire role globale vers la memoire locale** : la spec couvre la graduation agent_memory → memory (vers le haut). L'inverse (une memoire globale utile pour un role specifique pourrait etre "indexee" localement) est hors scope V1.

5. ~~**Race condition sur la graduation**~~ — RESOLU (adversarial cycle 1 F-EC-1, cycle 2 F-DA-1) : graduation idempotente via SELECT-before-INSERT avec verification `metadata.graduated = true` sur les sources (pas de `ON CONFLICT` — `content_hash` n'existe pas dans `memory`).

6. **`ROLE_TOKEN_BUDGETS` incomplet** (adversarial cycle 2 F-SS-2) : ajouter `planner: 3000` et `explorer: 3000` dans `ROLE_TOKEN_BUDGETS` de `agent-context.ts`. Ces roles sont utilises par les pipelines LIGHT et RESEARCH.
