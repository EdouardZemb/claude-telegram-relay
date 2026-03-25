---
phase: 0-explore
generated_at: "2026-03-25T10:00:00Z"
subject: "Connecter pipeline SDD et backlog — lier un pipeline à une tâche"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

Le pipeline SDD (Spec-Driven Development) et le backlog de tâches coexistent dans le bot
sans être liés. Un utilisateur peut lancer `/explore <sujet>` ou cliquer sur les boutons
SDD inline, et en parallèle gérer ses tâches via `/task`, `/backlog`, `/sprint`. Ces deux
flux sont complètement orthogonaux : le pipeline tracker (disk JSON) et les tâches
(Supabase) ne se connaissent pas.

Le sujet de l'exploration est volontairement tronqué dans le nom (slug de 40 chars) mais
le sens est clair : **quand un pipeline SDD est lancé, une tâche devrait être créée dans le
backlog, et l'avancement du pipeline devrait se refléter dans le statut de la tâche**.

Concrètement, le problème se manifeste ainsi :
- L'utilisateur fait `/explore améliorer les notifications` → un tracker SDD est créé,
  mais le backlog ne bouge pas.
- L'utilisateur regarde `/backlog` → il ne voit pas les pipelines en cours.
- En fin de pipeline (phase `doc` terminée), la tâche devrait passer à `review` ou `done`
  automatiquement, mais rien ne se passe.

C'est un manque de cohésion entre les deux systèmes de suivi qui génère de la confusion
et oblige l'utilisateur à gérer manuellement les deux surfaces.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue | Docs | 2026-03-25 | GitHub lie automatiquement PR et issues via mots-clés (closes/fixes) dans les commits. L'issue passe à "closed" quand la PR est mergée. Pattern de référence croisée bien établi. | High |
| 2 | https://linear.app/docs/api/issues | Docs API | 2026-03-25 | Linear lie les issues aux cycles (sprints) et workflow states via des transitions automatiques déclenchées par des états externes (git branch, PR status). Transition state machine bidirectionnelle. | High |

**Synthèse :**

Le pattern dominant dans les outils modernes (GitHub Projects, Linear, Jira) est de lier
un "ticket/issue" à un "workflow d'implémentation" via une référence bidirectionnelle. La
transition d'état du ticket est déclenchée automatiquement par les événements du workflow.

Dans notre contexte, le ticket = `Task` (Supabase), le workflow = `PipelineTracker` (disk
JSON). Le lien peut se faire soit par un champ `pipeline_name` dans la tâche, soit par un
champ `task_id` dans le tracker, soit les deux.

L'approche Linear — task_id dans le tracker, pipeline_name dans la tâche — offre la
bidirectionnalité la plus propre et permet les requêtes dans les deux sens.

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/pipeline-tracker.ts` | `PipelineTracker` interface n'a pas de champ `taskId`. La fonction `createPipeline(chatId, threadId, name)` ne prend pas de taskId. | Moyen — ajout de champ optionnel dans l'interface |
| 2 | `src/tasks.ts` | `Task` interface n'a pas de champ `pipeline_name` ou `sdd_phase`. `addTask()` accepte des opts extensibles mais le schéma Supabase est fixe. | Moyen — migration SQL + update Task interface + addTask opts |
| 3 | `src/commands/exploration.ts` | `/explore` appelle `createPipeline()` puis `launchJob()`. C'est ici qu'une tâche devrait être créée et liée. Point d'entrée principal. | Haut — modification directe nécessaire |
| 4 | `src/commands/sdd-flow.ts` | Gère les callbacks `sdd_{phase}`. Appelle `updateStep()` sur phase transition. Pourrait déclencher `updateTaskStatus()` en parallèle. | Haut — point de synchronisation des états |
| 5 | `src/job-manager.ts` | `Job` a un champ `taskId?: string`. `getCompletionKeyboard()` génère déjà un bouton "Terminer la tâche" (`jc_done:taskId`) pour les jobs `exec`/`orchestrate`. Pattern existant et réutilisable. | Faible — pattern déjà là, extensible |
| 6 | `src/commands/tasks.ts` | Handler `/task` crée une tâche standalone. Si on crée une tâche auto depuis le pipeline, le format et les callbacks sont déjà définis. | Faible — réutilisation |
| 7 | `db/schema.sql` | Table `tasks` : pas de colonne `pipeline_name` ou `sdd_phase`. Migration SQL nécessaire pour ajouter ces champs. | Haut — migration Supabase |
| 8 | `src/sdd-agents.ts` | `runSddImplement` retourne `SDD_IMPLEMENT_OK: {name} — {prUrl}`. Phase `doc` retourne `SDD_DOC_OK`. Ces résultats pourraient déclencher des transitions de tâche. | Moyen — hook dans job-manager notification |

**Points de friction identifiés :**

1. **Migration Supabase nécessaire** : ajouter `sdd_pipeline_name TEXT` dans la table
   `tasks`. C'est un changement de schéma qui nécessite `db/schema.sql` + migration appliquée.

2. **PipelineTracker immuable sur disk** : `PipelineTracker` est sérialisé en JSON. Ajouter
   `taskId` est trivial mais il faut gérer la rétro-compatibilité (trackers existants sans
   ce champ).

3. **Création de tâche auto vs tâche existante** : doit-on toujours créer une nouvelle
   tâche, ou permettre de lier le pipeline à une tâche existante ? Les deux cas sont valides.

4. **Synchronisation des états** : le mapping phase SDD → statut tâche n'est pas trivial.
   `explore/discuss/spec/challenge` → `in_progress`, `implement` → `review`,
   `doc` → `done` est une heuristique raisonnable mais discutable.

**Actifs réutilisables :**

- `job-manager.ts` a déjà le concept de `taskId` dans un `Job`. Le bouton `jc_done:taskId`
  est déjà implémenté pour les jobs `exec`/`orchestrate`.
- `addTask()` est flexible avec ses opts. Ajouter `sdd_pipeline_name` est simple une fois
  le schéma étendu.
- `formatBacklog()` affiche déjà les tâches avec statut/priorité/sprint. Afficher le
  `pipeline_name` serait une extension cosmétique.

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: taskId dans tracker + migration SQL | C: Tags seuls (sans migration SQL) | D: Lien faible via tags + notification |
|---------|:------------:|:---------------------------------------:|:------------------------------------:|:--------------------------------------:|
| **Complexité** (obligatoire) | S | M | S | S |
| **Valeur ajoutée** (obligatoire) | Low | High | Med | Low |
| **Risque technique** (obligatoire) | Low | Med | Low | Low |
| *Impact maintenance* (si pertinent) | Nulle | Tracking centralisé | Fragile | Faible |
| *Réversibilité* (si pertinent) | — | Migration SQL difficile à annuler | Triviale | Triviale |

**Option A — Status quo :**
Aucun lien entre pipeline et tâches. Les deux systèmes restent indépendants. L'utilisateur
doit gérer manuellement. La confusion persiste mais aucun risque introduit.

**Option B — taskId dans PipelineTracker + colonne sdd_pipeline_name dans tasks :**
C'est le lien bidirectionnel complet. À la création du pipeline (`/explore`), une tâche est
créée automatiquement et son `id` est stocké dans le tracker. Le champ `sdd_pipeline_name`
dans la tâche permet de retrouver le tracker depuis la tâche. Les transitions de phase SDD
mettent à jour le statut de la tâche (heuristique phase → statut). C'est la solution la
plus cohérente mais elle nécessite une migration Supabase.

**Option C — Tags seuls (`["sdd-pipeline:nom"]`) sans migration SQL :**
Pas de champ `sdd_pipeline_name`. La tâche est créée avec un tag `sdd-pipeline:{name}` qui
permet de la retrouver. Pas de migration. Fragile car les tags sont un champ libre TEXT[].
Permet quand même la visibilité dans `/backlog`. Pas de lien inverse (tracker → tâche).

**Option D — Lien faible via notification uniquement :**
Le pipeline n'est pas lié à une tâche existante mais envoie une notification quand les
phases importantes passent. L'utilisateur crée manuellement une tâche s'il le souhaite.
Valeur très faible car le problème original (visibilité dans le backlog) n'est pas résolu.

## Section 5 — Verdict et justification

**Verdict : GO — Option B recommandée**

Le besoin est réel et bien posé : la fragmentation entre le pipeline SDD et le backlog
force l'utilisateur à gérer deux surfaces de suivi sans lien visible. L'exploration
confirme que l'infrastructure technique pour ce lien est déjà presque en place :
`job-manager.ts` a déjà un champ `taskId` et un bouton "Terminer la tâche" pour d'autres
job types, et `addTask()` est extensible.

L'Option B est recommandée car elle apporte la valeur maximale (visibilité dans le backlog,
synchronisation automatique des statuts) avec un risque technique maîtrisable (migration
SQL mineure, rétro-compatibilité triviale avec le champ optionnel dans le tracker). La
migration Supabase est un champ TEXT nullable — annulable si nécessaire.

La synchronisation phase → statut est une heuristique simple et défendable :
- `explore/discuss/spec/challenge` → `in_progress` (travail en cours)
- `implement/review` → `review` (en attente de validation)
- `doc` (OK) → `done`

L'implémentation est localisée dans 3 fichiers principaux : `exploration.ts` (création
de tâche), `sdd-flow.ts` (synchronisation des statuts), `pipeline-tracker.ts` (ajout du
champ `taskId`).

## Section 6 — Input pour étape suivante

**Option recommandée :** Option B — taskId bidirectionnel avec migration SQL

**Fichiers concernés :**

- `db/schema.sql` — ajouter `sdd_pipeline_name TEXT` sur la table `tasks`
- `src/pipeline-tracker.ts` — ajouter `taskId?: string` dans `PipelineTracker` interface ; passer `taskId` optionnel à `createPipeline()`
- `src/tasks.ts` — ajouter `sdd_pipeline_name` dans `Task` interface et `addTask()` opts
- `src/commands/exploration.ts` — créer une tâche au lancement du pipeline et lier le tracker
- `src/commands/sdd-flow.ts` — au `updateStep()`, si tracker a `taskId`, appeler `updateTaskStatus()` selon la phase
- `src/commands/tasks.ts` — dans `/backlog`, afficher optionnellement le pipeline_name si présent

**Contraintes identifiées :**

1. Migration Supabase non destructive (champ nullable, pas de NOT NULL)
2. Rétro-compatibilité des trackers existants : `taskId` optionnel dans l'interface TypeScript
3. Éviter d'appeler `addTask()` si `supabase` n'est pas disponible dans `exploration.ts`
4. La synchronisation des statuts doit être "best-effort" (log.warn si taskId manquant, pas d'exception)
5. La tâche créée automatiquement doit avoir `tags: ["sdd-pipeline"]` pour faciliter le filtrage

**Questions ouvertes à résoudre pendant la spec :**

- Doit-on permettre de lier un pipeline à une tâche **existante** (ex: `/explore <sujet> --task <id>`) ?
- Doit-on créer la tâche avec le sprint actuel ou sans sprint ?
- Lors du `/backlog`, doit-on afficher le pipeline_name en clair ou juste un indicateur visuel (`[SDD]`) ?
- La tâche créée doit-elle être créée au démarrage du pipeline ou seulement après le premier GO (fin de explore) ?

## Verdict

GO
La connexion pipeline SDD — backlog est un manque de cohésion bien identifié avec une solution technique claire, des actifs réutilisables existants (taskId dans job-manager, addTask() extensible), et un impact localisé dans 4-5 fichiers. La migration SQL est mineure et réversible.
