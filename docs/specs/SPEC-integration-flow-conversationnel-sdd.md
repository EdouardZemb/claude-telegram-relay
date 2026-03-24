---
phase: 1-spec
status: draft
generated_at: "2026-03-24T18:00:00Z"
subject: "Phase 3 Architecture V2 — Integration du flow conversationnel SDD"
decisions:
  - D1: Instruction de convergence dans buildPrompt() de bot-context.ts (transversal, pas dans topic-config.ts)
  - D2: Spec-architect en background avec handoff summary comme substitut a la Discovery Interview
  - D3: 3 agents adversariaux en parallele via Promise.all dans un seul job sdd-challenge
  - D4: sdd-agents.ts dans src/ (logique metier, pas Composer grammY)
  - D5: Callbacks sdd_* dans sdd-flow.ts appellent les fonctions de sdd-agents.ts via job-manager.launch()
  - D6: exploration.ts adapte pour creer un pipeline tracker a chaque lancement
  - D7: Completion d'un job SDD met a jour le pipeline tracker et affiche la status bar
input_exploration: docs/explorations/EXPLORE-integration-flow-conversationnel-sdd.md
---

# SPEC — Integration du flow conversationnel SDD (Phase 3 Architecture V2)

## Section 1 — Objectif

Brancher les modules fondation Phase 2 (pipeline-tracker.ts, conversation-handoff.ts, sdd-flow.ts) dans le flow reel du bot pour obtenir un pipeline SDD end-to-end fonctionnel. La Phase 3 connecte les 5 maillons qui existent individuellement mais ne sont pas encore relie : (1) ajouter l'instruction de convergence dans le system prompt de buildPrompt(), (2) creer le module sdd-agents.ts avec les vraies fonctions d'agent qui remplacent les placeholders de sdd-flow.ts, (3) adapter exploration.ts pour creer un pipeline tracker, (4) chaîner la completion de job avec updateStep et affichage status bar.

Source : docs/ARCHITECTURE-V2.md Phase 3, decisions conversationnelles D1-D7, docs/explorations/EXPLORE-integration-flow-conversationnel-sdd.md.

---

## Section 2 — Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | buildPrompt() dans bot-context.ts ajoute TOUJOURS l'instruction de convergence dans le system prompt (pas conditionnelle a un tracker). L'instruction demande a Claude de produire "Decisions:\n- ...\nProchaine etape: ..." quand la conversation converge. < 100 mots, positionnee en debut de system prompt (avant recentMessages) pour maximiser l'efficacite. | Challenge F-DA-1 BLOQUANT correction, D1 | Instruction toujours presente, pas de dependance a chatId/threadId |
| R2 | SUPPRIMEE — buildPrompt() n'a plus besoin de hasSddPipeline. L'instruction de convergence est un guidage comportemental sans effet de bord si aucun pipeline n'existe (les boutons n'apparaissent que si detectConvergenceInResponse match ET un tracker existe). | Challenge F-DA-1 correction | -- |
| R3 | sdd-agents.ts est un module de logique metier dans src/ (pas dans src/commands/). Il exporte des fonctions publiques : runSddExplore(name, chatId, threadId, bctx), runSddSpec(name, handoff, bctx), runSddChallenge(name, bctx), runSddImplement(name, bctx), runSddReview(name, bctx). | D4, exploration F4 | sdd-flow.ts importe { runSddExplore } from "../sdd-agents.ts" |
| R4 | Chaque fonction de sdd-agents.ts retourne une Promise<string> avec un prefixe SDD_{PHASE}_{VERDICT}: ... pour compatibilite avec getCompletionKeyboard() dans job-manager.ts. En cas d'erreur, retourner SDD_{PHASE}_FAILED: message d'erreur. | D4, exploration F3 | runSddExplore retourne "SDD_EXPLORE_GO: explore complete — EXPLORE-name.md" |
| R5 | runSddExplore() construit le prompt avec le contexte conversationnel assemble par assembleHandoffContext() + formatHandoffForAgent(), puis appelle spawnClaude() avec l'agent explorer.md. L'artefact produit est docs/explorations/EXPLORE-{name}.md. Le verdict (GO/PIVOT/DROP) est extrait depuis le contenu de l'artefact apres completion. | D4, ARCHITECTURE-V2 Etape 1 | spawnClaude({ prompt: fullPrompt, systemPrompt: "...", model: "claude-sonnet-4-6" }) |
| R6 | runSddSpec() injecte le handoff summary (formatHandoffForAgent()) + la reference exploration (explorationRef si presente) comme substitut a la Discovery Interview du spec-architect. Le prompt doit inclure une section "CONTEXTE CONVERSATIONNEL" avant la demande de spec. L'agent ne conduit pas d'interview interactive. | D2, exploration F1 | Prompt: "CONTEXTE CONVERSATIONNEL:\n{handoffFormatted}\n\nGenere la spec 9 sections pour : {name}" |
| R7 | runSddChallenge() lance 3 spawnClaude() en parallele via Promise.allSettled : devils-advocate.md, edge-case-hunter.md, simplicity-skeptic.md. Les rapports des agents qui reussissent sont concatenes dans docs/reviews/adversarial-SPEC-{name}.md. Les agents en echec sont documentes comme "AGENT CRASH" dans le rapport. Le verdict global est le plus severe des agents ayant repondu (NO-GO > GO_WITH_CHANGES > GO). | Challenge F-EC-2, D3, ARCHITECTURE-V2 Etape 4 | Promise.allSettled([spawnDevil, spawnEdge, spawnSkeptic]) → filtrage fulfilled/rejected |
| R8 | runSddImplement() appelle le skill /dev-implement via spawnClaude() avec useWorktree: true. Il passe la spec (specRef) et le rapport adversarial (adversarialRef) comme contexte. L'artefact produit est docs/reviews/implement-{name}.md. Le format de retour est SDD_IMPLEMENT_OK: PR#{numero} — {stats}. | D4, ARCHITECTURE-V2 Etape 5 | spawnClaude({ prompt, useWorktree: true }) |
| R9 | Les callbacks sdd_explore / sdd_spec / sdd_challenge / sdd_implement / sdd_review dans sdd-flow.ts remplacent les placeholders par des appels launch(jobType, chatId, () => runSddXxx(...), { messageThreadId }). Le handoff context est assemble dans le callback avant le lancement du job (pas dans sdd-agents.ts). | D5, sdd-flow.ts L218-223 | launch("sdd-explore:name", chatId, () => runSddExplore(name, chatId, threadId, bctx), opts) |
| R10 | La fonction explorationCommand dans exploration.ts cree un pipeline tracker avant le lancement du job explore. Le nom du pipeline est derive de la query via toPipelineName(query). Si un tracker existe deja pour ce chat/thread, verifier son age : si < 1h, demander confirmation a l'utilisateur avant d'ecraser (bouton "Remplacer le pipeline en cours ?"). Si > 1h ou inexistant, creer directement. | Challenge F-DA-2 correction, D6, ARCHITECTURE-V2 Etape 1 | createPipeline(chatId, threadId, toPipelineName(query)) avec guard anti-ecrasement |
| R11 | Quand exploration.ts lance l'explorateur en background, il appelle updateStep(chatId, threadId, "explore", { status: "running", jobId }) apres le launch. Le job type passe a launchJob est "sdd-explore:{name}" (meme format que dans sdd-flow.ts) pour que getCompletionKeyboard() reconnaisse le pattern. | D6, D7, job-manager.ts L306-354 | launchJob("sdd-explore:" + name, chatId, exploreFn, { messageThreadId }) |
| R12 | sdd-agents.ts NE reutilise PAS buildExploreFn() depuis exploration.ts (qui importe des modules "Supprimes" via bmad-agents.ts). runSddExplore() construit son propre prompt directement avec spawnClaude() : lis .claude/agents/explorer.md et suis ses instructions. L'exploration via /explore continue d'utiliser ses imports actuels (a nettoyer en Phase 4). | Challenge F-EC-3 MAJEUR correction, Z4 | runSddExplore appelle spawnClaude directement, pas buildExploreFn |
| R13 | sdd-agents.ts NE DOIT PAS importer depuis orchestrator/, blackboard.ts, gate-evaluator.ts, gate-persistence.ts, trust-scores.ts, deliberation.ts, agent-messaging.ts, adversarial-verifier.ts, adversarial-challenge.ts, spec-lite.ts, exploration-scoring.ts, pipeline-selection.ts, pipeline-state.ts, workflow.ts, bmad-agents.ts, bmad-prompts.ts, agent-schemas.ts, feedback-loop.ts, conversation-session.ts, code-review.ts, prd.ts, prd-workflow.ts, auto-pipeline.ts, llm-router.ts. | Contrainte principale, ARCHITECTURE-V2 Modules Supprimes | Import autorise : agent.ts, conversation-handoff.ts, pipeline-tracker.ts, logger.ts |
| R14 | L'instruction de convergence est toujours presente mais ne perturbe pas les conversations normales — c'est un guidage comportemental qui n'a d'effet que quand Claude detecte une convergence reelle. Les boutons n'apparaissent que si le regex match ET un tracker existe. | D1, Challenge F-DA-1 correction | Pas de condition, toujours injecte |
| R15 | Plain text uniquement dans toutes les reponses Telegram. Pas de markdown dans les messages du bot (confirmant la convention existante). | Convention projet | Aucun bold/italic/code dans les messages SDD |

---

## Section 3 — Donnees d'entree

| Source | Type | Acces | Champs |
|--------|------|-------|--------|
| Pipeline tracker | PipelineTracker | getTracker(chatId, threadId) | name, steps, chatId, threadId |
| Handoff summary | HandoffSummary | assembleHandoffContext(messages, opts) | objective, decisions, constraints, filesIdentified, explorationRef, specRef |
| Context conversationnel format | string | formatHandoffForAgent(summary) | section RESUME DES DECISIONS CONVERSATIONNELLES |
| Callback SDD | string | ctx.callbackQuery.data | format "sdd_{action}:{name}" |
| Query exploration | string | ctx.match?.trim() | query texte libre |
| BotContext | BotContext | parametre des handlers | supabase, sendResponse, threadOpts, getThreadId |
| Messages recents | string[] | getRecentMessages() de memory/core.ts | messages bruts de la conversation |
| SpawnClaude result | SpawnClaudeResult | spawnClaude(opts) | stdout, stderr, exitCode |

---

## Section 4 — Donnees de sortie

### 4.1 Instruction de convergence dans buildPrompt()

Chaine ajoutee au system prompt quand hasSddPipeline est true :

```
SDD CONVERGENCE: When the conversation converges on clear decisions, produce this exact format:
Decisions:
- [decision 1]
- [decision 2]
Prochaine etape: [suggested step]
```

Contrainte : < 100 mots, en anglais pour le system prompt Claude, insert apres la section MEMORY MANAGEMENT.

### 4.2 Module sdd-agents.ts

Exports publics :
- `runSddExplore(name: string, chatId: number, threadId: number | undefined, bctx: BotContext): Promise<string>`
- `runSddSpec(name: string, handoff: HandoffSummary, bctx: BotContext): Promise<string>`
- `runSddChallenge(name: string, bctx: BotContext): Promise<string>`
- `runSddImplement(name: string, bctx: BotContext): Promise<string>`
- `runSddReview(name: string, bctx: BotContext): Promise<string>`

Chaque fonction retourne une string prefixee SDD_{PHASE}_{VERDICT}: ... (ou SDD_{PHASE}_FAILED: ...).

### 4.3 Adaptation sdd-flow.ts

Les cases explore/spec/challenge/implement/review remplacent :
```typescript
const agentFn = async (): Promise<string> => {
  return `SDD_${action.toUpperCase()}_OK: ${name} — Phase ${action} completee via SDD flow`;
};
```
par :
```typescript
const handoff = assembleHandoffContext(recentMessages, { pipelineName: name, explorationRef });
const agentFn = (): Promise<string> => runSddXxx(name, handoff, bctx);
```

### 4.4 Adaptation exploration.ts

Ajout apres la validation de query, avant le lancement du job :
1. `const pipelineName = toPipelineName(query)`
2. `await createPipeline(chatId, threadId, pipelineName)` — ecrase un tracker precedent
3. `await updateStep(chatId, threadId, "explore", { status: "running" })` apres launch

Le jobType passe a launchJob est `"sdd-explore:" + pipelineName` au lieu de `"explore"`.

### 4.5 Format de retour par phase

| Phase | Format succes | Format echec |
|-------|---------------|--------------|
| explore | `SDD_EXPLORE_GO: {name} — EXPLORE-{name}.md` | `SDD_EXPLORE_FAILED: {error}` |
| explore pivot | `SDD_EXPLORE_PIVOT: {name} — {raison}` | |
| explore drop | `SDD_EXPLORE_DROP: {name} — {raison}` | |
| spec | `SDD_SPEC_OK: {name} — SPEC-{name}.md ({n} V-criteres)` | `SDD_SPEC_FAILED: {error}` |
| challenge | `SDD_CHALLENGE_GO: {name} — adversarial-SPEC-{name}.md` | `SDD_CHALLENGE_FAILED: {error}` |
| challenge with changes | `SDD_CHALLENGE_GO_WITH_CHANGES: {name} — {n} findings` | |
| challenge no-go | `SDD_CHALLENGE_NO-GO: {name} — {n} findings critiques` | |
| implement | `SDD_IMPLEMENT_OK: {name} — PR#{n} ({stats})` | `SDD_IMPLEMENT_FAILED: {error}` |
| review | `SDD_REVIEW_OK: {name} — review complete` | `SDD_REVIEW_FAILED: {error}` |

---

## Section 5 — Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/sdd-agents.ts` | Creer (~280 LOC) | Module de logique metier SDD : 5 fonctions runSddXxx() avec construction de prompt, appel spawnClaude(), parsing du resultat |
| `src/commands/sdd-flow.ts` | Modifier (~+50 LOC) | Remplacer les placeholders agentFn (L218-223) par des appels aux fonctions de sdd-agents.ts. Ajouter import conversation-handoff et memory/core. |
| `src/bot-context.ts` | Modifier (~+20 LOC) | Ajouter parametre hasSddPipeline?: boolean a buildPrompt(), ajouter la verif getTracker() dans callClaude(), ajouter l'instruction de convergence au system prompt quand actif |
| `src/commands/exploration.ts` | Modifier (~+20 LOC) | Ajouter createPipeline() + updateStep() avant/apres launchJob(). Changer jobType en "sdd-explore:{name}". Exporter buildExploreFn(). |
| `tests/unit/sdd-agents.test.ts` | Creer (~150 LOC) | Tests unitaires des 5 fonctions runSddXxx avec mocks de spawnClaude et sdd-flow placeholder |
| `tests/unit/sdd-flow.test.ts` | Modifier (~+40 LOC) | Tester que les cases explore/spec/challenge/implement/review appellent les bonnes fonctions de sdd-agents (moquees) |
| `tests/unit/bot-context.test.ts` | Modifier (~+20 LOC) | Tester l'instruction de convergence dans buildPrompt() avec hasSddPipeline=true et false |
| `tests/unit/exploration.test.ts` | Creer (~80 LOC) | Tester buildExploreFn export, createPipeline appelé dans /explore, jobType format "sdd-explore:..." |

Fichiers lus mais non modifies :
- `src/pipeline-tracker.ts` — API consommee telle quelle (createPipeline, updateStep, getTracker, formatStatusBar, toPipelineName)
- `src/conversation-handoff.ts` — API consommee telle quelle (assembleHandoffContext, formatHandoffForAgent)
- `src/agent.ts` — spawnClaude() consomme tel quel
- `src/job-manager.ts` — launch(), getCompletionKeyboard() deja fonctionnels, pas de modification
- `src/memory/core.ts` — getRecentMessages() consomme tel quel

---

## Section 6 — Patterns existants

### 6.1 Pattern spawnClaude dans exploration.ts

Reutiliser le pattern complet de construction de prompt + spawn (L129-203 de exploration.ts) :
```typescript
// src/commands/exploration.ts L176-185
const result = await spawnClaude({
  prompt: fullPrompt,
  systemPrompt: systemPrompt || undefined,
  outputFormat: "json",
  model,
  effort: effort as "low" | "medium" | "high" | "max",
  mcpRole: "explorer",
});
```
Pour sdd-agents.ts, utiliser le meme pattern sans outputFormat json (les agents SDD retournent du texte libre).

### 6.2 Pattern launch() dans sdd-flow.ts

Pattern existant a adapter (sdd-flow.ts L203-234) :
```typescript
const jobType = `sdd-${action}:${name}`;
const jobId = await launch(jobType, chatId, agentFn, { messageThreadId: threadId });
await updateStep(chatId, threadId, phase, { jobId });
```

### 6.3 Pattern createPipeline() dans pipeline-tracker.ts

API a appeler depuis exploration.ts (pipeline-tracker.ts L131-157) :
```typescript
export async function createPipeline(
  chatId: number,
  threadId: number | undefined,
  name: string,
): Promise<PipelineTracker>
```

### 6.4 Pattern assembleHandoffContext() + formatHandoffForAgent()

(conversation-handoff.ts L123-207) :
```typescript
const handoff = assembleHandoffContext(recentMessages, {
  pipelineName: name,
  explorationRef: "docs/explorations/EXPLORE-{name}.md",
});
const formatted = formatHandoffForAgent(handoff);
```

### 6.5 Pattern buildPrompt() avec params optionnels (bot-context.ts L569-650)

buildPrompt() accepte actuellement 7 params optionnels. Ajouter hasSddPipeline comme 8eme :
```typescript
function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentMessages?: string,
  topicName?: string,
  dynamicProfile?: string,
  documentContext?: string,
  hasSddPipeline?: boolean,   // NEW
): string
```

### 6.6 Pattern de detection convergence deja cable dans zz-messages.ts

(zz-messages.ts L513-527) : le code existe, il ne se declenche jamais car Claude ne produit pas le signal. Aucune modification necessaire — il fonctionnera des que l'instruction est ajoutee dans buildPrompt().

### 6.7 getCompletionKeyboard() deja fonctionnel

(job-manager.ts L306-354) : gere deja les jobs "sdd-*" et parse SDD_{PHASE}_{VERDICT}:. Pas de modification.

---

## Section 7 — Contraintes

### 7.1 Imports interdits dans sdd-agents.ts

sdd-agents.ts NE DOIT PAS importer depuis les modules marques "Supprimes" dans ARCHITECTURE-V2 (R13) :
- Interdits absolus : orchestrator/, blackboard.ts, gate-evaluator.ts, bmad-agents.ts, bmad-prompts.ts, agent-schemas.ts, adversarial-challenge.ts, adversarial-verifier.ts, spec-lite.ts, pipeline-selection.ts, pipeline-state.ts, workflow.ts, prd.ts, auto-pipeline.ts, llm-router.ts, code-review.ts
- Imports autorises : agent.ts (spawnClaude), conversation-handoff.ts, pipeline-tracker.ts, logger.ts, feature-flags.ts

### 7.2 Ne pas modifier les agents .claude/agents/*.md

Les fichiers .claude/agents/explorer.md, spec-architect.md, devils-advocate.md, edge-case-hunter.md, simplicity-skeptic.md, reviewer.md ne doivent pas etre modifies. Le contexte conversationnel est injecte uniquement via le prompt.

### 7.3 Ne pas modifier les skills .claude/skills/*.md

Les fichiers de skills ne doivent pas etre modifies.

### 7.4 buildPrompt() reste synchrone

buildPrompt() ne doit pas devenir async. La verification getTracker() est faite cote appelant (dans callClaude()) et le resultat est passe comme parametre hasSddPipeline.

### 7.5 sdd-agents.ts n'est pas un Composer grammY

Ce module n'importe pas Composer, Context, ou grammy. Il est de la logique metier pure. Il n'est pas auto-charge par loader.ts.

### 7.6 Semaphore job-manager

Le semaphore par defaut du job-manager est max 3. runSddChallenge() lance 3 Promise.all() en interne dans une seule fonction — cette fonction est un seul job (1 slot semaphore). Les 3 spawnClaude() sont des processus OS, pas des slots semaphore.

### 7.7 Taille des fichiers

- sdd-agents.ts doit rester sous 400 LOC
- sdd-flow.ts avec modifications reste sous 350 LOC (actuellement 244 LOC, ajout ~+50 LOC)
- bot-context.ts avec modifications reste sous 840 LOC (actuellement 816 LOC, ajout ~+20 LOC)

### 7.8 Pas de modification de relay.ts

Tout est deja initialise au startup (initJobManager, initSessions, initPipelineTracker).

### 7.9 Instruction de convergence en anglais

Le system prompt de buildPrompt() est en anglais (convention existante). L'instruction de convergence suit cette convention.

---

## Section 8 — Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|--------------|--------|
| V1 | buildPrompt() avec hasSddPipeline=true contient le pattern "SDD CONVERGENCE" dans sa sortie | Test: buildPrompt("msg", ..., ..., ..., ..., ..., ..., true) includes "SDD CONVERGENCE" | unit |
| V2 | buildPrompt() avec hasSddPipeline=false ou undefined ne contient pas "SDD CONVERGENCE" | Test: buildPrompt("msg") does not include "SDD CONVERGENCE" | unit |
| V3 | L'instruction de convergence dans le system prompt est < 100 mots | Test: compter les mots de la section ajoutee quand hasSddPipeline=true | unit |
| V4 | L'instruction de convergence contient "Decisions:" et "Prochaine etape:" | Test: inclusion des deux marqueurs dans l'instruction | unit |
| V5 | runSddExplore() retourne une string prefixee "SDD_EXPLORE_GO:", "SDD_EXPLORE_PIVOT:", "SDD_EXPLORE_DROP:", ou "SDD_EXPLORE_FAILED:" | Test: mock spawnClaude avec stdout contenant un verdict, verifier le prefixe du retour | unit |
| V6 | runSddSpec() retourne une string prefixee "SDD_SPEC_OK:" ou "SDD_SPEC_FAILED:" | Test: mock spawnClaude, verifier le prefixe | unit |
| V7 | runSddSpec() inclut la section "CONTEXTE CONVERSATIONNEL" dans le prompt passe a spawnClaude | Test: capturer le prompt via mock spawnClaude, verifier la presence de "CONTEXTE CONVERSATIONNEL" | unit |
| V8 | runSddChallenge() appelle spawnClaude 3 fois en parallele (Promise.all) | Test: mock spawnClaude comptant les appels, verifier count=3 et que les 3 appels debutent avant que le premier se termine (mock avec delai) | unit |
| V9 | runSddChallenge() consolide les 3 rapports en un seul artefact adversarial-SPEC-{name}.md | Test: mock spawnClaude retournant des rapports distincts, verifier que le rapport consolide contient les 3 sections | unit |
| V10 | runSddChallenge() retourne le verdict le plus severe parmi les 3 agents (NO-GO > GO_WITH_CHANGES > GO) | Test: cas (GO, NO-GO, GO_WITH_CHANGES) → retourne "SDD_CHALLENGE_NO-GO:" | unit |
| V11 | runSddImplement() passe useWorktree: true a spawnClaude | Test: mock spawnClaude capturant les options, verifier useWorktree=true | unit |
| V12 | exploration.ts cree un pipeline tracker avant de lancer le job /explore | Test: mock createPipeline, verifier appele avec le bon nom kebab-case avant launchJob | integration |
| V13 | exploration.ts passe jobType "sdd-explore:{name}" a launchJob (et non "explore") | Test: mock launchJob, verifier que le premier argument match /^sdd-explore:/ | integration |
| V14 | exploration.ts appelle updateStep avec { status: "running" } apres le launch | Test: mock updateStep, verifier appele avec phase="explore" et status="running" | integration |
| V15 | buildExploreFn() est exportee depuis exploration.ts | Test: import { buildExploreFn } from "../../src/commands/exploration.ts" ne lance pas d'erreur | unit |
| V16 | Le callback sdd_explore dans sdd-flow.ts appelle runSddExplore (via launch) au lieu du placeholder | Test: mock runSddExplore et launch, simuler callback "sdd_explore:test-name", verifier runSddExplore appelee | integration |
| V17 | Le callback sdd_spec dans sdd-flow.ts assemble le handoff avant d'appeler runSddSpec | Test: mock assembleHandoffContext, verifier appelee avant le launch | integration |
| V18 | sdd-agents.ts n'importe pas depuis les modules interdits (R13) | Test statique: grep des imports de sdd-agents.ts, aucun import depuis orchestrator/ ou blackboard | unit |
| V19 | Quand spawnClaude retourne exitCode != 0, runSddXxx retourne une string prefixee "SDD_{PHASE}_FAILED:" | Test: mock spawnClaude avec exitCode=1, verifier le prefixe FAILED | unit |
| V20 | Le rapport challenge consolide est sauvegarde dans docs/reviews/adversarial-SPEC-{name}.md | Test: mock writeFile, verifier chemin avec adversarial-SPEC-{name}.md | unit |
| V21 | sdd-flow.ts envoie la status bar formatStatusBar() au chat apres le lancement d'un job SDD | Test integration: simuler callback sdd_spec, verifier que le message de reponse contient le format status bar "Pipeline «" | integration |
| V22 | La detection de convergence dans zz-messages.ts se declenche quand Claude produit "Decisions:" dans sa reponse | Test existant V19/V20 dans sdd-flow.test.ts confirme detectConvergenceInResponse — aucun nouveau test necessaire pour la logique de detection | unit |

---

## Section 9 — Coverage et zones d'ombre

### 9.1 Matrice de couverture

| Dimension | Status | Detail |
|-----------|--------|--------|
| **Fonctionnel** | Couvert | Les 5 fonctions runSddXxx sont specifiees avec input/output/format de retour. Le flow bout en bout explore → spec → challenge → implement → review est defini. |
| **Metier** | Couvert | Instruction de convergence (R1-R2), format prefixe SDD (R4), handoff comme substitut interview (R6), challenge parallele (R7), exploration tracker (R10-R11). |
| **Technique** | Couvert | Imports interdits (R13), async/sync de buildPrompt (R2), semaphore single-slot (contrainte 7.6), tailles de fichiers (7.7). |
| **Erreurs** | Couvert | SDD_PHASE_FAILED pour exitCode != 0, degrade gracefully si tracker absent (R4, V19). |

### 9.2 Alternatives evaluees et rejetees

**Option B (integration incrémentale sans sdd-agents.ts)** : rejetee car elle fait grossir sdd-flow.ts au-dela de 500 LOC en melangeant UI et logique metier. L'exploration a identifie ce risque (F4).

**Option D (plugin grammY conversations)** : rejetee car refonte structurelle disproportionnee pour le gain. Le pattern callbacks manuels est suffisant et coherent avec les 9 autres Composers.

**Instruction de convergence inconditionnelle** : rejetee car pollue les conversations normales. La condition hasSddPipeline permet de n'ajouter l'instruction que quand un pipeline est actif.

**Consolidation LLM des findings challenge** : deferred. La concatenation simple suffit pour Phase 3. La deduplication semantique est une amelioration future.

### 9.3 Zones non resolues

**Z1 — Revisions de spec** : L'Architecture V2 mentionne max 2 revisions (Etape 3). La gestion d'un compteur de revisions dans le pipeline tracker n'est pas specifiee ici. Deferre a une iteration post-Phase 3.

**Z2 — Merger direct** : Le bouton [Merger] de l'Etape 6 (merge PR avec confirmation) n'est pas dans le perimetre de cette spec. C'est une feature de Phase 5 (simplification des commandes).

**Z3 — updateStep post-completion depuis job-manager** : Quand un job se termine, job-manager.ts notifie le chat mais ne met pas a jour le pipeline tracker (il ne l'importe pas). L'update se fait dans le callback sdd_* suivant. Si l'utilisateur ne clique pas de bouton suivant, le tracker reste en "running" jusqu'au prochain acces. Ce comportement est acceptable pour Phase 3.

**Z4 — buildExploreFn et l'agent Ada (legacy)** : Le code actuel de exploration.ts utilise getAgent("explorer") depuis bmad-agents.ts, buildAgentContext depuis agent-context.ts, buildAgentSystemPromptPart depuis bmad-prompts.ts, parseAgentOutput depuis agent-schemas.ts — tous des modules "Supprimes" dans ARCHITECTURE-V2. La spec buildExploreFn doit simplifier ces appels ou les retirer. Cette simplification est un sous-objectif de Phase 3 : buildExploreFn utilise directement spawnClaude() sans passer par les modules deprecated.
