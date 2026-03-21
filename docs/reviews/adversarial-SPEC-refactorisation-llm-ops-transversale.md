# Adversarial Review — SPEC-refactorisation-llm-ops-transversale

> Date : 2026-03-21
> Source : docs/specs/SPEC-refactorisation-llm-ops-transversale.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic

## Synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|-----------------|------------------|-------------------|-------|
| BLOQUANT | 1 | 0 | 0 | 1 |
| MAJEUR   | 3 | 4 | 3 | 10 |
| MINEUR   | 2 | 2 | 3 | 7 |
| **Total** | **6** | **6** | **6** | **18** |

## Verdict : GO WITH CHANGES

**Justification** : 1 BLOQUANT resolvable (dependance circulaire via `AgentRole` type — corrigeable en extrayant le type ou en utilisant `type-only` imports) + 10 MAJEURS. La spec est solide dans sa structure et sa couverture, mais le probleme de dependance circulaire doit etre resolu avant implementation, et plusieurs scenarios d'erreur meritent une couverture explicite.

---

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — Dependance circulaire cachee via AgentRole type**
- Source : Section 7 (Contraintes) / Regle R2
- Description : R2 affirme que `llm-ops.ts` n'importe PAS depuis `orchestrator.ts` pour eviter les dependances circulaires. Or, la spec dit que `llm-ops.ts` importe depuis `feedback-loop.ts` et `agent-events.ts`. Verification du codebase :
  - `feedback-loop.ts` ligne 18 : `import type { AgentRole } from "./orchestrator.ts"`
  - `agent-events.ts` ligne 8 : `import type { AgentRole } from "./orchestrator.ts"`
  - L'API publique de `llm-ops.ts` (Section 4.4) utilise `AgentRole` comme parametre dans `buildSpanId()`, `getCircuitBreakerStatus()`, `shouldDowngradePipeline()`, `logCostWithSpan()`, `recordPromptVersion()`
  - Si `llm-ops.ts` importe `AgentRole` depuis `orchestrator.ts` (directement ou via re-export), et que `orchestrator.ts` importe `logCostWithSpan` depuis `llm-ops.ts`, il y a dependance circulaire : `orchestrator.ts` -> `llm-ops.ts` -> `orchestrator.ts`
- Impact : Casse potentielle a l'import en runtime (Bun gere les cycles de type-only mais pas les cycles de valeur). Rend R2 non respectee en l'etat.
- Evidence : `src/feedback-loop.ts:18`, `src/agent-events.ts:8`, `src/orchestrator.ts:140` (`export type AgentRole`)
- Resolution : Extraire `AgentRole` dans un fichier partage (`src/types.ts` ou `src/agent-types.ts`) ou utiliser exclusivement `string` au lieu d'`AgentRole` dans l'API de `llm-ops.ts`. Le BLOQUANT est resolvable sans remettre en cause l'architecture.

**[MAJEUR] F-DA-2 — La spec dit 14+ appelants de logCost mais le codebase n'en a que 2**
- Source : Section 7 (Contraintes) — "14+ appelants existants"
- Description : La contrainte affirme que `logCost()` a "14+ appelants existants". Verification codebase : seul `src/orchestrator.ts` importe et appelle `logCost()` (2 appels aux lignes 1050 et 1193). Il n'y a aucun autre import de `logCost` dans le codebase (`grep import.*logCost` ne retourne que `orchestrator.ts`).
- Impact : L'hypothese de backward compatibility stricte est sur-dimensionnee. La contrainte est valide en intention mais le nombre est faux. Cela peut conduire a une sur-prudence inutile lors de l'implementation.
- Evidence : `grep -rn "import.*logCost" src/` → seul `src/orchestrator.ts:44`

**[MAJEUR] F-DA-3 — Spec cite des lignes de code inexactes pour le heartbeat**
- Source : Section 6.2 (Pattern tache periodique) — "lignes 497-580"
- Description : La spec cite les "lignes 497-580" de `heartbeat.ts` pour le pattern de tache periodique. Le heartbeat actuel fait 597 lignes. Les taches periodiques commencent effectivement autour de la ligne 480 (morning digest) et les alert checks sont aux lignes 497-521. L'approximation est acceptable mais la reference exacte pour le pattern de reproduction (alert check) est correcte.
- Impact : Faible — les lignes sont approximativement correctes. Mais si le heartbeat est modifie entre la spec et l'implementation, les references seront perimees.

**[MAJEUR] F-DA-4 — R9 (query directe temps-reel) vs contrainte performance < 2s**
- Source : Regle R9 / Section 7 (Performance /monitor)
- Description : R9 affirme que `getLlmOpsSnapshot()` est une "agregation temps-reel (query Supabase directe)" et la contrainte de performance dit "max 4 queries Supabase en parallele, latence cible < 2s". Or, le snapshot inclut `promptVersions` (nouvelle table), `costSummary` (aggregation sur `cost_tracking` potentiellement volumineuse), `trustScores` (cache in-memory — pas de query), `recentGateEvaluations` (query limitee), et `circuitBreakers` (cache in-memory — pas de query). En realite, seules 2-3 queries Supabase sont necessaires, pas 4. Par contre, la query `cost_tracking` sans filtre de sprint pourrait etre lente sur une table volumineuse — la spec ne precise pas de filtre temporel.
- Impact : Risque de depassement de la latence cible si `cost_tracking` grossit. La spec devrait preciser un filtre (dernier sprint ou derniere semaine) pour `costSummary`.

**[MINEUR] F-DA-5 — combined_hash redondant avec la contrainte UNIQUE**
- Source : Section 4.1 (Table prompt_versions), Regle R3
- Description : La colonne `combined_hash` est definie comme `template_hash + feedback_hash` avec un `UNIQUE (agent_role, combined_hash)`. Mais `combined_hash` est une simple concatenation — si `template_hash = "abc"` et `feedback_hash = "def"`, `combined_hash = "abcdef"`. Il n'y a pas de separateur, ce qui cree un risque theorique de collision : `template_hash = "ab"`, `feedback_hash = "cdef"` donnerait le meme `combined_hash`. En pratique, avec des SHA256 de 64 chars, c'est impossible.
- Impact : Negligeable en pratique (SHA256 hex = 64 chars fixes), mais la spec devrait preciser le format du combined_hash (concatenation avec separateur, ex: `${template_hash}:${feedback_hash}`).

**[MINEUR] F-DA-6 — Pas de strategie de rollback pour la migration**
- Source : Section 5 (Fichiers concernes) — migration SQL
- Description : La migration ajoute une table et des colonnes, mais aucune migration de rollback n'est prevue. Si la migration echoue a mi-chemin (table creee mais colonnes non ajoutees), l'etat de la base sera inconsistant.
- Impact : Faible — les `IF NOT EXISTS` rendent la migration idempotente. Mais un script de rollback serait une bonne pratique.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[MAJEUR] F-EC-1 — Absence de gestion du cas Supabase null dans recordPromptVersion**
- Scenario : `buildAgentSystemPromptPart()` appelle `recordPromptVersion()` mais ne passe pas forcement un `SupabaseClient`. La signature accepte `supabase: SupabaseClient | null` mais la spec ne precise pas le comportement quand supabase est null.
- Source : Regle R11, Section 4.4 (API publique)
- Impact : Si `supabase` est null (mode local/dev), l'appel silencieux est attendu (fire-and-forget). Mais `buildAgentSystemPromptPart()` dans `bmad-prompts.ts` (ligne 104) ne recoit PAS de `SupabaseClient` en parametre — c'est une fonction pure qui ne prend que `(agentId, context)`. Pour appeler `recordPromptVersion(supabase, ...)`, il faudrait modifier la signature de `buildAgentSystemPromptPart` ou passer le supabase client dans le contexte. La spec ne mentionne pas cette modification.
- Frequence estimee : Systematique — se produira a chaque appel.

**[MAJEUR] F-EC-2 — Race condition sur le heartbeat state lastLlmOpsCheckAt**
- Scenario : Le heartbeat sauvegarde le state une seule fois a la fin de `pulse()` (ligne 583). Si `runLlmOpsCheck()` est lance mais le heartbeat crashe avant `saveState()`, le check ne sera pas marque comme execute et sera relance au prochain pulse (duplication). Plus critique : si deux instances de heartbeat tournent en parallele (restart PM2), elles pourraient lire le meme state et lancer deux checks simultanement.
- Source : Section 6.2 (Pattern heartbeat), Regle R7
- Impact : Notifications dupliquees. Les notifications de circuit-breaker ouvert seraient envoyees deux fois.
- Frequence estimee : Rare (crash pendant le check), mais possible lors de restarts PM2.

**[MAJEUR] F-EC-3 — getCircuitBreakerStatus avec un role inconnu retourne un faux negatif**
- Scenario : `getCircuitBreakerStatus(role)` interroge `getCachedTrustScore(role)`. Si le role n'est pas dans le cache, `getCachedTrustScore()` retourne un `makeDefaultTrustScore(role)` avec `score: 50` et `consecutiveFailures: 0`. Le circuit-breaker retournera `{ open: false }` pour un role qui n'a jamais ete evalue — ce qui est correct logiquement, mais masque l'absence de donnees.
- Source : Regle R5, R6
- Impact : Pas de faux positifs (pas de downgrade intempestif), mais aucun moyen de distinguer "role sain" de "role jamais evalue". Le `LlmOpsSnapshot` affichera des circuit-breakers "fermes" pour des roles sans aucune donnee.
- Frequence estimee : Occasionnel — lors de l'ajout de nouveaux roles ou au premier deploiement.

**[MAJEUR] F-EC-4 — logCostWithSpan ne gere pas le cas ou logCost echoue**
- Scenario : `logCostWithSpan()` est decrite comme appelant `logCost()` enrichi de `span_id` et `session_id`. Si l'insert Supabase echoue (contrainte FK sur `task_id`, disque plein, timeout), l'erreur est loguee mais le span est perdu. Il n'y a pas de fallback in-memory comme dans `agent-events.ts`.
- Source : Regle R8, Section 6.5 (Pattern fire-and-forget)
- Impact : Perte de donnees de cout silencieuse. Contrairement a `emitAgentEvent()` qui a un fallback in-memory, `logCost()` n'en a pas.
- Frequence estimee : Rare — mais en cas de probleme Supabase, tous les couts d'une session seront perdus.

**[MINEUR] F-EC-5 — Table prompt_versions sans purge et sans index temporel**
- Scenario : La spec dit "< 100 lignes" et "pas de purge necessaire". Si les templates YAML ou les feedback rules changent frequemment (ex: a chaque retro), le nombre de lignes croit lineairement. Avec 8 roles et des changements bi-hebdomadaires, ca donne ~800 lignes/an. Pas critique, mais il n'y a pas d'index sur `created_at` pour les queries temporelles.
- Source : Section 4.1, Zone d'ombre 3
- Impact : Queries `getActivePromptVersion()` sans index temporel. La spec ne precise pas si "active" = "derniere version" par role, ce qui necessite un `ORDER BY created_at DESC LIMIT 1`.
- Frequence estimee : Negligeable a court terme, potentiel a long terme.

**[MINEUR] F-EC-6 — buildSpanId avec des caracteres speciaux dans sessionId**
- Scenario : Le `pipelineSessionId` est genere comme `pr-${task.id}-${Date.now()}` (orchestrator.ts ligne 605). Si `task.id` contient des caracteres inattendus (UUID standard, donc safe), le span_id reste valide. Mais si le format evolue ou si un session_id externe est passe (via `--resume`), le span_id pourrait contenir des caracteres problematiques pour des queries ou des index.
- Source : Regle R4
- Impact : Faible — les UUID et timestamps sont safe. Mais aucune validation du format d'entree.
- Frequence estimee : Tres rare.

### Statistiques
- Bloquants : 0
- Majeurs : 4
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — shouldDowngradePipeline est une abstraction prematuree**
- Source : Section 4.4 (API publique), Regle R5
- Description : `shouldDowngradePipeline(role, currentPipeline)` est une fonction distincte de `getCircuitBreakerStatus()` qui ajoute une couche de decision. Dans la spec, le circuit-breaker est "non-bloquant" (R5) et "la decision reste au code appelant (orchestrator)". Alors pourquoi `llm-ops.ts` inclut une fonction qui prend la decision de downgrade ? L'orchestrateur devrait utiliser `getCircuitBreakerStatus()` et decider lui-meme, comme R5 le stipule. `shouldDowngradePipeline` est du scope creep par rapport au role "facade de lecture" de R1.
- Alternative : Supprimer `shouldDowngradePipeline` et laisser l'orchestrateur interpreter `CircuitBreakerStatus.suggestedDowngrade`. Le mapping pipeline -> downgrade pipeline est une logique metier qui appartient a l'orchestrateur.
- Codebase : L'orchestrateur gere deja la selection de pipeline via `pipeline-selection.ts`. Ajouter une source de decision dans `llm-ops.ts` cree une ambiguite.

**[MAJEUR] F-SS-2 — recordPromptVersion ajoute de la complexite dans le hot path du prompt building**
- Source : Regle R3, R11, Section 6.5
- Description : `recordPromptVersion()` est appele dans `buildAgentSystemPromptPart()` a chaque construction de prompt agent. Meme en fire-and-forget, cela ajoute : un hash SHA256 du template YAML, un hash SHA256 des feedback rules, et un upsert Supabase. Le template YAML est deja cache dans `agentCache` (bmad-prompts.ts ligne 68), donc le hash sera identique a chaque appel pour le meme role — l'upsert sera un no-op repetitif.
- Alternative : Appeler `recordPromptVersion()` uniquement au demarrage du bot (dans `relay.ts`) ou au rechargement du cache YAML, pas a chaque prompt build. Cela reduirait les appels de ~100/jour a ~1/deploy.
- Codebase : `agentCache` dans `bmad-prompts.ts` est un cache statique — le YAML ne change pas en runtime.

**[MAJEUR] F-SS-3 — LlmOpsSnapshot inclut des donnees deja accessibles individuellement**
- Source : Section 4.5 (Types exportes), Regle R1, R9
- Description : `LlmOpsSnapshot` agregue `trustScores` (deja dans `formatTrustScores()`), `recentGateEvaluations` (deja dans `formatRecentGateEvaluations()`), et `circuitBreakers` (derive des trust scores). Le `/monitor` existant appelle deja ces fonctions individuellement. La valeur ajoutee de `getLlmOpsSnapshot()` est limitee : c'est un wrapper autour de fonctions deja accessibles, avec en plus `promptVersions` et `costSummary` qui sont les seuls champs nouveaux.
- Alternative : Ajouter uniquement `getPromptVersions()` et `getCostSummaryBySession()` comme fonctions independantes, et les appeler dans `/monitor` a cote des fonctions existantes. Pas besoin d'un objet monolithique.
- Codebase : `src/commands/help.ts` lignes 186-250 — le `/monitor` agrege deja via `Promise.all` sans objet intermediaire.

**[MINEUR] F-SS-4 — Deux fonctions d'index pour cost_tracking (span_id + session_id)**
- Source : Section 4.2 (Colonnes ajoutees a cost_tracking)
- Description : Deux index sont crees : `idx_cost_tracking_session` et `idx_cost_tracking_span`. La table a deja 4 index. Le `span_id` est derive du `session_id` (format `${session_id}:${role}:${step}`), donc un index sur `session_id` suffit pour les queries par session, et un `LIKE` ou prefix match couvrirait les spans.
- Alternative : Un seul index sur `session_id` suffit pour la V1. L'index sur `span_id` peut etre ajoute si une query par span specifique se revele necessaire.
- Codebase : La spec ne decrit aucune query qui utiliserait `idx_cost_tracking_span` directement.

**[MINEUR] F-SS-5 — Le circuit-breaker reinvente la logique d'autonomie existante**
- Source : Regle R5, R6, Section 6.3
- Description : `getCircuitBreakerStatus()` verifie `trust_score < 30` et `consecutiveFailures >= 3`. La fonction `getAutonomyLevel()` dans `trust-scores.ts` (ligne 217-233) retourne deja "strict" quand le score est < 40. Le `CONSECUTIVE_FAIL_THRESHOLD = 3` est deja utilise dans `updateTrustScore()` pour l'acceleration de degradation. Le circuit-breaker est essentiellement un repackaging des seuils existants sous un nouveau nom.
- Alternative : Ajouter un champ `circuitBreakerOpen` au retour de `getAutonomyLevel()` serait plus simple et reutiliserait la logique existante.
- Codebase : `src/trust-scores.ts` lignes 35 (`CONSECUTIVE_FAIL_THRESHOLD = 3`) et 217-233 (`getAutonomyLevel`).

**[MINEUR] F-SS-6 — 22 V-criteres pour un module de ~200 lignes**
- Source : Section 8 (Criteres de validation)
- Description : 22 criteres de validation pour un module facade qui orchestre des appels existants. C'est un ratio elevee (1 critere pour ~10 lignes de code). Plusieurs criteres testent le meme concept sous des angles quasi-identiques (V2/V3/V4 testent les trois etats du circuit-breaker, V13/V14/V15 testent les trois conditions du heartbeat gate).
- Alternative : Regrouper les criteres par fonctionnalite (ex: "V2-4: circuit-breaker retourne le bon statut selon trust score et failures") reduirait a ~12-15 criteres sans perte de couverture.
- Codebase : Les tests existants dans `tests/` suivent un style plus compact avec des describe/it groupes.

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 3

---

## Findings croises (dedupliques)

Les findings suivants ont ete identifies par plusieurs agents :

| Finding | Agents | Severite retenue |
|---------|--------|-----------------|
| Dependance circulaire AgentRole | DA-1 | BLOQUANT |
| Circuit-breaker comme repackaging des seuils existants | DA-4 (performance), SS-5 (complexite) | MAJEUR |
| recordPromptVersion dans buildAgentSystemPromptPart sans acces Supabase | EC-1, SS-2 | MAJEUR |

---

## Recommandations

### Pour passer a GO :

1. **[BLOQUANT] Resoudre la dependance circulaire AgentRole** (F-DA-1)
   - Option A : Extraire `AgentRole` dans `src/agent-types.ts` et faire que tous les modules importent depuis ce fichier
   - Option B : Utiliser `string` au lieu de `AgentRole` dans l'API publique de `llm-ops.ts`
   - Option C : Utiliser `import type` depuis `orchestrator.ts` (Bun/TS resout les type-only imports sans cycle runtime) — verifier que c'est suffisant

2. **[MAJEUR] Preciser comment recordPromptVersion recoit le SupabaseClient** (F-EC-1, F-SS-2)
   - `buildAgentSystemPromptPart()` ne recoit pas de `supabase` — il faut soit modifier sa signature, soit appeler `recordPromptVersion` depuis l'appelant (orchestrator/agent-context), soit le faire au startup

3. **[MAJEUR] Ajouter un filtre temporel a costSummary dans getLlmOpsSnapshot** (F-DA-4)
   - Filtrer `cost_tracking` sur le sprint courant ou les 7 derniers jours pour eviter des queries lentes

4. **[MAJEUR] Envisager de supprimer shouldDowngradePipeline** (F-SS-1)
   - Laisser l'orchestrateur interpreter `CircuitBreakerStatus` directement, conformement a R5

5. **[MAJEUR] Corriger le nombre d'appelants logCost** (F-DA-2)
   - Remplacer "14+" par "2 appels dans orchestrator.ts" dans la contrainte

### Optionnelles (MINEUR) :

6. Ajouter un separateur dans `combined_hash` (F-DA-5)
7. Ajouter un index `created_at` sur `prompt_versions` (F-EC-5)
8. Envisager un seul index `session_id` sur `cost_tracking` en V1 (F-SS-4)

---

## Points forts identifies

1. **Architecture facade bien pensee** : le principe de ne pas dupliquer la logique et d'orchestrer les modules existants est correct et coherent avec le codebase.
2. **Backward compatibility explicite** : la decision de rendre `span_id`/`session_id` optionnels dans `CostEntry` et d'utiliser `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` est robuste.
3. **Feature flag pour activation progressive** : le gating sur `llmops_monitoring` avec activation manuelle post-validation est une bonne pratique.
4. **Patterns bien documentes** : la section 6 reference les patterns exacts du codebase avec numeros de ligne, ce qui facilite l'implementation.
5. **Couverture V-criteres exhaustive** : meme si le nombre est eleve (F-SS-6), chaque fonction publique est couverte par au moins un test.
6. **Zones d'ombre documentees honnêtement** : la section 9 identifie explicitement les incertitudes (seuils, frequence, volume).

---

## Etape suivante

**Verdict : GO WITH CHANGES**

Mettre a jour `docs/specs/SPEC-refactorisation-llm-ops-transversale.md` pour resoudre les findings, puis :

```
/dev-implement "Implementer SPEC-refactorisation-llm-ops-transversale. Spec: docs/specs/SPEC-refactorisation-llm-ops-transversale.md"
```
