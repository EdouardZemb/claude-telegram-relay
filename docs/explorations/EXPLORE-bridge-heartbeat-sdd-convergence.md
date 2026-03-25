---
phase: 0-explore
generated_at: "2026-03-25T14:30:00Z"
subject: "Bridge heartbeat → SDD : convergence detectee → auto-transition"
verdict: GO
next_step: "dev-spec"
---

# Bridge heartbeat → SDD : convergence detectee → auto-transition

## Section 1 — Probleme

Le systeme actuel comporte deux sous-systemes independants qui ne communiquent pas :

1. **Le Heartbeat** (`src/heartbeat.ts`) : service PM2 cron toutes les 10 minutes, surveille git, CI, sprint, taches stales, et peut notifier ou creer des taches. Il n'a aucune connaissance du pipeline SDD.

2. **Le pipeline SDD** (`src/pipeline-tracker.ts`, `src/commands/sdd-flow.ts`, `src/sdd-agents.ts`) : pipeline conversationnel a 7 phases (explore → discuss → spec → challenge → implement → review → doc) avec detection de convergence dans les reponses de Claude (`detectConvergenceInResponse`) et boutons inline pour avancer manuellement entre phases.

Le probleme concret : quand une phase SDD se termine avec succes (ex: explore → GO, review → APPROVED), la transition vers la phase suivante requiert une action manuelle de l'utilisateur (clic sur bouton inline). Il n'existe aucun mecanisme pour :
- Que le heartbeat detecte qu'un pipeline SDD attend une transition
- Qu'une convergence detectee declenche automatiquement la phase suivante
- Que le systeme auto-avance de maniere autonome quand les conditions sont reunies

Cette exploration est necessaire car la fonctionnalite touche a la frontiere entre deux sous-systemes critiques et implique des decisions architecturales sur le niveau d'autonomie souhaite.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Heartbeats vs Cron: Two Patterns for Scheduling Autonomous AI Work](https://dev.to/ryancwynar/heartbeats-vs-cron-two-patterns-for-scheduling-autonomous-ai-work-1l0) | Article technique | 2025 | Compare heartbeat (polling periodique avec contexte conversationnel) vs cron (execution isolee precise). Recommande un split : heartbeat pour actions internes, cron pour outputs publics | High |
| 2 | [Chorus Agent Harness — AI-DLC](https://github.com/Chorus-AIDLC/Chorus) | Framework open-source | 2025-2026 | Agent harness avec lifecycle hooks (SubagentStart, TeammateIdle, SubagentStop). Auto-avancement par resolution de dependances : les taches deviennent claimable quand les dependances upstream sont completees. Recuperation auto des taches orphelines | High |

**Synthese des enseignements cles :**

L'article Heartbeats vs Cron confirme que le pattern heartbeat est bien adapte pour des actions internes au systeme (comme l'auto-avancement de pipeline), tandis que les actions publiques (PR, merge) restent mieux gerees par des declencheurs explicites. La frontiere est claire : "si l'output reste entre moi et l'agent, heartbeat."

Le framework Chorus apporte un pattern directement applicable : l'auto-avancement par resolution de dependances. Quand une phase upstream complete avec succes, la phase downstream devient automatiquement "claimable". Cela correspond exactement a notre besoin : quand `explore` termine avec `GO`, `spec` (ou `discuss`) devrait devenir auto-declenchable.

Chorus montre aussi l'importance de la recuperation d'orphelins : si un pipeline SDD est bloque (agent crash, timeout), le heartbeat peut le detecter et le signaler. C'est un cas d'usage secondaire mais precieux.

Les deux sources convergent sur un point : la detection de convergence/completion doit etre separee de l'action de transition. Le heartbeat detecte et decide, mais l'execution de la transition peut etre immediate (auto-avance) ou differee (notification + bouton).

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/heartbeat.ts` (720 LOC) | Service autonome PM2 cron 10min. Collecte delta (git, sprint, CI, PRs, taches stales) puis spawn Claude pour decision. N'importe aucun module SDD. Actions limitees a : notify, task_create, none | High — point d'integration principal |
| 2 | `src/heartbeat-prompt.ts` (232 LOC) | Types HeartbeatState, HeartbeatDecision, HeartbeatDelta. Actions possibles : notify, task_create, none. Schema JSON pour Claude. Aucune notion de pipeline SDD dans le delta ni dans les actions | High — extension du schema necessaire |
| 3 | `src/pipeline-tracker.ts` (364 LOC) | Tracker SDD en memoire + persistence disque (pipelines.json). API : createPipeline, getTracker, updateStep, formatStatusBar. Phases : explore → discuss → spec → challenge → implement → review → doc. TTL 7 jours | High — source de verite pour l'etat SDD |
| 4 | `src/commands/sdd-flow.ts` (384 LOC) | Composer grammY pour callbacks inline sdd_*. `detectConvergenceInResponse()` : regex sur "Decisions:" dans la reponse Claude. `buildSddKeyboard()` : construit les boutons selon phase+verdict. Gere aussi merge_ask/merge_ok/merge_no | High — logique de transition existante |
| 5 | `src/commands/zz-messages.ts` (693 LOC) | Appelle `detectConvergenceInResponse` sur chaque reponse Claude (L282-294). Si convergence detectee ET tracker actif, affiche keyboard "discuss" | Medium — point d'integration convergence |
| 6 | `src/job-manager.ts` (748 LOC) | `getCompletionKeyboard()` : construit les boutons post-completion pour chaque phase SDD avec verdict. `sendJobCompletionNotification()` : met a jour le step tracker puis notifie. Deja fait le mapping phase → boutons suivants | High — logique de suggestion de transition |
| 7 | `src/sdd-agents.ts` (533 LOC) | Fonctions d'execution : runSddExplore, runSddSpec, runSddChallenge, runSddImplement, runSddReview, runSddDoc. Retournent des prefixes parseables : SDD_{PHASE}_{VERDICT} | Medium — interface stable |
| 8 | `src/sdd-task-sync.ts` (110 LOC) | Sync phase SDD → statut tache Supabase. Mapping clair : explore/discuss/spec/challenge → in_progress, implement/review → review, doc → done | Low — deja fonctionnel |
| 9 | `config/features.json` | Feature flags existants incluent `sdd_auto_merge` (precedent pour auto-actions SDD) et `heartbeat` (activable/desactivable) | Medium — pattern a reutiliser |
| 10 | `ecosystem.config.cjs` | Heartbeat configure en PM2 cron_restart */10, autorestart:false. Execute `bun run src/heartbeat.ts` | Low — pas de modification prevue |

**Points de friction identifies :**

- Le heartbeat n'importe aucun module SDD (`pipeline-tracker`, `sdd-flow`, `sdd-agents`). Ajouter ces imports creerait un couplage nouveau entre un service cron isole et le systeme conversationnel.
- Le heartbeat s'execute hors du processus bot (PM2 separe). Il n'a pas acces a `botInstance` pour envoyer des messages Telegram directement. Il ecrit dans `mcp-pending-notifications.json` pour le relay.
- L'action `HeartbeatDecision` ne supporte que 3 types : `notify`, `task_create`, `none`. Ajouter `sdd_advance` necessiterait d'etendre le schema et la logique d'execution.
- Le tracker pipeline est en memoire dans le processus relay, avec persistence disque. Le heartbeat (processus separe) devrait lire le fichier disque directement.

**Actifs reutilisables :**

- `pipeline-tracker.ts` expose `getTracker()` et `updateStep()` qui fonctionnent deja avec persistence disque
- `sdd-flow.ts::buildSddKeyboard()` fournit la logique de "quelle est la prochaine etape selon phase+verdict"
- `job-manager.ts` contient deja le mapping complet phase → verdict → boutons suivants dans `getCompletionKeyboard()`
- Le pattern `sdd_auto_merge` dans `config/features.json` est un precedent pour feature-flaguer des auto-actions SDD
- `detectConvergenceInResponse()` dans sdd-flow.ts est deja utilise dans zz-messages.ts et pourrait etre reutilise

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Heartbeat bridge (cron poll) | C: Event-driven dans relay (inline) | D: Hybride (convergence inline + heartbeat watchdog) |
|---------|:------------:|:-------------------------------:|:-----------------------------------:|:---------------------------------------------------:|
| **Complexite** (obligatoire) | S | M | M | L |
| **Valeur ajoutee** (obligatoire) | Low | High | High | High |
| **Risque technique** (obligatoire) | Low | Med | Low | Med |
| *Impact maintenance* | Nul | Augmente surface heartbeat (+50 LOC) | Modifie job-manager (+30 LOC) | Les deux (+80 LOC total) |
| *Reversibilite* | N/A | Feature flag → desactivable | Feature flag → desactivable | Feature flag → desactivable |

**Discussion des options :**

**A: Status quo** — L'utilisateur doit cliquer sur un bouton inline apres chaque phase SDD. Fonctionne, mais brise le flux autonome. La valeur ajoutee est nulle car le probleme persiste. Le risque est nul.

**B: Heartbeat bridge (cron poll)** — Le heartbeat (toutes les 10 min) lit `pipelines.json` depuis le disque, detecte les pipelines avec une phase terminee (status "ok") dont la phase suivante est encore "pending", et declenche une action. Deux sous-variantes :
- B1 (notification) : ecrit dans `mcp-pending-notifications.json` un rappel "Pipeline X attend la phase Y, voulez-vous avancer ?"
- B2 (auto-launch) : importe directement les fonctions de `sdd-agents.ts` et lance la phase suivante

B1 est safe (notification pure), B2 est plus autonome mais couple le heartbeat au systeme SDD. Le risque principal est le timing : 10 min de latence entre completion et detection. Un pipeline qui termine a t=0 ne sera auto-avance qu'a t+10min max.

**C: Event-driven dans relay (inline)** — Quand `sendJobCompletionNotification` dans `job-manager.ts` detecte un job SDD termine avec succes et un verdict "auto-advanceable" (GO, OK, APPROVED), il ne se contente pas d'afficher les boutons mais lance automatiquement la phase suivante via `sdd-flow.ts`. Cette approche est synchrone (latence zero), vit dans le processus relay (acces Telegram direct), et reutilise le code existant de `getCompletionKeyboard()` pour la logique de decision. Le flag `sdd_auto_advance` controle l'activation.

**D: Hybride** — Option C pour l'auto-avancement immediat (quand le relay est en ligne) + Option B1 pour le watchdog (quand un pipeline est bloque depuis >30min sans avancement, le heartbeat notifie). Combine latence zero et filet de securite, mais double la surface de code.

## Section 5 — Verdict et justification

**Verdict : GO**

L'option **C (event-driven dans relay)** est recommandee comme implementation principale, avec l'option B1 (heartbeat notification watchdog) comme extension future optionnelle.

Justification :

1. **L'archeologie codebase (Axe 2) montre que le point d'integration naturel est `job-manager.ts::sendJobCompletionNotification()`**, pas le heartbeat. Cette fonction detecte deja la completion des jobs SDD, parse le verdict, met a jour le tracker, et construit les boutons de transition. Ajouter l'auto-avancement ici est une extension naturelle de ~30 LOC, pas un changement architectural.

2. **L'etat de l'art (Axe 1) confirme la separation detection/action** : la detection de completion (deja en place via `SDD_{PHASE}_{VERDICT}` parsing) est distincte de l'action de transition. Le pattern Chorus "auto-claimable quand upstream complete" correspond exactement a l'option C.

3. **Le heartbeat (option B) introduirait un couplage inter-processus inutile** pour un cas d'usage qui a une solution plus simple et plus reactive dans le processus relay. Le heartbeat devrait lire `pipelines.json` (format interne du relay), importer des modules SDD, et subir 0-10 min de latence. L'article "Heartbeats vs Cron" recommande le heartbeat pour les actions internes periodiques, pas pour les reactions immediates a des evenements.

4. **Le precedent `sdd_auto_merge`** dans le codebase montre que les auto-actions SDD controlees par feature flag sont un pattern accepte et eprouve.

5. **Le risque est faible** car l'option C reutilise integralement l'infrastructure existante (job-manager, pipeline-tracker, sdd-agents) sans ajouter de nouvelle dependance. Le feature flag `sdd_auto_advance` permet un rollback instantane.

## Section 6 — Input pour etape suivante

### Input pour spec

**Option recommandee :** C — Event-driven auto-avancement dans `job-manager.ts`

**Fichiers concernes :**
- `src/job-manager.ts` : modifier `sendJobCompletionNotification()` pour auto-lancer la phase suivante quand les conditions sont reunies
- `src/commands/sdd-flow.ts` : extraire la logique de "quelle phase suivante" dans une fonction reutilisable (ex: `getNextPhase(phase, verdict)`)
- `config/features.json` : ajouter le flag `sdd_auto_advance`
- `src/heartbeat-prompt.ts` (optionnel, extension future) : ajouter `activePipelines` au delta pour visibilite

**Contraintes identifiees :**
1. **Verdicts auto-advancables** : seuls certains verdicts declenchent l'auto-avancement. Proposition :
   - explore → GO : auto-avance vers `discuss` (pas directement `spec`, la discussion est precieuse)
   - spec → OK : auto-avance vers `challenge`
   - challenge → GO : auto-avance vers `implement`
   - challenge → GO_WITH_CHANGES : PAS d'auto-avancement (l'utilisateur doit decider)
   - implement → OK : auto-avance vers `review`
   - review → APPROVED : auto-avance vers `doc`
   - review → CHANGES_REQUESTED : PAS d'auto-avancement
   - doc → OK : pipeline termine, pas de suite

2. **Feature flag `sdd_auto_advance`** : active par defaut (false initialement), controlable via `/feature enable sdd_auto_advance`

3. **Message de notification** : quand l'auto-avancement se declenche, envoyer un message Telegram explicatif : "Auto-avancement : phase {next} lancee suite au verdict {verdict} de la phase {current}. [Annuler]"

4. **Bouton Annuler** : permettre d'annuler un auto-avancement dans les 30 premieres secondes (cancel du job manager)

5. **Limite de profondeur** : ne pas auto-avancer plus de 3 phases consecutives sans interaction utilisateur (circuit breaker anti-boucle)

**Questions ouvertes a resoudre pendant la spec :**
- Faut-il auto-avancer explore → discuss ou explore → spec directement ?
- Le heartbeat watchdog (option B1) est-il necessaire des la v1 ou est-ce une extension v2 ?
- Comment gerer le cas ou l'auto-avancement echoue (retry ? notification ? rollback du step status ?)
