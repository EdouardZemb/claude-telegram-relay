# Adversarial Review — SPEC-modules-fondation-flow-sdd

> Date : 2026-03-24
> Spec source : docs/specs/SPEC-modules-fondation-flow-sdd.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic
> Cycle : 1 (premiere review, spec non encore implementee)

---

## Synthese

| Agent | BLOQUANT | MAJEUR | MINEUR | Total |
|-------|----------|--------|--------|-------|
| Devil's Advocate | 1 | 3 | 2 | 6 |
| Edge Case Hunter | 1 | 3 | 2 | 6 |
| Simplicity Skeptic | 0 | 3 | 2 | 5 |
| **Total (deduplique)** | **1** | **7** | **4** | **12** |

**Verdict : GO WITH CHANGES**

Justification : 1 BLOQUANT identifie (incoherence architecturale entre R7 et la realite du mutex `callClaude` — appeler `callClaude` depuis un agent background casse le design). 7 MAJEURS, dont plusieurs revelent des zones d'ombre importantes : concurrence write/read sur `pipelines.json`, absence du `discuss` dans les callbacks SDD, et coordination non specifiee entre `buildSddKeyboard` et `getCompletionKeyboard`. Les corrections requises sont claires et n'imposent pas de refonte de l'architecture.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — R7 suppose que `callClaude` peut etre appele hors du thread principal**
- Source : Section 2, R7 ("R7 — `extractHandoffSummary()` appelle `callClaude` sans `resume: true`") ; Section 3, ligne "Conversation courante (handoff)" ; Section 7 contrainte "callClaude dans extractHandoffSummary : pas de `resume: true`"
- Description : `callClaude` dans `bot-context.ts` est un mutex serialise : une seule instance Claude a la fois, avec queue FIFO (`claudeBusy`, `claudeQueue`). `extractHandoffSummary()` est appele depuis le handler `sdd_spec` du Composer `sdd-flow.ts`, qui est lui-meme declenche par un callback Telegram pendant la conversation active. Mais la spec definit `conversation-handoff.ts` comme une entite standalone qui recoit `callClaude` comme parametre (Section 7 dependances : "src/bot-context.ts : BotContext, callClaude signature — stable"). Le probleme : ce `callClaude` est une closure sur l'etat `session.sessionId` dans `bot-context.ts`. L'appeler avec `resume: false` (Decision Q1) ne corrompt pas la session mais **bloque** tous les autres messages Telegram entrants pendant 5-30s dans le handler de callback. Ce blocage est pire que dans la conversation normale car il intervient pendant le traitement d'un callback (non-interruptible dans grammY). La spec note le probleme en exploration (F3 de EXPLORE-phase-2) mais n'en tire aucune regle ou contrainte explicite.
- Impact : Blocage de l'interface utilisateur pendant 5-30s a chaque click sur [Formaliser en spec]. Aucun message entrant ne peut etre traite. Si l'extraction echoue (timeout Claude), le callback reste bloque sans recuperation specifiee.
- Evidence : `src/bot-context.ts:203-310` — mutex `claudeBusy` avec queue. `src/bot-context.ts:298-311` — `callClaude` est serialise. Exploration F3 : "L'extraction du handoff (`callClaude`) consomme le mutex seriaise. Si un message utilisateur arrive pendant l'extraction, il sera mis en queue. Ce blocage est court (~5s) mais visible."

**[MAJEUR] F-DA-2 — R10 : regex `/^Decisions:/m` ecrit dans la spec ne correspond pas a l'exemple donne**
- Source : Section 2, R10 ; Section 8, V19 ("detectConvergenceInResponse retourne non-null quand la reponse Claude contient `\nDecisions:`")
- Description : R10 dit que le system prompt instruite Claude de produire "Decisions: ...\nProchaine etape: ..." quand la conversation converge, et donne comme regex `/^Decisions:/m`. V19 valide contre `\nDecisions:` (avec antislash-n). Ces deux patterns sont incoherents : `^Decisions:` (avec flag `m`) matche en debut de ligne, `\nDecisions:` matche explicitement un newline avant le mot. Un test V19 ecrit sur `\nDecisions:` passerait mais une implementation utilisant `^Decisions:` et flag `m` se comporterait differemment sur une reponse commencant directement par "Decisions:". De plus, la spec ne definit pas le pattern exact ni les flags — R10 donne `/^Decisions:/m` comme exemple mais Section 4 dit seulement "Regex: /^Decisions:/m sur la reponse Claude", laissant V19 avec un pattern different.
- Impact : Incoherence spec-criteres qui peut produire un test passant mais une implementation incorrecte. Un faux positif ou faux negatif selon la version du regex implementee.

**[MAJEUR] F-DA-3 — Absence de regle pour le callback `sdd_discuss` alors qu'il est utilise dans les boutons**
- Source : Section 2, R13 ("Les callbacks `sdd_explore`, `sdd_spec`, `sdd_challenge`, `sdd_implement`, `sdd_review` lancent les agents...") ; Section 4, `buildSddKeyboard` regles phase 'explore'
- Description : La Section 4 decrit explicitement le bouton "Discuter sans explorer" → callback `sdd_discuss:{name}` en phase 'explore', et "Post-exploration verdict GO : [Discuter les resultats]". Ces boutons produisent des callbacks `sdd_discuss:*`. Mais R13 liste seulement `sdd_explore`, `sdd_spec`, `sdd_challenge`, `sdd_implement`, `sdd_review` — aucun `sdd_discuss`. Que fait le Composer quand il recoit `sdd_discuss:{name}` ? Aucune regle ne le specifie. Le prefixe `sdd_` sera matche par le guard R9, mais l'action resultante est indeterminee (probablement tomber dans un `default` non gere).
- Impact : Les boutons [Discuter les resultats] et [Discuter sans explorer] — les deux premiers boutons avec lesquels l'utilisateur interagit — ne produiraient aucune action specifiee. L'UX de la phase initiale est brisee.

**[MAJEUR] F-DA-4 — R16 interdit `pipeline-state.ts` mais R12 exige de copier son pattern exactement**
- Source : Section 2, R12 ("Le pattern etabli : _clearMemoryStore dans pipeline-state.ts") ; Section 2, R16 ("pipeline-tracker.ts ne doit importer aucun module marque Supprime, comme pipeline-state.ts")
- Description : R16 interdit d'importer `pipeline-state.ts`. R12 cite `pipeline-state.ts` comme modele de reference pour `_clearForTests()`. La tension n'est pas une contradiction — la spec dit "copier le pattern", pas "importer" — mais le libelle de R12 cite la "ligne 43" de `pipeline-state.ts` comme reference. Si un implementeur lit R12 rapidement, il peut interpreter "pattern etabli" comme permission d'importer. La spec devrait clarifier explicitement que le pattern est a copier, pas a importer. Par ailleurs, la spec cite V9 : "_clearForTests() vide le store in-memory et force un reload depuis disque au prochain getTracker()". Mais `pipeline-state.ts:_clearMemoryStore()` NE force PAS le reload depuis disque — elle se contente de vider la map. La spec requiert un comportement plus riche que le pattern cite.
- Impact : Confusion possible pour l'implementeur. V9 exige un comportement (`force reload disk`) non present dans le pattern reference, ce qui peut resulter en une implementation incomplete.

**[MINEUR] F-DA-5 — R8 : "< 200 tokens input" est une contrainte non verifiable par les criteres de validation**
- Source : Section 2, R8 ("Le prompt d'extraction handoff est compact (< 200 tokens input)") ; Section 8, criteres V10-V12
- Description : V10 valide que `extractHandoffSummary` avec un mock LLM retourne un `HandoffSummary`. V11 valide la robustesse JSON. V12 valide le format de `formatHandoffForAgent`. Aucun V-critere ne verifie que le prompt envoye est < 200 tokens. La contrainte R8 n'a pas de critere de validation correspondant — c'est une regle sans test.

**[MINEUR] F-DA-6 — Decision Q1 : la justification "< 20 LOC" pour les types copies est subjective**
- Source : Section 9, A1 ("les 3 types utiles sont simples et se redefinissent en < 20 LOC")
- Description : La justification de la Decision Q1 (redefinir les types dans `conversation-handoff.ts` plutot qu'importer de `conversation-session.ts`) cite "< 20 LOC" mais n'identifie pas les 3 types. `conversation-session.ts` contient `DetectedConstraint`, `SessionDecision`, `IntentEntry`, `PendingProposal`, `ConversationSession` — 5+ types, certains complexes (ex: `ConversationSession` avec 8 champs). Si l'implementeur a besoin de plus que les 3 types cites, il peut etre tente d'importer le module marque "Supprime". La spec ne liste pas quels types exactement sont a copier.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — Corruption possible de `pipelines.json` si deux callbacks SDD se declenchent simultanement**
- Scenario : L'utilisateur a deux clients Telegram ouverts (mobile + desktop) et clique sur [Explorer] depuis les deux en moins de 100ms. Deux callbacks `sdd_explore:{name}` arrivent dans grammY. Les deux handlers appellent `createPipeline()` puis `savePipelines()` (atomic write). La persistence atomic write `tmp → rename` protege contre la corruption lors d'une ecriture unique, mais si les deux executions sont interleaved (lecture-modification-ecriture-lecture-modification-ecriture), la seconde ecriture peut ecraser la premiere sans voir ses changements. La spec ne mentionne aucun mutex ou lock au niveau du fichier `pipelines.json`, alors que `job-manager.ts` a le meme pattern et souffre du meme probleme (accepte en silence dans le codebase existant).
- Source : Section 2, R5 ("persistence utilise atomic write (tmp → rename)") ; Section 6, Pattern 1 ; Section 7 "Semaphore job-manager : max 3 jobs concurrents"
- Impact : Perte silencieuse d'un tracker de pipeline lors d'un double-click ou usage multi-client. L'utilisateur clique [Explorer], le job part, mais `pipelines.json` ne contient que le second tracker. Le premier est perdu.
- Frequence estimee : rare en usage solo, occasionnel avec multi-device

**[MAJEUR] F-EC-2 — `getTracker()` apres `createPipeline()` peut retourner null si RELAY_DIR n'existe pas**
- Scenario : Premier demarrage, `RELAY_DIR` n'existe pas encore. `createPipeline()` appelle `savePipelines()` qui appelle `mkdir(RELAY_DIR, { recursive: true })` avant l'ecriture. Mais si le `mkdir` echoue silencieusement (permissions), le fichier `pipelines.json` n'est pas cree. L'etat est en memoire. Un restart immediat du bot avant la prochaine sauvegarde perd le tracker. La spec dit "En cas d'echec IO, degrader gracieusement (log.error, ne pas propager)" (R5), ce qui est correct, mais le critere V8 ("Persistence disque : createPipeline() puis _clearForTests() puis getTracker() charge depuis le fichier disque") passera en test (RELAY_DIR existe dans les tests) mais silhouera le cas reel de premier demarrage.
- Source : Section 2, R5 ; Section 8, V8
- Impact : V8 donne une fausse confiance : le round-trip est verifie en conditions normales mais pas sur un systeme ou RELAY_DIR est absent ou non-writable.
- Frequence estimee : rare (premier demarrage ou probleme permissions)

**[MAJEUR] F-EC-3 — Le format du callback data `sdd_{etape}:{name}` est ambigu si le nom contient ":"**
- Scenario : Un nom de pipeline derive par R1 ne peut pas contenir ":" car la normalisation kebab-case supprime les non-alphanum. Mais qu'advient-il si l'utilisateur tape une description comme "Port 8080:9090 redirect" ? R1 dit "strip non-alphanum" → "port-8080-9090-redirect". Pas de probleme ici. Mais si le nom est passe via un autre mecanisme (reprise depuis fichier artefact dont le nom est `EXPLORE-foo:bar.md` par exemple), le split `data.split(":")` produira `["sdd_spec", "foo", "bar"]` et `name` sera "foo" avec "bar" perdu. La spec ne specifie pas comment parser le `name` depuis le callback data quand le `split(":")` produit plus de 2 elements.
- Source : Section 3 ("Prefixe "sdd_", format "sdd_{etape}:{name}"") ; Section 4, `buildSddKeyboard`
- Impact : Parsing incorrect du nom de pipeline si le nom contient un ":". Le tracker lookup echoue, le callback produit "Pipeline inconnu" a tort.
- Frequence estimee : occasionnel si les noms de fichiers artefacts sont passes tels quels

**[MAJEUR] F-EC-4 — Absence de comportement specifie pour `updateStep()` sur une phase inconnue**
- Scenario : Un agent SDD (ex: explore) termine et appelle `updateStep(chatId, threadId, 'explore', newStatus)`. Que se passe-t-il si le tracker n'existe plus (expire entre le lancement et la completion) ? La spec definit `getTracker()` retourne `null` si expire (R4), mais ne specifie pas le comportement de `updateStep()` quand le tracker est absent. L'agent qui a tourne pendant 5 minutes ne peut pas mettre a jour l'etat — le status bar reste "EN COURS" indefiniment. De plus, la spec ne definit pas `updateStep()` explicitement (elle utilise `updateStep` dans les exemples mais la signature exacte n'est pas dans la Section 4).
- Source : Section 2, R3 (TTL 7 jours) ; Section 4 (absence de `updateStep` dans l'interface de `pipeline-tracker.ts`) ; Section 8, V5, V15
- Impact : API incomplete — les agents background qui appellent `updateStep()` n'ont pas de contrat specifie. Le status bar peut rester bloque en "EN COURS" si le tracker expire pendant l'execution d'un job long.
- Frequence estimee : rare (TTL 7 jours) mais impact visible sur le status bar

**[MINEUR] F-EC-5 — V11 : "HandoffSummary avec valeurs par defaut (objectif=conversation)" est sous-specifie**
- Scenario : `extractHandoffSummary` avec JSON invalide retourne un HandoffSummary avec "valeurs par defaut". V11 specifie `objectif=conversation` et `decisions=[]` mais pas les autres champs. Si l'implementeur retourne `{ objective: "conversation", decisions: [], constraints: undefined, filesIdentified: undefined, ... }`, le type `HandoffSummary` est-il satisfait ? La spec ne dit pas si les autres champs doivent etre des arrays vides ou peuvent etre undefined/null.
- Source : Section 8, V11

**[MINEUR] F-EC-6 — Post-implement keyboard : [Merger] n'a pas de callback `sdd_merge` dans R13**
- Scenario : La Section 4 decrit "Post-implement : [Review] + [Merger] + [Corriger]" comme boutons. R13 liste les callbacks: `sdd_explore`, `sdd_spec`, `sdd_challenge`, `sdd_implement`, `sdd_review`. Ni `sdd_merge` ni `sdd_correct` ne sont dans R13. Les boutons [Merger] et [Corriger] du post-implement (et [Re-explorer] du post-PIVOT, [Corriger la spec d'abord] du post-challenge) ne sont pas couverts par les handlers specifies.
- Source : Section 2, R13 ; Section 4, boutons post-implement et post-challenge

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — `sdd-flow.ts` et `getCompletionKeyboard` de job-manager.ts sont deux points d'entree de keyboard non coordonnes**
- Source : Section 5 ("src/job-manager.ts : Modifier (mineur) — Ajouter cases 'sdd-*' dans `getCompletionKeyboard()`") ; Section 4, `buildSddKeyboard`
- Description : La spec cree deux fonctions de construction de keyboard pour les jobs SDD : (1) `buildSddKeyboard(phase, name, verdict?)` dans `sdd-flow.ts` — appele proactivement lors des transitions de phase et (2) `getCompletionKeyboard(job)` dans `job-manager.ts` — appele automatiquement a la completion de chaque job. La Zone d'ombre Z3 reconnait ce probleme mais le classe comme "detail a coordonner". En pratique, la completion d'un job SDD via job-manager appelera `getCompletionKeyboard()` qui retournera un keyboard `sdd-*`. Mais ce keyboard ne connait pas le `verdict` de l'etape — parametre critique de `buildSddKeyboard`. Un job `sdd-explore` complet affichera-t-il les boutons GO, PIVOT, ou DROP ? `getCompletionKeyboard` n'a pas acces au resultat structure (verdict). La spec ne resout pas cette tension fondamentale — elle la defere.
- Alternative : Deux options : (A) supprimer le cas `sdd-*` de `getCompletionKeyboard` et laisser le callback `sdd_complete:{jobId}` ou une notification post-job dans `sdd-flow.ts` construire le keyboard contextuel avec le verdict extrait du resultat du job. (B) standardiser le format du resultat du job SDD pour inclure le verdict en prefixe parseable (ex: `SDD_EXPLORE_GO: ...`), similaire a `PRD_CREATED:` ou `PRDWF_DECOMPOSED:`.
- Codebase : `src/job-manager.ts:294-308` — pattern `PRD_CREATED:` et `PRDWF_DECOMPOSED:` resout exactement ce probleme en parsant le resultat structuree dans `getCompletionKeyboard`.

**[MAJEUR] F-SS-2 — `conversation-handoff.ts` reinvente `buildEnrichedDescription` de prd-workflow.ts**
- Source : Section 1 (objectif de `conversation-handoff.ts`) ; Section 9, A1 (alternatives evaluees)
- Description : `prd-workflow.ts:buildEnrichedDescription(rawDesc, session)` fait exactement ce que fait `extractHandoffSummary` — combiner la description detectee et le contexte de session en un input enrichi pour un agent background. Les deux fonctions : (1) lisent la session de conversation, (2) assemblent un contexte structure, (3) passent cela a un processus agent. La difference est que `extractHandoffSummary` passe par un `callClaude` intermediaire pour extraire les decisions, alors que `buildEnrichedDescription` assemble directement les champs de session. La spec cite `buildEnrichedDescription` dans la Section 9 A1 ("pattern pour enrichir un input") mais comme inspiration, pas comme candidat a la reutilisation. Les alternatives evaluees (A1-A4) ne considerent pas "reutiliser/etendre buildEnrichedDescription" vs "creer extractHandoffSummary avec callClaude".
- Alternative : Si `conversation-session.ts` expose deja `decisions`, `constraints`, `recentMessages` via `ConversationSession`, `extractHandoffSummary` pourrait assembler le `HandoffSummary` directement sans appel LLM (pattern `buildEnrichedDescription`), eliminant le probleme du mutex (F-DA-1). La perte de qualite d'extraction vs un LLM call est a evaluer.
- Codebase : `src/prd-workflow.ts:57-71` — `buildEnrichedDescription` fait le meme assemblage en 15 LOC, sans LLM.

**[MAJEUR] F-SS-3 — `initPipelineTracker()` dans relay.ts est marque "si un init est necessaire" — la spec ne tranche pas**
- Source : Section 5 ("src/relay.ts : Modifier (mineur) — Ajouter import et appel `initPipelineTracker()` dans le bloc de startup si un init est necessaire")
- Description : La spec ne decide pas si `pipeline-tracker.ts` necessite un init au startup. La parenthese "si un init est necessaire (analogue a initSessions)" cree une ambiguite : l'implementeur devra decider. `conversation-session.ts` a `initSessions()` pour pre-charger le fichier disque et eviter le cold-start (premier getSession() chargerait le fichier de facon synchrone, potentiellement bloquante). Si `pipeline-tracker.ts` suit le meme pattern de chargement lazy + debounce, un `initPipelineTracker()` est necessaire. Si le chargement est bloquant synchrone au premier acces, il n'est pas necessaire. Cette decision impacte les tests (V8, V9) et le code de relay.ts — laisser "si necessaire" est une indecision de spec.
- Alternative : Trancher explicitement : soit `pipeline-tracker.ts` a un init pre-charge (necessite relay.ts modification), soit il fait un chargement lazy sur premier acces (pas de modification relay.ts). Le pattern conversation-session.ts avec debounce est le pattern etabli et recommande.
- Codebase : `src/conversation-session.ts:113-130` — `initSessions()` pre-charge le fichier JSON au startup.

**[MINEUR] F-SS-4 — 6 phases dans `SddPhase` vs 6 symboles dans `formatStatusBar` — la phase 'discuss' est dans le type mais son status bar n'est pas clairement specifie**
- Source : Section 4, type `PipelineStep` ("phase: SddPhase // 'explore'|'discuss'|'spec'|'challenge'|'implement'|'review'") ; Section 4, `formatStatusBar` exemple
- Description : L'exemple de `formatStatusBar` dans la Section 4 liste : Exploration, Discussion, Spec, Challenge, Implementation, Review. Le type `SddPhase` contient 'discuss'. L'exemple du status bar dit "OK Discussion — 3 decisions". Mais dans `buildSddKeyboard`, la phase 'discuss' declenche le bouton [Formaliser en spec] + [Continuer] quand convergence — pas de job 'sdd-discuss'. Si 'discuss' n'a pas de job associe (c'est une phase conversationnelle, pas agent), que met-on dans `steps.discuss.status` ? La spec ne specifie pas si la phase 'discuss' est initialisee a 'pending' ou a un statut special, ni comment elle passe a 'ok'.

**[MINEUR] F-SS-5 — R6 definit 6 phases dans formatStatusBar mais la spec initiale (R13) gere 5 agents**
- Source : Section 2, R6 (symboles pour 6 phases : explore, discuss, spec, challenge, implement, review) ; Section 2, R13 (5 callbacks agents : sdd_explore, sdd_spec, sdd_challenge, sdd_implement, sdd_review)
- Description : La phase 'discuss' est dans le status bar mais n'a pas de job SDD correspondant. Sa gestion dans le tracker (quand passe-t-elle de 'pending' a 'ok' ?) est non specifiee. Ce n'est pas une contradiction bloquante (la discussion est une transition conversationnelle, pas un job) mais la spec ne dit pas explicitement comment cette transition est enregistree dans le tracker.

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 2

---

## Findings consolides et dedupliques

| ID | Severite | Titre | Agents | Resolvable |
|----|----------|-------|--------|------------|
| F-DA-1 | BLOQUANT | `callClaude` dans `extractHandoffSummary` bloque le mutex depuis un callback | DA | Oui — revoir l'architecture du handoff ou ajouter un guard explicite |
| F-DA-2 | MAJEUR | Incoherence regex R10 vs V19 (`^Decisions:/m` vs `\nDecisions:`) | DA | Oui — unifier le pattern dans R10 et V19 |
| F-DA-3 / F-EC-6 | MAJEUR | Callback `sdd_discuss` non specifie dans R13, boutons [Merger] et [Corriger] sans handler | DA + EC | Oui — completer R13 avec tous les callbacks ou documenter explicitement les cas non-agent |
| F-EC-1 | BLOQUANT | Corruption potentielle de `pipelines.json` en cas de callbacks simultanes | EC | Oui — ajouter note de limitation connue ou mutex en memoire |
| F-EC-2 | MAJEUR | V8 ne couvre pas le cas RELAY_DIR absent (permissions) | EC | Oui — ajouter cas de test negatif ou documenter la limitation |
| F-EC-3 | MAJEUR | Format callback `sdd_{etape}:{name}` ambigu si le nom contient ":" | EC | Oui — specifier le parsing (join du reste ou restriction sur le nom) |
| F-EC-4 | MAJEUR | `updateStep()` non defini dans l'interface publique de `pipeline-tracker.ts` | EC | Oui — ajouter `updateStep` dans la Section 4 avec comportement sur tracker expire |
| F-SS-1 | MAJEUR | Deux points d'entree keyboard non coordonnes (`buildSddKeyboard` vs `getCompletionKeyboard`) | SS | Oui — adopter le pattern `SDD_EXPLORE_GO:` ou supprimer le cas `sdd-*` de job-manager |
| F-SS-2 | MAJEUR | `extractHandoffSummary` reinvente `buildEnrichedDescription` de prd-workflow.ts | SS | Oui — evaluer si l'appel LLM est necessaire vs assemblage direct de session |
| F-SS-3 | MAJEUR | `initPipelineTracker()` non tranchee ("si necessaire") | SS | Oui — decider explicitement (lazy vs pre-charge) |
| F-DA-4 | MINEUR | R12 cite pipeline-state.ts comme pattern mais V9 requiert un comportement plus riche | DA | Oui — clarifier que `_clearForTests` doit aussi reset le flag de chargement |
| F-SS-4 / F-SS-5 | MINEUR | Phase 'discuss' dans le type mais sans job ni transition specifiee | SS | Oui — ajouter une note explicite sur la gestion de la phase discuss |

Note de deduplication : F-DA-3 et F-EC-6 decrivent le meme probleme (callbacks non couverts dans R13). F-SS-4 et F-SS-5 decrivent le meme probleme (phase 'discuss' sans semantique definie). F-EC-1 est liste comme BLOQUANT distinct de F-DA-1 car ils concernent des couches differentes (concurrence disque vs mutex LLM).

---

## Recommandations (actions pour passer a GO)

### Corrections bloquantes (requises avant implementation)

**1. Resoudre F-DA-1 — Architecture du handoff et mutex callClaude**

Option A (recommandee) : `extractHandoffSummary` ne doit PAS appeler `callClaude` directement depuis le handler de callback. Le callback `sdd_spec:{name}` doit : (1) assembler un HandoffSummary directement depuis la session (`conversation-session.ts:ConversationSession.decisions`, `.constraints`, `.messages`) sans LLM call, analogue a `buildEnrichedDescription`, puis (2) lancer le job background spec-architect qui recoit ce HandoffSummary comme input. Adapter la Decision Q1 et R7 en consequence.

Option B : Si l'appel LLM pour le handoff est juge necessaire pour la qualite, l'externaliser dans le job background lui-meme (le job spec-architect appelle `callClaude` pour l'extraction, hors du handler callback). Cela deplace le blocage hors de l'interaction Telegram.

Si l'Option A est choisie, F-SS-2 devient une recommandation forte : reutiliser ou etendre `buildEnrichedDescription`.

**2. Resoudre F-EC-1 — Concurrence sur `pipelines.json`**

Ajouter une note dans R5 ou Section 9 Zone d'ombre : "La persistence disque n'est pas thread-safe en cas de callbacks simultanement traites par grammY. Limitation acceptee en V1 (usage mono-utilisateur, risque de double-click negligeable). Mitigation : utiliser un mutex en memoire (pattern semaphore.ts) si le probleme se manifeste." Ce finding peut etre classe MAJEUR/accepte plutot que BLOQUANT si le contexte mono-utilisateur du projet est reconnu explicitement.

### Corrections majeures (requises pour coherence spec)

**3. Completer R13 et la Section 4 avec TOUS les callbacks SDD (F-DA-3 / F-EC-6)**

Lister explicitement : `sdd_discuss` (transition vers la discussion post-exploration), `sdd_merge` (merge du PR), `sdd_correct` (relancer implementeur). Ou documenter explicitement quels boutons sont "de navigation conversationnelle" (pas de job) vs "de lancement d'agent" (job). La frontiere doit etre claire.

**4. Unifier le pattern regex (F-DA-2)**

Choisir un pattern unique pour R10 et V19. Recommandation : utiliser `/(^|\n)Decisions:/` pour matcher en debut de reponse OU apres un saut de ligne. Mettre a jour R10 et V19 avec le meme pattern.

**5. Definir `updateStep()` dans la Section 4 (F-EC-4)**

Ajouter la signature et le comportement : `updateStep(chatId, threadId, phase, status, artifact?, summary?, jobId?)`. Specifier le comportement si le tracker est null/expire : log.warn, pas d'erreur, no-op.

**6. Trancher `initPipelineTracker()` (F-SS-3)**

Adopter le pattern etabli de `conversation-session.ts` : chargement pre-cache au startup via `initPipelineTracker()`, appele dans `relay.ts` apres `initJobManager(mainBot)`. Supprimer la mention "si necessaire".

**7. Resoudre la coordination `buildSddKeyboard` / `getCompletionKeyboard` (F-SS-1)**

Adopter le pattern `PRD_CREATED:` : specifier que le resultat des jobs SDD utilise un prefixe structure `SDD_{PHASE}_{VERDICT}:` (ex: `SDD_EXPLORE_GO:`, `SDD_SPEC_OK:`, `SDD_CHALLENGE_NO-GO:`). `getCompletionKeyboard` parse ce prefixe pour construire le keyboard contextuel avec le verdict correct, eliminer la dependance a `buildSddKeyboard` depuis job-manager.

**8. Specifier le parsing du callback data (F-EC-3)**

Ajouter dans R9 : "Le nom du pipeline est extrait par `data.slice(prefixe.length + etape.length + 1)` ou `split(":").slice(1).join(":")` pour tolerer les noms contenant `:`. En pratique, les noms derives par R1 ne contiennent pas `:` — mais specifier la robustesse."

### Acceptable en V1 sans modification

- V8/F-EC-2 (RELAY_DIR absent) : le test V8 est valide dans son perimetre. Documenter la limitation dans Section 9 Zone d'ombre.
- F-DA-4 (R12 vs V9) : clarifier dans V9 que `_clearForTests()` doit inclure le reset du flag `persistLoaded` analogue a `conversation-session.ts:_resetSessions()` (ligne 475 : `persistLoaded = true`).
- F-SS-4/5 (phase 'discuss') : ajouter dans Section 9 : "La phase 'discuss' est une phase conversationnelle sans job SDD associe. Elle passe de 'pending' a 'ok' quand le callback `sdd_discuss` est appele (bouton [Discuter les resultats] ou [Discuter sans explorer])."

---

## Points forts identifies

1. **Pattern de persistence disque bien choisi** : La reutilisation du pattern atomic write de `job-manager.ts` est solide. L'analogie avec `conversation-session.ts` pour le TTL et `_clearForTests` est cohesive avec le codebase.

2. **Guard prefixe + next() correctement specifie** (R9) : Le pattern grammY est bien defini, avec reference aux 9 fichiers existants. Le Composer separe `sdd-flow.ts` est le bon choix pour eviter de grossir `zz-messages.ts`.

3. **Separation des responsabilites claire** : Les trois modules ont des perimtres bien distincts — tracker (etat), handoff (extraction), sdd-flow (UI/callbacks). La decision Q2 (Composer separe) est bien argumentee.

4. **V-criteres exhaustifs sur les cas nominaux** : Les 24 V-criteres couvrent bien les happy paths, les expirations TTL, les verdicts de keyboard, et les faux positifs de convergence.

5. **Alternatives bien documentees** (A1-A4) : Chaque decision architecturale est tracee avec ses alternatives et sa justification. La Zone d'ombre Z1 (system prompt non modifie en Phase 2) est une reconnaissance honnete du perimetre.

6. **Interdiction explicite des modules Supprimes** (R15, R16) : Les contraintes anti-couplage sont clairement posees, ce qui protege contre la dette technique lors de l'implementation.

---

## Etape suivante

**Verdict : GO WITH CHANGES**

Corrections requises avant de commencer l'implementation :

1. **[BLOQUANT/MAJEUR]** Resoudre l'architecture `extractHandoffSummary` vs mutex `callClaude` (F-DA-1) — trancher Option A (assemblage direct) ou Option B (appel LLM dans le job). Mettre a jour R7 et Decision Q1.
2. **[MAJEUR]** Completer R13 avec tous les callbacks SDD (`sdd_discuss`, `sdd_merge`, `sdd_correct`) ou documenter la frontiere job vs navigation (F-DA-3/F-EC-6).
3. **[MAJEUR]** Definir `updateStep()` dans Section 4 (F-EC-4).
4. **[MAJEUR]** Trancher `initPipelineTracker()` et specifier dans relay.ts (F-SS-3).
5. **[MAJEUR]** Specifier la coordination `buildSddKeyboard` / `getCompletionKeyboard` via pattern `SDD_{PHASE}_{VERDICT}:` (F-SS-1).
6. **[MAJEUR]** Unifier le pattern regex de convergence R10/V19 (F-DA-2).

Corrections secondaires (peuvent etre appliquees en meme temps) :
7. Specifier le parsing du callback data pour noms avec ":" (F-EC-3).
8. Documenter la limitation de concurrence sur `pipelines.json` (F-EC-1) en Zone d'ombre.
9. Clarifier V9 : `_clearForTests()` doit reset le flag `persistLoaded` (F-DA-4).
10. Ajouter la semantique de la phase 'discuss' dans Section 9 (F-SS-4/5).

Une fois ces corrections appliquees a la spec :
`/dev-implement "Implementer SPEC-modules-fondation-flow-sdd. Spec: docs/specs/SPEC-modules-fondation-flow-sdd.md"`
