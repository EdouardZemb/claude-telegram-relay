# SDD Phase 3 — S24 Task Breakdown

Derive du plan d'architecture et de la spec S24.
Chaque tache trace vers des FR-XXX et AC-XXX.


## Taches Ordonnees

### T1 — Migration Supabase : table blackboard (FR-001)
Priority: P1 | Depends on: rien | Estimated: 1h

Creer la table `blackboard` dans Supabase avec :
- Colonnes : id, created_at, updated_at, task_id (FK tasks), session_id (unique), version (int, default 1), sections (JSONB), history (JSONB array), status (active/completed/failed), pipeline_type
- Index sur session_id, task_id, status
- RLS : full access (comme cost_tracking)
- Trigger updated_at
- Mettre a jour db/schema.sql

Acceptance Criteria:
- AC-001 : row creee avec session_id unique et version=1
- AC-003 : version conflict detectable (WHERE version = expected_version)

Tests:
- [ ] AC-001 : createBlackboard cree une row version=1, sections vides
- [ ] AC-003 : update avec version stale echoue (0 rows affected)
- [ ] SC-003 : migration s'applique proprement sur Supabase


### T2 — Module src/blackboard.ts : API CRUD (FR-002)
Priority: P1 | Depends on: T1 | Estimated: 3h

Creer src/blackboard.ts avec :
- Types : BlackboardSections (spec, plan, tasks, implementation, verification), BlackboardRow, SectionName
- createBlackboard(supabase, taskId, sessionId, pipelineType) : cree une row
- readSection(supabase, sessionId, section) : lit une section (retourne null si vide, EC-001)
- writeSection(supabase, sessionId, section, data, role, expectedVersion) : ecrit avec optimistic locking (AC-002, AC-003, AC-005)
- getFullBlackboard(supabase, sessionId) : retourne tout (AC-006)
- Role authorization map : analyst->spec, pm->tasks, architect->plan, dev->implementation, qa->verification, verifier->verification
- Overflow handling : si data > 50KB, truncate + overflow field (EC-002)
- Version overflow : alerte si version > 100 (EC-007)

Acceptance Criteria:
- AC-002 : writeSection incremente version atomiquement
- AC-003 : writeSection avec version stale retourne erreur
- AC-004 : readSection retourne seulement la section demandee
- AC-005 : writeSection rejette les ecritures non autorisees par role
- AC-006 : getFullBlackboard retourne toutes les sections + metadata

Tests:
- [ ] AC-002 : writeSection incremente version
- [ ] AC-004 : readSection retourne seulement la section
- [ ] AC-005 : writeSection rejette role non autorise
- [ ] AC-006 : getFullBlackboard retourne tout
- [ ] EC-001 : readSection sur section vide retourne null
- [ ] EC-002 : output > 50KB est tronque avec warning
- [ ] EC-007 : version > 100 trigger une alerte


### T3 — Gate Evaluator agent (FR-003)
Priority: P1 | Depends on: T2 | Estimated: 3h

Creer src/gate-evaluator.ts avec :
- Types : GateEvaluation { pass, score, issues[], gate_name }, EvaluationIssue { severity, description, suggestion }
- evaluateGate(supabase, sessionId, gateName, context) : appelle Claude CLI avec un prompt d'evaluation
- 3 gates definis : "tasks" (apres PM), "plan" (apres architect), "implementation" (apres dev)
- Chaque gate a ses criteres specifiques (AC-007, AC-008, AC-009)
- Timeout 120s : si depasse, passe avec warning (EC-004)
- Seuil de passage : score >= 60
- Resultat ecrit dans blackboard.verification.gates[]

Acceptance Criteria:
- AC-007 : evaluateur verifie spec (GIVEN/WHEN/THEN, edge cases, success criteria)
- AC-008 : evaluateur verifie plan (couverture FR, interfaces, migration)
- AC-009 : evaluateur verifie tasks (tracabilite FR, test plan, dependances)
- AC-010 : resultat structure { pass, score, issues[], gate_name }

Tests:
- [ ] AC-010 : output evaluateur a le bon schema
- [ ] EC-004 : timeout 120s traite comme pass + warning
- [ ] Gate "tasks" detecte une tache sans traces_to
- [ ] Gate "plan" detecte un FR non couvert
- [ ] Gate "implementation" detecte un test manquant


### T4 — Boucle evaluate-rework (FR-004)
Priority: P1 | Depends on: T3 | Estimated: 2h

Creer src/evaluate-rework.ts avec :
- evaluateAndRework(supabase, sessionId, agentRole, gateName, runAgent, maxIterations=2) : boucle
- Si evaluateur rejette : relance l'agent avec feedback de l'evaluateur en contexte additionnel (AC-011)
- Si max iterations atteint et toujours rejete : continue avec warning dans blackboard (AC-012)
- Chaque iteration incremente la version du blackboard (AC-013)
- Retourne { finalEvaluation, iterations, passedAtIteration }

Acceptance Criteria:
- AC-011 : agent relance recoit le feedback evaluateur
- AC-012 : apres 2 iterations echouees, continue avec warning logue
- AC-013 : chaque rework incremente la version blackboard

Tests:
- [ ] AC-011 : feedback evaluateur passe a l'agent au retry
- [ ] AC-012 : max 2 iterations puis warning
- [ ] AC-013 : version incrementee a chaque rework
- [ ] Cas ou l'agent corrige au 1er retry (1 iteration)
- [ ] Cas ou l'agent passe du 1er coup (0 iteration)


### T5 — Adversarial Verifier (FR-005)
Priority: P1 | Depends on: T2 | Estimated: 2h

Creer src/adversarial-verifier.ts avec :
- Types : DriftReport { coverage_score, drift_items[], overall_verdict }, DriftItem { fr_id, status, details }
- verifySpecVsImplementation(supabase, sessionId) : appelle Claude CLI en clean room
- Input : seulement blackboard.spec + blackboard.implementation (pas plan ni tasks) (AC-014)
- Output : coverage_score 0-100, drift_items par FR (AC-015)
- Si requirements manquants : stocke dans blackboard.verification + workflow_logs (AC-016)
- Skip sur QUICK pipeline (EC-006)

Acceptance Criteria:
- AC-014 : verifier recoit uniquement spec + implementation
- AC-015 : output { coverage_score, drift_items[], overall_verdict }
- AC-016 : drift stocke dans blackboard.verification et workflow_logs

Tests:
- [ ] AC-014 : prompt du verifier ne contient pas plan/tasks
- [ ] AC-015 : output a le bon schema
- [ ] AC-016 : drift report persiste dans blackboard et workflow_logs
- [ ] EC-006 : QUICK pipeline skip le verifier


### T6 — Tracabilite FR->tache->test->code (FR-007)
Priority: P2 | Depends on: T2 | Estimated: 1.5h

Ajouter dans src/blackboard.ts :
- generateTraceabilityReport(supabase, sessionId) : croise les sections du blackboard
- Mapping pur (pas de LLM) : parcourt spec.requirements, tasks.items, verification.tests, implementation.files
- Chaque tache dans blackboard.tasks a un champ traces_to (AC-020)
- Chaque test dans blackboard.verification a un champ validates (AC-021)
- Rapport : covered_fr[], partially_covered_fr[], missing_fr[], coverage_percentage (AC-022)

Acceptance Criteria:
- AC-020 : taches ont traces_to avec FR-XXX
- AC-021 : tests ont validates avec AC-XXX
- AC-022 : rapport de tracabilite complet

Tests:
- [ ] AC-020 : taches dans blackboard ont traces_to
- [ ] AC-021 : tests dans blackboard ont validates
- [ ] AC-022 : rapport couvre tous les FR (100%, partial, 0%)
- [ ] FR manquant dans tasks = "missing" dans le rapport


### T7 — Integration orchestrator.ts (FR-006, FR-008)
Priority: P2 | Depends on: T2, T3, T4, T5, T6 | Estimated: 4h

Modifier src/orchestrator.ts :
- Ajouter useBlackboard: boolean dans OrchestrateOptions (AC-019)
- Si useBlackboard=true :
  - Creer un blackboard au debut (createBlackboard)
  - Charger le template SDD dans blackboard.spec (AC-023, FR-008)
  - Chaque agent lit le blackboard au lieu du text concat (AC-017)
  - Chaque agent ecrit dans la section appropriee (AC-018)
  - Apres PM, architect, dev : lance evaluateAndRework (FR-004)
  - Apres tout : lance adversarialVerifier si pas QUICK (FR-005)
  - Genere le rapport de tracabilite (FR-007)
- Si useBlackboard=false ou omis : legacy flow intact (EC-005, AC-019)
- Sessions concurrentes : chaque pipeline a son propre session_id (EC-003)

Acceptance Criteria:
- AC-017 : agents lisent le blackboard
- AC-018 : agents ecrivent dans la bonne section
- AC-019 : useBlackboard=false = legacy flow
- AC-023 : template SDD charge au demarrage

Tests:
- [ ] AC-017 : agent recoit le contexte du blackboard
- [ ] AC-018 : output ecrit dans la bonne section
- [ ] AC-019 : legacy flow sans changement
- [ ] AC-023 : template charge dans blackboard.spec
- [ ] EC-003 : 2 sessions concurrentes sans contamination
- [ ] EC-005 : orchestrate sans useBlackboard marche comme avant
- [ ] EC-008 : fallback in-memory si Supabase indisponible


### T8 — Commande /orchestrate mise a jour + relay.ts (FR-006)
Priority: P2 | Depends on: T7 | Estimated: 1.5h

Modifier src/relay.ts :
- /orchestrate accepte --blackboard flag pour activer useBlackboard
- Afficher le resultat du blackboard (evaluations, verifier, tracabilite) dans la reponse Telegram
- /orchestrate sans --blackboard = comportement existant
- Ajouter dans /help

Tests:
- [ ] /orchestrate --blackboard lance le flow blackboard
- [ ] /orchestrate sans flag = legacy
- [ ] /help affiche l'option --blackboard


### T9 — Tests et dogfooding (SC-001 a SC-008)
Priority: P2 | Depends on: T1-T8 | Estimated: 3h

3 fichiers de tests :
- tests/blackboard.test.ts : T1+T2 (CRUD, locking, roles, overflow)
- tests/gate-evaluator.test.ts : T3+T4 (evaluation, rework loop)
- tests/adversarial-verifier.test.ts : T5+T6 (drift, tracabilite)

Verification finale :
- [ ] SC-001 : 508+ tests existants passent
- [ ] SC-002 : 30+ nouveaux tests
- [ ] SC-003 : migration Supabase OK (via MCP)
- [ ] SC-004 : pipeline DEFAULT avec gates fonctionne
- [ ] SC-005 : adversarial verifier produit un drift report
- [ ] SC-006 : legacy orchestrate identique a S23
- [ ] SC-007 : rework loop relance un agent avec feedback
- [ ] SC-008 : rapport de tracabilite FR->task->test

CLAUDE.md mis a jour.


## Dependances

```
T1 (migration)
  └─> T2 (API blackboard)
        ├─> T3 (evaluator) ─> T4 (rework loop)
        ├─> T5 (verifier)
        └─> T6 (tracabilite)
              └─> T7 (integration orchestrator) ─> T8 (relay.ts)
                                                      └─> T9 (tests + dogfooding)
```

T3 et T5 sont independantes (parallelisables).
T6 est independante de T3/T4/T5.
T7 attend T2, T3, T4, T5, T6.
T9 attend tout.


## Test Plan Resume

| Source | Tests |
|--------|-------|
| T1 | 3 tests (create, locking, migration) |
| T2 | 7 tests (CRUD, roles, overflow, null) |
| T3 | 5 tests (schema, timeout, detection) |
| T4 | 5 tests (feedback, max iter, version) |
| T5 | 4 tests (clean room, schema, persist, skip) |
| T6 | 4 tests (traces_to, validates, report, missing) |
| T7 | 7 tests (read/write, legacy, template, concurrent, fallback) |
| T8 | 3 tests (flag, legacy, help) |
| T9 | 8 verifications SC-001 a SC-008 |
| **Total** | **46 tests** (depasse les 30+ requis par SC-002) |
