---
phase: 0-explore
generated_at: "2026-03-24T15:30:00Z"
subject: "Phase 4 — Suppression de l'orchestration TypeScript (ARCHITECTURE-V2)"
verdict: GO
next_step: "dev-implement"
---

## Section 1 — Probleme

Le document ARCHITECTURE-V2 definit une migration en 6 phases pour transformer le bot d'un orchestrateur SDLC rigide (34K LOC, 88 modules) en un assistant conversationnel delegant a Claude Code. La Phase 4 concerne la suppression de l'orchestration TypeScript : 31 fichiers source totalisant ~12 936 LOC, plus ~54 fichiers de tests associes.

La question centrale est : **dans quel ordre ces modules peuvent-ils etre supprimes sans casser les imports des modules actifs (conserves) ?** Certains modules cibles sont uniquement importes par d'autres modules cibles (suppression safe), tandis que d'autres sont importes par du code actif qui devra etre adapte en amont.

L'exploration est necessaire car le graphe de dependances est dense (31 modules avec des references croisees) et une suppression dans le mauvais ordre provoquerait des erreurs de compilation en cascade.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| - | N/A — exploration purement interne | - | - | Ce sujet est une analyse de dependances du codebase existant, sans equivalent externe | N/A |

Axe "Non couvert — sources externes non pertinentes" : ce sujet est une analyse purement interne du graphe de dependances du projet. L'etat de l'art externe (strategies de suppression de code mort, outils d'analyse de dependances) n'apporte pas de valeur ajoutee specifique ici. La methode est classique : analyse topologique des imports, identification des feuilles (modules sans dependants actifs), suppression en vagues des feuilles vers les racines.

**Note** : le verdict GO est justifie malgre l'absence d'axe 1 car il s'agit d'un refactoring interne dont toutes les informations necessaires sont dans le codebase.

## Section 3 — Archeologie codebase

### 3.1 — Inventaire des modules cibles (31 fichiers, 12 936 LOC)

| # | Fichier/Module | LOC | Observation | Impact potentiel |
|---|---------------|-----|-------------|:----------------:|
| 1 | `src/orchestrator.ts` (barrel) | 41 | Re-exporte deliberation, pipeline, format, types, pipeline-selection | Faible (barrel) |
| 2 | `src/orchestrator/types.ts` | 95 | Types AgentRole, AgentStepResult, OrchestratedResult | Moyen (types utilises) |
| 3 | `src/orchestrator/agent-step.ts` | 262 | runAgentStep, getOrchestrationInstructions | Faible |
| 4 | `src/orchestrator/pipeline.ts` | 1096 | orchestrate() — coeur du pipeline multi-agent | Faible (derriere barrel) |
| 5 | `src/orchestrator/format.ts` | 188 | formatOrchestrationResult, buildOrchestrationSummary | Faible |
| 6 | `src/blackboard.ts` | 653 | Shared workspace: versioned JSONB, optimistic locking | Faible |
| 7 | `src/gate-evaluator.ts` | 927 | Gate evaluation: dual verification, rubric scoring | Faible |
| 8 | `src/gate-persistence.ts` | 222 | Gate persistence, double-loop learning | Faible |
| 9 | `src/trust-scores.ts` | 289 | Per-role trust scores, formatTrustScores | Moyen (alerts.ts, llm-ops.ts) |
| 10 | `src/deliberation.ts` | 150 | Deliberation protocol | Faible |
| 11 | `src/agent-messaging.ts` | 422 | Inter-agent messaging | Faible |
| 12 | `src/adversarial-verifier.ts` | 342 | Spec-vs-implementation drift detection | Faible |
| 13 | `src/bmad-agents.ts` | 449 | 8 agent definitions, buildBmadExecPrompt | Eleve (agent.ts, commands/quality.ts) |
| 14 | `src/bmad-prompts.ts` | 560 | Context-aware prompt builder per agent role | Eleve (agent.ts) |
| 15 | `src/agent-schemas.ts` | 1091 | Typed JSON output schemas per agent role | Moyen |
| 16 | `src/pipeline-selection.ts` | 310 | Dynamic pipeline selection | Faible |
| 17 | `src/pipeline-state.ts` | 258 | Pipeline checkpoint/resume | Faible |
| 18 | `src/workflow.ts` | 848 | Workflow engine: state transitions, loadWorkflowConfig | Eleve (13+ importers actifs) |
| 19 | `src/feedback-loop.ts` | 447 | Double-loop learning, loadFeedbackRules | Moyen (relay.ts, quality.ts) |
| 20 | `src/conversation-session.ts` | 481 | Conversation sessions | Eleve (zz-messages.ts, relay.ts) |
| 21 | `src/code-review.ts` | 259 | Adversarial code review | Moyen (agent.ts) |
| 22 | `src/prd.ts` | 342 | PRD management | Eleve (planning.ts, jobs.ts, zz-messages.ts, etc.) |
| 23 | `src/prd-workflow.ts` | 492 | PRD-to-Deploy workflow | Moyen (planning.ts, zz-messages.ts) |
| 24 | `src/auto-pipeline.ts` | 393 | Autonomous end-to-end pipeline | Moyen (execution.ts, planning.ts, jobs.ts) |
| 25 | `src/llm-router.ts` | 465 | LLM-based pipeline selection | Faible |
| 26 | `src/story-files.ts` | 351 | Structured task specs | Moyen (execution.ts, planning.ts) |
| 27 | `src/command-router.ts` | 367 | Routes intents to commands | Moyen (zz-messages.ts) |
| 28 | `src/agent-context.ts` | 486 | Supabase context assembly for agents | Moyen (agent.ts) |
| 29 | `src/agent-events.ts` | 234 | Agent event log | Faible |
| 30 | `src/cost-estimate.ts` | 159 | Pre-implementation cost estimation | Moyen (utilities.ts, cost-tracking.ts) |
| 31 | `src/mcp-config.ts` | 257 | Per-role MCP tool configuration | Moyen (agent.ts) |

### 3.2 — Dependances des modules actifs (conserves) vers les modules cibles

Voici la liste exhaustive des modules actifs qui importent des modules cibles :

| Module actif (conserve) | Importe depuis (module cible) | Symboles importes |
|------------------------|------------------------------|-------------------|
| `src/relay.ts` | `conversation-session.ts` | `initSessions` |
| `src/relay.ts` | `feedback-loop.ts` | `loadFeedbackRules` |
| `src/agent.ts` | `agent-context.ts` | `buildAgentContext` |
| `src/agent.ts` | `bmad-agents.ts` | `buildBmadExecPrompt`, `enrichPromptWithAgent` |
| `src/agent.ts` | `code-review.ts` | `formatReviewResult`, `runCodeReview`, `saveReviewResult` |
| `src/agent.ts` | `bmad-prompts.ts` | (via bmad-agents) |
| `src/agent.ts` | `mcp-config.ts` | `buildMcpToolInstructions` |
| `src/llm-ops.ts` | `trust-scores.ts` | types/functions |
| `src/alerts.ts` | `trust-scores.ts` | `formatTrustScores` |
| `src/patterns.ts` | `workflow.ts` | `loadWorkflowConfig`, `SprintMetrics` type |
| `src/commands/help.ts` | `agent-events.ts` | `formatAgentTimeline`, `getAgentEvents` |
| `src/commands/help.ts` | `agent-messaging.ts` | `formatMessageFlow`, `getAgentMessages`, `getMessageFlowSummary` |
| `src/commands/help.ts` | `bmad-agents.ts` | `formatAgentList` |
| `src/commands/help.ts` | `conversation-session.ts` | `getActiveSessionCount` |
| `src/commands/help.ts` | `feedback-loop.ts` | `getFeedbackRules` |
| `src/commands/help.ts` | `gate-persistence.ts` | `formatDoubleLoopRules` |
| `src/commands/help.ts` | `trust-scores.ts` | `formatRecentGateEvaluations`, `formatTrustScores` |
| `src/commands/quality.ts` | `bmad-agents.ts` | `getAgentForCommand` |
| `src/commands/quality.ts` | `feedback-loop.ts` | `loadFeedbackRules`, `processRetroFeedback` |
| `src/commands/quality.ts` | `workflow.ts` | multiple exports |
| `src/commands/zz-messages.ts` | `command-router.ts` | routing functions |
| `src/commands/zz-messages.ts` | `conversation-session.ts` | `PendingProposal` type, session functions |
| `src/commands/zz-messages.ts` | `prd.ts` | `formatPRDDetail`, `getPRD` |
| `src/commands/zz-messages.ts` | `prd-workflow.ts` | multiple functions |
| `src/commands/utilities.ts` | `cost-estimate.ts` | `estimateSprintCost`, `formatCostEstimate` |
| `src/commands/jobs.ts` | `prd.ts` | `formatPRDDetail`, `getPRD` |
| `src/commands/execution.ts` | `agent-schemas.ts`, `auto-pipeline.ts`, `conversation-session.ts`, `orchestrator.ts`, `pipeline-state.ts`, `story-files.ts`, `workflow.ts` | (multiple) |
| `src/commands/planning.ts` | `conversation-session.ts`, `prd.ts`, `prd-workflow.ts`, `story-files.ts`, `workflow.ts` | (multiple) |
| `mcp/memory-server.ts` | `cost-estimate.ts`, `orchestrator.ts`, `prd.ts`, `story-files.ts`, `pipeline-selection.ts` | (multiple) |

### 3.3 — Classification des modules cibles

**Groupe A — Feuilles pures (aucun importeur actif, suppression immediate safe)**

Ces modules ne sont importes QUE par d'autres modules cibles (ou par rien) :

| Module | Importeurs (tous cibles) |
|--------|-------------------------|
| `src/orchestrator/types.ts` | orchestrator barrel, agent-step, pipeline, format |
| `src/orchestrator/agent-step.ts` | orchestrator barrel |
| `src/orchestrator/pipeline.ts` | orchestrator barrel |
| `src/orchestrator/format.ts` | orchestrator barrel |
| `src/blackboard.ts` | agent-messaging, pipeline-state (tous cibles) |
| `src/deliberation.ts` | orchestrator barrel (cible) |
| `src/adversarial-verifier.ts` | aucun importeur |
| `src/pipeline-selection.ts` | orchestrator barrel, prd-workflow (tous cibles) |
| `src/pipeline-state.ts` | execution.ts (cible) |
| `src/llm-router.ts` | pipeline-selection, prd-workflow, auto-pipeline (tous cibles) |
| `src/agent-schemas.ts` | execution.ts (cible), deliberation, pipeline-state (tous cibles) |
| `src/auto-pipeline.ts` | execution.ts (cible), planning.ts (cible), jobs.ts |
| `src/gate-persistence.ts` | gate-evaluator (cible), help.ts |
| `src/gate-evaluator.ts` | aucun importeur actif direct |

**Groupe B — Modules avec 1-2 importeurs actifs (necessitent d'abord un refactoring mineur)**

| Module | Importeurs actifs | Effort de decouplage |
|--------|-------------------|---------------------|
| `src/agent-events.ts` | `commands/help.ts` | Retirer /status agent timeline |
| `src/agent-messaging.ts` | `commands/help.ts` | Retirer /status message flow |
| `src/code-review.ts` | `agent.ts` | Retirer code review du spawn |
| `src/mcp-config.ts` | `agent.ts` | Retirer MCP tool instructions |
| `src/agent-context.ts` | `agent.ts` | Simplifier dans bot-context |
| `src/cost-estimate.ts` | `commands/utilities.ts`, `cost-tracking.ts`, `mcp/memory-server.ts` | Retirer /estimate ou rendre inline |

**Groupe C — Modules profondement ancres (necessitent un refactoring significatif avant suppression)**

| Module | Importeurs actifs | Complexite |
|--------|-------------------|------------|
| `src/bmad-agents.ts` | `agent.ts`, `commands/quality.ts`, `commands/help.ts` | Eleve — buildBmadExecPrompt utilise dans agent spawn |
| `src/bmad-prompts.ts` | `agent.ts` (via bmad-agents), `code-review.ts` | Eleve — enrichPromptWithAgent |
| `src/workflow.ts` | `patterns.ts`, `commands/quality.ts`, `commands/execution.ts`, `commands/planning.ts` | Eleve — WorkflowTracker, loadWorkflowConfig |
| `src/feedback-loop.ts` | `relay.ts`, `commands/quality.ts`, `commands/help.ts` | Moyen — loadFeedbackRules, processRetroFeedback |
| `src/conversation-session.ts` | `relay.ts`, `commands/zz-messages.ts`, `commands/execution.ts`, `commands/planning.ts` | Eleve — initSessions, getSession, PendingProposal |
| `src/prd.ts` | `commands/planning.ts`, `commands/jobs.ts`, `commands/zz-messages.ts`, `mcp/memory-server.ts` | Eleve — generatePRD, getPRD, savePRD |
| `src/prd-workflow.ts` | `commands/planning.ts`, `commands/zz-messages.ts` | Moyen |
| `src/trust-scores.ts` | `alerts.ts`, `llm-ops.ts`, `commands/help.ts` | Moyen |
| `src/story-files.ts` | `commands/execution.ts`, `commands/planning.ts`, `mcp/memory-server.ts` | Moyen |
| `src/command-router.ts` | `commands/zz-messages.ts` | Moyen |
| `src/orchestrator.ts` (barrel) | `commands/execution.ts`, `mcp/memory-server.ts` | Moyen (mais execution.ts est aussi cible) |

### 3.4 — Impact sur les tests

54 fichiers de tests importent des modules cibles. Ces tests devront etre :
- **Supprimes** si ils testent uniquement du code cible (ex: `orchestrator.test.ts`, `gate-evaluator.test.ts`)
- **Adaptes** si ils testent du code actif qui utilisait des modules cibles (ex: `exploration-command.test.ts`)

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Suppression par vagues (3 passes) | C: Suppression big-bang |
|---------|:------------:|:-----------------------------------:|:----------------------:|
| **Complexite** (obligatoire) | S | M | L |
| **Valeur ajoutee** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | Low | Low | High |
| *Impact maintenance* | Negatif (dette) | Positif | Positif |
| *Reversibilite* | N/A | Haute (chaque vague = 1 commit) | Basse |

**Option A — Status quo** : ne rien faire. Les 12 936 LOC de code mort restent. La maintenance, la compilation et les tests sont alourdis. Cout zero a court terme, dette croissante a long terme.

**Option B — Suppression par vagues (3 passes)** : supprimer d'abord les feuilles pures (Groupe A), puis les modules a faible couplage (Groupe B) apres decouplage mineur, enfin les modules profondement ancres (Groupe C) apres refactoring de leurs importeurs actifs. Chaque vague passe CI avant la suivante. Risque minimal car chaque etape est reversible.

**Option C — Suppression big-bang** : tout supprimer en une seule PR, avec adaptation de tous les importeurs actifs en meme temps. Plus rapide si ca marche, mais le diff serait enorme (~15K LOC supprimes + refactoring des importeurs), les conflits de merge probables, et le debugging en cas de regression tres difficile.

## Section 5 — Verdict et justification

**Verdict : GO** — Option B (suppression par vagues en 3 passes).

Justification :
1. **Groupe A (feuilles pures) est safe a supprimer immediatement** : 14 modules / ~4 500 LOC n'ont aucun importeur actif. Leur suppression ne casse aucun import de code conserve.
2. **Groupe B necessite un decouplage mineur** : 6 modules / ~2 100 LOC avec 1-2 importeurs actifs chacun. Le decouplage est localise et simple (retirer des imports + fonctionnalites dans help.ts, agent.ts, utilities.ts).
3. **Groupe C necessite la Phase 5** : les modules profondement ancres (`workflow.ts`, `prd.ts`, `conversation-session.ts`, `bmad-agents.ts`) sont importes par `commands/execution.ts` et `commands/planning.ts` qui sont eux-memes dans la liste "Supprimes" de l'ARCHITECTURE-V2 (Phase 5). La suppression de ces commands facilite enormement la suppression du Groupe C.
4. **Les 54 fichiers de tests** seront supprimes/adaptes en meme temps que leurs modules sources.
5. **Le MCP server** (`mcp/memory-server.ts`) devra etre adapte pour retirer les references a `orchestrator`, `prd`, `story-files`, `cost-estimate` et `pipeline-selection`.

## Section 6 — Input pour etape suivante

### Option recommandee : Suppression par vagues (3 passes)

### Vague 1 — Feuilles pures (suppression immediate, ~4 500 LOC)

Modules supprimables sans modifier aucun fichier actif :

```
src/orchestrator/types.ts          (95 LOC)
src/orchestrator/agent-step.ts     (262 LOC)
src/orchestrator/pipeline.ts       (1096 LOC)
src/orchestrator/format.ts         (188 LOC)
src/orchestrator.ts                (41 LOC)  — barrel, supprimer apres ses sous-modules
src/blackboard.ts                  (653 LOC)
src/deliberation.ts                (150 LOC)
src/adversarial-verifier.ts        (342 LOC)
src/pipeline-selection.ts          (310 LOC)
src/pipeline-state.ts              (258 LOC)
src/llm-router.ts                  (465 LOC)
src/agent-schemas.ts               (1091 LOC)
src/gate-evaluator.ts              (927 LOC)
src/gate-persistence.ts            (222 LOC) — mais help.ts l'importe
```

**Attention** : `gate-persistence.ts` et `auto-pipeline.ts` ont un importeur dans `commands/help.ts` et `commands/jobs.ts` respectivement. Ils ne sont PAS des feuilles pures. Ils passent en vague 2.

**Feuilles pures confirmees (12 modules)** :
1. `src/orchestrator/types.ts`
2. `src/orchestrator/agent-step.ts`
3. `src/orchestrator/pipeline.ts`
4. `src/orchestrator/format.ts`
5. `src/orchestrator.ts` (barrel)
6. `src/blackboard.ts`
7. `src/deliberation.ts`
8. `src/adversarial-verifier.ts`
9. `src/pipeline-selection.ts`
10. `src/pipeline-state.ts`
11. `src/llm-router.ts`
12. `src/agent-schemas.ts`

**Prerequis** : `commands/execution.ts` et `commands/planning.ts` doivent etre supprimes AVANT (Phase 5 dans ARCHITECTURE-V2, mais en pratique c'est un prerequis de la vague 1 car ils importent orchestrator, pipeline-state, agent-schemas, etc.).

**Ordre de suppression recommande pour la vague 1** :
1. D'abord `commands/execution.ts` + `commands/planning.ts` (leurs importeurs — loader.ts les decouvre dynamiquement, donc les retirer suffit)
2. Puis les 4 sous-modules orchestrator/ dans l'ordre : types, agent-step, format, pipeline
3. Puis le barrel `orchestrator.ts`
4. Puis les feuilles restantes dans n'importe quel ordre : blackboard, deliberation, adversarial-verifier, pipeline-selection, pipeline-state, llm-router, agent-schemas

**Tests a supprimer en vague 1** :
- `tests/unit/orchestrator.test.ts`
- `tests/unit/pipeline-selection.test.ts`
- `tests/unit/pipeline-state.test.ts`
- `tests/unit/deliberation.test.ts`
- `tests/unit/parallel-blackboard.test.ts`
- `tests/unit/adversarial-verifier.test.ts`
- `tests/unit/agent-schemas.test.ts`
- `tests/unit/orchestrator-deliberation.test.ts`
- `tests/unit/gate-evaluator.test.ts`
- `tests/unit/gate-persistence.test.ts`
- `tests/unit/rubric-scoring.test.ts`
- `tests/unit/dual-verification.test.ts`
- `tests/unit/adaptive-pipeline.test.ts`
- `tests/integration/mcp-blackboard.test.ts`
- Tout test qui importe exclusivement des modules supprimes

### Vague 2 — Decouplage mineur + suppression (~3 400 LOC)

Modules necessitant un decouplage d'1-2 importeurs actifs :

| Module | Importeur actif | Action de decouplage |
|--------|----------------|---------------------|
| `src/gate-persistence.ts` (222) | `commands/help.ts` | Retirer `formatDoubleLoopRules` du /status |
| `src/agent-events.ts` (234) | `commands/help.ts` | Retirer agent timeline du /status |
| `src/agent-messaging.ts` (422) | `commands/help.ts` | Retirer message flow du /status |
| `src/trust-scores.ts` (289) | `alerts.ts`, `llm-ops.ts`, `commands/help.ts` | Retirer `formatTrustScores` et types |
| `src/code-review.ts` (259) | `agent.ts` | Retirer code review du spawn agent |
| `src/mcp-config.ts` (257) | `agent.ts` | Retirer MCP tool instructions (ou simplifier) |
| `src/agent-context.ts` (486) | `agent.ts` | Simplifier context assembly dans agent.ts directement |
| `src/cost-estimate.ts` (159) | `commands/utilities.ts`, `cost-tracking.ts`, `mcp/memory-server.ts` | Retirer /estimate ou inliner |
| `src/auto-pipeline.ts` (393) | `commands/jobs.ts` (via type check) | Retirer reference |
| `src/story-files.ts` (351) | `mcp/memory-server.ts` | Retirer du MCP server |
| `src/command-router.ts` (367) | `commands/zz-messages.ts` | Simplifier routage dans zz-messages |

**Tests additionnels a supprimer** :
- `tests/unit/trust-scores.test.ts`, `tests/unit/trust-integration.test.ts`
- `tests/unit/mcp-config.test.ts`, `tests/unit/agent-context.test.ts`
- `tests/unit/command-router.test.ts`, `tests/unit/cost-estimate.test.ts`
- `tests/unit/auto-pipeline.test.ts`

### Vague 3 — Modules profondement ancres (~4 000 LOC)

A faire APRES la Phase 5 (simplification des commandes) car les importeurs principaux (`commands/execution.ts`, `commands/planning.ts`) seront deja supprimes :

| Module | Importeurs actifs restants | Action |
|--------|---------------------------|--------|
| `src/workflow.ts` (848) | `patterns.ts`, `commands/quality.ts` | Retirer WorkflowTracker, simplifier patterns |
| `src/feedback-loop.ts` (447) | `relay.ts`, `commands/quality.ts`, `commands/help.ts` | Retirer loadFeedbackRules de relay.ts |
| `src/conversation-session.ts` (481) | `relay.ts`, `commands/zz-messages.ts` | Retirer initSessions, adapter zz-messages |
| `src/prd.ts` (342) | `commands/jobs.ts`, `commands/zz-messages.ts`, `mcp/memory-server.ts` | Retirer PRD management |
| `src/prd-workflow.ts` (492) | `commands/zz-messages.ts` | Retirer PRD workflow buttons |
| `src/bmad-agents.ts` (449) | `agent.ts`, `commands/quality.ts`, `commands/help.ts` | Retirer buildBmadExecPrompt, formatAgentList |
| `src/bmad-prompts.ts` (560) | `agent.ts` (via bmad-agents) | Retirer prompt enrichment |

### Contraintes identifiees

1. **`commands/execution.ts` et `commands/planning.ts` sont le goulot d'etranglement** : ils importent massivement depuis les modules cibles. Leur suppression (Phase 5) doit preceder ou etre fusionnee avec la Phase 4.
2. **Le MCP server** (`mcp/memory-server.ts`) importe `orchestrator`, `prd`, `story-files`, `cost-estimate`, `pipeline-selection` — il devra etre adapte.
3. **`commands/help.ts`** est le module actif le plus touche (7 imports de modules cibles) — sa simplification est necessaire des la vague 2.
4. **`agent.ts`** importe 4 modules cibles — son refactoring est critique pour la vague 2.

### Questions ouvertes

1. **Faut-il fusionner Phase 4 et Phase 5 ?** La suppression de `commands/execution.ts` et `commands/planning.ts` est un prerequis de facto pour la plupart des suppressions de la Phase 4. Les traiter ensemble serait plus coherent.
2. **Que faire du MCP server ?** Les outils `orchestrate_task`, `prd_create`, `prd_get`, etc. devront etre soit retires soit reecrits.
3. **`workflow.ts` exporte `loadWorkflowConfig` et `SprintMetrics`** utilises par `patterns.ts` (module actif selon ARCHITECTURE-V2 avec mention "Differe"). Faut-il supprimer `patterns.ts` aussi ?
4. **`alerts.ts` importe `formatTrustScores`** de `trust-scores.ts`. ARCHITECTURE-V2 mentionne que `alerts.ts` est "Simplifie dans heartbeat" — confirmer que cette simplification inclut le retrait de trust-scores.
