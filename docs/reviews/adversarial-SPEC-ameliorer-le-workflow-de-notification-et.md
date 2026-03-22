# Rapport Adversarial — SPEC-ameliorer-le-workflow-de-notification-et

> Généré le 2026-03-22. Source spec : docs/specs/SPEC-ameliorer-le-workflow-de-notification-et.md

---

## Tableau de synthèse

| ID | Agent | Sévérité | Titre |
|----|-------|----------|-------|
| F-EC-1 | Edge Case Hunter | BLOQUANT | Format BATCH_COMPLETE étendu corrompt la notification existante |
| F-DA-1 | Devil's Advocate | MAJEUR | Escalade critique inaccessible sur le chemin direct botInstance |
| F-EC-2 | Edge Case Hunter | MAJEUR | Bouton "Relancer" cliquable après cleanup du job (> 24h) |
| F-EC-3 | Edge Case Hunter | MAJEUR | Flood Telegram en mode batch parallèle (onProgress concurrent) |
| F-EC-4 | Edge Case Hunter | MAJEUR | Tâches bloquées-et-sautées absentes des failed IDs (arrêt anticipé séquentiel) |
| F-DA-2 | Devil's Advocate | MAJEUR | Parseur notification ligne 291 non mis à jour dans le périmètre spec |
| F-SS-1 | Simplicity Skeptic | MAJEUR | Trois parseurs indépendants pour le même format bespoke BATCH_COMPLETE |
| F-DA-3 | Devil's Advocate | MINEUR | Seuil R3 ambigu : caractères vs frontière de tâche |
| F-SS-2 | Simplicity Skeptic | MINEUR | Helper sendProgressMessage — abstraction sans valeur ajoutée |
| F-SS-3 | Simplicity Skeptic | MINEUR | V5 est une vérification manuelle, pas un test automatisé |
| F-EC-5 | Edge Case Hunter | MINEUR | Batch vide possible si failed= est parsé sans garde |

---

## Verdict

**GO WITH CHANGES**

Justification : 1 BLOQUANT resolvable (F-EC-1 corrigeable en ajoutant un strip du champ `failed=` dans le parseur de notification) + 5 MAJEURS. Aucun bloquant non resolvable. Les corrections requises sont circonscrites et n'impliquent pas de refonte architecturale.

---

## Findings détaillés

### Devil's Advocate

**[MAJEUR] F-DA-1 — Escalade critique inaccessible sur le chemin direct botInstance**

- Source : Section 2 R6, Section 6.3, Section 7 (contrainte concurrence)
- Description : La spec dit que l'escalade critique utilise `enqueue({ severity: "critical" })`. Mais `sendJobCompletionNotification` (job-manager.ts l.301-309) envoie toujours directement via `botInstance.api.sendMessage` quand `botInstance` est disponible, et retourne immédiatement après (`return`). Le `enqueue` avec severity critique n'est atteint que sur le chemin de fallback (botInstance null). Dans un environnement normal où le bot est initialisé, la notification critique serait envoyée via le chemin direct — sans bypass des quiet hours, sans le comportement spécial "critical". La spec présente les deux chemins comme équivalents, mais ce n'est pas le cas.
- Impact : Le comportement d'escalade critique (R6) ne fonctionnera pas comme spécifié. La notification critique arrivera comme une notification normale, sans bypass des quiet hours ni différenciation visuelle.
- Evidence : `if (botInstance && job.chatId) { ... await botInstance.api.sendMessage(...); return; }` (job-manager.ts l.301-309). Le `enqueue` (l.316) n'est jamais atteint quand botInstance est disponible.

**[MAJEUR] F-DA-2 — Parseur notification ligne 291 non explicitement listé dans le périmètre**

- Source : Section 2 R9, Section 5 (fichiers concernés), Section 6.6 (troncature existante)
- Description : La spec change le format de `job.result` de `BATCH_COMPLETE:2/6\n\n[details]` à `BATCH_COMPLETE:2/6:failed=abc,def\n\n[details]`. Mais le parseur existant dans `sendJobCompletionNotification` (job-manager.ts l.291) fait `job.result.replace("BATCH_COMPLETE:", "").split("\n")[0]` — ce qui retourne désormais `2/6:failed=abc,def` au lieu de `2/6`. Le message affiché serait "Resultat : 2/6:failed=abc,def taches reussies". La section 5 indique bien `job-manager.ts` pour modification, mais ne cite pas explicitement cette ligne comme à mettre à jour. Risque de régression silencieuse.
- Impact : Message de notification batch malformé visible par l'utilisateur à chaque batch.

**[MINEUR] F-DA-3 — Seuil de troncature R3 ambigu : caractères vs frontière de tâche**

- Source : Section 2 R3, Section 4.1
- Description : R3 dit "tronquer à la tâche N avec '... +K autres'", mais section 4.1 dit "si le message dépasse 3800 chars, tronquer à la tâche N". Ces formulations sont cohérentes sur le principe mais laissent ouvert le cas d'une tâche unique dont le `formatPipelineResult` dépasse à lui seul 3800 chars (ex: blocked.reason très long). La spec ne précise pas si la tâche N doit être incluse complètement ou tronquée en milieu de ligne.
- Impact : Ambiguité d'implémentation mineure, risque de comportements légèrement différents selon l'implémenteur.

### Statistiques Devil's Advocate
- Bloquants : 0
- Majeurs : 2
- Mineurs : 1

---

### Edge Case Hunter

**[BLOQUANT] F-EC-1 — Format BATCH_COMPLETE étendu corrompt la notification existante**

- Scénario : Le batch termine. planning.ts retourne `BATCH_COMPLETE:2/6:failed=abc12345,def67890\n\n[details]`. `sendJobCompletionNotification` parse `job.result.replace("BATCH_COMPLETE:", "").split("\n")[0]` et obtient `2/6:failed=abc12345,def67890`. Le message affiché est "Resultat : 2/6:failed=abc12345,def67890 taches reussies".
- Source : Section 2 R9, job-manager.ts l.290-292 (code existant)
- Impact : Régression directement visible par l'utilisateur sur chaque notification de batch terminé. Le changement de format introduit un bug dans le parseur existant qui n'est pas identifié par la spec comme à corriger.
- Fréquence estimée : Fréquent — chaque batch autopipeline déclenche ce bug.

**[MAJEUR] F-EC-2 — Bouton "Relancer les N echecs" cliquable après cleanup du job (> 24h)**

- Scénario : Batch terminé à J, bouton "Relancer les N echecs" affiché dans Telegram. À J+25h, le job est nettoyé par `cleanup()`. L'utilisateur clique sur le bouton. Le handler `jc_batch_retry:<jobId>` appelle `get(jobId)` qui retourne `undefined`. Le comportement non spécifié — crash, message vague, ou réponse silencieuse.
- Source : Section 2 R10, Section 5 (jobs.ts), Section 7 (contrainte cleanup > 24h)
- Impact : UX dégradée — bouton toujours visible, résultat indéfini au clic. Les messages Telegram ne peuvent pas être supprimés programmatiquement.
- Fréquence estimée : Occasionnel — tout utilisateur qui ne clique pas dans les 24h.

**[MAJEUR] F-EC-3 — Flood Telegram en mode batch parallèle (onProgress concurrent)**

- Scénario : Batch de 10 tâches avec `maxConcurrency: 3`. Les 3 premières tâches démarrent simultanément et envoient chacune des messages onProgress via `botInstance.api.sendMessage`. Telegram limite à 30 messages/minute dans le même chat. Avec des tâches longues et de nombreux onProgress, la limite est atteinte, déclenchant des erreurs 429.
- Source : Section 2 R4, R5, Section 7 (contrainte concurrence)
- Impact : Les messages de progression sont perdus silencieusement (catchés conformément à V13), mais l'utilisateur ne voit qu'une fraction des updates. Dégradation silencieuse du suivi de progression qui est pourtant l'objectif central de R4.
- Fréquence estimée : Occasionnel — uniquement avec maxConcurrency > 1 et batchs larges.

**[MAJEUR] F-EC-4 — Tâches bloquées-et-sautées absentes des failed IDs (arrêt anticipé séquentiel)**

- Scénario : Batch séquentiel de 5 tâches. La tâche 3 est bloquée (phase: "blocked"). Le code `runBatchPipeline` break immédiatement (l.327-331). Les tâches 4 et 5 n'ont jamais été exécutées. La `launchFn` retourne `BATCH_COMPLETE:2/5:failed=<id_task3>` — uniquement l'ID de la tâche 3. L'utilisateur clique "Relancer les 1 echec" mais voit seulement la tâche 3 relancée, pas les tâches 4 et 5 qui n'ont jamais tourné.
- Source : Section 2 R9, R10, auto-pipeline.ts l.327-331
- Impact : Le retry partiel donne un sentiment faux de résolution — l'utilisateur pense avoir relancé tous les échecs mais les tâches non exécutées sont silencieusement ignorées.
- Fréquence estimée : Rare — seulement quand des gates bloquent en mode séquentiel.

**[MINEUR] F-EC-5 — Batch retry avec failed= vide (garde défensive absente)**

- Scénario : R8/R11 garantissent que le bouton "Relancer" n'apparaît que si `failed=` est non-vide. Mais le handler `jc_batch_retry` dans jobs.ts recevra quand même des clicks (message Telegram = état figé). Si le parsing retourne 0 IDs, le handler tenterait de lancer un batch vide.
- Source : Section 2 R10, Section 5 (jobs.ts)

### Statistiques Edge Case Hunter
- Bloquants : 1
- Majeurs : 3
- Mineurs : 1

---

### Simplicity Skeptic

**[MAJEUR] F-SS-1 — Trois parseurs indépendants pour le même format bespoke BATCH_COMPLETE**

- Source : Section 4.2 (format R9), Section 5 (job-manager.ts, jobs.ts, planning.ts)
- Description : Le format `BATCH_COMPLETE:<ok>/<total>:failed=<id1>,<id2>\n\n<details>` est un protocole texte bespoke qui sera parsé par au moins 3 consommateurs distincts : (1) `sendJobCompletionNotification` pour extraire ok/total et afficher le message, (2) `getCompletionKeyboard` pour extraire les failed IDs et construire le bouton, (3) le handler `jc_batch_retry` dans jobs.ts pour récupérer les IDs et relancer. La spec ne définit pas de fonction utilitaire partagée `parseBatchResult()`. Chaque équipe/contexte réimplèmente la même logique de parsing — risque de divergence et de bugs.
- Alternative : Ajouter `interface BatchResult { ok: number; total: number; failedIds: string[]; details: string }` et `parseBatchResult(result: string): BatchResult` dans job-manager.ts, partagé entre les 3 consommateurs.
- Codebase : Précédent existant : `buildPreflightResultTag` / parsing de `PRDWF_PREFLIGHT:` — même anti-pattern, même risque.

**[MINEUR] F-SS-2 — Helper sendProgressMessage — abstraction sans valeur ajoutée claire**

- Source : Section 7 (contrainte dépendance botInstance)
- Description : La spec propose d'exporter `sendProgressMessage(chatId, threadId, message)` depuis job-manager.ts "pour éviter d'exposer l'instance directement". Mais `botInstance` n'est pas exposé publiquement — il est déjà encapsulé. La `onProgress` dans planning.ts pourrait simplement faire `await botInstance.api.sendMessage(chatId, msg)` en capturant les variables locales dans la closure. Ajouter un helper exporté ajoute une surface d'API publique sans simplifier le code côté appelant.
- Alternative : Capturer chatId/threadId avant la closure (déjà prévu par R5) et appeler directement un import nommé si nécessaire. Ou passer botInstance comme paramètre explicite à launchFn.
- Codebase : Le pattern capture-avant-closure est déjà documenté en section 6.1 — suffisant sans helper supplémentaire.

**[MINEUR] F-SS-3 — V5 est une vérification manuelle, non automatisée**

- Source : Section 8 V5
- Description : V5 ("Le onProgress utilise chatId/threadId captures et non ctx.reply()") est explicitement marqué "manual" avec "verification par review de code". C'est la contrainte la plus critique de sécurité (ctx périmé = crash silencieux ou mauvais destinataire), mais elle n'a pas de test automatisé. Les 12 autres V-critères ont des tests unit ou integration.
- Alternative : Un test simple mocke ctx.reply pour throw une erreur, puis vérifie que launchFn ne lève pas — ou utilise un spy pour confirmer que ctx.reply n'est pas appelé après le launch.

### Statistiques Simplicity Skeptic
- Bloquants : 0
- Majeurs : 1
- Mineurs : 2

---

## Recommandations (actions pour passer à GO)

### Corrections obligatoires (BLOQUANT + MAJEURS bloquants)

**[1] Corriger le parseur de notification batch (F-EC-1 + F-DA-2)**

Dans `sendJobCompletionNotification` (job-manager.ts l.290-292), mettre à jour le parsing du format étendu :

```typescript
} else if (job.type === "autopipeline-batch" && job.result?.startsWith("BATCH_COMPLETE:")) {
  // Parse "BATCH_COMPLETE:<ok>/<total>:failed=...\n\n..."
  const afterPrefix = job.result.replace("BATCH_COMPLETE:", "").split("\n")[0];
  const summary = afterPrefix.split(":")[0]; // "2/6" — strip ":failed=..." part
  message = `Implementation batch terminée (${elapsed})\nResultat : ${summary} taches reussies`;
}
```

Ajouter ce parsing dans la section 5 (job-manager.ts) et dans la section 8 (V1 doit couvrir ce cas).

**[2] Résoudre le conflit escalade critique vs chemin direct (F-DA-1)**

Deux options, choisir l'une :
- Option A (recommandée) : Dans `sendJobCompletionNotification`, ajouter un paramètre `severity` ou injecter la logique d'escalade AVANT d'envoyer via botInstance. Utiliser une indication visuelle dans le message (`ALERTE CRITIQUE`) plutôt que le mécanisme de queue pour les notifications directes.
- Option B : Envoyer via `enqueue` même quand botInstance est disponible, pour les cas critiques. Adapter `sendStandalone` pour utiliser botInstance si disponible.

La spec doit préciser laquelle est retenue.

**[3] Ajouter une garde dans le handler jc_batch_retry pour job inexistant (F-EC-2)**

Dans jobs.ts, handler `jc_batch_retry` :
```typescript
if (!job) {
  await ctx.answerCallbackQuery({ text: "Ce batch a expiré (> 24h). Relance un nouveau batch depuis /backlog." });
  return;
}
```
Ajouter un V-critère V14 couvrant ce cas.

**[4] Définir un parseur partagé parseBatchResult (F-SS-1)**

Ajouter dans job-manager.ts une fonction utilitaire exportée :
```typescript
export function parseBatchResult(result: string): { ok: number; total: number; failedIds: string[]; details: string } | null
```
Utilisée par les 3 consommateurs. Ajouter la définition de l'interface et de la fonction dans la section 5.

### Corrections recommandées (MAJEURS non bloquants)

**[5] Couvrir les tâches non exécutées dans failed IDs (F-EC-4)**

Dans la `launchFn` de planning.ts, après `runBatchPipeline`, collecter également les IDs des tâches passées en entrée mais absentes de `results` (arrêt anticipé) et les inclure dans `failed=`. Ou documenter explicitement dans la spec que les tâches non exécutées ne sont pas incluses et pourquoi.

**[6] Limiter le rate de onProgress en mode parallèle (F-EC-3)**

Ajouter dans la section 7 une contrainte : "En mode parallèle (maxConcurrency > 1), le onProgress est envoyé uniquement à la fin de chaque tâche (pas à chaque phase interne) pour éviter le flood Telegram." Sinon préciser que c'est un risque accepté.

**[7] Automatiser V5 (F-SS-3)**

Remplacer la vérification manuelle par un test : mocker `ctx.reply` comme un spy, lancer la closure launchFn, vérifier que le spy n'a pas été appelé.

---

## Points forts de la spec

- La section 6 (Patterns existants) est exemplaire : elle cite des lignes de code précises et explique pourquoi chaque pattern est réutilisable. Cela réduira le temps d'implémentation et les divergences.
- Les 13 V-critères sont bien structurés avec niveaux (unit/integration/manual) — excellent rapport de testabilité (10/13 automatisés).
- La zone d'ombre 2 (messages multiples vs edit) est honnêtement documentée avec les trade-offs — pas de sur-promesse sur la solution retenue.
- Le périmètre est clairement borné (option C, retry automatique option D explicitement exclu) — bon contrôle du scope creep.
- R5 (ctx périmé) est une contrainte technique bien identifiée et justifiée avec référence au pattern existant.
