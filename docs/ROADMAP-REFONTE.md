# Roadmap Refonte — claude-telegram-relay

> Cree le 2026-03-20. Derniere mise a jour : 2026-03-20 (audit post-Phase 2).
> Document vivant, mis a jour au fil des sprints.

## Contexte

Le projet a accumule 56 modules TypeScript et de la dette technique au fil des sprints S08-S44. Deux phases de refactoring ont ete livrees. Un audit complet post-Phase 2 (code, Supabase, logs PM2) a produit la roadmap ci-dessous.

**Etat actuel post-audit :**
- 56 modules src/, 2690 tests (100% pass), 0 dead code structurel
- 21 silent catches restants (tous acceptables : fire-and-forget)
- 0 TODO/FIXME/HACK dans le code
- Score audit code : A (excellent)
- Score coherence Supabase : 94%

---

## Phase 1 — Simplification code mort + refactoring zz-messages [DONE]

> Commit : 34e8dcb | Pipeline : docs/reviews/pipeline-simplification-bot.md

| Action | Statut |
|--------|--------|
| Suppression worktree.ts (195L) + dag-executor.ts (277L) | DONE |
| Suppression feature flag model_cascade | DONE |
| Nettoyage 10 exports morts memory.ts | DONE |
| Correction 5 silent catches (workflow.ts, orchestrator.ts) | DONE |
| Extraction processMessageInput() dans zz-messages.ts | DONE |
| Fix test TTS pre-existant | DONE |

---

## Phase 2 — Migration schema Supabase [DONE]

> Commit : a72e978 | Migration : schema_sync_tables_columns_rls | Pipeline : docs/reviews/pipeline-migration-schema-supabase.md

| Action | Statut |
|--------|--------|
| Creation 4 tables manquantes (pipeline_runs, gate_evaluations, trust_scores, agent_events) | DONE |
| Ajout colonne model a cost_tracking | DONE |
| Ajout colonne metadata a workflow_logs (decouverte bonus) | DONE |
| Fix noms colonnes dans code-review.ts, orchestrator.ts (step_from/step_to) | DONE |
| Fix filtres alerts.ts (.eq("step",...) -> metadata->>type) | DONE |
| Fix colonnes audit_results dans memory-server.ts (global_score/findings) | DONE |
| Fix filtres dashboard/server.ts (workflow_logs metadata) | DONE |
| Ajout table audit_results dans schema.sql | DONE |
| RLS + policies pour toutes les nouvelles tables | DONE |
| Refresh schema cache PostgREST | DONE |
| Tests adaptes (code-review.test.ts, mcp-audit-tool.test.ts) : 2690 pass | DONE |

---

## Phase 3 — Micro-corrections [DONE]

> Severite : MIXTE — 1 bug critique + nettoyage rapide
> Estimation : 30 minutes, pas besoin de pipeline complet

### 3a. Bug critique

| # | Probleme | Fichier | Ligne | Impact |
|---|----------|---------|-------|--------|
| B1 | `.update()` sans destructuration `{ error }` | src/heartbeat.ts | 562 | Update silencieusement echoue, dedup_key perdu |

### 3b. Feature flag mort

| # | Probleme | Fichier | Detail |
|---|----------|---------|--------|
| F1 | Flag `explore_mode` ON mais jamais reference dans le code | config/features.json | Aucun `isFeatureEnabled("explore_mode")` dans src/ — supprimer |

### 3c. Documentation desynchronisee

| # | Probleme | Detail |
|---|----------|--------|
| D1 | CLAUDE.md : tests count "2720" | Maintenant 2690 |
| D2 | CLAUDE.md : code-review.ts description "worktree isolation" | worktree.ts supprime en Phase 1 |
| D3 | CLAUDE.md : module count inconsistances possibles | Verifier le count reel vs declare |

**Actions requises :**
- [x] Fix heartbeat.ts:562 (ajouter `const { error } = await ...`)
- [x] Supprimer flag `explore_mode` de config/features.json
- [x] Mettre a jour CLAUDE.md (tests 2690, modules 58, composers 13, code-review.ts)

> Commit : fd5931a | Pipeline : docs/reviews/pipeline-micro-corrections.md

---

## Phase 4 — Nettoyage schema Supabase [A EVALUER]

> Severite : BASSE — pas d'impact fonctionnel, nettoyage de dette

### Tables mortes (jamais requetees via `.from()`)

| # | Table | Lignes schema.sql | Detail |
|---|-------|-------------------|--------|
| T1 | `logs` | L88-104 | Table d'observabilite declaree mais jamais inseree/lue |
| T2 | `workflow_proposals` | L325-347 | Propositions cross-projet, jamais implementees |
| T3 | `audit_results` | L1120-1134 | Creee en prod (migration) + declaree dans schema.sql, mais 0 `.from("audit_results")` dans src/. Utilisee uniquement via MCP memory-server et dashboard |

### RPCs mortes (jamais invoquees via `.rpc()`)

| # | RPC | Detail |
|---|-----|--------|
| R1 | `get_recent_messages` | Remplacee par autre mecanisme |
| R2 | `match_messages` | Remplacee par Edge Function `search` |
| R3 | `match_memory` | Remplacee par Edge Function `search` |
| R4 | `match_documents` | Remplacee par Edge Function `search` |
| R5 | `set_project_scope` | Helper RLS jamais appele |
| R6 | `current_project_id` | Helper RLS jamais appele |

### RPC non utilisee mais potentiellement utile

| # | RPC | Detail |
|---|-----|--------|
| R7 | `archive_old_memories` | Declaree dans schema.sql, jamais invoquee. La table `memory_archive` reste vide — accumulation infinie de memories en prod |

**Actions requises :**
- [ ] Decider : supprimer les tables/RPCs mortes ou les documenter comme futures
- [ ] Evaluer si `archive_old_memories` doit etre appele dans le heartbeat (prevention accumulation memoire)

---

## Phase 5 — Gros fichiers : decomposition [A PLANIFIER]

> Severite : MOYENNE — maintenabilite long terme
> Prerequis : Phases 3-4 completees

### Fichiers > 1000 lignes (candidats prioritaires)

| # | Fichier | Lignes | Proposition | Effort |
|---|---------|--------|-------------|--------|
| G1 | memory.ts | 1649 | Extraire memory-linking.ts (~300L), memory-classification.ts (~200L), memory-clustering.ts (~200L) | M |
| G2 | orchestrator.ts | 1312 | Extraire orchestrator-steps.ts (runAgentStep, agent prompts) | M |
| G3 | agent-schemas.ts | 1060 | Extraire en 1 fichier par role ou en 2-3 groupes thematiques | S |

### Fichiers 500-1000 lignes (surveillance)

| Fichier | Lignes | Notes |
|---------|--------|-------|
| gate-evaluator.ts | 887 | Complexe mais cohesif |
| workflow.ts | 769 | Machine a etats — difficile a decouper |
| zz-messages.ts | ~700 | Deja refactore (etait 913L), acceptable |
| bot-context.ts | 725 | Constructeur + helpers — cohesif |
| documents.ts | 706 | CRUD + search — cohesif |
| blackboard.ts | 621 | Workspace partage — cohesif |
| agent.ts | 600 | Spawn + branch-PR — cohesif |
| heartbeat.ts | 595 | Pulse periodique — cohesif |

**Actions requises :**
- [ ] Specifier via `/dev-spec` la decomposition de memory.ts (priorite 1)
- [ ] Specifier la decomposition de orchestrator.ts (priorite 2)

---

## Phase 6 — Resilience et monitoring [FUTUR]

> Severite : BASSE — amelioration operationnelle

| # | Idee | Detail | Effort |
|---|------|--------|--------|
| M1 | CI guard schema coherence | Check CI qui compare schema.sql vs colonnes referencees dans le code | M |
| M2 | Groq TTS quota monitoring | Alerter quand le quota journalier Groq approche la limite (3600 TPD) | S |
| M3 | LLM intent detection timeout | Augmenter le timeout de 15s ou implementer retry | S |
| M4 | Archivage memoire automatique | Appeler `archive_old_memories` dans le heartbeat periodique | S |

---

## Phase 7 — Restructuration architecturale [FUTUR]

> Severite : BASSE — ambition long terme
> Prerequis : Phases 3-6 completees

| # | Idee | Benefice | Effort |
|---|------|----------|--------|
| A1 | Restructuration par domaine (core/, telegram/, agents/, memory/) | Navigation codebase, isolation des concerns | L |
| A2 | Barrel files par domaine | Imports simplifies, API publique explicite | M |
| A3 | Reduction a ~40 modules (fusion des petits modules cohesifs) | Moins de fichiers a naviguer | M |

---

## Suivi

| Phase | Statut | Date | Commit/PR |
|-------|--------|------|-----------|
| 1. Simplification code mort + zz-messages | DONE | 2026-03-20 | 34e8dcb |
| 2. Migration schema Supabase | DONE | 2026-03-20 | a72e978 |
| 3. Micro-corrections (heartbeat, flags, docs) | DONE | 2026-03-20 | fd5931a |
| 4. Nettoyage schema (tables/RPCs mortes) | A EVALUER | — | — |
| 5. Decomposition gros fichiers | A PLANIFIER | — | — |
| 6. Resilience et monitoring | FUTUR | — | — |
| 7. Restructuration architecturale | FUTUR | — | — |
