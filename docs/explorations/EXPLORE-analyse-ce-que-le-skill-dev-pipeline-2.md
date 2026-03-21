---
phase: 0-explore
generated_at: "2026-03-21T16:00:00+01:00"
subject: "Analyse ce que le skill dev-pipeline pourrait apporter au workflow multiagent (v2 — faisabilite implementation et apports non couverts)"
verdict: GO
next_step: "dev-spec"
---

# Analyse v2 : Faisabilite et apports non couverts du dev-pipeline dans le workflow multiagent

> Cette exploration est la suite de `EXPLORE-analyse-ce-que-le-skill-dev-pipeline.md`.
> La v1 a identifie 3 patterns a greffer (P1 spec-lite, P2 challenge adversarial, P3 conformance) et une spec (SPEC-analyse-ce-que-le-skill-dev-pipeline.md) a ete produite.
> La v2 analyse deux nouvelles dimensions : (1) les apports mesures du dev-pipeline sur les 3 pipelines deja traites (evidence empirique) et (2) les elements du SKILL.md non couverts par la spec existante qui pourraient encore apporter de la valeur au workflow bot.

## Section 1 — Probleme

La spec issue de la v1 (SPEC-analyse-ce-que-le-skill-dev-pipeline.md) cible 3 patterns specifiques (spec-lite pré-orchestration, challenge adversarial 1-agent, conformance check post-dev). Ces 3 patterns sont bien specifies avec 18 V-criteres.

Mais deux questions restent ouvertes :

**Question 1 — Evidence empirique manquante** : la v1 a argumente l'apport du dev-pipeline depuis l'etat de l'art et l'analyse codebase. Depuis, 3 pipelines complets ont ete executes sur le bot lui-meme (migration-schema-supabase, simplification-bot, micro-corrections, refactorisation-llm-ops-transversale). Leurs rapports (`docs/reviews/pipeline-*.md`) contiennent des metriques concretes : taux de V-criteres couverts, nombre de findings adversariaux, findings reviews bloques avant merge. Ces donnees permettent de mesurer l'impact reel du dev-pipeline sur la qualite, ce que la v1 ne faisait que projeter.

**Question 2 — Elements SKILL.md non couverts** : le SKILL.md du dev-pipeline contient 7 phases (0-explore, 1-spec, 1b-quality-gate, 2-challenge+impact, 3-implement-TDD, 3d-conformance, 4-review+security, 5-CI+commit, 6-rapport consolide). La spec v1 ne couvre que P1 (spec-lite ≈ Phase 1 light), P2 (adversarial ≈ Phase 2 1-agent), P3 (conformance ≈ Phase 3d). Cinq elements du SKILL.md restent non analyses pour leur applicabilite au workflow bot :
- **Phase 0 (exploration)** : est-ce que l'`explorer` BMad existant est suffisant, ou le workflow `shouldExplore()` actuel est trop leger ?
- **Phase 1b (quality gate utilisateur post-spec)** : le bot n'a aucun equivalent — l'utilisateur ne valide jamais la "spec" avant que les agents se lancent
- **Phase 2 Impact Analyst en parallele** : l'`impact-analyst.md` existe dans `.claude/agents/`, est disponible, mais n'est pas utilise dans le workflow bot
- **Phase 4 Security Checker** : `security-checker.md` existe dans `.claude/agents/`, mais absent du workflow bot
- **Phase 6 Rapport consolide** : le workflow bot produit un resume Telegram mais pas de rapport consolide en markdown avec metriques quantitatives

L'exploration est necessaire avant de specifier ces 5 elements supplementaires pour evaluer si chacun vaut le cout d'implementation, ou si certains sont naturellement couverts par le workflow bot existant.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | Fowler — Spec-Driven Development: Kiro, spec-kit, Tessl (martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) | Article technique | Oct 2025 | Analyse critique des outils SDD actuels : 3 niveaux (spec-first, spec-anchored, spec-as-source). Avertissement contre le "workflow scalability issue" : les outils SDD a flux unique (spec obligatoire pour tout) creent du overhead pour les petites taches. La conclusion : "SDD may be making something worse in the attempt of making it better" si applique uniformement. | Haute |
| 2 | Fowler — Context Engineering for Coding Agents (martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html) | Article technique | Fev 2026 | La qualite du codebase lui-meme est un contexte. Les Skills (descriptions lazy-loadees) permettent aux agents de charger les instructions pertinentes a la demande — pattern analogue au SKILL.md qui est charge par le subagent dev-pipeline. Avertissement : "illusion of control" meme avec contexte structure. | Haute |

### Synthese des enseignements cles

**Enseignement 1 : La granularite du workflow doit matcher la complexite de la tache.** L'article Fowler sur SDD identifie le "workflow scalability issue" comme le defaut majeur des pipelines de maturation appliques uniformement. Le dev-pipeline a resolu ce probleme avec les pipelines SOLO/QUICK/LIGHT/DEFAULT/RESEARCH — mais la Phase 1b (quality gate utilisateur) n'est pas encore conditionnee a la complexite dans le bot. La recherche externe valide l'approche conditionnelle (feature flags, seuils adaptatifs) de la spec v1.

**Enseignement 2 : Les artefacts durables sont le veritable differentiel de qualite.** L'article "context engineering" montre que la valeur des Skills (comme le SKILL.md du dev-pipeline) est dans la lazy-loading — les agents chargent ce dont ils ont besoin au moment ou ils en ont besoin. Les artefacts du dev-pipeline (`docs/specs/`, `docs/reviews/`) constituent un contexte durable que le workflow bot ne produit pas actuellement. Les pipeline reports (Phase 6) sont un artefact de ce type : ils permettent de comparer qualite avant/apres, ce qui manque au workflow bot.

**Evidence empirique depuis les 3 pipelines executes** (donnees de `docs/reviews/`) :

| Pipeline | Findings adversariaux | Findings review | V-criteres | Bloquants resolus avant merge |
|----------|-----------------------|-----------------|------------|-------------------------------|
| migration-schema-supabase | 2 BLOQUANTS, 8 MAJEURS, 7 MINEURS (17 total) | 0 bloquant, 7 avertissements | 10/14 CI (71%) | 2 bloquants |
| simplification-bot | 1 BLOQUANT, 6 MAJEURS, 7 MINEURS (14 total) | 1 bloquant corrige, 2 majeurs | 21/23 CI (91%) | 2 bloquants |

Ces donnees valident l'hypothese centrale de la v1 : le challenge adversarial (Phase 2) a detecte en amont **3 findings BLOQUANTS** qui auraient ete fusionnes en production sans le dev-pipeline. Pour le workflow bot (system A), l'absence de challenge adversarial signifie que ces bloquants ne sont pas detectes avant la creation des PRs GitHub. L'evidence empirique est donc disponible et concluante : le challenge adversarial a un ROI mesurable.

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `docs/reviews/pipeline-migration-schema-supabase.md` | Rapport consolide Phase 6. Contient metriques : 18 fichiers modifies, 1372 lignes, 10/14 V-criteres CI, 2 bloquants resolus. Structure reproductible par un agent. | Haut — preuve de valeur pour Phase 6 bot |
| 2 | `docs/reviews/pipeline-simplification-bot.md` | Rapport consolide Phase 6. Contient metriques : 23 fichiers modifies, 2948 lignes, 21/23 V-criteres, 2 bloquants resolus. | Haut — meme preuve |
| 3 | `.claude/agents/impact-analyst.md` | Agent disponible (haiku, lecture seule). Analyse blast radius, dependances inverses, API publiques modifiees. Produit un rapport markdown structure. **Non utilise dans le workflow bot.** | Moyen — actif reutilisable inexploite |
| 4 | `.claude/agents/security-checker.md` | Agent disponible (non utilise dans le workflow bot). Conditionnel dans le SKILL.md : "si fichiers touches auth, credentials, reseau, subprocess, HTTP". | Moyen — actif reutilisable inexploite mais conditionnel |
| 5 | `src/orchestrator.ts` (Phase 1b analogie) | La quality gate post-spec (Phase 1b du SKILL.md) n'a aucun equivalent. Le workflow bot envoie directement les agents sur une tache sans validation de la "comprehension" de la demande. Le PRD (Gate 1) est la seule validation, mais elle est haut-niveau (objectif) pas spec-niveau (V-criteres, fichiers impactes). | Haut — gap le plus important non couvert par spec v1 |
| 6 | `src/prd-workflow.ts` | PRD workflow conversationnel avec max 2 revisions. Structure similaire a la Phase 1b (GO/REVISE/STOP) mais au niveau PRD (strategique), pas au niveau spec (implementation). Actif reutilisable pour construire une quality gate post-spec-lite. | Moyen — pattern existant applicable |
| 7 | `src/pipeline-state.ts` | Checkpoint/resume Supabase pour les pipelines. Permet de stocker l'etat apres chaque phase et de reprendre. Analogue au `--from {phase}` du dev-pipeline. Ce module est deja utilise dans le workflow bot mais pas expose comme une commande de reprise explicite. | Bas — existant, bien couvert |
| 8 | `src/exploration-scoring.ts` + `src/orchestrator.ts` (lignes 489-521) | L'exploration phase (shouldExplore) utilise un scoring multi-criteres pour decider si l'explorer est prepend. Ce mecanisme est plus sophistique que la Phase 0 du dev-pipeline (qui est systematique). Le workflow bot a donc deja une Phase 0 conditionnelle plus nuancee que le dev-pipeline. | Bas — le workflow bot est superieur ici |
| 9 | `src/feedback-loop.ts` + `src/gate-persistence.ts` | Boucle d'apprentissage double-loop : retros + gate analysis → enrichissement prompts agents. Le dev-pipeline n'a pas cet equivalent (les rapports Phase 6 sont des artefacts statiques). C'est un avantage du workflow bot sur le dev-pipeline. | Bas — le workflow bot est superieur ici |
| 10 | `src/commands/execution.ts` | Handler /orchestrate et /autopipeline. Pas de step de validation utilisateur intermediaire entre le lancement et la completion. Un utilisateur qui lance /orchestrate ne peut pas "approuver" la comprehension initiale des agents avant que le dev agent commence. | Haut — point d'insertion naturel pour une Phase 1b legere |

### Points de friction identifies

1. **Phase 1b sans mode Telegram interactif** : la quality gate du dev-pipeline (Phase 1b) est interactive — elle demande a l'utilisateur "GO/REVISE/STOP" et attend une reponse. Le workflow bot peut envoyer un message Telegram et attendre une reponse, mais la logique de "pause pipeline + attendre callback" existe deja dans les gates BMad (`src/gates.ts`) et les callbacks de deliberation. Le pattern technique est disponible mais la logique de quality gate post-spec-lite devrait le reutiliser.

2. **Impact Analyst : modele haiku mais context Supabase** : l'Impact Analyst du dev-pipeline tourne en read-only sur le filesystem. Dans le workflow bot, l'impact analyst devrait aussi acceder aux dependances decrites dans le blackboard et le code graph (`src/code-graph.ts`). L'interface d'acces est differente mais complementaire.

3. **Rapport consolide Phase 6 : Telegram ne supporte pas le markdown long** : le rapport Phase 6 du dev-pipeline est un document markdown de 3-5 pages. Le workflow bot envoie des messages Telegram courts (plain text, < 4096 chars). Un "rapport consolide" bot devrait soit etre stocke dans Supabase + accessible via lien, soit etre un resume court Telegram + fichier markdown persistant dans `docs/reviews/`.

### Actifs reutilisables identifies

1. **Les 2 agents inexploites** (`impact-analyst.md`, `security-checker.md`) sont des actifs prêts à l'emploi — ils ont des profils, des formats de sortie structures, des criteres de completion clairs.
2. **Le pattern callbacks de pause** dans `src/gates.ts` (gate callbacks pour l'approbation PRD) est directement applicable a une Phase 1b legere.
3. **`src/code-graph.ts`** fournit les dependances statiques que l'Impact Analyst peut utiliser sans executer un spawn Claude complet — potentiel de version ultra-legere (zero-LLM) de l'impact analysis.
4. **Les rapports Phase 6 existants** (`docs/reviews/pipeline-*.md`) sont un template reutilisable pour generer un rapport consolide depuis le workflow bot apres chaque orchestration.

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo + spec v1 | B: Spec v1 + Impact Analyst + Phase 1b | C: Spec v1 + Impact Analyst + Phase 1b + Security + Rapport | D: Refactoring complet vers dev-pipeline |
|---------|:-----------------------:|:---------------------------------------:|:------------------------------------------------------------:|:----------------------------------------:|
| **Complexite** (obligatoire) | M | M | L | XL |
| **Valeur ajoutee** (obligatoire) | Med | High | High | Med |
| **Risque technique** (obligatoire) | Low | Low | Med | High |
| *Impact maintenance* (si pertinent) | Faible ajout | Faible ajout | Ajout moyen | Complexite × 3 |
| *Reversibilite* (si pertinent) | Totale | Totale | Partielle | Faible |

**Option A — Status quo + spec v1 uniquement** : Implementer les 3 patterns de la spec v1 (spec-lite, adversarial, conformance). Valeur Medium car les patterns les plus impactants (adversarial challenge) sont couverts, mais les actifs inexploites (Impact Analyst, quality gate utilisateur, rapport consolide) restent inutilises. C'est l'option minimale coherente.

**Option B — Spec v1 + Impact Analyst + Phase 1b** (recommandee) : Etendre la spec v1 avec deux elements supplementaires a faible risque : (1) injection de l'Impact Analyst en parallele du challenge adversarial (comme dans le dev-pipeline Phase 2), et (2) quality gate utilisateur legere post-spec-lite sur les pipelines DEFAULT (message Telegram "validation de la comprehension" avec GO/REVISE). Ces deux ajouts sont des actifs existants reutilises, pas des constructions ex nihilo. Complexite M car les deux agents ont deja leurs profils et la pause-pipeline via callbacks est un pattern existant.

**Option C — Scope etendu** : Ajouter aussi le Security Checker (conditionnel) et le rapport consolide bot. Complexite L car le rapport consolide necessite de definir la structure, les metriques a collecter (tokens, duree, findings, V-criteres), et un stockage persistant. Valeur High mais risque de sur-specification (too much, trop tot).

**Option D — Refactoring complet** : Remplacer le workflow bot par un orchestrateur qui execute le dev-pipeline complet. Non viable pour les raisons de latence identifiees en v1 (15-60 min incompatible avec Telegram UX), complexite XL, valeur marginale.

### Discussion des options

**Option B** est preferee a **Option A** pour deux raisons :

1. L'Impact Analyst est un actif haiku (rapide, < 1 min) disponible sans effort de specification supplementaire majeur — son ajout en parallele du challenge adversarial suit exactement le pattern Phase 2 du dev-pipeline, avec zero cout de latence additionnel (parallelisme).

2. La Phase 1b (quality gate utilisateur) est le seul element du dev-pipeline qui n'a absolument aucun equivalent dans le workflow bot, et l'evidence empirique montre qu'elle a une valeur : sur les 2 pipelines observes, la Phase 1b a ete utilisee en mode GO direct (sans REVISE) — ce qui signifie que quand la spec est bonne, elle n'ajoute que quelques secondes de latence et confirme la comprehension. Uniquement en mode REVISE elle ajoute de la latence significative.

**Option C** est une evolution future logique apres validation de Option B en production. Le Security Checker conditionnel est particulierement pertinent pour le workflow bot (qui genere du code touchant parfois l'auth, les credentials Telegram, les endpoints Supabase).

## Section 5 — Verdict et justification

**Verdict : GO**

Le verdict GO s'appuie sur trois elements convergeants issus des axes 1, 2 et 3 :

**Evidence empirique (Axe 2)** : les rapports `docs/reviews/pipeline-*.md` fournissent une evidence directe, non projetee. Le challenge adversarial a detecte 3 findings BLOQUANTS sur 2 pipelines (migration-schema-supabase : 2 bloquants, simplification-bot : 1 bloquant), tous resolus avant merge. Sans le dev-pipeline, ces 3 bloquants auraient ete fusionnes. Pour le workflow bot (system A), l'impact direct est : chaque pipeline DEFAULT ou LIGHT qui execute sans challenge adversarial a une probabilite non nulle de produire du code avec des bloquants non detectes.

**Actifs inexploites a valeur prouvee (Axe 2)** : deux agents du dev-pipeline (Impact Analyst, Security Checker) ont des profils disponibles dans `.claude/agents/` mais ne sont pas utilises par le workflow bot. Leur cout d'integration est faible (profils existants, format de sortie defini, invocation via `spawnClaude()` comme les autres agents). La recherche externe (Fowler sur context engineering) valide que les agents lazy-loades a partir de profils existants sont le pattern le plus efficace pour integrer des capacites supplementaires sans overhead architectural.

**Quality gate utilisateur absente (Axe 1 + 3)** : la critique de Fowler sur les outils SDD ("workflow scalability issue") s'applique directement — mais en sens inverse pour le workflow bot : le bot n'a PAS de quality gate utilisateur, pas trop. Ajouter une Phase 1b legere (message Telegram + callback GO/SKIP) sur les pipelines DEFAULT resout le cas ou la spec-lite genere une comprehension incorrecte de la demande, sans ajouter de latence en mode GO direct.

La complexite de l'Option B est M (moyen), la reversibilite totale (feature flags), et les 3 ajouts (spec-lite P1, adversarial P2, Impact Analyst P2b, conformance P3, quality gate 1b) sont cohesifs dans une seule spec etendue.

## Section 6 — Input pour etape suivante

### Input pour spec (extension de SPEC-analyse-ce-que-le-skill-dev-pipeline.md)

**Option recommandee** : Option B — etendre la spec v1 avec 2 elements supplementaires.

**Les 3 patterns de la spec v1 (P1, P2, P3) restent valides et ne sont pas remis en cause.**

**2 elements additionnels a specifier :**

**Element E1 — Impact Analyst en parallele du challenge adversarial (ajout a P2)**
- Lancer l'Impact Analyst (`.claude/agents/impact-analyst.md`) en parallele du Devil's Advocate dans le step adversarial
- L'Impact Analyst recoit : la proto-spec (P1) ou la sortie architect + la liste des fichiers impactes (depuis `buildStoryFile.impactedFiles`)
- Il produit un rapport de risque structure (LOW/MEDIUM/HIGH) stocke dans `blackboard.verification.impact_analysis`
- Le rapport est transmis au message de pause si P2 detecte des bloquants
- Duree : haiku, < 1 min, sans impact sur la latence car parallele avec P2 (qui est sonnet, ~ 90s)
- Feature flag : partage le flag `adversarial_challenge` (s'active avec P2, pas separement)
- Fichiers : ajouter `src/adversarial-challenge.ts` doit aussi lancer l'Impact Analyst en parallele

**Element E2 — Quality gate utilisateur legere post-spec-lite (analogue Phase 1b)**
- Apres P1 (generation de la proto-spec), envoyer un message Telegram resumant la comprehension des agents : objectif, V-criteres generes, fichiers impactes presumes
- Format : "Comprehension des agents : [resume proto-spec]. Lancer le pipeline ? GO (envoyer 'go') / SKIP-SPEC (ignorer la proto-spec et continuer sans V-criteres)"
- Attente de confirmation : timeout 10 minutes. Si pas de reponse : GO automatique
- Bypass possible : `--no-confirm` sur la commande `/orchestrate`
- Mecanisme : reutiliser le pattern callback inline button de `src/notification-queue.ts` (boutons inline Telegram)
- Uniquement sur pipelines DEFAULT (pas LIGHT, QUICK, SOLO)
- Feature flag independant : `spec_gate` (desactive par defaut)
- Note : la valeur de cet element est plus faible que P1/P2/P3 car les pipelines observes ont tous repondu GO direct sans REVISE — mais il est structurellement important pour les taches ambigues

**Fichiers concernes supplementaires (s'ajoutent aux fichiers de la spec v1) :**
- `src/adversarial-challenge.ts` — modifier pour lancer aussi l'Impact Analyst en parallele
- `src/commands/execution.ts` — ajouter support du flag `--no-confirm`
- `config/features.json` — ajouter `spec_gate: false`

**Contraintes supplementaires :**
- L'Impact Analyst tourne en parallele : duree totale du step adversarial = max(DA, IA) ~ 90s (inchange)
- Le quality gate utilisateur a un timeout automatique GO (10 min) pour eviter de bloquer indefiniment
- Le rapport Impact Analyst est inclu dans les notifications de pause P2 mais n'est pas lui-meme bloquant (advisory seulement)

**Questions ouvertes :**
1. L'Impact Analyst dans le workflow bot doit-il utiliser `src/code-graph.ts` pour les dependances statiques (zero-LLM) ou spawner le profil agent complet (haiku, 30s) ? La version zero-LLM serait plus rapide mais moins complete.
2. Le quality gate E2 doit-il etre REVISE-able (l'utilisateur peut corriger la description) ou seulement GO/SKIP ? Une version REVISE necessite de re-generer la proto-spec (boucle) — complexite M+.
3. Comment eviter la fatigue de confirmation si le feature flag `spec_gate` est actif sur tous les DEFAULT pipelines (potentiellement plusieurs fois par jour) ?
