---
phase: 0-explore
generated_at: "2026-03-26T10:00:00Z"
subject: "Orphan recovery — pont heartbeat-SDD pour detection et remediation des pipelines bloques"
verdict: GO
next_step: "dev-spec"
---

# Orphan recovery — pont heartbeat-SDD pour detection et remediation des pipelines bloques

## Section 1 — Probleme

Le heartbeat (`src/heartbeat.ts`) tourne en PM2 cron toutes les 10 minutes. Il surveille git, CI, sprint, taches stales, PRs ouvertes, et peut notifier ou creer des taches. Cependant, il n'a **aucune connaissance de l'etat des pipelines SDD**.

Le pipeline SDD (`src/pipeline-tracker.ts`) persiste son etat dans `~/.claude-relay/pipelines.json` avec 7 phases (explore -> discuss -> spec -> challenge -> implement -> review -> doc). Chaque phase peut etre en status `pending`, `running`, `ok`, ou `failed`. Les jobs SDD tournent en arriere-plan via le job-manager (`src/job-manager.ts`) avec un timeout de 2 heures.

Le probleme : quand un pipeline SDD est bloque — agent crash sans timeout, phase `running` depuis >30 min sans progres, job-manager qui a perdu le contexte apres un restart PM2 — **personne ne le detecte**. L'utilisateur peut ne pas remarquer qu'un pipeline attend indefiniment. Les scenarios concrets :

1. **Agent crash silencieux** : `spawnClaude()` echoue mais le step reste en `running` dans pipelines.json (race condition entre job-manager et pipeline-tracker).
2. **Timeout non-detecte** : le job-manager a un timeout de 2h, mais si PM2 restart le relay avant, les jobs `running` sont marques `failed` dans jobs.json mais pipelines.json n'est pas mis a jour (processus differents).
3. **Phase stuck** : la phase `discuss` (conversationnelle) peut rester en `running` indefiniment si l'utilisateur oublie la conversation.
4. **Orphelin post-restart** : apres un restart du heartbeat ou du relay, les pipelines en cours ne sont pas re-evalues.

L'auto-avancement event-driven (`src/sdd-auto-advance.ts`) gere deja le **happy path** : quand un job termine avec succes, il tente d'avancer automatiquement. Cette exploration concerne uniquement le **watchdog pour les cas d'echec** — la detection et la remediation des pipelines orphelins ou bloques.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [HeartBeat Pattern — Martin Fowler](https://martinfowler.com/articles/patterns-of-distributed-systems/heartbeat.html) | Pattern catalogue | 2023 | Pattern heartbeat pour detection de pannes dans les systemes distribues. Timeout = multiple de l'intervalle de heartbeat. Eviter les faux positifs via buffering temporel. Remediation : reassignment des donnees du noeud defaillant | High |
| 2 | [Design a Distributed Job Scheduler — AlgoMaster](https://blog.algomaster.io/p/design-a-distributed-job-scheduler) | Article technique | 2025 | Patterns pour detection de jobs orphelins : query `status=running AND last_heartbeat < threshold`. Retry avec backoff exponentiel. Escalation : apres `max_retries`, dead-letter. Checkpointing pour jobs longs. Recommande de traquer chaque tentative d'execution separement | High |

**Synthese des enseignements cles :**

Le pattern heartbeat classique (Martin Fowler) s'applique directement a notre cas : le heartbeat PM2 (10 min) joue le role du moniteur, et les pipelines SDD jouent le role des noeuds surveilles. Le timeout de detection doit etre un multiple de l'intervalle : avec un heartbeat a 10 min, detecter un pipeline bloque apres 30 min (3x) est un seuil raisonnable qui evite les faux positifs.

L'article AlgoMaster apporte le pattern concret de detection d'orphelins : scanner la table (ou le fichier) des jobs pour ceux en `running` dont le `startedAt` depasse un seuil. C'est exactement ce que pipelines.json permet deja — chaque step a un champ `startedAt` optionnel. L'escalation recommandee (retry -> notification -> dead-letter/backlog) correspond bien aux actions que le heartbeat sait deja executer (`notify`, `task_create`).

Point cle des deux sources : la detection doit etre **idempotente**. Le heartbeat tourne toutes les 10 min — il ne doit pas re-notifier a chaque pulse pour le meme pipeline bloque. Le systeme de cooldowns existant dans `heartbeat-prompt.ts` repond deja a ce besoin.

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/heartbeat.ts` (747 LOC) | Service PM2 cron 10 min. Importe deja `readFile`, `join`, le pattern de collecte de delta. N'importe aucun module SDD. Actions : notify, task_create, none. Section "Periodic tasks" gated par timestamps dans HeartbeatState | High — point d'integration principal |
| 2 | `src/heartbeat-prompt.ts` (235 LOC) | Types HeartbeatState, HeartbeatDelta, HeartbeatAction. Pas de champ pour pipeline SDD. HeartbeatState a deja des champs `last*At` pour gater les taches periodiques (hourly, daily). Extensible | High — extension du state necessaire |
| 3 | `src/pipeline-tracker.ts` (365 LOC) | Source de verite pour l'etat SDD. Persistence dans `pipelines.json`. Chaque PipelineStep a : `phase`, `status`, `startedAt?`, `completedAt?`, `jobId?`. Le `startedAt` est set quand status passe a `running`. TTL 7 jours. Export `loadPipelines()` est private mais `getTracker()` et la Map interne sont accessibles | High — source de donnees a lire |
| 4 | `src/job-manager.ts` (782 LOC) | Jobs persistent dans `jobs.json`. Au chargement, les jobs `running`/`pending` sont marques `failed` avec error `"restart"`. Timeout job = 2h. Mais : la notification de completion (qui met a jour pipeline-tracker) ne se declenche pas pour les jobs marques `failed` au restart — c'est le trou dans la maille | Critical — source du probleme d'orphelins |
| 5 | `src/sdd-auto-advance.ts` (282 LOC) | Gere le happy-path : apres completion OK, tente d'avancer. Circuit breaker a 3 auto-avances max. Feature flag `sdd_auto_advance`. Ne gere PAS les cas d'echec ou de stuck | Medium — complementaire, pas de conflit |
| 6 | `src/notification-queue.ts` | Fonction `enqueue()` pour notifications via bot ou MCP bridge. Deja utilisee par heartbeat pour les alertes | Low — reutilisable tel quel |
| 7 | `src/sdd-task-sync.ts` (111 LOC) | Sync phase -> statut tache. Pas de logique de detection de stuck. Utile si remediation implique de mettre a jour le statut de la tache liee | Low — reutilisable |
| 8 | `src/alerts.ts` (570 LOC) | `checkStuckTasks()` detecte deja les taches Supabase en `in_progress` depuis >24h. Pattern directement transposable aux pipelines SDD | Medium — pattern a reproduire |
| 9 | `config/heartbeat-state.json` | State persiste du heartbeat. Extensible avec de nouveaux champs `last*At` | Low — modification triviale |

**Points de friction identifies :**

1. **Couplage heartbeat <-> pipeline-tracker** : le heartbeat est un processus PM2 isole. Il doit lire `pipelines.json` mais ne peut pas utiliser la Map in-memory de pipeline-tracker (processus different). Solution : lire directement le fichier JSON, comme le fait deja `loadPipelines()`.

2. **Desynchronisation jobs.json / pipelines.json** : quand PM2 restart le relay, job-manager marque les jobs comme `failed` dans jobs.json, mais ne met pas a jour pipelines.json (l'update se fait dans `sendJobCompletionNotification` qui n'est pas appelee pour les jobs marques failed au restart). C'est la source principale d'orphelins.

3. **Phase conversationnelle "discuss"** : cette phase est `running` tant que l'utilisateur n'a pas fini de discuter. Un timeout de 30 min serait un faux positif. Il faut un seuil different (24h ?) ou exclure cette phase du watchdog.

**Actifs reutilisables :**

- `HeartbeatState.cooldowns` : evite les notifications repetees
- `HeartbeatState.last*At` pattern : gate temporelle pour les taches periodiques
- `enqueue()` : notification immediate via bot
- `addTask()` : creation de taches backlog
- `checkStuckTasks()` pattern : query + seuil + alerte
- `readFile(pipelines.json)` : lecture directe sans import du module

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Watchdog heartbeat (lecture pipelines.json) | C: Watchdog dans le relay (in-process timer) | D: Recovery au restart uniquement |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | M | S |
| **Valeur ajoutee** (obligatoire) | Low | High | High | Med |
| **Risque technique** (obligatoire) | Low (dette) | Low | Med | Low |
| *Impact maintenance* | Negatif (dette invisible) | Faible (50-80 LOC) | Moyen (timer + cleanup) | Faible |
| *Reversibilite* | N/A | Haute (feature flag) | Moyenne | Haute |

**Option A — Status quo** : aucun changement. Les pipelines bloques restent invisibles. L'utilisateur doit verifier manuellement via `/jobs` ou constater l'absence de notification. La dette s'accumule car chaque restart PM2 peut laisser des pipelines orphelins sans remediation. Cout : 0. Risque : pipelines bloques silencieusement, perte de confiance dans le systeme autonome.

**Option B — Watchdog heartbeat** : le heartbeat (toutes les 10 min) lit `pipelines.json` directement, detecte les steps `running` depuis plus de N minutes (30 min pour agents, 24h pour `discuss`), et declenche une remediation graduee : (1) notification Telegram, (2) passage du step a `failed` dans pipelines.json, (3) creation d'une tache backlog si remediation echoue. Gate par un nouveau champ `lastPipelineWatchdogAt` dans HeartbeatState et feature flag `sdd_pipeline_watchdog`. Estimation : 50-80 LOC dans heartbeat.ts + 10 LOC dans heartbeat-prompt.ts. Avantage principal : le heartbeat est deja un processus de surveillance isole, c'est son role naturel. Pas de nouveau processus PM2.

**Option C — Watchdog in-process (relay)** : ajouter un `setInterval()` dans le relay (claude-relay PM2) qui scanne periodiquement les pipelines. Avantage : acces direct a la Map in-memory de pipeline-tracker, pas besoin de lire le fichier. Inconvenient : le relay est le processus qui peut crasher et causer les orphelins — le watchdog crasherait avec lui. De plus, le relay a deja beaucoup de responsabilites. Le heartbeat est specifiquement concu pour la surveillance externe.

**Option D — Recovery au restart uniquement** : au demarrage du relay, scanner pipelines.json et marquer comme `failed` tous les steps `running` (meme logique que job-manager pour jobs.json). Couvre le cas post-restart mais pas les timeouts en cours d'execution. Solution partielle qui ne detecte pas les agents qui tournent indefiniment sans terminer.

## Section 5 — Verdict et justification

**Verdict : GO**

L'option B (watchdog heartbeat) est clairement la meilleure approche :

1. **Fit architectural** : le heartbeat est concu exactement pour ce type de surveillance. Il tourne deja en processus isole (PM2 cron), lit deja des fichiers JSON (heartbeat-state.json, mcp-pending-notifications.json), et dispose du pattern de gate temporelle (`last*At`) et de cooldowns pour eviter les faux positifs. Ajouter la surveillance de pipelines.json est une extension naturelle de ses responsabilites.

2. **Faible complexite, haute valeur** : 50-80 LOC dans heartbeat.ts (une nouvelle fonction `checkSddPipelines()` calquee sur le pattern existant de `checkStuckTasks()`), 10 LOC dans heartbeat-prompt.ts (nouveau champ HeartbeatState), et un feature flag pour le rollback. Le ratio cout/benefice est excellent.

3. **Complementarite avec l'existant** : l'auto-avancement (`sdd-auto-advance.ts`) gere le happy-path, le watchdog gere les cas d'echec. Les deux mecanismes ne se chevauchent pas. L'option D (recovery au restart) pourrait etre ajoutee en complement mais ne suffit pas seule.

4. **Sources externes concordantes** : le pattern heartbeat (Fowler) et le pattern de detection d'orphelins (AlgoMaster) confirment que la surveillance periodique avec seuil temporel est l'approche standard pour ce type de probleme. Le seuil de 30 min (3x l'intervalle de 10 min) suit la recommandation de Fowler.

5. **Risque maitrise** : lecture seule de pipelines.json (pas de modification cross-processus risquee), notification via le canal existant (enqueue), et feature flag pour desactiver en cas de probleme.

## Section 6 — Input pour etape suivante

### Option recommandee : B — Watchdog heartbeat

### Fichiers concernes

- `src/heartbeat.ts` : ajouter `checkSddPipelines()` dans la section "Periodic tasks", gate par `lastPipelineWatchdogAt` (toutes les 10 min = chaque pulse)
- `src/heartbeat-prompt.ts` : ajouter `lastPipelineWatchdogAt: string | null` dans HeartbeatState et `createDefaultState()`
- `src/feature-flags.ts` : nouveau flag `sdd_pipeline_watchdog` (off par defaut)
- Tests : `tests/unit/heartbeat-sdd-watchdog.test.ts`

### Contraintes identifiees

1. **Seuils differencies par phase** : les phases agent (explore, spec, challenge, implement, review, doc) ont un seuil de 30-60 min. La phase `discuss` (conversationnelle) a un seuil beaucoup plus long (24h) ou est exclue du watchdog.
2. **Lecture fichier cross-processus** : le heartbeat et le relay sont des processus PM2 differents. La lecture de `pipelines.json` doit etre tolerante aux fichiers partiellement ecrits (atomic write via tmp+rename est deja en place dans pipeline-tracker).
3. **Idempotence** : utiliser le systeme de cooldowns existant du heartbeat pour ne pas re-notifier le meme pipeline bloque a chaque pulse.
4. **Pas de modification de pipelines.json par le heartbeat** : le heartbeat detecte et notifie, mais ne modifie pas pipelines.json (risque de conflit d'ecriture avec le relay). La remediation "marquer comme failed" est optionnelle (Phase 2).
5. **Remediation graduee** : Notification Telegram (toujours) -> creation tache backlog (si pipeline bloque depuis >2h, optionnel).

### Questions ouvertes a resoudre pendant la spec

1. Le heartbeat doit-il modifier pipelines.json pour marquer les steps comme `failed`, ou seulement notifier ? (risque de conflit d'ecriture cross-processus vs. necessite de nettoyer l'etat)
2. Faut-il ajouter l'option D (recovery au restart) en complement, dans le relay au demarrage ?
3. Le seuil de 30 min est-il suffisant pour la phase `implement` qui peut legitimement prendre 1-2h ?
4. Faut-il lire aussi `jobs.json` en complement de `pipelines.json` pour croiser les donnees (job failed + step still running = orphelin certain) ?
