---
phase: 0-explore
generated_at: "2026-03-24T09:15:00Z"
subject: "Nettoyage du code mort — Phase 1 de l'architecture V2"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Probleme

Le bot Telegram `claude-telegram-relay` a accumule ~34K LOC en 44 sprints. Le document `docs/ARCHITECTURE-V2.md` definit une migration en 6 phases vers une architecture conversationnelle plus legere (~18-20K LOC). La Phase 1 est la plus sure a executer en premier : elle ne cree rien de nouveau, elle supprime uniquement du code mort.

**Code mort identifie dans trois categories :**

1. **6 feature flags desactives** (`exploration_phase`, `exploration_gate`, `spec_phase_lite`, `adversarial_challenge`, `prd_maturation_phases`, `memory_promotion`) — le code derriere ces flags ne s'execute jamais en production. Il a ete develop mais deliberement laisse off.

2. **5 agents `.claude/agents/` obsoletes** — `impact-analyst.md`, `security-checker.md`, `test-architect.md`, `implementer.md`, `tester.md` — documentes comme "Supprimes" dans ARCHITECTURE-V2.md. Ils ne sont references nulle part dans le TypeScript.

3. **3 skills `.claude/skills/` obsoletes** — `dev-spec/`, `dev-challenge/`, `dev-pipeline/` — documentes comme "Supprimes" dans ARCHITECTURE-V2.md. Ils ne sont references nulle part dans le TypeScript.

L'exploration est necessaire pour identifier precisement les dependances entre modules, les tests a mettre a jour, et les cascades d'imports a corriger avant de specifier le travail de suppression.

## Section 2 — Etat de l'art

**Note : L'axe 1 (etat de l'art externe) n'est pas applicable pour ce sujet.** Il s'agit d'un refactoring interne specifique au codebase `claude-telegram-relay`. Les bonnes pratiques generales de suppression de code mort (dead code elimination) sont bien etablies et ne necessitent pas de recherche externe : (1) identifier les points d'entree, (2) tracer les imports en cascade, (3) supprimer dans l'ordre inverse des dependances, (4) mettre a jour les tests, (5) verifier que le build passe.

Ce sujet etant purement archeologique (exploration du codebase existant), l'axe 1 est marque **Non couvert — sources externes non pertinentes**. Le verdict reste eligible a GO car la limitation vient de la nature du sujet et non d'un manque d'information.

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| — | Non applicable | — | — | Refactoring interne, pas de benchmark externe necessaire | N/A |

## Section 3 — Archeologie codebase

### 3.1 — Modules TypeScript derriere les 6 flags desactives

| # | Fichier/Module | Flag | Observation | Impact potentiel |
|---|---------------|------|-------------|:----------------:|
| 1 | `src/spec-lite.ts` (189 LOC) | `spec_phase_lite` | Import statique dans `orchestrator/pipeline.ts` (L81) et `prd-workflow.ts` (L35). Import dynamique dans `auto-pipeline.ts` (L192). Expose `generateProtoSpec`, `parseProtoSpec`, `StoryFileInput`. | Eleve |
| 2 | `src/adversarial-challenge.ts` (362 LOC) | `adversarial_challenge` | Import statique dans `orchestrator/pipeline.ts` (L14) et `prd-workflow.ts` (L14). Expose `runAdversarialChallenge`, `runImpactAnalysis`, `parseAdversarialResult`. | Eleve |
| 3 | `src/exploration-scoring.ts` (292 LOC) | `exploration_phase` | Import dans `llm-router.ts` (L11) et `orchestrator/pipeline.ts` (L57). Expose `computeExplorationScore`, `shouldExplore`, `ExplorationScore`. | Moyen |
| 4 | `src/commands/exploration.ts` (234 LOC) — partiel | `exploration_phase` | Le handler `/explore` retourne immediatement "desactivee" si le flag est off. Le reste du module reste actif (code-graph fast-path). La commande est quand meme chargee par le loader. | Faible |
| 5 | `src/gate-evaluator.ts` (937 LOC) — section | `exploration_gate` | Uniquement ~10 lignes gard par `isFeatureEnabled("exploration_gate")` (L521). Le reste du module est actif et utilise par l'orchestrateur. | Faible |
| 6 | `src/prd-workflow.ts` (783 LOC) — fonctions | `prd_maturation_phases` + `spec_phase_lite` + `adversarial_challenge` | Fonctions `isPrdMaturationEnabled()` et `runPrdPreflightChecks()` (L558-L700+) guerdees. Appel dans `commands/planning.ts` (L861). `runPrdPreflightChecks` appelle `generateProtoSpec` (spec_phase_lite) et `runAdversarialChallenge` (adversarial_challenge). | Moyen |
| 7 | `src/orchestrator/pipeline.ts` (1486 LOC) — sections | `spec_phase_lite` + `adversarial_challenge` + `memory_promotion` | 3 blocs gardes : P1 (L326-400), P2 (L862-901), memory promotion (L1431-1439). Imports en tete : `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `shouldExplore`, `ExplorationScore`, `promoteWorkingMemory`. | Eleve |
| 8 | `src/memory/graph.ts` (855 LOC) — fonction | `memory_promotion` | `promoteWorkingMemory()` (L765-855) est la seule fonction derriere ce flag. Elle est exportee via `src/memory.ts`. Elle contient aussi un appel interne `isFeatureEnabled("agent_role_memory")` (actif, a conserver). La fonction `memoryHealthStats` utilise le tag `working_memory_promotion` pour les stats (independant du flag). | Moyen |
| 9 | `src/llm-router.ts` (481 LOC) — ligne | `exploration_phase` | Uniquement L97 : `if (isFeatureEnabled("exploration_phase"))` avant un appel a `computeExplorationScore`. Le reste du module est actif. | Faible |
| 10 | `src/auto-pipeline.ts` — ligne | `spec_phase_lite` | L186-192 : guard `isFeatureEnabled("spec_phase_lite")` avant import dynamique de `spec-lite.ts`. Ce module est lui-meme derriere les phases 4/5 de suppression (ARCHITECTURE-V2.md). | Faible |

### 3.2 — Agents `.claude/agents/` obsoletes

| # | Fichier | Statut dans ARCHITECTURE-V2 | References TypeScript | Impact potentiel |
|---|---------|----------------------------|----------------------|:----------------:|
| 11 | `.claude/agents/impact-analyst.md` (124 LOC) | Supprime — "integre dans le challenge" | Aucune | Nul |
| 12 | `.claude/agents/security-checker.md` (96 LOC) | Supprime — "ponctuel, pas systematique" | Aucune | Nul |
| 13 | `.claude/agents/test-architect.md` (119 LOC) | Supprime — "gere en interne par /dev-implement" | Aucune | Nul |
| 14 | `.claude/agents/implementer.md` (63 LOC) | Supprime — "gere en interne par /dev-implement" | Aucune | Nul |
| 15 | `.claude/agents/tester.md` (87 LOC) | Supprime — "gere en interne par /dev-implement" | Aucune | Nul |

### 3.3 — Skills `.claude/skills/` obsoletes

| # | Fichier | Statut dans ARCHITECTURE-V2 | References TypeScript | Impact potentiel |
|---|---------|----------------------------|----------------------|:----------------:|
| 16 | `.claude/skills/dev-spec/SKILL.md` (138 LOC) | Supprime — "spec-architect invoque directement" | Aucune | Nul |
| 17 | `.claude/skills/dev-challenge/SKILL.md` (66 LOC) | Supprime — "invoque par le flow" | Aucune | Nul |
| 18 | `.claude/skills/dev-pipeline/SKILL.md` (571 LOC) | Supprime — "remplace par le flow conversationnel" | Aucune | Nul |

### 3.4 — Tests a mettre a jour

| # | Fichier test | Raison de la mise a jour |
|---|-------------|--------------------------|
| 19 | `tests/unit/spec-lite.test.ts` (177 LOC) | Supprime avec le module |
| 20 | `tests/unit/adversarial-challenge.test.ts` (193 LOC) | Supprime avec le module |
| 21 | `tests/unit/exploration-scoring.test.ts` (302 LOC) | Supprime avec le module |
| 22 | `tests/unit/orchestrator.test.ts` | Sections "[V14] Feature Flags for P1/P2/E1/P3", "memory_promotion feature flag", "Working memory promotion" (env. 30 lignes) a supprimer |
| 23 | `tests/unit/logger-migration.test.ts` | Retirer `adversarial-challenge.ts` et `spec-lite.ts` de la liste `MIGRATED_MODULES` |
| 24 | `tests/generated/reviser-prd-to-deploy-workflow.test.ts` (891 LOC) | Sections V2/V3/V18 testant `prd_maturation_phases`/`spec_phase_lite`/`adversarial_challenge` (env. 32 references) — refactoring ou suppression selon si le module `prd-workflow.ts` est conserve |
| 25 | `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` (656 LOC) | Sections V1/V2/V12 testant `memory_promotion` (14 references) a supprimer |
| 26 | `tests/unit/memory-evolution.test.ts` | Sections testant `memory_promotion` flag et `working_memory_promotion` (env. 10 tests) |
| 27 | `CLAUDE.md` | Mettre a jour la table Dev Pipeline (retirer dev-spec, dev-challenge, dev-pipeline), la liste des agents, le workflow |

### 3.5 — Points de friction

**Friction 1 — `prd-workflow.ts` est partiellement a supprimer.**
Le module `prd-workflow.ts` (783 LOC) est derriere `prd_to_deploy` (flag ACTIF), mais les fonctions `isPrdMaturationEnabled()` et `runPrdPreflightChecks()` sont derriere `prd_maturation_phases` (flag INACTIF). La suppression est chirurgicale : supprimer uniquement ces deux fonctions et leurs imports associes (`generateProtoSpec`, `runAdversarialChallenge`), pas le module entier.

**Friction 2 — `orchestrator/pipeline.ts` a 3 blocs a exciser.**
Trois sections distinctes (P1, P2, memory_promotion) sont a retirer du pipeline. Chaque retrait necessite aussi de retirer les imports en tete du fichier. Les blocs sont bien isoles par des guards `if (isFeatureEnabled(...))`, la chirurgie est nette.

**Friction 3 — `src/memory/graph.ts` : attention a `working_memory_promotion`.**
La fonction `promoteWorkingMemory()` est derriere `memory_promotion`. Mais le tag `"working_memory_promotion"` est aussi utilise comme filtre dans `memoryHealthStats()` (L615) pour compter les promotions recentes — ceci est independant du flag. La suppression de `promoteWorkingMemory` ne doit pas toucher ce filtre de stats.

**Friction 4 — Les tests de conformance source (orchestrator.test.ts) cassent apres suppression.**
Les tests [V1]/[V2]/[V3] dans `orchestrator.test.ts` lisent le source de `pipeline.ts` et verifient la presence de `isFeatureEnabled("memory_promotion")`. Apres suppression du code derriere le flag, ces tests doivent etre supprimes.

**Friction 5 — `doc-freshness` test verifie la coherence entre src/ et CLAUDE.md.**
La suppression de modules dans `src/` doit etre accompagnee d'une mise a jour de `CLAUDE.md` pour eviter que le test `doc-freshness.test.ts` echoue.

### 3.6 — Actifs reutilisables

- La structure des guards `if (!isFeatureEnabled(...)) { return ... }` est deja en place et rend la suppression tres lisible.
- Les tests unitaires des modules a supprimer (spec-lite, adversarial-challenge, exploration-scoring) peuvent etre simplement supprimes sans migration.
- `bun test` (4035 tests, 0 fail actuellement) constitue un filet de securite fiable.

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Phase 1 complete (agents + skills + flags) | C: Phase 1 minimale (flags seulement) |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** | S | M | S |
| **Valeur ajoutee** | Low | High | Med |
| **Risque technique** | Low | Low | Low |
| *Impact maintenance* | Negatif (dette croissante) | Positif (~843 LOC + 489 LOC md + 775 LOC skills = ~2100 LOC supprimes) | Positif partiel |
| *Reversibilite* | Haute | Faible (git, mais intentionnel) | Haute |

**Option A — Status quo :** Ne rien faire. La dette technique reste, les modules morts continuent d'etre compiles et maintenus. Le risque zero a court terme, mais chaque sprint de migration future sera plus lourd. Non recommande.

**Option B — Phase 1 complete :** Supprimer les modules TypeScript derriere les flags desactives (spec-lite, adversarial-challenge, exploration-scoring, sections dans pipeline.ts/prd-workflow.ts/gate-evaluator.ts), les 5 agents .md obsoletes, et les 3 skills .md obsoletes. Mettre a jour les imports, les tests, et CLAUDE.md. C'est exactement ce que ARCHITECTURE-V2.md prescrit pour Phase 1. Complexite M car plusieurs fichiers touches, mais risque Low car les modules sont bien isoles par des feature flags.

**Option C — Phase 1 minimale :** Ne supprimer que les 3 modules entierement derriere des flags (spec-lite, adversarial-challenge, exploration-scoring), sans toucher pipeline.ts, prd-workflow.ts, ni les agents/.md skills/. Reduit la complexite mais laisse une partie de la dette et necessite une seconde passe plus couteuse. Non recommande.

## Section 5 — Verdict et justification

**Verdict : GO — Option B recommandee.**

**Justification :**

1. **Code clairement mort et identifiable.** Les 6 feature flags sont desactives depuis plusieurs sprints (attestes dans `config/features.json` et dans MEMORY.md). Il n'y a aucun risque de regression fonctionnelle : les guards `isFeatureEnabled(...)` garantissent que ce code ne s'execute jamais en production.

2. **Scope bien delimite.** L'archeologie revele que Phase 1 = suppression de 3 modules entiers (~843 LOC) + sections chirurgicales dans 4 modules (pipeline.ts, prd-workflow.ts, gate-evaluator.ts, llm-router.ts) + 5 agents .md (~489 LOC) + 3 skills .md (~775 LOC). Total approximatif : ~2100 LOC supprimes. Aucune creation de nouveau code.

3. **Cascade d'imports propre.** Les dependances sont unidirectionnelles : spec-lite et adversarial-challenge sont importes par pipeline.ts et prd-workflow.ts, mais pas par d'autres modules actifs. La suppression ne cree pas de breaking change dans les modules conserves — il suffit de retirer les imports et les blocs guards.

4. **Filet de securite solide.** 4035 tests passent actuellement. La suppression des tests specifiques aux modules supprimes (spec-lite.test.ts = 177 LOC, adversarial-challenge.test.ts = 193 LOC, exploration-scoring.test.ts = 302 LOC) est une reduction intentionnelle, pas un signe de regression. Le test `doc-freshness` validera automatiquement la coherence CLAUDE.md / src/ apres mise a jour.

5. **Alignement avec ARCHITECTURE-V2.md.** Phase 1 est explicitement definie comme un prerequis pour les phases suivantes. La commencer maintenant evite que les Phases 2-6 doivent jongler avec du code mort.

6. **Agents et skills orphelins.** Les 5 agents et 3 skills a supprimer n'ont aucune reference TypeScript — leur suppression est purement documentaire et sans risque de regression.

## Section 6 — Input pour etape suivante

### Option recommandee : B (Phase 1 complete)

### Perimetre exact de suppression

**Fichiers TypeScript a supprimer integralement :**
- `src/spec-lite.ts`
- `src/adversarial-challenge.ts`
- `src/exploration-scoring.ts`
- `tests/unit/spec-lite.test.ts`
- `tests/unit/adversarial-challenge.test.ts`
- `tests/unit/exploration-scoring.test.ts`

**Fichiers TypeScript a modifier (suppression chirurgicale) :**
- `src/orchestrator/pipeline.ts` : retirer imports `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `shouldExplore`, `ExplorationScore`, `promoteWorkingMemory` ; retirer blocs P1 (L326-400), P2 (L862-901), memory promotion (L1431-1439)
- `src/prd-workflow.ts` : retirer imports `generateProtoSpec`, `StoryFileInput`, `runAdversarialChallenge`, `runImpactAnalysis` ; retirer fonctions `isPrdMaturationEnabled()`, `runPrdPreflightChecks()` et le type `PreflightReport`
- `src/gate-evaluator.ts` : retirer ~10 lignes du bloc `isFeatureEnabled("exploration_gate")` (L521)
- `src/llm-router.ts` : retirer import `computeExplorationScore` et le bloc `if (isFeatureEnabled("exploration_phase"))` (L97)
- `src/auto-pipeline.ts` : retirer le bloc `isFeatureEnabled("spec_phase_lite")` (L186-192)
- `src/commands/exploration.ts` : retirer la guard `if (!isFeatureEnabled("exploration_phase"))` (L79-82) et l'import `isFeatureEnabled` si plus utilise
- `src/memory.ts` (barrel) : retirer export `promoteWorkingMemory` de memory/graph.ts
- `src/memory/graph.ts` : supprimer la fonction `promoteWorkingMemory()` (L765-855) et les imports associes (`isFeatureEnabled`, `saveAgentMemory`, `graduateAgentMemory` si uniquement utilises dans cette fonction)
- `src/commands/planning.ts` : retirer imports `isPrdMaturationEnabled`, `runPrdPreflightChecks` et le bloc L861-900
- `config/features.json` : retirer les 6 cles : `exploration_phase`, `exploration_gate`, `spec_phase_lite`, `adversarial_challenge`, `prd_maturation_phases`, `memory_promotion`

**Fichiers agents a supprimer :**
- `.claude/agents/impact-analyst.md`
- `.claude/agents/security-checker.md`
- `.claude/agents/test-architect.md`
- `.claude/agents/implementer.md`
- `.claude/agents/tester.md`

**Fichiers skills a supprimer :**
- `.claude/skills/dev-spec/SKILL.md` (et dossier `dev-spec/`)
- `.claude/skills/dev-challenge/SKILL.md` (et dossier `dev-challenge/`)
- `.claude/skills/dev-pipeline/SKILL.md` (et dossier `dev-pipeline/`)

**Fichiers tests a mettre a jour :**
- `tests/unit/orchestrator.test.ts` : supprimer les describes "[V14] Feature Flags for P1/P2/E1/P3", "memory_promotion feature flag", "Working memory promotion in orchestrate()"
- `tests/unit/logger-migration.test.ts` : retirer `adversarial-challenge.ts` et `spec-lite.ts` de `MIGRATED_MODULES`
- `tests/generated/reviser-prd-to-deploy-workflow.test.ts` : supprimer les describes V2, V3, V18 et les mocks `prd_maturation_phases`, `spec_phase_lite`, `adversarial_challenge`
- `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` : supprimer les describes [V1], [V2], [V12] lies a `memory_promotion`
- `tests/unit/memory-evolution.test.ts` : supprimer la section "Feature flag memory_promotion" et les tests dependants

**Documentation a mettre a jour :**
- `CLAUDE.md` : table Dev Pipeline (retirer dev-spec, dev-challenge, dev-pipeline, mettre a jour le workflow) ; liste agents (11 → 6) ; liste skills (7 → 4)

### Contraintes identifiees

- `memory/graph.ts` : conserver le filtre `eq("metadata->>source", "working_memory_promotion")` dans `memoryHealthStats()` (L615) — ce n'est pas derriere un flag, c'est du monitoring de donnees existantes
- `src/commands/exploration.ts` : Phase 1 retire uniquement la guard `exploration_phase`. La commande `/explore` elle-meme sera adaptee en Phase 3 (flow conversationnel). Ne pas supprimer le module entier maintenant.
- `gate-evaluator.ts` est conserve (Phase 4 le supprimera) — supprimer uniquement le bloc `exploration_gate`
- `prd-workflow.ts` est conserve (Phase 5/4 le traitera) — supprimer uniquement les fonctions derriere `prd_maturation_phases`

### Questions ouvertes pour la spec

1. `src/memory/graph.ts` : `promoteWorkingMemory` importe `saveAgentMemory` et `graduateAgentMemory` depuis `memory/agent-memory.ts`. Ces imports sont-ils utilises ailleurs dans `graph.ts` ou uniquement dans `promoteWorkingMemory` ? (Verifier avant de retirer les imports.)
2. Le type `WorkingMemoryData` dans `memory/graph.ts` est-il utilise ailleurs que dans `promoteWorkingMemory` ? (Export dans `memory.ts` barrel — verifier les references.)
3. `tests/generated/reviser-prd-to-deploy-workflow.test.ts` : les tests V2/V3 testent `prd-workflow.ts` qui est conserve. Faut-il garder les tests qui ne testent pas les flags supprimes, ou supprimer le fichier entier et le regenerer plus tard ?
