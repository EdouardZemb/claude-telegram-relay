---
phase: 0-explore
generated_at: "2026-03-25T18:30:00+01:00"
subject: "Auto-merge des PRs SDD quand CI vert et review approved"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Auto-merge des PRs SDD quand CI vert et review approved

## Section 1 -- Probleme

Le pipeline SDD du bot cree des PRs via `spawnClaude()` dans `agent.ts` (useWorktree), attend la CI via `gh pr checks`, et le reviewer agent approuve la PR via `gh pr review --approve`. Cependant, apres la phase review APPROVED, le merge reste bloque derriere un clic humain : le bouton "Fusionner la PR" (`sdd_merge_ask` dans `job-manager.ts` puis `sdd_merge_ok` dans `sdd-flow.ts`) necessite une interaction manuelle pour executer `gh pr merge --squash --delete-branch`.

Ce gap cree un goulet d'etranglement : le pipeline SDD est entierement automatise de l'exploration a la review, mais la derniere etape (merge) casse l'autonomie du bot. Pour un bot mono-utilisateur operant souvent en asynchrone (jobs lances la nuit, pendant des reunions), l'absence d'auto-merge signifie que les PRs validees restent ouvertes indefiniment jusqu'a ce que l'humain les remarque.

Le sujet est distinct de l'exploration precedente `EXPLORE-controle-ci-et-bouton-merge-post.md` qui couvrait le controle CI avant merge (gate defensive). Ici, l'objectif est de **fermer la boucle completement** : quand le pipeline SDD valide une PR (review APPROVED + CI verte), la merger automatiquement sans intervention humaine, tout en preservant les gardes-fous de securite.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [gh pr merge - CLI manual](https://cli.github.com/manual/gh_pr_merge) | Documentation officielle | 2026-03-25 | `gh pr merge --auto --squash` active l'auto-merge natif GitHub : la PR est mergee automatiquement quand tous les required status checks passent. Necessite `allow_auto_merge: true` sur le repo | Haute |
| 2 | [Automatically merging a pull request - GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) | Documentation officielle | 2026-03-25 | Guide complet auto-merge GitHub : requiert branch protection + status checks. Le merge est differe jusqu'a ce que toutes les conditions soient remplies. Peut etre active par le CLI ou l'API | Haute |
| 3 | [How to automatically merge trusted Pull Requests on GitHub](https://jhale.dev/posts/auto-merging-prs/) | Article technique | 2026-03-25 | Pattern pour auto-merge de PRs de confiance (Dependabot, bots). Recommande branch protection rules comme garde-fou principal + `allow_auto_merge` + restrictions sur qui peut activer l'auto-merge | Haute |
| 4 | [Managing auto-merge for pull requests in your repository - GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository) | Documentation officielle | 2026-03-25 | Procedures d'activation/desactivation de l'auto-merge au niveau repository. Toggle dans Settings > General > Pull Requests | Moyenne |
| 5 | [gh pr merge --auto behaviour - Issue #3514](https://github.com/cli/cli/issues/3514) | Issue GitHub CLI | 2026-03-25 | Discussion sur le comportement de `--auto` : il ne poll pas, il enregistre l'intention de merge aupres de GitHub qui l'execute quand les conditions sont remplies. Pas de notification retour au CLI | Moyenne |

### Synthese

Trois strategies emergent pour automatiser le merge :

**1. `gh pr merge --auto --squash` (natif GitHub)** : Le plus elegant. Une seule commande enregistre l'intention de merge. GitHub execute le merge automatiquement quand la CI passe. Avantages : zero polling, zero latence, delegue la responsabilite a GitHub. Inconvenient : necessite `allow_auto_merge: true` sur le repo (actuellement `false`) et ne produit pas de notification retour — le bot ne sait pas quand le merge effectif a lieu sans polling ou webhook.

**2. Polling CI + merge programmatique** : Apres la review APPROVED, lancer un job qui poll `gh pr checks` (reutilisant `waitForCIChecks` existant dans `agent.ts`), puis execute `gh pr merge --squash --delete-branch` quand la CI passe. Avantage : le bot controle le timing et peut notifier immediatement dans Telegram. Inconvenient : occupe un slot semaphore pendant 3-10 minutes de polling.

**3. GitHub Actions workflow trigger** : Creer un workflow `.github/workflows/auto-merge-sdd.yml` qui se declenche sur `check_suite` completed + merge si la PR a un label `sdd-auto-merge`. Avantage : push-based, pas de polling cote bot. Inconvenient : necessite un mecanisme de notification retour (webhook ou polling periodique) pour que le bot sache que le merge a eu lieu.

La recommandation de la communaute open-source est claire : pour un systeme automatise de confiance avec branch protection, l'option 1 (`--auto`) est la plus simple et la plus robuste. Le polling (option 2) est le fallback quand l'auto-merge n'est pas disponible.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/sdd-agents.ts` L406-488 | `runSddReview()` : si verdict APPROVED et prUrl fourni, appelle `gh pr review --approve`. Retourne `SDD_REVIEW_APPROVED: name`. C'est le point naturel pour declencher l'auto-merge apres l'approbation | Point d'injection auto-merge |
| 2 | `src/job-manager.ts` L487-501 | Post-completion pour `sdd-implement` : persiste `prUrl` dans le tracker via `updateStep`. Pattern reutilisable pour persister l'etat auto-merge | Reference pattern |
| 3 | `src/job-manager.ts` L504-549 | Post-completion pour jobs `sdd-*` : sync l'etat du step dans le pipeline tracker + sync la tache Supabase liee. C'est l'endroit ou le merge automatique pourrait etre declenche apres review completion | Point d'injection centralize |
| 4 | `src/commands/sdd-flow.ts` L334-375 | Handlers `merge_ask`/`merge_ok`/`merge_no` : le merge humain via bouton. Le `merge_ok` execute `gh pr merge --squash --delete-branch` directement. Ce code reste necessaire comme fallback manuel | Coexistence |
| 5 | `src/job-manager.ts` L364-392 | `getCompletionKeyboard()` pour review APPROVED : affiche [Voir la PR] + [Fusionner la PR]. Avec auto-merge, ces boutons doivent changer : [Voir la PR] + information "merge automatique en cours" ou "merge effectue" | Adaptation boutons |
| 6 | `src/agent.ts` L366-436 | `waitForCIChecks()` : fonction privee, poll `gh pr checks --json` toutes les 15s pendant 10min. Retourne `{passed, details}`. Utilise `onProgress` callback. Reutilisable si exportee | Infrastructure existante |
| 7 | `src/pipeline-tracker.ts` L38-47 | `PipelineStep` a `prUrl?: string` mais pas de champ pour l'etat auto-merge ou CI | Extension schema |
| 8 | `src/feature-flags.ts` | Feature flags file-based avec hot-reload. 6 flags actifs. Pattern ideal pour un flag `sdd_auto_merge` | Infrastructure existante |
| 9 | `config/features.json` | 6 flags actifs. Ajout d'un 7e flag `sdd_auto_merge` pour toggle l'auto-merge | Fichier de config |
| 10 | `.github/workflows/ci.yml` / `deploy.yml` | CI: 2 jobs (`check` requis, `e2e` depends). Deploy : `push` sur master declenche pull + pm2 restart + smoke test + auto-rollback. Le deploy se declenche automatiquement apres merge | Pipeline complet |
| 11 | Repo settings (API) | `allow_auto_merge: false`, `required_status_checks: [check]`, `strict: true`, `enforce_admins: false`, `required_pull_request_reviews: null` (pas de review requise par branch protection) | Config GitHub |
| 12 | `SPEC-controle-ci-et-bouton-merge-post.md` | Spec existante pour gate CI avant merge (option C). Non implementee. Complementaire a cette exploration | Travail prealable |

### Points de friction

- **`allow_auto_merge: false`** : Le repo n'a pas l'auto-merge GitHub active. Il faut l'activer via `gh api -X PATCH repos/EdouardZemb/claude-telegram-relay -f allow_auto_merge=true` ou dans les settings GitHub. C'est un changement de configuration one-shot, pas de code.
- **Pas de `required_pull_request_reviews`** : Le branch protection n'exige pas de reviews. L'approbation par le reviewer agent est volontaire, pas imposee par GitHub. Cela signifie que `gh pr merge --auto` pourrait merger des que la CI passe, AVANT la review agent si on l'active trop tot.
- **Notification retour** : `gh pr merge --auto` est fire-and-forget. Le bot ne recoit pas de callback quand le merge effectif a lieu. Pour notifier dans Telegram, il faudrait soit (a) poller `gh pr view --json state`, soit (b) ecouter le webhook `pull_request.closed`, soit (c) detecter le merge lors du prochain heartbeat.
- **PRs externes** : Si quelqu'un ouvre une PR manuellement (hors pipeline SDD), le bot ne doit PAS la merger automatiquement. Le guard doit verifier que la PR a ete creee par le pipeline SDD.
- **Slot semaphore** : Si on utilise le polling (option 2), un slot semaphore est occupe pendant 3-10min. Avec le semaphore max 3, cela reduit la capacite pour d'autres jobs.

### Actifs reutilisables

- **`waitForCIChecks()`** dans `agent.ts` : complete et testee, pattern de polling reutilisable si exportee
- **`extractPrUrl()` / `extractPrNumber()`** : presente dans `job-manager.ts` et `sdd-flow.ts`
- **`PipelineStep.prUrl`** : tracking deja en place
- **`isFeatureEnabled()`** : toggle instantane pour activer/desactiver l'auto-merge
- **Post-completion notification** dans `sendJobCompletionNotification()` : infrastructure de notification apres job completion
- **`SPEC-controle-ci-et-bouton-merge-post.md`** : gate CI avant merge, complementaire et implementable en parallele

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo (bouton humain) | B: Polling CI + merge programmatique | C: `gh pr merge --auto` natif | D: GitHub Actions auto-merge workflow |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** | S | M | S | M |
| **Valeur ajoutee** | Low | High | High | High |
| **Risque technique** | Low | Low | Low | Med |
| *Impact maintenance* | Neutre | Faible (reutilise code existant) | Negligeable (config GitHub) | Moyen (nouveau workflow + labels) |
| *Reversibilite* | N/A | Haute (feature flag) | Haute (toggle repo setting + feature flag) | Haute (desactiver workflow) |

### Discussion par option

**A: Status quo** — Le merge reste manuel via bouton Telegram. Le pipeline SDD s'arrete apres review APPROVED avec un bouton "Fusionner la PR". L'humain doit agir. Pour un bot concu pour l'autonomie, c'est un point de friction majeur qui casse le flow asynchrone.

**B: Polling CI + merge programmatique** — Apres que `runSddReview` retourne APPROVED, lancer un job qui (1) exporte et appelle `waitForCIChecks` pour attendre la CI verte, (2) execute `gh pr merge --squash --delete-branch`, (3) notifie dans Telegram. Le bot garde le controle total : il sait exactement quand le merge a lieu et peut notifier immediatement. Inconvenient : occupe un slot semaphore pendant le polling CI (~3-10min). Cout : ~80 LOC (nouvelle fonction `autoMergeSddPr` + integration dans job-manager post-completion + feature flag).

**C: `gh pr merge --auto` natif GitHub** — Apres review APPROVED, executer `gh pr merge --auto --squash --delete-branch`. GitHub attend que la CI passe et merge automatiquement. Zero polling, zero slot semaphore, fire-and-forget. Inconvenient : necessite `allow_auto_merge: true` sur le repo + le bot ne recoit pas de notification quand le merge effectif a lieu (il faudrait poller periodiquement ou utiliser le heartbeat pour detecter). Cout : ~40 LOC (ajout `--auto` dans `runSddReview` + feature flag + notification adaptee).

**D: GitHub Actions auto-merge workflow** — Creer un workflow qui se declenche sur `check_suite` completed et merge les PRs labelisees `sdd-auto-merge`. Avantage : push-based, pas de polling cote bot. Inconvenient : ajoute de la complexite (nouveau workflow, label management, notification retour vers Telegram). Plus adapte pour un repo multi-contributeur qu'un bot mono-utilisateur.

### Option recommandee : C + complement polling leger

La meilleure approche est l'option C (`gh pr merge --auto --squash`) avec un complement de detection du merge effectif :

1. Apres review APPROVED, executer `gh pr merge --auto --squash --delete-branch` (fire-and-forget)
2. Adapter les boutons post-review pour indiquer "auto-merge active" au lieu de "Fusionner la PR"
3. Detecter le merge effectif via un polling leger dans le heartbeat (toutes les 10min) ou lors de la prochaine interaction utilisateur
4. Feature flag `sdd_auto_merge` pour toggle instantane
5. Conserver le bouton "Fusionner" comme fallback si l'auto-merge est desactive ou echoue

Cette approche est preferee a B car elle ne bloque pas de slot semaphore et delegue la responsabilite du timing a GitHub (qui est plus fiable que notre polling pour ce cas d'usage).

## Section 5 -- Verdict et justification

**Verdict : GO**

L'implementation est justifiee pour 4 raisons :

1. **Valeur strategique elevee** : Le bot est concu comme un orchestrateur autonome (vision strategique documentee dans `vision_orchestrator.md`). L'auto-merge est la derniere piece manquante pour boucler le pipeline SDD de bout en bout : exploration -> spec -> challenge -> implement -> review -> merge -> deploy (le deploy est deja automatique via `deploy.yml` sur push master). Sans auto-merge, le bot n'est autonome qu'a 90%.

2. **Complexite minimale avec l'option C** : `gh pr merge --auto --squash` est une seule ligne de code supplementaire dans `runSddReview`. Le gros du travail est l'adaptation des boutons et la notification, qui sont des modifications incrementales dans le code existant (~40-60 LOC). Activer `allow_auto_merge` sur le repo est un changement de configuration one-shot.

3. **Gardes-fous en profondeur** : Le branch protection (`required_status_checks: [check]`, `strict: true`) reste le filet de securite. L'auto-merge ne peut pas bypasser la CI. Le feature flag `sdd_auto_merge` permet de desactiver instantanement. Seules les PRs du pipeline SDD (avec review APPROVED) declenchent l'auto-merge, pas les PRs externes.

4. **Infrastructure existante mature** : Le pipeline SDD est complet (tracker, jobs, notifications, boutons inline). La spec `SPEC-controle-ci-et-bouton-merge-post.md` (gate CI avant merge) est complementaire et peut etre implementee en parallele comme defense supplementaire. Les patterns de feature flags, post-completion hooks, et notification sont tous en place.

L'axe 1 (etat de l'art) confirme que `gh pr merge --auto` est le pattern standard pour les bots de confiance. L'axe 2 (archeologie) montre que le point d'injection est clair (`runSddReview` + `sendJobCompletionNotification`) et que tous les building blocks existent. L'axe 3 (matrice) identifie C comme le meilleur rapport valeur/complexite avec la meilleure utilisation des ressources (pas de slot semaphore bloque).

## Section 6 -- Input pour etape suivante

### Option recommandee

**C : `gh pr merge --auto --squash` natif GitHub + detection merge + feature flag**

### Fichiers concernes

1. **Configuration GitHub (one-shot)** : Activer `allow_auto_merge` sur le repo via `gh api -X PATCH repos/EdouardZemb/claude-telegram-relay -f allow_auto_merge=true`
2. **`config/features.json`** : Ajouter flag `"sdd_auto_merge": true`
3. **`src/sdd-agents.ts`** (`runSddReview`) : Apres `gh pr review --approve`, si feature flag actif, executer `gh pr merge --auto --squash --delete-branch`. Garder le verdict `SDD_REVIEW_APPROVED` inchange, ajouter `[AUTO-MERGE]` au result string
4. **`src/job-manager.ts`** (`getCompletionKeyboard`) : Si auto-merge active et review APPROVED, remplacer le bouton "Fusionner la PR" par un indicateur "Auto-merge active" (ou supprimer le bouton merge et garder seulement "Voir la PR")
5. **`src/job-manager.ts`** (`sendJobCompletionNotification`) : Adapter le message pour review APPROVED avec auto-merge : "Review approuvee. Auto-merge active, le merge sera effectue automatiquement quand la CI passera."
6. **`src/commands/sdd-flow.ts`** : Le handler `merge_ok` reste en place comme fallback pour le merge manuel (feature flag desactive ou auto-merge echoue)

### Contraintes identifiees

- **Guard PR SDD-only** : Ne pas activer l'auto-merge sur des PRs non creees par le pipeline SDD. Le guard naturel est que seul `runSddReview` appelle `gh pr merge --auto`, et cette fonction n'est appelee que par le pipeline SDD
- **Pas de `required_pull_request_reviews` dans branch protection** : L'auto-merge sera declenche des que la CI passe (pas besoin d'attendre une review GitHub). C'est correct car la review est geree par le pipeline SDD (verdict agent), pas par les branch protection rules
- **Notification du merge effectif** : Avec `--auto`, le bot ne sait pas quand le merge a lieu. Option A : poller `gh pr view --json state` dans le heartbeat. Option B : accepter le delai et laisser le deploy (qui se declenche sur push master) servir de signal indirect. Option C : ajouter un polling court (30s x 20 = 10min) dans un job dedie leger sans bloquer de slot semaphore
- **Echec auto-merge** : Si `gh pr merge --auto` echoue (repo setting, permission), le bot doit proposer le bouton "Fusionner" classique comme fallback
- **Coexistence avec la spec gate CI** : La spec `SPEC-controle-ci-et-bouton-merge-post.md` (gate CI dans `merge_ok`) est complementaire. Elle protege le merge manuel, l'auto-merge protege le flow automatique. Les deux peuvent coexister

### Questions ouvertes a resoudre pendant la spec

1. Faut-il confirmer le merge effectif dans Telegram ? Si oui, via heartbeat (10min de delai) ou job dedie (polling court) ?
2. Le message post-review doit-il offrir un bouton "Desactiver l'auto-merge" pour permettre un override ponctuel ?
3. Faut-il logger l'activation de l'auto-merge dans Supabase (`agent_events` ou `workflow_logs`) pour tracabilite ?
4. Si l'auto-merge echoue silencieusement (ex: conflit de merge detecte par GitHub), comment le bot le detecte-t-il et le signale-t-il ?
5. Faut-il implementer la spec gate CI (`SPEC-controle-ci-et-bouton-merge-post.md`) en prerequis ou en parallele ?
