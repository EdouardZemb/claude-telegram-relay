# ADR-005: Mandatory SDD Process for Every Sprint

## Date
2026-03-14

## Status
Accepted

## Context
Early sprints (S08-S15) used ad-hoc implementation. Code quality varied, scope creep was common, and acceptance criteria were implicit. Starting S16, we experimented with a structured spec-first approach.

The BMad methodology provides gates and agent roles, but doesn't prescribe a documentation flow. We needed a repeatable process that forces upfront thinking before coding.

## Decision
Every sprint follows a 4-phase SDD (Spec-Driven Development) process with gates between each phase:

1. Phase 1 (Spec): FR, AC, EC, SC definitions. Gate 1 = user approval.
2. Phase 2 (Architecture): Components, file impacts, flows, risks. Gate 2 = user approval.
3. Phase 3 (Task Breakdown): Ordered tasks with dependencies, test counts, traceability matrix. Gate 3 = user approval.
4. Phase 4 (Implementation): Code, tests, CI verification, CLAUDE.md update.

No code is written before Gate 3 approval. Each gate requires explicit user validation.

## Consequences
- Forces upfront design, catches issues before coding starts
- Traceability matrix ensures every FR has tests
- User stays in control at each gate (can redirect before effort is spent)
- Adds overhead for truly trivial changes (mitigated by QUICK pipeline for bugs/fixes)
- Sprint specs in docs/sprints/ serve as permanent documentation of decisions
- The process itself is documented and can evolve based on retro feedback
