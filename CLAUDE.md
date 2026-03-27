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
| `config.ts` | Centralized env var validation via Zod: lazy singleton getConfig(), AppConfig type, _resetConfigForTesting() for tests |
| `topic-config.ts` | Per-topic system prompts and command allowlists for forum groups |
| `loader.ts` | Auto-discovers and loads Composer modules from src/commands/ |
| `commands/help.ts` | Composer: /help (interactive category menu + menu_ callbacks), /workflow, /status, /monitor |
| `commands/tasks.ts` | Composer: /task, /backlog, /sprint, /start (onboarding + task start), /done + task_ callbacks |
| `commands/memory-cmds.ts` | Composer: /brain, /ideas, /remind |
| `commands/quality.ts` | Composer: /metrics (+ quality nav keyboard), /retro, /patterns, /alerts, /cost + retro callbacks |
| `commands/profile.ts` | Composer: /profile, /notify (inline prefs keyboard + notify_ callbacks) |
| `commands/project.ts` | Composer: /projects, /project |
| `commands/documents.ts` | Composer: /docs + classification callbacks |
| `commands/exploration.ts` | Composer: /explore — Explorer agent (Ada) |
| `commands/jobs.ts` | Composer: /jobs (list, cancel) |
| `commands/command-router.ts` | Routing helpers: actionVerb, buildClarificationQuestion, routeIntent, checkPendingClarification, handleConfirmationCallback, buildSyntheticUpdate |
| `commands/sdd-flow.ts` | Composer: SDD InlineKeyboard callbacks (sdd_ prefix), contextual keyboard construction, convergence detection |
| `commands/utilities.ts` | Composer: /speak, /export, /feature, /rollback + callbacks |
| `commands/zz-messages.ts` | Composer: message handlers (text, voice, photo, document) with intent routing and SDD pipeline context injection |
| `commands/maturation.ts` | Composer: /idea (maturation pipeline launch + mat_ callbacks) |
| `maturation/types.ts` | Maturation engine types: phases, steps, runs, documents, quality gates |
| `maturation/documents.ts` | Maturation filesystem I/O: run directories, atomic document persistence |
| `maturation/scoring.ts` | Quality gate scoring: ambiguity/maturity extraction, gate evaluation |
| `maturation/engine.ts` | Maturation state machine: phase transitions, loop logic, circuit breaker |
| `maturation/phases.ts` | Phase execution: P0-P3b runners with parallel agent spawning |
| `maturation/agents.ts` | Maturation agent configuration: prompt builders, model/effort mapping |
| `maturation/index.ts` | Barrel re-export for maturation sub-modules |
| `maturation.ts` | Root barrel re-export for maturation module (barrel convention) |
| `agent.ts` | Sub-agent execution: centralized spawnClaude() with branch-PR workflow |
| `agent-context.ts` | Enriched Supabase context builder for SDD agents: buildAgentContext(supabase, role, phase) with parallel fetch, timeout, size cap |
| `html-format-helpers.ts` | Shared HTML formatting helpers for Telegram: sectionTitle, separator, progressBar, kvLine, statusIcon, bulletList, collapsibleSection |
| `html-utils.ts` | HTML escaping for Telegram HTML parse_mode: escapeHtml() — extracted to avoid circular imports with memory sub-modules |
| `result.ts` | Custom Result<T, E> discriminant type with ok/err constructors and isOk/isErr type guards (vague 3) |
| `tasks.ts` | Task CRUD: backlog → in_progress → review → done lifecycle |
| `memory.ts` | Barrel re-export for memory sub-modules (see `src/memory/`) |
| `memory/core.ts` | Core memory: processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext, archiveOldMemories |
| `memory/classification.ts` | Message classification, autoRemember, findDuplicateIdea, classifyLinkContent |
| `memory/scoring.ts` | Importance scoring, temporal decay, conflict resolution, contradiction detection |
| `memory/ideas.ts` | Ideas CRUD: listIdeas, getIdea, reviewIdea, promoteIdea, archiveIdea, formatIdeasList |
| `memory/graph.ts` | Memory linking, chains, clustering, health stats, buildMemoryChains |
| `memory/agent-memory.ts` | Role-specific agent memory: ROLE_CANONICAL_TAGS, saveAgentMemory, getAgentMemories, graduateAgentMemory |
| `gates.ts` | BMad gates: PRD approval, architecture validation, code review |
| `semaphore.ts` | Promise-based counting semaphore (default max 3) |
| `llm-ops.ts` | Unified LLM-Ops facade: prompt versioning, circuit-breaker, span attribution, cost tracking, observability |
| `logger.ts` | Structured logger: JSON (production) / colored (dev), correlation IDs, log level filtering |
| `alerts.ts` | Anomaly detection: stuck tasks, rework spikes, schedule slips |
| `doc-utils.ts` | Documentation parsing utilities: module/command extraction, test count, gap detection |
| `documents.ts` | Document management: extraction, classification, CRUD, semantic search |
| `document-sharding.ts` | Intelligent context cache: splits large docs, loads relevant shards |
| `projects.ts` | Multi-project CRUD with topic-based routing |
| `notification-queue.ts` | Notification batching: flush intervals, digest, quiet hours, inline buttons, preferences |
| `transcribe.ts` | Voice transcription (Groq cloud or whisper-cpp local) |
| `tts.ts` | Text-to-speech via Piper (local) |
| `job-manager.ts` | Background job manager: fire-and-forget, semaphore concurrency, persistence, batch result parsing, progress messaging |
| `feature-flags.ts` | Feature flags: Supabase persistence + in-memory cache, file fallback (initFeatureFlags, refreshFeatureFlags, isFeatureEnabled, setFeature async) |
| `pipeline-tracker.ts` | SDD pipeline tracker: per-chat state tracking, disk persistence, status bar formatting, pipeline context injection for prompts |
| `conversation-handoff.ts` | Conversation-to-agent handoff: local pattern matching extraction of decisions/constraints |
| `sdd-agents.ts` | SDD agent functions: business logic for each pipeline phase (explore, spec, challenge, implement, review), auto-merge via gh pr merge --auto |
| `prompt-overlay.ts` | Prompt overlay CRUD: dynamic feedback overlays for SDD agents, JSON local storage, max 3 per role, TTL, buildEnrichedPrompt |
| `feedback-analyzer.ts` | Agent feedback analysis: recurring failure pattern detection, overlay generation, runFeedbackLoop orchestrator |
| `sdd-auto-advance.ts` | Event-driven SDD auto-advance: getNextSddPhase mapping, depth circuit breaker, tryAutoAdvance orchestration |
| `sdd-task-sync.ts` | SDD-backlog sync: PHASE_TO_TASK_STATUS mapping, syncTaskStatusForPhase best-effort sync (no downgrade, errors logged) |
| `sdd-event.ts` | SDD verdict emission: best-effort write to agent_events after SDD job completion, emitSddVerdict with PHASE_TO_AGENT_ROLE mapping |
| `action-registry.ts` | Registry of bot commands: metadata, params, risk levels, aliases, categories |
| `inline-menus.ts` | Progressive inline menu system: category grouping, dynamic keyboards, onboarding, quality/notify navigation |
| `intent-detection.ts` | Two-tier intent detection: regex fast-path + LLM fallback, feature_request intent for SDD pipeline trigger |
| `heartbeat.ts` | Autonomous heartbeat: periodic pulse, alert checks, memory archival |
| `heartbeat-sdd-watchdog.ts` | SDD pipeline watchdog: detects orphaned/stuck pipeline phases (cross-process read) |
| `heartbeat-prompt.ts` | Heartbeat prompt builder: system prompt, delta formatting, decision schema |
| `heartbeat-sdd-watchdog.ts` | SDD pipeline watchdog for heartbeat: detects orphaned/stuck pipeline phases |

### Telegram Commands

| Command | Purpose |
|---------|---------|
| `/help` | Interactive command menu with category navigation (inline keyboard) |
| `/task <title>` | Create task (--desc, --priority, --hours) |
| `/backlog` | View backlog |
| `/sprint` | View current sprint + progress bar |
| `/start [id]` | Without args: onboarding with quick-access buttons. With id: mark task in_progress |
| `/done <id>` | Mark task complete |
| `/docs` | Document management (list, search, stats, delete, categories) |
| `/explore <query>` | Launch Explorer agent to investigate a topic in the codebase |
| `/project` | Project management (create, switch, archive, topic) |
| `/projects` | List all projects |
| `/profile` | User profile (view, update, insights) |
| `/metrics` | Sprint metrics (velocity, rework, cycle time) |
| `/retro <sprint>` | Generate retrospective |
| `/patterns` | Multi-sprint trend analysis |
| `/alerts` | Check anomalies |
| `/cost` | Token usage and cost tracking (per sprint or total) |
| `/status` | System health check |
| `/speak <text>` | Text-to-speech |
| `/remind <msg>` | Set reminder |
| `/workflow` | Development workflow overview |
| `/export` | Export tasks/metrics |
| `/brain` | Memory synthesis: patterns, health, ideas, suggestions. Sub-command: /brain health |
| `/ideas` | Ideas pipeline: list, add, review, promote, archive |
| `/notify` | Notification preferences: status, quiet hours, on/off per type, immediate mode |
| `/feature` | Feature flags: list, enable, disable |
| `/jobs` | Background job status (list, cancel) |
| `/rollback` | Rollback to previous commit |
| `/monitor` | Production monitoring: response time, spawn stats, module errors |
| `/idea <description>` | Lancer la maturation multi-agent d'une idee (exploration, confrontation, synthese) |

### Database (Supabase)

Tables: `messages`, `memory`, `memory_archive`, `tasks`, `projects`, `prds`, `sprint_metrics`, `workflow_logs`, `feedback_rules`, `workflow_proposals`, `retros`, `logs`, `document_shards`, `cost_tracking`, `blackboard`, `pipeline_runs`, `gate_evaluations`, `trust_scores`, `agent_events`, `document_categories`, `documents`, `prompt_versions`, `agent_memory`, `feature_flags`

RPCs: `get_recent_messages`, `get_active_goals`, `get_facts`, `get_sprint_summary`, `match_messages`, `match_memory`, `match_documents`, `archive_old_memories`, `bump_memory_access`

Edge Functions: `embed` (auto-embeddings on insert), `search` (semantic search), `classify-thought` (GPT-4o-mini message classification with idea detection), `memory-mcp` (memory CRUD + semantic search API)

### MCP Memory Server (`mcp/`)

Local MCP server (`.mcp.json`, stdio) exposing tools: memory CRUD, task management, sprint/metrics/cost/alerts, feature flags. Notification bridge via `mcp-pending-notifications.json`.

### Development Workflow

The orchestration TypeScript modules (orchestrator/, blackboard, deliberation, gate-evaluator, pipeline-selection, etc.) have been removed in favour of the SDD (Spec-Driven Development) pipeline managed via `.claude/skills/` and `.claude/agents/`.

Workflow steps (config/workflow.yaml): request → decomposition → validation → execution → review → closure

Details: see CHANGELOG.md and docs/sprints/ for version history.

### Infrastructure

**PM2 services** (ecosystem.config.cjs):
- `claude-relay` — Main bot
- `claude-dashboard` — Kanban board (port 3456)
- `claude-heartbeat` — Autonomous pulse every 10min (alert checks, memory archival, morning digest)
- `claude-system-alerts` — System health monitoring (every 15min)

**GitHub Actions** (self-hosted runner): `ci.yml` (PR checks: typecheck, tests, doc freshness, per-file coverage, E2E) and `deploy.yml` (master: git pull, pm2 restart, smoke test, auto-rollback, gated by `sdd_auto_deploy` feature flag).

**Dashboard** (port 3456): Kanban board with project filter, sprint progress, task cards.

### Project Structure

```
src/                    64 TypeScript modules (core logic)
  commands/             13 Composer modules (Telegram command handlers)
  memory/               6 sub-modules (core, classification, scoring, ideas, graph, agent-memory)
  maturation/           7 sub-modules (types, documents, scoring, engine, phases, agents, barrel)
dashboard/              Kanban board (server.ts + index.html)
config/                 profile.md, workflow.yaml, bmad-templates/
db/schema.sql           Authoritative database schema
mcp/                    MCP memory server (memory-server.ts)
supabase/functions/     Edge Functions (embed, search, classify-thought, memory-mcp)
tests/                  2478 tests (unit + integration + E2E)
scripts/                Deployment, token rotation, setup, per-file coverage check
docs/specs/             Formal specifications (SPEC-{name}.md)
docs/reviews/           Adversarial reviews, impact analysis, pipeline reports
docs/explorations/      Exploration reports (EXPLORE-{name}.md)
docs/adr/               Architecture Decision Records (ADR-{nnn}.md)
.claude/agents/         15 specialized agents (6 dev pipeline + 9 maturation)
.claude/skills/         4 skills (dev pipeline orchestration)
.maturation/            Maturation engine runs (local-first, filesystem persistence)
```

### Dev Pipeline (maturation code)

Pour toute modification non triviale, utiliser le pipeline de maturation :

| Commande | Phase | Description |
|----------|-------|-------------|
| `/dev-explore` | 0 | Exploration structuree avant spec (optionnel, verdict GO/PIVOT/DROP) |
| `/dev-implement` | 1 | Implementation TDD (generation tests + code + validation) |
| `/dev-review` | 2 | Revue de code |
| `/dev-doc` | 3 | Mise a jour documentation |

Workflow : `/dev-explore` (optionnel) → `/dev-implement` (TDD) → `/dev-review` → `/dev-doc` → commit

Details : voir [docs/WORKFLOW-PIPELINE.md](docs/WORKFLOW-PIPELINE.md) et [docs/WORKFLOW-DEV.md](docs/WORKFLOW-DEV.md)

### Conventions

- Runtime: Bun
- Tests: `bun test` (2478 tests, all must pass before merge)
- Git workflow: feature branch → PR → CI (must pass) → merge to master
- CI verification: after creating a PR, always run `./scripts/wait-ci.sh` to verify CI passes before announcing completion. Never declare a PR ready without confirmed green CI.
- Error handling: always destructure `{ error }` from Supabase operations and log with `log.error` (via `createLogger` from `src/logger.ts`)
- Telegram responses: LLM responses (callClaude) use plain text via sendResponse. Bot-side formatting functions (formatBacklog, formatMetrics, etc.) use HTML via sendResponseHtml — escapeHtml() mandatory for all dynamic content interpolated in HTML strings.
- Voice messages: always respond with voice + text (dual format)
- Language: French for user-facing, English for code/comments
- Barrel convention: any module refactored into a sub-directory MUST keep a barrel file at the original path (re-exports only, no logic) so existing imports remain unchanged
- File size guideline: source files > 800 LOC (excluding barrels and tests) are candidates for refactoring into sub-modules. Currently all files under threshold
- Coding standards (enforced in `tests/unit/coding-standards.test.ts` and CI): S1 no direct `console` calls (use createLogger), S2 no direct `process.env` (use getConfig), S3 LOC threshold 800, S4 architectural boundaries, S5 barrel convention, S6 createLogger mandatory for modules with logic, S7 no circular imports (DFS detection), S8 per-file coverage minimum 30% (`scripts/check-coverage.sh`), S9 process.env allowlist size cap (max 20). Details: `docs/specs/SPEC-enforcement-standards-agents.md`

## Setup

See [docs/SETUP.md](docs/SETUP.md) for the full setup guide. Quick start: `bun run setup`.
