## Revue : SPEC-modules-fondation-flow-sdd.md

Fichiers couverts :
- src/pipeline-tracker.ts (nouveau)
- src/conversation-handoff.ts (nouveau)
- src/commands/sdd-flow.ts (nouveau)
- src/relay.ts
- src/job-manager.ts
- src/commands/zz-messages.ts
- CLAUDE.md
- tests/unit/pipeline-tracker.test.ts (nouveau)
- tests/unit/conversation-handoff.test.ts (nouveau)
- tests/unit/sdd-flow.test.ts (nouveau)
- tests/unit/coding-standards.test.ts
- tests/unit/loader.test.ts

---

### Problemes bloquants

- [job-manager.ts:316] **Derivation du nom de pipeline incorrecte dans `getCompletionKeyboard`.**
  `sddName = job.type.replace("sdd-", "")` donne `"explore"` (le nom de la phase), pas le nom du
  pipeline SDD (ex: `"refactoring-memoire"`). Les callbacks post-completion auront donc des
  `callback_data` du type `sdd_discuss:explore` au lieu de `sdd_discuss:{nom-du-pipeline}`. La
  structure `Job` ne contient pas de champ pour le nom du pipeline — soit il faut l'encoder dans
  `job.type` (`sdd-explore:refactoring-memoire`), soit l'ajouter dans `LaunchOptions` (ex:
  `taskId` repurpose), soit injecter un champ `pipelineName` dans la struct `Job`. En l'etat,
  tous les boutons de completion des jobs SDD pointent vers un pipeline nommement incorrect et
  tomberont en `Pipeline inconnu ou expire` a chaque clic.

---

### Avertissements

- [conversation-handoff.ts:45,52] **`[CONTRAINTE]` present dans les deux patterns (`DECISION_PATTERNS` et `CONSTRAINT_PATTERNS`).**
  Un message contenant `[CONTRAINTE] ...` sera extrait a la fois comme decision (via
  `DECISION_PATTERNS[2]`) et comme contrainte (via `CONSTRAINT_PATTERNS[0]`). C'est une
  ambiguite semantique : la balise `[CONTRAINTE]` ne devrait produire qu'une contrainte. Impact
  faible (doubles dans le resume), mais peut polluer le `HandoffSummary.decisions` avec du
  contenu qui appartient aux contraintes. Suggestion : retirer `[CONTRAINTE]` de `DECISION_PATTERNS`.

- [commands/sdd-flow.ts:207] **Import dynamique de `job-manager.ts` diverge du pattern etabli.**
  Tous les autres Composers (`execution.ts`, `exploration.ts`, `planning.ts`, `utilities.ts`)
  importent `launch` et `isJobManagerEnabled` de facon statique en haut du fichier. `sdd-flow.ts`
  utilise un import dynamique a l'interieur du handler, ce qui masque la dependance et rompt la
  coherence. Aucun gain justifie ce choix — aucun probleme de circularite detecte. Suggestion :
  migrer vers un import statique comme les autres Composers.

- [tests/unit/coding-standards.test.ts:193] **Allowlist LOC pour `zz-messages.ts` indique `909` mais le fichier est desormais a `926` lignes.**
  Ce chiffre est utilise dans le message de documentation du test (`expected ~909`). Pas un
  echec de test (le test verifie uniquement `> 800`), mais la valeur documentaire devient
  inexacte. Suggestion : mettre a jour `909` -> `927` (ou la valeur reelle) pour conserver la
  coherence de la documentation du test.

---

### Suggestions

- [src/pipeline-tracker.ts:18-23] Legere redondance : `getRelayDir()` et `getPipelinesFile()` sont
  recalcules a chaque appel plutot qu'une seule fois. Le pattern etabli dans `job-manager.ts`
  (lignes 18-19) utilise des constantes module-level. Ici la resolution lazy est justifiee par
  les tests qui modifient `process.env.RELAY_DIR` — le code est correct, mais un commentaire
  `// Lazy pour les tests` serait utile pour les futurs lecteurs.

- [src/commands/sdd-flow.ts:218-219] La `agentFn` placeholder retourne un resultat hardcode
  (`SDD_{action}_OK: ...`). C'est explicitement un placeholder pour la Phase 3, mais il serait
  utile d'ajouter un commentaire `// TODO Phase 3: wired to real {action} agent` sur chaque cas
  (ou centralise) pour eviter toute confusion lors de la Phase 3.

- [tests/unit/sdd-flow.test.ts:194-208] Le test V13 (guard prefixe `sdd_`) est structurel
  uniquement (verifie que `mod.default` est une fonction). Les tests V14 et V15 (tracker
  null/expire) sont notes comme "integration-level" et non implementes directement. La spec
  les classe comme requis au niveau unit (V14, V15). Acceptable comme compromis si les tests
  pipeline-tracker.test.ts couvrent le TTL, mais la couverture du handler sdd-flow lui-meme
  en isolation n'est pas atteinte — a surveiller en Phase 3 avec mock de `ctx`.

- [CLAUDE.md] Les nouveaux modules sont correctement documentes dans la table `src/`. A noter :
  `conversation-handoff.ts` est ajoute en ligne 92 mais manque la documentation de
  `assembleHandoffContext` / `formatHandoffForAgent` dans la table des commandes Telegram (ce
  n'est pas une commande, donc c'est correct de ne pas le mentionner la).

---

### Verification des criteres V1-V24

| # | Critere | Statut |
|---|---------|--------|
| V1 | `toPipelineName("Refactoring memoire permanente")` → `"refactoring-memoire-permanente"` | OK — test pipeline-tracker.test.ts:48 |
| V2 | diacritiques + ponctuation | OK — test pipeline-tracker.test.ts:54 |
| V3 | 6 steps initiaux 'pending' | OK — test pipeline-tracker.test.ts:80 |
| V4 | Cles de stockage | OK — test pipeline-tracker.test.ts:96-109 |
| V5 | TTL 7 jours → null | OK — test pipeline-tracker.test.ts:120 |
| V6 | Symboles statut | OK — test pipeline-tracker.test.ts:208 |
| V7 | Artifact affiche | OK — test pipeline-tracker.test.ts:231 |
| V8 | Round-trip persistence | OK — test pipeline-tracker.test.ts:324 |
| V9 | `_clearForTests()` | OK — test pipeline-tracker.test.ts:337 |
| V10 | `assembleHandoffContext` avec decisions | OK — test conversation-handoff.test.ts:14 |
| V11 | `assembleHandoffContext` vide → arrays vides | OK — test conversation-handoff.test.ts:40 |
| V12 | `formatHandoffForAgent` sections presentes | OK — test conversation-handoff.test.ts:128 |
| V13 | Guard prefixe `sdd_` appelle `next()` | Partiel — test structurel uniquement (mod.default) |
| V14 | Tracker inconnu → pas de job | Non teste directement (voir avertissement) |
| V15 | Tracker expire → pas de job | Non teste directement (voir avertissement) |
| V16 | `buildSddKeyboard('explore', 'foo', undefined)` → [Explorer] + [Discuter] | OK — test sdd-flow.test.ts:53 |
| V17 | Verdict DROP → undefined | OK — test sdd-flow.test.ts:89 |
| V18 | Verdict NO-GO → pas de [Implementer] | OK — test sdd-flow.test.ts:130 |
| V19 | `detectConvergenceInResponse` → non-null sur pattern | OK — test sdd-flow.test.ts:12 |
| V20 | `detectConvergenceInResponse` → null sur reponse normale | OK — test sdd-flow.test.ts:26 |
| V21 | Pas d'imports modules Supprimes | OK — tests statiques pipeline-tracker.test.ts:372 et conversation-handoff.test.ts:193 |
| V22 | Composer charge par loader.ts | OK — loader.test.ts confirme sdd-flow.ts dans liste |
| V23 | Click [Specifier] → job "sdd-spec" | Non teste (integration manuelle) |
| V24 | Status bar plain-text | OK — test pipeline-tracker.test.ts:278 (no markdown markers) |

---

### Checks automatises

- `bunx tsc --noEmit` : 0 erreur
- `bun test` : 3936 pass, 0 fail (3946 tests avec 10 skips)
- `bun test tests/unit/pipeline-tracker.test.ts tests/unit/conversation-handoff.test.ts tests/unit/sdd-flow.test.ts` : 66/66 pass
- S1 (pas de console direct) : OK
- S2 (pas de process.env direct sans allowlist) : OK — `pipeline-tracker.ts` correctement ajoute a l'allowlist
- S3 (LOC <= 800) : OK — nouveaux modules bien en dessous du seuil ; `zz-messages.ts` correctement dans l'allowlist
- S4 (frontieres architecturales src/*.ts n'importe pas commands/) : OK — les importations dans sdd-flow.ts vont de commands/ vers src/ (direction autorisee)
- S5 (barrel convention) : OK — pas de nouveaux sous-repertoires

---

### Score : 80/100

**Justification :** L'implementation est globalement solide — TypeScript sans erreur, tests complets pour les modules core (`pipeline-tracker`, `conversation-handoff`), conventions respectees, contraintes d'import V21 honorees, integration loader correcte. Le score est penalise par :

1. **Bug bloquant** (-15) : la derivation du nom de pipeline dans `getCompletionKeyboard` (`job.type.replace("sdd-", "")`) produit un nom de phase au lieu du nom du pipeline, rendant tous les boutons post-completion des jobs SDD non fonctionnels en production.
2. **Pattern overlap `[CONTRAINTE]`** (-3) : double extraction decisions/contraintes.
3. **Import dynamique non justifie** (-2) : diverge du pattern etabli sans raison.
