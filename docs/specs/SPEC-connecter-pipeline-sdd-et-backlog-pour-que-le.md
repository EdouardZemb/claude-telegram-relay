# SPEC — Connecter pipeline SDD et backlog pour synchronisation automatique des statuts

**Nom :** connecter-pipeline-sdd-et-backlog-pour-que-le
**Date :** 2026-03-25
**Statut :** Implémenté (spec rédigée post-implémentation)

---

## 1. Objectif

Créer un lien bidirectionnel entre le pipeline SDD et le backlog de tâches, de sorte que le statut d'une tâche backlog reflète automatiquement la progression du pipeline SDD associé — sans intervention manuelle de l'utilisateur.

Chaque phase SDD complétée avec succès fait avancer la tâche liée vers le statut correspondant (in_progress → review → done), rendant le kanban cohérent avec l'avancement réel du développement.

---

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | `/explore <query>` crée automatiquement une tâche backlog avec le tag `sdd-pipeline` et le champ `sdd_pipeline_name` | `exploration.ts:93-99` | `/explore refactoring-mémoire` → tâche `[SDD] refactoring-mémoire` créée |
| R2 | `/explore <query> --task <id>` lie le pipeline à une tâche existante au lieu d'en créer une | `exploration.ts:54,79-89` | `/explore refactoring --task abc123` → tâche abc123 liée |
| R3 | Si la tâche `--task <id>` n'existe pas, le pipeline est créé sans lien (warning affiché) | `exploration.ts:86-89` | Tâche inconnue → `"Tâche introuvable. Pipeline sans lien de tâche."` |
| R4 | `PipelineTracker` stocke `taskId` optionnel (lien pipeline → tâche, UUID) | `pipeline-tracker.ts:53` | `tracker.taskId = "abc-123-def"` |
| R5 | `Task` stocke `sdd_pipeline_name` optionnel (lien tâche → pipeline, kebab-case) | `tasks.ts:45` | `task.sdd_pipeline_name = "refactoring-memoire"` |
| R6 | Mapping phases → statuts : explore/discuss/spec/challenge → `in_progress` | `sdd-task-sync.ts:26-33` | Phase `spec` OK → tâche passe à `in_progress` |
| R7 | Mapping phases → statuts : implement/review → `review` | `sdd-task-sync.ts:26-33` | Phase `implement` OK → tâche passe à `review` |
| R8 | Mapping phases → statuts : doc (ok) → `done` | `sdd-task-sync.ts:26-33` | Phase `doc` OK → tâche passe à `done` |
| R9 | Pas de downgrade : si la tâche est déjà à un statut plus avancé, la sync est ignorée | `sdd-task-sync.ts:83-95` | Tâche `review` + explore OK → pas de retour à `in_progress` |
| R10 | La sync se déclenche uniquement quand `stepStatus === "ok"` (phase réussie) | `sdd-task-sync.ts:60-63` | Phase `running` ou `failed` → pas de sync |
| R11 | La sync est best-effort : les erreurs sont loggées via `log.warn`, jamais propagées | `sdd-task-sync.ts:106-109` | Erreur Supabase → log.warn, pipeline continue |
| R12 | `/backlog` affiche le préfixe `[SDD]` devant le titre des tâches avec `sdd_pipeline_name` | `tasks.ts:251` | `P2 [SDD] refactoring-mémoire (S12)` |
| R13 | La sync via job-manager utilise une instance Supabase créée à la volée (lazy import) | `job-manager.ts:537-540` | Job completion → createClient lazy |
| R14 | Les tâches auto-créées reçoivent le tag `sdd-pipeline` | `exploration.ts:96` | `tags: ["sdd-pipeline"]` |

---

## 3. Données d'entrée

| Source | Type | Accès | Champs |
|--------|------|-------|--------|
| Commande Telegram | `/explore <query> [--task <id>]` | Message Telegram | `query: string`, `taskId?: string` |
| Pipeline tracker | `PipelineTracker` | `getTracker(chatId, threadId)` | `taskId?: string`, `name: string` |
| Phase SDD | Callback job-manager | Résultat job asynchrone | `phase: SddPhase`, `stepStatus: StepStatus` |
| Tâche existante | `Task` (Supabase) | `getTaskById(supabase, id)` | `id: string`, `status: Task["status"]` |
| Callback sdd_flow | `ctx.callbackQuery.data` | Telegram inline keyboard | `action: string` (ex: `discuss`) |

---

## 4. Données de sortie

**Tâche créée (R1, R14) :**
```
{
  title: "[SDD] <query>",
  description: "Pipeline SDD: <pipelineName>",
  tags: ["sdd-pipeline"],
  sdd_pipeline_name: "<pipelineName>",  // kebab-case
  status: "backlog"                      // initial
}
```

**Tracker créé (R4) :**
```
{
  chatId: <number>,
  threadId?: <number>,
  name: "<pipelineName>",
  taskId?: "<uuid>",   // lien vers la tâche backlog
  steps: { explore: pending, ... }
}
```

**Règles de remplissage :**
- `taskId` absent si création tâche échoue (best-effort)
- `sdd_pipeline_name` = `toPipelineName(query)` (kebab-case, max 48 chars)
- `formatBacklog` préfixe `[SDD] ` avant le titre si `sdd_pipeline_name != null`

---

## 5. Interface Telegram

### Messages `/explore`

```
Utilisateur: /explore refactoring mémoire

Bot: "Exploration SDD lancée: "refactoring-memoire" (job j-abc123)
Sujet: refactoring mémoire"
```

```
Utilisateur: /explore refactoring --task abc123

Bot: "Tâche "abc123" introuvable. Le pipeline sera créé sans lien de tâche."
     "Exploration SDD lancée: "refactoring" (job j-xyz)"
```

### Affichage `/backlog`

```
Backlog

-- En cours --
  P2 [SDD] refactoring-memoire (S12)  [abcd1234]
  P1 Fix bug urgent (S12)  [efgh5678]

-- A faire --
  P3 [SDD] nouvelle-feature  [ijkl9012]
```

Le préfixe `[SDD]` est positionné entre la priorité et le titre.

### Features Telegram évaluées

| Feature | Évaluation |
|---------|-----------|
| `setMyCommands` | N/A — `/explore` déjà dans le menu |
| `ReplyKeyboardMarkup` | N/A — keyboards inline suffisent |
| Message pinning | N/A — pas de message de référence à épingler |
| `editMessageText` | N/A — chaque notification est un message distinct |
| Reactions | N/A — pas de feedback léger nécessaire |

---

## 6. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/pipeline-tracker.ts` | Modifier | Ajout champ `taskId?: string` dans `PipelineTracker`, support dans `createPipeline(opts?)` |
| `src/tasks.ts` | Modifier | Ajout `sdd_pipeline_name: string \| null` dans `Task`, `addTask(opts.sdd_pipeline_name)`, `[SDD]` dans `formatBacklog` |
| `src/sdd-task-sync.ts` | Créer | `PHASE_TO_TASK_STATUS`, `syncTaskStatusForPhase()` — module dédié sync best-effort |
| `src/commands/exploration.ts` | Modifier | Auto-création tâche, `parseExploreArgs(--task)`, appel `syncTaskStatusForPhase` (path non-job-manager) |
| `src/commands/sdd-flow.ts` | Modifier | Import `syncTaskStatusForPhase`, appel dans callback `discuss` |
| `src/job-manager.ts` | Modifier | Appel `syncTaskStatusForPhase` dans `notifyJobCompletion` pour phases SDD |
| `db/schema.sql` | Modifier | Colonne `sdd_pipeline_name TEXT` dans la table `tasks` |
| `db/migrations/001_initial.sql` | Modifier | Même colonne pour migration SQL |
| `tests/unit/sdd-backlog-link.test.ts` | Créer | Tests V1-V14 couvrant les 14 critères de validation |

---

## 7. Patterns existants

**Pattern best-effort avec log.warn :**
```typescript
// sdd-task-sync.ts:106-109
} catch (error) {
  // Best-effort: log but don't throw
  log.warn("syncTaskStatus: error during sync", { taskId, phase, error: String(error) });
}
```
Même pattern utilisé dans `exploration.ts:105-110` pour la création de tâche.

**Pattern opts? extension sur fonction publique :**
```typescript
// pipeline-tracker.ts:160-165
export async function createPipeline(
  chatId: number,
  threadId: number | undefined,
  name: string,
  opts?: { taskId?: string },    // ← extension sans breaking change
): Promise<PipelineTracker>
```
Idem `addTask(supabase, title, opts?)` dans `tasks.ts:50`.

**Pattern ordre de progression de statuts :**
```typescript
// sdd-task-sync.ts:36
const STATUS_ORDER: Task["status"][] = ["backlog", "in_progress", "review", "done"];
// Anti-downgrade: currentIdx >= targetIdx → no-op
```

**Pattern lazy Supabase import (job-manager) :**
```typescript
// job-manager.ts:537-540 — évite la dépendance circulaire
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
```

---

## 8. Contraintes

- **Pas de downgrade** : le statut d'une tâche ne peut qu'avancer dans le cycle `backlog → in_progress → review → done`
- **Best-effort obligatoire** : `syncTaskStatusForPhase` ne doit jamais propager d'exception — un échec de sync ne doit pas bloquer le pipeline SDD
- **Cohérence bidirectionnelle** : les deux liens (`taskId` dans tracker, `sdd_pipeline_name` dans task) sont optionnels indépendamment — la feature dégrade gracieusement si Supabase est indisponible
- **Pas d'impact sur le flux pipeline** : la sync est appelée après les opérations principales, jamais avant
- **LOC threshold** : `sdd-task-sync.ts` doit rester sous 800 LOC (actuellement ~111 LOC)
- **Standard S1** : pas de `console.log` direct — uniquement `createLogger("sdd-task-sync")`
- **Standard S2** : pas de `process.env` direct — `getConfig()` si besoin de config (actuellement non nécessaire dans `sdd-task-sync.ts`)
- **Dépendances autorisées pour `sdd-task-sync.ts`** : `tasks.ts`, `pipeline-tracker.ts` (types only), `logger.ts`, `@supabase/supabase-js`

---

## 9. Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|--------------|--------|
| V1 | `PipelineTracker` a un champ `taskId` optionnel | `tracker.taskId` accepte `string \| undefined` en TypeScript | `unit` |
| V2 | `createPipeline` avec `opts.taskId` stocke le taskId dans le tracker | `tracker.taskId === "abc-123-def"` après `createPipeline(…, { taskId: "abc-123-def" })` | `unit` |
| V3 | Interface `Task` a un champ `sdd_pipeline_name: string \| null` | TypeScript compile sans erreur avec `task.sdd_pipeline_name` | `unit` |
| V4 | `addTask` avec `opts.sdd_pipeline_name` stocke la valeur | Mock Supabase: `task.sdd_pipeline_name === "my-pipeline"` après insert | `unit` |
| V5 | `formatBacklog` affiche `[SDD]` pour les tâches avec `sdd_pipeline_name` | La ligne contenant le titre SDD contient `[SDD]` | `unit` |
| V6 | Phases explore/discuss/spec/challenge mappent à `in_progress` | `PHASE_TO_TASK_STATUS.explore === "in_progress"` (et les 3 autres) | `unit` |
| V7 | Phases implement/review mappent à `review` | `PHASE_TO_TASK_STATUS.implement === "review"` | `unit` |
| V8 | Phase doc (ok) mappe à `done` | `PHASE_TO_TASK_STATUS.doc === "done"` | `unit` |
| V9 | `syncTaskStatusForPhase` est best-effort (pas de throw si taskId absent ou phase non-ok) | `await syncTaskStatusForPhase(supabase, undefined, "explore", "ok")` ne throw pas | `unit` |
| V10 | `getTaskById` retourne la tâche par UUID complet | Mock Supabase: `task !== null` pour UUID existant | `unit` |
| V11 | `taskId` persiste sur disque et survit au rechargement | `createPipeline` → `_clearForTests` → `getTracker` → `tracker.taskId` préservé | `unit` |
| V12 | Backward-compat : trackers sans `taskId` (avant migration) se chargent sans erreur | Tracker JSON sans `taskId` → `getTracker` retourne le tracker avec `taskId === undefined` | `unit` |
| V13 | `db/schema.sql` contient la colonne `sdd_pipeline_name` | `readFile("db/schema.sql")` contient `"sdd_pipeline_name"` | `unit` |
| V14 | Le préfixe `[SDD]` est positionné avant le titre dans `formatBacklog` | `indexOf("[SDD]") < indexOf("<title>")` dans la même ligne | `unit` |
| V15 | Pas de downgrade : une tâche déjà en `review` ne revient pas à `in_progress` | `syncTaskStatusForPhase(supabase, "t1", "explore", "ok")` → statut reste `review` | `unit` |
| V16 | Sync déclenchée uniquement sur `stepStatus === "ok"` | Phase `running` ou `failed` → statut tâche inchangé | `unit` |
| V17 | Auto-création tâche dans `/explore` sans `--task` | Mock Supabase: `addTask` appelé avec `sdd_pipeline_name = pipelineName` | `integration` |
| V18 | `--task <id>` existant lie sans créer | Mock Supabase: `addTask` NON appelé, `getTaskById` appelé | `integration` |

---

## 10. Coverage et zones d'ombre

### Matrice des dimensions

| Dimension | Couvert | Zones d'ombre |
|-----------|---------|---------------|
| **Problème** | Déconnexion entre pipeline SDD et kanban backlog — résolu par lien bidirectionnel automatique | Quid des pipelines créés via `sdd-flow.ts` (pas via `/explore`) ? Pas de création de tâche dans ce path |
| **Périmètre** | `/explore` + callbacks SDD + job completion | `sdd-flow.ts` ne crée pas de tâche si pipeline créé hors `/explore`. Seul `/explore` crée la tâche |
| **Validation** | 18 critères, tous testables en `unit` ou `integration` | Pas de test E2E pour le chemin complet `/explore` → job → completion → sync |
| **Technique** | Lazy import Supabase dans job-manager évite la dépendance circulaire | Gestion des erreurs réseau Supabase pendant la sync (couvert par best-effort) |
| **UX Telegram** | `[SDD]` dans `/backlog`, messages de confirmation dans `/explore` | Pas de notification Telegram quand le statut tâche est mis à jour automatiquement |

### Alternatives évaluées

| Alternative | Décision | Raison |
|-------------|----------|--------|
| Sync synchrone bloquant le pipeline | Rejetée | Un échec Supabase ne doit pas bloquer le pipeline SDD |
| Webhook Supabase pour sync inverse | Rejetée (hors scope) | Complexité disproportionnée — sync unidirectionnelle suffisante pour V1 |
| Tag unique par pipeline au lieu de colonne | Rejetée | Colonne SQL dédiée permet les requêtes indexées et les FK futures |
| Création tâche dans `sdd-flow.ts` aussi | Non décidé | Zones d'ombre : pipelines créés via buttons sans passer par `/explore` n'ont pas de tâche liée |

### Zones non résolues

- **Z1** : Si un pipeline est démarré via les boutons SDD sans passer par `/explore`, aucune tâche n'est créée. L'indicateur `[SDD]` n'apparaîtra donc pas dans `/backlog`.
- **Z2** : Pas de notification utilisateur quand le statut d'une tâche est mis à jour automatiquement (sync silencieuse). L'utilisateur doit vérifier `/backlog` pour voir l'avancement.
- **Z3** : La création de tâche Supabase est best-effort — si elle échoue, le pipeline continue sans lien et aucune rétroaction n'est donnée au-delà du log.warn.
