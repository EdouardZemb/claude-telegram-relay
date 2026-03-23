# Spec : Enforcement automatique des standards par les agents

> Genere le 2026-03-23. Source : exploration EXPLORE-enforcement-standards-agents.md, CLAUDE.md, ADR-008, src/bmad-prompts.ts, .claude/agents/implementer.md, .claude/agents/reviewer.md, tests/unit/logger-migration.test.ts.

## 1. Objectif

Garantir que les 6 standards de developpement du projet (Result type, createLogger, config centralisee, convention barrel, seuil 800 LOC, frontieres architecturales) sont automatiquement appliques lors de l'implementation par les agents BMad (orchestrateur `/orchestrate`, `/autopipeline`) et le pipeline CLI de maturation (`.claude/agents/`). Double couche d'enforcement : injection dans les prompts agents (soft, guide l'agent pendant l'implementation) + tests structurels dynamiques en CI (hard, bloque les PRs non conformes).

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Les instructions de l'agent `dev` dans le pipeline BMad (`getDevInstructions("exec")` et `getOrchestrationInstructions("dev")`) doivent inclure les 6 standards nommes et actionnables | Exploration S3-1, CLAUDE.md conventions | "Utiliser `Result<T, E>` de `src/result.ts` pour les erreurs metier (jamais throw)" |
| R2 | L'agent Implementer du pipeline CLI (`.claude/agents/implementer.md`) doit avoir une section "Standards obligatoires" listant les 6 conventions avec reference a CLAUDE.md | Exploration S3-2 | Section "## Standards obligatoires" avec 6 items |
| R3 | L'agent Reviewer du pipeline CLI (`.claude/agents/reviewer.md`) doit avoir dans sa checklist un item par standard verifiable. Attention : l'item existant L41 prescrivant `console.error` pour les erreurs Supabase doit etre corrige pour prescrire `log.error` (via createLogger) a la place, conformement au standard S1 | Exploration S3-3, challenge adversarial F-DA-1 (contradiction) | "- [ ] Pas de `console.log/error/warn` direct (utiliser `createLogger`)" |
| R4 | Un fichier de test structurel dynamique (`tests/unit/coding-standards.test.ts`) doit scanner tous les fichiers `src/**/*.ts` et verifier automatiquement les 4 standards detectables par analyse statique | Exploration S5-E | Absence de `console.log`, absence de `process.env.` direct, seuil LOC, acyclicite des couches |
| R5 | Les tests structurels doivent etre dynamiques : auto-decouverte des fichiers source (glob), pas de liste statique de modules | Exploration S3-6, question ouverte 2 | `Bun.glob("src/**/*.ts")` au lieu d'un tableau statique |
| R6 | Les tests structurels doivent exclure les fichiers non pertinents : barrels (re-export only), fichiers de type (`*.d.ts`), tests, `config.ts` (pour process.env), `logger.ts` (pour console), `result.ts` | Exploration S5-contraintes | Barrels : `memory.ts`, `orchestrator.ts` exclus du check LOC et process.env |
| R7 | Le seuil LOC est 800 lignes par fichier source non-barrel, conformement a CLAUDE.md. Les fichiers actuellement au-dessus du seuil sont en allowlist temporaire : `pipeline.ts` (1486), `agent-schemas.ts` (1091), `planning.ts` (1005), `gate-evaluator.ts` (937), `zz-messages.ts` (909), `graph.ts` (855), `workflow.ts` (848). Mettre a jour CLAUDE.md pour lister tous les fichiers > 800 LOC | CLAUDE.md "File size guideline", challenge adversarial (allowlist incomplete) | `pipeline.ts` (1486 LOC) est en allowlist temporaire |
| R8 | Les frontieres architecturales sont verifiees par un test d'imports : aucun fichier service (`src/*.ts`) n'importe depuis `src/commands/` | ADR-008, Exploration S5-E | `import { ... } from "./commands/foo"` dans un fichier service est une violation |
| R9 | Le standard Result type est enforce uniquement par le prompt (couche soft), pas par test structurel, car il s'agit d'une regle contextuelle ("quand une fonction peut echouer de maniere metier") non detectable par regex sans faux positifs | Exploration S4-E, S5-contraintes | Pas de test "tout fichier doit importer Result" |
| R10 | Les instructions injectees dans les prompts agents doivent rester concises (max 6 items, 1-2 phrases par standard) et pointer vers CLAUDE.md pour le detail, pas dupliquer le contenu | Exploration S5-contraintes | "Voir CLAUDE.md section Conventions pour le detail" |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `src/**/*.ts` | Fichiers source TypeScript | Filesystem (glob) | Contenu pour regex, nombre de lignes, imports |
| `src/bmad-prompts.ts` | Module prompts BMad | Code source | `getDevInstructions()`, instructions array |
| `src/orchestrator/agent-step.ts` | Module orchestration | Code source | `getOrchestrationInstructions()`, instructions array |
| `.claude/agents/implementer.md` | Agent profile CLI | Markdown | Sections contraintes, bonnes pratiques |
| `.claude/agents/reviewer.md` | Agent profile CLI | Markdown | Checklist de revue |
| CLAUDE.md | Project instructions | Markdown | Section Conventions |
| ADR-008 | Architecture decision record | Markdown | 3-layer architecture definition |

## 4. Donnees de sortie

### Livrable 1 — Injection prompts (couche soft)

**4 fichiers modifies** avec des blocs d'instructions standards inseres :

- `src/bmad-prompts.ts` : bloc "STANDARDS DU PROJET" dans `getDevInstructions("exec")` (6 items) + 1 ligne dans `getOrchestrationInstructions("dev")`
- `.claude/agents/implementer.md` : section "## Standards obligatoires" (6 items avec references)
- `.claude/agents/reviewer.md` : 6 items ajoutes dans la checklist de revue sous "### Standards projet"

### Livrable 2 — Tests structurels dynamiques (couche hard)

**1 fichier cree** : `tests/unit/coding-standards.test.ts`

Structure attendue du fichier de test :

```
describe("Coding standards — S1: no direct console calls")
  - Scanne dynamiquement tous src/**/*.ts (hors exclusions R6)
  - Pour chaque fichier : verifie absence de console.log/error/warn hors commentaires/strings
  - Reutilise le pattern getCodeLines + hasRealConsoleCall de logger-migration.test.ts

describe("Coding standards — S2: no direct process.env")
  - Scanne dynamiquement tous src/**/*.ts (hors config.ts, logger.ts)
  - Pour chaque fichier : verifie absence de process.env. hors commentaires/strings

describe("Coding standards — S3: LOC threshold")
  - Scanne dynamiquement tous src/**/*.ts
  - Exclut barrels et fichiers en allowlist temporaire (R7)
  - Pour chaque fichier : verifie LOC <= 800

describe("Coding standards — S4: architectural boundaries")
  - Verifie qu'aucun fichier src/*.ts (hors commands/) n'importe depuis src/commands/
  - Verifie qu'aucun fichier src/commands/*.ts n'importe directement @supabase/supabase-js

describe("Coding standards — S5: barrel convention")
  - Pour chaque sous-repertoire de src/ qui contient des modules (memory/, orchestrator/)
  - Verifie qu'un barrel file existe au chemin parent (src/memory.ts, src/orchestrator.ts)
```

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/bmad-prompts.ts` (552 LOC) | Modifier | Ajouter bloc "STANDARDS DU PROJET" dans `getDevInstructions("exec")` — point d'injection naturel, array de strings L262-278 |
| `src/orchestrator/agent-step.ts` (262 LOC) | Modifier | Ajouter ligne standards dans `getOrchestrationInstructions("dev")` — case "dev" L179-188 |
| `.claude/agents/implementer.md` | Modifier | Ajouter section "## Standards obligatoires" apres la section "## Bonnes pratiques" existante |
| `.claude/agents/reviewer.md` | Modifier | Ajouter sous-section "### Standards projet" dans la checklist de revue, apres "### Patterns projet" |
| `tests/unit/coding-standards.test.ts` | Creer | Tests structurels dynamiques — 5 suites de tests (S1-S5) avec auto-decouverte fichiers |
| `tests/unit/logger-migration.test.ts` | Ne pas modifier | Source du pattern reutilisable (`getCodeLines`, `hasRealConsoleCall`) — copier le pattern, pas importer depuis un test |

## 6. Patterns existants

### Pattern 1 : Filtrage code hors commentaires/strings (logger-migration.test.ts L78-103)

Le test `logger-migration.test.ts` contient deux fonctions reutilisables pour scanner le code source en excluant les faux positifs :

```typescript
// tests/unit/logger-migration.test.ts L78-87
function getCodeLines(content: string): string[] {
  return content.split("\n").filter((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("/*")) return false;
    return true;
  });
}

// tests/unit/logger-migration.test.ts L93-103
function hasRealConsoleCall(line: string, pattern: RegExp): boolean {
  if (!pattern.test(line)) return false;
  const withoutStrings = line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return pattern.test(withoutStrings);
}
```

Ce pattern sera copie (pas importe) dans `coding-standards.test.ts` et generalise pour detecter `process.env.` en plus de `console.*`. Le pattern `hasRealConsoleCall` strip deja les strings simples/doubles/template — il gere donc les template literals monolignes. Pour les multilignes, le filtre par ligne est suffisant car `console.log` ne peut pas etre a cheval sur 2 lignes. Challenge adversarial F-DA-2 resolu : le pattern existant est adequat.

### Pattern 2 : Injection d'instructions par bloc dans les prompts (bmad-prompts.ts L535-552)

La fonction `buildIsolationInstructions` montre le pattern pour ajouter un bloc structure aux prompts agents :

```typescript
// src/bmad-prompts.ts L535-552
export function buildIsolationInstructions(agentId: string): string {
  const caps = getAgentCapabilities(agentId);
  const lines: string[] = ["LIMITES DE TON ROLE:"];
  if (!caps.canModifyCode) lines.push("- Tu ne PEUX PAS modifier le code source");
  // ...
  return lines.join("\n");
}
```

Le bloc "STANDARDS DU PROJET" suivra le meme pattern : array de strings -> join("\n").

### Pattern 3 : Checklist structuree dans reviewer.md (L20-41)

La checklist de revue est organisee en sous-sections (`### Conventions`, `### Patterns projet`, `### Architecture et qualite`, `### Tests`). Les items standards seront ajoutes dans une nouvelle sous-section `### Standards projet` placee apres `### Patterns projet` pour respecter la structure existante.

### Pattern 4 : Section structuree dans implementer.md (L43-47)

La section "## Bonnes pratiques" de l'implementer est une liste a puces. La section "## Standards obligatoires" sera ajoutee immediatement apres, avec le meme format.

## 7. Contraintes

### Ce qu'il ne faut PAS casser

- **Backward compatibility des prompts** : les instructions existantes dans `getDevInstructions` et `getOrchestrationInstructions` doivent rester intactes — les standards sont ajoutes EN PLUS, pas en remplacement
- **Tests existants** : `logger-migration.test.ts` reste tel quel (il continuera a fonctionner sur sa liste statique). Le nouveau fichier `coding-standards.test.ts` est complementaire, pas un remplacement
- **Performance CI** : les tests structurels scannent ~88 fichiers TypeScript. Le scan doit rester rapide (< 2s). Pas de parsing AST, uniquement regex

### Limites techniques

- **Faux positifs process.env** : 27 fichiers utilisent actuellement `process.env.` en dehors de `config.ts`. Certains usages sont legitimes (ex: `process.env.NODE_ENV` dans logger.ts, `process.env.PROJECT_DIR` dans agent-step.ts pour le chemin du projet). Le test doit avoir une allowlist explicite pour ces usages avec un commentaire justificatif par entree
- **Faux positifs LOC** : 7 fichiers depassent deja 800 LOC (`pipeline.ts` 1486, `agent-schemas.ts` 1091, `planning.ts` 1005, `gate-evaluator.ts` 937, `zz-messages.ts` 909, `graph.ts` 855, `workflow.ts` 848). Ces fichiers sont en allowlist temporaire (R7). L'allowlist doit etre documentee dans le test avec reference au ticket de refactorisation futur
- **Result type non testable par regex** : la regle "utiliser Result<T,E> pour les erreurs metier" est subjective et contextuelle. Seule la couche prompt l'enforce (R9)

### Dependances

- Aucune dependance nouvelle. Le projet utilise deja Bun test, `fs.readFileSync`, `glob` natif Bun
- Les modifications de `bmad-prompts.ts` et `agent-step.ts` n'ajoutent pas d'import

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `getDevInstructions("exec")` retourne un string contenant les 6 standards nommes (Result, createLogger, getConfig, barrel, 800 LOC, frontieres) | Test unitaire : appeler `getDevInstructions("exec")` et verifier 6 keywords | unit |
| V2 | `getOrchestrationInstructions("dev")` mentionne les standards du projet | Test unitaire : appeler la fonction et verifier la presence d'une reference aux standards | unit |
| V3 | `.claude/agents/implementer.md` contient une section "Standards obligatoires" avec 6 items | Grep sur le fichier : chercher "## Standards obligatoires" + 6 marqueurs | unit |
| V4 | `.claude/agents/reviewer.md` contient "### Standards projet" dans la checklist avec des items checkables | Grep sur le fichier : chercher "### Standards projet" + items `- [ ]` | unit |
| V5 | Le test S1 (no console) detecte un fichier source avec `console.log` comme violation | Ajouter un mock file avec `console.log` dans le test, verifier echec | unit |
| V6 | Le test S2 (no process.env) detecte un fichier avec `process.env.FOO` comme violation et accepte les fichiers en allowlist | Ajouter un mock file dans le test, verifier echec + non-echec allowlist | unit |
| V7 | Le test S3 (LOC threshold) detecte un fichier depassant 800 lignes (hors allowlist) | Verifier via le test que les fichiers en allowlist passent et qu'un fichier fictif a 801 lignes echoue | unit |
| V8 | Le test S4 (architectural boundaries) detecte un import `from "./commands/..."` dans un fichier service | Verifier via le test que le scan des fichiers `src/*.ts` ne trouve aucun import interdit | unit |
| V9 | Le test S5 (barrel convention) verifie que `src/memory.ts` et `src/orchestrator.ts` existent comme barrels | Verifier via le test que chaque sous-repertoire de src/ a un barrel | unit |
| V10 | Les instructions standards dans les prompts restent concises : max 15 lignes ajoutees par point d'injection (R10) | Compter les lignes ajoutees dans le diff. Max 15 lignes pour getDevInstructions, max 3 pour getOrchestrationInstructions, max 12 pour implementer.md, max 10 pour reviewer.md | manual |
| V11 | `bun test tests/unit/coding-standards.test.ts` passe sur l'etat actuel du codebase (pas de regression) | Executer le test apres implementation. 0 failures | integration |
| V12 | Les tests existants (`bun test tests/unit/logger-migration.test.ts`) continuent de passer sans modification | Executer apres implementation. 0 failures | unit |
| V13 | L'allowlist LOC dans le test contient exactement les fichiers documentes dans CLAUDE.md comme au-dessus du seuil | Cross-reference allowlist du test avec la section "File size guideline" de CLAUDE.md | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Les 6 standards sont documentes mais pas enforces par les agents. L'exploration confirme que ni les prompts BMad ni les agents CLI ne les mentionnent explicitement |
| Perimetre | Couvert | Deux livrables clairs : injection prompts (4 fichiers) + tests structurels (1 fichier). Pipeline BMad et pipeline CLI couverts. Standards R1-R10 tracables |
| Validation | Couvert | 13 V-criteres couvrant les deux couches. 11 unit, 1 integration, 1 manual |
| Technique | Couvert | Pas de nouvelle dependance. Patterns existants reutilises. Points de friction identifies (faux positifs, allowlists) |
| UX | Non applicable | Pas d'interaction utilisateur directe — les modifications impactent les agents et la CI, pas l'interface Telegram |
| Alternatives | Couvert | L'exploration a evalue 5 options (A-E). L'option E (prompt + tests structurels) est retenue. L'option D (ESLint custom) est rejetee car double tooling dans un projet solo |

**Zones d'ombre residuelles :**

- **Scope exact de l'allowlist process.env** : les 27 fichiers utilisant `process.env.` devront etre audites un par un pendant l'implementation pour determiner lesquels sont legitimes (usage pre-config comme `process.env.PROJECT_DIR || process.cwd()`) et lesquels sont des violations a corriger. Cette allowlist sera documentee dans le test avec un commentaire justificatif par entree.
- **Evolution de l'allowlist LOC** : quand un fichier en allowlist sera refactorise sous 800 LOC, il devra etre retire de l'allowlist manuellement. Pas de mecanisme automatique de nettoyage prevu dans cette spec.
- **Agents adversariaux** : l'exploration suggerait de modifier `.claude/agents/devils-advocate.md` pour ajouter un axe "conformite standards". Ceci est hors scope de cette spec (les agents adversariaux analysent la spec, pas le code) mais pourrait etre ajoute dans une vague ulterieure.
