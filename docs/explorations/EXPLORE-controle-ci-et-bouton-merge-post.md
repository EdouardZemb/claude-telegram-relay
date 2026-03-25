---
phase: 0-explore
generated_at: "2026-03-25T12:00:00Z"
subject: "Controle CI et bouton merge post-implementation"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Controle CI et bouton merge post-implementation

## Section 1 -- Probleme

Apres l'etape d'implementation ou de review dans le pipeline SDD (dev pipeline), le bot cree une PR GitHub mais ne verifie pas que la CI (GitHub Actions) est passee avec succes avant de proposer des boutons d'action dans la conversation Telegram. Actuellement :

- Le bouton "Fusionner la PR" (`sdd_merge_ask`) apparait dans `job-manager.ts` quand la review donne un verdict APPROVED, **sans controle prealable de l'etat CI**.
- Le bouton "Voir la PR" (URL) est present apres implementation, mais il n'y a pas de feedback sur l'etat CI.
- Si l'utilisateur clique "Fusionner la PR" alors que la CI est encore en cours ou a echoue, le `gh pr merge --squash` dans `sdd-flow.ts` echouera (le master est protege avec `required_status_checks: [check]`), produisant un message d'erreur peu explicite.

L'exploration est necessaire pour evaluer les differentes approches (polling, webhooks, auto-merge) et identifier les points d'integration dans l'architecture existante.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [gh pr checks - CLI manual](https://cli.github.com/manual/gh_pr_checks) | Documentation officielle | 2026-03-25 | `gh pr checks` avec `--json name,state,bucket` permet le polling programmatique de l'etat CI. Option `--watch` disponible pour attente interactive | Haute |
| 2 | [gh pr merge - CLI manual](https://cli.github.com/manual/gh_pr_merge) | Documentation officielle | 2026-03-25 | `gh pr merge --auto` active l'auto-merge : GitHub merge automatiquement quand les checks requis passent. Requiert `allow_auto_merge` active sur le repo | Haute |
| 3 | [GitHub Webhooks Guide](https://www.magicbell.com/blog/github-webhooks-guide) | Article technique | 2026-03-25 | Webhooks (push-based) sont recommandes par GitHub vs polling. Event `check_suite` completed notifie quand tous les checks sont termines | Moyenne |
| 4 | [Using REST API to interact with checks](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks) | Documentation officielle | 2026-03-25 | API REST pour check runs/suites. Permet `gh api` pour verifier l'etat programmatiquement sans parsing text | Haute |
| 5 | [Support pr auto-merge - Issue #2619](https://github.com/cli/cli/issues/2619) | Issue GitHub CLI | 2026-03-25 | Discussion sur l'activation de l'auto-merge via CLI. `gh pr merge --auto` est la solution integree, mais necessite `allow_auto_merge: true` au niveau du repo | Moyenne |

### Synthese

Trois approches emergent pour controle CI + merge :

**1. Polling via `gh pr checks`** : C'est l'approche deja implementee dans `agent.ts` (`waitForCIChecks`). Poll toutes les 15s pendant 10min max. Robuste mais consomme des ressources et ajoute de la latence entre la fin CI et la notification.

**2. GitHub auto-merge (`gh pr merge --auto`)** : Le plus elegant — on declenche le merge une seule fois et GitHub attend automatiquement que les checks passent. Cependant, le repo a actuellement `allow_auto_merge: false` et il faudrait l'activer dans les settings GitHub.

**3. Webhooks GitHub (`check_suite` completed)** : Push-based, zero latence, mais necessite un endpoint HTTP expose (Supabase Edge Function ou route Express). Plus complexe a implementer et maintenir pour un benefice marginal dans ce contexte (le bot est mono-utilisateur).

La recommandation du milieu open-source est claire : pour un bot mono-utilisateur, le polling court est pragmatique. L'auto-merge GitHub est l'option la plus propre si on accepte de changer le setting du repo.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/agent.ts` L362-436 | `waitForCIChecks()` existe deja — poll `gh pr checks` toutes les 15s, 10min max. Retourne `{passed, details}`. Utilise `onProgress` callback | Reutilisable directement |
| 2 | `src/agent.ts` L254-264 | `AgentResult` inclut deja `ciPassed`, `ciDetails` — utilise par `executeTask` mais PAS par le pipeline SDD | Extension necessaire |
| 3 | `src/sdd-agents.ts` L310-358 | `runSddImplement()` lance Claude en worktree mais ne verifie PAS la CI apres creation de la PR. Retourne `SDD_IMPLEMENT_OK:` avec PR URL | Point d'injection CI |
| 4 | `src/job-manager.ts` L321-391 | `getCompletionKeyboard()` pour `sdd-implement` affiche [Review] + [Corriger] ; pour `sdd-review` APPROVED affiche [Voir la PR] + [Fusionner la PR]. Aucun controle CI | Point d'injection bouton |
| 5 | `src/commands/sdd-flow.ts` L294-367 | Handlers `merge_ask` / `merge_ok` / `merge_no` — le merge s'execute immediatement via `spawnSync gh pr merge --squash`. Pas de verification CI prealable | Gate CI a ajouter |
| 6 | `src/pipeline-tracker.ts` L38-47 | `PipelineStep` a un champ `prUrl` — pas de champ pour l'etat CI | Extension schema |
| 7 | `scripts/wait-ci.sh` | Script shell equivalent pour usage CLI. Non reutilisable en TypeScript mais confirme le pattern de polling | Reference |
| 8 | `.github/workflows/ci.yml` | CI a 2 jobs : `check` (typecheck, tests, coverage) et `e2e` (needs check). Le branch protection exige `check` uniquement | Seul `check` est bloquant |
| 9 | Repo settings via API | `allow_auto_merge: false`, `required_status_checks: [check]`, `strict: true` | Auto-merge non disponible sans changement settings |

### Points de friction

- **`runSddImplement` ne retourne pas l'etat CI** : l'agent Claude cree la PR (via `useWorktree: true` qui declenche le workflow interne de Claude Code), mais le code n'attend pas la CI. Le PR URL est extrait du stdout.
- **Delai CI** : la CI prend typiquement 3-5 minutes (typecheck + tests + coverage + E2E). Un polling de 15s pendant 10min est raisonnable.
- **`merge_ok` ne verifie pas la CI** : si on clique "Fusionner" avant que la CI soit verte, `gh pr merge` echoue car le branch protection l'empeche. L'erreur est affichee mais pas interpretee.

### Actifs reutilisables

- **`waitForCIChecks()` dans `agent.ts`** : fonction complete avec polling, timeout, progress callback. Exportable et reutilisable telle quelle.
- **`extractPrUrl()` / `extractPrNumber()`** : deja present dans `job-manager.ts` et `sdd-flow.ts`.
- **`PipelineStep.prUrl`** : tracking deja en place via `updateStep()`.
- **Pattern `onProgress` → `sendProgressMessage`** : le job-manager sait envoyer des messages de progression en cours de job.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Polling CI post-implement | C: Gate CI avant merge | D: Auto-merge GitHub |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** | S | M | S | S |
| **Valeur ajoutee** | Low | High | Med | High |
| **Risque technique** | Low | Low | Low | Low |
| *Impact maintenance* | Neutre | Faible (reutilise waitForCIChecks) | Negligeable | Negligeable (config GitHub) |
| *Reversibilite* | N/A | Haute (ajout non-breaking) | Haute | Haute (toggle settings) |

### Discussion par option

**A: Status quo** — Le merge peut echouer silencieusement si la CI n'est pas passee. L'utilisateur doit verifier manuellement sur GitHub avant de cliquer "Fusionner". Pas de feedback CI dans la conversation.

**B: Polling CI post-implement** — Apres que `runSddImplement` cree la PR, ajouter un appel a `waitForCIChecks()` (deja existant dans `agent.ts`). Le job-manager affiche un message de progression ("Attente CI..."), puis ajuste les boutons de completion selon le resultat CI : si CI verte, afficher [Fusionner la PR] ; si CI rouge, afficher [Voir les erreurs CI] + [Relancer]. Le champ `ciPassed` est ajoute au `PipelineStep`. Cout : ~100 LOC de glue code, aucune nouvelle dependance.

**C: Gate CI avant merge uniquement** — Ne pas poller apres implement, mais verifier la CI au moment du clic sur "Fusionner la PR" (`merge_ask` handler). Si CI non verte, afficher un message d'erreur au lieu de confirmer. Plus simple mais moins bon UX : l'utilisateur decouvre l'echec CI seulement au moment du merge.

**D: Auto-merge GitHub** — Activer `allow_auto_merge` sur le repo, puis dans `merge_ok` utiliser `gh pr merge --auto --squash`. GitHub attend automatiquement que la CI passe puis merge. Excellent UX, mais necessite un changement de settings GitHub et le bot perd le controle sur le timing (pas de notification Telegram quand le merge effectif a lieu, sauf si on ajoute un webhook).

### Option recommandee : B + C combinees

La meilleure approche est de combiner B (notification proactive du statut CI) et C (gate defensive avant merge) :
1. Apres implementation, poller la CI et notifier dans Telegram
2. Avant chaque merge, verifier que la CI est verte (defense en profondeur)
3. Ajuster les boutons inline selon l'etat CI

## Section 5 -- Verdict et justification

**Verdict : GO**

L'implementation est justifiee pour 3 raisons :

1. **Infrastructure existante** : `waitForCIChecks()` dans `agent.ts` est une fonction complete et testee qui fait exactement le polling necessaire. Il suffit de la reutiliser dans le contexte SDD. Le cout d'integration est faible (~100 LOC).

2. **Valeur utilisateur elevee** : Actuellement, un clic sur "Fusionner" peut echouer sans explication claire si la CI n'est pas encore passee. L'ajout du controle CI transforme le flow en experience guidee : l'utilisateur sait quand la CI passe, voit le bouton merge au bon moment, et ne peut pas merger prematurement.

3. **Risque technique quasi nul** : L'option B+C est purement additive — elle ne modifie aucun comportement existant, elle ajoute un controle supplementaire. Le branch protection reste le filet de securite final. La reversibilite est totale.

L'axe 1 (etat de l'art) confirme que le pattern polling est standard pour les bots mono-utilisateur. L'axe 2 (archeologie) montre que tous les building blocks sont deja en place. L'axe 3 (matrice) identifie B+C comme le meilleur rapport valeur/complexite.

## Section 6 -- Input pour etape suivante

### Option recommandee

**B+C : Polling CI post-implement + Gate CI avant merge**

### Fichiers concernes

1. **`src/sdd-agents.ts`** (`runSddImplement`) : ajouter appel `waitForCIChecks` apres extraction du PR URL, retourner l'etat CI dans le result string (ex: `SDD_IMPLEMENT_OK:name — prUrl [CI:PASS]` ou `SDD_IMPLEMENT_OK:name — prUrl [CI:FAIL:details]`)
2. **`src/job-manager.ts`** (`getCompletionKeyboard`) : parser l'etat CI du result pour ajuster les boutons post-implement. Si CI verte : [Review] + [Fusionner]. Si CI rouge : [Review] + [Voir CI] + [Relancer impl]
3. **`src/commands/sdd-flow.ts`** (`merge_ok` handler) : ajouter verification CI avant d'executer `gh pr merge`. Si CI non passee, afficher message explicatif + proposer d'attendre
4. **`src/pipeline-tracker.ts`** (`PipelineStep`) : ajouter champ optionnel `ciPassed?: boolean`
5. **`src/agent.ts`** : exporter `waitForCIChecks` (actuellement non exporte)

### Contraintes identifiees

- `waitForCIChecks` est actuellement une fonction privee dans `agent.ts` — il faut l'exporter
- Le timeout de 10min de `waitForCIChecks` doit rester coherent avec le timeout job-manager (2h)
- Le result string SDD est tronque a 500 chars dans job-manager — s'assurer que le format CI enrichi tient dans cette limite
- Le champ `PipelineStep.prUrl` est deja persiste — ajouter `ciPassed` dans le meme schema de persistence

### Questions ouvertes a resoudre pendant la spec

1. Faut-il proposer un bouton "Relancer la CI" (re-push force) en cas d'echec CI ? Ou seulement afficher l'erreur ?
2. Doit-on bloquer la review tant que la CI n'est pas passee, ou permettre la review en parallele (la CI prend 3-5min, la review aussi) ?
3. Format exact du result string enrichi : `[CI:PASS]` ou champ separe dans le result ?
4. Faut-il activer `allow_auto_merge` sur le repo en complement (option D) pour les cas edge ou le bot redemarrerait entre la verification CI et le merge ?
