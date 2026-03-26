# Challenge Adversarial — SPEC-monitoring-qualite-fonctionnalites-existantes.md

Verdict global: GO_WITH_CHANGES
Agents: 3/3 reussis

---

## Devil's Advocate — Rapport

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — Pattern `getRelayDir()` cite `homedir()` mais le code réel utilise `process.env.HOME`**
- Source : Section 7, Pattern 2
- Description : La spec documente `return process.env.RELAY_DIR ?? join(homedir(), ".claude-relay")` avec import `homedir` de `node:os`. Le code réel dans `pipeline-tracker.ts:21` utilise `process.env.HOME || "~"`. L'implémenteur aura deux versions contradictoires.
- Impact : Soit l'implémenteur introduit un import `homedir` absent des autres modules, soit il dévie du patron documenté. Sur un chemin de CI strict, cela peut déclencher une incohérence architecturale.
- Evidence : Spec ligne ~238 vs `pipeline-tracker.ts:21`

---

**[BLOQUANT] F-DA-2 — `alerts.ts` absent de l'allowlist S2 — le getter `getRelayDir()` cassera le CI**
- Source : Section 8 — Contraintes, standard S2
- Description : La spec affirme que l'usage de `process.env.RELAY_DIR` via le getter "contourne la violation S2 car il est dans l'allowlist S9". Mais l'allowlist S2 (dans `coding-standards.test.ts`) liste des fichiers spécifiques — `alerts.ts` n'y figure pas. L'allowlist S9 est un cap de *taille* (max 20 entrées), pas une exemption de fichier pour S2. La confusion entre S2 et S9 est structurelle.
- Impact : Le CI cassera à la première exécution. Il faut ajouter `alerts.ts` à l'ALLOWLIST S2 dans `coding-standards.test.ts`, ce que la spec ne mentionne pas.
- Evidence : `coding-standards.test.ts:123-147` — 13 fichiers listés, `alerts.ts` absent.

---

**[MAJEUR] F-DA-3 — `AgentFeedbackSignal.details` sans source dans `gate_evaluations`**
- Source : Section 3 — Données d'entrée, R7
- Description : Le mapping de `gate_evaluations` vers `AgentFeedbackSignal` inclut `details?: string`, mais la table `gate_evaluations` (schema.sql:478-493) n'a aucun champ texte libre mappable — uniquement des JSONB (`rubric_dimensions`, `deterministic_checks`).
- Impact : L'implémenteur doit décider arbitrairement la source de `details`. Les overlays seront moins informatifs si `undefined`.

---

**[MAJEUR] F-DA-4 — `spawnClaude()` cascade : `options.role` sera toujours `"default"` dans les stats**
- Source : Section 4 — Livrable 2, R6
- Description : Quand `options.cascade === true`, `spawnClaude()` délègue à `spawnClaudeWithCascade()` qui choisit lui-même le modèle via `CASCADE_MODELS`. Au moment où `recordSpawnResult(options.role ?? options.model ?? "default", ...)` s'exécute, `options.model` n'est pas encore connu. Tous les spawns cascade seront enregistrés sous `"default"`.
- Impact : La moitié des spawns (SDD pipeline en cascade) seront indiscernables dans les stats — la valeur diagnostique est nulle pour ce cas dominant.

---

**[MAJEUR] F-DA-5 — Middleware timing inclut les appels LLM — métrique trompeuse**
- Source : Section 4 — Livrable 4, R2 ; Pattern 5
- Description : `const start = Date.now(); await next(); recordCommandCall(cmd, Date.now() - start)` mesure le temps total incluant les spawns Claude. `/explore` avec agent pris 2 minutes sera moyenné avec `/explore` sans agent (200ms). La spec affiche `avg_ms` sans préciser que c'est le temps bout-en-bout incluant LLM.
- Impact : L'opérateur verra des moyennes inexplicables. Deux appels identiques à la même commande peuvent varier d'un facteur 600x.

---

**[MAJEUR] F-DA-6 — `monitoring.test.ts` sans isolation entre tests — V14 non déterministe**
- Source : Section 6, critères V1/V2/V3/V14
- Description : Les tests existants de `monitoring.test.ts` n'appellent pas `resetMonitoringState()` entre chaque test. Les nouveaux tests `commandStats` seront pollués par l'état accumulé. Le critère V3 (cap à 100 clés dans `commandStats`) échouera si la Map est déjà partiellement remplie.
- Impact : Suite de tests non déterministe selon l'ordre d'exécution. La spec ne spécifie pas l'ajout de `beforeEach`/`afterEach`.

---

**[MINEUR] F-DA-7 — Budget LOC de `agent.ts` potentiellement obsolète**
- Source : Section 6, tableau Budget LOC
- Description : La spec indique `agent.ts` à 732 LOC. Les commits récents sur master (`a625d72`, `f836d23`) ont modifié des modules liés. Le budget peut être dépassé avant même l'implémentation.

---

**[MINEUR] F-DA-8 — `loadCommandStats()` : JSON valide mais contenu corrompu non géré**
- Source : R4, R5 — Section 2
- Description : R4 spécifie "silently ignore si JSON invalide" mais ne couvre pas le cas d'un JSON valide avec `stats.metrics.calls = "not_a_number"`. Les calculs de `totalMs / calls` produiraient `NaN`.

---

**[MINEUR] F-DA-9 — Format HTML de l'exemple `/monitor` incohérent avec `formatMonitoringStats()`**
- Source : Section 5 — exemple de conversation
- Description : L'exemple affiche `p50: 2s` en plain-text. Le code réel utilise `kvLine()` qui génère `<b>p50</b>: 2s`. La nouvelle section "Par commande" n'a aucun critère V sur le style HTML attendu.

---

**[MINEUR] F-DA-10 — `getDefaultSupabase()` non exportée dans le codebase**
- Source : Section 4 — Livrable 3, R8
- Description : R8 appelle `fetchGateEvaluationSignals(getDefaultSupabase())` en indiquant que c'est un "import lazy pattern existant". Aucune fonction `getDefaultSupabase()` n'est exportée dans le codebase — c'est une fonction à créer, créant une connexion Supabase supplémentaire non trackée.

---

### Statistiques
- Bloquants : 2
- Majeurs : 4
- Mineurs : 4

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants sont corrigeables (ajouter `alerts.ts` à l'allowlist S2, clarifier le patron `getRelayDir()`), mais doivent être résolus **avant** l'implémentation pour éviter un CI cassé dès le premier commit. Les 4 majeurs (notamment le problème cascade sur les stats spawn) méritent des précisions dans la spec. La structure générale est saine.

---

## Edge Case Hunter — Rapport

J'ai suffisamment d'information pour produire mon rapport. Voici mon analyse adversariale complète.

---

## Edge Case Hunter — Rapport

### Findings

---

**[BLOQUANT] F-EC-1 — `recordSpawnResult` non appelé sur le chemin `cascade: true`**
- Scenario : La fonction `spawnClaude()` contient deux branches `return` distinctes (ligne 239-243 de `agent.ts`) : une pour `options.cascade === true` (retourne `spawnClaudeWithCascade(options)`), une pour le chemin normal. La spec (R6, Section 4 Livrable 2) dit d'appeler `recordSpawnResult` "avant de retourner" sans spécifier comment gérer les deux branches. Une implémentation naïve ajouterait `recordSpawnResult` uniquement avant le second `return` (chemin non-cascade), laissant l'intégralité des spawns SDD (qui utilisent le cascade) sans instrumentation. C'est l'inverse exact du bug corrigé.
- Source : R6 + Section 4 Livrable 2 + `src/agent.ts:238-243`
- Impact : Lacune n°3 de l'exploration (recordSpawnResult jamais appelé) serait partiellement corrigée mais la moitié des spawns resterait invisible. Le `getSpawnStats()` dans `/monitor` sous-compterait sans avertissement.
- Fréquence estimée : Fréquent — le SDD pipeline utilise cascade par défaut

---

**[MAJEUR] F-EC-2 — `getDefaultSupabase()` inexistante dans le codebase**
- Scenario : R8 indique que `getDeps()` doit utiliser `fetchGateEvaluationSignals(getDefaultSupabase())` via un "import lazy (pattern require() existant ligne 67)". Mais ligne 67 de `feedback-analyzer.ts` importe uniquement `isFeatureEnabled` (feature-flags) — aucun `getDefaultSupabase()` n'existe dans le codebase. Les seuls endroits où un client Supabase est créé sont `bot-context.ts` (singleton, risque S7 cycle), `job-manager.ts` (lazy require inline), `heartbeat.ts` (createClient direct). L'implémenteur doit inventer le pattern sans guide, avec risque de violer S2 (`process.env` direct) ou S7 (cycle via bot-context.ts).
- Source : R8 + `src/feedback-analyzer.ts:64-72` + `src/bot-context.ts:388`
- Impact : Ambiguité bloquante pour l'implémenteur. Solutions alternatives toutes risquées (cycle, S2 violation). Tests existants ne couvrent pas ce chemin production.
- Fréquence estimée : Bloquant à l'implémentation (100%)

---

**[MAJEUR] F-EC-3 — Mapping snake_case → camelCase non documenté pour la query `gate_evaluations`**
- Scenario : La table `gate_evaluations` (db/schema.sql:484) a la colonne `agent_role` (snake_case). L'interface `AgentFeedbackSignal` a le champ `agentRole` (camelCase). La spec (R7) décrit le query et le mapping via `GATE_NAME_TO_SOURCE` mais ne mentionne pas la transformation de nommage. Le client Supabase JS retourne les colonnes en snake_case par défaut. Un implémenteur qui écrit `row.agentRole` directement obtiendrait `undefined` — les signaux auraient `agentRole: undefined`, les patterns ne seraient jamais groupés par rôle, aucun overlay ne serait créé.
- Source : R7 + Section 3 (Données d'entrée) + `db/schema.sql:484`
- Impact : `fetchGateEvaluationSignals` retournerait des objets malformés, `analyzeAgentFeedback` ne détecterait aucun pattern (groupe undefined → toujours < threshold 3). Lacune n°4 resterait effective malgré l'instrumentation.
- Fréquence estimée : Fréquent (implémentation correcte non évidente)

---

**[MAJEUR] F-EC-4 — `loadCommandStats` : comportement merge vs overwrite non défini**
- Scenario : R4 dit "initialise la Map avec les valeurs lues (cumul cross-restarts)". Mais si la Map contient déjà des entrées au moment de l'appel (ex: test qui appelle `loadCommandStats` après des `recordCommandCall`), le comportement n'est pas précisé : merge-additif (cumul) ou remplacement total ? Le V5 prescrit un `resetMonitoringState()` préalable mais R4 ne précise pas le comportement général. Si l'implémenteur choisit le remplacement et qu'un hot-reload ou appel multiple survient en production, les stats en mémoire depuis le dernier flush seraient perdues.
- Source : R4 + V5 + Section 8 (Ce qu'il ne faut pas casser)
- Impact : Perte silencieuse de métriques en cas de double initialisation ou test sans reset préalable. Les critères V3/V5 peuvent produire des résultats flaky si l'ordre d'exécution des tests varie.
- Fréquence estimée : Occasionnel (tests) / Rare (production)

---

**[MAJEUR] F-EC-5 — Label UX "/monitor" trompeur : "depuis dernier restart" ≠ réalité post-persistence**
- Scenario : Section 5 montre le message `/monitor` avec "(4 commandes actives depuis dernier restart)". Or, après l'implémentation de R4 (`loadCommandStats` charge les stats cross-restarts), les données reflètent l'historique cumulatif et non "depuis le dernier restart". Le label est architecturalement incorrect. Un utilisateur voyant "depuis dernier restart" avec des stats ancienness de plusieurs semaines serait induit en erreur sur la fenêtre temporelle des données.
- Source : Section 5 Interface Telegram + R4 (cumul cross-restarts) + R5 (`flushed_at` disponible)
- Impact : UX trompeuse. Le champ `flushed_at` du JSON est disponible et permettrait d'afficher "depuis [date dernier flush]" — mais la spec ne l'utilise pas. Annotation incorrecte conçue avant la décision de persistance cross-restart.
- Fréquence estimée : Fréquent (à chaque `/monitor` post-restart)

---

**[MAJEUR] F-EC-6 — Tests `monitoring.test.ts` : absence d'isolation d'état → V3 flaky**
- Scenario : Les 38 tests existants de `monitoring.test.ts` n'utilisent pas `beforeEach(() => resetMonitoringState())`. Ils utilisent `toBeGreaterThanOrEqual` pour pallier l'accumulation. Le critère V3 (cap 100 clés) requiert de "remplir la Map à 100, appeler avec une nouvelle clé, vérifier size". Si d'autres tests `recordCommandCall` ont ajouté des clés avant V3, la Map peut déjà être proche ou à 100 — l'entrée de setup de V3 serait ignorée par le cap, le test compterait moins de 100 insertions effectives. Le résultat peut varier selon l'ordre d'exécution des tests.
- Source : V3 + `tests/unit/monitoring.test.ts:1-124` + Section 8 (Ce qu'il ne faut pas casser)
- Impact : Tests non-déterministes. CI pourrait passer ou échouer selon l'ordre Bun. Le standard S8 (coverage ≥ 30%) exige des tests fiables.
- Fréquence estimée : Occasionnel (dépend de l'ordre d'exécution Bun)

---

**[MINEUR] F-EC-7 — Double flush concurrent SIGTERM + setInterval**
- Scenario : Si PM2 envoie SIGTERM exactement pendant l'exécution d'un `flushCommandStats()` déclenché par le `setInterval` horaire, deux instances de flush s'exécutent quasi-simultanément. Les UUIDs du fichier `.tmp` sont différents, donc pas de collision. Le dernier `rename()` gagne. Pas de perte de données, mais la `flushed_at` du fichier final peut être antérieure à une écriture qui s'est terminée après. Sans mutex, comportement non documenté.
- Source : R3 + Section 4 Livrable 4 + Pattern 1 (`pipeline-tracker.ts:119-131`)
- Fréquence estimée : Rare

---

**[MINEUR] F-EC-8 — `commandStats` : accumulation de clés obsolètes (renommages de commandes)**
- Scenario : Cap à 100 clés (R2). Si 30 commandes actives + 70 commandes obsolètes (renommées, supprimées) ont été enregistrées avant un restart, le fichier JSON chargé au démarrage consomme 70 des 100 slots — les nouvelles commandes actuelles sont potentiellement ignorées par le cap. Aucun mécanisme de nettoyage des clés obsolètes n'est prévu.
- Source : R2 + R4 + Section 10 "Rotation JSON" (Zones non résolues)
- Fréquence estimée : Rare (projet stable, peu de renommages)

---

**[MINEUR] F-EC-9 — `passed` non indexé : performance query `gate_evaluations`**
- Scenario : R7 query : `gate_evaluations WHERE passed=false AND created_at > now()-30 days LIMIT 50`. La colonne `passed` n'a pas d'index dans `db/schema.sql` (seuls `agent_role`, `gate_name`, `session_id`, `created_at`, `sprint_id` sont indexés). Supabase utilisera l'index `created_at` (le plus sélectif), puis filtrera sur `passed`. Acceptable en V1 (petit volume), mais non documenté.
- Source : R7 + `db/schema.sql:497-501`
- Fréquence estimée : Rare (volume faible, 30 jours de gate_evaluations)

---

**[MINEUR] F-EC-10 — V4/V5/V6 : RELAY_DIR temporaire non spécifié pour les tests d'intégration**
- Scenario : V4 (`flushCommandStats()` → fichier créé), V5 (`loadCommandStats()` → Map initialisée), V6 (JSON invalide → silence) nécessitent un répertoire temporaire réel. La spec dit "Pattern établi dans `pipeline-tracker.test.ts` à reproduire" mais ne fournit pas le snippet. Si l'implémenteur oublie de setter `RELAY_DIR` via `process.env` ou d'utiliser `mkdtemp()`, les tests écrivent dans `~/.claude-relay/` (production) et s'interfèrent avec le processus bot live.
- Source : V4/V5/V6 + R3/R4 + Section 8 Contraintes
- Fréquence estimée : Occasionnel (erreur d'implémentation de test)

---

### Statistiques
- Bloquants : 1
- Majeurs : 5
- Mineurs : 4

---

## Verdict de l'agent: GO_WITH_CHANGES

**Justification** : La spec est solide sur l'architecture (flush relay.ts, pattern JSON atomique, cap 100 clés) et adresse correctement les findings adversariaux précédents. Mais 3 issues bloquent une implémentation correcte sans ambiguïté : (1) la double-branche `spawnClaude` pour `recordSpawnResult` doit être rendue explicite avec un exemple de code qui capture les deux `return`, (2) `getDefaultSupabase()` doit être remplacé par un pattern concret documenté (lazy require de createClient + getConfig), (3) le mapping `agent_role` → `agentRole` doit être documenté. L'UX label "depuis dernier restart" doit être corrigé en "depuis dernier flush: [flushed_at]".

---

## Simplicity Skeptic — Rapport

## Simplicity Skeptic — Rapport

### Findings

**[BLOQUANT] F-SS-1 — `getDefaultSupabase()` référencée mais n'existe pas dans le codebase**
- Source : Section 7 Pattern 4, R8, Section 4 Livrable 3
- Description : La spec prescrit `fetchGateEvaluationSignals(getDefaultSupabase())` dans `getDeps()`, en citant "pattern `require()` existant ligne 67". Or `getDefaultSupabase()` n'existe nulle part dans le codebase. Le pattern ligne 67 de `feedback-analyzer.ts` ne crée pas de Supabase — il importe `isFeatureEnabled`. Les autres modules créent leur client Supabase via `createClient` direct (`heartbeat.ts:482`, `job-manager.ts:556`) ou via `bot-context.ts:388`. La spec invente une fonction utilitaire sans préciser comment l'implémenter.
- Alternative : Utiliser le pattern existant de `heartbeat.ts` : `createClient(getConfig().supabaseUrl, getConfig().supabaseAnonKey)` en lazy import dans `getDeps()`.
- Codebase : `src/feedback-analyzer.ts:67`, `src/heartbeat.ts:482`

---

**[MAJEUR] F-SS-2 — Violation S2 non résolue : `process.env.RELAY_DIR` accès direct dans `alerts.ts`**
- Source : Section 7 Pattern 2, Section 8 Contraintes S2
- Description : La spec propose de copier `getRelayDir()` de `pipeline-tracker.ts` dans `alerts.ts`, accédant directement à `process.env.RELAY_DIR`. L'invocation de "l'allowlist S9" pour justifier ceci est inexacte — S9 concerne le cap du nombre d'entrées dans la liste d'exceptions de `config.ts`, pas une permission générale de `process.env`. La spec exclut l'import depuis `bot-context.ts` par "risque cycle S7" sans vérifier si ce cycle existe réellement.
- Alternative : Vérifier le graphe d'imports `alerts.ts → bot-context.ts` avant d'exclure l'option propre. Si cycle confirmé, documenter explicitement le compromis.
- Codebase : `src/pipeline-tracker.ts:20-22`, `src/heartbeat.ts:64`

---

**[MAJEUR] F-SS-3 — Double système de mesure de latence sans clarification**
- Source : Section 4 Livrable 4, R2
- Description : `recordResponseTime` est déjà appelé dans `zz-messages.ts:359` et `zz-messages.ts:412`. Le middleware proposé dans `relay.ts` ajoute `recordCommandCall(cmd, ms)` pour les commandes slash — deux systèmes indépendants qui se chevauchent partiellement. La spec ne clarifie pas ce chevauchement : `/monitor` affichera des métriques de `responseTimeBuffer` ET des `commandStats` représentant des mesures différentes.
- Alternative : Documenter explicitement dans la spec que `recordResponseTime` mesure les messages texte/voix et `recordCommandCall` mesure les commandes slash — labels distincts dans l'affichage `/monitor`.
- Codebase : `src/commands/zz-messages.ts:359,412`

---

**[MAJEUR] F-SS-4 — Champ `role?` ajouté à `SpawnClaudeOptions` sans audit des appelants**
- Source : Section 4 Livrable 2, R6
- Description : La spec ajoute `role?` à l'interface `SpawnClaudeOptions` pour passer `options.role ?? options.model ?? "default"` à `recordSpawnResult`. `SpawnClaudeOptions` ne contient pas ce champ aujourd'hui. Aucun audit des nombreux appelants de `spawnClaude` dans le codebase n'est fourni pour confirmer la rétrocompatibilité ou l'absence de collisions de noms.
- Alternative : Inclure un `grep spawnClaude` des appelants existants pour confirmer la rétrocompatibilité avant implémentation.
- Codebase : `src/agent.ts:238-243`

---

**[MAJEUR] F-SS-5 — Mapping `gate_name` → source SDD peut être silencieusement vide en prod**
- Source : Section 2 R7, Exploration Section 6
- Description : L'exploration recommandait `workflow_logs` comme "changement minimal". La spec pivot vers `gate_evaluations` sans explication. Le filtrage par `startsWith` (`"implement"`, `"spec"`, etc.) peut silencieusement ignorer des entrées réelles si les `gate_name` en base ne matchent aucun des 4 préfixes — la boucle feedback reste vide sans erreur visible.
- Alternative : Logger les `gate_name` non reconnus plutôt que les ignorer silencieusement. Auditer les valeurs réelles en base avant de figer le mapping.
- Codebase : `db/schema.sql:478-493`

---

**[MINEUR] F-SS-6 — Cap 100 clés `commandStats` : 4x le nombre réel de commandes**
- Source : Section 2 R2
- Description : Le projet a ~25 commandes (CLAUDE.md). Un cap à 100 masquerait des clés parasites accumulées par un bug plutôt que d'alerter dessus.
- Alternative : Cap à 50, ou filtrer `cmd` avec `/^[a-z]{2,20}$/` avant insertion.

---

**[MINEUR] F-SS-7 — Absence de TTL/rotation pour `command-stats.json`**
- Source : Section 2 R5, Section 10 zone non résolue 3
- Description : La spec reconnaît l'absence de rotation sans définir une taille maximale ni un TTL. Risque faible (2 KB pour 25 commandes) mais non nul si des clés parasites s'accumulent.

---

**[MINEUR] F-SS-8 — Critère V16 partiellement manuel**
- Source : Section 9 V16
- Description : V16 inclut "Lecture du code relay.ts" — critère manuel, contrairement aux 15 autres V-critères testables automatiquement. Vérifier que `flushCommandStats` est appelé avant `process.exit(0)` est difficile à automatiser sans mocker `process.exit`.

---

### Statistiques
- Bloquants : 1
- Majeurs : 4
- Mineurs : 3

---

## Verdict de l'agent: GO_WITH_CHANGES

**Points bloquants à résoudre avant implémentation :**
1. **F-SS-1** : Remplacer `getDefaultSupabase()` par le pattern `createClient(getConfig()...)` existant dans la spec
2. **F-SS-5** : Ajouter un log explicite pour les `gate_name` non reconnus (éviter échec silencieux en prod)

**Points majeurs à clarifier :**
- F-SS-2 : Corriger la justification S2/S9 ou vérifier réellement l'absence de cycle import
- F-SS-3 : Documenter la séparation `responseTimeBuffer` vs `commandStats` dans l'affichage `/monitor`