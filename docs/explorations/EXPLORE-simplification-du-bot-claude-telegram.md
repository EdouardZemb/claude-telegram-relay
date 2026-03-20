---
phase: 0-explore
generated_at: "2026-03-20T12:00:00Z"
subject: "Simplification du bot claude-telegram-relay"
verdict: GO
next_step: "dev-spec"
---

# Exploration : Simplification du bot claude-telegram-relay

## Section 1 -- Probleme

Le projet claude-telegram-relay a accumule 73 modules TypeScript (60 dans src/ + 13 Composers dans src/commands/) pour un total de 29 189 lignes de code source. Cette croissance organique sprint apres sprint (S08 a S44+) a produit plusieurs symptomes de dette technique :

1. **Code mort** : des modules entiers ne sont plus importes par le code de production (worktree.ts, dag-executor.ts) mais restent dans le codebase avec leurs tests associes.
2. **God-module** : zz-messages.ts (913 lignes) contient 4 handlers Telegram (text, voice, photo, document) avec une duplication massive entre le handler text (214 lignes) et le handler voice (226 lignes) — environ 85% du code est identique (session tracking, intent detection, PRD workflow interception, proposal confirmation, conversation fallback).
3. **Erreurs silencieuses** : 27 occurrences de `.catch(() => {})` dont certaines masquent des erreurs significatives (Supabase workflow logs, orchestrator agent events, session persistence).
4. **Complexite de navigation** : 73 modules rendent la comprehension du codebase difficile pour un nouveau contributeur ou pour un agent Claude Code travaillant en contexte limite.

L'objectif est de retrouver un codebase fonctionnel, navigable et maintenable sans regression fonctionnelle.

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [grammY — Scaling Up: Large Codebase](https://grammy.dev/advanced/structuring) | Documentation officielle | 2026-03-20 | Recommande le pattern 1-Composer-par-feature, composition centralisee dans bot.ts, pre-filtrage via router plugin | Haute |
| 2 | [How to Delete Dead Code in TypeScript — Cam McHenry](https://camchenry.com/blog/deleting-dead-code-in-typescript) | Article technique | 2026-03-20 | Processus iteratif ts-prune + ts-unused-exports, attention aux barrel files, exceptions framework-specifiques | Haute |
| 3 | [Dead Code Detection: Knip vs ts-prune — Level Up Coding](https://levelup.gitconnected.com/dead-code-detection-in-typescript-projects-why-we-chose-knip-over-ts-prune-8feea827da35) | Retour d'experience | 2025 | Knip detecte exports + fichiers + dependances morts en une passe, meilleur pour projets large | Moyenne |
| 4 | [How to Refactor a Monolithic Codebase — CloudBees](https://www.cloudbees.com/blog/how-to-refactor-a-monolithic-codebase-over-time) | Guide strategique | 2025 | Refactoring incrementiel, pieces isolees, habit d'opportunistic refactoring | Moyenne |

**Synthese :**

La documentation officielle grammY valide notre architecture actuelle (1 Composer par domaine fonctionnel) mais souligne que chaque Composer doit rester focalise sur un concern. Le god-module zz-messages.ts viole ce principe en melangeant 4 types de messages avec du code duplique.

Pour le dead code, les outils ts-prune et Knip automatisent la detection des exports/modules inutilises. Cependant, dans notre cas, l'analyse manuelle via grep est suffisante car les modules morts (worktree.ts, dag-executor.ts) sont facilement identifiables — zero importers depuis le code de production.

La strategie recommandee est le refactoring incrementiel : supprimer le code mort d'abord (gain rapide, zero risque de regression), puis refactorer les modules complexes un par un avec des tests comme filet de securite.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/worktree.ts` (195 lignes) | Zero importers depuis src/. Seul importer : 1 test unitaire. Git worktree lifecycle jamais integre au pipeline reel. | Suppression safe |
| 2 | `src/dag-executor.ts` (277 lignes) | Zero importers depuis src/. 3 fichiers de tests l'importent. Le DAG executor a ete remplace par l'orchestrateur sequentiel dans orchestrator.ts. | Suppression safe |
| 3 | `src/semaphore.ts` (53 lignes) | Importe par dag-executor.ts (mort), job-manager.ts et auto-pipeline.ts. Reste utile pour job-manager et auto-pipeline. | Conserver |
| 4 | `src/commands/zz-messages.ts` (913 lignes) | God-module : 4 handlers. Text handler (L201-414) et voice handler (L417-642) partagent ~85% de code identique : session init, constraint extraction, clarification check, PRD revision check, proposal confirmation, intent detection (regex + LLM), PRD workflow interception, conversation fallback. Seules differences : transcription prealable, `sendVoiceResponse` vs `sendResponse`, document search absent du voice handler. | Refactoring prioritaire |
| 5 | `src/prd-workflow.ts` (459 lignes) | Import `decomposeTask` depuis `agent.ts` — VALIDE (la fonction existe, export correct, build OK). Le module compile et le projet bundle sans erreur (verifie via `bun build`). | Aucun bug d'import |
| 6 | `.catch(() => {})` (27 occurrences) | 3 categories : (a) cleanup de fichiers temporaires (unlink) — acceptable, (b) fire-and-forget non-critique (bumpMemoryAccess, autoRemember) — acceptable, (c) erreurs Supabase masquees (workflow.ts L683, orchestrator.ts L697/746/796/1011, conversation-session.ts L127) — problematique | 5-6 catches a corriger |
| 7 | `model_cascade` feature flag | Flag OFF, aucune reference dans src/. Code mort implicite. | Suppression du flag |
| 8 | `src/heartbeat-prompt.ts` | Importe uniquement par heartbeat.ts. Module utile mais heartbeat est stoppe en production (PM2). | Conserver (potentiellement reactiver) |

**Points de friction identifies :**

- Les 2 720 tests existants couvrent largement le code, y compris les modules morts (worktree.test.ts, dag-executor.test.ts). Supprimer du code implique de supprimer les tests associes.
- Le loader.ts auto-decouvre les Composers dans src/commands/ par convention de nommage. Tout split de zz-messages.ts doit respecter cette convention.
- Le prefixe "zz-" de zz-messages.ts est intentionnel : il garantit le chargement apres tous les command handlers pour servir de fallback. Un refactoring doit preserver cet ordre.

**Actifs reutilisables :**

- Suite de 2 720 tests comme filet de securite pour le refactoring.
- Build check rapide (`bun build` en 42ms) pour verifier les imports a chaque etape.
- Feature flags pour activer/desactiver progressivement des fonctionnalites.

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo | B: Nettoyage chirurgical | C: Refactoring profond | D: Rewrite modulaire |
|---------|:------------:|:-----------------------:|:---------------------:|:-------------------:|
| **Complexite** | S | S | M | L |
| **Valeur ajoutee** | Low | Med | High | High |
| **Risque technique** | Low | Low | Med | High |
| *Impact maintenance* | Negatif (dette croissante) | Positif (moins de bruit) | Tres positif | Tres positif mais long |
| *Reversibilite* | N/A | Totale (git revert) | Partielle | Faible |

**Option A — Status quo** : ne rien faire. La dette continue de s'accumuler. Les 73 modules restent, le god-module grossit a chaque feature, les silent catches masquent des bugs. Cout zero immediat, cout croissant dans le temps.

**Option B — Nettoyage chirurgical** : supprimer les 2 modules morts (worktree.ts 195L + dag-executor.ts 277L = 472 lignes + tests associes), supprimer le feature flag `model_cascade` mort, corriger les 5-6 `.catch(() => {})` problematiques en ajoutant du logging. Gain : ~500 lignes mortes en moins, meilleure observabilite. Risque quasi-nul car code non-utilise.

**Option C — Refactoring profond** : Option B + extraction d'un helper `handleMessageInput()` dans zz-messages.ts pour factoriser le pipeline text/voice (session init, intent detection, PRD workflow, proposal confirmation, conversation fallback). Le handler text et voice deviennent des wrappers legers (~30-40 lignes chacun) qui preparent l'input puis delegent au pipeline commun. Reduction estimee : zz-messages.ts passe de 913 a ~550-600 lignes (gain ~35%).

**Option D — Rewrite modulaire** : restructuration complete du codebase avec decoupage en sous-repertoires par domaine (core/, telegram/, agents/, memory/, documents/), barrel files par domaine, reduction a ~40 modules au lieu de 73. Gain maximal en maintenabilite mais risque eleve de regression et effort de plusieurs sprints.

## Section 5 -- Verdict et justification

**Verdict : GO — Option C (Refactoring profond)**

Justification :

1. **Le code mort est confirme** (Axe 2) : worktree.ts et dag-executor.ts ont zero importers depuis le code de production. La suppression est sans risque.

2. **La duplication text/voice est massive et mesurable** (Axe 2) : 85% de code identique entre les deux handlers (440 lignes sur ~440). L'extraction d'un pipeline commun est un refactoring classique bien documente dans la litterature (Axe 1 — pattern Composer de grammY, single-responsibility principle).

3. **Les silent catches problematiques sont identifies et localises** (Axe 2) : 5-6 sur 27 masquent des erreurs Supabase dans workflow.ts et orchestrator.ts. Les autres (cleanup de fichiers temporaires, fire-and-forget non-critique) sont des patterns acceptables.

4. **L'import prd-workflow.ts n'est PAS casse** : `decomposeTask` existe dans agent.ts, l'import est valide, le projet compile et bundle sans erreur. Ce point ne necessite aucune action.

5. **La suite de tests (2 720 tests) et le build rapide (42ms)** offrent un filet de securite solide pour le refactoring. Le risque technique de l'option C est maitrise.

L'option C offre le meilleur ratio valeur/risque : elle inclut le nettoyage chirurgical (option B) et ajoute le refactoring du god-module qui est la source principale de dette technique. L'option D est prematuree — elle peut etre planifiee pour un sprint futur si l'option C revele d'autres besoins.

## Section 6 -- Input pour etape suivante

### Input pour spec

**Option recommandee** : Refactoring profond (Option C) en 3 phases sequentielles :

**Phase 1 — Suppression code mort** (risque minimal)
- Supprimer `src/worktree.ts` (195 lignes)
- Supprimer `src/dag-executor.ts` (277 lignes)
- Supprimer les tests associes : `tests/unit/worktree.test.ts`, `tests/unit/dag-executor.test.ts`
- Verifier que les tests des modules adjacents (tavily-research.test.ts, adaptive-pipeline.test.ts qui importent dag-executor) sont mis a jour ou supprimes
- Supprimer le feature flag `model_cascade` de `config/features.json`
- Run `bun test` apres chaque suppression

**Phase 2 — Correction des silent catches** (risque faible)
- Remplacer les `.catch(() => {})` problematiques par `.catch((err) => console.error("context:", err))` dans :
  - `src/workflow.ts` L683 (workflow log insert)
  - `src/orchestrator.ts` L697, L746, L796, L1011 (agent event inserts)
  - `src/conversation-session.ts` L127 (session persistence)
- Conserver les `.catch(() => {})` sur : unlink de fichiers temporaires, bumpMemoryAccess, autoRemember, ctx.reply en catch d'erreur (double-fault protection)

**Phase 3 — Refactoring zz-messages.ts** (risque modere)
- Extraire une fonction `processMessageInput(bctx, ctx, input, options)` qui encapsule le pipeline commun :
  - Session init + constraint extraction
  - Pending clarification check
  - PRD revision check
  - Proposal confirmation check
  - Intent detection (regex + LLM) + PRD workflow interception
  - Conversation fallback (context assembly, callClaude, memory intents, proposal detection)
- Options type : `{ isVoice: boolean; savePrefix: string; respond: (ctx, text) => Promise<void> }`
- Le text handler et voice handler deviennent des wrappers : preparation de l'input (transcription pour voice) + delegation au pipeline commun
- Les photo et document handlers restent inchanges (pas de duplication significative entre eux)
- Mise a jour de CLAUDE.md pour refleter le nouveau module count

**Fichiers concernes** :
- `src/commands/zz-messages.ts` (refactoring principal)
- `src/worktree.ts` (suppression)
- `src/dag-executor.ts` (suppression)
- `tests/unit/worktree.test.ts` (suppression)
- `tests/unit/dag-executor.test.ts` (suppression)
- `tests/unit/tavily-research.test.ts` (verifier imports dag-executor)
- `tests/unit/adaptive-pipeline.test.ts` (verifier imports dag-executor)
- `src/workflow.ts` (correction catch)
- `src/orchestrator.ts` (correction catch)
- `src/conversation-session.ts` (correction catch)
- `config/features.json` (suppression model_cascade)
- `CLAUDE.md` (mise a jour module count)

**Contraintes identifiees** :
- Le prefixe "zz-" de zz-messages.ts doit etre preserve pour garantir l'ordre de chargement par loader.ts
- La fonction extraite doit gerer les deux modes de reponse (text vs voice) via une callback
- Les 2 720 tests doivent tous passer apres chaque phase
- Le voice handler a une difference fonctionnelle : pas de document search auto. A preserver dans les options.

**Questions ouvertes a resoudre pendant la spec** :
1. Faut-il aussi supprimer `tests/unit/tavily-research.test.ts` et `tests/unit/adaptive-pipeline.test.ts` s'ils dependent de dag-executor, ou simplement retirer les imports ?
2. La fonction extraite doit-elle etre dans zz-messages.ts ou dans un nouveau module (ex: `src/message-pipeline.ts`) ?
3. Le feature flag `exploration_gate` (OFF) est-il aussi du code mort a supprimer ?
