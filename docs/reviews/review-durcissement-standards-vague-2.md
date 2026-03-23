# Revue : SPEC-durcissement-standards-vague-2

> Reviewer : agent reviewer
> Date : 2026-03-23
> Périmètre : 45 fichiers modifiés (31 src/ + 2 config + 7 tests/unit nouveaux + 2 tests/generated + 3 autres)

---

## Résumé exécutif

L'implémentation atteint ses objectifs principaux : zéro `any` dans `src/`, `noExplicitAny: "error"` actif dans `biome.json`, 7 nouveaux fichiers de tests unitaires créés, et `bunx tsc --noEmit` passe sans erreur. Un problème bloquant a été identifié : le seuil CI `3441` est incompatible avec le nombre réel de tests (`3158`), ce qui causerait un échec CI systématique.

---

## Conventions

- [x] `bunx tsc --noEmit` : **0 erreur** — TypeScript compile sans problème
- [x] Pas de secrets ni credentials dans le code
- [x] Types explicites sur les signatures publiques — `any` éliminé dans `src/`
- [x] `bunx biome check src/` : **0 erreur** (5 warnings `noImplicitAnyLet` pré-existants, niveau `warn`, hors scope de cette vague)

---

## Problèmes bloquants

### [.github/workflows/ci.yml:52] Seuil CI 3441 incompatible avec le nombre réel de tests

Le seuil anti-régression a été mis à `3441`, mais le `bun test tests/unit tests/integration tests/system` produit actuellement **3158 tests** (3080 unit + 46 integration + 32 system). Les 7 nouveaux fichiers de tests ajoutent 63 tests.

- Avant cette implémentation : 3158 - 63 = **3095 tests**
- Après implémentation : **3158 tests**
- Seuil CI configuré : **3441** — soit 283 au-dessus du réel

Si cette branche est mergée telle quelle, le step `Verify test count` échouerait **à chaque CI run**, bloquant tous les futurs PRs.

L'impact report notait d'ailleurs le seuil à `3300` (pas `3441`). La spec R12 s'appuyait sur un décompte erroné de 3441 (tag `adversarial F-DA-10`), mais le vrai décompte au moment de l'implémentation est 3158.

**Correction requise :** remplacer `3441` par `3158` dans `.github/workflows/ci.yml:52`.

---

## Avertissements

### [src/command-router.ts:43] Inconsistance interne — cast inline au lieu du type nommé `MsgWithThread`

La fonction `confirmationKey()` à la ligne 43 utilise encore un cast inline `as { message_thread_id?: number }`, alors que le type helper `MsgWithThread` est défini plus bas dans le même fichier à la ligne 341 et utilisé correctement aux lignes 342-344.

Ce n'est pas un `any`, donc pas bloquant pour le linter, mais c'est incohérent avec le pattern unifié préconisé par la spec R3 et la section 6.8. Le type `MsgWithThread` devrait être déplacé en haut du fichier pour être accessible partout.

### [tests/unit/transcribe.test.ts:49-79] Test du guard VOICE_PROVIDER insuffisant

Le test `"returns '' for empty Buffer when no VOICE_PROVIDER is configured"` ne valide pas réellement le comportement de `transcribe()` avec un provider vide. Comme `VOICE_PROVIDER` est lu au niveau module (ligne 18 de `src/transcribe.ts`), la valeur est fixée à l'import. Le test manipule `process.env.VOICE_PROVIDER` après import mais le module est déjà caché par Bun — le comportement testé est donc toujours `typeof transcribe === "function"`, pas `transcribe(buffer) === ""`.

La spec R10 et V16 demandaient explicitement de vérifier que `transcribe(buffer)` retourne `""` quand `VOICE_PROVIDER` est vide. Ce V-critère n'est pas couvert de manière exécutable.

Accepté pour cette vague : le test est un smoke test utile. Mais la couverture réelle du guard (V16) reste non vérifiée par les tests.

### [tests/generated/durcissement-standards-vague-2.test.ts] V8 test trop permissif

Le test V8 vérifie seulement que `biome.json` a la règle `noExplicitAny` définie (`toBeDefined()`), sans vérifier qu'elle est bien `"error"`. Puisque `biome.json` a effectivement `"error"`, un test plus précis (`toBe("error")`) aurait été plus robuste en cas de régression.

---

## Suggestions

### [src/doc-utils.ts:60,93,111] Typage explicite des boucles regex (`let match`)

Les `let match;` dans les boucles regex produisent des warnings `noImplicitAnyLet`. La correction est simple : `let match: RegExpExecArray | null;`. Ce n'est pas bloquant (`noImplicitAnyLet` reste à `"warn"`), mais la cohérence avec la philosophie de cette vague justifie de l'adresser dans un PR de suivi.

### [src/feedback-loop.ts:71-80] Interface `FeedbackRuleRow` en double

La fonction `loadFeedbackRules()` utilise une interface inline anonyme pour typer le `.map()`. Une interface nommée `FeedbackRuleRow` aurait été plus maintenable et cohérente avec le pattern des autres modules (cf. `WorkflowLogRow` dans `workflow.ts`). L'approche actuelle fonctionne mais est moins lisible.

### [tests/unit/llm-ops.test.ts:37-43] Test circuit-breaker incomplet

Le test `"healthy role has open = false"` a un commentaire expliquant qu'il ne peut pas vraiment affirmer `open = false` pour une raison liée au trust score initial. Le test se réduit à vérifier que `typeof status.open === "boolean"`, ce qui est redondant avec le test précédent. La spec V13 demandait de couvrir le **comportement** du circuit-breaker (pas uniquement les constantes). Un test réel nécessiterait de mocker les trust scores, ce qui dépasse un test unitaire simple.

---

## Vérification des V-critères

| V-critère | Statut | Détail |
|-----------|--------|--------|
| V1 | Passe | `bunx biome check --diagnostic-level=error src/` : 0 erreur. `noExplicitAny: "error"` actif |
| V2 | Passe | `bunx tsc --noEmit` : 0 erreur |
| V3 | Passe | `bunx biome check src/` : 0 erreur (5 warnings `noImplicitAnyLet` pré-existants) |
| V4 | **Echoue** | 3158 tests < seuil 3441. Seuil incorrect (voir problème bloquant) |
| V5 | Passe | `proactive-planner.ts` : `Task[]` importé et utilisé, tsc valide |
| V6 | Passe | `formatMetrics(metrics: SprintMetrics)` — test V6 passe, format correct |
| V7 | Passe | `BlackboardSections.spec: Record<string, unknown> \| null` — tsc valide |
| V8 | Passe | `biome.json` a `"noExplicitAny": "error"` |
| V9 | Passe | `ci.yml` contient `3441` (mais seuil incorrect, cf. V4) |
| V10 | Passe | `tests/unit/deliberation.test.ts` existe, 12 tests passent |
| V11 | Passe | `tests/unit/document-sharding.test.ts` existe, 9 tests passent |
| V12 | Passe | `tests/unit/heartbeat-prompt.test.ts` existe, 16 tests passent |
| V13 | Partiel | `tests/unit/llm-ops.test.ts` existe, 14 tests passent. Comportement CB couvert partiellement |
| V14 | Passe | `tests/unit/relay.test.ts` existe, 3 tests passent, bot non démarré |
| V15 | Passe | `tests/unit/topic-config.test.ts` existe, `getTopicConfig` retourne `undefined` (pas null) |
| V16 | Partiel | `tests/unit/transcribe.test.ts` existe, smoke test passe. Guard réel non exécuté (module cache) |
| V17 | Passe | `catch (error: any)` dans `src/commands/` migrés — biome check passe |
| V18 | Passe | `pipeline-selection.ts` : `supabase?: SupabaseClient` — tsc valide |
| V19 | Passe | 3158 tests passent, 0 fail (seuil CI seul problématique) |
| V20 | Passe | `getAllSprintMetrics()` retourne `SprintMetrics[]` — tsc valide |

---

## Revue par fichier (points notables)

### src/blackboard.ts

`BlackboardSections` correctement migré vers `Record<string, unknown> | null`. Le site d'usage critique dans `InMemoryBlackboard.write()` utilise `(row.sections as unknown as Record<string, unknown>)[section] = data` — double cast nécessaire car `BlackboardSections` est indexé par `SectionName`, pas `string`. C'est une solution valide.

### src/workflow.ts

`SprintMetrics`, `RetroRow`, `WorkflowLogRow` correctement définis depuis le schéma SQL. `getWorkflowAuditHistory()` utilise `Record<string, unknown>` pour les rows de `workflow_audit` (table non définie dans le scope) avec narrowing explicite sur chaque champ — pattern propre.

### src/agent-messaging.ts (hors scope — backward compatibility)

Le module consomme `BlackboardSections` via `readSection()` qui retourne `Record<string, unknown> | WorkingMemory | null`. L'adaptation est correcte : les sections `messages` sont castées en `MessagesSection | null` avec `as` explicite (ligne 58 : `as MessagesSection | null`). Pas de breaking change.

### src/orchestrator.ts (hors scope — backward compatibility)

Les accès aux sections blackboard (`spec`, `implementation`) sont correctement typés comme `Record<string, unknown> | null` (lignes 1742-1752) avec cast explicite. Pas de breaking change observé.

### tests/unit/deliberation.test.ts

Couvre `shouldDeliberate` et `getDeliberationReviewer` directement depuis `src/deliberation.ts`. Cas nominaux, d'erreur, et edge cases couverts (rôle inconnu via `as never`). Conforme à V10.

### tests/unit/topic-config.test.ts

Tests case-insensitive et trim (lignes 59-72) — bonne couverture. Attention : les tests supposent que `getTopicConfig` est case-insensitive et trim-tolerant, ce qui est bien le cas (`topicName.toLowerCase().trim()` dans le source). Conforme à V15.

### tests/generated/durcissement-incremental-des-standards.test.ts

V9 correctement mis à jour pour accepter `"warn"` ou `"error"`. Les 42 tests de vague 1 passent sans régression.

---

## Résultat des tests

```
bun test tests/unit tests/integration tests/system
3158 pass, 0 fail (115 fichiers)

bun test tests/unit/deliberation.test.ts ... transcribe.test.ts
63 pass, 0 fail (7 fichiers)

bunx tsc --noEmit
0 erreurs

bunx biome check src/
0 erreurs, 5 warnings (noImplicitAnyLet pré-existants)
```

---

## Score : 82/100

**Déduction principale :** seuil CI 3441 incompatible avec le compte réel (3158) — bloquant CI (-15 pts).
**Déduction secondaire :** V16 transcribe guard non exécutable à cause du module cache Bun (-3 pts).

L'élimination de 155 occurrences de `any` dans `src/`, les 7 nouveaux fichiers de tests, et la cohérence des patterns de typage (SupabaseClient, unknown + narrowing, Record<string, unknown>) sont de très bonne qualité. La migration des `BlackboardSections` avec les adaptations dans `orchestrator.ts` et `agent-messaging.ts` est correcte.

**Correction requise avant merge :** `.github/workflows/ci.yml` ligne 52 — remplacer `3441` par `3158`.
