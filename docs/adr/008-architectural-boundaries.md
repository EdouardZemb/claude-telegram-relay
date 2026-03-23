# ADR-008: Architectural Boundaries — Module Decomposition and Layering

## Date
2026-03-23

## Status
Accepted

## Context

The codebase grew organically from a monolith to 64 TypeScript modules. Two files exceeded 2000 lines of code: `src/memory.ts` (2174 LOC, 13+ sections, 46+ exports) and `src/orchestrator.ts` (2019 LOC, 6+ sections, complex pipeline logic). While functionally correct, these monolithic files violated the Single Responsibility Principle and made it difficult to reason about dependencies between subsystems.

The codebase already follows a 3-layer architecture — commands (`src/commands/`) calling services (`src/*.ts`) that receive Supabase as a parameter — but this was never formally documented.

This ADR is part of the "durcissement des standards" initiative (vague 4), following strict mode TypeScript (vague 1), zero-any elimination (vague 2), and Result type/catch audit (vague 3).

## Decision

1. **Decompose monolithic modules** into sub-module directories with barrel re-exports at the original file path. Consumers continue importing from `./memory.ts` and `./orchestrator.ts` with zero import changes.

2. **memory.ts (2174 LOC)** decomposed into 6 sub-modules in `src/memory/`:
   - `core.ts` — processMemoryIntents, getMemoryContext, getRecentMessages, getRelevantContext, archiveOldMemories
   - `classification.ts` — classifyMessage, autoRemember, findDuplicateIdea, classifyLinkContent
   - `scoring.ts` — calculateEffectiveImportance, resolveMemoryConflict, updateMemoryWithRevision, findContradiction
   - `ideas.ts` — Idea CRUD, formatIdeasList
   - `graph.ts` — linking, chains, clustering, health stats, promoteWorkingMemory
   - `agent-memory.ts` — role-specific agent memory CRUD, graduation

3. **orchestrator.ts (2019 LOC)** decomposed into 4 sub-modules in `src/orchestrator/`:
   - `types.ts` — AgentRole, AgentStepResult, OrchestratedResult, OrchestrateOptions, AGENT_COMMAND_MAP
   - `agent-step.ts` — runAgentStep, getOrchestrationInstructions, persistAgentArtifact
   - `pipeline.ts` — orchestrate() main function
   - `format.ts` — formatOrchestrationResult, buildOrchestrationSummary, logOrchestrationResult

4. **Document the 3-layer architecture**: commands -> services -> data (Supabase via parameters).

## Consequences

**Easier:**
- Navigating memory and orchestrator subsystems (6 files of 170-340 LOC vs 1 file of 2174 LOC)
- Understanding dependency direction between sub-modules (acyclic graph documented)
- Onboarding: each sub-module has a focused responsibility
- Future refactoring: can modify scoring without touching ideas or graph logic

**Harder/trade-offs:**
- Barrel files add an indirection layer (one extra hop for IDE "go to definition")
- Sub-module internal dependencies must remain acyclic: core and graph are hub modules that import from specialized modules (scoring, classification, ideas, agent-memory), but not the reverse
- pipeline.ts remains large (~1486 LOC) because orchestrate() is a single sequential flow that would be harder to follow if fragmented further
- Static analysis tests that grep file content need awareness that code moved to sub-modules

**Unchanged:**
- All 46+ public exports from memory.ts remain available at the same import path
- All 10+ public exports from orchestrator.ts remain available at the same import path
- Runtime behavior is identical — this is a pure structural refactoring
