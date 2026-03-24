# Pipeline Dev — Reference detaillee

Pipeline de maturation code, de l'exploration au commit.

## Diagramme du pipeline

```
                          ┌─────────────────────┐
                          │  Phase 0 (optionnel) │
                          │    /dev-explore       │
                          │  Verdict: GO/PIVOT/   │
                          │          DROP          │
                          └──────────┬────────────┘
                                     │ GO
                          ┌──────────▼────────────┐
                          │      Phase 1           │
                          │  /dev-implement (TDD)  │
                          │  Tests → Code →        │
                          │  Validation            │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 2           │
                          │     /dev-review        │
                          │  Reviewer              │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 3           │
                          │  /dev-doc + Commit     │
                          └───────────────────────┘
```

## Table de reference

| Phase | Nom | Declencheur | Input | Output | Agent(s) | Etape suivante |
|-------|-----|-------------|-------|--------|----------|----------------|
| 0 | Exploration | `/dev-explore` (optionnel) | Question ouverte | `docs/explorations/EXPLORE-{name}.md` | Explorer | Phase 1 (si GO) |
| 1 | Implementation TDD | `/dev-implement` | Besoin fonctionnel + explore (optionnel) | Code + tests + `docs/reviews/implement-{name}.md` | Pipeline interne (tests + code + validation) | Phase 2 |
| 2 | Review | `/dev-review` | Code implemente | Findings inline | Reviewer | Phase 3 |
| 3 | Doc + Commit | `/dev-doc` | Code review | Documentation + commit | Pipeline (inline) | Fin |

## Etapes detaillees

### Phase 0 — Exploration (optionnelle)

**Commande** : `/dev-explore`

**Quand l'utiliser** : quand le sujet est flou, qu'on hesite entre plusieurs approches, ou qu'on veut un etat de l'art avant d'implementer.

**Agent** : Explorer (`explorer.md`)

**Deroulement** :
1. Cadrage du probleme et des contraintes
2. Recherche de l'etat de l'art (codebase, documentation, web)
3. Archeologie du codebase (fichiers concernes, dependances)
4. Construction d'une matrice d'alternatives (3+ options)
5. Verdict argumente : GO (option recommandee) / PIVOT (reformuler) / DROP (abandonner)

**Artefact** : `docs/explorations/EXPLORE-{name}.md`

**Verdict** :
- **GO** : option recommandee identifiee, passer a `/dev-implement`
- **PIVOT** : reformuler le besoin, relancer l'exploration
- **DROP** : le besoin n'est pas justifie, abandonner

### Phase 1 — Implementation TDD

**Commande** : `/dev-implement`

**Deroulement** :
1. Analyse de la demande et decomposition en sous-taches
2. Generation des squelettes de tests TDD (bases sur les V-criteres si spec fournie)
3. Implementation du code pour faire passer les tests
4. Completion des tests avec edge cases, scenarios d'erreur, robustesse
5. Validation finale : `bun test` (max 2 iterations correctives)

**Input recommande** :
- Description de la feature, bug fix, ou refactoring
- Spec si disponible : `docs/specs/SPEC-{name}.md`
- Review adversariale si disponible : `docs/reviews/adversarial-SPEC-{name}.md`

**Artefact** : `docs/reviews/implement-{name}.md` (rapport d'implementation)

### Phase 2 — Review

**Commande** : `/dev-review`

**Agent** : Reviewer (`reviewer.md`)

**Score** : note sur 100 avec breakdown par categorie

**Correction** : les findings bloquants sont corriges immediatement. Les suggestions non-bloquantes vont au backlog.

### Phase 3 — Documentation + Commit

**Commande** : `/dev-doc`

**Deroulement** :
1. Mise a jour de la documentation (CLAUDE.md, docs/ si necessaire)
2. Execution CI : `bunx tsc --noEmit` + `bun test`
3. Commit avec message conventionnel

**Convention commit** :
```
type(scope): description concise

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

Types : `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Reprendre en contexte frais

Les artefacts fichiers permettent la reprise a n'importe quelle etape.

| Situation | Action |
|-----------|--------|
| Exploration faite, commencer l'implementation | `/dev-implement` en citant `docs/explorations/EXPLORE-{name}.md` |
| Spec existante, commencer l'implementation | `/dev-implement docs/specs/SPEC-{name}.md` |
| Implementation faite, lancer la review | `/dev-review` |
| Review faite, mettre a jour la doc | `/dev-doc` |

**Detection automatique** : fournir le chemin de l'artefact existant comme argument pour que le skill retrouve le contexte.
