# S35 — Auto-amélioration & Confiance

## Objectif

Rendre le système capable d'apprendre de ses erreurs et de gagner en autonomie progressivement.
Les agents qui réussissent systématiquement les gates gagnent en confiance (trust score).
Les patterns d'erreurs récurrents enrichissent automatiquement les prompts (double-loop learning).

## Prérequis

- S34 : Scoring rubrique structuré (4 dimensions × 25 points) dans gate-evaluator.ts
- S34 : Routage en cascade et routeur LLM

## Functional Requirements

### FR-001 : Persistance des résultats de gate (fondation)

Persister les résultats complets de chaque évaluation de gate dans Supabase.

**Table `gate_evaluations` :**
- session_id, task_id, sprint_id, agent_role, gate_name
- score (0-100), passed (boolean)
- rubric_dimensions (JSONB : 4 dimensions avec score, feedback, critical)
- deterministic_checks (JSONB : résultats tsc/bun test)
- rework_iteration (0, 1, 2), rework_triggered (boolean)
- created_at

**Acceptance Criteria :**
- AC-001 : Chaque appel à evaluateGate() persiste le résultat dans gate_evaluations
- AC-002 : Les dimensions rubrique sont stockées avec score, feedback, et flag critical
- AC-003 : Les résultats des checks déterministes sont stockés (check, passed, output tronqué, duration)
- AC-004 : Le numéro d'itération rework est tracké (0 = premier essai)
- AC-005 : Requêtes disponibles : par agent_role, par gate_name, par sprint_id

### FR-002 : Trust Scores par rôle d'agent

Calculer et maintenir un score de confiance par rôle d'agent basé sur l'historique des gate evaluations.

**Table `trust_scores` :**
- agent_role (PK), score (0-100, default 50), consecutive_passes, consecutive_failures
- total_evaluations, total_passes, last_evaluation_at, updated_at

**Calcul :**
- Gate pass sans rework : +5 points (cap à 100)
- Gate pass avec rework : +1 point
- Gate fail (après max rework) : -10 points (floor à 0)
- Score initial : 50 (neutre)
- Le score reflète la fiabilité récente, pas l'historique total

**Acceptance Criteria :**
- AC-006 : Trust score calculé et mis à jour après chaque gate evaluation
- AC-007 : Score borné entre 0 et 100
- AC-008 : Passes consécutives et failures consécutives trackées
- AC-009 : Score initial de 50 pour un nouveau rôle
- AC-010 : updateTrustScore() appelé dans evaluateAndRework() après le résultat final

### FR-003 : Double-loop Learning

Quand un même type d'erreur rubrique est détecté 3+ fois pour un agent, enrichir automatiquement son prompt système.

**Mécanisme :**
1. Après chaque gate evaluation, analyser les dimensions rubrique avec score < 15
2. Grouper par (agent_role, dimension_name) dans gate_evaluations
3. Si une dimension est faible 3+ fois : générer une instruction corrective
4. Stocker dans feedback_rules avec source = "double_loop" (vs "retro" existant)
5. L'instruction est injectée dans le prompt via buildFeedbackContext() (existant)

**Acceptance Criteria :**
- AC-011 : Dimensions faibles (< 15/25) détectées après chaque gate evaluation
- AC-012 : Compteur par (agent_role, dimension) maintenu
- AC-013 : À 3+ occurrences, feedback_rule créée automatiquement avec source "double_loop"
- AC-014 : L'instruction générée est spécifique à la dimension (pas générique)
- AC-015 : Les règles double-loop s'affichent dans buildFeedbackContext() comme les règles retro
- AC-016 : Pas de doublon : si une règle existe déjà pour (agent_role, dimension), mettre à jour

### FR-004 : Autonomie Progressive des Gates

Les gates s'auto-approuvent pour les agents avec un trust score élevé sur les tâches simples.

**Seuils :**
- Trust score >= 80 ET priorité P3+ : gate spec/plan auto-approuvée (skip LLM)
- Trust score >= 90 ET priorité P3+ : gate implementation auto-approuvée (checks déterministes seulement, skip LLM)
- Trust score < 80 OU priorité P1/P2 : évaluation complète (comportement actuel)

**Acceptance Criteria :**
- AC-017 : evaluateGate() vérifie le trust score avant l'évaluation LLM
- AC-018 : Auto-approval loggée dans gate_evaluations avec flag auto_approved = true
- AC-019 : Tâches P1/P2 toujours évaluées complètement, quel que soit le trust score
- AC-020 : Feature flag "auto_gate_approval" (disabled par défaut)
- AC-021 : Les checks déterministes tournent toujours, même en auto-approval

### FR-005 : Dashboard Confiance dans /monitor

Étendre /monitor avec les trust scores et métriques de confiance.

**Affichage :**
- Trust scores par rôle (score, passes/failures consécutives, total évaluations)
- Décisions récentes (5 dernières gate evaluations avec résultat)
- Règles double-loop actives (agent, dimension, instruction)
- Gates auto-approuvées récentes (si feature flag actif)

**Acceptance Criteria :**
- AC-022 : /monitor affiche les trust scores de tous les rôles
- AC-023 : /monitor affiche les 5 dernières gate evaluations
- AC-024 : /monitor affiche les règles double-loop actives
- AC-025 : Format plain text, pas de markdown

## Edge Cases

- EC-001 : Aucune gate evaluation en base → trust score = 50 (default), dashboard affiche "Pas de donnees"
- EC-002 : Supabase indisponible → trust score default 50, pas d'auto-approval, warning loggé
- EC-003 : Dimension rubrique absente (vieux format sans rubric) → ignorée pour le double-loop
- EC-004 : Trust score à 90 mais checks déterministes échouent → gate échoue (pas d'auto-approval)
- EC-005 : Deux pipelines concurrents modifient le même trust score → dernier écrit gagne (acceptable)

## Success Criteria

- 45+ nouveaux tests
- Tous les 909+ tests existants passent
- Trust scores calculés et persistés après chaque gate
- Double-loop détecte et corrige les faiblesses récurrentes
- /monitor affiche les métriques de confiance
- Feature flag auto_gate_approval contrôle l'autonomie progressive
- Backward compatible : comportement identique avec feature flag off
