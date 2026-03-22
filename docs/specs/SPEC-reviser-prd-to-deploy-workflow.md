# Spec : Reviser le workflow PRD-to-Deploy avec phases de maturation

> Genere le 2026-03-21. Source : exploration `docs/explorations/EXPLORE-reviser-prd-to-deploy-workflow.md`, code source `src/prd-workflow.ts`, `src/commands/planning.ts`, `src/spec-lite.ts`, `src/adversarial-challenge.ts`, `src/adversarial-verifier.ts`, `src/conversation-session.ts`, `src/job-manager.ts`.

## 1. Objectif

Enrichir le workflow conversationnel PRD-to-Deploy (accessible via `/prd_workflow` sur Telegram) avec les memes phases de maturation que le dev-pipeline Claude Code : spec-lite (P1), adversarial challenge (P2), impact analysis (E1) avant le lancement, et conformance check (P3) apres l'implementation. L'objectif est d'offrir a l'utilisateur Telegram une visibilite sur les quality gates — proto-spec, findings bloquants, risque d'impact, score de conformance — via un rapport consolide unique (preflight report) avant de confirmer le lancement de l'implementation batch.

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Le preflight est declenche automatiquement entre la decomposition en taches (F4) et la confirmation de lancement (F5), quand le flag `prd_maturation_phases` est active | Exploration section 5, option D | Apres `prd_approve` -> decomposition -> preflight -> bouton de confirmation |
| R2 | Le preflight execute P1 (spec-lite) sur chaque tache du PRD decompose, puis P2 (adversarial challenge) + E1 (impact analysis) en parallele sur l'ensemble du PRD. P2 recoit un `AdversarialInput` synthetique : `taskTitle = prd.title`, `taskDescription = prd.content`, `protoSpec = null`, `agentOutput = concatenation des N proto-specs (JSON.stringify)`. E1 recoit l'union des `impactedFiles` de toutes les proto-specs (ou des story files si P1 est off, cf. R5bis) | Exploration section 3 #4-6, orchestrator L.682-742/1123-1239, correction F-DA-1/F-DA-3 | P1 genere une ProtoSpec par tache, P2+E1 evaluent le PRD globalement via un input synthetique |
| R3 | Le rapport preflight consolide est presente a l'utilisateur avec deux boutons : `prdwf_preflight_ok` (continuer) et `prdwf_preflight_abort` (annuler) | Exploration section 6 | Message Telegram avec resume + boutons inline |
| R4 | Si le flag `prd_maturation_phases` est desactive, le workflow saute la phase preflight et passe directement a la confirmation de lancement (comportement actuel) | Exploration section 5, contrainte 3 | Retrocompatibilite totale avec le workflow existant |
| R5 | Si le flag `spec_phase_lite` est desactive alors que `prd_maturation_phases` est actif, P1 est sautee (pas de proto-spec) mais P2+E1 restent executees | Exploration section 5, contrainte 3, flags existants `config/features.json` | Flag granulaire |
| R5bis | Quand P1 est off (R5), E1 utilise les `impactedFiles` extraits des story files des taches (`buildStoryFile(task).impactedFiles`) comme source alternative de fichiers impactes | Correction F-DA-3 | `impactedFiles = union(tasks.map(t => buildStoryFile(t).impactedFiles))` |
| R6 | Si le flag `adversarial_challenge` est desactive alors que `prd_maturation_phases` est actif, P2+E1 sont sautees mais P1 reste executee | Exploration section 5, contrainte 3 | Flag granulaire |
| R7 | Le preflight est execute en arriere-plan via `launchJob` car la duree totale peut atteindre 150s (P1 ~60s + P2 ~90s), au-dela du timeout Telegram de 30s | Exploration section 5, contrainte 1 | Job type `prd-preflight` |
| R8 | La proto-spec generee est stockee en memoire dans une Map `pendingProtoSpecs` avec un TTL de 10 minutes, suivant le pattern existant de `pendingDescriptions` | Exploration section 5, contrainte 2, pattern prd-workflow.ts L.420-434 | `pendingProtoSpecs.set(chatKey, { protoSpec, prdId })` |
| R9 | Le rapport preflight affiche toujours les findings BLOQUANTS, affiche les findings MAJEURS s'il y en a 3 ou moins, et ne montre jamais les findings MINEURS dans le resume Telegram | Exploration section 6, question ouverte 1 | Telegram est un contexte compact |
| R10 | Quand le challenge adversarial retourne PAUSE (>= 1 finding BLOQUANT), le rapport preflight propose un troisieme bouton `prdwf_revise_prd` pour permettre a l'utilisateur de reviser le PRD sans le recreer | Exploration section 6, question ouverte 2 | L'utilisateur peut corriger le PRD puis relancer le preflight |
| R11 | [REPORTE V2] Le conformance check (P3) post-implementation est reporte en V2. Raison : les proto-specs en Map memoire (TTL 10min) ne survivent pas a la duree de l'implementation batch (potentiellement des heures) ni aux redemarrages PM2. Prerequis V2 : persister les proto-specs dans Supabase (blackboard) | Correction F-EC-1/F-SS-2/F-DA-4 | V1 se concentre sur P1+P2+E1 preflight |
| R12 | Un seul flag global `prd_maturation_phases` controle l'activation de la logique preflight dans le workflow PRD-to-Deploy. Les flags existants `spec_phase_lite` et `adversarial_challenge` controlent la mecanique interne de chaque phase. Matrice des combinaisons (correction F-SS-1) : | Exploration section 6, question ouverte 4 | Voir matrice ci-dessous |

### Matrice des feature flags (R12)

| `prd_maturation_phases` | `spec_phase_lite` | `adversarial_challenge` | Comportement |
|:-:|:-:|:-:|---|
| false | * | * | Pas de preflight, workflow inchange (defaut) |
| true | true | true | P1 + P2 + E1 complet |
| true | true | false | P1 seulement (proto-specs, pas de challenge) |
| true | false | true | P2 + E1 seulement (challenge sans proto-spec, impact via story files) |
| true | false | false | Preflight SKIPPED (toutes phases sautees, verdict SKIPPED) |
| R13 | Les nouveaux callbacks Telegram respectent la contrainte de 64 bytes : `prdwf_preflight_ok` (18 bytes), `prdwf_preflight_abort` (21 bytes), `prdwf_revise_prd` (16 bytes) | Exploration section 5, contrainte 5 | Tous sous la limite de 64 bytes |
| R14 | Le job preflight produit un result string avec le tag `PRDWF_PREFLIGHT:` suivi du prdId, du verdict, et du resume, pour integration dans `job-manager.ts` (pattern existant `PRDWF_DECOMPOSED:`) | Pattern job-manager.ts L.211-217 | `PRDWF_PREFLIGHT:{prdId}|{verdict}|{resume}` |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| PRD approuve | `PRD` (type de `src/prd.ts`) | `getPRD(supabase, prdId)` | `id`, `title`, `content`, `summary`, `project` |
| Taches decomposees | `Task[]` (type de `src/tasks.ts`) | `supabase.from("tasks").select("*").contains("tags", ["prd:{id}"])` | `id`, `title`, `description`, `acceptance_criteria`, `tags` |
| Feature flags | JSON | `isFeatureEnabled("prd_maturation_phases")`, `isFeatureEnabled("spec_phase_lite")`, `isFeatureEnabled("adversarial_challenge")` | boolean par flag |
| Session conversationnelle | `ConversationSession` | `getSession(chatId, threadId)` | `prdWorkflowStep`, `activePrdId` |
| Story files des taches | `StoryFileInput` | `buildStoryFile(task)` | `acceptanceCriteria`, `implementationSteps`, `testStubs`, `impactedFiles` |

## 4. Donnees de sortie

### 4.1 PreflightReport (structure interne)

```typescript
interface PreflightReport {
  prdId: string;
  prdTitle: string;
  /** P1: proto-specs par tache (une par tache decomposee) */
  protoSpecs: Array<{ taskId: string; taskTitle: string; spec: ProtoSpec }>;
  /** P2: resultat du challenge adversarial sur le PRD global */
  adversarial: AdversarialResult | null;
  /** E1: resultat de l'analyse d'impact */
  impact: ImpactAnalysisResult | null;
  /** Verdict consolide : PASS, PAUSE, ou SKIPPED */
  verdict: "PASS" | "PAUSE" | "SKIPPED";
  /** Duree totale du preflight en ms */
  durationMs: number;
}
```

Regles de remplissage :
- `protoSpecs` : rempli si `spec_phase_lite` est actif (R5). Sinon tableau vide.
- `adversarial` : rempli si `adversarial_challenge` est actif (R6). Sinon `null`.
- `impact` : rempli si `adversarial_challenge` est actif (R6). Sinon `null`. Lance en `Promise.all` avec P2 (R2).
- `verdict` : `PAUSE` si adversarial.verdict === "PAUSE" OU si adversarial.verdict === "SKIPPED" (prudence : un agent qui echoue ne doit pas valider le preflight, cf. correction F-DA-2). `PASS` si adversarial.verdict === "PASS" ou si P2 sautee (flag off). `SKIPPED` si tous les sous-flags sont desactives.

### 4.2 Rapport Telegram (formatPreflightReport)

Message texte plat (pas de markdown) avec sections :
```
RAPPORT PRE-LANCEMENT — {prdTitle}

Proto-spec : {taskCount} taches analysees, {totalVCriteria} V-criteres generes
Fichiers impactes : {fileCount} fichiers identifies

Challenge adversarial : {verdict}
{N} finding(s) bloquant(s), {M} finding(s) majeur(s)
{liste des findings BLOQUANTS, chacun sur une ligne avec id et titre}
{liste des findings MAJEURS si <= 3}

Analyse d'impact : risque {risk_level}
{modules_direct} modules directs, {modules_transitive} modules transitifs
{liste breaking_changes si non vide}

Duree : {durationSec}s
```

### 4.3 Rapport de conformance post-implementation [REPORTE V2]

> Reporte en V2 (cf. R11). Prerequis : persistence des proto-specs dans Supabase.

```
RAPPORT DE CONFORMANCE — {prdTitle}

Score moyen : {avgScore}% ({verdict})
{tache1} : {score1}% ({verdict1})
{tache2} : {score2}% ({verdict2})
...

{details des drift_items non-implemented si score < 80%}
```

### 4.4 Result string du job (pour job-manager)

Format : `PRDWF_PREFLIGHT:{prdId}|{verdict}|{resumeTexte}`

Exemple : `PRDWF_PREFLIGHT:c495951a|PASS|3 taches analysees, 12 V-criteres, risque LOW`

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/prd-workflow.ts` | modifier | Ajouter `runPrdPreflightChecks()`, `buildPreflightReport()`, `formatPreflightReport()`, `storePendingProtoSpec()`, `getPendingProtoSpec()`, `clearPendingProtoSpec()`, type `PreflightReport`. Note : `buildConformanceReport()` et `formatConformanceReport()` sont reportes en V2 (cf. R11) |
| `src/commands/planning.ts` | modifier | Ajouter callbacks `prdwf_preflight_ok`, `prdwf_preflight_abort`, `prdwf_revise_prd`. Modifier `prd_approve` callback pour lancer le preflight apres la decomposition. Modifier `prdwf_launch` callback pour lancer le conformance check post-batch |
| `src/conversation-session.ts` | modifier | Ajouter `"spec_preflight"` a l'union type `prdWorkflowStep` |
| `config/features.json` | modifier | Ajouter `"prd_maturation_phases": false` |
| `src/job-manager.ts` | modifier | Ajouter case `prd-preflight` dans `getCompletionKeyboard()` et `sendJobCompletionNotification()` pour gerer le tag `PRDWF_PREFLIGHT:` |
| `tests/unit/prd-workflow.test.ts` | modifier | Ajouter tests pour `runPrdPreflightChecks`, `buildPreflightReport`, `formatPreflightReport`, `storePendingProtoSpec`, `getPendingProtoSpec` (conformance reports reportes V2) |
| `tests/unit/prd-workflow-comprehensive.test.ts` | modifier | Ajouter tests pour les callbacks preflight et le flux complet avec/sans flags |

## 6. Patterns existants

### 6.1 Pattern de stockage temporaire en Map avec TTL

Le module `src/prd-workflow.ts` utilise deja ce pattern pour `pendingDescriptions` et `pendingRevisions` (lignes 420-452) :

```typescript
const pendingDescriptions = new Map<string, string>();
export function storePendingDescription(chatKey: string, description: string): void {
  pendingDescriptions.set(chatKey, description);
  setTimeout(() => pendingDescriptions.delete(chatKey), 10 * 60 * 1000);
}
```

Le meme pattern sera reutilise pour `pendingProtoSpecs: Map<string, { protoSpecs: ..., prdId: string }>`.

### 6.2 Pattern de lancement de job avec result tag

Le module `src/commands/planning.ts` lance des jobs avec des result tags structures (ligne 619) :

```typescript
return `PRDWF_DECOMPOSED:${prd.id}|${result.tasks.length}|${result.message}`;
```

Et le `src/job-manager.ts` (lignes 206-217) les consomme pour generer des boutons :

```typescript
if (job.result?.startsWith("PRDWF_DECOMPOSED:")) {
  const parts = job.result.replace("PRDWF_DECOMPOSED:", "").split("|");
  const prdId = parts[0];
  if (prdId) {
    kb.row().text("Lancer l'implementation", `prdwf_launch:${prdId.substring(0, 8)}`);
  }
}
```

Le meme pattern sera utilise pour `PRDWF_PREFLIGHT:`.

### 6.3 Pattern d'execution P1+P2+E1 en parallele

L'orchestrateur `src/orchestrator.ts` (lignes 1154-1158) execute P2 et E1 en parallele :

```typescript
const [adversarialResult, impactResult] = await Promise.all([
  runAdversarialChallenge(challengeInput, agentContextCache.get("dev")),
  runImpactAnalysis(impactedFiles, agentContextCache.get("dev")),
]);
```

Ce pattern sera reutilise dans `runPrdPreflightChecks` : P1 d'abord (car P2 utilise la proto-spec), puis P2+E1 en parallele.

### 6.4 Pattern de notification gate

Le module `src/prd-workflow.ts` (lignes 362-386) fournit `notifyGateResult` :

```typescript
export async function notifyGateResult(
  gateName: string, passed: boolean, score: number, ...
): Promise<void> {
  await enqueue({ type: "task", severity: "normal", message });
}
```

### 6.5 Pattern de formatage DriftReport pour Telegram

Le module `src/adversarial-verifier.ts` (lignes 313-331) fournit `formatDriftReport` :

```typescript
export function formatDriftReport(report: DriftReport | null): string {
  const lines: string[] = ["ADVERSARIAL VERIFICATION", ...];
  // ...format texte plat
}
```

Ce pattern sera reutilise pour le formatage du conformance report agrege.

### 6.6 Pattern de callback conditionnel dans le keyboard

Le module `src/prd-workflow.ts` (lignes 232-244) construit des keyboards avec des conditions :

```typescript
export function buildRevisionKeyboard(prd: PRD): InlineKeyboard {
  const kb = new InlineKeyboard().text("Approuver", `prd_approve:${prd.id}`);
  if (revCount < MAX_REVISIONS) {
    kb.text(`Revision (${revCount}/${MAX_REVISIONS})`, `prdwf_revise:${prd.id}`);
  }
  kb.row().text("Rejeter", `prd_reject:${prd.id}`);
  return kb;
}
```

Le meme pattern sera utilise pour le preflight keyboard avec le bouton `prdwf_revise_prd` conditionnel (seulement si verdict PAUSE).

## 7. Contraintes

### Ce qu'il ne faut PAS casser

- **Workflow existant** : quand `prd_maturation_phases` est desactive (defaut), le workflow doit se comporter exactement comme avant. Aucun changement visible pour les utilisateurs existants.
- **Callbacks existants** : les callbacks `prdwf_create`, `prdwf_task`, `prdwf_cancel`, `prdwf_revise:`, `prdwf_launch:`, `prdwf_merge:` doivent continuer a fonctionner.
- **Tests existants** : les 4 fichiers de test existants (`prd-workflow.test.ts`, `prd-workflow-integration.test.ts`, `prd-workflow-comprehensive.test.ts`, `prd-workflow-e2e-junctions.test.ts`) ne doivent pas casser. L'ajout de `"spec_preflight"` au type `prdWorkflowStep` ne devrait pas affecter les tests existants.
- **Job manager** : l'ajout de `prd-preflight` comme nouveau type de job ne doit pas impacter les jobs existants.
- **Feature flags** : les flags `spec_phase_lite` et `adversarial_challenge` existants controlent leur mecanique respective independamment de `prd_maturation_phases`.

### Limites techniques

- **Timeout Telegram** : les handlers de callback doivent repondre en < 30s. Toute operation longue (preflight, conformance) doit etre lancee via `launchJob`.
- **Callback data <= 64 bytes** : les nouveaux noms de callback sont verifies (max 21 bytes pour `prdwf_preflight_abort`).
- **TTL session 2h** : la session `ConversationSession` a un TTL de 2h. Le preflight doit etre complete dans ce delai. Le TTL de 10 minutes pour `pendingProtoSpecs` est suffisant pour le cas d'usage (l'utilisateur decide dans les minutes qui suivent la notification).
- **Concurrence** : `runPrdPreflightChecks` peut etre execute en parallele pour differents PRD. Les Maps de stockage sont indexees par chatKey, pas par prdId. Il n'y a pas de risque de collision si un seul preflight est en cours par chat/thread.

### Dependances

- `src/spec-lite.ts` : `generateProtoSpec(task, storyFile, agentContext)` — fonction standalone, pas de modification requise.
- `src/adversarial-challenge.ts` : `runAdversarialChallenge(input)`, `runImpactAnalysis(files)` — fonctions standalone, pas de modification requise. L'input synthetique pour le PRD global est construit cote appelant (cf. R2).
- `src/adversarial-verifier.ts` : `checkConformance(protoSpec, devOutput, pipelineType)`, `formatDriftReport(report)` — fonctions standalone, pas de modification requise.
- `src/story-files.ts` : `buildStoryFile(task)` — pour generer les story files avant P1.
- `src/feature-flags.ts` : `isFeatureEnabled(flag)` — deja en place.
- `src/notification-queue.ts` : `enqueue(notification)` — deja en place.

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `runPrdPreflightChecks` retourne un `PreflightReport` valide avec `protoSpecs`, `adversarial`, `impact`, et `verdict` quand les deux sous-flags sont actifs | Test unitaire avec mocks de `generateProtoSpec`, `runAdversarialChallenge`, `runImpactAnalysis` | unit |
| V2 | `runPrdPreflightChecks` saute P1 (proto-spec) quand `spec_phase_lite` est desactive mais `prd_maturation_phases` est actif, et retourne `protoSpecs: []` | Test unitaire avec mock de `isFeatureEnabled` retournant false pour `spec_phase_lite` | unit |
| V3 | `runPrdPreflightChecks` saute P2+E1 quand `adversarial_challenge` est desactive mais `prd_maturation_phases` est actif, et retourne `adversarial: null`, `impact: null` | Test unitaire avec mock de `isFeatureEnabled` retournant false pour `adversarial_challenge` | unit |
| V4 | `runPrdPreflightChecks` retourne `verdict: "SKIPPED"` quand les deux sous-flags (`spec_phase_lite` et `adversarial_challenge`) sont desactives | Test unitaire verifiant le verdict | unit |
| V5 | `runPrdPreflightChecks` retourne `verdict: "PAUSE"` quand le challenge adversarial retourne un finding BLOQUANT | Test unitaire avec mock de `runAdversarialChallenge` retournant `verdict: "PAUSE"` | unit |
| V5bis | `runPrdPreflightChecks` retourne `verdict: "PAUSE"` quand le challenge adversarial retourne `verdict: "SKIPPED"` (agent en echec = prudence, cf. F-DA-2) | Test unitaire avec mock de `runAdversarialChallenge` retournant `verdict: "SKIPPED"` | unit |
| V6 | `formatPreflightReport` produit un message texte plat sans markdown, incluant les sections proto-spec, challenge, impact, et duree | Test unitaire verifiant la structure du texte et l'absence de caracteres markdown (`*`, `_`, `` ` ``) | unit |
| V7 | `formatPreflightReport` affiche les findings BLOQUANTS toujours, les MAJEURS si <= 3, et jamais les MINEURS (R9) | Test unitaire avec un rapport contenant 1 BLOQUANT, 4 MAJEURS, 2 MINEURS : seul le BLOQUANT est affiche | unit |
| V8 | `storePendingProtoSpec` et `getPendingProtoSpec` suivent le pattern TTL 10 minutes : la valeur est recuperable immediatement, et supprimee apres expiration | Test unitaire avec timer mock | unit |
| V9 | Le callback `prdwf_preflight_ok` dans `planning.ts` lance `runBatchPipeline` via `launchJob` avec les taches du PRD | Test d'integration mockant le job-manager et verifiant l'appel a `launchJob` avec le bon type et les bonnes taches | integration |
| V10 | Le callback `prdwf_preflight_abort` annule le workflow et envoie un message de confirmation d'annulation | Test d'integration verifiant `ctx.editMessageText` et le nettoyage de `pendingProtoSpecs` | integration |
| V11 | Le callback `prdwf_revise_prd` redirige vers le flow de revision PRD existant (pattern `prdwf_revise:`) en passant le `prdId` | Test d'integration verifiant le stockage dans `pendingRevisions` et le message d'instruction | integration |
| V12 | Quand `prd_maturation_phases` est desactive, le flux `prd_approve` -> decompose -> `prdwf_launch` est inchange (retrocompatibilite) | Test d'integration reproduisant le workflow complet avec `prd_maturation_phases: false` | integration |
| V13 | Le type `prdWorkflowStep` dans `conversation-session.ts` accepte la valeur `"spec_preflight"` sans casser les valeurs existantes | Test unitaire verifiant que les 6 valeurs existantes + la nouvelle sont valides | unit |
| V14 | Le job type `prd-preflight` dans `job-manager.ts` genere les boutons `prdwf_preflight_ok` et `prdwf_preflight_abort` a la completion du job | Test unitaire mockant un job complete avec result tag `PRDWF_PREFLIGHT:` et verifiant les boutons generes | unit |
| V15 | Le job type `prd-preflight` avec verdict PAUSE genere un troisieme bouton `prdwf_revise_prd` en plus des deux boutons standard | Test unitaire verifiant les 3 boutons quand le result tag contient `|PAUSE|` | unit |
| V16 | [REPORTE V2] `buildConformanceReport` — reporte avec R11 | - | - |
| V17 | [REPORTE V2] `formatConformanceReport` — reporte avec R11 | - | - |
| V18 | Le nouveau flag `prd_maturation_phases` est present dans `config/features.json` avec la valeur par defaut `false` | Verification directe du fichier JSON | unit |
| V19 | Le preflight est execute en arriere-plan via `launchJob` et ne bloque pas le handler Telegram (duree < 2s pour le handler, execution reelle en background) | Test d'integration verifiant que `launchJob` est appele et que `ctx.editMessageText` est appele immediatement | integration |
| V20 | Apres un `prdwf_preflight_abort`, un nouveau `/prd_workflow` sur le meme chat demarre un workflow frais sans artefacts residuels | Test d'integration verifiant le nettoyage de toutes les Maps de stockage temporaire | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Le workflow PRD-to-Deploy ne presente pas les quality gates (spec-lite, adversarial, conformance) a l'utilisateur Telegram. Ces phases existent dans l'orchestrateur mais sont invisibles. |
| Perimetre | Couvert | IN : preflight P1+P2+E1 avant lancement, conformance P3 apres implementation, 3 nouveaux callbacks, 1 nouveau flag. OUT : modification des agents eux-memes, modification de l'orchestrateur, nouveau UI dashboard. |
| Validation | Couvert | 20 V-criteres couvrant les fonctions preflight, formatage, stockage, callbacks, retrocompatibilite, flags granulaires, et conformance post-implementation. |
| Technique | Couvert | Architecture fondee sur les patterns existants (Map TTL, job tags, callback keyboards). Dependances identifiees, toutes standalone. Pas de nouvelle dependance externe. |
| UX | Pertinent | L'utilisateur recoit un rapport consolide unique (preflight) avec 2-3 boutons de decision. Le workflow ajoute un seul checkpoint conversationnel supplementaire. Le rapport est en texte plat (contrainte Telegram). Les findings sont filtres par severite pour la lisibilite (R9). |
| Alternatives | Pertinent | 4 options evaluees dans l'exploration (A: status quo, B: integration transparente, C: etapes conversationnelles explicites, D: module pre-launch dedie). Option D retenue car elle minimise les interactions supplementaires tout en maximisant la visibilite. Option C ecartee car trop fragmentee. Option B ecartee car pas de rapport consolide. |

**Zones d'ombre residuelles** :

1. **Aggregation P1 multi-taches** : quand un PRD est decompose en N taches, le preflight genere N proto-specs. La question de savoir s'il faut executer l'adversarial challenge une fois par tache ou une fois globalement sur l'ensemble du PRD est tranchee en faveur du challenge global (R2), mais l'alternative par-tache pourrait etre envisagee en V2 si les PRD sont tres heterogenes.

2. **Relance du preflight apres revision** : apres un `prdwf_revise_prd`, l'utilisateur revise le PRD. Faut-il re-decomposer en taches ET relancer le preflight ? La spec suppose que oui (le PRD revise passe par le meme flux que l'approbation initiale), mais cela double le temps de traitement. A valider pendant l'implementation.

3. **Proto-spec en memoire vs Supabase** : la proto-spec est stockee dans une Map en memoire avec TTL 10 minutes. Si le bot redemarrait entre la generation du preflight et la confirmation par l'utilisateur, la proto-spec serait perdue. Le TTL de 10 minutes est suffisant pour le bouton de confirmation (l'utilisateur decide dans les minutes qui suivent). Le conformance check (P3) est reporte en V2 car il necessite une persistence longue duree (implementation batch = heures). V2 : persister dans Supabase (blackboard).
