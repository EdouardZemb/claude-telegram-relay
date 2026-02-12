# Claude Telegram Relay

A self-improving agentic framework powered by Claude Code, piloted via Telegram.

Not just a chatbot. A structured AI workflow system with BMad methodology, multi-project management, autonomous code execution, adversarial code review, and continuous improvement through retrospectives.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
                        ┌─────────────────────────────────────┐
                        │         BMad Workflow Engine         │
                        │                                     │
  Telegram ──────────▶  │  Analyse ─▶ PRD ─▶ Architecture     │
  (text, voice, docs)   │     │        │        │              │
                        │  Gate 1   Gate 2   Gate 3            │
                        │     │        │        │              │
                        │  Execution ─▶ Review ─▶ Merge        │
                        │     │                                │
                        │  Retrospective ──▶ Self-Improvement  │
                        └──────────────┬──────────────────────┘
                                       │
                              Supabase (memory, tasks,
                              PRDs, metrics, proposals)
```

## Core Capabilities

### BMad Method Integration
6 specialized AI agents, each with a distinct persona, loaded from YAML templates:

| Agent | Role | Trigger |
|-------|------|---------|
| Mary (Analyst) | Market research, competitive analysis, domain expertise | /patterns |
| John (PM) | PRD creation, task decomposition, requirement discovery | /plan, /prd |
| Winston (Architect) | Technical design, architecture decisions | via /plan |
| Bob (Scrum Master) | Sprint planning, retrospectives, metrics analysis | /sprint, /retro, /metrics |
| Amelia (Dev) | Code execution, test-driven implementation | /exec |
| Quinn (QA) | Test automation, proactive alerts, code review | /alerts |

### 3-Gate Workflow
Strict validation enforced before code reaches production:

- **Gate 1 — PRD**: No execution without an approved Product Requirements Document
- **Gate 2 — Architecture**: Tasks must have sufficient technical context
- **Gate 3 — Code Review**: Adversarial review (minimum 3 findings, score 0-100, blocks merge if < 50)

Gates can be bypassed with explicit user override via inline Telegram buttons.

### Multi-Project Management
Manage multiple projects from a single Telegram bot:

- `/project create <name>` to create a new project
- Topic-based routing: each Telegram forum topic maps to a project
- All commands auto-scope to the active project
- Separate workflows, metrics, and retrospectives per project
- Cross-project improvement propagation via voting mechanism

### Document Sharding
Large documents (PRDs, architecture) are split into indexed sections:

- Only relevant sections loaded into agent context (saves tokens)
- Cross-references between document sections
- Task execution automatically enriched with relevant document shards

### Continuous Improvement
The system improves itself through data-driven retrospectives:

- Sprint metrics: completion rate, avg delivery time, first-pass rate
- Multi-sprint pattern analysis across projects
- Retro actions automatically propose workflow changes
- Feedback loop: recurring retro patterns become permanent agent instructions
- Cross-project voting: when 2+ projects suggest the same improvement, it promotes to reference template
- Dynamic user profiling: learns communication style, activity patterns, autonomy level
- Workflow config evolves based on evidence, not assumptions

### Autonomous Pipelines
- `/orchestrate` chains agents in configurable pipelines (DEFAULT, QUICK, REVIEW)
- `/autopipeline` runs end-to-end without user intervention (PRD → dev → review → done)
- `/planify` proactively analyzes backlog and suggests priority reordering

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Telegram** account

### Guided Setup (Recommended)

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Claude Code reads `CLAUDE.md` and walks you through setup phase by phase.

### Manual Setup

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

### Workflow BMad

| Phase | Command | Agent | Description |
|-------|---------|-------|-------------|
| Analyse | /prd \<description\> | John (PM) | Create a Product Requirements Document |
| Planification | /plan \<description\> | John (PM) | Decompose into sub-tasks |
| Execution | /exec \<id\> | Amelia (Dev) | Launch autonomous code agent |
| Qualite | /metrics [sprint] | Bob (SM) | Sprint metrics |
| Qualite | /retro [sprint] | Bob (SM) | Retrospective analysis |
| Qualite | /patterns | Mary (Analyst) | Multi-sprint trend analysis |
| Qualite | /alerts | Quinn (QA) | Proactive issue detection |
| Orchestration | /orchestrate \<id\> | All agents | Multi-agent pipeline |
| Orchestration | /autopipeline \<id\> | All agents | Autonomous end-to-end |
| Planification | /planify | — | Proactive backlog analysis |
| Process | /workflow | — | View full BMad process |
| Process | /agents | — | List all agents and capabilities |

### Backlog & Sprint

| Command | Description |
|---------|-------------|
| /task \<title\> | Add a task to backlog |
| /backlog [project] | View backlog |
| /sprint [id] | Sprint status |
| /start \<id\> | Start a task |
| /done \<id\> | Complete a task |

### Projects

| Command | Description |
|---------|-------------|
| /projects | List all projects |
| /project create \<name\> | Create new project |
| /project switch \<slug\> | Switch active project |
| /project archive \<slug\> | Archive a project |
| /project topic \<slug\> | Link topic to project |

### Utilities

| Command | Description |
|---------|-------------|
| /status | Server health (CPU, RAM, PM2, messages) |
| /remind \<time\> \<text\> | Set a reminder |
| /speak [text] | Text-to-speech |
| /profile | User profile insights |
| /export | Export all data as JSON |
| /help | Command reference |

## Architecture

```
src/
  relay.ts                # Main bot — commands, handlers, Claude CLI integration
  bmad-agents.ts          # Agent registry — 6 BMad agents mapped to commands
  bmad-prompts.ts         # YAML-powered system prompts with context-aware instructions
  gates.ts                # Gate enforcement — PRD, Architecture, Code Review
  code-review.ts          # Adversarial code review with scoring
  agent.ts                # Sub-agent execution — branch/PR/CI workflow
  tasks.ts                # Task CRUD — backlog, sprints, priorities
  projects.ts             # Multi-project management with topic routing
  document-sharding.ts    # Document splitting, indexing, context loading
  workflow.ts             # Configurable workflow engine (workflow.yaml)
  workflow-propagation.ts # Cross-project improvement proposals + voting
  patterns.ts             # Multi-sprint pattern analysis
  alerts.ts               # Proactive issue detection
  memory.ts               # Facts, goals, semantic search (pgvector)
  orchestrator.ts         # Multi-agent pipeline orchestrator
  auto-pipeline.ts        # Autonomous end-to-end pipeline
  story-files.ts          # Structured task specs (acceptance criteria, steps, tests)
  feedback-loop.ts        # Retro-driven learning → agent prompt enrichment
  proactive-planner.ts    # Daily backlog analysis + recommendations
  prd.ts                  # PRD generation and lifecycle
  notifications.ts        # Forum topic notifications
  profile-evolution.ts    # Dynamic user profiling
  transcribe.ts           # Voice transcription (Groq / local Whisper)
  tts.ts                  # Text-to-speech (Piper)
  alert-cron.ts           # Hourly scheduled alert runner

config/
  bmad-templates/         # BMad Method v6 templates
    agents/               # Agent YAML definitions (persona, capabilities, menus)
    workflows/            # Step-file workflows (analysis, planning, solutioning)
    tasks/                # Reusable task templates
    data/                 # Reference data
  workflow.yaml           # Configurable workflow (steps, transitions, checkpoints)
  profile.md              # User personalization

dashboard/
  server.ts               # HTTP server (port 3456) with API proxy
  index.html              # Kanban board + PRDs + metrics + retros

db/
  schema.sql              # Complete Supabase schema

supabase/functions/
  embed/index.ts          # Auto-embedding Edge Function
  search/index.ts         # Semantic search Edge Function
```

## Database

### Tables
| Table | Purpose |
|-------|---------|
| messages | Conversation history with pgvector embeddings |
| memory | Facts and goals with embeddings |
| tasks | Backlog with BMad story fields (AC, subtasks, dev notes) |
| prds | Product Requirements Documents with status lifecycle |
| projects | Multi-project registry with topic mapping |
| document_shards | Indexed document sections for efficient context |
| sprint_metrics | Quantitative sprint data |
| retros | Retrospective analyses and accepted actions |
| workflow_logs | Transition tracking for workflow engine |
| workflow_proposals | Cross-project improvement proposals |
| feedback_rules | Learned patterns from retros → agent prompt enrichment |
| logs | System logs |

### Edge Functions
- **embed** — Auto-generates embeddings on INSERT (DB webhooks)
- **search** — Semantic search endpoint

## Process Management

Four services managed by PM2:

| Service | Description |
|---------|-------------|
| claude-relay | Main Telegram bot |
| claude-dashboard | Kanban board (port 3456) |
| claude-autodeploy | Auto-deploy watcher |
| claude-alert-cron | Hourly anomaly detection |

```bash
npx pm2 status                      # Check services
npx pm2 logs claude-relay           # View logs
npx pm2 restart claude-relay        # Restart bot
npx pm2 start ecosystem.config.cjs  # Start all
```

## CI/CD

Feature branch workflow enforced at all levels:

1. `/exec` creates a feature branch
2. Agent writes code + tests
3. Adversarial code review (Gate 3)
4. Push + PR creation
5. CI checks on GitHub Actions
6. Merge to master triggers auto-deploy via SSH
7. PM2 restarts, deploy notification sent to Telegram

## Resilience

- Rate limiting (30 msg/min)
- Circuit breaker (3 consecutive errors = skip)
- Lock file prevents duplicate instances
- Graceful shutdown with Supabase session cleanup
- PM2 auto-restart (max 10 with 5s delay)
- Heartbeat during long agent operations
- Offset management prevents crash loops on startup

## The Full Version

This free relay covers the essentials. The full version in the [AI Productivity Hub](https://skool.com/autonomee) unlocks:

- 6 Specialized AI Agents via Telegram forum topics
- VPS Deployment with hybrid mode ($2-5/month)
- Real Integrations (Gmail, Calendar, Notion via MCP)
- Human-in-the-Loop actions via inline buttons
- Voice & Phone Calls (ElevenLabs)
- Fallback AI Models (OpenRouter, Ollama)
- Production Infrastructure (watchdog, auto-deploy)

**YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Community:** [skool.com/autonomee](https://skool.com/autonomee)

## License

MIT

---

Built by [Goda Go](https://youtube.com/@GodaGo)
