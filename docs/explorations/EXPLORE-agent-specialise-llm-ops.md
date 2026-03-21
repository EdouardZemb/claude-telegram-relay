---
phase: 0-explore
generated_at: "2026-03-21T14:30:00+01:00"
subject: "Pertinence d'un agent specialise LLM-Ops dans le workflow multiagent"
verdict: PIVOT
next_step: dev-explore
---

# Agent Specialise LLM-Ops dans le Workflow Multiagent

## Section 1 — Probleme

### Origine

Le pipeline multiagent actuel (DEFAULT, LIGHT, QUICK, SOLO, REVIEW, RESEARCH) orchestre jusqu'a 5 agents en sequence pour produire du code. Les capacites opérationnelles LLM — observabilite des traces, versioning des prompts, evaluation continue des outputs, guardrails d'infrastructure, routing intelligent de modeles — sont aujourd'hui dispersees entre plusieurs modules (`llm-router.ts`, `cost-tracking.ts`, `gate-evaluator.ts`, `feedback-loop.ts`, `trust-scores.ts`, `agent-events.ts`) sans cohesion ni responsabilite claire.

### Probleme pose

La question est : faut-il materialiser ces responsabilites LLM-Ops sous la forme d'un **agent specialise** (un 9e role BMad, analogue a `qa` ou `architect`) qui interviendrait dans le pipeline avec une position et un mandat explicites ? Ou bien ces responsabilites sont-elles mieux traitees comme de l'infrastructure transversale sans agent dedie ?

### Pourquoi explorer avant de specifier

L'introduction d'un agent dans le pipeline augmente le cout, la latence et la complexite de coordination (+1 handoff, +1 step). La decision ne doit pas etre prise sans evaluer : (a) ce que LLM-Ops couvre qui n'est pas deja couvert, (b) si un "agent" est la bonne forme architecturale pour ce coverage, (c) quelles alternatives existent.

---

## Section 2 — Etat de l'Art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://www.truefoundry.com/blog/llmops-tools | Article | 2026 | LLMOps complet : prompt management, inference optimization, observabilite temps-reel (latence, cout, drift), RAG pipelines, securite/audit. Passage en revue des 10 meilleurs outils. | Haute |
| 2 | https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025 | Etude de cas | 2025 | Analyse de 1200 deployments : gardes-fous en infrastructure > prompts, context engineering > prompt engineering, guardrails architecturaux (session taint, dual-layer permissions). | Tres haute |
| 3 | https://www.comet.com/site/blog/llmops/ | Guide | 2025-2026 | Economic observability : attribution cout au niveau span/trace/projet. Tracing de trajectoires agentiques (non-deterministisme, boucles, appels recursifs). | Haute |
| 4 | https://zedtreeo.com/llmops-explained-guide-2026/ | Guide | 2026 | LLMOps bien implemente reduit les couts API de 30-60% (caching, routing, prompt compression). Risque principal sans LLMOps : degradation silencieuse de qualite apres update modele. | Haute |
| 5 | https://langwatch.ai/blog/llmops-is-the-new-devops-here-s-what-every-developer-must-know | Article | 2025 | Evolution vers "AgentOps" : orchestration multi-modeles, tracking comportement agent, tracabilite cross-steps. Les responsabilites LLM-Ops tendent vers de l'infrastructure, pas des agents. | Haute |

### Synthese des enseignements cles

**1. LLM-Ops est en grande majorite de l'infrastructure transversale, pas un agent.**
L'etat de l'art (ZenML, Comet, TrueFoundry, LangWatch) converge sur une architecture ou LLM-Ops se materialise comme une couche d'outillage orthogonale au pipeline : traceurs (Langfuse, Phoenix), gateways de routing (Portkey, LiteLLM), evaluateurs automatiques (DeepEval, RAGAS), guardrails d'infrastructure (Guardrails AI, NeMo Guardrails). Ces composants ne participent pas au pipeline de production d'artefacts — ils l'observent et le contraingnent depuis l'exterieur.

**2. La tendance de fond est "infrastructure over prompts".**
L'analyse de 1200 deployments en production (ZenML 2025) indique que les guardrails les plus fiables sont implementes en code, pas en prompts. Un "agent LLM-Ops" dont la responsabilite serait de surveiller/evaluer via un prompt est precisement ce que l'industrie cherche a eviter : il rajoute non-determinisme la ou on veut de la determinisme.

**3. Les fonctions LLM-Ops a valeur reelle sont connues et bornees.**
Prompt versioning + A/B testing, cost attribution par span, tracing distribue (input → output → tool call → eval), evaluation automatique par rubric, circuit breakers/fallbacks de modeles. Ce sont des fonctions techniques, pas des roles de raisonnement.

**4. Le cote "agent" de LLM-Ops est AgentOps.**
L'evolution vers "AgentOps" (LangWatch, Langfuse, Arize) se concentre sur la visualisation de graphes d'agents, le replay de sessions, l'evaluation inter-agents. Ces fonctions sont davantage du tooling de dev qu'un agent dans le pipeline de production.

---

## Section 3 — Archeologie Codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/llm-router.ts` | Routing dynamique pipeline + models via Haiku (5s timeout). Difficulte scoring (graph + description + historique). Bonne couverture mais : pas de fallback model si Haiku echoue au routing, pas de logging structure des decisions de routing. | Moyen |
| 2 | `src/cost-tracking.ts` | Tracking tokens/cout par agent, par sprint, par tache. `MODEL_PRICING` pour 3 modeles. Pas d'attribution au niveau span ou gate individuel (granularite pipeline, pas step). | Moyen |
| 3 | `src/gate-evaluator.ts` | Rubric scoring 4 dimensions (0-25 chacune), checks deterministes, boucle evaluate-rework (max 2 iterations), auto-approve via trust score. Deja une forme d'evaluation automatique de qualite. | Eleve |
| 4 | `src/feedback-loop.ts` | Double-boucle d'apprentissage : retros + gate logs → regles persistees en DB → enrichissement prompts agents. Notion de `trustDeltaAfter` pour evaluer l'efficacite des regles. | Eleve |
| 5 | `src/trust-scores.ts` | Scores de confiance 0-100 par role agent. Mise a jour apres chaque gate. Auto-approve quand score >= seuil par role (`specAutoApprove`, `implAutoApprove`). Degradation acceleree (3+ echecs consecutifs). | Eleve |
| 6 | `src/agent-events.ts` | Event sourcing : 13 types d'evenements (spawned, completed, failed, retried, timed_out...). Stockage Supabase + fallback in-memory. Base solide pour tracing mais pas exploite pour observabilite visible. | Moyen |
| 7 | `src/adversarial-verifier.ts` | Drift detection spec-vs-implementation. Clean room (recoit ONLY spec + impl). Score de coverage 0-1. Verdict pass/fail/warning. Skippé sur QUICK pipeline. | Eleve |
| 8 | `src/orchestrator.ts` | Pipeline sequentiel avec : structured message passing (JSON schemas), retry loop, blackboard integration, checkpoint/resume. Pas de timeout global par step LLM-Ops, pas de circuit breaker explicite entre agents. | Eleve |
| 9 | `src/bmad-prompts.ts` | Prompts charges depuis YAML (`config/bmad-templates/agents/*.yaml`). Enrichissement via `feedback-loop.ts`. Pas de versioning des templates (fichiers YAML en git, pas de table de versions en DB). | Moyen |
| 10 | `src/alerts.ts` | Detection d'anomalies (stuck tasks, rework spikes, schedule slips). Types `review_score_drop`, `agent_failure_pattern`. Deja une forme de monitoring workflow mais orienté taches, pas traces LLM. | Moyen |
| 11 | `src/heartbeat.ts` | Pulse autonome toutes les 10min : alert checks, archival memoire, digest matin. Orchestre des responsabilites monitoring sans etre dans le pipeline de production. | Modele interessant |
| 12 | `config/features.json` | Feature flags : `exploration_phase: false`, `exploration_gate: false`. LLM-Ops features pourraient etre flag-controlees. | Faible |

### Points de friction identifies

1. **Granularite du cout** : `cost-tracking.ts` agit au niveau agent-step mais pas au niveau gate individuel ni span interne. Impossible de savoir quel appel specifique dans un step est couteux.
2. **Prompt versioning absent** : les templates YAML sont versiones par git mais sans historique query-able en DB. Aucun A/B testing de prompts.
3. **Agent-events sous-exploite** : event sourcing complet en place (`agent-events.ts`) mais aucune vue agregee, aucun alerting base sur les traces d'evenements.
4. **Pas de circuit breaker inter-agents** : si un agent produit un output de mauvaise qualite (faible trust score), le pipeline continue sans degradation de pipeline.
5. **Observabilite LLM invisible** : toutes les donnees (agent_events, cost_tracking, gate_evaluations, trust_scores) existent en DB mais il n'y a pas de dashboard ni de query structure pour les exploiter en temps reel.

### Actifs reutilisables

- `agent-events.ts` : base d'event sourcing exploitable pour tracing LLM-Ops
- `trust-scores.ts` : mecanisme de confiance par role → proxy pour qualite continue
- `gate-evaluator.ts` + `adversarial-verifier.ts` : evaluation automatique deja en place
- `feedback-loop.ts` : apprentissage double-boucle → base pour prompt improvement
- `heartbeat.ts` : pattern d'agent autonome periodique → modele pour un daemon LLM-Ops
- `cost-tracking.ts` : attribution cout existante → extensible au niveau span

---

## Section 4 — Matrice d'Alternatives

| Critere | A: Status Quo | B: Agent LLM-Ops dans le pipeline | C: Module LLM-Ops transversal | D: Daemon LLM-Ops (heartbeat pattern) |
|---------|:------------:|:---------------------------------:|:-----------------------------:|:--------------------------------------:|
| **Complexite** (obligatoire) | S | L | M | M |
| **Valeur ajoutee** (obligatoire) | Low | Med | High | High |
| **Risque technique** (obligatoire) | Low | High | Low | Low |
| *Impact maintenance future* | Statu quo | Eleve (9e role, 9e YAML, +1 step pipeline) | Faible (module interne, pas d'interface publique) | Faible (service isole, pas de couplage) |
| *Reversibilite* | N/A | Difficile (integre dans les sequences de pipeline) | Facile (module interne remplacable) | Facile (service PM2 on/off) |

### Discussion par option

**A — Status quo.**
Le systeme actuel a toutes les briques separees (agent-events, trust-scores, cost-tracking, gate-evaluator) mais sans cohesion. La valeur LLM-Ops est presente mais fragmentee et non exploitable facilement. C'est le risque de "degradation silencieuse" identifie dans l'etat de l'art : les donnees existent mais personne ne les lit de facon systematique.

**B — Agent LLM-Ops dans le pipeline.**
L'idee d'un 9e role BMad qui s'insererait entre deux agents (ex: apres `dev`, avant `qa`) pour evaluer la qualite LLM de l'output est techniquement possible mais architecturalement problematique. Cela ajoute +1 step sequentiel, +1 cout LLM, +1 point de defaillance dans un pipeline deja long. Surtout : l'industrie converge vers le principe inverse — garder l'evaluation LLM-Ops hors du chemin critique et deterministe. Un agent LLM-Ops dans le pipeline serait redondant avec `gate-evaluator.ts` qui fait deja de l'evaluation rubric.

**C — Module LLM-Ops transversal.**
Creer `src/llm-ops.ts` : un module interne (non-agent) qui centralise les responsabilites fragmentees. Il exposerait : (1) tracing structure depuis agent-events, (2) attribution cout au niveau span, (3) prompt versioning query-able en DB, (4) circuit-breaker pipeline base sur trust scores, (5) aggregation observabilite pour /monitor. Complexite M, valeur High, risque Low. C'est l'option la plus alignee avec l'etat de l'art.

**D — Daemon LLM-Ops (pattern heartbeat).**
Creer un service PM2 `claude-llmops` (analogue a `claude-heartbeat`) qui tourne periodiquement, aggrège les metriques, detecte les degradations de prompts, envoie des alertes. Pas dans le chemin critique du pipeline. Complementaire a l'option C plutot que concurrent. Complexite M, valeur High, risque Low.

---

## Section 5 — Verdict et Justification

**Verdict : PIVOT**

La question posee — "faut-il un agent specialise LLM-Ops dans le pipeline ?" — est mal posee. L'exploration montre que la reponse est non pour un agent dans le pipeline, mais oui pour une refactorisation LLM-Ops sous forme de module transversal + daemon.

**Justification :**

1. **L'industrie converge contre les agents dans le chemin critique LLM-Ops** (axe 1 : ZenML 2025, 1200 deployments). Les gardes-fous fiables sont en code, pas en prompts. Un 9e agent BMad pour "surveiller" les autres agents via LLM rajouterait exactement le non-determinisme que LLM-Ops cherche a eliminer.

2. **Le codebase a toutes les briques mais pas la cohesion** (axe 2). `agent-events.ts` fait de l'event sourcing complet mais rien ne l'exploite systematiquement. `trust-scores.ts` mesure la qualite continue mais ne declanche pas de circuit-breaker. `cost-tracking.ts` manque de granularite span-level. Ces lacunes sont reelles mais ne necessitent pas d'agent — elles necessitent un module transversal bien concu.

3. **La valeur LLM-Ops est identifiee et bornee** (axes 1 + 3) : prompt versioning en DB, circuit-breaker pipeline base sur trust scores, attribution cout span-level, agregation `/monitor`. Ce sont des fonctions deterministes qui appartiennent a de l'infrastructure, pas a un agent de raisonnement.

4. **Le pattern heartbeat est deja prouve** (axe 2 : `heartbeat.ts`). Plutot qu'un agent dans le pipeline, un daemon periodique LLM-Ops (option D) serait coherent avec l'architecture existante, reversible, et non-bloquant.

**Direction recommandee pour le PIVOT :** explorer l'option "Module LLM-Ops transversal + Daemon LLM-Ops" comme refactorisation ciblée (deux livrables distincts) plutot qu'un nouvel agent.

---

## Section 6 — Input pour Etape Suivante

Le verdict etant PIVOT, voici la direction alternative a explorer :

### Direction : Refactorisation LLM-Ops en deux livrables

**Livrable 1 — `src/llm-ops.ts` (module transversal)**

Responsabilites :
- **Prompt versioning** : table `prompt_versions` en Supabase, query par role + date, tracking des changements de feedback-rules
- **Circuit-breaker pipeline** : si `trust_score < seuil_critique` pour un role apres un gate failure, downgrader automatiquement le pipeline (ex: DEFAULT → LIGHT) ou notifier avant de continuer
- **Attribution cout span-level** : etendre `cost-tracking.ts` pour logguer chaque appel LLM individuel avec son gate/step parent, pas seulement l'agent global
- **Agregation observabilite** : API interne pour `/monitor` — fournir latence par agent, taux de reussite gate, evolution trust scores, top-5 prompts les plus couteux

**Livrable 2 — Daemon `claude-llmops` (service PM2)**

Responsabilites :
- Periode : toutes les 30min (moins frequent que heartbeat)
- Detecte : degradation de trust scores (-10+ en 24h sur un role), prompt drift (output quality drop apres changement YAML), anomalies de cout (cost spike >2x moyenne)
- Actions : notifie sur Telegram + cree une tache de diagnostic automatiquement

### Raisons du PIVOT

- L'option "agent dans le pipeline" est architecturalement incorrecte pour le domaine LLM-Ops (infrastructure over prompts)
- Les livrables identifies sont concrets, bornables en spec formelle, sans risk de sur-ingenierie
- Le module transversal est le seul chemin pour resoudre les 5 points de friction identifies (granularite cout, prompt versioning, agent-events sous-exploite, absence circuit-breaker, observabilite invisible)

### Questions ouvertes pour la prochaine exploration

1. Quelle est la granularite minimale utile pour le prompt versioning ? (par role ? par commande ? par sprint ?)
2. Quels seuils pour le circuit-breaker trust-score → downgrade pipeline ? (a calibrer avec les donnees existantes en DB)
3. Le daemon LLM-Ops est-il un complement ou peut-on absorber ses responsabilites dans le heartbeat existant ?
4. Schema Supabase : table `prompt_versions` vs extension de `feedback_rules` ?
