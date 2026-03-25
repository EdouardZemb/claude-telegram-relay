---
phase: 1-implement
generated_at: "2026-03-25T14:45:00Z"
subject: "Implementation des menus inline progressifs pour ameliorer l'UX Telegram"
status: DONE
---

# Implementation : Menus inline progressifs

## Tests generes

| Fichier | V-criteres couverts | Tests |
|---------|-------------------|-------|
| `tests/unit/inline-menus.test.ts` | V1-V8 | 27 tests |
| `tests/unit/action-registry.test.ts` | Category field | 5 tests ajoutes |
| `tests/e2e/e2e.test.ts` | /help interactive | 1 test mis a jour |

### Detail des V-criteres

- V1: MENU_CATEGORIES definition (4-5 categories, id/label/description, unicite)
- V2: getActionsForCategory (couverture complete des commandes, retour vide pour inconnu)
- V3: buildMainMenuKeyboard (1 bouton par categorie, menu_cat: prefix, <=5 rows, <=64 bytes)
- V4: buildCategoryKeyboard (boutons commande, bouton Retour, menu_cmd: prefix, max 5 rows, <=64 bytes)
- V5: buildOnboardingKeyboard (boutons decouverte, raccourcis backlog/status)
- V6: buildBacklogActionKeyboard (bouton Demarrer, short ID <=64 bytes)
- V7: buildQualityNavKeyboard (metriques, retro, alertes, couts)
- V8: buildNotifyPrefsKeyboard (toggles par type, notify_ prefix, <=64 bytes)

## Fichiers modifies

| Fichier | Changements | LOC |
|---------|------------|-----|
| `src/inline-menus.ts` | **Nouveau** -- Module de construction de menus inline progressifs | ~210 |
| `src/action-registry.ts` | Ajout champ `category` a ActionDefinition + categories sur les 27 commandes + getActionsByCategory() | +35 |
| `src/commands/help.ts` | /help remplace par menu interactif + callback handlers (menu_cat:, menu_cmd:, menu_back) | +70, -25 |
| `src/commands/tasks.ts` | /start sans args = onboarding interactif + callbacks task_start:/task_done: | +65 |
| `src/commands/quality.ts` | Navigation inline apres /metrics (retro, alerts, cost) | +4 |
| `src/commands/profile.ts` | /notify status avec inline keyboard + callbacks notify_on:/notify_off: | +50 |
| `tests/unit/inline-menus.test.ts` | **Nouveau** -- 27 tests pour le module inline-menus | ~250 |
| `tests/unit/action-registry.test.ts` | 5 tests ajoutes (category field, getActionsByCategory) | +25 |
| `tests/unit/coding-standards.test.ts` | inline-menus.ts ajoute a S6 allowlist (pure functions) | +2 |
| `tests/e2e/e2e.test.ts` | /help test adapte au nouveau format interactif | +2, -2 |
| `CLAUDE.md` | Documentation inline-menus.ts + mise a jour action-registry | +2 |

## Architecture

### Nouveau module : `src/inline-menus.ts`

Module pur (pas de side-effects, pas de I/O) qui construit des InlineKeyboard a partir des metadonnees du registre de commandes.

Fonctions exportees :
- `MENU_CATEGORIES` -- 5 categories (tasks, quality, knowledge, project, system)
- `getActionsForCategory(id)` -- ActionDefinition[] pour une categorie
- `buildMainMenuKeyboard()` -- Menu principal avec 1 bouton par categorie
- `buildCategoryKeyboard(id)` -- Sous-menu avec commandes + bouton Retour
- `buildOnboardingKeyboard()` -- Accueil interactif pour /start
- `buildBacklogActionKeyboard(id, title)` -- Boutons Demarrer/Terminer pour une tache
- `buildQualityNavKeyboard()` -- Navigation metriques/retro/alertes/couts
- `buildNotifyPrefsKeyboard(prefs)` -- Toggles de preferences notifications

### Conventions callback_data

| Prefix | Module | Exemples |
|--------|--------|----------|
| `menu_cat:` | help.ts | `menu_cat:tasks`, `menu_cat:quality` |
| `menu_cmd:` | help.ts | `menu_cmd:backlog`, `menu_cmd:metrics` |
| `menu_back` | help.ts | Retour au menu principal |
| `task_start:` | tasks.ts | `task_start:abc12345` |
| `task_done:` | tasks.ts | `task_done:abc12345` |
| `notify_on:` | profile.ts | `notify_on:task` |
| `notify_off:` | profile.ts | `notify_off:pr` |

### Contraintes respectees

- Max 5 rows par keyboard (iOS)
- Max 64 bytes par callback_data
- Commandes slash existantes inchangees (menus = ajout, pas remplacement)
- Convention "plain text only" pour le contenu (inline keyboards = navigation)
- Prefixes callback_data uniques par module

## Resultats tests

```
1975 pass, 0 fail, 1 skip
4005 expect() calls
70 fichiers de test
```

Typecheck : OK (0 erreurs)

## Statut final

**DONE**

Prochaines etapes :
- `/dev-review` pour la revue de code
- `/dev-doc` pour la mise a jour documentation
