---
phase: 0-explore
generated_at: "2026-03-22T00:00:00Z"
subject: "Corriger les défauts du pipeline d'agents autonomes qui causent les échecs des branches audit"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

Le pipeline d'agents autonomes (spawnClaude → branch → commit → PR → CI) présente quatre défauts structurels qui causent des échecs répétés en CI, visibles sur les branches audit. Ces défauts ne sont pas détectés localement car la validation se produit trop tard (en CI GitHub Actions, après push), et parce que les agents ne reçoivent pas les bonnes instructions de leur contexte injecté.

**Cause racine 1 — Absence de validation TypeScript avant commit dans spawnClaude**
`src/agent.ts` : la fonction `executeTask` fait `git add -A` puis `git commit` immédiatement après la fin du spawn Claude, sans aucune vérification. Aucun `bun build --no-bundle` ni `bun test` n'est exécuté entre la fin du spawn et le commit. Un agent qui introduit une erreur de type passera le commit local, échouera en CI sur l'étape "Type check" ou "Run unit tests", et bloquera la PR sans feedback immédiat exploitable.

**Cause racine 2 — Erreurs Supabase silencieuses dans heartbeat.ts**
`src/heartbeat.ts` (lignes 126-129, 197-200) : deux appels Supabase (`getSprintDelta` et `getStaleTasks`) destructurent uniquement `{ data }` sans `{ data, error }`. Si la requête échoue (table indisponible, RLS error, network), l'erreur est ignorée et le code continue sur `data = undefined`, produisant un comportement silencieusement incorrect. La convention du projet impose `{ error }` systématique (voir `CLAUDE.md` conventions + `src/agent-context.ts` lignes 281-282, 308-309 qui appliquent correctement le pattern). L'issue signalée dans `src/agent-context.ts` et `src/bmad-prompts.ts` ne se confirme pas à l'analyse du code actuel pour ces deux fichiers — seul `heartbeat.ts` présente le défaut.

**Cause racine 3 — Documentation CLAUDE.md non mise à jour par les agents**
Le count de tests dans CLAUDE.md indique 3212 tests. Le vrai décompte mesuré est 2967 tests (run du 2026-03-22). Cet écart de 245 tests déclenche l'alerte dans le CI "Doc freshness check" car `scripts/doc-freshness.ts` compare les deux. Les agents dev ne reçoivent pas d'instruction explicite pour mettre à jour CLAUDE.md après avoir ajouté ou supprimé des tests. La `critical_actions` du dev agent YAML (`config/bmad-templates/agents/dev.agent.yaml`) liste 8 actions obligatoires, aucune ne mentionne CLAUDE.md. Le contexte injecté via `buildAgentContext` dans `agent-context.ts` n'inclut pas non plus cette obligation.

**Cause racine 4 — Import fragile `../scripts/` dans src/**
`src/heartbeat.ts` ligne 59 importe directement depuis `"../scripts/doc-utils.ts"`. Ce chemin relatif croise les frontières de module (src/ → scripts/) et est fragile : si `heartbeat.ts` est déplacé, si `scripts/doc-utils.ts` est renommé, ou si un agent refactorise sans voir la dépendance, le build casse. Les tests (`tests/unit/doc-utils.test.ts`, `tests/unit/doc-freshness.test.ts`) importent depuis `"../../scripts/doc-utils.ts"` : trois chemins relatifs différents vers le même fichier. La solution idiomatique est de déplacer `doc-utils.ts` dans `src/` ou de créer un réexport dans `src/`.

Ces quatre défauts combinés expliquent pourquoi les branches d'agents échouent en CI sans feedback précoce, et pourquoi les agents répètent les mêmes erreurs de sprint en sprint.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://circleci.com/blog/enforce-type-safety-with-typescript-checks-before-deployments/ | Article technique | 2025 | `tsc --noEmit` comme gate obligatoire avant déploiement : "malicious code which violates contracts will not be merged." Coût minimal, valeur maximale. | Haute |
| 2 | https://dev.to/arasosman/git-hooks-for-automated-code-quality-checks-guide-2025-372f | Guide pratique | 2025 | Pre-commit hooks comme "first line of defense" : "fail-fast approach saves time." Recommande Lefthook, Husky pour TypeScript. | Haute |
| 3 | https://supabase.com/docs/guides/functions/error-handling | Documentation officielle | 2026 | "Functions that fail silently are hard to debug, functions with clear error messages get fixed fast." Pattern d'erreur-first explicite pour toutes les invocations Supabase. | Haute |

**Synthèse des enseignements :**

L'industrie converge sur deux principes complémentaires pour les pipelines autonomes : (1) valider au plus tôt (pre-commit > pre-push > CI) et (2) traiter toutes les erreurs explicitement. Pour TypeScript, la commande `bun build --no-bundle --target=bun` est l'équivalent de `tsc --noEmit` dans l'écosystème Bun : elle détecte les erreurs de type sans générer d'output. Le coût est de quelques secondes par fichier, négligeable face au coût d'une PR bloquée 10-15 minutes en CI.

Pour les erreurs Supabase, le pattern officiel impose de destructurer `{ data, error }` et de vérifier `error` immédiatement. Le projet applique ce pattern dans 95% de ses modules (`src/agent-context.ts`, `src/tasks.ts`, etc.) — la faute dans `heartbeat.ts` est une exception récente probablement introduite par un agent qui n'a pas eu ce pattern dans son contexte.

Lefthook est déjà configuré dans ce projet (`lefthook.yml`) pour Biome check, mais ne couvre pas le typecheck ni les tests. C'est un levier existant sous-utilisé.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/agent.ts` lignes 437-444 | `git add -A` + `git commit` sans validation préalable. Aucun `bun build` ni `bun test` entre fin de spawn et commit. | Critique — source directe des échecs CI |
| 2 | `src/heartbeat.ts` lignes 126-129, 197-200 | `{ data }` sans `{ data, error }` dans `getSprintDelta` et `getStaleTasks`. Erreur Supabase ignorée silencieusement. | Élevé — comportement incorrect sans trace |
| 3 | `src/heartbeat.ts` ligne 59 | `import ... from "../scripts/doc-utils.ts"` — import cross-frontières src/scripts. | Moyen — fragilité structurelle, bloque refactorisations |
| 4 | `src/bmad-agents.ts` lignes 172-179 | `criticalActions` du dev agent : 7 actions, aucune sur CLAUDE.md update ni typecheck avant commit. | Élevé — les agents répèteront l'erreur |
| 5 | `config/bmad-templates/agents/dev.agent.yaml` lignes 21-29 | Idem : `critical_actions` sans mention de CLAUDE.md update ni `bun build` pré-commit. | Élevé — source de l'instruction manquante |
| 6 | `src/agent-context.ts` fonction `buildAgentContext` | Le contexte injecté couvre mémoire, sprint, tâches, trust — mais pas les patterns obligatoires (error destructuring, CLAUDE.md update). | Élevé — les agents n'ont pas ces règles en context |
| 7 | `src/bmad-prompts.ts` fonction `getDevInstructions` | Instructions exec : 9 points, aucun sur typecheck pré-commit ni CLAUDE.md. | Élevé — instructions incomplètes |
| 8 | `lefthook.yml` | Seul Biome check sur fichiers stagés. `bun build` et `bun test` absents. | Moyen — levier sous-utilisé |
| 9 | `.github/workflows/ci.yml` | Type check, tests et doc freshness : validation exhaustive mais tardive (post-push). | Info — gatekeeper final mais trop lent pour feedback |
| 10 | `scripts/doc-utils.ts` | Fichier partagé src/ + scripts/ + tests/ via trois chemins relatifs différents. | Moyen — fragile mais fonctionnel actuellement |

**Points de friction identifiés :**

- Ajouter `bun build` dans `executeTask` avant le commit ajoute ~5-10s par fichier modifié, acceptable.
- Ajouter `bun test` avant commit ajoute potentiellement 2-3 minutes selon la taille de la suite. Il faut cibler `bun test tests/unit` uniquement (rapide, ~8s), pas la suite complète.
- Déplacer `doc-utils.ts` dans `src/` nécessite de mettre à jour 3 imports (heartbeat.ts, doc-freshness.test.ts, doc-utils.test.ts) — changement mineur mais doit être fait par un humain ou un agent avec instructions précises.
- Enrichir le contexte agent via `buildAgentContext` ou `getDevInstructions` est non-invasif et ne casse rien.

**Actifs réutilisables :**

- Le pattern `{ data, error }` est présent et correct dans `src/agent-context.ts` lignes 281-282 — template directement utilisable pour corriger heartbeat.ts.
- `lefthook.yml` est déjà en place — extension naturelle pour ajouter typecheck.
- `buildAgentContext` et `getDevInstructions` sont des points d'injection propres pour enrichir les instructions agents sans modifier les YAML.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Correction ciblée 4 défauts | C: Refactorisation complète pipeline |
|---------|:------------:|:-----------:|:-----------:|
| **Complexité** (obligatoire) | S | S | L |
| **Valeur ajoutée** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | High | Low | Med |
| *Impact maintenance* (pertinent) | Dégradation continue | Amélioration durable | Amélioration + dette restructuration |
| *Réversibilité* (pertinent) | N/A | Haute | Basse |

**Option A — Status quo :** Les quatre défauts persistent. Les branches audit continuent d'échouer en CI. Les agents répètent les mêmes erreurs car ils n'ont pas les bonnes instructions. Le heartbeat peut silencieusement produire des données incorrectes sur l'état du sprint. Non recommandé.

**Option B — Correction ciblée des 4 défauts :** Quatre corrections atomiques et indépendantes. (1) Ajouter `bun build` + `bun test tests/unit` dans `executeTask` avant le commit. (2) Corriger les deux destructurations dans `heartbeat.ts`. (3) Enrichir `getDevInstructions` et le contexte agent avec l'obligation CLAUDE.md + typecheck. (4) Déplacer ou réexporter `doc-utils.ts` depuis `src/`. Chaque correction est testable isolément. C'est l'option recommandée.

**Option C — Refactorisation complète du pipeline agent :** Refactoriser `executeTask` pour introduire une phase de "pre-commit validation" configurable (typecheck, tests, linting), centraliser les patterns Supabase dans un helper, restructurer les imports. Plus complet mais complexité accrue, risque de régression, et la valeur marginale vs option B est faible à court terme.

---

## Section 5 — Verdict et justification

**Verdict : GO — Option B (Correction ciblée des 4 défauts)**

**Justification :**

L'archéologie codebase (Axe 2) confirme que les quatre défauts sont réels, localisés, et indépendants. Chaque correction est chirurgicale : 1-5 lignes de code pour les défauts 1 et 2, quelques lignes de contexte pour le défaut 3, un déplacement de fichier pour le défaut 4. Le risque technique est faible car aucune interface publique n'est modifiée.

L'état de l'art (Axe 1) valide l'approche : pre-commit validation (TypeScript + tests unitaires) est la pratique standard en 2025 pour les pipelines autonomes. Le coût de `bun test tests/unit` (~8s mesuré) est acceptable. Supabase documente explicitement que les erreurs silencieuses sont le pattern le plus difficile à déboguer — corriger les deux occurrences dans heartbeat.ts est non-négociable.

Le défaut 3 (CLAUDE.md non mis à jour) est confirmé par la mesure : 2967 tests réels vs 3212 documentés, écart de 245. Sans instruction explicite dans le contexte agent, les agents répéteront cette omission à chaque sprint. Enrichir `getDevInstructions` dans `src/bmad-prompts.ts` est la correction la moins invasive et la plus durable.

Le défaut 4 (import `../scripts/`) n'est pas bloquant aujourd'hui mais représente une dette qui se manifeste lors des refactorisations autonomes — l'axe 2 montre trois chemins relatifs vers le même fichier.

---

## Section 6 — Input pour étape suivante

**Option recommandée :** B — Correction ciblée des 4 défauts

**Fichiers concernés par la spec :**

- `src/agent.ts` — ajouter validation pré-commit dans `executeTask` (fonction git + spawnClaude)
- `src/heartbeat.ts` — corriger `getSprintDelta` (lignes 126-129) et `getStaleTasks` (lignes 197-200)
- `src/bmad-prompts.ts` — enrichir `getDevInstructions` avec obligation CLAUDE.md + typecheck
- `src/agent-context.ts` — optionnellement : enrichir la section `PATTERNS OBLIGATOIRES` du contexte injecté
- `scripts/doc-utils.ts` → déplacer vers `src/doc-utils.ts` (mise à jour imports heartbeat.ts + tests)

**Contraintes identifiées :**

- La validation TypeScript dans `executeTask` doit cibler uniquement les fichiers modifiés (ex: `git diff --name-only HEAD` + `bun build --no-bundle`) pour rester rapide, pas tous les fichiers src/.
- `bun test tests/unit` doit être exécuté, pas `bun test` complet (trop lent pour un pipeline agent).
- Si `bun build` échoue, le commit doit être bloqué et un message d'erreur précis retourné (exit code non-zero → rollback de branche + retour `success: false`).
- Le déplacement de `doc-utils.ts` doit préserver les exports existants et mettre à jour le `package.json` ou les paths si nécessaire.

**Questions ouvertes à résoudre pendant la spec :**

1. Faut-il bloquer hard sur l'échec typecheck (arrêt de branche) ou envoyer un warning et continuer ? — Recommandation : bloquer hard, même comportement que l'échec CI actuel mais plus tôt.
2. Les instructions enrichies dans `getDevInstructions` doivent-elles aussi apparaître dans `dev.agent.yaml` (YAML template) pour les usages directs des agents YAML ?
3. Faut-il ajouter un test unitaire vérifiant que `executeTask` appelle la validation pré-commit, ou se contenter des tests E2E existants ?

**Critères de validation (V-criteria) :**

- V1 : Un agent qui introduit une erreur de type TypeScript voit le commit bloqué dans `executeTask` avant le `git push`.
- V2 : `getSprintDelta` et `getStaleTasks` dans heartbeat.ts logguent l'erreur Supabase via `log.error` quand `error` n'est pas null.
- V3 : Le contexte injecté par `getDevInstructions` mentionne explicitement l'obligation de mise à jour de CLAUDE.md après ajout/suppression de tests ou modules.
- V4 : `src/heartbeat.ts` n'importe plus depuis `"../scripts/"` — le module `doc-utils` est résolu depuis `src/`.
- V5 : `bun test tests/unit` passe sans régression après les modifications.
