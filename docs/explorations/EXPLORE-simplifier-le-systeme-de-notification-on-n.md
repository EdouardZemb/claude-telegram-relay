---
phase: 0-explore
generated_at: "2026-03-24T00:00:00Z"
subject: "Simplifier le système de notification — on n'utilise pas le digest ni les quiet hours"
verdict: GO
next_step: "dev-implement"
---

## Section 1 — Problème

Le système de notification du projet comprend deux fichiers (`notification-queue.ts`, `notification-prefs.ts`) et expose des fonctionnalités de batching, digest du matin, quiet hours, et persistance JSON. Or, l'analyse de la configuration en production révèle que ces features sont **entièrement désactivées** :

- `quietStart: 0` et `quietEnd: 0` → `isQuietHours()` retourne toujours `false`
- `batchThreshold: 100` → seuil jamais atteint dans la pratique (9 callsites au total)
- Le service `claude-heartbeat` (PM2) est stoppé → `flushMorningDigest()` ne s'exécute jamais

Résultat : ~200-250 LOC de code de batching/digest/quiet hours sont maintenus sans jamais s'exécuter. Ce code mort augmente la complexité cognitive, ralentit l'onboarding, et représente une dette technique injustifiée au regard du principe YAGNI. Une exploration est nécessaire pour cadrer le périmètre exact de la simplification et évaluer le risque.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://xygeni.io/blog/yagni-and-secure-code-why-not-yet-can-save-you-from-bugs | Article | 2026-03-24 | YAGNI = principe de sécurité ET d'hygiène : le code mort crée des surfaces d'attaque silencieuses et affaiblit la lisibilité. Supprimer les routes, flags et fonctions inutilisés est recommandé dans les pipelines CI/CD. | ★★★★ |
| 2 | https://corner.buka.sh/yagni-the-key-to-simpler-more-maintainable-code | Article | 2026-03-24 | YAGNI : construire pour les besoins actuels, pas pour des besoins futurs hypothétiques. La complexité inutile augmente les risques de bugs et alourdit la maintenance. | ★★★ |
| 3 | https://www.linkedin.com/pulse/building-scalable-notification-batching-service-redis-mukesh-singh-jiihf | Article | 2026-03-24 | Recommande deux voies : notifications immédiates (haute priorité) et notifications batchées (groupées). Pour un usage mono-utilisateur personnel comme ce bot, la livraison immédiate est préférable au batching. | ★★★★ |

**Synthèse :**

Le principe YAGNI est unanimement reconnu comme une pratique saine : ne pas maintenir de code pour des besoins hypothétiques futurs. Quand une feature est désactivée en production depuis plusieurs sprints, sa suppression est préférable à sa maintenance coûteuse.

Pour les bots Telegram personnels (mono-utilisateur), l'envoi immédiat est le pattern dominant. Le batching et les digest sont des patterns adaptés aux systèmes multi-utilisateurs à fort volume (email marketing, alerting distribué) — pas à un orchestrateur personnel de tâches.

L'article sur le notification batching Redis confirme qu'un système de notification réellement utile pour le cas d'usage de ce bot doit prioriser : (1) livraison immédiate avec filtrage par type, (2) inline keyboards pour actions rapides. Ces deux features sont déjà implémentées et fonctionnelles.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/notification-queue.ts` (370 LOC) | Contient batching, quiet hours, digest, persistance JSON, MCP bridge. Environ 200-250 LOC de code mort (flush, formatDigest, formatMorningDigest, flushMorningDigest, timer, saveQueue/loadQueue). | ★★★★ |
| 2 | `src/notification-prefs.ts` (135 LOC) | Contient isQuietHours, isImmediate, isTypeEnabled, formatPrefs. Les champs quietStart/quietEnd/batchIntervalMs/batchThreshold sont dead config. | ★★★ |
| 3 | `src/heartbeat.ts` | Importe flushMorningDigest, getQueue, loadQueue, isQuietHours — uniquement pour le digest du matin. Service stoppé en PM2. | ★★★ |
| 4 | `src/relay.ts` | Appelle startQueue(mainBot) : initialise timer 5 min + loadPrefs. Le timer ne sert à rien si batchThreshold=100 et quiet hours désactivées. | ★★ |
| 5 | `src/commands/profile.ts` | Commande /notify expose quiet, TYPE batch — jamais utilisés selon la config. | ★★ |
| 6 | `src/commands/tasks.ts` | 2 callsites enqueue() — conservés | ★ |
| 7 | `src/commands/execution.ts` | 2 callsites enqueue() — conservés | ★ |
| 8 | `src/commands/memory-cmds.ts` | 3 callsites enqueue() — conservés | ★ |
| 9 | `src/job-manager.ts` | 1 callsite enqueue() — conservé | ★ |
| 10 | `src/prd-workflow.ts` | 1 callsite enqueue() — conservé | ★ |
| 11 | `src/memory/core.ts` | 1 callsite enqueue() — conservé | ★ |
| 12 | `src/memory/classification.ts` | 1 callsite enqueue() — conservé | ★ |
| 13 | `src/commands/utilities.ts` | Callbacks notif_* — conservés (inline keyboards) | ★ |
| 14 | `config/notification-prefs.json` | Config prod : quietStart=0, quietEnd=0, batchThreshold=100 | ★★★★ |

**Points de friction :**
- heartbeat.ts dépend de `flushMorningDigest`, `getQueue`, `loadQueue` → ces imports devront être supprimés ou simplifiés si le service est relancé un jour
- L'interface `enqueue()` est bien établie (9 callsites) — à conserver absolument sans modification de signature

**Actifs réutilisables :**
- `enqueue()` — API publique solide, tous les callsites l'utilisent correctement
- `getInlineKeyboard()` — génère les boutons contextuels, utile et bien isolé
- `isTypeEnabled()` — filtre per-type, simple et fonctionnel
- Callbacks `notif_*` dans utilities.ts — indépendants du batching, à conserver

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Suppression digest+quiet hours | C: Suppression totale queue |
|---------|:------------:|:-----------:|:-----------:|
| **Complexité** | S | M | M |
| **Valeur ajoutée** | Low | High | Med |
| **Risque technique** | Low | Low | Med |
| *Impact maintenance* | Négatif (dette croissante) | Positif (-200 LOC) | Positif (-370 LOC) |
| *Réversibilité* | N/A | Haute (git) | Moyenne (9 callsites à revoir) |

**Option A — Status quo :**
Maintenir le code tel quel. Aucun risque à court terme mais dette technique croissante : tout nouveau développeur doit comprendre un système de batching/digest qui ne fait rien. Le risque augmente si quelqu'un réactive le heartbeat sans comprendre que quiet hours sont à 0h-0h.

**Option B — Suppression digest + quiet hours (recommandée) :**
Supprimer `formatDigest`, `formatMorningDigest`, `flushMorningDigest`, `isQuietHours`, le timer de batching, la persistance JSON, les champs dead config. Conserver `enqueue()` avec envoi immédiat direct, `isTypeEnabled()`, `getInlineKeyboard()`. Simplifier `/notify` (supprimer `quiet` et `batch`). Les 9 callsites `enqueue()` restent inchangés. Risque faible — supprimer du code mort n'introduit pas de régression.

**Option C — Suppression totale du système de queue :**
Remplacer `enqueue()` par un `sendNotification()` direct sans file d'attente. Élimine la totalité des deux fichiers mais nécessite de modifier les 9 callsites et de revoir l'interface MCP bridge. Plus risqué et moins nécessaire — `enqueue()` en mode passthrough est une interface propre qu'il vaut mieux conserver.

---

## Section 5 — Verdict et justification

**Verdict : GO — Option B (suppression digest + quiet hours)**

La configuration production confirme que les quiet hours (`quietStart: 0, quietEnd: 0`) et le batching (`batchThreshold: 100`) sont désactivés de facto depuis plusieurs sprints. Le service heartbeat qui déclenche `flushMorningDigest()` est stoppé en PM2. Ces features ne servent pas l'usage réel du bot : un orchestrateur personnel mono-utilisateur bénéficie d'un envoi immédiat, pas de digest groupés.

Les sources externes (principe YAGNI, article batching Redis) confirment que maintenir du code complexe pour un besoin hypothétique futur est une antipattern. À l'inverse, l'interface `enqueue()` est bien établie avec 9 callsites et son maintien en mode passthrough (envoi immédiat + filtrage par type) est la simplification la plus sûre.

Le risque de l'option B est faible : supprimer du code mort ne peut pas causer de régression sur des features actives, et la réversibilité est totale via git. Le gain est significatif : ~200-250 LOC supprimés, réduction de la complexité cognitive, suppression du timer setInterval qui tourne inutilement toutes les 5 minutes.

---

## Section 6 — Input pour étape suivante

**Option recommandée :** B — Suppression digest + quiet hours, conservation de l'interface `enqueue()`

**Fichiers concernés :**
- `src/notification-queue.ts` — supprimer : `formatDigest`, `formatMorningDigest`, `flushMorningDigest`, `flush`, `saveQueue`, `loadQueue`, timer setInterval, logique quiet hours dans `enqueue()`. Simplifier `startQueue()` (plus de timer, juste init bot). L'`enqueue()` devient un envoi immédiat direct.
- `src/notification-prefs.ts` — supprimer : `isQuietHours()`. Supprimer champs `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold` de l'interface et du JSON par défaut.
- `src/heartbeat.ts` — supprimer les imports `flushMorningDigest`, `getQueue`, `loadQueue`, `isQuietHours`. Nettoyer la logique digest du matin (lignes ~604-614).
- `src/relay.ts` — simplifier `startQueue()` call (plus de timer à gérer).
- `src/commands/profile.ts` — supprimer sous-commandes `/notify quiet` et `/notify TYPE batch`.
- `config/notification-prefs.json` — supprimer champs `quietStart`, `quietEnd`, `batchIntervalMs`, `batchThreshold`.

**Contraintes identifiées :**
- Les 9 callsites `enqueue()` ne doivent PAS être modifiés (interface stable)
- Les callbacks `notif_*` dans utilities.ts ne sont pas touchés
- `isTypeEnabled()` et `getInlineKeyboard()` sont à conserver
- Tests existants sur notification-queue à mettre à jour/supprimer selon la surface retirée

**Questions ouvertes pour l'implémentation :**
- Le MCP bridge `consumeMcpPending()` : le conserver dans `startQueue()` avec un simple setInterval dédié, ou migrer vers un autre mécanisme ?
- La persistance de la queue : si on conserve `enqueue()` en mode immédiat, il n'y a plus besoin de `loadQueue()` au démarrage — mais vérifier s'il y a une queue non-flushée à vider avant suppression.

---

## Verdict

GO

Suppression ciblée de ~200-250 LOC de code mort (digest, quiet hours, batching) sans modifier l'interface `enqueue()`. Risque technique faible, gain de lisibilité élevé, aligné YAGNI. Option B recommandée.
