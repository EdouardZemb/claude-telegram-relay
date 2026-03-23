## Revue : SPEC-durcissement-standards-vague-4

> Revue generee le 2026-03-23. Scope : 22 fichiers modifies par le pipeline (barrels, 10 sous-modules, ADR, CLAUDE.md, 6 fichiers de tests).

### Verification automatisee

| Critere | Resultat |
|---------|----------|
| `bunx tsc --noEmit` | 0 erreurs |
| `bun test` (full suite) | 3712 pass, 0 fail, 15 skip |
| `bun test durcissement-standards-vague-4.test.ts` | 61 pass, 0 fail |
| Cycles memory (scoring/ideas/agent-memory/classification -> core ou graph) | 0 import interdit |
| Cycles orchestrator (types -> sous-modules, agent-step -> pipeline) | 0 import interdit |
| Secrets dans les fichiers modifies | Aucun |
| `any` TypeScript dans les fichiers modifies | Aucun |

### Problemes bloquants

Aucun.

### Avertissements

1. **[src/orchestrator/pipeline.ts] 1486 LOC — depasse le seuil de 800 LOC**
   Le fichier `pipeline.ts` depasse largement le seuil de 800 LOC documente dans CLAUDE.md. La spec reconnait ce depassement comme un compromis accepte (zone d'ombre #2 : "la fragmenter davantage risquerait de rendre le flux plus difficile a suivre"). L'ADR le mentionne egalement ("pipeline.ts remains large ~1486 LOC"). Le test V13 exclut correctement ce fichier de la verification LOC. **Accepte** comme compromis documente, mais a surveiller si le fichier continue de grossir.

2. **[src/memory/graph.ts] 855 LOC — depasse le seuil de 800 LOC**
   Le fichier `graph.ts` depasse le seuil de 800 LOC de 55 lignes. La spec prevoyait ~700 LOC (zone d'ombre #1 : "Si la refactorisation revele des possibilites de decoupage supplementaire..."). Le test V13 utilise un seuil relache de 900 LOC et passe. **Avertissement** : si des fonctionnalites sont ajoutees a `graph.ts`, un decoupage supplementaire (par exemple separer `memoryHealthStats`/`formatMemoryHealth` dans un fichier `health.ts`) sera necessaire.

3. **[src/memory/core.ts:49, src/memory/graph.ts:103] Interfaces `FactRecord` et `GoalRecord` dupliquees**
   Les interfaces `FactRecord` et `GoalRecord` sont definies de maniere identique dans `core.ts` et `graph.ts`. Les deux sont privees (non exportees), donc pas de conflit de barrel. Cependant, cela viole le principe DRY. Si l'une des deux est modifiee sans l'autre, un bug silencieux pourrait apparaitre (pas d'erreur TypeScript puisque ce sont des interfaces structurelles independantes). **Recommandation** : extraire ces interfaces dans `core.ts` et les importer dans `graph.ts`. Cela inverserait la dependance (graph -> core) mais la spec R7 autorise graph comme module hub qui consomme des modules specialises. Alternativement, les placer dans un fichier `types.ts` interne au sous-repertoire memory.

4. **[src/memory/agent-memory.ts:157] Constante `HARD_LIMIT = 15` dupliquee**
   La constante `AGENT_MEMORY_HARD_LIMIT` (15) est definie dans `graph.ts` et dupliquee en tant que `const HARD_LIMIT = 15` locale dans `agent-memory.ts`, avec un commentaire explicatif : "to avoid circular dependency". Ceci est une consequence directe de la contrainte R7 (agent-memory ne doit pas importer graph). Le risque est une divergence silencieuse si la valeur change dans `graph.ts` sans etre mise a jour dans `agent-memory.ts`. **Accepte** car documente et motive par l'absence de cycle, mais a terme un fichier `constants.ts` commun dans `src/memory/` pourrait resoudre cela sans introduire de cycle.

5. **[src/orchestrator.ts barrel, src/deliberation.ts] Dependance circulaire pre-existante**
   `deliberation.ts` importe `runAgentStep` (valeur, pas type-only) depuis le barrel `orchestrator.ts`, et le barrel re-exporte depuis `deliberation.ts`. Ce cycle existait deja avant la vague 4 (le monolithe `orchestrator.ts` faisait deja `export { ... } from "./deliberation.ts"` et `deliberation.ts` importait des fonctions de `orchestrator.ts`). Bun gere ce cycle au runtime (les tests passent), mais c'est une dette technique heritee. Cet avertissement est **hors scope — backward compatibility** car `deliberation.ts` n'est pas dans les fichiers modifies. A terme, `deliberation.ts` devrait importer directement depuis `./orchestrator/agent-step.ts` et `./orchestrator/types.ts` pour casser le cycle.

### Suggestions

1. **[src/memory.ts:27] Ligne vide manquante entre sections du barrel**
   Il manque une ligne vide entre les sections `classification.ts` et `core.ts` du barrel memory. Les autres sections sont separees par des lignes vides. Cosmetic uniquement.

2. **[src/memory/scoring.ts:31] `MemorySearchResult` non re-exporte par le barrel**
   L'interface `MemorySearchResult` est exportee depuis `scoring.ts` et importee par `classification.ts`. Elle n'est pas re-exportee par le barrel `memory.ts`. Actuellement, aucun consommateur externe n'en a besoin (elle etait deja privee dans le monolithe original). Si un consommateur futur en a besoin, il faudra l'ajouter au barrel. Aucun changement necessaire pour l'instant.

3. **[tests/generated/durcissement-standards-vague-4.test.ts:239] Seuil V13 relache a 900 LOC**
   Le test V13 verifie `< 900 LOC` au lieu de `< 800 LOC` (le seuil documente dans CLAUDE.md). Cela laisse une marge de 100 lignes au-dessus du seuil officiel. Graph.ts (855 LOC) passe le test mais depasse le seuil CLAUDE.md. **Suggestion** : aligner le seuil du test sur 800 LOC et ajouter une exception explicite pour `graph.ts` (comme c'est deja fait pour `pipeline.ts`).

4. **[src/orchestrator/types.ts:8] `import type { generateTraceabilityReport }` utilise pour extraire un ReturnType**
   L'import `import type { generateTraceabilityReport } from "../blackboard.ts"` dans types.ts est utilise uniquement pour `ReturnType<typeof generateTraceabilityReport>` dans l'interface `OrchestratedResult`. C'est un pattern correct mais inhabituel — il serait plus explicite de definir un type `TraceabilityReport` dans `blackboard.ts` et de l'importer directement. Refactoring optionnel, non bloquant.

5. **[docs/adr/008-architectural-boundaries.md] ADR minimal et conforme**
   L'ADR contient les 4 sections requises (Date, Status, Context, Decision, Consequences), documente les 3 couches architecturales, et mentionne les compromis (pipeline.ts large, barrel indirection). Conforme a la spec R9.

### Verification des V-criteres de la spec

| V-critere | Statut | Detail |
|-----------|--------|--------|
| V1 | OK | `src/memory.ts` : 77 LOC, barrel re-export only, aucune logique |
| V2 | OK | `src/orchestrator.ts` : 41 LOC, barrel re-export only, aucune logique |
| V3 | OK | Tous les exports publics memory re-exportes (35 fonctions + 9 types + 3 constantes) |
| V4 | OK | Tous les exports publics orchestrator re-exportes (fonctions, types, constantes + re-exports deliberation/pipeline-selection) |
| V5 | OK | Aucun fichier consommateur modifie (scope = barrels + sous-modules + ADR + CLAUDE.md + tests) |
| V6 | OK | 3712 tests pass, 0 fail (depasse les 3609 du baseline) |
| V7 | OK | `bunx tsc --noEmit` : 0 erreurs |
| V8 | OK | scoring/ideas/agent-memory/classification n'importent ni core.ts ni graph.ts |
| V9 | OK | types.ts n'importe aucun sous-module local, agent-step.ts n'importe pas pipeline.ts |
| V10 | OK | Chaque sous-module (sauf types.ts) a son propre `createLogger()` |
| V11 | OK | ADR `docs/adr/008-architectural-boundaries.md` existe avec Context, Decision, Consequences |
| V12 | OK | CLAUDE.md contient `memory/core.ts`, `orchestrator/types.ts`, etc. dans la table des modules |
| V13 | PARTIEL | graph.ts (855) et pipeline.ts (1486) depassent 800 LOC. Pipeline.ts est un compromis reconnu par la spec. graph.ts depasse de 55 LOC (voir avertissement #2) |
| V14 | OK | `src/memory/` contient les 6 fichiers : core.ts, classification.ts, scoring.ts, ideas.ts, graph.ts, agent-memory.ts |
| V15 | OK | `src/orchestrator/` contient les 4 fichiers : types.ts, agent-step.ts, pipeline.ts, format.ts |
| V16 | OK | Tous les imports locaux entre sous-modules utilisent l'extension `.ts` |
| V17 | OK | Les tests passent, le barrel resout correctement pour les imports avec et sans extension `.ts` |

### Resume des fichiers relus

| Fichier | LOC | Verdict |
|---------|-----|---------|
| `src/memory.ts` (barrel) | 77 | OK — re-export only |
| `src/memory/core.ts` | 340 | OK |
| `src/memory/classification.ts` | 308 | OK |
| `src/memory/scoring.ts` | 294 | OK |
| `src/memory/ideas.ts` | 174 | OK |
| `src/memory/graph.ts` | 855 | Avertissement (> 800 LOC) |
| `src/memory/agent-memory.ts` | 295 | OK |
| `src/orchestrator.ts` (barrel) | 41 | OK — re-export only |
| `src/orchestrator/types.ts` | 95 | OK |
| `src/orchestrator/agent-step.ts` | 261 | OK |
| `src/orchestrator/pipeline.ts` | 1486 | Avertissement (> 800 LOC, compromis documente) |
| `src/orchestrator/format.ts` | 188 | OK |
| `CLAUDE.md` | — | OK — table des modules a jour |
| `docs/adr/008-architectural-boundaries.md` | — | OK — ADR conforme |
| `tests/generated/durcissement-standards-vague-4.test.ts` | 311 | OK — 61 tests, couvre V1-V16 |
| `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` | 551 | OK — imports via barrel fonctionnels |
| `tests/generated/refactorisation-llm-ops-transversale.test.ts` | — | OK — aucun changement structurel |
| `tests/unit/logger-migration.test.ts` | — | OK — references mises a jour vers sous-modules |
| `tests/unit/orchestrator.test.ts` | — | OK — imports via barrel fonctionnels |
| `tests/integration/mcp-blackboard.test.ts` | — | OK — aucun changement structurel |
| `src/code-graph.ts` | — | OK — aucun changement structurel |
| `src/doc-utils.ts` | — | OK — scan des sous-repertoires pour freshness checks |

### Score : 88/100

Deductions :
- -5 : `graph.ts` depasse le seuil de 800 LOC sans exception explicite dans le test V13
- -3 : interfaces `FactRecord`/`GoalRecord` dupliquees entre core.ts et graph.ts (dette technique mineure)
- -2 : constante `HARD_LIMIT` dupliquee dans agent-memory.ts (justifie mais fragile)
- -2 : seuil V13 du test relache a 900 LOC au lieu de 800 LOC

Points forts :
- Refactorisation pure sans changement fonctionnel, 0 test casse
- Barrel pattern impeccable : 77 et 41 LOC, re-export only
- Dependances acycliques respectees (DAG correct, verifie par tests)
- ADR et CLAUDE.md mis a jour de maniere exhaustive
- 61 tests specifiques couvrant les 17 V-criteres (sauf V11/V12 manuels)
- TypeScript strict : 0 erreur, 0 `any`
- 3712 tests passent (103 de plus que le baseline de 3609)
