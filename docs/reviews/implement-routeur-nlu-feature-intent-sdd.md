# Implementation Report — Routeur NLU Feature Request Intent (Option C)

**Date**: 2026-03-25
**Source**: docs/explorations/EXPLORE-routeur-nlu-feature-intent-sdd.md
**Status**: DONE

## Tests generes (Phase 1)

**Fichier**: `tests/unit/nlu-feature-request.test.ts` — 44 tests

| V-critere | Tests | Description |
|-----------|-------|-------------|
| V1 | 14 | Regex detection des patterns FR (il faudrait pouvoir, ce serait bien, on pourrait, j'aimerais, etc.) |
| V2 | 3 | Priorite feature_request sur create_task quand "tache" absent |
| V3 | 3 | create_task preservee quand "tache" explicitement mentionne |
| V4 | 2 | Routing vers commande explore |
| V5 | 2 | LLM fallback detecte feature requests + prompt enrichi |
| V6 | 3 | Feature flag nlu_feature_request gate le comportement |
| V7 | 2 | Confirmation InlineKeyboard (jamais auto-dispatch) |
| V8 | 3 | Callback handling confirm/cancel |
| V9 | 5 | Extraction du sujet de la feature request |
| V10 | 7 | Pas de faux positifs sur conversation casuelle |

## Fichiers modifies (Phase 2)

| Fichier | Modification | LOC delta |
|---------|-------------|-----------|
| `src/intent-detection.ts` | +17eme intent `feature_request` (7 regex patterns + argExtractor). Restriction de `create_task` a un seul pattern exigeant "tache". Enrichissement du prompt LLM avec instruction feature_request. | +41 |
| `src/commands/command-router.ts` | +`isFeatureRequestIntent()`, `showFeatureRequestConfirmation()`, `handleFeatureRequestCallback()`. Map de pending feature requests avec TTL 120s. | +77 |
| `src/commands/zz-messages.ts` | +Import des nouvelles fonctions. +Callback handler `feature_request_confirm/cancel`. +Interception feature_request dans processMessageInput (regex et LLM). | +39 |
| `config/features.json` | +`"nlu_feature_request": false` (off par defaut) | +1 |
| `tests/unit/nlu-feature-request.test.ts` | 44 tests couvrant les 10 V-criteres | +289 (nouveau) |

## Architecture de la solution

```
Message utilisateur
  |
  v
detectIntent() — regex fast-path
  |
  +-- intent=feature_request? --[flag ON]--> showFeatureRequestConfirmation()
  |                                            |
  |                                            v
  |                                       InlineKeyboard [Explorer] [Non merci]
  |                                            |
  |                                            +-- confirm --> /explore <sujet>
  |                                            +-- cancel  --> "Pas de souci"
  |
  +-- confidence >= 0.8? --> routeIntent() (existing flow)
  |
  +-- else --> detectIntentWithLLM()
                |
                +-- intent=feature_request? --[flag ON]--> showFeatureRequestConfirmation()
                +-- confidence >= 0.8? --> routeIntent()
                +-- else --> conversation fallback
```

## Decisions d'implementation

1. **Priorite feature_request > create_task**: L'intent `feature_request` est declare AVANT `create_task` dans `INTENT_PATTERNS`. Le pattern `create_task` est restreint a un seul regex exigeant le mot "tache". Les patterns generiques (`il faut ajouter`, `on doit creer`) sont captures par feature_request sauf si "tache" est present.

2. **Confirmation obligatoire**: Jamais d'auto-dispatch vers `/explore`. Toujours via InlineKeyboard avec TTL 120s.

3. **Feature flag off par defaut**: `nlu_feature_request: false` dans features.json. Le detection regex fonctionne toujours (intent=feature_request), mais `isFeatureRequestIntent()` retourne false quand le flag est off, ce qui laisse le message continuer vers le flow normal.

4. **LOC contenus**: La logique de confirmation reste dans command-router.ts (77 LOC). zz-messages.ts passe de 694 a 733 LOC (sous le seuil 800).

5. **Pattern `il faut/on doit + verbe` sans "tache"**: Capture par feature_request via negative lookahead `(?!.*\btache\b)`.

## Resultat `bun test`

```
2195 pass
1 skip
0 fail
4416 expect() calls
Ran 2196 tests across 78 files
```

Aucune regression. Les 44 nouveaux tests passent. Les tests existants intent-detection (49 pass) et command-router (23 pass) restent verts.

## Statut final

**DONE** — Prochaines etapes : `/dev-review` puis `/dev-doc`.
