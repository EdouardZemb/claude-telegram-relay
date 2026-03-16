# ADR-004: DAG-Based Parallel Agent Execution

## Date
2026-03-15

## Status
Accepted

## Context
The orchestrator (S22) originally ran agents sequentially in a for...of loop. For pipelines with independent stages (e.g., analyst and PM can run concurrently), this wastes time. S25 introduced parallelism.

Options: simple Promise.all on independent stages, or a full DAG scheduler with dependency resolution. The DAG approach is more general and handles the three levels of parallelism: (1) independent pipeline stages, (2) fan-out dev agents on subtasks, (3) batch tasks in autopipeline.

## Decision
Implement a DAG executor with pre-defined DAGs (DEFAULT, QUICK, REVIEW) that encode stage dependencies. Semaphore-based concurrency control (default max 3). Each node in the DAG is an agent execution. The executor resolves dependencies, runs ready nodes concurrently (up to semaphore limit), and collects results. Fan-out creates N parallel dev agents in separate git worktrees. Backward-compatible: `parallel: false` (default) preserves sequential behavior.

## Consequences
- Significant speedup for multi-agent pipelines (measured via ParallelMetrics speedup ratio)
- Pre-defined DAGs are simple to understand and maintain
- Semaphore prevents resource exhaustion (CPU, memory, API rate limits)
- Git worktrees enable true isolation for parallel dev agents
- Adding new DAG configurations requires code changes (not config-driven yet)
- The `parallel: false` default ensures zero risk to existing workflows
