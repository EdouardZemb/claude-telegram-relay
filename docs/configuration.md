# Configuration Guide

## Environment Variables (.env)

Copy `.env.example` to `.env` and fill in values.

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_USER_ID` | Your Telegram user ID (from @userinfobot) | `123456789` |
| `SUPABASE_URL` | Supabase project URL | `https://abc123.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon public key | `eyJ...` |

### Personalization

| Variable | Description | Default |
|----------|-------------|---------|
| `USER_NAME` | Your first name | — |
| `USER_TIMEZONE` | IANA timezone | `UTC` |

### Forum Topics (Optional)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_GROUP_ID` | Group forum ID (-100xxxxxxxxx) |
| `SPRINT_THREAD_ID` | Sprint topic thread ID |
| `DEV_THREAD_ID` | Development topic thread ID |
| `IDEAS_THREAD_ID` | Ideas topic thread ID |
| `SERVER_THREAD_ID` | Server topic thread ID |

Thread IDs appear in bot logs as `thread=XX` when messages arrive.

### Paths (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_PATH` | Claude CLI binary path | auto-detected |
| `PROJECT_DIR` | Working directory for agents | relay directory |
| `RELAY_DIR` | Data directory | `~/.claude-relay` |

### Voice (Optional)

| Variable | Description |
|----------|-------------|
| `VOICE_PROVIDER` | `groq` (cloud) or `local` (whisper.cpp) |
| `GROQ_API_KEY` | Groq API key (free at console.groq.com) |
| `WHISPER_BINARY` | whisper-cpp binary path |
| `WHISPER_MODEL_PATH` | ggml model file path |
| `WHISPER_LANGUAGE` | Language code (`fr`, `en`, `auto`) |

### Dashboard (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHBOARD_PORT` | HTTP server port | `3456` |
| `DASHBOARD_TOKEN` | Access token for authentication | — |

## User Profile (config/profile.md)

Loaded on every message to personalize Claude's responses. Contains:

- Name and timezone
- Occupation and availability
- Communication preferences (brief/detailed, casual/formal)
- Goals (updated automatically via [GOAL:] tags)

Copy from `config/profile.example.md` during setup. The profile evolves automatically via `src/profile-evolution.ts` which detects:
- Peak activity hours
- Frequent task types
- Active days of the week
- Preferred autonomy level

## Workflow Configuration (config/workflow.yaml)

Defines the agentic workflow state machine. Loaded by `src/workflow.ts`.

### Steps

Six sequential steps, each with optional checkpoint:

| Step | Checkpoint | Description |
|------|-----------|-------------|
| request | off | Receive and understand the request |
| decomposition | light | Break into subtasks (1 retry) |
| validation | off | User sign-off (skippable for priority 1-2) |
| execution | strict | Implementation (3 retries max) |
| review | light | CI + code review (1 retry) |
| closure | off | Merge, deploy, update backlog |

### Checkpoint Modes

- **off**: no evaluation, direct pass
- **light**: quick criteria check, max 1 retry on failure
- **strict**: deep audit against all criteria, max 3 retries, potential rework loop

### Transitions

Defined as `from → to` with optional conditions:
- `decomposition → execution` (auto_validated: skip user validation for priority 1-2)
- `validation → decomposition` (rework: user rejected the plan)
- `execution → execution` (checkpoint_failed: retry implementation)
- `review → execution` (rework: issues found in review)

This file is a living document: retros may propose changes that get applied after validation.

## BMad Templates (config/bmad-templates/)

### Agents (config/bmad-templates/agents/)

YAML files defining each agent's persona:

| File | Agent | Active |
|------|-------|--------|
| `analyst.agent.yaml` | Mary (Analyst) | Yes |
| `pm.agent.yaml` | John (PM) | Yes |
| `architect.agent.yaml` | Winston (Architect) | Yes |
| `dev.agent.yaml` | Amelia (Dev) | Yes |
| `qa.agent.yaml` | Quinn (QA) | Yes |
| `sm.agent.yaml` | Bob (Scrum Master) | Yes |
| `bmad-master.agent.yaml` | BMad Master (orchestrator) | Yes |
| `tech-writer.agent.yaml` | Paige (Tech Writer) | Template only |
| `ux-designer.agent.yaml` | Sally (UX Designer) | Template only |
| `quick-flow-solo-dev.agent.yaml` | Barry (Solo Dev) | Template only |

Each YAML contains: metadata (id, name, icon), persona (role, identity), principles, critical actions, and menu items.

### Workflows (config/bmad-templates/workflows/)

Step-file workflows organized by phase:
- `1-analysis/` — Research and analysis steps
- `2-planning/` — Planning and requirement steps
- `3-solutioning/` — Architecture and design steps
- `4-implementation/` — Development steps
- `quick-flow/` — Simplified single-agent flow

### Other Template Directories

- `tasks/` — Reusable task templates
- `data/` — Reference data for agents
- `teams/` — Team composition templates

## PM2 Configuration (ecosystem.config.cjs)

Four services:

| Service | Script | Notes |
|---------|--------|-------|
| `claude-relay` | `start-relay.sh` | Main bot, autorestart max 10 |
| `claude-dashboard` | `bun run dashboard/server.ts` | Port 3456, autorestart max 10 |
| `claude-autodeploy` | `scripts/auto-deploy.sh` | CI/CD watcher, autorestart max 5 |
| `claude-alert-cron` | `bun run src/alert-cron.ts` | Hourly cron (0 * * * *) |

All logs go to `~/.claude-relay/logs/`.

Commands:
```
npx pm2 status                      # Check all services
npx pm2 logs claude-relay           # View relay logs
npx pm2 restart claude-relay        # Restart bot
npx pm2 start ecosystem.config.cjs  # Start all services
```
