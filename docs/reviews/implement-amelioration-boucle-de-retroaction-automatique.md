---
name: amelioration-boucle-de-retroaction-automatique
phase: 2-implement
generated_at: "2026-03-25T00:00:00Z"
spec_ref: docs/specs/SPEC-amelioration-boucle-de-retroaction-automatique.md
adversarial_ref: docs/reviews/adversarial-SPEC-amelioration-boucle-de-retroaction-automatique.md
---

# Rapport d'Implémentation — Amélioration boucle de rétroaction automatique

## Statut final : DONE

---

## 1. Tests générés / modifiés

### `tests/unit/feedback-analyzer.test.ts` — 10 nouveaux tests (V9–V14 + edge cases)

| Test | V-critère | Description |
|------|-----------|-------------|
| V9: fetchSignals returns signals from mocked Supabase | V9 | fetchSignals injectée retourne des signaux négatifs → runFeedbackLoop crée un overlay |
| V10: fetchSignals empty → no overlays | V10 | fetchSignals retournant [] → overlaysCreated=0 |
| V10: fetchSignals with only positive verdicts | V10 | Signaux GO/APPROVED → aucun overlay créé |
| fetchSignals: malformed payload fields handled | V9 | Signaux partiels sans details → pas de crash |
| F-EC-1: accepts "spec" as source type | V9 | Union type étendu, 3 signaux source="spec" détectés |
| F-EC-1: accepts "discuss" as source type | V9 | Union type étendu, 3 signaux source="discuss" détectés |
| V13: LLM overlay mode calls generateOverlayFn | V13 | generateOverlayFn injectée appelée avec agentRole/failureCount/source/details, overlay ≤300 chars |
| V14: LLM overlay failure falls back to template | V14 | generateOverlayFn lance exception → fallback template utilisé |
| aggregatedDetails populated from signal details | V9 | RecurringPattern.aggregatedDetails contient les details des signaux |
| aggregatedDetails undefined when no details | V9 | Signaux sans details → aggregatedDetails undefined |

### `tests/unit/job-manager.test.ts` — 4 nouveaux tests (V11, V12)

| Test | V-critère | Description |
|------|-----------|-------------|
| V11: PHASE_TO_AGENT_ROLE maps all phases correctly | V11 | challenge→spec-architect, review→reviewer, implement→implementer, explore→explorer, spec→spec-architect, discuss défini |
| V11: SDD challenge job with NO-GO completes normally | V11 | Job sdd-challenge:my-spec avec résultat NO-GO se termine avec status=completed |
| V12: SDD job completes when emitSddVerdict encounters Supabase error | V12 | Erreur Supabase best-effort → job.status=completed, job.error=null |
| V12: non-SDD jobs not affected by SDD event logic | V12 | Job "exec" non affecté par la logique d'émission SDD |

---

## 2. Fichiers modifiés

### `src/sdd-agents.ts` (+17 lignes)
- Export `PHASE_TO_AGENT_ROLE: Record<string, string>` — source de vérité pour le mapping phase → agent_role
- Mapping: `explore→explorer`, `discuss→spec-architect`, `spec→spec-architect`, `challenge→spec-architect`, `implement→implementer`, `review→reviewer`, `doc→spec-architect`
- Résout F-SS-5 (duplication mapping), F-DA-1 (phase "discuss" manquante)

### `src/feedback-analyzer.ts` (+80 lignes / 233→309 LOC)
- `AgentFeedbackSignal.source` étendu à `"spec" | "discuss"` (F-EC-1 — TypeScript valide)
- `RecurringPattern.aggregatedDetails?: string` — agrège les details des signaux pour le LLM (F-EC-3)
- `buildFetchSignals()` — implémentation Supabase réelle de `fetchSignals` : fenêtre 7j, filtre `event_type='sdd_verdict'`, verdicts négatifs uniquement (R2)
- `buildGenerateOverlayFn()` — factory injectant la dépendance LLM Haiku via `spawnClaude` (F-SS-1: pas d'import direct `agent.ts`)
- `Dependencies.generateOverlayFn?` optionnel — compatibilité backward avec tests V1-V8 existants
- `getDeps()` production : fetchSignals Supabase + generateOverlayFn Haiku/template
- `generateOverlayText()` étendu : templates pour source `"spec"` et `"discuss"` (F-EC-1)
- `analyzeAgentFeedback()` : agrégation des details dans `aggregatedDetails`
- `runFeedbackLoop()` : utilise `generateOverlayFn` injectable (avec fallback si absente)

### `src/sdd-event.ts` (nouveau fichier, 54 LOC)
- Module d'émission SDD extrait de `job-manager.ts` pour respecter S3 LOC threshold
- `emitSddVerdict(jobId, jobType, result)` — émission best-effort dans `agent_events`
- Réutilise `PHASE_TO_AGENT_ROLE` depuis `sdd-agents.ts`
- `session_id = jobId` pour unicité par run (F-SS-8)
- Details tronqués à 200 chars pour contexte LLM (F-EC-3)

### `src/job-manager.ts` (+12 lignes net / 769→781 LOC)
- Post `tryAutoAdvance` : fire-and-forget qui appelle `emitSddVerdict` puis `runFeedbackLoop` (R1, R9)
- Pattern fire-and-forget via `Promise.resolve().then(async () => {...}).catch(...)` (F-SS-2)
- Imports dynamiques ESM (`await import(...)`) — pas de `require()` CommonJS (F-SS-10)
- Condition `job.type.startsWith("sdd-") && job.status === "completed" && job.type.includes(":")`

### `config/features.json` (+1 ligne)
- `"sdd_feedback_llm_overlay": false` ajouté (désactivé par défaut, R4/R5)

### `CLAUDE.md` (+1 ligne)
- Ajout de `sdd-event.ts` dans la table des modules

---

## 3. Décisions d'implémentation vs adversarial review

| Finding | Action |
|---------|--------|
| F-DA-1 (discuss manquant) | `discuss→spec-architect` dans PHASE_TO_AGENT_ROLE + `AgentFeedbackSignal.source` étendu |
| F-DA-2 (pas de CHECK constraint) | Validation défensive dans `buildFetchSignals()` : skip des rows avec payload invalide |
| F-DA-3 (source implicite) | `source = phase` documenté dans R3, union type exhaustif dans `AgentFeedbackSignal` |
| F-DA-4 (BotContext non disponible) | Client Supabase lazy via `getConfig()` dans `sdd-event.ts` (même pattern que syncTask) |
| F-DA-5 (fenêtre 7j / TTL 7j) | Accepté comme risque documenté ; le dedup `hasSimilar` limite la prolifération |
| F-DA-6 (fallback LLM imprécis) | Fallback sur toute exception + stdout vide + exitCode ≠ 0 |
| F-EC-1 (source "spec" absent) | Union type étendu à `"spec" \| "discuss"` |
| F-EC-2 (race condition JSON) | Fire-and-forget séquentiel — pas de concurrence dans la boucle |
| F-EC-3 (50 chars insuffisant) | 200 chars de context dans `sdd-event.ts` + 500 chars max dans le prompt Haiku |
| F-EC-7 (useWorktree manquant) | `useWorktree: false` dans `buildGenerateOverlayFn` |
| F-SS-1 (couplage agent.ts) | `spawnClaude` dans `getDeps()` uniquement, via factory `buildGenerateOverlayFn` |
| F-SS-2 (timeout post-job) | Fire-and-forget explicite avec `.catch()` |
| F-SS-4 (client Supabase dupliqué) | Client lazy dans `sdd-event.ts` + `getDeps()` — cohérent avec pattern projet |
| F-SS-5 (PHASE_TO_AGENT_ROLE dupliqué) | Export depuis `sdd-agents.ts`, importé dans `sdd-event.ts` |
| F-SS-6 (émission dans job-manager) | Extraction dans `sdd-event.ts` (module dédié) — compromis entre spec et LOC |
| F-SS-8 (session_id sémantique) | `session_id = job.id` (unique par run) |
| F-SS-10 (require CommonJS) | Dynamic import ESM via `await import(...)` dans job-manager |

---

## 4. Résultats `bun test`

```
2257 pass
1 skip
1 fail (pre-existing: TSC bun-types TS2688 — env issue, non lié à ce sprint)
2259 tests across 80 files
```

Tests ciblés :
- `tests/unit/feedback-analyzer.test.ts` : 24 pass, 0 fail
- `tests/unit/job-manager.test.ts` : 58 pass, 0 fail

---

## 5. LOC final

| Fichier | LOC avant | LOC après |
|---------|-----------|-----------|
| `src/feedback-analyzer.ts` | 233 | 309 |
| `src/job-manager.ts` | 769 | 781 |
| `src/sdd-agents.ts` | ~475 | ~492 |
| `src/sdd-event.ts` | N/A (nouveau) | 54 |

Tous les fichiers restent sous le seuil de 800 LOC (S3).

---

## 6. Checklist V-critères

| V# | Statut | Notes |
|----|--------|-------|
| V1 | ✅ | Test existant, toujours vert |
| V2 | ✅ | Test existant, toujours vert |
| V3 | ✅ | Test existant, toujours vert |
| V4 | ✅ | Test existant, toujours vert |
| V5 | ✅ | Test existant, toujours vert |
| V6 | ✅ | Test existant, toujours vert |
| V7 | ✅ | Test existant, toujours vert |
| V8 | ✅ | Test existant, toujours vert |
| V9 | ✅ | Testé via mock fetchSignals |
| V10 | ✅ | Testé avec signaux vides et signaux GO |
| V11 | ✅ | PHASE_TO_AGENT_ROLE testé + job challenge NO-GO |
| V12 | ✅ | Job complète normalement même si Supabase échoue |
| V13 | ✅ | generateOverlayFn injectée, overlay ≤300 chars |
| V14 | ✅ | Exception dans generateOverlayFn → template statique |
| V15 | ⚠️ | Comportemental (V11+V12 couvrent l'intent). Test V15 "spy" remplacé par test comportemental (F-SS-9 suggestion) |
