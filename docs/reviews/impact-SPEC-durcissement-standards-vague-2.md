## Rapport d'impact : Durcissement standards de développement — Vague 2

> Généré le 2026-03-23 à partir de docs/specs/SPEC-durcissement-standards-vague-2.md.

### Niveau de risque : MEDIUM

### Résumé

Le changement est structurellement peu risqué : il ne modifie aucune signature publique exportée (les `any` ciblés sont quasi-exclusivement des types internes de paramètres ou des annotations de retour internes). Les 7 nouveaux fichiers de test ajoutent de la couverture sans altérer le code de production. Le seul changement observable par les modules consommateurs est la modification de `BlackboardSections` (spec/plan/tasks/implementation/messages de `any` à `Record<string, unknown>`) qui impacte `orchestrator.ts` et `agent-messaging.ts`, et la formalisation des retours `any[]` en types concrets dans `workflow.ts` qui impacte `commands/quality.ts`. Ces deux points constituent le risque principal.

---

### Modules impactés

| Module | Impact | Détail |
|--------|--------|--------|
| `src/blackboard.ts` | Direct | 14 `any` à éliminer. `BlackboardSections.spec/.plan/.tasks/.implementation/.messages` passent de `any \| null` à `Record<string, unknown> \| null`. L'interface `BlackboardRow` est exportée et consommée par `orchestrator.ts` et `agent-messaging.ts`. |
| `src/workflow.ts` | Direct | 18 `any` à éliminer. Fonctions `formatMetrics`, `formatMetricsComparison`, `formatRetro`, `generateRetroData`, `getAllSprintMetrics`, `getRetro` changent leurs annotations de `any` vers des types concrets. Exportées et utilisées par `commands/quality.ts`. |
| `src/patterns.ts` | Direct | 9 `any` à éliminer. Dépend de `workflow.ts` pour `loadWorkflowConfig`. Nouvelle interface `RetroRow` à co-définir ou importer. |
| `src/gate-evaluator.ts` | Direct | 9 `any` à éliminer. `normalizeEvaluation` et `normalizeFindings` migrent vers `unknown`. Types exportés `GateEvaluation`, `GateName` consommés par `orchestrator.ts` et `gate-persistence.ts`. |
| `src/proactive-planner.ts` | Direct | 26 `any` à éliminer (le plus chargé). Import de `Task` depuis `tasks.ts`. Module terminal (aucun module ne l'importe en dehors des tests). |
| `src/commands/jobs.ts` | Direct | 7 `any` à éliminer. Utilise `PipelineResult` de `auto-pipeline.ts` — type déjà exporté, disponible à l'import. |
| `src/profile-evolution.ts` | Direct | 5 `any` à éliminer. Consommé uniquement par `bot-context.ts`. |
| `src/orchestrator.ts` | Direct | 5 `any` à éliminer. Consomme `BlackboardSections`, `GateEvaluation`, `GateName`. Impact indirect sur tous les modules qui l'importent (`auto-pipeline.ts`, `pipeline-selection.ts`, `deliberation.ts`, `feedback-loop.ts`, `agent-schemas.ts`, `pipeline-state.ts`, `mcp-config.ts`). |
| `src/commands/planning.ts` | Direct | 5 `any` à éliminer. Catch `(error: any)` → `(error: unknown)`. |
| `src/commands/memory-cmds.ts` | Direct | 5 `any` à éliminer. Résultats Supabase typés. |
| `src/alerts.ts` | Direct | 5 `any` à éliminer. Import `Task` depuis `tasks.ts` pour les `.filter`/`.map`. |
| `src/adversarial-verifier.ts` | Direct | 5 `any` à éliminer. `normalizeDriftReport` migre vers `unknown`. Module terminal (non importé par d'autres modules `src/`). |
| `src/spec-lite.ts` | Direct | 4 `any` à éliminer. `normalizeProtoSpec` migre vers `unknown`. Importé par `orchestrator.ts` et `prd-workflow.ts`. |
| `src/commands/exploration.ts` | Direct | 4 `any` à éliminer. |
| `src/commands/execution.ts` | Direct | 4 `any` à éliminer. Catch `unknown`. |
| `src/command-router.ts` | Direct | 4 `any` à éliminer. Pattern GrammY `message_thread_id`. Importé par `relay.ts` via le chargement des Composers. |
| `src/bot-context.ts` | Direct | 4 `any` à éliminer. Exporté (type `BotContext`, constantes) vers 13 Composer modules et `loader.ts`. |
| `src/pipeline-selection.ts` | Direct | 3 `any` à éliminer. `supabase?: any` → `supabase?: SupabaseClient`. Importé par `prd-workflow.ts` et `orchestrator.ts`. |
| `src/agent-context.ts` | Direct | 3 `any` à éliminer. `.map((f: any))` sur résultats Supabase. Non importé par d'autres modules `src/` (terminal). |
| `src/adversarial-challenge.ts` | Direct | 3 `any` à éliminer. `normalizeFindings` migre vers `unknown`. Importé par `orchestrator.ts`. |
| `src/memory.ts` | Direct | 2 `any` à éliminer. Importé par `bot-context.ts`, `orchestrator.ts`, `heartbeat.ts`, `llm-router.ts`, `agent-context.ts`, `exploration-scoring.ts`, `commands/utilities.ts`. |
| `src/agent-schemas.ts` | Direct | 2 `any` à éliminer. `validateAgentOutput(obj: any)` → `(obj: unknown)`. Importé par `adversarial-challenge.ts`, `spec-lite.ts`, `orchestrator.ts`, `deliberation.ts`, `pipeline-state.ts`, `prd-workflow.ts`. |
| `src/prd-workflow.ts` | Direct | 1 `any` à éliminer. Typage de `prd.metadata`. Importé par `job-manager.ts` et `commands/planning.ts`. |
| `src/llm-router.ts` | Direct | 1 `any` à éliminer. `normalizeDecision(obj: any)` → `(obj: unknown)`. Importé par `auto-pipeline.ts`. |
| `src/job-manager.ts` | Direct | 1 `any` à éliminer. Catch `unknown`. Importé par 5 modules Composer + `relay.ts`. |
| `src/feedback-loop.ts` | Direct | 1 `any` à éliminer. `.map((row: any))` → interface `FeedbackRuleRow` (interface `FeedbackRule` déjà exportée depuis le fichier). |
| `src/doc-utils.ts` | Direct | 1 `any` à éliminer. Catch `(e: any)` → `(e: unknown)`. Non importé par d'autres modules `src/`. |
| `src/commands/utilities.ts` | Direct | 1 `any` à éliminer. Catch `unknown`. |
| `src/commands/quality.ts` | Direct | 1 `any` à éliminer. `.map((t: Task))`. Consomme les exports `formatMetrics`, `formatRetro`, `getAllSprintMetrics` de `workflow.ts`. |
| `src/bmad-prompts.ts` | Direct | 1 `any` à éliminer. Cast `agentId`. Importé par `orchestrator.ts`, `code-review.ts`, `commands/exploration.ts`. |
| `src/bmad-agents.ts` | Direct | 1 `any` à éliminer. Cast `task as Task`. Importé par 7 modules `src/`. |
| `src/commands/quality.ts` | Indirect | Consomme les types de retour concrets de `workflow.ts` (`formatMetrics(metrics: SprintMetrics)`, `getAllSprintMetrics()` → `SprintMetrics[]`). Si les interfaces sont bien définies et compatibles, aucune modification n'est nécessaire dans ce fichier. |
| `src/agent-messaging.ts` | Indirect | Consomme `BlackboardSections` (via `readSection`/`writeSectionWithRetry`). Le typage `Record<string, unknown>` sur les sections `messages` peut nécessiter des ajustements dans les accès aux propriétés. |
| `biome.json` | Direct | `noExplicitAny: "warn"` → `"error"` (PR finale uniquement). |
| `.github/workflows/ci.yml` | Direct | Seuil anti-régression `600` → `3300`. |
| `tests/unit/deliberation.test.ts` | Créé | Nouveau fichier de test. Impact uniquement sur la couverture. |
| `tests/unit/document-sharding.test.ts` | Créé | Nouveau fichier de test. |
| `tests/unit/heartbeat-prompt.test.ts` | Créé | Doublon potentiel avec `heartbeat.test.ts` (voir points d'attention). |
| `tests/unit/llm-ops.test.ts` | Créé | Nouveau fichier de test. |
| `tests/unit/relay.test.ts` | Créé | Nouveau fichier de test. Risque d'initialisation involontaire du bot. |
| `tests/unit/topic-config.test.ts` | Créé | Nouveau fichier de test. Pure. |
| `tests/unit/transcribe.test.ts` | Créé | Nouveau fichier de test. |

---

### API publiques modifiées

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/blackboard.ts` | `BlackboardSections.spec/.plan/.tasks/.implementation/.messages` | Modification de type (`any` → `Record<string, unknown>`) | Oui — `Record<string, unknown>` est plus strict mais accepte les mêmes valeurs objets |
| `src/workflow.ts` | `formatMetrics(metrics: any)` | Modification de signature (`any` → `SprintMetrics`) | Oui si `SprintMetrics` couvre tous les champs utilisés par `quality.ts` |
| `src/workflow.ts` | `formatRetro(retro: any)` | Modification de signature (`any` → `RetroRow`) | Oui si `RetroRow` couvre les champs utilisés |
| `src/workflow.ts` | `getAllSprintMetrics(supabase)` → `Promise<any[]>` | Modification de retour (`any[]` → `SprintMetrics[]`) | Oui — type plus strict, aucun breaking change pour les consommateurs |
| `src/workflow.ts` | `getRetro(supabase, sprintId)` → `Promise<any \| null>` | Modification de retour (`any \| null` → `RetroRow \| null`) | Oui — type plus strict |
| `src/workflow.ts` | `logWorkflowAudit(supabase: any, ...)` | Modification de paramètre (`any` → `SupabaseClient`) | Oui — les appelants actuels passent déjà un vrai `SupabaseClient` |
| `src/pipeline-selection.ts` | `classifyAdaptivePipeline(task, supabase?: any)` | Modification de paramètre (`any` → `SupabaseClient`) | Oui — backward-compatible, `supabase` reste optionnel |
| `src/agent-schemas.ts` | `validateAgentOutput(obj: any, role)` | Modification de paramètre (`any` → `unknown`) | Oui — `unknown` est plus strict mais aucun consommateur ne passe un type non-object |
| `src/spec-lite.ts` | `normalizeProtoSpec(obj: any, ...)` (privée) | Modification de paramètre interne | Non applicable — fonction privée |
| `src/llm-router.ts` | `normalizeDecision(obj: any)` (privée) | Modification de paramètre interne | Non applicable — fonction privée |
| `src/adversarial-challenge.ts` | `normalizeFindings(raw: any[])` (privée) | Modification de paramètre interne | Non applicable — fonction privée |
| `src/gate-evaluator.ts` | `normalizeEvaluation(obj: any, ...)` (privée) | Modification de paramètre interne | Non applicable — fonction privée |
| `.github/workflows/ci.yml` | Seuil anti-régression | Modification de valeur (`600` → `3300`) | N/A — CI uniquement |
| `biome.json` | `noExplicitAny` | Modification de niveau (`"warn"` → `"error"`) | N/A — linter uniquement, sans effet runtime |

---

### Breaking changes potentiels

- [ ] **`BlackboardSections` : `spec/plan/tasks/implementation/messages` passent de `any | null` à `Record<string, unknown> | null`** — impact : `orchestrator.ts` lignes 743-1267 (accès par clé sur ces sections), `agent-messaging.ts` lignes 54-212. Si le code accède à des propriétés typées sur ces sections (ex : `spec.title`), TypeScript exigera un narrowing ou un cast explicite. Sans adaptation, `bunx tsc --noEmit` produira des erreurs sur ces accès.

- [ ] **`formatMetrics(metrics: SprintMetrics)` : si l'interface `SprintMetrics` ne couvre pas tous les champs accédés dans `formatMetrics` lui-même** — impact : `commands/quality.ts`. Risque faible si les champs sont alignés avec le schéma SQL, mais à vérifier lors de la définition de l'interface.

- [ ] **Seuil CI `3300` activé avant que les 7 nouveaux fichiers de tests existent** — impact : rupture de CI si les tests sont poussés dans des PRs séparées sans respecter l'ordre. Le seuil doit être activé dans la même PR que les 7 fichiers de tests.

- [ ] **`relay.test.ts` : démarrage involontaire du bot** — impact : instabilité CI si l'import de `relay.ts` déclenche des effets de bord (connexion Telegram). Le guard `import.meta.main` protège l'exécution principale, mais les imports de niveau module (`BOT_TOKEN`, etc.) s'exécutent à l'import. Vérifier que `bot-context.ts` ne lève pas d'erreur fatale à l'import quand les env vars sont absentes (indiqué safe par le code, mais à confirmer à l'exécution).

---

### Points d'attention pour le Reviewer

1. **Accès aux propriétés de `BlackboardSections` dans `orchestrator.ts`** : après le passage de `spec/plan/tasks/implementation/messages` à `Record<string, unknown>`, tous les accès par propriété nommée (ex : `spec.title`, `plan.roles`) devront être précédés de narrowing ou de cast. Vérifier les lignes 743, 770, 924, 1073, 1267 dans `src/orchestrator.ts` et les lignes 54-212 dans `src/agent-messaging.ts`. Fichiers à vérifier : `/home/edouard/claude-telegram-relay/src/orchestrator.ts`, `/home/edouard/claude-telegram-relay/src/agent-messaging.ts`.

2. **Définition de `SprintMetrics` compatible avec `workflow.ts` ET `agent-context.ts`** : `agent-context.ts` exporte `fetchSprintMetrics` (ligne 404) qui construit aussi des objets métriques depuis Supabase. Si l'interface `SprintMetrics` est définie dans `workflow.ts`, s'assurer qu'elle est importée (et non redéfinie) dans `agent-context.ts` pour éviter un conflit de types structurels. Fichiers à vérifier : `/home/edouard/claude-telegram-relay/src/workflow.ts`, `/home/edouard/claude-telegram-relay/src/agent-context.ts`.

3. **`heartbeat-prompt.test.ts` vs `heartbeat.test.ts` existant** : `tests/unit/heartbeat.test.ts` importe déjà `createDefaultState` et `buildHeartbeatPrompt` depuis `src/heartbeat-prompt.ts` (lignes 13-16). Créer un second fichier test couvrant les mêmes fonctions sans doublon. Recommandation : renommer `heartbeat.test.ts` → `heartbeat-prompt.test.ts` et ajouter les cas manquants, OU créer `heartbeat-prompt.test.ts` avec des cas complémentaires (edge cases non couverts). Risque de conflit de `describe` blocks si les deux fichiers existent avec les mêmes cas. Fichiers à vérifier : `/home/edouard/claude-telegram-relay/tests/unit/heartbeat.test.ts`.

4. **`deliberation.test.ts` vs `orchestrator-deliberation.test.ts` existant** : `tests/unit/orchestrator-deliberation.test.ts` importe déjà `shouldDeliberate` et `getDeliberationReviewer` depuis `src/deliberation.ts`. Note : `DELIBERATION_PAIRS` n'est pas exportée depuis `deliberation.ts` (constante privée). La spec (section 4.2) indique de tester `DELIBERATION_PAIRS` mais ce n'est pas possible sans export. Recommandation : renommer `orchestrator-deliberation.test.ts` → `deliberation.test.ts` et compléter. Fichier à vérifier : `/home/edouard/claude-telegram-relay/tests/unit/orchestrator-deliberation.test.ts`.

5. **Séquençage des PRs : seuil CI `3300` et `noExplicitAny: "error"`** : la règle R11 et R12 exigent que ces deux changements soient les derniers. Si les PRs sont fusionnées dans le mauvais ordre (ex : `biome.json` activé avant élimination complète des `any`), la CI cassera immédiatement. Point de coordination critique pour le Reviewer entre les PRs. Fichiers à vérifier : `/home/edouard/claude-telegram-relay/biome.json`, `/home/edouard/claude-telegram-relay/.github/workflows/ci.yml`.

6. **`pipeline-selection.ts` : `supabase?: SupabaseClient` casse les callers sans import** : `classifyAdaptivePipeline` est appelé depuis `orchestrator.ts` (lignes 92, 121) qui importe déjà `SupabaseClient`. Vérifier que l'import n'est pas dupliqué. Risque faible mais à contrôler. Fichier à vérifier : `/home/edouard/claude-telegram-relay/src/pipeline-selection.ts`.

---

### Blast radius

- Modules directement modifiés : 31 fichiers `src/` + 2 fichiers de config (`biome.json`, `.github/workflows/ci.yml`) = **33 fichiers**
- Modules indirectement impactés (consommateurs des API modifiées) : `orchestrator.ts`, `agent-messaging.ts`, `commands/quality.ts`, `auto-pipeline.ts`, `prd-workflow.ts` = **5 modules**
- Fichiers de test créés : **7 fichiers**
- Fichiers de test potentiellement à adapter (doublons) : **2 fichiers** (`heartbeat.test.ts`, `orchestrator-deliberation.test.ts`)
- Fichiers de test existants à surveiller pour non-régression (couvrant les modules impactés) : `blackboard.test.ts`, `workflow.test.ts`, `patterns.test.ts`, `gate-evaluator.test.ts`, `orchestrator.test.ts`, `agent-messaging.test.ts`, `pipeline-selection.test.ts`, `agent-schemas.test.ts`, `spec-lite.test.ts`, `feedback-loop.test.ts` = **10 fichiers**
