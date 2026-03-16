# ADR-003: JSONB Blackboard for Multi-Agent Shared Workspace

## Date
2026-03-14

## Status
Accepted

## Context
The gated SDD pipeline (S24) needs a shared workspace where agents write structured data (spec, plan, tasks, implementation, verification) and downstream agents read it. Options: shared files in git, Supabase JSONB column, or a dedicated document store.

Files in git would create merge conflicts during parallel execution. A document store adds infrastructure. Supabase is already in the stack.

## Decision
Single `blackboard` table in Supabase with a JSONB `sections` column. Each section (spec, plan, tasks, implementation, verification) is a key in the JSONB. Versioned with an integer for optimistic locking. Role-based write authorization (only certain agents can write certain sections). `writeSectionWithRetry` handles concurrent writes via retry loop.

## Consequences
- Leverages existing Supabase infrastructure, no new dependencies
- JSONB gives flexibility for evolving section schemas
- Optimistic locking prevents lost updates during parallel execution
- Role-based authorization prevents agents from overwriting sections they shouldn't touch
- Single row per pipeline run keeps queries simple
- JSONB size limit (~1GB) is far beyond our needs
- No built-in change history (we log transitions separately in workflow_logs)
