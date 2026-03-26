---
phase: 0-explore
generated_at: "2026-03-25T00:00:00Z"
subject: "Amélioration boucle de rétroaction automatique (feedback-analyzer, prompt-overlay, sdd-agents)"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

La boucle de rétroaction automatique du projet (modules `feedback-analyzer.ts`, `prompt-overlay.ts`, `sdd-agents.ts`) a pour objectif d'améliorer de façon autonome les prompts des agents SDD à partir de leurs résultats passés. Le mécanisme actuel fonctionne en trois temps : (1) détection de patterns d'échecs répétés via comptage brut par rôle, (2) génération d'un overlay textuel statique (template hard-codé), (3) injection de l'overlay dans le prompt de l'agent au prochain appel.

Cette exploration est nécessaire car plusieurs limites structurelles ont été identifiées lors de l'analyse du code :

1. **`fetchSignals` retourne toujours `[]` en production** : la dépendance de production injectée dans `getDeps()` fait `fetchSignals: async () => []` — la boucle ne reçoit donc jamais de signaux réels. C'est le gap le plus critique : la feature est activée (`prompt_feedback_loop: true` dans `config/features.json`) mais ne produit aucun overlay en pratique.

2. **Détection de patterns limitée à un comptage total** : l'algorithme `analyzeAgentFeedback` ne tient pas compte du temps (pas de fenêtre glissante), ne distingue pas les types d'erreurs dans les signaux (un `NO-GO` pour "spec trop vague" et un `NO-GO` pour "imports manquants" génèrent le même overlay), et n'exploite pas le champ `details` des signaux.

3. **Overlays statiques basés sur des templates hard-codés** : `generateOverlayText` utilise 4 templates fixes par `source` × `agentRole`. L'overlay ne reflète pas la nature réelle de l'erreur, et sa valeur corrective diminue vite avec le temps.

4. **Persistance locale uniquement (JSON fichier)** : les overlays sont stockés dans `~/.claude-relay/prompt-overlays.json`. Ils survivent aux redémarrages du bot mais sont perdus si le répertoire change ou lors d'une migration. La table Supabase `feedback_rules` existe mais n'est pas utilisée par le nouveau système.

5. **Métriques d'efficacité absentes** : on ne sait pas si un overlay a effectivement amélioré les résultats d'un agent. Il n'y a aucun suivi de l'impact des overlays sur les verdicts post-activation.

6. **Fréquence horaire bloquée sur un heartbeat arrêté** : le heartbeat PM2 est actuellement stoppé (mémoire `architecture_v2_progress.md` : "PM2 services actifs : relay, dashboard (heartbeat stoppe)"), ce qui signifie que la boucle ne tourne pas du tout.

L'exploration doit identifier les pistes d'amélioration les plus rentables selon trois axes : fréquence d'exécution, qualité de détection des patterns, persistance/métriques.

---

## Section 2 — État de l'art

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Adaline — Complete Guide to LLM & AI Agent Evaluation 2026](https://www.adaline.ai/blog/complete-guide-llm-ai-agent-evaluation-2026) | Guide | 2026 | Patterns d'évaluation continue : production-to-test pipeline, LLM-as-judge, threshold-gated prompt deployment, état partagé entre expérimentation et production | ★★★★★ |
| 2 | [Medium — Feedback-Driven AI: The Key to Building Better LLMs](https://medium.com/@aartijha96/feedback-driven-ai-the-key-to-building-better-llms-627518e364cc) | Article | 2025 | Techniques RLHF, RLRF, Self-Refine, MemPrompt, LLMRefine — mécanismes d'auto-amélioration des LLMs par feedback | ★★★★☆ |

### Synthèse de l'état de l'art

**Pattern 1 — Fermeture de la boucle (Adaline)**

Le consensus 2025-2026 insiste sur un cycle continu : chaque échec en production doit devenir un cas de régression dans l'évaluation. Le principe clé : *"vos métriques d'évaluation deviennent vos métriques de monitoring en production"*. Pour un système d'overlays, cela implique que les overlays ne peuvent être générés qu'à partir de signaux réels capturés en production — un `fetchSignals: async () => []` est un antipattern fondamental.

**Pattern 2 — Évaluation multi-niveaux (Adaline)**

Les systèmes efficaces évaluent à trois niveaux : execution-level (les appels d'outils ont-ils réussi ?), trajectory-level (le raisonnement était-il cohérent ?), outcome-level (l'objectif a-t-il été atteint ?). Pour les agents SDD, cela correspond à : l'agent a-t-il produit un fichier ? La spec est-elle structurée ? Le verdict challenge était-il GO ? Cette granularité permet d'ajuster les overlays de façon ciblée.

**Pattern 3 — MemPrompt et Self-Refine (Medium)**

MemPrompt maintient une mémoire dynamique des corrections passées pour informer les réponses futures. C'est exactement le rôle des overlays, mais la version actuelle ne dispose d'aucun mécanisme de rétroaction : un overlay injecté n'est jamais évalué sur son efficacité. Self-Refine (génération → critique → révision) suggère d'utiliser un LLM léger (Haiku) pour générer des overlays contextuels plutôt que des templates statiques.

**Pattern 4 — Stopping criteria (Medium)**

Les boucles de feedback efficaces définissent des critères d'arrêt clairs : l'overlay doit être désactivé si les performances s'améliorent après N cycles. L'actuel TTL de 7 jours fixe est une approximation grossière — un overlay devrait être désactivé dès que le pattern qu'il corrige disparaît.

---

## Section 3 — Archéologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/feedback-analyzer.ts` (233 LOC) | `fetchSignals: async () => []` en production — la boucle est fonctionnellement vide. L'interface `AgentFeedbackSignal` est correcte mais jamais alimentée. | Critique |
| 2 | `src/prompt-overlay.ts` (212 LOC) | Stockage JSON local robuste, API claire, max 3 overlays/agent, TTL 7j. Bien testée. `buildEnrichedPrompt` correctement appelé dans `sdd-agents.ts`. | Bon actif |
| 3 | `src/sdd-agents.ts` (562 LOC) | `readAgentFile` injecte les overlays si `prompt_feedback_loop` activé. Tous les verdicts SDD sont retournés sous forme de strings préfixées (`SDD_CHALLENGE_NO-GO:`, `SDD_REVIEW_CHANGES_REQUESTED:`, etc.) — source idéale pour des signaux. | Actif clé |
| 4 | `src/heartbeat.ts` (739 LOC) | `runFeedbackLoop()` appelé toutes les heures dans `pulse()`. Heartbeat PM2 est actuellement stoppé → la boucle ne tourne pas en production. Mécanisme de timing correct mais service inactif. | Bloquant |
| 5 | `src/job-manager.ts` | Analyse les résultats des jobs SDD via regex `SDD_\w+_(NO-GO|FAILED|...)` pour `sdd-auto-advance`. Cette même logique pourrait alimenter `fetchSignals`. | Actif réutilisable |
| 6 | `db/schema.sql` — table `agent_events` | Colonnes : `session_id`, `agent_role`, `event_type`, `payload JSONB`. Indexée par `(session_id, agent_role)`. Pourrait stocker les signaux SDD persistants. | Actif réutilisable |
| 7 | `db/schema.sql` — table `feedback_rules` | Colonnes : `agent_id`, `pattern`, `instruction`, `occurrences`, `sprints`, `active`, `source`. Existante mais non utilisée par le système actuel. Correspond exactement au besoin de persistance des overlays. | Actif sous-exploité |
| 8 | `db/schema.sql` — table `cost_tracking` | `agent_role`, `model`, `duration_ms`, `retry_attempt`. Pourrait servir de proxy de qualité (retries élevés = agent en difficulté). | Actif optionnel |
| 9 | `config/features.json` | `prompt_feedback_loop: true` — feature activée. `sdd_auto_advance: false` — auto-avancement désactivé. | Contexte opérationnel |
| 10 | `tests/unit/feedback-analyzer.test.ts` | 10 tests couvrant V1-V8. Tous passent avec `fetchSignals` mocké. Aucun test E2E de la chaîne complète (job → signal → overlay → agent enrichi). | Couverture partielle |

**Points de friction identifiés :**

- **Friction F1** : `fetchSignals` est une dépendance injectée mais sa valeur par défaut est `async () => []`. Toute implémentation réelle doit passer par `_setDependencies()` (mécanisme de test uniquement) ou modifier `getDeps()` pour une vraie source.
- **Friction F2** : La table `feedback_rules` utilise `agent_id` (not `agentRole`) et `source IN ('retro', 'double_loop')` — incompatible directement avec les nouveaux signaux SDD sans migration.
- **Friction F3** : `generateOverlayText` est déterministe et ne lit pas le champ `details` des signaux — les overlays générés sont identiques quelle que soit la cause réelle de l'échec.
- **Friction F4** : Absence de feedback sur l'efficacité d'un overlay : aucun compteur de "succès post-overlay" pour mesurer si les agents s'améliorent.

---

## Section 4 — Matrice d'alternatives

| Critère | A: Status quo | B: Brancher fetchSignals sur Supabase + overlays LLM | C: Persistence Supabase + métriques d'efficacité | D: Pipeline complet (B+C + feedback-on-overlay) |
|---------|:------------:|:---------------------------------------------------:|:------------------------------------------------:|:------------------------------------------------:|
| **Complexité** (obligatoire) | S (rien à faire) | M (2-3 fichiers, ~150 LOC nouveaux) | M-L (migration schema + nouveau module ~200 LOC) | L (3-4 semaines, tout pipeline) |
| **Valeur ajoutée** (obligatoire) | None | High (boucle fonctionnelle en prod) | Med (durabilité + observabilité) | High (système complet auto-apprenant) |
| **Risque technique** (obligatoire) | High (feature activée mais vide = illusion de sécurité) | Low-Med (Supabase query + Haiku call) | Med (migration schema, backward compat) | High (complexité, couplage) |
| *Impact maintenance* | Négatif (feature flag ON mais dead code) | Positif (logique centralisée) | Positif (source of truth) | Neutre (complexité croissante) |
| *Réversibilité* | N/A | Facile (feature flag) | Moyenne (migration schema) | Difficile |

**Discussion des options :**

**A — Status quo** : La feature est marquée active dans `features.json` mais `fetchSignals` retourne toujours `[]`. C'est une dette technique active : les overlays ne sont jamais créés automatiquement, mais le code donne l'illusion d'une boucle fonctionnelle. Risque élevé de fausse confiance.

**B — Brancher fetchSignals sur Supabase + overlays LLM-générés** : C'est l'option à fort retour immédiat. Il s'agit de (1) implémenter `fetchSignals` pour lire les entrées récentes dans `agent_events` ou `logs`, (2) remplacer les templates statiques par un appel Haiku pour générer un overlay contextuellement pertinent à partir du champ `details` du signal. Complexité M, risque faible, résout le gap critique. La table `agent_events` est déjà indexée par `agent_role` ce qui facilite la requête. Cette option peut être activée en 2-3 sprints avec couverture de tests complète.

**C — Persistance Supabase + métriques d'efficacité** : Complémentaire à B. Les overlays actuellement dans JSON local seraient persistés dans `feedback_rules` (après migration du champ `source` pour accepter `'sdd_auto'`). On ajoute un compteur de succès : après N pipelines post-overlay, si le taux d'échec diminue, l'overlay est "graduré" (stabilisé) ; sinon il est expiré. Cela nécessite une migration schema et un nouveau module `overlay-metrics.ts` (~200 LOC). Risque moyen, bénéfice observabilité.

**D — Pipeline complet** : Combine B+C avec une boucle de feedback-on-overlay (un LLM évalue si l'overlay a été efficace et le révise si besoin). Trop complexe pour un premier sprint, mais décrit l'état cible à long terme. DROP pour ce sprint.

**Option recommandée : B (focus sur le gap critique)**

L'option B résout immédiatement le problème fondamental (boucle fonctionnellement vide) avec un effort raisonnable. C peut être planifié comme suite naturelle.

---

## Section 5 — Verdict et justification

**Verdict : GO**

**Option recommandée : B — Brancher fetchSignals sur Supabase + overlays LLM-générés**

Justification en 5 points :

1. **Gap critique démontré** (axe 2) : `fetchSignals: async () => []` dans `getDeps()` garantit que zéro overlay n'est jamais créé automatiquement en production, malgré la feature activée. Ce n'est pas un bug latent — c'est un dead code actif qui crée une fausse confiance.

2. **Infrastructure existante exploitable** (axe 2) : la table `agent_events` est indexée par `agent_role`, les résultats SDD sont déjà parsés via regex dans `job-manager.ts` et `sdd-auto-advance.ts`. L'implémentation de `fetchSignals` peut réutiliser ces deux actifs sans nouveau schema.

3. **Overlays contextuels validés par l'état de l'art** (axe 1) : MemPrompt (Medium) et les recommandations Adaline convergent sur la nécessité de feedback dynamique ancré sur les vrais motifs d'erreur. Les templates statiques actuels sont insuffisants pour tout cas d'erreur non anticipé.

4. **Risque faible** (axe 3) : l'option B est gated par le feature flag existant `prompt_feedback_loop`, réversible immédiatement. Les modifications se limitent à `feedback-analyzer.ts` (remplacement du `getDeps()` défaut) et à un nouveau helper Haiku pour les overlays LLM. Aucune migration schema requise pour le minimum viable.

5. **Heartbeat stoppé = contrainte de déploiement à résoudre** : le heartbeat PM2 doit être redémarré pour que la boucle s'exécute. C'est un prérequis opérationnel documenté dans la section 6.

---

## Section 6 — Input pour étape suivante

**Option recommandée :** B — Brancher fetchSignals sur Supabase + overlays LLM-générés

**Fichiers concernés :**
- `src/feedback-analyzer.ts` — Modifier `getDeps()` pour implémenter `fetchSignals` réelle (Supabase query sur `agent_events` ou lecture des logs récents)
- `src/feedback-analyzer.ts` — Modifier `generateOverlayText` pour accepter un mode `llm` (appel Haiku avec le `details` du signal) en plus du mode template existant
- `src/heartbeat.ts` — Vérifier que le heartbeat PM2 est redémarré (prérequis opérationnel)
- `config/features.json` — Potentiellement ajouter `sdd_feedback_llm_overlay` pour gater le mode LLM séparément

**Contraintes identifiées :**
- La table `agent_events` ne stocke pas actuellement les verdicts SDD — il faut soit y écrire les événements depuis `sdd-agents.ts` à chaque phase complétée, soit utiliser les `logs` Supabase filtrés par messages contenant `SDD_*_NO-GO` / `SDD_*_FAILED`
- La table `feedback_rules` existante a `source CHECK ('retro', 'double_loop')` — incompatible directement ; préférer rester sur le JSON local pour les overlays et ne migrer vers Supabase qu'en option C
- Le heartbeat est actuellement stoppé (`PM2 services actifs : relay, dashboard (heartbeat stoppe)`) — à redémarrer ou déclencher la boucle autrement (via commande `/feature` manuelle ou cron dédié)
- Coût Haiku : chaque génération d'overlay via LLM coûte ~$0.001 (quelques centimes par mois au rythme actuel)

**Questions ouvertes pour la spec :**
- Q1 : Faut-il stocker les signaux dans `agent_events` (au moment de l'exécution des phases SDD) ou lire les logs/résultats de jobs a posteriori ? La première approche est plus précise mais plus invasive.
- Q2 : Quel est le seuil de déclenchement optimal pour les overlays LLM ? Conserver `RECURRENCE_THRESHOLD = 3` ou le rendre configurable ?
- Q3 : Doit-on relancer le heartbeat PM2 dans le scope de ce sprint ou implémenter un mécanisme alternatif de déclenchement de la boucle (ex : via job-manager après chaque phase SDD complétée) ?
- Q4 : Comment mesurer l'efficacité d'un overlay ? Critère minimal : le taux d'échec pour `agentRole`+`source` diminue après activation.

**Bloc Input pour spec :**
```
Sujet: Brancher fetchSignals sur Supabase et remplacer les overlays statiques par des overlays LLM-générés (Haiku) contextuels à partir des verdicts SDD réels.

Fichiers cibles: src/feedback-analyzer.ts, src/sdd-agents.ts (émission d'événements), src/heartbeat.ts
Schema Supabase: table agent_events (existante), lecture logs ou écriture événements à chaque phase SDD

Contraintes:
- Rester compatible avec les tests existants (V1-V8 via _setDependencies)
- Feature gating: prompt_feedback_loop existant + nouveau flag sdd_feedback_llm_overlay optionnel
- Heartbeat redémarré ou boucle déclenchée autrement
- Pas de migration feedback_rules dans ce sprint

Références:
- Exploration: docs/explorations/EXPLORE-amelioration-boucle-de-retroaction-automatique.md
- Modules: src/feedback-analyzer.ts, src/prompt-overlay.ts, src/sdd-agents.ts, src/heartbeat.ts
```
