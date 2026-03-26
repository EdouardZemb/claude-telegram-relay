# Rapport d'implémentation — SPEC-le-systeme-doit-pouvoir-gerer-et-eliminer-le

**Date** : 2026-03-26
**Branche** : `feat/prompt-overlay-purge-and-admin`
**Statut** : Implémenté, tests verts, PR créée

---

## Résumé

Implémentation complète de la spec « Gestion et suppression des prompt overlays » en TDD.
3 lacunes du système de prompt overlays corrigées :
1. Purge physique des overlays inactifs
2. Interface Telegram `/overlay`
3. Cleanup des leaks de répertoires temporaires dans les tests

---

## Fichiers modifiés

| Fichier | Changements |
|---------|------------|
| `src/prompt-overlay.ts` | `purgeInactiveOverlays()` ajouté (filtre `!active`, `saveOverlays(active)`, log) |
| `src/feedback-analyzer.ts` | Import `purgeInactiveOverlays`, champ `purgedCount` dans `FeedbackLoopResult`, appel après `expireOverlays()`, 3 sites de retour mis à jour |
| `src/commands/utilities.ts` | Commande `/overlay` avec sous-commandes `list`, `deactivate <id>`, `purge` |
| `src/action-registry.ts` | Entrée `/overlay` (risk: low, category: system) |
| `src/inline-menus.ts` | `/overlay` ajouté dans la catégorie `system` |
| `tests/unit/prompt-overlay.test.ts` | `afterAll` ajouté, 6 nouveaux tests `purgeInactiveOverlays` (V1-V5) |
| `tests/unit/feedback-analyzer.test.ts` | `afterAll` ajouté, test `purgedCount` |
| `.gitignore` | `.test-prompt-overlay-*/` et `.test-feedback-analyzer-*/` |
| `CLAUDE.md` | Documentation `/overlay` dans le tableau des commandes |

---

## Résultats des tests

```
52 pass, 0 fail (prompt-overlay + feedback-analyzer)
2292 pass, 1 skip, 1 fail total (failure pré-existante tsc sur worktree sans deps)
```

---

## Corrections issues de la review adversariale

| Finding | Correction appliquée |
|---------|---------------------|
| F-DA-1 / F-EC-1 (BLOQUANT) | 3 sites de retour de `runFeedbackLoop()` mis à jour avec `purgedCount: 0` ou `purgedCount` |
| F-DA-2 / F-EC-2 / F-SS-1 (MAJEUR) | Cache géré par `saveOverlays(active)` — pas de `_cache = null` explicite |
| F-DA-3 / F-EC-5 (MAJEUR) | `overlayText` non affiché dans `/overlay list`, non passé à `escapeHtml` |
| F-DA-4 (MAJEUR) | `sendResponseHtml` uniquement pour `list`, `ctx.reply` pour `deactivate` et `purge` |
| F-EC-3 (MAJEUR) | Guard `if (!id)` ajouté pour `/overlay deactivate` sans argument |
| F-EC-4 / F-SS-5 (MAJEUR) | `afterAll` ajouté dans `feedback-analyzer.test.ts` également |
| F-SS-3 (MAJEUR) | `sectionTitle()` de `html-format-helpers.ts` utilisé (pas de séparateur verbatim) |
| F-SS-4 (MAJEUR) | Patterns gitignore spécifiques (`.test-prompt-overlay-*/`, `.test-feedback-analyzer-*/`) |
| F-EC-9 (MINEUR) | `log.info("Purged inactive overlays", { count })` ajouté |

---

## Décisions d'implémentation

- **Cache** : `saveOverlays(active)` met à jour `_cache` automatiquement (ligne 71 de prompt-overlay.ts). Pas de `_cache = null` additionnel nécessaire.
- **No-write si zéro inactifs** : guard `if (inactive.length === 0) return 0` — pas d'écriture disque inutile.
- **`overlayText` non affiché** : la liste affiche `id`, `agentRole`, `statut`, `createdAt`, `reason` uniquement — pas de risque de message trop long.
- **Feature flag** : `/overlay purge` depuis Telegram bypass le feature flag `prompt_feedback_loop` (comportement intentionnel, accès admin direct).
