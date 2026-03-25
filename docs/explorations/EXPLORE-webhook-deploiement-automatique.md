---
phase: 0-explore
generated_at: "2026-03-25T21:45:00+01:00"
subject: "Webhook deploiement automatique post-merge SDD"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Webhook deploiement automatique post-merge SDD

## Section 1 -- Probleme

Le pipeline SDD est desormais capable de boucler de bout en bout : exploration, spec, challenge, implementation, review, et enfin auto-merge (via `gh pr merge --auto --squash` dans `sdd-agents.ts` L499-519, controle par le feature flag `sdd_auto_merge`). Le deploiement est egalement automatise : `deploy.yml` se declenche sur tout push vers master et execute git pull, pm2 restart, smoke test avec auto-rollback en cas d'echec.

Cependant, ces deux mecanismes sont **deja couples** par design : quand le merge s'effectue sur master, GitHub declenche automatiquement le workflow `deploy.yml` via le trigger `on: push: branches: [master]`. Il n'y a pas de gap a combler entre le merge et le deploy -- le deploy.yml s'execute deja automatiquement.

La vraie question est donc : **quels gardes-fous supplementaires faut-il ajouter** pour s'assurer que le deploiement automatique post-merge SDD est fiable, observable et bloq able ? Trois preoccupations emergent :

1. **Observabilite** : Apres un auto-merge SDD, le bot Telegram ne sait pas que le deploy a eu lieu. Le `notify-deploy.sh` envoie une notification dans le topic "serveur", mais le pipeline SDD n'est pas informe du succes/echec du deploy.
2. **Feature flag `sdd_auto_deploy`** : Le feature flag demande n'existe pas. Actuellement, TOUT merge sur master declenche un deploy, qu'il vienne du pipeline SDD ou non. Un flag permettrait de bloquer selectivement les deploys post-auto-merge.
3. **Boucle de feedback** : Apres deploy, le pipeline SDD devrait pouvoir marquer la tache comme "deployed" et notifier dans le chat originel, fermant completement la boucle d'autonomie.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [GitHub Actions: push event trigger](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#push) | Documentation officielle | 2026-03-25 | Le trigger `on: push` se declenche automatiquement apres un merge PR (squash merge = push sur la branche cible). Aucun webhook supplementaire n'est necessaire. Le deploy.yml existant couvre deja ce cas | Haute |
| 2 | [GitHub Actions: workflow_run event](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#workflow_run) | Documentation officielle | 2026-03-25 | L'event `workflow_run` permet de chainer des workflows : un workflow peut se declencher quand un autre workflow termine. Pattern utile pour declencher une action post-deploy (ex: notification, validation) | Haute |
| 3 | [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments) | Documentation officielle | 2026-03-25 | L'API Deployments permet de creer des deployment status (pending, success, failure) lies a un commit. Integration optionnelle pour tracabilite dans l'onglet Deployments de GitHub | Moyenne |
| 4 | [PM2 deploy workflow patterns](https://pm2.keymetrics.io/docs/usage/deployment/) | Documentation officielle | 2026-03-25 | PM2 supporte un workflow deploy natif (pm2 deploy) mais le projet utilise deja un pattern custom (deploy.yml + pm2 restart). Le pattern existant est adapte au contexte self-hosted runner | Faible |

### Synthese

L'analyse de l'etat de l'art revele un constat fondamental : **le deploiement automatique post-merge est deja en place**. Le trigger `on: push: branches: [master]` dans `deploy.yml` assure que tout merge (y compris les auto-merges SDD) declenche automatiquement le pipeline git pull + pm2 restart + smoke test + auto-rollback.

Le vrai besoin est donc un **complement d'observabilite et de controle**, pas un nouveau mecanisme de deploiement. Trois patterns complementaires emergent :

1. **Post-deploy notification dans le pipeline SDD** : Apres que `deploy.yml` termine avec succes, envoyer une notification dans le chat SDD originel. Le mecanisme existe deja partiellement (`notify-deploy.sh` envoie dans le topic serveur) mais n'est pas connecte au pipeline SDD.

2. **Feature flag comme kill-switch** : Un flag `sdd_auto_deploy` qui, s'il est desactive, empeche le workflow deploy.yml de redemarrer les services. Ce n'est pas trivial car deploy.yml s'execute dans le contexte GitHub Actions, pas dans le bot. Options : (a) le workflow lit un fichier de config dans le repo, (b) le workflow verifie un label/tag sur le merge commit, (c) le feature flag est lu via un script au debut du workflow.

3. **Boucle de feedback post-deploy** : Utiliser le heartbeat (toutes les 10min) pour detecter qu'un deploy a eu lieu et mettre a jour le pipeline tracker.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `.github/workflows/deploy.yml` | Trigger `on: push: branches: [master]`. Steps: git pull, pm2 restart, smoke test, auto-rollback. Appelle `notify-deploy.sh` et `generate-checklist.ts`. Se declenche automatiquement apres tout merge, y compris auto-merge SDD | Deja fonctionnel |
| 2 | `.github/workflows/ci.yml` | Trigger `on: pull_request: branches: [master]`. 2 jobs: `check` (typecheck, tests, coverage) et `e2e`. Le check job est requis par branch protection. Le deploy.yml ne s'execute que si le merge a lieu, donc apres CI verte | Garde-fou existant |
| 3 | `scripts/notify-deploy.sh` | Envoie une notification Telegram dans le topic serveur (thread_id=7). Format: "Deploy OK (hostname) - timestamp / commit / Services redemarres" ou "Deploy ECHEC". N'est pas connecte au pipeline SDD | Point d'extension |
| 4 | `scripts/rollback.sh` | Rollback vers le commit precedent + pm2 restart + smoke test. Envoie notification Telegram en cas de rollback. Mecanisme de securite deja en place dans deploy.yml (step "Smoke test") | Garde-fou existant |
| 5 | `src/sdd-agents.ts` L499-519 | Auto-merge : si `sdd_auto_merge` est actif et review APPROVED, execute `gh pr merge --auto --squash --delete-branch`. Retourne `[AUTO-MERGE]` dans le tag result | Declencheur en amont |
| 6 | `src/job-manager.ts` L496-497 | Message post-review pour auto-merge : "auto-merge active — le merge sera effectue automatiquement quand la CI passera." Ne mentionne pas le deploy | Point d'extension |
| 7 | `src/job-manager.ts` L383-387 | Si `[AUTO-MERGE]` dans result, le bouton "Fusionner la PR" est supprime. Le pipeline sait que l'auto-merge est active | Etat connu |
| 8 | `config/features.json` | 8 flags dont `sdd_auto_merge: true` et `sdd_auto_advance: false`. Pas de flag `sdd_auto_deploy` | Ajout necessaire |
| 9 | `src/heartbeat.ts` | Pulse toutes les 10min. Detecte les nouveaux commits (`getGitDelta`), CI echouee (`getCIStatus`), PRs stale (`getOpenPRs`). Pourrait detecter un deploy recent et notifier le pipeline SDD | Point d'integration |
| 10 | `src/pipeline-tracker.ts` | Tracking par chat des etapes SDD. `PipelineStep` a `status`, `summary`, `prUrl`. Pas de champ `deployedAt` ou `deployStatus` | Extension schema |
| 11 | `src/sdd-auto-advance.ts` | Auto-avancement entre phases SDD. Map: review:APPROVED -> doc. Le deploy n'est pas une phase SDD formelle | Pas de changement |
| 12 | `scripts/smoke-test.ts` | 5 checks post-deploy : PM2, Dashboard, Supabase, Claude CLI, Telegram. Exit code 1 si echec -> deploy.yml rollback | Validation existante |
| 13 | `ecosystem.config.cjs` | PM2 config : relay, dashboard, heartbeat (cron 10min), system-alerts (cron 15min). deploy.yml ne redemarre que relay et dashboard | Coherent |

### Points de friction

- **deploy.yml s'execute dans GitHub Actions, pas dans le bot** : Le feature flag `sdd_auto_deploy` ne peut pas etre lu via `isFeatureEnabled()` depuis le workflow. Le workflow s'execute sur le self-hosted runner ou le fichier `config/features.json` est accessible localement, mais la lecture doit etre faite en bash (pas de TypeScript disponible directement dans un step shell).

- **Pas de lien entre deploy.yml et le pipeline SDD** : deploy.yml ne sait pas si le merge provient du pipeline SDD ou d'un merge manuel. Pour le feature flag, cela signifie que le flag doit bloquer tous les deploys (pas seulement les SDD) ou que le workflow doit distinguer l'origine du merge.

- **Delai de detection** : Le heartbeat pulse toutes les 10min. Si le deploy a lieu entre deux pulses, la notification dans le chat SDD peut arriver 10min apres le deploy. C'est acceptable pour un bot asynchrone.

- **deploy.yml ne restaure pas le heartbeat** : Le pm2 restart couvre relay et dashboard, mais pas heartbeat. C'est correct car heartbeat est cron-based (pas de keep-alive).

### Actifs reutilisables

- **`notify-deploy.sh`** : Envoie deja des notifications Telegram post-deploy. Peut etre etendu pour ecrire dans le fichier `mcp-pending-notifications.json` (pattern utilise par heartbeat).
- **`getGitDelta()` dans heartbeat.ts** : Detecte deja les nouveaux commits. Peut etre enrichi pour detecter un deploy recent.
- **`isFeatureEnabled()` / `config/features.json`** : Le fichier est sur le disque du runner self-hosted. Peut etre lu par deploy.yml via `jq` ou `node -e`.
- **`scripts/smoke-test.ts`** : Validation post-deploy complete (5 checks).
- **Pipeline tracker** (`getTracker`, `updateStep`) : Peut etre enrichi avec un champ `deployedAt`.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo (deploy.yml seul) | B: Feature flag + notification enrichie | C: Webhook callback post-deploy | D: Phase "deploy" dans le pipeline SDD |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** | S | S | M | L |
| **Valeur ajoutee** | Med | High | High | Med |
| **Risque technique** | Low | Low | Low | Med |
| *Impact maintenance* | Neutre | Faible (1 step deploy.yml + 1 flag) | Moyen (nouveau mecanisme callback) | Eleve (nouvelle phase SDD) |
| *Reversibilite* | N/A | Haute (feature flag + step conditionnel) | Haute (supprimer le step) | Moyenne (refactoring pipeline) |

### Discussion par option

**A: Status quo** — Le deploy automatique fonctionne deja : merge sur master -> deploy.yml -> pm2 restart -> smoke test -> rollback si echec. La notification `notify-deploy.sh` informe dans le topic serveur. Le manque est l'absence de feature flag pour bloquer et l'absence de notification dans le chat SDD originel. Pour un bot visant l'autonomie complete, c'est suffisant mais pas observable.

**B: Feature flag + notification enrichie** — Ajouter un feature flag `sdd_auto_deploy` dans `config/features.json`. Dans `deploy.yml`, ajouter un step conditionnel au debut qui lit le flag et skip le deploy si desactive. Enrichir `notify-deploy.sh` pour ecrire dans `mcp-pending-notifications.json` afin que le heartbeat puisse relayer l'info dans le chat SDD originel. Cout : ~30 LOC (1 step deploy.yml + modification notify-deploy.sh + 1 flag). C'est la solution la plus pragmatique : elle ajoute le controle demande et l'observabilite sans complexite inutile.

**C: Webhook callback post-deploy** — Apres le smoke test dans deploy.yml, ajouter un step qui appelle un endpoint du bot (ou ecrit dans Supabase) pour signaler le succes/echec du deploy. Le bot reagit en mettant a jour le pipeline tracker et en notifiant le chat SDD. Avantage : feedback quasi-immediat (pas d'attente heartbeat). Inconvenient : necessite un endpoint webhook dans le bot ou un mecanisme de callback (ecriture Supabase + polling). Plus complexe que B pour un gain marginal (10min vs quasi-immediat).

**D: Phase "deploy" dans le pipeline SDD** — Ajouter une 7e phase formelle au pipeline SDD (explore -> spec -> challenge -> implement -> review -> doc -> deploy). Le auto-advance de "doc" vers "deploy" lance un job qui attend le merge, attend le deploy, et verifie le smoke test. Inconvenient : le deploy n'est pas une phase "de maturation" mais une phase d'operations. Ajouter une phase alourdit le pipeline pour un cas qui est deja gere par l'infrastructure CI/CD. Melange des responsabilites.

## Section 5 -- Verdict et justification

**Verdict : GO**

L'option B (feature flag + notification enrichie) est recommandee pour 4 raisons :

1. **Le deploy automatique est deja en place** : L'analyse du codebase revele que `deploy.yml` se declenche deja sur tout push vers master, y compris les auto-merges SDD. Il n'y a pas de nouveau mecanisme de deploiement a creer. Le besoin reel est un complement de controle et d'observabilite, que l'option B couvre exactement.

2. **Complexite minimale** : L'option B requiert ~30 LOC de modifications : un step conditionnel dans deploy.yml (lecture du flag via `jq`), un ajout dans `notify-deploy.sh` (ecriture dans `mcp-pending-notifications.json`), et l'ajout du flag `sdd_auto_deploy` dans `config/features.json`. Tous les building blocks existent.

3. **Gardes-fous en profondeur** : Le feature flag `sdd_auto_deploy` ajoute un kill-switch instantane. La CI (branch protection + required checks) reste le premier filet de securite. Le smoke test dans deploy.yml reste le deuxieme filet. Le rollback automatique reste le troisieme filet. Le flag ajoute une 4e couche de controle humain.

4. **Coherence avec l'architecture existante** : Le pattern feature flag + `mcp-pending-notifications.json` + heartbeat est deja utilise pour les alertes, les anomalies LLM-Ops, et les audits. L'option B ne fait que reutiliser ce pattern eprouve pour le deploy.

L'option C (webhook callback) apporte un gain marginal (feedback immediat vs 10min) pour une complexite nettement superieure. L'option D (phase deploy SDD) melange operations et maturation. L'option B est le meilleur rapport valeur/complexite.

## Section 6 -- Input pour etape suivante

### Option recommandee

**B : Feature flag `sdd_auto_deploy` + notification enrichie post-deploy**

### Fichiers concernes

1. **`config/features.json`** : Ajouter `"sdd_auto_deploy": true`
2. **`.github/workflows/deploy.yml`** : Ajouter un step au debut qui lit `sdd_auto_deploy` dans `config/features.json` via `jq`. Si le flag est `false`, skip le deploy avec un message d'information et sortir en succes (pour ne pas bloquer le workflow)
3. **`scripts/notify-deploy.sh`** : Apres l'envoi Telegram, ecrire dans `~/.claude-relay/mcp-pending-notifications.json` avec le type `deploy_result`, le statut (success/failure) et le SHA du commit deploye. Le heartbeat relayera automatiquement la notification vers le chat
4. **`src/heartbeat.ts`** (optionnel, phase 2) : Si on veut enrichir la notification avec le lien vers le pipeline SDD originel, ajouter une logique dans le heartbeat qui correle le SHA deploye avec un pipeline tracker en cours

### Contraintes identifiees

- **Lecture du flag dans GitHub Actions** : `config/features.json` est un fichier local sur le runner self-hosted. La lecture se fait via `jq .sdd_auto_deploy config/features.json` dans un step bash. Si `jq` n'est pas installe, fallback sur `node -e "console.log(require('./config/features.json').sdd_auto_deploy)"` ou `bun -e`
- **deploy.yml ne doit pas echouer si le flag n'existe pas** : Si le fichier ou le flag est absent, le comportement par defaut doit etre de deployer (backward compatible). Le flag n'est un bloqueur que quand il est explicitement a `false`
- **Atomicite de `mcp-pending-notifications.json`** : Le fichier est ecrit par notify-deploy.sh (bash) et lu par le heartbeat (TypeScript). Le pattern write-to-tmp + mv est deja utilise dans heartbeat.ts. notify-deploy.sh doit utiliser le meme pattern
- **Pas de modification du pipeline SDD** : Le deploy n'est pas une phase SDD. Le feature flag controle le workflow deploy.yml directement, pas le pipeline SDD

### Questions ouvertes a resoudre pendant la spec

1. Si `sdd_auto_deploy` est false, deploy.yml doit-il tout de meme faire le `git pull` (pour avoir le code a jour sans redemarrer les services) ou tout skipper ?
2. Faut-il distinguer les merges SDD des merges manuels dans deploy.yml ? (Le flag bloque tout si false, ce qui est plus simple mais peut bloquer un hotfix manuel)
3. Le message de notification deploy doit-il inclure le lien vers la PR d'origine et le nom du pipeline SDD ?
4. Faut-il ajouter un champ `deployedAt` au pipeline tracker, ou la notification seule suffit-elle pour la tracabilite ?
5. Faut-il verifier la presence de `jq` dans le workflow et l'installer si absent, ou se contenter d'un fallback `bun -e` ?
