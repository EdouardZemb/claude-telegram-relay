# Spec : Corriger les defauts du pipeline d'agents autonomes

> Genere le 2026-03-22. Source : exploration prealable (docs/explorations/EXPLORE-corriger-les-defauts-du-pipeline-dagents.md), analyse codebase, CLAUDE.md conventions.

## 1. Objectif

Corriger quatre defauts structurels du pipeline d'agents autonomes (spawnClaude -> branch -> commit -> PR -> CI) qui causent des echecs repetitifs en CI sur les branches audit. Les corrections ciblent : (1) l'absence de validation TypeScript/tests avant commit dans `executeTask`, (2) les erreurs Supabase silencieuses dans `heartbeat.ts`, (3) le manque d'instructions agents pour la mise a jour de CLAUDE.md, et (4) l'import fragile cross-frontieres `../scripts/doc-utils.ts` dans `src/`. L'objectif est un feedback precoce (pre-commit plutot que post-push CI) et l'elimination des erreurs silencieuses.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Avant tout `git commit` dans `executeTask`, un typecheck (`bun build --no-bundle --target=bun`) DOIT etre execute sur les fichiers modifies. Si le typecheck echoue, le commit est bloque et la branche annulee avec `success: false`. | Exploration S1 (cause racine 1), etat de l'art (tsc --noEmit gate), convention CI ci.yml | Un agent introduit `const x: number = "foo"` → typecheck echoue → commit bloque, branche nettoyee, `AgentResult.error` contient le message d'erreur typecheck |
| R2 | Avant tout `git commit` dans `executeTask`, les tests unitaires (`bun test tests/unit`) DOIVENT passer. Si les tests echouent, le commit est bloque avec `success: false`. | Exploration S1, convention dev.agent.yaml ("Run full test suite after each task"), CLAUDE.md conventions | Un agent supprime une fonction utilisee par un test → tests echouent → commit bloque |
| R3 | Toute operation Supabase dans le codebase DOIT destructurer `{ data, error }` et verifier `error` avant d'utiliser `data`. Si `error` est non-null, loguer avec `log.error` et gerer proprement (fallback ou propagation). | CLAUDE.md conventions ("always destructure { error }"), exploration S2, pattern existant src/agent-context.ts L281 | `getSprintDelta` reçoit une erreur RLS → loguee via `log.error`, retourne un snapshot vide avec `changed: false` |
| R4 | Les instructions d'execution du dev agent (`getDevInstructions("exec")` dans `bmad-prompts.ts`) DOIVENT inclure l'obligation de mettre a jour CLAUDE.md (compteur de tests, table des modules) quand des tests ou modules sont ajoutes/supprimes. | Exploration S3, mesure d'ecart (2967 tests reels vs 3212 documentes) | Un agent ajoute 15 tests → doit mettre a jour "N tests" dans CLAUDE.md |
| R5 | Les instructions d'execution du dev agent DOIVENT inclure l'obligation d'executer `bun build --no-bundle --target=bun` et `bun test tests/unit` avant de considerer le travail termine. | Exploration S3, dev.agent.yaml critical_actions | Un agent termine son code → verifie typecheck + tests → confirme completion |
| R6 | Le module `doc-utils.ts` DOIT resider dans `src/` et etre importe par chemin relatif `./doc-utils.ts` depuis les modules `src/`. Le fichier `scripts/doc-utils.ts` est remplace par un re-export depuis `src/doc-utils.ts` pour ne pas casser `scripts/doc-freshness.ts`. | Exploration S4, convention projet (pas d'import cross-frontieres src/ → scripts/) | `src/heartbeat.ts` importe `"./doc-utils.ts"` au lieu de `"../scripts/doc-utils.ts"` |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| Git working tree | Fichiers modifies | `git diff --name-only HEAD` | Liste des fichiers .ts modifies par l'agent |
| Bun build | Resultat typecheck | `spawnSync(["bun", "build", "--no-bundle", "--target=bun", ...files])` | exitCode, stderr |
| Bun test | Resultat tests unitaires | `spawnSync(["bun", "test", "tests/unit"])` | exitCode, stderr |
| Supabase | Tables tasks, sprint | Client Supabase | `{ data, error }` destructure |
| CLAUDE.md | Documentation projet | Lecture fichier | Compteur tests, table modules |

## 4. Donnees de sortie

### 4.1 Validation pre-commit (R1, R2)

Fonction `runPreCommitValidation()` dans `src/agent.ts` :
- **Entree** : `projectDir: string`
- **Sortie** : `{ passed: boolean; errors: string[] }`
- Si `passed === false`, le `git commit` dans `executeTask` est saute, la branche nettoyee, et `AgentResult` retourne avec `success: false` et `error` contenant le detail des erreurs.

Structure de retour en cas d'echec :
```
AgentResult {
  success: false,
  output: stdout de l'agent,
  error: "Pre-commit validation failed:\n- TypeCheck: <message d'erreur>\n- Tests: <N tests echoues>",
  durationMs: elapsed
}
```

### 4.2 Correction Supabase heartbeat.ts (R3)

Les deux fonctions `getSprintDelta` et `getStaleTasks` logguent l'erreur et retournent un resultat par defaut propre :
- `getSprintDelta` : `log.error("Supabase error in getSprintDelta", { error })` → retourne snapshot inchange avec `changed: false`
- `getStaleTasks` : `log.error("Supabase error in getStaleTasks", { error })` → retourne `{ tasks: "", hasStale: false }`

### 4.3 Instructions agent enrichies (R4, R5)

Ajout de 3 lignes dans le retour de `getDevInstructions("exec")` dans `src/bmad-prompts.ts` :
```
- Apres ajout/suppression de tests ou modules, mettre a jour CLAUDE.md (compteur tests, table modules)
- Avant de terminer, executer bun build --no-bundle --target=bun pour verifier les types
- Avant de terminer, executer bun test tests/unit pour verifier les tests unitaires
```

### 4.4 Deplacement doc-utils.ts (R6)

- `src/doc-utils.ts` : fichier principal (contenu actuel de `scripts/doc-utils.ts`)
- `scripts/doc-utils.ts` : re-export `export * from "../src/doc-utils.ts"` pour backward compat CI

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/agent.ts` | Modifier | Ajouter validation pre-commit (typecheck + tests unitaires) dans `executeTask` avant `git add -A` / `git commit` (R1, R2) |
| `src/heartbeat.ts` | Modifier | Corriger destructuration `{ data, error }` dans `getSprintDelta` (L126) et `getStaleTasks` (L197), remplacer import `"../scripts/doc-utils.ts"` par `"./doc-utils.ts"` (R3, R6) |
| `src/bmad-prompts.ts` | Modifier | Enrichir `getDevInstructions("exec")` avec obligations CLAUDE.md, typecheck, tests (R4, R5) |
| `src/doc-utils.ts` | Creer | Deplacer le contenu de `scripts/doc-utils.ts` ici (R6) |
| `scripts/doc-utils.ts` | Modifier | Remplacer le contenu par un re-export `export * from "../src/doc-utils.ts"` (R6) |
| `tests/unit/doc-utils.test.ts` | Modifier | Mettre a jour le chemin d'import de `"../../scripts/doc-utils.ts"` vers `"../../src/doc-utils.ts"` (R6) |
| `tests/unit/doc-freshness.test.ts` | Modifier | Mettre a jour le chemin d'import de `"../../scripts/doc-utils.ts"` vers `"../../src/doc-utils.ts"` (R6) |
| `tests/unit/agent-precommit.test.ts` | Creer | Tests unitaires pour la validation pre-commit `runPreCommitValidation` (V1, V2) |
| `tests/unit/heartbeat.test.ts` | Modifier | Ajouter tests pour le comportement `{ data, error }` de `getSprintDelta` et `getStaleTasks` (V3) |

## 6. Patterns existants

### 6.1 Pattern Supabase `{ data, error }` (template pour R3)

Fichier `src/agent-context.ts`, ligne 281 :
```typescript
const { data, error } = await supabase.rpc("get_sprint_summary", { p_sprint: sprint });
if (error || !data) return "";
```
Ce pattern est la reference du projet. Il est present dans la quasi-totalite des modules (`tasks.ts`, `memory.ts`, `prd.ts`, etc.). Les deux occurrences dans `heartbeat.ts` (lignes 126 et 197) ne destructurent que `{ data }` — elles sont les seules exceptions.

### 6.2 Pattern `spawnSync` pour commandes CLI (template pour R1, R2)

Fichier `src/agent.ts`, fonction `git()` ligne 249-256 :
```typescript
function git(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(["git", ...args], { cwd: PROJECT_DIR });
  return {
    ok: result.exitCode === 0,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}
```
La validation pre-commit reutilise exactement ce pattern pour `bun build` et `bun test`.

### 6.3 Pattern d'instructions agent (template pour R4, R5)

Fichier `src/bmad-prompts.ts`, fonction `getDevInstructions`, lignes 261-288 :
```typescript
function getDevInstructions(command: string): string {
  if (command === "exec") {
    return [
      "INSTRUCTIONS EXECUTION:",
      "- Analyse le codebase existant avant toute modification",
      // ... 8 points existants
      "Commence maintenant.",
    ].join("\n");
  }
```
Les nouvelles instructions s'ajoutent dans ce tableau avant "Commence maintenant.".

### 6.4 Pattern lefthook.yml (existant sous-utilise)

Fichier `lefthook.yml` :
```yaml
pre-commit:
  commands:
    biome-check:
      glob: "*.{ts,tsx,js,jsx,json}"
      run: bunx biome check --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
```
Le hook ne couvre que Biome. Le typecheck et les tests ne sont pas ajoutés dans lefthook car le besoin est specifiquement dans le pipeline agent (`executeTask`), pas dans les commits humains (le CI couvre ces cas). L'ajout dans lefthook est hors scope.

### 6.5 Pattern `createLogger` (pour R3)

Fichier `src/heartbeat.ts` n'utilise pas encore `createLogger` — il utilise `console.log`/`console.error` directement. La correction R3 utilise `createLogger("heartbeat")` conformement a la convention du projet (voir migration logger recente, commit 2369f6a).

## 7. Contraintes

- **Ne pas casser le CI existant** : `scripts/doc-freshness.ts` est execute en CI (`bun run scripts/doc-freshness.ts`). Le re-export dans `scripts/doc-utils.ts` garantit que cet import relatif `"./doc-utils.ts"` continue de fonctionner.
- **Performance** : la validation pre-commit doit rester rapide (<15s). Mesure reelle (2026-03-22) : `bun test tests/unit --bail` = ~7.6s. Le typecheck `bun build --no-bundle --target=bun` prend ~5s. Total acceptable : ~13s.
- **Ne pas executer `bun test` complet** : la suite complete (3000+ tests) prend trop longtemps (~2-3 min) pour un pipeline agent. Cibler uniquement `tests/unit` avec `--bail` (fail-fast au premier echec).
- **Pas de modification des interfaces publiques** : `SpawnClaudeOptions`, `SpawnClaudeResult`, `AgentResult` restent inchanges. La validation pre-commit est interne a `executeTask`.
- **Backward compat lefthook** : ne pas modifier `lefthook.yml` — le scope est le pipeline agent, pas les commits humains.
- **Migration logger complete de heartbeat.ts** : `heartbeat.ts` doit etre entierement migre vers `createLogger("heartbeat")` (remplacer tous les `console.log/error/warn`). Un test existant (`logger-migration.test.ts`) attend deja cette migration. Cela adresse le finding F-SS-4 (coherence du pattern de logging dans le fichier).
- **Defense en profondeur (R1-R2 + R4-R5)** : la redondance entre le gate hard (`runPreCommitValidation` dans `executeTask`) et les instructions soft (R4-R5 dans les prompts agent) est intentionnelle. Le gate hard couvre le chemin `executeTask`. Les instructions soft couvrent les chemins hors `executeTask` (orchestrateur via `spawnClaude` direct). Les deux mecanismes coexistent par design — un commentaire dans le code le documente.
- **Fail-fast dans runPreCommitValidation** : le typecheck s'execute en premier. Si le typecheck echoue, les tests sont ignores (economie de ~8s). L'ordre est : typecheck → tests → resultat agrege.
- **Troncation des erreurs pre-commit** : les messages d'erreur dans `AgentResult.error` sont tronques a ~2000 caracteres pour eviter les messages Telegram illisibles (finding F-EC-4).

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `runPreCommitValidation` retourne `{ passed: false }` quand `bun build --no-bundle --target=bun` echoue sur un fichier TypeScript invalide | Test unitaire : mock `spawnSync` pour simuler exitCode=1 et verifier le retour | unit |
| V2 | `runPreCommitValidation` retourne `{ passed: false }` quand `bun test tests/unit` echoue | Test unitaire : mock `spawnSync` pour simuler exitCode=1 et verifier le retour | unit |
| V3 | `runPreCommitValidation` retourne `{ passed: true }` quand typecheck et tests passent | Test unitaire : mock `spawnSync` pour simuler exitCode=0 et verifier le retour | unit |
| V4 | `executeTask` ne fait PAS `git commit` quand `runPreCommitValidation` retourne `passed: false` | Test unitaire : verifier que la sequence `git add` → validation → retour `success: false` est respectee sans appel a `git commit` | unit |
| V5 | `getSprintDelta` dans heartbeat.ts destructure `{ data, error }` et loggue l'erreur quand `error` n'est pas null | Test unitaire : mock Supabase retournant `{ data: null, error: { message: "RLS" } }`, verifier que `log.error` est appele et que le retour est `{ changed: false }` | unit |
| V6 | `getStaleTasks` dans heartbeat.ts destructure `{ data, error }` et loggue l'erreur quand `error` n'est pas null | Test unitaire : mock Supabase retournant `{ data: null, error: { message: "timeout" } }`, verifier que `log.error` est appele et que le retour est `{ tasks: "", hasStale: false }` | unit |
| V7 | `getDevInstructions("exec")` retourne un texte contenant "CLAUDE.md" et "bun build" et "bun test" | Test unitaire : appeler `getDevInstructions("exec")` et verifier les 3 sous-chaines presentes | unit |
| V8 | `src/heartbeat.ts` importe depuis `"./doc-utils.ts"` et non depuis `"../scripts/doc-utils.ts"` | Test unitaire : lire le contenu de heartbeat.ts et verifier l'absence de `../scripts/doc-utils` | unit |
| V9 | `scripts/doc-utils.ts` re-exporte tout depuis `"../src/doc-utils.ts"` | Test unitaire : verifier que `scripts/doc-utils.ts` contient `export * from` et que les exports sont identiques a `src/doc-utils.ts` | unit |
| V10 | `bun test tests/unit` passe sans regression apres toutes les modifications | Execution de la suite de tests unitaires complete | integration |
| V11 | `bun build --no-bundle --target=bun src/*.ts` passe sans erreur de type | Execution typecheck sur le projet complet | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | 4 causes racines identifiees et confirmees par exploration codebase. Ecart mesure (2967 vs 3212 tests). Defauts Supabase localises (heartbeat.ts L126, L197). |
| Perimetre | Couvert | IN scope : 4 corrections ciblees (agent.ts, heartbeat.ts, bmad-prompts.ts, doc-utils.ts). OUT scope : migration complete console.log → logger dans heartbeat.ts, ajout typecheck dans lefthook.yml, refactorisation complete du pipeline agent. |
| Validation | Couvert | 11 V-criteres avec niveaux (9 unit, 2 integration). Aucun critere E2E ou manual necessaire — tous les comportements sont testables par mock. |
| Technique | Couvert | Patterns existants identifies (Supabase { data, error }, spawnSync, getDevInstructions). Impact sur 9 fichiers (4 modifies, 2 crees, 3 tests modifies/crees). Aucune nouvelle dependance. |
| UX | Non applicable | Pas d'interaction utilisateur directe — corrections internes au pipeline d'agents. |
| Alternatives | Couvert | Option A (status quo) rejetee — degradation continue. Option B (corrections ciblees) retenue — chirurgicale, reversible, faible risque. Option C (refactorisation complete) evaluee et ecartee — complexite disproportionnee pour la valeur marginale. Voir exploration section 4. |

**Zones d'ombre residuelles :**

1. **Timeout de la validation pre-commit** : si `bun test tests/unit` prend plus de 30s (ex: suite qui grossit), faut-il un timeout configurable ? Decision : fixer un timeout hard de 60s dans `spawnSync`. Si depasse, la validation echoue avec message "tests timeout". A revisiter si la suite unitaire depasse 500 tests. Mesure actuelle : 7.6s (2567 tests, 2026-03-22).
2. **Fichiers cibles pour le typecheck** : le typecheck `bun build --no-bundle --target=bun` doit-il cibler tous les fichiers `src/*.ts` ou uniquement les fichiers modifies par l'agent (`git diff --name-only`) ? Decision : cibler `src/` complet pour detecter les effets de bord sur les imports. Le cout (~5s) est acceptable.
3. **Logger dans heartbeat.ts** : resolu — la migration complete de heartbeat.ts vers createLogger est incluse dans cette spec (tests existants l'attendent deja).
4. **Race condition agents concurrents (F-EC-2)** : preexistante, hors scope. Le semaphore limite a 3 concurrents. A traiter dans une spec dediee si necessaire.
5. **Couverture orchestrateur (F-DA-1)** : la validation pre-commit ne couvre que `executeTask`. Les agents spawnes via l'orchestrateur dependent des instructions soft (R4-R5). C'est une limitation acceptee — le CI reste le filet de securite final pour ces chemins.
