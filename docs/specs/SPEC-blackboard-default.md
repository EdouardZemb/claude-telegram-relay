# Spec : Blackboard actif par défaut sur pipelines multi-agents

> Généré le 2026-03-22. Source : analyse du code orchestrator.ts, execution.ts, auto-pipeline.ts, blackboard.ts, pipeline-selection.ts + interview utilisateur (2 rounds).

## 1. Objectif

Les utilisateurs oublient d'ajouter --blackboard lors de /orchestrate sur des pipelines complexes (DEFAULT, LIGHT, RESEARCH), perdant la traçabilité inter-agents (gates, adversarial verifier, traceability report). Cette spec active le blackboard par défaut sur les pipelines à 3+ agents et ajoute --no-blackboard pour le désactiver explicitement.

## 2. Règles métier

| # | Règle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Le blackboard est actif par défaut sur DEFAULT, LIGHT et RESEARCH | Réponse user Q2b | /orchestrate abc → blackboard actif |
| R2 | Le blackboard reste désactivé par défaut sur QUICK, SOLO et REVIEW | Réponse user Q2b | /orchestrate abc quick → pas de blackboard |
| R3 | --no-blackboard désactive explicitement le blackboard | Réponse user Q4c | /orchestrate abc --no-blackboard |
| R4 | --blackboard force l'activation (même sur QUICK/SOLO/REVIEW) | Compat existante | /orchestrate abc quick --blackboard |
| R5 | --overlap force le mode séquentiel quand le blackboard est actif | Réponse user Q3c, code L744-748 | --overlap avec DEFAULT → séquentiel (log warning) |
| R6 | Warning visible dans le chat quand fallback in-memory est utilisé | Réponse user Q5b | "Blackboard en mode degrade (in-memory)" |
| R7 | --no-blackboard disponible sur /orchestrate ET /autopipeline | Réponse user Q6b | /autopipeline abc --no-blackboard |
| R8 | Un pipeline custom (comma-separated) est traité comme DEFAULT pour le blackboard | Déduction logique | /orchestrate abc pm,dev,qa → blackboard actif (3 agents) |
| R9 | Le label d'affichage au lancement indique l'état du blackboard | Réponse user Q4c | "Blackboard: actif" ou "Blackboard: desactive" |

## 3. Données d'entrée

| Source | Type | Accès | Champs utilisés |
|--------|------|-------|-----------------|
| Arguments commande | string | ctx.match | --blackboard, --no-blackboard, pipeline type |
| Pipeline résolu | AgentRole[] | orchestrator.ts | Longueur et type du pipeline |
| Supabase | DB | bctx.supabase | Table blackboard (création session) |

## 4. Données de sortie

Pas de nouvelle structure. Le comportement existant du blackboard (sessions Supabase, gates, traceability report) est simplement activé par défaut sur certains pipelines. Ajout d'un warning Telegram quand le fallback in-memory est déclenché.

## 5. Fichiers concernés

| Fichier | Action | Raison |
|---------|--------|--------|
| src/commands/execution.ts | modifier | Parser --no-blackboard, calculer useBlackboard par défaut selon pipeline, ajouter le flag à /autopipeline, mise à jour labels et usage text |
| src/orchestrator.ts | modifier | Ajouter le warning in-memory visible (via onProgress), pas de changement à l'interface OrchestrateOptions |
| src/auto-pipeline.ts | modifier | Ajouter support useBlackboard dans PipelineOptions, propager à orchestrate() dans la phase analyse |
| src/commands/help.ts | modifier | Mise à jour texte /help pour refléter le nouveau comportement |
| src/action-registry.ts | modifier | Mise à jour usage de /orchestrate et /autopipeline |
| CLAUDE.md | modifier | Section Architecture : documenter le blackboard par défaut |

## 6. Patterns existants

Le blackboard est déjà entièrement implémenté dans orchestrator.ts (L627-679). Le changement est minimal : inverser la logique de défaut. Le pattern actuel :

```
const useBlackboard = args.includes("--blackboard");  // execution.ts L253
```

Devient une fonction qui détermine le défaut selon le pipeline résolu :

```
function shouldUseBlackboard(pipeline, hasExplicitFlag, hasNoFlag): boolean
```

Le fallback in-memory (InMemoryBlackboard, L648-654) existe déjà. Il suffit d'ajouter un message via onProgress quand il est activé (R6).

Pour /autopipeline, le pattern d'orchestrate() est déjà appelé dans la phase analyse (auto-pipeline.ts L212-219) mais sans passer useBlackboard. Il suffit de le propager.

## 7. Contraintes

- Ne pas casser les pipelines QUICK/SOLO/REVIEW qui ne passent pas par le blackboard aujourd'hui
- Ne pas modifier l'interface OrchestrateOptions (useBlackboard reste un boolean optionnel)
- Le flag --blackboard explicite doit continuer à forcer l'activation (backward compat)
- Le comportement avec --overlap est conservé (R5) : si blackboard actif, overlap est désactivé silencieusement avec warning console (code existant L744-748)
- Ne pas toucher à la logique interne du blackboard (verrouillage optimiste, sections, gates)

## 8. Critères de validation

| # | Critère | Vérification | Niveau |
|---|---------|-------------|--------|
| V1 | /orchestrate abc (pipeline DEFAULT) active le blackboard sans flag | Test unit : résoudre useBlackboard=true quand pipeline=DEFAULT | unit |
| V2 | /orchestrate abc quick n'active PAS le blackboard | Test unit : résoudre useBlackboard=false quand pipeline=QUICK | unit |
| V3 | /orchestrate abc --no-blackboard sur DEFAULT désactive le blackboard | Test unit : --no-blackboard override | unit |
| V4 | /orchestrate abc quick --blackboard force l'activation | Test unit : --blackboard override sur QUICK | unit |
| V5 | Pipeline custom à 3+ agents active le blackboard par défaut | Test unit : pipeline custom pm,dev,qa → useBlackboard=true | unit |
| V6 | Pipeline custom à 1-2 agents n'active PAS le blackboard | Test unit : pipeline custom dev,qa → useBlackboard=false | unit |
| V7 | Warning visible quand fallback in-memory est utilisé | Test unit : onProgress reçoit le message de warning | unit |
| V8 | /autopipeline supporte --no-blackboard | Test unit : parsing des args autopipeline | unit |
| V9 | Label de lancement affiche "Blackboard: actif" ou "Blackboard: desactive (--no-blackboard)" | Test unit : vérifier le message de lancement | unit |
| V10 | --overlap avec blackboard par défaut → séquentiel (comportement existant conservé) | Test unit : effectiveOverlap=false quand useBlackboard=true | unit |
| V11 | /help et usage text mis à jour | Manual : vérifier le texte | manual |
| V12 | CLAUDE.md mis à jour | Manual : vérifier la section Architecture | manual |
| V13 | LIGHT et RESEARCH activent le blackboard par défaut | Test unit : résoudre useBlackboard=true pour ces pipelines | unit |
| V14 | REVIEW n'active PAS le blackboard par défaut | Test unit : résoudre useBlackboard=false pour REVIEW | unit |
| V15 | Tous les tests existants passent (régression) | bun test | integration |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Problème | Couvert | Les utilisateurs oublient --blackboard, perdent la traçabilité |
| Périmètre | Couvert | Défaut par pipeline + --no-blackboard + doc, MVP clair |
| Validation | Couvert | 15 V-critères couvrant tous les cas |
| Technique | Couvert | Changement localisé (3 fichiers core + 3 fichiers doc), pas de nouvelle dépendance |
| UX | Pertinent | Le label d'affichage et le warning in-memory informent l'utilisateur du nouvel état |
| Alternatives | Non applicable | La seule alternative serait un feature flag, mais le changement est simple et ne justifie pas un flag supplémentaire |

**Zones d'ombre résiduelles** : aucune identifiée. Le changement est une inversion de défaut sur une fonctionnalité déjà implémentée et testée.
