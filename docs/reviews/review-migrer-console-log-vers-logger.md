## Revue : Migration console.log vers le logger structure (SPEC-migrer-console-log-vers-logger)

> Revue effectuee le 2026-03-22. Scope : 42 fichiers src/ + 2 fichiers tests (logger-migration.test.ts, loader.test.ts).

### Synthese

La migration remplace correctement les 241 appels `console.log/error/warn` par le logger structure `createLogger()` dans les 42 fichiers source. Zero `console.*` residuel dans `src/` (hors `logger.ts`). Tests de compliance (275 pass) et tests loader (18 pass) passent integralement.

---

### Problemes bloquants

Aucun.

---

### Avertissements

1. **[src/heartbeat.ts:106] Variable shadowing `log`** — La declaration `const log = git("log", "--oneline", ...)` dans `getGitDelta()` masque le logger module-level `const log = createLogger("heartbeat")` (ligne 53). Pre-existant avant la migration, mais desormais plus confus puisque le logger s'appelle aussi `log`. Risque : si du code de logging est ajoute dans cette fonction, il appellera le string au lieu du logger. Recommandation : renommer en `const gitLog = git("log", ...)`.

2. **[src/workflow.ts:510,523] Variable shadowing `log`** — Les boucles `for (const log of logs ?? [])` dans `generateRetroData()` masquent le logger module-level `const log = createLogger("workflow")` (ligne 21). Meme probleme de confusion que ci-dessus. Recommandation : renommer en `for (const entry of logs ?? [])`.

3. **[src/heartbeat.ts:420,444,471,488,506,532,547,576,607,623] Trailing colon vestigiel dans le message** — 10 appels suivent le pattern `log.error("Label:", { error: String(err) })` avec un deux-points en fin de message. Ce deux-points etait justifie avec `console.error("Label:", err)` (separator d'arguments), mais il est desormais inutile puisque l'erreur est dans le champ metadata. Le deux-points apparait dans le message JSON/dev sans objet visible a sa droite. Memes observations dans `notification-queue.ts` (3 appels), `bmad-prompts.ts` (1 appel), `gate-evaluator.ts` (1 appel) — total 15 appels concernes.

4. **[src/documents.ts:166,169,171] Choix info vs debug pour pdf-parse** — La spec R2 indique explicitement `console.log("pdf-parse OK: X chars")` -> `log.debug(...)` (diagnostic). L'implementation utilise `log.info` pour ces 3 lignes. En production (`LOG_LEVEL=info` par defaut), ces logs seront visibles pour chaque PDF traite, ce qui ajoute du bruit. Les lignes 178, 202, 206, 228 (pdftoppm messages) sont correctement `log.info` car ils indiquent le choix de pipeline (operationnel). Recommandation : passer les 3 lignes pdf-parse (166, 169, 171) en `log.debug`.

---

### Suggestions

1. **[tests/unit/loader.test.ts] Tests adaptés correctement** — Les tests du loader interceptent `console.log` (le transport sous-jacent du logger en dev) et utilisent un helper `extractLoadedFiles()` qui parse le format structure. Cette approche est correcte mais fragile : si le format de sortie du logger change, les tests casseront. Pour robustesse a long terme, envisager de mocker directement le module logger dans les tests du loader (via `bun:test` mock). Non bloquant actuellement.

2. **[tests/unit/logger-migration.test.ts:71-96] Filtre R16 bien implemente** — Le helper `hasRealConsoleCall` supprime les string literals avant de chercher `console.*`, couvrant correctement le cas `gate-persistence.ts` (L124). Un test dedie `R16` le valide (L185-194). Bon travail.

3. **[src/logger.ts] API stable, aucune modification** — Le module logger n'a pas ete touche (R10 respecte). Les 3 appels `console.*` internes sont preserves (V6 verifie).

4. **[general] Coherence des noms de module** — Tous les noms passes a `createLogger()` correspondent au nom de fichier (ex: `createLogger("memory")` dans `memory.ts`, `createLogger("zz-messages")` dans `commands/zz-messages.ts`, `createLogger("documents-cmd")` dans `commands/documents.ts`). Exception notable : `commands/documents.ts` utilise `"documents-cmd"` pour eviter la collision avec `src/documents.ts` qui utilise `"documents"`. Choix judicieux.

5. **[src/loader.ts:68] R15 correctement appliquee** — L'errorBoundary passe `moduleName` en metadata : `log.error(err.error, { errorModule: moduleName })`. Cela preserve l'information du module en erreur tout en supprimant le prefixe `[${moduleName}]` du message (redondant avec le champ `module` du logger).

---

### Checklist de revue

| Critere | Statut | Detail |
|---------|--------|--------|
| Imports coherents | OK | `./logger.ts` pour `src/`, `../logger.ts` pour `src/commands/`, aucun import circulaire |
| Pas de secrets | OK | Aucun credential dans les fichiers modifies |
| Types explicites | OK | `createLogger` retourne un type infere correct, pas de `any` ajoute |
| Coherence patterns | OK | Pattern `{ error: String(error) }` uniforme sur les 42 fichiers |
| Pas de duplication | OK | Un seul module logger reutilise partout |
| Nommage | OK | Noms de module coherents avec le fichier source |
| Backward compatibility | OK | Aucune API publique modifiee, changement purement interne |
| Tests existants | OK | 275/275 logger-migration, 18/18 loader — zero echec |
| R1 (import + declaration) | OK | 42/42 fichiers ont `import { createLogger }` et `const log = createLogger(...)` |
| R2 (info/debug) | WARN | 3 lignes pdf-parse en `info` au lieu de `debug` (voir avertissement 4) |
| R3 (warn mapping) | OK | `console.warn` -> `log.warn` direct |
| R4 (error mapping) | OK | `console.error` -> `log.error` direct pour strings simples |
| R5 (error avec metadata) | OK | Pattern `{ error: String(error) }` applique uniformement |
| R6 (object literal) | OK | Pattern P7 (agent-events.ts) correctement converti |
| R7 (timestamp heartbeat) | OK | Aucun `[${timestamp}]` dans heartbeat.ts |
| R8 (prefixe loader) | OK | Aucun `[loader]` dans les messages de loader.ts |
| R9 (.catch inline) | OK | Toutes les closures `.catch` utilisent `log.error` du scope module |
| R10 (logger.ts exclu) | OK | Pas modifie, 3 `console.*` preserves |
| R11 (scope respect) | OK | Seuls `src/` et les tests specifies sont modifies |
| R12 (test etendu) | OK | 42 modules dans MIGRATED_MODULES (3 pilotes + 5 vague1 + 7 vague2 + 28 vague3) |
| R13 (pas de toMeta) | OK | `String(error)` inline partout, pas de helper |
| R14 (withCorrelation hors scope) | OK | Aucun ajout de `withCorrelation` |
| R15 (loader errorBoundary) | OK | `{ errorModule: moduleName }` correctement passe en metadata |
| R16 (faux positifs string) | OK | Test dedie + filtre `hasRealConsoleCall` fonctionnel |
| V10 (non-regression) | OK | Tests logger-migration (275) + loader (18) passent |

### Rapport d'impact : validation

Le rapport d'impact identifiait 7 points d'attention. Verdict :

1. **CRITIQUE — Tests loader.test.ts** : RESOLU. Les tests ont ete adaptes avec des helpers `extractLoadedFiles()` et `extractSummary()` qui parsent le format du logger structure. Les 18 tests passent.

2. **CRITIQUE — Test code-review.test.ts** : HORS SCOPE confirme. Le fichier `code-review.test.ts` n'est pas dans la liste des fichiers modifies par ce pipeline. Les tests existants continueront de passer car `log.error` appelle `console.error` en sous-jacent — le spy captera l'appel.

3. **IMPORTANT — Tests prd.test.ts** : HORS SCOPE confirme. Meme raisonnement que ci-dessus — les assertions `toHaveBeenCalled()` (sans verification de contenu) continueront de fonctionner.

4. **IMPORTANT — Choix info vs debug** : PARTIELLEMENT RESOLU. La majorite des choix sont corrects. Exception : pdf-parse (3 lignes, voir avertissement 4).

5. **ATTENTION — Suppression prefixe [loader]** : RESOLU. Les prefixes `[loader]` ont ete supprimes des messages et les tests adaptes en parallele.

6. **ATTENTION — Suppression prefixe timestamp heartbeat** : RESOLU. Aucun `[${timestamp}]` ne subsiste dans heartbeat.ts.

7. **ATTENTION — V11 scope tests** : RESPECTE. Seuls `logger-migration.test.ts` et `loader.test.ts` sont dans le scope (pas `prd.test.ts` ni `code-review.test.ts`).

---

### Score : 90/100

La migration est correcte, complete, et bien testee. Les 42 fichiers sont migres sans residus, les patterns sont uniformes, et les regles R1-R16 sont respectees. Les 4 avertissements sont mineurs (2 pre-existants, 1 esthetique, 1 choix info/debug) et ne bloquent pas le merge. Zero probleme bloquant.
