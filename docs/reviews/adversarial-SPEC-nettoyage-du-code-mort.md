# Adversarial Challenge — SPEC-nettoyage-du-code-mort

> Genere le 2026-03-24. Source : docs/specs/SPEC-nettoyage-du-code-mort.md

## Tableau de synthese

| ID | Agent | Severite | Titre |
|----|-------|----------|-------|
| F-DA-1 | Devil's Advocate | BLOQUANT | `shouldExplore` appele inconditionnellement dans pipeline.ts — typecheck echoue |
| F-EC-1 | Edge Case Hunter | BLOQUANT | `buildPreflightKeyboard` importee dans `job-manager.ts` — non couverte par la spec |
| F-DA-2 | Devil's Advocate | MAJEUR | `prd-workflow.ts` imports `adversarial-challenge.ts` + `spec-lite.ts` non adresses explicitement |
| F-SS-1 | Simplicity Skeptic | MAJEUR | R6 omet `formatPreflightReport` du perimetre de suppression de `prd-workflow.ts` |
| F-EC-2 | Edge Case Hunter | MAJEUR | Tests dans `orchestrator.test.ts` — lignes V14/V12 partiellement conservees selon la spec |
| F-DA-3 | Devil's Advocate | MAJEUR | Contradiction entre V18 et la spec : `dev-challenge` est a la fois supprime et conserve |
| F-SS-2 | Simplicity Skeptic | MAJEUR | Mise a jour de `CLAUDE.md` sous-specifiee — risque de rupture du test `doc-freshness` |
| F-EC-3 | Edge Case Hunter | MINEUR | Comptage tests (~678) non verifiable a priori — risque ecart avec realite |
| F-SS-3 | Simplicity Skeptic | MINEUR | R14 mentionne `tests/unit/orchestrator.test.ts` mais les blocs [V12] P1/P2 sont valides sans flags |
| F-DA-4 | Devil's Advocate | MINEUR | Zone d'ombre 9.2 insuffisamment precisee pour les callbacks preflight dans planning.ts |

---

## Verdict

**GO WITH CHANGES**

- 2 BLOQUANTs resolvables (corrections dans la spec, sans remettre en cause l'architecture)
- 2 MAJEURs supplementaires confirmant les lacunes

---

## Findings detailles

### Devil's Advocate

---

**[BLOQUANT] F-DA-1 — `shouldExplore` appele inconditionnellement dans `pipeline.ts` — typecheck echoue**

- Source : Section 3 (Donnees d'entree) / Section 5 (Fichiers concernes) — `src/orchestrator/pipeline.ts`
- Description : La spec dit de supprimer le module `src/exploration-scoring.ts` et de retirer l'import L57 (`type ExplorationScore, shouldExplore`). Mais `shouldExplore` est appele inconditionnellement a la ligne 147 de `pipeline.ts`, en dehors de tout flag feature — le bloc L131-170 n'est pas derriere un `isFeatureEnabled`. Si l'implementeur retire uniquement l'import L57 (comme prescrit), la compilation TypeScript echoue avec "Cannot find name 'shouldExplore'". La spec ne mentionne pas ce bloc dans ses donnees d'entree (les 3 zones a modifier sont L325-412, L859-950, L1430-1451 selon §3 et §6.1).
- Impact : V4 (`bun run tsc --noEmit` passe sans erreur) echoue. L'implementation ne peut pas etre completee sans casser le build.
- Evidence : `src/orchestrator/pipeline.ts` L131-170 — bloc "Exploration phase: check if task needs research before decomposition" sans garde `isFeatureEnabled`. Confirmé par Grep : aucune occurrence de `exploration_phase` dans `pipeline.ts`.

---

**[MAJEUR] F-DA-2 — `prd-workflow.ts` : imports `adversarial-challenge.ts` et `spec-lite.ts` non adresses explicitement**

- Source : Section 3 — `src/prd-workflow.ts` / Regle R6
- Description : La spec dit de retirer "Imports L12-14, L35" de `prd-workflow.ts`. Ces imports (`runAdversarialChallenge`, `runImpactAnalysis` depuis `adversarial-challenge.ts` et `generateProtoSpec`, `StoryFileInput` depuis `spec-lite.ts`) sont utilises exclusivement dans `runPrdPreflightChecks` (L577-684). La spec confirme que ces fonctions sont supprimees. Mais la spec §3 ne liste pas explicitement les imports L12-14 et L35 dans les "champs utilises" pour `prd-workflow.ts` — seuls "Imports L12-14, L35 ; types et fonctions L51-64, L517-535, L540-551, L553-784" sont cites. C'est correct mais ambigu : l'import L35 extrait `StoryFileInput` qui pourrait avoir d'autres usages dans le fichier. Risque de TypeScript error si `StoryFileInput` est supprime mais reste reference.
- Impact : Rupture de compilation potentielle si l'implementeur retire L35 integralement sans verifier les autres usages de `StoryFileInput`.

---

**[MAJEUR] F-DA-3 — Contradiction V18 vs spec : `dev-challenge` est simultanement a supprimer et conserve**

- Source : Section 4.5 (CLAUDE.md sortie attendue) / Regle R11 / V18 / V10
- Description : La spec dit (R11 + V18) de retirer `dev-challenge` de la table Dev Pipeline dans `CLAUDE.md`. La spec dit aussi (R9 + V10) de supprimer le dossier `.claude/skills/dev-challenge/`. Mais le present skill `dev-challenge/SKILL.md` est celui utilise pour generer ce rapport adversarial (il est en cours d'execution). La spec supprime l'outil qui sert a valider la spec elle-meme. Ce n'est pas techniquement un bloquant pour l'implementation, mais c'est une incoherence architecturale : apres le nettoyage, le workflow de dev-challenge sera supprime alors que `CLAUDE.md` continue de referencer le workflow `/dev-spec → /dev-challenge → /dev-implement`. La section 4.5 indique que `CLAUDE.md` doit garder `dev-explore`, `dev-implement`, `dev-review`, `dev-doc` mais retirer `dev-spec`, `dev-challenge`, `dev-pipeline`. Or la section "Dev Pipeline" de `CLAUDE.md` actuel (L225) decrit le workflow complet incluant `dev-challenge`. La spec est coherente en elle-meme mais l'impact operationnel (plus de skill pour valider les specs futures) n'est pas discute.
- Impact : Apres nettoyage, le workflow documenté dans `CLAUDE.md` devient incomplet (references a `dev-spec` disparaissent mais le processus de validation des specs n'est pas remplace).

---

**[MINEUR] F-DA-4 — Zone d'ombre 9.2 insuffisamment precisee pour les callbacks preflight dans `planning.ts`**

- Source : Section 9 (zones d'ombre) — point 2
- Description : La zone d'ombre 9.2 indique "Confirmer qu'ils ne sont pas references par d'autres parties du module (Grep `prdwf_preflight` dans planning.ts avant suppression)". Mais la spec ne dicte pas ce que l'implementeur doit faire si `prdwf_preflight_ok/abort/revise_prd` sont references ailleurs. C'est une instruction incomplète ("a verifier") sans plan de contingence.
- Impact : Si un test ou un autre module reference ces callbacks, l'implementeur n'a pas de directive claire.

---

### Edge Case Hunter

---

**[BLOQUANT] F-EC-1 — `buildPreflightKeyboard` importee dans `job-manager.ts` — non couverte par la spec**

- Scenario : La spec (R6) indique de supprimer `buildPreflightKeyboard` de `prd-workflow.ts`. Or `src/job-manager.ts` L15 importe `buildPreflightKeyboard` depuis `prd-workflow.ts` et l'utilise a L298 dans le case `"prd-preflight"` du switch. Si `buildPreflightKeyboard` est supprimee, `job-manager.ts` aura une reference non resolue.
- Source : Regle R6 / Section 5 — liste des fichiers concernes
- Impact : Erreur TypeScript a la compilation : `Module '"./prd-workflow.ts"' has no exported member 'buildPreflightKeyboard'`. V4 echoue. Le fichier `job-manager.ts` n'est mentionné nulle part dans la spec (ni dans §3, ni dans §5, ni dans §7).
- Frequence estimee : Certain (toujours present dans le code au moment de l'implementation)

---

**[MAJEUR] F-EC-2 — Tests `orchestrator.test.ts` : blocs V12 partiellement valides sans les flags**

- Scenario : La spec (R14, §5) dit de supprimer les describes "[V14] Feature Flags for P1/P2/E1/P3", "[V12] P1/P2/E1/P3 pipeline scope guards", "memory_promotion feature flag", "Working memory promotion in orchestrate()" de `tests/unit/orchestrator.test.ts`. Mais le describe "[V12] P1/P2/E1/P3 pipeline scope guards" (L396-438) contient des tests valides qui ne testent PAS les flags : ils testent la structure des pipelines (QUICK ne contient pas "spec-lite", DEFAULT a dev apres architect, etc.). Ces assertions resteront vraies apres le nettoyage et sont des tests de regression utiles. La spec les supprime par inadvertance.
- Source : Section 5 / Regle R14 — `tests/unit/orchestrator.test.ts`
- Impact : Perte de tests de regression valides sur la structure des pipelines. Risque de regression silencieuse sur les definitions de pipelines.
- Frequence estimee : Certain si l'implementeur suit la spec a la lettre.

---

**[MINEUR] F-EC-3 — Comptage tests (~678 supprimes) non verifiable a priori**

- Scenario : La spec dit "4035 → ~3357 tests (suppression de ~678 tests directs)". Ce chiffre est une estimation. Si la realite est significativement differente (ex: 3357 tests mais plusieurs encore en echec a cause de dependances non identifiees), le critere V5 "0 fail" peut echouer.
- Source : Section 4.3 — Tests
- Impact : Mineur — la spec reconnait elle-meme l'incertitude ("~678" et "l'estimation ~678 tests est approximative"). La seule vraie contrainte est "0 fail".
- Frequence estimee : Rare.

---

### Simplicity Skeptic

---

**[MAJEUR] F-SS-1 — R6 : `formatPreflightReport` listee dans l'objectif mais omise dans les patterns de verification**

- Source : Regle R6 (Section 2) / Section 5 / V-critere V21
- Description : R6 liste `formatPreflightReport` parmi les fonctions a supprimer de `prd-workflow.ts`. V21 verifie l'absence de `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `PreflightReport`. Mais V21 ne verifie pas l'absence de `formatPreflightReport`, `buildPreflightResultTag`. Ces deux fonctions sont dans la liste R6 et dans la liste §3 (L685 et L762 de prd-workflow.ts), mais ne sont pas couvertes par un V-critere dedié. Un implementeur incomplet pourrait oublier ces deux fonctions. La spec est inconsistante dans la granularite de ses V-criteres.
- Alternative : Etendre V21 pour inclure `formatPreflightReport` et `buildPreflightResultTag`, ou les regrouper explicitement.
- Codebase : `src/prd-workflow.ts` L691 (`formatPreflightReport`), L762 (`buildPreflightResultTag`)

---

**[MAJEUR] F-SS-2 — Mise a jour CLAUDE.md sous-specifiee : risque de rupture `doc-freshness`**

- Source : Regle R11 / Section 4.5 / V-criteres V18, V19, V20, V23
- Description : La spec dit de mettre a jour `CLAUDE.md` pour reflechir 6 agents (non 11) et 4 skills (non 7). Mais `CLAUDE.md` ne contient pas de liste explicite des agents par nom — il contient seulement `11 specialized agents (dev pipeline)` et `7 skills (dev pipeline orchestration)` dans le bloc "Project Structure" (L207-208). Le test `doc-freshness` verifie la coherence entre les modules `src/` dans CLAUDE.md et les fichiers reels. Les agents `.claude/agents/` et `.claude/skills/` ne sont pas dans `src/` — il n'est pas certain que `doc-freshness` les verifie. La spec suppose que V23 (doc-freshness) sera satisfait par la mise a jour de CLAUDE.md, mais la relation causale n'est pas prouvee. Si `doc-freshness` verifie uniquement `src/`, alors supprimer les modules `spec-lite.ts`, `adversarial-challenge.ts`, `exploration-scoring.ts` de `src/` sans mettre a jour CLAUDE.md ferait echouer le test.
- Alternative : Verifier explicitement ce que teste `doc-freshness` avant d'implementer.
- Codebase : `tests/` — chercher le test `doc-freshness`

---

**[MINEUR] F-SS-3 — R14 supprime des tests [V12] utiles apres nettoyage**

- Source : Regle R14 / Section 5 — `tests/unit/orchestrator.test.ts`
- Description : La spec recommande de supprimer le describe "[V12] P1/P2/E1/P3 pipeline scope guards" car il "reference des flags supprimes". Mais en lisant les tests (L409-438), la majorite d'entre eux testent des proprietes structurelles des pipelines (QUICK = ["dev", "qa"], SOLO = ["dev"], position de "dev" apres "architect" dans DEFAULT). Ces tests restent valides et pertinents apres le nettoyage — ils n'ont aucune dependance sur les flags supprimes. Seul le test L409-415 qui verifie `QUICK_PIPELINE.not.toContain("spec-lite")` est specifiquement lie au flag. Supprimer tout le describe est une sur-suppression.
- Alternative : Ne retirer que les tests qui referencent explicitement les flags (`spec-lite`, `adversarial`), conserver les tests de structure pipeline.

---

## Recommandations (actions pour passer a GO)

### BLOQUANTS a corriger dans la spec

**1. [F-DA-1] Ajouter le bloc L131-170 de `pipeline.ts` au perimetre de suppression**

Dans la Section 3 (Donnees d'entree), pour `src/orchestrator/pipeline.ts`, ajouter aux champs utilises :
- "Bloc L131-170 : variable `_explorationScore`, appel `shouldExplore`, affectation conditionnelle de `pipeline`"

Ce bloc entier peut etre supprime car :
- `_explorationScore` n'est jamais utilise apres L150
- Le call `shouldExplore` est la seule utilisation des imports L57 (`ExplorationScore`, `shouldExplore`)
- Supprimer ce bloc + l'import L57 rend la suppression de `exploration-scoring.ts` safe

Ajouter aussi ce bloc aux blocs a retirer dans §6.1 (Guard pattern).

**2. [F-EC-1] Ajouter `src/job-manager.ts` au perimetre de modification**

Dans la Section 3 et la Section 5, ajouter :
- `src/job-manager.ts` | Modifier | Retirer l'import `buildPreflightKeyboard` (L15) et le case `"prd-preflight"` (L293-308) du switch dans la fonction de notification.

Ajouter le V-critere :
- V25 : `src/job-manager.ts` ne contient plus d'import `buildPreflightKeyboard` depuis `prd-workflow.ts`

### MAJEURs a considerer

**3. [F-SS-1] Etendre V21 pour couvrir `formatPreflightReport` et `buildPreflightResultTag`**

Modifier V21 : "Grep dans `prd-workflow.ts` retourne 0 pour `isPrdMaturationEnabled`, `runPrdPreflightChecks`, `PreflightReport`, `formatPreflightReport`, `buildPreflightResultTag`"

**4. [F-EC-2] Affiner R14 pour `orchestrator.test.ts`**

Modifier R14 pour `tests/unit/orchestrator.test.ts` : retirer uniquement les describes "[V14] Feature Flags for P1/P2/E1/P3", "memory_promotion feature flag", "Working memory promotion in orchestrate()". Conserver le describe "[V12] P1/P2/E1/P3 pipeline scope guards" en ne retirant que les tests `it("[V14]...")` a l'interieur.

**5. [F-SS-2] Verifier le perimetre du test `doc-freshness`**

Avant implementation, executer le test `doc-freshness` pour comprendre exactement ce qu'il verifie. S'il verifie la presence de `spec-lite.ts`, `adversarial-challenge.ts`, `exploration-scoring.ts` dans CLAUDE.md, alors supprimer ces modules de la liste dans `CLAUDE.md` est requis (ce qui est deja dans R11, mais la section Sources dans `CLAUDE.md` — `src/ 75 TypeScript modules` — doit aussi etre mise a jour).

---

## Points forts de la spec

- **Perimetre chirurgical excellent** : la spec identifie avec precision les lignes exactes a modifier (ex: R7 sur `graph.ts` avec la precaution L615 pour `working_memory_promotion`). C'est du travail d'archeologie solide.
- **Cas limites pre-identifies** : la zone d'ombre §9.1 sur `isFeatureEnabled` dans `exploration.ts` et §9.4 sur `pendingProtoSpec` montrent une anticipation reelle.
- **Verification independante des assertions** : les 24 V-criteres sont concrets, verificables par Grep/ls, et couvrent les principales surfaces de regression.
- **Contrainte barrel respectee** : R8 adresse correctement le barrel `src/memory.ts` sans y introduire de logique.
- **Precaution historique** : R3 (conserver le filtre `working_memory_promotion` dans `memoryHealthStats`) est une distinction subtile et correcte entre code mort et donnees historiques.
- **Dependances unidirectionnelles** : la spec a verifie que les modules supprimes ne sont importes que par les modules identifies. Les deux BLOQUANTs sont des imports inverses (pipeline.ts → exploration-scoring.ts, job-manager.ts → prd-workflow.ts) manques lors de l'archeologie.

---

## Statistiques par agent

| Agent | Bloquants | Majeurs | Mineurs | Total |
|-------|-----------|---------|---------|-------|
| Devil's Advocate | 1 | 2 | 1 | 4 |
| Edge Case Hunter | 1 | 1 | 1 | 3 |
| Simplicity Skeptic | 0 | 2 | 1 | 3 |
| **Total unique** | **2** | **3** | **2** | **7** |

---

## Etape suivante

Verdict **GO WITH CHANGES** : corriger la spec sur les 2 BLOQUANTs (F-DA-1 et F-EC-1) puis lancer :

```
/dev-implement "Implementer SPEC-nettoyage-du-code-mort. Spec: docs/specs/SPEC-nettoyage-du-code-mort.md"
```

Les corrections minimales requises avant implementation :
1. Ajouter L131-170 de `pipeline.ts` au perimetre de suppression (elimine F-DA-1)
2. Ajouter `job-manager.ts` comme fichier a modifier (elimine F-EC-1)
