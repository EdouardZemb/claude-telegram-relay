---
phase: 1-spec
generated_at: "2026-03-25T10:40:00+01:00"
subject: "Controle CI et bouton merge post-implementation"
source_exploration: "docs/explorations/EXPLORE-controle-ci-et-bouton-merge-post.md"
source_review: "Revue adversariale en conversation (2026-03-25)"
revision: "v1 — post-adversarial, Option C simplifiee"
verdict: GO
option: "C — Gate CI avant merge"
---

## Section 1 — Objectif

Empecher le merge d'une PR quand la CI n'est pas verte, avec un message clair dans Telegram au lieu d'une erreur cryptique de `gh pr merge`. Actuellement, quand l'utilisateur clique "Fusionner la PR" dans la conversation, le `merge_ok` handler dans `sdd-flow.ts` execute `gh pr merge --squash` sans verification prealable. Si la CI est encore en cours ou a echoue, le branch protection bloque le merge avec un message d'erreur brut de `gh`.

La revue adversariale a identifie que l'approche B+C (polling post-implement + gate avant merge) est sur-ingenieree pour un bot mono-utilisateur. L'option C seule (verification CI au moment du clic merge) couvre 80% de la valeur avec ~30 lignes de code au lieu de 200+.

---

## Section 2 — Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Avant d'executer `gh pr merge`, verifier l'etat CI via `gh pr checks <prNumber> -R <repo> --json name,state,bucket` | Exploration §4 option C ; adversarial §4 | Si CI en cours : "CI en cours sur la PR #42, reessayez dans quelques minutes" |
| R2 | Si tous les checks sont `pass` ou `skipping` : proceder au merge normalement | Exploration §3 — `waitForCIChecks` pattern | Merge squash + delete branch comme aujourd'hui |
| R3 | Si un ou plusieurs checks sont `fail` : afficher les noms des checks echoues + bouton "Voir la CI sur GitHub" | Adversarial §3 — "pas de lien vers les logs GitHub Actions" | "CI echouee : check (fail). Corrigez les erreurs avant de merger." + bouton URL Actions |
| R4 | Si les checks sont encore en cours (`pending`) : afficher un message invitant a reessayer + bouton "Reessayer le merge" | Adversarial §3 — attente passive non souhaitable | "CI en cours (2/3 checks termines). Reessayez dans quelques minutes." + bouton retry |
| R5 | Si `gh pr checks` echoue (PR fermee, branche supprimee, erreur reseau) : fallback sur le comportement actuel (tenter le merge, laisser GitHub decider) | Defense en profondeur — le branch protection reste le filet de securite | Pas de regression si la commande `gh` echoue |
| R6 | Le check requis par le branch protection est `check` uniquement. `e2e` (needs check) peut etre `fail` sans bloquer le merge GitHub | `.github/workflows/ci.yml` + repo settings | Si `check: pass` et `e2e: fail`, le merge est autorise par GitHub. Notre gate doit se limiter au check `check` pour etre coherent |
| R7 | Aucune modification du semaphore, du job-manager, ni du result string SDD | Adversarial §1 — couplage textuel fragile, slots semaphore bloques | Le polling CI reste hors scope (phase 2 eventuelle) |
| R8 | Aucune regression sur les tests existants | Standard projet | `bun test` doit passer |

---

## Section 3 — Donnees d'entree

| Source | Type | Acces | Champs cles |
|--------|------|-------|-------------|
| `src/commands/sdd-flow.ts` L294-367 | TypeScript source | Lecture fichier | Handlers `merge_ask`, `merge_ok`, `merge_no`. Le `merge_ok` handler (L326-367) execute `gh pr merge --squash` sans verification CI |
| `src/agent.ts` L366-436 | TypeScript source | Reference | `waitForCIChecks()` — NON reutilisee dans cette spec (privee, prend branchName, pas PR number). Sert de reference pour le pattern de parsing des checks |
| `.github/workflows/ci.yml` | Workflow CI | Reference | 2 jobs : `check` (requis par branch protection) et `e2e` (depends on check). Seul `check` est bloquant pour le merge |
| Repo settings | GitHub config | API | `allow_auto_merge: false`, `required_status_checks: [check]`, `strict: true` |

---

## Section 4 — Donnees de sortie

### Comportement attendu du `merge_ok` handler apres modification

**Cas 1 — CI verte :**
```
Message: "PR #42 mergee en squash et branche supprimee."
(Comportement identique a aujourd'hui)
```

**Cas 2 — CI en cours :**
```
Message: "CI en cours sur la PR #42. Reessayez dans quelques minutes."
Boutons: [Reessayer le merge] [Voir la PR]
```

**Cas 3 — CI echouee :**
```
Message: "CI echouee sur la PR #42 : check (fail). Corrigez les erreurs avant de merger."
Boutons: [Voir la CI] [Voir la PR]
```

**Cas 4 — Erreur `gh pr checks` :**
```
(Fallback: tente le merge normalement, comme aujourd'hui. Si le merge echoue aussi, affiche l'erreur gh.)
```

### Fonction utilitaire ajoutee

```typescript
// Dans sdd-flow.ts, fonction locale (pas exportee)
async function checkPrCI(prNumber: string, repo: string): Promise<
  { status: "pass" } | { status: "pending"; details: string } | { status: "fail"; details: string } | { status: "error" }
>
```

---

## Section 5 — Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/commands/sdd-flow.ts` | Modifier | Ajouter `checkPrCI()` locale + integrer dans `merge_ok` handler avant `gh pr merge` |
| `tests/unit/sdd-flow.test.ts` | Modifier | Ajouter tests pour les 4 cas CI (pass, pending, fail, error) dans le handler merge_ok |

---

## Section 6 — Patterns existants

### P1 — Pattern spawnSync pour commandes gh dans sdd-flow.ts

`src/commands/sdd-flow.ts` L352-363 — le `merge_ok` handler utilise deja `spawnSync` pour `gh pr merge` :

```typescript
const mergeResult = spawnSync([
  "gh", "pr", "merge", prNumForMerge,
  "--squash", "--delete-branch",
  "-R", githubRepo,
]);
```

La verification CI utilisera le meme pattern avec `gh pr checks` :

```typescript
const checksResult = spawnSync([
  "gh", "pr", "checks", prNumber,
  "-R", repo,
  "--json", "name,state,bucket",
]);
```

### P2 — Pattern parsing JSON de checks dans agent.ts

`src/agent.ts` L396-416 — le parsing des checks CI suit ce pattern :

```typescript
const checks = JSON.parse(output) as Array<{ name: string; state: string; bucket: string }>;
const allCompleted = checks.every(c => c.bucket === "pass" || c.bucket === "fail" || c.bucket === "skipping");
const allPassed = checks.every(c => c.bucket === "pass" || c.bucket === "skipping");
```

La fonction `checkPrCI` reutilisera exactement ce pattern de parsing.

### P3 — Pattern InlineKeyboard dans sdd-flow.ts

`src/commands/sdd-flow.ts` L305-312 — les boutons inline suivent ce pattern :

```typescript
const confirmKb = new InlineKeyboard()
  .text("Confirmer le merge", `sdd_merge_ok:${name}`)
  .text("Annuler", `sdd_merge_no:${name}`);
```

Les boutons retry/voir CI reutiliseront le meme pattern.

---

## Section 7 — Contraintes

| # | Contrainte | Detail |
|---|-----------|--------|
| C1 | **Pas de modification de agent.ts** | `waitForCIChecks()` reste privee. La fonction `checkPrCI` est locale a sdd-flow.ts et utilise le PR number (pas le branch name). Pas d'export, pas de couplage inter-modules |
| C2 | **Pas de modification du job-manager ni du result string** | L'adversarial a identifie que le result string est tronque a 500 chars et que l'encoder avec l'etat CI est fragile. La verification CI se fait uniquement au moment du merge |
| C3 | **Pas de polling long** | Pas de boucle d'attente dans le handler callback. Un seul appel synchrone a `gh pr checks`. Si la CI n'est pas terminee, on demande a l'utilisateur de reessayer |
| C4 | **Coherence avec le branch protection** | Le check requis est `check` uniquement. Pour etre coherent avec GitHub, on verifie que le check nomme `check` est pass. Si seul `e2e` echoue mais `check` passe, on autorise le merge (GitHub le ferait aussi) |
| C5 | **Le bouton "Reessayer le merge" reutilise le callback existant** | `sdd_merge_ok:{name}` — pas de nouveau callback a creer. L'utilisateur reclique et la verification CI se refait |
| C6 | **Fallback gracieux** | Si `gh pr checks` echoue pour n'importe quelle raison, on ne bloque pas le merge. On tente le merge normalement et on laisse GitHub decider. Le branch protection reste le dernier rempart |

---

## Section 8 — Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | Le handler `merge_ok` appelle `gh pr checks` avant `gh pr merge` | Lecture du code : `checkPrCI()` appele avant `spawnSync(["gh", "pr", "merge", ...])` | unit |
| V2 | Si CI verte, le merge s'execute normalement | Test : mock spawnSync pour retourner checks `[{bucket:"pass"}]` puis verifier que `gh pr merge` est appele | unit |
| V3 | Si CI en cours, message explicatif + bouton retry affiches, pas de merge | Test : mock checks avec `bucket:"pending"`, verifier `ctx.reply` contient "en cours" et `reply_markup` contient bouton retry | unit |
| V4 | Si CI echouee, message avec details + bouton "Voir la CI", pas de merge | Test : mock checks avec `bucket:"fail"`, verifier message contient nom du check echoue | unit |
| V5 | Si `gh pr checks` echoue, fallback sur le merge direct | Test : mock spawnSync exitCode non-zero pour checks, verifier que `gh pr merge` est quand meme appele | unit |
| V6 | Le bouton "Reessayer le merge" utilise le callback `sdd_merge_ok:{name}` | Lecture du code : le InlineKeyboard pour le cas "pending" utilise le meme callback | unit |
| V7 | Coherence R6 : si `check` pass mais `e2e` fail, le merge est autorise | Test : mock checks `[{name:"check",bucket:"pass"},{name:"e2e",bucket:"fail"}]`, verifier merge autorise | unit |
| V8 | Aucune regression tests existants | `bun test` passe | integration |

---

## Section 9 — Coverage et zones d'ombre

### Matrice des 4 dimensions

| Dimension | Couvert | Hors scope | Zone d'ombre |
|-----------|---------|-----------|--------------|
| **Probleme** | Message d'erreur cryptique quand merge impossible, pas de feedback CI | Notification proactive du statut CI apres implementation (Option B) | — |
| **Perimetre** | Gate CI dans `merge_ok` handler uniquement (Option C) | Polling CI post-implement, modification result string, auto-merge GitHub | Le bouton "Fusionner" apparait toujours apres review APPROVED meme si CI pas terminee. L'utilisateur pourrait cliquer et recevoir "CI en cours" — UX acceptable car bouton retry fourni |
| **Validation** | V1-V8 couverts par tests unitaires + integration | Tests E2E Telegram (hors scope, pas de regression comportement) | Le mock de `spawnSync` dans les tests doit couvrir les 4 cas. Verifier que le test framework supporte le mock de `Bun.spawnSync` |
| **Technique** | Modification isolee dans sdd-flow.ts (~30 LOC), aucune nouvelle dependance, aucun export | Modification agent.ts, job-manager.ts, pipeline-tracker.ts | Si le format JSON de `gh pr checks --json` change dans une future version de gh CLI, le parsing cassera silencieusement (fallback sur merge direct via C6) |

### Alternatives evaluees

**Alt A — Option B+C combinee (polling + gate)** : Rejetee apres revue adversariale. Le polling CI post-implement occupe un slot semaphore pendant 3-10 minutes, complexifie le result string (troncature 500 chars), et necessite d'exporter `waitForCIChecks`. Cout reel 200-300 LOC sur 5 fichiers vs 30 LOC sur 1 fichier. Pour un bot mono-utilisateur, le gain UX marginal ne justifie pas la complexite.

**Alt B — Auto-merge GitHub (Option D)** : `gh pr merge --auto --squash` est la solution la plus propre a long terme. Cependant, elle necessite d'activer `allow_auto_merge` sur le repo et n'offre pas de notification Telegram quand le merge effectif a lieu. Candidate pour phase 2 complementaire.

**Alt C — Ne rien faire (Option A)** : Le branch protection bloque deja le merge si CI rouge. Cependant, le message d'erreur est cryptique ("GraphQL: ... required status check 'check' is expected") et l'utilisateur doit aller sur GitHub pour comprendre. Option C ameliore significativement l'UX pour ~30 LOC.

### Phase 2 potentielle (hors scope)

- Activer `allow_auto_merge` sur le repo pour le cas ou le bot redemarre entre verification et merge
- Ajouter un polling CI optionnel post-implement pour notification proactive (Option B)
- Bouton "Relancer la CI" (re-push force) en cas d'echec CI flaky
