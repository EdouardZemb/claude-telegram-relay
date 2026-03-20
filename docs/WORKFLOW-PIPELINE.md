# Workflows de maturation

Vue d'ensemble des pipelines de maturation code pour Claude Code.

## Principes fondateurs

### 1. Contexte frais

Chaque etape produit un artefact auto-suffisant sur disque. Un agent en contexte frais (nouvelle conversation) peut reprendre a n'importe quelle etape en lisant les artefacts precedents. Aucune information critique ne vit uniquement dans l'historique de conversation.

### 2. Artefacts durables

Les artefacts sont des fichiers Markdown structures avec front-matter YAML. Ils servent de contrat entre etapes : l'output d'une etape est l'input de la suivante. Ils sont versiones avec le code et servent de documentation vivante.

### 3. Chainement explicite

Chaque etape declare ses inputs et outputs. Le pipeline orchestre l'ordre d'execution, mais chaque etape peut aussi etre invoquee independamment. Les dependances sont verifiables : si l'artefact d'input n'existe pas, l'etape echoue avec un message clair.

### 4. Autonomie des etapes

Chaque etape est executee par un agent specialise qui a un role precis et un perimetre limite. Un agent Spec Architect ne fait que rediger des specs. Un agent Reviewer ne fait que relire du code. Cette separation des responsabilites evite la derive et garantit la qualite.

## Pipeline Dev

Maturation complete d'une feature, de l'idee au commit.

```
/dev-spec -> quality gate -> /dev-challenge + Impact -> /dev-implement (TDD) -> conformance -> review -> /dev-doc -> commit
```

Reference detaillee : [WORKFLOW-DEV.md](WORKFLOW-DEV.md)

Orchestration automatisee : `/dev-pipeline` (execute toutes les phases) ou `/dev-pipeline --from {phase}` (reprise).

## Conventions de nommage des artefacts

| Dossier | Contenu | Pattern de nommage |
|---------|---------|-------------------|
| `docs/specs/` | Specifications formelles | `SPEC-{kebab-name}.md` |
| `docs/reviews/` | Reviews adversariales | `adversarial-SPEC-{kebab-name}.md` |
| `docs/reviews/` | Analyses d'impact | `impact-SPEC-{kebab-name}.md` |
| `docs/reviews/` | Rapports d'implementation | `implement-{kebab-name}.md` |
| `docs/explorations/` | Rapports d'exploration | `EXPLORE-{kebab-name}.md` |

### Regles de nommage

- `{kebab-name}` : identifiant court en kebab-case derive du sujet (ex: `healthcheck-endpoint`, `cache-migration`)
- Les noms doivent etre stables : une fois un artefact cree, son nom ne change pas
- Les references entre artefacts utilisent des chemins relatifs depuis la racine du projet

## Workflows autonomes

Certaines commandes fonctionnent independamment du pipeline :

| Commande | Usage | Artefact |
|----------|-------|----------|
| `/dev-explore` | Exploration prealable, etat de l'art | `docs/explorations/EXPLORE-{name}.md` |
| `/dev-review` | Revue de code ponctuelle | Aucun (inline) |
| `/dev-test` | Generation de tests | Fichiers `tests/` |
| `/dev-doc` | Mise a jour documentation | Fichiers `docs/` |
