---
phase: 0-explore
generated_at: "2026-03-25T14:30:00Z"
subject: "Amelioration de la mise en page HTML des commandes Telegram"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Amelioration de la mise en page HTML des commandes Telegram

## Section 1 — Probleme

Le bot Telegram utilise actuellement un formatage HTML minimaliste pour ses commandes (/backlog, /sprint, /metrics, /alerts, /brain, /ideas, /monitor, /docs, /cost, /jobs, /feature). Les reponses sont fonctionnelles mais visuellement monotones : texte brut avec quelques balises `<b>` et `<code>`, pas de separateurs visuels, pas d'utilisation des capacites avancees de Telegram (blockquote, underline, strikethrough, expandable blockquote, liens inline, custom emoji via tg-emoji).

Ce manque de mise en page impacte la lisibilite, la hierarchie visuelle de l'information, et l'experience utilisateur globale. Une exploration est necessaire avant specification pour :
1. Inventorier exhaustivement les balises HTML supportees par Telegram Bot API
2. Identifier les patterns UX utilises par les bots Telegram populaires
3. Auditer chaque fonction de formatage existante et proposer des ameliorations concretes
4. Evaluer l'effort et les risques d'une migration vers un formatage plus riche

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Telegram Bot API - Formatting options](https://core.telegram.org/bots/api#formatting-options) | Documentation officielle | 2026-03 | Reference officielle des balises HTML supportees, limites, entites | Haute |
| 2 | [Telegram Styled Text Entities](https://core.telegram.org/api/entities) | Documentation officielle | 2026-03 | Liste complete des MessageEntity types (bold, italic, blockquote, expandable_blockquote, custom_emoji, date_time) | Haute |
| 3 | [GramIO - Formatting messages in Telegram bots](https://gramio.dev/formatting) | Guide technique | 2026-03 | Table exhaustive des balises HTML supportees avec exemples et limites | Haute |
| 4 | [grammY ParseMode reference](https://grammy.dev/ref/types/parsemode) | Documentation framework | 2026-03 | Reference ParseMode pour grammY (framework utilise par le projet) | Moyenne |

### Synthese des enseignements cles

**Balises HTML supportees par Telegram Bot API (Bot API 9.3+) :**

| Balise | Rendu | Usage recommande |
|--------|-------|-----------------|
| `<b>`, `<strong>` | **Gras** | Titres, labels, valeurs cles |
| `<i>`, `<em>` | *Italique* | Descriptions, notes secondaires |
| `<u>`, `<ins>` | Souligne | Accent sur elements importants |
| `<s>`, `<strike>`, `<del>` | ~~Barre~~ | Elements obsoletes, taches annulees |
| `<code>` | `Monospace inline` | IDs, valeurs techniques, commandes |
| `<pre>` | Bloc preformate | Blocs de code, donnees tabulaires |
| `<pre><code class="language-X">` | Bloc colore | Code source avec syntax highlighting |
| `<a href="URL">` | Lien cliquable | URLs, mentions utilisateur |
| `<blockquote>` | Citation | Citations, notes, contexte additionnel |
| `<blockquote expandable>` | Citation repliable | Contenu long optionnel (details, historique) |
| `<tg-spoiler>` | Spoiler (tap to reveal) | Contenu sensible, reponses quiz |
| `<tg-emoji emoji-id="ID">` | Custom emoji | Emojis personnalises premium |

**Contraintes critiques identifiees :**
- Pas de `<br>` : utiliser `\n` pour les sauts de ligne
- Pas de `<table>` : les tableaux doivent etre simules avec `<pre>` ou espaces
- `<code>` et `<pre>` ne peuvent PAS etre combines avec d'autres balises de formatage (pas de gras dans du code)
- Pas de listes HTML (`<ul>`, `<ol>`, `<li>`) dans le parse_mode natif — GramIO les supporte via conversion interne, mais pas grammY/Telegram directement
- Blockquotes non nestables
- Limite de 4096 caracteres par message (le chunking existe deja dans sendResponseHtml)
- Tous les `<`, `>`, `&` hors balises doivent etre escapes (deja gere par escapeHtml)

**Patterns UX observes chez les bots populaires :**
1. **Separateurs visuels** : lignes `─────────` (caracteres Unicode box-drawing) entre sections
2. **Indicateurs de statut** : emojis Unicode standards (pas custom) pour etats visuels
3. **Hierarchie a 2 niveaux** : titre en `<b>` + sous-sections avec indentation et `<i>` pour labels
4. **Valeurs cles en monospace** : `<code>` pour les chiffres, IDs, pourcentages
5. **Barres de progression** : caracteres Unicode block (petit a grand) pour visualiser des pourcentages
6. **Blockquotes pour contexte** : notes et explications en blockquote pour separer du contenu principal
7. **Expandable blockquotes** : details optionnels que l'utilisateur peut deplier

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/tasks.ts` (L213-276) | `formatTask`, `formatBacklog`, `formatSprintSummary` — utilise `<b>`, `<code>`, `escapeHtml`. Pas de separateurs, pas de barres de progression, pas de blockquote | Eleve |
| 2 | `src/commands/quality.ts` (L153-188) | `formatMetrics`, `formatMetricsComparison` — barres `=` basiques, pas d'indicateurs visuels de tendance | Eleve |
| 3 | `src/alerts.ts` (L509-573) | `formatMonitoringStats`, `formatAlerts` — icones `!!`/`!`/`~` en texte, `<b>` pour titres, `<code>` pour roles | Moyen |
| 4 | `src/memory/ideas.ts` (L162-177) | `formatIdeasList` — une seule ligne par idee, pas de separateurs, statut en texte brut | Moyen |
| 5 | `src/memory/graph.ts` (L400-417, L652-684) | `formatClusters` (plain text!), `formatMemoryHealth` — `formatClusters` n'utilise PAS HTML, `formatMemoryHealth` utilise `<b>` basique | Moyen |
| 6 | `src/commands/documents.ts` (L74-118) | `formatDocumentLine`, `formatDocumentLineHtml`, `formatDocumentDetail`, `formatDocumentDetailHtml` — double implementation (plain + HTML), liens `<a>` | Faible |
| 7 | `src/pipeline-tracker.ts` (L254-284) | `formatStatusBar` — utilise des STATUS_SYMBOLS, `<b>`, `<code>`, bien structure | Faible |
| 8 | `src/llm-ops.ts` (L218-248, L505-540) | `formatCostSummary` (plain text!), `formatLlmOpsSnapshot` (HTML) — inconsistance : cost en plain, monitoring en HTML | Moyen |
| 9 | `src/job-manager.ts` (L677-711) | `formatJobList` — plain text, pas de HTML, formatage pipe-delimited | Moyen |
| 10 | `src/feature-flags.ts` (L57-67) | `formatFeatures` — plain text, ON/OFF basique | Faible |
| 11 | `src/notification-queue.ts` (L74-81) | `formatPrefs` — plain text, pas de HTML | Faible |
| 12 | `src/commands/quality.ts` (L291-321) | `formatRetro` — plain text! Non HTML malgre sendResponseHtml dans le callsite | Moyen |
| 13 | `src/html-utils.ts` | `escapeHtml` — ne couvre que les 5 entites de base. Suffisant pour Telegram | Aucun |
| 14 | `src/bot-context.ts` (L631-695) | `sendResponse` (plain), `sendResponseHtml` (HTML) — chunking identique, 4000 chars max | Aucun |

**Points de friction identifies :**
- **Inconsistance plain text vs HTML** : `formatCostSummary`, `formatJobList`, `formatFeatures`, `formatPrefs`, `formatRetro`, `formatClusters` sont en plain text mais certains sont envoyes via `sendResponseHtml` (risque si le texte contient `<` ou `&` non escapes)
- **Absence d'un style guide unifie** : chaque format* a son propre style (certains avec indentation 2 espaces, d'autres sans, certains avec sections `<b>`, d'autres en MAJUSCULES)
- **Pas de composants reutilisables** : chaque fonction reconstruit les memes patterns (titre, separateur, liste d'items) sans helpers partages

**Actifs reutilisables :**
- `escapeHtml()` dans `src/html-utils.ts` — deja bien implemente et utilise partout
- `sendResponseHtml()` dans `src/bot-context.ts` — chunking fonctionnel
- Le pattern `lines.push()` + `lines.join("\n")` est universel — facile a enrichir
- `STATUS_SYMBOLS` dans `src/pipeline-tracker.ts` — bon precedent pour les indicateurs visuels
- `PRIORITY_LABELS` et `STATUS_LABELS` dans `src/tasks.ts` — pattern de mapping reutilisable

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Enrichissement incremental | C: Refactoring avec helpers HTML partages | D: Migration vers un template engine |
|---------|:------------:|:----------------------------:|:----------------------------------------:|:------------------------------------:|
| **Complexite** | S | S | M | L |
| **Valeur ajoutee** | Low | Med | High | High |
| **Risque technique** | Low | Low | Low | Med |
| *Impact maintenance* | Neutre | Faible (memes patterns) | Positif (DRY, consistance) | Negatif (dependance ajoutee) |
| *Reversibilite* | N/A | Totale | Totale | Difficile |

### Discussion par option

**A: Status quo** — Ne rien changer. Le formatage actuel fonctionne mais reste visuellement pauvre. L'inconsistance plain text/HTML est un risque latent (contenu non-escape). Aucun effort mais aucune amelioration UX.

**B: Enrichissement incremental** — Enrichir chaque `format*` individuellement en ajoutant des balises HTML avancees (`<blockquote>`, `<u>`, barres de progression Unicode, separateurs). Migration progressive des fonctions plain text vers HTML. Simple a implementer mais sans factorisation : chaque format* duplique les memes patterns d'affichage.

**C: Refactoring avec helpers HTML partages** — Creer un module `src/html-format-helpers.ts` avec des fonctions reutilisables (`sectionHeader`, `progressBar`, `separator`, `statusLine`, `kvLine`, `alertIcon`) puis migrer chaque `format*` vers ces helpers. Garantit la consistance visuelle, reduit la duplication, facilite les evolutions futures. Effort moyen mais valeur elevee.

**D: Migration vers un template engine** — Introduire un moteur de templates (handlebars, eta, etc.) pour separer structure et donnees. Overhead important, dependance externe, complexite disproportionnee pour le volume de templates (environ 15 fonctions de formatage). Non justifie pour ce projet.

## Section 5 — Verdict et justification

**Verdict : GO** — Option C recommandee (Refactoring avec helpers HTML partages)

**Justification :**

1. **Axe 1 (Etat de l'art)** : Telegram supporte des balises riches sous-exploitees par le projet (`<blockquote>`, `<blockquote expandable>`, `<u>`, barres de progression Unicode). Les patterns UX des bots populaires confirment que ces elements ameliorent significativement la lisibilite.

2. **Axe 2 (Archeologie)** : L'audit revele 6 fonctions en plain text qui devraient etre en HTML (`formatCostSummary`, `formatJobList`, `formatFeatures`, `formatPrefs`, `formatRetro`, `formatClusters`), une absence de style guide, et des patterns de duplication clairs. Un module de helpers centralise resoudrait ces 3 problemes simultanement.

3. **Axe 3 (Matrice)** : L'option C offre le meilleur ratio valeur/complexite. La complexite M est justifiee par la creation d'un seul nouveau module de helpers (estimee a ~150 LOC) + la migration des ~15 fonctions format* (modification unitaire par fonction, environ 5-15 lignes chacune). Le risque technique est faible car il s'agit uniquement de modifications de string formatting, sans impact sur la logique metier.

4. **Couverture test** : Le projet a 2029 tests. Chaque `format*` peut etre teste unitairement en verifiant la presence des balises HTML attendues, sans impact sur les tests existants (les tests actuels verifient le contenu, pas le formatage exact).

## Section 6 — Input pour etape suivante

### Input pour spec

**Option recommandee** : C — Refactoring avec helpers HTML partages

**Nouveau module a creer** : `src/html-format-helpers.ts`

Helpers proposes :
- `sectionTitle(text: string): string` — `<b>TEXT</b>` + separateur Unicode
- `separator(): string` — ligne Unicode `─────────────────────`
- `progressBar(current: number, total: number, width?: number): string` — barre Unicode (ex: `[████░░░░░░] 40%`)
- `kvLine(key: string, value: string | number): string` — `<i>key:</i> <code>value</code>`
- `statusIcon(severity: 'ok' | 'warning' | 'critical' | 'info'): string` — icones Unicode coherentes
- `bulletList(items: string[]): string` — liste avec indentation et puces Unicode
- `collapsibleSection(title: string, content: string): string` — `<blockquote expandable>` wrapper

**Fichiers concernes (par priorite)** :
1. `src/tasks.ts` — formatBacklog, formatSprintSummary, formatTask
2. `src/commands/quality.ts` — formatMetrics, formatMetricsComparison, formatRetro
3. `src/alerts.ts` — formatAlerts, formatMonitoringStats
4. `src/memory/ideas.ts` — formatIdeasList
5. `src/memory/graph.ts` — formatMemoryHealth, formatClusters (migration plain -> HTML)
6. `src/llm-ops.ts` — formatCostSummary (migration plain -> HTML), formatLlmOpsSnapshot
7. `src/job-manager.ts` — formatJobList (migration plain -> HTML)
8. `src/feature-flags.ts` — formatFeatures (migration plain -> HTML)
9. `src/notification-queue.ts` — formatPrefs (migration plain -> HTML)

**Contraintes identifiees** :
- Le barrel `src/html-utils.ts` existe deja — le nouveau module peut le completer ou etre separe (prefere separe pour eviter la croissance du barrel)
- Les fonctions plain text qui migrent vers HTML doivent aussi mettre a jour leurs callsites pour utiliser `sendResponseHtml` au lieu de `sendResponse`
- Les tests existants pour les format* devront etre mis a jour pour verifier les balises HTML
- Respecter la regle de 800 LOC max par fichier

**Questions ouvertes a resoudre pendant la spec** :
1. Faut-il utiliser `<blockquote expandable>` pour les sections longues (retro, patterns) ou garder tout visible ?
2. Les barres de progression doivent-elles utiliser des caracteres block Unicode ou des emoji (compatibilite client mobile vs desktop) ?
3. Faut-il un dark mode aware (les couleurs ne sont pas controllables, mais certains caracteres Unicode rendent differemment) ?
4. Le module helpers doit-il exporter un "theme" configurable ou des fonctions statiques ?
