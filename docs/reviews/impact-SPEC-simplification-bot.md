## Rapport d'impact : Simplification du bot claude-telegram-relay

> Genere le 2026-03-20 a partir de docs/specs/SPEC-simplification-bot.md.

### Niveau de risque : MEDIUM

### Resume

Le changement propose la suppression de 2 modules morts (worktree.ts, dag-executor.ts), la migration de constantes/types/fonctions DAG vers orchestrator.ts, la correction de 6 silent catches, le nettoyage de 10 exports morts dans memory.ts, la suppression du feature flag model_cascade, et l'extraction d'un pipeline commun text/voice dans zz-messages.ts. Le blast radius touche 14 fichiers source/config et 6 fichiers de tests. Le risque principal reside dans le refactoring de zz-messages.ts (extraction processMessageInput) qui est le point d'entree le plus critique du bot pour le traitement des messages.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/worktree.ts` | Direct | Suppression complete — 0 importers dans src/ confirme par Grep |
| `src/dag-executor.ts` | Direct | Suppression apres migration des constantes/types/fonctions DAG |
| `src/orchestrator.ts` | Direct | Reception des types/constantes/fonctions DAG migres + correction de 4 silent catches + nouvel import de semaphore.ts |
| `src/memory.ts` | Direct | Retrait du mot-cle export sur 10 declarations mortes (FactRecord, GoalRecord, IdeaRecord, MemoryArchiveResult, MemoryChainNode, MemoryLink, MemoryRecord, MemorySearchResult, MemoryStats, SimilarMemory) |
| `src/commands/zz-messages.ts` | Direct | Extraction de processMessageInput(), refactoring des handlers text (L201-414) et voice (L417-642) en wrappers legers |
| `src/workflow.ts` | Direct | Correction du silent catch L683 (logWorkflowAudit) |
| `src/conversation-session.ts` | Direct | Correction du silent catch L127 (saveSessions — note : la fonction interne a deja un try/catch avec console.error) |
| `config/features.json` | Direct | Suppression de la cle model_cascade |
| `CLAUDE.md` | Direct | Mise a jour du module count (58 → 56) et suppression des references worktree.ts et dag-executor.ts de la table des modules |
| `README.md` | Indirect | Contient des references a dag-executor.ts et worktree.ts dans le diagramme d'architecture et la liste des fichiers — doit etre mis a jour |
| `config/code-graph.json` | Indirect | Contient les entrees de graphe pour worktree.ts et dag-executor.ts — deviendra incoherent si non mis a jour |
| `src/semaphore.ts` | Aucun | Pas de modification, mais devient une dependance directe de orchestrator.ts (etait indirecte via dag-executor.ts) |
| `src/pipeline-selection.ts` | Aucun | Pas de modification, les re-exports depuis orchestrator.ts sont preserves |
| `tests/unit/readme.test.ts` | Indirect | Verifie que "dag-executor" apparait dans README.md (L180) — ce test cassera apres suppression si README et test ne sont pas mis a jour |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/dag-executor.ts` | DAGNodeStatus, DAGNode, DAGDefinition, DAGExecutionResult, RunAgentFn, OnNodeFailedFn (types) | Suppression du module source | Non (migration vers orchestrator.ts) |
| `src/dag-executor.ts` | DEFAULT_DAG, QUICK_DAG, REVIEW_DAG, SOLO_DAG, LIGHT_DAG, RESEARCH_DAG (constantes) | Suppression du module source | Non (migration vers orchestrator.ts) |
| `src/dag-executor.ts` | getDAG, buildSequentialDAG, executeDag (fonctions) | Suppression du module source | Non (migration vers orchestrator.ts) |
| `src/orchestrator.ts` | (memes types, constantes, fonctions ci-dessus) | Ajout | Oui |
| `src/memory.ts` | FactRecord, GoalRecord, IdeaRecord, MemoryArchiveResult, MemoryChainNode, MemoryLink, MemoryRecord, MemorySearchResult, MemoryStats, SimilarMemory | Retrait du mot-cle export | Oui (0 importers externes confirme) |
| `src/commands/zz-messages.ts` | processMessageInput (nouvelle) | Ajout (fonction interne, non exportee) | Oui |

### Breaking changes potentiels

- [ ] **Import path dag-executor → orchestrator** : les 2 fichiers de tests (adaptive-pipeline.test.ts, tavily-research.test.ts) importent depuis `../../src/dag-executor`. Ces imports casseront a la suppression du module. — **impact** : tests/unit/adaptive-pipeline.test.ts, tests/unit/tavily-research.test.ts
- [ ] **Test readme.test.ts L180** : verifie que `"dag-executor"` apparait dans README.md. Apres suppression du module et mise a jour de README.md, ce test cassera si la chaine n'est plus presente. — **impact** : tests/unit/readme.test.ts
- [ ] **config/code-graph.json** : contient les entrees de noeud et d'arete pour worktree.ts (L34) et dag-executor.ts (L2410, L4553, L4562). Deviendra incoherent avec le filesystem. — **impact** : config/code-graph.json, et potentiellement les tests de code-graph si le graphe est valide par rapport aux fichiers reels.
- [ ] **README.md** : contient les references architecturales a dag-executor.ts (L95, L502) et worktree.ts (L99, L504). Non mentionne dans la spec (section 5 "fichiers concernes" ne liste pas README.md a modifier). — **impact** : README.md

### Points d'attention pour le Reviewer

1. **README.md et readme.test.ts non couverts par la spec** : La section 5 de la spec liste les fichiers concernes mais omet README.md et tests/unit/readme.test.ts. Or, README.md contient des references explicites a dag-executor.ts et worktree.ts (diagramme mermaid L95/L99, section fichiers L502/L504), et le test readme.test.ts L180 verifie la presence de "dag-executor" dans README.md. Ce test cassera apres la suppression si ni le README ni le test ne sont mis a jour. La spec promet "0 regression sur les 2720 tests" (V21), mais ce test n'est pas pris en compte. **Fichiers a verifier** : README.md, tests/unit/readme.test.ts.

2. **config/code-graph.json non couvert par la spec** : Le fichier contient les definitions de noeud pour worktree.ts et dag-executor.ts. Apres suppression des modules, le graphe sera desynchronise. Si des tests ou fonctionnalites valident la coherence du graphe par rapport au filesystem, ils casseront. **Fichier a verifier** : config/code-graph.json.

3. **Risque du refactoring zz-messages.ts** : L'extraction de processMessageInput() touche 440 lignes de code critique (le pipeline complet text + voice). Le text handler (L201-414) et le voice handler (L417-642) ont 5 differences fonctionnelles subtiles (document search, prompt prefix, save message format, response method, document context). Une erreur dans la parametrisation des options pourrait provoquer une regression silencieuse (ex: voice qui inclut le document search, ou text qui utilise sendVoiceResponse). Les V-criteres V16-V19 couvrent les cas principaux mais il faudrait tester les edge cases (PRD workflow interception dans les deux modes, proposal detection, etc.). **Fichiers a verifier** : src/commands/zz-messages.ts, tests/unit/zz-messages-search.test.ts, tests/unit/zz-messages-document.test.ts.

4. **conversation-session.ts L127 : catch redondant** : La fonction saveSessions() a deja un try/catch interne avec console.error (L118-120). Le .catch(() => {}) externe (L127) est un filet de securite contre un throw avant le try (hautement improbable). Ajouter du logging a ce catch est correct mais de faible impact. Le Reviewer doit s'assurer que le message de log est distinct de celui de saveSessions() pour eviter la confusion. **Fichier a verifier** : src/conversation-session.ts.

5. **Taille accrue de orchestrator.ts** : Le fichier est deja consequent (~1237+ lignes d'exports visibles). Ajouter les types DAG (~20 lignes), 6 constantes (~40 lignes), et 3 fonctions dont executeDag (~60 lignes) ajoute ~120 lignes. C'est acceptable, mais orchestrator.ts pourrait beneficier d'un commentaire de section clair pour separer le code DAG du code orchestrateur natif. **Fichier a verifier** : src/orchestrator.ts.

### Blast radius

- Modules directement modifies : 7 (orchestrator.ts, memory.ts, zz-messages.ts, workflow.ts, conversation-session.ts, features.json, CLAUDE.md)
- Modules supprimes : 2 (worktree.ts, dag-executor.ts)
- Modules indirectement impactes : 3 (README.md, config/code-graph.json, tests/unit/readme.test.ts)
- Fichiers source modifies : 9
- Fichiers de test directement modifies : 2 (adaptive-pipeline.test.ts, tavily-research.test.ts)
- Fichiers de test supprimes : 2 (worktree.test.ts = 7 tests, dag-executor.test.ts = 13 tests)
- Fichiers de test indirectement impactes : 1 (readme.test.ts)
- Tests totaux supprimes : 20 (7 + 13)
