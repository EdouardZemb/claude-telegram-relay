---
name: enforcement-standards-vague-2
description: Extension coding-standards.test.ts avec S6-S9 (createLogger, cycles imports, couverture par fichier, plafond allowlist) + script CI couverture
status: ready
phase: 1-implement
exploration: docs/explorations/EXPLORE-enforcement-auto-standards-developpement.md
generated_at: "2026-03-24"
---

# SPEC — Enforcement automatique des standards (vague 2 : S6-S9)

## Section 1 — Objectif

Étendre le fichier `tests/unit/coding-standards.test.ts` (310 LOC, 162 tests dynamiques, S1-S5 tous verts) avec 4 nouveaux standards identifiés par l'exploration EXPLORE-enforcement-auto-standards-developpement.md. Ajouter un script CI pour le seuil de couverture par fichier. Le résultat : chaque convention documentée dans CLAUDE.md est soit enforced en CI (couche hard), soit prescrite dans les agents (couche soft, déjà en place dans reviewer.md).

### Contexte (déjà implémenté — hors scope)

Les éléments suivants sont déjà en production :

- S1-S5 dans `coding-standards.test.ts` : console, process.env, LOC, frontières, barrel
- Section "Standards projet" dans `.claude/agents/reviewer.md` (6 items checklist)
- Biome lint + typecheck en pre-commit (Lefthook)
- Suite complète en pre-push + CI

---

## Section 2 — Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | S6 : tout fichier `src/**/*.ts` non-barrel, non-.d.ts doit contenir `createLogger` (import ou appel). Exclusions : `logger.ts` (l'implémente), `result.ts` (types purs), `config.ts` (types + config), `semaphore.ts` (utilitaire générique sans log), fichiers ne contenant que des types/interfaces | EXPLORE §5 S6, logger-migration.test.ts pattern | `agent.ts` doit avoir `import { createLogger }` ou `const log = createLogger(...)` |
| R2 | S7 : aucun cycle dans le graphe d'imports statiques ES6 entre fichiers `src/**/*.ts`. Détection via DFS sur les imports `from "..."`. Les imports dynamiques `import()` sont ignorés (rares dans src/) | EXPLORE §5 S7 | Si A importe B et B importe A → violation |
| R3 | S8 : seuil de couverture par fichier de 30% lignes minimum. Enforcement via script CI custom parsant la sortie `bun test --coverage`. Exclusions : barrels, .d.ts, fichiers < 10 lignes | EXPLORE §5 S8, Bun bug #17028 | `sdd-agents.ts` à 15% → échec CI |
| R4 | S9 : le nombre d'entrées dans l'allowlist S2 (process.env) ne doit pas dépasser MAX=18 (taille actuelle : 16 allowlist + 2 excluded by design). Toute augmentation doit être justifiée par un commentaire dans le test | EXPLORE §5 S9 | Ajout d'un 19e fichier sans justification → échec test |
| R5 | Les tests S6 et S7 sont ajoutés dans `coding-standards.test.ts` (même fichier, même pattern). Le test S9 est un test meta dans le même fichier | EXPLORE §6 question 4 : DFS reste dans le même fichier car la complexité est contenue |
| R6 | Le script S8 est un fichier séparé `scripts/check-coverage.sh` appelé dans CI après les tests | Séparation : les tests structurels vérifient le code source, le script vérifie la sortie coverage |
| R7 | Ne pas fusionner `logger-migration.test.ts` dans `coding-standards.test.ts` — garder séparé pour clarté historique | EXPLORE §6 question 1 |
| R8 | Result<T,E> enforcement reste soft (prompt uniquement, pas de test structurel) car le pattern Supabase `{ data, error }` domine — forcer Result partout ajouterait du boilerplate sans gain | EXPLORE §3 points de friction, §6 question 3 |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| `src/**/*.ts` | Fichiers source TypeScript | Filesystem (glob via `getAllSourceFiles()`) | Contenu pour regex, imports, LOC |
| `bun test --coverage` | Sortie texte coverage | stdout CI | Lignes `% Stmts`, `% Lines` par fichier |
| `tests/unit/coding-standards.test.ts` | Fichier existant (310 LOC) | Code source | Helpers `getCodeLines`, `hasRealMatch`, `getAllSourceFiles`, `isBarrelFile` |

---

## Section 4 — Données de sortie

### Livrable 1 — Tests S6, S7, S9 dans coding-standards.test.ts

3 nouveaux `describe()` ajoutés au fichier existant :

```
describe("Coding standards — S6: createLogger mandatory")
  - Scanne tous src/**/*.ts (hors exclusions R1)
  - Pour chaque fichier : vérifie présence de createLogger import/appel
  - Allowlist pour fichiers types-only sans side-effects

describe("Coding standards — S7: no circular imports")
  - Construit graphe d'imports (regex sur `from "..."`)
  - DFS pour détecter cycles
  - Affiche le cycle complet en cas de violation

describe("Coding standards — S9: process.env allowlist size cap")
  - Test meta : vérifie que ALLOWLIST S2 + EXCLUDED_BY_DESIGN <= MAX (18)
  - Détecte toute inflation non justifiée de l'allowlist
```

### Livrable 2 — Script CI couverture par fichier

Fichier `scripts/check-coverage.sh` :
- Parse la sortie `bun test --coverage`
- Vérifie que chaque fichier source a >= 30% lignes couvertes
- Exclusions : barrels, .d.ts, fichiers < 10 lignes
- Allowlist initiale pour les fichiers actuellement sous le seuil
- Exit code 1 si violation, avec liste des fichiers en échec

### Livrable 3 — Step CI

Ajout d'un step dans `.github/workflows/ci.yml` après les tests :
```
- name: Per-file coverage check
  run: scripts/check-coverage.sh
```

---

## Section 5 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `tests/unit/coding-standards.test.ts` (~310 → ~500 LOC) | Modifier | Ajouter S6 (createLogger), S7 (cycles imports), S9 (plafond allowlist) |
| `scripts/check-coverage.sh` | Créer | Script CI pour seuil couverture par fichier (S8) |
| `.github/workflows/ci.yml` | Modifier | Ajouter step `check-coverage.sh` après les tests |

---

## Section 6 — Patterns existants

### Pattern 1 : Test dynamique par fichier (coding-standards.test.ts S1-S2)

```typescript
const files = getAllSourceFiles().filter(f => {
  if (f.endsWith(".d.ts")) return false;
  if (EXCLUDED.has(basename(f))) return false;
  if (isBarrelFile(f)) return false;
  return true;
});

for (const file of files) {
  it(`${file} has no direct console calls`, () => {
    const content = readFileSync(join(SRC_DIR, file), "utf-8");
    const codeLines = getCodeLines(content);
    const violations = codeLines.filter(line => hasRealMatch(line, PATTERN));
    expect(violations.length).toBe(0);
  });
}
```

S6 réutilise ce pattern exact avec un pattern `/createLogger/` et une logique inversée (vérifie présence, pas absence).

### Pattern 2 : Test meta allowlist (coding-standards.test.ts S3)

```typescript
// S3 vérifie déjà que les fichiers en allowlist sont encore au-dessus du seuil
for (const [file, expectedLoc] of Object.entries(LOC_ALLOWLIST)) {
  it(`allowlist: ${file} is still above ${MAX_LOC} LOC`, () => { ... });
}
```

S9 s'inspire de ce pattern pour vérifier la taille de l'allowlist S2.

### Pattern 3 : Parsing d'imports ES6 (pour S7)

```typescript
// Regex pour extraire les imports relatifs
const IMPORT_PATTERN = /(?:import|from)\s+['"](\.[^'"]+)['"]/g;

function getImports(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  const imports: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    imports.push(match[1]);
  }
  return imports;
}
```

Le DFS classique sur le graphe détecte les cycles et retourne le chemin complet pour le message d'erreur.

---

## Section 7 — Contraintes

### Ce qu'il ne faut PAS casser

- Les 162 tests S1-S5 existants doivent rester verts sans modification
- Le helper `getAllSourceFiles()` est partagé — ne pas changer sa sémantique
- Les allowlists S2 et S3 existantes ne sont pas modifiées par cette spec
- La CI existante (7 steps) n'est pas modifiée — le script couverture est ajouté EN PLUS

### Limites techniques

- **S6 faux positifs** : certains fichiers source ne font que déclarer des types/interfaces sans side-effects (ex: types purs). Ils n'ont pas besoin de logger. L'allowlist S6 doit couvrir ces cas. Critère : si un fichier n'a aucun appel de fonction (uniquement `type`, `interface`, `export type`), il est exclu
- **S7 résolution de chemin** : les imports relatifs (`./foo`, `../bar`) doivent être résolus par rapport au fichier source. Les extensions `.ts` peuvent être omises dans les imports. Le résolveur doit tester `path.ts` et `path/index.ts`
- **S7 performance** : ~48 fichiers source, graphe petit. Le DFS est O(V+E), négligeable
- **S8 parsing coverage** : la sortie `bun test --coverage` utilise un format tabulaire. Le script doit parser les colonnes `% Lines` par fichier. Le format peut changer entre versions de Bun — le script doit échouer proprement si le format n'est pas reconnu
- **S9 comptage** : le MAX inclut à la fois `ALLOWLIST` (16 entries) et `EXCLUDED_BY_DESIGN` (2 entries) = 18 total. Si un fichier est supprimé du codebase, son entrée allowlist devrait aussi être retirée (mais ce nettoyage est manuel)

### Dépendances

- Aucune dépendance nouvelle
- Le script `check-coverage.sh` utilise uniquement bash, grep, awk (outils standard)

---

## Section 8 — Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|--------------|--------|
| V1 | S6 : tout fichier src/ non-exclu contient `createLogger` | Test dynamique : chaque fichier → `grep createLogger` | unit |
| V2 | S6 : les fichiers types-only (result.ts, config types) sont correctement exclus | Test : vérifier que les exclusions ne cassent pas | unit |
| V3 | S7 : aucun cycle détecté dans l'état actuel du codebase | Test : DFS sur le graphe d'imports → 0 cycle | unit |
| V4 | S7 : un cycle artificiel est détecté (test de robustesse) | Test avec mock : A→B→A doit lever une erreur claire avec le chemin du cycle | unit |
| V5 | S9 : le nombre d'entrées allowlist S2 est <= 18 | Test meta : `Object.keys(ALLOWLIST).length + EXCLUDED_BY_DESIGN.size <= 18` | unit |
| V6 | S9 : ajout d'un 19e élément fait échouer le test | Vérification logique du test : MAX = 18, comptage strict | unit |
| V7 | Les 162 tests S1-S5 existants restent verts | `bun test tests/unit/coding-standards.test.ts` → 0 failure sur S1-S5 | unit |
| V8 | Le script `check-coverage.sh` parse correctement la sortie coverage | Exécution manuelle : `bash scripts/check-coverage.sh` → exit 0 sur l'état actuel | integration |
| V9 | Le script détecte un fichier sous le seuil de 30% | Test manuel avec seuil artificiel ou fichier sans tests | integration |
| V10 | La step CI `check-coverage.sh` est présente dans ci.yml | Grep : `check-coverage` dans ci.yml | unit |
| V11 | `bun test` complet (1820+ tests) passe après toutes les modifications | CI vert sur PR | integration |

---

## Section 9 — Coverage et zones d'ombre

### Matrice de couverture des dimensions

| Dimension | Couvert | Non couvert |
|-----------|---------|-------------|
| **Problème** | 4 standards non enforced identifiés par l'exploration (S6-S9) | — |
| **Périmètre** | 3 fichiers à modifier/créer, 0 fichier source impacté | — |
| **Validation** | 11 V-critères : 8 unit, 3 integration | Mock d'un cycle d'imports réel (risque faible car DFS est classique) |
| **Technique** | Réutilise helpers existants, 0 dépendance nouvelle, CI étendue | Format sortie coverage Bun peut changer entre versions |

### Alternatives évaluées

| Option | Verdict | Raison |
|--------|---------|--------|
| ESLint (no-floating-promises, naming-convention) | Écarté | ~50MB deps, cohabitation complexe avec Biome, seule règle à valeur ajoutée (no-floating-promises) détectable via test structurel |
| bunfig.toml coverageThreshold | Écarté | Bug #17028 : enforcement per-file sans allowlist possible, trop rigide. Script custom plus flexible |
| **Étendre coding-standards.test.ts + script CI (retenu)** | **GO** | Zero dépendance, infrastructure éprouvée, pattern extensible, ROI maximal |

### Zones d'ombre résiduelles

1. **Seuil couverture initial (30%)** : choisi arbitrairement comme plancher bas. L'exploration suggère d'analyser la distribution actuelle pendant l'implémentation et d'ajuster. Montée progressive de 5% par sprint.

2. **S6 types-only detection** : distinguer un fichier "types purs" (pas besoin de logger) d'un fichier avec de la logique nécessite une heuristique. Critère proposé : si le fichier ne contient aucun appel de fonction (uniquement `type`, `interface`, `export type`, `const` avec valeur littérale), il est exclu. Peut nécessiter ajustement de l'allowlist après premiers runs.

3. **S7 re-exports** : un barrel qui re-exporte (`export * from "./sub"`) crée un edge dans le graphe mais pas un "vrai" import fonctionnel. Le DFS le compte quand même — acceptable car les barrels ne devraient pas créer de cycles.

4. **Montée du seuil couverture** : le script S8 a un seuil initial de 30%. L'augmentation progressive (5%/sprint) est un processus manuel — pas de mécanisme automatique de montée prévu dans cette spec.
