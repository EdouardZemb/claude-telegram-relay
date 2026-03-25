# Implement Report — SPEC-modes-de-mise-en-page-telegram-html-markdown

## Statut : DONE

Tests : 2062 pass, 1 skip, 0 fail (avant : 2029 tests, +33 nouveaux tests)

## Résumé

Migration complète des fonctions de formatage bot-side de plain text vers HTML parse_mode Telegram. Invariant R2 maintenu : les réponses LLM (callClaude → sendResponse) restent en plain text.

## Fichiers modifiés

### Nouveau module
- `src/html-utils.ts` — fonction `escapeHtml()` extraite pour éviter le cycle d'import circulaire `bot-context → memory → ideas → bot-context`. Couvre `&`, `<`, `>`, `"`, `'` (fix F-DA-1).

### Modules source
- `src/bot-context.ts` — re-export `escapeHtml` depuis html-utils ; `sendVoiceResponse` strip HTML avant Markdown (fix F-EC-2/R5)
- `src/tasks.ts` — `formatBacklog` : sections `<b>`, titres `<b>`, IDs `<code>` ; `formatSprintSummary` : titre `<b>`
- `src/pipeline-tracker.ts` — `formatStatusBar` : nom pipeline `<b>`, artifact `<code>`, summary `escapeHtml`
- `src/memory/ideas.ts` — `formatIdeasList` : header `<b>`, IDs `<code>`, content `escapeHtml` (import direct html-utils pour éviter circulaire)
- `src/memory/graph.ts` — `formatMemoryHealth` : header `<b>`, topAccessed `escapeHtml` (import direct html-utils)
- `src/commands/quality.ts` — `formatMetrics` : titre `<b>` ; `formatMetricsComparison` : header `<b>`, IDs `<code>` ; 4 `sendResponse` → `sendResponseHtml`
- `src/alerts.ts` — `formatMonitoringStats` : sections `<b>`, roles/mods `<code>` ; `formatAlerts` : header `<b>`, messages `escapeHtml`
- `src/llm-ops.ts` — `formatLlmOpsSnapshot` : header `<b>`, rôles/raisons `escapeHtml` (fix F-DA-2/F-EC-1)
- `src/commands/tasks.ts` — 4 `sendResponse` → `sendResponseHtml` ; `currentProject.name` `escapeHtml` (fix F-EC-3)
- `src/commands/memory-cmds.ts` — `sendResponse` → `sendResponseHtml` pour formatMemoryHealth et formatIdeasList
- `src/commands/sdd-flow.ts` — `parse_mode: "HTML"` pour job launch reply
- `src/commands/utilities.ts` — `parse_mode: "HTML"` pour notif_sprint editMessageText (fix R6)
- `src/commands/help.ts` — `/monitor` reply avec `parse_mode: "HTML"`
- `CLAUDE.md` — règle R8 mise à jour : distinction LLM responses (plain text) vs bot-side formatting (HTML) ; entrée html-utils.ts ajoutée au tableau des modules

### Tests ajoutés/modifiés
- `tests/unit/tasks.test.ts` — V1 (sections `<b>`), V2 (`<code>` IDs), V3 (XSS escaping), V4 ([SDD] préservé), V5 (sprint `<b>`)
- `tests/unit/pipeline-tracker.test.ts` — V6 (pipeline `<b>`), V7 (artifact `<code>`)
- `tests/unit/memory.test.ts` — V8 (ideas header `<b>`), V9 (ideas IDs `<code>`)
- `tests/unit/memory-evolution.test.ts` — V10 (memoryHealth `<b>`)
- `tests/unit/bot-context.test.ts` — escapeHtml describe block (`&`, `<`, `>`, `"`, `'`) ; V14/V15 ordre strip HTML avant Markdown dans sendVoiceResponse
- `tests/unit/alerts.test.ts` — V13 (XSS escaping dans messages), V13-spec (header `<b>`)
- `tests/unit/monitoring.test.ts` — V12 (monitoring `<b>`)
- `tests/unit/memory-cmds.test.ts` — regex mis à jour pour `sendResponseHtml`
- `tests/unit/coding-standards.test.ts` — `html-utils.ts` ajouté à TYPES_ONLY_ALLOWLIST S6 (pure function, no side-effects)
- `tests/integration/ideas-lifecycle.test.ts` — assertions mises à jour pour format HTML
- `tests/generated/modes-de-mise-en-page-telegram-html-markdown.test.ts` — V10-V11 (quality.ts source checks), V16 (invariant R2 formatRetro), V18 (CLAUDE.md), V1/V5 (tasks.ts), V6/V7 (pipeline-tracker), escapeHtml unit tests

## Défauts adversariaux résolus

| Réf | Défaut | Résolution |
|-----|--------|-----------|
| F-DA-1 | escapeHtml manque `"` et `'` | Ajout `&quot;` et `&#39;` dans html-utils.ts |
| F-DA-2/F-EC-1 | formatLlmOpsSnapshot non échappé | Migration llm-ops.ts avec escapeHtml |
| F-EC-2 | sendVoiceResponse affiche HTML brut | Strip HTML avant Markdown dans sendVoiceResponse |
| F-EC-3 | currentProject.name non échappé | escapeHtml dans tasks.ts command header |
| F-DA-3 | Header concat dans tasks.ts | escapeHtml appliqué |
| S7 | Import circulaire potentiel | html-utils.ts module indépendant |

## Invariants respectés

- R2 : callClaude → sendResponse (plain text) — zéro violation (V16 vérifie formatRetro)
- R4 : HTML niveau 1 uniquement (`<b>`, `<code>`, `<a href>`) — pas de `<i>`, `<u>`, etc.
- R5 : TTS strip HTML avant Markdown
- S7 : Pas de cycle d'import (html-utils.ts racine indépendante)
