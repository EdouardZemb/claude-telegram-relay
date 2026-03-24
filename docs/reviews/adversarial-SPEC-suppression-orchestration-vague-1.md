# Adversarial Review — SPEC-suppression-orchestration-vague-1

> Spec source : `docs/specs/SPEC-suppression-orchestration-vague-1.md`
> Date : 2026-03-24
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic
> Cycle : 1

---

## Tableau de synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|:---:|:---:|:---:|:---:|
| BLOQUANT | 2 | 1 | 0 | 3 |
| MAJEUR | 3 | 3 | 2 | 8 |
| MINEUR | 2 | 2 | 2 | 6 |
| **Total** | **7** | **6** | **4** | **17** |

---

## Verdict : GO WITH CHANGES

**Justification** : 3 BLOQUANTs existent mais tous sont resolubles avant implementation. Le BLOQUANT principal (F-DA-1) est une erreur d'analyse de graphe de dependances : `AgentRole` est un type-only export encore importe par 4 modules actifs (`feedback-loop.ts`, `agent-context.ts`, `mcp-config.ts`, `prd-workflow.ts`) depuis `orchestrator.ts`, et la spec ne prevoit pas la migration de ce type. Les deux autres BLOQUANTs concernent (F-DA-2) `prd-workflow.ts` qui reste importateur de `pipeline-selection.ts` via `explainPipelineChoice` meme apres adaptation de `zz-messages.ts`, et (F-EC-1) `gate-persistence.ts` qui importe `DeterministicCheckResult`/`RubricDimension` depuis `gate-evaluator.ts` (cible de suppression) sans que help.ts soit son seul importeur. Ces trois BLOQUANTs exigent des corrections spec avant implementation.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — `AgentRole` importe depuis `orchestrator.ts` par 4 modules actifs non mentionnes**

- Source : Section 4 (Fichiers supprimes), Section 7.3 (Modules a verifier)
- Description : La spec supprime `src/orchestrator.ts` (barrel) et tous ses sous-modules dont `orchestrator/types.ts` qui contient la definition de `AgentRole`. Or 4 modules actifs importent ce type directement depuis `orchestrator.ts` : `src/feedback-loop.ts` (ligne 19), `src/agent-context.ts` (ligne 14), `src/mcp-config.ts` (ligne 7), `src/prd-workflow.ts` (ligne 19). Ces modules ne sont pas des cibles de suppression en vague 1 et ne sont pas mentionnes dans la section 4 "Fichiers modifies". Apres suppression du barrel orchestrator.ts, `bunx tsc --noEmit` echoue sur ces 4 fichiers avec "Cannot find module './orchestrator.ts'".
- Evidence : `grep -rn "from.*orchestrator\b" src/ --include="*.ts"` retourne `feedback-loop.ts:19`, `agent-context.ts:14`, `mcp-config.ts:7`, `prd-workflow.ts:19` hors cibles de suppression.
- Impact : Typecheck (V5) echoue avant meme de lancer les tests. La vague 1 est bloquee.
- Resolution suggeree : Deux options : (a) deplacer `AgentRole` dans un module sans dependance sur l'orchestrateur (ex: un nouveau `src/agent-types.ts` ou dans `src/bmad-agents.ts` qui est conserve), puis adapter les 4 imports en vague 1 ; (b) faire migrer le type dans `src/orchestrator/types.ts` → `src/bmad-agents.ts` et adapter les imports. L'option (a) est plus propre architecturalement.

**[BLOQUANT] F-DA-2 — `prd-workflow.ts` importe `explainPipelineChoice` depuis `pipeline-selection.ts` (cible de suppression)**

- Source : R3, Section 7.3, Section 5 (pipeline-selection.ts "Supprimer — Importeurs : orchestrator barrel (cible), prd-workflow (actif indirect) → verifier")
- Description : La spec note "verifier" mais ne conclut pas. La verification confirme que `prd-workflow.ts` importe statiquement `explainPipelineChoice` et `PipelineType` depuis `pipeline-selection.ts` (ligne 20) ET utilise un import dynamique de `computeDifficultyScore` depuis `llm-router.ts` (ligne 87). `prd-workflow.ts` est lui-meme importe par `commands/zz-messages.ts` (ligne 57). Meme apres adaptation de `zz-messages.ts` (R11 : retirer les imports prd, prd-workflow, command-router), `prd-workflow.ts` et `pipeline-selection.ts` sont lies. R11 prevoit de retirer l'import de `prd-workflow.ts` dans `zz-messages.ts`, mais `prd-workflow.ts` elle-meme garde ses imports de `pipeline-selection.ts` (elle n'est pas supprimee). Donc `pipeline-selection.ts` a encore un importeur actif (`prd-workflow.ts`) apres adaptation de `zz-messages.ts`, et NE PEUT PAS etre supprimee en vague 1 sans adapter `prd-workflow.ts` au prealable.
- Evidence : `grep -n "from.*pipeline-selection" src/prd-workflow.ts` → ligne 20 (import statique), ligne 141 (import dynamique additionnel). `grep -n "from.*prd-workflow" src/commands/zz-messages.ts` → ligne 57 (import actif, R11 le retire).
- Impact : V7 echoue. `pipeline-selection.ts` ne peut pas etre supprime si `prd-workflow.ts` l'importe encore.
- Resolution suggeree : Ajouter a la section 4 "Fichiers modifies" : adapter `src/prd-workflow.ts` pour retirer les imports de `pipeline-selection.ts` et `llm-router.ts` (remplacer `explainPipelineChoice` par une version inline ou retirer la fonctionnalite). Ou reporter `prd-workflow.ts` a la suppression en vague 1 egalement (elle n'a plus d'importeur apres adaptation de `zz-messages.ts` selon R11). Verifier que `gate-evaluator.ts` (cible) est le seul autre importeur dynamique de `prd-workflow.ts`.

**[BLOQUANT] F-DA-3 — `gate-persistence.ts` importe des types depuis `gate-evaluator.ts` (cible) — suppression en cascade non modelisee**

- Source : Section 5 ("gate-persistence.ts : help.ts importe formatDoubleLoopRules → adapter help.ts d'abord")
- Description : La spec affirme que gate-persistence.ts peut etre supprimee apres adaptation de help.ts (qui est son seul importeur). Cette analyse est incomplete : `gate-persistence.ts` elle-meme importe `DeterministicCheckResult` et `RubricDimension` depuis `gate-evaluator.ts` (ligne 8). Si `gate-evaluator.ts` est supprime en etape 6 (apres adaptation de help.ts en etape 1), et `gate-persistence.ts` est supposee etre supprimee dans la meme vague, l'ordre doit etre : supprimer `gate-evaluator.ts` ET `gate-persistence.ts` dans le meme commit. La spec dit que `gate-persistence.ts` doit etre supprimee "apres adaptation de help.ts" mais ne la liste pas explicitement dans la liste des suppressions de la section 4. Elle n'est pas dans la liste "Fichiers supprimes (src/)".
- Evidence : `grep -n "^import" src/gate-persistence.ts` → ligne 8 : `import type { DeterministicCheckResult, RubricDimension } from "./gate-evaluator.ts"`. La section 4 ne liste pas `gate-persistence.ts` dans les fichiers supprimes.
- Impact : Ambiguite implementeur : gate-persistence.ts est-elle supprimee ou conservee ? Si conservee, typecheck echoue apres suppression de gate-evaluator.ts. Si supprimee, la section 4 et V-criteres sont incomplets.
- Resolution suggeree : Ajouter explicitement `src/gate-persistence.ts` dans la liste des fichiers supprimes (section 4) et dans V3. Ajouter un V-critere ou note : "gate-persistence.ts est supprimee en meme temps que gate-evaluator.ts". Supprimer aussi `tests/unit/gate-persistence.test.ts` de la liste des suppressions explicites (deja mentionne) — verifier.

**[MAJEUR] F-DA-4 — 3 fichiers test prd-workflow ne sont pas dans la liste de suppression alors qu'ils importent des modules cibles**

- Source : Section 4 (Fichiers supprimes, tests/), R5/R6
- Description : La spec liste `tests/unit/prd-workflow-integration.test.ts` comme "Supprimer ou adapter" (section 4) et mentionne qu'elle importe `conversation-session` et `pipeline-selection`. Or 3 autres fichiers test prd-workflow ne sont pas analyses : (a) `tests/unit/prd-workflow-comprehensive.test.ts` importe `explainPipelineChoice` depuis `pipeline-selection.ts` (ligne 24) et des symboles depuis `conversation-session.ts` et `prd-workflow.ts` — si pipeline-selection est supprime, ce test doit etre adapte ou supprime ; (b) `tests/unit/prd-workflow-e2e-junctions.test.ts` importe depuis `conversation-session.ts` et `prd-workflow.ts` — selon R6, adapter (pas supprimer) si prd-workflow reste actif ; (c) `tests/unit/prd-workflow.test.ts` importe exclusivement depuis `conversation-session.ts`, `prd.ts`, et `prd-workflow.ts` — si prd-workflow reste actif (vague 1), ce test reste valide ; si elle est supprimee, tous ces tests sont supprimer.
- Evidence : `grep "from.*pipeline-selection" tests/unit/prd-workflow-comprehensive.test.ts` → ligne 24. `grep "from.*pipeline-selection" tests/unit/prd-workflow-e2e-junctions.test.ts` → zero resultat.
- Impact : CI echoue si pipeline-selection est supprime et prd-workflow-comprehensive.test.ts n'est pas adapte (V4 echoue).

**[MAJEUR] F-DA-5 — R11 sous-specifie l'adaptation de `zz-messages.ts` : conversation-session reste utilise apres adaptation**

- Source : R11, Section 7.2 (etape 2)
- Description : R11 dit "retirer les imports de prd.ts, prd-workflow.ts, command-router.ts, conversation-session.ts". Mais la verification du code montre que `zz-messages.ts` utilise `addConstraint`, `addIntent`, `addMessage`, `extractConstraints`, `formatSessionForIntent`, `getSession` depuis `conversation-session.ts` — ces fonctions sont utilisees pour le tracking de session conversationnelle independamment du proposal routing. R11 ne peut pas retirer TOUS les imports de `conversation-session.ts`, seulement le type `PendingProposal` (lie au proposal routing). Les autres imports (`getSession`, `addConstraint`, etc.) restent necessaires pour la conversation naturelle. La spec dit "conversation naturelle directe" mais zz-messages.ts continue d'avoir besoin de la session pour le contexte.
- Evidence : `grep -n "from.*conversation-session" src/commands/zz-messages.ts` → lignes 22 (PendingProposal) et 30 (6 autres imports). Seul `PendingProposal` est lie au proposal routing.
- Impact : Si R11 est applique tel quel (retrait de TOUS les imports de conversation-session), zz-messages.ts casse le tracking conversationnel. V5 echoue.

**[MAJEUR] F-DA-6 — V20 (grep zero resultat) est incompatible avec les imports actifs de `AgentRole`, `feedback-loop`, `agent-context`**

- Source : V20 / Section 8
- Description : V20 stipule "Aucun fichier conserve n'importe un module supprime". Le pattern grep de V20 inclut `from.*orchestrator`. Or `feedback-loop.ts` (conserve), `agent-context.ts` (conserve), `mcp-config.ts` (conserve) importent tous `AgentRole` depuis `./orchestrator.ts`. Ces fichiers ne sont pas dans la liste de suppression. Si le type n'est pas migre (F-DA-1), V20 ne peut pas passer.
- Evidence : Consequence directe de F-DA-1.
- Impact : V20 sera en echec en l'etat.

**[MINEUR] F-DA-7 — La spec indique que `prd_workflow` est dans R8 (7 entrees) mais l'action-registry a un module "planning" pour prd_workflow**

- Source : R8 / Section 2
- Description : R8 dit "Retirer de `action-registry.ts` les 6 entrees correspondant aux commandes supprimees (exec, orchestrate, autopipeline, plan, prd, planify) + prd_workflow" — cela fait 7. Verification : `grep -n "module.*planning\|prd_workflow" src/action-registry.ts` confirme que `prd_workflow` est listee avec `module: "planning"` (ligne 276). La suppression de 7 entrees est correcte (exec=1, orchestrate=1, autopipeline=1, plan=1, prd=2, planify=1, prd_workflow=1). Mais R8 dit "6 entrees... + prd_workflow" alors que prd a 2 entrees distinctes (create_prd et view_prd). Le decompte detaille serait : 8 entrees totales supprimees pour 7 commandes. L'ambiguite est mineure mais peut induire l'implementeur en erreur.
- Impact : Faible. L'implementeur doit supprimer toutes les entrees avec module="execution" ou module="planning".

**[MINEUR] F-DA-8 — `tests/unit/logger-migration.test.ts` reference `gate-persistence.ts` explicitement**

- Source : Section 4 (Fichiers modifies/supprimes), R16
- Description : `tests/unit/logger-migration.test.ts` contient 3 references directes a `gate-persistence.ts` (lignes 63, 74, 190-192) : une assertion que `gate-persistence.ts` utilise `console.error` uniquement dans les string literals. Si `gate-persistence.ts` est supprimee en vague 1, ce test devient invalide et doit etre adapte. La spec (R16) parle uniquement de `coding-standards.test.ts`, pas de `logger-migration.test.ts`.
- Evidence : `grep -n "gate-persistence" tests/unit/logger-migration.test.ts` → lignes 63, 74, 190, 191, 192.
- Impact : CI echoue si `logger-migration.test.ts` essaie de lire un fichier supprime (readFileSync sur `gate-persistence.ts`).

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — `prd-workflow.ts` et `prd.ts` : chaine de dependances cascade non resolue en vague 1**

- Scenario : Apres adaptation de `zz-messages.ts` (R11 : retirer import de prd-workflow.ts) et adaptation de `jobs.ts` (R12 : retirer import de prd.ts), il reste un importeur de `prd.ts` : `mcp/memory-server.ts` (ligne 437). La spec prevoit d'adapter mcp/memory-server.ts (R19) pour retirer ses imports (dont prd). Mais `prd.ts` importe `buildAgentSystemPrompt` depuis `bmad-agents.ts` (ligne 19) qui reste actif. Si `prd.ts` n'est pas supprimee (elle a encore un importeur via mcp/memory-server.ts avant adaptation R19), et si `prd-workflow.ts` reste active (importee par... zz-messages.ts avant R11), la cascade est : R11 libere prd-workflow.ts de zz-messages, puis prd-workflow.ts n'a plus d'importeur actif → elle peut etre supprimee → mais prd.ts a encore mcp/memory-server.ts comme importeur. La spec dit "prd.ts : jobs.ts, zz-messages.ts → adapter jobs.ts et zz-messages.ts d'abord" mais oublie mcp/memory-server.ts qui sera adapte separement (R19). L'ordre garantit-il que mcp/memory-server.ts est adapte avant verification V7 ?
- Source : Section 7.2 (ordre de suppression), R19, Section 7.1 (prd.ts conserve)
- Impact : Si R19 n'est pas applique en etape 4 (avant la suppression des modules en etape 6), `mcp/memory-server.ts` reste importeur actif de `prd.ts` apres les adaptations etapes 1-3. La spec dit bien "etape 4 : adapter mcp/memory-server.ts", ce qui est correct. Mais l'implementeur pourrait interpreter "retirer imports orchestrator/prd/story-files/cost-estimate/pipeline-selection" et supprimer l'usage de prd en etape 4, puis prd.ts devient une feuille... sauf que prd-workflow.ts l'importe encore si elle n'est pas supprimee. La spec laisse `prd-workflow.ts` dans les fichiers conserves (section 7.1). Confirmation : `prd-workflow.ts` importe `prd.ts` (ligne 27). L'adaptation de `zz-messages.ts` (R11) retire l'import de `prd-workflow.ts` depuis `zz-messages.ts`, mais `prd-workflow.ts` elle-meme reste ACTIVE. Donc `prd.ts` a `prd-workflow.ts` comme importeur actif. `prd.ts` ne peut pas etre supprimee en vague 1.
- Frequence estimee : Certain — la spec dit "prd.ts est conserve en vague 1" (section 7.1). La V7 ne cible pas prd.ts.

**[MAJEUR] F-EC-2 — `agent-messaging.ts` : importeur unique actif est `commands/help.ts`, qui est adapte en vague 1 (R10)**

- Scenario : `agent-messaging.ts` est importe par (a) `orchestrator/pipeline.ts` (cible de suppression) et (b) `commands/help.ts`. R10 prevoit d'adapter `help.ts` en retirant les imports de `agent-messaging.ts` (formatMessageFlow, getAgentMessages, getMessageFlowSummary). Apres R10, `agent-messaging.ts` n'a plus d'importeur actif → elle devient une feuille supprimable. Or `agent-messaging.ts` importe `agent-events.ts` (emitAgentEvent). Apres suppression de `agent-messaging.ts`, `agent-events.ts` n'a plus que `commands/help.ts` (R10 retire cet import aussi) et `orchestrator/pipeline.ts` (cible). Donc `agent-events.ts` devient aussi une feuille. Ni `agent-messaging.ts` ni `agent-events.ts` ne sont dans la liste de fichiers supprimes (section 4). Leurs tests (`tests/unit/agent-messaging.test.ts`, `tests/unit/agent-events.test.ts`) restent et essaient d'importer des modules qui existent toujours... mais si personne n'importe ces modules, ils sont code mort.
- Source : Section 4, Section 7.1
- Impact : Pas un BLOQUANT pour V5/V4 (les modules existent, les tests passent). Mais c'est du code mort post-vague 1 non identifie. Le spec devrait soit les supprimer, soit les conserver explicitement.
- Frequence estimee : Certain — l'analyse des importeurs est completable par grep.

**[MAJEUR] F-EC-3 — `sdd-agents.test.ts` reference "gate-persistence" dans sa liste de modules interdits**

- Scenario : `tests/unit/sdd-agents.test.ts` ligne 116 verifie que `sdd-agents.ts` n'importe pas `gate-persistence`. Si `gate-persistence.ts` est supprimee (F-DA-3 confirme qu'elle doit l'etre), ce test devient bizarrement plus "faux positif" : il verifie l'absence d'un import vers un module qui n'existe plus. Ce n'est pas bloquant mais le test doit etre nettoye (retirer `gate-persistence` de la liste des modules interdits, ou la remplacer par une assertion plus pertinente).
- Source : R16 (coding-standards.test.ts), non mentionne pour sdd-agents.test.ts
- Impact : Faible — le test continue de passer (sdd-agents.ts n'importe pas gate-persistence), mais l'assertion devient sans objet.

**[MAJEUR] F-EC-4 — `tests/unit/cost-estimate.test.ts` importe `bmad-agents.ts` via `cost-estimate.ts` : indirectement dependant de `story-files.ts`**

- Scenario : `bmad-agents.ts` importe `buildStoryFile` et `formatStoryForAgent` depuis `story-files.ts`. `cost-estimate.ts` importe `getAgents` depuis `bmad-agents.ts`. `utilities.ts` importe `estimateSprintCost` depuis `cost-estimate.ts`. La chaine `cost-estimate → bmad-agents → story-files` est active. `story-files.ts` est conserve en vague 1 (section 7.1 : "bmad-agents.ts l'importe → vague 2"). Pas de probleme de suppression ici. Mais si quelqu'un verifie V7 (`from.*auto-pipeline` dans la section des modules non-supprimes), `auto-pipeline.ts` importe aussi `story-files.ts` — auto-pipeline.ts est supprime, ce qui est correct. La verification statique de V7 est donc correcte. Pas de BLOQUANT.
- Source : V7, Section 5
- Impact : Faible, confirmation que V7 est valide pour story-files.ts.
- Frequence estimee : Non applicable (absence de probleme confirmee).

**[MAJEUR] F-EC-5 — R9 : l'adaptation de `intent-detection.ts` laisse `prd_workflow` avec `command: "prd_workflow"` dans INTENT_PATTERNS**

- Scenario : R9 dit "Retirer de `intent-detection.ts` les patterns pointant vers exec, orchestrate, plan, prd, prd_workflow". Verification : `grep -n "prd_workflow\|prd\b\|exec\b\|orchestrate\b\|plan\b" src/intent-detection.ts` confirme que `prd_workflow` apparait comme `command: "prd_workflow"` (ligne 243) dans un pattern intent `suggest_prd`. V12 verifie `grep "\"exec\"\|\"orchestrate\"\|\"plan\"\|\"prd\"\|\"prd_workflow\""`. Or le pattern contient aussi `command: "prd"` (lignes 207, 228) pour les intents `view_prd` et `create_prd`. Ces intents pointeraient vers `prd` qui n'existe plus comme commande. La spec devrait clarifier : ces intents doivent-ils pointer vers une autre commande (ex: le flow conversationnel naturel) ou etre entierement supprimes ?
- Source : R9, V12
- Impact : Si les patterns prd/prd_workflow ne sont pas retires, `intent-detection.ts` route vers des commandes inexistantes → comportement inattendu. Le V12 grep verifie l'absence, mais la question semantique reste : que fait le bot si l'intent "view_prd" est detecte et que la commande "/prd" n'existe plus ?

**[MINEUR] F-EC-6 — V3 liste "14 modules feuilles" mais la liste reelle contient 15 entrees (orchestrator barrel + 4 sous-modules + 9 autres + gate-persistence)**

- Scenario : V3 dit "14 modules feuilles (orchestrator barrel, 4 sous-modules, blackboard, deliberation, adversarial-verifier, pipeline-selection, pipeline-state, llm-router, agent-schemas, gate-evaluator, auto-pipeline)". Decompte : barrel(1) + sous-modules(4) + blackboard + deliberation + adversarial-verifier + pipeline-selection + pipeline-state + llm-router + agent-schemas + gate-evaluator + auto-pipeline = 14. Mais si gate-persistence.ts est aussi supprimee (F-DA-3), le total est 15. Le V-critere V3 doit etre mis a jour.
- Source : V3 / Section 8
- Impact : Mineur — l'implementeur peut compter, mais le V-critere dit "14" et en verifie moins.

**[MINEUR] F-EC-7 — V14 liste "21 fichiers de tests supprimes" mais la section 4 en contient 21, sans compter gate-persistence.test.ts et logger-migration adaptations**

- Scenario : La section 4 liste 21 tests supprimes. `gate-persistence.test.ts` est dans la liste. Mais `logger-migration.test.ts` n'est pas dans la liste de suppression alors qu'il reference `gate-persistence.ts` (F-DA-8). V14 verifie "les 21 fichiers". Si `gate-persistence.test.ts` est supprime mais `logger-migration.test.ts` est adapte, V14 reste a 21. Coherent.
- Impact : Mineur — confirme que V14 est correct si logger-migration.test.ts est adapte (pas supprime).

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — La spec introduit un nouveau module `src/agent-types.ts` implicitement sans le documenter**

- Source : Section 2 (R7 description), F-DA-1 (consequence)
- Description : Pour resoudre le BLOQUANT F-DA-1 (migration de `AgentRole` hors de `orchestrator/types.ts`), l'implementeur devra creer un nouveau module ou modifier un module existant. La spec ne dit rien de ce choix architectural. Si `AgentRole` est defini dans `bmad-agents.ts` (conservation), cela cree une dependance `feedback-loop.ts → bmad-agents.ts` qui n'existait pas. Si un nouveau fichier `agent-types.ts` est cree, la section 4 (fichiers modifies) et CLAUDE.md doivent etre mis a jour. La spec aurait du prevoir cette migration explicitement.
- Alternative simple : deplacer `AgentRole` dans `src/bmad-agents.ts` (deja importe par agent.ts, quality.ts, help.ts, trust-scores.ts) et mettre a jour les 4 imports de `feedback-loop`, `agent-context`, `mcp-config`, `prd-workflow`. Zero nouveau fichier.
- Impact : Sans instruction, l'implementeur fait un choix non coordonne avec le projet.

**[MAJEUR] F-SS-2 — La suppression en cascade de modules produit une dette de code mort non identifiee**

- Source : Section 4, F-EC-2
- Description : Apres adaptation de `help.ts` (R10 retire les imports de `agent-messaging.ts` et `agent-events.ts`), ces deux modules deviennent des feuilles sans importeur. Or la spec ne les supprime pas. Ils rejoignent une liste de code mort non visible : des modules qui "existent" mais que personne n'importe. Le meme phenomene peut se produire pour d'autres modules (ex: `spec-lite.ts` et `adversarial-challenge.ts` qui n'existent pas encore selon l'exploration mais dont les tests pourraient pointer vers eux). La spec devrait soit documenter explicitement les modules qui deviennent feuilles mais sont conserves intentionnellement (ex: pour les vagues suivantes), soit les supprimer en vague 1.
- Impact : Maintenabilite : le projet accumule du code mort invisible. L'absence d'importeurs ne declenche pas d'erreur de compilation.

**[MINEUR] F-SS-3 — L'ordre de suppression de la section 7.2 cree un risque de typecheck partiel entre etapes**

- Source : Section 7.2 (Ordre de suppression)
- Description : L'etape 6 de l'ordre suggere de "Supprimer les modules devenus feuilles" dans le meme commit. En pratique, si l'implementeur fait des commits incrementaux (un commit par etape), le typecheck entre etapes 5 et 6 echouera : apres suppression de `commands/execution.ts` et `commands/planning.ts` (etape 5), les imports depuis ces fichiers dans les tests non encore adaptes (etape 9) provoquent des erreurs. La spec suppose un seul commit atomique mais ne le dit pas explicitement.
- Clarification suggeree : Preciser que toutes les etapes 1-9 doivent etre dans un seul commit atomique, ou que `bun test` n'est lance qu'apres l'etape 9.

**[MINEUR] F-SS-4 — V10 (tests manuels Telegram) ne peut pas etre verifie en CI et n'est pas realiste pour un pipeline CI/CD**

- Source : V10 / Section 8
- Description : V9 et V10 sont des V-criteres manuels (inspection humaine du bot Telegram). La spec les inclut dans la liste de validation sans les separer clairement des V-criteres automatisables. Dans un workflow CI/CD, V1-V8 et V11-V20 sont automatisables. V9/V10 sont des criteres post-deploy. L'absence de cette distinction peut conduire l'implementeur a attendre une validation manuelle bloquante avant de merger.
- Alternative : Marquer V9 et V10 comme "post-deploy / validation manuelle" hors du gate CI.

---

## Findings partages (credites a plusieurs agents)

| Finding | Agents | Severite |
|---------|--------|----------|
| AgentRole : 4 importeurs actifs non migres | F-DA-1, F-DA-6, F-SS-1 | BLOQUANT |
| pipeline-selection.ts : prd-workflow.ts restant importeur | F-DA-2, F-EC-1 | BLOQUANT |
| gate-persistence.ts : absence de la liste de suppression explicite | F-DA-3, F-EC-6 | BLOQUANT |
| prd-workflow test files non analyses (comprehensive, e2e-junctions) | F-DA-4, F-EC-2 | MAJEUR |
| agent-messaging.ts / agent-events.ts deviennent code mort non identifie | F-EC-2, F-SS-2 | MAJEUR |

---

## Recommandations (actions pour passer a GO)

1. **[Critique] Migrer `AgentRole` hors de `orchestrator/types.ts`** : ajouter une regle dans Section 2 stipulant que `AgentRole` (et `AgentRole` uniquement) est deplace dans `src/bmad-agents.ts` (conserve) ou un nouveau `src/agent-types.ts`. Lister les 4 imports a mettre a jour (`feedback-loop.ts`, `agent-context.ts`, `mcp-config.ts`, `prd-workflow.ts`) dans la section 4 "Fichiers modifies". Mettre a jour V7 en consequence (le pattern grep ne doit pas cibler `from.*orchestrator` dans ces 4 fichiers apres migration).

2. **[Critique] Decider du sort de `prd-workflow.ts` en vague 1** : deux options mutuellement exclusives : (a) supprimer `prd-workflow.ts` en vague 1 (elle n'a plus d'importeur apres R11 + gate-evaluator supprime) — cela resout automatiquement le BLOQUANT pipeline-selection.ts ; (b) conserver `prd-workflow.ts` et adapter en retirant ses imports de `pipeline-selection.ts` et `llm-router.ts`. L'option (a) est plus simple mais exige d'ajouter `prd-workflow.ts` et ses tests (`prd-workflow.test.ts`, `prd-workflow-comprehensive.test.ts`, `prd-workflow-e2e-junctions.test.ts`) dans les suppressions. L'option (b) exige une regle R20bis et d'adapter `prd-workflow-integration.test.ts`, `prd-workflow-comprehensive.test.ts`.

3. **[Critique] Ajouter explicitement `gate-persistence.ts` dans la liste des suppressions** : ajouter a la section 4 "Fichiers supprimes (src/) : `src/gate-persistence.ts` (222 LOC)". Ajouter dans V3. Confirmer que `gate-persistence.test.ts` est bien dans les 21 suppressions de tests. Adapter `logger-migration.test.ts` (retirer les 3 references a `gate-persistence.ts`).

4. **[Important] Clarifier R11** : R11 doit specifier que seul l'import de `PendingProposal` et le code de proposal routing sont retires depuis `conversation-session.ts`. Les imports `addConstraint`, `addIntent`, `addMessage`, `extractConstraints`, `formatSessionForIntent`, `getSession` restent necessaires pour le tracking conversationnel.

5. **[Important] Analyser et decider pour `agent-messaging.ts` et `agent-events.ts`** : apres R10 (retrait de leurs imports dans help.ts) et suppression de `orchestrator/pipeline.ts`, ces deux modules n'ont plus d'importeurs. Soit les ajouter aux suppressions de vague 1 (avec leurs tests), soit les marquer explicitement "conserver pour vague 2" dans section 7.1.

6. **[Important] Completer l'analyse des tests prd-workflow** : `prd-workflow-comprehensive.test.ts` importe `explainPipelineChoice` depuis `pipeline-selection.ts`. Si pipeline-selection.ts est supprimee, ce test doit etre adapte ou supprime. Ajouter a la section 4.

7. **[Souhaitable] Corriger V3** : mettre a jour le compte de "14 modules feuilles" selon la decision sur gate-persistence.ts.

8. **[Souhaitable] Separer V9/V10** : marquer "validation manuelle post-deploy" separement des V-criteres CI dans la section 8.

---

## Points forts identifies

- **Graphe de dependances globalement correct** : les suppressions principales (orchestrator/, blackboard, deliberation, pipeline-state, agent-schemas, gate-evaluator) sont bien identifiees comme feuilles. L'ordre en 10 etapes est logiquement structure.
- **Pattern grep avant suppression** : la methode "grep avant chaque suppression" (section 6.1) est la bonne pratique pour eviter les suppressions erronees.
- **story-files.ts conserve correctement** : l'analyse de bmad-agents.ts → story-files.ts est correcte. La spec a identifie ce cas et l'a reporte explicitement.
- **V20 ambitieux mais utile** : le V-critere transversal "aucun fichier conserve n'importe un module supprime" est la meilleure garantie de typecheck apres vague. Il doit etre corrige (F-DA-1) mais son principe est le bon.
- **R10, R11, R12, R19 bien identifies** : les adaptations des modules Composer (help, zz-messages, jobs) et du MCP server sont correctement listees avec leur justification.
- **Non-regression des tests conserves** : la section 7.5 identifie correctement `conversation-handoff.test.ts` et `pipeline-tracker.test.ts` comme tests qui deviennent "plus vrais" apres la vague — analyse fine.
- **Loader auto-discovery** : le pattern loader (section 6.3) est correctement applique — supprimer le fichier suffit pour decharger le Composer.

---

## Etape suivante

Verdict **GO WITH CHANGES** : les 3 BLOQUANTs sont resolubles par des corrections textuelles de la spec et un choix architectural explicite (migration AgentRole, sort de prd-workflow.ts, ajout de gate-persistence.ts dans les suppressions). Aucun ne remet en cause le perimetre de la vague.

Corrections minimales requises avant implementation :
1. Migration `AgentRole` : choisir la destination, ajouter les 4 adaptations de fichiers actifs.
2. `prd-workflow.ts` : choisir entre suppression (option recommandee, plus simple) ou adaptation (retrait des imports pipeline-selection / llm-router).
3. `gate-persistence.ts` : ajouter dans la liste des suppressions de la section 4 et V3.

Apres corrections, lancer :
```
/dev-implement "Implementer SPEC-suppression-orchestration-vague-1. Spec: docs/specs/SPEC-suppression-orchestration-vague-1.md. Review: docs/reviews/adversarial-SPEC-suppression-orchestration-vague-1.md"
```
