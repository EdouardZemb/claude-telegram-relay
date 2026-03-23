# Spec : Sante du systeme de memoire permanente et promotion working memory

> Genere le 2026-03-23. Source : exploration EXPLORE-sante-systeme-memoire-permanente-multi.md, codebase analysis.

## 1. Objectif

Activer la promotion des decouvertes et decisions de la working memory (blackboard) vers la memoire permanente en fin de pipeline multi-agent, et ajouter des metriques quantitatives de sante du systeme memoire. Aujourd'hui, `promoteWorkingMemory()` est implemente et teste mais jamais appele : les agents perdent leurs decouvertes entre pipelines. Les metriques de sante (dedup, embeddings, age, distribution par type) n'existent pas, empechant tout pilotage de la qualite memoire.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | En fin de pipeline (succes ou echec), l'orchestrateur lit la section `working_memory` du blackboard et appelle `promoteWorkingMemory()` si le feature flag `memory_promotion` est actif | Exploration section 5 (option B) + codebase (orchestrator.ts L1710-1783) | Pipeline DEFAULT termine -> decisions architect + discoveries qa promues en facts |
| R2 | Seules les `decisions` et `discoveries` sont promues ; `blockers` et `context_updates` sont ignores | Code existant `promoteWorkingMemory()` (memory.ts L908-919) + tests unitaires existants | Un blocker "API down" n'est pas persiste en memoire permanente |
| R3 | Chaque item promu passe par `resolveMemoryConflict()` : skip si duplicat (>0.85), update si contradiction (>0.80), merge si complement (>0.75), insert sinon | Code existant (memory.ts L796-830, L922-948) | Decision "Use REST" deja connue -> skip (pas de doublon) |
| R4 | Les items promus ont `metadata.source = "working_memory_promotion"` et `metadata.pipeline_session_id` | Code existant (memory.ts L942-947) | Permet de tracer l'origine des faits promus |
| R5 | Le nombre d'items promus est logue et reporte via `onProgress` | Exploration section 6 (input) | "Working memory: 3 items promus en memoire permanente" |
| R6 | La fonction `memoryHealthStats()` retourne des metriques quantitatives : total par type, ratio embeddings, age moyen, score importance moyen, top acces, promotions recentes | Exploration section 3 (observation #3) + section 6 (input) | `/brain health` affiche "127 facts, 12 goals, 85% embeddings, age moyen 14j" |
| R7 | Les metriques sont calculees a la volee (pas de persistance en base) pour la V1 | Decision architecturale : simplicite, pas de nouveau schema | Appel direct aux RPCs et queries existantes |
| R8 | Le feature flag `memory_promotion` est cree avec valeur `false` par defaut | Exploration section 6 (contraintes : feature flag obligatoire pour rollback) | Activation manuelle via `/feature enable memory_promotion` |
| R9 | La promotion est executee dans un try/catch isole : un echec ne doit jamais bloquer le retour du pipeline | Contrainte fiabilite + pattern existant dans orchestrator.ts | Erreur Supabase -> log.error + continue normalement |
| R10 | `auto-pipeline.ts` passe `useBlackboard: true` a `orchestrate()` pour la Phase 3 (analyse). Les decisions analyst/pm/architect sont promues. Limitation V1 : la Phase 4 (dev via `executeTask()`) n'utilise pas le blackboard | Challenge adversarial F-DA-1 + cycle 2 : auto-pipeline n'utilisait pas le blackboard. executeTask hors scope V1 | `/autopipeline` Phase 3 -> decisions architect promues. Phase 4 dev -> pas de promotion |
| R11 | Les items promus sont tronques a 500 caracteres maximum avant insertion en memoire | Challenge adversarial F-EC-2 : decisions longues polluent le budget token | Decision de 2000 chars tronquee a 500 chars |
| R12 | `/brain health` est dispatch par match exact du mot "health" apres `/brain`. Tout autre texte est envoye au LLM existant (fallback) | Challenge adversarial F-EC-7 : collision sous-commande / texte libre | `/brain health` -> metriques, `/brain healthy tips` -> LLM |
| R13 | `memoryHealthStats()` retourne 0 pour avgImportanceScore et avgAgeDays quand total=0 (pas de division par zero) | Challenge adversarial F-EC-3 : table memory vide | Projet neuf -> toutes metriques a 0, pas de NaN |
| R14 | `recentPromotions` ne compte que les inserts (metadata.source = "working_memory_promotion"), pas les updates/merges. Limitation V1 documentee | Challenge adversarial F-EC-6 : updates/merges ne changent pas metadata.source | Compteur sous-estime legerement la realite |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| Blackboard `working_memory` section | WorkingMemory (JSONB) | `readSection(supabase, sessionId, "working_memory")` ou `bbFallback.read(sessionId, "working_memory")` | `decisions[]`, `discoveries[]` |
| Table `memory` | PostgreSQL | Supabase client, RPCs `get_facts`, `get_active_goals` | `type`, `content`, `importance_score`, `access_count`, `created_at`, `embedding`, `metadata` |
| Table `memory_links` | PostgreSQL | Supabase client | `source_id`, `target_id`, `link_type`, `similarity` |
| Table `memory_archive` | PostgreSQL | Supabase client | `archived_at`, `type` |
| Feature flags | JSON file | `isFeatureEnabled("memory_promotion")` | Flag boolean |

## 4. Donnees de sortie

### 4.1 Promotion (effet de bord)

Nouveaux enregistrements dans la table `memory` avec :
- `type`: "fact"
- `content`: texte de la decision ou decouverte
- `metadata`: `{ source: "working_memory_promotion", pipeline_session_id: string, agent: string }`

Regle de remplissage : R2, R3, R4.

### 4.2 Metriques de sante memoire

Structure retournee par `memoryHealthStats()` :

```typescript
interface MemoryHealthStats {
  total: number;                        // nombre total de memoires actives
  byType: Record<string, number>;       // ventilation par type (fact, goal, idea, preference, completed_goal)
  embeddingCoverage: number;            // ratio 0-1 des memoires avec embedding non-null
  avgImportanceScore: number;           // score d'importance moyen
  avgAgeDays: number;                   // age moyen en jours
  recentPromotions: number;             // items inseres via working_memory dans les 7 derniers jours (inserts uniquement, pas les updates/merges -- limitation V1)
  linksCount: number;                   // nombre total de liens semantiques
  archiveCount: number;                 // nombre de memoires archivees
  topAccessed: Array<{                  // top 5 memoires les plus accedees
    content: string;
    accessCount: number;
  }>;
}
```

Exemple attendu :
```
SANTE MEMOIRE
Total: 142 memoires actives
  fact: 98 | goal: 12 | idea: 23 | preference: 9
Embeddings: 131/142 (92%)
Importance moyenne: 47.3
Age moyen: 18.2 jours
Liens semantiques: 87
Archive: 34
Promotions recentes (7j): 5
Top acces: "Bun runtime..." (14x), "Supabase schema..." (11x)
```

Regle de remplissage : R6, R7.

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/orchestrator.ts` | modifier | Ajouter appel `promoteWorkingMemory()` en fin de pipeline (apres traceability, avant cleanup) |
| `src/auto-pipeline.ts` | modifier | Ajouter `useBlackboard: true` a l'appel `orchestrate()` (R10) |
| `src/memory.ts` | modifier | Ajouter fonction `memoryHealthStats()` et `formatMemoryHealth()`, troncature 500 chars (R11), guard division par zero (R13) |
| `src/commands/memory-cmds.ts` | modifier | Ajouter sous-commande `/brain health` avec dispatch exact match (R12) |
| `config/features.json` | modifier | Ajouter flag `memory_promotion: false` |
| `tests/unit/memory-evolution.test.ts` | modifier | Ajouter tests pour `memoryHealthStats()`, `formatMemoryHealth()`, table vide, troncature |
| `tests/unit/orchestrator.test.ts` | modifier | Ajouter test verifiant que `promoteWorkingMemory` est appele en fin de pipeline quand le flag est actif |
| `tests/unit/auto-pipeline.test.ts` | modifier | Ajouter test verifiant que `orchestrate()` est appele avec `useBlackboard: true` |

## 6. Patterns existants

### Pattern 1 : Feature flag guard dans l'orchestrateur

L'orchestrateur utilise deja `isFeatureEnabled()` pour conditionner des comportements. Exemple dans `src/orchestrator.ts` :

```typescript
import { isFeatureEnabled } from "./feature-flags.ts";
```

Le pattern est : `if (isFeatureEnabled("flag_name")) { ... }`. Le fichier `config/features.json` contient les flags avec valeurs booleennes.

### Pattern 2 : Lecture working_memory du blackboard

Le code lit deja la working_memory dans l'orchestrateur (L916-920) pour la detection de conflits inter-agents :

```typescript
const wm = supabase && !bbFallback
  ? ((await readSection(supabase, bbSessionId, "working_memory")) as WorkingMemory | null)
  : (bbFallback?.read(bbSessionId, "working_memory") as WorkingMemory | null);
```

Ce meme pattern peut etre reutilise pour lire la working memory en fin de pipeline.

### Pattern 3 : promoteWorkingMemory() deja implemente

`src/memory.ts` L897-956 : la fonction existe, est typee (`WorkingMemoryData`), gere les cas null, itere sur decisions/discoveries, passe par `resolveMemoryConflict()`, et retourne un compteur. 9 tests unitaires couvrent les cas nominaux, edge cases, duplicats.

### Pattern 4 : Metriques calculees a la volee dans /brain

`src/commands/memory-cmds.ts` L46-154 : la commande `/brain` execute deja plusieurs queries en parallele (`get_facts`, `get_active_goals`, count par type, signal/noise ratio, clusters) et passe le tout a un LLM pour synthese. La sous-commande `/brain health` peut reutiliser ce pattern de batch queries.

### Pattern 5 : Post-pipeline hooks dans l'orchestrateur

Zone L1710-1783 de `src/orchestrator.ts` : apres la boucle agent, le code execute sequentiellement : pipeline status update, adversarial verifier, traceability, blackboard status update, puis cleanup. La promotion s'insere naturellement juste avant le cleanup (L1779).

## 7. Contraintes

- **Ne pas casser le pipeline** : la promotion est un post-hook non-bloquant. Un echec ne doit jamais empecher le retour de `orchestrate()`. Pattern : try/catch + log.error.
- **Pas de nouveau schema SQL** : les metriques sont calculees via queries sur les tables existantes (`memory`, `memory_links`, `memory_archive`). Pas de migration.
- **Respect du budget token** : les faits promus passent par `resolveMemoryConflict()` qui deduplique. Le MAX_FACTS_IN_CONTEXT (20) existant dans `getMemoryContext()` limite naturellement l'impact sur le contexte agent.
- **Compatibilite InMemoryBlackboard** : si le pipeline utilise le fallback in-memory (`bbFallback`), la working memory doit etre lue via `bbFallback.read()` et non via Supabase.
- **Performance /brain health** : les queries doivent etre executees en parallele (Promise.all) pour eviter la latence sequentielle. Budget cible : < 2s.
- **1680 lignes dans memory.ts** : ajouter `memoryHealthStats()` et `formatMemoryHealth()` (environ 80 lignes) est acceptable. Un refactoring plus profond est hors scope (option C de l'exploration).

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `promoteWorkingMemory()` est appele en fin de pipeline quand le flag `memory_promotion` est actif et que le blackboard a une section `working_memory` non-null | Test unitaire : mock orchestrate() fin de pipeline, verifier appel | unit |
| V2 | La promotion n'est PAS appelee quand le flag `memory_promotion` est inactif | Test unitaire : mock avec flag off, verifier que promoteWorkingMemory n'est pas appele | unit |
| V3 | La promotion n'est PAS appelee quand le pipeline n'utilise pas de blackboard (`options.useBlackboard` false) | Test unitaire : mock sans blackboard, verifier absence d'appel | unit |
| V4 | Un echec de `promoteWorkingMemory()` (ex: erreur Supabase) ne bloque pas le retour de `orchestrate()` | Test unitaire : mock promoteWorkingMemory qui throw, verifier que orchestrate() retourne normalement | unit |
| V5 | Le compteur de promotions est reporte via `onProgress` | Test unitaire : mock onProgress, verifier message "Working memory: N items promus" | unit |
| V6 | `memoryHealthStats()` retourne le total de memoires par type | Test unitaire : mock Supabase avec donnees connues, verifier byType | unit |
| V7 | `memoryHealthStats()` calcule le ratio d'embedding coverage | Test unitaire : N memoires dont M avec embedding, verifier ratio M/N | unit |
| V8 | `memoryHealthStats()` retourne le nombre de promotions recentes (7 jours, source = working_memory_promotion) | Test unitaire : memoires avec metadata.source filtrees par date | unit |
| V9 | `memoryHealthStats()` retourne 0/valeurs par defaut si Supabase est null | Test unitaire : appel avec null, verifier retour par defaut | unit |
| V10 | `formatMemoryHealth()` produit un texte lisible en plain text (pas de markdown) | Test unitaire : stats connues -> verifier format texte | unit |
| V11 | `/brain health` repond avec les metriques formatees | Test integration : mock bot context, commande /brain health, verifier reponse | integration |
| V12 | Le flag `memory_promotion` existe dans `config/features.json` avec valeur `false` | Test unitaire : lire le fichier, verifier la presence du flag | unit |
| V13 | La promotion fonctionne avec le fallback InMemoryBlackboard | Test unitaire : creer InMemoryBlackboard, ecrire working_memory, verifier lecture et promotion | unit |
| V14 | `memoryHealthStats()` calcule le score d'importance moyen et l'age moyen en jours | Test unitaire : donnees connues avec dates et scores, verifier calculs | unit |
| V15 | `auto-pipeline.ts` appelle `orchestrate()` avec `useBlackboard: true` | Test unitaire : mock orchestrate, verifier que useBlackboard est true dans les options | unit |
| V16 | `memoryHealthStats()` retourne 0 pour avgImportanceScore et avgAgeDays quand la table memory est vide (total=0) | Test unitaire : mock Supabase retournant 0 rows, verifier pas de NaN | unit |
| V17 | Les items promus sont tronques a 500 caracteres avant insertion | Test unitaire : decision de 1000 chars, verifier contenu insere <= 500 chars | unit |
| V18 | `/brain health` dispatch uniquement sur match exact "health", tout autre texte va au LLM | Test integration : "/brain health" -> metriques, "/brain healthy" -> LLM | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Le gap est clairement identifie : promoteWorkingMemory() est du code mort. Les metriques manquent pour piloter la qualite memoire. Source : exploration section 1 et 3. |
| Perimetre | Couvert | Option B de l'exploration : activer promotion + metriques. Pas de refactoring de memory.ts ni d'isolation agent-scoped (option C, hors scope V1). |
| Validation | Couvert | 18 V-criteres avec niveaux explicites (16 unit, 2 integration). La base de tests existante (9 tests promoteWorkingMemory, 223 tests memory total) assure une bonne couverture initiale. |
| Technique | Couvert | Tous les fichiers identifies existent. Les patterns de code sont cites avec numeros de ligne. L'insertion dans l'orchestrateur est a un point precis (L1779, avant cleanup). |
| UX | Pertinent | La sous-commande `/brain health` est l'interface utilisateur. Format plain text conforme aux conventions Telegram du projet. |
| Alternatives | Pertinent | Option A (status quo), B (choisie), C (refactoring complet) evaluees dans l'exploration section 4. B est le prerequis logique de C. |

**Zones d'ombre residuelles** :

1. **Seuil d'importance minimum pour la promotion** : actuellement `promoteWorkingMemory()` promeut tout ce qui passe le conflit resolution (>= insert). Si les agents produisent beaucoup de decisions triviales, la memoire pourrait etre polluee. Mitigation V1 : le feature flag permet de couper. A revoir si les metriques montrent du bruit excessif.

2. **Metriques persistees vs a la volee** : la V1 calcule a la volee (R7). Si le besoin de trends historiques emerge (ex: graph d'evolution du total memoires par sprint), il faudra persister dans `sprint_metrics`. Hors scope V1.

3. **auto-pipeline.ts** : le module `auto-pipeline.ts` appelle `orchestrate()` SANS `useBlackboard: true` pour la Phase 3 (analyse). Cette spec inclut l'ajout de `useBlackboard: true` a cet appel (R10) pour capturer les decisions analyst/pm/architect. Limitation V1 : la Phase 4 (dev agent via `executeTask()`) n'utilise pas le blackboard et ses decisions ne sont pas promues. Etendre `executeTask()` au blackboard est un chantier separe.
