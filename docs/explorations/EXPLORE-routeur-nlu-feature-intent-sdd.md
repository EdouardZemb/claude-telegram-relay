---
phase: 0-explore
generated_at: "2026-03-25T14:30:00Z"
subject: "Routeur NLU — detection automatique d'intent feature-request pour declenchement pipeline SDD"
verdict: GO
next_step: "dev-spec"
---

# Exploration — Routeur NLU : intent feature-request vers pipeline SDD

## Section 1 — Probleme

Quand un utilisateur envoie un message en langage naturel decrivant une feature ou un changement ("ajoute un dark mode", "il faudrait pouvoir exporter en CSV", "ce serait bien d'avoir des notifications push"), le bot ne detecte pas cette intention comme une demande de feature. Selon le texte :

1. Si le message contient "il faudrait ajouter/creer/faire", le regex `create_task` le capture et le route vers `/task` — creant une tache basique au lieu de lancer une exploration structuree.
2. Si le message est plus vague ("ce serait bien d'avoir X", "on pourrait ajouter Y"), aucun intent n'est detecte et le message tombe dans le fallback conversationnel — Claude repond en conversation sans rien declencher.
3. Jamais le pipeline SDD (`/explore`) n'est declenche automatiquement pour des feature requests.

Le gap est clair : entre les 16 intents regex existants et le LLM fallback, aucun ne couvre la classe semantique "feature request / proposition de changement" qui devrait declencher `/explore` plutot qu'une commande existante ou une conversation.

L'exploration est necessaire car :
- Le risque de faux positifs est eleve (messages conversationnels vs vrais feature requests)
- Plusieurs options d'implementation existent (regex, LLM prompt, hybride)
- L'interaction avec les intents existants (`create_task`, `explore_topic`) doit etre resolue proprement

## Section 2 — Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [Intent-Driven Natural Language Interface: A Hybrid LLM + Intent Classification Approach](https://medium.com/data-science-collective/intent-driven-natural-language-interface-a-hybrid-llm-intent-classification-approach-e1d96ad6f35d) | Article technique | 2025 | Architecture hybride regex/LLM avec fallback gracieux. Le LLM n'est invoque que quand le regex echoue, reduisant les couts. Recommande un seuil de confidence a 0.7+ avec confirmation utilisateur entre 0.7-0.85. | Haute |
| 2 | [LLM Classifier Confidence Scores](https://aejaspan.github.io/posts/2025-09-01-LLM-Clasifier-Confidence-Scores/) | Benchmark | 2025-09 | Aucun format de prompt n'atteint une calibration acceptable pour les scores de confiance LLM (ECE 0.108-0.427 vs seuil ideal < 0.05). Les erreurs a haute confiance persistent. Recommande de ne pas se fier uniquement au score LLM pour des decisions automatiques. | Haute |
| 3 | [Benchmarking Hybrid LLM Classification Systems](https://www.voiceflow.com/pathways/benchmarking-hybrid-llm-classification-systems) | Benchmark Voiceflow | 2025 | Les systemes hybrides (NLU classique + LLM fallback) surpassent le LLM seul en precision et latence. L'approche deux-tiers reduit les faux positifs de 30-40% par rapport au LLM seul. | Haute |
| 4 | [Enhancing Customer Service Chatbots with Context-Aware NLU](https://arxiv.org/abs/2506.01781) | Paper academique | 2025-06 | L'ajout de contexte sessionnel (historique conversation, etat systeme) ameliore la precision de +4.8% sur les intents ambigus. Walmart production deployment. | Moyenne |
| 5 | [False Positive Intent Detection Framework for Chatbot Annotation](https://dl.acm.org/doi/fullHtml/10.1145/3582768.3582798) | Paper ACM | 2023 | Framework de detection de faux positifs par active learning. Recommande un mecanisme de confirmation explicite pour les intents a faible confiance plutot que l'execution automatique. | Moyenne |

### Synthese

L'etat de l'art converge sur plusieurs points critiques pour notre cas :

**Architecture hybride validee.** Le pattern regex fast-path + LLM fallback que le projet utilise deja (intent-detection.ts) est l'approche recommandee en 2025. L'ajout d'une nouvelle classe d'intent ("feature_request") dans ce framework existant est la voie naturelle.

**Danger des scores de confiance LLM.** Les benchmarks 2025 montrent que les scores de confiance retournes par les LLM sont mal calibres (ECE >> 0.05). Cela signifie qu'un LLM qui retourne confidence=0.85 pour "feature_request" n'est pas necessairement fiable. Implication directe : la detection de feature request ne devrait pas etre entierement automatique mais passer par une confirmation utilisateur.

**Confirmation > Execution automatique.** Tous les papiers et articles recommandent un mecanisme de confirmation pour les classes d'intent nouvelles ou ambigues. Cela correspond exactement a notre contrainte "ne pas sur-declencher". L'InlineKeyboard de confirmation existe deja dans `command-router.ts` pour les actions a risque "high" — on peut reutiliser ce pattern.

**Contexte sessionnel precieux.** L'enrichissement du prompt LLM avec le contexte de conversation recent (deja fait via `recentMessages` dans `detectIntentWithLLM`) est un facteur prouve d'amelioration de la precision.

## Section 3 — Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/intent-detection.ts` (373 LOC) | 16 intents regex + LLM fallback. L'intent `create_task` capture "il faut/faudrait ajouter/creer/faire" — conflit direct avec le langage de feature request. L'intent `explore_topic` capture "explore/investiguer/etudier/rechercher" — semantique differente (exploration technique vs proposition de feature). | Eleve |
| 2 | `src/commands/zz-messages.ts` (694 LOC) | Pipeline message : regex -> LLM -> conversation fallback. Seuil de confiance a 0.8. Le routing via `routeIntent()` dispatch vers la commande cible. Point d'insertion naturel pour un nouveau type d'intent. | Eleve |
| 3 | `src/commands/command-router.ts` (246 LOC) | `routeIntent()` gere la confirmation (InlineKeyboard) pour les actions "high" risk. Pattern reutilisable : on pourrait traiter feature_request comme risk "medium" avec confirmation inline. `buildSyntheticUpdate()` permet de dispatcher `/explore <sujet>`. | Moyen |
| 4 | `src/action-registry.ts` (461 LOC) | 30 actions enregistrees. L'action `explore` est risk "low" et `backgroundEligible: true`. Si feature_request route vers `/explore`, le risk level existant s'applique (pas de confirmation high-risk). | Moyen |
| 5 | `src/commands/exploration.ts` (155 LOC) | Handler `/explore`: cree un pipeline SDD, lance `runSddExplore()` via job-manager. Accepte un texte libre en argument. Parfaitement adapte comme cible du routing. | Moyen |
| 6 | `src/feature-flags.ts` (71 LOC) | Systeme de flags fichier-based (config/features.json). 9 flags existants. Ajouter `nlu_feature_request: false` est trivial. | Faible |
| 7 | `config/features.json` | 9 flags actuels. Le flag `intent_detection` mentionne dans les specs n'est plus utilise comme guard (le code de zz-messages.ts invoque detectIntent() sans verifier de flag). | Faible |
| 8 | `src/sdd-auto-advance.ts` | Precedent pertinent : auto-advancement conditionne par feature flag + circuit breaker de profondeur (max 3). Pattern a considerer pour limiter les auto-declenchements. | Faible |

### Points de friction

1. **Conflit `create_task` vs `feature_request`.** Le regex `(il faut|on doit|faudrait) + (ajouter|creer|faire)` capture exactement le langage de feature request. Le message "il faudrait ajouter un dark mode" sera route vers `/task` avec confidence 0.7+ au lieu de `/explore`. Resolution necessaire : soit restreindre le regex `create_task` (exiger le mot "tache"), soit donner priorite au nouveau intent `feature_request` quand le sujet n'est pas une tache mais une feature.

2. **Discrimination semantique subtile.** "Ajoute une tache pour le dark mode" (task) vs "Ajoute un dark mode" (feature request). La difference est la presence/absence du mot "tache" — le regex actuel ne discrimine pas.

3. **zz-messages.ts a 694 LOC** (proche du seuil 800). L'ajout de logique de feature request doit etre minimal dans ce fichier — idealement, la logique va dans `intent-detection.ts` et `command-router.ts`.

### Actifs reutilisables

1. **Architecture deux-tiers complete** (regex + LLM fallback) dans `intent-detection.ts` — ajouter un 17eme intent regex est trivial.
2. **Pattern confirmation InlineKeyboard** dans `command-router.ts` — reutilisable pour la confirmation "Lancer une exploration SDD ?"
3. **Pipeline `/explore` fonctionnel** — accepte un texte libre, lance le pipeline SDD, cree la tache automatiquement.
4. **Feature flags operationnels** — un nouveau flag `nlu_feature_request` permettrait un rollback instantane.
5. **LLM prompt existant** dans `detectIntentWithLLM()` — enrichissable avec une instruction supplementaire pour detecter les feature requests.

## Section 4 — Matrice d'alternatives

| Critere | A: Status quo | B: Regex-only + confirmation | C: Regex + LLM enrichi + confirmation | D: LLM-only (pas de regex) |
|---------|:------------:|:-----------:|:-----------:|:-----------:|
| **Complexite** (obligatoire) | S | S | M | M |
| **Valeur ajoutee** (obligatoire) | Low | Med | High | Med |
| **Risque technique** (obligatoire) | Low | Med | Low | High |
| *Impact maintenance* | Nul | Faible | Faible | Moyen |
| *Reversibilite* | N/A | Haute (flag) | Haute (flag) | Moyenne |

### Discussion

**Option A — Status quo.** Les feature requests tombent soit dans `/task` (mauvais routing), soit dans la conversation (pas d'action). L'utilisateur doit connaitre et taper `/explore` manuellement. Aucun risque mais aucune valeur ajoutee. Baseline.

**Option B — Regex-only + confirmation.** Ajouter un nouvel intent `feature_request` avec des patterns regex cibles : "il faudrait pouvoir", "ce serait bien de/d'", "on pourrait ajouter", "ajoute un/une [non-tache]", "j'aimerais que", "pourquoi pas ajouter". Restreindre le regex `create_task` pour exiger le mot "tache". Quand l'intent est detecte, afficher un InlineKeyboard de confirmation "Lancer une exploration SDD sur ce sujet ?" avant de dispatcher vers `/explore`. Le feature flag desactive entierement le comportement. Avantage : zero latence supplementaire (regex), implementation simple (~80 LOC). Inconvenient : les regex ne capturent que les formulations prevues — "le bot devrait supporter le multi-langue" ne matcherait pas.

**Option C — Regex + LLM enrichi + confirmation (recommandee).** Meme regex que B pour le fast-path, mais enrichir le prompt LLM existant de `detectIntentWithLLM()` avec une instruction explicite pour detecter les feature requests quand le regex echoue. Le LLM a deja le contexte conversationnel et la liste des commandes — ajouter dans le prompt "Si le message decrit une fonctionnalite ou un changement souhaite qui n'existe pas encore, classifier comme feature_request avec la commande explore". La confirmation inline est obligatoire (jamais d'execution automatique). Le feature flag controle les deux couches. Avantage : couverture large (le LLM capture les formulations non-prevues), faux positifs mitiges par la confirmation. Inconvenient : +15s de latence pour les messages qui passent au LLM (mais c'est deja le cas sans ce changement).

**Option D — LLM-only.** Supprimer le regex fast-path et tout router via le LLM. Plus simple conceptuellement mais : +15s de latence sur chaque message, couts tokens augmentes, dependance forte au LLM, et les benchmarks 2025 montrent que les scores de confiance LLM sont mal calibres (Section 2, source 2). Risque de faux positifs eleve sans la couche regex comme filet de securite.

## Section 5 — Verdict et justification

**Verdict : GO** — avec l'option C (Regex + LLM enrichi + confirmation).

Justification :

1. **Le besoin est reel et documente.** L'archeologie codebase (Section 3) montre un conflit actif : les feature requests sont mal routees vers `/task` ou perdues dans la conversation. Le gap entre l'intent detection existante et le pipeline SDD est clairement identifie.

2. **L'infrastructure est prete.** Les 5 actifs reutilisables identifies (architecture deux-tiers, pattern confirmation, pipeline /explore, feature flags, prompt LLM) permettent une implementation a faible risque. L'option C reutilise 100% de l'existant sans nouvelle dependance.

3. **L'etat de l'art valide l'approche.** Les benchmarks 2025 (sources 1, 3) confirment que les systemes hybrides regex+LLM surpassent le LLM seul en precision (-30-40% de faux positifs). La confirmation utilisateur (source 5) est le mecanisme recommande pour les intents a confiance ambigue — exactement ce que propose l'option C.

4. **Le risque est maitrise.** Le feature flag `nlu_feature_request` permet un rollback instantane. La confirmation inline empeche tout faux positif de declencher un pipeline SDD sans intervention de l'utilisateur. La complexite est M (estimee a ~120 LOC repartis sur 2-3 fichiers).

5. **Le conflit `create_task` est un bug implicite** que cette implementation corrige en bonus : actuellement "il faudrait ajouter un dark mode" cree une tache au lieu d'explorer la feature.

## Section 6 — Input pour etape suivante

### Option recommandee : C — Regex + LLM enrichi + confirmation

### Fichiers concernes

| Fichier | Modification |
|---------|-------------|
| `src/intent-detection.ts` | Ajouter intent `feature_request` (regex patterns + argExtractor). Restreindre regex `create_task` pour exiger le mot "tache". |
| `src/intent-detection.ts` | Enrichir le prompt LLM dans `detectIntentWithLLM()` avec une instruction feature_request. |
| `src/commands/zz-messages.ts` | Ajouter un guard feature flag `nlu_feature_request` autour du traitement de l'intent feature_request. Afficher InlineKeyboard de confirmation au lieu de dispatcher directement. |
| `src/commands/command-router.ts` | Ajouter le handling du callback `intent_feature_request_confirm` / `intent_feature_request_cancel`. |
| `src/action-registry.ts` | Optionnel : ajouter des aliases "feature request" a l'action `explore`. |
| `config/features.json` | Ajouter `"nlu_feature_request": false`. |
| `tests/unit/intent-detection.test.ts` | Tests unitaires : detection feature_request, non-detection conversation casual, priorite sur create_task. |

### Contraintes identifiees

1. **Seuil de confiance.** Le seuil regex a 0.8 dans zz-messages.ts s'applique. Les patterns feature_request doivent avoir assez de specificite pour atteindre 0.7+ sans sur-matcher les messages conversationnels.
2. **Discrimination task vs feature.** Le regex `create_task` doit etre restreint pour exiger "tache" dans le message. Les messages sans "tache" mais avec des formulations de proposition doivent aller vers `feature_request`.
3. **Confirmation obligatoire.** Ne jamais dispatcher `/explore` automatiquement — toujours passer par un InlineKeyboard "Lancer une exploration SDD sur ce sujet ?".
4. **Feature flag off par defaut.** `nlu_feature_request: false` dans features.json, activation via `/feature enable nlu_feature_request`.
5. **zz-messages.ts < 800 LOC.** La logique de confirmation doit rester dans command-router.ts, pas dans zz-messages.ts.

### Patterns regex suggerees (a valider pendant la spec)

```
/\b(il\s+faudrait\s+pouvoir|ce\s+serait\s+bien\s+(de|d')|on\s+pourrait\s+ajouter|j'aimerais\s+(que|pouvoir))\b/i
/\b(ajoute|ajouter)\s+(un|une|des|le|la|du)\s+(?!tache|task)\w+/i   // "ajoute un X" sauf "ajoute une tache"
/\b(pourquoi\s+pas|et\s+si\s+on)\s+(ajouter|ajoutait|faisait|implementait)\b/i
/\b(le\s+bot\s+devrait|il\s+manque|ca\s+manque)\b/i
/\b(nouvelle\s+fonctionnalite|new\s+feature|feature\s+request)\b/i
```

### Questions ouvertes a resoudre pendant la spec

1. **Formulation du message de confirmation.** Quel texte exact pour l'InlineKeyboard ? Proposition : "Ca ressemble a une demande de feature. Lancer une exploration SDD ?" avec boutons [Explorer] [Non merci].
2. **Cooldown anti-spam.** Faut-il un cooldown par chat (ex: max 1 suggestion feature_request par heure) pour eviter de proposer l'exploration a chaque message vaguement suggestif ?
3. **Interaction avec le pipeline SDD actif.** Si un pipeline SDD est deja en cours dans le thread, faut-il quand meme proposer l'exploration ou ignorer silencieusement ?
4. **Metriques de suivi.** Logger les detections feature_request (acceptees/refusees) pour mesurer le taux de faux positifs en production et ajuster les seuils.
