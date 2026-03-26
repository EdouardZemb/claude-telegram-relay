---
phase: 0-explore
generated_at: "2026-03-25T20:04:00Z"
subject: "Monitoring qualite des fonctionnalites existantes"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Probleme

Le codebase dispose d'un ensemble heterogene de mecanismes de surveillance de la qualite: alertes reactives sur les taches, metriques de sprint post-hoc, monitoring technique en memoire volatile, et boucle de feedback SDD par overlays. Ces systemes existent mais sont fragmentes dans cinq modules differents (`alerts.ts`, `commands/quality.ts`, `llm-ops.ts`, `feedback-analyzer.ts`, `heartbeat.ts`), avec des lacunes significatives:

1. **Aucun monitoring fonctionnel par fonctionnalite**: les metriques existantes couvrent les taches et les sprints, pas les commandes individuelles du bot (`/docs`, `/explore`, `/metrics`, `/tasks`, etc.). Il est impossible de savoir quelle commande echoue le plus, quelle fonctionnalite est la plus lente ou la plus utilisee.

2. **Monitoring en memoire volatile**: les ring buffers pour les temps de reponse et les compteurs de spawn (`recordResponseTime`, `recordSpawnResult`, `recordModuleError`) sont reinitialises a chaque redemarrage PM2. Or les redemarrages frequents (signales dans `vigilance_post_s30.md`) effacent toute l'historique de monitoring.

3. **`recordSpawnResult` non appele en production**: la fonction est exportee dans `alerts.ts` et testee dans `monitoring.test.ts`, mais n'est jamais appelee dans `sdd-agents.ts` ni dans `agent.ts`. Le monitoring des echecs de spawn est donc vide en production.

4. **Boucle feedback SDD sans source de signaux reelle**: `runFeedbackLoop` appelle `deps.fetchSignals()` qui retourne `[]` en production (la dependency par defaut ne fait rien). Les overlays adaptatifs ne se creent jamais automatiquement.

L'exploration est necessaire avant de specifier car plusieurs directions sont possibles: enrichir le monitoring en memoire, persister les metriques dans Supabase, ou instrumenter les Composers grammY directement.

---

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://grafana.com/docs/grafana/latest/panels-visualizations/ | Doc officielle | 2026-03 | Tableau de bord avec series temporelles, alertes seuils, annotations | Med |
| 2 | https://opentelemetry.io/docs/concepts/observability-primer/ | Reference | 2026-03 | Trois piliers: logs, metriques, traces. Instrumentation au niveau middleware | High |
| 3 | https://www.datadoghq.com/blog/monitoring-101-collecting-data/ | Article | 2026-03 | Work metrics (throughput, error rate, latency) vs resource metrics | High |
| 4 | https://grammy.dev/plugins/transformer-throttler | Doc grammY | 2026-03 | Plugin middleware grammY: instrumentation possible via transformer pattern | High |
| 5 | https://docs.pmhq.io/guides/process-monitoring | Doc PM2 | 2026-03 | PM2 expose des metriques runtime, mais pas au niveau applicatif | Low |

**Synthese des enseignements:**

L'observabilite moderne distingue trois niveaux: **work metrics** (throughput, error rate, latency par operation), **resource metrics** (CPU, memoire) et **business metrics** (utilisation par feature). Le projet a deja les resource metrics (via `/status` avec `os` module) et les business metrics (via `sprint_metrics`), mais manque les work metrics au niveau commande.

Le pattern middleware est standard pour l'instrumentation: grammY supporte les middlewares Composer, ce qui permet d'intercepter toutes les commandes a un seul endroit sans modifier chaque handler. OpenTelemetry recommande de mesurer au point d'entree (Composer), pas dans la logique metier.

La persistance est critique: les metriques in-memory sont appropriees pour les alertes temps reel (seuils courts), mais les tendances historiques necessitent Supabase ou un fichier JSON atomique (pattern deja utilise par `pipeline-tracker.ts` et `heartbeat.ts`).

---

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/alerts.ts` (585 LOC) | Contient les ring buffers (`responseTimeBuffer`, `spawnCounters`, `moduleErrors`) + `formatMonitoringStats()`. Tous volatils. `recordSpawnResult` export mais jamais appelee en production. | High |
| 2 | `src/commands/quality.ts` (575 LOC) | Commandes `/metrics`, `/retro`, `/patterns`, `/alerts`, `/cost`. Metriques par sprint depuis `sprint_metrics` Supabase. Aucune metrique par commande. | High |
| 3 | `src/llm-ops.ts` (549 LOC) | Tracking cout LLM par agent dans `cost_tracking`. `getLlmOpsSnapshot()` pour `/monitor`. Circuit-breaker stub (toujours ok). | Med |
| 4 | `src/heartbeat.ts` (738 LOC) | Periodic tasks: alertes toutes les heures, archival memoire, check llm-ops toutes les 30min, feedback loop toutes les heures, audit quotidien. Point de consolidation des checks periodiques. | High |
| 5 | `src/feedback-analyzer.ts` (232 LOC) | Analyse les signaux d'echec agents, genere des overlays. `fetchSignals` retourne `[]` par defaut en prod. Patterns detectes seulement si signaux injectes (tests). | Med |
| 6 | `src/commands/zz-messages.ts` | Appelle `recordResponseTime(Date.now() - handlerStart)` aux lignes 359 et 412. Seul endroit ou les temps de reponse sont enregistres. | Med |
| 7 | `src/agent.ts` | `spawnClaude()` centralise, jamais appele `recordSpawnResult`. Gap de monitoring spawn. | High |
| 8 | `src/commands/help.ts` | Commande `/monitor`: affiche `formatMonitoringStats()` + `formatLlmOpsSnapshot()`. Interface existante exploitable. | Med |
| 9 | `src/pipeline-tracker.ts` (365 LOC) | Patron de persistance JSON atomique reutilisable (mkdir + writeFile + rename). Bon modele pour persister des metriques commandes. | Med |
| 10 | `src/feature-flags.ts` | Hot-reload JSON, pattern pour gate les nouvelles fonctionnalites de monitoring. | Low |
| 11 | `db/schema.sql` | Tables: `cost_tracking`, `sprint_metrics`, `workflow_logs`. Pas de table dediee aux metriques par commande. Extension possible sans migration destructive. | High |
| 12 | `tests/unit/monitoring.test.ts` | 38 tests couvrant les ring buffers. Tous verts. Base de test a etendre pour la persistance. | Med |

**Points de friction identifies:**

- `alerts.ts` est a 570 LOC et approche le seuil de 800 LOC. Ajouter la persistance ou d'autres compteurs pousserait vers un refactoring obligatoire.
- `heartbeat.ts` est deja a 738 LOC. Ajouter du code de flush de metriques le ferait depasser le seuil.
- `recordSpawnResult` n'est jamais appelee: corriger ce gap necessite de modifier `agent.ts` qui importe dans 8+ fichiers.
- La boucle feedback SDD depend d'une `fetchSignals` non implementee en prod — corriger ceci necessite soit Supabase (table `agent_events`/`gate_evaluations` existante), soit un fichier local.

**Actifs reutilisables:**

- Pattern persistence JSON atomique de `pipeline-tracker.ts` (mkdir + tmp + rename)
- Pattern injection de dependances de `feedback-analyzer.ts` (testabilite sans mock global)
- Ring buffers de `alerts.ts` (logique correcte, juste non persistee)
- `heartbeat.ts` comme orchestrateur de flush periodique

---

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Metriques par commande en memoire + flush JSON | C: Metriques par commande dans Supabase | D: Middleware grammY unifie |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | M | L | M |
| **Valeur ajoutee** (obligatoire) | Low | High | High | High |
| **Risque technique** (obligatoire) | Low | Low | Med | Med |
| *Impact maintenance* | Stagnation | Minimal (+1 module) | Modere (+migration) | Modere (middleware global) |
| *Reversibilite* | N/A | High (fichier JSON) | Low (schema DB) | Med (middleware debranchable via flag) |

**Discussion par option:**

**A — Status quo**: Les metriques actuelles (ring buffers volatils, `recordSpawnResult` non appelee, `fetchSignals` vide) donnent une observabilite illusoire. La valeur est quasi-nulle car les donnees disparaissent au redemarrage et ne couvrent pas les cas d'usage reels.

**B — Metriques par commande en memoire + flush JSON periodique**: Ajouter un compteur par commande (`commandStats: Map<string, {calls, errors, totalMs}>`) dans `alerts.ts`, flushe toutes les heures par le heartbeat vers un fichier JSON atomique (modele `pipeline-tracker.ts`). Corriger aussi `recordSpawnResult` dans `agent.ts`. Faible risque, haute valeur, entierement reversible. Nouvelle section dans `/monitor`. C'est l'option recommandee pour une premiere iteration.

**C — Supabase**: Persister les metriques par commande dans une nouvelle table `command_metrics`. Permet des requetes historiques, comparaisons inter-sprints, alertes Supabase. Mais necessite une migration schema, et le codebase evite les acces Supabase depuis les handlers synchrones chauds (latence). Mieux adapte a une V2 apres validation de la valeur.

**D — Middleware grammY unifie**: Ajouter un middleware Composer global dans `loader.ts` ou `relay.ts` qui intercepte toutes les commandes, mesure la latence, compte les erreurs, et alimente des compteurs. Elegant et DRY, mais necessite de comprendre le cycle de vie grammY (middlewares async, gestion des erreurs non propagees), et risque de casser le `commandGuard` existant si mal positionne.

---

## Section 5 — Verdict et justification

**GO — Option B: Metriques par commande en memoire + flush JSON**

Le codebase dispose deja de tous les composants necessaires (ring buffers, heartbeat periodique, pattern persistence JSON atomique, interface `/monitor`), mais ils sont incomplets ou mal connectes. L'option B comble les trois lacunes critiques identifiees (metriques par commande, persistance au redemarrage, `recordSpawnResult` non appelee) avec un risque minimal.

Les sources externes (OpenTelemetry, Datadog) confirment que les work metrics par operation (commande Telegram) sont le niveau d'observabilite manquant. Le fait que `recordSpawnResult` soit exportee mais jamais appelee en production est un bug de monitoring existant documentable et corrigeable sans risque.

La boucle feedback SDD (`fetchSignals` vide en prod) est un probleme connexe mais distinct: il est recommande de le traiter dans la meme spec car les deux problemes partagent le meme gap fondamental (donnees de qualite non collectees). Implementer `fetchSignals` depuis les logs Supabase existants (`workflow_logs`) est un changement minimal.

La complexite M est justifiee: il faut modifier 3-4 fichiers (`alerts.ts` ou nouveau module, `agent.ts`, `heartbeat.ts`, `commands/help.ts`), ajouter des tests, et maintenir en dessous du seuil LOC de 800.

---

## Section 6 — Input pour etape suivante

**Option recommandee**: B — Metriques par commande en memoire + flush JSON periodique

**Fichiers concernes:**
- `/home/edouard/claude-telegram-relay/src/alerts.ts` — ajouter `commandStats` Map, `recordCommandCall(cmd, ms, error)`, `getCommandStats()`, flush JSON. Attention: 570 LOC, risque de depasser 800 si on n'extrait pas les fonctions de monitoring dans un sous-module (`src/monitoring.ts`)
- `/home/edouard/claude-telegram-relay/src/agent.ts` — appeler `recordSpawnResult(role, success)` apres chaque `spawnClaude()`
- `/home/edouard/claude-telegram-relay/src/heartbeat.ts` — ajouter flush periodique des stats commandes (toutes les heures, pattern existant)
- `/home/edouard/claude-telegram-relay/src/commands/help.ts` — etendre `/monitor` avec section commandes
- `/home/edouard/claude-telegram-relay/src/feedback-analyzer.ts` — implementer `fetchSignals` depuis `workflow_logs` Supabase

**Contraintes identifiees:**
- LOC: `alerts.ts` a 570 LOC, `heartbeat.ts` a 738 LOC. Si l'ajout depasse 800 LOC dans l'un ou l'autre, extraire en sous-module (`src/monitoring.ts`)
- Standard S1: pas de `console`, utiliser `createLogger`
- Standard S2: pas de `process.env` direct, utiliser `getConfig()`
- Tests: couverture minimum 30% par fichier (standard S8)
- Le fichier JSON de persistance doit utiliser le pattern atomique (tmp + rename) de `pipeline-tracker.ts`
- Feature flag: gater la persistance par `monitoring_persist` (nouveau flag) pour rollback facile

**Questions ouvertes pour la spec:**
1. Granularite des metriques par commande: toutes les commandes ou seulement les commandes a risque elevé (`/explore`, `/docs`, `/task`, `/start`)?
2. Retention du fichier JSON: garder les 24 dernieres heures ou illimite?
3. Seuils d'alerte: quels seuils declenchent une alerte pour une commande (ex: error rate > 20%, p95 > 10s)?
4. `fetchSignals` de feedback-analyzer: lire depuis `workflow_logs` (table existante) ou creer une table `agent_events`?

## Verdict
GO
Trois lacunes critiques documentees (metriques par commande manquantes, persistance volatile, `recordSpawnResult` jamais appelee en production), solution claire avec faible risque via Option B, tous les composants reutilisables identifies dans le codebase.
