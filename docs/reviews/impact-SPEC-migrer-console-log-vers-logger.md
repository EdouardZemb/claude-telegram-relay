## Rapport d'impact : Migrer console.log vers le logger structure

> Genere le 2026-03-22 a partir de docs/specs/SPEC-migrer-console-log-vers-logger.md.

### Niveau de risque : HIGH

### Resume

Ce changement modifie 42 fichiers source dans `src/` pour remplacer 241 appels `console.log/error/warn` par le logger structure `createLogger`. Bien que l'API du logger soit stable et que la migration soit purement mecanique (refactoring interne sans changement de comportement fonctionnel), le blast radius est massif (42 fichiers directs + 42 fichiers de test correspondants) et plusieurs tests existants interceptent directement `console.log/error/warn` pour valider le comportement des modules migres, ce qui constitue un risque de regression eleve.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/logger.ts` | Aucun (exclu R10) | Implementation intentionnelle, conserve ses 3 appels `console.*` |
| `src/memory.ts` | Direct | 38 appels console a migrer — plus gros volume |
| `src/heartbeat.ts` | Direct | 35 appels — suppression pattern timestamp redondant (R7) |
| `src/documents.ts` | Direct | 23 appels — extraction/classification |
| `src/tts.ts` | Direct | 14 appels — cascade fallback TTS |
| `src/gate-evaluator.ts` | Direct | 12 appels — 7 `.catch` inline |
| `src/commands/zz-messages.ts` | Direct | 11 appels — handler principal Telegram |
| `src/workflow.ts` | Direct | 9 appels — transitions workflow |
| `src/bot-context.ts` | Direct | 7 appels — contexte partage |
| `src/loader.ts` | Direct | 7 appels — prefixe `[loader]` redondant (R8) |
| `src/prd.ts` | Direct | 6 appels — CRUD PRD |
| `src/blackboard.ts` | Direct | 6 appels — warns multi-lignes |
| `src/adversarial-verifier.ts` | Direct | 6 appels |
| `src/tasks.ts` | Direct | 5 appels |
| `src/adversarial-challenge.ts` | Direct | 4 appels |
| `src/commands/utilities.ts` | Direct | 4 appels |
| `src/llm-router.ts` | Direct | 4 appels |
| `src/document-sharding.ts` | Direct | 4 appels |
| `src/llm-ops.ts` | Direct | 3 appels |
| `src/cost-tracking.ts` | Direct | 3 appels |
| `src/notification-queue.ts` | Direct | 3 appels |
| `src/projects.ts` | Direct | 3 appels |
| `src/spec-lite.ts` | Direct | 3 appels |
| `src/pipeline-state.ts` | Direct | 3 appels |
| `src/job-manager.ts` | Direct | 3 appels |
| `src/commands/documents.ts` | Direct | 3 appels |
| `src/commands/memory-cmds.ts` | Direct | 3 appels |
| `src/commands/quality.ts` | Direct | 2 appels |
| `src/trust-scores.ts` | Direct | 2 appels |
| `src/gates.ts` | Direct | 2 appels |
| `src/agent-context.ts` | Direct | 1 appel |
| `src/agent-events.ts` | Direct | 1 appel (pattern P7 object literal) |
| `src/feedback-loop.ts` | Direct | 1 appel |
| `src/story-files.ts` | Direct | 1 appel |
| `src/transcribe.ts` | Direct | 1 appel |
| `src/intent-detection.ts` | Direct | 1 appel |
| `src/conversation-session.ts` | Direct | 1 appel |
| `src/gate-persistence.ts` | Direct | 1 appel |
| `src/code-review.ts` | Direct | 1 appel |
| `src/bmad-prompts.ts` | Direct | 1 appel |
| `src/commands/execution.ts` | Direct | 1 appel |
| `src/commands/help.ts` | Direct | 1 appel |
| `src/commands/jobs.ts` | Direct | 1 appel |
| `tests/unit/logger-migration.test.ts` | Direct | Extension de MIGRATED_MODULES |
| `tests/unit/loader.test.ts` | Indirect | 10+ tests interceptent `console.log/warn/error` pour valider loader.ts — format des messages va changer |
| `tests/unit/prd.test.ts` | Indirect | 4 tests spyOn `console.error` pour verifier le comportement d'erreur de prd.ts |
| `tests/unit/code-review.test.ts` | Indirect | 1 test intercepte `console.error` pour verifier saveReviewResult |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/logger.ts` | `createLogger()` | Aucun | Oui |
| 42 fichiers `src/` | N/A (implementation interne) | Remplacement console.* par log.* | Oui |

Aucune API publique (signature, type d'export, valeur de retour) n'est modifiee par cette migration. Le changement est strictement interne : les appels `console.*` sont remplaces par des appels au logger, sans modifier les interfaces exportees.

### Breaking changes potentiels

- [x] **Tests `loader.test.ts` casseront** (10+ tests) — Ces tests interceptent directement `console.log` et cherchent des patterns de string specifiques comme `"[loader] Loaded:"`, `"composers loaded"`, et `"[loader]"`. Apres migration, `log.info("Loaded: help.ts")` passera par le logger qui formate le message differemment (JSON en production, format avec couleurs ANSI en dev). Les tests verront soit un string JSON, soit un string formate avec `[loader]` insere par le formatter dev — pas le format original `"[loader] Loaded: help.ts"`. **Impact** : `tests/unit/loader.test.ts` (tests : load order, loaded count, module filenames, 13 known files, .ts extension filtering)

- [x] **Tests `prd.test.ts` casseront** (4 tests) — Ces tests font `spyOn(console, "error")` et verifient que `errorSpy.toHaveBeenCalled()` apres une erreur Supabase. Apres migration de `src/prd.ts`, les erreurs passeront par `log.error()` qui appelle `console.error(formatted)` avec un message formate. Le spy captera toujours l'appel mais le contenu sera different (string formate vs string brut). Les assertions `toHaveBeenCalled()` passeront encore, mais si des assertions sur le contenu sont ajoutees ulterieurement, elles casseraient. **Impact** : `tests/unit/prd.test.ts` (4 tests error handling) — **risque modere** car les assertions actuelles sont faibles (`toHaveBeenCalled` seulement)

- [x] **Test `code-review.test.ts` cassera** (1 test) — Ce test intercepte `console.error` et verifie que `errorCalls[0][0].toContain("saveReviewResult error")`. Apres migration, `log.error("saveReviewResult error", ...)` produira un message formate differemment. Le `toContain` echouera car le message sera enveloppe dans le format du logger (JSON ou format dev). **Impact** : `tests/unit/code-review.test.ts` (test "logs error when supabase insert fails")

### Points d'attention pour le Reviewer

1. **CRITIQUE — Tests loader.test.ts a adapter** : 10+ tests dans `tests/unit/loader.test.ts` interceptent `console.log` pour parser les messages du loader (patterns `[loader] Loaded:`, `composers loaded`, `[loader] Failed`). Ces tests doivent etre adaptes pour fonctionner avec le format du logger. Options : (a) intercepter `console.log` mais parser le format logger, (b) mocker le module logger directement, (c) tester le retour de `loadComposers()` sans verifier les logs. La spec ne mentionne pas cette adaptation — elle doit etre ajoutee au scope de la vague 2 (loader.ts est en vague 2).

2. **CRITIQUE — Test code-review.test.ts : assertion sur le contenu** : Le test a la ligne 433 fait `expect(errorCalls[0][0]).toContain("saveReviewResult error")`. Apres migration de `src/code-review.ts`, le message sera formate par le logger. Ce test doit etre adapte pour gerer le nouveau format, ou l'assertion doit etre relaxee.

3. **IMPORTANT — Tests prd.test.ts : spy console.error** : 4 tests dans `tests/unit/prd.test.ts` font `spyOn(console, "error")`. Les assertions actuelles (`toHaveBeenCalled`) continueront de passer car `log.error` appelle bien `console.error` en sous-jacent. Toutefois, cela cree un couplage fragile avec l'implementation du logger. Le Reviewer doit verifier que ces tests passent apres migration de `src/prd.ts` (vague 2) et envisager de les migrer vers un spy sur le logger.

4. **IMPORTANT — Choix info vs debug subjectif** : La regle R2 distingue `log.info` (operationnel) et `log.debug` (diagnostic) pour les `console.log`, mais le choix est parfois subjectif. Le Reviewer doit verifier que les appels critiques en production (erreurs Supabase, demarrage de services, chargement de modules) restent en `info` et ne sont pas degrades en `debug` (invisible en prod avec `LOG_LEVEL=info` par defaut).

5. **ATTENTION — Suppression prefixe `[loader]` et impact tests** : La regle R8 stipule de supprimer le prefixe `[loader]` des messages. Or, les tests `loader.test.ts` cherchent explicitement `"[loader] Loaded:"`. La migration de loader.ts et l'adaptation des tests doivent etre faites dans le meme commit/PR pour eviter un etat intermediaire ou les tests echouent.

6. **ATTENTION — Suppression prefixe timestamp dans heartbeat.ts** : La regle R7 supprime les prefixes `[${timestamp}]`. Le Reviewer doit verifier qu'aucune logique downstream (monitoring, parsing de logs) ne depend de ce format de timestamp inline.

7. **ATTENTION — Contrainte hors-scope (R11) a verifier** : Le V-critere V11 stipule que seuls les fichiers `src/` et `tests/unit/logger-migration.test.ts` sont modifies. Or les tests `loader.test.ts`, `prd.test.ts`, et `code-review.test.ts` devront aussi etre adaptes. Le Reviewer doit valider si ces adaptations de tests sont dans le scope (elles devraient l'etre).

### Blast radius

- Modules directement modifies : 42 (fichiers source `src/`)
- Modules indirectement impactes : 3 (fichiers de test qui interceptent console.* : `loader.test.ts`, `prd.test.ts`, `code-review.test.ts`)
- Fichiers source modifies : 43 (42 src/ + 1 test logger-migration.test.ts)
- Fichiers de test a verifier : 45 (42 tests unitaires correspondant aux modules migres + 3 tests avec interception console.*)
