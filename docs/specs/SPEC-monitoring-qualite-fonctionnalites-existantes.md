---
name: monitoring-qualite-fonctionnalites-existantes
description: Combler 4 lacunes critiques de monitoring — métriques par commande, persistance JSON cross-restart, recordSpawnResult non appelé, fetchSignals SDD vide
status: ready
phase: 1-implement
exploration: docs/explorations/EXPLORE-monitoring-qualite-fonctionnalites-existantes.md
adversarial: docs/reviews/adversarial-SPEC-monitoring-qualite-fonctionnalites-existantes.md
generated_at: "2026-03-25"
revision: 2
---

# SPEC — Monitoring qualité fonctionnalités existantes

## Section 1 — Objectif

Combler quatre lacunes critiques de monitoring identifiées dans l'exploration
[EXPLORE-monitoring-qualite-fonctionnalites-existantes.md](../explorations/EXPLORE-monitoring-qualite-fonctionnalites-existantes.md),
en corrigeant l'architecture de flush suite à la review adversariale (processus PM2 séparés) :

1. **Absence de métriques par commande Telegram** : aucune visibilité sur quelle commande est la plus lente ou la plus utilisée.
2. **Ring buffers volatils** : `responseTimeBuffer`, `spawnCounters`, `moduleErrors` dans `alerts.ts` réinitialisés à chaque restart PM2.
3. **`recordSpawnResult` non appelé en production** : exporté et testé, jamais invoqué dans `agent.ts`.
4. **`fetchSignals` retourne `[]` en production** : la boucle feedback SDD ne reçoit aucun signal réel — overlays adaptatifs jamais créés automatiquement.

Solution retenue (Option B de l'exploration, révisée) : ajout des fonctions `commandStats` dans `alerts.ts` existant + flush JSON atomique déclenché depuis `relay.ts` (même processus PM2 que le bot) + correctifs ciblés dans 3 fichiers.

> **Décision architecturale clé (F-DA-7)** : le flush doit être déclenché depuis le processus `claude-relay` (relay.ts), pas depuis `claude-heartbeat` (processus PM2 distinct à mémoire séparée). Deux déclencheurs : `setInterval` horaire + `gracefulShutdown`.

---

## Section 2 — Règles métier

| #   | Règle | Source | Exemple |
|-----|-------|--------|---------|
| R1  | Ajouter `commandStats : Map<string, { calls: number; totalMs: number }>` dans `alerts.ts`. Clé = nom de commande sans slash (`"metrics"`, `"explore"`). Pas de champ `errors` — l'error tracking via middleware est structurellement non fiable (errorBoundary absorbe avant le middleware). | EXPLORE §5 Option B + F-SS-5 review adversariale | `commandStats.get("metrics") → { calls: 12, totalMs: 8400 }` |
| R2  | `recordCommandCall(cmd: string, ms: number): void` — incrémente `calls` et cumule `totalMs` dans la Map. Si `commandStats.size >= 100` (cap anti-fuite mémoire), l'entrée est ignorée. Appelé depuis un middleware grammY ajouté dans `relay.ts` APRÈS le middleware auth, AVANT `loadComposers`. Le middleware extrait la commande de `ctx.message?.text`. | R1 + F-EC-8 | `recordCommandCall("metrics", 700)` → `{ calls: 1, totalMs: 700 }` |
| R3  | `flushCommandStats(): Promise<void>` — écrit `{RELAY_DIR}/command-stats.json` via pattern atomique tmp+rename de `pipeline-tracker.ts`. Pas de feature flag — la persistance JSON locale est safe (aucune latence réseau, aucune DB). Si le répertoire n'existe pas, `mkdir({ recursive: true })` avant l'écriture. En cas d'erreur, `log.error` et return sans lancer d'exception. | EXPLORE §6 — persistance JSON + F-SS-2 (supprimer flag) | Fichier créé avec les stats courantes, résistant aux interruptions |
| R4  | `loadCommandStats(): Promise<void>` — lit `command-stats.json` au démarrage, initialise la Map avec les valeurs lues (cumul cross-restarts). Si le fichier est absent ou le JSON invalide (try/catch), silently ignore (Map reste vide). | EXPLORE §6 — cumul cross-restarts | Map initialisée avec dernières valeurs avant restart |
| R5  | Format JSON `command-stats.json` : `{ "flushed_at": "ISO", "stats": { "[cmd]": { "calls": N, "totalMs": N } } }`. Champs obligatoires : `flushed_at` (string ISO), `stats` (objet). Structure cohérente avec `heartbeat-state.json`. | Cohérence codebase | `{ "flushed_at": "2026-03-25T20:00:00.000Z", "stats": { "metrics": { "calls": 12, "totalMs": 8400 } } }` |
| R6  | Instrumenter `spawnClaude()` (API publique exportée, `agent.ts:238`) — appeler `recordSpawnResult(options.role ?? options.model ?? "default", result.exitCode === 0)` avant de retourner. Ne pas instrumenter `spawnClaudeCore` (privée) ni `spawnClaudeWithCascade` (interne) — instrumenter la façade publique évite le double-comptage des cascades. | EXPLORE §3 gap + F-DA-4 review adversariale | `spawnClaude({ prompt, role: "spec-architect" })` → `recordSpawnResult("spec-architect", true)` |
| R7  | `fetchGateEvaluationSignals(supabase: SupabaseClient): Promise<AgentFeedbackSignal[]>` dans `feedback-analyzer.ts` — query `gate_evaluations WHERE passed=false AND created_at > now()-30 days LIMIT 50`. Mapping explicite via `GATE_NAME_TO_SOURCE`: vérifier si `gate_name` commence par `"challenge"`, `"review"`, `"implement"`, `"explore"` (startsWith). Si aucune correspondance, **ignorer** le signal (ne pas injecter de conseils incorrects). | EXPLORE §6 + F-DA-5/F-EC-6/F-SS-4 review adversariale | `gate_name="challenge_v2"` → source `"challenge"` ; `gate_name="prd_approval"` → ignoré |
| R8  | `getDeps()` dans `feedback-analyzer.ts` : la dépendance `fetchSignals` par défaut appelle `fetchGateEvaluationSignals(getDefaultSupabase())`. `getDefaultSupabase()` = import lazy du client Supabase (pattern `require()` existant ligne 67). L'interface `_setDependencies` et `_deps` restent inchangées. | Pattern existant feedback-analyzer.ts:64-72 | Tests existants utilisant `_setDependencies` non cassés |
| R9  | `formatMonitoringStats()` dans `alerts.ts` étendue avec section "Par commande Telegram" en bas du HTML existant. Afficher top 10 par `calls` décroissant : `calls` + `avg_ms` (= totalMs / calls). Si `commandStats` vide, afficher `<i>Aucune donnée (démarrage récent)</i>`. Ne jamais afficher `error_rate` — annotation explicite `⚠️ error tracking: non disponible (V1)` sous le titre de section. | F-SS-5 + F-EC-9 + F-DA-2 review adversariale | Section affichée même à 0 commandes (état explicite) |
| R10 | `resetMonitoringState()` dans `alerts.ts` (existante) étendue pour effacer aussi `commandStats` : `commandStats.clear()`. Interface inchangée pour les tests existants. | F-DA-2/F-EC-2 review adversariale | `resetMonitoringState()` → Map vide + ring buffers vides |

---

## Section 3 — Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| Middleware grammY (relay.ts) | Événement Telegram | `ctx.message?.text` | Nom de commande (`/[a-z]+`), timestamp début/fin handler |
| `spawnClaude()` (agent.ts) | Résultat spawn | `SpawnClaudeResult.exitCode`, `SpawnClaudeOptions.role`, `.model` | `exitCode`, `role`, `model` |
| Table `gate_evaluations` (Supabase) | SQL query | `supabase.from("gate_evaluations").select(...)` | `agent_role`, `gate_name`, `passed`, `created_at`, `session_id` |
| `{RELAY_DIR}/command-stats.json` | Fichier JSON local | `readFile(path, "utf-8")` | `flushed_at`, `stats.*` |

---

## Section 4 — Données de sortie

### Livrable 1 — `src/alerts.ts` (modifié, 585 → ~665 LOC)

Ajouts en bas du fichier (après les exports existants) :

```
commandStats: Map<string, { calls: number; totalMs: number }> // store interne
recordCommandCall(cmd: string, ms: number): void              // incrémente + cap 100
getCommandStats(): Record<string, { calls: number; totalMs: number }> // lecture
flushCommandStats(): Promise<void>                            // JSON atomique
loadCommandStats(): Promise<void>                             // restauration startup
```

Modification de fonctions existantes :
- `formatMonitoringStats()` : ajout section "Par commande Telegram" (R9)
- `resetMonitoringState()` : ajout `commandStats.clear()` (R10)

Aucune suppression, aucun re-export à créer, aucun import existant cassé.

### Livrable 2 — `src/agent.ts` (modifié, +~6 LOC)

- `role?: string` ajouté à l'interface `SpawnClaudeOptions` (rétrocompatible, optionnel)
- Import `recordSpawnResult` depuis `./alerts.ts`
- Appel dans `spawnClaude()` (ligne 238) : `recordSpawnResult(options.role ?? options.model ?? "default", result.exitCode === 0)` avant `return result`
- `spawnClaudeCore` et `spawnClaudeWithCascade` inchangées

### Livrable 3 — `src/feedback-analyzer.ts` (modifié, +~25 LOC)

- Constante `GATE_NAME_TO_SOURCE: Record<string, AgentFeedbackSignal["source"]>` :
  ```ts
  { challenge: "challenge", review: "review", implement: "implement", explore: "explore" }
  ```
- Nouvelle fonction `fetchGateEvaluationSignals(supabase: SupabaseClient)` : query + mapping (avec filtrage des source inconnues)
- `getDeps()` : remplacer `fetchSignals: async () => []` par closure sur `fetchGateEvaluationSignals`

### Livrable 4 — `src/relay.ts` (modifié, +~20 LOC)

- Import `recordCommandCall`, `loadCommandStats`, `flushCommandStats` depuis `./alerts.ts`
- Middleware timing après le middleware auth existant, avant `loadComposers` :
  ```ts
  bot.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const cmd = ctx.message?.text?.match(/^\/(\w+)/)?.[1];
    if (cmd) recordCommandCall(cmd, Date.now() - start);
  });
  ```
- `await loadCommandStats()` dans le bloc d'init (après `initPipelineTracker`)
- `setInterval(flushCommandStats, 3_600_000)` dans le bloc des `setInterval` existants
- `await flushCommandStats()` dans `gracefulShutdown()` AVANT `process.exit(0)`

### Format `command-stats.json`

```json
{
  "flushed_at": "2026-03-25T20:00:00.000Z",
  "stats": {
    "metrics": { "calls": 12, "totalMs": 8400 },
    "explore": { "calls": 3, "totalMs": 45000 },
    "docs": { "calls": 7, "totalMs": 2100 }
  }
}
```

---

## Section 5 — Interface Telegram

### Commande `/monitor` — Extension de la section de formatage

Commande existante dans `commands/help.ts`. La fonction `formatMonitoringStats()` (dans `alerts.ts`) est étendue avec une section "Par commande Telegram" en bas du message HTML existant.

**Format HTML de la nouvelle section (cas normal) :**

```
─────────────────────────
<b>Par commande Telegram</b>
⚠️ error tracking: non disponible (V1)
  /metrics    12 appels   700ms moy
  /explore     3 appels 15000ms moy
  /docs        7 appels   300ms moy
  /sprint      5 appels   200ms moy
  (top 10 par usage, depuis dernier flush)
```

**Format HTML (Map vide — démarrage récent) :**

```
─────────────────────────
<b>Par commande Telegram</b>
<i>Aucune donnée (démarrage récent)</i>
```

**Pas de nouveau message, pas de nouveau bouton.** La section s'ajoute en bas du message `/monitor` existant.

**Chat action :** `typing` (déjà implémenté dans help.ts, pas de modification).

**Exemple de conversation complet :**

```
Utilisateur : /monitor

Bot :
═══ Monitoring Production ═══

<b>Temps de réponse</b>
  p50: 2s  p95: 8s  p99: 12s  (42 mesures)
─────────────────────────
<b>Spawn Claude par rôle</b>
  ✅ spec-architect: 5/5 OK (0% échec)
  ⚠️ reviewer: 3/4 OK (25% échec)
─────────────────────────
<b>Erreurs modules (dernière heure)</b>
  ✅ Aucune erreur
─────────────────────────
<b>Par commande Telegram</b>
⚠️ error tracking: non disponible (V1)
  /metrics    12 appels   700ms moy
  /explore     3 appels 15000ms moy
  /docs        7 appels   300ms moy
  /sprint      5 appels   200ms moy
  (4 commandes actives depuis dernier restart)
```

**Évaluation des features Telegram :**

| Feature | Évaluation |
|---------|-----------|
| `setMyCommands` | N/A — `/monitor` déjà enregistré |
| `ReplyKeyboardMarkup` | N/A — vue status ponctuelle, pas d'actions fréquentes |
| Message pinning | N/A — données trop volatiles |
| `editMessageText` | N/A — snapshot unique, pas de live-update |
| Reactions | N/A — pas de validation utilisateur requise |

---

## Section 6 — Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/alerts.ts` (585 LOC) | Modifier → ~665 LOC | Ajouter `commandStats` Map + 5 fonctions + étendre `formatMonitoringStats` et `resetMonitoringState`. Reste sous 800 LOC — pas d'extraction. |
| `src/agent.ts` (732 LOC) | Modifier (+~6 LOC) | Ajouter `role?` à `SpawnClaudeOptions`, instrumenter `spawnClaude()` (façade publique) avec `recordSpawnResult`. |
| `src/feedback-analyzer.ts` (232 LOC) | Modifier (+~25 LOC) | Implémenter `fetchGateEvaluationSignals` + `GATE_NAME_TO_SOURCE` + brancher dans `getDeps()`. |
| `src/relay.ts` (239 LOC) | Modifier (+~20 LOC) | Ajouter middleware timing + `loadCommandStats()` init + `setInterval(flushCommandStats, 3_600_000)` + `flushCommandStats()` dans `gracefulShutdown`. |
| `tests/unit/monitoring.test.ts` (125 LOC) | Modifier | Étendre avec tests `recordCommandCall`, `flushCommandStats`, `loadCommandStats`, `resetMonitoringState` effaçant commandStats, section "Par commande" dans `formatMonitoringStats`. Imports depuis `../../src/alerts` inchangés. |
| `tests/unit/feedback-analyzer.test.ts` | Modifier | Ajouter tests pour `fetchGateEvaluationSignals` avec mock Supabase, et mapping explicite `GATE_NAME_TO_SOURCE`. |

> **Non modifiés** : `heartbeat.ts` (processus PM2 séparé — flush déplacé dans relay.ts), `config/features.json` (pas de feature flag).

---

## Section 7 — Patterns existants

### Pattern 1 — Persistance JSON atomique (`src/pipeline-tracker.ts:119-131`)

```ts
// src/pipeline-tracker.ts:119-131
async function savePipelines(): Promise<void> {
  try {
    await mkdir(getRelayDir(), { recursive: true });
    const entries = Array.from(pipelines.entries()).map(([key, tracker]) => ({ key, tracker }));
    const pipelinesFile = getPipelinesFile();
    const tmp = pipelinesFile + `.tmp.${crypto.randomUUID().substring(0, 8)}`;
    await writeFile(tmp, JSON.stringify(entries, null, 2));
    await rename(tmp, pipelinesFile);
  } catch (error) {
    log.error("Pipeline persistence error", { error: String(error) });
  }
}
```

Réutiliser pour `flushCommandStats()` : même structure, remplacer `pipelinesFile` par `getRelayDir() + "/command-stats.json"`.

### Pattern 2 — Getter RELAY_DIR (allowlist S9) (`src/pipeline-tracker.ts:20-22`)

```ts
// src/pipeline-tracker.ts:20-22 — getter lazy allowlist S9
function getRelayDir(): string {
  return process.env.RELAY_DIR ?? join(homedir(), ".claude-relay");
}
```

Utiliser ce même getter dans `alerts.ts` pour `flushCommandStats`/`loadCommandStats` — contourne la violation S2 car ce pattern est dans l'allowlist S9. Ne pas importer depuis `bot-context.ts` (risque cycle S7 : alerts → bot-context → ...).

### Pattern 3 — Ring buffer record/get (`src/alerts.ts:360-384`)

```ts
// src/alerts.ts:360-384
const responseTimeBuffer: number[] = [];
export function recordResponseTime(ms: number): void {
  responseTimeBuffer.push(ms);
  if (responseTimeBuffer.length > RESPONSE_TIME_BUFFER_SIZE) responseTimeBuffer.shift();
}
```

Pattern `store privé + record*(input) + get*() en lecture` à reproduire pour `commandStats`.

### Pattern 4 — Injection de dépendances testable (`src/feedback-analyzer.ts:64-72`)

```ts
// src/feedback-analyzer.ts:64-72
function getDeps(): Dependencies {
  if (_deps) return _deps;
  const { isFeatureEnabled } = require("./feature-flags.ts");
  return {
    isFeatureEnabled,
    fetchSignals: async () => [], // ← remplacer par fetchGateEvaluationSignals
  };
}
```

Modifier uniquement la ligne `fetchSignals: async () => []` pour appeler `fetchGateEvaluationSignals(getDefaultSupabase())`. L'interface `_setDependencies`/`_deps` reste inchangée — tests existants non cassés.

### Pattern 5 — setInterval dans relay.ts (`src/relay.ts:173-174`)

```ts
// src/relay.ts:173-174
setInterval(clearStaleState, 300_000);
```

Ajouter dans le même bloc : `setInterval(flushCommandStats, 3_600_000)` — même style, pas de state tracking (setInterval natif garantit la fréquence).

---

## Section 8 — Contraintes

### Budget LOC

| Fichier | LOC actuel | LOC cible | Marge seuil 800 |
|---------|-----------|-----------|-----------------|
| `src/alerts.ts` | 585 | ~665 | 135 sous seuil |
| `src/agent.ts` | 732 | ~738 | 62 sous seuil |
| `src/relay.ts` | 239 | ~259 | 541 sous seuil |
| `src/feedback-analyzer.ts` | 232 | ~257 | 543 sous seuil |

### Standards de codage (CLAUDE.md)

- **S1** : pas de `console` — `alerts.ts` utilise déjà `createLogger("alerts")`. Nouvelles fonctions `commandStats` dans le même module → même logger.
- **S2** : pas de `process.env` direct — utiliser le getter lazy `getRelayDir()` (pattern allowlist S9, Pattern 2 ci-dessus). Ne PAS importer depuis `bot-context.ts`.
- **S7** : pas de cycle — `alerts.ts` n'importe rien de nouveau (les fonctions `commandStats` sont dans le même fichier). Vérifier que `relay.ts` → `alerts.ts` ne crée pas de cycle via les nouveaux imports.
- **S8** : couverture ≥ 30% — `monitoring.test.ts` étendu pour les nouvelles fonctions.

### Ce qu'il ne faut pas casser

- **38 tests de `monitoring.test.ts`** : importent depuis `../../src/alerts`. Toutes les fonctions restent dans `alerts.ts` → aucun import à mettre à jour.
- **`resetMonitoringState()`** : étendue (+ `commandStats.clear()`), pas remplacée. Les tests qui l'appellent entre cas restent valides.
- **Interface `_setDependencies` / `analyzeAgentFeedback` / `generateOverlayText`** dans `feedback-analyzer.ts` : inchangée.
- **`SpawnClaudeOptions`** : `role?` est un ajout rétrocompatible optionnel. Tous les appels existants sans `role` restent valides — le fallback utilise `options.model ?? "default"`.
- **Interface publique de `alerts.ts`** : `formatAlerts`, `runAllChecks`, `checkStuckTasks`, etc. inchangées.

### Dépendances

- Table `gate_evaluations` : existante dans Supabase, champ `agent_role TEXT NOT NULL`, `gate_name TEXT NOT NULL`, `passed BOOLEAN`. Aucune migration.
- `fs/promises` (Bun) : `mkdir`, `readFile`, `writeFile`, `rename` — déjà utilisés dans `pipeline-tracker.ts`.

---

## Section 9 — Critères de validation

| #   | Critère | Vérification | Niveau |
|-----|---------|-------------|--------|
| V1  | `recordCommandCall("metrics", 700)` → `getCommandStats()["metrics"]` = `{ calls: 1, totalMs: 700 }` | `expect(stats.metrics.calls).toBe(1)` dans `monitoring.test.ts` | `unit` |
| V2  | Deux appels `recordCommandCall("docs", 300)` → `calls === 2`, `totalMs === 600` | Vérifier cumul dans le Record retourné | `unit` |
| V3  | `recordCommandCall` avec 100 clés distinctes déjà en Map → 101e clé ignorée, `commandStats.size` reste 100 | Remplir Map à 100, appeler avec nouvelle clé, vérifier size | `unit` |
| V4  | `flushCommandStats()` → fichier `command-stats.json` créé, JSON valide, champs R5 présents | `JSON.parse(readFileSync(...))` ne lance pas d'erreur, champs `flushed_at` et `stats` présents | `integration` |
| V5  | `loadCommandStats()` → Map initialisée avec valeurs lues (reset préalable de la Map via `resetMonitoringState`) | Reset Map, `loadCommandStats()`, `getCommandStats()` = valeurs du fichier JSON | `integration` |
| V6  | `loadCommandStats()` avec fichier JSON invalide → silently ignore (pas d'exception lancée) | Créer fichier avec JSON cassé, appeler `loadCommandStats()`, pas d'erreur | `integration` |
| V7  | `spawnClaude({ prompt: "test", role: "spec-architect" })` → `getSpawnStats()["spec-architect"]` incrémenté | Mock `spawnClaudeCore` via injection ou test avec `spawnClaude` exportée, vérifier compteur spawn | `unit` |
| V8  | `fetchGateEvaluationSignals(mockSupabase)` avec 3 rows `passed=false`, `gate_name="challenge_v2"` → retourne 3 signals `{ source: "challenge", outcome: "NO-GO" }` | Mock Supabase retournant 3 rows, vérifier mapping | `integration` |
| V9  | `fetchGateEvaluationSignals(mockSupabase)` avec `gate_name="prd_approval"` → signal ignoré (array vide ou exclu) | Vérifier que le signal avec source inconnue n'apparaît pas dans le résultat | `integration` |
| V10 | `runFeedbackLoop()` avec 4 signaux NO-GO pour `"spec-architect"` via `_setDependencies` → `overlaysCreated >= 1` | Injecter `fetchSignals` via `_setDependencies`, vérifier résultat | `integration` |
| V11 | `formatMonitoringStats()` retourne HTML contenant `<b>Par commande Telegram</b>` quand `commandStats` non vide | `expect(output).toContain("Par commande Telegram")` | `unit` |
| V12 | `formatMonitoringStats()` avec `commandStats` vide → HTML contient `Aucune donnée (démarrage récent)` | `expect(output).toContain("Aucune donnée")` | `unit` |
| V13 | `formatMonitoringStats()` n'affiche jamais de pourcentage d'erreur | `expect(output).not.toContain("% err")` | `unit` |
| V14 | `resetMonitoringState()` efface aussi `commandStats` | Appeler `recordCommandCall`, puis `resetMonitoringState()`, vérifier `getCommandStats()` vide | `unit` |
| V15 | `alerts.ts` < 800 LOC après implémentation | Standard S3 dans `coding-standards.test.ts` passe | `unit` |
| V16 | `await flushCommandStats()` est appelé dans `gracefulShutdown()` de relay.ts avant `process.exit(0)` | Lecture du code relay.ts + test d'intégration si applicable | `integration` |

---

## Section 10 — Coverage et zones d'ombre

### Matrice des 5 dimensions

| Dimension | Questions résolues | Zones résiduelles |
|-----------|-------------------|-------------------|
| **Problème** | 4 lacunes documentées et adressées dans la même spec. Architecture flush corrigée suite au finding F-DA-7 (processus PM2 séparés). | Aucune — toutes issues de l'exploration + review adversariale |
| **Périmètre** | 4 fichiers modifiés (pas d'extraction monitoring.ts). Flush dans relay.ts (même processus). Pas de feature flag. | Le middleware timing ne capture pas les callbacks `callback_query` (boutons inline) — V1 couvre uniquement les commandes `/cmd`. |
| **Validation** | 16 V-critères couvrant les 4 lacunes + cas edge (JSON invalide, cap 100 clés, Map vide). | V4/V5/V6 (`flush`/`load`) : tests d'intégration nécessitent un RELAY_DIR temporaire. Pattern établi dans `pipeline-tracker.test.ts` à reproduire. |
| **Technique** | Pattern JSON atomique réutilisé depuis pipeline-tracker.ts. Getter lazy RELAY_DIR (allowlist S9). `spawnClaude()` instrumenté (façade publique, évite double-comptage cascade). Mapping explicite `GATE_NAME_TO_SOURCE` (évite split fragile). | `gate_evaluations` peut contenir des `gate_name` non reconnus — filtrés silencieusement. À monitorer en prod. `require()` dans `getDeps()` : pattern CommonJS existant, risque si migration ESM future (hors scope). |
| **UX Telegram** | Section "Par commande" avec état explicite (vide ou données). Note `⚠️ error tracking: non disponible (V1)` évite métriques trompeuses. | Tri "top 10 par usage" arbitraire — un tri par `avg_ms` (commandes lentes) serait plus actionnable en V2. |

### Alternatives évaluées et rejetées (dont findings adversariaux)

| Alternative | Raison du rejet |
|-------------|----------------|
| **Flush depuis heartbeat.ts** | F-DA-7 (bloquant) : processus PM2 séparé (`claude-heartbeat` vs `claude-relay`), mémoire non partagée → Map toujours vide dans le heartbeat |
| **Extraction `src/monitoring.ts`** | F-SS-1 : alerts.ts à 585 LOC + ~80 LOC nouveaux = 665, bien sous 800. Extraction crée un module supplémentaire et casse 38 imports de tests sans valeur |
| **Feature flag `monitoring_persist`** | F-SS-2 : persistance JSON locale safe (pas de réseau, pas de DB, pas de latence). Un 12e flag sans rollback urgence justifié |
| **Error rate dans commandStats** | F-EC-3/F-SS-5 : `errorBoundary` de loader.ts absorbe les exceptions avant le middleware → error rate structurellement 0%, activement trompeur |
| **Instrumenter `spawnClaudeCore`** | F-DA-4 : `spawnClaudeWithCascade` appelle `spawnClaudeCore` en boucle → double-comptage. La façade `spawnClaude()` est l'API publique naturelle |
| **`gate_name.split("_")[0]`** | F-DA-5/F-EC-6 : fragile, `"architecture_review"` → `"architecture"` (inconnu) → overlay avec mauvais template. Mapping explicite par startsWith est robuste |
| **Métriques dans Supabase (Option C)** | Migration schema + latence synchrone dans les handlers chauds. Adapté en V2 pour historique inter-sprints après validation de la valeur |

### Zones non résolues (hors scope V1)

1. **Seuils d'alerte par commande** : non définis. Alertes à définir en V2 après accumulation de données (ex: `avg_ms > 10000`).
2. **Callbacks `callback_query` non tracés** : seules les commandes `/cmd` sont instrumentées via le middleware text.
3. **Rotation JSON** : stats cumulatives sans expiry. Si le fichier grossit, ajouter rotation mensuelle en V2.
4. **`require()` dans getDeps()** : syntaxe CommonJS existante dans feedback-analyzer.ts. Risque si migration ESM future — hors scope, déjà présent avant cette spec.
5. **Tri par latence** : le top 10 par `calls` est arbitraire. Un tri par `avg_ms` serait plus actionnable pour identifier les commandes lentes — à envisager en V2.
