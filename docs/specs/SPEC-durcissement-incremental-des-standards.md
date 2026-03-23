# Spec : Durcissement incremental des standards de developpement — Vague 1

> Genere le 2026-03-23. Source : exploration EXPLORE-il-faut-ameliorer-les-standards-de.md, codebase analysis (biome.json, package.json, lefthook.yml, .github/workflows/ci.yml, src/bot-context.ts, .env.example, 73 occurrences process.env).

## 1. Objectif

Etablir les fondations de qualite du projet en activant le type-checking TypeScript strict, en centralisant la validation des variables d'environnement via Zod, en durcissant la configuration Biome, et en ajoutant un step `bunx tsc --noEmit` dans la CI. Cette vague 1 pose les rails structurels sans toucher au code metier : aucune des 105 occurrences de `any` ni des 102 catch silencieux n'est corrigee — c'est le perimetre des vagues 2-4. Le resultat : les erreurs de type et les variables d'environnement manquantes sont detectees au plus tot (boot du bot, pre-commit, CI).

## 2. Regles metier

| # | Regle | Source | Exemple |
|---|-------|--------|---------|
| R1 | Un fichier `tsconfig.json` est cree a la racine du projet avec `strict: true`, `noImplicitReturns: true`, `skipLibCheck: true`, `target: "ESNext"`, `module: "ESNext"`, `moduleResolution: "bundler"`. `noUncheckedIndexedAccess` est CONDITIONNEL : executer `bunx tsc --noEmit` avec cette option AVANT de la figer. Si >20 erreurs sur le code src/ actuel, la retirer du scope vague 1 et la reporter en vague 2 (adversarial F-DA) | Exploration section 6 (vague 1) + contrainte : compiler sans erreur sur le code actuel | `tsconfig.json` valide que tsc passe en zero erreur sur `src/` |
| R2 | Le `tsconfig.json` inclut `src/**/*.ts` et `mcp/**/*.ts` dans `include` ; exclut `node_modules` et `tests/` | Perimetre code de production uniquement. Les tests sont types par Bun directement | `include: ["src/**/*.ts", "mcp/**/*.ts"]` |
| R3 | `exactOptionalPropertyTypes` n'est PAS active en vague 1 : genere trop d'erreurs sur le code existant (proprietes optionnelles traitees comme `T | undefined`) | Contrainte : tsconfig doit compiler sans erreur sur le code actuel. Option reportee a vague 2+ | `exactOptionalPropertyTypes` absent du tsconfig vague 1 |
| R4 | Un module `src/config.ts` est cree, centralisant TOUTES les variables d'environnement lues via `process.env` dans `src/` avec validation Zod | Exploration section 3 (#3) : 73 occurrences process.env en 25 fichiers | `config.SUPABASE_URL` au lieu de `process.env.SUPABASE_URL` dans chaque module |
| R5 | `src/config.ts` definit deux schemas Zod distincts : `RequiredEnvSchema` (variables dont l'absence doit faire echouer le boot) et `OptionalEnvSchema` (variables avec valeur par defaut) | Distinction semantique : TELEGRAM_BOT_TOKEN manquant = boot impossible ; VOICE_PROVIDER manquant = feature desactivee | `RequiredEnvSchema` : TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, SUPABASE_URL, SUPABASE_ANON_KEY |
| R6 | Au boot, si une variable requise est absente, `src/config.ts` leve une erreur explicite (`ConfigurationError`) avec le nom de la variable manquante et un lien vers `.env.example` | Exploration section 1 (#3) : fail-fast au boot | `Error: Missing required env var: TELEGRAM_BOT_TOKEN. See .env.example` |
| R7 | `src/config.ts` exporte une fonction `getConfig()` qui retourne un singleton lazy : la validation Zod est faite une seule fois au premier appel, pas au chargement du module. Cela evite de casser les tests qui importent transitvement config.ts via bot-context.ts sans avoir les variables d'env definies (adversarial BLOQUANT). `bot-context.ts` appelle `getConfig()` dans ses initialisations. Les tests n'importent jamais config.ts directement | Performance + compatibilite tests : pas de crash au chargement du module | `import { getConfig } from "./config.ts"; const cfg = getConfig(); cfg.telegramBotToken` |
| R8 | `src/bot-context.ts` est mis a jour pour importer `getConfig()` depuis `src/config.ts` et l'appeler en interne. Les exports publics de bot-context.ts (BOT_TOKEN, ALLOWED_USER_ID, etc.) sont conserves avec les memes noms pour ne pas casser les 14 importeurs. bot-context.ts appelle `getConfig()` dans chaque export au lieu de `process.env` direct | R4 : centralisation. Pas de double source de verite (adversarial MAJEUR) | `const cfg = getConfig(); export const BOT_TOKEN = cfg.telegramBotToken;` |
| R9 | `biome.json` est mis a jour : `noExplicitAny` passe a `"warn"` (pas `"error"` : les 105 occurrences existantes ne doivent pas bloquer) ; `noImplicitAnyLet` passe a `"warn"` ; `noUnusedImports` passe a `"error"`. Pour `noUnusedVariables` : verifier que Biome respecte la convention de prefixe `_` (variables comme `_before`, `_key`) avant de passer a `"error"`. Si Biome ne respecte pas le prefixe `_` : garder `"warn"` (adversarial impact) | Exploration section 4 (option B vague 1) + contrainte : ne pas bloquer les PRs en cours | Nouveau code avec `any` : warning CI visible mais pas bloquant |
| R10 | `biome.json` conserve `noNonNullAssertion: "off"` en vague 1 : les assertions `!` existantes (trop nombreuses) ne sont pas touchees | Contrainte : scope vague 1 = config uniquement, pas de modifications du code metier | Reporté à vague 2+ |
| R11 | `lefthook.yml` est mis a jour pour ajouter un hook `typecheck` en pre-commit : `bunx tsc --noEmit` sur l'ensemble du projet | Exploration section 3 (#9) : les erreurs de type passent le hook actuel | Pre-commit bloque si tsc signale une erreur |
| R12 | La CI (`.github/workflows/ci.yml`) remplace le step "Type check" actuel (`bun build --no-bundle` fichier par fichier) par `bunx tsc --noEmit` | Exploration section 3 (#10) : le check actuel est insuffisant (pas de strict, pas de cross-file) | Step CI : `bunx tsc --noEmit` avec exit code 1 si erreur |
| R13 | Le step typecheck CI doit passer en zero erreur avec le nouveau `tsconfig.json`. Si des erreurs de compilation existent sur le code actuel, elles doivent etre corrigees pendant l'implementation de cette vague (uniquement les erreurs induites par `strict: true` et `noUncheckedIndexedAccess` sur le code src/, pas les `any`) | Contrainte : la CI doit rester verte apres le merge | Les erreurs de nullability introduites par `noUncheckedIndexedAccess` sur les tableaux existants doivent etre corrigees |
| R14 | `package.json` ajoute un script `"typecheck": "tsc --noEmit"` pour permettre l'execution locale | Convention projet : scripts npm pour toutes les operations courantes | `bun run typecheck` equivalent a `bunx tsc --noEmit` |
| R15 | `src/config.ts` n'est pas importe DIRECTEMENT par les fichiers de tests. Les imports transitifs via bot-context.ts sont OK car getConfig() est lazy et ne leve pas d'erreur au chargement du module (adversarial BLOQUANT resolu). Les tests continuent de mocker process.env directement | Contrainte : ne pas casser les 3399 tests existants. Les tests mocquent process.env avant import des modules | Pattern existant : `process.env.SUPABASE_URL = "..."` dans les beforeEach des tests |

## 3. Donnees d'entree

| Source | Type | Acces | Champs utilises |
|--------|------|-------|-----------------|
| Variables d'environnement | `process.env` | Lecture au chargement du module `src/config.ts` | TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, SUPABASE_URL, SUPABASE_ANON_KEY, USER_NAME, USER_TIMEZONE, TELEGRAM_GROUP_ID, SPRINT_THREAD_ID, DEV_THREAD_ID, CLAUDE_PATH, PROJECT_DIR, RELAY_DIR, VOICE_PROVIDER, GROQ_API_KEY, GROQ_TTS_VOICE, GROQ_TTS_MODEL, TTS_PROVIDER, PIPER_BINARY, PIPER_MODEL_PATH, WHISPER_BINARY, WHISPER_MODEL_PATH, WHISPER_LANGUAGE, GITHUB_REPO, NODE_ENV, LOG_LEVEL, HEARTBEAT_DEBUG, TMPDIR |
| `.env.example` | Fichier texte | Reference documentaire pour les messages d'erreur | Liste des variables requises vs optionnelles |
| `biome.json` | JSON | Lecture/modification directe | `linter.rules.suspicious`, `linter.rules.correctness` |
| `lefthook.yml` | YAML | Lecture/modification directe | `pre-commit.commands` |
| `.github/workflows/ci.yml` | YAML | Lecture/modification directe | Step "Type check" |

## 4. Donnees de sortie

### 4.1 `tsconfig.json` (nouveau fichier)

Fichier de configuration TypeScript strict a la racine :
- `compilerOptions.strict: true` (active strictNullChecks, strictFunctionTypes, strictPropertyInitialization, etc.)
- `compilerOptions.noUncheckedIndexedAccess: true` (CONDITIONNEL — retirer si >20 erreurs tsc sur le code actuel)
- `compilerOptions.noImplicitReturns: true`
- `compilerOptions.skipLibCheck: true` (requis pour ne pas echouer sur les types des dependances)
- `compilerOptions.target: "ESNext"`, `module: "ESNext"`, `moduleResolution: "bundler"`
- `include: ["src/**/*.ts", "mcp/**/*.ts"]`
- `exclude: ["node_modules", "tests"]`

### 4.2 `src/config.ts` (nouveau module)

Module d'initialisation exportant un objet `config` type :

```typescript
// structure attendue (non-normative)
export const config = {
  telegramBotToken: string,         // requis
  telegramUserId: string,           // requis
  supabaseUrl: string,              // requis
  supabaseAnonKey: string,          // requis
  userName: string,                 // optionnel, defaut ""
  userTimezone: string,             // optionnel, defaut Intl auto
  telegramGroupId: string,          // optionnel, defaut ""
  sprintThreadId: number,           // optionnel, defaut 0
  devThreadId: number,              // optionnel, defaut 0
  claudePath: string,               // optionnel, defaut "claude"
  projectDir: string,               // optionnel, defaut ""
  relayDir: string,                 // optionnel, defaut ~/.claude-relay
  voiceProvider: string,            // optionnel, defaut ""
  groqApiKey: string,               // optionnel, defaut ""
  // ... (tous les process.env identifies en section 3)
}
```

En cas de variable requise absente : `throw new Error("Missing required env var: <NAME>. See .env.example")`

### 4.3 `biome.json` modifie

Regles mises a jour :
- `suspicious.noExplicitAny`: `"off"` → `"warn"`
- `suspicious.noImplicitAnyLet`: `"off"` → `"warn"`
- `correctness.noUnusedVariables`: `"warn"` → `"error"`
- `correctness.noUnusedImports`: `"warn"` → `"error"`

### 4.4 `lefthook.yml` modifie

Nouveau hook ajouté au bloc `pre-commit.commands` :
```yaml
typecheck:
  run: bunx tsc --noEmit
```

### 4.5 `.github/workflows/ci.yml` modifie

Le step "Type check" est remplace par :
```yaml
- name: Type check
  run: bunx tsc --noEmit
```
Le step "Syntax check setup scripts" est supprime (couvert par tsc si les setup scripts sont dans `include`, ou maintenu separe si hors perimetre tsconfig).

### 4.6 `package.json` modifie

Nouveau script : `"typecheck": "tsc --noEmit"`

## 5. Fichiers concernes

| Fichier | Action | Raison |
|---------|--------|--------|
| `tsconfig.json` | Creer | Nouveau fichier de configuration TypeScript strict (R1, R2, R3) |
| `src/config.ts` | Creer | Module centralisant tous les process.env avec validation Zod (R4, R5, R6, R7) |
| `src/bot-context.ts` | Modifier | Importer les constantes depuis src/config.ts (R8) — 13 occurrences process.env |
| `biome.json` | Modifier | Durcir les regles noExplicitAny, noImplicitAnyLet, noUnusedVariables, noUnusedImports (R9, R10) |
| `lefthook.yml` | Modifier | Ajouter le hook typecheck pre-commit (R11) |
| `.github/workflows/ci.yml` | Modifier | Remplacer bun build --no-bundle par bunx tsc --noEmit (R12) |
| `package.json` | Modifier | Ajouter le script typecheck (R14) + deplacer Zod de devDependencies vers dependencies (adversarial cycle 2 F-DA-2) |

Note : les autres fichiers avec `process.env` (heartbeat.ts, tts.ts, transcribe.ts, etc.) NE sont PAS modifies en vague 1. Seul `src/bot-context.ts` est mis a jour pour illustrer le pattern. La migration complete des 25 fichiers est le scope de la vague 2. IMPORTANT (adversarial cycle 2 F-EC-1) : l'initialisation Supabase (`createClient(...)`) dans bot-context.ts est egalement migrée vers getConfig() mais doit rester lazy — ne pas appeler createClient au chargement du module si les env vars ne sont pas definies. Utiliser un getter lazy ou evaluer au premier acces.

## 6. Patterns existants

### 6.1 Pattern de validation Zod (precedent dans le projet)

Zod est en devDependencies (`package.json` L43) mais non utilise dans `src/` a ce jour. Le schema `agent-schemas.ts` definit des types JSON pour les agents mais sans validation runtime Zod. La structure d'un schema Zod attendue s'inspire de l'usage dans les tests existants :

Reference : `/home/edouard/claude-telegram-relay/package.json` L43 — `"zod": "^3.25.76"` en devDependencies. **IMPORTANT (adversarial MAJEUR)** : Zod doit etre deplace de `devDependencies` vers `dependencies` car `src/config.ts` l'utilise en production. Ajouter `package.json` a la section 5 si pas deja present.

### 6.2 Pattern des exports de constantes (bot-context.ts)

`src/bot-context.ts` exporte deja les constantes de configuration a la ligne 26-36 :
```
export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
```
Ces exports sont importes dans `src/relay.ts` (L22-32). Le pattern `export const X = config.x` reste compatible avec tous les importeurs existants sans modification des fichiers appelants.

### 6.3 Pattern de test des fichiers de configuration

`tests/unit/lefthook-config.test.ts` (L1-78) montre le pattern de test structural pour les fichiers de config : lecture du fichier, parse YAML/JSON, assertions sur les champs. Ce meme pattern s'applique pour tester `tsconfig.json` et `biome.json`.

### 6.4 Pattern feature-flags (hot-reload)

`src/feature-flags.ts` : module lu au demarrage avec hot-reload via `config/features.json`. Le pattern `const value = readJsonFile(); return value.flagName` est la reference pour le chargement de configuration a partir d'un fichier. `src/config.ts` suit un pattern similaire mais pour les variables d'environnement.

### 6.5 Pattern de test process.env dans les tests existants

`tests/unit/bot-context.test.ts` importe directement les exports de `bot-context.ts`. Les tests qui ont besoin de surcharger des variables d'environnement le font via `process.env.X = "..."` avant l'import (ou dans un beforeEach avec des modules dynamiques). Ce pattern est conserve en vague 1 : `src/config.ts` exporte `getConfig()` lazy — la validation Zod n'est executee qu'au premier appel, pas au chargement du module. `config.ts` exporte egalement `_resetConfigForTesting()` pour permettre aux tests de reinitialiser le singleton (adversarial cycle 2 F-EC-2).

## 7. Contraintes

- **Ne pas casser les 3343 tests** : aucune modification du code metier. Les exports de `bot-context.ts` gardent les memes noms. L'evaluation de `src/config.ts` au chargement ne doit pas lever d'erreur si les variables requises ne sont pas definies dans l'environnement de test (utiliser `process.env.TELEGRAM_BOT_TOKEN ?? ""` dans les tests ou exporter une fonction `loadConfig()` qui peut etre mockee — a trancher en implementation)
- **tsconfig doit compiler en zero erreur sur le code actuel** : `skipLibCheck: true` est obligatoire. `exactOptionalPropertyTypes` est exclu (R3). Si `noUncheckedIndexedAccess` ou `noImplicitReturns` genere des erreurs sur le code existant, ces erreurs specifiques doivent etre corrigees dans cette vague (scope limite : corrections de nullability, pas refactoring)
- **biome.json : noExplicitAny reste "warn" pas "error"** : les 105 occurrences existantes ne bloquent pas les PRs en cours. Passage a "error" dans la vague 2
- **Pas de migration complete des process.env** : seul `src/bot-context.ts` est migre en vague 1. Les autres fichiers (25) gardent leurs `process.env` directs jusqu'a la vague 2
- **Bun et tsc** : `bunx tsc --noEmit` fonctionne avec Bun mais la resolution des modules (`.ts` extensions) requiert `moduleResolution: "bundler"` dans le tsconfig pour etre compatible avec les imports Bun style (`import ... from "./module.ts"`)
- **lefthook typecheck en pre-commit** : ce hook s'execute sur tous les fichiers (pas seulement les staged), ce qui peut ralentir le pre-commit. Si trop lent, option : l'executer uniquement en CI et garder le pre-commit sur Biome uniquement
- **Dependance** : `src/config.ts` doit etre importe tot dans `src/relay.ts` (avant les autres imports) pour que le fail-fast soit effectif au demarrage

## 8. Criteres de validation

| # | Critere | Verification | Niveau |
|---|---------|-------------|--------|
| V1 | `tsconfig.json` existe a la racine du projet avec `strict: true` et `skipLibCheck: true` | `existsSync("tsconfig.json") && JSON.parse(readFileSync(...)).compilerOptions.strict === true` | unit |
| V2 | `bunx tsc --noEmit` s'execute sans erreur sur le codebase actuel | Executer `bunx tsc --noEmit` et verifier exit code 0 | integration |
| V3 | `tsconfig.json` inclut `src/**/*.ts` et `mcp/**/*.ts` et exclut `node_modules` et `tests` | Assertions sur les champs `include` et `exclude` du fichier JSON | unit |
| V4 | `src/config.ts` existe et exporte une fonction `getConfig()` qui retourne un objet non-null | `existsSync("src/config.ts")` + import et verifier que `getConfig()` retourne un objet | unit |
| V5 | `config` contient les 4 variables requises (telegramBotToken, telegramUserId, supabaseUrl, supabaseAnonKey) comme champs de type string | Inspection du type export via assertion TypeScript ou verification runtime des champs | unit |
| V6 | Si TELEGRAM_BOT_TOKEN est absent de l'environnement, `getConfig()` leve une erreur contenant "TELEGRAM_BOT_TOKEN" (pas au chargement du module, seulement a l'appel de getConfig) | Test : reset le singleton, supprimer TELEGRAM_BOT_TOKEN de process.env, appeler getConfig(), verifier que l'erreur est levee | unit |
| V7 | `config.sprintThreadId` est de type number (pas string) meme si la variable d'env est une chaine | `typeof config.sprintThreadId === "number"` avec `SPRINT_THREAD_ID="6"` → `config.sprintThreadId === 6` | unit |
| V8 | `src/bot-context.ts` n'utilise plus `process.env.TELEGRAM_BOT_TOKEN` directement : `BOT_TOKEN` est derive de `config.telegramBotToken` | Grep `process.env.TELEGRAM_BOT_TOKEN` dans `src/bot-context.ts` → zero occurrence | unit |
| V9 | `biome.json` a `noExplicitAny: "warn"` (pas "off") | Lecture JSON et assertion sur `linter.rules.suspicious.noExplicitAny` | unit |
| V10 | `biome.json` a `noUnusedImports: "error"` et `noUnusedVariables: "error"` | Lecture JSON et assertions | unit |
| V11 | `biome check src/` s'execute sans erreur (exit code 0) apres les modifications Biome | `Bun.spawnSync(["bunx", "biome", "check", "src/"])` → exit code 0. Pattern identique a tests/unit/lefthook-config.test.ts L70-77 | integration |
| V12 | `lefthook.yml` contient un hook `typecheck` dans `pre-commit.commands` | Parse YAML et verifier `config["pre-commit"].commands.typecheck` existe avec `run` contenant "tsc --noEmit" | unit |
| V13 | Le step "Type check" dans `.github/workflows/ci.yml` utilise `bunx tsc --noEmit` (pas `bun build --no-bundle`) | Lecture YAML et assertion sur le contenu du step | unit |
| V14 | `package.json` contient le script `"typecheck": "tsc --noEmit"` | `JSON.parse(readFileSync("package.json")).scripts.typecheck === "tsc --noEmit"` | unit |
| V15 | Les 3343 tests existants passent sans regression apres toutes les modifications | `bun test` → pass count >= 3343, fail count = 0 | integration |
| V16 | `src/config.ts` est importe et utilisable dans un contexte de test avec des variables d'env mockees | Test unitaire de src/config.ts avec process.env surcharges, verifier que les valeurs sont correctement lues | unit |

## 9. Coverage et zones d'ombre

| Dimension | Statut | Justification |
|-----------|--------|---------------|
| Probleme | Couvert | Absence de tsconfig strict, process.env disperses, Biome permissif, CI insuffisante : tous documentes dans l'exploration sections 1 et 3 |
| Perimetre | Couvert | Vague 1 explicitement bornee : config uniquement, pas de code metier, pas de correction des any ni des catch silencieux. Migration process.env limitee a bot-context.ts |
| Validation | Couvert | 16 V-criteres couvrant chaque fichier cree/modifie : tsconfig (V1-V3), config.ts (V4-V8), biome.json (V9-V11), lefthook.yml (V12), ci.yml (V13), package.json (V14), non-regression (V15-V16) |
| Technique | Couvert | Contraintes Bun/tsc (moduleResolution bundler), skipLibCheck, exactOptionalPropertyTypes exclu, noExplicitAny en warn, hook pre-commit potentiellement lent |
| UX | Non applicable | Pas d'interaction utilisateur Telegram. Le seul "UX" est le message d'erreur au boot (R6) : explicite et actionnable |
| Alternatives | Pertinent | Option C (strict-first big bang) rejetee : risque de blocage prod. Option D (Standards-as-Code toolkit) rejetee : sur-ingenierie. Option B (incremental) choisie, documentee dans l'exploration section 4 |

**Zones d'ombre residuelles :**

1. ~~**Erreurs tsc induites par `noUncheckedIndexedAccess`**~~ — RESOLU (adversarial) : option CONDITIONNELLE. Executer tsc avec l'option avant de la figer. Si >20 erreurs : retirer du scope vague 1. Pas de scope crawl.

2. ~~**Strategie de fail-fast `src/config.ts` dans les tests**~~ — RESOLU (adversarial BLOQUANT) : `getConfig()` est un singleton lazy. La validation Zod n'est executee qu'au premier appel de `getConfig()`, pas au chargement du module. Les tests qui importent transitvement config.ts via bot-context.ts ne crashent pas car bot-context.ts appelle `getConfig()` seulement quand ses exports sont evalues. Pas besoin de setup.ts global.

3. **Scope exact des corrections tsc** : si `strict: true` + `noImplicitReturns` generent des erreurs sur le code src/ actuel, ces corrections sont dans le scope de cette vague. Mais si elles sont trop nombreuses (>20 fichiers), il faudra ajuster le tsconfig (retirer une option) plutot que de corriger le code — ce trade-off est a evaluer pendant l'implementation.

4. ~~**Zod en devDependencies**~~ — RESOLU (adversarial MAJEUR) : deplacer Zod de `devDependencies` vers `dependencies` dans package.json car src/config.ts l'utilise en production.
