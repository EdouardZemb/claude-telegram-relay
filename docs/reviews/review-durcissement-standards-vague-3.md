## Revue : SPEC-durcissement-standards-vague-3

> Reviewer : agent reviewer
> Date : 2026-03-23
> Périmètre : 41 fichiers listés dans le scope (src/, tests/, .github/, CLAUDE.md)

---

### Problèmes bloquants

- **[src/workflow.ts:788]** Le bloc `catch` porte le commentaire `// R8: business error → log.warn` mais aucun appel `log.warn` n'est présent dans le corps du bloc. R8 exige `log.warn` minimum — commentaire seul insuffisant. Le bloc est vide (`} catch { // R8: business error → log.warn\n  }`). Violation directe de la règle R8/R9 de la spec.

- **[src/agent.ts:409]** Même violation : le bloc `catch` porte `// R8: business error → log.warn` mais contient uniquement `await Bun.sleep(pollIntervalMs)` — aucun `log.warn`. Le CI poll dans la boucle de vérification avale silencieusement les erreurs réseau, ce qui est l'exact anti-pattern que R8 cherche à éliminer.

- **[.github/workflows/ci.yml:71]** Le parsing de la couverture est cassé. La commande `awk '{ print $3 }'` sur une ligne du type `All files | 69.87 | 58.20 |` retourne `|` (le troisième token selon le séparateur espace par défaut), pas la valeur numérique. `LINES` est toujours `|` après `tr -d '%'`. La condition `[ -z "$LINES" ]` échoue car `|` n'est pas vide. La comparaison `bc -l` reçoit `| < 60` et produit une erreur. En pratique, sur un runner Linux avec `bc`, la commande `$(echo "| < 60" | bc -l)` retourne une erreur et `(( ))` échoue silencieusement — le résultat dépend du comportement exact du shell. Sur le runner self-hosted, le thresholding coverage est soit cassé, soit non-enforced selon le comportement de bash `(( ))` face à une erreur bc. Commande correcte : `awk -F'|' '{ gsub(/ /,"",$2); print $2 }'`. La spec R15/R16 exige que le seuil 60% soit enforced.

---

### Avertissements

- **[src/commands/tasks.ts:56]** Imports `resolveProjectContext` et le bloc depuis `../tasks.ts` sont placés **après** la définition de la fonction exportée `parseTaskCommand` (lignes 33-55). ES modules hoistent les imports donc cela fonctionne à l'exécution, mais c'est une violation de la convention projet (tous les imports en tête de fichier). Cela suggère un ajout mécanique des nouvelles déclarations sans réorganisation. À corriger pour maintenir la lisibilité.

- **[src/commands/execution.ts:374-387]** Le `OrchestrateCommandSchema` valide `idPrefix`, `pipeline`, `useBlackboard`, `skipChallenge`, `useResume`, `resumeSessionId` — mais après le parse, seul `orchestrateParsed.data.idPrefix` est utilisé (ligne 387). Les valeurs validées pour `pipeline`, `useBlackboard`, etc. sont immédiatement abandonnées ; le code continue à utiliser les variables locales `pipelineArg`, `useBlackboard`, `skipChallenge`, `useResume`, `explicitResumeId` qui sont les valeurs brutes pré-validation. Cela signifie que la validation Zod de ces champs est effectuée mais son résultat n'est pas consommé. La valeur ajoutée du schema Zod se limite donc à la validation du `idPrefix` — pas du pipeline ni des flags. Incohérence conceptuelle, non-bloquante (la validation downstream via `validAgents` compense partiellement).

- **[src/commands/tasks.ts:35]** Le regex `--desc` ne capture pas les descriptions contenant des tirets internes. `parseTaskCommand("Fix bug --desc Hello-World")` retourne `desc: undefined` car le pattern `[^-][^\s-]*` exige que chaque token commence par un non-tiret. Cas de régression : un utilisateur qui tape `/task Fix bug --desc API-endpoint` perd sa description silencieusement. Le test `command-validators.test.ts` ne couvre pas ce cas.

- **[CLAUDE.md:189,222]** La documentation indique "3516 tests" dans deux endroits distincts. Le compte réel est **3228** (confirmé par `bun test tests/unit tests/integration tests/system`). Le CI a correctement été mis à jour à 3228 avec un commentaire expliquant la divergence, mais CLAUDE.md reste inexact. Risque : confusion lors des prochains sprints si quelqu'un vérifie le compte de tests réel contre la doc.

- **[.github/workflows/ci.yml:45-63]** Les tests sont executés deux fois dans le même job CI : d'abord pour le compte (`bun test tests/unit tests/integration tests/system`), puis pour la couverture (`bun test --coverage --coverage-reporter=text tests/unit tests/integration`). La spec R15 demande un "single step" — la double exécution existe, bien que le second run exclue `tests/system`. Pas de violation directe (la spec dit "une seule exécution du test runner" pour éviter 4 runs — ici il y en a 2), mais le coût CI est plus élevé que nécessaire.

- **[src/commands/jobs.ts:194]** Le bloc `catch` est annoté `// R7: optional feature → skip` mais il enveloppe un `await job.cancel()` dans une commande Telegram active. Si `cancel()` lève une exception, elle est silencieusement avalée sans notifier l'utilisateur que la cancellation a échoué. R7 est raisonnable ici (l'annulation est best-effort), mais un `log.warn` serait préférable pour la traçabilité.

- **[src/agent-events.ts:209-219]** Le bloc `catch` externe (R7) contient un `try/catch` imbriqué (R7 également) avec un `log.error` dans le catch interne. Cette structure à deux niveaux est inhabituelle. Le `log.error` interne se produit quand même le fallback en mémoire échoue — c'est correct, mais la lisibilité est dégradée.

---

### Suggestions

- **[src/commands/tasks.ts:35]** Remplacer le regex `--desc` par `--desc\s+(.*?)(?=\s+--|$)` pour capturer tout contenu jusqu'au prochain flag ou fin de chaîne, incluant les tirets. Ajouter un test couvrant `/task Fix bug --desc API-endpoint`.

- **[src/commands/execution.ts:387]** Pour que la validation Zod de `/orchestrate` soit réellement utile, utiliser les valeurs validées : `const { idPrefix, useBlackboard: _ub, skipChallenge: _sc, useResume: _ur } = orchestrateParsed.data` et remplacer les références aux variables brutes en aval. Ou à minima documenter explicitement que seul `idPrefix` est extrait du résultat Zod.

- **[.github/workflows/ci.yml:71]** Corriger le parsing awk : remplacer `awk '{ print $3 }'` par `awk -F'|' '{ gsub(/[[:space:]]/, "", $2); print $2 }'` pour extraire correctement la valeur de couverture des lignes.

- **[src/workflow.ts:788]** Ajouter `log.warn("auditWorkflow: loadWorkflowConfig unavailable", { entry: entry.action })` dans le catch vide pour satisfaire R8.

- **[src/agent.ts:409]** Ajouter `log.warn("pollCiStatus: poll attempt failed, retrying", { attempt })` dans le catch pour satisfaire R8 (l'`await Bun.sleep` actuel est un retry silencieux).

- **[CLAUDE.md:189,222]** Corriger "3516 tests" → "3228 tests" (ou valeur vérifiée au moment du merge).

- **[tests/unit/command-validators.test.ts]** Ajouter des tests couvrant : (a) description avec tirets (`--desc API-endpoint`), (b) `OrchestrateCommandSchema` avec un pipeline inconnu non-custom (ex: `"light"`) pour documenter le comportement attendu.

---

### Résumé des conformités

| Règle | Statut | Note |
|-------|--------|------|
| R1/R2 `src/result.ts` | Conforme | Implémentation exacte de la spec |
| R3 adoption limitée | Conforme | Seuls validators + `parseTaskCommand` utilisent Result |
| R4 audit 111 catch | Conforme | Les 111 blocs sont annotés, 0 catch vide restant |
| R5 catégorie A | Conforme | Commentaires `// R5: parse failure → fallback` présents |
| R6 catégorie B | Conforme | Commentaires `// R6: optional IO → degrade gracefully` présents |
| R7 catégorie C | Conforme | Commentaires `// R7: optional feature → skip` présents |
| R8 catégorie D | **Partiel** | workflow.ts:788 et agent.ts:409 ont le commentaire R8 sans log.warn |
| R9 catégorie E | Conforme | job-manager.ts:128 reclassé R6 (justifié par le comportement IO) |
| R10 TaskCommandSchema | Conforme | Schéma + parseTaskCommand exportés et utilisés |
| R11 ExecCommandSchema | Conforme | Regex correcte, min/max cohérents, tests V8-V10 passent |
| R12 OrchestrateCommandSchema | Partiel | Schema valide mais valeurs non consommées (idPrefix uniquement extrait) |
| R13 PrdCommandSchema | Conforme | Schéma flat object validant les champs extraits, F-DA-2 respecté |
| R14 erreurs Zod → reply | Conforme | Tous les handlers appellent ctx.reply + return |
| R15 step unique | Partiel | Double exécution des tests (count + coverage), mais dans un seul step YAML |
| R16 parsing coverage graceful | **Non conforme** | awk $3 retourne `\|` — threshold 60% jamais enforced |
| R17 seuil régression | Conforme | Seuil 3228 = count réel vérifié, avec commentaire explicatif |
| TypeScript | Conforme | `bunx tsc --noEmit` : 0 erreurs |
| Tests | Conforme | 3228 pass, 0 fail |

---

### Score : 74/100

**Justification :** L'implémentation est large (111 catch blocks, 4 schemas Zod, CI coverage, nouveau `Result<T, E>`) et globalement solide. Les deux problèmes bloquants (workflow.ts et agent.ts avec R8 sans log.warn, et le parsing awk cassé qui désactive silencieusement l'enforcement du seuil coverage) doivent être corrigés avant merge. La logique de validation Zod pour `/orchestrate` (valeurs validées non utilisées) est une opportunité manquée mais non-bloquante. Les imports mal positionnés dans tasks.ts et la regex --desc défaillante sont des problèmes de qualité à corriger.
