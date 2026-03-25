---
name: dev-explore
description: "Phase 0 optionnelle : exploration structuree avant implementation. TRIGGER when: idee vague, espace de solutions large, ou changement a fort impact architectural. DO NOT TRIGGER for: bugfix, evolution claire, refactoring bien delimite."
argument-hint: "<description du sujet a explorer>"
context: fork
---

Input : $ARGUMENTS (description libre du sujet a explorer)
Prerequis : aucun

## Etape 1 : Parser les arguments et deriver le nom

Extraire de "$ARGUMENTS" la description du sujet a explorer.

**Derivation du `{name}` en kebab-case** (5 etapes) :
1. Transliteration des accents (e->e, a->a, u->u, etc.)
2. Suppression des caracteres non alphanumeriques sauf espaces et tirets
3. Remplacement des espaces par des tirets
4. Conversion en minuscules
5. Troncature a 40 caracteres (couper au dernier tiret complet si possible)

**Fallback slug vide** : si le slug derive est vide apres les 5 etapes, utiliser un fallback generique `explore-{YYYYMMDD-HHMM}` (timestamp courant).

Validations :
- Si la description est vide : `ERREUR: description obligatoire. Usage : /dev-explore "sujet a explorer"` -> STOP

**Gestion anti-ecrasement** :
- Construire le chemin cible : `docs/explorations/EXPLORE-{name}.md`
- Si le fichier existe deja : **afficher un warning et demander confirmation avant ecrasement**
  - Si l'utilisateur confirme l'ecrasement -> ecraser
  - Si l'utilisateur refuse -> suffixer automatiquement avec `-2`, `-3`, etc. jusqu'a trouver un nom libre
  - En mode non-interactif (pas de confirmation possible) -> suffixer automatiquement

## Etape 2 : Deleguer a l'agent Explorer

1. Creer le dossier `docs/explorations/` s'il n'existe pas (`mkdir -p`)
2. Invoquer un subagent (Agent tool, subagent_type: general-purpose, model: sonnet) avec ce prompt :

> Lis ton profil agent dans `.claude/agents/explorer.md` et suis ses instructions.
> Sujet a explorer : "{description}"
> Nom de l'artefact : `{name}`
> Chemin de sortie : `docs/explorations/EXPLORE-{name}.md`

Attendre la completion du subagent.

## Etape 3 : Verifier l'artefact

1. Verifier que `docs/explorations/EXPLORE-{name}.md` existe
   - Si absent : `ERREUR: artefact non produit par l'agent Explorer -- verifier les logs du subagent` -> STOP
2. Lire le front-matter YAML et extraire les 5 champs obligatoires : `phase`, `generated_at`, `subject`, `verdict`, `next_step`
3. Verifier la presence des 6 sections obligatoires dans le body :
   - Section 1 -- Probleme
   - Section 2 -- Etat de l'art
   - Section 3 -- Archeologie codebase
   - Section 4 -- Matrice d'alternatives
   - Section 5 -- Verdict et justification
   - Section 6 -- Input pour etape suivante

## Etape 4 : Resume et etape suivante

Afficher un resume structure :

```
--- Exploration Phase 0 : {subject} ---
Verdict    : {verdict}
Alternatives evaluees : {P} options
Option recommandee : {option} (si GO, sinon "N/A")
Artefact   : docs/explorations/EXPLORE-{name}.md
```

Suggerer l'etape suivante selon le verdict :
- **GO** : "Prochaine etape : `/dev-implement` en citant l'artefact d'exploration comme input"
  - Exemple : `/dev-implement "Implementation de {option recommandee}. Exploration : docs/explorations/EXPLORE-{name}.md"`
- **PIVOT** : "Direction alternative identifiee. Lire la section 6 de l'artefact puis relancer `/dev-explore` sur la nouvelle piste"
- **DROP** : "Sujet abandonne. Les raisons sont documentees dans la section 6 de l'artefact"

## Regles

- **Wrapper uniquement** : ne PAS reimplementer la logique d'exploration -- toute l'analyse (3 axes, matrice, verdict) est dans `explorer.md`
- **Pas de modification code source** : Phase 0 est purement analytique
- **Pas de git push** : le commit est gere par le workflow global
