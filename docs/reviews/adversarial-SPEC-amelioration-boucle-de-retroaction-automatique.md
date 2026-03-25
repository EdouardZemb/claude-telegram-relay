# Challenge Adversarial — SPEC-amelioration-boucle-de-retroaction-automatique.md

Verdict global: GO_WITH_CHANGES
Agents: 3/3 reussis

---

## Devil's Advocate — Rapport

## Devil's Advocate — Rapport

### Findings

**[BLOQUANT] F-DA-1 — Phase "discuss" omise du mapping agent_role (R3)**
- **Source** : Section 2 - Règle R3 ; Section 6
- **Description** : R3 définit le mapping phase → agent_role pour 5 phases (`challenge`, `review`, `implement`, `explore`, `spec`). Or, `pipeline-tracker.ts:29-31` et `job-manager.ts:530-538` incluent une 6ème phase `"discuss"` comme phase SDD valide. Aucun mapping pour `"discuss"`.
- **Impact** : Impossible d'implémenter R1/R3 de façon complète. L'écriture d'événement dans `agent_events` pour un job `"discuss"` produira un `agent_role` inconnu ou arbitraire.
- **Evidence** : `pipeline-tracker.ts:31` — `| "discuss"` dans `SddPhase` type union ; spec R3 mentionne uniquement 5 phases.

---

**[BLOQUANT] F-DA-2 — Pas de contrainte CHECK sur `event_type` dans `agent_events` — pollution des signaux**
- **Source** : Section 2 - Règle R2 ; Section 10 - Matrice "Technique"
- **Description** : `fetchSignals` filtre sur `event_type='sdd_verdict'`. Or, `db/schema.sql:1130` déclare `event_type TEXT NOT NULL` sans CHECK constraint. D'autres modules peuvent écrire des événements avec ce même `event_type` mais un `payload` malformé. La spec reconnaît elle-même ce risque en section 10 ("La table `agent_events` n'a pas de `source` constraint") sans le résoudre.
- **Impact** : Signaux corrompus → overlays générés sur des données invalides → runtime errors dans `fetchSignals` au parsing de `payload.verdict`.
- **Evidence** : `db/schema.sql:1130` ; `feedback-analyzer.ts:46` énumère 4 verdicts valides sans forçage en base ; spec section 10 documente le risque sans le corriger.

---

**[MAJEUR] F-DA-3 — Dérivation implicite `source = phase` non explicite dans R1**
- **Source** : Section 2 - Règle R1 ; Section 3
- **Description** : R1 montre `source: "challenge"` dans l'exemple, mais ne formalise pas que `source = phase.toLowerCase()`. `feedback-analyzer.ts:22` liste `source: "challenge" | "review" | "implement" | "explore"` (4 valeurs), ce qui ne correspond pas aux 5-6 phases SDD. Ambiguïté pour `spec`, `discuss`.
- **Impact** : Signaux fragmentés si des implémenteurs écrivent `source="spec-writing"` vs `source="spec"`. `analyzeAgentFeedback` groupe par `source` (ligne 99-103) — patterns SDD non détectés.

---

**[MAJEUR] F-DA-4 — job-manager n'a pas accès à BotContext ("via supabase bctx")**
- **Source** : Section 6 - Fichiers concernés ; Section 1
- **Description** : R1 dit d'émettre un événement "via supabase bctx" depuis `job-manager`. Mais `job-manager.ts` est un singleton fire-and-forget sans accès à `BotContext`. Il crée déjà son propre client lazy (`lignes 556-558`). La spec assume un accès unifié mais la réalité architecturale impose un client local.
- **Impact** : Ambiguïté : deux clients Supabase créés, gestion d'erreur divergente, risque de credentials différents entre contextes.

---

**[MAJEUR] F-DA-5 — Fenêtre 7 jours (R2) mal alignée avec TTL overlay 7 jours (R8)**
- **Source** : Section 2 - Règles R2 et R8 ; `feedback-analyzer.ts:215`
- **Description** : `fetchSignals` lit une fenêtre de 7 jours. Les overlays ont un TTL de 7 jours. Un signal de J-6 génère un overlay qui expire en J+1. Quand l'overlay expire, `fetchSignals` voit encore les signaux (J-6 < 7j) et régénère un overlay identique — boucle sans fin de création d'overlays redondants.
- **Impact** : Prolifération d'overlays dupliqués en fin de période ; accumulation jusqu'au `max: 3` qui bloque tout nouveau signal légitime.

---

**[MAJEUR] F-DA-6 — Condition de fallback LLM imprécise (R4 + V14)**
- **Source** : Section 2 - Règle R4 ; Section 9 - V14
- **Description** : V14 dit "fallback vers template statique si `spawnClaude` Haiku échoue (`exitCode ≠ 0` ou `stdout` vide)". Cas non couverts : Haiku retourne `exitCode=0` avec JSON malformé, Haiku timeout (pas d'exitCode), stdout avec texte non-parsable. La condition de fallback est incomplète.
- **Impact** : Implémentation fragile — des cas limites réels ne déclenchent pas le fallback, causant des erreurs au parsing JSON silencieuses.

---

**[MINEUR] F-DA-7 — "50 premiers chars" ambigu pour UTF-8 multi-byte (R1)**
- **Source** : Section 2 - Règle R1
- **Description** : "50 premiers chars" ne précise pas si c'est 50 code points Unicode ou 50 bytes. Pour du français avec accents, la différence peut couper au milieu d'un graphème.

---

**[MINEUR] F-DA-8 — Pas d'agent markdown pour phase "discuss" dans `.claude/agents/`**
- **Source** : Section 2 - Règle R3 ; Exploration §3 obs#3
- **Description** : R3 s'appuie sur les fichiers agents existants (`spec-architect.md`, `reviewer.md`, `explorer.md`). Aucun `discuss.md` n'existe. Si la phase `"discuss"` est mappée, elle n'a pas d'agent associé.

---

**[MINEUR] F-DA-9 — V9-V10 testent uniquement le cas nominal, aucun cas limite**
- **Source** : Section 9 - Critères V9-V10
- **Description** : Pas de critère pour `fetchSignals` avec `payload.verdict` invalide, `payload.source` absent, ou row malformée. L'implémenteur peut ne pas gérer ces cas, causant des crashes silencieux.

---

**[MINEUR] F-DA-10 — Flag `sdd_feedback_llm_overlay` non vérifié pour collision**
- **Source** : Section 6 - `config/features.json`
- **Description** : La spec demande d'ajouter ce flag (absent actuellement). Mineur car c'est un ajout pur, mais aucune vérification d'absence dans les branches non mergées ou tests existants.

---

### Statistiques
- **Bloquants** : 2
- **Majeurs** : 4
- **Mineurs** : 4

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants (phase `"discuss"` sans mapping + absence de contrainte CHECK sur `agent_events`) sont résolubles avant implémentation. F-DA-1 nécessite une décision explicite dans la spec (mapping `discuss → ?`). F-DA-2 nécessite soit une contrainte CHECK en migration SQL, soit une validation défensive dans `fetchSignals`. Les majeurs (F-DA-3 à F-DA-6) sont des ambiguïtés d'implémentation qui doivent être clarifiées dans la spec avant que l'implémenteur commence. Aucun bloquant n'est architecturalement irreconciliable.

---

## Edge Case Hunter — Rapport

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — `source: "spec"` absent de l'union type `AgentFeedbackSignal`**
- Scenario : R3 définit que la phase `spec` mappe vers `agent_role = "spec-architect"` et que `payload.source` sera `"spec"`. Or, l'interface `AgentFeedbackSignal.source` dans `feedback-analyzer.ts:23` est typée `"challenge" | "review" | "implement" | "explore"` — `"spec"` est absent. Un signal SDD issu de la phase `spec` inséré en base avec `payload.source = "spec"` serait soit rejeté à la compilation TypeScript, soit silencieusement ignoré car `generateOverlayText` n'a pas de branche `spec` dans ses templates.
- Source : R3 (mapping phase→rôle), Section 4 (struct AgentFeedbackSignal), `feedback-analyzer.ts:23`
- Impact : Tous les signaux de `runSddSpec` tombent dans le fallback template générique ou cassent la CI avec TypeScript strict.
- Fréquence estimée : **Fréquent** — la phase `spec` est présente dans tout pipeline SDD standard

---

**[BLOQUANT] F-EC-2 — Double invocation concurrente de `runFeedbackLoop` sans verrou**
- Scenario : R9 déclenche `runFeedbackLoop` depuis `job-manager.ts` après chaque job SDD. Si deux jobs se terminent quasi-simultanément (ex: auto-advance explore + spec), les deux invocations lisent `loadOverlays()` en mémoire, créent des overlays, puis `saveOverlays()` — la seconde écriture écrase silencieusement la première. Le check `hasSimilar` est insuffisant car il ne couvre pas cette race condition sur le fichier JSON.
- Source : R9, Section 8 contrainte 5, `prompt-overlay.ts:107` (pas de mutex)
- Impact : Perte silencieuse d'overlays. Le fichier `~/.claude-relay/prompt-overlays.json` peut se retrouver en état incohérent.
- Fréquence estimée : **Occasionnel** (pipelines actifs en parallèle)

---

**[MAJEUR] F-EC-3 — `payload.details` tronqué à 50 chars : insuffisant pour l'analyse LLM**
- Scenario : R1 capture les "50 premiers chars du résultat". Avec le format SDD (`SDD_CHALLENGE_NO-GO: amelioration-boucle-de-retroaction-automatique — ...`), les 50 chars contiennent quasi-uniquement le préfixe verbose. Le LLM Haiku reçoit des détails non-informatifs et génèrera des overlays génériques — équivalent aux templates statiques.
- Source : R1, Section 4 (prompt Haiku avec details)
- Impact : L'intérêt du mode LLM (R4) est neutralisé en pratique.
- Fréquence estimée : **Fréquent**

---

**[MAJEUR] F-EC-4 — Requête JSONB sans index GIN sur `agent_events.payload`**
- Scenario : R2 filtre sur `payload.verdict IN (...)` (colonne JSONB). Le schema ne dispose que des index sur `session_id` et `session_id + agent_role` — aucun index GIN sur `payload`. Avec croissance de la table, full-table scan sur la fenêtre 7 jours.
- Source : R2, `db/schema.sql` lignes 1135-1138
- Impact : Dégradation des performances croissante. Non bloquant à court terme mais non documenté.
- Fréquence estimée : **Rare à court terme, croissant**

---

**[MAJEUR] F-EC-5 — `runFeedbackLoop` sans injection Supabase explicite**
- Scenario : `job-manager.ts` appelle `runFeedbackLoop()` sans paramètre. `fetchSignals` instancie un client Supabase via `getConfig()` sans `bctx`. Si `getConfig()` échoue (env var manquante), l'erreur propagée dans `fetchSignals` est absorbée par le `best-effort` — silencieusement, sans log visible pour l'utilisateur.
- Source : Section 6, Contrainte 4 (S2 getConfig)
- Impact : Mauvaise configuration masquée en production.
- Fréquence estimée : **Rare**

---

**[MAJEUR] F-EC-6 — Phase `spec` absente des critères de validation V9-V15**
- Scenario : R3 mappe `spec` → `spec-architect`, mais aucun V-critère ne teste ce mapping. V11 teste uniquement `SDD_CHALLENGE_NO-GO`. Un bug de mapping pour la phase `spec` passerait en CI sans être détecté.
- Source : Section 9 (V9-V15), R3
- Impact : Couverture de test insuffisante pour un chemin critique.
- Fréquence estimée : **Occasionnel**

---

**[MAJEUR] F-EC-7 — `spawnClaude` sans `useWorktree: false` pour le call Haiku**
- Scenario : R4 appelle `spawnClaude({ model: "haiku", effort: "low" })` sans spécifier `useWorktree: false`. Si le défaut crée un worktree Git pour générer 300 chars de texte LLM, c'est une opération git aberrante (coûteuse en ressources disque/git).
- Source : R4, Section 7 pattern 3
- Impact : Création d'un worktree inutile à chaque overlay LLM.
- Fréquence estimée : **Rare mais possible**

---

**[MINEUR] F-EC-8 — Overlays expirés jamais purgés physiquement**
- Scenario : `expireOverlays()` met `active = false` mais ne supprime pas les entrées. Le fichier JSON grossit indéfiniment après des centaines de sprints sans mécanisme de purge documenté.
- Source : Section 8 contrainte 3, `prompt-overlay.ts:170-188`

---

**[MINEUR] F-EC-9 — `RECURRENCE_THRESHOLD = 3` non configurable par rôle**
- Scenario : Seuil hardcodé dans `feedback-analyzer.ts:43`. Un agent très actif (spec-architect lancé 20 fois/sprint) atteint le seuil trivialement ; un agent rare peut avoir 3 vrais échecs sans overlay si la fenêtre 7j n'en capture que 2.
- Source : `feedback-analyzer.ts:43`, Section 8 contrainte 1

---

**[MINEUR] F-EC-10 — Aucune notification Telegram quand un overlay est créé automatiquement**
- Scenario : Les overlays modifient silencieusement le comportement des agents SDD futurs. En cas de faux positif, l'utilisateur ne peut pas détecter ni révoquer l'overlay (pas de commande `/overlays`). Seule trace : `log.info`.
- Source : Section 5, Section 10 (zones non résolues)

---

### Statistiques
- Bloquants : 2
- Majeurs : 5
- Mineurs : 3

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants doivent être résolus avant implémentation : **F-EC-1** est un bug de typage TypeScript qui cassera la CI, **F-EC-2** est une race condition sur l'écriture du fichier JSON d'overlays. **F-EC-3** remet en question l'utilité pratique du mode LLM tel que spécifié (50 chars trop courts). Les findings F-EC-4 à F-EC-7 sont gérables en implémentation mais doivent être documentés dans la spec.

---

## Simplicity Skeptic — Rapport

## Simplicity Skeptic — Rapport

### Findings

**[BLOQUANT] F-SS-1 — `spawnClaude` Haiku appelé depuis `feedback-analyzer.ts` : couplage architectural interdit**
- Source : R4, Section 6 (modification `feedback-analyzer.ts`), Section 7 pattern #3
- Description : La spec propose d'appeler `spawnClaude` (depuis `agent.ts`) directement dans `feedback-analyzer.ts`. Ce module est actuellement un module d'analyse pure sans dépendance sur `agent.ts`. Introduire `spawnClaude` crée un couplage fort avec la CLI Claude, transforme un module de calcul en module avec effet de bord long-running, et aggrave le graphe de dépendances (agent.ts → tasks.ts → supabase). La contrainte S7 (pas de circular imports) est à risque.
- Alternative : Garder `generateOverlayText` comme fonction pure. Déplacer la dépendance LLM dans `runFeedbackLoop` via un `generateOverlayFn` injectable dans `_setDependencies` — la dépendance sur `spawnClaude` reste dans `getDeps()` uniquement.
- Codebase : `src/feedback-analyzer.ts:64-72` (pattern getDeps existant), `src/sdd-agents.ts:1-6` (R13 import restriction)

**[BLOQUANT] F-SS-2 — Appel `runFeedbackLoop()` dans `job-manager.ts` : risque de timeout sur chaque job SDD**
- Source : R9, Section 6 (modification `job-manager.ts`), critère V15
- Description : `runFeedbackLoop` effectue une requête Supabase puis potentiellement un `spawnClaude` Haiku (process CLI externe, 10-30 secondes). Cet appel est dans le chemin de notification post-job, qui envoie déjà la notification Telegram. Si awaité, ralentit l'UX. Si fire-and-forget, les erreurs sont silencieuses et la spec perd sa cohérence avec R6 (best-effort). Aucune mention explicite dans la spec.
- Alternative : Fire-and-forget explicite `Promise.resolve().then(() => runFeedbackLoop()).catch(...)`, ou déléguer exclusivement au heartbeat (R9 reconnaît lui-même que c'est la voie principale) — évite la duplication.
- Codebase : `src/job-manager.ts:569-579` (chemin notification post-job), `src/heartbeat.ts:675-683` (appel existant runFeedbackLoop)

**[MAJEUR] F-SS-3 — Double feature flag : complexité de gating sans valeur proportionnelle**
- Source : Section 8 contrainte #2, R4, R5
- Description : Second flag `sdd_feedback_llm_overlay` imbriqué dans `prompt_feedback_loop` génère 4 états (2×2) dont un est sémantiquement identique à l'état existant. Tests V7/V13/V14 doivent couvrir les combinaisons. La fonctionnalité LLM a un fallback immédiat (R5) — un flag permanent n'est pas justifié.
- Alternative : Implémenter le LLM comme comportement par défaut avec fallback template intégré. Si flag nécessaire, le documenter comme temporaire avec date d'expiration.
- Codebase : `config/features.json` (déjà 6 flags actifs), `src/feedback-analyzer.ts:165` (gating à un seul niveau)

**[MAJEUR] F-SS-4 — `fetchSignals` avec client Supabase créé dans `getDeps()` : duplication du pattern lazy import**
- Source : R2, Section 8 contrainte #4
- Description : Crée un troisième client Supabase instancié dans un module core, ajoutant une connexion WebSocket supplémentaire. Fait de `feedback-analyzer.ts` un module avec état externe, contrairement à son design actuel. La marge LOC <400 (Section 8 #3) sera très étroite (313 → ~393 LOC).
- Alternative : Passer `fetchSignals` via injection dans `_setDependencies` (pattern déjà en place). Factory dans `heartbeat.ts` ou `job-manager.ts` qui a déjà accès au client Supabase.
- Codebase : `src/feedback-analyzer.ts:60-72` (injection déjà prévue), `src/job-manager.ts:555-558` (pattern lazy import existant)

**[MAJEUR] F-SS-5 — Mapping `agent_role` depuis phase SDD : règle métier fragile codée en dur**
- Source : R3, Section 7 pattern #6
- Description : Mapping `challenge → "spec-architect"` codé en dur dans `job-manager.ts` alors que la vérité existe dans `sdd-agents.ts` (les fonctions `runSddChallenge`, `runSddSpec` appellent toutes deux `readAgentFile("spec-architect.md")`). Deux sources de vérité sans lien typé.
- Alternative : Exporter `PHASE_TO_AGENT_ROLE: Record<string, string>` depuis `sdd-agents.ts` (source de vérité) et l'importer dans `job-manager.ts`. Pattern identique à `PHASE_TO_TASK_STATUS` dans `sdd-task-sync.ts`.
- Codebase : `src/sdd-agents.ts:159, 206, 458` (readAgentFile calls), `src/sdd-task-sync.ts` (PHASE_TO_TASK_STATUS — pattern similaire)

**[MAJEUR] F-SS-6 — Émission `agent_events` dans `job-manager.ts` : responsabilité hors périmètre**
- Source : R1, Section 6 (modification `job-manager.ts`)
- Description : `job-manager.ts` gère déjà notification Telegram, keyboard SDD, updateStep pipeline, syncTaskStatusForPhase, auto-advance, persist prUrl. Y ajouter émission `agent_events` + `runFeedbackLoop` alourdit encore ce module (580+ LOC). De plus, `agent_events` n'a aucun writer/reader dans `src/` actuellement (`grep agent_events` : zéro résultat).
- Alternative : Concentrer l'émission dans `sdd-agents.ts` directement (connaît le rôle, la phase, le verdict, le pipelineName, et a accès à BotContext).
- Codebase : `src/job-manager.ts:1-30` (déjà 8 imports, module multi-responsabilité)

**[MINEUR] F-SS-7 — `details` tronqué à 50 chars en émission mais agrégé jusqu'à 500 chars en prompt LLM**
- Source : R1, Section 4
- Description : Avec RECURRENCE_THRESHOLD=3 et 50 chars/signal, l'agrégation maximale est 150 chars — la limite de 500 chars n'est jamais atteinte. La limite à 50 chars est trop conservative pour produire un overlay contextuel utile.
- Alternative : Tronquer à 200 chars en émission, supprimer la limite artificielle de 500 chars côté prompt.
- Codebase : `src/feedback-analyzer.ts:46` (FAILURE_OUTCOMES)

**[MINEUR] F-SS-8 — `session_id = pipelineName` dans `agent_events` : sémantique incorrecte**
- Source : R8, Section 3
- Description : Utiliser le nom du pipeline comme `session_id` casse la sémantique attendue (plusieurs runs du même pipeline partagent le même `session_id`). Le groupement est déjà satisfait par le filtre `event_type='sdd_verdict'` + `agent_role`.
- Alternative : Utiliser `job.id` (disponible dans `job-manager.ts`) comme `session_id` pour garantir l'unicité par run.
- Codebase : `db/schema.sql` (colonne session_id), `src/job-manager.ts` (job.id disponible)

**[MINEUR] F-SS-9 — V15 teste le câblage, pas le comportement observable**
- Source : Section 9, V15
- Description : V15 vérifie que `runFeedbackLoop` est invoqué depuis `job-manager.ts` (spy/mock) — test d'implémentation-coupling. Si le mécanisme change (event emitter, queue), V15 casse sans que le comportement métier soit affecté. Redondant avec V11-V14.
- Alternative : Critère comportemental de bout-en-bout : "après 3 verdicts NO-GO, un overlay est actif pour le rôle correspondant".
- Codebase : `src/feedback-analyzer.ts:161-232` (runFeedbackLoop déjà couvert par V6-V8)

**[MINEUR] F-SS-10 — `require()` CommonJS dans un module ESM Bun : anti-pattern aggravé**
- Source : Section 8 contrainte #1, Section 7 pattern #2
- Description : `feedback-analyzer.ts:67` utilise déjà `require()` dans `getDeps()`. Ajouter `spawnClaude` via `require("./agent.ts")` au même endroit est risqué : `agent.ts` importe `@supabase/supabase-js` avec effets de bord potentiels à l'import.
- Alternative : Dynamic imports ESM (`await import(...)`) comme dans `src/job-manager.ts:555-556`, ou factories via `_setDependencies`.
- Codebase : `src/feedback-analyzer.ts:67` (require existant), `src/job-manager.ts:555` (dynamic import ESM pattern)

---

### Statistiques
- Bloquants : 2
- Majeurs : 4
- Mineurs : 4

---

## Verdict de l'agent: GO_WITH_CHANGES

Les deux bloquants sont corrigeables sans refonte majeure : F-SS-1 (injection via `_setDependencies` plutôt qu'import direct de `agent.ts`) et F-SS-2 (fire-and-forget explicite ou délégation exclusive au heartbeat). Les majeurs F-SS-4 et F-SS-5 ont des corrections simples (injection pattern existant, export PHASE_TO_AGENT_ROLE). F-SS-6 est une décision d'architecture à valider. Le cœur de la spec (signaux, seuils, overlay template) est solide — la sur-ingenierie est concentrée sur le câblage, pas sur la logique métier.