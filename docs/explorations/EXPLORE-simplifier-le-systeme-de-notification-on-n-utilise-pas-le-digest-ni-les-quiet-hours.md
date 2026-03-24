---
phase: 0-explore
generated_at: "2026-03-24T10:00:00+01:00"
subject: "Simplifier le systeme de notification (digest et quiet hours inutilises)"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Probleme

Le systeme de notification (S26) a ete concu avec trois mecanismes sophistiques : batching avec seuil, quiet hours (heures de silence), et morning digest (resume du matin). L'hypothese initiale etait qu'un utilisateur unique (Edouard, Europe/Paris) voudrait eviter les interruptions la nuit et recevoir un digest consolide le matin.

A l'usage, deux constats s'imposent :

1. **Le digest est mort** : le service `claude-heartbeat` (seul appelant de `flushMorningDigest`) est arrete (`pm2 list` ne le montre pas en `online`). Le digest matin ne se declenche jamais.

2. **Les quiet hours sont desactivees en pratique** : le fichier `config/notification-prefs.json` en production contient `quietStart: 0, quietEnd: 0`, ce qui correspond exactement au cas `quietStart === quietEnd → return false` dans `isQuietHours()`. Les notifications passent donc toujours immediacement.

3. **Le seuil de batch est maximaliste** : `batchThreshold: 100` — il faudrait 100 notifications pour declencher un flush automatique. En usage reel, ce seuil n'est jamais atteint.

L'exploration vise a determiner si on peut supprimer ces mecanismes inutilises pour simplifier le code (~505 LOC), reduire la surface de maintenance, et eliminer des dependances croisees entre modules (`heartbeat.ts`, `notification-queue.ts`, `notification-prefs.ts`).

---

## Section 2 — Etat de l'art

L'exploration externe porte sur les patterns de simplification de systemes de notification dans les bots Telegram mono-utilisateur.

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | Non couvert — sujet trop specifique aux bots Telegram mono-utilisateur | — | — | Aucune source externe pertinente trouvee | — |

**Degradation gracieuse** : L'axe 1 est marque "Non couvert — sources externes indisponibles". Le sujet (simplification d'un systeme de notification maison pour un usage mono-utilisateur) n'a pas d'equivalent significatif dans la litterature publique. Le verdict ne peut pas etre GO sur la base de l'axe 1 seul — mais les axes 2 et 3 (archeologie codebase) sont suffisamment solides pour justifier un GO avec l'analyse interne.

**Raisonnement contextuel** : Les patterns generaux de notification (batching, quiet hours) sont bien documentes dans les SDKs de push notification (Firebase, APNS), mais ces patterns ciblent des applications multi-utilisateurs avec des exigences de delivery garantie. Pour un bot mono-utilisateur synchrone (l'utilisateur voit les messages Telegram en temps reel), le batching et les quiet hours ajoutent de la complexite sans benefice observable.

---

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/notification-queue.ts` | 370 LOC. Contient: `enqueue`, `flush`, `flushMorningDigest`, `formatDigest`, `formatMorningDigest`, `getInlineKeyboard`, `consumeMcpPending`, `startQueue`, `stopQueue`. Les fonctions `flushMorningDigest` et `formatMorningDigest` ne sont appelees que par `heartbeat.ts` (service arrete). | Haut |
| 2 | `src/notification-prefs.ts` | 135 LOC. Contient: `loadPrefs`, `savePrefs`, `getPrefs`, `isTypeEnabled`, `isImmediate`, `isQuietHours`, `formatPrefs`. `isQuietHours` est appele dans `notification-queue.ts` et `heartbeat.ts`. La config actuelle neutralise completement `isQuietHours` (0h-0h). | Haut |
| 3 | `src/heartbeat.ts` | Importe `flushMorningDigest`, `isQuietHours`, `loadPrefs`, `enqueue`. Service `claude-heartbeat` actuellement **arrete** dans PM2. Le digest matin ne se declenche jamais. | Moyen |
| 4 | `src/relay.ts` | Appelle `startQueue(mainBot)` et `loadPrefs()` au demarrage. Si on supprime le batching, `startQueue` peut etre remplace par une simple initialisation du bot. | Moyen |
| 5 | `src/commands/profile.ts` | Implemente `/notify` avec sous-commandes: `quiet Xh-Yh`, `on TYPE`, `off TYPE`, `TYPE immediate`, `TYPE batch`. Les sous-commandes `quiet` et `batch` deviendraient obsoletes. | Moyen |
| 6 | `src/commands/utilities.ts` | Contient les callbacks `notif_*` (notif_start, notif_done, notif_view, notif_promote, notif_archive, notif_dismiss, notif_sprint, notif_viewtask). Ces callbacks sont lies aux **inline keyboards** des notifications, pas au batching — a conserver. | Faible |
| 7 | `src/job-manager.ts` | Appelle `enqueue()` pour notifier la fin de jobs. Usage valide, a conserver. | Faible |
| 8 | `src/memory/core.ts` | Appelle `enqueue()` pour les nouvelles idees (intent-tag). Usage valide, a conserver. | Faible |
| 9 | `src/memory/classification.ts` | Appelle `enqueue()` pour les idees auto-detectees. Usage valide, a conserver. | Faible |
| 10 | `src/commands/tasks.ts` | Appelle `enqueue()` pour tache demarree/terminee. Usage valide. | Faible |
| 11 | `src/commands/execution.ts` | Appelle `enqueue()` pour PR creee et tache terminee. Usage valide. | Faible |
| 12 | `src/commands/memory-cmds.ts` | Appelle `enqueue()` pour idees manuelles et promotions. Usage valide. | Faible |
| 13 | `src/prd-workflow.ts` | Appelle `enqueue()` pour evenements PRD. Usage valide. | Faible |
| 14 | `tests/unit/notification-prefs.test.ts` | 170 LOC de tests. Les tests de `isQuietHours`, `formatPrefs` (qui inclut quiet hours), `batchThreshold` seraient a adapter/supprimer. | Faible |
| 15 | `tests/unit/notification-queue.test.ts` | 250 LOC de tests. Les tests de `formatMorningDigest`, `flush` avec batching, `enqueue` avec quiet hours seraient a adapter. | Faible |
| 16 | `config/notification-prefs.json` | Config actuelle: `quietStart:0, quietEnd:0, batchThreshold:100`. Confirme que les deux features sont inactives en production. | Informatif |

**Points de friction** :
- 9 callsites de `enqueue()` a travers 8 fichiers — l'interface `enqueue()` est necessaire et doit etre conservee
- Les tests de `notification-prefs` et `notification-queue` couvrent actuellement des fonctionnalites a supprimer (~60% des tests)
- Le `/notify` command expose `quiet` et `batch` sub-commands qui deviendraient obsoletes

**Actifs reutilisables** :
- L'interface `enqueue()` est bien etablie, tous les callsites peuvent rester inchanges
- Les callbacks `notif_*` dans `utilities.ts` sont independants du mecanisme de batching
- `getInlineKeyboard()` peut etre conserve tel quel
- `isTypeEnabled()` (activation/desactivation par type) reste pertinente

---

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Supprimer digest+quiet hours uniquement | C: Remplacer par envoi immediat pur |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S (garder tel quel) | M (refactoring cible) | S (logique simple) |
| **Valeur ajoutee** (obligatoire) | Low (code mort maintenu) | High (simplification reelle) | High (maximum simplicite) |
| **Risque technique** (obligatoire) | Low (pas de changement) | Low (interface enqueue preservee) | Low (suppression code mort) |
| *Impact maintenance* (pertinent) | Negatif (505 LOC de complexite inutile) | Positif (reduction ~200 LOC) | Positif (reduction ~300 LOC) |
| *Reversibilite* (pertinent) | N/A | Facile (git revert) | Facile (git revert) |

**Discussion par option** :

**Option A — Status quo** : Maintenir le systeme tel quel. Le code est correct et les tests passent. Mais on maintient ~200-300 LOC de logique inactive (quiet hours, digest, batching complexe) qui cree de la confusion sur l'architecture reelle. La config actuelle neutralise completement les features avancees, donc le code est trompeur.

**Option B — Supprimer digest et quiet hours uniquement** : Conserver le module `notification-queue.ts` mais supprimer `flushMorningDigest`, `formatMorningDigest`, la logique de batching dans `startQueue`, et simplifier `enqueue` pour envoyer toujours immediatement (pour les types non-immediate, envoyer avec un leger delai ou directement). Conserver `isTypeEnabled()` et les inline keyboards. Adapter `notification-prefs.ts` pour ne plus contenir `quietStart/quietEnd/batchIntervalMs/batchThreshold`. Adapter `/notify` pour ne plus exposer `quiet` et `batch`. **Option recommandee** : equilibre entre simplification et preservation de l'API existante.

**Option C — Remplacer par envoi immediat pur** : Supprimer les deux modules `notification-queue.ts` et `notification-prefs.ts`, remplacer `enqueue()` par une fonction simple qui envoie directement via le bot ou ecrit dans un fichier MCP. Conserver `isTypeEnabled` comme simple boolean. Maximise la simplification mais necessite de refactorer plus de callsites. Risque plus eleve car l'interface change.

---

## Section 5 — Verdict et justification

**GO** — Option B recommandee : supprimer digest, quiet hours, et batching complexe.

La justification repose sur trois elements convergents :

1. **Preuve empirique par la config** : `config/notification-prefs.json` en production montre `quietStart:0, quietEnd:0` et `batchThreshold:100`. L'utilisateur a explicitement configure le systeme pour desactiver les quiet hours et rendre le batch pratiquement impossible. Ce n'est pas un oubli — c'est un signal clair que ces features ne sont pas utilisees.

2. **Service heartbeat arrete** : Le seul appelant de `flushMorningDigest()` est `claude-heartbeat`, service actuellement non-running dans PM2. Le digest matin ne peut pas fonctionner dans la configuration actuelle. Maintenir ce code cree une illusion de fonctionnalite.

3. **Rapport benefice/cout favorable** : La suppression de ~200 LOC de logique inactive (quiet hours, digest, batching avec seuil, persistence JSON de la queue) simplifie significativement le systeme sans impact sur les fonctionnalites actives. L'interface `enqueue()` et les inline keyboards `notif_*` restent intactes. Les 9 callsites existants ne changent pas.

L'absence de sources externes (axe 1 non couvert) ne change pas le verdict car l'analyse interne est conclusive : le code est factuellement inactif et la configuration actuelle le confirme.

---

## Section 6 — Input pour etape suivante

**Option recommandee** : Option B — Supprimer digest, quiet hours, batching complexe

**Fichiers concernes** :
- `/home/edouard/claude-telegram-relay/src/notification-queue.ts` — a simplifier (~200 LOC a supprimer)
- `/home/edouard/claude-telegram-relay/src/notification-prefs.ts` — a simplifier (supprimer quiet hours, batch fields)
- `/home/edouard/claude-telegram-relay/src/commands/profile.ts` — adapter `/notify` (retirer sous-commandes `quiet` et `batch`)
- `/home/edouard/claude-telegram-relay/src/heartbeat.ts` — supprimer imports `flushMorningDigest`, `isQuietHours`, `loadPrefs` (usage digest)
- `/home/edouard/claude-telegram-relay/src/relay.ts` — simplifier `startQueue` (plus besoin du timer)
- `/home/edouard/claude-telegram-relay/tests/unit/notification-prefs.test.ts` — adapter tests
- `/home/edouard/claude-telegram-relay/tests/unit/notification-queue.test.ts` — adapter tests
- `/home/edouard/claude-telegram-relay/config/notification-prefs.json` — simplifier (supprimer champs obsoletes)

**Contraintes identifiees** :
- L'interface `enqueue(item)` DOIT rester identique — 9 callsites l'utilisent sans modification
- Les callbacks `notif_*` dans `utilities.ts` sont independants du batching — a conserver tel quel
- `getInlineKeyboard()` doit etre conserve (utilise dans `sendStandalone`)
- `isTypeEnabled()` doit etre conserve (filtre par type dans `enqueue`)
- `consumeMcpPending()` (bridge MCP via fichier JSON) est a conserver — c'est le seul mecanisme actif pour les notifications MCP

**Ce qui peut etre supprime** :
- `formatDigest()`, `formatMorningDigest()`, `flushMorningDigest()`
- `isQuietHours()`, `loadPrefs()`, `savePrefs()`, `formatPrefs()`, `batchIntervalMs`, `batchThreshold`, `quietStart`, `quietEnd`
- La persistence JSON de la queue (`QUEUE_FILE`, `loadQueue()`, `saveQueue()`)
- Le timer dans `startQueue()` (remplace par un simple check MCP periodic ou supprime)
- Les sous-commandes `/notify quiet` et `/notify TYPE batch` dans `profile.ts`
- Les tests correspondants dans `notification-prefs.test.ts` et `notification-queue.test.ts`

**Nouveau comportement de `enqueue()`** :
- Si type desactive → skip (identique)
- Si `severity === "critical"` ou `isImmediate(type)` → envoi immediat (identique)
- Sinon → envoi immediat aussi (suppression du batching, simplification)

**Questions ouvertes pour la spec** :
- Faut-il conserver `consumeMcpPending()` avec son timer, ou migrer vers un check explicite au moment de l'enqueue ?
- La suppression du fichier `notification-queue.json` (persistence) pose-t-elle un probleme si la queue a des items en attente lors du redemarrage ? (Reponse probable: non, la queue est vide en production)
- Faut-il garder un module `notification-prefs.ts` reduit (juste `isTypeEnabled` + `isImmediate`) ou l'inliner dans `notification-queue.ts` ?

## Verdict

GO
Simplification justifiee par la configuration production (quiet hours a 0h-0h, batchThreshold a 100) et le service heartbeat arrete. L'interface enqueue() et les inline keyboards restent intacts. Reduction estimee: ~200-250 LOC actives supprimees, complexite architecturale reduite.
