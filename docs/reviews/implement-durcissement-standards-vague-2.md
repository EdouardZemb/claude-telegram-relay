# Rapport d'implémentation — SPEC-durcissement-standards-vague-2

**Date** : 2026-03-23
**Spec** : docs/specs/SPEC-durcissement-standards-vague-2.md
**Review adversariale** : docs/reviews/adversarial-SPEC-durcissement-standards-vague-2.md
**Pipeline** : Test Architect → Implementer → Tester (TDD)

---

## Phase 1 — Test Architect

Création du squelette de tests dans `tests/generated/durcissement-standards-vague-2.test.ts` :
- V6, V8, V9, V15, V20 : runnable dès le départ
- V7, V10-V16, V17-V19 : `test.skip` (dépendent de l'implémentation)

---

## Phase 2 — Implementer

### Élimination des `any` dans `src/`

155+ occurrences éliminées across 31 fichiers. Patterns utilisés :

**Pattern 1 — Import Task + types Supabase**
- `src/proactive-planner.ts` (26 occurrences) → `Task[]`, lambdas typées
- `src/commands/jobs.ts` → `Task[]`, `Record<string, unknown>[]`

**Pattern 2 — unknown + narrowing**
- `src/gate-evaluator.ts` → `normalizeEvaluation(obj: Record<string, unknown>)`, `parseRubricFromOutput(obj: Record<string, unknown>)`, cast `rubricObj = obj.rubric as Record<string, Record<string, unknown>>`
- `src/spec-lite.ts` → `normalizeProtoSpec(obj: Record<string, unknown>)`
- `src/adversarial-challenge.ts` → `normalizeFindings(raw: unknown[])`, filter type predicate
- `src/adversarial-verifier.ts` → `normalizeDriftReport(obj: Record<string, unknown>)`
- `src/llm-router.ts` → `normalizeDecision(obj: Record<string, unknown>)`, narrowing pipeline/models
- `src/agent-schemas.ts` → `validateAgentOutput(obj: unknown)`, `validateExplorationPhaseOutput(obj: unknown)` avec cast `const o = obj as Record<string, unknown>`
- `src/workflow.ts` → interfaces `SprintMetrics`, `RetroRow`, `WorkflowLogRow` exportées

**Pattern 3 — BlackboardSections**
- `src/blackboard.ts` → `BlackboardSections.spec/plan/tasks/implementation/verification/messages` : `Record<string, unknown> | null` ; `working_memory: WorkingMemory | null`
- `readSection()` retourne `Record<string, unknown> | WorkingMemory | null`
- `mergeImplementationSection()` : cast `existingRaw as Record<string, unknown>`
- `InMemoryBlackboard.write()` : double cast via `as unknown as Record<string, unknown>`
- `src/agent-messaging.ts` : cast `section as unknown as Record<string, unknown>` pour `writeSectionWithRetry`
- `src/orchestrator.ts` : cast `(result.structured || {...}) as Record<string, unknown>` aux 4 sites d'écriture blackboard

**Pattern 4 — catch unknown**
- `src/job-manager.ts` → `catch (error: unknown)`, `error instanceof Error ? error.message : String(error)`
- `src/doc-utils.ts` → `catch (e: unknown)`, cast `(e as { stdout?: string; stderr?: string })`
- `src/commands/utilities.ts` → `catch (error: unknown)`
- `src/commands/planning.ts` → 3 `catch (error: unknown)` avec `.message` corrigés
- `src/commands/exploration.ts` → `catch (error: unknown)`
- `src/commands/execution.ts` → `catch (error: unknown)`, `.catch((err: unknown))`

**Pattern 5 — GrammY cast**
- `src/command-router.ts` → `(ctx.message as { message_thread_id?: number })?.message_thread_id`
- `src/bot-context.ts` → `type MsgWithThread = { message_thread_id?: number }`

**Autres fichiers corrigés**
- `src/patterns.ts` → interfaces `RetroActionRow`, `WorkflowLogRecord`
- `src/profile-evolution.ts` → interfaces `MsgRow`, `TaskRow`
- `src/orchestrator.ts` → `(st: { title: string; done?: boolean })`, `as AgentRole`, `Record<string, string>`
- `src/commands/memory-cmds.ts` → interface `MemoryRow`
- `src/alerts.ts` → lambdas typées, type predicate pour scores
- `src/agent-context.ts` → lambdas typées
- `src/memory.ts` → lambdas typées
- `src/pipeline-selection.ts` → `supabase?: SupabaseClient`
- `src/prd-workflow.ts` → `Record<string, AgentRole[]>`, `prd.metadata?.revision_count as number`
- `src/bmad-prompts.ts` → `agentId as AgentRole`
- `src/bmad-agents.ts` → `task as Task`, import `Task`
- `src/feedback-loop.ts` → row typé, `row.agent_id as AgentRole`
- `src/agent-events.ts` → `payload: Record<string, unknown>`, narrowing `duration_ms`
- `src/commands/zz-messages.ts` → `Promise<ThoughtClassification | null>`, `Promise<DocumentSearchResult[]>`
- `src/commands/quality.ts` → `t as { title?, status?, priority? }`, null guard sur `metrics`

### Interfaces ajoutées à workflow.ts (V5)

```typescript
export interface SprintMetrics {
  id: string; sprint_id: string; tasks_planned: number; tasks_completed: number;
  completion_rate: number; avg_delivery_hours: number | null; first_pass_rate: number | null;
  incidents_count: number; rework_count: number; retro_actions_proposed: number;
  retro_actions_accepted: number; sprint_started_at: string | null;
  sprint_ended_at: string | null; total_tokens: number; total_cost_usd: number;
  agent_executions: number; project_id: string | null; created_at: string;
}
export interface RetroRow { ... }
export interface WorkflowLogRow { ... }
```

### Fix de régressions découvertes

- **F-DA-11 (Adversarial)** : Seuil CI corrigé 600 → 3441
- **F-DA-12 (Adversarial)** : `BlackboardSections.verification` inclus dans la migration → `Record<string, unknown> | null`
- **`evaluateExplorationCompleteness`** : filtre `findingsWithSources` corrigé — sources must be non-empty array (`sources.length > 0`), ancienne logique bug (sources vides comptaient comme "avec sources")
- **`durcissement-incremental-des-standards.test.ts` V9** : assoupli pour accepter `"warn"` ou `"error"` (vague 1 → vague 2 migration)

---

## Phase 3 — Tester

### 7 fichiers de tests unitaires créés (V10-V16)

| Fichier | Module | Tests |
|---------|--------|-------|
| `tests/unit/deliberation.test.ts` | `deliberation.ts` | `shouldDeliberate()`, `getDeliberationReviewer()` — 12 tests |
| `tests/unit/document-sharding.test.ts` | `document-sharding.ts` | `splitIntoSections()`, cache management — 8 tests |
| `tests/unit/heartbeat-prompt.test.ts` | `heartbeat-prompt.ts` | `buildHeartbeatPrompt()`, `createDefaultState()`, constants — 12 tests |
| `tests/unit/llm-ops.test.ts` | `llm-ops.ts` | `getCircuitBreakerStatus()`, `LLMOPS_CHECK_INTERVAL_MS`, `buildSpanId()`, `sha256()` — 13 tests |
| `tests/unit/relay.test.ts` | `relay.ts` | smoke test exports, no bot start — 3 tests |
| `tests/unit/topic-config.test.ts` | `topic-config.ts` | `TOPIC_CONFIGS`, `getTopicConfig()` (retourne `undefined` pour unknown) — 9 tests |
| `tests/unit/transcribe.test.ts` | `transcribe.ts` | guard VOICE_PROVIDER, signature — 4 tests |

---

## Résultats de validation

### V1 — Aucun `any` restant dans `src/`
```
bunx biome check --diagnostic-level=error src/
→ Checked 77 files. No fixes applied. (0 noExplicitAny errors)
```

### V2 — TypeScript strict
```
bunx tsc --noEmit
→ 0 erreurs
```

### V3 — biome.json `noExplicitAny: "error"`
```json
"suspicious": { "noExplicitAny": "error" }
```

### V4 — CI threshold 3441
```yaml
if [ "$PASS_COUNT" -lt 3441 ]
```

### V5 — Interface SprintMetrics complète
Toutes les colonnes SQL incluses : `retro_actions_proposed`, `retro_actions_accepted`, `project_id`, `created_at`

### V6 — formatMetrics(metrics: SprintMetrics) callable
✓ Test runnable dans `durcissement-standards-vague-2.test.ts`

### V7 — BlackboardSections.spec = Record<string, unknown> | null
✓ Validé par `bunx tsc --noEmit` (0 erreurs)

### V8 — biome.json has noExplicitAny
✓ Configuré à `"error"`

### V9 — ci.yml threshold 3441
✓ `.github/workflows/ci.yml` contient `3441`

### V10-V16 — 7 fichiers tests unitaires
✓ Tous créés dans `tests/unit/`

### V15 — getTopicConfig returns undefined (not null)
```typescript
export function getTopicConfig(topicName: string | undefined): TopicConfig | undefined {
  if (!topicName) return undefined;
```
✓ `tests/unit/topic-config.test.ts` vérifie `toBeUndefined()`

### V17 — BlackboardSections.verification = Record<string, unknown> | null
✓ Inclus dans la migration (F-DA-12)

### V18 — pipeline-selection.ts uses SupabaseClient
✓ `supabase?: SupabaseClient` (3 occurrences)

### V19 — 0 régression
```
3516 pass, 15 skip, 0 fail
```
(Au-dessus du seuil 3441)

### V20 — getAllSprintMetrics retourne SprintMetrics[]
✓ Test runnable dans `durcissement-standards-vague-2.test.ts`

---

## Récapitulatif chiffres

| Métrique | Avant | Après |
|----------|-------|-------|
| Occurrences `any` dans `src/` | 155+ | 0 |
| Fichiers src/ modifiés | 0 | 31 |
| Fichiers tests créés | 0 | 7 |
| Tests passing | 3441 | 3516 |
| Tests failing | 0 | 0 |
| biome noExplicitAny | warn | error |
| CI threshold | 600 | 3441 |
| TSC erreurs | 0 | 0 |

---

## Hors scope identifié

Aucun besoin hors scope détecté. Tous les changements sont dans les fichiers listés en Section 5 de la spec ou dans des fichiers de tests.

**Note** : La correction du bug `findingsWithSources` (sources vides comptaient comme "avec sources") est un bugfix de régression dans `src/gate-evaluator.ts`, qui était dans scope (Section 5 inclut ce fichier). Cette correction était nécessaire pour que le test existant `gate-evaluator.test.ts` passe.
