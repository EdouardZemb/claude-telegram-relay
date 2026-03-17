# S36 — Memoire Evolutive

## Objectif

Transformer la memoire plate (stockage + recherche) en memoire relationnelle qui comprend les liens entre informations, evolue automatiquement (mise a jour au lieu de duplication), et filtre intelligemment a l'ecriture.

## Prerequis

- Systeme memoire existant : memory.ts, classify-thought Edge Function, embed Edge Function
- Semantic search fonctionnel (match_memory RPC, search Edge Function)
- Contradiction detection existante (detectAndLogContradiction, seuil 0.80)

## Functional Requirements

### FR-001 : Liens inter-memories

Quand une nouvelle memoire est stockee, decouvrir les memories semantiquement proches et creer des liens bidirectionnels.

**Table `memory_links` :**
- source_id (UUID, FK memory.id)
- target_id (UUID, FK memory.id)
- similarity (NUMERIC, 0-1)
- link_type (TEXT : "related" | "supports" | "extends")
- created_at (TIMESTAMPTZ)
- PK : (source_id, target_id)

**Mecanisme :**
1. Apres insertion d'une memoire, recherche semantique (seuil 0.65, max 5 resultats)
2. Exclure les contradictions (gerees par FR-002) et les doublons (similarity > 0.85)
3. Creer des liens bidirectionnels (A->B et B->A) avec le score de similarite
4. link_type determine par similarite : >= 0.75 "extends", >= 0.65 "related"
5. Appel asynchrone (fire-and-forget) pour ne pas ralentir le stockage

**Utilisation des liens :**
- `getMemoryContext()` enrichi : pour chaque fait/goal retourne, inclure les memories liees (1 niveau de profondeur, max 3 liens par memoire)
- `/brain` affiche les clusters de memories connectees
- `getLinkedMemories(memoryId)` : retourne les memories liees avec score et type

**Acceptance Criteria :**
- AC-001 : Liens crees automatiquement apres chaque insertion de memoire
- AC-002 : Liens bidirectionnels (source->target et target->source)
- AC-003 : Seuil de similarite configurable (default 0.65)
- AC-004 : Max 5 liens par memoire (garder les plus forts)
- AC-005 : getMemoryContext() inclut les memories liees dans le contexte
- AC-006 : getLinkedMemories() retourne les liens tries par similarite
- AC-007 : /brain affiche les clusters connectes

### FR-002 : Evolution des memories (merge au lieu de duplication)

Quand une nouvelle information contredit ou complete une memoire existante, mettre a jour l'existante au lieu de creer un doublon.

**Mecanisme :**
1. Avant insertion, recherche semantique (seuil 0.75)
2. Classification du match :
   - Similarite >= 0.85 : doublon → skip insertion, bump access de l'existante
   - Similarite >= 0.80 + tonalite opposee : contradiction → update le contenu de l'existante, incrementer metadata.revision_count, stocker l'ancien contenu dans metadata.previous_versions[]
   - Similarite 0.75-0.80 : complement → enrichir l'existante en fusionnant le contenu (appel LLM leger pour merge, ou concatenation simple)
   - Similarite < 0.75 : nouveau → insertion normale (comportement actuel)
3. L'embedding de la memoire mise a jour est regenere (via webhook embed existant)

**Distinction contradiction vs complement :**
- Utiliser classify-thought pour extraire le type semantique
- Contradiction : memes sujets (topics overlap) + assertion opposee (negation, nouveau fait remplacant)
- Complement : memes sujets + information additionnelle

**Acceptance Criteria :**
- AC-008 : Doublons detectes (>= 0.85) et skippes avec bump access
- AC-009 : Contradictions (>= 0.80 + oppose) declenchent update de l'existante
- AC-010 : metadata.previous_versions[] conserve l'historique des mises a jour
- AC-011 : metadata.revision_count incremente a chaque update
- AC-012 : Complements (0.75-0.80) enrichissent la memoire existante
- AC-013 : Memories mises a jour voient leur embedding regenere
- AC-014 : Le comportement par defaut (similarity < 0.75) reste inchange

### FR-003 : Extraction selective (filtrage a l'ecriture)

Renforcer le filtrage a l'ecriture pour ne garder que les informations actionnables. Reduire le bruit dans la memoire.

**Mecanisme :**
1. Enrichir classify-thought avec un score d'actionnabilite (0-10)
   - 0-3 : pas actionnable (salutations, meta-conversation, confirmations simples)
   - 4-6 : moderement actionnable (observations generales, contexte)
   - 7-10 : hautement actionnable (decisions, faits cles, preferences, goals)
2. Seuil de stockage : actionnability >= 5 (configurable)
3. Les intent tags explicites ([REMEMBER:], [GOAL:], [IDEA:]) bypassent le filtre (l'utilisateur a explicitement demande le stockage)
4. Les ideas bypassent aussi le filtre (toujours stockees si is_idea = true)

**Metriques :**
- Tracker le nombre de memories filtrees vs stockees dans les logs
- `/brain` affiche le ratio signal/bruit (memories stockees / messages totaux)

**Acceptance Criteria :**
- AC-015 : classify-thought retourne un champ actionability_score (0-10)
- AC-016 : autoRemember() verifie actionability >= seuil avant stockage
- AC-017 : Intent tags explicites bypassent le filtre
- AC-018 : Ideas bypassent le filtre
- AC-019 : Seuil configurable (default 5)
- AC-020 : /brain affiche le ratio signal/bruit

### FR-004 : Memoire de travail structuree

Contexte evolutif par pipeline qui s'enrichit au fur et a mesure de l'execution des agents.

**Mecanisme :**
1. Section `working_memory` dans le blackboard (en plus des 5 sections existantes)
2. Structure :
   - decisions[] : decisions prises pendant le pipeline (agent, decision, reasoning)
   - discoveries[] : faits decouverts (agent, fact, source)
   - blockers[] : problemes rencontres (agent, issue, status)
   - context_updates[] : enrichissements de contexte (agent, key, value)
3. Chaque agent lit la working_memory en debut d'execution et y ecrit en fin
4. A la fin du pipeline, les decisions et discoveries significatives sont promues en memories permanentes (via autoRemember)
5. Promotion selective : seuls les items avec importance estimee haute sont persistes

**Integration :**
- `buildAgentContext()` inclut la working_memory du pipeline courant
- Le superviseur lit la working_memory pour ses decisions retry/skip/escalate
- `promoteWorkingMemory(sessionId)` extrait et persiste les items significatifs

**Acceptance Criteria :**
- AC-021 : Section working_memory disponible dans le blackboard
- AC-022 : Agents ecrivent decisions/discoveries/blockers pendant l'execution
- AC-023 : Agents suivants lisent la working_memory accumulee
- AC-024 : promoteWorkingMemory() persiste les items significatifs en memories permanentes
- AC-025 : Le superviseur utilise blockers[] pour ses decisions
- AC-026 : working_memory nettoyee avec le reste du blackboard en fin de pipeline

## Edge Cases

- EC-001 : Supabase indisponible pour les liens → skip la creation de liens, log warning, memoire stockee normalement
- EC-002 : Memoire cible d'un lien supprimee/archivee → lien orphelin ignore lors de la lecture (lazy cleanup)
- EC-003 : classify-thought ne retourne pas actionability_score (vieille version) → default a 7 (backward compatible, stocke par defaut)
- EC-004 : Merge de contradiction produit un contenu incoherent → garder l'ancien contenu, stocker le nouveau separement, log warning
- EC-005 : Pipeline sans blackboard (mode sequentiel simple) → pas de working_memory, comportement inchange
- EC-006 : 100+ liens pour une memoire populaire → capped a 5 liens max par memoire, garder les plus forts
- EC-007 : Boucle de liens (A->B->C->A) → getLinkedMemories ne suit qu'un seul niveau de profondeur

## Success Criteria

- 50+ nouveaux tests
- Tous les 948+ tests existants passent
- Liens crees automatiquement et visibles dans /brain
- Contradictions resolues par merge au lieu de duplication
- Ratio signal/bruit ameliore (moins de memories stockees, plus pertinentes)
- Working memory enrichit le contexte des agents en pipeline
- Backward compatible : feature flags ou seuils configurables
