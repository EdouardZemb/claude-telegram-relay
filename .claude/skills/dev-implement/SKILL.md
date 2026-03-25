---
name: dev-implement
description: "[team] Implementation TDD. TRIGGER when: une feature, correction ou refactoring est pret pour implementation. DO NOT TRIGGER for: changement simple (1-2 fichiers)."
argument-hint: "[spec-path ou description]"
context: fork
---

Input : $ARGUMENTS (description de la feature/bug/refactoring + fichiers optionnels)
Prerequis : aucun

## Description

Ce workflow coordonne l'implementation complete en TDD :
1. Generation des squelettes de tests depuis les V-criteres de la spec (ou la description)
2. Implementation du code pour faire passer les tests
3. Completion des tests avec edge cases, scenarios d'erreur et robustesse
4. Validation finale `bun test` (max 2 iterations correctives)

## Instructions

1. Analyser la demande : decomposer en sous-taches
2. Phase 1 -- Generation des tests :
   - Lire la spec (`docs/specs/SPEC-{name}.md`) si fournie
   - Generer les squelettes de tests TDD dans `tests/` bases sur les V-criteres
   - Documenter le plan de test (fichiers crees, V-criteres couverts)
3. Phase 2 -- Implementation :
   - Ecrire le code en TDD pour faire passer les squelettes de tests
   - Un module a la fois, verifier `bun test` progressivement
   - Tenir compte des findings de la review adversariale si fournie (`docs/reviews/adversarial-SPEC-{name}.md`)
4. Phase 3 -- Completion des tests :
   - Completer les squelettes avec edge cases, erreurs, robustesse
   - Verifier la couverture des V-criteres de la spec
5. Phase 4 -- Consolidation :
   - Run `bun test` pour validation finale
   - Si bloquants CI : corriger (max 2 iterations)
6. Produire le rapport consolide

## Input attendu

L'utilisateur specifie :
- La description de la feature, bug fix, ou refactoring a implementer
- Les fichiers ou packages concernes (optionnel)
- **Reference aux artefacts du workflow** (recommande) :
  - Spec : `docs/specs/SPEC-{name}.md` — les tests DOIVENT couvrir les V-criteres si fournie
  - Review adversariale : `docs/reviews/adversarial-SPEC-{name}.md` — tenir compte des findings si fournie
  - Exploration : `docs/explorations/EXPLORE-{name}.md` — contexte architectural si fournie

## Output (artefact obligatoire)

1. Afficher le rapport consolide dans la conversation
2. **Sauvegarder** dans `docs/reviews/implement-{name}.md` (obligatoire — {name} derive de la spec ou de la description)
3. Le rapport inclut :
   - Tests generes (fichiers, V-criteres couverts)
   - Fichiers modifies et lignes changees
   - Tests completes et resultats
   - Resultat `bun test`
   - Statut final (DONE ou NEEDS_FIXES)

## Etape suivante (workflow)

Apres la sauvegarde, indiquer a l'utilisateur :
- **DONE** : la review puis la documentation sont les prochaines etapes (`/dev-review` puis `/dev-doc`)
- **NEEDS_FIXES** : corriger les problemes restants, puis relancer la validation
