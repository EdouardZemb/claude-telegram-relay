---
phase: 0-explore
generated_at: "2026-03-21T00:00:00Z"
subject: "Réviser le workflow PRD-to-Deploy pour intégrer les phases de maturation (spec-lite, adversarial challenge, impact analysis, conformance check)"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

### Origine

Le workflow PRD-to-Deploy (`src/prd-workflow.ts`, feature flag `prd_to_deploy`) est un workflow conversationnel accessible depuis Telegram via `/prd_workflow`. Il orchestre une séquence linéaire : triage de complexité → génération de PRD → révision bornée (max 3) → décomposition en tâches → confirmation de lancement → exécution du pipeline auto (`runBatchPipeline`) → notification de fin.

Ce workflow couvre la partie "planification et lancement" mais délègue l'exécution à `auto-pipeline.ts` qui, à son tour, invoque l'orchestrateur (`src/orchestrator.ts`). Or, l'orchestrateur dispose déjà de trois phases de maturation (P1, P2, P3) qui ne sont pas exposées de façon conversationnelle dans le workflow PRD-to-Deploy :

- **P1 spec-lite** (`src/spec-lite.ts`) : génère une proto-spec avec V-critères et fichiers impactés avant l'orchestration.
- **P2 adversarial challenge** (`src/adversarial-challenge.ts`) : Devil's Advocate qui détecte les failles bloquantes avant dev.
- **E1 impact analysis** (`src/adversarial-challenge.ts`) : analyse d'impact blast radius via code-graph.
- **P3 conformance check** (`src/adversarial-verifier.ts`) : vérifie que l'implémentation satisfait les V-critères.

Ces phases existent dans l'orchestrateur mais sont gouvernées par des feature flags (`spec_phase_lite`, `adversarial_challenge`) qui sont **désactivés par défaut** dans `config/features.json` (état actuel : `false`). Le workflow `/prd_workflow` ne les expose pas du tout : il ne montre aucun résultat de spec-lite, ne présente pas les findings adversariaux à l'utilisateur, et ne rapporte pas le conformance score.

### Pourquoi explorer maintenant

Le dev-pipeline Claude Code (`.claude/skills/`) expose ces phases de façon explicite avec des artefacts, des gates et des pauses humain-dans-la-boucle. Le workflow PRD-to-Deploy accessible depuis Telegram devrait offrir une expérience équivalente : l'utilisateur devrait voir la proto-spec, être alerté des findings bloquants, et recevoir un rapport de conformance. Cela réduit le risque de lancer des implémentations sur des specs mal formées.

L'exploration est nécessaire car l'intégration soulève des questions d'architecture UX non triviales : comment présenter ces phases dans un contexte conversationnel Telegram (contrainte des 64 bytes sur les callbacks, TTL des sessions, notifications asynchrones) sans dégrader la fluidité du workflow ?

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://www.softwareseni.com/spec-driven-development-in-2025-the-complete-guide-to-using-ai-to-write-production-code/ | Article/Guide | 2025 | Spec-driven development : les specs formelles comme blueprint exécutables pour l'IA. Quality gates intégrés au cycle : spec → génération → validation. Recommande une approche test-first dans la spec elle-même. | Haute |
| 2 | https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt/ | Blog officiel LangChain | 2025 | LangGraph `interrupt` : mécanisme natif pour pauser un pipeline agent et attendre une décision humaine, puis reprendre depuis le checkpoint persisté. Pattern central pour les workflows multi-étapes avec approbation. | Haute |
| 3 | https://www.augmentcode.com/guides/ai-spec-driven-development-workflows | Guide technique | 2025 | AI dans SDD : agents pour la validation de spec, détection de dérive (drift detection), et génération de tâches atomiques. Insiste sur le fait que les gains dépendent d'une implémentation structurée avec contexte architectural. | Haute |
| 4 | https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-ai-framework-2025-complete-architecture-guide-multi-agent-orchestration-analysis | Architecture guide | 2025 | LangGraph HITL patterns : approve/reject, edit state, review LLM output. Persistent state permet de pauser, laisser l'humain modifier, reprendre. | Moyenne |

### Synthèse des enseignements clés

**1. Les quality gates en-ligne sont le pattern dominant.** L'état de l'art 2025 en SDD converge vers des pipelines où chaque étape produit un artefact validé avant de passer à la suivante. Les gates ne bloquent pas définitivement — ils offrent un mécanisme de pause-révision-reprise. Le codebase dispose déjà de cette infrastructure dans l'orchestrateur (`onAdversarialPause`, `evaluateAndRework`).

**2. Le human-in-the-loop conversationnel est une interface de première classe.** LangGraph `interrupt` montre qu'il est acceptable de persister l'état d'un pipeline, notifier l'humain, et attendre une décision asynchrone. Telegram + grammY (avec les InlineKeyboard callbacks) est architecturalement équivalent : les boutons `prdwf_*` sont des interruptions persistées en session.

**3. La spec-lite avant la génération du PRD est une opportunité manquée.** L'état de l'art recommande que la spec soit le premier artefact produit, pas une conséquence du PRD. Dans le workflow actuel, la proto-spec est générée *après* le PRD et *avant* le lancement de l'orchestrateur — elle n'est jamais montrée à l'utilisateur dans le contexte PRD-to-Deploy.

**4. Le drift detection est critique.** Augment Code et d'autres outils 2025 insistent sur la détection de dérive spec/implémentation. Le `checkConformance` P3 du codebase est exactement ce pattern, mais il n'est reporté que dans les logs internes, pas exposé dans le workflow Telegram.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/prd-workflow.ts` | Module central du workflow. Contient 7 fonctions (F1 triage, F2 génération, F3 révision, F4 décomposition, F5 confirmation, F6 gate notifications, F7 PR merge). Pas d'appels à `generateProtoSpec`, `runAdversarialChallenge`, ou `checkConformance`. | Haut — fichier principal à enrichir |
| 2 | `src/commands/planning.ts` | Composer Telegram. Gère les callbacks `prdwf_*`. La step `prdwf_launch` lance directement `runBatchPipeline` sans phase de spec-lite préalable. Session state `prdWorkflowStep` a 6 valeurs mais pas de valeur pour les nouvelles phases. | Haut — callbacks à ajouter |
| 3 | `src/orchestrator.ts` | L. 682-742 : P1 spec-lite. L. 1123-1239 : P2+E1 adversarial + impact. L. 1243-1294 : P3 conformance. Ces phases existent mais sont invoquées *pendant* l'orchestration des agents, pas *avant* le lancement de la batch pipeline depuis le workflow PRD. | Moyen — actifs réutilisables |
| 4 | `src/spec-lite.ts` | `generateProtoSpec(task, storyFile, agentContext)` → `ProtoSpec`. Fonction standalone prête à l'emploi. Cible < 60s (haiku model). | Faible — actif réutilisable direct |
| 5 | `src/adversarial-challenge.ts` | `runAdversarialChallenge(input)` + `runImpactAnalysis(files)` en `Promise.all`. Retourne `AdversarialResult` avec verdict PASS/PAUSE/SKIPPED + findings classés. | Faible — actif réutilisable direct |
| 6 | `src/adversarial-verifier.ts` | `checkConformance(protoSpec, devOutput)` → `DriftReport`. `formatDriftReport(report)` pour affichage Telegram. | Faible — actif réutilisable direct |
| 7 | `src/conversation-session.ts` | `prdWorkflowStep` : 6 valeurs (`triage | generation | revision | decomposition | implementation | done`). Il faudrait ajouter `spec_review` et `challenge_review`. TTL 2h — suffisant. | Moyen — extension de type |
| 8 | `config/features.json` | `spec_phase_lite: false`, `adversarial_challenge: false`, `prd_to_deploy: true`. Les nouvelles phases devraient partager les flags existants ou avoir leur propre flag `prd_maturation_phases`. | Moyen — configuration |
| 9 | `src/notification-queue.ts` | `enqueue({ type, severity, message })` déjà utilisé par `notifyGateResult` dans `prd-workflow.ts`. Infrastructure de notification asynchrone prête. | Faible — actif réutilisable |
| 10 | `src/job-manager.ts` | Gère les jobs async. Le job `prd-decompose` envoie déjà un bouton `prdwf_launch` au résultat. Le nouveau job `prd-spec-challenge` devrait envoyer un bouton `prdwf_spec_ok` ou `prdwf_spec_pause`. | Moyen — extension jobs |
| 11 | `src/prd.ts` | Template PRD sans section V-critères. La proto-spec pourrait enrichir automatiquement le PRD en V-critères post-approbation. | Moyen — opportunité |
| 12 | `tests/unit/prd-workflow*.test.ts` | 1567 lignes de tests sur le workflow existant. Zéro test couvrant l'intégration spec-lite/adversarial dans ce contexte. | Moyen — effort test à prévoir |

### Points de friction identifiés

1. **Contrainte callback Telegram ≤ 64 bytes** : les nouveaux boutons `prdwf_spec_ok`, `prdwf_spec_pause`, `prdwf_challenge_resume:` doivent rester sous la limite. Le pattern actuel stocke les données dans `pendingDescriptions`/`pendingRevisions` en mémoire — le même pattern s'applique pour stocker `protoSpec`.

2. **Feature flags conditionnels** : si `spec_phase_lite` est désactivé, le workflow doit skiper silencieusement la phase et passer directement au lancement. Les nouvelles phases doivent respecter les flags existants.

3. **Asynchronicité et job manager** : les phases P1/P2 peuvent prendre 60-180s. Elles doivent être lancées en background via `launchJob` et notifier via la notification queue, pas bloquer le handler Telegram (timeout 30s).

4. **Le `prdWorkflowStep` dans la session** : ne reflète pas les nouvelles phases. La session doit être étendue sans breaking change.

5. **Pas de `protoSpec` stockée dans la session** : la proto-spec générée avant le lancement doit être persistée (Supabase blackboard ou mémoire session) pour être passée au conformance check après implémentation.

### Actifs réutilisables

- `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `checkConformance`, `formatDriftReport` : toutes des fonctions standalone testées, prêtes à l'emploi.
- `notifyGateResult` dans `prd-workflow.ts` : pattern de notification déjà établi.
- `pendingDescriptions` / `pendingRevisions` maps : pattern de stockage temporaire session → réutilisable pour `pendingProtoSpec`.
- `buildRevisionKeyboard` : modèle de keyboard avec conditionnels → inspirant pour les nouveaux keyboards.
- `InlineKeyboard` + callbacks `prdwf_*` dans `planning.ts` : infrastructure callback complète.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Intégration transparente (flags existants) | C: Nouvelles étapes conversationnelles explicites | D: Phase pre-launch dédiée |
|---------|:------------:|:----------------------------------------------:|:------------------------------------------------:|:--------------------------:|
| **Complexité** (obligatoire) | S | M | L | M |
| **Valeur ajoutée** (obligatoire) | Low | Med | High | High |
| **Risque technique** (obligatoire) | Low | Low | Med | Low |
| *Impact maintenance* | Négligeable | Faible (flags existants) | Moyen (nouveaux callbacks, types) | Faible (module isolé) |
| *Réversibilité* | N/A | Haute (flags) | Moyenne (refactor session) | Haute (feature flag) |

### Discussion par option

**A — Status quo.** Le workflow PRD-to-Deploy délègue tout à l'orchestrateur qui, si les flags sont activés, exécute silencieusement P1/P2/P3. L'utilisateur Telegram ne voit jamais les résultats de spec-lite ou adversarial. Valeur ajoutée nulle depuis la perspective UX conversationnelle. Acceptable uniquement si on ne veut pas investir.

**B — Intégration transparente avec flags existants.** Lors de la step `prdwf_launch`, avant de lancer `runBatchPipeline`, exécuter P1+P2 en background et reporter les résultats via notification queue. Si P2 retourne PAUSE, envoyer un bouton `prdwf_challenge_resume`. Réutilise les flags `spec_phase_lite` et `adversarial_challenge` existants. Complexité M car il faut gérer l'asynchronicité et le stockage de la proto-spec. Ne requiert pas de nouveaux `prdWorkflowStep`. C'est l'option la plus pragmatique : elle enrichit le workflow sans le restructurer.

**C — Nouvelles étapes conversationnelles explicites.** Ajouter deux nouvelles phases visibles dans la conversation : une étape "Revue de spec" (affiche la proto-spec et demande confirmation) et une étape "Challenge adversarial" (présente les findings et propose de continuer/arrêter). Cela crée une expérience plus riche mais allonge le workflow (2 étapes de plus, chacune avec un cycle question/réponse). Requiert de nouveaux `prdWorkflowStep`, de nouveaux callbacks Telegram, et un stockage intermédiaire de la proto-spec. Complexité L. Risque d'abandon utilisateur si le workflow est trop long.

**D — Module pre-launch dédié (`prdwf_preflight`).** Extraire toute la logique de maturation dans une fonction `runPrdPreflightChecks(prd, tasks)` appelée depuis `prdwf_launch`. Cette fonction exécute P1→P2→E1 en séquence/parallèle, produit un rapport synthétique, et le présente à l'utilisateur avec un seul bouton de confirmation. Un seul nouveau callback `prdwf_preflight_ok`. Complexité M, réversibilité haute (derrière un flag `prd_maturation_phases`), valeur ajoutée haute car l'utilisateur a une vue consolidée avant de lancer.

---

## Section 5 — Verdict et justification

**Verdict : GO — Option D (module pre-launch dédié) avec élément de B (flags existants).**

**Justification :**

L'état de l'art (sources 1-4) confirme que l'exposition explicite des quality gates est une pratique de premier ordre en 2025 pour les pipelines AI-driven. Le codebase dispose déjà de tous les actifs nécessaires : `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `checkConformance` sont des fonctions standalone testées qui n'attendent que d'être invoquées depuis le workflow PRD-to-Deploy.

L'archéologie (axe 2) révèle que la séquence dans l'orchestrateur (P1 → P2+E1 → dev → P3) peut être transposée naturellement : P1+P2+E1 avant `prdwf_launch`, P3 après le batch pipeline. Le pattern de notification asynchrone via `job-manager` + `notification-queue` est déjà opérationnel dans le workflow (voir `prd-decompose` job).

L'option D est retenue car elle minimise le nombre de nouvelles interactions conversationnelles (un seul checkpoint supplémentaire : le rapport de preflight avant lancement) tout en maximisant la valeur : l'utilisateur reçoit un résumé consolidé — proto-spec, findings adversariaux, risque d'impact — et décide en connaissance de cause. Elle respecte les flags existants (`spec_phase_lite`, `adversarial_challenge`) pour la rétrocompatibilité et peut être activée via un nouveau flag `prd_maturation_phases` sans rien casser.

L'option C est écartée car elle fragmente trop le workflow en étapes séquentielles, augmentant le risque d'abandon et la complexité de la gestion de session. L'option B est moins complète que D car elle ne présente pas de rapport consolidé à l'utilisateur.

---

## Section 6 — Input pour étape suivante

### Option recommandée

**Option D : module pre-launch dédié `runPrdPreflightChecks`**, intégré dans `src/prd-workflow.ts` derrière le flag `prd_maturation_phases`.

### Fichiers concernés par la spec

| Fichier | Changement |
|---------|-----------|
| `src/prd-workflow.ts` | Nouvelle fonction `runPrdPreflightChecks(prd, tasks, agentContext)` + `buildPreflightReport(protoSpec, adversarial, impact)` + `storePendingProtoSpec(chatKey, protoSpec)` |
| `src/commands/planning.ts` | Nouveau callback `prdwf_preflight_ok` + `prdwf_preflight_abort` dans le handler `prdwf_*`. Modification de `prdwf_launch` pour invoquer preflight avant batch. |
| `src/conversation-session.ts` | Ajout de `spec_preflight` dans l'union type de `prdWorkflowStep`. |
| `config/features.json` | Ajout du flag `prd_maturation_phases: false`. |
| `tests/unit/prd-workflow.test.ts` | Nouveaux tests pour `runPrdPreflightChecks`, `buildPreflightReport`, callbacks `prdwf_preflight_*`. |

### Contraintes identifiées

1. **Asynchronicité obligatoire** : `runPrdPreflightChecks` doit être lancé via `launchJob` (car P1 ~60s + P2 ~90s = ~150s, au-delà du timeout Telegram). Le résultat doit être envoyé via `notification-queue`.

2. **Stockage proto-spec** : ajouter `pendingProtoSpecs: Map<string, ProtoSpec>` dans `prd-workflow.ts` avec TTL 10 minutes, pattern identique à `pendingDescriptions`.

3. **Respect des flags** : si `spec_phase_lite` est off → skiper P1, si `adversarial_challenge` est off → skiper P2+E1. Si les deux sont off et `prd_maturation_phases` est on → n'afficher que l'avertissement "phases désactivées".

4. **P3 conformance post-batch** : intégrer le conformance check *après* `runBatchPipeline` via le résultat du job. Peut être ajouté au message de fin de job dans `job-manager.ts` (voir L.213-217 où le bouton launch est déjà ajouté).

5. **Callback ≤ 64 bytes** : `prdwf_preflight_ok` = 18 bytes. `prdwf_preflight_abort` = 21 bytes. Dans les limites.

### Questions ouvertes à résoudre pendant la spec

1. **Granularité du rapport preflight** : afficher tous les findings adversariaux ou seulement les BLOQUANTS ? (Recommandation : BLOQUANTS toujours, MAJEURS si ≤ 3, MINEURS jamais dans le résumé Telegram.)

2. **Comportement si preflight PAUSE** : l'utilisateur peut-il modifier le PRD puis relancer ? Ou doit-il créer un nouveau PRD ? (Recommandation : offrir un bouton `prdwf_revise:{prdId}` depuis le rapport de pause, pour éviter un cul-de-sac.)

3. **P3 conformance post-batch** : le conformance check nécessite le `devOutput` de chaque tâche. Comment agréger les résultats de plusieurs tâches dans un batch ? (Recommandation : conformance par tâche, score moyen global.)

4. **Feature flag `prd_maturation_phases` vs réutilisation de `spec_phase_lite`** : un seul flag global PRD ou deux flags fins ? (Recommandation : un flag global `prd_maturation_phases` qui délègue aux flags existants pour la mécanique, mais garde un point d'entrée unique pour l'UX.)

5. **Impact sur les tests** : les tests existants (`prd-workflow.test.ts`, `prd-workflow-comprehensive.test.ts`) mockent `generateAndSavePRD` et `decomposePRDIntoTasks`. Les nouveaux tests devront mocker `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`. Prévoir ~50 nouveaux tests.

### Input pour spec (bloc structuré)

```yaml
input_pour_spec:
  module_principal: src/prd-workflow.ts
  nouvelles_fonctions:
    - runPrdPreflightChecks(prd, tasks, options) -> PreflightReport
    - buildPreflightReport(protoSpec, adversarial, impact) -> string
    - storePendingProtoSpec(chatKey, protoSpec) -> void
    - getPendingProtoSpec(chatKey) -> ProtoSpec | undefined
  nouveaux_callbacks_telegram:
    - prdwf_preflight_ok
    - prdwf_preflight_abort
  nouveau_flag:
    name: prd_maturation_phases
    default: false
    doc: "Active P1+P2+E1 avant le lancement et P3 après dans le workflow PRD-to-Deploy"
  sequence_enrichie:
    - F1: triage
    - F2: génération PRD
    - F3: révision bornée
    - F4: décomposition en tâches (post-approbation)
    - F4b: [NOUVEAU] preflight checks P1+P2+E1 (si prd_maturation_phases ON)
    - F5: confirmation de lancement
    - F6: batch pipeline (runBatchPipeline)
    - F6b: [NOUVEAU] conformance report P3 (si prd_maturation_phases ON)
    - F7: PR merge notification
  tests_a_ecrire: ~50 nouveaux tests
  effort_estime: M (2-3 jours, pipeline LIGHT)
```
