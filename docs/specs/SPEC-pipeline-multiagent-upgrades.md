# Spec : Pipeline Multi-Agent Upgrades (5 ameliorations P1-P5)

> Genere le 2026-03-20. Source : docs/explorations/EXPLORE-analyse-dev-pipeline-multiagent.md, codebase exploration (orchestrator.ts, agent-context.ts, pipeline-selection.ts, llm-router.ts, agent-events.ts, cost-tracking.ts, pipeline-state.ts, agent.ts, blackboard.ts, semaphore.ts).

## 1. Objectif

Implementer les 5 ameliorations recommandees par l'exploration multi-agent (P1 a P5) dans les modules runtime du bot (`src/`) pour : reduire la latence du pipeline (-30-40% via parallelisme intra-phase), ameliorer la qualite contextuelle des agents mid-pipeline (context refresh), faciliter le debug post-echec (DLQ cognitive), optimiser les couts token (-20-30% via seuil adaptatif LIGHT/DEFAULT), et permettre le tracing complet cross-agent (correlation_id). Le perimetre est strictement limite aux fichiers TypeScript `src/` et aux tests associes -- les skills `.claude/skills/` et agents `.claude/agents/` sont hors scope.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Dans `orchestrate()`, quand `overlap: true`, les 2 derniers agents du pipeline s'executent en parallele au lieu de sequentiellement | Exploration P1, input utilisateur | Pour DEFAULT (5 agents), qa demarre en meme temps que dev ; pour LIGHT, qa et dev sont lances en parallele |
| R1b | En mode overlap, `Promise.allSettled()` est utilise (pas `Promise.all()`). Si un agent echoue et `stopOnFailure: true`, le pipeline est marque en echec mais les deux resultats sont conserves. Les verifications post-agent (blackboard, clarifications, gate evaluations) ne sont executees que pour les agents reussis | Adversarial F-EC-1 | Dev echoue, qa reussit : pipeline echoue, resultat qa conserve pour audit |
| R1c | Le mode overlap est incompatible avec `useBlackboard: true`. Si les deux options sont actives, overlap est ignore (fallback sequentiel) avec un `console.warn` | Adversarial F-EC-2 | Pipeline gated SDD avec blackboard : pas de parallelisme pour eviter les conditions de course |
| R1d | En mode overlap, l'agent QA recoit un snapshot fige des previousMessages (sans le resultat dev). QA produit donc une review basee sur la spec (analyst/pm/architect), pas sur l'output dev. C'est un compromis accepte pour le gain de latence | Adversarial F-DA-2 | QA en overlap fait une review de conformite spec, pas de review de code |
| R2 | Le parallelisme est limite par le Semaphore existant (max 3 concurrents) | Contrainte technique (semaphore.ts) | Si 3 agents tournent deja, le 4e attend |
| R3 | L'option `overlap` est un booleen optionnel dans `OrchestrateOptions`, defaut `false` | Decision technique | Backward compatible : sans l'option, comportement sequentiel inchange |
| R4 | Quand `refreshContext: true` dans OrchestrateOptions, le contexte agent est reconstruit via `buildAgentContext()` complet entre chaque agent (sauf le premier). Pas de separation stable/volatile : reutiliser la fonction existante (pattern identique a orchestrator.ts:874-881 pour l'agent explorer) | Exploration P2 + Adversarial F-SS-2 | Sprint progress passe de 40% a 60% en cours de pipeline |
| R5 | Le refresh complet coute ~8 requetes paralleles par phase (identique au build initial). C'est acceptable car le pipeline dure 2-5 minutes et le cout marginal est negligeable face a la simplicite | Exploration P2 + Adversarial F-SS-2 | Pas de nouvelle abstraction stable/volatile |
| R6 | Si `refreshContext: true` et supabase est null ou si `buildAgentContext()` retourne "", le cache existant est conserve (pas d'ecrasement) | Adversarial F-EC-3 | Supabase indisponible mid-pipeline : contexte initial preserve |
| R7 | Quand un agent echoue apres tous ses retries, le contexte complet est capture dans `agent_events` avec `event_type='failure_captured'` | Exploration P3 | Le payload JSONB contient `prompt_hash`, `partial_output` (tronque a 2000 chars), `error`, `tokens_input`, `tokens_output`, `duration_ms` |
| R8 | La capture DLQ est fire-and-forget : elle ne bloque jamais le pipeline et ne propage pas les erreurs | Exploration P3 | Si l'insert echoue, fallback in-memory + log console |
| R9 | Le seuil difficulty pour DEFAULT passe de 0.6 a 0.7 dans `scoreToPipeline()` | Exploration P4 | Un score de 0.65 retourne LIGHT au lieu de DEFAULT |
| R10 | `selectAdaptivePipeline()` force DEFAULT quand `affectedModules.length > 5` meme si difficulty < 0.7. L'override s'applique APRES le switch sur `difficulty.pipeline` : le pipeline intermediaire (LIGHT/SOLO) est d'abord calcule, puis remonte en DEFAULT si le critere est rempli | Exploration P4 + Adversarial F-DA-1 | Feature impactant 6 modules avec difficulty 0.5 : switch retourne LIGHT, override remonte en DEFAULT |
| R11 | `selectAdaptivePipeline()` force DEFAULT quand des mots-cles "breaking changes" sont detectes dans le titre/description. L'override s'applique APRES le switch sur `difficulty.pipeline` (meme logique que R10) | Exploration P4 + Adversarial F-DA-1 | Tache "breaking change API v2 migration" avec difficulty 0.5 : switch retourne LIGHT, override remonte en DEFAULT |
| R12 | Le `pipelineSessionId` existant est propage comme `correlation_id` dans le champ `metadata.pipeline_session_id` de chaque appel `logCost()` dans l'orchestrateur | Exploration P5 | `logCost(supabase, { ..., metadata: { pipeline_session_id: "pr-abc-123" } })` |
| R13 | `getTracingTimeline()` est un export alias de `getAgentEvents()` dans `agent-events.ts`. Pas de nouvelle implementation : `getAgentEvents(supabase, sessionId)` fait deja le merge DB + in-memory et le tri par `created_at` | Exploration P5 + Adversarial F-SS-1 | `export const getTracingTimeline = getAgentEvents` |
| R14 | Le `session_id` des `agent_events` est deja le pipeline session ID (verifie dans orchestrator.ts:694-698) : aucun changement structurel necessaire pour la correlation agent_events | Exploration P5, verification codebase | Le champ existe deja et est correctement utilise |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| Task (Supabase) | Table `tasks` | `supabase.from("tasks")` | id, title, description, priority, sprint, project_id, subtasks |
| Pipeline run | Table `pipeline_runs` | `supabase.from("pipeline_runs")` | session_id, task_id, pipeline_type, pipeline_agents, current_step, status |
| Agent events | Table `agent_events` | `supabase.from("agent_events")` | session_id, agent_role, event_type, payload, created_at |
| Cost tracking | Table `cost_tracking` | `supabase.from("cost_tracking")` | task_id, sprint_id, agent_role, metadata (JSONB) |
| Memory context | RPC `get_facts`, `get_active_goals` | Via `buildMemoryChains()` | Sections volatiles |
| Sprint context | RPC `get_sprint_summary` | Via `fetchSprintContext()` | Sections volatiles |
| Difficulty score | Fonction `computeDifficultyScore()` | Via `llm-router.ts` | score, components, affectedModules |
| Code graph | Fonction `getGraph()` | Via `code-graph.ts` | Module count, dependency depth |

## 4. Donnees de sortie

### P1 : Parallelisme intra-phase (overlap)

- Nouvelle option `overlap?: boolean` dans `OrchestrateOptions` (orchestrator.ts)
- Quand active, les 2 derniers agents du pipeline sont executes via `Promise.allSettled()` au lieu de sequentiellement
- L'agent N-1 et l'agent N (typiquement dev+qa) demarrent en parallele
- Les `previousMessages` passes aux 2 agents paralleles sont identiques (snapshot au moment du fork). QA fait une review spec-only sans voir le resultat dev
- Si `useBlackboard: true`, overlap est ignore avec un `console.warn` (fallback sequentiel)
- En cas d'echec d'un agent et `stopOnFailure: true`, le pipeline echoue mais les deux resultats sont conserves. Les verifications post-agent ne s'executent que pour les agents reussis
- Le resultat combine les 2 steps dans l'ordre du pipeline

### P2 : Context refresh mid-pipeline

- Nouvelle option `refreshContext?: boolean` dans `OrchestrateOptions`
- Dans la boucle `orchestrate()`, si `refreshContext: true`, le `agentContextCache` est reconstruit via `buildAgentContext()` complet avant chaque agent (sauf le premier). Pas de nouvelle fonction : reutilise le pattern existant (orchestrator.ts:874-881 pour explorer)
- Si `buildAgentContext()` retourne "" (supabase null ou erreur), le cache existant est conserve (garde preventive, pas d'ecrasement)
- Pas de nouvelle fonction dans `agent-context.ts` : P2 se limite a un appel conditionnel dans la boucle orchestrate()

### P3 : Agent DLQ (Dead Letter Queue cognitive)

- Nouveau event_type `'failure_captured'` dans l'union `AgentEventType` (agent-events.ts)
- Nouvelle fonction `captureAgentFailure(supabase, sessionId, role, failureContext): Promise<void>` dans `agent-events.ts`
  - `failureContext` contient : `promptSnippet` (premiers 500 chars du prompt — pas de hash SHA-256, le session_id+role identifient deja l'echec), `partialOutput` (premiers 2000 chars), `error`, `tokensInput`, `tokensOutput`, `durationMs`
  - Fire-and-forget : try/catch avec fallback in-memory, jamais bloquant
- Appel dans `orchestrate()` apres epuisement des retries (entre le dernier retry echoue et le `push(result)`)

### P4 : Seuil adaptatif LIGHT vs DEFAULT

- `scoreToPipeline()` dans `llm-router.ts` : seuil `<= 0.6` -> `<= 0.7` pour LIGHT
- `selectAdaptivePipeline()` dans `pipeline-selection.ts` : ajout de 2 criteres de forçage DEFAULT :
  - `affectedModules.length > 5` (via `computeDifficultyScore`)
  - Presence de mots-cles breaking changes dans le texte de la tache
- Nouveaux mots-cles breaking changes : `["breaking", "migration schema", "deprecate", "api v2", "schema change", "backward incompatible", "supprime", "retire"]`

### P5 : Observabilite cross-agent (correlation_id)

- Propagation du `pipelineSessionId` dans chaque appel `logCost()` dans `orchestrator.ts` via `metadata: { pipeline_session_id: pipelineSessionId }`
- `getTracingTimeline` est un export alias de `getAgentEvents` dans `agent-events.ts` : `export const getTracingTimeline = getAgentEvents`. Pas de nouvelle implementation

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/orchestrator.ts` | modifier | P1: parallelisme overlap des 2 derniers agents. P2: appel refreshVolatileContext entre chaque agent. P3: appel captureAgentFailure apres epuisement retries. P5: propagation pipelineSessionId dans logCost metadata |
| `src/agent-context.ts` | aucune modification | P2 simplifie : reutilise `buildAgentContext()` existant directement dans orchestrator.ts |
| `src/agent-events.ts` | modifier | P3: nouveau type failure_captured, nouvelle fonction captureAgentFailure(). P5: export alias getTracingTimeline = getAgentEvents |
| `src/llm-router.ts` | modifier | P4: seuil scoreToPipeline() passe de 0.6 a 0.7 |
| `src/pipeline-selection.ts` | modifier | P4: criteres forçage DEFAULT (impact > 5 fichiers, breaking changes) dans selectAdaptivePipeline() |
| `src/cost-tracking.ts` | aucune modification structurelle | P5: le champ metadata JSONB accepte deja des champs libres -- seul le commentaire pourrait etre enrichi |
| `tests/unit/llm-router.test.ts` | modifier | P4: mettre a jour les tests scoreToPipeline pour le nouveau seuil 0.7 |
| `tests/unit/adaptive-pipeline.test.ts` | modifier | P4: mettre a jour les tests scoreToPipeline pour le nouveau seuil 0.7 |
| `tests/unit/pipeline-selection.test.ts` | modifier | P4: ajouter tests pour criteres impact > 5 et breaking changes |
| `tests/unit/agent-events.test.ts` | modifier | P3: tests captureAgentFailure(). P5: tests getTracingTimeline() |
| `tests/unit/agent-context.test.ts` | aucune modification | P2 simplifie : pas de nouvelle fonction a tester dans agent-context |

## 6. Patterns existants

### Pattern 1 : Emission d'events fire-and-forget (agent-events.ts:52-86)

La fonction `emitAgentEvent()` est fire-and-forget avec fallback in-memory. La DLQ (`captureAgentFailure()`) reutilisera ce meme pattern : insert Supabase, fallback in-memory, jamais bloquant.

```typescript
// src/agent-events.ts:52-86
export async function emitAgentEvent(
  supabase: SupabaseClient | null,
  sessionId: string,
  role: string,
  eventType: AgentEventType,
  payload: Record<string, any> = {}
): Promise<void> {
  // ... fire-and-forget with in-memory fallback
}
```

### Pattern 2 : Cache de contexte par role (orchestrator.ts:544-559)

Le pipeline construit deja un cache `agentContextCache` par role au debut de l'orchestration via `buildAgentContext()`. Le refresh mid-pipeline reutilisera ce meme cache en ne re-appelant que les fetchers volatiles.

```typescript
// src/orchestrator.ts:544-559
const agentContextCache = new Map<string, string>();
if (supabase) {
  const ctxResults = await Promise.all(
    pipeline.map(async (role) => {
      const ctx = await buildAgentContext(supabase, { role, ... });
      return [role, ctx] as [string, string];
    })
  );
  for (const [role, ctx] of ctxResults) {
    if (ctx) agentContextCache.set(role, ctx);
  }
}
```

### Pattern 3 : Retry loop avec backoff (orchestrator.ts:700-731)

Le retry loop existant est le point d'insertion naturel pour la DLQ : apres epuisement des retries, capturer le contexte d'echec.

```typescript
// src/orchestrator.ts:700-731
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  result = await runAgentStep(...);
  if (result.success) break;
  if (attempt < maxRetries) {
    retryCount = attempt + 1;
    const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
    // ...
  }
}
```

### Pattern 4 : Difficulty scoring avec seuils (llm-router.ts:365-371)

La fonction `scoreToPipeline()` utilise des seuils numeriques simples. Le changement de seuil est une modification d'une seule ligne.

```typescript
// src/llm-router.ts:365-371
export function scoreToPipeline(score: number): "SOLO" | "LIGHT" | "DEFAULT" {
  if (score < 0.3) return "SOLO";
  if (score <= 0.6) return "LIGHT";  // -> changera en 0.7
  return "DEFAULT";
}
```

### Pattern 5 : Propagation metadata dans logCost (orchestrator.ts:997-1011)

Le `logCost()` dans l'orchestrateur passe deja taskId, sprintId, agentRole, model dans le `CostEntry`. Le champ `metadata` (type `Record<string, unknown>`) existe deja dans `CostEntry` (cost-tracking.ts:36) et est insere tel quel dans le JSONB de Supabase. Ajouter `pipeline_session_id` dans le metadata suit exactement le meme pattern.

```typescript
// src/cost-tracking.ts:128-153
export async function logCost(supabase, entry: CostEntry): Promise<void> {
  // ...
  await supabase.from("cost_tracking").insert({
    // ...
    metadata: entry.metadata || {},
  });
}
```

### Pattern 6 : Pipeline session ID (orchestrator.ts:600-608)

Le `pipelineSessionId` (format `pr-{taskId}-{timestamp}`) est deja propage dans `emitAgentEvent()` comme `sessionId`, dans `savePipelineStep()`, et dans `updatePipelineStatus()`. L'etendre au `logCost()` via metadata est le dernier maillon manquant.

```typescript
// src/orchestrator.ts:600-608
pipelineSessionId = `pr-${task.id}-${Date.now()}`;
await createPipelineRun(supabase, task.id, pipelineSessionId, ...);
```

### Pattern 7 : selectAdaptivePipeline avec import dynamique (pipeline-selection.ts:123-150)

La fonction importe dynamiquement `computeDifficultyScore` et utilise le resultat pour choisir le pipeline. Les criteres additionnels (impact > 5, breaking changes) s'inserent naturellement apres le switch sur `difficulty.pipeline`.

```typescript
// src/pipeline-selection.ts:123-150
export async function selectAdaptivePipeline(task, explicitPipeline?, supabase?): Promise<AgentRole[]> {
  if (explicitPipeline) return explicitPipeline;
  // keyword rules ...
  const { computeDifficultyScore } = await import("./llm-router.ts");
  const difficulty = await computeDifficultyScore(task, supabase);
  switch (difficulty.pipeline) {
    // ...
  }
}
```

## 7. Contraintes

- **Backward compatibility** : toutes les modifications sont opt-in via des parametres optionnels. Les fonctions existantes gardent leur signature ; les nouveaux parametres ont des valeurs par defaut qui preservent le comportement actuel
- **Pas de migration SQL** : les tables `agent_events`, `cost_tracking`, `pipeline_runs` existent deja avec les colonnes necessaires. Le nouveau type d'event `failure_captured` est un string dans un champ TEXT sans CHECK constraint. Le `pipeline_session_id` est stocke dans le JSONB `metadata` existant
- **Performance** : le refresh mid-pipeline (P2) ajoute au maximum 2 appels asynchrones paralleles par phase (sprint + memoire). L'overlap P1 n'ajoute aucun appel supplementaire, il reordonne juste l'execution
- **Tests existants** : les 2690 tests doivent continuer a passer. Les tests `llm-router.test.ts` et `adaptive-pipeline.test.ts` devront etre mis a jour pour le nouveau seuil 0.7 (les assertions sur les valeurs 0.6 < x <= 0.7 changent de resultat attendu)
- **Semaphore** : le parallelisme P1 utilise `Promise.all()` sur 2 agents, donc occupe 2 slots du semaphore (max 3). Pas de risque de deadlock car le reste du pipeline est sequentiel
- **Pas de nouveau service** : aucun nouveau process PM2 ni edge function. Toutes les modifications sont dans les modules TypeScript existants
- **Scope strict `src/`** : les skills `.claude/skills/` et agents `.claude/agents/` sont hors scope. Le parallelisme P1 s'implemente dans `orchestrator.ts`, pas dans les skills

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `scoreToPipeline(0.65)` retourne `"LIGHT"` au lieu de `"DEFAULT"` | Test unitaire : appeler `scoreToPipeline(0.65)` et verifier le retour | unit |
| V2 | `scoreToPipeline(0.71)` retourne `"DEFAULT"` | Test unitaire : appeler `scoreToPipeline(0.71)` et verifier le retour | unit |
| V3 | `scoreToPipeline(0.3)` retourne `"LIGHT"` (frontiere SOLO/LIGHT inchangee) | Test unitaire : verifier que le seuil 0.3 reste la frontiere | unit |
| V4 | `scoreToPipeline(0.7)` retourne `"LIGHT"` (frontiere inclusive) | Test unitaire : verifier que 0.7 est la borne haute de LIGHT | unit |
| V5 | `selectAdaptivePipeline()` retourne DEFAULT pour une tache avec > 5 modules impactes et difficulty < 0.7 | Test unitaire avec mock `computeDifficultyScore` retournant score=0.5 et affectedModules de longueur 6 | unit |
| V6 | `selectAdaptivePipeline()` retourne DEFAULT pour une tache contenant des mots-cles breaking changes et difficulty < 0.7 | Test unitaire avec tache "breaking change API v2 migration" et difficulty=0.5 | unit |
| V7 | `selectAdaptivePipeline()` retourne LIGHT pour une tache avec 3 modules impactes et difficulty=0.5 (cas normal) | Test unitaire : confirmer que le comportement LIGHT est preserve pour les cas standards | unit |
| V8 | Le type `AgentEventType` inclut `"failure_captured"` | Verification de type : compiler un fichier qui utilise le type `"failure_captured"` | unit |
| V9 | `captureAgentFailure()` insere un event avec type `failure_captured` et payload contenant `prompt_snippet`, `partial_output`, `error`, `tokens_input`, `tokens_output`, `duration_ms` | Test unitaire avec mock Supabase : verifier l'insert et les champs du payload | unit |
| V10 | `captureAgentFailure()` ne bloque jamais : si l'insert Supabase throw, la fonction ne propage pas l'erreur | Test unitaire : mocker un insert qui throw, verifier que la fonction resout sans erreur | unit |
| V11 | `captureAgentFailure()` tombe en fallback in-memory quand supabase est null | Test unitaire : appeler avec supabase=null, verifier que l'event est dans le store in-memory via `getInMemoryEventsForSession()` | unit |
| V12 | Dans `orchestrate()` avec `refreshContext: true`, `buildAgentContext()` est re-appele avant chaque agent (sauf le 1er) pour mettre a jour le cache | Test integration : mocker orchestrate avec 3 agents, verifier que `buildAgentContext` est appele 2 fois de plus que sans refreshContext | integration |
| V13 | Si `buildAgentContext()` retourne "" lors du refresh (supabase null), le cache existant est conserve (pas d'ecrasement) | Test unitaire : simuler buildAgentContext retournant "", verifier que le cache precedent est preserve | unit |
| V14 | Dans `orchestrate()` sans `refreshContext` (defaut), le contexte n'est jamais reconstruit mid-pipeline | Test integration : mocker orchestrate, verifier que buildAgentContext n'est appele qu'une fois par role | integration |
| V17 | `logCost()` dans `orchestrate()` inclut `pipeline_session_id` dans le metadata | Test unitaire : mocker le supabase insert dans logCost, verifier que metadata contient le champ | unit |
| V18 | `getTracingTimeline` est un alias exportable de `getAgentEvents` | Test unitaire : verifier que `getTracingTimeline === getAgentEvents` | unit |
| V20 | Apres epuisement des retries dans `orchestrate()`, `captureAgentFailure()` est appelee avec le bon sessionId, role, et contexte d'echec | Test integration : orchestrer avec maxRetries=1 et un agent qui echoue toujours, verifier l'appel DLQ | integration |
| V21 | Le `pipelineSessionId` est identique dans les `agent_events.session_id` et les `cost_tracking.metadata.pipeline_session_id` d'un meme pipeline run | Test integration : mocker un pipeline run de 2 agents, verifier la coherence du session_id dans les 2 tables | integration |
| V19 | Avec `overlap: true` et `useBlackboard: true`, overlap est ignore (fallback sequentiel) avec `console.warn` | Test unitaire : verifier que le pipeline est sequentiel quand les deux options sont actives | unit |
| V20 | Avec `overlap: true` et pipeline de 3+ agents, les 2 derniers agents s'executent en parallele via Promise.allSettled | Test integration : mocker orchestrate avec pipeline [analyst, dev, qa] et overlap=true, verifier que dev et qa sont lances en parallele | integration |
| V21 | Avec `overlap: true` et un agent qui echoue et stopOnFailure=true, le pipeline echoue mais les deux resultats sont conserves | Test integration : mocker un agent qui echoue en overlap, verifier que les resultats des deux agents sont dans les steps | integration |
| V22 | Avec `overlap: true` et pipeline de 2 agents, les 2 agents s'executent en parallele | Test integration : pipeline [dev, qa] avec overlap=true, verifier parallelisme | integration |
| V23 | Avec `overlap: true` et pipeline de 1 agent, pas de changement de comportement | Test unitaire : pipeline [dev] avec overlap=true, execution normale | unit |
| V24 | Avec `overlap: false` (defaut), le pipeline reste strictement sequentiel | Test integration : verifier que le comportement par defaut est inchange | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | L'exploration multi-agent a identifie 5 ecarts concrets par rapport a l'etat de l'art (latence, qualite contextuelle, debug, cout, monitoring), chacun avec impact mesurable |
| Perimetre | Couvert | Les 5 ameliorations sont scopees aux fichiers TypeScript `src/` existants. Pas de migration SQL, pas de nouveau service, pas de modification des skills/agents. 11 fichiers impactes (6 sources + 5 tests) |
| Validation | Couvert | 24 V-criteres couvrant les 5 ameliorations : 14 unit, 10 integration, 0 E2E, 0 manual. Tous les seuils et comportements sont testables automatiquement |
| Technique | Couvert | Les 7 patterns existants (fire-and-forget, cache role, retry loop, difficulty scoring, metadata JSONB, pipeline session ID, adaptive selection) sont identifies avec citations exactes du code source |
| UX | Non applicable | Pas d'interaction utilisateur directe : les 5 ameliorations sont internes au pipeline runtime. Les options `overlap` et `refreshContext` sont passees programmatiquement, pas par commande Telegram |
| Alternatives | Pertinent | L'exploration a explicitement ecarte les alternatives couteuses (A2A, negotiation multi-round, migration LangGraph, semantic caching, circuit breakers) au profit de modifications ciblees du code existant. Le choix du parallelisme "2 derniers agents" vs "parallelisme total" est motive par la simplicite et la limitation du semaphore |

**Zones d'ombre residuelles** :

1. **P1 -- Messages precedents en mode overlap** : les 2 agents paralleles reçoivent le meme snapshot de `previousMessages` (fige au moment du fork). L'agent qa ne voit donc pas le resultat de dev en mode overlap. C'est documente et accepte (R1d) : QA fait une review spec-only. Si ce compromis pose probleme a l'usage, un mode "waterfall overlap" pourra etre ajoute plus tard.

2. **P4 -- Definition des mots-cles "breaking changes"** : la liste initiale est conservative. Elle devra etre affinee apres observation de quelques pipelines reels. Faux positifs possibles avec "supprime" ou "retire" (peuvent designer des suppressions non-breaking).

3. **P4 -- Seuil de 5 modules** : arbitraire, a ajuster apres mesure reelle.

4. **P3 -- Snippet de prompt** : on stocke les 500 premiers caracteres du prompt (pas un hash). Pour replay complet, il faudra reconstruire le prompt depuis les inputs.
