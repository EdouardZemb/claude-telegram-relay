---
phase: 1-spec
generated_at: "2026-03-25T15:30:00+01:00"
subject: "Consolidation ciblée post-évaluation du périmètre fonctionnel"
source_exploration: "docs/explorations/EXPLORE-evaluation-de-toutes-les-fonctionnalites.md"
source_review: "docs/reviews/adversarial-SPEC-evaluation-de-toutes-les-fonctionnalites.md"
revision: "v2 — corrections post-adversarial (F-DA-1..10, F-EC-1..7, F-SS-1..7)"
verdict: GO
option: B — Consolidation ciblée
---

## Section 1 — Objectif

Résoudre les 5 points de friction concrets identifiés lors de l'évaluation exhaustive du périmètre fonctionnel (Option B — Consolidation ciblée) : commandes fantômes dans `/help` et `/workflow`, violations S2/S3 actives, entrées mortes dans les allowlists S2 et S3, et documentation du service heartbeat PM2.

**Périmètre exclu** : activation de `intent_detection`, refactoring de `bot-context.ts`, `memory/graph.ts`, migration `commands/memory-cmds.ts` (USER_TIMEZONE).

---

## Section 2 — Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | `/patterns` doit être retiré de la sortie `/help` (ligne 41) ET de la sortie `/workflow` (ligne 95) | Exploration §3 friction #7 ; F-SS-6 — `/workflow` ligne 95 référence aussi `/patterns` | Supprimer `"  /patterns -- Analyse multi-sprints (Analyste Mary)"` et `"  /patterns pour les tendances multi-sprints"` |
| R2 | `/estimate` doit être retiré de la sortie `/help` (ligne 52) : absent de `action-registry.ts`, aucun handler | Exploration §3 friction #8 | Supprimer `"  /estimate <n> [pipeline] -- Estimation cout sprint"` |
| R3 | `agent.ts` ne doit plus utiliser `process.env` directement — **3 violations** : `CLAUDE_PATH` (l.21), `PROJECT_DIR` (l.22), `GITHUB_REPO` (l.229) | Exploration §3 friction #10 ; F-DA-2 / F-EC-2 / F-SS-1 — GITHUB_REPO ligne 229 était manquant dans la spec v1 | Remplacer par `getConfig().claudePath`, `getConfig().projectDir`, `getConfig().githubRepo` depuis `./config.ts` (PAS `./bot-context.ts` — voir C5) |
| R4 | `commands/tasks.ts` ne doit plus utiliser `process.env` directement pour `SPRINT_THREAD_ID` (l.249) et `USER_TIMEZONE` (l.254, l.314) | Exploration §3 friction #9 | Remplacer par `getConfig().sprintThreadId` et `getConfig().userTimezone` (à vérifier dans config.ts) |
| R5 | `documents.ts` ne doit plus utiliser `process.env.CLAUDE_PATH` directement (ligne 83) | Grep confirmé — `const CLAUDE_PATH = process.env.CLAUDE_PATH \|\| "claude"` | Remplacer par `getConfig().claudePath` depuis `./config.ts` directement (PAS `./bot-context.ts` — voir C6) |
| R6 | Les 3 entrées mortes de l'allowlist S2 (`code-graph.ts`, `profile-evolution.ts`, `workflow.ts`) doivent être retirées de `ALLOWLIST` dans `coding-standards.test.ts` | Ces fichiers n'existent plus dans `src/` (Glob confirmé) | Supprimer les 3 lignes correspondantes dans `ALLOWLIST` (lignes ~135-137) |
| R6b | L'entrée morte `workflow.ts: 848` dans `LOC_ALLOWLIST` S3 doit aussi être retirée de `coding-standards.test.ts` | F-DA-3 / F-EC-5 / F-SS-3 — `src/workflow.ts` n'existe pas, entrée silencieusement ignorée par `existsSync` guard | Supprimer `"workflow.ts": 848` de `LOC_ALLOWLIST` (ligne ~184) |
| R7 | Après migration R3+R4+R5, les fichiers migrés doivent être retirés de l'ALLOWLIST S2 | Standard S9 — cap à 20 entrées (config.ts + logger.ts exclus par design, 18 dans ALLOWLIST) ; migrations libèrent 3 entrées supplémentaires aux 3 supprimées via R6 | Supprimer `agent.ts`, `commands/tasks.ts`, `documents.ts` de l'ALLOWLIST S2 |
| R8 | `zz-messages.ts` doit être < 800 LOC après refactoring (standard S3) | coding-standards.test.ts S3 — LOC_ALLOWLIST contient actuellement `"commands/zz-messages.ts": 938` | Extraire le routeur de commandes vers `src/commands/command-router.ts` : fonctions `routeIntent` (l.221), `buildClarificationQuestion` (l.189), `checkPendingClarification` (l.275), `handleConfirmationCallback` (l.287), `buildSyntheticUpdate` (l.311) |
| R9 | Si `zz-messages.ts` est réduit sous 800 LOC, l'entrée `commands/zz-messages.ts` doit être retirée de `LOC_ALLOWLIST` dans `coding-standards.test.ts` | Standard S3 — après R6b et R9 la LOC_ALLOWLIST sera vide (0 entrées) | Supprimer `"commands/zz-messages.ts": 938` de `LOC_ALLOWLIST` (ligne ~185) |
| R10 | La barrel convention s'applique uniquement si un sous-répertoire est créé. Un fichier plat `command-router.ts` dans `commands/` ne nécessite pas de barrel | Standard S5 — la barrel convention s'applique aux sous-répertoires, pas aux fichiers plats | Pas de barrel si `command-router.ts` est ajouté dans `commands/` |
| R11 | Le service PM2 `claude-heartbeat` a déjà `autorestart: false, cron_restart: "*/10 * * * *"` — c'est une config délibérée, pas un oubli. Ajouter un commentaire inline dans `ecosystem.config.cjs` clarifiant ce choix | F-SS-4 / F-DA-6 — `disabled: true` n'est pas une option PM2 valide ; la config actuelle est intentionnelle | Ajouter `// heartbeat cron: runs every 10min via PM2 cron, autorestart:false = no keep-alive between runs` |
| R12 | Aucune régression sur les 1910 tests existants | Standard projet — `bun test` doit passer avant tout merge | Exécuter `bun test` après chaque action |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Champs clés |
|--------|------|-------|-------------|
| `docs/explorations/EXPLORE-evaluation-de-toutes-les-fonctionnalites.md` | Rapport d'exploration | Lecture fichier | Sections 3 (inventaire), 4 (alternatives), 5 (verdict), 6 (input pour spec) |
| `src/commands/help.ts` | TypeScript source | Lecture fichier | Ligne 41 (`/patterns` dans `/help`), ligne 52 (`/estimate`), ligne 95 (`/patterns` dans `/workflow`) |
| `src/agent.ts` | TypeScript source | Lecture fichier | Lignes 21-22 : `CLAUDE_PATH`, `PROJECT_DIR` ; ligne 229 : `GITHUB_REPO` |
| `src/commands/tasks.ts` | TypeScript source | Lecture fichier | Lignes 249, 254, 314 : `SPRINT_THREAD_ID`, `USER_TIMEZONE` |
| `src/documents.ts` | TypeScript source | Lecture fichier | Ligne 83 : `process.env.CLAUDE_PATH` |
| `src/config.ts` | TypeScript source | Lecture fichier | `claudePath` (l.77,142), `projectDir` (l.77,143), `githubRepo` (l.89,155), `sprintThreadId` (l.138) — tous disponibles dans `AppConfig` |
| `src/bot-context.ts` | TypeScript source | Lecture fichier | Exporte `CLAUDE_PATH`, `PROJECT_DIR`, `USER_TIMEZONE` via IIFE getConfig() — **NE PAS utiliser depuis agent.ts ni documents.ts** (voir C5, C6) |
| `src/commands/zz-messages.ts` | TypeScript source | Lecture fichier | Fonctions candidates : `routeIntent` (l.221), `buildClarificationQuestion` (l.189), `checkPendingClarification` (l.275), `handleConfirmationCallback` (l.287), `buildSyntheticUpdate` (l.311) |
| `tests/unit/coding-standards.test.ts` | Test TypeScript | Lecture fichier | `ALLOWLIST` S2 (l.123-153) — 18 entrées ; `LOC_ALLOWLIST` S3 (l.183-185) — 2 entrées dont 1 morte |
| `ecosystem.config.cjs` | PM2 config | Lecture fichier | Service `claude-heartbeat` (l.37-47) : `autorestart: false, cron_restart: "*/10 * * * *"` — config délibérée |

---

## Section 4 — Données de sortie

### Structure attendue

Après implémentation, les modifications produisent :

**help.ts — sortie /help corrigée (ligne 41 supprimée) :**
```
QUALITE & AMELIORATION
  /metrics [sprint] -- Metriques (Scrum Master Bob)
  /retro [sprint] -- Retrospective (Bob)
  /alerts -- Alertes proactives (QA Quinn)
  /cost [sprint|total] -- Suivi couts tokens par agent/tache/sprint
  /brain -- Synthese memoire
  /ideas -- Gerer les idees
```
(suppression de `/patterns` à la ligne 41)

**help.ts — sortie /workflow corrigée (ligne 95 supprimée) :**
```
SUIVI
  /retro pour analyser le sprint
  /metrics pour les donnees quantitatives
```
(suppression de `"  /patterns pour les tendances multi-sprints"`)

**agent.ts — 3 process.env remplacés, import config.ts ajouté :**
```typescript
import { getConfig } from "./config.ts";
// lignes 21-22 remplacées :
const CLAUDE_PATH = getConfig().claudePath;
const PROJECT_DIR = getConfig().projectDir || process.cwd();
// ligne 229 remplacée :
const GITHUB_REPO = getConfig().githubRepo || "EdouardZemb/claude-telegram-relay";
```

**commands/tasks.ts — migrations getConfig :**
```typescript
import { getConfig } from "../config.ts";
// process.env.SPRINT_THREAD_ID → getConfig().sprintThreadId
// process.env.USER_TIMEZONE → getConfig().userTimezone (ou constante équivalente)
```

**documents.ts — import getConfig ajouté depuis config.ts :**
```typescript
import { getConfig } from "./config.ts";
// ligne 83 remplacée :
const CLAUDE_PATH = getConfig().claudePath;
```

**coding-standards.test.ts — allowlists réduites :**
- S2 ALLOWLIST : 18 → 12 entrées (−3 entrées mortes R6, −3 migrations R7)
- S3 LOC_ALLOWLIST : 2 → 0 entrées (−1 workflow.ts morte R6b, −1 zz-messages.ts après split R9)

**zz-messages.ts — taille réduite :**
- Avant : 938 LOC (comptage test) / 904 LOC (wc -l)
- Après : < 800 LOC (cible : ~770-790)
- Nouveau fichier : `src/commands/command-router.ts` (~150-160 LOC)

**ecosystem.config.cjs — commentaire ajouté :**
```javascript
{
  name: "claude-heartbeat",
  // heartbeat cron: runs every 10min via PM2 cron_restart, autorestart:false = no keep-alive between runs
  autorestart: false,
  cron_restart: "*/10 * * * *",
  ...
}
```

### Règles de remplissage

- Les migrations `process.env` vers `getConfig()` utilisent **toujours** `./config.ts` comme source (jamais `./bot-context.ts` pour les fichiers non-Composer)
- Une entrée ne doit être retirée de l'ALLOWLIST S2 que si le fichier source ne contient plus **aucun** `process.env` réel (hors commentaires et strings)
- Vérifier via `grep -n "process\.env" src/<fichier>` après chaque migration
- Compter les LOC avec `wc -l src/commands/zz-messages.ts` après extraction (référence : test utilise `split("\n").length`)

---

## Section 5 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/commands/help.ts` | Modifier | Retirer `/patterns` (ligne 41 de `/help`, ligne 95 de `/workflow`) et `/estimate` (ligne 52) |
| `src/agent.ts` | Modifier | Lignes 21-22, 229 : remplacer les 3 `process.env` par `getConfig()` depuis `./config.ts` |
| `src/commands/tasks.ts` | Modifier | Lignes 249, 254, 314 : remplacer `process.env.SPRINT_THREAD_ID` et `process.env.USER_TIMEZONE` par `getConfig()` |
| `src/documents.ts` | Modifier | Ligne 83 : remplacer `process.env.CLAUDE_PATH` par `getConfig().claudePath` depuis `./config.ts` |
| `src/commands/zz-messages.ts` | Modifier (extraire) | 938 LOC — extraire `routeIntent`, `buildClarificationQuestion`, `checkPendingClarification`, `handleConfirmationCallback`, `buildSyntheticUpdate` vers `command-router.ts` |
| `src/commands/command-router.ts` | Créer | Nouveau module < 200 LOC contenant le routeur de commandes extrait de `zz-messages.ts` |
| `tests/unit/coding-standards.test.ts` | Modifier | (1) Retirer 3 entrées mortes de S2 ALLOWLIST (`code-graph.ts`, `profile-evolution.ts`, `workflow.ts`) ; (2) Retirer fichiers migrés (`agent.ts`, `commands/tasks.ts`, `documents.ts`) ; (3) Retirer `workflow.ts: 848` de LOC_ALLOWLIST S3 ; (4) Retirer `commands/zz-messages.ts: 938` de LOC_ALLOWLIST S3 après split |
| `ecosystem.config.cjs` | Modifier | Ajouter commentaire inline sur `claude-heartbeat` pour documenter le choix délibéré `autorestart: false + cron_restart` |
| `CLAUDE.md` | Modifier | Retirer `/patterns` et `/estimate` de la table des commandes Telegram |

---

## Section 6 — Patterns existants

### P1 — Pattern getConfig() dans un module source (usage direct depuis config.ts)

`src/config.ts` lignes 76-89 — `claudePath`, `projectDir`, `githubRepo` sont dans `AppConfig` :

```typescript
// config.ts L76-89
claudePath: string;
projectDir: string;
githubRepo: string;

// Valeurs (L142-155)
claudePath: optionalResult.CLAUDE_PATH,  // default "claude"
projectDir: optionalResult.PROJECT_DIR,  // default ""
githubRepo: optionalResult.GITHUB_REPO,  // default ""
```

Migration cible pour `agent.ts` :
```typescript
import { getConfig } from "./config.ts";  // ajouter cet import
// Remplacer lignes 21-22 :
const CLAUDE_PATH = getConfig().claudePath;
const PROJECT_DIR = getConfig().projectDir || process.cwd();
// Remplacer ligne 229 :
const GITHUB_REPO = getConfig().githubRepo || "EdouardZemb/claude-telegram-relay";
```

### P2 — Pattern getConfig() pour constantes optionnelles (tasks.ts)

`src/config.ts` ligne 138 — `sprintThreadId` exposé dans AppConfig :
```typescript
sprintThreadId: optionalResult.SPRINT_THREAD_ID,  // number, default 0
```

Migration cible pour `commands/tasks.ts` :
```typescript
import { getConfig } from "../config.ts";
const sprintThread = getConfig().sprintThreadId;
```

Vérifier si `userTimezone` est dans AppConfig — si non, utiliser la chaîne littérale `"Europe/Paris"` comme fallback (cohérent avec le reste du codebase).

### P3 — Pattern split en sous-module plat (sans barrel)

`src/commands/sdd-flow.ts` (376 LOC) + `src/commands/sdd-agents.ts` (488 LOC) — modèle de séparation des responsabilités dans `commands/` sans créer de sous-répertoire. Les imports restent `"../commands/command-router.ts"`.

### P4 — Pattern d'extraction de fonctions internes vers un fichier frère

`src/commands/sdd-flow.ts` importe des fonctions business logic de `src/commands/sdd-agents.ts` qui les exporte. Même pattern attendu : `zz-messages.ts` importera les fonctions extraites depuis `command-router.ts`.

### P5 — Suppression d'entrée allowlist dans coding-standards.test.ts

`tests/unit/coding-standards.test.ts` lignes 123-153 — structure `ALLOWLIST: Record<string, string>`. Supprimer une entrée revient à retirer la ligne correspondante. Le test S9 (cap size) vérifiera automatiquement la réduction.

---

## Section 7 — Contraintes

| # | Contrainte | Détail |
|---|-----------|--------|
| C1 | **S9 cap strict** | L'ALLOWLIST S2 ne peut pas dépasser 20 entrées. Actuellement 18 (+ 2 EXCLUDED_BY_DESIGN). Les 3 suppressions R6 libèrent de la place pour les migrations R3+R4+R5. Ordre obligatoire : supprimer entrées mortes (R6) **avant** de migrer (R7). |
| C2 | **Barrel convention** | `command-router.ts` est un fichier plat dans `commands/` — aucun barrel requis. Ne créer de barrel que si un sous-répertoire `commands/router/` est créé (ce qui est exclu, voir Alt B). |
| C3 | **S8 couverture 30% — tests en priorité** | `command-router.ts` créé doit atteindre 30% de couverture. **Chemin principal : créer les tests unitaires** pour les fonctions extraites. L'ajout à la coverage allowlist est un fallback exceptionnel nécessitant une justification écrite (ex: "impossible à tester sans mock Telegram complet"). Vérifier via `scripts/check-coverage.sh`. |
| C4 | **Import circulaire** | `command-router.ts` peut importer depuis `zz-messages.ts` seulement pour des types partagés. Les dépendances de données doivent être unidirectionnelles (zz-messages.ts importe de command-router.ts, pas l'inverse). Vérifier avec le test S7. |
| C5 | **agent.ts : utiliser config.ts, pas bot-context.ts** | `agent.ts` est un module de la couche "services" — il NE DOIT PAS importer `bot-context.ts`. `bot-context.ts` importe `tts.ts`, `memory.ts`, `documents.ts` qui initialisent Supabase et TTS. Utiliser `getConfig()` depuis `./config.ts` directement. |
| C6 | **documents.ts : utiliser config.ts, pas bot-context.ts** | `bot-context.ts` importe `type { DocumentSearchResult }` depuis `./documents.ts` (ligne 14). Si `documents.ts` importait `bot-context.ts`, cela créerait le cycle `bot-context.ts → documents.ts → bot-context.ts` détecté par le test S7 (la regex S7 n'exclut pas `import type`). Utiliser `getConfig()` depuis `./config.ts` directement. |
| C7 | **heartbeat.ts conservé** | Le code `heartbeat.ts` (720 LOC) ne doit pas être supprimé dans cette spec. Seul un commentaire dans `ecosystem.config.cjs` est concerné. |
| C8 | **Pas de régression tests** | `bun test` doit retourner 1910 tests passants (ou plus si nouveaux tests pour command-router.ts). |
| C9 | **Vérification USER_TIMEZONE dans config.ts** | Avant de migrer `commands/tasks.ts`, vérifier si `userTimezone` est dans AppConfig. Si absent, utiliser la valeur littérale `"Europe/Paris"` avec un commentaire TODO (ne pas ajouter une nouvelle env var hors scope). |

---

## Section 8 — Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|-------------|--------|
| V1 | La sortie `/help` ne contient plus `/patterns` ni `/estimate` | `grep -n "patterns\|estimate" src/commands/help.ts` retourne 0 match dans les strings de la fonction `helpCommands` | unit |
| V2 | La sortie `/workflow` ne contient plus `/patterns` | `grep -n "patterns" src/commands/help.ts` retourne 0 match dans les strings de la fonction `/workflow` | unit |
| V3 | `agent.ts` ne contient plus aucun `process.env` réel (3 violations migrées : CLAUDE_PATH, PROJECT_DIR, GITHUB_REPO) | `grep -n "process\.env" src/agent.ts` retourne 0 hors commentaires ; test coding-standards.test.ts S2 `agent.ts has no direct process.env usage` passe sans être dans l'allowlist | unit |
| V4 | `commands/tasks.ts` ne contient plus `process.env.SPRINT_THREAD_ID` ni `process.env.USER_TIMEZONE` | Test coding-standards.test.ts S2 `commands/tasks.ts has no direct process.env usage` passe | unit |
| V5 | `documents.ts` ne contient plus `process.env.CLAUDE_PATH` | Test coding-standards.test.ts S2 `documents.ts has no direct process.env usage` passe | unit |
| V6 | S2 ALLOWLIST réduit de 18 à 12 entrées (−3 mortes R6, −3 migrations R7) | Compter les entrées de l'ALLOWLIST dans le diff de coding-standards.test.ts ; test S9 cap passe | unit |
| V7 | `code-graph.ts`, `profile-evolution.ts`, `workflow.ts` absents de l'ALLOWLIST S2 | `grep "code-graph\|profile-evolution\|workflow.ts" tests/unit/coding-standards.test.ts` retourne 0 dans le bloc ALLOWLIST | unit |
| V8 | `zz-messages.ts` a moins de 800 LOC | Test coding-standards.test.ts S3 `commands/zz-messages.ts is under 800 LOC` passe (fichier retiré de LOC_ALLOWLIST) | unit |
| V9 | `commands/zz-messages.ts` ET `workflow.ts` retirés de `LOC_ALLOWLIST` | LOC_ALLOWLIST vide (0 entrées) dans coding-standards.test.ts | unit |
| V10 | `command-router.ts` respecte S4 (boundaries architecturales) et S7 (pas de cycle avec bot-context.ts) | Test coding-standards.test.ts S4 et S7 passent | unit |
| V11 | `command-router.ts` a ≥ 30% de couverture (tests unitaires créés) | `scripts/check-coverage.sh` passe avec exit code 0 | integration |
| V12 | 1910 tests (ou plus) passent | `bun test` | integration |
| V13 | CI passe (typecheck + coding-standards + coverage) | `./scripts/wait-ci.sh` après création de la PR | integration |
| V14 | `ecosystem.config.cjs` contient un commentaire inline sur `claude-heartbeat` documentant le choix délibéré | Lecture du fichier : présence de commentaire sur la ligne `autorestart: false` ou `cron_restart` | manual |

---

## Section 9 — Coverage et zones d'ombre

### Matrice des 4 dimensions

| Dimension | Couvert | Hors scope | Zone d'ombre |
|-----------|---------|-----------|--------------|
| **Problème** | Commandes fantômes (/help + /workflow), violations S2 dans 3 fichiers, entrées mortes S2 et S3, heartbeat sans documentation | Refonte architecture, nouvelles fonctionnalités | — |
| **Périmètre** | 5 points de friction prioritaires (Option B) + 1 ajout (GITHUB_REPO dans agent.ts) | Activation intent_detection, refactoring bot-context.ts/memory/graph.ts | `commands/memory-cmds.ts` : 3 occurrences USER_TIMEZONE (hors scope car allowlist S9 reste à 12 < 20 après implémentation — pas de pression) |
| **Validation** | V1-V13 couverts par tests automatiques (unit+integration), V14 manuel | Tests E2E de commandes impactées (non requis, comportement utilisateur inchangé) | Si `command-router.ts` utilise des mocks Telegram complexes, la couverture 30% peut nécessiter un pattern de test spécifique |
| **Technique** | Migrations getConfig depuis config.ts (évite cycles et dépendances lourdes), split flat-file, nettoyage allowlists | Sous-répertoire commands/router/ (exclu) | `USER_TIMEZONE` dans AppConfig : à vérifier avant migration tasks.ts (si absent → fallback littéral "Europe/Paris" acceptable) |

### Alternatives évaluées

**Alt A — Migrer agent.ts et documents.ts via bot-context.ts plutôt que config.ts** : Rejeté. `agent.ts → bot-context.ts` charge inutilement tts.ts/memory.ts/grammy pour 3 constantes. `documents.ts → bot-context.ts` crée un cycle S7 (`bot-context.ts → documents.ts → bot-context.ts`) — **bloquant CI** (F-EC-1 confirmé).

**Alt B — Créer un sous-répertoire commands/router/ plutôt qu'un fichier plat** : Rejeté. La barrel convention ajouterait un fichier supplémentaire pour un seul sous-module. Préférer `commands/command-router.ts` comme fichier plat.

**Alt C — Laisser agent.ts dans l'allowlist S2 (ne migrer que CLAUDE_PATH et PROJECT_DIR)** : Rejeté. GITHUB_REPO ligne 229 est déjà dans `config.ts` (githubRepo, ligne 155). Migration triviale. Sans elle, `agent.ts` reste dans l'allowlist et le décompte 18→12 est incorrect (descend seulement à 13) — (F-DA-2).

**Alt D — Inclure commands/memory-cmds.ts dans les migrations S2** : Hors scope dans cette spec (3 occurrences USER_TIMEZONE). La cap S9 reste à 12 après implémentation (bien en-dessous de 20) — aucune pression immédiate.

**Alt E — Ajouter `disabled: true` dans ecosystem.config.cjs pour le heartbeat** : Rejeté. Cette clé n'existe pas dans le format PM2 ecosystem. La configuration actuelle (`autorestart: false, cron_restart: "*/10 * * * *"`) est délibérée et correcte — ajouter un commentaire suffit (F-DA-6 / F-SS-4).

### Questions ouvertes résolues

- `/patterns` : confirmé fantôme et double-présent — dans `/help` ligne 41 ET dans `/workflow` ligne 95. Les deux occurrences doivent être supprimées.
- `/estimate` : confirmé fantôme — absent de `action-registry.ts` et de tous les Composers.
- `agent.ts` : **3 violations** `process.env` (CLAUDE_PATH, PROJECT_DIR, GITHUB_REPO) — pas 2. GITHUB_REPO ligne 229.
- `documents.ts → config.ts` direct : `bot-context.ts` utilise `import type { DocumentSearchResult } from "./documents.ts"` — tout import de `bot-context.ts` depuis `documents.ts` créerait un cycle DFS détecté par S7. Migration via `config.ts` évite le problème.
- Heartbeat : `autorestart: false, cron_restart: "*/10 * * * *"` est une config délibérée (cron pattern PM2). Pas besoin de `disabled: true` (option invalide) — juste un commentaire de documentation.
- LOC_ALLOWLIST : 2 entrées (workflow.ts + zz-messages.ts), les deux à retirer → 0 entrées après implémentation.
- Fonction extraite : `routeIntent` (ligne 221), PAS `routeMessage` (n'existe pas — F-DA-4 / F-SS-2).
