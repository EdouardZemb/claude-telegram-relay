---
phase: 0-explore
generated_at: "2026-03-22T12:00:00Z"
subject: "Migrer tous les console.log/error/warn du codebase vers le module logger structuré src/logger.ts"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

Le codebase utilise actuellement 242 appels directs à `console.log`, `console.error` et `console.warn` répartis dans 42 fichiers source (hors `logger.ts` lui-même). Ces appels produisent des sorties non structurées, sans timestamp normalisé, sans `module` identifier, sans `correlation_id`, et sans niveau de filtrage configurable.

Le module `src/logger.ts` a été créé lors d'un sprint récent et expose `createLogger(moduleName)` (retourne `debug/info/warn/error`) ainsi que `withCorrelation` pour la propagation des correlation IDs. Trois fichiers pilotes (`relay.ts`, `orchestrator.ts`, `agent.ts`) ont déjà migré et servent de référence. Le test `tests/unit/logger-migration.test.ts` vérifie que ces trois fichiers n'ont plus de console direct.

L'exploration est nécessaire avant la spec pour : (1) quantifier exactement les patterns de migration, (2) identifier les défis non triviaux (heartbeat timestamps redondants, arguments multiples, `.catch(err => console.error(...))` inline), et (3) choisir une stratégie incrémentale adaptée aux 42 fichiers restants sans casser les 2816 tests.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/ | Guide | 2026-03-22 | Migration incrémentale depuis console.log : commencer par les chemins critiques (error handlers), utiliser les child loggers pour le contexte, environment variable pour contrôler le niveau. Passer l'error en premier arg pour capturer le stack trace. | High |
| 2 | https://martinfowler.com/articles/codemods-api-refactoring.html | Article technique | 2026-03-22 | Codemods AST pour refactoring d'API à grande échelle : décomposer en transformations atomiques, tester chaque pattern couvert, insérer des TODO pour les cas ambigus. Préférer les migrations incrémentales aux big-bang. | High |

**Synthèse des enseignements :**

La migration de `console.*` vers un logger structuré est un refactoring courant dans les codebases Node.js/TypeScript de taille moyenne. L'état de l'art recommande une approche incrémentale par vague plutôt qu'un changement global en une fois.

Le pattern de référence pour les error objects est `logger.error("msg", { error: e.message, stack: e.stack })` — Pino et la plupart des loggers structurés préconisent que le message reste une string et que les données contextuelles passent en objet metadata. C'est exactement l'API exposée par `src/logger.ts` : `log.error("msg", { key: value })`.

Pour les cas `console.error("label:", error)` (deux arguments), la convention est de passer l'error en metadata : `log.error("label", { error: String(error) })`. Cette transformation est mécanique et systématisable.

Les codemods AST (jscodeshift, ast-grep) permettent d'automatiser les cas simples (~75% du volume) mais les cas complexes (multi-ligne, `.catch(err => console.error(...))` inline, templates avec `[${timestamp}]` préfixant déjà le timestamp) nécessitent une migration manuelle raisonnée.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/memory.ts` | 38 appels — plus grand volume. Dominé par `console.error("label:", error)` (pattern P2). Quelques `console.log(...)` pour déduplication et contradiction detection (informationnel → `log.info`). Pas d'import logger. | High |
| 2 | `src/heartbeat.ts` | 35 appels — pattern spécial : préfixe `[${timestamp}]` répété sur chaque appel (`console.log(\`[${timestamp}] ...\``). Le structured logger ajoute déjà un timestamp → double timestamp à supprimer. Module autonome (PM2 process), bénéficie le plus de structured logs. | High |
| 3 | `src/documents.ts` | 23 appels — mélange `console.error` (Supabase errors) et `console.log` informationnels (pdf-parse stats, Vision extraction). Pattern P1 (template literal seul) et P2 (string + error). | High |
| 4 | `src/tts.ts` | 14 appels — 100% `console.error`/`console.warn` en cascade de fallback (Groq → local). Pattern P1 et P2. Critique pour observabilité TTS. | Med |
| 5 | `src/gate-evaluator.ts` | 12 appels — 7 en `.catch(err => console.error(...))` inline, 2 multi-lignes. Défi : les lambdas inline nécessitent que le logger soit en scope, ce qui implique un `const log = createLogger("gate-evaluator")` au niveau module. | High |
| 6 | `src/commands/zz-messages.ts` | 11 appels — handler principal de messages Telegram. Certains logs portent le contexte `[topic:${topicName}]` intégré dans le template → à externaliser en metadata `{ topic: topicName }`. Bénéfice de `withCorrelation` très élevé ici. | High |
| 7 | `src/workflow.ts` | 9 appels — dont un multi-ligne avec message de transition invalid. Pattern P1/P2. | Med |
| 8 | `src/loader.ts` | 7 appels — tous préfixés `[loader]` dans le message. Ce préfixe devient redondant avec `createLogger("loader")`. Simplification nette. | Med |
| 9 | `src/bot-context.ts` | 7 appels — dont `console.log("Calling Claude: ...")` (informationnel → `log.debug`). Déjà en scope du contexte bot avec `chatId` → `withCorrelation` applicable directement. | High |
| 10 | `src/prd.ts` | 6 appels — tous `console.error` sur opérations Supabase. Migration mécanique. | Low |
| 11 | `src/blackboard.ts` | 6 appels — dont 1 `console.warn` multi-ligne sur dépassement de taille de section et 1 `console.error` multi-ligne sur version overflow. Pattern P3 (multi-ligne avec args). | Med |
| 12 | `src/adversarial-verifier.ts` | 6 appels — 2 `console.log` (info → `log.info`/`log.debug`), 2 `console.warn` timeout, 2 `console.error`. Migration directe. | Med |
| 13 | `src/agent-events.ts` | 1 appel — `console.error("msg", { sessionId, role })` — pattern rare : object literal en second arg. Doit devenir `log.error("msg", { sessionId, role })`. | Low |
| 14 | `src/gate-persistence.ts` | 2 appels réels (ligne 68 : console.error, ligne 122 : dans une string template — **pas** un appel console, juste texte). | Low |
| 15 | `src/commands/{jobs,help,execution,utilities,memory-cmds,quality,documents}` | 1-4 appels chacun — tous patterns P1/P2. Migration rapide. | Low |
| 16 | `src/relay.ts`, `src/orchestrator.ts`, `src/agent.ts` | **Déjà migrés**. Servent de référence : `const log = createLogger("module")` en tête, usage `log.info/error/warn` avec template literal string seule ou metadata objet. | Référence |
| 17 | `src/logger.ts` | 3 appels `console.log/error/warn` — **intentionnels** : c'est l'implémentation du logger lui-même qui délègue à console. À NE PAS migrer. | Exclu |

**Points de friction identifiés :**

1. **Pattern P4 — `[${timestamp}]` dans heartbeat.ts** : 25+ appels préfixent manuellement l'ISO timestamp. Après migration, le logger ajoute son propre timestamp → le préfixe dans le message doit être supprimé pour éviter la redondance. Transformation non-mécanique sur 35 appels.

2. **Pattern P5 — `.catch(err => console.error(...))` inline** : 4 appels dans gate-evaluator et workflow.ts. La lambda inline doit référencer le logger du module → nécessite que `log` soit déclaré avant et accessible dans la closure. Pas de blocage, mais transformation manuelle.

3. **Pattern P6 — `console.error("msg", error_object)` multi-args** : 127 appels (dominant). `createLogger` accepte un second arg `opts?: Omit<LogOptions, "module">` qui est un plain object. Donc `console.error("msg", error)` doit devenir `log.error("msg", { error: String(error) })` ou `log.error("msg", { error: error instanceof Error ? error.message : String(error) })`. Un helper `toMeta(e: unknown)` pourrait simplifier.

4. **Pattern P7 — `console.error("msg", { sessionId, role })` object literal** : 1 cas (agent-events.ts). Directement mappable : `log.error("msg", { sessionId, role })`.

5. **Pas de `withCorrelation` dans les modules hors relay/orchestrator/agent** : les modules appelés en cascade (bot-context, commands/*) auraient besoin du `withCorrelation` wrappé au niveau du message handler dans `zz-messages.ts` pour que tous les logs d'une requête partagent le `correlation_id`. C'est une valeur ajoutée de la migration mais nécessite un wrapping dans les handlers Telegram.

**Actifs réutilisables :**

- Les 3 fichiers déjà migrés (`relay.ts`, `orchestrator.ts`, `agent.ts`) fournissent le pattern exact à répliquer.
- `tests/unit/logger-migration.test.ts` fournit le test de compliance : extensible pour couvrir d'autres modules critiques.
- L'API `createLogger` accepte déjà les metadata en objet → aucune modification du module logger nécessaire.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Migration incrémentale par vagues (recommandé) | C: Migration globale big-bang |
|---------|:------------:|:-----------:|:-----------:|
| **Complexité** (obligatoire) | S | M | L |
| **Valeur ajoutée** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | Med | Low | High |
| *Impact maintenance future* | Négatif (dette) | Positif | Positif mais risqué |
| *Réversibilité* | Totale | Facile par module | Difficile post-merge |

**Option A — Status quo** : Conserver les `console.*` actuels. Valeur ajoutée nulle : les logs de prod restent illisibles sans corrélation, le filtrage par niveau est impossible, et la dette technique s'accumule à chaque nouveau module. Le risque est croissant car les nouveaux devs reproduiront le pattern `console.*` observé dans le code existant.

**Option B — Migration incrémentale par vagues** : Migrer fichier par fichier en 3 vagues de priorité croissante (voir Section 6). Chaque vague est un PR autonome avec tests de compliance. Risque faible car chaque PR est limité en scope et les tests `bun test` valident la non-régression. C'est l'approche recommandée par l'état de l'art (Better Stack, Martin Fowler).

**Option C — Migration globale big-bang** : Migrer tous les 42 fichiers en un seul PR. Valeur ajoutée identique à B mais risque élevé : diff massif, difficile à reviewer, une erreur de conversion sur un `.catch` inline pourrait silencer des erreurs critiques en prod, et les conflits de merge avec les branches feature en cours seraient importants.

---

## Section 5 — Verdict et justification

**Verdict : GO — Option B (migration incrémentale par vagues)**

L'exploration confirme que la migration est techniquement straightforward pour ~75% des cas (patterns P1/P2/P3) et que les défis identifiés (patterns P4/P5/P6) sont tous résolubles de manière déterministe sans modifier l'API du logger.

**Justification :**

1. **Le module logger est production-ready** (axe 2) : `src/logger.ts` a une API complète, 3 fichiers déjà migrés servent de référence, et `logger.test.ts` + `logger-migration.test.ts` fournissent un filet de sécurité établi.

2. **Volume gérable en vagues** (axe 2) : 242 appels dans 42 fichiers, dont 167 `console.error` (migration mécanique P2), 53 `console.log` (→ `log.info` ou `log.debug` selon criticité), 22 `console.warn`. La vague 1 (modules haute criticité) représente ~55% du volume.

3. **Bénéfice observabilité immédiat** (axe 1) : en production, passer à JSON structuré avec `correlation_id`, `module`, et `level` filtrable par `LOG_LEVEL` est la recommandation unanime de l'état de l'art pour les bots Telegram/services Node.js.

4. **Risque technique maîtrisé** (axe 3) : l'approche par vagues permet de valider chaque groupe indépendamment via `bun test` (2816 tests). Les patterns complexes (P4 heartbeat, P5 .catch inline) sont clairement identifiés et limités à 2 fichiers.

5. **Pas de modification du logger nécessaire** : l'API actuelle de `src/logger.ts` supporte déjà tous les patterns identifiés. La seule question ouverte est l'opportunité d'un helper `toMeta(e: unknown)` pour sérialiser les Error objects.

---

## Section 6 — Input pour étape suivante

### Input pour spec

**Option recommandée** : B — Migration incrémentale par vagues

**Stratégie de migration en 3 vagues :**

**Vague 1 — Modules critiques haute fréquence** (42 fichiers dans cette vague : ~140 appels)
- `src/memory.ts` (38), `src/heartbeat.ts` (35), `src/documents.ts` (23), `src/commands/zz-messages.ts` (11), `src/bot-context.ts` (7)
- Priorité : ces modules sont au cœur du chemin chaud et bénéficient le plus de la corrélation
- Challenge spécial heartbeat : supprimer le préfixe `[${timestamp}]` dans les messages (redondant avec timestamp logger)
- Opportunité `withCorrelation` : wrapper les handlers Telegram dans `zz-messages.ts` pour propager `chat_id:message_id`

**Vague 2 — Infrastructure et agents** (~60 appels)
- `src/tts.ts` (14), `src/gate-evaluator.ts` (12), `src/workflow.ts` (9), `src/loader.ts` (7), `src/prd.ts` (6), `src/blackboard.ts` (6), `src/adversarial-verifier.ts` (6)
- Challenge gate-evaluator : 7 `.catch(err => console.error(...))` inline — déclarer `const log = createLogger("gate-evaluator")` en tête puis substituer

**Vague 3 — Modules légers** (~40 appels)
- 28 fichiers restants avec 1-5 appels chacun : migration mécanique pure

**Règles de conversion standardisées :**
- `console.log("msg")` → `log.info("msg")` (ou `log.debug` si purement diagnostic)
- `console.warn("msg")` → `log.warn("msg")`
- `console.error("msg")` → `log.error("msg")`
- `console.error("label:", error)` → `log.error("label", { error: String(error) })`
- `console.error("label:", error)` (avec Error object) → `log.error("label", { error: error instanceof Error ? error.message : String(error) })`
- `console.log("prefix", variable)` → `log.info(\`prefix ${variable}\`)` ou `log.info("prefix", { value: variable })`
- Template `[${timestamp}] msg` → `log.info("msg")` (supprimer le préfixe timestamp)

**Fichiers concernés** : 42 fichiers dans `src/` (liste complète dans Section 3), `src/logger.ts` **exclu** (implémentation intentionnelle)

**Contraintes identifiées :**
- Ne jamais modifier `src/logger.ts` (les 3 `console.*` y sont intentionnels)
- `scripts/` et `tests/` : hors scope de la migration (peuvent rester avec `console.*` car ce ne sont pas des modules de production)
- Chaque vague doit passer `bun test` (2816 tests) avant merge
- Le test `logger-migration.test.ts` doit être étendu pour couvrir les modules de chaque vague

**Questions ouvertes à résoudre pendant la spec :**
1. Faut-il créer un helper `toMeta(e: unknown): { error: string }` dans `logger.ts` pour standardiser la sérialisation des Error objects ? (évite 127 repetitions du ternaire `error instanceof Error`)
2. Faut-il ajouter `withCorrelation` dans le handler principal de `zz-messages.ts` (Vague 1) ou le différer en Vague 2 ?
3. Les modules `scripts/` (`smoke-test.ts`, `migrate.ts`, etc.) doivent-ils aussi migrer ? (actuellement 59 appels dans scripts/)
4. Niveau de log à utiliser pour les messages informationnels actuellement en `console.log` : `info` par défaut ou `debug` pour les messages purement diagnostics (ex: `pdf-parse OK: X chars`) ?
