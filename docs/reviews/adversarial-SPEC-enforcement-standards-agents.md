# Adversarial Review — SPEC-enforcement-standards-agents

> Date : 2026-03-23
> Spec source : `docs/specs/SPEC-enforcement-standards-agents.md`
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic

---

## Synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|-----------------|-----------------|-------------------|-------|
| BLOQUANT | 1 | 1 | 0 | 2 |
| MAJEUR   | 3 | 3 | 3 | 9 |
| MINEUR   | 2 | 2 | 2 | 6 |
| **Total** | **6** | **6** | **5** | **17** |

### Verdict : GO WITH CHANGES

**Justification** : 2 BLOQUANTs resolvables (contradictions corrigeables sans remettre en cause l'architecture) + 9 MAJEURs. La spec est solide sur le fond — l'approche double couche (prompt + tests structurels) est pragmatique et bien calibree. Les BLOQUANTs concernent une contradiction interne dans reviewer.md et l'inadequation du filtre `getCodeLines` pour les template literals multilignes. Les deux sont resolvables par des corrections ciblees.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — Contradiction entre la spec et reviewer.md existant sur console.error**
- Source : Regle R3, Section 4 (Livrable 1), reviewer.md ligne 41
- Description : La spec demande d'ajouter dans reviewer.md un item "pas de `console.log/error/warn` direct (utiliser `createLogger`)" (R3). Or le meme fichier reviewer.md contient deja a la ligne 41 : "Destructuration `{ error }` sur les operations Supabase avec `console.error` si erreur". C'est une contradiction directe : le reviewer aurait dans sa checklist deux items mutuellement exclusifs — l'un interdisant `console.error`, l'autre le prescrivant.
- Impact : Un agent reviewer suivant les deux consignes produirait des findings incoherents. Cela discredite la checklist entiere.
- Evidence : reviewer.md L41 : `- [ ] Destructuration { error } sur les operations Supabase avec console.error si erreur`

**[MAJEUR] F-DA-2 — Allowlist process.env trop large et non definie**
- Source : Section 7 (Limites techniques), Regle R6
- Description : La spec identifie 27 fichiers utilisant `process.env.` et prevoit une allowlist "documentee dans le test avec un commentaire justificatif par entree", mais n'en definit pas le contenu. Le travail d'audit (determiner quels usages sont legitimes parmi 65 occurrences dans 27 fichiers) est repousse a l'implementation. C'est une decision arbitraire : soit le scope de l'allowlist est dans la spec, soit le standard S2 est premature.
- Impact : L'implementeur devra prendre 27 decisions de classification sans criteres clairs dans la spec. Risque d'allowlist trop permissive (qui annule l'utilite du test) ou trop restrictive (faux positifs en CI).

**[MAJEUR] F-DA-3 — V13 est inveriable en l'etat**
- Source : Section 8 (V-criteres), V13
- Description : V13 demande que "l'allowlist LOC dans le test contient exactement les fichiers documentes dans CLAUDE.md comme au-dessus du seuil". Or CLAUDE.md documente 3 fichiers (agent-schemas.ts 1091, gate-evaluator.ts 937, workflow.ts 848) tandis que la spec elle-meme en Section 7 en liste 7 (ajoutant pipeline.ts 1486, planning.ts 1005, zz-messages.ts 909, graph.ts 855). Ces 7 fichiers correspondent a la realite du codebase verifie. V13 pointe vers CLAUDE.md qui est incomplet — il faudrait d'abord mettre a jour CLAUDE.md.
- Impact : V13 echoue systematiquement a moins de choisir entre les 3 fichiers de CLAUDE.md et les 7 fichiers reels. La spec ne tranche pas.
- Evidence : CLAUDE.md "File size guideline" ne mentionne que `agent-schemas.ts`, `gate-evaluator.ts`, `workflow.ts`. `wc -l` sur les 7 fichiers confirme qu'ils depassent tous 800 LOC.

**[MAJEUR] F-DA-4 — Spec affirme "4 fichiers modifies" mais en necessite potentiellement 5**
- Source : Section 4 (Livrable 1)
- Description : La Section 4 annonce "4 fichiers modifies" mais en liste 3 (bmad-prompts.ts, implementer.md, reviewer.md). Le 4eme est `src/orchestrator/agent-step.ts` mentionne dans le texte. De plus, la correction du BLOQUANT F-DA-1 (ligne 41 de reviewer.md) implique de modifier un item existant en plus d'en ajouter, et la mise a jour de CLAUDE.md (F-DA-3) ajouterait un 5eme fichier. Le compte "4 fichiers modifies" est donc a la fois incorrectement presente (3 + 1 dans le texte) et potentiellement sous-evalue.
- Impact : Mineur en soi, mais temoigne d'un manque de rigueur dans le denombrement des livrables.

**[MINEUR] F-DA-5 — R10 "max 6 items" vs V10 "max 15 lignes" — confusion de metrique**
- Source : Regle R10, Critere V10
- Description : R10 dit "max 6 items, 1-2 phrases par standard" mais V10 verifie "max 15 lignes ajoutees par point d'injection". 6 items x 2 phrases = 12 lignes + espacements = potentiellement > 15 lignes. Les deux metriques ne sont pas coherentes. De plus, V10 donne "max 3" pour getOrchestrationInstructions mais R10 demande aussi "6 items" — impossible en 3 lignes.
- Impact : Le critere V10 est ambigu. L'implementeur devra choisir entre respecter R10 (6 items) et V10 (3 lignes pour orchestration).

**[MINEUR] F-DA-6 — Regle R9 sous-documentee sur le mecanisme de validation**
- Source : Regle R9, Section 8
- Description : R9 dit que le Result type est "enforce uniquement par le prompt (couche soft)". Mais il n'y a aucun V-critere qui verifie que le prompt mentionne effectivement Result<T,E> de maniere utile. V1 verifie juste la presence du mot "Result" dans le string retourne, pas que l'instruction est actionnable. Un prompt contenant "Voir CLAUDE.md pour Result" satisferait V1 sans rien enforcer.
- Impact : L'enforcement "soft" pourrait etre purement cosmétique.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — getCodeLines ne gere pas les template literals multilignes**
- Scenario : Un fichier contient un template literal multiligne avec `console.log` dans le texte (pas dans le code) :
  ```typescript
  const prompt = `
  Utilise console.log pour debugger
  `;
  ```
  La fonction `getCodeLines` (copiee de logger-migration.test.ts) filtre les lignes de commentaires (// et /* et *) mais ne filtre pas les lignes a l'interieur de template literals multilignes. `hasRealConsoleCall` remplace les strings sur une seule ligne (`/`[^`]*`/g` ne traverse pas les lignes). La ligne "Utilise console.log pour debugger" passerait le filtre getCodeLines (ce n'est pas un commentaire) et hasRealConsoleCall detecterait `console.log` car le replacement de template ne couvrirait pas un template qui s'etend sur plusieurs lignes.
- Source : Section 6 (Pattern 1), Regle R4
- Impact : Faux positifs en CI. Un fichier comme `gate-persistence.ts` (qui a `"log les erreurs avec console.error"` dans un template string) pourrait declencher un echec si le template est reformate sur plusieurs lignes.
- Frequence estimee : Occasionnel — les prompts dans le codebase contiennent frequemment des references a console.error dans des template literals.

**[MAJEUR] F-EC-2 — Test S4 ne couvre pas les imports dynamiques ni les re-exports**
- Scenario : Un fichier service fait `const mod = await import("./commands/foo.ts")` ou un barrel re-exporte un module de commands/. Le test S4 ne verifie que les imports statiques via regex `from "./commands/"`. Les imports dynamiques (pattern `import("...")`) et les re-exports (`export { ... } from "./commands/..."`) ne sont pas mentionnes.
- Source : Section 4 (S4: architectural boundaries), Regle R8
- Impact : Un contournement de la frontiere architecturale ne serait pas detecte par le test.
- Frequence estimee : Rare — le codebase n'utilise actuellement pas ce pattern, mais rien ne l'empeche.

**[MAJEUR] F-EC-3 — Pas de gestion de l'evolution de la liste des sous-repertoires pour S5**
- Scenario : Un developpeur cree un nouveau sous-repertoire `src/alerts/` (en decomposant alerts.ts) et oublie de creer le barrel `src/alerts.ts`. Le test S5 est decrit comme verifiant "chaque sous-repertoire de src/" mais la spec ne precise pas comment la decouverte automatique fonctionne (glob sur les directories ?). Si le test utilise une liste statique `["memory", "orchestrator"]`, il ne detecterait pas le nouveau sous-repertoire.
- Source : Section 4 (S5: barrel convention), Regle R5
- Impact : Le test S5 deviendrait obsolete des qu'un nouveau module serait decompose.
- Frequence estimee : Occasionnel — le pattern de decomposition a ete utilise 2 fois (memory, orchestrator) et sera probablement reutilise.

**[MAJEUR] F-EC-4 — Test S2 (process.env) avec 27 fichiers en allowlist perd son utilite**
- Scenario : Si les 27 fichiers actuellement utilisant process.env sont tous mis en allowlist, le test S2 ne detecterait des violations que dans les futurs fichiers. Mais un developpeur ajoutant `process.env.` dans un fichier deja en allowlist (pour un usage different) ne serait pas detecte.
- Source : Section 7 (Limites techniques), Regle R4
- Impact : L'allowlist est par fichier, pas par occurrence. Un fichier en allowlist pour `process.env.NODE_ENV` pourrait librement utiliser `process.env.SECRET_KEY` sans detection.
- Frequence estimee : Occasionnel — les fichiers en allowlist sont ceux ou les developpeurs sont le plus susceptibles d'ajouter d'autres usages.

**[MINEUR] F-EC-5 — Pas de test pour la regression de l'allowlist LOC**
- Scenario : Un fichier en allowlist est refactorise sous 800 LOC mais l'allowlist n'est pas mise a jour. Le test continue de passer (pas d'echec) mais l'allowlist est desormais incorrecte (elle autorise un fichier qui n'a plus besoin d'exemption). La spec reconnait ce probleme en Section 9 ("pas de mecanisme automatique de nettoyage") mais ne propose aucune mitigation.
- Source : Section 9 (Zones d'ombre), Section 4 (S3)
- Impact : L'allowlist LOC grossit monotoniquement, jamais ne retrecit. A terme elle perd sa valeur documentaire.
- Frequence estimee : Rare a court terme, certain a long terme.

**[MINEUR] F-EC-6 — Le test S1 pourrait avoir des faux negatifs sur console.debug/info/trace**
- Scenario : La spec mentionne `console.log/error/warn` (3 methodes). Mais `console.debug`, `console.info`, `console.trace` existent aussi et contournent le standard. Un developpeur utilisant `console.info` au lieu de `log.info` ne serait pas detecte.
- Source : Section 4 (S1: no direct console calls), Regle R4
- Impact : Contournement du standard par utilisation d'une methode console non couverte.
- Frequence estimee : Rare — mais possible.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — La couche "soft" (injection prompts) a une valeur incertaine pour un cout de maintenance certain**
- Source : Section 4 (Livrable 1), Regles R1-R3, R10
- Description : La spec propose de modifier 4 fichiers pour injecter des instructions textuelles dans les prompts agents. Mais ces instructions sont des recommandations passives — l'agent peut les ignorer. Seule la couche "hard" (tests CI) garantit reellement l'enforcement. La couche soft ajoute du texte a maintenir dans 4 fichiers distincts (synchronisation manuelle avec CLAUDE.md a chaque evolution des standards) pour un benefice non mesurable.
- Alternative : Se limiter a la couche hard (tests structurels) + un seul point de reference (CLAUDE.md) que les agents lisent deja automatiquement. Si l'agent lit CLAUDE.md (ce qui est le cas pour Claude Code), les instructions injectees dans les prompts sont redondantes.
- Codebase : CLAUDE.md est charge automatiquement par Claude Code. Les 6 standards y sont deja documentes dans la section "Conventions".

**[MAJEUR] F-SS-2 — Les allowlists representent une dette technique structurelle**
- Source : Section 7 (Limites techniques), Regles R6, R7
- Description : La spec introduit potentiellement une allowlist de 27 fichiers (process.env) + 7 fichiers (LOC) + 2 fichiers (config.ts, logger.ts pour exclusions console/env). Soit ~36 entrees d'exception pour un codebase de 88 fichiers. Le ratio exception/fichier est de 41%, ce qui est tres eleve. Un test dont 41% des sujets sont exemptes a une valeur limitee.
- Alternative : Pour process.env, envisager une approche par pattern (autoriser `process.env.NODE_ENV` partout mais interdire les autres) plutot que par fichier. Pour LOC, accepter le seuil actuel et ne tester que les nouveaux fichiers (diff-based).
- Codebase : Le test logger-migration.test.ts utilise deja une liste statique de 23 modules. La spec critique cette approche (R5 : "pas de liste statique") tout en creant des allowlists statiques de taille comparable.

**[MAJEUR] F-SS-3 — La spec sous-estime la duplication avec logger-migration.test.ts**
- Source : Section 5 (Fichiers concernes), Section 6 (Pattern 1)
- Description : Le nouveau test `coding-standards.test.ts` duplique la logique de `logger-migration.test.ts` : meme scan de fichiers src, memes fonctions `getCodeLines`/`hasRealConsoleCall`, meme verification d'absence de console calls. La seule difference est que coding-standards.test.ts scanne dynamiquement (glob) et logger-migration.test.ts utilise une liste statique. Le risque de divergence entre les deux tests est reel (un bug corrige dans l'un mais pas l'autre). La spec dit explicitement "pas importer depuis un test" et "logger-migration.test.ts reste tel quel" — mais ne justifie pas pourquoi les deux tests doivent coexister.
- Alternative : Supprimer ou deprecier `logger-migration.test.ts` en faveur de `coding-standards.test.ts` (qui est un superset strict). Ou extraire les fonctions partagees dans un fichier `tests/helpers/code-scan.ts`.
- Codebase : logger-migration.test.ts (201 LOC) verifie exactement les memes invariants que S1 de coding-standards.test.ts, mais sur une liste statique de 23 modules.

**[MINEUR] F-SS-4 — La section "Patterns existants" duplique ce qui est dans le codebase**
- Source : Section 6
- Description : Les 4 patterns sont des copies verbatim du code existant avec numeros de lignes. Cette section sera obsolete des que les lignes changent. C'est de la documentation de reference qui devrait etre dans un commentaire ou une reference au fichier, pas dans la spec.
- Alternative : Remplacer par "Reutiliser le pattern de `tests/unit/logger-migration.test.ts` L78-103" sans copier le code.

**[MINEUR] F-SS-5 — R10 ajoute une contrainte de concision auto-referee**
- Source : Regle R10, V10
- Description : R10 demande "max 6 items, 1-2 phrases par standard" et V10 verifie "max 15 lignes". Mais c'est une contrainte que seul l'auteur de la spec peut verifier (comptage de lignes dans un diff). Elle n'est pas testable automatiquement et ajoute de la complexite a la spec sans valeur d'enforcement.
- Alternative : Supprimer V10 et faire confiance au bon sens de l'implementeur. Ou le remplacer par un test structurel qui verifie que le prompt total reste sous une taille raisonnable.

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 2

---

## Findings dedupliques (croises entre agents)

| # | Finding | Agents | Severite |
|---|---------|--------|----------|
| 1 | Contradiction reviewer.md console.error vs standard S1 | DA-1 | BLOQUANT |
| 2 | getCodeLines ne gere pas les template literals multilignes | EC-1 | BLOQUANT |
| 3 | Allowlist process.env non definie, trop large, audit repousse | DA-2, EC-4, SS-2 | MAJEUR |
| 4 | V13 inveriable car CLAUDE.md incomplet (3 fichiers vs 7 reels) | DA-3 | MAJEUR |
| 5 | Duplication coding-standards.test.ts vs logger-migration.test.ts | SS-3 | MAJEUR |
| 6 | Valeur incertaine de la couche soft (CLAUDE.md deja lu) | SS-1 | MAJEUR |
| 7 | R10/V10 metriques incoherentes (6 items vs 15 lignes vs 3 lignes) | DA-5, SS-5 | MAJEUR |
| 8 | Comptage fichiers modifies incorrect (3 vs 4 vs 5) | DA-4 | MAJEUR |
| 9 | Test S4 ne couvre pas imports dynamiques | EC-2 | MAJEUR |
| 10 | Test S5 potentiellement statique malgre R5 | EC-3 | MAJEUR |
| 11 | R9 enforcement soft sans V-critere actionnable | DA-6 | MINEUR |
| 12 | Pas de nettoyage auto de l'allowlist LOC | EC-5 | MINEUR |
| 13 | S1 ne couvre pas console.debug/info/trace | EC-6 | MINEUR |
| 14 | Section "Patterns existants" fragile (numeros de ligne) | SS-4 | MINEUR |

---

## Recommandations (actions concretes pour passer a GO)

### Obligatoires (resolvent les BLOQUANTs)

1. **Corriger la contradiction reviewer.md** (F-DA-1) : Modifier la ligne 41 de reviewer.md dans le livrable. Remplacer `console.error` par `log.error` dans l'item existant "Destructuration `{ error }` sur les operations Supabase avec ~~console.error~~ `log.error(...)` si erreur". Ceci doit etre fait dans le scope de cette spec car la spec touche deja ce fichier.

2. **Ameliorer le filtre pour template literals multilignes** (F-EC-1) : `hasRealConsoleCall` ne suffit pas pour les template literals qui s'etendent sur plusieurs lignes. Ajouter un pre-traitement qui retire les contenus de template literals multilignes avant le scan ligne par ligne, ou utiliser un mode de scan qui detecte les ouvertures/fermetures de backticks. Alternative pragmatique : documenter la limite et accepter les faux positifs rares comme risque residuel (avec un commentaire `// KNOWN_LIMITATION: multiline template literals` dans le test).

### Fortement recommandees (resolvent les MAJEURs)

3. **Definir l'allowlist process.env dans la spec** (F-DA-2, F-EC-4) : Au minimum categoriser les 27 fichiers en "legitime" vs "a migrer". Envisager un format d'allowlist par pattern (`process.env.NODE_ENV` autorise partout) plutot que par fichier entier.

4. **Mettre a jour CLAUDE.md** (F-DA-3) : Inclure les 7 fichiers >800 LOC dans la section "File size guideline", ou preciser que l'allowlist dans le test fait reference.

5. **Harmoniser R10/V10** (F-DA-5, SS-5) : Choisir une seule metrique (nombre d'items OU nombre de lignes) et l'appliquer uniformement. Suggestion : "max 8 items pour getDevInstructions, max 1 item de reference pour getOrchestrationInstructions".

6. **Gerer la duplication avec logger-migration.test.ts** (F-SS-3) : Au minimum ajouter un commentaire dans les deux fichiers pointant vers l'autre. Idealement, extraire les helpers dans `tests/helpers/code-scan.ts` ou deprecier le test statique.

7. **Rendre S5 dynamique** (F-EC-3) : Le test S5 doit lister dynamiquement les sous-repertoires de `src/` (via `readdirSync` + `statSync`) et non utiliser une liste statique.

---

## Points forts identifies

- **Approche double couche** (soft + hard) bien pensee : la couche soft guide l'agent, la couche hard garantit en CI. Meme si la couche soft a une valeur debattue, la ceinture-bretelles est defensable pour un projet solo sans revue humaine systematique.
- **Reutilisation des patterns existants** (getCodeLines, hasRealConsoleCall, buildIsolationInstructions) : la spec ne reinvente pas la roue.
- **R9 (Result type non testable par regex)** est un bon jugement d'ingenierie. Eviter les faux positifs vaut mieux que forcer un test inadapte.
- **Tracabilite** excellente : chaque regle a une source (exploration, CLAUDE.md, ADR-008), chaque V-critere a un niveau de test. Les 13 V-criteres couvrent bien les deux livrables.
- **Scope maitrise** : 5 fichiers modifies + 1 cree, pas de nouvelle dependance. C'est un changement de configuration/test, pas un changement architectural.

---

## Etape suivante

Verdict **GO WITH CHANGES** : mettre a jour `docs/specs/SPEC-enforcement-standards-agents.md` selon les recommandations ci-dessus (au minimum les 2 obligatoires + corrections V13 et R10/V10), puis lancer :

```
/dev-implement "Implementer SPEC-enforcement-standards-agents. Spec: docs/specs/SPEC-enforcement-standards-agents.md"
```
