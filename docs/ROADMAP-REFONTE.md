# Roadmap Refonte — claude-telegram-relay

> Cree le 2026-03-20. Document vivant, mis a jour au fil des sprints.

## Contexte

Le projet a accumule 58+ modules TypeScript et de la dette technique au fil des sprints S08-S44. Un audit complet (diagnostic + exploration + challenge adversarial + impact analysis + review) a identifie les problemes ci-dessous. La Phase 1 de simplification a ete livree (commit 34e8dcb).

---

## Phase 1 — Simplification code mort + refactoring zz-messages [DONE]

> Commit : 34e8dcb | Pipeline : docs/reviews/pipeline-simplification-bot.md

| Action | Statut |
|--------|--------|
| Suppression worktree.ts (195L) | DONE |
| Suppression dag-executor.ts (277L) | DONE |
| Suppression feature flag model_cascade | DONE |
| Nettoyage 10 exports morts memory.ts | DONE |
| Correction 5 silent catches (workflow.ts, orchestrator.ts) | DONE |
| Extraction processMessageInput() dans zz-messages.ts | DONE |
| Fix test TTS pre-existant | DONE |
| Tests : 2690 pass, 0 fail | DONE |

---

## Phase 2 — Schema Supabase desynchronise [A FAIRE]

> Severite : HAUTE — erreurs en production, masquees avant la correction des silent catches

Les logs PM2 revelent 3 problemes de schema. Le code reference des colonnes/tables qui n'existent pas dans Supabase.

| # | Probleme | Table/Colonne | Modules concernes | Erreur Supabase |
|---|----------|---------------|-------------------|-----------------|
| S1 | Table manquante | `pipeline_runs` | orchestrator.ts (createPipelineRun, updatePipelineStatus) | `PGRST205: Could not find the table 'public.pipeline_runs' in the schema cache` |
| S2 | Colonne manquante | `workflow_logs.from_step` | workflow.ts (saveReviewResult, logOrchestrationResult) | `PGRST204: Could not find the 'from_step' column of 'workflow_logs' in the schema cache` |
| S3 | Colonne manquante | `cost_tracking.model` | orchestrator.ts (logCost) | `PGRST204: Could not find the 'model' column of 'cost_tracking' in the schema cache` |

**Actions requises :**
- [ ] Verifier db/schema.sql vs Supabase reel : identifier toutes les divergences
- [ ] Creer les migrations manquantes (pipeline_runs, from_step, model)
- [ ] Appliquer les migrations via MCP Supabase
- [ ] Verifier que les logs PM2 ne montrent plus ces erreurs

---

## Phase 3 — prd-workflow et orchestrateur [A EVALUER]

> Severite : MOYENNE — fonctionnalites utilisateur impactees

Findings du diagnostic initial (pre-refactoring) :

| # | Probleme | Detail | Source |
|---|----------|--------|--------|
| P1 | prd-workflow.ts fragile | Gestion d'etat via metadata JSONB, revision count fragile | Diagnostic initial |
| P2 | bot-context.ts mutex queue | Claude calls serialisees via mutex, potentiel bottleneck | Diagnostic initial |
| P3 | bot-context.ts session init async | Session chargee au module init, race condition potentielle | Diagnostic initial |
| P4 | Rate limiter memory leak | In-memory timestamps array jamais nettoye completement | Diagnostic initial |

**Actions requises :**
- [ ] Evaluer si P1-P4 causent des problemes reels en production (verifier logs)
- [ ] Specifier les corrections necessaires via /dev-spec si confirmes

---

## Phase 4 — Coherence documentation et configuration [A FAIRE]

> Severite : BASSE — pas d'impact fonctionnel mais dette qui s'accumule

| # | Probleme | Detail | Source |
|---|----------|--------|--------|
| D1 | CLAUDE.md module count | "56" est arithmetiquement correct (58-2) mais le count reel des fichiers peut diverger | Review (avertissement) |
| D2 | CLAUDE.md reference worktree | code-review.ts description dit encore "worktree isolation" mais le module n'existe plus | Review (avertissement) |
| D3 | Tests count dans CLAUDE.md | Indique "2720 tests" mais c'est maintenant 2690 | Post-implementation |
| D4 | Feature flag exploration_gate | OFF, utilise dans gate-evaluator.ts pour bypass auto-pass — documenter ou supprimer | Exploration |

**Actions requises :**
- [ ] Mettre a jour les compteurs dans CLAUDE.md (tests, modules)
- [ ] Corriger la description de code-review.ts
- [ ] Documenter le role d'exploration_gate ou le supprimer

---

## Phase 5 — Tables et RPCs inutilisees [A EVALUER]

> Severite : BASSE — nettoyage de schema

Findings de l'audit Supabase initial :

| # | Element | Statut | Detail |
|---|---------|--------|--------|
| DB1 | Table `logs` | Inutilisee dans src/ | Definie dans schema.sql, jamais inseree/lue depuis le code applicatif |
| DB2 | Table `workflow_proposals` | Inutilisee | Schema complet avec indexes et RLS, zero references dans le code |
| DB3 | RPC `get_recent_messages` | Non appelee | Definie dans schema mais jamais invoquee depuis src/ |
| DB4 | Edge function `memory-mcp` | Non invoquee directement | Probablement accedee via protocole MCP externe, pas depuis relay |

**Actions requises :**
- [ ] Confirmer que ces elements sont bien inutilises (pas d'acces externe)
- [ ] Supprimer ou documenter si conserves volontairement

---

## Phase 6 — Simplification structurelle avancee [FUTUR]

> Severite : BASSE — amelioration maintenabilite long terme

Options identifiees dans l'exploration (Option D — non retenue pour l'instant) :

| # | Idee | Benefice | Effort |
|---|------|----------|--------|
| F1 | Restructuration par domaine (core/, telegram/, agents/, memory/) | Navigation codebase, isolation des concerns | L |
| F2 | Barrel files par domaine | Imports simplifies, API publique explicite | M |
| F3 | Reduction a ~40 modules (fusion des petits modules) | Moins de fichiers a naviguer | M |
| F4 | orchestrator.ts trop gros (1312L) | Extraire les DAG definitions, pipeline selection dans des modules dedies | S |

**Prerequis :** Phases 2-4 completees.

---

## Suivi

| Phase | Statut | Date | Commit/PR |
|-------|--------|------|-----------|
| 1. Simplification code mort + zz-messages | DONE | 2026-03-20 | 34e8dcb |
| 2. Schema Supabase | A FAIRE | — | — |
| 3. prd-workflow et orchestrateur | A EVALUER | — | — |
| 4. Documentation et configuration | A FAIRE | — | — |
| 5. Tables et RPCs inutilisees | A EVALUER | — | — |
| 6. Simplification structurelle | FUTUR | — | — |
