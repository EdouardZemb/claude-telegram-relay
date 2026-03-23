# Rapport Adversarial — SPEC-durcissement-standards-vague-2.md
# Cycle 2

> Généré le 2026-03-23. Spec source : docs/specs/SPEC-durcissement-standards-vague-2.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic (parallèles, indépendants)
> Cycle 2 : vérification des corrections du cycle 1 + recherche de nouveaux problèmes.

---

## Tableau de synthèse

| # | Agent | Sévérité | Titre | Statut |
|---|-------|----------|-------|--------|
| F-DA-11 | Devil's Advocate | BLOQUANT | Triple incohérence du seuil CI : 600 → 3300 (S5) vs 3441 (R12/V9) vs 3095 (S7) | NOUVEAU |
| F-DA-12 | Devil's Advocate | MAJEUR | `BlackboardSections.verification` absente de la contrainte narrowing | NOUVEAU |
| F-DA-13 | Devil's Advocate | MINEUR | `noImplicitAnyLet: "warn"` non couvert par `noExplicitAny: "error"` | NOUVEAU |
| F-EC-9  | Edge Case Hunter  | MAJEUR | V1 ne peut pas être exécuté avant R11 — timing de vérification sous-spécifié | NOUVEAU |
| F-EC-10 | Edge Case Hunter  | MAJEUR | `tokenEstimate()` inexistante dans `document-sharding.ts` — V11 teste une fonction fantôme | NOUVEAU |
| F-EC-11 | Edge Case Hunter  | MINEUR | `relay.ts` : smoke test peut crasher selon les env vars au moment de l'import | NOUVEAU |
| F-SS-1  | Simplicity Skeptic | MAJEUR | `orchestrator-deliberation.test.ts` couvre déjà 100% des exports de `deliberation.ts` | NOUVEAU |
| F-SS-2  | Simplicity Skeptic | MAJEUR | `heartbeat.test.ts` importe UNIQUEMENT depuis `heartbeat-prompt.ts` — doublon structurel | NOUVEAU |
| F-SS-3  | Simplicity Skeptic | MINEUR | R14 (ordre de priorité) non vérifiable : aucun V-critère ne contraint l'ordre de traitement | NOUVEAU |

**Corrections cycle 1 vérifiées :**
- F-EC-8 RESOLU : V1 utilise `bunx biome check --diagnostic-level=error` — confirmé (biome retourne "No fixes applied" en mode error sur `src/` avec `noExplicitAny: "warn"` actuel)
- F-DA-10 RESOLU partiel : R12 et V4/V9 sont cohérents à 3441 — MAIS Section 5 (3300) et Section 7 (3095) n'ont pas été mis à jour (voir F-DA-11)
- F-DA-1 RESOLU : `zz-messages.ts` présent en Section 5 (ligne 134 de la spec)
- F-DA-4 RESOLU : `SprintMetrics` inclut tous les champs SQL — confirmé par `db/schema.sql` lignes 230-254
- F-DA-7 RESOLU : V13 teste le comportement du circuit-breaker (`getCircuitBreakerStatus`) via l'export `getCircuitBreakerStatus`, pas les constantes internes `CB_TRUST_THRESHOLD`/`CB_FAILURE_THRESHOLD` (non exportées)
- F-DA-6 RESOLU : V15 spécifie `undefined` — confirmé par `getTopicConfig` lignes 87-91 de `src/topic-config.ts` (retourne `undefined` pour topicName inconnu)
- F-DA-9 RESOLU : `deliberation.test.ts` et `heartbeat-prompt.test.ts` sont explicitement distincts de leurs fichiers existants
- Impact BlackboardSections : contrainte narrowing ajoutée pour `orchestrator.ts` (~8 sites) et `agent-messaging.ts` (~6 sites) — mais `verification` est manquante (voir F-DA-12)

---

## Verdict

**GO WITH CHANGES**

Justification : 1 BLOQUANT (F-DA-11 — triple incohérence du seuil CI entre trois sections de la spec) et 4 MAJEURS. Le BLOQUANT est resolvable en corrigeant les deux valeurs résiduelles incorrectes (Section 5 et Section 7) sans toucher à l'architecture.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-11 — Triple incohérence du seuil CI : trois valeurs différentes dans la même spec**
- Source : Section 5 ligne 143 vs R12 (Section 2) vs Section 7 contrainte ligne 214
- Description : La spec mentionne trois valeurs distinctes pour le même seuil de test CI dans trois sections différentes :
  - Section 5 (table "Fichiers concernés") : `Seuil anti-régression 600 → 3300`
  - R12 (Section 2 "Règles métier") : `if [ "$PASS_COUNT" -lt 3441 ]` (corrigé au cycle 1)
  - V4/V9 (Section 8 "Critères de validation") : `>= 3441 pass` (corrigé au cycle 1)
  - Section 7 (contrainte non-régression) : `les 3095 tests actuels doivent tous passer`

  La correction du cycle 1 (F-DA-10 → 3441) n'a été appliquée qu'en R12 et V-critères, mais PAS en Section 5 (toujours "3300") et PAS en Section 7 (toujours "3095"). Un implémenteur qui suit la Section 5 comme référence pour les modifications à effectuer mettra "3300" dans `ci.yml`, pas "3441". La Section 7 affirme "3095 tests actuels" alors que le mémoire indique 3343 et que R12 fixe le seuil final à 3441.
- Impact : BLOQUANT — contradiction directe entre trois sections de la spec. La Section 5 est la section opérationnelle qui guide l'implémentation. Une valeur erronée à cet endroit entraîne un CI avec un seuil insuffisant.
- Evidence : `Section 5 ligne 143 : "Seuil anti-régression 600 → 3300"` vs `R12 : "si [ "$PASS_COUNT" -lt 3441 ]"` vs `Section 7 : "les 3095 tests actuels"`

**[MAJEUR] F-DA-12 — `BlackboardSections.verification` absente de la contrainte narrowing**
- Source : Section 7, contrainte "BlackboardSections narrowing" + `src/blackboard.ts` lignes 38-46
- Description : La contrainte de narrowing en Section 7 mentionne `orchestrator.ts` (~8 sites) et `agent-messaging.ts` (~6 sites). Mais `BlackboardSections` définit 5 champs `any | null` : `spec`, `plan`, `tasks`, `implementation`, `messages` — et aussi `verification: any | null` (ligne 43 de `blackboard.ts`). La Section 4.1 (table des types) ne liste pas `verification` parmi les champs à migrer. La Section 7 ne mentionne pas de narrowing pour `verification`. Des accès à `sections.verification` existent dans `orchestrator.ts` (lignes 1267, 1403 — `readSection(supabase, bbSessionId, "verification")`). Si `verification` reste `any | null` après la migration, un `any` résiduel persistera et V1 (biome check) échouera.
- Impact : Risk de `any` résiduel non documenté dans la spec, bloquant V1 au dernier moment.

**[MINEUR] F-DA-13 — `noImplicitAnyLet: "warn"` non couvert : périmètre de l'upgrade biome.json non précisé**
- Source : Section 2 R11, Section 8 V1/V3, `biome.json` ligne 25
- Description : `biome.json` a `"noImplicitAnyLet": "warn"` en plus de `"noExplicitAny": "warn"`. La spec ne traite que le passage de `noExplicitAny` à `"error"`, sans position sur `noImplicitAnyLet`. Si des `let` sans annotation de type existent dans `src/`, ils déclencheront `noImplicitAnyLet` mais pas `noExplicitAny`. La spec est silencieuse sur cette règle biome voisine.
- Impact : Ambiguïté sur le scope exact du passage à `"error"` — `noImplicitAnyLet` inclus ou non ?

### Statistiques
- Bloquants : 1
- Majeurs : 1
- Mineurs : 1

---

## Edge Case Hunter — Rapport

### Findings

**[MAJEUR] F-EC-9 — V1 donne un faux positif tant que `noExplicitAny: "error"` n'est pas activé dans biome.json**
- Scenario : V1 exige `bunx biome check --diagnostic-level=error src/` retourne 0 erreurs. Or `noExplicitAny` est actuellement à `"warn"` dans `biome.json`. Le flag `--diagnostic-level=error` de biome ne remonte que les règles configurées à `"error"` — il ne transforme pas les `"warn"` en `"error"`. Test effectué sur le codebase actuel : `bunx biome check --diagnostic-level=error src/` retourne "Checked 77 files in 181ms. No fixes applied." malgré 20+ occurrences `noExplicitAny` en warn. Donc V1 passerait en permanence pendant toutes les PRs intermédiaires de vague 2, sans détecter un seul `any` résiduel — exactement le contraire de son objectif.
- Source : Section 8, V1 ; Section 7, contrainte séquençage ; `biome.json` ligne 23
- Impact : Critère de validation V1 sans valeur de garde avant la PR finale. Les `any` résiduels ne seront détectés qu'à la dernière PR, annulant la détection précoce.
- Frequence estimee : Frequent (à chaque PR intermédiaire de vague 2, soit 7+ PRs)

**[MAJEUR] F-EC-10 — `tokenEstimate()` inexistante dans `document-sharding.ts` : V11 et Section 4.2 référencent une fonction fantôme**
- Scenario : Section 4.2 spécifie que `tests/unit/document-sharding.test.ts` doit couvrir `tokenEstimate()`. Or dans `src/document-sharding.ts`, la fonction interne s'appelle `estimateTokens` (ligne 109) et n'est PAS exportée (`function estimateTokens`, sans `export`). Il n'existe pas de fonction `tokenEstimate` dans ce module. Un test qui tente d'importer `{ tokenEstimate }` depuis `../../src/document-sharding.ts` obtiendra `undefined`. Le test échouera avec "is not a function".
- Source : Section 4.2 table "Tests minimaux" pour `document-sharding.test.ts` ; `src/document-sharding.ts` lignes 109-111
- Impact : `document-sharding.test.ts` ne peut pas être créé tel que décrit dans la spec sans exporter `estimateTokens` (changement de `src/`) ou en testant `splitIntoSections` et son champ `token_estimate` indirect. V11 ne passera pas avec les instructions actuelles de la spec.
- Frequence estimee : Certain (erreur factuelle sur le nom d'une fonction)

**[MINEUR] F-EC-11 — `relay.ts` : les imports module-level depuis `bot-context.ts` peuvent lancer des effets de bord**
- Scenario : `relay.ts` importe `GROUP_ID`, `RELAY_DIR`, `TEMP_DIR`, `UPLOADS_DIR`, `PROJECT_DIR`, `supabase` depuis `bot-context.ts`. `supabase` est initialisé au niveau module via `createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`. Si `SUPABASE_URL` ou `SUPABASE_ANON_KEY` sont vides, `createClient` peut lancer une exception ou retourner un client invalide. La Section 7 mentionne que `BOT_TOKEN` est protégé par un IIFE try/catch mais ne mentionne pas `supabase`. Un smoke test de `relay.ts` avec des env vars vides peut crasher à l'initialisation du client Supabase, pas à l'appel `new Bot()`.
- Source : Section 7 contrainte "Module `relay.ts`" ; `src/relay.ts` ligne 33 ; `src/bot-context.ts` lignes 31-80
- Impact : `relay.test.ts` peut échouer à l'import avec une erreur Supabase, rendant le smoke test non fonctionnel sans env vars factices.
- Frequence estimee : Occasionnel (dépend de l'environnement de test CI)

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 1

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — `orchestrator-deliberation.test.ts` couvre déjà 100% des exports testables de `deliberation.ts`**
- Source : Section 4.2 ligne `deliberation.test.ts` ; Section 7 contrainte "Module `deliberation.ts`"
- Description : `tests/unit/orchestrator-deliberation.test.ts` (vérifié) importe directement `shouldDeliberate` et `getDeliberationReviewer` depuis `../../src/deliberation.ts` et couvre tous les cas de manière exhaustive : true pour architect/dev, false pour analyst/pm/qa/sm, reviewer pm pour architect, reviewer qa pour dev, null pour tous les autres. `deliberation.ts` exporte 3 symboles : `runDeliberation` (nécessite agent spawn, non testable unitairement), `shouldDeliberate` (couvert), `getDeliberationReviewer` (couvert). La spec justifie en Section 7 que le nouveau fichier peut "se concentrer sur les cas non couverts" — mais il n'y a pas de cas testables non couverts sans effets de bord. Créer un doublon n'apporte aucune valeur de couverture.
- Alternative : Renommer `orchestrator-deliberation.test.ts` en `deliberation.test.ts` pour respecter la convention de nommage, sans dupliquer les tests. Le compteur de tests V4 est alors atteint avec ce rename (0 nouveau test créé pour ce module).
- Codebase : `tests/unit/orchestrator-deliberation.test.ts` lignes 1-47

**[MAJEUR] F-SS-2 — `heartbeat.test.ts` importe UNIQUEMENT depuis `heartbeat-prompt.ts` : le fichier existant est déjà le fichier "dédié"**
- Source : Section 4.2 ligne `heartbeat-prompt.test.ts` ; Section 7 contrainte ; `tests/unit/heartbeat.test.ts`
- Description : La spec justifie la création de `heartbeat-prompt.test.ts` en affirmant que `heartbeat.test.ts` "teste le module heartbeat.ts". Or l'analyse du code montre l'inverse : `tests/unit/heartbeat.test.ts` lignes 6-13 importent `buildHeartbeatPrompt`, `createDefaultState`, `HEARTBEAT_DECISION_SCHEMA`, `HEARTBEAT_SYSTEM_PROMPT` exclusivement depuis `../../src/heartbeat-prompt`. Il n'y a aucun import depuis `src/heartbeat.ts`. V12 exige que `heartbeat-prompt.test.ts` couvre `createDefaultState()` et `buildHeartbeatPrompt()` — ces tests existent déjà et passent. Créer un second fichier duplique l'existant sans valeur ajoutée.
- Alternative : Renommer `heartbeat.test.ts` en `heartbeat-prompt.test.ts` pour aligner nommage et contenu. Pas de doublon, pas de tests supplémentaires, V12 satisfait.
- Codebase : `tests/unit/heartbeat.test.ts` lignes 5-13 — imports directs depuis `src/heartbeat-prompt` uniquement

**[MINEUR] F-SS-3 — R14 (ordre de priorité) est un conseil éditorial déguisé en règle métier**
- Source : Section 2, R14
- Description : R14 prescrit un ordre de traitement par nombre d'occurrences décroissant. Aucun V-critère ne valide cet ordre. Si l'implémenteur traite les fichiers dans n'importe quel ordre, aucun critère de la Section 8 ne peut signaler une violation. La présence de R14 dans la table des "Règles métier" crée une confusion : c'est un conseil de productivité, pas une contrainte de conformité.
- Alternative : Déplacer en note éditoriale dans la Section 6 (Patterns existants) ou Section 9 (Coverage).

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 1

---

## Recommandations (pour passer à GO)

### Corrections obligatoires (BLOQUANT)

**1. F-DA-11** — Unifier le seuil CI dans toutes les sections de la spec :
- Section 5 ligne 143 : remplacer `600 → 3300` par `600 → 3441`
- Section 7 contrainte non-régression : remplacer `3095 tests actuels` par `3441 tests actuels`
- R12 et V4/V9 sont déjà corrects (3441) — ne pas les modifier

### Corrections recommandées (MAJEURS)

**2. F-DA-12** — Compléter la contrainte narrowing en Section 7 pour inclure `verification` explicitement dans la liste des sections à migrer de `any | null` vers `Record<string, unknown> | null`.

**3. F-EC-9** — Clarifier le timing de V1 dans la Section 8 : ajouter une note "(ce critère ne peut être exécuté comme garde que après l'activation de `noExplicitAny: "error"` dans biome.json — PR finale uniquement. Avant cette PR, utiliser `bunx biome check --diagnostic-level=warn src/ | grep noExplicitAny` pour détecter les `any` résiduels)".

**4. F-EC-10** — Corriger Section 4.2 : remplacer `tokenEstimate()` par une formulation correcte. Deux options :
  - Option A : "tester `splitIntoSections()` avec du contenu markdown contenant des headings, vérifier que le champ `token_estimate` est positif pour chaque section retournée" (test indirect via l'interface publique)
  - Option B : Ajouter `estimateTokens` aux exports de `document-sharding.ts` et documenter ce changement dans la spec

**5. F-SS-1** — Remplacer "Créer `deliberation.test.ts`" par "Renommer `orchestrator-deliberation.test.ts` en `deliberation.test.ts`" dans la Section 4.2 et la Section 5.

**6. F-SS-2** — Remplacer "Créer `heartbeat-prompt.test.ts`" par "Renommer `heartbeat.test.ts` en `heartbeat-prompt.test.ts`" dans la Section 4.2 et la Section 5.

### Corrections mineures (optionnelles)

**7. F-DA-13** — Clarifier en Section 7 si `noImplicitAnyLet` reste à `"warn"` ou passe aussi à `"error"`.

**8. F-EC-11** — Enrichir la zone d'ombre 4 (Section 9) avec un V-critère ou une instruction précise sur les env vars factices nécessaires pour que `relay.test.ts` n'échoue pas à cause du client Supabase.

**9. F-SS-3** — Déplacer R14 en note éditoriale dans Section 6 ou Section 9.

---

## Points forts identifiés

- La spec est remarquablement précise sur les types à créer avec correspondance exacte avec le schéma SQL (`SprintMetrics` avec tous les champs du `db/schema.sql` lignes 230-254, `RetroRow` avec `project_id` inclus).
- Le séquençage obligatoire (any → tests → biome error) est une décision architecturale saine qui évite les régressions en cascade.
- Les 8 patterns existants (Section 6) sont tous vérifiables dans le codebase et constituent une guidance concrète et actionnable pour l'implémenteur.
- La correction de F-EC-8 (biome check avec `--diagnostic-level=error` vs grep) est validée et correcte dans son raisonnement — le problème est uniquement le timing d'exécution (F-EC-9).
- La contrainte de narrowing Blackboard (Section 7) anticipe correctement les cascades TypeScript dans `orchestrator.ts` et `agent-messaging.ts`.
- V14 (relay.test.ts vérifie uniquement les exports constants) est une contrainte bien pensée qui évite un test fragile dépendant du bot Telegram.
- Les zones d'ombre résiduelles en Section 9 sont honnêtement documentées (types Supabase complexes, relay.ts testabilité).
- La résolution de F-DA-6 est confirmée : `getTopicConfig` retourne bien `undefined` (pas `null`) pour un topic inconnu — V15 est correct.
