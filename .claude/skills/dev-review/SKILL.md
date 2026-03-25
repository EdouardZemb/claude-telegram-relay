---
name: dev-review
description: "Revue de code rapide (1 agent). TRIGGER when: fichiers modifies a valider. DO NOT TRIGGER for: audit qualite."
argument-hint: "[fichiers]"
---

Input : $ARGUMENTS (fichiers specifies) ou git diff (defaut)
Prerequis : linter configure, test runner disponible

## Etapes

### 1. Identifier les fichiers

Utiliser `git diff --name-only` pour trouver les fichiers modifies, ou travailler sur les fichiers specifies par l'utilisateur.

### 2. Verifier les conventions

- **Lint** : executer `bunx tsc --noEmit` sur les fichiers concernes
- Imports tries selon la configuration du projet
- Pas de secrets dans le code (verifier .env, credentials, tokens, cles API)
- Type hints pour les fonctions publiques
- Respect des conventions de style du projet (line-length, target Python, etc.)

### 3. Verifier les patterns du projet

- Les patterns d'appel du projet sont respectes (ex: clients partages, helpers, utils)
- Les conventions d'API du projet sont suivies (dry-run, payloads, format de reponse)
- Les caches et mecanismes d'optimisation existants sont utilises correctement
- Pas de reinvention de fonctionnalites deja presentes dans le codebase

### 4. Verifier l'architecture

- Pas de duplication de modules ou de logique existante
- Dependances correctes entre packages/modules (pas de cross-deps inattendues)
- Respect de la separation des responsabilites du projet
- Les nouveaux modules s'integrent coheremment dans la structure existante

### 5. Verifier les tests

- Tests presents pour les nouvelles fonctions
- Mocks et helpers partages utilises (tests/fixtures/ ou equivalent)
- Mocks pour les appels reseau et I/O dans les tests unitaires
- Markers pour les tests d'integration/E2E si applicable
- Couverture des cas d'erreur et edge cases

### 6. Rapport

Produire un rapport structure avec :
- **Bloquants** (a corriger avant merge)
- **Avertissements** (a considerer)
- **Suggestions** (ameliorations optionnelles)
- **Score global sur 100**

Lancer `bunx tsc --noEmit` et `bun test` pour valider.
