`UNDERSTANDING.md` écrit dans le répertoire de run.

**Résumé de l'analyse :**

- **Score d'ambiguïté : 7/10** — intention claire, détails techniques critiques manquants
- **Type** : feature (nouvelle intégration API externe)
- **Blocage principal** : le choix de l'API bancaire (Nordigen, Plaid, CSV manuel...) est un prérequis avant toute spécification — sans ça, impossible de concevoir l'architecture
- **Point de friction inattendu** : "budget" et "dépenses" déclenchent déjà l'intent `view_cost` (coût tokens LLM) dans `intent-detection.ts` — conflit sémantique à résoudre
- **5 questions de clarification** formulées, la plus urgente étant la source de données bancaires