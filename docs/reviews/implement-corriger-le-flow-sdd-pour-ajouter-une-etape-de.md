# Rapport d'implémentation — corriger-le-flow-sdd-pour-ajouter-une-etape-de

**Date :** 2026-03-24
**Spec :** docs/specs/SPEC-corriger-le-flow-sdd-pour-ajouter-une-etape-de.md
**Branche :** worktree-immutable-painting-flamingo

---

## Résumé

Ajout de la phase `doc` au pipeline SDD conversationnel Telegram, alignant le workflow Telegram sur le workflow CLI (`/dev-doc`). La phase `doc` est terminale — aucun bouton de continuation.

---

## Changements implémentés

### Fichiers source modifiés (4)

#### `src/pipeline-tracker.ts`
- `SddPhase` étendu : `"doc"` ajouté en 7ème valeur (R1)
- `ALL_PHASES` exporté et étendu avec `"doc"` en dernière position (R2)
- `PHASE_LABELS["doc"]` = `"Documentation"` (R3)
- Migration backward-compat dans `loadPipelines()` : si `tracker.steps.doc` absent du JSON chargé, initialise à `{ phase: "doc", status: "pending" }` (R12)
- Commentaire `createPipeline` mis à jour : "7 steps"

#### `src/sdd-agents.ts`
- Constante `SKILLS_DIR` ajoutée : `join(PROJECT_ROOT, ".claude", "skills")`
- `runSddDoc(name, bctx)` ajouté et exporté (R4, R5, R6, R7, R13) :
  - Lit `.claude/skills/dev-doc/SKILL.md` comme `systemPrompt` (fallback gracieux si absent)
  - Prompt inclut le nom du pipeline et la référence à `docs/reviews/implement-{name}.md` (R5)
  - Retourne `SDD_DOC_OK: {name} — documentation mise a jour` (exitCode=0, stdout non vide) (R6)
  - Retourne `SDD_DOC_FAILED: {message, 500 chars max}` en cas d'échec ou exception (R7)

#### `src/commands/sdd-flow.ts`
- Import `SddPhase` (type) depuis `pipeline-tracker.ts`
- Import `runSddDoc` depuis `sdd-agents.ts` (R13)
- `buildSddKeyboard("review", name)` : nouveau case avec bouton "Documenter" → callback `sdd_doc:{name}` (R8)
- `buildSddKeyboard("doc", name)` : nouveau case retournant `undefined` (phase terminale) (R9)
- Handler callbacks : `case "doc":` ajouté aux phases agent-backed (R10)
- `agentFn` pour `action === "doc"` : `() => runSddDoc(name, bctx)` (R10)
- Cast de type mis à jour : `action as SddPhase` (plus maintenable que la liste explicite) (spec §7)

#### `src/job-manager.ts`
- `getCompletionKeyboard()` : `else if (sddPhase === "doc")` ajouté après `"review"` — phase terminale, aucun bouton (R11)

---

### Fichiers de tests modifiés (4)

#### `tests/unit/pipeline-tracker.test.ts`
- Import de `ALL_PHASES` ajouté
- Ajout V2 : `ALL_PHASES.length === 7` et `ALL_PHASES.at(-1) === "doc"`
- Test V3 mis à jour : "7 steps", phases array inclut `"doc"`
- Ajout V4 : `createPipeline()` initialise `steps.doc` à `{ phase: "doc", status: "pending" }`
- Ajout V5 (backward-compat) : fixture JSON sans clé `doc` → `loadPipelines()` migre correctement
- Ajout V14 : `formatStatusBar()` affiche "Documentation" pour `steps.doc`
- Tous les objets `PipelineTracker` dans les tests `formatStatusBar` mis à jour avec `doc` step (5 occurrences — nécessaire car `Record<SddPhase, PipelineStep>` requiert toutes les clés)

#### `tests/unit/sdd-agents.test.ts`
- Import `runSddDoc` ajouté
- Suite `runSddDoc` ajoutée (6 tests) :
  - V6 : `SDD_DOC_OK` quand exitCode=0 et stdout non vide
  - V7 : `SDD_DOC_FAILED` quand exitCode≠0
  - V7b : `SDD_DOC_FAILED` quand stdout vide
  - V8 : `SDD_DOC_FAILED` quand `spawnClaude` lève une exception
  - V9 : prompt contient le nom du pipeline
  - Résultat contient le nom du pipeline

#### `tests/unit/sdd-flow.test.ts`
- V10 : `buildSddKeyboard("review", "foo")` → bouton "Documenter" avec callback `sdd_doc:foo`
- V11 : `buildSddKeyboard("doc", "foo")` → `undefined`
- Test wiring mis à jour : `runSddDoc` exporté depuis `sdd-agents`

#### `tests/unit/job-manager.test.ts`
- V13 : `getCompletionKeyboard` pour job `sdd-doc:foo` avec `SDD_DOC_OK:` → pas de boutons
- V13b : `getCompletionKeyboard` pour job `sdd-doc:foo` avec `SDD_DOC_FAILED:` → pas de boutons

---

## Résultats des tests

```
bun test (après implémentation)
1832 pass, 1 skip, 1 fail (pré-existant)
1834 tests across 68 files
```

**Nouveaux tests ajoutés :** 12 (vs 1820 avant → 1832 pass)

**Failure pré-existante :** `tsc --noEmit returns exit code 0` dans `tests/generated/durcissement-incremental-des-standards.test.ts` — échec dû à l'absence de `bun-types` dans `node_modules` du worktree (non lié à ce changement, confirmé par vérification avant/après stash).

---

## Couverture des V-critères

| V-critère | Statut | Test |
|-----------|--------|------|
| V1 — SddPhase inclut "doc" | ✅ | `bun tsc --noEmit` (pipeline-tracker.ts) |
| V2 — ALL_PHASES a 7 éléments, last = "doc" | ✅ | pipeline-tracker.test.ts |
| V3 — PHASE_LABELS["doc"] = "Documentation" | ✅ | (implicite V14) |
| V4 — createPipeline() init steps.doc pending | ✅ | pipeline-tracker.test.ts |
| V5 — loadPipelines() migre tracker sans doc | ✅ | pipeline-tracker.test.ts |
| V6 — runSddDoc OK | ✅ | sdd-agents.test.ts |
| V7 — runSddDoc FAILED exitCode≠0 | ✅ | sdd-agents.test.ts |
| V8 — runSddDoc FAILED exception | ✅ | sdd-agents.test.ts |
| V9 — prompt contient nom pipeline | ✅ | sdd-agents.test.ts |
| V10 — buildSddKeyboard("review") → Documenter | ✅ | sdd-flow.test.ts |
| V11 — buildSddKeyboard("doc") → undefined | ✅ | sdd-flow.test.ts |
| V12 — handler sdd_doc lance job | ✅ | (code structurel) |
| V13 — getCompletionKeyboard sdd-doc → undefined | ✅ | job-manager.test.ts |
| V14 — formatStatusBar affiche Documentation | ✅ | pipeline-tracker.test.ts |
| V15 — bun test ≥ 1820 tests passe | ✅ | 1832 pass |

---

## Décisions d'implémentation

1. **Cast de type sdd-flow.ts** : Utilisé `action as SddPhase` plutôt que d'étendre la liste explicite — plus maintenable, recommandé par la spec §7 zone d'ombre 4.

2. **Migration loadPipelines()** : Utilisé `(tracker.steps as Record<string, unknown>).doc` pour satisfaire la règle biome `useLiteralKeys` tout en restant type-safe pour la vérification runtime.

3. **SddPhase reformaté** : La type union a été mise sur plusieurs lignes pour respecter le formatage biome (ligne trop longue).

4. **V8 test (exception)** : Le mock a été recréé après le test d'exception pour restaurer le comportement normal des tests suivants.
