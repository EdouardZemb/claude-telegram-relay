---
phase: 0-explore
generated_at: "2026-03-22T12:00:00+01:00"
subject: "Améliorer le workflow de notification et d'escalade des batch autopipeline"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

Le batch autopipeline du PRD `c1626df9` s'est terminé avec un résultat 2/6 tâches réussies, mais l'utilisateur n'a reçu aucun détail sur les échecs ni proposition corrective. Ce cas révèle trois défauts structurels dans la chaîne de notification batch :

**1. Notification tronquée (job-manager.ts ligne 291)** : la fonction `sendJobCompletionNotification` extrait uniquement la première ligne du résultat batch via `.split("\n")[0]`. Le format retourné par `planning.ts` est `BATCH_COMPLETE:2/6\n\n[détails de chaque tâche]`. Les détails — contenant succès/échec par tâche, raison courte, durée, PR URL — sont intégralement jetés. De plus, le résultat est tronqué à 500 caractères lors du stockage dans `job.result` (ligne 156), ce qui détruit les données avant même la notification.

**2. Callback `onProgress` vide (planning.ts lignes 552 et 626)** : les deux points de lancement `prdwf_launch` et `prdwf_proto_launch` utilisent `runBatchPipeline(bctx.supabase!, tasks, { autoPipeline: true })` sans passer de `onProgress`. Dans `auto-pipeline.ts`, le `runBatchPipeline` appelle `options.onProgress` à chaque tâche démarrée, mais ici ce callback est absent (non fourni = no-op). Les notifications de progression en temps réel ne sont donc jamais émises.

**3. Pas d'escalade pour les échecs partiels** : le batch 2/6 est notifié avec un message de tonalité neutre (`Implementation batch terminée`) et une sévérité `normal`. Il n'existe aucune logique de calcul du taux d'échec, aucun seuil d'alerte (ex : >50% d'échecs), aucun bouton d'action proposant de relancer les échecs, et aucun retry automatique avant déclaration d'échec final.

Une exploration est nécessaire avant spécification car trois composants sont impliqués (`job-manager.ts`, `commands/planning.ts`, `auto-pipeline.ts`), les changements affectent l'UX Telegram (messages, boutons inline), et il faut évaluer où placer la logique de retry (dans le batch, dans le job manager, ou dans les deux).

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://docs.celeryq.dev/en/stable/userguide/monitoring.html (2026-03-22) | Documentation officielle | 2026-03-22 | Celery distingue task-failed / task-retried / task-rejected avec handlers d'événements. La `State` in-memory permet le suivi individuel. Escalade par comptage de failures dans une fenêtre temporelle. | Haute |
| 2 | https://bullmq.io/ (2026-03-22) | Documentation officielle | 2026-03-22 | BullMQ implémente retry avec backoff exponentiel (attempts + delay), dead letter queues, et event listeners `queueEvents.on("failed")`. Progress tracking via `job.updateProgress()`. | Haute |
| 3 | https://martinfowler.com/articles/patterns-of-distributed-systems/index.html (2026-03-22) | Article technique | 2026-03-22 | Patterns HeartBeat, State Watch, Request Waiting List pour coordination en cas de défaillance partielle. | Moyenne |
| 4 | https://core.telegram.org/bots/api#sendmessage (2026-03-22) | Documentation API | 2026-03-22 | Inline keyboards avec callback_data pour boutons Retry / Voir détails / Ignorer. Limite 4096 chars par message. | Haute |

**Synthèse des enseignements :**

**Pattern 1 — Séparation stockage/affichage** : Celery et BullMQ stockent le résultat complet en base de données (ou en mémoire) et n'envoient qu'un résumé dans la notification. La notification contient un lien/ID pour accéder au détail complet. C'est le pattern inverse de l'implémentation actuelle qui tronque à 500 chars dès le stockage.

**Pattern 2 — Progress callbacks obligatoires** : BullMQ expose `job.updateProgress()` qui émet un événement traité par les listeners. Le principe est que chaque changement d'état significatif déclenche une notification immédiate. Le pattern existant dans `auto-pipeline.ts` (paramètre `onProgress`) est architecturalement correct, mais non branché dans `planning.ts`.

**Pattern 3 — Seuil d'escalade et dead letter** : BullMQ utilise `attempts: N` avec backoff avant de basculer en "dead letter". Celery distingue retry automatique (transparent) et échec final (alerte). Un seuil à 50% d'échecs est une heuristique standard pour déclencher une alerte de sévérité élevée vs simple notification.

**Pattern 4 — Actions contextuelles inline** : L'API Telegram permet des boutons inline avec `callback_data`. Le pattern recommandé est : boutons d'action présents dans la notification d'échec elle-même (pas dans un message séparé), libellés précis ("Relancer les 4 échecs", pas juste "Retry").

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/job-manager.ts` (l.155-156) | `job.result` tronqué à 500 chars lors du stockage. Toute donnée au-delà est irrémédiablement perdue. | Haut — nécessite refactoring stockage |
| 2 | `src/job-manager.ts` (l.290-292) | `sendJobCompletionNotification` : extrait seulement `.split("\n")[0]` pour `autopipeline-batch`. Corrigible localement. | Haut — bug direct |
| 3 | `src/job-manager.ts` (l.212-215) | `getCompletionKeyboard` pour `autopipeline-batch` : uniquement "Voir le backlog". Pas de bouton "Relancer les échecs" conditionnel. | Moyen — extension simple |
| 4 | `src/commands/planning.ts` (l.551-555) | `prdwf_launch` : `runBatchPipeline(..., { autoPipeline: true })` sans `onProgress`. | Haut — no-op callback |
| 5 | `src/commands/planning.ts` (l.623-629) | `prdwf_proto_launch` (même pattern) : même absence de `onProgress`. | Haut — no-op callback |
| 6 | `src/commands/planning.ts` (l.555) | Format de retour `BATCH_COMPLETE:${ok}/${results.length}\n\n${lines.join(...)}` : les lignes de détail sont construites mais aussitôt perdues par la troncature. | Moyen — la donnée existe mais est détruite |
| 7 | `src/auto-pipeline.ts` (l.305-335) | `runBatchPipeline` appelle `options.onProgress` à chaque tâche (ligne 322 et 328). Interface déjà en place, non utilisée. | Actif réutilisable |
| 8 | `src/auto-pipeline.ts` (l.374-408) | `formatPipelineResult(result)` : format multi-ligne avec statut, phase, durée, PR URL, raison de blocage. Données complètes disponibles. | Actif réutilisable |
| 9 | `src/notification-queue.ts` (l.248) | `enqueue` avec `severity: "critical"` bypass quiet hours et envoie immédiatement. Infrastructure d'escalade existante. | Actif réutilisable |
| 10 | `src/commands/jobs.ts` (l.128-145) | Callback `jc_backlog` existant et fonctionnel. Pattern de callback inline documenté et testé. | Actif réutilisable |
| 11 | `src/commands/jobs.ts` (l.80-200) | Handler `callback_query` avec switch sur préfixes `job_` et `jc_`. Extension par nouveau préfixe `jc_batch_retry:` est triviale. | Actif réutilisable |
| 12 | `tests/unit/job-manager.test.ts` | Tests existants couvrent `launch`, `list`, `cancel`, `getCompletionKeyboard`. Pas de tests sur le format de notification `autopipeline-batch`. | Gap test identifié |

**Points de friction :**

- La troncature à 500 chars dans `job.result` est une limite de design historique (persistence JSON légère). Pour stocker les résultats batch complets, il faudrait soit augmenter la limite, soit stocker séparément (Supabase ou fichier).
- Brancher `onProgress` dans `planning.ts` requiert d'avoir accès au `bot` ou à un canal de notification dans la closure. Dans `planning.ts`, on a accès à `ctx` (le contexte Grammy) ce qui permet d'appeler `ctx.reply()` depuis la closure — mais la closure tourne en background, le `ctx` Telegram est périmé après quelques secondes. Il faudra utiliser `botInstance` directement (disponible dans `job-manager.ts`) ou le `chatId`/`threadId` capturés avant le lancement.
- Le retry de tâches individuelles nécessite de stocker les IDs des tâches échouées dans le résultat du job (ex: `BATCH_COMPLETE:2/6:failed_ids=abc,def`) pour que le callback de relance puisse les récupérer.

**Actifs réutilisables :**

- `onProgress` dans `runBatchPipeline` est déjà en place — il suffit de le brancher.
- Le pattern d'escalade via `enqueue({ severity: "critical" })` existe déjà dans `notification-queue.ts`.
- Le pattern de callbacks inline `jc_*` dans `jobs.ts` est extensible sans refactoring majeur.
- `formatPipelineResult()` dans `auto-pipeline.ts` produit déjà les données nécessaires par tâche.

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Patch minimal | C: Refactoring enrichi | D: Refactoring complet avec retry |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexité** | S | S | M | L |
| **Valeur ajoutée** | Low | Med | High | High |
| **Risque technique** | Low | Low | Low | Med |
| *Impact maintenance* | Négatif (bug connu) | Neutre | Positif | Positif |
| *Réversibilité* | N/A | Haute | Haute | Moyenne |

**Option A — Status quo** : Conserver le comportement actuel. Les utilisateurs ne voient pas le détail des échecs. Pas de retour sur 4/6 tâches échouées. Inacceptable pour un système de production visant l'autonomie.

**Option B — Patch minimal** : Corriger uniquement les deux bugs ponctuels — (1) enlever le `.split("\n")[0]` dans `sendJobCompletionNotification` et (2) augmenter la limite de troncature de 500 à 4000 chars pour les résultats `autopipeline-batch`. Aucune escalade, aucun onProgress, aucun retry. Risque faible, livrable rapide, mais laisse deux des quatre problèmes non résolus.

**Option C — Refactoring enrichi (recommandée)** : Corriger les trois bugs et ajouter l'escalade. (1) Corriger la notification tronquée en recomposant un message lisible depuis le résultat batch complet. (2) Brancher `onProgress` dans `planning.ts` en utilisant le `botInstance` et les IDs capturés avant la closure async. (3) Ajouter une logique de seuil d'escalade (>50% échecs = sévérité critique + bouton "Relancer les échecs"). Complexité M, valeur ajoutée High, risque Low car toutes les briques existent. C'est l'option qui résout les 3 problèmes racines sans sur-ingénierie.

**Option D — Refactoring complet avec retry automatique** : Idem option C + retry automatique des tâches échouées avant déclaration d'échec final. Nécessite de modifier `runBatchPipeline` pour accepter `maxRetries` par tâche (déjà prévu dans `PipelineOptions.maxRetries` mais non utilisé en batch), stocker les IDs des tâches échouées dans le résultat, et ajouter un callback `jc_batch_retry:<jobId>` dans `jobs.ts`. Complexité L due au stockage des failed IDs et à la logique de relance partielle. La valeur ajoutée marginale vs C est faible pour un premier itération — mieux vaut itérer depuis C.

## Section 5 — Verdict et justification

**Verdict : GO — Option C (Refactoring enrichi)**

L'état de l'art (Celery, BullMQ) confirme que les trois patterns manquants — progress callbacks, seuil d'escalade, et notification avec actions contextuelles — sont des patterns standards bien établis, pas des innovations risquées. L'archéologie codebase révèle que toutes les briques nécessaires sont déjà en place : `onProgress` dans `runBatchPipeline` (axe 2, point 7), `enqueue({ severity: "critical" })` pour l'escalade (point 9), le pattern `jc_*` pour les nouveaux boutons (point 11), et `formatPipelineResult()` pour les données détaillées (point 8). L'effort est donc principalement de branchage, pas de création ex nihilo.

Le seul risque identifié est la troncature à 500 chars : le résultat complet d'un batch de 6 tâches via `formatPipelineResult` peut facilement dépasser 3000 chars. La solution est d'augmenter la limite de troncature spécifiquement pour les types batch (ou de ne stocker que le résumé en `job.result` et les détails en mémoire/cache séparé). Une limite à 4000 chars couvre les cas courants sans refactoring de la persistence JSON.

Le callback `onProgress` dans `planning.ts` nécessite d'utiliser `botInstance` directement (le contexte Grammy `ctx` est périmé après la réponse initiale). Ce pattern est déjà utilisé dans `sendJobCompletionNotification` (ligne 301) — il est safe et documenté.

L'option D (retry automatique) est clairement une amélioration de valeur, mais elle est mieux positionnée comme une itération S+1 une fois que C est stable et validé en production.

## Section 6 — Input pour étape suivante

**Option recommandée** : C — Refactoring enrichi (3 problèmes racines + escalade)

**Fichiers concernés** :
- `src/job-manager.ts` — corrections notification + escalade + keyboard conditionnel
- `src/commands/planning.ts` — branchage `onProgress` dans les deux closures `launchFn`
- `src/auto-pipeline.ts` — ajout d'un format de résultat batch enrichi (optionnel : inclure `failedTaskIds` dans le résultat)
- `src/commands/jobs.ts` — nouveau callback `jc_batch_retry:<jobId>` (si retry manuel)
- `tests/unit/job-manager.test.ts` — tests pour notification `autopipeline-batch` avec détails

**Contraintes identifiées** :
- La troncature `job.result` à 500 chars doit être augmentée à 4000 pour `autopipeline-batch` uniquement (ou conditionnellement pour tous les types batch)
- Le `onProgress` dans `planning.ts` doit utiliser `botInstance.api.sendMessage(cId, msg, { message_thread_id: tId })` — pas `ctx.reply()` (contexte périmé)
- Le seuil d'escalade à 50% doit être configurable (éviter le hardcode)
- Le message de notification batch doit rester sous 4096 chars (limite Telegram) — tronquer à la tâche N si nécessaire avec "... +K autres"
- Le bouton "Relancer les échecs" nécessite de stocker les failed IDs dans le résultat — format suggéré : `BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\n[détails]`

**Questions ouvertes pour la spec** :
1. Doit-on stocker le résultat batch complet en Supabase (`pipeline_runs` table) pour y accéder via `/jobs <id>` sans limitation de taille ?
2. La notification de progression en temps réel (`onProgress`) doit-elle éditer un seul message (via `editMessageText`) ou envoyer de nouveaux messages ? Éditer est moins spam mais requiert de stocker le `message_id` initial.
3. Le seuil de 50% est-il le bon seuil ? Faut-il distinguer "tâches bloquées par gate" (attendu) vs "tâches échouées à l'exécution" (problème) ?
4. Faut-il implémenter le retry automatique (Option D) en S+1 ou directement dans cette spec ?
