# Challenge Adversarial — SPEC-connecter-pipeline-sdd-et-backlog-pour-que-le.md

Verdict global: GO_WITH_CHANGES
Agents: 3/3 reussis

---

## Devil's Advocate — Rapport

J'ai tous les éléments. Je produis le rapport.

---

## Devil's Advocate — Rapport

### Findings

---

**[BLOQUANT] F-DA-1 — Statut `cancelled` absent de `STATUS_ORDER` : sync peut dés-annuler une tâche**

- **Source :** R9 (spec §2) + `sdd-task-sync.ts:36` + `tasks.ts:30`
- **Description :** `STATUS_ORDER = ["backlog", "in_progress", "review", "done"]` ne contient pas `"cancelled"`. Or `Task["status"]` inclut `"cancelled"` (tasks.ts:30). Si une tâche liée est annulée puis qu'une phase SDD se complète, `STATUS_ORDER.indexOf("cancelled")` retourne `-1`. La condition anti-downgrade `currentIdx >= targetIdx` devient `-1 >= 0` = `false` → `updateTaskStatus` est appelé, réactivant silencieusement la tâche annulée.
- **Impact :** Un pipeline SDD actif lié à une tâche annulée la remet en `in_progress`/`review`/`done` sans que l'utilisateur en soit informé. Violation de R9 ("Pas de downgrade") pour ce cas limite.
- **Evidence :** `sdd-task-sync.ts:83-95` — la guard ne gère que les statuts connus de `STATUS_ORDER`; `tasks.ts:30` confirme `"cancelled"` comme valeur valide du type.

---

**[MAJEUR] F-DA-2 — Phase `discuss` marquée `ok` à l'instant du clic bouton, sans aucune discussion réelle**

- **Source :** R10 (spec §2) + `sdd-flow.ts:222` (grep résultat, bloc `case "discuss"`)
- **Description :** R10 stipule que "La sync se déclenche uniquement quand `stepStatus === "ok"` (phase réussie)" avec l'exemple "Phase `running` ou `failed` → pas de sync". Pour `discuss`, la phase passe directement de `pending` à `ok` au moment du clic sur le bouton, sans phase `running`, sans job lancé, sans validation de contenu. La spec justifie R10 avec l'exemple d'une "phase running" qui n'existe jamais pour `discuss`. Le label "réussie" est donc vidé de sens pour cette phase.
- **Impact :** Une tâche backlog peut passer à `in_progress` simplement parce que l'utilisateur a cliqué "Discuter sans explorer", avant même d'avoir tapé un seul message. La sémantique de progression du kanban est corrompue.
- **Evidence :** `sdd-flow.ts:222` : `updateStep(chatId, threadId, "discuss", { status: "ok" })` + `syncTaskStatusForPhase(..., "discuss", "ok")` dans le même bloc immédiat, sans validation de contenu.

---

**[MAJEUR] F-DA-3 — Absence totale de feedback utilisateur sur la création automatique de tâche**

- **Source :** R1 (spec §2) + §5 "Messages `/explore`" + Z3 (spec §10)
- **Description :** R1 spécifie que `/explore <query>` crée automatiquement une tâche backlog. La section 5 montre le message de confirmation ("Exploration SDD lancée: …") mais ne mentionne **aucune confirmation** de la création de la tâche. En cas de succès, `exploration.ts:100-103` appelle seulement `log.info(...)` — aucun `ctx.reply`. L'utilisateur ne sait pas qu'une tâche a été créée dans son backlog. Z3 reconnaît le cas d'échec silencieux mais ignore le cas de succès silencieux.
- **Impact :** L'utilisateur découvrira la tâche par accident via `/backlog`. Contradiction avec l'objectif §1 qui dit "rendant le kanban cohérent avec l'avancement réel" — une cohérence invisible n'est pas une cohérence utilisable. Z2 reconnaît l'absence de notification sur les mises à jour de statut mais pas sur la création initiale.
- **Evidence :** `exploration.ts:113-128` — `createPipeline(...)` puis `ctx.reply("Exploration SDD lancée: ...")` sans mention de la tâche créée.

---

**[MAJEUR] F-DA-4 — V10 : contrat documenté ambigu entre "UUID complet" (spec) et "id prefix" (test)**

- **Source :** V10 (spec §9) + `tests/unit/sdd-backlog-link.test.ts:14`
- **Description :** La spec V10 dit "retourne la tâche par UUID complet" et le critère de vérification dit `task !== null` pour UUID existant. Or le commentaire d'en-tête du fichier test (ligne 14) dit explicitement `"V10: getTaskById returns task by id prefix"`. Le test réel (lignes 291-309) utilise bien un UUID complet — mais l'en-tête contredit la spec et introduit une ambiguïté : `getTaskById` est-il censé aussi fonctionner avec un préfixe (comme dans `/done <8chars>`) ?
- **Impact :** Si un futur développeur implémente ou teste `getTaskById` avec un préfixe de 8 chars (pattern courant dans le reste du code, cf. `t.id.substring(0, 8)` dans `formatBacklog`), il sera guidé par l'en-tête du test vers un comportement non supporté par l'implémentation Supabase (`.eq("id", taskId)` ne fait pas de recherche par préfixe).

---

**[MINEUR] F-DA-5 — Code pattern §7 incomplet : `getConfig` lazy import omis**

- **Source :** §7 "Pattern lazy Supabase import" (spec lignes 174-178)
- **Description :** Le code example du pattern montre :
  ```typescript
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  ```
  mais `config` n'est pas défini — l'import réel (`job-manager.ts:537-540`) fait d'abord `const { getConfig } = await import("./config.ts")`. L'exemple est silencieusement non-compilable tel quel.
- **Impact :** Mineur — ne bloque pas l'implémentation (déjà faite), mais induit en erreur si quelqu'un copie ce pattern pour une autre intégration.

---

**[MINEUR] F-DA-6 — "Lien bidirectionnel" (§1) : terminologie trompeuse par rapport au comportement réel**

- **Source :** §1 Objectif + §10 alternatives évaluées
- **Description :** Le titre et §1 qualifient la feature de "lien bidirectionnel". En réalité : (a) la sync est strictement unidirectionnelle (pipeline → task), (b) le "lien inverse" (task → pipeline via `sdd_pipeline_name`) n'est jamais exploité programmatiquement — c'est uniquement un affichage visuel dans `/backlog`. La §10 confirme que "Webhook Supabase pour sync inverse" est rejeté. Le terme "bidirectionnel" décrit les pointeurs de données (deux objets se référençant mutuellement), non le comportement de sync.
- **Impact :** Risque de sur-expectation : un lecteur de la spec pourrait s'attendre à ce qu'une modification manuelle de statut dans le backlog impacte le pipeline, ce qui n'est pas le cas.

---

### Statistiques

- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Verdict de l'agent: GO_WITH_CHANGES

**Justification :** L'implémentation est fonctionnelle et cohérente sur les cas principaux. Deux corrections sont nécessaires avant mise en production : (1) ajouter `"cancelled"` dans `STATUS_ORDER` avec un guard explicite (F-DA-1, risque de régression silencieuse), (2) ajouter un `ctx.reply` confirmant la création automatique de tâche dans `/explore` (F-DA-3, UX manquante non documentée comme choix volontaire). F-DA-2 mérite discussion : le comportement `discuss` → `ok` immédiat est possiblement intentionnel mais doit être documenté explicitement comme exception au modèle "phase réussie = job complété".

---

## Edge Case Hunter — Rapport

## Edge Case Hunter — Rapport

**Spec :** `SPEC-connecter-pipeline-sdd-et-backlog-pour-que-le.md`
**Code analysé :** `sdd-task-sync.ts`, `exploration.ts`, `sdd-flow.ts`, `job-manager.ts`, `pipeline-tracker.ts`, `sdd-backlog-link.test.ts`

---

### Findings

---

**[BLOQUANT] F-EC-1 — Path boutons SDD ne crée jamais de tâche → sync toujours muette**

- **Scénario :** L'utilisateur lance le pipeline via les boutons inline SDD (`sdd_explore`, `sdd_spec`…) sans passer par `/explore`. Le tracker est créé sans `taskId` (aucune tâche auto-créée, seul `/explore` crée des tâches — R1, Z1). Toutes les phases agent-backed (spec, challenge, implement, review, doc) déclenchent bien `syncTaskStatusForPhase` via le job-manager (ligne 541), mais `tracker.taskId` est `undefined` → retour immédiat en no-op silencieux. Le backlog n'est jamais mis à jour pour ce path.
- **Source :** Section 10, Zone Z1 — "Pas de création de tâche dans ce path" reconnu mais non résolu. Règles R1/R6/R7/R8.
- **Impact :** La feature promise ("backlog reflète automatiquement la progression SDD") est entièrement inactive pour le path le plus courant (buttons inline). L'objectif de la spec n'est atteint que pour le path `/explore`.
- **Fréquence estimée :** Fréquent — les buttons inline sont le flow principal post-`/explore`.

---

**[BLOQUANT] F-EC-2 — `--task <id>` attend un UUID complet mais le backlog affiche des préfixes courts**

- **Scénario :** Le `/backlog` affiche `[abcd1234]` (8 chars) et l'utilisateur tape naturellement `/explore refactoring --task abcd1234`. `parseExploreArgs` accepte `\S+` sans validation → `getTaskById` fait `.eq("id", "abcd1234")` → Supabase retourne null → message "introuvable" → pipeline sans lien. L'utilisateur comprend que le `--task` est cassé alors que son ID est correct visuellement.
- **Source :** R2 (`--task <id>`), V10 ("full UUID"), Section 5 (affichage backlog avec IDs courts).
- **Impact :** Fonctionnalité R2 inutilisable par un utilisateur normal suivant l'UX naturelle. Silencieux côté log (warn "introuvable"), frustrant côté user.
- **Fréquence estimée :** Fréquent si l'utilisateur utilise R2.

---

**[MAJEUR] F-EC-3 — Double `/explore` sur la même query orpheline une tâche backlog**

- **Scénario :** L'utilisateur relance `/explore refactoring-memoire` (même query). `createPipeline` écrase le tracker existant (nouveau `taskId` si Supabase OK, ou `undefined`). L'ancienne tâche `[SDD] refactoring-memoire` reste dans le backlog avec `sdd_pipeline_name` set, mais aucun tracker ne la référence plus. Le pipeline continue sur la nouvelle tâche. Résultat : entrées `[SDD]` dupliquées dans le backlog sans pipeline actif.
- **Source :** R1 (auto-création), `exploration.ts:65-73` (guard < 1h remplace mais ne nettoie pas la tâche orpheline).
- **Impact :** Pollution du backlog avec des tâches `[SDD]` fantômes. La règle anti-doublon mentionnée dans le guard ne supprime pas la tâche Supabase existante.
- **Fréquence estimée :** Occasionnel (retry après erreur, ou re-exploration d'un sujet).

---

**[MAJEUR] F-EC-4 — V17 et V18 (integration tests) absents du fichier de test**

- **Scénario :** La spec définit V17 ("auto-création tâche dans `/explore` sans `--task`") et V18 ("`--task <id>` existant lie sans créer") au niveau `integration`. Le fichier `sdd-backlog-link.test.ts` ne contient que des tests `unit` (header mentionne V1-V14 uniquement). V15 et V16 sont couverts implicitement par des tests non-labellisés, mais V17/V18 sont absents.
- **Source :** Section 9, V17-V18 (`integration`). Header test file : "V-criteria: V1…V14".
- **Impact :** Les deux critères qui valident le path Telegram complet (`/explore` → création tâche → Supabase) ne sont pas testés. Un bug dans l'intégration `exploration.ts` → `addTask` resterait non détecté en CI.
- **Fréquence estimée :** N/A (gap de couverture CI permanent).

---

**[MAJEUR] F-EC-5 — Création de tâche silencieusement ignorée si `bctx.supabase` est null**

- **Scénario :** Si `bctx.supabase` est `null` (erreur d'init, env manquant), le guard `bctx.supabase ? await addTask(...)` retourne `null` sans message à l'utilisateur. L'exploration se lance normalement (`"Exploration SDD lancée: ..."`), le user croit avoir un backlog link, mais aucune tâche n'a été créée. Aucun log (même warn) n'est émis pour ce cas.
- **Source :** `exploration.ts:93` — guard sans else-branch ni log.
- **Impact :** L'utilisateur pense que le lien existe (message de lancement positif), mais le backlog ne sera jamais mis à jour. Divergence silencieuse.
- **Fréquence estimée :** Rare (boot degradé), mais impact disproportionné.

---

**[MAJEUR] F-EC-6 — Aucun feedback utilisateur sur la création de tâche auto dans `/explore`**

- **Scénario :** Quand `/explore refactoring` auto-crée une tâche (R1), le message de confirmation est uniquement `"Exploration SDD lancée: "refactoring-memoire" (job j-abc123)\nSujet: refactoring"`. Aucune mention que `[SDD] refactoring` a été ajouté au backlog. L'utilisateur ne sait pas qu'une tâche a été créée, ne peut pas vérifier son ID, et risque de lancer `/explore ... --task` inutilement.
- **Source :** Section 5 (Interface Telegram), R1. Section 10, Z2 (sync silencieuse).
- **Impact :** UX dégradée — la feature de création auto est invisible. L'utilisateur vérifie `/backlog` pour confirmer, ce qui n'est pas naturel.
- **Fréquence estimée :** Fréquent (chaque `/explore` sans `--task`).

---

**[MINEUR] F-EC-7 — Truncation 48-chars crée une divergence titre/sdd_pipeline_name non testée**

- **Scénario :** Pour `/explore this is a very long query that exceeds forty eight characters easily`, `toPipelineName` tronque à 48 chars → `sdd_pipeline_name = "this-is-a-very-long-query-that-exceeds-forty-ei"` mais le titre reste `"[SDD] this is a very long query that exceeds forty eight characters easily"`. Le lien `[SDD]` dans `/backlog` affiche le titre complet, mais le `sdd_pipeline_name` tronqué. Aucun test ne couvre ce cas.
- **Source :** Section 4 ("sdd_pipeline_name = toPipelineName(query) (kebab-case, max 48 chars)"). Aucun test dans V1-V18.

---

**[MINEUR] F-EC-8 — Sync silencieuse : aucune utilisation de `notification-queue.ts` existant**

- **Scénario :** Quand `syncTaskStatusForPhase` avance une tâche de `backlog` à `review`, l'utilisateur n'est pas notifié. La spec reconnaît Z2 mais ne propose aucune mitigation. Le module `notification-queue.ts` (listé dans CLAUDE.md) permet précisément ce type de notification passive. L'évaluation "Features Telegram évaluées" (section 5) ne mentionne pas les notifications.
- **Source :** Section 10, Z2. `src/notification-queue.ts` existant.

---

**[MINEUR] F-EC-9 — Incohérence de message entre R3, section 5 et code (accents manquants)**

- **Scénario :** Trois formulations différentes pour le même message d'erreur "tâche introuvable" : R3 (`"Tâche introuvable. Pipeline sans lien de tâche."`), section 5 (`"Tâche "abc123" introuvable. Le pipeline sera créé sans lien de tâche."`), code (`"Tache "${linkedTaskId}" introuvable. Le pipeline sera cree sans lien de tache."` — sans accents). La dernière viole les conventions TTS/qualité documentées dans `feedback_accents.md`.
- **Source :** R3, Section 5, `exploration.ts:86-89`.

---

### Statistiques

| Sévérité | Nombre |
|----------|--------|
| Bloquants | 2 |
| Majeurs | 4 |
| Mineurs | 3 |

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants (F-EC-1 path boutons, F-EC-2 ID court) remettent en cause la valeur réelle de la feature pour les usages naturels. La spec est solide sur le happy path `/explore → job → sync`, mais le périmètre "bidirectionnel" annoncé en titre est trompeur : en pratique, seul le path `/explore` est couvert. Recommandation : résoudre F-EC-1 (création de tâche dans `sdd-flow.ts` si tracker sans `taskId`) et F-EC-2 (accepter le préfixe court ou clarifier l'UX) avant de clôturer la spec.

---

## Simplicity Skeptic — Rapport

## Simplicity Skeptic — Rapport

**Spec analysée :** `SPEC-connecter-pipeline-sdd-et-backlog-pour-que-le.md`
**Statut déclaré :** Implémenté (spec post-implémentation)
**Code de référence :** `sdd-task-sync.ts` (111 LOC), `pipeline-tracker.ts`, `tasks.ts`, `exploration.ts`, `sdd-flow.ts`, `job-manager.ts`

---

### Findings

**[MAJEUR] F-SS-1 — Colonne SQL `sdd_pipeline_name` redondante avec tag `sdd-pipeline`**
- Source : R12, Section 6 (db/schema.sql), Section 4 (données de sortie)
- Description : La seule utilité de la colonne `sdd_pipeline_name` dans `tasks` est d'afficher le préfixe `[SDD]` dans `/backlog` (R12). Or, le tag `sdd-pipeline` est déjà ajouté systématiquement aux mêmes tâches (R14). `formatBacklog` aurait pu conditionner l'affichage `[SDD]` sur `tags.includes("sdd-pipeline")` sans nouvelle colonne SQL, sans migration, sans champ supplémentaire dans l'interface `Task`. La colonne stocke le pipeline name, mais aucune logique ne l'utilise pour retrouver le tracker — le lien inverse (task → pipeline) n'est jamais exercé dans le code.
- Alternative : `if (task.tags.includes("sdd-pipeline")) prefix = "[SDD]"` — zéro colonne SQL, zéro migration, zéro champ interface.
- Codebase : `tasks.ts:34,45` (tag + colonne), `tasks.ts:251` (formatBacklog), `exploration.ts:96-97` (tags + sdd_pipeline_name en double)

**[MAJEUR] F-SS-2 — Zone d'ombre Z1 non résolue : le chemin principal (boutons inline) ne crée jamais de tâche**
- Source : Section 10, Z1 et Alternatives ("Création tâche dans `sdd-flow.ts` aussi — Non décidé")
- Description : La spec reconnaît explicitement que les pipelines lancés via les boutons SDD inline (chemin dominant depuis le refactor UX menus progressifs) ne créent aucune tâche backlog. La feature est donc silencieuse pour ~80% des pipelines réels — seuls ceux initiés via `/explore` (chemin minoritaire) bénéficient du lien. La valeur de la feature est réduite à un cas d'usage marginal, au prix d'une colonne SQL et d'un module dédié.
- Alternative : Décision explicite GO ou DROP pour Z1 avant merge, ou scope limité à "liaison manuelle via `--task`" uniquement.
- Codebase : `sdd-flow.ts:225` (seule la phase `discuss` synchro dans ce path), aucun `addTask` dans `sdd-flow.ts`

**[MINEUR] F-SS-3 — R13 est un détail d'implémentation déguisé en règle métier**
- Source : R13 ("La sync via job-manager utilise une instance Supabase créée à la volée")
- Description : Ce n'est pas une règle métier — c'est un détail d'implémentation interne pour éviter une dépendance circulaire. La spec mélange les couches. Cette règle n'a aucune valeur pour quelqu'un qui implémente la feature, sauf si on cherche à justifier le pattern `lazy import`.
- Alternative : Déplacer dans Section 7 (Patterns existants) ou supprimer.

**[MINEUR] F-SS-4 — V17/V18 labellisés "integration" mais sont des tests unitaires avec mocks**
- Source : Section 9, V17 et V18
- Description : V17 ("Mock Supabase: `addTask` appelé") et V18 ("Mock Supabase: `addTask` NON appelé") utilisent `createMockSupabase` — c'est par définition du test unitaire. Le label `integration` est incorrect. De plus, ces deux critères ne sont pas implémentés dans le fichier `tests/unit/sdd-backlog-link.test.ts` (le fichier s'arrête à V14 nommés + 4 tests anonymes pour V15/V16).
- Codebase : `tests/unit/sdd-backlog-link.test.ts` (324 lignes, V17/V18 absents)

**[MINEUR] F-SS-5 — Section "Features Telegram évaluées" : 5 lignes toutes N/A**
- Source : Section 5, tableau "Features Telegram évaluées"
- Description : Ce tableau liste 5 features Telegram toutes rejetées avec "N/A". C'est un artefact de template qui n'apporte aucune information — une feature absente n'a pas besoin d'être documentée 5 fois. Génère du bruit dans la spec.
- Alternative : Supprimer la section ou la remplacer par "Aucune feature Telegram supplémentaire requise."

**[MINEUR] F-SS-6 — "Lien bidirectionnel" : claim inexact, asymétrie non documentée**
- Source : Section 1 (Objectif), Section 8 (Contraintes)
- Description : Le titre et l'objectif parlent de "lien bidirectionnel". En réalité : `tracker.taskId` permet pipeline→task (utilisé), mais `task.sdd_pipeline_name` ne permet jamais de retrouver le tracker (aucun appel `getTracker` depuis une tâche). Le lien est fonctionnellement unidirectionnel. La bidirectionnalité déclarée justifie deux champs (R4+R5) mais seul R4 sert à la sync.
- Codebase : `sdd-task-sync.ts:56-57` (seul `taskId` utilisé pour la sync), aucun usage de `sdd_pipeline_name` pour lookup tracker

---

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 4

---

### Synthèse

L'implémentation core (`sdd-task-sync.ts`, 111 LOC) est propre et bien contrainte. Les findings se concentrent sur deux décisions de conception :

1. La colonne SQL `sdd_pipeline_name` ajoute une migration et un champ interface pour une valeur (affichage `[SDD]`) déjà portée par le tag existant.
2. La feature couvre uniquement le path `/explore` alors que le path dominant (boutons inline) est explicitement laissé hors scope sans décision formelle.

Le module en lui-même est une bonne implémentation d'un scope trop étroit pour justifier l'infrastructure qu'il crée.

## Verdict de l'agent: GO_WITH_CHANGES

> Recommandations : (1) Évaluer si `sdd_pipeline_name` peut être remplacé par `tags.includes("sdd-pipeline")` pour éliminer la migration SQL. (2) Statuer explicitement sur Z1 (pipeline via boutons) avant de considérer la feature "complète".