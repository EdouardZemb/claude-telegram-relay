## Rapport d'impact : Integration hybride des patterns dev-pipeline dans le workflow multiagent

> Genere le 2026-03-21 a partir de docs/specs/SPEC-analyse-ce-que-le-skill-dev-pipeline.md.

### Niveau de risque : MEDIUM

### Resume

Le changement greffe 5 elements (P1 spec-lite, P2 adversarial challenge, E1 impact analyst, E2 quality gate utilisateur, P3 conformance check) dans le workflow multiagent existant. Les 5 elements sont derriere 3 feature flags desactives par defaut, ce qui limite le risque de regression immediate. Cependant, la modification directe de `orchestrator.ts` (fichier central importe par 14 modules) et `adversarial-verifier.ts` (API publique modifiee avec ajout de `checkConformance`) represente un blast radius MEDIUM avec des chemins d'integration complexes a valider.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/orchestrator.ts` | Direct | Insertion de 4 steps conditionnels dans la boucle pipeline (P1 avant agents, P2+E1 apres architect, E2 apres P1, P3 avant qa). Modifications dans le corps de `orchestrate()` (~lignes 458-1360). Pas de modification des exports publics (AgentRole, OrchestrateOptions, etc.) |
| `src/adversarial-verifier.ts` | Direct | Ajout de la fonction `checkConformance(protoSpec, devOutput)`. Export public ajoute (backward-compatible). La logique existante de `verifySpecVsImplementation` n'est pas modifiee |
| `src/auto-pipeline.ts` | Direct | Ajout de la phase spec-lite entre story enrichment et analysis. La fonction `runAutoPipeline` est modifiee pour passer la proto-spec au contexte d'orchestration |
| `src/commands/execution.ts` | Direct | Ajout des flags `--skip-challenge` et `--no-confirm` dans le parser `/orchestrate`. Ajout de callback handlers `specgate_go:` et `specgate_skip:` pour les boutons inline E2 |
| `src/agent-schemas.ts` | Direct | Ajout des interfaces `ProtoSpec`, `AdversarialResult`, `ImpactAnalysisResult`. Export public ajoute (backward-compatible) |
| `config/features.json` | Direct | Ajout de 3 flags : `spec_phase_lite`, `adversarial_challenge`, `spec_gate` (tous false) |
| `src/spec-lite.ts` | Direct (creation) | Nouveau module : `generateProtoSpec()`. Importe `agent.ts`, `blackboard.ts`, `feature-flags.ts` |
| `src/adversarial-challenge.ts` | Direct (creation) | Nouveau module : `runAdversarialChallenge()`, `runImpactAnalysis()`. Importe `agent.ts`, `code-graph.ts`, `feature-flags.ts` |
| `src/blackboard.ts` | Indirect | Pas de modification du code mais les sections `spec.proto_spec`, `verification.adversarial_challenge`, `verification.impact_analysis` et `verification.conformance` sont ecrites par les nouveaux steps. Le type `BlackboardSections` et `SectionName` ne sont pas modifies (JSONB flexible). Impact nul sur le code existant |
| `src/code-graph.ts` | Indirect | `getImpactRadius()` est appele par E1 (`adversarial-challenge.ts`). Pas de modification. Nouveau consommateur de l'API publique existante |
| `src/feature-flags.ts` | Indirect | `isFeatureEnabled()` est appele pour les 3 nouveaux flags. Pas de modification du module. Le fichier `config/features.json` est modifie (ajout de cles) |
| `src/agent.ts` | Indirect | `spawnClaude()` est appele par les 2 nouveaux modules (`spec-lite.ts`, `adversarial-challenge.ts`). Pas de modification |
| `src/pipeline-selection.ts` | Aucun | Aucune modification (les steps sont injectes dynamiquement, pas de nouveaux pipelines) |
| `src/pipeline-state.ts` | Aucun | Pas de modification, mais le resume pipeline devra etre verifie pour gerer les nouveaux steps conditionnels |
| `src/deliberation.ts` | Aucun | Pas impacte — importe AgentRole et runAgentStep mais les deux ne changent pas |
| `src/llm-router.ts` | Aucun | Pas impacte |
| `src/agent-context.ts` | Aucun | Pas impacte |
| `src/mcp-config.ts` | Aucun | Pas impacte |
| `src/feedback-loop.ts` | Aucun | Pas impacte |
| `src/agent-messaging.ts` | Aucun | Pas impacte |
| `src/agent-events.ts` | Aucun | Pas impacte |
| `src/llm-ops.ts` | Aucun | Pas impacte |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/adversarial-verifier.ts` | `checkConformance()` | Ajout | Oui |
| `src/agent-schemas.ts` | `ProtoSpec` (interface) | Ajout | Oui |
| `src/agent-schemas.ts` | `AdversarialResult` (interface) | Ajout | Oui |
| `src/agent-schemas.ts` | `ImpactAnalysisResult` (interface) | Ajout | Oui |
| `src/spec-lite.ts` | `generateProtoSpec()` | Creation (nouveau module) | Oui |
| `src/adversarial-challenge.ts` | `runAdversarialChallenge()` | Creation (nouveau module) | Oui |
| `src/adversarial-challenge.ts` | `runImpactAnalysis()` | Creation (nouveau module) | Oui |
| `src/orchestrator.ts` | `orchestrate()` | Modification interne (pas de changement de signature) | Oui |
| `src/auto-pipeline.ts` | `runAutoPipeline()` | Modification interne (pas de changement de signature) | Oui |

### Breaking changes potentiels

Aucun breaking change identifie au niveau des exports publics. Tous les changements sont des ajouts ou des modifications internes conditionnees par des feature flags desactives par defaut. Cependant :

- [ ] **Risque de regression dans `orchestrate()`** : la fonction fait ~900 lignes et contient la logique critique du pipeline multiagent. L'insertion de 4 steps conditionnels dans le corps de cette fonction augmente la complexite cyclomatique et le risque de bugs subtils (ex: mauvaise valeur de `bbVersion` apres un step conditionnel, `messages[]` desynchronise si P1/E2 ajoutent des entries) — **impact** : tous les consommateurs de `orchestrate()` (auto-pipeline.ts, commands/execution.ts)
- [ ] **Risque de conflit de callbacks** : l'ajout des callbacks `specgate_go:` et `specgate_skip:` dans `execution.ts` introduit un nouveau namespace de callbacks. Si d'autres Composers utilisent des prefixes similaires sans filtrage `next()`, il y a risque de collision — **impact** : commands/execution.ts, commands/planning.ts (qui a deja `prdwf_*`)
- [ ] **Risque sur pipeline resume (S33)** : si un pipeline est resume apres un P1 ou E2, la logique de resume doit savoir si ces steps conditionnels ont deja ete executes. La spec ne couvre pas explicitement ce scenario — **impact** : orchestrator.ts, pipeline-state.ts

### Points d'attention pour le Reviewer

1. **Complexite de `orchestrate()` apres modification** : la fonction `orchestrate()` (src/orchestrator.ts, ~lignes 458-1490) est deja la plus complexe du codebase. L'insertion de 4 blocs conditionnels (P1, E2, P2+E1, P3) a des points differents de la boucle pipeline va augmenter significativement sa complexite. Verifier que les conditions de guard (`isFeatureEnabled`, pipeline type check, flag `--skip-challenge`/`--no-confirm`) sont mutuellement exclusives et correctes. Considerer si les steps conditionnels ne devraient pas etre extraits dans des fonctions dediees appelees depuis `orchestrate()`.

2. **Coherence du blackboard version (`bbVersion`)** : les steps P1, P2+E1, E2, P3 ecrivent tous dans le blackboard via `writeSection()`. Chaque ecriture incremente `bbVersion` (optimistic locking). Si un step conditionnel est saute (flag off), le `bbVersion` doit rester correct pour les ecritures suivantes. Verifier dans src/orchestrator.ts que le `bbVersion` n'est pas incremente quand un step est saute.

3. **Type `AgentRole` preserve** : la spec insiste (section 7, contrainte "Type safety") que `AgentRole` n'est PAS etendu. Verifier que les nouveaux steps sont bien des fonctions standalone (`generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `checkConformance`) et non de nouveaux agents dans le type union. Le type `AgentRole` est utilise dans 15 fichiers — tout ajout de valeur casserait les switch/map exhaustifs dans pipeline-selection.ts, agent-schemas.ts, bmad-agents.ts, mcp-config.ts, etc.

4. **Comportement E2 timeout + resume pipeline** : E2 utilise un timeout de 10 minutes avec GO implicite (R20). Ce timer doit etre gere cote bot (dans execution.ts via le callback handler), pas dans orchestrator.ts. Verifier que le mecanisme de pause/reprise du pipeline fonctionne correctement avec le `Promise` pattern (probablement un `new Promise` avec `setTimeout` et resolution via callback). Verifier aussi que le timer est nettoye si l'utilisateur repond avant les 10 minutes.

5. **Tests existants a adapter** : 5 fichiers de tests existants totalisent 1519 lignes. Les tests de orchestrator.test.ts (351 lignes), adversarial-verifier.test.ts (177 lignes) et auto-pipeline.test.ts (183 lignes) devront etre adaptes pour couvrir les chemins conditionnels. Verifier que les tests existants passent toujours sans modification quand les flags sont off (R12).

6. **Ajout de flags dans config/features.json** : le fichier contient actuellement 7 flags. L'ajout de 3 flags supplementaires ne doit pas modifier les valeurs existantes (V15). Le flag `llmops_monitoring` a ete recemment change de `false` a `true` (fichier modifie dans le git status actuel) — verifier que cette modification n'entre pas en conflit.

### Blast radius

- Modules directement modifies : 6 (orchestrator.ts, adversarial-verifier.ts, auto-pipeline.ts, commands/execution.ts, agent-schemas.ts, config/features.json)
- Modules crees : 2 (spec-lite.ts, adversarial-challenge.ts)
- Modules indirectement impactes : 5 (blackboard.ts, code-graph.ts, feature-flags.ts, agent.ts, pipeline-state.ts)
- Fichiers de test a creer : 2 (spec-lite.test.ts, adversarial-challenge.test.ts)
- Fichiers de test a modifier : 3 (orchestrator.test.ts, adversarial-verifier.test.ts, auto-pipeline.test.ts)
