---
phase: 0-explore
generated_at: "2026-03-25T16:00:00Z"
subject: "Injection du contexte pipeline SDD dans le system prompt pendant la phase discuss"
verdict: GO
next_step: "dev-spec"
---

## Section 1 -- Probleme

Quand un pipeline SDD est actif et en phase "discuss", l'utilisateur envoie des messages texte qui sont traites par `zz-messages.ts`. Le handler `processMessageInput()` assemble un prompt via `bctx.buildPrompt()` qui inclut le contexte memoire, les messages recents, le profil dynamique, le contexte documents, et le topic Telegram -- mais **aucune information sur le pipeline SDD en cours**.

Consequence : Claude repond comme en conversation libre, sans savoir qu'un pipeline SDD est actif, quel est son nom, quelle phase est en cours, et quels artefacts ont deja ete produits. Il ne peut pas :
- Guider naturellement vers la formalisation en spec
- Faire reference aux decisions deja prises dans le pipeline
- Rappeler les contraintes identifiees lors de l'exploration
- Structurer ses reponses pour faciliter le handoff vers l'agent spec-architect

L'instruction "SDD CONVERGENCE" existante dans `buildPrompt()` (ligne 597 de `bot-context.ts`) dit a Claude de produire le format "Decisions: ..." quand la conversation converge, mais sans contexte pipeline, Claude ne sait pas *pourquoi* il devrait orienter vers des decisions, ni vers quelle spec il devrait guider.

L'exploration est necessaire car plusieurs approches sont envisageables (injection dans buildPrompt, middleware grammY, enrichissement du prompt dans zz-messages) avec des compromis differents en termes de couplage, performance, et maintenabilite.

---

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Context Engineering for LLM Apps](https://aishwaryasrinivasan.substack.com/p/context-engineering-for-llm-apps) | Article technique | 2026-03-25 | Patterns de context engineering : injection dynamique d'etat applicatif dans le system prompt, assemblage multi-sources, template library par workflow stage, "context as RAM" -- charger uniquement ce qui est necessaire pour la tache en cours. | Haute |
| 2 | [grammY Conversations Plugin](https://grammy.dev/plugins/conversations) | Doc officielle | 2026-03-25 | Plugin conversations grammY : gestion d'etat multi-messages via replay engine, `conversation.external()` pour acceder a l'etat externe, `ctx.conversation.active()` pour inspecter les conversations actives et router conditionnellement. Pattern de middleware conditionnel base sur l'etat. | Moyenne |
| 3 | [EXPLORE-integration-flow-conversationnel-sdd.md](../explorations/EXPLORE-integration-flow-conversationnel-sdd.md) | Exploration interne | 2026-03-24 | Exploration Phase 3 Architecture V2 : identifie deja que buildPrompt() n'instruit pas Claude sur le contexte pipeline, et recommande l'ajout de l'instruction SDD CONVERGENCE (qui a ete implementee). Mais ne couvre pas l'injection du contexte pipeline complet (nom, phase, artefacts). | Haute |

### Synthese des enseignements cles

**Context engineering** : L'article de reference etablit que le system prompt doit etre dynamique et reflecter l'etat applicatif courant. Le pattern recommande est un template avec sections conditionnelles : role + contraintes (statique) + etat courant (dynamique) + historique recent + outils disponibles. Le concept cle est "context as RAM" -- ne charger que ce qui est pertinent pour la tache en cours. Injecter le contexte pipeline SDD quand un pipeline est actif, ne rien injecter sinon.

**grammY conversations** : Le plugin offre un modele elegant de gestion d'etat multi-messages, mais son adoption imposerait une refonte du handler zz-messages.ts. Le pattern plus leger et applicable immediatement est la consultation d'etat via `getTracker()` dans le handler existant -- pattern deja utilise pour la detection de convergence (lignes 276-288 de zz-messages.ts).

**Precedent interne** : L'exploration EXPLORE-integration-flow-conversationnel-sdd.md a identifie le probleme (buildPrompt ne connait pas le pipeline) et a resolu la partie "convergence signal" via l'instruction SDD CONVERGENCE. Mais le contexte pipeline riche (nom, phase, artefacts, exploration ref) n'est toujours pas injecte. C'est une lacune restante de la Phase 3.

---

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/bot-context.ts` (buildPrompt, L531-622) | Assemble le prompt avec sections conditionnelles (topic, profile, memory, documents, SDD CONVERGENCE). Accepte deja un parametre `topicName` pour injection conditionnelle du topic context. Pattern reutilisable pour un parametre `pipelineContext`. 788 LOC -- sous le seuil 800. | Moyen |
| 2 | `src/commands/zz-messages.ts` (processMessageInput, L167-289) | Point d'injection principal. Appelle deja `getTracker()` en fin de pipeline (L276) pour la convergence. Le meme appel peut etre deplace en amont pour construire le contexte pipeline avant `buildPrompt()`. 687 LOC -- marge confortable sous le seuil 800. | Eleve |
| 3 | `src/pipeline-tracker.ts` (getTracker, formatStatusBar) | `getTracker(chatId, threadId)` retourne le PipelineTracker complet avec nom, phase en cours, artefacts. `formatStatusBar()` formate un resume texte. Pas de fonction dediee "format pour prompt" mais facile a ajouter. | Faible |
| 4 | `src/commands/sdd-flow.ts` (buildSddKeyboard, detectConvergenceInResponse) | Deja importe dans zz-messages.ts. Le couplage est etabli. | Aucun ajout |
| 5 | `src/conversation-handoff.ts` (formatHandoffForAgent) | Formate un HandoffSummary en texte structure pour injection dans un prompt agent. Pattern directement reutilisable comme modele pour formater le contexte pipeline. | Faible |
| 6 | `src/topic-config.ts` (getTopicConfig) | Precedent d'injection conditionnelle dans buildPrompt : si topicName est present, le config est charge et injecte. Meme pattern applicable pour le pipeline. | Aucun ajout |
| 7 | Interface `BotContext` (bot-context.ts L132-178) | La signature de `buildPrompt` a 7 parametres. En ajouter un 8e (`pipelineContext?: string`) resterait acceptable mais approche la limite de lisibilite. Alternative : passer un objet options. | Moyen |

### Points de friction

1. **Signature buildPrompt** : Deja 7 parametres positionnels. Un 8e parametre `pipelineContext?: string` est la solution la plus simple mais degrade la lisibilite. Une refactorisation vers un objet `BuildPromptOptions` serait plus propre mais touche l'interface BotContext et tous les appelants.

2. **Performance** : `getTracker()` est actuellement appele en fin de pipeline (apres callClaude) pour la convergence. Le deplacer en amont ajoute un await supplementaire, mais getTracker est une lookup en memoire (Map + loadPipelines qui est un no-op apres le premier load). Impact negligeable.

3. **Couplage zz-messages <-> pipeline-tracker** : L'import dynamique `await import("../pipeline-tracker.ts")` (L276) deviendrait un import statique en tete de fichier pour etre utilise en amont. Pas de circularite puisque pipeline-tracker n'importe rien de commands/.

### Actifs reutilisables

- Pattern d'injection conditionnelle dans `buildPrompt()` : deja fait pour topic context (L560-571), document context (L576-581), voice capabilities (L603-616). Le pipeline context suivrait le meme pattern.
- `formatStatusBar()` dans pipeline-tracker.ts : format texte existant, adaptable pour un "format prompt" plus concis.
- `formatHandoffForAgent()` dans conversation-handoff.ts : modele de formatage structure pour injection dans un prompt.
- Lookup `getTracker()` deja present dans zz-messages.ts (import dynamique L276).

---

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Injection dans buildPrompt | C: Enrichissement dans zz-messages | D: Middleware grammY dedie |
|---------|:------------:|:----------------------------:|:----------------------------------:|:-------------------------:|
| **Complexite** | S | M | S | L |
| **Valeur ajoutee** | Low | High | High | High |
| **Risque technique** | Low | Med | Low | High |
| *Impact maintenance* | Aucun | Signature buildPrompt evolue | Localise dans zz-messages | Nouveau module a maintenir |
| *Reversibilite* | N/A | Facile (supprimer le parametre) | Facile (supprimer le bloc) | Difficile (retirer le middleware) |

### Discussion des options

**A: Status quo** -- Ne rien faire. Claude continue de repondre sans conscience du pipeline SDD. La convergence detection fonctionne (quand Claude produit "Decisions:" par hasard ou par l'instruction generique), mais l'orientation vers la spec est absente. Pas de valeur ajoutee, mais zero risque.

**B: Injection dans buildPrompt via parametre supplementaire** -- Ajouter un 8e parametre `pipelineContext?: string` a `buildPrompt()` et l'injecter comme section conditionnelle (meme pattern que topic context). Le contexte serait assemble dans zz-messages.ts via `getTracker()` puis passe a buildPrompt. Avantage : centralise dans buildPrompt, beneficie a tout appelant futur. Inconvenient : la signature de buildPrompt devient longue (8 params). Risque moyen du a la modification de l'interface BotContext.

**C: Enrichissement dans zz-messages.ts avant l'appel a buildPrompt** -- Au lieu de modifier buildPrompt, construire le contexte pipeline dans `processMessageInput()` et le concatener au `memoryContext` ou au `relevantContext` existant avant l'appel a buildPrompt. Avantage : zero modification de buildPrompt/BotContext, changement localise. Inconvenient : le contexte pipeline est melange avec d'autres contextes, pas d'architecture claire. Reversible facilement.

**D: Middleware grammY dedie** -- Creer un middleware qui intercepte tous les messages, detecte la presence d'un pipeline actif, et enrichit `ctx` avec le contexte pipeline avant que zz-messages ne le traite. Inspirer du plugin conversations de grammY. Avantage : separation des responsabilites. Inconvenient : complexite elevee, nouveau module, necessiterait d'etendre le type Context de grammY, risque d'interactions imprevues avec les autres middlewares.

---

## Section 5 -- Verdict et justification

**Verdict : GO**

L'option **C (Enrichissement dans zz-messages.ts)** est recommandee, avec une evolution vers B a moyen terme si d'autres modules ont besoin du contexte pipeline.

Justification :

1. **Axe 1 (etat de l'art)** : Le pattern "context as RAM" recommande d'injecter dynamiquement l'etat applicatif pertinent dans le prompt. L'injection conditionnelle (uniquement quand un pipeline est actif) est exactement le pattern prescrit -- ne pas surcharger le contexte quand il n'y a pas de pipeline.

2. **Axe 2 (archeologie)** : Le codebase a deja tous les building blocks : `getTracker()` est appele dans zz-messages.ts, `formatStatusBar()` peut etre adapte, le pattern d'injection conditionnelle est deja utilise 4 fois dans `buildPrompt()`. Le changement est minimal (~20-30 lignes) et localise dans un seul fichier.

3. **Axe 3 (matrice)** : L'option C offre la meilleure balance complexite/valeur/risque. Complexite S, valeur High, risque Low. Entierement reversible. Ne modifie pas l'interface BotContext, ne casse pas les tests existants, reste sous le seuil 800 LOC pour zz-messages.ts.

L'option B serait un meilleur choix architectural a long terme, mais elle impose une modification de la signature de buildPrompt et de l'interface BotContext. Si d'autres consumers (ex: heartbeat, notifications) ont besoin du contexte pipeline plus tard, un ticket de refactoring buildPrompt vers un objet options sera justifie a ce moment-la.

---

## Section 6 -- Input pour etape suivante

### Option recommandee : C -- Enrichissement dans zz-messages.ts

### Fichiers concernes
- `src/commands/zz-messages.ts` -- modification principale (~20-30 lignes)
- `src/pipeline-tracker.ts` -- ajout d'une fonction `formatPipelineContextForPrompt()` (~15-20 lignes)
- Tests associes dans `tests/`

### Design en quelques lignes

1. **Dans `pipeline-tracker.ts`**, ajouter une fonction exportee :
```
formatPipelineContextForPrompt(tracker: PipelineTracker): string
```
Qui retourne un bloc texte type :
```
PIPELINE SDD ACTIF: "nom-du-pipeline"
Phase en cours: discuss
Artefacts produits: EXPLORE-nom.md (explore: OK)
Objectif: guider la discussion vers des decisions formalisables en spec.
Quand la conversation converge sur des decisions claires, utilise le format "Decisions: ..."
```

2. **Dans `zz-messages.ts` (processMessageInput)**, deplacer l'appel `getTracker()` en amont (avant l'assemblage du prompt), et si un tracker est actif avec la phase "discuss" (ou toute phase conversationnelle), concatener le contexte pipeline au `memoryContext` passe a `buildPrompt()`.

3. **Transformer l'import dynamique** `await import("../pipeline-tracker.ts")` (L276) en import statique en tete de fichier, puisqu'il sera utilise en amont aussi.

### Contraintes identifiees
- Ne pas depasser 800 LOC dans zz-messages.ts (actuellement 687, marge de ~113 lignes)
- Ne pas depasser 800 LOC dans pipeline-tracker.ts (actuellement 300, marge confortable)
- Pas de modification de l'interface BotContext ni de la signature de buildPrompt
- Pas de nouvelle dependance entre modules (pipeline-tracker est deja importe dans zz-messages)
- Le contexte pipeline doit etre injecte uniquement quand un pipeline est actif (pas de bruit quand il n'y en a pas)
- L'instruction SDD CONVERGENCE existante dans buildPrompt (L597) reste en place -- le contexte pipeline la renforce, ne la remplace pas

### Questions ouvertes a resoudre pendant la spec
- Faut-il injecter le contexte pipeline pour toutes les phases (explore, discuss, spec...) ou seulement pendant "discuss" et "explore" ?
- Faut-il inclure le contenu resume de l'artefact d'exploration (si disponible) dans le contexte pipeline, ou juste la reference au fichier ?
- Le format du contexte pipeline doit-il etre en francais (coherent avec le system prompt) ou en anglais (coherent avec les autres instructions buildPrompt) ?
- Faut-il ajouter des instructions specifiques par phase (ex: pendant discuss -> "guide vers spec", pendant review -> "resume les findings") ?
