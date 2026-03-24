# Revue : SPEC-nettoyage-du-code-mort (Phase 1 — Architecture V2)

> Revue generee le 2026-03-24.
> Reviewer : agent reviewer (sonnet)
> Scope : 25 fichiers modifies (cf. liste dans le prompt pipeline)
> Rapport d'impact : docs/reviews/impact-SPEC-nettoyage-du-code-mort.md (pris en compte)

---

## Etat de l'implementation

L'implementation couvre correctement le perimetre de la spec. Les modules entiers supprimes, les blocs chirurgicaux retires, les agents/skills obsoletes nettoyes, et la documentation mise a jour. Les V-criteres structurels V1-V3 (fichiers deletes), V6-V15 (flags, imports, agents) sont satisfaits.

---

## Problemes bloquants

### B1 — [src/orchestrator/pipeline.ts:15] Import `checkConformance` inutilise

`checkConformance` est importe depuis `adversarial-verifier.ts` mais n'est utilise nulle part dans le corps du fichier. Les autres imports du meme bloc (`DriftReport`, `persistDriftReport`, `verifySpecVsImplementation`) sont bel et bien utilises. Biome signale ce cas comme `lint/correctness/noUnusedImports` — ce qui provoque l'echec du test CI `[V11] biome check src/ passes`.

```
src/orchestrator/pipeline.ts:15 lint/correctness/noUnusedImports
  checkConformance — importe mais jamais appele
```

Ce symbole etait probablement utilise dans le bloc P2 (`runAdversarialChallenge`) retire par cette PR. Sa suppression de la liste d'imports est requise pour que le build biome passe.

### B2 — [src/orchestrator/pipeline.ts:61-65] Imports `LIGHT_PIPELINE`, `QUICK_PIPELINE`, `RESEARCH_PIPELINE`, `REVIEW_PIPELINE`, `SOLO_PIPELINE` inutilises

Ces cinq constantes sont importees depuis `pipeline-selection.ts` mais ne sont pas referencees dans le corps de `pipeline.ts` apres retrait des blocs de garde. Biome les signale comme imports inutilises (`noUnusedImports`). Meme impact que B1 : echec du test CI biome.

Ces constantes etaient peut-etre utilisees dans les blocs P1/P2 retires pour filtrer les pipelines eligibles. La valeur `DEFAULT_PIPELINE` et `selectPipeline` restent utilisees correctement.

### B3 — [src/orchestrator/pipeline.ts:120] `let pipeline` devrait etre `const`

La variable `pipeline` est assignee une seule fois (ligne 120) et n'est jamais reassignee par la suite. Biome signale `lint/style/useConst` (fixable). Cela contribue egalement a l'echec du test `[V11]`.

### B4 — [src/prd-workflow.ts:30] `type Task` importe mais inutilise

L'import `type Task` depuis `./tasks.ts` est un vestige du code supprime (`prd_maturation_phases`). Biome le signale comme `noUnusedImports`. L'import `addTask` dans la meme ligne reste utilise (ligne 324 : `const task = await addTask(...)`). La correction est de retirer uniquement `, type Task` de l'import destructure.

---

## Avertissements

### W1 — [src/orchestrator/pipeline.ts, src/prd-workflow.ts, src/memory/graph.ts] Trailing blank line (biome format)

Les trois fichiers modifies ont un double saut de ligne en fin de fichier la ou biome en attend un seul :
- `src/orchestrator/pipeline.ts:1072` — ligne vide orpheline avant `}` fermant
- `src/prd-workflow.ts:493-494` — double saut de ligne en fin de fichier
- `src/memory/graph.ts:744-745` — double saut de ligne en fin de fichier

Ces erreurs de format biome contribuent a l'echec de `[V11]`. Elles ont vraisemblablement ete introduites lors des suppressions chirurgicales.

### W2 — [CLAUDE.md:50] Description de `orchestrator/pipeline.ts` toujours mentionner "adversarial"

La description du module dans CLAUDE.md indique :
```
| `orchestrator/pipeline.ts` | Main orchestrate() function: multi-agent pipeline with blackboard, gates, adversarial, conformance |
```
Le mot "adversarial" est imprecis apres retrait du bloc `runAdversarialChallenge` / `runImpactAnalysis`. La conformance spec-vs-implementation (`adversarial-verifier.ts`) reste active — donc "conformance" est correct — mais "adversarial" evoque desormais l'ancien module `adversarial-challenge.ts` supprime. Cette description induit en erreur un lecteur futur.

### W3 — [CLAUDE.md:189] Comptage des modules : "72 TypeScript modules" a verifier

La spec prevoyait un passage de 75 a ~72 modules (retrait de 3 modules). La valeur dans CLAUDE.md est 72. Il convient de verifier que ce chiffre est exact par rapport aux fichiers reellement presents dans `src/`.

---

## Suggestions

### S1 — [tests/unit/coding-standards.test.ts:184-192] LOC allowlist a mettre a jour si les refactors post-Phase 1 font descendre les fichiers sous seuil

La LOC allowlist du test est mise a jour (`orchestrator/pipeline.ts: 1107`, `gate-evaluator.ts: 927`, `commands/planning.ts: 847`). Les valeurs sont coherentes avec les fichiers actuels. Aucune action requise maintenant — a surveiller lors des prochaines phases.

### S2 — [src/orchestrator/pipeline.ts:50 dans CLAUDE.md] Mettre a jour la description du module pour retirer "adversarial"

Correction suggere pour CLAUDE.md L50 :
```
| `orchestrator/pipeline.ts` | Main orchestrate() function: multi-agent pipeline with blackboard, gates, conformance, deliberation |
```

---

## Validation des V-criteres specifies

| V-critere | Statut | Note |
|-----------|--------|------|
| V1 `src/spec-lite.ts` n'existe plus | PASS | Fichier absent confirme |
| V2 `src/adversarial-challenge.ts` n'existe plus | PASS | Fichier absent confirme |
| V3 `src/exploration-scoring.ts` n'existe plus | PASS | Fichier absent confirme |
| V4 typecheck `bunx tsc --noEmit` | PASS | Aucune erreur TypeScript |
| V5 `bun test` 0 fail | BLOQUE | 1 fail — test `[V11] biome check src/` echoue (B1-B4, W1) |
| V6 `config/features.json` sans les 6 cles | PASS | Verifie : 6 cles actives, 0 flags morts |
| V7 Aucune reference aux modules supprimes dans imports actifs | PASS | Grep src/ retourne 0 resultats |
| V8 Aucune reference aux 6 flags supprimes dans src/ | PASS | Grep retourne 0 resultats |
| V9 5 agents obsoletes supprimes | PASS | `.claude/agents/` : 6 agents restants confirmes |
| V10 3 skills obsoletes supprimes | PASS | `.claude/skills/` : 4 skills restants confirmes |
| V11 `src/memory/graph.ts` sans `promoteWorkingMemory` ni `WorkingMemoryData` | PASS | Grep retourne 0 |
| V12 `src/memory/graph.ts` conserve `getAgentMemories` | PASS | Utilise en L10 (import) et dans `buildMemoryChains` |
| V13 `src/memory/graph.ts` conserve le filtre `working_memory_promotion` | PASS | L602 intact |
| V14 `src/memory.ts` barrel sans `promoteWorkingMemory`/`WorkingMemoryData` | PASS | Barrel nettoye |
| V15 `src/commands/exploration.ts` sans guard `exploration_phase` | PASS | Guard retiree, `isFeatureEnabled` absent du module (import nettoye) |
| V16 `tests/generated/reviser-prd-to-deploy-workflow.test.ts` supprime | PASS | Fichier absent |
| V17 `logger-migration.test.ts` sans `adversarial-challenge.ts`/`spec-lite.ts` | PASS | Retire de `MIGRATED_MODULES` |
| V18 `CLAUDE.md` sans `dev-spec`/`dev-challenge`/`dev-pipeline` dans la table | PASS | Table Dev Pipeline a 4 phases |
| V19 `CLAUDE.md` liste 6 agents | PASS | `.claude/agents/: 6 specialized agents` |
| V20 `CLAUDE.md` liste 4 skills | PASS | `.claude/skills/: 4 skills` |
| V21 `src/prd-workflow.ts` sans fonctions preflight | PASS | Grep retourne 0 pour tous les symboles |
| V22 `src/commands/planning.ts` sans `isPrdMaturationEnabled`/callbacks preflight | PASS | Grep retourne 0 |
| V23 Test `doc-freshness` | A VERIFIER | Depend du check CI complet (non execute localement) |
| V24 `src/orchestrator/pipeline.ts` sans `generateProtoSpec`/`runAdversarialChallenge`/etc. | PASS | Grep retourne 0 |
| V25 `src/job-manager.ts` sans `buildPreflightKeyboard` | PASS | Import retire, case `prd-preflight` retire |

---

## Conformite avec la spec et le rapport d'impact

### Breaking change `job-manager.ts` (point d'attention 1 du rapport d'impact)

Correctement adresse. `src/job-manager.ts` a bien ete ajoute au scope malgre l'oubli de la spec originale (R16 ajoute par le challenge adversarial F-EC-1). L'import `buildPreflightKeyboard` est retire, ainsi que les deux blocs `prd-preflight` dans le switch de completion.

### `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` — perimetre de suppression (point d'attention 2)

La suppression correspond exactement a l'analyse du rapport d'impact : les describes [V1]-[V5] et [V12]-[V13] lies a `promoteWorkingMemory`/`memory_promotion` sont retires. Le describe [V8] (`recentPromotions via source = working_memory_promotion`) est correctement conserve (teste `memoryHealthStats` qui reste active, conforme a R3). L'en-tete du fichier de test est mis a jour pour refleter le nouveau perimetre (V6-V10, V14, V16).

### Import `isFeatureEnabled` dans `commands/exploration.ts` (zone d'ombre §9.1)

Correctement resolu. L'import `isFeatureEnabled` n'apparait plus dans `commands/exploration.ts`. La verification confirme qu'aucune autre reference au module `feature-flags` ne subsiste dans ce fichier.

---

## Resultats des tests

```
bun test : 3859 pass, 10 skip, 1 fail (test biome [V11])
bunx tsc --noEmit : 0 erreurs
```

Le seul echec est le test `[V11] biome check src/ passes` provoque par les 4 problemes bloquants identifies (B1-B4) et les 3 avertissements de format (W1). Les tests unitaires specifiques au scope (logger-migration, orchestrator, memory-evolution, sante-systeme, memoire-hybride-agents-bmad) passent tous : 753 pass, 0 fail.

---

## Score : 68/100

L'implementation est structurellement correcte sur tous les criteres fonctionnels. Le nettoyage est propre, coherent et conforme aux regles metier R1-R16. Quatre imports inutilises et trois erreurs de format biome (residus des suppressions chirurgicales) bloquent le test CI `[V11] biome check`. Ces points sont tous des corrections mecaniques de quelques lignes, sans impact sur la logique.

**Conditions pour passer a 100/100 :**
1. Retirer `checkConformance` de l'import `adversarial-verifier.ts` dans `pipeline.ts` (B1)
2. Retirer `LIGHT_PIPELINE`, `QUICK_PIPELINE`, `RESEARCH_PIPELINE`, `REVIEW_PIPELINE`, `SOLO_PIPELINE` de l'import `pipeline-selection.ts` dans `pipeline.ts` (B2)
3. Changer `let pipeline` en `const pipeline` a la ligne 120 de `pipeline.ts` (B3)
4. Retirer `, type Task` de l'import `./tasks.ts` dans `prd-workflow.ts` (B4)
5. Corriger les 3 trailing blank lines biome dans `pipeline.ts`, `prd-workflow.ts`, `memory/graph.ts` (W1)
