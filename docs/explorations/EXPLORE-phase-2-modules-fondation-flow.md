---
phase: 0-explore
generated_at: "2026-03-24T10:45:00Z"
subject: "Phase 2 Architecture V2 — Modules fondation du flow conversationnel avec boutons"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

L'Architecture V2 (docs/ARCHITECTURE-V2.md) vise à transformer le bot d'un orchestrateur SDLC rigide (34K LOC, 37 commandes) en un **assistant conversationnel** qui déclenche des agents Claude Code via des boutons InlineKeyboard. La Phase 2 en est la fondation technique : sans elle, les Phases 3 à 6 ne peuvent pas s'appuyer sur des abstractions stables.

Trois composants doivent être créés :

1. **`pipeline-tracker.ts`** — Suivi de l'état du pipeline SDD (Exploration → Discussion → Spec → Challenge → Implémentation → Review) par chat, avec persistence disque et affichage status bar plain-text. Remplace `pipeline-state.ts` (dépendant du module `orchestrator/` qui sera supprimé en Phase 4).

2. **`conversation-handoff.ts`** — Extraction d'un résumé structuré des décisions prises en conversation, via `callClaude`, pour le passer en input aux agents background. C'est le **pont critique** entre le canal conversation (éphémère) et le canal agents (persistent).

3. **Boutons InlineKeyboard dans `zz-messages.ts`** — Callbacks `sdd_*` qui lancent les agents (Explorer, Spec-architect, Devils-advocate × 3, Implementer) en background via `job-manager.ts`, avec génération de claviers contextuels selon la phase courante et le verdict de l'étape précédente.

L'exploration est nécessaire car ces trois composants s'articulent autour d'une couche existante complexe (909 LOC dans `zz-messages.ts`, mutex `callClaude`, pattern de persistence disque établi), et la Phase 1 (nettoyage code mort) n'est pas encore effectuée, créant des dépendances enchevêtrées à prendre en compte.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://grammy.dev/plugins/keyboard | Doc officielle | 2026-03-24 | Patterns InlineKeyboard grammY : création objet/fonctionnel, callback_query handlers, `answerCallbackQuery`, best practice catch-all handler | Haute |
| 2 | https://dev.to/madhead/two-design-patterns-for-telegram-bots-59f5 | Article | 2026-03-24 | 2 patterns : Chain of Responsibility (handlers séquentiels) + FSM (états, transitions, persistence serveur). Recommande de combiner les deux. | Haute |
| 3 | https://openai.github.io/openai-agents-python/handoffs/ | Doc SDK | 2026-03-24 | Structure handoff : `input_history`, `pre_handoff_items`, `input_filter`. Recommande de collapser le transcript en résumé assistant pour éviter confusion. `nest_handoff_history` plie le transcript précédent en un seul message. | Haute |
| 4 | https://jtanruan.medium.com/context-engineering-in-llm-based-agents-d670d6b439bc | Article | 2026-03-24 | Context engineering : Working context / Memory / Artifacts. Pour les handoffs inter-agents : préférer un résumé LLM au transcript brut (tokens + confusion réduits). | Moyenne |

### Synthèse des enseignements clés

**Sur les boutons InlineKeyboard grammY** : Le pattern recommandé est la séparation claire entre données label et données callback (préfixe + payload). La documentation insiste sur un handler catch-all `bot.on("callback_query:data")` en fin de chaîne pour éviter l'animation loading 60s côté client. Dans un Composer grammY multi-modules, chaque Composer définit son propre `composer.on("callback_query:data")` avec un guard de préfixe et appelle `next()` si non concerné — c'est le pattern déjà utilisé dans les 9 fichiers du projet.

**Sur la persistence d'état pipeline** : Le pattern FSM avec persistence serveur est le pattern dominant pour les bots multi-étapes. L'état doit survivre aux redémarrages (`pipeline-state.ts` utilisait Supabase ; le nouveau `pipeline-tracker.ts` ciblera le disque local pour être léger et autonome, aligné avec `job-manager.ts` et `conversation-session.ts`). Le pattern atomic write (tmp → rename) est la convention robuste pour éviter la corruption.

**Sur le handoff conversation → agent** : La recommandation de l'écosystème agents (OpenAI SDK, Context Engineering) est unanime : ne pas passer le transcript brut, mais un résumé LLM structuré. Les champs canoniques sont : objectif, décisions, contraintes, fichiers identifiés, questions résolues, hors-scope. Ce résumé sert de "mémoire courte portable" pour l'agent qui n'a pas accès à la session de conversation.

**Sur la détection de convergence** : Aucun framework ne fournit cette feature out-of-the-box. L'approche la plus légère est de détecter dans la réponse de Claude des marqueurs sémantiques ("on est d'accord", "je note comme décision") plutôt qu'un LLM call supplémentaire — à confirmer en spec.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/pipeline-state.ts` (259 LOC) | Modèle de données `PipelineState` utilise `AgentRole` et `AgentMessage` de `orchestrator.ts` (supprimé en Phase 4). Persistence via Supabase `pipeline_runs`. Pattern: create/save/load/update. | Haut — à remplacer sans ses dépendances vers l'orchestrateur |
| 2 | `src/job-manager.ts` (589 LOC) | Pattern de persistence disque (atomic write tmp→rename), semaphore, `getCompletionKeyboard()`, `InlineKeyboard` post-completion. `launch()` retourne jobId immédiatement. | Haut — modèle direct pour pipeline-tracker et pour les callbacks post-agent |
| 3 | `src/conversation-session.ts` (100+ LOC, TTL 2h) | Types `ConversationSession`, `SessionDecision`, `DetectedConstraint`, `PendingProposal`. Persistence JSON sur disque. L'architecture V2 marque ce module "Supprimé" mais ses types sont nécessaires à `conversation-handoff.ts`. | Haut — types à migrer ou réutiliser |
| 4 | `src/commands/zz-messages.ts` (909 LOC) | Handler `callback_query:data` pour préfixe `intent_`. `processMessageInput()` gère la session, intent detection, PRD workflow, fallback conversation. Déjà au-dessus du seuil 800 LOC. | Très haut — modification principale, risque de régression |
| 5 | `src/bot-context.ts` (`callClaude`) | Mutex sérialisé (une seule instance Claude à la fois). Queue FIFO. `callClaude` prend 5-30s. Heartbeat toutes les 2min. | Moyen — extraction handoff consomme un slot du mutex |
| 6 | `src/commands/jobs.ts` + `src/job-manager.ts` | Pattern callback `job_status:{jobId}`, `jc_done:{taskId}`, `jc_backlog`, `jc_batch_retry:{jobId}`. Tous utilisent le même Composer.on avec guard préfixe + next(). | Haut — modèle exact à répliquer pour callbacks `sdd_*` |
| 7 | `src/commands/exploration.ts` (229 LOC) | `launchJob("explore", chatId, exploreFn, {messageThreadId})` via `isJobManagerEnabled()`. Confirmation "Job lancé explore (id: …)". Candidat à adapter pour déclencher via bouton plutôt que commande. | Haut — lancement Explorer via bouton [Explorer] |
| 8 | `src/prd-workflow.ts` | `buildRevisionKeyboard()`, `buildTriageResponse()` — patterns de construction de keyboards contextuels selon état. `storePendingDescription()` — mini-pattern de pont conversation→agent. | Moyen — patterns réutilisables pour construction keyboard SDD |
| 9 | `src/relay.ts` | `initSessions()`, `initJobManager(bot)` appelés au startup. Tout nouveau module avec init doit être enregistré ici. | Moyen — pipeline-tracker nécessitera un `initPipelineTracker()` ou chargement lazy |
| 10 | `src/agent.ts` (`spawnClaude`) | API: `{ prompt, systemPrompt, model, effort, useWorktree, mcpRole }`. Retourne `{ stdout, stderr, exitCode }`. C'est la fonction que `conversation-handoff.ts` déclenchera indirectement via job-manager. | Moyen — interface stable |

### Points de friction identifiés

**F1 — Dépendances enchevêtrées dans zz-messages.ts avant Phase 1** : `zz-messages.ts` importe `prd-workflow.ts`, `prd.ts`, `command-router.ts`, `conversation-session.ts` — tous destinés à être supprimés ou simplifiés. Ajouter les boutons SDD avant la Phase 1 crée un fichier encore plus dense avec des imports morts. Risque de régression lors du nettoyage Phase 1.

**F2 — conversation-session.ts marqué "Supprimé" mais types nécessaires** : `conversation-handoff.ts` a besoin des types `DetectedConstraint`, `SessionDecision`, et de l'accès aux `recentMessages` de la session courante. Il faudra soit garder les types dans un module léger, soit les redéfinir dans `conversation-handoff.ts`.

**F3 — callClaude mutex et latence extraction** : L'extraction du handoff (`callClaude` pour résumer la conversation) consomme le mutex sérialisé. Si un message utilisateur arrive pendant l'extraction, il sera mis en queue. Ce blocage est court (~5s) mais visible.

**F4 — zz-messages.ts à 909 LOC** : Ajouter les boutons SDD (handler callback, `buildSddKeyboard`, logique de convergence) va dépasser significativement les 1000 LOC. Un refactoring en sous-modules (par exemple `commands/sdd-flow.ts`) devrait être planifié dans cette phase ou explicitement déféré.

**F5 — Boutons SDD dans messages anciens après redémarrage** : Les messages Telegram avec `reply_markup` persistent dans l'interface client. Un bouton cliqué sur un message de 3 jours déclenchera le callback — le pipeline-tracker doit gérer les pipelines expiré/inconnus gracieusement (réponse "Pipeline expiré, relancez via /dev-explore").

### Actifs réutilisables

- **Pattern persistence disque** (job-manager.ts + conversation-session.ts) : atomic write tmp→rename, `RELAY_DIR`, graceful degradation si IO échoue.
- **Pattern callback avec next()** : guard préfixe + `next()` pour la chaîne de middleware grammY.
- **`getCompletionKeyboard(job)`** dans job-manager.ts : modèle pour `buildSddKeyboard(phase, name, verdict)`.
- **Types `SessionDecision`, `DetectedConstraint`** dans conversation-session.ts : réutilisables tel quel dans handoff.
- **`buildEnrichedDescription(rawDesc, session)`** dans prd-workflow.ts : pattern pour enrichir un input avec le contexte de session — quasi identique à ce que fera `extractHandoffSummary`.
- **`launchJob("explore", chatId, fn, opts)`** dans exploration.ts : pattern de lancement agent, directement extensible aux autres agents SDD.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: 3 modules indépendants (V2) | C: Module unifié sdd-flow.ts | D: Étendre job-manager.ts |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexité** | S | M | M | M |
| **Valeur ajoutée** | Low | High | High | Med |
| **Risque technique** | Low | Med | Med | High |
| *Impact maintenance* | Neutre | Faible (séparation claire) | Moyen (module plus large) | Fort (job-manager déjà complexe) |
| *Réversibilité* | Totale | Bonne | Bonne | Difficile |

**Option A — Status quo** : Ne pas créer ces modules, garder les commandes texte uniquement. L'Architecture V2 reste un document sans implémentation. Valeur nulle : le flow conversationnel avec boutons est le cœur de la V2.

**Option B — 3 modules indépendants** (recommandée dans ARCHITECTURE-V2.md) : `pipeline-tracker.ts` (~100 LOC), `conversation-handoff.ts` (~80 LOC), boutons dans `zz-messages.ts` (~80 LOC supplémentaires). Séparation des responsabilités claire : état/persistence, LLM extraction, UI/callbacks. Chaque module peut être testé indépendamment. Complexité M mais bien bornée (~260 LOC total, dans la fourchette 200-300 LOC annoncée dans l'architecture).

**Option C — Module unifié `commands/sdd-flow.ts`** : Regroupe le tracker, le handoff, et les callbacks dans un seul fichier. Évite d'éparpiller la logique SDD dans plusieurs modules. Risque : fort couplage interne, difficile à tester unitairement, et va à l'encontre des conventions de découpe du projet (Composers séparés par domaine).

**Option D — Étendre `job-manager.ts`** : Ajouter le tracking de pipeline SDD directement dans job-manager (qui gère déjà les jobs background). Évite un nouveau fichier. Risque fort : job-manager est déjà à 589 LOC, son rôle est générique (tous types de jobs), le coupler avec la logique SDD spécifique crée une dette technique immédiate. Le `Job` interface devrait être étendu avec des champs SDD-spécifiques.

---

## Section 5 — Verdict et justification

**Verdict : GO** — Option B (3 modules indépendants)

**Justification :**

Les sources externes (axe 1) confirment que le pattern FSM avec persistence disque et le pattern de résumé structuré pour les handoffs sont des approches éprouvées. Le codebase (axe 2) dispose de tous les actifs nécessaires : pattern persistence (job-manager.ts, conversation-session.ts), pattern callback grammY (9 fichiers existants), pattern lancement agent background (exploration.ts), types réutilisables (conversation-session.ts).

La complexité est bien bornée : l'architecture annonce 200-300 LOC total, ce qui est cohérent avec l'analyse (pipeline-tracker ≈ 100 LOC, conversation-handoff ≈ 80 LOC, extensions zz-messages ≈ 80 LOC). Aucune nouvelle dépendance externe n'est nécessaire — tout repose sur grammY, Bun, et les modules internes existants.

Les risques identifiés (F1 à F5) sont réels mais gérables en spec : F1 (Phase 1 non faite) se résout en séquençant les phases correctement ou en isolant les nouveaux imports ; F2 (types conversation-session) se résout en gardant un stub de types ; F3 (mutex callClaude) est acceptable pour une extraction de 5s ; F4 (taille zz-messages) doit être traité explicitement en spec ; F5 (boutons anciens) se résout avec un guard TTL dans pipeline-tracker.

L'option B est la seule qui maintient la séparation des responsabilités, s'aligne avec les conventions du projet, et est testable indépendamment. La valeur ajoutée est haute : ces 3 modules sont le prérequis bloquant pour les Phases 3-5 de l'Architecture V2.

---

## Section 6 — Input pour étape suivante

### Option recommandée : B (3 modules indépendants)

### Fichiers à créer

- `src/pipeline-tracker.ts` — nouveau module (~100 LOC)
- `src/conversation-handoff.ts` — nouveau module (~80 LOC)

### Fichiers à modifier

- `src/commands/zz-messages.ts` — ajouter handler `sdd_*`, `buildSddKeyboard()`, détection convergence (~80 LOC)
- `src/relay.ts` — enregistrer éventuellement un `initPipelineTracker()` si nécessaire
- `src/job-manager.ts` — ajouter case `'explore'`, `'spec'`, `'challenge'`, `'implement'` dans `getCompletionKeyboard()`

### Interface proposée pour pipeline-tracker.ts

```typescript
type SddPhase = 'explore' | 'discuss' | 'spec' | 'challenge' | 'implement' | 'review';
type StepStatus = 'pending' | 'running' | 'ok' | 'failed';

interface PipelineStep {
  phase: SddPhase;
  status: StepStatus;
  artifact?: string;   // ex: "docs/explorations/EXPLORE-refactoring-memoire.md"
  summary?: string;    // ex: "GO — 3 alternatives, verdict GO"
  jobId?: string;      // référence job-manager pour corrélation
  startedAt?: string;
  completedAt?: string;
}

interface PipelineTracker {
  chatId: number;
  threadId?: number;
  name: string;        // kebab-case, ex: "refactoring-memoire"
  steps: Record<SddPhase, PipelineStep>;
  createdAt: string;
  updatedAt: string;
}

// API publique
export async function createPipeline(chatId: number, threadId: number | undefined, name: string): Promise<PipelineTracker>
export async function updateStep(chatId: number, threadId: number | undefined, phase: SddPhase, updates: Partial<PipelineStep>): Promise<void>
export async function getTracker(chatId: number, threadId?: number): Promise<PipelineTracker | null>
export function formatStatusBar(tracker: PipelineTracker): string
export function _clearForTests(): void
```

Persistence : `RELAY_DIR/pipelines.json`, atomic write, TTL 7 jours, clé `${chatId}:${threadId ?? 'main'}`.

### Interface proposée pour conversation-handoff.ts

```typescript
interface HandoffSummary {
  objective: string;
  decisions: string[];
  constraints: string[];
  filesIdentified: string[];
  resolvedQuestions: string[];
  outOfScope: string[];
  explorationRef?: string;  // chemin EXPLORE-{name}.md si disponible
  specRef?: string;         // chemin SPEC-{name}.md si disponible
}

export async function extractHandoffSummary(
  callClaude: (prompt: string) => Promise<string>,
  conversationHistory: string,   // recentMessages formatés
  options?: { explorationRef?: string; specRef?: string }
): Promise<HandoffSummary>

export function formatHandoffForAgent(summary: HandoffSummary): string
```

Le prompt d'extraction doit être court et déterministe (< 200 tokens input, JSON forcé), sans `resume` pour éviter la contamination du contexte de session.

### Contraintes identifiées pour la spec

1. **Sequençage** : Pipeline-tracker et conversation-handoff ne doivent pas importer de modules marqués "Supprimés" dans l'Architecture V2 (`orchestrator/`, `blackboard.ts`, `agent-schemas.ts`, etc.).
2. **Taille zz-messages.ts** : La spec doit décider explicitement si les boutons SDD sont dans `zz-messages.ts` ou dans un nouveau `commands/sdd-flow.ts` (Composer séparé, plus propre).
3. **Callbacks SDD et état stale** : Le handler `sdd_*` doit vérifier via `getTracker()` que le pipeline est connu et non expiré avant de lancer un agent.
4. **Tests** : Pipeline-tracker et conversation-handoff doivent avoir des tests unitaires complets avec `_clearForTests()`. Les callbacks `sdd_*` dans zz-messages doivent être testés avec des `callback_query` mocks (pattern existant dans `tests/unit/zz-messages-document.test.ts`).
5. **Mutex callClaude** : L'extraction handoff ne doit pas utiliser `resume: true` pour ne pas contaminer la session de conversation principale.

### Questions ouvertes à résoudre pendant la spec

- **Q1** : Faut-il garder `conversation-session.ts` comme module de types uniquement, ou redéfinir les types dans `conversation-handoff.ts` ?
- **Q2** : Les boutons SDD dans `zz-messages.ts` ou dans un nouveau `commands/sdd-flow.ts` Composer ?
- **Q3** : Comment le bot sait-il quel `name` de pipeline associer à une conversation ? Proposer un mécanisme simple (hashé à partir du premier message + timestamp ? saisi par l'utilisateur ? extrait par LLM ?).
- **Q4** : La détection de convergence se fait-elle par regex sur la réponse Claude (comme `PROPOSAL_PATTERNS`) ou par LLM call supplémentaire ?
- **Q5** : Faut-il une commande de reprise `/dev-pipeline --status` qui affiche la status bar sans lancer de job ?
