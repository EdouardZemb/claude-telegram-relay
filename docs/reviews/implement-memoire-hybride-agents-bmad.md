# Rapport d'implémentation : SPEC-memoire-hybride-agents-bmad

**Date :** 2026-03-23
**Spec :** docs/specs/SPEC-memoire-hybride-agents-bmad.md (Rev.3)
**Review adversariale :** docs/reviews/adversarial-SPEC-memoire-hybride-agents-bmad.md
**Pipeline :** dev-implement (Test Architect → Implementer → Tester)
**Statut final :** DONE — 3399 pass, 0 fail (3405 tests au total, 6 skip pre-existants)

---

## 1. Résumé des modifications

### Fichiers modifiés (dans le scope spec section 5)

| Fichier | Nature | Lignes ajoutées |
|---------|--------|----------------|
| `src/memory.ts` | Fonctions agent_memory + injection MEMOIRE ROLE | +326 |
| `src/agent-context.ts` | Budgets de tokens, shares rééquilibrées, exports | +44 |
| `db/schema.sql` | Table agent_memory, RPC, index, trigger, RLS | +116 |
| `db/migrations/001_initial.sql` | Idem (synchronisation migration) | +116 |
| `config/features.json` | Ajout flag agent_role_memory: false | +1 |
| `tests/fixtures/mock-supabase.ts` | Méthode delete() + cas delete dans _execute() | +17 |

### Fichier créé

| Fichier | Nature | Tests |
|---------|--------|-------|
| `tests/generated/memoire-hybride-agents-bmad.test.ts` | Suite 62 tests V1-V20 | 62/62 pass |

---

## 2. Implémentation détaillée

### 2.1 Table agent_memory (db/schema.sql + db/migrations/001_initial.sql)

```sql
CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_role TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  importance_score NUMERIC(5,2) DEFAULT 50.0,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

RPC `get_agent_memories(p_role TEXT, p_limit INT DEFAULT 15)` : sélection par rôle, tri `importance_score DESC, created_at DESC`.

Note : FK vers `memory.id` (lien inter-mémoires) NON implémentée — déférée à V2 conformément à l'impératif 3 de la spec et aux findings F-DA-3/F-EC-1/F-SS-1 de la review adversariale.

### 2.2 ROLE_CANONICAL_TAGS (src/memory.ts)

Tags statiques par rôle, 8 rôles :

```typescript
export const ROLE_CANONICAL_TAGS: Record<string, string[]> = {
  analyst: ["analyse-metier", "exigence", "besoin-utilisateur", "risque"],
  pm: ["planification", "estimation", "priorite", "dependance"],
  architect: ["pattern-architectural", "decision-technique", "contrainte", "dette-technique"],
  dev: ["implementation", "fix", "refactoring", "api"],
  qa: ["pattern-bug", "regression", "cas-limite", "test-manquant"],
  sm: ["processus", "blocage", "retrospective", "velocite"],
  planner: ["decomposition", "estimation", "priorisation", "scope"],
  explorer: ["recherche", "benchmark", "etat-art", "alternative"],
};
```

Aucun appel LLM — tags purement statiques (conformément aux impératifs 7/8).

### 2.3 resolveAgentMemoryConflict (src/memory.ts)

Résolution binaire par comparaison exacte (normalisation : lowercase + trim + collapse whitespace) :

```typescript
function normalizeContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ");
}

export async function resolveAgentMemoryConflict(
  supabase: SupabaseClient,
  role: string,
  content: string
): Promise<AgentMemoryRecord | null>
```

Requête : `agent_memory.eq("agent_role", role)`, scan séquentiel sur `normalizeContent(row.content) === normalizeContent(content)`. Pas de recherche sémantique (Edge Function), conformément à l'impératif 1.

### 2.4 saveAgentMemory (src/memory.ts)

Séquence complète :
1. Validation du rôle via `Object.prototype.hasOwnProperty.call(ROLE_CANONICAL_TAGS, role)` (impératif 6)
2. Appel `resolveAgentMemoryConflict` — si doublon détecté, skip + log INFO
3. Comptage des entrées existantes — si ≥ 15, éviction de l'entrée `ORDER BY importance_score ASC LIMIT 1` + `DELETE` + `log.info` (impératif 4)
4. INSERT avec tags canoniques du rôle

Limite dure : `AGENT_MEMORY_HARD_LIMIT = 15`.

### 2.5 graduateAgentMemory (src/memory.ts)

Graduation SELECT-before-INSERT (impératif 2 — NO ON CONFLICT) :
1. Sélection de toutes les entrées `agent_memory` avec `normalizeContent(content) === normalizeContent(content)`
2. Déduplique les `agent_role` distincts
3. Si ≥ 2 rôles distincts → INSERT dans `memory` + UPDATE `metadata.graduated = true` sur les sources
4. Appel fire-and-forget depuis `promoteWorkingMemory` (`.catch(() => {})`)

### 2.6 promoteWorkingMemory (src/memory.ts)

Modifications derrière le flag `agent_role_memory` :
- Ajout de `agent_role: item.agent` dans le champ `metadata` lors de la promotion vers `memory`
- Appel `await saveAgentMemory(supabase, item.agent, item.content, ...)` (awaité — impératif V9)
- Appel `graduateAgentMemory(supabase, item.content).catch(() => {})` (fire-and-forget)

### 2.7 buildMemoryChains (src/memory.ts)

Modifications :
- Early return conditionnel : `if (facts.length === 0 && goals.length === 0 && !roleMemoryEnabled) return ""`
- Chargement conditionnel des liens : `allIds.length > 0 ? await getLinkedMemoriesBatch(...) : new Map()`
- Injection de section MEMOIRE ROLE en fin de chaîne si `roleMemoryEnabled` :

```
MEMOIRE ROLE ({role}):
- {content} [tags: tag1, tag2] (score: XX.X)
```

Format plat V1 — sans liens enrichis (déféré V2).

### 2.8 agent-context.ts

Budgets ajoutés :
```typescript
planner: 3000,
explorer: 3000,
```

Exports ajoutés :
```typescript
export const ROLE_MEMORY_SHARE = 0.10;
export const ROLE_MEMORY_SHARE_WITH_EXPLORATION = 0.08;
```

Shares rééquilibrées spec 6.5 :

| Section | Sans exploration | Avec exploration |
|---------|-----------------|-----------------|
| CONTEXTE MEMOIRE | 0.20 | 0.18 |
| RAPPORT EXPLORATION | — | 0.10 |
| SPRINT ACTUEL | 0.08 | 0.07 |
| TACHES RECENTES | 0.11 | 0.09 |
| GRAPHE CODE | 0.08 | 0.07 |
| CONFIANCE AGENTS | 0.06 | 0.05 |
| METRIQUES SPRINT | 0.08 | 0.06 |
| DOCUMENTS PROJET | 0.08 | 0.07 |
| PROFIL UTILISATEUR | 0.07 | 0.05 |
| TACHES SIMILAIRES | 0.08 | 0.06 |
| CONTEXTE CONVERSATION | 0.06 | 0.05 |
| **Total** | **1.00** | **0.93** |

---

## 3. Tests V1-V20

### Suite générée : tests/generated/memoire-hybride-agents-bmad.test.ts

| V-critère | Description | Résultat |
|-----------|-------------|---------|
| V1 | ROLE_CANONICAL_TAGS défini pour les 8 rôles | PASS |
| V2 | resolveAgentMemoryConflict — match exact (lowercase+trim) | PASS |
| V3 | resolveAgentMemoryConflict — pas de faux positif | PASS |
| V4 | buildMemoryChains injecte MEMOIRE ROLE si flag actif | PASS |
| V5 | buildMemoryChains ne contient pas MEMOIRE ROLE si flag inactif | PASS |
| V6 | saveAgentMemory — validation de rôle invalide | PASS |
| V7 | saveAgentMemory — insert valide avec tags canoniques | PASS |
| V8 | graduateAgentMemory — ≥2 rôles distincts → INSERT memory | PASS |
| V9 | promoteWorkingMemory — saveAgentMemory awaité (3 entrées) | PASS |
| V10 | graduateAgentMemory — <2 rôles → pas de graduation | PASS |
| V11 | getAgentMemories — délègue au RPC get_agent_memories | PASS |
| V12 | schema.sql contient CREATE TABLE agent_memory | PASS |
| V13 | RPC get_agent_memories trie par importance_score DESC | PASS |
| V14 | ROLE_MEMORY_SHARE = 0.10 exporté | PASS |
| V15 | ROLE_MEMORY_SHARE_WITH_EXPLORATION = 0.08 exporté | PASS |
| V16 | ROLE_TOKEN_BUDGETS contient planner:3000 et explorer:3000 | PASS |
| V17 | agent_role_memory flag existe et est false par défaut | PASS |
| V18 | buildMemoryChains sans facts/goals + flag actif → MEMOIRE ROLE | PASS |
| V19 | resolveAgentMemoryConflict normalise whitespace multiple | PASS |
| V20 | saveAgentMemory — éviction si ≥15 entrées + DELETE | PASS |

**Résultat : 62/62 tests PASS**

### Isolation des tests

Utilisation de `mock.module("../../src/feature-flags", ...)` avec variable de contrôle module-level `let agentRoleMemoryFlagValue = false` pour éviter les races entre fichiers de test parallèles (feature-flags.test.ts réécrit features.json pendant les runs parallèles).

---

## 4. Validation finale

### bun test (suite complète)

```
3399 pass
6 skip
0 fail
7782 expect() calls
Ran 3405 tests across 116 files. [~31s]
```

**Zéro régression** par rapport au HEAD pré-implémentation.

### Correction apportée pendant les tests

La session précédente avait inadvertamment mis `memory_promotion: true` dans `features.json`. Corrigé vers `false` pour maintenir la cohérence avec HEAD (commit `8b88475` a ajouté ce flag avec valeur `false`).

---

## 5. Conformité aux 8 points impératifs

| Point | Exigence | Status |
|-------|----------|--------|
| 1 | `resolveAgentMemoryConflict` : comparaison binaire exacte (pas sémantique) | CONFORME |
| 2 | Graduation SELECT-before-INSERT (pas ON CONFLICT sur content_hash inexistant) | CONFORME |
| 3 | Liens inter-mémoires déférés à V2 (FK non implémentée) | CONFORME |
| 4 | Limite dure 15 DELETE avec `log.info` | CONFORME |
| 5 | Validation du rôle dans `saveAgentMemory` via `hasOwnProperty(ROLE_CANONICAL_TAGS)` | CONFORME |
| 6 | Shares rééquilibrées spec 6.5 (sans/avec exploration, totaux 1.00/0.93) | CONFORME |
| 7 | `ROLE_CANONICAL_TAGS` avec les 8 rôles exacts | CONFORME |
| 8 | 20 V-critères V1-V20 testés et passants | CONFORME |

---

## 6. Findings adversariaux adressés

| Finding | Description | Résolution |
|---------|-------------|-----------|
| F-DA-1 (bloquant) | `content_hash` inexistant → ON CONFLICT invalide | Remplacé par SELECT-before-INSERT |
| F-DA-3/F-EC-1/F-SS-1 (bloquant) | FK vers memory.id non existante | Déférée V2, trigger auto-link retiré |
| F-DA-2 | Précision de "exact-match" | Binary lowercase/trim/whitespace collapse |
| F-EC-2 | Stratégie d'éviction sous limite | DELETE `importance_score ASC LIMIT 1` |
| F-EC-3 | Validation de rôle | `hasOwnProperty(ROLE_CANONICAL_TAGS)` + warn log |
| F-SS-2 | Budgets planner/explorer manquants | Ajout `planner: 3000, explorer: 3000` |

---

## 7. Hors scope identifié (non implémenté)

Conformément à la garde de scope (spec section 5) :

- **Trigger auto-link** : trigger SQL `auto_link_agent_to_global` référençant `memory.id` était dans un draft interne mais retiré car FK non créée (V2 scope). Si ce trigger est souhaité, il nécessite la création de la FK en V2.
- **Recherche sémantique dans resolveAgentMemoryConflict** : explicitement exclu (impératif 1). Une future V2 pourrait ajouter un fallback via Edge Function `match_agent_memories` si une recherche fuzzy est nécessaire.
- **Interface de visualisation `agent_memory`** : aucune commande Telegram `/brain agent-memory` n'a été ajoutée (hors scope spec).
