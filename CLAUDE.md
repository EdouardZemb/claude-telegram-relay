# Claude Telegram Relay

> Claude Code reads this file automatically.

## Architecture

Modular TypeScript monolith: Telegram bot orchestrating BMad AI agents via Supabase.

**Data flow:** Telegram → relay.ts → Supabase (tasks, memory, metrics) → Claude Code agents → GitHub PRs → deployment

### Source Modules (`src/`)

| Module | Purpose |
|--------|---------|
| `relay.ts` | Main bot: message handling, 27 Telegram commands, voice, photos, docs |
| `agent.ts` | Sub-agent execution: launches Claude Code with branch-PR workflow |
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
| `gate-evaluator.ts` | Gate evaluation: LLM-based quality checks at pipeline gates, evaluate-rework loop (max 2 iterations) |
| `adversarial-verifier.ts` | Clean room spec-vs-implementation drift detection, coverage scoring |
| `agent-schemas.ts` | Typed JSON output schemas per agent role, parsing, structured chain context |
| `bmad-agents.ts` | 6 agent definitions (analyst, pm, architect, dev, qa, sm) with YAML templates |
| `bmad-prompts.ts` | Context-aware prompt builder per agent |
| `auto-pipeline.ts` | Autonomous end-to-end pipeline with auto pipeline selection and retries |
| `cost-tracking.ts` | Token usage tracking, cost estimation, sprint cost aggregation, /cost command |
| `workflow.ts` | Workflow engine: loads config/workflow.yaml, tracks state transitions, transition enforcement, retry policies |
| `alerts.ts` | Anomaly detection: stuck tasks, rework spikes, schedule slips |
| `patterns.ts` | Multi-sprint pattern analysis, workflow improvement proposals |
| `prd.ts` | PRD management: draft → approved/rejected |
| `code-review.ts` | Adversarial code review before merge |
| `feedback-loop.ts` | Learning from retros → permanent agent prompt enrichment |
| `story-files.ts` | Structured task specs (acceptance criteria, test stubs, steps) |
| `document-sharding.ts` | Intelligent context cache: splits large docs, loads only relevant shards |
| `workflow-propagation.ts` | Cross-project improvement voting |
| `profile-evolution.ts` | Auto-learns user style, activity patterns, autonomy level |
| `proactive-planner.ts` | Daily backlog analysis + recommendations |
| `projects.ts` | Multi-project CRUD with topic-based routing |
| `notifications.ts` | Proactive Telegram notifications to forum topics (tasks, ideas) |
| `transcribe.ts` | Voice transcription (Groq cloud or whisper-cpp local) |
| `tts.ts` | Text-to-speech via Piper (local) |
| `alert-cron.ts` | Hourly scheduled alert runner + memory archival |

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

### Database (Supabase)

Tables: `messages`, `memory`, `memory_archive`, `tasks`, `projects`, `prds`, `sprint_metrics`, `workflow_logs`, `feedback_rules`, `workflow_proposals`, `retros`, `logs`, `document_shards`, `cost_tracking`, `blackboard`

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

**Workflow steps** (config/workflow.yaml): request → decomposition → validation → execution → review → closure

### Infrastructure

**PM2 services** (ecosystem.config.cjs):
- `claude-relay` — Main bot (start-relay.sh)
- `claude-dashboard` — Kanban board (port 3456)
- `claude-autodeploy` — CI/CD auto-deploy
- `claude-alert-cron` — Hourly anomaly detection

**Dashboard** (port 3456): Kanban board with project filter, sprint progress, task cards. API: /api/projects, /api/tasks, /api/prds, /api/health

### Project Structure

```
src/                    36 TypeScript modules (core logic)
dashboard/              Kanban board (server.ts + index.html)
config/
  profile.md            User profile
  workflow.yaml         Workflow state machine
  bmad-templates/       Agent YAML definitions + workflow templates
db/schema.sql           Authoritative database schema
mcp/                    MCP memory server (memory-server.ts)
supabase/functions/     Edge Functions (embed, search, classify-thought, memory-mcp)
tests/                  555 tests (unit + integration)
scripts/                Deployment, token rotation, setup
examples/               Onboarding examples (morning briefing, checkin, memory)
```

### Conventions

- Runtime: Bun
- Tests: `bun test` (611 tests, all must pass before merge)
- Git workflow: feature branch → PR → CI → merge to master
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
