# SDD Spec — S30 CI/CD & E2E Testing

## Overview

Mettre en place un pipeline CI/CD fiable et des tests end-to-end sur les commandes Telegram. Deux axes : (1) un self-hosted GitHub Actions runner sur le serveur pour resoudre le probleme de deploy SSH bloque par le pare-feu, (2) un bot Telegram de test dedie avec un framework E2E pour valider les commandes avant merge.

Contexte : les tests actuels (749) sont 100% unitaires avec mocks. Le deploy GitHub Actions echoue systematiquement (timeout SSH, pare-feu). Le plan de test des PR ne peut etre valide qu'apres merge+deploy, ce qui est incoherent. Le service auto-deploy.sh (polling 60s) est un mecanisme redondant une fois le runner en place.


## User Stories

US-001: As a developer, I want GitHub Actions CI/CD to run directly on my server so that deploys no longer fail due to SSH firewall restrictions.

US-002: As a developer, I want to validate Telegram bot commands before merging a PR so that I can catch regressions pre-merge instead of post-deploy.

US-003: As a developer, I want E2E tests to run automatically in CI on every PR so that regressions are caught without manual testing.

US-004: As a developer, I want test data isolated from production data so that E2E tests never pollute the production environment.

US-005: As a developer, I want clear E2E test results in the PR checks so that I can quickly identify what failed and why.


## Functional Requirements

FR-001: Self-hosted GitHub Actions runner
  Installer et configurer un runner GitHub Actions directement sur le serveur de production. Le runner initie des connexions sortantes vers GitHub (HTTPS port 443), contournant les restrictions de pare-feu.
  Acceptance Criteria:
  - AC-001: GIVEN the server WHEN the runner service starts THEN it connects to GitHub and appears as "online" in the repository's runner settings
  - AC-002: GIVEN a push to any branch WHEN a CI workflow triggers THEN the job runs on the self-hosted runner (not GitHub-hosted)
  - AC-003: GIVEN the runner service WHEN it is configured as systemd THEN it starts automatically on server reboot

FR-002: Migration CI workflow vers self-hosted
  Adapter ci.yml pour utiliser le runner local au lieu de ubuntu-latest.
  Acceptance Criteria:
  - AC-004: GIVEN ci.yml WHEN runs-on is set to [self-hosted, linux] THEN all existing tests (749+) pass on the runner
  - AC-005: GIVEN the runner WHEN bun is already installed locally THEN the setup-bun step is skipped or optional
  - AC-006: GIVEN a PR WHEN CI runs THEN the check status is reported back to GitHub (pass/fail)

FR-003: Migration deploy workflow vers self-hosted
  Adapter deploy.yml pour deployer localement (cd + git pull + pm2 restart) au lieu de SSH distant.
  Acceptance Criteria:
  - AC-007: GIVEN a push to master WHEN the deploy job runs THEN it executes: git pull, bun install, pm2 restart on the local server
  - AC-008: GIVEN the deploy completes WHEN smoke tests run THEN bun run smoke validates the deployment
  - AC-009: GIVEN smoke tests fail WHEN the rollback step triggers THEN scripts/rollback.sh reverts to the previous commit
  - AC-010: GIVEN the migration is complete WHEN the old SSH secrets are checked THEN SERVER_HOST, SERVER_USER, DEPLOY_SSH_KEY, SERVER_PORT are removed from GitHub secrets

FR-004: Suppression auto-deploy.sh
  Retirer le mecanisme de polling redondant une fois le runner en place.
  Acceptance Criteria:
  - AC-011: GIVEN the runner handles deploys WHEN auto-deploy.sh is removed THEN scripts/auto-deploy.sh no longer exists
  - AC-012: GIVEN ecosystem.config.cjs WHEN the claude-autodeploy entry is removed THEN PM2 no longer manages an autodeploy service
  - AC-013: GIVEN CLAUDE.md WHEN the documentation is updated THEN references to auto-deploy and claude-autodeploy are removed or updated

FR-005: Bot de test Telegram dedie
  Un second bot Telegram avec un token separe, utilise exclusivement pour les tests E2E.
  Acceptance Criteria:
  - AC-014: GIVEN a test bot created via @BotFather WHEN its token is stored in GitHub secrets as TELEGRAM_BOT_TOKEN_TEST THEN the E2E framework can authenticate with it
  - AC-015: GIVEN the test bot starts WHEN RELAY_DIR is set to ~/.claude-relay-test THEN it uses an isolated directory (no collision with production flock, session, queue)
  - AC-016: GIVEN the test bot starts WHEN it initializes THEN it calls deleteWebhook and flushes pending getUpdates to avoid stale messages
  - AC-017: GIVEN the test bot WHEN it receives messages from unknown users THEN it ignores them (only responds to TELEGRAM_USER_ID_TEST)

FR-006: Framework de tests E2E
  Un framework TypeScript pour envoyer des commandes Telegram au bot de test et verifier les reponses.
  Acceptance Criteria:
  - AC-018: GIVEN the E2E framework WHEN sendCommand("/help") is called THEN it sends the message via Grammy client to the test bot
  - AC-019: GIVEN a command was sent WHEN waitForReply(timeout) is called THEN it polls getUpdates and returns the bot's response text
  - AC-020: GIVEN a response WHEN assertContains("text") is called THEN it passes if the response contains the text, fails otherwise
  - AC-021: GIVEN the framework WHEN timeout is reached without a response THEN the test fails with a clear timeout error message including elapsed time
  - AC-022: GIVEN the framework WHEN setup() is called THEN the test bot process starts; when teardown() is called THEN it stops cleanly

FR-007: Suite de tests E2E (commandes critiques)
  Tests E2E couvrant les commandes les plus utilisees et risquees.
  Acceptance Criteria:
  - AC-023: GIVEN the test bot is running WHEN /help is sent THEN the response contains "help" or a list of commands
  - AC-024: GIVEN the test bot is running WHEN /status is sent THEN the response contains health information (not an error)
  - AC-025: GIVEN the test bot is running WHEN /feature list is sent THEN the response contains feature flag names
  - AC-026: GIVEN the test bot is running WHEN /task [E2E-<run_id>] Test Title is sent THEN a task is created in Supabase with that title
  - AC-027: GIVEN a test task exists WHEN /backlog is sent THEN the response contains the test task title
  - AC-028: GIVEN the test bot is running WHEN /monitor is sent THEN the response contains monitoring metrics
  - AC-029: GIVEN the test bot is running WHEN /estimate is sent THEN the response contains cost estimation data
  - AC-030: GIVEN the test bot is running WHEN a free-text message is sent THEN the bot responds without crashing
  - AC-031: GIVEN any E2E test WHEN it completes THEN test data created in Supabase is cleaned up

FR-008: Integration CI des tests E2E
  Les tests E2E tournent dans GitHub Actions sur chaque PR, apres les tests unitaires.
  Acceptance Criteria:
  - AC-032: GIVEN ci.yml WHEN the e2e job is defined THEN it depends on the unit test job (needs: [check])
  - AC-033: GIVEN the e2e job WHEN it starts THEN the test bot is launched, tests run, and the bot is stopped within the job
  - AC-034: GIVEN the e2e job WHEN secrets TELEGRAM_BOT_TOKEN_TEST and TELEGRAM_USER_ID_TEST are required THEN they are available in the runner environment
  - AC-035: GIVEN the e2e tests fail WHEN the PR check is reported THEN the PR is blocked (required check)

FR-009: Isolation des donnees de test
  Les tests E2E ne polluent pas les donnees de production dans Supabase.
  Acceptance Criteria:
  - AC-036: GIVEN any entity created by E2E tests WHEN it is inserted in Supabase THEN its title or content contains the prefix [E2E-<run_id>]
  - AC-037: GIVEN two CI runs in parallel (two PRs) WHEN they use different run_ids THEN their test data does not collide
  - AC-038: GIVEN the test suite completes WHEN cleanup runs THEN all rows matching [E2E-*] for the current run_id are deleted
  - AC-039: GIVEN cleanup fails WHEN an error occurs THEN a warning is logged but the CI job is not blocked

FR-010: Rapport E2E dans la PR
  Les resultats des tests E2E sont visibles dans les checks GitHub de la PR.
  Acceptance Criteria:
  - AC-040: GIVEN the e2e job completes WHEN the result is reported to GitHub THEN it shows pass/fail in the PR checks
  - AC-041: GIVEN an E2E test fails WHEN the CI log is inspected THEN it shows: command sent, response received, assertion that failed, elapsed time
  - AC-042: GIVEN the e2e job completes WHEN the total execution time is logged THEN it is displayed per test


## Edge Cases

EC-001: Runner offline — GIVEN the self-hosted runner is offline WHEN a CI job is triggered THEN GitHub queues the job and waits (no silent failure). Expected behavior: job stays queued until runner reconnects.

EC-002: Bot de test ne demarre pas — GIVEN the test bot fails to start (invalid token, port conflict) WHEN the E2E job begins THEN it fails fast with an explicit error message within 10s (no retry loop).

EC-003: Telegram API rate limit — GIVEN the E2E tests send commands too quickly WHEN a 429 response is received THEN wait 1s and retry once. If still 429, mark test as skipped.

EC-004: Supabase timeout pendant un test — GIVEN a Supabase query times out (>10s) WHEN running an E2E test THEN mark the test as skipped (not failed) with a timeout warning.

EC-005: Bot de test met trop de temps a repondre — GIVEN the test bot takes more than 15s to respond WHEN waitForReply timeout is reached THEN mark the test as failed with elapsed time.

EC-006: Cleanup echoue — GIVEN the Supabase cleanup fails (row locked, etc.) WHEN the teardown runs THEN log a warning and continue (do not block CI).

EC-007: Deux CI E2E en parallele — GIVEN two PR CI jobs run E2E simultaneously WHEN they use unique prefixes [E2E-<run_id>] THEN their data does not collide in Supabase.

EC-008: Messages non-test sur le bot de test — GIVEN the test bot receives messages from unknown users (spam) WHEN it processes incoming updates THEN it ignores messages not from TELEGRAM_USER_ID_TEST.

EC-009: Stale getUpdates — GIVEN the test bot starts WHEN there are pending updates from a previous crashed run THEN deleteWebhook + getUpdates with offset flush clears them before tests begin.

EC-010: Deploy et E2E en concurrence — GIVEN a deploy job and an E2E job could run on the same runner WHEN the runner processes one job at a time THEN jobs are queued and executed sequentially (no conflict).


## Success Criteria

SC-001: Self-hosted runner apparait "online" dans GitHub et execute les jobs CI
SC-002: Tous les tests existants (749+) passent sur le runner self-hosted
SC-003: Le deploy sur master s'execute localement sans SSH (git pull + pm2 restart)
SC-004: Le smoke test post-deploy valide le deployment et rollback en cas d'echec
SC-005: auto-deploy.sh et le service PM2 claude-autodeploy sont supprimes
SC-006: 8+ tests E2E passent en CI sur une PR
SC-007: Le bot de test demarre et s'arrete en moins de 30s
SC-008: Suite E2E complete en moins de 3 minutes
SC-009: Zero donnees de test residuelles dans Supabase apres un run
SC-010: Les tests E2E detectent une regression introduite intentionnellement
SC-011: Le plan de test des PR peut etre valide avant merge grace aux E2E


## Out of Scope

- Playwright pour le dashboard (futur, si besoin)
- Environnement staging complet (Docker, second serveur)
- Tests E2E des commandes vocales
- Tests E2E du pipeline /orchestrate ou /autopipeline (trop long, trop couteux en tokens)
- Multi-runner ou runner distribue
- Dashboard de monitoring des runs E2E


## Dependencies

- S29 production readiness (smoke tests, rollback) — deja merge
- Bot de test a creer via @BotFather (action manuelle)
- Secrets GitHub a configurer (TELEGRAM_BOT_TOKEN_TEST, TELEGRAM_USER_ID_TEST)
- Grammy deja present dans les dependances (utilise par relay.ts)


## Architecture Decisions

AD-001: Self-hosted runner avec systemd (pas PM2)
  Rationale: Le runner est de l'infrastructure systeme, pas un service applicatif. systemd garantit le redemarrage automatique au boot et la gestion propre du processus. PM2 est reserve aux services applicatifs (relay, dashboard).

AD-002: Grammy comme client E2E (pas HTTP brut)
  Rationale: Le projet utilise deja Grammy pour le bot. Reutiliser la meme lib pour le client de test reduit le code a maintenir et garantit la compatibilite des types.

AD-003: Supabase partage avec tags de test (pas de schema separe)
  Rationale: Un schema separe necessiterait de dupliquer les migrations et les Edge Functions. Le prefixe [E2E-<run_id>] est simple, identifiable, et le cleanup par tag est fiable. Le risque residuel (affichage temporaire dans /backlog) est mineur.

AD-004: Tests E2E sequentiels (pas paralleles)
  Rationale: Les tests sequentiels evitent les race conditions Telegram, le rate limiting, et simplifient le debugging. La suite complete vise < 3 min, pas besoin de parallelisme.

AD-005: Bot demarre/arrete dans le job CI (pas de service permanent)
  Rationale: Zero cout d'infrastructure supplementaire. Pas de service a maintenir. Le bot n'existe que pendant le run E2E (quelques minutes).

AD-006: Prefixe unique par CI run [E2E-<run_id>]
  Rationale: Permet les PRs en parallele sans collision de donnees dans Supabase. Le run_id (GITHUB_RUN_ID) est unique par execution.


## Test Plan

Derived from acceptance criteria and edge cases above.

Unit Tests:
- [ ] AC-004: ci.yml uses runs-on: [self-hosted, linux]
- [ ] AC-005: setup-bun step is skipped when bun is present
- [ ] AC-011: auto-deploy.sh no longer exists
- [ ] AC-012: ecosystem.config.cjs has no claude-autodeploy entry
- [ ] AC-015: RELAY_DIR isolation (test bot uses ~/.claude-relay-test)
- [ ] AC-016: deleteWebhook + flush getUpdates on bot start (EC-009)
- [ ] AC-017: test bot ignores unknown users (EC-008)
- [ ] AC-018: sendCommand sends message via Grammy client
- [ ] AC-019: waitForReply returns bot response within timeout
- [ ] AC-020: assertContains validates response text
- [ ] AC-021: waitForReply fails with timeout error after configured delay (EC-005)
- [ ] AC-031: cleanup deletes test data from Supabase
- [ ] AC-036: test entities have [E2E-<run_id>] prefix
- [ ] AC-037: parallel runs with different run_ids don't collide (EC-007)
- [ ] AC-038: cleanup removes all rows matching current run_id
- [ ] AC-039: cleanup failure logs warning without blocking (EC-006)
- [ ] EC-003: Telegram 429 triggers wait and retry

Integration Tests:
- [ ] AC-001: runner connects to GitHub and appears online
- [ ] AC-002: CI job runs on self-hosted runner
- [ ] AC-006: CI check status reported to GitHub
- [ ] AC-007: deploy job executes git pull + pm2 restart locally
- [ ] AC-008: smoke test validates deployment
- [ ] AC-009: rollback triggers on smoke failure
- [ ] AC-032: e2e job depends on unit test job
- [ ] AC-033: test bot starts, tests run, bot stops within CI job
- [ ] AC-040: e2e result reported as pass/fail in PR checks

Acceptance Tests (E2E):
- [ ] AC-023: /help returns command list
- [ ] AC-024: /status returns health info
- [ ] AC-025: /feature list returns feature flags
- [ ] AC-026: /task creates task in Supabase
- [ ] AC-027: /backlog shows test task
- [ ] AC-028: /monitor returns metrics
- [ ] AC-029: /estimate returns cost data
- [ ] AC-030: free-text message gets a response
- [ ] SC-010: E2E detects intentional regression

Adversarial Verification:
- [ ] Spec vs implementation drift check
- [ ] All FR-XXX traceable to code
- [ ] All AC-XXX traceable to tests
