# Spec : Refactorisation LLM-Ops Transversale

> Genere le 2026-03-21. Source : exploration EXPLORE-refactorisation-llm-ops-transversale.md, exploration EXPLORE-agent-specialise-llm-ops.md, codebase analysis (agent-events.ts, trust-scores.ts, cost-tracking.ts, gate-evaluator.ts, feedback-loop.ts, gate-persistence.ts, heartbeat.ts, heartbeat-prompt.ts, orchestrator.ts, bmad-prompts.ts, commands/help.ts, db/schema.sql, config/features.json).

## 1. Objectif

Creer un module transversal `src/llm-ops.ts` qui unifie les responsabilites LLM-Ops fragmentees sur 6 modules (prompt versioning, circuit-breaker, attribution couts par span, observabilite agregee, drift detection) et integrer un check periodique `runLlmOpsCheck()` dans le heartbeat existant, controle par feature flag. L'objectif est de passer d'une observabilite dispersee et manuelle a une couche coherente, queryable et proactive, sans breaking changes sur les API existantes.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Le module `llm-ops.ts` est une facade de lecture/ecriture au-dessus de `agent-events.ts`, `trust-scores.ts` et `cost-tracking.ts`. Il ne duplique aucune logique — il importe et orchestre. | Exploration S5 (Option D) | `getLlmOpsSnapshot()` appelle `getCachedTrustScores()`, `getAgentEvents()`, `formatRecentGateEvaluations()` en interne |
| R2 | `llm-ops.ts` n'importe PAS de valeurs depuis `gate-evaluator.ts` ni `orchestrator.ts` pour eviter les dependances circulaires. Pour le type `AgentRole`, utiliser `import type` depuis `orchestrator.ts` (Bun/TS resout les type-only imports sans cycle runtime). Ce sont ces modules qui importent des valeurs depuis `llm-ops.ts` (direction acyclique). | Exploration S3 point 1 + F-DA-1 | `orchestrator.ts` appelle `llmOps.logCostWithSpan()`, `gate-evaluator.ts` reste inchange |
| R3 | Le prompt versioning stocke un hash combine `template_hash + feedback_hash` par role agent dans la table `prompt_versions`. Un upsert sur `(agent_role, combined_hash)` evite les doublons. | Exploration S2, S6 schema | Role `dev`, template YAML modifie → nouvelle ligne dans `prompt_versions` avec hashes differents |
| R4 | Le span_id est synthetique : `${session_id}:${role}:${step_index}`, sans dependance a une lib OpenTelemetry externe. Le session_id existant (`pipelineSessionId` dans orchestrator.ts) sert de trace-id. | Exploration S3 point 5, S6 contrainte 1 | Session `pr-abc-1234`, step dev index 3 → span_id `pr-abc-1234:dev:3` |
| R5 | Le circuit-breaker est non-bloquant : `getCircuitBreakerStatus()` retourne un statut et une recommandation, mais la decision de downgrade reste au code appelant (orchestrator). Pas de fonction `shouldDowngradePipeline` dans `llm-ops.ts` — la logique de mapping pipeline→downgrade appartient a l'orchestrateur via `pipeline-selection.ts`. | Exploration S6 contrainte 4 + F-SS-1 | `{ open: true, reason: "trust_score < 30", suggestedDowngrade: "QUICK" }` → orchestrator decide |
| R6 | Les seuils circuit-breaker : `trust_score < 30` pour un role OU `consecutiveFailures >= 3` → statut ouvert. | Exploration S5 question resolue (b) | Role `architect` avec score 25 → circuit-breaker open, suggestion downgrade |
| R7 | `runLlmOpsCheck()` est une tache periodique du heartbeat, gated sur le feature flag `llmops_monitoring` et un intervalle de 30 minutes (`lastLlmOpsCheckAt`). | Exploration S5 verdict, S4 Option D | Heartbeat pulse → verifie `llmops_monitoring` flag + intervalle 30min → appelle `runLlmOpsCheck()` |
| R8 | `logCost()` existant reste inchange (backward compat). Une nouvelle fonction `logCostWithSpan()` ajoute `span_id` et `session_id` en passant par le meme `logCost()` enrichi de champs optionnels. | Exploration S6 contrainte 2 | Code existant appelle toujours `logCost(supabase, entry)` sans modification |
| R9 | `getLlmOpsSnapshot()` est une agregation temps-reel (query Supabase directe), pas un cache periodique. La latence est acceptable pour `/monitor` (utilisation rare, < 1/h). Le `costSummary` est filtre sur les 7 derniers jours pour eviter les queries lentes sur une table volumineuse. | Exploration S6 question 1 + F-DA-4 | `/monitor` → `getLlmOpsSnapshot()` → 2-3 queries paralleles Supabase → resultat formate |
| R10 | `runLlmOpsCheck()` peut creer des notifications via le mecanisme existant (`writeMcpPending` ou `enqueue`) mais ne cree PAS de taches automatiquement. Il notifie seulement les anomalies LLM-Ops detectees. | Exploration S6 question 3, principe de prudence | Trust score d'un role chute sous 30 → notification Telegram, pas de tache auto-generee |
| R11 | Le `recordPromptVersion()` est appele depuis l'orchestrateur (`orchestrator.ts`) au moment de l'execution d'un step agent, la ou le `SupabaseClient` est disponible. Il n'est PAS appele depuis `buildAgentSystemPromptPart()` qui est une fonction pure sans acces Supabase. Le template hash est calcule depuis le cache YAML, le feedback hash depuis les feedback rules actives pour le role. | F-EC-1 + F-SS-2 corrige | Step orchestrator pour role `dev` → hash YAML + hash feedback rules → `recordPromptVersion(supabase, ...)` |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `trust_scores` table | DB Supabase | `getCachedTrustScores()` (in-memory cache) | `agent_role`, `score`, `consecutive_failures`, `consecutive_passes` |
| `agent_events` table | DB Supabase | `getAgentEvents(supabase, sessionId)` | `session_id`, `agent_role`, `event_type`, `payload`, `created_at` |
| `cost_tracking` table | DB Supabase | query directe | `task_id`, `sprint_id`, `agent_role`, `tokens_input`, `tokens_output`, `cost_usd`, `duration_ms`, `span_id` (nouveau), `session_id` (nouveau) |
| `gate_evaluations` table | DB Supabase | `formatRecentGateEvaluations()` | `agent_role`, `gate_name`, `score`, `passed`, `auto_approved`, `created_at` |
| `feedback_rules` table | DB Supabase | `getFeedbackRules()` (in-memory cache) | `agent_id`, `pattern`, `instruction`, `active` |
| `pipeline_runs` table | DB Supabase | query directe | `session_id`, `status`, `created_at` |
| YAML templates | Fichiers locaux | `readFileSync` dans `bmad-prompts.ts` | Contenu fichier → SHA256 hash |
| `config/features.json` | Fichier local | `isFeatureEnabled("llmops_monitoring")` | Flag boolean |
| `HeartbeatState` | Fichier JSON local | `loadState()` | `lastLlmOpsCheckAt` (nouveau champ) |

## 4. Donnees de sortie

### 4.1 Table `prompt_versions` (nouvelle)

```
id             UUID         PK auto
created_at     TIMESTAMPTZ  DEFAULT NOW()
agent_role     TEXT         NOT NULL
template_hash  TEXT         NOT NULL   -- SHA256 du contenu YAML
feedback_hash  TEXT         NOT NULL   -- SHA256 des feedback_rules actives pour ce role
combined_hash  TEXT         NOT NULL   -- "${template_hash}:${feedback_hash}" (separateur ':' pour eviter les collisions)
UNIQUE (agent_role, combined_hash)
```

Regles de remplissage : un upsert sur `(agent_role, combined_hash)` a chaque appel de `recordPromptVersion()` (R3). Si le combined_hash existe deja, aucune ecriture (idempotent).

### 4.2 Colonnes ajoutees a `cost_tracking`

```
span_id      TEXT  -- optionnel, format "${session_id}:${role}:${step}" (R4)
session_id   TEXT  -- optionnel, pipeline session id (R4)
INDEX idx_cost_tracking_session ON cost_tracking(session_id)
```

### 4.3 Champ ajoute a `HeartbeatState`

```typescript
lastLlmOpsCheckAt: string | null;  // ISO timestamp, intervalle 30min
```

### 4.4 API publique de `src/llm-ops.ts`

```typescript
// Prompt versioning (R3, R11)
recordPromptVersion(supabase: SupabaseClient | null, role: AgentRole, templateHash: string, feedbackHash: string): Promise<void>
getActivePromptVersion(supabase: SupabaseClient | null, role: AgentRole): Promise<PromptVersion | null>

// Span attribution (R4, R8)
buildSpanId(sessionId: string, role: AgentRole, stepIndex: number): string
logCostWithSpan(supabase: SupabaseClient | null, entry: CostEntry, spanId: string, sessionId: string): Promise<void>

// Circuit-breaker (R5, R6)
getCircuitBreakerStatus(role: AgentRole): CircuitBreakerStatus

// Observabilite agregee (R1, R9)
getLlmOpsSnapshot(supabase: SupabaseClient): Promise<LlmOpsSnapshot>

// Check periodique heartbeat (R7, R10)
runLlmOpsCheck(supabase: SupabaseClient, notifyFn: (msg: string) => Promise<void>): Promise<LlmOpsCheckResult>
```

### 4.5 Types exportes

```typescript
interface PromptVersion {
  id: string;
  agentRole: string;
  templateHash: string;
  feedbackHash: string;
  combinedHash: string;
  createdAt: string;
}

interface CircuitBreakerStatus {
  open: boolean;
  reason: string;
  suggestedDowngrade: string | null;  // "QUICK", "SOLO", etc. ou null si pas de downgrade
}

interface LlmOpsSnapshot {
  trustScores: Record<string, { score: number; autonomyLevel: string; consecutiveFailures: number }>;
  recentGateEvaluations: string;  // texte formate
  circuitBreakers: Array<{ role: string; open: boolean; reason: string }>;
  promptVersions: Array<{ role: string; combinedHash: string; createdAt: string }>;
  costSummary: { totalSpans: number; totalCostUsd: number; topRoleByCost: string | null };
}

interface LlmOpsCheckResult {
  anomalies: string[];
  notificationsSent: number;
  circuitBreakersOpen: string[];
}
```

### 4.6 Feature flag

Ajout dans `config/features.json` : `"llmops_monitoring": false` (desactive par defaut au deploiement, activation manuelle apres validation).

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/llm-ops.ts` | Creer | Module transversal : facade unifiee pour les 5 responsabilites LLM-Ops (R1) |
| `db/migrations/llm-ops-schema.sql` | Creer | Migration Supabase : table `prompt_versions` + colonnes `span_id`/`session_id` sur `cost_tracking` (R3, R4) |
| `db/schema.sql` | Modifier | Ajouter la table `prompt_versions`, colonnes `span_id`/`session_id` sur `cost_tracking`, et index (schema autoritatif) |
| `src/heartbeat.ts` | Modifier | Ajouter appel a `runLlmOpsCheck()` dans la section periodic tasks, gate sur feature flag + intervalle 30min (R7) |
| `src/heartbeat-prompt.ts` | Modifier | Ajouter `lastLlmOpsCheckAt: string \| null` a `HeartbeatState` et `createDefaultState()` (R7) |
| `src/orchestrator.ts` | Modifier | Remplacer `logCost()` par `logCostWithSpan()` avec `buildSpanId()` aux 2 points de log (lignes ~1050 et ~1193) (R4, R8) |
| `src/bmad-prompts.ts` | Inchange | `buildAgentSystemPromptPart()` reste une fonction pure. `recordPromptVersion()` est appele depuis l'orchestrateur (R11 corrige) |
| `src/cost-tracking.ts` | Modifier | Ajouter champs optionnels `span_id` et `session_id` a `CostEntry`, les inclure dans `logCost()` insert (R8) |
| `src/commands/help.ts` | Modifier | Remplacer l'agregation manuelle dans `/monitor` par un appel a `getLlmOpsSnapshot()` (R1, R9) |
| `config/features.json` | Modifier | Ajouter `"llmops_monitoring": false` (R7) |
| `tests/unit/llm-ops.test.ts` | Creer | Tests unitaires pour les 6 fonctions publiques du module |
| `tests/unit/llm-ops-integration.test.ts` | Creer | Tests d'integration pour le flow heartbeat + Supabase mock |

## 6. Patterns existants

### 6.1 Pattern facade : aggregation de sources dans une seule reponse

Le pattern exact que `getLlmOpsSnapshot()` doit suivre existe deja dans `src/commands/help.ts` lignes 182-250. Le handler `/monitor` aggrege manuellement depuis 5 sources (formatTrustScores, formatRecentGateEvaluations, formatDoubleLoopRules, getAgentEvents, getAgentMessages) via `Promise.all`. Le module `llm-ops.ts` encapsule ce pattern dans une fonction reutilisable.

```typescript
// src/commands/help.ts lignes 193-197 — pattern a encapsuler
const [recentEvals, dlRules] = await Promise.all([
  formatRecentGateEvaluations(supabase),
  formatDoubleLoopRules(supabase),
]);
```

### 6.2 Pattern tache periodique dans le heartbeat

Le heartbeat (`src/heartbeat.ts` lignes 497-580) utilise un pattern coherent pour les taches periodiques :
1. Verifier l'intervalle via `state.lastXxxAt` et un seuil temporel
2. Log de demarrage
3. Executer la tache
4. Mettre a jour `state.lastXxxAt`
5. Wrapper try/catch pour ne jamais bloquer le pulse

```typescript
// src/heartbeat.ts lignes 498-521 — pattern exact a reproduire
try {
  const hourAgo = now - 60 * 60 * 1000;
  if (!state.lastAlertCheckAt || new Date(state.lastAlertCheckAt).getTime() < hourAgo) {
    console.log(`[${timestamp}] Running hourly alert checks...`);
    const alerts = await runAllChecks(supabase, sprint);
    // ... process results ...
    state.lastAlertCheckAt = timestamp;
  }
} catch (err) {
  console.error(`[${timestamp}] Alert check error:`, err);
}
```

### 6.3 Pattern circuit-breaker via trust scores

Le mecanisme de circuit-breaker existe partiellement dans `src/trust-scores.ts` :
- `getCachedTrustScore(role)` retourne le score actuel (lignes 53-55)
- `CONSECUTIVE_FAIL_THRESHOLD = 3` est deja defini (ligne 35)
- `getAutonomyLevel(role)` retourne un niveau basé sur les seuils (lignes 217-233)

Le circuit-breaker de `llm-ops.ts` etend ce pattern en ajoutant la decision de downgrade pipeline.

### 6.4 Pattern feature flag

`src/feature-flags.ts` expose `isFeatureEnabled(name)` avec hot-reload. Le heartbeat utilise deja ce pattern (ligne 360) : `if (!isFeatureEnabled("heartbeat")) return`.

### 6.5 Pattern fire-and-forget async

`agent-events.ts` utilise le pattern fire-and-forget (ligne 53-87) : ecriture Supabase en async sans bloquer le pipeline, avec fallback in-memory. `recordPromptVersion()` doit suivre le meme pattern : upsert fire-and-forget, log erreur, jamais bloquer le prompt builder.

### 6.6 Pattern SHA256 hash

Bun fournit `Bun.CryptoHasher` natif. Pattern recommande :

```typescript
import { CryptoHasher } from "bun";
function sha256(content: string): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}
```

## 7. Contraintes

- **Backward compatibility absolue** : `logCost()` doit continuer a fonctionner sans changement pour les 2 appelants existants dans `orchestrator.ts`. Les champs `span_id` et `session_id` sont optionnels dans `CostEntry` (R8).
- **Pas de dependance OpenTelemetry** : span_id est synthetique, pas de nouvelle lib npm (R4).
- **Pas de dependance circulaire runtime** : `llm-ops.ts` importe des valeurs depuis `trust-scores.ts`, `agent-events.ts`, `cost-tracking.ts`, `feedback-loop.ts`. Il utilise `import type { AgentRole }` depuis `orchestrator.ts` (type-only, pas de cycle runtime). Il n'importe PAS de valeurs depuis `orchestrator.ts`, `gate-evaluator.ts`, `bmad-prompts.ts` (R2). Ces derniers importent des valeurs depuis `llm-ops.ts`.
- **Feature flag obligatoire** : `llmops_monitoring` desactive par defaut. Le module est utilisable (`getLlmOpsSnapshot()`, `recordSpan()`, etc.) meme quand le flag est off — seul `runLlmOpsCheck()` dans le heartbeat est gate (R7).
- **Migration non-destructive** : `ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS` pour `span_id` et `session_id`. Pas de modification des colonnes existantes.
- **HeartbeatState compatible** : le champ `lastLlmOpsCheckAt` est ajoute avec valeur par defaut `null`. Le `loadState()` existant parse le JSON et ignore les champs inconnus, donc aucun risque de casser le heartbeat au deploiement.
- **Performance /monitor** : `getLlmOpsSnapshot()` execute max 4 queries Supabase en parallele. Latence cible < 2s. Ne jamais bloquer le handler Telegram.
- **Tests CI** : tous les tests existants (2690) doivent continuer a passer. Les nouveaux tests doivent etre executables sans connexion Supabase reelle (mock pattern existant).

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `buildSpanId("ses1", "dev", 3)` retourne `"ses1:dev:3"` | Test unitaire de la fonction pure | unit |
| V2 | `getCircuitBreakerStatus("dev")` retourne `{ open: true, ... }` quand trust score < 30 | Mock du cache trust-scores, assertion sur le resultat | unit |
| V3 | `getCircuitBreakerStatus("dev")` retourne `{ open: true, ... }` quand consecutiveFailures >= 3 | Mock du cache avec 3 echecs consecutifs | unit |
| V4 | `getCircuitBreakerStatus("dev")` retourne `{ open: false, ... }` quand score >= 30 et failures < 3 | Mock du cache avec score normal | unit |
| V5 | `getCircuitBreakerStatus()` retourne un `suggestedDowngrade: "QUICK"` exploitable par l'orchestrateur quand circuit-breaker open | Mock trust score bas, verification du champ suggestedDowngrade | unit |
| V6 | `recordPromptVersion()` effectue un upsert sur `prompt_versions` sans erreur | Mock Supabase upsert, verification appel avec bons parametres | unit |
| V7 | `recordPromptVersion()` est idempotent : deux appels avec le meme hash ne creent qu'une ligne | Mock Supabase upsert avec onConflict, verification single insert | unit |
| V8 | `logCostWithSpan()` appelle `logCost()` avec les champs `span_id` et `session_id` ajoutes a l'entry | Mock logCost, verification des champs dans l'objet passe | unit |
| V9 | `CostEntry` accepte les champs optionnels `span_id` et `session_id` sans casser la signature existante | Compilation TypeScript (tsc --noEmit) | unit |
| V10 | `getLlmOpsSnapshot()` retourne un objet LlmOpsSnapshot complet avec toutes les sections | Mock Supabase, verification de la structure de retour | integration |
| V11 | `runLlmOpsCheck()` detecte un circuit-breaker ouvert et appelle la fonction de notification | Mock trust scores + notifyFn, verification que notifyFn a ete appelee | unit |
| V12 | `runLlmOpsCheck()` ne fait rien quand tous les scores sont normaux | Mock trust scores normaux, verification que notifyFn n'est pas appelee | unit |
| V13 | Le heartbeat appelle `runLlmOpsCheck()` quand le feature flag est ON et l'intervalle de 30min est depasse | Mock feature flags + state + fonctions llm-ops | integration |
| V14 | Le heartbeat n'appelle PAS `runLlmOpsCheck()` quand le feature flag est OFF | Mock feature flags OFF, verification pas d'appel | integration |
| V15 | Le heartbeat n'appelle PAS `runLlmOpsCheck()` si l'intervalle de 30min n'est pas depasse | Mock state avec lastLlmOpsCheckAt recent | integration |
| V16 | L'orchestrateur appelle `recordPromptVersion()` avec le hash du template YAML et le hash des feedback rules au moment d'executer un step agent | Mock recordPromptVersion dans le flow orchestrateur, verification des arguments | integration |
| V17 | L'orchestrator appelle `logCostWithSpan()` avec le bon span_id synthetique au lieu de `logCost()` | Verification du code (recherche d'appels) + test d'integration mock | integration |
| V18 | La migration SQL ajoute la table `prompt_versions` et les colonnes sans erreur sur schema existant | Execution de la migration sur une base de test | integration |
| V19 | `/monitor` utilise `getLlmOpsSnapshot()` et affiche les sections trust, circuit-breaker, prompt versions | Verification du code dans help.ts | integration |
| V20 | Les 2690 tests existants passent apres les modifications | `bun test` complet en CI | integration |
| V21 | `tsc --noEmit` ne produit aucune erreur apres les modifications | Compilation TypeScript en CI | unit |
| V22 | `HeartbeatState` avec le nouveau champ `lastLlmOpsCheckAt` est compatible avec l'ancien format JSON (champ absent = null) | Test unitaire : parse ancien JSON → champ null | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | L'exploration initiale (EXPLORE-agent-specialise-llm-ops) et l'exploration technique (EXPLORE-refactorisation-llm-ops-transversale) documentent exhaustivement la fragmentation des 6 modules LLM-Ops et ses consequences (degradation silencieuse, couts non attribues, prompts qui derivent sans detection). |
| Perimetre | Couvert | Scope IN : module facade `llm-ops.ts`, migration schema, integration heartbeat/orchestrator/bmad-prompts/help.ts. Scope OUT : dashboard visualisation, lib OpenTelemetry, daemon PM2 separe, modification de gate-evaluator.ts ou des flux de trust-scores. |
| Validation | Couvert | 22 V-criteres couvrent les 6 fonctions publiques, l'integration heartbeat, l'integration orchestrator, la migration SQL, et la non-regression CI. |
| Technique | Couvert | L'archeologie codebase detaillee (section 3 de l'exploration) identifie les 12 fichiers impactes, les points de friction (dependances circulaires, backward compat logCost, schema cost_tracking sans session_id), et les patterns reutilisables. |
| UX | Non applicable | Module d'infrastructure interne sans interaction utilisateur directe. Le seul output visible est la section `/monitor` enrichie, qui suit le format texte existant. |
| Alternatives | Pertinent | 4 alternatives evaluees dans l'exploration (S4) : A (status quo), B (module seul), C (module + daemon separe), D (module + heartbeat). Option D retenue avec justification : elimination de la duplication setup, feature flag pour activation progressive, complexite M vs L pour l'option C. |

**Zones d'ombre residuelles :**

1. **Seuils circuit-breaker a affiner** : les seuils `trust_score < 30` et `consecutiveFailures >= 3` sont issus de l'exploration et coherents avec les constantes existantes (`CONSECUTIVE_FAIL_THRESHOLD = 3` dans trust-scores.ts). Ils pourront etre ajustes apres observation des donnees reelles en production.

2. **Frequence optimale du check heartbeat** : 30 minutes est une estimation raisonnable (les trust scores changent peu entre les pipeline runs). Si le heartbeat s'avere trop frequent ou pas assez, l'intervalle est configurable sans modification de code (constante dans llm-ops.ts).

3. **Volume table `prompt_versions`** : avec 8 roles agents et des changements de template/feedback rares, la table restera petite (< 100 lignes). Pas de strategie de purge necessaire a court terme. A revisiter si les roles se multiplient.

4. **Granularite span pour les sous-appels internes** : cette spec couvre les spans au niveau agent-step dans le pipeline (un span par agent dans l'orchestration). Les sous-appels internes d'un agent (ex: gate evaluator appelant Claude pour scorer) ne sont PAS traces comme spans separes dans cette V1. Extension possible en V2 si besoin de granularite plus fine.
