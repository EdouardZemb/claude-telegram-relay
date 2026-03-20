# Spec : Simplification du bot claude-telegram-relay

> Genere le 2026-03-20. Source : exploration EXPLORE-simplification-du-bot-claude-telegram.md, discovery interview, analyse codebase.

## 1. Objectif

Reduire la dette technique du bot en supprimant le code mort (modules, exports, feature flags), en corrigeant les silent catches problematiques, et en eliminant la duplication massive entre les handlers text et voice de zz-messages.ts via l'extraction d'un pipeline commun. Le codebase doit rester fonctionnellement identique avec 0 regression sur les 2720 tests.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Supprimer worktree.ts et dag-executor.ts : 0 importers depuis src/ | Exploration S3 #1, #2 | `src/worktree.ts` (195L), `src/dag-executor.ts` (277L) — zero imports production |
| R2 | Supprimer dag-executor.ts ENTIEREMENT (constantes DAG, executeDag, types inclus) : aucune de ces fonctions n'est appelee en production. Les tests qui importent dag-executor doivent etre adaptes pour ne plus en dependre | Challenge adversarial C-1 | executeDag() = 0 callers en src/, les constantes DAG ne sont utilisees que dans les tests |
| R3 | Supprimer les tests associes aux modules morts : worktree.test.ts, dag-executor.test.ts. Adapter adaptive-pipeline.test.ts et tavily-research.test.ts pour retirer les imports dag-executor (supprimer les tests qui en dependent ou definir les constantes localement dans le test) | Challenge adversarial C-1 | Tests de modules qui n'existent plus |
| R4 | Supprimer uniquement le feature flag `model_cascade` de config/features.json. Conserver `exploration_gate` | Discovery Q4 | `model_cascade: false` — aucune reference dans src/ |
| R5 | Supprimer de memory.ts les exports jamais importes nulle part (ni src/ ni tests/) : FactRecord, GoalRecord, IdeaRecord, MemoryArchiveResult, MemoryChainNode, MemoryLink, MemoryRecord, MemorySearchResult, MemoryStats, SimilarMemory | Discovery Q1 | `export interface FactRecord` → `interface FactRecord` (retirer le mot-cle export) |
| R6 | Remplacer les `.catch(() => {})` problematiques par `.catch((err) => console.error("context:", err))` dans workflow.ts (L683), orchestrator.ts (L697, L746, L796, L1011). NE PAS modifier conversation-session.ts L127 (double-fault protection acceptable per R7) | Challenge adversarial C-3 | Erreurs Supabase masquees silencieusement |
| R7 | Conserver les `.catch(() => {})` sur : unlink de fichiers temporaires, bumpMemoryAccess, autoRemember, ctx.reply en catch d'erreur (double-fault protection) | Exploration S3 #6 | Ces patterns sont des fire-and-forget acceptables |
| R8 | Extraire une fonction `processMessageInput()` dans zz-messages.ts pour factoriser le pipeline commun text/voice : session init, constraint extraction, clarification check, PRD revision check, proposal confirmation, intent detection (regex + LLM), PRD workflow interception, conversation fallback | Discovery Q2 | Pipeline place en haut de zz-messages.ts, pas de nouveau fichier |
| R9 | Le text handler et voice handler deviennent des wrappers legers qui preparent l'input puis delegent au pipeline commun | Exploration S4 | Text : `text = ctx.message.text`, Voice : transcription prealable |
| R10 | Preserver les differences fonctionnelles entre text et voice : (a) voice inclut la transcription prealable, (b) voice utilise `sendVoiceResponse` au lieu de `sendResponse`, (c) text inclut le document search auto, voice non, (d) le prefixe de prompt differe (`[Voice message transcribed]:`), (e) le format saveMessage differe (text: `"user", text` / voice: `"user", "[Voice Xs]: transcription"`) | Challenge adversarial C-2 | Options passees au pipeline commun, incluant le saveMessage format |
| R11 | Le prefixe "zz-" de zz-messages.ts doit etre preserve : le loader.ts trie alphabetiquement et ce prefixe garantit le chargement en dernier (apres tous les command handlers) | Exploration S3 contraintes | `files.sort()` dans loader.ts |
| R12 | Les handlers photo et document restent inchanges (pas de duplication significative entre eux) | Exploration S6 | Photo = 128L, Document = 138L, logiques differentes |
| R13 | Mettre a jour README.md, readme.test.ts et config/code-graph.json apres suppression des modules morts | Impact analysis | readme.test.ts verifie la presence de "dag-executor" dans README.md ; code-graph.json reference worktree.ts et dag-executor.ts |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `src/worktree.ts` | Module TypeScript | Filesystem | Module entier (suppression) |
| `src/dag-executor.ts` | Module TypeScript | Filesystem | Constantes DAG, types, fonctions getDAG/buildSequentialDAG/executeDag |
| `src/memory.ts` | Module TypeScript | Filesystem | Declarations export des 10 interfaces/types morts |
| `src/commands/zz-messages.ts` | Composer module | Filesystem | Handlers text (L201-414) et voice (L417-642) |
| `src/workflow.ts` | Module TypeScript | Filesystem | L683 : `.catch(() => {})` |
| `src/orchestrator.ts` | Module TypeScript | Filesystem | L697, L746, L796, L1011 : `.catch(() => {})` ; re-exports pipeline constants |
| `src/conversation-session.ts` | Module TypeScript | Filesystem | L127 : `.catch(() => {})` |
| `config/features.json` | JSON config | Filesystem | Cle `model_cascade` |
| `tests/unit/worktree.test.ts` | Test file | Filesystem | Module entier (suppression) |
| `tests/unit/dag-executor.test.ts` | Test file | Filesystem | Module entier (suppression) |
| `tests/unit/adaptive-pipeline.test.ts` | Test file | Filesystem | Imports depuis dag-executor (a rediriger) |
| `tests/unit/tavily-research.test.ts` | Test file | Filesystem | Imports depuis dag-executor (a rediriger) |

## 4. Donnees de sortie

### 4.1 Modules supprimes

- `src/worktree.ts` — supprime (195 lignes)
- `src/dag-executor.ts` — supprime (277 lignes) apres migration des constantes DAG vers orchestrator.ts
- `tests/unit/worktree.test.ts` — supprime (79 lignes)
- `tests/unit/dag-executor.test.ts` — supprime (189 lignes)

### 4.2 Constantes et types migres

Les elements suivants sont deplaces de `dag-executor.ts` vers `orchestrator.ts` :
- Types : `DAGNodeStatus`, `DAGNode`, `DAGDefinition`, `DAGExecutionResult`, `RunAgentFn`, `OnNodeFailedFn`
- Constantes : `DEFAULT_DAG`, `QUICK_DAG`, `REVIEW_DAG`, `SOLO_DAG`, `LIGHT_DAG`, `RESEARCH_DAG`
- Fonctions : `getDAG`, `buildSequentialDAG`, `executeDag`

### 4.3 config/features.json mis a jour

```json
{
  "heartbeat": true,
  "explore_mode": true,
  "job_manager": true,
  "auto_document_search": true,
  "prd_to_deploy": true,
  "exploration_phase": true,
  "exploration_gate": false
}
```

### 4.4 Pipeline commun processMessageInput

Signature cible :

```typescript
interface MessageInputOptions {
  isVoice: boolean;
  includeDocumentSearch: boolean;
  promptPrefix: string;      // "" pour text, "[Voice message transcribed]: " pour voice
  respond: (ctx: Context, text: string) => Promise<void>;
}

async function processMessageInput(
  bctx: BotContext,
  ctx: Context,
  input: string,
  options: MessageInputOptions,
): Promise<void>
```

Le pipeline encapsule : session init + constraint extraction, clarification check, PRD revision check, proposal confirmation check, context assembly (relevantContext, memoryContext, recentMessages, dynProfile, classification, docResults optionnel), intent detection (regex + LLM) + PRD workflow interception, conversation fallback (prompt build, callClaude, processMemoryIntents, proposal detection).

### 4.5 Exports memory.ts nettoyes

Les 10 exports morts perdent le mot-cle `export` (le code interne est conserve s'il est utilise localement, sinon supprime) :
- `FactRecord`, `GoalRecord`, `IdeaRecord` — interfaces non referencees
- `MemoryArchiveResult`, `MemoryChainNode`, `MemoryLink`, `MemoryRecord`, `MemorySearchResult`, `MemoryStats` — types non references
- `SimilarMemory` — interface non referencee

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/worktree.ts` | Supprimer | Module mort : 0 importers depuis src/ (verifie par Grep) |
| `src/dag-executor.ts` | Supprimer | Module mort apres migration DAG : 0 importers depuis src/ |
| `src/orchestrator.ts` | Modifier | Corriger silent catches (PAS de migration DAG — tout est supprime) |
| `src/memory.ts` | Modifier | Retirer le mot-cle `export` de 10 declarations mortes |
| `src/commands/zz-messages.ts` | Modifier | Extraire processMessageInput(), simplifier text/voice handlers |
| `src/workflow.ts` | Modifier | Corriger `.catch(() => {})` L683 avec logging |
| `src/orchestrator.ts` | Modifier | Corriger `.catch(() => {})` L697, L746, L796, L1011 avec logging |
| `README.md` | Modifier | Retirer references a worktree.ts et dag-executor.ts |
| `tests/unit/readme.test.ts` | Modifier | Adapter assertions apres suppression modules morts |
| `config/code-graph.json` | Modifier | Retirer noeuds worktree.ts et dag-executor.ts |
| `config/features.json` | Modifier | Supprimer la cle `model_cascade` |
| `CLAUDE.md` | Modifier | Mettre a jour le module count (passage de 58 a 56 modules src/) |
| `tests/unit/worktree.test.ts` | Supprimer | Tests du module mort worktree.ts |
| `tests/unit/dag-executor.test.ts` | Supprimer | Tests du module mort dag-executor.ts |
| `tests/unit/adaptive-pipeline.test.ts` | Modifier | Rediriger imports DAG de dag-executor vers orchestrator |
| `tests/unit/tavily-research.test.ts` | Modifier | Rediriger imports DAG de dag-executor vers orchestrator |

## 6. Patterns existants

### 6.1 Loader alphabetique avec prefixe "zz-"

```typescript
// src/loader.ts L26-27
// Sort alphabetically — ensures "zz-" prefixed files load last
files.sort();
```

Le prefixe "zz-" de zz-messages.ts est un pattern de chargement critique. Le refactoring doit rester dans le meme fichier (pas de nouveau module) pour preserver cet ordre.

### 6.2 Pattern Composer factory

```typescript
// src/commands/zz-messages.ts L177
export default function messagesComposer(bctx: BotContext): Composer<Context> {
```

Toutes les fonctions internes (comme `processMessageInput`) doivent rester dans le scope du Composer factory pour acceder a `bctx` via closure.

### 6.3 Re-export pattern dans orchestrator.ts

```typescript
// src/orchestrator.ts L118-131
// Re-export pipeline selection for backward compatibility
export {
  DEFAULT_PIPELINE, QUICK_PIPELINE, REVIEW_PIPELINE,
  SOLO_PIPELINE, LIGHT_PIPELINE, RESEARCH_PIPELINE,
  selectPipeline, selectAdaptivePipeline,
  classifyPipeline, classifyAdaptivePipeline,
  type PipelineType,
};
```

Les constantes PIPELINE sont definies dans `pipeline-selection.ts` et re-exportees depuis `orchestrator.ts`. Les constantes DAG suivront le meme pattern en sens inverse : definies directement dans orchestrator.ts (pas de re-export, car dag-executor.ts sera supprime).

### 6.4 Silent catch pattern acceptable vs problematique

Acceptable (fire-and-forget non-critique) :
```typescript
// src/commands/zz-messages.ts L761
await unlink(filePath).catch(() => {});
// src/memory.ts L365
bumpMemoryAccess(supabase, servedIds).catch(() => {});
```

Problematique (erreur Supabase masquee) :
```typescript
// src/workflow.ts L683
}).catch(() => {});  // workflow log insert — erreur perdue
// src/orchestrator.ts L697
}).catch(() => {});  // agent event emit — erreur perdue
```

### 6.5 Duplication text/voice dans zz-messages.ts

Le handler text (L201-414) et voice (L417-642) partagent un pipeline quasi-identique avec ces differences :

| Etape | Text handler | Voice handler |
|-------|-------------|---------------|
| Input | `ctx.message.text` | `transcription` (apres fetch + transcribe) |
| Save message | `"user", text` | `"user", [Voice Xs]: transcription` |
| Document search | Oui (`isFeatureEnabled("auto_document_search")`) | Non |
| Prompt prefix | `text` brut | `[Voice message transcribed]: transcription` |
| Response | `bctx.sendResponse(ctx, response)` | `bctx.sendVoiceResponse(ctx, claudeResponse)` |
| Document context | Passe a `buildPrompt` | Non passe (undefined) |

Tout le reste (session init, constraints, clarification, PRD revision, proposal confirmation, intent detection regex + LLM, PRD workflow interception, conversation fallback, proposal detection) est identique.

## 7. Contraintes

### Ce qu'il ne faut PAS casser

- **2720 tests** : tous doivent passer apres chaque phase du refactoring (`bun test`)
- **Build** : `bun build` doit rester sans erreur apres chaque modification
- **Ordre de chargement** : le prefixe "zz-" de zz-messages.ts doit etre preserve (loader.ts)
- **Comportement fonctionnel** : text et voice doivent produire des resultats identiques a l'existant
- **Dual format voice** : les reponses vocales doivent continuer a etre envoyees en voice + text (via `sendVoiceResponse`)
- **semaphore.ts** : conserve — importe par job-manager.ts et auto-pipeline.ts (modules vivants)
- **Feature flag `exploration_gate`** : conserve malgre son etat OFF

### Limites techniques

- `processMessageInput` doit rester une fonction interne a zz-messages.ts (dans le scope du Composer factory) car elle depend de `bctx` via closure
- Les types DAG migres vers orchestrator.ts importent `AgentRole` et `AgentStepResult` qui sont deja definis dans orchestrator.ts — pas de dependance circulaire
- `executeDag` importe `Semaphore` depuis semaphore.ts — cette dependance doit etre preservee dans orchestrator.ts

### Dependances

- `src/semaphore.ts` : utilise par executeDag (a migrer), job-manager.ts, auto-pipeline.ts
- `orchestrator.ts` depend deja de `pipeline-selection.ts` — l'ajout des DAG ne cree pas de nouvelle dependance externe sauf semaphore.ts
- Les 2 tests a modifier (adaptive-pipeline.test.ts, tavily-research.test.ts) changent seulement la source d'import

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | worktree.ts est supprime et n'est importe nulle part | `grep -r "worktree" src/` ne retourne aucun import | unit |
| V2 | dag-executor.ts est supprime et n'est importe nulle part | `grep -r "dag-executor" src/ tests/` ne retourne aucun import | unit |
| V3 | Les constantes DAG (DEFAULT_DAG, QUICK_DAG, REVIEW_DAG, SOLO_DAG, LIGHT_DAG, RESEARCH_DAG) sont importables depuis orchestrator.ts | `import { SOLO_DAG } from "./orchestrator"` compile sans erreur | unit |
| V4 | getDAG("SOLO") retourne un Map avec dev:[] | Test unitaire : `expect(getDAG("SOLO").get("dev")).toEqual([])` | unit |
| V5 | buildSequentialDAG(["dev", "qa"]) retourne un Map avec dev:[], qa:["dev"] | Test unitaire assertion sur le Map retourne | unit |
| V6 | executeDag execute les agents dans l'ordre des dependances | Test unitaire avec mock runAgent verifiant l'ordre d'execution | unit |
| V7 | adaptive-pipeline.test.ts passe apres redirection des imports vers orchestrator | `bun test tests/unit/adaptive-pipeline.test.ts` exit 0 | integration |
| V8 | tavily-research.test.ts passe apres redirection des imports vers orchestrator | `bun test tests/unit/tavily-research.test.ts` exit 0 | integration |
| V9 | model_cascade est absent de config/features.json | JSON.parse du fichier ne contient pas la cle `model_cascade` | unit |
| V10 | exploration_gate est present dans config/features.json | JSON.parse du fichier contient `exploration_gate: false` | unit |
| V11 | Les 10 exports morts de memory.ts ne sont plus exportes | `grep "export.*FactRecord\|export.*GoalRecord\|..." src/memory.ts` ne retourne rien | unit |
| V12 | Les fonctions/types internes de memory.ts restent utilisables en interne | Les fonctions qui utilisent FactRecord, GoalRecord, etc. compilent sans erreur | unit |
| V13 | workflow.ts L683 : le catch log l'erreur au lieu de la masquer | Test : mock console.error, verifier qu'il est appele sur erreur Supabase | unit |
| V14 | orchestrator.ts L697, L746, L796, L1011 : les catches loguent l'erreur | Verification par inspection ou test unitaire avec mock console.error | unit |
| V15 | conversation-session.ts L127 : le catch log l'erreur | Verification par inspection ou test unitaire avec mock console.error | unit |
| V16 | Le text handler produit le meme comportement qu'avant le refactoring pour un message texte simple | Test integration : message texte -> intent detection -> conversation fallback -> reponse identique | integration |
| V17 | Le voice handler produit le meme comportement qu'avant le refactoring pour un message vocal | Test integration : message vocal -> transcription -> intent detection -> conversation fallback -> voiceResponse | integration |
| V18 | Le text handler inclut le document search auto et le voice handler ne l'inclut pas | Verification du parametre `includeDocumentSearch` passe a processMessageInput | unit |
| V19 | Le voice handler utilise sendVoiceResponse et le text handler utilise sendResponse | Verification du callback `respond` passe a processMessageInput | unit |
| V20 | Le prefixe "zz-" est preserve : loader.ts charge zz-messages.ts en dernier | Verification que le fichier s'appelle toujours zz-messages.ts | manual |
| V21 | `bun test` passe integralement (2720 tests - ceux supprimes pour les modules morts) | `bun test` exit 0 | integration |
| V22 | `bun build src/relay.ts` compile sans erreur | Build check apres chaque phase | integration |
| V23 | processMessageInput n'est pas dans un fichier separe (reste dans zz-messages.ts) | Verification que `src/message-pipeline.ts` n'existe pas | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Duplication text/voice (85%), modules morts (worktree, dag-executor), silent catches (5-6), exports morts memory.ts (10), feature flag mort (model_cascade) — tous documentes dans l'exploration |
| Perimetre | Couvert | IN : suppression code mort, migration DAG, extraction pipeline commun, correction catches, nettoyage exports. OUT : refactoring des handlers photo/document (pas de duplication significative), suppression exploration_gate, restructuration par domaine (option D) |
| Validation | Couvert | 2720 tests existants comme filet de securite, build check rapide (42ms), 23 V-criteres couvrant chaque changement |
| Technique | Couvert | Impact sur 14 fichiers, pas de nouvelle dependance, pas de changement d'API publique, ordre de chargement preserve |
| UX | Non applicable | Refactoring interne sans impact sur l'experience utilisateur Telegram |
| Alternatives | Couvert | 4 alternatives evaluees dans l'exploration (Status quo / Nettoyage chirurgical / Refactoring profond / Rewrite modulaire). Option C retenue pour ratio valeur/risque optimal |

**Zones d'ombre residuelles :**

1. **Nombre exact de tests supprimes** : worktree.test.ts (79L) et dag-executor.test.ts (189L) sont supprimes. Les tests des DAG dans adaptive-pipeline.test.ts et tavily-research.test.ts sont preserves avec redirection d'imports. Le nombre total de tests passera de 2720 a ~2700 (estimation — le nombre exact depend du nombre de `it()` dans les fichiers supprimes).
2. **Signature exacte de processMessageInput** : la signature proposee en section 4.4 est indicative. L'implementation peut ajuster les parametres si necessaire, tant que les V-criteres V16-V19 sont satisfaits.
3. **Position exacte du code DAG dans orchestrator.ts** : les types et constantes DAG doivent etre places apres les imports existants de semaphore.ts (nouvel import a ajouter) et avant la section types/functions existante. L'implementation determinera le placement exact.
