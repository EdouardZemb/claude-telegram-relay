---
name: simplifier-le-systeme-de-notification-on-n
description: Suppression du code mort dans notification-queue.ts (batching, quiet hours, digest du matin, persistance JSON) — envoi immédiat systématique, interface enqueue() inchangée
status: ready
phase: 1-implement
exploration: docs/explorations/EXPLORE-simplifier-le-systeme-de-notification-on-n-2.md
generated_at: "2026-03-24"
---

# SPEC — Simplifier le système de notification

## Section 1 — Objectif

Supprimer ~220 LOC de code mort dans `src/notification-queue.ts` (batching par timer, quiet hours, digest du matin, persistance JSON de la queue), en remplaçant `enqueue()` par un envoi immédiat via `sendStandalone()`. L'interface publique `enqueue()` reste inchangée pour les 9 callsites existants. Le principe directeur est YAGNI : la configuration production (`quietStart=0`, `quietEnd=0`, `batchThreshold=100`) confirme que ces features ne s'activent jamais.

---

## Section 2 — Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | `enqueue()` envoie immédiatement via `sendStandalone()` si le type est activé — sans batching, sans quiet hours, sans persistance queue | Config prod : batchThreshold=100 jamais atteint ; EXPLORE-2 §4 Option B | `enqueue({type:"task",...})` → `sendStandalone()` |
| R2 | `enqueue()` ignore silencieusement les types désactivés (`isTypeEnabled()` = false) | Comportement existant conservé — L342-343 notification-queue.ts | `types.idea.enabled=false` → return sans envoi |
| R3 | L'interface publique `enqueue(item: Omit<NotificationItem, "id"\|"createdAt">)` reste inchangée — les 9 callsites ne sont pas modifiés | EXPLORE-2 §6 "Les callsites enqueue() restent inchangés" | tasks.ts, memory-cmds.ts, job-manager.ts, memory/core.ts, memory/classification.ts, heartbeat.ts |
| R4 | `consumeMcpPending()` est conservée et appelle `sendStandalone()` directement pour chaque item pending (sans passer par la queue) | EXPLORE-2 §6 "conserver avec un timer dédié" | Lit `mcp-pending-notifications.json`, envoie chaque item, vide le fichier |
| R5 | `startQueue()` démarre un timer de 60 s appelant uniquement `consumeMcpPending()` — plus de timer flush ni de logique quiet hours | EXPLORE-2 §6 "timer dédié minimal pour consumeMcpPending()" | `setInterval(consumeMcpPending, 60_000)` |
| R6 | `TypePrefs` est simplifiée à `{ enabled: boolean }` — le champ `immediate` est supprimé ainsi que `isImmediate()` | Conséquence de R1 : tous les envois étant immédiats, `immediate` n'a plus d'effet | — |
| R7 | `NotificationPrefs` perd `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold` | Ces champs correspondent aux features supprimées (R1, R5) | Interface allégée |
| R8 | La commande `/notify` expose uniquement : `status`, `on TYPE`, `off TYPE` — les sous-commandes `quiet`, `batch`, `immediate` sont supprimées | Conséquence de R6+R7 ; aucun utilisateur ne les utilise (config prod) | Help : "Usage: /notify [status\|on TYPE\|off TYPE]" |
| R9 | `heartbeat.ts` supprime les 5 imports liés au digest/quiet (`flushMorningDigest`, `getQueue`, `isQuietHours`, `loadPrefs`, `loadQueue`) et la logique digest du matin (L609-616) | EXPLORE-2 §3 : service heartbeat non démarré en PM2 ; logique caduque après R1 | — |
| R10 | `relay.ts` supprime l'appel redondant `loadPrefs()` (L147) — `startQueue()` l'appelle déjà | EXPLORE-2 §3 relay.ts : appel en double | — |
| R11 | `config/notification-prefs.json` est réduit aux champs persistants : objet `types` (dict type→`{enabled}`) | Conséquence de R6+R7 | `{"types":{"task":{"enabled":true},...}}` |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| Callsite `enqueue()` | `Omit<NotificationItem, "id"\|"createdAt">` | Paramètre fonction | `type`, `severity`, `message`, `data?` |
| `config/notification-prefs.json` | JSON → `NotificationPrefs` | `loadPrefs()` au démarrage | `types[type].enabled` uniquement après simplification |
| `mcp-pending-notifications.json` | JSON Array | `consumeMcpPending()` poll 60s | `type`, `severity`, `message`, `data`, `createdAt` |
| Env vars | string | Process env | `TELEGRAM_GROUP_ID`, `TELEGRAM_USER_ID`, `SPRINT_THREAD_ID`, `DEV_THREAD_ID` |

---

## Section 4 — Données de sortie

**Sortie principale : envoi Telegram immédiat**

```
sendStandalone(fullItem)
  → botInstance.api.sendMessage(chatId, message, { reply_markup?, message_thread_id? })
```

**Comportements de sortie :**
- Type activé + botInstance présent → message Telegram envoyé avec boutons inline contextuels (`getInlineKeyboard()`)
- Type désactivé → aucune sortie (return silencieux)
- `botInstance` null (tests, avant `startQueue`) → return silencieux sans erreur
- Erreur Telegram → `log.error`, pas de throw

**Exemple de sortie pour `type="task"`, `taskStatus="in_progress"` :**
```
Message : "Tache T42 passee en review"
Boutons  : [Terminer] [Voir details]
Thread   : sprintThreadId (si groupe configuré)
```

---

## Section 5 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/notification-queue.ts` | Modifier (~473 → ~230 LOC) | Supprimer batching, quiet hours, digest, persistance queue ; simplifier `enqueue()` et `consumeMcpPending()` |
| `src/heartbeat.ts` | Modifier | Supprimer 5 imports + bloc digest du matin L609-616 (service non actif en PM2) |
| `src/relay.ts` | Modifier | Supprimer appel `loadPrefs()` redondant L147 |
| `src/commands/profile.ts` | Modifier | Supprimer sous-commandes `/notify quiet`, `/notify TYPE batch`, `/notify TYPE immediate` + mettre à jour le help |
| `config/notification-prefs.json` | Modifier | Supprimer champs `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold` et champ `immediate` par type |
| `tests/unit/notification-queue.test.ts` | Modifier | Supprimer suites `formatDigest`, `formatMorningDigest`, `flush` ; adapter suite `enqueue` à l'envoi immédiat |

---

## Section 6 — Patterns existants

**1. `sendStandalone()` — cœur de l'envoi (à réutiliser directement dans `enqueue()`)**
```typescript
// src/notification-queue.ts L233-250
async function sendStandalone(item: NotificationItem): Promise<void> {
  if (!botInstance) return;
  const chatId = groupId || process.env.TELEGRAM_USER_ID || "";
  if (!chatId) return;
  const threadId = getThreadId(item.type);
  const keyboard = getInlineKeyboard(item);
  const opts: Record<string, unknown> = {};
  if (groupId && threadId) opts.message_thread_id = threadId;
  if (keyboard) opts.reply_markup = keyboard;
  try {
    await botInstance.api.sendMessage(chatId, item.message, opts);
  } catch (error) {
    log.error(`Notification send error:`, { error: String(error) });
  }
}
```
Devient le seul chemin d'envoi — appelé directement par `enqueue()` et `consumeMcpPending()`.

**2. `isTypeEnabled()` — filtre type (à conserver tel quel)**
```typescript
// src/notification-queue.ts L82-84
export function isTypeEnabled(type: NotificationType): boolean {
  return getPrefs().types[type]?.enabled ?? true;
}
```

**3. `getInlineKeyboard()` — boutons contextuels (à conserver tel quel)**
```typescript
// src/notification-queue.ts L188-223
export function getInlineKeyboard(item: NotificationItem): InlineKeyboard | undefined { ... }
```
4 types couverts : task (start/done + view), pr (url), idea (promote + archive), alert (view task + sprint + dismiss).

**4. `consumeMcpPending()` — bridge MCP (à simplifier : remplacer `queue.push` + `saveQueue()` par `sendStandalone()`)**
```typescript
// src/notification-queue.ts L414-440 — logique de polling à conserver
// Remplacer :  queue.push(fullItem); ... await saveQueue();
// Par :        await sendStandalone(fullItem);
```

**5. Pattern `beforeEach` dans les tests (à adapter)**
```typescript
// tests/unit/notification-queue.test.ts L169-181
beforeEach(async () => {
  const prefs = getDefaultPrefs(); // TypePrefs simplifiée après R6
  await savePrefs(prefs);
  await loadPrefs();
});
```

---

## Section 7 — Contraintes

**Ne pas casser :**
- Les 9 callsites `enqueue()` dans `tasks.ts` (×2), `memory-cmds.ts` (×3), `job-manager.ts` (×1), `memory/core.ts` (×1), `memory/classification.ts` (×1), `heartbeat.ts` (×2) — **aucune modification**
- Les callbacks `notif_*` dans `src/commands/utilities.ts` — **non touchés**
- `isTypeEnabled()` et `getInlineKeyboard()` — interfaces et comportements inchangés, exports maintenus
- Les 6 tests `getInlineKeyboard` et le test `stopQueue` → conserver sans modification

**Limites techniques :**
- `botInstance` est null lors des tests unitaires (startQueue jamais appelé) → `sendStandalone()` retourne silencieusement ; les tests `enqueue` restent valides sans mock bot
- Si heartbeat.ts est redémarré **avant** ce nettoyage → compilation KO sur les imports supprimés ; la modification heartbeat.ts est donc bloquante pour tout redémarrage du service
- Le fichier `mcp-pending-notifications.json` peut ne pas exister → `consumeMcpPending()` doit conserver le `try/catch` silencieux existant (R6 dans le code actuel)
- Imports `fs/promises` : supprimer `rename` et les références à `QUEUE_FILE` ; conserver `readFile`/`writeFile` pour `loadPrefs`, `savePrefs`, `consumeMcpPending`

---

## Section 8 — Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|--------------|--------|
| V1 | `enqueue()` avec type activé et botInstance=null ne lève pas d'erreur | `await enqueue({type:"task", severity:"normal", message:"x"})` → no throw | unit |
| V2 | `enqueue()` avec type désactivé ne lève pas d'erreur et n'envoie rien | `types.idea.enabled=false` + enqueue idea → no throw | unit |
| V3 | `enqueue()` assigne `id` (UUID) et `createdAt` (timestamp) à chaque item | Test existant "assigns unique IDs and timestamps" passe (comportement conservé) | unit |
| V4 | Les fonctions `formatDigest`, `formatMorningDigest`, `flushMorningDigest`, `flush`, `isQuietHours`, `saveQueue`, `loadQueue`, `isImmediate` n'existent plus dans le module | `grep` sur ces noms dans `notification-queue.ts` → 0 résultats export/function | unit |
| V5 | `getInlineKeyboard()` retourne les boutons corrects pour chaque type (task/pr/idea/alert) | 6 tests suite `getInlineKeyboard` passent sans modification | unit |
| V6 | `NotificationPrefs` ne contient plus `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold` | TypeScript compile sans erreur ; grep sur ces champs dans `notification-queue.ts` → 0 résultats | unit |
| V7 | `formatPrefs()` n'affiche plus "Quiet hours" ni "Batch" | `formatPrefs(getDefaultPrefs())` ne contient pas les chaînes "Quiet" et "Batch" | unit |
| V8 | `startQueue()` démarre exactement 1 timer (consumeMcpPending 60s), `stopQueue()` l'arrête proprement | Test `stopQueue` existant passe ; inspection code confirme unique `setInterval` | unit |
| V9 | `heartbeat.ts` compile sans les imports supprimés | `bun tsc --noEmit` (ou équivalent bun typecheck) passe | unit |
| V10 | `/notify quiet 22h-8h` répond avec le message d'aide mis à jour (sous-commande supprimée) | Test integration : `ctx.match = "quiet 22h-8h"` → reply contient "Usage: /notify" | integration |
| V11 | `/notify on task` et `/notify off task` fonctionnent et persistent dans les prefs | Test integration : toggle + `getPrefs().types.task.enabled` correct | integration |
| V12 | `config/notification-prefs.json` ne contient plus `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold`, `immediate` | `grep` sur fichier config → 0 résultats pour ces clés | unit |
| V13 | `bun test` (1820 tests) passe en CI après toutes les modifications | CI vert sur PR | integration |

---

## Section 9 — Coverage et zones d'ombre

### Matrice de couverture des dimensions

| Dimension | Couvert | Non couvert |
|-----------|---------|-------------|
| **Problème** | Code mort identifié (formatDigest, quiet hours, batching, persistance) confirmé par config prod et deux explorations | — |
| **Périmètre** | 6 fichiers à modifier, 9 callsites protégés, MCP bridge conservé, tests à adapter | Redémarrage heartbeat service (hors scope — service arrêté) |
| **Validation** | 13 V-critères : unit (V1-V9, V12), integration (V10-V11, V13) | Mock botInstance pour test d'envoi effectif (hors scope) |
| **Technique** | Simplification `enqueue()`, `consumeMcpPending()` modifiée, timer 60s, `TypePrefs` simplifiée | Performance timer 60s vs 300s (non mesuré — bot personnel, volume faible) |

### Alternatives évaluées

| Option | Verdict | Raison |
|--------|---------|--------|
| A — Status quo | Écarté | Dette croissante, timer inutile toutes les 5 min, code incompréhensible pour tout nouveau contributeur |
| **B — Suppression ciblée digest+quiet (retenu)** | **GO** | ~-220 LOC, interface `enqueue()` inchangée, risque technique minimal, réversibilité totale via git |
| C — Suppression totale de la queue | Écarté | Nécessite modification des 9 callsites + refactoring MCP bridge, risque plus élevé pour gain marginal |

### Zones d'ombre

1. **Timer MCP 60s vs 300s** : L'exploration recommande 60s sans benchmark précis. Le heartbeat étant arrêté, le seul consommateur est `relay.ts` via `startQueue()`. 60s est une valeur raisonnable pour un bot personnel — ajustable post-implémentation.

2. **`severity` dans NotificationItem** : Après R1 (envoi toujours immédiat), le champ `severity: "critical"|"normal"` n'est plus utilisé dans `enqueue()`. Il est conservé dans le type pour compatibilité des callsites (ils passent `severity`) mais devient sémantiquement inerte. Refactoring complet de `NotificationItem` est hors scope.

3. **Tests `enqueue` post-simplification** : Sans mock de `botInstance`, les tests vérifient l'absence d'erreur et les règles de filtrage type, mais pas l'envoi effectif. Un mock partiel pour vérifier que `sendStandalone` est appelé serait une amélioration future (hors scope de ce ticket).

4. **`loadQueue()` dans heartbeat.ts** : L'import `loadQueue` est présent (L64) mais après simplification, `loadQueue()` n'existera plus. Ce nettoyage est couvert par R9 et vérifié par V9.
