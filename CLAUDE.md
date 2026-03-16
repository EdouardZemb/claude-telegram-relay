# Claude Telegram Relay

> Claude Code reads this file automatically.

## Architecture

Modular TypeScript monolith: Telegram bot orchestrating BMad AI agents via Supabase.

**Data flow:** Telegram → relay.ts → Supabase (tasks, memory, metrics) → Claude Code agents → GitHub PRs → deployment

### Source Modules (`src/`)

| Module | Purpose |
|--------|---------|
| `relay.ts` | Bot entrypoint: creates Bot, loads Composers via loader, auth middleware, startup/shutdown. Exports async `createBot(token)` factory for E2E testing via `handleUpdate` |
| `bot-context.ts` | Shared dependency object for Composers: callClaude, sendResponse, buildPrompt, supabase, session, topic helpers |
| `topic-config.ts` | Topic configuration for Telegram forum groups: per-topic system prompts and command allowlists |
| `loader.ts` | Auto-discovers and loads Composer modules from src/commands/ via Bun Glob, errorBoundary per module |
| `commands/help.ts` | Composer: /help, /workflow, /agents, /status, /monitor |
| `commands/tasks.ts` | Composer: /task, /backlog, /sprint, /start, /done |
| `commands/execution.ts` | Composer: /exec, /orchestrate, /autopipeline + gate callbacks |
| `commands/planning.ts` | Composer: /plan, /prd, /planify + PRD validation callbacks |
| `commands/memory-cmds.ts` | Composer: /brain, /ideas, /remind |
| `commands/quality.ts` | Composer: /metrics, /retro, /patterns, /alerts, /cost + retro callbacks |
| `commands/profile.ts` | Composer: /profile, /notify + profile update callbacks |
| `commands/project.ts` | Composer: /projects, /project |
| `commands/utilities.ts` | Composer: /speak, /export, /feature, /estimate, /rollback + gate/notif callbacks |
| `commands/zz-messages.ts` | Composer: message:text, message:voice, message:photo, message:document handlers (loaded last) |
| `agent.ts` | Sub-agent execution: launches Claude Code with branch-PR workflow, centralized spawnClaude() with CLI flags |
| `agent-context.ts` | Supabase context assembly for BMad agents: memory, sprint, tasks, profile with token budgets per role |
| `tasks.ts` | Task CRUD: backlog → in_progress → review → done lifecycle |
| `memory.ts` | Intelligent memory: intent tags, auto-classification via GPT-4o-mini, semantic archive, ideas pipeline, importance scoring with temporal decay, contradiction detection |
| `gates.ts` | BMad gates: Gate 1 (PRD approval), Gate 2 (architecture), Gate 3 (code review) |
| `orchestrator.ts` | Multi-agent pipeline: structured JSON message passing, retry loop, dynamic pipeline selection, cost tracking per agent, blackboard integration, parallel DAG execution |
| `blackboard.ts` | Shared structured workspace: versioned JSONB sections, optimistic locking, role authorization, traceability reports, concurrent write retry, fan-in merge |
| `dag-executor.ts` | DAG-based parallel agent scheduler: dependency resolution, semaphore-gated concurrency, pre-defined DAGs (DEFAULT, QUICK, REVIEW) |
| `semaphore.ts` | Promise-based counting semaphore for concurrency control (default max 3) |
| `supervisor.ts` | Deterministic TypeScript supervisor: agent status tracking, retry/skip/escalate decisions, timeout, structured report with speedup ratio |
| `fan-out.ts` | Subtask parallelism: fan-out N Dev agents in worktrees, fan-in merge branches and blackboard sections, file overlap detection |
| `worktree.ts` | Git worktree lifecycle: create, push, merge, cleanup. Branch isolation for parallel agents |
| `gate-evaluator.ts` | Gate evaluation: dual verification (deterministic + LLM), structured rubric scoring (4x25), evaluate-rework loop (max 2 iterations), trust-based auto-approval |
| `llm-router.ts` | LLM-based router for dynamic pipeline selection: Haiku analyzes task, returns pipeline + model overrides + budget |
| `adversarial-verifier.ts` | Clean room spec-vs-implementation drift detection, coverage scoring |
| `agent-schemas.ts` | Typed JSON output schemas per agent role, parsing, structured chain context, JSON Schema for --json-schema flag |
| `bmad-agents.ts` | 6 agent definitions (analyst, pm, architect, dev, qa, sm) with YAML templates, CLI flags (effort, model, budget) |
| `bmad-prompts.ts` | Context-aware prompt builder per agent, system/task prompt split for --append-system-prompt |
| `auto-pipeline.ts` | Autonomous end-to-end pipeline with auto pipeline selection and retries |
| `cost-tracking.ts` | Token usage tracking, multi-model cost estimation (Opus/Sonnet/Haiku), sprint cost aggregation, /cost command |
| `workflow.ts` | Workflow engine: loads config/workflow.yaml, tracks state transitions, transition enforcement, retry policies |
| `alerts.ts` | Anomaly detection: stuck tasks, rework spikes, schedule slips |
| `patterns.ts` | Multi-sprint pattern analysis, workflow improvement proposals |
| `prd.ts` | PRD management: draft → approved/rejected |
| `code-review.ts` | Adversarial code review before merge, --from-pr support, worktree isolation |
| `feedback-loop.ts` | Learning from retros + double-loop gate analysis → permanent agent prompt enrichment |
| `story-files.ts` | Structured task specs (acceptance criteria, test stubs, steps) |
| `document-sharding.ts` | Intelligent context cache: splits large docs, loads only relevant shards |
| `workflow-propagation.ts` | Cross-project improvement voting |
| `profile-evolution.ts` | Auto-learns user style, activity patterns, autonomy level |
| `proactive-planner.ts` | Daily backlog analysis + recommendations |
| `projects.ts` | Multi-project CRUD with topic-based routing |
| `notifications.ts` | Proactive Telegram notifications routed through notification queue (tasks, ideas, PRs) |
| `notification-queue.ts` | Notification batching queue: enqueue, flush, digest formatting, inline buttons, quiet hours, morning digest, JSON persistence |
| `notification-prefs.ts` | Notification preferences: quiet hours, per-type enable/disable/immediate, /notify command config |
| `transcribe.ts` | Voice transcription (Groq cloud or whisper-cpp local) |
| `tts.ts` | Text-to-speech via Piper (local) |
| `autonomy-scanner.ts` | Proactive task creation: scans codebase for improvements, creates auto-generated tasks |
| `autonomy-cron.ts` | Scheduled autonomy runner: daily scan trigger via PM2 cron |
| `alert-cron.ts` | Hourly scheduled alert runner + memory archival + morning digest flush |
| `feature-flags.ts` | Feature flags: file-based toggle system, hot-reload, /feature command |
| `cost-estimate.ts` | Pre-implementation cost estimation based on agent budgets and historical data |
| `mcp-config.ts` | Per-role MCP tool configuration: tool allowlists, system prompt instructions for agent MCP access |
| `pipeline-state.ts` | Pipeline checkpoint/resume: persists execution state after each agent step, enables resuming from last success |
| `intent-detection.ts` | Intent detection spike: pattern-based natural language to command mapping, behind feature flag |
| `trust-scores.ts` | Trust scores per agent role: confidence tracking, auto-approval logic, progressive autonomy |
| `gate-persistence.ts` | Gate evaluation persistence to Supabase, double-loop learning from recurring rubric weaknesses |

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
| `/plan <request>` | Decompose request into subtasks |
| `/planify` | Proactive planner: backlog reordering, pacing |
| `/prd` | PRD management (create, list, view, approve, reject) |
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
| `/rollback` | Rollback to previous commit |
| `/monitor` | Production monitoring: response time, spawn stats, module errors |

### Database (Supabase)

Tables: `messages`, `memory`, `memory_archive`, `tasks`, `projects`, `prds`, `sprint_metrics`, `workflow_logs`, `feedback_rules`, `workflow_proposals`, `retros`, `logs`, `document_shards`, `cost_tracking`, `blackboard`, `pipeline_runs`, `gate_evaluations`, `trust_scores`

RPCs: `get_recent_messages`, `get_active_goals`, `get_facts`, `get_sprint_summary`, `match_messages`, `match_memory`, `archive_old_memories`, `bump_memory_access`

Edge Functions: `embed` (auto-embeddings on insert), `search` (semantic search), `classify-thought` (GPT-4o-mini message classification with idea detection), `memory-mcp` (memory CRUD + semantic search API)

### MCP Memory Server (`mcp/`)

Local MCP server exposing memory tools to Claude Code sessions:
- `search_thoughts` — Semantic search via embeddings
- `list_thoughts` — List recent memories by type
- `thought_stats` — Memory statistics
- `capture_thought` — Insert new memory

Config: `.mcp.json`. Transport: stdio. Wraps the `memory-mcp` Edge Function.

### BMad Workflow

**Gates:**
1. PRD approval required before /exec
2. Architecture validation
3. Code review (CI + adversarial review, 3+ findings required)

**Pipelines:**
- DEFAULT: analyst → pm → architect → dev → qa
- QUICK: dev → qa (auto-selected for bugs, fixes, docs, simple P3 tasks)
- REVIEW: qa → architect (auto-selected for review/audit/refactor tasks)

**Pipeline selection (S22):** `autoPipeline: true` enables dynamic selection based on task title/description keywords and priority. Manual override via explicit `pipeline` option.

**Structured message passing (S22):** Agents produce typed JSON output (<<<JSON>>>...<<<END>>> markers). Each role has a defined schema (analyst: risks/feasibility, pm: subtasks/priorities, architect: design/decisions, dev: files/summary, qa: score/findings, sm: summary/next_steps). Downstream agents receive structured context instead of raw text.

**Retry loop (S22):** `maxRetries` option (default 0). Failed agents are retried with exponential backoff (1s, 2s, 4s... max 30s). Retry metrics logged to workflow_logs.

**Cost tracking (S23):** Each agent execution logs token usage (input/output) and estimated cost to `cost_tracking` table. Sprint metrics include total tokens and cost. `/cost` command shows breakdown by agent and task.

**Memory importance (S23):** Memories have `importance_score` (0-100) with exponential temporal decay (half-life 70 days). Access boosts score. `getMemoryContext` serves top 20 facts and top 10 goals ranked by importance. Contradiction detection flags semantically similar existing facts.

**Workflow enforcement (S23):** `WorkflowTracker.transition()` accepts `enforce: true` to validate transitions against workflow.yaml. Retry policies are derived from checkpoint modes (off=0, light=1, strict=3).

**Blackboard (S24):** Shared JSONB workspace per pipeline run (`blackboard` table). 5 sections: spec, plan, tasks, implementation, verification. Versioned with optimistic locking. Role-based write authorization. `useBlackboard: true` on orchestrate() enables the blackboard flow. Gate Evaluator checks quality at each gate (score 0-100, pass/fail). Evaluate-rework loop (max 2 iterations) self-corrects on failure. Adversarial Verifier detects spec drift in clean room (spec + implementation only, no plan/tasks). Traceability report maps FR->tasks->tests->files. `/orchestrate <id> [pipeline] --blackboard` activates the flow.

**Parallel execution (S25):** DAG-based parallel scheduling replaces sequential for...of loop when `parallel: true`. Three levels: (1) independent agents run concurrently (analyst+PM in DEFAULT), (2) fan-out N Dev agents on subtasks (each in git worktree), (3) batch tasks in autopipeline. Supervisor (TypeScript, zero LLM cost) handles retry/skip/escalate. Semaphore limits max concurrency (default 3). Blackboard supports concurrent writes via `writeSectionWithRetry`. ParallelMetrics track speedup ratio. `/orchestrate <id> [pipeline] --parallel` activates parallel mode. Backward-compatible: `parallel: false` (default) = sequential.

**Smart Notifications (S26):** All proactive notifications (tasks, PRs, ideas, alerts) route through a batching queue (`notification-queue.ts`). Batching: flush after 5min interval OR 5-message threshold, whichever comes first. Single notifications sent standalone with inline action buttons; 2+ grouped into digest format. Quiet hours (default 20h-9h, timezone-aware) queue non-critical notifications for morning digest. Critical alerts bypass quiet hours. Inline buttons: task (Demarrer/Terminer/Voir), PR (URL button), idea (Promouvoir/Archiver), alert (Voir tache/sprint/Ignorer). Preferences configurable via `/notify` command (quiet hours, per-type enable/disable/immediate). Persistence: queue + prefs saved to JSON files in RELAY_DIR. Morning digest triggered by alert-cron when quiet hours end.

**Documentation & Maintenance (S27):** Automated documentation freshness enforcement. CI step (`scripts/doc-freshness.ts`) verifies every PR: all `src/*.ts` modules appear in CLAUDE.md module table, all `bot.command()` registrations appear in commands table, test count within ±10 of documented value. Conventional commit format enforced by pre-push hook (regex, no external deps). `git-cliff` generates CHANGELOG.md from commit history. `scripts/doc-check.ts` proposes CLAUDE.md updates interactively (`bun run doc:check`). Architecture Decision Records in `docs/adr/`. TSDoc `@module`/`@description` headers on all source modules.

**CLI Optimization (S28):** Centralized `spawnClaude()` function in `agent.ts` replaces 5 duplicated spawn calls. All CLI flags are conditionally constructed: `--output-format json` + `--json-schema` for structured output (replaces <<<JSON>>> markers as primary, kept as fallback), `--effort` per agent role (low/medium/high/max), `--model` + `--fallback-model` for model routing (Opus for architect/dev, Sonnet for analyst/pm/qa, Haiku for sm), `--max-budget-usd` as per-agent cost guard, `--append-system-prompt` for system/task prompt separation, `-w` for worktree isolation (exec/code-review), `--from-pr` for code review PR context. Multi-model pricing in `cost-tracking.ts` (Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per 1M tokens). Agent CLI config (effort, model, budget) defined in `bmad-agents.ts` as source of truth. Backward compatible: all flags are optional, omitted when not set.

**Production Readiness (S29):** Post-deploy validation pipeline. Smoke tests (`bun run smoke`) run 5 checks: PM2 services, Dashboard health, Supabase connectivity, Claude CLI, Telegram bot. Each with 10s timeout, report sent to Telegram. Auto-rollback in deploy.yml if smoke fails (`scripts/rollback.sh`). Feature flags in `config/features.json` with `/feature` command (list/enable/disable, hot-reload). Pre-implementation cost estimation (`/estimate <n> [pipeline]`) based on agent budgets from bmad-agents.ts with historical comparison. Production monitoring in alerts.ts: response time p50/p95/p99 (ring buffer), spawn success/failure rate per agent role, module error counters (1h window). `/monitor` command. `system-alerts.sh` activated via PM2 (every 15min) with 1h cooldown per alert type. Post-merge checklist generation from sprint tasks. `/rollback` command for manual rollback.

**CI/CD & E2E Testing (S30):** Self-hosted GitHub Actions runner on the server (systemd, HTTPS outbound only — no firewall issues). CI (`ci.yml`) and deploy (`deploy.yml`) run on `[self-hosted, linux]`. Deploy is local (git pull + pm2 restart + smoke test + auto-rollback), replacing SSH-based deploy. Auto-deploy polling (`auto-deploy.sh`, `claude-autodeploy` PM2 service) removed — redundant with runner. E2E tests use Grammy's `bot.handleUpdate()` to inject synthetic Telegram updates into the bot's handler pipeline. `relay.ts` exports `createBot(token)` factory function; `import.meta.main` guards startup side effects (bot.start, PID file, intervals, process handlers). E2E framework (`tests/e2e/framework.ts`) intercepts `ctx.reply()` via Grammy API transformer — no real Telegram API calls. 8 E2E tests cover /help, /status, /feature, /workflow, /agents, /monitor, /estimate, /notify. Data isolation via `[E2E-<runId>]` prefix tags, cleanup after each test. E2E job in CI depends on check job, uses RELAY_DIR in /tmp.

**Composer Extensibility (S31):** Refactored relay.ts (3216→243 lines) using Grammy's native Composer pattern. `src/bot-context.ts` provides a typed `BotContext` dependency object (callClaude, sendResponse, buildPrompt, supabase, session, topic helpers) injected into all Composers. `src/loader.ts` auto-discovers `src/commands/*.ts` via Bun Glob, imports each module, and mounts Composers with per-module errorBoundary. 10 Composer modules cover all 33 commands + 4 message handlers + callbacks. `src/topic-config.ts` extracts per-topic system prompts and command allowlists. Adding a new feature = creating a new file in `src/commands/`, no relay.ts modification needed. Zero new dependencies. ADR-007.

**Advanced Multi-Agent Architecture (S33):** Three architectural improvements plus intent detection spike. (1) MCP Dynamic: `src/mcp-config.ts` defines per-role MCP tool allowlists (analyst: read-only context, dev/architect: full blackboard access, qa: read-only, sm: memory-only). `spawnClaude()` accepts `mcpRole` option, injects MCP tool instructions into agent system prompt via `buildMcpToolInstructions()`. Agents inherit MCP server access from project `.mcp.json` automatically. (2) Checkpoint/Resume: `pipeline_runs` table tracks pipeline execution state. `src/pipeline-state.ts` saves state after each agent step (`savePipelineStep()`), enables resume from last successful agent (`buildResumeContext()`). `/orchestrate <id> --resume [sessionId]` resumes failed pipelines. In-memory fallback when Supabase unavailable. (3) Intent Detection: `src/intent-detection.ts` maps natural language to commands via regex patterns with confidence scoring (0.7-0.95). Behind `intent_detection` feature flag (disabled by default). Integrated in `zz-messages.ts` text handler — suggests matching command when confidence >= 0.8.

**Quality Foundations & Routing (S34):** Four improvements to gate intelligence and cost optimization. (1) Dual Verification: `gate-evaluator.ts` runs deterministic checks (tsc type check, bun test) BEFORE LLM evaluation on implementation gates. If checks fail, gate fails immediately without LLM cost. Non-implementation gates (spec, plan, tasks) skip deterministic checks. 30s timeout per check. (2) Structured Rubric Scoring: Gates score 4 dimensions x 25 points instead of single 0-100. Implementation gates: error_handling, test_coverage, code_style, spec_conformity. Spec/plan gates: completeness, traceability, clarity, feasibility. Dimension below 10 flagged as critical weakness. Total = sum of dimensions (0-100 scale preserved). (3) Model Cascade: `spawnClaudeWithCascade()` in agent.ts starts with Haiku, escalates to Sonnet then Opus on failure. Failure context from previous attempt included in escalated prompt. Explicit model override disables cascade. Cascade disabled by default (backward compatible). (4) LLM Router: `src/llm-router.ts` uses a Haiku call to analyze task and return pipeline type + per-role model overrides + budget. Replaces keyword matching in auto-pipeline when `useRouter: true`. 5s timeout with fallback to keyword-based classifyPipeline(). Feature flags: `llm_router`, `model_cascade` (both disabled by default).

**Auto-improvement & Confidence (S35):** Five features for progressive autonomy and self-improvement. (1) Gate Evaluation Persistence: every `evaluateGate()` result is persisted to `gate_evaluations` table with rubric dimensions, deterministic check results, rework iteration, and auto-approval flag. (2) Trust Scores: `trust_scores` table tracks per-agent-role confidence (0-100, default 50). Pass without rework: +5, pass with rework: +1, fail: -10. Updated automatically after each gate evaluation via `evaluateAndRework()`. (3) Double-loop Learning: when a rubric dimension scores below 15/25 three or more times for an agent role, a corrective feedback rule is auto-generated in `feedback_rules` (source: `double_loop`). Injected into agent prompts via `buildFeedbackContext()`. (4) Progressive Gate Auto-approval: trust >= 80 + P3+ tasks: spec/plan/tasks gates auto-approved (skip LLM). Trust >= 90 + P3+: implementation gates auto-approved (deterministic checks still run). P1/P2 always fully evaluated. Behind `auto_gate_approval` feature flag (disabled by default). (5) /monitor Extension: shows trust scores, 5 most recent gate evaluations, and active double-loop rules.

**Workflow steps** (config/workflow.yaml): request → decomposition → validation → execution → review → closure

### Infrastructure

**PM2 services** (ecosystem.config.cjs):
- `claude-relay` — Main bot (start-relay.sh)
- `claude-dashboard` — Kanban board (port 3456)
- `claude-alert-cron` — Hourly anomaly detection
- `claude-system-alerts` — System health monitoring (every 15min)

**GitHub Actions** (self-hosted runner):
- Runner installed on server via `scripts/setup-runner.sh` (systemd service)
- `ci.yml` — PR checks: type check, unit/integration/system tests, doc freshness, E2E tests
- `deploy.yml` — Production deploy on push to master: git pull, pm2 restart, smoke test, auto-rollback
- E2E job runs after unit tests, uses `handleUpdate` injection (no Telegram API dependency)

**Dashboard** (port 3456): Kanban board with project filter, sprint progress, task cards. API: /api/projects, /api/tasks, /api/prds, /api/health

### Project Structure

```
src/                    44 TypeScript modules (core logic)
  commands/             10 Composer modules (Telegram command handlers)
dashboard/              Kanban board (server.ts + index.html)
config/
  profile.md            User profile
  workflow.yaml         Workflow state machine
  bmad-templates/       Agent YAML definitions + workflow templates
db/schema.sql           Authoritative database schema
mcp/                    MCP memory server (memory-server.ts)
supabase/functions/     Edge Functions (embed, search, classify-thought, memory-mcp)
tests/                  948 tests (unit + integration + E2E)
scripts/                Deployment, token rotation, setup
examples/               Onboarding examples (morning briefing, checkin, memory)
```

### Conventions

- Runtime: Bun
- Tests: `bun test` (948 tests, all must pass before merge)
- Git workflow: feature branch → PR → CI (must pass) → merge to master
- CI verification: after creating a PR, always run `./scripts/wait-ci.sh` to verify CI passes before announcing completion. Never declare a PR ready without confirmed green CI.
- Error handling: always destructure `{ error }` from Supabase operations and log with `console.error`
- Telegram responses: plain text only, no markdown formatting
- Voice messages: always respond with voice + text (dual format)
- Language: French for user-facing, English for code/comments

---

## Setup Guide

> For new users setting up the project. Walk through one phase at a time.
> If this is a fresh clone, run `bun run setup` first.

### Phase 1: Telegram Bot (~3 min)

**You need from the user:**
- A Telegram bot token from @BotFather
- Their personal Telegram user ID

**What to tell them:**
1. Open Telegram, search for @BotFather, send `/newbot`
2. Pick a display name and a username ending in "bot"
3. Copy the token BotFather gives them
4. Get their user ID by messaging @userinfobot on Telegram

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`
3. Run `bun run test:telegram` to verify — it sends a test message to the user

**Done when:** Test message arrives on Telegram.

### Phase 2: Database & Memory — Supabase (~12 min)

#### Step 1: Create Supabase Project

**You need from the user:**
- Supabase Project URL
- Supabase anon public key

**What to tell them:**
1. Go to supabase.com, create a free account
2. Create a new project (any name, any region close to them)
3. Wait ~2 minutes for it to provision
4. Go to Project Settings > API
5. Copy: Project URL and anon public key

**What you do:**
1. Save `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`

#### Step 2: Connect Supabase MCP

**What to tell them:**
1. Go to supabase.com/dashboard/account/tokens
2. Create an access token, copy it

**What you do:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

#### Step 3: Create Tables

1. Read `db/schema.sql`
2. Execute it via `execute_sql` (or tell the user to paste it in the SQL Editor)
3. Run `bun run test:supabase` to verify tables exist

#### Step 4: Set Up Semantic Search

**You need from the user:**
- An OpenAI API key (for generating text embeddings)

**What you do:**
1. Deploy the embed Edge Function via Supabase MCP (`deploy_edge_function` with `supabase/functions/embed/index.ts`)
2. Deploy the search Edge Function (`supabase/functions/search/index.ts`)
3. Tell the user to store their OpenAI key in Supabase:
   - Go to Supabase dashboard > Project Settings > Edge Functions
   - Under Secrets, add: `OPENAI_API_KEY` = their key
4. Set up database webhooks so embeddings are generated automatically:
   - Go to Supabase dashboard > Database > Webhooks > Create webhook
   - Name: `embed_messages`, Table: `messages`, Events: INSERT
   - Type: Supabase Edge Function, Function: `embed`
   - Create a second webhook: `embed_memory`, Table: `memory`, Events: INSERT, Function: `embed`

#### Step 5: Verify

Run `bun run test:supabase` to confirm tables exist, Edge Functions respond, and embeddings work.

### Phase 3: Personalize (~3 min)

**Ask the user:** first name, timezone, occupation, time constraints, communication style.

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers

### Phase 4: Test (~2 min)

1. Run `bun run start`
2. Tell the user to send a test message on Telegram
3. Confirm it responded, then Ctrl+C to stop

### Phase 5: Always On (~5 min)

**macOS:** `bun run setup:launchd -- --service relay`
**Linux:** `bun run setup:services -- --service relay` (uses PM2)
**Verify:** `npx pm2 status` (Linux) or `launchctl list | grep com.claude` (macOS)

### Phase 6: Proactive AI (Optional)

- `examples/smart-checkin.ts` — Periodic intelligent check-ins
- `examples/morning-briefing.ts` — Daily summary

Schedule: `bun run setup:services -- --service all`

### Phase 7: Voice Transcription (Optional)

**Option A: Groq (recommended)** — Set `VOICE_PROVIDER=groq` and `GROQ_API_KEY`
**Option B: Local whisper** — Set `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH`
Verify: `bun run test:voice`

### After Setup

Run `bun run setup:verify` for full health check.
