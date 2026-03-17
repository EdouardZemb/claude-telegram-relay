# SDD Spec — S44 MCP Business Server, Exploration & Pipeline Adaptatif

## Overview

S44 expose la logique metier du bot comme MCP Server pour acces programmatique depuis toute session Claude Code. Cette fondation permet ensuite un agent explorateur zero-friction et des pipelines adaptatifs par difficulte. Trois axes prioritaires : MCP Server metier (fondation), agent explorateur dedie (sans PRD/gates), pipeline adaptatif par score de difficulte.

Motive par : besoin d'utiliser les outils du bot depuis les conversations Claude Code, benchmark S32 (trop de friction pour des taches exploratoires), recherche DAAO (scaling par difficulte), etat de l'art MCP 2026 (pattern "build once, use everywhere").

## User Stories

US-001: As a Claude Code session, I want to create tasks, manage PRDs, and trigger pipelines via MCP tools, so that the conversation can use the bot's capabilities programmatically and send notifications to Telegram.

US-002: As a developer, I want to ask the bot to explore a topic and get a structured report without creating a task/PRD, so that I can evaluate ideas before committing to implementation.

US-003: As a developer, I want the pipeline to automatically scale the number of agents based on task difficulty, so that simple tasks don't waste tokens on unnecessary agents.

US-004: As a developer, I want agents to be able to search the web during execution, so that they can access up-to-date information for research and exploration tasks.

US-005: As a developer, I want to trigger exploration through natural language (not just /explore), so that the conversational orchestrator handles it seamlessly.

## Functional Requirements

FR-000: MCP Business Logic Server — expose core bot capabilities as MCP tools
  Acceptance Criteria:
  - AC-MCP-001: GIVEN a Claude Code session with the MCP server configured WHEN it calls task_create with title, description, priority, sprint THEN a task is created in Supabase (same result as /task) AND a notification is enqueued to Telegram
  - AC-MCP-002: GIVEN a Claude Code session WHEN it calls task_update with taskId and status THEN the task status is updated (same as /start, /done) AND a notification is enqueued
  - AC-MCP-003: GIVEN a Claude Code session WHEN it calls task_list with optional filters (status, sprint, project) THEN it returns the backlog (same as /backlog)
  - AC-MCP-004: GIVEN a Claude Code session WHEN it calls sprint_summary with sprint ID THEN it returns sprint progress (same as /sprint)
  - AC-MCP-005: GIVEN a Claude Code session WHEN it calls prd_create with title and description THEN a PRD is generated via Claude and saved (same as /prd create)
  - AC-MCP-006: GIVEN a Claude Code session WHEN it calls prd_list or prd_get THEN it returns PRDs (same as /prd list, /prd view)
  - AC-MCP-007: GIVEN a Claude Code session WHEN it calls prd_approve or prd_reject with PRD ID THEN the PRD status is updated (same as /prd approve, /prd reject)
  - AC-MCP-008: GIVEN any MCP tool that modifies state WHEN the operation succeeds THEN a notification is sent to Telegram via enqueue() so the user sees it
  - AC-MCP-009: GIVEN the MCP server WHEN it starts THEN it connects to Supabase using env vars and validates connectivity
  - AC-MCP-010: GIVEN the existing memory MCP tools (search_thoughts, capture_thought, etc.) THEN they continue to work alongside the new business tools in the same server

FR-001: Agent Explorateur — nouveau role "explorer" (Haiku, read-only, zero gate)
  Acceptance Criteria:
  - AC-001: GIVEN a user sends "/explore comment ameliorer la memoire" WHEN the command is processed THEN an explorer agent is spawned with Haiku model, receives full context (code graph, memory, sprint metrics, profile), and returns a structured report (etat des lieux, options, recommandations, estimation effort)
  - AC-002: GIVEN an exploration completes THEN an inline button "Creer une tache" is shown allowing the user to convert findings into a task
  - AC-003: GIVEN a structural question (e.g. "quels modules dependent de memory.ts") WHEN code-graph can answer it THEN the response is generated from code-graph without spawning an agent (zero LLM cost)

FR-002: Integration conversationnelle de l'exploration
  Acceptance Criteria:
  - AC-004: GIVEN intent_detection is enabled WHEN a user sends "explore les options pour X" or "recherche comment faire Y" THEN the intent detector routes to the explore action
  - AC-005: GIVEN the explore action is registered THEN it appears in the action registry with risk level "low" and appropriate aliases

FR-003: Pipeline adaptatif par difficulte
  Acceptance Criteria:
  - AC-006: GIVEN a task is submitted to orchestrate/autopipeline WHEN the LLM router or difficulty scorer evaluates it THEN a difficulty score 0-1 is computed based on code graph complexity, task description analysis, and historical similar tasks
  - AC-007: GIVEN difficulty < 0.3 THEN pipeline SOLO is selected (dev only, no other agents)
  - AC-008: GIVEN difficulty 0.3-0.6 THEN pipeline LIGHT is selected (analyst+pm merged into single "planner" call, then dev, then qa)
  - AC-009: GIVEN difficulty > 0.6 THEN pipeline DEFAULT is selected (full 5-agent pipeline)
  - AC-010: GIVEN explicit pipeline override by user THEN the override takes precedence over difficulty-based selection

FR-004: Fusion analyst+pm en mode LIGHT
  Acceptance Criteria:
  - AC-011: GIVEN pipeline LIGHT is selected THEN a single "planner" agent call replaces separate analyst and pm calls, combining their schemas and prompts
  - AC-012: GIVEN the planner agent produces output THEN downstream agents (dev, qa) receive it in the same structured format as they would from separate analyst+pm

FR-005: Recherche web pour agents via Brave Search MCP
  Acceptance Criteria:
  - AC-013: GIVEN Brave Search MCP is configured in .mcp.json THEN all spawned agents can access web search tools automatically
  - AC-014: GIVEN an explorer agent is spawned THEN its MCP config includes web search tool access
  - AC-015: GIVEN a RESEARCH pipeline is defined THEN it uses planner -> N parallel searchers -> synthesizer pattern with fan-out on blackboard

FR-006: Pipeline RESEARCH dedie
  Acceptance Criteria:
  - AC-016: GIVEN a user requests "/explore --deep <topic>" or the explorer detects a topic requiring web research THEN the RESEARCH pipeline is triggered: planner decomposes into sub-questions, fan-out searcher agents, fan-in synthesis on blackboard
  - AC-017: GIVEN the RESEARCH pipeline completes THEN the final synthesis is formatted as a structured report with sources

FR-007: DAG definitions pour nouveaux pipelines
  Acceptance Criteria:
  - AC-018: GIVEN SOLO pipeline THEN DAG contains single dev node
  - AC-019: GIVEN LIGHT pipeline THEN DAG contains planner -> dev -> qa chain
  - AC-020: GIVEN RESEARCH pipeline THEN DAG contains planner -> parallel searchers -> synthesizer

## Edge Cases

EC-000: MCP server cannot connect to Supabase — Expected behavior: tools return error messages, server stays running
EC-001: Explore command with empty topic — Expected behavior: ask user to specify what to explore
EC-002: Code graph answers structural question but graph is stale — Expected behavior: regenerate graph index before answering
EC-003: Difficulty score computation fails (LLM timeout, graph unavailable) — Expected behavior: fall back to keyword-based pipeline selection (current behavior)
EC-004: Brave Search MCP not configured — Expected behavior: explorer works without web search, logs warning that web search is unavailable
EC-005: RESEARCH pipeline with 0 sub-questions from planner — Expected behavior: fall back to single searcher with original topic
EC-006: User says "explore" but intent is actually to execute — Expected behavior: intent detection distinguishes exploration from execution based on context
EC-007: MCP tool called with invalid task ID — Expected behavior: return clear error message, no crash
EC-008: PRD generation fails (Claude CLI unavailable) — Expected behavior: return error, no partial PRD saved

## Success Criteria

SC-001: All existing tests pass (zero regression)
SC-002: 50+ new tests covering MCP tools, exploration, difficulty scoring, pipeline selection, RESEARCH pipeline
SC-003: MCP business server functional: task_create, task_update, task_list, sprint_summary, prd_create, prd_list, prd_get, prd_approve, prd_reject all work from Claude Code
SC-004: Notifications arrive on Telegram when MCP tools modify state
SC-005: /explore command responds correctly on Telegram with structured report
SC-006: Pipeline adaptatif selects correct pipeline for known difficulty levels
SC-007: Brave Search MCP integration documented and functional
SC-008: Feature flags: explore_mode, adaptive_pipeline, web_search (all disabled by default)

## Out of Scope

- Autonomous exploration cron (proactive reports without user trigger)
- Modification des pipelines DEFAULT/QUICK/REVIEW existants
- Migration de la base de donnees (pas de nouvelles tables)
- Multi-project exploration (un seul projet a la fois)
- Cost optimization des agents existants (hors scope, focus sur les nouveaux modes)
- Orchestrate/exec/autopipeline MCP tools (phase 2 — necessite gestion processus longue duree)

## Dependencies

- S39 code-graph.ts (knowledge graph queries)
- S37 action-registry + intent-detection (conversational routing)
- S43 conversation-session (session context for exploration)
- S34 llm-router (difficulty scoring extension)
- S25 dag-executor + fan-out (RESEARCH pipeline parallelism)
- Existing: mcp/memory-server.ts (pattern a etendre)
- Existing: src/tasks.ts, src/prd.ts (business logic to expose)
- Existing: src/notification-queue.ts enqueue() (notifications sans ctx Telegram)
- External: Brave Search API key (free tier 2000 req/month)

## Task Decomposition

T1 — MCP Business Server: task tools (FONDATION)
  Etendre mcp/memory-server.ts avec task_create, task_update, task_list, sprint_summary.
  Chaque outil appelle directement les fonctions de src/tasks.ts.
  Notifications via enqueue() de notification-queue.ts.
  AC: AC-MCP-001, AC-MCP-002, AC-MCP-003, AC-MCP-004, AC-MCP-008, AC-MCP-009, AC-MCP-010, EC-000, EC-007

T2 — MCP Business Server: PRD tools
  Ajouter prd_create, prd_list, prd_get, prd_approve, prd_reject.
  prd_create appelle generatePRD() de src/prd.ts.
  Notifications via enqueue().
  AC: AC-MCP-005, AC-MCP-006, AC-MCP-007, AC-MCP-008, EC-008

T3 — Agent Explorateur: role + config
  Creer role "explorer" dans bmad-agents.ts (Haiku, low effort, budget $0.10).
  Prompt template dans bmad-templates/. Schema de sortie dans agent-schemas.ts.
  Feature flag explore_mode.
  AC: AC-001

T4 — Commande /explore + Composer
  Nouveau fichier src/commands/explore.ts. Parse /explore <topic> et /explore --deep.
  Spawn explorer agent. Inline button "Creer une tache". Gere topic vide.
  AC: AC-001, AC-002, EC-001

T5 — Reponses structurelles via code-graph (zero LLM)
  Detecter questions structurelles et repondre via code-graph.ts sans agent.
  Heuristique par mots-cles + patterns de modules.
  AC: AC-003

T6 — Integration conversationnelle exploration
  Enregistrer "explore" dans action-registry.ts. Patterns regex dans intent-detection.ts.
  AC: AC-004, AC-005, EC-006

T7 — Difficulty scorer
  computeDifficultyScore() dans llm-router.ts. Inputs: graph complexity, description, historique.
  AC: AC-006, EC-003

T8 — Pipeline adaptatif (SOLO, LIGHT, DAGs) + fusion planner
  Pipelines SOLO et LIGHT dans orchestrator.ts + dag-executor.ts. Role "planner" fusionnant analyst+pm.
  Selection auto basee sur difficulty score. Override manuel.
  AC: AC-007, AC-008, AC-009, AC-010, AC-011, AC-012, AC-018, AC-019

T9 — Brave Search MCP + config explorer + pipeline RESEARCH
  Brave Search MCP dans .mcp.json. Role explorer avec acces web. Pipeline RESEARCH (planner -> chercheurs -> synthese).
  AC: AC-013, AC-014, AC-015, AC-016, AC-017, AC-020, EC-004, EC-005

T10 — Tests + CLAUDE.md
  50+ tests. Mise a jour CLAUDE.md (modules, commandes). Feature flags.
  AC: SC-001 a SC-008

Ordre d'execution:
  T1 -> T2 (fondation MCP, critique)
  T3 -> T4 -> T5 -> T6 (exploration)
  T7 -> T8 (pipeline adaptatif)
  T9 (recherche web)
  T10 en continu

## Test Plan

Unit Tests:
- [ ] AC-MCP-001: task_create inserts task and enqueues notification
- [ ] AC-MCP-002: task_update changes status and enqueues notification
- [ ] AC-MCP-003: task_list returns filtered tasks
- [ ] AC-MCP-004: sprint_summary returns correct counts
- [ ] AC-MCP-005: prd_create generates and saves PRD
- [ ] AC-MCP-006: prd_list/prd_get return PRDs
- [ ] AC-MCP-007: prd_approve/reject update status
- [ ] AC-MCP-008: all state-changing tools enqueue notifications
- [ ] AC-MCP-010: existing memory tools still work
- [ ] EC-000: tools return error on Supabase failure
- [ ] EC-007: invalid task ID returns clear error
- [ ] EC-008: PRD generation failure handled gracefully
- [ ] AC-001: explorer agent spawned with correct config
- [ ] AC-003: code-graph structural questions answered without agent
- [ ] AC-004: intent detection routes "explore X" to explore action
- [ ] AC-005: explore action registered in action-registry
- [ ] AC-006: difficulty score computed correctly
- [ ] AC-007: SOLO selected for difficulty < 0.3
- [ ] AC-008: LIGHT selected for difficulty 0.3-0.6
- [ ] AC-009: DEFAULT selected for difficulty > 0.6
- [ ] AC-010: explicit override beats difficulty selection
- [ ] AC-011: planner combines analyst+pm schemas
- [ ] AC-012: planner output compatible with downstream
- [ ] AC-018: SOLO DAG has single dev node
- [ ] AC-019: LIGHT DAG has planner -> dev -> qa
- [ ] AC-020: RESEARCH DAG has planner -> searchers -> synthesizer
- [ ] EC-001: empty topic prompts user
- [ ] EC-003: difficulty scoring fallback on error
- [ ] EC-004: explorer works without Brave Search
- [ ] EC-005: RESEARCH with 0 sub-questions falls back
- [ ] EC-006: "explore" vs "execute" intent distinction

Integration Tests:
- [ ] AC-002: inline button "Creer une tache" after exploration
- [ ] AC-013: Brave Search MCP accessible to spawned agents
- [ ] AC-016: RESEARCH pipeline end-to-end
- [ ] MCP server end-to-end: create task, verify in DB, verify notification enqueued

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
