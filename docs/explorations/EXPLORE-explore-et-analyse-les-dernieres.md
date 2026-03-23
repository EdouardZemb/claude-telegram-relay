---
phase: 0-explore
generated_at: "2026-03-23T14:30:00Z"
subject: "Gestion de la memoire dans les systemes multi-agent : etat de l'art vs configuration actuelle"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Gestion de la memoire dans les systemes multi-agent

## Section 1 -- Probleme

Le systeme Claude Telegram Relay orchestre 8 agents BMad specialises (analyst, pm, architect, dev, qa, sm, verifier, evaluator) via des pipelines sequentiels. Chaque agent dispose d'un contexte memoire assemble dynamiquement (`agent-context.ts`), d'un espace de travail partage (`blackboard.ts`), et d'un systeme de memoire persistante avec liens semantiques (`memory.ts`).

Cependant, le domaine de la memoire pour systemes multi-agent LLM evolue rapidement (2025-2026). Plusieurs frameworks et papiers academiques proposent des architectures de memoire significativement differentes de notre approche actuelle. Cette exploration vise a identifier les innovations pertinentes et a evaluer si des ameliorations structurelles de notre gestion memoire apporteraient une valeur significative.

Les questions cles sont :
- Notre architecture memoire est-elle competitive par rapport a l'etat de l'art ?
- Quels patterns emergents dans les frameworks (LangGraph, CrewAI, AutoGen) et la recherche academique pourraient enrichir notre systeme ?
- Notre modele de partage memoire inter-agents via le blackboard est-il optimal, ou des alternatives offriraient-elles de meilleurs resultats ?

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [AI Agent Memory: Comparative Analysis LangGraph, CrewAI, AutoGen](https://dev.to/foxgem/ai-agent-memory-a-comparative-analysis-of-langgraph-crewai-and-autogen-31dp) | Article technique | 2025 | Comparatif des architectures memoire des 3 frameworks majeurs : LangGraph (flexible, vector DB), CrewAI (structure, 5 types memoire dont entity/contextual/user), AutoGen (message-centric, leger) | Haute |
| 2 | [A-MEM: Agentic Memory for LLM Agents (arXiv:2502.12110)](https://arxiv.org/abs/2502.12110) | Papier academique | 2025-02 | Systeme de memoire agentique inspire du Zettelkasten : indexation dynamique, liens entre memoires, organisation autonome avec mots-cles/tags structures. Chaque memoire genere des attributs structures et evolue quand de nouvelles informations arrivent | Haute |
| 3 | [Collaborative Memory: Multi-User Memory Sharing with Dynamic Access Control (arXiv:2505.18279)](https://arxiv.org/html/2505.18279v1) | Papier academique | 2025-05 | Framework a deux niveaux (memoire privee/partagee) avec controle d'acces dynamique via graphes bipartis temporels. Reduction de 61% de l'utilisation de ressources avec partage. Provenance immuable par fragment | Haute |
| 4 | [MemAgents: ICLR 2026 Workshop on Memory for LLM-Based Agentic Systems](https://openreview.net/forum?id=U51WxL382H) | Workshop academique | 2026 | Workshop ICLR dedie a la memoire pour systemes agentiques. Distinction memoire en-weights (statique) vs memoire agent (en ligne, pilotee par interaction) | Moyenne |
| 5 | [Intrinsic Memory Agents: Heterogeneous Multi-Agent LLM Systems](https://arxiv.org/abs/2508.08997) | Papier academique | 2025-08 | Memoire intrinseque par agent : memoire specifique au role qui evolue avec les outputs de l'agent. Preserve les perspectives specialisees et la coherence role-memoire | Haute |

### Synthese des enseignements cles

**1. Taxonomie des memoires multi-agent**

L'etat de l'art converge vers une taxonomie en 4-5 types de memoire complementaires :
- **Short-term/Working memory** : contexte de la conversation ou du pipeline en cours
- **Long-term/Episodic memory** : memoire persistante des experiences passees
- **Semantic memory** : faits, connaissances structurees, graphe de connaissances
- **Entity memory** : suivi des entites specifiques (personnes, modules, concepts)
- **Procedural memory** : patterns d'action appris (quand faire X, comment faire Y)

Notre systeme couvre principalement les 3 premiers types (working memory via blackboard, long-term via archivage, semantic via liens et embeddings) mais manque de memoire entite et procedurale explicites.

**2. Organisation autonome vs structuree**

A-MEM propose un changement de paradigme : au lieu de structures de memoire predefinies, l'agent organise lui-meme ses memoires via un systeme inspire du Zettelkasten. Chaque nouveau souvenir genere automatiquement des attributs (description contextuelle, mots-cles, tags) et cherche des connexions avec les memoires existantes. Notre systeme fait deja du linking semantique automatique (S36-01) mais avec une structure plus rigide (4 types de liens fixes : related, extends, supports, contradicts).

**3. Memoire privee vs partagee**

Le papier Collaborative Memory introduit la distinction formelle entre memoire privee (specifique a un agent) et memoire partagee (accessible a plusieurs agents). Notre blackboard est un espace partage, mais tous les agents ont acces a la meme memoire persistante (via `memory.ts`). Il n'y a pas de notion de memoire specifique a un role d'agent. Les Intrinsic Memory Agents montrent que la memoire specifique au role preserve mieux les perspectives specialisees.

**4. Memoire intrinseque et evolution**

L'approche "Intrinsic Memory Agents" propose que chaque agent maintienne une memoire qui evolue avec ses propres outputs, preservant sa perspective specialisee. Cela contraste avec notre approche ou tous les agents partagent le meme pool de memoire. L'avantage est de maintenir des perspectives distinctes (l'architecte retient des patterns architecturaux, le QA retient des patterns de bugs).

**5. Patterns de convergence dans les frameworks**

CrewAI se demarque avec 5 types de memoire structures et un systeme d'"Agentic RAG" qui combine raisonnement agent et retrieval. LangGraph mise sur la flexibilite et le state management precis avec reducers pour merge concurrent. AutoGen reste minimaliste avec un modele message-centric.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/memory.ts` (1600+ lignes) | Module central : importance scoring avec decroissance temporelle, liens semantiques (4 types), chaines multi-hop (BFS), clustering par composantes connexes, resolution de conflits (skip/update/merge), promotion working memory, pipeline d'idees | Coeur du systeme, modification majeure |
| 2 | `src/blackboard.ts` (~640 lignes) | Espace partage pipeline : sections typees (spec, plan, tasks, implementation, verification, working_memory, messages), verrouillage optimiste, autorisations par role, retry concurrent, merge fan-in | Impact moyen : extension possible sans refonte |
| 3 | `src/agent-context.ts` (~460 lignes) | Assemblage contexte agent : fetches paralleles (memoire, sprint, taches, profil, graphe code, trust scores, metriques, documents, taches similaires), budget tokens par role, shares prioritaires | Impact fort : point d'injection pour memoire role-specifique |
| 4 | `src/agent-messaging.ts` | Messagerie inter-agents via blackboard : messages structures (directive, question, observation, warning, escalation), detection de conflits, clarification protocol | Impact moyen : pourrait devenir un canal de memoire |
| 5 | `src/orchestrator.ts` | Orchestrateur multi-agent : passe le contexte memoire a chaque agent, promotion working memory en fin de pipeline (feature flag `memory_promotion`) | Impact moyen : point d'integration |
| 6 | `src/document-sharding.ts` | Cache contextuel : decoupe les documents en shards indexes, charge uniquement les shards pertinents (avec cache TTL 5min) | Impact faible : pattern reutilisable |
| 7 | `config/features.json` | Feature flags : `memory_promotion` recemment active (true) | Controle de deploiement |
| 8 | `db/schema.sql` | Tables : `memory`, `memory_archive`, `memory_links` ; RPCs : `get_facts`, `get_active_goals`, `match_memory`, `archive_old_memories`, `bump_memory_access`, `get_linked_memories`, `link_memory` | Schema a etendre |
| 9 | `src/feedback-loop.ts` | Double-loop learning : analyse retro + gates -> enrichissement prompts agents | Pattern de memoire procedurale embryonnaire |
| 10 | `src/trust-scores.ts` | Scores de confiance par role avec tracking historique | Forme primitive de memoire agent-specifique |

### Points de friction identifies

1. **Memoire indifferenciee par role** : tous les agents accedent au meme pool de faits/objectifs via `getMemoryContext()` ou `buildMemoryChains()`. L'architecte voit les memes faits que le dev. Le seul ajustement est le volume (budget tokens par role) et la profondeur (chaines pour roles strategiques, faits plats pour roles tactiques).

2. **Pas de memoire episodique formelle** : les agents n'ont pas acces a l'historique de leurs propres executions passees. Les `agent_events` existent mais ne sont pas injectes dans le contexte des agents.

3. **Working memory ephemere** : le blackboard working_memory est detruit en fin de pipeline. La promotion ne conserve que les decisions et decouvertes, pas les "lecons apprises" proceduales.

4. **Pas d'entity tracking** : aucun suivi formel des entites mentionnees a travers les conversations et pipelines (modules, concepts, personnes).

### Actifs reutilisables

1. **Infrastructure de liens semantiques** (`memory_links`, `get_linked_memories` RPC, `classifyLinkContent`) — extensible pour des types de liens supplementaires.
2. **System d'embeddings** (Edge Function `embed` + `search`) — reutilisable pour tout nouveau type de memoire.
3. **Blackboard avec verrouillage optimiste** — pattern solide pour tout nouveau stockage partage.
4. **Pipeline de resolution de conflits** (duplicate/contradiction/complement) — reutilisable.
5. **Feature flags** — deploiement progressif de nouvelles fonctionnalites memoire.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Memoire role-specifique | C: Memoire agentique (A-MEM) | D: Memoire hybride (role + agentique) |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | L | L |
| **Valeur ajoutee** (obligatoire) | Low | High | Med | High |
| **Risque technique** (obligatoire) | Low | Low | High | Med |
| *Impact maintenance* | Nul | Faible (1 table, 1 RPC) | Eleve (refonte memory.ts) | Moyen |
| *Reversibilite* | N/A | Haute (feature flag) | Faible | Moyenne |

### Discussion des options

**A: Status quo** — La configuration actuelle fonctionne et couvre les besoins de base. Les liens semantiques, le clustering, et la promotion working memory sont des avancees recentes (S36-S41). Cependant, l'absence de memoire role-specifique signifie que les agents strategiques (architecte, analyste) n'accumulent pas de perspective propre au fil des sprints, et les lecons apprises sont perdues.

**B: Memoire role-specifique** — Ajouter une couche de memoire filtree par role d'agent, inspiree des Intrinsic Memory Agents et de CrewAI. Concretement : une colonne `agent_role` dans la table `memory` ou une table `agent_memory` separee, avec injection dans le contexte via `buildAgentContext()`. L'architecte accumulerait des patterns architecturaux, le QA des patterns de bugs recurrents, le PM des patterns de planification. Complexite moderee car l'infrastructure (embeddings, liens, resolution de conflits) existe deja. Valeur ajoutee elevee car les agents strategiques beneficieraient d'une memoire contextuelle a leur role.

**C: Memoire agentique complete (A-MEM)** — Refondre le systeme memoire pour permettre aux agents d'organiser eux-memes leurs memoires via un systeme Zettelkasten. Chaque insertion genererait automatiquement des attributs structures, et les liens seraient crees par l'agent plutot que par similarite cosinus. Valeur ajoutee theorique elevee mais complexite d'implementation importante : il faudrait refactorer `memory.ts` en profondeur, ajouter un LLM call a chaque insertion memoire (cout), et le benefice marginal sur notre systeme de liens existant est incertain.

**D: Memoire hybride (role + agentique)** — Combiner B et une version allegee de C. Memoire role-specifique avec auto-organisation limitee : les agents annotent leurs memoires avec des tags structures (sans LLM call systematique), et les liens inter-memoires sont enrichis par le contexte du role. Cette option offre le meilleur rapport cout/benefice a moyen terme mais represente un effort de developpement significatif.

## Section 5 -- Verdict et justification

**Verdict : GO** — avec l'option B (memoire role-specifique) comme premiere etape.

Justification :

1. **Gap confirme par l'etat de l'art** : les 3 sources principales (Intrinsic Memory Agents, Collaborative Memory, comparatif frameworks) convergent sur le fait que la memoire differenciee par agent/role est un pattern etabli et a forte valeur ajoutee. CrewAI l'integre nativement, et les papiers academiques demontrent que la preservation des perspectives specialisees ameliore la qualite des outputs multi-agent.

2. **Infrastructure existante favorable** : notre systeme possede deja les fondations (embeddings, liens semantiques, resolution de conflits, promotion working memory, feature flags). L'ajout d'une memoire role-specifique ne necessite qu'une extension du schema et de l'assemblage contexte — pas une refonte.

3. **ROI clair** : les agents strategiques (architecte, QA) qui s'executent frequemment accumuleraient une expertise specifique au fil des sprints. L'architecte retiendrait les patterns d'architecture valides, le QA les patterns de bugs recurrents, enrichissant leurs futures evaluations. L'option C (A-MEM) est trop couteuse en effort et en LLM calls pour un benefice marginal incertain sur notre systeme de liens deja fonctionnel.

4. **Risque maitrise** : l'option B est deployable progressivement via feature flag, reversible, et ne casse aucune API existante. L'impact sur la maintenance est faible (1 nouvelle table ou colonne, 1 RPC).

5. **Alignement avec la roadmap** : cette amelioration s'inscrit dans la trajectoire S40-S43 (agent context, memoire, autonomie) documentee dans la memoire du projet.

## Section 6 -- Input pour etape suivante

### Input pour spec (option B : memoire role-specifique)

**Perimetre** :
- Ajouter une table `agent_memory` (ou colonne `agent_role` sur `memory`) pour stocker des memoires specifiques a un role d'agent
- Modifier `buildMemoryChains()` dans `agent-context.ts` pour injecter la memoire role-specifique en complement de la memoire globale
- Modifier le pipeline de promotion working memory pour tagger les memoires promues avec le role de l'agent source
- Ajouter un RPC `get_agent_memories(p_role, p_limit)` pour recuperer les memoires specifiques a un role

**Fichiers concernes** :
- `src/memory.ts` — nouvelle fonction `saveAgentMemory()`, modification de `promoteWorkingMemory()`
- `src/agent-context.ts` — modification de `buildMemoryChains()` pour inclure la memoire role
- `src/orchestrator.ts` — alimentation de la memoire role a chaque fin d'execution d'agent
- `db/schema.sql` — nouvelle table ou colonne
- `config/features.json` — nouveau flag `agent_role_memory`

**Contraintes identifiees** :
- Budget tokens : la memoire role-specifique doit s'inserer dans le budget existant (share a definir, probablement 8-12% du budget total)
- Volume : limiter a 10-15 memoires role-specifiques par agent pour eviter la saturation
- Decroissance : appliquer la meme logique de decay temporel que les memoires globales
- Deduplication : la resolution de conflits existante doit s'appliquer aussi aux memoires role

**Questions ouvertes a resoudre pendant la spec** :
1. Table separee `agent_memory` vs colonne `agent_role` sur la table `memory` existante ? (table separee recommandee pour isolation et simplicite des requetes)
2. Les memoires role-specifiques doivent-elles avoir leurs propres embeddings, ou reutiliser le systeme d'embeddings existant ?
3. Quels types de memoire role-specifique capturer automatiquement ? (decisions architecturales, patterns de bugs, estimations vs reel, etc.)
4. Faut-il un mecanisme de "graduation" de memoire role vers memoire globale quand un pattern est confirme par plusieurs roles ?
