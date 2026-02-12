# Changelog

All notable changes to Claude Telegram Relay are documented here.
Format follows sprints (S01-S18), each corresponding to a merged PR.

## S18 — Nettoyage, Stabilisation et Documentation (Feb 2026)

### Phase 1: Nettoyage code
- Remove dead code: notifyPRMerged, notifyDeploy, getProjectById, parallelReview, rejectProposal, getPromotedProposals, shardAnalysis, shardMemoryFacts
- Replace outdated examples/supabase-schema.sql with pointer to db/schema.sql
- Add error logging to unguarded Supabase insert operations (memory.ts, orchestrator.ts, code-review.ts)

### Phase 2: Documentation core
- Restructure CLAUDE.md: architecture + conventions + setup guide
- Update README.md with S15-S17 features (orchestration, feedback loop, dynamic profiling)
- Create CHANGELOG.md

### Phase 3: Documentation features
- (in progress)

### Phase 4: Validation
- (pending)

## S17 — Consolidation et Fiabilite (Feb 2026) — PR #21

- S17-01: Activate feedback loop from retros (processRetroFeedback)
- S17-02: Fix null date and multiline regex bugs
- S17-03: 44 new tests (total: 246 across 18 files)
- S17-05: Activate BMad gates with PRD approval + audit trail
- S17-06: Real-time sprint progress bar in dashboard (auto-refresh 15s)
- S17-07: Complete feedback loop retros → agent prompts (3 rules active)
- S17-08: Intelligent context cache (TTL 5min, LRU, auto-invalidation)
- S17-10: Dynamic profile enrichment (communication style, activity days, autonomy level)

Remaining: S17-04 (dogfooding /orchestrate), S17-09 (external integration) → S19

## S16 — Orchestration Intelligente (Feb 2026) — PR #20

- S16-01: Multi-agent orchestration framework (orchestrator.ts)
- S16-02: Atomic story files for structured task execution
- S16-03: Feedback loop from retros to agent prompts
- S16-05: Workflow audit trail with diff tracking
- S16-06: Agent metrics dashboard endpoints
- S16-07: Enhanced proactive alerts for QA agent
- S16-08: Extend sharding to retros, memory facts, and analyses
- S16-09: Automated BMad pipeline end-to-end (auto-pipeline.ts)
- S16-10: Proactive backlog planning and recommendations (proactive-planner.ts)

New commands: /orchestrate, /autopipeline, /planify

## S15 — BMad Avance (Feb 2026) — PR #19

- S15-01/02: Document sharding + cross-references
- S15-03/04/05: YAML-powered agent prompts, routing, isolation
- S15-06: UX overhaul of Telegram commands + /workflow
- S15-07/08: Adversarial code review + Gate 3 pre-merge
- S15-09/10: Cross-project workflow propagation + voting
- S15-11: README complete rewrite

## S14 — BMad Method + Multi-Projets (Feb 2026) — PR #18

- S14-01: Copy BMad Method v6 into config/bmad-templates/
- S14-02: Adapt BMad agents to Telegram context
- S14-03: Implement strict BMad gates
- S14-04: Atomic story files for BMad tasks
- S14-05: Multi-project DB schema and projects module
- S14-08: /project and /projects commands
- S14-09: Scope existing commands by project
- S14-10: Dashboard multi-project support
- S14-11: Unit tests for BMad agents, gates, and projects

## S13 — Intelligence Reflexive Complete (Feb 2026) — PR #17

- Proactive alerts system
- System-level tests
- Pattern analysis across sprints

## S12 — Intelligence Reflexive (Feb 2026) — PR #16

- Pattern detection across sprints
- System tests
- Timeout improvements

## S11 — Amelioration Continue (Feb 2026) — PR #15

- Configurable workflow engine (config/workflow.yaml)
- Sprint metrics tables (sprint_metrics, workflow_logs, retros)
- /metrics and /retro commands
- WorkflowTracker integrated into /exec and /plan

## S10 — Stabilisation (Feb 2026) — PR #13

- Security: injection prevention, dashboard proxy
- Resilience: callClaude timeout (5min), mutex, TTS guard, agent timeout (15min), memory leak fix
- DB stability: tasks/prds schema, RPC get_sprint_summary, indexes
- Infrastructure: pm2-logrotate, smoke test CI/CD, graceful shutdown
- UX: /help command, /exec feedback
- Token rotation script (scripts/rotate-token.sh)

## S09 — Documentation (Feb 2026) — PR #12

- Comprehensive documentation and recovery procedures
- RECOVERY.md for incident response

## S08 — PRD Workflow (Feb 2026) — PR #10

- /prd command with inline validation buttons
- PRD dashboard view
- prds table in Supabase

## S07 — CI/CD (Feb 2026) — PRs #8, #9

- GitHub Actions CI workflow
- CI-aware task execution
- Fix gh CLI flags in agent.ts

## S06 — Proactive Notifications (Feb 2026) — PR #7

- Proactive notifications per Telegram forum topic
- Voice + text dual response for voice messages

## S05 — CI/CD Pipeline (Feb 2026) — PR #5

- CI/CD pipeline
- Security hardening
- System alerts
- Branch-PR workflow for /exec

## S04 — Forum Topics (Feb 2026) — PRs #3, #4

- Telegram forum topics support
- Contextual topic routing
- Command guards
- Dashboard filters
- Morning briefing pattern

## S03 — Auto-Deploy (Feb 2026) — PR #2

- Pull-based auto-deploy for CI/CD

## S02 — Agentique Workflow (Feb 2026) — PR #1

- Agentic workflow (/exec, /task, /backlog, /sprint)
- Dashboard (Kanban board on port 3456)
- Text-to-speech (Piper)
- Task management system

## S01 — Initial Release (Jan 2026)

- Claude Code Telegram relay
- Voice transcription (Groq + local whisper)
- Supabase memory system (messages, memory, semantic search)
- Profile personalization
- Setup scripts and health checks
