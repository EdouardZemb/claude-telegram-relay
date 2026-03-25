---
phase: 1-implement
generated_at: "2026-03-25T22:10:00+01:00"
subject: "Feature flag sdd_auto_deploy + notification enrichie post-deploy"
status: DONE
---

# Implementation : sdd_auto_deploy + notification enrichie post-deploy

## Tests generes

**Fichier** : `tests/unit/sdd-auto-deploy.test.ts` (19 tests)

| # | V-critere | Test | Status |
|---|-----------|------|--------|
| V1 | Flag existe et est boolean | `sdd_auto_deploy exists in config/features.json and is boolean` | PASS |
| V2 | Flag defaut a true | `sdd_auto_deploy defaults to true` | PASS |
| V1 | isFeatureEnabled lit le flag | `isFeatureEnabled reads sdd_auto_deploy correctly` | PASS |
| V3 | deploy.yml lit le flag | `deploy.yml contains a step that reads sdd_auto_deploy` | PASS |
| V3 | deploy.yml utilise bun pour parser | `deploy.yml uses jq or bun to read the flag from features.json` | PASS |
| V4 | deploy.yml skip conditionnel | `deploy.yml has conditional logic to skip restart when flag is false` | PASS |
| V5 | Backward compat (defaut=deploy) | `deploy.yml defaults to deploying when flag is absent` | PASS |
| V6 | MCP notification sur succes | `notify-deploy.sh writes MCP notification on success` | PASS |
| V7 | MCP notification sur echec | `notify-deploy.sh writes MCP notification on failure` | PASS |
| V8 | Contenu notification complet | `MCP notification includes type, severity, commit info, and status` | PASS |
| V9 | Creation RELAY_DIR si absent | `notify-deploy.sh creates RELAY_DIR if it does not exist` | PASS |
| V10 | Append sans ecrasement | `notify-deploy.sh appends to existing pending notifications` | PASS |
| V10-edge | Fichier MCP corrompu | `handles corrupted existing MCP file gracefully` | PASS |
| V8-edge | Details vides | `handles empty commit details gracefully` | PASS |
| V7-edge | Status inconnu | `handles unknown status as failure` | PASS |
| V8-edge | Caracteres speciaux | `handles special characters in commit message` | PASS |
| struct | git pull inconditionnel | `git pull step is unconditional` | PASS |
| struct | Restart/smoke conditionnel | `restart and smoke test steps are conditional on DEPLOY_ENABLED` | PASS |
| struct | Step "deploy skipped" | `deploy skipped step exists for when flag is false` | PASS |

## Fichiers modifies

| Fichier | Changement | LOC delta |
|---------|-----------|-----------|
| `config/features.json` | Ajout flag `sdd_auto_deploy: true` | +1 |
| `.github/workflows/deploy.yml` | Step "Check sdd_auto_deploy flag" + conditions `if:` sur restart/smoke/install + step "Deploy skipped" | +25 |
| `scripts/notify-deploy.sh` | Restructuration : Telegram notification decouplee du MCP, ajout ecriture `mcp-pending-notifications.json` avec append atomique (tmp+mv) | +44 |
| `tests/unit/sdd-auto-deploy.test.ts` | Nouveau fichier : 19 tests couvrant les 3 composants | +278 |

## Architecture des changements

### 1. Feature flag `sdd_auto_deploy` (config/features.json)
- Ajout simple du flag, valeur par defaut `true` (backward compatible)
- Lu par `isFeatureEnabled()` sans modification du module `feature-flags.ts`

### 2. Step conditionnel dans deploy.yml
- **git pull** : toujours execute (le code est mis a jour meme si le deploy est desactive)
- **Check flag** : lit `config/features.json` via `bun -e` avec fallback a `true` si fichier absent ou erreur
- **Install deps, Restart, Smoke test** : conditionnes par `steps.check_flag.outputs.DEPLOY_ENABLED == 'true'`
- **Deploy skipped** : step informatif quand le flag est false

### 3. Notification enrichie (notify-deploy.sh)
- **Telegram** : inchange, mais ne bloque plus l'execution si BOT_TOKEN/GROUP_ID manquent
- **MCP notification** : ecrit dans `$RELAY_DIR/mcp-pending-notifications.json`
  - Type `alert`, severity `normal` (success) ou `critical` (failure)
  - Data : `deployStatus`, `alertType: deploy_result`, `commitInfo`
  - Append atomique : lit existant, ajoute, ecrit via tmp+mv
  - Cree le RELAY_DIR si absent
  - Gere les fichiers corrompus (reset a [])

## Resultat bun test

```
2151 pass
1 skip
0 fail
4325 expect() calls
Ran 2152 tests across 77 files. [41.59s]
```

## Statut final

**DONE** -- Prochaines etapes : `/dev-review` puis `/dev-doc`
