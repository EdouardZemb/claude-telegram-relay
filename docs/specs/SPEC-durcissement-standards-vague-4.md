# Spec : Durcissement standards de developpement -- Vague 4

> Genere le 2026-03-23. Source : docs/explorations/EXPLORE-il-faut-ameliorer-les-standards-de.md (section 5 -- vague 4), analyse codebase (src/memory.ts 2174 LOC, src/orchestrator.ts 2019 LOC, 18 fichiers > 500 LOC), contexte des vagues 1-3 implementees.

## 1. Objectif

Refactoriser les deux plus gros modules du codebase (`src/memory.ts` 2174 LOC, `src/orchestrator.ts` 2019 LOC) en sous-modules thematiques, definir des frontieres architecturales explicites entre les couches du systeme (commands -> services -> data), et documenter ces conventions dans un ADR. Cette vague consolide les acquis des vagues 1 (tsconfig strict, config.ts, biome durci), 2 (zero any, 3609 tests) et 3 (Result type, catch audites, validation Zod) en s'attaquant a la dette structurelle : des fichiers monolithiques aux responsabilites trop larges, et l'absence de frontieres architecturales formelles entre les couches.

---

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Refactoriser `src/memory.ts` (2174 LOC) en 6 sous-modules dans `src/memory/` : `core.ts` (interfaces, constantes, processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext, archiveOldMemories), `classification.ts` (classifyMessage, autoRemember, findDuplicateIdea, classifyLinkContent), `scoring.ts` (calculateEffectiveImportance, bumpMemoryAccess, findSimilarFact, resolveMemoryConflict, updateMemoryWithRevision, findContradiction, detectAndLogContradiction), `ideas.ts` (Idea, listIdeas, getIdea, reviewIdea, promoteIdea, archiveIdea, formatIdeasList), `graph.ts` (AGENT_MEMORY_HARD_LIMIT, linkMemories, getLinkedMemories, getLinkedMemoriesBatch, getMemoryChain, clusterMemories, formatClusters, buildMemoryChains, memoryHealthStats, formatMemoryHealth, findSimilarPastTasks, promoteWorkingMemory), `agent-memory.ts` (ROLE_CANONICAL_TAGS, AgentMemoryRecord, resolveAgentMemoryConflict, getAgentMemories, saveAgentMemory, graduateAgentMemory) | Exploration section 5 vague 4, analyse des 13 sections delimitees par `// -- ` dans memory.ts. archiveOldMemories deplace dans core.ts (RPC generique, pas lie aux ideas). AGENT_MEMORY_HARD_LIMIT deplace dans graph.ts (consomme par buildMemoryChains) pour eviter cycle graph <-> agent-memory | `import { processMemoryIntents } from "./memory/core.ts"` via barrel |
| R2 | Refactoriser `src/orchestrator.ts` (2019 LOC) en 4 sous-modules dans `src/orchestrator/` : `types.ts` (AgentRole, AgentStepResult, OrchestratedResult, OrchestrateOptions, AGENT_COMMAND_MAP), `agent-step.ts` (runAgentStep, getOrchestrationInstructions, persistAgentArtifact, _PROJECT_DIR), `pipeline.ts` (orchestrate -- la fonction principale de 1400 LOC, incluant exploration, blackboard, spec-lite, adversarial, conformance, overlap, deliberation, working memory promotion), `format.ts` (formatOrchestrationResult, buildOrchestrationSummary, logOrchestrationResult). Les re-exports de pipeline-selection et deliberation restent dans le barrel `src/orchestrator.ts`, pas dans types.ts | Exploration section 5 vague 4, analyse des 6 sections delimitees par `// -- ` dans orchestrator.ts. Corrige suite au challenge adversarial F-DA-7 (pas de re-export de modules externes dans types.ts) | `import { orchestrate } from "./orchestrator/pipeline.ts"` via barrel |
| R3 | Chaque refactorisation DOIT exposer un barrel `src/memory.ts` et `src/orchestrator.ts` qui re-exporte tout le contenu public des sous-modules. Les imports existants dans le codebase (`from "./memory.ts"`, `from "../memory.ts"`, `from "../../src/memory"`) ne changent PAS. Zero modification dans les fichiers consommateurs | Contrainte non-regression : 3609 tests, 9 fichiers src + 3 commands + 12 tests importent depuis memory.ts, 12 fichiers src + 1 command + 1 mcp + 4 tests importent depuis orchestrator.ts | `// src/memory.ts (barrel) \n export { processMemoryIntents, ... } from "./memory/core.ts"` |
| R4 | Les fichiers barrel originaux (`src/memory.ts`, `src/orchestrator.ts`) deviennent des fichiers de 30-50 lignes maximum contenant uniquement des `export { ... } from "..."` -- aucune logique applicative | Convention barrel (re-export only) | Voir pattern existant : `src/orchestrator.ts` fait deja `export { ... } from "./deliberation.ts"` et `export { ... } from "./pipeline-selection.ts"` |
| R5 | Les sous-modules partagent le meme logger via `createLogger("memory.xxx")` ou `createLogger("orchestrator.xxx")` ou le nom du sous-module. Les constantes privees (DECAY_HALF_LIFE_DAYS, MAX_FACTS_IN_CONTEXT, etc.) restent dans le sous-module qui les utilise | Convention codebase : chaque module cree son propre logger | `const log = createLogger("memory.scoring")` |
| R6 | Les interfaces et types exportes restent a leur place semantique : `MemoryCluster`, `MemoryChain`, `MemoryHealthStats`, `WorkingMemoryData`, `Idea`, `SimilarTask`, `AgentMemoryRecord` dans le sous-module qui les definit et les utilise, re-exportes par le barrel | Analyse des 12 fichiers de test qui importent des types depuis memory.ts | `export type { MemoryHealthStats } from "./memory/graph.ts"` dans le barrel |
| R7 | Les dependances internes entre sous-modules memory sont autorisees mais **sans cycle**. Dependances reelles verifiees dans le code : `core.ts` importe depuis `scoring.ts` (resolveMemoryConflict, updateMemoryWithRevision, bumpMemoryAccess), `classification.ts` (findDuplicateIdea), et `graph.ts` (getLinkedMemoriesBatch). `graph.ts` importe depuis `classification.ts` (classifyLinkContent), `scoring.ts` (bumpMemoryAccess, resolveMemoryConflict), et `agent-memory.ts` (getAgentMemories). Les modules specialises (`scoring.ts`, `ideas.ts`, `agent-memory.ts`) n'importent PAS depuis `core.ts` ni `graph.ts`. Exception : `classification.ts` importe depuis `scoring.ts` (autoRemember appelle resolveMemoryConflict, updateMemoryWithRevision) -- dependance unidirectionnelle classification -> scoring autorisee. `core.ts` et `graph.ts` sont des modules hub qui consomment les modules specialises | Analyse des appels reels dans memory.ts (processMemoryIntents lignes 226-257, getMemoryContext lignes 336-365, buildMemoryChains lignes 1613-1655). Corrige suite au challenge adversarial F-DA-1/F-DA-2 | Interdit : `scoring.ts` importe depuis `core.ts` ou `graph.ts` (cycle) |
| R8 | Les dependances internes entre sous-modules orchestrator sont autorisees (pipeline.ts importe depuis agent-step.ts, format.ts importe depuis types.ts) mais unidirectionnelles : types <- agent-step <- pipeline, types <- format | Analyse des appels : orchestrate() appelle runAgentStep(), formatOrchestrationResult() utilise AgentStepResult | Interdit : `agent-step.ts` importe depuis `pipeline.ts` |
| R9 | Creer un ADR minimal `docs/adr/008-architectural-boundaries.md` documentant la decision de refactoriser les modules > 2000 LOC en sous-modules avec barrels, et les 3 couches architecturales : **commands** (`src/commands/`) -> **services** (`src/*.ts`) -> **data** (Supabase via parametres). L'ADR se limite a la decision et ses consequences -- les conventions operationnelles (seuil LOC, regles barrel) sont documentees dans CLAUDE.md | Analyse codebase : pattern deja respecte a 100%, il manque la documentation. Challenge adversarial F-SS-3 : ADR minimal, conventions dans CLAUDE.md | `docs/adr/008-architectural-boundaries.md` |
| R10 | CLAUDE.md documente la regle barrel : tout module refactorise en sous-repertoire DOIT conserver un barrel au chemin original pour la compatibilite des imports | Decision technique spec. Challenge adversarial F-SS-3 : conventions operationnelles dans CLAUDE.md | Section Conventions de CLAUDE.md |
| R11 | CLAUDE.md documente la regle de taille : les fichiers source > 800 LOC (hors barrel) sont candidats a la refactorisation. Les fichiers actuellement > 800 LOC : agent-schemas.ts (1091), gate-evaluator.ts (937), workflow.ts (848) -- reportes a une vague future | Analyse codebase : 5 fichiers > 800 LOC avant cette vague. Challenge adversarial F-SS-3 : convention dans CLAUDE.md | Section Conventions de CLAUDE.md |
| R12 | Les tests existants (6 fichiers memory + 3 fichiers orchestrator) ne sont PAS modifies -- ils continuent d'importer depuis les barrels `../../src/memory` et `../../src/orchestrator`. Ajouter des tests unitaires pour chaque sous-module isole (imports circulaires, exports manquants) | Non-regression : 3609 tests | `import { calculateEffectiveImportance } from "../../src/memory"` -- inchange |
| R13 | Perimetre des fichiers impactes : `src/memory.ts` (barrel), `src/memory/*.ts` (6 fichiers crees), `src/orchestrator.ts` (barrel), `src/orchestrator/*.ts` (4 fichiers crees), `docs/adr/008-architectural-boundaries.md` (cree), `CLAUDE.md` (mis a jour). Aucune modification dans `src/commands/`, `tests/`, `mcp/`, ou d'autres modules src existants | Contrainte fournie : vague 4 = refactorisation + ADR. Corrige suite au challenge adversarial F-DA-3 | |
| R15 | Les fonctions et types prives (non exportes) sont places dans le sous-module qui les utilise. S'ils sont utilises par plusieurs sous-modules, les placer dans `core.ts` (memory) ou `types.ts` (orchestrator). Exemples : `_MemoryRecord`, `_MemoryLink` dans `core.ts` ; `autoCreateGoals`, `resolveMemoryType` dans `classification.ts` (utilises par autoRemember/classifyMessage) ; `_PROJECT_DIR` dans `agent-step.ts` (utilise par runAgentStep) | Challenge adversarial F-EC-3/F-EC-5/F-EC-6 : les fonctions privees non documentees risquent un mauvais placement | |
| R14 | Le fichier `CLAUDE.md` doit etre mis a jour pour refleter les nouveaux sous-modules dans la table des modules source | Convention codebase : CLAUDE.md documente tous les modules | Ajouter `memory/core.ts`, `memory/classification.ts`, etc. |

---

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `src/memory.ts` (2174 LOC) | Fichier TypeScript monolithique | Read / Split | 13 sections delimitees par `// -- `, ~46 exports publics (a verifier par `grep "^export " src/memory.ts`), 4 imports internes (feature-flags, logger, notification-queue, supabase) |
| `src/orchestrator.ts` (2019 LOC) | Fichier TypeScript monolithique | Read / Split | 6 sections delimitees par `// -- `, 8 exports publics + re-exports deliberation/pipeline-selection, 26 imports |
| 9 fichiers src importent `./memory.ts` | Consommateurs memory | Read-only (inventaire) | bot-context.ts, heartbeat.ts, orchestrator.ts, exploration-scoring.ts, agent-context.ts, llm-router.ts + 3 commands |
| 12 fichiers src + 1 mcp importent `./orchestrator.ts` | Consommateurs orchestrator | Read-only (inventaire) | mcp-config.ts, agent-schemas.ts, pipeline-selection.ts, prd-workflow.ts, llm-router.ts, auto-pipeline.ts, deliberation.ts, feedback-loop.ts, agent-context.ts, pipeline-state.ts, commands/execution.ts, mcp/memory-server.ts |
| 12 fichiers tests importent `../../src/memory` | Tests memory | Read-only (non-regression) | memory.test.ts, memory-importance.test.ts, memory-links.test.ts, memory-chains.test.ts, memory-evolution.test.ts, memory-cmds.test.ts + integration + generated |
| 4 fichiers tests importent `../../src/orchestrator` | Tests orchestrator | Read-only (non-regression) | orchestrator.test.ts, orchestrator-deliberation.test.ts, adaptive-pipeline.test.ts, tavily-research.test.ts |
| `docs/adr/template.md` | Template ADR | Read (reference) | Format : Date, Status, Context, Decision, Consequences |

---

## 4. Donnees de sortie

### 4.1 Sous-modules memory (`src/memory/`)

| Fichier | Contenu | LOC estimee |
|---------|---------|:-----------:|
| `src/memory/core.ts` | Interfaces (MemoryRecord, MemorySearchResult, FactRecord, GoalRecord, MemoryStats), constantes (DECAY_HALF_LIFE_DAYS, MAX_FACTS/GOALS_IN_CONTEXT), fonctions privees partagees (_MemoryRecord, _MemoryLink, autoCreateGoals, resolveMemoryType), processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext, archiveOldMemories | ~400 |
| `src/memory/classification.ts` | ThoughtClassification, classifyMessage, autoRemember, findDuplicateIdea, classifyLinkContent | ~300 |
| `src/memory/scoring.ts` | calculateEffectiveImportance, bumpMemoryAccess, findSimilarFact, ConflictResolution, resolveMemoryConflict, updateMemoryWithRevision, findContradiction, detectAndLogContradiction, PROMOTION_MAX_CHARS, constantes de seuils (DUPLICATE_THRESHOLD, CONTRADICTION_THRESHOLD, COMPLEMENT_THRESHOLD, ACTIONABILITY_THRESHOLD) | ~350 |
| `src/memory/ideas.ts` | Idea, listIdeas, getIdea, reviewIdea, promoteIdea, archiveIdea, formatIdeasList | ~180 |
| `src/memory/graph.ts` | AGENT_MEMORY_HARD_LIMIT, MemoryCluster, MemoryChain, LinkedMemory, MemoryHealthStats, SimilarTask, WorkingMemoryData, linkMemories, getLinkedMemories, getLinkedMemoriesBatch, getMemoryChain, clusterMemories, formatClusters, buildMemoryChains, memoryHealthStats, formatMemoryHealth, findSimilarPastTasks, promoteWorkingMemory | ~720 |
| `src/memory/agent-memory.ts` | ROLE_CANONICAL_TAGS, AgentMemoryRecord, resolveAgentMemoryConflict, getAgentMemories, saveAgentMemory, graduateAgentMemory, normalizeContent | ~250 |
| `src/memory.ts` (barrel) | Re-exports de tous les exports publics des 6 sous-modules | ~45 |

### 4.2 Sous-modules orchestrator (`src/orchestrator/`)

| Fichier | Contenu | LOC estimee |
|---------|---------|:-----------:|
| `src/orchestrator/types.ts` | AgentRole, AgentStepResult, OrchestratedResult, OrchestrateOptions, AGENT_COMMAND_MAP | ~100 |
| `src/orchestrator/agent-step.ts` | runAgentStep, getOrchestrationInstructions, persistAgentArtifact | ~230 |
| `src/orchestrator/pipeline.ts` | orchestrate (la fonction principale incluant toute la logique de pipeline) | ~750 |
| `src/orchestrator/format.ts` | formatOrchestrationResult, buildOrchestrationSummary, logOrchestrationResult | ~120 |
| `src/orchestrator.ts` (barrel) | Re-exports de tous les exports publics des 4 sous-modules | ~35 |

### 4.3 ADR

- `docs/adr/008-architectural-boundaries.md` : ADR minimal -- decision de refactorisation modules > 2000 LOC, frontieres commands -> services -> data. Conventions operationnelles (barrel, seuil 800 LOC) dans CLAUDE.md

### 4.4 CLAUDE.md

- Mise a jour table des modules : remplacement de `memory.ts` par 6 sous-modules + barrel, `orchestrator.ts` par 4 sous-modules + barrel

---

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/memory.ts` | Modifier (transformer en barrel) | Remplacer le contenu monolithique (2174 LOC) par des re-exports depuis `src/memory/` |
| `src/memory/core.ts` | Creer | Interfaces, constantes, fonctions centrales (processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext) |
| `src/memory/classification.ts` | Creer | Classification des messages, auto-remember, detection duplicats, classification liens |
| `src/memory/scoring.ts` | Creer | Importance scoring, decay, conflict resolution, contradiction detection |
| `src/memory/ideas.ts` | Creer | CRUD ideas, formatage, archivage memoires |
| `src/memory/graph.ts` | Creer | Linking, chains, clustering, health stats, similar tasks, working memory promotion, buildMemoryChains |
| `src/memory/agent-memory.ts` | Creer | Memoire role-specifique agents BMad |
| `src/orchestrator.ts` | Modifier (transformer en barrel) | Remplacer le contenu monolithique (2019 LOC) par des re-exports depuis `src/orchestrator/` |
| `src/orchestrator/types.ts` | Creer | Types, interfaces, constantes de l'orchestrateur |
| `src/orchestrator/agent-step.ts` | Creer | Execution d'un agent individuel avec retry |
| `src/orchestrator/pipeline.ts` | Creer | Fonction orchestrate() principale |
| `src/orchestrator/format.ts` | Creer | Formatage des resultats pour Telegram et logs |
| `docs/adr/008-architectural-boundaries.md` | Creer | ADR documentant les frontieres architecturales |
| `CLAUDE.md` | Modifier | Mise a jour table des modules source |

---

## 6. Patterns existants

### 6.1 Re-exports barrel (pattern deja en place dans orchestrator.ts)

Le fichier `src/orchestrator.ts` fait deja des re-exports depuis d'autres modules :

```typescript
// src/orchestrator.ts lignes 117-132
export { getDeliberationReviewer, runDeliberation, shouldDeliberate } from "./deliberation.ts";
export {
  classifyAdaptivePipeline,
  classifyPipeline,
  DEFAULT_PIPELINE,
  LIGHT_PIPELINE,
  type PipelineType,
  QUICK_PIPELINE,
  RESEARCH_PIPELINE,
  REVIEW_PIPELINE,
  SOLO_PIPELINE,
  selectAdaptivePipeline,
  selectPipeline,
};
```

Ce pattern sera generalise pour les barrels complets.

### 6.2 Sections delimitees dans memory.ts

Le fichier `src/memory.ts` est deja organise en 13 sections clairement delimitees par des commentaires `// -- Nom Section --` (lignes 32, 130, 618, 654, 734, 887, 994, 1051, 1241, 1331, 1422, 1543, 1674, 1823, 1893). Le decoupage en sous-modules suit exactement ces frontieres existantes -- pas de refactorisation de logique, uniquement un deplacement de code.

### 6.3 Logger par module (pattern universel)

Chaque module du codebase cree son propre logger :

```typescript
// src/memory.ts ligne 30
const log = createLogger("memory");

// src/orchestrator.ts ligne 26
const log = createLogger("orchestrator");
```

Les sous-modules suivront le meme pattern : `createLogger("memory.scoring")`.

### 6.4 ADR existants (7 ADR dans docs/adr/)

Les ADR suivent le template `docs/adr/template.md` : Date, Status, Context, Decision, Consequences. Le prochain numero est 008.

### 6.5 Conventions d'import Supabase (pattern service)

Tous les services recoivent `supabase: SupabaseClient | null` en parametre, jamais en variable globale. Ce pattern est deja respecte a 100% et sera documente dans l'ADR :

```typescript
// src/memory.ts ligne 316 — pattern typique
export async function getMemoryContext(supabase: SupabaseClient | null): Promise<string> {
```

---

## 7. Contraintes

- **Non-regression imports** : les 21 fichiers (9 src + 3 commands + 1 mcp + 12 tests) qui importent depuis `memory.ts` ou `orchestrator.ts` ne doivent PAS etre modifies. Les barrels assurent la compatibilite transparente
- **Non-regression tests** : les 3609 tests existants doivent passer sans modification. Aucun changement fonctionnel n'est introduit -- uniquement du deplacement de code
- **Pas de cycle de dependances** : les sous-modules doivent respecter un ordre de dependance strict (R7, R8). Un import circulaire entre sous-modules serait un bug de refactorisation
- **Bun runtime** : verifier que Bun resout correctement les imports vers les sous-repertoires (`./memory/core.ts`) avec l'extension `.ts` explicite (convention codebase existante)
- **Pipeline maturation** : la refactorisation de `orchestrator.ts` touche la logique critique du pipeline multi-agents. La fonction `orchestrate()` de ~1400 LOC reste dans un seul fichier (`pipeline.ts`) pour eviter de fragmenter une sequence logique complexe
- **MCP server** : `mcp/memory-server.ts` importe depuis `../src/orchestrator.ts` -- le barrel doit fonctionner aussi avec ce chemin relatif
- **Scope strict** : uniquement memory.ts, orchestrator.ts, ADR et CLAUDE.md. Pas de refactorisation des 3 autres fichiers > 800 LOC (agent-schemas.ts, gate-evaluator.ts, workflow.ts) qui sont reportes a une vague future
- **CI existante** : la CI (typecheck, tests, doc freshness) doit passer sans modification de configuration

---

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `src/memory.ts` est un barrel de ~45 LOC contenant uniquement des `export { ... } from "./memory/..."` | Lire le fichier et verifier : pas de logique, pas de const, pas de function, uniquement export/re-export. `wc -l src/memory.ts` < 60 | unit |
| V2 | `src/orchestrator.ts` est un barrel de ~35 LOC contenant uniquement des `export { ... } from "./orchestrator/..."` | Lire le fichier et verifier : pas de logique, uniquement export/re-export. `wc -l src/orchestrator.ts` < 50 | unit |
| V3 | Tous les exports publics actuels de memory.ts sont re-exportes par le barrel sans exception | Capturer les symboles exportes avant refactorisation (`grep "^export " src/memory.ts`), puis verifier que le barrel re-exporte exactement les memes symboles. Diff des symboles : 0 manquant, 0 en trop | unit |
| V4 | Tous les exports publics actuels de orchestrator.ts sont re-exportes par le barrel sans exception | Capturer les symboles exportes avant refactorisation, puis verifier que le barrel re-exporte exactement les memes symboles | unit |
| V5 | Aucun fichier src/, commands/, tests/, mcp/ n'est modifie dans ses imports (sauf memory.ts et orchestrator.ts eux-memes) | `git diff --name-only` ne contient que `src/memory.ts`, `src/orchestrator.ts`, les nouveaux fichiers `src/memory/*.ts`, `src/orchestrator/*.ts`, `docs/adr/008-*.md`, `CLAUDE.md` | integration |
| V6 | Les 3609 tests passent sans modification | `bun test` : 0 failed, count >= 3609 | integration |
| V7 | Le typecheck passe | `bun run typecheck` : 0 errors | integration |
| V8 | Aucun cycle de dependance entre sous-modules memory | Verifier que les modules specialises (`classification.ts`, `scoring.ts`, `ideas.ts`, `agent-memory.ts`) n'importent PAS depuis `core.ts` ni `graph.ts`. `core.ts` et `graph.ts` sont des hubs qui importent depuis les modules specialises (sens unique). `grep "from.*./core" src/memory/scoring.ts src/memory/classification.ts src/memory/ideas.ts src/memory/agent-memory.ts` doit retourner vide. `grep "from.*./graph" src/memory/scoring.ts src/memory/classification.ts src/memory/ideas.ts src/memory/agent-memory.ts` doit retourner vide | unit |
| V9 | Aucun cycle de dependance entre sous-modules orchestrator | `grep "from.*./orchestrator/" src/orchestrator/` : types.ts n'importe aucun sous-module local, agent-step.ts n'importe pas pipeline.ts | unit |
| V10 | Chaque sous-module a son propre `createLogger` | `grep "createLogger" src/memory/*.ts src/orchestrator/*.ts` : chaque fichier (sauf types) a exactement un appel createLogger | unit |
| V11 | L'ADR `docs/adr/008-architectural-boundaries.md` existe et documente la decision de refactorisation + les 3 couches architecturales. ADR minimal (decision + consequences), conventions operationnelles dans CLAUDE.md | Lire le fichier : sections Context, Decision, Consequences presentes. Verifier que CLAUDE.md contient les conventions barrel et seuil 800 LOC | manual |
| V12 | CLAUDE.md est mis a jour avec les nouveaux sous-modules dans la table | `grep "memory/core" CLAUDE.md` retourne un resultat | manual |
| V13 | Aucun sous-module ne depasse 800 LOC (R11) | `wc -l src/memory/*.ts src/orchestrator/*.ts` : chaque fichier < 800 | unit |
| V14 | Les 6 sous-modules memory existent dans `src/memory/` | `ls src/memory/` : core.ts, classification.ts, scoring.ts, ideas.ts, graph.ts, agent-memory.ts | unit |
| V15 | Les 4 sous-modules orchestrator existent dans `src/orchestrator/` | `ls src/orchestrator/` : types.ts, agent-step.ts, pipeline.ts, format.ts | unit |
| V16 | Les imports relatifs entre sous-modules utilisent l'extension `.ts` explicite | `grep "from " src/memory/*.ts` : tous les imports locaux terminent par `.ts` | unit |
| V17 | Le MCP server continue de fonctionner : `import { orchestrate } from "../src/orchestrator.ts"` resout correctement via le barrel | `bun run --dry-run mcp/memory-server.ts` ne genere pas d'erreur d'import | integration |

---

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Les fichiers monolithiques de 2000+ LOC sont clairement identifies, les frontieres manquantes documentees dans l'exploration |
| Perimetre | Couvert | Scope strict : 2 refactorisations + 1 ADR + 1 CLAUDE.md. Les 3 autres fichiers > 800 LOC sont explicitement exclus (R11) |
| Validation | Couvert | 17 V-criteres couvrant la non-regression (V3-V6), l'absence de cycles (V8-V9), la structure (V1-V2, V13-V15) et la documentation (V11-V12) |
| Technique | Couvert | Le decoupage suit les sections existantes dans les fichiers. Le pattern barrel est deja utilise dans le codebase. Les dependances internes sont analysees et documentees (R7-R8) |
| UX | Non applicable | Refactorisation interne sans impact sur les commandes Telegram ou l'experience utilisateur |
| Alternatives | Pertinent | Trois alternatives evaluees dans l'exploration : (A) status quo rejete car la dette structurelle s'aggrave, (C) refonte big-bang rejetee car trop risquee, (D) framework Standards-as-Code rejete car sur-ingenierie. L'option B (incremental) retenue, cette vague en est la derniere etape |

**Zones d'ombre residuelles** :
1. **graph.ts a ~700 LOC** : c'est le plus gros sous-module, proche du seuil de 800 LOC. Si la refactorisation revele des possibilites de decoupage supplementaire (par exemple separer health-stats et similar-tasks), ce sera a la discretion de l'implementeur tant que le barrel reste stable
2. **pipeline.ts a ~750 LOC** : la fonction `orchestrate()` est un flux sequentiel complexe avec de nombreuses branches conditionnelles. La fragmenter davantage risquerait de rendre le flux plus difficile a suivre. Accepte comme compromis tant que le seuil de 800 LOC est respecte
3. **Performances d'import Bun** : le passage de 1 fichier a 6 (memory) ou 4 (orchestrator) pourrait theoriquement impacter le temps de demarrage. Impact attendu negligeable (Bun resout les imports en <1ms par fichier). A verifier en post-implementation
