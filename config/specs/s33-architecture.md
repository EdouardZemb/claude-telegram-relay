# S33 Architecture — Architecture Multi-Agent : Fondations

## 1. Decouverte cle

Les agents spawnes par `spawnClaude()` heritent DEJA de `.mcp.json` quand `cwd` est le repertoire projet (defaut). Le flag CLI `--mcp-config <path|json>` existe pour les spawns en worktree.

Consequence : l'axe 1 (MCP dynamique) est plus simple que prevu. Le vrai travail est d'instruire les agents a UTILISER les outils MCP et de gerer le cas worktree.

## 2. Vue d'ensemble des composants

```
                    +------------------+
                    |   orchestrator   |
                    |   orchestrate()  |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
        runAgentStep   runAgentStep   runAgentStep
        (analyst)      (architect)    (dev)
              |              |              |
        spawnClaude    spawnClaude    spawnClaude
              |              |              |
        [MCP inherited from .mcp.json]     |
              |              |              |
        memory-server  memory-server  memory-server
        (9 outils)     (9 outils)    (9 outils)
              |              |              |
              +--------------+--------------+
                             |
                      +------+------+
                      |  Supabase   |
                      | (REST/RPC)  |
                      +-------------+

        +------------------+
        |  pipeline_runs   |  <-- NOUVEAU (checkpoint/resume)
        +------------------+

        +------------------+
        |  intent-detect   |  <-- NOUVEAU (spike, feature flag)
        +------------------+
```

## 3. Axe 1+3 : MCP Dynamique + Blackboard Temps Reel

### 3.1 Probleme

Les agents ont acces aux outils MCP (heritage .mcp.json) mais ne savent pas qu'ils doivent les utiliser. Il faut :
- Injecter des instructions MCP dans les prompts agents
- Gerer le cas worktree (cwd != projet)
- Passer le session_id du blackboard pour que les agents puissent lire/ecrire

### 3.2 Composants impactes

| Fichier | Changement | Risque |
|---------|-----------|--------|
| `src/agent.ts` | Ajouter `mcpConfig?: string` a SpawnClaudeOptions, passer `--mcp-config` si present | Faible |
| `src/orchestrator.ts` | Passer mcpConfig en worktree, injecter blackboard session_id dans le prompt | Moyen |
| `src/bmad-prompts.ts` | Ajouter section "OUTILS MCP DISPONIBLES" dans le prompt systeme des agents | Faible |
| `src/bmad-agents.ts` | Ajouter `mcpTools?: string[]` par agent (quels outils sont pertinents par role) | Faible |

### 3.3 Design detaille

#### SpawnClaudeOptions (agent.ts)

```typescript
export interface SpawnClaudeOptions {
  // ... existant ...
  mcpConfig?: string;  // chemin fichier ou JSON inline pour --mcp-config
}
```

Dans `spawnClaude()`, apres les flags existants :
```typescript
if (options.mcpConfig) {
  args.push("--mcp-config", options.mcpConfig);
}
```

#### MCP Tools par role (bmad-agents.ts)

```typescript
// Ajout a BmadAgent
mcpTools?: string[];

// Exemple :
// analyst: ["search_thoughts", "get_project_context"]
// architect: ["search_thoughts", "get_project_context", "read_blackboard"]
// dev: ["search_thoughts", "get_tasks", "read_blackboard", "write_blackboard"]
// qa: ["search_thoughts", "get_tasks", "read_blackboard", "write_blackboard"]
// pm: ["search_thoughts", "get_tasks", "get_sprint_summary"]
// sm: ["get_sprint_summary", "thought_stats"]
```

#### Instructions MCP dans les prompts (bmad-prompts.ts)

Nouvelle section injectee dans `buildAgentSystemPromptPart()` :
```
--- OUTILS MCP DISPONIBLES ---
Tu as acces aux outils MCP suivants pendant ton execution :
- search_thoughts : Recherche semantique dans la memoire du projet
- get_tasks : Liste des taches (filtrer par status, projet, sprint)
- read_blackboard : Lire les sections du blackboard (spec, plan, tasks, implementation, verification)
- write_blackboard : Ecrire dans ta section du blackboard

Session blackboard : <session_id>
Tu es autorise a ecrire dans la section : <section_name>

IMPORTANT : Utilise ces outils pour enrichir ta comprehension du projet avant de produire ton output.
```

#### Worktree (agent.ts / orchestrator.ts)

Quand `useWorktree: true` ou `cwd` != PROJECT_DIR :
```typescript
const mcpConfigPath = path.join(PROJECT_DIR, ".mcp.json");
// Passer en --mcp-config pour que l'agent ait acces au MCP depuis le worktree
```

### 3.4 Flux d'execution (orchestrate avec blackboard)

1. `orchestrate()` cree le blackboard (existant)
2. Pour chaque `runAgentStep()` :
   a. Construire le prompt avec instructions MCP + session_id blackboard
   b. Si worktree : passer `--mcp-config` avec chemin absolu vers `.mcp.json`
   c. L'agent s'execute, peut appeler `read_blackboard` / `write_blackboard` via MCP
   d. Apres execution : ecriture orchestrator-side dans le blackboard (existant, garde comme fallback)
3. Gate evaluation (existant)

### 3.5 Risques

- **Double ecriture blackboard** : L'agent ecrit via MCP ET l'orchestrator ecrit apres. Solution : l'orchestrator verifie si la section est deja remplie avant d'ecrire (skip si version > attendue).
- **Conflit de version** : `writeSectionWithRetry()` gere deja le locking optimiste (3 retries).
- **Agent qui n'utilise pas les outils** : Pas bloquant, l'orchestrator ecrit en fallback comme avant.

## 4. Axe 2 : Checkpoint / Resume de Pipeline

### 4.1 Probleme

Si un pipeline echoue a l'etape 3/5, on repart de zero. Avec des couts d'agents Opus ($2/spawn), c'est du gaspillage.

### 4.2 Composants impactes

| Fichier | Changement | Risque |
|---------|-----------|--------|
| `db/schema.sql` | Nouvelle table `pipeline_runs` | Faible |
| `src/orchestrator.ts` | Sauvegarder l'etat a chaque etape, ajouter logique de resume | Moyen |
| `src/commands/execution.ts` | Parser flag `--resume` sur `/orchestrate` | Faible |

### 4.3 Schema pipeline_runs

```sql
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  session_id TEXT NOT NULL,           -- lien vers blackboard
  pipeline_type TEXT NOT NULL,        -- DEFAULT, QUICK, REVIEW
  status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed, resumed
  current_step TEXT,                  -- role en cours d'execution
  steps_completed JSONB DEFAULT '[]', -- [{role, output, duration_ms, cost, timestamp}]
  steps_remaining TEXT[] DEFAULT '{}', -- roles restants
  error_message TEXT,                 -- si failed, le message d'erreur
  blackboard_id UUID,                -- ref vers blackboard
  options JSONB DEFAULT '{}',        -- options originales (parallel, useBlackboard, etc.)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pipeline_runs_task ON pipeline_runs(task_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
```

### 4.4 Flux

#### Execution normale

```
orchestrate(task, options)
  1. Creer pipeline_run en base (status: running)
  2. Pour chaque agent :
     a. Mettre a jour current_step
     b. Executer runAgentStep()
     c. Sauvegarder resultat dans steps_completed
     d. Mettre a jour steps_remaining
  3. Marquer status: completed (ou failed si erreur)
```

#### Resume apres echec

```
orchestrate(task, { resume: true })
  1. Charger dernier pipeline_run pour cette tache (status: failed)
  2. Si absent : erreur "Aucun pipeline a reprendre"
  3. Si complete : erreur "Pipeline deja termine"
  4. Restaurer steps_completed comme previousMessages
  5. Reprendre a partir de steps_remaining[0]
  6. Marquer ancien run comme "resumed", creer nouveau run
```

### 4.5 Integration avec /orchestrate

```
/orchestrate <id> [pipeline] [--resume] [--blackboard] [--parallel]
```

Dans `commands/execution.ts`, parser `--resume` et passer `{ resume: true }` a `orchestrate()`.

### 4.6 Risques

- **Etat stale** : Le code a pu changer entre l'echec et le resume. Mitigation : log un warning si le commit HEAD a change.
- **Blackboard desynchronise** : Si le blackboard est supprime, on en recree un nouveau et on log un warning.

## 5. Axe 4 : Intent Detection (Spike)

### 5.1 Probleme

Les utilisateurs doivent connaitre les commandes slash pour interagir. Un message naturel comme "montre moi le backlog" devrait router vers `/backlog` automatiquement.

### 5.2 Composants impactes

| Fichier | Changement | Risque |
|---------|-----------|--------|
| `src/intent-detection.ts` | NOUVEAU — detection d'intent + routage | Faible (spike) |
| `src/commands/zz-messages.ts` | Hook d'intent detection avant le traitement standard | Faible |
| `config/features.json` | Nouveau flag `intent_detection` | Faible |

### 5.3 Design

#### Approche : Pattern matching + LLM fallback

Deux niveaux de detection :

**Niveau 1 : Patterns statiques (zero cout)**
```typescript
const INTENT_PATTERNS: Array<{
  intent: string;
  command: string;
  patterns: RegExp[];
  confidence: number;  // toujours 0.95 pour les patterns
}> = [
  {
    intent: "view_backlog",
    command: "/backlog",
    patterns: [/backlog/i, /taches?\s*(en\s+)?attente/i, /quoi\s+dans\s+le\s+backlog/i],
    confidence: 0.95,
  },
  {
    intent: "view_sprint",
    command: "/sprint",
    patterns: [/sprint\s+(en\s+)?cours/i, /avancement/i, /progression/i],
    confidence: 0.95,
  },
  {
    intent: "create_task",
    command: "/task",
    patterns: [/cree?\s+(une?\s+)?tache/i, /nouvelle?\s+tache/i, /ajoute?\s+.*tache/i],
    confidence: 0.90,
  },
  // ... 10-15 patterns pour les commandes les plus courantes
];
```

**Niveau 2 : Classification LLM (fallback si aucun pattern match)**
Reutiliser `classifyMessage()` (Edge Function `classify-thought`) en ajoutant un champ `intent` dans la reponse. Cout : ~$0.001/message (GPT-4o-mini).

#### Interface

```typescript
export interface DetectedIntent {
  intent: string;       // ex: "view_backlog"
  command: string;      // ex: "/backlog"
  confidence: number;   // 0.0 - 1.0
  args?: string;        // arguments extraits, ex: "P1" pour "/task P1 title"
  source: "pattern" | "llm";
}

export function detectIntent(message: string): Promise<DetectedIntent | null>;
```

#### Comportement par seuil de confiance

- `>= 0.8` : Suggere la commande, demande confirmation ("Tu veux que je lance /backlog ?")
- `0.5 - 0.8` : Demande clarification ("Tu parles du backlog ou du sprint ?")
- `< 0.5` : Traitement standard (conversation normale)

Pas d'execution automatique dans le spike. Toujours confirmation utilisateur.

### 5.4 Integration dans zz-messages.ts

```typescript
// Avant le traitement standard du message texte :
if (isFeatureEnabled("intent_detection")) {
  const intent = await detectIntent(text);
  if (intent && intent.confidence >= 0.8) {
    await ctx.reply(`Je comprends que tu veux ${intent.intent}. Tu veux que je lance ${intent.command} ?`);
    // Callback inline button pour confirmer/annuler
    return;
  }
}
// ... traitement standard existant
```

### 5.5 Risques

- **Faux positifs** : Un message contenant "backlog" dans une discussion ne devrait pas trigger. Mitigation : seuil 0.8 + confirmation.
- **Latence LLM** : Le fallback LLM ajoute ~500ms. Mitigation : patterns statiques d'abord (instant).
- **Conflit avec commandes slash** : Les commandes slash ont toujours priorite (traitement par les Composers AVANT zz-messages).

## 6. Fichiers impactes — Resume

| Fichier | Axe | Type de changement |
|---------|-----|--------------------|
| `src/agent.ts` | 1+3 | Ajouter mcpConfig a SpawnClaudeOptions |
| `src/orchestrator.ts` | 1+3, 2 | Instructions MCP, checkpoint save/load, resume |
| `src/bmad-agents.ts` | 1+3 | Ajouter mcpTools par agent |
| `src/bmad-prompts.ts` | 1+3 | Section "OUTILS MCP DISPONIBLES" |
| `src/intent-detection.ts` | 4 | NOUVEAU — patterns + detection |
| `src/commands/zz-messages.ts` | 4 | Hook intent detection |
| `src/commands/execution.ts` | 2 | Parser --resume |
| `db/schema.sql` | 2 | Table pipeline_runs |
| `config/features.json` | 4 | Flag intent_detection |

## 7. Decisions d'architecture

**DA-001 : Heritage MCP plutot qu'injection explicite**
Les agents heritent de .mcp.json par defaut. On n'ajoute --mcp-config QUE pour le cas worktree. Raison : simplicite, moins de code, deja fonctionnel.

**DA-002 : Instructions MCP dans le prompt plutot que config par role**
On dit aux agents quels outils utiliser via le prompt (pas de restriction technique). Raison : --allowedTools ajouterait de la complexite et les agents respectent bien les instructions prompt.

**DA-003 : Pipeline_runs en Supabase plutot qu'en fichier local**
La persistence d'etat du pipeline va en base. Raison : coherence avec le reste de l'architecture (blackboard, tasks, metrics sont deja en Supabase).

**DA-004 : Patterns statiques d'abord, LLM en fallback pour l'intent detection**
Raison : zero cout pour les cas courants, latence minimale, et le LLM n'est appele que pour les messages ambigus.

**DA-005 : Confirmation obligatoire pour l'intent detection**
Jamais d'execution automatique dans le spike. Raison : les faux positifs sont inevitables, mieux vaut confirmer que de lancer une action non desiree.

**DA-006 : Fallback orchestrator-side pour l'ecriture blackboard**
L'orchestrator continue d'ecrire dans le blackboard apres chaque agent (sauf si la section est deja a jour). Raison : un agent qui n'utilise pas les outils MCP ne doit pas casser le flux.

## 8. Non-goals (confirmes)

- Pas de restriction technique d'outils MCP par role (DA-002)
- Pas de communication peer-to-peer entre agents
- Pas d'execution automatique d'intent (DA-005)
- Pas de UI pour le resume (juste le flag --resume)
- Pas de pipeline_runs UI/dashboard
