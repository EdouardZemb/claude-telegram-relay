## Rapport d'impact : Nettoyage du code mort (Phase 1 — Architecture V2)

> Genere le 2026-03-24 a partir de docs/specs/SPEC-nettoyage-du-code-mort.md.

### Niveau de risque : MEDIUM

### Resume

Le changement supprime 3 modules TypeScript autonomes (843 LOC) et retire chirurgicalement des blocs gardes par 6 feature flags desactives dans 8 modules existants. Les dependances des modules supprimes sont unidirectionnelles et confinables, mais un breaking change non couvert par la spec a ete identifie : `src/job-manager.ts` importe `buildPreflightKeyboard` depuis `prd-workflow.ts`, fonction listee pour suppression sans que `job-manager.ts` figure dans la liste des fichiers a modifier. Ce point doit etre traite explicitement avant implementation.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/spec-lite.ts` | Direct — suppression | Module entier (189 LOC). Importe par `orchestrator/pipeline.ts`, `prd-workflow.ts`, `auto-pipeline.ts` (import dynamique). |
| `src/adversarial-challenge.ts` | Direct — suppression | Module entier (362 LOC). Importe par `orchestrator/pipeline.ts`, `prd-workflow.ts`. |
| `src/exploration-scoring.ts` | Direct — suppression | Module entier (292 LOC). Importe par `llm-router.ts`, `commands/exploration.ts` (via `isFeatureEnabled`). |
| `src/orchestrator/pipeline.ts` | Direct — modification | Retirer 3 imports et 3 blocs gardes : P1 (L325-412), P2+E1 (L859-950), memory_promotion (L1430-1451). |
| `src/prd-workflow.ts` | Direct — modification | Retirer imports `adversarial-challenge` + `spec-lite`, types/fonctions `prd_maturation_phases` (L51-L800+). |
| `src/gate-evaluator.ts` | Direct — modification | Retirer bloc `exploration_gate` (~10 lignes L521-529). |
| `src/llm-router.ts` | Direct — modification | Retirer import `computeExplorationScore` + bloc `exploration_phase` (L95-108). |
| `src/auto-pipeline.ts` | Direct — modification | Retirer import dynamique `spec-lite` + bloc `spec_phase_lite` (L185-205). |
| `src/commands/exploration.ts` | Direct — modification | Retirer guard `exploration_phase` (L79-82). `isFeatureEnabled` importe en L21 et utilise uniquement pour ce guard : l'import doit aussi etre retire. |
| `src/commands/planning.ts` | Direct — modification | Retirer imports (`isPrdMaturationEnabled`, `runPrdPreflightChecks`, `storePendingProtoSpec`, `buildPreflightResultTag`, `clearPendingProtoSpec`, `getPendingProtoSpec`), bloc L861-894, callbacks L667-773. |
| `src/memory/graph.ts` | Direct — modification | Supprimer `promoteWorkingMemory` (L765-855) et `WorkingMemoryData` (L95). Retirer `saveAgentMemory`, `graduateAgentMemory` de l'import L10. |
| `src/memory.ts` | Direct — modification | Retirer re-exports `promoteWorkingMemory` et `type WorkingMemoryData` (barrel). |
| `src/job-manager.ts` | **Direct — NON COUVERT PAR LA SPEC** | Importe `buildPreflightKeyboard` depuis `prd-workflow.ts` (L15). Cette fonction est listee pour suppression dans R6, mais `job-manager.ts` n'est pas dans la liste des fichiers a modifier (Section 5). Sans modification de `job-manager.ts`, le typecheck echouera. |
| `config/features.json` | Direct — modification | Supprimer 6 cles : `exploration_phase`, `exploration_gate`, `spec_phase_lite`, `adversarial_challenge`, `prd_maturation_phases`, `memory_promotion`. |
| `.claude/agents/` (5 fichiers) | Direct — suppression | `impact-analyst.md`, `security-checker.md`, `test-architect.md`, `implementer.md`, `tester.md`. Aucune reference TypeScript — impact zero sur le build. |
| `.claude/skills/` (3 dossiers) | Direct — suppression | `dev-spec/`, `dev-challenge/`, `dev-pipeline/`. Aucune reference TypeScript — impact zero sur le build. |
| `tests/unit/spec-lite.test.ts` | Direct — suppression | 177 LOC, importe uniquement depuis le module supprime. |
| `tests/unit/adversarial-challenge.test.ts` | Direct — suppression | 193 LOC, importe uniquement depuis le module supprime. |
| `tests/unit/exploration-scoring.test.ts` | Direct — suppression | 302 LOC, importe uniquement depuis le module supprime. |
| `tests/generated/reviser-prd-to-deploy-workflow.test.ts` | Direct — suppression | 891 LOC. Importe `buildPreflightKeyboard`, `formatPreflightReport`, `PreflightReport`, `runPrdPreflightChecks` depuis `prd-workflow` + mocks de `spec-lite` et `adversarial-challenge`. Importe `getCompletionKeyboard` depuis `job-manager` (V14/V15 tests pour prd-preflight). |
| `tests/unit/orchestrator.test.ts` | Direct — modification | Retirer describes : `[V14] Feature Flags for P1/P2/E1/P3` (L365), `[V12] P1/P2/E1/P3 pipeline scope guards` (L396), `memory_promotion feature flag` (L442), `Working memory promotion in orchestrate()` (L456). |
| `tests/unit/logger-migration.test.ts` | Direct — modification | Retirer `adversarial-challenge.ts` (L42) et `spec-lite.ts` (L50) de `MIGRATED_MODULES`. |
| `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` | Direct — modification | Retirer describes [V1]-[V5] et [V12]-[V13] lies a `promoteWorkingMemory`/`memory_promotion`. Les describes [V6]-[V11] et [V14]-[V18] sont independants et doivent etre conserves. |
| `tests/unit/memory-evolution.test.ts` | Direct — modification | Retirer le describe `promoteWorkingMemory` (L560-700+) et la section `Feature flag memory_promotion` (L1083-1093). Le type `WorkingMemoryData` est importe en L1 — retirer l'import. |
| `CLAUDE.md` | Direct — modification | Table Dev Pipeline (retirer `dev-spec`, `dev-challenge`, `dev-pipeline`), liste agents (11→6), liste skills (7→4), workflow. |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/spec-lite.ts` | `generateProtoSpec`, `parseProtoSpec`, `StoryFileInput` | Suppression (module entier) | Non — callers dans `pipeline.ts`, `prd-workflow.ts`, `auto-pipeline.ts` doivent etre mis a jour |
| `src/adversarial-challenge.ts` | `runAdversarialChallenge`, `runImpactAnalysis`, `parseAdversarialResult` | Suppression (module entier) | Non — callers dans `pipeline.ts`, `prd-workflow.ts` doivent etre mis a jour |
| `src/exploration-scoring.ts` | `computeExplorationScore`, `shouldExplore`, `ExplorationScore` | Suppression (module entier) | Non — callers dans `llm-router.ts`, `pipeline.ts` doivent etre mis a jour |
| `src/prd-workflow.ts` | `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `PreflightReport`, `storePendingProtoSpec`, `getPendingProtoSpec`, `clearPendingProtoSpec`, `buildPreflightResultTag`, `buildPreflightKeyboard`, `formatPreflightReport` | Suppression de 9 exports | Non — `buildPreflightKeyboard` utilisee par `job-manager.ts` (non liste dans la spec) |
| `src/memory/graph.ts` | `promoteWorkingMemory`, `WorkingMemoryData` | Suppression | Non — utilises par `pipeline.ts` (via barrel `memory.ts`) et tests |
| `src/memory.ts` | `promoteWorkingMemory`, `type WorkingMemoryData` | Suppression de re-export | Non — importe dans `pipeline.ts` et tests |

### Breaking changes potentiels

- [x] **`job-manager.ts` — import `buildPreflightKeyboard` non couvert** : `src/job-manager.ts` L15 importe `buildPreflightKeyboard` depuis `prd-workflow.ts`. Cette fonction est supprimee par R6, mais `job-manager.ts` n'apparait pas dans la Section 5 (fichiers concernes). Sans retrait de cet import ET des blocs `case "prd-preflight"` (L293-308, L349-353) dans `job-manager.ts`, le typecheck echouera — **impact : `src/job-manager.ts`, tous ses importeurs (`relay.ts`, `commands/jobs.ts`, `commands/planning.ts`, `commands/utilities.ts`, `commands/execution.ts`, `commands/exploration.ts`)**

- [x] **`tests/generated/reviser-prd-to-deploy-workflow.test.ts` — `getCompletionKeyboard` pour prd-preflight** : ce fichier de test (marque pour suppression) importe `getCompletionKeyboard` depuis `job-manager` pour tester V14/V15 (prd-preflight). Sa suppression est correcte, mais confirme que la logique `prd-preflight` dans `job-manager.ts` devient orpheline et doit etre retiree conjointement.

- [ ] **`src/commands/exploration.ts` — import `isFeatureEnabled`** : apres retrait de la guard `exploration_phase` (L79-82), `isFeatureEnabled` n'a plus d'usage dans ce module (seul import en L21 pour ce guard). La spec identifie ce cas comme zone d'ombre (§9) mais la verification Grep confirme qu'il n'existe qu'une occurrence — l'import doit etre retire pour eviter un warning TypeScript (`no-unused-vars`).

- [ ] **`src/prd-workflow.ts` — `buildPreflightResultTag` utilise dans `planning.ts` alors que les deux sont supprimes** : `planning.ts` importe `buildPreflightResultTag` (L28) et l'appelle dans le bloc `isPrdMaturationEnabled()` (L893). Les deux suppressions sont coordonnees dans la spec (R6 + R15) — pas de regression si l'implementation est sequentielle.

### Points d'attention pour le Reviewer

1. **`src/job-manager.ts` — missing from spec** : c'est le principal oubli de la spec. `job-manager.ts` importe `buildPreflightKeyboard` (L15) et contient deux blocs `prd-preflight` (L293-308 pour le keyboard, L349-353 pour le message de completion). Ces blocs deviennent dead code apres suppression de `buildPreflightKeyboard` + des callbacks `planning.ts`. L'implementeur doit ajouter `job-manager.ts` a la liste des fichiers a modifier (retrait de l'import L15, retrait des deux blocs `prd-preflight`). Verifier que le test `tests/unit/job-manager.test.ts` ne teste pas ces blocs (verifie : aucune reference preflight dans ce fichier).

2. **`tests/generated/sante-systeme-memoire-permanente-multi.test.ts` — perimetre de suppression** : la spec indique "supprimer [V1], [V2], [V12]" mais l'analyse montre que [V1]-[V5] et [V12]-[V13] sont tous lies a `promoteWorkingMemory`/`memory_promotion`. Les describes [V3] (`promoteWorkingMemory NON appelee quand useBlackboard est false`), [V4] (`echec de promoteWorkingMemory ne bloque pas`), [V5] (`compteur de promotions via onProgress`) doivent egalement etre retires. Le [V8] (`memoryHealthStats — recentPromotions`) utilise `working_memory_promotion` comme donnee de test mais teste `memoryHealthStats` qui reste active — a conserver (conforme a R3).

3. **`src/commands/exploration.ts` — import `isFeatureEnabled` orphelin** : la zone d'ombre §9.1 est maintenant resolue par l'analyse : `isFeatureEnabled` est importe en L21 et utilise uniquement en L79. Apres retrait de L79-82, l'import devient inutilise. Le retirer pour eviter un echec TypeScript strict (`noUnusedLocals`).

4. **Suppression coordonnee `planning.ts` + `prd-workflow.ts` + `job-manager.ts`** : ces trois modules sont couples par les fonctions preflight. Leur modification doit etre atomique dans le meme commit pour eviter un etat intermediaire qui ne compile pas.

### Blast radius

- Modules directement modifies : 13 (3 supprimes + 10 edites dans `src/`)
- Modules indirectement impactes : 6 (importeurs de `job-manager.ts` si le breaking change est adresse)
- Fichiers source modifies : 15 (incluant `config/features.json` et `CLAUDE.md`)
- Fichiers de test a verifier : 8 (4 supprimes + 4 edites partiellement)
- Agents/skills supprimes : 8 (5 agents + 3 skills, aucun impact TypeScript)
