# Implementation Report — Migrer console.log vers le logger structure

> Date : 2026-03-22
> Spec : docs/specs/SPEC-migrer-console-log-vers-logger.md
> Review adversariale : docs/reviews/adversarial-SPEC-migrer-console-log-vers-logger.md

## Synthese

Migration des 241 appels `console.log/error/warn` dans 42 fichiers `src/` vers le module logger structure `src/logger.ts`. Toutes les vagues (1, 2, 3) implementees dans un seul PR pour eviter les conflits merge (recommandation F-SS-1).

**Statut : DONE**

## Fichiers modifies (source)

### Vague 1 — Modules critiques (5 fichiers, ~114 appels)

| Fichier | Appels migres | Notes |
|---------|--------------|-------|
| `src/memory.ts` | 38 | `createLogger("memory")`, tous error/info |
| `src/heartbeat.ts` | 35 | `createLogger("heartbeat")`, R7 : prefixes `[${timestamp}]` supprimes, HEARTBEAT_DEBUG conditionnel remplace par `log.debug` |
| `src/documents.ts` | 23 | `createLogger("documents")`, pdf-parse stats en `log.debug` |
| `src/commands/zz-messages.ts` | 11 | `createLogger("zz-messages")` |
| `src/bot-context.ts` | 7 | `createLogger("bot-context")` |

### Vague 2 — Infrastructure et agents (7 fichiers, ~60 appels)

| Fichier | Appels migres | Notes |
|---------|--------------|-------|
| `src/tts.ts` | 14 | `createLogger("tts")` |
| `src/gate-evaluator.ts` | 12 | `createLogger("gate-evaluator")`, 7 `.catch` inline migres (R9) |
| `src/workflow.ts` | 9 | `createLogger("workflow")` |
| `src/loader.ts` | 7 | `createLogger("loader")`, R8 : prefixes `[loader]` supprimes, R15 : errorBoundary `moduleName` passe en metadata `{ errorModule: moduleName }` |
| `src/prd.ts` | 6 | `createLogger("prd")` |
| `src/blackboard.ts` | 6 | `createLogger("blackboard")` |
| `src/adversarial-verifier.ts` | 6 | `createLogger("adversarial-verifier")` |

### Vague 3 — Modules legers (28 fichiers, ~70 appels)

| Fichier | Appels migres |
|---------|--------------|
| `src/tasks.ts` | 5 |
| `src/adversarial-challenge.ts` | 4 |
| `src/commands/utilities.ts` | 4 |
| `src/llm-router.ts` | 4 |
| `src/document-sharding.ts` | 4 |
| `src/llm-ops.ts` | 3 |
| `src/cost-tracking.ts` | 3 |
| `src/notification-queue.ts` | 3 |
| `src/projects.ts` | 3 |
| `src/spec-lite.ts` | 3 |
| `src/pipeline-state.ts` | 3 |
| `src/job-manager.ts` | 3 |
| `src/commands/documents.ts` | 3 |
| `src/commands/memory-cmds.ts` | 3 |
| `src/commands/quality.ts` | 2 |
| `src/trust-scores.ts` | 2 |
| `src/gates.ts` | 2 |
| `src/agent-context.ts` | 1 |
| `src/agent-events.ts` | 1 (R6 : object literal passe en metadata) |
| `src/feedback-loop.ts` | 1 |
| `src/story-files.ts` | 1 |
| `src/transcribe.ts` | 1 |
| `src/intent-detection.ts` | 1 |
| `src/conversation-session.ts` | 1 |
| `src/gate-persistence.ts` | 1 |
| `src/code-review.ts` | 1 |
| `src/bmad-prompts.ts` | 1 |
| `src/commands/execution.ts` | 1 |
| `src/commands/help.ts` | 1 |
| `src/commands/jobs.ts` | 1 |

## Fichiers modifies (tests)

| Fichier | Modifications |
|---------|--------------|
| `tests/unit/logger-migration.test.ts` | MIGRATED_MODULES etendu de 3 a 45 modules. Ajout tests V6 (logger.ts preserve console), V7 (heartbeat pas de timestamp prefix), V8 (loader pas de [loader] prefix), R16 (gate-persistence string literal). Filtre ameliore avec `hasRealConsoleCall()` pour exclure les string literals. |
| `tests/unit/loader.test.ts` | Adapte pour le nouveau format du logger structure. Tests interceptent `console.log` (sortie sous-jacente du logger) et utilisent `extractLoadedFiles()` pour parser le format "Loaded: filename.ts" au lieu de "[loader] Loaded: filename.ts". |
| `tests/unit/prd.test.ts` | Pas de modification — `spyOn(console, "error")` fonctionne toujours car `log.error()` appelle `console.error()` en interne. |
| `tests/unit/code-review.test.ts` | Pas de modification — meme raison que prd.test.ts. |

## Fichiers exclus (conformite spec)

- `src/logger.ts` : 3 appels `console.*` preserves (R10, implementation du logger)
- `src/gate-persistence.ts` L124 : "console.error" dans un string literal, pas un appel reel (R16)
- `scripts/`, `dashboard/`, `mcp/` : hors scope (R11)

## Regles appliquees

| Regle | Application |
|-------|------------|
| R1 | Import `createLogger` + `const log = createLogger("...")` dans chaque fichier |
| R2 | `console.log` -> `log.info` (operationnel) ou `log.debug` (diagnostic: pdf-parse stats, heartbeat debug output) |
| R3 | `console.warn` -> `log.warn` (mapping direct) |
| R4 | `console.error("msg")` -> `log.error("msg")` |
| R5 | `console.error("label:", error)` -> `log.error("label", { error: String(error) })` |
| R6 | `console.error("msg", { obj })` -> `log.error("msg", { obj })` (agent-events.ts) |
| R7 | heartbeat.ts : prefixes `[${timestamp}]` supprimes (redundants avec `entry.timestamp`) |
| R8 | loader.ts : prefixes `[loader]` supprimes (redundants avec `createLogger("loader")`) |
| R9 | `.catch(err => console.error(...))` -> `.catch((err) => log.error(...))` |
| R10 | `src/logger.ts` non modifie |
| R11 | Seuls `src/` et les 4 tests modifies |
| R12 | `MIGRATED_MODULES` etendu avec les 42 modules |
| R13 | Pas de helper `toMeta()`, `{ error: String(error) }` inline partout |
| R14 | `withCorrelation` hors scope |
| R15 | loader.ts errorBoundary : `log.error(msg, { errorModule: moduleName })` |
| R16 | Test de compliance filtre les string literals |

## Findings adversariaux adresses

| Finding | Resolution |
|---------|-----------|
| F-EC-1 (BLOQUANT) : loader.test.ts casse | Tests adaptes avec `extractLoadedFiles()` qui parse le format du logger structure |
| F-DA-1 : prd.test.ts et code-review.test.ts | Pas de modification necessaire — `console.error` toujours appele en interne par le logger |
| F-DA-2/F-EC-2 : errorBoundary perd moduleName | Corrige avec metadata `{ errorModule: moduleName }` (R15) |
| F-EC-3 : gate-persistence.ts faux positif | Test `hasRealConsoleCall()` filtre les string literals |
| F-DA-3 : info/debug subjectif | Critere applique : `log.debug` pour diagnostics (pdf-parse, heartbeat raw output), `log.info` pour tout le reste |
| F-EC-5 : HEARTBEAT_DEBUG conditionnel | Condition supprimee, remplacee par `log.debug` (LOG_LEVEL gere le filtrage) |
| F-SS-1 : 1 PR unique | Toutes les vagues dans un seul PR/commit |

## Resultats `bun test`

```
3207 pass
5 skip
0 fail
7355 expect() calls
Ran 3212 tests across 111 files. [35.78s]
```

Zero regression. Les 275 tests de logger-migration.test.ts passent (45 modules x 6 assertions + tests complementaires).

## Etape suivante

**DONE** — Le conformance check et la review sont geres par `/dev-pipeline`.
