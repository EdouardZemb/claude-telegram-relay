# ADR-006: Single-User Monolith Architecture

## Date
2026-02-11

## Status
Accepted

## Context
This project started as a personal AI assistant. The architecture choices were: multi-tenant SaaS, single-user with microservices, or single-user monolith.

Multi-tenant adds auth, isolation, billing complexity for zero immediate value. Microservices add deployment complexity (multiple processes, message queues, service discovery) for a system with one user.

## Decision
Single-user TypeScript monolith. One process handles Telegram commands, agent orchestration, memory, and notifications. Supabase provides persistence but the bot itself is stateless (restartable). PM2 manages process lifecycle. No authentication layer (Telegram user ID check is sufficient). No horizontal scaling.

## Consequences
- Dramatically simpler codebase (no auth, no multi-tenancy, no service mesh)
- Single process means no inter-service communication overhead
- File-based persistence (queues, prefs) is safe without distributed locking
- Cannot serve multiple users without significant rearchitecture
- PM2 provides adequate process management for single-instance deployment
- If the project is ever open-sourced for multi-user use, this is the first decision to revisit
- Memory usage is bounded by single-user volumes (hundreds of tasks, not millions)
