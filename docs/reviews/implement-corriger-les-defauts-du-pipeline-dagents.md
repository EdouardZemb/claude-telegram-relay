# Implementation Report — SPEC-corriger-les-defauts-du-pipeline-dagents

> Date : 2026-03-22
> Spec : docs/specs/SPEC-corriger-les-defauts-du-pipeline-dagents.md
> Review adversariale : docs/reviews/adversarial-SPEC-corriger-les-defauts-du-pipeline-dagents.md

## Test Architect — Squelettes generes

| Fichier | V-criteres couverts | Tests prevus |
|---------|-------------------|--------------|
| `tests/generated/corriger-les-defauts-du-pipeline-dagents.test.ts` | V1-V11 | 30 tests (11 V-criteres + edge cases) |

V-criteres couverts :
- V1 (unit) : runPreCommitValidation + typecheck failure
- V2 (unit) : runPreCommitValidation + test failure
- V3 (unit) : runPreCommitValidation + both pass
- V4 (unit) : executeTask flow (structural)
- V5 (unit) : getSprintDelta error handling (structural + mock)
- V6 (unit) : getStaleTasks error handling (structural + mock)
- V7 (unit) : getDevInstructions enrichment
- V8 (unit) : heartbeat.ts import path
- V9 (unit) : scripts/doc-utils.ts re-export
- V10 (integration) : bun test tests/unit
- V11 (integration) : bun build typecheck

## Implementer — Fichiers modifies

| Fichier | Action | Lignes changees | Regle |
|---------|--------|----------------|-------|
| `src/agent.ts` | Modifie | +55 lignes (runPreCommitValidation + integration executeTask) | R1, R2 |
| `src/heartbeat.ts` | Modifie | ~40 lignes (Supabase error handling + logger migration + import fix) | R3, R6 |
| `src/bmad-prompts.ts` | Modifie | +3 lignes (instructions exec) | R4, R5 |
| `src/doc-utils.ts` | Cree | 221 lignes (copie depuis scripts/) | R6 |
| `scripts/doc-utils.ts` | Modifie | Remplace par re-export (7 lignes) | R6 |
| `tests/unit/doc-utils.test.ts` | Modifie | Import path update | R6 |
| `tests/unit/doc-freshness.test.ts` | Modifie | Import path update | R6 |
| `CLAUDE.md` | Modifie | +1 module (doc-utils.ts), module count 62 -> 63 | R6 |

### Details des modifications

**R1-R2 : Validation pre-commit (src/agent.ts)**
- Ajout de `runPreCommitValidation(projectDir)` : typecheck (`bun build --no-bundle --target=bun src/`) puis tests unitaires (`bun test tests/unit --bail`)
- Fail-fast : si le typecheck echoue, les tests sont ignores
- Troncation des erreurs a 2000 caracteres (finding F-EC-4)
- Try/catch pour gerer les erreurs d'environnement (finding F-EC-1 : bun absent, cwd invalide)
- Integration dans `executeTask` entre `git add -A` et `git commit`
- Commentaire "Defense in profondeur" documentant la coexistence gate hard + instructions soft (finding F-DA-3, F-SS-2)

**R3 : Correction Supabase heartbeat.ts**
- `getSprintDelta` : destructure `{ data: tasks, error }`, log.error + retour `changed: false` sur erreur
- `getStaleTasks` : destructure `{ data, error }`, log.error + retour `{ tasks: "", hasStale: false }` sur erreur
- Migration complete de heartbeat.ts vers `createLogger("heartbeat")` (35 occurrences console.log/error/warn remplacees)
- Le test logger-migration.test.ts (275 tests) passe desormais sans modification

**R4-R5 : Instructions agent enrichies (src/bmad-prompts.ts)**
- 3 nouvelles lignes dans `getDevInstructions("exec")` avant "Commence maintenant" :
  - Obligation mise a jour CLAUDE.md (compteur tests, table modules)
  - Obligation executer `bun build --no-bundle --target=bun` avant fin
  - Obligation executer `bun test tests/unit` avant fin

**R6 : Deplacement doc-utils.ts**
- `src/doc-utils.ts` : fichier principal (contenu identique a l'ancien scripts/doc-utils.ts)
- `scripts/doc-utils.ts` : re-export `export * from "../src/doc-utils.ts"` pour backward compat CI
- `src/heartbeat.ts` : import depuis `"./doc-utils.ts"` au lieu de `"../scripts/doc-utils.ts"`
- Tests et CI scripts mis a jour pour importer depuis le bon chemin
- `CLAUDE.md` mis a jour (nouveau module doc-utils.ts, compteur 62 -> 63)
- Verification : `bun run scripts/doc-freshness.ts` passe (re-export fonctionne)

## Tester — Tests completes

30 tests implementes dans `tests/generated/corriger-les-defauts-du-pipeline-dagents.test.ts` :
- 3 tests V1 (typecheck failure, export, truncation)
- 1 test V2 (test failure avec tmpdir)
- 1 test V3 (both pass avec tmpdir)
- 2 tests V4 (structural flow verification)
- 4 tests V5 (destructuration, log.error, changed:false, mock Supabase)
- 3 tests V6 (destructuration, log.error, mock Supabase)
- 4 tests V7 (CLAUDE.md, bun build, bun test, ordering)
- 2 tests V8 (no ../scripts, imports ./doc-utils.ts)
- 3 tests V9 (re-export, identity, functions)
- 1 test V10 (integration : bun test tests/unit)
- 1 test V11 (integration : bun build typecheck)
- 5 tests edge cases (defense in profondeur, fail-fast, logger migration)

## Resultat bun test

```
tests/unit : 2967 pass, 0 fail (101 files, 7.73s)
tests/generated/corriger-*.test.ts : 30 pass, 0 fail
scripts/doc-freshness.ts : OK (modules + commands en sync)
```

## Statut final

**DONE**

Toutes les corrections implementees, tous les V-criteres couverts, aucune regression.

## Etape suivante

Le conformance check puis la review sont geres par `/dev-pipeline`.
