# Spec : Micro-corrections post-audit Phase 3

> Genere le 2026-03-20. Source : exploration EXPLORE-micro-corrections-post-audit.md, verification codebase directe.

## 1. Objectif

Corriger trois problemes residuels identifies par l'audit post-Phase 2 : (1) un bug de silent failure sur un `.update()` Supabase dans heartbeat.ts, (2) un feature flag mort `explore_mode` dans config/features.json, (3) cinq valeurs perimees dans CLAUDE.md. Ces corrections alignent le code et la documentation sur l'etat reel du codebase apres les Phases 1-2 de la roadmap de refonte.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Toute operation Supabase `.update()` doit destructurer `{ error }` et logger l'erreur avec `console.error` si elle survient | Convention CLAUDE.md section Conventions : "always destructure `{ error }` from Supabase operations and log with `console.error`" | `const { error } = await supabase.from("tasks").update(...)` + `if (error) console.error(...)` |
| R2 | Un feature flag sans aucune reference `isFeatureEnabled()` dans src/ doit etre supprime de config/features.json | Best practices DevCycle (exploration S2 #2), principe : flags morts = dette technique | `explore_mode` : 0 appels `isFeatureEnabled("explore_mode")` dans src/ |
| R3 | Les counts dans CLAUDE.md (tests, modules, composers) doivent refleter l'etat reel du codebase | Verification directe : `ls src/*.ts | wc -l` = 58, `ls src/commands/*.ts | wc -l` = 13 | "56 TypeScript modules" → "58 TypeScript modules" |
| R4 | Les descriptions de modules dans CLAUDE.md ne doivent pas mentionner des fonctionnalites de modules supprimes | `worktree.ts` supprime en Phase 1 (commit 34e8dcb), mais `code-review.ts` decrit encore "worktree isolation" | Retirer ", worktree isolation" de la description de code-review.ts |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `src/heartbeat.ts` (ligne 562) | Module TypeScript | Filesystem | Appel `.update()` sans destructuration `{ error }` |
| `config/features.json` | JSON config | Filesystem | Cle `explore_mode` (ligne 3) |
| `CLAUDE.md` | Documentation Markdown | Filesystem | Lignes 56, 175, 176, 182, 214 |

## 4. Donnees de sortie

### 4.1 heartbeat.ts — correction du silent failure

Avant (ligne 562) :
```typescript
await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id);
```

Apres :
```typescript
const { error: updateError } = await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id);
if (updateError) console.error(`[${timestamp}] Failed to update task notes:`, updateError);
```

La variable `timestamp` est deja disponible dans le scope (definie en haut de la fonction `runHeartbeat()`). Le nom `updateError` evite tout conflit avec d'autres variables du scope.

### 4.2 config/features.json — suppression du flag mort

Avant :
```json
{
  "heartbeat": true,
  "explore_mode": true,
  "job_manager": true,
  "auto_document_search": true,
  "prd_to_deploy": true,
  "exploration_phase": true,
  "exploration_gate": false
}
```

Apres :
```json
{
  "heartbeat": true,
  "job_manager": true,
  "auto_document_search": true,
  "prd_to_deploy": true,
  "exploration_phase": true,
  "exploration_gate": false
}
```

`isFeatureEnabled()` retourne `false` pour les flags absents (ligne 31-33 de feature-flags.ts), donc aucun impact fonctionnel.

### 4.3 CLAUDE.md — 5 corrections documentaires

| Ligne | Avant | Apres |
|-------|-------|-------|
| 56 | `code-review.ts \| Adversarial code review before merge, worktree isolation` | `code-review.ts \| Adversarial code review before merge` |
| 175 | `src/                    56 TypeScript modules (core logic)` | `src/                    58 TypeScript modules (core logic)` |
| 176 | `  commands/             11 Composer modules (Telegram command handlers)` | `  commands/             13 Composer modules (Telegram command handlers)` |
| 182 | `tests/                  2720 tests (unit + integration + E2E)` | `tests/                  2690 tests (unit + integration + E2E)` |
| 214 | `Tests: \`bun test\` (2720 tests, all must pass before merge)` | `Tests: \`bun test\` (2690 tests, all must pass before merge)` |

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/heartbeat.ts` | Modifier (ligne 562) | Ajouter destructuration `{ error }` et `console.error` sur l'appel `.update()` — convention R1 |
| `config/features.json` | Modifier (supprimer ligne 3) | Retirer le flag `explore_mode` jamais reference dans le code — regle R2 |
| `CLAUDE.md` | Modifier (lignes 56, 175, 176, 182, 214) | Corriger 5 valeurs perimees — regles R3 et R4 |

## 6. Patterns existants

### Pattern de destructuration Supabase (convention du projet)

Le pattern attendu est utilise partout dans le codebase. Exemples proches dans heartbeat.ts lui-meme :

- Ligne 418 : `console.error(\`[\${timestamp}] Claude spawn failed:\`, result.stderr);` — meme format de log avec timestamp
- Ligne 464 : `console.error(\`[\${timestamp}] JSON parse failed:\`, parseError, ...)` — meme format

Le pattern general dans tout le codebase est :
```typescript
const { error } = await supabase.from("table").operation(...);
if (error) console.error("context:", error);
```

Ici on utilise `{ error: updateError }` pour eviter un potentiel shadowing dans le scope.

### Pattern de suppression de feature flags

La spec precedente (SPEC-simplification-bot.md, regle R4) a deja supprime le flag `model_cascade` avec la meme approche : suppression de la ligne JSON, aucune migration necessaire car `isFeatureEnabled()` retourne `false` par defaut pour les flags absents (feature-flags.ts ligne 31-33).

## 7. Contraintes

- **Tests existants** : les 2690 tests doivent tous passer apres correction. Les modifications ne touchent aucune logique testee (le `.update()` n'a pas de test dedie, le flag `explore_mode` n'est reference nulle part, CLAUDE.md n'a pas de test de contenu pour ces valeurs)
- **Format JSON valide** : config/features.json doit rester un JSON valide apres suppression de la ligne (attention a la virgule de la ligne precedente)
- **Variable `timestamp`** : deja definie dans le scope de `runHeartbeat()`, pas besoin de la creer
- **Pas de regression fonctionnelle** : les trois corrections sont isolees et n'affectent aucun chemin fonctionnel existant

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | L'appel `.update()` a heartbeat.ts:562 destructure `{ error }` et log avec `console.error` si erreur | Grep sur `const { error: updateError }` dans heartbeat.ts + lecture du code | manual |
| V2 | Le flag `explore_mode` n'existe plus dans config/features.json | `cat config/features.json \| grep explore_mode` retourne 0 resultats | unit |
| V3 | Le JSON de config/features.json est valide apres suppression | `bun -e "JSON.parse(require('fs').readFileSync('config/features.json','utf8'))"` sans erreur | unit |
| V4 | CLAUDE.md indique "58 TypeScript modules" (ligne 175) | Grep sur "58 TypeScript modules" dans CLAUDE.md | manual |
| V5 | CLAUDE.md indique "13 Composer modules" (ligne 176) | Grep sur "13 Composer modules" dans CLAUDE.md | manual |
| V6 | CLAUDE.md indique "2690 tests" aux deux endroits (lignes 182 et 214) | Grep sur "2690 tests" dans CLAUDE.md retourne 2 occurrences | manual |
| V7 | CLAUDE.md description de code-review.ts ne mentionne plus "worktree isolation" | Grep sur "worktree isolation" dans CLAUDE.md retourne 0 resultats | manual |
| V8 | Les 2690 tests passent sans regression | `bun test` retourne 0 echec | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Trois problemes factuels et documentes dans la roadmap Phase 3, confirmes par exploration codebase |
| Perimetre | Couvert | Scope strictement defini : 1 ligne de code, 1 cle JSON, 5 valeurs doc. Pas d'extension possible |
| Validation | Couvert | 8 V-criteres couvrent chaque correction individuellement + test de non-regression global (V8) |
| Technique | Couvert | Patterns existants identifies et reutilises. Variables de scope verifiees. Aucune dependance nouvelle |
| UX | Non applicable | Corrections internes (code, config, doc). Aucune interaction utilisateur impactee |
| Alternatives | Non applicable | Corrections factuelles sans ambiguite. Pas d'alternative de design a evaluer |

**Zones d'ombre residuelles** : Aucune. Les trois corrections sont factuelles, pre-planifiees dans la roadmap, et verifiees par exploration directe du codebase.
