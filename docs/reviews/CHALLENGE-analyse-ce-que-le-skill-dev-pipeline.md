# Challenge adversarial — SPEC-analyse-ce-que-le-skill-dev-pipeline

> Date : 2026-03-21. Spec v2 analysee par 3 agents adversariaux.

## Synthese

| Severite | Count |
|----------|-------|
| BLOQUANT | 3 |
| MAJEUR   | 5 |
| MINEUR   | 4 |

**Verdict : PAUSE** — 3 findings bloquants a resoudre avant implementation.

---

## Agent 1 : Devil's Advocate (failles logiques)

### F-DA-1 [BLOQUANT] — Pas de mecanisme de reprise apres pause P2

R7 dit : "si P2 trouve un bloquant, le pipeline se met en pause et notifie l'utilisateur." Mais la spec ne definit aucun mecanisme pour REPRENDRE le pipeline apres la pause. Le PRD workflow a des boutons inline pour la reprise — P2 n'a rien. Le pipeline reste bloque indefiniment.

**Impact** : Le challenge adversarial est inutilisable en pratique — une pause sans reprise = un pipeline mort.

**Correction suggeree** : Ajouter des boutons inline "Continuer" / "Abandonner" au message de pause P2 (pattern identique a E2), avec un callback `challenge_resume:` et `challenge_abort:`. Documenter le flow de reprise dans R7.

### F-DA-2 [BLOQUANT] — Point d'insertion P2 indefini sur pipeline LIGHT

R5 dit "P2 s'insere entre le dernier agent pre-dev (architect ou planner)." Section 5 precise "apres la gate evaluation d'architect (ligne ~986)." Mais sur LIGHT (planner -> dev -> qa), le `planner` n'est PAS dans le `gateMap` de l'orchestrateur (lignes 981-985 : seuls `pm`, `architect`, `dev` ont des gates). Le point d'insertion de P2 apres la "gate du planner" n'existe pas dans le code.

**Impact** : P2 ne peut pas fonctionner sur LIGHT pipeline sans modification du gateMap ou logique d'insertion alternative.

**Correction suggeree** : Definir explicitement le point d'insertion P2 pour LIGHT : soit ajouter `planner` au `gateMap`, soit inserer P2 par detection de l'agent "dev" dans le pipeline (inserer juste avant, independamment des gates). La deuxieme option est plus robuste.

### F-DA-3 [MAJEUR] — Echec silencieux de P2 masque par le fail-safe

V4 dit "runAdversarialChallenge retourne verdict PASS avec 0 findings si spawnClaude echoue." Combine avec la zone d'ombre #3 (parsing regex du texte agent), deux scenarios d'echec silencieux existent : (1) l'agent ne demarre pas, (2) l'agent repond dans un format inattendu. Dans les deux cas, verdict "PASS" — le challenge est invisible et inutile.

**Impact** : Le pipeline continue comme si le challenge avait valide l'implementation, alors qu'il n'a meme pas tourne. L'utilisateur n'est pas informe.

**Correction suggeree** : Distinguer PASS (challenge reussi, 0 bloquant) de SKIPPED (echec agent). Notifier l'utilisateur en cas de SKIPPED via onProgress("Challenge adversarial : echec agent, analyse non disponible").

### F-DA-4 [MINEUR] — Champ `fr_id` semantiquement incorrect pour V-criteres

P3 reutilise `DriftReport` tel quel, mais le type `DriftItem` a un champ `fr_id` (ligne 20 de adversarial-verifier.ts). Utiliser `fr_id` pour des identifiants `[V1]`, `[V2]` est trompeur. Ca fonctionne techniquement mais introduit une dette semantique.

**Correction suggeree** : Renommer le champ en `criterion_id` ou accepter la dette et documenter que `fr_id` peut contenir des V-criteria IDs.

---

## Agent 2 : Edge Case Hunter (cas limites)

### F-EC-1 [BLOQUANT] — E2 perd son timer si le bot redemarre

R20 dit "timeout de 10 minutes gere cote bot." Le timer est en memoire (setTimeout ou equivalent). Si le bot PM2 redemarre pendant les 10 minutes d'attente E2, le timer est perdu. Le pipeline attend indefiniment un callback qui ne viendra jamais — pas de persistence de l'etat E2.

**Impact** : Un restart PM2 (frequents en production, cf. memory vigilance_post_s30) pendant l'attente E2 bloque le pipeline sans recours.

**Correction suggeree** : Persister l'etat E2 (timestamp de debut, session ID) dans Supabase ou dans le pipeline-state existant. Au restart, verifier les E2 en attente et appliquer le timeout si expire.

### F-EC-2 [MAJEUR] — Pipelines concurrents avec E2 et confusion de callbacks

Si `maxConcurrency > 1` dans auto-pipeline, deux pipelines DEFAULT concurrents peuvent atteindre E2 simultanement. L'utilisateur recoit deux messages avec boutons "GO" / "SKIP". Les callbacks `specgate_go:` et `specgate_skip:` doivent inclure un identifiant unique (session ID) pour eviter qu'un clic sur le mauvais bouton reprenne le mauvais pipeline.

**Correction suggeree** : Inclure le bbSessionId dans le callback data (`specgate_go:{sessionId}`) et valider dans le handler que le callback correspond au bon pipeline.

### F-EC-3 [MAJEUR] — Interaction P1/exploration phase non definie

P1 s'execute avant la boucle d'agents. Mais l'exploration phase (Pattern 4, lignes 499-514) peut dynamiquement changer le pipeline (ex: DEFAULT -> RESEARCH). Si l'exploration se declenche APRES P1 et switch le pipeline, la proto-spec a ete generee pour le mauvais contexte. La spec ne definit pas l'ordre P1 vs exploration.

**Correction suggeree** : Definir explicitement l'ordre : exploration PUIS P1 (la proto-spec utilise le pipeline final). Ou invalider la proto-spec si le pipeline change apres P1.

### F-EC-4 [MAJEUR] — --skip-challenge et E1 : ambiguite

R14 dit `--skip-challenge` bypasse P2. R8 dit P2 et E1 partagent le flag `adversarial_challenge`. Mais `--skip-challenge` est un flag de commande, pas le feature flag. La spec ne precise pas si `--skip-challenge` saute aussi E1. Si E1 tourne sans P2, le `Promise.all` (R15) ne s'applique plus, et E1 tourne seul — ce qui change le flow.

**Correction suggeree** : Preciser dans R14 que `--skip-challenge` saute P2 ET E1 ensemble (coherent avec le flag partage).

### F-EC-5 [MINEUR] — Resume pipeline (S33) et interaction avec P1/P2/E1/P3

Le pipeline peut reprendre depuis un checkpoint (pipeline-state.ts). Si un crash arrive apres P1 mais avant dev, P1 re-execute-t-il au resume ? La proto-spec est dans le blackboard, donc theoriquement non. Mais la spec ne definit pas ce comportement. Idem pour P2/E1 : si le crash arrive pendant P2, le challenge est-il re-execute ?

**Correction suggeree** : Ajouter une regle definissant le comportement de resume : "au resume, P1 est saute si proto_spec existe dans le blackboard. P2+E1 sont re-executes. P3 est saute si conformance existe."

---

## Agent 3 : Simplicity Skeptic (sur-ingenierie)

### F-SS-1 [MAJEUR] — E2 (quality gate utilisateur) = complexite disproportionnee

E2 necessite : un feature flag, des boutons inline, un callback handler, un timer 10 min, une logique de timeout, le flag `--no-confirm`, et l'interaction avec P1. La zone d'ombre #4 admet deja le risque de "fatigue de confirmation." Si l'utilisateur clique GO 95% du temps, tout ce mecanisme est du bruit.

**Suggestion** : Reporter E2 a une V2. Commencer avec P1+P2+E1+P3 seuls. Ajouter E2 uniquement si les retours en production montrent un besoin de validation intermediaire. Cela retire 1 flag, ~4 V-criteres, et une partie significative de la complexite callback.

### F-SS-2 [MINEUR] — Trois flags independants = 8 combinaisons, plusieurs non-sens

Trois flags (`spec_phase_lite`, `adversarial_challenge`, `spec_gate`) creent 8 etats. Plusieurs sont inoperants : `spec_gate` sans `spec_phase_lite` (R22 = inoperant), `spec_phase_lite` seul sans `adversarial_challenge` (P1 produit une spec que personne ne challenge). La matrice de combinaisons est sous-testee.

**Suggestion** : Reduire a 2 flags : `spec_phase` (controle P1+P3+E2) et `adversarial_challenge` (controle P2+E1). Cela elimine les etats non-sens et simplifie la configuration.

### F-SS-3 [MINEUR] — Chevauchement proto-spec / story files

Le story file (via `buildStoryFile`) contient deja : `acceptanceCriteria`, `implementationSteps`, `impactedFiles`, `testStubs`. La proto-spec ajoute : `objective`, `v_criteria`, `impacted_files`. Il y a recouvrement sur `impactedFiles` et les criteres d'acceptation sont proches des V-criteres. Deux structures paralleles pour des donnees similaires stockees dans des endroits differents (memoire vs blackboard).

**Suggestion** : Evaluer si les V-criteres pourraient etre un enrichissement du story file existant plutot qu'une structure separee. Si la separation est justifiee (scope/lifecycle different), le documenter explicitement.

---

## Matrice de resolution recommandee

| Finding | Severite | Action recommandee | Effort |
|---------|----------|-------------------|--------|
| F-DA-1 | BLOQUANT | Ajouter boutons inline + callback de reprise P2 | Moyen |
| F-DA-2 | BLOQUANT | Insertion P2 par detection pre-dev, pas par gateMap | Faible |
| F-EC-1 | BLOQUANT | Persister etat E2 ou reporter E2 a V2 | Moyen/nul si reporte |
| F-DA-3 | MAJEUR | Distinguer PASS/SKIPPED + notification echec | Faible |
| F-EC-2 | MAJEUR | SessionId dans callback data E2 | Faible |
| F-EC-3 | MAJEUR | Definir ordre exploration vs P1 | Faible (spec) |
| F-EC-4 | MAJEUR | --skip-challenge saute P2+E1 ensemble | Faible (spec) |
| F-SS-1 | MAJEUR | Reporter E2 a V2 (resout aussi F-EC-1, F-EC-2) | Nul (retrait) |
| F-EC-5 | MINEUR | Documenter comportement resume pour P1/P2/P3 | Faible (spec) |
| F-DA-4 | MINEUR | Renommer fr_id ou documenter | Faible |
| F-SS-2 | MINEUR | Reduire a 2 flags | Faible |
| F-SS-3 | MINEUR | Documenter separation proto-spec vs story file | Faible (spec) |

**Note** : Reporter E2 a V2 (F-SS-1) resoudrait F-EC-1, F-EC-2 et eliminerait le flag `spec_gate` (F-SS-2), retirant 6 V-criteres et une part significative de la complexite. C'est la recommandation la plus impactante.
