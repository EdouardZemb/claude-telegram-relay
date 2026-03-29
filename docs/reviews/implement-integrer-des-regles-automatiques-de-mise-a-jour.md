# Review: Implémentation — Règles automatiques de mise à jour

**Pipeline:** V3 post-maturation
**Feature:** `integrer-des-regles-automatiques-de-mise-a-jour`
**Date:** 2026-03-29
**Statut:** IMPLÉMENTÉ — feature flag `doc_auto_update = false` (désactivé par défaut)

---

## Résumé

Implémentation de la stratification 3 tiers pour les mises à jour automatiques de documentation, avec protection anti-récursion et validation pre-PR.

---

## Fichiers créés

| Fichier | Rôle |
|---------|------|
| `src/doc-auto-update.ts` | Module core : classification tier, plan building, constantes |
| `tests/unit/doc-auto-update.test.ts` | 49 tests unitaires (100% des fonctions exportées) |
| `scripts/doc-auto-update.ts` | Script CI : orchestration complète (git → detect → plan → PR) |
| `.github/workflows/doc-update.yml` | GitHub Actions : déclenchement sur `src/**` push to master |

## Fichiers modifiés

| Fichier | Changement |
|---------|-----------|
| `config/features.json` | Ajout `doc_auto_update: false` |
| `CLAUDE.md` | Ajout `doc-auto-update.ts` dans Source Modules table |

---

## Architecture : stratification 3 tiers

### Tier 1 — Auto-merge (8 docs opérationnels)
- `README.md` (full)
- `CHANGELOG.md` (append-only)
- `docs/WORKFLOW-DEV.md` (full)
- `docs/WORKFLOW-PIPELINE.md` (full)
- `docs/SETUP.md` (full)
- `docs/dashboard.md` (full)
- `docs/bmad-system.md` (full)
- `docs/configuration.md` (full)

### Tier 2 — PR + notification Telegram (sans auto-merge)
- `CLAUDE.md` : PR créée, notification Telegram envoyée, review humaine requise

### Tier 3 — Exclus (design-intent artifacts)
- `docs/specs/**` — spécifications formelles
- `docs/adr/**` — Architecture Decision Records
- Tout autre chemin non listé → Tier 3 par défaut (fail-closed)

---

## Protection anti-récursion (triple barrière)

1. **Path filter** : `shouldTriggerUpdate()` gate sur `src/**` seulement — les commits doc-only ne déclenchent pas de nouveau cycle
2. **GITHUB_TOKEN natif** — pas de secrets supplémentaires requis
3. **`[skip actions]`** : suffixe dans tous les commits auto-générés (`SKIP_CI_SUFFIX`)

---

## Validation pre-PR

Avant toute création de PR, `scripts/doc-freshness.ts` est exécuté. Si le format est cassé (gaps détectés), la PR n'est jamais créée et le script sort avec code 1.

---

## Tests

```
49 pass, 0 fail
Suite: tests/unit/doc-auto-update.test.ts
```

Couverture :
- `classifyDoc` : tous les 8 docs Tier 1 + CLAUDE.md + docs/specs/ + docs/adr/ + chemins inconnus
- `shouldTriggerUpdate` : src/ présent, absent, vide, mix, prefixe exact
- `buildDocUpdatePlan` : toutes combinaisons (tier1 seul, tier2 seul, tier3 seul, mix, vide)
- `DOC_UPDATE_RULES` : 8 Tier1, 1 Tier2, CHANGELOG append-only
- `TIER3_PATTERNS`, `SKIP_CI_SUFFIX`, `buildBranchName`, `tierLabel`

---

## Activation

Pour activer :
```bash
# Via feature flag Supabase
bun -e "
  const { createClient } = require('@supabase/supabase-js');
  // ... setFeature('doc_auto_update', true)
"

# Ou directement dans config/features.json
# "doc_auto_update": true
```

**Prérequis avant activation :**
1. Résoudre le test failing `tsc --noEmit` (bun-types manquant en environnement CI worktree)
2. Vérifier que `TELEGRAM_BOT_TOKEN` et `TELEGRAM_USER_ID` sont bien configurés en secrets GitHub

---

## Décisions d'implémentation

### F-SC-1 + F-TC-1 (CLAUDE.md) — showstopper résolu
CLAUDE.md est classé Tier 2 : une PR est créée mais jamais auto-mergée. Une notification Telegram informe l'utilisateur pour review humaine.

### F-PC-1 (specs/ADRs) — showstopper résolu
`docs/specs/**` et `docs/adr/**` sont Tier 3 (exclus). La liste `TIER3_PATTERNS` est extensible.

### F-PC-2 (récursion) — showstopper résolu
Triple barrière : `shouldTriggerUpdate()` + `GITHUB_TOKEN` + `[skip actions]`. Aucun cycle possible.

### F-TC-1 / F-SC-5 (doc-freshness) — showstopper résolu
Validation `scripts/doc-freshness.ts` exécutée avant toute création de PR. Fail-fast si format cassé.

---

## Risques résiduels

| Risque | Mitigation |
|--------|-----------|
| Claude Code CLI absent du runner | Script `catch` silencieux, continue sans mise à jour |
| Telegram credentials manquants | `notifyTelegram()` log warning et continue |
| Concurrent runs créant des branches conflictuelles | `concurrency: group: doc-auto-update` dans le workflow |
| Auto-merge Tier 1 bloqué (CI fails) | `gh pr merge --auto` respecte les branch protections |
