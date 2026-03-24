---
name: simplifier-le-systeme-de-notification-on-n
description: Suppression des mécanismes de notification inactifs (quiet hours, morning digest, batching avec seuil et persistence JSON) du système S26.
status: draft
created_at: "2026-03-24"
exploration: docs/explorations/EXPLORE-simplifier-le-systeme-de-notification-on-n-utilise-pas-le-digest-ni-les-quiet-hours.md
---

# SPEC — Simplifier le système de notification (suppression digest, quiet hours, batching)

## 1. Objectif

Supprimer les mécanismes de notification inactifs en production (quiet hours, morning digest, batching avec seuil et persistence JSON de queue) du système S26. Le comportement observable reste inchangé : `enqueue()` envoie immédiatement les notifications autorisées. Réduction estimée : ~200-250 LOC actives supprimées, complexité architecturale réduite.

**Pourquoi maintenant** : la config production (`quietStart: 0, quietEnd: 0`, `batchThreshold: 100`) neutralise explicitement ces features ; le service `claude-heartbeat` (seul appelant de `flushMorningDigest`) est arrêté. Le code est factuellement inactif mais crée une illusion de fonctionnalité.

---

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | L'interface `enqueue(item: Omit<NotificationItem, "id"\|"createdAt">): Promise<void>` est conservée identique — 9 callsites inchangés dans 8 fichiers | Exploration §3 — contrainte callsites | `enqueue({type:"task", severity:"normal", message:"..."})` |
| R2 | Si `isTypeEnabled(type) === false`, la notification est silencieusement ignorée (skip) | Comportement existant à préserver | type "idea" désactivé → aucun envoi |
| R3 | Tous les autres cas (y compris `severity === "critical"` et types en mode `immediate`) → envoi immédiat via `sendStandalone()` | Exploration §5 — nouveau comportement | notification task normale → envoi direct |
| R4 | `getInlineKeyboard(item)` est conservé tel quel — produit les boutons inline par type | Exploration §3 — actif réutilisable | task backlog → boutons "Demarrer" + "Voir details" |
| R5 | `consumeMcpPending()` est conservé — lit `mcp-pending-notifications.json` et appelle `enqueue()` pour chaque item valide | Exploration §3 contrainte | bridge MCP → notif Telegram |
| R6 | `startQueue(bot)` est conservé mais simplifié : initialise le bot, lance un timer périodique pour `consumeMcpPending()` uniquement (plus de flush de queue, plus de loadQueue) | Exploration §6 Q1 | démarrage relay → timer MCP check actif |
| R7 | `isTypeEnabled()` et `isImmediate()` sont conservés dans `notification-prefs.ts` (utilisés par `/notify on/off/immediate`) | Exploration §3 — actifs réutilisables | |
| R8 | `NotificationPrefs` est réduit : supprimer `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold` — ne conserver que `types: Record<NotificationType, TypePrefs>` | Exploration §6 — à supprimer | |
| R9 | `/notify` conserve les sous-commandes `status`, `on TYPE`, `off TYPE`, `TYPE immediate` — supprime `quiet Xh-Yh` et `TYPE batch` (concept de batching disparu) | Exploration §6 | `/notify task off` → fonctionne ; `/notify quiet 22h-8h` → handler absent |
| R10 | `formatPrefs()` est adapté : affiche uniquement la liste des types (actif/immédiat/désactivé), sans section quiet hours ni batch | Dérivé R8 + R9 | `/notify status` → "PREFERENCES NOTIFICATIONS\nTypes :\n  task : immediat..." |
| R11 | Fonctions supprimées de `notification-queue.ts` : `formatDigest`, `formatMorningDigest`, `flushMorningDigest`, `flush`, `sendDigest`, `getQueue`, `loadQueue`, `saveQueue`, `TYPE_PRIORITY`, `TYPE_LABELS` ; constante `QUEUE_FILE` supprimée ; état mutable `queue[]` supprimé | Exploration §6 — à supprimer | |
| R12 | Fonctions supprimées de `notification-prefs.ts` : `isQuietHours` | Exploration §6 — à supprimer | |
| R13 | `heartbeat.ts` adapté : supprimer le bloc "Morning digest flush" (lignes 604-614), les imports `flushMorningDigest`, `isQuietHours`, `loadPrefs` (usage digest), `getQueue`, `loadQueue` ; conserver `enqueue` (utilisé pour alertes aux lignes 625 et 667) | Exploration §3 #3 | |
| R14 | `relay.ts` adapté : supprimer l'appel séparé `await loadPrefs()` (ligne 152) — déjà appelé dans `startQueue` | Exploration §3 #4 | |

---

## 3. Données d'entrée

| Source | Type | Accès | Champs |
|--------|------|-------|--------|
| Callsites `enqueue()` (8 fichiers) | `Omit<NotificationItem, "id"\|"createdAt">` | Appel direct fonction | `type: NotificationType`, `severity: "critical"\|"normal"`, `message: string`, `data?: { taskId?, taskStatus?, prUrl?, ideaId?, alertType? }` |
| Fichier MCP bridge | JSON array `mcp-pending-notifications.json` | `consumeMcpPending()` via `readFile` | `type`, `severity`, `message`, `data`, `createdAt` |
| Config prefs | JSON `config/notification-prefs.json` | `loadPrefs()` | `types: Record<NotificationType, TypePrefs>` (champs obsolètes ignorés au chargement) |
| Commande `/notify` | string `ctx.match` | Handler Telegram | `"status"`, `"on TYPE"`, `"off TYPE"`, `"TYPE immediate"` |

---

## 4. Données de sortie

**Notification Telegram directe** :
- Appel `bot.api.sendMessage(chatId, message, opts)` — immédiat à chaque `enqueue()` valide
- `opts.reply_markup` = inline keyboard si `getInlineKeyboard(item)` retourne une valeur
- `opts.message_thread_id` = threadId déterminé par `getThreadId(type)` si groupId configuré

**Config prefs persistée** (après `/notify on/off/immediate`) :
- Fichier `config/notification-prefs.json` — structure simplifiée :
```json
{
  "types": {
    "task":  { "enabled": true,  "immediate": false },
    "pr":    { "enabled": true,  "immediate": false },
    "idea":  { "enabled": true,  "immediate": false },
    "alert": { "enabled": true,  "immediate": true  }
  }
}
```

**Réponse `/notify status`** :
```
PREFERENCES NOTIFICATIONS

Types :
  task : batch
  pr : batch
  idea : batch
  alert : immediat
```
(Note : "batch" n'est plus qu'un label d'affichage indiquant que le type n'est pas en mode immédiat — les deux modes envoient maintenant immédiatement)

---

## 5. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/notification-queue.ts` | Modifier | Supprimer : `queue[]`, `QUEUE_FILE`, `loadQueue`, `saveQueue`, `flush`, `flushMorningDigest`, `formatDigest`, `formatMorningDigest`, `sendDigest`, `getQueue`, `TYPE_PRIORITY`, `TYPE_LABELS` ; Simplifier `enqueue` (always sendStandalone si non-disabled) ; Simplifier `startQueue` (timer MCP only, plus de loadQueue) |
| `src/notification-prefs.ts` | Modifier | Supprimer : `isQuietHours`, champs `quietStart`/`quietEnd`/`batchIntervalMs`/`batchThreshold` dans `NotificationPrefs` et `DEFAULT_PREFS` ; Adapter `formatPrefs` (types only) |
| `src/commands/profile.ts` | Modifier | Supprimer sous-commandes `/notify` : `quiet Xh-Yh` (handler + message d'aide) ; `TYPE batch` (handler) |
| `src/heartbeat.ts` | Modifier | Supprimer bloc digest (lignes 604-614) + imports `flushMorningDigest`, `isQuietHours`, `loadPrefs`, `getQueue`, `loadQueue` |
| `src/relay.ts` | Modifier | Supprimer l'appel séparé `await loadPrefs()` (ligne 152) et l'import `loadPrefs` si devenu inutilisé |
| `tests/unit/notification-queue.test.ts` | Modifier | Supprimer : tests `formatDigest`, `formatMorningDigest`, `flush` avec batching ; Adapter : `enqueue` (simplifier beforeEach — plus de batchThreshold) ; Conserver : `getInlineKeyboard`, `stopQueue` |
| `tests/unit/notification-prefs.test.ts` | Modifier | Supprimer : tests `isQuietHours` et assertions sur `batchThreshold`/`quietStart`/`quietEnd` ; Adapter : `formatPrefs` (retirer attentes quiet/batch) ; Conserver : `loadPrefs`, `savePrefs`, `isTypeEnabled`, `isImmediate` |
| `config/notification-prefs.json` | Modifier | Simplifier : supprimer champs obsolètes (`quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold`) |

---

## 6. Patterns existants

**Pattern `sendStandalone()` — envoi direct Telegram** (`src/notification-queue.ts:130-147`)
```typescript
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
→ La nouvelle `enqueue()` appellera toujours `sendStandalone` (sauf skip).

**Pattern `consumeMcpPending()` — bridge MCP** (`src/notification-queue.ts:311-337`)
→ Conservé intégralement. Pattern file-bridge : lit JSON, enfile chaque item valide, vide le fichier.

**Pattern `getInlineKeyboard()` — keyboards par type** (`src/notification-queue.ts:85-120`)
→ Conservé intégralement. Dispatche par type : task/pr/idea/alert → keyboards spécifiques.

**Pattern `isTypeEnabled()` / `isImmediate()`** (`src/notification-prefs.ts:78-84`)
→ Conservé. Lecture depuis cache `cachedPrefs`, fallback sur defaults.

**Pattern tests reset prefs** (`tests/unit/notification-queue.test.ts:168-180`)
```typescript
beforeEach(async () => {
  const prefs = getDefaultPrefs();
  prefs.quietStart = 0; prefs.quietEnd = 0; prefs.batchThreshold = 100;
  await savePrefs(prefs); await loadPrefs();
  while (getQueue().length > 0) getQueue().pop();
});
```
→ Après simplification : supprimer les champs obsolètes ; plus besoin de `while getQueue().pop()`.

---

## 7. Contraintes

1. **Interface `enqueue()` immuable** : signature `(item: Omit<NotificationItem, "id"|"createdAt">): Promise<void>` inchangée — 9 callsites dans 8 fichiers (`job-manager.ts`, `heartbeat.ts`, `prd-workflow.ts`, `memory/core.ts`, `memory/classification.ts`, `commands/memory-cmds.ts`, `commands/execution.ts`, `commands/tasks.ts`).

2. **Callbacks `notif_*` dans `utilities.ts` non touchés** : les handlers `notif_start`, `notif_done`, `notif_view`, `notif_viewtask`, `notif_promote`, `notif_archive`, `notif_dismiss`, `notif_sprint` sont indépendants du mécanisme de batching — aucune modification.

3. **`consumeMcpPending()` conservé** : seul mécanisme actif pour les notifications émises par le serveur MCP. Le timer dans `startQueue()` est le seul déclencheur.

4. **`bun test` doit passer** : les 3870+ tests existants doivent passer après modification. Les tests supprimés sont ceux couvrant des fonctions supprimées (formatDigest, isQuietHours, etc.).

5. **heartbeat.ts doit compiler** : le service est arrêté mais le code doit passer le typecheck. Supprimer toutes références aux fonctions supprimées.

6. **Pas de migration de données** : le fichier `notification-queue.json` (s'il existe) est simplement ignoré après la suppression de `loadQueue()`. En production la queue est vide, donc pas de perte.

7. **Backward compat config** : `loadPrefs()` doit ignorer silencieusement les champs `quietStart/quietEnd/batchIntervalMs/batchThreshold` présents dans un fichier de config existant (comportement déjà assuré par le spread `{...DEFAULT_PREFS, ...parsed}`).

---

## 8. Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|--------------|--------|
| V1 | `enqueue({type:"task", severity:"normal", message:"x"})` ne lève pas d'erreur et appelle `sendStandalone` immédiatement | Unit test : mock `sendStandalone`, vérifier appel | unit |
| V2 | Une notification de type désactivé (`isTypeEnabled === false`) n'appelle pas `sendStandalone` | Unit test : disable type, enqueue, mock sendStandalone → 0 appels | unit |
| V3 | Une notification `severity === "critical"` appelle `sendStandalone` même si type non-immediate | Unit test : mock sendStandalone, vérifier appel | unit |
| V4 | `getQueueSize()` retourne toujours 0 (plus de queue interne) | Unit test : after enqueue, getQueueSize() === 0 | unit |
| V5 | `isTypeEnabled("idea")` retourne `false` après `savePrefs({...idea: {enabled:false}})` | Unit test prefs | unit |
| V6 | `isImmediate("alert")` retourne `true` par défaut ; `isImmediate("task")` retourne `false` | Unit test prefs | unit |
| V7 | `getInlineKeyboard({type:"task", data:{taskId:"x", taskStatus:"backlog"}})` retourne un keyboard défini | Unit test | unit |
| V8 | `getInlineKeyboard({type:"task"})` retourne `undefined` (pas de data) | Unit test | unit |
| V9 | `/notify status` affiche les 4 types sans mention de "Quiet hours" ni "Batch interval" | Unit test : formatPrefs output ne contient pas "Quiet" ni "Batch" | unit |
| V10 | `/notify off idea` désactive les notifications idea (`isTypeEnabled("idea") === false`) | Unit test : handler profile.ts + isTypeEnabled | unit |
| V11 | `/notify on task` active les notifications task | Unit test : handler profile.ts + isTypeEnabled | unit |
| V12 | `/notify task immediate` met `immediate=true` pour task | Unit test : handler profile.ts + isImmediate | unit |
| V13 | `/notify quiet 22h-8h` ne correspond à aucun handler (réponse "Usage:" par défaut) | Unit test command routing | unit |
| V14 | `/notify task batch` ne correspond à aucun handler (réponse "Usage:" par défaut) | Unit test command routing | unit |
| V15 | `consumeMcpPending()` lit le fichier MCP, enqueue les items valides, vide le fichier | Unit test : mock readFile/writeFile | unit |
| V16 | `consumeMcpPending()` ignore silencieusement si le fichier MCP n'existe pas | Unit test : mock readFile → throw ENOENT | unit |
| V17 | `startQueue(bot)` démarre un timer qui appelle `consumeMcpPending()` périodiquement ; `stopQueue()` l'arrête | Integration test : mock setInterval/clearInterval | integration |
| V18 | `loadPrefs()` ignore les champs `quietStart/quietEnd/batchIntervalMs/batchThreshold` présents dans le fichier JSON existant | Unit test : writeFile avec ces champs + loadPrefs + getPrefs | unit |
| V19 | `tsc --noEmit` passe sans erreur après modification de tous les fichiers | CI typecheck | integration |
| V20 | `bun test` passe sans erreur (≥3870 tests) | CI run | integration |
| V21 | `heartbeat.ts` ne référence plus `flushMorningDigest`, `isQuietHours`, `getQueue`, `loadQueue` | `grep` sur heartbeat.ts | integration |

---

## 9. Coverage et zones d'ombre

### Matrice des dimensions

| Dimension | Couverture | Notes |
|-----------|------------|-------|
| **Problème** | Complet | Config prod (`0h-0h`, `batchThreshold:100`) + service heartbeat arrêté prouvent l'inactivité. Décision GO confirmée par l'exploration. |
| **Périmètre** | Complet | 2 modules core, 3 fichiers dépendants, 2 fichiers de tests, 1 config JSON. Callbacks `notif_*` (utilities.ts) hors périmètre — explicitement préservés. |
| **Validation** | Complet | 21 V-critères couvrant : enqueue directe, filtrage type, keyboards, prefs CRUD, /notify commands, MCP bridge, typecheck, CI. |
| **Technique** | Complet | Suppression pure de code mort + simplification de `enqueue()`. Aucune nouvelle dépendance. Interface publique inchangée. |

### Alternatives évaluées

| Option | Verdict | Raison |
|--------|---------|--------|
| A — Status quo | Rejetée | Maintient ~200 LOC de logique inactive, architecture trompeuse |
| **B — Suppression ciblée** (retenue) | **GO** | Préserve interface `enqueue()`, supprime inactif, risque faible |
| C — Envoi pur (supprimer les 2 modules) | Non retenue | Refactor plus large, risque de casser callsites, gain marginal vs B |

### Zones d'ombre résiduelles

1. **`relay.ts` ligne 152 `loadPrefs()`** : la règle R14 prescrit sa suppression car `startQueue` l'appelle déjà. À vérifier en lecture que ce n'est pas un appel intentionnel post-`initPipelineTracker`. Risque faible (appel idempotent).

2. **heartbeat.ts : `isQuietHours` autres usages ?** : l'exploration a identifié l'usage lignes 608-614 (bloc digest). L'implémenteur doit vérifier qu'il n'y a pas d'autre usage de `isQuietHours` dans heartbeat.ts hors de ce bloc avant suppression de l'import.

3. **Suppression de `getQueue()` et `getQueueSize()`** : `getQueueSize()` est exporté et peut être utilisé hors des fichiers explorés (ex: monitoring). Vérifier via `grep getQueueSize` avant suppression. `getQueue()` est utilisé dans heartbeat.ts (ligne 608) — supprimé avec le bloc digest.

4. **`formatPrefs()` libellé "batch"** : après suppression du batching, le statut d'un type non-`immediate` sera toujours affiché "batch" dans `formatPrefs()`. Ce libellé est trompeur mais acceptable pour la V1 — note à documenter en commentaire code ou à changer en "normal".
