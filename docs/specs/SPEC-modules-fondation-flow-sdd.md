---
phase: 1-spec
status: draft
generated_at: "2026-03-24T12:00:00Z"
subject: "Phase 2 Architecture V2 — Modules fondation du flow conversationnel SDD avec boutons"
decisions:
  - Q1: Types autonomes dans conversation-handoff.ts (pas de couplage conversation-session.ts)
  - Q2: Nouveau Composer commands/sdd-flow.ts pour les callbacks sdd_*
  - Q3: Nommage pipeline par string processing kebab-case sur la description initiale
  - Q4: Detection convergence par regex sur la reponse Claude (format instructe par le system prompt)
input_exploration: docs/explorations/EXPLORE-phase-2-modules-fondation-flow.md
---

# SPEC — Modules fondation du flow conversationnel SDD

## Section 1 — Objectif

Creer les trois composants fondation de la Phase 2 de l'Architecture V2 : `pipeline-tracker.ts` (suivi d'etat du pipeline SDD par chat avec persistence disque), `conversation-handoff.ts` (extraction d'un resume structure des decisions conversationnelles pour le passer aux agents background), et `commands/sdd-flow.ts` (nouveau Composer grammY gerant les callbacks InlineKeyboard SDD et la construction des claviers contextuels). Ces modules constituent le pont critique entre le canal conversation (ephemere) et le canal agents (persistent) et sont le prerequis bloquant pour les Phases 3-5 de l'Architecture V2.

Source : docs/ARCHITECTURE-V2.md Phase 2, decisions conversationnelles Q1-Q4.

---

## Section 2 — Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Le nom du pipeline est derive par string processing kebab-case (5 etapes) a partir de la description initiale : lowercase → NFD normalize → strip diacritics → strip non-alphanum → collapse hyphens → trim hyphens | Decision Q3 | "Refactoring memoire permanente" → "refactoring-memoire-permanente" |
| R2 | La cle de stockage du tracker est `${chatId}:${threadId}` pour un forum thread, `${chatId}:main` pour un chat prive | Exploration F5, pattern conversation-session.ts | chatId=12345, threadId=67 → "12345:67" |
| R3 | Un tracker expire apres 7 jours sans mise a jour (TTL base sur `updatedAt`) | Exploration F5, ARCHITECTURE-V2.md (reprise possible) | tracker.updatedAt < Date.now() - 7j → expiry |
| R4 | `getTracker()` retourne `null` si le pipeline est inconnu ou expire. Les callbacks `sdd_*` doivent verifier ce cas avant de lancer un agent | Decision Q2, Contrainte supplementaire | callback sdd_spec clique sur message de 8 jours → reponse "Pipeline expire" |
| R5 | La persistence utilise atomic write (tmp → rename) sur `RELAY_DIR/pipelines.json`. En cas d'echec IO, degrader gracieusement (log.error, ne pas propager). Limitation V1 : une seule pipeline active par chat (pas de protection concurrence multi-pipeline) | Challenge F-EC-1, Pattern job-manager.ts lignes 134-144 | IO error lors de saveJobs → log.error, pas de crash |
| R5b | L'API publique inclut `updateStep(chatId, threadId, phase, updates)` pour mettre a jour un step du tracker (status, artifact, summary, jobId). Met a jour `updatedAt` automatiquement | Challenge F-EC-4 | updateStep(123, undefined, 'explore', { status: 'ok', artifact: '...' }) |
| R6 | `formatStatusBar()` produit du plain-text uniquement (convention Telegram du projet), 6 phases (explore, discuss, spec, challenge, implement, review), symboles : OK / EN COURS / -- | ARCHITECTURE-V2.md exemple status bar | "Pipeline 'refactoring-memoire'\n  OK Exploration (GO)...\n  EN COURS Spec..." |
| R7 | `assembleHandoffContext()` assemble le contexte pour l'agent background SANS appel LLM : messages recents (via getRecentMessages ou parametre), reference exploration, reference spec. Pas de callClaude dans un callback — le spec-architect fait sa propre extraction | Challenge F-DA-1 BLOQUANT, Decision Q1 | assembleHandoffContext(recentMessages, { explorationRef }) → HandoffSummary |
| R8 | Le HandoffSummary contient 6 champs canoniques (objective, decisions, constraints, filesIdentified, resolvedQuestions, outOfScope). Le champ objective est derive de la description pipeline, les decisions/constraints sont extraits par pattern matching sur les messages recents (regex sur "[DECIDE]", "[CONTRAINTE]" ou equivalent). Si aucun pattern trouve, les arrays sont vides — l'agent fera sa propre analyse | Challenge F-DA-1 BLOQUANT, Exploration section handoff | messages contenant "on fait X" → decisions: ["X"] |
| R9 | `sdd-flow.ts` est un Composer grammY independant. Son handler `callback_query:data` utilise le prefixe `sdd_` avec guard + `next()` si non concerne (pattern etabli dans 9 fichiers du projet) | Decision Q2, pattern jobs.ts lignes 88-108 | data.startsWith("sdd_") ? handle : next() |
| R10 | zz-messages.ts detecte la convergence de la discussion par regex sur la reponse de Claude. Le system prompt conversationnel instruit Claude de produire le format reconnaissable "Decisions: ...\nProchaine etape: ..." quand la conversation converge | Decision Q4 | Regex: /^Decisions:/m sur la reponse Claude |
| R11 | Les boutons SDD sont des accelerateurs : les commandes /dev-explore, /dev-spec, /dev-challenge, /dev-implement restent disponibles comme fallback | ARCHITECTURE-V2.md Reprise et Fallback | Bouton [Explorer] = raccourci vers /dev-explore |
| R12 | `_clearForTests()` est exporte depuis `pipeline-tracker.ts` pour les tests unitaires (pattern etabli : _clearMemoryStore dans pipeline-state.ts, _resetSessions dans conversation-session.ts) | Contrainte supplementaire, pipeline-state.ts ligne 43 | beforeEach(() => _clearForTests()) |
| R13 | Les callbacks `sdd_explore`, `sdd_spec`, `sdd_challenge`, `sdd_implement`, `sdd_review`, `sdd_discuss` lancent les agents ou mettent a jour le tracker via `launch()` de job-manager.ts. Le type de job utilise le nom de l'etape (ex: "sdd-explore"). Le callback `sdd_discuss` met a jour le step 'discuss' en status 'ok' sans lancer de job | Challenge F-DA-3, Decision Q2, pattern exploration.ts lignes 206-210 | launch("sdd-explore", chatId, exploreFn, { messageThreadId }) |
| R14 | `buildSddKeyboard(phase, name, verdict?)` construit le clavier contextuel selon la phase courante et le verdict de l'etape precedente. Verdicts GO/PIVOT/DROP de l'exploration et GO/GO_WITH_CHANGES/NO-GO du challenge suppriment les boutons d'action pertinents | ARCHITECTURE-V2.md etapes 1, 4 | Verdict DROP → pas de bouton [Specifier] |
| R15 | `conversation-handoff.ts` ne doit importer aucun module marque "Supprime" dans ARCHITECTURE-V2.md (orchestrator/, blackboard.ts, agent-schemas.ts, etc.) | Contrainte supplementaire | Import de orchestrator.ts interdit |
| R16 | `pipeline-tracker.ts` ne doit importer aucun module marque "Supprime" dans ARCHITECTURE-V2.md | Contrainte supplementaire | Import de pipeline-state.ts ou orchestrator.ts interdit |

---

## Section 3 — Donnees d'entree

| Source | Type | Acces | Champs |
|--------|------|-------|--------|
| Telegram InlineKeyboard callback | `ctx.callbackQuery.data` | grammY Composer | Prefixe "sdd_", format "sdd_{etape}:{name}" |
| Conversation courante (handoff) | `string` | Parametre `conversationHistory` de `extractHandoffSummary` | Messages formates (user/assistant) |
| Fichier disque `pipelines.json` | `Record<string, PipelineTracker>` | `fs/promises readFile` | cle: `${chatId}:${threadId|'main'}`, valeur: PipelineTracker |
| Reponse Claude (detection convergence) | `string` | Retour de `callClaude` dans zz-messages.ts | Format "Decisions: ...\nProchaine etape: ..." |
| Options de lancement bouton | `{ chatId: number, threadId?: number, pipelineName: string }` | ctx.chat.id, ctx.callbackQuery.message.message_thread_id | Identifies dans le callback data |
| Artefacts de reference | `{ explorationRef?: string, specRef?: string }` | Parametre options de extractHandoffSummary | Chemins relatifs docs/explorations/ ou docs/specs/ |

---

## Section 4 — Donnees de sortie

### pipeline-tracker.ts

**Type `PipelineTracker`** :
```
{
  chatId: number,
  threadId?: number,
  name: string,              // kebab-case derive de la description (R1)
  steps: Record<SddPhase, PipelineStep>,
  createdAt: string,         // ISO 8601
  updatedAt: string,         // ISO 8601, sert de base pour TTL R3
}
```

**Type `PipelineStep`** :
```
{
  phase: SddPhase,           // 'explore'|'discuss'|'spec'|'challenge'|'implement'|'review'
  status: StepStatus,        // 'pending'|'running'|'ok'|'failed'
  artifact?: string,         // chemin fichier produit (ex: "docs/explorations/EXPLORE-foo.md")
  summary?: string,          // resume court (ex: "GO — 3 alternatives")
  jobId?: string,            // ref job-manager pour correlation
  startedAt?: string,
  completedAt?: string,
}
```

**`formatStatusBar(tracker)`** retourne un string plain-text sur le modele :
```
Pipeline « {name} »
  OK Exploration (GO) — EXPLORE-{name}.md
  OK Discussion — 3 decisions
  EN COURS Spec...
  -- Challenge
  -- Implementation
  -- Review
```

Regles de remplissage :
- `OK` si status = 'ok', `EN COURS` si status = 'running', `--` si status = 'pending', `ECHEC` si status = 'failed'
- L'artifact et le summary sont affiches si presents

### conversation-handoff.ts

**Type `HandoffSummary`** :
```
{
  objective: string,
  decisions: string[],
  constraints: string[],
  filesIdentified: string[],
  resolvedQuestions: string[],
  outOfScope: string[],
  explorationRef?: string,
  specRef?: string,
}
```

**`formatHandoffForAgent(summary)`** retourne un string formate pour injection dans le prompt agent :
```
RESUME DES DECISIONS CONVERSATIONNELLES

Objectif: {objective}

Decisions:
- {decision 1}
- {decision 2}

Contraintes:
- {constraint 1}

Fichiers identifies: {filesIdentified.join(', ')}

Questions resolues:
- {question 1}

Hors scope: {outOfScope.join(', ')}

Reference exploration: {explorationRef | 'aucune'}
Reference spec: {specRef | 'aucune'}
```

### commands/sdd-flow.ts

Composer grammY qui :
1. Gere les callbacks `sdd_*` (R9) avec verification via `getTracker()` (R4)
2. Lance les agents via `launch()` de job-manager (R13)
3. Repond par plain-text en cas de pipeline expire/inconnu
4. Exporte `buildSddKeyboard(phase, name, verdict?)` : retourne un `InlineKeyboard` ou `undefined` selon la phase et le verdict

**`buildSddKeyboard` regles** :
- Phase 'explore' : boutons [Explorer] → callback `sdd_explore:{name}`, [Discuter sans explorer] → callback `sdd_discuss:{name}`
- Post-exploration verdict GO : [Discuter les resultats] + [Specifier]
- Post-exploration verdict PIVOT : [Re-explorer] + [Discuter] (pas de [Specifier])
- Post-exploration verdict DROP : aucun bouton d'action
- Phase 'discuss' + convergence : [Formaliser en spec] + [Continuer]
- Post-spec : [Challenger] + [Implementer direct] + [Reviser la spec]
- Post-challenge GO : [Implementer]
- Post-challenge GO_WITH_CHANGES : [Implementer avec corrections] + [Corriger la spec d'abord]
- Post-challenge NO-GO : [Discuter les findings] + [Retravailler la spec] (pas de [Implementer])
- Post-implement : [Review] + [Merger] + [Corriger]

---

## Section 5 — Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `src/pipeline-tracker.ts` | Creer (nouveau) | Module de suivi d'etat pipeline SDD par chat, persistence disque, status bar — remplace pipeline-state.ts sans ses dependances orchestrateur |
| `src/conversation-handoff.ts` | Creer (nouveau) | Extraction du resume structure des decisions conversationnelles pour les agents background — pont conversation → agent |
| `src/commands/sdd-flow.ts` | Creer (nouveau) | Composer grammY pour les callbacks InlineKeyboard SDD (prefixe sdd_) et construction des claviers contextuels |
| `src/commands/zz-messages.ts` | Modifier | Ajouter : (1) import buildSddKeyboard de sdd-flow, (2) CONVERGENCE_PATTERNS regex sur la reponse Claude, (3) logique d'affichage du clavier SDD quand convergence detectee. Fichier actuellement 909 LOC |
| `src/relay.ts` | Modifier (mineur) | Ajouter import et appel `initPipelineTracker()` dans le bloc de startup si un init est necessaire (analogue a initSessions) |
| `src/job-manager.ts` | Modifier (mineur) | Ajouter cases 'sdd-explore', 'sdd-spec', 'sdd-challenge', 'sdd-implement', 'sdd-review' dans `getCompletionKeyboard()` switch — pour le clavier post-completion |
| `tests/unit/pipeline-tracker.test.ts` | Creer (nouveau) | Tests unitaires de pipeline-tracker (createPipeline, updateStep, getTracker, formatStatusBar, TTL, expiry) |
| `tests/unit/conversation-handoff.test.ts` | Creer (nouveau) | Tests unitaires de conversation-handoff (extractHandoffSummary mock LLM, formatHandoffForAgent) |
| `tests/unit/sdd-flow.test.ts` | Creer (nouveau) | Tests du Composer sdd-flow (buildSddKeyboard, guard pipeline expire, prefixe sdd_) |

**Fichiers verifies existants** :
- `src/job-manager.ts` : 588 LOC, existe, API `launch()` stable
- `src/conversation-session.ts` : 481 LOC, existe, marque "Supprime" dans ARCHITECTURE-V2 — les types seront redifinis dans conversation-handoff.ts (Decision Q1)
- `src/pipeline-state.ts` : 258 LOC, existe, marque "Supprime" — ne pas importer
- `src/commands/zz-messages.ts` : 909 LOC, existe, PROPOSAL_PATTERNS + detectProposalInResponse() = modele direct pour CONVERGENCE_PATTERNS

---

## Section 6 — Patterns existants

**Pattern 1 — Persistence disque atomic write** (`src/job-manager.ts` lignes 134-144, `src/conversation-session.ts` lignes 120-129) :
```typescript
async function savePipelines(): Promise<void> {
  try {
    await mkdir(RELAY_DIR, { recursive: true });
    const tmp = PIPELINES_FILE + `.tmp.${crypto.randomUUID().substring(0, 8)}`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, PIPELINES_FILE);
  } catch (error) {
    log.error("Pipeline persistence error", { error: String(error) });
  }
}
```

**Pattern 2 — Guard prefixe callback avec next()** (`src/commands/jobs.ts` lignes 88-113) :
```typescript
composer.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("sdd_")) {
    await next();
    return;
  }
  // ... handle sdd_ callbacks
});
```

**Pattern 3 — Lancement agent via job-manager** (`src/commands/exploration.ts` lignes 206-210) :
```typescript
const jobId = await launchJob("explore", chatId, exploreFn, { messageThreadId: threadId });
await ctx.reply(`Job lance explore (id: ${jobId})\nQuery: ${query}`, bctx.threadOpts(ctx));
```

**Pattern 4 — Conversion slug kebab-case** (`src/commands/project.ts` lignes 74-79) :
```typescript
const slug = argument
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
```
A adapter pour `toPipelineName(description: string): string`.

**Pattern 5 — Detection regex sur reponse Claude** (`src/commands/zz-messages.ts` lignes 69-88, `detectProposalInResponse`) :
Modele direct pour `detectConvergenceInResponse(response: string): ConvergenceSignal | null` avec CONVERGENCE_PATTERNS.

**Pattern 6 — InlineKeyboard contextuel** (`src/prd-workflow.ts`, `buildRevisionKeyboard()`) :
Construction InlineKeyboard selon l'etat, retourne l'objet pret a injecter dans `reply_markup`.

**Pattern 7 — Test _clearForTests** (`src/pipeline-state.ts` ligne 43, `src/conversation-session.ts` ligne 474) :
```typescript
export function _clearForTests(): void {
  pipelines.clear();
  persistLoaded = false; // force reload disk on next access
}
```

---

## Section 7 — Contraintes

### Ne pas casser

- `bun test` doit passer a 100% avant et apres (4035 tests actuellement)
- Le pipeline de lancement de jobs via job-manager.ts reste inchange (API `launch()`, `Job`, `LaunchOptions`)
- Le handler `callback_query:data` de zz-messages.ts (prefixe `intent_`) reste fonctionnel et prioritaire
- La chaine de middleware grammY fonctionne : chaque Composer appelle `next()` si le callback ne lui appartient pas
- `src/relay.ts` startup sequence : tout nouvel init est appele dans le bloc de startup existant (ligne 147-151)

### Limites techniques

- `conversation-handoff.ts` ne doit PAS importer de modules marques "Supprimes" dans ARCHITECTURE-V2.md
- `pipeline-tracker.ts` ne doit PAS importer de modules marques "Supprimes" dans ARCHITECTURE-V2.md
- `callClaude` dans extractHandoffSummary : pas de `resume: true` (Decision Q1 + Contrainte supplementaire)
- zz-messages.ts depasse deja 909 LOC — les additions doivent etre minimales (< 50 LOC), la logique substantielle va dans sdd-flow.ts
- Les reponses Telegram sont en plain-text uniquement, pas de markdown
- La detection de convergence est un best-effort : si le regex echoue, l'utilisateur peut toujours taper une commande /dev-* (R11)
- TTL 7 jours sur les trackers (R3) : les boutons sur des messages anciens doivent produire un message d'expiry clair
- Semaphore job-manager : max 3 jobs concurrents (existant, pas a modifier)

### Dependances

- grammY : `Composer`, `InlineKeyboard`, `Context` — stable
- Bun runtime : `fs/promises` (mkdir, readFile, rename, writeFile), `crypto.randomUUID()`
- `src/job-manager.ts` : `launch`, `isJobManagerEnabled`, `sendProgressMessage` — API stable
- `src/logger.ts` : `createLogger` — stable
- `src/bot-context.ts` : `BotContext`, `callClaude` signature — stable
- `process.env.RELAY_DIR` : convention partagee avec job-manager et conversation-session

---

## Section 8 — Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `toPipelineName("Refactoring memoire permanente")` retourne `"refactoring-memoire-permanente"` | Test unitaire pipeline-tracker : assert string output | unit |
| V2 | `toPipelineName("Phase 2 : Creer les modules (avec accents)")` retourne `"phase-2-creer-les-modules-avec-accents"` | Test unitaire pipeline-tracker : diacritics + ponctuation | unit |
| V3 | `createPipeline(chatId, undefined, name)` cree un tracker avec 6 steps tous en status 'pending' | Test unitaire pipeline-tracker : steps initiaux | unit |
| V4 | Cle de stockage pour threadId=67 est `"12345:67"`, pour threadId=undefined est `"12345:main"` | Test unitaire pipeline-tracker : cle de storage | unit |
| V5 | `getTracker(chatId, threadId)` retourne `null` apres TTL 7 jours (simuler updatedAt = now - 8j) | Test unitaire pipeline-tracker : TTL expiry | unit |
| V6 | `formatStatusBar` produit le bon symbole pour chaque statut : 'ok' → 'OK', 'running' → 'EN COURS', 'pending' → '--', 'failed' → 'ECHEC' | Test unitaire pipeline-tracker : 4 cas | unit |
| V7 | `formatStatusBar` affiche l'artifact quand present dans le PipelineStep | Test unitaire pipeline-tracker : artifact display | unit |
| V8 | Persistence disque : `createPipeline()` puis `_clearForTests()` puis `getTracker()` charge depuis le fichier disque | Test unitaire pipeline-tracker : round-trip persistence | unit |
| V9 | `_clearForTests()` vide le store in-memory et force un reload depuis disque au prochain `getTracker()` | Test unitaire pipeline-tracker | unit |
| V10 | `assembleHandoffContext` avec des messages contenant des decisions retourne un `HandoffSummary` avec decisions peuplees | Test unitaire conversation-handoff : extraction decisions | unit |
| V11 | `assembleHandoffContext` avec des messages sans pattern reconnu retourne un HandoffSummary avec arrays vides et objective = nom du pipeline | Test unitaire conversation-handoff : cas vide | unit |
| V12 | `formatHandoffForAgent` produit un string contenant "Objectif:", "Decisions:", "Contraintes:", "Hors scope:" | Test unitaire conversation-handoff : sections presentes | unit |
| V13 | Le Composer sdd-flow appelle `next()` quand le callback data ne commence pas par "sdd_" | Test unitaire sdd-flow : guard prefixe | unit |
| V14 | `sdd_spec:{name}` sur un pipeline inconnu (getTracker = null) produit une reponse "Pipeline inconnu ou expire" et NE lance pas de job | Test unitaire sdd-flow : guard tracker null | unit |
| V15 | `sdd_spec:{name}` sur un pipeline expire (updatedAt = now - 8j) produit une reponse "Pipeline expire" et NE lance pas de job | Test unitaire sdd-flow : guard TTL | unit |
| V16 | `buildSddKeyboard('explore', 'foo', undefined)` retourne un InlineKeyboard avec boutons [Explorer] et [Discuter sans explorer] | Test unitaire sdd-flow : keyboard initial | unit |
| V17 | `buildSddKeyboard('explore', 'foo', 'DROP')` retourne un InlineKeyboard sans bouton [Specifier] | Test unitaire sdd-flow : verdict DROP | unit |
| V18 | `buildSddKeyboard('challenge', 'foo', 'NO-GO')` retourne un InlineKeyboard sans bouton [Implementer] | Test unitaire sdd-flow : verdict NO-GO | unit |
| V19 | `detectConvergenceInResponse` retourne non-null quand la reponse Claude contient `\nDecisions:` | Test unitaire (function exportee de zz-messages ou sdd-flow) | unit |
| V20 | `detectConvergenceInResponse` retourne null sur une reponse conversationnelle normale sans le pattern | Test unitaire : false positive prevention | unit |
| V21 | Les modules pipeline-tracker.ts et conversation-handoff.ts ne contiennent aucun import depuis orchestrator/, blackboard.ts, agent-schemas.ts | Verification statique : grep sur les imports des fichiers crees | unit |
| V22 | Le Composer sdd-flow est charge par loader.ts (charge auto depuis src/commands/) | Test integration : le Composer enregistre ses handlers au startup | integration |
| V23 | Un click sur [Specifier] dans le chat Telegram lance un job de type "sdd-spec" dans job-manager | Test integration : callback sdd_spec, mock launchJob, verify job.type | integration |
| V24 | La status bar s'affiche en plain-text apres completion d'un job SDD (pas de markdown, pas d'asterisques) | Verification manuelle en environnement de test | manual |

---

## Section 9 — Coverage et zones d'ombre

### Matrice des dimensions

| Dimension | Couvert | Niveau | Remarque |
|-----------|---------|--------|----------|
| Persistence disque — happy path | Oui | unit (V8) | Round-trip create → clear → reload |
| Persistence disque — IO failure | Oui | unit implicite (R5 : log.error + degrade) | Test a ajouter dans pipeline-tracker.test.ts |
| TTL expiry | Oui | unit (V5, V15) | 7 jours |
| Callbacks SDD — pipeline connu | Oui | integration (V23) | |
| Callbacks SDD — pipeline inconnu/expire | Oui | unit (V14, V15) | |
| Detection convergence — true positive | Oui | unit (V19) | |
| Detection convergence — false positive | Oui | unit (V20) | |
| Keyboard contextuel — verdicts GO/PIVOT/DROP | Oui | unit (V16, V17) | |
| Keyboard contextuel — verdict NO-GO | Oui | unit (V18) | |
| Keyboard contextuel — phases intermediaires | Partiel | unit | discuss, spec, implement a tester |
| extractHandoffSummary — JSON valide | Oui | unit (V10) | |
| extractHandoffSummary — JSON invalide | Oui | unit (V11) | |
| Import interdit depuis modules Supprimes | Oui | unit statique (V21) | |
| Chargement Composer par loader.ts | Oui | integration (V22) | |
| Affichage plain-text Telegram | Oui | manual (V24) | |
| Concurrence jobs (semaphore max 3) | Non specifie | — | Herite de job-manager.ts, pas de nouveau comportement |

### Alternatives evaluees

**A1 — Redefinition des types conversation-session.ts dans handoff vs import** : Decision Q1 tranche en faveur de la redefinition dans conversation-handoff.ts. Justification : conversation-session.ts est marque "Supprime" dans ARCHITECTURE-V2 — creer un couplage structurel serait une dette immediate. Les 3 types utiles (`DetectedConstraint`, `SessionDecision`, types de messages) sont simples et se redefinissent en < 20 LOC.

**A2 — Callbacks SDD dans zz-messages.ts vs sdd-flow.ts** : Decision Q2 tranche en faveur de sdd-flow.ts. Justification : zz-messages.ts est deja a 909 LOC, au-dessus du seuil 800 LOC. Ajouter 80-100 LOC de callbacks SDD depasserait significativement 1000 LOC. Un Composer separe `commands/sdd-flow.ts` suit les conventions du projet (separation par domaine), est charge automatiquement par loader.ts, et permet des tests unitaires independants.

**A3 — Nommage pipeline par LLM vs string processing** : Decision Q3 tranche en faveur du string processing kebab-case. Justification : pas d'appel LLM supplementaire, deterministe et testable, pattern deja etabli dans project.ts pour les slugs. La qualite du nom est suffisante pour l'usage (identification dans status bar + noms de fichiers).

**A4 — Detection convergence par LLM call vs regex** : Decision Q4 tranche en faveur du regex sur la reponse Claude. Justification : le LLM call supplementaire consommerait le mutex callClaude (5-30s de blocage). Le regex est gratuit et immediat. La robustesse est assuree par le system prompt conversationnel qui instruit Claude de produire le format reconnaissable — si Claude ne le produit pas, les boutons n'apparaissent pas mais les commandes /dev-* restent disponibles (R11, principe de grace degradee).

### Zones d'ombre residuelles

**Z1 — System prompt conversationnel pour induire le format "Decisions: ..."** : La spec definit la logique de detection (V19, V20, R10) mais ne specifie pas les modifications au system prompt de `callClaude`. Cette modification est dans `src/bot-context.ts` ou `src/topic-config.ts` — a traiter dans la Phase 3 (integration du flow conversationnel). Pour la Phase 2, la detection est implantee mais ne sera pas triggerable par Claude tant que le system prompt n'est pas modifie.

**Z2 — Types des messages conversationnels passes a extractHandoffSummary** : La spec definit `conversationHistory: string` comme parametre. Le formatage exact (comment les messages user/assistant sont combines en string) est a la discretion de l'implementeur, avec comme contrainte le budget tokens (< 200 tokens input pour le prompt). Suggestion : prendre les N derniers echanges user/assistant depuis `getRecentMessages()`.

**Z3 — Clavier post-job dans getCompletionKeyboard** : La spec indique que job-manager.ts doit ajouter les cases 'sdd-*' dans `getCompletionKeyboard()` (section 5). Le detail exact des boutons post-completion (quels boutons pour quelle phase) est redondant avec `buildSddKeyboard` de sdd-flow.ts. L'implementeur devra coordonner les deux points d'entree pour eviter des claviers incoherents.
