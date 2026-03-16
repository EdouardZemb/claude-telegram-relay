# SDD Spec — S33 Architecture Multi-Agent : Fondations

## Overview

Ce sprint pose les fondations techniques pour que les agents BMad puissent interagir dynamiquement avec Supabase pendant leur execution, reprendre un pipeline apres echec, et utiliser le blackboard en temps reel. Ces trois axes resolvent le probleme fondamental identifie dans le benchmark S32 : les agents manquent de contexte projet pour produire du code fonctionnel.

## User Stories

US-001: En tant que developpeur, je veux que les agents BMad spawnes puissent querier Supabase pendant leur execution, pour qu'ils produisent du code mieux integre au projet.

US-002: En tant que developpeur, je veux pouvoir reprendre un pipeline multi-agent au dernier agent reussi apres un echec, pour ne pas perdre le travail deja fait.

US-003: En tant que developpeur, je veux que les agents lisent et ecrivent le blackboard pendant leur execution (pas seulement apres), pour que l'information circule en temps reel entre agents.

US-004: En tant que developpeur, je veux un prototype d'intent detection pour les messages naturels, pour explorer la transition vers un orchestrateur conversationnel.

## Functional Requirements

FR-001: MCP dynamique — Heritage de la config MCP par les agents spawnes
  Acceptance Criteria:
  - AC-001: GIVEN un agent spawne via spawnClaude() WHEN l'option mcpConfig est activee THEN l'agent a acces aux outils MCP (search_thoughts, get_tasks, get_sprint_summary, get_project_context, read_blackboard, write_blackboard)
  - AC-002: GIVEN un agent spawne sans option mcpConfig WHEN il s'execute THEN le comportement est identique a avant (backward compatible)
  - AC-003: GIVEN un agent spawne avec MCP WHEN il appelle get_project_context THEN il recoit les facts, goals, sprint summary et taches recentes

FR-002: MCP dynamique — Configuration MCP par role
  Acceptance Criteria:
  - AC-004: GIVEN un agent analyst WHEN il est spawne en orchestration THEN il a acces aux outils MCP memoire + projet (search_thoughts, get_tasks, get_sprint_summary, get_project_context)
  - AC-005: GIVEN un agent dev WHEN il est spawne en orchestration avec blackboard THEN il a acces aux outils MCP memoire + projet + blackboard (read_blackboard, write_blackboard)
  - AC-006: GIVEN la config MCP d'un agent WHEN elle est construite THEN elle est passee via le flag --mcp-config avec un fichier temporaire JSON

FR-003: Checkpoint / Resume de pipeline
  Acceptance Criteria:
  - AC-007: GIVEN un pipeline en cours d'execution WHEN un agent step se termine (succes ou echec) THEN l'etat du pipeline est persiste en Supabase (table pipeline_runs : session_id, pipeline_type, current_step, steps_completed, steps_results, blackboard_id, status, timestamps)
  - AC-008: GIVEN un pipeline qui a echoue a l'agent architect WHEN l'utilisateur lance /orchestrate <id> --resume THEN le pipeline reprend a l'agent architect avec les sorties des agents precedents restaurees
  - AC-009: GIVEN un pipeline qui reprend WHEN les agents precedents ont deja tourne THEN leurs sorties structurees sont chargees depuis pipeline_runs et passees comme previousMessages
  - AC-010: GIVEN un pipeline complete (tous agents reussis) WHEN on verifie pipeline_runs THEN le status est "completed" et toutes les sorties sont persistees

FR-004: Blackboard temps reel — Lecture pendant execution
  Acceptance Criteria:
  - AC-011: GIVEN un agent dev spawne avec MCP + blackboard WHEN il utilise l'outil read_blackboard THEN il lit la section plan ecrite par l'architecte precedemment
  - AC-012: GIVEN un agent qa spawne avec MCP + blackboard WHEN il utilise l'outil read_blackboard THEN il lit les sections spec, plan et implementation

FR-005: Blackboard temps reel — Ecriture pendant execution
  Acceptance Criteria:
  - AC-013: GIVEN un agent dev spawne avec MCP + blackboard WHEN il utilise l'outil write_blackboard pour la section implementation THEN le blackboard est mis a jour en base avec versioning optimiste
  - AC-014: GIVEN deux agents en parallele qui ecrivent WHEN ils utilisent write_blackboard simultanement THEN le locking optimiste gere le conflit (retry ou erreur explicite)

FR-006: Intent Detection — Prototype spike
  Acceptance Criteria:
  - AC-015: GIVEN un message naturel de l'utilisateur (ex: "montre moi le backlog") WHEN il est traite par la couche d'intent detection THEN l'intent est identifie (ex: "view_backlog") avec un score de confiance
  - AC-016: GIVEN un intent detecte avec confiance >= 0.8 WHEN le routeur le recoit THEN il suggere la commande correspondante (ex: "Je comprends que tu veux voir le backlog. Tu veux que je lance /backlog ?")
  - AC-017: GIVEN un message ambigu (confiance < 0.8) WHEN il est traite THEN le bot demande clarification au lieu d'agir
  - AC-018: GIVEN l'intent detection WHEN elle est deployee THEN elle est derriere un feature flag "intent_detection" (desactive par defaut)

## Edge Cases

EC-001: Agent spawne sans Supabase configuree — MCP config non generee, agent fonctionne normalement sans outils MCP
EC-002: Pipeline resume sur un pipeline inexistant — Erreur explicite "Aucun pipeline a reprendre pour cette tache"
EC-003: Pipeline resume quand le pipeline precedent est complete — Erreur "Ce pipeline est deja termine"
EC-004: Fichier MCP temporaire non nettoye apres crash — Nettoyage au demarrage du relay (tmp cleanup)
EC-005: Blackboard supprime entre deux etapes du pipeline resume — Erreur explicite, nouveau blackboard cree
EC-006: Intent detection sur un message vide ou trop court — Pas de detection, traitement normal
EC-007: Intent detection en conflit avec une commande slash explicite — La commande slash a toujours priorite

## Success Criteria

SC-001: Tous les tests existants passent (802+)
SC-002: 20+ nouveaux tests (unit + integration)
SC-003: Un agent spawne via /orchestrate peut appeler get_project_context via MCP et recevoir des donnees
SC-004: Un pipeline echoue peut etre repris via --resume sans relancer les agents deja termines
SC-005: Migration pipeline_runs s'applique cleanement sur Supabase
SC-006: Intent detection identifie correctement 5+ commandes courantes dans les tests

## Out of Scope

- Orchestrateur conversationnel complet (S34 Option B)
- Routage dynamique d'agents base sur le contexte (S34)
- Communication peer-to-peer entre agents
- Interface utilisateur pour le resume de pipeline (au-dela du flag --resume)
- Intent detection en production (reste derriere feature flag, spike exploratoire)

## Dependencies

- S32 : agent-context.ts et extension MCP (deja merge)
- Claude Code CLI : support du flag --mcp-config (a verifier)
- Table pipeline_runs : nouvelle migration Supabase

## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-001: spawnClaude avec mcpConfig genere un fichier MCP temporaire et passe --mcp-config
- [ ] AC-002: spawnClaude sans mcpConfig ne passe pas le flag --mcp-config
- [ ] AC-004/AC-005: buildMcpConfigForRole retourne les bons outils par role
- [ ] AC-006: buildMcpConfigFile cree un fichier JSON valide dans /tmp
- [ ] AC-007: savePipelineState persiste l'etat en base correctement
- [ ] AC-008: loadPipelineState charge l'etat et identifie le bon point de reprise
- [ ] AC-009: buildResumeContext reconstruit les previousMessages depuis les resultats sauvegardes
- [ ] AC-010: pipeline complete met a jour le status en base
- [ ] AC-015: detectIntent identifie correctement les intents pour 5+ patterns
- [ ] AC-016: routeIntent retourne la bonne commande avec confiance >= 0.8
- [ ] AC-017: routeIntent demande clarification si confiance < 0.8
- [ ] AC-018: intent detection respecte le feature flag
- [ ] EC-001: pas de MCP config si Supabase manquante
- [ ] EC-002: resume sur pipeline inexistant renvoie erreur
- [ ] EC-003: resume sur pipeline complete renvoie erreur
- [ ] EC-006: intent detection ignore messages vides/courts
- [ ] EC-007: commandes slash prioritaires sur intent detection

Integration Tests:
- [ ] SC-003: agent spawne accede a get_project_context via MCP (mock MCP server)
- [ ] SC-005: migration pipeline_runs s'applique et les CRUD fonctionnent
- [ ] AC-011: agent dev lit le blackboard via MCP apres ecriture par architect
- [ ] AC-013: agent dev ecrit le blackboard via MCP avec versioning

Acceptance Tests:
- [ ] FR-001: heritage MCP complet et fonctionnel
- [ ] FR-003: resume de pipeline end-to-end
- [ ] FR-006: intent detection spike valide sur 5+ patterns

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
