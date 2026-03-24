# Architecture V2 — Assistant Personnel Conversationnel avec Pipeline SDD

> Document de reference. Date : 2026-03-24.
> Resultat de l'audit architectural et de la refonte du flow utilisateur.

## Vision

Transformer le bot d'un orchestrateur SDLC rigide (34K LOC, 37 commandes, 6 pipelines) en un assistant personnel conversationnel qui delegue a Claude Code via un pipeline SDD (Specification-Driven Development) integre dans le fil de la conversation.

**Principe fondamental** : le relay recoit, assemble le contexte, et delegue. Claude Code fait le travail.

## Architecture Cible

```
Telegram (grammY)
├── Canal conversation (callClaude)     — serie, rapide, session resumee
│   └── Texte uniquement, pas d'ecriture fichier
├── Canal agents (spawnClaude)          — background, job-manager, semaphore max 3
│   └── Ecriture fichiers, git, PRs
└── Pont entre les deux                — resume structure (decisions conversation)
```

### Regle fondamentale

Le canal conversation ne produit que du texte. Tout ce qui ecrit des fichiers passe par le canal agents. Le pont entre les deux est un **resume structure** genere dans la conversation et passe comme input a l'agent.

## Flow Utilisateur Complet

### Etape 0 — Declenchement

**Cas A — Sujet clair, scope limite** (bugfix, petite evolution) :
- Intent detection detecte un sujet simple
- Boutons : [Fix direct] [Specifier d'abord]
- Pas d'exploration pour un bugfix

**Cas B — Sujet large, impact incertain** (feature, refactoring, architecture) :
- Le bot propose l'exploration
- Boutons : [Explorer] [Discuter sans explorer]

### Etape 1 — Exploration (background, 3-5 min)

**Declencheur** : bouton [Explorer] ou commande `/dev-explore`

Avant lancement, le bot extrait les contraintes deja exprimees dans la conversation via `callClaude()` (3-5s) et les injecte dans le prompt de l'explorateur.

L'agent `explorer.md` tourne en background via `spawnClaude()` :
- Axe 1 : etat de l'art externe (WebSearch, 5 requetes max, 2+ sources)
- Axe 2 : archeologie codebase (Read, Grep, Glob)
- Axe 3 : matrice d'alternatives (2-5 options, 3 criteres obligatoires)
- Verdict : GO / PIVOT / DROP
- Artefact : `docs/explorations/EXPLORE-{name}.md`

**Conversation libre pendant l'exploration.**

A la completion : resume dans le chat + status bar pipeline.

Verdicts :
- **GO** : boutons [Discuter les resultats] [Specifier]
- **PIVOT** : boutons [Re-explorer] [Discuter] — pas de bouton Specifier
- **DROP** : pas de bouton d'action — discussion uniquement

### Etape 2 — Discussion informee

**Declencheur** : bouton [Discuter les resultats] ou message libre apres exploration

Conversation normale via `callClaude()` avec resume de l'exploration en contexte. Le user discute les resultats, affine les choix, ajoute des contraintes.

**Detection de convergence** : quand la discussion stabilise, le bot resume les decisions et propose la formalisation.

Boutons : [Formaliser en spec] [Continuer]

### Etape 3 — Generation de la spec (background, 2-3 min)

**Declencheur** : bouton [Formaliser en spec]

**Etape 3a — Extraction du resume** (dans la conversation, 5-10s) :
- `callClaude()` produit un resume structure des decisions : objectif, decisions, contraintes, fichiers identifies, questions resolues, hors scope
- Ce resume est le **pont** entre la conversation (ephemere) et la spec (persistante)

**Etape 3b — Spec-architect en background** :
- Recoit : artefact d'exploration + resume des decisions conversationnelles
- Utilise `.claude/agents/spec-architect.md` avec template 9 sections obligatoire
- Fait sa propre exploration codebase complementaire (Read, Grep, Glob)
- Produit les V-criteres testables
- Sauvegarde `docs/specs/SPEC-{name}.md`

**Conversation libre pendant la generation.**

A la completion : resume (objectif, perimetre, V-criteres) + status bar.

Boutons : [Challenger] [Implementer direct] [Reviser la spec]

Si [Reviser] : le user indique ce qui manque, spec-architect relance avec feedback (max 2 revisions).

### Etape 4 — Challenge adversarial (background, 3-5 min)

**Declencheur** : bouton [Challenger] ou commande `/dev-challenge`

**3 agents en parallele** (perspectives distinctes, non fusionnes) :
- `devils-advocate.md` : contradictions internes, hypotheses non verifiees
- `edge-case-hunter.md` : crashs runtime, cas limites, perf a l'echelle
- `simplicity-skeptic.md` : sur-complexite, alternatives plus simples

Chaque agent lit la spec + fait sa propre exploration codebase. Rapport consolide et deduplique.

Artefact : `docs/reviews/adversarial-SPEC-{name}.md`

**Conversation libre pendant le challenge.**

Verdicts :
- **GO** : boutons [Implementer]
- **GO WITH CHANGES** : boutons [Implementer avec corrections] [Corriger la spec d'abord]
- **NO-GO** : boutons [Discuter les findings] [Retravailler la spec] — **pas de bouton Implementer**

### Etape 5 — Implementation (background, 5-15 min)

**Declencheur** : bouton [Implementer] ou commande `/dev-implement`

Le skill `/dev-implement` coordonne en interne 3 sous-phases via subagents Claude Code natifs :
- Phase A : Test Architect (haiku) — squelettes TDD depuis la spec + V-criteres
- Phase B : Implementer (sonnet) — code en TDD pour faire passer les tests
- Phase C : Tester (haiku) — complete avec edge cases, erreurs, robustesse
- Consolidation : `bun test` + max 2 iterations correctives

Input : spec + review adversariale (l'implementeur tient compte des findings).
Artefact : `docs/reviews/implement-{name}.md`
Git : feature branch + commit + PR

**Conversation libre pendant l'implementation.**

A la completion : resume (PR, diff stats, tests) + status bar.

Boutons : [Review] [Merger] [Corriger]

### Etape 6 — Review et merge (optionnel)

- **[Review]** : lance `reviewer.md` en background, rapport dans le chat
- **[Merger]** : merge le PR (avec confirmation)
- **[Corriger]** : le user decrit le probleme, relance l'implementeur avec feedback

## Status Bar Pipeline

Affiche apres chaque etape pour situer l'avancement :

```
Pipeline « refactoring-memoire »
  OK Exploration (GO) — EXPLORE-refactoring-memoire.md
  OK Discussion — 5 decisions capturees
  OK Spec (14 V-criteres) — SPEC-refactoring-memoire.md
  EN COURS Challenge — 3 agents...
  -- Implementation
  -- Review
```

Persiste sur disque via `pipeline-tracker.ts` pour survivre aux restarts.

## Reprise et Fallback

Les commandes restent disponibles comme alternative aux boutons :

| Situation | Commande de reprise |
|---|---|
| Session perdue, exploration existe | `/dev-spec "Exploration: docs/explorations/EXPLORE-{name}.md"` |
| Session perdue, spec existe | `/dev-challenge docs/specs/SPEC-{name}.md` |
| Implementation echouee | `/dev-implement --from implement docs/specs/SPEC-{name}.md` |
| Reprise complete | `/dev-pipeline --from {phase} docs/specs/SPEC-{name}.md` |

Convention `{name}` + artefacts fichiers = tout est recuperable independamment de la session.

## Agents (.claude/agents/)

| Agent | Role | Modele |
|---|---|---|
| `explorer.md` | Exploration 3 axes + verdict GO/PIVOT/DROP | sonnet |
| `spec-architect.md` | Specification 9 sections + V-criteres | sonnet |
| `devils-advocate.md` | Challenge : contradictions, hypotheses | sonnet |
| `edge-case-hunter.md` | Challenge : crashs, cas limites, perf | sonnet |
| `simplicity-skeptic.md` | Challenge : sur-complexite, alternatives | sonnet |
| `reviewer.md` | Review de code post-implementation | sonnet |

Supprimes : `impact-analyst.md` (integre dans le challenge), `security-checker.md` (ponctuel, pas systematique), `test-architect.md` + `implementer.md` + `tester.md` (geres en interne par `/dev-implement`).

## Skills (.claude/skills/)

| Skill | Role |
|---|---|
| `/dev-explore` | Lancement exploration (fallback commande) |
| `/dev-implement` | Orchestration TDD interne (Test Architect, Implementer, Tester) |
| `/dev-review` | Review de code post-implementation |
| `/dev-doc` | Mise a jour documentation |

Supprimes : `/dev-spec` (spec-architect invoque directement), `/dev-challenge` (invoque par le flow), `/dev-pipeline` (remplace par le flow conversationnel).

## Modules TypeScript

### Conserves (inchanges)

| Module | Raison |
|---|---|
| `relay.ts` | Entry point |
| `config.ts` | Env vars (Zod) |
| `logger.ts` | Structured logging |
| `memory/` (6 sous-modules) | Valeur ajoutee principale |
| `documents.ts` + `document-sharding.ts` | Context cache |
| `job-manager.ts` + `semaphore.ts` | Background execution |
| `intent-detection.ts` | Regex + LLM fallback |
| `transcribe.ts` + `tts.ts` | Voix |
| `topic-config.ts` | Prompts par topic |
| `feature-flags.ts` | Flags utiles uniquement |
| `commands/tasks.ts` | /task, /backlog, /sprint, /start, /done |
| `commands/memory-cmds.ts` | /brain, /ideas, /remind |
| `commands/help.ts` | /help, /status |
| `commands/jobs.ts` | /jobs |
| `commands/documents.ts` | /docs |
| `commands/quality.ts` | /metrics, /cost |
| `commands/profile.ts` | /profile |
| `commands/project.ts` | /projects |
| `commands/utilities.ts` | /speak, /export |

### Simplifies

| Module | Changement |
|---|---|
| `bot-context.ts` | Retirer profile-evolution, simplifier context assembly |
| `agent.ts` | Retirer code-review integre, simplifier cascade |
| `cost-tracking.ts` | Parser stdout du spawn, retirer aggregation complexe |
| `notification-queue.ts` | Buffer + flush simple, retirer digest/quiet hours |
| `action-registry.ts` | Reduire a ~20 commandes |
| `commands/zz-messages.ts` | Ajouter gestion boutons + status bar + detection convergence |
| `commands/exploration.ts` | Adapter pour le flow conversationnel |
| `tasks.ts` | 4 etats : backlog, in_progress, review, done |

### Nouveaux (~200-300 LOC total)

| Module | Responsabilite |
|---|---|
| `pipeline-tracker.ts` | Etat du pipeline par chat, persistence disque, affichage status bar |
| `conversation-handoff.ts` | Extraction resume decisions, pont conversation -> agent |

### Supprimes (~8000 LOC)

| Module | Raison |
|---|---|
| `orchestrator/` (4 sous-modules) | Remplace par delegation directe a Claude Code |
| `blackboard.ts` | Plus d'etat partage inter-agents |
| `gate-evaluator.ts` | Tests + typecheck = hooks natifs Claude Code |
| `gate-persistence.ts` | Plus de persistence de gates |
| `trust-scores.ts` | Plus de scores de confiance |
| `deliberation.ts` | Plus de deliberation inter-agents |
| `agent-messaging.ts` | Plus de messaging inter-agents |
| `adversarial-verifier.ts` | Plus de verification adversariale TypeScript |
| `adversarial-challenge.ts` | Remplace par agents .claude/agents/ |
| `spec-lite.ts` | Desactive, jamais utilise |
| `exploration-scoring.ts` | Desactive, jamais utilise |
| `pipeline-selection.ts` | Plus de selection de pipeline |
| `pipeline-state.ts` | Remplace par pipeline-tracker.ts |
| `workflow.ts` | 4 etats dans tasks.ts suffisent |
| `bmad-agents.ts` | Remplace par .claude/agents/*.md |
| `bmad-prompts.ts` | System prompts dans les agents .md |
| `agent-schemas.ts` | Plus de JSON schemas inter-agents |
| `feedback-loop.ts` | Differe post-migration |
| `conversation-session.ts` | Sessions gerees par Claude Code |
| `code-review.ts` | Claude Code le fait en interne |
| `prd.ts` + `prd-workflow.ts` | Conversation naturelle remplace le PRD formel |
| `auto-pipeline.ts` | Plus de pipeline automatique |
| `llm-router.ts` | Plus de routage LLM |
| `proactive-planner.ts` | Differe |
| `autonomy-scanner.ts` | Differe |
| `profile-evolution.ts` | Differe |
| `alerts.ts` | Simplifie dans heartbeat |
| `patterns.ts` | Differe |
| `story-files.ts` | Plus de story files |
| `code-graph.ts` + `explore-graph.ts` | Differe |
| `command-router.ts` | Simplifie dans zz-messages |
| `agent-events.ts` | Differe |
| `agent-context.ts` | Simplifie dans bot-context |
| `cost-estimate.ts` | Differe |
| `mcp-config.ts` | Simplifie |
| `commands/execution.ts` | Remplace par flow conversationnel + boutons |
| `commands/planning.ts` | Remplace par conversation naturelle |

## Metriques Cibles

| Metrique | Avant | Apres |
|---|---|---|
| LOC source | 34K | ~18-20K |
| Modules source | 88 | ~45 |
| Commandes bot | 37 | ~20 |
| Agents .claude/ | 11 | 6 |
| Skills .claude/ | 7 | 4 |
| Pipelines | 6 (DEFAULT, LIGHT, QUICK, SOLO, REVIEW, RESEARCH) | 1 (flow conversationnel) |
| Temps execution task complexe | 15-30 min (5 agents series + gates) | 5-15 min (agents paralleles, pas de gates LLM) |
| Appels LLM par task | 6-8 (agents + gates + deliberation) | 2-4 (exploration + spec + challenge + implement) |
| Points de failure pipeline | ~12 | ~5 |

## Garanties

| Garantie | Mecanisme |
|---|---|
| Contexte pas perdu conversation -> spec | Resume structure extrait AVANT lancement spec-architect |
| Exploration informee des contraintes | Extraction contraintes injectees dans le prompt explorer |
| Qualite du challenge | 3 agents paralleles (perspectives distinctes) |
| Spec complete et structuree | Spec-architect avec template 9 sections (inchange) |
| Reprise possible apres perte de session | Artefacts fichiers + convention {name} + commandes /dev-* |
| User sait ou il en est | Status bar pipeline apres chaque etape |
| DROP/NO-GO respectes | Boutons d'action supprimes, discussion uniquement |
| Conversation jamais bloquee | Tout ce qui prend > 5s tourne en background |
| Fallback si boutons ignores | Commandes /dev-* restent disponibles |

## Plan de Migration

La migration se fait en phases incrementales, chaque phase doit passer CI avant la suivante.

### Phase 1 — Nettoyage du code mort
- Supprimer les modules derriere les 6 feature flags desactives
- Supprimer les agents et skills retires
- Mettre a jour les imports et les tests

### Phase 2 — Nouveaux modules fondation
- Creer `pipeline-tracker.ts` (etat pipeline, persistence, status bar)
- Creer `conversation-handoff.ts` (extraction resume, pont conversation/agent)
- Ajouter gestion boutons InlineKeyboard dans `zz-messages.ts`

### Phase 3 — Integration du flow conversationnel
- Modifier `zz-messages.ts` pour detecter convergence et proposer boutons
- Brancher exploration -> discussion -> spec -> challenge -> implement via boutons
- Adapter `exploration.ts` pour le flow conversationnel

### Phase 4 — Suppression de l'orchestration TypeScript
- Supprimer `orchestrator/`, `blackboard.ts`, `gate-evaluator.ts`, etc.
- Simplifier `agent.ts` et `bot-context.ts`
- Migrer les tests

### Phase 5 — Simplification des commandes
- Retirer `commands/execution.ts` et `commands/planning.ts`
- Simplifier `action-registry.ts`
- Mettre a jour `/help`

### Phase 6 — Documentation et stabilisation
- Mettre a jour CLAUDE.md
- Mettre a jour docs/WORKFLOW-*.md
- Tests E2E du flow complet
