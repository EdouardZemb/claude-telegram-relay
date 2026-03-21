---
phase: 0-explore
generated_at: "2026-03-21T14:00:00+01:00"
subject: "Analyse ce que le skill dev-pipeline pourrait apporter au workflow multiagent"
verdict: GO
next_step: "dev-spec"
---

# Analyse : Apport du skill dev-pipeline au workflow multiagent du bot

## Section 1 — Problème

Le projet dispose de deux systèmes d'orchestration multiagent distincts qui coexistent sans jamais se parler :

**Système A — Pipeline bot (runtime Telegram)** : `orchestrator.ts` + `auto-pipeline.ts` enchainent 8 agents BMad (analyst, pm, architect, dev, qa, sm, explorer, planner) pour traiter des tâches issues du backlog. Ce système est déclenché par des commandes Telegram (`/orchestrate`, `/autopipeline`), tourne en production 24/7 et produit des PR GitHub.

**Système B — Pipeline de maturation code (dev pipeline)** : `.claude/skills/dev-pipeline/SKILL.md` orchestre 11 agents spécialisés (Spec Architect, Devil's Advocate, Edge Case Hunter, Simplicity Skeptic, Impact Analyst, Test Architect, Implementer, Tester, Reviewer, Security Checker) sur 6 phases (explore → spec → challenge → implement → review → doc → commit). Ce système est invoqué interactivement par le développeur dans Claude Code et produit des artefacts durables sur disque (`docs/specs/`, `docs/reviews/`).

L'exploration est nécessaire parce que ces deux systèmes résolvent des problèmes voisins (faire produire du code de qualité par des agents Claude) mais avec des approches radicalement différentes. Le système B a des propriétés que le système A n'a pas : spec formelle avec V-critères, challenge adversarial à 3 agents parallèles, TDD séquencé (Test Architect → Implementer → Tester), conformance traceability, quality gate utilisateur post-spec, rapport consolidé avec métriques de diff. La question est : lesquelles de ces propriétés peuvent être apportées au système A, et sous quelle forme ?

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | TDAD: Test-Driven Agentic Development (arxiv.org/html/2603.17973) | Article de recherche | Mars 2026 | Approche TDD pour agents codeurs : graphe AST code→tests, analyse d'impact pré-commit. Réduction de 72% des régressions (562→155 sur SWE-bench). Résultat contre-intuitif : les instructions TDD procédurales sans contexte ciblé *aggravent* les régressions (+63% vs baseline). La densité de contexte prime sur la prescription de workflow. | Haute |
| 2 | MatrixFounder/Agentic-development (github.com/MatrixFounder/Agentic-development) | Framework open source | 2025 | 10 rôles d'agents (Analyst, Architect, Planner, Developer, Reviewer, Security Auditor + Director adversarial) avec Stub-First TDD et VDD (Verification-Driven Development). L'agent adversarial "Sarcasmotron" challenge le plan avant implémentation. Distingue blueprints (théorie) et drivers (instructions exécutables). | Haute |
| 3 | SoftwareSeni — Spec-Driven Development in 2025 (softwareseni.com/spec-driven-development-in-2025-the-complete-guide) | Article technique | 2025 | La SDD place la spec au centre : objectifs + règles + critères de succès. La spec sert d'ancre pendant l'implémentation. Compatible TDD (par tâche) et BDD (end-to-end). La SDD "sits above them as the source of intent". GitHub Copilot Agent intègre specs → code autonomous pipeline. | Haute |
| 4 | Microsoft AI-led SDLC (techcommunity.microsoft.com/.../4491896) | Blog technique | 2026 | Pipeline SDLC agentic end-to-end : Issue → Spec → Code → CI → PR. Quality gates automatisés dans Azure DevOps. La review ligne-par-ligne devient impraticable avec le code AI-généré → quality gates contextuels automatisés nécessaires. | Moyenne |

### Synthèse des enseignements clés

**Enseignement 1 : La spec formelle est le différenciateur de qualité majeur.** Les systèmes multiagents qui produisent du code de haute qualité ont tous une spec explicite en amont. Sans spec, les agents travaillent sur des interprétations divergentes de la demande. Le dev-pipeline l'a compris avec ses 9 sections et V-critères. Le workflow bot (système A) n'a que la description de tâche et le story file généré automatiquement — un niveau de formalisme nettement inférieur.

**Enseignement 2 : Le TDD procédural sans contexte est contre-productif.** La recherche TDAD montre que prescrire "écris les tests avant le code" sans fournir le contexte de quel code est impacté aggrave les résultats. Le dev-pipeline résout ce problème en donnant au Test Architect la spec complète avec V-critères. Si le workflow bot adoptait le TDD, il devrait aussi fournir ce contexte de spec.

**Enseignement 3 : L'adversarial challenge est une pratique émergente reconnue.** Plusieurs frameworks indépendants (MatrixFounder/Agentic-development avec son "Sarcasmotron", le dev-pipeline avec 3 adversariaux parallèles) convergent vers le même pattern : un agent dédié à contester la spec avant que l'implémentation ne commence. Cela réduit le coût de correction (10x moins cher de corriger une spec qu'un bug en prod).

**Enseignement 4 : La traçabilité V-critère → test → conformance est rare mais précieuse.** Aucun framework du marché n'a nativement ce niveau de traçabilité. GitHub Copilot lie issues → specs → code, mais pas jusqu'aux tests avec vérification automatique. C'est un avantage concurrentiel unique du dev-pipeline.

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/orchestrator.ts` (1569 lignes) | Cœur du système A. Enchaîne les agents BMad avec passage de messages structurés JSON. A le blackboard (optionnel), les trust scores, l'evaluator-rework loop, la deliberation. N'a PAS : spec formelle, challenge adversarial pré-implémentation, TDD séquencé. | Haut |
| 2 | `src/auto-pipeline.ts` (394 lignes) | Pipeline autonome end-to-end. Phases : gate_check → story_enrichment → analysis → execution → review → done. La phase analysis utilise les agents analyst+pm+architect. Pas de phase spec dédiée, pas de challenge adversarial. | Haut |
| 3 | `src/story-files.ts` | Génère un story file structuré (ACs, steps, test stubs) depuis la description de tâche. C'est l'équivalent light d'une spec — mais sans les 9 sections, sans V-critères formels, sans interview utilisateur. | Moyen |
| 4 | `src/gate-evaluator.ts` (887 lignes) | Évalue chaque phase pipeline avec rubric 4×25, dual verification (déterministe + LLM), boucle evaluate-rework max 2 iterations, trust scores. Analogue partiel du challenge adversarial du dev-pipeline. | Moyen |
| 5 | `src/adversarial-verifier.ts` | Détection drift spec↔implémentation en clean room. Comparable à la Phase 3d (conformance) du dev-pipeline. Activé seulement en mode blackboard (optionnel). | Moyen |
| 6 | `src/deliberation.ts` | Protocole deliberation : architect→PM (1 revision max), dev→QA. C'est un adversarial review limité (paires prédéfinies, 1 round-trip max). Moins puissant que le triple challenge parallèle du dev-pipeline. | Bas |
| 7 | `src/prd.ts` + `src/prd-workflow.ts` | PRD = spec haut niveau conversationnel. Requis par Gate 1 avant `/exec`. Structure différente d'une SPEC (moins formelle, pas de V-critères, pas de section fichiers impactés). | Moyen |
| 8 | `src/pipeline-selection.ts` | Sélection dynamique parmi 6 pipelines (SOLO/QUICK/LIGHT/DEFAULT/REVIEW/RESEARCH). Le dev-pipeline apporte une 7e option possible : DEFAULT + spec_phase (FULL). | Bas |
| 9 | `src/feedback-loop.ts` + `src/gate-persistence.ts` | Boucle d'apprentissage double : retros + gate analysis → enrichissement prompts agents. Le dev-pipeline n'a pas cet équivalent — les artefacts servent de mémoire épisodique mais pas d'apprentissage structuré. | Bas |
| 10 | `.claude/agents/` (11 agents) | Les agents du dev-pipeline (Spec Architect, Devil's Advocate, Edge Case Hunter, Simplicity Skeptic, Impact Analyst, Test Architect, Implementer, Tester, Reviewer, Security Checker) sont définis ici. Séparés des agents BMad du bot (analyst, pm, architect, dev, qa, sm, explorer, planner). | Haut |
| 11 | `.claude/skills/dev-pipeline/SKILL.md` | 572 lignes de méta-orchestration. Aucune intégration avec le code runtime du bot — deux mondes hermétiquement séparés. | Haut |

### Points de friction identifiés

1. **Frontière runtime/développement** : Le dev-pipeline opère en dehors de l'exécution du bot (Claude Code interactif), le workflow bot opère en runtime (PM2). Toute intégration doit gérer cette frontière de manière explicite.
2. **Deux ontologies de spec** : Le bot a les PRDs (`src/prd.ts`, format conversationnel) et les story files (`src/story-files.ts`, généré auto). Le dev-pipeline a les SPECs (`docs/specs/SPEC-*.md`, 9 sections formelles). Unifier ces ontologies représente un travail non trivial.
3. **Durée d'exécution incompatible** : Le dev-pipeline prend 15-60 minutes (6 phases, 11 agents). La plupart des interactions Telegram attendent une réponse en < 2 minutes. Une intégration directe en synchrone est impossible.
4. **Context isolation** : Les agents du dev-pipeline tournent dans des subagents Claude Code avec accès au filesystem. Les agents BMad tournent via `spawnClaude()` avec un prompt construit dynamiquement. Les deux mécanismes de context feeding sont différents.

### Actifs réutilisables

1. **Les 11 agents spécialisés** (`.claude/agents/*.md`) sont disponibles — ils peuvent être invoqués depuis le bot comme subagents via `spawnClaude()` si on leur fournit le bon contexte.
2. **`src/adversarial-verifier.ts`** est déjà une implémentation partielle du pattern challenge adversarial — extensible pour faire un challenge pré-spec.
3. **`src/gate-evaluator.ts`** : la rubric 4×25 et la boucle evaluate-rework sont les briques d'un challenge multi-dimensions.
4. **`src/pipeline-state.ts`** : le checkpoint/resume Supabase peut stocker les artefacts de spec pour les réutiliser entre phases asynchrones.
5. **`docs/specs/SPEC-*.md`** existants : 6 specs formelles déjà produites par le dev-pipeline peuvent servir de données d'entraînement pour scorer la qualité d'une description de tâche.

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Intégration hybride légère | C: Intégration profonde | D: Unification ontologique |
|---------|:------------:|:-----------------------------:|:-----------------------:|:--------------------------:|
| **Complexité** (obligatoire) | S | M | L | XL |
| **Valeur ajoutée** (obligatoire) | Low | High | High | Med |
| **Risque technique** (obligatoire) | Low | Low | High | High |
| *Impact maintenance* (si pertinent) | Neutre | Faible ajout | Complexité × 2 | Complexité × 3 |
| *Réversibilité* (si pertinent) | N/A | Totale | Partielle | Faible |

**Option A — Status quo** : Les deux systèmes restent hermétiques. Le dev-pipeline sert à faire évoluer le code du bot (PRs), le workflow bot sert à traiter les tâches en runtime. Pas de duplication, pas de complexité ajoutée. Valeur ajoutée nulle pour l'orchestration runtime. Option correcte si l'objectif est uniquement de maintenir la qualité du code du bot lui-même.

**Option B — Intégration hybride légère** : On sélectionne 2-3 patterns du dev-pipeline à greffer dans l'orchestrateur bot, sans changer l'architecture de fond. Candidats naturels : (1) enrichissement de la description de tâche en proto-spec structurée avant orchestration (ajouter une "spec phase" légère via le Spec Architect ou le PM agent étendu) ; (2) challenge adversarial facultatif sur la spec générée (1 agent au lieu de 3, derrière feature flag) ; (3) conformance check des V-critères en post-implementation (réutiliser la logique de `adversarial-verifier.ts`). Complexité M, réversible totalement, valeur haute. C'est l'option recommandée.

**Option C — Intégration profonde** : Transformer l'`auto-pipeline.ts` pour dérouler les 6 phases du dev-pipeline en asynchrone (job-manager + Supabase checkpoints). Le bot deviendrait un orchestrateur qui démarre un pipeline de maturation complet pour chaque tâche significative. Complexité L, risque élevé (durée 15-60 min incompatible avec UX Telegram), valeur haute mais coût de maintenance élevé.

**Option D — Unification ontologique** : Supprimer la distinction PRD/story file/SPEC et créer une ontologie unifiée. Toutes les tâches auraient une SPEC formelle 9 sections produite avant toute orchestration. Complexité XL, risque très élevé, bénéfice marginal par rapport à B.

## Section 5 — Verdict et justification

**Verdict : GO**

L'analyse révèle une asymétrie claire entre les deux systèmes : le dev-pipeline (Système B) dispose de patterns de qualité que le workflow bot (Système A) n'a pas, et ces patterns sont apportables de manière ciblée sans refonte architecturale.

Trois enseignements des axes 1 et 2 convergent vers GO :

Premièrement, la recherche externe (TDAD, frameworks comparatifs) confirme que la **spec formelle pré-implémentation** est le différenciateur de qualité le plus impactant dans les pipelines multiagents. Le workflow bot actuel n'a que le PRD (haut niveau) et le story file (auto-généré depuis le titre de tâche) — deux niveaux de formalisme insuffisants pour guider un pipeline 5-agents vers une implémentation cohérente. Ajouter une "phase spec légère" (une version abrégée du travail du Spec Architect, focalisée sur les V-critères et les fichiers impactés) avant l'orchestration BMad est l'amélioration à plus fort retour sur investissement.

Deuxièmement, l'**archéologie codebase** révèle que les briques nécessaires existent déjà : `adversarial-verifier.ts`, `gate-evaluator.ts`, `pipeline-state.ts`, et les 11 agents `.claude/agents/*.md` sont disponibles. L'intégration hybride légère (Option B) est une composition d'actifs existants, pas une construction ex nihilo.

Troisièmement, la contrainte de **durée incompatible** (15-60 min pour le dev-pipeline complet vs < 2 min attendu Telegram) impose de choisir l'Option B plutôt que C ou D. Seuls les patterns transposables en < 5 minutes supplémentaires par phase sont candidats à l'intégration. Le challenge adversarial à 3 agents parallèles (Phase 2 du dev-pipeline) peut être approximé par 1 seul agent adversarial derrière feature flag — réduisant la latence de 3-5 minutes à 1-2 minutes.

La valeur ajoutée est confirmée par le benchmark de l'exploration précédente (`EXPLORE-analyse-dev-pipeline-multiagent.md`) qui identifie "spec formelle pré-implementation" comme l'un des deux patterns absents les plus impactants dans le workflow bot.

## Section 6 — Input pour étape suivante

### Input pour spec

**Option recommandée** : Option B — Intégration hybride légère

**3 patterns à spécifier, par ordre de priorité :**

**Pattern P1 — Spec phase légère pré-orchestration** (priorité haute)
- Avant de lancer `orchestrate()`, produire une proto-spec structurée avec au moins : objectif, V-critères (3-5 max), fichiers probablement impactés.
- Mécanisme : nouveau agent `spec-lite` (sous-ensemble du Spec Architect, haiku model, < 2 min), ou extension du `pm` agent existant avec des instructions spécifiques.
- Stockage : dans le blackboard (section `spec`), déjà supporté par `blackboard.ts`.
- Déclenchement : uniquement sur pipelines DEFAULT et LIGHT (pas QUICK/SOLO).
- Feature flag : `spec_phase_lite`.

**Pattern P2 — Challenge adversarial 1-agent avant dev** (priorité moyenne)
- Après la phase architect, avant le dev : lancer un seul agent adversarial (Devil's Advocate ou simplicity-skeptic au choix selon la nature de la tâche).
- L'agent reçoit la proto-spec (si P1 actif) ou la sortie architect.
- Si l'adversarial trouve des problèmes BLOQUANTS → pause pipeline + notification Telegram à l'utilisateur.
- Mécanisme : nouveau step `adversarial` inséré dynamiquement dans le pipeline, derrière feature flag `adversarial_challenge`.
- Seuil : 1 finding BLOQUANT = pause. Pas de boucle corrective automatique (trop cher en latence).

**Pattern P3 — Conformance check post-implémentation** (priorité basse)
- Après le dev agent, avant QA : vérifier que les V-critères de la proto-spec (P1) sont couverts par des tests.
- Mécanisme : réutiliser la logique de `adversarial-verifier.ts` + inspection du code généré.
- Condition : uniquement si P1 a produit des V-critères.

**Fichiers concernés par la spec :**
- `src/orchestrator.ts` — ajouter step `spec-lite` et step `adversarial` dans le pipeline loop
- `src/auto-pipeline.ts` — ajouter phase spec avant la phase analysis
- `src/blackboard.ts` — section `spec` déjà supportée, aucune modification nécessaire
- `src/feature-flags.ts` — ajouter `spec_phase_lite` et `adversarial_challenge`
- `config/features.json` — déclarer les deux nouveaux flags
- `.claude/agents/spec-lite.md` (nouveau) — profil agent spec légère
- Possiblement : `src/adversarial-challenge.ts` (nouveau) — module dédié au challenge adversarial runtime

**Contraintes identifiées :**
- Durée max acceptable par pattern : 2 minutes (compatibilité UX Telegram)
- Les patterns P1 et P2 doivent être derrière feature flags désactivés par défaut
- Ne pas modifier le comportement des pipelines QUICK et SOLO (régression de complexité garantie)
- La proto-spec générée par P1 doit être auto-suffisante — pas d'interview utilisateur en synchrone

**Questions ouvertes à résoudre pendant la spec :**
1. Quel est le niveau minimal d'une proto-spec "utile" pour améliorer la qualité du dev agent ? 3 V-critères suffisent-ils ?
2. Le challenge adversarial 1-agent doit-il pouvoir être bypassé par l'utilisateur (override) comme les gates BMad existants ?
3. Les V-critères de la proto-spec doivent-ils utiliser la notation `[Vx]` du dev-pipeline pour la conformance, ou une notation propre au runtime bot ?
4. Comment gérer la latence additionnelle dans le cas `maxConcurrency > 1` du batch pipeline ?
5. Le spec-lite agent doit-il lire les specs formelles existantes (`docs/specs/SPEC-*.md`) pour s'en inspirer, ou opérer en isolation ?
