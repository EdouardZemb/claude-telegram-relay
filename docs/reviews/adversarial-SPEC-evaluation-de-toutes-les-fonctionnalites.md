# Challenge Adversarial — SPEC-evaluation-de-toutes-les-fonctionnalites.md

Verdict global: GO_WITH_CHANGES
Agents: 3/3 reussis

---

## Devil's Advocate — Rapport

Analyse terminée. Voici le rapport :

---

## Devil's Advocate — Rapport

### Findings

---

**[BLOQUANT] F-DA-1 — Extraction R8 : 9 dépendances non documentées**
- Source : Section 2 R8, Section 5 `command-router.ts`, Section 6 P3/P4
- Description : La spec liste 5 fonctions à extraire (`routeIntent`, `buildClarificationQuestion`, `checkPendingClarification`, `handleConfirmationCallback`, `buildSyntheticUpdate`), mais ces fonctions dépendent de 9 artefacts non listés qui résident dans `zz-messages.ts` : `pendingClarifications` (Map l.140), `pendingConfirmations` (Map l.139), `CLARIFICATION_TTL_MS` (l.142), `CONFIRMATION_TTL_MS` (l.141), `confirmationKey()` (l.144), `resolveTaskId()` (l.150), `resolveSprintId()` (l.178), `actionVerb()` (l.208), `_syntheticUpdateCounter` (l.309).
- Impact : Extraire uniquement les 5 fonctions produit un fichier qui ne compile pas (références non résolues). Un implémenteur suivant la spec à la lettre échoue à la première compilation. De plus, les Maps partagées (`pendingClarifications`, `pendingConfirmations`) portent de l'**état mutable** — si elles restent dans `zz-messages.ts`, les callbacks Composer (lignes 346, 400) perdent la cohérence d'état. Si elles migrent vers `command-router.ts`, `zz-messages.ts` doit les importer (sens correct), mais la spec ne le documente pas.
- Evidence : `routeIntent` l.244 : `pendingClarifications.set(key, ...)` ; `checkPendingClarification` l.277 : `const pending = pendingClarifications.get(key)` ; `buildClarificationQuestion` l.192 : appel `actionVerb(action.command)` — aucun de ces symboles n'est dans la liste d'extraction.

---

**[MAJEUR] F-DA-2 — R4 tasks.ts : 4 violations process.env, spec en liste 3**
- Source : Section 2 R4, Section 3 (table), Section 5 (table), Section 4 output example
- Description : R4 cite "lignes 249, 254, 314" et Section 3 dit "Lignes 249, 254, 314". Grep réel : 4 occurrences — ligne 309 (`process.env.SPRINT_THREAD_ID`) manquante dans toute la spec. Les lignes 249 et 309 sont deux codepaths distincts appelant la même variable.
- Impact : Un implémenteur qui suit les numéros de ligne migrate 3 occurrences, oublie la ligne 309. `commands/tasks.ts` reste dans les violations S2. V4 échoue, CI bloqué. La validation V4 ("test S2 passe") est correcte mais la description R4 est factuellement fausse.
- Evidence : `grep -n "process\.env" src/commands/tasks.ts` → lignes 249, 254, **309**, 314.

---

**[MAJEUR] F-DA-3 — C3 coverage 30% : aucun plan de test pour command-router.ts**
- Source : Section 7 C3, Section 9 "Zone d'ombre"
- Description : C3 exige 30% de couverture sur `command-router.ts` via tests unitaires, mais la spec ne spécifie pas quels tests créer, quels mocks utiliser, ni la structure de test. Les fonctions extraites dépendent de Maps d'état partagées (`pendingClarifications`, `pendingConfirmations`) et de callbacks grammy (Context) — deux sources de complexité de mock non documentées.
- Impact : L'implémenteur doit concevoir l'approche de test ex-nihilo. Si les mocks grammy sont trop complexes, le fallback "ajout à la coverage allowlist" (mentionné en C3) peut être utilisé, mais il consommerait une entrée de l'ALLOWLIST S2 supplémentaire, potentiellement problématique selon le nombre de tests créés. La zone d'ombre de la spec ("peut nécessiter un pattern de test spécifique") reconnaît le problème sans le résoudre.

---

**[MINEUR] F-DA-4 — LOC zz-messages.ts : "938 comptage test" vs ~905 réel**
- Source : Section 4 "zz-messages.ts taille réduite"
- Description : La spec affirme "Avant : 938 LOC (comptage test) / 904 LOC (wc -l)". `split("\n").length` d'un fichier de 904 lignes donne ~905. La LOC_ALLOWLIST contient `938` mais le fichier réel est à ~905. La cible "extraire ~150 LOC → ~770-790" reste atteignable (905 - 150 = ~755 < 800), mais les chiffres de départ sont faux.
- Impact : Faible — le test staleness vérifie `> 800` (pas `== 938`), donc la LOC_ALLOWLIST est stale mais non bloquante. L'estimation de réduction LOC reste valide.

---

**[MINEUR] F-DA-5 — C9 pseudo-contrainte : userTimezone existe déjà**
- Source : Section 7 C9, Section 6 P2
- Description : C9 dit "Avant de migrer commands/tasks.ts, vérifier si `userTimezone` est dans AppConfig. Si absent → fallback littéral Europe/Paris". `userTimezone` est confirmé dans `config.ts` ligne 136 (`userTimezone: optionalResult.USER_TIMEZONE`). Le chemin "si absent" n'existera jamais, la contrainte C9 est une fausse vérification.
- Impact : Faible — ne bloque pas l'implémentation, mais alerte inutilement l'implémenteur sur un cas qui n'existe pas.

---

**[MINEUR] F-DA-6 — documents.ts : 2ème usage process.env non documenté**
- Source : Section 2 R5, Section 3 (table), Section 4 output example
- Description : La spec couvre uniquement la ligne 83 (`process.env.CLAUDE_PATH`). La ligne 103 contient `Object.entries(process.env).filter(...)`. Ce second usage n'est pas dans la spec. Il n'est pas capturé par S2 (le pattern `/\bprocess\.env\./` exige un `.X` après `env`) mais crée une asymétrie documentaire.
- Impact : Faible — pas de CI failure, mais source de confusion si l'implémenteur inspecte le fichier et voit un `process.env` non migré.

---

**[MINEUR] F-DA-7 — Ordre R6→R7 présenté comme strict mais pas techniquement obligatoire**
- Source : Section 7 C1
- Description : C1 impose "Ordre obligatoire : supprimer entrées mortes (R6) AVANT de migrer (R7)". Justification : éviter de dépasser le cap S9. Or cap = 20, actuel = 18 ALLOWLIST + 2 EXCLUDED = 20. Si on supprime 3 fichiers (migrations R7) avant de nettoyer (R6), on passe à 15 + 2 = 17 ≤ 20. La contrainte d'ordre ne protège pas d'une violation de cap — elle est présentée comme bloquante alors qu'elle est juste recommandée (bonne pratique, pas contrainte technique).

---

### Statistiques
- Bloquants : 1
- Majeurs : 2
- Mineurs : 4

---

## Verdict de l'agent: GO_WITH_CHANGES

**Justification** : Le F-DA-1 (dépendances non documentées de l'extraction) est bloquant pour l'implémentation telle que décrite — l'implémenteur doit explicitement lister les 9 dépendances supplémentaires à déplacer (Maps, TTL, helpers) avant d'ouvrir un éditeur. Le F-DA-2 (ligne 309 manquante dans R4) est un CI-blocker si les numéros de ligne sont suivis à la lettre. Ces deux points nécessitent des corrections dans la spec avant implémentation, mais l'architecture globale de la spec (Option B, cibles de réduction, validation criteria) est solide.

---

## Edge Case Hunter — Rapport

---

## Edge Case Hunter — Rapport

### Findings

---

**[BLOQUANT] F-EC-1 — Module-level state non listé pour extraction**

- **Scenario :** Les 5 fonctions candidates à l'extraction (`routeIntent`, `checkPendingClarification`, `handleConfirmationCallback`, `buildSyntheticUpdate`, `buildClarificationQuestion`) utilisent toutes des variables de module : `pendingClarifications` (Map, l.140), `pendingConfirmations` (Map, l.139), `_syntheticUpdateCounter` (l.309), `CONFIRMATION_TTL_MS`/`CLARIFICATION_TTL_MS` (l.141-142). La spec ne mentionne **aucune** de ces variables pour l'extraction vers `command-router.ts`.
- **Source :** R8, Section 4 (sortie zz-messages), Section 5 (fichiers concernés) — aucune mention de ce state
- **Impact :** Deux issues mutuellement exclusives : (a) si le state reste dans `zz-messages.ts`, les fonctions extraites ne peuvent plus y accéder → code cassé ; (b) si `command-router.ts` importe ces variables depuis `zz-messages.ts` → cycle S7 ou violation C4 "dépendances unidirectionnelles". Les deux options bloquent CI.
- **Fréquence estimée :** Certain (toute tentative d'implémentation conforme à la spec aboutit à ce problème)

---

**[BLOQUANT] F-EC-2 — Fonctions helper et interfaces non listées pour extraction mais requises**

- **Scenario :** `routeIntent` appelle `resolveTaskId` (l.236) et `resolveSprintId` (l.239) ; `buildClarificationQuestion` appelle `actionVerb` (l.192) ; toutes utilisent `confirmationKey` (l.144). Ces 4 helpers + les interfaces `RouterContext`/`RouteResult`/`PendingConfirmation`/`PendingClarification` (l.115-137) doivent impérativement migrer dans `command-router.ts`. Or la spec ne les cite nulle part dans R8, Section 4 ni Section 5.
- **Source :** R8 ("extraire `routeIntent`, `buildClarificationQuestion`..."), C4 ("dépendances unidirectionnelles")
- **Impact :** Si ces helpers restent dans `zz-messages.ts`, `command-router.ts` doit les importer de `zz-messages.ts`, violant C4. Si dupliqués, violation DRY + désynchronisation. La contrainte C4 est architecturalement incompatible avec la liste d'extraction incomplète.
- **Fréquence estimée :** Certain

---

**[MAJEUR] F-EC-3 — Quatrième occurrence `process.env` non listée dans `tasks.ts`**

- **Scenario :** La spec (R4, Section 3, V4) mentionne "lignes 249, 254, 314" pour `tasks.ts`. Or la lecture du fichier révèle une 4ème occurrence : `line 309` — `const sprintThread = parseInt(process.env.SPRINT_THREAD_ID || "0", 10)` dans le handler `/start` (distinct du handler `/done` l.249). Si cette ligne n'est pas migrée, `grep -n "process\.env" src/commands/tasks.ts` retourne 1 match, le test S2 échoue, et V4 ne passe pas.
- **Source :** R4 ("Lignes 249, 254, 314"), V4 ("commands/tasks.ts has no direct process.env usage")
- **Impact :** `commands/tasks.ts` ne peut pas être retiré de l'ALLOWLIST S2, le décompte 18→12 devient 18→13, la validation V4 échoue en CI.
- **Fréquence estimée :** Certain (pattern identique dupliqué dans `/start` et `/done`)

---

**[MAJEUR] F-EC-4 — Estimation LOC `command-router.ts` sous-évaluée**

- **Scenario :** Section 4 annonce `~150-160 LOC` pour `command-router.ts`. Comptage réel des éléments obligatoires à migrer (F-EC-1 + F-EC-2) : 5 fonctions nommées (~140 L) + confirmationKey/actionVerb/resolveTaskId/resolveSprintId (~55 L) + 4 interfaces (~25 L) + 3 constantes/maps/counter (~8 L) + imports grammy/supabase (~10 L) = ~238 LOC. Le fichier résultant dépasse la limite S3 de 800 LOC uniquement si `command-router.ts` lui-même n'est pas pris en compte, mais la cible annoncée est fausse.
- **Source :** Section 4 ("Nouveau fichier : `src/commands/command-router.ts` (~150-160 LOC)")
- **Impact :** L'implémenteur peut s'arrêter après ~160 L en pensant être complet, laissant des helpers non migrés (retour à F-EC-2). L'estimation erronée masque l'ampleur réelle de l'extraction.
- **Fréquence estimée :** Fréquent (l'estimation guide le travail de l'implémenteur)

---

**[MAJEUR] F-EC-5 — Fallback `userTimezone` absent du code de sortie Section 4**

- **Scenario :** `getConfig().userTimezone` retourne `""` (string vide, valeur Zod par défaut — `config.ts` l.31) si `USER_TIMEZONE` est absent. Le code actuel dans `tasks.ts` utilise `process.env.USER_TIMEZONE || "Europe/Paris"` (fallback explicite). La Section 4 montre uniquement `getConfig().sprintThreadId` sans exemple analogue pour `userTimezone`. Un implémenteur pourrait écrire `getConfig().userTimezone` sans fallback, passant `""` à `toLocaleTimeString()` — ce qui lève un `RangeError: Invalid time zone specified`.
- **Source :** Section 4 (code de sortie tasks.ts), C9 ("si absent → fallback littéral 'Europe/Paris' acceptable")
- **Impact :** Comportement silencieusement incorrect ou exception runtime pour tout utilisateur sans `USER_TIMEZONE` configuré. C9 mentionne le cas mais la Section 4 (référence d'implémentation) ne le montre pas.
- **Fréquence estimée :** Occasionnel (déploiements sans USER_TIMEZONE)

---

**[MINEUR] F-EC-6 — V1/V2 : critères grep peuvent matcher dans des commentaires**

- **Scenario :** V1 dit `grep -n "patterns\|estimate" src/commands/help.ts retourne 0 match`. Si un commentaire de code contient `// patterns removed` ou `// no estimate`, le grep retourne un match et le critère échoue — alors que la fonctionnalité est correctement implémentée.
- **Source :** Section 8, V1, V2
- **Impact :** Faux négatif sur la validation manuelle ; le grep brut n'est pas équivalent à "absent des strings de helpCommands". Mineur car non exécuté en CI automatique.
- **Fréquence estimée :** Rare

---

**[MINEUR] F-EC-7 — Visibilité (export/private) des fonctions extraites non spécifiée**

- **Scenario :** La spec liste les 5 fonctions à extraire mais ne précise pas lesquelles doivent être exportées. `routeIntent`, `checkPendingClarification`, `handleConfirmationCallback`, `buildSyntheticUpdate` sont appelées depuis `messagesComposer` dans `zz-messages.ts` → doivent être `export`. `buildClarificationQuestion` est appelée uniquement par `routeIntent` (interne) → peut rester privée. Sans cette précision, l'implémenteur risque soit de ne rien exporter (erreurs d'import), soit de tout exporter (surface API inutilement large).
- **Source :** R8, Section 5 ("Créer" `command-router.ts`)
- **Impact :** Erreurs de compilation si les exports manquent ; pas de test possible pour C3 (30% couverture) si les fonctions ne sont pas exportées.
- **Fréquence estimée :** Occasionnel

---

**[MINEUR] F-EC-8 — Aucun exemple de test pour C3 (couverture 30% `command-router.ts`)**

- **Scenario :** C3 dit "créer des tests unitaires" comme chemin principal mais `routeIntent` requiert de mocker `grammy Context`, `InlineKeyboard`, `Supabase`, et `dispatchCommand` (callback async complexe). Sans skeleton ou pattern de test, l'implémenteur peut bloquer sur comment atteindre 30% et recourir directement au fallback allowlist — court-circuitant l'objectif de couverture.
- **Source :** C3 ("Chemin principal : créer les tests unitaires"), V11
- **Impact :** Risque de coverage allowlist utilisé sans justification écrite ; précédent de couverture dégradée sur le nouveau module.
- **Fréquence estimée :** Occasionnel

---

### Statistiques
- Bloquants : **2**
- Majeurs : **3**
- Mineurs : **3**

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux findings BLOQUANTS (F-EC-1, F-EC-2) partagent la même cause racine : la spec liste 5 fonctions à extraire mais omet leur écosystème complet (state, helpers, interfaces). Cela rend l'implémentation telle que spécifiée architecturalement impossible (C4 + S7). F-EC-3 (4ème `process.env` dans tasks.ts) et F-EC-5 (fallback `userTimezone`) sont des bugs silencieux qui feraient échouer CI. Corrections nécessaires avant implémentation : (1) lister explicitement l'extraction de `confirmationKey`, `resolveTaskId`, `resolveSprintId`, `actionVerb` + les 4 interfaces + le state + `_syntheticUpdateCounter` dans R8/Section 4/Section 5, (2) ajouter la ligne 309 de tasks.ts aux lignes à migrer, (3) montrer le fallback `|| "Europe/Paris"` dans la Section 4, (4) corriger l'estimation LOC à ~215-240.

---

## Simplicity Skeptic — Rapport

## Simplicity Skeptic — Rapport

**Spec analysée** : `docs/specs/SPEC-evaluation-de-toutes-les-fonctionnalites.md` (v2, post-adversarial)  
**Codebase vérifié** : `src/agent.ts`, `src/config.ts`, `src/commands/help.ts`, `src/commands/zz-messages.ts`, `tests/unit/coding-standards.test.ts`

---

### Findings

**[MAJEUR] F-SS-1 — R8 : extraction sous-spécifiée, état partagé silencieux**

- **Source** : Section 2 R8, Section 4 (structure attendue), Contrainte C4
- **Description** : La spec liste 5 fonctions à extraire vers `command-router.ts` (`buildClarificationQuestion`, `routeIntent`, `checkPendingClarification`, `handleConfirmationCallback`, `buildSyntheticUpdate`). Mais ces fonctions dépendent d'un bloc d'état partagé défini dans `zz-messages.ts` aux lignes 113-148 : les Maps `pendingConfirmations`/`pendingClarifications`, les constantes TTL, `_syntheticUpdateCounter` (l.309), la fonction `confirmationKey` (l.144), les interfaces `RouteResult`/`RouterContext`/`PendingConfirmation`/`PendingClarification` (ll.115-137), et les helpers `resolveTaskId`/`resolveSprintId` (ll.150-187). La contrainte C4 stipule que les dépendances doivent être unidirectionnelles (`zz-messages.ts → command-router.ts`) — ce qui signifie que **tout cet état doit partir dans `command-router.ts`**. La spec ne le mentionne pas explicitement. Un implémenteur qui extrait seulement les 5 fonctions nommées obtiendra soit un import circulaire (C4 violated → S7 échec CI) soit des erreurs de compilation.
- **Alternative** : Spécifier explicitement que le bloc entier ll.113-334 (commenté `// ── Command Router (inlined from command-router.ts) ──`) doit être extrait, ce que le commentaire existant suggère d'ailleurs.
- **Codebase** : `src/commands/zz-messages.ts:113-148`, `src/commands/zz-messages.ts:309`, `tests/unit/coding-standards.test.ts:488-499` (S7 DFS)

---

**[MAJEUR] F-SS-2 — R8 : estimations LOC systématiquement incorrectes**

- **Source** : Section 4 "zz-messages.ts — taille réduite", `command-router.ts (~150-160 LOC)`
- **Description** : La spec annonce `command-router.ts` à "~150-160 LOC" et `zz-messages.ts` à "~770-790 LOC" après split. Mais le bloc command-router dans `zz-messages.ts` couvre les lignes 113-334 soit ~222 lignes, auxquelles s'ajoutent les interfaces et l'état. Une extraction complète conforme à C4 produira un `command-router.ts` à ~220-240 LOC (non 150-160), et `zz-messages.ts` tombera à ~700-716 LOC (non 770-790). Les objectifs de la spec restent valides (< 800 LOC), mais les chiffres concrets fournis induisent en erreur et l'implémenteur pourrait croire avoir fait une erreur s'il obtient des LOC très différents.
- **Alternative** : Annoter l'extraction comme "tout le bloc ll.113-334" et ajuster les cibles à "~220 LOC / ~700 LOC".
- **Codebase** : `src/commands/zz-messages.ts:113-334` (grep confirmé)

---

**[MAJEUR] F-SS-3 — S9 cap déjà atteint (20/20) : tension non résolue avec sdd-agents.ts**

- **Source** : Section 7 C1, `tests/unit/coding-standards.test.ts:556-578`
- **Description** : Le S9 test vérifie `allowlistEntries + excludedEntries ≤ 20`. L'état actuel est exactement 18 + 2 = 20. Le cap EST ATTEINT maintenant, avant même cette spec. La spec présente C1 comme un "ordre obligatoire (R6 avant R7)" pour ne pas dépasser le cap. Mais la vraie tension est que `sdd-agents.ts` a été ajouté récemment (dernière entrée, justification "GITHUB_REPO — GitHub CLI pr review call") et a poussé le total à 20. La spec exclut explicitement la migration de `sdd-agents.ts` hors scope, mais ne mentionne pas que c'est cette entrée qui a saturé le cap. En laissant `sdd-agents.ts` dans l'allowlist, et en supprimant seulement les entrées mortes + migrées, la spec réduit à 12/20, ce qui est correct. Mais si un prochain sprint ajoute 8 entrées légitimes, le cap sera à nouveau atteint. Le nettoyage de ce sprint devrait idéalement aussi déclencher la migration de `sdd-agents.ts` (1 entrée triviale).
- **Alternative** : Inclure `sdd-agents.ts` dans les migrations R3-R5 (GITHUB_REPO est déjà dans `config.ts:155`, migration identique à agent.ts R3). Réduirait le total à 11/20 au lieu de 12/20.
- **Codebase** : `src/sdd-agents.ts` — grep `GITHUB_REPO`, `tests/unit/coding-standards.test.ts:151-153`

---

**[MINEUR] F-SS-4 — C3 : exigence de tests pour command-router.ts possiblement inutile**

- **Source** : Section 7 C3, Section 9 zone d'ombre
- **Description** : La spec exige 30% de couverture pour le nouveau `command-router.ts` et déclare "chemin principal : créer les tests unitaires." Mais les fonctions extraites (`routeIntent`, `handleConfirmationCallback`, `buildSyntheticUpdate`) manipulent `grammy Context`, `InlineKeyboard`, et des Maps avec TTL. Les tester unitairement requiert des mocks grammy non triviaux. Les fonctions simples comme `buildClarificationQuestion` et `confirmationKey` couvrent peut-être 30% à elles seules. La spec reconnaît la zone d'ombre ("si command-router.ts utilise des mocks Telegram complexes, la couverture 30% peut nécessiter un pattern de test spécifique") mais dit "tests en priorité" — ce qui est une sur-spécification par rapport à la valeur réelle. L'ajout au coverage allowlist (fallback explicite) est probablement l'issue correcte pour les fonctions Telegram-heavy.
- **Alternative** : Qualifier C3 : "créer des tests pour les fonctions pures (`buildClarificationQuestion`, `confirmationKey`, `buildSyntheticUpdate`)" et accepter le fallback coverage allowlist pour `routeIntent`.

---

**[MINEUR] F-SS-5 — R1/R2 incomplets : CLAUDE.md update manquant dans les règles métier**

- **Source** : Section 2 R1/R2 vs Section 5 fichiers
- **Description** : La Section 5 liste `CLAUDE.md` comme fichier à modifier (retirer `/patterns` et `/estimate` de la table des commandes). Mais les règles R1 et R2 en Section 2 ne mentionnent que `help.ts`. Un implémenteur qui exécute les règles de Section 2 sans lire Section 5 en entier manquera la mise à jour `CLAUDE.md`. Il n'y a aucun critère de validation automatique pour CLAUDE.md (V14 ne couvre que ecosystem.config.cjs). L'incohérence est bénigne (pas de CI regression) mais représente un gap de spec.
- **Alternative** : Ajouter "et `CLAUDE.md` table des commandes" aux descriptions de R1 et R2.

---

**[MINEUR] F-SS-6 — LOC_ALLOWLIST : test existsSync guard permet accumulation silencieuse**

- **Source** : Section 2 R6b, `tests/unit/coding-standards.test.ts:207`
- **Description** : Le test S3 LOC_ALLOWLIST vérifie "allowlist: ${file} is still above 800 LOC" mais contient `if (!existsSync(filePath)) return;` (l.207). Conséquence : `workflow.ts: 848` dans `LOC_ALLOWLIST` passe ce test silencieusement depuis la suppression de `src/workflow.ts`. La spec corrige ceci en R6b, ce qui est bien. Mais le design du test lui-même a un défaut : il ne signale pas les entrées mortes (fichiers supprimés). Ce pattern de "garde existsSync silencieux" reproduit exactement le même pattern pour S2 ALLOWLIST (les 3 fichiers morts ne font pas échouer de test). La spec résout les symptômes mais pas le pattern.
- **Alternative** : Hors scope de cette spec, mais noter que les tests de validation d'allowlist devraient échouer (non skip) pour les fichiers inexistants.

---

### Statistiques

- Bloquants : 0
- Majeurs : 3 (F-SS-1, F-SS-2, F-SS-3)
- Mineurs : 3 (F-SS-4, F-SS-5, F-SS-6)

---

## Verdict de l'agent: GO_WITH_CHANGES

**Justification** : La spec est correcte dans ses objectifs et adresse des problèmes réels (fantômes `/help`, violations S2, dette LOC). Les 3 findings MAJEURS ne sont pas des bloquants CI si l'implémenteur lit attentivement le code source, mais F-SS-1 (état partagé non spécifié) est un piège d'implémentation concret qui CAUSERA soit un import circulaire soit une compilation cassée. Recommandation : corriger R8 pour référencer explicitement le bloc ll.113-334 et son état associé avant d'implémenter.