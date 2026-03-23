## Rapport d'impact : Enforcement automatique des standards par les agents

> Genere le 2026-03-23 a partir de docs/specs/SPEC-enforcement-standards-agents.md.

### Niveau de risque : MEDIUM

### Resume

Le changement ajoute du contenu textuel (instructions) dans 4 fichiers existants et cree 1 nouveau fichier de test. Les modifications sont additives et n'alterent aucune signature de fonction ni aucun export public. Le risque principal reside dans la taille de l'allowlist process.env (25 fichiers a auditer) et dans l'ajout d'un test structurel LOC qui pourrait devenir fragile si de nouveaux fichiers depassent le seuil sans etre ajoutes a l'allowlist. La spec est bien delimitee et les patterns sont eprouves.

### Modules impactes

| Module | Impact | Detail |
|--------|--------|--------|
| `src/bmad-prompts.ts` (552 LOC) | Direct | Ajout d'un bloc "STANDARDS DU PROJET" (~10 lignes) dans `getDevInstructions("exec")`. Fonction privee (non exportee), pas de risque de rupture d'API. Le test existant V7 (`corriger-les-defauts-du-pipeline-dagents.test.ts`) appelle `buildFullAgentPrompt("dev", {command: "exec"})` et verifie la presence de "CLAUDE.md", "bun build", "bun test" — ces verifications resteront valides car le changement est additif |
| `src/orchestrator/agent-step.ts` (261 LOC) | Direct | Ajout de 1-3 lignes dans le case "dev" de `getOrchestrationInstructions()`. Fonction exportee mais uniquement consommee en interne par `runAgentStep` (meme fichier L83). Aucun test unitaire existant specifique a cette fonction |
| `.claude/agents/implementer.md` | Direct | Ajout d'une section "Standards obligatoires" (~10 lignes). Fichier markdown lu par le pipeline CLI — pas de dependances code |
| `.claude/agents/reviewer.md` | Direct | Ajout d'une sous-section "Standards projet" (~8 lignes) dans la checklist. Fichier markdown lu par le pipeline CLI — pas de dependances code |
| `tests/unit/coding-standards.test.ts` | Direct (creation) | Nouveau fichier de test — 5 suites (S1-S5). Scan dynamique de ~88 fichiers src. Aucun module source ne depend d'un fichier de test |
| `src/bmad-agents.ts` | Indirect | Importe depuis `bmad-prompts.ts` — non impacte car les exports publics de `bmad-prompts.ts` ne changent pas |
| `src/code-review.ts` | Indirect | Importe `buildFullAgentPrompt` depuis `bmad-prompts.ts` — non impacte (API inchangee) |
| `src/orchestrator/pipeline.ts` | Indirect | Importe `runAgentStep` depuis `agent-step.ts` et `loadAgentYaml` depuis `bmad-prompts.ts` — non impacte (API inchangee) |
| `src/commands/exploration.ts` | Indirect | Importe `buildAgentSystemPromptPart` et `buildAgentTaskPromptPart` depuis `bmad-prompts.ts` — non impacte |

### API publiques modifiees

| Fichier | Fonction/Classe | Type de changement | Backward-compatible |
|---------|----------------|--------------------|--------------------|
| `src/bmad-prompts.ts` | `getDevInstructions()` (privee) | Modification — ajout de contenu dans la valeur de retour | Oui (pas exportee, signature inchangee) |
| `src/orchestrator/agent-step.ts` | `getOrchestrationInstructions()` (exportee) | Modification — ajout de contenu dans la valeur de retour du case "dev" | Oui (signature inchangee, retour enrichi) |

### Breaking changes potentiels

Aucun breaking change identifie. Les modifications sont purement additives :
- Aucune signature de fonction modifiee
- Aucun export supprime ou renomme
- Les prompts existants sont preserves avec du contenu supplementaire ajoute en fin de liste

### Points d'attention pour le Reviewer

1. **Allowlist process.env — risque de regression silencieuse** : la spec mentionne "27 fichiers" mais le scan actuel trouve 25 fichiers (hors `config.ts` et `logger.ts`) utilisant `process.env.`. Chaque entree de l'allowlist devra etre justifiee avec un commentaire. Les fichiers critiques a auditer en priorite : `notification-queue.ts` (8 occurrences), `tts.ts` (8), `bot-context.ts` (5), `heartbeat.ts` (5), `transcribe.ts` (5). Verifier si certains de ces usages sont des violations a corriger plutot qu'a exempter.

2. **Allowlist LOC incomplete dans la spec** : la spec (R7) mentionne 3 fichiers en allowlist temporaire (`agent-schemas.ts`, `gate-evaluator.ts`, `workflow.ts`) en reference a CLAUDE.md. Or, les fichiers actuellement au-dessus de 800 LOC incluent aussi : `pipeline.ts` (1486), `planning.ts` (1005), `zz-messages.ts` (909), `graph.ts` (855), `bot-context.ts` (816). La spec mentionne 7 fichiers dans la section "Limites techniques" (contraintes) mais la section R7 ne cite que les 3 documentes dans CLAUDE.md. L'implementeur devra reconcilier ces deux listes. Le V-critere V13 demande l'alignement avec CLAUDE.md — mais CLAUDE.md ne liste que 3 fichiers alors que 8 sont au-dessus du seuil. Le test echouera si l'allowlist est trop restrictive.

3. **Section 4 — reference ambigue** : le Livrable 1 mentionne "1 ligne dans `getOrchestrationInstructions("dev")`" sous la puce `src/bmad-prompts.ts`, mais cette fonction est dans `src/orchestrator/agent-step.ts` (correctement identifie dans la section 5). Ambiguite mineure mais a clarifier pour l'implementeur.

4. **Test structurel S4 (boundaries) — scope commands/** : le test verifie que les fichiers `src/*.ts` n'importent pas depuis `src/commands/`. Verifier que le glob inclut aussi les sous-repertoires (`src/memory/*.ts`, `src/orchestrator/*.ts`) pour une couverture complete des frontieres architecturales. Le test S4 mentionne aussi une verification que les commandes n'importent pas `@supabase/supabase-js` directement — cette regle n'est pas documentee dans ADR-008 ni dans CLAUDE.md et pourrait generer des faux positifs si des commandes accedent legitimement a Supabase via le `bot-context`.

5. **Impact CI — performance** : le scan de ~88 fichiers TypeScript avec regex est rapide (< 2s comme specifie). Toutefois, le test S3 (LOC) et S2 (process.env) necessitent chacun une lecture complete de tous les fichiers source. Verifier que le test reste rapide en execution groupee avec les 3600+ tests existants.

### Blast radius

- Modules directement modifies : 4 (bmad-prompts.ts, agent-step.ts, implementer.md, reviewer.md) + 1 cree (coding-standards.test.ts)
- Modules indirectement impactes : 4 (bmad-agents.ts, code-review.ts, pipeline.ts, exploration.ts) — aucun changement fonctionnel pour eux
- Fichiers source modifies : 4
- Fichiers de test a verifier : 2 (corriger-les-defauts-du-pipeline-dagents.test.ts V7 — utilise buildFullAgentPrompt("dev", {command: "exec"}) qui inclura le nouveau contenu, et le nouveau coding-standards.test.ts)
