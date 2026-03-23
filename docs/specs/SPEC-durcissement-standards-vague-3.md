# Spec : Durcissement standards de développement — Vague 3

> Généré le 2026-03-23. Source : docs/explorations/EXPLORE-il-faut-ameliorer-les-standards-de.md (section 5 — vague 3), analyse codebase (grep catch, inventaire Zod, coverage bun test --coverage), contraintes vagues 1+2 fournies.

## 1. Objectif

Durcir le traitement des erreurs et la robustesse des inputs dans `src/` via quatre actions : (1) créer un `Result<T, E>` custom dans `src/result.ts` pour rendre les chemins d'erreur explicites dans le code applicatif, (2) auditer et corriger les 111 blocs `catch {}` silencieux (sans `log.` ni `throw`) en appliquant une stratégie uniforme par catégorie, (3) ajouter des schémas Zod pour valider les inputs des commandes Telegram critiques (`/task`, `/exec`, `/orchestrate`, `/prd`), et (4) intégrer la couverture de code dans la CI avec un seuil minimal via `bun test --coverage`. Cela consolide les acquis des vagues 1 (tsconfig strict, config.ts, biome) et 2 (zero `any`, 3516 tests) et élimine la principale source de bugs silencieux au runtime.

---

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Créer `src/result.ts` avec un type `Result<T, E>` custom et les constructeurs `ok(value)` / `err(error)`. **Décision : custom plutôt que neverthrow** car le codebase utilise déjà massivement le pattern Supabase `{ data, error }` et n'a pas besoin de la composition monadique (map/flatMap) qu'apporte neverthrow. Un type algebraic discriminant suffit | Exploration section 5, analyse codebase — absence de chaining fonctionnel | `const r = ok(42); if (r.ok) r.value // 42` |
| R2 | `Result<T, E>` est un type discriminant : `{ ok: true; value: T } \| { ok: false; error: E }`. Les constructeurs `ok<T>(value: T): Result<T, never>` et `err<E>(error: E): Result<never, E>` sont purement fonctionnels (pas d'effet de bord) | Source : analyse des besoins — pas de chaining requis, juste le type discriminant | `type Result<T, E = Error> = { ok: true; value: T } \| { ok: false; error: E }` |
| R3 | `Result` est adopté uniquement dans les nouvelles fonctions créées dans cette vague (validateurs Zod, helpers d'audit) — **pas de migration massive du code existant**. Le code existant conserve ses patterns `{ data, error }` Supabase et ses try/catch. La migration incrémentale est laissée à la vague 4 | Contrainte de périmètre — maintenir 3516 tests, éviter la régression | Les validators Zod de la section commandes retournent `Result<ParsedArgs, ZodError>` |
| R4 | Audit des 111 `catch {}` silencieux (blocs `catch {` sans `log.` ni `throw` dans le corps immédiat) : appliquer la stratégie selon la catégorie du bloc | Grep codebase : 111 occurrences de `catch {` sans log/throw — voir R5-R9 | |
| R5 | **Catégorie A — JSON.parse / parse optionnel** (17 blocs) : les catch autour de `JSON.parse`, `parseInt`, `parseFloat` sans log restent silencieux mais **doivent ajouter un commentaire `// R5: parse failure → fallback`** pour documenter l'intention | Analyse : `prd.ts:194`, `adversarial-verifier.ts:133`, `gate-evaluator.ts:621` — parser un output LLM peut légitimement échouer | `} catch { // R5: parse failure → fallback \n  return null; }` |
| R6 | **Catégorie B — Filesystem / state optionnel** (14 blocs) : les catch autour de `readFile`, `writeFile`, `mkdir`, `rename` et du chargement d'état (`loadState`, config getters dans `bot-context.ts`) restent silencieux mais **doivent ajouter un commentaire `// R6: optional IO → degrade gracefully`** | Analyse : `heartbeat.ts:103`, `bot-context.ts:34-87` (config getters — les 14 blocs IIFE) — une erreur IO ne doit pas crasher le bot | `} catch { // R6: optional IO → degrade gracefully \n return ""; }` |
| R7 | **Catégorie C — Edge Functions / services optionnels** (blocs autour de `supabase.functions.invoke`, recherche sémantique, `bumpMemoryAccess`) : restent silencieux avec commentaire `// R7: optional feature → skip`  | Analyse : `memory.ts:611` (classifyMessage), `memory.ts:781` (deduplication), `agent-context.ts` — les Edge Functions peuvent ne pas être déployées | `} catch { // R7: optional feature → skip \n return null; }` |
| R8 | **Catégorie D — Erreurs métier non attendues** (blocs sans justification claire dans les modules critiques : `orchestrator.ts`, `agent.ts`, `relay.ts`, `llm-router.ts`, `agent-schemas.ts`, `commands/`) : **doivent être remplacés par `log.warn` minimum** avec le nom de la fonction et le contexte disponible. Si l'erreur ne peut pas être typée, utiliser `log.warn("${functionName} catch", { context: "..." })` | Analyse : `orchestrator.ts:559`, `relay.ts:61`, `llm-router.ts:90` — les erreurs dans ces modules indiquent des problèmes réels qu'on doit détecter | `} catch { \n  log.warn("buildAgentContext catch", { role, taskId }); \n}` |
| R9 | **Catégorie E — Propagation manquante** (blocs catch dans des fonctions qui retournent une valeur critique et avalent silencieusement l'erreur) : **doivent relancer l'erreur ou retourner `null` + `log.error`**. Identifier en priorité les blocs dans `src/commands/execution.ts:264`, `src/job-manager.ts:128`, `src/workflow.ts:788` | Analyse : blocs catch dans des flux de commandes Telegram — une erreur silencieuse dans `/exec` est un bug | `} catch (error) { \n  log.error("execTask catch", { error: String(error) }); \n  return null; \n}` |
| R10 | Ajouter un schéma Zod `TaskCommandSchema` dans `src/commands/tasks.ts` pour valider l'input de `/task` : titre non vide (string min 1), options `--desc`, `--priority` (1-5), `--hours` (nombre positif) extraites par regex depuis `ctx.match` avant l'appel à `addTask` | Analyse : `tasks.ts:36` — `input = ctx.match?.trim()` passé directement à `addTask` sans validation | `/task Fix bug --priority 2 --hours 3` → `{ title: "Fix bug", priority: 2, estimatedHours: 3 }` |
| R11 | Ajouter un schéma Zod `ExecCommandSchema` dans `src/commands/execution.ts` pour valider l'input de `/exec` : `idPrefix` non vide, format alphanumérique 4-8 chars | Analyse : `execution.ts:82` — `idPrefix` passé directement au `.filter()` Supabase sans validation du format | `/exec abc123` → `{ idPrefix: "abc123" }` ; `/exec ""` → erreur "ID requis" |
| R12 | Ajouter un schéma Zod `OrchestrateCommandSchema` dans `src/commands/execution.ts` pour valider l'input de `/orchestrate` : `idPrefix` alphanumérique, `pipeline` optionnel parmi les valeurs connues en MINUSCULES (`full`, `quick`, `review` — adversarial F-DA-1 : le handler utilise des minuscules, pas des majuscules), flags booléens `useBlackboard`, `skipChallenge`, `useResume`, `resumeSessionId` optionnel | Analyse : `execution.ts:293-310` — parsing manuel ad hoc | `/orchestrate abc123 quick --blackboard` → `{ idPrefix: "abc123", pipeline: "quick", useBlackboard: true }` |
| R13 | Ajouter un schéma Zod `PrdCommandSchema` dans `src/commands/planning.ts` pour valider les CHAMPS EXTRAITS par le parsing regex existant (pas un discriminatedUnion sur la string brute — adversarial F-DA-2). Le schema valide : `action` parmi `list/view/create/approve/reject`, `id` optionnel (regex hex 4-8 chars), `description` optionnel (string non vide). Le parsing regex existant extrait d'abord l'action, puis le schema Zod valide les champs extraits | Analyse : planning.ts:207-239 | `PrdCommandSchema.safeParse({ action: "view", id: "abc12345" })` → `success: true` |
| R14 | Les schémas Zod des commandes ne sont utilisés que pour la validation — en cas d'échec Zod, afficher un message d'erreur clair en français à l'utilisateur (via `ctx.reply`) et `return`. **Pas de remontée d'exception au niveau Grammy** | Convention bot : erreurs utilisateur = message informatif, pas de crash | `if (!parsed.success) { await ctx.reply("Usage: /task <titre>"); return; }` |
| R15 | Fusionner les steps CI `Verify test count` + `Coverage check` en un seul step qui execute `bun test --coverage` une seule fois (adversarial F-EC-1 : eviter 4 runs de test dans le meme job). **Seuil minimal : 60% de ligne coverage global** | Analyse : baseline 69.13%. Bun 1.3.9 supporte `--coverage` mais pas `--coverage-threshold` natif | CI step unique : run tests + extract count + extract coverage |
| R16 | Le parsing de la couverture utilise `grep -i "all files"` (case-insensitive — adversarial F-EC-2) avec degradation graceful : si le format change ou le grep echoue, afficher un warning mais ne pas bloquer la CI. Le seuil reste enforced via script shell | Analyse : format `bun test --coverage` peut varier entre versions Bun | `LINES=$(... \| grep -i "all files" \| awk '{ print $3 }') \|\| LINES=""` |
| R17 | Maintenir le seuil de régression existant de 3441 tests dans `.github/workflows/ci.yml`. Les nouveaux tests unitaires pour `src/result.ts` et les validators Zod s'ajoutent au dessus, faisant passer le seuil à **3516+N** (N = nombre de nouveaux tests, estimé 20-30) | Contrainte fournie : "Maintenir la non-regression : 3516 tests doivent passer" + seuil CI actuel 3441 | Mise à jour `.github/workflows/ci.yml` : `if [ "$PASS_COUNT" -lt 3516 ]` |
| R18 | Scope : `src/` uniquement. `tests/`, `scripts/`, `mcp/`, `dashboard/` ne sont pas modifiés sauf `.github/workflows/ci.yml` pour la couverture | Contrainte de périmètre fournie | |

---

## 3. Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| `src/*.ts` (111 blocs `catch {}` silencieux) | Fichiers TypeScript source | Read / Edit directs | Blocs `catch {` sans `log.` ni `throw` dans 34 fichiers |
| `src/commands/tasks.ts` | Composer GrammY | Read / Edit | `ctx.match?.trim()` ligne 36, appel `addTask` |
| `src/commands/execution.ts` | Composer GrammY | Read / Edit | `ctx.match?.trim()` lignes 82, 293, 507, parsing `--blackboard`, `--resume`, `--skip-challenge` |
| `src/commands/planning.ts` | Composer GrammY | Read / Edit | `ctx.match?.trim()` lignes 207-239, regex sur input |
| `src/logger.ts` | Logger structuré | Import read-only | `createLogger(module)` → `log.warn(msg, meta)`, `log.error(msg, meta)` |
| `src/config.ts` | Pattern Zod existant | Read (référence) | Pattern `z.object({...}).safeParse()` à réutiliser pour les schémas de commandes |
| `.github/workflows/ci.yml` | Config CI | Read / Edit | Step `Verify test count`, ajout step `Coverage check` |
| `package.json` | Dépendances | Read | `zod: "^3.25.76"` déjà en `dependencies` (pas de nouvelle dépendance nécessaire) |

---

## 4. Données de sortie

### 4.1 `src/result.ts` — Result type custom

Nouveau fichier exposant le type discriminant et ses constructeurs :

```typescript
// src/result.ts — Result<T, E> custom type
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Type guard helpers
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok === true;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return result.ok === false;
}
```

Ce fichier est utilisé initialement par les validators Zod des commandes (section 4.3).

### 4.2 `src/*.ts` — Catch blocks audités

Pour chaque bloc `catch {}` sans `log.` ni `throw`, l'une de ces transformations est appliquée selon la catégorie :

**Catégorie A (JSON/parse) — commentaire intentionnel :**
```typescript
} catch {
  // R5: parse failure → fallback
  return null;
}
```

**Catégorie B (IO/config) — commentaire intentionnel :**
```typescript
} catch {
  // R6: optional IO → degrade gracefully
  return defaultValue;
}
```

**Catégorie C (Edge Functions) — commentaire intentionnel :**
```typescript
} catch {
  // R7: optional feature → skip
  return null;
}
```

**Catégorie D (erreurs métier) — log.warn minimum :**
```typescript
} catch {
  log.warn("nomDeLaFonction catch", { context: "..." });
}
```

**Catégorie E (propagation manquante) — log.error + return null :**
```typescript
} catch (error) {
  log.error("nomDeLaFonction catch", { error: String(error) });
  return null;
}
```

### 4.3 Validators Zod des commandes

**`src/commands/tasks.ts`** — `TaskCommandSchema` :

```typescript
// Parse /task <titre> [--desc <description>] [--priority <1-5>] [--hours <n>]
const TaskCommandSchema = z.object({
  title: z.string().min(1, "Le titre est requis"),
  desc: z.string().optional(),
  priority: z.coerce.number().int().min(1).max(5).optional(),
  hours: z.coerce.number().positive().optional(),
});
```

Retourne `Result<TaskCommandArgs, ZodError>` via `ok(parsed.data)` / `err(parsed.error)`.

**`src/commands/execution.ts`** — `ExecCommandSchema` et `OrchestrateCommandSchema` :

```typescript
// /exec <idPrefix>
const ExecCommandSchema = z.object({
  idPrefix: z.string().min(4, "ID trop court").max(36).regex(/^[a-f0-9-]+$/, "Format ID invalide"),
});

// /orchestrate <idPrefix> [pipeline] [--blackboard] [--resume [sessionId]] [--skip-challenge]
const VALID_PIPELINES = ["DEFAULT", "LIGHT", "QUICK", "SOLO", "REVIEW", "RESEARCH", "full"] as const;
const OrchestrateCommandSchema = z.object({
  idPrefix: z.string().min(4).max(36).regex(/^[a-f0-9-]+$/),
  pipeline: z.enum(VALID_PIPELINES).optional(),
  useBlackboard: z.boolean(),
  skipChallenge: z.boolean(),
  useResume: z.boolean(),
  resumeSessionId: z.string().optional(),
});
```

**`src/commands/planning.ts`** — `PrdCommandSchema` :

```typescript
// /prd [list|<hexId>|<description>]
const PrdCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("view"), id: z.string().regex(/^[a-f0-9]{4,8}$/) }),
  z.object({ action: z.literal("create"), description: z.string().min(1) }),
]);
```

### 4.4 `.github/workflows/ci.yml` — Step couverture

Nouveau step `Coverage check` après les tests :

```yaml
- name: Coverage check
  run: |
    COVERAGE_OUTPUT=$(bun test --coverage --coverage-reporter=text tests/unit tests/integration 2>&1)
    echo "$COVERAGE_OUTPUT" | tail -5
    LINES=$(echo "$COVERAGE_OUTPUT" | grep "All files" | awk '{ print $3 }')
    echo "Line coverage: ${LINES}%"
    if [ -z "$LINES" ]; then
      echo "ERROR: Could not parse coverage output"
      exit 1
    fi
    if (( $(echo "$LINES < 60" | bc -l) )); then
      echo "ERROR: Coverage ${LINES}% below threshold 60%"
      exit 1
    fi
    echo "Coverage OK: ${LINES}% >= 60%"
```

---

## 5. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/result.ts` | Créer | Nouveau type `Result<T, E>` custom avec constructeurs `ok`/`err` et type-guards |
| `src/commands/tasks.ts` | Modifier | Ajouter `TaskCommandSchema` Zod, parser l'input de `/task` avant `addTask` |
| `src/commands/execution.ts` | Modifier | Ajouter `ExecCommandSchema` et `OrchestrateCommandSchema` Zod, valider idPrefix et flags |
| `src/commands/planning.ts` | Modifier | Ajouter `PrdCommandSchema` Zod, valider l'input de `/prd` |
| `src/bot-context.ts` | Modifier | 14 blocs `catch {}` catégorie B/D : ajouter commentaires R6 ou `log.warn` selon la catégorie |
| `src/memory.ts` | Modifier | 9 blocs `catch {}` catégories A/C : ajouter commentaires R5/R7 (JSON parse, Edge Functions) |
| `src/orchestrator.ts` | Modifier | 8 blocs `catch {}` catégorie D/E : ajouter `log.warn` minimum |
| `src/heartbeat.ts` | Modifier | 7 blocs `catch {}` catégorie B/D : ajouter commentaires R6 ou `log.warn` |
| `src/relay.ts` | Modifier | 6 blocs `catch {}` catégorie D/E : ajouter `log.warn` minimum |
| `src/llm-router.ts` | Modifier | 6 blocs `catch {}` catégorie D : ajouter `log.warn` minimum |
| `src/agent-schemas.ts` | Modifier | 6 blocs `catch {}` catégorie A (JSON parse LLM output) : commentaires R5 |
| `src/agent-context.ts` | Modifier | 9 blocs `catch {}` catégories B/D : commentaires R6 ou `log.warn` |
| `src/adversarial-challenge.ts` | Modifier | 5 blocs `catch {}` catégorie A/D : commentaires R5 ou `log.warn` |
| `src/commands/help.ts` | Modifier | 4 blocs `catch {}` catégorie D : ajouter `log.warn` |
| `src/autonomy-scanner.ts` | Modifier | 3 blocs `catch {}` catégorie B : commentaires R6 |
| `src/agent-events.ts` | Modifier | 3 blocs `catch {}` catégorie C/D : commentaires R7 ou `log.warn` |
| `src/code-graph.ts` | Modifier | 3 blocs `catch {}` catégorie B : commentaires R6 |
| `src/adversarial-verifier.ts` | Modifier | 2 blocs `catch {}` catégorie A : commentaires R5 |
| `src/gate-evaluator.ts` | Modifier | 2 blocs `catch {}` catégorie A : commentaires R5 |
| `src/exploration-scoring.ts` | Modifier | 2 blocs `catch {}` catégorie D : `log.warn` |
| `src/spec-lite.ts` | Modifier | 2 blocs `catch {}` catégorie A/D : commentaire R5 ou `log.warn` |
| `src/cost-tracking.ts` | Modifier | 2 blocs `catch {}` catégorie B/D : commentaire R6 ou `log.warn` |
| `src/notification-queue.ts` | Modifier | 2 blocs `catch {}` catégorie D : `log.warn` |
| `src/doc-utils.ts` | Modifier | 2 blocs `catch {}` catégorie B : commentaires R6 |
| `src/notification-prefs.ts` | Modifier | 1 bloc `catch {}` catégorie B : commentaire R6 |
| `src/prd.ts` | Modifier | 1 bloc `catch {}` catégorie A : commentaire R5 |
| `src/commands/exploration.ts` | Modifier | 1 bloc `catch {}` manquant dans l'inventaire initial (adversarial) |
| `src/conversation-session.ts` | Modifier | 1 bloc `catch {}` catégorie B : commentaire R6 |
| `src/commands/jobs.ts` | Modifier | 1 bloc `catch {}` catégorie D : `log.warn` |
| `src/commands/execution.ts` | Modifier (aussi) | 1 bloc `catch {}` catégorie E : `log.error` + return |
| `src/workflow.ts` | Modifier | 1 bloc `catch {}` catégorie D : `log.warn` |
| `src/llm-ops.ts` | Modifier | 1 bloc `catch {}` catégorie D : `log.warn` |
| `src/prd-workflow.ts` | Modifier | 1 bloc `catch {}` catégorie B : commentaire R6 |
| `src/agent.ts` | Modifier | 1 bloc `catch {}` catégorie D/E : `log.warn` |
| `src/feature-flags.ts` | Modifier | 1 bloc `catch {}` catégorie B : commentaire R6 |
| `src/job-manager.ts` | Modifier | 1 bloc `catch {}` catégorie E : `log.error` + return |
| `src/cost-estimate.ts` | Modifier | 1 bloc `catch {}` catégorie D : `log.warn` |
| `.github/workflows/ci.yml` | Modifier | Ajouter step `Coverage check` (60% seuil) + mettre à jour seuil tests à 3516 |
| `tests/unit/result.test.ts` | Créer | Tests unitaires pour `src/result.ts` : constructeurs, type-guards, discriminant |
| `tests/unit/command-validators.test.ts` | Créer | Tests unitaires pour les schémas Zod des 4 commandes critiques |

---

## 6. Patterns existants

### 6.1 Pattern Zod dans `src/config.ts` (à réutiliser)

Référence : `/home/edouard/claude-telegram-relay/src/config.ts` lignes 19-34.

```typescript
// Pattern exact à réutiliser pour les validators de commandes
const RequiredEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  // ...
});
const result = RequiredEnvSchema.safeParse(process.env);
if (!result.success) {
  // handle error
}
```

Les validators de commandes utilisent le même pattern `z.object({}).safeParse(parsedInput)` → `if (!parsed.success) { await ctx.reply("Usage: ..."); return; }`.

### 6.2 Pattern `createLogger` dans les modules existants

Référence : présent dans 50+ modules source, pattern standard :

```typescript
import { createLogger } from "./logger.ts";
const log = createLogger("module-name");
// Usage : log.warn("functionName catch", { error: String(error), context: "..." });
```

Tous les modules cibles de l'audit catch ont déjà `createLogger` importé. La correction D/E n'ajoute pas d'import, juste `log.warn` ou `log.error`.

### 6.3 Pattern catch actuel dans `src/heartbeat.ts` (catégorie B)

Référence : `/home/edouard/claude-telegram-relay/src/heartbeat.ts` lignes 103-106.

```typescript
export async function loadState(): Promise<HeartbeatState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return createDefaultState();  // catégorie B — IO optional, correct, ajouter commentaire
  }
}
```

Ce pattern est correct (fallback sur état par défaut) — la correction se limite à un commentaire `// R6: optional IO → degrade gracefully`.

### 6.4 Pattern catch catégorie A dans `src/memory.ts`

Référence : `/home/edouard/claude-telegram-relay/src/memory.ts` lignes 607-612.

```typescript
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
```

Ce bloc a déjà un commentaire — il est conforme à la catégorie C (Edge Functions optionnelles). Les blocs sans commentaire similaires dans `memory.ts` lignes 426, 451 suivent le même pattern et doivent recevoir le commentaire catégorie C `// R7: optional feature → skip`.

### 6.5 Pattern `ctx.match` existant dans `src/commands/tasks.ts`

Référence : `/home/edouard/claude-telegram-relay/src/commands/tasks.ts` lignes 34-55.

```typescript
const input = ctx.match?.trim();
if (!input) {
  await ctx.reply("Usage: /task titre de la tache", bctx.threadOpts(ctx));
  return;
}
// → input passé directement à addTask(bctx.supabase, input, {...})
```

Le validator Zod s'insère entre la vérification `!input` et l'appel `addTask` :

```typescript
const input = ctx.match?.trim();
if (!input) { await ctx.reply("Usage: /task <titre>", bctx.threadOpts(ctx)); return; }
const parsed = parseTaskCommand(input);  // helper utilisant TaskCommandSchema
if (!parsed.ok) { await ctx.reply(`Erreur: ${parsed.error.issues[0].message}`, bctx.threadOpts(ctx)); return; }
const task = await addTask(bctx.supabase, parsed.value.title, { ... });
```

---

## 7. Contraintes

- **Non-régression 3516 tests** : tous les tests existants doivent passer après la vague 3. Les corrections catch (commentaires, log.warn) et les validators Zod (path heureux inchangé) ne cassent aucun comportement existant
- **Pas de migration massive vers Result** : `Result<T, E>` est adopté uniquement dans le nouveau code (validators, helpers). Les modules existants gardent leurs patterns
- **Pas de modification tests/** : seuls `tests/unit/result.test.ts` et `tests/unit/command-validators.test.ts` sont créés. Les tests existants ne sont pas modifiés
- **Seuil couverture conservatif (60%)** : la baseline actuelle est 69.13% (unit only) et 69.16% (unit+integration). Le seuil 60% donne une marge de 9 points pour absorber les nouveaux fichiers (result.ts, commandes avec validators). Si le coverage baisse en dessous de 65% après les changements, le seuil doit être ajusté avant merge
- **Bun 1.3.9 — pas de `--coverage-threshold` natif** : le seuil est enforced par script shell parsant la sortie texte de `bun test --coverage`. Si la version de Bun est upgradée (1.2+ supporte `coverageThreshold` dans `bunfig.toml`), migrer vers la config native
- **Zod déjà en `dependencies`** : `zod: "^3.25.76"` est dans `package.json`. Pas de nouvelle dépendance
- **`neverthrow` non adopté** : decision documentée (R1) — le codebase ne fait pas de chaining monadique. Adopter neverthrow ajouterait une dépendance externe pour un bénéfice limité à ce stade
- **Scope `src/` uniquement** : `mcp/`, `scripts/`, `dashboard/` ne sont pas concernés par l'audit catch ni les validators
- **Les `.catch()` fire-and-forget** (26 occurrences comme `unlink(f).catch(() => {})`) sont **hors scope** de cette vague — ils sont des patterns intentionnels de cleanup async non-bloquant

---

## 8. Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|-------------|--------|
| V1 | `src/result.ts` exporte `Result<T, E>`, `ok(value)`, `err(error)`, `isOk()`, `isErr()` | `import { ok, err, isOk } from "../../src/result.ts"` — vérifier types discriminants | unit |
| V2 | `ok(42)` retourne `{ ok: true, value: 42 }` et `err(new Error("x"))` retourne `{ ok: false, error: Error }` | Test unitaire : `expect(ok(42)).toEqual({ ok: true, value: 42 })` | unit |
| V3 | Le type `Result<T, E>` est discriminant : TypeScript infère `result.value` uniquement dans la branche `result.ok === true` | Vérification typecheck : `tsc --noEmit` passe sans erreur sur un usage avec narrow | unit |
| V4 | `isOk(ok(1))` retourne `true`, `isErr(err("x"))` retourne `true`, `isOk(err("x"))` retourne `false` | Tests unitaires des type-guards | unit |
| V5 | `TaskCommandSchema.safeParse({ title: "Fix bug", priority: 2 })` retourne `success: true` avec les valeurs parsées | Test unitaire du schéma Zod | unit |
| V6 | `TaskCommandSchema.safeParse({ title: "" })` retourne `success: false` avec message d'erreur sur `title` | Test de validation Zod — titre vide rejeté | unit |
| V7 | `TaskCommandSchema.safeParse({ title: "test", priority: 6 })` retourne `success: false` — priority hors range | Test de validation Zod — priority > 5 rejeté | unit |
| V8 | `ExecCommandSchema.safeParse({ idPrefix: "abc123" })` retourne `success: true` | Test unitaire ExecCommandSchema | unit |
| V9 | `ExecCommandSchema.safeParse({ idPrefix: "ab" })` retourne `success: false` — trop court (< 4 chars) | Test de validation Zod — idPrefix court rejeté | unit |
| V10 | `ExecCommandSchema.safeParse({ idPrefix: "xyz!@#" })` retourne `success: false` — caractères invalides | Test de validation Zod — format non-hexadécimal rejeté | unit |
| V11 | `OrchestrateCommandSchema.safeParse({ idPrefix: "abc123", pipeline: "full" })` retourne `success: true` — pipelines en minuscules, flags avec defaults false | Test unitaire OrchestrateCommandSchema | unit |
| V12 | `OrchestrateCommandSchema.safeParse({ idPrefix: "abc123", pipeline: "INVALID", useBlackboard: false, skipChallenge: false, useResume: false })` retourne `success: false` — pipeline invalide (valeurs valides : `full`, `quick`, `review` en minuscules — adversarial F-DA-1) | Test de validation Zod — pipeline inconnu rejeté | unit |
| V13 | `PrdCommandSchema.safeParse({ action: "list" })` retourne `success: true` (schema valide les champs extraits, pas la string brute — adversarial F-DA-2) | Test unitaire PrdCommandSchema | unit |
| V14 | `PrdCommandSchema.safeParse({ action: "view", id: "abc12345" })` retourne `success: true` | Test de validation Zod — ID hexadecimal | unit |
| V15 | `PrdCommandSchema.safeParse({ action: "invalid_action" })` retourne `success: false` — action inconnue rejetee | Test de validation Zod — action invalide | unit |
| V16 | `/task` avec titre vide répond "Usage: /task <titre>" sans créer de tâche | Test d'intégration mockant ctx.match = "" | integration |
| V17 | `/task Fix bug --priority 7` répond avec message d'erreur Zod "priority must be ≤ 5" sans créer de tâche | Test d'intégration mockant ctx.match | integration |
| V18 | `/task Fix bug` (path heureux) crée la tâche via `addTask` — non-régression | Test d'intégration — vérifier que le comportement existant est préservé | integration |
| V19 | `/exec ""` (idPrefix vide) répond "Usage: /exec <id>" sans requête Supabase | Test d'intégration — guard condition existante inchangée | integration |
| V20 | Aucun des 111 blocs `catch {}` silencieux ne subsiste sans commentaire de catégorie (R5/R6/R7) ou `log.warn`/`log.error` | `grep -rn "catch\s*{" src/ | grep -v "log\.\|// R[5-9]"` → 0 résultat | unit |
| V21 | Les 34 fichiers modifiés dans l'audit catch compilent sans erreur TypeScript (`tsc --noEmit`) | CI : step `Type check` vert | integration |
| V22 | `bun test tests/unit tests/integration tests/system` passe ≥ 3516 tests sans régression | CI : step `Verify test count` → `$PASS_COUNT -ge 3516` | integration |
| V23 | `bun test --coverage tests/unit tests/integration` — ligne `All files` ≥ 60% | CI : step `Coverage check` vert | integration |
| V24 | `tests/unit/result.test.ts` couvre : `ok`, `err`, `isOk`, `isErr`, type discriminant, narrowing | `bun test tests/unit/result.test.ts` → all pass | unit |
| V25 | `tests/unit/command-validators.test.ts` couvre les 4 schémas Zod (TaskCommand, ExecCommand, Orchestrate, Prd) avec cas valides et invalides | `bun test tests/unit/command-validators.test.ts` → all pass | unit |

---

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Problème | Couvert | 111 catch silencieux identifiés par grep, catégorisés en 5 catégories avec stratégie pour chacune. Absence de Result type et de validation Zod documentés. Couverture CI absente vérifiée |
| Périmètre | Couvert | Scope `src/` exclusivement. Nouvelles dépendances : aucune (Zod déjà présente). `neverthrow` explicitement rejeté (R1). Fichiers modifiés et créés listés exhaustivement |
| Validation | Couvert | 25 V-critères avec niveaux. Tests unitaires pour `result.ts` et validators Zod. Tests d'intégration pour les commandes Telegram critiques. V20 vérifiable par grep post-implémentation |
| Technique | Couvert | Bun 1.3.9 coverage (69.13% baseline), seuil 60% conservatif, implémentation via script shell (pas de `--coverage-threshold` natif). Pattern `safeParse` Zod réutilisé depuis `config.ts`. `createLogger` présent dans tous les modules cibles |
| UX | Pertinent | Les messages d'erreur Zod affichés aux utilisateurs Telegram doivent être en français et inclure le bon format (R14). Un message Zod brut anglais serait une régression UX — traduction via `.issues[0].message` overridé dans les schemas |
| Alternatives | Pertinent | `neverthrow` vs custom évalué (R1 — custom retenu). Seuil couverture 60% vs 70% vs 80% évalué (60% retenu car conservatif par rapport à la baseline 69%). Script shell vs `bunfig.toml` coverage threshold évalué (script retenu pour Bun 1.3.9 sans config native) |

**Zones d'ombre résiduelles :**

1. **Catégorisation des 111 blocs** : la distinction entre catégories B (IO graceful) et D (erreur métier non attendue) pour certains blocs dans `agent-context.ts` et `orchestrator.ts` nécessite une lecture ligne par ligne. Si un bloc est ambigu, la règle conservatrice est catégorie D → `log.warn` (mieux sur-logger que sous-logger)

2. **Seuil couverture CI** : 60% est conservatif par rapport à la baseline 69.16%. Si l'ajout des nouveaux fichiers (`result.ts`, command validators) augmente le numérateur sans trop impacter le dénominateur, le seuil pourrait être relevé à 65% après vérification post-implémentation. Cette décision est laissée à l'implémenteur

3. **Compatibilité `PrdCommandSchema` avec le routage existant** : la commande `/prd` a une logique de parsing complexe (regex `hexIdMatch`, test `isPrdMaturationEnabled()`, test `isPrdWorkflowEnabled()`). Le schéma Zod valide l'input brut avant ce routage — il ne remplace pas les branches conditionnelles existantes mais s'insère en amont. L'implémenteur doit veiller à ne pas bloquer les flux `isPrdMaturationEnabled()` qui ont leurs propres validations

4. **Test count après vague 3** : le seuil est mis à jour de 3441 → 3516 (baseline vague 2 confirmée). Les nouveaux tests `result.test.ts` et `command-validators.test.ts` ajoutent ~20-30 tests. Le seuil final dans CI sera 3516 + N tests ajoutés par cette vague (à déterminer à la fin de l'implémentation)
