# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Bug Fixes

- Remove jq dependency from wait-ci.sh, use plain text gh output([8548b9e](https://github.com/EdouardZemb/claude-telegram-relay/commit/8548b9e4dd746e536195aba11b0699e867e54faf))
- Deep clone default prefs to prevent test pollution, fix gh pr checks fields([ae0f463](https://github.com/EdouardZemb/claude-telegram-relay/commit/ae0f463972dff463aa1988161d126e9decbbc663))
- CI reliability — mkdir in saveQueue, test env setup, CI verification script([04e2ee2](https://github.com/EdouardZemb/claude-telegram-relay/commit/04e2ee22c35c745fd3f39c86ee7b671d576932c3))
- *(tests)* Set env vars before notifications module import([289c073](https://github.com/EdouardZemb/claude-telegram-relay/commit/289c073894e11a1e49d63af2444e6c2fa48b8d68))
- *(S18-03)* Add error logging to unguarded Supabase operations([487720e](https://github.com/EdouardZemb/claude-telegram-relay/commit/487720e55dd008c3372e15cbf832205758464b10))
- *(S17-02)* Fix null date and multiline regex bugs([63c084c](https://github.com/EdouardZemb/claude-telegram-relay/commit/63c084c8053438725478205ca7a62de6c5c13fa6))
- Include task priority in BMad exec prompt([cab93f8](https://github.com/EdouardZemb/claude-telegram-relay/commit/cab93f8870bd568b64ee33d34f10ad7e8f73ff85))
- Prevent relay crash loop from CLAUDECODE env var and unhandled errors([4ae5043](https://github.com/EdouardZemb/claude-telegram-relay/commit/4ae504333b384097a742d2be3bf03e3c90ef7712))
- Add -R flag to gh CLI commands in agent.ts([7b2deed](https://github.com/EdouardZemb/claude-telegram-relay/commit/7b2deedc254ab21b5ad1b52d433c1f049335a9c3))

### CI/CD

- *(S18-12)* Add test count verification step to CI pipeline([ea86447](https://github.com/EdouardZemb/claude-telegram-relay/commit/ea86447e8ceadd45ddb9fd04f12a60dbeba9079a))

### Database

- *(S19-01/03)* Sync db/schema.sql with live database([5666e8e](https://github.com/EdouardZemb/claude-telegram-relay/commit/5666e8ee48bc9270288f3ca81310e24b08ad50a2))

### Documentation

- *(S18-09)* Document dashboard and metrics system([ba58243](https://github.com/EdouardZemb/claude-telegram-relay/commit/ba582436af0a11b370794ba1294c9310764af8c9))
- *(S18-08)* Document configuration (env vars, workflow, BMad templates, PM2)([14f8be7](https://github.com/EdouardZemb/claude-telegram-relay/commit/14f8be7cf16278f87041d58222a2f9dc973adc8b))
- *(S18-07)* Document BMad workflow system([9aa6d46](https://github.com/EdouardZemb/claude-telegram-relay/commit/9aa6d468f9f5da1234942b7885600213085c5983))
- *(S18-06)* Create CHANGELOG.md with full sprint history S01-S18([f244e0d](https://github.com/EdouardZemb/claude-telegram-relay/commit/f244e0d609ee62a595f2e7b0282f78d2dcc97918))
- *(S18-05)* Update README with S15-S17 features([3768b71](https://github.com/EdouardZemb/claude-telegram-relay/commit/3768b71ddeb67a9457503da65b1dcea5dd70aef1))
- *(S18-04)* Restructure CLAUDE.md with architecture + setup guide([9e61800](https://github.com/EdouardZemb/claude-telegram-relay/commit/9e618009241f8141b073b826acefc49d05476178))
- *(S18-02)* Replace outdated example schema with pointer to db/schema.sql([3f69a5e](https://github.com/EdouardZemb/claude-telegram-relay/commit/3f69a5eeabef9709182b3ac287041eb76d9905be))

### Features

- Add smart notifications with batching queue, quiet hours, and inline buttons([4ac6e95](https://github.com/EdouardZemb/claude-telegram-relay/commit/4ac6e958101d2bd7edfcd18cd77961bd49b0dc36))
- Add parallel execution with DAG scheduling, fan-out agents, and worktree isolation([5505735](https://github.com/EdouardZemb/claude-telegram-relay/commit/5505735b71835cee037ee6a055350cc1083f516f))
- Add gated blackboard with adversarial evaluation for SDD workflow([029bb80](https://github.com/EdouardZemb/claude-telegram-relay/commit/029bb8082c1b2595eb5ca7fc2c8f1c9f02ba4a84))
- Add memory evolution with importance scoring, cost tracking, and workflow enforcement([89d5517](https://github.com/EdouardZemb/claude-telegram-relay/commit/89d5517c1d9170fbca1ce8d452383143f253a9fb))
- Add orchestration intelligence with structured messaging, retries, and dynamic pipelines([73725ee](https://github.com/EdouardZemb/claude-telegram-relay/commit/73725eee381ff8f338f95fc1740230fcb450409e))
- Add ideas pipeline with semantic deduplication and full lifecycle([7f6883a](https://github.com/EdouardZemb/claude-telegram-relay/commit/7f6883a12da7da39634c36e8b732702800135ec3))
- Add autonomy scanner for proactive task creation([05d46ef](https://github.com/EdouardZemb/claude-telegram-relay/commit/05d46ef26f282dbca65e8b6aeabc56decadc610c))
- *(S20)* Open Brain — intelligent memory system([58a3230](https://github.com/EdouardZemb/claude-telegram-relay/commit/58a32305e5dbf51546c101779302d89d1ce97336))
- *(S19-10/12)* Wire autopipeline analysis into dev agent, update tests([f371dac](https://github.com/EdouardZemb/claude-telegram-relay/commit/f371dace43a0e7ea9cee4a19a5e6366cbbf25a05))
- *(S19-07/08/09)* Strengthen gates, persist overrides, add code review dashboard([9e7900b](https://github.com/EdouardZemb/claude-telegram-relay/commit/9e7900b65db90a2277acfaf7a0e4225e98740823))
- *(S19-04/05/06)* Wire story files into /exec, /orchestrate, and /plan([5396e58](https://github.com/EdouardZemb/claude-telegram-relay/commit/5396e58709ea255bb130f5168561c93a40ba741a))
- *(S17-10)* Enrich dynamic profile with communication and workflow data([e483a17](https://github.com/EdouardZemb/claude-telegram-relay/commit/e483a17c8fdfdad0eeea1d3869b6ca8c465f023c))
- *(S17-08)* Add intelligent context cache for document sharding([2ccd4c4](https://github.com/EdouardZemb/claude-telegram-relay/commit/2ccd4c4348c93ae8d7ceded1844e8a19eef99675))
- *(S17-07)* Complete feedback loop retros -> agent prompts([3d8ded7](https://github.com/EdouardZemb/claude-telegram-relay/commit/3d8ded73aa1ea6954e4dd06f2b404f6153929e30))
- *(S17-06)* Add real-time sprint progress bar to dashboard([6310c94](https://github.com/EdouardZemb/claude-telegram-relay/commit/6310c9499907f4d152d56ae5a43620ac060b8107))
- *(S17-05)* Activate BMad gates with PRD and audit trail([d3f3284](https://github.com/EdouardZemb/claude-telegram-relay/commit/d3f328472a6d3f229a2de2bdf6bf2e41c183e0ed))
- *(S17-01)* Activate feedback loop from retros([d960a8f](https://github.com/EdouardZemb/claude-telegram-relay/commit/d960a8fbb1367500a2f632191102b28daa9f1784))
- *(S16-10)* Proactive backlog planning and recommendations([8b27b8b](https://github.com/EdouardZemb/claude-telegram-relay/commit/8b27b8b940ed52b89ea8b7c3e147da3a4b89f1a4))
- *(S16-09)* Automated BMad pipeline end-to-end([c790797](https://github.com/EdouardZemb/claude-telegram-relay/commit/c79079729265e5f6a0de385c87a4f2137a3281fb))
- *(S16-08)* Extend sharding to retros, memory facts, and analyses([c2c9623](https://github.com/EdouardZemb/claude-telegram-relay/commit/c2c9623b520ae9157b5b501658412f169c926c52))
- *(S16-07)* Enhanced proactive alerts for QA agent([61cec5f](https://github.com/EdouardZemb/claude-telegram-relay/commit/61cec5fa35bc4c7c1045df9cb3213d176509c0d1))
- *(S16-06)* Agent metrics dashboard endpoints([36f153d](https://github.com/EdouardZemb/claude-telegram-relay/commit/36f153d5121aca1de4d8e04ca2cc7427fbee4dad))
- *(S16-05)* Workflow audit trail with diff tracking([a53b877](https://github.com/EdouardZemb/claude-telegram-relay/commit/a53b877842bab47b170cfab4fd444d8b438b1fb2))
- *(S16-03)* Feedback loop from retros to agent prompts([3f658e7](https://github.com/EdouardZemb/claude-telegram-relay/commit/3f658e75c0fc11a70a80b8e44174061b0d7dab15))
- *(S16-02)* Atomic story files for structured task execution([7d0a303](https://github.com/EdouardZemb/claude-telegram-relay/commit/7d0a303104b493d63b501ac8f40edd0426fd665d))
- *(S16-01)* Multi-agent orchestration framework([6574b95](https://github.com/EdouardZemb/claude-telegram-relay/commit/6574b95473cbd45cdf8163c0c513c32d53b6a1f8))
- *(S15-11)* Refonte complete README([3582d49](https://github.com/EdouardZemb/claude-telegram-relay/commit/3582d4955b2867edcf5c2a45080465aec1a67f26))
- *(S15-09/10)* Cross-project workflow propagation + voting([524bf15](https://github.com/EdouardZemb/claude-telegram-relay/commit/524bf15ac1acb1c7066114bc04c8db629ef119ce))
- *(S15-07/08)* Adversarial code review + Gate 3 pre-merge([b2b0ff5](https://github.com/EdouardZemb/claude-telegram-relay/commit/b2b0ff5db83208f95c48ec02c5e1a708918b3265))
- *(S15-06)* Refonte UX commandes Telegram + /workflow([6f4b7d8](https://github.com/EdouardZemb/claude-telegram-relay/commit/6f4b7d8897d9a3ecf508b4878ccfaf56ac0a1231))
- *(S15-03/04/05)* YAML-powered agent prompts, routing, isolation([ac9296d](https://github.com/EdouardZemb/claude-telegram-relay/commit/ac9296d51b1f34eb659c69852075d26d26a2c42e))
- *(S15-01/02)* Document sharding + cross-references([2413f20](https://github.com/EdouardZemb/claude-telegram-relay/commit/2413f207f9bc1c34c9132210ba4d7e804afcd212))
- *(S14-11)* Tests unitaires BMad agents, gates et projects([56ccec0](https://github.com/EdouardZemb/claude-telegram-relay/commit/56ccec0e8b4910e2106fb39b204ceda710b7cd47))
- *(S14-10)* Dashboard multi-projets([7fbdf23](https://github.com/EdouardZemb/claude-telegram-relay/commit/7fbdf2342fbe14620c7f00e0e0ae26048e495d40))
- *(S14-09)* Scope commandes existantes par projet([c52ce53](https://github.com/EdouardZemb/claude-telegram-relay/commit/c52ce53a444811299d968d3e3efa36f86b39da55))
- *(S14-08)* Commandes /project et /projects([364b0ef](https://github.com/EdouardZemb/claude-telegram-relay/commit/364b0ef17d848f26161939932cc391ddfdd53222))
- *(S14-05)* Schema multi-projet DB et module projects([599eacb](https://github.com/EdouardZemb/claude-telegram-relay/commit/599eacb40b6795128822334b4f502fd6843f6def))
- *(S14-04)* Story files atomiques BMad([c85be12](https://github.com/EdouardZemb/claude-telegram-relay/commit/c85be12d64431dbb749dbbdeb15a66d20e98b64f))
- *(S14-03)* Implementer les gates strictes BMad([659e12d](https://github.com/EdouardZemb/claude-telegram-relay/commit/659e12d2b681ea4ddd557c8b2e9e9ab7ef51dcdb))
- *(S14-02)* Adapter les agents BMad au contexte Telegram([bcb8851](https://github.com/EdouardZemb/claude-telegram-relay/commit/bcb8851d2f0cb7aa5e8c21cdb7117340fde12c23))
- *(S14-01)* Copier BMad Method v6 dans config/bmad-templates/([81468b6](https://github.com/EdouardZemb/claude-telegram-relay/commit/81468b673d08fff8c5c204c29c14f7037ef2ceaf))
- S13 - intelligence reflexive complete, tests systeme, alertes proactives([25787dc](https://github.com/EdouardZemb/claude-telegram-relay/commit/25787dcfc173afaef798c5cfd149c832f6cd13f3))
- S12 - intelligence reflexive, tests, suppression timeout([cc7f8ce](https://github.com/EdouardZemb/claude-telegram-relay/commit/cc7f8ce76cbbb27b7a172ed804e936d49b73dcf8))
- S11 - amelioration continue, workflow configurable, metriques et retros([a8a3aff](https://github.com/EdouardZemb/claude-telegram-relay/commit/a8a3aff15c0b00261981f0883ef89b3cfd4d6ebf))
- S10 - stabilisation, securite et resilience([4060e4f](https://github.com/EdouardZemb/claude-telegram-relay/commit/4060e4f6809a0300472676082417aaf5105d87a4))
- S09 - comprehensive documentation and recovery procedures (#12)([8df4f06](https://github.com/EdouardZemb/claude-telegram-relay/commit/8df4f06d09e638bf12ed6b50aa5326a44453e535))
- S08 - PRD workflow with /prd command, validation buttons, and dashboard view([1e1827c](https://github.com/EdouardZemb/claude-telegram-relay/commit/1e1827cc1be1e0c4f940afd5965749a095c8efd5))
- S07 - CI workflow and CI-aware task execution([a64b624](https://github.com/EdouardZemb/claude-telegram-relay/commit/a64b6245e8b2b56d719592b2f3496892e94ff6ad))
- S06 - proactive notifications per topic and voice+text responses([7f5b0ba](https://github.com/EdouardZemb/claude-telegram-relay/commit/7f5b0ba5f673842171575e36cba35fff6ea1d0b1))
- S06 - proactive notifications per topic and voice+text responses([a461719](https://github.com/EdouardZemb/claude-telegram-relay/commit/a461719a02033264f8efd0d96e889704caa1d11e))
- S05 - CI/CD pipeline, security hardening, system alerts, branch-PR workflow([0c6bc6b](https://github.com/EdouardZemb/claude-telegram-relay/commit/0c6bc6b0f5e2aca9cf767738a3354f3f67c27b71))
- Contextual topics, command guards, dashboard filters, morning briefing([766d343](https://github.com/EdouardZemb/claude-telegram-relay/commit/766d3439b5d5f63049f30f28df5a09b77dc8cfe1))
- Add Telegram forum topics support([577ad73](https://github.com/EdouardZemb/claude-telegram-relay/commit/577ad7368acef7e16fcebded9d02af16a7e489e1))
- Add pull-based auto-deploy for CI/CD([3d2a7f6](https://github.com/EdouardZemb/claude-telegram-relay/commit/3d2a7f63a6026bc8ad2cd4458a41171a1423763f))
- Add agentique workflow, dashboard, TTS and task management([28db1e9](https://github.com/EdouardZemb/claude-telegram-relay/commit/28db1e987f198db0d93042eb32ca457f7dcdf4a8))

### Other

- Merge pull request #32 from EdouardZemb/feature/s25-parallel-execution

feat: S25 parallel execution with DAG scheduling and fan-out agents([8b40a19](https://github.com/EdouardZemb/claude-telegram-relay/commit/8b40a191f4b4bf0f3ef407c69bd91576f80b121a))
- Merge pull request #31 from EdouardZemb/feature/s24-gated-blackboard-sdd

feat: S24 Gated Blackboard & SDD([a0b9ca8](https://github.com/EdouardZemb/claude-telegram-relay/commit/a0b9ca8da3e9b7319f6010763ca21768f75fa638))
- Merge pull request #29 from EdouardZemb/feature/s22-orchestration-intelligence

feat: S22 orchestration intelligence([deb9b3b](https://github.com/EdouardZemb/claude-telegram-relay/commit/deb9b3b49c4021cf8faf96908d63c9491573454e))
- Merge pull request #28 from EdouardZemb/feature/ideas-pipeline

feat: S21 Ideas Pipeline([00d2e6c](https://github.com/EdouardZemb/claude-telegram-relay/commit/00d2e6c1a016452e13dd7bb2e548507c897589cc))
- Merge pull request #26 from EdouardZemb/feature/autonomy-scanner

feat: autonomy scanner — proactive task creation([5ee32f5](https://github.com/EdouardZemb/claude-telegram-relay/commit/5ee32f5848c7803768ee829e1519ceb39c95dba0))
- Merge pull request #25 from EdouardZemb/quick/notifications-tests

test: add unit tests for notifications module([1ba2c69](https://github.com/EdouardZemb/claude-telegram-relay/commit/1ba2c699d2114286ea31c3f5add65eff53146cb9))
- Merge pull request #24 from EdouardZemb/feature/s20-open-brain

feat(S20): Open Brain — intelligent memory system([ff1ba1f](https://github.com/EdouardZemb/claude-telegram-relay/commit/ff1ba1f42334b175c4755f91d6ae5d014abd4f0d))
- Merge pull request #23 from EdouardZemb/feature/s19-phase1-schema-sync

feat(S19): Activation BMad complet - schema sync, gates, story files, autopipeline([6dd8e4b](https://github.com/EdouardZemb/claude-telegram-relay/commit/6dd8e4b203d055e525de05b2019bafbd3790e9b7))
- Merge pull request #22 from EdouardZemb/feature/s18-nettoyage-stabilisation-docs

S18: Nettoyage, Stabilisation et Documentation([30fe5c6](https://github.com/EdouardZemb/claude-telegram-relay/commit/30fe5c64b6f33b4161d2763046a474df5b078f82))
- Merge pull request #21 from EdouardZemb/feature/s17-consolidation-fiabilite

feat(S17): Consolidation et Fiabilite - 8/10 taches([9aed983](https://github.com/EdouardZemb/claude-telegram-relay/commit/9aed9838f80fc8a646c92a9b0de5416a1b42c328))
- Merge pull request #20 from EdouardZemb/feature/s16-orchestration-intelligente

feat(S16): Orchestration Intelligente([2f1a23d](https://github.com/EdouardZemb/claude-telegram-relay/commit/2f1a23d3f3d75b74996943c72ff6a80aa1ec4152))
- Merge pull request #19 from EdouardZemb/feature/s15-bmad-avance

feat(S15): BMad Avance + Qualite + README([d84d94f](https://github.com/EdouardZemb/claude-telegram-relay/commit/d84d94fc379897ae6bff5e989f96f6cc1aa72805))
- Merge pull request #18 from EdouardZemb/feature/s14-bmad-multi-projets

feat: S14 — BMad Method v6 + Multi-Projets([93ee8d0](https://github.com/EdouardZemb/claude-telegram-relay/commit/93ee8d01011b6bfad6a40b493a0f8900692df6cb))
- Merge pull request #17 from EdouardZemb/feature/s13-intelligence-reflexive-complete

feat: S13 - intelligence reflexive complete([f2c25a7](https://github.com/EdouardZemb/claude-telegram-relay/commit/f2c25a74b9907539d2de7e9e330fdb89f460e646))
- Merge pull request #16 from EdouardZemb/feature/s12-intelligence-reflexive

feat: S12 - Intelligence reflexive + tests d'integration([31eaccf](https://github.com/EdouardZemb/claude-telegram-relay/commit/31eaccf1cbcf910d433698ea0673790d00482f12))
- Merge pull request #15 from EdouardZemb/feature/s11-amelioration-continue

feat: S11 - amelioration continue([03035ca](https://github.com/EdouardZemb/claude-telegram-relay/commit/03035ca6fd11f60357a225dd3eec34ed68c2480e))
- Merge pull request #13 from EdouardZemb/feature/s10-stabilisation

feat: S10 - stabilisation, securite et resilience([0ad22a1](https://github.com/EdouardZemb/claude-telegram-relay/commit/0ad22a13181aec4299a66dc2642e5338cfc3f582))
- Merge pull request #11 from EdouardZemb/fix/relay-crash-loop

fix: prevent relay crash loop from CLAUDECODE env var([caa0dc4](https://github.com/EdouardZemb/claude-telegram-relay/commit/caa0dc40b04c69d7e64d40dbc9d1a8d6febd100a))
- Merge pull request #10 from EdouardZemb/feature/s08-prd-workflow

feat: S08 - PRD workflow([1eb9104](https://github.com/EdouardZemb/claude-telegram-relay/commit/1eb9104fa8d8ae3c400f91ac5caef94679260c84))
- Merge pull request #9 from EdouardZemb/feature/s07-fix-gh-repo

fix: add -R flag to gh CLI commands in agent.ts([40928e2](https://github.com/EdouardZemb/claude-telegram-relay/commit/40928e2985f76f8a0047021f863ed7c3d8c5ee47))
- Merge pull request #8 from EdouardZemb/feature/s07-ci-cd

feat: S07 - CI workflow and CI-aware task execution([20e5628](https://github.com/EdouardZemb/claude-telegram-relay/commit/20e5628a7e86a294771b917e3c33f0d6a9e4a44d))
- Merge pull request #7 from EdouardZemb/feature/s06-proactive-notifications

feat: S06 - proactive notifications per topic([cdc77bd](https://github.com/EdouardZemb/claude-telegram-relay/commit/cdc77bde67dcbd411ba8d9b8ecaa6f32cc435cf9))
- Merge pull request #6 from EdouardZemb/feature/s06-proactive-notifications

feat: S06 - proactive notifications per topic([1b484b0](https://github.com/EdouardZemb/claude-telegram-relay/commit/1b484b008338169b9601ff8ae8063f697bbde1d0))
- Merge pull request #5 from EdouardZemb/feature/sprint-s05

Sprint S05: CI/CD, securite, alertes, workflow branche-PR([2e78d9e](https://github.com/EdouardZemb/claude-telegram-relay/commit/2e78d9e549d6b3028ede4db07ce51605125efa75))
- Merge pull request #4 from EdouardZemb/feature/sprint-s04

feat: Sprint S04 - contextual topics, command guards, dashboard([ce062ff](https://github.com/EdouardZemb/claude-telegram-relay/commit/ce062ff3a2f6948c16e840921a4ae2cc3de408af))
- Merge pull request #3 from EdouardZemb/feature/topics-forum

feat: support Topics Forum Telegram([1f372fd](https://github.com/EdouardZemb/claude-telegram-relay/commit/1f372fd793582181a4c853d87e9251703859c840))
- Merge pull request #2 from EdouardZemb/feature/auto-deploy

feat: add pull-based auto-deploy([93f5dab](https://github.com/EdouardZemb/claude-telegram-relay/commit/93f5daba74c67e1f830ab46ee9582cd78693d53a))
- Merge pull request #1 from EdouardZemb/feature/initial-setup

feat: agentique workflow, dashboard, TTS and task management([56520ea](https://github.com/EdouardZemb/claude-telegram-relay/commit/56520ea5b4839e81ffddf1c82561c543a3e5296f))
- Merge pull request #7 from godagoo/develop

Voice transcription options([18f263e](https://github.com/EdouardZemb/claude-telegram-relay/commit/18f263e276959d0ccf322adcc47d4a5577917d3c))
- Update CLAUDE.md and README for voice and memory

CLAUDE.md:
- Phase 2 rewritten: Supabase MCP required (not optional), 5-step setup
  with Edge Function deployment, OpenAI key in Supabase secrets,
  database webhooks for auto-embedding
- Phase 7 rewritten: Groq (recommended) vs local whisper.cpp choice
- Updated Skool URL to skool.com/autonomee

README.md:
- Voice: "Groq cloud or local Whisper" (was "Gemini")
- Memory: "Semantic search over conversation history" (was generic)
- How It Works: describes embedding pipeline and auto-memory
- Project structure: added transcribe.ts, memory.ts, supabase/functions
- Env vars: note that OpenAI key lives in Supabase, not .env
- Updated Skool URL to skool.com/autonomee

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([d6046ec](https://github.com/EdouardZemb/claude-telegram-relay/commit/d6046ecd3e6990c002bef8a24c4b1c139cdc2f4a))
- Wire voice, memory, and Supabase into relay

relay.ts:
- Supabase client init (optional, only if SUPABASE_URL configured)
- saveMessage() logs all messages (text, voice, photo, document) to Supabase
- Voice handler: download OGG → transcribe → Claude → respond
- Semantic context retrieval before every Claude call (getRelevantContext)
- Memory context (facts + goals) included in every prompt
- Memory intent parsing after every Claude response (processMemoryIntents)
- buildPrompt() now includes memory management instructions

package.json:
- Added groq-sdk and @supabase/supabase-js dependencies
- Added test:voice script

.env.example:
- Replaced GEMINI_API_KEY with VOICE_PROVIDER, GROQ_API_KEY, whisper vars
- OpenAI key for embeddings lives in Supabase, not here

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([ff57eeb](https://github.com/EdouardZemb/claude-telegram-relay/commit/ff57eebbf6d324a1a4c68ea95be969be7c55259f))
- Add Supabase memory system with semantic search

Memory module (src/memory.ts):
- Semantic context retrieval via search Edge Function
- Facts and goals from Supabase RPCs (get_facts, get_active_goals)
- Intent parsing: Claude auto-tags [REMEMBER:], [GOAL:], [DONE:] in responses
  Tags are saved to Supabase and stripped before sending to user

Edge Functions (supabase/functions/):
- embed: auto-generates OpenAI embeddings on INSERT via database webhook
- search: generates query embedding + runs match_messages/match_memory RPC
- OpenAI key lives in Supabase secrets, never in the relay .env

Schema (db/schema.sql):
- Added pg_net extension for HTTP calls
- Added match_memory() function for semantic search on memory table
- Updated comments to reflect auto-embedding architecture

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([fced316](https://github.com/EdouardZemb/claude-telegram-relay/commit/fced3162c65657635e97164f7ba4f519e145283a))
- Add voice transcription with Groq and local whisper.cpp

Two provider options controlled by VOICE_PROVIDER env var:
- Groq: Free cloud API (whisper-large-v3-turbo), accepts OGG natively
- Local: whisper.cpp via Bun.spawn, requires ffmpeg for OGG→WAV conversion

Includes test script (bun run test:voice) that verifies the chosen provider:
- Groq: validates API key and model availability
- Local: checks ffmpeg, whisper binary, and model file

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([79e9e3d](https://github.com/EdouardZemb/claude-telegram-relay/commit/79e9e3d235ff8b93e7e9284dd04260e7416a479c))
- Merge pull request #6 from godagoo/develop

Free course release: guided setup + tooling([7836e55](https://github.com/EdouardZemb/claude-telegram-relay/commit/7836e5511de97ff0d8719dc0f540f2348ae82a21))
- Update README for free course release

Complete rewrite reflecting new project structure: guided setup
via CLAUDE.md, setup scripts, test scripts, service configuration,
profile personalization. Includes full course CTA.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([08299ca](https://github.com/EdouardZemb/claude-telegram-relay/commit/08299ca8310d6849d57fe45abdab5c7f7e55bc13))
- Add CLAUDE.md — guided conversational setup

Claude Code reads this automatically when users open the project.
7 phases: Telegram bot, Supabase, personalization, testing,
always-on services, proactive AI, and voice transcription.

References all setup scripts (bun run setup, test:telegram,
test:supabase, setup:launchd, setup:services, setup:verify).

Includes CTA for full course at AI Productivity Hub.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([07fe498](https://github.com/EdouardZemb/claude-telegram-relay/commit/07fe4989575e91e6ae14747449ca4ba8a30d1c66))
- Add setup/verify.ts — full health check

Tests everything in one pass: .env exists, dependencies installed,
Telegram bot token valid, Supabase connection and tables, launchd
services loaded, optional features configured. Reports pass/fail/warn.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([9d84634](https://github.com/EdouardZemb/claude-telegram-relay/commit/9d84634e99245f5931eb161846586d660450ec4d))
- Add automated service configuration (macOS launchd + PM2)

- setup/configure-launchd.ts: auto-generates plist files with correct
  paths, loads them into launchd. Supports relay, checkin, briefing.
  Uses StartCalendarInterval for scheduled services (fires after wake).
- setup/configure-services.ts: PM2-based setup for Windows/Linux.
  Always-on relay via PM2, scheduled services via cron instructions.
- package.json: add setup:launchd and setup:services scripts

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([61b0a91](https://github.com/EdouardZemb/claude-telegram-relay/commit/61b0a915d9978128f8c84298d05963245e5a0370))
- Add profile personalization

- config/profile.example.md: template for user identity, goals, constraints
- relay.ts: loads profile.md at startup, uses USER_NAME and USER_TIMEZONE
  from .env, builds richer prompt with personal context
- .gitignore: exclude config/profile.md (personal data)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([a78cb3f](https://github.com/EdouardZemb/claude-telegram-relay/commit/a78cb3fd4ce36cebdf1b942ac48343191433843e))
- Add test scripts and db/schema.sql

- setup/test-telegram.ts: verifies bot token and user ID by sending
  a test message via Telegram API
- setup/test-supabase.ts: verifies URL and anon key, checks if
  required tables (messages, memory, logs) exist
- db/schema.sql: canonical schema location (copied from examples/)
- package.json: add test:telegram and test:supabase scripts

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([ebf6edd](https://github.com/EdouardZemb/claude-telegram-relay/commit/ebf6edd4ba94e33bf45ca6ec4c1528cb5e497317))
- Add setup/install.ts — prerequisites checker and project bootstrapper

Checks bun and claude CLI, runs bun install, creates required
directories (logs, temp, uploads), copies .env.example to .env.

Also updates .env.example with clearer structure (required vs optional
sections) and adds "setup" script to package.json.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>([9a6ac16](https://github.com/EdouardZemb/claude-telegram-relay/commit/9a6ac164de39588a74f34971337c5502eb552a36))
- Merge pull request #4 from msaelices/project-dir

Add PROJECT_DIR support for Claude CLI working directory([2ac292a](https://github.com/EdouardZemb/claude-telegram-relay/commit/2ac292a3d8aa79f070c64ea09ce2fee2248f2608))
- Add PROJECT_DIR env var for Claude CLI working directory

Allow users to configure a separate project directory where Claude
operates, instead of defaulting to the relay's own directory.([be2513d](https://github.com/EdouardZemb/claude-telegram-relay/commit/be2513d40ce622f6dbf1ae4958a771ef30e43317))
- Fix YouTube channel link in credits([a4a81a6](https://github.com/EdouardZemb/claude-telegram-relay/commit/a4a81a6da3be9a8c4d6da81c2ccade18f38e6c97))
- Initial release: Claude Code Telegram Relay

A minimal pattern for running Claude Code as an always-on Telegram bot.

Features:
- Core relay pattern (Telegram → Claude CLI → response)
- Cross-platform daemon setup (macOS, Linux, Windows)
- Examples: morning briefing, smart check-ins, memory persistence
- Optional Supabase schema for cloud storage

Built by Goda as part of the Personal AI Infrastructure project.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>([7a18b12](https://github.com/EdouardZemb/claude-telegram-relay/commit/7a18b12d67bd17248ac1ff1336f8d59cdf19290e))

### Refactoring

- *(S18-01)* Remove dead code across 5 modules([e32344f](https://github.com/EdouardZemb/claude-telegram-relay/commit/e32344f8fe13fdef4a2ca3a56839f5e5895a19dd))

### Tests

- Add unit tests for notifications module (9 tests)([f0a23b7](https://github.com/EdouardZemb/claude-telegram-relay/commit/f0a23b70e9478b5a0e1f0379e00ccbbaf7bb7218))
- *(S18-11)* Add module integrity tests for anti-regression([b644dad](https://github.com/EdouardZemb/claude-telegram-relay/commit/b644dad28f939f99492a1ff6e521f7ba067c1ae2))
- *(S17-03)* Add unit tests for 5 untested S16 modules([ae76588](https://github.com/EdouardZemb/claude-telegram-relay/commit/ae76588547514027ef822fcdb67eb261c0969c2a))

