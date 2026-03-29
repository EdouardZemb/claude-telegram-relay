# Rapport d'implémentation : Notification proactive des décisions invalidées

**Pipeline** : notification-proactive-decisions-invalidees
**Date** : 2026-03-29
**Branche** : feature/notification-proactive-decisions-invalidees
**Spec** : SPEC-UNIFIEE (score maturité 8/10, recommandation PROCEED)

---

## Résumé

Implémentation de la détection proactive de contradictions dans le pipeline de maturation. Après chaque phase productive (explore, confront, synthesize, advocate), le pipeline détecte si la sortie de la phase invalide des décisions précédemment validées par l'utilisateur et déclenche un checkpoint interactif si le score de contradiction ≥ 0.85.

---

## Fichiers modifiés

### `src/maturation/types.ts` (+3 LOC)
- `CheckpointDecision.source` : ajout de `"contradiction"` au type union
- `MaturationRun` : ajout de `contradictionPauseCount?: number`

### `src/maturation/checkpoint.ts` (+130 LOC)
Nouvelles exports :
- `CONTRADICTION_THRESHOLD = 0.85` — seuil de déclenchement (élevé pour éviter les faux positifs)
- `MAX_CONTRADICTION_PAUSES = 2` — circuit breaker (max 2 pauses contradiction par run)
- `ContradictionResult` — interface `{ score: number, summary: string }`
- `buildContradictionDetectorPrompt(phaseOutput, decisions, phaseName)` — prompt pur
- `parseContradictionResponse(text)` — parser JSON robuste avec validation
- `detectContradiction(phaseOutput, decisions, callClaude, phaseName)` — détecteur fail-open
- `startContradictionCheckpoint(run, phaseOutput, phaseName, callClaude)` — orchestrateur avec circuit breaker

Modification :
- `handleCheckpointResponse` : skip `saveGlobalDecision` si `source === "contradiction"` (décision F-NC-1 : pas de pollution de `decisions.json`)

### `src/commands/maturation.ts` (+35 LOC)
- `runMaturationPipeline` : ajout de la détection de contradiction après chaque phase éligible (explore, confront, synthesize, advocate) sur `result.status === "ok"` et `result.documents.length > 0`
- `resumeMaturationAfterCheckpoint` : fix SHOWSTOPPER F-TC-1 — branche explicite `source === "contradiction"` qui préserve `currentPhase` au lieu de sauter à validate

---

## Décisions architecturales respectées

| Décision | Implémentation |
|----------|---------------|
| V2 Standard (4 phases) | Détection après explore, confront, synthesize, advocate |
| Seuil 0.85 | `CONTRADICTION_THRESHOLD = 0.85` |
| Circuit breaker max 2 | `MAX_CONTRADICTION_PAUSES = 2`, vérification en début de `startContradictionCheckpoint` |
| Fail-open | `detectContradiction` retourne `null` sur toute erreur Claude |
| Pas de pollution globale | `handleCheckpointResponse` skip `saveGlobalDecision` pour source=contradiction |
| F-TC-1 adressé | Branche `source === "contradiction"` dans CONTINUE préserve `currentPhase` |

---

## Tests

**Fichier** : `tests/unit/maturation-contradiction.test.ts`
**34 tests**, tous verts.

### Suites de tests :
- `constants` (2) — CONTRADICTION_THRESHOLD=0.85, MAX_CONTRADICTION_PAUSES=2
- `buildContradictionDetectorPrompt` (5) — nom de phase, décisions, troncature 2000 chars, seuil 0.85, format JSON
- `parseContradictionResponse` (10) — JSON valide, markdown code block, null sur erreurs (pas de JSON, score non-number, score hors range 0-1, summary manquant, input vide, valeurs limites 0 et 1)
- `detectContradiction` (7) — null si pas de décisions, null si score < seuil, résultat si score ≥ seuil, exactement au seuil, fail-open sur erreur Claude, fail-open sur réponse invalide, null à 0.84
- `startContradictionCheckpoint` (6) — null sans décisions, null si score bas, checkpoint source=contradiction, circuit breaker bloque à max, permet max-1, count undefined → 1
- `handleCheckpointResponse (contradiction)` (4) — pas de saveGlobalDecision, résolution normale, synthesize sauvegarde toujours, advocate sauvegarde toujours

---

## Flux d'exécution

```
runMaturationPipeline
  └─ [phase explore/confront/synthesize/advocate] → ok
      ├─ read phase documents (Bun.file)
      ├─ startContradictionCheckpoint(run, phaseOutput, phaseName, callClaude)
      │   ├─ circuit breaker? → null
      │   ├─ loadGlobalDecisions() → []? → null
      │   ├─ detectContradiction → score < 0.85? → null
      │   └─ create CheckpointDecision{source:"contradiction"}, run.contradictionPauseCount++
      └─ cp? → onProgress(⚠️ Contradiction détectée) → return MATURATION_CHECKPOINT

resumeMaturationAfterCheckpoint (CONTINUE)
  └─ lastCp.source === "contradiction" → preserve currentPhase (F-TC-1 fix)
```

---

## Métriques

- LOC ajoutées : ~168 (src) + ~240 (tests)
- Fichiers sources touchés : 3 (types.ts, checkpoint.ts, maturation.ts)
- Tests ajoutés : 34
- Couverture checkpoint.ts : maintenue (fonctions pures testées exhaustivement)
- TypeScript : 0 erreurs
- Régression : 0 (2506 tests pass, 0 fail)
