# Pipeline Dev — Reference detaillee

Pipeline de maturation code complet, de l'exploration au commit.

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
                          │     /dev-spec           │
                          │  Spec 9 sections       │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │     Phase 1b           │
                          │   Quality Gate         │
                          │  GO / REVISE / STOP    │
                          └──────────┬────────────┘
                                     │ GO
                     ┌───────────────┼───────────────┐
                     │               │               │
              ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
              │  Devil's    │ │  Edge Case  │ │  Impact     │
              │  Advocate   │ │  Hunter     │ │  Analyst    │
              └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                     │               │               │
                     └───────────────┼───────────────┘
                          ┌──────────▼────────────┐
                          │      Phase 2           │
                          │   Consolidation        │
                          │  adversarial + impact  │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 3           │
                          │  /dev-implement (TDD)  │
                          │  Test Arch → Impl →    │
                          │  Tester                │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │     Phase 3d           │
                          │  Conformance Check     │
                          │  V-criteres couverts   │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 4           │
                          │     Review             │
                          │  Reviewer + Security   │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 5           │
                          │  Doc + CI + Commit     │
                          └──────────┬────────────┘
                                     │
                          ┌──────────▼────────────┐
                          │      Phase 6           │
                          │  Rapport consolide     │
                          └───────────────────────┘
```

## Table de reference

| Phase | Nom | Declencheur | Input | Output | Agent(s) | Etape suivante |
|-------|-----|-------------|-------|--------|----------|----------------|
| 0 | Exploration | `/dev-explore` (optionnel) | Question ouverte | `docs/explorations/EXPLORE-{name}.md` | Explorer | Phase 1 (si GO) |
| 1 | Specification | `/dev-spec` ou `/dev-pipeline` | Besoin fonctionnel + explore (optionnel) | `docs/specs/SPEC-{name}.md` | Spec Architect | Phase 1b |
| 1b | Quality Gate | Automatique | Spec Rev.1 | Resume + verdict GO/REVISE/STOP | Pipeline (inline) | Phase 2 (si GO) |
| 2 | Challenge + Impact | `/dev-challenge` | Spec validee | `docs/reviews/adversarial-SPEC-{name}.md` + `impact-SPEC-{name}.md` | Devil's Advocate, Edge Case Hunter, Simplicity Skeptic, Impact Analyst | Phase 3 |
| 3 | Implementation TDD | `/dev-implement` | Spec Rev.2 + reviews | Code + tests + `docs/reviews/implement-{name}.md` | Test Architect, Implementer, Tester | Phase 3d |
| 3d | Conformance | Automatique | Tests + spec | Rapport conformance (V-criteres couverts) | Pipeline (inline) | Phase 4 |
| 4 | Review | `/dev-review` | Code implemente | Findings inline | Reviewer, Security Checker (conditionnel) | Phase 5 |
| 5 | Doc + CI + Commit | `/dev-doc` + CI | Code review | Documentation + commit | Pipeline (inline) | Phase 6 |
| 6 | Rapport | Automatique | Tous artefacts | Resume consolide | Pipeline (inline) | Fin |

## Etapes detaillees

### Phase 0 — Exploration (optionnelle)

**Commande** : `/dev-explore`

**Quand l'utiliser** : quand le sujet est flou, qu'on hesite entre plusieurs approches, ou qu'on veut un etat de l'art avant de specifier.

**Agent** : Explorer

**Deroulement** :
1. Cadrage du probleme et des contraintes
2. Recherche de l'etat de l'art (codebase, documentation, web)
3. Archeologie du codebase (fichiers concernes, dependances)
4. Construction d'une matrice d'alternatives (3+ options)
5. Verdict argumente : GO (option recommandee) / PIVOT (reformuler) / DROP (abandonner)
6. Si GO : production de l'input structure pour `/dev-spec`

**Artefact** : `docs/explorations/EXPLORE-{name}.md`

**Verdict** :
- **GO** : option recommandee identifiee, passer a `/dev-spec`
- **PIVOT** : reformuler le besoin, relancer l'exploration
- **DROP** : le besoin n'est pas justifie, abandonner

### Phase 1 — Specification

**Commande** : `/dev-spec`

**Agent** : Spec Architect

**9 sections obligatoires** :
1. **Contexte** : probleme a resoudre, motivation
2. **Objectifs** : resultats attendus, mesurables
3. **Perimetre** : in-scope / out-of-scope explicites
4. **Design** : architecture, diagrammes, interfaces
5. **V-criteres** : criteres de validation numerotes (V1, V2...), chacun avec niveau (unit/integration/E2E/manual)
6. **Coverage matrix** : 6 dimensions (fonctionnel, erreurs, edge cases, securite, performance, integration)
7. **Risques** : risques identifies et mitigations
8. **Dependances** : modules, APIs, outils externes
9. **Plan** : decoupage en taches, estimation effort

**Artefact** : `docs/specs/SPEC-{name}.md`

### Phase 1b — Quality Gate

**Declencheur** : automatique apres Phase 1

**Verification** :
- Les 9 sections sont presentes et non vides
- Les V-criteres ont des niveaux de test
- La coverage matrix couvre les 6 dimensions
- Le perimetre est explicite (in/out)

**Verdict** :
- **GO** : spec complete, passer au challenge
- **REVISE** : sections manquantes ou insuffisantes, retour Phase 1
- **STOP** : besoin mal defini, abandonner ou repartir de Phase 0

### Phase 2 — Challenge adversarial + Impact

**Commande** : `/dev-challenge`

**Agents** (en parallele) :
- **Devil's Advocate** : cherche les failles logiques, les hypotheses non verifiees, les cas oublies
- **Edge Case Hunter** : cherche les edge cases, les scenarios de defaillance, les inputs malformes
- **Simplicity Skeptic** : questionne la complexite, propose des alternatives plus simples
- **Impact Analyst** : mesure l'impact sur le codebase existant (fichiers modifies, interfaces cassees, migrations)

**Deroulement** :
1. Les 4 agents analysent la spec en parallele
2. Consolidation des findings (dedupliques, tries par severite)
3. Les findings critiques sont integres dans une Spec Rev.2
4. Un finding identifie par 3+ agents est un signal fort de priorite

**Artefacts** :
- `docs/reviews/adversarial-SPEC-{name}.md` (findings consolides)
- `docs/reviews/impact-SPEC-{name}.md` (analyse d'impact)
- `docs/specs/SPEC-{name}.md` Rev.2 (spec mise a jour)

### Phase 3 — Implementation TDD

**Commande** : `/dev-implement`

**Agents** (sequentiels) :
1. **Test Architect** : ecrit les tests d'abord, bases sur les V-criteres de la spec
2. **Implementer** : ecrit le code qui fait passer les tests
3. **Tester** : execute les tests, verifie la couverture, ajoute des tests manquants

**Deroulement** :
1. Test Architect lit la spec Rev.2 et cree les squelettes de tests
2. Implementer ecrit le code (un module a la fois)
3. Tester execute `pytest`, verifie couverture, ajoute tests edge cases
4. Iteration jusqu'a CI verte

**Convention nommage tests** :
- `test_{spec_slug}.py` ou `test_{spec_slug}_*.py`
- Le slug est derive du nom de spec : `SPEC-foo-bar.md` -> `foo_bar`
- Les markers `@pytest.mark.spec("Vx")` lient un test a un V-critere

**Artefact** : `docs/reviews/implement-{name}.md` (rapport d'implementation)

### Phase 3d — Conformance Check

**Declencheur** : automatique apres Phase 3

**Verification** :
- Chaque V-critere de la spec a au moins un test marque `@pytest.mark.spec("Vx")`
- Les fichiers test suivent la convention de nommage (R16)
- Les V-criteres E2E/manual sont notes INFO (non bloquants pour la CI)

**Rapport** : nombre de V-criteres couverts / total, liste des manquants

### Phase 4 — Review

**Commande** : `/dev-review`

**Agents** :
- **Reviewer** : revue de code classique (lisibilite, maintenabilite, conventions, bugs potentiels)
- **Security Checker** (conditionnel) : active si le diff touche auth, crypto, inputs utilisateur, chemins fichiers

**Score** : note sur 100 avec breakdown par categorie

**Correction** : les findings critiques sont corriges immediatement. Les suggestions non-bloquantes vont au backlog.

### Phase 5 — Documentation + CI + Commit

**Deroulement** :
1. `/dev-doc` : mise a jour de la documentation (CLAUDE.md, README si necessaire)
2. Execution CI : `just ci` (lint + tests)
3. Commit automatique si CI verte

**Convention commit** :
```
type(scope): description concise

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

Types : `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

### Phase 6 — Rapport consolide

**Declencheur** : automatique en fin de pipeline

**Contenu** :
- Resume de la feature
- Artefacts produits (avec chemins)
- Metriques : nombre de tests, couverture V-criteres, score review
- Backlog items generes (BL.x)
- Duree totale du pipeline

## Reprendre en contexte frais

Le pipeline supporte la reprise a n'importe quelle etape via `--from`.

```bash
# La spec existe deja, reprendre au challenge
/dev-pipeline --from challenge

# Spec + challenge faits, reprendre a l'implementation
/dev-pipeline --from implement

# Implementation faite, reprendre a la review
/dev-pipeline --from review

# Review faite, reprendre a la documentation + commit
/dev-pipeline --from doc
```

**Prerequis** : les artefacts des etapes precedentes doivent exister sur disque. Le pipeline verifie leur presence avant de demarrer et echoue avec un message explicite si un artefact manque.

**Detection automatique** : sans `--from`, le pipeline detecte l'etape de reprise en scannant les artefacts existants.

## Workflows autonomes

### Assessment rapide

```bash
/dev-assess
```

Evaluation rapide d'une idee sans pipeline complet. Produit un avis structure (probleme, alternatives, recommandation) sans creer d'artefact durable.

### Review ponctuelle

```bash
/dev-review
```

Revue de code sur un diff existant, sans lien avec un pipeline. Utile pour les PRs exterieures ou les revues de code quotidiennes.

### Generation de tests

```bash
/dev-test
```

Genere des tests pour du code existant, sans spec prealable. Utile pour augmenter la couverture de code legacy.
