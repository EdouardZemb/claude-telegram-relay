# Dashboard & Metrics

## Dashboard

The dashboard provides a visual kanban board accessible via web browser.

### Access

- URL: `http://localhost:3456` (or configured `DASHBOARD_PORT`)
- Authentication: add `?token=YOUR_TOKEN` to the URL (set `DASHBOARD_TOKEN` in `.env`)
- No token set = no auth required (warning printed at startup)

### Features

- Kanban columns: Backlog, In Progress, Review, Done
- Task cards with priority badge, sprint label, time estimates
- Project filter dropdown (multi-project support)
- PRD list with status (draft, approved, rejected)
- Sprint metrics and retrospective views
- Real-time sprint progress bar (auto-refresh every 15s)

### API Endpoints

All endpoints return JSON. Authentication required (except /api/health).

| Endpoint | Description | Filters |
|----------|-------------|---------|
| `GET /api/health` | Server health (CPU, RAM, uptime, Supabase status) | — |
| `GET /api/projects` | List all projects | — |
| `GET /api/tasks` | List tasks (excludes cancelled) | `?project_id=` |
| `GET /api/prds` | List PRDs | `?project_id=` |
| `GET /api/metrics` | Sprint metrics (velocity, cycle time) | `?project_id=` |
| `GET /api/retros` | Retrospectives | `?project_id=` |
| `GET /api/agent-metrics` | Agent performance data | `?project_id=` |
| `GET /api/workflow-audit` | Workflow audit trail | — |
| `GET /api/sprint-live` | Live sprint progress | — |

### Files

- `dashboard/server.ts` — Bun HTTP server with Supabase proxy
- `dashboard/index.html` — Single-page kanban board UI

The server acts as a proxy: the frontend never sees Supabase credentials.

## Metrics

### Sprint Metrics (/metrics)

Accessed via Telegram `/metrics [--sprint <id>]` or dashboard.

| Metric | Description |
|--------|-------------|
| Completion rate | % of tasks done vs total |
| Velocity | Tasks completed per sprint |
| Cycle time | Average time from start to done |
| Rework rate | % of tasks that went back from review to execution |
| First-pass rate | % of tasks that passed review on first attempt |

Data stored in `sprint_metrics` table, computed by `src/workflow.ts`.

### Agent Metrics

Tracked per agent across orchestration runs:

| Metric | Description |
|--------|-------------|
| Success rate | % of agent steps that completed without error |
| Average duration | Time per agent step in seconds |
| Output quality | Based on downstream agent satisfaction |
| Pipeline contribution | Agents that consistently add value vs bottleneck |

### Workflow Logs

Every workflow state transition is logged in `workflow_logs`:

- Task ID and step name
- From/to step transition
- Checkpoint result (pass/fail)
- Duration in milliseconds
- Agent notes and metadata

### Anomaly Detection (/alerts)

Proactive alerts from `src/alerts.ts`, run hourly via PM2 cron:

| Alert | Trigger |
|-------|---------|
| Stuck task | In progress > 48h without update |
| High rework rate | > 30% rework in current sprint |
| Schedule slip | Sprint pace behind expected trajectory |
| Long-running step | Agent execution > 15 minutes |
| Review score drop | Code review scores trending downward |
| Agent failure | Agent step failed in pipeline |

### Pattern Analysis (/patterns)

Multi-sprint analysis from `src/patterns.ts`:

- Identifies slow workflow steps across sprints
- Detects useless checkpoints (always pass = can simplify)
- Finds high-rework trends per task type
- Proposes workflow improvements based on evidence

### Retrospectives (/retro)

Generated per sprint from `src/feedback-loop.ts`:

- What worked well
- What didn't work
- Patterns detected across sprints
- Action items with priorities
- Accepted actions feed into the feedback loop

Actions from retros that recur across 2+ sprints become permanent agent instructions via the feedback loop system.
