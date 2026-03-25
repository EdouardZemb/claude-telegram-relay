---
phase: 0-explore
generated_at: "2026-03-25T14:00:00Z"
subject: "Feedback loop prompts : boucle fermee alertes/metriques vers system prompts SDD"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Feedback Loop Prompts

Boucle fermee entre les alertes/metriques du bot (agent failures, rework rate, review scores) et les system prompts des agents SDD, via un mecanisme de prompt overlay dynamique.

## Section 1 -- Probleme

Le pipeline SDD utilise 6 agents specialises (explorer, spec-architect, devils-advocate, edge-case-hunter, simplicity-skeptic, reviewer) dont les system prompts sont definis statiquement dans `.claude/agents/*.md`. Ces fichiers sont commites dans git et ne changent qu'a la main.

Parallelement, le systeme detecte deja des anomalies operationnelles :
- `alerts.ts` : stuck tasks, rework spikes, agent failure patterns, review score drops
- `llm-ops.ts` : prompt versioning (table `prompt_versions`), cout par agent, circuit-breakers
- `agent-memory.ts` : memoire persistante par role (table `agent_memory`, max 15 entries/role)

**Le gap** : aucun mecanisme ne ferme la boucle entre "detection d'un probleme recurrent" et "ajustement du prompt de l'agent concerne". Par exemple, si le spec-architect produit des specs systematiquement rejetees NO-GO par le challenge, son system prompt devrait etre enrichi avec les patterns de rejet identifies. Aujourd'hui, cette correction est manuelle et episodique.

L'exploration est necessaire avant specification car :
1. Les contraintes sont non triviales (pas de modification des .md dans git, tracabilite, rollback)
2. Plusieurs mecanismes existants pourraient servir de fondation (agent_memory, prompt_versions, feature flags)
3. Le risque de sur-ingenierie est reel pour un systeme monolithique a usage personnel

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Nebuly — LLM Feedback Loop](https://www.nebuly.com/blog/llm-feedback-loop) | Article technique | 2025-03 | Architecture feedback loop en 3 etapes : deploiement, collecte feedback (explicite + implicite), amelioration iterative. 4 mecanismes d'ajustement : system prompts, RAG, fine-tuning, evaluation datasets. Validation par A/B testing | Haute |
| 2 | [Maxim AI — Prompt Versioning Best Practices](https://www.getmaxim.ai/articles/prompt-versioning-best-practices-for-ai-engineering-teams) | Guide pratique | 2025-06 | Semantic versioning pour prompts, rollback automatique sur degradation metriques, performance attribution (quality/operational/business metrics), distributed tracing par version | Haute |
| 3 | [AutoPDL — Automatic Prompt Optimization](https://arxiv.org/abs/2504.04365) | Papier recherche | 2025-04 | Framework AutoML pour optimisation automatique de prompts d'agents. Successive halving sur espace combinatoire de patterns agentiques. Approche meta-optimisation complete | Moyenne |
| 4 | [VLDB 2026 — Making Prompts First-Class Citizens](https://vldb.org/cidrdb/papers/2026/p26-cetintemel.pdf) | Papier academique | 2026-01 | Prompts comme citoyens de premiere classe dans les pipelines LLM adaptatifs. Architecture de gestion de prompts avec versioning, A/B testing, et metriques integrees | Moyenne |

**Synthese de l'etat de l'art :**

Le consensus 2025-2026 converge vers un pattern en 3 couches :

1. **Collecte de signal** : metriques implicites (taux de rejet, rework, echecs) plus que feedback explicite. Les systemes les plus efficaces combinent les deux mais le signal implicite est 100x plus abondant.

2. **Prompt overlay plutot que mutation** : les plateformes matures (PromptLayer, Langfuse, Maxim) separent le "template de base" (commite, stable) du "suffix dynamique" (genere par le systeme, versionne en DB). Cela permet le rollback sans toucher au code source.

3. **Validation avant activation** : le pattern recommande est de generer le suffix, le valider (regression testing ou A/B), puis l'activer. Les systemes sans validation produisent des derives (prompt drift).

L'approche AutoPDL (meta-optimisation complete) est disproportionnee pour un monolithe a usage personnel. Le pattern overlay + versioning DB est plus adapte.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/sdd-agents.ts` L112-119, L151 | `readAgentFile()` lit les `.md` et passe en `systemPrompt` a `spawnClaude()`. Point d'injection naturel pour un overlay | Eleve |
| 2 | `src/llm-ops.ts` L342-369 | `recordPromptVersion()` upsert sur `prompt_versions(agent_role, combined_hash)`. Template hash + feedback hash existent deja comme colonnes — le feedback hash est toujours vide aujourd'hui | Eleve |
| 3 | `src/llm-ops.ts` L374-403 | `getActivePromptVersion()` recupere la version active par role. Infrastructure de lecture prete | Moyen |
| 4 | `src/alerts.ts` L172-273 | `checkReviewScoreDrop()` et `checkAgentFailurePatterns()` detectent deja les signaux pertinents avec type/severity/data structures | Eleve |
| 5 | `src/memory/agent-memory.ts` L97-120 | `getAgentMemories(role, limit=15)` recupere les insights par role. Pourrait fournir du contexte enrichi | Moyen |
| 6 | `src/memory/agent-memory.ts` L130-208 | `saveAgentMemory()` avec deduplication exacte, eviction par score, hard limit 15. Mecanisme de persistence pret | Moyen |
| 7 | `src/feature-flags.ts` | Feature flags fichier JSON, hot-reload. `isFeatureEnabled()` pour gating | Faible |
| 8 | `src/agent.ts` L145-232 | `spawnClaudeCore()` construit les args CLI dont `--append-system-prompt`. Le systemPrompt est un string unique — la concatenation template+overlay est triviale | Moyen |
| 9 | `db/schema.sql` L386-394 | Table `prompt_versions` avec `template_hash`, `feedback_hash`, `combined_hash`, unique sur `(agent_role, combined_hash)` | Eleve |
| 10 | `db/schema.sql` L478-493 | Table `gate_evaluations` avec `agent_role`, `gate_name`, `score`, `passed`, `rework_triggered`. Signal de qualite par gate et par agent | Eleve |
| 11 | `db/schema.sql` L203-220 | Table `workflow_logs` avec `had_rework`, `checkpoint_result`, `metadata`. Source de signal rework | Moyen |
| 12 | `src/heartbeat.ts` L596-626 | Le heartbeat execute deja `runAllChecks()` et envoie des notifications. Point d'integration naturel pour la boucle de feedback periodique | Moyen |
| 13 | `config/features.json` | 10 flags existants. Ajout de `prompt_feedback_loop` trivial | Faible |

**Points de friction :**

- Les fichiers `.claude/agents/*.md` ne doivent PAS etre modifies automatiquement (contrainte explicite). L'overlay doit etre un mecanisme separe.
- Le `systemPrompt` dans `spawnClaude()` est un string unique. La concatenation base+overlay doit etre faite AVANT l'appel, pas a l'interieur.
- La table `prompt_versions` a un schema minimal (hashes seulement). Elle ne stocke pas le contenu du suffix, juste son hash. Il faudrait soit etendre la table, soit stocker le contenu ailleurs.
- Le hard limit de 15 entries par role dans `agent_memory` pourrait etre insuffisant si on veut stocker a la fois des insights metier ET des feedback prompts. Separation des preoccupations necessaire.

**Actifs reutilisables :**

- `readAgentFile()` dans `sdd-agents.ts` : point d'injection direct. On peut le wrapper pour ajouter l'overlay.
- `recordPromptVersion()` / `getActivePromptVersion()` : infrastructure de versioning prete, le `feedback_hash` est deja prevu.
- `checkAgentFailurePatterns()` et `checkReviewScoreDrop()` : detection du signal deja implementee avec structure `Alert[]`.
- `saveAgentMemory()` / `getAgentMemories()` : persistance par role avec deduplication.
- `isFeatureEnabled()` : gating immediat.
- Le heartbeat (`pulse()`) : cron periodique ideal pour la boucle de feedback.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Overlay Supabase simple | C: Overlay agent_memory | D: Prompt compiler complet |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | S | L |
| **Valeur ajoutee** (obligatoire) | Low | High | Med | High |
| **Risque technique** (obligatoire) | Low | Low | Med | High |
| *Impact maintenance* | Nul | Faible — 1 table, 1 module | Faible — reutilise existant | Eleve — nouveau sous-systeme |
| *Reversibilite* | N/A | Haute — supprimer les overlays revient au .md de base | Haute — flag off | Moyenne — complexite a defaire |

### A: Status quo

Pas de changement. Les prompts des agents restent statiques dans `.claude/agents/*.md`. Les alertes sont generees mais pas exploitees pour ameliorer les prompts. Le developpeur corrige manuellement quand il constate un pattern de rejet recurrent.

Limite : pas de boucle d'apprentissage. Les memes erreurs se repetent jusqu'a correction manuelle.

### B: Overlay Supabase simple (recommande)

Nouvelle table `prompt_overlays` avec colonnes : `agent_role`, `overlay_text`, `trigger_type` (manual | alert | metric), `trigger_data` (JSONB avec les metriques qui ont declenche l'overlay), `active` (boolean), `created_at`, `expires_at` (TTL optionnel). Dans `sdd-agents.ts`, `readAgentFile()` est wrappe pour concatener le contenu .md avec les overlays actifs du role. Le heartbeat genere des overlays candidats quand les alertes depassent un seuil. Chaque overlay est trace (pourquoi il a ete cree), versionne (hash dans `prompt_versions`), et desactivable (flag `active` ou TTL expire).

Avantages : separation nette base/overlay, tracabilite complete, rollback par desactivation, integration naturelle avec `prompt_versions` existant.

### C: Overlay via agent_memory existant

Reutiliser la table `agent_memory` en ajoutant un tag `prompt-overlay` aux entries qui doivent enrichir le prompt. Dans `readAgentFile()`, recuperer les memories du role avec tag `prompt-overlay` et les concatener au system prompt.

Avantages : zero migration DB, reutilise l'existant.

Inconvenients : melange de preoccupations (insights metier vs overlays prompt), hard limit 15 entries par role contraint l'espace disponible, pas de TTL ni de flag `active`, pas de tracabilite du trigger.

### D: Prompt compiler complet

Systeme de compilation de prompts avec templates, variables, conditions, et pipeline de transformation. Le prompt final est assemble a partir de blocs : base (.md), context (agent_memory), overlays (alertes), instructions specifiques (task). Un moteur de regles evalue les metriques et active/desactive les blocs.

Avantages : maximum de flexibilite, separation des preoccupations complete.

Inconvenients : complexite disproportionnee pour un monolithe personnel, risque de sur-ingenierie, maintenance lourde. Le gain marginal par rapport a B est faible.

## Section 5 -- Verdict et justification

**Verdict : GO** — avec l'option B (Overlay Supabase simple).

Justification :

1. **L'infrastructure est quasi-prete** (Axe 2) : `prompt_versions` avec `feedback_hash`, `readAgentFile()` comme point d'injection, `checkAgentFailurePatterns()` / `checkReviewScoreDrop()` comme sources de signal, et le heartbeat comme moteur de la boucle. Le delta d'implementation est raisonnable.

2. **Le pattern overlay est l'etat de l'art** (Axe 1) : les plateformes matures (PromptLayer, Langfuse, Maxim) separent toutes le template de base du suffix dynamique. Le rollback sans modification du code source est une best practice etablie. Notre option B est un cas simplifie de ce pattern.

3. **La valeur est immediate et mesurable** (Axe 3) : si le spec-architect produit des specs rejetees NO-GO, un overlay "Eviter les patterns X, Y, Z identifies dans les challenges precedents" ameliore la qualite de la prochaine spec sans intervention humaine. Le signal de succes est direct : moins de NO-GO apres activation de l'overlay.

4. **Le risque est maitrise** : l'overlay est additif (concatenation au prompt de base), desactivable (flag `active`), et trace (trigger_data JSONB). En cas de regression, supprimer les overlays actifs revient au comportement d'origine.

5. **L'option C (agent_memory)** est ecartee car le melange de preoccupations et le hard limit 15 entries sont des contraintes reelles. L'option D (compiler complet) est ecartee car disproportionnee pour le contexte.

## Section 6 -- Input pour etape suivante

**Option recommandee : B — Overlay Supabase simple**

### Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `db/schema.sql` | Modifier | Ajouter table `prompt_overlays` |
| `src/sdd-agents.ts` | Modifier | Wrapper `readAgentFile()` pour concatener les overlays actifs |
| `src/llm-ops.ts` | Modifier | Ajouter fonctions CRUD pour prompt_overlays, integration avec `recordPromptVersion()` |
| `src/alerts.ts` | Modifier | Ajouter fonction `generateOverlaySuggestion()` qui transforme une alerte recurrente en overlay candidat |
| `src/heartbeat.ts` | Modifier | Ajouter etape periodique : evaluer alertes recurrentes, generer overlays candidats, activer si seuil depasse |
| `src/feature-flags.ts` | Aucune | Utiliser `isFeatureEnabled("prompt_feedback_loop")` — ajout dans `config/features.json` uniquement |
| `config/features.json` | Modifier | Ajouter flag `prompt_feedback_loop: false` (off par defaut) |

### Contraintes identifiees

1. **Pas de modification des .md** : les fichiers `.claude/agents/*.md` restent intouches. L'overlay est un suffix concatene au runtime.
2. **Feature flag** : `prompt_feedback_loop` off par defaut. Activation explicite apres validation.
3. **Tracabilite** : chaque overlay stocke dans `trigger_data` les alertes/metriques qui l'ont declenche, avec timestamp.
4. **Rollback** : desactiver un overlay = set `active = false`. Supprimer tous les overlays = retour au .md de base.
5. **TTL** : les overlays ont un `expires_at` optionnel. Le heartbeat desactive les overlays expires.
6. **Seuil d'activation** : un overlay n'est cree que si le pattern est recurrent (ex: >= 3 NO-GO du meme agent sur les 7 derniers jours). Pas de reaction a un echec isole.
7. **Generation de l'overlay** : le contenu de l'overlay est genere par un LLM (Haiku) qui recoit les alertes comme contexte et produit une instruction corrective courte. Le cout est negligeable (1 appel Haiku par overlay genere).

### Questions ouvertes a resoudre pendant la spec

1. **Granularite du signal** : faut-il agreger les alertes par type (`agent_failure_pattern`, `review_score_drop`) ou par agent_role ? Probablement par role, mais a confirmer.
2. **Limite d'overlays actifs** : combien d'overlays simultanes par role ? Suggestion : max 3 pour eviter la dilution du prompt.
3. **Validation humaine** : faut-il que l'overlay soit approuve par l'utilisateur avant activation, ou activation automatique avec notification ? Suggestion : automatique + notification (l'utilisateur peut desactiver).
4. **Metriques de succes de l'overlay** : comment mesurer si un overlay a ameliore le comportement de l'agent ? Comparer les gate_evaluations avant/apres activation.
5. **Interaction avec agent_memory** : l'overlay genere est-il aussi sauvegarde dans agent_memory pour enrichir le contexte conversationnel, ou uniquement dans prompt_overlays ? Suggestion : uniquement prompt_overlays (separation des preoccupations).
