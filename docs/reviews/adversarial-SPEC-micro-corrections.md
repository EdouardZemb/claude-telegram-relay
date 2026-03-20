# Adversarial Review — SPEC-micro-corrections

> Genere le 2026-03-20. Spec source : `docs/specs/SPEC-micro-corrections.md`

## Synthese

| Agent | Bloquants | Majeurs | Mineurs | Total |
|-------|-----------|---------|---------|-------|
| Devil's Advocate | 0 | 1 | 2 | 3 |
| Edge Case Hunter | 0 | 0 | 3 | 3 |
| Simplicity Skeptic | 0 | 0 | 2 | 2 |
| **Total** | **0** | **1** | **7** | **8** |
| **Dedupliques** | **0** | **1** | **6** | **7** |

### Verdict : GO

**Justification** : 0 BLOQUANT, 1 MAJEUR (hypothese sur la variable `timestamp` non verifiee dans tous les chemins d'appel, mais confirmee par inspection — resolvable sans impact). 6 MINEURS dedupliques, tous informatifs. La spec est precise, factuelle, et bien cadree pour des micro-corrections. Le scope est minimal et les risques sont negligeables.

---

## Devil's Advocate — Rapport

### Findings

**[MAJEUR] F-DA-1 — Hypothese implicite sur la disponibilite de `timestamp` dans le scope de la ligne 562**
- Source : Section 4.1, Section 7 contrainte "Variable `timestamp`"
- Description : La spec affirme que "La variable `timestamp` est deja disponible dans le scope (definie en haut de la fonction `runHeartbeat()`)". Verification : `timestamp` est defini a la ligne 356 (`const timestamp = new Date().toISOString();`), et la ligne 562 est dans un bloc `try` a l'interieur de `runHeartbeat()`. Le scope est confirme comme valide. Cependant, la spec ne mentionne pas que si `runHeartbeat()` etait un jour refactorisee (extraction de la section autonomy scan dans une fonction separee), `timestamp` ne serait plus disponible. L'hypothese est correcte aujourd'hui mais fragile.
- Impact : Risque faible. Si la fonction est refactorisee plus tard, le compilateur TypeScript detectera l'erreur (`timestamp` non defini), donc pas de silent failure possible. Neanmoins, une alternative plus robuste serait `new Date().toISOString()` directement dans le message d'erreur.
- Evidence : Ligne 356 de heartbeat.ts : `const timestamp = new Date().toISOString();` — ligne 562 est bien dans le meme scope de fonction.

**[MINEUR] F-DA-2 — La spec reference "ligne 562" mais les numeros de ligne sont volatils**
- Source : Section 3, Section 4.1, Section 5
- Description : La spec utilise des numeros de ligne absolus (562, 3, 56, 175, 176, 182, 214) comme references. Ces numeros changent a chaque modification des fichiers concernes. Si une autre PR est mergee entre la redaction de la spec et son implementation, les numeros seront decales. La spec devrait plutot utiliser des patterns de code comme reference (ex: `await supabase.from("tasks").update({ notes: opp.dedup_key })`).
- Impact : Risque de confusion lors de l'implementation si les lignes ont bouge. Mineur car le pattern de code est egalement fourni dans la section 4.1.

**[MINEUR] F-DA-3 — Les numeros de lignes CLAUDE.md dans la spec ne correspondent pas a l'etat actuel**
- Source : Section 3, Section 4.3
- Description : La spec indique que les corrections CLAUDE.md concernent les lignes 56, 175, 176, 182, 214. Verification de l'etat actuel : la ligne 56 contient bien `code-review.ts | Adversarial code review before merge, worktree isolation`, la ligne 175 contient `src/                    56 TypeScript modules`, la ligne 176 contient `commands/             11 Composer modules`, la ligne 182 contient `tests/                  2720 tests`, la ligne 214 contient `Tests: \`bun test\` (2720 tests`. Les numeros sont corrects a ce jour, mais la meme fragilite que F-DA-2 s'applique — un merge intermediaire pourrait les decaler.
- Impact : Mineur. Les patterns textuels sont fournis dans le tableau section 4.3, ce qui permet une implementation fiable independamment des numeros de ligne.

### Statistiques
- Bloquants : 0
- Majeurs : 1
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[MINEUR] F-EC-1 — Que se passe-t-il si `task` est cree mais `task.id` est undefined ?**
- Scenario : Ligne 561 verifie `if (task)` mais ne verifie pas `task.id`. Si `addTask()` retourne un objet truthy mais sans `id` (ex: erreur partielle de Supabase), le `.update()` echouerait silencieusement. Avec la correction proposee, l'erreur serait loggee — ce qui est une amelioration. Mais la spec ne mentionne pas ce cas.
- Source : Section 4.1 ; ligne 561-562 de heartbeat.ts
- Impact : La correction proposee ameliore justement ce scenario : l'erreur Supabase `.eq("id", undefined)` serait desormais loggee au lieu d'etre silencieuse. C'est un benefice non documente de la correction.
- Frequence estimee : Tres rare (Supabase retourne normalement l'objet complet ou null).

**[MINEUR] F-EC-2 — Race condition theorique entre creation et update de la tache**
- Scenario : Lignes 555-562 : `addTask()` cree la tache puis `.update()` met a jour ses notes. Si le processus est interrompu entre les deux operations (crash, kill signal PM2), la tache existe sans `dedup_key` dans `notes`. Au prochain heartbeat, `isDuplicate()` ne la trouvera pas (car elle cherche dans `notes`), et une tache dupliquee sera creee.
- Source : Section 4.1 ; lignes 555-565 de heartbeat.ts
- Impact : Duplication de tache en cas d'interruption entre creation et update. La correction proposee (ajout du logging d'erreur) ne resout pas ce cas, mais ce n'est pas dans le scope de cette spec (correctement delimite aux micro-corrections).
- Frequence estimee : Extremement rare (requiert un kill au moment exact entre les deux appels Supabase).

**[MINEUR] F-EC-3 — Suppression du flag `explore_mode` : impact si du code est ajoute plus tard avec ce flag**
- Scenario : Un developpeur futur pourrait ajouter `isFeatureEnabled("explore_mode")` dans le code en s'attendant a ce que le flag existe dans features.json. `isFeatureEnabled()` retourne `false` par defaut (confirme dans feature-flags.ts L31-33), donc le comportement serait coherent mais potentiellement surprenant.
- Source : Section 4.2 ; Section 7 contrainte "Pas de regression fonctionnelle"
- Impact : Aucun impact fonctionnel. Le flag retournerait `false` par defaut, ce qui est le comportement attendu pour un flag absent. Si un developpeur veut reactiver la feature, il peut simplement re-ajouter la cle dans features.json.
- Frequence estimee : Improbable (le flag n'a jamais ete reference dans src/).

### Statistiques
- Bloquants : 0
- Majeurs : 0
- Mineurs : 3

---

## Simplicity Skeptic — Rapport

### Findings

**[MINEUR] F-SS-1 — La spec est plus longue que les corrections qu'elle decrit**
- Source : Spec entiere (143 lignes) vs corrections effectives (~10 lignes de diff)
- Description : La spec de 9 sections et 143 lignes decrit 3 corrections totalisant environ 10 lignes de diff reel (2 lignes ajoutees dans heartbeat.ts, 1 ligne supprimee dans features.json, 5 lignes modifiees dans CLAUDE.md). Le ratio documentation/code est d'environ 14:1. Cela dit, le format 9 sections est impose par le pipeline dev et la spec sert aussi de trace d'audit pour les corrections post-roadmap — c'est donc un choix de processus, pas de sur-ingenierie.
- Alternative : Pour des corrections aussi triviales, un format simplifie (3 sections : objectif, corrections, validation) serait suffisant. Mais le pipeline impose le format standard.
- Codebase : Les specs precedentes (SPEC-simplification-bot.md) ont un ratio documentation/code plus equilibre car elles decrivent des changements plus complexes.

**[MINEUR] F-SS-2 — 8 V-criteres pour 3 corrections : sur-specification des validations**
- Source : Section 8
- Description : 8 criteres de validation pour 3 corrections simples (V1-V8). Les criteres V4, V5, V6, V7 sont tous des greps sur CLAUDE.md qui pourraient etre condenses en un seul critere "les 5 valeurs CLAUDE.md sont a jour". V8 (2690 tests passent) est un critere de non-regression standard qui s'applique a toute modification. Net : 3-4 criteres suffiraient (1 par correction + 1 non-regression).
- Alternative : Condenser en 4 V-criteres : V1 (heartbeat error handling), V2 (flag supprime + JSON valide), V3 (CLAUDE.md a jour), V4 (non-regression tests).
- Codebase : Le format 8 V-criteres est coherent avec les autres specs du projet (SPEC-simplification-bot a 21 V-criteres), donc c'est un choix de convention acceptable.

### Statistiques
- Bloquants : 0
- Majeurs : 0
- Mineurs : 2

---

## Deduplication

| Finding | Agents | Severite finale |
|---------|--------|-----------------|
| F-DA-1 (timestamp scope) | DA seul | MAJEUR |
| F-DA-2 (numeros de ligne volatils) | DA + DA-3 (merge) | MINEUR |
| F-EC-1 (task.id undefined) | EC seul | MINEUR |
| F-EC-2 (race condition creation/update) | EC seul | MINEUR |
| F-EC-3 (flag supprime, usage futur) | EC seul | MINEUR |
| F-SS-1 (ratio doc/code) | SS seul | MINEUR |
| F-SS-2 (sur-specification V-criteres) | SS seul | MINEUR |

F-DA-2 et F-DA-3 fusionnes (meme problematique : numeros de ligne volatils).

---

## Points forts identifies

1. **Scope parfaitement delimite** : 3 corrections factuelles, pas de scope creep, pas de refactoring opportuniste. Chaque correction est justifiee par une regle metier precise (R1-R4).
2. **Patterns existants reutilises** : La section 6 documente les patterns de destructuration Supabase et de suppression de flags deja utilises dans le projet. Pas d'invention de nouveaux patterns.
3. **Criteres de validation verifiables** : Chaque V-critere est accompagne d'une commande ou methode de verification concrete. Pas de critere subjectif.
4. **Section 9 (coverage) honnete** : La spec indique clairement que UX et Alternatives sont "non applicables" au lieu d'inventer du contenu artificiel.
5. **Risque zero de regression** : Les corrections sont isolees (error logging, flag mort, documentation) et ne touchent aucun chemin fonctionnel existant.

---

## Recommandations

1. **F-DA-1** (MAJEUR) : Considerer l'utilisation de `new Date().toISOString()` directement dans le log d'erreur au lieu de `timestamp`, pour une independance totale vis-a-vis du scope. Alternativement, documenter dans un commentaire que `timestamp` vient du scope parent de `runHeartbeat()`. Impact : negligeable, la correction actuelle est correcte et le compilateur protege contre une regression future.
2. **F-DA-2/F-DA-3** (MINEUR fusionne) : Lors de l'implementation, se fier aux patterns textuels (colonne "Avant" du tableau section 4.3) plutot qu'aux numeros de ligne absolus. La spec fournit deja les deux, donc aucune modification necessaire.
3. **F-EC-2** (MINEUR) : La race condition creation/update est un pre-existant hors scope. Pas d'action requise dans cette spec, mais pourrait etre note comme dette technique mineure pour un futur audit.

---

## Etape suivante

Verdict **GO** — la spec peut etre implementee directement.

Commande : `/dev-implement "Implementer SPEC-micro-corrections. Spec: docs/specs/SPEC-micro-corrections.md"`
