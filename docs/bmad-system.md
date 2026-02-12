# BMad Workflow System

The BMad (Business-Method-aligned Design) system structures how Claude agents work on tasks. It enforces quality through gates, orchestrates multiple specialized agents, and learns from retrospectives.

## Agents

Six specialized agents, each with a distinct persona and role:

| ID | Name | Role | Telegram trigger |
|----|------|------|-----------------|
| analyst | Mary | Market research, competitive analysis, domain expertise | /patterns |
| pm | John | PRD creation, task decomposition, requirement discovery | /plan, /prd |
| architect | Winston | Technical design, architecture decisions, feasibility | via orchestration |
| sm | Bob | Sprint planning, retrospectives, metrics analysis | /sprint, /retro, /metrics |
| dev | Amelia | Code execution, test-driven implementation | /exec |
| qa | Quinn | Testing, proactive alerts, adversarial code review | /alerts |

Agent definitions are in `config/bmad-templates/agents/` as YAML files. Each defines: persona, principles, critical actions, and communication style.

The agent routing is handled by `src/bmad-agents.ts` which maps commands to agents via `COMMAND_AGENT_MAP`.

## Gates

Three quality gates enforce validation before code reaches production:

### Gate 1 — PRD Approval
- Enforced before /exec can run
- Requires an approved PRD in the project's `prds` table
- Create with `/prd create <idea>`, approve with `/prd approve <id>`
- User can override via inline Telegram button (logged in audit trail)

### Gate 2 — Architecture
- Validates that the task has sufficient technical context
- Checks for architecture references and acceptance criteria
- Lighter gate, mostly advisory

### Gate 3 — Code Review
- Runs adversarial code review after implementation
- Minimum 3 findings required (prevents rubber-stamping)
- Quality score 0-100, blocks merge if score < 50
- Uses QA and Architect agents to find issues
- Results saved to `workflow_logs` table

Gate enforcement logic is in `src/gates.ts`. All gate overrides are logged in `workflow_audit` table.

## Pipelines

Three pre-configured agent pipelines in `src/orchestrator.ts`:

### DEFAULT_PIPELINE
`analyst → pm → architect → dev → qa`

Full rigorous flow. Each agent receives outputs from all previous agents as context. Used by `/orchestrate`.

### QUICK_PIPELINE
`dev → qa`

Fast iteration. Skips analysis and planning. Good for well-defined tasks.

### REVIEW_PIPELINE
`qa → architect`

Audit-only. No implementation, just review and architectural validation.

## Workflow Steps

Defined in `config/workflow.yaml`, loaded by `src/workflow.ts`:

```
request → decomposition → validation → execution → review → closure
```

Each step has a checkpoint configuration:
- **off**: no evaluation, direct pass
- **light**: quick verification, max 1 retry
- **strict**: deep audit, max 3 retries, potential rework

### Transitions
- decomposition → execution (auto-validated for priority 1-2)
- validation → decomposition (rework if rejected)
- execution → review (on success)
- execution → execution (on checkpoint failure, up to max retries)
- review → execution (rework if issues found)
- review → closure (on success)

## Story Files

Before execution, tasks are enriched with structured story files (`src/story-files.ts`):

- Acceptance criteria (Given/When/Then format)
- Implementation steps with AC mapping
- Test stubs (unit/integration/e2e)
- Definition of done
- Impacted files list
- Architecture notes

The Dev agent reads the story file instead of a bare task title.

## Feedback Loop

The system learns from retrospectives (`src/feedback-loop.ts`):

1. After each sprint, `/retro` generates a retrospective
2. Recurring patterns across 2+ sprints are detected
3. These patterns become permanent rules for specific agents
4. Rules are stored in `feedback_rules` table
5. Agent prompts are enriched with applicable rules on every invocation

Example: if retros repeatedly flag "tests missing for edge cases", the QA agent gets a permanent instruction to check for edge case coverage.

## Auto-Pipeline

`/autopipeline` (`src/auto-pipeline.ts`) runs the full workflow autonomously:

1. Validates PRD (Gate 1)
2. Checks architecture readiness (Gate 2)
3. Launches Dev agent
4. Runs adversarial code review (Gate 3)
5. Creates PR
6. Notifies user only on completion or gate blocks

No user intervention needed unless a gate blocks.

## Cross-Project Propagation

When multiple projects suggest the same workflow improvement (`src/workflow-propagation.ts`):

1. Retro actions are parsed for gate/checkpoint change proposals
2. Each proposal is stored with source project and sprint
3. When another project's retro suggests the same change, it counts as a vote
4. At 2 votes, the proposal is promoted to the reference template
5. Rejected proposals are marked and won't be re-proposed

## Key Files

| File | Purpose |
|------|---------|
| `src/bmad-agents.ts` | Agent definitions and command routing |
| `src/bmad-prompts.ts` | Context-aware prompt building |
| `src/gates.ts` | Gate enforcement |
| `src/orchestrator.ts` | Multi-agent pipeline orchestration |
| `src/auto-pipeline.ts` | Autonomous end-to-end pipeline |
| `src/story-files.ts` | Structured task specs |
| `src/feedback-loop.ts` | Retro → agent prompt enrichment |
| `src/code-review.ts` | Adversarial code review |
| `src/workflow.ts` | Workflow state machine engine |
| `src/workflow-propagation.ts` | Cross-project improvement voting |
| `config/workflow.yaml` | Workflow steps and checkpoint config |
| `config/bmad-templates/agents/` | YAML agent definitions |
