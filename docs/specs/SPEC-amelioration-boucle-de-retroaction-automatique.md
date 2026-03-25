---
name: amelioration-boucle-de-retroaction-automatique
phase: 1-spec
generated_at: "2026-03-25T00:00:00Z"
exploration_ref: docs/explorations/EXPLORE-amelioration-boucle-de-retroaction-automatique.md
---

# SPEC — Amélioration boucle de rétroaction automatique

## Section 1 — Objectif

Brancher la boucle de rétroaction automatique (`feedback-analyzer.ts`) sur des signaux réels issus du pipeline SDD. Actuellement, `fetchSignals: async () => []` dans `getDeps()` garantit que zéro overlay correctif n'est jamais créé automatiquement en production, malgré `prompt_feedback_loop: true` dans `features.json` — c'est du dead code actif. L'objectif est d'implémenter (1) l'émission d'événements SDD dans `agent_events` depuis `job-manager.ts`, (2) `fetchSignals` lisant ces événements depuis Supabase, et (3) un mode LLM (Haiku) pour `generateOverlayText` produisant des overlays contextuellement pertinents à partir du champ `details` des signaux.

---

## Section 2 — Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Après complétion d'un job SDD dans `job-manager.ts`, un événement doit être écrit dans `agent_events` avec `agent_role` (dérivé de la phase), `event_type = 'sdd_verdict'`, `payload.verdict`, `payload.pipelineName`, `payload.details` (50 premiers chars du résultat), `payload.source` (phase: challenge/review/etc.) | Exploration §3 obs#3, job-manager.ts:349 (parsing regex SDD existant) | Phase challenge, verdict NO-GO → `{agent_role: "spec-architect", event_type: "sdd_verdict", payload: {verdict: "NO-GO", source: "challenge", pipelineName: "mon-feature", details: "Sections 6 et 7 vides"}}` |
| R2 | `fetchSignals` dans `getDeps()` interroge `agent_events` sur une fenêtre glissante de 7 jours, filtrée sur `event_type = 'sdd_verdict'` et `payload.verdict IN ('NO-GO', 'GO_WITH_CHANGES', 'CHANGES_REQUESTED', 'FAILED')`. Retourne un tableau `AgentFeedbackSignal[]` mappé depuis les colonnes. | Exploration §4 option B, FAILURE_OUTCOMES feedback-analyzer.ts:46 | `SELECT * FROM agent_events WHERE event_type='sdd_verdict' AND created_at > now()-'7 days'::interval` |
| R3 | La valeur du champ `agent_role` écrit dans `agent_events` est déterminée par la phase SDD : `challenge` → `"spec-architect"`, `review` → `"reviewer"`, `implement` → `"implementer"`, `explore` → `"explorer"`, `spec` → `"spec-architect"`. | Exploration §3 obs#3 + sdd-agents.ts readAgentFile() conventions (fichiers: spec-architect.md, reviewer.md, explorer.md) | Phase "challenge" → agent_role = "spec-architect" (c'est lui qui est challengé) |
| R4 | En mode LLM (`sdd_feedback_llm_overlay: true`), `runFeedbackLoop` construit un prompt Haiku avec `agentRole`, `failureCount`, `source`, et les `details` des signaux (concaténés), puis appelle `spawnClaude` avec `model: "claude-haiku-4-5-20251001"` et `effort: "low"`. L'overlay produit est tronqué à 300 chars. | Exploration §3 F3, état de l'art Pattern 3 (MemPrompt) | 4 signaux NO-GO pour spec-architect, details: "sections 6-7 vides", "imports manquants", "V-critères sans niveau" → overlay LLM : "ATTENTION : 4 échecs récents. Cause dominante : sections 6-7 non explorées. Action : utiliser Glob/Grep pour remplir ces sections avant de soumettre." |
| R5 | En mode template (flag `sdd_feedback_llm_overlay` désactivé, ou appel Haiku échoue), la logique existante de `generateOverlayText` est conservée intégralement (fallback). | Contrainte rétrocompatibilité tests V3, V6 | Flag désactivé → template "ATTENTION : 3 echecs recents detectes lors de la phase challenge..." |
| R6 | L'émission de l'événement dans `job-manager.ts` est best-effort : si l'écriture Supabase échoue, le job se termine normalement, l'erreur est loggée avec `log.warn`. | Pattern projet : destructuring `{ error }` + `log.warn` (conventions CLAUDE.md) | `const { error } = await supabase.from('agent_events').insert({...}); if (error) log.warn('emit sdd event failed', { error })` |
| R7 | La table `feedback_rules` Supabase n'est pas utilisée dans ce sprint. Les overlays restent stockés en JSON local (`~/.claude-relay/prompt-overlays.json`). | Exploration contrainte "Pas de migration feedback_rules dans ce sprint", exploration §3 friction F2 |  |
| R8 | Le champ `session_id` de `agent_events` est le `pipelineName` (nom du pipeline SDD, ex: `"mon-feature"`). Il permet de regrouper les événements d'un même pipeline. | Schema db/schema.sql:1127 — colonne `session_id TEXT NOT NULL` | `session_id = "amelioration-boucle-de-retroaction-automatique"` |
| R9 | `fetchSignals` ne dépend pas du heartbeat PM2 : il est appelé directement depuis `runFeedbackLoop()` qui est désormais aussi invoqué depuis `job-manager.ts` après chaque complétion de job SDD (en plus de l'appel existant dans heartbeat.ts). | Exploration §5 point 5 — heartbeat actuellement stoppé | Job SDD terminé → `runFeedbackLoop()` appelé immédiatement (sans attendre le prochain pulse heartbeat) |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| Table Supabase `agent_events` | Rows filtrées (7j, sdd_verdict) | `supabase.from('agent_events').select('agent_role,event_type,payload,created_at').eq('event_type','sdd_verdict').gte('created_at', cutoff)` | `agent_role`, `payload.verdict`, `payload.source`, `payload.details`, `created_at` |
| `config/features.json` | Feature flags JSON | `isFeatureEnabled(flag)` | `prompt_feedback_loop` (existant), `sdd_feedback_llm_overlay` (nouveau) |
| Job result string (job-manager.ts) | String prefixée `SDD_*` | Regex `VERDICT_REGEX` existante (sdd-auto-advance.ts:152) | Verdict, phase, pipeline name |
| `AgentFeedbackSignal[]` | Interface TypeScript | Mappé depuis agent_events rows | `agentRole`, `outcome`, `timestamp`, `source`, `details?` |

---

## Section 4 — Données de sortie

**`fetchSignals()` → `AgentFeedbackSignal[]`**

Structure d'un signal mappé depuis `agent_events` :
```typescript
{
  agentRole: string;      // agent_events.agent_role, ex: "spec-architect"
  outcome: "GO" | "GO_WITH_CHANGES" | "NO-GO" | "APPROVED" | "CHANGES_REQUESTED" | "FAILED";
                          // mappé depuis payload.verdict
  timestamp: string;      // agent_events.created_at (ISO)
  source: "challenge" | "review" | "implement" | "explore"; // payload.source
  details?: string;       // payload.details (50 premiers chars du résultat SDD)
}
```

**Overlay LLM généré (mode `sdd_feedback_llm_overlay: true`)** :

Prompt Haiku :
```
Tu génères une instruction corrective courte (max 300 chars, en français) pour un agent IA SDD.
Agent: {agentRole}
Echecs récents ({failureCount}): source={source}
Details des signaux: {details concaténés, max 500 chars}
Ecris une instruction d'action concrète commençant par "ATTENTION :".
```

Réponse attendue (exemple) :
```
ATTENTION : 4 échecs récents (challenge). Cause dominante : sections 6-7 non renseignées.
Action : utiliser Glob/Grep pour remplir la section fichiers avec des chemins réels avant de soumettre la spec.
```

**Règles de remplissage** :
- Si `spawnClaude` Haiku échoue ou retourne vide → fallback vers `generateOverlayText` template
- L'overlay est tronqué à 300 chars si le LLM produit plus
- Le champ `details` agrège les `details` des N signaux du pattern, séparés par " | "

---

## Section 5 — Interface Telegram

N/A — pas d'impact sur l'interface Telegram.

La boucle de rétroaction est entièrement automatique et s'exécute en arrière-plan (heartbeat ou post-job). Ses effets (overlays enrichissant les prompts d'agents SDD) sont invisibles pour l'utilisateur. Les résultats sont tracés via `log.info("Feedback loop: X overlay(s) created, Y expired, Z pattern(s)")` dans `heartbeat.ts` et `job-manager.ts`.

---

## Section 6 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/feedback-analyzer.ts` | **Modifier** | Remplacer `fetchSignals: async () => []` dans `getDeps()` par une vraie requête Supabase ; ajouter la logique LLM overlay dans `runFeedbackLoop` (via `spawnClaude`) gated par `sdd_feedback_llm_overlay` |
| `src/job-manager.ts` | **Modifier** | (1) Émettre un événement dans `agent_events` après complétion d'un job SDD (via supabase bctx), en réutilisant le parsing SDD existant (lignes 334-380) ; (2) appeler `runFeedbackLoop()` à la fin d'un job SDD |
| `config/features.json` | **Modifier** | Ajouter `"sdd_feedback_llm_overlay": false` (désactivé par défaut pour permettre validation progressive) |
| `tests/unit/feedback-analyzer.test.ts` | **Modifier** | Ajouter tests V9-V14 couvrant fetchSignals (mock Supabase), LLM overlay (mock spawnClaude), best-effort emit |
| `tests/unit/job-manager.test.ts` | **Modifier** | Ajouter tests pour l'émission d'événements SDD post-complétion (mock Supabase insert) |

---

## Section 7 — Patterns existants

**1. Regex de parsing verdict SDD** — réutilisable pour mapper les résultats en AgentFeedbackSignal :
- `src/sdd-auto-advance.ts:152` :
  ```typescript
  const VERDICT_REGEX =
    /^SDD_\w+_(GO_WITH_CHANGES|NO-GO|GO|OK|FAILED|PIVOT|DROP|APPROVED|CHANGES_REQUESTED):/;
  ```
- `src/job-manager.ts:349` : même regex utilisée pour extraire le verdict dans le switch SDD

**2. Pattern d'injection de dépendances testable** — existant dans `feedback-analyzer.ts`, à conserver :
- `src/feedback-analyzer.ts:60-72` : `_setDependencies` / `getDeps()` — les tests V1-V8 injectent `fetchSignals` via ce mécanisme ; la nouvelle implémentation Supabase doit rester dans `getDeps()` (production default)

**3. Appel LLM léger via `spawnClaude`** — pattern utilisé dans tous les agents SDD :
- `src/sdd-agents.ts:177-183` : `spawnClaude({ prompt, model: "claude-sonnet-4-6", effort: "medium" })` — adapter avec `model: "claude-haiku-4-5-20251001"` et `effort: "low"` pour les overlays

**4. Émission best-effort Supabase** — pattern standard du projet :
- `src/memory/agent-memory.ts` (saveAgentMemory) : `const { error } = await supabase.from('agent_memory').insert({...}); if (error) log.error(...)`
- Convention CLAUDE.md : "always destructure `{ error }` from Supabase operations and log with `log.error`"

**5. Fenêtre temporelle Supabase** — pattern réutilisable pour `fetchSignals` :
- `src/alerts.ts` : filtres `.gte('created_at', cutoffDate.toISOString())` sur fenêtre glissante 7j

**6. Mapping agent_role depuis phase SDD** :
- `src/sdd-agents.ts:159` : `readAgentFile("explorer.md")` → `src/sdd-agents.ts:206` : `readAgentFile("spec-architect.md")` → `src/sdd-agents.ts:458` : `readAgentFile("reviewer.md")`
- Mapping phase → rôle déductible : challenge → spec-architect, review → reviewer, implement → implementer, explore → explorer, spec → spec-architect

---

## Section 8 — Contraintes

1. **Rétrocompatibilité tests V1-V8** : `analyzeAgentFeedback`, `generateOverlayText` et `runFeedbackLoop` gardent leurs signatures actuelles. Les tests existants injectent `fetchSignals` via `_setDependencies` — ce mécanisme doit rester fonctionnel.

2. **Feature flag double gating** : `prompt_feedback_loop` (existant) gate la boucle entière. `sdd_feedback_llm_overlay` (nouveau, `false` par défaut) gate uniquement le mode LLM. Si `sdd_feedback_llm_overlay = false`, les overlays sont générés par les templates statiques existants.

3. **LOC threshold** : `feedback-analyzer.ts` est à 233 LOC. Avec les ajouts (fetchSignals Supabase + LLM path), rester sous 400 LOC (threshold 800 LOC, guideline projet).

4. **Standards S1/S2** : interdiction de `console.*` (utiliser `createLogger`) et de `process.env` direct (utiliser `getConfig()`). La création du client Supabase dans `feedback-analyzer.ts` doit passer par `getConfig()`.

5. **Émission best-effort** : les appels `supabase.from('agent_events').insert(...)` dans `job-manager.ts` ne doivent jamais propager d'exceptions ni bloquer le flow principal. Bloc `try/catch` obligatoire.

6. **Pas de migration `feedback_rules`** : la table `feedback_rules` a un CHECK constraint `source IN ('retro', 'double_loop')` incompatible. Hors scope de ce sprint.

7. **Coût Haiku** : le flag `sdd_feedback_llm_overlay` est désactivé par défaut. Estimation ~$0.001/overlay. Le mécanisme de dédup existant (overlay identique role+source déjà actif → skip) limite les appels.

8. **Import restriction `sdd-agents.ts`** : le commentaire R13 indique des imports restreints, mais la réalité du fichier montre déjà `feature-flags.ts` et `prompt-overlay.ts`. L'émission d'événements SDD passe par `job-manager.ts` (qui a déjà accès au Supabase via BotContext) pour éviter d'alourdir `sdd-agents.ts`.

---

## Section 9 — Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|--------------|--------|
| V1 | `analyzeAgentFeedback` détecte les patterns récurrents (≥3 NO-GO) pour un agent role | Test existant — 3 signaux NO-GO spec-architect → pattern détecté | `unit` |
| V2 | `analyzeAgentFeedback` retourne `[]` si aucun pattern récurrent | Test existant — 2 signaux GO → [] | `unit` |
| V3 | `generateOverlayText` produit une instruction corrective ≤500 chars mentionnant le pattern | Test existant — texte non vide, match regex echec/rejet | `unit` |
| V4 | `analyzeAgentFeedback` groupe les échecs par agentRole indépendamment | Test existant — 3 NO-GO spec-architect + 3 NO-GO reviewer → 2 patterns | `unit` |
| V5 | `analyzeAgentFeedback` respecte `RECURRENCE_THRESHOLD` (2 < 3 = pas de pattern) | Test existant — 2 NO-GO → [] | `unit` |
| V6 | `runFeedbackLoop` crée des overlays quand des patterns sont détectés | Test existant — signals injectés via `_setDependencies` → overlaysCreated ≥ 1 | `unit` |
| V7 | `runFeedbackLoop` est gated par `prompt_feedback_loop` feature flag | Test existant — flag false → skipped=true | `unit` |
| V8 | `runFeedbackLoop` expire les anciens overlays avant d'en créer de nouveaux | Test existant — `expiredCount` défini | `unit` |
| V9 | `fetchSignals` dans `getDeps()` retourne les signaux des 7 derniers jours depuis `agent_events` (verdict négatif uniquement) | Mock Supabase retournant 3 rows avec payload.verdict='NO-GO' → fetchSignals retourne 3 AgentFeedbackSignal | `integration` |
| V10 | `fetchSignals` retourne `[]` si `agent_events` est vide ou si tous les verdicts sont positifs | Mock Supabase retournant rows avec payload.verdict='GO' → fetchSignals retourne [] | `integration` |
| V11 | Après complétion d'un job SDD avec verdict négatif, un événement est écrit dans `agent_events` via `job-manager.ts` | Mock supabase.insert — après parseResult SDD_CHALLENGE_NO-GO → insert appelé avec agent_role='spec-architect', event_type='sdd_verdict' | `integration` |
| V12 | L'émission de l'événement dans `job-manager.ts` est best-effort : une erreur Supabase ne bloque pas le flow | Mock supabase.insert retournant `{ error: new Error('Supabase down') }` → job se termine normalement, log.warn appelé | `unit` |
| V13 | En mode LLM (`sdd_feedback_llm_overlay: true`), `runFeedbackLoop` appelle `spawnClaude` Haiku avec les details des signaux et produit un overlay ≤300 chars | Mock `spawnClaude` retournant "ATTENTION : texte contextuel..." → overlay.overlayText.length ≤ 300 | `unit` |
| V14 | En mode LLM, si `spawnClaude` Haiku échoue (exitCode ≠ 0 ou stdout vide), `runFeedbackLoop` bascule sur le template statique (fallback) | Mock `spawnClaude` retournant exitCode=1 → overlay généré via `generateOverlayText` template | `unit` |
| V15 | `runFeedbackLoop` est appelé depuis `job-manager.ts` après complétion d'un job SDD (pas seulement via heartbeat) | Test intégration : job SDD complété → `runFeedbackLoop` invoqué (spy/mock) | `integration` |

---

## Section 10 — Coverage et zones d'ombre

### Matrice des dimensions

| Dimension | Couverture par cette spec | Zones non résolues |
|-----------|--------------------------|-------------------|
| **Problème** | Gap critique résolu : `fetchSignals: async () => []` remplacé par requête Supabase réelle (R2) | Pas de mesure de l'efficacité des overlays (option C différée) : on ne sait pas si un overlay améliore réellement les verdicts suivants |
| **Périmètre** | 2 fichiers modifiés (`feedback-analyzer.ts`, `job-manager.ts`), 1 config modifiée (`features.json`) | Heartbeat PM2 actuellement stoppé — l'appel depuis job-manager est le mécanisme principal. Si job-manager est lui-même inaccessible, la boucle ne tourne pas |
| **Validation** | 15 V-critères couvrant les cas nominaux et de fallback (V9-V15 nouveaux) | Pas de test E2E de la chaîne complète en production réelle (signaux → overlay → amélioration verdict) |
| **Technique** | Supabase query sur `agent_events`, Haiku via `spawnClaude`, feature flag double-gating | La table `agent_events` n'a pas de `source` constraint — les événements non-SDD pourraient polluer les signaux si d'autres modules écrivent dans cette table à l'avenir |
| **UX Telegram** | N/A (boucle invisible) | Aucune notification utilisateur quand un overlay est créé ou expiré — l'utilisateur ne sait pas que la boucle fonctionne |

### Alternatives évaluées

| Option | Décision | Justification |
|--------|----------|---------------|
| **A — Status quo** | Rejeté | Dead code actif : feature activée mais zéro overlay généré. Fausse confiance |
| **B — fetchSignals Supabase + LLM overlays** | **Choisi** | Résout le gap critique, faible risque, réutilise infra existante (`agent_events`, Haiku via spawnClaude) |
| **C — Persistance Supabase (`feedback_rules`) + métriques d'efficacité** | Différé S+1 | Migration schema incompatible (`source CHECK`), requiert nouveau module `overlay-metrics.ts`. Bonne suite naturelle après validation de B |
| **D — Pipeline complet (B+C + feedback-on-overlay)** | Drop | Trop complexe pour un premier sprint, couplage élevé |

### Décisions ouvertes documentées

- **Q3 (heartbeat)** : le heartbeat PM2 étant stoppé, l'appel `runFeedbackLoop()` depuis `job-manager.ts` est le mécanisme principal. Si le heartbeat est redémarré, les deux chemins seront actifs (dedup via `hasSimilar` existant dans `runFeedbackLoop` — pas de double overlay).
- **Q4 (efficacité overlays)** : différé à option C. Critère minimal futur : taux d'échec pour `agentRole+source` diminue de ≥20% sur les 14 jours suivant activation d'un overlay.
