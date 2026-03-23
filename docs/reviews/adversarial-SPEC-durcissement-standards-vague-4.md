# Adversarial Review — SPEC-durcissement-standards-vague-4 (Cycle 2)

> Spec source : `docs/specs/SPEC-durcissement-standards-vague-4.md`
> Date : 2026-03-23
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic
> Cycle : 2 (re-evaluation apres corrections des 3 BLOQUANTs et 9 MAJEURs du cycle 1)

---

## Tableau de synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|:---:|:---:|:---:|:---:|
| BLOQUANT | 1 | 0 | 0 | 1 |
| MAJEUR | 2 | 2 | 1 | 5 |
| MINEUR | 2 | 1 | 2 | 5 |
| **Total** | **5** | **3** | **3** | **11** |

---

## Verdict : GO WITH CHANGES

**Justification** : 1 BLOQUANT resolvable (classification.ts -> scoring.ts non autorise par R7) et 5 MAJEURs. Les corrections du cycle 1 ont resolu les 2 principaux BLOQUANTs (graphe de dependances corrige, cycle graph/agent-memory resolu via deplacement de AGENT_MEMORY_HARD_LIMIT). Cependant, la correction de R7 a introduit un nouveau BLOQUANT : R7 affirme que les modules specialises "ne dependent que de leurs propres types et de Supabase", mais `autoRemember` (classification.ts) appelle directement `resolveMemoryConflict` et `updateMemoryWithRevision` (scoring.ts), ce qui est prouve par le code source. Ce BLOQUANT est resolvable en ajoutant classification.ts -> scoring.ts dans le graphe R7.

---

## Evaluation des corrections du cycle 1

| Correction | BLOQUANT cycle 1 | Statut | Commentaire |
|------------|-------------------|--------|-------------|
| R7 corrige : graphe base sur les appels reels, core.ts et graph.ts sont des hubs | F-DA-1, F-DA-2 | Partiellement resolu | Le modele hub est correct mais la description des modules specialises est encore fausse (voir F-DA-1c2 ci-dessous) |
| AGENT_MEMORY_HARD_LIMIT deplace dans graph.ts | F-EC-1 (cycle graph/agent-memory) | Resolu | graph.ts importe depuis agent-memory.ts (getAgentMemories, saveAgentMemory, graduateAgentMemory) mais agent-memory.ts n'importe pas depuis graph.ts. Sens unique confirme |
| R13 corrige : perimetre complet | F-DA-3 | Resolu | R13 liste maintenant tous les fichiers : barrel, sous-modules, ADR, CLAUDE.md |
| R15 ajoute : placement fonctions privees | F-EC-3 | Partiellement resolu | R15 existe mais contient une erreur factuelle (voir F-DA-2c2) |
| archiveOldMemories dans core.ts | F-DA-4 | Resolu | Placement semantiquement coherent (RPC generique) |
| V3/V4 : diff des symboles | F-DA-5 | Resolu | Le V-critere ne repose plus sur un comptage hardcode |
| V8 : verification cycles basee sur hubs | F-EC-1 (V8) | Resolu | V8 verifie maintenant que les modules specialises n'importent pas depuis core.ts ni graph.ts |
| ADR minimal (R9) + conventions CLAUDE.md (R10, R11) | F-SS-3 | Resolu | Separation ADR (decision) / CLAUDE.md (conventions operationnelles) |
| Re-exports pipeline-selection retires de types.ts | F-DA-7 | Non resolu | R2 mentionne encore "re-exports pipeline-selection" dans types.ts (voir F-DA-3c2) |

---

## Devil's Advocate -- Rapport (Cycle 2)

### Findings

**[BLOQUANT] F-DA-1c2 -- R7 interdit les imports entre modules specialises, mais classification.ts doit importer depuis scoring.ts**

- Source : Regle R7 / Section 2 ; Regle R1 (placement de autoRemember dans classification.ts)
- Description : R7 corrige declare que "Les modules specialises (classification.ts, scoring.ts, ideas.ts, agent-memory.ts) n'importent PAS depuis core.ts ni graph.ts -- ils ne dependent que de leurs propres types et de Supabase." La formulation "leurs propres types et de Supabase" exclut les imports entre modules specialises eux-memes. Or `autoRemember` (classification.ts per R1) appelle directement `resolveMemoryConflict` (scoring.ts, ligne 508 de memory.ts) et `updateMemoryWithRevision` (scoring.ts, ligne 514). Cela cree une dependance classification.ts -> scoring.ts que R7 interdit.
- Impact : L'implementeur ne peut pas respecter R7 tel qu'ecrit sans modifier le placement de `autoRemember` ou des fonctions de scoring. Soit classification.ts importe depuis scoring.ts (violant R7), soit autoRemember est deplace dans core.ts (ce qui contredit R1), soit resolveMemoryConflict/updateMemoryWithRevision sont dupliques (inacceptable).
- Evidence : `src/memory.ts` lignes 506-522 : `autoRemember` (classification.ts) appelle `resolveMemoryConflict` (scoring.ts) et `updateMemoryWithRevision` (scoring.ts)
- Resolution suggeree : Modifier R7 pour autoriser les imports entre modules specialises du meme niveau (classification -> scoring OK, scoring -> classification interdit pour eviter les cycles). Reformuler : "Les modules specialises n'importent PAS depuis core.ts ni graph.ts. Les imports entre modules specialises sont autorises a condition d'etre unidirectionnels (classification -> scoring OK)."

**[MAJEUR] F-DA-2c2 -- R15 justifie le placement de autoCreateGoals/resolveMemoryType dans core.ts avec une evidence fausse**

- Source : Regle R15 / Section 2
- Description : R15 affirme que `autoCreateGoals` et `resolveMemoryType` doivent aller dans `core.ts` car "utilises par processMemoryIntents". Verification dans le code source : ces deux fonctions ne sont appelees QUE par `autoRemember` (classification.ts). `processMemoryIntents` ne les appelle pas. Si ces fonctions restent dans core.ts, cela cree une dependance classification.ts -> core.ts, aggravant le BLOQUANT F-DA-1c2. Si elles sont placees dans classification.ts (ou elles sont effectivement utilisees), R15 est faux mais R7 est moins viole.
- Impact : Le placement dans core.ts force classification.ts a importer depuis core.ts, ce que R7 interdit explicitement. Le placement dans classification.ts est correct (R15 dit "places dans le sous-module qui les utilise") mais contredit l'exemple donne.
- Evidence : `src/memory.ts` : `resolveMemoryType` appele a la ligne 486 (dans autoRemember), `autoCreateGoals` appele aux lignes 510, 520, 564 (dans autoRemember). Aucun appel depuis processMemoryIntents (lignes 216-300)

**[MAJEUR] F-DA-3c2 -- R2 mentionne encore "re-exports pipeline-selection" dans types.ts malgre la correction F-DA-7**

- Source : Regle R2 / Section 2
- Description : Le cycle 1 avait identifie F-DA-7 (re-export de pipeline-selection dans types.ts comme anti-pattern). L'utilisateur indique que la correction F-DA-7 a retire ces re-exports de types.ts. Or R2 contient encore : "types.ts (AgentRole, AgentStepResult, OrchestratedResult, OrchestrateOptions, AGENT_COMMAND_MAP, re-exports pipeline-selection)". La correction n'a pas ete appliquee dans le texte de R2.
- Impact : Contradiction entre la correction annoncee et le texte de la spec. L'implementeur ne saura pas si types.ts doit ou non re-exporter pipeline-selection. Le barrel orchestrator.ts devra de toute facon re-exporter pipeline-selection (il le fait deja), mais types.ts ne devrait contenir que des declarations.
- Evidence : R2 texte actuel : "types.ts (..., re-exports pipeline-selection)"

**[MINEUR] F-DA-4c2 -- R7 liste des dependances incompletes pour graph.ts**

- Source : Regle R7 / Section 2
- Description : R7 liste les dependances de graph.ts : "scoring.ts (bumpMemoryAccess, resolveMemoryConflict)" et "agent-memory.ts (getAgentMemories)". Verification codebase : graph.ts a besoin de 3 fonctions supplementaires non listees : `updateMemoryWithRevision` (scoring.ts, via promoteWorkingMemory ligne 945), `PROMOTION_MAX_CHARS` (scoring.ts, via promoteWorkingMemory ligne 938), et `saveAgentMemory` + `graduateAgentMemory` (agent-memory.ts, via promoteWorkingMemory lignes 976, 982).
- Impact : Faible -- la direction des dependances est correcte (graph -> scoring, graph -> agent-memory). Mais le listing incomplet pourrait induire l'implementeur en erreur sur les imports necessaires.
- Evidence : `src/memory.ts` lignes 938-982 dans `promoteWorkingMemory` (graph.ts)

**[MINEUR] F-DA-5c2 -- Les delimiteurs de section sont "// ── " (unicode) et non "// -- " comme indique par la spec**

- Source : Section 6.2 (Patterns existants), R1 justification "13 sections delimitees par // -- "
- Description : La spec reference des delimiteurs `// -- ` (tirets ASCII) alors que le code source utilise `// ── ` (caractere unicode box drawing U+2500). De plus, memory.ts contient 15 delimiteurs et non 13, et orchestrator.ts contient 10 delimiteurs et non 6.
- Impact : Mineur, la spec utilise ces chiffres uniquement comme justification du decoupage, pas comme V-critere. Mais les chiffres sont factuellement faux.
- Evidence : `grep -c "// ── " src/memory.ts` = 15, `grep -c "// ── " src/orchestrator.ts` = 10

---

## Edge Case Hunter -- Rapport (Cycle 2)

### Findings

**[MAJEUR] F-EC-1c2 -- V8 ne detecte pas la dependance classification.ts -> scoring.ts**

- Scenario : L'implementeur place `autoRemember` dans classification.ts (R1), importe `resolveMemoryConflict` depuis scoring.ts. V8 ne verifie que les imports depuis core.ts et graph.ts. Il ne verifie pas les imports entre modules specialises. Le cycle classification -> scoring -> classification (si scoring importait un jour de classification) ne serait pas detecte par V8.
- Source : V-critere V8 / Section 8
- Impact : Un cycle transitif entre modules specialises ne serait pas detecte par la suite de validation. Le V8 actuel est trop restrictif sur ce qu'il verifie (core, graph) et ignore les dependances inter-specialises.
- Frequence estimee : Certain pour la dependance classification -> scoring, faible pour un cycle reel (scoring n'a pas de raison d'importer depuis classification)

**[MAJEUR] F-EC-2c2 -- MemorySearchResult (interface privee) utilisee par classification.ts ET scoring.ts**

- Scenario : `MemorySearchResult` est une interface privee (non exportee) definie a la ligne 62 de memory.ts. Elle est utilisee par `findDuplicateIdea` (classification.ts, ligne 610), `findSimilarFact` (scoring.ts, ligne 773), et `findContradiction` (scoring.ts, ligne 1017). R15 dit de placer les types prives partages dans core.ts. Si classification.ts et scoring.ts doivent importer ce type depuis core.ts, cela viole R7 (modules specialises n'importent pas depuis core.ts). Si on le duplique, c'est une violation DRY.
- Source : R7, R15 ; `src/memory.ts` lignes 62-68, 610, 773, 1017
- Impact : L'implementeur devra choisir entre violer R7 (importer un type depuis core.ts), dupliquer le type (mauvaise pratique), ou l'exporter via le barrel (surexpose un type interne). Aucune option n'est satisfaisante sans modifier R7.
- Frequence estimee : Certain -- c'est une consequence directe de la repartition des fonctions

**[MINEUR] F-EC-3c2 -- consumer count du spec inexact pour memory.ts**

- Scenario : La spec (section 3) declare "9 fichiers src + 3 commands + 12 tests" importent depuis memory.ts. Verification : 6 fichiers src (bot-context, heartbeat, orchestrator, exploration-scoring, agent-context, llm-router) + 2 commands (zz-messages, utilities) + 1 command (memory-cmds) + 5 fichiers tests. Le compte est inexact.
- Source : Section 3 / Donnees d'entree
- Impact : Faible. Les V-criteres de non-regression (V5, V6) ne dependent pas de ce comptage. Mais l'inexactitude reduit la fiabilite de la section d'inventaire.
- Frequence estimee : Non applicable (erreur factuelle)

---

## Simplicity Skeptic -- Rapport (Cycle 2)

### Findings

**[MAJEUR] F-SS-1c2 -- La complexite du graphe de dependances R7 est auto-infligee par le decoupage en 6 modules**

- Source : Regles R1, R7 / Section 2
- Description : Les corrections du cycle 1 ont rendu R7 plus precis mais aussi plus complexe : core.ts et graph.ts sont des "hubs" qui importent depuis 3-4 modules specialises, avec des dependances inter-specialises non resolues (classification -> scoring). Un decoupage en 4 modules (core, operations = classification+scoring, graph, agent-memory) eliminerait le probleme classification -> scoring (elles seraient dans le meme fichier) et simplifierait le graphe a : core -> operations, core -> graph, graph -> operations, graph -> agent-memory. Soit 4 dependances au lieu de ~10.
- Alternative : Fusionner classification.ts et scoring.ts en `operations.ts` (~650 LOC, sous le seuil de 800). Cela resout F-DA-1c2 et F-EC-2c2 sans modifier R7.
- Codebase : Le codebase existant ne fait jamais de decoupages a 6 fichiers pour un domaine. Les `commands/` sont 13 fichiers mais pour 13 fonctionnalites independantes (pas un graphe de dependances).

**[MINEUR] F-SS-2c2 -- La spec sur-specifie les dependances au lieu de definir un principe simple**

- Source : Regle R7 / Section 2
- Description : R7 enumere chaque dependance individuelle (graph -> classification.classifyLinkContent, graph -> scoring.bumpMemoryAccess, etc.). Cette enumeration est fragile : tout ajout de fonctionnalite necessiterait une mise a jour de la spec. Un principe simple ("les dependances entre sous-modules memory sont autorisees a condition d'etre acycliques, avec core.ts et graph.ts comme seuls hubs autorises") serait plus robuste et couvrirait les evolutions futures.
- Alternative : Remplacer l'enumeration par un principe + un diagramme de direction

**[MINEUR] F-SS-3c2 -- Section 6.2 cite un pattern de delimiteur inexistant**

- Source : Section 6.2 / Patterns existants
- Description : La section 6.2 affirme que memory.ts est "organise en 13 sections clairement delimitees par des commentaires `// -- Nom Section --`". Le delimiteur reel est `// ── ` (unicode box drawing) et il y en a 15, pas 13. Cet ecart documentaire mineur suggere que l'analyse automatique des sections n'a pas ete verifiee manuellement.
- Codebase : `grep -c "// ── " src/memory.ts` = 15

---

## Findings partages (credites a plusieurs agents)

| Finding | Agents | Severite |
|---------|--------|----------|
| classification.ts -> scoring.ts non autorise par R7 | F-DA-1c2, F-EC-1c2, F-SS-1c2 | BLOQUANT |
| Types prives partages (MemorySearchResult) entre modules specialises | F-EC-2c2, F-DA-1c2 | MAJEUR |
| R15 justification factuelle incorrecte | F-DA-2c2 | MAJEUR |

---

## Recommandations (actions pour passer a GO)

1. **[Critique] Modifier R7 pour autoriser classification.ts -> scoring.ts** : reformuler la phrase "ils ne dependent que de leurs propres types et de Supabase" en "ils ne dependent pas de core.ts ni graph.ts, mais les imports unidirectionnels entre modules specialises sont autorises (classification -> scoring)". Cela resout F-DA-1c2 et F-EC-1c2.

2. **[Important] Corriger R15** : retirer l'exemple "autoCreateGoals, resolveMemoryType dans core.ts (utilises par processMemoryIntents)" qui est faux. Ces fonctions sont utilisees uniquement par `autoRemember` (classification.ts) et doivent rester dans classification.ts selon la regle R15 elle-meme ("places dans le sous-module qui les utilise").

3. **[Important] Retirer "re-exports pipeline-selection" de R2** : la correction F-DA-7 du cycle 1 n'a pas ete appliquee dans le texte de R2. types.ts ne doit contenir que des types, interfaces et constantes. Les re-exports pipeline-selection restent dans le barrel orchestrator.ts.

4. **[Important] Clarifier le partage de MemorySearchResult** : ajouter dans R15 que les types prives partages entre modules specialises (comme MemorySearchResult) peuvent etre exportes par le sous-module qui les definit originellement et importes par les autres, sans passer par core.ts.

5. **[Souhaitable] Completer la liste des imports graph.ts** dans R7 : ajouter `updateMemoryWithRevision`, `PROMOTION_MAX_CHARS` (scoring.ts), `saveAgentMemory`, `graduateAgentMemory` (agent-memory.ts).

6. **[Souhaitable] Corriger les chiffres Section 6.2** : 15 delimiteurs (pas 13), caractere unicode `// ── ` (pas `// -- `).

---

## Points forts identifies

- **Corrections du cycle 1 globalement efficaces** : les 2 BLOQUANTs principaux (graphe de dependances, cycle graph/agent-memory) sont resolus. Le modele hub (core.ts, graph.ts) avec modules specialises est architecturalement sain
- **AGENT_MEMORY_HARD_LIMIT dans graph.ts** : resolution elegante du cycle, la constante est au plus pres de son consommateur principal (buildMemoryChains)
- **archiveOldMemories dans core.ts** : correction semantiquement justifiee
- **V3/V4 avec diff des symboles** : le V-critere ne repose plus sur un comptage hardcode, ce qui le rend robuste
- **V8 oriente hubs** : la verification cible correctement les hubs (core.ts, graph.ts) comme seuls modules autorises a avoir des dependances entrantes depuis les modules specialises
- **ADR minimal + conventions CLAUDE.md** : separation propre entre decision architecturale (ADR) et regles operationnelles (CLAUDE.md)
- **Non-regression barrel** : l'approche barrel avec zero modification des consommateurs reste la force principale de cette spec

---

## Etape suivante

Verdict **GO WITH CHANGES** : le BLOQUANT restant est resolvable par une modification textuelle de R7 (autoriser classification -> scoring). Les 5 MAJEURs sont des corrections de texte (R15, R2) et de precision (MemorySearchResult, import list). Aucun ne remet en cause l'architecture.

Corrections minimales requises :
1. R7 : autoriser imports unidirectionnels entre modules specialises (classification -> scoring)
2. R15 : corriger l'exemple autoCreateGoals/resolveMemoryType (classification.ts, pas core.ts)
3. R2 : retirer "re-exports pipeline-selection" de types.ts

Apres correction, lancer :
```
/dev-implement "Implementer SPEC-durcissement-standards-vague-4. Spec: docs/specs/SPEC-durcissement-standards-vague-4.md"
```
