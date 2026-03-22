# Spec : Migrer console.log vers le logger structure

> Genere le 2026-03-22. Source : exploration EXPLORE-migrer-console-log-vers-logger.md, codebase analysis (src/logger.ts, 3 fichiers pilotes migres, 42 fichiers restants).

## 1. Objectif

Migrer les 241 appels `console.log/error/warn` restants dans 42 fichiers source (`src/`) vers le module logger structure `src/logger.ts` (API `createLogger(moduleName)`), afin d'obtenir des logs JSON structures en production avec timestamp normalise, module identifier, correlation ID et filtrage par niveau (`LOG_LEVEL`). L'approche est incrementale par vagues pour maitriser le risque de regression sur les 2816 tests existants.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Chaque fichier migre DOIT importer `createLogger` et declarer `const log = createLogger("nom-module")` en tete de fichier (apres les imports) | Pattern des 3 fichiers pilotes (relay.ts L38-42, agent.ts L19-23, orchestrator.ts L24-26) | `import { createLogger } from "./logger.ts"; const log = createLogger("memory");` |
| R2 | `console.log("msg")` → `log.info("msg")` pour les messages operationnels ; `log.debug("msg")` pour les messages purement diagnostiques (ex: stats pdf-parse, variables de debug) | Exploration S6 regles de conversion + convention etat de l'art (Better Stack) | `console.log("Loaded: file")` → `log.info("Loaded: file")` ; `console.log("pdf-parse OK: X chars")` → `log.debug("pdf-parse OK: X chars")` |
| R3 | `console.warn("msg")` → `log.warn("msg")` — mapping direct | Exploration S6 | `console.warn("TTS: fallback")` → `log.warn("TTS: fallback")` |
| R4 | `console.error("msg")` → `log.error("msg")` — mapping direct pour les strings simples | Exploration S6 | `console.error("PIPER_MODEL_PATH not set")` → `log.error("PIPER_MODEL_PATH not set")` |
| R5 | `console.error("label:", error)` avec Error object → `log.error("label", { error: String(error) })` — le message reste une string, l'erreur passe en metadata | Exploration S3 pattern P6 (127 appels) + etat de l'art Pino/Better Stack | `console.error("Spawn error:", error)` → `log.error("Spawn error", { error: String(error) })` |
| R6 | `console.error("label:", { key: val })` avec object literal → `log.error("label", { key: val })` — passage direct en metadata | Exploration S3 pattern P7 (agent-events.ts) | `console.error("msg", { sessionId, role })` → `log.error("msg", { sessionId, role })` |
| R7 | Templates avec prefixe `[${timestamp}]` dans heartbeat.ts → supprimer le prefixe timestamp (redondant avec `entry.timestamp` du logger) et conserver uniquement le message | Exploration S3 pattern P4 (35 appels heartbeat.ts) | `` console.log(`[${timestamp}] Heartbeat pulse starting...`) `` → `log.info("Heartbeat pulse starting...")` |
| R8 | Templates avec prefixe `[module]` dans le message (ex: loader.ts `[loader]`) → supprimer le prefixe module (redondant avec `createLogger("loader")`) | Exploration S3 observation loader.ts (7 appels) | `` console.warn(`[loader] ${file}: no default export`) `` → `` log.warn(`${file}: no default export`) `` |
| R9 | `.catch(err => console.error(...))` inline → `.catch((err) => log.error(...))` — le `log` du module doit etre accessible dans la closure (declare au niveau module) | Exploration S3 pattern P5 (gate-evaluator.ts 7 appels, orchestrator.ts deja migre) | `.catch((err) => console.error("Gate error:", err))` → `.catch((err) => log.error("Gate error", { error: String(err) }))` |
| R10 | `src/logger.ts` est EXCLU de la migration — ses 3 appels `console.log/error/warn` sont l'implementation intentionnelle du logger | Exploration S3 item 17 | Les lignes 131, 133, 135 de logger.ts restent inchangees |
| R11 | `scripts/`, `dashboard/`, `mcp/` sont HORS SCOPE — seuls les fichiers dans `src/` sont migres. EXCEPTION : les tests qui espionnent directement `console.*` sur un module migre (loader.test.ts, prd.test.ts, code-review.test.ts) DOIVENT etre adaptes pour espionner le logger ou utiliser des assertions independantes du format de sortie | Exploration S6 + challenge adversarial (finding BLOQUANT) | `scripts/smoke-test.ts` conserve ses `console.log` ; `loader.test.ts` adapte ses spyOn |
| R15 | `loader.ts` errorBoundary (L65) utilise `[${moduleName}]` dynamique — passer `moduleName` en metadata au lieu de le supprimer : `log.error(msg, { errorModule: moduleName })` | Challenge adversarial (finding MAJEUR) | `` console.error(`[${moduleName}] ${error}`) `` → `` log.error(`${error}`, { errorModule: moduleName }) `` |
| R16 | Les references a `"console.error"` dans des string literals (ex: gate-persistence.ts L122) ne sont PAS des appels console et doivent etre exclues du test de compliance — le regex du test doit ignorer les strings entre quotes | Challenge adversarial (finding MAJEUR faux positif) | Le test filtre `console\.` uniquement hors des string literals |
| R12 | Le test `logger-migration.test.ts` DOIT etre etendu pour inclure tous les modules migres dans chaque vague (pas uniquement les 3 pilotes) | Exploration S6 + test existant (tests/unit/logger-migration.test.ts) | Ajouter `"memory.ts"`, `"heartbeat.ts"`, etc. a `MIGRATED_MODULES` |
| R13 | Pas de helper `toMeta()` dans le logger — utiliser directement `{ error: String(error) }` inline pour rester simple et eviter une abstraction prematuree | Decision spec (le pattern `String(error)` est suffisamment court et explicite, 127 occurrences ne justifient pas un helper qui obscurcirait le code) | `log.error("msg", { error: String(error) })` |
| R14 | `withCorrelation` est HORS SCOPE de cette migration — la propagation des correlation IDs sera un chantier separe | Decision spec (l'ajout de withCorrelation dans zz-messages.ts implique une refonte des handlers Telegram qui depasse le perimetre d'un refactoring de logs) | Le wrapping sera traite dans une spec dediee |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| 42 fichiers source `src/*.ts` + `src/commands/*.ts` | TypeScript source | Filesystem (Read) | Appels `console.log/error/warn` dans le code non-commente |
| `src/logger.ts` | Module TypeScript | Import | `createLogger(moduleName)` retournant `{ debug, info, warn, error }` |
| 3 fichiers pilotes migres (`relay.ts`, `orchestrator.ts`, `agent.ts`) | TypeScript source | Read (reference) | Pattern d'import et d'usage |
| `tests/unit/logger-migration.test.ts` | Test file | Read/Modify | `MIGRATED_MODULES` array a etendre |

## 4. Donnees de sortie

**Par fichier migre :**
- Ajout de l'import : `import { createLogger } from "./logger.ts";`
- Ajout de la declaration : `const log = createLogger("nom-module");`
- Remplacement de chaque `console.log/error/warn` selon les regles R2-R9
- Suppression des prefixes redondants (timestamp, module name)

**Test de compliance (extension de logger-migration.test.ts) :**
- `MIGRATED_MODULES` mis a jour avec tous les fichiers migres par vague
- Chaque module verifie : import createLogger, declaration log, zero console.log/error/warn dans le code non-commente

**Structure du test etendu :**
```
MIGRATED_MODULES = [
  // Pilotes (existants)
  "relay.ts", "orchestrator.ts", "agent.ts",
  // Vague 1
  "memory.ts", "heartbeat.ts", "documents.ts", "commands/zz-messages.ts", "bot-context.ts",
  // Vague 2
  "tts.ts", "gate-evaluator.ts", "workflow.ts", "loader.ts", "prd.ts", "blackboard.ts", "adversarial-verifier.ts",
  // Vague 3
  ...les 28 fichiers restants
]
```

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| **Vague 1 — Modules critiques haute frequence (~114 appels)** | | |
| `src/memory.ts` | modifier | 38 appels console — plus gros volume, chemin chaud memoire |
| `src/heartbeat.ts` | modifier | 35 appels — pattern P4 timestamp redondant a supprimer |
| `src/documents.ts` | modifier | 23 appels — extraction/classification documents |
| `src/commands/zz-messages.ts` | modifier | 11 appels — handler principal messages Telegram |
| `src/bot-context.ts` | modifier | 7 appels — contexte partage du bot |
| **Vague 2 — Infrastructure et agents (~60 appels)** | | |
| `src/tts.ts` | modifier | 14 appels — cascade fallback TTS |
| `src/gate-evaluator.ts` | modifier | 12 appels — 7 `.catch` inline |
| `src/workflow.ts` | modifier | 9 appels — transitions workflow |
| `src/loader.ts` | modifier | 7 appels — prefixe `[loader]` redondant |
| `src/prd.ts` | modifier | 6 appels — CRUD PRD Supabase |
| `src/blackboard.ts` | modifier | 6 appels — dont warns multi-lignes |
| `src/adversarial-verifier.ts` | modifier | 6 appels — verification spec/impl |
| **Vague 3 — Modules legers (~70 appels)** | | |
| `src/tasks.ts` | modifier | 5 appels |
| `src/adversarial-challenge.ts` | modifier | 4 appels |
| `src/commands/utilities.ts` | modifier | 4 appels |
| `src/llm-router.ts` | modifier | 4 appels |
| `src/document-sharding.ts` | modifier | 4 appels |
| `src/llm-ops.ts` | modifier | 3 appels |
| `src/cost-tracking.ts` | modifier | 3 appels |
| `src/notification-queue.ts` | modifier | 3 appels |
| `src/projects.ts` | modifier | 3 appels |
| `src/spec-lite.ts` | modifier | 3 appels |
| `src/pipeline-state.ts` | modifier | 3 appels |
| `src/job-manager.ts` | modifier | 3 appels |
| `src/commands/documents.ts` | modifier | 3 appels |
| `src/commands/memory-cmds.ts` | modifier | 3 appels |
| `src/commands/quality.ts` | modifier | 2 appels |
| `src/trust-scores.ts` | modifier | 2 appels |
| `src/gates.ts` | modifier | 2 appels |
| `src/agent-context.ts` | modifier | 1 appel |
| `src/agent-events.ts` | modifier | 1 appel (pattern P7 object literal) |
| `src/feedback-loop.ts` | modifier | 1 appel |
| `src/story-files.ts` | modifier | 1 appel |
| `src/transcribe.ts` | modifier | 1 appel |
| `src/intent-detection.ts` | modifier | 1 appel |
| `src/conversation-session.ts` | modifier | 1 appel |
| `src/gate-persistence.ts` | modifier | 1 appel |
| `src/code-review.ts` | modifier | 1 appel |
| `src/bmad-prompts.ts` | modifier | 1 appel |
| `src/commands/execution.ts` | modifier | 1 appel |
| `src/commands/help.ts` | modifier | 1 appel |
| `src/commands/jobs.ts` | modifier | 1 appel |
| **Tests** | | |
| `tests/unit/logger-migration.test.ts` | modifier | Etendre MIGRATED_MODULES avec les fichiers migres par vague |
| `tests/unit/loader.test.ts` | modifier | Adapter les 10+ tests qui espionnent `console.log` pour parser `[loader] Loaded:` — le format change apres migration |
| `tests/unit/prd.test.ts` | modifier | Adapter les 4 tests qui espionnent `console.error` — utiliser des assertions independantes du format |
| `tests/unit/code-review.test.ts` | modifier | Adapter le test qui verifie `saveReviewResult error` via `console.error` interception |
| **Exclus** | | |
| `src/logger.ts` | NE PAS modifier | Implementation intentionnelle (R10) |

## 6. Patterns existants

**Pattern de reference — fichier migre (relay.ts L38-42, L80, L110) :**
```typescript
import { createLogger } from "./logger.ts";
const log = createLogger("relay");

// Usage info
log.info(`Group message: chat_id=${chatId} from=${userId}`);

// Usage error avec template literal
log.error(`Bot error: ${err}`);

// Usage dans .catch inline
.catch((e) => log.error(`Failed to load feedback rules: ${e}`));
```

**Pattern de reference — error avec metadata (orchestrator.ts L419) :**
```typescript
if (error) log.error(`persistAgentArtifact(${agentId}) error: ${error.message}`);
```

**Pattern de reference — .catch inline migre (orchestrator.ts L837, L890, L906) :**
```typescript
}).catch((err) => log.error(`emitAgentEvent spawned error: ${err}`));
}).catch((err) => log.error(`captureAgentFailure error: ${err}`));
```

**Test de compliance existant (tests/unit/logger-migration.test.ts L14-68) :**
```typescript
const MIGRATED_MODULES = ["relay.ts", "orchestrator.ts", "agent.ts"];

// Pour chaque module :
// 1. Verifie import createLogger
// 2. Verifie const log = createLogger("...")
// 3. Verifie zero console.log/error/warn dans le code non-commente
// 4. Verifie usage de log.info/error/warn/debug
```

**API createLogger (src/logger.ts L142-153) :**
```typescript
export function createLogger(moduleName: string) {
  return {
    debug: (message: string, opts?: Omit<LogOptions, "module">) => ...,
    info:  (message: string, opts?: Omit<LogOptions, "module">) => ...,
    warn:  (message: string, opts?: Omit<LogOptions, "module">) => ...,
    error: (message: string, opts?: Omit<LogOptions, "module">) => ...,
  };
}
```

Le second argument `opts` accepte un `Record<string, unknown>` (hors `module`). Cela permet de passer des metadata arbitraires : `log.error("msg", { error: String(e), taskId })`.

## 7. Contraintes

- **Ne pas casser les 2816 tests** : chaque vague doit passer `bun test` integralement avant merge
- **Ne pas modifier `src/logger.ts`** : les 3 `console.*` internes sont l'implementation du logger (R10)
- **Ne pas modifier `scripts/`, `tests/`, `dashboard/`, `mcp/`** : hors scope (R11)
- **Pas de nouvelle dependance** : le module logger existe deja, pas de lib externe
- **Pas de modification de l'API du logger** : `createLogger` accepte deja tous les patterns identifies
- **Pas de `withCorrelation`** dans cette migration : la propagation des correlation IDs est un chantier distinct (R14)
- **Compatibilite des signatures** : `log.error(msg, opts)` attend `message: string` en premier arg — ne jamais passer un Error object directement comme message (utiliser template literal ou `String(error)`)
- **Niveau de log coherent** : `console.error` → `log.error`, `console.warn` → `log.warn`, `console.log` → `log.info` (defaut) ou `log.debug` (diagnostic). Ne jamais downgrader un `console.error` en `log.info`
- **Merge incrementaux** : chaque vague est un PR autonome, pas de PR geant couvrant les 42 fichiers

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | Apres vague 1, les 5 fichiers cibles (memory.ts, heartbeat.ts, documents.ts, zz-messages.ts, bot-context.ts) n'ont plus aucun `console.log/error/warn` dans le code non-commente | Test logger-migration.test.ts etendu avec ces 5 modules dans MIGRATED_MODULES | unit |
| V2 | Apres vague 2, les 7 fichiers cibles (tts.ts, gate-evaluator.ts, workflow.ts, loader.ts, prd.ts, blackboard.ts, adversarial-verifier.ts) n'ont plus aucun `console.log/error/warn` dans le code non-commente | Test logger-migration.test.ts etendu avec ces 7 modules | unit |
| V3 | Apres vague 3, les 28 fichiers restants n'ont plus aucun `console.log/error/warn` dans le code non-commente | Test logger-migration.test.ts etendu avec les 28 modules | unit |
| V4 | Chaque fichier migre importe `createLogger` et declare `const log = createLogger("nom-module")` | Test logger-migration.test.ts (assertions existantes : import + declaration) | unit |
| V5 | Chaque fichier migre utilise au moins un appel `log.info`, `log.error`, `log.warn` ou `log.debug` | Test logger-migration.test.ts (assertion existante : usage log.*) | unit |
| V6 | `src/logger.ts` conserve ses 3 appels `console.*` internes inchanges | Test : verifier que logger.ts contient exactement 3 occurrences de `console.` dans le code non-commente | unit |
| V7 | heartbeat.ts ne contient plus de prefixe `[${timestamp}]` dans les messages de log (regle R7) | Grep dans le fichier migre : aucune occurrence de `` `[${timestamp}]` `` ou `` `[${new Date` `` | unit |
| V8 | loader.ts ne contient plus de prefixe `[loader]` dans les messages de log (regle R8) | Grep dans le fichier migre : aucune occurrence de `[loader]` dans les strings de log | unit |
| V9 | Les `.catch(err => ...)` inline de gate-evaluator.ts utilisent `log.error` au lieu de `console.error` | Test logger-migration.test.ts pour gate-evaluator.ts (zero console.error) | unit |
| V10 | Aucune regression sur la suite de tests : `bun test` passe integralement (2816+ tests) apres chaque vague | Execution `bun test` en CI (ci.yml) sur le PR de chaque vague | integration |
| V11 | Les modules `scripts/`, `dashboard/`, `mcp/` ne sont PAS modifies. Les tests adaptes sont limites a : `logger-migration.test.ts`, `loader.test.ts`, `prd.test.ts`, `code-review.test.ts` | Verification git diff : seuls `src/` et les 4 fichiers test listes sont modifies | unit |
| V12 | En production (NODE_ENV=production), les logs des modules migres sortent en JSON structure avec les champs `timestamp`, `level`, `module`, `correlation_id`, `message` | Test unitaire : mocker `process.env.NODE_ENV = "production"`, capturer stdout/stderr, parser JSON et verifier les champs | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | 241 appels console.* non structures dans 42 fichiers identifie dans l'exploration, impact observabilite en prod clairement documente |
| Perimetre | Couvert | IN: 42 fichiers src/, logger-migration.test.ts. OUT: logger.ts, scripts/, tests/, dashboard/, mcp/, withCorrelation |
| Validation | Couvert | 12 V-criteres couvrant compliance par vague, patterns speciaux (heartbeat, loader, gate-evaluator), non-regression, et output JSON |
| Technique | Couvert | API logger inchangee, patterns de conversion documentes pour les 7 patterns identifies (P1-P7), pas de nouvelle dependance |
| UX | Non applicable | Aucune interaction utilisateur modifiee — refactoring purement interne |
| Alternatives | Pertinent | Option A (status quo) rejetee : dette croissante. Option B (incrementale) retenue : risque maitrise. Option C (big-bang) rejetee : diff massif, risque regression, conflits merge. Detaille dans l'exploration Section 4 |

**Zones d'ombre residuelles :**

1. **Choix info vs debug pour `console.log` informationnels** : la regle R2 donne la direction (operationnel → `info`, diagnostic → `debug`), mais la distinction est parfois subjective. L'implementeur devra juger au cas par cas. En cas de doute, preferer `info` (plus visible en production).

2. **Ordre des vagues vs branches concurrentes** : si d'autres PRs modifient des fichiers en cours de migration, des conflits de merge sont possibles. La strategie est de merger chaque vague rapidement (dans la meme journee si possible) pour minimiser la fenetre de conflit.

3. **Tests qui mockent `console.error`** : certains tests unitaires existants pourraient spy sur `console.error` pour verifier le comportement d'erreur. Apres migration, ces tests devront etre adaptes (spy sur `log.error` ou verifier que le logger est appele). A verifier pendant l'implementation de chaque vague.
