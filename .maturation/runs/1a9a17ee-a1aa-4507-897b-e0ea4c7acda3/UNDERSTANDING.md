`UNDERSTANDING.md` écrit dans le répertoire de run.

**Résumé de l'analyse** :

- **Intention** : Assistant financier personnel via le bot Telegram — agrégation PSD2, budget hybride (enveloppes fixes + plafonds souples), catégorisation semi-auto évoluant vers l'automatisation par apprentissage, données sensibles local-first.

- **Score d'ambiguïté : 4/10** — direction claire après les 4 clarifications. Deux points techniques structurants restent à résoudre avant la spec :
  1. **OAuth2 redirect_uri** : les API bancaires PSD2 imposent un callback HTTP que le bot Telegram n'a pas nativement
  2. **Stockage local** : "puissant comme une DB vectorielle" entre en tension avec ADR-001 (pas de SQLite/dépendances natives)

- **Intégrations naturelles** dans le codebase : `notification-queue.ts` pour les alertes de dépassement, `heartbeat.ts` pour le polling périodique, `job-manager.ts` pour les syncs bancaires, pattern `maturation/documents.ts` pour le local-first, `llm-ops.ts` pour la catégorisation IA.

- **4 questions de clarification** formulées sur le redirect OAuth, le compromis analytique/dépendances pour le stockage, la sensibilité des libellés en cloud, et le périmètre multi-comptes en v1.