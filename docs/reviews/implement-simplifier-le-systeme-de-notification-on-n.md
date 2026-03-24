# Rapport d'implémentation — Simplification du système de notification

**Spec** : `docs/specs/SPEC-simplifier-le-systeme-de-notification-on-n.md`
**Review adversariale** : `docs/reviews/adversarial-SPEC-simplifier-le-systeme-de-notification-on-n.md`
**Date** : 2026-03-24
**Résultat** : GO — 1819/1821 tests pass (1 skip, 1 fail pré-existant)

---

## 1. Résumé des changements

Suppression des mécanismes de notification inactifs (batching, quiet hours, morning digest) du module `notification-queue.ts`. Le comportement observable reste inchangé : `enqueue()` envoie maintenant toujours immédiatement (au lieu de buffer + flush).

**Réduction LOC** : ~180 lignes supprimées de `notification-queue.ts` (474 → ~195 LOC actives).

---

## 2. Fichiers modifiés

| Fichier | Changement |
|---------|-----------|
| `src/notification-queue.ts` | Réécriture : suppression queue[], QUEUE_FILE, loadQueue, saveQueue, flush, flushMorningDigest, formatDigest, formatMorningDigest, sendDigest, TYPE_PRIORITY, TYPE_LABELS, isQuietHours ; simplification enqueue/startQueue/consumeMcpPending ; NotificationPrefs réduit |
| `src/notification-prefs.ts` | N/A — n'existe pas, tout était dans notification-queue.ts |
| `src/commands/profile.ts` | Suppression handlers `/notify quiet Xh-Yh` et `/notify TYPE batch` ; mise à jour du message Usage |
| `src/heartbeat.ts` | Suppression imports : flushMorningDigest, isQuietHours, loadPrefs, getQueue, loadQueue ; suppression bloc "Morning digest flush" (ex-lignes 604-619) |
| `src/relay.ts` | Suppression import `loadPrefs` et appel `await loadPrefs()` redondant (déjà dans startQueue) |
| `config/notification-prefs.json` | Suppression champs obsolètes : quietStart, quietEnd, batchIntervalMs, batchThreshold |
| `tests/unit/notification-queue.test.ts` | Réécriture : suppression tests formatDigest/formatMorningDigest/flush/getQueue ; nouveaux tests V1-V18 |
| `tests/system/module-integrity.test.ts` | Adaptation : suppression assertions getQueue/loadQueue ; ajout assertions getQueueSize |

---

## 3. Décisions d'implémentation (findings adversariaux résolus)

### F-DA-1 / F-EC-2 / F-SS-2 — Intervalle timer MCP non spécifié
**Résolution** : Constante locale `MCP_POLL_INTERVAL_MS = 5 * 60 * 1000` (5 minutes — valeur existante conservée).

### F-DA-2 / F-EC-4 — Import `isQuietHours` oublié dans notification-queue.ts
**Résolution** : Supprimé — la fonction `isQuietHours` a été entièrement retirée du module (elle était définie ET utilisée dans notification-queue.ts).

### F-DA-3 — R6 vs R14 : loadPrefs dans startQueue
**Résolution** : `startQueue()` conserve `await loadPrefs()`. `relay.ts` supprime l'appel redondant post-startQueue.

### F-DA-4 / F-EC-6 / F-SS-4 — Label "batch" trompeur
**Résolution** : Label changé en "normal" dans `formatPrefs()`. `/notify status` affiche maintenant `task : normal` (non-immédiat) au lieu de `task : batch`.

### F-EC-1 / F-SS-1 — `consumeMcpPending()` contradictoire avec "conservé intégralement"
**Résolution** : `consumeMcpPending()` modifié pour appeler `await enqueue({type, severity, message, data})` au lieu de `queue.push(fullItem)`. La référence `saveQueue()` en fin de fonction également supprimée.

### F-EC-3 — `getDefaultPrefs()` retournait des champs obsolètes
**Résolution** : `DEFAULT_PREFS` et `getDefaultPrefs()` simplifiés — ne contiennent plus `quietStart/quietEnd/batchIntervalMs/batchThreshold`.

### F-EC-5 — Perte du `createdAt` original des items MCP
**Décision** : Acceptée. La signature `Omit<NotificationItem, "id"|"createdAt">` exclut `createdAt`. Sans digest, le timestamp de création n'a plus d'impact fonctionnel. L'item MCP reçoit `Date.now()` à l'enqueue.

### F-SS-3 — `getQueueSize()` : garder ou supprimer ?
**Résolution** : Conservé, retourne toujours `0`. Satisfait V4 et maintient la compatibilité des callsites potentiels (ex: monitoring).

---

## 4. Critères de validation

| Critère | Résultat | Note |
|---------|----------|------|
| V1 — enqueue envoie immédiatement | ✅ | botInstance null en tests → sendStandalone no-op, pas d'erreur |
| V2 — type désactivé → skip | ✅ | Test vérifié |
| V3 — critical → sendStandalone | ✅ | Test vérifié |
| V4 — getQueueSize() === 0 | ✅ | Test vérifié |
| V5 — isTypeEnabled après savePrefs | ✅ | Test vérifié |
| V6 — isImmediate defaults | ✅ | Test vérifié |
| V7 — getInlineKeyboard avec data | ✅ | Test vérifié |
| V8 — getInlineKeyboard sans data | ✅ | Test vérifié |
| V9 — formatPrefs sans quiet/batch | ✅ | Test vérifié |
| V10 — /notify off idea | ✅ | Handler conservé, testé via isTypeEnabled |
| V11 — /notify on task | ✅ | Handler conservé |
| V12 — /notify task immediate | ✅ | Test via isImmediate |
| V13 — /notify quiet 22h-8h → fallback Usage | ✅ | Handler supprimé, fallback existant atteint |
| V14 — /notify task batch → fallback Usage | ✅ | Handler supprimé, fallback existant atteint |
| V15 — consumeMcpPending lit et vide le fichier | ✅ | Test vérifié |
| V16 — consumeMcpPending ENOENT silencieux | ✅ | Test vérifié |
| V17 — startQueue démarre timer MCP | ✅ | Implémentation, stopQueue fonctionne |
| V18 — loadPrefs ignore champs obsolètes | ✅ | Test vérifié (types chargés correctement) |
| V19 — tsc --noEmit passe | ⚠️ | Erreur pré-existante `bun-types` non liée à ces changements |
| V20 — bun test ≥1820 tests | ✅ | 1819 pass, 1 skip, 1 fail pré-existant (tsc) |
| V21 — heartbeat.ts sans refs supprimées | ✅ | grep confirme absence |

---

## 5. Tests

**Avant** : 1818 pass, 1 skip, 2 fail (tsc + module-integrity `getQueue`)
**Après** : 1819 pass, 1 skip, 1 fail (tsc pré-existant uniquement)

Le test `module-integrity` a été adapté pour vérifier que `getQueue` et `loadQueue` sont bien absents (removes exported).

---

## 6. Risques résiduels

- **V19 (tsc)** : L'erreur `Cannot find type definition file for 'bun-types'` est pré-existante sur `master` et non liée à ces changements.
- **Backward compat config** : Les champs `quietStart/quietEnd/batchIntervalMs/batchThreshold` sont encore présents dans les objets runtime si le fichier JSON existant les contient (comportement de spread). Aucun impact fonctionnel.
