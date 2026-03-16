# SDD Spec — S31 Composer Extensibility

## Overview

Refactoriser relay.ts (3216 lignes, 33 commandes, 1 mega callback handler) en modules Composer Grammy autonomes, charges dynamiquement depuis un dossier src/commands/. Objectif : permettre l'ajout de nouvelles fonctionnalites (ex: classification de documents, OCR, pipelines custom) par simple creation d'un fichier, sans modifier relay.ts.

Contexte : relay.ts concentre tout le code du bot (commandes, callbacks, handlers de messages, fonctions internes). Chaque nouvelle feature necessite de modifier ce fichier, ce qui augmente le risque de regression et la complexite de merge. Grammy fournit nativement la classe Composer, qui permet de decouper un bot en sous-modules independants. Bun fournit Glob pour le chargement dynamique.


## User Stories

US-001: As a developer, I want to add a new Telegram command by creating a single file in src/commands/ so that I don't need to modify relay.ts.

US-002: As a developer, I want each command module to be testable in isolation so that I can write focused unit tests without loading the entire bot.

US-003: As a developer, I want relay.ts to be under 400 lines so that the bot entrypoint is easy to understand and maintain.

US-004: As a developer, I want callback query handlers to be co-located with their associated commands so that related logic stays together.

US-005: As a developer, I want shared bot utilities (callClaude, supabase, sendResponse, etc.) accessible from any Composer so that I don't duplicate internal functions.

US-006: As a developer, I want errors in one Composer to be isolated so that a bug in /prd doesn't crash the /task commands.


## Functional Requirements

FR-001: BotContext — Shared dependency object
  Extraire les fonctions et l'etat partages de relay.ts (callClaude, callClaudeInternal, supabase, session, claudeQueue, reminders, sendResponse, buildPrompt, saveMessage, etc.) dans un objet BotContext type et injectable, accessible par tous les Composers.
  Acceptance Criteria:
  - AC-001: GIVEN a BotContext WHEN it is created THEN it exposes callClaude, supabase, session, and all shared functions currently used by commands in relay.ts
  - AC-002: GIVEN a Composer module WHEN it needs to call Claude THEN it accesses callClaude via BotContext (not via closure or global)
  - AC-003: GIVEN the BotContext type WHEN exported from src/bot-context.ts THEN it has full TypeScript typing (no any)

FR-002: Composer modules in src/commands/
  Chaque domaine fonctionnel est un fichier dans src/commands/ qui exporte un default Composer (ou une factory function prenant BotContext et retournant un Composer).
  Acceptance Criteria:
  - AC-004: GIVEN src/commands/ WHEN all modules are created THEN every bot.command() currently in relay.ts has been moved to a Composer module
  - AC-005: GIVEN a Composer module WHEN it exports its default THEN it is either a Composer instance or a function (ctx: BotContext) => Composer
  - AC-006: GIVEN src/commands/help.ts WHEN loaded THEN it registers /help, /workflow, /agents, /status, /monitor commands
  - AC-007: GIVEN each Composer WHEN it handles callback queries THEN the callbacks related to its commands are registered in the same file (not in a centralized handler)

FR-003: Auto-loader (src/loader.ts)
  Un module qui scanne src/commands/*.ts avec Bun Glob, importe dynamiquement chaque fichier, et monte les Composers sur le bot.
  Acceptance Criteria:
  - AC-008: GIVEN src/commands/ with N .ts files WHEN the loader runs THEN N Composers are mounted on the bot via bot.use()
  - AC-009: GIVEN a new file added to src/commands/ WHEN the bot restarts THEN the new Composer is automatically loaded without modifying any other file
  - AC-010: GIVEN a Composer that throws during import WHEN the loader processes it THEN the error is logged and other Composers continue loading
  - AC-011: GIVEN the loader WHEN it mounts Composers THEN each one is wrapped in bot.errorBoundary() for runtime error isolation

FR-004: Reduction de relay.ts
  relay.ts ne contient plus que : creation du bot, middleware global (auth, rate limiting), appel du loader, entrypoint (import.meta.main), et process handlers.
  Acceptance Criteria:
  - AC-012: GIVEN relay.ts after refactoring WHEN lines are counted THEN it is under 400 lines
  - AC-013: GIVEN relay.ts WHEN inspected THEN it contains zero bot.command() calls (all moved to Composers)
  - AC-014: GIVEN relay.ts WHEN inspected THEN it contains zero direct callback_query handlers (all moved to Composers)
  - AC-015: GIVEN createBot() WHEN called THEN it returns a fully functional Bot with all commands registered (backward compatible)

FR-005: Message handlers migration
  Les handlers generiques (message:text, message:voice, message:photo, message:document) sont migres dans un ou plusieurs Composers.
  Acceptance Criteria:
  - AC-016: GIVEN a text message WHEN received by the bot THEN it is handled by a Composer (not inline in relay.ts)
  - AC-017: GIVEN a voice message WHEN received by the bot THEN transcription + Claude response + TTS still works identically
  - AC-018: GIVEN a photo message WHEN received by the bot THEN the current handler behavior is preserved
  - AC-019: GIVEN a document message WHEN received by the bot THEN the current handler behavior is preserved

FR-006: E2E test compatibility
  Les tests E2E existants (8 tests via handleUpdate) continuent de fonctionner sans modification.
  Acceptance Criteria:
  - AC-020: GIVEN the existing E2E test suite WHEN run against the refactored bot THEN all 8 tests pass
  - AC-021: GIVEN createBot(token) WHEN called in E2E tests THEN it returns a Bot that handles /help, /status, /feature, /workflow, /agents, /monitor, /estimate, /notify identically

FR-007: Documentation updates
  CLAUDE.md, doc-freshness, et ADR sont mis a jour pour refleter la nouvelle architecture.
  Acceptance Criteria:
  - AC-022: GIVEN doc-freshness.ts WHEN it scans for command registrations THEN it finds commands in src/commands/*.ts (composer.command) in addition to relay.ts (bot.command)
  - AC-023: GIVEN CLAUDE.md WHEN updated THEN the module table includes src/commands/ modules and src/bot-context.ts and src/loader.ts
  - AC-024: GIVEN docs/adr/ WHEN an ADR is created THEN it documents the Composer pattern decision, alternatives considered, and rationale


## Edge Cases

EC-001: Composer avec erreur de syntaxe — GIVEN a file in src/commands/ with a syntax error WHEN the loader imports it THEN the error is logged with the filename and the bot starts without that module. Expected behavior: graceful degradation.

EC-002: Deux Composers enregistrent la meme commande — GIVEN two files both register /task WHEN the loader mounts them THEN Grammy uses the first registered handler (order deterministic via sorted filenames). Expected behavior: warn in logs about duplicate command registration.

EC-003: Composer accede a BotContext avant initialisation — GIVEN a Composer factory function WHEN BotContext.supabase is null (no SUPABASE_URL) THEN the Composer handles it gracefully (same behavior as current null checks in relay.ts).

EC-004: Fichier non-Composer dans src/commands/ — GIVEN a utility file (e.g., helpers.ts) in src/commands/ that doesn't export a Composer WHEN the loader processes it THEN it is skipped with a debug log (no crash).

EC-005: Callback query data non gere — GIVEN a callback_query with data that no Composer handles WHEN received THEN the bot answers with a generic "Action non reconnue" (same as current fallback behavior).

EC-006: Hot reload en dev — GIVEN a Composer file is modified WHEN the bot is restarted via PM2 THEN the updated Composer is loaded. Expected behavior: no caching issues with Bun import.

EC-007: Ordre de chargement des Composers — GIVEN Composers with middleware dependencies (e.g., message:text must be loaded last after all commands) WHEN the loader runs THEN it supports explicit ordering (e.g., numeric prefix or metadata). Expected behavior: message handlers loaded after command handlers.


## Success Criteria

SC-001: relay.ts est sous 400 lignes
SC-002: Tous les 763+ tests existants passent (unit + integration + E2E)
SC-003: Les 33 commandes Telegram fonctionnent identiquement apres refactoring
SC-004: Le callback_query handler monolithique est elimine (chaque Composer gere ses callbacks)
SC-005: Ajouter une commande ne necessite que la creation d'un fichier dans src/commands/
SC-006: Zero nouvelle dependance npm (Composer est natif Grammy, Glob est natif Bun)
SC-007: Chaque Composer est isolee par errorBoundary (une erreur dans un module ne crashe pas les autres)
SC-008: doc-freshness.ts detecte les commandes dans src/commands/ sans faux positifs


## Out of Scope

- Refactoring des modules metier (tasks.ts, memory.ts, etc.) — ils restent inchanges
- Systeme de plugins dynamiques chargeable a chaud sans restart
- Migration vers Grammy Router (pas necessaire pour ce scope)
- Scenes/Stages pour les flux conversationnels multi-etapes (futur sprint)
- Nouvelles features (classification de documents, OCR) — a construire apres ce sprint


## Dependencies

- Grammy Composer class (deja inclus dans grammy, pas de dependance supplementaire)
- Bun Glob API (natif Bun)
- S30 E2E framework (deja merge) — les tests E2E doivent continuer a passer
- createBot() factory function dans relay.ts (a adapter, pas supprimer)


## Architecture Decisions

AD-001: Grammy Composer natif (pas de framework de plugins custom)
  Rationale: Composer est le mecanisme officiel de Grammy pour la modularite. Bot extends Composer, donc la compatibilite est garantie. Pas besoin de reinventer un systeme de plugins.

AD-002: Factory function avec BotContext (pas de singleton global)
  Rationale: Les Composers ont besoin d'acceder a supabase, callClaude, session, etc. Un objet BotContext injecte est testable et evite les globals. Chaque Composer exporte une factory (ctx: BotContext) => Composer.

AD-003: Auto-chargement par Glob (pas de registre manuel)
  Rationale: Le pattern convention-over-configuration (un fichier = un module charge) est utilise par Discord.js, GramIO, et d'autres frameworks matures. Ca elimine le boilerplate d'enregistrement et garantit qu'un nouveau fichier est automatiquement decouvert.

AD-004: ErrorBoundary par Composer (pas de try/catch global)
  Rationale: Grammy fournit bot.errorBoundary() qui isole les erreurs par sous-arbre de middleware. Si /prd crashe, /task continue de fonctionner. Plus robuste qu'un try/catch global.

AD-005: Migration incrementale (Composer par Composer, pas big bang)
  Rationale: Chaque Composer migre est un commit atomique testable. Si un Composer pose probleme, on peut le reverter sans impacter les autres. Les tests passent a chaque etape.

AD-006: Ordre de chargement via convention de nommage
  Rationale: Les fichiers sont charges par ordre alphabetique. Les message handlers (qui doivent etre enregistres apres les commandes) sont dans un fichier prefixe "zz-" ou similaire (ex: zz-messages.ts). Simple, explicite, pas de metadata complexe.


## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-001: BotContext exposes callClaude, supabase, session and all shared functions
- [ ] AC-003: BotContext type has full TypeScript typing (no any)
- [ ] AC-005: Composer module exports a factory function or Composer instance
- [ ] AC-008: Loader discovers and mounts N Composer files from src/commands/
- [ ] AC-009: New file in src/commands/ is auto-loaded on restart
- [ ] AC-010: Loader handles import errors gracefully (EC-001)
- [ ] AC-011: Each Composer is wrapped in errorBoundary
- [ ] AC-012: relay.ts is under 400 lines
- [ ] AC-013: relay.ts contains zero bot.command() calls
- [ ] AC-014: relay.ts contains zero callback_query handlers
- [ ] EC-002: Duplicate command registration logs a warning
- [ ] EC-004: Non-Composer files in src/commands/ are skipped
- [ ] EC-007: Message handlers loaded after command handlers

Integration Tests:
- [ ] AC-015: createBot() returns a fully functional Bot (backward compatible)
- [ ] AC-017: Voice message flow works end-to-end
- [ ] AC-022: doc-freshness detects commands in src/commands/

Acceptance Tests (E2E):
- [ ] AC-020: All 8 existing E2E tests pass without modification
- [ ] AC-021: handleUpdate works identically for /help, /status, /feature, /workflow, /agents, /monitor, /estimate, /notify
- [ ] SC-003: All 33 Telegram commands function identically

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
