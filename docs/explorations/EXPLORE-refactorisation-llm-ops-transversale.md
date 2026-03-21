---
phase: 0-explore
generated_at: "2026-03-21T16:00:00+01:00"
subject: "Refactorisation LLM-Ops transversale : module src/llm-ops.ts + daemon claude-llmops"
verdict: GO
next_step: "dev-spec"
---

# Refactorisation LLM-Ops Transversale

## Section 1 — Problème

### Origine

L'exploration précédente (`EXPLORE-agent-specialise-llm-ops.md`) a conclu avec un verdict PIVOT : l'idée d'un agent LLM-Ops dans le pipeline BMad est architecturalement incorrecte. Le cadrage validé est un **module transversal `src/llm-ops.ts` + un daemon PM2 `claude-llmops`**, analogue au pattern `heartbeat.ts` existant.

Les composants LLM-Ops sont aujourd'hui fragmentés sur 6 modules distincts :
- `agent-events.ts` — event sourcing (13 types), non exploité pour observabilité
- `trust-scores.ts` — scores de confiance 0-100 par rôle, sans circuit-breaker pipeline
- `cost-tracking.ts` — attribution coûts par agent/sprint, pas de granularité span
- `gate-evaluator.ts` — rubric scoring 4×25, boucle rework, sans lien direct aux coûts
- `feedback-loop.ts` — double-boucle d'apprentissage, sans versioning des règles en DB
- `gate-persistence.ts` — persistance évaluations, double-loop learning

### Problème posé

Cette exploration a pour objectif de :
1. Valider la conception concrète du module `src/llm-ops.ts` (API, responsabilités, frontières)
2. Définir précisément le périmètre du daemon `claude-llmops` vs le heartbeat existant
3. Identifier le schéma Supabase minimal nécessaire (table `prompt_versions` ?)
4. Résoudre les 3 questions ouvertes laissées par l'exploration précédente : granularité prompt versioning, seuils circuit-breaker, absorber dans heartbeat ou daemon séparé

### Pourquoi explorer avant de spécifier

La conception de `llm-ops.ts` touche 6 modules existants avec 14 consommateurs (imports directs). Une mauvaise API de ce module ou un mauvais découpage créerait de la dette technique immédiate. L'exploration doit clarifier : (a) quelles fonctions appartiennent réellement au module vs restent dans leurs modules source, (b) comment le module s'intègre sans breaking changes, (c) si un daemon séparé est justifié vs extension du heartbeat.

---

## Section 2 — État de l'Art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://jangwook.net/en/blog/en/ai-agent-observability-production-guide/ | Guide prod | 2025 | Tracing distribué multi-niveaux obligatoire. Circuit breakers via surveillance de profondeur de spans (ex: boucle récursive détectée en 3 min). Cost attribution par agent. Module transversal OpenTelemetry recommandé. | Très haute |
| 2 | https://opentelemetry.io/blog/2024/llm-observability/ | Spec officielle | 2024 | Architecture span hiérarchique : request params + model version + token counts + cost par span. Payloads de prompt en events span (pas attributs). Séparation receivers/processors/exporters. | Haute |
| 3 | https://www.getmaxim.ai/articles/llm-observability-best-practices-for-2025/ | Best practices | 2025 | Logging structuré + cost tracking (sem 1-2) → instrumentation traces (sem 3-4) → dashboards + alertes (mois 1). Distributed tracing + token accounting = baseline 2025. | Haute |
| 4 | https://agenta.ai/blog/top-llm-observability-platforms | Comparatif | 2025 | Prompt versioning comme artefact de première classe. Link prompt version → trace. Évaluations offline et online sur données production. Langfuse, Opik, LangSmith comparés. | Haute |

### Synthèse des enseignements clés

**1. Module transversal, pas agent — confirmation forte.**
L'ensemble de l'état de l'art 2025-2026 place l'observabilité LLM dans une couche d'infrastructure orthogonale au pipeline de production. OpenTelemetry propose une hiérarchie de spans : une trace parent par pipeline, des spans fils par agent step, des span events pour les payloads de prompt. Ce modèle mappe directement sur l'architecture existante (`session_id` comme trace-id, `agent_role` comme span, `agent_events` comme events).

**2. Span-level cost attribution est la lacune la plus critique.**
L'attribution coût au niveau span (step individuel dans le pipeline) est décrite comme standard de production 2025. La pratique recommandée : logger `tokens_input`, `tokens_output`, `cost_usd`, `duration_ms`, `model` par span (i.e. par appel LLM individuel dans un step agent). Le codebase actuel log déjà au niveau agent mais pas au niveau gate individuel ou appel interne.

**3. Prompt versioning comme artefact de première classe.**
Langfuse, LangSmith et Opik traitent les versions de prompts comme des artefacts liés aux traces. La recommandation : stocker `(role, version, content_hash, created_at)` avec lien vers les traces qui l'ont utilisé. Permet A/B testing et détection de drift de qualité post-changement de template YAML.

**4. Circuit breaker via profondeur de span / score de qualité.**
Le pattern recommandé n'est pas un circuit breaker au sens réseau (latence + timeout). En contexte multi-agent LLM, le circuit breaker est basé sur la **dégradation de qualité mesurée** : si le score de qualité (trust score, rubric score) chute sous un seuil sur N évaluations consécutives, déclencher un downgrade de pipeline ou une notification. Ce pattern est déjà partiellement implémenté dans `trust-scores.ts` mais sans décision de pipeline automatique.

---

## Section 3 — Archéologie Codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/agent-events.ts` (241 lignes) | Event sourcing complet : 13 types, persist Supabase + fallback in-memory, `getTracingTimeline` (alias `getAgentEvents`). Non exploité pour agrégation observabilité. DLQ via `captureAgentFailure`. | Base solide pour couche tracing — réutilisable sans modification |
| 2 | `src/trust-scores.ts` (287 lignes) | Scores 0-100 par rôle, seuils `specAutoApprove`/`implAutoApprove` par rôle, `getAutonomyLevel`. Met à jour après chaque gate. Pas de déclenchement automatique de downgrade pipeline quand score critique. | Étendu : ajouter `shouldDowngradePipeline(role, currentPipeline)` → API publique de llm-ops.ts |
| 3 | `src/cost-tracking.ts` (362 lignes) | Attribution coûts par agent/sprint/tâche. `MODEL_PRICING` 3 modèles. Parsing token CLI. Pas de `span_id` ni lien vers `session_id`. Pas d'attribution au niveau gate individuel. | Étendu : ajouter champ `span_id` + `session_id` → logCostWithSpan() |
| 4 | `src/gate-evaluator.ts` (887 lignes) | Rubric 4×25, eval-rework loop, auto-approve via trust-scores. Appelle `updateTrustScore` et `persistGateEvaluation`. Ne log pas le coût du call LLM evaluateur lui-même. | Consommateur de llm-ops.ts : appel à `recordSpan()` pour le coût de l'évaluation |
| 5 | `src/feedback-loop.ts` (431 lignes) | Double-boucle : retros → règles persistées → enrichissement prompts. `trustDeltaAfter` pour mesurer efficacité règle. Pas de versioning des règles en DB par date/hash. | Étendu : `getActivePromptVersion(role)` → permet de lier règle feedback à une version de prompt |
| 6 | `src/bmad-prompts.ts` (559 lignes) | Charge YAML depuis `config/bmad-templates/agents/*.yaml`. Enrichit via `buildFeedbackContext()`. Pas de hash du template ni de version stockée au moment de l'exécution. | Étendu : appel à `recordPromptVersion(role, hash)` au moment de la construction du prompt |
| 7 | `src/orchestrator.ts` (1552 lignes) | Orchestre tout. Importe `cost-tracking`, `agent-events`, `trust-scores` (via gate-evaluator). C'est le point d'intégration central. Pas de notion de "span ouvert". | Consommateur principal de llm-ops.ts : ouvrir/fermer spans, attributs de pipeline |
| 8 | `src/heartbeat.ts` | Daemon PM2 cron*/10. Collecte delta git+tâches, spawn Claude si intéressant, tâches périodiques (alerts, archival, digest). Pattern éprouvé pour daemon autonome. | Modèle d'implémentation pour claude-llmops — réutiliser le pattern state JSON |
| 9 | `src/alerts.ts` | Détection anomalies workflow (stuck tasks, rework, schedule). `formatMonitoringStats()` compose pour `/monitor`. Import `formatTrustScores` depuis trust-scores. | Consommateur de llm-ops.ts : remplacer imports directs par API agrégée |
| 10 | `src/commands/help.ts` | `/monitor` : compose trust-scores, gate-evaluations, agent-events. Agrège manuellement depuis 3 sources. | Simplifiable : appel unique à `getLlmOpsSnapshot()` de llm-ops.ts |
| 11 | `db/schema.sql` | Tables existantes : `agent_events` (session_id, agent_role, event_type, payload), `cost_tracking` (sans span_id ni session_id), `trust_scores`, `gate_evaluations`, `feedback_rules`. Pas de table `prompt_versions`. | Nouvelle migration : `prompt_versions` + colonnes `span_id`/`session_id` sur `cost_tracking` |
| 12 | `ecosystem.config.cjs` | 4 services PM2 : relay, dashboard, heartbeat (*/10), system-alerts (*/15). Pattern cron_restart bien établi. | Ajout du 5e service `claude-llmops` (*/30) via nouvelle entrée |

### Points de friction identifiés

1. **Frontière `llm-ops.ts` vs modules source** : Le module doit exposer une API de façade sans dupliquer la logique. Il ne doit pas importer depuis `gate-evaluator.ts` pour éviter les dépendances circulaires (gate-evaluator → trust-scores, trust-scores → bmad-agents). La direction : llm-ops.ts importe trust-scores + cost-tracking + agent-events, mais PAS gate-evaluator ni orchestrator.

2. **`cost_tracking` sans `session_id`** : La table `cost_tracking` n'a pas de colonne `session_id`. L'attribution coût par pipeline-run (span parent) nécessite une migration. Risque de breaking change sur `logCost()` si on renomme le paramètre — solution : ajouter `span_id` optionnel.

3. **Prompt versioning vs feedback_rules** : La table `feedback_rules` stocke les règles d'enrichissement mais pas le hash du template YAML source. Deux options : (a) nouvelle table `prompt_versions` avec `(role, template_hash, feedback_hash, active_since)`, (b) extension de `feedback_rules` avec un champ `template_hash`. Option (a) est plus propre car sépare versioning statique (YAML) du dynamique (règles apprises).

4. **Daemon séparé vs heartbeat** : Le heartbeat tourne */10 et peut spawner Claude pour analyse. LLM-Ops monitoring est plus naturellement */30 (moins fréquent, données moins volatiles). Surtout : si le daemon LLM-Ops détecte une anomalie et doit créer une tâche, il a besoin d'accès Supabase et Telegram — exactement comme le heartbeat. La duplication de setup serait coûteuse. **Décision recommandée : absorber dans le heartbeat comme tâche périodique supplémentaire**, avec un `llmops_check_interval` configurable et un flag feature `llmops_monitoring`.

5. **Pas de span_id dans l'architecture actuelle** : Le concept de "span ouvert" (open telemetry pattern) n'existe pas. Le proxy le plus proche est `session_id` dans `agent_events`. L'implémentation devrait utiliser `session_id` comme trace-id et `${session_id}:${agent_role}:${step_index}` comme span_id synthétique, sans dépendance à une lib OpenTelemetry externe.

### Actifs réutilisables

- `agent-events.ts` : `emitAgentEvent` + `getAgentEvents` → base du tracing LLM-Ops
- `trust-scores.ts` : `getCachedTrustScore` + `getAutonomyLevel` → base du circuit-breaker
- `cost-tracking.ts` : `logCost` + `MODEL_PRICING` → extensible avec span attribution
- `heartbeat.ts` : pattern complet state JSON + cron + Supabase + Telegram → modèle pour le daemon
- `feature-flags.ts` : hot-reload → `llmops_monitoring` flag pour activer/désactiver
- `alerts.ts` : types `Alert` existants → réutilisables pour alertes LLM-Ops

---

## Section 4 — Matrice d'Alternatives

| Critère | A: Status quo | B: Module llm-ops.ts seul | C: Module + daemon séparé | D: Module + intégration heartbeat |
|---------|:------------:|:------------------------:|:------------------------:|:---------------------------------:|
| **Complexité** (obligatoire) | S | M | L | M |
| **Valeur ajoutée** (obligatoire) | Low | High | High | High |
| **Risque technique** (obligatoire) | Low | Low | Med | Low |
| *Impact maintenance future* | Fragmentation croissante | Cohérence + 1 point d'entrée | +1 service PM2 à maintenir | Heartbeat + responsabilités LLM-Ops bien séparées |
| *Réversibilité* | N/A | Facile (module interne) | Difficile (service séparé enraciné) | Facile (flag feature pour désactiver) |

### Discussion par option

**A — Status quo.**
La fragmentation actuelle des 6 modules LLM-Ops sans cohérence génère un risque de dégradation silencieuse. Chaque nouveau sprint qui utilise le pipeline ajoute des coûts non attribués, des trust scores qui baissent sans déclencher de downgrade, des prompts qui dérivent sans detection. La valeur créée par le système multiagent est réelle mais invisible. Le status quo devient techniquement intenable à mesure que le pipeline gagne en intensité d'utilisation.

**B — Module `src/llm-ops.ts` seul (sans daemon).**
Créer un module de façade qui unifie les 5 responsabilités LLM-Ops (prompt versioning, circuit-breaker, span attribution, observabilité `/monitor`, drift detection) sans daemon associé. Toutes les fonctions de monitoring seraient déclenchées à la demande (par `/monitor`, par le pipeline, par les gates). C'est l'option la plus simple et déjà très valorisante. Le monitoring périodique manquerait, mais la fondation serait posée.

**C — Module + daemon PM2 `claude-llmops` séparé.**
Crée un 5e service PM2 avec sa propre entrée dans `ecosystem.config.cjs`. Avantage : isolation totale, cron indépendant. Inconvénient : duplication du setup Supabase/Telegram déjà dans le heartbeat, +1 service à monitorer, +1 log à gérer. Complexité opérationnelle élevée pour un gain marginal par rapport à l'option D.

**D — Module + intégration heartbeat (option recommandée).**
`src/llm-ops.ts` comme module transversal + `runLlmOpsCheck()` intégrée dans le heartbeat comme tâche périodique toutes les 30min (feature-flaggée). Le heartbeat appelle déjà `runAllChecks()`, `archiveOldMemories()`, `runAllScanners()` — ajouter `runLlmOpsCheck()` est parfaitement naturel. Pas de nouveau service PM2, pas de duplication setup. Le monitoring LLM-Ops est activé par le flag `llmops_monitoring`. Complexité M, valeur High, risque Low.

---

## Section 5 — Verdict et Justification

**Verdict : GO**

**Option recommandée : D — Module `src/llm-ops.ts` + intégration dans heartbeat**

**Justification :**

1. **L'état de l'art valide la direction module transversal** (axe 1 : OpenTelemetry, jangwook.net 2025). Les patterns recommandés — span hierarchy, cost-per-span, prompt versioning comme artefact, circuit breaker par score qualité — sont tous implémentables sans lib externe, en réutilisant les structures existantes (`session_id` → trace-id, `agent_events` → span events, `trust_scores` → signal circuit-breaker).

2. **Les 6 modules fragmentés fournissent toutes les briques** (axe 2). Aucune dépendance externe n'est nécessaire. `agent-events.ts` est déjà un event sourcing de qualité production. `trust-scores.ts` a la mécanique de scoring par rôle. `cost-tracking.ts` a le pricing multi-modèle. Il manque uniquement la couche de façade, les 3-4 fonctions transversales (recordSpan, getCircuitBreakerStatus, recordPromptVersion, getLlmOpsSnapshot), et une migration Supabase légère.

3. **L'absorption dans le heartbeat élimine le principal risque de l'option C** (axe 3). La duplication setup Supabase/Telegram est le risque central d'un daemon séparé. Le heartbeat résout déjà ce problème avec un pattern éprouvé. La séparation logique est maintenue (module `llm-ops.ts` autonome et testable), seul le scheduling est mutualisé.

4. **Le périmètre est bornable en spec formelle**. Les 4 responsabilités du module sont identifiées précisément, les 2 nouvelles entrées de schéma Supabase sont définies, les consommateurs (orchestrator, gate-evaluator, bmad-prompts, help.ts) sont connus avec leurs points d'intégration. Une spec en 9 sections est directement réalisable.

5. **Les 3 questions ouvertes de l'exploration précédente sont résolues** : (a) granularité prompt versioning = par rôle + hash combiné template_yaml + feedback_rules actives, (b) seuils circuit-breaker = `trust_score < 30` sur un rôle OU `consecutiveFailures >= 3` → notification + proposition downgrade, (c) daemon séparé ou heartbeat = heartbeat avec flag feature.

---

## Section 6 — Input pour Étape Suivante

### Option recommandée : D

### Fichiers concernés (à modifier ou créer)

**Nouveaux :**
- `src/llm-ops.ts` — Module transversal (à créer)
- `db/migrations/llm-ops-schema.sql` — Migration : table `prompt_versions` + colonne `span_id` sur `cost_tracking`

**Modifiés (intégration) :**
- `src/heartbeat.ts` — Ajouter `runLlmOpsCheck()` dans la boucle périodique (toutes les 30min)
- `src/heartbeat-prompt.ts` — Étendre `HeartbeatDelta` avec métriques LLM-Ops
- `src/orchestrator.ts` — Appeler `llmOps.recordSpan(session_id, role, ...)` à chaque step
- `src/bmad-prompts.ts` — Appeler `llmOps.recordPromptVersion(role, hash)` à la construction
- `src/cost-tracking.ts` — Ajouter `logCostWithSpan(supabase, entry, spanId)` sans casser logCost()
- `src/commands/help.ts` — Remplacer agrégation manuelle `/monitor` par `getLlmOpsSnapshot()`
- `config/features.json` — Ajouter flag `llmops_monitoring: false`

**Non modifiés (consommateurs passifs) :**
- `src/trust-scores.ts` — API publique lue par llm-ops.ts, pas modifiée
- `src/agent-events.ts` — API publique lue par llm-ops.ts, pas modifiée
- `src/gate-evaluator.ts` — Consomme trust-scores directement, pas de dépendance vers llm-ops.ts

### API publique cible de `src/llm-ops.ts`

```typescript
// Prompt versioning
recordPromptVersion(supabase, role: AgentRole, templateHash: string, feedbackHash: string): Promise<void>
getActivePromptVersion(supabase, role: AgentRole): Promise<PromptVersion | null>

// Span attribution
recordSpan(supabase, session_id: string, role: AgentRole, step: number, tokens: TokenUsage, durationMs: number): Promise<string> // retourne span_id
recordSpanCost(supabase, spanId: string, entry: CostEntry): Promise<void>

// Circuit-breaker
getCircuitBreakerStatus(role: AgentRole): CircuitBreakerStatus // { open: boolean, reason: string, suggestedDowngrade: PipelineType | null }
shouldDowngradePipeline(supabase, sessionId: string, currentPipeline: PipelineType): Promise<PipelineDowngradeDecision>

// Observabilité agrégée
getLlmOpsSnapshot(supabase): Promise<LlmOpsSnapshot> // pour /monitor
runLlmOpsCheck(supabase, notifyFn): Promise<LlmOpsCheckResult> // pour heartbeat
```

### Schéma Supabase minimal

```sql
-- Nouvelle table
CREATE TABLE prompt_versions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  agent_role TEXT NOT NULL,
  template_hash TEXT NOT NULL,    -- SHA256 du contenu YAML
  feedback_hash TEXT NOT NULL,    -- SHA256 des feedback_rules actives pour ce rôle
  combined_hash TEXT NOT NULL,    -- template_hash + feedback_hash
  UNIQUE (agent_role, combined_hash)
);

-- Extension cost_tracking
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS span_id TEXT;
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cost_tracking_session ON cost_tracking(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_span ON cost_tracking(span_id);
```

### Contraintes identifiées pour la spec

1. **Pas de lib OpenTelemetry externe** : span_id synthétique `${session_id}:${role}:${step}`, pas de dépendance à `@opentelemetry/*`
2. **Backward compatibility** : `logCost()` existant inchangé, `logCostWithSpan()` est une surcharge optionnelle
3. **Feature flag** : `llmops_monitoring` contrôle l'activation de `runLlmOpsCheck()` dans le heartbeat
4. **Circuit-breaker non bloquant** : `shouldDowngradePipeline()` retourne une recommandation, la décision finale reste à l'orchestrator
5. **Granularité prompt versioning** : par rôle agent, pas par commande Telegram ni par sprint — simplifie la table et les queries

### Questions ouvertes résiduelles pour la spec

1. Le `getLlmOpsSnapshot()` doit-il être une query Supabase temps-réel ou une agrégation périodique cachée ? (impact sur la latence de `/monitor`)
2. Quels seuils précis pour le circuit-breaker ? (`trust_score < 30` OU `consecutiveFailures >= 3` — à valider avec les données réelles en DB via MCP Supabase)
3. Le daemon `runLlmOpsCheck()` doit-il créer automatiquement des tâches de diagnostic (comme le heartbeat), ou seulement notifier ? (politique de création automatique de tâches à définir)
