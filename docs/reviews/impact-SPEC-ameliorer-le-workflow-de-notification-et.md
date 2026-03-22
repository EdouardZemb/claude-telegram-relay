## Rapport d'impact : Ameliorer le workflow de notification et d'escalade des batch autopipeline

> Genere le 2026-03-22 a partir de docs/specs/SPEC-ameliorer-le-workflow-de-notification-et.md.

### Niveau de risque : MEDIUM

### Resume

Le changement est circonscrit a 3 fichiers sources et 2 fichiers de test. Il n'introduit aucun changement de signature d'API publique existante : les nouvelles exports (`BATCH_FAILURE_THRESHOLD`, `sendProgressMessage`) sont des ajouts purs. Le risque principal est une regression de la logique de troncature dans `launch()` (modification d'une branche conditionnelle qui affecte tous les types de jobs) et une regression des notifications existantes dans `sendJobCompletionNotification` (modification d'un switch existant). Le blast radius transitif est modere : 6 modules importent `job-manager`, mais aucun ne consomme les nouvelles exports.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/job-manager.ts` | Direct | Modifications substantielles : logique de troncature conditionnelle par type, enrichissement de `sendJobCompletionNotification` pour `autopipeline-batch`, ajout escalade critique, enrichissement `getCompletionKeyboard`, export de `BATCH_FAILURE_THRESHOLD` et `sendProgressMessage` |
| `src/commands/planning.ts` | Direct | Branchement du callback `onProgress` dans les deux closures `launchFn` (lignes ~551 et ~625), encodage des failed IDs dans le format de retour, capture de `chatId`/`messageThreadId` avant closure |
| `src/commands/jobs.ts` | Direct | Ajout du handler callback `jc_batch_retry:<jobId>` dans le bloc `jc_` existant |
| `src/notification-queue.ts` | Indirect | Consomme le chemin `enqueue({ severity: "critical" })` deja existant — aucune modification requise, mais le chemin critique est emprunte plus frequemment |
| `src/auto-pipeline.ts` | Indirect | `runBatchPipeline` et `formatPipelineResult` sont consommes sans modification ; `PipelineResult` doit exposer `task.id` pour l'encodage des failed IDs — a verifier |
| `src/relay.ts` | Indirect | Importe `initJobManager` — non impacte, mais charge `job-manager` au demarrage |
| `src/commands/execution.ts` | Indirect | Importe `launch` depuis `job-manager` — non impacte fonctionnellement |
| `src/commands/utilities.ts` | Indirect | Importe `launch` depuis `job-manager` — non impacte fonctionnellement |
| `src/commands/exploration.ts` | Indirect | Importe `launch` depuis `job-manager` — non impacte fonctionnellement |
| `tests/unit/job-manager.test.ts` | Direct | Le test "truncates result to 500 chars" (ligne 84) echouera apres la modification — il devra etre mis a jour. Les tests `getCompletionKeyboard` pour `autopipeline-batch` (absent actuellement) devront etre ajoutes |
| `tests/unit/auto-pipeline.test.ts` | Direct | Ajout de tests pour le format `BATCH_COMPLETE:<ok>/<total>:failed=<ids>` — aucun test existant ne couvre ce format |
| `tests/generated/reviser-prd-to-deploy-workflow.test.ts` | Indirect | Importe `getCompletionKeyboard` et le teste pour `prd-preflight` — non impacte si la signature reste stable (ajout de comportement conditionnel uniquement) |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/job-manager.ts` | `getCompletionKeyboard` | Modification (comportement conditionnel pour `autopipeline-batch`) | Oui — signature inchangee, comportement etendu |
| `src/job-manager.ts` | `BATCH_FAILURE_THRESHOLD` | Ajout (export de constante) | Oui |
| `src/job-manager.ts` | `sendProgressMessage` | Ajout (export de fonction helper) | Oui |
| `src/job-manager.ts` | Logique de troncature dans `launch()` | Modification (branche conditionnelle par type) | Oui pour les types existants — risque de regression si la condition est mal libelle |
| `src/job-manager.ts` | `sendJobCompletionNotification` | Modification (branche `autopipeline-batch` enrichie, fallback `enqueue` avec `severity` conditionnelle) | Oui — les autres types non modifies |

### Breaking changes potentiels

- [ ] **Regression test troncature 500 chars** — Le test `"truncates result to 500 chars"` dans `tests/unit/job-manager.test.ts` (l.84-92) lance un job de type `"test"`, qui passera dans la branche generale (limite 500). Si l'implementeur conditionne sur `type === "autopipeline-batch"` uniquement, ce test continuera de passer. En revanche, si la condition est elargie par erreur, tous les types auront une limite de 4000 et ce test cassera — **impact** : `tests/unit/job-manager.test.ts`

- [ ] **Regression getCompletionKeyboard pour autopipeline-batch echoue** — La fonction retourne actuellement `undefined` pour les jobs `status === "failed"` (toutes branches confondues). Si l'ajout du bouton "Relancer les echecs" bypass cette garde, les jobs batch echoues afficheront incorrectement un keyboard — **impact** : `src/job-manager.ts`, `tests/unit/job-manager.test.ts`

- [ ] **Format BATCH_COMPLETE parse fragile** — La notification enrichie et le keyboard conditionnel parsent `job.result` avec `startsWith("BATCH_COMPLETE:")` et decodent `failed=<ids>`. Si la closure `launchFn` dans `planning.ts` produit un format legerement different (ex: espace apres `:`, IDs complets au lieu de 8 chars), le parsing echouera silencieusement et le bouton "Relancer les echecs" n'apparaitra pas — **impact** : `src/job-manager.ts`, `src/commands/planning.ts`

- [ ] **Acces a `task.id` dans PipelineResult** — Le format `failed=<id1>,<id2>` necessite que la closure de `planning.ts` accede a `result.task.id` pour chaque echec. L'interface `PipelineResult` expose `task` (type `Task`) qui contient `id`. Aucune modification d'interface requise, mais ce champ doit etre present dans tous les resultats de `runBatchPipeline`, y compris les cas d'erreur (`Promise.allSettled` line 360 de `auto-pipeline.ts`) — le cas d'erreur reconstruit un objet `task: tasks[i]` qui preserve `id` : pas de breaking change, mais a verifier en test — **impact** : `src/commands/planning.ts`

- [ ] **`botInstance` non expose dans `planning.ts`** — Le `onProgress` doit appeler `botInstance.api.sendMessage`. `botInstance` est une variable de module privee dans `job-manager.ts`. La spec prevoit d'exporter `sendProgressMessage(chatId, threadId, message)` comme helper — si cet export est oublie ou mal nomme, `planning.ts` ne pourra pas envoyer les messages de progression sans importer directement l'instance bot — **impact** : `src/job-manager.ts`, `src/commands/planning.ts`

- [ ] **Callback `jc_batch_retry` : resolution des taches echouees par ID court** — Le format stocke les 8 premiers caracteres de l'UUID (`task.id.substring(0, 8)`). Le handler `jc_batch_retry` devra retrouver les taches completes depuis Supabase avec un `.ilike("id", "<shortId>%")` (pattern deja utilise pour `jc_done`). Si deux taches ont un UUID avec les 8 premiers caracteres identiques (tres improbable), la relance chargerait une mauvaise tache — **impact** : `src/commands/jobs.ts`

### Points d'attention pour le Reviewer

1. **Conditionnalite de la troncature dans `launch()`** : verifier que la modification de `job-manager.ts` l.155-156 conditionne strictement sur `type === "autopipeline-batch"` et non sur un pattern plus large. Le test existant "truncates result to 500 chars" doit continuer de passer sans modification. Fichier : `src/job-manager.ts` l.154-156.

2. **Parsing du format `BATCH_COMPLETE` en deux endroits distincts** : `sendJobCompletionNotification` et `getCompletionKeyboard` parsent tous deux `job.result` avec ce format. S'assurer que le format produit par `planning.ts` et le format attendu dans `job-manager.ts` sont strictement identiques (meme separateur, meme position du champ `failed=`, meme longueur des IDs). Un test de round-trip (encode dans planning, decode dans job-manager) est necessaire. Fichiers : `src/commands/planning.ts` l.551-556 et l.625-629, `src/job-manager.ts` blocs `autopipeline-batch`.

3. **Guard `status === "failed"` dans `getCompletionKeyboard`** : la fonction retourne `undefined` pour tous les jobs echoues (ligne 193). Le bouton "Relancer les echecs" doit n'apparaitre que pour les jobs `completed` dont le resultat contient des echecs partiels (taux > seuil). Verifier que la condition est dans la branche `case "autopipeline-batch"` apres la garde initiale, et non avant. Fichier : `src/job-manager.ts` l.192-194.

4. **Fallback `enqueue` avec `severity: "critical"`** : le chemin de fallback (quand `botInstance` est null ou que l'envoi direct echoue) doit aussi appliquer la severite conditionnelle. Actuellement le fallback utilise `severity: "normal"` (l.317). Si le batch a un taux d'echec critique et que le bot echoue a envoyer directement, la notification critique est degradee silencieusement en normale — a corriger ou a documenter comme limitation connue. Fichier : `src/job-manager.ts` l.315-321.

5. **Concurrence et ordre des messages `onProgress`** : le `onProgress` est appele depuis la closure async fire-and-forget. Les erreurs d'envoi doivent etre attrapees sans relancer (`try/catch` silencieux avec `log.error`). Verifier que l'implementation dans `planning.ts` wrap l'appel a `sendProgressMessage` dans un try/catch et ne propage pas les erreurs Telegram qui casseraient le pipeline. Contrainte specifiee en R13/section 7 de la spec. Fichier : `src/commands/planning.ts` closures launchFn.

### Blast radius

- Modules directement modifies : 3 (`src/job-manager.ts`, `src/commands/planning.ts`, `src/commands/jobs.ts`)
- Modules indirectement impactes : 4 (`src/notification-queue.ts`, `src/auto-pipeline.ts`, `src/relay.ts` — chargement, `tests/generated/reviser-prd-to-deploy-workflow.test.ts`)
- Fichiers source modifies : 3
- Fichiers de test a verifier : 3 (`tests/unit/job-manager.test.ts` — 1 test existant a mettre a jour + nouveaux, `tests/unit/auto-pipeline.test.ts` — nouveaux tests, `tests/unit/batch-parallel.test.ts` — pas de modification requise mais pertinent pour contexte)
