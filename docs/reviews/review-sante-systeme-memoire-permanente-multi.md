## Revue : SPEC-sante-systeme-memoire-permanente-multi

> Generee le 2026-03-23. Reviewer agent. Scope : 10 fichiers modifies par le pipeline.

---

### Problemes bloquants

Aucun.

---

### Avertissements

- **[src/memory.ts:1660-1697]** Les 6 queries Supabase dans `memoryHealthStats()` ne verifient pas le champ `error` des reponses. Supabase retourne `{ data: null, error: ... }` en cas d'echec (ex: table inexistante, timeout reseau) sans lever d'exception. Le code utilise `allMemories.data || []` ce qui masque silencieusement les erreurs. La convention du projet impose la destructuration `{ error }` avec `log.error`. Recommandation : verifier au moins `allMemories.error` et `linksResult.error` (les deux tables les moins couramment accedees : `memory_links`, `memory_archive`), puis logger si erreur.

- **[src/memory.ts:1669-1671]** La query `allMemories` recupere TOUTES les lignes de la table `memory` (colonnes `type, importance_score, created_at, access_count`) sans limite. Sur un projet avec des centaines de memoires c'est acceptable, mais si la table grandit au-dela de quelques milliers de lignes, cette query deviendra couteuse en memoire cote client (toutes les lignes chargees dans le runtime). La spec mentionne un budget < 2s. Pour la V1 c'est acceptable, a surveiller via les metriques de sante elles-memes.

- **[src/memory.ts:1675-1676]** La query `withEmbedding` recupere tous les `id` des memoires avec embedding non-null pour compter. Il serait plus efficace d'utiliser `{ count: "exact", head: true }` pour obtenir seulement le count sans transferer les rows. Meme remarque pour `linksResult` (L1678-1680) et `archiveResult` (L1682-1684). Cela reduirait la bande passante et la consommation memoire.

- **[tests/unit/orchestrator.test.ts:456-578]** Les tests V1-V5 et V13 sont des verifications structurelles (regex sur le source code) et non des tests comportementaux. Ils verifient que le pattern de code existe dans le fichier source mais ne testent pas l'execution reelle. C'est un compromis raisonnable pour eviter les mocks lourds de `orchestrate()`, mais le risque est qu'un refactoring syntaxique casse les tests sans changer le comportement. Documenter ce choix dans un commentaire serait utile.

---

### Suggestions

- **[src/memory.ts:1675-1684]** Remplacer les queries de comptage par `select("id", { count: "exact", head: true })` pour `withEmbedding`, `linksResult`, `archiveResult`, et `recentPromotionsResult`. Cela retourne seulement le count sans transferer les lignes. Exemple :
  ```
  supabase.from("memory_links").select("id", { count: "exact", head: true })
  ```
  Puis lire `result.count` au lieu de `result.data?.length`.

- **[src/orchestrator.ts:1788]** Le cast implicite de `WorkingMemory` (blackboard.ts, arrays required) vers `WorkingMemoryData` (memory.ts, arrays optional) fonctionne car les types required sont assignables aux optional. Toutefois, documenter cette compatibilite avec un commentaire inline serait utile pour les futurs mainteneurs. Le rapport d'impact mentionne ce point comme zone de vigilance (#1).

- **[src/commands/memory-cmds.ts:46-57]** Le bloc `/brain health` est propre et bien isole avec early return. Suggestion mineure : ajouter un commentaire mentionnant la regle R12 pour la tracabilite spec-implementation.

- **[tests/unit/memory-cmds.test.ts]** Les tests V11 et V18 sont structurels (regex sur le source). Ajouter un test comportemental avec un mock de `BotContext` qui execute reellement le handler `/brain` avec match="health" et verifie la reponse serait un bon complement futur (hors scope V1).

- **[tests/unit/auto-pipeline.test.ts:193-203]** Le test V15 verifie par regex que `useBlackboard: true` est present dans le code source. C'est fragile mais acceptable en V1. Un test integration qui invoque `runAutoPipeline` avec des mocks verifierait le comportement reel.

- **[config/features.json]** Le flag `memory_promotion` est correctement positionne a `false`. RAS.

---

### Conformite aux regles de la spec

| Regle | Statut | Commentaire |
|-------|--------|-------------|
| R1 | OK | `promoteWorkingMemory()` appele en fin de pipeline, conditionne par flag et bbSessionId |
| R2 | OK | Seules `decisions` et `discoveries` sont traitees dans `promoteWorkingMemory()` |
| R3 | OK | `resolveMemoryConflict()` appele avec seuils corrects (code pre-existant, non modifie) |
| R4 | OK | Metadata `source: "working_memory_promotion"` et `pipeline_session_id` presents |
| R5 | OK | `onProgress` appele avec le count quand > 0 |
| R6 | OK | `memoryHealthStats()` retourne toutes les metriques specifiees |
| R7 | OK | Calcul a la volee, pas de persistance |
| R8 | OK | Flag `memory_promotion: false` dans `config/features.json` |
| R9 | OK | try/catch isole, log.error, pas de re-throw |
| R10 | OK | `useBlackboard: true` ajoute a l'appel `orchestrate()` dans auto-pipeline.ts L218 |
| R11 | OK | Troncature a 500 chars via `PROMOTION_MAX_CHARS`, flag `truncated` en metadata |
| R12 | OK | Dispatch exact match `brainInput === "health"` avec early return |
| R13 | OK | Guard `if (total === 0) return empty` empeche toute division par zero |
| R14 | OK | `recentPromotions` ne compte que les inserts (filtre `metadata->>source`) |

### Conformite aux V-criteres

| V-critere | Test | Statut |
|-----------|------|--------|
| V1 | orchestrator.test.ts L466 | OK (structurel) |
| V2 | orchestrator.test.ts L486 | OK (structurel) |
| V3 | orchestrator.test.ts L504 | OK (structurel) |
| V4 | orchestrator.test.ts L523 | OK (structurel) |
| V5 | orchestrator.test.ts L546 | OK (structurel) |
| V6 | memory-evolution.test.ts L778 | OK |
| V7 | memory-evolution.test.ts L796 | OK |
| V8 | memory-evolution.test.ts L827 | OK |
| V9 | memory-evolution.test.ts L751 | OK |
| V10 | memory-evolution.test.ts L886 | OK |
| V11 | memory-cmds.test.ts L19 | OK (structurel) |
| V12 | memory-evolution.test.ts L968 + orchestrator.test.ts L444 | OK |
| V13 | orchestrator.test.ts L563 | OK (structurel) |
| V14 | memory-evolution.test.ts L811 | OK |
| V15 | auto-pipeline.test.ts L193 | OK (structurel) |
| V16 | memory-evolution.test.ts L766 | OK |
| V17 | memory-evolution.test.ts L670 | OK |
| V18 | memory-cmds.test.ts L40 | OK (structurel) |

### Verification rapport d'impact

| Point d'attention | Verdict |
|-------------------|---------|
| #1 WorkingMemory vs WorkingMemoryData type compat | OK — types required assignables aux optional. Pas de risque runtime. |
| #2 Query directe memory_links | OK — la query fonctionne via `from("memory_links").select("id")`. RLS policy "Allow all" existe. |
| #3 Parsing sous-commande /brain | OK — exact match avec early return, le fallback LLM est preserve. |
| #4 Query memory_archive | OK — table existe dans schema.sql, query directe valide. |
| #5 Performance Promise.all | OK — 6 queries parallelisees. Avertissement emis sur le volume potentiel. |
| #6 Isolation try/catch | OK — le try/catch englobe lecture WM + appel promoteWorkingMemory + onProgress. |

### Tests

- **128 tests pass, 0 fail** (fichiers testes : memory-evolution, orchestrator, auto-pipeline, memory-cmds)
- Couverture des cas nominaux, erreurs et limites : bonne
- Mocks Supabase utilises correctement (pas d'appels reels)
- Tests structurels (regex sur source) : compromis documente, acceptable en V1

### Backward compatibility

Aucun breaking change detecte. Toutes les modifications sont additives :
- Nouveaux exports dans memory.ts (ajout pur)
- Comportement additionnel dans orchestrate() conditionne par feature flag off par defaut
- Sous-commande `/brain health` avec fallback preserve pour `/brain` sans argument

---

### Score : 88/100

Implementation solide et conforme a la spec. Les 18 V-criteres sont couverts. Les avertissements portent sur l'absence de verification des erreurs Supabase dans `memoryHealthStats()` et sur le potentiel de performance pour les grosses tables — deux points non bloquants pour la V1 mais a adresser en iteration suivante. Les tests structurels sont un compromis acceptable mais fragile a moyen terme.
