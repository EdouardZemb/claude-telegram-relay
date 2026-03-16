# Architecture Plan — S24 Gated Blackboard & SDD

> Phase 2 du processus SDD. Derive de la spec s24-gated-blackboard-sdd.md.
> Gate 1 (spec) validee le 2026-03-15.


## Composants

### 1. Table `blackboard` (Supabase) — FR-001

```sql
CREATE TABLE IF NOT EXISTS blackboard (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID REFERENCES tasks(id),
  session_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
  pipeline_type TEXT,
  sections JSONB NOT NULL DEFAULT '{
    "spec": null,
    "plan": null,
    "tasks": null,
    "implementation": null,
    "verification": null
  }',
  history JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  project_id UUID REFERENCES projects(id)
);

CREATE INDEX idx_blackboard_task ON blackboard(task_id);
CREATE INDEX idx_blackboard_session ON blackboard(session_id);
CREATE INDEX idx_blackboard_status ON blackboard(status);
```

Decisions :
- Single JSONB `sections` column (AD-001) plutot que 5 colonnes separees
- `history` : array de {version, section, timestamp, agent_role} pour l'audit
- `session_id` : genere par l'orchestrateur (format: `bb_{taskId}_{timestamp}`)
- Optimistic locking via `version` dans la clause WHERE (AD-002)

RLS : full access (comme cost_tracking, meme pattern single-user)


### 2. Module `src/blackboard.ts` — FR-002

API typee pour lire/ecrire dans le blackboard.

```
Interfaces:
  BlackboardSections {
    spec: SpecSection | null
    plan: PlanSection | null
    tasks: TasksSection | null
    implementation: ImplementationSection | null
    verification: VerificationSection | null
  }

  SpecSection {
    user_stories: { id: string, text: string }[]
    requirements: { id: string, description: string, acceptance_criteria: { id: string, given: string, when: string, then: string }[] }[]
    edge_cases: { id: string, description: string, expected: string }[]
    success_criteria: { id: string, description: string }[]
  }

  PlanSection {
    architecture: string
    components: { name: string, responsibility: string, interactions: string[] }[]
    interfaces: { name: string, methods: string[] }[]
    migration_plan: string | null
    decisions: { id: string, decision: string, rationale: string }[]
  }

  TasksSection {
    tasks: { id: string, title: string, traces_to: string[], acceptance_criteria: string[], dependencies: string[] }[]
    test_plan: { id: string, validates: string[], description: string }[]
    dependencies: { from: string, to: string }[]
  }

  ImplementationSection {
    files_changed: { path: string, action: 'created' | 'modified' | 'deleted', traces_to: string[] }[]
    tests_written: { path: string, validates: string[] }[]
    summary: string
  }

  VerificationSection {
    evaluations: GateEvaluation[]
    adversarial_report: AdversarialReport | null
    traceability: TraceabilityReport | null
  }

Fonctions exportees:
  createBlackboard(supabase, taskId, projectId?) -> { session_id, id }
  readSection(supabase, sessionId, section) -> T | null
  writeSection(supabase, sessionId, section, data, agentRole, currentVersion) -> { version } | { error }
  getFullBlackboard(supabase, sessionId) -> BlackboardDocument | null
  getBlackboardHistory(supabase, sessionId) -> HistoryEntry[]
```

Contraintes d'ecriture par role (AC-005) :
- analyst : spec
- pm : tasks
- architect : plan
- dev : implementation
- qa : verification
- evaluator : verification
- verifier : verification

Le write verifie `WHERE version = currentVersion` (optimistic locking). Si 0 rows updated, erreur de conflit de version (AC-003).

Chaque write ajoute une entree dans `history` (version, section, timestamp, agent_role).


### 3. Gate Evaluator — FR-003, FR-004

Nouveau role agent `evaluator` (pas un BMad agent, un agent specialise).

```
Interface GateEvaluation {
  gate_name: string        // 'spec' | 'plan' | 'tasks' | 'implementation'
  pass: boolean
  score: number            // 0-100
  issues: { severity: 'critical' | 'major' | 'minor', description: string, suggestion: string }[]
  iteration: number        // 1 ou 2
}
```

Implementation dans `src/blackboard.ts` (meme module, fonctions dediees) :

```
evaluateGate(supabase, sessionId, gateName, maxIterations=2) -> GateEvaluation

  1. Lit la section correspondante du blackboard
  2. Construit un prompt d'evaluation specifique a la gate :
     - Gate spec : "Verifie que tous les FR ont des AC en GIVEN/WHEN/THEN, edge cases definis, success criteria mesurables"
     - Gate plan : "Verifie que l'architecture couvre tous les FR, interfaces definies, migration si necessaire"
     - Gate tasks : "Verifie que chaque tache trace vers un FR, test plan couvre tous les AC, dependances explicites"
     - Gate implementation : "Verifie que tous les tests passent, code suit les conventions, pas de regression"
  3. Appelle Claude CLI avec le prompt + la section en contexte
  4. Parse le JSON structure (GateEvaluation)
  5. Si pass=false et iteration < maxIterations :
     - Ecrit le feedback dans blackboard.verification.evaluations
     - Retourne les issues pour rework
  6. Si pass=false et iteration >= maxIterations :
     - Log warning, continue avec issues flaggees (AC-012)
  7. Si pass=true : continue au step suivant
```

Le prompt evaluateur est construit avec les criteres specifiques a la gate. Il recoit UNIQUEMENT la section a evaluer, pas tout le blackboard (principle of least context, coherent avec AD-005).


### 4. Evaluate-Rework Loop — FR-004

Integree dans la boucle de l'orchestrateur (pas une fonction separee). Modifie le flow dans `orchestrate()` quand `useBlackboard: true` :

```
Pour chaque agent du pipeline:
  1. Agent ecrit dans le blackboard
  2. evaluateGate(gateName correspondant)
  3. Si echec et iterations restantes :
     - Relance l'agent avec les issues de l'evaluateur en contexte additionnel
     - L'agent reecrit dans le blackboard (version incrementee)
     - Re-evaluate
  4. Si pass ou max iterations atteint : next agent
```

Mapping agent -> gate :
- analyst -> gate 'spec' (pas d'evaluation, l'analyste enrichit la spec)
- pm -> gate 'tasks'
- architect -> gate 'plan'
- dev -> gate 'implementation'
- qa -> pas de gate (le QA EST l'evaluateur de la phase implementation)

Donc 3 gates evalues par le LLM : tasks, plan, implementation.
Le gate spec est deja valide manuellement en Phase 1 SDD (humain).


### 5. Adversarial Verifier — FR-005

Fonction dediee dans `src/blackboard.ts` :

```
runAdversarialVerification(supabase, sessionId) -> AdversarialReport

  AdversarialReport {
    coverage_score: number   // 0-100
    drift_items: { fr_id: string, status: 'implemented' | 'missing' | 'partial' | 'divergent', details: string }[]
    overall_verdict: 'pass' | 'fail' | 'partial'
  }
```

Implementation :
1. Lit blackboard.spec (requirements originaux)
2. Lit blackboard.implementation (fichiers modifies, tests ecrits)
3. Construit un prompt "clean room" : compare FR par FR si chaque requirement est couvert par l'implementation
4. N'a PAS acces a plan ni tasks (AD-005)
5. Appelle Claude CLI, parse le JSON
6. Ecrit le rapport dans blackboard.verification.adversarial_report

Skipped pour QUICK pipelines (EC-006) : pas de spec a verifier.


### 6. Orchestrator Integration — FR-006

Modifications dans `src/orchestrator.ts`. Nouvelles options :

```
OrchestrateOptions (existant) + :
  useBlackboard?: boolean   // opt-in (AD-004)
```

Quand `useBlackboard: true` :

1. Debut pipeline : `createBlackboard(supabase, taskId)`
2. Charge le spec template dans blackboard.spec si disponible (AC-023)
3. Pour chaque agent :
   a. L'agent recoit la section pertinente du blackboard (pas de text concat)
   b. L'agent ecrit son output dans la section correspondante
   c. Gate evaluation (si applicable)
   d. Rework loop si necessaire
4. Fin pipeline (sauf QUICK) : adversarial verification
5. Genere le traceability report

Quand `useBlackboard: false` ou omis : legacy flow inchange (EC-005).

Le blackboard remplace `AgentMessage[]` comme mecanisme de passage de contexte. Les agents lisent les sections dont ils ont besoin :
- PM lit spec
- Architect lit spec + tasks
- Dev lit plan + tasks
- QA lit spec + implementation


### 7. Traceability — FR-007

Fonction dans `src/blackboard.ts` :

```
generateTraceabilityReport(supabase, sessionId) -> TraceabilityReport

  TraceabilityReport {
    requirements: { fr_id: string, tasks: string[], tests: string[], files: string[], status: 'covered' | 'partial' | 'missing' }[]
    total_coverage: number  // percentage
  }
```

Construit en croisant :
- blackboard.spec.requirements (les FR-XXX)
- blackboard.tasks.tasks[].traces_to (liens vers FR-XXX)
- blackboard.tasks.test_plan[].validates (liens vers AC-XXX)
- blackboard.implementation.files_changed[].traces_to (liens vers FR-XXX)

Pas de LLM necessaire, c'est du mapping pur.


## Fichiers impactes

| Fichier | Action | Description |
|---------|--------|-------------|
| src/blackboard.ts | Nouveau | API blackboard, evaluateur, verifier, traceability (~500 lignes) |
| src/orchestrator.ts | Modifie | Integration useBlackboard, read/write sections, gate loop |
| src/relay.ts | Modifie | Passer useBlackboard dans les options /orchestrate et /autopipeline |
| db/schema.sql | Modifie | Table blackboard + indexes + RLS |
| config/workflow.yaml | Inchange | Les gates du blackboard sont complementaires au workflow existant |
| tests/unit/blackboard.test.ts | Nouveau | Tests blackboard CRUD, evaluateur, verifier, traceability |
| tests/unit/orchestrator.test.ts | Modifie | Tests integration blackboard dans orchestrateur |
| CLAUDE.md | Modifie | Documentation blackboard.ts + table blackboard |


## Interfaces entre modules

```
orchestrator.ts
  └── importe blackboard.ts
       ├── createBlackboard()
       ├── readSection()
       ├── writeSection()
       ├── evaluateGate()          # appelle Claude CLI
       ├── runAdversarialVerification()  # appelle Claude CLI
       └── generateTraceabilityReport()

relay.ts
  └── passe useBlackboard: true dans orchestrate() options
```

Pas de nouvelle dependance externe. Reutilise le pattern existant d'appel Claude CLI (spawn dans orchestrator.ts).


## Migration DB

Une seule migration :
1. CREATE TABLE blackboard (voir schema ci-dessus)
2. ALTER TABLE blackboard ENABLE ROW LEVEL SECURITY
3. CREATE POLICY "Allow all for authenticated" ON blackboard FOR ALL USING (true)

Pas de modification des tables existantes.


## Risques techniques et mitigations

RT-001 : Evaluateur trop strict (rejette systematiquement)
  Mitigation : Score minimum de passage a 60/100 (configurable). Max 2 iterations, puis on continue avec warning.

RT-002 : Cout tokens evaluateur (3 evaluations + 1 verifier = 4 appels Claude supplementaires)
  Mitigation : Prompts courts (section uniquement, pas tout le blackboard). Estime ~20K tokens par evaluation. Budget total pipeline avec blackboard : ~200K tokens vs ~120K sans.

RT-003 : Latence ajoutee (4 appels supplementaires)
  Mitigation : Evaluations parallelisables a terme (S25). Pour S24, sequentiel accepte. L'overhead est ~2min sur un pipeline de ~10min.

RT-004 : Blackboard JSONB trop gros (>1MB)
  Mitigation : EC-002 gere le truncation. Overflow field pour les gros outputs.


## Decoupage en taches (Phase 3 preview)

T1: Migration DB (blackboard table) — FR-001
T2: Blackboard CRUD API — FR-002
T3: Gate Evaluator + prompts — FR-003
T4: Evaluate-rework loop — FR-004
T5: Adversarial Verifier — FR-005
T6: Integration orchestrator — FR-006
T7: Traceability report — FR-007
T8: Spec template loading — FR-008
T9: Tests + dogfooding — SC-001 a SC-008

Dependances : T1 -> T2 -> T3 -> T4 -> T6 -> T9
                             T2 -> T5 -> T6
                             T2 -> T7 -> T6
                             T2 -> T8 -> T6
