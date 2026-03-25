---
name: dev-doc
description: "Mise a jour documentation projet. TRIGGER when: structure, outils ou architecture ont change."
---

Input : $ARGUMENTS (modules/packages specifies) ou aucun (audit complet)
Prerequis : aucun

## Scope

Fichiers de documentation concernes :
- `CLAUDE.md` (racine) : instructions principales pour Claude Code
- `docs/` : documentation technique du projet
- `{module}/CLAUDE.md` : contexte specifique par module/package (si applicable)
- `{module}/README.md` : documentation utilisateur par module (si applicable)

## Etapes

### 1. Audit de coherence

- Verifier que la documentation reflete le code actuel
- Verifier que la structure documentee correspond a la realite (modules, exports, API)
- Identifier les informations obsoletes ou manquantes
- Verifier la coherence entre les differents fichiers de documentation

### 2. Mise a jour

Pour chaque fichier a mettre a jour :
1. Lire le fichier existant
2. Lire les fichiers source correspondants pour verifier l'exactitude
3. Appliquer les modifications necessaires
4. Garder le style concis et factuel (pas de prose)

### 3. Conventions

- Markdown standard, pas d'emojis
- Tableaux pour les listes structurees
- Blocs de code avec langage specifie
- Sections courtes et facilement parcourables
- Pas de duplication d'information entre fichiers

### 4. Verification sante

- Documentation racine raisonnable en taille (eviter le bloat de contexte)
- Tous les modules/packages principaux ont une documentation minimale
- Les compteurs et listes (nombre d'outils, liste de modules, etc.) sont coherents entre documentation et code

### 5. Validation

- Verifier que les commandes documentees fonctionnent
- Verifier que les chemins de fichiers sont corrects
- Verifier la coherence entre documentation racine et documentation par module

## Ce qu'il ne faut PAS faire

- Ne pas ajouter de documentation speculative
- Ne pas documenter du code qui n'existe pas encore
- Ne pas dupliquer le contenu entre differents fichiers de documentation
- Ne pas modifier le code source (uniquement la documentation)
