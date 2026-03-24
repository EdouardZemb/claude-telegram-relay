---
spec_id: suppression-orchestration-vague-1
phase: 1-spec
generated_at: "2026-03-24T17:00:00Z"
status: ready
author: spec-architect
reference_exploration: docs/explorations/EXPLORE-phase-4-suppression-orchestration.md
---

# SPEC — Suppression Orchestration Vague 1

## 1. Objectif

Supprimer `commands/execution.ts` et `commands/planning.ts` (1 495 LOC, 7 commandes bot), puis supprimer tous les modules source qui deviennent des feuilles pures sans importeur actif apres cette suppression. Cette vague debloque la plus grande partie de la Phase 4 de ARCHITECTURE-V2 : les deux Composers sont les principaux consommateurs de l'orchestration TypeScript et leur retrait libere 14+ modules en cascade. Les commandes remplacees par le flow SDD (`/exec`, `/orchestrate`, `/autopipeline`, `/plan`, `/prd`, `/planify`, `/prd_workflow`) disparaissent du bot.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Supprimer `commands/execution.ts` en entier — commandes /exec, /orchestrate, /autopipeline remplacees par sdd-flow.ts | Decision utilisateur | Fichier deleted, loader ne le trouve plus |
| R2 | Supprimer `commands/planning.ts` en entier — commandes /plan, /prd, /planify, /prd_workflow remplacees par la conversation naturelle | Decision utilisateur | Fichier deleted, loader ne le trouve plus |
| R3 | Apres R1+R2, supprimer tout module dont ZERO importeur actif subsiste (verification par grep avant chaque suppression) | Decision utilisateur | `agent-schemas.ts` : seul importeur etait execution.ts (cible) |
| R4 | Ne PAS supprimer un module si un importeur actif non-cible subsiste — la suppression est reportee a une vague ulterieure | Decision utilisateur | `workflow.ts` a encore `patterns.ts` et `quality.ts` comme importeurs actifs |
| R5 | Supprimer les tests qui importent exclusivement des modules supprimes (verification par grep) | Decision utilisateur | `orchestrator.test.ts` importe uniquement `src/orchestrator.ts` |
| R6 | Adapter (pas supprimer) les tests qui importent a la fois des modules supprimes et des modules actifs | Contrainte CI | `command-validators.test.ts` : retirer les imports de execution.ts et planning.ts, garder le reste |
| R7 | Mettre a jour `relay.ts` si ses imports deviennent invalides apres les suppressions | Contrainte typecheck | `relay.ts` importe `conversation-session.ts` (reste actif via zz-messages) → pas de changement |
| R8 | Retirer de `action-registry.ts` les 6 entrees correspondant aux commandes supprimees (exec, orchestrate, autopipeline, plan, prd, planify) + prd_workflow | Contrainte coherence | module: "execution" et module: "planning" disparus |
| R9 | Retirer de `intent-detection.ts` les patterns pointant vers exec, orchestrate, plan, prd, prd_workflow | Contrainte coherence | 6 entrees INTENT_PATTERNS a supprimer |
| R10 | Mettre a jour `commands/help.ts` : retirer les lignes mentionnant les 7 commandes supprimees, retirer les imports invalides (gate-persistence, agent-events, agent-messaging, bmad-agents, conversation-session, trust-scores, feedback-loop) | Contrainte typecheck | formatDoubleLoopRules, getActiveSessionCount, etc. ne sont plus utilises dans help.ts |
| R11 | Mettre a jour `commands/zz-messages.ts` : retirer les imports de prd.ts, prd-workflow.ts, command-router.ts, conversation-session.ts ; retirer le code de proposal routing vers prd_workflow/exec/plan ; retirer la logique de session PendingProposal | Decision utilisateur (conversation naturelle) | mapProposalAction, detectProposalInResponse, PendingProposal → supprimes |
| R12 | Mettre a jour `commands/jobs.ts` : retirer l'import de `prd.ts` (formatPRDDetail, getPRD) et le dynamic import de `auto-pipeline.ts` dans le handler jc_batch_retry | Contrainte typecheck | jobs.ts garde les fonctions non-prd |
| R13 | Adapter `loader.test.ts` : retirer execution.ts et planning.ts de la liste attendue des composers charges, mettre a jour le compte | Contrainte CI | expected array a 12 elements au lieu de 14 |
| R14 | Adapter `action-registry.test.ts` : retirer les assertions sur exec, orchestrate, autopipeline, plan, prd, planify | Contrainte CI | expect(commands).toContain("orchestrate") → supprimer |
| R15 | Adapter `intent-detection.test.ts` : retirer les tests de detection de plan, exec, orchestrate, prd, prd_workflow | Contrainte CI | Tests "detects plan intent", "detects resume intent" → supprimer |
| R16 | Adapter `coding-standards.test.ts` : retirer les references a "commands/execution.ts" et "commands/planning.ts" dans les assertions LOC et env vars | Contrainte CI | Maps de LOC et env vars a nettoyer |
| R17 | Supprimer `command-validators.test.ts` en entier — il n'importe que ExecCommandSchema, OrchestrateCommandSchema, PrdCommandSchema (tous supprimes) | Contrainte CI | Seul fichier du test qui n'a plus de sujet de test valide |
| R18 | Adapter `mcp-orchestration-tools.test.ts` : l'assertion "28 total tools" et les assertions sur orchestrate_task/prd_create/pipeline_selection devront etre revues selon l'etat du MCP server apres la vague | Contrainte CI (deferred) | MCP server adaptation = post-vague |
| R19 | Le MCP server (`mcp/memory-server.ts`) importe orchestrator, prd, story-files, cost-estimate, pipeline-selection → ces imports deviennent invalides apres la vague ; adapter le MCP server dans le meme commit | Contrainte typecheck | mcp/memory-server.ts ligne 428-439 |
| R20 | `bun test` doit passer apres la vague — zero test en echec | Contrainte CI | Gate de validation finale |

## 3. Donnees d'entree

| Source | Type | Acces | Champs |
|--------|------|-------|--------|
| `src/commands/execution.ts` | Fichier TS (648 LOC) | Suppression | Commandes /exec, /orchestrate, /autopipeline, schemas Zod exportes |
| `src/commands/planning.ts` | Fichier TS (847 LOC) | Suppression | Commandes /plan, /prd, /planify, /prd_workflow, schema PrdCommandSchema |
| `docs/explorations/EXPLORE-phase-4-suppression-orchestration.md` | Exploration | Lecture | Graphe de dependances, classification Groupe A/B/C, ordre de suppression |
| Graphe d'imports (grep) | Analyse statique | Grep au moment de l'implementation | Liste des importeurs actifs par module cible |
| `tests/unit/` (120+ fichiers) | Fichiers TS test | Grep + suppression/adaptation | Imports vers modules supprimes |

## 4. Donnees de sortie

La vague 1 produit les changements suivants dans le depot :

**Fichiers supprimes (src/) :**
- `src/commands/execution.ts` (648 LOC)
- `src/commands/planning.ts` (847 LOC)
- `src/orchestrator.ts` (barrel, 41 LOC)
- `src/orchestrator/types.ts` (95 LOC)
- `src/orchestrator/agent-step.ts` (262 LOC)
- `src/orchestrator/pipeline.ts` (1 096 LOC)
- `src/orchestrator/format.ts` (188 LOC)
- `src/blackboard.ts` (653 LOC)
- `src/deliberation.ts` (150 LOC)
- `src/adversarial-verifier.ts` (342 LOC)
- `src/pipeline-selection.ts` (310 LOC)
- `src/pipeline-state.ts` (258 LOC)
- `src/llm-router.ts` (465 LOC)
- `src/agent-schemas.ts` (1 091 LOC)
- `src/gate-evaluator.ts` (927 LOC)
- `src/auto-pipeline.ts` (393 LOC) — seuls importeurs etaient execution.ts, planning.ts, jobs.ts (dynamic import)
- `src/story-files.ts` (351 LOC) — seuls importeurs actifs etaient execution.ts, planning.ts, orchestrator/pipeline.ts (cible), auto-pipeline.ts (cible), prd-workflow.ts (cible), bmad-agents.ts (qui reste active via agent.ts → a reverifier par grep)

**Note sur story-files.ts :** `bmad-agents.ts` importe `buildStoryFile` et `formatStoryForAgent` depuis `story-files.ts`. `bmad-agents.ts` est lui-meme importe par `agent.ts` (actif), `commands/quality.ts` (actif), `commands/help.ts` (actif). Donc `story-files.ts` a un importeur actif indirect via `bmad-agents.ts`. Il NE PEUT PAS etre supprime en vague 1. Il passe en vague 2 apres decouplage de bmad-agents.

**Revision : story-files.ts reste (importeur actif : bmad-agents.ts).**

**Fichiers supprimes (tests/) :**
- `tests/unit/command-validators.test.ts` (importe exclusivement des schemas supprimes)
- `tests/unit/orchestrator.test.ts`
- `tests/unit/orchestrator-deliberation.test.ts`
- `tests/unit/gate-evaluator.test.ts`
- `tests/unit/gate-persistence.test.ts`
- `tests/unit/rubric-scoring.test.ts`
- `tests/unit/dual-verification.test.ts`
- `tests/unit/deliberation.test.ts`
- `tests/unit/adversarial-verifier.test.ts`
- `tests/unit/agent-schemas.test.ts`
- `tests/unit/parallel-blackboard.test.ts`
- `tests/unit/pipeline-selection.test.ts`
- `tests/unit/pipeline-state.test.ts`
- `tests/unit/llm-router.test.ts`
- `tests/unit/auto-pipeline.test.ts`
- `tests/unit/batch-parallel.test.ts`
- `tests/unit/adaptive-pipeline.test.ts`
- `tests/unit/s38-integration.test.ts` (importe blackboard, agent-schemas)
- `tests/unit/tavily-research.test.ts` (importe orchestrator, llm-router)
- `tests/unit/trust-integration.test.ts` (importe gate-evaluator)
- `tests/integration/mcp-blackboard.test.ts`

**Fichiers modifies (adaptes) :**
- `src/action-registry.ts` — retirer les 7 entrees des commandes supprimees
- `src/intent-detection.ts` — retirer les patterns vers exec, orchestrate, plan, prd, prd_workflow
- `src/commands/help.ts` — retirer lignes des commandes supprimees + imports invalides
- `src/commands/zz-messages.ts` — retirer imports prd, prd-workflow, command-router, conversation-session ; retirer proposal routing
- `src/commands/jobs.ts` — retirer import prd.ts et dynamic import auto-pipeline.ts (handler jc_batch_retry)
- `mcp/memory-server.ts` — retirer imports orchestrator, prd, story-files, cost-estimate, pipeline-selection ; retirer ou stub les outils MCP correspondants
- `tests/unit/loader.test.ts` — retirer execution.ts et planning.ts de la liste expected
- `tests/unit/action-registry.test.ts` — retirer assertions exec/orchestrate/autopipeline/plan/prd/planify
- `tests/unit/intent-detection.test.ts` — retirer tests de detection plan/exec/orchestrate/prd/prd_workflow
- `tests/unit/coding-standards.test.ts` — retirer references aux deux fichiers supprimes
- `tests/unit/prd-workflow-integration.test.ts` — importe conversation-session et pipeline-selection (tous deux cibles) → supprimer ou adapter
- `CLAUDE.md` — retirer les lignes de description des modules supprimes dans la table Source Modules et dans le tableau Telegram Commands

**Etat apres vague 1 :**
- Nombre de commandes bot : ~15 (contre ~30 avant)
- LOC supprimes : ~8 600 LOC source + ~3 000 LOC tests (estimation)
- `bun test` : vert

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/commands/execution.ts` | Supprimer | Composer a remplacer par sdd-flow (R1) |
| `src/commands/planning.ts` | Supprimer | Composer a remplacer par conversation (R2) |
| `src/orchestrator.ts` | Supprimer | Barrel feuille apres suppression de execution.ts (R3) |
| `src/orchestrator/types.ts` | Supprimer | Feuille pure : importeurs = orchestrator barrel (cible) |
| `src/orchestrator/agent-step.ts` | Supprimer | Feuille pure : importeur = orchestrator barrel (cible) |
| `src/orchestrator/pipeline.ts` | Supprimer | Feuille pure : importeur = orchestrator barrel (cible) |
| `src/orchestrator/format.ts` | Supprimer | Feuille pure : importeur = orchestrator barrel (cible) |
| `src/blackboard.ts` | Supprimer | Feuilles : agent-messaging (cible vague 2), pipeline-state (cible) |
| `src/deliberation.ts` | Supprimer | Feuille pure : importeur = orchestrator barrel (cible) |
| `src/adversarial-verifier.ts` | Supprimer | Aucun importeur actif |
| `src/pipeline-selection.ts` | Supprimer | Importeurs : orchestrator barrel (cible), prd-workflow (actif indirect) → verifier |
| `src/pipeline-state.ts` | Supprimer | Importeur = execution.ts (cible) |
| `src/llm-router.ts` | Supprimer | Importeurs : pipeline-selection (cible), prd-workflow (actif) → verifier |
| `src/agent-schemas.ts` | Supprimer | Importeurs : execution.ts (cible), deliberation (cible), pipeline-state (cible) |
| `src/gate-evaluator.ts` | Supprimer | Aucun importeur actif direct (trust-integration.test.ts = test seul) |
| `src/auto-pipeline.ts` | Supprimer | Importeurs actifs : execution.ts (cible), planning.ts (cible), jobs.ts (dynamic import → retirer) |
| `src/story-files.ts` | **Conserver** | bmad-agents.ts (actif) importe buildStoryFile — reportee vague 2 |
| `src/action-registry.ts` | Modifier | Retirer 7 entrees (R8) |
| `src/intent-detection.ts` | Modifier | Retirer patterns exec/orchestrate/plan/prd/prd_workflow (R9) |
| `src/commands/help.ts` | Modifier | Retirer commandes + imports invalides (R10) |
| `src/commands/zz-messages.ts` | Modifier | Retirer imports prd/prd-workflow/command-router/conversation-session + code proposal (R11) |
| `src/commands/jobs.ts` | Modifier | Retirer import prd.ts + dynamic import auto-pipeline.ts (R12) |
| `mcp/memory-server.ts` | Modifier | Retirer imports orchestrator/prd/story-files/cost-estimate/pipeline-selection (R19) |
| `tests/unit/command-validators.test.ts` | Supprimer | Importe exclusivement des schemas supprimes (R17) |
| `tests/unit/orchestrator.test.ts` | Supprimer | Importe exclusivement src/orchestrator (R5) |
| `tests/unit/orchestrator-deliberation.test.ts` | Supprimer | Importe orchestrator et deliberation (R5) |
| `tests/unit/gate-evaluator.test.ts` | Supprimer | Importe gate-evaluator (R5) |
| `tests/unit/gate-persistence.test.ts` | Supprimer | Importe gate-persistence (R5) |
| `tests/unit/rubric-scoring.test.ts` | Supprimer | Importe gate-evaluator (R5) |
| `tests/unit/dual-verification.test.ts` | Supprimer | Importe gate-evaluator (R5) |
| `tests/unit/deliberation.test.ts` | Supprimer | Importe deliberation (R5) |
| `tests/unit/adversarial-verifier.test.ts` | Supprimer | Importe adversarial-verifier (R5) |
| `tests/unit/agent-schemas.test.ts` | Supprimer | Importe agent-schemas (R5) |
| `tests/unit/parallel-blackboard.test.ts` | Supprimer | Importe blackboard (R5) |
| `tests/unit/pipeline-selection.test.ts` | Supprimer | Importe pipeline-selection (R5) |
| `tests/unit/pipeline-state.test.ts` | Supprimer | Importe pipeline-state (R5) |
| `tests/unit/llm-router.test.ts` | Supprimer | Importe llm-router (R5) |
| `tests/unit/auto-pipeline.test.ts` | Supprimer | Importe auto-pipeline (R5) |
| `tests/unit/batch-parallel.test.ts` | Supprimer | Importe auto-pipeline (R5) |
| `tests/unit/adaptive-pipeline.test.ts` | Supprimer | Importe agent-schemas et llm-router (R5) |
| `tests/unit/s38-integration.test.ts` | Supprimer | Importe agent-schemas et blackboard (R5) |
| `tests/unit/tavily-research.test.ts` | Supprimer | Importe orchestrator et llm-router (R5) |
| `tests/unit/trust-integration.test.ts` | Supprimer | Importe gate-evaluator (R5) |
| `tests/integration/mcp-blackboard.test.ts` | Supprimer | Importe blackboard (R5) |
| `tests/unit/loader.test.ts` | Modifier | Retirer execution.ts + planning.ts de la liste expected (R13) |
| `tests/unit/action-registry.test.ts` | Modifier | Retirer assertions sur commandes supprimees (R14) |
| `tests/unit/intent-detection.test.ts` | Modifier | Retirer tests plan/exec/orchestrate/prd/prd_workflow (R15) |
| `tests/unit/coding-standards.test.ts` | Modifier | Retirer references aux deux fichiers supprimes (R16) |
| `tests/unit/prd-workflow-integration.test.ts` | Supprimer ou adapter | Importe conversation-session et pipeline-selection (cibles) — a verifier |
| `CLAUDE.md` | Modifier | Retirer modules supprimes de la table Source Modules et Telegram Commands |

**Modules a verifier par grep avant suppression** (imports croisees potentiels) :
- `src/pipeline-selection.ts` : verifier si `prd-workflow.ts` (actif : importe par zz-messages.ts) appelle `explainPipelineChoice` — auquel cas pipeline-selection NE peut pas etre supprime en vague 1
- `src/llm-router.ts` : verifier si `prd-workflow.ts` l'importe directement

**Note sur gate-persistence.ts :** Le rapport d'exploration indique que `commands/help.ts` importe `formatDoubleLoopRules` depuis `gate-persistence.ts`. Comme help.ts sera adapte (R10 — retirer cet import), gate-persistence.ts devient une feuille pure. Il PEUT etre supprime en vague 1 apres adaptation de help.ts.

## 6. Patterns existants

### 6.1 Verification des importeurs actifs (methode grep)

Pattern utilise dans l'exploration pour confirmer qu'un module est une feuille :

```bash
# Avant chaque suppression : verifier zero importeur actif non-cible
grep -rn "from.*<module>" src/ mcp/ --include="*.ts" | grep -v "commands/execution\|commands/planning\|orchestrator/"
```

Reference : exploration section 3.2, tableau complet des dependances.

### 6.2 Suppression de fichier + test associe (pattern existant)

La vague 3 (durcissement standards) a etabli le pattern : supprimer le fichier source ET son fichier test dans le meme commit. Voir `SPEC-durcissement-standards-vague-3.md` section 6.

### 6.3 Loader auto-discovery (src/loader.ts:25-27)

```typescript
for await (const file of glob.scan(commandsDir)) {
  files.push(file);
}
```

Le loader scanne dynamiquement `src/commands/*.ts`. Supprimer un fichier suffit pour le retirer du bot — pas besoin de modifier `relay.ts` ou `loader.ts` pour decharger les Composers.

### 6.4 Pattern d'adaptation de help.ts

`commands/help.ts` importe des modules cibles uniquement pour enrichir `/status`. Le pattern etabli en vague 2 de durcissement est : retirer les imports inutilises, simplifier la commande `/status` pour ne garder que les informations systeme (CPU, memoire, uptime) sans les données d'orchestration.

### 6.5 Pattern d'adaptation de zz-messages.ts

`zz-messages.ts` utilise `PendingProposal` et les sessions de `conversation-session.ts` pour le systeme de "proposal routing" (Claude propose une action, l'utilisateur confirme). Ce systeme est remplace par la conversation naturelle directe. Le pattern de retrait : supprimer le bloc `if (session.pendingProposal && ...)` et les imports associes.

## 7. Contraintes

### 7.1 Modules a conserver imperativement

| Module | Raison de conservation |
|--------|----------------------|
| `src/agent.ts` | `spawnClaude` utilise par `sdd-agents.ts` (actif) |
| `src/bot-context.ts` | `callClaude` est le canal conversation |
| `src/commands/sdd-flow.ts` | Nouveau flow SDD (Phase 2-3) |
| `src/commands/exploration.ts` | Maintenu actif |
| `src/commands/help.ts` | Adapte (pas supprime) |
| `src/commands/zz-messages.ts` | Adapte (pas supprime) |
| `src/commands/quality.ts` | Adapte si besoin |
| `src/commands/jobs.ts` | Adapte (retrait prd + auto-pipeline) |
| `src/story-files.ts` | bmad-agents.ts l'importe → vague 2 |
| `src/workflow.ts` | patterns.ts et quality.ts l'importent → vague 3 |
| `src/feedback-loop.ts` | relay.ts, quality.ts, help.ts → vague 3 |
| `src/conversation-session.ts` | relay.ts, zz-messages.ts, help.ts → vague 3 |
| `src/prd.ts` | jobs.ts, zz-messages.ts → adapter jobs.ts et zz-messages.ts d'abord |
| `src/prd-workflow.ts` | zz-messages.ts → adapter zz-messages.ts d'abord |
| `src/command-router.ts` | zz-messages.ts → adapter zz-messages.ts d'abord |
| `src/bmad-agents.ts` | agent.ts, quality.ts, help.ts → vague 2 |
| `src/gate-persistence.ts` | help.ts importe formatDoubleLoopRules → adapter help.ts d'abord |

**Note critique :** `prd.ts`, `prd-workflow.ts` et `command-router.ts` ont encore des importeurs actifs (`jobs.ts`, `zz-messages.ts`) apres suppression de planning.ts/execution.ts. Ils ne peuvent pas etre supprimes directement. L'adaptation de `jobs.ts` (R12) et `zz-messages.ts` (R11) doit se faire dans le meme commit que leur suppression.

### 7.2 Ordre de suppression dans le commit

Pour eviter les erreurs de typecheck en cours de modification :

1. Adapter `commands/help.ts` (retirer imports gate-persistence, agent-events, agent-messaging, bmad-agents, conversation-session, trust-scores, feedback-loop)
2. Adapter `commands/zz-messages.ts` (retirer imports prd, prd-workflow, command-router, conversation-session + code proposal)
3. Adapter `commands/jobs.ts` (retirer import prd + dynamic import auto-pipeline)
4. Adapter `mcp/memory-server.ts` (retirer imports des 5 modules)
5. Supprimer `commands/execution.ts` et `commands/planning.ts`
6. Supprimer les modules devenus feuilles (orchestrator/, blackboard, deliberation, adversarial-verifier, pipeline-selection, pipeline-state, llm-router, agent-schemas, gate-evaluator, gate-persistence, auto-pipeline)
7. Adapter action-registry.ts, intent-detection.ts, CLAUDE.md
8. Supprimer les tests des modules supprimes
9. Adapter les tests restants (loader, action-registry, intent-detection, coding-standards)
10. `bun test` pour valider

### 7.3 Modules a verifier par grep avant suppression (incertitudes)

- **`src/pipeline-selection.ts`** : `prd-workflow.ts` importe `explainPipelineChoice` (ligne 5 du test prd-workflow-integration). Si `prd-workflow.ts` reste actif (importeur : zz-messages.ts), pipeline-selection.ts a encore un importeur actif → NE PAS supprimer ; adapter zz-messages.ts d'abord pour retirer prd-workflow → puis pipeline-selection devient feuille. Verifier l'ordre.
- **`src/llm-router.ts`** : verifier si prd-workflow.ts l'importe.
- **`src/prd-workflow-integration.test.ts`** : importe `explainPipelineChoice` de pipeline-selection et `getSession` de conversation-session — si les deux sont supprimes, le test peut etre supprime ; sinon adapter.

### 7.4 TypeScript strict

Le projet est en strict mode. Toute suppression d'import laissant des symboles non-utilises ou des imports invalides provoque une erreur de typecheck. La verification via `bun run typecheck` (ou equivalent) est obligatoire avant le commit final.

### 7.5 Ne pas casser les tests existants conserves

Les tests suivants doivent continuer a passer apres la vague :
- Tous les tests des modules conserves (sdd-flow, exploration, help, zz-messages, quality, jobs, memory, tasks, etc.)
- `tests/unit/relay.test.ts` — relay.ts est adapte mais conserve
- `tests/unit/conversation-handoff.test.ts` — verifie explicitement l'ABSENCE d'imports orchestrator/blackboard/agent-schemas/pipeline-state/conversation-session dans les modules actifs. Ces assertions deviennent PLUS vraies apres la vague (les modules sont supprimes), donc le test reste valide.
- `tests/unit/pipeline-tracker.test.ts` — idem

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `src/commands/execution.ts` n'existe plus apres le commit | `ls src/commands/execution.ts` → erreur | unit |
| V2 | `src/commands/planning.ts` n'existe plus apres le commit | `ls src/commands/planning.ts` → erreur | unit |
| V3 | Les 14 modules feuilles (orchestrator barrel, 4 sous-modules, blackboard, deliberation, adversarial-verifier, pipeline-selection, pipeline-state, llm-router, agent-schemas, gate-evaluator, auto-pipeline) n'existent plus | `ls src/{orchestrator.ts,blackboard.ts,...}` → erreur pour chacun | unit |
| V4 | `bun test` passe sans erreur apres la vague | Sortie CI verte, 0 failing tests | integration |
| V5 | `bun run typecheck` (ou equivalent) ne retourne aucune erreur | Zero erreur TS | unit |
| V6 | `grep -rn "from.*commands/execution\|from.*commands/planning" src/ mcp/` retourne zero resultat | Zero ligne | unit |
| V7 | `grep -rn "from.*orchestrator\b\|from.*blackboard\|from.*deliberation\|from.*adversarial-verifier\|from.*pipeline-selection\|from.*pipeline-state\|from.*llm-router\|from.*agent-schemas\|from.*gate-evaluator\|from.*auto-pipeline" src/ mcp/` retourne zero resultat | Zero ligne | unit |
| V8 | Le bot demarre sans erreur (`bun run src/relay.ts`) | Pas de crash au demarrage, log "composers loaded" visible | E2E |
| V9 | `/help` dans Telegram n'affiche plus les commandes /exec, /orchestrate, /autopipeline, /plan, /prd, /planify | Inspection manuelle de la reponse /help | manual |
| V10 | `/exec`, `/orchestrate`, `/autopipeline`, `/plan`, `/prd`, `/planify`, `/prd_workflow` ne repondent plus (commande inconnue) | Envoi de la commande sur le bot, pas de handler declenche | manual |
| V11 | `action-registry.ts` ne contient plus les entrees module="execution" et module="planning" | `grep "module.*execution\|module.*planning" src/action-registry.ts` → zero resultat | unit |
| V12 | `intent-detection.ts` ne contient plus de patterns vers exec, orchestrate, plan, prd, prd_workflow | `grep "\"exec\"\|\"orchestrate\"\|\"plan\"\|\"prd\"\|\"prd_workflow\"" src/intent-detection.ts` → zero resultat | unit |
| V13 | `loader.test.ts` passe : la liste des composers charges est a jour (sans execution.ts et planning.ts) | Test unitaire green | unit |
| V14 | Les 21 fichiers de tests supprimes n'existent plus dans `tests/` | `ls tests/unit/orchestrator.test.ts` → erreur (et idem pour les 20 autres) | unit |
| V15 | `mcp/memory-server.ts` ne contient plus les imports orchestrator, prd, story-files, cost-estimate, pipeline-selection | Grep sur les lignes 428-439 → zero match | unit |
| V16 | `commands/jobs.ts` ne contient plus l'import de `prd.ts` ni le dynamic import de `auto-pipeline.ts` | Grep dans jobs.ts → zero match | unit |
| V17 | `commands/zz-messages.ts` ne contient plus les imports de `prd.ts`, `prd-workflow.ts`, `command-router.ts` et les types de `conversation-session.ts` | Grep dans zz-messages.ts → zero match | unit |
| V18 | `commands/help.ts` ne contient plus les imports de `gate-persistence`, `agent-events`, `agent-messaging`, `trust-scores`, `feedback-loop` | Grep dans help.ts → zero match | unit |
| V19 | `CLAUDE.md` ne mentionne plus les modules supprimes dans la table Source Modules | Grep CLAUDE.md → zero ligne pour orchestrator.ts, blackboard.ts, etc. | unit |
| V20 | Aucun fichier conserve (src/ + mcp/ + tests/) n'importe un module supprime | `grep -rn "from.*agent-schemas\|from.*blackboard\|from.*gate-evaluator\|from.*pipeline-state\|from.*llm-router\|from.*deliberation\|from.*orchestrator\|from.*adversarial-verifier\|from.*pipeline-selection\|from.*auto-pipeline" src/ mcp/ tests/` → zero resultat | unit |

## 9. Coverage et zones d'ombre

### 9.1 Matrice des dimensions

| Dimension | Couvert | Restant / Incertitude |
|-----------|---------|----------------------|
| **Suppression des 2 Composers** | Oui — R1, R2, V1, V2, V10 | Aucune |
| **Cascade des feuilles pures** | Oui — R3, section 4 (14 modules), V3, V7 | story-files.ts exclue (bmad-agents import) |
| **Adaptation des modules actifs** | Oui — R8 a R12 pour action-registry, intent-detection, help, zz-messages, jobs, mcp | Voir incertitudes ci-dessous |
| **Tests supprimes** | Oui — R5, section 4 (21 fichiers), V14, V20 | prd-workflow-integration.test.ts a decider |
| **Tests adaptes** | Oui — R13-R17, loader/action-registry/intent-detection/coding-standards | mcp-orchestration-tools.test.ts deferred |
| **CI verte** | Oui — R20, V4, V5 | Gate finale |

### 9.2 Zones d'ombre et decisions a prendre a l'implementation

**Zone 1 — pipeline-selection.ts supprimable en vague 1 ?**
`prd-workflow.ts` importe `explainPipelineChoice` depuis pipeline-selection.ts (confirme par le test `prd-workflow-integration.test.ts` ligne 5). Or `prd-workflow.ts` est importe par `zz-messages.ts` (actif). Si zz-messages.ts est adapte pour retirer l'import de prd-workflow.ts dans le meme commit (R11), alors prd-workflow.ts devient feuille, et pipeline-selection.ts avec lui. **Recommandation** : inclure la suppression de prd-workflow.ts ET pipeline-selection.ts dans ce commit si zz-messages.ts est adapte pour ne plus les importer. Sinon, les deux passent en vague 2.

**Zone 2 — llm-router.ts supprimable en vague 1 ?**
L'exploration signale llm-router.ts comme importe par pipeline-selection (cible), prd-workflow (actif indirect si zone 1 non resolue), et auto-pipeline (cible). A verifier par grep : `grep -n "from.*llm-router" src/ -r`. Si prd-workflow.ts est supprime en meme temps (voir zone 1), llm-router.ts devient feuille.

**Zone 3 — prd-workflow-integration.test.ts : supprimer ou adapter ?**
Ce test importe `explainPipelineChoice` de pipeline-selection et `getSession` de conversation-session. Si les deux modules sont supprimes en vague 1, supprimer le test. Si conversation-session reste (car relay.ts + zz-messages.ts l'importent encore), adapter le test pour retirer l'import pipeline-selection.

**Zone 4 — mcp-orchestration-tools.test.ts**
Ce test verifie la structure du MCP server, notamment le nombre d'outils (28) et la presence de `orchestrate_task`, `prd_create`, `pipeline-selection`. Apres adaptation de `mcp/memory-server.ts` (R19), ces outils disparaissent. Le test sera en echec. Il doit etre adapte pour refleter le nouveau nombre d'outils et supprimer les assertions sur les outils supprimes. **Inclure dans le meme commit** sous peine d'echec CI.

**Zone 5 — prd.ts et prd-workflow.ts**
`prd.ts` est importe par `jobs.ts` et `zz-messages.ts`. `prd-workflow.ts` est importe par `zz-messages.ts`. La spec (R11, R12) prevoit d'adapter ces fichiers pour retirer ces imports. Si ces adaptations sont faites dans le meme commit, `prd.ts` et `prd-workflow.ts` peuvent egalement etre supprimes en vague 1 (leurs seuls importeurs actifs seraient alors eux-memes nuls). **Recommandation** : inclure leur suppression si l'adaptation de zz-messages.ts et jobs.ts les rend inutilises.

**Zone 6 — conversation-session.ts**
Meme si zz-messages.ts est adapte pour retirer `PendingProposal` et les fonctions de session, `relay.ts` importe encore `initSessions` et `commands/help.ts` importe `getActiveSessionCount`. Ces importeurs restent actifs (relay.ts et help.ts ne sont pas supprimes). Donc `conversation-session.ts` NE PEUT PAS etre supprime en vague 1. Il passe en vague 3.

### 9.3 Alternatives evaluees

| Alternative | Evaluation |
|-------------|-----------|
| Supprimer en big-bang (toute la Phase 4 en un commit) | Rejetee : diff ~15K LOC, debugging difficile, conflit probable |
| Ne pas supprimer les tests (les laisser echouer puis les corriger apres) | Rejetee : CI doit etre verte a la fin de la vague |
| Supprimer seulement les Composers sans les feuilles | Sous-optimal : les 14 modules feuilles seraient du code mort compile inutilement, supprimer maintenant est plus simple |
| Conserver prd.ts et prd-workflow.ts pour la vague 2 | Acceptable si l'adaptation de zz-messages.ts/jobs.ts est trop large — decision a l'implementation |
