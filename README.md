# Claude Telegram Relay

A personal AI assistant on Telegram powered by Claude Code.

You message it. Claude responds. Text, photos, documents, voice. It remembers across sessions, manages tasks, executes code autonomously, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
You ──▶ Telegram ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                                    │
                              Supabase (memory, tasks, PRDs)
```

## What You Get

- **Relay**: Send messages on Telegram, get Claude responses back
- **Memory**: Semantic search over conversation history, persistent facts and goals via Supabase
- **Task Management**: Full backlog with sprints, priorities, kanban dashboard
- **Agentic Execution**: Claude sub-agents that create branches, write code, open PRs, wait for CI
- **PRD Workflow**: Generate, validate, and track Product Requirements Documents
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals and schedule
- **Voice**: Transcribe voice messages (Groq cloud or local Whisper) + TTS responses (Piper)
- **Forum Topics**: Route messages and notifications to dedicated Telegram group topics
- **Dashboard**: Web-based kanban board for visual task management
- **CI/CD**: GitHub Actions auto-deploy on merge to master
- **Always On**: PM2 process management with auto-restart on crash
- **Guided Setup**: Claude Code reads CLAUDE.md and walks you through everything

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Telegram** account

### Option A: Guided Setup (Recommended)

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Claude Code reads `CLAUDE.md` and walks you through setup conversationally.

### Option B: Manual Setup

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
bun run setup          # Install deps, create .env
# Edit .env with your API keys
bun run test:telegram  # Verify bot token
bun run test:supabase  # Verify database
bun run start          # Start the bot
```

## Telegram Commands

### Task Management
- `/task <title>` — Add a task to the backlog
- `/backlog [project]` — View current backlog (optionally filter by project)
- `/sprint [S01]` — View sprint status or a specific sprint
- `/start <id>` — Mark a task as in_progress
- `/done <id>` — Mark a task as done

### Agentic Execution
- `/exec <id>` — Execute a task using a Claude sub-agent (creates branch, codes, opens PR)
- `/plan <description>` — Decompose a request into sub-tasks and add to backlog

### PRD Workflow
- `/prd` — List all PRDs
- `/prd <id>` — View a specific PRD with validation buttons (Approve/Reject/Modify)
- `/prd <description>` — Generate a new PRD from a description

### Utilities
- `/status` — Server and bot health status (CPU, memory, PM2 services, message count)
- `/remind <time> <text>` — Set a reminder (e.g., `/remind 14h30 Call client` or `/remind 2h Check logs`)
- `/export` — Export all messages, memory, and tasks as JSON
- `/speak [text]` — Synthesize text to voice (or re-read last response)

## Architecture

```
src/
  relay.ts           # Main bot daemon — message handlers, commands, Claude CLI calls
  agent.ts           # Sub-agent execution — branch/PR workflow, git integration
  tasks.ts           # Task CRUD on Supabase — backlog, sprints, priorities
  memory.ts          # Memory management — facts, goals, semantic search
  prd.ts             # PRD generation and lifecycle — draft, approved, rejected
  notifications.ts   # Proactive notifications to forum topics
  transcribe.ts      # Voice transcription — Groq or local whisper
  tts.ts             # Text-to-speech — Piper TTS

dashboard/
  server.ts          # HTTP server for kanban board (port 3456)
  index.html         # Frontend kanban UI

db/
  schema.sql         # Complete Supabase schema (tables, RLS, functions, pgvector)

supabase/functions/
  embed/index.ts     # Auto-embedding Edge Function (OpenAI text-embedding-3-small)
  search/index.ts    # Semantic search Edge Function

config/
  profile.example.md # Personalization template
  profile.md         # User profile (loaded on every message)

scripts/
  auto-deploy.sh     # Watches for deployments, restarts services
  notify-deploy.sh   # Sends deploy status to Telegram
  system-alerts.sh   # System health monitoring

.github/workflows/
  ci.yml             # CI on pull requests
  deploy.yml         # Auto-deploy to production on merge to master
```

## Database (Supabase)

### Tables
- **messages** — Conversation history with embeddings (pgvector 1536 dims)
- **memory** — Facts and goals with embeddings
- **tasks** — Backlog with status (backlog/in_progress/review/done/cancelled), priority, sprint
- **prds** — Product Requirements Documents with status (draft/approved/rejected/superseded)
- **logs** — System logs

### RPC Functions
- `get_recent_messages` — Last N messages for context
- `match_messages` — Semantic search over messages
- `match_memory` — Semantic search over memory
- `get_active_goals` — Active goals
- `get_facts` — All stored facts
- `get_sprint_summary` — Sprint progress (counts by status)

### Edge Functions
- **embed** — Auto-generates embeddings on INSERT (triggered by DB webhooks)
- **search** — Semantic search endpoint

## Process Management (PM2)

Three services managed by PM2 (`ecosystem.config.cjs`):

| Service | Description | Logs |
|---------|-------------|------|
| `claude-relay` | Main Telegram bot | `~/.claude-relay/logs/relay-*.log` |
| `claude-dashboard` | Kanban board (port 3456) | `~/.claude-relay/logs/dashboard-*.log` |
| `claude-autodeploy` | Auto-deploy watcher | `~/.claude-relay/logs/autodeploy-*.log` |

### Common PM2 Commands
```bash
npx pm2 status                    # Check all services
npx pm2 logs claude-relay         # View relay logs
npx pm2 restart claude-relay      # Restart the bot
npx pm2 stop all                  # Stop all services
npx pm2 start ecosystem.config.cjs  # Start all services
```

## Forum Topics

The bot supports Telegram group forums with topic-specific behavior:

| Topic | Label | Allowed Commands | Purpose |
|-------|-------|-----------------|---------|
| claude-relay | Dev | exec, plan, prd, task, backlog, sprint, done, start, status, export, remind, speak | Development discussions |
| idees | Brainstorm | task, plan, prd, remind, speak | Idea exploration |
| sprint | Sprint | task, backlog, sprint, done, start, plan, prd, exec, status, remind, speak | Sprint management |
| serveur | Ops | status, exec, remind, speak | Server operations |

Notifications are routed automatically:
- PR created/merged → Dev topic
- Task status changes → Sprint topic
- Deploy events → Server topic

## Resilience Features

- **Offset management**: Pending Telegram updates are dropped on startup to prevent crash loops from re-processing failed messages
- **Circuit breaker**: Messages that cause 3+ consecutive errors are automatically skipped
- **Try/catch isolation**: Each message handler catches errors independently — one bad message won't crash the bot
- **Lock file**: Prevents multiple bot instances from running simultaneously
- **Rate limiting**: 30 messages/minute max to prevent abuse
- **Uncaught exception handler**: Notifies via Telegram before PM2 restarts the process
- **PM2 auto-restart**: max 10 restarts with 5s delay between attempts

## CI/CD Workflow

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make changes, commit, push
3. Open a PR on GitHub → CI runs tests
4. Merge to master → GitHub Actions auto-deploys via SSH
5. PM2 restarts services, deploy notification sent to Telegram

The `/exec` command automates steps 1-3: it spawns a Claude sub-agent that creates a branch, makes changes, and opens a PR.

## Environment Variables

See `.env.example` for all options. The essentials:

```bash
# Required
TELEGRAM_BOT_TOKEN=     # From @BotFather
TELEGRAM_USER_ID=       # From @userinfobot
SUPABASE_URL=           # From Supabase dashboard
SUPABASE_ANON_KEY=      # From Supabase dashboard

# Recommended
USER_NAME=              # Your first name
USER_TIMEZONE=          # e.g., Europe/Paris

# Forum group (optional)
TELEGRAM_GROUP_ID=      # Group ID for forum topics
SPRINT_THREAD_ID=       # Thread ID of sprint topic
DEV_THREAD_ID=          # Thread ID of dev topic
OPS_THREAD_ID=          # Thread ID of ops topic

# Voice (optional)
VOICE_PROVIDER=         # "groq" or "local"
GROQ_API_KEY=           # For Groq (free at console.groq.com)

# TTS (optional)
TTS_PROVIDER=           # "local" for Piper TTS
PIPER_BINARY=           # Path to piper binary
PIPER_MODEL=            # Path to piper voice model

# Dashboard
DASHBOARD_PORT=3456     # Kanban board port
DASHBOARD_TOKEN=        # Auth token for dashboard access

# Note: OpenAI key for embeddings is stored in Supabase
# (Edge Function secrets), not in this .env file.
```

## Troubleshooting

See [RECOVERY.md](RECOVERY.md) for emergency procedures (bot not responding, SSH access, PM2 recovery).

## The Full Version

This free relay covers the essentials. The full version in the [AI Productivity Hub](https://skool.com/autonomee) community unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator via Telegram forum topics
- **VPS Deployment** — Always-on cloud server with hybrid mode ($2-5/month)
- **Real Integrations** — Gmail, Calendar, Notion connected via MCP
- **Human-in-the-Loop** — Claude asks before taking actions via inline buttons
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs, calls when urgent
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down
- **Production Infrastructure** — Auto-deploy, watchdog, uninstall scripts

We also help you personalize it for your business, or package it as a product for your clients.

**Subscribe on YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Join the community:** [skool.com/autonomee](https://skool.com/autonomee)

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
