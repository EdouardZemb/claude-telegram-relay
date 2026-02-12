# Vision : Systeme Agentique Personnel avec Amelioration Continue

> Document de reference strategique — v1.0, 12 fevrier 2026


## 1. Ce qu'on construit

Un systeme de pilotage de projets logiciels par agent autonome, pilote depuis Telegram, qui s'ameliore en continu grace a l'analyse de ses propres performances et du feedback utilisateur.

Ce n'est pas un chatbot. C'est un partenaire de travail qui :
- Execute des taches de bout en bout (code, tests, PRs, deploy)
- Apprend de chaque interaction pour affiner sa comprehension du besoin
- Evalue sa propre qualite a chaque etape
- Fait evoluer ses propres processus en fonction des resultats mesures


## 2. Positionnement dans l'ecosysteme

### Ce qui existe

| Projet | Forces | Limites |
|--------|--------|---------|
| SICA (Bristol) | Agent qui modifie son propre code source, +36 points sur SWE-Bench | Academique, pas d'interface utilisateur, pas de gestion de projets |
| EvoAgentX (EMNLP 2025) | Workflows multi-agents avec evolution automatique, architecture en couches | Framework generique, pas personnalise, pas d'interface conversationnelle |
| BMad | Workflows YAML structures, gates de validation, artefacts tracables | Rigide, pas d'amelioration continue native, configuration manuelle |
| CrewAI | 100k+ devs, config YAML, roles d'agents | Orientee entreprise, pas de boucle de feedback personnel |
| LangGraph | Graphes de workflows flexibles, adopte par Klarna/Uber | Complexe, pas d'interface Telegram, pas de memoire personnelle |
| Devin (Cognition AI) | Ingenieur IA complet, $2B valorisation | Ferme, payant, pas personnalisable, pas de pilotage vocal |

### Notre position unique

Personne ne combine ces 4 elements :
1. Interface conversationnelle naturelle (Telegram + vocal)
2. Execution agentique complete (branch -> code -> PR -> CI -> deploy)
3. Memoire personnelle persistante (facts, goals, recherche semantique)
4. Amelioration continue du systeme par le systeme lui-meme

On construit le premier systeme agentique personnel qui evolue avec son utilisateur.


## 3. Architecture cible

### Vue d'ensemble

```
Edouard (Telegram)
    |
    v
[Relay Principal]
    |
    +---> [Moteur de Workflow] --- config: workflow.yaml
    |         |
    |         +---> Etape 1: Reception & Comprehension
    |         +---> Etape 2: Decomposition & Planification
    |         +---> Etape 3: Validation (optionnelle)
    |         +---> Etape 4: Execution (sous-agents Claude Code)
    |         +---> Etape 5: Auto-evaluation (checkpoint critique)
    |         +---> Etape 6: Review & Livraison
    |         +---> Etape 7: Cloture & Retro
    |
    +---> [Collecteur de Metriques]
    |         |
    |         +---> sprint_metrics (Supabase)
    |         +---> workflow_metrics (Supabase)
    |
    +---> [Moteur d'Amelioration Continue]
    |         |
    |         +---> Retros automatiques
    |         +---> Analyse de patterns
    |         +---> Propositions proactives
    |         +---> Evolution du workflow
    |
    +---> [Profil Evolutif]
    |         |
    |         +---> Preferences de travail
    |         +---> Domaines de confiance / autonomie
    |         +---> Patterns de communication
    |
    +---> [Routeur Multi-Projets] (futur)
              |
              +---> Projet A (backlog, sprints, repo)
              +---> Projet B (backlog, sprints, repo)
```


## 4. Les 5 piliers

### Pilier 1 : Workflow structure et configurable

Inspire de BMad, mais en version legere et evolutive.

Le workflow est defini dans un fichier de configuration (workflow.yaml ou table Supabase), pas en dur dans le code. Chaque etape a :
- Un nom et une description
- Des conditions d'entree et de sortie
- Un niveau d'autonomie (automatique, semi-automatique, validation requise)
- Un checkpoint d'auto-evaluation optionnel

Exemple de workflow par defaut :

```yaml
workflow:
  name: "standard"
  steps:
    - id: receive
      name: "Reception"
      auto: true

    - id: decompose
      name: "Decomposition"
      auto: true
      checkpoint:
        enabled: true
        questions:
          - "Le plan couvre-t-il tous les aspects de la demande ?"
          - "Y a-t-il des risques ou des dependances non identifies ?"

    - id: validate
      name: "Validation utilisateur"
      auto: false
      skip_if: "task.priority <= 2 AND task.type == 'bugfix'"

    - id: execute
      name: "Execution"
      auto: true
      checkpoint:
        enabled: true
        questions:
          - "Le code est-il propre et conforme aux conventions ?"
          - "Les tests passent-ils ?"
          - "Y a-t-il des regressions potentielles ?"

    - id: review
      name: "Review"
      auto: false
      checkpoint:
        enabled: true
        questions:
          - "Le diff est-il minimal et lisible ?"
          - "La PR repond-elle exactement a la demande ?"

    - id: close
      name: "Cloture"
      auto: true
      triggers:
        - collect_metrics
        - update_profile
```

Le workflow est un objet vivant. Il evolue en fonction des retros.


### Pilier 2 : Checkpoints d'auto-evaluation

A chaque etape optionnelle du workflow, le systeme fait une pause critique :

- Il genere une evaluation structuree de son propre travail
- Il identifie les points faibles et les risques
- Il decide : passer a l'etape suivante, corriger, ou escalader vers l'utilisateur

Les checkpoints sont configurables :
- Desactives pour les taches simples / faible risque
- Actives pour les taches complexes / impact eleve
- Le seuil se calibre automatiquement au fil du temps

Les resultats des checkpoints sont traces. Si un checkpoint detecte souvent des erreurs a une certaine etape, ca signale un probleme systematique a corriger.


### Pilier 3 : Metriques automatiques

A chaque sprint / tache / workflow, le systeme collecte automatiquement :

Metriques de sprint :
- Taches planifiees vs completees
- Temps moyen entre demande et livraison
- Nombre de corrections apres livraison
- Taux de PRs mergees du premier coup

Metriques de workflow :
- Temps passe a chaque etape
- Nombre de retours en arriere (etape N -> etape N-1)
- Taux de checkpoints qui detectent des problemes
- Frequence des escalades vers l'utilisateur

Metriques de qualite :
- Crashs / incidents post-deploy
- Bugs detectes apres livraison
- Satisfaction implicite (l'utilisateur corrige-t-il souvent le resultat ?)

Stockage : table sprint_metrics et workflow_metrics dans Supabase.


### Pilier 4 : Retros automatiques et evolution du workflow

A la fin de chaque sprint :

1. Le systeme genere une retro basee sur les metriques
2. Il identifie les patterns recurrents (positifs et negatifs)
3. Il propose des ajustements du workflow :
   - Ajouter/supprimer des etapes
   - Modifier les niveaux d'autonomie
   - Ajuster les seuils de checkpoints
   - Reorganiser les priorites
4. L'utilisateur valide, rejette ou ajuste les propositions
5. Le workflow est mis a jour en consequence

Les propositions ne sont jamais imposees. Le systeme suggere, l'utilisateur decide. Et cette decision elle-meme nourrit le systeme.


### Pilier 5 : Profil evolutif

Le profil utilisateur passe de statique (fichier profile.md) a dynamique :

- Preferences de travail : petits sprints ou gros blocs ? Matin ou apres-midi ?
- Patterns de communication : quand l'utilisateur veut discuter vs quand il veut de l'execution directe
- Domaines de confiance : ou l'agent a l'autonomie totale, ou il doit valider
- Seuils de qualite : ce qui est "assez bien" vs ce qui doit etre parfait
- Recurrence des corrections : les patterns de feedback qui reviennent

Le profil se met a jour incrementalement. Pas de reecriture totale, des ajustements fins apres chaque interaction significative.


## 5. Roadmap d'implementation

### Phase A : Fondations (Sprint S11)

Objectif : poser le socle de l'amelioration continue.

- Table sprint_metrics dans Supabase
- Table workflow_metrics dans Supabase
- Script de collecte des metriques a la cloture d'un sprint
- Commande /retro pour generer une retro automatique
- Premier workflow.yaml avec le pipeline par defaut
- Checkpoints d'auto-evaluation dans le flux /exec

### Phase B : Intelligence reflexive (Sprint S12-S13)

Objectif : le systeme apprend de ses propres donnees.

- Analyse de patterns sur les metriques accumulees
- Propositions d'amelioration du workflow basees sur les donnees
- Profil evolutif avec mise a jour incrementale
- Dashboard : vue metriques et evolution du workflow
- Alertes proactives ("ce sprint semble surcharge")

### Phase C : Multi-projets (Sprint S14-S15)

Objectif : etendre le systeme a plusieurs projets.

- Notion de "projet actif" dans le bot
- Commande /project pour switcher de contexte
- Backlog et sprints filtres par projet
- /exec sait dans quel repo travailler
- Vue consolidee cross-projets dans le dashboard

### Phase D : Orchestration avancee (Sprint S16+)

Objectif : le systeme devient un veritable partenaire strategique.

- Detection automatique du projet a partir du contexte
- Priorisation intelligente entre projets
- Propositions strategiques ("tu devrais bosser sur X")
- Dependances inter-projets
- Rapports consolides


## 6. Principes directeurs

1. Le workflow est un outil, pas une contrainte. Il existe pour etre mesure et ameliore, pas pour etre subi.

2. L'autonomie se gagne par la confiance. Le systeme commence avec plus de validations et gagne en autonomie au fur et a mesure que la confiance s'etablit.

3. Les metriques servent l'amelioration, pas le controle. On mesure pour comprendre et s'adapter, pas pour juger.

4. Les propositions ne sont jamais imposees. Le systeme suggere, l'utilisateur decide.

5. La simplicite d'abord. Chaque ajout doit justifier sa complexite par une valeur mesurable.

6. L'interface reste Telegram. Pas de dashboards compliques pour le pilotage quotidien. Le dashboard sert pour la visualisation, Telegram pour l'action.


## 7. Ce qu'on ne fait PAS

- On ne construit pas un framework generique a la CrewAI. C'est un outil personnel, optimise pour un utilisateur.
- On ne fait pas du multi-tenant. Un serveur = un utilisateur = un systeme.
- On ne remplace pas les outils existants (GitHub, Supabase). On les orchestre.
- On ne vise pas la perfection du premier coup. On vise l'amelioration continue.


## 8. Mesures de succes

Comment savoir si on a reussi ?

- Le temps entre "j'ai une idee" et "c'est en production" diminue sprint apres sprint
- Le nombre de corrections post-livraison diminue
- Le niveau d'autonomie de l'agent augmente (moins de validations manuelles necessaires)
- Le workflow evolue naturellement en fonction des retros
- L'utilisateur fait confiance au systeme pour des taches de plus en plus complexes


---

*Ce document est lui-meme un objet vivant. Il sera mis a jour a chaque evolution significative du systeme.*
