# S30 Task Breakdown — CI/CD & E2E Testing

> Phase 3 du processus SDD. Derive de s30-cicd-e2e-testing.md (spec) et s30-architecture-plan.md (architecture).
> Gate 1 (spec) validee le 2026-03-16. Gate 2 (architecture) validee le 2026-03-16.


## Task List

### T1: Installer le runner GitHub Actions sur le serveur (FR-001)
- Priority: P1
- Estimate: 1h
- Dependencies: rien
- AC: AC-001, AC-002, AC-003

Script d'installation `scripts/setup-runner.sh` : telecharge le binaire GitHub Actions runner, l'enregistre avec le token du repo, cree le service systemd `github-runner.service`. Le runner initie des connexions HTTPS sortantes (port 443), contournant le pare-feu. Labels : `self-hosted`, `linux`.

Note : T1 est une tache d'infrastructure manuelle. Le script guide l'installation mais necessite une execution interactive (token d'enregistrement a coller). Le service systemd garantit le redemarrage au boot.

Tests (3):
- [ ] AC-001 : runner connecte et "online" dans GitHub (verification manuelle)
- [ ] AC-002 : un job CI se lance sur le runner self-hosted (apres T2)
- [ ] AC-003 : le service systemd demarre au reboot (`systemctl is-enabled github-runner`)

Files: scripts/setup-runner.sh


### T2: Migrer ci.yml vers self-hosted (FR-002)
- Priority: P1
- Estimate: 1h
- Dependencies: T1
- AC: AC-004, AC-005, AC-006

Modifier `.github/workflows/ci.yml` : `runs-on: [self-hosted, linux]` au lieu de `ubuntu-latest`. Retirer le step `oven-sh/setup-bun@v2` (bun deja installe sur le serveur). Conserver `bun install --frozen-lockfile` pour la correctness. Conserver `actions/checkout@v4` pour le checkout propre dans le workspace runner.

Tests (3):
- [ ] AC-004 : tous les tests existants (749+) passent sur le runner self-hosted
- [ ] AC-005 : le step setup-bun n'est plus present dans ci.yml
- [ ] AC-006 : le check status est reporte a GitHub (pass/fail visible dans la PR)

Files: .github/workflows/ci.yml


### T3: Migrer deploy.yml vers self-hosted (FR-003)
- Priority: P1
- Estimate: 1.5h
- Dependencies: T1
- AC: AC-007, AC-008, AC-009, AC-010

Remplacer `appleboy/ssh-action` par un deploy local : `cd /home/edouard/claude-telegram-relay && git pull && pm2 restart`. Conserver le smoke test + rollback (S29). Supprimer les secrets SSH de GitHub (SERVER_HOST, SERVER_USER, DEPLOY_SSH_KEY, SERVER_PORT) une fois valide.

Tests (4):
- [ ] AC-007 : le job deploy execute git pull + bun install + pm2 restart localement
- [ ] AC-008 : le smoke test valide le deployment (bun run smoke)
- [ ] AC-009 : le rollback se declenche si le smoke echoue (scripts/rollback.sh)
- [ ] AC-010 : les secrets SSH sont supprimes de GitHub (verification manuelle)

Files: .github/workflows/deploy.yml


### T4: Retirer auto-deploy.sh et claude-autodeploy (FR-004)
- Priority: P1
- Estimate: 0.5h
- Dependencies: T3
- AC: AC-011, AC-012, AC-013

Supprimer `scripts/auto-deploy.sh`. Retirer l'entree `claude-autodeploy` de `ecosystem.config.cjs`. Mettre a jour CLAUDE.md (retirer les references auto-deploy et claude-autodeploy). Sur le serveur : `pm2 delete claude-autodeploy && pm2 save`.

Tests (3):
- [ ] AC-011 : scripts/auto-deploy.sh n'existe plus
- [ ] AC-012 : ecosystem.config.cjs n'a plus d'entree claude-autodeploy
- [ ] AC-013 : CLAUDE.md ne reference plus auto-deploy ni claude-autodeploy

Files: scripts/auto-deploy.sh (supprimer), ecosystem.config.cjs, CLAUDE.md


### T5: Extraire createBot() de relay.ts (prerequis FR-006)
- Priority: P1
- Estimate: 2h
- Dependencies: rien (parallelisable avec T1-T4)
- AC: prerequis technique pour AC-018, AC-022

Refactoring de relay.ts : extraire la creation du bot et l'enregistrement de tous les handlers dans une fonction `createBot(token: string): Bot`. Ajouter un guard `if (import.meta.main)` autour de `bot.start()` et du code d'initialisation global (Supabase init, PID file, notification queue, etc.). Le fichier relay.ts doit pouvoir etre importe sans effets de bord pour les tests E2E.

Impact : ~3200 lignes a reorganiser mais zero changement fonctionnel. Tous les handlers restent identiques. Le bot de prod fonctionne comme avant via `bun run src/relay.ts` (import.meta.main = true).

Tests (4):
- [ ] createBot() retourne une instance Bot Grammy avec tous les handlers enregistres
- [ ] import de relay.ts sans import.meta.main ne lance pas bot.start()
- [ ] bot.start() est appele uniquement quand relay.ts est execute directement
- [ ] les 749+ tests existants passent sans regression

Files: src/relay.ts


### T6: Framework E2E avec handleUpdate (FR-005, FR-006, FR-009)
- Priority: P1
- Estimate: 3h
- Dependencies: T5
- AC: AC-014, AC-015, AC-018, AC-019, AC-020, AC-021, AC-022, AC-036, AC-037, AC-038, AC-039

Nouveau fichier `tests/e2e/framework.ts`. Classe E2EFramework qui :
1. Importe createBot() et instancie le bot sans bot.start()
2. Construit des objets Update Telegram synthetiques (message avec text, from, chat)
3. Appelle bot.handleUpdate(update) pour injecter les commandes
4. Intercepte ctx.reply() / ctx.api.sendMessage() pour capturer les reponses
5. Fournit les helpers : sendCommand(cmd), tag(text), assertContains(), assertNotContains()
6. Gere le cleanup Supabase : supprime toutes les lignes avec prefix [E2E-<runId>]
7. RELAY_DIR isole dans /tmp/claude-relay-e2e-<runId>

L'approche handleUpdate (AD-007 architecture plan) evite le besoin d'un bot Telegram externe et de secrets Telegram en CI.

Tests (8):
- [ ] AC-018 : sendCommand() envoie un update via handleUpdate et retourne la reponse
- [ ] AC-019 : la reponse est capturee via l'intercepteur ctx.reply
- [ ] AC-020 : assertContains valide la presence d'un texte dans la reponse
- [ ] AC-021 : timeout depasse retourne une erreur avec le temps ecoule
- [ ] AC-022 : setup() cree le bot, teardown() nettoie proprement
- [ ] AC-036 : tag() ajoute le prefix [E2E-<runId>] aux entites
- [ ] AC-038 : cleanup() supprime les lignes taguees dans Supabase
- [ ] AC-039 : cleanup failure log un warning sans throw

Files: tests/e2e/framework.ts, tests/unit/e2e-framework.test.ts


### T7: Suite de tests E2E — 8+ commandes (FR-007)
- Priority: P1
- Estimate: 2.5h
- Dependencies: T6
- AC: AC-023, AC-024, AC-025, AC-026, AC-027, AC-028, AC-029, AC-030, AC-031

Nouveau fichier `tests/e2e/e2e.test.ts`. 8+ tests E2E couvrant les commandes critiques :
- /help : la reponse contient la liste des commandes
- /status : la reponse contient des infos de sante (pas d'erreur)
- /feature list : la reponse contient des noms de feature flags
- /task [E2E-<runId>] Test : cree une tache dans Supabase
- /backlog : la tache creee apparait dans la reponse
- /monitor : la reponse contient des metriques
- /estimate : la reponse contient des donnees de cout
- Message libre : le bot repond sans crash

Chaque test est independant, cleanup apres chaque test via afterEach.

Tests (9):
- [ ] AC-023 : /help retourne la liste des commandes
- [ ] AC-024 : /status retourne des infos de sante
- [ ] AC-025 : /feature list retourne les feature flags
- [ ] AC-026 : /task cree une tache dans Supabase avec le titre tague
- [ ] AC-027 : /backlog affiche la tache de test
- [ ] AC-028 : /monitor retourne des metriques
- [ ] AC-029 : /estimate retourne des donnees de cout
- [ ] AC-030 : un message libre obtient une reponse non-vide
- [ ] AC-031 : les donnees de test sont nettoyees apres chaque test

Files: tests/e2e/e2e.test.ts


### T8: Integration CI — job E2E dans ci.yml (FR-008)
- Priority: P1
- Estimate: 1h
- Dependencies: T2, T7
- AC: AC-032, AC-033, AC-034, AC-035

Ajouter un job `e2e` dans ci.yml, dependant du job `check` (needs: [check]). Le job :
1. Checkout le repo
2. bun install --frozen-lockfile
3. Cree le RELAY_DIR temporaire dans /tmp
4. Execute bun test tests/e2e avec les env vars (RELAY_DIR, SUPABASE_URL, SUPABASE_ANON_KEY, GITHUB_RUN_ID, E2E_MODE)
5. Cleanup du repertoire temporaire (if: always())

Avec l'approche handleUpdate, les secrets Telegram ne sont plus necessaires. Seuls SUPABASE_URL et SUPABASE_ANON_KEY sont requis.

Tests (4):
- [ ] AC-032 : le job e2e depend du job check (needs: [check])
- [ ] AC-033 : les tests E2E tournent et le cleanup s'execute dans le job
- [ ] AC-034 : les env vars SUPABASE_URL et SUPABASE_ANON_KEY sont disponibles
- [ ] AC-035 : si les tests E2E echouent, la PR est bloquee (check required)

Files: .github/workflows/ci.yml


### T9: Isolation et cleanup des donnees (FR-009)
- Priority: P1
- Estimate: 1h
- Dependencies: T6, T7
- AC: AC-036, AC-037, AC-038, AC-039

Valider et renforcer l'isolation des donnees :
1. Verifier que toutes les entites creees par les E2E portent le prefixe [E2E-<runId>]
2. Tester la non-collision entre deux runs paralleles (runIds differents)
3. Verifier que le cleanup supprime toutes les lignes taguees dans les tables : tasks, memory, messages, logs
4. Verifier que le cleanup echoue gracieusement (log warning, pas de throw)

Cette tache renforce et valide le cleanup deja implemente dans T6, avec des tests specifiques a l'isolation.

Tests (4):
- [ ] AC-036 : toutes les entites de test ont le prefixe [E2E-<runId>]
- [ ] AC-037 : deux runs avec des runIds differents n'entrent pas en collision
- [ ] AC-038 : le cleanup supprime toutes les lignes du runId courant
- [ ] AC-039 : un echec de cleanup log un warning sans bloquer

Files: tests/unit/e2e-isolation.test.ts


### T10: Tests, verification et documentation (FR-010, SC-001 a SC-011)
- Priority: P2
- Estimate: 2h
- Dependencies: T1-T9
- SC: SC-001 a SC-011

Verification finale :
1. Tous les 749+ tests existants passent (SC-002)
2. Les tests E2E passent en CI sur une PR de test (SC-006)
3. La suite E2E complete en moins de 3 minutes (SC-008)
4. Zero donnees residuelles apres un run (SC-009)
5. Detection de regression intentionnelle (SC-010) : introduire un bug dans /help, verifier que le test E2E le detecte
6. Mettre a jour CLAUDE.md : nouveau job CI E2E, retrait auto-deploy/claude-autodeploy, framework E2E, approche handleUpdate
7. Mettre a jour le test plan dans le template PR

Tests (5):
- [ ] SC-002 : tous les tests existants passent sur le runner
- [ ] SC-006 : 8+ tests E2E passent en CI
- [ ] SC-008 : suite E2E < 3 minutes
- [ ] SC-009 : zero donnees residuelles apres un run
- [ ] SC-010 : regression intentionnelle detectee par les E2E

Adversarial (3):
- [ ] Spec vs implementation drift check (tous les FR implementes)
- [ ] Tous les FR-XXX tracables vers du code
- [ ] Tous les AC-XXX tracables vers des tests

Files: CLAUDE.md, docs/sprints/s30-cicd-e2e-testing.md (cocher les items)


## Dependency Graph

```
T1 (runner) ──────┬──→ T2 (ci.yml) ──────────┬──→ T8 (job E2E CI)
                   │                           │
                   └──→ T3 (deploy.yml) ──→ T4 (retrait auto-deploy)
                                               │
T5 (createBot) ──→ T6 (framework E2E) ──→ T7 (suite E2E) ──┤
                                          │                  │
                                          └──→ T9 (isolation)│
                                                             │
                                          T1-T9 ──→ T10 (verification)
```

Parallelisable : T1 + T5 (demarrent immediatement, pas d'inter-dependance)
Chemin critique : T5 → T6 → T7 → T8 → T10 = 10.5h


## Traceability Matrix

| FR | AC | Tasks | Tests |
|----|-----|-------|-------|
| FR-001 | AC-001, AC-002, AC-003 | T1 | setup-runner verification (3) |
| FR-002 | AC-004, AC-005, AC-006 | T2 | ci.yml migration (3) |
| FR-003 | AC-007, AC-008, AC-009, AC-010 | T3 | deploy.yml migration (4) |
| FR-004 | AC-011, AC-012, AC-013 | T4 | auto-deploy removal (3) |
| FR-005 | AC-014, AC-015, AC-022 | T5, T6 | createBot extraction (4), framework setup/teardown (8) |
| FR-006 | AC-018, AC-019, AC-020, AC-021 | T6 | framework E2E (8) |
| FR-007 | AC-023 to AC-031 | T7 | suite E2E (9) |
| FR-008 | AC-032, AC-033, AC-034, AC-035 | T8 | CI integration (4) |
| FR-009 | AC-036, AC-037, AC-038, AC-039 | T6, T9 | isolation tests (4) |
| FR-010 | AC-040, AC-041, AC-042 | T10 | natif bun test + CI checks (3) |

| EC | Tasks | Tests |
|----|-------|-------|
| EC-001 | T1 | runner offline → jobs en file (verification manuelle) |
| EC-002 | T6 | bot test ne demarre pas → fail fast |
| EC-003 | T6 | rate limit (N/A avec handleUpdate) |
| EC-004 | T6, T7 | Supabase timeout → test skipped |
| EC-005 | T6, T7 | timeout reponse bot → test failed avec temps |
| EC-006 | T9 | cleanup echoue → warning, pas de blocage |
| EC-007 | T9 | deux runs paralleles → prefixes uniques |
| EC-008 | T6 | messages non-test (N/A avec handleUpdate) |
| EC-009 | T6 | stale updates (N/A avec handleUpdate) |
| EC-010 | T8 | deploy + E2E concurrence → runner sequentiel |

| SC | Task | Verification |
|----|------|-------------|
| SC-001 | T1 | runner "online" dans GitHub |
| SC-002 | T10 | 749+ tests passent sur le runner |
| SC-003 | T3 | deploy local sans SSH |
| SC-004 | T3 | smoke test + rollback fonctionnels |
| SC-005 | T4 | auto-deploy.sh et PM2 service supprimes |
| SC-006 | T10 | 8+ tests E2E passent en CI |
| SC-007 | T6 | bot setup/teardown < 30s |
| SC-008 | T10 | suite E2E < 3 minutes |
| SC-009 | T10 | zero donnees residuelles |
| SC-010 | T10 | regression intentionnelle detectee |
| SC-011 | T8, T10 | plan de test validable avant merge |


## Estimates Summary

| Task | Estimate | Cumulative |
|------|----------|------------|
| T1 Runner installation | 1h | 1h |
| T2 CI migration | 1h | 2h |
| T3 Deploy migration | 1.5h | 3.5h |
| T4 Retrait auto-deploy | 0.5h | 4h |
| T5 Extraction createBot | 2h | 6h |
| T6 Framework E2E | 3h | 9h |
| T7 Suite E2E | 2.5h | 11.5h |
| T8 Integration CI | 1h | 12.5h |
| T9 Isolation donnees | 1h | 13.5h |
| T10 Verification + docs | 2h | 15.5h |
| **Total** | **15.5h** | |

Note : T1 et T5 sont parallelisables (aucune dependance mutuelle). Chemin critique : T5 → T6 → T7 → T8 → T10 = 10.5h.


## Notes d'implementation

1. **Approche handleUpdate (revision Gate 2)** : Le framework E2E n'utilise PAS l'API Telegram externe. Il injecte des updates synthetiques via bot.handleUpdate(). Cela simplifie FR-005 (plus besoin de bot @BotFather ni de token test) et FR-008 (plus besoin de secrets Telegram en CI). Les AC-014 (token test), AC-016 (deleteWebhook), AC-017 (ignore unknown users) sont adaptes pour l'approche handleUpdate.

2. **Extraction createBot()** : relay.ts fait ~3200 lignes avec tout dans le scope global. L'extraction de createBot() est le prerequis critique pour les E2E. Le guard import.meta.main protege le code d'initialisation (Supabase, PID, queue, bot.start). Les handlers sont enregistres dans createBot(), le reste est dans le scope main.

3. **Partie A (T1-T4) est infrastructure** : T1 et T3 necessitent des verifications manuelles sur le serveur. T2 et T4 sont des modifications de fichiers de config. La partie A peut etre terminee independamment de la partie B.

4. **Secrets Supabase en CI** : SUPABASE_URL et SUPABASE_ANON_KEY doivent etre configures dans les secrets GitHub pour le job E2E. Le runner self-hosted a deja acces au .env local, mais le job CI utilise le workspace runner (pas /home/edouard/claude-telegram-relay).
