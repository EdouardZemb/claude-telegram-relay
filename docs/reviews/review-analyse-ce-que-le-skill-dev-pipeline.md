## Revue : SPEC-analyse-ce-que-le-skill-dev-pipeline

> Date: 2026-03-21. Fichiers modifies : 14 (6 modifies + 2 crees + 4 tests + CLAUDE.md + config/features.json).

### Checklist

- [x] TypeScript compile sans erreur (bun runtime, pas de tsconfig projet -- verification via `bun test`)
- [x] Imports coherents (pas de circulaire, pas d'inutilises)
- [x] Pas de secrets ou credentials dans le code
- [x] Types explicites sur les signatures publiques (sauf `any` justifies, voir W2)
- [x] Coherence avec les patterns existants du codebase
- [x] Pas de duplication injustifiee de logique existante (sauf W1)
- [x] Conventions de nommage respectees
- [x] Dependances correctes dans les fichiers de configuration
- [x] Backward compatibility : API publiques non cassees (tous les changements sont des ajouts)
- [x] Coherence cross-modules : imports, interfaces respectees
- [x] Rapport d'impact verifie : conclusions correctes (blast radius MEDIUM confirme)
- [x] Tests existent pour le nouveau code (74 tests sur les 4 fichiers, tous pass)
- [x] Pas d'appels reels Supabase en unit test
- [x] Cas nominaux, d'erreur et limites couverts dans les tests
- [x] Type `AgentRole` non modifie (contrainte spec section 7 respectee)
- [x] Feature flags desactives par defaut (regression zero R12 respectee)
- [x] Flags existants inchanges (V15 verifie par test)

### Problemes bloquants

Aucun.

### Avertissements

- **[W1] src/auto-pipeline.ts:189-199 — Duplication de la logique P1 avec orchestrator.ts:681-729.** La proto-spec est generee dans `auto-pipeline.ts` (Phase 2b) mais aussi dans `orchestrator.ts` (P1). Dans auto-pipeline, le `protoSpec` genere est un `const` local qui n'est pas transmis a `orchestrate()` a la ligne 212 : ni via les options, ni via le blackboard. L'orchestrateur va regenerer une deuxieme proto-spec si le flag est actif. Cela cause un double appel a `generateProtoSpec` (double cout, double latence ~60s). La spec (section 5, fichier `src/auto-pipeline.ts`) indique "passer proto-spec au contexte d'orchestration" mais cela n'est pas fait dans l'implementation actuelle.

- **[W2] src/adversarial-verifier.ts:186 — `devOutput: any` dans la signature publique de `checkConformance`.** Le parametre `devOutput` est type `any` sur une fonction publique. Le pattern du codebase tolere `any` dans les fonctions de normalisation internes (comme `normalizeProtoSpec(obj: any)`) mais les signatures publiques preferent des types explicites. Ici, `devOutput` devrait idealement etre type `StructuredAgentOutput | Record<string, unknown>` ou au minimum `unknown`. Le meme pattern (`any`) existe deja dans `verifySpecVsImplementation(spec: any, implementation: any)` donc c'est coherent avec l'existant, mais cela reste une dette technique.

- **[W3] src/orchestrator.ts:686-691 — Detection du type de pipeline par comparaison de reference d'objet.** La variable `pipelineTypeForFlags` est determinee en comparant `pipeline` avec les constantes exportees (`RESEARCH_PIPELINE`, `SOLO_PIPELINE`, etc.) par identite de reference (`===`). Si un pipeline custom est passe avec le meme contenu que `DEFAULT_PIPELINE` (ex: `["analyst", "pm", "architect", "dev", "qa"]`), il sera classifie comme `"DEFAULT"` par le fallback, ce qui est correct par accident. Mais si un pipeline custom comme `["pm", "dev", "qa"]` est passe, il sera aussi classifie `"DEFAULT"`, ce qui activerait incorrectement P1/P2/P3 sur un pipeline qui n'est pas DEFAULT. Ce scenario est peu probable en pratique (les pipelines custom passent via le parametre `pipeline` de `OrchestrateOptions`), mais le garde n'est pas robuste.

- **[W4] src/orchestrator.ts:1259 — Condition de P3 verifie `nextAg === "qa" || currentIdx === pipeline.length - 1`.** Si le pipeline ne contient pas de qa (ex: un pipeline custom `["dev"]`), P3 s'execute quand meme apres dev car `currentIdx === pipeline.length - 1` est vrai. La spec (R9) dit "P3 s'execute apres le dev agent et avant QA, uniquement si P1 a produit des V-criteres." L'intent est que P3 s'execute avant QA ou en dernier recours apres dev. La condition actuelle est acceptable mais la spec ne couvre pas explicitement le cas d'un pipeline sans qa.

- **[W5] src/commands/execution.ts:32 — Fuite memoire potentielle sur `challengeResolvers`.** La map `challengeResolvers` stocke des callbacks de resume pour le challenge adversarial. Le cleanup est assure par (a) le callback handler qui supprime l'entree, ou (b) le timeout de 10 minutes. Si ni le callback ni le timeout ne se declenchent (ex: le bot redemarre pendant les 10 minutes), les entrees orphelines restent en memoire. En pratique, le timeout `setTimeout` garantit le cleanup en 10 minutes maximum, donc l'impact est minime. Mais le `setTimeout` ne survit pas a un redemarrage PM2, laissant le pipeline bloque sans cleanup.

### Suggestions

- **[S1] src/auto-pipeline.ts:189-199 — Supprimer la duplication P1.** Trois options : (a) supprimer la Phase 2b de auto-pipeline et laisser l'orchestrateur gerer P1 seul (recommande -- c'est deja fait dans orchestrate()), (b) passer la proto-spec generee via une option supplementaire a `orchestrate()`, (c) documenter explicitement que P1 est execute deux fois quand `runAutoPipeline` est utilise avec le flag actif. L'option (a) est la plus simple et elimine la duplication.

- **[S2] src/adversarial-challenge.ts:92-93 — Utiliser `claude-sonnet-4-5-20250514` au lieu de `claude-sonnet-4-20250514`.** Le modele specifie dans le prompt pour le Devil's Advocate est `claude-sonnet-4-20250514`. Verifier que c'est le bon identifiant modele pour le Sonnet en production. Si le codebase utilise des noms de modeles differents, aligner.

- **[S3] src/orchestrator.ts:121-124 — Imports statiques vs dynamiques.** Les imports `spec-lite.ts` et `adversarial-challenge.ts` sont statiques dans l'orchestrateur (lignes 121-122) mais dynamiques dans auto-pipeline (ligne 193: `await import("./spec-lite.ts")`). Cette inconsistance n'a pas d'impact fonctionnel mais pourrait causer de la confusion. Uniformiser : soit tout statique, soit tout dynamique.

- **[S4] tests/unit/adversarial-challenge.test.ts:161-175 — Tests E1 manquants.** Le fichier de test reconnait explicitement (lignes 161-164) que `runImpactAnalysis` ne peut pas etre teste en unit parce qu'il depend de `getGraph()` et `spawnClaude`. Des tests avec mocks permettraient de couvrir les 3 chemins (zero-LLM, agent spawn, fallback). Cela ameliorerait la couverture des V19-V21 qui sont actuellement verifies "par le code" uniquement.

- **[S5] src/spec-lite.ts:13-18 — Interface `StoryFileInput` dupliquee.** L'interface `StoryFileInput` dans `spec-lite.ts` est un sous-ensemble de l'interface retournee par `buildStoryFile()` dans `story-files.ts`. Importer le type depuis `story-files.ts` eviterait la duplication. Si les types divergent, le compilateur ne signalera pas l'incoherence.

- **[S6] config/features.json — Flag `spec_gate` manquant.** La spec (section 5, R22, V14) prevoit 3 flags: `spec_phase_lite`, `adversarial_challenge`, `spec_gate`. L'implementation n'en ajoute que 2, car E2 est differe a V2 selon la recommandation adversariale (F-SS-1). Cette decision est documentee dans `implement-analyse-ce-que-le-skill-dev-pipeline.md` mais V14 de la spec n'est pas formellement satisfait. Pas un probleme bloquant (decision deliberee et documentee), mais noter que la spec et l'implementation divergent sur ce point.

### Verification du rapport d'impact

Le rapport d'impact identifiait correctement :

1. **Complexite de `orchestrate()` apres modification** -- Confirme. La fonction etait deja ~900 lignes, les 4 blocs conditionnels (P1: ~50 lignes, P2+E1: ~120 lignes, P3: ~50 lignes) l'amenent a ~1120 lignes de corps. Les conditions de guard sont correctes et mutuellement exclusives. Les fonctions sont extraites dans des modules dedies (`spec-lite.ts`, `adversarial-challenge.ts`), ce qui limite la complexite ajoutee dans `orchestrate()`.

2. **Coherence du blackboard version** -- Confirme. Le `bbVersion` est correctement incremente uniquement quand un step ecrit (res.success check), et reste intact quand un step conditionnel est saute.

3. **Type AgentRole preserve** -- Confirme. Aucun ajout au type union. Les nouveaux steps sont des fonctions standalone.

4. **Comportement E2 timeout + resume** -- Non applicable (E2 differe a V2). Le mecanisme equivalent pour P2 (challenge adversarial pause) est correctement implemente avec callback + timeout 10min.

5. **Tests existants** -- Confirme. Les 74 tests passes couvrent les nouveaux chemins. Les tests existants ne sont pas casses (flags off par defaut).

6. **Flags dans config/features.json** -- Confirme partiel. 2 flags ajoutes au lieu de 3 (E2 differe). Les valeurs existantes sont inchangees.

### Score : 82/100

Justification : Implementation solide avec bonne adherence aux patterns du codebase. Tests complets pour les parsers et les edge cases. Architecture propre avec separation des responsabilites (modules dedies). Points de deduction : duplication P1 auto-pipeline/orchestrateur (W1, -6), couverture tests E1 limitee (S4, -4), `any` sur signature publique (W2, -3), robustesse du pipeline type guard (W3, -3), divergence spec/implementation sur V14 non formellement reconciliee (S6, -2).
