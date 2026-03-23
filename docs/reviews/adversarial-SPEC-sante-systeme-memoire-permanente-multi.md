# Adversarial Review — SPEC-sante-systeme-memoire-permanente-multi (Cycle 2)

> Date : 2026-03-23
> Spec source : docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md
> Agents : Devil's Advocate, Edge Case Hunter, Simplicity Skeptic
> Cycle : 2 (post-corrections cycle 1)

---

## Synthese

| Agent | BLOQUANT | MAJEUR | MINEUR | Total |
|-------|----------|--------|--------|-------|
| Devil's Advocate | 0 | 3 | 2 | 5 |
| Edge Case Hunter | 1 | 2 | 2 | 5 |
| Simplicity Skeptic | 0 | 1 | 3 | 4 |
| **Total (deduplique)** | **1** | **5** | **5** | **11** |

**Verdict : GO WITH CHANGES**

Justification : 1 BLOQUANT resolvable (R10 ne produit aucune promotion utile car auto-pipeline utilise executeTask pour l'execution, pas orchestrate) + 5 MAJEURS. Les corrections du cycle 1 sont bien appliquees, la spec est significativement amelioree. Cependant, le nouveau finding sur R10 revele un malentendu architectural important sur auto-pipeline, et plusieurs findings du cycle 1 restent non adresses.

### Corrections cycle 1 validees

Les 7 corrections demandees sont correctement integrees dans la spec :
1. R10 + V15 : auto-pipeline.ts dans le scope avec useBlackboard: true
2. R6 : "taux de dedup estime" retire
3. R13 + V16 : division par zero geree
4. R12 + V18 : dispatch /brain health specifie
5. R11 + V17 : troncature 500 chars
6. R14 : limitation recentPromotions documentee
7. auto-pipeline.ts ajoute dans les fichiers concernes (Section 5)

---

## Devil's Advocate — Rapport

### Findings

**[MAJEUR] F-DA-1 — R10 : useBlackboard sur auto-pipeline ne couvre que la phase analyse, pas l'execution**
- Source : Section 2, R10 / Section 5 (auto-pipeline.ts)
- Description : R10 dit "auto-pipeline.ts passe useBlackboard: true a orchestrate()". Verification du code : auto-pipeline.ts appelle orchestrate() uniquement pour la Phase 3 (analyse, L211-218). La Phase 4 (execution) appelle executeTask() (L243), qui est un code path completement different qui n'utilise ni blackboard ni working memory. Or, c'est le dev agent (Phase 4) qui produit les decisions et decouvertes les plus critiques (choix d'implementation, decouvertes sur le code). Les agents d'analyse (analyst, pm, architect) produisent des specs/plans, rarement des "discoveries" au sens working_memory.
- Impact : La promotion ne capturera que les decisions de la phase analyse (si tant est que les agents d'analyse ecrivent dans working_memory), pas celles de l'execution. Le benefice reel de R10 est quasi nul. L'exemple donne dans R10 ("decisions agents sont promues") est trompeur car il implique que TOUTES les decisions d'un auto-pipeline sont promues, alors que seules celles de la phase analyse le sont.
- Evidence : `src/auto-pipeline.ts` L211-218 (orchestrate) vs L243 (executeTask). executeTask() n'interagit pas avec le blackboard.

**[MAJEUR] F-DA-2 — Seuils de similarity non valides pour le format working memory (cycle 1, non adresse)**
- Source : Section 2, R3
- Description : Les seuils existants (0.85 duplicat, 0.80 contradiction, 0.75 complement) ont ete calibres pour les faits utilisateur courts. Les decisions promues depuis la working memory ont un format different : "Use microservices (raison: Better scalability)". La concatenation "decision (raison: reasoning)" produit des textes plus longs et structurellement differents des faits classiques. Le semantic search peut retourner des similarity ambigues entre 0.75-0.85 pour des items semantiquement identiques mais formules differemment, entrainant des merges au lieu de skips.
- Impact : Pollution potentielle de la memoire par des items quasi-dupliques.

**[MAJEUR] F-DA-3 — Tout est promu comme "fact" sans distinction (cycle 1, non adresse)**
- Source : Section 4.1 / Code existant L939-940
- Description : Les decisions et discoveries sont toutes inserees avec type "fact". Une decision architecturale ("Use REST API") et une decouverte factuelle ("Coverage is 85%") ont des natures semantiquement differentes. Les regrouper sous "fact" empeche tout filtrage futur par nature et melange les items dans get_facts().
- Impact : Si un mecanisme de filtrage "decisions recentes" vs "decouvertes recentes" est souhaite a terme, il faudra parser le metadata, ce qui est fragile. Hors scope V1 mais devrait etre documente comme zone d'ombre.

**[MINEUR] F-DA-4 — R11 : troncature 500 chars dans promoteWorkingMemory mais pas dans le code existant**
- Source : Section 2, R11 / Code existant memory.ts L910-911
- Description : R11 dit "les items promus sont tronques a 500 caracteres maximum avant insertion en memoire". Or le code existant de promoteWorkingMemory() (L910-911) concatene deja decision + reasoning sans troncature. La spec dit "modifier memory.ts" pour ajouter la troncature, mais ne precise pas si c'est dans promoteWorkingMemory() ou dans un layer au-dessus. La position exacte de la troncature dans le code devrait etre explicitee : avant resolveMemoryConflict() (pour que le search soit fait sur le texte tronque) ou apres (inconsistance potentielle entre le texte cherche et le texte insere).
- Impact : Mineur si tronque avant resolve, mais si tronque apres, le search pourrait trouver un match sur le texte long puis inserer le texte court, ce qui serait incoherent.

**[MINEUR] F-DA-5 — References a des numeros de ligne fragiles (cycle 1, non adresse)**
- Source : Section 5, Section 6 (Patterns 2, 3, 5)
- Description : La spec reference des numeros de ligne precis (L908-919, L796-830, L916-920, L1710-1783, L1779). Tout changement dans memory.ts ou orchestrator.ts avant l'implementation invalidera ces references.
- Impact : Risque de confusion a l'implementation.

### Statistiques
- Bloquants : 0
- Majeurs : 3
- Mineurs : 2

---

## Edge Case Hunter — Rapport

### Findings

**[BLOQUANT] F-EC-1 — R10 + auto-pipeline : le blackboard est cree puis abandonne sans cleanup**
- Scenario : Avec R10, auto-pipeline appelle orchestrate() avec useBlackboard: true pour la Phase 3 (analyse). L'orchestrateur cree un blackboard (L628-649), execute les agents d'analyse, puis termine normalement en marquant le blackboard "completed" (L1770-1776) et en nettoyant les trackers (L1780-1783). Ensuite, auto-pipeline continue avec Phase 4 (executeTask) qui ne connait pas ce blackboard. Le blackboard reste en base avec status "completed" apres la phase analyse. Si la Phase 4 echoue, le blackboard indique "completed" alors que le pipeline global a echoue. Pire : si auto-pipeline est utilise sans includeAnalysis (L201), orchestrate() n'est pas appele du tout et useBlackboard n'a aucun effet.
- Source : Section 2, R10 / auto-pipeline.ts L201-218, L243
- Impact : (1) Inconcurrence semantique : blackboard "completed" mais pipeline echoue. (2) Si includeAnalysis=false, R10 est un no-op. (3) Un blackboard orphelin en base (pas de cleanup si Phase 4 echoue). L'hypothese implicite de R10 est que orchestrate() est le seul point de sortie d'auto-pipeline, ce qui est faux.
- Frequence estimee : frequent (auto-pipeline est le mode principal d'execution autonome)

**[MAJEUR] F-EC-2 — Concurrence : deux pipelines simultanement sur le meme projet (cycle 1, non adresse)**
- Scenario : Deux pipelines /orchestrate --blackboard sur des taches differentes executent promoteWorkingMemory en parallele. resolveMemoryConflict() appelle findSimilarFact() qui invoque la Edge Function search. Si les deux promotions s'interleave, le dedup ne fonctionne pas car l'embedding du premier insert n'est pas encore genere quand le second fait sa recherche.
- Source : Section 2, R1 + R3
- Impact : Double insertion de faits identiques.
- Frequence estimee : rare (semaphore max 3, mais possible)

**[MAJEUR] F-EC-3 — Edge Function search en panne : insertions massives sans dedup (cycle 1, non adresse)**
- Scenario : Supabase disponible mais Edge Function search en panne ou rate-limited. findSimilarFact() retourne null, resolveMemoryConflict() retourne toujours "insert". Tous les items sont inseres sans aucun filtrage.
- Source : Section 2, R3 / Code memory.ts L760-770
- Impact : Insertion massive de doublons. Le feature flag memory_promotion peut couper la promotion, mais il n'y a pas de detection automatique de cette degradation.
- Frequence estimee : occasionnel (Edge Functions ont des cold starts et rate limits)

**[MINEUR] F-EC-4 — R11 troncature : perte silencieuse d'information sans avertissement**
- Scenario : Un agent produit une decision de 2000 caracteres avec un reasoning detaille. La troncature a 500 chars coupe le reasoning. L'utilisateur qui lit la memoire promue voit une decision tronquee sans savoir qu'il manque de l'information. Aucun log ou metadata ne signale que la troncature a eu lieu.
- Source : Section 2, R11
- Impact : Perte silencieuse d'information. L'item tronque pourrait etre semantiquement different de l'original (le meaning change si tronque au milieu d'une phrase).
- Frequence estimee : occasionnel

**[MINEUR] F-EC-5 — memoryHealthStats topAccessed avec access_count faible (cycle 1, non adresse)**
- Scenario : La plupart des memoires ont access_count 0 ou 1. Le top 5 affiche des items avec tous access_count=1, ce qui n'apporte aucune valeur informative.
- Source : Section 4.2, champ topAccessed
- Impact : UX degradee (information sans valeur).
- Frequence estimee : frequent sur les projets jeunes

### Statistiques
- Bloquants : 1
- Majeurs : 2
- Mineurs : 2

---

## Simplicity Skeptic — Rapport

### Findings

**[MAJEUR] F-SS-1 — R10 ajoute de la complexite pour un benefice nul**
- Source : Section 2, R10 / Section 5 (auto-pipeline.ts)
- Description : R10 demande de modifier auto-pipeline.ts pour passer useBlackboard: true. Cela cree un blackboard Supabase (avec toute sa mecanique : creation, sections, version tracking, cleanup, status update) pour la phase analyse uniquement. Or (1) les agents d'analyse ecrivent principalement dans les sections spec/plan/tasks du blackboard, pas dans working_memory, et (2) la phase execution (qui genere les vraies decisions) n'utilise pas ce blackboard. Le cout (nouveau import, creation/cleanup d'un blackboard supplementaire, test a ecrire) n'est pas justifie par le benefice.
- Alternative : Documenter que la promotion via auto-pipeline n'est effective que via /orchestrate --blackboard. Retirer R10 de la V1 et re-evaluer quand auto-pipeline sera refactorise pour utiliser orchestrate() de bout en bout.
- Codebase : auto-pipeline.ts L211-243 montre clairement les deux code paths separes.

**[MINEUR] F-SS-2 — Duplication des queries entre /brain et /brain health (cycle 1, non adresse)**
- Source : Section 6, Pattern 4 vs Section 4.2
- Description : /brain execute deja get_facts, get_active_goals, count par type (L57-68). memoryHealthStats() recalcule total, byType, etc. Si un utilisateur fait /brain puis /brain health, les queries sont doublees. La spec ne prevoit pas de reutilisation.
- Alternative : memoryHealthStats() pourrait etre appele dans /brain pour enrichir le prompt LLM. Hors scope V1 mais la dette technique est creee.

**[MINEUR] F-SS-3 — archiveCount et linksCount : metriques brutes sans interpretation (cycle 1, non adresse)**
- Source : Section 4.2, champs archiveCount et linksCount
- Description : "Archive: 34" et "Liens semantiques: 87" sont des nombres bruts. Sans ratio (archive/total, liens/memoire), ils n'ont pas de valeur pour piloter la qualite memoire. Le spec ajoute de la complexite (2 queries supplementaires dans le Promise.all) pour une valeur informative faible.
- Alternative : Remplacer par des ratios ou omettre en V1.

**[MINEUR] F-SS-4 — Section 9 coverage revendique "14 V-criteres" mais le spec en a 18**
- Source : Section 9, dimension Validation
- Description : La section 9 dit "14 V-criteres avec niveaux explicites" mais la section 8 contient V1 a V18, soit 18 V-criteres (les V15-V18 ont ete ajoutes dans le cycle 1). La section 9 n'a pas ete mise a jour apres les corrections.
- Alternative : Corriger "14" en "18" dans la section 9.

### Statistiques
- Bloquants : 0
- Majeurs : 1
- Mineurs : 3

---

## Findings dedupliques et croises

| ID | Severite | Titre | Agents |
|----|----------|-------|--------|
| F-EC-1 | BLOQUANT | R10 auto-pipeline : blackboard cree pour analyse seulement, abandon sans benefice reel | EC, DA, SS |
| F-DA-1 | MAJEUR | R10 ne couvre que Phase 3 (analyse), pas Phase 4 (execution via executeTask) | DA, EC, SS |
| F-DA-2 | MAJEUR | Seuils similarity non valides pour le format working memory | DA |
| F-DA-3 | MAJEUR | Tout promu comme "fact" sans distinction decision/discovery | DA |
| F-EC-2 | MAJEUR | Concurrence : double promotion sans dedup fiable | EC |
| F-EC-3 | MAJEUR | Edge Function search en panne : insertions massives sans dedup | EC |
| F-DA-4 | MINEUR | Position de la troncature R11 non specifiee (avant ou apres resolve) | DA, EC |
| F-DA-5 | MINEUR | Numeros de ligne fragiles dans les references | DA |
| F-EC-5 | MINEUR | topAccessed inutile avec access_count faible | EC, SS |
| F-SS-2 | MINEUR | Duplication queries /brain vs /brain health | SS |
| F-SS-4 | MINEUR | Section 9 dit "14 V-criteres" au lieu de 18 | SS |

Note : F-EC-1 et F-DA-1 et F-SS-1 decrivent le meme probleme fondamental (R10 n'atteint pas son objectif) sous trois angles differents. Les trois agents convergent independamment : c'est le finding le plus significatif de ce cycle 2.

---

## Recommandations (actions pour passer a GO)

1. **[BLOQUANT] Revoir R10 (auto-pipeline + useBlackboard)** : L'ajout de useBlackboard: true dans auto-pipeline ne produit pas le benefice escompte car executeTask() (Phase 4) n'ecrit pas dans le blackboard. Deux options :
   - **(a) Retirer R10 et documenter la limitation** : la promotion ne fonctionne que via /orchestrate --blackboard. Accepter en V1 que auto-pipeline ne beneficie pas de la promotion. C'est l'option la plus simple et honnete.
   - **(b) Deplacer la promotion dans orchestrate() pour tous les pipelines**, sans condition useBlackboard. Lire la working_memory si elle existe (non-null), sinon skip. Cela permet a tout appel orchestrate() de promouvoir, meme sans blackboard. Mais cela ne couvre toujours pas executeTask() d'auto-pipeline.
   Le choix (a) est recommande pour garder la V1 simple et honnete.

2. **[MAJEUR] Documenter la non-distinction fact/decision** comme zone d'ombre : ajouter en section 9 que tous les items sont promus comme "fact" et que la distinction semantique est perdue. Prevoir un champ metadata.promotion_type ("decision" | "discovery") pour un filtrage futur.

3. **[MINEUR] Preciser la position de la troncature R11** : tronquer AVANT l'appel a resolveMemoryConflict() pour que la recherche semantique et l'insertion portent sur le meme texte. Ajouter un metadata.truncated: true si troncature appliquee.

4. **[MINEUR] Corriger la section 9** : remplacer "14 V-criteres" par "18 V-criteres".

5. **[RECOMMANDE] Ajouter un garde-fou Edge Function** : dans promoteWorkingMemory, si plus de N items consecutifs retournent "insert" (findSimilarFact retourne null), logger un warning indiquant une degradation potentielle du service de dedup.

---

## Points forts identifies

1. **Corrections cycle 1 bien integrees** : les 7 corrections sont toutes presentes et correctement formulees dans les regles et V-criteres. La spec montre une bonne capacite d'iteration.

2. **R12 + V18 (dispatch /brain health)** : le match exact sur "health" avec fallback LLM est le bon pattern. Bien specifie.

3. **R13 + V16 (division par zero)** : la gestion du cas table vide est explicite et testable.

4. **R11 + V17 (troncature)** : bonne decision de limiter la taille des items promus. Besoin seulement de preciser la position dans le code.

5. **Scope V1 toujours bien delimitee** : malgre les ajouts du cycle 1, le perimetre reste coherent et implementable en une iteration.

6. **Feature flag (R8)** : le pattern feature flag avec defaut false reste la meilleure approche pour un rollback propre.

---

## Etape suivante

**Verdict : GO WITH CHANGES**

Actions requises avant implementation :
1. Revoir R10 : soit retirer et documenter la limitation auto-pipeline, soit reformuler avec un mecanisme viable (BLOQUANT resolvable)
2. Corriger section 9 (14 -> 18 V-criteres)
3. Preciser la position de la troncature R11 (avant resolveMemoryConflict)

Findings acceptables en V1 sans modification (non bloquants) :
- Seuils de similarity non recalibres pour le format working memory (a surveiller via metriques)
- Tout promu comme "fact" (documenter comme limitation V1)
- Concurrence double promotion (rare, mitige par le semaphore)
- Edge Function en panne (existant, pas specifique a cette spec)

Une fois les corrections appliquees a `docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md` :
`/dev-implement "Implementer SPEC-sante-systeme-memoire-permanente-multi. Spec: docs/specs/SPEC-sante-systeme-memoire-permanente-multi.md"`
