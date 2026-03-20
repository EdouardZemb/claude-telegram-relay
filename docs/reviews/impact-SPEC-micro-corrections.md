## Rapport d'impact : Micro-corrections post-audit Phase 3

> Genere le 2026-03-20 a partir de docs/specs/SPEC-micro-corrections.md.

### Niveau de risque : LOW

### Resume

Ce changement corrige trois problemes isoles sans lien fonctionnel entre eux : un silent failure sur un `.update()` Supabase dans heartbeat.ts (ajout de destructuration `{ error }` + log), la suppression d'un feature flag mort `explore_mode` dans config/features.json, et cinq corrections de valeurs documentaires obsoletes dans CLAUDE.md. Le blast radius est minimal : aucune API publique n'est modifiee, aucun export n'est touche, et les trois corrections sont strictement internes a leurs fichiers respectifs.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/heartbeat.ts` | Direct | Ajout de destructuration `{ error: updateError }` et `console.error` sur l'appel `.update()` ligne 562. Modification interne a la fonction `pulse()`, aucun changement de signature ou de retour. |
| `config/features.json` | Direct | Suppression de la cle `explore_mode`. Aucun appel `isFeatureEnabled("explore_mode")` n'existe dans `src/`, ni dans `tests/`. Le flag est un vestige sans consommateur. |
| `CLAUDE.md` | Direct | 5 corrections de valeurs textuelles (counts modules, composers, tests, description code-review.ts). Documentation pure, aucun impact runtime. |
| `src/feature-flags.ts` | Aucun | Lit `config/features.json` dynamiquement. `isFeatureEnabled()` retourne `false` pour les flags absents (ligne 31-33). Aucune modification requise. |
| `src/code-review.ts` | Aucun | Mentionne dans CLAUDE.md mais le module lui-meme n'est pas modifie. Sa description doc est corrigee (retrait ", worktree isolation"). |
| `src/agent.ts` | Aucun | Seul importateur de `code-review.ts`. Non impacte par la correction documentaire. |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/heartbeat.ts` | `pulse()` | Modification interne (ajout error handling dans le body) | Oui — signature et type de retour inchanges |

Aucune autre API publique n'est modifiee. Les exports de `heartbeat.ts` (11 fonctions/types exportes : `loadState`, `saveState`, `getGitDelta`, `getSprintDelta`, `getCIStatus`, `getOpenPRs`, `getStaleTasks`, `TriageResult`, `collectAndTriage`, `executeActions`, `pulse`) restent identiques.

### Breaking changes potentiels

Aucun breaking change identifie.

- La modification de `heartbeat.ts` est interne au body de `pulse()` : meme signature, meme type de retour, meme comportement fonctionnel (le `.update()` continue d'etre appele, avec en plus un log en cas d'erreur).
- La suppression de `explore_mode` dans `features.json` n'a aucun consommateur : zero occurrences de `isFeatureEnabled("explore_mode")` dans `src/` et `tests/`. De plus, `isFeatureEnabled()` retourne `false` par defaut pour les flags absents, donc meme un consommateur hypothetique non detecte ne casserait pas.
- Les modifications de `CLAUDE.md` sont purement documentaires et n'affectent aucun runtime.

### Points d'attention pour le Reviewer

1. **Variable `timestamp` dans le scope de `pulse()`** : verifier que `timestamp` est bien accessible a la ligne 562. Confirme : `const timestamp = new Date().toISOString()` est defini a la ligne 356, au debut de `pulse()`, et la ligne 562 est dans le meme body de fonction (bloc try/catch interne). Le nom `updateError` evite tout shadowing avec d'autres variables `error` potentielles dans le scope englobant.

2. **Validite JSON apres suppression de `explore_mode`** : la ligne `"explore_mode": true,` est la deuxieme entree du JSON (ligne 3). Sa suppression doit preserver la virgule de la ligne precedente (`"heartbeat": true,`) et le reste du fichier. Verifier que le JSON resultant est syntaxiquement valide (V-critere V3 de la spec).

3. **Coherence des counts CLAUDE.md** : les valeurs cibles (58 modules, 13 composers, 2690 tests) doivent correspondre a l'etat reel du codebase au moment de l'implementation. Si d'autres modifications ont eu lieu entre la redaction de la spec et l'implementation, ces valeurs pourraient etre deja obsoletes. Verifier avec `ls src/*.ts | wc -l`, `ls src/commands/*.ts | wc -l`, et le nombre reel de tests.

4. **Description `code-review.ts` dans CLAUDE.md** : verifier que `worktree.ts` est bien absent du codebase (confirme : `src/worktree.ts` n'existe pas) et que `code-review.ts` n'importe plus rien de worktree (confirme : aucun import worktree dans code-review.ts).

### Blast radius

- Modules directement modifies : 3 (heartbeat.ts, features.json, CLAUDE.md)
- Modules indirectement impactes : 0
- Fichiers source modifies : 3
- Fichiers de test a verifier : 0 (aucun test ne couvre le `.update()` modifie, aucun test ne reference `explore_mode`, aucun test ne valide les valeurs de CLAUDE.md)
