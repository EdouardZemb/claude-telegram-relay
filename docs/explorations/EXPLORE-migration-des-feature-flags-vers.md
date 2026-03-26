---
phase: 0-explore
generated_at: "2026-03-25T14:30:00Z"
subject: "Migration des feature flags de config/features.json vers Supabase"
verdict: GO
next_step: "dev-spec"
---

## Section 1 -- Probleme

Le systeme de feature flags actuel repose sur un fichier JSON local (`config/features.json`) lu et ecrit par `src/feature-flags.ts`. Ce fichier est un fichier suivi par Git (tracked). Le probleme survient lors du deploiement : le workflow `deploy.yml` execute `git checkout -- .` qui remet tous les fichiers tracked a l'etat du commit, ecrasant les modifications runtime faites via `/feature enable|disable`.

Concretement, si un operateur desactive `sdd_auto_deploy` via Telegram pour bloquer un deploy, le prochain deploy restaure le fichier a son etat Git (ou le flag est `true`), annulant la decision operationnelle. C'est un bug critique de persistance : les flags runtime ne survivent pas aux deploys.

Une exploration est necessaire car plusieurs strategies sont possibles (Supabase table, fichier hors Git, hybrid cache) et le choix impacte :
- Le module `feature-flags.ts` (4 fonctions exportees, 10+ importeurs)
- Le workflow CI/CD `deploy.yml` (lecture du flag `sdd_auto_deploy` avant restart)
- Le MCP server `mcp/memory-server.ts` (tool `manage_feature`)
- Les 11 flags existants en production

## Section 2 -- Etat de l'art

| # | Source | Type | Date | Resume | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | [featureflags.io - Database Migrations](https://featureflags.io/feature-flags-database-migrations/) | Guide | 2025 | Pattern de stockage des flags en DB avec cache local, migration multi-etapes | Haute |
| 2 | [Reflectoring - Zero Downtime with Feature Flags](https://reflectoring.io/zero-downtime-deployments-with-feature-flags/) | Article | 2025 | Strategie parallel read/write pour migrer un store de flags, rollback via flag | Haute |
| 3 | [Supabase Best Practices](https://www.leanware.co/insights/supabase-best-practices) | Guide | 2025 | Schema design normalise, RLS policies, service_role vs anon key | Moyenne |
| 4 | [LaunchDarkly - Multi-stage migrations](https://docs.launchdarkly.com/guides/infrastructure/infrastructure-migration) | Documentation | 2025 | Pattern de migration incrementale : shadow read, dual write, full cutover | Moyenne |

**Synthese des enseignements cles :**

Le consensus de l'industrie est clair : les feature flags doivent etre stockes dans un store persistant independant du deploiement. Les fichiers locaux sont acceptables uniquement pour le developpement local ou les prototypes. En production, un store base de donnees est le standard.

La strategie recommandee pour la migration est le "dual read" : lire d'abord la base, fallback sur le fichier local si la base est indisponible. Cela permet une migration sans downtime et un rollback instantane.

Pour le cache local, les bonnes pratiques suggerent un TTL court (30-60 secondes) pour les flags qui changent rarement, avec invalidation immediate lors des ecritures. La lecture fichier actuelle (re-read a chaque appel) est deja un pattern "no cache" qui fonctionne pour un fichier de 11 entries -- le meme pattern peut s'appliquer en DB avec un cache en memoire pour eviter les round-trips reseau.

Le point cle pour notre cas : le deploy script `deploy.yml` lit `features.json` en shell (via `bun -e "require(...)"`) pour decider s'il faut redemarrer les services. Apres migration, ce script devra interroger Supabase directement ou utiliser un mecanisme alternatif.

## Section 3 -- Archeologie codebase

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | `src/feature-flags.ts` (71 LOC) | Module principal : `loadFeatures()`, `isFeatureEnabled()`, `setFeature()`, `listFeatures()`, `formatFeatures()`. Lecture/ecriture synchrone via `readFileSync`/`writeFileSync` | **Haut** — refonte complete |
| 2 | `config/features.json` (13 LOC) | 11 flags booleens. Fichier tracked par Git | **Haut** — a remplacer ou deprecier |
| 3 | `.github/workflows/deploy.yml` (L22-39) | Lit `features.json` en shell pour verifier `sdd_auto_deploy` avant restart | **Haut** — doit interroger la DB |
| 4 | `src/commands/utilities.ts` | Commande `/feature` : appelle `setFeature()` et `formatFeatures()` | **Moyen** — API inchangee si interface preservee |
| 5 | `mcp/memory-server.ts` (L727-760) | Tool `manage_feature` : appelle `listFeatures()`, `setFeature()` | **Moyen** — meme interface |
| 6 | `src/heartbeat.ts` | 3 appels `isFeatureEnabled()` (heartbeat, llmops_monitoring, audit_system) | **Faible** — appels indirects, interface preservee |
| 7 | `src/sdd-auto-advance.ts` | `isFeatureEnabled("sdd_auto_advance")` | **Faible** — idem |
| 8 | `src/job-manager.ts` | `isFeatureEnabled("job_manager")` | **Faible** — idem |
| 9 | `src/commands/command-router.ts` | `isFeatureEnabled("nlu_feature_request")` | **Faible** — idem |
| 10 | `src/commands/zz-messages.ts` | `isFeatureEnabled("auto_document_search")` | **Faible** — idem |
| 11 | `src/memory/graph.ts` | `isFeatureEnabled("agent_role_memory")` | **Faible** — idem |
| 12 | `src/feedback-analyzer.ts` | `isFeatureEnabled("prompt_feedback_loop")` via deps injection | **Faible** — idem |
| 13 | `tests/unit/feature-flags.test.ts` | 127 LOC, lit/ecrit directement `features.json` | **Haut** — refonte tests |
| 14 | `tests/unit/sdd-auto-deploy.test.ts` | Verifie existence du flag dans le fichier JSON | **Moyen** — adapter |
| 15 | `src/bot-context.ts` | Expose `supabase: SupabaseClient | null` — client disponible partout | **Actif reutilisable** |
| 16 | `db/schema.sql` | Pas de table `feature_flags` existante | **A creer** |

**Points de friction :**
- `feature-flags.ts` utilise des API synchrones (`readFileSync`/`writeFileSync`). La migration vers Supabase impose des API async. Tous les appels `isFeatureEnabled()` sont dans des contextes async, donc le changement est faisable mais touche la signature.
- Le `deploy.yml` s'execute en shell sans le runtime Node/Bun du bot. Il devra interroger Supabase via `curl` ou un script Bun dediee.
- Le `heartbeat.ts` cree son propre client Supabase (il tourne en process separe PM2). Pas de probleme.

**Actifs reutilisables :**
- `bot-context.ts` fournit deja un client Supabase accessible par tous les Composers
- Le pattern `getConfig()` (config.ts) avec lazy singleton est reutilisable pour le cache en memoire
- Les tests existants couvrent bien l'API publique — ils guideront la refonte
- Le MCP server importe deja les fonctions de `feature-flags.ts` — l'interface peut rester identique

## Section 4 -- Matrice d'alternatives

| Critere | A: Status quo (fichier JSON) | B: Supabase table + cache memoire | C: Fichier hors Git (.gitignore) | D: Supabase + fichier fallback hybride |
|---------|:---:|:---:|:---:|:---:|
| **Complexite** (obligatoire) | S | M | S | L |
| **Valeur ajoutee** (obligatoire) | Low | High | Med | High |
| **Risque technique** (obligatoire) | Low | Low | Low | Med |
| *Impact maintenance* | Negatif (bug persistance) | Positif (centralise) | Neutre | Negatif (2 sources de verite) |
| *Reversibilite* | N/A (actuel) | Haute (fallback fichier) | Haute | Moyenne |

**Option A — Status quo (fichier JSON tracked)** : Aucun effort mais le bug de persistance persiste. Chaque deploy ecrase les modifications runtime. Le flag `sdd_auto_deploy` est particulierement critique car il est cense bloquer les deploys, mais le deploy lui-meme le restaure. C'est un cercle vicieux.

**Option B — Supabase table + cache memoire** : Creer une table `feature_flags` dans Supabase. Le module `feature-flags.ts` devient async avec un cache en memoire (TTL 60s). Les ecritures (`setFeature`) persistent en DB immediatement et invalident le cache. Le deploy script interroge Supabase via `curl` (l'API REST PostgREST est deja disponible). Migration one-shot des 11 flags existants. Le fichier `features.json` est conserve comme valeur par defaut (defaults) mais n'est plus modifie au runtime.

**Option C — Fichier hors Git (.gitignore)** : Deplacer `features.json` dans un chemin ignore par Git (ex: `data/features.json`). Simple mais fragile : le fichier peut etre perdu lors d'un `git clean`, ne survit pas a une reinstallation, pas de visibilite multi-instance, pas de backup.

**Option D — Hybride Supabase + fichier fallback** : Comme B mais avec dual-read systematique (DB puis fichier) et dual-write (DB + fichier). Complexite elevee pour un gain marginal par rapport a B seul. La degradation gracieuse de B (fallback sur defaults) couvre deja le cas de panne Supabase.

## Section 5 -- Verdict et justification

**Verdict : GO** — Implementer l'option B (Supabase table + cache memoire).

Justification :

1. **Le probleme est reel et impactant** (Section 1) : le bug `git checkout -- .` qui ecrase les flags runtime est confirme dans le deploy.yml (ligne 17). Le flag `sdd_auto_deploy` est cense controler le deploy mais est ecrase PAR le deploy — c'est un defaut de conception critique.

2. **La solution est alignee avec l'etat de l'art** (Section 2) : le stockage en base de donnees est le standard de l'industrie pour les feature flags en production. Le pattern cache + TTL est eprouve et simple a implementer.

3. **L'impact codebase est maitrise** (Section 3) : seuls 3 fichiers necessitent des modifications significatives (`feature-flags.ts`, `deploy.yml`, tests). Les 10+ consommateurs de `isFeatureEnabled()` n'ont besoin d'aucun changement si l'interface reste synchrone grace au cache en memoire (le cache est pre-charge au boot et rafraichi periodiquement).

4. **La complexite est moderate (M)** et le risque technique est faible : Supabase est deja utilise partout dans le projet, le pattern PostgREST est bien maitrise, et le fallback sur des defaults hardcodes garantit la resilience.

5. **Le deploy script peut interroger Supabase via curl** en utilisant les variables d'environnement deja presentes sur le runner self-hosted (`SUPABASE_URL`, `SUPABASE_ANON_KEY`), sans dependance au runtime Bun.

## Section 6 -- Input pour etape suivante

### Input pour spec

**Option recommandee** : B — Supabase table `feature_flags` + cache memoire dans `feature-flags.ts`

**Schema table propose** :
```sql
CREATE TABLE IF NOT EXISTS feature_flags (
  flag TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT DEFAULT 'system'
);
```

**Fichiers a modifier** :
1. `src/feature-flags.ts` — Refonte : API async avec cache memoire (Map + TTL), `initFeatureFlags(supabase)` au boot, `isFeatureEnabled()` reste synchrone (lit le cache)
2. `db/schema.sql` — Ajouter table `feature_flags`
3. `.github/workflows/deploy.yml` — Remplacer lecture JSON par `curl` PostgREST
4. `tests/unit/feature-flags.test.ts` — Adapter pour Supabase mock
5. `config/features.json` — Conserver comme defaults (valeurs par defaut si DB vide), ne plus modifier au runtime

**Contraintes identifiees** :
- `isFeatureEnabled()` est appele dans des contextes synchrones. Le cache memoire doit etre pre-charge au demarrage pour que la lecture reste synchrone (pas de changement de signature pour les 10+ consommateurs)
- Le deploy script n'a pas acces au runtime Bun de maniere fiable (il tourne en shell). Utiliser `curl` vers l'API REST Supabase
- Le `heartbeat.ts` cree son propre client Supabase — il faudra soit passer le module `feature-flags.ts` (prefere), soit dupliquer l'init
- Migration des 11 flags existants : script one-shot INSERT avec les valeurs actuelles de `features.json`
- RLS : la table doit etre accessible en lecture avec `anon` key (les flags ne sont pas sensibles), ecriture restreinte ou via `service_role`

**Questions ouvertes a resoudre pendant la spec** :
1. TTL du cache : 30s vs 60s vs event-driven (Supabase Realtime) ?
2. Le MCP server (`manage_feature`) doit-il avoir son propre client ou reutiliser un singleton ?
3. Faut-il un endpoint RPC pour atomic toggle ou un simple UPDATE suffit ?
4. Gestion de l'init au boot : que faire si Supabase est down au demarrage ? (proposition : charger les defaults de `features.json` et retenter en background)
