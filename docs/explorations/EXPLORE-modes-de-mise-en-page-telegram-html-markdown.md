---
phase: 0-explore
generated_at: "2026-03-25T00:00:00+01:00"
subject: "Modes de mise en page Telegram : HTML vs MarkdownV2 vs plain text"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Probleme

Le codebase applique aujourd'hui une convention stricte "plain text only" pour toutes les réponses Telegram (règle CLAUDE.md ligne 175 : "Telegram responses: plain text only, no markdown formatting"). Cette règle est formulée dans le prompt système (bot-context.ts:553) et documentée comme convention d'équipe.

Or, deux constats contradictoires émergent :

1. **HTML est déjà utilisé en production** : `sendResponseHtml` existe dans `bot-context.ts` et est appelé depuis `commands/documents.ts` pour afficher des liens cliquables (`<a href>`). La convention "plain text" est donc déjà contournée pour les cas où les URLs signées Supabase sont disponibles.

2. **L'UX souffre de cette contrainte** : le feedback `feedback_ux_telegram.md` note une frustration UX récurrente liée à l'absence d'exploitation des capacités Telegram. La mise en page hiérarchique (gras pour les titres, code pour les IDs, liens cliquables) améliorerait significativement la lisibilité des commandes `/backlog`, `/sprint`, `/brain`, `/metrics`, `/docs`, et des réponses SDD.

L'exploration vise à évaluer quel mode de formatage adopter de manière cohérente sur l'ensemble du bot, en remplaçant le patchwork actuel (plain text majoritaire + HTML ad hoc dans documents.ts).

---

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | https://core.telegram.org/bots/api#formatting-options | Doc officielle | 2026-03-25 | 3 modes : HTML, MarkdownV2, Markdown (legacy). Tableau complet des tags supportés, règles d'imbrication, entités avancées (blockquote, spoiler, custom_emoji, date_time depuis mars 2026) | Haute |
| 2 | https://grammy.dev/plugins/parse-mode | Doc plugin grammY | 2026-03-25 | Plugin `parse-mode` officiel grammY : tagged template `fmt` + classe `FormattedString`, gestion automatique des offsets d'entités, pas besoin d'échapper manuellement | Haute |
| 3 | https://grammy.dev/guide/basics | Doc grammY | 2026-03-25 | Exemples d'usage `parse_mode: "HTML"` et `parse_mode: "MarkdownV2"` dans l'API grammY, mention du plugin parse-mode | Haute |
| 4 | https://postly.ai/telegram/telegram-markdown-formatting | Article | 2026-03-25 | Comparatif pratique MarkdownV2 vs HTML : HTML recommandé pour les bots complexes, MarkdownV2 sujet aux rejets API si un caractère spécial est manqué | Moyenne |
| 5 | https://github.com/EdJoPaTo/telegram-format | Bibliothèque | 2026-03-25 | Librairie externe pour formatter du Markdown/HTML Telegram, approche alternative au plugin grammY natif | Faible |

### Synthèse des enseignements

**Mode HTML** : balises `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`, `<blockquote>`, `<tg-spoiler>`. Seuls `&`, `<` et `>` doivent être échappés (`&amp;`, `&lt;`, `&gt;`). C'est le mode le plus sûr pour un bot : les erreurs d'échappement sont rares et prévisibles. En cas de contenu dynamique (titres de tâches, noms de projets), `escapeHtml()` sur les variables suffit.

**Mode MarkdownV2** : syntaxe familière mais piégeuse. 18 caractères spéciaux doivent tous être échappés avec `\` dans le texte littéral. Un seul caractère oublié dans une chaîne dynamique (ex : un point dans un nom de fichier, un tiret dans un ID) cause un rejet silencieux de tout le message par l'API Telegram. Inadapté pour du contenu dynamique riche.

**Mode Markdown (legacy)** : à éviter. Pas de support underline/strikethrough/spoiler/blockquote. Conservé uniquement pour compatibilité ascendante.

**Entités sans parse_mode** : l'API accepte aussi un tableau `entities` (objets `MessageEntity` avec offset/length/type). Complexe à construire manuellement mais c'est ce que fait le plugin grammY `parse-mode` sous le capot via `fmt`. Avantage : aucune injection possible via le contenu, parfaitement sûr, mais overhead de développement.

**Mise à jour mars 2026** : nouveau type d'entité `date_time` pour des dates formatées automatiquement selon la locale de l'utilisateur.

---

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/bot-context.ts:628-695` | `escapeHtml()` déjà implémenté, `sendResponse()` (plain text) et `sendResponseHtml()` (parse_mode HTML) coexistent. Les deux sont exposés dans `BotContext`. | Direct — point d'extension naturel |
| 2 | `src/commands/documents.ts:82-118` | Seul module utilisant HTML activement : `formatDocumentLineHtml`, `formatDocumentDetailHtml`, appels `sendResponseHtml` conditionnels selon présence d'URL signées. Patron de référence. | Direct — pattern à généraliser |
| 3 | `src/bot-context.ts:553` | Prompt système Claude : "IMPORTANT: Never use markdown formatting in your responses..." — règle explicite pour les réponses LLM, indépendante du formatage bot | Indirect — ne pas confondre avec le formatage bot-side |
| 4 | `src/pipeline-tracker.ts:251` | `formatStatusBar()` : commentaire "Plain-text only (Telegram convention)". Pipeline SDD serait amélioré avec icônes bold/code. | Direct — candidat à la migration HTML |
| 5 | `src/tasks.ts` | `formatBacklog`, `formatSprintProgress` : plain text avec emojis et symboles ASCII (✓, ●, etc). Amélioration lisible avec HTML (gras sur les noms de tâche, code sur les IDs) | Direct |
| 6 | `src/memory/ideas.ts:159` | `formatIdeasList()` : commentaire "plain text, no markdown". Candidat à enrichissement. | Direct |
| 7 | `src/memory/graph.ts:397,649` | `formatMemoryClusters`, `formatMemoryHealthStats` : même pattern plain text explicite | Direct |
| 8 | `src/alerts.ts:505,554` | `formatMonitoringStats`, section Formatting : plain text | Direct |
| 9 | `src/commands/zz-messages.ts:699-706` | `sendVoiceResponse` : strip des balises markdown (**, *, `, #) avant TTS — ce nettoyage devra inclure les balises HTML si HTML est utilisé | Indirect — compatibilité TTS |
| 10 | `src/commands/help.ts` | Menu aide : texte de commandes, descriptions — HTML améliorerait la lisibilité des menus | Direct |
| 11 | `src/notification-queue.ts:181-184` | `sendMessage` avec opts standard — pas de parse_mode défini, reste plain text pour les notifications | Direct |
| 12 | `src/job-manager.ts:107,557-559` | Messages de progression/résultat jobs — pas de parse_mode | Direct |

**Points de friction identifiés :**
- `sendVoiceResponse` strip les balises Markdown (`**`, `*`, etc.) mais pas les balises HTML `<b>`, `<i>`, etc. — risque de lire "<b>mot</b>" à voix haute si HTML activé globalement sans adapter le strip.
- Contenu LLM dynamique dans les réponses Claude : le prompt système interdit déjà le Markdown dans les réponses LLM. Si on active HTML pour les formatages bot-side (fonctions de formatting statiques), il faut maintenir la séparation claire : contenu LLM → toujours plain text (envoyé via `sendResponse`), contenu bot-side → HTML via `sendResponseHtml`.
- `editMessageText` (sdd-flow.ts, documents.ts) : si le message original a été envoyé avec `parse_mode: "HTML"`, la modification doit aussi l'inclure, sinon Telegram rejette l'édition.

**Actifs réutilisables :**
- `escapeHtml()` déjà exportée et utilisée dans documents.ts — patron mature
- `sendResponseHtml()` déjà dans BotContext — pas de nouveau code d'infrastructure nécessaire
- Pattern conditionnel dans documents.ts (plain text si pas d'URLs, HTML si URLs signées) — à simplifier en cible unique HTML

---

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo (plain text) | B: HTML pour le formatage bot-side | C: MarkdownV2 global | D: Plugin grammY parse-mode (entités) |
|---------|:--------------------------:|:-----------------------------------:|:--------------------:|:--------------------------------------:|
| **Complexite** (obligatoire) | S (rien à faire) | M (migration des fonctions de formatting, adaptation TTS strip) | L (échappement systématique, risque de bugs) | L (refactoring profond, dépendance nouvelle) |
| **Valeur ajoutee** (obligatoire) | Low (UX pauvre, feedback reçu) | High (liens cliquables, gras/code, lisibilité ++, cohérence avec documents.ts existant) | High (même UX) | High (même UX + sécurité maximale) |
| **Risque technique** (obligatoire) | Low (stable mais dégradé) | Low (HTML est le mode le plus robuste, escapeHtml() mature, patron déjà validé en prod) | High (tout caractère spécial non échappé rejette le message entier, bugs silencieux) | Med (plugin stable mais overhead architectural, pas dans package.json actuel) |
| *Impact maintenance* (si pertinent) | Neutre | Faible — convention simple : HTML pour fonctions de formatting, plain text pour LLM | Élevé — discipline d'échappement à maintenir sur tout contenu dynamique | Faible à terme, fort à court terme (migration) |
| *Reversibilite* (si pertinent) | N/A | Bonne — `sendResponse` reste, migration progressive possible | Mauvaise — un seul bug casse tout un message | Bonne mais irréversible architecturalement |

**Discussion par option :**

**A — Status quo** : la convention plain text est cohérente mais pénalise l'UX. Elle est déjà violée en production (documents.ts) sans stratégie unifiée. Maintenir le status quo crée une dette d'incohérence croissante.

**B — HTML pour le formatage bot-side** : option recommandée. HTML est le mode le plus robuste du Bot API : seuls 3 caractères à échapper, aucun risque de rejet message sur du contenu dynamique, et `escapeHtml()` est déjà implémentée et testée. La migration est progressive : enrichir les fonctions de formatting existantes (`formatBacklog`, `formatStatusBar`, `formatIdeasList`, etc.) une par une, en utilisant exclusivement `sendResponseHtml` pour ces fonctions. Les réponses LLM restent en plain text via `sendResponse`. Le TTS strip doit être adapté pour supprimer les balises HTML.

**C — MarkdownV2 global** : syntaxe familière mais piège opérationnel. Les titres de tâches, noms de fichiers, chemins, et IDs contiennent fréquemment des caractères spéciaux (`.`, `-`, `(`, `)`, `_`). Un seul caractère non échappé dans une chaîne dynamique cause le rejet silencieux du message par Telegram. Trop risqué pour un bot de productivité dont les données proviennent d'un LLM ou d'inputs utilisateur.

**D — Plugin grammY parse-mode (entités)** : approche la plus safe techniquement (pas d'injection possible) mais overhead architectural significatif. Pas justifié pour un bot monolithique interne où le contenu est maîtrisé. À reconsidérer si le bot devient public ou multi-tenant.

---

## Section 5 — Verdict et justification

**GO — Adopter HTML comme mode de formatage standard pour les fonctions de formatting bot-side**

Le codebase contient déjà tous les fondamentaux pour une adoption propre et progressive de HTML : `escapeHtml()` exportée, `sendResponseHtml()` dans BotContext, et un patron de référence validé en production dans `commands/documents.ts`. La règle "plain text only" du CLAUDE.md cible les *réponses LLM* (pour éviter que Claude génère du Markdown rendu comme texte brut), pas le formatage *bot-side* des fonctions statiques de listing — cette distinction doit être formalisée.

L'axe 1 (état de l'art) confirme qu'HTML est unanimement recommandé pour les bots complexes avec contenu dynamique : règles d'échappement minimales (3 caractères), aucun risque de rejet silencieux, support complet des entités avancées (blockquote, code, liens). L'axe 2 (archéologie) identifie une dizaine de modules candidats à l'enrichissement, tous utilisant des fonctions de formatting statiques indépendantes du LLM. L'axe 3 (matrice) montre que HTML est l'option à meilleur ratio valeur/risque : valeur High, risque Low, complexité M.

Le seul point d'attention est la compatibilité TTS : `sendVoiceResponse` doit être adapté pour stripper les balises HTML avant synthèse vocale.

---

## Section 6 — Input pour etape suivante

### Option recommandée
**HTML comme mode de formatage standard bot-side**, avec `sendResponseHtml` + `escapeHtml` pour toutes les fonctions de formatting statiques. Les réponses LLM (`callClaude`) restent en plain text via `sendResponse`.

### Distinction de convention à formaliser
- `sendResponse` : pour le contenu LLM (toujours plain text, Claude ne génère pas de HTML)
- `sendResponseHtml` : pour les fonctions de formatting bot-side statiques (listes, tableaux de bord, status bars)

### Fichiers concernés par la migration (par priorité)
1. `src/pipeline-tracker.ts` — `formatStatusBar()` : bold sur les phases, code sur les noms de pipeline
2. `src/tasks.ts` — `formatBacklog()`, `formatSprintProgress()` : bold sur les titres, code sur les IDs
3. `src/memory/ideas.ts` — `formatIdeasList()` : bold sur les titres d'idées
4. `src/commands/quality.ts` — messages de métriques, rétro
5. `src/alerts.ts` — `formatMonitoringStats()`
6. `src/memory/graph.ts` — `formatMemoryClusters()`, `formatMemoryHealthStats()`
7. `src/notification-queue.ts` — notifications avec `parse_mode: "HTML"` optionnel
8. `src/commands/zz-messages.ts:699-706` — adapter `sendVoiceResponse` pour strip HTML

### Contraintes identifiées
- `sendVoiceResponse` : ajouter strip des balises HTML (`.replace(/<[^>]+>/g, "")`) avant TTS
- `ctx.editMessageText` : inclure `parse_mode: "HTML"` si le message original était HTML
- Convention à documenter dans CLAUDE.md : distinguer "LLM responses → plain text" de "bot-side formatting → HTML"
- Ne pas utiliser `parse_mode: "HTML"` pour le contenu LLM brut (risque si Claude génère accidentellement des `<` ou `>`)

### Questions ouvertes pour la spec
1. Faut-il enrichir également les messages de `ctx.reply()` simples (confirmations, erreurs) ou uniquement les fonctions de listing/formatting ?
2. Quel niveau de richesse HTML viser ? Minimaliste (bold + code + liens) ou étendu (blockquote pour le SDD, spoiler pour les infos sensibles) ?
3. Faut-il une fonction helper `htmlTag(tag, content)` ou garder les templates littéraux directs comme dans documents.ts ?
4. Stratégie de migration : tous les modules en une PR ou progressive par commande ?

## Verdict

GO

HTML est le mode optimal pour le bot : infrastructure déjà en place, patron validé en prod dans documents.ts, risque technique minimal, valeur UX haute. La migration des fonctions de formatting statiques vers HTML est une amélioration cohérente qui résout l'incohérence actuelle sans impact sur la logique LLM.
