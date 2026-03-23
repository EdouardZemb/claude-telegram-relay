## Rapport d'impact : Durcissement standards de développement — Vague 3

> Généré le 2026-03-23 à partir de docs/specs/SPEC-durcissement-standards-vague-3.md.

### Niveau de risque : MEDIUM

### Résumé

Le changement est à périmètre large (34 fichiers `src/` + 1 fichier CI + 2 nouveaux fichiers de test) mais structurellement peu risqué pour le code existant : les corrections de blocs `catch {}` (commentaires de catégorie ou ajout de `log.warn`) ne modifient aucune signature publique. La création de `src/result.ts` est purement additive — aucun module existant n'en dépend. Les validators Zod s'insèrent en amont du chemin heureux existant dans trois fichiers Composer, sans toucher aux fonctions appelées (`addTask`, `orchestrate`, `getPRD`). Le risque principal est concentré sur deux points : (1) l'intégration du `PrdCommandSchema` dans la logique de routage complexe de `/prd` (branches `isPrdMaturationEnabled` / `isPrdWorkflowEnabled`) et (2) l'ajout du step `Coverage check` dans la CI, dont le seuil de 60% n'a pas été validé sur le build CI réel avec les nouveaux fichiers.

---

### Modules impactés

| Module | Impact | Détail |
|--------|--------|--------|
| `src/result.ts` | Direct (création) | Nouveau fichier. Aucun module existant n'en dépend. Adopté uniquement dans le nouveau code (validators). Risque nul sur les modules existants. |
| `src/commands/tasks.ts` | Direct | Ajout de `TaskCommandSchema` Zod et logique de parsing entre `ctx.match` et `addTask`. L'interface externe (commande `/task`) est préservée. Aucun export public modifié (seul `export default tasksCommands` existe). |
| `src/commands/execution.ts` | Direct | Ajout de `ExecCommandSchema` et `OrchestrateCommandSchema`. Un bloc `catch {}` catégorie E à transformer en `log.error` + return. L'export unique `export default execution` est inchangé. Les heartbeat `catch {}` (ligne 264) restent inchangés (catégorie D → log.warn minimum). |
| `src/commands/planning.ts` | Direct | Ajout de `PrdCommandSchema`. La logique de routage existante (`hexIdMatch`, `isPrdMaturationEnabled`, `isPrdWorkflowEnabled`) reste intacte — le schema s'insère avant ces branches. Export unique `export default planningCommands` inchangé. |
| `src/bot-context.ts` | Direct | 14 blocs `catch {}` à annoter (catégories B et D). Les 11 IIFEs config getters (`BOT_TOKEN`, `ALLOWED_USER_ID`, etc.) reçoivent des commentaires `// R6`. Les blocs `loadSession`, `loadReminders`, `createSupabase` reçoivent également des commentaires R6. Les exports publics (`PROJECT_ROOT`, `BOT_TOKEN`, `RELAY_DIR`, `createBotContext`, etc.) sont **inchangés dans leur signature**. |
| `src/memory.ts` | Direct | 9 blocs `catch {}` à annoter (catégories A et C). Principalement des blocs autour d'Edge Functions (catégorie C : R7) et des blocs `JSON.parse` implicites dans les retours de search (catégorie A : R5). Certains blocs dans `reviewIdea`, `promoteIdea`, `archiveIdea` (lignes 1128, 1157, 1180) semblent de catégorie D (erreur silencieuse après un `log.error` précédent) et devront être traités avec précaution. Aucun export modifié. |
| `src/orchestrator.ts` | Direct | 8 blocs `catch {}` catégories D et C. Les blocs avec commentaires existants (`// Sharding not available`, `// Template not available`, etc.) sont déjà conformes à l'esprit de la spec — ils recevront les commentaires de catégorie formels (R7 pour les features optionnelles, log.warn pour les erreurs métier dans `agentContextCache` lignes 825, 1542). L'interface publique d'`orchestrator.ts` (10+ exportations consommées par `auto-pipeline.ts`, `pipeline-selection.ts`, etc.) est **inchangée**. |
| `src/heartbeat.ts` | Direct | 7 blocs `catch {}` catégories B et D. `loadState` (catégorie B, commentaire R6 à ajouter). Aucun export modifié. |
| `src/relay.ts` | Direct | 6 blocs `catch {}` catégories D et E. Les blocs de graceful shutdown (lignes 160, 172) et les blocs de notification fallback (lignes 115, 213, 226) reçoivent des `log.warn`. Aucun export public (module entrypoint). |
| `src/llm-router.ts` | Direct | 6 blocs `catch {}` catégories A et D. Les blocs `JSON.parse` du routeur (lignes 163, 172) sont catégorie A (commentaires R5). Les blocs de complexity et exploration hints (lignes 90, 102, 426, 441) sont catégorie D (best-effort → `log.warn`). Importé par `auto-pipeline.ts`. |
| `src/agent-schemas.ts` | Direct | 6 blocs `catch {}` catégorie A (JSON parse LLM output). Commentaires R5. Importé par `adversarial-challenge.ts`, `spec-lite.ts`, `orchestrator.ts`, `deliberation.ts`, `pipeline-state.ts`, `prd-workflow.ts`. |
| `src/agent-context.ts` | Direct | 9 blocs `catch {}` catégories B et D. Aucun export public modifié. |
| `src/adversarial-challenge.ts` | Direct | 5 blocs `catch {}` catégories A et D. Importé par `orchestrator.ts`. |
| `src/commands/help.ts` | Direct | 4 blocs `catch {}` catégorie D → `log.warn`. Export unique inchangé. |
| `src/autonomy-scanner.ts` | Direct | 3 blocs `catch {}` catégorie B → commentaires R6. |
| `src/agent-events.ts` | Direct | 3 blocs `catch {}` catégories C et D. |
| `src/code-graph.ts` | Direct | 3 blocs `catch {}` catégorie B → commentaires R6. |
| `src/adversarial-verifier.ts` | Direct | 2 blocs `catch {}` catégorie A → commentaires R5. |
| `src/gate-evaluator.ts` | Direct | 2 blocs `catch {}` catégorie A → commentaires R5. |
| `src/exploration-scoring.ts` | Direct | 2 blocs `catch {}` catégorie D → `log.warn`. |
| `src/spec-lite.ts` | Direct | 2 blocs `catch {}` catégories A et D. |
| `src/cost-tracking.ts` | Direct | 2 blocs `catch {}` catégories B et D. |
| `src/notification-queue.ts` | Direct | 2 blocs `catch {}` catégorie D → `log.warn`. |
| `src/doc-utils.ts` | Direct | 2 blocs `catch {}` catégorie B → commentaires R6. |
| `src/notification-prefs.ts` | Direct | 1 bloc `catch {}` catégorie B → commentaire R6. |
| `src/prd.ts` | Direct | 1 bloc `catch {}` catégorie A → commentaire R5. |
| `src/conversation-session.ts` | Direct | 1 bloc `catch {}` catégorie B → commentaire R6. |
| `src/commands/jobs.ts` | Direct | 1 bloc `catch {}` catégorie D → `log.warn`. |
| `src/workflow.ts` | Direct | 1 bloc `catch {}` catégorie D → `log.warn` (`loadWorkflowConfig` ligne 788). |
| `src/llm-ops.ts` | Direct | 1 bloc `catch {}` catégorie D → `log.warn`. |
| `src/prd-workflow.ts` | Direct | 1 bloc `catch {}` catégorie B → commentaire R6. |
| `src/agent.ts` | Direct | 1 bloc `catch {}` catégorie D/E (CI poll, ligne 409) → `log.warn`. |
| `src/feature-flags.ts` | Direct | 1 bloc `catch {}` catégorie B → commentaire R6. |
| `src/job-manager.ts` | Direct | 1 bloc `catch {}` catégorie E (ligne 128) → `log.error` + return. |
| `src/cost-estimate.ts` | Direct | 1 bloc `catch {}` catégorie D → `log.warn`. |
| `.github/workflows/ci.yml` | Direct | Ajout step `Coverage check` (60% seuil, script shell parsant `bun test --coverage`). Mise à jour seuil de test count : `3441` → `3516`. |
| `tests/unit/result.test.ts` | Créé | Tests unitaires pour `src/result.ts`. Purement additif. |
| `tests/unit/command-validators.test.ts` | Créé | Tests unitaires pour les 4 schémas Zod. Purement additif. |
| `src/orchestrator.ts` | Indirect | Consomme `tasks.ts` → les validators Zod dans les commandes ne modifient pas l'interface de `addTask`, `orchestrate` ou `getPRD`. Aucun impact induit. |
| `src/loader.ts` | Indirect | Charge les Composers (`tasks`, `execution`, `planning`) à l'initialisation. Les Composers ajoutent des validators internes mais leur interface (fonction exportée par défaut) reste identique. |
| `src/relay.ts` | Indirect | Consomme `bot-context.ts` via `createBotContext`. Les corrections de `catch {}` dans `bot-context.ts` ne changent aucune signature. |

---

### API publiques modifiées

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/result.ts` | `Result<T, E>`, `ok()`, `err()`, `isOk()`, `isErr()` | Ajout (nouveau fichier) | Oui — aucun module existant n'en dépend |
| `src/commands/tasks.ts` | `tasksCommands(bctx)` | Aucune modification de signature | Oui — comportement interne étendu (validation), interface externe inchangée |
| `src/commands/execution.ts` | `execution(bctx)` | Aucune modification de signature | Oui — comportement interne étendu, interface externe inchangée |
| `src/commands/planning.ts` | `planningCommands(bctx)` | Aucune modification de signature | Oui — comportement interne étendu, interface externe inchangée |
| `src/bot-context.ts` | `BOT_TOKEN`, `ALLOWED_USER_ID`, `RELAY_DIR`, `createBotContext`, etc. | Aucune modification — ajout de commentaires dans les blocs catch | Oui — signatures et valeurs de retour inchangées |
| `.github/workflows/ci.yml` | Step `Verify test count` | Modification du seuil (`3441` → `3516`) | N/A — CI uniquement |
| `.github/workflows/ci.yml` | Step `Coverage check` | Ajout d'un nouveau step | N/A — CI uniquement (peut bloquer les PRs si coverage < 60%) |

---

### Breaking changes potentiels

- [ ] **Step `Coverage check` CI : seuil 60% non validé sur build réel avec les nouveaux fichiers** — impact : le step `Coverage check` est ajouté dans la même PR que les nouveaux fichiers (`result.ts`, validators). Si `result.ts` ou les validators ont une couverture faible (fonction non testée), le coverage global peut descendre légèrement. La baseline est 69.13% (unit only) — la marge de 9 points est large, mais les modules infrastructure comme `relay.ts` (0%) et `transcribe.ts` (0%) sont inclus dans `tests/unit tests/integration`. À valider sur un run CI réel avant de considérer la PR mergeable. Fichier à vérifier : `.github/workflows/ci.yml`.

- [ ] **`PrdCommandSchema` bloque les chemins `isPrdMaturationEnabled()` et `isPrdWorkflowEnabled()`** — impact : la commande `/prd` dans `commands/planning.ts` a une logique de routage conditionnelle en amont du parsing de l'input. Le schéma Zod doit s'insérer **après** les vérifications de feature flags, pas avant, sinon des inputs valides pour les workflows alternatifs pourraient être rejetés. L'input de `/prd` peut prendre des formes (`list`, UUID hex, texte libre, commandes workflow) que le `PrdCommandSchema.discriminatedUnion` doit toutes couvrir. Fichier à vérifier : `src/commands/planning.ts` lignes 207-300.

- [ ] **Seuil CI `3516` activé avant que les nouveaux tests existent** — impact : si le seuil est mis à jour dans `.github/workflows/ci.yml` dans une PR séparée des fichiers de test, la CI cassera immédiatement. Le seuil final doit être `3516 + N` où N est le nombre réel de nouveaux tests générés. La spec indique "estimé 20-30" — le seuil `3516` correspond à la baseline actuelle (= seuil cible = total existant à maintenir). L'implémenteur doit vérifier que le décompte actuel est bien 3516 et non le threshold CI actuel de 3441. Fichier à vérifier : `.github/workflows/ci.yml` ligne 52.

- [ ] **`log.warn` dans `job-manager.ts` ligne 128 (catégorie E) : retour de valeur modifié** — impact : la spec R9 exige pour la catégorie E un `log.error` + `return null`. Si `loadJobRegistry()` est appelé dans un contexte où une valeur non-null est attendue au démarrage, retourner `null` implicitement (déjà le cas avec `loaded = true`) ne casse rien. Mais transformer le bloc catch en `log.error` + return forcé change le comportement observable en logs. Fichier à vérifier : `src/job-manager.ts` lignes 123-131.

---

### Points d'attention pour le Reviewer

1. **Routage `/prd` et insertion du `PrdCommandSchema`** : `src/commands/planning.ts` ligne 207 commence par une vérification `!input || /^(list|lister)$/i.test(input)` qui gère le cas sans argument. Ensuite, la logique vérifie `hexIdMatch` (regex `/^[a-f0-9]{4,8}$/`), puis les branches `isPrdMaturationEnabled()` et `isPrdWorkflowEnabled()`. Le `PrdCommandSchema` de la spec utilise un `discriminatedUnion` sur l'action — mais la détection de l'action (list / view / create) est actuellement implicite dans la logique de routing. Le Reviewer doit s'assurer que le schema Zod ne remplace pas cette logique mais se superpose à elle, ou que sa validation intervient après les feature-flag checks. Risque : rejet d'inputs légitimes pour les workflows activés dynamiquement. Fichier : `/home/edouard/claude-telegram-relay/src/commands/planning.ts`.

2. **Décompte du seuil CI (`3441` → `3516`) vs count réel** : le CI actuel a un seuil à `3441` mais la mémoire projet indique 3343 tests et la spec cite 3516. La spec (R17) précise "seuil à 3516+N (N = nouveaux tests estimés 20-30)". Avant de modifier le seuil dans `ci.yml`, l'implémenteur doit faire un `bun test tests/unit tests/integration tests/system 2>&1 | grep "pass"` pour connaître le décompte réel. Si le count actuel est inférieur à 3516, un seuil à 3516 cassera immédiatement la CI même sans les nouveaux tests. Fichier : `/home/edouard/claude-telegram-relay/.github/workflows/ci.yml` ligne 52.

3. **Catégorisation ambiguë dans `src/memory.ts` lignes 1128, 1157, 1180** : ces blocs `catch {}` suivent un `log.error` explicite (ex : `log.error("review idea error", { error: String(error) })`), puis un `return false` ou `return null`. Ils pourraient être classés catégorie D (le `log.error` est déjà là, juste avant le `catch`), mais en réalité le `log.error` est dans le bloc `if (error)` Supabase, pas dans le `catch`. Le `catch {}` silencieux englobe une exception inattendue (erreur réseau, etc.) qui ne passerait pas par le `if (error)` de Supabase. Ces blocs sont catégorie D → `log.warn` minimum. Fichier : `/home/edouard/claude-telegram-relay/src/memory.ts`.

4. **`ExecCommandSchema` : contrainte regex `/^[a-f0-9-]+$/` vs UUIDs complets** : les IDs de tâches sont des UUIDs Supabase (ex : `c495951a-1234-...`). La regex `[a-f0-9-]+` est correcte pour les préfixes hexadécimaux avec tirets. Mais la contrainte `min(4).max(36)` doit permettre les UUIDs complets (36 chars). À vérifier que le code existant dans `/exec` (ligne 96 : `t.id.startsWith(idPrefix)`) fonctionne avec des idPrefix de 36 chars — ce qui est un cas limite valide si l'utilisateur copie l'ID complet. Fichier : `/home/edouard/claude-telegram-relay/src/commands/execution.ts`.

5. **Script shell de coverage : portabilité de `bc`** : le step CI utilise `if (( $(echo "$LINES < 60" | bc -l) ))`. Sur le runner self-hosted (Linux), `bc` est disponible. À confirmer que le format de sortie de `bun test --coverage` correspond bien à `grep "All files"` — ce format peut varier entre versions de Bun. Si le parse échoue (`LINES` vide), le step se termine en erreur (code `exit 1`). C'est un garde-fou correct mais peut bloquer des PRs légitimes si le format change. Alternative plus robuste : `awk '$1 == "All" && $2 == "files"'`. Fichier : `/home/edouard/claude-telegram-relay/.github/workflows/ci.yml`.

6. **Tests de non-régression pour les commandes modifiées** : il n'existe pas de fichier `tests/unit/execution-command.test.ts` ni `tests/unit/tasks-command.test.ts` ni `tests/unit/planning-command.test.ts` dans le répertoire de tests. Les tests existants couvrant ces fichiers passent par des imports indirects (ex : `tests/unit/workflow.test.ts` importe `execution` indirectement). Les nouveaux validators Zod dans ces fichiers ne seront testés que via `tests/unit/command-validators.test.ts`. Vérifier que la couverture de `tasks.ts`, `execution.ts` et `planning.ts` n'est pas dégradée après l'ajout des validators (branches d'erreur Zod non testées = coverage baisse). Fichiers : `/home/edouard/claude-telegram-relay/tests/unit/command-validators.test.ts` (à créer).

---

### Blast radius

- Modules directement modifiés : **34 fichiers `src/`** + **1 fichier CI** (`.github/workflows/ci.yml`) = **35 fichiers**
- Modules indirectement impactés (consommateurs des APIs modifiées) : aucun — aucune signature publique n'est modifiée. `loader.ts` et `relay.ts` chargent les Composers inchangés. = **0 modules**
- Fichiers source créés : **1 fichier** (`src/result.ts`)
- Fichiers de test créés : **2 fichiers** (`tests/unit/result.test.ts`, `tests/unit/command-validators.test.ts`)
- Fichiers de test existants à surveiller pour non-régression (couvrant les modules impactés) : `tests/unit/bot-context.test.ts`, `tests/unit/memory.test.ts`, `tests/unit/orchestrator.test.ts`, `tests/unit/heartbeat.test.ts`, `tests/unit/job-manager.test.ts`, `tests/unit/workflow.test.ts`, `tests/unit/llm-router.test.ts`, `tests/unit/agent-schemas.test.ts`, `tests/unit/agent-context.test.ts`, `tests/unit/prd-workflow.test.ts` = **10 fichiers**
