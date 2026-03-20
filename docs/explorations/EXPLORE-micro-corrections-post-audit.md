---
phase: 0-explore
generated_at: "2026-03-20T14:30:00+01:00"
subject: "Micro-corrections post-audit : bug heartbeat, flag mort, doc desynchronisee"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Micro-corrections post-audit

## Section 1 — Probleme

Le projet claude-telegram-relay a subi un audit complet post-Phase 2 (migration schema Supabase). Cet audit a identifie trois categories de problemes residuels documentes dans `docs/ROADMAP-REFONTE.md` Phase 3 :

1. **Bug critique** : `src/heartbeat.ts` ligne 562 effectue un `.update()` Supabase sans destructurer `{ error }`, ce qui rend l'echec de mise a jour des notes de deduplication totalement silencieux. Si l'update echoue (timeout, RLS, contrainte), la dedup_key est perdue et la tache auto-generee ne porte pas son identifiant de deduplication, ouvrant la porte a des doublons lors des prochains scans.

2. **Feature flag mort** : `explore_mode` est declare `true` dans `config/features.json` mais aucun appel `isFeatureEnabled("explore_mode")` n'existe dans `src/`. Ce flag est un vestige d'une ancienne iteration et pollue la configuration sans effet.

3. **Documentation desynchronisee** : `CLAUDE.md` contient plusieurs informations perimees apres les Phases 1-2 de la roadmap de refonte :
   - Nombre de tests : indique "2720" alors que le count reel est 2690
   - Description de `code-review.ts` : mentionne "worktree isolation" alors que `worktree.ts` a ete supprime en Phase 1
   - Nombre de modules : indique "56 TypeScript modules" (reel : 58) et "11 Composer modules" (reel : 13)

Une exploration est necessaire pour evaluer la meilleure approche de correction groupee, mesurer l'impact potentiel et decider si un pipeline complet est justifie ou si une correction directe suffit.

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Supabase JS — Error Handling Discussion (GitHub #32)](https://github.com/supabase/supabase-js/issues/32) | Discussion officielle | 2026-03-20 | Supabase retourne `{data, error}` au lieu de throw. Pattern recommande : toujours destructurer et verifier `if (error)`. Ignorer `error` cause des silent failures et de la corruption logique downstream. | Haute |
| 2 | [Managing Tech Debt by Cleaning Up Unused Flags (DevCycle)](https://docs.devcycle.com/best-practices/tech-debt/) | Best practices | 2026-03-20 | Les flags morts augmentent la complexite cognitive, risquent des fallbacks non voulus, et doivent etre nettoyes regulierement. Recommandation : classifier les flags (temporaire vs permanent), detecter via analyse statique, supprimer dans le meme cycle de dev. | Haute |
| 3 | [The 12 Commandments Of Feature Flags (Octopus Deploy)](https://octopus.com/devops/feature-flags/feature-flag-best-practices/) | Guide | 2026-03-20 | Principe cle : chaque flag doit avoir un proprietaire et une date d'expiration. Les flags sans reference dans le code sont des candidats immediats a la suppression. | Moyenne |

**Synthese** : Les trois problemes identifies correspondent a des anti-patterns bien documentes dans l'industrie. Le bug heartbeat.ts est un cas classique de "silent failure" que Supabase lui-meme met en garde dans sa documentation. Le flag `explore_mode` est un exemple typique de dette technique de feature flags — un flag cree pour une experimentation passee, jamais nettoye apres que le besoin a disparu ou a ete rempli differemment (les flags `exploration_phase` et `exploration_gate` ont pris le relais). La desynchronisation documentaire est un phenomene previsible apres des refactorings importants (Phase 1 a supprime `worktree.ts` et `dag-executor.ts`, les counts ont change).

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/heartbeat.ts:562` | `await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id)` — seul `.update()` du fichier, sans destructuration `{ error }`. Se trouve dans le bloc autonomy scan. | Critique — dedup_key silencieusement perdue, doublons potentiels |
| 2 | `config/features.json` | 7 flags declares. `explore_mode: true` est le seul flag jamais reference par `isFeatureEnabled()` dans `src/`. Les 6 autres flags (`heartbeat`, `job_manager`, `auto_document_search`, `prd_to_deploy`, `exploration_phase`, `exploration_gate`) sont tous utilises. | Faible — aucun impact fonctionnel, uniquement pollution config |
| 3 | `src/feature-flags.ts:31` | `isFeatureEnabled()` lit `config/features.json`. Supprimer `explore_mode` ne casse rien car la fonction retourne `false` par defaut pour les flags absents. | Aucun risque |
| 4 | `CLAUDE.md:182` | Indique "2720 tests" — le count reel post-Phase 1 est 2690 (verifie par `bun test`). | Aucun impact fonctionnel, confusion pour les agents/devs qui lisent CLAUDE.md |
| 5 | `CLAUDE.md:214` | Repete "2720 tests" dans la section Conventions. | Idem |
| 6 | `CLAUDE.md:56` | `code-review.ts` decrit comme "Adversarial code review before merge, worktree isolation". Le fichier reel ne contient aucune reference a "worktree" (verifie par grep). `worktree.ts` a ete supprime en Phase 1 (commit 34e8dcb). | Confusion documentaire |
| 7 | `CLAUDE.md:175` | Indique "56 TypeScript modules" dans `src/` — le count reel est 58 (verifie par `ls src/*.ts | wc -l`). | Confusion documentaire |
| 8 | `CLAUDE.md:176` | Indique "11 Composer modules" dans `src/commands/` — le count reel est 13 (verifie : 13 fichiers exportent tous un Composer). Le tableau juste en dessous liste correctement les 13 modules. | Incoherence interne dans CLAUDE.md |
| 9 | `docs/ROADMAP-REFONTE.md:54-82` | Phase 3 documente deja exactement ces trois problemes avec les actions requises. Ce travail est pre-planifie. | Confirme la pertinence |

**Points de friction** : Aucun. Les trois corrections sont parfaitement isolees, sans interdependances, sans risque de breaking changes.

**Actifs reutilisables** : Le pattern correct de destructuration est deja utilise partout ailleurs dans le codebase (convention documentee dans CLAUDE.md section Conventions : "always destructure `{ error }` from Supabase operations and log with `console.error`"). La correction est un alignement sur la convention existante.

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Fix direct (3 corrections groupees) | C: Pipeline complet /dev-spec |
|---------|:------------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | S | M |
| **Valeur ajoutee** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | Med (bug silencieux persiste) | Low | Low |
| *Impact maintenance* | Negatif (doc ment, flag pollue) | Positif (coherence restauree) | Positif (idem) |
| *Reversibilite* | N/A | Totale (3 micro-edits) | Totale |

**Option A — Status quo** : Laisser les trois problemes en l'etat. Le bug heartbeat continue de perdre silencieusement les dedup_keys en cas d'erreur Supabase. Le flag mort reste dans la config. La documentation induit en erreur les agents et developpeurs. Cout : zero maintenant, mais accumulation de confusion et risque operationnel.

**Option B — Fix direct groupee** : Corriger les trois problemes en un seul commit. (1) Ajouter `const { error } = await ...` + `if (error) console.error(...)` a heartbeat.ts:562. (2) Supprimer la ligne `"explore_mode": true` de features.json. (3) Mettre a jour les 5 valeurs perimees dans CLAUDE.md (2x test count, 1x description code-review, 2x module counts). Effort estime : 15-20 minutes. Pas besoin de spec formelle pour des corrections factuelles.

**Option C — Pipeline complet /dev-spec** : Overkill pour 3 micro-corrections sans ambiguite. La spec serait plus longue a ecrire que les corrections elles-memes. Ce niveau de formalisme est reserve aux changements architecturaux ou fonctionnels, pas aux bug fixes factuels et au nettoyage de config.

## Section 5 — Verdict et justification

**Verdict : GO**

L'option B (fix direct groupee) est la recommandation. Justifications :

1. **Axe 1 (etat de l'art)** : La correction du bug heartbeat.ts aligne le code sur le pattern officiel recommande par Supabase (destructuration `{ error }`). Le nettoyage du flag mort suit les best practices documentees par DevCycle et Octopus Deploy (suppression immediate des flags sans reference code).

2. **Axe 2 (archeologie codebase)** : Les trois corrections sont parfaitement isolees. Le pattern a appliquer existe deja dans le codebase (convention CLAUDE.md). Aucune dependance, aucun risque de regression. La roadmap Phase 3 pre-planifie exactement ces actions.

3. **Axe 3 (matrice)** : L'option B offre le meilleur ratio valeur/effort (High/S). L'option C (pipeline complet) est disproportionnee pour des corrections factuelles. Le status quo laisse un bug critique actif.

4. **Risque de non-action** : Le bug heartbeat.ts est qualifie de critique car il peut causer des taches dupliquees lors des scans autonomes, generant du bruit operationnel et de la confusion dans le backlog.

## Section 6 — Input pour etape suivante

**Option recommandee** : B — Fix direct groupee

**Fichiers concernes** :
- `src/heartbeat.ts` (ligne 562) — ajouter destructuration `{ error }` + log
- `config/features.json` — supprimer `"explore_mode": true`
- `CLAUDE.md` (lignes 56, 175, 176, 182, 214) — corriger 5 valeurs perimees

**Corrections precises a appliquer** :

1. **heartbeat.ts:562** — Remplacer :
   ```typescript
   await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id);
   ```
   Par :
   ```typescript
   const { error: updateError } = await supabase.from("tasks").update({ notes: opp.dedup_key }).eq("id", task.id);
   if (updateError) console.error(`[${timestamp}] Failed to update task notes:`, updateError);
   ```

2. **config/features.json** — Supprimer la ligne `"explore_mode": true,`

3. **CLAUDE.md** — 5 corrections :
   - Ligne 56 : `code-review.ts` description → retirer ", worktree isolation"
   - Ligne 175 : "56 TypeScript modules" → "58 TypeScript modules"
   - Ligne 176 : "11 Composer modules" → "13 Composer modules"
   - Ligne 182 : "2720 tests" → "2690 tests"
   - Ligne 214 : "2720 tests" → "2690 tests"

**Contraintes identifiees** :
- Les tests existants (2690) doivent tous passer apres correction
- Le format JSON de features.json doit rester valide apres suppression du flag

**Questions ouvertes** : Aucune. Les corrections sont factuelles et sans ambiguite.

**Note** : Etant donne la simplicite et le caractere factuel des corrections, un pipeline `/dev-spec` complet n'est pas necessaire. Un commit direct sur une branche feature avec PR suffit. Le roadmap `docs/ROADMAP-REFONTE.md` Phase 3 devra etre mis a jour (checkboxes cochees, statut DONE) apres application.
