# Claude Telegram Relay

> Claude Code reads this file automatically.

## Architecture

Modular TypeScript monolith: Telegram bot orchestrating BMad AI agents via Supabase.

**Data flow:** Telegram → relay.ts → Supabase (tasks, memory, metrics) → Claude Code agents → GitHub PRs → deployment

### Source Modules (`src/`)

| Module | Purpose |
|--------|---------|
| `relay.ts` | Bot entrypoint: creates Bot, loads Composers, auth middleware, startup/shutdown |
| `bot-context.ts` | Shared dependency object for Composers (callClaude, sendResponse, supabase, session) |
| `topic-config.ts` | Per-topic system prompts and command allowlists for forum groups |
| `loader.ts` | Auto-discovers and loads Composer modules from src/commands/ |
| `commands/help.ts` | Composer: /help, /workflow, /agents, /status, /monitor |
| `commands/tasks.ts` | Composer: /task, /backlog, /sprint, /start, /done |
| `commands/execution.ts` | Composer: /exec, /orchestrate (--skip-challenge), /autopipeline + gate/challenge callbacks |
| `commands/planning.ts` | Composer: /plan, /prd, /planify + PRD validation callbacks |
| `commands/memory-cmds.ts` | Composer: /brain, /ideas, /remind |
| `commands/quality.ts` | Composer: /metrics, /retro, /patterns, /alerts, /cost + retro callbacks |
| `commands/profile.ts` | Composer: /profile, /notify + profile update callbacks |
| `commands/project.ts` | Composer: /projects, /project |
| `commands/documents.ts` | Composer: /docs + classification callbacks |
| `commands/exploration.ts` | Composer: /explore — Explorer agent (Ada) |
| `commands/jobs.ts` | Composer: /jobs (list, cancel) |
| `commands/utilities.ts` | Composer: /speak, /export, /feature, /estimate, /rollback + callbacks |
| `commands/zz-messages.ts` | Composer: message handlers (text, voice, photo, document) with intent routing |
| `agent.ts` | Sub-agent execution: centralized spawnClaude() with branch-PR workflow |
| `agent-context.ts` | Supabase context assembly for agents with token budgets per role |
| `code-graph.ts` | Codebase knowledge graph: regex indexer, dependency queries, impact radius |
| `explore-graph.ts` | Zero-LLM fast-path for /explore structural queries via code graph |
| `tasks.ts` | Task CRUD: backlog → in_progress → review → done lifecycle |
| `memory.ts` | Intelligent memory: classification, importance scoring, contradiction detection, clustering |
| `gates.ts` | BMad gates: PRD approval, architecture validation, code review |
| `orchestrator.ts` | Multi-agent pipeline orchestrator with sequential execution and retry |
| `blackboard.ts` | Shared structured workspace: versioned JSONB, optimistic locking, role authorization |
| `deliberation.ts` | Deliberation protocol: paired reviewer examines strategic agent output |
| `semaphore.ts` | Promise-based counting semaphore (default max 3) |
| `gate-evaluator.ts` | Gate evaluation: dual verification, structured rubric scoring (4x25), rework loop |
| `llm-router.ts` | LLM-based dynamic pipeline selection with difficulty scoring |
| `llm-ops.ts` | Unified LLM-Ops facade: prompt versioning, circuit-breaker, span attribution, observability |
| `logger.ts` | Structured logger: JSON (production) / colored (dev), correlation IDs, log level filtering |
| `adversarial-verifier.ts` | Clean room spec-vs-implementation drift detection, V-criteria conformance check |
| `adversarial-challenge.ts` | P2 adversarial challenge (Devil's Advocate) + E1 impact analysis before dev |
| `spec-lite.ts` | P1 lightweight spec phase: proto-spec with V-criteria and impacted files |
| `agent-schemas.ts` | Typed JSON output schemas per agent role, ProtoSpec/AdversarialResult/ImpactAnalysisResult |
| `bmad-agents.ts` | 8 agent definitions with YAML templates, CLI flags, trust thresholds |
| `bmad-prompts.ts` | Context-aware prompt builder per agent role |
| `auto-pipeline.ts` | Autonomous end-to-end pipeline with auto selection and retries |
| `cost-tracking.ts` | Token usage tracking, multi-model cost estimation, sprint aggregation |
| `workflow.ts` | Workflow engine: state transitions, enforcement, retry policies |
| `alerts.ts` | Anomaly detection: stuck tasks, rework spikes, schedule slips |
| `patterns.ts` | Multi-sprint pattern analysis, workflow improvement proposals |
| `prd.ts` | PRD management: draft → approved/rejected |
| `prd-workflow.ts` | Conversational PRD-to-Deploy workflow with bounded revision |
| `code-review.ts` | Adversarial code review before merge |
| `feedback-loop.ts` | Double-loop learning: retro + gate analysis → agent prompt enrichment |
| `story-files.ts` | Structured task specs (acceptance criteria, test stubs, steps) |
| `documents.ts` | Document management: extraction, classification, CRUD, semantic search |
| `document-sharding.ts` | Intelligent context cache: splits large docs, loads relevant shards |
| `profile-evolution.ts` | Auto-learns user style, activity patterns, autonomy level |
| `proactive-planner.ts` | Backlog analysis, pipeline suggestions, auto-defer for overloaded sprints |
| `projects.ts` | Multi-project CRUD with topic-based routing |
| `notification-queue.ts` | Notification batching: flush intervals, digest, quiet hours, inline buttons |
| `notification-prefs.ts` | Notification preferences: quiet hours, per-type config |
| `transcribe.ts` | Voice transcription (Groq cloud or whisper-cpp local) |
| `tts.ts` | Text-to-speech via Piper (local) |
| `autonomy-scanner.ts` | Proactive task creation from codebase scanning |
| `job-manager.ts` | Background job manager: fire-and-forget, semaphore concurrency, persistence |
| `feature-flags.ts` | Feature flags: file-based toggle, hot-reload |
| `cost-estimate.ts` | Pre-implementation cost estimation based on agent budgets |
| `mcp-config.ts` | Per-role MCP tool configuration and allowlists |
| `exploration-scoring.ts` | Exploration phase scoring: graph + keywords + similarity |
| `pipeline-selection.ts` | Dynamic pipeline selection: keywords, constants, adaptive selection |
| `pipeline-state.ts` | Pipeline checkpoint/resume: persists state, enables resume from last success |
| `action-registry.ts` | Registry of all 34 bot commands: metadata, params, risk levels, aliases |
| `intent-detection.ts` | Two-tier intent detection: regex fast-path + LLM fallback |
| `command-router.ts` | Routes intents to commands: risk confirmation, parameter extraction |
| `trust-scores.ts` | Per-role trust scores: confidence tracking, autonomy levels |
| `gate-persistence.ts` | Gate evaluation persistence, double-loop learning |
| `agent-events.ts` | Agent event log (event sourcing): lifecycle tracking, timeline |
| `agent-messaging.ts` | Inter-agent messaging: structured messages, clarification, conflict detection |
| `conversation-session.ts` | Conversation sessions: per-chat tracking, constraint extraction, phase detection |
| `heartbeat.ts` | Autonomous heartbeat: periodic pulse, alert checks, memory archival |
| `heartbeat-prompt.ts` | Heartbeat prompt builder: system prompt, delta formatting, decision schema |

### Telegram Commands

| Command | Purpose |
|---------|---------|
| `/help` | Command reference |
| `/task <title>` | Create task (--desc, --priority, --hours) |
| `/backlog` | View backlog |
| `/sprint` | View current sprint + progress bar |
| `/start <id>` | Mark task in_progress |
| `/done <id>` | Mark task complete |
| `/exec <id>` | Launch Claude Code agent (requires Gate 1) |
| `/orchestrate <id>` | Full BMad multi-agent pipeline (--blackboard for gated SDD flow) |
| `/autopipeline <id>` | Autonomous end-to-end pipeline |
| `/docs` | Document management (list, search, stats, delete, categories) |
| `/explore <query>` | Launch Explorer agent to investigate a topic in the codebase |
| `/plan <request>` | Decompose request into subtasks |
| `/planify` | Proactive planner: backlog reordering, pacing |
| `/prd` | PRD management (create, list, view, approve, reject) |
| `/prd_workflow` | Conversational PRD-to-Deploy workflow |
| `/project` | Project management (create, switch, archive, topic) |
| `/projects` | List all projects |
| `/profile` | User profile (view, update, insights) |
| `/metrics` | Sprint metrics (velocity, rework, cycle time) |
| `/retro <sprint>` | Generate retrospective |
| `/patterns` | Workflow pattern analysis |
| `/alerts` | Check anomalies |
| `/cost` | Token usage and cost tracking (per sprint or total) |
| `/status` | System health check |
| `/speak <text>` | Text-to-speech |
| `/remind <msg>` | Set reminder |
| `/workflow` | BMad workflow overview |
| `/agents` | List BMad agents |
| `/export` | Export tasks/metrics |
| `/brain` | Memory synthesis: patterns, health, ideas, suggestions |
| `/ideas` | Ideas pipeline: list, add, review, promote, archive |
| `/notify` | Notification preferences: status, quiet hours, on/off per type, immediate mode |
| `/estimate` | Pre-implementation cost estimation per sprint/pipeline |
| `/feature` | Feature flags: list, enable, disable |
| `/jobs` | Background job status (list, cancel) |
| `/rollback` | Rollback to previous commit |
| `/monitor` | Production monitoring: response time, spawn stats, module errors |

### Database (Supabase)

Tables: `messages`, `memory`, `memory_archive`, `tasks`, `projects`, `prds`, `sprint_metrics`, `workflow_logs`, `feedback_rules`, `workflow_proposals`, `retros`, `logs`, `document_shards`, `cost_tracking`, `blackboard`, `pipeline_runs`, `gate_evaluations`, `trust_scores`, `agent_events`, `document_categories`, `documents`, `prompt_versions`

RPCs: `get_recent_messages`, `get_active_goals`, `get_facts`, `get_sprint_summary`, `match_messages`, `match_memory`, `match_documents`, `archive_old_memories`, `bump_memory_access`

Edge Functions: `embed` (auto-embeddings on insert), `search` (semantic search), `classify-thought` (GPT-4o-mini message classification with idea detection), `memory-mcp` (memory CRUD + semantic search API)

### MCP Memory Server (`mcp/`)

Local MCP server (`.mcp.json`, stdio) exposing 21 tools: memory CRUD, task/PRD management, code graph queries, sprint/metrics/cost/alerts, feature flags, backlog analysis. Notification bridge via `mcp-pending-notifications.json`.

### BMad Workflow

**Gates:**
1. PRD approval required before /exec
2. Architecture validation
3. Code review (CI + adversarial review, 3+ findings required)

**Pipelines:**
- DEFAULT: analyst → pm → architect → dev → qa (complex features, difficulty > 0.6)
- LIGHT: planner → dev → qa (medium tasks, difficulty 0.3-0.6, planner = analyst+pm fusion)
- QUICK: dev → qa (auto-selected for bugs, fixes, docs, simple P3 tasks)
- SOLO: dev (trivial changes, difficulty < 0.3: typos, labels, config tweaks)
- REVIEW: qa → architect (auto-selected for review/audit/refactor tasks)
- RESEARCH: explorer → planner → dev → qa (web research, benchmarks, state of the art via Tavily)

Workflow steps (config/workflow.yaml): request → decomposition → validation → execution → review → closure

Details: see CHANGELOG.md and docs/sprints/ for version history.

### Infrastructure

**PM2 services** (ecosystem.config.cjs):
- `claude-relay` — Main bot
- `claude-dashboard` — Kanban board (port 3456)
- `claude-heartbeat` — Autonomous pulse every 10min (alert checks, memory archival, morning digest)
- `claude-system-alerts` — System health monitoring (every 15min)

**GitHub Actions** (self-hosted runner): `ci.yml` (PR checks: typecheck, tests, doc freshness, E2E) and `deploy.yml` (master: git pull, pm2 restart, smoke test, auto-rollback).

**Dashboard** (port 3456): Kanban board with project filter, sprint progress, task cards.

### Project Structure

```
src/                    62 TypeScript modules (core logic)
  commands/             13 Composer modules (Telegram command handlers)
dashboard/              Kanban board (server.ts + index.html)
config/                 profile.md, workflow.yaml, bmad-templates/
db/schema.sql           Authoritative database schema
mcp/                    MCP memory server (memory-server.ts)
supabase/functions/     Edge Functions (embed, search, classify-thought, memory-mcp)
tests/                  3212 tests (unit + integration + E2E)
scripts/                Deployment, token rotation, setup
docs/specs/             Formal specifications (SPEC-{name}.md)
docs/reviews/           Adversarial reviews, impact analysis, pipeline reports
docs/explorations/      Exploration reports (EXPLORE-{name}.md)
.claude/agents/         11 specialized agents (dev pipeline)
.claude/skills/         7 skills (dev pipeline orchestration)
```

### Dev Pipeline (maturation code)

Pour toute modification non triviale, utiliser le pipeline de maturation :

| Commande | Phase | Description |
|----------|-------|-------------|
| `/dev-explore` | 0 | Exploration structuree avant spec (optionnel, verdict GO/PIVOT/DROP) |
| `/dev-spec` | 1 | Specification formelle 9 sections + V-criteres |
| `/dev-challenge` | 2 | Challenge adversarial (3 agents paralleles) + analyse d'impact |
| `/dev-implement` | 3 | Implementation TDD (Test Architect → Implementer → Tester) |
| `/dev-review` | 4 | Revue de code |
| `/dev-doc` | 5 | Mise a jour documentation |
| `/dev-pipeline` | * | Meta-orchestrateur (toutes les phases bout en bout) |

Workflow complet : `/dev-spec` → quality gate → `/dev-challenge` + Impact → `/dev-implement` (TDD) → conformance → review → `/dev-doc` → commit

Reprise en contexte frais : `/dev-pipeline --from {phase} docs/specs/SPEC-{name}.md`

Details : voir [docs/WORKFLOW-PIPELINE.md](docs/WORKFLOW-PIPELINE.md) et [docs/WORKFLOW-DEV.md](docs/WORKFLOW-DEV.md)

### Conventions

- Runtime: Bun
- Tests: `bun test` (3212 tests, all must pass before merge)
- Git workflow: feature branch → PR → CI (must pass) → merge to master
- CI verification: after creating a PR, always run `./scripts/wait-ci.sh` to verify CI passes before announcing completion. Never declare a PR ready without confirmed green CI.
- Error handling: always destructure `{ error }` from Supabase operations and log with `log.error` (via `createLogger` from `src/logger.ts`)
- Telegram responses: plain text only, no markdown formatting
- Voice messages: always respond with voice + text (dual format)
- Language: French for user-facing, English for code/comments

## Setup

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide. Quick start: `bun run setup`.
