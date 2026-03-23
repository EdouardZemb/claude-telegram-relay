---
phase: 0-explore
generated_at: "2026-03-23T08:18:00Z"
subject: "Sante du systeme de memoire permanente et integration multi-agent"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Sante du systeme de memoire permanente et integration multi-agent

## Section 1 -- Probleme

Le projet claude-telegram-relay dispose d'un systeme de memoire permanente riche, accumule sur ~15 sprints d'evolution (S15 a S44). Ce systeme comprend : une table `memory` avec embeddings vectoriels, un mecanisme d'importance scoring avec decay temporel, des liens semantiques entre memoires (memory_links), un pipeline d'idees, une detection de contradictions, une resolution de conflits (dedup/update/merge), un archivage automatique, et un systeme de memoire de travail (working_memory) dans le blackboard pour les pipelines multi-agents.

Une exploration est necessaire car :

1. **Complexite accumulee** : 1680+ lignes dans `src/memory.ts`, 8 tables/vues liees en base, 4 Edge Functions, un serveur MCP -- l'ensemble n'a jamais eu d'audit de coherence globale.
2. **Integration multi-agent incomplete** : les agents BMad recoivent du contexte memoire via `buildAgentContext()` et `buildMemoryChains()`, mais la boucle retour (working memory -> permanent memory) semble desactivee.
3. **Gap entre code et runtime** : `promoteWorkingMemory()` est defini et teste unitairement mais jamais appele par l'orchestrateur -- les decouvertes et decisions des agents pendant les pipelines sont perdues.
4. **Aucune visibilite** : il n'existe pas de metriques observables sur la sante du systeme memoire (taux de dedup, qualite des liens, ratio signal/bruit, couverture des embeddings).

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Letta Blog: Agent Memory](https://www.letta.com/blog/agent-memory) | Article technique | 2026-03 | Architecture memoire tiered (message buffer, core memory, recall memory, archival), sleep-time compute, agents qui controlent leur memoire via API tools | Haute |
| 2 | [47billion: AI Agent Memory Best Practices 2026](https://47billion.com/blog/ai-agent-memory-types-implementation-best-practices/) | Article synthese | 2026-03 | Taxonomie cognitive (short/long-term, episodic/semantic/procedural), scope-based isolation (user/agent/session), importance scoring + temporal decay, memory consolidation (+26% accuracy vs vector pur) | Haute |
| 3 | [arXiv: Multi-Agent Memory from a Computer Architecture Perspective](https://arxiv.org/html/2603.10062) | Paper | 2026-03 | Hierarchie I/O-cache-memory, deux gaps critiques: cache sharing inter-agents et controle d'acces structure a la memoire | Moyenne |
| 4 | [Mem0: Production-Ready Long-Term Memory](https://arxiv.org/pdf/2504.19413) | Paper | 2025-04 | Framework de reference pour memoire persistante avec consolidation intelligente, version control, graph-based memory | Moyenne |

**Synthese des enseignements cles :**

L'etat de l'art 2026 converge vers quatre principes fondamentaux :

**Hierarchie de memoire.** Tous les frameworks adoptent une architecture en couches : memoire de travail (in-context, ephemere), memoire core (faits stables, editable), memoire de rappel (historique searchable), memoire archivale (stockage long terme). Le projet claude-telegram-relay possede deja ces 4 couches (blackboard working_memory, memory table, messages table, memory_archive) mais elles sont faiblement couplees.

**Consolidation intelligente.** Mem0 et Letta proposent des mecanismes de promotion automatique : les decouvertes faites pendant les sessions de travail remontent vers la memoire permanente apres filtrage par importance. Le projet a `promoteWorkingMemory()` mais ne l'utilise pas -- c'est le gap le plus critique identifie.

**Scope-based isolation.** Les systemes modernes isolent les memoires par agent_id, session_id et organisation. Le projet a une isolation partielle (par project_id) mais pas par agent_id -- tous les agents partagent le meme pool memoire sans distinction de role pour l'ecriture (seule la lecture est differenciee via `buildMemoryChains` tactique vs strategique).

**Boucles d'auto-amelioration.** L'approche ACE (Generator-Reflector-Curator) montre +10.6% de gain en gardant un "playbook" executable. Le projet a un systeme de feedback rules (`feedback-loop.ts`) qui joue un role similaire mais est deconnecte du cycle memoire.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/memory.ts` (1680 lignes) | Module monolithique : intent tags, classification, conflict resolution, linking, clustering, archiving, ideas, memory chains, similar tasks -- tout dans un seul fichier | Elevee |
| 2 | `src/agent-context.ts` | Assemble le contexte memoire pour les agents via `buildMemoryChains()`. Budget tokens par role (dev:2000, analyst:4000). 10 sections en parallele. | Moyenne |
| 3 | `src/blackboard.ts` | Working memory structuree (decisions, discoveries, blockers, context_updates) avec optimistic locking. Bien concu mais sous-utilise. | Elevee |
| 4 | `src/orchestrator.ts` | Appelle `buildAgentContext()` entre chaque agent. N'appelle PAS `promoteWorkingMemory()` en fin de pipeline -- les decouvertes sont perdues. | Critique |
| 5 | `src/agent-messaging.ts` | Inter-agent messaging via blackboard. Conflict detection par Jaccard. Max 20 messages, 2000 tokens budget. Fonctionne mais pas persiste en memoire permanente. | Moyenne |
| 6 | `src/feedback-loop.ts` | Feedback rules appris des retros -> enrichissement prompts agents. Deconnecte du cycle memoire (pas de lien memory_links vers les rules). | Moyenne |
| 7 | `src/heartbeat.ts` | Appelle `archiveOldMemories()` periodiquement (hourly via heartbeat). Seul mecanisme de maintenance memoire actif. | Faible |
| 8 | `mcp/memory-server.ts` | 21 tools MCP exposant memoire, tasks, PRDs, blackboard. Passe par Edge Functions (memory-mcp) pour search/capture. | Faible |
| 9 | `supabase/functions/embed/` | Auto-embedding via webhook on INSERT (text-embedding-3-small). Trigger aussi sur `updateMemoryWithRevision` (clears embedding). | Moyenne |
| 10 | `supabase/functions/classify-thought/` | Classification GPT-4o-mini avec detection idees et actionability scoring (S36-06). Gate d'entree vers auto-remember. | Moyenne |
| 11 | `db/schema.sql` (memory, memory_links, memory_archive) | Schema complet avec RPCs (get_facts, get_active_goals, bump_memory_access, match_memory, link_memory, archive_old_memories, get_linked_memories). Bien indexe. | Faible |
| 12 | `tests/unit/memory*.test.ts` (5 fichiers, 223 tests) | Couverture solide : importance scoring, conflict resolution, linking, chains, evolution. Tous passent. | Positive |

**Points de friction identifies :**

1. **Dead code critique** : `promoteWorkingMemory()` est defini, teste, documente dans la spec S36-08 -- mais jamais branche dans le pipeline. Les decisions et decouvertes des agents (working_memory) sont perdues a chaque fin de pipeline.

2. **Monolithe memory.ts** : 1680 lignes, 35+ fonctions exportees, 6 responsabilites distinctes (CRUD, classification, linking, clustering, archival, ideas). Rend le module difficile a tester en isolation et a evoluer.

3. **Pas de metriques memoire** : aucun compteur de dedup, ratio signal/bruit, couverture embeddings, age moyen des memoires, taux de contradiction. La commande `/brain` donne un apercu qualitatif mais pas quantitatif.

4. **buildMemoryChains erreur silencieuse** : le batch fetch de linked memories logue `[object Object]` pour les erreurs (visible dans les tests) -- perte d'information de debug.

5. **Isolation agent incomplete** : tous les agents lisent/ecrivent dans la meme table memory. Un agent dev pourrait polluer la memoire strategique avec des details d'implementation bas niveau.

**Actifs reutilisables :**

- Schema memory + memory_links + memory_archive complet et bien indexe
- Pipeline conflict resolution (dedup > 0.85, contradiction > 0.80, complement > 0.75) operationnel
- buildMemoryChains avec differentiation tactique/strategique
- 223 tests unitaires memory verts
- Edge Functions embed + classify-thought fonctionnelles
- MCP server avec 21 tools prets

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Activer promotion + metriques | C: Refactoring complet + agent-scoped memory |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | L |
| **Valeur ajoutee** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | Low | Low | High |
| *Impact maintenance* | Negatif (dette croissante) | Positif (observabilite) | Positif (modularite) |
| *Reversibilite* | N/A | Haute (on/off via feature flag) | Faible (migration schema) |

**A: Status quo** -- Ne rien faire. La memoire permanente fonctionne pour les cas de base (intent tags [REMEMBER], auto-classify), mais les decouvertes pipeline sont perdues, la monolithe memory.ts continue de grossir, et il n'y a aucune visibilite sur la sante du systeme. Le risque est l'erosion progressive de la valeur de la memoire : les agents reinventent des decisions deja prises parce que le contexte ne remonte pas.

**B: Activer promotion + metriques** -- Brancher `promoteWorkingMemory()` dans l'orchestrateur en fin de pipeline (reussi ou echoue), ajouter des metriques observables (compteur dedup, age moyen, taux embeddings, ratio facts/goals/ideas), et corriger le logging d'erreur. Complexite moderee (M) car le code existe deja et est teste. Valeur ajoutee haute car (1) les decisions agents persistent enfin et (2) on a de la visibilite. Feature-flaggable pour rollback facile.

**C: Refactoring complet + agent-scoped memory** -- En plus de B, decoupe de memory.ts en sous-modules (memory-crud, memory-linking, memory-classification, memory-ideas, memory-archival), ajout d'un champ `agent_id` dans la table memory pour isolation, et implementation d'un systeme de memoire hierarchique a la Letta (core memory vs recall vs archival avec transitions explicites). Valeur ajoutee haute mais risque technique eleve : migration schema, changements dans l'orchestrateur, impact sur 38 fichiers de tests.

## Section 5 -- Verdict et justification

**Verdict : GO** -- Option B (Activer promotion + metriques)

Justification :

1. Le gap le plus critique est clairement identifie : `promoteWorkingMemory()` est du code mort (Axe 2, observation #4). L'activer est une correction a faible risque avec un impact eleve -- les agents cesseront de "perdre la memoire" entre pipelines.

2. L'etat de l'art (Axe 1) confirme que la consolidation memoire est le mecanisme differentiant des systemes de production (+26% accuracy selon Mem0). Le projet a deja l'infrastructure, il manque juste le branchement.

3. Les metriques sont indispensables pour piloter l'evolution future. Sans visibilite, on ne peut pas savoir si le systeme memoire s'ameliore ou se degrade. Le `/brain` actuel est qualitatif ; il faut du quantitatif.

4. L'option C (refactoring complet) est prematuree sans les metriques de B. On risquerait d'optimiser sans savoir quoi optimiser. B est le prerequis logique de C.

5. Le risque technique est faible : le code existe, est teste (223 tests verts), et peut etre derriere un feature flag.

## Section 6 -- Input pour etape suivante

**Option recommandee** : B -- Activer promotion working memory + metriques memoire

**Fichiers concernes** :
- `src/orchestrator.ts` -- ajouter appel `promoteWorkingMemory()` en fin de pipeline
- `src/memory.ts` -- ajouter fonctions de metriques (memoryHealthStats)
- `src/commands/quality.ts` ou `src/commands/memory-cmds.ts` -- exposer metriques via commande
- `config/feature-flags.json` -- flag `memory_promotion` (off par defaut)
- `tests/unit/memory-evolution.test.ts` -- tests integration promotion dans orchestrator

**Contraintes identifiees** :
- La promotion doit etre idempotente (conflict resolution existe deja)
- Budget token : les faits promus ne doivent pas exploser le contexte agent (respecter MAX_FACTS_IN_CONTEXT = 20)
- Le logging d'erreur `[object Object]` dans getLinkedMemoriesBatch doit etre corrige (utiliser String(error))
- Feature flag obligatoire pour rollback en cas de pollution memoire

**Questions ouvertes a resoudre pendant la spec** :
1. Faut-il promouvoir aussi les `blockers` et `context_updates` de working memory, ou seulement `decisions` et `discoveries` ?
2. Quel seuil d'importance minimum pour la promotion (eviter le bruit) ?
3. Les metriques doivent-elles etre persistees en base (sprint_metrics) ou calculees a la volee ?
4. Faut-il un mecanisme de "memory gc" plus agressif que l'archival actuel (90 jours) pour les faits promus a faible importance ?
