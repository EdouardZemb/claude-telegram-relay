---
phase: 0-explore
generated_at: "2026-03-24T14:30:00+01:00"
subject: "Enforcement automatique des standards de developpement"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Enforcement automatique des standards de developpement

## Section 1 -- Probleme

Le projet claude-telegram-relay dispose de conventions documentees dans CLAUDE.md (pas de console.log, acces env centralise via getConfig, seuil 800 LOC, conventions barrel, usage Result) et d'un fichier de tests `coding-standards.test.ts` qui en enforce deja 5 (S1-S5). Cependant, plusieurs standards restent non enforces automatiquement :

1. **Usage de Result<T,E>** : le type Result est defini dans `src/result.ts` mais n'est utilise que dans `src/commands/tasks.ts`. Les 5 autres fichiers avec `throw new Error` (documents.ts, transcribe.ts, intent-detection.ts, utilities.ts, config.ts, job-manager.ts) n'utilisent pas ce pattern.
2. **Couverture par fichier** : la couverture globale est a 66.64% lignes / 59.42% fonctions, mais il n'y a pas de seuil par fichier enforce — certains modules critiques pourraient avoir une couverture tres basse sans que CI echoue.
3. **Analyse statique supplementaire** : Biome est configure et passe en CI, mais certaines regles custom projet-specifiques (ex : pas d'import circulaire, pas de `any` cast hors tests) ne sont pas encore testees.
4. **Allowlist process.env qui grossit** : le standard S2 a 16 fichiers en allowlist, ce qui dilue l'intention originale.

L'exploration doit determiner quelles regles ajouter, comment structurer les tests, et evaluer le ratio effort/impact pour chaque renforcement.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [typescript-eslint rules](https://typescript-eslint.io/rules/) | Doc officielle | 2026-03-24 | 100+ regles TypeScript dont no-explicit-any, no-unused-vars, no-floating-promises, naming-convention. Supporte regles custom avec RuleTester. | Haute |
| 2 | [Bun coverage thresholds](https://bun.com/docs/test/code-coverage) | Doc officielle | 2026-03-24 | bunfig.toml supporte coverageThreshold (lines, functions, statements). Enforcement per-file, pas global (bug #17028 open). Workaround : script custom parsant "All files". | Haute |
| 3 | [ESLint + Bun setup](https://medium.com/@dharminnagar/setting-up-eslint-prettier-husky-in-a-bun-typescript-project-063fb5076d12) | Blog | 2026-03-24 | Guide complet ESLint + Prettier + Husky pour Bun. Compatible lefthook. | Moyenne |
| 4 | [Bun coverage per-file bug #17028](https://github.com/oven-sh/bun/issues/17028) | GitHub Issue | 2025-02 | coverageThreshold applique per-file, pas global. Tout fichier sous le seuil fait echouer le build, meme si le global est OK. | Haute |

### Synthese

L'ecosysteme offre deux approches complementaires pour enforcer des standards :

**Approche A -- Tests structurels (bun:test)** : c'est l'approche deja en place avec `coding-standards.test.ts`. Avantages : zero dependance supplementaire, integre au CI existant, tests lisibles et maintenables, detection immediate avec message d'erreur clair. Inconvenient : chaque regle est codee manuellement.

**Approche B -- Linter (ESLint/Biome)** : Biome est deja integre. ESLint avec typescript-eslint offrirait des regles supplementaires (no-floating-promises, consistent-type-imports, naming-convention). Inconvenient : ajout d'une dependance lourde (eslint + typescript-eslint + parser), duplication avec Biome pour les regles deja couvertes, complexite de configuration.

**Approche C -- Couverture par fichier** : Bun supporte coverageThreshold dans bunfig.toml mais l'enforcement est per-file (bug #17028), ce qui est en fait le comportement desire ici. Alternative : script custom dans CI. Le CI existant verifie deja le seuil global (60% lignes) via parsing de la sortie.

La tendance 2025-2026 est de combiner analyse statique (Biome/ESLint) avec des tests architecturaux custom ("ArchUnit" pattern) pour les regles projet-specifiques. Les projets Bun matures preferent etendre les tests existants plutot qu'ajouter ESLint en plus de Biome.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `tests/unit/coding-standards.test.ts` (310 LOC) | 5 standards enforces (S1-S5) : console, process.env, LOC, boundaries, barrel. 162 tests dynamiques. Infrastructure solide et extensible. | Ancrage principal |
| 2 | `tests/unit/logger-migration.test.ts` | Verifie que les modules migres utilisent createLogger. Helpers getCodeLines/hasRealMatch copies dans coding-standards.test.ts. | Pattern reutilisable |
| 3 | `tests/generated/durcissement-incremental-des-standards.test.ts` | Tests V1-V16 pour tsconfig, biome, lefthook, config.ts, CI. Valide l'infra statique. | Couverture infra OK |
| 4 | `tests/system/module-integrity.test.ts` | Verifie imports/exports de tous les modules core. Anti-regression structurelle. | Complementaire |
| 5 | `src/result.ts` (41 LOC) | Result<T,E> avec ok/err/isOk/isErr. Teste a 100% dans result.test.ts. | Standard sous-utilise |
| 6 | `src/config.ts` (172 LOC) | getConfig() centralise avec Zod. 16 fichiers en allowlist S2. | Allowlist a reduire |
| 7 | `biome.json` | noExplicitAny: error, noUnusedImports: error, noUnusedVariables: warn. Deja integre CI + lefthook. | Couverture statique existante |
| 8 | `lefthook.yml` | Pre-commit: biome-check + typecheck (tsc --noEmit). | Gate local OK |
| 9 | `.github/workflows/ci.yml` | Type check + unit/integration/system tests + doc freshness + coverage global 60%. | Pipeline CI complet |
| 10 | `src/commands/tasks.ts` | Seul fichier utilisant `import { err, ok, type Result } from "../result.ts"`. | Adoption Result faible |

### Points de friction

- **Result adoption** : imposer Result partout d'un coup toucherait ~30 fichiers avec pattern `{ data, error }` Supabase. Le standard original dans CLAUDE.md dit "usage Result" mais la realite est que Supabase retourne `{ data, error }` et non `Result<T, E>`. Forcer une conversion systematic ajouterait du boilerplate sans gain reel. L'enforcement devrait cibler les nouvelles fonctions a signature explicite, pas le wrapping Supabase.
- **Allowlist process.env S2** : 16 fichiers allowlistes. Certains (heartbeat.ts, job-manager.ts, pipeline-tracker.ts) sont des processus standalone ou le config lazy singleton n'est pas adapte. L'allowlist est justifiee et documentee. Reduire l'allowlist necessite un refactoring de getConfig() pour supporter l'initialisation eager, hors scope enforcement.
- **Couverture per-file** : le bug Bun #17028 fait que `coverageThreshold` dans bunfig.toml echoue si UN fichier est sous le seuil. C'est le comportement desire mais necessite un seuil bas initial (ex: 30%) puis montee progressive.

### Actifs reutilisables

- `getCodeLines()` et `hasRealMatch()` dans coding-standards.test.ts : helpers AST-lite reutilisables pour toute nouvelle regle
- `getAllSourceFiles()` : discovery de tous les fichiers src/*.ts
- `isBarrelFile()` : detection des barrels pour exclusion
- Pattern de test dynamique `for (const file of files) { it(...) }` : genere un test par fichier, excellent pour diagnostic CI
- Infrastructure CI (ci.yml) : deja configuree pour unit + system tests, ajout d'un nouveau fichier test zero-friction

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Etendre coding-standards.test.ts | C: Ajouter ESLint | D: bunfig.toml coverageThreshold |
|---------|:------------:|:-----------------------------------:|:------------------:|:-------------------------------:|
| **Complexite** | S | S | L | S |
| **Valeur ajoutee** | Low | High | Med | Med |
| **Risque technique** | Low | Low | Med | Med |
| *Impact maintenance* | Neutre | Faible (memes patterns) | Lourd (config ESLint + Biome cohabitation) | Faible (1 fichier) |
| *Reversibilite* | N/A | Totale (supprimer tests) | Moyenne (desinstaller deps) | Totale (supprimer bunfig) |

### Discussion

**A: Status quo** — Les 5 standards actuels (S1-S5) couvrent les conventions les plus critiques. Mais aucun mecanisme ne detecte les regressions sur les nouveaux standards (Result, createLogger uniformise, imports circulaires). Le risque est la derive progressive. Valeur ajoutee nulle car les lacunes identifiees persistent.

**B: Etendre coding-standards.test.ts** — Ajouter S6 (Result usage pour nouvelles fonctions exportees), S7 (couverture par fichier via script custom), S8 (pas d'import circulaire), S9 (createLogger obligatoire hors barrels/type defs). Reutilise toute l'infrastructure existante. Le pattern est eprouve (162 tests, 0 fail), extensible, et zero nouvelle dependance. Les tests structurels sont plus lisibles qu'une config ESLint pour les regles projet-specifiques. Complexite S car les helpers existent deja.

**C: Ajouter ESLint** — Apporterait no-floating-promises, consistent-type-imports, naming-convention. Mais ces regles sont soit deja couvertes par Biome (noExplicitAny, noUnusedImports), soit non prioritaires (naming-convention). Le cout est eleve : ~50MB de deps, configuration complexe pour cohabiter avec Biome, double linter en CI. La regle no-floating-promises est la seule a haute valeur non couverte, mais elle peut etre ajoutee via un test structurel simple (detecter les await manquants sur les Promises retournees).

**D: bunfig.toml coverageThreshold** — Activer `coverageThreshold = { lines = 30 }` dans bunfig.toml. Bun enforcera per-file (bug #17028 = comportement desire ici). Risque : certains fichiers bas (<30%) feraient echouer CI immediatement, necessite une allowlist ou un seuil initial tres bas. Alternative : script custom dans CI qui parse la sortie coverage et verifie fichier par fichier avec allowlist, plus flexible mais plus complexe.

## Section 5 -- Verdict et justification

**Verdict : GO** — Option B (etendre coding-standards.test.ts) combinee avec un volet couverture (D light, script custom).

**Justification :**

1. **Infrastructure prouvee** : le fichier coding-standards.test.ts est operationnel depuis plusieurs sprints, avec 162 tests dynamiques, zero faux positif, et une architecture extensible (helpers, discovery, exclusions documentees). Ajouter 3-4 standards supplementaires suit le meme pattern S/M de complexite.

2. **Zero nouvelle dependance** : contrairement a ESLint (option C, ~50MB deps), l'extension des tests structurels n'ajoute aucune dependance. Le projet utilise deja Biome pour le linting generique et bun:test pour les tests structurels — les deux couches sont complementaires sans overlap.

3. **ROI maximum** : les standards les plus impactants non encore enforces sont (a) la verification que createLogger est utilise dans tout fichier non-barrel (S6), (b) l'absence d'imports circulaires (S7), et (c) le seuil de couverture par fichier (via script CI). Ces 3 ajouts couvrent les 3 sources de regression les plus frequentes observees dans l'historique du projet (commits reintroduisant console.log, fichiers sans tests, imports brises).

4. **Approche incrementale** : chaque nouveau standard est un `describe()` independant dans le meme fichier, activable/desactivable via allowlist, avec messages d'erreur explicites. Pas de big-bang, pas de risque de casser CI.

5. **L'option C (ESLint) est exclue** car la seule regle a haute valeur non couverte (no-floating-promises) peut etre detectee via un test structurel simple, sans justifier l'ajout de 50MB de deps et la cohabitation complexe avec Biome.

## Section 6 -- Input pour etape suivante

### Option recommandee : Etendre coding-standards.test.ts + script couverture CI

### Standards a ajouter

| Standard | Description | Approche | Priorite |
|----------|-------------|----------|:--------:|
| S6 | createLogger obligatoire dans tout fichier src/*.ts non-barrel, non-.d.ts | Test structurel : grep `createLogger` + exclusion logger.ts, barrels, .d.ts | P1 |
| S7 | Pas d'imports circulaires | Test structurel : construire graphe d'imports, detecter cycles (DFS) | P2 |
| S8 | Seuil couverture par fichier (30% initial, monte progressive) | Script CI custom parsant `bun test --coverage` output | P2 |
| S9 | Allowlist S2 (process.env) ne grossit pas sans justification | Test meta : verifier que le nombre d'entrees allowlist <= MAX | P3 |

### Fichiers concernes

- `tests/unit/coding-standards.test.ts` : fichier principal a etendre (S6, S7, S9)
- `.github/workflows/ci.yml` : ajouter step couverture par fichier (S8)
- `bunfig.toml` : creer si necessaire pour config coverage reporter
- Aucun fichier source src/ modifie (Phase 0 = enforcement, pas refactoring)

### Contraintes identifiees

- S6 (createLogger) : exclure logger.ts, barrels, .d.ts, et les fichiers qui n'ont pas de side-effects (result.ts, config.ts types-only). Definir une allowlist initiale stricte.
- S7 (imports circulaires) : la detection de cycles necessite un parser d'imports simple (regex-based suffit pour les imports statiques ES6). Les imports dynamiques `import()` sont ignores (rare dans src/).
- S8 (couverture par fichier) : le seuil initial doit etre bas (30% lignes) pour ne pas bloquer CI. Monter de 5% par sprint. Exclure les fichiers generes, barrels, et .d.ts.
- S9 (taille allowlist) : le MAX initial = 16 (taille actuelle). Toute augmentation doit etre justifiee dans un commentaire.

### Questions ouvertes a resoudre pendant la spec

1. Faut-il fusionner `logger-migration.test.ts` dans `coding-standards.test.ts` (eviter duplication helpers) ou garder la separation pour clarte historique ?
2. Le seuil couverture initial per-file (30%) est-il trop bas/haut ? Analyser la distribution actuelle.
3. Faut-il ajouter un standard S10 pour Result<T,E> usage, ou est-ce premature vu que seul `tasks.ts` l'utilise et que le pattern Supabase `{ data, error }` est dominant ?
4. Le test de cycles d'imports doit-il etre dans coding-standards.test.ts ou dans un fichier dedie (vu la complexite du DFS) ?
