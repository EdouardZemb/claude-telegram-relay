# ADR-001: File-Based Queues for Notification Persistence

## Date
2026-03-16

## Status
Accepted

## Context
Smart notifications (S26) need persistence to survive bot restarts during quiet hours. Options considered: Supabase table, SQLite, or JSON files in RELAY_DIR.

The system is single-user, single-process. Queue sizes are small (typically <50 items). Supabase would add latency and dependency for a purely local operation. SQLite would add a native dependency to a Bun project that currently has none.

## Decision
Use JSON file persistence (write tmp + atomic rename) in RELAY_DIR (~/.claude-relay/). Queue and preferences each have their own file. Load on startup, save on every enqueue.

## Consequences
- Simple implementation, zero external dependencies
- Atomic writes prevent corruption on crash
- Not suitable for multi-instance deployment (no locking between processes)
- Queue size is limited by memory, but this is irrelevant for single-user volumes
- If we ever go multi-user, this decision must be revisited (migrate to Supabase)
