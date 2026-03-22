# Rapport d'implementation : Ameliorer le workflow de notification et d'escalade des batch autopipeline

> Genere le 2026-03-22. Spec : docs/specs/SPEC-ameliorer-le-workflow-de-notification-et.md

## Phase 1 — Test Architect

Squelettes generes dans `tests/generated/ameliorer-le-workflow-de-notification-et.test.ts`.

| V-critere | Niveau | Describe | Tests prevus |
|-----------|--------|----------|-------------|
| V1 | unit | Notification batch avec detail par tache | nominal (detail multi-tache), durees, PR URLs |
| V2 | unit | Troncature resultat 4000 chars | conserve 3000, tronque 5000, exact 4000, autres types 500 |
| V3 | unit | Troncature Telegram 3800 chars | message tronque avec +K autres, message court non tronque |
| V4 | unit | onProgress envoie un message par tache | sendProgressMessage callable avec bons params |
| V5 | unit | onProgress utilise chatId/threadId | sendMessage appele, pas ctx.reply |
| V6 | unit | Escalade critique si taux > 50% | 75% echec, 100% echec, 50% exact (pas ALERTE) |
| V7 | unit | Notification normale si taux <= 50% | 25% echec, 0% echec |
| V8 | unit | Keyboard avec bouton Relancer | bouton present, job ID dans callback_data, 1 echec, pas de bouton si sous seuil |
| V9 | unit | Keyboard avec seulement backlog | tous reussissent, sans BATCH_COMPLETE, status failed |
| V10 | unit | Handler jc_batch_retry | extraction failed IDs pour relance |
| V11 | unit | Encodage failed IDs | round-trip encode/decode, IDs vides |
| V12 | unit | Seuil configurable | valeur 0.5, type number, entre 0 et 1 |
| V13 | unit | Erreurs sendProgressMessage catchees | bot echoue, bot null, threadId present/absent |
| V14 | unit | Job expire dans handler retry | get() retourne undefined, parseBatchResult null |
| V15 | unit | parseBatchResult format etendu | valide avec/sans IDs, invalide, null, vide, 0/0, double newlines |
| V16 | unit | Taches non executees dans failed IDs | parsing IDs multiples, ok/total corrects |
| V17 | unit | Rate limit onProgress | 1 message par appel |

Total : 17 V-criteres couverts, 51 tests

## Phase 2 — Implementer

### Fichiers modifies

| Fichier | Lignes changees | Description |
|---------|----------------|-------------|
| `src/job-manager.ts` | +140 / -2 | Ajout `BATCH_FAILURE_THRESHOLD`, `BatchResult`, `parseBatchResult()`, `sendProgressMessage()`. Troncature conditionnelle 4000 chars. Notification batch enrichie avec detail par tache, troncature 3800, prefixe ALERTE. Keyboard conditionnel avec bouton Relancer. Fallback enqueue avec severite critique. |
| `src/commands/planning.ts` | +60 / -8 | Import `sendProgressMessage`. Les deux closures `launchFn` (prdwf_launch et prdwf_preflight_ok) branchent `onProgress` via `sendProgressMessage` avec chatId/threadId captures. Format de retour encode les failed IDs (R9) et les taches non executees (R15). |
| `src/commands/jobs.ts` | +89 / -1 | Import `launch`, `parseBatchResult`. Handler `jc_batch_retry:<jobId>` : garde pour job expire (R14), parsing des failed IDs, resolution des taches par short ID prefix dans Supabase, relance d'un nouveau batch autopipeline-batch. |

### Regles metier couvertes

| Regle | Statut | Implementation |
|-------|--------|----------------|
| R1 | OK | `sendJobCompletionNotification` parse les blocs de details et produit une ligne condensee par tache |
| R2 | OK | Troncature conditionnelle `job.type === "autopipeline-batch" ? 4000 : 500` dans `launch()` |
| R3 | OK | Troncature intelligente a 3800 chars + detection des blocs manques (total > lignes parsees) + safety final |
| R4 | OK | `onProgress` branche dans les deux closures via `sendProgressMessage(capturedChatId, capturedThreadId, msg)` |
| R5 | OK | `chatId` et `threadId` captures avant la closure, `sendProgressMessage` utilise `botInstance.api.sendMessage` |
| R6 | OK | Prefixe "ALERTE — " quand `failRate > BATCH_FAILURE_THRESHOLD` sur le chemin direct botInstance |
| R7 | OK | `export const BATCH_FAILURE_THRESHOLD = 0.5` |
| R8 | OK | Callback_data `jc_batch_retry:<jobId>` dans le bouton "Relancer les N echecs" |
| R9 | OK | Format `BATCH_COMPLETE:<ok>/<total>:failed=<id1>,<id2>\n\n<details>` dans les closures launchFn |
| R10 | OK | Handler `jc_batch_retry` dans jobs.ts relance un nouveau batch pour les taches echouees |
| R11 | OK | Keyboard batch contient bouton "Voir le backlog" en complement du bouton conditionnel |
| R12 | OK | `parseBatchResult()` exporte et utilisee par notification, keyboard, et handler retry |
| R13 | OK | Prefixe "ALERTE — " sur le chemin direct botInstance, pas via enqueue |
| R14 | OK | Garde `if (!originalJob)` avec `answerCallbackQuery` d'expiration dans handler retry |
| R15 | OK | Taches non executees collectees via `executedIds` set et ajoutees a `failedIds` |
| R16 | OK | `onProgress` envoie un seul message par appel, branche au niveau batch (pas phase interne) |

### Corrections adversariales integrees

| Finding | Statut | Resolution |
|---------|--------|------------|
| F-EC-1 (BLOQUANT) | Corrige | `parseBatchResult()` centralise le parsing, `sendJobCompletionNotification` utilise `batch.ok/batch.total` au lieu du parsing inline |
| F-DA-1 (MAJEUR) | Corrige | Prefixe "ALERTE — " sur le chemin direct botInstance + severite critique sur le fallback enqueue |
| F-EC-2 (MAJEUR) | Corrige | Garde `if (!originalJob)` avec `answerCallbackQuery` dans handler `jc_batch_retry` |
| F-EC-3 (MAJEUR) | Corrige | `onProgress` est un callback par tache terminee (pas par phase), rate-limit naturel |
| F-EC-4 (MAJEUR) | Corrige | Taches non executees detectees via `executedIds` set dans les closures launchFn |
| F-DA-2 (MAJEUR) | Corrige | Parseur notification reecrit avec `parseBatchResult()`, ne touche plus au champ `failed=` |
| F-SS-1 (MAJEUR) | Corrige | `parseBatchResult()` utilitaire partagee par les 3 consommateurs |
| F-EC-5 (MINEUR) | Corrige | Garde `if (batch.failedIds.length === 0)` dans handler retry |

## Phase 3 — Tester

Tests completes avec edge cases, scenarios d'erreur et robustesse :

- **parseBatchResult** : null/undefined input, format sans details, batch vide 0/0, details avec double newlines, single failed ID, IDs avec caracteres speciaux
- **Seuil d'escalade** : type validation (number, range 0-1)
- **Notification** : durees et PR URLs dans les lignes de detail, batch de 1 tache (reussi/echoue), result null, result non-BATCH_COMPLETE
- **Keyboard** : job ID dans callback_data, 1 seul echec, sous seuil, status failed
- **sendProgressMessage** : bot null, threadId present/absent, erreur Telegram catchee, multiple appels (rate limit)
- **Troncature** : resultat exactement 4000, type orchestrate reste a 500
- **Escalade** : 50% exact (pas ALERTE, seuil strictement superieur)

## Resultat bun test

```
 3307 pass
 5 skip
 1 fail (pre-existant: V10 corriger-les-defauts, bun path manquant)
 7575 expect() calls
Ran 3313 tests across 114 files. [31.84s]
```

Dont 51 tests dans `tests/generated/ameliorer-le-workflow-de-notification-et.test.ts` : **51 pass, 0 fail, 0 skip**

## Statut final

**DONE**

Les 3 defauts structurels identifies dans la spec sont corriges :
1. Notification tronquee → detail par tache avec troncature intelligente
2. Callback onProgress absent → branche dans les deux closures avec sendProgressMessage
3. Pas d'escalade → prefixe ALERTE + bouton Relancer + handler retry

Prochaine etape : conformance check puis review via `/dev-pipeline`.
