---
phase: 0-explore
generated_at: "2026-03-24T14:30:00Z"
subject: "Phase 3 Architecture V2 — Intégration du flow conversationnel SDD"
verdict: GO
next_step: "dev-implement"
---

## Section 1 — Problème

La Phase 2 de l'Architecture V2 a posé les fondations : `pipeline-tracker.ts` (persistence état pipeline, status bar), `conversation-handoff.ts` (extraction résumé décisions par pattern matching), et `sdd-flow.ts` (Composer pour callbacks InlineKeyboard `sdd_*`, construction de claviers contextuels, détection de convergence). Ces trois modules sont fonctionnels et testés, mais **non connectés au flow réel du bot**.

La Phase 3 doit les brancher pour obtenir un pipeline SDD end-to-end fonctionnel :

1. **System prompt de `callClaude`** : le `buildPrompt()` dans `bot-context.ts` n'instruit pas encore Claude à produire le format "Decisions: ..." quand la conversation converge. La détection de convergence (`detectConvergenceInResponse`) dans `zz-messages.ts` est câblée (lignes 513-527) mais ne se déclenche jamais car Claude ne produit pas le signal attendu.

2. **Callbacks `sdd_*` en placeholder** : dans `sdd-flow.ts` ligne 218, les phases explore/spec/challenge/implement/review utilisent une fonction placeholder (`async () => "SDD_{ACTION}_OK: ..."`) au lieu d'appeler les vrais agents via `spawnClaude()`.

3. **Exploration sans pipeline tracker** : `commands/exploration.ts` lance l'explorateur via `launchJob("explore", ...)` mais ne crée pas de `PipelineTracker`, ce qui empêche l'affichage du status bar et la chaîne de boutons post-exploration.

4. **Chaînage completion → boutons suivants** : le `getCompletionKeyboard()` dans `job-manager.ts` gère déjà les résultats SDD (lignes 306-354), mais les agents doivent retourner le bon format de préfixe (`SDD_{PHASE}_{VERDICT}: ...`) pour que les boutons contextuels apparaissent.

5. **Flow bout en bout manquant** : message utilisateur → détection convergence → boutons → agent background → notification completion → boutons suivants. Chaque maillon existe individuellement mais ils ne sont pas connectés.

L'exploration est nécessaire car l'intégration touche 5+ modules simultanément avec des dépendances circulaires potentielles (sdd-flow importe pipeline-tracker, zz-messages importe sdd-flow, exploration.ts doit importer pipeline-tracker), et le spec-architect agent a une phase interactive (Discovery Interview) qui ne peut pas tourner en background tel quel.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Inline and Custom Keyboards (built-in) - grammY](https://grammy.dev/plugins/keyboard) | Doc officielle | 2026-03-24 | Patterns InlineKeyboard grammY : callback_query handlers, `answerCallbackQuery`, guard de préfixe + `next()`, handler catch-all pour éviter le loading 60s côté client. | Haute |
| 2 | [Conversations plugin - grammY](https://grammy.dev/plugins/conversations) | Doc officielle | 2026-03-24 | Plugin `@grammyjs/conversations` : `waitForCallbackQuery()` pour attendre un clic bouton, state management via session storage, support TypeScript natif. Approche alternative au pattern actuel de callbacks manuels. | Moyenne |
| 3 | [Spec-Driven Development in 2025 - SoftwareSeni](https://www.softwareseni.com/spec-driven-development-in-2025-the-complete-guide-to-using-ai-to-write-production-code/) | Guide | 2026-03-24 | SDD comme méthodologie production : specs formelles → AI code generation. Les spécifications détaillées produisent du code consistant et maintenable. Recommande un "two-layer model" : orchestration déterministe + exécution bornée par agents. | Haute |
| 4 | [An AI-led SDLC with Azure and GitHub - Microsoft](https://techcommunity.microsoft.com/blog/appsonazureblog/an-ai-led-sdlc-building-an-end-to-end-agentic-software-development-lifecycle-wit/4491896) | Blog technique | 2026-03-24 | Agentic SDLC end-to-end : orchestration déterministe (workflow TypeScript) + agents AI bornés. Chaque étape a un input/output formel, l'orchestrateur gère les transitions. Pattern directement applicable au flow SDD. | Haute |

### Synthèse des enseignements clés

**Sur le pattern callback grammY** : Le projet utilise déjà le pattern recommandé (guard de préfixe + `next()` dans chaque Composer). Le plugin `conversations` de grammY offrirait un modèle plus élégant (`waitForCallbackQuery`) mais imposerait une refonte complète du handler dans `zz-messages.ts` — disproportionné pour Phase 3. Le pattern actuel est suffisant et déjà testé.

**Sur l'orchestration SDD** : Le consensus de l'industrie (Microsoft, SoftwareSeni, InfoQ) est que l'orchestration doit être déterministe (code TypeScript, pas de LLM pour décider quoi faire ensuite) tandis que les agents sont bornés dans leur exécution. C'est exactement le modèle de `sdd-flow.ts` : les transitions sont codées dans `buildSddKeyboard()` et `getCompletionKeyboard()`, les agents font le travail via `spawnClaude()`.

**Sur le Discovery Interview du spec-architect** : L'agent `spec-architect.md` a une Phase 2 interactive (max 4 rounds × 4 questions). En background via `spawnClaude()`, cette interaction est impossible. Deux approches : (a) passer le handoff summary comme substitut à l'interview (l'exploration + la discussion ont déjà collecté les réponses), ou (b) utiliser `callClaude()` en mode conversationnel pour l'interview avant de lancer le spec-architect en background. L'approche (a) est cohérente avec l'Architecture V2 qui supprime les interactions mid-agent.

**Sur le format de convergence** : Aucun framework ne fournit la détection de convergence out-of-the-box. L'approche du projet (marqueur "Decisions:" dans la réponse Claude, détecté par regex) est simple et pragmatique. L'instruction doit être ajoutée au system prompt de `buildPrompt()`.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/bot-context.ts` L569-649 | `buildPrompt()` construit le system prompt. Aucune instruction SDD/convergence actuellement. Ajouter l'instruction "Decisions:" ici = 5-10 lignes. | Moyen — modification chirurgicale |
| 2 | `src/commands/sdd-flow.ts` L196-235 | Switch `case "explore"/"spec"/"challenge"/"implement"/"review"` avec placeholder `agentFn`. Chaque case doit être remplacé par un vrai appel `spawnClaude()` avec le prompt approprié. | Haut — coeur de Phase 3 |
| 3 | `src/commands/exploration.ts` L77-225 | `/explore` handler. `exploreFn` construit le prompt via `buildAgentContext`, `buildAgentSystemPromptPart`, `spawnClaude()`. Pattern complet à réutiliser pour les callbacks SDD. Ne crée pas de pipeline tracker. | Haut — modèle pour les autres agents + adaptation tracker |
| 4 | `src/commands/zz-messages.ts` L513-527 | Convergence detection déjà câblée : `detectConvergenceInResponse(finalResponse)` → `getTracker()` → `buildSddKeyboard("discuss", tracker.name)` → reply avec keyboard. Fonctionne mais jamais déclenché (pas d'instruction dans le prompt). | Moyen — fonctionne dès que le prompt est corrigé |
| 5 | `src/job-manager.ts` L306-354 | `getCompletionKeyboard()` gère les jobs `sdd-*` : parse `SDD_{PHASE}_{VERDICT}:` du résultat, construit les boutons contextuels par phase/verdict. Logique complète et testée. | Faible — déjà fonctionnel, pas de modification nécessaire |
| 6 | `src/agent.ts` L227 | `spawnClaude()` : API publique. Accepte `{ prompt, systemPrompt, model, effort, mcpRole, useWorktree }`. Retourne `{ stdout, stderr, exitCode }`. Interface stable. | Faible — consommé tel quel |
| 7 | `.claude/agents/spec-architect.md` | Phase 2 = Discovery Interview (interactive, 4 rounds × 4 questions). Incompatible avec `spawnClaude()` en background. Le handoff summary doit remplacer l'interview. | Haut — nécessite adaptation du prompt |
| 8 | `.claude/agents/devils-advocate.md`, `edge-case-hunter.md`, `simplicity-skeptic.md` | 3 agents adversariaux, lecture seule, max 10 findings chacun. Tous utilisent Read/Grep/Glob. Peuvent tourner en parallèle via 3 `spawnClaude()` concurrents. | Moyen — lancement parallèle à implémenter |
| 9 | `src/conversation-handoff.ts` | `assembleHandoffContext()` + `formatHandoffForAgent()`. Extraction locale (regex, pas de LLM). Retourne `HandoffSummary` avec objective/decisions/constraints/files. | Faible — consommé tel quel |
| 10 | `src/pipeline-tracker.ts` | `createPipeline()`, `updateStep()`, `formatStatusBar()`. API complète et testée. `toPipelineName()` pour dériver le nom. | Faible — consommé tel quel |
| 11 | `src/relay.ts` L149-151 | `initJobManager(mainBot)`, `initSessions()`, `initPipelineTracker()` déjà appelés au startup. Pas de modification nécessaire. | Aucun |
| 12 | `src/memory/core.ts` (`getRecentMessages`) | Utilisé dans `zz-messages.ts` pour assembler le contexte. Le handoff en a besoin pour extraire les messages récents à passer à `assembleHandoffContext()`. | Faible — import existant dans zz-messages.ts |

### Points de friction identifiés

**F1 — spec-architect interactif** : Le plus gros défi. L'agent `spec-architect.md` attend une interview interactive (Phase 2) qui ne peut pas se faire en background. Solutions : (a) modifier le prompt pour skip la Phase 2 et utiliser le handoff summary comme input déjà enrichi, (b) ajouter les contraintes/décisions dans une section "Context de la discussion" du prompt. L'option (a) est la plus simple et cohérente avec la vision V2.

**F2 — 3 challengers en parallèle** : Le semaphore de `job-manager.ts` est limité à 3 (default). Lancer 3 challengers simultanément consomme tous les slots. Si un autre job tourne déjà, un challenger sera en queue. Solution : lancer les 3 via `Promise.all()` dans une seule fonction d'agent, et compter comme 1 seul job.

**F3 — Format de retour des agents** : Chaque agent SDD doit retourner `SDD_{PHASE}_{VERDICT}: ...` pour que `getCompletionKeyboard()` fonctionne. Les agents `.claude/agents/*.md` ne produisent pas ce format nativement. Le wrapper dans `sdd-flow.ts` doit parser le résultat brut et le préfixer.

**F4 — Taille du `sdd-flow.ts`** : Actuellement 245 LOC. Ajouter 5 fonctions d'agent (explore, spec, challenge, implement, review) avec prompt construction + parsing = environ 200-300 LOC supplémentaires. Le fichier resterait sous le seuil de 800 LOC si les fonctions d'agent sont extraites dans un module séparé (ex: `sdd-agents.ts`).

**F5 — Exploration.ts double chemin** : Après Phase 3, l'exploration peut être déclenchée par `/explore` (commande directe) ou par bouton `sdd_explore` (callback SDD). Les deux chemins doivent produire le même résultat mais avec un contexte différent (commande = query directe, SDD = conversation enrichie par handoff). Factoriser la logique commune.

### Actifs réutilisables

- **`exploreFn` dans exploration.ts** (L129-203) : Logique complète de construction de prompt + spawnClaude pour l'explorateur. Peut être extraite en fonction réutilisable.
- **`assembleHandoffContext()` + `formatHandoffForAgent()`** dans conversation-handoff.ts : Prêt à l'emploi pour injecter le contexte conversationnel dans les prompts d'agents.
- **`getCompletionKeyboard()`** dans job-manager.ts (L306-354) : Déjà implémenté pour tous les cas SDD. Pas de modification nécessaire.
- **Pattern `launch(jobType, chatId, agentFn, opts)`** dans job-manager.ts : Interface standard pour lancer un job background.
- **`updateStep()` + `formatStatusBar()`** dans pipeline-tracker.ts : API complète pour le suivi de progression.
- **`getRecentMessages()`** dans memory/core.ts : Source de messages récents pour le handoff.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Intégration incrémentale | C: Module sdd-agents.ts dédié | D: Plugin grammY conversations |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexité** (obligatoire) | S | M | M | L |
| **Valeur ajoutée** (obligatoire) | Low | High | High | High |
| **Risque technique** (obligatoire) | Low | Med | Low | High |
| *Impact maintenance* | Aucun — status quo | Moyen — logique répartie sur 3-4 fichiers | Faible — agents isolés dans un module | Haut — refonte du message handler |
| *Réversibilité* | N/A | Haute — chaque branchement est indépendant | Haute — module supprimable | Faible — refonte structurelle |

### Discussion par option

**A: Status quo** — Les modules Phase 2 existent mais ne sont pas connectés. Le pipeline SDD n'est pas fonctionnel. Pas de valeur ajoutée tant que l'intégration n'est pas faite. Sert uniquement de baseline pour mesurer l'effort des autres options.

**B: Intégration incrémentale** — Modifier `sdd-flow.ts` pour remplacer les placeholders par les vrais agents, ajouter l'instruction de convergence dans `buildPrompt()`, adapter `exploration.ts` pour créer le tracker. Avantage : chaque modification est petite et testable indépendamment. Inconvénient : la construction de prompts d'agents dans `sdd-flow.ts` risque de le faire grossir au-delà de 500 LOC, mêlant UI (boutons) et logique métier (prompts agents).

**C: Module sdd-agents.ts dédié** — Comme B, mais extraire toute la logique de construction de prompts et d'appels `spawnClaude()` dans un nouveau `src/sdd-agents.ts`. `sdd-flow.ts` reste un Composer léger (UI + routing de callbacks), `sdd-agents.ts` contient les fonctions `runExploreAgent()`, `runSpecAgent()`, `runChallengeAgents()`, `runImplementAgent()`, `runReviewAgent()`. Séparation propre UI/métier. Le Composer `sdd-flow.ts` appelle les fonctions de `sdd-agents.ts` dans les callbacks.

**D: Plugin grammY conversations** — Réécrire le flow SDD en utilisant `@grammyjs/conversations` avec `waitForCallbackQuery()`. Plus élégant structurellement mais nécessite une refonte profonde du message handler (`zz-messages.ts`), l'ajout de session storage pour le plugin, et une requalification complète des tests. Risque de régression élevé pour un gain marginal.

---

## Section 5 — Verdict et justification

**Verdict : GO** — Option C (module `sdd-agents.ts` dédié)

**Justification :**

L'Architecture V2 Phase 3 est la pièce manquante pour rendre le flow SDD fonctionnel. Les fondations Phase 2 sont solides et testées (`pipeline-tracker.ts`, `conversation-handoff.ts`, `sdd-flow.ts`), les points d'intégration sont clairement identifiés, et le risque est maîtrisable grâce à la séparation UI/métier.

L'option C est préférable à B car elle respecte la convention du projet (un module = une responsabilité), évite de faire grossir `sdd-flow.ts` au-delà du seuil 800 LOC, et facilite les tests unitaires (les fonctions d'agent sont testables indépendamment du Composer grammY). Le surcoût par rapport à B est minime (~20 LOC de structure supplémentaire).

L'option D est rejetée car le plugin `conversations` imposerait une refonte structurelle disproportionnée alors que le pattern actuel (callbacks manuels + guard) fonctionne et est cohérent avec les 9 autres Composers du projet.

Le point de friction F1 (spec-architect interactif) est résolu en injectant le handoff summary comme substitut à la Discovery Interview, ce qui est cohérent avec la vision V2 ("le résumé structuré est le pont entre conversation et agent"). Le point F2 (3 challengers) est résolu en les enveloppant dans un seul job. Le point F3 (format de retour) est résolu par un wrapper de parsing dans `sdd-agents.ts`.

L'état de l'art confirme que l'approche est standard (orchestration déterministe + agents bornés), et les sources externes valident le modèle SDD comme méthodologie production éprouvée.

---

## Section 6 — Input pour étape suivante

### Option recommandée : C — Module sdd-agents.ts dédié

### Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/sdd-agents.ts` | Créer | Fonctions d'agent SDD : `runExploreAgent()`, `runSpecAgent()`, `runChallengeAgents()`, `runImplementAgent()`, `runReviewAgent()` |
| `src/commands/sdd-flow.ts` | Modifier | Remplacer les placeholders par appels aux fonctions de `sdd-agents.ts` |
| `src/bot-context.ts` | Modifier | Ajouter instruction convergence dans `buildPrompt()` (~5 lignes) |
| `src/commands/exploration.ts` | Modifier | Ajouter `createPipeline()` à la création d'une exploration |
| `tests/unit/sdd-agents.test.ts` | Créer | Tests unitaires des fonctions d'agent |
| `tests/unit/sdd-flow.test.ts` | Modifier | Tests d'intégration callbacks → vrais agents (mockés) |
| `tests/unit/bot-context.test.ts` | Modifier | Test de l'instruction convergence dans le prompt |

### Contraintes identifiées

- **Convention de retour** : Chaque fonction d'agent dans `sdd-agents.ts` doit retourner une string préfixée `SDD_{PHASE}_{VERDICT}: ...` pour la compatibilité avec `getCompletionKeyboard()`
- **spec-architect sans interview** : Le prompt du spec-architect doit être adapté pour recevoir le handoff summary en lieu et place de l'interview interactive. Ajouter une section "CONTEXTE CONVERSATIONNEL" au prompt qui contient le `formatHandoffForAgent()` + l'artefact d'exploration
- **3 challengers = 1 job** : `runChallengeAgents()` doit lancer 3 `spawnClaude()` en `Promise.all()` et consolider les résultats dans un seul rapport. Un seul slot de job-manager consommé
- **exploration.ts double chemin** : Factoriser `exploreFn` en fonction exportable, appelée par `/explore` et par `runExploreAgent()` dans sdd-agents.ts
- **Instruction convergence** : Ajouter dans `buildPrompt()`, conditionné à la présence d'un pipeline tracker actif pour le chat courant (éviter de polluer les conversations normales)
- **Pas de modification de relay.ts** : Tout est déjà initialisé au startup

### Questions ouvertes à résoudre pendant l'implémentation

1. **Conditionner l'instruction convergence** : Faut-il toujours ajouter l'instruction "Decisions:" dans le prompt, ou seulement quand un pipeline SDD est actif pour le chat ? L'option "toujours" est plus simple mais pollue les conversations normales. L'option "conditionné" nécessite de passer le chatId/threadId à `buildPrompt()`.
2. **Consolidation du challenge** : Comment fusionner les 3 rapports adversariaux ? Option simple : concaténation avec séparateurs. Option élaborée : déduplications des findings similaires (nécessite un LLM call supplémentaire).
3. **Artefact d'implémentation** : `runImplementAgent()` doit-il créer la PR directement ou seulement les fichiers ? L'Architecture V2 dit "feature branch + commit + PR", ce qui implique `useWorktree: true` dans `spawnClaude()`.
