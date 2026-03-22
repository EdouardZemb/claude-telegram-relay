# Spec : Ameliorer le workflow de notification et d'escalade des batch autopipeline

> Genere le 2026-03-22. Source : demande utilisateur, exploration EXPLORE-ameliorer-le-workflow-de-notification-et.md, codebase (job-manager.ts, planning.ts, auto-pipeline.ts, jobs.ts, notification-queue.ts).

## 1. Objectif

Corriger les trois defauts structurels de la chaine de notification batch autopipeline (notification tronquee, callback onProgress absent, pas d'escalade) afin que l'utilisateur recoive le detail complet des resultats par tache, un suivi en temps reel de la progression, et une alerte avec actions correctives quand le taux d'echec depasse un seuil configurable.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | La notification batch doit afficher le statut individuel de chaque tache (succes/echec + phase + raison courte) | Demande utilisateur (point 1) + exploration section 1 | "1. OK — Ajouter le logger (done, 45s, PR #42)\n2. ECHEC — Refactorer le cache (execution, agent crashed)" |
| R2 | Le resultat stocke dans `job.result` ne doit pas etre tronque a 500 chars pour les jobs de type `autopipeline-batch` — limite portee a 4000 chars | Exploration section 5 (contrainte troncature) | Un batch de 6 taches produit environ 2000-3000 chars de details |
| R3 | Le message Telegram de notification batch doit rester sous 4096 chars (limite API Telegram) — si le detail depasse, tronquer a la tache N avec "... +K autres" | Exploration section 2 (source 4, API Telegram) | "... +3 autres taches. Utilise /jobs <id> pour le detail complet" |
| R4 | Le callback `onProgress` doit etre branche dans les deux closures `launchFn` de planning.ts (`prdwf_launch` et `prdwf_preflight_ok`) | Demande utilisateur (point 2) + exploration section 3 (points 4-5) | A chaque tache demarre/terminee, un message est envoye dans le chat d'origine |
| R5 | Le `onProgress` doit utiliser `botInstance.api.sendMessage(chatId, msg, { message_thread_id })` et non `ctx.reply()` car le contexte Grammy est perime dans la closure async | Exploration section 5 (contrainte ctx perime) | Pattern deja utilise dans `sendJobCompletionNotification` (job-manager.ts l.301) |
| R6 | Si le taux d'echec du batch depasse le seuil (defaut: 50%), la notification est envoyee avec severite "critical" et inclut un bouton "Relancer les echecs" | Demande utilisateur (point 3) + exploration section 4 (option C) | Batch 2/6 = 67% echec > 50% seuil → alerte critique |
| R7 | Le seuil d'escalade doit etre configurable via une constante exportee (pas de hardcode dans le corps de la fonction) | Exploration section 5 (contrainte seuil configurable) | `const BATCH_FAILURE_THRESHOLD = 0.5` |
| R8 | Le bouton "Relancer les echecs" stocke les IDs des taches echouees dans le callback_data sous la forme `jc_batch_retry:<jobId>` | Exploration section 3 (point 11) + section 5 | callback_data = `jc_batch_retry:abc12345` |
| R9 | Le resultat batch encode les IDs des taches echouees dans le format `BATCH_COMPLETE:<ok>/<total>:failed=<id1>,<id2>\n\n[details]` pour permettre la relance | Exploration section 5 (format suggere) | `BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\nPIPELINE OK...` |
| R10 | Le handler `jc_batch_retry` recupere les failed IDs depuis le resultat du job original et relance un nouveau batch pipeline uniquement pour ces taches | Demande utilisateur (point 3, bouton "Relancer les echecs") | Clic sur "Relancer les 4 echecs" → nouveau job `autopipeline-batch` pour les 4 taches |
| R11 | Le bouton "Voir le backlog" est conserve dans le keyboard batch, en complement du bouton conditionnel "Relancer les N echecs" | Exploration section 3 (point 3) | Keyboard: ["Relancer les 4 echecs", "Voir le backlog"] |
| R12 | Une fonction utilitaire partagee `parseBatchResult(result)` parse le format `BATCH_COMPLETE:` et retourne `{ ok, total, failedIds, details }`. Les 3 consommateurs (notification, keyboard, retry handler) utilisent cette fonction unique — aucun parsing inline du format | Challenge F-EC-1, F-DA-2, F-SS-1 | `parseBatchResult("BATCH_COMPLETE:2/6:failed=abc,def\n\ndetails")` → `{ ok: 2, total: 6, failedIds: ["abc", "def"], details: "details" }` |
| R13 | Sur le chemin direct botInstance, quand le taux d'echec depasse le seuil, le message est prefixe par "ALERTE — " pour differencier visuellement la notification critique. Le mecanisme `enqueue` n'est pas utilise sur ce chemin | Challenge F-DA-1 | Batch 1/4 → message = "ALERTE — Implementation batch terminee (...)" |
| R14 | Le handler `jc_batch_retry` verifie que le job original existe toujours. Si le job a ete nettoye (> 24h), repondre avec `answerCallbackQuery` expliquant que le batch a expire | Challenge F-EC-2 | Clic sur bouton 25h apres → "Ce batch a expire. Relance depuis /backlog." |
| R15 | Les taches non executees (arret anticipe en mode sequentiel) sont incluses dans les failed IDs au meme titre que les taches explicitement echouees | Challenge F-EC-4 | Batch sequentiel 5 taches, tache 3 bloquee → failed IDs = [id3, id4, id5] |
| R16 | En mode parallele, le `onProgress` est envoye uniquement a la fin de chaque tache (pas a chaque phase interne) pour eviter le flood Telegram (limite 30 msg/min) | Challenge F-EC-3 | Batch 10 taches, maxConcurrency 3 → max 10 messages de progression |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `PipelineResult[]` (retour de `runBatchPipeline`) | Array d'objets | Retour de fonction (`auto-pipeline.ts`) | `success`, `phase`, `task.id`, `task.title`, `durationMs`, `message`, `prUrl`, `blocked.reason` |
| `Job` (registre job-manager) | Objet en memoire | `registry.get(id)` | `id`, `type`, `status`, `chatId`, `messageThreadId`, `result`, `error` |
| `botInstance` (singleton job-manager) | Bot Grammy | Variable module | `api.sendMessage(chatId, text, opts)` |
| `chatId` + `messageThreadId` (captures dans planning.ts) | number | Captures avant la closure async via `ctx.chat.id` et `ctx.message?.message_thread_id` | `chatId`, `threadId` |

## 4. Donnees de sortie

### 4.1 Notification batch enrichie (message Telegram)

Structure :
```
Implementation batch terminee (<duree>)
Resultat : <ok>/<total> taches reussies

1. OK — <titre> (done, <duree>s, PR #<n>)
2. ECHEC — <titre> (execution, <raison courte>)
3. OK — <titre> (done, <duree>s)
...
```

Regles de remplissage :
- Chaque ligne suit le format de `formatPipelineResult` simplifie en une ligne (R1)
- Si le message depasse 3800 chars, tronquer a la tache N et ajouter "... +K autres. /jobs <id> pour les details" (R3)

### 4.2 Format de resultat `job.result` enrichi

Structure : `BATCH_COMPLETE:<ok>/<total>:failed=<id1>,<id2>\n\n<details>` (R9)

Regles de remplissage :
- `<ok>` et `<total>` : compteurs de succes et total
- `failed=` : liste CSV des 8 premiers caracteres des IDs des taches echouees (vide si aucun echec)
- `<details>` : `formatPipelineResult` pour chaque tache, separe par `\n\n---\n\n`
- Tronque a 4000 chars au lieu de 500 (R2)

### 4.3 Keyboard inline conditionnel

- Si taux d'echec > seuil (R6) : bouton "Relancer les N echecs" (`jc_batch_retry:<jobId>`) + bouton "Voir le backlog" (`jc_backlog`)
- Sinon : bouton "Voir le backlog" uniquement (comportement actuel)

### 4.4 Messages de progression (onProgress)

Format : `Batch [<i>/<total>] : <titre> — <statut>` envoye via `botInstance.api.sendMessage` (R4, R5)

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/job-manager.ts` | modifier | R1: enrichir `sendJobCompletionNotification` pour le type `autopipeline-batch` — afficher le detail par tache au lieu de la premiere ligne. R2: augmenter la limite de troncature a 4000 pour `autopipeline-batch`. R6: ajouter logique d'escalade (severite critique si taux echec > seuil). R7: exporter la constante seuil. R11: enrichir `getCompletionKeyboard` avec bouton conditionnel "Relancer les echecs". R12: ajouter `parseBatchResult()` et `BatchResult` interface, utilises par notification + keyboard. R13: prefixer "ALERTE — " sur le chemin direct botInstance quand taux echec > seuil |
| `src/commands/planning.ts` | modifier | R4: brancher `onProgress` dans les deux closures `launchFn` (lignes ~551 et ~625). R5: capturer `chatId` et `messageThreadId` avant la closure, utiliser `botInstance` importable ou une fonction helper. R9: encoder les failed IDs dans le format de retour. R15: inclure les taches non executees (arret anticipe sequentiel) dans les failed IDs. R16: limiter onProgress a un message par tache terminee |
| `src/commands/jobs.ts` | modifier | R8/R10: ajouter le handler callback `jc_batch_retry:<jobId>` qui relit les failed IDs du job original et relance un batch pour ces taches. R12: utiliser `parseBatchResult()` pour le parsing. R14: ajouter garde pour job expire (> 24h) avec `answerCallbackQuery` |
| `tests/unit/job-manager.test.ts` | modifier | Ajouter tests pour : notification batch enrichie (R1), troncature 4000 (R2), troncature Telegram (R3), escalade critique (R6), keyboard conditionnel (R8/R11) |
| `tests/unit/auto-pipeline.test.ts` | modifier | Ajouter tests pour le format de resultat batch avec failed IDs (R9) |

## 6. Patterns existants

### 6.1 Notification directe via botInstance (job-manager.ts l.301-308)

Le pattern d'envoi de notification directe est deja en place dans `sendJobCompletionNotification`. Il utilise `botInstance.api.sendMessage(job.chatId, message, opts)` avec `message_thread_id` optionnel. Ce meme pattern sera reutilise pour le `onProgress` dans planning.ts.

```typescript
// src/job-manager.ts l.301-308
if (botInstance && job.chatId) {
  try {
    const opts: Record<string, unknown> = {};
    if (job.messageThreadId) opts.message_thread_id = job.messageThreadId;
    const keyboard = getCompletionKeyboard(job);
    if (keyboard) opts.reply_markup = keyboard;
    await botInstance.api.sendMessage(job.chatId, message, opts);
```

### 6.2 Callback inline jc_* (jobs.ts l.102-145)

Le pattern d'extension des callbacks de completion est documente : le handler verifie `data.startsWith("jc_")`, decoupe sur `:`, et dispatch par action. Ajouter `jc_batch_retry` est trivial.

```typescript
// src/commands/jobs.ts l.102-108
if (!data.startsWith("jc_")) {
  await next();
  return;
}
const [action, param] = data.split(":");
```

### 6.3 Escalade via severite critique (notification-queue.ts l.248)

L'infrastructure d'escalade existe deja : `enqueue({ severity: "critical" })` bypass les quiet hours et envoie immediatement. Ce pattern sera utilise pour les echecs batch > seuil.

```typescript
// src/notification-queue.ts l.248
if (item.severity === "critical" || isImmediate(item.type)) {
  await sendStandalone(fullItem);
  return;
}
```

### 6.4 formatPipelineResult (auto-pipeline.ts l.374-408)

La fonction `formatPipelineResult` produit deja un format multi-ligne riche avec statut, phase, duree, PR URL, raison de blocage. Ce format sera reutilise pour les details par tache dans la notification enrichie, et condense en une ligne pour le message Telegram.

### 6.5 onProgress dans runBatchPipeline (auto-pipeline.ts l.321-328)

Le callback `onProgress` est deja appele a chaque tache dans `runBatchPipeline` (mode sequentiel et parallele). Il suffit de le passer depuis planning.ts au lieu de l'omettre.

```typescript
// src/auto-pipeline.ts l.321-322 (mode sequentiel)
if (options.onProgress) {
  await options.onProgress(`\nBatch: ${results.length + 1}/${tasks.length} — ${task.title}`);
}
```

### 6.6 Parseur partage parseBatchResult (nouveau, job-manager.ts)

Fonction utilitaire exportee qui centralise le parsing du format `BATCH_COMPLETE:`. Utilisee par `sendJobCompletionNotification`, `getCompletionKeyboard`, et le handler `jc_batch_retry` dans jobs.ts.

```typescript
export interface BatchResult {
  ok: number;
  total: number;
  failedIds: string[];
  details: string;
}

export function parseBatchResult(result: string): BatchResult | null {
  if (!result?.startsWith("BATCH_COMPLETE:")) return null;
  const afterPrefix = result.replace("BATCH_COMPLETE:", "");
  const [header, ...rest] = afterPrefix.split("\n\n");
  const [counts, failedPart] = header.split(":failed=");
  const [ok, total] = counts.split("/").map(Number);
  const failedIds = failedPart?.split(",").filter(Boolean) ?? [];
  return { ok, total, failedIds, details: rest.join("\n\n") };
}
```

### 6.7 Troncature conditionnelle par type (job-manager.ts l.154-156)

Actuellement la troncature est uniforme a 500 chars. Le changement consiste a conditionner la limite par type de job :

```typescript
// src/job-manager.ts l.155-156 (actuel)
job.result = typeof result === "string"
  ? result.substring(0, 500) : String(result).substring(0, 500);
```

## 7. Contraintes

- **Ne pas casser les notifications existantes** : les types `exec`, `orchestrate`, `autopipeline`, `prd`, `prd-decompose`, `prd-preflight`, `explore` conservent leur comportement actuel intact
- **Limite Telegram 4096 chars** : le message de notification batch enrichi doit etre tronque intelligemment a ~3800 chars pour laisser de la marge (R3)
- **Contexte Grammy perime** : dans les closures async de planning.ts, ne jamais utiliser `ctx.reply()` — utiliser `botInstance.api.sendMessage()` avec chatId/threadId captures avant la closure (R5)
- **Pas de retry automatique dans cette iteration** : le retry se fait manuellement via le bouton "Relancer les echecs". Le retry automatique (option D de l'exploration) est reporte a une iteration ulterieure
- **Callback_data Telegram limite a 64 bytes** : le format `jc_batch_retry:<jobId>` avec un jobId de 8 chars = 22 chars, largement dans la limite
- **Concurrence** : le `onProgress` est appele depuis un contexte async fire-and-forget — les erreurs d'envoi de message Telegram doivent etre catchees silencieusement (log.error sans throw)
- **Persistence JSON** : augmenter la limite de `job.result` a 4000 chars augmente la taille du fichier `jobs.json` — acceptable car le cleanup supprime les jobs > 24h
- **Dependance sur `botInstance`** : le `onProgress` dans planning.ts necessite l'acces a `botInstance` qui est un singleton dans job-manager.ts — exporter une fonction helper `sendProgressMessage(chatId, threadId, message)` pour eviter d'exposer l'instance directement

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | La notification batch affiche le statut individuel de chaque tache (titre, succes/echec, phase, duree) | Test unitaire : mocker un job `autopipeline-batch` avec `job.result` contenant un format `BATCH_COMPLETE:2/4:failed=...` et verifier que `sendJobCompletionNotification` produit un message multi-ligne avec 4 taches detaillees | unit |
| V2 | Le resultat d'un job `autopipeline-batch` est tronque a 4000 chars au lieu de 500 | Test unitaire : lancer un job `autopipeline-batch` avec un resultat de 3000 chars et verifier que `job.result` conserve les 3000 chars intacts | unit |
| V3 | Le message Telegram est tronque a 3800 chars max avec mention "... +K autres" | Test unitaire : construire un resultat batch de 10 taches depassant 4096 chars et verifier que le message genere est <= 3800 chars et contient le suffixe de troncature | unit |
| V4 | Le callback `onProgress` envoie un message a chaque tache dans le batch | Test integration : mocker `botInstance.api.sendMessage`, lancer un batch de 3 taches via la closure `launchFn` de planning.ts, verifier que `sendMessage` a ete appele au moins 3 fois avec des messages contenant les titres des taches | integration |
| V5 | Le `onProgress` utilise `chatId`/`threadId` captures et non `ctx.reply()` | Test unitaire : mocker `ctx.reply` comme un spy, lancer la closure `launchFn`, verifier que le spy n'a pas ete appele apres le launch | unit |
| V6 | Si le taux d'echec depasse 50%, la notification est envoyee avec severite critique | Test unitaire : mocker `sendJobCompletionNotification` avec un batch 1/4 (75% echec), verifier que le fallback `enqueue` utilise `severity: "critical"` | unit |
| V7 | Si le taux d'echec est inferieur ou egal a 50%, la notification est envoyee avec severite normale | Test unitaire : meme pattern que V6 avec batch 3/4 (25% echec), verifier `severity: "normal"` | unit |
| V8 | Le keyboard batch contient "Relancer les N echecs" quand il y a des echecs et le seuil est depasse | Test unitaire : appeler `getCompletionKeyboard` avec un job `autopipeline-batch` dont le resultat contient `failed=abc,def` et verifier que le keyboard contient un bouton "Relancer les 2 echecs" | unit |
| V9 | Le keyboard batch contient uniquement "Voir le backlog" quand tous les jobs reussissent | Test unitaire : appeler `getCompletionKeyboard` avec un job `autopipeline-batch` dont le resultat est `BATCH_COMPLETE:4/4:failed=` et verifier un seul bouton | unit |
| V10 | Le handler `jc_batch_retry` relance un nouveau batch pour les taches echouees | Test integration : mocker le handler callback avec un job original contenant `failed=abc12345,def67890`, verifier qu'un nouveau job `autopipeline-batch` est lance avec les 2 taches correspondantes | integration |
| V11 | Le format de resultat batch encode correctement les failed IDs | Test unitaire : verifier que le format retourne par la closure `launchFn` dans planning.ts contient `BATCH_COMPLETE:2/6:failed=<ids>` avec les bons IDs des taches echouees | unit |
| V12 | Le seuil d'escalade est exporte comme constante configurable | Test unitaire : importer `BATCH_FAILURE_THRESHOLD` depuis job-manager.ts et verifier sa valeur par defaut (0.5) | unit |
| V13 | Les erreurs d'envoi de message dans onProgress sont catchees sans crash | Test unitaire : mocker `botInstance.api.sendMessage` pour throw une erreur, verifier que le batch continue sans crash | unit |
| V14 | Le handler `jc_batch_retry` repond gracieusement quand le job original a expire | Test unitaire : appeler le handler avec un jobId inexistant, verifier que `answerCallbackQuery` est appele avec un message d'expiration | unit |
| V15 | `parseBatchResult` parse correctement le format etendu et retourne l'interface structuree | Test unitaire : tester avec format valide, format sans failed IDs, format invalide (retourne null) | unit |
| V16 | Les taches non executees (arret anticipe) sont incluses dans les failed IDs | Test unitaire : simuler un batch sequentiel de 5 taches ou seules 3 ont des resultats, verifier que les IDs des taches 4 et 5 apparaissent dans failed= | unit |
| V17 | En mode parallele, onProgress envoie au maximum 1 message par tache terminee | Test unitaire : mocker sendMessage, lancer un batch parallele de 3 taches, verifier que sendMessage est appele exactement 3 fois pour la progression | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Les 3 problemes racines sont clairement identifies et traces : notification tronquee (R1-R3), onProgress absent (R4-R5), pas d'escalade (R6-R8) |
| Perimetre | Couvert | Option C de l'exploration : correction des 3 bugs + escalade + bouton retry manuel. Option D (retry automatique) explicitement exclue de cette iteration |
| Validation | Couvert | 17 V-criteres couvrant chaque regle metier, majoritairement testables en unit (14 unit, 2 integration, 1 corrige de manual a unit). Corrections challenge integrees : parseur partage, escalade directe, garde expiration, taches non executees, rate-limit onProgress |
| Technique | Couvert | Fichiers identifies par exploration codebase reelle, patterns reutilisables documentes avec references exactes, contraintes techniques listees |
| UX | Pertinent | Le format de notification enrichi, les boutons inline conditionnels et les messages de progression affectent directement l'experience utilisateur Telegram. Le format est specifie dans la section 4 |
| Alternatives | Pertinent | 4 options evaluees dans l'exploration (A: status quo, B: patch minimal, C: refactoring enrichi, D: refactoring complet). Option C selectionnee comme meilleur rapport valeur/complexite. Option D reportee a S+1 |

**Zones d'ombre residuelles** :

1. **Stockage longue duree des resultats batch** : la limite de 4000 chars dans `job.result` est suffisante pour les cas courants (6-8 taches), mais un batch de 20+ taches pourrait depasser. Si ce cas se presente, il faudrait envisager un stockage separe en Supabase (table `pipeline_runs`). Non bloquant pour cette iteration car les batchs actuels sont <= 10 taches.

2. **Notification de progression : messages multiples vs edit** : cette spec opte pour l'envoi de messages separes (`sendMessage`) plutot que l'edition d'un message unique (`editMessageText`). L'edition serait moins spam mais requiert de stocker le `message_id` initial et ajoute de la complexite. A reconsiderer si les utilisateurs signalent un bruit excessif.

3. **Distinction echecs attendus vs inattendus** : le seuil de 50% traite tous les echecs de la meme maniere. Une tache bloquee par gate (attendu) et une tache crashee (inattendu) ont le meme poids. Une distinction future pourrait moduler le seuil par type d'echec (ex: `blocked` ne compte pas dans le taux d'echec).
