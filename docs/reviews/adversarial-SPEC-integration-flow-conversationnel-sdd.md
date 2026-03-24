---
phase: 2-challenge
status: complete
spec: docs/specs/SPEC-integration-flow-conversationnel-sdd.md
generated_at: "2026-03-24T18:30:00Z"
agents:
  - devils-advocate
  - edge-case-hunter
  - simplicity-skeptic
verdict: GO_WITH_CHANGES
findings_summary:
  bloquants: 2
  majeurs: 7
  mineurs: 5
---

# Challenge Adversarial — SPEC-integration-flow-conversationnel-sdd.md

## Contexte

Spec analysee : Phase 3 Architecture V2 — Integration du flow conversationnel SDD
Trois agents adversariaux ont analyse independamment la spec, puis leurs rapports ont ete consolides.
Verdict global : **GO_WITH_CHANGES** (le verdict le plus severe des 3 agents).

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — Contradiction buildPrompt() sync/async : R2 impose sync mais R1 requiert getTracker() async**

- Source : Section 2, Regles R1 et R2 / Section 7.4
- Description : R1 stipule que l'instruction de convergence est conditionnee "a la presence d'un pipeline tracker actif pour le chat courant". R2 resout cela en disant que "la verification du tracker se fait cote appelant et se passe en parametre". Mais le seul appelant dans zz-messages.ts (L488-496) appelle `bctx.buildPrompt()` sans aucune reference a `chatId` ou `threadId`. La spec indique que "callClaude() verifie getTracker() avant buildPrompt()", mais `callClaude()` dans bot-context.ts (L298-311) ne recoit que `prompt` et `options?: ClaudeCallOptions` — il ne connait pas le chatId ou threadId du contexte Telegram courant. Il n'y a aucun mecanisme dans la signature de `callClaude()` pour passer ces informations. La spec cree donc une obligation sans specifier comment `callClaude()` obtient le chatId/threadId necessaire a l'appel `getTracker()`.
- Impact : BLOQUANT — L'implémentation est architecturalement impossible sans modifier `callClaude()` (sa signature doit accepter un chatId/threadId) OU sans reorganiser le flux dans `zz-messages.ts` pour verifier le tracker avant de construire le prompt. La spec omet de specifier lequel de ces deux schemas est retenu.
- Evidence : Section 6.5 montre la signature actuelle `buildPrompt(... hasSddPipeline?: boolean)` — ok. Mais la Section 2 R2 dit que "callClaude() verifie getTracker() avant buildPrompt()" : `callClaude()` en L298 est `callClaudeInternal(prompt, options)` — aucun chatId.

**[BLOQUANT] F-DA-2 — Instruction de convergence positionnee "apres MEMORY MANAGEMENT" mais buildPrompt() ne garantit pas cette position**

- Source : Section 4.1 / Section 6.5 (buildPrompt L569-650)
- Description : La spec dit "insert apres la section MEMORY MANAGEMENT". Dans buildPrompt() (L622-629), la section MEMORY MANAGEMENT est ajoutee a `parts` avec `parts.push(...)`. Mais l'instruction de convergence SDD doit etre inseree "apres" elle — or `parts` est un tableau et `push` ajoute a la fin. Si l'instruction SDD est aussi ajoutee par `push`, elle sera apres MEMORY MANAGEMENT seulement si rien d'autre n'est ajouté entre les deux. Or L631-643 ajoutent VOICE CAPABILITIES apres MEMORY MANAGEMENT, et L646 ajoute `recentMessages`. La spec ne prend pas en compte cet ordre — l'instruction SDD sera soit intercalee entre MEMORY MANAGEMENT et VOICE CAPABILITIES, soit apres recentMessages. Ce detail est non-trivial car l'instruction de convergence doit etre positionnee de façon a ne pas etre "noyee" a la fin du prompt apres les messages recents.
- Impact : BLOQUANT — Le prompt structure differe de la spec, avec un risque de degradation de l'effectivite de l'instruction de convergence si elle apparait apres les messages recents (le contexte proche est prioritaire pour Claude).
- Evidence : bot-context.ts L622-647 : l'ordre est MEMORY_MANAGEMENT → VOICE_CAPABILITIES → recentMessages → User message. La spec dit "apres MEMORY MANAGEMENT" mais ne specifie pas si c'est avant ou apres VOICE_CAPABILITIES et recentMessages.

**[MAJEUR] F-DA-3 — R5 : extraction du verdict GO/PIVOT/DROP "depuis le contenu de l'artefact" non specifiee**

- Source : Section 2, Regle R5 / Section 4.5
- Description : R5 dit "Le verdict (GO/PIVOT/DROP) est extrait depuis le contenu de l'artefact apres completion." Mais comment ? L'artefact est un fichier markdown EXPLORE-{name}.md produit par l'agent explorer. La spec ne definit pas le format attendu dans ce fichier pour le verdict, ni la regex d'extraction, ni le comportement si le verdict est absent. Section 4.5 montre les formats de retour SDD_EXPLORE_GO/PIVOT/DROP mais ne specifie pas comment runSddExplore() derive ces valeurs depuis le contenu de l'artefact.
- Impact : MAJEUR — L'implementation de runSddExplore() doit inventer une logique d'extraction qui peut etre incorrecte ou fragile. Si l'agent explorer ne produit pas de signal explicite de verdict dans son artefact, la fonction retournera toujours "GO" par defaut ou echouera a determiner le verdict.
- Evidence : Contrainte 7.2 interdit de modifier .claude/agents/explorer.md — donc le format de sortie de l'agent n'est pas controlable par la spec.

**[MAJEUR] F-DA-4 — R7 : "le verdict global est le plus severe" sans definition de l'algorithme de synthese**

- Source : Section 2, Regle R7 / Section 4 (section manquante)
- Description : R7 dit que "le verdict global est le plus severe des 3 agents (NO-GO > GO_WITH_CHANGES > GO)". Mais les 3 agents (devils-advocate, edge-case-hunter, simplicity-skeptic) produisent des rapports textuels, pas des verdicts structures. La spec ne definit pas comment le verdict est extrait de chaque rapport. Les agents utilisent les classifications BLOQUANT/MAJEUR/MINEUR — pas GO/NO-GO. Il faudrait soit un mapping BLOQUANT→NO-GO, MAJEUR→GO_WITH_CHANGES, MINEUR→GO, soit que les agents produisent un verdict explicite en fin de rapport. Ni l'un ni l'autre n'est specifie.
- Impact : MAJEUR — L'implementation doit inventer une logique de synthese de verdict qui n'existe pas dans la spec, avec un risque de divergence entre le verdict retourne et le contenu reel des rapports.
- Evidence : .claude/agents/devils-advocate.md : format de sortie avec BLOQUANT/MAJEUR/MINEUR mais aucune mention de GO/NO-GO.

**[MAJEUR] F-DA-5 — Decision D2 non coherente avec contrainte 7.2**

- Source : Decisions D2 / Section 7.2
- Description : D2 dit "Spec-architect en background avec handoff summary comme substitut a la Discovery Interview". Or spec-architect.md est dans .claude/agents/ — sa logique interne n'est pas controlable (contrainte 7.2). Si spec-architect.md conduit une interview interactive (ce que son nom suggere), le lancement en background via spawnClaude() causera un timeout ou un blocage silencieux. La spec suppose que l'agent peut fonctionner en mode non-interactif avec uniquement un prompt en entree, mais ne verifie pas cette hypothese.
- Impact : MAJEUR — Si spec-architect.md attend une interaction, runSddSpec() ne terminera jamais ou echouera silencieusement.

**[MINEUR] F-DA-6 — R9 precise "le handoff context est assemble dans le callback" mais R3 exporte les fonctions avec handoff en parametre**

- Source : Section 2, Regles R3 et R9 / Section 4.3
- Description : R3 exporte `runSddSpec(name, handoff, bctx)` avec `handoff: HandoffSummary` comme parametre. R9 dit que "le handoff context est assemble dans le callback avant le lancement du job". La Section 4.3 montre le pattern attendu. Mais le probleme est que `assembleHandoffContext` dans sdd-flow.ts necessite `recentMessages` — qui provient de `getRecentMessages()` de memory/core.ts. Le callback sdd_spec dans sdd-flow.ts ne recupere pas actuellement les recentMessages (elle a seulement chatId, threadId, tracker). La spec ne specifie pas comment sdd-flow.ts recupere les recentMessages — soit via une requete Supabase depuis bctx.supabase, soit depuis memory/core.ts directement.
- Impact : MINEUR — Ambiguite implementatoire, mais resoluble en regardant les patterns existants.

**[MINEUR] F-DA-7 — Regle R4 dit "prefixe SDD_{PHASE}_{VERDICT}:" mais format "SDD_CHALLENGE_NO-GO:" contient un tiret**

- Source : Section 2, Regle R4 / Section 4.5
- Description : R4 dit "SDD_{PHASE}_{VERDICT}:" avec PHASE et VERDICT en majuscules et "pour compatibilite avec getCompletionKeyboard()". Le fichier job-manager.ts utilise la regex `/^SDD_(\w+)_(\w[\w-]*?):/` ou `\w[\w-]*?` autorise les tirets. Mais R4 dit "prefixe SDD_{PHASE}_{VERDICT}" sans mentionner explicitement les tirets. La cohérence est assuree par la regex existante, mais c'est une hypothese implicite non justifiee dans la spec.
- Impact : MINEUR — La regex job-manager.ts couvre le cas, donc pas de breaking change.

### Statistiques
- Bloquants : 2
- Majeurs : 4
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — Ecrasement silencieux du tracker par /explore : perte de pipeline actif non detectee**

- Scenario : L'utilisateur a un pipeline SDD actif (ex: "ma-feature" en phase spec) et lance `/explore ma-feature`. R10 dit "Si un tracker existe deja pour ce chat/thread, il est ecrase (nouvelle exploration = nouveau pipeline)". L'utilisateur perd son pipeline en cours sans avertissement. La spec ne prevoit ni confirmation, ni preservation du pipeline precedent, ni message d'erreur.
- Source : Section 2, Regle R10 / Section 4.4
- Impact : Perte de donnees — les steps, jobIds, et artefacts du pipeline en cours sont definitvement perdus. L'utilisateur devra reprendre son pipeline SDD depuis le debut.
- Frequence estimee : Occasionnel (l'utilisateur explore frequemment pour des recherches intermediaires).

**[MAJEUR] F-EC-2 — runSddChallenge() : Promise.all avec 3 spawnClaude() — que se passe-t-il si 1 ou 2 agents echouent ?**

- Scenario : Dans runSddChallenge(), Promise.all lance 3 spawnClaude(). Si un agent retourne exitCode != 0, Promise.all echoue immediatement et les 2 autres resultats sont perdus. La spec ne specifie pas si le comportement attendu est : (a) echec total → SDD_CHALLENGE_FAILED, (b) consolidation partielle avec les agents reussis (ex: 2/3), ou (c) Promise.allSettled() pour recuperer tous les resultats meme partiels.
- Source : Section 2, Regle R7 / Section 7.6
- Impact : En cas d'echec d'un seul agent sur 3 (scenario frequent : timeout, modele sature), tout le challenge echoue alors que 2 rapports sont disponibles.
- Frequence estimee : Occasionnel (les agents Claude peuvent timeout ou echouer sur des questions complexes).

**[MAJEUR] F-EC-3 — buildExploreFn() avec modules "Supprimes" : la fonction actuelle dans exploration.ts importe bmad-agents.ts, agent-schemas.ts, bmad-prompts.ts**

- Scenario : La spec demande d'exporter `buildExploreFn()` depuis exploration.ts et que sdd-agents.ts l'importe (R12). Mais buildExploreFn, tel que defini dans exploration.ts (L129-203), importe `getAgent` de bmad-agents.ts, `buildAgentContext` de agent-context.ts, `buildStructuredOutputInstructions`/`parseAgentOutput` de agent-schemas.ts, `buildAgentSystemPromptPart` de bmad-prompts.ts — tous des modules "Supprimes" dans ARCHITECTURE-V2 (R13). Donc si sdd-agents.ts importe buildExploreFn, il importe indirectement les modules interdits via la closure de buildExploreFn.
- Source : Section 2, Regles R12 et R13 / Section 7.1 / Section 9.3 Zone Z4
- Impact : Violation directe de R13 par voie indirecte. La Zone Z4 mentionne ce probleme mais le marque comme "sous-objectif : buildExploreFn utilise directement spawnClaude() sans passer par les modules deprecated" — mais ne le resout pas dans la spec.
- Frequence estimee : Certain (c'est le code existant).

**[MAJEUR] F-EC-4 — Que se passe-t-il si getTracker() retourne null quand updateStep() est appele dans exploration.ts ?**

- Scenario : La spec dit (R10-R11) que exploration.ts appelle `createPipeline()` puis `updateStep()`. Mais si `createPipeline()` echoue (erreur d'ecriture disque, permissions), le tracker n'existe pas et `updateStep()` loggue un warn silencieux (pipeline-tracker.ts L194-196). L'utilisateur ne voit pas d'erreur — le job est lance mais le tracker n'est pas mis a jour.
- Source : Section 4.4 / pipeline-tracker.ts L194-196
- Impact : Pipeline tracker incohérent : le job tourne mais les steps ne sont jamais mis a jour → la status bar sera toujours vide/erronee.
- Frequence estimee : Rare (mais problematique en prod si le disque est plein).

**[MAJEUR] F-EC-5 — runSddImplement() avec useWorktree: true sur une branche propre : collision de branches potentielle**

- Scenario : runSddImplement() appelle spawnClaude avec useWorktree: true pour implementer la spec. Si l'utilisateur relance sdd_implement pour le meme pipeline name (correction apres un echec), une nouvelle branche worktree est creee avec le meme nom potentiel. La spec ne specifie pas comment le nom de branche est derive du pipeline name, ni comment les collisions sont gerees.
- Source : Section 2, Regle R8 / Section 4.5
- Impact : Crash du spawn Claude ou creation d'une branche doublon inutilisable.
- Frequence estimee : Occasionnel (les retries sont courants apres un echec d'implementation).

**[MINEUR] F-EC-6 — buildExploreFn() prend (query, bctx, chatId, threadId) mais la signature differe entre R12 et l'usage dans runSddExplore()**

- Scenario : R12 dit `buildExploreFn(query, bctx, chatId, threadId): () => Promise<string>`. R5 dit `runSddExplore(name, chatId, threadId, bctx)`. La spec n'explique pas comment `name` et `query` sont reconcilies — sont-ils identiques ? Si runSddExplore() appelle buildExploreFn(name, bctx, chatId, threadId), alors "name" est passe comme "query" — mais name est le pipeline name (kebab-case) alors que query est une description naturelle. L'agent explorer recevra un prompt avec une query en kebab-case.
- Source : Section 2, Regles R5 et R12
- Impact : Mineur — l'agent peut produire un rapport sur "mon-projet-v2" au lieu de "mon projet v2" mais le contenu reste exploitable.
- Frequence estimee : Frequent (si buildExploreFn est utilise tel quel avec name).

**[MINEUR] F-EC-7 — Convergence SDD dans zz-messages.ts : la detection ne peut se declencher que si buildPrompt() inclut l'instruction**

- Scenario : La detection de convergence dans zz-messages.ts L514 appelle `detectConvergenceInResponse(finalResponse)` apres `callClaude()`. Mais si le tracker n'existe pas encore (premier message d'une conversation sans pipeline actif), hasSddPipeline=false → pas d'instruction → pas de convergence → pas de keyboard. C'est correct. Mais si l'utilisateur a un tracker mais que callClaude() est appele sans le flag hasSddPipeline (ex: depuis une autre commande qui appelle callClaude directement), l'instruction n'est pas injectee. La spec ne liste pas tous les endroits ou callClaude() est appele pour garantir la propagation de hasSddPipeline.
- Source : Section 2, Regles R1-R2 / zz-messages.ts L488-500
- Impact : Mineur — seulement zz-messages.ts fait la boucle complète buildPrompt+callClaude+detection, les autres usages ne concernent pas la convergence.

### Statistiques
- Bloquants : 1
- Majeurs : 4
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — R12 exporte buildExploreFn() de exploration.ts mais exploration.ts est un Composer grammY : couplage indesirable**

- Source : Section 2, Regle R12 / Section 7.5
- Description : La spec demande d'exporter buildExploreFn() de `src/commands/exploration.ts`. Or exploration.ts est un module de commandes Telegram (Composer grammY), auto-charge par loader.ts. Exporter une fonction metier depuis un Composer cree un couplage entre la couche UI (exploration.ts) et la couche logique (sdd-agents.ts). Si sdd-agents.ts importe buildExploreFn de exploration.ts, sdd-agents.ts devient dependent du Composer — ce qui est exactement ce que la spec interdit par R13 et contrainte 7.5. Une alternative plus propre : buildExploreFn est definie dans sdd-agents.ts lui-meme (c'est la logique metier SDD) et exploration.ts l'importe de la, pas l'inverse.
- Alternative : Definir buildExploreFn dans sdd-agents.ts. exploration.ts l'appelle via import depuis sdd-agents.ts pour son job background, sans creer de couplage circulaire.
- Codebase : src/commands/exploration.ts est charge par loader.ts comme Composer. src/commands/sdd-flow.ts importe depuis src/pipeline-tracker.ts (correct). sdd-agents.ts ne doit pas importer depuis src/commands/.

**[MAJEUR] F-SS-2 — Section 7.7 : bot-context.ts passerait de 816 a 836 LOC, au-dessus du seuil de 800 LOC documenté dans CLAUDE.md**

- Source : Section 7.7 / CLAUDE.md section "File size guideline"
- Description : CLAUDE.md indique "source files > 800 LOC are candidates for refactoring into sub-modules. Currently above threshold: bot-context.ts (816)". La spec ajoute ~20 LOC a bot-context.ts, le portant a ~836 LOC. La spec elle-meme note "reste sous 840 LOC" — acceptant donc de franchir le seuil de refactoring documente. C'est contradictoire avec les standards du projet.
- Alternative : L'instruction de convergence (hasSddPipeline) pourrait etre injectee depuis zz-messages.ts directement dans le prompt avant de passer a callClaude(), plutot que dans buildPrompt(). Cela evite de modifier bot-context.ts et respecte le seuil.
- Codebase : CLAUDE.md "File size guideline: source files > 800 LOC [...] deferred to future vagues". Mais la spec ajoute deliberement des LOC a un fichier deja au-dessus du seuil.

**[MAJEUR] F-SS-3 — sdd-agents.ts exporte 5 fonctions mais leur logique est tres similaire : duplication de code non justifiee**

- Source : Section 4.2 / Section 2, Regles R5-R8
- Description : Les 5 fonctions runSddExplore/Spec/Challenge/Implement/Review suivent toutes le meme pattern : (1) construire un prompt avec contexte conversationnel, (2) appeler spawnClaude(), (3) parser le resultat, (4) retourner un prefixe SDD_{PHASE}_{VERDICT}. La spec ne propose pas de factorisation commune (ex: une fonction generique `runSddPhase(phase, agent, prompt)`) alors que la structure est identique. Avec 5 fonctions distinctes de ~50 LOC chacune, le module approche 280 LOC (comme predit), mais une factorisation pourrait reduire a ~150 LOC avec le meme comportement.
- Alternative : Une fonction generique `runSddPhase(config: SddPhaseConfig): Promise<string>` avec une interface de configuration, utilisee par les 5 wrappers publics.
- Codebase : agent.ts utilise deja un pattern generalise spawnClaude() sans duplication par agent.

**[MAJEUR] F-SS-4 — La spec reinvente l'extraction de verdict depuis des artefacts textuels sans s'appuyer sur les patterns existants**

- Source : Section 2, Regles R5 et R7
- Description : La spec demande d'extraire des verdicts depuis le contenu des artefacts (markdown produits par les agents). Le projet dispose deja de `parseAgentOutput()` dans agent-schemas.ts pour parser les sorties d'agents en JSON structure — mais R13 interdit d'importer agent-schemas.ts dans sdd-agents.ts. La spec cree donc une logique d'extraction ad-hoc alors que le projet a investi dans un systeme de parsing structure. Au lieu d'interdire agent-schemas.ts pour sdd-agents.ts, une alternative serait de creer un module `sdd-parser.ts` leger qui ne depend que de patterns regex — sans agent-schemas.ts mais sans reimplementer de la logique dupliquee.
- Alternative : Creer src/sdd-parser.ts avec uniquement les fonctions de parsing SDD. Autorise dans R13 (module nouveau, pas dans la liste interdite).
- Codebase : agent-schemas.ts L1091 LOC est un module trop lourd pour sdd-agents.ts, mais la logique de parsing peut etre extraite.

**[MINEUR] F-SS-5 — V21 introduit un critere de validation sur la status bar dans sdd-flow.ts mais sdd-flow.ts n'importe pas formatStatusBar**

- Source : Section 8, Critere V21 / src/commands/sdd-flow.ts
- Description : V21 dit "sdd-flow.ts envoie la status bar formatStatusBar() au chat apres le lancement d'un job SDD". Mais dans le code actuel de sdd-flow.ts (L225-228), le message envoye est `"Job lance ${jobType} (id: ${jobId})\nPipeline: ${name}"` — aucun import de formatStatusBar. La spec ajoute implicitement une fonctionnalite (affichage de la status bar) sans la lister explicitement dans la Section 5 comme modification de sdd-flow.ts.
- Alternative : Ajouter explicitement l'import de formatStatusBar et l'appel dans la Section 5 comme modification attendue.

### Statistiques
- Bloquants : 0
- Majeurs : 4
- Mineurs : 1

---

## Synthese et Verdict Global

### Matrice de severite consolidee

| ID | Agent | Niveau | Titre court |
|----|-------|--------|-------------|
| F-DA-1 | Devil's Advocate | BLOQUANT | Contradiction buildPrompt sync vs getTracker async dans callClaude() |
| F-EC-1 | Edge Case Hunter | BLOQUANT | Ecrasement silencieux du tracker par /explore |
| F-DA-3 | Devil's Advocate | MAJEUR | Extraction du verdict GO/PIVOT/DROP non specifiee |
| F-DA-4 | Devil's Advocate | MAJEUR | Algorithme de synthese des verdicts challenge non defini |
| F-DA-5 | Devil's Advocate | MAJEUR | spec-architect.md interactif potentiellement incompatible avec background |
| F-EC-2 | Edge Case Hunter | MAJEUR | Promise.all challenge : echec partiel non gere |
| F-EC-3 | Edge Case Hunter | MAJEUR | buildExploreFn() viole R13 via imports indirects |
| F-EC-4 | Edge Case Hunter | MAJEUR | createPipeline() echec silencieux → tracker incohérent |
| F-EC-5 | Edge Case Hunter | MAJEUR | Collision de branches pour runSddImplement() retry |
| F-SS-1 | Simplicity Skeptic | MAJEUR | Export buildExploreFn depuis un Composer : couplage UI/logique |
| F-SS-2 | Simplicity Skeptic | MAJEUR | bot-context.ts depasse le seuil de 800 LOC |
| F-SS-3 | Simplicity Skeptic | MAJEUR | Duplication de code dans les 5 runSddXxx sans factorisation |
| F-SS-4 | Simplicity Skeptic | MAJEUR | Logique d'extraction de verdict reinventee sans pattern existant |
| F-DA-2 | Devil's Advocate | BLOQUANT* | Position de l'instruction de convergence dans buildPrompt |
| F-DA-6 | Devil's Advocate | MINEUR | recentMessages non disponible dans sdd-flow.ts callbacks |
| F-DA-7 | Devil's Advocate | MINEUR | Tiret dans SDD_CHALLENGE_NO-GO: implicitement supporte |
| F-EC-6 | Edge Case Hunter | MINEUR | name (kebab) vs query (naturel) dans buildExploreFn |
| F-EC-7 | Edge Case Hunter | MINEUR | hasSddPipeline non propage a tous les appels callClaude |
| F-SS-5 | Simplicity Skeptic | MINEUR | formatStatusBar non liste comme modification de sdd-flow.ts |

*F-DA-2 reclassifie en BLOQUANT apres analyse : la position post-recentMessages neutralise l'instruction de convergence dans les conversations longues.

### Verdict global : GO_WITH_CHANGES

**Verdict par agent :**
- Devil's Advocate : GO_WITH_CHANGES (2 bloquants, 4 majeurs)
- Edge Case Hunter : GO_WITH_CHANGES (1 bloquant, 4 majeurs)
- Simplicity Skeptic : GO_WITH_CHANGES (0 bloquants, 4 majeurs)

**Verdict consolide : GO_WITH_CHANGES**

La spec est implementable mais requiert des corrections sur les points suivants avant implementation :

### Corrections requises (bloquants)

1. **F-DA-1** : Specifier explicitement comment `callClaude()` obtient le chatId/threadId pour verifier getTracker(). Option recommandee : ajouter `chatId?: number; threadId?: number` a `ClaudeCallOptions`, ou passer hasSddPipeline directement dans zz-messages.ts avant buildPrompt() (sans impliquer callClaude()).

2. **F-DA-2** : Preciser la position exacte de l'instruction de convergence dans buildPrompt() : "apres MEMORY MANAGEMENT et avant VOICE_CAPABILITIES" (L629-631), pas apres recentMessages.

3. **F-EC-1** : Ajouter une confirmation ou un message d'avertissement quand /explore ecrase un pipeline actif ("Pipeline SDD actif detecte, sera ecrase par la nouvelle exploration.").

4. **F-EC-3** : Resoudre la contradiction R12/R13 : soit buildExploreFn est definie dans sdd-agents.ts et non dans exploration.ts (approche recommandee), soit la spec accepte explicitement les imports indirects de modules "Supprimes" via buildExploreFn.

### Corrections recommandees (majeurs)

5. **F-DA-3** : Ajouter une section specifying the format du verdict dans EXPLORE-{name}.md (ex: ligne "## Verdict\nGO" en fin de rapport) ou indiquer que GO est le verdict par defaut si aucun verdict n'est trouve.

6. **F-DA-4** : Specifier l'algorithme de synthese : soit les agents adversariaux ajoutent un verdict explicite en fin de rapport (ex: "## Verdict de l'agent: NO-GO"), soit la presence de findings BLOQUANT → NO-GO, MAJEUR → GO_WITH_CHANGES, sinon → GO.

7. **F-EC-2** : Remplacer Promise.all par Promise.allSettled dans runSddChallenge(). Les rapports reussis sont consolides, les echecs sont loggues. Un rapport partiel (2/3 agents) vaut mieux qu'un echec total.

8. **F-SS-1** : Inverser la dependance : buildExploreFn dans sdd-agents.ts, exploration.ts importe depuis sdd-agents.ts (si necessaire) plutot que l'inverse.

9. **F-SS-2** : Evaluer si l'ajout a buildPrompt() est necessaire ou si l'injection de hasSddPipeline peut se faire dans zz-messages.ts directement, sans modifier bot-context.ts.
