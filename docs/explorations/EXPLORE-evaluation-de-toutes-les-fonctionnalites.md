---
phase: 0-explore
generated_at: "2026-03-25T12:00:00+01:00"
subject: "Evaluation de toutes les fonctionnalités du bot Claude Telegram Relay"
verdict: GO
next_step: "dev-spec"
---

## Section 1 — Problème

Le projet claude-telegram-relay a évolué de manière incrémentale sur plus de 30 sprints, accumulant 48 modules TypeScript (~16 300 LOC après une réduction de 53 % depuis le pic). Cette croissance organique a produit un système riche mais complexe dont personne n'a dressé un inventaire exhaustif et critique depuis longtemps.

L'exploration est nécessaire pour :
1. Cartographier l'ensemble des fonctionnalités déclarées vs réellement opérationnelles
2. Identifier les fonctionnalités orphelines, peu utilisées, ou en dette technique
3. Détecter les zones de chevauchement fonctionnel (duplication implicite)
4. Produire une base de référence pour les sprints S44+ (consolidation, architecture V2)

La question centrale : **quel est l'état réel du périmètre fonctionnel, et quelles décisions de consolidation ou de suppression sont justifiées ?**

---

## Section 2 — État de l'art

L'axe "état de l'art externe" est limité pour ce sujet : il s'agit d'une évaluation interne d'un système propriétaire. Les meilleures pratiques pertinentes sont issues du domaine de la gestion de la dette technique et de l'audit de bots Telegram.

| # | Source | Type | Date | Résumé | Pertinence |
|---|--------|------|------|--------|:----------:|
| 1 | CLAUDE.md (documentation interne) | Doc projet | 2026-03-25 | Architecture complète, 48 modules, 24 tables Supabase, pipeline SDD, 6 feature flags, CI/CD | Haute |
| 2 | CHANGELOG.md + docs/sprints/ | Historique | 2026-03-25 | Historique S08-S44, réduction de 34.6K → 16.3K LOC, migration Architecture V2 | Haute |
| 3 | Memory files (.claude/projects/) | Mémoire agent | 2026-03-25 | Sprints S34-S44, roadmap, bugs connus, feedback process | Haute |

**Note :** L'axe 1 repose sur des sources internes car le sujet est une évaluation de codebase privé. Les sources externes (pratiques de feature audit, technical debt management) sont couvertes implicitement par les conventions du projet.

**Synthèse :** Le projet est un monolithe modulaire TypeScript orchestrant des agents IA via Telegram. Après Architecture V2 (phases 1-5), 6 modules orchestrateurs ont été supprimés, la couverture de tests est à 1910 tests, et 6 feature flags contrôlent les fonctionnalités expérimentales. La dette principale identifiée est : `zz-messages.ts` à 904 LOC (seuil 800), `bot-context.ts` à 788 LOC (proche du seuil), `memory/graph.ts` à 743 LOC.

---

## Section 3 — Archéologie codebase

### Inventaire complet des fonctionnalités

#### Commandes Telegram (25 commandes)

| # | Commande | Module | LOC module | Statut | Notes |
|---|----------|--------|-----------|--------|-------|
| 1 | `/help` | commands/help.ts (183) | 183 | Opérationnel | Référence complète |
| 2 | `/workflow` | commands/help.ts | 183 | Opérationnel | Vue pipeline SDD |
| 3 | `/status` | commands/help.ts | 183 | Opérationnel | Santé serveur + PM2 + Supabase |
| 4 | `/monitor` | commands/help.ts | 183 | Opérationnel | Monitoring prod + LLM-Ops snapshot |
| 5 | `/task` | commands/tasks.ts (329) | 329 | Opérationnel | Validation Zod, multi-projet |
| 6 | `/backlog` | commands/tasks.ts | 329 | Opérationnel | Scoping par projet auto |
| 7 | `/sprint` | commands/tasks.ts | 329 | Opérationnel | Vue sprint + progression |
| 8 | `/start` | commands/tasks.ts | 329 | Opérationnel | Transition backlog → in_progress |
| 9 | `/done` | commands/tasks.ts | 329 | Opérationnel | Transition → done + notification |
| 10 | `/brain` | commands/memory-cmds.ts (479) | 479 | Opérationnel | Synthèse mémoire + /brain health |
| 11 | `/ideas` | commands/memory-cmds.ts | 479 | Opérationnel | Pipeline idées CRUD |
| 12 | `/remind` | commands/memory-cmds.ts | 479 | Opérationnel | Rappels in-memory |
| 13 | `/metrics` | commands/quality.ts (536) | 536 | Opérationnel | Métriques sprint + comparaison |
| 14 | `/retro` | commands/quality.ts | 536 | Opérationnel | Génération retro IA + callback validation |
| 15 | `/alerts` | commands/quality.ts | 536 | Opérationnel | Détection anomalies |
| 16 | `/cost` | commands/quality.ts | 536 | Opérationnel | Suivi coûts tokens |
| 17 | `/profile` | commands/profile.ts (90) | 90 | Opérationnel | Profil utilisateur |
| 18 | `/notify` | commands/profile.ts | 90 | Opérationnel | Préférences notifications |
| 19 | `/projects` | commands/project.ts (143) | 143 | Opérationnel | Liste projets |
| 20 | `/project` | commands/project.ts | 143 | Opérationnel | CRUD projets + topic routing |
| 21 | `/docs` | commands/documents.ts (649) | 649 | Opérationnel | Gestion docs + classification LLM |
| 22 | `/explore` | commands/exploration.ts (92) | 92 | Opérationnel | Agent Ada exploration codebase |
| 23 | `/jobs` | commands/jobs.ts (153) | 153 | Opérationnel | Background jobs list/cancel |
| 24 | `/speak` | commands/utilities.ts (343) | 343 | Opérationnel | TTS Piper local |
| 25 | `/feature` | commands/utilities.ts | 343 | Opérationnel | Feature flags toggle |
| 26 | `/rollback` | commands/utilities.ts | 343 | Opérationnel | Rollback git |
| 27 | `/export` | commands/utilities.ts | 343 | Partiel | Export tâches/métriques |

#### Fonctionnalités core non-commandes

| # | Module | Fonctionnalité | LOC | Statut | Notes |
|---|--------|---------------|-----|--------|-------|
| 1 | agent.ts (710) | SpawnClaude + cascade modèles | 710 | Opérationnel | CASCADE_MODELS: Haiku→Sonnet→Opus |
| 2 | sdd-agents.ts (488) | Pipeline SDD (explore/spec/challenge/implement/review/doc) | 488 | Opérationnel | Cœur du pipeline de maturation |
| 3 | sdd-flow.ts (376) | Callbacks InlineKeyboard SDD, détection convergence | 376 | Opérationnel | buildSddKeyboard, detectConvergence |
| 4 | heartbeat.ts (720) | Pulse autonome: alertes, archivage mémoire, scan autonomie | 720 | Partiellement actif | PM2 heartbeat arrêté (memory.md) |
| 5 | job-manager.ts (685) | Jobs background, concurrence, persistance JSON | 685 | Opérationnel (feature flag) | feature: job_manager=true |
| 6 | notification-queue.ts (252) | Notifications immédiates, boutons inline, préférences | 252 | Opérationnel | Batching supprimé, livraison immédiate |
| 7 | llm-ops.ts (539) | Coûts, circuit-breaker, versioning prompts, observabilité | 539 | Opérationnel (feature flag) | feature: llmops_monitoring=true |
| 8 | intent-detection.ts (373) | Détection intention 2 niveaux: regex + LLM fallback | 373 | Derrière feature flag (non activé) | feature: intent_detection=false par défaut |
| 9 | documents.ts (716) | Extraction texte, classification, CRUD, recherche sémantique | 716 | Opérationnel | feature: auto_document_search=true |
| 10 | document-sharding.ts (617) | Cache contexte: division docs larges, chargement shards | 617 | Opérationnel | Utilisé dans bot-context |
| 11 | memory/core.ts (340) | Mémoire court/long terme, contexte, archivage | 340 | Opérationnel | |
| 12 | memory/classification.ts (308) | Classification messages, autoRemember, idées | 308 | Opérationnel | Utilise Edge Function classify-thought |
| 13 | memory/scoring.ts (294) | Score importance, décroissance temporelle, conflits | 294 | Opérationnel | |
| 14 | memory/ideas.ts (174) | CRUD idées, promote, archive | 174 | Opérationnel | |
| 15 | memory/graph.ts (743) | Liens mémoire, chaînes, clusters, santé | 743 | Opérationnel | 743 LOC, candidat refactoring |
| 16 | memory/agent-memory.ts (295) | Mémoire agents par rôle, graduation | 295 | Opérationnel (feature flag) | feature: agent_role_memory=true |
| 17 | alerts.ts (570) | Tâches bloquées, rework spikes, schedule slips | 570 | Opérationnel | 4 importeurs, conservé |
| 18 | gates.ts (241) | BMad gates: PRD approval, architecture, code review | 241 | Opérationnel | |
| 19 | pipeline-tracker.ts (296) | État SDD par chat, persistance disque | 296 | Opérationnel | TTL 7 jours |
| 20 | conversation-handoff.ts (207) | Handoff conversation→agent, extraction décisions/contraintes | 207 | Opérationnel | |
| 21 | transcribe.ts (117) | Transcription vocale: Groq cloud ou whisper-cpp local | 117 | Opérationnel | |
| 22 | tts.ts (267) | Synthèse vocale Piper local | 267 | Opérationnel | |
| 23 | topic-config.ts (91) | Prompts par topic forum, allowlists commandes | 91 | Opérationnel | |
| 24 | action-registry.ts (425) | Registre commandes: métadonnées, params, niveaux risque | 425 | Opérationnel | Base du intent-detection |
| 25 | heartbeat-prompt.ts (232) | Construction prompt heartbeat, schéma décisions | 232 | Opérationnel | |
| 26 | result.ts (40) | Type Result<T,E> discriminant, ok/err constructors | 40 | Opérationnel | Vague 3 Architecture V2 |
| 27 | semaphore.ts (53) | Sémaphore counting, max 3 par défaut | 53 | Opérationnel | |
| 28 | config.ts (171) | Validation env via Zod, getConfig() singleton | 171 | Opérationnel | |
| 29 | logger.ts (164) | Logger structuré JSON/coloré, correlation IDs | 164 | Opérationnel | |
| 30 | loader.ts (82) | Auto-discovery Composer modules | 82 | Opérationnel | |
| 31 | bot-context.ts (788) | Contexte partagé Composers, session, deps | 788 | Opérationnel | 788 LOC, proche seuil 800 |
| 32 | projects.ts (229) | Multi-projet CRUD, routing par topic | 229 | Opérationnel | |
| 33 | tasks.ts (259) | Lifecycle tâches backlog→done | 259 | Opérationnel | |
| 34 | doc-utils.ts (227) | Parsing docs: modules/commandes, count tests, gaps | 227 | Opérationnel | |
| 35 | feature-flags.ts (67) | Flags fichier, hot-reload, 6 actifs | 67 | Opérationnel | |

#### Infrastructure et pipeline dev

| # | Composant | Description | Statut |
|---|-----------|-------------|--------|
| 1 | PM2 relay | Bot principal | Actif |
| 2 | PM2 dashboard | Kanban port 3456 | Actif |
| 3 | PM2 heartbeat | Pulse autonome 10min | Arrêté (memory.md) |
| 4 | PM2 system-alerts | Alertes système 15min | Statut inconnu |
| 5 | CI (ci.yml) | typecheck, tests, doc freshness, coverage, E2E | Actif |
| 6 | Deploy (deploy.yml) | git pull, pm2 restart, smoke test, auto-rollback | Actif |
| 7 | MCP memory server | CRUD mémoire, tasks, sprints via stdio | Actif |
| 8 | Supabase Edge Functions | embed, search, classify-thought, memory-mcp | Actif |
| 9 | .claude/agents/ (6) | explorer, spec-architect, devils-advocate, edge-case-hunter, simplicity-skeptic, reviewer | Actif |
| 10 | .claude/skills/ (4) | dev-explore, dev-implement, dev-review, dev-doc | Actif |

### Points de friction identifiés

| # | Fichier/Module | Observation | Impact potentiel |
|---|---------------|-------------|:----------------:|
| 1 | zz-messages.ts (904 LOC) | Dépasse le seuil 800 LOC. Contient command-router inline. | Haut |
| 2 | bot-context.ts (788 LOC) | 788 LOC, très proche du seuil. Contexte partagé énorme. | Moyen |
| 3 | memory/graph.ts (743 LOC) | 743 LOC, candidat refactoring | Moyen |
| 4 | quality.ts (536 LOC) | Contient des fonctions inlinées qui dupliquent des requêtes Supabase (collectSprintMetrics, generateRetroData) | Moyen |
| 5 | heartbeat.ts (720 LOC) | Service PM2 heartbeat arrêté. Code vivant mais service down. | Haut |
| 6 | intent_detection feature flag | Non activé par défaut, code présent mais inactif | Faible |
| 7 | /patterns commande | Citée dans `/help` (output help.ts ligne 42) mais PAS listée dans CLAUDE.md commands | Moyen |
| 8 | /estimate commande | Citée dans `/help` (ligne 55) mais PAS dans CLAUDE.md | Moyen |
| 9 | tasks.ts /done et /start | Utilise `process.env` directement (SPRINT_THREAD_ID, USER_TIMEZONE) — violation standard S2 | Moyen |
| 10 | agent.ts | CLAUDE_PATH et PROJECT_DIR via `process.env` direct (lignes 21-22) — violation S2 | Moyen |

### Actifs réutilisables

- **1910 tests** couvrant la majorité des modules
- **Pipeline CI robuste** avec couverture par fichier (seuil 30%)
- **Feature flags** permettant d'activer/désactiver sans déploiement
- **Barrel re-exports** maintenus pour memory.ts → src/memory/
- **Result<T,E>** type discriminant disponible pour améliorer la gestion d'erreurs
- **action-registry.ts** : base solide pour le intent-detection si activé

---

## Section 4 — Matrice d'alternatives

L'exploration identifie 3 postures possibles face à l'état actuel du périmètre fonctionnel :

| Critère | A: Status quo (gel) | B: Consolidation ciblée | C: Audit + roadmap complète |
|---------|:------------------:|:-----------------------:|:---------------------------:|
| **Complexité** (obligatoire) | S | M | L |
| **Valeur ajoutée** (obligatoire) | Low | High | High |
| **Risque technique** (obligatoire) | Med | Low | Med |
| *Impact maintenance* (si pertinent) | Négatif (dette croît) | Positif | Très positif |
| *Réversibilité* (si pertinent) | Non | Oui | Oui |

**Option A — Status quo :** Continuer à livrer sans adresser la dette. `zz-messages.ts` restera au-dessus du seuil, bot-context.ts approchera 800 LOC, le heartbeat PM2 restera arrêté sans décision formelle. Le risque est une dégradation progressive de la maintenabilité. Violation des standards S3 (LOC) et S2 (process.env direct) déjà présentes.

**Option B — Consolidation ciblée :** Traiter les 5-6 points de friction prioritaires : (1) refactoring zz-messages.ts en sous-modules, (2) décision formelle heartbeat ON/OFF, (3) correction violations S2 dans tasks.ts et agent.ts, (4) documenter /patterns et /estimate dans CLAUDE.md ou retirer de /help. Complexité M, impact immédiat sur la qualité.

**Option C — Audit + roadmap complète :** Produire un document de roadmap S44-S48 couvrant tous les modules, définir des critères d'archivage pour les features peu utilisées, planifier le split de zz-messages.ts, activer intent_detection et mesurer l'usage. Valeur haute mais effort L (plusieurs sprints).

---

## Section 5 — Verdict et justification

## Verdict GO

Le projet est **sain dans l'ensemble** : 1910 tests passent, le pipeline CI est actif, les 6 feature flags contrôlent correctement les fonctionnalités expérimentales, et la migration Architecture V2 (phases 1-5) a déjà réduit le LOC de 53 %. Il n'y a pas de fonctionnalité cassée majeure visible dans le code.

Cependant, **4 actions concrètes sont clairement justifiées** :

1. **Violations standards S2 et S3 actives** : `zz-messages.ts` dépasse le seuil 800 LOC (904), `tasks.ts` et `agent.ts` utilisent `process.env` directement en violation du standard S2. Ces violations sont détectées par les tests `coding-standards.test.ts` mais doivent être corrigées.

2. **Service heartbeat arrêté** : Le code de `heartbeat.ts` (720 LOC) est vivant et testé mais le service PM2 est arrêté selon les memory files. Une décision formelle (réactiver ou archiver) est nécessaire pour éviter du code mort en production.

3. **Incohérence /help vs CLAUDE.md** : Les commandes `/patterns` et `/estimate` sont citées dans la sortie `/help` (help.ts lignes 42, 55) mais absentes de la documentation CLAUDE.md. Soit elles existent (à documenter) soit elles sont obsolètes (à retirer du /help).

4. **intent_detection non activé** : Le module complet (373 LOC + action-registry 425 LOC) est présent et testé mais le feature flag n'est pas activé en production. Décision à prendre : activer ou marquer comme expérimental dans la doc.

Le verdict GO signifie que le codebase peut immédiatement recevoir des sprints de consolidation ciblée (Option B) sans spec préalable complexe, car les problèmes sont localisés et bien définis.

---

## Section 6 — Input pour étape suivante

**Option recommandée :** B — Consolidation ciblée

**Fichiers concernés par priorité :**

1. `src/commands/zz-messages.ts` (904 LOC) → split en sous-modules (command-router.ts séparé)
2. `src/commands/tasks.ts` (lignes 249, 309) → migrer SPRINT_THREAD_ID et USER_TIMEZONE vers getConfig()
3. `src/agent.ts` (lignes 21-22) → migrer CLAUDE_PATH et PROJECT_DIR vers getConfig()
4. `src/heartbeat.ts` + `ecosystem.config.cjs` → décision formelle PM2 heartbeat
5. `src/commands/help.ts` → vérifier existence /patterns et /estimate, corriger /help output
6. `config/features.json` → activer ou documenter intent_detection

**Contraintes identifiées :**
- Toute modification de zz-messages.ts doit respecter la barrel convention (si sous-répertoire créé)
- Les migrations getConfig() doivent passer le standard S2 dans `coding-standards.test.ts`
- Le seuil de couverture S8 (30% par fichier) doit être maintenu
- Pas de régression sur les 1910 tests existants

**Questions ouvertes pour la spec :**
- Les commandes `/patterns` et `/estimate` existent-elles réellement ? (vérifier `action-registry.ts` et les Composers)
- Le heartbeat doit-il être réactivé ou la feature est-elle abandonnée ?
- L'intent_detection doit-il passer en GA (activer par défaut) ou rester expérimental ?
- `bot-context.ts` à 788 LOC : anticiper le refactoring avant de dépasser 800 ?
