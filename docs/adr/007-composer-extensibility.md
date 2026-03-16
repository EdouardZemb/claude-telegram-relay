# ADR-007: Composer-Based Extensibility

## Date
2026-03-16

## Status
Accepted

## Context
relay.ts had grown to 3216 lines with 33 commands and all message handlers registered inline in a single createBot() function. Adding a new feature required modifying relay.ts directly, violating the open-closed principle. The callback query handler was a 276-line if-else chain. This made the codebase harder to maintain and extend.

## Decision
Adopt Grammy's native Composer pattern combined with Bun Glob auto-loading:

1. **BotContext** (`src/bot-context.ts`): Extract all shared state and functions (callClaude, sendResponse, buildPrompt, supabase, session, topic helpers) into a typed dependency object. Each Composer receives this context via a factory function.

2. **Composer modules** (`src/commands/*.ts`): One file per functional domain. Each exports a factory `(ctx: BotContext) => Composer`. Commands and callbacks are registered on the Composer, not the Bot directly.

3. **Auto-loader** (`src/loader.ts`): Scans `src/commands/` with `Bun.Glob("*.ts")`, imports each module, calls the factory with BotContext, and mounts the Composer via `bot.use(bot.errorBoundary(...))`. Alphabetical ordering ensures `zz-messages.ts` loads last (catch-all handlers).

4. **Topic configuration** (`src/topic-config.ts`): Per-topic system prompts and command allowlists extracted from relay.ts for reuse across Composers.

Zero new dependencies — Composer is native to Grammy, Glob is native to Bun.

## Consequences

**Easier:**
- Adding a new feature: create `src/commands/new-feature.ts`, it's auto-loaded. No relay.ts modification needed.
- Testing: each Composer can be tested in isolation.
- Code navigation: 10 focused files (200-400 lines each) instead of one 3200-line file.
- Error isolation: errorBoundary per module prevents one broken Composer from crashing the bot.

**Harder:**
- Understanding the full command registration requires looking across multiple files (mitigated by CLAUDE.md module table and doc-freshness CI check).
- Shared state changes in BotContext affect all Composers (mitigated by TypeScript typing).
