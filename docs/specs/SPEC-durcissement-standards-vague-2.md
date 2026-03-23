# Spec : Durcissement standards de développement — Vague 2

> Généré le 2026-03-23. Source : docs/explorations/EXPLORE-il-faut-ameliorer-les-standards-de.md (section 5), analyse codebase (grep any, inventaire tests), contraintes vague 1 fournies.

## 1. Objectif

Éliminer les `any` TypeScript explicites dans `src/` fichier par fichier (155 occurrences sur 31 fichiers), ajouter des tests unitaires pour les 7 modules actuellement non couverts (deliberation, document-sharding, heartbeat-prompt, llm-ops, relay, topic-config, transcribe), et passer `noExplicitAny` de `"warn"` à `"error"` dans `biome.json` uniquement après que tous les `any` sont éliminés. Cela consolide les acquis de la vague 1 (tsconfig strict, config.ts Zod, hooks pre-commit typecheck) et élève le niveau de fiabilité du codebase sans risque de régression.

---

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Les 155 occurrences de `any` dans `src/` (hors `tests/`, `scripts/`, `mcp/`, `dashboard/`) doivent être remplacées par un type précis : type spécifique existant, `unknown` + type-guard, ou générique typé | Exploration EXPLORE section 5 + grep codebase | `(t: any) => t.status` → `(t: Task) => t.status` |
| R2 | Les `any` liés aux résultats Supabase (`.select("*")`) utilisent le type de table correspondant défini dans `src/tasks.ts`, `src/workflow.ts` etc., ou `Record<string, unknown>` si aucun type n'est disponible | Analyse codebase : proactive-planner.ts utilise `tasks.filter((t: any)` alors que `Task` existe dans tasks.ts | `tasks.filter((t: Task) => t.status === "done")` |
| R3 | Les `any` liés aux messages GrammY (ctx.message, ctx.callbackQuery) utilisent le cast `as { message_thread_id?: number }` ou le type GrammY précis (`Message.CommonMessage`) pour accéder aux propriétés non typées | Analyse bot-context.ts ligne 421-422, command-router.ts | `(ctx.message as { message_thread_id?: number })?.message_thread_id` |
| R4 | Les `any` dans les fonctions de normalisation d'output agent (normalizeFindings, normalizeDriftReport, normalizeEvaluation) utilisent `unknown` + type-guards explicites | Analyse adversarial-challenge.ts, adversarial-verifier.ts, gate-evaluator.ts | `function normalizeFindings(raw: unknown[]): ...` avec `if (typeof f === "object" && f !== null)` |
| R5 | Les types de données Blackboard (`spec`, `plan`, `tasks`, `implementation`, `messages`) sont typés avec des interfaces spécifiques ou `Record<string, unknown>` — pas `any` | Analyse blackboard.ts lignes 39-45 | `spec: Record<string, unknown> \| null` |
| R6 | Les paramètres Supabase et les fonctions utilitaires de bas niveau qui reçoivent `supabase?: any` utilisent le type `SupabaseClient` importé depuis `@supabase/supabase-js` | Analyse pipeline-selection.ts, workflow.ts | `supabase?: SupabaseClient` |
| R7 | Les fonctions de formatage (`formatMetrics`, `formatRetro`) qui reçoivent `metrics: any` ou `retro: any` sont typées avec l'interface correspondante (`SprintMetrics`, `RetroRow`) définie à partir du schéma SQL | Analyse workflow.ts lignes 425, 598 + db/schema.sql |  `formatMetrics(metrics: SprintMetrics): string` |
| R8 | Les 7 modules sans tests unitaires dédiés reçoivent chacun un fichier `tests/unit/{module}.test.ts` avec au minimum : (a) smoke test d'import, (b) test des exports publics, (c) test des cas d'erreur / edge cases | Exploration section 5 + analyse tests/ |  `deliberation.test.ts`, `document-sharding.test.ts`, etc. |
| R9 | Les tests des modules sans effets de bord (heartbeat-prompt, topic-config) testent la logique pure (fonctions de transformation, constantes) directement sans mock | Analyse heartbeat-prompt.ts (pas d'imports Supabase), topic-config.ts (exports de constantes) | `expect(TOPIC_CONFIGS["claude-relay"].allowedCommands).toContain("exec")` |
| R10 | Les tests des modules avec effets de bord externes (transcribe, relay) testent les guard conditions et les branches sans dépendance réseau via des variables d'environnement vides ou des mocks minimalistes | Analyse transcribe.ts ligne 26 : `if (!VOICE_PROVIDER) return ""` | `expect(await transcribe(Buffer.from(""))).toBe("")` quand VOICE_PROVIDER non défini |
| R11 | `noExplicitAny: "error"` dans `biome.json` n'est activé qu'après que TOUS les `any` dans `src/` ont été éliminés et que `bun test` + `bunx tsc --noEmit` passent sans erreur | Contrainte vague 2 fournie — séquençage obligatoire | La PR qui passe `warn` → `error` ne doit contenir aucun `any` résiduel |
| R12 | Le seuil de régression CI passe de `600` à `3441` tests dans `.github/workflows/ci.yml` après l'ajout des tests des 7 modules (adversarial F-DA-10 : le test count actuel est 3441, pas 3095) | Contrainte vague 2 fournie + test count actuel 3441 | `if [ "$PASS_COUNT" -lt 3441 ]` |
| R13 | Aucun import ni type des modules `tests/`, `scripts/`, `mcp/`, `dashboard/` n'est modifié — seul `src/` est dans le périmètre de l'élimination des `any` | Contrainte de périmètre fournie | `tests/unit/*.test.ts` peuvent continuer à utiliser `as any` dans les mocks si nécessaire |
| R14 | L'ordre de priorité pour l'élimination des `any` suit le nombre d'occurrences décroissant : proactive-planner.ts (26), workflow.ts (18), blackboard.ts (14), patterns.ts (9), gate-evaluator.ts (9) en premier | Analyse grep codebase — traiter les fichiers les plus chargés en premier pour libérer le seuil Biome rapidement | |

---

## 3. Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| `src/*.ts` (31 fichiers avec `any`) | Fichiers TypeScript source | Read / Edit directs | Toutes les occurrences `: any`, `as any`, `any[]`, `Promise<any>` |
| `src/tasks.ts` | Interface `Task` | Import | Propriétés : `id`, `status`, `priority`, `sprint`, `created_at`, `updated_at`, `title` |
| `db/schema.sql` | Définitions de tables SQL | Read | `sprint_metrics`, `retros`, `workflow_logs` — colonnes pour construire les interfaces TS |
| `biome.json` | Config linter | Read / Edit | `linter.rules.suspicious.noExplicitAny` |
| `.github/workflows/ci.yml` | Config CI | Read / Edit | Seuil `600` dans le check anti-régression |
| `tests/unit/*.test.ts` (existants) | Fichiers de tests existants | Read | Patterns de test (imports, describe/it structure, mocks) |
| `src/deliberation.ts`, `src/document-sharding.ts`, `src/heartbeat-prompt.ts`, `src/llm-ops.ts`, `src/relay.ts`, `src/topic-config.ts`, `src/transcribe.ts` | Modules sans tests | Read | Exports publics, fonctions testables, guard conditions |

---

## 4. Données de sortie

### 4.1 Fichiers `src/` modifiés (élimination `any`)

Pour chaque fichier, les `any` sont remplacés par le type adéquat. La structure des fonctions et signatures publiques reste identique — seuls les types internes changent. Exemple de transformation pour `proactive-planner.ts` :

```typescript
// Avant
function detectStuckPatterns(tasks: any[]): PlannerRecommendation[]

// Après
function detectStuckPatterns(tasks: Task[]): PlannerRecommendation[]
```

**Nouveaux types à définir** (dans le fichier concerné ou importés) :

| Fichier | Type nouveau/importé | Remplace |
|---------|---------------------|---------|
| `workflow.ts` | `interface SprintMetrics` (id, sprint_id, tasks_planned, tasks_completed, completion_rate, avg_delivery_hours, first_pass_rate, incidents_count, rework_count, total_tokens, total_cost_usd, agent_executions, sprint_started_at, sprint_ended_at, retro_actions_proposed, retro_actions_accepted, project_id, created_at) — tous les champs du schema SQL (adversarial F-DA-4) | `metrics: any`, `metricsList: any[]` |
| `workflow.ts` | `interface RetroRow` (sprint_id, what_worked, what_didnt, patterns_detected, actions_proposed, actions_accepted, raw_analysis, validated_at) | `retro: any` dans `formatRetro` / `getRetro` |
| `workflow.ts` | `interface WorkflowLogRow` (task_id, sprint_id, step_from, step_to, had_rework, duration_seconds, checkpoint_result) | `(l: any)` dans les `.filter` / `.map` |
| `blackboard.ts` | `type SectionData = Record<string, unknown>` | `any \| null` dans `BlackboardSections.spec`, `.plan`, `.tasks`, `.implementation`, `.messages` |
| `patterns.ts` | `interface RetroRow` (réutiliser depuis workflow.ts ou co-définir) | `retros: any[]` |
| `proactive-planner.ts` | Import `Task` depuis `./tasks.ts` | Tous les `(t: any)` dans les `.filter` / `.map` |

### 4.2 Nouveaux fichiers de tests (7 modules)

| Fichier créé | Tests minimaux |
|-------------|---------------|
| `tests/unit/deliberation.test.ts` | Existe déjà partiellement dans `orchestrator-deliberation.test.ts` — créer un fichier dédié avec : exports publics (`shouldDeliberate`, `getDeliberationReviewer`), constants `DELIBERATION_PAIRS` |
| `tests/unit/document-sharding.test.ts` | Smoke test imports, `tokenEstimate()`, `splitIntoSections()` sur texte minimal, edge case section vide |
| `tests/unit/heartbeat-prompt.test.ts` | Déjà couvert dans `heartbeat.test.ts` (importe depuis `heartbeat-prompt`) — renommer ou créer alias si nécessaire. Vérifier que l'import direct de `heartbeat-prompt.ts` est testé |
| `tests/unit/llm-ops.test.ts` | Circuit-breaker logic (état open/closed), `CB_TRUST_THRESHOLD` constante, `LLMOPS_CHECK_INTERVAL_MS`, fonction `buildLlmOpsSnapshot` si pure |
| `tests/unit/relay.test.ts` | Smoke test : module importable sans crash (guard env vars manquantes), pas de test de bot complet |
| `tests/unit/topic-config.test.ts` | `TOPIC_CONFIGS` non vide, chaque topic a `label`, `systemPrompt`, `allowedCommands` non vides, `getTopicConfig` retourne null pour topic inconnu |
| `tests/unit/transcribe.test.ts` | `transcribe(buffer)` retourne `""` quand `VOICE_PROVIDER` est vide, erreur loggée pour provider inconnu |

### 4.3 `biome.json` modifié

```json
"noExplicitAny": "error"
```

(Uniquement après validation complète — voir R11)

### 4.4 `.github/workflows/ci.yml` modifié

```yaml
if [ "$PASS_COUNT" -lt 3441 ]; then
```

---

## 5. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/proactive-planner.ts` | Modifier | 26 occurrences `any` — importer `Task` depuis tasks.ts, typer les paramètres internes |
| `src/workflow.ts` | Modifier | 18 occurrences `any` — définir `SprintMetrics`, `RetroRow`, `WorkflowLogRow`, typer `formatMetrics`, `formatRetro`, `generateRetroData` |
| `src/blackboard.ts` | Modifier | 14 occurrences `any` — remplacer `spec/plan/tasks/implementation/messages: any` par `Record<string, unknown>`, typer `writeSection data`, `overflow` |
| `src/patterns.ts` | Modifier | 9 occurrences `any` — importer ou co-définir `RetroRow`, `SprintMetrics`, typer `computeStepDurations`, `computeSprintRework`, `generateSuggestions` |
| `src/gate-evaluator.ts` | Modifier | 9 occurrences `any` — typer `sectionData` comme `unknown` + narrowing, normalizers avec `unknown` |
| `src/commands/jobs.ts` | Modifier | 7 occurrences `any` — typer les résultats de pipeline (interface `PipelineResult`) |
| `src/profile-evolution.ts` | Modifier | 5 occurrences `any` — importer `Task` depuis tasks.ts, typer les messages Supabase |
| `src/orchestrator.ts` | Modifier | 5 occurrences `any` — typer `spec`, `impl`, `sections` avec types existants ou `Record<string, unknown>` |
| `src/commands/planning.ts` | Modifier | 5 occurrences `any` — typer les catch `(error: unknown)`, les `.map((t: Task))` |
| `src/commands/memory-cmds.ts` | Modifier | 5 occurrences `any` — typer les résultats mémoire Supabase |
| `src/alerts.ts` | Modifier | 5 occurrences `any` — importer `Task` pour les filtres de tâches |
| `src/adversarial-verifier.ts` | Modifier | 5 occurrences `any` — utiliser `unknown` + narrowing dans normalizeDriftReport, typer `spec` / `implementation` / `devOutput` |
| `src/spec-lite.ts` | Modifier | 4 occurrences `any` — normalizeProtoSpec avec `unknown` |
| `src/commands/exploration.ts` | Modifier | 4 occurrences `any` — utiliser le cast approprié pour les types d'agent |
| `src/commands/execution.ts` | Modifier | 4 occurrences `any` — typer `adversarialResult`, `impactResult`, catch `unknown` |
| `src/command-router.ts` | Modifier | 4 occurrences `any` — même pattern que bot-context.ts pour message_thread_id |
| `src/bot-context.ts` | Modifier | 4 occurrences `any` — cast GrammY typé pour thread_id et reply_to_message |
| `src/pipeline-selection.ts` | Modifier | 3 occurrences `any` — remplacer `supabase?: any` par `supabase?: SupabaseClient` |
| `src/agent-context.ts` | Modifier | 3 occurrences `any` — typer les `.map((f: any))` avec les types de résultats Supabase |
| `src/adversarial-challenge.ts` | Modifier | 3 occurrences `any` — utiliser `unknown` dans normalizeFindings |
| `src/memory.ts` | Modifier | 2 occurrences `any` — typer les résultats `.map((r: any))` |
| `src/agent-schemas.ts` | Modifier | 2 occurrences `any` — typer `validateAgentOutput(obj: unknown, ...)` |
| `src/prd-workflow.ts` | Modifier | 1 occurrence `any` — typer `prd.metadata` avec une interface |
| `src/llm-router.ts` | Modifier | 1 occurrence `any` — typer `normalizeDecision(obj: unknown)` |
| `src/job-manager.ts` | Modifier | 1 occurrence `any` — typer le catch `(error: unknown)` |
| `src/feedback-loop.ts` | Modifier | 1 occurrence `any` — typer le `.map((row: any))` avec interface `FeedbackRuleRow` |
| `src/doc-utils.ts` | Modifier | 1 occurrence `any` — typer le catch `(e: unknown)` |
| `src/commands/utilities.ts` | Modifier | 1 occurrence `any` — catch `(error: unknown)` |
| `src/commands/quality.ts` | Modifier | 1 occurrence `any` — typer le `.map((t: Task))` |
| `src/bmad-prompts.ts` | Modifier | 1 occurrence `any` — typer le cast agentId |
| `src/bmad-agents.ts` | Modifier | 1 occurrence `any` — typer le cast `task as Task` |
| `src/commands/zz-messages.ts` | Modifier | 1 occurrence `Promise<any[]>` manquante dans l'inventaire initial (adversarial F-DA-1) |
| `tests/unit/deliberation.test.ts` | Créer | Module sans tests unitaires dédiés (couverture partielle via orchestrator-deliberation) |
| `tests/unit/document-sharding.test.ts` | Créer | Module sans tests |
| `tests/unit/heartbeat-prompt.test.ts` | Créer | Module sans test dédié (couvert indirectement via heartbeat.test.ts) |
| `tests/unit/llm-ops.test.ts` | Créer | Module sans tests |
| `tests/unit/relay.test.ts` | Créer | Module sans tests |
| `tests/unit/topic-config.test.ts` | Créer | Module sans tests |
| `tests/unit/transcribe.test.ts` | Créer | Module sans tests |
| `biome.json` | Modifier | Passer `noExplicitAny` de `"warn"` à `"error"` (après élimination complète) |
| `.github/workflows/ci.yml` | Modifier | Seuil anti-régression 600 → 3441 |

---

## 6. Patterns existants

### 6.1 Import de `Task` depuis tasks.ts (pattern à généraliser)

`src/proactive-planner.ts` lignes 54-145 : utilise `supabase.from("tasks").select("*")` et itère avec `(t: any)`. Le type `Task` est déjà défini dans `src/tasks.ts` (lignes 23-45) avec toutes les propriétés. Ce pattern d'import est déjà utilisé dans `src/alerts.ts` ligne 1 :

```typescript
import type { Task } from "./tasks.ts";
```

### 6.2 Pattern `unknown` + type-guard pour normalizers

`src/spec-lite.ts` ligne 133 `normalizeProtoSpec(obj: any, ...)` — pattern à migrer vers `unknown`. Exemple existant avec `unknown` dans `src/agent-schemas.ts` ligne 758 :

```typescript
export function validateAgentOutput(obj: any, role: AgentRole): boolean {
```

À transformer en :

```typescript
export function validateAgentOutput(obj: unknown, role: AgentRole): boolean {
  if (!obj || typeof obj !== "object") return false;
  ...
}
```

### 6.3 Pattern `SupabaseClient` comme type de paramètre

Tous les modules service (`tasks.ts`, `memory.ts`, `workflow.ts`, `gates.ts`) utilisent `SupabaseClient` depuis `@supabase/supabase-js`. `pipeline-selection.ts` et `workflow.ts` utilisent `supabase?: any` — à remplacer par `supabase?: SupabaseClient` comme dans `src/orchestrator.ts` ligne 1.

### 6.4 Pattern catch avec `unknown`

`src/commands/planning.ts` ligne 187 : `catch (error: any)`. Le pattern correct déjà utilisé dans `src/job-manager.ts` voisins :

```typescript
} catch (error: unknown) {
  log.error("description", { error: String(error) });
}
```

### 6.5 Pattern de test de module Bun (sans effets de bord)

`tests/unit/tts.test.ts` (lignes 1-60) : test d'un module I/O avec guard condition `if (!VOICE_PROVIDER) return ""` — testable directement sans mock. Même pattern applicable à `transcribe.ts` ligne 26.

### 6.6 Pattern test de constantes exportées

`tests/unit/feature-flags.test.ts` (lignes 22-28) : smoke test d'une constante exportée. Même pattern pour `TOPIC_CONFIGS` dans `topic-config.ts` et `HEARTBEAT_DECISION_SCHEMA` dans `heartbeat-prompt.ts`.

### 6.7 Pattern test de fonctions pures de parsing

`tests/unit/llm-router.test.ts` (lignes 9-60) : test direct de fonctions de parsing sans Supabase. Même pattern pour `normalizeDecision` dans `llm-router.ts` et les fonctions de normalisation dans les modules verifier/challenge.

### 6.8 Cast GrammY pour thread_id (pattern unifié bot-context / command-router)

`src/bot-context.ts` lignes 421-422 et `src/command-router.ts` lignes 341-342 utilisent le même `as any`. Pattern à unifier :

```typescript
// Type helper dédié
type MessageWithThread = { message_thread_id?: number };
const threadId = (ctx.message as MessageWithThread)?.message_thread_id ?? 0;
```

---

## 7. Contraintes

- **Non-régression tests** : les 3441 tests actuels doivent tous passer après chaque PR de vague 2. Aucune suppression de test existant autorisée.
- **Périmètre `src/` uniquement** : les fichiers `tests/`, `scripts/`, `mcp/`, `dashboard/` sont hors périmètre pour l'élimination des `any`. Les fichiers de tests peuvent continuer à utiliser `as any` dans les mocks si nécessaire.
- **Séquençage obligatoire** : `noExplicitAny: "error"` dans biome.json ne peut être activé qu'en dernière PR, après que tous les `any` dans `src/` sont éliminés et que `bunx biome check` + `bunx tsc --noEmit` passent sans erreur.
- **Vague 1 acquise** : tsconfig.json strict est présent (commit 71e7bb0), `src/config.ts` avec `getConfig()` existe, `noUnusedImports: "error"` et `noExplicitAny: "warn"` sont déjà actifs dans biome.json, typecheck est dans le hook pre-commit et CI.
- **`noUncheckedIndexedAccess` retiré** : ce flag a été retiré de tsconfig.json car trop d'erreurs — ne pas le réintroduire dans cette vague.
- **Types Supabase** : les requêtes `.select("*")` retournent des types `unknown[]` non inférés depuis le schéma. Pour les cas simples, utiliser l'interface définie dans le module (ex : `Task`). Pour les cas complexes (jointures, RPCs), utiliser `Record<string, unknown>` ou une interface ad-hoc minimale.
- **BlackboardSections narrowing** (adversarial Impact) : le passage de `any | null` à `Record<string, unknown> | null` pour les sections Blackboard force un narrowing sur tous les sites d'accès par propriété dans `orchestrator.ts` (~8 sites) et `agent-messaging.ts` (~6 sites). Ces fichiers doivent être adaptés pour caster ou narrower les accès (`(section as Record<string, unknown>).fieldName`).
- **Modules GrammY** : certains types GrammY n'exposent pas `message_thread_id` — utiliser des casts locaux typés (`as { message_thread_id?: number }`) plutôt que `as any`.
- **Module `relay.ts`** : il ne peut pas être instancié dans les tests (démarre le bot Telegram). Le test doit uniquement vérifier que le module s'importe sans crash quand les variables d'environnement sont absentes (pas d'appel à `new Bot()`).
- **Module `deliberation.ts`** : `orchestrator-deliberation.test.ts` teste déjà `shouldDeliberate` et `getDeliberationReviewer`. Le nouveau `deliberation.test.ts` peut réexporter ces tests ou se concentrer sur les cas non couverts.
- **Runtime** : Bun 1.x — la syntaxe `import.meta.dir` est disponible dans les tests. Pas de `__dirname`.

---

## 8. Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|-------------|--------|
| V1 | `bunx biome check --diagnostic-level=error src/` avec `noExplicitAny: "error"` retourne 0 erreurs (couvre tous les patterns : `: any`, `as any`, `any[]`, `Promise<any>`, `<any>`) — PAS un grep qui rate les generiques (adversarial F-EC-8) | Biome check avec noExplicitAny error | unit |
| V2 | `bunx tsc --noEmit` passe sans erreur après toutes les modifications de types | Déjà dans CI (step "Type check") et hook pre-commit | unit |
| V3 | `bunx biome check src/` passe sans `noExplicitAny` warning/error | Biome check en CI via step biome-check hook pre-commit | unit |
| V4 | `bun test tests/unit tests/integration tests/system` retourne `>= 3441 pass, 0 fail` | CI step "Verify test count" avec seuil mis a jour (adversarial F-DA-10) | integration |
| V5 | `proactive-planner.ts` : `detectStuckPatterns(tasks)` accepte `Task[]`, TypeScript valide la signature | `bunx tsc --noEmit` couvre cela | unit |
| V6 | `workflow.ts` : `formatMetrics(metrics: SprintMetrics)` est appelable depuis les tests sans erreur de type, avec toutes les propriétés du schéma SQL accessibles | Test unitaire dans `workflow.test.ts` existant + typecheck | unit |
| V7 | `blackboard.ts` : `BlackboardSections.spec` est de type `Record<string, unknown> \| null` — pas `any \| null` | `bunx tsc --noEmit` | unit |
| V8 | `biome.json` a `"noExplicitAny": "error"` après la PR finale | Lecture du fichier + `bunx biome check src/` sans erreurs | manual |
| V9 | `.github/workflows/ci.yml` a le seuil `3441` | Lecture du fichier + CI verte (adversarial F-DA-10) | integration |
| V10 | `tests/unit/deliberation.test.ts` existe, passe, et importe directement depuis `src/deliberation.ts` | `bun test tests/unit/deliberation.test.ts` | unit |
| V11 | `tests/unit/document-sharding.test.ts` existe, passe, couvre au moins les exports publics et un cas d'erreur | `bun test tests/unit/document-sharding.test.ts` | unit |
| V12 | `tests/unit/heartbeat-prompt.test.ts` existe, passe, couvre `createDefaultState()` et `buildHeartbeatPrompt()` | `bun test tests/unit/heartbeat-prompt.test.ts` | unit |
| V13 | `tests/unit/llm-ops.test.ts` existe, passe, couvre le COMPORTEMENT du circuit-breaker (pas les constantes internes non exportees — adversarial F-DA-7) et `LLMOPS_CHECK_INTERVAL_MS` | `bun test tests/unit/llm-ops.test.ts` | unit |
| V14 | `tests/unit/relay.test.ts` existe, passe, et ne démarre pas le bot Telegram — vérifie seulement les exports constants | `bun test tests/unit/relay.test.ts` | unit |
| V15 | `tests/unit/topic-config.test.ts` existe, passe, verifie que `TOPIC_CONFIGS` contient les topics attendus avec les champs requis, et que `getTopicConfig` retourne `undefined` (pas `null` — adversarial F-DA-6) pour un topic inconnu | `bun test tests/unit/topic-config.test.ts` | unit |
| V16 | `tests/unit/transcribe.test.ts` existe, passe, vérifie que `transcribe(buffer)` retourne `""` quand `VOICE_PROVIDER` est vide | `bun test tests/unit/transcribe.test.ts` | unit |
| V17 | Les catch `(error: any)` dans `src/commands/` sont migrés vers `(error: unknown)` avec `String(error)` | `bunx biome check src/commands/` — après activation `noExplicitAny: "error"` | unit |
| V18 | `src/pipeline-selection.ts` : les signatures avec `supabase?: any` utilisent `supabase?: SupabaseClient` | `bunx tsc --noEmit` | unit |
| V19 | Pas de régression : tous les tests existants avant la vague 2 passent encore (3441 minimum) | `bun test` — 0 fail | integration |
| V20 | `src/workflow.ts` : `getAllSprintMetrics` retourne `SprintMetrics[]` et non `any[]` | `bunx tsc --noEmit` | unit |

---

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Problème | Couvert | 155 occurrences `any` inventoriées par grep exact, 7 modules sans tests identifiés, séquençage clair |
| Périmètre | Couvert | IN scope : `src/*.ts` seulement. OUT scope explicite : `tests/`, `scripts/`, `mcp/`, `dashboard/`. Séquençage défini (any → tests → biome `error`) |
| Validation | Couvert | 20 V-critères couvrant grep zéro `any`, typecheck, biome check, test count, chaque module de test, et non-régression |
| Technique | Couvert | Patterns de remplacement identifiés (Task import, unknown + narrowing, SupabaseClient, catch unknown, GrammY cast). Contraintes Bun/GrammY documentées |
| UX | Non applicable | Pas d'interaction utilisateur modifiée — changements purement internes au codebase |
| Alternatives | Pertinent | Deux approches évaluées pour les types Supabase : (A) interfaces ad-hoc définies dans le module vs (B) types générés automatiquement via `supabase gen types`. L'option A est recommandée à ce stade car la génération de types Supabase nécessite une connexion active et introduit une dépendance de build. Option B reste possible en vague 3+ |

**Zones d'ombre résiduelles :**

1. ~~**`heartbeat-prompt.test.ts` vs `heartbeat.test.ts`**~~ — RESOLU (adversarial F-DA-9) : creer un fichier `heartbeat-prompt.test.ts` dedie qui teste les exports DIRECTS de `src/heartbeat-prompt.ts` (`createDefaultState`, `buildHeartbeatPrompt`, `HEARTBEAT_DECISION_SCHEMA`). Pas de doublon : `heartbeat.test.ts` teste le module heartbeat.ts, pas heartbeat-prompt.ts directement.

2. ~~**`deliberation.test.ts` vs `orchestrator-deliberation.test.ts`**~~ — RESOLU (adversarial F-DA-9) : creer un fichier `deliberation.test.ts` dedie testant les exports DIRECTS de `src/deliberation.ts` (`shouldDeliberate`, `getDeliberationReviewer`). L'existant `orchestrator-deliberation.test.ts` reste inchange (teste l'integration orchestrateur+deliberation).

3. **Types Supabase complexes** : certains `.select("*")` sur des tables sans interface TS définie (ex : `workflow_logs`, `messages`) retourneront `Record<string, unknown>[]`. Les accès à des propriétés spécifiques nécessiteront du narrowing ou des interfaces minimales. La profondeur du typage est laissée à la discrétion de l'implémenteur — l'objectif est de supprimer `any`, pas de typer exhaustivement chaque colonne SQL.

4. **`relay.ts` testabilité** : le module importe `BOT_TOKEN` depuis `bot-context.ts` au niveau module. Si `bot-context.ts` lève une erreur au chargement quand les env vars sont absentes, le test import devra utiliser des env vars factices. À vérifier lors de l'implémentation.
