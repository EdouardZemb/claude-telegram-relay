# Challenge Adversarial — SPEC-modes-de-mise-en-page-telegram-html-markdown.md

Verdict global: GO_WITH_CHANGES
Agents: 3/3 reussis

---

## Devil's Advocate — Rapport

## Devil's Advocate — Rapport

### Findings

---

**[BLOQUANT] F-DA-1 — `escapeHtml` n'échappe pas les guillemets : injection HTML dans les attributs `href`**
- Source : Section 7 — `escapeHtml()` / R3
- Description : La fonction `escapeHtml` n'échappe que `&`, `<`, `>`. Elle n'échappe pas `"` (`&quot;`) ni `'` (`&#39;`). R3 impose de l'utiliser sur "tout contenu dynamique intégré dans une chaîne HTML", y compris les URLs dans `href`. Si une URL contient un `"`, l'attribut est cassé ou exploitable.
- Impact : La règle R3 est inapplicable telle que formulée pour les attributs HTML — elle ne couvre que les contenus textuels. L'implémentation de référence dans `documents.ts` qui utilise `escapeHtml(url)` dans `href` est déjà défectueuse.
- Evidence : `src/bot-context.ts:629` — `return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");` — pas de `"` ni `'`.

---

**[BLOQUANT] F-DA-2 — `/monitor` concatène du HTML migré et du texte non échappé dans un seul `ctx.reply`**
- Source : Section 3 Zone d'ombre / Section 5 tableau / Section 6
- Description : `/monitor` dans `help.ts:213-226` concatène `formatMonitoringStats()` et `formatLlmOpsSnapshot()` via `parts.join("\n")`. Après migration, `formatMonitoringStats` retourne du HTML. `formatLlmOpsSnapshot` contient des variables dynamiques (`cb.reason`, `pv.role`) sans aucun `escapeHtml`. L'activation de `parse_mode: "HTML"` rendra ces variables vulnérables.
- Impact : Régression Telegram garantie si `cb.reason` ou un `pv.role` contient `<` ou `>` — message rejeté ou corrompu par l'API.
- Evidence : `src/commands/help.ts:213-226` concaténation directe. `src/llm-ops.ts:511` — `parts.push(\`  ${cb.role}: ${cb.reason}\`)` — aucun `escapeHtml`.

---

**[MAJEUR] F-DA-3 — La spec recense 4 appels `sendResponse` dans `tasks.ts` mais la concaténation `header + formatSprintSummary` n'est pas traitée**
- Source : Section 6 — `src/commands/tasks.ts` : "Passer les 4 appels `sendResponse`"
- Description : Deux des sites d'appel dans `tasks.ts` construisent `header + formatSprintSummary(...) + "\n\n" + formatBacklog(...)` dans une seule chaîne, puis appellent `sendResponse`. Le `header` (nom de projet) est du contenu dynamique non échappé. La spec ne mentionne pas ce cas.
- Impact : Si un nom de projet contient `<` ou `>`, le message HTML sera rejeté par Telegram.

---

**[MAJEUR] F-DA-4 — `formatRetro` exclue sous prétexte de "contenu LLM" alors que c'est une fonction de formatage statique**
- Source : Section 3 Note sur `formatRetro` / R2
- Description : La spec justifie l'exclusion de `formatRetro` en affirmant que "la rétro est générée par `callClaude`". Or `formatRetro` (`src/commands/quality.ts:288`) prend un `RetroRow` Supabase, pas une string LLM. La vraie raison d'exclusion (contenu narratif potentiellement risqué) est valide mais non exprimée — l'argument avancé est factuellement faux.
- Impact : La justification incorrecte fragilise la règle R2 et peut conduire à des décisions d'inclusion/exclusion incohérentes pour d'autres fonctions similaires.
- Evidence : `function formatRetro(retro: RetroRow | null): string` — signature avec `RetroRow`, pas de `callClaude`.

---

**[MAJEUR] F-DA-5 — `sendResponseHtml` découpe les chunks sans valider la fermeture des balises HTML**
- Source : Section 7 — `sendResponseHtml()` / R1
- Description : La fonction coupe les messages longs sur `\n\n`/`\n`/espace sans vérifier l'intégrité des balises HTML. Un découpage à cheval sur `<b>Titre très l` | `ong</b>` produit du HTML malformé rejeté par Telegram.
- Impact : Pour des listings verbeux (`formatMemoryHealth`, `formatMonitoringStats`), un chunk malformé génère une erreur API silencieuse sans diagnostic clair.
- Evidence : `src/bot-context.ts:679-688` — découpage sans vérification d'intégrité HTML. Spec Section 7 : "même logique de chunking que sendResponse" présentée comme garantie suffisante.

---

**[MAJEUR] F-DA-6 — L'assertion "aucun autre `editMessageText` affecté" n'est pas étayée par une recherche exhaustive**
- Source : Section 8 contrainte 4 / R6
- Description : La spec affirme que `utilities.ts:323` est le seul `editMessageText` affecté, sans prouver cette unicité par une recherche dans le codebase. D'autres occurrences existent (`documents.ts:547`, `profile.ts:134`, `help.ts:59/80/91`) mais ne sont pas affectées dans le scope actuel.
- Impact : L'assertion non étayée crée un risque si une future refactorisation ajoute un `editMessageText` sur une fonction migrée sans que R6 soit rappelée.

---

**[MINEUR] F-DA-7 — Les références à des numéros de ligne dans la spec sont volatiles**
- Source : Section 3, Section 6 — multiples références de type `help.ts:L226`, `utilities.ts:323`
- Description : Les numéros de ligne dans la spec seront décalés dès la première modification des fichiers concernés, rendant les références caduques.
- Impact : Faible en implémentation initiale, mais trompeuses pour toute révision ultérieure.

---

**[MINEUR] F-DA-8 — `sendVoiceResponse` appelle `sendResponse` avec la chaîne HTML brute**
- Source : Section 4 Adaptation `sendVoiceResponse` / R5
- Description : `sendVoiceResponse` appelle `sendResponse(ctx, response)` avec la réponse brute dans les deux branches (TTS réussi et échoué). Si `response` contient du HTML (après migration d'une fonction de formatage), `sendResponse` n'utilisant pas `parse_mode`, l'utilisateur verra les balises en clair.
- Impact : Faible dans le scope actuel (seules les réponses LLM plain text passent par `sendVoiceResponse`), mais fragilité latente si le comportement change.
- Evidence : `src/bot-context.ts:716` — `await sendResponse(ctx, response);` — chaîne originale non nettoyée.

---

### Statistiques
- Bloquants : 2
- Majeurs : 4
- Mineurs : 2

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants sont réels mais corrigeables avant implémentation :
1. **F-DA-1** : étendre `escapeHtml` pour échapper `"` et `'`, ou documenter explicitement que R3 ne s'applique pas aux attributs HTML.
2. **F-DA-2** : migrer `formatLlmOpsSnapshot` dans le périmètre ou extraire son affichage dans un `ctx.reply` séparé sans `parse_mode: "HTML"`.

---

## Edge Case Hunter — Rapport

J'ai assez d'éléments pour produire le rapport complet.

---

## Edge Case Hunter — Rapport

### Findings

---

**[BLOQUANT] F-EC-1 — `/monitor` : `formatLlmOpsSnapshot` non échappé injecté dans un contexte HTML**

- **Scenario :** La spec mandate d'ajouter `parse_mode: "HTML"` au `ctx.reply` de `help.ts:226` (Section 6). Ce `ctx.reply` envoie `parts.join("\n")` où `parts = [formatMonitoringStats(), "", formatLlmOpsSnapshot(snapshot)]`. `formatLlmOpsSnapshot` (non migré, `src/llm-ops.ts` absent de la Section 6) contient du contenu dynamique non échappé : `cb.reason`, `cb.role`, `pv.role`, `snapshot.costSummary.topRoleByCost`. Un circuit-breaker dont `cb.reason` vaut `"connection to <host:3000> failed"` produit du HTML malformé. Telegram silencionne ou rejette silencieusement le message entier.
- **Source :** Section 6 — `src/commands/help.ts` (L226), Section 10 "Zones d'ombre non résolues" — `formatLlmOpsSnapshot` classé "Faible impact" à tort
- **Impact :** Le message `/monitor` disparaît complètement lors d'incidents réseau, exactement quand l'utilisateur en a le plus besoin. `src/llm-ops.ts` manque dans la liste des fichiers à modifier.
- **Fréquence estimée :** Occasionnel (circuit-breakers s'ouvrent lors d'erreurs infra qui génèrent précisément des messages contenant `<`, `>`)

---

**[BLOQUANT] F-EC-2 — `sendVoiceResponse` : le texte d'accompagnement affiche du raw HTML**

- **Scenario :** R5 définit le strip HTML pour le TTS (le buffer audio), mais `sendVoiceResponse` envoie systématiquement le `response` original (non strippé) via `sendResponse` (sans `parse_mode`) : ligne 716 (succès vocal + texte) et ligne 723 (fallback texte pur). Si `response` contient du HTML — cas implicitement anticipé par R5 —, l'utilisateur lit `<b>En cours</b>` en clair dans le message texte. Le strip produit une voix propre mais un texte dégradé.
- **Source :** R5 et Section 4 "Adaptation sendVoiceResponse", `src/bot-context.ts:716, 723`
- **Impact :** Double affichage incohérent : audio correct + texte avec balises HTML brutes. La spec corrige l'audio et omet le chemin texte.
- **Fréquence estimée :** Rare (path vocal) mais systématique dès qu'un intent vocal déclenche un listing formaté

---

**[MAJEUR] F-EC-3 — `header` avec `currentProject.name` non échappé dans `/backlog` et `/sprint`**

- **Scenario :** `tasks.ts:150` : `` `Backlog — ${currentProject.name}\n\n` `` et `tasks.ts:187` : `` `${currentProject.name} — ` `` sont concaténés avec du HTML (`formatBacklog`, `formatSprintSummary`) avant d'être envoyés via `sendResponseHtml` (post-migration). `currentProject.name` est une valeur utilisateur stockée en base. Un projet nommé `Mon projet <b>` génère du HTML malformé. La spec ne mentionne pas l'échappement de `currentProject.name` dans ces concaténations.
- **Source :** Section 6 — `src/commands/tasks.ts` ("passer les 4 appels sendResponse à sendResponseHtml"), `tasks.ts:150, 187`
- **Impact :** Titres de projets avec `<`, `>`, `&` cassent silencieusement le rendu ou permettent de l'HTML arbitraire dans le backlog.
- **Fréquence estimée :** Rare mais exploitable via la création de projet

---

**[MAJEUR] F-EC-4 — `formatBacklog(tasks, title?)` : paramètre `title` non défini dans la transformation HTML**

- **Scenario :** `tasks.ts:202` appelle `formatBacklog(tasks, \`Taches ${arg}\`)` où `arg = ctx.match?.trim()` — valeur directement contrôlée par l'utilisateur via `/sprint <arg>`. La Section 4 définit la transformation HTML de `formatBacklog` (sections, titres de tâches, IDs) mais ne mentionne jamais le paramètre optionnel `title?`. Un utilisateur tape `/sprint <script>` → le titre rendu en HTML n'est pas échappé.
- **Source :** Section 4 "formatBacklog" — paramètre `title?` absent de la spécification de transformation
- **Impact :** XSS-like dans les titres de section du backlog via la commande /sprint.
- **Fréquence estimée :** Rare (input utilisateur délibéré), mais non-couvert par aucun V-critère

---

**[MAJEUR] F-EC-5 — `escapeHtml` ne gère pas `"` pour les attributs `href`**

- **Scenario :** `escapeHtml` (Section 7) échappe uniquement `&`, `<`, `>`. R4 autorise `<a href="...">`. Si une URL contient `"` (ex: URL mal formée venant de Supabase), l'attribut `href` est cassé ou l'injection d'attribut est possible. Ce pattern `<a href="${doc.url}">` est déjà en production dans `documents.ts` avec la même `escapeHtml` et le même risque pré-existant.
- **Source :** R4 — balises autorisées, Section 7 — implémentation `escapeHtml`
- **Impact :** Attribut HTML malformé pour les liens, potentielle injection d'attribut. Aucun V-critère ne teste ce cas.
- **Fréquence estimée :** Rare (URLs pathologiques), mais absence de protection documentée

---

**[MAJEUR] F-EC-6 — Comptage "5 appels" dans `quality.ts` probablement incorrect**

- **Scenario :** Section 6 indique "passer les 5 appels `sendResponse` sur formatMetrics/formatMetricsComparison/formatAlerts à `sendResponseHtml`". Le grep du codebase identifie : L338 (formatMetricsComparison), L357 (formatMetrics), L375 (formatMetricsComparison), L482 (formatAlerts) — soit 4 appels. L501 (`formatCostSummary`) est hors scope selon la contrainte 7. Un 5e appel non localisé par la spec risque d'être oublié à l'implémentation, laissant un handler en plain text alors que la fonction retourne du HTML.
- **Source :** Section 6 — `src/commands/quality.ts`
- **Impact :** Un handler oublié affiche `<b>Metriques Sprint S23</b>` brut au lieu du rendu gras.
- **Fréquence estimée :** Occasionnel (erreur d'implémentation probable)

---

**[MINEUR] F-EC-7 — Contradiction entre R2 et R5 : le strip HTML dans `sendVoiceResponse` est une branche morte**

- **Scenario :** R2 garantit que les réponses LLM transitent toujours par `sendResponse` (plain text). Si R2 est strictement respecté, `sendVoiceResponse` ne reçoit jamais de HTML → le strip HTML ajouté par R5 est mort code. Si le strip est nécessaire (R5), c'est que R2 ne couvre pas tous les cas. Cette tension n'est pas résolue dans la spec.
- **Source :** R2 (invariant LLM), R5 (strip HTML dans sendVoiceResponse)

---

**[MINEUR] F-EC-8 — `sdd-flow.ts:290` : `jobType` non mentionné dans les variables à échapper**

- **Scenario :** Section 6 pour `sdd-flow.ts` : "escapeHtml sur `jobId` et `name`". Le template `\`Job lance ${jobType} (id: ${jobId})\n...\`` inclut aussi `jobType`. Même si `jobType` est aujourd'hui un enum contrôlé, il n'est pas listé comme nécessitant l'échappement, créant un écart entre la spec et le code résultant.
- **Source :** Section 6 — `src/commands/sdd-flow.ts`

---

**[MINEUR] F-EC-9 — V16 est un grep statique : ne protège pas contre les régressions futures**

- **Scenario :** V16 vérifie que `grep -n "sendResponseHtml" quality.ts` ne contient pas `formatRetro` — test valide au moment de la migration mais contournable dès la prochaine PR. Un test d'intégration vérifiant que le résultat de `formatRetro` n'est pas interprété en HTML (ex: titre généré par LLM `<b>Points forts</b>` affiché en gras = FAIL) serait plus robuste.
- **Source :** V16 — critère de validation pour l'invariant LLM

---

**[MINEUR] F-EC-10 — Exclusion de `notification-queue.ts` crée une incohérence visuelle par channel**

- **Scenario :** Post-migration, `/backlog` affiche `<b>En cours</b>` (bold) via sendResponseHtml. Une notification batched sur la même tâche envoyée par `notification-queue.ts` (exclu, plain text) affiche `En cours : Migrer auth middleware [a1b2...]` sans formatage. L'utilisateur voit deux représentations différentes de la même donnée selon le channel (commande vs notification).
- **Source :** Contrainte 7 — `notification-queue.ts` hors scope

---

### Statistiques

- **Bloquants : 2** (F-EC-1, F-EC-2)
- **Majeurs : 4** (F-EC-3, F-EC-4, F-EC-5, F-EC-6)
- **Mineurs : 4** (F-EC-7, F-EC-8, F-EC-9, F-EC-10)

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants sont corrigeables sans restructurer la spec : F-EC-1 requiert d'ajouter `src/llm-ops.ts` à la liste des fichiers modifiés (escaping dans `formatLlmOpsSnapshot`) et un V-critère associé ; F-EC-2 requiert de préciser que `sendVoiceResponse` doit utiliser `sendResponseHtml` pour le texte d'accompagnement. Les majeurs F-EC-3 et F-EC-4 requièrent d'ajouter l'échappement de `currentProject.name` et du paramètre `title?` dans la Section 4. La spec est solide dans son périmètre et son infrastructure — ces corrections sont chirurgicales.

---

## Simplicity Skeptic — Rapport

## Simplicity Skeptic — Rapport

### Findings

---

**[MAJEUR] F-SS-1 — Zone d'ombre `/monitor` non résolue mais renvoyée à l'implémenteur**
- Source : Section 10 — Zones d'ombre non résolues
- Description : La spec signale explicitement que `formatLlmOpsSnapshot` (plain text) est concaténé avec `formatMonitoringStats` (HTML après migration) dans `/monitor` via `parts.join("\n")` sans `parse_mode`. Si `/monitor` est migré vers HTML, `formatLlmOpsSnapshot` expose du contenu dynamique (rôles Claude, cb.reason, noms de prompt) non échappé. La décision est renvoyée à l'implémenteur sur une zone identifiée comme à risque.
- Alternative : Soit exclure `/monitor` du scope, soit décider explicitement de migrer `formatLlmOpsSnapshot` dans cette spec.
- Codebase : `src/commands/help.ts:213-226` — concaténation et envoi sans `parse_mode` ; `src/llm-ops.ts:504` — `formatLlmOpsSnapshot` retourne du plain text avec contenu dynamique.

---

**[MAJEUR] F-SS-2 — `/help` migré vers HTML mais la ligne L226 est dans `/monitor`, pas `/help`**
- Source : Section 6 — Fichiers concernés, entrée `src/commands/help.ts`
- Description : La spec demande de migrer `ctx.reply(parts.join("\n"), threadOpts(ctx))` (help.ts:226) vers `parse_mode: "HTML"`, mais L226 est dans le handler `/monitor`, pas `/help`. Le handler `/help` (L29-38) n'utilise que du texte statique brut — aucune valeur fonctionnelle à migrer.
- Alternative : Supprimer l'entrée `src/commands/help.ts` du scope, ou la renommer en `/monitor`.
- Codebase : `src/commands/help.ts:29-37` — `/help` n'appelle aucune fonction de formatage enrichie.

---

**[MAJEUR] F-SS-3 — Duplication `sendResponse` / `sendResponseHtml` renforcée sans refactoring**
- Source : Section 7 — Patterns existants, `sendResponseHtml`
- Description : Les deux fonctions sont identiques sauf `parse_mode: "HTML"` (~30 lignes dupliquées). La spec ajoute 4-5 appels supplémentaires à `sendResponseHtml` en renforçant une paire dupliquée sans recommander de consolidation, alors que la migration serait l'occasion naturelle de le faire.
- Alternative : Un paramètre optionnel `parseMode` sur `sendResponse` ou une fonction unifiée `sendReply(ctx, text, html=false)`.
- Codebase : `src/bot-context.ts:632-696` — les deux fonctions sont strictement identiques sauf le `parse_mode`.

---

**[MAJEUR] F-SS-4 — `formatMemoryHealth` contient du contenu utilisateur dynamique non mentionné dans les règles d'escaping**
- Source : Section 4 — Règles de transformation HTML, `formatMemoryHealth`
- Description : `formatMemoryHealth` inclut `t.content.slice(0,40)` (contenu mémoire potentiellement issu d'utilisateurs ou d'agents). Sans escaping explicite, si cette valeur contient `<` ou `>`, le rendu HTML sera cassé. La spec liste R3 (`escapeHtml` obligatoire pour contenu dynamique) mais ne mentionne pas ce champ dans les règles de transformation de cette fonction.
- Alternative : Ajouter `escapeHtml(t.content.slice(0,40))` explicitement dans la règle de transformation de `formatMemoryHealth`.
- Codebase : `src/memory/graph.ts:676` — `t.content.slice(0,40)` intégré dans le résultat sans escaping.

---

**[MINEUR] F-SS-5 — V16 est une vérification grep manuelle, pas un test automatisé**
- Source : Section 9 — Critères de validation, V16
- Description : V16 propose un `grep` manuel comme vérification que `formatRetro` n'est pas envoyée via `sendResponseHtml`. Les 17 autres critères sont des tests `unit`/`integration` — V16 crée une exception implicite "manual/grep" non labellisée.
- Alternative : Convertir en assertion statique dans `coding-standards.test.ts`, ou labelliser explicitement `manual`.
- Codebase : `tests/unit/coding-standards.test.ts` — checks statiques de source déjà en place dans le projet.

---

**[MINEUR] F-SS-6 — `sendVoiceResponse` envoie la chaîne HTML originale via `sendResponse` (plain text)**
- Source : Section 4 — Adaptation `sendVoiceResponse` ; Section 8 — Contrainte 3
- Description : Après migration, `sendVoiceResponse` strip le HTML pour le TTS mais envoie `response` (chaîne HTML non filtrée) via `sendResponse` sans `parse_mode`. Les balises `<b>`, `<code>` s'afficheront littéralement dans le message texte accompagnant la voix.
- Alternative : Utiliser `sendResponseHtml(ctx, response)` dans `sendVoiceResponse`, ou stripper les balises pour la partie texte aussi.
- Codebase : `src/bot-context.ts:716` — `await sendResponse(ctx, response)` envoie l'original non filtré.

---

**[MINEUR] F-SS-7 — CLAUDE.md inclus dans le même PR que 13 fichiers source**
- Source : Section 6 — Fichiers concernés, entrée `CLAUDE.md` ; R8
- Description : Modifier CLAUDE.md dans le même PR que les fichiers de code mélange deux natures de changements. Le projet dispose d'une convention ADR pour les décisions architecturales.
- Alternative : Retirer CLAUDE.md du scope du PR implémentation — commit documentation séparé ou ADR.
- Codebase : `docs/adr/` — convention ADR existante.

---

**[MINEUR] F-SS-8 — Couverture XSS fragmentaire : seul `formatBacklog` a un critère d'escaping explicite**
- Source : Section 9 — Critères de validation, V3
- Description : V3 teste l'escaping XSS uniquement pour `formatBacklog`. Les fonctions `formatIdeasList`, `formatMemoryHealth`, `formatStatusBar` manipulent aussi du contenu utilisateur dynamique sans critère de validation d'escaping dédié.
- Alternative : Ajouter un critère d'escaping pour chaque fonction manipulant du contenu utilisateur, ou reformuler V3 comme critère transversal.
- Codebase : `src/memory/ideas.ts:161` — `idea.content` est du contenu utilisateur ; `src/pipeline-tracker.ts:253` — `tracker.name` peut contenir des caractères arbitraires.

---

### Statistiques
- Bloquants : 0
- Majeurs : 4
- Mineurs : 4

---

**Synthèse** : L'infrastructure est en place (`escapeHtml`, `sendResponseHtml`, patron `documents.ts`) et le périmètre est bien délimité. Les findings majeurs portent sur une zone d'ombre réelle laissée ouverte (F-SS-1), une erreur de référence de fichier (F-SS-2), une dette technique renforcée (F-SS-3), et un risque d'escaping non couvert (F-SS-4). Aucune sur-ingénierie structurelle — la spec est conservative et bien ancrée dans les patterns existants.

## Verdict de l'agent: GO_WITH_CHANGES

Les 4 findings majeurs méritent correction avant implémentation : résoudre la zone d'ombre `/monitor` (F-SS-1), corriger la référence fichier (F-SS-2), ajouter l'escaping de `t.content.slice(0,40)` dans les règles (F-SS-4). F-SS-3 est une dette à noter mais non bloquante.