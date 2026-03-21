# Adversarial Review — SPEC-pipeline-multiagent-upgrades

> Date : 2026-03-20
> Source : docs/specs/SPEC-pipeline-multiagent-upgrades.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic

---

## Synthese

| Severite | Devil's Advocate | Edge Case Hunter | Simplicity Skeptic | Total |
|----------|-----------------|------------------|-------------------|-------|
| BLOQUANT | 1 | 1 | 0 | 2 |
| MAJEUR   | 3 | 3 | 3 | 9 |
| MINEUR   | 2 | 2 | 2 | 6 |
| **Total** | **6** | **6** | **5** | **17** |

**Verdict : GO WITH CHANGES**

Justification : 2 BLOQUANTS resolvables (corrigeables en modifiant la spec sans remettre en cause l'architecture) + 9 MAJEURS. Les bloquants concernent (1) l'incoherence entre `selectAdaptivePipeline` et `scoreToPipeline` qui cree une double logique contradictoire pour le seuil P4, et (2) le risque de resultats incoherents en mode overlap P1 quand QA est lance sans le resultat dev. Les deux sont corrigeables par des ajustements de spec.

---

## Devil's Advocate -- Rapport

### Findings

**[BLOQUANT] F-DA-1 -- Double logique contradictoire pour le seuil P4 entre scoreToPipeline et selectAdaptivePipeline**
- Source : Section 4, P4 / Regles R9-R11 / fichiers llm-router.ts et pipeline-selection.ts
- Description : La spec propose de changer le seuil dans `scoreToPipeline()` (0.6 -> 0.7) ET d'ajouter des override dans `selectAdaptivePipeline()`. Or `selectAdaptivePipeline()` utilise `difficulty.pipeline` qui est le retour de `scoreToPipeline()`. Si on change le seuil dans `scoreToPipeline`, les overrides dans `selectAdaptivePipeline` deviennent partiellement redondants : une tache avec difficulty=0.65 et 6 modules impactes sera deja routee en LIGHT par le nouveau seuil, et l'override `affectedModules > 5` la remonterait en DEFAULT. La spec ne clarifie pas l'ordre de priorite : le override dans `selectAdaptivePipeline` s'applique-t-il APRES le switch sur `difficulty.pipeline` (auquel cas c'est coherent) ou AVANT (auquel cas c'est un conflit) ?
- Impact : Implementation ambigue, risque d'implementer la logique dans le mauvais ordre. Le resultat sera correct si l'override est post-switch, mais la spec doit etre explicite.
- Evidence : pipeline-selection.ts:142-149 montre `switch (difficulty.pipeline)` suivi d'un return immediat -- les overrides n'ont pas de point d'insertion naturel dans le code actuel.

**[MAJEUR] F-DA-2 -- Hypothese non verifiee : QA fait une review independante de la spec, pas du code dev**
- Source : Section 9, zone d'ombre 1 / Regle R1
- Description : La spec justifie le mode overlap (dev et qa en parallele) en affirmant que "qa fait une review independante basee sur la spec (pas sur l'output dev)". Or dans le codebase, QA recoit les `previousMessages` qui incluent les outputs de tous les agents precedents et les utilise pour evaluer la conformite. En mode overlap, QA ne verra pas le resultat dev, ce qui n'est pas juste "acceptable" mais un changement fondamental du comportement QA.
- Impact : QA en mode overlap produira une evaluation basee uniquement sur les specs (analyst/pm/architect), sans pouvoir verifier l'implementation dev. C'est une review de spec, pas une review de code.

**[MAJEUR] F-DA-3 -- Decision arbitraire : seuil de 5 modules pour forcer DEFAULT**
- Source : Regle R10 / Section 9, zone d'ombre 3
- Description : Le seuil de 5 modules est reconnu comme arbitraire dans les zones d'ombre mais presente comme une regle ferme dans R10. Aucune analyse de la distribution reelle de `affectedModules.length` n'a ete faite. La spec elle-meme note que "le seuil recommande par l'exploration est arbitraire".
- Impact : Risque de faux positifs (tache touchant 6 modules mais chacun trivialement) ou de faux negatifs (tache touchant 4 modules critiques avec forte interdependance).

**[MAJEUR] F-DA-4 -- Incoherence entre R6 et l'implementation proposee dans buildAgentContext**
- Source : Regle R6 / Section 4, P2
- Description : R6 dit "au plus 1 requete Supabase batch par phase (sections volatiles uniquement)". Or `buildAgentContext` fait deja 8 fetches paralleles. La nouvelle `refreshVolatileContext()` devrait ne faire que 2 (sprint + memoire), mais `fetchSprintContext` peut elle-meme faire 2 requetes (auto-detect sprint + get_sprint_summary). La spec ne precise pas si `refreshVolatileContext` reutilise le sprintId deja connu (1 requete) ou re-detecte le sprint courant (potentiellement 2).
- Impact : Performance potentiellement pire qu'annoncee si le sprintId n'est pas passe en parametre au refresh.

**[MINEUR] F-DA-5 -- Omission : pas de V-critere pour le mode overlap avec resume (S33)**
- Source : Section 8 / V22-V25
- Description : Les V-criteres pour P1 (overlap) ne couvrent pas le cas ou le pipeline est resume (`resumeSessionId`). Que se passe-t-il si le pipeline est resume a l'avant-dernier agent avec `overlap: true` ? Un seul agent reste, pas de parallelisme.
- Impact : Cas marginal mais non teste.

**[MINEUR] F-DA-6 -- Inconsistance dans la terminologie "phases" vs "agents"**
- Source : Section 1, sections 4.2 et 4.4
- Description : La spec parle tantot de "parallelisme intra-phase" (titre P1), tantot de "2 derniers agents" (description). Les termes "phase" et "agent" sont utilises de maniere interchangeable alors qu'un pipeline peut avoir plusieurs agents par phase (ex: deliberation protocol). Le refresh est dit "entre chaque agent" dans la spec mais le titre dit "mid-pipeline".
- Impact : Ambiguite mineure mais source potentielle de confusion lors de l'implementation.

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter -- Rapport

### Findings

**[BLOQUANT] F-EC-1 -- Overlap + stopOnFailure : crash silencieux si un des 2 agents paralleles echoue**
- Scenario : Pipeline [analyst, dev, qa] avec `overlap: true` et `stopOnFailure: true`. Dev et qa sont lances en parallele via `Promise.all()`. Dev echoue, qa reussit. Que se passe-t-il ?
- Source : Section 4, P1 / Pattern 3 / Regle R1
- Impact : `Promise.all()` rejette des que la premiere promesse rejette (si les erreurs ne sont pas catchees en amont). Mais `runAgentStep` ne throw pas (retourne `{ success: false }`). Le vrai probleme est que `stopOnFailure` est gere dans la boucle sequentielle apres chaque agent. Avec `Promise.all`, les deux agents completent, puis il faudrait verifier les deux resultats. La spec ne precise pas comment gerer les echecs en mode overlap.
- Frequence estimee : Occasionnel (agents echouent environ 5-10% du temps)

**[MAJEUR] F-EC-2 -- Overlap + inter-agent messages (blackboard) : desynchronisation**
- Scenario : Pipeline avec `useBlackboard: true` et `overlap: true`. Apres chaque agent, le code verifie les conflits working memory et les clarifications (lignes 750-802). En mode overlap, ces verifications post-agent ne peuvent pas se faire pour les 2 agents en parallele sans condition de course sur le blackboard.
- Source : Section 4, P1 / orchestrator.ts:750-802
- Impact : Ecriture concurrente sur le blackboard (bbVersion), conflits detectes partiellement, clarifications manquees.
- Frequence estimee : Rare (overlap + blackboard ensemble)

**[MAJEUR] F-EC-3 -- Context refresh avec supabase null**
- Scenario : `refreshContext: true` mais supabase est null. La spec (V14) dit que `refreshVolatileContext()` retourne "" quand supabase est null, coherent avec `buildAgentContext`. Mais dans ce cas, le cache sera mis a jour avec une string vide, ecrasant le contexte initial.
- Source : Section 4, P2 / V14 / Regle R4
- Impact : Perte de contexte pour les agents mid-pipeline quand supabase est temporairement indisponible. Le contexte initial (construit quand supabase etait disponible) sera remplace par "".
- Frequence estimee : Rare (supabase downtime mid-pipeline)

**[MAJEUR] F-EC-4 -- DLQ prompt_hash : collision SHA-256 pratiquement nulle mais prompt_hash inutile sans le prompt complet**
- Scenario : L'operateur veut faire un replay apres echec. Il recupere l'event `failure_captured` avec `prompt_hash`. Le hash identifie le prompt mais ne permet pas de le reconstruire. Les inputs ayant change depuis (sprint, memoire), la reconstruction est non-deterministe.
- Source : Section 4, P3 / Section 9, zone d'ombre 5
- Impact : La DLQ documente l'echec mais ne permet pas le replay. La valeur du `prompt_hash` est limitee a la deduplication, pas au debug.
- Frequence estimee : Occasionnel (chaque echec DLQ aura ce probleme)

**[MINEUR] F-EC-5 -- Breaking changes keywords : faux positifs sur "migration"**
- Scenario : Tache "migration donnees utilisateur vers nouveau format JSON" -- contient "migration" mais pas "migration schema". Pourtant la spec inclut "migration schema" comme mot-cle compose. Par contre le mot "supprime" (dans la liste) matchera "supprimer les logs obsoletes" qui n'est pas un breaking change.
- Source : Section 4, P4 / Regle R11
- Impact : Faux positifs sur des taches non-breaking, forçage inutile en DEFAULT.
- Frequence estimee : Occasionnel

**[MINEUR] F-EC-6 -- getTracingTimeline deduplication fragile**
- Scenario : La spec dit que `getTracingTimeline()` est "essentiellement un wrapper autour de `getAgentEvents()`". Or `getAgentEvents()` dedup les events in-memory par l'absence de `id` (ligne 137). Si un event in-memory recoit un id par un autre mecanisme, il sera duplique dans le merge.
- Source : Section 4, P5 / agent-events.ts:137
- Impact : Duplications theoriques dans la timeline.
- Frequence estimee : Rare

### Statistiques
- Bloquants : 1
- Majeurs : 3
- Mineurs : 2

---

## Simplicity Skeptic -- Rapport

### Findings

**[MAJEUR] F-SS-1 -- getTracingTimeline est une duplication de getAgentEvents sans valeur ajoutee**
- Source : Section 4, P5 / Regle R13
- Description : La spec propose `getTracingTimeline(supabase, sessionId)` qui "retourne tous les events pour un session_id donne, DB + in-memory, ordonnees par created_at". C'est exactement ce que fait deja `getAgentEvents(supabase, sessionId)` sans le parametre `role` (agent-events.ts:92-141). La spec reconnait elle-meme que c'est "essentiellement un wrapper autour de `getAgentEvents()`".
- Alternative : Utiliser directement `getAgentEvents(supabase, sessionId)` qui fait deja le merge et le tri. Si un alias est souhaite, un simple `export const getTracingTimeline = getAgentEvents` suffit.
- Codebase : agent-events.ts:92-141

**[MAJEUR] F-SS-2 -- refreshVolatileContext : abstraction prematuree pour un solo developer**
- Source : Section 4, P2 / Regle R4-R6
- Description : La separation stable/volatile du contexte avec une fonction dediee `refreshVolatileContext()` ajoute de la complexite architecturale (nouveau concept, nouvelle interface, 2 V-criteres de plus). Or le benefice reel est discutable : un pipeline dure typiquement 2-5 minutes, pendant lesquelles le sprint progress change de quelques pour-cent. Pour un solo developer (mentionne dans la zone d'ombre 4), le contexte ne change presque jamais mid-pipeline.
- Alternative : Rappeler `buildAgentContext()` complet pour les roles restants (deja fait dans le cas explorer, lignes 874-881 de orchestrator.ts). Le cout est ~8 requetes paralleles au lieu de ~2, mais la simplicite est meilleure.
- Codebase : orchestrator.ts:874-881 montre deja un re-build complet du contexte pour les agents downstream post-explorer.

**[MAJEUR] F-SS-3 -- 5 ameliorations dans une seule spec : scope creep et risque d'implementation monolithique**
- Source : Section 1 (objectif)
- Description : La spec regroupe 5 ameliorations (P1-P5) de natures differentes (parallelisme, caching, error handling, seuils, observabilite) dans une seule spec. Chaque amelioration pourrait etre une spec independante avec ses propres tests et sa propre review. Le couplage entre elles est minimal : seule P5 (correlation_id) depend legerement de P3 (DLQ uses the same session_id).
- Alternative : Decouvrir en 5 specs atomiques, implementables et deployables independamment. Cela permet un review plus cible et un rollback granulaire.

**[MINEUR] F-SS-4 -- Breaking changes keywords : liste hardcodee vs pattern existant**
- Source : Section 4, P4 / Regle R11
- Description : Les keyword arrays (BUG_KEYWORDS, REVIEW_KEYWORDS, DOC_KEYWORDS, RESEARCH_KEYWORDS) sont un pattern existant dans pipeline-selection.ts. Ajouter une nouvelle liste BREAKING_KEYWORDS suit le pattern, mais la spec propose 8 mots-cles dont certains en francais et d'autres en anglais ("supprime", "retire" vs "breaking", "deprecate"). La coherence linguistique n'est pas respectee par rapport aux listes existantes (qui sont majoritairement en anglais avec quelques mots francais).
- Codebase : pipeline-selection.ts:40-62 -- les listes existantes melangent deja les langues, mais de maniere plus equilibree.

**[MINEUR] F-SS-5 -- prompt_hash SHA-256 : complexite sans utilite demontree**
- Source : Section 4, P3 / Regle R7
- Description : Le `prompt_hash` (SHA-256 du prompt tronque) dans le payload DLQ ajoute une dependance a une lib crypto pour une valeur de deduplication theorique. En pratique, le `session_id` + `agent_role` identifient deja de maniere unique un echec dans un pipeline. Aucun use case de deduplication par hash n'est mentionne dans la spec.
- Alternative : Stocker simplement les 500 premiers caracteres du prompt au lieu d'un hash, ou ne rien stocker (le contexte est reconstituable depuis les inputs).

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 2

---

## Points forts identifies

1. **Backward compatibility exemplaire** : toutes les modifications sont opt-in via parametres optionnels avec valeurs par defaut preservant le comportement actuel. C'est un modele a suivre.
2. **Patterns existants bien documentes** : les 7 patterns avec citations exactes du code (lignes, extraits) facilitent grandement l'implementation et reduisent les risques d'integration.
3. **V-criteres exhaustifs** : 25 criteres de validation couvrant tous les comportements attendus, y compris les frontieres et les cas degrades (supabase null, pipeline 1 agent).
4. **Zones d'ombre transparentes** : 5 zones d'ombre explicitement documentees avec justification de l'approche choisie. L'auteur reconnait les limites.
5. **Pas de migration SQL** : la spec exploite les structures JSONB existantes et les types TEXT sans CHECK constraint, evitant toute migration schema.

---

## Recommandations pour passer a GO

### Bloquants a resoudre

1. **F-DA-1 (seuil P4)** : Clarifier dans la spec que les overrides `affectedModules > 5` et `breaking changes` s'appliquent APRES le switch `difficulty.pipeline` dans `selectAdaptivePipeline`, en remontant le resultat de LIGHT/SOLO vers DEFAULT. Modifier le code du switch pour stocker le pipeline intermediaire, puis appliquer les overrides. Concretement :
   ```
   let selectedPipeline = difficulty.pipeline;
   if (difficulty.affectedModules.length > 5 && selectedPipeline !== "DEFAULT") selectedPipeline = "DEFAULT";
   if (hasBreakingKeywords(text) && selectedPipeline !== "DEFAULT") selectedPipeline = "DEFAULT";
   ```

2. **F-EC-1 (overlap + stopOnFailure)** : Ajouter une regle dans la spec : "En mode overlap, si un agent echoue et `stopOnFailure: true`, le pipeline echoue mais les deux resultats sont conserves. Les verifications post-agent (blackboard, clarifications, gate evaluations) ne sont executees que pour les agents reussis." Coder le `Promise.all` avec `Promise.allSettled` ou un try/catch par agent.

### Majeurs a considerer

3. **F-DA-2 (QA sans output dev)** : Soit documenter explicitement que l'overlap produit une QA "spec-only", soit proposer un mode "waterfall overlap" ou QA demarre apres dev mais sans bloquer le pipeline summary.

4. **F-SS-1 (getTracingTimeline)** : Remplacer par un export alias de `getAgentEvents` ou supprimer de la spec.

5. **F-SS-2 (refreshVolatileContext)** : Evaluer si un simple `buildAgentContext()` complet (deja fait pour explorer) est suffisant. Si oui, simplifier P2 en ajoutant un appel `buildAgentContext()` dans la boucle pour les roles suivant le premier.

6. **F-SS-3 (scope)** : Envisager de decouper en specs atomiques P1/P2/P3/P4/P5 si l'implementation depasse 1-2 jours.

7. **F-EC-2 (overlap + blackboard)** : Ajouter une regle : "overlap est incompatible avec useBlackboard (ou les verifications post-agent sont serialisees apres le Promise.all)."

8. **F-EC-3 (refresh avec supabase null)** : Ajouter une garde : "si refreshVolatileContext retourne '', ne pas ecraser le cache existant."

---

## Etape suivante

**Verdict : GO WITH CHANGES**

Mettre a jour `docs/specs/SPEC-pipeline-multiagent-upgrades.md` selon les recommandations ci-dessus (au minimum les 2 bloquants), puis lancer :

```
/dev-implement "Implementer SPEC-pipeline-multiagent-upgrades. Spec: docs/specs/SPEC-pipeline-multiagent-upgrades.md"
```
