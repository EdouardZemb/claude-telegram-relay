# Rapport adversarial — SPEC-durcissement-standards-vague-3

> Cycle 2 — Généré le 2026-03-23
> Spec source : `docs/specs/SPEC-durcissement-standards-vague-3.md`
> Contexte : Corrections cycle 1 appliquées (F-DA-1, F-DA-2, F-EC-1, F-EC-2, section 5, V12-V15). Recherche de NOUVEAUX problèmes.

---

## Tableau de synthèse

| ID | Agent | Sévérité | Titre |
|----|-------|----------|-------|
| F-DA-1 | Devil's Advocate | BLOQUANT | VALID_PIPELINES : 3 représentations contradictoires (code exemple, R12, V11) |
| F-DA-2 | Devil's Advocate | MAJEUR | `--hours` mappé vers un champ inexistant dans `addTask` |
| F-DA-3 | Devil's Advocate | MAJEUR | R16 (dégradation graceful) contredite par le script section 4.4 (`exit 1` sur grep vide) |
| F-DA-4 | Devil's Advocate | MINEUR | R17 : ambiguïté sur le seuil final (3516 vs 3516+N) |
| F-EC-1 | Edge Case Hunter | MAJEUR | V20 aveugle aux `catch (error) {}` silencieux avec binding |
| F-EC-2 | Edge Case Hunter | MAJEUR | ExecCommandSchema regex `/^[a-f0-9-]+$/` accepte des chaînes invalides (ex: `"---"`) |
| F-EC-3 | Edge Case Hunter | MINEUR | CI coverage exclut `tests/system` — divergence silencieuse avec "Verify test count" |
| F-EC-4 | Edge Case Hunter | MINEUR | `$LINES` peut contenir `%` selon le format Bun — comparaison `bc -l` échoue |
| F-SS-1 | Simplicity Skeptic | MAJEUR | Flags booléens requis dans `OrchestrateCommandSchema` — impossible de distinguer "absent" de `false` |
| F-SS-2 | Simplicity Skeptic | MINEUR | `PrdCommandSchema` discriminatedUnion inutilement complexe vs schema plat |
| F-SS-3 | Simplicity Skeptic | MINEUR | `parseTaskCommand` helper non spécifié — risque de duplication avec parsing existant |

---

## Verdict : NO-GO

**Justification :** 1 BLOQUANT irreconciliable (F-DA-1) + 5 MAJEURS nécessitant corrections de spec avant implémentation.

F-DA-1 est bloquant car les 3 représentations de `VALID_PIPELINES` se contredisent directement dans la même spec. L'implémenteur ne peut pas satisfaire simultanément R12 (3 valeurs minuscules), V11 (`"LIGHT"` valide en majuscule) et le code exemple (6 valeurs dont 5 majuscules + 1 minuscule). Quelle que soit la décision prise, au moins un V-critère sera violé.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — VALID_PIPELINES : 3 représentations contradictoires dans la même spec**

- Source : Section 4.3 ligne 151, R12 (Règles métier), V11 (Critères de validation)
- Description : La spec contient trois représentations incompatibles des valeurs valides de pipeline pour `OrchestrateCommandSchema` :
  1. **Section 4.3 — code exemple** : `["DEFAULT", "LIGHT", "QUICK", "SOLO", "REVIEW", "RESEARCH", "full"]` — mélange de majuscules ET une valeur minuscule `"full"`, 7 valeurs
  2. **R12 — texte** : `"valeurs connues en MINUSCULES (full, quick, review)"` — 3 valeurs seulement, toutes minuscules
  3. **V11 — V-critère** : `pipeline: "LIGHT"` doit retourner `success: true` — valeur en MAJUSCULES

- Impact : Ces trois sources se contredisent directement. Satisfaire V11 (`"LIGHT"` valide) invalide R12 (qui dit seulement minuscules). Suivre R12 invalide V11. Le code exemple (7 valeurs) est incohérent avec R12 (3 valeurs). L'implémenteur produira un schéma incorrect quelle que soit l'interprétation choisie.

- Evidence :
  ```typescript
  // Section 4.3 ligne 151 :
  const VALID_PIPELINES = ["DEFAULT", "LIGHT", "QUICK", "SOLO", "REVIEW", "RESEARCH", "full"] as const;
  // R12 texte : "full, quick, review en MINUSCULES"
  // V11 : pipeline: "LIGHT" → success: true  ← MAJUSCULE
  ```
  Le codebase réel (`execution.ts:356-361`) utilise `"full"`, `"quick"`, `"review"` en minuscules — aligné avec R12 mais pas avec V11 ni le code exemple.

**[MAJEUR] F-DA-2 — `--hours` mappé vers un champ inexistant dans `addTask`**

- Source : R10, Section 4.3 (`TaskCommandSchema`), Section 6.5
- Description : La spec définit `hours: z.coerce.number().positive().optional()` dans `TaskCommandSchema` et montre l'usage `parsed.value.title` passé à `addTask`. Mais `addTask` dans `src/tasks.ts:49-63` n'a pas de paramètre `estimated_hours` dans ses `opts`. La colonne `estimated_hours` existe dans la DB (`schema.sql` ligne 120) et dans le type `Task`, mais l'interface `addTask` ne l'expose pas.

- Impact : Si le validator Zod parse `--hours 3` mais que `addTask` ignore le champ, la valeur est silencieusement perdue (régression UX invisible). Si l'implémenteur modifie `addTask`, il sort du scope R18 sans que la spec l'autorise. La section 5 ne liste pas `src/tasks.ts` comme fichier modifié pour ce changement.

- Evidence : `src/tasks.ts:52-63` — `opts` de `addTask` : `description?`, `project?`, `priority?`, `sprint?`, `tags?`, `acceptance_criteria?`, `dev_notes?`, `architecture_ref?`, `subtasks?` — pas d'`estimated_hours`.

**[MAJEUR] F-DA-3 — R16 (dégradation graceful) contredite par le script section 4.4**

- Source : R16 vs Section 4.4 (script YAML `Coverage check`)
- Description : R16 stipule : "si le format change ou le grep échoue, afficher un warning **mais ne pas bloquer la CI**". Le script de la section 4.4 fait `exit 1` quand `$LINES` est vide.

- Impact : La règle R16 et son implémentation de référence sont directement contradictoires. Si Bun change son format de sortie coverage (ce que R16 anticipe comme risque réel), la CI se bloque malgré la garantie de dégradation graceful.

- Evidence :
  - R16 : "afficher un warning mais **ne pas bloquer la CI**"
  - Section 4.4 : `if [ -z "$LINES" ]; then echo "ERROR: Could not parse coverage output"; exit 1; fi`

**[MINEUR] F-DA-4 — R17 : ambiguïté sur le seuil final (3516 vs 3516+N)**

- Source : R17, V22, Zone d'ombre n°4
- Description : R17 dit de mettre le seuil à `3516+N` (N à déterminer). V22 dit `$PASS_COUNT -ge 3516`. Si le CI est mis à 3516 maintenant et que les nouveaux tests ajoutent N=25 tests, le seuil ne sera pas mis à jour post-implémentation. La protection anti-régression s'affaiblit progressivement.

### Statistiques
- Bloquants : 1
- Majeurs : 2
- Mineurs : 1

---

## Edge Case Hunter — Rapport

### Findings

**[MAJEUR] F-EC-1 — V20 aveugle aux `catch (error) {}` silencieux avec binding**

- Scenario : Le V-critère V20 propose de vérifier l'audit via `grep -rn "catch\s*{" src/` — ce pattern ne matche que les `catch {}` sans binding. Des blocs `catch (error) { /* silence */ }` existent dans le codebase et sont invisibles à ce grep : `src/adversarial-verifier.ts:115`, `src/tts.ts:207`, `src/code-review.ts:166`, `src/intent-detection.ts:454`, `src/gate-evaluator.ts:154`, `src/gate-evaluator.ts:593`, `src/adversarial-challenge.ts:108`, `src/adversarial-challenge.ts:285`.
- Source : V20, R4-R9 (l'audit cible les 111 blocs `catch {` sans binding — explicitement hors scope pour les catch avec binding)
- Impact : Post-implémentation, V20 "passe" (0 résultat au grep) mais une classe entière de catch potentiellement silencieux n'est pas auditée. La spec ne documente pas explicitement que les `catch (e) {}` sont hors scope — l'implémenteur croit que l'audit est complet.
- Frequence estimee : Certain — ces blocs existent déjà.

**[MAJEUR] F-EC-2 — ExecCommandSchema regex `/^[a-f0-9-]+$/` accepte des chaînes invalides**

- Scenario : La regex n'impose aucune contrainte de position sur le tiret. Elle accepte `"---"` (4 chars, regex ok), `"-abc"`, `"abc-"`, `"a--b"`. Ces chaînes satisfont le schéma (min 4 chars, max 36, regex ok) mais `idPrefix.startsWith("---")` ne matchera jamais aucun UUID (les UUID commencent par `[a-f0-9]`).
- Source : R11, Section 4.3 (`ExecCommandSchema`), V8-V10
- Impact : Le schéma valide des inputs qui échouent silencieusement au filtre Supabase (0 résultat, message "Aucune tache trouvée" au lieu d'un message d'erreur explicite). V10 teste `"xyz!@#"` (invalide par caractères) mais pas `"---"` (faussement valide par structure).
- Frequence estimee : Rare mais possible (copie-colle d'un mauvais ID).

**[MINEUR] F-EC-3 — CI coverage exclut `tests/system` — divergence avec "Verify test count"**

- Scenario : Le script section 4.4 exécute `bun test --coverage tests/unit tests/integration` sans `tests/system`. Le step "Verify test count" (à fusionner avec le step coverage selon R15) couvre `tests/unit tests/integration tests/system`. Si la fusion exclut les tests système du run coverage, la couverture calculée diverge silencieusement de la baseline 69.13%.
- Source : R15, Section 4.4, CI actuel (`ci.yml:43`)
- Frequence estimee : Certain au premier run post-merge — discordance silencieuse.

**[MINEUR] F-EC-4 — `$LINES` peut contenir `%` — comparaison `bc -l` échoue**

- Scenario : Selon la version de Bun, la sortie coverage peut formater le pourcentage avec `%` (ex: `"69.13%"`). `awk '{ print $3 }'` retournerait `"69.13%"` et `echo "69.13% < 60" | bc -l` échouerait avec une erreur de syntaxe, provoquant un comportement non défini du `if (( ... ))`.
- Source : R16, Section 4.4 (script)
- Frequence estimee : Rare (dépend de la version Bun).

### Statistiques
- Bloquants : 0
- Majeurs : 2
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — `OrchestrateCommandSchema` : flags booléens requis non nullable**

- Source : Section 4.3, R12 (`OrchestrateCommandSchema`)
- Description : Le schéma définit `useBlackboard: z.boolean()`, `skipChallenge: z.boolean()`, `useResume: z.boolean()` comme champs requis. Ces flags proviennent de `args.includes("--blackboard")` (toujours booléen). L'implémenteur doit injecter les valeurs avant `safeParse`, ce qui contourne l'utilité du schéma (pas de transformation, juste une re-validation de ce qu'on vient de calculer). De plus, `z.boolean()` (sans default) exige que l'objet passé à `safeParse` contienne ces clés — si l'implémenteur oublie un champ, le schema rejette l'input avec un message peu utile pour l'utilisateur.
- Alternative : `useBlackboard: z.boolean().default(false)` — cohérent avec la sémantique CLI (flag absent = false). Permet un appel `OrchestrateCommandSchema.safeParse({ idPrefix, pipeline })` sans injecter les booléens manuellement.
- Codebase : `execution.ts:296-298` — `const useBlackboard = args.includes("--blackboard")` retourne déjà un booléen — la validation stricte `z.boolean()` est redondante.

**[MINEUR] F-SS-2 — `PrdCommandSchema` : `discriminatedUnion` inutilement complexe**

- Source : Section 4.3, R13 (`PrdCommandSchema`)
- Description : `z.discriminatedUnion("action", [...])` est conçu pour des unions où chaque branche a des champs significativement différents. Ici, les 3 branches (`list`, `view`, `create`) ont respectivement 1, 2 et 2 champs. Un schema plat avec `z.enum` + champs optionnels serait plus simple et plus aligné avec le pattern `z.object({}).safeParse()` de `config.ts` (section 6.1).
- Alternative : `z.object({ action: z.enum(["list", "view", "create"]), id: z.string().regex(...).optional(), description: z.string().min(1).optional() })`.
- Codebase : La section 6.1 dit "réutiliser ce pattern" en référençant `config.ts` qui utilise `z.object({})` simple — la spec elle-même recommande le pattern simple mais propose `discriminatedUnion`.

**[MINEUR] F-SS-3 — `parseTaskCommand` helper non spécifié**

- Source : Section 6.5, R10
- Description : La section 6.5 montre `parseTaskCommand(input)` dans un exemple de code mais ne spécifie pas : signature de la fonction, localisation (module), comportement du parsing regex des options (`--desc`, `--priority`, `--hours`). Sans spécification, l'implémenteur peut dupliquer la logique de parsing de `ctx.match?.trim()` existante ou créer un helper qui ne retourne pas `Result<>`.
- Alternative : Spécifier explicitement dans la section 4.3 : `function parseTaskCommand(input: string): Result<TaskCommandArgs, ZodError>` — parse les options par regex puis appelle `TaskCommandSchema.safeParse()`.

### Statistiques
- Bloquants : 0
- Majeurs : 1
- Mineurs : 2

---

## Points forts identifiés

1. **Catégorisation A-E des catch blocks** : la segmentation en 5 catégories avec stratégie par catégorie est claire et actionnable. Le mapping fichier → catégorie en section 5 est exhaustif et vérifiable (111 blocs confirmés par grep dans 34 fichiers).
2. **Pattern de réutilisation Zod** : référencer `config.ts:19-34` comme modèle est une bonne décision — cohérence avec le codebase.
3. **Seuil couverture conservatif 60%** : bien justifié face à la baseline 69.13%, avec marge de 9 points pour absorber les nouveaux fichiers.
4. **R3 — pas de migration massive** : la contrainte de ne pas migrer le code existant vers Result préserve la non-régression des 3516 tests.
5. **V20 machine-checkable** : l'idée d'un V-critère vérifiable par grep est excellente — le pattern doit juste être élargi pour couvrir les catch avec binding.

---

## Recommandations (actions pour passer à GO)

### Correction bloquante (obligatoire)

**F-DA-1** : Choisir UNE représentation cohérente, alignée avec le codebase réel (`execution.ts:356-361`) :
- Section 4.3 code exemple : `["full", "quick", "review"] as const`
- R12 texte : déjà correct ("full, quick, review en minuscules") — garder
- V11 : remplacer `pipeline: "LIGHT"` par `pipeline: "quick"` (valeur minuscule valide)

### Corrections majeures (obligatoires avant implémentation)

**F-DA-2** : Choisir l'une de deux options :
- (a) Supprimer `hours` de `TaskCommandSchema` — hors scope car `addTask` ne l'accepte pas
- (b) Ajouter `src/tasks.ts` en section 5 avec la correction d'interface `opts += estimated_hours?: number`
- Option (a) recommandée pour respecter R18 (scope `src/` sans modifier les interfaces existantes)

**F-DA-3** : Corriger le script section 4.4 pour respecter R16 :
```yaml
LINES=$(echo "$COVERAGE_OUTPUT" | grep -i "all files" | awk '{ print $3 }') || LINES=""
if [ -z "$LINES" ]; then
  echo "WARNING: Could not parse coverage output — skipping threshold check"
else
  if (( $(echo "$LINES < 60" | bc -l) )); then
    echo "ERROR: Coverage ${LINES}% below threshold 60%"; exit 1
  fi
fi
```

**F-EC-1** : Étendre V20 ou documenter explicitement le périmètre :
- Option (a) : élargir le grep : `grep -rn "catch\s*\b" src/ | grep -v "log\.\|// R[5-9]\|throw"` → 0 résultat
- Option (b) : ajouter une note en V20 "périmètre : uniquement les `catch {}` sans binding (111 blocs)"

**F-EC-2** : Renforcer la regex `ExecCommandSchema` pour interdire les tirets en début/fin :
```typescript
idPrefix: z.string().min(4).max(36)
  .regex(/^[a-f0-9][a-f0-9-]{2,34}[a-f0-9]$|^[a-f0-9]{4,36}$/)
```
Ou utiliser `.refine()` : `.refine(s => !s.startsWith('-') && !s.endsWith('-'))`.

**F-SS-1** : Remplacer `z.boolean()` par `z.boolean().default(false)` pour les 3 flags :
```typescript
useBlackboard: z.boolean().default(false),
skipChallenge: z.boolean().default(false),
useResume: z.boolean().default(false),
```

### Corrections mineures (recommandées)

- **F-DA-4** : Clarifier V22 — seuil à 3516 maintenant, note "à mettre à jour manuellement post-implémentation une fois N connu"
- **F-EC-3** : Préciser dans R15 si `tests/system` est inclus dans le step coverage fusionné
- **F-EC-4** : Ajouter `LINES=$(echo "$LINES" | tr -d '%')` avant la comparaison `bc -l`
- **F-SS-2** : Optionnel — garder discriminatedUnion avec justification explicite
- **F-SS-3** : Spécifier la signature de `parseTaskCommand` en section 4.3

---

## Étape suivante

Verdict **NO-GO** — corriger la spec puis relancer le challenge (cycle 3) :

1. Résoudre F-DA-1 (BLOQUANT) — 2 minutes de correction dans la spec
2. Traiter F-DA-2, F-DA-3, F-EC-1, F-EC-2, F-SS-1 (MAJEURS)
3. Relancer : `/dev-challenge docs/specs/SPEC-durcissement-standards-vague-3.md`
4. Après GO : `/dev-implement "Implémenter SPEC-durcissement-standards-vague-3. Spec: docs/specs/SPEC-durcissement-standards-vague-3.md"`
