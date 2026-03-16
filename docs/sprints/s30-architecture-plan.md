# Architecture Plan — S30 CI/CD & E2E Testing

> Phase 2 du processus SDD. Derive de la spec s30-cicd-e2e-testing.md.
> Gate 1 (spec) validee le 2026-03-16.


## Composants

### 1. Self-Hosted GitHub Actions Runner (systemd) — FR-001

Installation du runner directement sur le serveur de production. Le runner est un binaire GitHub qui initie des connexions HTTPS sortantes vers GitHub (port 443), contournant le pare-feu sans ouvrir de port entrant.

```
Installation:
  Repertoire: /home/edouard/actions-runner/
  Binaire: actions-runner/run.sh
  Service: /etc/systemd/system/github-runner.service

  [Unit]
  Description=GitHub Actions Runner
  After=network.target

  [Service]
  Type=simple
  User=edouard
  WorkingDirectory=/home/edouard/actions-runner
  ExecStart=/home/edouard/actions-runner/run.sh
  Restart=always
  RestartSec=5
  KillSignal=SIGTERM
  TimeoutStopSec=10

  [Install]
  WantedBy=multi-user.target
```

Decisions :
- systemd et pas PM2 (AD-001) : c'est de l'infrastructure systeme, pas un service applicatif
- Un seul runner, jobs en file d'attente (pas de multi-runner, hors scope)
- Labels : `self-hosted`, `linux` (suffisant pour le routing des jobs)
- Le runner travaille dans `_work/` (sous-repertoire dedie), isole du repo principal


### 2. CI Workflow migre — FR-002

Modifications de `.github/workflows/ci.yml` :

```yaml
# AVANT
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2   # plus necessaire
      # ...

# APRES
jobs:
  check:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4
      # setup-bun supprime (deja installe)
      - name: Install dependencies
        run: bun install --frozen-lockfile
      # reste identique...
```

Le runner a deja bun, git, node installe localement. `actions/checkout@v4` est conserve car il gere le checkout propre du repo dans le workspace du runner (plus propre qu'un cd + git pull).

Point d'attention : le runner execute les steps dans `_work/claude-telegram-relay/claude-telegram-relay/`. Les paths absolus dans les tests doivent etre relatifs ou configures via env.


### 3. Deploy Workflow migre — FR-003

Modifications de `.github/workflows/deploy.yml` :

```yaml
# AVANT
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          # ...

# APRES
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    steps:
      - name: Deploy to production
        run: |
          cd /home/edouard/claude-telegram-relay
          git fetch origin master
          git checkout master
          git pull origin master

          if git diff --name-only HEAD~1 HEAD | grep -q "package.json"; then
            bun install
          fi

          npx pm2 restart claude-relay --update-env
          npx pm2 restart claude-dashboard --update-env

          sleep 5

          COMMIT=$(git log --oneline -1)

          if bun run smoke; then
            echo "Deploy complete: $COMMIT (smoke test OK)"
            bash scripts/notify-deploy.sh "success" "$COMMIT"
            bun run scripts/generate-checklist.ts 2>/dev/null || true
          else
            echo "SMOKE TEST FAILED — rolling back"
            bash scripts/notify-deploy.sh "failure" "Smoke test failed for $COMMIT — auto-rollback"
            bash scripts/rollback.sh "smoke test failed after deploy"
            exit 1
          fi
```

Differences majeures vs l'ancien deploy.yml :
- `runs-on: [self-hosted, linux]` au lieu de `ubuntu-latest`
- Plus de `appleboy/ssh-action` — execution directe sur le serveur
- `cd /home/edouard/claude-telegram-relay` en debut de script (le deploy travaille sur le repo reel, pas le workspace runner)
- Tout le reste est identique (smoke, rollback, notify)


### 4. Suppression auto-deploy.sh — FR-004

Fichiers a supprimer ou modifier :

```
scripts/auto-deploy.sh           -> SUPPRIMER
ecosystem.config.cjs             -> Retirer l'entree claude-autodeploy
CLAUDE.md                        -> Retirer references auto-deploy et claude-autodeploy
```

Sur le serveur (action manuelle ou script) :
```bash
pm2 delete claude-autodeploy
pm2 save
```


### 5. Bot de test Telegram — FR-005

Un second bot Telegram utilise exclusivement pour les tests E2E. Pas un nouveau module source — c'est le meme code relay.ts lance avec des variables d'environnement differentes.

```
Configuration E2E:
  TELEGRAM_BOT_TOKEN  = $TELEGRAM_BOT_TOKEN_TEST  (token du bot test)
  TELEGRAM_USER_ID    = $TELEGRAM_USER_ID_TEST     (ID du compte qui envoie les commandes)
  RELAY_DIR           = /tmp/claude-relay-e2e-$GITHUB_RUN_ID
  SUPABASE_URL        = (meme que prod)
  SUPABASE_ANON_KEY   = (meme que prod)
```

Demarrage dans le job CI :
```
bun run src/relay.ts &
BOT_PID=$!
sleep 5  # attendre que le bot soit pret
# ... tests E2E ...
kill $BOT_PID
```

Isolation :
- RELAY_DIR dans /tmp avec run_id unique -> pas de collision flock, session, queue
- Le bot test utilise le long polling (comme le bot prod), pas de webhook
- Au demarrage : appel deleteWebhook + getUpdates avec offset -1 pour flush (EC-009)
- Le bot test ignore les messages qui ne viennent pas de TELEGRAM_USER_ID_TEST (AC-017, EC-008)

Decision : le bot test est le meme binaire que le bot prod, avec des env vars differentes. Pas de code specifique au test dans relay.ts. La seule difference est le token et le RELAY_DIR.


### 6. Framework E2E — FR-006

Nouveau fichier `tests/e2e/framework.ts`. Client Grammy qui envoie des commandes au bot test et verifie les reponses.

```
Architecture:

  tests/e2e/
    framework.ts        Helpers: sendCommand, waitForReply, assertContains, setup, teardown, cleanup
    e2e.test.ts         Suite de tests (8+ commandes)
    README.md           PAS de README (hors scope)

Interfaces:

  E2EConfig {
    botToken: string          // TELEGRAM_BOT_TOKEN_TEST
    userId: number            // TELEGRAM_USER_ID_TEST
    runId: string             // GITHUB_RUN_ID ou generateur local
    commandTimeout: number    // defaut 15000ms
    supabaseUrl: string
    supabaseKey: string
  }

  E2EFramework {
    setup(): Promise<void>
      // 1. Lance le bot test en subprocess (bun run src/relay.ts)
      // 2. Attends 5s que le bot demarre
      // 3. Initialise le client Grammy test (Bot instance en mode user)
      // 4. Flush getUpdates

    sendCommand(command: string): Promise<string>
      // 1. Envoie le message via Telegram API (bot.api.sendMessage)
      // NON — le client E2E doit envoyer comme un USER, pas comme un bot.
      // Utilise l'API Telegram directement (fetch POST /sendMessage avec le token USER)
      // PROBLEME : on ne peut pas envoyer comme un user avec un token bot.

      // SOLUTION REVISEE : on utilise un second bot pour envoyer les messages.
      // NON — deux bots ne peuvent pas communiquer naturellement.

      // SOLUTION FINALE : on utilise le MTProto user API via Grammy.
      // NON — Grammy est un framework bot, pas un client user.

      // SOLUTION PRAGMATIQUE (retenue) :
      // Le framework envoie les messages via l'API Telegram Bot standard.
      // Mais on a besoin d'un "client" qui envoie des messages AU bot de test.
      // Deux approches possibles :
      //
      // A) Utiliser un compte utilisateur Telegram (Telethon/GramJS) pour envoyer
      //    des messages au bot de test. Complexe, necessite phone + session.
      //
      // B) Appeler directement les handlers du bot en memoire, sans passer par
      //    Telegram. Plus simple, mais ne teste pas le transport Telegram.
      //
      // C) Utiliser le webhook simulation : injecter un Update JSON dans le
      //    handler du bot via bot.handleUpdate(). Teste le routing complet
      //    sans passer par l'API Telegram externe.
      //
      // Decision retenue : OPTION C (bot.handleUpdate)
      // Rationale : teste toute la logique du bot (routing, handlers, Supabase)
      // sans dependance externe (pas de compte user, pas de rate limit Telegram,
      // pas de latence reseau). Le seul aspect non teste est le transport
      // Telegram lui-meme, mais c'est la responsabilite de Grammy, pas la notre.

    waitForReply(timeout?: number): Promise<string>
      // Avec handleUpdate, la reponse est capturee via un mock de ctx.reply()
      // Le mock collecte les appels et renvoie le texte

    assertContains(response: string, expected: string): void
    assertNotContains(response: string, unexpected: string): void

    cleanup(): Promise<void>
      // Supprime toutes les lignes Supabase avec prefix [E2E-<runId>]
      // Tables: tasks, memory, messages, logs
      // Log warning si echec, ne throw pas

    teardown(): Promise<void>
      // 1. cleanup()
      // 2. Arrete le subprocess du bot test
  }
```

REVISION ARCHITECTURALE — Approche handleUpdate :

Apres reflexion, l'approche subprocess + API Telegram externe a un probleme fondamental : pour envoyer un message AU bot de test via l'API Telegram, il faut un compte utilisateur Telegram (pas un bot). Les bots ne peuvent pas initier de conversations entre eux.

Solutions evaluees :
- GramJS/MTProto user client : necessite un numero de telephone, une session, complexite excessive pour des tests
- Subprocess + API : impossible sans compte user
- handleUpdate : injecte des updates directement dans le handler Grammy

Decision retenue : bot.handleUpdate() (Option C)

Le framework :
1. Importe et configure le bot Grammy en memoire (meme code que relay.ts mais sans bot.start())
2. Construit un objet Update Telegram synthetique (message avec text, from, chat)
3. Appelle bot.handleUpdate(update)
4. Capture les reponses via un intercepteur sur ctx.reply / ctx.api.sendMessage
5. Verifie les assertions

Avantages :
- Zero dependance externe (pas d'API Telegram, pas de rate limit, pas de latence)
- Teste toute la logique applicative (routing, handlers, Supabase, formatage)
- Rapide (~100ms par test au lieu de 5-15s)
- Pas besoin de bot de test ni de token test (plus simple)
- Fonctionne en CI sans aucun secret Telegram

Inconvenients :
- Ne teste pas le transport Telegram (mais c'est la responsabilite de Grammy)
- Necessite de mocker ctx.reply pour capturer les reponses

Impact sur les autres FR :
- FR-005 (bot de test dedie) : SIMPLIFIE — plus besoin de creer un bot test via @BotFather, plus besoin de TELEGRAM_BOT_TOKEN_TEST. Le "bot de test" est une instance Grammy en memoire.
- FR-008 (integration CI) : SIMPLIFIE — plus besoin de secrets Telegram dans GitHub. Seuls les secrets Supabase sont necessaires.
- FR-009 (isolation) : INCHANGE — les tags [E2E-<run_id>] sont toujours utilises pour les donnees Supabase.

ATTENTION : cette approche change FR-005 par rapport a la spec Gate 1. Le bot de test n'est plus un process separe avec un token dedie, mais une instance Grammy en memoire avec des updates injectees. Les AC-014 (token), AC-016 (deleteWebhook), AC-017 (ignore unknown users) deviennent non applicables ou simplifies. A valider avec l'utilisateur en Gate 2.


### 7. Suite de tests E2E — FR-007

```
tests/e2e/e2e.test.ts

Structure:

  import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
  import { E2EFramework } from "./framework"

  describe("E2E Telegram Commands", () => {

    let fw: E2EFramework

    beforeAll(async () => {
      fw = new E2EFramework({ runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}` })
      await fw.setup()
    })

    afterEach(async () => {
      await fw.cleanup()  // cleanup Supabase apres chaque test
    })

    afterAll(async () => {
      await fw.teardown()
    })

    test("/help returns command list", async () => {
      const reply = await fw.sendCommand("/help")
      fw.assertContains(reply, "help")
    })

    test("/status returns health info", async () => {
      const reply = await fw.sendCommand("/status")
      fw.assertNotContains(reply, "error")
    })

    test("/feature list returns flags", async () => {
      const reply = await fw.sendCommand("/feature list")
      fw.assertContains(reply, "feature")
    })

    test("/task creates task in Supabase", async () => {
      const tag = fw.tag("Test Task")  // -> "[E2E-<runId>] Test Task"
      const reply = await fw.sendCommand(`/task ${tag}`)
      fw.assertContains(reply, "tache")
      // Verify in Supabase
      const rows = await fw.querySupabase("tasks", { title: tag })
      expect(rows.length).toBe(1)
    })

    test("/backlog shows tasks", async () => {
      // Create a task first
      await fw.sendCommand(`/task ${fw.tag("Backlog Test")}`)
      const reply = await fw.sendCommand("/backlog")
      fw.assertContains(reply, "Backlog Test")
    })

    test("/monitor returns metrics", async () => {
      const reply = await fw.sendCommand("/monitor")
      fw.assertContains(reply, "monitor")  // ou "p50" ou "reponse"
    })

    test("/estimate returns cost data", async () => {
      const reply = await fw.sendCommand("/estimate")
      fw.assertContains(reply, "estimation")  // ou "cout" ou "$"
    })

    test("free text message gets response", async () => {
      const reply = await fw.sendCommand("Bonjour, ceci est un test E2E")
      expect(reply.length).toBeGreaterThan(0)
    })
  })
```

Chaque test est independant. Le cleanup() apres chaque test supprime les entites taguees [E2E-*] dans Supabase.


### 8. Integration CI — FR-008

Job E2E ajoute dans ci.yml, dependant du job check :

```yaml
jobs:
  check:
    runs-on: [self-hosted, linux]
    # ... existant ...

  e2e:
    needs: [check]
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Setup E2E environment
        run: mkdir -p /tmp/claude-relay-e2e-${{ github.run_id }}
        env:
          RELAY_DIR: /tmp/claude-relay-e2e-${{ github.run_id }}

      - name: Run E2E tests
        run: bun test tests/e2e
        env:
          RELAY_DIR: /tmp/claude-relay-e2e-${{ github.run_id }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
          GITHUB_RUN_ID: ${{ github.run_id }}
          E2E_MODE: "true"

      - name: Cleanup E2E temp dir
        if: always()
        run: rm -rf /tmp/claude-relay-e2e-${{ github.run_id }}
```

Avec l'approche handleUpdate, les secrets Telegram ne sont plus necessaires dans le job E2E. Seuls SUPABASE_URL et SUPABASE_ANON_KEY sont requis (deja configures pour d'autres usages potentiels).


### 9. Isolation des donnees — FR-009

```
Strategie:

  Prefixe: "[E2E-<GITHUB_RUN_ID>]" sur toute entite creee
  Tables concernees: tasks, memory, messages, logs

  Cleanup (dans framework.ts):
    async cleanup() {
      for (const table of ["tasks", "memory", "messages", "logs"]) {
        const { error } = await supabase
          .from(table)
          .delete()
          .like("title" | "content", `%[E2E-${this.runId}]%`)
        if (error) console.warn(`E2E cleanup warning (${table}): ${error.message}`)
      }
    }

  Collision inter-runs:
    GITHUB_RUN_ID est unique par execution -> pas de collision
    En local: `local-${Date.now()}` -> unique aussi
```


### 10. Rapport E2E — FR-010

Le runner self-hosted envoie les resultats directement a GitHub via l'API (comportement natif des runners). Bun test affiche nativement les resultats par test (nom, duree, pass/fail). En cas d'echec, le framework log la commande envoyee, la reponse recue, et l'assertion echouee.

Pas de module supplementaire. Le formatter natif de bun test suffit pour AC-040, AC-041, AC-042.


## Fichiers impactes

| Fichier | Action | Traces vers | Description |
|---------|--------|-------------|-------------|
| .github/workflows/ci.yml | Modifie | FR-002, FR-008 | runs-on self-hosted, job e2e |
| .github/workflows/deploy.yml | Modifie | FR-003 | Retirer SSH action, deploy local |
| scripts/auto-deploy.sh | Supprime | FR-004 | Mecanisme redondant |
| ecosystem.config.cjs | Modifie | FR-004 | Retirer claude-autodeploy |
| tests/e2e/framework.ts | Nouveau | FR-005, FR-006, FR-009, FR-010 | Framework E2E avec handleUpdate |
| tests/e2e/e2e.test.ts | Nouveau | FR-007 | Suite de 8+ tests |
| CLAUDE.md | Modifie | FR-004 | Retirer auto-deploy, ajouter E2E |
| scripts/setup-runner.sh | Nouveau | FR-001 | Script d'installation du runner |


## Interfaces entre modules

```
ci.yml
  ├── job: check (tests unitaires)
  │     └── runs-on: [self-hosted, linux]
  │     └── bun test tests/unit + tests/integration + tests/system
  └── job: e2e (needs: check)
        └── runs-on: [self-hosted, linux]
        └── bun test tests/e2e
              └── tests/e2e/framework.ts
                    ├── importe Grammy Bot (src/relay.ts ou factory)
                    ├── construit Update synthetique
                    ├── appelle bot.handleUpdate()
                    ├── intercepte ctx.reply()
                    └── requete Supabase pour assertions + cleanup

deploy.yml
  └── job: deploy (runs-on: [self-hosted, linux])
        └── cd /home/edouard/claude-telegram-relay
        └── git pull + pm2 restart + smoke test
```

Dependance critique : le framework E2E doit pouvoir creer une instance Grammy Bot sans appeler bot.start(). Cela necessite que la configuration du bot (handlers, middleware) soit extractible de relay.ts dans une factory function. Si relay.ts configure tout dans le scope global, il faudra un leger refactoring pour extraire `createBot()`.


## Refactoring requis : extraction factory bot

relay.ts fait actuellement tout dans le scope global (creation du bot, enregistrement des handlers, bot.start()). Pour les tests E2E, on a besoin de :

```typescript
// Dans relay.ts ou un nouveau fichier src/bot-factory.ts

export function createBot(token: string): Bot {
  const bot = new Bot(token)

  // Enregistre tous les handlers
  bot.command("help", helpHandler)
  bot.command("status", statusHandler)
  // ... tous les handlers ...
  bot.on("message:text", messageHandler)

  return bot  // sans appeler bot.start()
}

// En fin de relay.ts (execution conditionnelle) :
if (import.meta.main) {
  const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!)
  bot.start()
}
```

Impact : modifie relay.ts (extraction, pas de changement fonctionnel). Le framework E2E importe createBot() et appelle bot.handleUpdate() au lieu de bot.start().

Alternative : si le refactoring de relay.ts est trop risque (c'est le fichier le plus gros et critique), on peut creer un bot minimal de test qui n'enregistre que les handlers a tester. Mais ca duplique du code et ne teste pas le vrai routing.

Decision : extraire createBot() de relay.ts. C'est un refactoring safe (renommage + extraction, zero changement de comportement). Le fichier est gros mais la modification est localisee.


## Migration DB

Aucune migration necessaire. Pas de nouvelle table, pas de modification de schema. Les tests E2E utilisent les tables existantes (tasks, memory, messages, logs) avec des tags de test.


## Risques techniques et mitigations

RT-001 : handleUpdate ne teste pas le transport Telegram
  Mitigation : C'est un compromis delibere. Le transport est la responsabilite de Grammy (bien teste). Notre valeur ajoutee est dans les handlers, le routing, et les effets Supabase. Si un bug transport apparait, il sera detecte par les tests manuels.

RT-002 : Extraction createBot() casse relay.ts
  Mitigation : Refactoring minimal (extract function, pas de changement de logique). Les 749 tests existants valident qu'il n'y a pas de regression. Faire ce refactoring en premiere tache avec un run de tests complet avant de continuer.

RT-003 : Le runner self-hosted a acces au filesystem de production
  Mitigation : Le runner execute les jobs dans son workspace dedie (_work/). Le job E2E utilise /tmp/ pour RELAY_DIR. Le seul job qui touche /home/edouard/claude-telegram-relay est le deploy (par design). Le runner tourne sous le user edouard (meme permissions que le deploy actuel).

RT-004 : Mocker ctx.reply() ne capture pas tous les formats de reponse
  Mitigation : relay.ts utilise ctx.reply() pour les reponses texte, ctx.replyWithVoice() pour la voix, ctx.api.sendMessage() pour les notifications. Le framework doit intercepter les 3. Les tests E2E se concentrent sur les reponses texte (commandes), donc ctx.reply() couvre 95% des cas.

RT-005 : Les tests E2E sont fragiles (dependance au format exact des reponses)
  Mitigation : Les assertions utilisent assertContains (sous-chaine) et pas d'egalite exacte. Les reponses en francais avec des mots-cles generiques ("tache", "help", "monitor") sont stables.

RT-006 : Le runner offline bloque toute la CI
  Mitigation : GitHub queue les jobs quand le runner est offline (EC-001). Le job tourne des que le runner revient. Pas de timeout fatal. Monitoring via /status ou systemctl status github-runner.

RT-007 : Secrets Supabase dans le runner
  Mitigation : Les secrets GitHub sont injectes via env vars dans le job, pas stockes en clair sur le disque. Le runner efface le workspace apres chaque job. Le user edouard a deja acces a Supabase (les secrets sont dans .env).


## Decoupage en taches (Phase 3 preview)

Partie A — Self-Hosted Runner :
  T1: Installer le runner GitHub Actions sur le serveur — FR-001
  T2: Migrer ci.yml vers self-hosted — FR-002
  T3: Migrer deploy.yml vers self-hosted — FR-003
  T4: Retirer auto-deploy.sh et claude-autodeploy — FR-004

Partie B — E2E Testing :
  T5: Extraire createBot() de relay.ts — prerequis FR-006
  T6: Framework E2E (handleUpdate, intercepteur, helpers) — FR-005, FR-006
  T7: Suite de tests E2E (8+ commandes) — FR-007
  T8: Integration CI (job e2e dans ci.yml) — FR-008
  T9: Isolation et cleanup des donnees — FR-009
  T10: Tests unitaires du framework + documentation CLAUDE.md — FR-010

Dependances :
  T1 -> T2 -> T3 -> T4 (sequentiel)
  T5 -> T6 -> T7 -> T9 -> T10 (sequentiel)
  T2 + T7 -> T8 (le job CI necessite le runner + les tests)
  T1-T4 et T5-T7 peuvent etre faits en parallele
