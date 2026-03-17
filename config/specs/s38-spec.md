# SDD Spec — S38 Communication Inter-Agents

## Overview

Passer d'agents isoles qui produisent du JSON en sequence a des agents qui communiquent entre eux pendant l'execution. Les agents Claude Code sont des sous-processus CLI, la communication passe donc par le blackboard (messages persistants) et le superviseur (re-invocation pour clarification). Audit trail complet via event sourcing.

## Prerequis

- S37 Orchestrateur conversationnel (complete)
- Blackboard avec working_memory (S36-07)
- Supervisor deterministe (S25)
- Pipeline checkpoint/resume (S33)
- DAG executor avec execution parallele (S25)

## User Stories

US-001: As a pipeline operator, I want a full audit trail of agent execution so I can debug failures and understand agent behavior.
US-002: As a downstream agent, I want to ask a clarification question to a previous agent so I can resolve ambiguities without producing low-quality output.
US-003: As a pipeline operator, I want to see the communication flow between agents so I can understand how decisions were made.
US-004: As an agent, I want to read observations and decisions from other agents beyond just their structured output so I have richer context.
US-005: As a supervisor, I want to detect when agents disagree so I can mediate and produce a consistent result.

## Functional Requirements

### FR-001 : Agent Event Log (Event Sourcing)

Table `agent_events` pour tracer le cycle de vie complet de chaque agent dans un pipeline.

**Schema :**
```sql
CREATE TABLE agent_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_agent_events_session ON agent_events(session_id);
CREATE INDEX idx_agent_events_role ON agent_events(session_id, agent_role);
```

**Event types :**
- `spawned` — agent process started (payload: model, effort, budget)
- `started` — agent began processing (payload: prompt_tokens estimate)
- `output_produced` — agent returned structured output (payload: output summary, token count)
- `completed` — agent finished successfully (payload: duration_ms, tokens_input, tokens_output, cost_usd)
- `failed` — agent failed (payload: error, exit_code)
- `retried` — agent retry triggered (payload: attempt, reason)
- `skipped` — agent skipped by supervisor (payload: reason)
- `timed_out` — agent exceeded timeout (payload: timeout_ms)
- `message_sent` — agent sent an inter-agent message (payload: to, message_type)
- `message_received` — agent received an inter-agent message (payload: from, message_type)
- `clarification_requested` — agent asked for clarification (payload: target_agent, question)
- `clarification_resolved` — clarification answered (payload: source_agent, answer summary)

**Integration :**
- `emitAgentEvent(supabase, sessionId, role, eventType, payload)` — fire-and-forget async
- Appele dans orchestrator.ts a chaque etape du pipeline (before/after spawnClaude)
- In-memory fallback quand Supabase indisponible (array locale, incluse dans le rapport final)

**Acceptance Criteria :**
- AC-001 : Chaque execution d'agent genere au minimum spawned + completed|failed|timed_out
- AC-002 : Les events sont stockes dans agent_events avec session_id correct
- AC-003 : In-memory fallback fonctionne quand supabase est null
- AC-004 : getAgentEvents(sessionId) retourne la timeline ordonnee par created_at
- AC-005 : getAgentEvents(sessionId, role) filtre par role

### FR-002 : Canal de messages inter-agents

Nouvelle section `messages` dans le blackboard pour la communication structuree entre agents.

**Message envelope :**
```typescript
interface AgentInterMessage {
  id: string;           // UUID
  from: AgentRole;      // expediteur
  to: AgentRole | '*';  // destinataire (* = broadcast)
  type: 'directive' | 'question' | 'observation' | 'warning' | 'escalation';
  content: string;      // le message
  correlationId?: string; // pour lier question/reponse
  timestamp: string;    // ISO 8601
  resolved?: boolean;   // pour les questions
}
```

**Mecanisme :**
1. Nouvelle section `messages` ajoutee au blackboard (type `AgentInterMessage[]`)
2. `sendAgentMessage(supabase, sessionId, message)` — ecrit dans la section messages
3. `getAgentMessages(supabase, sessionId, forRole)` — lit les messages destines a un role (ou broadcasts)
4. Les messages sont inclus dans le contexte agent via `buildStructuredChainContext()`
5. Write authorization : tous les roles peuvent ecrire dans `messages`

**Types de messages :**
- `directive` — instruction d'un agent amont (ex: architect -> dev "utilise le pattern Observer")
- `question` — demande de clarification (declenche FR-003)
- `observation` — fait decouvert pendant l'execution (enrichit le contexte)
- `warning` — alerte sur un risque ou probleme detecte
- `escalation` — probleme non resolu, remonte au superviseur

**Acceptance Criteria :**
- AC-006 : Section messages disponible dans le blackboard
- AC-007 : sendAgentMessage ecrit dans la section messages avec optimistic locking
- AC-008 : getAgentMessages filtre par destinataire (role exact ou broadcast *)
- AC-009 : Messages inclus dans le contexte des agents downstream
- AC-010 : Tous les roles peuvent ecrire des messages (pas de restriction)
- AC-011 : Messages tries par timestamp

### FR-003 : Protocole de clarification (Request/Reply)

Quand un agent downstream a besoin d'une clarification, il peut demander au superviseur de re-invoquer un agent precedent.

**Mecanisme :**
1. L'agent downstream ecrit un message `type: 'question'` avec `to: <target_role>`
2. Apres completion de l'agent, le superviseur detecte les questions non resolues (`resolved: false`)
3. Le superviseur re-invoque l'agent cible avec la question en contexte
4. L'agent cible ecrit une reponse (`type: 'directive'`, `correlationId: question.id`, marque `resolved: true`)
5. L'agent demandeur est re-invoque avec la reponse

**Gardes :**
- Max 1 round-trip par paire d'agents par pipeline (eviter les boucles infinies)
- Timeout standard de l'agent pour la reponse
- Si le round-trip echoue, le superviseur escalade a l'utilisateur (message Telegram)
- Cout du round-trip compte dans le budget pipeline

**Integration superviseur :**
- `Supervisor.checkPendingClarifications(sessionId)` — detecte les questions non resolues
- `Supervisor.resolveClarification(sessionId, question, targetRole)` — orchestre le round-trip
- Les clarifications sont tracees dans agent_events (clarification_requested, clarification_resolved)

**Acceptance Criteria :**
- AC-012 : Un agent peut ecrire une question avec type 'question' et to specifique
- AC-013 : Le superviseur detecte les questions non resolues apres completion d'un agent
- AC-014 : Le superviseur re-invoque l'agent cible avec la question
- AC-015 : La reponse est ecrite comme message et la question marquee resolved
- AC-016 : Max 1 round-trip par paire d'agents (guard anti-boucle)
- AC-017 : Timeout => escalation a l'utilisateur
- AC-018 : Agent events traces pour chaque clarification

### FR-004 : Detection de conflits et mediation

Quand deux agents produisent des decisions contradictoires, le superviseur detecte et medie.

**Mecanisme :**
1. Apres chaque agent, analyser les decisions dans working_memory vs les decisions precedentes
2. Detection de conflit : memes sujets (cles similaires dans decisions[]) + conclusions differentes
3. Heuristique simple : comparaison des champs `decision` par overlap lexical (Jaccard > 0.5) + assertion differente
4. Si conflit detecte :
   a. Le superviseur ecrit un message `type: 'escalation'` avec les deux positions
   b. Re-invoque l'agent de plus haut rang (architect > pm > analyst) avec les deux positions pour trancher
   c. Si le conflit persiste apres mediation, notification Telegram a l'utilisateur avec les deux positions + bouton "Choisir A / Choisir B / Ignorer"
5. La resolution est enregistree dans working_memory.decisions[]

**Acceptance Criteria :**
- AC-019 : Conflits detectes par overlap lexical des decisions dans working_memory
- AC-020 : Mediation par re-invocation de l'agent de plus haut rang
- AC-021 : Escalation Telegram si le conflit persiste apres mediation
- AC-022 : Resolution enregistree dans working_memory

### FR-005 : Contexte enrichi avec messages

Le contexte des agents est enrichi avec les messages inter-agents en plus des outputs structures.

**Mecanisme :**
1. `buildStructuredChainContext()` inclut une section "Messages inter-agents" avec les messages pertinents
2. Les messages filtres : ceux adresses au role courant + broadcasts
3. Les questions resolues incluent la reponse (correlation)
4. Les warnings et escalations sont priorises (affiches en premier)
5. Budget token : max 2000 tokens pour les messages (tronquer les plus anciens si necessaire)

**Acceptance Criteria :**
- AC-023 : buildStructuredChainContext inclut les messages inter-agents
- AC-024 : Messages filtres par destinataire
- AC-025 : Questions resolues presentees avec leur reponse
- AC-026 : Budget token respecte (max 2000 tokens pour les messages)

### FR-006 : Monitoring inter-agents

Extension de /monitor pour visualiser les communications inter-agents.

**Mecanisme :**
1. `getAgentTimeline(sessionId)` — timeline textuelle des events d'un pipeline
2. `getMessageFlow(sessionId)` — resume des messages echanges (from -> to, type, resolved?)
3. `/monitor` ajoute une section "Dernier pipeline" avec :
   - Timeline des agents (spawned -> completed avec duree)
   - Messages echanges (nombre, par type)
   - Clarifications (demandees, resolues, echouees)
   - Conflits detectes et resolutions
4. Metriques dans pipeline_runs : nombre de messages, nombre de clarifications, nombre de conflits

**Acceptance Criteria :**
- AC-027 : getAgentTimeline retourne les events ordonnes avec formatting lisible
- AC-028 : getMessageFlow resume les messages par paire d'agents
- AC-029 : /monitor affiche la section "Dernier pipeline"
- AC-030 : Pipeline metrics incluent message_count, clarification_count, conflict_count

## Edge Cases

EC-001 : Supabase indisponible pour agent_events — fallback in-memory, events inclus dans le rapport final du superviseur
EC-002 : Agent ne produit pas de question structuree (output brut) — pas de clarification, pipeline continue normalement
EC-003 : Clarification re-invoke echoue (agent crash) — superviseur marque la question comme non resolue, continue le pipeline avec un warning
EC-004 : Plus de 20 messages dans un pipeline — tronquer les plus anciens dans le contexte (garder les 15 plus recents)
EC-005 : Pipeline sequentiel (parallel: false) — meme comportement, les messages sont ecrits/lus via blackboard
EC-006 : Pipeline sans blackboard — pas de messages inter-agents, comportement actuel preserve
EC-007 : Deux agents ecrivent simultanement dans messages (parallele) — writeSectionWithRetry gere le conflit (optimistic locking existant)
EC-008 : Conflit detection sur des decisions non comparables — false positive ignore, pas d'impact fonctionnel
EC-009 : Agent tente de communiquer avec un agent pas encore execute — message stocke, sera lu quand l'agent sera invoque (pas de blocage)

## Success Criteria

SC-001 : 60+ nouveaux tests
SC-002 : Tous les tests existants passent (1085+)
SC-003 : Events traces dans agent_events pour chaque pipeline run
SC-004 : Messages inter-agents lisibles dans le contexte des agents downstream
SC-005 : Clarification round-trip fonctionne dans un pipeline blackboard
SC-006 : /monitor affiche la timeline et les messages du dernier pipeline
SC-007 : Backward compatible : pipelines existants sans changement de comportement
SC-008 : Feature flag `inter_agent_messaging` (desactive par defaut)

## Out of Scope

- Migration vers Agent Teams SDK natif (evaluer en S39+)
- Communication cross-pipeline (entre pipelines differents)
- Message persistence a long terme (au-dela de la vie du pipeline)
- LLM-based conflict detection (heuristique simple suffit pour cette iteration)
- Real-time streaming entre agents (les agents sont des sous-processus CLI batch)

## Dependencies

- S37 Orchestrateur conversationnel (complete)
- Blackboard avec optimistic locking (S24)
- Working memory (S36-07)
- Supervisor (S25)
- Pipeline checkpoint/resume (S33)

## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-001 : emitAgentEvent cree spawned + completed
- [ ] AC-002 : events stockes dans agent_events via Supabase
- [ ] AC-003 : fallback in-memory quand supabase null
- [ ] AC-004 : getAgentEvents retourne timeline ordonnee
- [ ] AC-005 : getAgentEvents filtre par role
- [ ] AC-006 : section messages dans le blackboard
- [ ] AC-007 : sendAgentMessage ecrit avec optimistic locking
- [ ] AC-008 : getAgentMessages filtre par destinataire
- [ ] AC-009 : messages inclus dans contexte agent
- [ ] AC-010 : tous les roles autorisent ecriture messages
- [ ] AC-011 : messages tries par timestamp
- [ ] AC-012 : agent ecrit question avec type et to
- [ ] AC-013 : superviseur detecte questions non resolues
- [ ] AC-014 : superviseur re-invoque agent cible
- [ ] AC-015 : reponse ecrite et question marquee resolved
- [ ] AC-016 : guard max 1 round-trip par paire
- [ ] AC-017 : timeout => escalation
- [ ] AC-018 : events traces pour clarifications
- [ ] AC-019 : detection conflits par overlap lexical
- [ ] AC-020 : mediation par agent haut rang
- [ ] AC-021 : escalation Telegram si conflit persiste
- [ ] AC-022 : resolution dans working_memory
- [ ] AC-023 : buildStructuredChainContext inclut messages
- [ ] AC-024 : messages filtres par destinataire
- [ ] AC-025 : questions resolues avec reponse
- [ ] AC-026 : budget token 2000 max
- [ ] AC-027 : getAgentTimeline formate lisiblement
- [ ] AC-028 : getMessageFlow resume par paire
- [ ] AC-029 : /monitor affiche section pipeline
- [ ] AC-030 : pipeline metrics avec counts
- [ ] EC-001 : fallback in-memory pour events
- [ ] EC-002 : pas de question structuree -> continue
- [ ] EC-003 : clarification echoue -> warning + continue
- [ ] EC-004 : tronquer messages > 20
- [ ] EC-005 : mode sequentiel fonctionne
- [ ] EC-006 : sans blackboard -> pas de messages
- [ ] EC-007 : ecriture concurrente messages -> retry
- [ ] EC-008 : faux positif conflit -> ignore
- [ ] EC-009 : message vers agent futur -> stocke et lu plus tard

Integration Tests:
- [ ] SC-003 : events dans agent_events apres un orchestrate mock
- [ ] SC-005 : clarification round-trip complet

Acceptance Tests:
- [ ] FR-001 : toutes les AC-001 a AC-005 satisfaites
- [ ] FR-002 : toutes les AC-006 a AC-011 satisfaites
- [ ] FR-003 : toutes les AC-012 a AC-018 satisfaites
- [ ] FR-004 : toutes les AC-019 a AC-022 satisfaites
- [ ] FR-005 : toutes les AC-023 a AC-026 satisfaites
- [ ] FR-006 : toutes les AC-027 a AC-030 satisfaites

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
