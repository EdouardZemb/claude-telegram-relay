`RESEARCH.md` écrit dans le répertoire de run.

**Résumé de la recherche :**

- **Powens supporte LBP** — confirmé via OpenBankingTracker, 1800+ institutions, 99.5% data refresh
- **Pas de SDK TypeScript** — REST API uniquement, wrapper HTTP à écrire (~1-2h d'effort)
- **OAuth dans Telegram** — nécessite un endpoint HTTPS intermédiaire (Bun ~20 lignes sur le même VPS) qui relaie via deep link `t.me/bot?start=<code>` — contournable, pas bloquant
- **Token 180 jours sans refresh** — re-auth tous les 6 mois, à anticiper via `notification-queue.ts`
- **Codebase bien préparé** — `job-manager.ts` et `notification-queue.ts` absorbent directement l'intégration

**Recommandation : V3 — Enveloppes budgétaires** (10-15 j/p), en construisant V1→V2→V3 séquentiellement. V4 (projections long terme) en itération après 2-3 mois de données accumulées.