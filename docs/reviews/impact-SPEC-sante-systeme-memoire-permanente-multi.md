## Rapport d'impact : Sante du systeme de memoire permanente et promotion working memory

> Genere le 2026-03-23 a partir de docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md.

### Niveau de risque : MEDIUM

### Resume

Le changement active du code existant non-branche (`promoteWorkingMemory()`) dans l'orchestrateur et ajoute deux nouvelles fonctions dans `memory.ts` plus une sous-commande `/brain health`. Le blast radius est contenu a 4 modules directement modifies, mais l'orchestrateur est un hub critique importe par 3 modules (auto-pipeline, deliberation, execution). Le risque principal est la modification du chemin post-pipeline de `orchestrate()` qui impacte transitivement tout appel d'orchestration (y compris `/autopipeline` et `/orchestrate`). Le feature flag `memory_promotion` (off par defaut) mitigue fortement le risque de regression en production.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/orchestrator.ts` | Direct | Ajout d'un nouvel import depuis `memory.ts` (`promoteWorkingMemory`), ajout d'un bloc try/catch post-pipeline entre traceability et cleanup (L1777-1779). Nouveau chemin d'execution conditionnel sur feature flag + blackboard. |
| `src/memory.ts` | Direct | Ajout de `memoryHealthStats()` et `formatMemoryHealth()` (~80 lignes). Nouvelles queries sur tables `memory`, `memory_links`, `memory_archive`. Aucune modification des fonctions existantes. |
| `src/commands/memory-cmds.ts` | Direct | Ajout du parsing de sous-commande dans le handler `/brain` (actuellement pas de parsing `ctx.match`). Nouveau import de `memoryHealthStats` et `formatMemoryHealth` depuis `memory.ts`. |
| `config/features.json` | Direct | Ajout du flag `memory_promotion: false`. Aucun impact sur les flags existants. |
| `src/auto-pipeline.ts` | Indirect | Appelle `orchestrate()` a L211. Beneficie automatiquement de la promotion si le flag est actif et le blackboard utilise. Aucune modification requise mais le comportement change. |
| `src/commands/execution.ts` | Indirect | Appelle `orchestrate()` via `/orchestrate`. Meme impact transitif que auto-pipeline. |
| `src/deliberation.ts` | Indirect | Importe `runAgentStep` depuis orchestrator mais pas `orchestrate()`. Impact negligeable. |
| `tests/unit/memory-evolution.test.ts` | Direct | Ajout de tests pour `memoryHealthStats()` et `formatMemoryHealth()`. |
| `tests/unit/orchestrator.test.ts` | Direct | Ajout de tests pour le branchement `promoteWorkingMemory` en fin de pipeline. |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/memory.ts` | `memoryHealthStats()` | Ajout | Oui |
| `src/memory.ts` | `formatMemoryHealth()` | Ajout | Oui |
| `src/memory.ts` | `MemoryHealthStats` (interface) | Ajout | Oui |
| `src/orchestrator.ts` | `orchestrate()` | Modification (effet de bord interne) | Oui (comportement additionnel conditionnel) |
| `src/commands/memory-cmds.ts` | handler `/brain` | Modification (ajout sous-commande) | Oui (sans argument = comportement inchange) |

### Breaking changes potentiels

Aucun breaking change identifie. Les ajouts sont tous backward-compatible :
- Les nouvelles fonctions sont de purs ajouts d'exports.
- La modification de `orchestrate()` est conditionnelle (feature flag off par defaut + `useBlackboard` requis).
- Le handler `/brain` sans argument conserve le comportement actuel (synthese LLM).

### Points d'attention pour le Reviewer

1. **Type compatibility WorkingMemory vs WorkingMemoryData** : L'orchestrateur lit le blackboard via `readSection()` qui retourne `WorkingMemory` (blackboard.ts, arrays required). `promoteWorkingMemory()` attend `WorkingMemoryData` (memory.ts, arrays optional). La compatibilite fonctionne car les types optionnels acceptent les required, mais le cast implicite merite une verification. Fichiers : `src/orchestrator.ts` (nouveau code post-pipeline), `src/blackboard.ts` L31-36, `src/memory.ts` L885-890.

2. **Queries `memory_links` dans memoryHealthStats()** : La spec prevoit de compter les liens semantiques via la table `memory_links`. Or cette table n'est actuellement jamais requetee directement via le client Supabase dans `memory.ts` -- toutes les operations passent par les RPCs (`link_memory`, `get_linked_memories`). Le Reviewer doit verifier que la query directe `supabase.from("memory_links").select("id", { count: "exact" })` fonctionne correctement avec les RLS policies (la policy "Allow all for authenticated" existe dans schema.sql L810-811). Fichier : `src/memory.ts` (nouvelle fonction `memoryHealthStats()`).

3. **Ajout de parsing sous-commande dans /brain** : Le handler `/brain` actuel (memory-cmds.ts L32-177) n'utilise pas `ctx.match` et va directement a la synthese LLM. L'ajout de `/brain health` necessite d'inserer un parsing de sous-commande au debut du handler. Le Reviewer doit verifier que `/brain` sans argument (cas nominal actuel) n'est pas casse par ce refactoring. Pattern de reference : le handler `/ideas` (meme fichier, L194-196) montre le pattern subcommand correct. Fichier : `src/commands/memory-cmds.ts`.

4. **Query `memory_archive` dans memoryHealthStats()** : La table `memory_archive` n'est actuellement referencee nulle part dans `src/` (seulement dans `db/schema.sql` et la RPC `archive_old_memories`). La spec prevoit un `archiveCount` via query directe. Verifier que la table existe et est accessible dans l'environnement Supabase actuel. Fichier : `src/memory.ts`, `db/schema.sql` L681-699.

5. **Performance Promise.all dans memoryHealthStats()** : La spec prevoit 5-6 queries en parallele (count par type, embedding coverage, importance moyen, age moyen, liens, archives, promotions recentes, top accessed). Le budget cible est < 2s. Le Reviewer doit verifier que les queries sont bien parallelisees et que les index existants (`idx_memory_archive_type`, `idx_memory_archive_archived_at`) couvrent les besoins. Fichier : `src/memory.ts`.

6. **Isolation try/catch dans l'orchestrateur** : La regle R9 impose que la promotion ne bloque jamais le pipeline. Le Reviewer doit verifier que le try/catch englobe bien l'integralite du bloc promotion (lecture blackboard + appel promoteWorkingMemory + onProgress) et non juste une partie. Fichier : `src/orchestrator.ts` (zone L1777-1779).

### Blast radius

- Modules directement modifies : 4 (orchestrator.ts, memory.ts, memory-cmds.ts, features.json)
- Modules indirectement impactes : 3 (auto-pipeline.ts, execution.ts, deliberation.ts)
- Fichiers source modifies : 4
- Fichiers de test a verifier : 2 (memory-evolution.test.ts, orchestrator.test.ts)
