---
phase: 0-explore
generated_at: "2026-03-26T14:00:00Z"
subject: "Contexte agent enrichi : injection de donnees Supabase dans les agents SDD"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Contexte agent enrichi pour les agents SDD

## Section 1 -- Probleme

Les agents SDD (definis dans `.claude/agents/` et orchestres par `src/sdd-agents.ts`) sont executes via `spawnClaude()` avec un prompt textuel statique. Ils ne recoivent aucune donnee dynamique provenant de Supabase : ni les taches en cours du sprint, ni les metriques de velocite/rework, ni l'historique memoire (faits, objectifs, decisions), ni les evenements recents des agents precedents.

Ce manque de contexte a des consequences concretes :
- L'agent **spec-architect** genere des specs qui ne tiennent pas compte des taches existantes (risque de doublons ou d'incompatibilites)
- L'agent **explorer** ne sait pas quels patterns ont deja ete explores recemment
- Les agents **challenge** (devils-advocate, edge-case-hunter, simplicity-skeptic) ne peuvent pas evaluer l'impact sur les taches en cours ou la dette technique connue
- L'agent **implementer** ne connait pas la velocite du sprint ni les contraintes budgetaires
- L'agent **reviewer** ne peut pas verifier la coherence avec les decisions architecturales passees

Le MCP memory server (`mcp/memory-server.ts`) expose deja un outil `get_project_context` qui agrege faits, objectifs, sprint summary et taches recentes. Mais ce contexte n'est jamais injecte dans les prompts des agents SDD.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Article technique officiel | 2026-03-26 | Hierarchie a 3 couches (persistent / time-sensitive / transient), just-in-time retrieval, compaction, notes structurees, sous-agents specialises retournant des resumes condenses | Forte |
| 2 | [Claude Code Docs — Create custom subagents](https://code.claude.com/docs/en/sub-agents) | Documentation officielle | 2026-03-26 | Les subagents recoivent uniquement le system prompt + env basique. Champ `skills` pour injecter du contenu, champ `mcpServers` pour brancher des serveurs MCP, `--append-system-prompt` pour enrichir le prompt CLI | Forte |
| 3 | [Context Engineering: A Complete Guide](https://codeconductor.ai/blog/context-engineering) | Blog technique | 2026-03-26 | Multi-layer context (identity/policy, time-sensitive data, transient state), external memory retrieval, hierarchique (summary first, context second, task last) | Moyenne |

### Synthese des enseignements cles

**Architecture a couches** : Anthropic recommande 3 couches de contexte — persistante (identite, politique), sensible au temps (donnees fraiches), et transitoire (etat conversationnel). Notre cas d'usage mappe directement : le profil agent (.md) est la couche persistante, les donnees Supabase (taches, metriques, memoire) sont la couche time-sensitive, et le handoff conversationnel est la couche transitoire.

**Just-in-time vs pre-loading** : La documentation Anthropic recommande un hybride — pre-charger les donnees critiques pour la vitesse, tout en permettant la decouverte autonome pour le reste. Pour nos agents SDD, le pre-loading est plus adapte car les agents sont spawnes en one-shot (pas de dialogue interactif avec Supabase).

**Budget de contexte** : Les donnees injectees doivent etre compactes. Anthropic insiste sur "the smallest set of high-signal tokens". Un bloc de contexte Supabase ne devrait pas depasser 1000-1500 tokens pour laisser de la place au prompt metier de l'agent.

**MCP vs injection directe** : La documentation Claude Code montre que les subagents supportent `mcpServers` pour brancher des serveurs MCP directement. Cependant, nos agents sont spawnes via `spawnClaude()` (CLI), pas comme des subagents natifs Claude Code. L'injection dans le prompt via `--append-system-prompt` est la voie la plus directe et testable.

**Skills injection** : Le champ `skills` des subagents injecte du contenu statique. Pour du contenu dynamique (donnees Supabase), l'injection dans le prompt reste la solution la plus flexible.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/sdd-agents.ts` (580 LOC) | 6 fonctions `runSdd*` construisent chacune un prompt statique. Seul `runSddSpec` recoit un `HandoffSummary`. Toutes recoivent `bctx: BotContext` (sauf explore) qui donne acces a `bctx.supabase` | Modification directe — point d'injection principal |
| 2 | `src/agent.ts` — `spawnClaude()` | Flag `--append-system-prompt` pour injecter du contexte systeme. Le prompt est passe via `-p`. Les deux sont des vecteurs d'injection | Aucune modification necessaire — API deja suffisante |
| 3 | `src/bot-context.ts` — `BotContext` | Interface partagee contenant `supabase: SupabaseClient \| null`. Deja passe a la plupart des `runSdd*` | Reutilisable tel quel |
| 4 | `src/conversation-handoff.ts` | Pattern existant : `assembleHandoffContext()` + `formatHandoffForAgent()` transforment des messages en bloc texte injectable. Seul utilise pour la phase spec | Pattern a generaliser |
| 5 | `mcp/memory-server.ts` — `get_project_context` | Outil MCP qui agrege facts, goals, sprint_summary, recent_tasks via Supabase REST. Code d'assemblage deja ecrit (lignes 189-241) | Logique a extraire/dupliquer cote relay |
| 6 | `src/memory/core.ts` — `getMemoryContext()` | Fonction existante qui recupere faits + objectifs depuis Supabase et les formate en texte. Utilisee dans `zz-messages.ts` pour le prompt conversationnel | Directement reutilisable |
| 7 | `src/tasks.ts` — `getBacklog()`, `getSprintSummary()`, `getCurrentSprint()` | Fonctions CRUD existantes pour les taches et sprint. Deja utilisees par le MCP server | Directement reutilisables |
| 8 | `src/llm-ops.ts` — `getSprintCostSummary()` | Cout et budget du sprint courant. Pertinent pour l'agent implementer (budget awareness) | Optionnel, valeur ajoutee |
| 9 | `src/memory/agent-memory.ts` — `getAgentMemories()` | Memoire specifique par role d'agent. Pourrait injecter les apprentissages passes du meme role | Valeur ajoutee forte |
| 10 | `src/prompt-overlay.ts` — `buildEnrichedPrompt()` | Mecanisme existant d'enrichissement de prompt par role. Pattern a suivre pour l'injection de contexte | Pattern de reference |
| 11 | `src/commands/sdd-flow.ts` (L260-272) | Point d'appel des `runSdd*`. La phase spec appelle deja `getRecentMessages()` pour le handoff. Les autres phases n'appellent rien de Supabase | Point d'integration secondaire |
| 12 | `src/pipeline-tracker.ts` | Tracker de l'etat du pipeline SDD. Pourrait fournir le contexte "ou en est-on dans le pipeline" a chaque agent | Optionnel, valeur ajoutee |

### Points de friction

1. **Performance** : Chaque appel Supabase ajoute de la latence avant le spawn de l'agent. Il faut paralliser les requetes (`Promise.all`) et imposer un timeout court (3-5s) avec fallback gracieux.
2. **Taille du contexte** : Le system prompt des agents est deja consequent (~2000-4000 tokens). Il faut limiter le bloc de contexte injecte a ~1000-1500 tokens maximum.
3. **runSddExplore n'a pas bctx** : La fonction `runSddExplore` ne recoit pas de `BotContext`, donc pas d'acces direct a Supabase. Il faudra soit lui passer `bctx`, soit passer le contexte deja assemble.
4. **Tests** : Le module `sdd-agents.ts` utilise des hooks injectables (`_writeFileHook`, `_spawnSyncHook`, etc.) pour le testing. Le nouveau code de recuperation Supabase devra suivre le meme pattern.

### Actifs reutilisables

- `getMemoryContext(supabase)` : retourne deja un bloc texte "Faits connus" + "Objectifs actifs"
- `getSprintSummary(supabase, sprintId)` : retourne `{total, backlog, in_progress, review, done}`
- `getCurrentSprint(supabase)` : retourne le sprint actif
- `getBacklog(supabase)` : retourne les taches actives
- `getAgentMemories(supabase, role)` : retourne les memoires specifiques a un role d'agent
- `assembleHandoffContext()` / `formatHandoffForAgent()` : pattern de formatage texte pour injection prompt
- `buildEnrichedPrompt()` : pattern d'enrichissement de system prompt
- Les test hooks de `sdd-agents.ts` : pattern a reproduire pour le nouveau code

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Injection prompt (pre-fetch + formatage) | C: MCP Server aux agents | D: Fichier contexte pre-genere |
|---------|:------------:|:-------------------------------------------:|:------------------------:|:-----------------------------:|
| **Complexite** (obligatoire) | S | M | L | M |
| **Valeur ajoutee** (obligatoire) | Low | High | High | Med |
| **Risque technique** (obligatoire) | Low | Low | High | Med |
| *Impact maintenance* | Aucun | Faible — module isole | Fort — config MCP + sync | Moyen — lifecycle fichier |
| *Reversibilite* | N/A | Haute — supprimer le bloc suffit | Faible — infrastructure MCP | Haute — supprimer le fichier |

### Discussion des options

**A: Status quo** — Les agents continuent de travailler sans contexte Supabase. Pas de risque, pas de cout, mais la qualite des outputs reste limitee par le manque de contexte projet. Les agents ne peuvent pas prendre de decisions informees par l'etat reel du projet.

**B: Injection prompt (pre-fetch + formatage)** — Creer un module `src/agent-context.ts` qui expose une fonction `buildAgentContext(supabase, role, phase)`. Cette fonction recupere en parallele (Promise.all avec timeout) : memoire contextuelle, sprint summary, taches en cours, et agent memories. Elle formate le tout en un bloc texte compact (<1500 tokens) injecte dans le prompt via `--append-system-prompt`. Chaque `runSdd*` appelle cette fonction avant `spawnClaude()`. Avantages : reutilise les fonctions Supabase existantes, testable via hooks, reversible, pas de changement d'infrastructure. Inconvenient mineur : ajout de latence (attenuee par parallelisation + timeout).

**C: MCP Server aux agents** — Brancher le MCP memory server sur chaque agent spawn via le flag CLI ou la config subagent `mcpServers`. Les agents pourraient alors utiliser les outils MCP (`get_tasks`, `get_project_context`, etc.) pour decouvrir le contexte eux-memes. Avantages : contexte a la demande, pas de pre-fetch. Inconvenients : les agents SDD sont spawnes en one-shot via `spawnClaude()` CLI, pas comme des subagents natifs — brancher un MCP server stdio dans ce contexte est complexe et fragile. Necessite de modifier l'interface `spawnClaude()` pour supporter les MCP servers. Risque de surconsommation de tokens si l'agent fait trop de requetes MCP.

**D: Fichier contexte pre-genere** — Avant chaque spawn, generer un fichier temporaire `context-{name}.json` contenant les donnees Supabase, et dire a l'agent de le lire. Avantages : separation claire. Inconvenients : gestion du lifecycle du fichier (creation, nettoyage), l'agent doit savoir le lire (instruction supplementaire), moins direct que l'injection prompt, risque de fichiers orphelins.

## Section 5 -- Verdict et justification

**Verdict : GO** — avec l'option B (injection prompt pre-fetch + formatage).

Justification :
1. **Alignement avec les best practices** (Axe 1) : L'approche par injection directe suit la recommandation Anthropic de "pre-load critical data for speed" dans un contexte d'agents one-shot. La structure a couches (system prompt agent = persistent, contexte Supabase = time-sensitive, handoff = transient) est exactement le pattern recommande.

2. **Reutilisation massive du code existant** (Axe 2) : Les fonctions `getMemoryContext()`, `getSprintSummary()`, `getCurrentSprint()`, `getBacklog()`, `getAgentMemories()` sont deja implementees et testees. Le pattern `formatHandoffForAgent()` montre exactement comment formater du contexte pour injection. Le pattern `buildEnrichedPrompt()` montre comment enrichir un prompt sans modifier les fichiers agents. Le cout d'implementation est donc faible.

3. **Meilleur rapport complexite/valeur** (Axe 3) : L'option B est la seule a combiner complexite M, valeur High, risque Low, et haute reversibilite. L'option C (MCP) serait plus elegante conceptuellement mais implique un risque technique nettement plus eleve pour un gain marginal. L'option D n'offre pas d'avantage clair sur B.

4. **Compatibilite avec l'existant** : Le module `sdd-agents.ts` utilise deja des patterns d'injection (hooks de test, `enrichPrompt()`). Ajouter un appel `buildAgentContext()` avant chaque `spawnClaude()` est une extension naturelle du code existant.

## Section 6 -- Input pour etape suivante

### Option recommandee : B — Module `agent-context.ts`

**Fichiers concernes :**
- `src/agent-context.ts` — **nouveau** — module de construction de contexte agent
- `src/sdd-agents.ts` — **modifier** — appeler `buildAgentContext()` dans chaque `runSdd*`
- `tests/unit/agent-context.test.ts` — **nouveau** — tests unitaires

**Contraintes identifiees :**
- Budget de tokens : le bloc de contexte injecte ne doit pas depasser ~1500 tokens (~6000 caracteres)
- Latence : timeout de 3-5 secondes sur les requetes Supabase, fallback gracieux (contexte vide)
- `runSddExplore` : necessite de recevoir `supabase` en parametre (ou le contexte pre-assemble)
- Pattern de test : utiliser des hooks injectables comme le reste de `sdd-agents.ts`
- Coding standard S6 : le nouveau module doit utiliser `createLogger`
- Coding standard S2 : pas de `process.env` direct

**Questions ouvertes a resoudre pendant la spec :**
1. Quelles donnees exactes par phase ? (ex: l'explorer n'a pas besoin des metriques de cout, mais le reviewer a besoin des decisions architecturales)
2. Faut-il un feature flag `agent_context_injection` pour pouvoir desactiver si probleme de performance ?
3. Le contexte doit-il etre injecte dans le `systemPrompt` (via `--append-system-prompt`) ou dans le `prompt` (via `-p`) ? Le system prompt est plus semantiquement correct mais le prompt est plus visible pour le debug.
4. Faut-il aussi injecter l'etat du pipeline SDD (via `pipeline-tracker.ts`) pour que chaque agent sache ou en est le pipeline ?

**Input pour spec :**
```
Module: src/agent-context.ts
Fonction principale: buildAgentContext(supabase, role, phase, options?)
Retour: string (bloc texte formate, <1500 tokens)
Donnees sources: getMemoryContext, getSprintSummary, getCurrentSprint, getBacklog, getAgentMemories
Pattern: parallelisation Promise.all + timeout 3-5s + fallback ""
Integration: appel dans chaque runSdd* de sdd-agents.ts, injection via systemPrompt
Tests: hooks injectables, mock Supabase
Exploration: docs/explorations/EXPLORE-contexte-agent-enrichi-s40.md
```
