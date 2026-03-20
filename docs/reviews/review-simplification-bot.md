## Revue : SPEC-simplification-bot

> Revue de code pour l'implementation de docs/specs/SPEC-simplification-bot.md
> Fichiers en scope : CLAUDE.md, README.md, config/code-graph.json, config/features.json, src/commands/zz-messages.ts, src/dag-executor.ts (supprime), src/memory.ts, src/orchestrator.ts, src/workflow.ts, src/worktree.ts (supprime), tests/unit/adaptive-pipeline.test.ts, tests/unit/dag-executor.test.ts (supprime), tests/unit/readme.test.ts, tests/unit/tavily-research.test.ts, tests/unit/worktree.test.ts (supprime)

### Verification automatisee

| Check | Resultat |
|-------|----------|
| `bun test` | 2689 pass, 1 fail (pre-existant : tts/piper binary) |
| Tests zz-messages | 113 pass, 0 fail |
| Tests adaptive-pipeline | pass |
| Tests tavily-research | pass |
| Tests readme | 16 pass, 0 fail |
| `src/dag-executor.ts` supprime | OK (fichier absent, 0 imports dans src/ et tests/) |
| `src/worktree.ts` supprime | OK (fichier absent, 0 imports dans src/ et tests/) |
| `tests/unit/dag-executor.test.ts` supprime | OK |
| `tests/unit/worktree.test.ts` supprime | OK |
| `model_cascade` absent de features.json | OK |
| `exploration_gate` present dans features.json | OK (false) |
| 10 exports morts retires de memory.ts | OK (aucun export sur FactRecord, GoalRecord, IdeaRecord, MemoryArchiveResult, MemoryChainNode, MemoryLink, MemoryRecord, MemorySearchResult, MemoryStats, SimilarMemory) |
| Silent catches corriges dans workflow.ts | OK (0 `.catch(() => {})` restants) |
| Silent catches corriges dans orchestrator.ts | OK (4 catches avec logging : L697, L746, L796, L1011) |
| conversation-session.ts L127 inchange | OK (`.catch(() => {})` preserve per R7) |
| `processMessageInput` interne a zz-messages.ts | OK (non exporte, dans le scope du Composer factory) |
| Prefixe "zz-" preserve | OK |
| config/code-graph.json nettoye | OK (0 references a worktree.ts ou dag-executor.ts) |
| dag-executor supprime dans adaptive-pipeline.test.ts | OK (0 imports) |
| dag-executor supprime dans tavily-research.test.ts | OK (0 imports) |
| dag-executor supprime dans readme.test.ts | OK |

### Conformite spec (V-criteres)

| V# | Critere | Statut |
|----|---------|--------|
| V1 | worktree.ts supprime, 0 imports | OK |
| V2 | dag-executor.ts supprime, 0 imports src/ et tests/ | OK |
| V3 | N/A — Option A retenue (suppression complete, pas de migration) | OK |
| V4 | N/A — executeDag non migre | OK |
| V5 | N/A — buildSequentialDAG non migre | OK |
| V6 | N/A — executeDag non migre | OK |
| V7 | adaptive-pipeline.test.ts passe | OK |
| V8 | tavily-research.test.ts passe | OK |
| V9 | model_cascade absent de features.json | OK |
| V10 | exploration_gate present (false) | OK |
| V11 | 10 exports morts retires de memory.ts | OK |
| V12 | Types internes toujours utilisables (build OK) | OK |
| V13 | workflow.ts catch corrige avec logging | OK |
| V14 | orchestrator.ts 4 catches corriges avec logging | OK |
| V15 | conversation-session.ts L127 inchange (R7) | OK |
| V16 | Text handler delegue a processMessageInput | OK |
| V17 | Voice handler delegue a processMessageInput | OK |
| V18 | includeDocumentSearch: true (text) / false (voice) | OK |
| V19 | respond: sendResponse (text) / sendVoiceResponse (voice) | OK |
| V20 | Fichier toujours nomme zz-messages.ts | OK |
| V21 | 2689 tests pass (1 fail pre-existant) | OK |
| V22 | N/A (pas de tsconfig, Bun runtime — build verifie via tests) | OK |
| V23 | processMessageInput dans zz-messages.ts uniquement | OK |

### Problemes bloquants

- [README.md:122-126] Le diagramme Mermaid d'architecture contient 3 aretes orphelines referencant des noeuds supprimes : `Orch --> DAG`, `DAG --> Super`, `DAG --> FanOut`. Les noeuds `DAG["dag-executor.ts"]` et `FanOut["fan-out.ts +\nworktree.ts"]` ont ete retires du subgraph "Agent Pipeline" (correct), mais les aretes qui les connectent n'ont pas ete supprimees. Mermaid cree des noeuds implicites, ce qui produit 2 boites flottantes non labellisees ("DAG" et "FanOut") dans le diagramme rendu. Le readme.test.ts ne detecte pas ce probleme car Mermaid ne genere pas d'erreur pour les noeuds implicites.

### Avertissements

- [CLAUDE.md:175] Le module count "56 TypeScript modules" est coherent avec le calcul precedent (58 - 2 = 56), mais il y a 58 fichiers .ts dans src/ actuellement et 71 si on inclut src/commands/. L'ecart preexiste (le chiffre original de "58" etait deja inexact) mais merite une correction eventuelle.

- [CLAUDE.md:56] La description de `code-review.ts` mentionne encore "worktree isolation" alors que `code-review.ts` ne reference plus worktree nulle part dans son code. Ce n'est pas un bug fonctionnel (le module code-review.ts est hors scope), mais la description dans CLAUDE.md (qui est en scope) est devenue caduque suite a la suppression de worktree.ts.

### Suggestions

- [tests/unit/tavily-research.test.ts:5] Le commentaire de module mentionne encore "router/DAG support" alors que les tests DAG ont ete retires. Nettoyage cosmetique du docstring.

- [README.md:95] Le diagramme Mermaid reference encore `Super["supervisor.ts"]` alors que supervisor.ts n'existe pas sur le filesystem. C'est un probleme pre-existant hors scope, mais a corriger a l'occasion puisque README.md est deja modifie.

- [src/commands/zz-messages.ts] L'extraction de `processMessageInput` est bien realisee. Les 5 differences text/voice (R10) sont correctement parametrisees via `MessageInputOptions`. Bonne utilisation du pattern closure pour acceder a `bctx`. Les handlers text et voice sont desormais des wrappers legers et lisibles.

- [src/orchestrator.ts] Les 4 silent catches corriges suivent un pattern coherent avec des messages d'erreur descriptifs et distincts : "emitAgentEvent spawned error", "emitAgentEvent completed/failed error", "emitAgentEvent clarification error", "logCost orchestration error". Bon travail.

### Verification du rapport d'impact

Les 4 breaking changes potentiels identifies dans le rapport d'impact ont tous ete correctement traites :
1. Import path dag-executor dans les tests : sections DAG supprimees (Option A adversariale)
2. readme.test.ts "dag-executor" : assertion retiree
3. config/code-graph.json : noeuds dag-executor et worktree supprimes
4. README.md : references textuelles supprimees dans le file tree et la section "Parallel Execution", MAIS les aretes Mermaid restent (probleme bloquant ci-dessus)

### Score : 88/100

- Implementation solide du refactoring zz-messages.ts (processMessageInput)
- Suppression propre des modules morts (dag-executor, worktree, tests associes)
- Correction coherente des silent catches
- Nettoyage complet des exports morts dans memory.ts
- 2689 tests pass, aucune regression
- Deduction : -8 points pour le diagramme Mermaid casse (aretes orphelines DAG/FanOut dans README.md)
- Deduction : -2 points pour la description CLAUDE.md "worktree isolation" devenue caduque
- Deduction : -2 points pour le module count "56" imprecis dans CLAUDE.md
