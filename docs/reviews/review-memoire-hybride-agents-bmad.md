# Revue : SPEC-memoire-hybride-agents-bmad

> Reviewer : Agent Reviewer
> Date : 2026-03-23
> Spec : docs/specs/SPEC-memoire-hybride-agents-bmad.md
> Rapport d'impact : docs/reviews/impact-SPEC-memoire-hybride-agents-bmad.md

## Fichiers examines

- `config/features.json`
- `db/migrations/001_initial.sql`
- `db/schema.sql`
- `src/agent-context.ts`
- `src/memory.ts`
- `tests/fixtures/mock-supabase.ts`
- `tests/generated/memoire-hybride-agents-bmad.test.ts`

---

## Problemes bloquants

Aucun.

---

## Avertissements

### [src/memory.ts:2061-2066] Metadata spread override : `graduated: false` peut etre ecrase par le caller

```typescript
metadata: {
  source: "working_memory_promotion",
  promotion_type: metadata.promotion_type ?? "decision",
  pipeline_session_id: metadata.pipeline_session_id ?? null,
  graduated: false,
  ...metadata,   // <- spread APRES les cles fixees — ecrase graduated si caller passe graduated:true
},
```

Le spread `...metadata` est applique APRES la cle `graduated: false`. Si un appelant externe passe `{ graduated: true }` dans les metadata, la valeur hardcodee est ecrasee. Le pattern securise serait de placer le spread EN PREMIER et de forcer les valeurs fixes APRES :

```typescript
metadata: {
  ...metadata,
  source: "working_memory_promotion",      // toujours forced
  graduated: false,                        // toujours forced a l'insertion
  promotion_type: metadata.promotion_type ?? "decision",
  pipeline_session_id: metadata.pipeline_session_id ?? null,
},
```

Impacte : V1, V2, comportement stable avec les appelants actuels (orchestrateur passe seulement `{ promotion_type, pipeline_session_id }`) mais fragile pour extensions futures.

### [db/schema.sql:1252-1256] Body du trigger `auto_embed_agent_memory` incompatible avec l'Edge Function `embed`

Le trigger envoie :
```json
{ "table": "agent_memory", "id": "...", "content": "..." }
```

Mais l'Edge Function `embed` (supabase/functions/embed/index.ts ligne 17) destructure :
```typescript
const { record, table } = await req.json();
```

Il n'y a pas de cle `record` dans le body envoy, donc `record?.content` sera `undefined` et la fonction retournera HTTP 400 "Missing record data". **Le trigger d'embedding est silencieusement inoperant.** Les embeddings `agent_memory` ne seront jamais generes via ce chemin.

Note d'attenuation : (1) le trigger est marque "V2: for future semantic search" dans le commentaire ; (2) l'exception est catchee (`EXCEPTION WHEN OTHERS THEN RETURN NEW`) donc l'insertion n'est pas bloquee ; (3) les V-criteres ne couvrent pas l'effectivite du trigger. Cependant la V2 echouera silencieusement sans correction.

Format correct pour le body (coherent avec le Supabase database webhook standard) :
```sql
body := jsonb_build_object(
  'table', 'agent_memory',
  'record', jsonb_build_object(
    'id', NEW.id::text,
    'content', NEW.content,
    'embedding', NEW.embedding
  )
)
```

### [tests/generated/memoire-hybride-agents-bmad.test.ts:900-926] V16 teste les valeurs de la spec, pas les valeurs reelles du code

Le test V16 ("sum of all shares <= 1.0") hard-code les valeurs de la spec 6.5 dans un tableau statique, mais ne lit pas les shares reels de `buildAgentContext()`. La MEMOIRE ROLE est incluse comme `0.10` dans le tableau du test avec le commentaire "(in CONTEXTE MEMOIRE budget)", ce qui est correct conceptuellement (la memoire role est injectee dans `buildMemoryChains()` puis compresse dans la section CONTEXTE MEMOIRE) mais cree une confusion : le test valide les valeurs de la spec, pas le code.

Consequence : si les shares sont modifies dans `agent-context.ts` sans mise a jour du test, V16 passera meme si la somme reelle depasse 1.0. Un test plus robuste lirait les shares depuis une invocation reelle de `buildAgentContext()` ou depuis une introspection des valeurs exportees.

Note : le test passe et valide la conformite spec 6.5. C'est un avertissement sur la robustesse du test, pas sur la correction.

---

## Suggestions

### [src/agent-context.ts] `ROLE_MEMORY_TAGS` absent — export mentionne dans l'impact report mais non implemente

Le rapport d'impact (section "API publiques modifiees") mentionne `ROLE_MEMORY_TAGS` comme un nouvel export de `src/agent-context.ts`. Cet export n'existe pas. La spec section 5 le liste explicitement : "ajouter constante `ROLE_MEMORY_SHARE`, `ROLE_MEMORY_TAGS`".

Les tags canoniques sont accessibles via `ROLE_CANONICAL_TAGS` exporte depuis `src/memory.ts`, ce qui satisfait fonctionnellement le besoin. Cependant l'export nomme `ROLE_MEMORY_TAGS` depuis `agent-context.ts` manque. Aucun V-critere ne le teste directement, donc ce n'est pas bloquant.

Si `ROLE_MEMORY_TAGS` est destine a etre un alias ou un re-export, l'ajouter dans `agent-context.ts` renforcerait la coherence de l'interface publique.

### [src/memory.ts:2025-2053] La verification de la limite (eviction) s'effectue apres `resolveConflict`

La sequence actuelle est : (1) resolveConflict (skip si doublon), (2) requete de count + eviction eventuelle, (3) insert. Si `resolveConflict` retourne "insert" alors qu'il y a 15 entrees (dont le nouveau contenu est distinct), la requete de count est redondante car elle cible le meme role avec les memes filtres que la requete de conflit. Deux requetes SELECT sur `agent_memory` pour le meme role. Optimisation possible : fusionner les deux SELECT. Non bloquant, l'optimisation releve d'une iteration future.

### [tests/generated/memoire-hybride-agents-bmad.test.ts:19-48] Mock `setFeature` ne modifie pas l'etat consulte par `loadFeatures`

Le mock de `feature-flags` expose `setFeature` qui modifie `agentRoleMemoryFlagValue` mais `loadFeatures` lit le fichier reel. Ceci est intentionnel et documente, mais signifie que les tests qui utilisent `setFeature` n'affectent que `isFeatureEnabled("agent_role_memory")`. Pour les autres flags, les tests lisent le fichier reel. Ce couplage au fichier reel est acceptable pour l'isolation du flag `agent_role_memory` mais fragile si d'autres flags changent pendant les tests.

---

## Verifications effectuees

### Conformite spec

| V-critere | Statut | Note |
|-----------|--------|------|
| V1 saveAgentMemory insert | PASS | 62 tests, 0 fail |
| V2 deduplication exact-match | PASS | |
| V3 getAgentMemories max 15 | PASS | |
| V4 buildMemoryChains section MEMOIRE ROLE | PASS | |
| V5 format plat en V1 (pas de liens) | PASS | |
| V6 section absente si flag=false | PASS | |
| V7 ROLE_MEMORY_SHARE in [0.08, 0.12] | PASS | 0.10 et 0.08 |
| V8 agent_role dans metadata | PASS | |
| V9 saveAgentMemory appele quand flag=true | PASS | |
| V10 graduation exact-match >= 2 roles | PASS | idempotent via SELECT-before-INSERT |
| V11 pas de double graduation | PASS | |
| V12 colonnes schema agent_memory | PASS | id UUID, agent_role NOT NULL, content NOT NULL, tags TEXT[], importance_score NUMERIC, embedding VECTOR(1536), metadata JSONB |
| V13 RPC get_agent_memories filtre par role | PASS | |
| V14 flag agent_role_memory = false par defaut | PASS | config/features.json confirme |
| V15 buildAgentContext(null) = "" | PASS | |
| V16 somme shares <= 1.0 | PASS (avec reserve) | Test valide les valeurs de la spec, pas les valeurs live du code — voir avertissement |
| V17 ROLE_CANONICAL_TAGS 8 roles | PASS | |
| V18 saveAgentMemory appele par orchestrateur | PASS | via promoteWorkingMemory sous feature flag |
| V19 role invalide : warn + return 0 | PASS | |
| V20 eviction au hard limit 15 | PASS | |

### TypeScript

Le projet ne dispose pas de tsconfig.json a la racine (runtime Bun natif). La verification de type s'effectue via la suite de tests. Les imports sont coherents, aucun `any` non justifie identifie dans les nouvelles fonctions.

### Tests

- Suite complete : **3399 pass, 0 fail, 6 skip** (`bun test tests/`)
- Tests specifiques : **62 pass, 0 fail** (`bun test tests/generated/memoire-hybride-agents-bmad.test.ts`)
- Regression pre-existante (memory_promotion) : **resolue** — `config/features.json` a `memory_promotion: false`, tests orchestrator et memory-evolution passent.

### Pas d'import circulaire

`src/memory.ts` importe `isFeatureEnabled` depuis `src/feature-flags.ts`. `src/feature-flags.ts` n'importe que `fs` et `path`. Aucun cycle.

### Backward compatibility

Les fonctions modifiees (`promoteWorkingMemory`, `buildMemoryChains`, `buildAgentContext`) ont des signatures inchangees. Les nouveaux comportements sont conditionnels au feature flag `agent_role_memory = false` (inactif par defaut). Zero regression sur le comportement existant.

### Schema SQL

- Table `agent_memory` : colonnes conformes au V12, index corrects, RLS "Allow all for authenticated" coherent avec la table `memory`.
- RPC `get_agent_memories` : filtre `agent_role = p_role`, ordre `importance_score DESC, created_at DESC`, limite `p_limit`. Conforme V13.
- Trigger `agent_memory_updated_at` : correct.
- Trigger embed `agent_memory_auto_embed` : present mais body incompatible avec l'Edge Function (voir avertissement).
- `db/migrations/001_initial.sql` et `db/schema.sql` sont synchronises (seule difference : extensions commentees dans migrations).

---

## Score : 84/100

Deduction : -8 incompatibilite trigger embed (avertissement architectural, silencieusement inoperant), -5 fragilite metadata spread (risque de regression future), -3 test V16 non intrinseque (valide la spec pas le code). Base : 100.

Implementation solide et additive. Feature flag inactif par defaut garantit zero regression. Tous les 20 V-criteres sont couverts par les tests. Les deux bloquants potentiels signales par le rapport d'impact (depassement budget shares, race condition graduation) sont correctement resolus dans l'implementation.
