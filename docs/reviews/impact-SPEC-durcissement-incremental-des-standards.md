## Rapport d'impact : Durcissement incremental des standards de developpement — Vague 1

> Genere le 2026-03-23 a partir de docs/specs/SPEC-durcissement-incremental-des-standards.md.

### Niveau de risque : MEDIUM

### Resume

La spec introduit 2 nouveaux fichiers (tsconfig.json, src/config.ts) et modifie 5 fichiers de configuration/infrastructure (biome.json, lefthook.yml, .github/workflows/ci.yml, package.json, src/bot-context.ts). L'impact direct sur le code metier est sciemment limite : seul src/bot-context.ts est migre en vague 1, et les exports publics existants (BOT_TOKEN, ALLOWED_USER_ID, etc.) conservent leurs noms. Le risque principal est le passage de noUnusedImports et noUnusedVariables de "warn" a "error" dans Biome, qui bloque la CI si des imports ou variables non utilises existent dans le code source actuel — une situation probable compte tenu des 411 imports totaux dans src/. La zone d'ombre la plus critique est la strategie de fail-fast de src/config.ts dans les tests : si le module leve une erreur au chargement quand TELEGRAM_BOT_TOKEN est absent, les 3343 tests risquent de regrasser.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `tsconfig.json` | Direct | Creation du fichier (inexistant a ce jour). Perimetre : src/**/*.ts et mcp/**/*.ts |
| `src/config.ts` | Direct | Creation. Nouveau module central de validation des variables d'environnement via Zod |
| `src/bot-context.ts` | Direct | Modification : les 13 `process.env.*` sont remplaces par `config.*`. Les exports publics (BOT_TOKEN, ALLOWED_USER_ID, GROUP_ID, CLAUDE_PATH, PROJECT_DIR, RELAY_DIR, TEMP_DIR, UPLOADS_DIR, USER_NAME, USER_TIMEZONE) conservent leurs noms |
| `biome.json` | Direct | Modification de 4 regles linter : noExplicitAny warn, noImplicitAnyLet warn, noUnusedVariables error, noUnusedImports error |
| `lefthook.yml` | Direct | Ajout du hook typecheck pre-commit (bunx tsc --noEmit) |
| `.github/workflows/ci.yml` | Direct | Remplacement du step "Type check" (bun build --no-bundle fichier par fichier) par bunx tsc --noEmit |
| `package.json` | Direct | Ajout du script "typecheck" |
| `src/relay.ts` | Indirect | Importe BOT_TOKEN, ALLOWED_USER_ID, GROUP_ID, PROJECT_DIR, RELAY_DIR, TEMP_DIR, UPLOADS_DIR, supabase depuis bot-context.ts — non casse si les exports gardent leurs noms |
| `src/commands/zz-messages.ts` | Indirect | Importe ALLOWED_USER_ID, BOT_TOKEN, formatDocumentContext, UPLOADS_DIR depuis bot-context.ts — non casse si les exports sont preserves |
| `src/commands/documents.ts` | Indirect | Importe ALLOWED_USER_ID, escapeHtml depuis bot-context.ts |
| `src/commands/help.ts` | Indirect | Importe RELAY_START_TIME depuis bot-context.ts |
| `tests/unit/bot-context.test.ts` | Direct (test) | Importe PROJECT_ROOT, RELAY_DIR, RELAY_START_TIME, TEMP_DIR, UPLOADS_DIR, USER_TIMEZONE depuis src/bot-context.ts. Teste aussi supabase=null avec delete process.env.SUPABASE_URL — le comportement change si src/config.ts est evalue au chargement |
| `tests/unit/notification-queue.test.ts` | Indirect (test) | Set process.env en top-level avant les imports — pattern fragile si src/config.ts est evalue avant ces assignments |
| `tests/unit/format-document-context.test.ts` | Indirect (test) | Importe formatDocumentContext depuis src/bot-context.ts |
| `tests/unit/zz-messages-search.test.ts` | Indirect (test) | Importe formatDocumentContext depuis src/bot-context.ts |
| `src/code-review.ts` | Aucun | Definit `const _GITHUB_REPO` (underscore prefix) — variable actuellement non bloquante en "warn", mais pourrait devenir un probleme si noUnusedVariables passe a "error" (cf. point d'attention #2) |
| `src/orchestrator.ts` | Aucun | Definit `const _PROJECT_DIR` (underscore prefix) — meme risque que code-review.ts |
| `src/agent-messaging.ts` | Aucun | Definit `const _key` localement — risque identique |
| `src/commands/documents.ts` | Aucun | Definit `const _userId` (underscore prefix) — risque identique |
| `src/doc-utils.ts` | Aucun | Definit `const _regex` — risque identique |
| Les 24 autres fichiers avec process.env | Aucun en vague 1 | Hors scope vague 1 : heartbeat.ts, tts.ts, transcribe.ts, agent.ts, notification-queue.ts, etc. gardent leurs process.env directs |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/bot-context.ts` | `BOT_TOKEN` (export const) | Modification interne (source : process.env → config.telegramBotToken) | Oui — meme nom, meme type string |
| `src/bot-context.ts` | `ALLOWED_USER_ID` (export const) | Modification interne | Oui — meme nom, meme type string |
| `src/bot-context.ts` | `GROUP_ID` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `CLAUDE_PATH` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `PROJECT_DIR` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `RELAY_DIR` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `USER_NAME` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `USER_TIMEZONE` (export const) | Modification interne | Oui |
| `src/bot-context.ts` | `supabase` (export const) | Modification interne (source : process.env → config.supabaseUrl) | Oui — meme type SupabaseClient \| null |
| `src/config.ts` | `config` (export const, nouveau) | Ajout | Oui — nouvel export |
| `tsconfig.json` | N/A (nouveau fichier) | Ajout | Oui — aucun fichier existant ne l'importe |
| `.github/workflows/ci.yml` | Step "Type check" | Modification (bun build → tsc --noEmit) | Risque : le nouveau step est plus strict et peut echouer si le code a des erreurs de type |

### Breaking changes potentiels

- [x] **Fail-fast src/config.ts dans les tests** — Si src/config.ts evalue Zod au chargement du module et leve une erreur quand TELEGRAM_BOT_TOKEN est absent, tout test qui importe (directement ou transitivement) src/bot-context.ts echouera. `tests/unit/bot-context.test.ts` n'initialise pas TELEGRAM_BOT_TOKEN avant l'import. **Impact** : potentiellement des dizaines de fichiers de tests via la chaine d'import bot-context.ts → config.ts. La spec identifie cette zone d'ombre (section 9, point 2) mais ne tranche pas la solution.

- [x] **Passage noUnusedVariables et noUnusedImports de "warn" a "error"** — Le code src/ contient des variables prefixees `_` qui sont syntaxiquement "inutilisees" selon Biome : `_GITHUB_REPO` (src/code-review.ts:24), `_PROJECT_DIR` (src/orchestrator.ts:134), `_key` (src/agent-messaging.ts:172), `_userId` (src/commands/documents.ts:329), `_regex` (src/doc-utils.ts:91). Si Biome ne reconnait pas le prefixe `_` comme convention d'exclusion, le check `biome check src/` echouera (V11), bloquant la CI. **Impact** : src/code-review.ts, src/orchestrator.ts, src/agent-messaging.ts, src/commands/documents.ts, src/doc-utils.ts.

- [x] **Erreurs tsc induites par strict:true et noUncheckedIndexedAccess** — Le code src/ actuel n'a jamais ete compile avec strict:true. Les acces tableau `arr[0]` sans garde deviennent `T | undefined` avec noUncheckedIndexedAccess. Le nombre exact d'erreurs est inconnu sans executer tsc. La spec exige zero erreur (V2) mais reconnait que si trop d'erreurs apparaissent, l'option pourrait etre retiree (section 9, point 1). **Impact** : potentiellement nombreux fichiers src/ (63 modules).

- [ ] **Zod en devDependencies uniquement** — `zod` est declare en `devDependencies` dans package.json (L43). Si src/config.ts l'importe en production (`import { z } from "zod"`), le module sera manquant en environnement de production si bun install --production est execute. **Impact** : src/config.ts, demarrage du bot en prod. Note : avec Bun et le bundling, ce risque est reduit mais merite verification.

- [ ] **bot-context.ts : buildPrompt utilise encore process.env.VOICE_PROVIDER et process.env.TTS_PROVIDER directement** (lignes 552-564) — Ces deux variables ne font pas partie des 13 occurrences citees dans la spec (R8). Si l'implementation ne les migre pas, la R4 n'est pas complete pour bot-context.ts. **Impact** : src/bot-context.ts.

### Points d'attention pour le Reviewer

1. **Strategie de fail-fast src/config.ts : objet ou fonction lazy ?** : La spec (section 9, point 2) laisse ouverte la question : si config.ts exporte un objet evalue au chargement et que TELEGRAM_BOT_TOKEN est absent, tous les tests qui importent bot-context.ts echoueront. Verifier que l'implementation choisit une des solutions identifiees (setup.ts de test definissant les variables requises, ou export d'une fonction lazy). Fichiers cles : `src/config.ts` (implementation), `tests/unit/bot-context.test.ts` (test le plus expose), `tests/unit/notification-queue.test.ts` (set process.env en top-level avant imports). Critere : V15 (3343 tests sans regression).

2. **Variables prefixees `_` et biome noUnusedVariables "error"** : Biome 2.x reconnait le prefixe `_` comme convention pour les variables intentionnellement inutilisees — mais il faut verifier que la version installee (@biomejs/biome ^2.4.8) applique bien cette exception. Si non, les 5 fichiers avec `const _X` echoueront au check biome (V11). Fichiers a verifier : `src/code-review.ts:24`, `src/orchestrator.ts:134`, `src/agent-messaging.ts:172`, `src/commands/documents.ts:329`, `src/doc-utils.ts:91`.

3. **Zod a deplacer en dependencies (pas devDependencies)** : src/config.ts utilise Zod au runtime de production (validation au boot). Zod doit etre en `dependencies`, pas `devDependencies`. Fichier : `package.json` L43. Si non corrige : echec silencieux en prod avec `bun install --production`.

4. **Couverture partielle de bot-context.ts** : La spec mentionne 13 occurrences process.env dans bot-context.ts (R8), mais buildPrompt contient encore deux `process.env.VOICE_PROVIDER` et `process.env.TTS_PROVIDER` (lignes 552 et 559 du fichier actuel). Verifier que ces variables sont incluses dans config.ts et que bot-context.ts ne contient plus aucun process.env direct apres implementation (V8 verifie uniquement TELEGRAM_BOT_TOKEN).

5. **CI : step "Syntax check setup scripts" a conserver ou supprimer explicitement** : La spec (section 4.5) mentionne que ce step "est supprime (couvert par tsc si les setup scripts sont dans include, ou maintenu separe si hors perimetre tsconfig)". Le tsconfig inclut uniquement `src/**` et `mcp/**` — les scripts setup/ ne sont PAS couverts. La CI perdra ce check de syntaxe sans remplacement. Fichier : `.github/workflows/ci.yml`.

### Blast radius

- Modules directement modifies : 7 (tsconfig.json nouveau, src/config.ts nouveau, src/bot-context.ts, biome.json, lefthook.yml, .github/workflows/ci.yml, package.json)
- Modules indirectement impactes : 14 (src/relay.ts + 13 fichiers src/ et commands/ qui importent depuis bot-context.ts)
- Fichiers source modifies : 1 (src/bot-context.ts) + 2 nouveaux (tsconfig.json, src/config.ts)
- Fichiers de test a verifier : 3 (tests/unit/bot-context.test.ts, tests/unit/notification-queue.test.ts, tests/unit/format-document-context.test.ts, tests/unit/zz-messages-search.test.ts) — 4 au total
