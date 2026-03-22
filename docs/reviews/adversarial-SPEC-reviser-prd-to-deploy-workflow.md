# Challenge Adversarial — SPEC-reviser-prd-to-deploy-workflow

> Date : 2026-03-21
> Spec source : `docs/specs/SPEC-reviser-prd-to-deploy-workflow.md`
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic

---

## Synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|:---:|:---:|:---:|:---:|
| BLOQUANT | 1 | 1 | 0 | 2 |
| MAJEUR | 3 | 4 | 3 | 10 |
| MINEUR | 2 | 2 | 3 | 7 |

**Verdict : GO WITH CHANGES**

Justification : 2 findings BLOQUANTS identifies (F-DA-1 et F-EC-1), tous deux resolvables par une modification de la spec sans remettre en cause l'architecture. 10 findings MAJEURS dont plusieurs recoupements entre agents.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — runAdversarialChallenge est concu pour une tache, pas pour un PRD global**

- Source : Section 2, R2 ; Section 5, fichier `src/adversarial-challenge.ts`
- Description : R2 stipule que "P2 (adversarial challenge) + E1 (impact analysis) [sont executes] en parallele sur l'ensemble du PRD". Or, `runAdversarialChallenge` prend un `AdversarialInput` dont les champs sont `taskTitle`, `taskDescription`, `protoSpec` (une seule proto-spec), et `agentOutput`. L'interface est dimensionnee pour une tache unique, pas pour un PRD entier avec N taches et N proto-specs. La spec ne precise pas comment construire l'`AdversarialInput` a partir du PRD global : quel `taskTitle` utiliser ? Quel `protoSpec` passer quand il y en a N ? Faut-il concatener les N proto-specs ? Cet ecart rend l'implementation de R2 ambigue.
- Impact : L'implementeur devra inventer une adaptation non specifiee : soit wrapper les N proto-specs dans un seul `AdversarialInput` (non prevu par le type), soit appeler N fois la fonction (contredit R2 "globalement"), soit modifier `AdversarialInput` (la spec dit "pas de modification requise" en section 7).
- Evidence : Section 7 — "src/adversarial-challenge.ts : runAdversarialChallenge(input) — fonctions standalone, pas de modification requise." vs R2 — "P2 evaluent le PRD globalement".

**[MAJEUR] F-DA-2 — Contradiction verdict SKIPPED dans AdversarialResult vs PreflightReport**

- Source : Section 4.1 (PreflightReport) ; `src/agent-schemas.ts` ligne 198
- Description : Le type `AdversarialResult.verdict` a 3 valeurs : `PASS`, `PAUSE`, `SKIPPED`. Le `PreflightReport.verdict` a aussi 3 valeurs : `PASS`, `PAUSE`, `SKIPPED`. La spec (section 4.1, regles de remplissage) dit : "verdict PASS si adversarial.verdict === 'PASS' ou si P2 sautee". Mais `AdversarialResult` peut retourner `SKIPPED` (quand l'agent echoue, cf. F-DA-3 dans adversarial-challenge.ts). La spec ne definit pas le mapping SKIPPED de l'AdversarialResult vers le PreflightReport.verdict. Est-ce PASS ? SKIPPED ? PAUSE ? Un agent qui echoue silencieusement (SKIPPED) ne devrait probablement pas donner un verdict PASS au preflight.
- Impact : Si l'agent adversarial echoue et retourne SKIPPED, le preflight pourrait laisser passer un PRD non challenge comme s'il etait valide.

**[MAJEUR] F-DA-3 — runImpactAnalysis attend des chemins de fichiers, pas une liste concatenee de N proto-specs**

- Source : Section 5.3, pattern 6.3 ; `src/adversarial-challenge.ts` L.200
- Description : `runImpactAnalysis` prend `impactedFiles: string[]`. R2 dit que E1 est execute "sur l'ensemble du PRD". Quand il y a N proto-specs chacune avec ses `impacted_files`, la spec ne precise pas si on fait l'union des fichiers impactes de toutes les proto-specs ou s'il faut faire autrement. De plus, si P1 est desactivee (R5), `protoSpecs` est vide, et il n'y a aucune source de fichiers impactes pour E1 — la spec ne couvre pas ce cas.
- Impact : Sans fichiers impactes, `runImpactAnalysis` retourne LOW/0 modules/0 modules, rendant E1 inutile quand P1 est off.

**[MAJEUR] F-DA-4 — Hypothese non fondee sur le TTL 10 minutes**

- Source : Section 2, R8 ; Section 7 contraintes ; Section 9, zone d'ombre 3
- Description : Le TTL de 10 minutes pour `pendingProtoSpecs` est choisi par analogie avec `pendingDescriptions`, mais les cas d'usage sont differents. `pendingDescriptions` est utilise entre le moment ou l'utilisateur tape une commande et clique un bouton (quelques secondes). `pendingProtoSpecs` est utilise entre la fin du preflight (qui prend lui-meme 150s) et la confirmation par l'utilisateur, PUIS doit survivre jusqu'a la fin de l'implementation batch (potentiellement des heures) pour le conformance check (R11). Un TTL de 10 minutes est insuffisant pour le conformance check post-implementation.
- Evidence : R11 — "apres l'implementation batch (runBatchPipeline), si prd_maturation_phases est actif et qu'une proto-spec est disponible, le conformance check (P3) est execute". La batch peut durer des heures (timeout job = 2h). La proto-spec aura expire bien avant.

**[MINEUR] F-DA-5 — Callback prdwf_revise_prd vs prdwf_revise: confusion de noms**

- Source : Section 2, R10 et R13 ; Section 6, pattern 6.6
- Description : Le nouveau callback `prdwf_revise_prd` (16 bytes) coexiste avec le callback existant `prdwf_revise:{prdId}` (jusqu'a ~49 bytes). Les deux servent a "reviser le PRD" mais dans des contextes differents. Le spec (V11) dit que `prdwf_revise_prd` "redirige vers le flow de revision PRD existant". La distinction est fragile et pourrait creer de la confusion a la maintenance.
- Impact : Risque de confusion mineur entre les deux callbacks de revision.

**[MINEUR] F-DA-6 — Absence de prdWorkflowStep pour la phase conformance**

- Source : Section 5, fichier `src/conversation-session.ts` ; Section 2, R11
- Description : La spec ajoute `"spec_preflight"` a l'union type `prdWorkflowStep` mais n'ajoute pas de valeur pour la phase conformance post-implementation. L'etape conformance est implicitement couverte par `"implementation"` ou `"done"`, mais c'est une omission par rapport a la symetrie avec le preflight.
- Impact : Faible — le conformance check est lance dans le callback de completion du batch, pas en tant que step conversationnel distinct.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — Proto-spec perdue apres redemarrage du bot entre preflight et confirmation**

- Scenario : Le preflight genere les proto-specs, l'utilisateur recoit la notification avec les boutons. Le bot redemarrage (deploy, crash, pm2 restart). L'utilisateur clique sur "prdwf_preflight_ok". Les proto-specs en memoire (Map) sont perdues.
- Source : Section 2, R8 ; Section 9, zone d'ombre 3
- Impact : Le conformance check (R11) ne peut pas s'executer. Plus grave : le callback handler pour `prdwf_preflight_ok` ne peut pas acceder aux proto-specs pour les passer au pipeline. Le workflow continue sans proto-specs, potentiellement sans erreur visible (fail silencieux). Le deploy.yml fait un `pm2 restart` a chaque merge sur master — ce scenario est frequent, pas rare.
- Frequence estimee : occasionnel (chaque deploy pendant un preflight en cours)

**[MAJEUR] F-EC-2 — Preflight lance pour un PRD sans taches decomposees**

- Scenario : Le preflight est lance "apres la decomposition en taches" (R1). Mais la spec ne verifie pas explicitement que des taches existent. Si `decomposePRDIntoTasks` echoue partiellement (0 taches creees), le preflight tente de generer des proto-specs sur un tableau vide.
- Source : Section 2, R1 et R2 ; Section 3, donnees d'entree "Taches decomposees"
- Impact : `runPrdPreflightChecks` avec 0 taches : P1 genere 0 proto-specs, P2 recoit un AdversarialInput sans protoSpec ni taskTitle pertinent. Le preflight retourne un rapport vide avec verdict PASS, donnant un faux positif. L'utilisateur est encourage a lancer une implementation sans taches.
- Frequence estimee : rare (decomposeTask echoue mais le job ne fail pas totalement)

**[MAJEUR] F-EC-3 — Concurrence : deux preflights sur le meme chat/thread**

- Scenario : L'utilisateur approuve un PRD, la decomposition et le preflight se lancent en arriere-plan. Avant que le preflight finisse, l'utilisateur lance un second `/prd_workflow` sur le meme chat et approuve un second PRD. Les deux preflights ecrivent dans la meme cle `chatKey` de `pendingProtoSpecs`.
- Source : Section 7, contraintes — "Il n'y a pas de risque de collision si un seul preflight est en cours par chat/thread"
- Impact : Le second preflight ecrase les proto-specs du premier. Quand le premier callback `prdwf_preflight_ok` est clique, il recupere les proto-specs du second PRD et lance le conformance check avec les mauvais criteres.
- Frequence estimee : rare mais possible (utilisateur impulsif, deux PRD en parallele)

**[MAJEUR] F-EC-4 — Boutons de completion du job : PRDWF_PREFLIGHT pas gere dans sendJobCompletionNotification**

- Scenario : Le job `prd-preflight` se termine. `sendJobCompletionNotification` est appelee dans `job-manager.ts`. La fonction formate le message de notification. Mais le format du result tag `PRDWF_PREFLIGHT:{prdId}|{verdict}|{resume}` n'est pas reconnu dans le switch `job.type` de `getCompletionKeyboard` ni dans le formateur de message de `sendJobCompletionNotification`.
- Source : Section 5, fichier `src/job-manager.ts` ; Section 2, R14
- Impact : La spec dit d'ajouter le handling dans `buildJobResultButtons()` et `formatJobResult()` (section 5). Mais ces fonctions n'existent pas dans job-manager.ts — les fonctions reelles sont `getCompletionKeyboard()` et `sendJobCompletionNotification()`. Si l'implementeur suit les noms de la spec, il creera de nouvelles fonctions au lieu de modifier les existantes, causant du code mort ou des boutons manquants.
- Frequence estimee : systematique (la spec reference des fonctions qui n'existent pas)

**[MAJEUR] F-EC-5 — StoryFile vs StoryFileInput : type mismatch**

- Scenario : Le preflight appelle `buildStoryFile(task)` (retourne `StoryFile` avec `AcceptanceCriterion[]` objects) puis passe le resultat a `generateProtoSpec(task, storyFile)` qui attend `StoryFileInput` (avec `string[]`). L'appel `storyFile.acceptanceCriteria.join("; ")` dans `generateProtoSpec` produira `[object Object]; [object Object]` au lieu de texte lisible.
- Source : Section 5, dependances ; `src/spec-lite.ts` L.13-18 vs `src/story-files.ts` L.23-40
- Impact : Les proto-specs generees contiendront des criteres d'acceptation corrompus, rendant les V-criteres generes par le LLM de mauvaise qualite. Ce bug existe deja dans l'orchestrateur (L.702-706) mais la spec le propage sans le corriger.
- Frequence estimee : systematique

**[MINEUR] F-EC-6 — Result string tronquee a 500 caracteres dans job-manager**

- Scenario : Le job `prd-preflight` genere un result tag `PRDWF_PREFLIGHT:{prdId}|{verdict}|{resumeTexte}`. Si le resume est long, `job-manager.ts` tronque le result a 500 caracteres (L.152).
- Source : Section 4.4 ; `src/job-manager.ts` L.152
- Impact : Le resume pourrait etre tronque, rendant les boutons potentiellement inoperants si le prdId est coupe. Risque faible car le prdId est en debut de chaine, mais la troncation n'est pas documentee dans la spec.
- Frequence estimee : rare (le result tag devrait rester sous 500 chars)

**[MINEUR] F-EC-7 — Timeout Telegram sur answerCallbackQuery pour les nouveaux callbacks**

- Scenario : L'utilisateur clique sur `prdwf_preflight_ok`. Le handler doit appeler `ctx.answerCallbackQuery()` dans les 30 secondes. Si le handler effectue des operations (recuperation du PRD, lancement du job) avant de repondre, il pourrait depasser le timeout.
- Source : Section 7, limites techniques ; pattern existant dans planning.ts L.476
- Impact : L'utilisateur voit un spinner infini sur le bouton. Le lancement se fait quand meme mais l'UX est degradee.
- Frequence estimee : rare si le pattern existant (answerCallbackQuery en debut de handler) est respecte

### Statistiques
- Bloquants : 1
- Majeurs : 4
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — Granularite excessive des feature flags : 3 flags pour une seule fonctionnalite**

- Source : Section 2, R4-R6, R12
- Description : La spec introduit un flag `prd_maturation_phases` qui controle l'activation globale, mais reutilise les flags existants `spec_phase_lite` et `adversarial_challenge` pour le controle granulaire. Cela cree une matrice de 8 combinaisons possibles (2^3) dont seules 5 sont definies dans la spec. L'utilisateur doit comprendre l'interaction entre 3 flags pour configurer le preflight. Le V-critere V4 couvre le cas "deux sous-flags desactives" qui produit SKIPPED — un preflight qui ne fait rien mais qui s'execute quand meme.
- Alternative : Un seul flag `prd_maturation_phases` avec valeurs `off` / `lite` (P1 seulement) / `full` (P1+P2+E1) serait plus simple et eliminerait les combinaisons ambigues.
- Codebase : Les flags `spec_phase_lite` et `adversarial_challenge` sont actuellement `false` dans `config/features.json`. Ils sont conçus pour l'orchestrateur, pas pour le workflow PRD-to-Deploy. Les reutiliser couple le comportement des deux systemes de facon non evidente.

**[MAJEUR] F-SS-2 — Le conformance check (P3) post-implementation ajoute une complexite significative pour une valeur incertaine**

- Source : Section 2, R11 ; Section 4.3 ; Section 8, V16-V17 ; Section 9, zone d'ombre 3
- Description : Le conformance check requiert que les proto-specs survivent du preflight (avant implementation) jusqu'a la fin de la batch (apres implementation, potentiellement des heures plus tard). La spec stocke ca dans une Map en memoire avec TTL 10 minutes — ce qui est insuffisant (cf. F-DA-4). Pour que ca fonctionne, il faudrait persister dans Supabase. Cela ajoute 2 fonctions (`buildConformanceReport`, `formatConformanceReport`), 2 V-criteres (V16, V17), et la gestion du stockage. Le tout pour un score de conformance dans un message de fin que l'utilisateur lira a peine.
- Alternative : Reporter le conformance check en V2 (comme le suggere deja la zone d'ombre 3). Lancer le preflight (P1+P2+E1) apporte deja 90% de la valeur. P3 peut etre ajoute une fois le stockage Supabase en place.
- Codebase : L'orchestrateur utilise `checkConformance` dans son propre flux (L.1265) ou les proto-specs sont immediatement disponibles dans la meme execution. Le cas du PRD workflow est fondamentalement different (execution asynchrone, delai potentiel de heures).

**[MAJEUR] F-SS-3 — Le bouton prdwf_revise_prd duplique un flux existant sans valeur ajoutee claire**

- Source : Section 2, R10 ; Section 6, pattern 6.6 ; Section 8, V11
- Description : Le troisieme bouton `prdwf_revise_prd` "redirige vers le flow de revision PRD existant (pattern prdwf_revise:)". C'est un indirection : un bouton qui lance un autre bouton. L'utilisateur peut deja reviser son PRD via `/prd {id}` puis le bouton "Revision". Ajouter un troisieme bouton au preflight pour faire exactement la meme chose ajoute du code (callback handler, test V11) pour un raccourci que l'utilisateur peut faire en 2 clics.
- Alternative : Le rapport preflight avec verdict PAUSE pourrait simplement indiquer "Revise ton PRD avec /prd {id} puis relance le workflow" dans le texte, sans bouton supplementaire.

**[MINEUR] F-SS-4 — References a des fonctions inexistantes dans la spec**

- Source : Section 5 (fichiers concernes)
- Description : La spec reference `buildJobResultButtons()` et `formatJobResult()` dans `job-manager.ts`. Ces fonctions n'existent pas. Les fonctions reelles sont `getCompletionKeyboard()` et `sendJobCompletionNotification()`. La spec aurait du verifier les noms reels avant de les citer.
- Codebase : `src/job-manager.ts` — `getCompletionKeyboard()` (L.188), `sendJobCompletionNotification()` (L.243)

**[MINEUR] F-SS-5 — Sur-specification du format result tag**

- Source : Section 2, R14 ; Section 4.4
- Description : Le format `PRDWF_PREFLIGHT:{prdId}|{verdict}|{resume}` est specifie en detail avec un exemple. Mais le parsing de ce format dans `job-manager.ts` repose deja sur un pattern fragile (split par `|`, positions hardcodees). Ajouter un nouveau format pipe-separated augmente la dette technique sans apporter de structure (pas de schema, pas de validation).
- Alternative : Utiliser un JSON stringifie comme result au lieu d'un format pipe-separated ad hoc.

**[MINEUR] F-SS-6 — La spec ajoute 7 fichiers a modifier pour une fonctionnalite derriere un flag desactive par defaut**

- Source : Section 5 (fichiers concernes) ; Section 2, R12
- Description : Le flag `prd_maturation_phases` est `false` par defaut (R12). Les flags `spec_phase_lite` et `adversarial_challenge` sont aussi `false` dans le codebase actuel. Cela signifie que la fonctionnalite sera deployee mais inactive. L'effort d'implementation (7 fichiers, 20 V-criteres) est significatif pour une fonctionnalite dont l'activation n'est pas planifiee. La spec ne mentionne pas quand/comment le flag sera active.
- Alternative : Acceptable si le flag est active dans le sprint suivant, mais devrait etre documente.

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 3

---

## Recoupements entre agents

| Finding | Agents concordants | Severite retenue |
|---------|-------------------|-----------------|
| AdversarialInput non adapte pour un PRD global | F-DA-1, F-EC-5 (indirect) | BLOQUANT |
| Proto-specs perdues au redemarrage / TTL insuffisant pour P3 | F-DA-4, F-EC-1, F-SS-2 | BLOQUANT (F-EC-1) + MAJEUR (F-DA-4, F-SS-2) |
| Fonctions referencees inexistantes dans job-manager.ts | F-EC-4, F-SS-4 | MAJEUR |
| Complexite des 3 feature flags | F-SS-1 (seul) | MAJEUR |

---

## Points forts identifies

1. **Excellent respect des patterns existants** : la spec reutilise systematiquement les patterns du codebase (Map TTL, job tags, callback keyboards) au lieu d'inventer de nouveaux mecanismes.
2. **Retrocompatibilite stricte** : le flag `prd_maturation_phases: false` par defaut et la section 7 "Ce qu'il ne faut PAS casser" montrent une bonne conscience des risques de regression.
3. **V-criteres exhaustifs** : 20 V-criteres couvrant les cas nominaux, les flags granulaires, et la retrocompatibilite. La couverture est remarquable.
4. **Zones d'ombre documentees** : la section 9 identifie 3 zones d'ombre avec des decisions explicites et des pistes V2. C'est un bon signe de maturite.
5. **Architecture modulaire** : la spec ne modifie aucune dependance existante (`spec-lite.ts`, `adversarial-challenge.ts`, `adversarial-verifier.ts`), preferant les appeler en l'etat.

---

## Recommandations

### Pour passer a GO

1. **[BLOQUANT] Specifier l'adaptation de `AdversarialInput` pour un PRD global (F-DA-1)** :
   - Option A : Appeler `runAdversarialChallenge` une seule fois avec un `AdversarialInput` synthetique : `taskTitle = prd.title`, `taskDescription = prd.content`, `protoSpec = null`, `agentOutput = concatenation des N proto-specs`. Documenter cette adaptation dans la spec.
   - Option B : Ajouter un champ `protoSpecs: ProtoSpec[]` (pluriel) a `AdversarialInput` et modifier `adversarial-challenge.ts` pour supporter le cas multi-specs. Contredit la section 7 "pas de modification requise".
   - Recommandation : Option A (pas de modification de l'existant).

2. **[BLOQUANT] Gerer la perte de proto-specs au redemarrage (F-EC-1)** :
   - Option A : Persister les proto-specs dans Supabase (table `blackboard` ou nouvelle table). Overkill pour V1.
   - Option B : Stocker les proto-specs dans le fichier de persistence des sessions (`sessions.json`), qui survit aux restarts. Leger et coherent avec le pattern existant.
   - Option C : Reporter P3 (conformance check) en V2 et ne stocker les proto-specs que pour la duree du preflight (TTL 10min est suffisant pour le bouton de confirmation, pas pour P3).
   - Recommandation : Option C (simplification) ou Option B (robustesse minimale).

3. **[MAJEUR] Definir le mapping `AdversarialResult.verdict === "SKIPPED"` (F-DA-2)** :
   - Ajouter dans la section 4.1 : "Si adversarial.verdict === 'SKIPPED', le PreflightReport.verdict est 'PAUSE' (prudence : un agent qui echoue ne devrait pas valider le preflight)."

4. **[MAJEUR] Specifier la source de `impactedFiles` pour E1 quand P1 est off (F-DA-3)** :
   - Si `spec_phase_lite` est desactive, E1 peut utiliser les `impactedFiles` des story files des taches (disponibles via `buildStoryFile`).

5. **[MAJEUR] Corriger les noms de fonctions references (F-EC-4, F-SS-4)** :
   - Remplacer `buildJobResultButtons()` par `getCompletionKeyboard()` et `formatJobResult()` par `sendJobCompletionNotification()` dans la section 5.

6. **[MAJEUR] Simplifier les flags ou documenter la matrice (F-SS-1)** :
   - Au minimum, ajouter un tableau dans la spec montrant les 8 combinaisons de flags et le comportement attendu pour chacune.

---

## Etape suivante

Verdict **GO WITH CHANGES** : mettre a jour `docs/specs/SPEC-reviser-prd-to-deploy-workflow.md` selon les recommandations ci-dessus (6 corrections), puis lancer :

```
/dev-implement "Implementer SPEC-reviser-prd-to-deploy-workflow. Spec: docs/specs/SPEC-reviser-prd-to-deploy-workflow.md"
```
