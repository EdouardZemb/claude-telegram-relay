## Revue : SPEC-enforcement-standards-agents

> Revue du 2026-03-23. Scope : CLAUDE.md, src/bmad-prompts.ts, src/orchestrator/agent-step.ts, .claude/agents/implementer.md, .claude/agents/reviewer.md, tests/unit/coding-standards.test.ts, docs/specs/SPEC-enforcement-standards-agents.md.

### Checklist

- [x] TypeScript compile sans erreur (`bunx tsc --noEmit` : 0 erreurs)
- [x] Imports coherents (pas de nouveaux imports dans bmad-prompts.ts ni agent-step.ts, coding-standards.test.ts importe correctement depuis bun:test, fs, bun, path)
- [x] Pas de secrets ou credentials dans le code
- [x] Types explicites (pas de `any` dans le nouveau code)
- [x] Coherence avec les patterns existants (getCodeLines/hasRealMatch copies depuis logger-migration.test.ts, bloc STANDARDS conforme au pattern buildIsolationInstructions)
- [x] Pas de duplication de logique existante (les helpers sont copies dans le test, pas importes depuis un test — conforme a la spec)
- [x] Conventions de nommage respectees
- [x] Pas de console.log/error/warn direct
- [x] Pas de process.env. direct (l'occurrence dans bmad-prompts.ts L280 est dans un string literal, correctement filtree par hasRealMatch)
- [x] Fichiers source <= 800 LOC (bmad-prompts.ts: 560, agent-step.ts: 262, coding-standards.test.ts: 319)
- [x] Convention barrel respectee
- [x] Frontieres architecturales respectees
- [x] Backward compatibility : API publiques non cassees (getOrchestrationInstructions signature inchangee, buildFullAgentPrompt enrichi de facon additive)
- [x] Tests existants non casses (corriger-les-defauts-du-pipeline-dagents.test.ts: 29 pass/0 fail, logger-migration.test.ts: 317 pass/0 fail)
- [x] Rapport d'impact : conclusions verifiees et confirmees (voir details ci-dessous)

### Verification du rapport d'impact

1. **Allowlist process.env (point 1)** : 27 fichiers ont un usage de process.env. 25 sont dans l'allowlist du test, 2 sont exclus par design (config.ts, logger.ts). bmad-prompts.ts contient un usage dans un string literal correctement filtre. Couverture complete.
2. **Allowlist LOC (point 2)** : CLAUDE.md a ete mis a jour pour lister les 8 fichiers > 800 LOC. L'allowlist du test (8 fichiers) est alignee avec CLAUDE.md. V13 satisfait.
3. **Reference ambigue section 4 (point 3)** : non impactant pour l'implementation, getOrchestrationInstructions est bien dans agent-step.ts.
4. **S4 subdirectories (point 4)** : le test couvre bien les sous-repertoires (orchestrator/, memory/) en plus des fichiers top-level. Le check `@supabase/supabase-js` dans commands/ n'est pas implemente — decision raisonnable car non couvert par une regle formelle (R8) et risque de faux positifs.
5. **Performance CI (point 5)** : 308 tests en 94ms. Negligeable.

### Verification des V-criteres

| V# | Statut | Detail |
|----|--------|--------|
| V1 | OK | getDevInstructions("exec") contient les 6 keywords : Result, createLogger, getConfig, barrel, 800 LOC, Frontieres |
| V2 | OK | getOrchestrationInstructions("dev") contient "standards du projet (Result type, createLogger, getConfig, barrel, 800 LOC, frontieres) — voir CLAUDE.md" |
| V3 | OK | implementer.md contient "## Standards obligatoires" avec 6 items |
| V4 | OK | reviewer.md contient "### Standards projet" avec 6 items `- [ ]` |
| V5 | OK | Test S1 scanne dynamiquement et detecte les violations (308 tests generes) |
| V6 | OK | Test S2 avec allowlist de 25 fichiers + 2 exclusions by design |
| V7 | OK | Test S3 avec allowlist de 8 fichiers + verification inverse (allowlisted files still > 800) |
| V8 | OK | Test S4 verifie top-level et sous-repertoires, 0 violations |
| V9 | OK | Test S5 decouvre dynamiquement les sous-repertoires, verifie barrels et leur contenu |
| V10 | OK | Injections concises : 9 lignes dans getDevInstructions, 1 ligne dans getOrchestrationInstructions, 10 lignes dans implementer.md, 7 lignes dans reviewer.md |
| V11 | OK | `bun test tests/unit/coding-standards.test.ts` : 308 pass, 0 fail |
| V12 | OK | `bun test tests/unit/logger-migration.test.ts` : 317 pass, 0 fail |
| V13 | OK | Allowlist LOC dans le test (8 fichiers) alignee avec CLAUDE.md (8 fichiers) |

### Problemes bloquants

Aucun.

### Avertissements

- [tests/unit/coding-standards.test.ts:96-101] Le pattern d'assertion pour les violations console utilise `expect(violations).toEqual(expect.arrayContaining([]))` suivi de `expect(violations.length).toBe(0)`. La premiere assertion est toujours vraie (tout tableau contient un tableau vide) et ne sert qu'a afficher les violations pour debug. C'est un choix delibere mais non standard — un `expect(violations).toEqual([])` suffirait et afficherait aussi les violations en cas d'echec. Meme pattern repete en S2 (L167-170). Impact : aucun (comportement identique), mais lisibilite reduite.

- [.claude/agents/implementer.md, .claude/agents/reviewer.md] Ces fichiers sont dans `.gitignore` (repertoire .claude/agents/ non track). Les modifications ne seront pas commises et devront etre re-appliquees manuellement si le repertoire .claude est recree. Ce n'est pas un probleme de l'implementation (c'est un choix de structure du projet) mais un point d'attention pour la maintenabilite.

### Suggestions

- [tests/unit/coding-standards.test.ts:67-73] La detection de barrel est basee sur une liste statique `knownBarrels = ["memory.ts", "orchestrator.ts"]`. Si un nouveau sous-repertoire est cree dans src/ a l'avenir, il faudra mettre a jour cette liste ET l'exclure du test LOC. Envisager une detection dynamique : un fichier est un barrel si son nom correspond a un sous-repertoire existant et ne contient que des re-exports. Le test S5 fait deja cette verification de contenu — la detection de barrel pourrait s'appuyer dessus.

- [docs/specs/SPEC-enforcement-standards-agents.md:69] Le check `@supabase/supabase-js` dans les commandes n'a pas ete implemente. Si cette regle est jugee pertinente, la formaliser dans un ADR ou dans CLAUDE.md avant de l'ajouter au test.

### Score : 92/100

Implementation solide, bien alignee avec la spec et le rapport d'impact. Les deux couches d'enforcement (soft via prompts, hard via tests CI) sont correctement mises en place. Les allowlists sont documentees et justifiees. Les 13 V-criteres sont satisfaits. Le code est propre, concis, et ne casse rien. Points mineurs : pattern d'assertion non standard dans les tests et detection de barrel statique.
