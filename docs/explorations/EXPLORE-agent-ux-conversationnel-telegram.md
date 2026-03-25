---
phase: 0-explore
generated_at: "2026-03-25T14:30:00+01:00"
subject: "Agent UX conversationnel Telegram dans le pipeline SDD"
verdict: DROP
next_step: null
---

## Section 1 -- Probleme

Le pipeline SDD actuel comprend 6 agents specialises : explorer, spec-architect, devils-advocate, edge-case-hunter, simplicity-skeptic, reviewer. Aucun de ces agents ne couvre explicitement la perspective UX utilisateur Telegram. La question est : faut-il ajouter un 7e agent "ux-conversationnel" qui reviewerait les specs du point de vue de l'experience utilisateur dans le contexte specifique d'un bot Telegram ?

L'exploration est necessaire avant spec parce que :
1. Le gap reel n'est pas quantifie : on ne sait pas si des problemes UX sont passes a travers le pipeline existant
2. Le scope d'un tel agent est flou (review de spec ? review de code ? les deux ?)
3. Le risque de sur-ingenierie du pipeline lui-meme (deja 6 agents, 3 adversariaux en parallele) merite evaluation

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Conversational UX in Chatbot Design - Toptal](https://www.toptal.com/designers/ui/chatbot-ux-design) | Article technique | 2026-03-25 | Principes UX pour interfaces conversationnelles : progressive disclosure, gestion d'erreurs, feedback loops, decouverte de commandes | High |
| 2 | [Spec-Driven Development & AI Agents - Augment Code](https://www.augmentcode.com/guides/spec-driven-development-ai-agents-explained) | Guide | 2026-03-25 | Pipelines multi-agents SDD : roles specialises (analyst, architect, developer, reviewer), verifier agent post-implementation | Med |
| 3 | [Agentic Development Framework - GitHub](https://github.com/MatrixFounder/Agentic-development) | Framework | 2026-03-25 | Pipeline multi-agent avec roles Analyst/Architect/Planner/Developer/Reviewer/Security Auditor. Pas de role UX dedie — la verification UX est integree dans le Reviewer | Med |
| 4 | [Single-responsibility agents and multi-agent workflows - EPAM](https://www.epam.com/insights/ai/blogs/single-responsibility-agents-and-multi-agent-workflows) | Article | 2026-03-25 | Patterns multi-agents : sequentiel, parallele, debate. Recommandation de limiter le nombre d'agents pour eviter la surcharge de coordination | Med |

**Synthese de l'etat de l'art :**

Les principes UX conversationnels pour Telegram sont bien documentes : plain text, progressive disclosure, inline keyboards pour les actions, messages concis, gestion d'erreurs gracieuse, decouverte organique des commandes. Ces principes sont generiques et stables — ils ne changent pas d'une feature a l'autre.

Dans les pipelines multi-agents existants (Agentic Development, Angy, Spec Kit), aucun ne propose un agent UX dedie. La verification UX est soit integree dans le role Reviewer, soit traitee comme un critere de validation dans la spec (V-critere de niveau "manual"). L'approche predominante est de codifier les contraintes UX dans le system prompt ou les conventions du projet plutot que d'ajouter un agent supplementaire.

Le consensus en 2026 est de limiter le nombre d'agents pour eviter la surcharge de coordination. Les pipelines les plus matures (5-7 agents max) n'incluent pas d'agent UX specialise — ils codifient les regles UX dans les prompts des agents existants.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/bot-context.ts` (L553) | System prompt global impose deja "Never use markdown formatting [...] Write in plain text only" | Faible — convention UX deja codifiee au niveau le plus bas |
| 2 | `.claude/agents/spec-architect.md` (L71) | V-criteres avec niveau `manual` deja prevu pour "verification visuelle, UX, approbation humaine" | Faible — le mecanisme existe deja |
| 3 | `.claude/agents/edge-case-hunter.md` (L48) | Findings MAJEUR definis comme "erreur non geree qui impacte l'UX" | Faible — perspective UX deja integree dans cet agent |
| 4 | `.claude/agents/devils-advocate.md` (L28) | Analyse les "hypotheses implicites [...] sur le comportement utilisateur" | Faible — couverture partielle UX existante |
| 5 | `src/commands/sdd-flow.ts` (L75-156) | `buildSddKeyboard()` — 50+ lignes de logique InlineKeyboard contextuelle deja implementee | Nul — pattern UX Telegram deja mature |
| 6 | `docs/specs/SPEC-modules-fondation-flow-sdd.md` (L266) | Convention explicite "Les reponses Telegram sont en plain-text uniquement" | Nul — regle deja dans les specs |
| 7 | `docs/specs/SPEC-durcissement-standards-vague-4.md` (L206) | Dimension UX explicitement evaluee : "Non applicable — Refactorisation interne sans impact sur les commandes Telegram" | Nul — la grille d'evaluation UX existe deja dans les specs |
| 8 | `src/sdd-agents.ts` (L207-307) | `runSddChallenge()` lance 3 agents adversariaux en parallele via `Promise.allSettled` | Eleve — ajouter un 4e agent augmenterait le cout et la duree de la phase challenge |
| 9 | `CLAUDE.md` (L172) | Convention "Telegram responses: plain text only, no markdown formatting" documentee au niveau projet | Nul — convention deja codifiee |
| 10 | `tests/unit/pipeline-tracker.test.ts` (L343) | Test existant "is plain text only (no markdown)" — V-critere UX deja teste en unit | Nul — couverture test UX existante |

**Points de friction :**
- L'ajout d'un 4e agent dans `runSddChallenge()` augmenterait le cout token d'environ 25% par challenge (3 appels Claude Sonnet -> 4)
- Le temps de la phase challenge serait domine par le plus lent des 4 agents au lieu de 3
- Le fichier `sdd-agents.ts` (489 LOC) devrait etre modifie pour integrer un 4e agent

**Actifs reutilisables :**
- Le pattern d'agent adversarial est bien etabli : definition dans `.claude/agents/`, prompt template dans `sdd-agents.ts`, lancement parallele via `Promise.allSettled`
- La structure de rapport (BLOQUANT/MAJEUR/MINEUR + statistiques) est standardisee et reutilisable
- Le mecanisme de verdict (`extractChallengeVerdict`, `mostSevereVerdict`) est generique

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Agent UX dedie (7e agent) | C: Enrichir agents existants |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | L | S |
| **Valeur ajoutee** (obligatoire) | Med | Low | Med |
| **Risque technique** (obligatoire) | Low | Med | Low |
| *Impact maintenance* | Nul | +1 agent a maintenir, +1 fichier .md, modifications sdd-agents.ts | Modifications mineures dans 3 fichiers existants |
| *Reversibilite* | N/A | Moyenne — necessite rollback sdd-agents.ts + suppression agent | Elevee — ajout de lignes dans prompts existants |

**A: Status quo** — Les 6 agents existants couvrent deja partiellement la perspective UX : edge-case-hunter detecte les impacts UX, devils-advocate questionne les hypotheses utilisateur, spec-architect prevoit des V-criteres manuels pour l'UX. Les conventions Telegram (plain text, pas de markdown) sont codifiees dans bot-context.ts, CLAUDE.md, et les specs. 24 specs produites, 89 reviews — aucun probleme UX majeur non detecte identifie dans l'archeologie.

**B: Agent UX dedie** — Ajouterait un 7e agent avec checklist specifique Telegram (longueur messages, InlineKeyboard patterns, gestion d'erreurs, decouverte commandes, accents francais). Cout : +25% tokens par challenge, +1 agent a maintenir, modifications dans sdd-agents.ts. Probleme fondamental : les regles UX Telegram pour ce bot sont essentiellement statiques (plain text, accents, messages concis, InlineKeyboard pour actions) — elles ne varient pas d'une spec a l'autre. Un agent qui repete les memes findings a chaque challenge n'apporte pas de valeur incrementale.

**C: Enrichir agents existants** — Ajouter 2-3 lignes de checklist UX dans edge-case-hunter.md et reviewer.md pour couvrir explicitement : troncature Telegram (limite 4096 chars), coherence InlineKeyboard, messages d'erreur user-friendly. Cout negligeable, aucun changement d'architecture.

## Section 5 -- Verdict et justification

**Verdict : DROP**

L'analyse sur les 3 axes converge vers la meme conclusion : le gap UX dans le pipeline actuel est inexistant ou negligeable, et un 7e agent dedie serait de la sur-ingenierie.

1. **Pas de gap reel identifie** (Axe 2) : sur 24 specs et 89 reviews produites par le pipeline, l'archeologie du codebase ne revele aucun probleme UX Telegram qui aurait echappe aux agents existants. Les conventions UX critiques (plain text, accents francais, messages concis) sont deja codifiees a trois niveaux : system prompt global (bot-context.ts L553), conventions projet (CLAUDE.md L172), et specs individuelles.

2. **Couverture existante adequate** (Axe 2) : les 3 agents adversariaux couvrent deja la perspective UX partiellement — edge-case-hunter detecte les "erreurs qui impactent l'UX", devils-advocate questionne les hypotheses sur le "comportement utilisateur", spec-architect prevoit des V-criteres de niveau "manual" pour la "verification visuelle, UX". L'ajout de 2-3 items de checklist dans les agents existants (option C) suffirait si un renforcement etait juge necessaire.

3. **Regles UX statiques** (Axe 1) : contrairement aux preoccupations de securite ou de performance qui varient selon le contexte, les regles UX Telegram pour ce bot sont essentiellement statiques et connues (plain text, limite 4096 chars, InlineKeyboard pour actions, accents francais). Un agent qui applique les memes regles a chaque spec ne genere que du bruit repetitif, pas de valeur incrementale.

4. **Cout disproportionne** (Axe 3) : un 4e agent adversarial augmenterait le cout de la phase challenge de ~25% (+1 appel Claude Sonnet par pipeline run) pour une valeur ajoutee faible/nulle. Le pipeline compte deja 6 agents — c'est dans la fourchette haute des pipelines multi-agents matures.

5. **Consensus externe** (Axe 1) : aucun framework multi-agent de reference (Agentic Development, Spec Kit, Angy) n'inclut d'agent UX dedie. L'approche standard est de codifier les contraintes UX dans les prompts et les conventions du projet.

## Section 6 -- Input pour etape suivante

**Raisons de l'abandon :**
- Le probleme est mal pose : le gap UX n'existe pas dans la pratique (24 specs, 89 reviews, aucun probleme UX non detecte)
- La solution proposee (agent dedie) est disproportionnee par rapport au probleme
- Les mecanismes existants (conventions codifiees + agents adversariaux partiellement UX-aware) sont suffisants

**Conditions sous lesquelles revisiter la decision :**
1. Si un probleme UX Telegram majeur passe a travers le pipeline existant et cause un incident en production (evidence concrete d'un gap)
2. Si le bot evolue vers des Mini Apps Telegram ou des interfaces riches (au-dela du plain text + InlineKeyboard), ce qui introduirait des regles UX complexes et variables
3. Si le nombre de specs produites par semaine depasse 5+, ce qui justifierait un investissement dans l'automatisation UX plus poussee

**Action minimale recommandee (optionnelle, sans pipeline) :**
Si un renforcement UX leger est desire, ajouter dans `edge-case-hunter.md` un 7e axe d'analyse :
```
7. **Impact UX Telegram** : messages > 4096 chars, InlineKeyboard absent pour les actions, messages d'erreur non informatifs, accents manquants
```
Cela ne necessite ni nouveau agent, ni modification de sdd-agents.ts, ni pipeline SDD.
