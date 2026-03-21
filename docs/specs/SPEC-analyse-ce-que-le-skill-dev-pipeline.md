# Spec v2 : Integration hybride des patterns dev-pipeline dans le workflow multiagent

> Genere le 2026-03-21. Source : exploration EXPLORE-analyse-ce-que-le-skill-dev-pipeline.md (v1), exploration EXPLORE-analyse-ce-que-le-skill-dev-pipeline-2.md (v2), codebase orchestrator/auto-pipeline/adversarial-verifier/blackboard/gate-evaluator/code-graph/notification-queue, reponses utilisateur.

## 1. Objectif

Greffer 5 elements du dev-pipeline (systeme B) dans le workflow multiagent du bot Telegram (systeme A) pour ameliorer la qualite des implementations produites par les pipelines DEFAULT et LIGHT : (P1) une spec-phase legere pre-orchestration qui produit une proto-spec avec V-criteres et fichiers impactes, (P2) un challenge adversarial 1-agent insere entre architect et dev pour detecter les problemes bloquants avant implementation, (E1) un Impact Analyst lance en parallele de P2 pour evaluer le blast radius du changement, (P3) un conformance check post-implementation qui verifie que les V-criteres de la proto-spec sont couverts, et (E2) une quality gate utilisateur legere post-P1 sur les pipelines DEFAULT qui permet a l'utilisateur de valider la comprehension des agents avant implementation. Les cinq elements sont derriere feature flags desactives par defaut et ne modifient pas le comportement des pipelines QUICK, SOLO et REVIEW. L'evidence empirique des 3 pipelines dev-pipeline executes sur le bot (3 findings BLOQUANTS detectes et resolus avant merge) valide le ROI du challenge adversarial.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | P1 s'active uniquement sur les pipelines DEFAULT et LIGHT, jamais sur QUICK, SOLO ou REVIEW | Exploration v1 section 6 (contrainte explicite) | Une tache bug "fix crash on startup" selectee en QUICK ne declenche pas P1 |
| R2 | P1 produit une proto-spec structuree contenant : objectif (1-2 phrases), 3-5 V-criteres testables, liste de fichiers probablement impactes | Exploration v1 section 6, P1 | Proto-spec stockee dans blackboard.spec.proto_spec |
| R3 | La proto-spec est generee sans interview utilisateur — elle est auto-suffisante, construite a partir de la description de tache, du story file et du contexte agent | Exploration v1 section 6 (contrainte : pas d'interview synchrone) | Le spec-lite agent recoit la tache enrichie + story file comme input |
| R4 | P1 est derriere le feature flag `spec_phase_lite`, desactive par defaut | Exploration v1 section 6 | `isFeatureEnabled("spec_phase_lite")` retourne false initialement |
| R5 | P2 insere un step adversarial entre le dernier agent pre-dev (architect ou planner) et le dev agent dans le pipeline | Exploration v1 section 6, P2 | Pipeline DEFAULT : analyst -> pm -> architect -> [adversarial + impact] -> dev -> qa |
| R6 | P2 utilise un seul agent adversarial (devil's-advocate) qui recoit la proto-spec (si P1 actif) ou la sortie architect comme input | Exploration v1 section 6, P2 | L'agent produit max 10 findings classes par severite |
| R7 | Si P2 trouve au moins 1 finding BLOQUANT, le pipeline se met en pause et notifie l'utilisateur via Telegram, en incluant le rapport Impact Analyst (E1) si disponible | Exploration v1 section 6 + exploration v2 E1 | Message : "Challenge adversarial : 1 finding bloquant detecte. Impact: MEDIUM (3 modules). Pipeline en pause." |
| R8 | P2 est derriere le feature flag `adversarial_challenge`, desactive par defaut. E1 (Impact Analyst) partage ce meme flag — il s'active avec P2, pas separement | Exploration v1 section 6 + exploration v2 E1 | `isFeatureEnabled("adversarial_challenge")` controle P2 et E1 ensemble |
| R9 | P3 s'execute apres le dev agent et avant QA, uniquement si P1 a produit des V-criteres | Exploration v1 section 6, P3 | Si P1 n'a pas tourne (flag off ou pipeline QUICK), P3 est saute |
| R10 | P3 reutilise la logique de `adversarial-verifier.ts` en lui fournissant la proto-spec (V-criteres) comme spec et la sortie dev comme implementation | Exploration v1 section 6, P3 | Le DriftReport resultant indique quels V-criteres sont couverts vs manquants |
| R11 | La duree maximale acceptable pour chaque pattern est de 2 minutes (compatibilite UX Telegram) | Exploration v1 section 6, contrainte latence | Le spec-lite agent utilise haiku pour rester sous 2 min |
| R12 | Aucune modification du comportement existant n'est autorisee quand les feature flags sont desactives — regression zero | Exploration v1 section 6 | Tous les tests existants passent sans modification |
| R13 | Le V-critere de la proto-spec utilise la notation `[V1]`, `[V2]`, etc., coherente avec le dev-pipeline pour permettre la conformance (P3) | Exploration v1 section 6, question 3 | Proto-spec : "[V1] La fonction parseInput() retourne un objet valide pour un input JSON" |
| R14 | L'adversarial challenge (P2) peut etre bypasse par l'utilisateur via un flag `--skip-challenge` sur la commande `/orchestrate` | Exploration v1 section 6, question 2 + pattern existant des gate overrides | `/orchestrate T-42 --blackboard --skip-challenge` |
| R15 | E1 (Impact Analyst) est lance en parallele de P2 (Devil's Advocate) via `Promise.all`. Sa duree n'ajoute pas de latence au step adversarial car le DA (sonnet, ~90s) est toujours plus long que l'IA (haiku, <60s) | Exploration v2 section 6, E1 | `Promise.all([runAdversarialChallenge(...), runImpactAnalysis(...)])` |
| R16 | E1 produit un rapport de risque structure (LOW/MEDIUM/HIGH) avec nombre de modules impactes, breaking changes potentiels. Le rapport est stocke dans `blackboard.verification.impact_analysis` | Exploration v2 section 6, E1 | Rapport : `{ risk_level: "MEDIUM", modules_impacted: 3, breaking_changes: [] }` |
| R17 | Le rapport E1 est advisory — il n'est jamais bloquant en soi. Il est inclus dans le message de pause P2 (si bloquant) et dans le resume final du pipeline | Exploration v2 section 6, E1 | Le pipeline ne s'arrete pas si E1 dit HIGH — seuls les findings P2 BLOQUANTS arretent |
| R18 | E2 (quality gate utilisateur) s'active uniquement sur les pipelines DEFAULT, jamais sur LIGHT, QUICK, SOLO ou REVIEW | Exploration v2 section 6, E2 | Pipeline LIGHT ne declenche pas E2 meme si le flag est actif |
| R19 | E2 envoie un message Telegram apres P1 resumant la comprehension des agents (objectif, V-criteres, fichiers impactes) avec deux boutons inline : "GO" et "SKIP" | Exploration v2 section 6, E2 | Boutons inline Telegram via InlineKeyboard, pattern identique aux callbacks PRD |
| R20 | E2 a un timeout automatique de 10 minutes : si l'utilisateur ne repond pas, le pipeline continue (GO implicite) | Exploration v2 section 6, E2 | Evite de bloquer indefiniment un pipeline lance en background |
| R21 | E2 peut etre bypasse avec le flag `--no-confirm` sur `/orchestrate`. Quand bypasse, le pipeline continue directement apres P1 sans pause | Exploration v2 section 6, E2 | `/orchestrate T-42 --blackboard --no-confirm` |
| R22 | E2 est derriere le feature flag `spec_gate`, desactive par defaut, independant des autres flags | Exploration v2 section 6, E2 | `spec_gate` peut etre active sans `spec_phase_lite` (dans ce cas E2 est inoperant car pas de proto-spec) |
| R23 | E1 utilise `getImpactRadius()` de `src/code-graph.ts` pour les dependances statiques (zero-LLM), puis spawne l'agent Impact Analyst (haiku) pour l'analyse semantique si la liste de fichiers impactes est >= 3 | Exploration v2 section 3 item 3, question 1 | Pour une modification touchant 1-2 fichiers : zero-LLM seulement. Pour 3+ fichiers : zero-LLM + agent haiku |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| Task (Supabase `tasks`) | DB row | `supabase.from("tasks").select("*")` | title, description, acceptance_criteria, dev_notes, subtasks, priority, sprint, project_id |
| Story file | JSON (en memoire) | `buildStoryFile(task)` retourne `StoryFile` | acceptanceCriteria, implementationSteps, testStubs, impactedFiles |
| Blackboard sections | JSONB (Supabase `blackboard`) | `readSection(supabase, sessionId, "spec")` | spec.proto_spec (apres P1), spec.exploration (si explorer a tourne) |
| Sortie agents precedents | `AgentMessage[]` (en memoire) | `messages[]` dans la boucle orchestrate | structured (AnalystOutput, PmOutput, ArchitectOutput) |
| Feature flags | JSON fichier | `isFeatureEnabled(flag)` lit `config/features.json` | spec_phase_lite, adversarial_challenge, spec_gate |
| Agent context (Supabase) | string | `buildAgentContext(supabase, opts)` | Contexte memoire, sprint, profil, code graph |
| Code graph | JSON fichier | `getGraph()` lit `config/code-graph.json` | nodes, edges (pour E1 zero-LLM via `getImpactRadius()`) |

## 4. Donnees de sortie

### P1 — Proto-spec (stockee dans blackboard.spec.proto_spec)

Structure :
```json
{
  "objective": "string (1-2 phrases)",
  "v_criteria": [
    { "id": "V1", "description": "string testable", "level": "unit|integration|E2E" }
  ],
  "impacted_files": ["src/module.ts", "tests/unit/module.test.ts"],
  "generated_at": "ISO-8601",
  "agent_model": "claude-haiku-4-5",
  "duration_ms": 45000
}
```

Regles de remplissage :
- `objective` : derive de R2, construit depuis task.title + task.description
- `v_criteria` : 3 a 5 elements (R2), chaque description est une assertion testable avec notation `[Vx]` (R13)
- `impacted_files` : deduits depuis le story file (impactedFiles) + analyse agent
- `generated_at`, `agent_model`, `duration_ms` : metadata de tracabilite

### P2 — Rapport adversarial (stocke dans blackboard.verification.adversarial_challenge)

Structure :
```json
{
  "findings": [
    { "id": "F-DA-1", "severity": "BLOQUANT|MAJEUR|MINEUR", "title": "string", "description": "string", "source": "string" }
  ],
  "stats": { "bloquants": 0, "majeurs": 0, "mineurs": 0 },
  "verdict": "PASS|PAUSE",
  "duration_ms": 60000
}
```

Regles de remplissage :
- `verdict` : "PAUSE" si `stats.bloquants >= 1` (R7), sinon "PASS"
- `findings` : max 10 (agent constraint), parse depuis la sortie Devil's Advocate

### E1 — Rapport Impact Analyst (stocke dans blackboard.verification.impact_analysis)

Structure :
```json
{
  "risk_level": "LOW|MEDIUM|HIGH",
  "modules_impacted_direct": 2,
  "modules_impacted_transitive": 5,
  "breaking_changes": ["string"],
  "attention_points": ["string"],
  "graph_only": false,
  "duration_ms": 30000
}
```

Regles de remplissage :
- `risk_level` : LOW si modules_impacted_direct <= 1, MEDIUM si 2-3, HIGH si >= 4 (matrice de risque de `.claude/agents/impact-analyst.md`)
- `graph_only` : true si l'analyse est restee zero-LLM (< 3 fichiers impactes, R23), false si l'agent haiku a ete spawne
- `breaking_changes` et `attention_points` : vides si `graph_only`, remplis par l'agent sinon

### E2 — Quality gate utilisateur (pas de donnee de sortie persistee)

E2 ne produit pas de donnee de sortie structuree. C'est un point de pause dans le pipeline :
- Si GO (explicite ou timeout) : le pipeline continue
- Si SKIP : la proto-spec est ignoree pour les agents downstream (P3 sera saute car pas de V-criteres actifs)

### P3 — Conformance report (stocke dans blackboard.verification.conformance)

Structure : reutilise `DriftReport` de `adversarial-verifier.ts` tel quel.
- `coverage_score` : 0-100, pourcentage de V-criteres couverts
- `drift_items` : un item par V-critere avec status implemented/missing/partial/divergent
- `overall_verdict` : pass/fail/warning

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/orchestrator.ts` | modifier | Inserer les steps P1 (spec-lite), P2+E1 (adversarial + impact en parallele), E2 (quality gate utilisateur) et P3 (conformance) dans la boucle pipeline, conditionnes par feature flags. Point d'insertion P2+E1 : apres la gate evaluation d'architect (ligne ~986), avant le dev agent. Point d'insertion E2 : apres P1, avant la boucle d'agents. Point d'insertion P3 : apres le dev agent, avant qa |
| `src/auto-pipeline.ts` | modifier | Ajouter phase spec-lite entre story enrichment et analysis (si flag actif), passer proto-spec au contexte d'orchestration |
| `src/adversarial-verifier.ts` | modifier | Ajouter fonction `checkConformance(protoSpec, devOutput)` qui reutilise la logique existante de `verifySpecVsImplementation` avec V-criteres au lieu de FR-XXX. Le prompt doit etre adapte pour chercher des `[V1]`, `[V2]` au lieu de `FR-001`, `FR-002` |
| `src/pipeline-selection.ts` | non modifie | La selection de pipeline reste inchangee — P1/P2/E1/E2/P3 sont des steps supplementaires injectes dynamiquement, pas de nouveaux pipelines |
| `src/blackboard.ts` | non modifie | La section `spec` supporte deja des sous-cles arbitraires (JSONB), `proto_spec` s'y loge naturellement. La section `verification` accueille `adversarial_challenge`, `impact_analysis` et `conformance` |
| `config/features.json` | modifier | Ajouter `spec_phase_lite: false`, `adversarial_challenge: false` et `spec_gate: false` |
| `src/spec-lite.ts` | creer | Module dedie : fonction `generateProtoSpec(task, storyFile, agentContext)` qui spawn un agent haiku avec prompt spec-lite et retourne une ProtoSpec typee |
| `src/adversarial-challenge.ts` | creer | Module dedie : fonction `runAdversarialChallenge(input, agentContext)` qui spawn le Devil's Advocate et parse le rapport, retourne un AdversarialResult. Fonction `runImpactAnalysis(impactedFiles, agentContext)` qui combine code-graph zero-LLM + spawn conditionnel Impact Analyst haiku |
| `src/commands/execution.ts` | modifier | Ajouter support des flags `--skip-challenge` et `--no-confirm` dans le parser de `/orchestrate` (ligne ~224, ajouter au `.replace()` chain). Ajouter dans le message d'aide (ligne ~242) les deux nouvelles options. Ajouter callback handler pour `specgate_go:` et `specgate_skip:` (inline buttons E2) |
| `src/agent-schemas.ts` | modifier | Ajouter interfaces `ProtoSpec`, `AdversarialResult` et `ImpactAnalysisResult` dans les schemas agents |
| `tests/unit/spec-lite.test.ts` | creer | Tests unitaires pour generateProtoSpec : parsing, structure, edge cases, fallback sur echec |
| `tests/unit/adversarial-challenge.test.ts` | creer | Tests unitaires pour runAdversarialChallenge : parsing, verdict, pause condition. Tests pour runImpactAnalysis : zero-LLM path, agent spawn path, fallback |
| `tests/unit/orchestrator.test.ts` | modifier | Ajouter tests pour l'insertion conditionnelle des steps P1/P2/E1/E2/P3, tests pour --skip-challenge et --no-confirm, tests pour le timeout E2 |
| `tests/unit/adversarial-verifier.test.ts` | modifier | Ajouter tests pour checkConformance avec V-criteres au lieu de FR-XXX |

## 6. Patterns existants

### Pattern 1 : Gate evaluation avec rework loop (orchestrator.ts, lignes 980-999)

La boucle pipeline injecte deja des gates conditionels apres certains agents. Le pattern existant est :
```typescript
const gateMap: Record<string, GateName> = {
  pm: "tasks",
  architect: "plan",
  dev: "implementation",
};
const gate = gateMap[agentId];
if (gate) {
  const reworkResult = await evaluateAndRework(
    supabase, bbSessionId, agentId, gate, sectionData,
    async (feedback: string) => { /* rework callback */ }
  );
}
```
Ce pattern est directement reutilisable pour conditionner l'insertion de P2+E1 apres architect (meme point d'insertion que la gate evaluation). Le step adversarial s'execute apres la gate "plan" de l'architect, dans la meme zone du code.

### Pattern 2 : Feature flag check dans le flow (gate-evaluator.ts, ligne 24)

`isFeatureEnabled` est deja utilise dans le gate-evaluator et dans `prd-workflow.ts`. Le pattern :
```typescript
import { isFeatureEnabled } from "./feature-flags.ts";
if (isFeatureEnabled("some_flag")) { /* conditional logic */ }
```
S'applique directement aux 3 flags : `spec_phase_lite`, `adversarial_challenge`, `spec_gate`.

### Pattern 3 : Adversarial verifier post-implementation (orchestrator.ts, lignes 1314-1345)

L'adversarial verifier existe deja et s'execute apres tous les agents dans le mode blackboard :
```typescript
const pipelineTypeLabel = classifyPipeline(task);
if (pipelineTypeLabel !== "QUICK") {
  const spec = await readSection(supabase, bbSessionId, "spec");
  const impl = await readSection(supabase, bbSessionId, "implementation");
  driftReport = await verifySpecVsImplementation(spec, impl, pipelineTypeLabel);
}
```
P3 (conformance check) reutilise exactement cette logique mais avec la proto-spec au lieu de la spec complete, et insere le check AVANT QA au lieu d'apres tout le pipeline. La nouvelle fonction `checkConformance` est un wrapper adapte autour de `verifySpecVsImplementation`.

### Pattern 4 : Exploration phase prepend (orchestrator.ts, lignes 499-514)

L'exploration phase est un precedent d'injection dynamique d'agent dans le pipeline :
```typescript
if (exploreResult.score?.forceResearch && !pipeline.includes("explorer")) {
  pipeline = RESEARCH_PIPELINE;
} else if (!pipeline.includes("explorer")) {
  pipeline = ["explorer", ...pipeline] as AgentRole[];
}
```
P2+E1 s'injectent de facon analogue mais entre architect et dev plutot qu'au debut. P1 s'injecte avant la boucle d'agents (meme position que l'exploration phase).

### Pattern 5 : Agent spawn avec model specifique (orchestrator.ts, runAgentStep)

Le `runAgentStep` supporte deja des overrides de modele et d'effort. Le spec-lite agent (P1) et l'Impact Analyst (E1) reutilisent ce mecanisme avec `model: "claude-haiku-4-5"` et `effort: "low"` pour garantir la latence < 2 min.

### Pattern 6 : PRD workflow inline buttons + callbacks (commands/planning.ts, lignes 228-401)

Le PRD-to-Deploy workflow utilise des boutons inline Telegram avec callbacks `prdwf_*` pour l'interaction utilisateur :
```typescript
const keyboard = new InlineKeyboard()
  .text("Lancer l'implementation", `prdwf_launch:${prd.id.substring(0, 8)}`);
// ... callback handler:
composer.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("prdwf_")) { /* handle */ }
});
```
E2 (quality gate utilisateur) reutilise exactement ce pattern avec des callbacks `specgate_go:` et `specgate_skip:`. Le mecanisme de pause est analogue : envoyer le message avec boutons, attendre le callback, reprendre le pipeline.

### Pattern 7 : Impact radius zero-LLM (code-graph.ts, lignes 293-322)

Le module `code-graph.ts` fournit `getImpactRadius(graph, moduleId, depth)` qui retourne les modules impactes transitivement avec leur distance. Ce calcul est instantane (zero-LLM, zero-network) et fournit la base de l'analyse E1 :
```typescript
export function getImpactRadius(
  graph: CodeGraph, moduleId: string, depth: number = 3
): Array<{ module: string; distance: number }> {
  // BFS sur le graphe de dependances inverses
}
```
E1 utilise cette fonction pour le fast-path (< 3 fichiers impactes), et ne spawne l'agent haiku que si le nombre de fichiers impactes est >= 3 (R23).

## 7. Contraintes

- **Regression zero** : tous les 2690+ tests existants doivent passer sans modification quand les trois feature flags sont desactives (R12). Le comportement par defaut (flags off) est strictement identique au comportement actuel
- **Latence UX** : chaque pattern ajoute max 2 minutes au pipeline total (R11). P1 (spec-lite, haiku) vise 30-60s. P2+E1 (adversarial + impact, en parallele) vise 60-120s total (max des deux). P3 (conformance, reutilise verifier existant) vise 30-60s. E2 ajoute un temps d'attente utilisateur (max 10 min, timeout GO)
- **Pipelines non impactes** : QUICK, SOLO et REVIEW ne sont jamais modifies (R1, R18). La condition est verifiee au niveau de l'orchestrateur avant d'injecter les steps
- **Compatibilite blackboard** : les sections `spec.proto_spec`, `verification.adversarial_challenge`, `verification.impact_analysis` et `verification.conformance` utilisent le schema JSONB existant du blackboard. Pas de migration de schema necessaire
- **Type safety** : le type `AgentRole` (union type `"analyst" | "pm" | "architect" | "dev" | "qa" | "sm" | "explorer" | "planner"` dans orchestrator.ts ligne 143) ne doit PAS etre etendu avec de nouveaux roles. Les steps P1, P2, E1 et P3 sont des fonctions standalone appelees dans la boucle pipeline, pas de nouveaux agents BMad dans le type union. Cela evite de casser les exhaustive checks existants sur `AgentRole`
- **Feature flags independants** : `spec_phase_lite`, `adversarial_challenge` et `spec_gate` sont independants. P1 peut etre active sans P2. P2+E1 peuvent etre actives sans P1 (P2 utilise alors la sortie architect comme input). P3 est conditionne a P1 (pas de V-criteres sans proto-spec). E2 est conditionne a P1 (pas de proto-spec a montrer sans P1) — si `spec_gate` est actif mais `spec_phase_lite` est inactif, E2 est inoperant
- **Pas de nouvelle dependance** : les nouveaux modules (`spec-lite.ts`, `adversarial-challenge.ts`) utilisent uniquement les imports existants (`agent.ts`, `blackboard.ts`, `feature-flags.ts`, `code-graph.ts`)
- **Pas de modification du type AgentRole** : important car `AgentRole` est reexporte par `orchestrator.ts` et utilise dans 15+ fichiers. Ajouter un role casserait les switch/map exhaustifs
- **E1 ne bloque jamais le pipeline** : le rapport Impact Analyst est advisory (R17). Si l'agent haiku echoue ou timeout, le rapport est omis et le pipeline continue normalement
- **E2 ne bloque pas indefiniment** : le timeout de 10 minutes (R20) garantit que le pipeline reprend meme si l'utilisateur ne repond pas. Le timer est gere cote bot, pas cote orchestrateur

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `generateProtoSpec(task, storyFile, context)` retourne un objet ProtoSpec valide avec 3-5 V-criteres, un objectif non vide, et une liste de fichiers impactes | Test avec mock de spawnClaude retournant un JSON valide, assertion sur la structure | unit |
| V2 | `generateProtoSpec` retourne un objet ProtoSpec par defaut (objectif = titre tache, 0 V-criteres) si spawnClaude echoue (exit code != 0) | Test avec mock de spawnClaude retournant exit code 1 | unit |
| V3 | `runAdversarialChallenge(input, context)` parse correctement la sortie Devil's Advocate et retourne un AdversarialResult avec findings classes et verdict | Test avec mock retournant le format attendu du Devil's Advocate | unit |
| V4 | `runAdversarialChallenge` retourne verdict "PASS" avec 0 findings si spawnClaude echoue | Test avec mock retournant exit code 1 | unit |
| V5 | Le verdict adversarial est "PAUSE" quand `stats.bloquants >= 1` et "PASS" sinon | Test avec differentes combinaisons de findings (0 bloquant, 1 bloquant, 3 bloquants) | unit |
| V6 | `checkConformance(protoSpec, devOutput)` reutilise la logique de `verifySpecVsImplementation` et produit un DriftReport avec un item par V-critere | Test avec proto-spec a 3 V-criteres et mock d'implementation | unit |
| V7 | Quand `spec_phase_lite` est true et pipeline est DEFAULT, l'orchestrateur appelle `generateProtoSpec` avant la boucle d'agents et ecrit le resultat dans blackboard.spec.proto_spec | Test integration avec mock supabase, verifier l'ecriture blackboard | integration |
| V8 | Quand `spec_phase_lite` est false, aucun appel a `generateProtoSpec` n'est fait — le pipeline se comporte exactement comme avant | Test integration verifiant que le mock generateProtoSpec n'est jamais appele | integration |
| V9 | Quand `adversarial_challenge` est true, un step adversarial est insere entre architect et dev dans le pipeline DEFAULT | Test integration verifiant l'ordre des appels agents | integration |
| V10 | Quand l'adversarial trouve un finding bloquant, le pipeline se met en pause et `onProgress` recoit un message de pause incluant le rapport impact si disponible | Test integration avec mock adversarial retournant 1 bloquant + mock impact retournant MEDIUM | integration |
| V11 | Quand `--skip-challenge` est passe a `/orchestrate`, le step adversarial est saute meme si le flag est actif | Test du parser de commande dans execution.ts | unit |
| V12 | P1, P2, E1 et P3 sont ignores pour les pipelines QUICK, SOLO et REVIEW meme si les flags sont actifs | Test avec differents pipelines et flags actifs, verifier que les fonctions ne sont pas appelees | unit |
| V13 | P3 (conformance) est saute si P1 n'a pas produit de proto-spec (flag off ou pas de V-criteres) | Test verifiant que checkConformance n'est pas appele quand proto_spec est null | unit |
| V14 | `config/features.json` contient `spec_phase_lite: false`, `adversarial_challenge: false` et `spec_gate: false` apres la mise en place | Verification manuelle du fichier | manual |
| V15 | L'ajout des trois nouveaux flags ne modifie pas la valeur des flags existants (heartbeat, job_manager, etc.) | Test unitaire lisant le fichier features.json et verifiant toutes les valeurs | unit |
| V16 | La proto-spec P1 est injectee dans le contexte de tous les agents downstream (dev, qa) quand elle est disponible dans le blackboard | Test integration verifiant que le contexte agent contient la proto-spec | integration |
| V17 | Le rapport adversarial P2 est stocke dans blackboard.verification.adversarial_challenge | Test integration verifiant l'ecriture dans la bonne section | integration |
| V18 | Le rapport conformance P3 est stocke dans blackboard.verification.conformance | Test integration verifiant l'ecriture dans la bonne section | integration |
| V19 | `runImpactAnalysis(impactedFiles, agentContext)` retourne un ImpactAnalysisResult avec risk_level et modules_impacted quand les fichiers impactes sont >= 3 | Test avec mock code-graph retournant 5 dependants + mock spawnClaude retournant un rapport | unit |
| V20 | `runImpactAnalysis` retourne un rapport graph_only (zero-LLM) quand les fichiers impactes sont < 3, sans spawner d'agent | Test avec mock code-graph retournant 1 dependant, verifier que spawnClaude n'est pas appele | unit |
| V21 | `runImpactAnalysis` retourne un rapport LOW avec 0 modules si le code-graph n'est pas disponible ou si les fichiers impactes sont vides | Test avec mock code-graph retournant null | unit |
| V22 | E1 (Impact Analyst) et P2 (Devil's Advocate) sont lances en parallele via `Promise.all` et la duree totale du step est <= max(P2, E1) + 5s de marge | Test integration mesurant la duree avec des mocks a delai controle (P2: 100ms, E1: 50ms -> total < 200ms) | integration |
| V23 | Le rapport E1 est inclus dans le message de notification quand P2 detecte un bloquant (R7) | Test integration avec mock P2 retournant PAUSE + mock E1 retournant MEDIUM, verifier que le message onProgress contient "Impact: MEDIUM" | integration |
| V24 | Quand `spec_gate` est true et `spec_phase_lite` est true et pipeline est DEFAULT, un message Telegram avec boutons inline "GO" et "SKIP" est envoye apres P1 | Test integration verifiant que onProgress recoit le message avec le format attendu | integration |
| V25 | Quand E2 recoit le callback "GO", le pipeline reprend normalement | Test du callback handler verifiant la reprise du pipeline | integration |
| V26 | Quand E2 recoit le callback "SKIP", la proto-spec est marquee comme ignoree et P3 est saute | Test du callback handler verifiant que proto_spec.skipped = true et P3 non appele | integration |
| V27 | E2 reprend automatiquement en mode GO apres 10 minutes de timeout | Test avec timer mocke verifiant le timeout | unit |
| V28 | Quand `--no-confirm` est passe a `/orchestrate`, E2 est bypasse meme si le flag `spec_gate` est actif | Test du parser de commande dans execution.ts | unit |
| V29 | E2 est inoperant (saute silencieusement) quand `spec_gate` est actif mais `spec_phase_lite` est inactif | Test verifiant que E2 ne s'execute pas sans proto-spec | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Le probleme est clairement identifie par les explorations v1 et v2 : le workflow bot (systeme A) manque de spec formelle pre-implementation, de challenge adversarial, d'analyse d'impact, de validation utilisateur intermediaire, et de conformance check — cinq patterns presents dans le dev-pipeline (systeme B). L'evidence empirique des 3 pipelines executes (3 findings BLOQUANTS detectes avant merge) valide le ROI |
| Perimetre | Couvert | Scope strict : 5 elements (P1, P2, E1, E2, P3), 3 feature flags, insertion dans orchestrator + auto-pipeline + execution callbacks. OUT scope : unification ontologique PRD/story/spec, TDD sequence, interview utilisateur synchrone, modification des pipelines QUICK/SOLO/REVIEW, Security Checker (option C de l'exploration v2, evolution future), rapport consolide Phase 6 (evolution future) |
| Validation | Couvert | 29 V-criteres couvrant les fonctions pures (unit), l'integration dans l'orchestrateur (integration), et la configuration (manual). Pas de E2E necessaire car les agents sont mockes dans les tests |
| Technique | Couvert | Les fichiers impactes sont identifies par exploration codebase reelle. Les patterns existants (gate evaluation, feature flags, adversarial verifier, exploration prepend, PRD callbacks, code-graph impact radius) sont cites avec references exactes. Le type `AgentRole` n'est pas modifie |
| UX | Pertinent | Les patterns ajoutent de la latence au pipeline (P1: 30-60s, P2+E1: 60-120s, E2: 0s-10min, P3: 30-60s). L'utilisateur est informe via `onProgress` a chaque etape. Les bypass `--skip-challenge` et `--no-confirm` sont disponibles. E2 utilise des boutons inline Telegram (pas de texte a taper). Le format des messages suit le pattern existant plain text |
| Alternatives | Pertinent | L'exploration v2 a evalue 4 options (A: spec v1 seule, B: v1 + Impact Analyst + Phase 1b, C: scope etendu avec Security + rapport, D: refactoring complet). L'option B est retenue. Les options C et D sont explicitement exclues du perimetre. Le Security Checker conditionnel et le rapport consolide Phase 6 sont des evolutions futures apres validation en production de l'option B |

**Zones d'ombre residuelles :**

1. **Niveau minimal de proto-spec "utile"** : la spec prescrit 3-5 V-criteres. Si l'agent haiku produit systematiquement des V-criteres trop vagues pour etre exploitables par P3, il faudra iterer sur le prompt ou upgrader le modele a sonnet (au prix de la latence). A evaluer apres les premiers tests en production avec le flag actif.
2. **Latence en mode batch** : quand `maxConcurrency > 1` dans l'auto-pipeline, les patterns P1/P2+E1/E2/P3 ajoutent de la latence sequentielle non parallelisable. L'impact sur le throughput batch n'est pas mesure. A surveiller en production.
3. **Qualite du parsing adversarial** : le Devil's Advocate produit un rapport en texte structure (pas JSON). Le parsing des findings et de leur severite depend d'heuristiques regex. Si le format de sortie derive, le parsing echouera silencieusement (verdict "PASS" par defaut). Une evolution future pourrait forcer le format JSON via `outputFormat: "json"`.
4. **Fatigue de confirmation E2** : si le feature flag `spec_gate` est actif sur tous les DEFAULT pipelines (potentiellement plusieurs fois par jour), l'utilisateur peut ressentir une fatigue de confirmation. Le timeout GO automatique (10 min) et le flag `--no-confirm` attenuent ce risque, mais un mecanisme adaptatif (auto-disable apres N confirmations GO consecutives) pourrait etre ajoute en V2.
5. **Coherence E1 zero-LLM vs agent** : le seuil de 3 fichiers impactes (R23) pour decider entre zero-LLM et agent haiku est arbitraire. En production, ce seuil pourrait necessiter un ajustement base sur les retours (trop de false positives en zero-LLM pour les modifications simples multi-fichiers, ou inversement pas assez de profondeur pour les modifications complexes touchant 2 fichiers).
