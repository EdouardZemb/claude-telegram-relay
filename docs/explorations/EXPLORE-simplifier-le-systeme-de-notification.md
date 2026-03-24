---
phase: 0-explore
generated_at: "2026-03-24T00:00:00+01:00"
subject: "Simplifier le systeme de notification (supprimer digest et quiet hours)"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Probleme

Le systeme de notification a ete concu en S26 avec deux fonctionnalites sophistiquees :
- **Quiet hours** : fenetre de silence configurable (par defaut 20h-9h) pendant laquelle les notifications sont mises en queue au lieu d'etre envoyees directement, puis flushees au matin sous forme de digest.
- **Morning digest** : agregation des notifications accumulees pendant la nuit, formatees avec header temporel et regroupement par type.

Le constat est que ces deux fonctionnalites ne sont pas utilisees. Le bot est un outil personnel (usage solo, un seul utilisateur), et les notifications sont deja du type "envoyer quand ca se passe". Les quiet hours introduisent une complexite de gestion d'etat (file persistee sur disque, timer de flush, logique de detection heure/timezone) qui ne produit aucune valeur reelle.

L'objectif de cette exploration est de comprendre l'impact de leur suppression et d'identifier l'option la plus simple et la plus sure.

---

## Section 2 — Etat de l'art

Recherche externe limitee : ce sujet est specifique au domaine des bots Telegram personnels. Les patterns generaux de simplification de systemes de notification sont bien documentes.

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://core.telegram.org/bots/api#sendmessage (2026-03-24) | Doc officielle | 2026-03-24 | L'API Telegram est fire-and-forget, sans notion de quiet hours cote serveur. La gestion des plages de silence est entierement a la charge du client. | High |
| 2 | https://12factor.net/processes (2026-03-24) | Reference design | 2026-03-24 | Les processus stateless sont plus simples a maintenir. L'elimination de l'etat intermediaire (queue sur disque, timer) reduit la surface de bugs. | Med |

**Synthese** : pour un bot personnel monouser, envoyer la notification directement (sendStandalone) est le pattern le plus simple et le plus fiable. Le batching/digest a du sens pour des bots multi-users a fort volume. Ici le volume est faible (quelques evenements par sprint), et la latence zero est preferable a un digest decale. La suppression de quiet hours et digest aligne le systeme sur la realite d'usage.

---

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/notification-prefs.ts` (135 LOC) | Contient `isQuietHours`, `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold`, `loadPrefs`, `savePrefs`, `formatPrefs`. Quiet hours et batch sont les concepts centraux du module. | High |
| 2 | `src/notification-queue.ts` (370 LOC) | Contient `flushMorningDigest`, `formatMorningDigest`, `sendDigest`, `formatDigest`, la logique de batching dans `enqueue`, le timer de flush dans `startQueue`. Le module entier tourne autour du batching et des quiet hours. | High |
| 3 | `src/heartbeat.ts` | Appelle `isQuietHours()`, `flushMorningDigest()`, `loadQueue()`, `getQueue()` pour le flush du matin. | Med |
| 4 | `src/relay.ts` | Appelle uniquement `loadPrefs()` et `startQueue(bot)` au demarrage. | Low |
| 5 | `src/commands/profile.ts` (`/notify`) | Expose les sous-commandes `quiet Xh-Yh`, `TYPE immediate`, `TYPE batch` a l'utilisateur. Si digest/quiet hours disparaissent, ces sous-commandes disparaissent aussi. Reste : `on TYPE`, `off TYPE`, `status`. | Med |
| 6 | `src/commands/tasks.ts` | Appelle `enqueue()` uniquement — pas de dependance directe sur quiet hours. | Low |
| 7 | `src/commands/execution.ts` | Appelle `enqueue()` uniquement. | Low |
| 8 | `src/commands/memory-cmds.ts` | Appelle `enqueue()` uniquement. | Low |
| 9 | `src/job-manager.ts` | Appelle `enqueue()` uniquement. | Low |
| 10 | `src/prd-workflow.ts` | Appelle `enqueue()` uniquement. | Low |
| 11 | `src/memory/core.ts` | Appelle `enqueue()` uniquement. | Low |
| 12 | `src/memory/classification.ts` | Appelle `enqueue()` uniquement. | Low |
| 13 | `tests/unit/notification-queue.test.ts` (250 LOC) | Tests pour formatDigest, formatMorningDigest, getInlineKeyboard, enqueue, flush, queue lifecycle. | Med |
| 14 | `tests/unit/notification-prefs.test.ts` (170 LOC) | Tests pour loadPrefs, savePrefs, isTypeEnabled, isImmediate, isQuietHours, formatPrefs. | Med |
| 15 | `config/notification-prefs.json` | Fichier de persistance des prefs. Peut etre simplifie ou supprime. | Low |

**Points de friction** :
- La suppression de quiet hours/digest necessite de modifier `notification-queue.ts` (gros module), `notification-prefs.ts`, `heartbeat.ts`, `commands/profile.ts`, et les tests associes.
- Le concept de `batchThreshold` et `batchIntervalMs` disparait aussi : le timer dans `startQueue` n'a plus de raison d'etre si on ne bacthe plus.
- La notion d'`immediate` dans les prefs devient sans objet (toutes les notifs seraient immediate par construction).

**Actifs reutilisables** :
- `enqueue()` reste l'API publique — tous les appelants n'ont pas besoin de changer.
- `getInlineKeyboard()` est independant du batching — reste intact.
- `isTypeEnabled()` reste utile pour le on/off par type.
- La persistance de queue sur disque (`notification-queue.json`) peut etre supprimee.

---

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Suppression digest + quiet hours | C: Suppression totale du systeme de notif |
|---------|:------------:|:-----------------------------------:|:-----------------------------------------:|
| **Complexite** (obligatoire) | S (deja en place) | S (refactoring cible) | M (tous les appelants a adapter) |
| **Valeur ajoutee** (obligatoire) | Low (fonctionnalites inutilisees) | High (simplification reelle) | Low (perd les inline buttons et le on/off) |
| **Risque technique** (obligatoire) | Low | Low | Med |
| *Impact maintenance* | Neg (complexite inutile) | Pos (moins de code a maintenir) | Neg (perd des features utiles) |
| *Reversibilite* | N/A | High (peut reintroduire si besoin) | Low (difficile a reintroduire) |

**Discussion par option** :

**A — Status quo** : Le systeme fonctionne mais embarque 505 LOC de logique (prefs + queue) dont une partie significative sert uniquement le digest et les quiet hours. Maintenir ce code sans l'utiliser est une dette silencieuse.

**B — Suppression digest + quiet hours** : C'est l'option ciblee. `enqueue()` devient : verifier `isTypeEnabled`, envoyer directement via `sendStandalone`. Plus de timer, plus de queue persistee, plus de batching. Le `/notify` simplifie a `status`, `on TYPE`, `off TYPE`. Les tests restants couvrent l'essentiel. Reduction estimee : ~150-180 LOC supprimees sur les deux modules.

**C — Suppression totale** : Trop radical. Les inline buttons (actions rapides sur taches, PRs, idees) et le on/off par type ont de la valeur. Les appelants (`tasks.ts`, `execution.ts`, etc.) profitent du point d'integration unique.

---

## Section 5 — Verdict et justification

**Verdict : GO — Option B (suppression digest + quiet hours)**

**Justification** :

1. **Absence d'utilisation confirmee** : les quiet hours sont actives par defaut (20h-9h) mais l'utilisateur n'a pas configure de digest ni exprime le besoin. La complexite est presente sans retour.

2. **Alignement avec le modele d'usage** : bot personnel monouser, faible volume de notifications (quelques par sprint), latence zero preferable. Le digest ajoute une latence de plusieurs heures sans valeur perceptible.

3. **Simplification substantielle** : suppression d'environ 150-180 LOC, disparition du timer setInterval dans `startQueue`, elimination de la persistance queue sur disque, suppression de `flushMorningDigest`/`formatMorningDigest`/`sendDigest`/`formatDigest`, simplification du heartbeat (plus de flush morning).

4. **Risque faible** : tous les appelants de `enqueue()` restent inchanges. L'interface publique est preservee. Seule l'implementation interne de `enqueue` change (direct au lieu de queue). Les inline buttons et le on/off par type restent intacts.

5. **Reversibilite** : si les quiet hours deviennent utiles plus tard, elles peuvent etre reintroduites en moins d'une heure (le pattern est documente et connu).

---

## Section 6 — Input pour etape suivante

**Option recommandee** : B — Suppression digest + quiet hours, conservation de `enqueue` comme point d'integration avec `isTypeEnabled` + `sendStandalone` direct.

**Fichiers concernes** :
- `src/notification-queue.ts` : supprimer `formatDigest`, `formatMorningDigest`, `sendDigest`, `flushMorningDigest`, le timer dans `startQueue`, la logique de batching dans `enqueue`, `saveQueue`, `loadQueue` (si plus de persistance), `getQueue`/`getQueueSize` (si plus de queue)
- `src/notification-prefs.ts` : supprimer `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold`, `isQuietHours`, la partie "quiet hours" de `formatPrefs`; garder `types` (on/off/immediate), `loadPrefs`, `savePrefs`, `isTypeEnabled`, `isImmediate`
- `src/heartbeat.ts` : supprimer le bloc "Morning digest flush" (loadQueue + isQuietHours + flushMorningDigest)
- `src/commands/profile.ts` : simplifier `/notify` — supprimer les sous-commandes `quiet`, `immediate`, `batch`; garder `status`, `on TYPE`, `off TYPE`
- `tests/unit/notification-queue.test.ts` : supprimer les describe `formatDigest`, `formatMorningDigest`, `flush` (si flush disparait); adapter `enqueue`
- `tests/unit/notification-prefs.test.ts` : supprimer les tests `isQuietHours`, la partie quiet hours de `formatPrefs`

**Contraintes identifiees** :
- Garder `enqueue()` comme API publique inchangee (signature identique) pour ne pas toucher les 8+ appelants
- Garder `isTypeEnabled()` et le on/off par type — c'est une feature utile
- `startQueue()` peut rester mais ne lance plus de timer (ou le timer devient optionnel pour le MCP pending)
- Verifier si `consumeMcpPending` a encore besoin du timer ou peut etre appelé autrement

**Questions ouvertes** :
- Faut-il garder un timer minimal dans `startQueue` pour `consumeMcpPending` (bridge MCP) ou le deplacer dans le heartbeat ?
- La persistance `notification-queue.json` est-elle encore utile si plus de batching ? Probablement non.
- Faut-il garder `batchIntervalMs` dans les prefs pour un usage futur ou supprimer entierement l'interface `NotificationPrefs` et la remplacer par quelque chose de plus simple ?
