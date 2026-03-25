---
phase: 1-implement
generated_at: "2026-03-25T17:15:00Z"
subject: "Injection du contexte pipeline SDD dans le system prompt (option C)"
status: DONE
---

## Rapport d'implementation

### Description

Injection dynamique du contexte pipeline SDD dans le system prompt via l'option C (enrichissement dans zz-messages.ts). Quand un pipeline SDD est actif en phase conversationnelle (explore ou discuss), le prompt envoye a Claude inclut desormais le nom du pipeline, la phase en cours, les artefacts deja produits, et des instructions de guidage specifiques a la phase.

### Tests generes

| Fichier | Tests | V-criteres |
|---------|:-----:|------------|
| `tests/unit/pipeline-context-prompt.test.ts` | 16 | V1-V10 + edge cases |
| `tests/unit/zz-messages-pipeline-context.test.ts` | 12 | V11-V15 + LOC constraints |
| **Total** | **28** | |

#### V-criteres couverts

- V1: formatPipelineContextForPrompt retourne "" quand tracker est null
- V2: Retourne non-vide quand pipeline actif en discuss
- V3: Inclut le nom du pipeline
- V4: Inclut le label de la phase en cours
- V5: Inclut les references aux artefacts completes
- V6: Contient l'instruction de convergence (Decisions:)
- V7: Plain text only (pas de markdown)
- V8: Fonctionne pour la phase explore aussi
- V9: Retourne "" pour les phases non-conversationnelles (implement, review, etc.)
- V10: Output sous 500 caracteres (budget prompt)
- V11: getTracker appele avant buildPrompt dans processMessageInput
- V12: Pas de contexte pipeline quand aucun pipeline actif
- V13: Pipeline context concatene avec memoryContext
- V14: Import statique de getTracker (plus de dynamic import)
- V15: Detection de convergence preservee

### Fichiers modifies

| Fichier | Lignes changees | Nature |
|---------|:--------------:|--------|
| `src/pipeline-tracker.ts` | +62 (301 -> 363 LOC) | Ajout `formatPipelineContextForPrompt()` |
| `src/commands/zz-messages.ts` | +8 / -5 (687 -> 693 LOC) | Import statique, injection contexte, refactor convergence block |
| `tests/unit/pipeline-context-prompt.test.ts` | +177 (nouveau) | Tests formatPipelineContextForPrompt |
| `tests/unit/zz-messages-pipeline-context.test.ts` | +109 (nouveau) | Tests integration zz-messages |

### Details techniques

1. **`formatPipelineContextForPrompt(tracker)`** dans pipeline-tracker.ts :
   - Accepte `PipelineTracker | null`, retourne `string`
   - Phases conversationnelles : explore et discuss (Set CONVERSATIONAL_PHASES)
   - Format : nom pipeline, phase label, artefacts completes, instruction de guidage
   - Pour discuss : guidage vers decisions formalisables en spec
   - Pour explore : guidage vers identification alternatives/contraintes/risques
   - Retourne "" si tracker null, pas de phase running, ou phase non-conversationnelle

2. **Modifications zz-messages.ts** :
   - Import statique `{ formatPipelineContextForPrompt, getTracker }` depuis pipeline-tracker.ts
   - getTracker() appele en amont (avant buildPrompt) au lieu de en aval (apres callClaude)
   - Pipeline context prepend au memoryContext : `pipelineContext + "\n" + memoryContext + actionContext`
   - Le bloc convergence reutilise le `tracker` deja fetche (plus de dynamic import)
   - Suppression du `await import("../pipeline-tracker.ts")` dynamique

3. **Contraintes respectees** :
   - zz-messages.ts : 693 LOC (< 800)
   - pipeline-tracker.ts : 363 LOC (< 800)
   - Pas de modification de BotContext ni de buildPrompt signature
   - Pas de nouvelle dependance (pipeline-tracker deja importe dans zz-messages)
   - Import order conforme Biome

### Resultats tests

```
2029 pass, 1 skip, 0 fail
4082 expect() calls
73 fichiers de tests
```

### Statut final

**DONE** -- Prochaines etapes : `/dev-review` puis `/dev-doc`
