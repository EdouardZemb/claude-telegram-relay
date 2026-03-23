## Rapport d'impact : Durcissement standards de developpement -- Vague 4

> Genere le 2026-03-23 a partir de docs/specs/SPEC-durcissement-standards-vague-4.md.

### Niveau de risque : MEDIUM

### Resume

La refactorisation de deux fichiers monolithiques (memory.ts 2174 LOC, orchestrator.ts 2019 LOC) en sous-modules thematiques impacte directement 2 fichiers source et indirectement 30+ consommateurs (9 src + 3 commands + 1 MCP + 12 tests pour memory, 12 src + 1 command + 1 MCP + 4 tests pour orchestrator). Le risque est attenue par le pattern barrel qui preserve les chemins d'import existants, mais une dependance circulaire existante entre `deliberation.ts` et `orchestrator.ts` et une ambiguite de resolution de module Bun (fichier vs repertoire) constituent les deux principales zones de risque.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/memory.ts` | Direct | Transforme en barrel (~45 LOC) -- tout le contenu deplace dans `src/memory/` |
| `src/orchestrator.ts` | Direct | Transforme en barrel (~35 LOC) -- tout le contenu deplace dans `src/orchestrator/` |
| `src/memory/core.ts` | Direct | Nouveau fichier -- interfaces, constantes, processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext (~350 LOC) |
| `src/memory/classification.ts` | Direct | Nouveau fichier -- classifyMessage, autoRemember, findDuplicateIdea, classifyLinkContent (~300 LOC) |
| `src/memory/scoring.ts` | Direct | Nouveau fichier -- calculateEffectiveImportance, bumpMemoryAccess, conflict resolution (~350 LOC) |
| `src/memory/ideas.ts` | Direct | Nouveau fichier -- CRUD ideas, archiveOldMemories (~200 LOC) |
| `src/memory/graph.ts` | Direct | Nouveau fichier -- linking, chains, clustering, health stats (~700 LOC) |
| `src/memory/agent-memory.ts` | Direct | Nouveau fichier -- ROLE_CANONICAL_TAGS, memoire role-specifique (~280 LOC) |
| `src/orchestrator/types.ts` | Direct | Nouveau fichier -- AgentRole, AgentStepResult, OrchestratedResult, OrchestrateOptions, AGENT_COMMAND_MAP (~120 LOC) |
| `src/orchestrator/agent-step.ts` | Direct | Nouveau fichier -- runAgentStep, getOrchestrationInstructions, persistAgentArtifact (~230 LOC) |
| `src/orchestrator/pipeline.ts` | Direct | Nouveau fichier -- orchestrate() principale (~750 LOC) |
| `src/orchestrator/format.ts` | Direct | Nouveau fichier -- formatOrchestrationResult, buildOrchestrationSummary (~120 LOC) |
| `docs/adr/008-architectural-boundaries.md` | Direct | Nouveau fichier -- ADR frontieres architecturales |
| `CLAUDE.md` | Direct | Mise a jour table des modules source |
| `src/bot-context.ts` | Indirect | Importe `getIdea` depuis `./memory.ts` -- depend du barrel |
| `src/heartbeat.ts` | Indirect | Importe `archiveOldMemories` depuis `./memory.ts` -- depend du barrel |
| `src/agent-context.ts` | Indirect | Importe depuis `./memory.ts` et `./orchestrator.ts` (AgentRole, buildMemoryChains, findSimilarPastTasks) -- depend des deux barrels |
| `src/exploration-scoring.ts` | Indirect | Importe `findSimilarPastTasks` depuis `./memory.ts` -- depend du barrel |
| `src/llm-router.ts` | Indirect | Importe depuis `./memory.ts` (findSimilarPastTasks, SimilarTask) et `./orchestrator.ts` (AgentRole) -- depend des deux barrels |
| `src/deliberation.ts` | Indirect | Importe `AgentRole` (type) et `runAgentStep` (function) depuis `./orchestrator.ts` -- depend du barrel, **dependance circulaire existante** |
| `src/pipeline-selection.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/auto-pipeline.ts` | Indirect | Importe `AgentRole, classifyPipeline, orchestrate, selectPipeline` depuis `./orchestrator.ts` -- depend du barrel |
| `src/prd-workflow.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/feedback-loop.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/pipeline-state.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/mcp-config.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/agent-schemas.ts` | Indirect | Importe `AgentRole` type depuis `./orchestrator.ts` -- depend du barrel |
| `src/commands/memory-cmds.ts` | Indirect | Importe 8+ fonctions depuis `../memory.ts` -- depend du barrel |
| `src/commands/utilities.ts` | Indirect | Importe `archiveIdea, getIdea, promoteIdea` depuis `../memory.ts` -- depend du barrel |
| `src/commands/zz-messages.ts` | Indirect | Importe depuis `../memory.ts` -- depend du barrel |
| `src/commands/execution.ts` | Indirect | Importe depuis `../orchestrator.ts` -- depend du barrel |
| `mcp/memory-server.ts` | Indirect | Importe `formatOrchestrationResult, orchestrate` depuis `../src/orchestrator.ts` -- depend du barrel, **chemin relatif cross-directory** |
| 6 fichiers tests memory | Indirect | Importent depuis `../../src/memory` (sans extension .ts) -- depend du barrel + resolution module Bun |
| 4 fichiers tests orchestrator | Indirect | Importent depuis `../../src/orchestrator` (sans extension .ts) -- depend du barrel + resolution module Bun |
| 2 fichiers tests integration | Indirect | Importent depuis `../../src/memory` -- depend du barrel |
| 1 fichier test system | Indirect | Importe depuis `../../src/memory` -- depend du barrel |
| 1 fichier test generated | Indirect | Importe depuis `../../src/memory.ts` (avec extension) -- depend du barrel |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/memory.ts` | 49 exports (fonctions, types, interfaces, constantes) | Deplacement vers sous-modules, re-export via barrel | Oui (si barrel correct) |
| `src/orchestrator.ts` | 8 exports directs + re-exports deliberation + re-exports pipeline-selection | Deplacement vers sous-modules, re-export via barrel | Oui (si barrel correct) |

Aucune signature de fonction, type, ou interface n'est modifie. C'est un deplacement de code pur, sans changement fonctionnel.

### Breaking changes potentiels

- [ ] **Resolution de module Bun : fichier vs repertoire** -- Lorsque `src/memory.ts` (fichier) coexiste avec `src/memory/` (repertoire), Bun doit choisir lequel resoudre pour `import from "../../src/memory"` (sans extension). Avec `moduleResolution: "bundler"` dans tsconfig.json, le fichier `.ts` a priorite sur le repertoire, mais cela merite un test explicite. **impact** : 12 fichiers de tests memory + 4 fichiers de tests orchestrator + 2 tests integration + 1 test system
- [ ] **Dependance circulaire orchestrator <-> deliberation** -- `deliberation.ts` importe `AgentRole` (type) et `runAgentStep` (fonction) depuis `./orchestrator.ts`. Apres refactorisation, `orchestrator.ts` barrel re-exporte depuis `deliberation.ts` ET les sous-modules `orchestrator/agent-step.ts` et `orchestrator/types.ts` contiennent les definitions importees par `deliberation.ts`. Si `deliberation.ts` continue d'importer depuis le barrel `./orchestrator.ts`, le cycle est : `orchestrator.ts` (barrel) -> `deliberation.ts` -> `orchestrator.ts` (barrel). Bun gere les cycles au runtime mais cela peut causer des `undefined` si l'ordre d'initialisation est mauvais. **impact** : `src/deliberation.ts`, `src/orchestrator.ts` barrel, `src/orchestrator/agent-step.ts`
- [ ] **Dependance circulaire orchestrator <-> pipeline-selection** -- `pipeline-selection.ts` importe `AgentRole` type depuis `./orchestrator.ts`, et `orchestrator.ts` re-exporte depuis `pipeline-selection.ts`. Meme pattern cyclique, mais attenue car l'import est `type`-only (efface au runtime). **impact** : `src/pipeline-selection.ts`, `src/orchestrator.ts` barrel
- [ ] **graph.ts proche du seuil 800 LOC** -- Le sous-module `src/memory/graph.ts` est estime a ~700 LOC, proche de la limite de 800 LOC fixee par R11. Si le code reel depasse apres extraction (commentaires, imports supplementaires), un decoupage supplementaire sera necessaire. **impact** : `src/memory/graph.ts`
- [ ] **pipeline.ts proche du seuil 800 LOC** -- Le sous-module `src/orchestrator/pipeline.ts` est estime a ~750 LOC. Meme risque que graph.ts. **impact** : `src/orchestrator/pipeline.ts`

### Points d'attention pour le Reviewer

1. **Dependance circulaire deliberation.ts <-> orchestrator.ts** : C'est le risque principal. Actuellement `deliberation.ts` importe `runAgentStep` (valeur) depuis `orchestrator.ts` et `orchestrator.ts` re-exporte depuis `deliberation.ts`. Apres refactorisation, il faut verifier que le barrel ne cause pas de `undefined` au runtime a cause de l'ordre de resolution des modules. **Recommandation** : envisager de faire importer `deliberation.ts` directement depuis `./orchestrator/agent-step.ts` et `./orchestrator/types.ts` au lieu du barrel, pour casser le cycle. Cela impliquerait cependant de modifier `deliberation.ts` (hors scope R13). Verifier fichiers : `src/deliberation.ts`, `src/orchestrator.ts`, `src/orchestrator/agent-step.ts`.

2. **Resolution module Bun fichier+repertoire** : Verifier experimentalement que `import from "../../src/memory"` (sans extension .ts) resout bien vers `src/memory.ts` (le barrel) et non vers `src/memory/index.ts` (inexistant) quand les deux coexistent. Le tsconfig utilise `moduleResolution: "bundler"` et `allowImportingTsExtensions: true`, ce qui suggere que le fichier .ts est prioritaire, mais un test de non-regression est indispensable. Verifier : lancer `bun test` sans modification des tests.

3. **Exhaustivite du barrel memory.ts** : Le barrel doit re-exporter exactement 49 symboles publics (fonctions, types, interfaces, constantes). Tout oubli casserait un consommateur. Compter les exports avant et apres avec `grep "^export " src/memory.ts | wc -l`. Verifier aussi les types non-prefixes `export type` et les `export interface` qui sont parfois oublies dans les re-exports.

4. **AGENT_COMMAND_MAP est une constante privee (`const`, pas `export`)** : La spec place `AGENT_COMMAND_MAP` dans `orchestrator/types.ts` mais dans le code actuel c'est une `const` non exportee (pas de `export` prefix). Verifier que la refactorisation ne l'exporte pas accidentellement ou ne casse pas son utilisation interne dans `agent-step.ts`.

5. **MCP server chemin cross-directory** : `mcp/memory-server.ts` importe avec `../src/orchestrator.ts` (extension explicite). Ce chemin doit resoudre vers le barrel apres refactorisation. Comme le tsconfig `exclude` le repertoire `mcp/`, ce module est resolu uniquement par Bun au runtime -- verifier manuellement.

6. **Dependances internes memory : graph.ts -> classification.ts et scoring.ts** : Le graphe de dependance interne specifie dans R7 (core <- classification <- scoring <- ideas, core <- graph <- agent-memory) est unidirectionnel. Verifier qu'aucun import inverse n'est introduit, notamment : `promoteWorkingMemory` (graph.ts) appelle `resolveMemoryConflict` (scoring.ts) et `buildMemoryChains` (graph.ts) appelle `classifyLinkContent` (classification.ts) et `getAgentMemories` (agent-memory.ts). Cela implique que graph.ts depend de scoring.ts, classification.ts ET agent-memory.ts. L'ordre R7 indique `core <- graph <- agent-memory` mais graph.ts importe aussi depuis scoring.ts et classification.ts -- le graphe reel est un DAG, pas une chaine lineaire. L'implementeur doit s'assurer que c'est bien un DAG sans cycle.

7. **Test generated avec extension .ts** : Le fichier `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` importe depuis `../../src/memory.ts` (avec extension explicite). C'est la seule exception parmi les tests -- les autres importent sans extension. Ce fichier n'est pas encore committe (fichier untracked dans git status).

### Blast radius

- Modules directement modifies : 2 (memory.ts, orchestrator.ts) + 10 nouveaux fichiers + 1 ADR + 1 CLAUDE.md = 14 fichiers touches
- Modules indirectement impactes : 30+ (9 src + 3 commands + 1 MCP pour memory ; 12 src + 1 command + 1 MCP pour orchestrator ; dont certains importent les deux)
- Fichiers source modifies : 14 (2 transformes + 10 crees + 1 ADR + 1 CLAUDE.md)
- Fichiers de test a verifier : 13 (6 memory unit + 1 memory-cmds + 2 memory integration + 1 memory system + 1 memory generated + 2 orchestrator unit + 1 adaptive-pipeline + 1 tavily-research -- certains testent les deux modules)
