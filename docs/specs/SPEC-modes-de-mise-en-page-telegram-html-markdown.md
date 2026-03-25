---
phase: 1-spec
generated_at: "2026-03-25T12:00:00+01:00"
subject: "Modes de mise en page Telegram : adoption HTML pour le formatage bot-side"
source_exploration: "docs/explorations/EXPLORE-modes-de-mise-en-page-telegram-html-markdown.md"
verdict: GO
option: "B — HTML pour le formatage bot-side, plain text pour les réponses LLM"
---

## Section 1 — Objectif

Le codebase applique actuellement une convention "plain text only" déjà contournée en production : `sendResponseHtml` et `escapeHtml` existent dans `bot-context.ts`, et `commands/documents.ts` les utilise pour les liens cliquables. Cette convention incohérente pénalise l'UX (/backlog, /sprint, /brain, /metrics, /docs affichent du texte brut sans hiérarchie visuelle).

Cette spec formalise la stratégie suivante : **les fonctions de formatage bot-side statiques adoptent HTML**, tandis que **les réponses LLM (callClaude → sendResponse) restent en plain text**. L'infrastructure est déjà en place — escapeHtml(), sendResponseHtml(), et un patron de référence validé en production dans documents.ts.

---

## Section 2 — Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Les fonctions de formatage bot-side (listing, dashboard, métriques, status) retournent des chaînes HTML et sont envoyées via `sendResponseHtml` (ou `ctx.reply` avec `parse_mode: "HTML"`) | Exploration §5 — verdict GO, option B | `formatBacklog()` → `bctx.sendResponseHtml(ctx, result)` |
| R2 | Les réponses du LLM (`callClaude`) sont toujours envoyées via `sendResponse` (plain text) — invariant architectural | Exploration §3 — prompt système bot-context.ts:553 force plain text sur Claude | Les réponses `/explore`, `/retro` (LLM) restent plain text |
| R3 | Tout contenu dynamique intégré dans une chaîne HTML (titres de tâches, noms de fichiers, messages d'alerte, noms de pipelines) est obligatoirement passé par `escapeHtml()` avant interpolation | Exploration §3 — "risque si contenu contient < ou >" | `<b>${escapeHtml(task.title)}</b>`, `<code>${escapeHtml(alert.message)}</code>` |
| R4 | Niveau HTML minimaliste : seules `<b>` (titres/sections), `<code>` (IDs, valeurs techniques), et `<a href>` (liens) sont autorisées. Pas de `<i>`, `<u>`, `<s>`, `<blockquote>`, `<tg-spoiler>` | Exploration §6 Q2 résolu — minimaliste pour cohérence visuelle | Titre tâche → `<b>`, ID tâche → `<code>`, pas de blockquote SDD |
| R5 | `sendVoiceResponse` strip les balises HTML **avant** de stripper le Markdown, puis décode les entités HTML pour que le TTS ne lise pas les balises à voix haute | Exploration §3 — "point d'attention TTS", exploration §6 | `.replace(/<[^>]+>/g, "")` puis `.replace(/&amp;/g, "&")` etc. avant les replace Markdown |
| R6 | `ctx.editMessageText` sur un message dont le contenu HTML provient d'une fonction de formatage migrée doit inclure `parse_mode: "HTML"` dans les options — actuellement concerné : `src/commands/utilities.ts:323` (`formatSprintSummary`) | Exploration §3 — "editMessageText doit inclure parse_mode si message original HTML" | `ctx.editMessageText(formatted, { parse_mode: "HTML" })` |
| R7 | Les signatures des fonctions de formatage (`formatBacklog`, `formatStatusBar`, `formatIdeasList`, etc.) restent identiques — seul le contenu retourné change (chaînes HTML au lieu de plain text) | Principe de non-régression — les tests d'import et les callers existants ne doivent pas être cassés | `formatBacklog(tasks: Task[], title?: string): string` — signature inchangée |
| R8 | La règle CLAUDE.md ligne 175 ("plain text only") est précisée : elle s'applique aux *réponses LLM* (via `callClaude`), pas aux fonctions de formatage bot-side | Exploration §5 — "distinction à formaliser" | Nouvelle formulation : "LLM responses: plain text only. Bot-side formatting: HTML via sendResponseHtml" |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Comportement actuel |
|--------|------|-------|---------------------|
| `src/tasks.ts:220` | TypeScript | Lecture | `formatBacklog(tasks, title?)` — headers `-- En cours --`, IDs `[${id.slice(0,8)}]`, titres bruts |
| `src/tasks.ts:259` | TypeScript | Lecture | `formatSprintSummary(sprint, summary)` — `Sprint ${sprint}` comme titre, métriques plain text |
| `src/pipeline-tracker.ts:253` | TypeScript | Lecture | `formatStatusBar(tracker)` — `Pipeline « name »`, phases avec symboles ✓ ● ○, artifacts nom de fichier |
| `src/memory/ideas.ts:161` | TypeScript | Lecture | `formatIdeasList(ideas)` — `IDEES (n)` en header, `STATUS | id | content [topics] (date)` |
| `src/commands/quality.ts:152` | TypeScript | Lecture | `formatMetrics(metrics)` — `Metriques Sprint X` en titre, métriques numériques plain text |
| `src/commands/quality.ts:176` | TypeScript | Lecture | `formatMetricsComparison(list)` — `Evolution des sprints` + barre ASCII `===` |
| `src/commands/quality.ts:~288` | TypeScript | Lecture | `formatRetro(retro)` — contenu généré par LLM via callClaude, envoyé via sendResponse (R2 — ne pas migrer) |
| `src/alerts.ts:508` | TypeScript | Lecture | `formatMonitoringStats()` — sections `Temps de reponse:`, `Spawn Claude par role:`, `Erreurs modules:` |
| `src/alerts.ts:556` | TypeScript | Lecture | `formatAlerts(alerts)` — icônes `!!`, `!`, `~` + messages d'alerte dynamiques |
| `src/memory/graph.ts:651` | TypeScript | Lecture | `formatMemoryHealth(stats)` — métriques de santé mémoire, sections plain text |
| `src/bot-context.ts:698` | TypeScript | Lecture | `sendVoiceResponse` — strip Markdown avant TTS (** * ` # -), pas de strip HTML |
| `CLAUDE.md:175` | Convention | Lecture | "Telegram responses: plain text only, no markdown formatting" — formulation ambiguë couvrant LLM et bot-side |

**Note sur `formatRetro`** : la rétro est générée par `callClaude` et son contenu est du texte LLM. Elle est envoyée via `sendResponse` (plain text) — ne doit PAS migrer vers HTML (R2). Seules les fonctions de formatage statiques (listings, métriques, status) migrent.

---

## Section 4 — Données de sortie

### Règles de transformation HTML par fonction

**`formatBacklog`** (`src/tasks.ts:220`) :
- Titre de section `-- En cours --` → `<b>En cours</b>`
- Titre de tâche → `<b>${escapeHtml(t.title)}</b>`
- ID tronqué `[a1b2c3d4]` → `<code>${id}</code>` (IDs sont alphanumériques, escapeHtml reste défensif)
- Sprint tag `(S12)` → plain text (données numériques sûres)
- `sddTag` `[SDD]` → constant littéral, pas d'escaping nécessaire
- Exemple : `<b>En cours</b>\n  🔴 [SDD] <b>Migrer auth middleware</b> (S23) <code>a1b2c3d4</code>`

**`formatSprintSummary`** (`src/tasks.ts:259`) :
- `Sprint ${sprint}` → `<b>Sprint ${escapeHtml(sprint)}</b>`
- Métriques (nombres) → plain text (valeurs sûres, pas d'escaping)
- Exemple : `<b>Sprint S23</b>\n\nProgression: 8/12 (67%)\nA faire: 2\n...`

**`formatStatusBar`** (`src/pipeline-tracker.ts:253`) :
- `Pipeline « ${tracker.name} »` → `<b>Pipeline « ${escapeHtml(tracker.name)} »</b>`
- Phase active (running) → `<b>${label}</b>...`
- Phase terminée (done/skipped) → `${label}` (plain text)
- Artifact shortname → `<code>${escapeHtml(shortArtifact)}</code>`
- Summary → `(${escapeHtml(step.summary)})`
- Supprimer le commentaire JSDoc "Plain-text only (Telegram convention)"

**`formatIdeasList`** (`src/memory/ideas.ts:161`) :
- `IDEES (n)` → `<b>IDEES (${ideas.length})</b>`
- ID tronqué → `<code>${idea.id.slice(0, 8)}</code>`
- Contenu de l'idée → `${escapeHtml(idea.content)}`
- Topics → `[${topics.map(t => escapeHtml(t)).join(", ")}]`
- Supprimer le commentaire JSDoc "plain text, no markdown"

**`formatMetrics`** (`src/commands/quality.ts:152`) :
- `Metriques Sprint ${id}` → `<b>Metriques Sprint ${escapeHtml(metrics.sprint_id)}</b>`
- Valeurs numériques → plain text (sûres)
- Labels fixes (`Taches:`, `Temps moyen:`) → plain text

**`formatMetricsComparison`** (`src/commands/quality.ts:176`) :
- `Evolution des sprints` → `<b>Evolution des sprints</b>`
- Sprint IDs → `<code>${escapeHtml(m.sprint_id)}</code>`
- Barre ASCII `===` → conserver en plain text (visuellement correcte)

**`formatMonitoringStats`** (`src/alerts.ts:508`) :
- Section headers `Temps de reponse:`, `Spawn Claude par role:`, `Erreurs modules:` → `<b>...</b>`
- Rôle Claude (clé de spawnStats) → `<code>${escapeHtml(role)}</code>`
- Nom de module (clé de modErrors) → `<code>${escapeHtml(mod)}</code>`
- Valeurs numériques → plain text

**`formatAlerts`** (`src/alerts.ts:556`) :
- Compteur `${n} alerte(s) detectee(s)` → `<b>${n} alerte...</b>`
- Message d'alerte (dynamique) → `${escapeHtml(alert.message)}` (R3 obligatoire : contenu potentiellement LLM-généré)

**`formatMemoryHealth`** (`src/memory/graph.ts:651`) :
- Headers de section → `<b>header</b>`
- Valeurs de métriques numériques → `<code>value</code>` si valeur technique, plain text si % ou libellé

### Adaptation `sendVoiceResponse` (`src/bot-context.ts:698`)

Nouvelle séquence de nettoyage (ordre impératif) :
```
1. .replace(/<[^>]+>/g, "")           // Strip balises HTML
2. .replace(/&amp;/g, "&")            // Décoder entités HTML
3. .replace(/&lt;/g, "<")
4. .replace(/&gt;/g, ">")
5. .replace(/```[\s\S]*?```/g, "")    // Strip code blocks (existant)
6. .replace(/`([^`]+)`/g, "$1")       // Strip inline code (existant)
7. .replace(/\*\*([^*]+)\*\*/g, "$1") // Strip bold (existant)
8. .replace(/\*([^*]+)\*/g, "$1")     // Strip italic (existant)
9. .replace(/^#{1,6}\s+/gm, "")      // Strip headers (existant)
10. .replace(/^[-*]\s+/gm, "")        // Strip bullets (existant)
```

### Mise à jour `ctx.editMessageText` (`src/commands/utilities.ts:323`)

Avant : `ctx.editMessageText(formatted)` (sans parse_mode)
Après : `ctx.editMessageText(formatted, { parse_mode: "HTML" })`

---

## Section 5 — Interface Telegram

### Format des messages enrichis

Les commandes suivantes bénéficient d'une hiérarchie visuelle sans changement de structure :

| Commande | Avant | Après (changement) |
|----------|-------|---------------------|
| `/backlog` | `-- En cours --\n  🔴 Titre [abc123]` | `<b>En cours</b>\n  🔴 <b>Titre</b> <code>abc123</code>` |
| `/sprint` | `Sprint S23\n\nProgression: 8/12 (67%)` | `<b>Sprint S23</b>\n\nProgression: 8/12 (67%)` |
| `/metrics` | `Metriques Sprint S23\n\nTaches: 8/12` | `<b>Metriques Sprint S23</b>\n\nTaches: 8/12` |
| `/brain health` | `Memoire:\n  Total: 142 entrées` | `<b>Memoire</b>\n  Total: 142 entrées` |
| `/ideas` | `IDEES (5)\nACTIVE \| abc12345 \| Mon idée` | `<b>IDEES (5)</b>\nACTIVE \| <code>abc12345</code> \| Mon idée` |
| `/alerts` | `2 alertes detectees :\n  !! Stuck task` | `<b>2 alertes detectees</b>\n  !! ${escapeHtml(message)}` |
| `/monitor` | `Monitoring Production\n\nTemps de reponse:` | `<b>Monitoring Production</b>\n\n<b>Temps de reponse:</b>` |
| SDD status bar | `Pipeline « mon-feature »\n  ✓ explore` | `<b>Pipeline « mon-feature »</b>\n  ✓ explore` |

### Boutons et keyboards

Pas de changement. Les InlineKeyboard et ReplyKeyboard ne sont pas affectés par parse_mode.

### Flow conversationnel

Pas de changement de structure. Les messages sont enrichis visuellement, pas restructurés. Le nombre d'étapes avant le résultat reste identique.

### Features Telegram évaluées

| Feature | Décision |
|---------|---------|
| `parse_mode: "HTML"` | Adopté pour toutes les fonctions de formatage bot-side (R1) |
| `parse_mode: "MarkdownV2"` | Rejeté — trop risqué pour contenu dynamique (18 chars à échapper, rejet silencieux) |
| `editMessageText` avec `parse_mode` | Requis pour utilities.ts:323 (R6) |
| `blockquote`, `tg-spoiler` | Hors scope — non adopté (R4 niveau minimaliste) |
| `setMyCommands`, message pinning, reactions | Hors scope |

### Exemple de conversation — /backlog avant/après

**Avant (plain text) :**
```
Backlog

-- En cours --
  🔴 [SDD] Migrer auth middleware (S23)  [a1b2c3d4]
  🟡 Corriger bug webhook  [e5f6a7b8]

-- A faire --
  🟢 Ajouter tests coverage  [c9d0e1f2]
```

**Après (HTML) :**
```
Backlog

En cours  ← rendu en gras par Telegram
  🔴 [SDD] Migrer auth middleware (S23)  a1b2c3d4  ← ID en monospace
  🟡 Corriger bug webhook  e5f6a7b8

A faire  ← rendu en gras
  🟢 Ajouter tests coverage  c9d0e1f2
```

---

## Section 6 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/tasks.ts` | Modifier | Migrer `formatBacklog` et `formatSprintSummary` vers HTML (R1, R3, R4) |
| `src/pipeline-tracker.ts` | Modifier | Migrer `formatStatusBar` vers HTML, retirer commentaire "Plain-text only" (R1, R3, R4) |
| `src/memory/ideas.ts` | Modifier | Migrer `formatIdeasList` vers HTML, retirer commentaire "plain text, no markdown" (R1, R3, R4) |
| `src/commands/quality.ts` | Modifier | Migrer `formatMetrics` et `formatMetricsComparison` vers HTML ; passer les 5 appels `sendResponse` sur formatMetrics/formatMetricsComparison/formatAlerts à `sendResponseHtml` (R1, R3) |
| `src/alerts.ts` | Modifier | Migrer `formatMonitoringStats` et `formatAlerts` vers HTML (R1, R3) |
| `src/memory/graph.ts` | Modifier | Migrer `formatMemoryHealth` vers HTML (R1, R3) |
| `src/bot-context.ts` | Modifier | Adapter `sendVoiceResponse` : ajouter strip HTML + décodage entités avant le strip Markdown (R5) |
| `src/commands/tasks.ts` | Modifier | Passer les 4 appels `sendResponse(ctx, formatBacklog(...))` et `sendResponse(ctx, formatSprintSummary(...))` à `sendResponseHtml` (R1) |
| `src/commands/memory-cmds.ts` | Modifier | Passer les 3 appels `sendResponse` sur `formatIdeasList` (L228, L235) et `formatMemoryHealth` (L51) à `sendResponseHtml` (R1) |
| `src/commands/help.ts` | Modifier | Passer `ctx.reply(parts.join("\n"), threadOpts(ctx))` (L226) à `ctx.reply(parts.join("\n"), { ...threadOpts(ctx), parse_mode: "HTML" })` (R1) |
| `src/commands/sdd-flow.ts` | Modifier | Passer `ctx.reply(\`Job lance...\n${statusBar}\`, bctx.threadOpts(ctx))` (L289-292) à `{ ...bctx.threadOpts(ctx), parse_mode: "HTML" }` ; escapeHtml sur `jobId` et `name` (R1, R3, R6) |
| `src/commands/utilities.ts` | Modifier | Ajouter `parse_mode: "HTML"` au `ctx.editMessageText` (L323) utilisant `formatSprintSummary` (R6) |
| `CLAUDE.md` | Modifier | Préciser règle ligne 175 : distinguer réponses LLM (plain text) et formatage bot-side (HTML) (R8) |
| `tests/unit/tasks.test.ts` | Modifier | Mettre à jour assertions de `formatBacklog` et `formatSprintSummary` pour vérifier HTML (`<b>`, `<code>`) |
| `tests/unit/pipeline-tracker.test.ts` | Modifier | Mettre à jour assertions `formatStatusBar` (V5, V6, V7, V14) pour vérifier HTML |
| `tests/unit/memory.test.ts` | Modifier | Mettre à jour assertions `formatIdeasList` pour vérifier HTML |
| `tests/unit/memory-evolution.test.ts` | Modifier | Mettre à jour assertions `formatMemoryHealth` pour vérifier HTML |
| `tests/unit/monitoring.test.ts` | Modifier | Mettre à jour assertions `formatMonitoringStats` pour vérifier `<b>` sections |
| `tests/unit/bot-context.test.ts` | Modifier | Ajouter test V7 : `sendVoiceResponse` strip HTML avant TTS |
| `tests/unit/sdd-backlog-link.test.ts` | Modifier | Mettre à jour assertions V5/V14 `formatBacklog` SDD tag pour accepter HTML |
| `tests/integration/ideas-lifecycle.test.ts` | Modifier | Mettre à jour assertions `formatIdeasList` pour HTML |

---

## Section 7 — Patterns existants

### `escapeHtml()` — `src/bot-context.ts:628-630`
```typescript
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```
Exportée, déjà utilisée dans `commands/documents.ts`. Patron mature à réutiliser pour **toutes** les interpolations de contenu dynamique dans les chaînes HTML.

### `sendResponseHtml()` — `src/bot-context.ts:665-696`
```typescript
function sendResponseHtml(ctx: Context, response: string): Promise<void> {
  const opts = { ...threadOpts(ctx), parse_mode: "HTML" as const };
  // même logique de chunking que sendResponse (4000 chars, split sur \n\n / \n / espace)
  return ctx.reply(response, opts).then(() => {});
}
```
Déjà exposée dans `BotContext` (L141). Pas de nouveau code d'infrastructure nécessaire.

### Pattern de référence production — `src/commands/documents.ts:82-118`
```typescript
function formatDocumentLineHtml(doc: Document): string {
  const title = escapeHtml(doc.title || "Sans titre");
  const desc = doc.description ? ` — ${escapeHtml(doc.description)}` : "";
  return doc.url
    ? `<a href="${doc.url}">${title}</a>${desc}`
    : `${title}${desc}`;
}
```
Patron validé en production : `escapeHtml()` sur le contenu dynamique, template littéral HTML, envoi via `sendResponseHtml`. À généraliser.

---

## Section 8 — Contraintes

1. **Signatures inchangées** : aucune modification des signatures des fonctions de formatage. Les callers existants ne doivent pas être cassés par la migration (seul le contenu HTML change).

2. **Invariant LLM** : les réponses générées par `callClaude` sont **toujours** envoyées via `sendResponse` (plain text). Ne jamais passer le résultat brut de `callClaude` à `sendResponseHtml` — risque de rendu involontaire si Claude génère accidentellement des `<` ou `>`. Le prompt système (`bot-context.ts:553`) interdit déjà le Markdown dans les réponses LLM, mais pas les caractères `<>`.

3. **Ordre strip TTS** : dans `sendVoiceResponse`, le strip HTML doit précéder le strip Markdown. Sinon, un `**<b>mot</b>**` serait partiellement nettoyé par le strip Markdown en `<b>mot</b>` que le TTS lirait littéralement.

4. **`ctx.editMessageText`** : `utilities.ts:323` édite un message de notification avec `formatSprintSummary`. Après migration, l'edit doit inclure `parse_mode: "HTML"`. Aucun autre `editMessageText` dans le codebase actuel n'est affecté par cette migration.

5. **Tests** : `bun test` doit passer intégralement. Les tests des fonctions de formatage qui vérifient du contenu plain text spécifique (ex: `expect(result).toContain("-- En cours --")`) doivent être mis à jour pour vérifier HTML (ex: `expect(result).toContain("<b>En cours</b>")`).

6. **`formatRetro` exclue** : la rétro est du contenu LLM dynamique envoyé via `sendResponse`. Elle ne migre pas vers HTML (R2).

7. **`notification-queue.ts` et `job-manager.ts` exclus** : hors scope pour cette spec. Les notifications et messages de progression restent plain text (pas de formatage statique à enrichir).

---

## Section 9 — Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|-------------|--------|
| V1 | `formatBacklog` retourne `<b>En cours</b>` (ou autre section présente) quand des tâches en cours existent | `expect(result).toContain("<b>En cours</b>")` | unit |
| V2 | `formatBacklog` retourne `<code>${id}</code>` pour l'ID tronqué d'une tâche | `expect(result).toContain("<code>")` | unit |
| V3 | `formatBacklog` échappe les caractères spéciaux dans les titres de tâches | titre `"<XSS>"` → `"&lt;XSS&gt;"` dans le résultat | unit |
| V4 | `formatBacklog` conserve l'indicateur `[SDD]` pour les tâches avec `sdd_pipeline_name` | `expect(result).toContain("[SDD]")` | unit |
| V5 | `formatSprintSummary` retourne `<b>Sprint S12</b>` pour sprint_id "S12" | `expect(result).toContain("<b>Sprint S12</b>")` | unit |
| V6 | `formatStatusBar` retourne `<b>Pipeline « nom »</b>` comme première ligne | `expect(lines[0]).toContain("<b>Pipeline")` | unit |
| V7 | `formatStatusBar` enveloppe le nom de l'artifact dans `<code>` | `expect(result).toContain("<code>")` quand step.artifact est défini | unit |
| V8 | `formatIdeasList` retourne `<b>IDEES (n)</b>` comme header | `expect(result).toContain("<b>IDEES")` | unit |
| V9 | `formatIdeasList` retourne `<code>` pour les IDs tronqués | `expect(result).toContain("<code>")` | unit |
| V10 | `formatMetrics` retourne `<b>Metriques Sprint S23</b>` comme titre | `expect(result).toContain("<b>Metriques Sprint")` | unit |
| V11 | `formatMetricsComparison` retourne `<b>Evolution des sprints</b>` | `expect(result).toContain("<b>Evolution des sprints</b>")` | unit |
| V12 | `formatMonitoringStats` retourne `<b>Temps de reponse:</b>` (ou équivalent) comme section header | `expect(result).toContain("<b>")` | unit |
| V13 | `formatAlerts` échappe le contenu dynamique des messages d'alerte | alerte avec message `"a <b> c"` → `"a &lt;b&gt; c"` | unit |
| V14 | `sendVoiceResponse` strip les balises HTML avant TTS — le texte passé à `synthesize()` ne contient pas de `<b>` | mocker `synthesize`, vérifier que l'arg reçu ne contient pas `<b>` | unit |
| V15 | `sendVoiceResponse` décode les entités HTML — `&amp;` devient `&` dans le texte passé à `synthesize()` | mocker `synthesize`, vérifier que l'arg contient `&` et non `&amp;` | unit |
| V16 | `formatRetro` n'est pas envoyée via `sendResponseHtml` (invariant LLM) | `grep -n "sendResponseHtml" src/commands/quality.ts` ne contient pas `formatRetro` | integration |
| V17 | `bun test` passe intégralement après la migration | CI green, 0 failing tests | integration |
| V18 | CLAUDE.md règle ligne 175 distingue "LLM responses: plain text" et "bot-side formatting: HTML" | Lire CLAUDE.md — nouvelle formulation présente | manual |

---

## Section 10 — Coverage et zones d'ombre

### Matrice des dimensions explorées

| Dimension | Couverture | Décision |
|-----------|-----------|---------|
| **Problème** | Complet | Incohérence actuelle diagnostiquée (plain text violé en prod dans documents.ts) et feedback UX confirmé |
| **Périmètre** | Complet | 7 fonctions de formatage identifiées + callers + sendVoiceResponse + CLAUDE.md. Exclusions explicites : formatRetro (LLM), notification-queue, job-manager |
| **Validation** | Complet | 18 V-critères couvrant chaque fonction migrée + TTS + invariant LLM + CI |
| **Technique** | Complet | Infrastructure déjà en place (escapeHtml, sendResponseHtml, patron documents.ts). Contrainte editMessageText utilities.ts:323 identifiée. Ordre strip TTS spécifié |
| **UX Telegram** | Complet | Exemples avant/après pour chaque commande. Features HTML évaluées (blockquote/spoiler rejetés pour v1) |

### Questions de l'exploration resolues

| # | Question (exploration §6) | Décision |
|---|--------------------------|---------|
| Q1 | Enrichir les `ctx.reply()` simples (confirmations, erreurs) ou uniquement les fonctions de listing ? | **Hors scope** : seules les fonctions de formatage statiques migrent. Les messages de confirmation/erreur ad hoc restent plain text via `sendResponse`. |
| Q2 | Niveau de richesse HTML : minimaliste ou étendu (blockquote, spoiler) ? | **Minimaliste** : `<b>`, `<code>`, `<a href>` uniquement (R4). Blockquote et spoiler réservés à une spec future si besoin identifié. |
| Q3 | Fonction helper `htmlTag()` ou templates littéraux directs ? | **Templates littéraux directs**, comme dans documents.ts (patron validé). Pas de helper supplémentaire. |
| Q4 | Migration en PR unique ou progressive par commande ? | **PR unique** : les fonctions de formatage sont indépendantes, le changement est cohérent, et un PR unique évite une période intermédiaire où certaines commandes sont en HTML et d'autres en plain text. |

### Zones d'ombre non résolues

| Zone | Description | Impact |
|------|-------------|--------|
| `notification-queue.ts` | Les notifications batched n'ont pas de parse_mode. Le contenu (titres de tâches) est dynamique et pourrait bénéficier de HTML. | Faible — hors scope v1. À traiter dans une spec dédiée "amélioration UX notifications". |
| `job-manager.ts` | Messages de progression des jobs background (démarrage, résultat) sont plain text. | Faible — hors scope v1. Les messages de jobs sont courts et occasionnels. |
| `formatLlmOpsSnapshot` (`help.ts:219`) | Appelé aux côtés de `formatMonitoringStats` dans `/monitor`. Si `formatLlmOpsSnapshot` retourne plain text et est concaténé avec `formatMonitoringStats` (HTML), le résultat sera envoyé en HTML. Toute balise dans le snapshot LLM-Ops sera interprétée. | À vérifier lors de l'implémentation : si `formatLlmOpsSnapshot` contient du contenu dynamique, appliquer `escapeHtml` sur ses variables internes. |
