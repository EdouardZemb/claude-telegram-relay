# Implementation Report: Auto-merge des PRs SDD quand CI vert

## Resume

Implementation de l'auto-merge SDD via `gh pr merge --auto --squash --delete-branch`. Quand le reviewer SDD approuve une PR (verdict APPROVED), et que le feature flag `sdd_auto_merge` est actif, le bot active l'auto-merge natif GitHub. Le merge est effectue automatiquement par GitHub quand tous les status checks passent.

## Tests generes

| Fichier | Tests | Criteres couverts |
|---------|-------|-------------------|
| `tests/unit/sdd-agents.test.ts` | 7 tests (AM1-AM7) | Auto-merge actif/inactif, verdict, prUrl absent, GITHUB_REPO absent, echec merge, flag -R |
| `tests/unit/job-manager.test.ts` | 4 tests (AM-KB1 a AM-KB3, AM-NOTIF1) | Keyboard sans bouton merge quand auto-merge, notification avec message auto-merge |
| `tests/unit/feature-flags.test.ts` | 1 test (AM-FLAG) | Presence du flag sdd_auto_merge dans config |

**Total : 12 nouveaux tests**

## Fichiers modifies

| Fichier | Lignes changees | Description |
|---------|----------------|-------------|
| `config/features.json` | +1 | Ajout flag `sdd_auto_merge: true` |
| `src/sdd-agents.ts` | +40 | Import isFeatureEnabled, hook test, logique auto-merge dans runSddReview |
| `src/job-manager.ts` | +6 | Keyboard adapte (pas de bouton merge si [AUTO-MERGE]), notification specifique |
| `tests/unit/sdd-agents.test.ts` | +115 | 7 tests auto-merge + import setFeatureEnabledHook + beforeEach hook reset |
| `tests/unit/job-manager.test.ts` | +50 | 4 tests (keyboard + notification) |
| `tests/unit/feature-flags.test.ts` | +7 | 1 test presence flag |

## Architecture de la solution

### Option choisie : C (gh pr merge --auto natif GitHub)

Point d'injection : `runSddReview()` dans `src/sdd-agents.ts`

Flux :
1. Reviewer SDD analyse la PR et retourne `VERDICT: APPROVED`
2. `gh pr review --approve` est execute (existant)
3. Si `sdd_auto_merge` est actif : `gh pr merge --auto --squash --delete-branch` est execute
4. GitHub attend que la CI passe et merge automatiquement
5. Le tag `[AUTO-MERGE]` est ajoute au result string pour signaler aux composants aval

### Signalisation aval via tag [AUTO-MERGE]

Le result string `SDD_REVIEW_APPROVED: {name} [AUTO-MERGE]` sert de signal :
- `getCompletionKeyboard()` : supprime le bouton "Fusionner la PR" (inutile si auto-merge actif)
- `sendJobCompletionNotification()` : message specifique "auto-merge active"
- Le bouton "Voir la PR" reste disponible

### Gardes-fous

- Feature flag `sdd_auto_merge` pour toggle instantane
- Seul `runSddReview` peut declencher l'auto-merge (guard PR SDD-only)
- Echec de `gh pr merge --auto` est loge mais non fatal (fallback bouton manuel)
- Le bouton "Fusionner" dans `sdd-flow.ts` (`merge_ok`) reste en place comme fallback
- Branch protection (`required_status_checks: [check]`, `strict: true`) reste le filet de securite

### Testabilite

Hook pattern coherent avec l'existant (`setWriteFileHook`, `setSpawnSyncHook`) :
- `setFeatureEnabledHook` permet de controler `isFeatureEnabled` dans les tests
- Les tests par defaut desactivent l'auto-merge (`beforeEach(() => setFeatureEnabledHook(() => false))`)

## Resultats bun test

```
2074 pass
1 skip
0 fail
4173 expect() calls
Ran 2075 tests across 74 files
```

## Prerequis externe

`allow_auto_merge` doit etre active sur le repo GitHub :
```
gh api -X PATCH repos/EdouardZemb/claude-telegram-relay -f allow_auto_merge=true
```

## Statut final

**DONE**
