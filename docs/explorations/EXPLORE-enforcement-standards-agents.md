---
phase: 0-explore
generated_at: "2026-03-23T00:00:00Z"
subject: "Enforcement automatique des standards de developpement par les agents BMad et le pipeline de maturation CLI"
verdict: GO
next_step: "dev-spec"
---

# Section 1 — Probleme

## Origine

Les vagues 1-4 du durcissement des standards ont documente et implémenté six conventions de développement structurantes pour le projet :

1. **Result type** (`src/result.ts`) — gestion explicite des erreurs sans exception thrown
2. **createLogger** (`src/logger.ts`) — logger structuré JSON/couleur, correlation IDs, jamais `console.log`
3. **Config centralisée** (`src/config.ts`) — singleton Zod, jamais `process.env` direct
4. **Convention barrel** — tout module refactorisé en sous-répertoire DOIT conserver un barrel au chemin original
5. **Seuil 800 LOC** — fichiers source > 800 LOC sont candidats à la refactorisation
6. **Frontières architecturales** (ADR-008) — commandes → services → data (Supabase via paramètres), pas de cycle entre couches

Ces standards sont aujourd'hui documentés dans **CLAUDE.md** et **ADR-008**, et partiellement vérifiés par des tests structuraux (ex: `logger-migration.test.ts` vérifie l'absence de `console.log`). Mais ils ne sont **pas injectés dans les prompts agents** BMad (orchestrateur multi-agents `/orchestrate`, `/autopipeline`) ni dans les agents du pipeline de maturation CLI (`.claude/agents/implementer.md`, `.claude/agents/reviewer.md`, etc.).

## Pourquoi explorer avant de spécifier

Le problème est multi-dimensionnel avec plusieurs vecteurs d'enforcement possibles : injection dans les prompts, règles lint custom (Biome), tests structuraux, gate dédié, ou combinaison. Les agents BMad (orchestrateur) et les agents CLI (pipeline de maturation) ont des mécanismes d'injection différents. Une approche inadaptée à l'un ou l'autre canal risquerait d'introduire de la redondance, de la maintenance coûteuse, ou d'être silencieusement ignorée. L'exploration est nécessaire pour cartographier précisément les points d'injection existants et évaluer les alternatives.

## Magnitude du problème actuel

- **Pipeline BMad** : `src/bmad-prompts.ts` génère les prompts pour l'agent `dev` (via `getDevInstructions`) mais ne mentionne pas Result type, createLogger, getConfig, barrel, 800 LOC, ni frontières architecturales.
- **Pipeline CLI** : `.claude/agents/implementer.md` demande de "respecter les patterns existants du codebase" sans les nommer explicitement. L'agent Reviewer vérifie "pas de `any`" et "cohérence avec patterns existants" mais ne liste pas les six conventions.
- **Dev-challenge** : les agents adversariaux (Devil's Advocate, Edge Case Hunter, Simplicity Skeptic) lisent CLAUDE.md pour le contexte mais ne reçoivent pas d'instructions explicites sur la vérification des six standards.
- **Tests existants** : `logger-migration.test.ts` et `result.test.ts` vérifient respectivement l'absence de `console.log` et l'existence des exports de `result.ts`, mais ces tests ne couvrent pas l'utilisation dans les nouveaux fichiers ni les autres standards.

---

# Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://understandingdata.com/posts/custom-eslint-rules-determinism/ | Article technique | 2025 | Custom ESLint rules comme "teaching prompts" pour LLMs : les messages d'erreur structurés créent une boucle self-correcting (violation → erreur explicative → regeneration). 80% de réduction du temps de review manuel. Désactiver les inline-disable comments pour éviter le bypass | Haute |
| 2 | https://blog.jetbrains.com/idea/2025/05/coding-guidelines-for-your-ai-agents/ | Documentation officielle JetBrains | 2025 | Fichiers `.junie/guidelines.md` comme mécanisme primaire d'injection de guidelines dans les agents IA. Les guidelines doivent être adaptées par projet (pas de standard universel). Approche file-based persistante vs. injection dans chaque prompt | Haute |
| 3 | https://github.com/javierbrea/eslint-plugin-boundaries | Documentation npm/GitHub | 2025 | `eslint-plugin-boundaries` : définir des couches architecturales, spécifier les dépendances autorisées entre couches, enforcement ESLint immédiat. Compatible TypeScript, monorepos, architectures layered | Haute |
| 4 | https://nx.dev/docs/features/enforce-module-boundaries | Documentation Nx | 2025 | `@nx/enforce-module-boundaries` ESLint rule : checks TypeScript imports and package.json dependencies. Règle `no-restricted-imports` pour enforce architectural boundaries par directory structure | Moyenne |

## Synthese des enseignements

### Enseignement 1 : le prompt est suffisant mais fragile

JetBrains recommande les fichiers guidelines comme mécanisme d'injection principal. CLAUDE.md joue déjà ce rôle pour Claude Code (il est lu automatiquement à chaque session). Les agents CLI lisent CLAUDE.md en entrée (`.claude/skills/dev-challenge/SKILL.md` : "Lire les fichiers de configuration du projet pour les contraintes architecturales"). Le problème n'est pas l'absence du fichier mais l'absence d'une section dédiée "Standards à appliquer" rédigée pour être actionnable par un agent, pas juste informative pour un humain.

### Enseignement 2 : les règles lint custom créent une boucle de correction déterministe

L'article sur les custom ESLint rules expose un pattern puissant : quand un agent génère du code violant une règle, le message d'erreur structuré ("ici il faut Result<T, E>, pas throw") agit comme un correctif contextuel que l'agent peut appliquer dans l'itération suivante. Cette boucle est **déterministe** et ne dépend pas de la "bonne volonté" du modèle. Cependant Biome (actuellement utilisé dans ce projet) a une API de règles custom plus limitée qu'ESLint.

### Enseignement 3 : les frontières architecturales sont mieux enforced par des outils que par des prompts

`eslint-plugin-boundaries` et `@nx/enforce-module-boundaries` montrent que l'enforcement de la règle "commands → services → data" est un problème résolu par le tooling statique. Ces outils ne dépendent pas du modèle et s'exécutent en CI. Ils s'appliquent tant aux humains qu'aux agents.

### Enseignement 4 : la combinaison prompt + lint est la plus robuste

L'état de l'art converge : les guidelines dans les prompts (couche soft) réduisent la fréquence des violations, les règles lint (couche hard) bloquent les violations résiduelles en CI. Les deux couches sont complémentaires. Essayer de tout régler par les prompts produit une fausse sécurité ; essayer de tout régler par le lint est trop rigide pour des règles subjectives.

---

# Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/bmad-prompts.ts` (getDevInstructions, getOrchestrationInstructions) | Aucune mention de Result<T,E>, createLogger, getConfig, barrel, 800 LOC. La fonction `getDevInstructions("exec")` liste 8 instructions génériques. `getOrchestrationInstructions("dev")` liste 4 instructions. Point d'injection naturel pour les standards | Haut |
| 2 | `.claude/agents/implementer.md` | "Respecter les patterns existants du codebase" sans nommer les patterns. Section "Bonnes pratiques" : 4 items génériques. Point d'injection direct pour une section "Standards obligatoires" | Haut |
| 3 | `.claude/agents/reviewer.md` (Checklist de revue) | Checklist actuelle : TypeScript strict, pas d'any, cohérence patterns, BC, tests. Pas de mention Result<T,E>, createLogger, getConfig, barrel, 800 LOC | Haut |
| 4 | `.claude/skills/dev-challenge/SKILL.md` | Instruction "Lire les fichiers de configuration du projet pour les contraintes architecturales" → CLAUDE.md est lu. Mais pas de verification explicite des 6 standards par les agents adversariaux | Moyen |
| 5 | `.claude/agents/devils-advocate.md` | Axe 5 "Incoherences avec le contexte" inclut implicitement les standards mais pas explicitement. Le cross-référencement codebase est prévu mais non guidé vers les 6 standards | Moyen |
| 6 | `tests/unit/logger-migration.test.ts` | Vérifie l'absence de `console.log` dans 60 modules listés explicitement. Pattern réutilisable pour d'autres standards. Mais liste statique : les nouveaux modules ne sont pas auto-détectés | Moyen |
| 7 | `biome.json` | Règles actuelles : `noExplicitAny` (error), `noUnusedImports` (error), format basique. Aucune règle custom pour Result<T,E> usage, createLogger, getConfig, barrel. Biome 2.x supporte un plugin system mais moins mature qu'ESLint | Moyen |
| 8 | `lefthook.yml` | Pre-commit : biome check + tsc --noEmit. Pas de check standards custom | Faible |
| 9 | `tests/unit/doc-freshness.test.ts` | Vérifie la synchronisation CLAUDE.md ↔ modules src. Prouve que CLAUDE.md est lu en CI. Pattern extensible pour vérifier que CLAUDE.md contient une section standards actionnable | Faible |
| 10 | `src/agent.ts` (spawnClaudeCore) | CLAUDE.md est lu automatiquement par Claude Code CLI (convention) mais n'est pas injecté via `--append-system-prompt`. Les standards de CLAUDE.md arrivent donc dans le contexte de base de Claude Code, pas comme instruction système explicite | Moyen |
| 11 | `.claude/agents/spec-architect.md` | Lit CLAUDE.md pour explorer les patterns existants (section 6 de la spec). Mais aucune contrainte explicite sur les 6 standards dans la spec produite | Faible |
| 12 | `src/feedback-loop.ts` (buildFeedbackContext) | Injecte du feedback de rétro dans les prompts agents. Mécanisme existant pour enrichir les prompts de manière dynamique — extensible pour les standards | Faible |

### Points de friction

- **Biome vs ESLint** : Biome est l'outil linting en place. Ses règles custom (plugins Biome) sont moins matures qu'ESLint custom rules. Migrer vers ESLint uniquement pour les règles custom serait un coût élevé ; maintenir les deux outils en parallèle crée de la complexité.
- **Liste statique dans `logger-migration.test.ts`** : chaque nouveau module doit être ajouté manuellement. Un test dynamique qui scanne tous les fichiers `src/**/*.ts` serait plus robuste mais introduirait du bruit (barrels, types-only files).
- **Granularité** : certains standards (Result<T,E>) s'appliquent aux fonctions retournant des erreurs métier, pas à toutes les fonctions. Une règle lint aveugle produirait de faux positifs. La discrimination contextuelle est difficile à encoder dans une règle statique.

### Actifs réutilisables

- Le pattern de test structurel de `logger-migration.test.ts` (scan de fichiers src + regex exclusion commentaires/strings) est directement réutilisable pour les autres standards.
- `buildFeedbackContext` dans `src/feedback-loop.ts` est un mécanisme d'injection dynamique de contexte dans les prompts agents — extensible pour les standards.
- La fonction `buildIsolationInstructions` dans `src/bmad-prompts.ts` (lignes 535-552) montre le pattern pour ajouter des blocs d'instructions supplémentaires aux prompts agents.
- La section "Checklist de revue" de `.claude/agents/reviewer.md` est structurée pour accueillir des items supplémentaires sans refonte.

---

# Section 4 — Matrice d'alternatives

## Options

| Critere | A: Status quo | B: Injection prompt ciblée | C: Tests structuraux dynamiques | D: Lint rules custom (ESLint) | E: Combinaison B+C |
|---------|:------------:|:-----------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | S | S | L | M |
| **Valeur ajoutee** (obligatoire) | Low | Med | Med | High | High |
| **Risque technique** (obligatoire) | Low | Low | Low | Med | Low |
| *Impact maintenance* (pertinent) | Faible — les standards dérivent silencieusement | Faible — MAJ des fichiers agents à chaque nouveau standard | Moyen — MAJ de la liste de modules dans les tests | Élevé — règles custom à maintenir, outil à ajouter | Moyen — deux fichiers à mettre à jour |
| *Reversibilite* (pertinent) | N/A | Haute | Haute | Basse | Haute |

### Discussion

**A — Status quo** : CLAUDE.md et ADR-008 existent mais ne sont pas traduits en instructions actionnables pour les agents. Les agents peuvent violer les standards sans signal de feedback. Le risque est une dérive progressive de la qualité à mesure que le projet grandit et que de nouveaux agents/agents-CLI sont ajoutés. Valeur ajoutée nulle à court terme, coût nul, mais dette croissante.

**B — Injection prompt ciblée** : Ajouter une section "Standards obligatoires" à `.claude/agents/implementer.md`, `.claude/agents/reviewer.md`, et au `getDevInstructions` de `src/bmad-prompts.ts`. Coût S (2-3h de rédaction), impact immédiat sur tous les agents. La limite : c'est une contrainte "soft" — un agent peut l'ignorer ou mal l'interpréter. Mais en pratique, les modèles suivent bien les instructions explicites dans leurs prompts. Solution partielle pour le pipeline CLI, incomplète pour le BMad sans tests de vérification.

**C — Tests structuraux dynamiques** : Étendre `logger-migration.test.ts` en un module de vérification dynamique qui scanne automatiquement les nouveaux fichiers `src/**/*.ts` et vérifie les patterns des 6 standards. Ces tests s'exécutent en CI et bloquent les PRs qui violent les standards. Coût S-M (1-2 jours), robustesse élevée, auto-détection des nouveaux modules, pas de nouveau outil. Limite : certains standards (Result<T,E> pour la gestion d'erreur métier) ne sont pas détectables par regex simple sans faux positifs.

**D — Lint rules custom (ESLint)** : Ajouter ESLint pour les règles custom architecturales (eslint-plugin-boundaries pour les frontières architecturales, règles custom pour barrel/createLogger). Complexité élevée : double tooling (Biome + ESLint), configuration ESLint à maintenir, règles custom à écrire et tester. Valeur élevée pour les frontières architecturales mais sur-ingénierie pour les autres standards (Result<T,E>, 800 LOC, createLogger) qui sont mieux couverts par des tests structuraux. Non recommandé dans le contexte actuel où Biome est déjà en place et les équipes réduites (projet solo).

**E — Combinaison B+C** : Injection prompt (standards actionnables dans les agents) + tests structuraux dynamiques en CI (vérification post-implémentation). Les deux couches sont complémentaires et de complexité M au total. Le prompt guide l'agent pendant l'implémentation ; les tests bloquent les violations résiduelles. Pas de nouveau outil. Réutilise les patterns existants. **Option recommandée.**

---

# Section 5 — Verdict et justification

## Verdict : GO

**Option recommandée : E — Combinaison B (injection prompt) + C (tests structuraux dynamiques)**

### Justification

**Axe 1 (état de l'art)** confirme que la combinaison prompt + lint est l'approche la plus robuste selon les pratiques 2025-2026. La couche prompt réduit la fréquence des violations ; la couche lint/tests bloque les violations résiduelles. Les deux couches sont nécessaires et complémentaires.

**Axe 2 (archéologie codebase)** révèle que les deux points d'injection existent déjà et sont faibles à modifier : `getDevInstructions` et `getOrchestrationInstructions` dans `src/bmad-prompts.ts` pour le pipeline BMad, `.claude/agents/implementer.md` et `.claude/agents/reviewer.md` pour le pipeline CLI. Le pattern de test structurel de `logger-migration.test.ts` est immédiatement réutilisable. Aucun nouveau outil n'est nécessaire.

**Axe 3 (matrice)** montre que l'option E a un rapport valeur/complexité optimal : complexité M (estimée 1-2 jours), valeur High (enforcement bi-couche), risque Low (pas de nouveau outil, pas de breaking change), réversibilité Haute. L'option D (ESLint custom) est rejetée car elle introduit un double tooling coûteux à maintenir dans un projet solo.

Les quatre standards détectables par regex sans faux positifs significatifs sont : absence de `console.log/error/warn` (déjà couvert), utilisation de `createLogger` dans les nouveaux modules (pattern clair), absence de `process.env.` direct (hors `config.ts`), et vérification LOC > 800 (wc -l). Le standard Result<T,E> est mieux enforced par le prompt (règle subjective : "quand une fonction peut échouer de manière métier, retourner Result<T,E>"). Les frontières architecturales peuvent être vérifiées par un test structurel d'imports (grep circulaire entre couches).

---

# Section 6 — Input pour etape suivante

## Option recommandee : E — Injection prompt + tests structuraux dynamiques

### Perimetre de la spec (GO)

Deux livrables principaux :

**Livrable 1 — Injection dans les prompts agents (pipeline BMad + pipeline CLI)**

Pour le **pipeline BMad** (`src/bmad-prompts.ts`) :
- Ajouter un bloc "STANDARDS DU PROJET" dans `getDevInstructions("exec")` avec les 6 standards nommés et actionnables
- Ajouter une instruction "Vérifier les standards du projet" dans `getOrchestrationInstructions("dev")`

Pour le **pipeline CLI maturation** :
- Ajouter une section "Standards obligatoires" dans `.claude/agents/implementer.md` avec les 6 conventions listées (Result<T,E> pour erreurs métier, createLogger jamais console, getConfig jamais process.env direct, convention barrel, seuil 800 LOC, frontières architecturales ADR-008)
- Ajouter des items dans la "Checklist de revue" de `.claude/agents/reviewer.md` pour chaque standard vérifiable
- Ajouter une dimension "Conformité standards (ADR-008 + CLAUDE.md)" dans les axes d'analyse de `.claude/agents/devils-advocate.md`

**Livrable 2 — Tests structuraux dynamiques en CI**

Créer `tests/unit/coding-standards.test.ts` qui vérifie automatiquement sur tous les fichiers `src/**/*.ts` :
- Absence de `console.log/error/warn` (sauf barrels et scripts) — extension de `logger-migration.test.ts`
- Tout module avec `createLogger` est présent dans la liste des modules migrés (ou auto-détection)
- Absence de `process.env.` direct (hors `src/config.ts`)
- Aucun fichier source non-barrel ne dépasse 800 LOC (wc -l automatique)
- Vérification de l'acyclicité entre couches (commands → services) : aucun fichier `src/commands/*.ts` n'importe directement depuis Supabase, aucun fichier `src/*.ts` n'importe depuis `src/commands/`

### Fichiers concernes

| Fichier | Action |
|---------|--------|
| `src/bmad-prompts.ts` | Modifier — ajouter bloc standards dans getDevInstructions et getOrchestrationInstructions |
| `.claude/agents/implementer.md` | Modifier — section "Standards obligatoires" |
| `.claude/agents/reviewer.md` | Modifier — items checklist standards |
| `.claude/agents/devils-advocate.md` | Modifier — axe d'analyse standards |
| `tests/unit/coding-standards.test.ts` | Créer — tests structuraux dynamiques |

### Contraintes identifiees

- Les tests structuraux doivent exclure les barrels (fichiers re-export only), les fichiers de type (`*.d.ts`), les tests eux-mêmes, et le répertoire `node_modules`
- Le check LOC doit être tolérant : des commentaires longs (documentation) peuvent faire dépasser 800 LOC sans violation réelle. Seuil à 900 ou 1000 pour éviter les faux positifs
- Les instructions dans les prompts agents doivent rester concises (max 6 items) pour ne pas diluer les instructions principales — prioriser les standards les plus fréquemment violés
- Ne pas dupliquer le contenu de CLAUDE.md dans les prompts agents : pointer vers CLAUDE.md pour le détail, résumer en 1-2 phrases par standard dans les prompts

### Questions ouvertes pour la spec

1. **Scope LOC** : le seuil de 800 LOC dans les tests doit-il être 800 (strict, peut bloquer la CI) ou 1000 (pragmatique, pour la vague actuelle où pipeline.ts est à ~750 LOC) ?
2. **Auto-ajout ou liste statique** : le test de createLogger doit-il scanner dynamiquement tous les fichiers src qui ont une logique (pas barrels) ou maintenir une liste explicite comme `logger-migration.test.ts` ?
3. **Standards dans les agents de spec** : faut-il aussi injecter les standards dans `.claude/agents/spec-architect.md` pour qu'ils apparaissent dans la section 7 (Contraintes) de chaque spec produite ?
4. **Standards dans test-architect** : faut-il ajouter les standards dans `.claude/agents/test-architect.md` pour que les tests générés couvrent la conformité aux standards ?
