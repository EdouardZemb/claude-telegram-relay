# Claude Telegram Relay

> Claude Code reads this file automatically.

## Architecture

Modular TypeScript monolith: Telegram bot orchestrating BMad AI agents via Supabase.

**Data flow:** Telegram → relay.ts → Supabase (tasks, memory, metrics) → Claude Code agents → GitHub PRs → deployment

### Source Modules (`src/`)

| Module | Purpose |
|--------|---------|
| `relay.ts` | Main bot: message handling, 24 Telegram commands, voice, photos, docs |
| `agent.ts` | Sub-agent execution: launches Claude Code with branch-PR workflow |
| `tasks.ts` | Task CRUD: backlog → in_progress → review → done lifecycle |
| `memory.ts` | Persistent facts/goals via intent tags ([REMEMBER:], [GOAL:], [DONE:]) |
| `gates.ts` | BMad gates: Gate 1 (PRD approval), Gate 2 (architecture), Gate 3 (code review) |
| `orchestrator.ts` | Multi-agent pipeline: chains analyst → pm → architect → dev → qa |
| `bmad-agents.ts` | 6 agent definitions (analyst, pm, architect, dev, qa, sm) with YAML templates |
| `bmad-prompts.ts` | Context-aware prompt builder per agent |
| `auto-pipeline.ts` | Autonomous end-to-end pipeline (PRD → arch → dev → review → done) |
| `workflow.ts` | Workflow engine: loads config/workflow.yaml, tracks state transitions |
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
| `notifications.ts` | Proactive Telegram notifications to forum topics |
| `transcribe.ts` | Voice transcription (Groq cloud or whisper-cpp local) |
| `tts.ts` | Text-to-speech via Piper (local) |
| `alert-cron.ts` | Hourly scheduled alert runner |

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
| `/orchestrate <id>` | Full BMad multi-agent pipeline |
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
| `/status` | System health check |
| `/speak <text>` | Text-to-speech |
| `/remind <msg>` | Set reminder |
| `/workflow` | BMad workflow overview |
| `/agents` | List BMad agents |
| `/export` | Export tasks/metrics |

### Database (Supabase)

Tables: `messages`, `memory`, `tasks`, `projects`, `prds`, `sprint_metrics`, `workflow_logs`, `feedback_rules`, `workflow_proposals`, `retros`, `logs`, `document_shards`

RPCs: `get_recent_messages`, `get_active_goals`, `get_facts`, `get_sprint_summary`, `match_messages`, `match_memory`

Edge Functions: `embed` (auto-embeddings on insert), `search` (semantic search)

### BMad Workflow

**Gates:**
1. PRD approval required before /exec
2. Architecture validation
3. Code review (CI + adversarial review, 3+ findings required)

**Pipelines:**
- DEFAULT: analyst → pm → architect → dev → qa
- QUICK: dev → qa
- REVIEW: qa → architect

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
src/                    25 TypeScript modules (core logic)
dashboard/              Kanban board (server.ts + index.html)
config/
  profile.md            User profile
  workflow.yaml         Workflow state machine
  bmad-templates/       Agent YAML definitions + workflow templates
db/schema.sql           Authoritative database schema
supabase/functions/     Edge Functions (embed, search)
tests/                  244 tests (unit + integration)
scripts/                Deployment, token rotation, setup
examples/               Onboarding examples (morning briefing, checkin, memory)
```

### Conventions

- Runtime: Bun
- Tests: `bun test` (244 tests, all must pass before merge)
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
