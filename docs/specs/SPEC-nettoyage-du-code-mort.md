# Spec : Nettoyage du code mort (Phase 1 — Architecture V2)

> Genere le 2026-03-24. Source : docs/explorations/EXPLORE-nettoyage-du-code-mort.md, exploration codebase (src/, tests/, .claude/).

## 1. Objectif

Supprimer tout le code mort accumule dans le bot Telegram `claude-telegram-relay` correspondant a la Phase 1 de `docs/ARCHITECTURE-V2.md` : modules TypeScript derriere les 6 feature flags desactives, agents `.claude/agents/` obsoletes, skills `.claude/skills/` obsoletes. Mettre a jour les imports, barrels, tests et documentation pour que le build et les 4035 tests passent apres suppression.

Cette phase ne cree aucun nouveau code. Elle reduit la base de code d'environ 2100 LOC, abaisse la charge cognitive de maintenance, et degage la voie pour les Phases 2-6 de la migration architecturale.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Supprimer integralement les 3 modules TypeScript dont la totalite du code est derriere un flag desactive | EXPLORE §3.1 / ARCHITECTURE-V2 Phase 1 | `src/spec-lite.ts`, `src/adversarial-challenge.ts`, `src/exploration-scoring.ts` |
| R2 | Retirer chirurgicalement les blocs gardes par flag dans les modules partiellement morts, sans modifier le reste du module | EXPLORE §3.5 frictions 1-2 | Blocs P1/P2/memory_promotion dans `orchestrator/pipeline.ts` |
| R3 | Ne jamais toucher le filtre `eq("metadata->>source", "working_memory_promotion")` dans `memoryHealthStats()` — il n'est pas derriere un flag, c'est du monitoring de donnees historiques | EXPLORE §3.5 friction 3 | `src/memory/graph.ts` L615 |
| R4 | Conserver le module `src/commands/exploration.ts` entier — seule la guard `exploration_phase` est retiree. La commande `/explore` sera adaptee en Phase 3. | EXPLORE §6 contraintes | L79-82 de `commands/exploration.ts` |
| R5 | Conserver `src/gate-evaluator.ts` entier — retirer uniquement le bloc `exploration_gate` (~10 lignes). Le module est actif et sera supprime en Phase 4. | EXPLORE §6 contraintes | L521-529 de `gate-evaluator.ts` |
| R6 | Conserver `src/prd-workflow.ts` entier — retirer uniquement les fonctions et types derriere `prd_maturation_phases` : `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `PreflightReport`, `storePendingProtoSpec`, `getPendingProtoSpec`, `clearPendingProtoSpec`, `buildPreflightResultTag`, `buildPreflightKeyboard`, `formatPreflightReport` | EXPLORE §6 contraintes + verification planning.ts imports | `prd-workflow.ts` L51-L800+ |
| R7 | Dans `src/memory/graph.ts`, supprimer uniquement la fonction `promoteWorkingMemory` (L765-855) et l'interface `WorkingMemoryData` (L95). Retirer `saveAgentMemory` et `graduateAgentMemory` de l'import L10 mais conserver `getAgentMemories` qui est utilise dans `buildMemoryChains` (L543). Conserver `isFeatureEnabled` qui est utilise pour `agent_role_memory` (L454). | Verification Read graph.ts L10, L454, L543 | `src/memory/graph.ts` |
| R8 | Dans `src/memory.ts` barrel, retirer les exports `promoteWorkingMemory` et `type WorkingMemoryData` qui ne sont plus definis dans `memory/graph.ts` | Barrel convention CLAUDE.md + EXPLORE §6 | `src/memory.ts` L52-55 |
| R9 | Supprimer les 5 agents obsoletes et les 3 skills obsoletes (fichiers .md uniquement, sans reference TypeScript) | EXPLORE §3.2-3.3 / ARCHITECTURE-V2 | `.claude/agents/impact-analyst.md`, etc. |
| R10 | Supprimer les 6 cles des feature flags desactives dans `config/features.json` | EXPLORE §6 | `exploration_phase`, `exploration_gate`, `spec_phase_lite`, `adversarial_challenge`, `prd_maturation_phases`, `memory_promotion` |
| R11 | Mettre a jour `CLAUDE.md` : retirer les lignes `dev-spec`, `dev-challenge`, `dev-pipeline` de la table Dev Pipeline, retirer les agents supprimes de la liste agents (11 → 6), mettre a jour le workflow complet | EXPLORE §3.4 item 27 + test doc-freshness |  |
| R12 | Supprimer les fichiers de tests unitaires correspondant aux modules entierement supprimes | EXPLORE §3.4 | `tests/unit/spec-lite.test.ts`, `tests/unit/adversarial-challenge.test.ts`, `tests/unit/exploration-scoring.test.ts` |
| R13 | Supprimer le fichier de test genere qui teste exclusivement les fonctions derriere `prd_maturation_phases` | Verification : tous les describe blocs testent des fonctions supprimees | `tests/generated/reviser-prd-to-deploy-workflow.test.ts` |
| R14 | Dans les tests partiellement modifies, retirer uniquement les describe blocs qui referencent des flags supprimes ou des fonctions supprimees — ne pas toucher aux autres sections | EXPLORE §3.4 + verification Read | `tests/unit/orchestrator.test.ts`, `tests/unit/logger-migration.test.ts`, `tests/generated/sante-systeme-memoire-permanente-multi.test.ts`, `tests/unit/memory-evolution.test.ts` |
| R15 | Dans `src/commands/planning.ts`, retirer les imports et le bloc `isPrdMaturationEnabled()` (L861-894) ainsi que les fonctions importees exclusivement pour ce bloc : `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `storePendingProtoSpec`, `buildPreflightResultTag`. Retirer aussi les callbacks `prdwf_preflight_ok`, `prdwf_preflight_abort`, `prdwf_revise_prd` et les fonctions `getPendingProtoSpec`, `clearPendingProtoSpec` dans les callbacks | Verification Read planning.ts L667-773 | `src/commands/planning.ts` |
| R16 | Dans `src/job-manager.ts`, retirer l'import `buildPreflightKeyboard` (L15) et le case `"prd-preflight"` du switch qui l'utilise (L293-308, L349-353). La fonction supprimee de `prd-workflow.ts` casse le typecheck sinon. | Challenge adversarial F-EC-1 | `src/job-manager.ts` |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| `config/features.json` | Fichier JSON | Read | 6 cles a supprimer : `exploration_phase`, `exploration_gate`, `spec_phase_lite`, `adversarial_challenge`, `prd_maturation_phases`, `memory_promotion` |
| `src/spec-lite.ts` | Module TypeScript (189 LOC) | Delete | Module entier |
| `src/adversarial-challenge.ts` | Module TypeScript (362 LOC) | Delete | Module entier |
| `src/exploration-scoring.ts` | Module TypeScript (292 LOC) | Delete | Module entier |
| `src/orchestrator/pipeline.ts` | Module TypeScript (1486 LOC) | Edit chirurgical | Imports L14, L57, L62, L81 ; blocs L325-412, L859-950, L1430-1451 |
| `src/prd-workflow.ts` | Module TypeScript (783 LOC) | Edit chirurgical | Imports L12-14, L35 ; types et fonctions L51-64, L517-535, L540-551, L553-784 |
| `src/gate-evaluator.ts` | Module TypeScript (937 LOC) | Edit chirurgical | Bloc `exploration_gate` L521-529 |
| `src/llm-router.ts` | Module TypeScript (481 LOC) | Edit chirurgical | Import `computeExplorationScore` + bloc L95-108 |
| `src/auto-pipeline.ts` | Module TypeScript | Edit chirurgical | Bloc `spec_phase_lite` L185-205 |
| `src/commands/exploration.ts` | Module TypeScript (234 LOC) | Edit chirurgical | Guard `exploration_phase` L79-82 + import `isFeatureEnabled` si plus utilise |
| `src/commands/planning.ts` | Module TypeScript (1005 LOC) | Edit chirurgical | Imports L28, L42, L44, L46 ; bloc L861-894 ; callbacks L667-773 |
| `src/memory/graph.ts` | Module TypeScript (855 LOC) | Edit chirurgical | Import L10 (retirer saveAgentMemory, graduateAgentMemory) ; interface L95-120 ; fonction L765-855 |
| `src/memory.ts` | Barrel TypeScript | Edit | Exports L52-55 (promoteWorkingMemory, WorkingMemoryData) |
| `.claude/agents/` | Fichiers Markdown (5 fichiers) | Delete | Voir R9 |
| `.claude/skills/` | Fichiers Markdown (3 dossiers) | Delete | Voir R9 |
| `tests/unit/spec-lite.test.ts` | Test TypeScript (177 LOC) | Delete | Fichier entier |
| `tests/unit/adversarial-challenge.test.ts` | Test TypeScript (193 LOC) | Delete | Fichier entier |
| `tests/unit/exploration-scoring.test.ts` | Test TypeScript (302 LOC) | Delete | Fichier entier |
| `tests/generated/reviser-prd-to-deploy-workflow.test.ts` | Test TypeScript (891 LOC) | Delete | Fichier entier |
| `tests/unit/orchestrator.test.ts` | Test TypeScript | Edit chirurgical | Describes "[V14] Feature Flags for P1/P2/E1/P3", "[V12] P1/P2/E1/P3 pipeline scope guards" (lignes specifiques aux flags), "memory_promotion feature flag", "Working memory promotion in orchestrate()" |
| `tests/unit/logger-migration.test.ts` | Test TypeScript | Edit chirurgical | Retirer `adversarial-challenge.ts` et `spec-lite.ts` de `MIGRATED_MODULES` |
| `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` | Test TypeScript (656 LOC) | Edit chirurgical | Describes [V1], [V2], [V12] lies a `memory_promotion` |
| `tests/unit/memory-evolution.test.ts` | Test TypeScript (1093 LOC) | Edit chirurgical | Section "Feature flag memory_promotion" (L1083-1093) et tous les tests utilisant `WorkingMemoryData` / `promoteWorkingMemory` (L560-700+) |
| `CLAUDE.md` | Documentation Markdown | Edit | Table Dev Pipeline, liste agents, workflow |

## 4. Donnees de sortie

**Resultat attendu : un codebase compile sans erreur avec un nombre reduit de tests, tous verts.**

### 4.1 — Modules supprimes (0 LOC en sortie)

- `src/spec-lite.ts` : supprime
- `src/adversarial-challenge.ts` : supprime
- `src/exploration-scoring.ts` : supprime

### 4.2 — Modules modifies (imports + blocs retires)

Pour chaque module modifie, la sortie doit satisfaire :
- Plus aucune reference aux 6 feature flags supprimes dans les imports ou le corps
- Plus aucun appel aux fonctions des modules supprimes
- Le reste du module est identique (aucune logique modifiee)

### 4.3 — Tests

Reduction du nombre de tests : 4035 → ~3357 (suppression de ~678 tests directs + nettoyage sections partielles). Tous les tests restants passent (`bun test` : 0 fail).

### 4.4 — `config/features.json`

```json
{
  "heartbeat": true,
  "job_manager": true,
  "auto_document_search": true,
  "prd_to_deploy": true,
  "llmops_monitoring": true,
  "agent_role_memory": true
}
```
(6 cles retirees, 6 cles conservees)

### 4.5 — `CLAUDE.md`

- Table Dev Pipeline : ne contient plus les lignes `dev-spec`, `dev-challenge`, `dev-pipeline`
- Workflow complet (avant `/dev-implement`) : ne mentionne plus ces skills
- Liste agents `.claude/agents/` : 11 → 6 (gardes : explorer, spec-architect, devils-advocate, edge-case-hunter, simplicity-skeptic, reviewer)
- Liste skills `.claude/skills/` : 7 → 4 (gardes : dev-explore, dev-implement, dev-review, dev-doc)

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/spec-lite.ts` | Supprimer | Module entierement derriere `spec_phase_lite` (flag desactive) |
| `src/adversarial-challenge.ts` | Supprimer | Module entierement derriere `adversarial_challenge` (flag desactive) |
| `src/exploration-scoring.ts` | Supprimer | Module entierement derriere `exploration_phase` (flag desactive) |
| `src/orchestrator/pipeline.ts` | Modifier | Retirer imports + 3 blocs gardes par flags supprimes (P1, P2, memory_promotion) + bloc `shouldExplore` L131-170 (appel inconditionnel au module supprime `exploration-scoring.ts`) |
| `src/prd-workflow.ts` | Modifier | Retirer imports + types + fonctions derriere `prd_maturation_phases` |
| `src/gate-evaluator.ts` | Modifier | Retirer bloc `exploration_gate` (~10 lignes) |
| `src/llm-router.ts` | Modifier | Retirer import `computeExplorationScore` + bloc `exploration_phase` |
| `src/auto-pipeline.ts` | Modifier | Retirer bloc `spec_phase_lite` (import dynamique + generation proto-spec) |
| `src/commands/exploration.ts` | Modifier | Retirer guard `exploration_phase` (L79-82) + import `isFeatureEnabled` si plus utilise |
| `src/commands/planning.ts` | Modifier | Retirer imports + bloc `isPrdMaturationEnabled()` + callbacks preflight |
| `src/memory/graph.ts` | Modifier | Supprimer `promoteWorkingMemory` + `WorkingMemoryData` + imports associes |
| `src/memory.ts` | Modifier | Retirer re-exports `promoteWorkingMemory` et `type WorkingMemoryData` |
| `src/job-manager.ts` | Modifier | Retirer import `buildPreflightKeyboard` (L15) + case `"prd-preflight"` dans le switch (L293-308, L349-353) — fonctions supprimees de `prd-workflow.ts` |
| `config/features.json` | Modifier | Retirer les 6 cles de flags supprimes |
| `.claude/agents/impact-analyst.md` | Supprimer | Agent obsolete selon ARCHITECTURE-V2 |
| `.claude/agents/security-checker.md` | Supprimer | Agent obsolete selon ARCHITECTURE-V2 |
| `.claude/agents/test-architect.md` | Supprimer | Agent obsolete selon ARCHITECTURE-V2 |
| `.claude/agents/implementer.md` | Supprimer | Agent obsolete selon ARCHITECTURE-V2 |
| `.claude/agents/tester.md` | Supprimer | Agent obsolete selon ARCHITECTURE-V2 |
| `.claude/skills/dev-spec/SKILL.md` (dossier) | Supprimer | Skill obsolete selon ARCHITECTURE-V2 |
| `.claude/skills/dev-challenge/SKILL.md` (dossier) | Supprimer | Skill obsolete selon ARCHITECTURE-V2 |
| `.claude/skills/dev-pipeline/SKILL.md` (dossier) | Supprimer | Skill obsolete selon ARCHITECTURE-V2 |
| `tests/unit/spec-lite.test.ts` | Supprimer | Tests du module supprime |
| `tests/unit/adversarial-challenge.test.ts` | Supprimer | Tests du module supprime |
| `tests/unit/exploration-scoring.test.ts` | Supprimer | Tests du module supprime |
| `tests/generated/reviser-prd-to-deploy-workflow.test.ts` | Supprimer | Tous les describe blocs testent des fonctions supprimees (preflight maturation) |
| `tests/unit/orchestrator.test.ts` | Modifier | Supprimer describes lies aux flags supprimes (V14, memory_promotion, Working memory promotion) |
| `tests/unit/logger-migration.test.ts` | Modifier | Retirer `adversarial-challenge.ts` et `spec-lite.ts` de `MIGRATED_MODULES` |
| `tests/generated/sante-systeme-memoire-permanente-multi.test.ts` | Modifier | Supprimer describes [V1], [V2], [V3], [V4], [V5], [V12], [V13] lies a `memory_promotion` et `promoteWorkingMemory` |
| `tests/unit/memory-evolution.test.ts` | Modifier | Supprimer section "Feature flag memory_promotion" (L1083-1093) et tests `promoteWorkingMemory` / `WorkingMemoryData` (L560-700+) |
| `CLAUDE.md` | Modifier | Mettre a jour table Dev Pipeline, liste agents (11→6), liste skills (7→4), workflow |

## 6. Patterns existants

### 6.1 — Guard isFeatureEnabled (pattern de suppression)

Le pattern de suppression est uniforme dans tout le codebase : les blocs a retirer ont toujours la forme :

```typescript
if (isFeatureEnabled("flag_name")) {
  // code mort
}
```

ou

```typescript
if (!isFeatureEnabled("flag_name")) {
  return earlyReturn;
}
```

Exemples concrets :
- `src/orchestrator/pipeline.ts` L343-412 : bloc P1 avec `isFeatureEnabled("spec_phase_lite")`
- `src/orchestrator/pipeline.ts` L865-950 : bloc P2+E1 avec `isFeatureEnabled("adversarial_challenge")`
- `src/orchestrator/pipeline.ts` L1431-1451 : bloc memory_promotion avec `isFeatureEnabled("memory_promotion")`
- `src/commands/exploration.ts` L79-82 : early return `if (!isFeatureEnabled("exploration_phase"))`
- `src/gate-evaluator.ts` L521-529 : early return `if (!isFeatureEnabled("exploration_gate"))`
- `src/llm-router.ts` L97-108 : bloc `if (isFeatureEnabled("exploration_phase"))`
- `src/memory/graph.ts` L836 : sous-guard `if (isFeatureEnabled("agent_role_memory"))` a l'interieur de `promoteWorkingMemory` — disparait avec la fonction

### 6.2 — Pattern import a retirer partiellement

Plusieurs imports sont des destructurations partielles. La regle : retirer uniquement les symboles des modules supprimes, conserver les autres.

Exemple dans `src/memory/graph.ts` L10 :
```typescript
// Avant
import { getAgentMemories, graduateAgentMemory, saveAgentMemory } from "./agent-memory.ts";
// Apres
import { getAgentMemories } from "./agent-memory.ts";
```

Exemple dans `src/orchestrator/pipeline.ts` L57 :
```typescript
// Avant
import { type ExplorationScore, shouldExplore } from "../exploration-scoring.ts";
// Apres : supprimer l'import entier (module supprime)
```

### 6.3 — Pattern barrel re-export (memory.ts)

Le barrel `src/memory.ts` (verifie par Read) re-exporte via blocs nommes. Retirer les 2 lignes :
```typescript
// Dans le bloc graph.ts (L35-55)
  promoteWorkingMemory,       // <- retirer
  type WorkingMemoryData,     // <- retirer
```

### 6.4 — Precaution memoryHealthStats

Dans `src/memory/graph.ts` L615, conserver cette ligne intacte :
```typescript
.eq("metadata->>source", "working_memory_promotion")
```
Ce filtre recherche des donnees historiques en base — il n'a aucun lien avec le flag `memory_promotion`.

## 7. Contraintes

- **Ne pas casser les tests actifs** : `bun test` doit passer a 0 fail apres chaque etape
- **Ne pas modifier la logique metier** des modules conserves — uniquement retirer des blocs inertes
- **Contrainte barrel** (CLAUDE.md) : `src/memory.ts` est un barrel — ne pas y ajouter de logique, uniquement retirer les re-exports des symboles supprimes
- **`isFeatureEnabled` dans `src/commands/exploration.ts`** : verifier si le module importe `isFeatureEnabled` uniquement pour la guard `exploration_phase`. Si oui, retirer l'import. Si `isFeatureEnabled` est utilise ailleurs dans le module (a verifier avec Grep), le conserver.
- **`isFeatureEnabled` dans `src/memory/graph.ts`** : NE PAS retirer — utilise pour `agent_role_memory` (L454) qui est un flag actif (true dans features.json)
- **Callbacks `prdwf_preflight_ok/abort/revise_prd` dans `planning.ts`** : ces callbacks ne peuvent jamais etre declenches car la maturation est desactivee. Ils doivent etre retires car ils importent des fonctions de modules supprimes.
- **`WorkingMemoryData` type** : utilise uniquement dans `memory-evolution.test.ts` (tests qui seront supprimes) et dans `memory.ts` barrel (export a retirer). Le retrait ne cree pas de regression TypeScript.
- **Ne pas toucher aux phases 2-6** de l'architecture : `src/auto-pipeline.ts`, `src/orchestrator/pipeline.ts`, `src/prd-workflow.ts`, `src/gate-evaluator.ts` sont tous conserves partiellement — Phase 1 ne fait que les emaigrir
- **Test `doc-freshness`** : ce test CI compare la liste des modules dans `src/` avec `CLAUDE.md`. La mise a jour de `CLAUDE.md` doit etre faite dans le meme commit que la suppression des fichiers
- **Reduction du compteur de tests** : le passage de 4035 a ~3357 tests n'est pas une regression — c'est une reduction intentionnelle documentee

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `src/spec-lite.ts` n'existe plus | `ls src/spec-lite.ts` retourne "not found" | unit |
| V2 | `src/adversarial-challenge.ts` n'existe plus | `ls src/adversarial-challenge.ts` retourne "not found" | unit |
| V3 | `src/exploration-scoring.ts` n'existe plus | `ls src/exploration-scoring.ts` retourne "not found" | unit |
| V4 | `bun run tsc --noEmit` (ou equivalent typecheck) passe sans erreur | CI typecheck vert | integration |
| V5 | `bun test` passe a 0 fail | CI tests verts | integration |
| V6 | `config/features.json` ne contient plus les 6 cles supprimees | Grep `exploration_phase\|exploration_gate\|spec_phase_lite\|adversarial_challenge\|prd_maturation_phases\|memory_promotion` dans features.json retourne 0 resultats | unit |
| V7 | Aucune reference aux modules supprimes dans les imports TypeScript actifs | `grep -r "from.*spec-lite\|from.*adversarial-challenge\|from.*exploration-scoring" src/` retourne 0 resultats | unit |
| V8 | Aucune reference aux 6 flags supprimes dans le code TypeScript actif | `grep -r "isFeatureEnabled.*exploration_phase\|spec_phase_lite\|adversarial_challenge\|prd_maturation_phases\|memory_promotion\|exploration_gate" src/` retourne 0 resultats | unit |
| V9 | Les 5 agents obsoletes n'existent plus | `ls .claude/agents/impact-analyst.md .claude/agents/security-checker.md .claude/agents/test-architect.md .claude/agents/implementer.md .claude/agents/tester.md` retourne "not found" | unit |
| V10 | Les 3 dossiers de skills obsoletes n'existent plus | `ls .claude/skills/dev-spec .claude/skills/dev-challenge .claude/skills/dev-pipeline` retourne "not found" | unit |
| V11 | `src/memory/graph.ts` ne contient plus `promoteWorkingMemory` ni `WorkingMemoryData` | Grep `promoteWorkingMemory\|WorkingMemoryData` dans `src/memory/graph.ts` retourne 0 resultats | unit |
| V12 | `src/memory/graph.ts` conserve `getAgentMemories` dans son import `agent-memory.ts` | Grep `getAgentMemories` dans `src/memory/graph.ts` retourne au moins 1 resultat | unit |
| V13 | `src/memory/graph.ts` conserve le filtre `working_memory_promotion` dans `memoryHealthStats` | Grep `working_memory_promotion` dans `src/memory/graph.ts` retourne 1 resultat (L615) | unit |
| V14 | `src/memory.ts` barrel ne re-exporte plus `promoteWorkingMemory` ni `WorkingMemoryData` | Grep `promoteWorkingMemory\|WorkingMemoryData` dans `src/memory.ts` retourne 0 resultats | unit |
| V15 | `src/commands/exploration.ts` n'a plus la guard `exploration_phase` mais existe toujours | Grep `exploration_phase` dans `src/commands/exploration.ts` retourne 0 ; fichier existe | unit |
| V16 | `tests/generated/reviser-prd-to-deploy-workflow.test.ts` n'existe plus | `ls` retourne "not found" | unit |
| V17 | `tests/unit/logger-migration.test.ts` ne contient plus `adversarial-challenge.ts` ni `spec-lite.ts` dans `MIGRATED_MODULES` | Grep `adversarial-challenge\|spec-lite` dans `logger-migration.test.ts` retourne 0 | unit |
| V18 | `CLAUDE.md` ne contient plus les lignes `dev-spec`, `dev-challenge`, `dev-pipeline` dans la table Dev Pipeline | Grep `dev-spec\|dev-challenge\|dev-pipeline` dans la table Dev Pipeline de CLAUDE.md retourne 0 | unit |
| V19 | `CLAUDE.md` liste 6 agents (non 11) dans `.claude/agents/` | Compter les lignes agents dans CLAUDE.md = 6 | manual |
| V20 | `CLAUDE.md` liste 4 skills (non 7) dans `.claude/skills/` | Compter les lignes skills dans CLAUDE.md = 4 | manual |
| V21 | `src/prd-workflow.ts` ne contient plus `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `PreflightReport`, `formatPreflightReport`, `buildPreflightResultTag`, `buildPreflightKeyboard`, `storePendingProtoSpec`, `getPendingProtoSpec`, `clearPendingProtoSpec` | Grep dans `prd-workflow.ts` retourne 0 | unit |
| V22 | `src/commands/planning.ts` ne contient plus de reference a `isPrdMaturationEnabled` ni aux callbacks `prdwf_preflight_ok/abort/revise_prd` | Grep dans `planning.ts` retourne 0 | unit |
| V23 | Le test `doc-freshness` passe en CI | CI doc-freshness vert (CLAUDE.md coherent avec src/) | integration |
| V24 | `src/orchestrator/pipeline.ts` ne contient plus de reference a `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis`, `shouldExplore`, `promoteWorkingMemory` | Grep retourne 0 dans pipeline.ts | unit |
| V25 | `src/job-manager.ts` ne contient plus de reference a `buildPreflightKeyboard` | Grep `buildPreflightKeyboard` dans `job-manager.ts` retourne 0 | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Le probleme est explicitement documente dans ARCHITECTURE-V2.md et EXPLORE §1 : ~2100 LOC morts a retirer, 6 flags desactives attestes dans features.json |
| Perimetre | Couvert | Option B (Phase 1 complete) specifiee precisement : 3 modules TS entiers + sections chirurgicales dans 8 modules + 5 agents + 3 skills + 6 tests. Perimetre exact verifie par archeologie codebase. |
| Validation | Couvert | 24 V-criteres couvrant : existence de fichiers, 0 references aux symboles supprimes, typecheck, bun test, doc-freshness CI |
| Technique | Couvert | Dependances unidirectionnelles confirmees par Grep. Cas limites identifies (getAgentMemories a conserver, working_memory_promotion filtre a conserver, callbacks preflight dans planning.ts) |
| UX | Non applicable | Pas d'interaction utilisateur modifiee. La commande `/explore` continue de fonctionner (sans la guard). |
| Alternatives | Couvert | Matrice A/B/C evaluee dans EXPLORE §4. Option B recommandee et retenue. |

**Zones d'ombre residuelles :**

1. **`src/commands/exploration.ts` — `isFeatureEnabled` import** : apres retrait de la guard `exploration_phase`, verifier si `isFeatureEnabled` est utilise ailleurs dans le module. L'archeologie (Read L1-25) montre l'import en L21. Si la guard L79-82 est le seul usage, retirer l'import. A verifier au moment de l'implementation avec Grep.

2. **`src/commands/planning.ts` — callbacks preflight** : les callbacks `prdwf_preflight_ok`, `prdwf_preflight_abort`, `prdwf_revise_prd` (L667-773) referent a `getPendingProtoSpec`, `clearPendingProtoSpec`, `storePendingProtoSpec`. Ces fonctions sont supprimees de `prd-workflow.ts`. Les callbacks doivent etre entierement retires. Confirmer qu'ils ne sont pas references par d'autres parties du module (Grep `prdwf_preflight` dans planning.ts avant suppression).

3. **Comptage exact des tests supprimes** : l'estimation ~678 tests est approximative. Le comptage reel sera connu apres `bun test` post-suppression. Ce n'est pas un bloquant — seul le critere "0 fail" importe.

4. **`src/prd-workflow.ts` — fonctions pendingProtoSpec** : `storePendingProtoSpec`, `getPendingProtoSpec`, `clearPendingProtoSpec` sont des utilitaires de stockage en memoire qui servent uniquement les callbacks preflight. Ils doivent etre supprimes avec les callbacks. Le type `PreflightReport` peut aussi etre retire car uniquement utilise par les fonctions supprimees.
