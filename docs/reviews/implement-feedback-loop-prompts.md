# Implementation Report — feedback-loop-prompts

**Date** : 2026-03-25
**Phase** : dev-implement
**Statut** : DONE

## Objectif

Implementation du systeme de prompt overlay feedback loop : boucle fermee entre les alertes/metriques du bot et les system prompts des agents SDD, via un mecanisme d'overlay dynamique.

## Tests generes

| Fichier | Tests | V-criteres couverts |
|---------|:-----:|---------------------|
| `tests/unit/prompt-overlay.test.ts` | 21 | V1-V10 (CRUD, enrichment, max 3, TTL, edge cases) |
| `tests/unit/feedback-analyzer.test.ts` | 14 | V1-V8 (analysis, generation, runFeedbackLoop, dedup) |
| **Total** | **35** | |

### V-criteres couverts (prompt-overlay)

- V1: getActiveOverlays retourne uniquement les overlays actifs, non-expires, pour un role
- V2: addOverlay persiste l'overlay au fichier JSON avec la bonne structure
- V3: deactivateOverlay met active=false pour un overlay donne
- V4: buildEnrichedPrompt concatene le prompt de base + overlays (max 3)
- V5: max 3 overlays par agent enforces (le plus ancien desactive au dela)
- V6: overlays expires exclus de getActiveOverlays
- V7: getActiveOverlays retourne un array vide quand aucun overlay
- V8: deactivateOverlay est idempotent (pas d'erreur sur id inconnu)
- V9: buildEnrichedPrompt retourne le prompt de base inchange sans overlays
- V10: fichier de stockage cree si manquant (init gracieuse)

### V-criteres couverts (feedback-analyzer)

- V1: analyzeAgentFeedback detecte les patterns recurrents (>= 3 NO-GO)
- V2: retourne vide quand pas de patterns recurrents
- V3: texte d'overlay genere est une instruction corrective courte
- V4: regroupe les echecs par role d'agent
- V5: respecte le seuil de recurrence (2 echecs insuffisants)
- V6: runFeedbackLoop cree des overlays a partir des resultats d'analyse
- V7: runFeedbackLoop est gate par le feature flag prompt_feedback_loop
- V8: runFeedbackLoop expire les anciens overlays avant creation

## Fichiers modifies

| Fichier | Action | Lignes changees |
|---------|--------|:---------------:|
| `src/prompt-overlay.ts` | Cree | 211 LOC |
| `src/feedback-analyzer.ts` | Cree | 232 LOC |
| `src/sdd-agents.ts` | Modifie | +25 LOC (import, hook, enrichPrompt dans readAgentFile) |
| `src/heartbeat.ts` | Modifie | +15 LOC (import runFeedbackLoop, periodic task) |
| `src/heartbeat-prompt.ts` | Modifie | +2 LOC (lastFeedbackLoopAt dans HeartbeatState) |
| `config/features.json` | Modifie | +1 ligne (prompt_feedback_loop: false) |
| `tests/unit/prompt-overlay.test.ts` | Existant | 379 LOC (21 tests) |
| `tests/unit/feedback-analyzer.test.ts` | Cree | 217 LOC (14 tests) |
| `tests/unit/coding-standards.test.ts` | Modifie | +2 LOC (S2 allowlist pour prompt-overlay.ts) |
| `CLAUDE.md` | Modifie | +2 modules dans la table, test count mis a jour |

## Architecture

```
Alerte/Metriques
      |
      v
feedback-analyzer.ts  <-- analyzeAgentFeedback() detecte patterns recurrents
      |
      v
prompt-overlay.ts     <-- addOverlay() stocke overlay JSON local
      |                    buildEnrichedPrompt() concatene base + overlays
      v
sdd-agents.ts         <-- readAgentFile() enrichi via enrichPrompt()
      |                    (gate par feature flag prompt_feedback_loop)
      v
.claude/agents/*.md   <-- JAMAIS modifies (overlay est un suffix au runtime)
```

**Heartbeat integration** : `pulse()` appelle `runFeedbackLoop()` toutes les heures (gate par lastFeedbackLoopAt dans HeartbeatState).

**Feature flag** : `prompt_feedback_loop` dans `config/features.json` (off par defaut).

## Contraintes respectees

1. Fichiers `.claude/agents/*.md` jamais modifies (overlay est un suffix concatene au runtime)
2. Max 3 overlays actifs par agent role (oldest deactivated quand limit atteint)
3. Rollback possible : deactivateOverlay(id) ou supprimer tous les overlays
4. Feature flag `prompt_feedback_loop` off par defaut
5. TTL optionnel (expiresAt) pour les overlays generes automatiquement (7 jours)
6. Test hooks pour sdd-agents (setBuildEnrichedPromptHook) permettent le test isole
7. Dependency injection dans feedback-analyzer (_setDependencies) pour testabilite

## Resultat `bun test`

```
2239 pass
1 skip
0 fail
4483 expect() calls
Ran 2240 tests across 80 files. [41.93s]
```

TypeScript typecheck : clean (0 erreurs).
Biome check : clean (0 erreurs).

## Statut final

**DONE** — Prochaines etapes : `/dev-review` puis `/dev-doc`.
